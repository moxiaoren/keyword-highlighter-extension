/* tests/specs/modal-width-resize.test.js — 【2.0.2.7 需求③④】编辑器弹窗加宽/可拖宽 + 设置页「置顶排序」合框
 * ----------------------------------------------------------------------------
 * 用户原话（需求③）："添加关键词-重要笔记模块，宽度当前是多少，我发现经常添加 4 列的表格时就出现
 *   横向的滚动条了。可不可以适当增加默认宽度，然后改成和纵向一样，支持拖动临时拉伸宽度。"
 * 规范原话："③(a) 加宽 + (b) 弹窗可拖宽（含 4–5 处断言同步）"
 * 用户原话（需求④）："设置页那个卡片排序也改成下拉框内部展示胶囊吧，顺便优化一下下拉框的美观度和操作便捷性。"
 *
 * 这里锁**几何数字与结构**（毫秒级、无浏览器）；真机读数由 `_e2e` 覆盖：
 *   · `_e2e/content.test.js` 页内 ShadowRoot 委托：`r.w === 1040`
 *   · `_e2e/ui.test.js` O-6 / O-5：`1020 ≤ w ≤ 1060`
 *   · `_e2e/ui.test.js` 富文本编辑框：computed `resize` 含 both/horizontal
 * 为什么数字要进单测：860 → 1040 这种"文档里的当前值"只有脚本核对得住（票 #42 的口径）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 取 CSS 里某条规则的声明块（`sel {` 到下一个 `}`）—— 选择器在文件里必须唯一出现一次 */
function block(css, sel) {
  const i = css.indexOf(sel + ' {');
  if (i < 0) return null;
  const j = css.indexOf('}', i);
  return j < 0 ? null : css.slice(i + sel.length, j);
}

module.exports = async function run() {
  const css = read('src/ui/components/components.css');
  const modalLg = block(css, '.kh-modal-lg');
  /* 【票 #48】几何真值只在 `src/core/config.js` 声明一次（`EDITOR_W` / `EDITOR_WIN_PAD`），
   * 这里**读它**来核对 CSS 与开窗参数 —— 单测里再抄一个 1040 就是又一处漂移源。
   * 于是"改常量"只有两种结果：CSS 跟着改（绿）或没跟着改（这里红）。 */
  const CFG = read('src/core/config.js');
  const editorW = Number((/const EDITOR_W = (\d+);/.exec(CFG) || [])[1]);
  const winPad = Number((/const EDITOR_WIN_PAD = (\d+);/.exec(CFG) || [])[1]);
  const POPUP = read('popup/popup.js');

  suite('编辑器弹窗宽度与可拖宽（2.0.2.7 需求③）');

  await test('★ `.kh-modal-lg` 默认宽 = `KH.Config.EDITOR_W`（860 时三列各 267px，4 列表格必横向滚）', () => {
    truthy(modalLg, 'components.css 里应有 `.kh-modal-lg { … }` 规则');
    truthy(editorW > 0, 'src/core/config.js 里应有 `const EDITOR_W = <数字>;`（几何唯一真值）');
    truthy(new RegExp('min\\(' + editorW + 'px,\\s*100%\\)').test(modalLg),
      '★ 默认宽必须写成 `min(' + editorW + 'px, 100%)`（窄窗口自动退成 100%），实际 ' + JSON.stringify(modalLg));
    falsy(/max-width:\s*860px/.test(css),
      '★ 不许再有 `max-width: 860px` —— 写成 max-width 会把拖拽上限也钉在 860，"临时拉宽"就只剩变窄');
  });

  await test('★ 弹窗右下角可横向拖动，且能**超过**默认宽（独立窗口要比它更宽）', () => {
    truthy(/resize:\s*horizontal/.test(modalLg), '★ `.kh-modal-lg` 要有 `resize: horizontal`，实际 ' + JSON.stringify(modalLg));
    /* 拖拽把手的前提：元素不能是 `overflow: visible`（`.kh-modal` 的 `overflow: hidden` 满足） */
    const modal = block(css, '.kh-modal');
    truthy(modal && /overflow:\s*hidden/.test(modal),
      '★ `.kh-modal` 必须 `overflow: hidden`，否则部分浏览器不出拖拽把手，实际 ' + JSON.stringify(modal));
    /* 兜底路径（独立编辑窗口）里遮罩两侧留白：窗口窄了弹窗就被钳住，"三条路径一模一样"破功。
     * 窗口宽不再手抄 1100，而是从 `EDITOR_WIN_W`（= EDITOR_W + 2×PAD）派生 ⇒ 只判关系与取用方式。 */
    truthy(winPad >= 20,
      '★ 遮罩两侧留白（`EDITOR_WIN_PAD`）至少 20px，现在 ' + winPad + ' —— 窗口窄了编辑器会被钳成 ' + (editorW - winPad * 2) + 'px');
    truthy(/width:\s*\(KH\.Config && KH\.Config\.EDITOR_WIN_W\)/.test(POPUP),
      '★ `popup.js` 开独立窗口的宽必须取自 `KH.Config.EDITOR_WIN_W`（不许再手抄 1100）');
  });

  await test('★ 富文本编辑框 / 文本域放开宽度（旧口径 `resize: vertical` 已随用户改口作废）', () => {
    const rte = block(css, '.kh-rte');
    truthy(rte && /resize:\s*both/.test(rte), '★ `.kh-rte` 应两向可拖，实际 ' + JSON.stringify(rte));
    falsy(rte && /resize:\s*vertical/.test(rte), '★ `.kh-rte` 不该再停在「宽度不支持」的旧口径');
    const ta = block(css, '.kh-textarea');
    truthy(ta && /resize:\s*both/.test(ta), '★ `.kh-textarea` 要跟着一致，实际 ' + JSON.stringify(ta));
  });

  suite('设置页「置顶排序」：胶囊与下拉框同一个框（2.0.2.7 需求④）');

  const html = read('options/options.html');
  const sec = (html.match(/<section[^>]*id="sec-style"[\s\S]*?<\/section>/) || [''])[0];

  await test('★ `#pin-caps` 与 `#pf-notePinOrder` 装在同一个 `.kh-pin-box` 里（不再一上一下两截）', () => {
    truthy(sec.length > 0, '要能定位「样式」分区');
    const m = /<div class="kh-pin-box">\s*<div class="kh-lbl-preview" id="pin-caps"><\/div>\s*<select class="kh-input" id="pf-notePinOrder"><\/select>\s*<\/div>/.exec(sec);
    const at = sec.indexOf('kh-pin-fld');
    truthy(m, '★ 两个元素必须包在同一个 `.kh-pin-box` 里（胶囊在前、下拉在后），实际片段：' + JSON.stringify(sec.slice(at, at + 560)));
  });

  await test('★ 框内下拉退成"接着加"的入口（去自己的边框/底色，否则双边框）', () => {
    const b = block(css, '.kh-pin-box > .kh-input');
    truthy(b, 'components.css 里应有 `.kh-pin-box > .kh-input` 规则');
    truthy(/border:\s*0/.test(b) && /background:\s*transparent/.test(b),
      '★ 框内下拉不许再带自己的边框/底色，实际 ' + JSON.stringify(b));
    truthy(/\.kh-pin-box:focus-within/.test(css), '框要有一体化聚焦态（否则看不出焦点落在框里）');
  });
};
