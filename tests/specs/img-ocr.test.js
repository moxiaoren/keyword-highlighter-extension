/* tests/specs/img-ocr.test.js — 图片命中：**读不出地址的图也必须留在表里并带上原因**（K62 / v1.99.99.32）
 * ----------------------------------------------------------------------------
 * 用户现场：「图片识别: 条目=0 缓存=0 排队=0 在途=0」—— 抓取字段能把图片显示出来，OCR 却毫无反应。
 * 根因（真浏览器探针 `_e2e/probe-ocr-diag2.js` 复现）：
 *   `classify()` 的失败分支**不返回 src**，而 `build()` 里有一句 `if (!src) continue` ——
 *   于是「跨域未授权 / 懒加载还没加载 / 协议不认识」这些图**整条被丢掉**：
 *   面板里什么都不显示、诊断里 `条目=0`，用户完全看不出发生了什么。
 * 这里锁住修复后的口径：失败也要有 src（或退化成序号键），条目必须在、原因必须如实。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/** 造一个假 <img>（垫片元素 + 只读属性；`visibleEnough` 在垫片里因为没有 getBoundingClientRect 会放行） */
function fakeImg(attrs) {
  const img = H.el('img');
  for (const k of Object.keys(attrs || {})) img.setAttribute(k, attrs[k]);
  return img;
}

/**
 * 造装置：[应用截图 | 值格(imgs)] 一行两列的真表格 + 图片识别锚点。
 *
 * 【为什么必须是"带抓取字段的表"】用户确认的新口径：图片命中 = 「抓取后续字段」的一个分支 ——
 * 取图范围**以抓取字段的值格为准**（`KH.Fetch.cellsForHit`），锚点只用来定位表/行。
 * 所以装置里必须有 `应用截图` 标签格，它的右邻格才是被识别的值格。
 */
function anchorWith(imgs, metaExtra) {
  const valueCell = H.el('td');
  for (const im of imgs) valueCell.appendChild(im);
  const labelCell = H.el('td');
  labelCell.appendChild(H.txt('应用截图'));
  const tr = H.el('tr');
  tr.appendChild(labelCell); tr.appendChild(valueCell);
  tr.cells = tr.children;
  tr.cells.forEach((td, i) => { td.cellIndex = i; });
  tr.rowIndex = 0;
  const tbody = H.el('tbody'); tbody.appendChild(tr);
  const table = H.el('table'); table.appendChild(tbody);
  table.rows = [tr];                        // collectRightBlock 等要用（垫片不自动建）
  const rule = {
    ruleId: 'kOcrUnit', pattern: /华为/g, labelPattern: /供应商/g, flags: {}, labelFlags: {},
    meta: Object.assign({
      imgOcr: true, imgOcrMax: 4, display: '华为', label: '供应商',
      fetchLabels: '应用截图', imgOcrKeyword: '华为'
    }, metaExtra || {})
  };
  return { rule: rule, anchorCell: labelCell, valueCells: [valueCell], table: table, labelCell: labelCell, valueCell: valueCell };
}

/** 造一行 [标签 | 若干格] 的真表格（单行），并补上垫片缺失的表格访问器 */
function rowTable(cells) {
  const tr = H.el('tr');
  for (const c of cells) tr.appendChild(c);
  tr.cells = tr.children;
  tr.cells.forEach((td, i) => { td.cellIndex = i; });
  tr.rowIndex = 0;
  const tbody = H.el('tbody'); tbody.appendChild(tr);
  const table = H.el('table'); table.appendChild(tbody);
  table.rows = [tr];
  return table;
}

const cellOf = (text) => { const td = H.el('td'); if (text) td.appendChild(H.txt(text)); return td; };

/**
 * 【K75】锚点**只来自真命中** ⇒ 单测也必须从"命中"进（不再能把锚点塞进 `ctx.imgAnchors`）。
 * 装置的 `anchorCell` 是标签格（`应用截图`），所以取它里面的文本节点当"命中文本节点"：
 * `cellOfHit` 会解析成那一格，`Fetch.cellsForHit(那一格, meta)` 照旧按抓取字段取值格。
 */
