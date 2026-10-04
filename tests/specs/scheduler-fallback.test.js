/* tests/specs/scheduler-fallback.test.js — 「内容出现了却没有任何变动记录」的三条兜底（K60 / v1.99.99.30）
 * ----------------------------------------------------------------------------
 * 实测现场（用户："提交后不高亮、刷新页面才好"）：
 *   `上一轮扫描: 文本节点=29`，而同一时刻文档里有 512 个文本节点 —— 内容是在那次扫描**之后**长出来的，
 *   之后**再也没有重建**。而旧版（1.99.99.17）能工作，是因为它那条**每秒文本指纹轮询**一直在跑。
 * 成因有三类，都不产生"我们能处理的变动记录"：
 *   ① 内容由 **CSS 动画 / 过渡**显出来（只变样式，DOM 一个节点一个属性都没动）；
 *   ② 内容在**观察器换 body / 重挂的空隙**里长出来（记录丢了）；
 *   ③ 框架渲染方式让记录没落到我们手里。
 * 这一轮补三条兜底：动画/过渡结束（`setupAnimWatcher`）、**文本量暴涨**（`setupGrowthWatcher`）、
 * 以及保守档恢复旧版的每秒指纹轮询。本文件锁住"文本量暴涨"的判据与计时器的挂载/撤销。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const S = KH.Scheduler;

  suite('调度兜底：内容凭空出现时也要重建（K60）');

  await test('★ 文本量暴涨判据：内容"长出来"要判重建，同一块文本被改写不判', () => {
    const v = (a, b) => S.growthVerdict(a, b);
    eq(v(0, 500), true, '从空到有内容 → 必须重建');
    eq(v(29, 4426), true, '实测现场的量级（29 → 4426）→ 必须重建');
    eq(v(1000, 1400), true, '增长 40% → 重建');
    eq(v(1000, 1140), false, '增长 14%（不到 15% 且不足 300 字）→ 不重建');
    eq(v(20000, 20400), false, '大页面上多 400 字（时钟/计数滚动）→ 不该整页重建');
    eq(v(1000, 1000), false, '没变 → 不重建');
    eq(v(1000, 900), false, '变少（内容被删）→ 不重建（删除由变动记录负责）');
    eq(v(0, 100), false, '小页面多 100 字（不足以判定"内容长出来"）→ 不重建');
  });

  await test('★ 每次重建都要记下"这一轮看到的文本总量"（暴涨判据的基准）', () => {
    const box = H.el('div');
    box.innerHTML = '华为技术有限公司 一二三四五六七八九十';
    document.body.appendChild(box);
    const saved = S._scanTextLen;
    const savedRebuild = KH.rebuild;
    try {
      KH.rebuild = () => ({ ok: true });      // 替身：这条只验"基准有没有记"，不跑真管线（垫片里跑不出真 DOM）
      S._fire('test');
      truthy(S._scanTextLen > 0, '_fire 之后必须留下本轮的文本总量');
      eq(S._scanTextLen, S.textLen(), '基准必须等于当前的文本总量');
    } finally {
      KH.rebuild = savedRebuild;
      if (box.parentNode) box.parentNode.removeChild(box);
      S._scanTextLen = saved;
    }
  });

  await test('★ 涨势兜底计时器：页面变动观察开着才跑；关掉就不跑（省资源口径不变）', () => {
    const savedTimer = S._timers.growth;
    try {
      S.setupGrowthWatcher({ pageRebuildOnChange: true, pageFingerprintIntervalMs: 60000 });
      truthy(S._timers.growth, '开着"页面内容变化时自动重建"→ 必须挂上涨势检查');
      clearInterval(S._timers.growth);
      S.setupGrowthWatcher({ pageRebuildOnChange: false });
      falsy(S._timers.growth, '关掉自动重建后不该再跑任何轮询（省资源的口径不变）');
    } finally {
      clearInterval(S._timers.growth);
      S._timers.growth = savedTimer || null;
    }
  });
};
