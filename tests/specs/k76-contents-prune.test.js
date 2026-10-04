/* tests/specs/k76-contents-prune.test.js — 扫描剪枝口径（K76 · 2026-09-22）
 * ----------------------------------------------------------------------------
 * 缺陷（K75 的 R4 红队独立发现，非最近几轮引入）：
 *   任何被 `display:contents` 包住的命中词，本插件**完全不高亮**。
 *   根因：`display:contents` 的元素**没有布局盒** ⇒ 原生 `el.checkVisibility({checkVisibilityCSS:true})`
 *   对它**一律返回 false**（真机读数 `{"self":false,"kid":true}`），而旧实现把这个 false 直接当成
 *   "整棵子树不渲染" ⇒ `FILTER_REJECT` ⇒ **该行文本根本没进扫描**。
 *
 * 【同族但不属本轮改动的一条（口径是**刻意**的，不是缺陷）】
 *   `visibility:hidden` 祖先里再自己 `visibility:visible` 的后代**照旧整块不扫**：
 *   这是既有的保守取舍，由 `_e2e/content.test.js` 组 8d ⑥ 的 `#re-visible = 0` 锁着
 *   （原话："极罕见，不值得为它放宽成『只跳自己、继续下钻』"）。本条在 A5 里也钉一遍，
 *   免得以后有人顺手放宽而不知道有这条口径。
 *
 * 【R4 复验抓到的一条回退 → R0 收紧（2026-09-22）】
 *   R3 第一版把"原生判否"整个交给三样式法定性，于是**闭合 `<details>` 里的词开始命中**
 *   （真机 A/B：K76 = 1 处 / K76 前的发布副本 = 0 处）—— Chromium 用 UA 伪元素
 *   `::details-content{content-visibility:hidden}` 藏内容，子元素自身的 `content-visibility` 仍是 `visible`。
 *   现在收紧为：**原生判否时只允许 `display:contents` 推翻**，其余一律剪掉（A9 钉住）。
 *
 * 本文件锁死三件事：
 *   ① 剪枝口径只允许有一份实现（`Scanner.util.renderState` 的 0/1/2 三态）；
 *   ② `display:contents` 的**子树**要照常扫；`display:none` / `content-visibility:hidden` /
 *      `visibility:hidden` 仍整块不扫（前两者的 v1.99.99.16 口径不许回退）；
 *   ③ 口径不许再退回"`checkVisibility` 的布尔值就是结论"。
 *
 * ⚠️ 垫片没有 `getComputedStyle` / `checkVisibility`，而这两个 API 正是缺陷的现场。
 *   本文件在 `withRealVisibility` 里**同时补上两者**，并且让 `checkVisibility` 忠实模仿真浏览器
 *   （无布局盒 ⇒ false）—— 否则测到的是"退化路径"，而退化路径本来就是对的，等于**假绿**。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const VISIBLE = { display: 'block', visibility: 'visible', contentVisibility: 'visible', position: 'static', float: 'none' };
const CONTENTS = { display: 'contents' };
const HIDDEN_VIS = { visibility: 'hidden' };
const DISPLAY_NONE = { display: 'none' };
const CV_HIDDEN = { contentVisibility: 'hidden' };

/** 退化用的标签名白名单（与 `scanner.js` 的 `INLINE_TAGS` 同形） */
const INLINE_TAGS_STUB = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
]);

/** 默认计算样式 —— ⚠️ `display` **必须按标签给**（`<span>` ⇒ `inline`）：
 *  K77 起扫描判"视觉行内级"看的就是它，一律给 `block` 会把每个 `<span>` 当成块级 ⇒ 跨节点 run 断开 ⇒ **假红**。 */
function baseStyle(el) {
  const tag = String((el && el.tagName) || '').toUpperCase();
  return {
    display: INLINE_TAGS_STUB.has(tag) ? 'inline' : 'block',
    visibility: 'visible', contentVisibility: 'visible', position: 'static', float: 'none'
  };
}

/** 给垫片元素挂一份"计算样式"（`renderState` / `isVisualInline` 读的就是它） */
function styled(el, style) { el._khStyle = Object.assign({}, baseStyle(el), style || {}); return el; }

/**
 * 装上 `getComputedStyle` + 原型级 `checkVisibility`，跑完**原样还原**（单测共用一个进程，
 * 泄漏出去会让别的 spec（比如 diag-selfcheck 的 `hidden` 属性口径）变成另一种环境）。
 */
