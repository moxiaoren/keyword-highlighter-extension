/* tests/specs/v2087.test.js — 2.0.8.7 的两条新口径
 * ----------------------------------------------------------------------------
 * ① 图文合并的**命中闸门**：只有「这个字段的图这次真的 OCR 命中」才出合并行
 *    （2.0.8.6 的旧口径只看配置里写没写这个字段名 ⇒ 图没认出来也照样出行，用户实测不符）；
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy, falsy, loadKernel } = H;

module.exports = async function run() {
  const KH = loadKernel([]);
  const C = KH.Config;
  const N = KH.ImportantNote;

  /* ================= ① 合并闸门 ================= */

  suite('2.0.8.7 需求①：图文合并只在「图这次真命中」时出行');

  await test('★ 配置里写了字段、但这次没有 OCR 条目 ⇒ hit=false', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => [];
    const rows = N.mergeRowsFor(
      { pinId: 'kw1', imgOcrNeed: '登记号' },
      { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著', hidden: true }] } }
    );
    eq(rows.length, 1, '配置命中（字段在 imgOcrNeed 里）仍然产出一行');
    eq(rows[0].hit, false, '但图没认出来 ⇒ hit 必须是 false，decorateMerge 会把它滤掉');
    eq(rows[0].title, '软著');
    eq(rows[0].hidden, true);
    KH.ImgOcr.items = items;
  });

  await test('★ 有该字段的 OCR 条目且动态值全在 ⇒ hit=true', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 2024SR001', need: ['登记号'], needMissingValues: [], matched: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1', imgOcrNeed: '登记号' }, '登记号'), true);
    KH.ImgOcr.items = items;
  });

  await test('★ 条目是别的规则 / 别的字段 / 没读完 ⇒ 一律不算命中', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'other', label: '登记号', state: 'done', text: 'x', need: ['登记号'], needMissingValues: [] },
      { ruleId: 'kw1', label: '开发者', state: 'done', text: 'x', need: ['登记号'], needMissingValues: [] },
      { ruleId: 'kw1', label: '登记号', state: 'pending', text: 'x', need: ['登记号'], needMissingValues: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '登记号'), false, '三条都不该算命中');
    KH.ImgOcr.items = items;
  });

  await test('★ 动态值缺一个 ⇒ 不算命中（与 judgeInfo 的且关系一致）', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '登记号', state: 'done', text: 'x', need: ['登记号'], needMissingValues: ['2024SR001'], matched: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '登记号'), false);
    KH.ImgOcr.items = items;
  });

  await test('★ 没配动态判据时看静态命中词（matched 非空才算）', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '截图', state: 'done', text: 'x', need: [], matched: [] },
      { ruleId: 'kw1', label: '截图', state: 'done', text: 'x', need: [], matched: [{ text: '登记号' }] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '截图'), true, '第二条 static 命中了', false);
    KH.ImgOcr.items = items;
  });

  await test('没配图文合并 / 字段不在 imgOcrNeed 里 ⇒ 一行都不出', () => {
    eq(N.mergeRowsFor({ imgOcrNeed: '登记号' }, {}).length, 0);
    eq(N.mergeRowsFor({ imgOcrNeed: '' }, { imgMerge: { on: true, rows: [{ field: '登记号' }] } }).length, 0);
    eq(N.mergeRowsFor({ imgOcrNeed: '别的' }, { imgMerge: { on: true, rows: [{ field: '登记号' }] } }).length, 0);
  });

  /* ================= ⑤ 合并展示口径（A1 并表 + B2 有值进表才算） ================= */

  suite('2.0.8.7 口径：合并行并进「进表」那张表 + 静态命中要「有值进表」才触发');

  /** 临时替换 `ImgOcr` 的四个读点（`ocrExtraRows` 只走这几个口），跑完必还原。 */
  function withImgOcr(stub, fn) {
    const I = KH.ImgOcr;
    const old = { items: I.items, kvWords: I.kvWords, scopedRaw: I.scopedRaw, scopeKnown: I.scopeKnown };
    I.items = stub.items;
    I.kvWords = stub.kvWords;
    if (stub.scopedRaw) I.scopedRaw = stub.scopedRaw;
    if (stub.scopeKnown) I.scopeKnown = stub.scopeKnown;
    try { return fn(); } finally {
      I.items = old.items;
      I.kvWords = old.kvWords;
      if (old.scopedRaw) I.scopedRaw = old.scopedRaw;
      if (old.scopeKnown) I.scopeKnown = old.scopeKnown;
    }
  }

  const OCR_ONE = () => [{
    ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 abc1234', matched: ['登记号'],
    lineList: [{ cells: [{ t: '登记号' }, { t: 'abc1234' }] }],
  }];

  await test('★ B2：字段没写进动态词，只要「静态命中 + 真的进表出了值」就出合并行', () => {
    const rows = withImgOcr(
      { items: OCR_ONE, kvWords: () => ['登记号'], scopedRaw: (raw) => raw, scopeKnown: () => [] },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号 #表' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 1, '静态命中且有值时必须出这一行');
    eq(rows[0].hit, true);
    eq(rows[0].value, 'abc1234', '值直接取「进表」那一行，不回头再猜');
  });

  await test('★ B2 反例：图里命中、但没进表（没有 #表 标记的词）⇒ 不出行', () => {
    const rows = withImgOcr(
      { items: OCR_ONE, kvWords: () => [], scopedRaw: (raw) => raw, scopeKnown: () => [] },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 0, '没有值就不许留空壳');
  });

  await test('★ B2 反例：进表有词但这次没命中（matched 为空）⇒ 不出行', () => {
    const rows = withImgOcr(
      {
        items: () => [{
          ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 abc1234', matched: [],
          lineList: [{ cells: [{ t: '登记号' }, { t: 'abc1234' }] }],
        }],
        kvWords: () => ['登记号'], scopedRaw: (raw) => raw, scopeKnown: () => [],
      },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号 #表' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 0);
  });

  /** 造一张带 tbody 的抓取表（DOM 垫片足够：只需要 querySelector / appendChild / textContent）。 */
  function fetchCardEl() {
    const el = global.document.createElement('div');
    el.innerHTML = '<table class="kh-table kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">登记号</td><td>abc1234</td></tr>' +
      '</tbody></table>';
    return el;
  }

  await test('★ A1：合并行进「进表」那张表的 tbody，全卡只有一张表', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: true }] });
    const rows = el.querySelectorAll('tr.kh-merge-row');
    eq(rows.length, 1, '要有一行合并行');
    eq(el.querySelectorAll('table').length, 1, '不许再出现第二张表（旧口径就是表下面再一张）');
    const tds = rows[0].querySelectorAll('td');
    eq(tds[0].textContent, '软著');
    eq(tds[1].textContent, 'abc1234');
  });

  await test('★ A1 幂等：同样的内容再画一遍，行数不变、不重建', () => {
    const el = fetchCardEl();
    const item = { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: true }] };
    N.panel.decorateMerge(el, item);
    const first = el.querySelectorAll('tr.kh-merge-row')[0];
    N.panel.decorateMerge(el, item);
    const again = el.querySelectorAll('tr.kh-merge-row');
    eq(again.length, 1);
    truthy(again[0] === first, '同一行必须还是同一个节点（内容没变不重排）');
  });

  await test('★ A1：没命中就一条都不留（也不留孤儿按钮）', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: false }] });
    eq(el.querySelectorAll('tr.kh-merge-row').length, 0);
    eq(el.querySelectorAll('.kh-merge-more').length, 0);
  });

  await test('★ A1：隐藏行默认不显示，点「显示 N 条」才摊开（按钮挂在表后）', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: true, hit: true }] });
    const row = el.querySelectorAll('tr.kh-merge-row')[0];
    truthy(row.className.indexOf('kh-merge-hidden') >= 0, '隐藏行要带 kh-merge-hidden');
    eq(el.querySelectorAll('.kh-merge-more').length, 1, '要有「显示 N 条」开关');
    eq(el.querySelectorAll('tr.kh-merge-row').length, 1);
  });
};
