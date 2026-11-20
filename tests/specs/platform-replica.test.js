/**
 * 2.0.14 案例页（_cases/2.0.14/index.html）：后台详情页整页快照的行结构 + PDF 归属。
 *
 * 依据：用户 m11191「_cases/2.0.12.8/replica.html 就是那份后台整页快照，根据他进行改造。
 * 测试用例照着这个快照的结构重写，证书与授权勾选那套表单采用同类复刻，不要凭空新造页面。
 * 另外顺手把这次 PDF 归属的三条单测也补进同一套用例里。」
 *
 * 快照里每个字段行都是同一个形状（本文件照抄，不另造结构）：
 *   <tr data-v-514b86d8=""><td data-v-514b86d8="">标签</td>
 *       <td data-v-514b86d8="" colspan="8">值…</td></tr>
 * PDF 控件是 <span class="content-pdf" data-pdf="…">，页内脚本点它才 window.open。
 */
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const D = () => (typeof document !== 'undefined') ? document : global.document;

/** 快照行：标签格 + 值格（colspan=8，与 replica.html 一致）；twoTitles 时是两个标题格 + colspan=7 值格 */
function snapRow(label, elems, opts) {
  const o = opts || {};
  const cells = [];
  if (o.twoTitles) {
    for (const t of o.twoTitles) { const c = H.el('td', { 'data-v-514b86d8': '' }); c.appendChild(H.txt(t)); cells.push(c); }
  } else {
    const c = H.el('td', { 'data-v-514b86d8': '' }); c.appendChild(H.txt(label)); cells.push(c);
  }
  const valueCell = H.el('td', { 'data-v-514b86d8': '', colspan: o.twoTitles ? '7' : '8' });
  for (const e of (elems || [])) valueCell.appendChild(e);
  cells.push(valueCell);
  const tr = H.el('tr', { 'data-v-514b86d8': '' });
  for (const c of cells) tr.appendChild(c);
  tr.cells = tr.children;
  tr.cells.forEach((td, i) => { td.cellIndex = i; });
  const tbody = H.el('tbody'); tbody.appendChild(tr);
  const table = H.el('table'); table.appendChild(tbody);
  table.rows = [tr];
  tr.rowIndex = 0;
  return { tr: tr, table: table, valueCell: valueCell };
}

const pdfCtl = (u) => H.el('span', Object.assign({ 'class': 'content-pdf' }, u ? { 'data-pdf': u } : {}), [H.txt('PDF')]);

