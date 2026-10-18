/* tests/specs/baseline-matcher.test.js — 只读基线生成器的 glob 匹配器必须"老规则不改意"
 * ----------------------------------------------------------------------------
 * 为什么需要这条：
 *   基线 `_stage/audit/KH-AUDIT-BASELINE-*.json` 的 `scopes` / `excludes` 是
 *   `_tools/baseline-make.js` 的 `matchPattern()` 解释的**段级 glob**（`**` = 任意多段）。
 *   B1..B8 的 pattern 全是「目录 + /**」，匹配器只做整段相等比较。
 *   B9 为了剔除发布会重新生成的产物，第一次用到**段内通配**（`release/**\/*.zip|*.crx`），
 *   为此给 `matchPattern()` 加了段内 `*` 支持 —— 这是**改公共匹配语义**的动作：
 *   如果实现失手（例如 `*` 跨了 `/`、或整段回退成字面比较失败），历史基线的
 *   excludes 会静默变形，而基线一旦变形，"复现证明"就失去意义。
 *   所以这里把**老语义**（B1..B8 用到的全部形态）和**新语义**（段内 `*`）都钉死。
 *
 * 位置：_tools/ 在工作区里、不在扩展仓库内（同 e2e-selfcontained.test.js 的做法），
 * 找不到就**明红**（票 #47：单克隆扩展仓库时这套断言确实不适用，但"绿 + 跳过"会被读成通过）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;

/** __dirname = <工作区>/work/keyword-highlighter/tests/specs → 向上 4 级 = 工作区 */
const TOOL = path.resolve(__dirname, '..', '..', '..', '..', '_tools', 'baseline-make.js');

module.exports = async function run() {
  suite('baseline-matcher · 基线 glob 匹配器（老语义不回归 + 段内 * 生效）');

  /* 【票 #47】匹配器在**工作区私有仓**的 `_tools/baseline-make.js`；单仓检出时明红，不 skip。 */
  if (!H.needWorkspaceFile('★ baseline-make.js 匹配器', TOOL,
    '先在工作区根（F:\\harness\\高亮词插件）检出整个工作区（`_tools/baseline-make.js` 属工作区仓）。')) return;
  const { matchPattern, splitPattern, DEFAULT_DOT_GIT_RULE } = require(TOOL);
  const DOT_GIT = DEFAULT_DOT_GIT_RULE.rule;

  /* ---- 老语义（B1..B8 实际用过的形态，逐条钉死）---- */
  const OLD = [
    ['_e2e/_out/**', '_e2e/_out/a.png', true],
    ['_e2e/_out/**', '_e2e/_out/x/y/z.bin', true],
    ['_e2e/_out/**', '_e2e/_out', true],          // '**' 允许 0 段
    ['_e2e/_out/**', '_e2e/_other/a.png', false],
    ['**', 'anything/at/all.txt', true],
    ['work/**', 'work/keyword-highlighter/src/a.js', true],
    ['work/**', 'work', true],
    ['work/**', 'other/a.js', false],
    ['work/keyword-highlighter/release/**', 'work/keyword-highlighter/release/lang/x.gz', true],
    ['a/b.js', 'a/b.js', true],
    ['a/b.js', 'a/b.js.map', false],
    ['a/b.js', 'x/a/b.js', false],                 // 必须锚整条相对路径
    [DOT_GIT, '.git/objects/ab/cd', true],
    [DOT_GIT, '.github/workflows/x.yml', false]
  ];

  /* ---- 新语义（B9 首次使用的段内 '*'）---- */
  const NEW = [
    ['work/keyword-highlighter/release/**/*.zip', 'work/keyword-highlighter/release/keyword-highlighter-beta-v2.0.1.12.zip', true],
    ['work/keyword-highlighter/release/**/*.zip', 'work/keyword-highlighter/release/sub/deep/x.zip', true],
    ['work/keyword-highlighter/release/**/*.zip', 'work/keyword-highlighter/release/notes.txt', false],
    ['work/keyword-highlighter/release/**/*.zip', 'work/keyword-highlighter/release/lang/chi_sim.traineddata.gz', false],
    ['work/keyword-highlighter/release/**/*.zip', 'work/keyword-highlighter/src/a.js', false],
    ['work/keyword-highlighter/release/**/*.crx', 'work/keyword-highlighter/release/keyword-highlighter-beta-v2.0.1.12.crx', true],
    ['work/keyword-highlighter/release/**/*.crx', 'work/keyword-highlighter/release/keyword-highlighter-beta-v2.0.1.12.zip', false],
    ['work/keyword-highlighter/dist/**', 'work/keyword-highlighter/dist/kw.zip', true],
    ['work/keyword-highlighter/dist/**', 'work/keyword-highlighter/src/a.js', false],
    ['*.zip', 'a.zip', true],
    ['*.zip', 'd/a.zip', false],                   // 段内 * 不许吃掉 '/'
    ['work/*/x.js', 'work/a/x.js', true],
    ['work/*/x.js', 'work/a/b/x.js', false],
    ['a*z', 'abcz', true],
    ['a*z', 'ab', false],
    ['*z', 'z', true],                             // '*' 允许 0 字符
    ['a*z', 'z', false]                             // 字面字符不许被 '*' 吞掉
  ];

  const bad = [];
  for (const [pat, file, want] of OLD.concat(NEW)) {
    const got = matchPattern(pat, file);
    if (got !== want) bad.push(pat + ' × ' + file + ' → ' + got + '（期望 ' + want + '）');
  }

  await test('★ 老语义 ' + OLD.length + ' 例 + 段内 * ' + NEW.length + ' 例全部符合预期', () => {
    eq(bad.length, 0, '匹配器与约定不符：\n      ' + bad.join('\n      '));
  });

  await test('★ splitPattern 丢掉空段（pattern 写不写首尾 / 都不改变语义）', () => {
    deepEq(splitPattern('/a/**/'), ['a', '**']);
    deepEq(splitPattern('a/b'), ['a', 'b']);
    deepEq(splitPattern('**'), ['**']);
  });

  await test('★ `.git/**` 是记录在案的一等规则（不是靠通配碰巧生效）', () => {
    eq(DEFAULT_DOT_GIT_RULE.rule, '.git/**');
    eq(DEFAULT_DOT_GIT_RULE.kind, 'explicit');
    truthy(String(DEFAULT_DOT_GIT_RULE.note).length > 0);
  });

  await test('★ 恰好整段相等时不做正则回退（字面段仍然是字面比较）', () => {
    /* '**' 段永远走递归分支；含 '*' 的段才构造正则 —— 用一个含正则元字符的字面段证明没被当模式跑 */
    truthy(matchPattern('a.b/c', 'a.b/c'));
    falsy(matchPattern('a.b/c', 'axb/c'));
    truthy(matchPattern('release/**/[x].zip', 'release/[x].zip'));
    falsy(matchPattern('release/**/[x].zip', 'release/x.zip'));
  });
};
