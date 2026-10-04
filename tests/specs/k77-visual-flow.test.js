/* tests/specs/k77-visual-flow.test.js — 「命中要符合视觉」：折叠内容算数 + 视觉连续不断词（K77 · 2026-09-22）
 * ----------------------------------------------------------------------------
 * 用户口径（原话）：
 *   ①「折叠 `<details>` 里直接写在标签下的裸文本仍会命中 —— 你是指因为内容过长、被临时折叠、可以展开的内容么。
 *      如果是的话，**我希望能够命中**，而且抓取后续单元格要是展开后的完整内容」
 *   ②「**展开后，内容和前面接续。视觉上是一个完整连续整体才算**」
 *      + 追问选项 A：「展开后只要在**同一个容器（如单元格 / 正文块）里接着读**就算，哪怕换行另起一行」
 *   ③「它**不同**于弹窗增加显示的文本、网页自己的悬停文本」；「浮层文字不显示就不命中，显示之后可以参与命中」
 *
 * ⚠️ 本轮**有意翻转 K76 的一条口径**：K76 曾把"闭合 `<details>` 的元素包裹内容命中"当成回退收窄掉，
 *    按 ① 那不是回退、那正是用户要的行为。K77 放回，且只放"**语义明确的折叠**"：
 *      · 算：闭合 `<details>` 的正文、`content-visibility:hidden`（含 `hidden="until-found"`）、`display:contents`
 *      · 不算：`display:none`（隐藏菜单 / 抽屉 / 弹窗关闭态）、`visibility:hidden`
 *
 * ⚠️ 装置要点（K76 踩过的两个坑，这里都避开了）：
 *   1. `display` 的默认值**必须按标签给**（`<span>` ⇒ `inline`）—— 扫描判"视觉行内级"看的就是它；
 *      一律给 `block` 会让每个 `<span>` 变成块级 ⇒ 跨节点 run 断开 ⇒ **假红**。
 *   2. `checkVisibility` 必须**忠实**（无盒 / 祖先隐藏 / 闭合 details 的正文 ⇒ false），
 *      否则反向验证会变成**假绿**。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/** 与 `scanner.js` 的 `INLINE_TAGS` 同形的退化白名单（只在拿不到计算样式时用） */
const INLINE_TAGS = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
]);

function baseStyle(el) {
  const tag = String((el && el.tagName) || '').toUpperCase();
  return {
    display: INLINE_TAGS.has(tag) ? 'inline' : 'block',
    visibility: 'visible', contentVisibility: 'visible', position: 'static', float: 'none'
  };
}
/** 挂"计算样式"（`renderState` / `isVisualInline` / `collapsedInPlace` 读的都是它） */
function styled(el, style) { el._khStyle = Object.assign({}, baseStyle(el), style || {}); return el; }
const cs = (el) => (el && el._khStyle) || baseStyle(el);

/** `<details>` 的垫片支持：`open` + 能把 `<summary>` 指出来（真 DOM 由浏览器解析，垫片要手挂） */
function details(summaryText, bodyNodes, open) {
  const d = H.el('details');
  d.open = !!open;
  const s = H.el('summary');
  s.appendChild(H.txt(summaryText));
  d.appendChild(s);
  for (const b of (bodyNodes || [])) d.appendChild(b);
  d.querySelector = (sel) => (sel === 'summary' ? s : null);
  d._summary = s;
  return d;
}

/** 装 `getComputedStyle` + 原型级 `checkVisibility`（跑完**原样还原**，别污染别的 spec） */
function withCss(fn) {
  const prevCS = global.getComputedStyle;
  const prevCV = H.ShimElement.prototype.checkVisibility;
  global.getComputedStyle = (el) => cs(el);
  H.ShimElement.prototype.checkVisibility = function () {
    /* 祖先（含自身）：display:none / visibility 隐藏 / content-visibility:hidden ⇒ 不渲染 */
    for (let n = this; n; n = n.parentElement) {
      const st = cs(n);
      if (st.display === 'none') return false;
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      if (st.contentVisibility === 'hidden') return false;
      /* 闭合 `<details>` 的**正文**不渲染（真浏览器 = UA 伪元素 `::details-content{content-visibility:hidden}`） */
      if (n.tagName === 'DETAILS' && !n.open) {
        const s = n.querySelector ? n.querySelector('summary') : null;
        if (!s || !s.contains(this)) return false;
      }
    }
    if (cs(this).display === 'contents') return false;      // **没有布局盒** ⇒ 一律判否（老缺陷的成因）
    return true;
  };
  try { return fn(); } finally {
    if (prevCS === undefined) delete global.getComputedStyle; else global.getComputedStyle = prevCS;
    if (prevCV === undefined) delete H.ShimElement.prototype.checkVisibility; else H.ShimElement.prototype.checkVisibility = prevCV;
  }
}

