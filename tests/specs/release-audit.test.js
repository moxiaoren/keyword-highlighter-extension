/* tests/specs/release-audit.test.js — 发版口径断言（2026-11-12 用户要求）
 * ----------------------------------------------------------------------------
 * 用户原话：「测试版要 release，而且需要说明 html。这次没做。以及新增一个要求，
 * 稳定版的更新说明应该整理简化所有上个稳定版到这个稳定版的测试版更新，
 * 而不是只整理输出上个测试版的。（因为稳定版时给普通用户看的。）」
 *
 * 守三件事：
 *   1. 说明页草稿（.tmp/notes/v<版本>.md）与渲染产物（release/notes/v<版本>.html）缺一个就失败；
 *   2. 稳定版必须覆盖「上一个稳定版之后的所有测试版」，漏一个就失败；
 *   3. 两个出包脚本真的接上了这道闸（源码契约），不是写在文档里给人看的。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, eq, truthy } = H;

const A = require('../../scripts/release-audit');

function fixture(version, changelogVersions, opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-audit-'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version }), 'utf8');
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'ui', 'changelog.js'),
    'const CHANGELOG = [\n' + changelogVersions.map((v) => "  { version: '" + v + "', items: [] },").join('\n') + '\n];\n', 'utf8');
  fs.mkdirSync(path.join(root, '.tmp', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'release', 'notes'), { recursive: true });
  const body = o.md !== undefined ? o.md : '---\ntitle: ' + version + '\n---\n\n' + version + ' 更新说明，' + '内容'.repeat(120) + '\n';
  if (body) fs.writeFileSync(path.join(root, '.tmp', 'notes', 'v' + version + '.md'), body, 'utf8');
  if (o.html !== false) {
    const html = o.htmlText !== undefined ? o.htmlText : '<html><body><h1>' + version + ' 更新说明</h1></body></html>';
    fs.writeFileSync(path.join(root, 'release', 'notes', 'v' + version + '.html'), html, 'utf8');
  }
  return root;
}

module.exports = async function run() {
  suite('2.0.10.1 · 发版口径断言：说明页与稳定版汇总');

  await test('★ 测试版：草稿 + html 都在 ⇒ 通过', () => {
    const root = fixture('2.0.9.3', ['2.0.9.3', '2.0.9.2', '2.0.9', '2.0.8.23']);
    const r = A.audit({ root, version: '2.0.9.3' });
    eq(r.ok, true, r.errors.join('; '));
  });

  await test('★ 缺说明页草稿 ⇒ 失败（测试版也不许裸发）', () => {
    const root = fixture('2.0.9.3', ['2.0.9.3'], { md: '' });
    const r = A.audit({ root, version: '2.0.9.3' });
    eq(r.ok, false);
    truthy(r.errors.join(' ').indexOf('缺说明页草稿') >= 0, '要说清缺的是草稿');
  });

  await test('★ 缺 html ⇒ 失败（「这次没做」的就是这个）', () => {
    const root = fixture('2.0.9.3', ['2.0.9.3'], { html: false });
    const r = A.audit({ root, version: '2.0.9.3' });
    eq(r.ok, false);
    truthy(r.errors.join(' ').indexOf('缺说明页 html') >= 0);
  });

  await test('★ 稳定版：必须覆盖上一个稳定版之后的每一个测试版', () => {
    const versions = ['2.0.10', '2.0.9.2', '2.0.9.1', '2.0.9', '2.0.8.23'];
    const bad = fixture('2.0.10', versions, { md: '---\ntitle: 2.0.10\n---\n\n2.0.9.2 的那些改动…' + '内容'.repeat(120), htmlText: '<html>2.0.10</html>' });
    const rb = A.audit({ root: bad, version: '2.0.10' });
    eq(rb.ok, false, '只写最后一个测试版要拦下来');
    truthy(rb.errors.join(' ').indexOf('2.0.9.1') >= 0, '要点名漏了哪个测试版');

    const NS = require('../../scripts/notes-summary');
    const section =
      NS.MARK_START + '\n## 从 2.0.9 到 2.0.10：2 个测试版都改了什么\n\n### 2.0.9.2\n\n- **修复** 甲\n\n### 2.0.9.1\n\n- **新增** 乙\n\n' + NS.MARK_END;
    const good = fixture('2.0.10', versions, {
      md: '---\ntitle: 2.0.10\n---\n\n2.0.10 更新说明' + '内容'.repeat(120) + '\n\n' + section,
      htmlText: '<html>2.0.10 更新说明 2 个测试版都改了什么 2.0.9.2 2.0.9.1</html>',
    });
    const rg = A.audit({ root: good, version: '2.0.10' });
    eq(rg.ok, true, rg.errors.join('; '));
  });

  await test('★ betasBetween：只取「上一个稳定版之后」的四段号', () => {
    const versions = ['2.0.10', '2.0.9.2', '2.0.9.1', '2.0.9', '2.0.8.23', '2.0.8'];
    eq(A.betasBetween(versions, '2.0.10').join(','), '2.0.9.2,2.0.9.1', '不能把 2.0.8.23 算进来');
    eq(A.betasBetween(versions, '2.0.9').join(','), '2.0.8.23');
    eq(A.isStable('2.0.9.3'), false);
    eq(A.isStable('2.0.10'), true);
  });

  await test('★ 源码契约：两个出包脚本都真的接了这道闸', () => {
    const root = path.join(__dirname, '..', '..');
    const beta = fs.readFileSync(path.join(root, 'scripts/release-beta.js'), 'utf8');
    const rel = fs.readFileSync(path.join(root, 'scripts/release.js'), 'utf8');
    truthy(beta.indexOf("require('./release-audit').audit") >= 0, 'release-beta.js 要调用 audit');
    truthy(rel.indexOf("require('./release-audit').audit") >= 0, 'release.js 要调用 audit');
    truthy(beta.indexOf("'[0b]") >= 0 || beta.indexOf('[0b] 发版口径') >= 0, '测试版出包要有 0b 步骤');
  });
};
