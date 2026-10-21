/**
 * 2.0.6.5 需求②：PDF 占位命中。
 *
 * 用户口径（m00003 第 2 条）：「无需展示 pdf 源文件，只需要 pdf 占位。识别时蓝色框，无命中绿色框，
 * 命中时增加红框，点击后展示全文和命中内容」。
 *
 * 这条链被切成三段，本文件逐段钉住：
 *   ① 认引用：`Fetch.pdfRefOf` 只认页面自己声明的四种写法（a[href] / iframe / embed / object），
 *      并把它换成正文里的占位符 ⇒ `restoreImgs` 还原成 `<span class="khin-pdf" data-khpdf>`；
 *   ② 抽文字：`ImgOcr.build` 为这些引用建**另一类条目**（`kind:'pdf'`），发出去的消息是
 *      `MSG.OCR_PDF` 而不是 `MSG.OCR_IMAGE`；回执只有行文本，`_onResult` 把它统一成
 *      `lineList:[{t}]` —— 于是重要笔记的 `#表` 取值链对 PDF 也能用（它按「行号 ↔ lineList 下标」取值）；
 *   ③ 三态：`ImportantNote.markPdf` 的蓝/绿/红判据（本文件只测纯判据，DOM 全貌交给真机）。
 *
 * 不走真引擎：PDF 是**文本型**文件，抽取器在 `offscreen/pdf-text.js`（纯函数，自己一份 spec），
 * 这里只验"内容侧怎么认、怎么发、怎么落地"。
 */
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 一行两格的表：[报告 | 若干元素]，并补上垫片缺的表格访问器 */
function pdfRow(elems, metaExtra) {
  const valueCell = H.el('td');
  for (const e of elems) valueCell.appendChild(e);
  const labelCell = H.el('td');
  labelCell.appendChild(H.txt('报告'));
  const tr = H.el('tr');
  tr.appendChild(labelCell); tr.appendChild(valueCell);
  tr.cells = tr.children;
  tr.cells.forEach((td, i) => { td.cellIndex = i; });
  tr.rowIndex = 0;
  const tbody = H.el('tbody'); tbody.appendChild(tr);
  const table = H.el('table'); table.appendChild(tbody);
  table.rows = [tr];
  const rule = {
    ruleId: 'kPdf', pattern: /关键词a/g, labelPattern: /报告/g, flags: {}, labelFlags: {},
    meta: Object.assign({
      imgOcr: true, imgOcrMax: 4, display: '关键词a', label: '报告',
      fetchLabels: '报告', imgOcrKeyword: '登记号#表'
    }, metaExtra || {})
  };
  return { rule: rule, anchorCell: labelCell, hitCell: labelCell, valueCells: [valueCell], table: table };
}

/** 锚点格里的文本节点当"真命中"（`cellOfHit` 会解析成那一格，再按抓取字段取值格） */
function hitOf(a) {
  const cell = a.anchorCell || a.hitCell;
  let tn = null;
  const walk = (n) => {
    for (const c of (n.childNodes || [])) {
      if (c.nodeType === 3 && String(c.nodeValue || '').trim()) { tn = c; return true; }
      if (c.nodeType === 1 && walk(c)) return true;
    }
    return false;
  };
  if (cell) walk(cell);
  if (!tn) { tn = H.txt('命中'); if (cell) cell.appendChild(tn); }
  return { ruleId: a.rule.ruleId, meta: a.rule.meta, textNode: tn };
}

