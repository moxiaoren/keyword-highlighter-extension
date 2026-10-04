/* tests/specs/hot-update.test.js — 配置热更新必须复核站点门禁
 * ----------------------------------------------------------------------------
 * 回归背景（K40）：`applyConfig` 旧实现只重编译规则 + **无条件 rebuild**，
 * 完全不重评站点门禁。于是走 storage 变更这条路径时：
 *   · 设置页新增白名单 → 本该失效的站点**仍然高亮**；
 *   · 弹窗「禁用本站」写 siteDisabledMap → 高亮被**重建回来**，
 *     与随后 nudge 的 SITE_CHANGED（走 boot）竞态 → "时灵时不灵 / 无效"。
 *
 * 本用例把协作者全部换成桩，只验证 applyConfig 的**门禁语义**
 * （管线本身由其它 spec 与真浏览器 e2e 覆盖）：
 *   · 门禁不通过 → 报告 siteEnabled=false、**不得**再跑管线、且要清掉已渲染高亮；
 *   · 门禁恢复   → 重新上线，恰好再跑一次管线。
 *
 * 注意：断言必须写在 `await test(...)` 里（而不是裸在 run() 里 + try/finally）——
 * 裸断言抛出去会变成 run.js 的"加载 spec 失败"，虽然退出码同样是 1、门禁照样拦，
 * 但失败计数会少算一条，排查时容易被误导（本文件第一版就踩了这个坑）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const STUBS = ['Config', 'Compiler', 'SiteRules', 'Scheduler', 'Rebuilder', 'Scanner', 'Arbiter', 'Renderer', 'registry', 'features'];

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('hot-update · 配置热更新复核站点门禁（K40 不变式）');

  const real = {};
  for (const k of STUBS) real[k] = KH[k];

  let gate = true;      // 站点门禁结论（由用例控制）
  let runs = 0;         // 跑过几次渲染管线
  let cleared = 0;      // 清过几次高亮（下线）

  KH.Config = {
    merge: (o) => o,
    normalize: (c) => ({ config: c }),
    load: async () => ({ config: { globalEnabled: true } })     // boot() 走这条
  };
  KH.Compiler = { compileAll: () => [{ kind: 'normal', ruleId: 'r1' }] };   // 保证 rules.length > 0
  KH.SiteRules = { shouldHighlight: () => gate };
  KH.Scheduler = {
    setupObserver() { }, setupFingerprintWatcher() { }, setupPageClickWatcher() { },
    setupVisibilityWatcher() { }, setupUrlWatcher() { }, teardownAll() { }
  };
  KH.Rebuilder = { enterRebuild() { runs++; }, exitRebuild() { }, clear() { cleared++; } };
  KH.Scanner = { scan: () => [] };
  KH.Arbiter = { resolve: () => ({ resolved: [], shadowed: [] }) };
  KH.Renderer = { render: () => ({ rendered: 0, skipped: 0 }) };
  KH.registry = {
    emit() { }, add() { return { hit: {}, created: true }; },
    all: () => [], visualOnly: () => [], clear() { }, size: 0
  };
  KH.features = { entries: () => [], names: () => [] };

  const realBooted = KH.state.booted;

  /* run() 迭代的是 index.js 模块内的**闭包** features 注册表（不是 KH.features），
   * 所以这里把每个 feature 的 consume 临时换成空实现 —— 否则真实的 note-card 等会去碰
   * 垫片里没有的 window.addEventListener，往 stderr 吐一片异常噪声（会在门禁输出里掩盖真问题）。 */
  const featureRestore = [];
  const reg = real.features;
  if (reg && typeof reg.entries === 'function') {
    for (const [, feat] of reg.entries()) {
      if (feat && typeof feat.consume === 'function') {
        featureRestore.push([feat, feat.consume]);
        feat.consume = () => { };
      }
    }
  }

  try {
    KH.state.booted = true;                       // 已启动过：不牵动 boot() 的调度与 DOM

    await test('门禁通过 → 跑管线并报告 siteEnabled=true', async () => {
      gate = true;
      runs = 0;
      const on = await KH.applyConfig({});
      eq(on.siteEnabled, true, '门禁通过 → 报告 siteEnabled=true');
      eq(runs, 1, '门禁通过 → 恰好跑一次管线');
    });

    await test('★ 门禁不通过 → 报告 siteEnabled=false、不得再跑管线、并清掉高亮', async () => {
      gate = true; runs = 0; cleared = 0;
      await KH.applyConfig({});
      const base = runs;

      gate = false;
      const off = await KH.applyConfig({ siteRules: [{ type: 'whitelist', pattern: 'example.com' }] });
      eq(off.siteEnabled, false, '★ 门禁不通过 → 必须报告 siteEnabled=false');
      eq(runs, base, '★ 门禁不通过时不得再跑管线（旧实现无条件 rebuild → 白名单/禁用本站被重建回来）');
      truthy(cleared > 0, '★ 门禁不通过应下线：清掉已渲染的高亮');
    });

    await test('★ 门禁恢复 → 重新上线，恰好再跑一次管线', async () => {
      gate = false; runs = 0;
      await KH.applyConfig({});
      const base = runs;

      gate = true;
      const back = await KH.applyConfig({ siteRules: [] });
      eq(back.siteEnabled, true, '门禁恢复 → 重新上线');
      eq(runs, base + 1, '门禁恢复 → 再跑一次管线');
    });

    await test('全局开关关掉时同样不得跑管线（与 boot 同判据）', async () => {
      gate = true; runs = 0;
      KH.Config = { merge: (o) => o, normalize: (c) => ({ config: c }) };
      // 用 patch 把 globalEnabled 置 false，走门禁第一项
      KH.Config.normalize = () => ({ config: { globalEnabled: false } });
      await KH.applyConfig({ globalEnabled: false });
      eq(runs, 0, 'globalEnabled=false → 不得跑管线');
      KH.Config.normalize = (c) => ({ config: c });
    });

    /* 状态标记（`<html data-kh-state>`）是诊断与真浏览器回归**唯一**的观察点，
     * 它必须反映**每一次**状态变化 —— 而 URL 变化触发的那次重评走的是内核 `boot()`，
     * 不经过内容脚本那三条写标记的路径。旧实现因此会把标记停在旧值（诊断会看错）。
     * 注：这条必须在**单测**里锁。它当年在 e2e 里是**假绿**的 —— 那时扩展自己写 `stats`
     * 会触发 `storage.onChanged → applyConfig`，那条侧通道顺手也把标记写了，缺口就被掩盖了。
     * 1.99.99.19 把统计功能整体移除后侧通道已不存在，但"标记只由内核在每条出口发布"
     * 这条不变式成本最低、最直接的锁点仍然是这里，所以保留。 */
    await test('★ boot() 必须发布状态标记（on / off）', async () => {
      // 上一条用例把 Config 桩换成了没有 load 的版本；boot() 要读配置，这里恢复完整桩
      KH.Config = {
        merge: (o) => o,
        normalize: (c) => ({ config: c }),
        load: async () => ({ config: { globalEnabled: true } })
      };
      gate = true;
      await KH.boot();
      eq(document.documentElement.getAttribute('data-kh-state'), 'on', '启动成功 → 标记应为 on');
      gate = false;
      await KH.boot();
      eq(document.documentElement.getAttribute('data-kh-state'), 'off', '门禁不通过 → 标记应为 off');
      gate = true;
    });
  } finally {
    for (const [feat, fn] of featureRestore) feat.consume = fn;
    for (const k of STUBS) KH[k] = real[k];
    KH.state.booted = realBooted;
  }
};