function withRealVisibility(fn) {
  const prevCS = global.getComputedStyle;
  const prevCV = H.ShimElement.prototype.checkVisibility;
  global.getComputedStyle = (el) => (el && el._khStyle) || baseStyle(el);
  /* 忠实模仿真浏览器：**没有布局盒**的元素（`display:none` / `display:contents` …）一律 false。
   * 这正是真机上那个缺陷的成因。 */
  H.ShimElement.prototype.checkVisibility = function () {
    if (this.hasAttribute && this.hasAttribute('hidden')) return false;
    if (this._khNoBox) return false;      // 装置扩展：模仿"只有原生 API 看得见的隐藏"（闭合 <details> 的 ::details-content）
    const st = this._khStyle || baseStyle(this);
    if (st.display === 'none' || st.display === 'contents') return false;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (st.contentVisibility === 'hidden') return false;
    return true;
  };
  try { return fn(); } finally {
    if (prevCS === undefined) delete global.getComputedStyle; else global.getComputedStyle = prevCS;
    if (prevCV === undefined) delete H.ShimElement.prototype.checkVisibility; else H.ShimElement.prototype.checkVisibility = prevCV;
  }
}

const rulePlain = (src) => ({ pattern: new RegExp(src, 'g'), labelPattern: null, flags: {}, meta: {} });
const rulesFor = (KH, text) => KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: text, enabled: true }] });
const textsOf = (nodes) => nodes.map((n) => String(n.nodeValue));

/** 给 A8（变更相关性）用的极简假元素：`classify` 只碰这几个口子（与 relevance.test.js 同形）。
 *  ⚠️ 必须带上**忠实模仿真浏览器的 `checkVisibility`**（无布局盒 ⇒ false）：
 *  A8 要钉住的口径正是"旧写法读 `checkVisibility`、新写法读 `renderState`"，
 *  假元素没有这个方法时旧写法会走 `: true` 兜底 ⇒ **反向验证 R-3 抓不到差别（假绿）**。
 *  实测记录：第一版 A8 就是这样写成假绿的，补上这个方法后 R-3 才真正变红。 */