const rulesFor = (KH, text) => KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: text, enabled: true }] });
const textsOf = (nodes) => nodes.map((n) => String(n.nodeValue));

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const U = KH.Scanner.util;

  suite('K77 · 命中要符合视觉：折叠内容算数 + 视觉连续不断词');

  await test('★ A1 闭合 `<details>`：**正文**算"折叠在原位"、`<summary>` 不算（它本来就渲染）', () => {
    withCss(() => {
      const body = H.el('div'); body.appendChild(H.txt('辰式词'));
      const d = details('摘要甲', [body], false);
      const sum = d._summary;

      eq(U.renderState(body), 0, '正文自身的三种样式都"正常"（隐藏来自 UA 伪元素）⇒ renderState 看不出它不可见');
      eq(U.rendersSubtree(body), true, '闭合 `<details>` 的正文 = 折叠在原位、可展开 ⇒ **要算进可读内容**（K77 口径）');
      eq(U.collapsedInPlace(body), true, '`collapsedInPlace` 必须认出它');

      eq(U.rendersSubtree(sum), true, '`<summary>` 本来就渲染 ⇒ 必须算（不许因为父 details 闭合就把它当折叠）');
      eq(U.collapsedInPlace(sum), false, '`<summary>` 不是"折叠的正文"');

      const d2 = details('摘要乙', [H.el('div', null, ['辰式词'])], true);
      eq(U.rendersSubtree(d2._summary), true, '`<details open>` 的 summary 照常');
      eq(U.rendersSubtree(d2.lastChild), true, '`<details open>` 的正文照常（本来就渲染）');
    });
  });

  await test('★ A2 折叠 vs 真隐藏：`content-visibility:hidden` 算、`display:none` / `visibility:hidden` **不算**', () => {
    withCss(() => {
      const cv = styled(H.el('div'), { contentVisibility: 'hidden' });
      eq(U.rendersSubtree(cv), true, '`content-visibility:hidden` = 内容在原位、占位、可展开 ⇒ 算');
      eq(U.collapsedInPlace(cv), true, '`collapsedInPlace` 必须认出它');

      const none = styled(H.el('div'), { display: 'none' });
      eq(U.rendersSubtree(none), false, '`display:none`（隐藏菜单 / 抽屉 / 弹窗关闭态）⇒ **不算**（与 v1.99.99.16 一致）');
      const vis = styled(H.el('div'), { visibility: 'hidden' });
      eq(U.rendersSubtree(vis), false, '`visibility:hidden` ⇒ 不算（保守口径，`_e2e` 组 8d ⑥）');

      /* 顺序守卫：**折叠里再真隐藏**的，仍不许放行 */
      const inner = styled(H.el('div'), { display: 'none' });
      inner.appendChild(H.txt('辰式词'));
      const d = details('摘要丙', [inner], false);
      eq(U.rendersSubtree(inner), false, '`<details>` 里又 `display:none` 的：先判"被显式隐藏" ⇒ 仍不放行（判序不能反）');
      truthy(d, '装置就位');
    });
  });

  await test('★ A3 闭合 `<details>` 里的**裸文本**与**元素包裹文本**都要进扫描范围（两半统一）', () => {
    withCss(() => {
      const bare = details('摘要丁', [], false);
      bare.appendChild(H.txt('裸词甲'));                       // 直接挂在 details 下的文本（K76 之前靠"漏网"命中）
      const wrapped = H.el('div'); wrapped.appendChild(H.txt('包裹词乙'));
      const d2 = details('摘要戊', [wrapped], false);

      const box = H.el('div');
      box.appendChild(bare); box.appendChild(d2);

      const texts = textsOf(U.textNodesIn(box));
      truthy(texts.indexOf('裸词甲') >= 0, '裸文本必须进扫描范围，实际 ' + JSON.stringify(texts));
      truthy(texts.indexOf('包裹词乙') >= 0, '元素包裹的正文也必须进扫描范围（K76 曾把它收窄掉，K77 放回）');

      eq(KH.Scanner.scan(box, rulesFor(KH, '裸词甲')).length, 1, '裸文本那段要命中');
      eq(KH.Scanner.scan(box, rulesFor(KH, '包裹词乙')).length, 1, '元素包裹那段要命中');
      truthy(KH.Scanner._lastScan.collapsedPassThrough >= 1, '折叠放行要计入 collapsedPassThrough，实际 ' + KH.Scanner._lastScan.collapsedPassThrough);
    });
  });

  await test('★ A4 视觉连续：`display:inline` 的块级标签**不许**切断词；`display:block` 仍断', () => {
    withCss(() => {
      const mk = (mid) => {
        const box = H.el('div');
        const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
        const w = H.el('div'); if (mid) styled(w, { display: mid }); w.appendChild(H.txt('式'));
        const s2 = H.el('span'); s2.appendChild(H.txt('词'));
        box.appendChild(s1); box.appendChild(w); box.appendChild(s2);
        return box;
      };
      eq(KH.Scanner.scan(mk('inline'), rulesFor(KH, '辰式词')).length, 1,
        '`<div style="display:inline">` 视觉上就在同一行里 ⇒ 不许把它当断行边界（旧口径按标签名 DIV 判，凭空切断词）');
      eq(KH.Scanner.scan(mk('block'), rulesFor(KH, '辰式词')).length, 0,
        '`display:block` 是真的另起一块 ⇒ 仍必须断开（对照臂）');
    });
  });

  await test('★ A5 `relevance`：折叠内容上的 `class` 变化按"可见"判（显隐口径同源）', () => {
    withCss(() => {
      const bodyEl = H.el('div'); bodyEl.appendChild(H.txt('辰式词'));
      const d = details('摘要己', [bodyEl], false);       // 闭合的 details ⇒ 正文是"折叠在原位"
      const el = {
        nodeType: 1, tagName: 'DIV', textContent: '辰式词', parentElement: d, isConnected: true,
        children: [], hasAttribute: () => false, closest() { return null; }, contains() { return false; },
        querySelector() { return null; },
        checkVisibility() { return false; }                       // 折叠内容：原生可见性判断一律判否
      };
      const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
      const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
      Object.defineProperty(KH, 'rules', { value: [rulesFor(KH, '辰式词')[0]], configurable: true });
      Object.defineProperty(KH, 'registry', { value: { all: () => [], size: 0 }, configurable: true });
      let v;
      try {
        v = KH.Relevance.classify([{ type: 'attributes', target: el, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
      } finally {
        if (dRules) Object.defineProperty(KH, 'rules', dRules);
        if (dReg) Object.defineProperty(KH, 'registry', dReg);
      }
      eq(v, 'full', '折叠内容是"可见内容" ⇒ 按"子树里可能出现关键词"取样 ⇒ full，实际 ' + v);
    });
  });

  await test('★ A6 负例：`display:none` / `visibility:hidden` 的既有口径**没被放宽**（隐藏菜单不许放回来）', () => {
    withCss(() => {
      const box = H.el('div');
      const n = styled(H.el('div'), { display: 'none' });
      n.appendChild(H.txt('隐藏 辰式词'));
      const v = styled(H.el('div'), { visibility: 'hidden' });
      v.appendChild(H.txt('不可见 辰式词'));
      const ok = H.el('div'); ok.appendChild(H.txt('可见 辰式词'));
      box.appendChild(n); box.appendChild(v); box.appendChild(ok);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 1, '只有可见那段能进扫描范围，实际 ' + JSON.stringify(texts));
      eq(KH.Scanner.scan(box, rulesFor(KH, '辰式词')).length, 1, '两条真隐藏都不许命中');
      eq(KH.Scanner._lastScan.collapsedPassThrough, 0, '它们不是"折叠" ⇒ 不许计入 collapsedPassThrough');
    });
  });

  await test('★ A7 记忆化缓存**不许跨轮陈旧**：同一元素先 inline 后 block，第二轮必须按新样式判', () => {
    withCss(() => {
      const wrap = H.el('div'); wrap.appendChild(H.txt('辰'));
      const s2 = H.el('span'); s2.appendChild(H.txt('式词'));
      const box = H.el('div'); box.appendChild(wrap); box.appendChild(s2);

      styled(wrap, { display: 'inline' });
      eq(KH.Scanner.scan(box, rulesFor(KH, '辰式词')).length, 1,
        'wrapper 是行内 ⇒ 跨节点 run 必须接上（`辰` + `式词`）');

      styled(wrap, { display: 'block' });                 // 模拟 class 切换（同一元素！）
      eq(KH.Scanner.scan(box, rulesFor(KH, '辰式词')).length, 0,
        'wrapper 改成块级 ⇒ 第二轮必须断开；**绿了就说明缓存是跨轮陈旧的**');

      styled(wrap, { display: 'inline' });
      eq(KH.Scanner.scan(box, rulesFor(KH, '辰式词')).length, 1, '再改回行内 ⇒ 又要接上（双向都要跟着变）');
    });
  });
};
