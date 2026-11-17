/* tests/specs/compare-row-marks.test.js — 图片侧比对结论：行标题格里的 ✓ / ◐ / ✗
 *
 * 口径（2026-11-17 · 用户 m03523）：
 *   ① 结论挂在「文档类别那一行的标题单元格」里，不再在卡片底部占一行；
 *   ② 一类多图：只要有一张图对上，这一项就算对上；
 *   ③ 多个比对项：全对上 ✓、部分 ◐（悬停列出哪些有、哪些没有）、全不对 ✗；
 *   ④ 比对项被删掉后，上一轮的符号要撤掉，不留旧结论。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 一行一个「文档类别」：td 里并排放图，另一格放标题文字 */
function bodyWithRows(rows) {
  const body = H.el('div');
  const table = H.el('table');
  for (const srcs of rows) {
    const tr = H.el('tr');
    const td = H.el('td');
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

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);

  suite('compare-row-marks · 图片侧比对结论挂在行标题格');

  await test('★ 一类里两张图，只有一张对上 ⇒ 这一项仍算对上（✓ 绿，悬停说名字）', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png', 'https://ex.com/b.png']]);
    p.imgItems = [
      item('https://ex.com/a.png', { state: 'diff', items: [{ name: '广东天宸', ok: false }] }),
      item('https://ex.com/b.png', { state: 'same', items: [{ name: '广东天宸', ok: true }] })
    ];
    p.applyImgMarks();
    const mark = p.bodyEl.querySelectorAll('.kh-cmp-mark')[0];
    truthy(mark, '标题格里要有一枚比对符号');
    eq(mark.textContent, '✓', '任一张对上 ⇒ ✓');
    eq(mark.getAttribute('data-state'), 'ok', '状态 ok（绿色）');
    truthy(String(mark.title).indexOf('广东天宸') >= 0, '悬停说出对上的项：' + mark.title);
  });

  await test('★ 多个比对项：部分对上 ⇒ ◐ 黄，悬停分别列出有哪些、缺哪些', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png']]);
    p.imgItems = [item('https://ex.com/a.png', {
      state: 'diff',
      items: [{ name: '广东天宸', ok: true }, { name: '维沃', ok: false }]
    })];
    p.applyImgMarks();
    const mark = p.bodyEl.querySelectorAll('.kh-cmp-mark')[0];
    eq(mark.textContent, '◐', '部分对上 ⇒ ◐');
    eq(mark.getAttribute('data-state'), 'part');
    truthy(String(mark.title).indexOf('广东天宸') >= 0 && String(mark.title).indexOf('维沃') >= 0,
      '悬停既说有、也说缺：' + mark.title);
  });

  await test('★ 一个都没对上 ⇒ ✗ 黄，悬停点名缺哪个', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png']]);
    p.imgItems = [item('https://ex.com/a.png', { state: 'diff', items: [{ name: '维沃', ok: false }] })];
    p.applyImgMarks();
    const mark = p.bodyEl.querySelectorAll('.kh-cmp-mark')[0];
    eq(mark.textContent, '✗');
    eq(mark.getAttribute('data-state'), 'bad');
    truthy(String(mark.title).indexOf('维沃') >= 0, '悬停说出缺的项：' + mark.title);
  });

  await test('★ 没配比对项的图不挂符号；把比对项删掉后旧符号要撤掉', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithRows([['https://ex.com/a.png'], ['https://ex.com/b.png']]);
    p.imgItems = [
      item('https://ex.com/a.png', { state: 'same', items: [{ name: '广东天宸', ok: true }] }),
      item('https://ex.com/b.png', null)
    ];
    p.applyImgMarks();
    eq(p.bodyEl.querySelectorAll('.kh-cmp-mark').length, 1, '只有配了比对项的那一行有符号');

    p.imgItems = [item('https://ex.com/a.png', null), item('https://ex.com/b.png', null)];
    p.applyImgMarks();
    eq(p.bodyEl.querySelectorAll('.kh-cmp-mark').length, 0, '比对项删掉 ⇒ 旧符号一并摘掉');
  });

  await test('没有 bodyEl（面板还没造壳）⇒ 不抛也不画', () => {
    const p = shadowPanel();
    p.imgItems = [item('https://ex.com/a.png', { state: 'same', items: [{ name: 'x', ok: true }] })];
    p.applyImgMarks();
    eq(1, 1);
  });
};
