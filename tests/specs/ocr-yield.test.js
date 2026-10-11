/* tests/specs/ocr-yield.test.js — 识别在飞时给重建让路（K80 / 2.0.1.14）
 * ----------------------------------------------------------------------------
 * 实测缺陷（T2 真机读数，`_stage/wayfinder-perf/ocr-repro.md`）：**同一次图片识别**
 *   页面空闲时 0.77s  →  页面同时在重建 4.2s（M 档） / 27.5s（重页 H 档）。
 * 根因：重建是**同步**跑完一整轮全页扫描（`scheduler.js:95 KH.rebuild`），主线程一被占满，
 * 已提交的识别结果只能排队。识别是用户主动点、要等结果的；高亮是背景行为。
 *
 * 修法（`Scheduler._deferToOcr`）：有 OCR 在飞 ⇒ 把这一轮重建**顺延**（不丢：步长到了复检），
 * 但最多顺延 `_OCR_YIELD_MAX_MS` —— **上限必须硬**：识别永不回来时高亮不能永远不更新
 * （与 K56「延迟裁决不许饿死」同一个教训）。
 *
 * 本文件锁的正是这两条边界 + "顺延不丢"：
 *   ① 在飞 ⇒ 本轮不重建，且排了复检    ② 识别一空 ⇒ 复检必须真的补跑
 *   ③ 拖过上限 ⇒ 不许再等，照跑        ④ 上限之后计数归零（不是"每轮都卡 3 秒"）
 * 反向验证：去掉 `_fire` 开头那行 `if (this._deferToOcr(source)) return false;`，第 1 条立刻变红；
 * 把上限判断删掉（无限期顺延），第 3 条立刻变红。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const S = KH.Scheduler;

  /**
   * 把"识别在飞数 / 真重建 / 计时器"换成替身，跑完逐项还原。
   * 单测共用同一份内核实例，**绝不留脏状态**（尤其 `_timers.ocrYield` —— 它是真计时器，
   * 不清理就会在后面的用例里突然补跑一次重建）。
   */
  async function sandbox(fn) {
    const saved = {
      hasInflight: KH.ImgOcr && typeof KH.ImgOcr.inflightCount === 'function',
      inflight: KH.ImgOcr && KH.ImgOcr.inflightCount,
      rebuild: KH.rebuild,
      textLen: S.textLen,
      yieldTimer: S._timers.ocrYield,
      trailing: S._timers.trailing,
      since: S._ocrYieldSince,
      count: S._ocrYieldCount,
      pending: S._pendingSource,
      lastAt: S._lastRebuildAt
    };
    let inflight = 0;
    const built = [];
    KH.ImgOcr = KH.ImgOcr || {};
    KH.ImgOcr.inflightCount = () => inflight;
    KH.rebuild = (o) => { built.push((o && o.source) || ''); };
    S.textLen = () => 0;
    S._timers.ocrYield = null;
    S._timers.trailing = null;
    S._ocrYieldSince = 0;
    S._ocrYieldCount = 0;
    S._pendingSource = null;
    try {
      return await fn({ built, setInflight: (n) => { inflight = n; } });
    } finally {
      clearTimeout(S._timers.ocrYield);
      clearTimeout(S._timers.trailing);
      S._timers.ocrYield = saved.yieldTimer;
      S._timers.trailing = saved.trailing;
      S._ocrYieldSince = saved.since;
      S._ocrYieldCount = saved.count;
      S._pendingSource = saved.pending;
      S._lastRebuildAt = saved.lastAt;
      S.textLen = saved.textLen;
      KH.rebuild = saved.rebuild;
      if (saved.hasInflight) KH.ImgOcr.inflightCount = saved.inflight;
      else delete KH.ImgOcr.inflightCount;
    }
  }

  suite('调度：识别在飞时给重建让路（K80）');

  await test('★ 有识别在飞 ⇒ 本轮重建顺延，且必须自己排一次复检（不许把重建吞掉）', () => sandbox(async (c) => {
    c.setInflight(1);
    const fired = S._fire('mutation');
    falsy(fired, '有识别在飞时 _fire 必须返回 false（调用方据此知道"本轮没执行"）');
    eq(c.built.length, 0, '在飞时不重建：重建一跑就是同步 4.2s/27.5s（T2 实测），会把识别结果堵在队列里');
    truthy(S._timers.ocrYield, '必须排复检计时器 —— 不排就再也没有人来补跑这一轮（与 K56 同类饿死）');
    eq(S._ocrYieldCount, 1, '诊断计数要能说出"这一轮让路让了几次"（真机读 KH.diagnostics().ocrYield）');
    eq(S._pendingSource, 'mutation', '要记住被顺延的是哪条通道，复检时按同一来源补跑');
  }));

  await test('★ 识别一结束 ⇒ 复检必须真的补跑（"顺延"不是"丢弃"）', () => sandbox(async (c) => {
    c.setInflight(1);
    S._fire('mutation');
    c.setInflight(0);
    await sleep(S._OCR_YIELD_STEP_MS * 2);          // 让步长到点
    deepEq(c.built, ['mutation'], '识别空了以后必须补跑一次重建，否则页面上的内容替换永远不高亮');
    falsy(S._timers.ocrYield, '补跑后计时器要归零，不许重复排队');
  }));

  await test('★ 识别一直不回来 ⇒ 到上限照跑（上限是硬边界：高亮不许被饿死）', () => sandbox(async (c) => {
    c.setInflight(1);
    S._ocrYieldSince = Date.now() - (S._OCR_YIELD_MAX_MS + 50);   // 已经让满上限
    const fired = S._fire('mutation');
    truthy(fired, '过了上限就必须照跑 —— 识别卡死/超时也不能让高亮永远不更新');
    deepEq(c.built, ['mutation'], '这一轮要真的重建');
    eq(S._ocrYieldSince, 0, '跑过之后让路计时起点必须清零（否则下一轮一进来就"已过上限"，让路形同不存在）');
  }));

  await test('★ 空闲页面照旧立即重建（让路只在真有识别在飞时生效）', () => sandbox(async (c) => {
    truthy(S._fire('mutation'), '没有识别在飞时不许有任何延迟');
    deepEq(c.built, ['mutation'], '不引入新延迟 —— 高亮本身不许变慢');
    eq(S._ocrYieldCount, 0, '没让路就不该记数');
  }));

  await test('★ 全量下线时让路计时器要清掉（destroy 之后不许再补跑）', () => sandbox(async (c) => {
    c.setInflight(1);
    S._fire('mutation');
    truthy(S._timers.ocrYield, '前置：确实排在复检');
    S.teardownAll();
    falsy(S._timers.ocrYield, 'teardownAll 必须清掉让路计时器，否则 destroy 后还会凭空重建一次（旧版这行漏了会留下幽灵重建）');
    eq(S._ocrYieldSince, 0, '让路状态也要一起清零');
  }));

  await test('★ 识别在飞时 request() 也只能是"顺延"，不是"丢弃"（gap 窗口与让路互不干扰）', () => sandbox(async (c) => {
    c.setInflight(1);
    S._fire('mutation');                            // 第一次被顺延
    const before = c.built.length;
    c.setInflight(0);
    S.request('mutation', { gap: 0 });              // 相当于复检那一刻
    eq(c.built.length, before + 1, '识别空了以后同一来源的请求必须真的落到重建上');
  }));
};
