/* tests/specs/version.test.js — 版本比较（发版守卫的唯一口径）
 * ----------------------------------------------------------------------------
 * 为什么值得单测：版本比较只在发版时用到，写错的表现是"稳定版号低于线上测试版号"——
 * 浏览器永不降级 ⇒ 一整批测试版用户**永远收不到稳定版**，而且线上看不出任何异常。
 * 【2026-10-05】实现从 `background/update-checker.js` 搬到 `scripts/lib/version.js`
 * （插件入口取消了线上更新检查，但发版脚本仍要用同一个口径；两个脚本都必须调它，不能各写一套）。
 */
'use strict';
const path = require('path');
const H = require('../harness');
const { suite, test, eq } = H;

const V_PATH = path.join(__dirname, '..', '..', 'scripts', 'lib', 'version.js');

function fresh() {
  delete require.cache[require.resolve(V_PATH)];
  return require(V_PATH);
}

module.exports = async function run() {
  suite('版本比较 · 发版守卫口径');

  await test('版本比较：常规 / 四段 / 前导 v / 空值', () => {
    const V = fresh();
    eq(V.compareVersions('2.1.0', '2.0.9'), 1, '2.1.0 > 2.0.9');
    eq(V.compareVersions('2.1.0', '2.1.0'), 0, '相同版本');
    eq(V.compareVersions('v2.1.0', '2.1.0'), 0, '忽略前导 v');
    eq(V.compareVersions('2.1.0.1', '2.1.0'), 1, '四段版本按段比较');
    eq(V.compareVersions('', '2.1.0'), -1, '空版本视为 0');
  });

  await test('版本比较：稳定版 ⇄ 测试版 的升降序（发版铁律）', () => {
    const V = fresh();
    /* 这组不是"顺手多测几条"，它钉的是发版铁律：**稳定版号必须 > 线上测试版号**
     * （浏览器永不降级 ⇒ 低了就有一批人永远收不到稳定版）。线上现状 2.0.1 / 2.0.1.1。 */
    eq(V.compareVersions('2.0.1.1', '2.0.1'), 1, '测试版 2.0.1.1 高于稳定版 2.0.1 ⇒ 测试者能收到它');
    eq(V.compareVersions('2.0.1', '2.0.1.1'), -1, '稳定版若只到 2.0.1 就是回退 ⇒ release.js 必须拦住');
    eq(V.compareVersions('2.0.2', '2.0.1.1'), 1, '下一稳定版 2.0.2 高于测试版 2.0.1.1 ⇒ 测试者也能收到 2.0.2');
    eq(V.compareVersions('2.0.2.0', '2.0.2'), 0, '第四位 0 等于三段号 ⇒ 别把测试版号停在 x.y.z.0（它不算"更高"）');
    eq(V.compareVersions('2.0.2.1', '2.0.3'), -1, '下一轮稳定版 2.0.3 仍高于测试版 2.0.2.1 ⇒ 不变量继续成立');
  });

  await test('版本比较：预发布后缀（预发布 < 同号正式版）', () => {
    const V = fresh();
    eq(V.compareVersions('2.2.0-beta.1', '2.2.0'), -1, '2.2.0-beta.1 旧于 2.2.0');
    eq(V.compareVersions('2.2.0', '2.2.0-beta.1'), 1, '2.2.0 新于 2.2.0-beta.1');
    eq(V.compareVersions('2.2.0', '2.1.9'), 1, '核心段仍然参与比较');
    eq(V.compareVersions('2.2.0-beta.1', '2.2.0-beta.1'), 0, '同预发布相等');
  });
};
