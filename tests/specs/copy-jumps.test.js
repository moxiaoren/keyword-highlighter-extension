/* tests/specs/copy-jumps.test.js — 2.0.8「文案跳转」
 * ----------------------------------------------------------------------------
 * 设置页正文里的指路文案（「ℹ️ 关于 → 版本信息」「完整历史在欢迎页」）以前是**纯文本**，
 * 现在是真的链接，走 `goSection()` 这条与顶部 Tab 相同的通道（`options/options.js`），
 * 可带 `data-hspan` 指定帮助区的二级 Tab。
 *
 * 为什么必须有一条守卫：`#sec-*` 是**资产契约**（分区 id ↔ `.kh-tab` 的 data-tab ↔ SECTIONS
 * 三处对齐），`data-hspan` 又是二级 Tab 的另一套 id。任何一侧改名都不会有红灯 ——
 * 点了没反应、或者跳到空白区，用户看到的只是"这个链接坏了"。
 * 本 spec 只做**资产对账**（id 是否存在），不断言文案措辞 —— 改文案不该假红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 取某属性的全部值（HTML 属性足够规整，不需要解析器） */
function attrsOf(html, attr) {
  const re = new RegExp(attr + '="([^"]*)"', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

module.exports = async function run() {
  suite('2.0.8 · 文案跳转：设置页里的指路链接必须指向真存在的分区 / 二级 Tab');

  const html = read('options/options.html');

  await test('★ 分区 id ↔ 导航 data-tab ↔ SECTIONS 三处对齐', () => {
    const secIds = attrsOf(html, 'id').filter((id) => /^sec-[a-z]+$/.test(id)).map((id) => id.slice(4));
    /* 导航里的 7 个 .kh-tab：`href="#sec-X"` 与 `data-tab="X"` 成对 */
    const tabHrefs = [];
    const tabDatas = [];
    const tabRe = /<a class="kh-tab"[^>]*>/g;
    let m;
    while ((m = tabRe.exec(html))) {
      const tag = m[0];
      const h = /href="#sec-([a-z]+)"/.exec(tag);
      const d = /data-tab="([a-z]+)"/.exec(tag);
      if (h) tabHrefs.push(h[1]);
      if (d) tabDatas.push(d[1]);
    }
    eq(tabHrefs.length, 7, '导航应有 7 个分区（SECTIONS 也是 7 个），实际 ' + tabHrefs.length);
    eq(tabHrefs.join(','), tabDatas.join(','), '每个 .kh-tab 的 href 与 data-tab 必须一一对应');
    for (const id of tabHrefs) {
      truthy(secIds.indexOf(id) >= 0, '导航指向的分区 `sec-' + id + '` 必须真的存在于页面里');
    }
  });

  await test('★ 正文里每个页内跳转（a[href^="#sec-"]）都必须指向存在的东西', () => {
    const secIds = attrsOf(html, 'id').filter((id) => /^sec-[a-z]+$/.test(id));
    const hpanIds = attrsOf(html, 'data-hpan');            // 二级 Tab 按钮与面板共用这个 id
    const anchors = [];
    const re = /<a\b[^>]*href="#sec-[^"]*"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) anchors.push(m[0]);
    truthy(anchors.length > 0, '正文里必须有页内指路链接（否则「文案跳转」等于没做）');
    for (const tag of anchors) {
      const href = /href="#(sec-[a-z]+)"/.exec(tag);
      if (!href) { /* `.kh-tab` 之外只有形如 #sec-x 的，这里不该出现别的 */ }
      truthy(secIds.indexOf(href[1]) >= 0, '指路链接指向的分区 `' + href[1] + '` 必须存在：' + tag);
      const span = /data-hspan="([a-z]+)"/.exec(tag);
      if (span) {
        truthy(hpanIds.indexOf(span[1]) >= 0,
          '`data-hspan="' + span[1] + '"` 必须是帮助区里真的存在的二级 Tab（否则点完切不到那一页）');
      }
    }
  });

  await test('★ 「关于 → 版本信息」这条指路文案真的有两条链接（功能面板 + Q11）', () => {
    const aboutLinks = [];
    const re = /<a\b[^>]*href="#sec-help"[^>]*data-hspan="about"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) aboutLinks.push(m[0]);
    eq(aboutLinks.length, 2,
      '正文里应有两处可点的「关于 → 版本信息」（功能说明里的快捷键那条 + Q11 更新日志那条），实际 ' + aboutLinks.length);
  });

  await test('★ 「欢迎页」链接指向的页面真的存在（相对路径不许写错层级）', () => {
    const hits = [];
    const re = /<a\b[^>]*href="([^"]*welcome[^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) hits.push(m[1]);
    truthy(hits.length > 0, '设置页必须能跳到欢迎页（更新日志的完整历史在那里）');
    for (const href of hits) {
      const abs = path.resolve(path.join(ROOT, 'options'), href);
      truthy(fs.existsSync(abs), '欢迎页链接 `' + href + '` 解析到 ' + abs + '，但那个文件不存在');
    }
  });
};
