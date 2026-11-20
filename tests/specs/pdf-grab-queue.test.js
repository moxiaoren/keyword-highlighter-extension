/**
 * 2.0.14.5 需求（用户 m13119）：
 *  ① PDF 抓取一份一份来 —— 一个值格挂三份 PDF 时不许同时点开三个标签（串行队列）；
 *  ② PDF 不受 `imgOcrMax` 截断（那是图片的额度），一格三份就出三张牌；
 *  ③ 比对一致时识别原文仍要标出对上的值（不然只剩绿框，用户以为没命中）。
 */
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

/** 快照行：标签格 + 值格（colspan=8），与 replica.html 同形 */
function rowOf(label, elems) {
  const tr = H.el('tr');
  const c1 = H.el('td'); c1.appendChild(H.txt(label));
  const c2 = H.el('td', { colspan: '8' });
  for (const e of elems) c2.appendChild(e);
  tr.appendChild(c1); tr.appendChild(c2);
  tr.cells = tr.children;
  tr.cells.forEach((td, i) => { td.cellIndex = i; });
  return { tr: tr, valueCell: c2 };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('2.0.14.5 需求 · PDF 抓取串行 + 逐格一一对应 + 识别原文高亮');

  await test('★ 抓 PDF 走队列：kick 只入队，真正点开由泵一次一个', () => {
    const src = readSrc('src/features/fetch.js');
    const kick = (src.match(/function kickAutoPdf\(el\) \{[\s\S]*?\n  \}/) || [''])[0];
    truthy(!!kick, '要能读到 kickAutoPdf 的函数体');
    truthy(/autoPdfQueue\.push/.test(kick), '★ 只入队');
    truthy(!/openGrabWindow\(host, true\)/.test(kick), '★ 不许在 kick 里直接点开（那就是一次点一堆的根）');
    truthy(/function autoPdfQueuePump\(\)/.test(src), '要有队列泵');
    truthy(/openGrabWindow\(job\.host, true, done\)/.test(src), '泵一次只处理一份');
    truthy(/if \(autoPdfRunning\) return;/.test(src), '跑着的时候不许再开第二个');
  });

  await test('★ 一格挂三份 PDF：imgOcrMax=1 也要出三张牌（PDF 不跟图片抢额度）', () => {
    const links = ['a1.pdf', 'a2.pdf', 'a3.pdf'].map((u) => H.el('a', { href: 'https://x.test/' + u }, []));
    const r = rowOf('APP电子版权证书', links);
    const table = H.el('table'); const tbody = H.el('tbody');
    tbody.appendChild(r.tr); table.appendChild(tbody); document.body.appendChild(table);
    try {
      const got = KH.ImgOcr.collectPdfs({ ruleId: 'k3', meta: { imgOcrMax: 1 } }, [
        { label: 'APP电子版权证书', cells: [r.valueCell] }
      ]);
      eq(got.length, 3, '★ 三份各自一张牌（用户口径：直到这个单元格没有 pdf）');
      eq(got.map((g) => g.label).join('|'), 'APP电子版权证书|APP电子版权证书|APP电子版权证书', '三张都带本字段名');
    } finally { document.body.removeChild(table); }
  });

  await test('★ 比对一致时识别原文仍要高亮：标出对上的值，不是只给绿框', () => {
    const it = {
      text: '著作权人 北京山禾不动产管理有限公司\n登记号 2025SR0456628',
      matched: [],
      cmp: { state: 'same', items: [
        { name: '著作权人', kind: 'need', ok: true },
        { name: '登记号', kind: 'need', ok: true }
      ] },
      cmpReqs: [
        { name: '著作权人', kind: 'need', values: ['北京山禾不动产管理有限公司'] },
        { name: '登记号', kind: 'need', values: ['2025SR0456628'] }
      ]
    };
    const hits = KH.ImportantNote.ocrHits(it);
    truthy(hits.indexOf('北京山禾不动产管理有限公司') >= 0, '★ 对上的著作权人要标出来');
    truthy(hits.indexOf('2025SR0456628') >= 0, '★ 对上的登记号要标出来');
    const bad = Object.assign({}, it, { cmpReqs: [
      { name: '著作权人', kind: 'need', values: ['北京山禾不动产管理有限公司'] },
      { name: '登记号', kind: 'need', values: ['2025SR0456628'] }
    ], cmp: { state: 'diff', items: [
      { name: '著作权人', kind: 'need', ok: true },
      { name: '登记号', kind: 'need', ok: false }
    ] } });
    const hits2 = KH.ImportantNote.ocrHits(bad);
    truthy(hits2.indexOf('北京山禾不动产管理有限公司') >= 0, '对上的那项照标');
    truthy(hits2.indexOf('2025SR0456628') < 0, '★ 没对上的项不许标（那是待处理的差异）');
  });
};
