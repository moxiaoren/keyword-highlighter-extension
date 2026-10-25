/* tests/specs/scan-style-memo.test.js — 2.0.8「扫描期计算样式复用」
 * ----------------------------------------------------------------------------
 * 一句话：**同一个元素在一轮扫描里只该问一次 `getComputedStyle`**。
 *
 * 现场（`src/ui/changelog.js` 的「记账不动」条记着的第二笔开销）：原生 `checkVisibility`
 * 判否时，`rendersSubtree` 会退到 `collapsedInPlace` + `customCollapseExpandable`，两者都
 * **沿祖先链逐个问样式**（上限 128）。祖先链在相邻元素之间绝大部分是重合的 —— 闭合
 * `<details>` 的正文、`content-visibility:hidden` 的长内容、隐藏抽屉里成百上千个节点，
 * 每个后代都把同一批祖先再问一遍。
 *
 * 本 spec 把这条口径变成**可断言的性质**（计数装置，不读源码文本）：
 *   ① 一轮扫描内：`总调用数 === 被问过的元素数`（每个元素最多一次）；
 *   ② 语义不变：折叠区里的词照旧命中、真隐藏区里的照旧不命中；
 *   ③ 跨轮换新：样式改了第二轮必须跟着改（缓存不许陈旧 —— K77 的拆词判据直接吃 `display`）。
 *
 * ⚠️ 装置本身也要忠实：`checkVisibility` 必须带**祖先语义**（祖先 `display:none` /
 * `content-visibility:hidden` ⇒ false），否则根本走不到那两条沿祖先链的路径，测出来是假绿。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/* ------------------------------------------------------------------ 装置 */

const INLINE_TAGS_STUB = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
]);

function chainOf(el) {
  const a = [];
  let n = el;
  while (n && n.nodeType === 1) { a.push(n); n = n.parentNode; }
  return a;
}

/** 计算样式模型：`display` 认 `[hidden]` 与行内标签默认值、`visibility` 按继承解析、
 *  `content-visibility` **不继承**（真浏览器就是这样，折叠判定靠它逐层看）。 */
function computedOf(el) {
  const own = (el && el._khStyle) || {};
  const tag = String((el && el.tagName) || '').toUpperCase();
  let visibility = 'visible';
  for (const n of chainOf(el)) {
    const st = n._khStyle;
    if (st && st.visibility) { visibility = st.visibility; break; }
  }
  const hiddenAttr = !!(el.hasAttribute && el.hasAttribute('hidden'));
  return {
    display: own.display || (hiddenAttr ? 'none' : (INLINE_TAGS_STUB.has(tag) ? 'inline' : 'block')),
    visibility: visibility,
    contentVisibility: own.contentVisibility || 'visible',
    position: own.position || 'static',
    float: own.float || 'none'
  };
}

/** 本轮扫描的计数：元素 → 被问样式的次数；`total` = 总调用数 */
let perCall = null;
let total = 0;

function cssReset() { perCall = new Map(); total = 0; }
function cssMaxPerElement() {
  let max = 0;
  for (const n of perCall.values()) if (n > max) max = n;
  return max;
}

/** 装计数版 `getComputedStyle` + 祖先语义版 `checkVisibility`（跑完**原样还原**，别污染别的 spec） */
function withCountingCss(fn) {
  const prevCS = global.getComputedStyle;
  const prevCV = H.ShimElement.prototype.checkVisibility;
  cssReset();
  global.getComputedStyle = (el) => {
    total++;
    perCall.set(el, (perCall.get(el) || 0) + 1);
    return computedOf(el);
  };
  H.ShimElement.prototype.checkVisibility = function () {
    for (const n of chainOf(this)) {
      const st = computedOf(n);
      if (st.display === 'none') return false;
      if (st.contentVisibility === 'hidden') return false;
    }
    const own = (this._khStyle || {});
    if (own.display === 'contents') return false;      // 没有布局盒 ⇒ 原生一律判否（K76 的现场）
    const cs = computedOf(this);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return true;
  };
  try { return fn(); } finally {
    if (prevCS === undefined) delete global.getComputedStyle; else global.getComputedStyle = prevCS;
    if (prevCV === undefined) delete H.ShimElement.prototype.checkVisibility; else H.ShimElement.prototype.checkVisibility = prevCV;
  }
}

function styled(el, style) { el._khStyle = Object.assign({}, style || {}); return el; }

