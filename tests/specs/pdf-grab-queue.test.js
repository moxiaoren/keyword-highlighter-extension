/**
 * 2.0.14.5 需求（用户 m13119）：
 *  ① PDF 抓取一份一份来 —— 一个值格挂三份 PDF 时不许同时点开三个标签（串行队列）；
 *  ② PDF 不受 `imgOcrMax` 截断（那是图片的额度），一格三份就出三张牌；
 *  ③ 比对一致与不一致，识别原文都要标出图上写着的值（比对只决定图片红框，m13328）。
 *  ④ 地址没抓回来之前也要先出占位，回来只换那一张（m13311）。
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

  await test('★ 比对一致与不一致，识别原文都要高亮（比对只决定图片红框）', () => {
    const make = (state, oks) => ({
      text: '著作权人 北京山禾不动产管理有限公司\n登记号 2025SR0456628',
      matched: [],
      cmp: { state: state, items: [
        { name: '著作权人', kind: 'need', ok: oks[0] },
        { name: '登记号', kind: 'need', ok: oks[1] }
      ] },
      cmpReqs: [
        { name: '著作权人', kind: 'need', values: ['北京山禾不动产管理有限公司'] },
        { name: '登记号', kind: 'need', values: ['2025SR0456628'] }
      ]
    });
    const same = KH.ImportantNote.ocrHits(make('same', [true, true]));
    truthy(same.indexOf('北京山禾不动产管理有限公司') >= 0, '★ 一致时对上的著作权人也要标');
    truthy(same.indexOf('2025SR0456628') >= 0, '★ 一致时对上的登记号也要标');
    const diff = KH.ImportantNote.ocrHits(make('diff', [true, false]));
    truthy(diff.indexOf('北京山禾不动产管理有限公司') >= 0, '★ 不一致时同样要标（用户 m13328：其他都是不变的）');
    truthy(diff.indexOf('2025SR0456628') >= 0, '★ 没对上的那个值图上写着也要标');
  });

  await test('★ 先占位再认领：地址没回来也立刻出牌，回来只换那一张', () => {
    const mk = () => H.el('span', { class: 'content-pdf' });
    const s1 = mk(); const s2 = mk(); const s3 = mk();
    const r = rowOf('APP电子版权证书', [s1, s2, s3]);
    document.body.appendChild(r.tr);
    try {
      const F = KH.Fetch;
      const t1 = F.cellText(r.valueCell, false);
      const chips = String(t1).split('\u0001KHPDF\u0001').slice(1);
      eq(chips.length, 3, '★ 三份 PDF 先各占一个位（不许因为没地址就少画）');
      /* 占位地址进串前会 encodeURIComponent ⇒ `#pend:` 落成 `%23pend%3A` */
      truthy(chips.every((c) => c.indexOf('%23pend%3A') >= 0), '★ 占位是临时地址 #pend:');
      const html = F.restoreImgs(t1);
      eq((html.match(/khin-pdf-pending/g) || []).length, 3, '★ 三张等待牌');
      eq((html.match(/data-khpdf=""/g) || []).length, 3, '★ 还没有真地址');
      F.rememberAutoPdf(s2, 'https://x.test/b.pdf');
      const t2 = F.cellText(r.valueCell, false);
      const chips2 = String(t2).split('\u0001KHPDF\u0001').slice(1).map((c) => { try { return decodeURIComponent(c); } catch (err) { return c; } });
      truthy(chips2.some((c) => c.indexOf('https://x.test/b.pdf') >= 0), '★ 认领到的那一份换成真地址');
      eq(String(t2).split('\u0001KHPDF\u0001').length - 1, 3, '★ 另外两张仍是占位');
      eq((String(t2).match(/%23pend%3A/g) || []).length, 2, '★ 只剩两张等待牌');
    } finally { document.body.removeChild(r.tr); }
  });
};
