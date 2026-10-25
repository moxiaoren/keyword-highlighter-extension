/* tests/specs/config-noop.test.js — 配置"没真变"就不许动页面（K80 · F2 / 2.0.1.14）
 * ----------------------------------------------------------------------------
 * 实测缺陷（T3 裁决 6a，`_stage/wayfinder-perf/rootcause.md`）：
 *   `content/content.js` 把 `chrome.storage.local` 的**每一个键**都拼成 patch 送来，
 *   而 `Config.merge` 对未知键"宽容保留"（`config.js`）—— 于是版本标记
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
 *
 * T33（2.0.1.15 需求 4）追加第五件事：**UI-only 键**（`importantNote` / `notePanelWidth`，
 * 判据与读点清单见 `src/core/index.js` 的 `UI_ONLY_KEYS`）变了 ⇒ 不整页重建，只重跑 ⑦Consume。
 * 方向是**保守**的：只有"全键签名变了 + 核心签名没变"才跳；核心键一律照旧重建（反向守卫在下）。
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
  const realSigCore = KH.state.configSigCore;
  const realSiteEnabled = KH.state.siteEnabled;
  /* 真实的 defaults：既用于跑桩，也用于守卫测试（桩不许把这条守卫糊过去） */
  const realDefaults = Object.assign({}, real.Config && real.Config.defaults);

  let arm = 0;     // 重挂调度通道的次数
  let runs = 0;    // 跑渲染管线的次数

  /* 真实的 feature 注册表在 index.js 闭包里，run() 会调到它们；换成空实现避免碰垫片里没有的 DOM API。
   * T33 起顺手记下**每个 feature 的 consume 参数** —— 仅消费这条路必须真的把新 config 交给
   * `important-note`（面板 render 就是从它读宽度/字号/图片尺寸的）。 */
  const consumeCalls = [];
  const featureRestore = [];
  const reg = real.features;
  if (reg && typeof reg.entries === 'function') {
    for (const [label, feat] of reg.entries()) {
      if (feat && typeof feat.consume === 'function') {
        featureRestore.push([feat, feat.consume]);
        feat.consume = (hits, cfg, ctx) => { consumeCalls.push({ label, cfg, ctx }); };
      }
    }
  }

  try {
    /* 桩只覆盖"调度判据"这三件事；其余成员（归一函数 / 常量 / 面板 render 用到的读表辅助）
     * 由原型继承真实 Config —— 否则每加一个 render 依赖就要往桩里补一把，而且补漏时
     * 底下那条"三个 CSS 变量必须在 dirty 判定之前写"会被 TypeError 挡住，看起来像产品坏了。 */
    KH.Config = Object.create(real.Config);
    KH.Config.defaults = Object.assign({}, realDefaults);
    /* merge 的宽容保留语义与真实 `config.js` 一致：未知键原样收下 */
    KH.Config.merge = (stored) => Object.assign({}, stored);
    KH.Config.normalize = (c) => ({ config: Object.assign({}, c) });
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
    KH.state.configSigCore = '';
    KH.state.booted = true;
    /* T33 的仅消费分支要求"站点当前启用"（失效页没有面板可刷，那条路该走到 destroy 下线） */
    KH.state.siteEnabled = true;

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
      /* 用**核心键**做样例：`importantNote.fontSize` 自 T33 起属 UI-only（走仅消费，见下一组用例） */
      const r = await KH.applyConfig({ matchSettings: { highlightInInputs: true } });
      eq(runs, 1, '★ 已知配置键变化 → 必须跑一次管线（把真变化吞掉才是真事故）');
      truthy(arm > 0, '★ 已知配置键变化 → 调度通道照旧重挂（配置可能改了观察范围/限频）');
      truthy(r.source !== 'config-noop', '★ 有真变化就不许报告空转');
    });

    await test('★ T33 · 只改 UI-only 键（面板宽度 / 面板字号）⇒ 不重建、不重挂通道、只走一次⑦Consume', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      const r = await KH.applyConfig({ notePanelWidth: 320 });
      eq(runs, 0, '★ 只改面板宽度 ⇒ 不许整页重建（重页面一轮 4.3s × 每个打开的标签页）');
      eq(arm, 0, '★ 不许重挂调度通道（观察范围一个字没变，重挂就是白干活）');
      eq(r.source, 'config', '这不是"没变"—— 配置真改了，只是不用重建（别报 config-noop）');
      eq(r.consumeOnly, true, '★ 必须走⑦Consume 快通道（面板 render 才会把新宽度写到 CSS 变量上）');
      eq(KH.state.config.notePanelWidth, 320, 'state.config 必须已更新（面板 render 就是从它读宽度的）');
      eq(r.siteEnabled, true, '如实回报站点门禁结论（调用方据此更新就绪标记）');
      const note = consumeCalls.filter((c) => c.label === 'important-note');
      eq(note.length, 1, '★ important-note 的 consume 必须真被调到一次（否则新宽度落不到面板上）');
      eq(note[0].cfg.notePanelWidth, 320, '★ consume 拿到的必须是**更新后**的 config，不是上一轮的');
      eq(note[0].ctx.consumeOnly, true, '★ 必须带 consumeOnly 上下文（img-ocr 据此不许清空已有图片条目）');

      /* 同类的第二个 UI-only 键：面板字号（与宽度同一读点：panel.render 里的 CSS 变量） */
      runs = 0; arm = 0; consumeCalls.length = 0;
      await KH.applyConfig({ importantNote: { fontSize: 15 } });
      eq(runs, 0, '★ 面板字号同属 UI-only ⇒ 也不许重建');
      eq(arm, 0, '★ 不重挂通道');
      eq(consumeCalls.filter((c) => c.label === 'important-note').length, 1, '★ 走了一次仅消费');
      eq(KH.state.config.importantNote.fontSize, 15, '新字号必须落进 state.config（否则面板读到的还是旧值）');
    });

    await test('★ T33 反向守卫：核心键变了必须照旧整页重建（只许跳过 UI-only）', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      /* 核心键用**标量**值（`changeHandling`）：签名是 `JSON.stringify(cfg, 已知顶层键)`，
       * 而 replacer 数组对**嵌套对象**是过滤式的 ⇒ `keywords` 里的对象只按数组长度入签名
       * （`[{text:'a'}]` 与 `[{text:'b'}]` 的签名都是 `{"keywords":[{}]}`）。
       * 拿 keywords 当样例会把后面那条"混合批次"用例变成"长度没变 ⇒ 空转"。 */
      const r = await KH.applyConfig({ changeHandling: 'always', notePanelWidth: 320 });
      eq(runs, 1, '★ 核心键（变更处理方式）变了 ⇒ 必须整页重建，不许被同批的 UI-only 键带偏');
      truthy(arm > 0, '★ 必须重挂调度通道（changeHandling 直接改的就是调度侧行为）');
      truthy(r.consumeOnly !== true, '★ 不许走仅消费（那会把"核心配置变了"的整页更新吞掉）');
      truthy(r.source !== 'config-noop', '★ 有真变化就不许报空转');

      /* 对照组：同一批里核心键没动 ⇒ 只走仅消费 */
      runs = 0; arm = 0; consumeCalls.length = 0;
      const r2 = await KH.applyConfig({ notePanelWidth: 330, importantNote: { imgSize: 80 } });
      eq(runs, 0, '★ 核心键没动 ⇒ 不重建');
      eq(r2.consumeOnly, true, '★ 走仅消费');
    });

    await test('★ T33 既有语义不回归：未知键 ⇒ 仍 config-noop，连仅消费都不跑', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      const r = await KH.applyConfig({ khLastSeenVersion: '2.0.1.99' });
      eq(r.source, 'config-noop', '★ 未知键仍走空转分支（宽容保留语义不变）');
      eq(runs, 0, '★ 不重建');
      eq(arm, 0, '★ 不重挂通道');
      eq(consumeCalls.length, 0, '★ 连仅消费都不跑 —— 没变就是没变');
    });

    await test('★ T33 前提守卫：render 必须在判 dirty / 提前 return 之前写三个 CSS 变量', () => {
      /* 这条守的是 T33 的**整个前提**：仅消费这条路内容一个字没变也照样应用新宽度/字号/图片尺寸。
       * 用"页面上一个笔记都没有"跑真 render —— 实际路径就是 ①ensure 造壳 ②写三个 CSS 变量
       * ③发现没内容 ⇒ hide + 提前 return。变量若挪到 `dirty` 判定之后（或挪进 renderContent），
       * 这条路一个都写不出来 ⇒ 这里红。真机表现："设置页改了宽度、面板不动"，而其它断言全绿。
       * （旧写法按行切 `render()` 函数体做字符串定位 —— 换个等价换行/缩进就假红，且证明不了运行结果。） */
      const p = Object.create(KH.ImportantNote.panel);
      p.panelEl = null;                     // 外壳未建 ⇒ 必须走 ensure() + 前半段，不靠任何桩
      p.render([], { notePanelWidth: 9999, importantNote: { imgSize: 9999, fontSize: 9999 } });
      eq(p.root.style.getPropertyValue('--khin-panel-w'), KH.Config.normalizePanelWidth(9999) + 'px',
        '★ --khin-panel-w 必须在 dirty 判定之前写（越界值经唯一归一函数夹到上界）');
      /* 图片尺寸与正文字号写在 host 上（变量定义处是宿主/影子里的规则），面板宽度写在 .khin-wrap
       * 上 —— 别对着同一个元素查三个变量，那会看起来像"没写"。 */
      eq(p.host.style.getPropertyValue('--kh-img-size'), KH.Config.normalizeImgSize(9999) + 'px',
        '★ --kh-img-size 同上（写掉了设置页改了图尺寸、面板不理）');
      eq(p.host.style.getPropertyValue('--kh-note-fs'), KH.Config.normalizeNoteFontSize(9999) + 'px',
        '★ --kh-note-fs 同上');
    });

    await test('★ 未知键与已知键混在同一批 ⇒ 以"有真变化"为准（不许被未知键带偏，也不许漏）', async () => {
      runs = 0;
      await KH.applyConfig({ khLastSeenVersion: '2.0.1.15' });      // 纯未知键（已知键全都没动）
      eq(runs, 0, '前置：已知键一个都没动 ⇒ 空转');
      const r = await KH.applyConfig({ keywords: [{ text: '新词' }], khLastSeenVersion: '2.0.1.16' });
      eq(runs, 1, '★ 同一批里只要有一个真配置键变了，就必须重建');
      truthy(r.source !== 'config-noop', '★ 有真变化就不许报告空转');
    });

    /* 【T36】嵌套内容变化必须进签名。旧实现把 `JSON.stringify` 的**数组式 replacer** 当"只作用于顶层"
     * 用，可它在**每一层**都是属性白名单 ⇒ 嵌套对象被掏成 `{}`，只剩数组长度可见。
     * 症状：设置页改某个关键词的文字（数量不变）⇒ 签名不变 ⇒ 已打开页面永远高亮**旧词**。 */
    await test('★ T36：嵌套内容变了（keywords[0].text 改字、数量不变）⇒ 不许报 config-noop，必须整页重建', async () => {
      runs = 0; arm = 0;
      const before = JSON.stringify(KH.state.config.keywords);
      const r = await KH.applyConfig({ keywords: [{ text: '新词二' }] });
      truthy(before !== JSON.stringify(KH.state.config.keywords), '前置：这次 patch 确实换了关键词内容（长度不变）');
      truthy(r.source !== 'config-noop', '★ 嵌套内容变了就不许报空转（否则设置页改词之后，已打开页面永远高亮旧词）');
      eq(runs, 1, '★ 必须重跑一次管线（旧词的高亮要拆掉、新词要上）');
    });

    await test('★ T36：嵌套标量翻转（matchSettings.defaultCaseSensitive）⇒ 不许报 config-noop', async () => {
      runs = 0; arm = 0;
      const cur = KH.state.config.matchSettings || {};
      const r = await KH.applyConfig({ matchSettings: Object.assign({}, cur, { defaultCaseSensitive: !cur.defaultCaseSensitive }) });
      truthy(r.source !== 'config-noop', '★ 只翻了嵌套里的一个布尔，也必须算"配置真变了"');
      eq(runs, 1, '★ 大小写口径可能直接改命中集 ⇒ 必须重跑管线');
    });

    await test('★ T36 反向守卫：纯未知键仍 config-noop、UI-only 键仍走仅消费（修嵌套别把 K80/F2 与 T33 弄丢）', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      const a = await KH.applyConfig({ khLastSeenVersion: '2.0.1.19' });
      eq(a.source, 'config-noop', '★ 未知键（版本标记）仍必须空转 —— 这是 K80/F2 的立命之本');
      eq(runs, 0, '★ 未知键不许重建');

      const b = await KH.applyConfig({ notePanelWidth: 340 });
      eq(runs, 0, '★ UI-only 键仍不许整页重建（T33 判据不因本次修法变化）');
      eq(b.consumeOnly, true, '★ UI-only 键仍必须走仅消费');
      eq(arm, 0, '★ UI-only 键不许重挂调度通道');

      const c = await KH.applyConfig({ importantNote: { imgSize: 70, fontSize: 13 } });
      eq(runs, 0, '★ importantNote 同为 UI-only：面板字号变了也不许整页重建');
      eq(c.consumeOnly, true, '★ 必须走仅消费把新字号写下去');
      truthy(consumeCalls.length >= 2, '★ 两次 UI-only 变更都要真的把新 config 送给 feature.consume');
    });

    /* 【T36b】消减清单（lead 裁决 ① ② 另加）：顶层键按**读点位置**分三类，别一刀切。
     *   ① 页面侧零读点（`migrated`）        ⇒ 两个签名都不进 ⇒ 写入后连 Consume 都不跑（永不动任何东西）
     *   ② 页面侧读点全在 ⑦Consume（`noteCardStyle`）⇒ 进 UI_ONLY_KEYS ⇒ 只重跑 Consume
     *   （T52 订正：`imgOcr` **不在**此类 —— `img-ocr.js` 在仅消费通道早退，见下面它的反向守卫）
     *   ③ 被 ③Scan / ⑤Render / 编译 / 站点门禁读的 ⇒ 留在核心签名 ⇒ 照旧整页重建
     * 为什么 `migrated` 必须堵：`options.js` 点掉迁移提示会写它（`ocr-options.test.js` 钉着），
     * 不堵的话**每个打开的标签页各重建一轮** —— 与 K80/F2 修的是同一类"无关写入白干活"。 */
    await test('★ T36b：迁移标记 migrated 零页面侧读点 ⇒ 两个签名都不进（连仅消费都不许跑）', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      await KH.applyConfig({ migrated: { ocrEngine: true } });   // 前置：不存在 → 存在
      eq(runs, 0, '★ 前置：迁移标记从无到有也不许重建');
      eq(consumeCalls.length, 0, '★ 前置：连仅消费都不许跑');

      runs = 0; arm = 0; consumeCalls.length = 0;
      const r = await KH.applyConfig({ migrated: { ocrEngine: false } });
      eq(runs, 0, '★ 点掉迁移提示（写该标记）不许整页重建 —— 否则每个打开的标签页都白跑一轮');
      eq(consumeCalls.length, 0, '★ 也不许走仅消费：页面侧零读点，动它就是白干活');
      eq(arm, 0, '★ 不许重挂调度通道');
      eq(r.source, 'config-noop', '★ 两个签名都不含它 ⇒ 空转分支（语义：永不动任何东西）');
    });

    await test('★ T36b：noteCardStyle 读点全在⑦Consume ⇒ 只走仅消费、不整页重建', async () => {
      runs = 0; arm = 0; consumeCalls.length = 0;
      const r = await KH.applyConfig({ noteCardStyle: { bgColor: '#fff8e1', borderColor: '#e0c080' } });
      eq(runs, 0, '★ 笔记卡配色只被 note-card.js 的 consume 读 ⇒ 不许整页重建');
      eq(r.consumeOnly, true, '★ 必须走仅消费把新配色送下去');
      eq(arm, 0, '★ 不重挂通道');
      eq(r.source, 'config', '配置真改了（只是不用重建）—— 别报 config-noop');
      eq(KH.state.config.noteCardStyle.bgColor, '#fff8e1', 'state.config 必须已更新（consume 就从它读）');
      truthy(consumeCalls.length >= 1, '★ 新 config 必须真的送给 feature.consume');
    });

    /* 【T52 / F1 反向守卫】`imgOcr` **不许**进 UI_ONLY_KEYS —— 别被"engine 页面侧零读点"骗回去。
     * 依据：`img-ocr.js` 在**仅消费通道直接早退**（`if (ctx && ctx.consumeOnly) return;`），
     * 它成立的前提是"图片相关的变更必然判 'full'"（`relevance.js`）；而跨域白名单
     * `imgOcr.crossOriginSites` 的页面侧唯一读点（`img-ocr.js` 的 `crossOriginAllowed`）
     * **只在 `build()` 里跑** ⇒ 一旦 imgOcr 落进 UI_ONLY_KEYS，**设置页把站点加进白名单后
     * 已打开页面不生效**（要等一次真正的整页重建），与设置页"登记一次以后都算数"的文案直接冲突
     * —— 这就是发版阻塞回归 F1。变体乙（让它重跑跨域判定）同样不行：仅消费通道给的 hits 不是
     * 全量命中，照常 `build()` 会把已有图片命中清空（`img-ocr.js`）。
     * **接受的代价**：改 `engine` 也顺带整页重建一次（罕见、一次性），别为它做精细分类。 */
    await test('★ T52 反向守卫：imgOcr 改动必须整页重建（不许塞进 UI_ONLY_KEYS —— img-ocr 在仅消费通道早退）', async () => {
      const cases = [
        ['crossOriginSites（白名单，页面侧读点 img-ocr.js:190，改了必须重跑分类）', { imgOcr: { crossOriginSites: { 'cdn.test': true } } }],
        ['engine（页面侧零读点，但一并接受这次重建）', { imgOcr: { crossOriginSites: { 'cdn.test': true }, engine: 'ppocr' } }]
      ];
      for (const [what, patch] of cases) {
        runs = 0; arm = 0; consumeCalls.length = 0;
        const r = await KH.applyConfig(patch);
        eq(runs, 1, '★ imgOcr.' + what + ' 变了必须整页重建 —— img-ocr.js:633 在仅消费通道早退 ⇒ '
          + '不许把 imgOcr 塞进 UI_ONLY_KEYS（否则白名单改了页面不动）');
        truthy(r.consumeOnly !== true, '★ imgOcr.' + what + ' 不许走仅消费（仅消费通道下 img-ocr 的 build/classify 根本不跑）');
        truthy(arm > 0, '★ imgOcr.' + what + ' 必须重挂调度通道');
      }
    });

    await test('★ T36b 反向守卫：被 Scan/Render/编译/站点门禁读的键一律仍整页重建（highlightStyle 不许进表）', async () => {
      const cases = [
        ['keywords[0].text（编译读）', { keywords: [{ text: '新词三' }] }],
        ['matchSettings 嵌套标量（匹配口径）', { matchSettings: Object.assign({}, KH.state.config.matchSettings || {}, { defaultCaseSensitive: false }) }],
        ['highlightStyle（⑤Render 读）', { highlightStyle: { bgColor: '#ff0', textColor: '#111' } }],
        ['siteDisabledMap（站点门禁读）', { siteDisabledMap: { 'a.test': true } }]
      ];
      for (const [what, patch] of cases) {
        runs = 0; arm = 0; consumeCalls.length = 0;
        const r = await KH.applyConfig(patch);
        eq(runs, 1, '★ ' + what + ' 变了必须整页重建（把它塞进 UI_ONLY_KEYS 就是漏更新）');
        truthy(r.consumeOnly !== true, '★ ' + what + ' 不许走仅消费');
        truthy(arm > 0, '★ ' + what + ' 必须重挂调度通道');
      }
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
    await test('★ T33/T36b 守卫：UI-only 键的配置读点只许在"归一 / 消费 / 设置页"三处（判据被写进代码，不是注释）', () => {
      const root = path.join(__dirname, '..', '..');
      /* 只认"从配置对象上取值"的写法：`kw.importantNote`（词自己的笔记正文，compiler.js）与
       * `h.meta.importantNote`（命中身上的值）是**另一个东西**，不算配置读点。 */
      /* T52：`imgOcr` 已从 UI_ONLY_KEYS 摘掉（回归 F1，见上面它的反向守卫），故不在本表；
       * 它的分类由那条动态守卫钉着，不是靠这里的静态读点清单。 */
      const re = /(?:cfg|config|normalized|state\.config)\.(?:importantNote|notePanelWidth|noteCardStyle)\b/;
      const allowed = ['src/core/config.js', 'src/features/important-note.js', 'src/features/note-card.js',
        'options/options.js'];
      const seen = [];
      const bad = [];
      for (const f of sourceFiles(root)) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (!re.test(fs.readFileSync(f, 'utf8'))) continue;
        seen.push(rel);
        if (allowed.indexOf(rel) < 0) bad.push(rel);
      }
      deepEq(bad, [], '★ UI-only 键被 Scan/Render/编译/站点门禁读到 ⇒ 漏重建＝页面不更新；'
        + '要么把它从 UI_ONLY_KEYS 摘掉，要么改回整页重建');
      truthy(seen.length >= 3, '守卫自身要有效：至少要扫到 3 处 UI-only 配置读点（实际 ' + seen.length + ' 处）');

      /* 【T36b】同一条判据盯住「连签名都不进」的键：`migrated` 的读点只许在归一与设置页显示。
       * 谁在页面侧读了它（content/ 或 src/features/），就必须把它重新归类 —— 否则那个写入
       * 永远静默无动作（`config-noop`），页面侧读到的还是旧值。 */
      const reExcl = /(?:cfg|config|normalized|state\.config)\.migrated\b/;
      const allowedExcl = ['src/core/config.js', 'options/options.js'];
      const badExcl = [];
      for (const f of sourceFiles(root)) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (reExcl.test(fs.readFileSync(f, 'utf8')) && allowedExcl.indexOf(rel) < 0) badExcl.push(rel);
      }
      deepEq(badExcl, [], '★ NOT_A_RENDER_INPUT 里的键出现了页面侧读点 ⇒ 必须改为 UI-only 或核心签名，'
        + '否则页面读到的还是旧值（写它等于什么都不做）');
    });

    /* 【T57 / T54-E3 真机事故】上面 T36b 那条用例继续只钉**分类**（noteCardStyle 页面侧读点全在
     * ⑦Consume ⇒ 只走仅消费、不整页重建），那件事没变。但"分类正确"≠"值到了卡片上"：真机读数
     * （qa 三次恒为旧值）——已打开页面改「笔记卡配色」后 `cardStillOld.varBg` 仍是旧色，
     * `page.reload()` 之后才变：
     *   {"before":{"rebuildCount":4,"consumeOnlyCount":1},"after":{"rebuildCount":4,"consumeOnlyCount":2},
     *    "cardFirstShow":{"varBg":"#ffffff"},"cardStillOld":{"varBg":"#ffffff"},"cardReShow":{"varBg":"#ffffff"}}
     * 根因不在分类，在 `note-card.js`：`bind(configRef)` 的一次性早退把**每次 consume 新传进来的
     * `() => cfg` 闭包**一起丢掉了（监听只该装一次，配置引用不该被顺带冻住），于是卡片里
     * 两处读点永远拿到 boot 那次的 cfg ⇒ 靠"改走整页重建"也救不了：`card` 是模块单例，重建同样只调
     * 一次 consume、照样早退。下面两条把"新值必须真的到达卡片"钉死（垫片里没有真 DOM 事件管线，
     * 所以用最小手段：接管 document 监听拿到真实 click 处理器 + 观测引用本身）。
     * 放在本 spec 而不是新文件：`tests/run.js` 的 specs 是**显式清单**，新文件不登记就永远不会跑。 */
    await test('★ T57 反向守卫：第二次 bind 的配置引用必须生效（卡片读到最新 cfg，不是 boot 那次）', async () => {
      const card = KH.NoteCard;
      truthy(card && typeof card.bind === 'function', '本用例必须能拿到真实的 note-card 单例（KH.NoteCard）');
      const realDocAdd = document.addEventListener;
      const realWinAdd = global.addEventListener;
      const realRAF = global.requestAnimationFrame;
      const realHit = KH.hitAtPoint, realScanner = KH.Scanner, realShow = card.show;
      const realBound = card._bound, realBox = card.box, realRef = card._configRef;
      const handlers = {};
      const cfgBoot = { noteCardStyle: { bgColor: '#aaaaaa' } };
      const cfgNew = { noteCardStyle: { bgColor: '#123456' } };
      let shownCfg = '没走到 show（用例自身失效）';
      try {
        /* 垫片里没有 window.addEventListener / requestAnimationFrame（`window` 就是 global），
         * 这里补最小桩让 bind 能把监听真的装上 —— 不测 DOM，只测引用。 */
        global.addEventListener = () => { };
        global.requestAnimationFrame = () => 0;
        document.addEventListener = (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); };
        KH.Scanner = { isOwnUI: () => false };
        KH.hitAtPoint = () => ({ meta: { note: '备注正文', display: '命中词' } });
        card.show = (hit, x, y, cfg) => { shownCfg = cfg; };   // 只观测"引用取到的值"，不碰 DOM
        card._bound = false; card.box = null;

        card.bind(() => cfgBoot);        // 第一次：boot / 首次 consume 传给 bind 的引用
        card.bind(() => cfgNew);         // 第二次：已打开页面上的一次真配置变更
        const click = (handlers.click || [])[0];
        truthy(typeof click === 'function', 'bind 必须真的挂上 click 监听（否则本用例测不到东西）');
        click({ target: {}, clientX: 10, clientY: 10 });

        eq(shownCfg, cfgNew, '★ 卡片必须用**第二次** bind 的引用来取配置 —— 拿到 boot 那次就是真机事故：'
          + '已打开页面改配色不变色、刷新才变（`note-card.js:332-334` 把配置引用一起冻住了）');
        eq(card._configRef && card._configRef(), cfgNew, '★ `_configRef` 必须保存最新引用（`_bound` 只挡重复装监听，不挡配置刷新）');
      } finally {
        card.show = realShow; card._bound = realBound; card.box = realBox; card._configRef = realRef;
        KH.hitAtPoint = realHit; KH.Scanner = realScanner;
        document.addEventListener = realDocAdd;
        if (realWinAdd === undefined) delete global.addEventListener; else global.addEventListener = realWinAdd;
        if (realRAF === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = realRAF;
      }
    });

    await test('★ T57：卡片正显示时 consume 必须当场落新配色（不能等关掉再点开）', async () => {
      const card = KH.NoteCard;
      const entry = real.features.entries().find(([label]) => label === 'note-card');
      truthy(entry && entry[1] && typeof entry[1].consume === 'function', '真实 feature 注册表里必须有 note-card');
      const saved = featureRestore.find(([feat]) => feat === entry[1]);
      const consume = saved ? saved[1] : entry[1].consume;   // 本 spec 把真实 consume 换成了记录器，这里取回原实现
      const realHost = card.host, realBox = card.box, realLastCfg = card._lastCfg, realBound = card._bound;
      const writes = {};
      try {
        card._bound = true;                     // 隔离：只测 consume 的"当场落样式"，不让 bind 重装监听
        card.box = { hidden: false };           // visible === true（卡片正开着）
        card.host = { style: { setProperty: (k, v) => { writes[k] = v; } } };
        card._lastCfg = { noteCardStyle: { bgColor: '#aaaaaa' } };
        consume([], { noteCardStyle: { bgColor: '#123456' } }, {});
        eq(writes['--kh-nc-bg'], '#123456', '★ 卡片开着时改配色必须当场写进 host 样式（真机事故：只能刷新才变）');
      } finally {
        card.host = realHost; card.box = realBox; card._lastCfg = realLastCfg; card._bound = realBound;
      }
    });
  } finally {
    for (const [feat, fn] of featureRestore) feat.consume = fn;
    for (const k of STUBS) KH[k] = real[k];
    KH.state.booted = realBooted;
    KH.state.config = realConfig;
    KH.state.configSig = realSig;
    KH.state.configSigCore = realSigCore;
    KH.state.siteEnabled = realSiteEnabled;
  }
};