const link = (href, extra) => H.el('a', Object.assign({ href: href }, extra || {}), [H.txt('下载')]);

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const O = KH.ImgOcr;
  const F = KH.Fetch;
  const N = KH.ImportantNote;
  const sent = () => (global.__OCR_SENT__ || []);

  suite('2.0.6.5 需求②：PDF 占位 — 认引用与占位符');

  await test('★ 四种引用写法都认，`.pdf` 后面带查询串/锚点也认', () => {
    const a = H.el('a', { href: 'https://x.test/a.pdf' }, []);
    const b = H.el('a', { href: 'https://x.test/b.pdf?v=2#page=3' }, []);
    const rel = H.el('a', { href: '/files/r.pdf?k=1' }, []);
    const c = H.el('iframe', { src: 'https://x.test/c.PDF' }, []);
    const d = H.el('object', { data: 'https://x.test/d.bin', type: 'application/pdf' }, []);
    eq(F.pdfRefOf(a), 'https://x.test/a.pdf');
    eq(F.pdfRefOf(b), 'https://x.test/b.pdf?v=2#page=3', '查询串与锚点要原样保留（下载地址常带版本号）');
    eq(F.pdfRefOf(rel), new URL('/files/r.pdf?k=1', location.href).href, '相对地址按当前页解析（与图片同一口径）');
    eq(F.pdfRefOf(c), 'https://x.test/c.PDF', '扩展名大小写不敏感');
    eq(F.pdfRefOf(d), 'https://x.test/d.bin', '`type=application/pdf` 也算（不看扩展名）');
    eq(F.pdfRefOf(H.el('a', { href: 'https://x.test/a.html' }, [])), '', '普通链接不许被当成 PDF');
    eq(F.pdfRefOf(H.el('a', { href: 'javascript:void(0)' }, [])), '', '非 http(s) 协议一律不认');
  });

  await test('★ 占位符 ⇒ 正文里是 `<span class="khin-pdf" data-khpdf>`（不加载阅读器）', () => {
    const mark = F.pdfPlaceholder(H.el('a', { href: 'https://x.test/a.pdf', title: '合同.pdf' }, []));
    truthy(mark && mark.indexOf('KHPDF') >= 0, '先落成带哨兵的占位符（正文整体转义时靠它保住）');
    const html = F.restoreImgs(mark);
    truthy(/class="khin-pdf"/.test(html), '还原成占位元素');
    truthy(/data-khpdf="https:\/\/x\.test\/a\.pdf"/.test(html), '`data-khpdf` 是条目与占位之间的唯一约定');
    truthy(!/iframe|embed|object/i.test(html), '★ 绝不能把 `<embed>`/`<iframe>` 塞进面板（会真去加载阅读器）');
  });

  suite('2.0.6.5 需求②：PDF 条目走 OCR 管线（发的是 OCR_PDF）');

  await test('★ 值格里的 PDF 链接 ⇒ 建 `kind:pdf` 条目，且发出去的是 `kh:ocr:pdf`', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = sent().length;
    const a = pdfRow([link('https://x.test/a.pdf')]);
    O.build({}, {}, [hitOf(a)]);
    const items = O.items();
    eq(items.length, 1, 'PDF 也进条目表（与图片共用面板、缓存与额度）');
    eq(items[0].kind, 'pdf');
    eq(items[0].src, 'https://x.test/a.pdf');
    const last = sent()[sent().length - 1];
    eq(sent().length - before, 1, '必须真的发出去一条请求');
    eq(last.type, 'kh:ocr:pdf', '★ 类型必须是 OCR_PDF（离线引擎读不了 PDF，别让它白跑）');
    eq(last.src, 'https://x.test/a.pdf');
    truthy(!last.dataUrl, 'PDF 不搬图片字节（offscreen 自己去 fetch）');
  });

  await test('★ 没开「识别图片文字」的规则：PDF 也不采集（口径与图片一致）', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const a = pdfRow([link('https://x.test/off.pdf')], { imgOcr: false });
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 0, '开关关着就不该有任何条目');
  });

  await test('★ 回执只有行文本 ⇒ `lineList` 统一成 `[{t}]`，`#表` 就能进重要笔记', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const a = pdfRow([link('https://x.test/cert.pdf')]);
    O.build({}, {}, [hitOf(a)]);
    const it = O.items()[0];
    const text = '软件名称：某系统\n登记号：2025SR0456628\n著作权人：北京山禾不动产管理有限公司';
    O._onResult({
      requestId: sent()[sent().length - 1].requestId, ok: true, via: 'pdf',
      src: 'https://x.test/cert.pdf', text: text,
      lines: text.split('\n'), pages: 2, confidence: 0, ocrMs: 12
    });
    eq(it.state, 'done');
    eq(it.lineList.length, 3, '★ 每行一条（没有单元格坐标，重要笔记按行号取值）');
    eq(it.lineList[1].t, '登记号：2025SR0456628');
    eq(it.pages, 2, '页数要落下来（面板/诊断要看）');
    truthy(it.matched.length >= 1, '命中判定照常走（与图片同一套 judgeInfo）');
    const rows = N.ocrExtraRows({ pinId: 'kPdf', imgOcr: true, imgOcrKeyword: '登记号#表' });
    eq(rows.length, 1, '★ `登记号#表` 对 PDF 也加得出表格行');
    eq(rows[0].label, '登记号');
    eq(rows[0].value, '2025SR0456628', '值不许把下一行（著作权人）吞进来');
  });

  suite('2.0.6.5 需求②：PDF 占位三态（蓝=读中 / 绿=没命中 / 红=命中）');

  const span = () => H.el('span', { 'class': 'khin-pdf', 'data-khpdf': 'https://x.test/p.pdf' }, [H.txt('PDF')]);
  const has = (el, cls) => el.classList.contains(cls);

  await test('★ 命中 ⇒ 红框，且悬停说得出命中词', () => {
    const el = span();
    N.markPdf(el, { kind: 'pdf', src: 'https://x.test/p.pdf', state: 'done', text: '登记号：1', matched: [{ text: '登记号' }] });
    truthy(has(el, 'khin-pdfhit'), '命中挂红框');
    falsy(has(el, 'khin-pdfmiss') || has(el, 'khin-pdfbusy'), '三态互斥');
    truthy(String(el.getAttribute('title') || '').indexOf('登记号') >= 0, '悬停要说出命中的是哪个词');
  });

  await test('★ 读完没命中 ⇒ 绿框；抽不出字要说"可能是扫描件"', () => {
    const el = span();
    N.markPdf(el, { kind: 'pdf', src: 'https://x.test/p.pdf', state: 'done', text: '别的字', matched: [] });
    truthy(has(el, 'khin-pdfmiss'), '没命中挂绿框');
    truthy(String(el.getAttribute('title') || '').indexOf('未命中') >= 0);
    const empty = span();
    N.markPdf(empty, { kind: 'pdf', src: 'https://x.test/q.pdf', state: 'done', text: '', matched: [] });
    truthy(has(empty, 'khin-pdfmiss'), '一个字没抽到也归绿框（不是蓝框 —— 它已经跑完了）');
    truthy(String(empty.getAttribute('title') || '').indexOf('扫描件') >= 0, '要把"可能是扫描件"说出来，用户才知道为什么');
  });

  await test('★ 排队/在读 ⇒ 蓝框；失败 ⇒ 绿框 + 失败原因', () => {
    const busy = span();
    N.markPdf(busy, { kind: 'pdf', src: 'https://x.test/p.pdf', state: 'pending' });
    truthy(has(busy, 'khin-pdfbusy'), '在途挂蓝框');
    const bad = span();
    N.markPdf(bad, { kind: 'pdf', src: 'https://x.test/p.pdf', state: 'fail', error: '取不回来' });
    truthy(has(bad, 'khin-pdfmiss'), '失败不许挂蓝（像还在跑）也不许挂红');
    truthy(String(bad.getAttribute('title') || '').indexOf('取不回来') >= 0, '失败原因要如实说出来');
    N.markPdf(busy, null);
    falsy(has(busy, 'khin-pdfbusy'), '`it` 为空 ⇒ 三个状态框全清（换帧/无条目时不许留残影）');
  });
};
