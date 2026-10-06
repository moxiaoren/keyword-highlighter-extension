/* tests/specs/impact-mapping.test.js — 回归范围分类表本身的回归
 * ----------------------------------------------------------------------------
 * 为什么要有这条：
 *   用户定的规矩是「改到哪个方面就回归哪个方面；**不好判断就全量回归**」。
 *   这条规矩完全依赖 `scripts/impact.js` 里的「源文件 → 方面」映射表 ——
 *   映射表一旦被改错（比如把 `src/core/renderer.js` 误判成 hit），
 *   就会**该测的没测**，而且没有任何红灯。所以映射表本身也要有回归。
 *
 * 这里全部走**纯函数**（impact.js 导出 aspectsOf / combine），不读文件、不碰文件系统 ——
 * 上一轮我正是用"造文件再删"的土办法验证映射，结果删掉了 14 个真实源文件，教训在此。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq } = H;
const path = require('path');

module.exports = async function run() {
  const impact = require(path.join(__dirname, '..', '..', 'scripts', 'impact.js'));

  suite('impact-mapping · 回归范围分类表（K40 后续：按方面回归）');

  const CASES = [
    /* 命中与匹配 */
    ['src/core/compiler.js', 'hit'],
    ['src/core/scanner.js', 'hit'],
    ['src/core/arbiter.js', 'hit'],
    ['src/core/registry.js', 'hit'],
    ['src/features/combo/cells.js', 'hit'],
    ['src/features/combo/combo.js', 'hit'],
    ['src/features/rare-char.js', 'hit'],

    /* 渲染与着色 */
    ['src/core/renderer.js', 'visual'],
    ['src/core/rebuilder.js', 'visual'],
    ['content/content.css', 'visual'],

    /* 交互 */
    ['src/features/note-card.js', 'interact'],
    ['src/features/important-note.js', 'interact'],

    /* 抓取与序列化 */
    ['src/features/fetch.js', 'fetch'],
    ['src/platform/markdown.js', 'fetch'],

    /* 站点门禁 */
    ['src/features/site-rules.js', 'site'],

    /* 多方面的关键文件（宁可多测） */
    ['src/core/index.js', 'hit,interact,site'],
    ['src/core/scheduler.js', 'hit,interact,site'],
    ['content/content.js', 'hit,interact,site'],
    ['src/core/config.js', 'all'],
    ['src/platform/storage.js', 'data,ui'],
    ['src/features/page-editor.js', 'interact,ui'],
    ['src/ui/components/fields.js', 'interact,ui'],
    ['src/ui/tokens.css', 'ui,visual'],
    /* 【2026-10-06】`background/` 补了 `hit`（OCR 的 job 生命周期 / 额度归还 / 看门狗都在
     * `background/ocr.js` 里，改它直接影响"这张图到底能不能出结果"）。见 scripts/impact.js 的规则注释。 */
    ['background/service-worker.js', 'hit,interact,site,ui'],
    ['background/ocr.js', 'hit,interact,site,ui'],

    /* 管理端 */
    ['options/options.js', 'ui'],
    ['popup/popup.js', 'ui'],
    ['welcome/welcome.js', 'ui'],
    ['src/ui/changelog.js', 'ui'],
    ['src/ui/fieldmap.js', 'ui'],
    /* OCR 文案唯一真源：被**内容层**面板用，也被 options/popup 用 ⇒ 必须带 `interact`，
     * 否则选择器会选中一个不含内容层的空范围（假绿）。 */
    ['src/ui/ocr-copy.js', 'interact,ui'],
    ['src/build-info.js', 'ui'],

    /* 三端共用 / 影响面大 / 未归类 → 一律全量（用户口径：不好判断就全量回归） */
    ['src/core/protocol.js', 'all'],
    ['manifest.json', 'all'],
    ['icons/icon16.png', 'all'],
    ['_locales/zh_CN/messages.json', 'all'],
    ['src/features/_brand-new.js', 'all'],
    ['src/unknown/x.js', 'all'],
    ['something-else.xyz', 'all'],

    /* 只动测试 / 构建脚本 / 文档 → 不跑浏览器层 */
    ['tests/specs/compiler.test.js', 'none'],
    ['tests/run.js', 'none'],
    ['scripts/package.js', 'none'],
    ['scripts/impact.js', 'none'],
    ['tests/E2E-REPORT.md', 'none'],
    ['设计偏好.md', 'none']
  ];

  await test('★ 单个文件的方面判定全部符合分类表（' + CASES.length + ' 条）', () => {
    const wrong = [];
    for (const [rel, want] of CASES) {
      const got = impact.combine([rel]).text;
      if (got !== want) wrong.push(rel + '：期望 ' + want + '，实际 ' + got);
    }
    eq(wrong.length, 0, '以下路径判定不符：\n      ' + wrong.join('\n      '));
  });

  await test('★ 合并规则：多方面取并集', () => {
    eq(impact.combine(['src/core/renderer.js', 'src/features/note-card.js']).text, 'interact,visual');
    eq(impact.combine(['popup/popup.js', 'src/features/fetch.js']).text, 'fetch,ui');
    eq(impact.combine(['src/features/site-rules.js', 'src/core/index.js']).text, 'hit,interact,site');
  });

  await test('★ 合并规则：任一条影响面大 → 整体全量（拿不准就全量）', () => {
    eq(impact.combine(['src/core/renderer.js', 'manifest.json']).text, 'all');
    eq(impact.combine(['src/features/_brand-new.js', 'options/options.js']).text, 'all');
  });

  /* ---- 三级回归范围的"区域"一级 ----
   * 用户口径：只改了「关键词添加弹窗」就只回归那一块。最危险的失效是
   * "选中一个没有任何组会命中的空区域 → 一个组都不跑"（比全量更糟：假绿）。
   * ⚠️ 不变量要写对：`fields` 这类**虚拟 key**（只用于把共享文件展开到别的区域、自己不该被单独选中）
   * 本来就匹配不到任何组名 —— 所以不能要求"每个 key 都能被组名命中"，
   * 要守的是"**一个文件的区域集合里至少有一个 key 是能被组名命中的**" + "implies 指向的区域必须真实存在"。 */
  await test('★ 区域级：只改关键词弹窗 → 走区域级且含 editor（不再整个 UI 层）', () => {
    const A = require(path.join(__dirname, '..', '..', 'scripts', 'regression-areas.js'));
    const areas = A.areasOfFile('src/ui/components/keyword-editor.js');
    eq(JSON.stringify(areas), JSON.stringify(['editor']), 'keyword-editor.js 应只归属 editor；实际 ' + JSON.stringify(areas));
    /* 用真实的方面值（ui）跑一遍升级判定：应停在区域级 */
    const r = A.classify(['src/ui/components/keyword-editor.js'], () => ['ui']);
    eq(r.level, 'areas', '有区域归属 → 区域级；实际 ' + JSON.stringify(r));
    eq(r.areas.indexOf('editor') >= 0, true, '必须选中 editor；实际 ' + JSON.stringify(r.areas));
  });

  await test('★ 区域级：共享的 fields.js 改动 → 展开到多个区域（防"空区域假绿"）', () => {
    const A = require(path.join(__dirname, '..', '..', 'scripts', 'regression-areas.js'));
    const areas = A.areasOfFile('src/ui/components/fields.js');
    eq(areas.length > 1, true, '共享控件层必须展开成多个区域；实际 ' + JSON.stringify(areas));
    /* ① 展开结果里必须至少有一个"组名能命中"的区域（否则选中它 = 一个组都不跑） */
    const nameMatchable = areas.filter((k) => A.AREAS.some((b) => b.nameRe && b.nameRe.test(k)));
    eq(nameMatchable.length > 0, true, '展开后的区域里至少要有一个能被组名命中；实际 ' + JSON.stringify(areas));
    /* ② implies 指向的区域必须真实存在（写错 key 会静默丢覆盖） */
    for (const a of A.AREAS) {
      for (const k of (a.implies || [])) {
        eq(A.AREAS.some((b) => b.key === k), true, a.key + ' 的 implies 指向了不存在的区域：' + k);
      }
    }
  });

  await test('★ 危险文件 → 一律全量；未知文件退方面级；纯文档 → none', () => {
    const A = require(path.join(__dirname, '..', '..', 'scripts', 'regression-areas.js'));
    for (const p of ['manifest.json', 'src/core/scheduler.js', 'src/core/scanner.js', 'src/core/index.js']) {
      eq(A.classify([p], () => ['ui']).level, 'all', p + ' 必须判全量（动了它就别想省）');
    }
    eq(A.classify(['weird/unknown.js'], () => ['ui']).level, 'aspects', '未知文件但方面可判 → 退一级');
    eq(A.classify(['README.md'], (p) => (/\.md$/i.test(p) ? [] : ['ui'])).level, 'none', '只改文档 → none');
  });

  await test('★ 合并规则：只含测试/文档 → none（不能是空串，否则调用方会兜底成全量）', () => {
    eq(impact.combine(['tests/run.js', 'scripts/package.js']).text, 'none');
    eq(impact.combine([]).text, 'none');
  });

  await test('每个方面都至少有一个文件会触发它（防"某方面永远选不中"）', () => {
    const hit = new Set();
    for (const [rel] of CASES) {
      const r = impact.combine([rel]);
      if (!r.all) for (const a of r.list) hit.add(a);
    }
    const missing = Object.keys(impact.ASPECTS).filter((a) => !hit.has(a));
    eq(missing.length, 0, '这些方面没有任何用例覆盖：' + missing.join(', '));
  });
};
