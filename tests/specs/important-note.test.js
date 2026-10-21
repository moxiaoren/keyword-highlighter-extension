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

  /** 面板是单例字面量：用原型继承造"影子面板"，只改自己的字段，不污染真面板 */
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);

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

  suite('important-note · 多命中只展最短一条 + 计数小标 + 下拉（2.0.1.15 需求 1）');

  /* ★ 原「标签形态聚合」四条的老意图全部保留，只是**断言方向反了**：
   * 旧行为把同卡多命中平铺/合并（`🔖 a|b`、`🔖 标题1|标题2 → a`）会撑爆 200px 面板；
   * 新行为一律只展**最短的一条** + 右侧计数小标，具体名字去下拉里看。
   * 所以「含有聚合串」改成「不再含有聚合串」，并补上「出小标 + 小标报数」。 */

  await test('★ 无标题多值：只展最短一条，不再平铺 `🔖 a|b`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '' }, { kw: 'b', adj: '' }]);
    truthy(html.indexOf('🔖 a') >= 0, html);
    falsy(html.indexOf('a|b') >= 0, '多值不许再平铺：' + html);
    truthy(html.indexOf('data-kh-tag-more') >= 0, '命中 2 个要出计数小标：' + html);
    truthy(html.indexOf('>2</button>') >= 0, '小标要报命中数：' + html);
  });

  await test('★ 同标题多值 → 只展最短那条 `🔖 标题 → kw`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'b', adj: '状态' }]);
    truthy(html.indexOf('🔖 状态') >= 0, html);
    truthy(html.indexOf('→ a') >= 0, html);
    falsy(html.indexOf('→ a|b') >= 0, html);
    truthy(html.indexOf('>2</button>') >= 0, html);
  });

  await test('★ 多标题同值 → 标题不再合并 `🔖 标题1|标题2`', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'a', adj: '结果' }]);
    truthy(html.indexOf('🔖 状态') >= 0 && html.indexOf('→ a') >= 0, html);
    falsy(html.indexOf('🔖 状态|结果') >= 0, '标题不许再合并：' + html);
    truthy(html.indexOf('>2</button>') >= 0, html);
  });

  await test('★ 各标题单值但值不同 → 只展最短那条，不再逐条平铺', () => {
    const html = head.tagHtml([{ kw: 'a', adj: '状态' }, { kw: 'b', adj: '结果' }]);
    truthy(html.indexOf('🔖 状态') >= 0 && html.indexOf('→ a') >= 0, html);
    falsy(html.indexOf('🔖 结果') >= 0, '第 2 条不许再平铺到卡上：' + html);
    falsy(html.indexOf('→ b') >= 0, html);
    falsy(/状态\|结果/.test(html), '不应把不同标题合并：' + html);
    truthy(html.indexOf('>2</button>') >= 0, html);
  });

  await test('单条命中：逐字钉死形态，且不出小标', () => {
    eq(head.tagHtml([{ kw: 'a', adj: '' }]), '<span class="khin-item-kw">🔖 a</span>');
    eq(head.tagHtml([{ kw: 'a', adj: '状态' }]),
       '<span class="khin-item-kw">🔖 状态</span><span class="khin-item-adj">→ a</span>');
  });

  await test('★「最短」按码点数算：代理对不许用 String.length 误算', () => {
    // 😀 码点数 1、ab 码点数 2 ⇒ 展 😀。若误用 String.length，😀 也是 2 ⇒ 并列取文档序首个 ab，本断言必红。
    const html = head.tagHtml([{ kw: 'ab', adj: '' }, { kw: '😀', adj: '' }]);
    truthy(html.indexOf('🔖 😀') >= 0, '😀 码点数 1 最小，应展它：' + html);
    falsy(html.indexOf('🔖 ab') >= 0, html);
  });

  await test('★ 并列最短取文档序第一个（不排序、不随机）：连调两次结果相同', () => {
    const es = [{ kw: 'ab', adj: '甲' }, { kw: 'cd', adj: '乙' }, { kw: 'ef', adj: '丙' }];
    const a = head.tagHtml(es);
    const b = head.tagHtml(es);
    eq(a, b, '同一输入必须得到同一结果（可复现、可测，不许随机挑）；a=' + a + ' b=' + b);
    truthy(a.indexOf('🔖 甲') >= 0, '三条并列最长 2，取文档序第一个：' + a);
    // 入参顺序反过来就该跟着反 —— 证明跟的是文档序，不是"哪个词看着好"
    const r = head.tagHtml([{ kw: 'cd', adj: '乙' }, { kw: 'ab', adj: '甲' }]);
    truthy(r.indexOf('🔖 乙') >= 0, '并列时跟着文档序走：' + r);
  });

  await test('★ 命中数 ≤1：不显示小标、不可展开', () => {
    eq(head.tagHtml([]), '');
    eq(head.tagHtml(null), '');
    falsy(head.tagHtml([{ kw: 'a', adj: '' }]).indexOf('data-kh-tag-more') >= 0);
  });

  await test('★ 空文本命中（全空白）既不参与"最短"、也不计入命中数', () => {
    eq(head.tagHtml([{ kw: 'a', adj: '' }, { kw: '   ', adj: '' }]),
       '<span class="khin-item-kw">🔖 a</span>');
  });

  await test('★ 下拉内容：头行报总数、条目逐字完整，超过 20 条只渲染 20 条（不截断数据）', () => {
    const many = [];
    for (let i = 0; i < 5; i++) many.push({ kw: '命中' + i, adj: '' });
    many.push({ kw: '长'.repeat(40), adj: '' });
    const html = head.tagListHtml(many);
    truthy(html.indexOf('共 6 条') >= 0, html);
    truthy(html.indexOf('长'.repeat(40)) >= 0, '长文本必须逐字完整（超出只许 CSS 省略号）：' + html);
    eq((html.match(/class="khin-tag-item"/g) || []).length, 6);
    eq(head.tagListHtml([]), '');

    const over = [];
    for (let i = 0; i < 25; i++) over.push({ kw: 'k' + i, adj: '' });
    const h2 = head.tagListHtml(over);
    truthy(h2.indexOf('共 25 条') >= 0, '头行报的是真实总数（不许被 20 条截断）：' + h2);
    eq((h2.match(/class="khin-tag-item"/g) || []).length, 20, '最多渲染 20 条');
  });

  await test('标签文本被 HTML 转义（防注入）', () => {
    const html = head.tagHtml([{ kw: '<img src=x onerror=1>', adj: '' }]);
    falsy(html.indexOf('<img') >= 0, html);
    truthy(html.indexOf('&lt;img') >= 0);
  });

  await test('★ 命中文本绝不进 HTML 属性（escText 放行引号 ⇒ 属性就是新增注入面）', () => {
    // 下拉：命中只落文本节点，连 title 都不出（完整文本走 DOM 层 el.title）
    const list = head.tagListHtml([{ kw: '<b>x</b>" onmouseover="alert(1)', adj: '' }]);
    falsy(list.indexOf('<b>') >= 0, '尖括号要转义：' + list);
    truthy(list.indexOf('&lt;b&gt;') >= 0, list);
    falsy(/\stitle=/.test(list), '下拉里不许出现 title 属性：' + list);
    // 小标：字符串层只有骨架 + 计数，悬停说明在 DOM 层挂（下面那条契约用例钉它）
    const badge = head.tagHtml([{ kw: 'a', adj: '' }, { kw: 'b', adj: '' }]);
    falsy(/\stitle=/.test(badge), '小标串里不许带属性文案：' + badge);
    truthy(badge.indexOf('data-kh-tag-more') >= 0, badge);
  });

  await test('★ 文案真源：小标悬停说明 / 下拉头行都从 KH.OcrCopy.VIEW 取，面板不写死中文', () => {
    const src = read('src/features/important-note.js');
    const copy = read('src/ui/ocr-copy.js');
    truthy(/moreHits:\s*'点开看全部 \{n\} 个命中'/.test(copy), '文案真源要落在 ocr-copy.js 的 VIEW 表里');
    truthy(/hitsTotal:\s*'共 \{n\} 条'/.test(copy), copy.slice(0, 40));
    truthy(src.indexOf('KH.OcrCopy.VIEW.moreHits') >= 0 && src.indexOf('KH.OcrCopy.VIEW.hitsTotal') >= 0,
      '面板只许引用 VIEW，不许自己写这两句');
    falsy(/点开看全部|共 \{n\} 条/.test(src), '面板里不许出现这两句字面量（写死就是各写一套）：');
    truthy(src.indexOf('more.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.moreHits') >= 0,
      '悬停说明要在 renderTags 的 DOM 层挂（字符串层不带 title 属性）');
  });

  await test('★ 契约：展开/收起就地重画标签区（不走 refresh/render ⇒ head.changed 不脏也能更新）', () => {
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('this.renderTags(tagsEl, item);') >= 0, '唯一注入点要改成就地重画');
    falsy(src.indexOf('tagsEl.innerHTML = head.tagHtml(item.entries);') >= 0, '旧的一行注入必须消失');
    const fn = src.slice(src.indexOf('renderTags(tagsEl, item) {'), src.indexOf('renderItems() {'));
    truthy(fn.length > 0, '要能定位 renderTags 函数体（否则下面的断言是在空串上跑）');
    falsy(/this\.(refresh|render)\(/.test(fn), 'head.changed 在 entries 未变时判不脏 ⇒ 不许走 refresh()/render()');
    // 展开态必须挂面板侧：head 每次重建会把状态清掉
    truthy(/expandedTags: new Set\(\)/.test(src) && /pickedTags: new Map\(\)/.test(src),
      '展开态 / 选中态要挂在 panel 上');
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

  /* 2.0.2.2 需求 2：词级**正文字号**与尺寸同构——也是渲染期内联 `--kh-note-fs`，
   * 判脏口径必须一模一样（漏了就会出现"改了字号卡片不变、删掉字号旧字一直残留"） */
  await test('★ 只有 noteFontSize 变化 → 必须判脏（否则该词字号不刷新）', () => {
    const a = head.build([hit('甲', '', '笔记', { noteFontSize: '14' })], new Set());
    const b = head.build([hit('甲', '', '笔记', { noteFontSize: '18' })], new Set());
    truthy(head.changed(a, b), '字号变了却不判脏 → 卡片会一直用旧字号');
  });

  await test('★ noteFontSize 从有到无 → 也必须判脏（否则旧内联字号会残留）', () => {
    const a = head.build([hit('甲', '', '笔记', { noteFontSize: '18' })], new Set());
    const b = head.build([hit('甲', '', '笔记')], new Set());
    truthy(head.changed(a, b));
  });

  await test('noteFontSize 相同 → 不脏；且字号与尺寸互不串味', () => {
    const a = head.build([hit('甲', '', '笔记', { noteFontSize: '18' })], new Set());
    const b = head.build([hit('甲', '', '笔记', { noteFontSize: '18' })], new Set());
    falsy(head.changed(a, b));
    /* 同一条笔记、只换尺寸不换字号：仍要判脏（说明两个键各占一格，没有互相顶掉） */
    const c = head.build([hit('甲', '', '笔记', { noteFontSize: '18', imgSize: '70' })], new Set());
    const d = head.build([hit('甲', '', '笔记', { noteFontSize: '18', imgSize: '96' })], new Set());
    truthy(head.changed(c, d));
  });

  await test('★ noteFontSize 从有到无（同笔记另一词仍带值）也得判脏', () => {
    const a = head.build([hit('甲', '', '笔记', { noteFontSize: '18' })], new Set());
    const b = head.build([hit('甲', '', '笔记', { noteFontSize: '' })], new Set());
    truthy(head.changed(a, b));
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

  await test('★ 仅抓取：标签不许写成「🔖 标题 → 标题」（2.0.2.17 需求④）', () => {
    /* 仅抓取没有核心词 ⇒ 编译层 `display` 退回标签词（见 combo.js: `core.trim() || label`），
     * 于是 `→ 后半截` 与前半截一字不差 —— 白占一行宽度（用户原话："节省空间"）。 */
    const items = head.build([hit('计算机软件著作权登记证书', '计算机软件著作权登记证书', '笔记', { text: '', fetchOnly: true })], new Set());
    eq(items.length, 1);
    eq(items[0].entries.length, 1);
    eq(items[0].entries[0].kw, '计算机软件著作权登记证书');
    eq(items[0].entries[0].adj, '', '★ 前后同一个词时不许再出「→」那段');
    eq(head.tagHtml(items[0].entries), '<span class="khin-item-kw">🔖 计算机软件著作权登记证书</span>', '标签串');
  });

  await test('★ 前后不是同一个词时「→ 后半截」照旧（不许把这条一刀切掉）', () => {
    const items = head.build([hit('华为', '供应商', '笔记')], new Set());
    eq(items[0].entries[0].adj, '供应商');
    truthy(head.tagHtml(items[0].entries).indexOf('→ 华为') >= 0, '组合词形态不变');
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

  await test('★ 消费侧：fetchHtml 为 \'\' / null ⇒ 该字段卡片不渲染（真值判定在 important-note.js 那一处）', () => {
    // 空串与 null 对下游不可区分 ⇒ 两种入参都要落进"没有内容 ⇒ 不留卡"
    eq(head.build([hit('应用名称', '', '', { fetchHtml: '' })], new Set()).length, 0);
    eq(head.build([hit('应用名称', '', '', { fetchHtml: null })], new Set()).length, 0);
    // 反例：真有表格照旧成卡（上面两条不是把"抓取内容"整体关掉了）
    const ok = head.build([hit('应用名称', '', '',
      { fetchHtml: '<table class="kh-table"><tr><td>a</td><td>b</td></tr></table>' })], new Set());
    eq(ok.length, 1);
    // 手写笔记 + 空 fetchHtml：卡片照旧 —— 空掉的是"抓取那一块"，不是整张卡
    const withNote = head.build([hit('应用名称', '', '用户写的笔记', { fetchHtml: '' })], new Set());
    eq(withNote.length, 1);
    truthy(withNote[0].note.indexOf('<table') < 0, '空 fetchHtml 不许留下表格痕迹：' + withNote[0].note);
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

  suite('important-note · 默认宽度 250px 可经设置页调整（T26 / 用户 2026-10-12：200 → 250）');

  await test('★ 宽度只有一处真源（--khin-panel-w 变量），默认值跟 config 对表', () => {
    const src = read('src/features/important-note.js');
    const panel = (src.match(/\.khin-panel \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(panel.length > 0, '要能定位 .khin-panel 样式块（否则下面的断言跑在空串上等于没测）');
    truthy(/width:\s*var\(--khin-panel-w\)/.test(panel), '.khin-panel 的宽度必须走变量：' + panel);
    /* 反例防回归：宽度原来写死在这里（200px）——「设置页能填、面板不理」就是从这儿来的。
     * [^-] 是为了放过 min-width / max-width 两条合法声明（它们的值本来就不吃这个变量）。 */
    falsy(/[^-]width:\s*\d+px/.test(panel), '.khin-panel 里不许再写死宽度数字：' + panel);
    const wrap = (src.match(/\.khin-wrap \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/--khin-panel-w:\s*\d+px/.test(wrap), '变量默认值要定义在 .khin-wrap（render 往同一元素写内联值）：' + wrap);
    eq((src.match(/--khin-panel-w:\s*\d+px/g) || []).length, 1, '变量的默认值只许有一处定义');
    /* 两处真源不许漂移：CSS 默认值 == config 默认值；min-width == config 的下界。 */
    eq(Number((wrap.match(/--khin-panel-w:\s*(\d+)px/) || [])[1]), KH.Config.defaults.notePanelWidth,
      'CSS 的默认宽度必须跟 config 的默认值一致（漂移了，设置页读到的与面板显示的不是一回事）');
    truthy(new RegExp('min-width:\\s*' + KH.Config.PANEL_WIDTH_MIN + 'px').test(panel),
      'min-width 必须等于 config 的下界 ' + KH.Config.PANEL_WIDTH_MIN + 'px（min-width 压过 width，只改 width 白改）');
    /* 命中词块的上限是**派生**的（需求 3 改卡片后 250 下 ≈ 188：卡片外边距 12 + 边框 2 + 内边距 20 +
     * 关闭按钮与间隙 28 = 62），不留会过期的字面量 */
    const kw = (src.match(/\.khin-item-kw \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/max-width:\s*calc\(var\(--khin-panel-w\) - 62px\)/.test(kw),
      '命中词块上限必须跟着面板宽度变量走，且减数 = 卡片外边距 12 + 边框 2 + 内边距 20 + 关闭按钮 28：' + kw);
    /* 卡片化的那一半契约：减数改了，卡片的内边距/外边距也得是那个口径 —— 两边漂了会截字或溢出。 */
    const item = (src.match(/\.khin-item \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/margin:\s*0 6px 6px/.test(item) && /padding:\s*7px 10px/.test(item) && /border:\s*1px/.test(item),
      '卡片口径（外边距 6 / 内边距 10 / 1px 边框）必须与上面那条减数对得上：' + item);
    truthy(/border-radius:\s*8px/.test(item), '条目的圆角（需求 3：卡片化）：' + item);
    const ap = (src.match(/applyPosition\([^)]*\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    truthy(ap.length > 0, '要能定位 applyPosition');
    const apCode = ap.replace(/\/\*[\s\S]*?\*\//g, '');   // 只看代码，不看注释里的解释文字
    /* 反例防回归：以前这里是 `const width = this.minimized ? 56 : 360;` ——
     * 改 CSS 后钳位不跟、用户 resize 拉宽后 maxLeft 算错，所以钉住「不许再出现宽度字面量」。 */
    truthy(!/\b360\b/.test(apCode), 'applyPosition 里不许再出现写死的 360（那是 CSS 宽度的第二处真源）');
    truthy(/getBoundingClientRect\(\)\.width/.test(apCode) || /rect\.width/.test(apCode),
      '水平钳位必须读面板实测宽度（rect.width），否则 CSS 改了钳位不生效');
  });

  await test('★ 新配置键 notePanelWidth：默认 250、越界夹边界、坏值回默认（归一函数只有一个）', () => {
    const C = KH.Config;
    eq(C.defaults.notePanelWidth, 250, '默认宽度 250（用户 2026-10-12）');
    eq(C.normalize({}).config.notePanelWidth, 250, '缺键 ⇒ 回默认');
    eq(C.normalize({ notePanelWidth: 320 }).config.notePanelWidth, 320, '合法值原样保留');
    eq(C.normalize({ notePanelWidth: 100 }).config.notePanelWidth, 200, '小于下界 ⇒ 夹到 200（不丢用户的数）');
    eq(C.normalize({ notePanelWidth: 9999 }).config.notePanelWidth, 1200, '超过上界 ⇒ 夹到 1200');
    for (const bad of [0, -5, '', null, undefined, 'abc', NaN]) {
      eq(C.normalize({ notePanelWidth: bad }).config.notePanelWidth, 250, '坏值 ⇒ 回默认 250：' + String(bad));
    }
    eq(C.normalizePanelWidth('320'), 320, '字符串数字要认（导入的旧备份里存过字符串）');
    eq(C.normalizePanelWidth(250.6), 251, '面板宽度只收整数');
    eq(C.PANEL_WIDTH_MIN, 200, '下界常量（用户 2026-10-13 拍板 160 → 200）');
    eq(C.PANEL_WIDTH_MAX, 1200, '上界常量（2.0.2.7 用户 2026-10-15：600 → 1200）');
    /* 配置 → 面板的接线：写入口只有 render() 一处，且用的是 config 的归一函数（不许复制一份边界） */
    const src = read('src/features/important-note.js');
    truthy(/KH\.Config\.normalizePanelWidth\(/.test(src), '面板必须调 config 的唯一归一函数');
    /* config ⇒ 变量的唯一证据层：写入的值必须直接由 cfg.notePanelWidth 经唯一归一函数得出。
     * 字面量不可能满足这个正则（样式表里的默认值只是首屏兜底，真正生效的是这一行内联写入）。 */
    truthy(/setProperty\('--khin-panel-w',\s*\n\s*KH\.Config\.normalizePanelWidth\(cfg && cfg\.notePanelWidth\)/.test(src),
      '面板宽度必须由 render() 从 cfg.notePanelWidth 写到 CSS 变量上（否则设置页改了面板不理）');
    /* consume(hits, cfg) 必须把 cfg 交给 render —— 否则上面那行永远拿不到用户选的值 */
    const cons = (src.match(/consume\(hits, cfg\) \{[\s\S]*?\n      \},/) || [''])[0];
    truthy(/panel\.render\([\s\S]*?, cfg\)/.test(cons), 'consume 必须把 cfg 传给 render：' + cons);
  });

  await test('★ 三个外观数字的范围：字号 8 必须能用，越界值仍按各自口径处理（2.0.2.7 放宽）', () => {
    const C = KH.Config;
    /* 用户 2026-10-15 原话：「我有的字号设置为 8，而范围最小是 10，这不符合预期」⇒ 8 必须原样保留 */
    eq(C.normalizeNoteFontSize(8), 8, '★ 8 号字必须原样保留（以前被判越界、回落成 11）');
    eq(C.normalizeNoteFontSize('8'), 8, '字符串数字照收（导入的旧备份里存过字符串）');
    truthy(C.NOTE_FONT_MIN <= 8, '★ 下限必须 ≤ 8（用户真在用的设置），实际 ' + C.NOTE_FONT_MIN);
    eq(C.normalizeNoteFontSize(C.NOTE_FONT_MIN), C.NOTE_FONT_MIN, '下界本身是合法值');
    eq(C.normalizeNoteFontSize(C.NOTE_FONT_MAX), C.NOTE_FONT_MAX, '上界本身是合法值');
    /* 「放宽」不等于「不设界」：明显不合理的值仍按各自口径处理（用户口径：只有 999 这种才拦） */
    eq(C.normalizeNoteFontSize(999), 11, '字号越界 ⇒ 回落默认 11（2.0.2.2 起的老口径，本轮不翻案）');
    eq(C.normalizeImgSize(9999), C.IMG_SIZE_MAX, '图片尺寸越界 ⇒ 夹到边界');
    eq(C.normalizeImgSize(0), C.IMG_SIZE_DEFAULT, '图片尺寸坏值 ⇒ 回默认');
    /* 范围次序：任一对边界写反（lo > default 或 default > hi）都会让"填了不生效"，这里当场红 */
    for (const [lo, def, hi, what] of [
      [C.NOTE_FONT_MIN, C.NOTE_FONT_DEFAULT, C.NOTE_FONT_MAX, '字号'],
      [C.IMG_SIZE_MIN, C.IMG_SIZE_DEFAULT, C.IMG_SIZE_MAX, '图片尺寸'],
      [C.PANEL_WIDTH_MIN, C.PANEL_WIDTH_DEFAULT, C.PANEL_WIDTH_MAX, '面板宽度']
    ]) {
      truthy(lo <= def && def <= hi, what + ' 的区间必须含默认值：' + lo + ' ≤ ' + def + ' ≤ ' + hi);
    }
  });

  await test('★ 设置页三个数字输入的 min/max 都取自 config 常量（imgSize / 字号 / 面板宽度）', () => {
    const html = read('options/options.html');
    const pairs = [
      ['pf-imgSize', 'IMG_SIZE_MIN', 'IMG_SIZE_MAX'],
      ['pf-noteFontSize', 'NOTE_FONT_MIN', 'NOTE_FONT_MAX'],
      ['pf-notePanelWidth', 'PANEL_WIDTH_MIN', 'PANEL_WIDTH_MAX']
    ];
    for (const [id] of pairs) {
      truthy(html.indexOf('id="' + id + '"') >= 0, '设置页要有 #' + id);
      falsy(new RegExp('id="' + id + '"[^>]*min=').test(html),
        '#' + id + ' 的 min 不许写死在 HTML 里（那会和 config 的下界漂移）');
      falsy(new RegExp('id="' + id + '"[^>]*max=').test(html), '#' + id + ' 的 max 也不许写死');
    }
    const js = read('options/options.js');
    for (const [id, lo, hi] of pairs) {
      truthy(new RegExp("limitInput\\(\\$\\('" + id + "'\\), KH\\.Config\\." + lo + ", KH\\.Config\\." + hi + "\\)").test(js),
        '#' + id + ' 的 min/max 必须从 config 的边界常量写进去（2.0.2.6 起三个数字输入统一走 limitInput）');
    }
    truthy(/KH\.Config\.normalizePanelWidth\(\$\('pf-notePanelWidth'\)\.value\)/.test(js),
      '保存前必须过 config 的归一函数（坏值不许落盘）');
    truthy(/patch\(\{ notePanelWidth: w \}\)/.test(js), '归一后的值才落盘（顶层键，不走 saveNested）');
    truthy(js.indexOf("$('pf-notePanelWidth').value = w;") >= 0,
      '归一后的值要回显进框里（别让框里停着一个没生效的数）');
    /* 陈旧说明：那段「📋 复制这张图的全部识别文字」说的是 T25 已删的按钮 */
    falsy(html.indexOf('复制这张图的全部识别文字') >= 0, '设置页不许再描述那个已删的复制按钮');
    /* 2.0.2.1 需求 4 起全文栏默认可见、还能拖走，措辞随之改；断言只钉「通路说清没有」，
     * 不钉整句 —— 否则改一句文案就红，护栏变成绊脚石。 */
    truthy(html.indexOf('选中后 Ctrl+C') >= 0, '要写清真正可用的复制通路（大图全文栏选中复制）');
    truthy(html.indexOf('全文栏') >= 0 && html.indexOf('一键复制') >= 0,
      '复制通路要连「去哪复制」一起说清：全文栏 + 它自带的一键复制');
  });

  suite('important-note · 抓取字段标题可截断、内容必须完整（用户 2026-10-11：标题省宽度）');

  await test('★ 标题格里的文本单行裁切 + 宽度封顶；规则只落在标题格', () => {
    const src = read('src/features/important-note.js');
    const rule = (src.match(/\.kh-table \.kh-table-label \.kh-lbt \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(rule.length > 0, '要有 `.kh-table .kh-table-label .kh-lbt` 这条规则（否则 span 不截断）');
    truthy(/max-width:\s*var\(--kh-lbt-maxw,\s*8em\)/.test(rule),
      '标题列要有宽度封顶（默认 8em ≈ 88px @11px，用户 2026-10-11：标题可省宽度）');
    truthy(/max-height:\s*1\.5em/.test(rule) && /overflow:\s*hidden/.test(rule),
      '单行（max-height 1.5em）+ 溢出藏起来 —— 标题是"裁到一行"，不是竖排堆叠占高');
    truthy(/display:\s*inline-block/.test(rule), 'display 用 inline 档（inline-block）');
    /* 反例①：**不许**用 white-space:nowrap 裁单行 —— nowrap 把该列的**最小内容宽度**抬到标题全文，
     * auto 布局表格再也压不下去（真机：表宽 185px > 容器 178px，既有用例当场红）。 */
    falsy(/white-space:\s*nowrap/.test(rule),
      '标题不许用 white-space:nowrap 裁行（会把表格的最小宽度抬到标题全文 ⇒ 表格溢出容器，真机 185>178）');
    /* 反例②：**不许**用块级的 display —— 块级盒子会让 innerText 在格末多插换行（真机既有"值行数=5"用例变 6）。 */
    falsy(/display:\s*(-webkit-)?box\s*;/.test(rule) || /display:\s*block/.test(rule),
      'display 必须是 inline 那一档（inline-block）：块级会让 innerText 多一个换行');
    /* 反例③：-webkit-line-clamp 在表格单元格里不生效（Chromium 把 display 归一成 inline-block/flow-root，
     * 真机 5 个行盒、内容照旧换行），还让 scrollHeight 把被省略的内容算进去 ⇒ 别再用它当裁切手段。 */
    falsy(/-webkit-line-clamp|-webkit-box-orient|-webkit-inline-box/.test(rule),
      '-webkit-line-clamp 在表格里不生效（真机实测：计算 display 被归一到 inline-block，内容仍换行）');
    /* 反例④：把截断写给**所有** td 就是拿内容换宽度 —— 用户明确要求"实际抓取到的内容展示还是需要完整展示" */
    const tdRule = (src.match(/\n    \.kh-table td \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(tdRule.length > 0, '要能定位到 .kh-table td 的样式块（否则下面的反例是在空串上跑）');
    falsy(/text-overflow/.test(tdRule) || /max-width/.test(tdRule),
      '内容格（td）不许截断/封顶 —— 只有标题格让位');
  });

  await test('★ 历史笔记同样生效：渲染时就地给标题格补 .kh-lbt（幂等，已包裹的不重复包）', () => {
    const src = read('src/features/important-note.js');
    const frag = (src.match(/noteFragment\(doc, note\) \{[\s\S]*?\n    \},/) || [''])[0];
    truthy(frag.length > 0, '要能定位到 noteFragment（否则下面的断言是在空串上跑）');
    truthy(/querySelectorAll\('td\.kh-table-label'\)/.test(frag),
      '渲染时要就地找标题格补包裹 —— 表格是**存进笔记**的 HTML，只改生成侧等于只对新笔记生效');
    truthy(/className = 'kh-lbt'/.test(frag), '补的就是 CSS 认的那个类');
    truthy(/span\.title = txt/.test(frag),
      '全文要挂 title（视觉截断、hover 可读回，信息不许真丢）');
    truthy(/first\.className === 'kh-lbt'/.test(frag),
      '幂等：已经包过的不许再包一层（嵌套 span 会让省略号失效）');
    falsy(/innerHTML = m\[0\][\s\S]{0,200}innerHTML/.test(frag),
      '别在渲染里重写整串 innerHTML —— 只做补包裹，表格结构不动');
  });

  /* 【2.0.2.17 需求①】字段名格不再带后缀 ⇒ 补包裹回到「整格文本包一层」这最简单的一步。
   * 只锁源码形状：垫片的 `ShimElement` 没有 `firstChild`，`noteFragment` 的搬移循环在 node 环境里跑不起来
   * （上面那条"历史笔记同样生效"也是源码断言，同一原因）；真机行为由 `_e2e/ui.test.js` 覆盖。 */
  await test('★ 需求①：补包裹只包名字（后缀已不进笔记，不许留着绕开徽标的旧逻辑）', () => {
    const src = read('src/features/important-note.js');
    const frag = (src.match(/noteFragment\(doc, note\) \{[\s\S]*?\n    \},/) || [''])[0];
    truthy(frag.length > 0, '要能定位到 noteFragment（否则下面的断言是在空串上跑）');
    truthy(/const txt = td\.textContent \|\| ''/.test(frag), '整格文本就是标题');
    truthy(/span\.title = txt;/.test(frag), '全文要留在 title 里（截断只发生在视觉上，悬停能读全）');
    falsy(/kh-table-suffix/.test(frag), '★ 旧的后缀绕行逻辑必须删净（后缀已经不进笔记了）');
  });

  suite('important-note · 面板 UI 修复批（T29）');

  /** 单行规则（`{ … }` 不换行的那种）—— CSS_OF 用的是"到下一个 4 空格缩进的 }"，单行规则会多吞。 */
  const RULE = (src, sel) => (src.match(new RegExp(sel.replace(/\./g, '\\.').replace(/\s+/g, '\\s+') + ' \\{[^}]*\\}')) || [''])[0];

  await test('★ 键盘焦点环由面板自己给：只认 :focus-visible（F4.7，用户 2026-10-13 拍板做）', () => {
    const src = read('src/features/important-note.js');
    /* 原来全靠浏览器默认环（配色由浏览器定、与主题无关）。守卫按"规则形状"写：
     * 只许 :focus-visible —— 写成 :focus 会让鼠标点击也留一圈，点击感变脏。 */
    const rule = (src.match(/:focus-visible\s*\{[^}]*\}/) || [''])[0];
    truthy(/outline:\s*2px solid/.test(rule), '焦点环要显式给（默认环在深色主题下不够显眼）');
    truthy(/outline-offset:\s*1px/.test(rule), '留 1px 偏移 —— 环贴着边会被裁掉一半');
    truthy(/var\(--brand-deep,\s*#3579c2\)/.test(rule),
      '颜色走 tokens 的 --brand-deep 并带字面兜底（面板模板串是 meta-check 的扫描盲区，兜底是它唯一的护栏）');
    falsy(/:focus\s*\{/.test(src), '禁止 `:focus` 规则 —— 鼠标点击也会留环');
  });

  await test('★ 小按钮是真按钮：点得开、双击照旧、还能拖（T29 / F4.1 + F4.4）', () => {
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('<button class="khin-fab" type="button">') >= 0,
      'FAB 必须是真 <button>（原来是 div：键盘够不着、单击没反应，只有双击这一条隐性通路）');
    truthy(/\.khin-fab \{[\s\S]{0,400}?border: 0; font-family: inherit;/.test(src),
      '做成按钮后要盖掉 UA 的皮（边框 + 字体不继承）');
    truthy(src.indexOf("fab.addEventListener('click'") >= 0, '单击要能展开');
    /* T60：FAB 的 dblclick 由 `openPanel` 直接当处理器，改成包一层 —— 直接传处理器会把事件对象
     * 当 suppressMs 传进去（`typeof {} === 'object'` ⇒ 取 Date.now()，行为侥幸正确但不该靠侥幸），
     * 所以这里钉的是「仍然调 openPanel、且不把事件对象喂给它」。 */
    truthy(/fab\.addEventListener\('dblclick', \(\) => openPanel\(\)\)/.test(src), '双击习惯保留（且不把事件对象当 suppressMs 喂进去）');
    truthy(src.indexOf("fab.addEventListener('pointerdown'") >= 0, '拖动把手仍在（pointerdown）');
    truthy(/const inFab = hitFab\(t\)/.test(src) && /t\.tagName === 'BUTTON' && !inFab/.test(src),
      '拖动守卫必须放行 FAB 自己 —— 否则"按钮上不拖"会把它一起拦掉，面板再也拖不动');
    truthy(src.indexOf('<span aria-hidden="true">📌</span>') >= 0 &&
      src.indexOf('khin-fab-badge" aria-hidden="true"') >= 0,
      '📌 与徽标都是装饰：语义由 aria-label 承载，读屏不必再念一遍图标');
  });

  await test('★ 长按不当作点击：按住 ≥600ms 且没位移 ⇒ 不打开面板（T40 / T37 真机实测）', () => {
    const src = read('src/features/important-note.js');
    /* 真机实测（qa 取证）：按住约 1 秒不动再松手 ⇒ 面板自己弹开，鼠标与触屏都复现
     * —— FAB 同时是「展开」按钮与「拖动」把手，长按在浏览器眼里就是一次普通 click。
     * 判据：按住 ≥600ms 且期间无位移 ⇒ 不打开；快击照旧；拖完仍由 dragMoved 否决；
     * 键盘（Enter/空格不派发 pointerdown）必须仍然可用。 */
    const clickAt = src.indexOf("fab.addEventListener('click'");
    truthy(clickAt >= 0, 'FAB 的 click 通路不见了（T29 加的展开入口）');
    const fabClick = src.slice(clickAt, src.indexOf('});', clickAt));
    const downAt = src.indexOf("fab.addEventListener('pointerdown'");
    truthy(downAt >= 0, 'FAB 的 pointerdown 通路不见了（拖动把手）');
    const fabDown = src.slice(downAt, src.indexOf('});', downAt));

    truthy(/const FAB_LONG_PRESS_MS = 600;/.test(src), '阈值必须是具名常量 600ms（用户拍板值）');
    const constAt = src.indexOf('const FAB_LONG_PRESS_MS = 600;');
    truthy(/真机|按住/.test(src.slice(Math.max(0, constAt - 400), constAt)),
      '常量上方要写明理由（真机实测：按住约 1 秒松手会误开面板）');

    truthy(/this\.fabPressAt = Date\.now\(\);/.test(fabDown),
      '按下时要记时间戳 —— 这是时长判定的起点');
    truthy(/this\.dragMoved = false;/.test(fabDown),
      '每次按下先清掉上一次的拖动标记：拖动后若没派发 click，别让它吞掉下一次键盘激活');
    truthy(/fabPressAt: 0/.test(src), '时间戳默认值是 0（未记录 = 放行）');

    /* T41（lead 2026-10-12 口径）：时长必须在**指针事件**里量、click 只读 —— click 的派发延迟是
     * 浏览器行为（触屏尤其明显：指针抬起后还要等一次双击/缩放手势判定），拿它当计时源会把一次
     * 快速轻点误判成长按，"轻点开面板"在触屏上就没了。结算点 = startDrag 的 pointerup 收尾。 */
    truthy(/fabHeldMs: 0/.test(src), '要有一个结算字段，默认 0（未记录 = 放行，供键盘通路用）');
    truthy(/if \(this\.fabPressAt\) \{ this\.fabHeldMs = Date\.now\(\) - this\.fabPressAt; this\.fabPressAt = 0; \}/.test(src),
      '时长必须在 pointerup 里结算（指针事件里量），不许在 click 里现算');
    truthy(/window\.addEventListener\('pointercancel', up\)/.test(src),
      'pointercancel（触屏被系统接管，没有 pointerup）也要结算并清干净：否则残留时间戳会把下一次真实点击当成长按否决');
    truthy(/const heldMs = this\.fabHeldMs;/.test(fabClick), 'click 只读结算值，不参与计时');
    falsy(/Date\.now\(\)/.test(fabClick), 'click 里不许出现计时源（派发延迟不可控）');
    truthy(/const keyboard = !e \|\| e\.detail === 0;/.test(fabClick),
      '键盘激活（detail 为 0，前面没有 pointerdown）必须能分辨出来');
    truthy(/if \(keyboard\) \{ this\.dragMoved = false; this\.fabHeldMs = 0; openPanel\(\); return; \}/.test(fabClick),
      '键盘这一次一律放行，并清掉可能残留的手势状态（否则拖动收尾/pointercancel 的旧状态会吞掉键盘激活）');
    falsy(/keyboard[\s\S]{0,120}?FAB_LONG_PRESS_MS/.test(fabClick),
      '键盘通路不许过时长闸门（T29 刚让 FAB 键盘可达，不许改回不可达）');
    truthy(/this\.fabHeldMs = 0;/.test(fabClick), '结算值用完即清，别把上一次的按住时长带到下一次');
    truthy(/if \(heldMs >= FAB_LONG_PRESS_MS\) return;/.test(fabClick),
      '按住 ≥600ms 且没位移 ⇒ 直接返回，不打开面板');
    truthy(/if \(this\.dragMoved\) \{ this\.dragMoved = false; this\.fabHeldMs = 0; return; \}/.test(fabClick),
      '拖完补发的 click 仍由 dragMoved 否决，并且要一起清掉结算值（别让拖动时长污染下一次点击）');
    falsy(/setTimeout|setInterval/.test(fabClick), '不许为此新造长按定时器（按下记时间戳足够）');
    falsy(/(keydown|keyup)[^]{0,160}?fabPressAt/.test(src),
      '键盘通路不许与按住时长挂钩（T29 刚把 FAB 变成键盘可达，别改回不可达）');
  });

  await test('★ T52 反向用例：位移 ≤3px 不算「拖」⇒ 松手仍按点击处理（阈值是曼哈顿距离 >3px，不是 ≥）', () => {
    const src = read('src/features/important-note.js');
    /* 反向（"不算拖"那一侧）用例：FAB 同时是「展开」按钮与「拖动」把手，手按上去松开的途中只抖
     * 1~3px 的**必须仍算点击**（面板照开）。阈值实现在 important-note.js:1153：
     * 曼哈顿距离 |dx|+|dy| > 3 才 `state.moved = true`。
     * 装置说明：tests/harness.js 的 ShimElement 自 T38 起有事件通道（addEventListener /
     * dispatchEvent），但 **window 上的 pointermove/pointerup 管线仍然没有**
     * （垫片里 window === global，Node 的 global 不是 EventTarget），document 的监听器也还是
     * 空实现（:357）—— 真机式 pointerdown/move/up 在这里得另造一套事件管线，
     * 所以照本文件既有手法（上面 T40 那条）**静态钉住源码表达式**，不新造装置。 */
    const at = src.indexOf('startDrag(e) {');
    truthy(at >= 0, 'startDrag 不见了（FAB 的拖动把手）');
    const drag = src.slice(at, src.indexOf("window.addEventListener('pointermove'", at));
    truthy(drag.length > 0, '要在 startDrag 到 pointermove 注册之间取到拖动实现（否则下面是在空串上跑）');

    truthy(/const state = \{[^\n]*moved: false \};/.test(drag), 'moved 默认必须是假（"没动过"是默认，不是靠事后清）');
    truthy(/if \(Math\.abs\(ev\.clientX - state\.startX\) \+ Math\.abs\(ev\.clientY - state\.startY\) > 3\) state\.moved = true;/.test(drag),
      '阈值必须是曼哈顿距离 |dx|+|dy| **严格大于** 3 ⇒ 位移 ≤3px 的抖动不算拖（否则"明明点了、面板没开"会回来）');
    falsy(/>=\s*3/.test(drag), '禁 `>= 3`：恰好 3px 的抖动会被判成拖 —— 这条反向用例钉的就是这一侧');
    eq((src.match(/state\.moved = true/g) || []).length, 1, '置真只许有一处（就是那条 >3 比较），别在别处补"顺手也算拖"');
    truthy(/this\.dragMoved = !!state\.moved;/.test(drag), 'dragMoved 只由 state.moved 派生（指针抬起时结算）');
    eq((src.match(/this\.dragMoved = true/g) || []).length, 0, 'dragMoved 不许被任何地方直接置真 —— 它只能是">3px"的结果');
    const clickAt = src.indexOf("fab.addEventListener('click'");
    truthy(clickAt >= 0, 'FAB 的 click 通路不见了');
    const fabClick = src.slice(clickAt, src.indexOf('});', clickAt));
    truthy(/if \(this\.dragMoved\) \{ this\.dragMoved = false; this\.fabHeldMs = 0; return; \}/.test(fabClick),
      'FAB 的 click 只认 dragMoved ⇒ ≤3px 松手时该分支不成立，照常 openPanel（反向用例的另一半）');
  });

  await test('★ 多命中的下拉条目键盘选得了（T29 / F4.3）', () => {
    const src = read('src/features/important-note.js');
    const list = (src.match(/tagListHtml\(entries, max\) \{[\s\S]*?\n    \},/) || [''])[0];
    truthy(list.length > 0, '要能定位 tagListHtml（否则下面的断言是在空串上跑）');
    truthy(/class="khin-tag-item" data-kh-tag-idx="[^"]*" role="button" tabindex="0"/.test(list),
      '下拉条目要 role/tabindex —— 原来能展开、选不了，键盘用户卡在门外');
    const rt = (src.match(/renderTags\(tagsEl, item\) \{[\s\S]*?\n    \},/) || [''])[0];
    truthy(rt.length > 0, '要能定位 renderTags');
    truthy(/items\[i\]\.addEventListener\('keydown'/.test(rt), 'Enter/空格要触发选择');
    truthy(/items\[i\]\.addEventListener\('click', pickOne\)/.test(rt),
      '点击与键盘共用同一处选择逻辑（两套写法迟早走岔）');
    falsy(/closest\s*\(/.test(rt), '交互定位不许用 closest 反查（meta-check 红线）');
  });

  await test('★ 笔记列表整块没有时不许留 60px 白带（T29 / F6.1）', () => {
    const src = read('src/features/important-note.js');
    truthy(/\.khin-body\[hidden\] \{ display: none; \}/.test(src),
      '要补一条 [hidden] 规则（它是唯一没吃到 [hidden] 的 flex 子项）');
    truthy(src.indexOf('this.bodyEl.hidden = !(this.items.length || ctxN);') >= 0,
      '整页只有图片命中时要真的把正文整块藏起来，而不是留一条空高');
    const body = RULE(src, '.khin-body');
    truthy(/min-height:\s*60px/.test(body), 'min-height 仍要留给"有笔记"的正常态（不许为了这块白带去删它）');
  });

  await test('★ T43：大图平移放开到整屏 —— 只保证"不被拖丢"（120px 仍在视口内）', () => {
    const src = read('src/features/important-note.js');
    /* 用户原话（2026-10-12）："大图模式，图片拖动范围有点小，被限制在容器里面"。
     * 旧式是「图边贴视口边 + 60px 余量」，而大图常态是 84vw < 视口宽 ⇒ Math.max(0, …) 把整项压成 0
     * ⇒ scale=1 时只剩 60px 可挪。新式按「至少 KEEP 像素还在视口内」推导，图可以摆到整屏任意位置。 */
    truthy(/const LIGHTBOX_PAN_KEEP = 120;/.test(src),
      '常量必须是 LIGHTBOX_PAN_KEEP = 120（lead 拍板值：不至于把图拖丢的下限）');
    const fnAt = src.indexOf('const clampPan = (tx, ty) => {');
    truthy(fnAt >= 0, '要有 clampPan 本体（没匹配到说明它被重写了）');
    const fn = src.slice(fnAt, src.indexOf('};', fnAt));
    truthy(/const limX = Math\.max\(0, \(window\.innerWidth \+ r\.width\) \/ 2 - LIGHTBOX_PAN_KEEP\);/.test(fn),
      'X 上界必须是 (视口宽 + 图宽) / 2 − KEEP：图能摆到整屏，只保证不被拖丢');
    truthy(/const limY = Math\.max\(0, \(window\.innerHeight \+ r\.height\) \/ 2 - LIGHTBOX_PAN_KEEP\);/.test(fn),
      'Y 同构（一次改完 X/Y，别只改一半）');
    truthy(/Math\.min\(limX, Math\.max\(-limX, tx\)\)/.test(fn), '夹紧仍绕原点对称（复位/双击回中的前提）');
    /* 反向守卫：只加不改 —— 旧式一旦留下，小图又会退回"只剩 60px 可挪"，而且更难发现。
     * 注意注释里也不许写出旧式，否则这条会把注释算成命中。 */
    falsy(/r\.width - window\.innerWidth/.test(src), '旧式（图边贴视口边）不许留在文件里');
    falsy(/r\.height - window\.innerHeight/.test(src), 'Y 同构的旧式同样不许留');
    falsy(/LIGHTBOX_PAN_SLACK/.test(src), '旧常量名必须彻底消失（不许两个常量并存）');
    /* 求值顺序（lead 追加要求）：clampPan 读的是**活的** getBoundingClientRect ⇒ 必须先把本次
     * 缩放/旋转写进 transform、再夹紧。顺序反了它拿到的是上一次留下的尺寸 —— 从 4× 缩回 1× 时
     * 按旧的大盒算出很大的边界，平移量原样留下（用户看到"缩回来图飞出去"），要等下次 apply 才收回。 */
    const ap = (src.match(/const apply = \(\) => \{[\s\S]*?\n      \};/) || [''])[0];
    truthy(ap.length > 0, '要有 apply 本体（没匹配到说明它被重写了）');
    const firstTransform = ap.indexOf('img.style.transform');
    const clampCall = ap.indexOf('clampPan(');
    truthy(firstTransform >= 0 && clampCall > firstTransform,
      'apply 里必须"先写 transform 再 clampPan"（否则按上一次的盒算边界）');
    /* 反向守卫（可判定，不是永远为真）：被夹紧时要写第二次 transform ⇒ apply 体内恰好两次赋值；
     * 旧顺序只有一次赋值 ⇒ 这条会红。且第二次必须在"确实被夹紧"的条件里，不夹紧不许写。 */
    eq((ap.match(/img\.style\.transform/g) || []).length, 2,
      'apply 体内 img.style.transform 必须恰好两次（首次无条件、第二次只在被夹紧时）');
    truthy(/if \(p\.x !== tx0 \|\| p\.y !== ty0\) \{[\s\S]{0,240}?img\.style\.transform/.test(ap),
      '第二次赋值必须在"确实被夹紧"的条件分支里（不夹紧时不许多写一次 style）');
  });

  await test('★ T46：全文栏回进 .kh-lb-row（与翻页键同祖先）+ 关闭只认按下的位置', () => {
    const src = read('src/features/important-note.js');
    /* 真机缺陷（qa 取证，不是推断）：浮层锚**容器**（.kh-lb-stage）、‹/› 锚**行**（.kh-lb-row，
     * 列向 flex 居中、行宽 = 内容宽）。只要行的右缘比容器右缘内缩超过 60px，浮层右缘就必然压进行里
     * —— 实测 paneRect 与 nextRect 横向重叠 48px（= 整个按钮宽），elementFromPoint(› 中心) 命中的
     * 是浮层里的 .kh-lb-side-t ⇒ 真压住、真挡点击（浮层 z-index:3 > 导航 z-index:2）。 */
    const rowAt = src.indexOf('<div class="kh-lb-row">');
    const sideAt = src.indexOf('<div class="kh-lb-side" hidden>');
    const barAt = src.indexOf('<div class="kh-lb-bar">');
    truthy(rowAt > 0 && sideAt > rowAt, '浮层仍在行内（需求 4 后位置由 fixed + JS 决定，DOM 不动是少一处改动）');
    truthy(barAt > sideAt, 'DOM 顺序 = 图 → 导航（‹/›）→ 浮层，浮层在工具条之前');
    const rowSeg = src.slice(rowAt, sideAt);
    truthy(rowSeg.indexOf('‹') >= 0 && rowSeg.indexOf('›') >= 0, '浮层前面必须已经有两个翻页键');
    truthy(rowSeg.indexOf('<img class="kh-lb-img" alt="">') >= 0, 'img 标签仍原样（一个字不许改）');
    /* 定位（2.0.2.1 需求 4）：浮层改成 **position: fixed** —— 坐标按视口算，不再借任何祖先当基准，
     * 于是 T46 那条"锚容器 vs 锚行"的错位病根从根上消失（两个位次都由 dockSide 按图的实际矩形算，
     * 且都不越进导航所在的那条带）。脱流这条不变 ⇒「有/无浮层图一样宽」不许回退（T41 验收项）。 */
    const sideRule = RULE(src, '.kh-lb-side');
    truthy(/position:\s*fixed/.test(sideRule), '浮层必须脱流（fixed；否则又参与行宽分配）：' + sideRule);
    truthy(/width:\s*340px/.test(sideRule), '定宽 340px（不参与行宽分配，宽度只能自己定）：' + sideRule);
    truthy(/max-width:\s*min\(342px,\s*calc\(100vw - 16px\)\)/.test(sideRule),
      '窄视口下的上限（不许横着溢出行外）：' + sideRule);
    /* 几何的承重件已迁到 JS：两个位次就是 T46 缺陷的防线 —— 谁删掉兜底那档，浮层就重新压住 › */
    truthy(/x = r\.right \+ gap \+ 48 \+ gap/.test(src), '首选位落在导航外侧（结构上压不到 ›）');
    truthy(/if \(x \+ w > vw - gap\) x = r\.right - w;/.test(src),
      '放不下时退回行内右侧：右缘齐图右缘（让开 12 + 48 那条导航带 —— T46 缺陷的防线，不许删）');
    truthy(/\bz-index:\s*3\b/.test(sideRule), '层级仍高于图与导航（放大溢出盖不住它）');
    /* 关闭语义（T46 第二症状：在浮层里按下、往外松手 → 灯光箱被误关）：
     * 只有 pointerdown 也落在容器外，click 才关；抬手落点不再决定关不关。 */
    const pdAt = src.indexOf("box.addEventListener('pointerdown'");
    truthy(pdAt > 0, '要由 pointerdown 记下"按下的位置"');
    const pdSeg = src.slice(pdAt, pdAt + 260);
    truthy(/pressInStage = !!\(t && stage\.contains\(t\)\)/.test(pdSeg), '按下时判定是否落在容器内：' + pdSeg);
    const clAt = src.indexOf("box.addEventListener('click'");
    truthy(clAt > 0, '点击处理器仍在');
    const clSeg = src.slice(clAt, clAt + 420);
    truthy(/if \(pressInStage\) return;/.test(clSeg), '按下在容器内 ⇒ 这一下不算"点遮罩"，不许关：' + clSeg);
    truthy(src.indexOf('if (t && side.contains(t)) return;') >= 0,
      '浮层白名单仍要保留（承重件：进大图 → 选中 → Ctrl+C 的复制通路）');
    truthy(src.indexOf('if (t && stage.contains(t)) return;') >= 0, '容器白名单仍要保留');
  });

  /* ==========================================================================
   * T60 回归：「双击收起态 FAB 无法展开面板」——真机 e2e（_e2e/content.test.js
   * 「★ 双击标题栏收起为圆形 FAB，再双击展开」）第二步红，`.khin-panel` 300ms 后不存在。
   *
   * 机制（源码全路径，逐行可核）：一次鼠标双击 = down/up/click(1) → down/up/click(2) → dblclick。
   *   · click(1) 落点 = FAB 中心：`important-note.js:1264` 的 click 过三道具后调 openPanel()
   *     （:1252-1256），里面 `renderContent()` **就地换壳** `this.root.innerHTML = …`
   *     （:1245-1247 的 FAB → :1288-1311 的 `.khin-panel` + `.khin-header`）；
   *   · 第二次 click 与 dblclick 仍落在同一屏幕坐标 —— 坐标处已经是刚生成的 `.khin-header`
   *     （FAB 是 48×48 的圆、贴 wrap 左上角，wrap 就是面板起画点；header 是面板第一行、
   *      横向铺满，两盒必然相交），于是命中 :1377-1381 的 header dblclick ⇒ 当场 `minimized = true`
   *     又收回去（用户看到闪一下）⇒ e2e 断言 `.khin-panel` 不存在。
   * 回归来处：click 打开 FAB 是 T29 把 FAB 从 div 改成真 <button> 时加的（:1241-1243 注释），
   * 在那之前 FAB 只绑 dblclick、第一次 click 不开面板，所以这条用例当时是绿的。
   *
   * 装置说明（与上面 T40 / T52 同一条边界）：tests/harness.js 的 ShimElement **有**事件通道
   * （T38 起），但 pointerdown/pointerup 的**拖拽管线在 window 上**（window === global，
   * Node 的 global 不是 EventTarget），document 的监听器也是空实现（:357）——
   * 本套件里没有可用的指针事件管线，所以这里照本文件既有手法**逐字钉住源码表达式**。
   * 「≤600ms 不许收起」这条同时封住 "删掉守卫" 与 "守卫挂错事件" 两种改法（下面第 ② 条）。
   * 真机复验（第二次落点是不是 header）由 qa 用 _e2e 仪器做，本文件不下结论。
   * ========================================================================== */

  suite('important-note · T60 回归：刚由 FAB 展开的同一秒内，header 双击不许把面板收回去');

  await test('★ FAB click 展开后 ≤600ms 内 header dblclick **不得**收起（第一次落点的代价，不是用户的第二次手势）', () => {
    const src = read('src/features/important-note.js');

    /* ① 展开时要记下时刻，且**无条件覆盖**上一次的值（复刻时必须靠这句把旧窗口清掉，
     * 另写一句 `= 0` 是多余的）。suppressMs 是测试注入时钟的口子：`typeof 数字` 才认，
     * 传事件对象（`typeof {} === 'object'`）会回落到 Date.now()，所以下面还要钉住调用点不喂事件对象。 */
    const openAt = src.indexOf('const openPanel = (suppressMs) => {');
    truthy(openAt >= 0, '要能定位 openPanel（FAB 的展开通路，:1252）');
    truthy(src.indexOf("fab.addEventListener('pointerdown'", openAt) > openAt, 'openPanel 后面应紧跟 FAB 的 pointerdown 处理器');
    const openFn = src.slice(openAt, src.indexOf("fab.addEventListener('pointerdown'", openAt));
    eq((openFn.match(/this\.fabOpenedAt = /g) || []).length, 1,
      'openPanel 里对 fabOpenedAt 只许有**一次**无条件赋值（覆盖 = 清旧+记新一体），不许拆成两句或藏着分支：' + openFn);
    truthy(/this\.fabOpenedAt = typeof suppressMs === 'number' \? suppressMs : Date\.now\(\);/.test(openFn),
      'openPanel 必须记下这次展开的时刻，且抑制窗口只来自 FAB 的这次展开（suppressMs 参数，缺省 = 现在）：' + openFn);

    /* ② header 的双击收起步必须过这道否决闸，且**只认刚由 FAB 打开这一次** */
    const hdrAt = src.indexOf("header.addEventListener('dblclick'");
    truthy(hdrAt >= 0, '标题栏双击收起通路仍在（策划案 §5.2.3）');
    const hdr = src.slice(hdrAt, src.indexOf('});', hdrAt));
    /* 钉住四要素：窗口来自 fabOpenedAt、比较的是 FAB_LONG_PRESS_MS（既有常量，不另造魔数）、
     * 命中就 return 且**清掉**（一次性 —— 不清就是永久抑制：展开久了再双击标题栏永远收不起来）、
     * 放行方向仍是 `minimized = true`。 */
    const guard = /const sinceFabOpen = Date\.now\(\) - this\.fabOpenedAt;\s*\n\s*if \(this\.fabOpenedAt && sinceFabOpen >= 0 && sinceFabOpen < FAB_LONG_PRESS_MS\) \{ this\.fabOpenedAt = 0; return; \}/;
    truthy(guard.test(hdr),
      '★ 这条就是本票的修复：刚由 FAB 展开的一次双击，第二次落点落在标题栏上不许当"收起"，且窗口用既有常量 FAB_LONG_PRESS_MS；实际：' + hdr);
    truthy(/this\.minimized = true;/.test(hdr), '放行方向仍是收起（守卫不许把收起功能整体废掉）');
    /* 反向：不许顺手拿别的东西（时间戳比较、setTimeout 定时器）代替一次性窗口 */
    falsy(/setTimeout|setInterval/.test(hdr), '不许为这个窗口新造定时器：距 fabOpenedAt 不足阈值就够判了');
  });

  await test('★ >600ms 之后 header dblclick **必须**照旧收起（正常"展开久了再双击标题栏"，不受影响）', () => {
    const src = read('src/features/important-note.js');
    truthy(/const FAB_LONG_PRESS_MS = 600;/.test(src),
      '窗口阈值复用既有常量（用户拍板 600ms），不许另造一个魔数');
    /* 窗口是"距展开不足阈值"，不是"展开过就不再收起" ⇒ 时间一过闸门自己失效。 */
    const hdrAt = src.indexOf("header.addEventListener('dblclick'");
    const hdr = src.slice(hdrAt, src.indexOf('});', hdrAt));
    truthy(/sinceFabOpen < FAB_LONG_PRESS_MS/.test(hdr), '闸门是**上界**比较（< 阈值）—— 若写成 <= 或去掉比较，长窗口会吃掉正常收起：' + hdr);
    /* 本票不许碰的另外两条收起通路：`—` 按钮（:1384-1389）与 FAB 自身。 */
    const minAt = src.indexOf("minBtn.addEventListener('click'");
    truthy(minAt >= 0, '`—` 按钮的收起通路不见了');
    const minSeg = src.slice(minAt, minAt + 220);
    truthy(/this\.minimized = true;/.test(minSeg), '`—` 按钮不受本守卫影响（它没有"同一次双击的第二次落点"这回事）');
    falsy(/fabOpenedAt/.test(minSeg), '`—` 按钮不许被卷进这个窗口');
    /* 这条闸只许出现在 header 上：别的收起入口（若以后新增）不许悄悄吃到它。
     * 先剥注释再数 —— 上面解释机制的那几行注释里也写着这个名字，不剥就把自己的说明数进去了。
     * 口径：代码里这个名字一共只该有 3 处落点 —— 实例字段默认值 / openPanel 的赋值 /
     * header 守卫那一行（它在同一行里读值、算差、清零所以出现 3 次，这是允许的）。 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const hits = (code.match(/fabOpenedAt/g) || []).length;
    truthy(hits === 5, 'fabOpenedAt 在代码里应恰好 5 次（字段 1 + openPanel 赋值 1 + header 守卫那一行的读/算/清零 3），实测 ' + hits);
    const codeHdr = code.slice(code.indexOf("header.addEventListener('dblclick'"), code.indexOf("minBtn.addEventListener('click'"));
    truthy((codeHdr.match(/fabOpenedAt/g) || []).length === 3, '窗口逻辑必须只长在 header 的双击收起步里');
  });

  /* ==========================================================================
   * 【T63 · 真机 e2e 抓到的真产品缺陷】命中词块的复制反馈被列表重建吃掉
   *
   * 现场：点图片命中卡片上的命中词 chip，产品给它加 `.copied`（成功）/ `.failed`（失败）并改
   * title，1200ms 后复位 —— 这是承诺给用户的反馈窗口。但 `renderImgSection()` 每次都把列表
   * **整体重建**（`this.imgListEl.textContent = ''`，:1554），而只要 OCR 状态一变
   * （`KH.ImgOcr.onChange(() => panel.renderImg())`，:1918）就会重建一次 ⇒ 被点的 chip 当场游离，
   * 类名留在死节点上，屏幕上的绿框约 1/4 秒就没了。
   * qa（T62）真机读数：点击后 `.copied` 在 ms≈17–21 出现；ms≈94–330 图片列表整段 childList 删+加；
   * ms≈306–335 被点的 chip 已 `connected:false`，活着的面板里同文本 chip 的类名已不含 copied。
   *
   * 修法（本套用例钉的就是它）：这份瞬时反馈从**节点状态**提升为**面板级待显示状态**
   * `panel.imgCopyMark = { key, ok, at }`；建 chip 时命中同一稳定键且仍在窗口内就把类与 title
   * 一并补上（重建自动重放）；窗口一到由 `imgClearCopyMark` 在**活着的**列表里按 `dataset.k`
   * 找回 chip 复位 —— 只用节点 classList 记状态，就必然被下一次重建吃掉。
   *
   * 装置说明（与上面 T40 / T52 同一条边界）：tests/harness.js 的 ShimElement **有**事件通道
   * （T38 起）与 dataset（本 rig 补的），但 document 的监听器仍是空实现（:357）——
   * 这里给原型临时补 `dataset`、用完原样还原（同 k76-r4 那个文件对
   * querySelector 的处理手法）；`setTimeout` 收进队列由用例自己触发（**不真等 1200ms**）；
   * 剪贴板成败由 navigator.clipboard 的有无决定（垫片没有 execCommand ⇒ 退回 legacyCopy 必然 false，
   * 失败态因此是**真实**走出来的，不是硬塞的）。面板实例照本文件既有手法：原型继承造影子面板。
   * ========================================================================== */

  suite('important-note · T38 垫片事件通道：面板装进页面 + click 委托（原来完全没跑过）');

  /** 往给定容器里放一张缩略图（真实 DOM 里 :1602 就是这么写 thumb.src 的） */
  const thumbIn = (into, src, alt) => {
    const im = H.el('img');
    im.setAttribute('src', src);
    im.setAttribute('alt', alt || '');
    into.appendChild(im);
    return im;
  };

  await test('★ T38-1 panel.ensure(document) 在垫片里不再抛：宿主进 body、wrap 记到 root、重复调用复用同一宿主', () => {
    const p = shadowPanel();
    const before = document.body.children.length;

    const host = p.ensure(document);

    truthy(host, 'ensure 必须有返回值（修前在 :1100 当场抛，连这一行都到不了）');
    eq(document.body.children.length, before + 1, '只许挂一个宿主进 body');
    /* ⚠️ 元素只能比引用，别交给 eq / truthy 的**自动报错串**：eq 是先把
     * `JSON.stringify(expected)` 与 `stringify(actual)` 拼好消息再断言 ⇒ 元素带 parentNode
     * 回环，即使两边相等也当场抛 "Converting circular structure to JSON"（本用例第一版就栽在这）。
     * 带 msg 的 truthy/falsy 不受影响（`msg || JSON.stringify(v)` 短路）。 */
    truthy(document.body.children[document.body.children.length - 1] === host,
      '新宿主就是刚 append 的那个');
    eq(host.id, 'kh-important-note-host', '宿主 id 走唯一真源 HOST_ID');
    eq(host.getAttribute('data-kh-ext-ui'), '1',
      '自身 UI 标记：内容脚本的清理 / observer / 悬停命中都靠它整体跳过');
    truthy(p.root && p.root.classList.contains('khin-wrap'),
      'ensure 要把 .khin-wrap 记到 root —— 下面那条 click 委托就挂在它上面');
    truthy(p.ensure(document) === host,
      '宿主已经在 body 里（isConnected）⇒ 重复 ensure 必须复用它');
    eq(document.body.children.length, before + 1, '重复调用后 body 里的宿主数量不变');
  });

  await test('★ T38-2 冒泡 click 走 :1100 的委托：点影子根里的缩略图 ⇒ 灯箱打开并显示这张图', () => {
    const p = shadowPanel();
    p.ensure(document);
    /* 包一层 div：监听器在 root、目标 img 是孙辈 ⇒ 这条命中的是**冒泡**。
     * 若有人把处理器改成直接绑在 img 上，真机点缩略图的通路照样断，这里是钉子。 */
    const wrap = H.el('div');
    const im = thumbIn(wrap, 'https://ex.com/a.png', '甲');
    p.root.appendChild(wrap);

    const before = document.body.children.length;
    im.dispatchEvent({ type: 'click' });

    const fresh = document.body.children.slice(before);
    eq(fresh.length, 1, '点缩略图必须新建一个灯箱宿主（0 = 委托没跑；>1 = 装了两次）');
    eq(fresh[0].id, 'kh-note-lightbox', '宿主 id 走唯一真源 LIGHTBOX_ID');
    const sr = fresh[0].shadowRoot;
    truthy(sr.querySelector('.kh-lb'), '灯箱容器要在影子根里');
    eq(sr.querySelector('.kh-lb-img').getAttribute('src'), 'https://ex.com/a.png',
      '灯箱里那张图必须就是被点的那张 —— 打开态的硬证据（只在 apply() 里写）');
  });

  await test('★ T38-3 反向：点非 IMG、或 IMG 没有 src ⇒ 不许开灯箱（同时证明上面那条不是空断言）', () => {
    const p = shadowPanel();
    p.ensure(document);
    const wrap = H.el('div');
    const im = thumbIn(wrap, 'https://ex.com/a.png', '甲');
    const chip = H.el('span');
    chip.textContent = '一对一';
    wrap.appendChild(chip);
    const noSrc = H.el('img');                     // IMG 但没有 src
    wrap.appendChild(noSrc);
    p.root.appendChild(wrap);

    const before = document.body.children.length;
    chip.dispatchEvent({ type: 'click' });         // 委托第一行 `t.tagName !== 'IMG'` 就该 return
    noSrc.dispatchEvent({ type: 'click' });        // `!t.src` 同样 return
    eq(document.body.children.length, before, '点这两种都不许新建灯箱宿主');

    im.dispatchEvent({ type: 'click' });           // 反向用例的另一半：同一个装置里点真 IMG 必须开
    eq(document.body.children.length, before + 1,
      '同一装置里点真 IMG 必须开 —— 否则上面那条"没开"是空断言（装置坏了也说没开）');
  });

  await test('★ T38-4 垫片事件通道本身：注册序 / stopPropagation / removeEventListener / target', () => {
    const parent = H.el('div');
    const child = H.el('span');
    parent.appendChild(child);
    const seq = [];
    const a = () => seq.push('a');
    const b = (e) => { seq.push('b'); e.stopPropagation(); };
    child.addEventListener('click', a);
    child.addEventListener('click', b);
    parent.addEventListener('click', (e) => seq.push('parent:' + (e.target === child)));

    child.dispatchEvent({ type: 'click' });
    eq(seq.join(','), 'a,b',
      '同一元素上的多个监听器按注册序执行；stopPropagation 之后不再往祖先冒泡');

    child.removeEventListener('click', b);
    seq.length = 0;
    child.dispatchEvent({ type: 'click' });
    eq(seq.join(','), 'a,parent:true',
      '摘掉监听器后冒泡恢复；target 是**被派发的那个节点**，不是当前正在跑的监听器宿主');
  });

  await test('★ T38-5 window 事件通道（需求 1 的垫片前提）：window 就是 global，现给它 add/remove + __khFire', () => {
    eq(typeof window.addEventListener, 'function', 'window 上必须有 addEventListener（生产代码挂 resize 靠它）');
    eq(typeof window.removeEventListener, 'function', 'window 上必须有 removeEventListener');
    eq(typeof window.__khFire, 'function', '要有派发口，单测才谈得上"派发一次 resize"');
    const seq = [];
    const a = () => seq.push('a');
    const b = () => seq.push('b');
    window.addEventListener('resize', a);
    window.addEventListener('resize', b);
    window.__khFire('resize');
    eq(seq.join(','), 'a,b', '按注册序派发');
    window.removeEventListener('resize', a);
    seq.length = 0;
    window.__khFire('resize');
    eq(seq.join(','), 'b', 'removeEventListener 真摘掉（不是只摆个空实现）');
    window.removeEventListener('resize', b);
    seq.length = 0;
    window.__khFire('resize');
    eq(seq.join(','), '', '摘干净后再派发不该有回调');
  });

  /* ==================================================================
   * 2.0.2.4 需求②：**同一张图只占一行**
   *
   * 【用户原话】「关键词a，抓取字段：截图，图片命中词，一对一；关键词b，抓取字段：截图，
   *   图片命中词，美女。这种情况会重复识别，浪费资源。」引擎侧只识别一次由 ocr-long-image
   *   那条端到端钉住；这里钉面板侧：同一张图（同 `src`）的多条命中并成一行，**每个关键词
   *   各占一行命中词块**，不许把命中词丢掉、也不许把两个词的关键词头糊成一个。
   * ================================================================== */
  suite('important-note · 置顶排序：解析口径（最多 3 个 / 分隔符 / 去空去重 / 坏值不抛）');

  const cfgPin = (v) => ({ importantNote: { pinOrder: v } });

  await test('★ 三种分隔符 + 逐项 trim：逗号 / 中文逗号 / 顿号', () => {
    H.deepEq(head.parsePins(cfgPin('甲, 乙，丙')), ['甲', '乙', '丙']);
    H.deepEq(head.parsePins(cfgPin(' 甲 、乙,丙 ')), ['甲', '乙', '丙']);
  });

  await test('★ 换行也算分隔符，空项（含纯空白项）直接丢', () => {
    H.deepEq(head.parsePins(cfgPin('甲\n乙\n\n丙')), ['甲', '乙', '丙']);
    H.deepEq(head.parsePins(cfgPin(' , 甲 ,, 乙 , ')), ['甲', '乙']);
    H.deepEq(head.parsePins(cfgPin('甲，,、乙')), ['甲', '乙']);
  });

  await test('★ 超过 3 项只取前 3（"最多 3 个"由代码判，不靠用户自觉）', () => {
    H.deepEq(head.parsePins(cfgPin('a,b,c,d,e')), ['a', 'b', 'c']);
    H.deepEq(head.parsePins(cfgPin(['a', 'b', 'c', 'd'])), ['a', 'b', 'c'], '数组形态同样截断');
  });

  await test('★ 去重按首次出现（匹配不区分大小写 ⇒ 去重也必须不区分，否则同一个词占两格）', () => {
    H.deepEq(head.parsePins(cfgPin('甲, 甲, 乙')), ['甲', '乙']);
    H.deepEq(head.parsePins(cfgPin('Abc, abc, def')), ['Abc', 'def'], '保留用户第一次写的形态');
  });

  await test('★ 坏值/缺配置 → 空列表（配置是信任边界，不许抛）', () => {
    H.deepEq(head.parsePins(null), []);
    H.deepEq(head.parsePins({}), []);
    H.deepEq(head.parsePins({ importantNote: {} }), []);
    H.deepEq(head.parsePins(cfgPin('')), []);
    H.deepEq(head.parsePins(cfgPin('   ')), []);
    H.deepEq(head.parsePins(cfgPin(123)), [], '非字符串不置顶（也不许把 123 当关键词）');
    H.deepEq(head.parsePins(cfgPin(null)), []);
    H.deepEq(head.parsePins(cfgPin(['甲', null, ' 乙 ', ''])), ['甲', '乙'], '数组里的空项照丢');
  });

  suite('important-note · 置顶排序：排序口径（稳定 / 精确相等 / 取最靠前下标）');

  /* 五张卡：关键词 甲..戊，笔记 N甲..N戊（note 用来对 DOM 顺序取名） */
  const fiveCards = () => head.build([
    hit('甲', '', 'N甲'), hit('乙', '', 'N乙'), hit('丙', '', 'N丙'),
    hit('丁', '', 'N丁'), hit('戊', '', 'N戊')
  ], new Set());
  const kwOrder = (arr) => arr.map((it) => it.entries[0].kw).join('');
  const pin = (v) => head.parsePins(cfgPin(v));

  await test('★ 回归钉：空配置 = 行为与今天逐字节一致（原序、原数组内容）', () => {
    eq(kwOrder(head.sortByPins(fiveCards(), [])), '甲乙丙丁戊', '空配置不许动顺序');
    eq(kwOrder(head.sortByPins(fiveCards(), pin(''))), '甲乙丙丁戊');
    eq(kwOrder(head.sortByPins(fiveCards(), pin('   '))), '甲乙丙丁戊');
    eq(kwOrder(head.sortByPins(fiveCards(), pin('不存在'))), '甲乙丙丁戊', '匹配不上的关键词静默忽略');
  });

  await test('★ 单条置顶命中：第 3 位那张跳到第 1 位', () => {
    eq(kwOrder(head.sortByPins(fiveCards(), pin('丙'))), '丙甲乙丁戊');
  });

  await test('★ 两条置顶：按填写顺序（后填的排在前填的后面）', () => {
    eq(kwOrder(head.sortByPins(fiveCards(), pin('丁, 乙'))), '丁乙甲丙戊');
    eq(kwOrder(head.sortByPins(fiveCards(), pin('乙, 丁'))), '乙丁甲丙戊', '反着填就是反着的顺序');
  });

  await test('★ 未命中卡片保持原相对顺序（五张钉住：置顶卡只是"抽到前面"，其余不动）', () => {
    eq(kwOrder(head.sortByPins(fiveCards(), pin('戊'))), '戊甲乙丙丁');
    eq(kwOrder(head.sortByPins(fiveCards(), pin('丙, 甲'))), '丙甲乙丁戊');
    eq(kwOrder(head.sortByPins(fiveCards(), pin('乙, 戊'))), '乙戊甲丙丁');
  });

  await test('★ 一张卡命中两个置顶项 ⇒ 取最靠前的那个下标（不是最后一个）', () => {
    /* 卡 A：note=N乙（单个关键词 乙）；卡 B：note=N共（两个关键词 乙、甲）。
     * 原序 [A, B]，置顶表 ['甲','乙']：B 命中下标 1 与 0 ⇒ 取 0 ⇒ B 必须排到 A 前面。
     * 若实现取"最后一个匹配项"，B 的下标会算成 1、与 A 并列，稳定排序下顺序不变 ⇒ 本断言会红。 */
    const cards = head.build([hit('乙', '', 'N乙'), hit('乙', '', 'N共'), hit('甲', '', 'N共')], new Set());
    eq(cards.length, 2, '两张卡：一张单词卡、一张两词卡');
    eq(cards.map((it) => it.note).join(','), 'N乙,N共', '原序：单词卡在前');
    eq(head.sortByPins(cards, pin('甲, 乙')).map((it) => it.note).join(','), 'N共,N乙',
      '两词卡命中更靠前的下标 ⇒ 排在单词卡前面');
  });

  await test('★ 超过 3 项：第 4 项不生效（前 3 条才置顶）', () => {
    eq(kwOrder(head.sortByPins(fiveCards(), pin('戊, 丁, 丙, 甲'))), '戊丁丙甲乙');
  });

  await test('★ 大小写与首尾空白容错（中文无感，英文大小写混写很常见）', () => {
    const cards = head.build([hit('abcd', '', 'N1'), hit('ABC', '', 'N2')], new Set());
    eq(head.sortByPins(cards, pin(' abc ')).map((it) => it.note).join(','), 'N2,N1',
      '" abc " 要命中 "ABC"');
    eq(head.sortByPins(cards, pin('ABCD')).map((it) => it.note).join(','), 'N1,N2',
      '"ABCD" 要命中 "abcd"');
  });

  await test('★ 精确相等，不做包含匹配（"abc" 不许把 "abcd" 也顶上去）', () => {
    const cards = head.build([hit('abcd', '', 'N1'), hit('x', '', 'N2')], new Set());
    eq(head.sortByPins(cards, pin('abc')).map((it) => it.note).join(','), 'N1,N2');
  });

  await test('★ 纯函数：返回新数组，不动入参（render 会反复拿同一批 items 重排）', () => {
    const src = fiveCards();
    const out = head.sortByPins(src, pin('戊'));
    truthy(out !== src, '必须返回新数组');
    eq(kwOrder(src), '甲乙丙丁戊', '入参顺序原样保留');
    eq(kwOrder(out), '戊甲乙丙丁', '返回值才是置顶后的顺序');
  });

  await test('★ 重排真的落到 DOM：renderItems 按 this.items 的顺序铺卡', () => {
    const p = shadowPanel();
    p.bodyEl = H.el('div');
    p.items = head.sortByPins(fiveCards(), pin('戊、丙'));
    p.renderItems();
    const notes = p.bodyEl.querySelectorAll('.khin-item-note').map((el) => el.textContent);
    eq(notes.join(','), 'N戊,N丙,N甲,N乙,N丁', 'DOM 里的卡片顺序 = 置顶后的顺序（未命中的三张保持甲乙丁）');
  });

  suite('important-note · 置顶排序：改配置立刻重排（脏判据）');

  await test('★ 改 pinOrder 必须重排面板；同配置重复 render 不许重建', () => {
    /* 【这条是本需求最容易漏的一步】`head.changed(old, new)` 只比"每张卡的内容"
     * （长度 + 每卡 note/bg/字号/词条集合），**卡间顺序变了它照样返回 false**
     * ⇒ 不把置顶签名并进脏判据，用户改了「置顶排序」屏上不会重排（render 走 else 只刷图片分区）。
     * 反向那条同样重要：不许把脏判据写成"永远为真"来糊过去。 */
    const p = shadowPanel();
    const cards = fiveCards();
    let content = 0;        // renderContent 次数（= 列表重建）
    let imgOnly = 0;        // 局部刷新次数（= 只补命中标记 + 截图卡，笔记卡片不动）
    /* 本用例只钉"顺序变没变"这一个判据 ⇒ 把两个渲染出口换成本地探针（分开计数：
     * 不重建时走的是 renderImgSection，混在一起数就把"没重建"误读成"重建了"）；
     * `panelEl` 先给个非空桩（真壳由 renderContent 建，这里换掉了，所以得自己摆上），
     * 否则 `!this.panelEl` 会让每一轮都判脏，"同配置不重建"那条反证就测不出来了。 */
    p.panelEl = H.el('div');
    p.renderContent = () => { content += 1; };
    p.applyImgMarks = () => {};
    p.renderCtxCard = () => { imgOnly += 1; };
    p.show = () => {};
    const ocr = KH.ImgOcr;
    const savedItems = ocr && ocr.items;
    if (ocr) ocr.items = () => [];          // 本用例只钉"笔记卡片的重排"，图片分区不参与
    try {
      p.render(cards, cfgPin('丙'));
      eq(kwOrder(p.items), '丙甲乙丁戊', '第一轮：丙置顶');
      truthy(content > 0, '外壳未建 ⇒ 第一轮必须走 renderContent');

      const n1 = content;
      p.render(cards, cfgPin('戊'));
      eq(kwOrder(p.items), '戊甲乙丙丁', '第二轮：换成戊置顶 ⇒ items 顺序跟着变');
      truthy(content > n1,
        '★ 只改了置顶项也必须重排（head.changed 对同内容卡返回 false，光靠它这里不会重建）');

      const n2 = content;
      p.render(cards, cfgPin('戊'));
      eq(content, n2, '反证：同配置重复 render 不许重建（否则上面那条就成了"永远脏"）');
      eq(imgOnly, 1, '且必须落到"只补命中标记 + 截图卡"那一支（没重建 ≠ 什么都没做）');
      eq(kwOrder(p.items), '戊甲乙丙丁');
      p.render(cards, cfgPin('戊, 戊, 戊'));
      eq(content, n2, '归一后等价的写法（同一词多写几遍）⇒ 也不该重建');
      p.render(cards, cfgPin('戊, 甲, 乙'));
      truthy(content > n2, '换成别的置顶表（前 3 位变了）⇒ 必须重建');
    } finally {
      if (ocr) ocr.items = savedItems;
    }
  });

  await test('★ 接线契约：排序在 render 里做、脏判据里带置顶签名', () => {
    const src = read('src/features/important-note.js');
    const rgx = src.slice(src.indexOf('render(items, cfg) {'), src.indexOf('renderContent() {'));
    truthy(/head\.sortByPins\(items/.test(rgx), 'render 必须按 pinOrder 排卡片');
    truthy(/head\.parsePins\(cfg\)/.test(rgx), '置顶表必须从 cfg 现取（不许缓存成常量）');
    truthy(/this\.pinSig !== pinSig/.test(rgx),
      '★ 脏判据必须含置顶签名（head.changed 只看每卡内容，卡间顺序变了它返回 false）');
  });

  suite('important-note · 置顶排序：设置页接线（2.0.2.6 需求②：下拉框 + 胶囊）');

  await test('★ 设置页「样式 → 重要笔记」用下拉框选、胶囊展示，不裹 details', () => {
    const html = read('options/options.html');
    const sec = (html.match(/<section[^>]*id="sec-style"[\s\S]*?<\/section>/) || [''])[0];
    truthy(sec.length > 0, '要能定位「样式」分区');
    truthy(sec.indexOf('<select class="kh-input" id="pf-notePinOrder"></select>') >= 0,
      '★ 置顶排序必须是**空的下拉框**（候选由 JS 按当前关键词表填 —— 写死选项等于把词库抄进 HTML）');
    falsy(/<input[^>]*id="pf-notePinOrder"/.test(sec),
      '★ 不再是手填文本框（手填＝要用户自己敲分隔符、还得自己记住上限）');
    truthy(/class="kh-lbl-preview" id="pin-caps"/.test(sec),
      '★ 已置顶的项要用胶囊展示（复用「抓取字段」那套 `.kh-lbl-*` 控件语言，不新造一套）');
    falsy(sec.indexOf('<details') >= 0, '★ 「样式」分区里不许出现折叠的 <details>（_e2e/ui.test.js:48-71 的现场缺陷）');
    truthy(sec.indexOf('置顶排序') >= 0, '标签文案要带「置顶排序」（跟着分区里既有控件的命名习惯）');
    truthy(sec.indexOf('id="pin-max"') >= 0, '「最多 N 个」的 N 要有可注入的锚点（数字不写死在文案里）');
    /* 该分区原来写「三个都只是**默认值**」，现在有四个控件，数量词必须跟着改 */
    truthy(sec.indexOf('四项都只是') >= 0, '★ 「N 项都只是默认值」的数量词要跟着控件数改（现在四项）');
    falsy(sec.indexOf('三个都只是') >= 0, '文案不许再停在「三个都只是」');
    falsy(sec.indexOf('四个都只是') >= 0, '文案不许再停在「四个都只是」');
  });

  await test('★ 设置页接线：候选来自关键词表、选中追加到末位、落盘过同一处归一', () => {
    const js = read('options/options.js');
    truthy(js.indexOf("$('pf-notePinOrder')") >= 0, '下拉框必须在 options.js 里接线');
    truthy(/KH\.Config\.pinOrderKeys\(\(cfg\.importantNote \|\| \{\}\)\.pinOrder\)/.test(js),
      '★ 回显与"再加一个"都要从 pinOrderKeys 现取（上限 / 拆项 / 去重只在这一处判）');
    truthy(/saveNested\(\{ importantNote: \{ pinOrder: KH\.Config\.normalizePinOrder\(cur\.concat\(\[id\]\)\) \} \}\)/.test(js),
      '新增走 normalizePinOrder（上限 3 / 去重一处判），落盘走嵌套子键 importantNote.pinOrder');
    truthy(/saveNested\(\{ importantNote: \{ pinOrder: KH\.Config\.normalizePinOrder\(cur\.filter/.test(js),
      '胶囊上的 ✕ 也要走同一个归一函数回来');
    truthy(/renderPinOrder\(\)/.test(js), '候选与胶囊必须在 renderAll 里重建（关键词增删改后要跟着变）');
    truthy(/disabled: taken/.test(js) && /const taken = cur\.some\(/.test(js),
      '★ 已置顶的不再出现在候选里（同一个词只能占一个位次；要换位置先 ✕ 掉再选）');
    truthy(js.indexOf("$('pin-max').textContent = KH.Config.NOTE_PIN_MAX") >= 0,
      '标签里的「最多 N 个」必须从 NOTE_PIN_MAX 注入（不许有第二份 3）');
    /* 【2.0.2.7】胶囊骨架**只有一份**（fields.js 的 labelChip）—— 这里曾照抄过一份，
     * 于是改结构要改两处、漏一处的表现是"设置页的胶囊长得不一样" */
    truthy(/ui\.Fields\.labelChip\(\{/.test(js), '★ 胶囊骨架必须走共享工厂 ui.Fields.labelChip（不许在这里手抄第二份）');
    falsy(js.indexOf("class: 'kh-lbl-chip'") >= 0, '★ 设置页里不许再出现手写的胶囊结构（`class: \'kh-lbl-chip\'`）');
  });

  /* 【2.0.2.17 需求⑥ → 2.0.4 需求①收严】图片 OCR 命中后把「键：值」行并进抓取字段表，
   * 但**必须先对那个词配后缀标记**（`#表`/`#kv`）：没标记的词只做命中判定，一行都不进表。 */
  await test('★ 需求①：只有配了后缀标记的词才进表，标题格=命中词、值=分隔符之后', () => {
    const IN = KH.ImportantNote;
    const orig = KH.ImgOcr;
    KH.ImgOcr = {
      kvWords: orig.kvWords,      // 标记语法的唯一实现在真模块里，桩不许另写一份
      items: () => ([
        { ruleId: 'r6', key: 'r6|a', state: 'done',
          text: '计算机软件著作权登记证书\n登 记 号： 2018SR458983\n著 作 权 人： 某某公司' },
        { ruleId: 'r6', key: 'r6|b', state: 'done',
          text: '登 记 号： 2018SR458983' },
        { ruleId: 'r-other', key: 'x', state: 'done', text: '登记号：别的词' },
        { ruleId: 'r6', key: 'r6|c', state: 'pending', text: '' }
      ])
    };
    try {
      const meta = { pinId: 'r6', imgOcr: true, imgOcrKeyword: '登记号#表|著作权人' };
      eq(JSON.stringify(IN.ocrExtraRows(meta)),
        JSON.stringify([{ label: '登记号', value: '2018SR458983' }]),
        '「登 记 号」被 OCR 读散也要认；「著作权人」没标记 ⇒ 不进表；两张图同值只留一条；别的规则不算');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { imgOcrKeyword: '登记号' }))), '[]',
        '★ 收严：没配后缀标记 ⇒ 一行都不进表（旧版是"所有命中行都进表"）');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { imgOcr: false }))), '[]', '没勾「识别图片文字」⇒ 不补行');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { pinId: 'r-none' }))), '[]', '别的规则的结果不许串味');
      eq(JSON.stringify(IN.ocrExtraRows(null)), '[]', '没有 meta ⇒ 安全返回空');
    } finally { KH.ImgOcr = orig; }
  });

  await test('★ 需求⑥：OCR 结果异步回来时**笔记跟着重建**（否则用户要等页面变动才看得到新行）', () => {
    const src = read('src/features/important-note.js');
    const frag = (src.match(/KH\.ImgOcr\.onChange\(\(\) => \{[\s\S]*?\n    \}\);/) || [''])[0];
    truthy(frag.length > 0, '要能定位到 OCR 变更回调');
    truthy(/panel\.refresh\(\)/.test(frag), '★ OCR 结果变了必须重建笔记（面板不只是图片分区）');
    truthy(/ocrNoteSig\(\)/.test(frag), '要用指纹挡一道，别让每次状态抖动都重画整块笔记');
  });

  /* ==========================================================================
   * 需求④：悬浮窗反复重建闪烁 / 拖动卡顿（2.0.6.1）
   * ==========================================================================
   * 用户原话：「重要笔记悬浮窗反复重建闪烁、拖动卡顿不跟手…尤其是重建闪烁问题，
   * 无操作、无变动也自动重建」。锁三条判据（都是源码契约，行为由真机覆盖）：
   *   ① 收起态计数没变就不重写 FAB（旧写法每轮重扫都换新元素 = 无变动也闪）
   *   ② 拖动按一帧一次落位（旧写法每个 pointermove 都写 left/top）
   *   ③ 卡片重建时按 src 复用旧 <img>（旧写法换新元素 = 图重新解码闪一下）
   */
  suite('重要笔记面板不许无意义重建（2.0.6.1 需求④）');

  await test('★ 收起态计数没变 ⇒ 不重写 FAB（无操作无变动不该闪）', () => {
    const src = read('src/features/important-note.js');
    truthy(/fabNow && this\.fabCount === count/.test(src), '计数没变必须早退，不许无条件 root.innerHTML');
    truthy(/this\.fabCount = -1;/.test(src), '展开态换了 DOM 必须把计数标记重置（否则收回来时 FAB 是空的）');
  });

  await test('★ 拖动按一帧一次落位（指针事件比屏幕刷新快）', () => {
    const src = read('src/features/important-note.js');
    truthy(/requestAnimationFrame\(flush\)/.test(src), '落位必须走 rAF 合并');
    truthy(/cancelAnimationFrame\(rafId\)/.test(src), '抬手要取掉待执行的那一帧');
    truthy(/const up = \(\) => \{[\s\S]{0,200}?flush\(\);/.test(src), '★ 抬手先同步 flush，否则停在上一帧（看着像丢帧/不跟手）');
  });

  await test('★ 卡片重建时按 src 复用旧图（不让 <img> 重新解码闪一下）', () => {
    const src = read('src/features/important-note.js');
    truthy(/function carryImgs\(from, to\)/.test(src), '复用逻辑要抽成单点');
    truthy(/carryImgs\(prevEl, el\);/.test(src), '★ 建新卡时要把旧卡的图搬过来');
    truthy(/olds\.delete\(s0\)/.test(src), '同一张旧图只搬一次（同图可能出现两次）');
  });
};
