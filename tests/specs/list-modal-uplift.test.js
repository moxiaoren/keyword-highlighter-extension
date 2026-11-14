/* tests/specs/list-modal-uplift.test.js — 列表弹窗「批 1」纯呈现改造（2026-11-14，2.0.11）
 * ----------------------------------------------------------------------------
 * 用户原话：「优化一下添加关键词界面里的那几个输入窗点击之后弹出的管理列表弹窗。现在修改调整起来
 * 有些麻烦。帮忙设计一套交互体验好一点，管理便捷的 ui……但不要功能缩水。」
 *
 * 批 1 只改呈现，**存储串一个字都不动**（解析顺序 / 回写口径 / `|` 连接都没碰）：
 *   ① 头两行（快加框 + 筛选）整块吸顶，且快加框排在筛选前面（主路径是录词）；
 *   ② 三类行型各有类型名与 data-rowtype（词条 / 抓取字段 / 图片词）；
 *   ③ 从快加框加一条**不把焦点抢进新行**（连续录入不回跳）；行内回车仍进新行；
 *   ④ 批量条分区：批量改在左，删除在右（危险操作隔离）；
 *   ⑤ 勾选被筛选隐藏时出现在警告条里，删除按钮带条数；
 *   ⑥ 后缀图例一项一行（查记号不用在 151 字长句里找）。
 *
 * 真机观感由 e2e 覆盖；这里锁结构、文案与「不回抢焦点」这类毫秒级行为。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const FM = KH.FieldMap;

  const mkTok = (val) => KH.ui.Fields.create(FM.byKey('fetchLabels'), val || '', {});
  const lastModalEl = () => {
    const all = document.body.querySelectorAll('.kh-modal');
    return all[all.length - 1];
  };
  const openList = (ctrl) => {
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    return lastModalEl();
  };
  const boxOf = (modal) => modal.querySelector('.kh-list-box');

  suite('列表弹窗 · 批1 纯呈现改造（2.0.11）');

  await test('★ 吸顶头：快加框排在筛选之前，且两行同一个 .kh-list-head 容器', () => {
    const modal = openList(mkTok('开发者'));
    const box = boxOf(modal);
    const head = box.querySelector('.kh-list-head');
    truthy(head, '要有一个整块吸顶的头容器');
    const kids = head.children.map((el) => el.className || '');
    eq(kids.length, 2, '头容器里正好两行');
    truthy(/kh-list-addbar/.test(kids[0]), '第一行是快加框（主路径是录词）');
    truthy(/kh-list-toolbar/.test(kids[1]), '第二行才是筛选/全选/计数');
    truthy(box.querySelector('.kh-list-add') !== null, '快加输入框还在头里');
    KH.ui.Modal.closeAll();
  });

  await test('★ 行型：抓取字段弹窗标 tok，并给出类型名与一行「怎么录」', () => {
    const modal = openList(mkTok('开发者'));
    const box = boxOf(modal);
    eq(String(box.getAttribute('data-rowtype')), 'tok', '抓取字段是 tok');
    const type = box.querySelector('.kh-list-type');
    truthy(type, '要有类型名徽标');
    eq(String(type.textContent), '抓取字段', '类型名要说人话');
    const hint = box.querySelector('.kh-list-kicker-t');
    truthy(hint && String(hint.textContent).indexOf('回车') >= 0, '副标题要说清怎么接着录');
    const src = read('src/ui/components/fields.js');
    truthy(/isKv \? 'kv' : 'plain'/.test(src), '三种行型都要有 data-rowtype');
    truthy(/\.kh-list-box\[data-rowtype="tok"\] \.kh-lrow/.test(read('src/ui/components/components.css')),
      '行型要落到样式上（左侧色条），否则只是加了个属性');
    KH.ui.Modal.closeAll();
  });

  await test('★ 从快加框加一条：清空输入框、**不抢焦点**（连续录入不回跳）；行内回车仍进新行', () => {
    const modal = openList(mkTok('开发者'));
    const add = modal.querySelector('.kh-list-add');
    add.value = '被授权公司';
    add.dispatchEvent({ type: 'keydown', key: 'Enter' });
    eq(String(add.value), '', '加完要清空输入框，接着录下一条');
    const src = read('src/ui/components/fields.js');
    truthy(/keepFocus: true/.test(src), '快加路径要显式 keepFocus');
    truthy(/const keepFocus = !!\(opts && opts\.keepFocus\);/.test(src), '行内回车这条路径不能被一起关掉');
    truthy(/const focusInp = keepFocus \? null :/.test(src), 'keepFocus 时必须真的不调用 focus()');
    /* 垫片没有 activeElement，所以这里锁的是**实现口径**：keepFocus ⇒ focusInp 为 null；
     * 真机焦点行为由 e2e 的连续录入用例覆盖。 */
    KH.ui.Modal.closeAll();
  });

  await test('★ 批量条：删除在危险区（右侧带分隔），并带条数', () => {
    const modal = openList(mkTok('开发者|被授权公司'));
    const opsBar = modal.querySelector('.kh-list-ops');
    truthy(opsBar, '批量条要在');
    const kvModal = openList(KH.ui.Fields.create(FM.byKey('imgOcrKeyword'), '一对一', {}));
    const kvOps = kvModal.querySelector('.kh-list-ops');
    truthy(kvOps.querySelector('.kh-list-ops-grp'), '图片词弹窗的「批量改」要单独一组');
    eq(kvOps.querySelector('.kh-list-ops-grp').getAttribute('data-grp'), 'bulk', '这组是批量改');
    /* 垫片只认简单类名，复合选择器（`.a.b`）查不到 ⇒ 先按单个类取，再判 is-danger。 */
    const danger = opsBar.querySelectorAll('.kh-list-ops-grp')
      .filter((el) => /is-danger/.test(String(el.className)))[0];
    truthy(danger, '删除要单独进危险区');
    truthy(/删除选中/.test(String(danger.textContent)), '危险区里是删除按钮');
    const src = read('src/ui/components/fields.js');
    truthy(/delBtn\.textContent = n \? '删除选中（' \+ n \+ ' 条）'/.test(src), '按钮要报条数，别让人猜删几条');
    truthy(/\.kh-list-ops-grp\.is-danger \{ margin-left: auto/.test(read('src/ui/components/components.css')),
      '危险区要推到右侧并加分隔线');
    KH.ui.Modal.closeAll();
  });

  await test('★ 勾选被筛选隐藏：警告条出现且说明「会一并删掉」', () => {
    const src = read('src/ui/components/fields.js');
    truthy(/const hiddenPicked = \(\) => pickedRows\(\)\.filter/.test(src), '要能数出隐藏的勾选');
    truthy(/被当前筛选隐藏，点删除会一并删掉/.test(src), '警告要说清后果');
    truthy(/paintBulk\(\);/.test(src), '筛选变化后要刷新警告条');
    truthy(/const bulkWarn = h\('div', \{ class: 'kh-list-warn', hidden: true \}\)/.test(src), '警告条默认不占位');
    truthy(/已删除 ' \+ list\.length \+ ' 条/.test(src), '删完要点明删了几条');
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-list-warn\[hidden\] \{ display: none; \}/.test(css), 'hidden 必须真的不显示（flex 会压过默认样式）');
    KH.ui.Modal.closeAll();
  });

  await test('★ 后缀图例：一项一行，且七个记号一个不少（解析口径没变）', () => {
    const modal = openList(mkTok('开发者'));
    const legend = modal.querySelector('.kh-lbl-legend');
    truthy(legend, '抓取字段弹窗要有图例');
    const rows = legend.querySelectorAll('.kh-legend-row');
    truthy(rows.length >= 10, '每项独立成行，实际 ' + rows.length + ' 行');
    const codes = rows.map((r) => String(r.querySelector('.kh-legend-code') && r.querySelector('.kh-legend-code').textContent));
    for (const k of ['#图', '#0', '@2', '^锚文本', '%4', '~', '*', '!', '| 或 ｜']) {
      truthy(codes.some((c) => c.indexOf(k) >= 0), '图例里要能单独查到 ' + k + '：' + codes.join(' / '));
    }
    const t = legend.textContent;
    truthy(t.indexOf('回车') >= 0, '仍要说清「回车添加下一条」');
    truthy(legend.querySelectorAll('.kh-legend-val').length === rows.length, '每行都要有白话解释');
    KH.ui.Modal.closeAll();
  });
};
