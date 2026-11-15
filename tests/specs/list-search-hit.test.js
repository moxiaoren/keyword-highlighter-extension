/* tests/specs/list-search-hit.test.js — 列表弹窗「批 3」搜索命中高亮与计数（2026-11-15，2.0.13）
 * ----------------------------------------------------------------------------
 * 用户原话（m04948）：「优化一下添加关键词界面里的那几个输入窗点击之后弹出的管理列表弹窗……
 * 但不要功能缩水。」批 3 只动**筛选的呈现**，过滤口径（`rowText` 拼法）与存储一个字节都不动：
 *   ① 计数行在筛选时多报「筛中 K 条」，不再只有一个总数；
 *   ② 命中的行整行打 `is-hit`（左侧强调条）；
 *   ③ 命中落在名字以外（`@指向` / `取值后缀` / `进表`）时，行尾补一行「筛中：…」并用 <mark> 标出命中的字
 *      —— 名称在输入框里没法逐字标亮，不标出来用户会以为筛选坏了；名字命中就不重复一行；
 *   ④ 一条都没筛中时给「没有筛中「x」的条目」+ 一键清空，别让用户对着空列表猜。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const FM = KH.FieldMap;

  const mkTok = (val) => KH.ui.Fields.create(FM.byKey('fetchLabels'), val || '', {});
  const lastModalEl = () => {
    const all = document.body.querySelectorAll('.kh-modal');
    return all[all.length - 1];
  };
  const openTok = (val) => {
    const ctrl = mkTok(val);
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    const modal = lastModalEl();
    return { ctrl: ctrl, modal: modal, box: modal.querySelector('.kh-list-box') };
  };
  const rowsOf = (box) => box.querySelectorAll('.kh-lrow');
  const type = (box, q) => {
    const f = box.querySelector('.kh-list-filter');
    f.value = q;
    f.dispatchEvent({ type: 'input' });
    return f;
  };
  const countOf = (box) => String(box.querySelector('.kh-list-count').textContent);
  const whyOf = (row) => row.querySelector('.kh-list-why');

  suite('列表弹窗 · 批3 搜索命中高亮与计数（2.0.13）');

  await test('★ 不筛选时计数仍是「共 N 条，已选 M 条」（老口径不许被新文案挤掉）', () => {
    const o = openTok('开发者#图|设计师');
    eq(countOf(o.box), '共 2 条，已选 0 条', '没有筛选词时不多报「筛中」');
    KH.ui.Modal.closeAll();
  });

  await test('★ 筛选时计数报「筛中 K 条」，且数字跟着筛选词变', () => {
    const o = openTok('开发者#图|设计师');
    type(o.box, '开发');
    const c1 = countOf(o.box);
    truthy(c1.indexOf('共 2 条') >= 0, '总数不许被筛选改掉：' + c1);
    truthy(c1.indexOf('筛中 1 条') >= 0, '要报筛中几条，实际 ' + c1);
    type(o.box, '');
    falsy(countOf(o.box).indexOf('筛中') >= 0, '清空筛选后不该残留「筛中」');
    KH.ui.Modal.closeAll();
  });

  await test('★ 命中的行整行打 is-hit，没命中的行被隐藏', () => {
    const o = openTok('开发者#图|设计师');
    type(o.box, '设计');
    const rows = rowsOf(o.box);
    eq(rows.length, 2, '两条行都还在 DOM 里（只是隐藏）');
    const hit = rows.filter((r) => r.classList.contains('is-hit'));
    eq(hit.length, 1, '只有命中的那条打 is-hit');
    /* 垫片的 querySelector 不认「行 › main › input」这种三层嵌套，改从行本身取证：
     * 命中在名字里 ⇒ 不显示说明行（说明命中的是「设计师」那条的 name 分支） */
    eq(hit[0].querySelector('.kh-list-why').hidden, true, '名字命中：不该补说明行');
    const other = rows.filter((r) => r !== hit[0]);
    eq(other.length, 1, '另一条还在（只是隐藏）');
    eq(other[0].hidden, true, '没命中的行要隐藏');
    KH.ui.Modal.closeAll();
  });

  await test('★ 命中在名字以外（取值后缀）时，行尾补「筛中：…」并用 mark 标出命中的字', () => {
    const o = openTok('开发者#图|设计师');
    type(o.box, '图');
    const rows = rowsOf(o.box);
    const row = rows.filter((r) => !r.hidden)[0];
    truthy(row, '值「#图」要能被筛出来（过滤口径没变）');
    const why = whyOf(row);
    truthy(why, '行里要有命中说明行');
    eq(why.hidden, false, '命中在名字以外时必须显示说明行');
    const txt = String(why.textContent);
    truthy(txt.indexOf('筛中：') === 0, '要以「筛中：」开头，实际 ' + txt);
    const mark = why.querySelector('.kh-list-hit');
    truthy(mark, '命中的字要用 mark 标出来');
    eq(String(mark.textContent), '图', 'mark 里正好是命中的那段');
    KH.ui.Modal.closeAll();
  });

  await test('★ 名字本身就命中时不重复一行（否则每打一个字列表就变长）', () => {
    const o = openTok('开发者#图|设计师');
    type(o.box, '开发');
    const row = rowsOf(o.box).filter((r) => !r.hidden)[0];
    truthy(row, '「开发者」要被筛出来');
    eq(row.classList.contains('is-hit'), true, '命中态照旧打上');
    const why = whyOf(row);
    eq(why.hidden, true, '名字里就看得见命中，不再补一行');
    KH.ui.Modal.closeAll();
  });

  await test('★ 一条都没筛中：说清筛的是什么，并给一键清空（点完行全回来）', () => {
    const o = openTok('开发者#图|设计师');
    type(o.box, 'zzz');
    const noRes = o.box.querySelector('.kh-list-nores');
    truthy(noRes, '要有零结果条');
    eq(noRes.hidden, false, '零命中时要显示');
    truthy(String(noRes.textContent).indexOf('zzz') >= 0, '要说清筛的是哪个词，实际 ' + String(noRes.textContent));
    truthy(String(countOf(o.box)).indexOf('筛中 0 条') >= 0, '计数要老实报 0：' + countOf(o.box));
    noRes.querySelector('.kh-list-nores-btn').dispatchEvent({ type: 'click' });
    eq(String(o.box.querySelector('.kh-list-filter').value), '', '一键清空要真的清掉筛选词');
    eq(noRes.hidden, true, '清空后零结果条要收起');
    eq(rowsOf(o.box).filter((r) => r.hidden).length, 0, '清空后所有行都回来');
    KH.ui.Modal.closeAll();
  });

  await test('★ 图片词弹窗同一套：按 @指向 筛也能标出来（五弹窗共用一份实现）', () => {
    /* 图片词弹窗的 `row.name` 在部分字段上**保留原样**（含 `@字段`），所以 `@` 本身会算进名字；
     * 要验「命中在名字以外」，用只有 `rowText` 才有的 `#表`：名字里绝不会出现它。 */
    const ctrl = KH.ui.Fields.create(FM.byKey('imgOcrKeyword'), '甲@字段A#表|乙@字段B', {});
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    const box = lastModalEl().querySelector('.kh-list-box');
    type(box, '#表');
    const row = rowsOf(box).filter((r) => !r.hidden)[0];
    truthy(row, '要能按 @指向 筛出来');
    const why = whyOf(row);
    eq(why.hidden, false, '命中在 @指向 上，要补说明行');
    truthy(why.querySelector('.kh-list-hit'), '命中的「#表」要标出来');
    KH.ui.Modal.closeAll();
  });
};
