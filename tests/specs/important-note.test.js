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
};
