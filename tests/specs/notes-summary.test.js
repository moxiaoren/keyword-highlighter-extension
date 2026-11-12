/* tests/specs/notes-summary.test.js — 稳定版说明的测试版汇总（2026-11-12 用户要求）
 * ----------------------------------------------------------------------------
 * 用户原话：「稳定版的更新说明应该整理简化所有上个稳定版到这个稳定版的测试版更新，
 * 而不是只整理，输出上个测试版的。（因为稳定版时给普通用户看的。）」
 *
 * 守四件事：
 *   1. 范围对：上一个稳定版之后、本稳定版之前的**每一个**测试版都要进汇总；
 *   2. 内容真：带标签和正文，不是只有标题行；同一件事多版迭代时只留最终形态；
 *   3. 三条出口共用一份数据：Release 正文、说明页草稿注入、出包断言；
 *   4. 说明页 html 里有这段汇总（靠草稿注入 + am 渲染，断言见 release-audit）。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const fs = require('fs');
const path = require('path');
const { suite, test, eq, truthy } = H;

const NS = require('../../scripts/notes-summary');
const A = require('../../scripts/release-audit');
const ROOT = path.join(__dirname, '..', '..');

function entry(version, items) {
  return { version: version, items: items || [] };
}

module.exports = async function run() {
  suite('2.0.10.1 · 稳定版说明：把所有测试版的改动汇总进说明页');

  await test('★ betasBetween：本稳定版之下、上一个稳定版之上的全部测试版', () => {
    const cl = [
      entry('2.0.10'), entry('2.0.9.2'), entry('2.0.9.1'), entry('2.0.9'),
      entry('2.0.8.23'), entry('2.0.8.22'), entry('2.0.8'),
    ];
    eq(NS.betasBetween(cl, '2.0.10').map((c) => c.version).join(','), '2.0.9.2,2.0.9.1');
    eq(NS.betasBetween(cl, '2.0.9').map((c) => c.version).join(','), '2.0.8.23,2.0.8.22');
    eq(NS.betasBetween(cl, '2.0.9.1').length, 0, '测试版自己没有汇总范围');
    eq(NS.prevStable(cl, '2.0.10'), '2.0.9');
  });

  await test('★ collect：带正文、同一条只留最新写法', () => {
    const cl = [
      entry('2.0.10'),
      entry('2.0.9.2', ['【修复】超链接配只显示一行时反复跳动，改法 B', '【新增】图片可以点名第几张']),
      entry('2.0.9.1', ['【修复】超链接配只显示一行时反复跳动，改法 A']),
      entry('2.0.9'),
    ];
    const d = NS.collect(cl, '2.0.10');
    eq(d.count, 2);
    const flat = d.betas.reduce((n, b) => n + b.items.length, 0);
    eq(flat, 2, '旧写法要被去重掉');
    eq(d.betas[0].items[0].body.indexOf('改法 B') >= 0, true, '留最新那一版的写法');
  });

  await test('★ markdown：有标记、有「N 个测试版」标题、逐版小节', () => {
    const cl = [
      entry('2.0.10'),
      entry('2.0.9.2', ['【修复】甲问题']),
      entry('2.0.9.1', ['【新增】乙功能']),
      entry('2.0.9'),
    ];
    const md = NS.markdown(cl, '2.0.10');
    truthy(md.indexOf(NS.MARK_START) >= 0 && md.indexOf(NS.MARK_END) >= 0, '要有可替换的标记');
    truthy(md.indexOf('2 个测试版都改了什么') >= 0, '标题要写清覆盖了几版');
    truthy(md.indexOf('### 2.0.9.2') >= 0 && md.indexOf('### 2.0.9.1') >= 0, '每版一个小节');
    truthy(md.indexOf('甲问题') >= 0 && md.indexOf('乙功能') >= 0, '正文要进汇总');
    truthy(md.indexOf('最该知道的') >= 0, '要有扫读用的重点');
  });

  await test('★ 测试版不生成汇总段', () => {
    eq(NS.markdown([entry('2.0.9.3')], '2.0.9.3'), '');
  });

  await test('★ inject：没有标记就追加，有标记就原位替换（不会越注越多）', () => {
    const sec = NS.markdown([entry('2.0.10'), entry('2.0.9.1', ['【新增】乙'])], '2.0.10');
    const once = NS.inject('---\ntitle: x\n---\n\n正文', sec);
    truthy(once.indexOf(NS.MARK_START) > 0, '追加在正文之后');
    const twice = NS.inject(once, sec);
    eq(twice.indexOf(NS.MARK_START), once.indexOf(NS.MARK_START), '第二次注入位置不变');
    eq((twice.match(/KH:STABLE-SUMMARY:START/g) || []).length, 1, '只能有一段汇总');
  });

  await test('★ 真实 changelog：2.0.9 的汇总要收满 2.0.8.x 全部测试版', () => {
    const cl = NS.readChangelog(ROOT);
    const d = NS.collect(cl, '2.0.9');
    eq(d.prev, '2.0.8');
    truthy(d.count >= 20, '2.0.8 之后有 20 多个测试版，实际 ' + d.count);
    truthy(d.betas.some((b) => b.version === '2.0.8.23'), '最新的那个要在');
    truthy(d.betas.some((b) => b.version === '2.0.8.1'), '最早的那个也要在');
    const md = NS.markdown(cl, '2.0.9');
    truthy(md.length > 3000, '汇总不能只有几行标题，实际 ' + md.length);
  });

  await test('★ 三条出口共用一份数据：Release 正文与断言都 require 本模块', () => {
    const gh = fs.readFileSync(path.join(ROOT, 'scripts/gh-release.js'), 'utf8');
    truthy(gh.indexOf("require('./notes-summary')") >= 0, 'gh-release.js 要用汇总模块');
    truthy(gh.indexOf('本版汇总的测试版要点') < 0, '旧的「只出标题」写法要拆掉');
    const audit = fs.readFileSync(path.join(ROOT, 'scripts/release-audit.js'), 'utf8');
    truthy(audit.indexOf("require('./notes-summary')") >= 0, 'release-audit.js 要用同一份范围');
    truthy(audit.indexOf('NS.MARK_START') >= 0, '稳定版要断言汇总段真的注入了');
    const self = fs.readFileSync(path.join(ROOT, 'scripts/notes-summary.js'), 'utf8');
    truthy(self.indexOf("'--write'") >= 0, '要能写进说明页草稿（给 am 渲染）');
  });

  await test('★ 稳定版草稿没有汇总段 ⇒ 出包断言拦下', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kh-notes-'));
    fs.mkdirSync(path.join(tmp, 'src', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.tmp', 'notes'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'release', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ version: '2.0.10' }), 'utf8');
    fs.writeFileSync(path.join(tmp, 'src', 'ui', 'changelog.js'),
      "const CHANGELOG = [\n  { version: '2.0.10', items: [] },\n  { version: '2.0.9.1', items: [] },\n  { version: '2.0.9', items: [] },\n];\n", 'utf8');
    fs.writeFileSync(path.join(tmp, '.tmp', 'notes', 'v2.0.10.md'),
      '---\ntitle: 2.0.10\n---\n\n' + '内容'.repeat(120) + '\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'release', 'notes', 'v2.0.10.html'), '<html>2.0.10</html>', 'utf8');
    const r = A.audit({ root: tmp, version: '2.0.10' });
    eq(r.ok, false);
    truthy(r.errors.join(' ').indexOf('汇总段') >= 0, '要直接说缺汇总段');
    truthy(r.errors.join(' ').indexOf('notes-summary.js --write') >= 0, '要给出修法');
  });
};
