/* tests/specs/rare-combo.test.js — 罕见字作为「单元格组合」的核心词
 * ----------------------------------------------------------------------------
 * 规格来源：`src/ui/changelog.js` 早已写明
 *   「罕见字规则与普通关键词完全一致：…也可作为「单元格组合」的右格核心
 *     （左格标题词右侧出现罕见字才命中）。」
 *
 * 旧缺陷（用户实测："罕见字使用组合似乎不生效，依旧作为普通词到处命中"）：
 *   · `rare` Adapter（order 10）对 `kind:'rare' / rareChar` **无条件接管**；
 *   · `combo-lr` / `combo-tb`（order 20/30）又**显式排除** `kind:'rare' / rareChar`。
 *   两边互相排除 → 带组合的罕见字落到 rare Adapter → 编译成"整页逐字扫罕见字"，
 *   组合语义（只在标题格右侧那些格子里判定）**整条失效**。
 *
 * 这里锁的是**适配器落点**（纯逻辑、毫秒级）；行为层（只命中组合上下文里的罕见字）
 * 由 `_e2e` 的夹具 `rare-combo.html` 覆盖。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;

  /** dispatch 只需要一个"够用"的配置：视觉解析会读 groups / highlightStyle */
  const CFG = {
    keywords: [], groups: [],
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    matchSettings: {}
  };

  suite('rare-combo · 罕见字 + 单元格组合');

  await test('罕见字（无组合）仍由 rare Adapter 接管 —— 原有能力不得回退', () => {
    const r = C.dispatch({ id: 'a', text: 'hjz#', kind: 'rare', enabled: true }, CFG);
    truthy(r, '应编译出规则');
    eq(r.kind, 'rare');
    eq(r.probe, 'rare-char');
  });

  await test('★ 罕见字 + 左右格组合 → 必须由 combo-lr 接管（旧实现落到 rare，整页命中）', () => {
    const r = C.dispatch({
      id: 'b', text: 'hjz#', kind: 'rare', enabled: true,
      cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr'
    }, CFG);
    truthy(r, '应编译出规则');
    eq(r.kind, 'combo-lr', 'kind 必须是 combo-lr');
    eq(r.probe, 'combo-lr', '必须声明由 combo-lr Probe 定位（否则整页扫）');
    eq(r.meta.coreIsRare, true, '必须标记核心是"任意罕见字"');
    eq(r.pattern, null, '罕见字核心没有字面 pattern');
    eq(r.meta.display, '罕见字', '展示名不该出现 hjz# 这种内部标记');
  });

  await test('★ 罕见字 + 上下格组合 → combo-tb，且不得退化成「仅抓取」', () => {
    const r = C.dispatch({
      id: 'c', text: 'hjz#', kind: 'rare', enabled: true,
      cellVerifyEnabled: true, cellVerify: '是否刚需', comboAxis: 'tb'
    }, CFG);
    truthy(r, '应编译出规则');
    eq(r.kind, 'combo-tb');
    eq(r.probe, 'combo-tb');
    eq(r.meta.coreIsRare, true);
    eq(r.meta.fetchOnly, false, '罕见字核心不算"空核心"，不得退化成仅抓取');
    eq(r.visual, true, '组合命中要渲染');
  });

  await test('`rareChar` 字段形态（老数据）同样走组合', () => {
    const r = C.dispatch({
      id: 'd', text: 'hjz#', rareChar: true, enabled: true,
      cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr'
    }, CFG);
    eq(r.kind, 'combo-lr');
    eq(r.meta.coreIsRare, true);
  });

  await test('普通词 + 组合不受影响（回归）', () => {
    const r = C.dispatch({
      id: 'e', text: '资质A1', enabled: true,
      cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr'
    }, CFG);
    eq(r.kind, 'combo-lr');
    eq(r.meta.coreIsRare, false);
    truthy(r.pattern, '普通核心仍要有 pattern');
  });

  await test('普通词 / 仅抓取也不受影响（回归）', () => {
    const n = C.dispatch({ id: 'f', text: '审核不通过', enabled: true }, CFG);
    eq(n.kind, 'normal');
    const fo = C.dispatch({
      id: 'g', text: '', enabled: true, cellVerifyEnabled: true,
      cellVerify: '应用名称', comboAxis: 'lr', fetchLabels: '包名'
    }, CFG);
    eq(fo.kind, 'fetch-only', '空核心 + 抓取字段 = 仅抓取');
    eq(fo.meta.coreIsRare, false);
  });

  await test('罕见字判定与整页规则同一份实现（口径一致，不另写一份）', () => {
    truthy(KH.RareChar && typeof KH.RareChar.scanRare === 'function', 'KH.RareChar 必须可用');
    eq(KH.RareChar.isRareChar('昉'), true, '昉 应判为罕见字');
    eq(KH.RareChar.isRareChar('审'), false, '审 是常用字');
    const got = KH.RareChar.scanRare('昉与谞喆').map((h) => h.char);
    eq(got.join(','), '昉,谞,喆', '逐字判定应跳过常用字');
  });
};
