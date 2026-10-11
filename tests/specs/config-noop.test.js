/* tests/specs/config-noop.test.js — 配置"没真变"就不许动页面（K80 · F2 / 2.0.1.14）
 * ----------------------------------------------------------------------------
 * 实测缺陷（T3 裁决 6a，`_stage/wayfinder-perf/rootcause.md`）：
 *   `content/content.js:49-60` 把 `chrome.storage.local` 的**每一个键**都拼成 patch 送来，
 *   而 `Config.merge` 对未知键"宽容保留"（`config.js:264`）—— 于是版本标记
 *   （`khLastSeenVersion`）、OCR 语言包/模型缓存（`kh-ocr-lang-v1` / `kh-ocr-model-v1`）
 *   这些**跟页面渲染毫无关系**的写入，也会被当成"配置变了"，
 *   触发**每个打开的标签页各跑一整轮全页重建**。
 *   真机读数：一次 storage 写入 = 目标页 12023.9ms + 第二页 9244.5ms。
 *
 * 修法：`applyConfig` 比 `configSig`（只含 `Config.defaults` 的顶层键）——
 *   签名没变 ⇒ 直接返回 `source:'config-noop'`，不重挂调度通道、不重建、不发 CONFIG_CHANGED。
 *   （配置对象本身仍然更新，"宽容保留未知键"的语义不变。）
 *
 * 本文件锁四件事：未知键不重建 / **真配置变了照旧重建**（不能把真变化吞掉）/ 未 boot 不抢跑 /
 * 以及一条**防未来漏键**的守卫：全仓读到的配置键必须都在 `Config.defaults` 里。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, deepEq, truthy } = H;
const fs = require('fs');
const path = require('path');

const STUBS = ['Config', 'Compiler', 'SiteRules', 'Scheduler', 'Rebuilder', 'Scanner', 'Arbiter', 'Renderer', 'registry', 'features'];

/* 扫到的"配置键"里混进来的**非配置**成员：`.js` 是注释里的文件名（`config.js`），不是键。 */
const NOT_A_CONFIG_KEY = new Set(['js']);

