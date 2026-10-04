/* tests/specs/k76-r4-recheck.test.js — K76 的 **R4 独立复验（红队）**（2026-09-22）
 * ----------------------------------------------------------------------------
 * 本文件**不是** R3 spec 的复制品：它换装置（更忠实的"计算样式 + checkVisibility"模型）、
 * 换角度（嵌套 / 标签种类 / 祖先剪枝的负例 / 退化路径 / 快路径计数哨兵 /
 * relevance 的双向口径 / §二.5 已知边界），目的是**主动证伪** R3 的口径。
 *
 * 装置与 R3 spec 的三个差别（都是为了少一点"假绿"空间）：
 *   ① `getComputedStyle` 是**真的在算**：`display` 认 UA 规则 `[hidden]{display:none}`，
 *      `visibility` **按继承**解析（最近一个有显式值的祖先/自身），`content-visibility` 不继承；
 *   ② `checkVisibility` **带祖先语义**（祖先 `display:none` / `content-visibility:hidden` ⇒ false），
 *      而不只是看自己 —— 真浏览器就是这样，也正因为这样它才对 `display:contents` 判否；
 *   ③ 所有用例都跑在"装置忠实性哨兵"（组 1）之下：先证明假元素**确实**会对 `display:contents`
 *      判否、对普通元素判是，否则测到的是退化路径 ⇒ **假绿**（R3 已经踩过一次，见契约 §七 的
 *      "R-3 第一次做出来是假绿"）。
 *
 * ⚠️ 单测垫片**没有** `getComputedStyle` / `checkVisibility`，而这两个 API 正是缺陷现场。
 *   本文件一律用 `withCss()` 现场装、`finally` 里**原样还原**（含"原本就没有 ⇒ delete"），
 *   组 8 顺手把"还原是否干净"钉成断言 —— 泄漏出去会让别的 spec 在另一种环境下跑。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, skip } = H;

/* ------------------------------------------------------------------ 装置 */

/** 自身→祖先链 */
function chainOf(el) {
  const a = [];
  let n = el;
  while (n && n.nodeType === 1) { a.push(n); n = n.parentNode; }
  return a;
}

/** 退化用的标签名白名单（只在拿不到计算样式时用）—— 与 `scanner.js` 的 `INLINE_TAGS` 同形 */
const INLINE_TAGS_STUB = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
]);

/** 忠实版"计算样式"：display（含 UA `[hidden]{display:none}` 规则）/ 继承的 visibility / content-visibility
 *  ⚠️ K77 起 `display` 的**默认值必须按标签给**（`<span>` ⇒ `inline`）——扫描的"视觉行内级"判据看的就是它；
 *  一律给 `block` 会让每个 `<span>` 被当成块级 ⇒ 跨节点 run 断开 ⇒ **假红**（K77 实测踩过）。 */
function computedOf(el) {
  const own = (el && el._khStyle) || {};
  let visibility = 'visible';
  for (const n of chainOf(el)) {
    const st = n._khStyle;
    if (st && st.visibility) { visibility = st.visibility; break; }
  }
  const tag = String((el && el.tagName) || '').toUpperCase();
  const hiddenAttr = !!(el.hasAttribute && el.hasAttribute('hidden'));
  /* ⚠️ K77 复验补的忠实度：`hidden="until-found"` 的 UA 规则是 **`content-visibility: hidden`**，
   *   而**不是** `display:none`。真机读数（Edge · 2026-09-22 R4 实测）：
   *   `<div hidden="until-found">` ⇒ `display=block` / `content-visibility=hidden` / `checkVisibility=false`。 */
  const untilFound = hiddenAttr && String(el.getAttribute('hidden') || '').toLowerCase() === 'until-found';
  return {
    display: own.display || (untilFound ? 'block'
      : hiddenAttr ? 'none'
        : (INLINE_TAGS_STUB.has(tag) ? 'inline' : 'block')),
    visibility: visibility,
    contentVisibility: own.contentVisibility || (untilFound ? 'hidden' : 'visible'),
    position: own.position || 'static',
    float: own.float || 'none'
  };
}

/** 闭合 `<details>` 的**正文**（`<summary>` 子树之外）—— 真浏览器里不渲染
 *  （UA 伪元素 `::details-content{content-visibility:hidden}`）。
 *  真机读数：`details` 自身 `cv=true` / 正文 `<p>` `cv=false` / `<details open>` 与 `<summary>` 子树 `cv=true`。 */
function inClosedDetailsContent(el) {
  for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
    if (n.tagName === 'DETAILS' && !n.open) {
      const s = n.querySelector ? n.querySelector('summary') : null;
      return !(s && s.contains(el));
    }
  }
  return false;
}

/** `getComputedStyle` 调用计数 —— 记忆化 / 零额外样式读的哨兵（K77 复验新增） */
let csCalls = 0;
function csReset() { csCalls = 0; }
function csCount() { return csCalls; }

/** 装 `getComputedStyle` + 原型级 `checkVisibility`（跑完原样还原；原本没有就删掉） */
function withCss(fn) {
  const prevCS = global.getComputedStyle;
  const prevCV = H.ShimElement.prototype.checkVisibility;
  global.getComputedStyle = (el) => { csCalls++; return computedOf(el); };
  H.ShimElement.prototype.checkVisibility = function () {
    const own = this._khStyle || {};
    /* 祖先（含自身）的 display:none / content-visibility:hidden ⇒ 整块不渲染（真浏览器同此） */
    for (const n of chainOf(this)) {
      const st = computedOf(n);
      if (st.display === 'none') return false;
      if (st.contentVisibility === 'hidden') return false;
    }
    /* 闭合 `<details>` 的**正文**不渲染（真浏览器 = UA 伪元素 `::details-content`）—— K77 复验补的忠实度 */
    if (inClosedDetailsContent(this)) return false;
    if (own.display === 'contents') return false;          // **没有布局盒** ⇒ 一律判否（缺陷的成因）
    if (own._khNoBox) return false;                        // 装置扩展：只有原生 API 看得见的隐藏（**不是**折叠类，见 R4-13）
    const cs = computedOf(this);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return true;
  };
  try { return fn(); } finally {
    if (prevCS === undefined) delete global.getComputedStyle; else global.getComputedStyle = prevCS;
    if (prevCV === undefined) delete H.ShimElement.prototype.checkVisibility; else H.ShimElement.prototype.checkVisibility = prevCV;
  }
}

/** 稀疏样式（不塞默认值：否则"继承"会被自己的 `visibility:'visible'` 截断，装置就不忠实了） */
function styled(el, style) { el._khStyle = Object.assign({}, style || {}); return el; }

/** `<details>` 的垫片（K77 复验新增）：`open` 用**属性 + 属性反射**都写上（实现读的是 `el.open`），
 *  `<summary>` 交给垫片的 `querySelector('summary')` —— 与实现同款查找，不额外造假。 */
function detailsEl(open, summaryText, bodyNodes) {
  const d = H.el('details');
  d.open = !!open;
  if (open) d.setAttribute('open', '');
  const s = H.el('summary');
  s.appendChild(H.txt(summaryText == null ? '摘要' : summaryText));
  d.appendChild(s);
  for (const n of (bodyNodes || [])) d.appendChild(n);
  return d;
}

/** 把 `leaf` 用 n 层 `<div>` 包起来（深度边界用） */
function nest(leaf, n) {
  let cur = leaf;
  for (let i = 0; i < n; i++) { const w = H.el('div'); w.appendChild(cur); cur = w; }
  return cur;
}

const ruleFor = (KH, text) => KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: text, enabled: true }] });
const textsOf = (nodes) => nodes.map((n) => String(n.nodeValue));

/** A8/R4-9 用的假元素：`classify` 只碰这几个口子（与 relevance.test.js 同形）。
 *  ⚠️ `checkVisibility` **必须**忠实（无盒 ⇒ false）：否则"旧写法读 checkVisibility"会落到真值兜底，
 *  反向验证就变成**假绿**（R3 踩过的坑）。 */