/** 把若干行装进一张表挂到 body（closest 需要真实祖先链） */
function mount(rows) {
  const table = H.el('table'); const tbody = H.el('tbody');
  for (const r of rows) tbody.appendChild(r.tr);
  table.appendChild(tbody);
  table.rows = rows.map((r) => r.tr);
  D().body.appendChild(table);
  return table;
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;

  suite('2.0.14 案例页：快照行结构下的 PDF 归属');

  await test('★ 快照形状的两行各自挂 PDF ⇒ 两个字段的键与地址都各自独立', () => {
    const p1 = pdfCtl('assets/attachment.pdf');
    const p2 = pdfCtl('assets/attachment.pdf?v=2');
    const r1 = snapRow('互联网信息服务算法备案合作证明', [p1]);
    const r2 = snapRow('AI生成应用承诺函', [p2]);
    const table = mount([r1, r2]);
    try {
      const k1 = F.autoPdfKeyOf(p1);
      const k2 = F.autoPdfKeyOf(p2);
      truthy(/互联网信息服务算法备案合作证明/.test(k1), '第一行的键带自己的行标签');
      truthy(/AI生成应用承诺函/.test(k2), '第二行的键带自己的行标签');
      truthy(k1 !== k2, '★ 两个字段的键必须不同 —— 否则换行序就互相顶掉（这正是"抓成同一个"的根）');
      F.rememberAutoPdf(p1, 'https://x.test/cdn/a1.pdf');
      F.rememberAutoPdf(p2, 'https://x.test/cdn/a2.pdf');
      eq(F.autoPdfOf(p1), 'https://x.test/cdn/a1.pdf', '第一行拿到自己的地址');
      eq(F.autoPdfOf(p2), 'https://x.test/cdn/a2.pdf', '★ 第二行不许拿到第一行的地址');
    } finally { D().body.removeChild(table); }
  });

  await test('★ 快照形状：一行两个标题格 + colspan=7 的值格 ⇒ 行标签取紧邻控件的那个标题', () => {
    const pdf = pdfCtl('assets/attachment.pdf?v=3');
    const row = snapRow('', [pdf], { twoTitles: ['互联网信息服务算法备案合作证明', 'AI生成应用承诺函'] });
    const table = mount([row]);
    try {
      const key = F.autoPdfKeyOf(pdf);
      truthy(/AI生成应用承诺函/.test(key), '★ 取紧邻的那个标题（现场结构就是 PDF 紧跟第二个标题）');
      truthy(!/互联网信息服务算法备案合作证明/.test(key), '不许取最左那格（会把两个字段的地址记混）');
    } finally { D().body.removeChild(table); }
  });

  await test('★ 两行确实是同一份 PDF ⇒ 各自都记住（合并成一列是预期，用户 m11077）', () => {
    const url = 'https://x.test/cdn/shared.pdf';
    const p1 = pdfCtl(); const p2 = pdfCtl();
    const r1 = snapRow('互联网信息服务算法备案合作证明', [p1]);
    const r2 = snapRow('AI生成应用承诺函', [p2]);
    const table = mount([r1, r2]);
    try {
      F.rememberAutoPdf(p1, url);
      F.rememberAutoPdf(p2, url);
      eq(F.autoPdfOf(p1), url, '第一个字段拿到地址');
      eq(F.autoPdfOf(p2), url, '★ 真一样时第二个字段也拿到（合并是合规形态，不许拦）');
      eq(p2.getAttribute('data-khpdf-dup'), null, '不许给控件打「重复」标记');
    } finally { D().body.removeChild(table); }
  });

  await test('★ 快照形状：证书行与授权勾选行的单元格文字都能取到（证书/勾选不靠另造版式）', () => {
    const img = H.el('img', { 'class': 'el-image__inner', alt: '计算机软件著作权登记证书', src: 'data:image/png;base64,AAAA' });
    const certRow = snapRow('计算机软件著作权登记证书', [H.el('div', { 'class': 'el-image detail-app-screenshot' }, [img])]);
    const box = H.el('label', { 'class': 'el-checkbox' }, [H.txt('已核验：授权方 = 著作权人 南京石诚星桥科技有限公司')]);
    const authRow = snapRow('软著授权书（勾选）', [box]);
    const table = mount([certRow, authRow]);
    try {
      const t1 = F.cellText(certRow.valueCell, false);
      truthy(typeof t1 === 'string', '证书格的文字抽取不许抛错（图由图片 OCR 接管）');
      const t2 = F.cellText(authRow.valueCell, false);
      truthy(t2.indexOf('已核验') >= 0 || t2.indexOf('南京石诚星桥科技有限公司') >= 0,
        '★ 勾选行要读到勾选文案（授权方名字在这里）');
    } finally { D().body.removeChild(table); }
  });

  /* 【2.0.15 · 用户 m11605】一个 PDF 在面板里冒出 3 张同址占位：页面的控件是**多层同名节点**
   * （`content-pdf` 里套 `content-pdf-icon`，外层容器类名也含 content-pdf），旧写法对每个
   * 匹配节点各放一条占位。现在只认簇里最外层那个，并在一次取值内按地址去重。 */
  await test('★ 控件套控件：只出一张牌，地址挂在最外层', () => {
    const inner = H.el('span', { 'class': 'content-pdf' }, [H.txt('PDF')]);
    const outer = H.el('div', { 'class': 'content-pdf' }, [inner]);
    const row = snapRow('APP电子版权证书', [outer]);
    const table = mount([row]);
    try {
      truthy(F.autoPdfControlOf(inner) === null, '里层节点不再算控件');
      truthy(F.autoPdfControlOf(outer) === outer, '★ 簇里最外层才是控件');
      F.rememberAutoPdf(inner, 'https://x.test/cdn/app.pdf');
      eq(F.autoPdfOf(outer), 'https://x.test/cdn/app.pdf', '★ 地址要挂到最外层：取值只问最外层');
      const txt = String(F.cellText(row.valueCell, false));
      eq((txt.match(/KHPDF/g) || []).length, 1, '★ 一个 PDF 只许一张牌（旧写法这里出多张同址占位）');
      truthy(txt.indexOf(encodeURIComponent('https://x.test/cdn/app.pdf')) >= 0, '占位里带的是这份 PDF 的地址');
    } finally { D().body.removeChild(table); }
  });

  await test('★ 两个字段各配一个 PDF：各出一张牌、各指向自己的地址（一一对应）', () => {
    const pa = pdfCtl(); const pb = pdfCtl();
    const ra = snapRow('APP电子版权证书', [pa]);
    const rb = snapRow('ICP证', [pb]);
    const table = mount([ra, rb]);
    try {
      F.rememberAutoPdf(pa, 'https://x.test/cdn/app.pdf');
      F.rememberAutoPdf(pb, 'https://x.test/cdn/icp.pdf');
      const ta = String(F.cellText(ra.valueCell, false));
      const tb = String(F.cellText(rb.valueCell, false));
      eq((ta.match(/KHPDF/g) || []).length, 1, 'APP电子版权证书格：一张牌');
      eq((tb.match(/KHPDF/g) || []).length, 1, 'ICP证格：一张牌');
      truthy(ta.indexOf(encodeURIComponent('https://x.test/cdn/app.pdf')) >= 0, 'APP电子版权证书格：地址是它自己的');
      truthy(tb.indexOf(encodeURIComponent('https://x.test/cdn/icp.pdf')) >= 0, '★ ICP证格：地址不许指向电子版权证书');
      truthy(ta.indexOf(encodeURIComponent('https://x.test/cdn/icp.pdf')) < 0, '两个字段的地址互不串台');
    } finally { D().body.removeChild(table); }
  });
};
