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
  /* 抓取回填会请调度器整页重算；单测里关掉它 —— 本文件只验地址能不能拿到、条目建不建得出来 */
  const savedRebuild = KH.rebuild;
  KH.rebuild = null;

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

  await test('★ 2.0.7.1 需求④：点击跳转控件（真地址不在 href）也要认', () => {
    /* 用户现场：网页上是个按钮/链接，点开才跳到 PDF；href 只是 `javascript:;` 或跳板地址 */
    const btn = H.el('a', { href: 'javascript:;', 'data-href': '/files/contract.pdf?id=3' }, [H.txt('查看附件')]);
    eq(F.pdfRefOf(btn), new URL('/files/contract.pdf?id=3', location.href).href,
      '★ data-href 里的 .pdf 必须认（旧版只看 href，于是判不出来）');
    const dl = H.el('a', { href: 'javascript:void(0)', onclick: "open('/files/a.pdf')" }, [H.txt('下载')]);
    eq(F.pdfRefOf(dl), new URL('/files/a.pdf', location.href).href, '★ onclick 里带的 .pdf 地址也认');
    const jump = H.el('a', { href: '/api/doc/download?id=9988', title: '合同 PDF' }, []);
    eq(F.pdfRefOf(jump), new URL('/api/doc/download?id=9988', location.href).href,
      '★ 地址像下载入口 + 控件自己写着 PDF ⇒ 认（点击跳转的常见形态）');
    const plain = H.el('a', { href: 'https://x.test/news/1.html', title: 'PDF 规范解读' }, []);
    eq(F.pdfRefOf(plain), '', '普通页面链接哪怕标题有 PDF 也不许当附件（否则整页都在识别 HTML）');
  });

  await test('★ 占位符 ⇒ 正文里是 `<span class="khin-pdf" data-khpdf>`（不加载阅读器）', () => {
    const mark = F.pdfPlaceholder(H.el('a', { href: 'https://x.test/a.pdf', title: '合同.pdf' }, []));
    truthy(mark && mark.indexOf('KHPDF') >= 0, '先落成带哨兵的占位符（正文整体转义时靠它保住）');
    const html = F.restoreImgs(mark);
    truthy(/class="khin-pdf"/.test(html), '还原成占位元素');
    truthy(/data-khpdf="https:\/\/x\.test\/a\.pdf"/.test(html), '`data-khpdf` 是条目与占位之间的唯一约定');
    truthy(!/iframe|embed|object/i.test(html), '★ 绝不能把 `<embed>`/`<iframe>` 塞进面板（会真去加载阅读器）');
  });

  await test('★ 2026-11-18 用户口径：没有地址的 PDF 控件（span.content-pdf）点一次拿到地址后照常占位', () => {
    /* 现场：`<span class="content-pdf">PDF</span>` 由页面脚本在点击时才拼出地址，DOM 里没有 href。
     * 约定：内容脚本点一次（kickAutoPdf）→ 后台把新标签的 .pdf 地址回推（PDF_GRAB_RESULT）→ rememberAutoPdf。 */
    const span = H.el('span', { class: 'content-pdf' }, [H.txt('PDF')]);
    eq(F.pdfRefOf(span), '', '这种控件 DOM 里没有地址（所以不能靠 pdfRefOf 判）');
    eq(F.autoPdfOf(span), '', '还没点过 ⇒ 没有地址');
    const url = 'https://x.test/cdn/auto.pdf?sign=1';
    F.rememberAutoPdf(span, url);
    eq(F.autoPdfOf(span), url, '★ 抓回来的地址要挂在控件上（下一轮重建直接用）');
    const mark = F.pdfPlaceholder(span);
    truthy(mark && mark.indexOf('KHPDF') >= 0, '拿到地址后与 `<a href>` 完全同一条链路（落成占位）');
    truthy(new RegExp('data-khpdf="' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(F.restoreImgs(mark)),
      '★ 占位里带的是真地址（后台据此下载抽字）');
    const td = H.el('td', {}, [span]);
    const got = F.cellText(td, false);
    truthy(got.indexOf('KHPDF') >= 0, '★ 单元格正文里必须是 PDF 占位，不是「PDF」两个字');
    truthy(got.indexOf('PDF') >= 0, '占位符自身含 KHPDF 字样');
    const dataPdf = H.el('span', { 'data-pdf': '' }, [H.txt('查看')]);
    F.rememberAutoPdf(dataPdf, 'https://x.test/d.pdf');
    eq(F.pdfRefOf(dataPdf), '', '`[data-pdf]` 空壳也不带地址');
    truthy(F.autoPdfOf(dataPdf).indexOf('.pdf') > 0, '`[data-pdf]` 形态同样认（选择器覆盖）');
  });

  /* 【2026-11-18 用户实测 m04718】上一版只把地址记在内存里：面板读到的是渲染时快照、PDF 条目
   * 只在 build 里建 ⇒ 抓到地址后什么都不变（用户看到「点了、标签开了、面板没东西」）。
   * 下面两条钉住两件事：重算时能建出条目、页面重画换掉元素也还能取回地址。 */
  await test('★ 2026-11-18（m04718）：没有 href 的 PDF 控件抓到地址后，也要建 PDF 条目', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = sent().length;
    const sp = H.el('span', { 'class': 'content-pdf' }, [H.txt('PDF')]);
    F.rememberAutoPdf(sp, 'https://x.test/cdn/auto2.pdf');
    const a = pdfRow([sp]);
    O.build({}, {}, [hitOf(a)]);
    const items = O.items();
    eq(items.length, 1, '抓到地址 ⇒ 与 &#96;<a href>&#96; 同口径建条目');
    eq(items[0].kind, 'pdf');
    eq(items[0].src, 'https://x.test/cdn/auto2.pdf');
    const last = sent()[sent().length - 1];
    eq(sent().length - before, 1, '必须真的发出去一条请求');
    eq(last.type, 'kh:ocr:pdf', '★ 走 OCR_PDF（离线引擎读不了 PDF）');
  });

  await test('★ 2026-11-18（m04718）：页面重画换掉控件，按「页地址 + 下标」还能取回地址', () => {
    const D = (typeof document !== 'undefined') ? document : global.document;
    const url = 'https://x.test/cdn/auto3.pdf';
    const first = H.el('span', { 'class': 'content-pdf' }, [H.txt('PDF')]);
    D.body.appendChild(first);
    F.rememberAutoPdf(first, url);
    eq(F.autoPdfOf(first), url, '同一个元素当然取得到');
    first.parentNode.removeChild(first);
    const second = H.el('span', { 'class': 'content-pdf' }, [H.txt('PDF')]);
    D.body.appendChild(second);
    eq(F.autoPdfOf(second), url, '★ 新元素（同页同下标）也要取得到 —— 否则重画一次就得重新点一次');
    second.parentNode.removeChild(second);
  });

  /* 【2.0.15 · 用户 m10932/m10954】PDF 抓取的"地址对不对"是这条链的根：
   * 两个字段抓住同一份 PDF ⇒ 内容相同 ⇒ 面板按"内容一致"合并成「A/B」，其中一个字段被藏起来。
   * 下面三条钉住：①同一地址只能归一个字段；②同一控件换了地址仍要更新；③后台只认本页开出来的标签。 */
  await test('★ 2.0.15：两个字段确实是同一份 PDF ⇒ 都记住（合并成一列是预期，不许拦）', () => {
    const D = (typeof document !== 'undefined') ? document : global.document;
    const url = 'https://x.test/cdn/shared-one.pdf';
    const a = H.el('span', { class: 'content-pdf' }, [H.txt('PDF')]);
    const b = H.el('span', { class: 'content-pdf' }, [H.txt('PDF')]);
    D.body.appendChild(a); D.body.appendChild(b);
    F.rememberAutoPdf(a, url);
    F.rememberAutoPdf(b, url);
    eq(F.autoPdfOf(a), url, '第一个字段拿到地址');
    eq(F.autoPdfOf(b), url, '★ 第二个字段也拿到同一地址（用户 m11077：真一样时合并是预期）');
    eq(b.getAttribute('data-khpdf-dup'), null, '不许给控件打「重复」标记');
    D.body.removeChild(a); D.body.removeChild(b);
  });

  await test('★ 2.0.15：一行两个标题格、PDF 在第三格 ⇒ 行标签取**紧邻**的那个标题（不是最左）', () => {
    const cellA = H.el('td'); cellA.appendChild(H.txt('互联网信息服务算法备案合作证明'));
    const cellB = H.el('td'); cellB.appendChild(H.txt('AI生成应用承诺函'));
    const valueCell = H.el('td');
    const pdf = H.el('span', { class: 'content-pdf' }, [H.txt('PDF')]);
    valueCell.appendChild(pdf);
    const tr = H.el('tr'); tr.appendChild(cellA); tr.appendChild(cellB); tr.appendChild(valueCell);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; }); tr.rowIndex = 0;
    const tbody = H.el('tbody'); tbody.appendChild(tr);
    const table = H.el('table'); table.appendChild(tbody); table.rows = [tr];
    const D = (typeof document !== 'undefined') ? document : global.document;
    D.body.appendChild(table);
    const key = F.autoPdfKeyOf(pdf);
    truthy(/AI生成应用承诺函/.test(key), '★ 键里必须是紧邻控件的标题（AI生成应用承诺函）');
    truthy(!/互联网信息服务算法备案合作证明/.test(key), '不许拿最左那格当这个名字（会把两个字段的地址记混）');
    D.body.removeChild(table);
  });

  await test('★ 2.0.15：同一个控件换了地址，仍然要更新（不是一律拒绝）', () => {
    const D = (typeof document !== 'undefined') ? document : global.document;
    const sp = H.el('span', { class: 'content-pdf' }, [H.txt('PDF')]);
    D.body.appendChild(sp);
    F.rememberAutoPdf(sp, 'https://x.test/cdn/v1.pdf');
    F.rememberAutoPdf(sp, 'https://x.test/cdn/v2.pdf');
    eq(F.autoPdfOf(sp), 'https://x.test/cdn/v2.pdf', '★ 重新抓到的地址要覆盖旧的（字段确实换了 PDF）');
    D.body.removeChild(sp);
  });

  await test('★ 2.0.15：后台只认「本页开出来的」标签（openerTabId 对不上就不认领）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'background', 'service-worker.js'), 'utf8');
    truthy(/function isOurs\(tab\)[\s\S]{0,320}tab\.openerTabId == null \|\| tab\.openerTabId !== tabId/.test(src),
      '认领判据必须比对 openerTabId（用户自己开的标签 openerTabId 为空）');
    truthy(/st\.onCreated = \(tab\) => \{\s*\n\s*if \(st\.done \|\| !isOurs\(tab\)\) return;/.test(src),
      'onCreated 必须先过 isOurs，不再无条件认领第一个新标签');
    truthy(/if \(!st\.createdId\) \{ if \(!isOurs\(tab\)\) return; st\.createdId = id; \}/.test(src),
      'onUpdated 在未认领时也要过 isOurs');
    truthy(/const PDF_GRAB_BY_TAB = new Map\(\)/.test(src), '每页同时只允许一个抓取窗口');
    truthy(/prevTab\.finish\(''\)/.test(src), '★ 同一页开新窗口时要先让上一个收工（否则它抢走新标签）');
    truthy(/st\.click && Date\.now\(\) - st\.armAt > 3000/.test(src), '替用户点的那次只认 3 秒内出现的标签');
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

  await test('★ 抓到的相对地址要绝对化：页面把 assets/x.pdf 交给 window.open 是常态', () => {
    eq(F.absPdfUrl('assets/attachment.pdf'), new URL('assets/attachment.pdf', location.href).href,
      '相对地址必须按当前页解析，否则面板里存的是用不了的短地址');
    eq(F.absPdfUrl('  assets/a.pdf  '), new URL('assets/a.pdf', location.href).href, '两侧空白要剪掉');
    eq(F.absPdfUrl('https://cdn.test/a.pdf'), 'https://cdn.test/a.pdf', '已经是绝对地址就原样留着');
    eq(F.absPdfUrl('javascript:void(0)'), '', '脚本伪地址不许当 PDF 地址');
  });
  /* 等一拍：抓取回填的重算定时器还挂着，别让它落到后面的用例里（会污染调度器断言） */
  await new Promise((r) => setTimeout(r, 250));
  KH.rebuild = savedRebuild;
};
