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

  /* ===== 2.0.14.8 · 认领准确性补测（用户 m14946）=====
   * 上一组只证明「三张牌都在、有一张换成了真地址」，没证明「换的是对的那张」。
   * 这一组钉住两件事：①三份 PDF 各有各的牌（token 不同），地址只落到被点的那张；
   * ②两个抓取字段之间绝不串用（A 的地址不许出现在 B 的格子里）。 */
  const tableOf = (rows) => {
    const table = H.el('table'); const tbody = H.el('tbody');
    for (const r of rows) tbody.appendChild(r.tr);
    table.appendChild(tbody); document.body.appendChild(table);
    return table;
  };

  await test('★ 一个字段三份 PDF：三张牌各有各的 token，地址只换被点的那一张', () => {
    const c1 = H.el('span', { class: 'content-pdf' });
    const c2 = H.el('span', { class: 'content-pdf' });
    const c3 = H.el('span', { class: 'content-pdf' });
    const r = rowOf('APP电子版权证书', [c1, c2, c3]);
    const table = tableOf([r]);
    try {
      const F = KH.Fetch;
      const tokens = [c1, c2, c3].map((el) => F.autoPdfTokenKey(el));
      eq(new Set(tokens).size, 3, '★ 三份 PDF 的等待牌 token 必须互不相同（同 token = 三张牌一起变）');
      truthy(tokens.every((t) => !!t), '★ token 不许为空');
      F.rememberAutoPdf(c2, 'https://x.test/mid.pdf');
      eq(F.autoPdfOf(c1), '', '★ 第一份没被抓过，不许沾别人的地址');
      eq(F.autoPdfOf(c2), 'https://x.test/mid.pdf', '★ 只有被点的那一份拿到地址');
      eq(F.autoPdfOf(c3), '', '★ 第三份同样不许沾');
      const chips = String(F.cellText(r.valueCell, false)).split('\u0001KHPDF\u0001').slice(1)
        .map((c) => { try { return decodeURIComponent(c); } catch (e) { return c; } });
      eq(chips.filter((c) => c.indexOf('mid.pdf') >= 0).length, 1, '★ 真地址只出现一次');
      eq(chips.filter((c) => c.indexOf('#pend:') >= 0).length, 2, '★ 另外两张仍是等待牌');
    } finally { document.body.removeChild(table); }
  });

  await test('★ 两个抓取字段各一份 PDF：地址只落到自己字段的格子（不串用）', () => {
    const ca = H.el('span', { class: 'content-pdf' });
    const cb = H.el('span', { class: 'content-pdf' });
    const ra = rowOf('计算机软件著作权登记证书', [ca]);
    const rb = rowOf('APP电子版权认证证书', [cb]);
    const table = tableOf([ra, rb]);
    try {
      const F = KH.Fetch;
      /* 地址没回来时 `collectPdfs` 不出条目（条目只认已拿到的地址），所以先只给 A 一个地址，
       * 再看 B 会不会被顺手套上 A 的地址 —— 这正是「跨字段串用」的形态。 */
      F.rememberAutoPdf(ca, 'https://x.test/a.pdf');
      const got = KH.ImgOcr.collectPdfs({ ruleId: 'k9', meta: {} }, [
        { label: '计算机软件著作权登记证书', cells: [ra.valueCell] },
        { label: 'APP电子版权认证证书', cells: [rb.valueCell] }
      ]);
      eq(got.length, 1, '★ 只有 A 拿到地址 ⇒ 只许出一个条目（B 不许借 A 的地址凑一个）');
      eq(got[0].label, '计算机软件著作权登记证书', '★ 条目的字段名必须是 A');
      eq(got[0].src, 'https://x.test/a.pdf', '★ 地址是 A 自己的');
      eq(F.autoPdfOf(cb), '', '★ B 字段不许领到 A 的地址');
      truthy(String(F.cellText(ra.valueCell, false)).indexOf('a.pdf') >= 0, '★ A 自己拿到');
      eq((String(F.cellText(rb.valueCell, false)).match(/%23pend%3A/g) || []).length, 1, '★ B 仍是等待牌');
      /* 两边各自抓到之后：各出一条，地址各是各的（不合并、不串名） */
      F.rememberAutoPdf(cb, 'https://x.test/b.pdf');
      const both = KH.ImgOcr.collectPdfs({ ruleId: 'k9', meta: {} }, [
        { label: '计算机软件著作权登记证书', cells: [ra.valueCell] },
        { label: 'APP电子版权认证证书', cells: [rb.valueCell] }
      ]);
      eq(both.length, 2, '★ 两个字段各出自己那条');
      eq(both.map((g) => g.label + '=' + g.src).join('|'), '计算机软件著作权登记证书=https://x.test/a.pdf|APP电子版权认证证书=https://x.test/b.pdf', '★ 字段名与地址一一对应');
    } finally { document.body.removeChild(table); }
  });

  await test('★ 同一份地址挂在两个字段：两边各出一张牌，名字各认各的', () => {
    const same = 'https://x.test/same.pdf';
    const ra = rowOf('软著授权书（勾选）', [H.el('a', { href: same }, [])]);
    const rb = rowOf('APP电子版权授权书（勾选）', [H.el('a', { href: same }, [])]);
    const table = tableOf([ra, rb]);
    try {
      const got = KH.ImgOcr.collectPdfs({ ruleId: 'k10', meta: {} }, [
        { label: '软著授权书（勾选）', cells: [ra.valueCell] },
        { label: 'APP电子版权授权书（勾选）', cells: [rb.valueCell] }
      ]);
      eq(got.length, 2, '★ 同一地址挂在两个字段也是两张牌（用户 m11077：确实一样才合并，不能先扫到谁就吞掉）');
      eq(got.map((g) => g.label).join('|'), '软著授权书（勾选）|APP电子版权授权书（勾选）', '★ 两张牌各带自己的字段名');
      truthy(got.every((g) => g.src === same), '★ 地址都指向同一份');
    } finally { document.body.removeChild(table); }
  });
};
