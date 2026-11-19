/* tests/specs/note-paging.test.js — 重要笔记按页收录（【2.0.14 需求二】）
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-19）：先做成可选开关、默认关闭保持现状；开启后像 AI 助手那样分页：
 *   置顶卡单独一页固定展示 → 其后按分组成页 → 未分组最后。
 * 本套钉的是**开关默认关、页序、置顶不重复、只挂当前页、单页隐藏页签、全名不截断、切页记位置**七条。
 *
 * 造卡口径跟着 head.build 走：分组的来源是命中 meta.label（进了卡片的 entries[].adj），
 * 不是 meta.adj；置顶匹配键是 meta.pinId（= 规则 ruleId），归一成小写。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const head = KH.ImportantNote.head;

  /** 面板是单例字面量：原型继承造影子面板，只改自己的字段（同 important-note.test.js 手法） */
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);

  /** 造一条命中：label = 分组名（页的归组依据），pinId = 规则身份（置顶匹配用） */
  function hit(display, note, extra) {
    const meta = Object.assign({ display: display, text: display, label: '', importantNote: note, important: true }, extra || {});
    return { id: display + '|' + note, textNode: {}, kind: 'normal', meta: meta };
  }

  const cardsOf = (arr) => head.build(arr, new Set());

  /** 按给定卡与配置跑一次 renderItems（ptabsEl 给桩，否则收起联动那段没对象可写） */
  function renderWith(items, importantNote) {
    const p = shadowPanel();
    p.bodyEl = H.el('div');
    p.ptabsEl = H.el('div');
    p.cfg = { importantNote: importantNote || {} };
    p.items = items;
    p.renderItems();
    return p;
  }

  const keysOf = (p) => (p.pages || []).map((x) => x.key).join(',');
  const notesIn = (p) => p.bodyEl.querySelectorAll('.khin-item-note').map((el) => el.textContent).join(',');

  suite('important-note · 按页收录（2.0.14 需求二，默认关）');

  await test('★ 开关默认关：不建页表、不显示页签（与旧版逐字节一致）', () => {
    const p = renderWith(cardsOf([hit('甲', 'N甲', { label: '规范' }), hit('乙', 'N乙', { label: '流程' })]), {});
    eq((p.pages || []).length, 0, '关着不许算出页表');
    truthy(p.ptabsEl.hidden === true, '关着页签条必须隐藏');
    eq(p.bodyEl.children.length, 2, '关着就是一条长列表（两张卡都在）');
  });

  await test('★ 页序：置顶页 → 各分组页（按首次出现顺序）→ 未分组末页', () => {
    const items = cardsOf([
      hit('甲', 'N甲', { label: '项目管理规范', pinId: 'k1' }),
      hit('乙', 'N乙', { label: '项目管理规范' }),
      hit('丙', 'N丙', { label: '项目管理流程' }),
      hit('丁', 'N丁', { label: '' })
    ]);
    const p = renderWith(items, { pagedTabs: true, pinOrder: 'k1' });
    eq(keysOf(p), 'pin,g:项目管理规范,g:项目管理流程,other');
    eq(p.pages[0].label, '置顶');
    eq(p.pages[0].count, 1, '置顶页只有那一张');
    eq(p.pages[1].count, 1, '置顶卡不许在分组页里再算一次');
    eq(p.pages[3].label, '未分组');
  });

  await test('★ 只在当前页挂卡：置顶页只挂置顶那张，切走之后消失', () => {
    const items = cardsOf([
      hit('甲', 'N甲', { label: '规范', pinId: 'k1' }),
      hit('乙', 'N乙', { label: '规范' }),
      hit('丙', 'N丙', { label: '流程' })
    ]);
    const p = renderWith(items, { pagedTabs: true, pinOrder: 'k1' });
    eq(p.bodyEl.children.length, 1, '首屏是置顶页，只挂 1 张');
    eq(notesIn(p), 'N甲');
    p.setNotePage('g:规范');
    eq(p.bodyEl.children.length, 1, '规范页只有非置顶的那张');
    eq(notesIn(p), 'N乙');
  });

  await test('★ 分组名用全名：前 8 字相同也不许并成一页', () => {
    const items = cardsOf([
      hit('甲', 'N甲', { label: '项目管理规范文档' }),
      hit('乙', 'N乙', { label: '项目管理流程文档' })
    ]);
    const p = renderWith(items, { pagedTabs: true });
    eq(keysOf(p), 'g:项目管理规范文档,g:项目管理流程文档', '页 key 用未截断的全名');
    eq(p.pages[0].label, '项目管理规范文档', 'label 也用全名（页签自己 ellipsis）');
  });

  await test('★ 只有一页时整条页签隐藏（一页页签没信息量还占高度）', () => {
    const items = cardsOf([hit('甲', 'N甲', { label: '规范' }), hit('乙', 'N乙', { label: '规范' })]);
    const p = renderWith(items, { pagedTabs: true });
    eq((p.pages || []).length, 1);
    truthy(p.ptabsEl.hidden === true, '单页必须隐藏页签条');
    eq(p.bodyEl.children.length, 2, '单页照样两张卡都在');
  });

  await test('★ 置顶为空就不出置顶页；没有未分组卡也不出未分组页', () => {
    const items = cardsOf([hit('甲', 'N甲', { label: '规范' }), hit('乙', 'N乙', { label: '流程' })]);
    const p = renderWith(items, { pagedTabs: true, pinOrder: '' });
    eq(keysOf(p), 'g:规范,g:流程');
  });

  await test('★ 切页记住各自的滚动位置', () => {
    const items = cardsOf([hit('甲', 'N甲', { label: '规范' }), hit('乙', 'N乙', { label: '流程' })]);
    const p = renderWith(items, { pagedTabs: true });
    p.bodyEl.scrollTop = 120;
    p.setNotePage('g:流程');
    eq(p.bodyEl.scrollTop, 0, '新页从顶部开始');
    p.bodyEl.scrollTop = 40;
    p.setNotePage('g:规范');
    eq(p.bodyEl.scrollTop, 120, '切回来要还原那次的位置');
  });
};
