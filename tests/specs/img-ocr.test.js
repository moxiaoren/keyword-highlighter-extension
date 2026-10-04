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
  const { KH } = require('../bootstrap');
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
};