const ruleFor = (KH, text) => KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: text, enabled: true }] });

/** 造一片"被折叠起来的长内容"：`fold` 之下套 `depth` 层 wrapper，每层挂 `spans` 个带词的 span。
 *  这样祖先链**高度重合**（正是要考的形状），而每个后代都要沿链问一遍样式。 */
function foldedTree(foldStyle, depth, spans) {
  const box = H.el('div');
  const fold = styled(H.el('div'), foldStyle);
  let cur = fold;
  for (let d = 0; d < depth; d++) {
    const w = H.el('div');
    cur.appendChild(w);
    cur = w;
    for (let i = 0; i < spans; i++) {
      const s = H.el('span');
      s.appendChild(H.txt('辰式词'));
      w.appendChild(s);
    }
  }
  box.appendChild(fold);
  return box;
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');

  suite('2.0.8 · 扫描期计算样式复用：同一元素一轮只问一次，且缓存不许陈旧');

  await test('★ 装置哨兵：祖先 `content-visibility:hidden` 时后代必须被原生 `checkVisibility` 判否', () => {
    withCountingCss(() => {
      const box = foldedTree({ contentVisibility: 'hidden' }, 2, 1);
      const fold = box.childNodes[0];
      let descendant = fold;
      for (;;) {
        const kids = (descendant.childNodes || []).filter((n) => n.nodeType === 1);
        if (!kids.length) break;
        descendant = kids[kids.length - 1];
      }
      eq(descendant.checkVisibility({ checkVisibilityCSS: true }), false,
        '装置不忠实的话，下面两条沿祖先链的路径根本不会走 ⇒ 计数断言是假绿');
      const plain = H.el('div');
      eq(plain.checkVisibility({ checkVisibilityCSS: true }), true, '普通元素 ⇒ 判是（快路径）');
    });
  });

  await test('★ 一轮扫描内：同一元素最多问一次样式（总调用数 === 被问过的元素数）', () => {
    withCountingCss(() => {
      const box = foldedTree({ contentVisibility: 'hidden' }, 6, 3);
      const hits = KH.Scanner.scan(box, ruleFor(KH, '辰式词'));
      truthy(hits.length > 0, '折叠在原位的内容**必须**命中（K77 的用户口径），实际 ' + hits.length);
      eq(cssMaxPerElement(), 1,
        '同一元素在一轮扫描里被问了 ' + cssMaxPerElement() + ' 次 —— 祖先链在相邻元素之间是重合的，' +
        '每问一次都是纯重复开销（总调用 ' + total + ' / 元素 ' + perCall.size + '）');
      eq(total, perCall.size,
        '总调用数应与"被问过的元素数"相等（实得 ' + total + ' vs ' + perCall.size + '）');
    });
  });

  await test('★ 语义不变：真隐藏（`display:none`）区里的词照旧一个都不命中', () => {
    withCountingCss(() => {
      const box = foldedTree({ display: 'none' }, 4, 3);
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 0, '真隐藏 ≠ 折叠：不许命中');
    });
  });

  await test('★ 跨轮换新：样式在扫描之间变了，第二轮必须跟着变（缓存不许陈旧）', () => {
    withCountingCss(() => {
      /* 形状：左半段在**行内** wrapper 里，右半段的 wrapper 先是块级（视觉上另起一块 ⇒ 词被切断），
       * 再把它改成行内级 ⇒ 同一行里接着读 ⇒ 必须接上（K77 的判据直接吃 `display`）。 */
      const box = H.el('div');
      const blkA = styled(H.el('div'), { display: 'inline' });
      const blkB = styled(H.el('div'), { display: 'block' });
      blkA.appendChild(H.txt('辰'));
      blkB.appendChild(H.txt('式词'));
      box.appendChild(blkA); box.appendChild(blkB);
      const rules = ruleFor(KH, '辰式词');
      eq(KH.Scanner.scan(box, rules).length, 0, '右半段是块级 div ⇒ 视觉上另起一块 ⇒ 不该把一个词接起来');
      blkB._khStyle = { display: 'inline' };                    // 页面随后把它改成行内级
      eq(KH.Scanner.scan(box, rules).length, 1, '第二轮必须重新读样式并接上（跨轮复用缓存会漏）');
      truthy(perCall.get(blkB) >= 2, '两轮各问一次是正常的（' + perCall.get(blkB) + ' 次）—— 缓存只在一轮内有效');
    });
  });
};
