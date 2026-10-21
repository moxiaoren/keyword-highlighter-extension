/* ============================================================================
 * tests/specs/pdf-text.test.js · PDF 文本抽取（offscreen/pdf-text.js）的 9 条硬形态
 * ----------------------------------------------------------------------------
 * 为什么要在单测里**现场造 PDF 字节**：
 *   仓库里没有、也不该有 PDF 夹具（真 PDF 动辄几十 KB 且带二进制），而这条链的
 *   每个失败点都藏在字节层（流长度、ToUnicode 码长、对象流偏移）。
 *   用 zlib.deflateSync 现造最小 PDF，能让「哪一条形态坏了」一眼定位到用例名，
 *   而不是拿一份真 PDF 比对"抽出来好像少了几个字"。
 *
 * 覆盖的九条（与交付口径一一对应）：
 *   ① 未压缩最小 PDF  ② FlateDecode 流  ③ TJ 数组 + 词间距  ④ T* 换行
 *   ⑤ ToUnicode bfchar（中文）  ⑥ ToUnicode bfrange（含进位）
 *   ⑦ 对象流 ObjStm 里的字体字典  ⑧ 非 PDF 字节的降级  ⑨ 多页
 *
 * 注意：模块是**纯脚本**（IIFE + 挂 globalThis），不能 require ——
 * 用 new Function 把它执行进一个沙盒对象，再从沙盒取 KHPdfText（同 ocr-long-image 的 loadOffscreen 思路）。
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;

const MODULE_PATH = path.join(__dirname, '..', '..', 'offscreen', 'pdf-text.js');

/** 把纯脚本执行进沙盒，返回它的命名空间（不污染 Node 全局，spec 之间也不会互相覆盖）。 */
function loadModule() {
  const sandbox = {};
  const code = fs.readFileSync(MODULE_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'self', code)(sandbox, sandbox);
  truthy(sandbox.KHPdfText, 'offscreen/pdf-text.js 必须挂上 KHPdfText 命名空间');
  eq(typeof sandbox.KHPdfText.extractText, 'function', 'extractText 必须是函数');
  /* 不再断言 `version`：版本唯一真源是 `manifest.json`，模块里写死一个版本号会被
   * `scripts/meta-check.js` 判红（「出现版本号字面量」），单测跟着断就变成了双源。 */
  return sandbox.KHPdfText;
}

/* ---------------------------------------------------------------- 现场造 PDF */

const ascii = (s) => Buffer.from(s, 'latin1');

/** objects: [{num, body: string|Buffer}] → 一份能被子扫描器认出的最小 PDF。
 *  故意**不写 xref 表**：被测模块按 `N G obj` 扫对象，不读 xref；写成真 xref
 *  只会让夹具更难读，且会把"xref 偏移写错"这种与抽取无关的失败带进来。 */
function buildPdf(objects) {
  const chunks = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  for (const o of objects) {
    chunks.push(ascii(o.num + ' 0 obj\n'));
    chunks.push(typeof o.body === 'string' ? ascii(o.body) : o.body);
    chunks.push(ascii('\nendobj\n'));
  }
  chunks.push(ascii('trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n'));
  return Buffer.concat(chunks);
}

/** 一条流对象：`<< dict /Filter /FlateDecode /Length N >> stream ... endstream`。
 *  /Length 必须是**压缩后**的字节数（写错会被解析器按"找 endstream"兜底，测不出真实行为）。 */
function streamObj(dictBody, data, opts) {
  const o = opts || {};
  const raw = Buffer.isBuffer(data) ? data : ascii(data);
  const flate = o.flate !== false;
  const bytes = flate ? zlib.deflateSync(raw) : raw;
  return Buffer.concat([
    ascii('<< ' + dictBody + (flate ? ' /Filter /FlateDecode' : '') + ' /Length ' + bytes.length + ' >>\nstream\n'),
    bytes,
    ascii('\nendstream')
  ]);
}

/** 单页书的骨架：1 Catalog / 2 Pages / 3 Page / 4 Font / 5 Contents，extra 追加编号对象。 */
function onePage(content, fontObj, extra) {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>' },
    { num: 4, body: fontObj },
    { num: 5, body: content }
  ].concat(extra || []));
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const SIMSUN = '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 6 0 R >>';

/** 中文 CMap：三字一组，`<0001..0003>` 分别是 中 图 馆。 */
const CMAP_BFCHAR = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin begincmap',
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
  '/CMapName /Adobe-Identity-UCS def',
  '/CMapType 2 def',
  '1 begincodespacerange <0000> <FFFF> endcodespacerange',
  '3 beginbfchar',
  '<0001> <4E2D>',
  '<0002> <56FE>',
  '<0003> <9986>',
  'endbfchar',
  'endcmap CMapName currentdict /CMap defineresource pop end end'
].join('\n');

