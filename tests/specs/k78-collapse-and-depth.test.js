/* tests/specs/k78-collapse-and-depth.test.js — K78 的三项收口（2026-09-23）
 * ----------------------------------------------------------------------------
 * 用户 2026-09-23 拍板：本轮做 **②+④+①**（③ 极端页面性能不做）。
 *   ② `carrier()` 的祖先上限 `depth < 8` → **128**（与 K77 修好的 `collapsedInPlace` 对齐；
 *      口径上"词是否被拆开"与嵌套层数无关）。
 *   ④ `relevance` 的**属性分支**原来只取"被改元素自身的文本" ⇒ 拆词场景判"不用重建"
 *      （R4 发版后黄-4：`<div class="blk">辰</div><span>式词</span>` 改 class 后接不上）。
 *      现在与 `childList` 分支**共用同一份取样**（`ctxOf`）。
 *   ① 作者用 `display:none` 收起来、旁边有「展开」控件的内容要命中 —— 见 A4–A8（本轮后续补）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const ruleFor = (KH, text) => KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: text, enabled: true }] });
const rulePlain = (src) => ({ pattern: new RegExp(src, 'g'), labelPattern: null, flags: {}, meta: {} });
const textsOf = (nodes) => nodes.map((n) => String(n.nodeValue));

/** `n` 层行内 `<span>` 包着 `text`（每层都只有这一个孩子 ⇒ 只有在最外层才找得到兄弟） */
function nest(n, text) {
  let cur = H.el('span');
  cur.appendChild(H.txt(text));
  for (let i = 1; i < n; i++) { const w = H.el('span'); w.appendChild(cur); cur = w; }
  return cur;
}

/** 给 ④ 用的假元素（`classify` 只碰这几个口子；与 relevance.test.js 同形 + 兄弟指针） */
function fakeEl(tag, text) {
  const el = {
    nodeType: 1, tagName: String(tag || 'DIV').toUpperCase(), textContent: String(text || ''),
    parentElement: null, isConnected: true, children: [],
    previousElementSibling: null, nextElementSibling: null,
    hasAttribute: () => false,
    closest() { return null; },
    contains() { return false; },
    querySelector() { return null; },
    checkVisibility() { return true; }                 // 可见（④ 的两条用例都在"可见"这一支）
  };
  return el;
}

/** 用假的 rules / registry 跑一次相关性判据（不改真实内核状态，跑完还原） */
function withStubs(rules, fn) {
  const { KH } = require('../bootstrap');
  const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
  const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
  Object.defineProperty(KH, 'rules', { value: rules, configurable: true });
  Object.defineProperty(KH, 'registry', { value: { all: () => [], size: 0 }, configurable: true });
  try { return fn(KH); } finally {
    if (dRules) Object.defineProperty(KH, 'rules', dRules);
    if (dReg) Object.defineProperty(KH, 'registry', dReg);
  }
}
const attrRec = (target) => ({ type: 'attributes', target: target, addedNodes: [], removedNodes: [], attributeName: 'class' });

/* ---------------- ① 需要的"计算样式"桩（判据要看 display/visibility/position/float） ---------------- */

const INLINE_TAGS = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
]);
function baseStyle(el) {
  const tag = String((el && el.tagName) || '').toUpperCase();
  return {
    display: tag === 'BUTTON' ? 'inline-block' : (INLINE_TAGS.has(tag) ? 'inline' : 'block'),
    visibility: 'visible', contentVisibility: 'visible', position: 'static', float: 'none'
  };
}
const csOf = (el) => (el && el._khStyle) || baseStyle(el);
/** 挂"计算样式" */
function styled(el, style) { el._khStyle = Object.assign({}, baseStyle(el), style || {}); return el; }

function withCss(fn) {
  const prevCS = global.getComputedStyle;
  const prevCV = H.ShimElement.prototype.checkVisibility;
  global.getComputedStyle = (el) => csOf(el);
  H.ShimElement.prototype.checkVisibility = function () {
    for (let n = this; n; n = n.parentElement) {
      const st = csOf(n);
      if (st.display === 'none' || st.visibility === 'hidden' || st.contentVisibility === 'hidden') return false;
    }
    if (csOf(this).display === 'contents') return false;
    return true;
  };
  try { return fn(); } finally {
    if (prevCS === undefined) delete global.getComputedStyle; else global.getComputedStyle = prevCS;
    if (prevCV === undefined) delete H.ShimElement.prototype.checkVisibility; else H.ShimElement.prototype.checkVisibility = prevCV;
  }
}