/** 递归列出扩展源码目录下的所有 .js（这些才是"读配置"的地方；tests/ 与 _e2e/ 不算） */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (/\.js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['src', 'content', 'background', 'offscreen', 'popup', 'options', 'welcome']) walk(path.join(root, d));
  return out;
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('config-noop · 配置没真变就不许动页面（K80 · F2）');

  const real = {};
  for (const k of STUBS) real[k] = KH[k];
  const realBooted = KH.state.booted;
  const realConfig = KH.state.config;
  const realSig = KH.state.configSig;
  /* 真实的 defaults：既用于跑桩，也用于守卫测试（桩不许把这条守卫糊过去） */
  const realDefaults = Object.assign({}, real.Config && real.Config.defaults);

  let arm = 0;     // 重挂调度通道的次数
  let runs = 0;    // 跑渲染管线的次数

  /* 真实的 feature 注册表在 index.js 闭包里，run() 会调到它们；换成空实现避免碰垫片里没有的 DOM API */
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
    KH.Config = {
      defaults: Object.assign({}, realDefaults),
      /* merge 的宽容保留语义与真实 `config.js:255-268` 一致：未知键原样收下 */
      merge: (stored) => Object.assign({}, stored),
      normalize: (c) => ({ config: Object.assign({}, c) })
    };
    KH.Compiler = { compileAll: () => [{ kind: 'normal', ruleId: 'r1' }] };
    KH.SiteRules = { shouldHighlight: () => true };
    KH.Scheduler = {
      setupObserver() { arm++; }, setupFingerprintWatcher() { }, setupPageClickWatcher() { },
      setupVisibilityWatcher() { }, setupUrlWatcher() { }, teardownAll() { }
    };
    KH.Rebuilder = { enterRebuild() { runs++; }, exitRebuild() { }, clear() { } };
    KH.Scanner = { scan: () => [] };
    KH.Arbiter = { resolve: () => ({ resolved: [], shadowed: [] }) };
    KH.Renderer = { render: () => ({ rendered: 0, skipped: 0 }) };
    KH.registry = { emit() { }, add() { return { hit: {}, created: true }; }, all: () => [], visualOnly: () => [], clear() { }, size: 0 };
    KH.features = { entries: () => [], names: () => [] };

    /* 从确定的现场起步（不依赖前面 spec 留下的 state.config / configSig）：
     * 已知键有值 + 签名未知 ⇒ 第一次 applyConfig 必定走"正常路径"，空转判据才有对照。 */
    KH.state.config = { globalEnabled: true, keywords: [] };
    KH.state.configSig = '';
    KH.state.booted = true;

    await test('★ 未知键写入（版本标记 / OCR 缓存）⇒ 不重建、不重挂通道、报告 config-noop', async () => {
      runs = 0; arm = 0;
      await KH.applyConfig({});                                     // 基线：签名从空变成实值 → 正常路径
      const baseRuns = runs, baseArm = arm;
      truthy(baseRuns > 0 && baseArm > 0, '前置：基线那一次必须真的跑了管线并重挂了通道（否则本用例是空转通过）');

      /* 模拟 content.js 送来的真实 storage 变更：一个与渲染无关的版本标记 + OCR 缓存键 */
      const r = await KH.applyConfig({ khLastSeenVersion: '2.0.1.14', 'kh-ocr-lang-v1': 'chi_sim', 'kh-ocr-model-v1': 'ppocr-v4' });
      eq(r.source, 'config-noop', '★ 未知键变化必须走"空转"分支（否则每次写版本标记都全页重建）');
      eq(runs, baseRuns, '★ 不许重建 —— 真机读数：一次无关写入 = 目标页 12.0s + 第二页 9.2s（T3 候选 6a）');
      eq(arm, baseArm, '★ 不许重挂调度通道（通道本身没变，重挂就是白干活）');
      eq(r.siteEnabled, true, '空转也要如实报告当前站点门禁结论（调用方据此更新标记）');
      eq(KH.state.config['kh-ocr-lang-v1'], 'chi_sim', '未知键仍然被"宽容保留"（本次只改"动不动页面"，不改数据语义）');
    });

    await test('★ 真配置变了必须照旧重建一次（"跳过"只许跳过没变的）', async () => {
      runs = 0; arm = 0;
      const r = await KH.applyConfig({ importantNote: { fontSize: 15 } });
      eq(runs, 1, '★ 已知配置键变化 → 必须跑一次管线（把真变化吞掉才是真事故）');
      truthy(arm > 0, '★ 已知配置键变化 → 调度通道照旧重挂（配置可能改了观察范围/限频）');
      truthy(r.source !== 'config-noop', '★ 有真变化就不许报告空转');
    });

    await test('★ 未知键与已知键混在同一批 ⇒ 以"有真变化"为准（不许被未知键带偏，也不许漏）', async () => {
      runs = 0;
      await KH.applyConfig({ khLastSeenVersion: '2.0.1.15' });      // 纯未知键（已知键全都没动）
      eq(runs, 0, '前置：已知键一个都没动 ⇒ 空转');
      const r = await KH.applyConfig({ keywords: [{ text: '新词' }], khLastSeenVersion: '2.0.1.16' });
      eq(runs, 1, '★ 同一批里只要有一个真配置键变了，就必须重建');
      truthy(r.source !== 'config-noop', '★ 有真变化就不许报告空转');
    });

    await test('★ 未 booted 时不抢跑：走原路径返回 source="config"（此时还没有页面状态可省）', async () => {
      KH.state.booted = false;
      runs = 0;
      const r = await KH.applyConfig({ khLastSeenVersion: '2.0.1.17' });
      eq(runs, 0, '未启动时本来就不跑管线');
      eq(r.source, 'config', '未 booted 时不许报 config-noop（空转是"已启动且没变"的结论，别把两种情形混成一个）');
      KH.state.booted = true;
    });

    await test('★ 守卫：全仓读到的配置键必须都在 Config.defaults 里（否则"改了不生效"会回来）', () => {
      const root = path.join(__dirname, '..', '..');
      const keys = new Set();
      const re = /(?<![\w$.])(?:cfg|config|normalized|state\.config)\.([A-Za-z_$][\w$]*)/g;
      for (const f of sourceFiles(root)) {
        const text = fs.readFileSync(f, 'utf8');
        let m;
        while ((m = re.exec(text))) keys.add(m[1]);
      }
      const missing = [];
      for (const k of keys) {
        if (NOT_A_CONFIG_KEY.has(k)) continue;
        if (!Object.prototype.hasOwnProperty.call(realDefaults, k)) missing.push(k);
      }
      deepEq(missing, [], '★ 这些键被读但不在 Config.defaults 里 → 配置签名（F2 空转判据）会把它当"未知键"跳过，改了不生效');
      truthy(keys.size >= 10, '守卫自身要有效：扫到的键太少说明扫错了目录（当前 ' + keys.size + ' 个）');
    });
  } finally {
    for (const [feat, fn] of featureRestore) feat.consume = fn;
    for (const k of STUBS) KH[k] = real[k];
    KH.state.booted = realBooted;
    KH.state.config = realConfig;
    KH.state.configSig = realSig;
  }
};