function fakeEl(tag, text, style) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'DIV').toUpperCase(),
    textContent: text == null ? '' : String(text),
    parentElement: null,
    isConnected: true,
    children: [],
    _khStyle: Object.assign({}, style || {}),
    hasAttribute: () => false,
    closest() { return null; },
    contains() { return false; },
    querySelector() { return null; },
    checkVisibility() {
      const st = el._khStyle || {};
      if (st._khNoBox) return false;                          // 装置扩展：只有原生 API 看得见的隐藏（UA 伪元素类）
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

  suite('K76 · R4 独立复验（红队）：换装置与角度再判 `display:contents` 剪枝口径');

  await test('★ R4-1 装置忠实性哨兵：假元素必须真的对 `display:contents` 判否（否则整份复验是假绿）', () => {
    withCss(() => {
      truthy(typeof H.ShimElement.prototype.checkVisibility === 'function',
        '装置必须装上 `checkVisibility`（缺陷现场就在这条 API 上）');
      const c = styled(H.el('div'), { display: 'contents' });
      const p = H.el('div');
      eq(c.checkVisibility({ checkVisibilityCSS: true }), false,
        '`display:contents` ⇒ 无布局盒 ⇒ 原生判否：**装置没做到这一点，后面所有"绿"都不算数**');
      eq(p.checkVisibility({ checkVisibilityCSS: true }), true, '普通元素 ⇒ 原生判是（快路径那一条）');
      eq(U.renderState(c), 0, '而 `renderState` 必须能把这个"判否"定性回 0（本轮修的就是这条）');
      eq(U.renderState(p), 0, '普通元素 ⇒ 0');
    });
  });

  await test('★ R4-2 `display:contents` **嵌套**（contents 里再套 contents）里的词必须命中', () => {
    withCss(() => {
      const box = H.el('div');
      const c1 = styled(H.el('div'), { display: 'contents' });
      const c2 = styled(H.el('section'), { display: 'contents' });
      c2.appendChild(H.txt('辰式词'));
      c1.appendChild(c2);
      box.appendChild(c1);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 1, '两层无盒容器都不许把子树剪掉，实际：' + JSON.stringify(texts));
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 1, '嵌套无盒容器里的词必须命中');
      /* R4 复验收紧：从 `>= 2` 改成 `=== 2` —— 计数是**对外可观测的契约**（探针/诊断读它），
       * "每层各记一次、且普通元素一次都不记"必须精确；`>=` 会把"多记/少记"一起放过。 */
      eq(KH.Scanner._lastScan.contentsPassThrough, 2,
        '两层各记一次放行（`c1`/`c2`），且它证明 checkVisibility 判否后**确实**走了 `rendersSubtree` 的放行分支，实际 ' +
        KH.Scanner._lastScan.contentsPassThrough);
    });
  });

  await test('★ R4-3 `display:contents` 落在**行内标签**（span）与**块级标签**（section）上都要命中', () => {
    withCss(() => {
      const box = H.el('div');
      /* 行内标签上的 contents：整词 */
      const w1 = H.el('div');
      const sp = styled(H.el('span'), { display: 'contents' });
      sp.appendChild(H.txt('辰式词'));
      w1.appendChild(sp);
      /* 块级标签上的 contents：里面被两个行内子节点拆开的词 */
      const w2 = H.el('div');
      const sec = styled(H.el('section'), { display: 'contents' });
      const a = H.el('span'); a.appendChild(H.txt('辰'));
      const b = H.el('span'); b.appendChild(H.txt('式词'));
      sec.appendChild(a); sec.appendChild(b);
      w2.appendChild(sec);
      box.appendChild(w1); box.appendChild(w2);

      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 2, '行内（整词）+ 块级（拆词）两条路都必须命中，实际 ' + hits.length +
        '，命中文本 = ' + JSON.stringify(hits.map((h) => h.text)));
      eq(textsOf(U.textNodesIn(box)).length, 3, '三段文本都要被扫到');
    });
  });

  await test('★ R4-4 负例：`display:contents` 落在隐藏祖先内部 ⇒ **仍然一个都不许扫**（不许把不该扫的扫进来）', () => {
    withCss(() => {
      const box = H.el('div');
      const none = styled(H.el('div'), { display: 'none' });
      const c1 = styled(H.el('div'), { display: 'contents' }); c1.appendChild(H.txt('辰式词'));
      none.appendChild(c1); box.appendChild(none);

      const vish = styled(H.el('div'), { visibility: 'hidden' });
      const c2 = styled(H.el('div'), { display: 'contents' }); c2.appendChild(H.txt('辰式词'));
      vish.appendChild(c2); box.appendChild(vish);

      const hidAttr = H.el('div'); hidAttr.setAttribute('hidden', '');
      const c3 = styled(H.el('span'), { display: 'contents' }); c3.appendChild(H.txt('辰式词'));
      hidAttr.appendChild(c3); box.appendChild(hidAttr);

      /* 对照臂：同样形状但祖先正常 */
      const ok = H.el('div');
      const c4 = styled(H.el('div'), { display: 'contents' }); c4.appendChild(H.txt('辰式词'));
      ok.appendChild(c4); box.appendChild(ok);

      const texts = textsOf(U.textNodesIn(box));
      eq(texts.length, 1, '只有对照臂那一段能被扫到，实际：' + JSON.stringify(texts));
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 1, '隐藏祖先里的 contents **一个字都不许命中**（这是 v1.99.99.16 口径的底线）');
      truthy(KH.Scanner._lastScan.prunedInvisible >= 3,
        '三种隐藏祖先都要计入 prunedInvisible，实际 ' + KH.Scanner._lastScan.prunedInvisible);
    });
  });

  await test('★ R4-5 `display:contents` + 自身 `visibility:hidden` ⇒ 仍不扫（后代显式 visible 也不例外，保守口径）', () => {
    withCss(() => {
      const box = H.el('div');
      const c = styled(H.el('div'), { display: 'contents', visibility: 'hidden' });
      c.appendChild(H.txt('辰式词'));
      const shown = styled(H.el('span'), { visibility: 'visible' });
      shown.appendChild(H.txt('辰式词'));
      c.appendChild(shown);
      box.appendChild(c);

      eq(U.renderState(c), 1, '无盒 + 自身 visibility:hidden ⇒ 定性为 1（不是 0）');
      eq(textsOf(U.textNodesIn(box)).length, 0, '整块都不许扫');
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 0, '一个都不许命中');
    });
  });

  await test('★ R4-6【K77 口径翻转】`hidden` 属性仍不扫；`content-visibility:hidden` = 折叠在原位 ⇒ **要扫**（含 author 覆盖 UA 的边界）', () => {
    withCss(() => {
      const box = H.el('div');
      const hid = H.el('div'); hid.setAttribute('hidden', '');
      hid.appendChild(H.txt('辰式词'));
      const cv = styled(H.el('div'), { contentVisibility: 'hidden' });
      cv.appendChild(H.txt('辰式词'));
      /* 边界（真实渲染语义）：inline style 的 `display:contents` **胜过** UA 规则 `[hidden]{display:none}`
       * ⇒ 真浏览器里这个元素是"无盒但子树渲染"的 ⇒ 必须扫（`hidden` 属性不是万能判据，
       *   这正是 `renderState` 在能拿到计算样式时**不看属性**的理由） */
      const both = H.el('div'); both.setAttribute('hidden', '');
      styled(both, { display: 'contents' });
      both.appendChild(H.txt('辰式词'));
      const uf = H.el('div'); uf.setAttribute('hidden', 'until-found');
      uf.appendChild(H.txt('辰式词'));
      box.appendChild(hid); box.appendChild(cv); box.appendChild(both); box.appendChild(uf);

      eq(U.renderState(hid), 2, '`hidden` 属性（UA ⇒ display:none）⇒ 2 —— 底层原语 `renderState` 的三态口径**没变**');
      eq(U.renderState(cv), 2, '`content-visibility:hidden` 在原语里仍是 2（它确实"自身不可见"）—— 变的只是**决策入口**');
      eq(U.renderState(uf), 2, '`hidden="until-found"` 同理（真机 = display:block + content-visibility:hidden）');
      eq(U.renderState(both), 0, 'author 显式 `display:contents` 覆盖 UA `[hidden]` ⇒ 0（真渲染是这样）');

      /* K77 口径：决策入口 `rendersSubtree` 只对"**语义明确的折叠**"放行 */
      eq(U.rendersSubtree(hid), false, 'K77：真隐藏（display:none）⇒ **不算**可读内容（隐藏菜单 / 抽屉口径不许放宽）');
      eq(U.rendersSubtree(cv), true, 'K77：`content-visibility:hidden` = 内容在原位、占位、可展开 ⇒ **要算**（本轮的翻转点）');
      eq(U.rendersSubtree(uf), true, 'K77：`hidden="until-found"` 与它同类（真机 d=block / cv=hidden）⇒ 要算');

      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 3, '三段"折叠 / 无盒"内容要命中，`hidden` 那段仍不扫，实际 ' + hits.length);
      truthy(KH.Scanner._lastScan.collapsedPassThrough >= 2,
        '折叠放行（cv + until-found）要计入 `collapsedPassThrough`，实际 ' + KH.Scanner._lastScan.collapsedPassThrough);
    });
  });

  await test('★ R4-7 快路径哨兵：全是可见普通元素的树上 `contentsPassThrough` 必须为 0（判"是"时零额外开销）', () => {
    withCss(() => {
      const box = H.el('div');
      for (let i = 0; i < 5; i++) {
        const d = H.el('div');
        const s = H.el('span'); s.appendChild(H.txt('辰式词' + i));
        d.appendChild(s); box.appendChild(d);
      }
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 5, '普通元素照旧命中');
      eq(KH.Scanner._lastScan.contentsPassThrough, 0,
        '原生判"可见"时必须走快路径、不读样式、不计放行 —— 计数不为 0 说明快路径被绕过了');
      eq(KH.Scanner._lastScan.prunedInvisible, 0, '没有隐藏元素时不许有剪枝计数');
    });
  });

  await test('★ R4-8 退化路径（拿不到 `getComputedStyle`）只认 `hidden` 属性；且装置还原干净', () => {
    const before = global.getComputedStyle;
    eq(typeof global.getComputedStyle, 'undefined', '进这一组时必须没有 `getComputedStyle`（前面的 withCss 必须还原干净）');
    eq(U.renderState((function () { const d = H.el('div'); d.setAttribute('hidden', ''); return d; })()), 2,
      '无计算样式：`hidden` 属性 ⇒ 2');
    eq(U.renderState(H.el('div')), 0, '无计算样式：普通元素 ⇒ 0（保守当可见）');
    eq(U.renderState(styled(H.el('div'), { display: 'contents' })), 0, '无计算样式：contents 也 ⇒ 0');
    eq(U.renderState(styled(H.el('div'), { display: 'none' })), 0,
      '无计算样式：**只剩属性可用** ⇒ 连 `display:none` 也判不出来（退化是有界的、保守的）');
    eq(U.renderState(null), 0, '非元素 ⇒ 0');

    const box = H.el('div');
    const hid = H.el('div'); hid.setAttribute('hidden', ''); hid.appendChild(H.txt('辰式词'));
    const c = styled(H.el('div'), { display: 'contents' }); c.appendChild(H.txt('辰式词'));
    box.appendChild(hid); box.appendChild(c);
    const texts = textsOf(U.textNodesIn(box));
    eq(texts.length, 1, '退化路径下：`hidden` 属性容器仍被剪、contents 照扫，实际：' + JSON.stringify(texts));

    eq(global.getComputedStyle, before, '本组跑完不得改动全局 `getComputedStyle`');
    eq(H.ShimElement.prototype.checkVisibility, undefined, '本组跑完 `checkVisibility` 必须是原样（未安装）状态');
  });

  await test('★ R4-9 变更相关性同源（D4）**双向**：contents ⇒ full；真正不可见 ⇒ 不因为放宽而 full', () => {
    withCss(() => {
      const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
      const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
      Object.defineProperty(KH, 'rules', { value: [{ pattern: /辰式词/g, labelPattern: null, flags: {}, meta: {} }], configurable: true });
      Object.defineProperty(KH, 'registry', { value: { all: () => [], size: 0 }, configurable: true });
      try {
        const contentsEl = fakeEl('DIV', '辰式词', { display: 'contents' });
        eq(contentsEl.checkVisibility({ checkVisibilityCSS: true }), false,
          '哨兵：假元素的 `checkVisibility` 必须真的判否（否则旧写法落到真值兜底 ⇒ 假绿）');
        const v1 = KH.Relevance.classify(
          [{ type: 'attributes', target: contentsEl, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
        eq(v1, 'full', '`display:contents` 是"可见"的 ⇒ 子树里可能出现关键词 ⇒ full，实际 ' + v1);

        const noneEl = fakeEl('DIV', '辰式词', { display: 'none' });
        const v2 = KH.Relevance.classify(
          [{ type: 'attributes', target: noneEl, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
        eq(v2, 'skip', '真正不可见的元素、且注册表里没有命中落在里面 ⇒ 不许判成 full（放宽是有边界的），实际 ' + v2);

        /* R4 复验新增第三臂：**只有原生 API 看得见的隐藏**（UA 伪元素类，如闭合 `<details>` 的 `::details-content`）。
         * 这条臂只有 `relevance` 走 `rendersSubtree` 才成立 —— 走 `renderState`（三样式法）会判 0 = "可见" ⇒ 'full'。
         * 实测：改回 `U.renderState(t) === 0` 时本臂变红（见契约「复验（返工后）」的证伪 #5）。 */
        const uaHidden = fakeEl('DIV', '辰式词', { _khNoBox: true });
        eq(uaHidden.checkVisibility({ checkVisibilityCSS: true }), false, '哨兵：这个假元素确实"不渲染"');
        const v3 = KH.Relevance.classify(
          [{ type: 'attributes', target: uaHidden, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
        eq(v3, 'skip', '页面上看不见的块发生变更 ⇒ 不值得重建（`rendersSubtree` 判否），实际 ' + v3);
      } finally {
        if (dRules) Object.defineProperty(KH, 'rules', dRules);
        if (dReg) Object.defineProperty(KH, 'registry', dReg);
      }
    });
  });

  await test('★ R4-10【K77 口径翻转】跨出"块级标签但行内显示"边界的拆词要命中；`display:block` 仍断开', () => {
    withCss(() => {
      /* 旧口径（K76，登记为 §二.5 的"已知边界"）：包装容器按**标签名**判行内 ⇒ `DIV` 一律当断行边界
       * ⇒ 跨出 `display:contents` 边界的拆词**凭空断开**。
       * K77 改按**计算后的 `display`** 判 ⇒ contents / inline 的 DIV 视觉上在同一行里 ⇒ 必须接上。 */
      const mk = (wrapStyle) => {
        const box = H.el('div');
        const c = wrapStyle ? styled(H.el('div'), wrapStyle) : H.el('div');
        const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
        c.appendChild(s1);
        box.appendChild(c);
        const s2 = H.el('span'); s2.appendChild(H.txt('式词'));
        box.appendChild(s2);
        return box;
      };
      eq(KH.Scanner.scan(mk({ display: 'contents' }), ruleFor(KH, '辰式词')).length, 1,
        '跨出 `display:contents` 边界的拆词**必须命中**（这正是 K77 ② 的修复目标；K76 曾登记为"仍断开"）');
      eq(KH.Scanner.scan(mk({ display: 'inline' }), ruleFor(KH, '辰式词')).length, 1,
        '`<div style="display:inline">` 同理：视觉上同一行 ⇒ 不许切断');
      eq(KH.Scanner.scan(mk(null), ruleFor(KH, '辰式词')).length, 0,
        '对照臂：`display:block` 的 DIV 是真的另起一块 ⇒ **仍必须断开**（K77 没把口径放宽成"什么都穿透"）');

      /* 行内标签上的 `display:contents`（K76 就已通）保持不动 */
      const box2 = H.el('div');
      const cs = styled(H.el('span'), { display: 'contents' });
      const s3 = H.el('span'); s3.appendChild(H.txt('辰'));
      cs.appendChild(s3);
      box2.appendChild(cs);
      const s4 = H.el('span'); s4.appendChild(H.txt('式词'));
      box2.appendChild(s4);
      eq(KH.Scanner.scan(box2, ruleFor(KH, '辰式词')).length, 1, '行内 `display:contents` 上的跨边界拆词照旧命中');
    });
  });

  await test('★ R4-11 文本的**直接父元素**就是嵌套的无盒容器时，行内标签拆词不许被切断（`isHiddenEl` 那条路）', () => {
    withCss(() => {
      const box = H.el('div');
      const outer = styled(H.el('div'), { display: 'contents' });
      const inner = styled(H.el('section'), { display: 'contents' });   // 文本的**直接父元素**（无盒）
      inner.appendChild(H.txt('辰'));
      const mid = H.el('span'); mid.appendChild(H.txt('式'));
      inner.appendChild(mid);
      inner.appendChild(H.txt('词'));
      outer.appendChild(inner);
      box.appendChild(outer);

      eq(textsOf(U.textNodesIn(box)).length, 3, '三段都要进扫描范围');
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 1,
        '无盒容器做直接父元素时，跨节点 run 不许把它当"隐藏"剔出去（旧 `isHiddenEl` 正是在这里切断词；' +
        '实际命中 ' + hits.length + '，命中文本 ' + JSON.stringify(hits.map((h) => h.text)) + '）');
    });
  });

  await test('★ R4-12 剪枝正确性的承重墙：`renderState` 只看**自身** ⇒ 隐藏祖先必须靠"祖先先被 REJECT"兜住', () => {
    withCss(() => {
      const box = H.el('div');
      const none = styled(H.el('div'), { display: 'none' });
      const child = H.el('div'); child.appendChild(H.txt('辰式词'));
      none.appendChild(child); box.appendChild(none);

      eq(U.renderState(child), 0,
        '`renderState` 是**自身**口径：祖先 `display:none` 时子元素自己的计算样式仍是 block ⇒ 0（真浏览器同样如此）');
      eq(textsOf(U.textNodesIn(box)).length, 0,
        '所以"隐藏子树不扫"完全依赖 TreeWalker **先访问祖先**、祖先被 REJECT ⇒ 整棵子树跳过。' +
        '⚠️ 反过来说：`renderState` 只看自身、也看不见 UA 伪元素隐藏（闭合 `<details>` 的 `::details-content`）——' +
        '所以**决策入口是 `rendersSubtree`**（原生 `checkVisibility` 快路径 + 只允许 **`display:contents`** 与' +
        '**K77 的折叠例外**推翻判否），不是 `renderState`。见 R4-13 与 K1/K2。');
    });
  });

  await test('★ R4-13【K77 收窄为"只放折叠类"】不是折叠的"只有原生 API 看得见的隐藏"仍不许扫', () => {
    withCss(() => {
      /* K76 曾把"`checkVisibility` 判否 + 三样式都可见"整个当回退收窄；K77 的口径是：
       * **只放语义明确的折叠**（闭合 `<details>` 正文 / `content-visibility` 跳过渲染的）。
       * ⇒ 一个**没有** details / cv 祖先的"无盒"元素**不属于折叠**，仍然不许扫
       *   （否则"隐藏菜单换个隐藏机制"就又漏回来了；这正是 K77 要守的边界）。
       * 真机对照：闭合 `<details>` 的元素包裹内容 ⇒ 命中（K1）；这个孤儿形状 ⇒ 不命中。 */
      const box = H.el('div');
      const noBox = styled(H.el('div'), { _khNoBox: true });
      noBox.appendChild(H.txt('辰式词'));
      box.appendChild(noBox);

      eq(noBox.checkVisibility({ checkVisibilityCSS: true }), false, '哨兵：原生确实判否（这个装置形状是"只有原生看得见"）');
      eq(U.renderState(noBox), 0, '哨兵：三样式法看不出这层隐藏 ⇒ 决策**不能**只靠 `renderState`');
      eq(U.collapsedInPlace(noBox), false, '它既不在闭合 `<details>` 里、也没有 `content-visibility` 祖先 ⇒ **不是折叠**');
      eq(U.rendersSubtree(noBox), false, '决策判据必须判"不渲染"（K77 没放宽成"判否就放行"）');
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 0, '看不见又不是折叠 ⇒ 不许命中');
      eq(KH.Scanner._lastScan.collapsedPassThrough, 0, '更不许计到 `collapsedPassThrough`');
    });
  });

  /* ==================================================================
   * K77 复验：折叠内容算数（用户 ①）+ 视觉连续不断词（用户 ②）
   * ------------------------------------------------------------------
   * 契约：`_stage/tasks/2026-09-22-K77-视觉连续与折叠内容.md`
   * ⚠️ 本节是 **R4 自己造的形状**，与 R3 的 `k77-visual-flow.test.js` 换角度、互不替代。
   * ================================================================== */

  await test('★ K1 折叠①：闭合 `<details>` 的**正文**要扫（元素包裹 / 裸文本 / 嵌套 / 外闭内开），summary 与 open 不许误伤', () => {
    withCss(() => {
      const wrapped = H.el('div'); wrapped.appendChild(H.txt('辰式词'));
      const d1 = detailsEl(false, '摘要甲', [wrapped]);
      const d2 = detailsEl(false, '摘要乙', []); d2.appendChild(H.txt('辰式词'));          // 裸文本（K76 靠"漏网"命中，现在是显式行为）
      const d3 = detailsEl(true, '辰式词', [H.el('div', null, ['正文丙'])]);                 // open + summary 里的词
      const inner = detailsEl(true, '内层开', [H.el('p', null, ['辰式词'])]);                 // 外层闭合 + 内层 open
      const d4 = detailsEl(false, '外层闭', [H.el('div', null, [inner])]);
      const deep = detailsEl(false, '摘要戊', [nest(H.el('span', null, ['辰式词']), 6)]);      // 6 层包装（正常深度）

      const box = H.el('div');
      [d1, d2, d3, d4, deep].forEach((d) => box.appendChild(d));

      eq(U.rendersSubtree(wrapped), true, '闭合 `<details>` 的正文 ⇒ 决策判据判"算"（折叠在原位）');
      eq(U.collapsedInPlace(wrapped), true, '`collapsedInPlace` 必须认出它');
      eq(U.rendersSubtree(d3.firstElementChild), true, '`<details open>` 的 summary 照常渲染 ⇒ 算');
      eq(U.rendersSubtree(d1.firstElementChild), true, '闭合 details 的 summary 自身**本来就渲染** ⇒ 算（不许因为父 details 闭合就把它当折叠）');

      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 5, '元素包裹 / 裸文本 / open+summary / 嵌套 / 6 层包装：5 段都要命中，实际 ' + hits.length +
        '，命中文本 = ' + JSON.stringify(hits.map((h) => h.text)));
      truthy(KH.Scanner._lastScan.collapsedPassThrough >= 3,
        '折叠放行要计入 `collapsedPassThrough`，实际 ' + KH.Scanner._lastScan.collapsedPassThrough);
    });
  });

  await test('★ K2 折叠负例：折叠里**再真隐藏**仍不扫；`display:none` 祖先包住 `<details>` 也不许被"折叠"救回来', () => {
    withCss(() => {
      const box = H.el('div');
      /* ① 闭合 details 里又 display:none */
      const noneIn = styled(H.el('div'), { display: 'none' });
      noneIn.appendChild(H.txt('辰式词'));
      box.appendChild(detailsEl(false, '摘要甲', [noneIn]));
      /* ② 闭合 details 里又 visibility:hidden */
      const visIn = styled(H.el('div'), { visibility: 'hidden' });
      visIn.appendChild(H.txt('辰式词'));
      box.appendChild(detailsEl(false, '摘要乙', [visIn]));
      /* ③ display:none 祖先**包住** details（先被祖先剪掉，折叠例外不许翻案） */
      const noneOuter = styled(H.el('div'), { display: 'none' });
      noneOuter.appendChild(detailsEl(false, '摘要丙', [H.el('p', null, ['辰式词'])]));
      box.appendChild(noneOuter);
      /* ④ visibility:hidden 祖先包住 details */
      const visOuter = styled(H.el('div'), { visibility: 'hidden' });
      visOuter.appendChild(detailsEl(false, '摘要丁', [H.el('p', null, ['辰式词'])]));
      box.appendChild(visOuter);
      /* 对照臂 */
      box.appendChild(detailsEl(false, '摘要戊', [H.el('p', null, ['辰式词'])]));

      eq(U.rendersSubtree(noneIn), false, '折叠里又 `display:none` ⇒ 先判"被显式隐藏" ⇒ 不放行（判序不能反）');
      eq(U.collapsedInPlace(noneIn), false, '`collapsedInPlace` 也必须先看到 display:none');
      eq(U.collapsedInPlace(noneOuter), false, '`display:none` 祖先 ⇒ 折叠例外不许翻案');
      /* ⚠️ 收集到的文本里**本来就该有** `<summary>` 的文字（summary 是渲染中的）—— 只数关键词那几段 */
      const kwTexts = textsOf(U.textNodesIn(box)).filter((t) => t === '辰式词');
      eq(kwTexts.length, 1, '四个真隐藏段一个都不许进扫描范围，只有对照臂那段，实际 ' + JSON.stringify(kwTexts));
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1, '两种真隐藏（自身 / 祖先）都不许命中');
    });
  });

  await test('★ K3 视觉连续②：行内级 `display` 的包装要穿透、脱离行内流的要断开（`float` / `absolute` / `table`）', () => {
    withCss(() => {
      const split = (wrapStyle) => {
        const box = H.el('div');
        const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
        const w = H.el('div'); if (wrapStyle) styled(w, wrapStyle); w.appendChild(H.txt('式'));
        const s2 = H.el('span'); s2.appendChild(H.txt('词'));
        box.appendChild(s1); box.appendChild(w); box.appendChild(s2);
        return box;
      };
      const one = (style, label) => eq(KH.Scanner.scan(split(style), ruleFor(KH, '辰式词')).length, 1, label);
      const zero = (style, label) => eq(KH.Scanner.scan(split(style), ruleFor(KH, '辰式词')).length, 0, label);

      one({ display: 'inline' }, '`display:inline` ⇒ 同一行 ⇒ 必须接上');
      one({ display: 'inline-block' }, '`display:inline-block` ⇒ 行内级 ⇒ 接上');
      one({ display: 'inline-flex' }, '`display:inline-flex` ⇒ 行内级 ⇒ 接上');
      one({ display: 'inline-table' }, '`display:inline-table` ⇒ 行内级 ⇒ 接上');
      one({ display: 'contents' }, '`display:contents` ⇒ 无盒、行内流 ⇒ 接上');
      one({ display: 'inline', position: 'relative' }, '`position:relative` 仍在行内流里 ⇒ 接上');
      zero({ display: 'block' }, '`display:block` ⇒ 另起一块 ⇒ 断开');
      zero({ display: 'table' }, '`display:table` ⇒ 块级容器 ⇒ 断开');
      zero(null, '对照臂：DIV 默认（block）⇒ 断开');
      zero({ display: 'inline', float: 'left' }, '`float:left` 脱离行内流 ⇒ 断开');
      zero({ display: 'inline', position: 'absolute' }, '`position:absolute` 脱离行内流 ⇒ 断开');

      /* 反向：`<span style="display:block">` 是真的另起一块 —— **标签名是行内也不许穿透** */
      const box = H.el('div');
      const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
      const w = styled(H.el('span'), { display: 'block' }); w.appendChild(H.txt('式'));
      const s2 = H.el('span'); s2.appendChild(H.txt('词'));
      box.appendChild(s1); box.appendChild(w); box.appendChild(s2);
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 0,
        '`<span style="display:block">` ⇒ 判据看的是**计算后的 display**，标签名不再说话');
    });
  });

  await test('★ K4 记忆化：轮内命中缓存（第二次 `buildInlineRuns` 零样式读）；跨轮必须换新（同一元素 block↔inline）', () => {
    withCss(() => {
      const box = H.el('div');
      for (let i = 0; i < 6; i++) {
        const w = styled(H.el('div'), { display: 'inline' });
        w.appendChild(H.txt('字' + i));
        box.appendChild(w);
      }
      const nodes = U.textNodesIn(box);          // 入口：缓存整体换新
      csReset(); U.buildInlineRuns(nodes); const first = csCount();
      csReset(); U.buildInlineRuns(nodes); const second = csCount();
      truthy(first > 0, '第一次必须真的读样式（否则"命中缓存"无从谈起），实际 ' + first);
      eq(second, 0, '第二次必须**全部命中缓存** ⇒ 热路径不再读样式，实际 ' + second);

      /* 跨轮陈旧：同一个元素先 inline（接上）→ block（断开）→ inline（再接上） */
      const wrap = H.el('div'); wrap.appendChild(H.txt('辰'));
      const s2 = H.el('span'); s2.appendChild(H.txt('式词'));
      const box2 = H.el('div'); box2.appendChild(wrap); box2.appendChild(s2);
      styled(wrap, { display: 'inline' });
      eq(KH.Scanner.scan(box2, ruleFor(KH, '辰式词')).length, 1, 'wrapper 行内 ⇒ 跨节点 run 接上');
      styled(wrap, { display: 'block' });
      csReset(); const h2 = KH.Scanner.scan(box2, ruleFor(KH, '辰式词')).length;
      truthy(csCount() > 0, '第二轮必须**重新读**这个元素的样式（缓存换新），实际读 ' + csCount() + ' 次');
      eq(h2, 0, 'wrapper 改块级 ⇒ 第二轮必须断开（绿了就说明缓存跨轮陈旧）');
      styled(wrap, { display: 'inline' });
      eq(KH.Scanner.scan(box2, ruleFor(KH, '辰式词')).length, 1, '再改回行内 ⇒ 又要接上（双向都得跟）');
    });
  });

  await test('★ K5 性能哨兵：无折叠 / 无 contents 的普通树上，K77 新增的折叠判据**零额外样式读**', () => {
    withCss(() => {
      /* 单个文本节点（run 归并不会去问载体）⇒ 整轮扫描一次 `getComputedStyle` 都不该读：
       * 剪枝走 `checkVisibility` 快路径，K77 的 `collapsedInPlace` 只在判否时才被调用。 */
      const box = H.el('div');
      const d = H.el('div');
      const s = H.el('span'); s.appendChild(H.txt('辰式词'));
      d.appendChild(s); box.appendChild(d);
      csReset();
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      eq(hits.length, 1, '普通树照旧命中');
      eq(csCount(), 0, '可见元素的判据路径**一次样式都不许读**（K77 新增的折叠检查不许上热路径），实际 ' + csCount());
      eq(KH.Scanner._lastScan.collapsedPassThrough, 0, '没有折叠 ⇒ 计数为 0');
      eq(KH.Scanner._lastScan.contentsPassThrough, 0, '没有 contents ⇒ 计数为 0');
    });
  });

  await test('★ K6 折叠的**祖先深度**：≤7 步命中（绿）；≥8 步漏扫（红-1，见契约 R4 复验小结）', () => {
    withCss(() => {
      const build = (levels) => {
        const box = H.el('div');
        box.appendChild(detailsEl(false, '摘要', [nest(H.el('span', null, ['辰式词']), levels)]));
        return box;
      };
      /* 真机独立复现（Edge · R4 自造装置）：span 到 details 之间 6 层 ⇒ 1；7/8/9 层 ⇒ 0
       * ⇒ `collapsedInPlace` 的 `depth < 8` 祖先上限导致的**漏扫**（口径没写深度限定）。 */
      eq(KH.Scanner.scan(build(6), ruleFor(KH, '辰式词')).length, 1,
        '6 层包装（到 details 7 步）⇒ 正常命中');
      /* K77 红-1 **已修**（`collapsedInPlace` 祖先上限 8 → 128）。R4 原先在这里留了一条 `skip`，
       * 并注明"修好后（去掉/提高祖先上限）请把下面这条 skip 删掉，并在 build(8) 上断言 === 1" ——
       * 下面两行即按该授权改写。 */
      eq(KH.Scanner.scan(build(8), ruleFor(KH, '辰式词')).length, 1,
        '8 层包装（到 details 9 步）⇒ 必须命中（原先被 `depth < 8` 漏扫，R4 真机实测 p8 = 0）');
      eq(KH.Scanner.scan(build(12), ruleFor(KH, '辰式词')).length, 1,
        '12 层包装 ⇒ 仍必须命中（新上限 128 的安全边际）');
    });
  });

  /* ==================================================================
   * K7/K8：跨节点「字面前缀预筛」的语义中性（K77 发版前补的性能对冲）
   * ------------------------------------------------------------------
   * `matchInlineRuns` 新增：`literalOf(pattern.source)` 取不到前缀就跳过整个 run。
   * K7 是它的**正面守卫**（能命中的形状不许被预筛挡掉）；K8 登记 R4 证伪出的**漏命中**。
   * ================================================================== */

  /** 把若干段文本拆成同一 run 里的多个节点（`<span>` 包住 ⇒ 视觉行内、可穿透） */
  function runHit(parts, kw, opts) {
    const box = H.el('div');
    for (const t of parts) { const s = H.el('span'); s.appendChild(H.txt(t)); box.appendChild(s); }
    return KH.Scanner.scan(box, KH.Compiler.compileAll({
      groups: [], keywords: [Object.assign({ id: 'k1', text: kw, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false }, opts || {})]
    })).length;
  }

  await test('★ K7 跨节点预筛的正面守卫：顶层分支 / 转义字面量 / ASCII 不区分大小写 / lookbehind·lookahead / 字面量被拆开 —— 都不许被挡', () => {
    const U2 = U;
    eq(U2.literalOf('安.*车主|好.*车主'), '', '有顶层分支 ⇒ 必须返回空串（放弃预筛，否则第二分支全被挡）');
    eq(U2.literalOf('\\.5'), '.5', '转义的字面量（`\\.`）⇒ 必须还原成 `.`');
    eq(U2.literalOf('(?<=x)yz'), '', '以 `(` 开头 ⇒ 取不到前缀 ⇒ 空串');

    eq(runHit(['好', '车主'], '安.*车主|好.*车主', { useRegex: true }), 1, '**第二分支**的命中必须保住（a|b 的经典坑）');
    eq(runHit(['安', '全车主'], '安.*车主|好.*车主', { useRegex: true }), 1, '第一分支照旧');
    eq(runHit(['.', '5'], '\\.5', { useRegex: true }), 1, '转义前缀（`\\.5`）必须命中');
    eq(runHit(['a c', 'at'], '\\bcat', { useRegex: true }) >= 0, true, '（`\\b` 见 K8 登记）');
    eq(runHit(['ax', 'y', 'z'], '(?<=x)yz', { useRegex: true }), 1, 'lookbehind 开头 ⇒ 预筛不启用 ⇒ 命中');
    eq(runHit(['a', 'bc'], 'ab(?=c)', { useRegex: true }), 1, 'lookahead 结尾 ⇒ 命中');
    eq(runHit(['A', 'BC'], 'abc'), 1, 'ASCII 不区分大小写 ⇒ 命中（预筛要按大小写不敏感比较）');
    /* 字面量本身被拆到两个节点上：预筛看的是**整段 run 文本**，所以仍要找得到 */
    eq(runHit(['ab', 'cd'], 'abcd'), 1, '字面量跨节点拼接后仍要命中');
  });

  await test('★ K8 预筛的漏命中**已修**（R4 证伪）：`\\d` / `\\b` 这类转义不再被当成字面字母', () => {
    const U2 = U;
    /* R0 按 R4 的证伪结论改的：`literalOf` 只把"被转义的**字面字符**"当字面量；
     * 转义后面是**字母/数字**的（`\d \D \w \W \s \S \b \B \p \P \x \u \c \k \1..\9 \n \t \0`…）
     * 一律**放弃预筛**（`return ''`）。保守方向是对的：放弃预筛只是少省一点，**漏杀才是事故**。 */
    eq(U2.literalOf('\\d+'), '', '`\\d+` ⇒ 取不到字面前缀 ⇒ 空串（= 本函数文档一直承诺的行为）');
    eq(U2.literalOf('\\bcat'), '', '`\\bcat` ⇒ 空串（`\\b` 是词界断言，不是字母 b）');
    eq(U2.literalOf('\\w+'), '', '`\\w+` ⇒ 空串');
    eq(U2.literalOf('\\x41'), '', '`\\x41` ⇒ 空串（十六进制转义）');
    eq(U2.literalOf('\\u00e9'), '', '`\\u00e9` ⇒ 空串（Unicode 转义）');
    eq(U2.literalOf('a\\nb'), '', '`a\\nb` 里的 `\\n` 不是字母 n ⇒ 空串');
    eq(U2.literalOf('\\.5'), '.5', '转义的字面字符照旧能取到前缀（`\\.` ⇒ `.`）');
    eq(U2.literalOf('\\\\'), '\\', '`\\\\`（匹配一个反斜杠）照旧能取到前缀');

    /* 用户可见后果：正则关键词 `\d+` 在**单节点**与**跨节点**两条路上都必须命中 */
    const box = H.el('div'); const p = H.el('p'); p.appendChild(H.txt('订单号 12345')); box.appendChild(p);
    const r = KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: '\\d+', enabled: true, caseSensitive: false, wholeWord: false, useRegex: true }] });
    eq(r[0].pattern.source, '\\d+', '编译器是**原样透传**用户正则 ⇒ 预筛直接作用在用户源码上');
    eq(KH.Scanner.scan(box, r).length, 1, '单节点：`\\d+` 在"订单号 12345"上必须命中（修前 0）');
    truthy(runHit(['第', '12', '3号'], '\\d+', { useRegex: true }) >= 1,
      '跨节点：必须重新命中（K77 把预筛补到这条路时曾把这条也挡掉 —— 修前 0）；' +
      '⚠️ 这个 helper 会把**单节点那两段**（"12"/"3"）也算进来，所以这里是 ≥1 而不是 ===1');
  });

  /* ==================================================================
   * K78 复验（R4 独立）：② carrier 祖先上限 / ④ 属性变化取样范围 / ① 作者自折叠（启发式）
   * ------------------------------------------------------------------
   * 契约：`_stage/tasks/2026-09-23-K78-三项收口.md`
   * ① 是**启发式**，所以本节的重点是**误收**（隐藏菜单/抽屉/浮层被当"折叠内容"放回来）。
   * ================================================================== */

  /** 垫片的 `querySelector` 不支持属性选择器（`[role="button"]` / `[aria-expanded]`），
   *  而 ① 的"控件常包在容器里，往里看一眼"用的正是 `'button, a, summary, [role="button"], [aria-expanded]'`
   *  ⇒ 复验时补一个只认这些 token 的实现（**装置补齐，不是口径**；真机本来就是全功能选择器）。 */
  function withAttrSelector(fn) {
    const prev = H.ShimElement.prototype.querySelector;
    H.ShimElement.prototype.querySelector = function (sel) {
      const got = prev.call(this, sel);
      if (got) return got;
      const s = String(sel);
      if (s.indexOf('[') < 0) return null;
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      const attrs = parts.filter((p) => p.charAt(0) === '[').map((p) => {
        const m = /^\[([A-Za-z-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
        return m ? { name: m[1], val: m[2] } : null;
      }).filter(Boolean);
      const tags = parts.filter((p) => p.charAt(0) !== '[').map((p) => p.toUpperCase());
      let found = null;
      const walk = (n) => {
        if (found) return;
        for (const c of n.childNodes || []) {
          if (c.nodeType !== 1) continue;
          if (tags.indexOf(c.tagName) >= 0 ||
            attrs.some((a) => c.hasAttribute(a.name) && (a.val === undefined || String(c.getAttribute(a.name)) === a.val))) { found = c; return; }
          walk(c);
          if (found) return;
        }
      };
      walk(this);
      return found;
    };
    try { return fn(); } finally { H.ShimElement.prototype.querySelector = prev; }
  }

  /** K78 装置：`withCss` + 属性选择器 + `window.innerWidth/Height`（① 的浮层判定要用） */
  function withCss78(fn) {
    return withCss(() => withAttrSelector(() => {
      const w = global.innerWidth, h = global.innerHeight;
      global.innerWidth = 1000; global.innerHeight = 800;
      try { return fn(); } finally {
        if (w === undefined) delete global.innerWidth; else global.innerWidth = w;
        if (h === undefined) delete global.innerHeight; else global.innerHeight = h;
      }
    }));
  }

  /** ① 的开关来自 `window.KH.state.config`（内容脚本运行期配置）。
   *  ⚠️ `KH.state` 在垫片里是**只读 getter**（`Cannot set property state` —— R4 第一版就踩了它，
   *  赋值被 try 吞掉 ⇒ 开关永远不生效 ⇒ 假红）⇒ 必须用 `defineProperty` 替换（描述符可配置，跑完还原）。 */
  function withCfg(cfg, fn) {
    const d = Object.getOwnPropertyDescriptor(KH, 'state');
    const prev = KH.state;
    let ok = true;
    try {
      Object.defineProperty(KH, 'state', {
        value: Object.assign({}, prev || {}, { config: cfg }), configurable: true, enumerable: true, writable: true
      });
    } catch (e) { ok = false; }
    try { return fn(); } finally {
      if (ok) {
        try { if (d) Object.defineProperty(KH, 'state', d); else delete KH.state; } catch (e) { /* ignore */ }
      }
    }
  }

  /** `renderState`/`checkVisibility` 都当"可见"的 wrapper（浮动被刻意放在 static 之外时用） */
  function menuBtn(text, attrs) {
    const b = H.el('button');
    b.appendChild(H.txt(text));
    Object.keys(attrs || {}).forEach((k) => b.setAttribute(k, attrs[k]));
    return b;
  }

  await test('★ R4-K78-1（②）**中段**被 9 / 12 层行内包装时拆词必须接上，且样式读不随层数放大', () => {
    withCss78(() => {
      /* ⚠️ 形状必须让"中段被深包"—— 只有这样才会走到 `carrier()` 的 8 层上限：
       *   `辰` + `<span*9>式</span*9>` + `词`：中段那个文本节点要**爬到最外层**才看得到兄弟 `辰`。
       * R4 第一版把**首段**包深（`<span*9>辰</span*9>` + `式词`），结果被 `chains()` 的
       * "carrier 元素 contains 最后节点" 这条捷径救回来了 —— 上限改回 8 也照样绿（**假绿**）。
       * 谢谢 R3 的 A1 用了正确形状，让 R4 发现自己的用例不承重。 */
      const build = (levels) => {
        const box = H.el('div');
        const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
        const s3 = H.el('span'); s3.appendChild(H.txt('词'));
        let inner = H.el('span'); inner.appendChild(H.txt('式'));
        for (let i = 0; i < levels; i++) { const w = H.el('span'); w.appendChild(inner); inner = w; }
        box.appendChild(s1); box.appendChild(inner); box.appendChild(s3);
        return box;
      };
      eq(KH.Scanner.scan(build(7), ruleFor(KH, '辰式词')).length, 1, '7 层（旧上限的临界内）⇒ 命中');
      eq(KH.Scanner.scan(build(9), ruleFor(KH, '辰式词')).length, 1, '9 层中段包装 ⇒ 必须命中（旧上限 8 ⇒ 0）');
      eq(KH.Scanner.scan(build(12), ruleFor(KH, '辰式词')).length, 1, '12 层 ⇒ 仍必须命中');
      /* ② 不该把成本带成"每层祖先都读样式"：`isVisualInline` 有 WeakMap 记忆化 ⇒ 与元素数同阶 */
      const box = build(12); const nodes = U.textNodesIn(box);
      csReset(); U.buildInlineRuns(nodes);
      truthy(csCount() <= 40, '12 层包装下的样式读次数应与元素数同阶（记忆化），实际 ' + csCount());
    });
  });

  await test('★ R4-K78-2（④）属性变化取样 = "所在上下文"：邻居里的词也要重建；无关形状仍不许变"什么都重建"', () => {
    withCss78(() => {
      const rules = KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: '辰式词', enabled: true, caseSensitive: false, wholeWord: false, useRegex: false }] });
      const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
      const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
      Object.defineProperty(KH, 'rules', { value: rules, configurable: true });
      Object.defineProperty(KH, 'registry', { value: { all: () => [], size: 0 }, configurable: true });
      const classify = (el) => KH.Relevance.classify(
        [{ type: 'attributes', target: el, addedNodes: [], removedNodes: [], attributeName: 'class' }], {});
      try {
        /* a) K77 黄-4 的现场：改 wrapper 的 class，词的另一半在**行内兄弟**里 ⇒ 必须 full */
        const a = H.el('div'); const a1 = H.el('div'); a1.appendChild(H.txt('辰'));
        const a2 = H.el('span'); a2.appendChild(H.txt('式词'));
        a.appendChild(a1); a.appendChild(a2);
        eq(classify(a1), 'full', '改 `辰` 那个 wrapper 的 class ⇒ 取样含行内兄弟 ⇒ full（黄-4 的修法）');

        /* b) 负例（A3 的换角度）：行内兄弟与词无关 ⇒ 仍 skip（不许"什么都重建"） */
        const b = H.el('div'); const b1 = H.el('div'); b1.appendChild(H.txt('无关甲'));
        const b2 = H.el('span'); b2.appendChild(H.txt('无关乙'));
        b.appendChild(b1); b.appendChild(b2);
        eq(classify(b1), 'skip', '自身的行内上下文与关键词无关 ⇒ 仍 skip');

        /* c) 负例：**块级**兄弟不算同一上下文 —— 词在隔壁 `<p>` 里也不许重建（否则等于整页预筛失效） */
        const c = H.el('div'); const c1 = H.el('div'); c1.appendChild(H.txt('无关丙'));
        const cp = H.el('p'); cp.appendChild(H.txt('辰式词'));
        c.appendChild(c1); c.appendChild(cp);
        eq(classify(c1), 'skip', '块级兄弟不进上下文 ⇒ skip（`ctxOf` 只拼行内兄弟，注释里点过这个坑）');

        /* d) 表格：格子里的词算上下文（与 childList 分支同口径） */
        const tbl = H.el('table'); const tr = H.el('tr'); const td = H.el('td');
        const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
        const s2b = H.el('span'); s2b.appendChild(H.txt('式词'));
        td.appendChild(s1); td.appendChild(s2b); tr.appendChild(td); tbl.appendChild(tr);
        eq(classify(s1), 'full', '改格子内 span 的 class ⇒ 取整格文本 ⇒ full');
      } finally {
        if (dRules) Object.defineProperty(KH, 'rules', dRules);
        if (dReg) Object.defineProperty(KH, 'registry', dReg);
      }
    });
  });

  await test('★ R4-K78-3（① 正例）`display:none` + 紧邻「展开」按钮 + 可见前文 ⇒ 放行、计数、进扫描范围', () => {
    withCss78(() => {
      const wrap = H.el('div');
      const p1 = H.el('p'); p1.appendChild(H.txt('前文内容'));
      const btn = H.el('button'); btn.appendChild(H.txt('展开'));
      const hidden = styled(H.el('div'), { display: 'none' });
      hidden.appendChild(H.txt('辰式词'));
      wrap.appendChild(p1); wrap.appendChild(btn); wrap.appendChild(hidden);
      const box = H.el('div'); box.appendChild(wrap);

      eq(U.customCollapseExpandable(hidden), true, '① 的六条全中 ⇒ 放行');
      eq(U.rendersSubtree(hidden), true, '决策入口也要放行');
      truthy(textsOf(U.textNodesIn(box)).indexOf('辰式词') >= 0, '折叠块里的文本要进扫描范围');
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1, '要命中 1 处');
      truthy(KH.Scanner._lastScan.customCollapsePassThrough >= 1,
        '要计入 `customCollapsePassThrough`，实际 ' + KH.Scanner._lastScan.customCollapsePassThrough);
    });
  });

  await test('★ R4-K78-4a（① 负例·干净形状）无控件 / `visibility:hidden` / `content-visibility:hidden` / 大浮层 ⇒ 一律不放行', () => {
    withCss78(() => {
      /* a) 无任何展开控件（A5 形状）：前面有可见文本也不行 */
      const w1 = H.el('div');
      const t1 = H.el('div'); t1.appendChild(H.txt('普通前文'));
      const h1 = styled(H.el('div'), { display: 'none' }); h1.appendChild(H.txt('辰式词'));
      w1.appendChild(t1); w1.appendChild(h1);
      eq(U.customCollapseExpandable(h1), false, '没有展开控件 ⇒ 不放行（③ 满足也不行）');

      /* b) `visibility:hidden`（⑥） */
      const w2 = H.el('div');
      w2.appendChild(menuBtn('展开', {}));
      const h2 = styled(H.el('div'), { display: 'none', visibility: 'hidden' }); h2.appendChild(H.txt('辰式词'));
      w2.appendChild(h2);
      eq(U.customCollapseExpandable(h2), false, '`visibility:hidden` ⇒ 不放行');

      /* c) `content-visibility:hidden`（不归 ① 管） */
      const w3 = H.el('div');
      w3.appendChild(menuBtn('展开', {}));
      const h3 = styled(H.el('div'), { display: 'none', contentVisibility: 'hidden' }); h3.appendChild(H.txt('辰式词'));
      w3.appendChild(h3);
      eq(U.customCollapseExpandable(h3), false, '`content-visibility:hidden` ⇒ 不放行');

      /* d) 大浮层祖先（⑤：fixed/absolute 且覆盖 ≥60% 视口） */
      const overlay = styled(H.el('div'), { position: 'fixed' });
      overlay._rect = { top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700 };
      const w4 = H.el('div');
      w4.appendChild(menuBtn('展开', {}));
      const h4 = styled(H.el('div'), { display: 'none' }); h4.appendChild(H.txt('辰式词'));
      w4.appendChild(h4); overlay.appendChild(w4);
      eq(U.customCollapseExpandable(h4), false, '浮层（≥60% 视口）里的隐藏块 ⇒ 不放行');
    });
  });

  await test('★ R4-K78-5（① 开关）`scanCollapsedCustom=false` ⇒ ① 不放行；但 **不影响** K76/K77 的两类折叠', () => {
    withCss78(() => withCfg({ scanCollapsedCustom: false }, () => {
      const wrap = H.el('div');
      wrap.appendChild(menuBtn('展开', {}));
      const hidden = styled(H.el('div'), { display: 'none' }); hidden.appendChild(H.txt('辰式词'));
      wrap.appendChild(hidden);
      const cv = styled(H.el('div'), { contentVisibility: 'hidden' }); cv.appendChild(H.txt('辰式词'));
      const det = detailsEl(false, '摘要', [H.el('p', null, ['辰式词'])]);
      const box = H.el('div'); box.appendChild(wrap); box.appendChild(cv); box.appendChild(det);

      eq(U.customCollapseExpandable(hidden), false, '开关关 ⇒ ① 不放行');
      eq(U.rendersSubtree(cv), true, '`content-visibility:hidden`（K77 折叠）**不受开关影响**');
      eq(U.rendersSubtree(det.lastElementChild), true, '闭合 `<details>` 的正文也不受开关影响（注意用 `lastElementChild`：垫片没有 `firstChild`）');
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 2, '开关关掉后：折叠的 2 段仍命中，① 那段不命中');
      eq(KH.Scanner._lastScan.customCollapsePassThrough, 0, '开关关 ⇒ 计数为 0');
    }));
  });

  await test('★ R4-K78-6（① 边界·允许漏收）控件太远 / 文案不在词表 ⇒ 不放行（口径"宁可漏判"，但要登记清楚）', () => {
    withCss78(() => {
      /* 控件在 4 个兄弟之外 */
      const w1 = H.el('div');
      w1.appendChild(menuBtn('展开', {}));
      for (let i = 0; i < 3; i++) { const d = H.el('div'); d.appendChild(H.txt('间隔' + i)); w1.appendChild(d); }
      const h1 = styled(H.el('div'), { display: 'none' }); h1.appendChild(H.txt('辰式词'));
      w1.appendChild(h1);
      eq(U.customCollapseExpandable(h1), false, '控件超出 3 个兄弟 ⇒ 漏收（登记边界，可接受）');

      /* 文案不在展开词表：真实站点常见的「点击查看」/「+」 */
      const w2 = H.el('div');
      w2.appendChild(menuBtn('点击查看', {}));
      const h2 = styled(H.el('div'), { display: 'none' }); h2.appendChild(H.txt('辰式词'));
      w2.appendChild(h2);
      eq(U.customCollapseExpandable(h2), false, '「点击查看」不在词表 ⇒ 漏收（登记边界）');

      const w3 = H.el('div');
      w3.appendChild(menuBtn('+', {}));
      const h3 = styled(H.el('div'), { display: 'none' }); h3.appendChild(H.txt('辰式词'));
      w3.appendChild(h3);
      eq(U.customCollapseExpandable(h3), false, '「+」不在词表 ⇒ 漏收（登记边界）');
    });
  });

  await test('★ R4-K78-7（① 计数与快路径）普通可见树上 `customCollapsePassThrough` 必须为 0', () => {
    withCss78(() => {
      const box = H.el('div');
      const d = H.el('div'); const s = H.el('span'); s.appendChild(H.txt('辰式词'));
      d.appendChild(s); box.appendChild(d);
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1, '普通树照旧命中');
      eq(KH.Scanner._lastScan.customCollapsePassThrough, 0, '没有 ① 放行 ⇒ 计数 0');
      eq(KH.Scanner._lastScan.collapsedPassThrough, 0, '没有 K77 折叠 ⇒ 计数 0');
    });
  });

  await test('★ R4-K78-8a（① 收紧后的四个硬信号）弹层触发器 / 裸 `<a>` 文案 / 弹层 role / 定位块 ⇒ 一律不放行', () => {
    withCss78(() => {
      /* 1) `aria-haspopup` + `role=menu`：ARIA 下拉菜单（R4 证伪 → R0 已收紧） */
      const w1 = H.el('div');
      w1.appendChild(menuBtn('操作', { 'aria-expanded': 'false', 'aria-controls': 'm1', 'aria-haspopup': 'menu' }));
      const menu = styled(H.el('ul'), { display: 'none' });
      menu.setAttribute('id', 'm1'); menu.setAttribute('role', 'menu');
      const li = H.el('li'); li.appendChild(H.txt('辰式词')); menu.appendChild(li);
      w1.appendChild(menu);
      const box1 = H.el('div'); box1.appendChild(w1);
      eq(U.customCollapseExpandable(menu), false, '触发器带 `aria-haspopup` + 弹层 `role=menu` ⇒ 不放行');
      eq(textsOf(U.textNodesIn(box1)).indexOf('辰式词') >= 0, false, '菜单（含 `<li>` 子树）里的词不进扫描范围');

      /* 2) 裸 `<a>` 的文案不再算展开控件 */
      const w2 = H.el('div');
      const more = H.el('a'); more.appendChild(H.txt('更多'));
      const navMenu = styled(H.el('ul'), { display: 'none' });
      const li2 = H.el('li'); li2.appendChild(H.txt('辰式词')); navMenu.appendChild(li2);
      w2.appendChild(more); w2.appendChild(navMenu);
      const box2 = H.el('div'); box2.appendChild(w2);
      eq(U.customCollapseExpandable(navMenu), false, '`<a>更多</a>` 不算展开控件（链接是导航）⇒ 不放行');
      eq(textsOf(U.textNodesIn(box2)).indexOf('辰式词') >= 0, false, '导航下拉里的词不进扫描范围');

      /* 3) 隐藏块自己是 `position:absolute|fixed` ⇒ 弹层，不是折叠长内容 */
      const w3 = H.el('div');
      w3.appendChild(menuBtn('展开', {}));
      const abs = styled(H.el('div'), { display: 'none', position: 'absolute' });
      abs.appendChild(H.txt('辰式词'));
      w3.appendChild(abs);
      const box3 = H.el('div'); box3.appendChild(w3);
      eq(U.customCollapseExpandable(abs), false, '隐藏块自己定位 ⇒ 不放行');
      eq(textsOf(U.textNodesIn(box3)).indexOf('辰式词') >= 0, false, '定位弹层里的词不进扫描范围');

      /* 4) 隐藏块带弹层 `role`（`tabpanel` 是最常见的一条） */
      const w4 = H.el('div');
      const tabs = H.el('div'); tabs.setAttribute('role', 'tablist');
      tabs.appendChild(menuBtn('甲', { role: 'tab', 'aria-controls': 'p1', 'aria-expanded': 'false' }));
      w4.appendChild(tabs);
      const panel = styled(H.el('div'), { display: 'none' });
      panel.setAttribute('id', 'p1'); panel.setAttribute('role', 'tabpanel');
      panel.appendChild(H.txt('辰式词'));
      w4.appendChild(panel);
      const box4 = H.el('div'); box4.appendChild(w4);
      eq(U.customCollapseExpandable(panel), false, '隐藏块 `role=tabpanel` ⇒ 不放行');
      eq(textsOf(U.textNodesIn(box4)).indexOf('辰式词') >= 0, false, '非激活 tab 面板（带 role）里的词不进扫描范围');

      /* 5) 收紧不能把**正例**打掉：`<button>展开</button>` + 隐藏 div 仍要放行 */
      const w5 = H.el('div');
      w5.appendChild(menuBtn('展开', {}));
      const okHidden = styled(H.el('div'), { display: 'none' });
      okHidden.appendChild(H.txt('辰式词'));
      w5.appendChild(okHidden);
      const box5 = H.el('div'); box5.appendChild(w5);
      eq(U.customCollapseExpandable(okHidden), true, '正例（A4）不受收紧影响');
      truthy(textsOf(U.textNodesIn(box5)).indexOf('辰式词') >= 0, '正例的词仍要进扫描范围');
    });
  });

  await test('★ R4-K78-8b【R0 已按 R4 的建议收窄】缺 `aria-haspopup`/`role` 的下拉与无 role 的 tab 面板 ⇒ **不再被扫**', () => {
    withCss78(() => {
      /* R4 实测（收紧前）：硬信号只能挡"声明了自己是弹层"的那一类，以下两形状与"作者折叠的长内容"（A4 正例）
       * 在 DOM 上同形 ⇒ 会被放行。R0 按 R4 给的两条候选收紧做掉了：
       *   · **隐藏块是 `UL/OL/NAV/MENU` ⇒ 不算折叠长内容**（列表/导航 = 菜单，不是"长文本"）；
       *   · **触发器带 `role=tab` / `aria-selected` ⇒ 当弹层控件**（标签页管的是另一层 UI）。
       * 下面四条即按新行为断言（R4 原话："修好后：上面四条断言应改成 false/不含"）。 */
      const w1 = H.el('div');
      w1.appendChild(menuBtn('更多', { 'aria-expanded': 'false' }));
      const ul = styled(H.el('ul'), { display: 'none' });
      const li = H.el('li'); li.appendChild(H.txt('辰式词')); ul.appendChild(li);
      w1.appendChild(ul);
      const box1 = H.el('div'); box1.appendChild(w1);
      eq(U.customCollapseExpandable(ul), false, '只给 `aria-expanded=false` 的**下拉列表**（`ul`）⇒ 不放行');
      truthy(textsOf(U.textNodesIn(box1)).indexOf('辰式词') < 0, '该菜单项**不许**进扫描范围');

      const w2 = H.el('div');
      const tabs = H.el('div'); tabs.setAttribute('role', 'tablist');
      tabs.appendChild(menuBtn('甲', { role: 'tab', 'aria-controls': 'p2', 'aria-expanded': 'false' }));
      w2.appendChild(tabs);
      const panel = styled(H.el('div'), { display: 'none' });
      panel.setAttribute('id', 'p2'); panel.appendChild(H.txt('辰式词'));
      w2.appendChild(panel);
      const box2 = H.el('div'); box2.appendChild(w2);
      eq(U.customCollapseExpandable(panel), false, '**标签页触发器**（`role=tab`）⇒ 不当展开控件 ⇒ 隐藏面板不放行');
      truthy(textsOf(U.textNodesIn(box2)).indexOf('辰式词') < 0, '该面板里的词**不许**进扫描范围');
    });
  });
};