function fakeEl(tag, text) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'DIV').toUpperCase(),
    textContent: text == null ? '' : String(text),
    parentElement: null,
    isConnected: true,
    children: [],
    hasAttribute: () => false,
    closest() { return null; },
    contains() { return false; },
    querySelector() { return null; },
    checkVisibility() {
      const st = el._khStyle || VISIBLE;
      if (st.display === 'none' || st.display === 'contents') return false;
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      if (st.contentVisibility === 'hidden') return false;
      return true;
    }
  };
  return el;
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const U = KH.Scanner.util;

  suite('K76 · 扫描剪枝口径：`display:contents`（无盒但子树渲染）/ `visibility`（只跳自己）');

  await test('★ A1 剪枝口径的唯一真源：`renderState` 三态 = 0 / 1 / 2', () => {
    truthy(typeof U.renderState === 'function', '`Scanner.util.renderState` 必须存在（口径要能被别的模块共用）');
    withRealVisibility(() => {
      eq(U.renderState(styled(H.el('div'), CONTENTS)), 0,
        '`display:contents` 没有布局盒，但它的子树照常渲染 ⇒ 必须是 0（旧实现在这里被原生 API 判成"不可见"）');
      eq(U.renderState(styled(H.el('div'), HIDDEN_VIS)), 1,
        '`visibility:hidden` ⇒ 只跳自己（后代可用 `visibility:visible` 覆盖）');
      eq(U.renderState(styled(H.el('div'), DISPLAY_NONE)), 2, '`display:none` ⇒ 整棵子树不渲染');
      eq(U.renderState(styled(H.el('div'), CV_HIDDEN)), 2, '`content-visibility:hidden` ⇒ 整棵子树不渲染');
      eq(U.renderState(styled(H.el('span'), { visibility: 'visible' })), 0, '显式 `visibility:visible` ⇒ 正常渲染');
    });
    /* 拿不到计算样式时退化成"只认 hidden 属性"的保守判定（老环境 / 垫片默认） */
    const hid = H.el('div'); hid.setAttribute('hidden', '');
    eq(U.renderState(hid), 2, '没有 getComputedStyle 时：`hidden` 属性 ⇒ 2');
    eq(U.renderState(H.el('div')), 0, '没有 getComputedStyle 时：普通元素 ⇒ 0（保守当可见）');
    eq(U.renderState(null), 0, '非元素 ⇒ 0');
  });

  await test('★ A2 `display:contents` 容器里的文本必须进扫描范围（旧实现在这里整行 REJECT）', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const c = styled(H.el('div'), CONTENTS);
      c.appendChild(H.txt('内容甲'));
      const plain = H.el('div');
      plain.appendChild(H.txt('内容乙'));
      box.appendChild(c);
      box.appendChild(plain);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 2, '两个文本节点都该收到，实际收到：' + JSON.stringify(texts));
      truthy(texts.indexOf('内容甲') >= 0, '`display:contents` 里的文本必须被扫到（否则命中词永远不高亮）');
      truthy(texts.indexOf('内容乙') >= 0, '对照臂：普通容器照旧');
    });
  });

  await test('★ A3 `display:none` 仍被剪掉；`content-visibility:hidden` 自 K77 起按"折叠在原位"**放行**', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const n = styled(H.el('div'), DISPLAY_NONE);
      n.appendChild(H.txt('隐藏 华为 通过'));
      const cv = styled(H.el('div'), CV_HIDDEN);
      cv.appendChild(H.txt('折叠 华为 通过'));
      const vis = H.el('div');
      vis.appendChild(H.txt('审核 华为 通过'));
      box.appendChild(n); box.appendChild(cv); box.appendChild(vis);

      const nodes = textsOf(U.textNodesIn(box));
      truthy(nodes.indexOf('隐藏 华为 通过') < 0, '`display:none`（真·隐藏：隐藏菜单 / 抽屉 / 弹窗关闭态）不许进扫描范围');
      truthy(nodes.indexOf('折叠 华为 通过') >= 0, '`content-visibility:hidden` = 内容在原位、可展开 ⇒ **必须**进扫描范围（K77 口径）');

      const hits = KH.Scanner.scan(box, rulesFor(KH, '华为'));
      eq(hits.length, 2, '可见那段 + 折叠那段都该命中（`display:none` 那段不命中），实际 ' + hits.length);
      truthy(KH.Scanner._lastScan.prunedInvisible >= 1, '`display:none` 必须仍计入 prunedInvisible，实际 ' + KH.Scanner._lastScan.prunedInvisible);
      truthy(KH.Scanner._lastScan.collapsedPassThrough >= 1, '折叠放行必须计入 collapsedPassThrough，实际 ' + KH.Scanner._lastScan.collapsedPassThrough);
    });
  });

  await test('★ A4 `visibility:hidden` 容器里的文本仍整块不扫（v1.99.99.16 的口径不许回退）', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const v = styled(H.el('div'), HIDDEN_VIS);
      v.appendChild(H.txt('隐藏 华为 通过'));
      box.appendChild(v);

      const hits = KH.Scanner.scan(box, rulesFor(KH, '华为'));
      eq(hits.length, 0, '隐藏容器里的词不许命中（这是 v1.99.99.16 修过的旧事故）');
      eq(textsOf(U.textNodesIn(box)).length, 0, '隐藏容器里的文本不许进扫描范围');
      truthy(KH.Scanner._lastScan.prunedInvisible >= 1, '`visibility:hidden` 与 `display:none` 一视同仁：都要计入 prunedInvisible，实际 ' + KH.Scanner._lastScan.prunedInvisible);
    });
  });

  await test('★ A5 `visibility:hidden` 里再自己 `visibility:visible` 的后代**照旧不扫**（刻意保守口径，`_e2e` 组 8d ⑥ 锁着）', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const v = styled(H.el('div'), HIDDEN_VIS);
      v.appendChild(H.txt('隐藏的 华为'));
      const shown = styled(H.el('span'), { visibility: 'visible' });
      shown.appendChild(H.txt('露出来的 华为'));
      v.appendChild(shown);
      box.appendChild(v);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 0, '整块都不扫，实际收到：' + JSON.stringify(texts));
      const hits = KH.Scanner.scan(box, rulesFor(KH, '华为'));
      eq(hits.length, 0, '一个都不许命中（与 `_e2e/content.test.js` 组 8d ⑥ 的 `#re-visible = 0` 同一条口径）');
    });
  });

  await test('★ A6 `display:contents` 里被两个行内子节点拆开的词（不跨出该边界）必须命中', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const c = styled(H.el('div'), CONTENTS);
      const s1 = H.el('span'); s1.appendChild(H.txt('词'));
      const s2 = H.el('span'); s2.appendChild(H.txt('己'));
      c.appendChild(s1); c.appendChild(s2);
      box.appendChild(c);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 2, '两段文本都该扫到，实际：' + JSON.stringify(texts));
      const hits = KH.Scanner.scan(box, rulesFor(KH, '词己'));
      eq(hits.length, 1, '被行内标签拆开、但**没有跨出** `display:contents` 边界的词必须命中（跨节点 run 不许在这里断）');
      truthy(KH.Scanner._lastScan.contentsPassThrough >= 1, '`display:contents` 的放行必须留下计数，实际 ' + KH.Scanner._lastScan.contentsPassThrough);
    });
  });

  await test('★ A7 `display:contents` 里的**直接文本**被行内标签拆开也要命中（`isHiddenEl` 那条路的现场）', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      const c = styled(H.el('div'), CONTENTS);
      c.appendChild(H.txt('辰'));
      const mid = H.el('span'); mid.appendChild(H.txt('式'));
      c.appendChild(mid);
      c.appendChild(H.txt('词'));
      box.appendChild(c);

      const hits = KH.Scanner.scan(box, rulesFor(KH, '辰式词'));
      eq(hits.length, 1, '文本的**直接父元素**就是那个无盒容器时，跨节点 run 不许把它当成"隐藏"剔出去（旧 `isHiddenEl` 正是在这里切断词）');
    });
  });

  await test('★ A8 变更相关性：`display:contents` 上的 `class` 变化必须按"可见"判（不许走"变成不可见"那条错分支）', () => {
    withRealVisibility(() => {
      const box = fakeEl('DIV', '辰式词');
      box._khStyle = Object.assign({}, VISIBLE, CONTENTS);
      const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
      const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
      Object.defineProperty(KH, 'rules', { value: [rulePlain('辰式词')], configurable: true });
      Object.defineProperty(KH, 'registry', { value: { all: () => [], size: 0 }, configurable: true });
      let v;
      try {
        v = KH.Relevance.classify(
          [{ type: 'attributes', target: box, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
      } finally {
        if (dRules) Object.defineProperty(KH, 'rules', dRules);
        if (dReg) Object.defineProperty(KH, 'registry', dReg);
      }
      eq(v, 'full', '`display:contents` 是"可见"的 ⇒ 按"子树里可能出现关键词"取样 ⇒ full，实际 ' + v);
    });
  });

  await test('★ A9 `checkVisibility` 判否、但三种样式都"可见"、又**不是** `display:contents` ⇒ 仍不许扫（闭合 `<details>` 那类 UA 隐藏）', () => {
    withRealVisibility(() => {
      const box = H.el('div');
      /* ⚠️ `_khNoBox` 必须是**元素自身**的属性（挂在 `_khStyle` 里的话桩读不到 —— 第一版就写成那样，
       * 于是 `rendersSubtree` 拿到"三样式都可见"⇒ 假红。真机那条由探针 B10 独立证明）。 */
      const noBox = styled(H.el('div'), null);
      noBox._khNoBox = true;
      noBox.appendChild(H.txt('辰式词'));
      box.appendChild(noBox);

      eq(U.renderState(noBox), 0, '哨兵：三种样式法看不出这层隐藏 ⇒ 剪枝决策**不能**只靠 `renderState`');
      eq(U.rendersSubtree(noBox), false, '决策判据 `rendersSubtree` 必须判它"不渲染"');
      eq(textsOf(U.textNodesIn(box)).length, 0, '原生判否时**只允许 `display:contents` 推翻**，这类隐藏不许被放开');
      const hits = KH.Scanner.scan(box, rulesFor(KH, '辰式词'));
      eq(hits.length, 0, '页面上看不见的词不许命中（v1.99.99.16 的用户口径）');
      eq(KH.Scanner._lastScan.contentsPassThrough, 0, '这不是"无盒放行"，不该计到 contentsPassThrough');
      truthy(KH.Scanner._lastScan.prunedInvisible >= 1, '它必须被剪掉并计数，实际 ' + KH.Scanner._lastScan.prunedInvisible);
    });
  });
};