function hitOf(a) {
  const cell = a.anchorCell || a.cell;
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

module.exports = async function run() {
  const { KH, driveOcrResults } = require('../bootstrap');
  const O = KH.ImgOcr;

  suite('图片命中：读不出地址的图不许被静默丢掉（K62）');

  await test('★ 懒加载图（只有 data-src）→ classify 必须带上地址与原因 lazy', () => {
    const r = O.classify(fakeImg({ 'data-src': 'https://cdn.test/a.png' }), {});
    eq(r.ok, false, '懒加载图还没加载 → 不能当成"可识别"');
    eq(r.why, 'lazy', '原因必须是 lazy（面板要照原样说给用户看）');
    eq(r.src, 'https://cdn.test/a.png', '**必须把地址带出来** —— 否则 build 里那句 `if (!src) continue` 会把整条丢掉');
  });

  await test('★ 连地址都没有的图 → 也要留在表里（用序号键兜底），原因 no-src', () => {
    const anchors = [anchorWith([fakeImg({})])];
    O.build({}, {}, anchors.map(hitOf));
    const items = O.items();
    eq(items.length, 1, '没有地址的图也必须登记成条目（否则用户看到的是"条目=0、什么都没发生"）');
    eq(items[0].state, 'blocked', '状态应为 blocked');
    eq(items[0].why, 'no-src', '原因应为 no-src');
  });

  await test('★ 懒加载图 → 条目在、状态 blocked、原因 lazy（不再表现为"条目=0"）', () => {
    const anchors = [anchorWith([fakeImg({ 'data-src': 'https://cdn.test/lazy1.png' })])];
    O.build({}, {}, anchors.map(hitOf));
    const items = O.items();
    eq(items.length, 1, '懒加载图必须登记成条目');
    eq(items[0].state, 'blocked');
    eq(items[0].why, 'lazy');
    eq(items[0].src, 'https://cdn.test/lazy1.png', '条目要带着它的地址（加载完成后就能直接识别）');
  });

  await test('★ 两张不同的懒加载图 → 两条条目（序号键不许互相顶掉）', () => {
    const anchors = [anchorWith([
      fakeImg({ 'data-src': 'https://cdn.test/a.png' }),
      fakeImg({ 'data-src': 'https://cdn.test/b.png' })
    ])];
    O.build({}, {}, anchors.map(hitOf));
    eq(O.items().length, 2, '两张不同的图应是两条（键 = ruleId|地址）');
  });

  await test('★ 没开「识别图片文字」的规则：不采集（口径不变）', () => {
    const a = anchorWith([fakeImg({ 'data-src': 'https://cdn.test/c.png' })]);
    a.rule.meta.imgOcr = false;
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 0, '没开这个开关的规则不该产生任何图片条目');
  });

  await test('★ 诊断要能说出"未识别的原因分布"（条目=0 与"全是跨域未授权"是两回事）', () => {
    const anchors = [anchorWith([fakeImg({ 'data-src': 'https://cdn.test/d.png' })])];
    O.build({}, {}, anchors.map(hitOf));
    const d = O._debug();
    truthy(d.blocked && typeof d.blocked === 'object', '诊断必须带 blocked 原因分布');
    eq(d.blocked.lazy, 1, '原因分布要如实计数（实测 lazy=1）');
  });

  /* ------------------------------------------------------------------
   * K63：授权了却依然提示未授权 —— 授权白名单必须**当前站点与图片域名都认**
   * （垫片的 location.hostname = example.com，见 tests/harness.js）
   * ------------------------------------------------------------------ */

  await test('★ 授权「图片所在域名」→ 必须放行（用户最自然的做法）', () => {
    const cfg = { imgOcr: { crossOriginSites: { 'cdn.other.test': true } } };
    const r = O.classify(fakeImg({ src: 'https://cdn.other.test/a.png' }), cfg);
    eq(r.ok, true, '把图片所在域名加进白名单后必须能识别（旧实现只比当前站点 → 授权了也不生效）');
    eq(r.src, 'https://cdn.other.test/a.png');
  });

  await test('★ 授权「当前站点」→ 照旧放行（旧口径保持兼容）', () => {
    const cfg = { imgOcr: { crossOriginSites: { 'example.com': true } } };
    eq(O.classify(fakeImg({ src: 'https://cdn.other.test/a.png' }), cfg).ok, true,
      '授权当前站点时，该页面上的跨域图都放行');
  });

  await test('★ 白名单写法很随意也要能匹配（带协议 / 带路径 / 带端口 / 大小写）', () => {
    const cases = ['https://cdn.other.test', 'https://cdn.other.test/x.png', 'CDN.OTHER.TEST', 'cdn.other.test:443'];
    for (const key of cases) {
      const cfg = { imgOcr: { crossOriginSites: { [key]: true } } };
      eq(O.classify(fakeImg({ src: 'https://cdn.other.test/a.png' }), cfg).ok, true, '这种写法应能匹配：' + key);
    }
  });

  await test('★ 未授权时：条目带原因和**图片域名**（面板/诊断要能直接说清加哪个域名）', () => {
    O.build({}, {}, [hitOf(anchorWith([fakeImg({ src: 'https://cdn.other.test/z.png' })]))]);
    const items = O.items();
    eq(items.length, 1, '未授权的图也要留条目');
    eq(items[0].why, 'cross-origin');
    eq(items[0].host, 'cdn.other.test', '必须带上图片所在域名');
    eq(O._debug().blocked['cross-origin:cdn.other.test'], 1, '诊断的原因分布要带域名（照着填就能授权）');
  });

  /* ------------------------------------------------------------------
   * K68：容器把图压得很小 ≠ 图不可见 —— 判"值不值得识别"要看**原图像素**
   * ------------------------------------------------------------------ */

  await test('★ 容器把图压成 8×8、但原图 1000×600 → 必须照样识别（不再判"不可见"）', () => {
    /* 用 data: 图避开跨域分支（本组只验"原图 vs 容器尺寸"这条判据） */
    const img = fakeImg({ src: 'data:image/png;base64,iVBORw0KGgo=' });
    img.naturalWidth = 1000;
    img.naturalHeight = 600;
    img.getBoundingClientRect = () => ({ width: 8, height: 8 });     // CSS 压得很小
    const r = O.classify(img, {});
    eq(r.ok, true, 'data: 图本就可识别');
    O.build({}, {}, [hitOf(anchorWith([img]))]);
    const items = O.items();
    eq(items.length, 1, '必须留下条目');
    eq(items[0].state !== 'blocked', true, '**不许**判成 blocked（旧实现会判 invisible 并跳过识别）');
  });

  await test('★ 原图本身就极小（10×10）且确实渲染着 → blocked 且原因 too-small（不是"不可见"）', () => {
    const img = fakeImg({ src: 'data:image/png;base64,iVBORw0KGgo=' });
    img.naturalWidth = 10;
    img.naturalHeight = 10;
    img.getBoundingClientRect = () => ({ width: 40, height: 40 });
    O.build({}, {}, [hitOf(anchorWith([img]))]);
    const items = O.items();
    eq(items.length, 1);
    eq(items[0].state, 'blocked', '原图太小 → 不该送进引擎');
    eq(items[0].why, 'too-small', '原因必须是 too-small（"不可见"会误导用户）');
  });

  await test('★ 真的没渲染（无布局盒 0×0 且原图也小）→ blocked 且原因 invisible', () => {
    const img = fakeImg({ src: 'data:image/png;base64,iVBORw0KGgo=' });
    img.naturalWidth = 12;
    img.naturalHeight = 12;
    img.getBoundingClientRect = () => ({ width: 0, height: 0 });
    O.build({}, {}, [hitOf(anchorWith([img]))]);
    eq(O.items()[0].why, 'invisible', '真的没渲染才报"不可见"');
  });

  /* ==================================================================
   * 图片命中 = 「抓取后续字段」的一个分支（用户确认的新口径）
   *   · 取图范围：抓取字段的**值格**（`@表达式` 指哪一格就是哪一格），不管有没有 `#图` 修饰；
   *   · 匹配口径：「图片命中关键词」当**正则**（不全词、不区分大小写），**不回落**核心词；
   *   · 触发：谁命中就用谁所在行 —— 普通词也能用（不再限于组合词）；
   *   · 准入：没配抓取字段 / 没勾选 / 没有命中 → 一条都不产生。
   * ================================================================== */

  suite('图片命中 · 匹配口径（imgOcrKeyword 正则 / 不全词 / 不区分大小写）');

  await test('★ 当作**正则**：`A.C` 命中 `AxC`，不命中 `AC`（点号不是字面点）', () => {
    const rule = { meta: { imgOcrKeyword: 'A.C' } };
    truthy(O.matchedInText(rule, '前缀 AxC 后缀').length, '正则应命中 AxC');
    eq(O.matchedInText(rule, '前缀 AC 后缀').length, 0, '`.` 必须按正则语义（AC 不该命中）');
  });

  await test('★ **不区分大小写**：`abc` 命中 `ABC`', () => {
    truthy(O.matchedInText({ meta: { imgOcrKeyword: 'abc' } }, '编号 ABC123').length);
  });

  await test('★ **不要求整词**：`abc` 在 `xabcx` 里照样命中（wholeWord:false）', () => {
    truthy(O.matchedInText({ meta: { imgOcrKeyword: 'abc' } }, 'xabcx').length);
  });

  await test('★ **不回落**成规则核心词：关键词是 `一对一` 时，图里的 `华为` 不算命中', () => {
    const rule = { pattern: /华为/g, flags: {}, meta: { imgOcrKeyword: '一对一' } };
    eq(O.matchedInText(rule, '华为技术有限公司').length, 0, '留了图片命中关键词就不许再按核心词匹配');
    truthy(O.matchedInText(rule, '一对一安心对话').length);
  });

  await test('非法正则 → 不抛异常、不命中（与内核口径一致：编译失败即跳过）', () => {
    eq(O.matchedInText({ meta: { imgOcrKeyword: '(' } }, '随便什么文本').length, 0);
  });

  /* ==================================================================
   * 空白容忍（2.0.2.4 需求③）
   *   用户现场：OCR 结果里是「登记 号」，图片命中词是「登记号」⇒ 不算命中。
   *   口径：**原样匹配不中时，再按"剔掉空白"的文本判一次**；命中片段必须映射回**原文**
   *   （`OcrCopy.sentenceOf(text, needle)` 是在原文里 `indexOf`，给剔空白的版本就定位不到整句）。
   * ================================================================== */
  suite('图片命中 · 空白容忍（OCR 行里的空格不得挡住命中 · 2.0.2.4 需求③）');

  await test('★ 图里是「登记 号」、命中词是「登记号」→ 照样命中，片段与区间都映射回原文', () => {
    const m = O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '京A 登记 号 12345');
    eq(m.length, 1, '剔空白后应命中一次');
    eq(m[0].text, '登记 号', '片段必须是**原文**里那一段（复制整句靠它在原文里 indexOf）');
    eq(m[0].start, 3, '区间起点映射回原文（京A␣＝0..2）');
    eq(m[0].end, 7, '区间终点映射回原文（登记␣号＝3..6）');
  });

  await test('★ 反向也成立：命中词自带空白（用户手打「登 记号」）→ 按剔空白比对', () => {
    truthy(O.matchedInText({ meta: { imgOcrKeyword: '登 记号' } }, '京A登记号12345').length);
  });

  await test('★ 原文里本来就有空格也要认：命中词「登记号」直接命中「登记 号」（跳一次空白）', () => {
    const m = O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '前缀\n登记 号 后缀');
    eq(m.length, 1);
    eq(m[0].text, '登记 号');
  });

  await test('★ 无空白的原路径行为不变（区间仍是原文下标，不做任何额外处理）', () => {
    const m = O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '京A登记号12345');
    eq(m.length, 1);
    eq(m[0].text, '登记号');
    eq(m[0].start, 2);
    eq(m[0].end, 5);
  });

  await test('★ 空白容忍不许改成"整段剔空白再比"：跨过被空格分开的两个词仍算一次命中', () => {
    /* 原文「登记 号」剔空白＝「登记号」＝命中词 ⇒ 一次；原文里两个邻居词不许被拼成假命中 */
    const m = O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '登记 号码');
    eq(m.length, 1);
    eq(m[0].text, '登记 号', '只认到「登记 号」，不许把「码」也吞进来');
  });

  await test('★ 跨行不算命中（票 #34）：剔的只是**行内**空白，换行不许被拼成一个词', () => {
    eq(O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '前缀\n登记\n号 后缀').length, 0,
      '版面换行不是"被 OCR 读散的空格"：上下两行拼出来的词不算命中');
    truthy(O.matchedInText({ meta: { imgOcrKeyword: '登记号' } }, '前缀\n登记 号 后缀').length,
      '同一行里的空格仍要容忍（回归）');
  });

  suite('图片命中 · 准入条件（无抓取字段 / 未勾选 / 无命中 → 不产生条目）');

  await test('★ 没配「抓取后续字段」→ 不产生任何条目（即使勾了识别）', () => {
    const a = anchorWith([fakeImg({ 'data-src': 'https://cdn.test/x.png' })], { fetchLabels: '' });
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 0, '抓取字段是取图的前提：没配就无从取图');
  });

  await test('★ 「图片命中关键词」为空 → 不产生条目（不再回落核心词）', () => {
    const a = anchorWith([fakeImg({ 'data-src': 'https://cdn.test/x.png' })], { imgOcrKeyword: '' });
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 0);
  });

  await test('★ 未勾选「识别图片文字」→ 不产生条目', () => {
    const a = anchorWith([fakeImg({ 'data-src': 'https://cdn.test/x.png' })], { imgOcr: false });
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 0);
  });

  await test('★ 没有命中 → 不产生条目（**即使 ctx 里塞了旧口径的 `imgAnchors` 也不认**）', () => {
    /* K75 的靶心：旧口径下"组合词标题词定位到格就登记锚点"，于是没命中也在跑 OCR。
     * 现在锚点只来自真命中 ⇒ 这条 ctx 里带锚点也必须产出 0 条。 */
    const a = anchorWith([fakeImg({ 'data-src': 'https://cdn.test/must-ignore.png' })]);
    O.build({}, { imgAnchors: [a] }, []);
    eq(O.items().length, 0, '★ ctx.imgAnchors 不再是锚点来源 —— 没命中就没有任何图片条目');
    O.build({}, {}, []);
    eq(O.items().length, 0, '没有命中也没有锚点 → 照样 0 条');
  });

  await test('★ 命中是**普通词**（无组合词锚点）→ 同样按命中所在行的抓取字段取图', () => {
    /* 装置：一行「应用类型 | 交友」（`交友` 是普通词命中），另一行「应用截图 | 图」
     * —— 取图范围只看抓取字段，与命中词本身所在的那一格无关。 */
    const kwCell = cellOf('交友');
    const img = fakeImg({ 'data-src': 'https://cdn.test/plain.png' });
    const table = H.el('table');
    const tb1 = H.el('tbody');
    const tr1 = H.el('tr');
    const l1 = cellOf('应用类型'); tr1.appendChild(l1); tr1.appendChild(kwCell);
    const tr2 = H.el('tr');
    const l2 = cellOf('应用截图'); const v2 = H.el('td'); v2.appendChild(img);
    tr2.appendChild(l2); tr2.appendChild(v2);
    tb1.appendChild(tr1); tb1.appendChild(tr2);
    /* 两张表在同一容器里也要能找到？不需要：同表即可（`nearestTable` 从命中格往上找） */
    table.appendChild(tb1);
    tr1.cells = tr1.children; tr1.cells.forEach((td, i) => { td.cellIndex = i; });
    tr2.cells = tr2.children; tr2.cells.forEach((td, i) => { td.cellIndex = i; });
    table.rows = [tr1, tr2];

    const hit = { ruleId: 'kPlain', textNode: kwCell.childNodes[0], meta: {
      imgOcr: true, imgOcrMax: 4, fetchLabels: '应用截图', imgOcrKeyword: '一对一', display: '交友'
    } };
    O.build({}, {}, [hit]);
    const items = O.items();
    eq(items.length, 1, '普通词命中也要触发图片识别（不再限组合词）');
    eq(items[0].ruleId, 'kPlain');
    eq(items[0].keyword, '一对一', '面板行的关键词标签显示「图片命中关键词」');
    eq(items[0].label, '应用截图', '条目要标明图来自哪个抓取字段');
    eq(items[0].src, 'https://cdn.test/plain.png', '取的就是抓取字段值格里的那张图');
  });

  suite('图片命中 · 取图范围（抓取字段的值格 / @表达式 / 上限）');

  await test('★ K75：锚点 = **命中所在格** —— 取图只看命中那张表，页面里别的表的图不许被取', () => {
    /* 用户口径："判断命中了普通词/组合词没有。如果是，就看抓取字段的内容是否有图片…"
     * 命中驱动 ⇒ 锚点必须是命中的位置。这里放两张表：命中在表 A，表 A 与表 B 各有一张图。 */
    const mkTable = (rows) => {
      const t = H.el('table');
      const tb = H.el('tbody');
      const trs = rows.map((cells) => {
        const tr = H.el('tr');
        for (const c of cells) tr.appendChild(c);
        tr.cells = tr.children;
        tr.cells.forEach((td, i) => { td.cellIndex = i; });
        tb.appendChild(tr);
        return tr;
      });
      t.appendChild(tb);
      t.rows = trs;
      return t;
    };
    const imgA = fakeImg({ 'data-src': 'https://cdn.test/in-A.png' });
    const imgB = fakeImg({ 'data-src': 'https://cdn.test/in-B.png' });
    const hitCell = cellOf('交友');
    const vA = H.el('td'); vA.appendChild(imgA);
    const tableA = mkTable([[hitCell, cellOf('无关')], [cellOf('应用截图'), vA]]);
    const vB = H.el('td'); vB.appendChild(imgB);
    const tableB = mkTable([[cellOf('应用截图'), vB]]);
    const root = H.el('div');
    root.appendChild(tableA); root.appendChild(tableB);

    O.build({}, {}, [{ ruleId: 'kOwn', textNode: hitCell.childNodes[0], meta: {
      imgOcr: true, imgOcrMax: 4, fetchLabels: '应用截图', imgOcrKeyword: '一对一', display: '交友'
    } }]);
    const items = O.items();
    eq(items.length, 1, '只应有命中那张表里的 1 张图，实际 ' + JSON.stringify(items.map((i) => i.src)));
    eq(items[0].src, 'https://cdn.test/in-A.png', '★ 取的必须是**命中所在表**（表 A）里的图');
  });

  await test('★ `@1-3`：多格图片**按序全取**（视觉列顺序）', () => {
    const a3 = fakeImg({ 'data-src': 'https://cdn.test/a.png' });
    const b3 = fakeImg({ 'data-src': 'https://cdn.test/b.png' });
    const c3 = fakeImg({ 'data-src': 'https://cdn.test/c.png' });
    const t = rowTable([cellOf('应用截图'), (() => { const td = H.el('td'); td.appendChild(a3); return td; })(),
      (() => { const td = H.el('td'); td.appendChild(b3); return td; })(),
      (() => { const td = H.el('td'); td.appendChild(c3); return td; })()]);
    const anchor = { rule: { ruleId: 'kRange', meta: { imgOcr: true, imgOcrMax: 9, fetchLabels: '应用截图@1-3', imgOcrKeyword: 'x' } },
      anchorCell: t.rows[0].children[0] };
    O.build({}, {}, [hitOf(anchor)]);
    const items = O.items();
    eq(items.length, 3, '三格的图都要取到（不管字段有没有 #图 修饰）');
    eq(items.map((i) => i.src).join(','), 'https://cdn.test/a.png,https://cdn.test/b.png,https://cdn.test/c.png',
      '必须按视觉列顺序');
  });

  await test('★ `#图@2`（修饰与偏移顺序无关）→ 值格是右边第 2 格', () => {
    const first = fakeImg({ 'data-src': 'https://cdn.test/first.png' });
    const second = fakeImg({ 'data-src': 'https://cdn.test/second.png' });
    const t = rowTable([cellOf('应用截图'),
      (() => { const td = H.el('td'); td.appendChild(first); return td; })(),
      (() => { const td = H.el('td'); td.appendChild(second); return td; })()]);
    const anchor = { rule: { ruleId: 'kOrder', meta: { imgOcr: true, imgOcrMax: 9, fetchLabels: '应用截图#图@2', imgOcrKeyword: 'x' } },
      anchorCell: t.rows[0].children[0] };
    O.build({}, {}, [hitOf(anchor)]);
    eq(O.items().length, 1);
    eq(O.items()[0].src, 'https://cdn.test/second.png', '`#图` 与 `@2` 的先后顺序不影响结果');
  });

  await test('★ `imgOcrMax`：每处最多几张（与既有语义一致，按锚点累计）', () => {
    const mk = (n) => fakeImg({ 'data-src': 'https://cdn.test/' + n + '.png' });
    const t = rowTable([cellOf('应用截图'), (() => { const td = H.el('td'); td.appendChild(mk(1)); return td; })(),
      (() => { const td = H.el('td'); td.appendChild(mk(2)); return td; })(),
      (() => { const td = H.el('td'); td.appendChild(mk(3)); return td; })()]);
    const anchor = { rule: { ruleId: 'kMax', meta: { imgOcr: true, imgOcrMax: 2, fetchLabels: '应用截图@1-3', imgOcrKeyword: 'x' } },
      anchorCell: t.rows[0].children[0] };
    O.build({}, {}, [hitOf(anchor)]);
    eq(O.items().length, 2, '每处最多 2 张（上限沿用既有语义）');
  });

  /* ------------------------------------------------------------------
   * 【2.0.2.5 需求①】配额只管「要识别的图」，识别不了的图不许吃额度
   * ------------------------------------------------------------------
   * 用户现场：关键词 `a`；抓取字段 `包名|截图#图|资质类型@1|icon`；图片命中关键词 `一对一`
   *   ⇒「图片 OCR 不会拉起执行」。多字段时**每个值格都可能有图**，#图 那个字段的图常排在后面。
   * 根因：`collectImages` 第一句 `if (out.length >= max) return out;` 在 `classify` **之前** ——
   *   跨域未授权 / 懒加载 / 原图太小这些**根本识别不了**的图也计入配额，
   *   前面的 logo/icon 把额度吃光，真正的截图**连条目都没建**（自然永不提交）。
   * 口径：`imgOcrMax` 只数「可识别」的图；识别不了的图仍留原因条目（面板要如实说明），
   *   但**不再终止扫描**，且自己另受同一个 max 限流（一个格子里几十张懒加载图不许刷屏）。
   */
  const mkRow = (label, children) => {
    const tr = H.el('tr');
    tr.appendChild(cellOf(label));
    for (const c of children) tr.appendChild(c);
    tr.cells = tr.children;
    tr.cells.forEach((td, i) => { td.cellIndex = i; });
    tr.rowIndex = 0;
    return tr;
  };
  const td = (child) => { const c = H.el('td'); if (child) c.appendChild(child); return c; };
  /** 多行真表格：每行 [标签 | 值格…]，最后一行的值格是「命中」所在格（照用户页面的版式） */
  const wideTable = (rows) => {
    const tbody = H.el('tbody');
    const trs = rows.map((r) => { const tr = mkRow(r[0], r[1]); tbody.appendChild(tr); return tr; });
    const table = H.el('table'); table.appendChild(tbody);
    trs.forEach((tr, i) => { tr.rowIndex = i; });
    table.rows = trs;
    return { table: table, hitCell: trs[trs.length - 1].children[1] };
  };
  const okImg = (src) => { const im = fakeImg({ src: src }); im.naturalWidth = 100; im.naturalHeight = 100; return im; };
  const lazyImg = (src) => fakeImg({ 'data-src': src });

  await test('★ 需求①：前一个字段是跨域图（识别不了）、后一个字段才是截图 ⇒ 截图必须拿到名额并发出去', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = (global.__OCR_SENT__ || []).length;
    const w = wideTable([
      ['包名', [td(fakeImg({ src: 'https://cdn.other.test/logo.png' }))]],
      ['截图', [td(okImg('data:image/png;base64,iVBORw0KGgoNEED1'))]],
      ['应用名', [td(H.txt('关键词a'))]]
    ]);
    const meta = { imgOcr: true, imgOcrMax: 1, fetchLabels: '包名|截图#图', imgOcrKeyword: '一对一', display: '关键词a' };
    O.build({}, {}, [{ ruleId: 'kQuota1', meta: meta, textNode: w.hitCell.childNodes[0] }]);
    const items = O.items();
    eq(items.length, 2, '坏图仍留一条原因条目、好图另有一条（坏图不再吃掉名额）');
    eq(items[0].state, 'blocked', '第一张跨域未授权 ⇒ blocked（面板要说明原因）');
    eq(items[0].why, 'cross-origin');
    const good = items[1];
    eq(good.src, 'data:image/png;base64,iVBORw0KGgoNEED1', '**排在后面的截图必须进表**（修前它连条目都没有）');
    truthy(good.state === 'pending' || good.state === 'done', '能被识别的图必须真的提交（用户报的就是"不会拉起执行"）');
    eq((global.__OCR_SENT__ || []).length - before, 1, '★ 跨域图在前也照样发出 1 次识别请求');
  });

  await test('★ 需求①：前面三张懒加载图 + 后面一张截图，imgOcrMax=1 ⇒ 两者各自受 1 条限流', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const w = wideTable([
      ['包名', [td(lazyImg('https://cdn.test/l1.png')), td(lazyImg('https://cdn.test/l2.png')), td(lazyImg('https://cdn.test/l3.png'))]],
      ['截图', [td(okImg('data:image/png;base64,iVBORw0KGgoNEED2'))]],
      ['应用名', [td(H.txt('关键词a'))]]
    ]);
    const meta = { imgOcr: true, imgOcrMax: 1, fetchLabels: '包名@1-3|截图#图', imgOcrKeyword: '一对一', display: '关键词a' };
    O.build({}, {}, [{ ruleId: 'kQuota2', meta: meta, textNode: w.hitCell.childNodes[0] }]);
    const items = O.items();
    eq(items.filter((it) => it.state === 'blocked').length, 1,
      '识别不了的图自己也最多留 `max` 条原因条目（否则一个格子几十张懒加载图会把面板刷满）');
    eq(items.filter((it) => it.src === 'data:image/png;base64,iVBORw0KGgoNEED2').length, 1, '截图照旧拿到名额');
  });

  await test('★ 需求①（字段级开关）：`字段#0` 的值格图既不识别、也不带进抓取内容', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const w = wideTable([
      ['包名', [td(lazyImg('https://cdn.test/icon.png'))]],
      ['截图', [td(okImg('data:image/png;base64,iVBORw0KGgoNEED3'))]],
      ['应用名', [td(H.txt('关键词a'))]]
    ]);
    const meta = { imgOcr: true, imgOcrMax: 4, fetchLabels: '包名#0|截图', imgOcrKeyword: '一对一', display: '关键词a' };
    const fields = KH.Fetch.cellsForHit(w.hitCell, meta);
    eq(fields.map((f) => f.label).join(','), '包名,截图');
    eq(!!fields[0].noImg, true, '`#0` 必须解析成 noImg（字段级开关的唯一真源）');
    eq(fields[1].noImg, false, '没写 `#0` 的字段照旧参与图片识别');
    O.build({}, {}, [{ ruleId: 'kQuota3', meta: meta, textNode: w.hitCell.childNodes[0] }]);
    eq(O.items().length, 1, '`#0` 字段的图根本不进表');
    eq(O.items()[0].src, 'data:image/png;base64,iVBORw0KGgoNEED3', '只剩截图那张（用户要的就是这个）');
  });

  /* ------------------------------------------------------------------
   * 同页图超过并发上限：额度一归还就必须**补发**队列里剩下的
   * ------------------------------------------------------------------
   * 现场（用户手动测试套件里撞到的）：一页 9 张图（每行一张）⇒ 只有前几张出结果，
   * 其余一直写「前面的图识别完就轮到它（同时最多 4 张在跑）」，实测 +30s / +90s 都没动。
   * 根因：`submit()` 满额直接返回 false，而**归还额度的四个出口只看账、不看队列**。
   * 这条用例走真机同一条链：发请求 → 回执带 requestId → 结果经 onMessage 回来 → 归还额度 → 补发
   * （装置见 tests/bootstrap.js 的 sendMessage / onMessage 与 driveOcrResults）。
   */
  await test('★ 同页 9 张图：并发上限（4）之外的必须被补发（旧实现只跑前 4 张）', () => {
    /* 先清掉前面用例留在途的额度（走**真实销毁路径**：`KH.features.get('img-ocr').clear`，
     * 与 `src/core/rebuilder.js:111` 同签名）——否则它们占着 4 个位置，本用例一张也发不出去 */
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = (global.__OCR_SENT__ || []).length;
    const hits = [];
    for (let i = 0; i < 9; i++) {
      /* 原图得有尺寸，否则 pixelVerdict 判 too-small、条目直接 blocked（那是另一条用例的事） */
      const im = fakeImg({ src: 'data:image/png;base64,iVBORw0KGgo' + i });
      im.naturalWidth = 100; im.naturalHeight = 100;
      hits.push(hitOf(anchorWith([im])));
    }
    O.build({}, {}, hits);
    eq(O.items().length, 9, '9 张图应当有 9 条条目');
    eq((global.__OCR_SENT__ || []).length - before, 4,
      '同一时刻只发 4 张（MAX_INFLIGHT 仍然生效 —— 修的是"补发"，不是把上限调大）');
    eq(O.items().filter((it) => it.state === 'idle').length, 5, '先有 5 张排在队里');
    driveOcrResults(null, before);
    eq(O.items().filter((it) => it.state === 'done').length, 9,
      '★ 9 张都要落地：额度一归还就得接着发（否则面板永久停在「排队中…」）');
  });

  /* ------------------------------------------------------------------
   * K80：耗时徽标必须跟着缓存走（页面一重建就从缓存重造条目 ⇒ 徽标不许丢）
   * ------------------------------------------------------------------
   * 真机现场（F1「识别在飞时给重建让路」上线后的全量 E2E）：
   *   `✗ ② 图片命中进「🖼 图片命中」分区` —— `每个图片条目都该显示本次识别耗时；实际条目：[{"cost":""}]`
   * 根因：`build()` 命中缓存时只恢复 `state/text/conf/matched`，`ocrMs` 没进缓存 ⇒
   *   任何页面变动导致的重建都会把「这次识别耗时」整列抹空（让路只是把这个潜伏缺陷推到常见时序上）。
   * 这里锁住口径：缓存里存 `ocrMs`，重建后的条目照旧能出 0.8s 这种真实数字。
   */
  await test('★ 页面重建（缓存命中）后耗时徽标必须还在：`ocrMs` 跟着缓存走', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = (global.__OCR_SENT__ || []).length;
    const im = fakeImg({ src: 'data:image/png;base64,iVBORw0KGgoK80' });
    im.naturalWidth = 100; im.naturalHeight = 100;
    const a = anchorWith([im]);
    O.build({}, {}, [hitOf(a)]);
    eq(O.items().length, 1, '先有一张可识别的图');
    driveOcrResults(() => ({ ocrMs: 812 }), before);
    eq(O.items()[0].state, 'done', '回执到手 ⇒ 条目完成');
    eq(O.items()[0].ocrMs, 812, '回执里的耗时落在条目上');

    const sentAfterFirst = (global.__OCR_SENT__ || []).length;
    O.build({}, {}, [hitOf(a)]);            // 页面变了 ⇒ 条目表整体重造（走缓存分支）
    eq(O.items().length, 1);
    eq(O.items()[0].state, 'done', '缓存命中 ⇒ 重建后直接是完成态，不重新排队');
    eq((global.__OCR_SENT__ || []).length, sentAfterFirst, '缓存命中不该再发一次请求（验的是缓存，不是重跑）');
    eq(O.items()[0].ocrMs, 812, '★ 重建后耗时徽标必须还在（丢了就说明缓存没带上 ocrMs）');
  });

  /* ------------------------------------------------------------------
   * T55：同一张图被**两条规则**抓到时只许识别一次
   * ------------------------------------------------------------------
   * 现场（用户报）：两个关键词都开了「识别图片文字」、抓的是同一个字段 ⇒ 同一张图各建一条条目
   * （键 = `ruleId|src`）。识别是按**图片**算的，旧实现却按条目算：排队循环逐条 `submit()`，
   * 而 `submit()` 顶部只看额度、不看"这张图已经在飞" ⇒ 一张图发两次（4 张图 = 8 次识别）。
   * 口径：提交按 `src` 去重；结果 / 超时 / 同步失败都扇给同 `src` 的每条；两条的匹配文本
   * 各按自己的规则算、面板行数照旧（**禁**"合并成一行"）。
   */
  const srcImg = (src) => { const im = fakeImg({ src: src }); im.naturalWidth = 100; im.naturalHeight = 100; return im; };
  const asRule = (a, id) => { a.rule.ruleId = id; return a; };

  await test('★ 同一张图两条规则：只发 1 次请求，回执回来两条都落地（各按自己的规则匹配）', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = (global.__OCR_SENT__ || []).length;
    const src = 'data:image/png;base64,iVBORw0KGgoT55a';
    const a1 = anchorWith([srcImg(src)]);
    const a2 = asRule(anchorWith([srcImg(src)]), 'kOcrUnitB');
    O.build({}, {}, [hitOf(a1), hitOf(a2)]);
    eq(O.items().length, 2, '两条规则各一条条目（面板行数照旧，不许合并成一行）');
    eq((global.__OCR_SENT__ || []).length - before, 1,
      '★ 同一张图只发一次（旧实现两条各发一次 ⇒ 2 次：识别按图片算，不按条目算）');
    driveOcrResults(null, before);
    const items = O.items();
    eq(items.filter((it) => it.state === 'done').length, 2,
      '★ 回执要把同 src 的孪生条目一起落地（旧实现只更新提交的那条，另一条永远停在「识别中」）');
    eq(items[0].matched.length, 1, '第一条按自己的规则算出匹配文本');
    eq(items[1].matched.length, 1, '第二条也按自己的规则算出匹配文本');
  });

  await test('★ 4 张图 × 2 条规则 = 8 条条目 ⇒ 只发 4 次（去重不许越过 MAX_INFLIGHT）', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    const before = (global.__OCR_SENT__ || []).length;
    const hits = [];
    for (let i = 0; i < 4; i++) {
      const src = 'data:image/png;base64,iVBORw0KGgoT55b' + i;
      hits.push(hitOf(anchorWith([srcImg(src)])));
      hits.push(hitOf(asRule(anchorWith([srcImg(src)]), 'kOcrUnitB' + i)));
    }
    O.build({}, {}, hits);
    eq(O.items().length, 8, '4 张图 × 2 规则 = 8 条条目');
    eq((global.__OCR_SENT__ || []).length - before, 4,
      '首批只发 4 次（满额就停 —— 上限仍然生效）');
    truthy(O.inflightCount() <= 4, '并发上限仍受 MAX_INFLIGHT 约束（不许靠去重绕过）');
    driveOcrResults(null, before);
    eq((global.__OCR_SENT__ || []).length - before, 4,
      '★ 全页 4 张图总共只发 4 次（旧实现：首批 4 张各发一次，额度归还后又把孪生条目各补发一次 ⇒ 8 次）');
    eq(O.items().filter((it) => it.state === 'done').length, 8, '4 张图的结果把 8 条全部落地');
  });

  /* ------------------------------------------------------------------
   * 右键任意图 OCR（2.0.1.17 · SPEC 需求 6 / SECURITY.md 附录 B）：结果进图片模块
   * ------------------------------------------------------------------
   * 口径：右键识别的结果**不是**扫描链的产物（没有规则、没有命中、没有关键词），
   * 但它必须变成图片模块里看得见的一行 —— 否则用户右键半天，面板上什么都没发生。
   * 三条硬要求：① 用户手动要的那一行不受"默认只显示命中"约束；② 同一张图重复右键不堆行；
   * ③ 失败也建行（有状态类可判），不得静默。另加一条：页面重建不许把它冲掉。
   */
  suite('右键任意图 OCR：结果进图片模块（2.0.1.17）');

  await test('★ 右键识别的回执 ⇒ 当场建条目并常显（面板默认视图必须露出来）', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    O._onResult({
      requestId: 'imgCtx-1', ok: true, via: 'contextMenu', src: 'https://cdn.example.com/a.png',
      text: '华为技术有限公司', confidence: 97, ocrMs: 1200
    });
    const items = O.items();
    eq(items.length, 1, '右键识别的结果要变成一条条目（否则用户什么都看不到）');
    const it = items[0];
    eq(it.via, 'contextMenu', '条目要记住它是右键来的（面板与文案都靠它）');
    eq(it.src, 'https://cdn.example.com/a.png', '缩略图要有地址');
    eq(it.state, 'done');
    eq(it.text, '华为技术有限公司', '识别全文要落进条目（灯箱/悬停读的就是它）');
    eq(it.ocrMs, 1200, '耗时徽标照旧');
    /* 2.0.2.15：条目不再有「图片命中」分区那一行，唯一可见面是主模块那张「截图」卡 */
    const shown = KH.ImportantNote.panel.ctxItems().filter((x) => x.via === 'contextMenu');
    eq(shown.length, 1, '右键识别的条目必须进「截图」卡（否则用户什么都看不到）');
    eq(shown[0].text, '华为技术有限公司', '卡片上挂的就是这条识别全文');
    /* 用例隔离：右键条目按设计会**跨 build 存活**（下一个用例正是钉这件事），
     * 所以在用例末尾按真实销毁路径清掉，免得影响别的 spec。 */
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
  });

  await test('★ 同一张图再右键一次：只一行、取最新结果；失败也建行且判成 bad（不静默）', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    O._onResult({ requestId: 'imgCtx-2', ok: true, via: 'contextMenu', src: 'https://cdn.example.com/dup.png', text: '甲', confidence: 90, ocrMs: 10 });
    O._onResult({ requestId: 'imgCtx-3', ok: true, via: 'contextMenu', src: 'https://cdn.example.com/dup.png', text: '乙', confidence: 91, ocrMs: 11 });
    const dup = O.items().filter((it) => it.src.indexOf('/dup.png') > 0);
    eq(dup.length, 1, '同一张图重复右键 = 同一行（按 src 去重，不许堆行）');
    eq(dup[0].text, '乙', '后一次结果覆盖前一次（用户刚右键的就是它）');

    O._onResult({ requestId: 'imgCtx-4', ok: false, via: 'contextMenu', code: 'engine-unavailable', error: '识别引擎不可用', src: 'https://cdn.example.com/bad.png' });
    const bad = O.items().filter((it) => it.src.indexOf('/bad.png') > 0)[0];
    truthy(bad, '失败也要建行（SPEC 需求 6：识别服务不可用时必须如实告知，不得静默）');
    eq(bad.state, 'fail');
    eq(bad.errorCode, 'engine-unavailable', '失败原因要留在条目上（卡片据此显示「识别失败」）');
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
  });

  await test('★ 页面重建（下一次扫描）不许把右键识别的条目冲掉', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    O._onResult({ requestId: 'imgCtx-5', ok: true, via: 'contextMenu', src: 'https://cdn.example.com/keep.png', text: '保留', confidence: 88, ocrMs: 5 });
    O.build({}, {}, []);                       /* 下一次页面扫描：这次一个图片命中都没有 */
    const kept = O.items().filter((it) => it.via === 'contextMenu');
    eq(kept.length, 1, '★ 扫描链重建（build）不许把右键识别的条目冲掉（它不属于任何规则）');
    eq(kept[0].text, '保留', '重建后内容照旧');
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
  });

  /* ==========================================================================
   * 关掉右键那张「截图」卡（2.0.2.16 需求⑦）
   * ==========================================================================
   * 用户原话（m01585-7）："要支持关闭（视为之前添加的图片 OCR 都取消）"。
   * 口径：只作废**手动条目**，不清文字缓存 —— 关掉的是"这张卡"，不是"忘掉识别结果"。
   */
  suite('右键「截图」卡可关闭（2.0.2.16 需求⑦）');

  await test('★ clearManual：右键条目整批消失，文字缓存照旧留着', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    O._onResult({ requestId: 'imgCtx-9', ok: true, via: 'contextMenu', src: 'https://cdn.example.com/close.png', text: '关闭前', confidence: 90, ocrMs: 12 });
    eq(O.items().filter((it) => it.via === 'contextMenu').length, 1, '先有一条');
    const cachedBefore = O._debug().cache;
    truthy(cachedBefore >= 1, '识别结果进了文字缓存');
    eq(typeof O.clearManual, 'function', '面板点 ✕ 靠这个入口（不许面板自己改内部表）');
    O.clearManual();
    eq(O.items().filter((it) => it.via === 'contextMenu').length, 0, '★ 关掉 = 这批手动条目整批作废');
    eq(O._debug().cache, cachedBefore, '★ 缓存不许跟着清（同一张图再右键不该重跑引擎）');
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
  });

  await test('没有手动条目时点关闭：什么都不做、不抛', () => {
    KH.features.get('img-ocr').clear(null, { reason: 'destroy' });
    O.clearManual();
    eq(O.items().filter((it) => it.via === 'contextMenu').length, 0);
  });
};
