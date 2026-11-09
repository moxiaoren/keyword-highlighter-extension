/* tests/specs/v20812.test.js — 2.0.8.12 六项改动
 * ----------------------------------------------------------------------------
 * 用户（2026-11-09，睡觉前授权自主决策）：
 *   侧栏分组与空态三步引导 / 弹窗深链接 / 卡片定位原文 / 长任务进度与取消 /
 *   观感批剩余结构项 / 性能优化；另追加「抓取字段可设为超链接」「省略没生效」两条。
 *
 * 这里锁的是**行为契约**（源码里必须存在的关键分支与文案），不是逐字快照：
 *   · 侧栏必须分组，但 7 个 data-tab 一个都不能少（测试与深链接都按 data-tab 走）
 *   · 空态引导必须真的接在三处（分组 / 站点 / 关键词），不能只留个函数没人用
 *   · 弹窗必须走带 #sec- 的深链接，卡片要有 id 才点得到
 *   · 定位必须优先用 CSS.highlights 的 Range + 指纹，只把 window.find 当兜底
 *   · 长任务必须分批、必须能取消，且取消后如实报告已处理条数
 *   · 省略必须是一行（旧口径折 3 行，等于没省略）
 *
 * 注意：suite() 只接名字、不接回调 —— 用例必须写在同一层，否则一条都不会注册。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = function run() {
  suite('2.0.8.12 六项（侧栏分组 / 空态引导 / 深链接 / 定位原文 / 长任务 / 性能）');

  test('侧栏分组：4 组 + 7 个 data-tab 一个不少', () => {
    const html = read('options/options.html');
    const groups = (html.match(/class="kh-nav-group"/g) || []).length;
    truthy(groups === 4, '侧栏应有 4 个分组（内容/外观/站点与数据/帮助），实际 ' + groups);
    for (const t of ['keywords', 'groups', 'style', 'ocr', 'sites', 'data', 'help']) {
      truthy(html.includes('data-tab="' + t + '"'), '缺少分区 data-tab="' + t + '"');
    }
    truthy(html.includes('kh-nav-group-title'), '分组要有标题（否则只是换了嵌套，用户看不出分组）');
  });

  test('空态三步引导：函数存在、三处都接上、且最多三步', () => {
    const src = read('options/options.js');
    truthy(src.includes('function emptyGuide('), '缺少 emptyGuide()');
    const calls = (src.match(/emptyGuide\(/g) || []).length;
    truthy(calls >= 4, 'emptyGuide 应被调用 ≥3 次（函数定义 + 分组/站点/关键词三处），实际 ' + calls);
    truthy(/kh-empty-guide-steps/.test(src) && /h\('ol'/.test(src),
      '步骤要用 <ol> 渲染（有先后顺序的三步）');
    const kw = src.slice(src.indexOf('function toggleKeywordGuide'), src.indexOf('function toggleKeywordGuide') + 900);
    truthy(/total === 0/.test(src) && kw.length > 100, '关键词空态必须只在「一条都没有」时出现（筛不到不等于空）');
  });

  test('弹窗深链接：openOptions 带 #sec-，两张卡片可点', () => {
    const js = read('popup/popup.js');
    truthy(/openOptions\('help'/.test(js) && /openOptions\('keywords'/.test(js),
      '弹窗的按钮必须指向具体分区（help / keywords）');
    truthy(/\[\['card-keywords', 'keywords'\], \['card-site', 'sites'\]\]/.test(js),
      '两张卡片要各自映射到 keywords / sites 分区');
    truthy(/#sec-' \+ section/.test(js) || /'#sec-' \+ section/.test(js), 'openOptions 必须拼出 #sec-<分区>');
    const html = read('popup/popup.html');
    truthy(html.includes('id="card-keywords"') && html.includes('id="card-site"'), '两张信息卡要能定位到（缺 id）');
    truthy(/role="button"/.test(html) && /tabindex="0"/.test(html), '可点卡片要能被键盘访问（role + tabindex）');
    const css = read('popup/popup.css');
    truthy(css.includes('.kh-stat-card.is-link'), '可点卡片要有 pointer / hover 反馈');
  });

  test('卡片定位原文：优先 CSS.highlights + 指纹，window.find 只兜底', () => {
    const src = read('src/features/important-note.js');
    truthy(src.includes('function locateInPage(kw, hints)'), '缺少 locateInPage()');
    const body = src.slice(src.indexOf('function locateInPage(kw, hints)'), src.indexOf('function locateInPage(kw, hints)') + 2600);
    truthy(/CSS\.highlights/.test(body), '定位应遍历 CSS.highlights 里的 Range（才知道每个命中在哪）');
    truthy(/hints/.test(body), '定位要用卡片内容当指纹（否则同词多处仍然跳错）');
    truthy(/scrollIntoView/.test(body), '定位要滚动到目标');
    truthy(/window\.find/.test(body), '找不到时应回退 window.find（不能让按钮变成死的）');
    truthy(src.includes('.kh-locate-mark'), '定位后要给目标加短暂的可见标记');
  });

  test('长任务：分批 + 进度 + 可取消，且取消后如实报数', () => {
    const src = read('options/options.js');
    truthy(src.includes('async function runLongTask('), '缺少 runLongTask()');
    truthy(src.includes('const CHUNK = 25') && src.includes('const CHUNK = 50'), '删除与批量启停都要分批');
    truthy(src.includes('async function patchBatchEnabled('), '批量启停要收进一个可分批的函数');
    truthy(/cancelled/.test(src) && /正在停止/.test(src), '取消要能真的停下（按钮文案要如实）');
    truthy(/已取消：删除 ' \+ deleted/.test(src), '取消后要如实报告已删除多少条（不能只说"已取消"）');
    truthy(src.includes('kh-progress'), '进度条节点要存在');
    const css = read('options/options.css');
    truthy(css.includes('.kh-progress-fill'), '进度条要有填充样式');
  });

  test('省略口径：超出一行才收（2.0.8.13 改自适应）；链接样式存在', () => {
    const src = read('src/features/important-note.js');
    /* 行首锚定：深色主题块里也有 `.kh-table .kh-val-box` 选择器（只改颜色），
     * 直接 indexOf 会抓到那条，断言就跑在错误的片段上。 */
    const at = src.search(/\n    \.kh-table \.kh-val-box \{/);
    const box = src.slice(at, at + 900);
    truthy(/\.kh-val-tight/.test(box), '裁剪规则挂在 .kh-val-tight 上（默认整段显示，超一行才收）');
    truthy(/-webkit-line-clamp:\s*1;/.test(box), '收起来的时候是一行（旧口径 3 行 = 用户看到"没省略"）');
    truthy(/text-overflow:\s*ellipsis/.test(box), '一行也要有省略号，否则像被截断');
    truthy(src.includes('.kh-table .kh-val-link'), '超链接要有独立的链接样式');
  });

  test('性能：实体缓存有上限、prune 顺手删样式节点、计时器不叠', () => {
    const note = read('src/features/important-note.js');
    truthy(/_entCache\.size > 200/.test(note), '_entCache 必须有上限');

    const r = read('src/core/renderer.js');
    const prune = r.slice(r.indexOf('prune(keepNames)'), r.indexOf('prune(keepNames)') + 900);
    truthy(/_styleNodes\.delete\(name\)/.test(prune), 'prune 删组时要连 ::highlight 样式节点一起删');

    const s = read('src/core/scheduler.js');
    truthy(s.includes('clearInterval(this._timers.fingerprint)'), '重设指纹计时器前必须先 clearInterval');
    truthy(s.includes('clearInterval(this._timers.growth)'), '重设增长计时器前必须先 clearInterval');
  });
};
