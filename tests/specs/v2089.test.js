/* tests/specs/v2089.test.js — 2.0.8.9 需求①「闪烁根治 + 复制丢选区」
 * ----------------------------------------------------------------------------
 * 用户现场（2026-11-07）：Ctrl+C / 右键复制时页面闪一下，**选中变成没选中、复制失败**；
 * 页面静止时也会莫名其妙闪一下（没有可感知的内容变动）。
 *
 * 两个根因，两条锁：
 *   ① 重建旧路径是「先 Renderer.clear() 再整体重画」⇒ 命中集合没变也会出现一帧"高亮消失"。
 *      修法：视觉交给 `Renderer.render` 的内容签名 diff + 末尾 `prune()`；签名没变一个
 *      `CSS.highlights.set` 都不发生（真浏览器里那次 set 就是重新绘制）。
 *   ② 重建会走 `features.clear` + `features.consume`，笔记面板/命中卡片是**真 DOM**；
 *      Ctrl+C 时浏览器正要读 `getSelection()`，节点被换掉选区就塌。
 *      修法：`run()` 里有活选区时 `visual:false` + `features:false`（本轮不动面板 DOM），
 *      并且调度侧在 copy/cut/contextmenu/keydown(Ctrl+C) 之后 1200ms 内不重建（Source 进尾随队列）。
 *
 * 注意：suite() 只接名字、不接回调 —— 用例必须写在同一层，否则一条都不会注册。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');

  const renderer = read('core/renderer.js');
  const rebuilder = read('core/rebuilder.js');
  const index = read('core/index.js');
  const scheduler = read('core/scheduler.js');

  suite('2.0.8.9 · 重建不闪烁（需求①）');

  test('渲染幂等：同组内容签名没变就不调 CSS.highlights.set', () => {
    truthy(renderer.includes('_groupSigs'), 'renderer 必须保留每组的上次写入签名');
    truthy(renderer.includes('signatureOf(ranges)'), '必须有内容签名函数');
    truthy(/if \(this\._stillLive\(name, s\)\) return false;/.test(renderer),
      'setGroup 必须在「签名相同 + 注册表里还是我们那份」时早退（否则每次重建都会重新绘制）');
    truthy(/if \(this\._stillLive\(name, sig\)\) continue;/.test(renderer),
      'render 批量路径也要按签名跳过（这是"静止页面不闪"的关键）');
    /* 光比签名不够：页面自己 CSS.highlights.clear() 会把组抹掉而签名还在，
     * 只比签名就"以为画面还在"，自愈失效（e2e 7g 实测组数恒为 0）。 */
    truthy(/_stillLive\(name, sig\)/.test(renderer) && /CSS\.highlights\.get\(name\)/.test(renderer)
      && /cur === ours/.test(renderer),
      '_stillLive 必须核对注册表里的对象身份（页面清空后要能重写，即自愈）');
  });

  test('不清视觉的代价必须自己补：prune 撤掉本轮没出现的旧组', () => {
    truthy(/prune\(keepNames\)/.test(renderer), 'renderer 必须有 prune(keepNames)');
    truthy(/this\.prune\(keep\);/.test(renderer), 'render 末尾必须 prune(本轮 keep)');
    truthy(/for \(const name of Array\.from\(this\._groups\.keys\(\)\)\)/.test(renderer),
      'prune 只撤注册表里的组，不动 style 节点');
  });

  test('重建路径不再先清视觉；有活选区时连 feature 的 clear/consume 一起跳过', () => {
    truthy(/_hasTextSelection\(\)/.test(index), 'index 必须有选区判据');
    truthy(/visual: false/.test(index), '重建传入 visual:false');
    truthy(/features: !keepSelection/.test(index), '有选区时跳过 features.clear');
    truthy(/if \(features && !keepSelection\)/.test(index), '有选区时跳过 features.consume');
    truthy(/o\.features !== false/.test(rebuilder), 'rebuilder 必须真正认 opts.features');
  });

  test('异常兜底：不留半新半旧的组', () => {
    truthy(/catch \(err\)[\s\S]{0,400}Renderer\.prune\(new Set\(\)\)/.test(index),
      '重建异常时必须整体撤回高亮组，否则会出现与命中表对不上的脏画面');
  });

  test('复制保护窗口：copy/cut/contextmenu/keydown(Ctrl+C) 后 1200ms 内只排队不重建', () => {
    truthy(/const COPY_GUARD_MS = 1200;/.test(scheduler), '保护窗口 1200ms');
    truthy(/add\('copy'/.test(scheduler) && /add\('cut'/.test(scheduler), 'copy/cut 必须护住');
    truthy(/add\('contextmenu'/.test(scheduler), '右键菜单也要护（右键复制会先弹菜单）');
    truthy(/e\.key === 'c'/.test(scheduler) && /e\.key === 'x'/.test(scheduler),
      '键盘复制剪贴也要护（浏览器把 copy 推迟到 keyup 之后派发）');
    truthy(/_copyGuardActive\(\)/.test(scheduler), '必须有窗口判据');
  });

  test('保护窗口只延后、不丢：来源进尾随队列，窗口结束补跑', () => {
    const S = KH.Scheduler;
    const saved = {
      until: S._copyGuardUntil,
      pending: S._pendingSource,
      defer: S._copyDeferCount,
      timer: S._timers.copyGuard
    };
    try {
      S._timers.copyGuard = null;
      S._pendingSource = null;
      S._copyGuardUntil = Date.now() + 500;      // 手动进入保护期
      truthy(S._copyGuardActive(), '窗口内应判为保护期');
      eq(S.request('copy-probe'), false, '保护期内 request 不许真的重建');
      eq(S._pendingSource, 'copy-probe', '来源必须留在队列里（挡住 ≠ 丢弃）');
      truthy(S._copyDeferCount > saved.defer, '延后次数要记账');
      truthy(S._timers.copyGuard, '必须排一个窗口结束后的补跑计时器');
    } finally {
      clearTimeout(S._timers.copyGuard);
      S._timers.copyGuard = saved.timer;
      S._copyGuardUntil = saved.until;
      S._pendingSource = saved.pending;
      S._copyDeferCount = saved.defer;
    }
  });

  test('保护窗口不接管重建锁：enterRebuild/exitRebuild 配对语义不变', () => {
    truthy(/enterRebuild\(\)/.test(index) && /exitRebuild\(60\)/.test(index),
      'Rebuilder 的配对仍在 run() 的 finally 里');
    falsy(/copyGuard[\s\S]{0,80}enterRebuild/.test(scheduler),
      '复制保护不许自己去动 Rebuilder 的锁（两把锁混用会互相卡死）');
  });
};
