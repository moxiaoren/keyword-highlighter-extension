/* tests/specs/compare-row-marks.test.js — 图片侧比对结论：整行底色 + 标题格徽标
 *
 * 口径（2026-11-18 · 用户 m05666）：「复用隐私政策的一套展示逻辑」。
 *   ① 结论落在**整行**：行底色（KH.Compare.COLOR_OK / COLOR_BAD）＋ 标题格右侧一枚
 *      非颜色徽标（✔ 一致 / ⚠ 待确认）；悬停里说结论、说缺哪项、说口径。
 *      上一版在标题格里塞 ✓◐✗ 小符号，行里图多时挤成两行（用户实测），已删。
 *   ② 一类多图：只要有一张图对上，这一项就算对上。
 *   ③ 有任一项没对上 ⇒ ⚠ 待确认；全对上 ⇒ ✔ 一致（与隐私政策一样是二值，不再有「部分」）。
 *   ④ 比对项被删掉后，签名/底色/徽标/悬停一起撤掉，不留旧结论。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 一行一个「文档类别」：标题格挂着 kh-table-label，其余格并排放图。 */
function bodyWithRows(rows) {
  const body = H.el('div');
  const table = H.el('table');
  for (const srcs of rows) {
    const tr = H.el('tr');
    const td = H.el('td');
    td.className = 'kh-table-label';
    td.textContent = '证书';
    tr.appendChild(td);
    for (const s of srcs) {
      const cell = H.el('td');
      const im = H.el('img');
      im.setAttribute('src', s);
      cell.appendChild(im);
      tr.appendChild(cell);
    }
    table.appendChild(tr);
    body.appendChild(table);
  }
  return body;
}

/** 一条图片条目（面板消费的字段：src / state / matched / cmp） */
function item(src, cmp, matched) {
  return { key: 'r|' + src, src, state: 'done', text: 't', matched: matched || [{ text: 'x' }], cmp };
}

const labelCell = (body) => body.querySelectorAll('td.kh-table-label')[0];
/* 【2.0.17.3】小标已从标题格搬进内容格（行的最后一格）⇒ 整行找，别再只看第 0 格。 */
const markOf = (body) => {
  const cell = labelCell(body);
  const tr = cell && cell.parentNode ? cell.parentNode : null;
  return tr ? tr.querySelector('.kh-verdict') : null;
};

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);
  const C = KH.Compare;

  suite('compare-row-marks · 图片侧比对结论（隐私政策同一套：底色 + 徽标）');

  await test('★ 一类里两张图，只有一张对上 ⇒ ✔ 一致（绿底，悬停说名字）', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png', 'https://ex.com/b.png']]);
    p.imgItems = [
      item('https://ex.com/a.png', { state: 'diff', items: [{ name: '广东天宸', ok: false, kind: 'need', values: 1 }] }),
      item('https://ex.com/b.png', { state: 'same', items: [{ name: '广东天宸', ok: true, kind: 'need', values: 1 }] })
    ];
    p.applyImgMarks();
    const mark = markOf(p.bodyEl);
    truthy(mark, '标题格要有一枚结论徽标');
    eq(mark.textContent, C.markOf('same').label, '任一张对上 ⇒ ✔ 一致');
    eq(mark.getAttribute('data-state'), 'same');
    eq(labelCell(p.bodyEl).style.background, C.COLOR_OK, '整行铺一致底色');
    truthy(String(labelCell(p.bodyEl).title).indexOf('广东天宸') >= 0, '悬停说出对上的项');
  });

  await test('★ 有项没对上 ⇒ ⚠ 待确认（黄底），悬停分别列出有哪项、缺哪项', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png']]);
    p.imgItems = [item('https://ex.com/a.png', {
      state: 'diff',
      items: [{ name: '广东天宸', ok: true, kind: 'need', values: 1 }, { name: '维沃', ok: false, kind: 'need', values: 1 }]
    })];
    p.applyImgMarks();
    const mark = markOf(p.bodyEl);
    eq(mark.textContent, C.markOf('diff').label, '缺一项 ⇒ ⚠ 待确认');
    eq(mark.getAttribute('data-state'), 'diff');
    eq(labelCell(p.bodyEl).style.background, C.COLOR_BAD, '整行铺待确认底色');
    const tip = String(labelCell(p.bodyEl).title);
    truthy(tip.indexOf('广东天宸') >= 0 && tip.indexOf('维沃') >= 0, '悬停既说有、也说缺：' + tip);
    truthy(tip.indexOf(KH.OcrCopy.VIEW.imgCmpRuleTip) >= 0, '悬停末尾给口径');
  });

  await test('★ 一个都没对上 ⇒ ⚠ 待确认，悬停点名缺哪个', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png']]);
    p.imgItems = [item('https://ex.com/a.png', { state: 'diff', items: [{ name: '维沃', ok: false, kind: 'need', values: 1 }] })];
    p.applyImgMarks();
    const mark = markOf(p.bodyEl);
    eq(mark.textContent, C.markOf('diff').label);
    truthy(String(labelCell(p.bodyEl).title).indexOf('维沃') >= 0, '悬停说出缺的项');
  });

  await test('★ 字段根本没取到值 ⇒ 悬停说「没取到值」，不说「图上没有」', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png']]);
    p.imgItems = [item('https://ex.com/a.png', { state: 'diff', items: [{ name: '开发者', ok: false, kind: 'need', values: 0 }] })];
    p.applyImgMarks();
    const tip = String(labelCell(p.bodyEl).title);
    truthy(tip.indexOf('开发者') >= 0, '要点名：' + tip);
    truthy(tip.indexOf('没取到值') >= 0, '说成没取到值：' + tip);
    falsy(tip.indexOf(KH.OcrCopy.VIEW.imgCmpDiffTip.split('{')[0]) >= 0, '不该说「图上没有」：' + tip);
  });

  await test('★ 没配比对项的图不挂结论；把比对项删掉后底色与徽标一起撤掉', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png'], ['https://ex.com/b.png']]);
    p.imgItems = [
      item('https://ex.com/a.png', { state: 'same', items: [{ name: '广东天宸', ok: true, kind: 'need', values: 1 }] }),
      item('https://ex.com/b.png', null)
    ];
    p.applyImgMarks();
    eq(p.bodyEl.querySelectorAll('.kh-verdict').length, 1, '只有配了比对项的那一行有徽标');
    eq(p.bodyEl.querySelectorAll('.kh-cmp-mark').length, 0, '旧的小符号不再出现');

    p.imgItems = [item('https://ex.com/a.png', null), item('https://ex.com/b.png', null)];
    p.applyImgMarks();
    eq(p.bodyEl.querySelectorAll('.kh-verdict').length, 0, '比对项删掉 ⇒ 旧徽标摘掉');
    eq(labelCell(p.bodyEl).style.background, '', '底色也还原');
    eq(labelCell(p.bodyEl).getAttribute('data-kh-imgcmp-sig'), null, '签名一并清掉');
  });

  await test('没有 bodyEl（面板还没造壳）⇒ 不抛也不画', () => {
    const p = shadowPanel();
    p.imgItems = [item('https://ex.com/a.png', { state: 'same', items: [{ name: 'x', ok: true }] })];
    p.applyImgMarks();
    eq(1, 1);
  });
};