/** 临时改 `KH.state.config.scanCollapsedCustom`（只动 `.config`，跑完还原） */
function withToggle(value, fn) {
  const { KH } = require('../bootstrap');
  const hadState = !!KH.state;
  if (!hadState) { try { KH.state = {}; } catch (e) { /* ignore */ } }
  const prevCfg = KH.state && KH.state.config;
  try { KH.state.config = Object.assign({}, prevCfg || {}, { scanCollapsedCustom: value }); } catch (e) { /* ignore */ }
  try { return fn(); } finally {
    try { KH.state.config = prevCfg; if (!hadState) delete KH.state; } catch (e) { /* ignore */ }
  }
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const U = KH.Scanner.util;

  suite('K78 · run 祖先上限 / 属性变更的取样范围（① 折叠启发式见后续小节）');

  await test('★ A1【②】词被 **9 层**行内包装拆开时也要接上（原先 `carrier()` 的 8 层上限会放弃）', () => {
    const box = H.el('div');
    const s1 = H.el('span'); s1.appendChild(H.txt('辰'));
    const s3 = H.el('span'); s3.appendChild(H.txt('词'));
    box.appendChild(s1); box.appendChild(nest(9, '式')); box.appendChild(s3);

    /* 九层包装都是单孩子 ⇒ 只有走到**最外层**才找得到兄弟 `辰`，正好越过旧的 `depth < 8` */
    eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1,
      '9 层行内包装的拆词必须命中（改前：`carrier()` 在 8 层放弃 ⇒ 0）');
  });

  await test('★ A2【④】属性变化落在 wrapper 上、关键词在**邻居**里 ⇒ 必须重建', () => {
    const wrap = fakeEl('DIV', '辰');                    // 自身文本只有「辰」
    const sib = fakeEl('SPAN', '式词');                  // 关键词的另一半在**行内兄弟**里
    wrap.nextElementSibling = sib;
    eq(withStubs([rulePlain('辰式词')], (K) => K.Relevance.classify([attrRec(wrap)], {})), 'full',
      '取样必须取到"所在上下文"（自己 + 行内兄弟）⇒ 命中前缀 ⇒ full；' +
      '改前只取自身文本「辰」⇒ 预筛判不可能命中 ⇒ skip（R4 发版后黄-4）');
  });

  await test('★ A3【④】负例：上下文与关键词无关 ⇒ 仍不许重建（取样放宽不等于"什么都重建"）', () => {
    const wrap = fakeEl('DIV', '今天');
    const sib = fakeEl('SPAN', '天气晴朗');
    wrap.nextElementSibling = sib;
    eq(withStubs([rulePlain('辰式词')], (K) => K.Relevance.classify([attrRec(wrap)], {})), 'skip',
      '上下文里没有关键词前缀 ⇒ skip（这条守住"取样放宽"没有把预筛废掉）');
  });

  await test('★ A4【①】`display:none` + 紧邻「展开」控件 + 同容器有可见前文 ⇒ 放行（并计数）', () => {
    withCss(() => {
      const box = H.el('div');
      const head = H.el('span'); head.appendChild(H.txt('驳回原因：材料不齐'));
      const btn = H.el('button'); btn.setAttribute('aria-expanded', 'false'); btn.appendChild(H.txt('展开'));
      const body = styled(H.el('div'), { display: 'none' }); body.appendChild(H.txt('辰式词'));
      box.appendChild(head); box.appendChild(btn); box.appendChild(body);

      eq(U.customCollapseExpandable(body), true, '六条都成立 ⇒ 必须放行（作者自己折叠的长内容 = 页面内容）');
      truthy(textsOf(U.textNodesIn(box)).indexOf('辰式词') >= 0, '它的文本要进扫描范围');
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1, '并且要命中');
      truthy(KH.Scanner._lastScan.customCollapsePassThrough >= 1,
        '放行必须计入 customCollapsePassThrough，实际 ' + KH.Scanner._lastScan.customCollapsePassThrough);
    });
  });

  await test('★ A5【①】负例：隐藏菜单（前面没有可见前文、也没有展开控件）⇒ 仍不放行', () => {
    withCss(() => {
      const box = H.el('div');
      const ul = styled(H.el('ul'), { display: 'none' });
      const li = H.el('li'); li.appendChild(H.txt('隐藏 辰式词')); ul.appendChild(li);
      box.appendChild(ul);                                   // 它是容器的第一个孩子 ⇒ 前面没有可见前文
      box.appendChild(H.el('p', null, ['页面正文']));

      eq(U.customCollapseExpandable(li), false, '隐藏菜单不是"折叠起来的长内容" ⇒ 不许放行（v1.99.99.16 的口径）');
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 0, '里面的词不许命中');
      eq(KH.Scanner._lastScan.customCollapsePassThrough, 0, '拒绝的当然不计放行数');
    });
  });

  await test('★ A6【①】负例：`visibility:hidden` / `content-visibility:hidden` / 浮层 ⇒ 不因 ① 被放宽', () => {
    withCss(() => {
      const build = (style, host) => {
        const box = host || H.el('div');
        const head = H.el('span'); head.appendChild(H.txt('前文'));
        const btn = H.el('button'); btn.setAttribute('aria-expanded', 'false'); btn.appendChild(H.txt('展开'));
        const body = styled(H.el('div'), Object.assign({ display: 'none' }, style || {}));
        body.appendChild(H.txt('辰式词'));
        box.appendChild(head); box.appendChild(btn); box.appendChild(body);
        return { box: box, body: body };
      };
      eq(U.customCollapseExpandable(build({ visibility: 'hidden' }).body), false,
        '`visibility:hidden` 另有口径（组 8d ⑥）⇒ ① 不许放行');
      eq(U.customCollapseExpandable(build({ contentVisibility: 'hidden' }).body), false,
        '`content-visibility:hidden` 也不是"作者用 display:none 收的" ⇒ 不放行');

      /* 浮层：让整块落在一个"覆盖大半视口的 fixed 盒子"里 */
      const prevW = global.window && global.window.innerWidth, prevH = global.window && global.window.innerHeight;
      try {
        if (global.window) { global.window.innerWidth = 1000; global.window.innerHeight = 800; }
        const overlay = styled(H.el('div'), { position: 'fixed' });
        overlay.getBoundingClientRect = () => ({ width: 900, height: 700 });
        const o = build(null, overlay);
        eq(U.customCollapseExpandable(o.body), false, '浮层里的内容不归 ① 管（展开也不是"接着上文读"）');
      } finally {
        if (global.window) { global.window.innerWidth = prevW; global.window.innerHeight = prevH; }
      }
    });
  });

  await test('★ A7【①】设置开关：默认开 / 关掉即回到旧行为（`scanCollapsedCustom`）', () => {
    withCss(() => {
      const build = () => {
        const box = H.el('div');
        const btn = H.el('button'); btn.setAttribute('aria-expanded', 'false'); btn.appendChild(H.txt('展开'));
        const body = styled(H.el('div'), { display: 'none' }); body.appendChild(H.txt('辰式词'));
        box.appendChild(btn); box.appendChild(body);
        return { box: box, body: body };
      };
      eq(U.customCollapseExpandable(build().body), true, '缺键 = 默认开（存量用户不需要改配置）');
      withToggle(false, () => {
        eq(U.customCollapseExpandable(build().body), false, '开关关掉 ⇒ 完全回到旧行为');
        eq(KH.Scanner.scan(build().box, ruleFor(KH, '辰式词')).length, 0, '关掉后不许命中');
      });
      withToggle(true, () => {
        eq(KH.Scanner.scan(build().box, ruleFor(KH, '辰式词')).length, 1, '显式打开 ⇒ 照常命中');
      });
    });
  });

  await test('★ A8【①】快路径哨兵：普通可见树上 ① 的计数为 0（判据只对"原生判否"的元素生效）', () => {
    withCss(() => {
      const box = H.el('div');
      const p = H.el('p'); p.appendChild(H.txt('辰式词')); box.appendChild(p);
      eq(KH.Scanner.scan(box, ruleFor(KH, '辰式词')).length, 1, '普通树照旧命中');
      eq(KH.Scanner._lastScan.customCollapsePassThrough, 0, '没有折叠 ⇒ 计数 0');
      eq(KH.Scanner._lastScan.prunedInvisible, 0, '也没有被剪的');
    });
  });
};
