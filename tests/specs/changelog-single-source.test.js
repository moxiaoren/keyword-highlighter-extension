/* tests/specs/changelog-single-source.test.js — 版本说明的单一渲染源（台账 2026-11-14 第 10 条）
 * ----------------------------------------------------------------------------
 * 用户原话（2026-11-14）：「各渲染就统一，欢迎页只展示未读过的」；口径 A（已确认）：
 * 全部读过时不铺开全文、也不退化成空态，只留一行「本版说明已读，点开回看」。
 *
 * 本 spec 断言的是**行为**（判据与产出的 DOM），不是某段源码长什么样：
 *   · pickEntries 三态：首装只看当前版；lastSeen 落后时只把之后的新版本算未读；全读过时 unread 为空
 *   · 当前版本永不丢（lastSeen === version 时它进 read，可回看）
 *   · renderInto 产出的版本块结构唯一，类名由调用方给
 *   · 两页都加载同一份渲染入口，且不再各自写一套条目构造
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

module.exports = async function run() {
  const KH = H.loadKernel(['src/ui/changelog-render.js']);
  const R = KH.ChangelogRender;

  suite('changelog · 单一渲染源 + 未读裁剪（台账 #10）');

  await test('渲染入口注册在 KH 上，六项导出齐全', () => {
    truthy(R, 'src/ui/changelog-render.js 必须注册 window.KH.ChangelogRender');
    ['cmpVersion', 'itemEl', 'entryEl', 'renderInto', 'pickEntries'].forEach((k) => {
      eq(typeof R[k], 'function', k + ' 必须是函数（两页共用同一套判据与结构）');
    });
    eq(typeof R.SUMMARY, 'string', 'SUMMARY 文案也必须从这里取（不许页面里另写一句）');
    truthy(R.SUMMARY.indexOf('已读') >= 0 && R.SUMMARY.indexOf('回看') >= 0,
      'SUMMARY 要同时说清「已读」与「可回看」：' + R.SUMMARY);
  });

  await test('★ pickEntries 三态：首装只看当前版 / lastSeen 之后算未读 / 全读过 unread 为空', () => {
    const list = [
      { version: '2.0.10.10' }, { version: '2.0.10.9' },
      { version: '2.0.10.8' }, { version: '2.0.10.7' }
    ];
    const ver = '2.0.10.9';

    const first = R.pickEntries(list, { version: ver, lastSeen: null });
    eq(first.unread.map((e) => e.version).join(','), ver,
      '★ 首装只看当前版本（旧版本不在版面上，比当前版本新的也不上屏）');
    eq(first.read.length, 0, '首装没有「已读」可回看');

    const behind = R.pickEntries(list, { version: ver, lastSeen: '2.0.10.7' });
    eq(behind.unread.map((e) => e.version).join(','), '2.0.10.9,2.0.10.8',
      '★ lastSeen 之后的版本才算未读（当前版本与 2.0.10.8）');
    eq(behind.read.map((e) => e.version).join(','), '2.0.10.7', '读过的旧版本进 read，不再占版面');

    const allRead = R.pickEntries(list, { version: ver, lastSeen: ver });
    eq(allRead.unread.length, 0, '★ 全读过时 unread 必须为空（页面才会显示那一行入口）');
    eq(allRead.read[0].version, ver, '★ 当前版本永远可回看（旧判据会对 lastSeen === version 返回空集）');
    truthy(allRead.read.length > 1, '更旧的已读版本也留在 read 里（点开可回看）');
  });

  await test('★ renderInto 的版本块结构唯一，类名与锚点由调用方给', () => {
    const box = document.createElement('div');
    const entries = [{ version: '2.0.10.9', items: ['修复 `超时` 文案', '**加粗**也行'] }];
    R.renderInto(box, entries, {
      itemClass: 'kh-clip', titleClass: 'kh-rel-title', listClass: 'kh-rel-items',
      anchorId: (v) => 'chg-' + v.replace(/[^\w.]/g, '_')
    });
    const wrap = box.querySelector('.kh-clip');
    truthy(wrap, '版本块要按调用方给的 itemClass 挂类');
    eq(wrap.id, 'chg-2.0.10.9', '锚点由调用方的 anchorId 规则决定（设置页目录要能跳）');
    eq(wrap.querySelector('.kh-rel-title').textContent, '2.0.10.9', '标题就是版本号');
    const lis = wrap.querySelectorAll('.kh-rel-items li');
    eq(lis.length, 2, '每个条目一个 li（折叠判据按 li 计算样式数）');
    truthy(lis[0].textContent.indexOf('`') < 0, '★ 条目里的反引号由 Markdown 单源吃掉，不许上屏');
    truthy(lis[1].textContent.indexOf('**') < 0, '★ 加粗标记同样不许上屏');

    R.renderInto(box, [{ version: '1.0.0', items: ['只有一条'] }], { itemClass: 'kh-clip', listClass: 'kh-rel-items' });
    eq(box.querySelectorAll('.kh-clip').length, 1, '重渲染先清空，不许越画越多');
  });

  await test('★ 两页都加载同一份渲染入口，且不再各自写一条渲染实现', () => {
    truthy(/src\/ui\/changelog-render\.js/.test(readSrc('welcome/welcome.html')), '欢迎页要加载渲染入口');
    truthy(/src\/ui\/changelog-render\.js/.test(readSrc('options/options.html')), '设置页要加载同一个脚本');
    const wel = readSrc('welcome/welcome.js');
    const opt = readSrc('options/options.js');
    truthy(/KH\.ChangelogRender/.test(wel) && /renderInto\(/.test(wel), 'welcome 必须调共享渲染入口');
    truthy(/SUMMARY/.test(wel), '已读那一行的文案从共享入口取');
    falsy(/textContent = '暂无新版本说明'/.test(wel), '★ 不许再出现「暂无新版本说明」式空态');
    truthy(/KH\.ChangelogRender/.test(opt) && /entryEl\(/.test(opt), 'options 必须调共享渲染入口');
    falsy(/function changelogLi\(/.test(opt), '★ options 的第二套条目构造必须退场');
  });
};
