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
    /* 「面板里不许出现这两句字面量」这条静态哨兵已迁到 scripts/meta-check.js 的红线列表。 */
    truthy(src.indexOf('more.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.moreHits') >= 0,
      '悬停说明要在 renderTags 的 DOM 层挂（字符串层不带 title 属性）');
  });

  await test('★ 契约：展开/收起就地重画标签区（不走 refresh/render ⇒ head.changed 不脏也能更新）', () => {
    /* 真跑 renderTags：同一个容器画三遍（原样 / 展开 / 收起 / 选过一条），
     * 并盯住 refresh()/render() 一次都不许被调 —— 它们在 head.changed 判"不脏"时是整个空转的，
     * 走它们等于"点了小标屏上没反应"（这条契约的存在理由）。
     * （旧写法按行切函数体正则找 `this.refresh(` —— 换行/抽小函数就假红，且证明不了运行结果。） */
    const panel = KH.ImportantNote.panel;
    truthy(panel.expandedTags instanceof Set, '展开态要挂面板侧（head 每次重建会把状态清掉）');
    truthy(panel.pickedTags instanceof Map, '选中态要挂面板侧');

    const p = shadowPanel();
    p.expandedTags = new Set();          // 影子面板用自己的集合/映射，别污染真面板单例
    p.pickedTags = new Map();
    let refreshes = 0;
    let renders = 0;
    p.refresh = () => { refreshes += 1; };
    p.render = () => { renders += 1; };

    const item = { note: '甲', entries: [{ kw: '长词条甲', adj: '' }, { kw: '短', adj: '' }] };
    const tagsEl = H.el('div');
    p.renderTags(tagsEl, item);
    truthy(tagsEl.innerHTML.indexOf('短') >= 0, '未展开时只展示最短那条命中（就地画进传入的容器）');
    eq(tagsEl.querySelectorAll('.khin-tag-list').length, 0, '未展开时不许出下拉列表');

    p.expandedTags.add(item.note);
    p.renderTags(tagsEl, item);
    eq(tagsEl.querySelectorAll('.khin-tag-list').length, 1, '展开后下拉列表要出现在同一个容器里');
    eq(tagsEl.querySelectorAll('.khin-tag-item').length, 2, '下拉要列出全部命中');

    p.expandedTags.delete(item.note);
    p.renderTags(tagsEl, item);
    eq(tagsEl.querySelectorAll('.khin-tag-list').length, 0, '收起后列表必须回到没有（还是同一个容器）');

    p.pickedTags.set(item.note, 0);      // 用户在列表里选了第一条
    p.renderTags(tagsEl, item);
    truthy(tagsEl.innerHTML.indexOf('长词条甲') >= 0, '选过的条目要成为展示的那一条');

    eq(refreshes, 0, '★ 不许走 refresh()（head.changed 判不脏 ⇒ 整条 render 会空转）');
    eq(renders, 0, '★ 不许走 render()（同上）');
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
    /* 2.0.8.13 需求③：垂直留白收窄（外 6→5、内 7→5）以露出更多首屏卡片；
     * **水平仍是 10**，与 -62px 减数同源。行首锚定是为了跳过深色主题里的 :host(...) .khin-item 规则。 */
    const item = (src.match(/(?:^|\n)    \.khin-item \{[\s\S]*?\n    \}/) || [''])[0];
    truthy(/margin:\s*0 6px 5px/.test(item) && /padding:\s*5px 10px/.test(item) && /border:\s*1px/.test(item),
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
    /* 配置 → 面板的接线：真跑一次 render，直接看 CSS 变量上落下来的值。
     * 以前这里靠正则找 `setProperty('--khin-panel-w', ⏎ …)`（精确到换行缩进）与函数名 ——
     * 等价改写就假红，而"到底写没写上去"仍然没人证明。 */
    const p = shadowPanel();
    p.render([], { notePanelWidth: 320 });
    eq(p.root.style.getPropertyValue('--khin-panel-w'), '320px',
      '面板宽度必须由 render() 从 cfg.notePanelWidth 写到 CSS 变量上（否则设置页改了面板不理）');
    const q = shadowPanel();
    q.render([], { notePanelWidth: 9999 });
    eq(q.root.style.getPropertyValue('--khin-panel-w'), KH.Config.PANEL_WIDTH_MAX + 'px',
      '越界值必须经 config 的唯一归一函数夹到上界（渲染层不许自己复制一份边界）');
    /* consume(hits, cfg) 必须把 cfg 交给 render —— 否则上面那条在真实链路上永远拿不到用户选的值 */
    const src = read('src/features/important-note.js');
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



  /* 【2.0.2.17 需求①】字段名格不再带后缀 ⇒ 补包裹回到「整格文本包一层」这最简单的一步。
   * 只锁源码形状：垫片的 `ShimElement` 没有 `firstChild`，`noteFragment` 的搬移循环在 node 环境里跑不起来
   * （上面那条"历史笔记同样生效"也是源码断言，同一原因）；真机行为由 `_e2e/ui.test.js` 覆盖。 */

  suite('important-note · 面板 UI 修复批（T29）');

  /** 单行规则（`{ … }` 不换行的那种）—— CSS_OF 用的是"到下一个 4 空格缩进的 }"，单行规则会多吞。 */
  const RULE = (src, sel) => (src.match(new RegExp(sel.replace(/\./g, '\\.').replace(/\s+/g, '\\s+') + ' \\{[^}]*\\}')) || [''])[0];



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


  /* ==========================================================================
   * T60 回归：「双击收起态 FAB 无法展开面板」——真机 e2e（_e2e/content.test.js
   * 「★ 双击标题栏收起为圆形 FAB，再双击展开」）第二步红，`.khin-panel` 300ms 后不存在。
   *
   * 机制（源码全路径，逐行可核）：一次鼠标双击 = down/up/click(1) → down/up/click(2) → dblclick。
   *   · click(1) 落点 = FAB 中心：`important-note.js` 的 click 过三道具后调 openPanel()
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

  /* ==========================================================================
   * 四态入口（2026-11-03 用户拍板 A：贴边条 / 摘要列 / 手风琴 / 浮窗）。
   * 旧 T60 用例钉的是「FAB 展开同一秒内双击标题栏不许收起」——FAB 入口已删，默认形态变成
   * 贴边条；双击标题栏的新语义是「浮窗 → 贴边条」，不再有「FAB 换壳后第二次落点撞 header」。
   * 该竞态守卫仍保留在 header 里（fabOpenedAt 窗口），所以下面仍钉住它，但不再钉 FAB 源码。
   * ========================================================================== */

  suite('important-note · 四态入口：贴边条悬停/点击 + 浮窗标题栏双击回贴边');



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


  suite('important-note · 置顶排序：设置页接线（2.0.2.6 需求②：下拉框 + 胶囊）');


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
   * 但**必须先对那个词配后缀标记**（`#表`/`#kv`）：没标记的词只做命中判定，一行都不进表。
   * 【2.0.10.1】证书/授权书另有结构化自动抽取（ocr-auto.js）：它不看 `#表`，
   * 认得出文档类型就补行 —— 所以这张证书用例里「著作权人」会被自动抽出来。 */
  await test('★ 需求①：只有配了后缀标记的词走命中词进表；证书类文档另有自动抽取补行', () => {
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
        JSON.stringify([
          { label: '登记号', value: '2018SR458983' },
          { label: '著作权人', value: '某某公司' }
        ]),
        '「登 记 号」被 OCR 读散也要认；「著作权人」没 #表 不走命中词路径，但证书类自动抽取会补它；两张图同值只留一条');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { imgOcrKeyword: '登记号' }))),
        JSON.stringify([
          { label: '著作权人', value: '某某公司' },
          { label: '登记号', value: '2018SR458983' }
        ]),
        '★ 一个 #表 都没配：命中词一行都不进表，只剩证书自动抽取的两行（顺序按证书字段表）');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { imgOcr: false }))), '[]', '没勾「识别图片文字」⇒ 不补行');
      eq(JSON.stringify(IN.ocrExtraRows(Object.assign({}, meta, { pinId: 'r-none' }))), '[]', '别的规则的结果不许串味');
      eq(JSON.stringify(IN.ocrExtraRows(null)), '[]', '没有 meta ⇒ 安全返回空');
    } finally { KH.ImgOcr = orig; }
  });


  /* 【2026-11-11 需求④】用户口径：「授权方、被授权方这种进表内容，只取公司名，后面冗余部分不要。
   * 登记号同理，只要那一串代码。」只对明确语义的字段动手。 */
  await test('★ 需求④：进表值按字段语义收窄（授权方只留公司名、登记号只留代码）', () => {
    const IN = KH.ImportantNote;
    const orig = KH.ImgOcr;
    KH.ImgOcr = {
      kvWords: orig.kvWords,
      items: () => ([{
        ruleId: 'r7', key: 'r7|a', state: 'done',
        text: '授权方：北京某某科技有限公司（以下简称“甲方”）\n'
          + '被授权方：上海某某信息技术有限公司，授权期限三年\n'
          + '登记号：2018SR458983 证书号 软著登字第12345号\n'
          + '著作权人：某某工作室\n'
          + '版本号：v1.2.3 build 2026'
      }])
    };
    try {
      const rows = IN.ocrExtraRows({
        pinId: 'r7', imgOcr: true,
        imgOcrKeyword: '授权方#表|被授权方#表|登记号#表|著作权人#表|版本号#表'
      });
      const got = {};
      rows.forEach((r) => { got[r.label] = r.value; });
      eq(got['授权方'], '北京某某科技有限公司', '只留公司名，去掉「（以下简称…）」');
      eq(got['被授权方'], '上海某某信息技术有限公司', '逗号后的授权期限不算公司名');
      eq(got['登记号'], '2018SR458983', '只要那串登记代码，后面的证书号不要');
      eq(got['著作权人'], '某某工作室', '工作室也是单位名，原样保留');
      eq(got['版本号'], 'v1.2.3 build 2026', '普通字段不裁剪（裁错比不裁更伤人）');
    } finally { KH.ImgOcr = orig; }
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


  /* ==========================================================================
   * 2.0.8.9 需求②③（源码契约，行为由真机 e2e 覆盖）
   * ==========================================================================
   * ② 用户原话：「请改成默认悬窗，贴边模式才应该是备选」「贴标模式展开后，不需要那个
   *    缩略内容了，无端的占位置」。
   * ③ 用户原话：「只有贴边模式有？以及需要优化，疑似不生效（隐私政策里面有，但是出现
   *    小标提示没有。而且有时候底色变绿了，还是有小标且说没有）」。
   *    ⇒ 两条根因：徽标写进左列污染字段名；浮窗复用旧卡时压根不跑 decorateChecks。
   */
  suite('2.0.8.9 默认悬窗 / 展开收掉缩略 / 合规小标（需求②③）');

  /* 【台账 #2 · 2.0.10.6】用户拍板 A：只留悬窗，贴边条与摘要列整条删掉。
   * 这一条从「默认值必须是 float」改成「再也没有第二种形态可切」。 */
  await test('只剩一种形态：悬窗（贴边条 / 摘要列已删净）', () => {
    const src = read('src/features/important-note.js');
    falsy(/mode:\s*'(float|rail|list)'/.test(src), '`panel.mode` 这个概念必须消失，否则还剩第二条路径');
    falsy(/setMode\(|renderRailContent\(|renderRows\(/.test(src), '切形态 / 贴边 / 摘要列的入口要一起删');
    truthy(/minimized: false/.test(src), '收起态仍由 minimized 记（换回 FAB）');
    truthy(/data-act="collapse"/.test(src), '头部按钮改成「收起」，不再是「贴边」');
  });

  await test('贴边条与摘要列的样式已删净（不留死选择器）', () => {
    const src = read('src/features/important-note.js');
    falsy(/\.khin-(rail|drawer|dh|rows?)\b/.test(src), '贴边条 / 摘要列 / 行元素的选择器不许还留在注入样式里');
    truthy(/\.khin-fab \{/.test(src), 'FAB 的样式必须留着 —— 它是唯一收起态');
  });

  await test('浮窗复用旧卡也要跑合规校验（否则「只有贴边有」会复发）', () => {
    const src = read('src/features/important-note.js');
    /* renderItems 里 decorateMerge 与 decorateChecks 必须成对出现——旧写法只有 buildCardEl 那边调 */
    const at = src.indexOf('renderItems() {');
    truthy(at > 0, '找不到 renderItems 定义');
    const seg = src.slice(at, at + 6000);
    truthy(seg.indexOf('this.decorateMerge(el, item)') >= 0, '合并行每轮对齐');
    truthy(seg.indexOf('this.decorateChecks(el, item)') >= 0,
      '★ 复用分支必须补跑 decorateChecks：旧代码只在新建卡片时跑 ⇒ 悬窗永远没有小标');
  });

  /* 【2.0.8.14】用户要的「悬停展示会校验什么关键词」。
   * 真浏览器里 tag 标题太小看不清，所以判定结论和**实际拿去匹配的原文**都挂在悬停里；
   * 这里用真的表格渲染 + 真的 paintPolicy 跑一遍 DOM，锁住文案里必须有抓到的内容。 */
  await test('悬停说明：写出实际匹配的主标题 / 开发者原文，合并行也照常校验', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '主标题', rows: [[{ t: '某某清理大师' }]], opt: null },
      { label: '开发者', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      { label: '核准主体名称', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      /* 隐私政策与「隐私政策内容」同值 ⇒ 合并行，顺带验证合并标签上的悬停也不丢 */
      { label: '隐私政策', rows: [[{ t: '某某清理大师由北京某某科技有限公司运营。' }]], opt: null },
      { label: '隐私政策内容', rows: [[{ t: '某某清理大师由北京某某科技有限公司运营。' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const trs = div.querySelectorAll('tr');
    const policyTr = trs[trs.length - 1];
    const cells = policyTr.querySelectorAll('td');
    const tip = cells[0].getAttribute('title') || cells[0].title;
    truthy(tip.indexOf('某某清理大师') >= 0, '悬停要写出主标题抓到的原文');
    truthy(tip.indexOf('北京某某科技有限公司') >= 0, '★ 悬停要写出开发者抓到的原文（合并行被吞时这里会是空的）');
    truthy(tip.indexOf('找到了') >= 0, '要写命中结论');
    truthy(tip.indexOf('正文') >= 0, '要写正文字数口径');
    /* 【2.0.8.17】全中 ⇒ 只留绿底，不插「名」「开」小标（用户原话：找到的情况不需要小标） */
    eq(policyTr.querySelectorAll('.kh-policy-flag').length, 0,
      '全中时不许再挂「名」「开」小标：底色变绿已经说明命中');
    /* 合并出来的标签格自带 title，悬停时它会盖住 td 的 —— 说明必须拼在它后面 */
    const lbt = cells[0].querySelector('.kh-lbt');
    truthy(lbt, '隐私政策 / 隐私政策内容同值应合并成带 .kh-lbt 的标签');
    truthy(String(lbt.title).indexOf('隐私政策校验') >= 0, '合并标签的 title 里也要有校验说明');
    /* 开发者与核准主体同名被并成一行 ⇒ 同一主体，这行要按「同法人」染绿并写明依据
     * （旧代码 devTr === entTr 直接 return，这条口径永远走不到）。 */
    const devTr = trs[1];
    eq(devTr.querySelectorAll('td')[0].style.background, '#e6f4ea', '同值合并行要铺浅绿');
    truthy(String(devTr.querySelectorAll('td')[0].getAttribute('title') || '').indexOf('名字完全相同') >= 0,
      '悬停要写清「为什么算同一主体」');
  });

  await test('悬停说明：有缺时只给缺的那项挂一枚「开」小标（不挂命中的「名」）', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '主标题', rows: [[{ t: '某某清理大师' }]], opt: null },
      { label: '开发者', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      /* 正文只有主标题，没有公司名 ⇒ 开发者没找到 */
      { label: '隐私政策', rows: [[{ t: '某某清理大师隐私政策：我们重视你的隐私。' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const trs = div.querySelectorAll('tr');
    const policyTr = trs[trs.length - 1];
    const flags = policyTr.querySelectorAll('.kh-policy-flag');
    eq(flags.map((f) => f.textContent).join(''), '开', '只给没找到的「开发者」挂小标');
    truthy(flags[0].classList.contains('is-miss'), '缺项小标是 miss 态（橙色）');
    eq(policyTr.querySelectorAll('td')[0].style.background, '#fdf3d7', '有缺 ⇒ 行底色仍是浅黄');
  });

  await test('字段名一律走 labelText / fieldKeysOf（徽标与合并标签不许污染 readFields / rowOfField）', () => {
    const nc = read('src/features/note-check.js');
    const src = read('src/features/important-note.js');
    truthy(nc.indexOf('NoteCheck.labelText') >= 0, 'note-check 要导出 labelText');
    /* 2.0.8.14：读字段名从「单名」升级成「一行可能有多个名称」（开发者/核准主体名称同值会合并）。
     * 入口是 fieldKeysOf ⇒ labelsOf ⇒ labelText，三层都必须走，任何一层绕过就会重新吞字段。 */
    truthy(/NoteCheck\.fieldKeysOf\(tds\[0\]\)/.test(nc), 'readFields 用 fieldKeysOf 取字段名（合并行一个都不许漏）');
    truthy(/NoteCheck\.fieldsOf|NoteCheck\.fieldKeysOf[\s\S]{0,400}NoteCheck\.fieldKey\(labels\[/.test(nc), 'fieldKeysOf 内部把每个名称都过一遍 fieldKey');
    truthy(/if \(!out\.length\) push\(NoteCheck\.labelText\(td\)\)/.test(nc), 'labelsOf 兜底也要走 labelText');
    truthy(/NC\.fieldKeysOf\(tds\[0\]\)/.test(src), 'rowOfField 也必须用 fieldKeysOf，否则合并行找不回 policy/dev 行');
    falsy(/NoteCheck\.fieldKey\(tds\[0\]\.textContent\)/.test(nc), '不许再直接读 textContent');
    falsy(/NC\.fieldKey\(tds\[0\]\.textContent\)/.test(src), '面板层同样不许直接读 textContent');
  });
  /* 【2.0.8.14 需求②】用户仍报「重要笔记悬窗无端闪烁」。上一版修的是"重建时 hide→show 重播动画"，
   * 这一版补两条独立的残留成因：入场动画本身挂在"可见"上（任何 hidden 翻转都重播），
   * 以及标签区每轮 render 都 innerHTML 重造（hover 态与展开中的下拉当场消失）。 */
  suite('重要笔记 · 悬窗不闪（2.0.8.14 需求②）');

  await test('★ 入场动画只挂在 .khin-enter 上：显示/隐藏不许重播', () => {
    const src = read('src/features/important-note.js');
    const ruleOf = (sel) => {
      const re = new RegExp(sel.replace(/\./g, '\\.') + ' \\{[\\s\\S]*?\\n    \\}');
      const m = src.match(re);
      return m ? m[0] : '';
    };
    const panelRule = ruleOf('.khin-panel');
    truthy(panelRule && !/animation\s*:/.test(panelRule), '★ .khin-panel 基础规则里不许再有 animation（否则每次显示都重播）');
    falsy(/\.khin-drawer/.test(src), '摘要列已删，不该再有它的动画规则');
    truthy(/\.khin-panel\.khin-enter \{ animation: khin-in/.test(src), '动画改挂到 .khin-panel.khin-enter');
    truthy(/function playEnter\(el\)/.test(src), '要有一个只播一次的工具函数');
    truthy(/playEnter\(this\.panelEl\)/.test(src), '悬窗造壳后要播一次');
    truthy(/addEventListener\('animationend', stop/.test(src) && /setTimeout\(stop, 400\)/.test(src),
      'animationend 与兜底定时器都要能摘类（被提前隐藏时 animationend 不派发）');
  });

  await test('★ 标签区：签名没变就不重建（否则每轮重扫都把胶囊与下拉换新）', () => {
    const src = read('src/features/important-note.js');
    const i = src.indexOf('renderTags(tagsEl, item) {');
    truthy(i >= 0, '要有 renderTags');
    const seg = src.slice(i, i + 1800);
    const guard = seg.indexOf('__khTagSig');
    const write = seg.indexOf('tagsEl.innerHTML = head.tagHtml');
    truthy(guard >= 0 && write > guard, '签名判等必须早于 innerHTML 重建');
    truthy(/return;/.test(seg.slice(guard, write)), '签名一致要直接 return（一个子节点都不动）');
  });

  await test('★ 标签区 DOM：同一份命中重复 render 要复用原节点，内容变了才换', () => {
    const tagsEl = H.el('div', { class: 'khin-item-tags' }, []);
    const panel = shadowPanel();
    panel.pickedTags = new Map();
    panel.expandedTags = new Set();
    const item = { note: 'n1', entries: [{ kw: '高亮词', adj: '' }, { kw: '关键词', adj: '标题' }] };
    panel.renderTags(tagsEl, item);
    const first = tagsEl.children[0];
    truthy(first, '第一轮要渲染出节点');
    panel.renderTags(tagsEl, item);
    truthy(tagsEl.children[0] === first, '★ 同一份命中再 render 必须复用节点（旧代码每轮都换新）');
    panel.renderTags(tagsEl, { note: 'n1', entries: [{ kw: '另一个词', adj: '' }] });
    truthy(tagsEl.children[0] !== first, '命中变了要重建');
    truthy(String(tagsEl.textContent).indexOf('另一个词') >= 0, '重建后要是新内容');
  });

  /* 【2.0.8.15】用户实测：打开链接明明是正文，判定却说没有 —— 因为「隐私政策」那一格抓到的只是链接。
   * 现在这一格是链接时必须找后台抓正文，抓回来按正文重判（不许拿 URL 本身去比命中词）。 */
  suite('重要笔记 · 隐私政策改为跟链接抓正文（2.0.8.15 需求）');

  await test('★ 隐私政策那一格是链接：后台抓回正文后自动重判，悬停写明正文来源', async () => {
    const calls = [];
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '主标题', rows: [[{ t: '某某清理大师' }]], opt: null },
      { label: '开发者', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      /* 抓取表里「隐私政策」这一格只有链接本身 —— 旧代码直接拿这条 URL 去比命中词 */
      { label: '隐私政策', rows: [[{ t: 'https://a.test/p' }]], opt: null }
    ]);
    /* 垫片的 isConnected 要求挂到 document 上；真实页面里抓取表本来就在文档里 */
    if (document.body) document.body.appendChild(div);
    try {
      const panel = shadowPanel();
      panel._policyCache = new Map();
      panel._policyPending = new Set();
      /* 注入发送函数：真环境走 chrome.runtime.sendMessage；单测改全局 chrome 会与并发用例抢 */
      panel._policySend = (url, done) => {
        calls.push({ url: url });
        setTimeout(() => done({
          ok: true,
          text: '某某清理大师隐私政策：本应用由北京某某科技有限公司运营，详见 https://a.test/p 。',
          len: 46
        }), 0);
      };
      panel.decorateChecks(div, {});
      await new Promise((r) => setTimeout(r, 30));
      const trs = div.querySelectorAll('tr');
      const tr = trs[trs.length - 1];
      const tip = String(tr.querySelectorAll('td')[0].getAttribute('title') || '');
      eq(calls.length, 1, '★ 必须把链接发给后台抓正文');
      eq(calls[0].url, 'https://a.test/p', '发出去的必须就是这一格的链接');
      truthy(tip.indexOf('抓回的正文') >= 0, '悬停要写明正文来源（链接抓回）');
      truthy(tip.indexOf('北京某某科技有限公司') >= 0, '按正文重判要能找到开发者原文');
      truthy(tip.indexOf('找到了') >= 0, '正文里明明有 ⇒ 必须判命中，不许说没有');
      eq(tr.querySelectorAll('td')[0].style.background, '#e6f4ea', '三项都在正文里 ⇒ 浅绿');
    } finally {
      if (div.parentNode) div.parentNode.removeChild(div);
    }
  });

  /* 【2026-11-13 用户需求】营业执照/资质自动补的「企业名称」按开发者比对涂色；
   * 承诺函自动补的「承诺对象」按平台白名单涂绿/涂黄；「承诺方」只展示不上色。 */
  await test('自动行涂色：企业名称与开发者一致 ⇒ 绿，承诺对象白名单外 ⇒ 黄', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '企业名称', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '承诺对象', rows: [[{ t: '华为技术有限公司' }]], opt: null },
      { label: '承诺方', rows: [[{ t: '广州丙科技有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const trs = div.querySelectorAll('tr');
    /* 开发者与企业名称同值 ⇒ 表格把两行并成一行；合并行也要按「与开发者一致」判绿 */
    eq(trs[0].querySelectorAll('td')[0].style.background, KH.NoteCheck.COLOR_OK, '企业名称与开发者一致 ⇒ 浅绿');
    eq(trs[1].querySelectorAll('td')[0].style.background, KH.NoteCheck.COLOR_BAD, '华为 ⇒ 浅黄');
    falsy(trs[2].querySelectorAll('td')[0].style.background, '承诺方只展示，不上色');
    truthy(String(trs[1].querySelectorAll('td')[0].getAttribute('title') || '').indexOf('承诺对象') >= 0,
      '悬停要说明为什么黄');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  await test('自动行涂色：企业名称与开发者不一致 / 承诺对象是 vivo ⇒ 黄 / 绿', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '上海乙信息技术有限公司' }]], opt: null },
      { label: '企业名称', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '承诺对象', rows: [[{ t: '维沃移动通信有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const trs = div.querySelectorAll('tr');
    eq(trs[1].querySelectorAll('td')[0].style.background, KH.NoteCheck.COLOR_BAD, '两家不一致 ⇒ 浅黄');
    eq(trs[2].querySelectorAll('td')[0].style.background, KH.NoteCheck.COLOR_OK, 'vivo/维沃 ⇒ 浅绿');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  /* 【台账 #3/#4/#5 · 2026-11-14】颜色不动，另挂一枚**不靠颜色**的标记：
   * ✔ 一致 / ⚠ 待确认 / ？ 未查明。灰度截图、色觉障碍、打印时三态仍要分得清。 */
  await test('★ 判定行两态各带非颜色标记：✔ 一致 / ⚠ 待确认', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '企业名称', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '承诺对象', rows: [[{ t: '华为技术有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const trs = div.querySelectorAll('tr');
    /* 开发者与企业名称同值 ⇒ 表格并成一行，这一行是「一致」 */
    const sameCell = trs[0].querySelectorAll('td')[0];
    const sameMark = sameCell.querySelector('.kh-verdict');
    truthy(sameMark, '★ 一致行必须有非颜色标记（只涂浅绿不够）');
    eq(String(sameMark.textContent), '✔ 一致');
    eq(sameMark.getAttribute('data-state'), 'same', '状态挂在 data-state 上，样式只认它');
    const warnCell = trs[1].querySelectorAll('td')[0];
    const warnMark = warnCell.querySelector('.kh-verdict');
    truthy(warnMark, '★ 不一致行必须有非颜色标记');
    eq(String(warnMark.textContent), '⚠ 待确认');
    truthy(String(warnMark.textContent) !== String(sameMark.textContent), '两态文案必须不同');
    truthy(String(sameCell.getAttribute('title') || '').length > 0, '悬停说明还在');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  await test('★ 未查明是独立第三态：不涂色、有标记、悬停非空', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '企业名称', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const td = div.querySelectorAll('tr')[0].querySelectorAll('td')[0];
    falsy(td.style.background, '未查明不许涂色');
    const mark = td.querySelector('.kh-verdict');
    truthy(mark, '★ 未查明也要有标记 —— 否则和「这张卡没配校验」长得一模一样');
    eq(String(mark.textContent), '？ 未查明');
    eq(mark.getAttribute('data-state'), 'unknown');
    truthy(String(td.getAttribute('title') || '').indexOf('未查明') >= 0, '★ 悬停要写明未查明（以前是空串）');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  await test('★ 标记是纯后缀：字段名照旧认得出来，且同态重画复用同一节点', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '承诺对象', rows: [[{ t: '华为技术有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const cell = div.querySelectorAll('tr')[1].querySelectorAll('td')[0];
    const first = cell.querySelector('.kh-verdict');
    truthy(first, '前提：这一格真的挂了标记');
    eq(String(KH.NoteCheck.labelText(cell)), '承诺对象', 'labelText 要从右端把徽标剥掉');
    eq(KH.NoteCheck.labelsOf(cell).join('|'), '承诺对象', 'labelsOf 也照旧只认字段名');
    /* 值改成 vivo ⇒ 判定从「待确认」翻成「一致」：文案要更新，节点要复用（每轮换新会闪） */
    cell.parentNode.querySelectorAll('td')[1].textContent = '维沃移动通信有限公司';
    panel.decorateChecks(div, {});
    const second = cell.querySelector('.kh-verdict');
    truthy(second === first, '同一张卡重画要复用标记节点');
    eq(String(second.textContent), '✔ 一致', '判定变了，标记要跟着变');
    if (div.parentNode) div.parentNode.removeChild(div);
  });
  /* 【台账 #6】判定证据要就地可见：命中值 / 来源 / 读取时间 / 原页入口，不能只藏在悬停 title 里。 */
  await test('★ 判定行就地显示证据：值 / 来源 / 时间 / 原页入口', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '企业名称', rows: [[{ t: '华为技术有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const tr = div.querySelectorAll('tr')[1];
    const box = tr.querySelectorAll('td')[1].querySelector('.kh-evidence');
    truthy(box, '★ 判定行的值格里必须有证据行');
    const text = String(box.textContent || '');
    truthy(text.indexOf('值：华为技术有限公司') >= 0, '命中值要就地写出来：' + text);
    truthy(text.indexOf('源：本页抓取') >= 0, '来源要写清：' + text);
    truthy(/读取：\d{2}:\d{2}/.test(text), '读取时间要写出来：' + text);
    const link = box.querySelector('.kh-evidence-link');
    truthy(link, '★ 原页入口必须可点');
    eq(link.getAttribute('href'), location.href, '原页链接指向当前页');
    eq(link.getAttribute('target'), '_blank');
    eq(String(link.textContent), '原页 ↗');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  await test('★ 未查明行也带证据（值仍在，来源说清未查明）', () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '企业名称', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null }
    ]);
    const panel = shadowPanel();
    panel.decorateChecks(div, {});
    const tr = div.querySelectorAll('tr')[0];
    const box = tr.querySelectorAll('td')[1].querySelector('.kh-evidence');
    truthy(box, '未查明也是判定行，证据不能缺');
    const text = String(box.textContent || '');
    truthy(text.indexOf('值：北京知行灵动科技有限公司') >= 0, text);
    truthy(text.indexOf('源：本页抓取') >= 0, text);
    eq(tr.querySelectorAll('td')[0].querySelector('.kh-verdict').getAttribute('data-state'), 'unknown');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  /* 【台账 #8】查询超时 = 第四态：不涂底色，但徽标写「⏱ 超时」而不是「？未查明」。
   * 用户据此能分清「后台没回执，等会儿再看」和「这条真的查不到」。 */
  await test('★ 查询超时挂 ⏱ 超时（不是 ？未查明）：不涂色、悬停写明超时', async () => {
    const div = H.el('div', {}, []);
    div.innerHTML = KH.Fetch.rowsToTableHtml([
      { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
      { label: '核准主体', rows: [[{ t: '华为技术有限公司' }]], opt: null }
    ]);
    /* 同法人判定在 Promise 回调里画，回调会先看 isConnected —— 垫片的 div 不挂到文档上会被当已卸载跳过 */
    if (document.body) document.body.appendChild(div);
    const panel = shadowPanel();
    panel.lookupEntity = () => Promise.resolve({ rep: '', timedOut: true });
    panel.decorateChecks(div, {});
    await new Promise((r) => setTimeout(r, 20));
    const trs = div.querySelectorAll('tr');
    eq(trs.length, 2, '前提：开发者与核准主体各一行');
    const cell = trs[1].querySelectorAll('td')[0];
    const mark = cell.querySelector('.kh-verdict');
    truthy(mark, '★ 超时行必须有标记 —— 否则和「没配校验」长得一样');
    eq(String(mark.textContent), '⏱ 超时');
    eq(mark.getAttribute('data-state'), 'timeout');
    falsy(cell.style.background, '超时同样不改底色');
    truthy(String(cell.getAttribute('title') || '').indexOf('超时') >= 0, '★ 悬停要写明超时，而不是只写未查明');
    if (div.parentNode) div.parentNode.removeChild(div);
  });

  /* 数据层：20 秒（单测缩短到 25ms）没回执时 lookupEntity 要回 timedOut，
   * 且 Promise 必须收口（判据：20s 后不留悬挂 Promise）。 */
  await test('★ 没回执时 lookupEntity 回 timedOut=true 且 Promise 一定收口', async () => {
    const had = Object.prototype.hasOwnProperty.call(global, 'chrome') ? global.chrome : undefined;
    const panel = shadowPanel();
    panel._entTimeoutMs = 25;
    panel._entCache = new Map();
    global.chrome = { runtime: { lastError: null, sendMessage: function () { /* 后台被回收：永不回执 */ } } };
    try {
      const res = await panel.lookupEntity('某某超时科技有限公司');
      eq(typeof res, 'object', '★ 结果要带上「是不是超时」，不能只回空串');
      eq(res.timedOut, true, '★ 没回执 ⇒ timedOut 必须为 true');
      eq(res.rep, '');
    } finally {
      if (had === undefined) delete global.chrome; else global.chrome = had;
    }
  });

  /* 【台账 #7】判定要真的读面板当前的配置（this.cfg），不能偷偷回落到写死的默认值。
   * 判据「改名单无需改代码即生效」在面板这一层就是这条接线。 */
  await test('★ 面板按当前配置判：cfg 里放行华为 ⇒ 华为绿、vivo 黄（不用改代码）', () => {
    const make = (target) => {
      const div = H.el('div', {}, []);
      div.innerHTML = KH.Fetch.rowsToTableHtml([
        { label: '开发者', rows: [[{ t: '北京知行灵动科技有限公司' }]], opt: null },
        { label: '承诺对象', rows: [[{ t: target }]], opt: null }
      ]);
      return div;
    };
    const panel = shadowPanel();
    panel.cfg = { noteCheck: { promiseOk: ['华为'] } };   // 设置页改完写进配置的形状
    const dHuawei = make('华为技术有限公司');
    panel.decorateChecks(dHuawei, {});
    const hwCell = dHuawei.querySelectorAll('tr')[1].querySelectorAll('td')[0];
    eq(hwCell.style.background, KH.NoteCheck.COLOR_OK, '★ 华为在自定义名单里 ⇒ 浅绿');
    eq(String(hwCell.querySelector('.kh-verdict').textContent), '✔ 一致');
    const dVivo = make('维沃移动通信有限公司');
    panel.decorateChecks(dVivo, {});
    const vivoCell = dVivo.querySelectorAll('tr')[1].querySelectorAll('td')[0];
    eq(vivoCell.style.background, KH.NoteCheck.COLOR_BAD, '★ 自定义名单里没有 vivo ⇒ 浅黄（默认名单不再兜底）');
    eq(String(vivoCell.querySelector('.kh-verdict').textContent), '⚠ 待确认');
    if (dHuawei.parentNode) dHuawei.parentNode.removeChild(dHuawei);
    if (dVivo.parentNode) dVivo.parentNode.removeChild(dVivo);
  });
};