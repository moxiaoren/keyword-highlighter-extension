/* tests/specs/v20818p1.test.js — 2.0.8.18 需求②（P1）：合并行的冲突呈现
 * ----------------------------------------------------------------------------
 * 口径（用户 2026-11-10 拍板「先把 #114 冲突视觉补完」）：
 *   ① 两路值（页面抓取 / 图片进表）不一致时，这一行**必须让人看得出来**；
 *   ② 显示哪个值由每行的 `onConflict` 决定，五档：mark（默认，值照常显示 + 标注
 *      conflict 样式）、both（两值并列）、ocr（取图上值）、fetch（取页面值）、
 *      skip（这一行先不出现）；
 *   ③ 策略只决定「显示哪个」，**不决定「丢不丢信息」**：另一路的值永远留在悬停里；
 *   ④ 非冲突行不受策略影响（配了 skip 也不会把一致的行藏起来）。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy } = H;

module.exports = async function run() {
  const KH = H.loadKernel();
  const C = KH.Config;
  const N = KH.ImportantNote;
  const V = KH.OcrCopy.VIEW;

  /* ================= ① 配置归一 ================= */

  suite('2.0.8.18 · P1 合并行冲突策略的归一');

  await test('★ 不写 onConflict ⇒ 默认 mark（最保守：标注，不吞行）', () => {
    const r = C.normalizeImgMerge({ rows: [{ field: '登记号' }] }).rows[0];
    eq(r.onConflict, 'mark');
  });

  await test('★ 五档都收，大小写不敏感；未知值回落 mark', () => {
    const n = C.normalizeImgMerge;
    eq(n({ rows: [{ field: 'A', onConflict: 'both' }] }).rows[0].onConflict, 'both');
    eq(n({ rows: [{ field: 'A', onConflict: 'OCR' }] }).rows[0].onConflict, 'ocr');
    eq(n({ rows: [{ field: 'A', onConflict: 'fetch' }] }).rows[0].onConflict, 'fetch');
    eq(n({ rows: [{ field: 'A', onConflict: 'skip' }] }).rows[0].onConflict, 'skip');
    eq(n({ rows: [{ field: 'A', onConflict: '乱写的' }] }).rows[0].onConflict, 'mark', '坏值不许变成未定义');
    eq(n({ rows: [{ field: 'A', onConflict: 123 }] }).rows[0].onConflict, 'mark');
  });

  await test('★ 去重时保留**第一条**的策略（与 field/title 同一套「先写的赢」）', () => {
    const rows = C.normalizeImgMerge({
      rows: [{ field: '登记号', onConflict: 'both' }, { field: '登记号', onConflict: 'skip' }]
    }).rows;
    eq(rows.length, 1);
    eq(rows[0].onConflict, 'both');
  });

  /* ================= ② 配置传到合并行 ================= */

  suite('2.0.8.18 · P1 mergeRowsFor 把策略原样带出去');

  await test('★ 动态词路径与静态进表路径都要带 onConflict', () => {
    const I = KH.ImgOcr;
    const old = { items: I.items, kvWords: I.kvWords, scopedRaw: I.scopedRaw, scopeKnown: I.scopeKnown };
    try {
      I.items = () => [{
        ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 abc1234', matched: ['登记号'],
        lineList: [{ cells: [{ t: '登记号' }, { t: 'abc1234' }] }],
      }];
      I.kvWords = () => ['登记号'];
      I.scopedRaw = (raw) => raw;
      I.scopeKnown = () => [];
      const cfg = { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著', onConflict: 'both' }] } };
      const needRow = N.mergeRowsFor({ pinId: 'kw1', imgOcr: true, imgOcrNeed: '登记号' }, cfg)[0];
      eq(needRow.onConflict, 'both', '动态词路径要带上策略');
      const tableRow = N.mergeRowsFor({ pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号 #表' }, cfg)[0];
      eq(tableRow.from, 'table');
      eq(tableRow.onConflict, 'both', '静态进表路径也要带上策略');
    } finally {
      I.items = old.items;
      I.kvWords = old.kvWords;
      if (old.scopedRaw) I.scopedRaw = old.scopedRaw;
      if (old.scopeKnown) I.scopeKnown = old.scopeKnown;
    }
  });

  /* ================= ③ 呈现：五档行为 ================= */

  suite('2.0.8.18 · P1 冲突行按策略显示');

  /** 抓取表里「登记号」= abc1234；OCR 进表值另给，构造冲突。 */
  function cardEl() {
    const el = global.document.createElement('div');
    el.innerHTML = '<table class="kh-table kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">登记号</td><td>abc1234</td></tr>' +
      '</tbody></table>';
    return el;
  }
  function draw(policy, ocrValue) {
    const el = cardEl();
    N.panel.decorateMerge(el, {
      mergeRows: [{
        field: '登记号', title: '软著', hidden: false, hit: true,
        ocrValue: ocrValue, onConflict: policy
      }]
    });
    return el;
  }
  const rowsOf = (el) => el.querySelectorAll('tr.kh-merge-row');

  await test('★ mark（默认）：值取页面抓取，行带冲突类，悬停摊开两路原值', () => {
    const el = draw('mark', 'zzz999');
    const rows = rowsOf(el);
    eq(rows.length, 1);
    const tr = rows[0];
    truthy(String(tr.className).indexOf('kh-merge-conflict') >= 0, '冲突行必须带 kh-merge-conflict');
    eq(tr.getAttribute('data-kh-verdict'), 'conflict');
    const tds = tr.querySelectorAll('td');
    eq(tds[1].textContent, 'abc1234', '默认仍显示页面抓取值（不擅自改用户看到的内容）');
    truthy(String(tr.title).indexOf('zzz999') >= 0, '悬停里必须有图片上的值');
    truthy(String(tr.title).indexOf('abc1234') >= 0, '悬停里必须有页面抓取值');
    truthy(String(tr.title).indexOf(V.conflictTipOcr) >= 0);
  });

  await test('★ both：两值并列（页面值在前、图上值在后），并解释两个值的左右顺序', () => {
    const el = draw('both', 'zzz999');
    const tds = rowsOf(el)[0].querySelectorAll('td');
    truthy(tds[1].textContent.indexOf('abc1234') >= 0);
    truthy(tds[1].textContent.indexOf('zzz999') >= 0);
    truthy(tds[1].textContent.indexOf(V.conflictBothSep) >= 0, '两值之间要有分隔符');
    truthy(tds[1].textContent.indexOf('abc1234') < tds[1].textContent.indexOf('zzz999'), '页面值在左');
  });

  await test('★ ocr：冲突时取图片上的值；悬停仍给页面值', () => {
    const el = draw('ocr', 'zzz999');
    const tr = rowsOf(el)[0];
    eq(tr.querySelectorAll('td')[1].textContent, 'zzz999');
    truthy(String(tr.title).indexOf('abc1234') >= 0, '换值不等于丢信息');
  });

  await test('★ fetch：冲突时取页面值（与默认显示一致，但语义是用户显式选的）', () => {
    const el = draw('fetch', 'zzz999');
    eq(rowsOf(el)[0].querySelectorAll('td')[1].textContent, 'abc1234');
  });

  await test('★ skip：冲突行先不出现；但**一致**的行配 skip 也照常显示', () => {
    eq(rowsOf(draw('skip', 'zzz999')).length, 0, '冲突 + skip ⇒ 这一行不出现');
    eq(rowsOf(draw('skip', 'abc1234')).length, 1, '一致 + skip ⇒ 不受策略影响');
  });

  await test('★ 一致的行不带冲突类，悬停也不写「图片上的值」', () => {
    const tr = rowsOf(draw('mark', 'ABC1234'))[0];
    eq(String(tr.className).indexOf('kh-merge-conflict'), -1, '大小写差异算一致，不许标成冲突');
  });

  await test('★ 文案全部来自 ocr-copy（这里不手写中文）', () => {
    const keys = ['conflictTipOcr', 'conflictTipFetch', 'conflictTipBoth',
      'conflictTipWeak', 'conflictTipOnlyA', 'conflictTipOnlyB', 'conflictBothSep'];
    for (let i = 0; i < keys.length; i++) truthy(!!V[keys[i]], 'VIEW 缺 ' + keys[i]);
  });
};
