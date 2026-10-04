/* tests/specs/e2e-selfcontained.test.js — e2e 分组必须"自包含"
 * ----------------------------------------------------------------------------
 * 为什么需要这条：
 *   出包时真浏览器回归**按方面裁组**（`_e2e/run.js --aspects=...`，范围由 impact.js 算）。
 *   一组被裁掉之后，**后面那组如果靠"前一组留在页面上的内容"，就必然假红** ——
 *   实测踩到：裁掉第 1 组后，第 2 组 3 条全红（页面还停在 about:blank，`#tbody` 不存在）。
 *   假红比漏测更坏：它会让"按方面跑"这件事变得不可信，最后只能退回全量。
 *
 * 规约：**每个 group 在自己的第一条用例里必须自己起页** ——
 *   调 `fresh('xxx.html')`，或自己 `api.context.newPage()` + `goto(...)` / `setContent(...)`。
 *
 * 这条规约靠"记得"守不住（新增一个组很容易忘），所以这里做**源码级机械检查**：
 * 逐个 group，只看它**第一条用例**的范围里有没有起页动作；没有就红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq } = H;

/** `_e2e` 在工作区里、不在本仓库内：
 *  __dirname = 浏览器插件/work/keyword-highlighter/tests/specs
 *  向上 4 级 = 浏览器插件 → 再进 _e2e */
const E2E = path.resolve(__dirname, '..', '..', '..', '..', '_e2e');

/* 两层的"可裁剪粒度"不同，所以规约也不同：
 *   content.test.js → **按组裁剪**（content 的方面有 hit/visual/interact/fetch/site）
 *                     ⇒ 每个组都必须能在别人被裁掉时独立跑 ⇒ 第一条用例自己起页。
 *   ui.test.js      → **整层跑**（UI 层只有一个方面 `ui`，且各组共用顶部那一个 options
 *                     页面、状态逐组累积）⇒ 只要**文件级**起页就够了，组内共享是设计如此。
 *                     这条与 `_e2e/run.js` 里 UI_ASPECTS = ['ui'] 的注释必须一致。 */
const FILES = [
  { name: 'content.test.js', mode: 'per-group' },
  { name: 'ui.test.js', mode: 'layer' }
];

function lint(file, mode) {
  const src = fs.readFileSync(path.join(E2E, file), 'utf8');
  const lines = src.split(/\r?\n/);

  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    /* 有的 group 与注释同行（`/* ---- 9. 全词+正则 *​/  group('7. …')`），所以不锚行首 */
    const m = lines[i].match(/(?:^|\s)group\('([^']*)'/);
    if (m) groups.push({ name: m[1], line: i + 1, start: i });
  }

  const bad = [];

  /* 整层跑的模式：只要**第一个组之前**（文件前言）起过页即可 */
  if (mode === 'layer') {
    const preamble = lines.slice(0, groups.length ? groups[0].start : lines.length).join('\n');
    if (!/fresh\(|\.goto\(|setContent\(|newPage\(|extensionPage\(/.test(preamble)) {
      bad.push('（文件前言没有起页：' + file + '）');
    }
    return { total: groups.length, bad };
  }

  for (let g = 0; g < groups.length; g++) {
    const from = groups[g].start;
    const to = (g + 1 < groups.length) ? groups[g + 1].start : lines.length;
    const body = lines.slice(from, to).join('\n');

    /* 只看**第一条用例**：起页动作必须发生在第一个 await test( 到第二个 await test( 之间 */
    const t1 = body.indexOf('await test(');
    if (t1 < 0) { bad.push(groups[g].name + '（L' + groups[g].line + '：组内没有用例？）'); continue; }
    const t2 = body.indexOf('await test(', t1 + 1);
    const firstTest = t2 >= 0 ? body.slice(t1, t2) : body.slice(t1);

    if (!/fresh\(|\.goto\(|setContent\(|newPage\(|extensionPage\(/.test(firstTest)) {
      bad.push(groups[g].name + '（L' + groups[g].line + '）');
    }
  }
  return { total: groups.length, bad };
}

module.exports = async function run() {
  suite('e2e-selfcontained · e2e 分组必须自包含（按方面裁组的前提）');

  for (const f of FILES) {
    const p = path.join(E2E, f.name);
    if (!fs.existsSync(p)) { H.skip('★ ' + f.name + '：' + f.mode, '找不到 ' + p); continue; }
    await test('★ ' + f.name + '（' + f.mode + '）：起页规约成立（共 ' + lint(f.name, f.mode).total + ' 个分组）', () => {
      const r = lint(f.name, f.mode);
      eq(r.bad.length, 0,
        '这些地方没有自己起页 —— 按方面裁组时会假红：\n      ' + r.bad.join('\n      ') +
        (f.mode === 'per-group'
          ? '\n      修法：在该组第一条用例里加 await fresh(\'xxx.html\')，或自己 newPage() + goto()。'
          : '\n      修法：在文件前言（第一个 group 之前）建好共享页面。'));
    });
  }
};
