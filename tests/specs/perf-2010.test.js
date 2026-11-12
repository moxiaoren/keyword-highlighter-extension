/* tests/specs/perf-2010.test.js — 2.0.10 性能体检：把这一轮量出来的三处开销钉成回归
 * ============================================================================
 * 体检读数（800 行重页面 / 5614 节点 / 1734 条高亮，CDP 采样）：
 *   · 修复前：空闲 5s 里 148ms 花在「涨势兜底」的全文长度上（每秒一次 native
 *     textContent，单次 ~26ms；3000 行页约 100ms/次）
 *   · 修复后：同一页面同一口径降到 47ms/5s；重建耗时（avg 831ms）与命中数不变
 *   · 40 轮重建：堆 +385KB、节点与高亮区间数完全不变 ⇒ 没有 DOM 泄漏
 *
 * 这里只钉**口径**，不钉具体毫秒数（机器快慢不同）：
 *   ① 退避量按实测耗时折算，且封顶 15s；
 *   ② 后台标签页不跑 URL 轮询，切回前台由 visibilitychange 补一次；
 *   ③ 图片失败备忘有上限，不会只进不出。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const S = KH.Scheduler;

  suite('2.0.10 体检 · 涨势兜底不再每秒全文拼接');

  await test('★ 退避量按实测耗时折算，且封顶 15s', () => {
    eq(typeof S.growthBackoffMs, 'function', 'scheduler 要暴露 growthBackoffMs');
    eq(S.growthBackoffMs(0), 0, '没耗时就不退避');
    eq(S.growthBackoffMs(-5), 0, '负值当 0');
    eq(S.growthBackoffMs(26), 1300, '26ms × 50 = 1300ms（目标占用 ≤2%）');
    eq(S.growthBackoffMs(100), 5000, '100ms → 5s');
    eq(S.growthBackoffMs(1000), 15000, '再慢也不超过 15s');
  });

  await test('★ 计时器真的走退避：先看 _growthNextAt，再全文拼接', () => {
    const s = read('src/core/scheduler.js');
    const at = s.indexOf('setupGrowthWatcher(cfg)');
    truthy(at > 0, '找不到 setupGrowthWatcher');
    const body = s.slice(at, at + 2200);
    const guard = body.indexOf('Date.now() < this._growthNextAt');
    /* 初始化那一次 `this._scanTextLen = this.textLen()` 是基线，必须在闸门外；
     * 计时器里的那一次才是"每秒烧 26ms"的那次，必须在闸门之后。 */
    truthy(/const now = this\.textLen\(\);/.test(body), '计时器里要量一次当前全文长度');
    truthy(body.indexOf('const now = this.textLen();') > guard, '计时器里的全文长度只能在退避闸门之后量');
    truthy(body.indexOf('this.growthBackoffMs(') > 0, '退避量必须来自实测耗时');
    truthy(/if \(document\.hidden\) return;/.test(body), '后台标签页不跑涨势兜底');
    truthy(/if \(KH\.Rebuilder && KH\.Rebuilder\.inRebuildWindow\) return;/.test(body),
      '重建窗口里不许插队再量全文');
  });

  suite('2.0.10 体检 · 后台标签页不空转');

  await test('★ URL 轮询：隐藏时直接返回，前台发现变化才回调', () => {
    eq(typeof S._urlPollTick, 'function', '轮询体要抽成 _urlPollTick 才能测');
    const locDesc = Object.getOwnPropertyDescriptor(global, 'location');
    const hidDesc = Object.getOwnPropertyDescriptor(document, 'hidden');
    const calls = [];
    const oldOnChange = S._urlOnChange;
    const oldLast = S._lastHref;
    try {
      Object.defineProperty(global, 'location', {
        value: { href: 'https://example.com/new', hostname: 'example.com' },
        writable: true, configurable: true
      });
      S._urlOnChange = (h) => calls.push(h);
      S._lastHref = 'https://example.com/old';
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      eq(S._urlPollTick(), false, '隐藏时不许触发');
      eq(calls.length, 0, '隐藏时回调一次都不能有');
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      eq(S._urlPollTick(), true, '前台发现 URL 变了要触发');
      eq(calls.length, 1, '只触发一次');
      eq(S._lastHref, 'https://example.com/new', '基线要跟着更新，避免下一拍重复触发');
      eq(S._urlPollTick(), false, '同一 URL 不重复触发');
    } finally {
      if (locDesc) Object.defineProperty(global, 'location', locDesc);
      if (hidDesc) Object.defineProperty(document, 'hidden', hidDesc);
      else delete document.hidden;
      S._urlOnChange = oldOnChange;
      S._lastHref = oldLast;
    }
  });

  await test('★ 可见性回调与轮询一起建、一起摘（换站点不留幽灵监听）', () => {
    const s = read('src/core/scheduler.js');
    truthy(/addEventListener\('visibilitychange', this\._visCatch\)/.test(s), '要挂 visibilitychange');
    truthy(/removeEventListener\('visibilitychange', this\._visCatch\)/.test(s), 'teardown 必须摘掉');
    truthy(s.indexOf("document.addEventListener('visibilitychange'") < s.indexOf('    teardownAll() {'),
      '挂在前、摘在下');
    truthy(/_urlPollTick\(\)/.test(s), '计时器要调抽出来的 _urlPollTick');
  });

  suite('2.0.10 体检 · 失败备忘不会只进不出');

  await test('★ 图片失败表有硬上限，且所有写入都走 noteFail', () => {
    const s = read('src/features/img-ocr.js');
    truthy(/const FAIL_MAX = 300;/.test(s), '失败表要有硬上限 300');
    truthy(/function noteFail\(src, at\)/.test(s), '写失败表要走 noteFail');
    truthy(/failSrc\.delete\(first\.value\)/.test(s), '超上限要按插入顺序丢最旧的');
    truthy(/noteFail\(rec\.src, t\)/.test(s), '超时路径要走 noteFail');
    truthy(/noteFail\(it\.src\)/.test(s), '失败回执路径要走 noteFail');
    const sets = (s.match(/failSrc\.set\(/g) || []).length;
    eq(sets, 1, 'failSrc.set 只允许 noteFail 内部那一处（外面绕过上限等于没加）');
  });
};
