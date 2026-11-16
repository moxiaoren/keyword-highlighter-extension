/* tests/specs/auto-compare.test.js — 【2.0.13 批 A】自动行参与比对 / 判等收敛 / ⚙ 待配置 / 开关严格
 * ----------------------------------------------------------------------------
 * 用户 2026-11-15 拍板（原话要点）：
 *   · 「2 选严格」  ⇒ `imgCompare.on === false` 时一律不上色，且上一轮画过的要撤回；
 *   · 「1 先宽松，后面再观察使用情况收紧」 ⇒ 自动行名对上配置的**任一侧**就比；
 *   · 「3 一起做」  ⇒ 「⚙ 待配置」独立成第四态，与「？ 未查明」分开。
 * 这里锁的是**面板真渲染**（真表格 + 真 paintAuto），不是只看源码字符串。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const NC = Object.assign({}, KH.Compare, KH.Compare.Sources, { verdictMark: KH.Compare.markOf });
  const N = KH.ImportantNote;
  const shadowPanel = () => Object.create(N.panel);

  /** 造一张真的抓取表（走产品自己的渲染函数，标题/值结构完全一致） */
  const card = (rows) => {
    const d = H.el('div', {}, []);
    d.innerHTML = KH.Fetch.rowsToTableHtml(rows.map((r) => ({ label: r[0], rows: [[{ t: r[1] }]], opt: null })));
    return d;
  };
  const trOf = (div, i) => div.querySelectorAll('tr')[i];
  const cellOf = (div, i) => trOf(div, i).querySelectorAll('td')[0];
  const valOf = (div, i) => trOf(div, i).querySelectorAll('td')[1];
  const markOf = (div, i) => { const c = cellOf(div, i); return c.querySelector ? c.querySelector('.kh-verdict') : null; };
  /* 【2026-11-16】比对只认关键词里标的 `#比=对象`（item.pairs）；全局表与开关都已退场。 */
  const itemOf = (spec) => ({ pairs: KH.Compare.Rules.pairsOfLabels(spec) });

  suite('自动行比对 · 批 A（别名 / ⚙待配置 / 配置对上色 / 严格开关）');

  await test('④ 备案核准主体：APP备案主办单位 认成 entity（修静默失效）', () => {
    eq(NC.fieldKey('APP备案主办单位'), 'entity');
    eq(NC.fieldKey('APP备案主办单位名称'), 'entity');
    const div = card([['APP备案主办单位', '某某网络科技有限公司']]);
    const t = div.querySelectorAll('table')[0];
    eq(NC.readFields(t).entity, '某某网络科技有限公司', 'readFields 也要读到（否则 paintEntity 永远静默）');
  });

  await test('⚙ 待配置 是第四态，与 ？ 未查明 分开', () => {
    eq(NC.verdictMark('unset').label, '⚙ 待配置');
    eq(NC.verdictMark('unknown').label, '？ 未查明');
    eq(NC.verdictMark('unset').icon, '⚙');
  });

  await test('★ 内置兜底已退场：企业名称行不再自动与「开发者」比（没配比对对 ⇒ 不上色、无标记）', () => {
    const div = card([['企业名称', '北京知行灵动科技有限公司'], ['开发者', '上海乙信息技术有限公司']]);
    shadowPanel().decorateChecks(div, {});
    eq(markOf(div, 0), null, '没配比对对就不判');
    falsy(cellOf(div, 0).style.background, '也不上色');
  });

  await test('配了比对对后，缺另一侧 ⇒ ？ 未查明（配了，只是没取到）', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">企业名称</td><td>北京知行灵动科技有限公司</td></tr>' +
      '<tr><td class="kh-table-label">开发者</td><td></td></tr></tbody></table>';
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('企业名称#比=开发者'));
    const m = markOf(div, 0);
    eq(m.getAttribute('data-state'), 'unknown');
    truthy(String(m.textContent).indexOf('未查明') >= 0);
  });

  await test('★ 用户配的比对关系参与自动行上色：一致 ⇒ 绿 + 不再画逐字段证据行', () => {
    /* 两边值只差括号补充：raw 不同 ⇒ 不会被同值合并成一行，判等仍按同一家（core 开关）。 */
    const div = card([['开发者', '北京甲科技（集团）有限公司'], ['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('开发者#比=著作权人'));
    const m = markOf(div, 1);
    truthy(m, '著作权人这一行要出标记（以前是假灰）');
    eq(m.getAttribute('data-state'), 'same');
    eq(String(m.textContent), '✔ 一致');
    truthy(cellOf(div, 1).style.background, '一致要铺底色');
    eq(valOf(div, 1).querySelector('.kh-evidence'), null, '【2.0.11】证据行已删：结论只在徽标与悬停里');
  });

  await test('配置对不一致 ⇒ ⚠ 待确认，悬停给两边原值', () => {
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司']]);
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('开发者#比=著作权人'));
    const m = markOf(div, 1);
    eq(m.getAttribute('data-state'), 'diff');
    eq(String(m.textContent), '⚠ 待确认');
    const tip = String(cellOf(div, 1).getAttribute('title') || '');
    truthy(tip.indexOf('上海乙科技有限公司') >= 0 && tip.indexOf('北京甲科技有限公司') >= 0, tip);
  });

  await test('★ 对子的另一侧整行不在表里 ⇒ 这一行不判（不制造「无法核实」噪声）', () => {
    const div = card([['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('开发者#比=著作权人'));
    eq(markOf(div, 0), null, '★ 另一侧连行都没有 ⇒ 不挂标记');
    falsy(cellOf(div, 0).style.background, '也不上色');
  });

  await test('★ 把对子删掉再重画：上一轮的标记/底色必须撤回（不再留旧结论）', () => {
    const div = card([['开发者', '北京甲科技（集团）有限公司'], ['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('开发者#比=著作权人'));
    truthy(markOf(div, 1), '前提：先画上一轮');
    p.decorateChecks(div, { pairs: [] });
    eq(markOf(div, 1), null, '删掉对子后标记必须撤掉');
    eq(cellOf(div, 1).style.background, '', '底色要还原');
    eq(valOf(div, 1).querySelector('.kh-evidence'), null, '本来就不画证据行（2.0.11 起）');
  });

  await test('★ 判等收敛仍走同一套归一：括号补充 / 只差一字都算同一家', () => {
    const r = KH.Compare.Rules.pairVerdict('北京甲科技（集团）有限公司', '北京甲科技有限公司');
    eq(r.state, 'same', '去括号补充后同名 ⇒ 同一家');
    const near = KH.Compare.Rules.pairVerdict('北京知行灵动科技有限公司', '北京知行灵动科技有限公局');
    eq(near.state, 'same', '只差一字 ⇒ 近似同一家');
    const bad = KH.Compare.Rules.pairVerdict('上海完全不同科技有限公司', '北京知行灵动科技有限公司');
    eq(bad.state, 'diff', '完全不同 ⇒ 判不一致');
  });

  /* ---------- 2026-11-16 用户拍板：内置三条自动比对退场 ---------- */

  await test('★ 没配对 ⇒ 自动行一律不判（企业名称 / 著作权人 都不再兜底与开发者比）', () => {
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司'], ['企业名称', '广州丙科技有限公司']]);
    const p = shadowPanel();
    p.decorateChecks(div, { pairs: [] });
    eq(markOf(div, 1), null, '著作权人不再自动和开发者比');
    eq(markOf(div, 2), null, '企业名称不再自动和开发者比');
    falsy(cellOf(div, 1).style.background, '不上色');
  });

  await test('配置对按配置判：著作权人 ↔ 主办单位（不是与开发者比）', () => {
    /* 开发者是甲、著作权人是乙、主办单位也是乙：若兜底还在，著作权人会判 diff；
     * 配了 著作权人↔主办单位 之后按配置判 same。 */
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司'], ['主办单位', '上海乙科技有限公司（总部）']]);
    const p = shadowPanel();
    p.decorateChecks(div, itemOf('著作权人#比=主办单位'));
    const m = markOf(div, 1);
    eq(m.getAttribute('data-state'), 'same', '按配置对判同一家，而不是按开发者判 diff');
    eq(valOf(div, 1).querySelector('.kh-evidence'), null, '不再画证据行');
  });
};