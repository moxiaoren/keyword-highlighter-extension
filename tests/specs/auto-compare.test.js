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
  const cmpCfg = (rows, on) => ({ imgCompare: { on: on !== false, rows: rows } });

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

  await test('★ 企业名称行没有「开发者」这一行 ⇒ ⚙ 待配置（不再伪装成未查明）', () => {
    const div = card([['企业名称', '北京知行灵动科技有限公司']]);
    shadowPanel().decorateChecks(div, {});
    const m = markOf(div, 0);
    truthy(m, '必须有标记');
    eq(m.getAttribute('data-state'), 'unset');
    eq(String(m.textContent), '⚙ 待配置');
    falsy(cellOf(div, 0).style.background, '待配置同样不改底色');
    truthy(String(cellOf(div, 0).getAttribute('title') || '').indexOf('待配置') >= 0, '悬停要说「待配置」而不是「未查明」');
  });

  await test('企业名称行有「开发者」但值是空的 ⇒ 仍是 ？ 未查明（配了，只是没取到）', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">企业名称</td><td>北京知行灵动科技有限公司</td></tr>' +
      '<tr><td class="kh-table-label">开发者</td><td></td></tr></tbody></table>';
    shadowPanel().decorateChecks(div, {});
    const m = markOf(div, 0);
    eq(m.getAttribute('data-state'), 'unknown');
    truthy(String(m.textContent).indexOf('未查明') >= 0);
  });

  await test('★ 用户配的比对关系参与自动行上色：一致 ⇒ 绿 + 证据说清来源', () => {
    /* 两边值只差括号补充：raw 不同 ⇒ 不会被同值合并成一行，判等仍按同一家（core 开关）。 */
    const div = card([['开发者', '北京甲科技（集团）有限公司'], ['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.cfg = cmpCfg([{ left: '开发者', right: '著作权人' }]);
    p.decorateChecks(div, {});
    const m = markOf(div, 1);
    truthy(m, '著作权人这一行要出标记（以前是假灰）');
    eq(m.getAttribute('data-state'), 'same');
    eq(String(m.textContent), '✔ 一致');
    truthy(cellOf(div, 1).style.background, '一致要铺底色');
    const ev = valOf(div, 1).querySelector('.kh-evidence');
    truthy(ev && String(ev.textContent).indexOf('按你配的比对关系') >= 0, '证据要写清是配置对得出的结论');
  });

  await test('配置对不一致 ⇒ ⚠ 待确认，悬停给两边原值', () => {
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司']]);
    const p = shadowPanel();
    p.cfg = cmpCfg([{ left: '开发者', right: '著作权人' }]);
    p.decorateChecks(div, {});
    const m = markOf(div, 1);
    eq(m.getAttribute('data-state'), 'diff');
    eq(String(m.textContent), '⚠ 待确认');
    const tip = String(cellOf(div, 1).getAttribute('title') || '');
    truthy(tip.indexOf('上海乙科技有限公司') >= 0 && tip.indexOf('北京甲科技有限公司') >= 0, tip);
  });

  await test('配置对的另一侧整行都不存在 ⇒ 无法核实（不改底色）', () => {
    const div = card([['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.cfg = cmpCfg([{ left: '开发者', right: '著作权人' }]);
    p.decorateChecks(div, {});
    const m = markOf(div, 0);
    eq(m.getAttribute('data-state'), 'unknown');
    truthy(String(cellOf(div, 0).getAttribute('title') || '').indexOf('无法核实') >= 0);
  });

  await test('★ 严格开关：on=false 时不上色，并撤回上一轮画过的标记/底色/证据', () => {
    const div = card([['开发者', '北京甲科技（集团）有限公司'], ['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.cfg = cmpCfg([{ left: '开发者', right: '著作权人' }], true);
    p.decorateChecks(div, {});
    truthy(markOf(div, 1), '前提：先画上一轮');
    p.cfg = cmpCfg([{ left: '开发者', right: '著作权人' }], false);
    p.decorateChecks(div, {});
    eq(markOf(div, 1), null, '关掉开关后标记必须撤掉');
    eq(cellOf(div, 1).style.background, '', '底色要还原');
    const ev = valOf(div, 1).querySelector('.kh-evidence');
    eq(ev, null, '证据行也要撤掉');
  });

  await test('判等收敛：括号补充不算不一致（同一家）', () => {
    const cmp = { hasDoc: true, docAmbiguous: false, rightNames: ['著作权人'],
      rows: [{ left: '开发者', right: '著作权人', rv: ['北京甲乙科技有限公司'], lvOcr: [''] }] };
    const probs = KH.Compare.Rules.compareProblems(cmp, () => '北京甲乙科技（集团）有限公司');
    eq(probs.length, 0, '去括号补充后同名 ⇒ 不再报不一致');
  });

  await test('判等收敛：长名只差一字不算不一致；完全不同的仍然报', () => {
    const mk = (lv, rv) => ({ hasDoc: true, docAmbiguous: false, rightNames: ['著作权人'],
      rows: [{ left: '开发者', right: '著作权人', rv: [rv], lvOcr: [''] }] });
    eq(KH.Compare.Rules.compareProblems(mk('北京知行灵动科技有限公司', '北京知行灵动科技有限公局'), () => '北京知行灵动科技有限公司').length, 0, '只差一字 ⇒ 近似同一家');
    const bad = KH.Compare.Rules.compareProblems(mk('上海完全不同科技有限公司', '北京知行灵动科技有限公司'), () => '上海完全不同科技有限公司');
    eq(bad.length, 1);
    eq(bad[0].kind, 'mismatch');
  });

  await test('★ 左列挂着上一轮判定标记时，结论行照样取到值（浮窗复用旧卡的误报回归）', () => {
    const div = card([['开发者', '北京甲科技有限公司']]);
    /* 真实面板里 setVerdictMark 会把「✔ 一致」append 进左列；下一轮 decorateMerge 读字段名时
     * 旧写法 keyOf(textContent) 会变成「开发者✔ 一致」⇒ 取不到值 ⇒ 误报「缺左侧」。 */
    const labelCell = cellOf(div, 0);
    const mk = H.el('span', { class: 'kh-verdict', 'data-state': 'same', title: '✔ 一致' }, ['✔ 一致']);
    labelCell.appendChild(mk);
    const cmp = { hasDoc: true, docAmbiguous: false, rightNames: ['著作权人'],
      rows: [{ left: '开发者', right: '著作权人', rv: ['北京甲科技有限公司'], lvOcr: [''] }] };
    const p = shadowPanel();
    p.decorateMerge(div, { compare: cmp });
    const line = div.querySelector('.kh-compare-line');
    eq(line, null, '两边同值 ⇒ 不该出结论行；出线就说明左列字段名被标记污染、取数失败');
  });

  /* ---------- T4：主体行没配比对对，也自动和「开发者」比 ---------- */

  await test('★ 著作权人没配比对对，也自动和「开发者」比：一致 ⇒ 绿（悬停写明比的是谁）', () => {
    const div = card([['开发者', '北京甲科技（集团）有限公司'], ['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.cfg = { imgCompare: { on: true, rows: [] } };
    p.decorateChecks(div, {});
    const m = markOf(div, 1);
    truthy(m, '著作权人行要出标记');
    eq(m.getAttribute('data-state'), 'same');
    eq(String(m.textContent), '✔ 一致');
    const tip = String(cellOf(div, 1).getAttribute('title') || '');
    truthy(tip.indexOf('比对「著作权人」↔「开发者」') >= 0, tip);
    const ev = valOf(div, 1).querySelector('.kh-evidence');
    truthy(ev && String(ev.textContent).indexOf('与开发者比对') >= 0, '证据要写清是与开发者比对');
  });

  await test('著作权人与「开发者」不一致 ⇒ ⚠ 待确认，悬停给两边原值', () => {
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司']]);
    const p = shadowPanel();
    p.cfg = { imgCompare: { on: true, rows: [] } };
    p.decorateChecks(div, {});
    const m = markOf(div, 1);
    eq(m.getAttribute('data-state'), 'diff');
    const tip = String(cellOf(div, 1).getAttribute('title') || '');
    truthy(tip.indexOf('上海乙科技有限公司') >= 0 && tip.indexOf('北京甲科技有限公司') >= 0, tip);
  });

  await test('著作权人整卡没有「开发者」行 ⇒ ⚙ 待配置（缺的是配置，不是结果）', () => {
    const div = card([['著作权人', '北京甲科技有限公司']]);
    const p = shadowPanel();
    p.cfg = { imgCompare: { on: true, rows: [] } };
    p.decorateChecks(div, {});
    const m = markOf(div, 0);
    eq(m.getAttribute('data-state'), 'unset');
    falsy(cellOf(div, 0).style.background);
  });

  await test('用户配了别的对侧 ⇒ 配置对优先于「与开发者」兜底', () => {
    /* 开发者是甲、著作权人是乙、主办单位也是乙：若兜底生效，著作权人会判 diff；
     * 配了 著作权人↔主办单位 之后应按配置判 same。 */
    const div = card([['开发者', '北京甲科技有限公司'], ['著作权人', '上海乙科技有限公司'], ['主办单位', '上海乙科技有限公司（总部）']]);
    const p = shadowPanel();
    p.cfg = { imgCompare: { on: true, rows: [{ left: '著作权人', right: '主办单位' }] } };
    p.decorateChecks(div, {});
    const m = markOf(div, 1);
    eq(m.getAttribute('data-state'), 'same', '按配置对判同一家，而不是按开发者判 diff');
    const ev = valOf(div, 1).querySelector('.kh-evidence');
    truthy(ev && String(ev.textContent).indexOf('按你配的比对关系') >= 0);
  });
};