/* tests/specs/scheduler-defer.test.js — 「延迟裁决」不许把待办吞掉（K56 / v1.99.99.25）
 * ----------------------------------------------------------------------------
 * 实测缺陷（用户现场）：点"提交"翻页后，命中格子被框架整个换掉 → 审核状态那格**不再高亮**、
 * 面板里的抓取字段也不更新；**切走标签页再切回来**才恢复（可见性通道是一次立即重建）。
 * 真浏览器现场（`_e2e/probe-defer.js`）：`swap@1761 rebuilds=[] now=10845` —— 9 秒零重建。
 *
 * 根因在 `_drainMutations`（静默窗口的裁决）有两条"没人管"的路：
 *   ① 还没安静就 `return` —— 指望"下一条记录到来时顺手再排"。可**最后一批变动之后不会再有记录**，
 *      于是那一批记录永远躺在 `_pendingRecords` 里（早退时必须自己补排）。
 *   ② 页面上有源源不断的无关变动（计时器刷状态点、轮播改 style/class）时会一直刷新
 *      `_lastMutationAt` → 每次都"还没安静" → 顺延到天荒地老（必须有延迟上限）。
 * 反向验证：把这两条改回旧行为，本文件第 1、2 条立刻变红（`_e2e/probe-defer.js` 也复现 9 秒零重建）。
 *
 * 注意：这里锁的是**调度时机**，不是判据本身（判据在 relevance.test.js）。
 * 上限只许跳过"等安静"，**绝不许跳过相关性判定**（第 4 条）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;

/** 一条"无关紧要"的变更记录（判据被替身接管，形态只要能进 `_pendingRecords` 即可） */
function rec() {
  return { type: 'childList', target: null, addedNodes: [], removedNodes: [] };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const S = KH.Scheduler;

  /** 把调度器现场换成可控的替身，跑完**逐项还原**（单测共用同一份内核实例，不留脏状态） */
  function sandbox(verdict, fn) {
    const saved = {
      cap: S._DEFER_CAP_MS,
      classify: KH.Relevance.classify,
      request: S.request,
      records: S._pendingRecords,
      first: S._drainFirstPendingAt,
      lastMut: S._lastMutationAt,
      silent: S._timers.silent,
      capped: S._deferCappedCount,
      drain: S._drainCount
    };
    S._timers.silent = null;
    S._pendingRecords = [];
    S._drainFirstPendingAt = 0;
    S._drainCount = 0;
    S._deferCappedCount = 0;
    S._DEFER_CAP_MS = 200;                       // 上限在测试里缩短，跑得快
    const calls = [];
    S.request = (src) => calls.push(src);        // 替身：只看"轮不轮得到裁决"
    KH.Relevance.classify = () => verdict;
    try {
      return fn(calls);
    } finally {
      S._DEFER_CAP_MS = saved.cap;
      S.request = saved.request;
      KH.Relevance.classify = saved.classify;
      S._pendingRecords = saved.records;
      S._drainFirstPendingAt = saved.first;
      S._lastMutationAt = saved.lastMut;
      clearTimeout(S._timers.silent);
      S._timers.silent = saved.silent;
      S._deferCappedCount = saved.capped;
      S._drainCount = saved.drain;
    }
  }

  suite('调度：静默窗口不许把裁决饿死（K56）');

  await test('★ 还没安静就早退时，必须自己补排一次（最后一批变动之后不能没人管）', () => {
    sandbox('full', (calls) => {
      S._lastMutationAt = Date.now();            // 刚刚才变过
      S._stashRecords([rec()]);
      truthy(S._drainFirstPendingAt > 0, '攒到记录时必须记下"最早攒到时刻"（延迟上限的计时起点）');
      S._drainMutations(200);                    // 距最后变动 ~0ms → 走"还没安静"的早退分支
      falsy(calls.length, '还没安静时不该立刻重建（静默窗口本身仍然有效）');
      truthy(S._timers.silent, '早退时必须补排计时器；旧实现这里直接 return，这批记录再也没人裁决（实测翻页后一直不亮）');
      clearTimeout(S._timers.silent);
      S._timers.silent = null;
    });
  });

  await test('★ 拖过延迟上限就不许再等安静（持续变动的页面也必须裁决一次）', () => {
    sandbox('full', (calls) => {
      S._stashRecords([rec()]);
      S._drainFirstPendingAt = Date.now() - (S._DEFER_CAP_MS + 50);   // 已经拖过上限
      S._lastMutationAt = Date.now();                                 // 永远安静不下来
      S._drainMutations(200);
      deepEq(calls, ['mutation'], '拖过上限必须**不等安静**直接裁决并重建（否则就是饿死）');
      eq(S._deferCappedCount, 1, '诊断计数要能说出"这一轮是拖过上限才判的"');
      eq(S._pendingRecords.length, 0, '裁决后必须清空攒下的记录');
      eq(S._drainFirstPendingAt, 0, '裁决后必须清零计时起点（否则下一批会被上一批的起点连累，立刻又触发上限）');
    });
  });

  await test('★ 正常安静路径照旧（上限只兜底，不改变"等够静默窗口"的正常节奏）', () => {
    sandbox('full', (calls) => {
      S._stashRecords([rec()]);
      S._lastMutationAt = Date.now() - 500;      // 已经安静够了
      S._drainMutations(200);
      deepEq(calls, ['mutation'], '等够静默窗口 → 正常重建');
      eq(S._deferCappedCount, 0, '这条路径不该用到延迟上限');
      falsy(S._timers.silent, '既然已经裁决，就不该再排下一次');
    });
  });

  await test('★ 延迟上限只许跳过"等安静"，绝不许跳过相关性判定（判 skip 就不重建）', () => {
    sandbox('skip', (calls) => {
      S._stashRecords([rec()]);
      S._drainFirstPendingAt = Date.now() - (S._DEFER_CAP_MS + 50);
      S._lastMutationAt = Date.now();
      S._drainMutations(200);
      falsy(calls.length, '判据说"与命中无关" → 即便拖过上限也不许重建（否则退化成"一直重建"）');
      eq(S._pendingRecords.length, 0, 'skip 也照样清空攒下的记录（不能越攒越多）');
    });
  });

  await test('★ 攒记录时，中途追加不刷新"最早攒到时刻"（否则上限自己也会被无限顺延）', () => {
    sandbox('full', () => {
      const t0 = 1700000000000;
      const realNow = Date.now;
      try {
        Date.now = () => t0;
        S._stashRecords([rec()]);
        const first = S._drainFirstPendingAt;
        Date.now = () => t0 + 1000;
        S._stashRecords([rec()]);
        eq(S._drainFirstPendingAt, first, '同一批记录里继续追加，起点必须还是第一次攒到的时刻');
      } finally { Date.now = realNow; }
    });
  });
};
