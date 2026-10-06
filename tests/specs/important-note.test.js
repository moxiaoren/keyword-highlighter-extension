/* tests/specs/important-note.test.js — 重要笔记：内容分卡 / 标签形态聚合 / 抓取挂载 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const head = KH.ImportantNote.head;

  /** 造一条命中（只看面板消费用到的 meta 字段） */
  function hit(display, label, note, extra) {
    return { id: display + '|' + label, textNode: {}, kind: 'normal',
      meta: Object.assign({ display, label, importantNote: note, important: true }, extra || {}) };
  }

  suite('important-note · 内容分卡（铁律：内容不一致绝不进同一卡）');

  await test('★ 内容不同的两条 → 两张卡', () => {
    const items = head.build([hit('甲', '', '笔记A'), hit('乙', '', '笔记B')], new Set());
    eq(items.length, 2);
  });

  await test('★ 内容相同的两条 → 合成一张卡（标签列举）', () => {
    const items = head.build([hit('甲', '', '同一段笔记'), hit('乙', '', '同一段笔记')], new Set());
    eq(items.length, 1);
    eq(items[0].entries.length, 2);
  });

  await test('完全相同（内容+词+标题）→ 去重不留重复标签', () => {
    const items = head.build([hit('甲', '', '笔记'), hit('甲', '', '笔记')], new Set());
    eq(items.length, 1);
    eq(items[0].entries.length, 1);
  });

  await test('内容为空 → 不占面板', () => {
    eq(head.build([hit('甲', '', '')], new Set()).length, 0);
  });

  await test('被用户关掉的内容（ignored）→ 不再出现', () => {
    eq(head.build([hit('甲', '', '笔记')], new Set(['笔记'])).length, 0);
  });

  suite('important-note · 标签形态聚合（🔖 标题 → 关键词）');

  await test('★ 无标题普通词：多值聚合为 `🔖 a|b`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '' }, { kw: 'b', adj: '' }]);
    truthy(html.indexOf('🔖 a|b') >= 0, html);
  });

  await test('★ 同标题多值 → `🔖 标题 → a|b`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'b', adj: '状态' }]);
    truthy(html.indexOf('🔖 状态') >= 0, html);
    truthy(html.indexOf('→ a|b') >= 0, html);
  });

  await test('★ 多标题同值 → 标题合并 `🔖 标题1|标题2 → a`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'a', adj: '结果' }]);
    truthy(html.indexOf('🔖 状态|结果') >= 0, html);
    truthy(html.indexOf('→ a') >= 0, html);
  });

  await test('★ 各标题单值但值不同 → 逐条平铺不交叉', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'b', adj: '结果' }]);
    truthy(html.indexOf('🔖 状态') >= 0 && html.indexOf('→ a') >= 0, html);
    truthy(html.indexOf('🔖 结果') >= 0 && html.indexOf('→ b') >= 0, html);
    falsy(/状态\|结果/.test(html), '不应把不同标题合并：' + html);
  });

  await test('标签文本被 HTML 转义（防注入）', () => {
    const html = head.tagHtml([{ kw: '<img src=x onerror=1>', adj: '' }]);
    falsy(html.indexOf('<img') >= 0, html);
    truthy(html.indexOf('&lt;img') >= 0);
  });

  suite('important-note · 脏检查（命中未变不重建 DOM）');

  await test('相同集合 → 不脏', () => {
    const a = head.build([hit('甲', '', '笔记')], new Set());
    const b = head.build([hit('甲', '', '笔记')], new Set());
    falsy(head.changed(a, b));
  });

  await test('条目数变化 → 脏', () => {
    const a = head.build([hit('甲', '', '笔记')], new Set());
    const b = head.build([hit('甲', '', '笔记'), hit('乙', '', '笔记')], new Set());
    truthy(head.changed(a, b));
  });

  await test('条目数相同但内容不同 → 脏', () => {
    const a = head.build([hit('甲', '', '笔记A')], new Set());
    const b = head.build([hit('甲', '', '笔记B')], new Set());
    truthy(head.changed(a, b));
  });

  /* 单卡尺寸是**渲染期**写的内联 `--kh-img-size`（renderItems），
   * 所以"只改尺寸、内容没变"必须也算脏，否则卡片尺寸不会刷新（删掉词级尺寸时旧值还会残留） */
  await test('★ 只有 imgSize 变化 → 必须判脏（否则卡片尺寸不刷新）', () => {
    const a = head.build([hit('甲', '', '笔记', { imgSize: '70' })], new Set());
    const b = head.build([hit('甲', '', '笔记', { imgSize: '88' })], new Set());
    truthy(head.changed(a, b), '尺寸变了却不判脏 → 卡片会一直用旧尺寸');
  });

  await test('★ imgSize 从有到无 → 也必须判脏（否则旧内联尺寸会残留）', () => {
    const a = head.build([hit('甲', '', '笔记', { imgSize: '88' })], new Set());
    const b = head.build([hit('甲', '', '笔记')], new Set());
    truthy(head.changed(a, b));
  });

  await test('imgSize 相同 → 不脏（不能因为加了这一项就无谓重建）', () => {
    const a = head.build([hit('甲', '', '笔记', { imgSize: '88' })], new Set());
    const b = head.build([hit('甲', '', '笔记', { imgSize: '88' })], new Set());
    falsy(head.changed(a, b));
  });

  suite('important-note · 展示内容（用**实际命中的文本**，不是配置原文）');

  await test('★ 正则 `a|b` 只命中 `a` → 卡片标签展示 `a`（旧实现展示配置原文 `a|b`）', () => {
    const items = head.build([hit('a|b', '', '笔记', { text: 'a' })], new Set());
    eq(items.length, 1);
    eq(items[0].entries.map(e => e.kw).join(','), 'a', '应展示实际命中的 a，而不是配置原文 a|b');
  });

  await test('★ 罕见字命中 → 展示命中的那个字（不是「罕见字」三个字；稳定版有此能力）', () => {
    const items = head.build([hit('罕见字', '', '笔记', { text: '昉', rareKey: 'hjz#' })], new Set());
    eq(items.length, 1);
    eq(items[0].entries.map(e => e.kw).join(','), '昉');
  });

  await test('命中文本为空（仅抓取）→ 回落到配置展示名，行为不变', () => {
    const items = head.build([hit('应用名称', '', '笔记', { text: '', fetchOnly: true })], new Set());
    eq(items.length, 1);
    eq(items[0].entries.map(e => e.kw).join(','), '应用名称');
  });

  await test('普通词命中文本与配置一致时照旧（不引入无谓变化）', () => {
    const items = head.build([hit('审核不通过', '', '笔记', { text: '审核不通过' })], new Set());
    eq(items[0].entries.map(e => e.kw).join(','), '审核不通过');
  });

  suite('important-note · 抓取内容挂载到卡片');

  await test('★ 抓取表格 HTML 被拼进卡片内容（多行内容随卡片一起展示）', () => {
    const h = hit('应用名称', '', '用户写的笔记', { fetchHtml: '<table class="kh-table"><tr><td>包名</td><td>com.foo</td></tr></table>' });
    const items = head.build([h], new Set());
    eq(items.length, 1);
    truthy(items[0].note.indexOf('用户写的笔记') >= 0);
    truthy(items[0].note.indexOf('<table class="kh-table">') >= 0, '抓取表格应在内容里');
  });

  await test('只有抓取、没有手写笔记 → 也算有内容（占面板）', () => {
    const h = hit('应用名称', '', '', { fetchHtml: '<table class="kh-table"><tr><td>a</td><td>b</td></tr></table>' });
    eq(head.build([h], new Set()).length, 1);
  });

  await test('★ 复用高亮底色：impNoteBg 进卡片，空串则不铺', () => {
    const withBg = head.build([hit('甲', '', '笔记', { impNoteBg: '#112233' })], new Set());
    eq(withBg[0].bg, '#112233');
    const noBg = head.build([hit('甲', '', '笔记')], new Set());
    eq(noBg[0].bg, '');
  });

  await test('图片尺寸随卡片（词 > 分组 > 全局由编译期解决，这里只透传）', () => {
    const items = head.build([hit('甲', '', '笔记', { imgSize: 88 })], new Set());
    eq(items[0].imgSize, 88);
  });

  /* ==========================================================================
   * 🖼 图片分区：「用户手动收起过」的**作用范围**（K80）
   *
   * 缺陷背景（用户 2026-10-06 报的）：原实现只记一个布尔值 `imgUserCollapsed`，而它
   * **谁也不清**（rebuild 不清、destroy 也不清）⇒ 实际是**整页范围的长期记忆**。
   * 用户场景是"提交之后翻到下一页"—— 那是全新场景、新的图，却因为上一页收过一次
   * 而再也不自动展开了。要的是：同一批条目内尊重收起；换代即作废、有命中照常展开。
   * ========================================================================== */

  suite('important-note · 🖼 图片分区：「用户收起过」只在同一批条目内有效（K80）');

  /** 面板是单例字面量：用原型继承造"影子面板"，只改自己的字段，不污染真面板 */
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);

  await test('★ 同一批（异步结果陆续回来）→ 记忆保留，不被自动展开打断', () => {
    const p = shadowPanel();
    p.imgUserCollapsed = true;
    p.imgCollapsedKeys = ['r|a', 'r|b'];
    eq(p.imgSameBatch([{ key: 'r|a' }, { key: 'r|b' }, { key: 'r|c' }]), true, '旧键都在、只多不少 = 同一批');
    eq(p.imgSameBatch([]), true, '重建清底的瞬间（列表暂空）不算换代，记忆要留着');
  });

  await test('★ 条目换代（提交后翻页 / 重新扫描）→ 记忆作废，有命中要重新自动展开', () => {
    const p = shadowPanel();
    p.imgUserCollapsed = true;
    p.imgCollapsedKeys = ['r|a', 'r|b'];
    eq(p.imgSameBatch([{ key: 'r|a' }, { key: 'r|x' }]), false, '有旧键消失 ⇒ 换代');
    eq(p.imgSameBatch([{ key: 'r|x' }, { key: 'r|y' }]), false, '整批换新 ⇒ 换代');
  });

  await test('没收起过 / 没有记忆键 → 都不构成"记住收起"', () => {
    const p = shadowPanel();
    p.imgUserCollapsed = false;
    p.imgCollapsedKeys = ['r|a'];
    eq(p.imgSameBatch([{ key: 'r|a' }]), false, '用户没收起过');
    p.imgUserCollapsed = true;
    p.imgCollapsedKeys = [];
    eq(p.imgSameBatch([{ key: 'r|a' }]), false, '没有记忆键');
  });

  await test('★ 接线契约：换代先作废记忆；收起时连同当时的键一起记（不许退回布尔长期记忆）', () => {
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('if (!this.imgSameBatch(list)) { this.imgUserCollapsed = false; this.imgCollapsedKeys = []; }') >= 0,
      '分区渲染必须先问 imgSameBatch 并作废记忆');
    truthy(src.indexOf('if (this.imgUserCollapsed !== true && list.some(') >= 0,
      '自动展开仍只看"用户有没有对这一批收起过"');
    truthy(/this\.imgCollapsedKeys = this\.imgCollapsed\s*\r?\n\s*\?/.test(src),
      '收起动作要把当时的条目键记下来');
  });

  /* ==========================================================================
   * 【默认只显示命中】（用户 2026-10-06）
   *   用户原话："这个功能的主要目的是命中，未命中的图片其实不需要展示出来
   *   （可以留个渠道，后面人工打开复核）"。
   *   口径：命中常显；**真失败（bad 类）也必须常显**（否则就是 D-14.5 禁止的静默 ——
   *   用户看到空面板以为功能坏了）；其余（未命中 / 排队中 / 没认出文字 / 读不到图…）
   *   进题头上的「显示全部」人工复核视图。状态类只从 KH.OcrCopy.stateClass 取。
   * ========================================================================== */

  suite('important-note · 🖼 图片分区：默认只显示命中，「显示全部」是人工复核入口');

  await test('命中与"真失败"常显；未命中 / 排队中 / 没认出文字 / 读不到图默认不显示', () => {
    const p = shadowPanel();
    const hit = { state: 'done', text: '一对一', matched: [{ text: '一对一' }] };
    const miss = { state: 'done', text: '别的话' };
    const noText = { state: 'done', why: 'no-text' };
    const running = { state: 'pending' };
    const queued = { state: 'idle' };
    const bad = { state: 'fail', error: 'boom' };
    const timeout = { state: 'fail', errorCode: 'timeout' };
    const crossOrigin = { state: 'blocked', why: 'cross-origin', host: 'cdn.example.com' };
    eq(p.imgRowVisible(hit), true, '命中常显（这就是这个功能的目的）');
    eq(p.imgRowVisible(bad), true, '★ 真失败必须露出来：藏起来就是"静默"（D-14.5）');
    eq(p.imgRowVisible(timeout), true, '超时也是真失败（bad 类）');
    eq(p.imgRowVisible(miss), false, '未命中默认不展示（用户明确要求）');
    eq(p.imgRowVisible(noText), false, '「没认出文字」也不占默认版面（进复核视图）');
    eq(p.imgRowVisible(running), false, '识别中/排队中不占默认版面');
    eq(p.imgRowVisible(queued), false, '排队中同样进复核视图');
    eq(p.imgRowVisible(crossOrigin), false, '读不到图（note 类）进复核视图');
  });

  await test('打开「显示全部」后什么条目都显示；关掉又回到只看命中', () => {
    const p = shadowPanel();
    const miss = { state: 'done', text: '别的话' };
    p.imgShowAll = true;
    eq(p.imgRowVisible(miss), true, '复核视图里未命中也要能看到（否则这个渠道是假的）');
    p.imgShowAll = false;
    eq(p.imgRowVisible(miss), false, '关掉后回到只看命中');
  });

  await test('★ 「显示全部」的条数按默认口径数：切到复核视图后按钮还在，点得回去', () => {
    const p = shadowPanel();
    const hit = { state: 'done', text: '一对一', matched: [{ text: '一对一' }] };
    const miss = { state: 'done', text: '别的话' };
    const noText = { state: 'done', why: 'no-text' };
    const bad = { state: 'fail', error: 'boom' };
    const queued = { state: 'idle' };
    const list = [hit, miss, noText, bad, queued];
    eq(p.imgRowHiddenCount(list), 3, '要复核的＝未命中 + 没认出文字 + 排队中（命中 / 真失败不算）');
    p.imgShowAll = true;
    eq(p.imgRowVisible(miss), true, '此刻视图确实是全量（未命中都看得到）');
    eq(p.imgRowHiddenCount(list), 3,
      '★ 切到「显示全部」后条数不变 —— 若拿 list.length - 可见行数 数，这里会变 0，按钮当场消失、只进不出');
    eq(p.imgRowHiddenCount([]), 0, '空列表安全');
  });

  await test('★ 「显示全部」也按批有效：条目换代就回到"只看命中"（不做整页长期记忆）', () => {
    const p = shadowPanel();
    p.imgShowAll = true;
    p.imgShowAllKeys = ['r|a', 'r|b'];
    eq(p.imgShowAllSameBatch([{ key: 'r|a' }, { key: 'r|b' }, { key: 'r|c' }]), true, '旧键都在 = 同一批');
    eq(p.imgShowAllSameBatch([]), true, '重建清底的瞬间不算换代');
    eq(p.imgShowAllSameBatch([{ key: 'r|a' }, { key: 'r|x' }]), false, '有旧键消失 ⇒ 换代');
    p.imgShowAll = false;
    p.imgShowAllKeys = ['r|a'];
    eq(p.imgShowAllSameBatch([{ key: 'r|a' }]), false, '本来就没开"显示全部"');
  });

  await test('★ 还没跑完的条目要"说出来"：计数与空视图都不许在结果回来之前说"没有命中"', () => {
    const p = shadowPanel();
    const running = { state: 'pending' };
    const queued = { state: 'idle' };
    const hit = { state: 'done', text: '一对一', matched: [{ text: '一对一' }] };
    const miss = { state: 'done', text: '别的话' };
    const bad = { state: 'fail', error: 'boom' };
    eq(p.imgBusyCount([running, queued, hit, miss, bad]), 2, '识别中 + 排队中都算"还没跑完"');
    eq(p.imgBusyCount([hit, miss, bad]), 0, '终态不算');
    eq(p.imgBusyCount([]), 0, '空列表安全');
  });

  await test('★ 接线契约：渲染按 imgRowVisible 过滤；题头有「显示全部」；空视图留一行说明', () => {
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('const shown = list.filter((it) => this.imgRowVisible(it));') >= 0,
      '渲染必须按 imgRowVisible 过滤（不能另写一套条件）');
    truthy(src.indexOf("'<span class=\"khin-imgall\" data-act=\"all\" hidden></span>'") >= 0,
      '题头要有「显示全部」这个复核入口（否则默认视图把条目藏了就没地方看）');
    truthy(src.indexOf('this.imgShowAll = !this.imgShowAll;') >= 0, '「显示全部」要能切换');
    truthy(src.indexOf('const hiddenN = this.imgRowHiddenCount(list);') >= 0,
      '★ 「显示全部」的条数要按默认口径数：用 `list.length - shown.length` 在切到复核视图后会变 0 ⇒ 按钮消失、点不回去');
    truthy(src.indexOf("none.className = 'khin-imgnone';") >= 0,
      '默认视图一条都没有时要留说明行，不能悄悄空白');
    truthy(src.indexOf('KH.OcrCopy.render(\n          busyN ? KH.OcrCopy.VIEW.noneHitBusy : KH.OcrCopy.VIEW.noneHit') >= 0 ||
      src.indexOf('busyN ? KH.OcrCopy.VIEW.noneHitBusy : KH.OcrCopy.VIEW.noneHit') >= 0,
      '说明文案走唯一真源 KH.OcrCopy（面板不许自己写中文），且还有在跑的条目时不许说"没有命中"');
    truthy(src.indexOf('const busyN = this.imgBusyCount(list);') >= 0 &&
      src.indexOf('KH.OcrCopy.render(KH.OcrCopy.VIEW.busy, { n: busyN })') >= 0,
      '计数要把"识别中 N"说出来（默认视图把在跑的行藏起来了，不说就等于骗人）');
    const copy = read('src/ui/ocr-copy.js');
    truthy(copy.indexOf('VIEW: VIEW,') >= 0, '展示筛选文案要挂在 KH.OcrCopy.VIEW 上导出');
    truthy(copy.indexOf('showAll:') >= 0 && copy.indexOf('onlyHits:') >= 0 && copy.indexOf('noneHit:') >= 0,
      '三个视图文案都要在真源里（显示全部 / 只看命中 / 没有命中）');
    truthy(copy.indexOf('noneHitBusy:') >= 0 && copy.indexOf('busy:') >= 0,
      '"还在识别中"的两处文案（空视图 / 计数后缀）也要在真源里');
    truthy(copy.indexOf('const VIEW = {') >= 0 && copy.indexOf('const COPY = {') >= 0,
      'VIEW 与 COPY 必须分开：COPY 的键集合要与 img-ocr.js 终态集合完全相等（枚举对账）');
  });

  suite('important-note · 面板紧凑化 + 双滚动（用户 2026-10-07：条目多太占地方、超屏看不到全部）');

  await test('★ 接线契约：OCR 分区不许把笔记列表挤没，自己封顶后交给列表滚', () => {
    const src = read('src/features/important-note.js');
    const imgsec = (src.match(/\.khin-imgsec \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(imgsec.length > 0, '要能定位到 .khin-imgsec 的样式块（否则下面的断言是在空串上跑，等于没测）');
    truthy(/flex: 0 0 auto/.test(imgsec),
      '分区不参与收缩 —— 否则它会把 .khin-body 挤到近零，就是用户说的"两者互相抢占展示"');
    truthy(/min-height: 0/.test(imgsec), 'min-height:0 是 flex 子项能收缩的前提');
    const cap = imgsec.match(/max-height:\s*(\d+)vh/);
    truthy(cap, '分区要封顶（vh）：不然它顶破面板后会被 .khin-panel 的 overflow:hidden 裁掉，连滚动条都看不见');
    truthy(cap && Number(cap[1]) <= 60, '封顶不超过 60vh，笔记列表至少留 40vh');
    const list = (src.match(/\.khin-imglist \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/flex: 1 1 auto/.test(list) && /min-height: 0/.test(list),
      '列表要能在分区内收缩（flex:1 1 auto + min-height:0），否则出不了滚动条');
    truthy(/overflow-y: auto/.test(list), '列表自己要能滚 —— 这是"超过浏览器高度看不到全部"的解药');
    const body = (src.match(/\.khin-body \{[^}]*\}/) || [''])[0];
    truthy(/overflow-y: auto/.test(body), '笔记列表也要能滚（上下两个滚动区各管自己）');
    const panel = (src.match(/\.khin-panel \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/max-height:\s*calc\(100vh/.test(panel), '面板总高仍受视口限制（这是滚动能成立的前提）');
    truthy(/flex-direction: column/.test(panel), '面板仍是纵向 flex：header / 列表 / 分区三段');
  });

  await test('★ 接线契约：字号走紧凑档（正文 12px / 行距 1.45 / 缩略图 ≤ 48px）', () => {
    const src = read('src/features/important-note.js');
    const note = (src.match(/\.khin-item-note \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/font-size: 12px/.test(note) && /line-height: 1\.45/.test(note),
      '正文 12px / 1.45（用户 2026-10-07：条目一多就太占地方）');
    const thumb = (src.match(/\.khin-imgthumb \{[\s\S]*?\n    \}/) || [''])[0];
    const side = thumb.match(/width:\s*(\d+)px/);
    truthy(side && Number(side[1]) <= 48, 'OCR 缩略图不超过 48px —— 9 张图的场景里它是主要高度来源');
  });
};