module.exports = async function run() {
  const PT = loadModule();
  const extract = (buf) => PT.extractText(buf);

  suite('PDF 文本抽取：九条形态');

  /* ① 未压缩的最小 PDF：字体没有 ToUnicode，只有 ASCII —— 必须原样出字 */
  await test('① 未压缩最小 PDF（WinAnsiEncoding，无 ToUnicode）⇒ Hello World', async () => {
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET', { flate: false }),
      HELVETICA
    ));
    deepEq(r.lines, ['Hello World'], 'lines 必须正好一条');
    eq(r.text, 'Hello World');
    eq(r.pages, 1, '应解析到 1 页');
    eq(r.fonts, 1, '应解析到 1 个字体');
    eq(r.mapped, 0, '没有 ToUnicode ⇒ mapped 必须是 0');
    truthy(r.warnings.length > 0, '没有 ToUnicode 必须给出降级说明（不许静默）');
    truthy(r.warnings.some(w => w.indexOf('ToUnicode') >= 0), 'warning 要指名 ToUnicode');
  });

  /* ② 同内容压进 FlateDecode 流：结果必须逐字相同（解压链的唯一证据） */
  await test('② FlateDecode 压缩的内容流 ⇒ 结果与未压缩一致', async () => {
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET'),
      HELVETICA
    ));
    deepEq(r.lines, ['Hello World'], '解压后必须和未压缩那版一模一样');
    eq(r.text, 'Hello World');
  });

  /* ③ TJ 数组：≤ -100 的数字是词间距 ⇒ 补空格，不能粘成 HelloWorld */
  await test('③ TJ 数组 + 词间距（-100）⇒ 同一行 Hello World', async () => {
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td [(Hello) -100 (World)] TJ ET'),
      HELVETICA
    ));
    deepEq(r.lines, ['Hello World'], 'TJ 里的 -100 必须补成一个空格');
  });

  /* ④ T* 换行：必须切成两行（行切分是后续关键词判定的最小单位） */
  await test('④ T* 换行 ⇒ lines 至少两行且各自完整', async () => {
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 14 TL 72 720 Td (Line one) Tj T* (Line two) Tj ET'),
      HELVETICA
    ));
    truthy(r.lines.length >= 2, 'T* 必须切出新行，实际 ' + JSON.stringify(r.lines));
    eq(r.lines[0], 'Line one');
    eq(r.lines[1], 'Line two');
    eq(r.text, 'Line one\nLine two', 'text 是 lines 用 \\n 拼的');
  });

  /* ⑤ 中文 bfchar：Identity-H 双字节 + ToUnicode 单码映射 */
  await test('⑤ ToUnicode bfchar ⇒ 中图馆（逐码映射）', async () => {
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td <000100020003> Tj ET'),
      SIMSUN,
      [{ num: 6, body: streamObj('', CMAP_BFCHAR) }]
    ));
    deepEq(r.lines, ['中图馆'], '十六进制串必须按 CMap 逐码解出来');
    eq(r.mapped, 1, '有 ToUnicode ⇒ mapped 记 1');
    eq(r.fonts, 1);
    falsy(r.text.indexOf('\uFFFD') >= 0, '不许出现替换字符（那是编码猜测失败的痕迹）');
  });

  /* ⑥ 中文 bfrange：连续码位递增；顺带钉住"跨字节进位"（4EFF → 4F00） */
  await test('⑥ ToUnicode bfrange ⇒ 码位递增，且 4EFF→4F00 能进位', async () => {
    const cmap = [
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfrange',                        /* 入口数写在 beginbfrange 前，两条区间共用一次 endbfrange */
      '<0001> <0003> <4E2D>',
      '<0004> <0005> <4EFF>',
      'endbfrange',
      'endcmap'
    ].join('\n');
    const r = await extract(onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td <00010002000300040005> Tj ET'),
      SIMSUN,
      [{ num: 6, body: streamObj('', cmap) }]
    ));
    eq(r.lines.length, 1, '一条 Tj ⇒ 一行');
    const s = r.lines[0];
    eq(s.length, 5, '五个码位必须先解出五个字符，实际 ' + JSON.stringify(s));
    eq(s.charCodeAt(0), 0x4E2D);
    eq(s.charCodeAt(1), 0x4E2E);
    eq(s.charCodeAt(2), 0x4E2F);
    eq(s.charCodeAt(3), 0x4EFF);
    /* 4EFF + 1 必须进位成 4F00；只加低字节的实现会得到 4E00（错但很像），单看字形发现不了 */
    eq(s.charCodeAt(4), 0x4F00, 'bfrange 递增必须按大端整数进位，不能只加低字节');
  });

  /* ⑦ 对象流：字体字典藏在 /Type /ObjStm 里 —— 现代生成器的默认写法，不认它就整页丢字 */
  await test('⑦ 字体字典藏在 ObjStm ⇒ 仍能抽出中文', async () => {
    const fontDict = '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 6 0 R >>';
    const header = '4 0';                      // N=1，唯一一对：对象号 4、偏移 0
    const objstmPayload = Buffer.concat([ascii(header), ascii('\n'), ascii(fontDict)]);
    const doc = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>' },
      { num: 5, body: streamObj('', 'BT /F1 12 Tf 72 720 Td <000100020003> Tj ET') },
      { num: 6, body: streamObj('', CMAP_BFCHAR) },
      /* First = 头部长度（'4 0' 三字节）；4 号对象**只**存在于这条流里，没有同名间接对象 */
      { num: 7, body: streamObj('/Type /ObjStm /N 1 /First ' + header.length, objstmPayload) }
    ]);
    const r = await extract(doc);
    deepEq(r.lines, ['中图馆'], 'ObjStm 里的字体字典必须被展开并参与解码');
    eq(r.mapped, 1);
    truthy(r.warnings.some(w => w.indexOf('ObjStm') >= 0), '展开过对象流要留一条说明');
  });

  /* ⑧ 降级：非 PDF 字节 / 空输入 / 垃圾输入 —— 永不抛，永远给结构完整的空结果 */
  await test('⑧ 非 PDF 字节 ⇒ 不抛异常、lines 为空、warnings 非空', async () => {
    const r = await extract(new Uint8Array([1, 2, 3]));
    deepEq(r.lines, []);
    eq(r.text, '');
    eq(r.pages, 0);
    eq(r.fonts, 0);
    eq(r.mapped, 0);
    truthy(r.warnings.length > 0, '必须给出人话的降级说明');
    truthy(r.warnings[0].indexOf('不是 PDF') >= 0, '警告要说明"不是 PDF"，实际：' + r.warnings[0]);
  });

  await test('⑧b 空输入 / null / 假 PDF 头 ⇒ 仍然不抛', async () => {
    for (const bad of [new Uint8Array(0), null, undefined, 'not bytes']) {
      const r = await extract(bad);
      deepEq(r.lines, [], '输入 ' + String(bad) + ' 必须得到空 lines');
      truthy(r.warnings.length > 0, '输入 ' + String(bad) + ' 必须有 warning');
    }
    /* 有 %PDF 头但内部全坏：扫描不到对象，也只能是空结果 + warning，不许抛 */
    const junk = Buffer.concat([ascii('%PDF-1.4\n'), ascii('<<<< /Type /Page nonsense >>>>\n')]);
    const r = await extract(junk);
    deepEq(r.lines, []);
    truthy(r.warnings.length > 0);
  });

  /* ⑨ 多页：两页各自 /Contents，页数与两页文字都要在 */
  await test('⑨ 两页 ⇒ pages=2，两页文字都在且顺序不乱', async () => {
    const r = await extract(buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>' },
      { num: 4, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>' },
      { num: 5, body: streamObj('', 'BT /F1 12 Tf 72 720 Td (Page One) Tj ET') },
      { num: 6, body: streamObj('', 'BT /F1 12 Tf 72 720 Td (Page Two) Tj ET') },
      { num: 7, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ]));
    eq(r.pages, 2, '两页必须都认出来（/Type /Pages 不算页）');
    deepEq(r.lines, ['Page One', 'Page Two'], '两页文字按页序进 lines');
  });

  /* 附带：输入形态（ArrayBuffer 与 Uint8Array 等价）+ 只出现一次的字体不重复计数 */
  await test('⑩ 入参 ArrayBuffer 与 Uint8Array 等价；共享字体只计一次', async () => {
    const doc = onePage(
      streamObj('', 'BT /F1 12 Tf 72 720 Td (Same Bytes) Tj ET', { flate: false }),
      HELVETICA
    );
    const asBuf = doc.buffer.slice(doc.byteOffset, doc.byteOffset + doc.byteLength);
    const a = await extract(asBuf);
    const b = await extract(new Uint8Array(doc));
    deepEq(a.lines, b.lines, '两种入参必须抽出同样的行');
    eq(a.pages, b.pages);
    eq(a.fonts, 1, '同一个字体对象跨页共享时只计一次');
  });
};
