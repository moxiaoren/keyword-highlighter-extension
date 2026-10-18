/* tests/harness.js — 极简测试框架 + 最小 DOM 垫片
 *
 * 为什么不用 playwright：
 *   本工程的**回归热点**（匹配边界、裁决优先级、字段往返、CSV 兼容、抓取解析）
 *   绝大多数是**纯逻辑**，不需要真实布局；用最小 DOM 垫片在 Node 里跑，
 *   单测毫秒级、无浏览器依赖，才能做到"每改一处都跑"。
 *   真正需要布局/几何的（视觉行合并、假表格几何对齐、CSS.highlights 生效）
 *   仍然必须真浏览器验证 —— 那一层由 tests/browser.md 列出的手工步骤覆盖。
 */
'use strict';

const assert = require('assert');

/* ---------------------------------------------------------------- 极简 DOM 垫片 */

/** 同级节点（真实 DOM 的 nextSibling / previousSibling）。
 *  垫片早期没实现它，于是 `Scanner.carrier()`（跨节点命中靠它把相邻行内文本串起来）
 *  在单测里永远找不到兄弟 → 跨节点能力在单测层完全锁不住，只能靠真浏览器。 */
function siblingOf(n, dir) {
  const p = n && n.parentNode;
  if (!p || !p.childNodes) return null;
  const i = p.childNodes.indexOf(n);
  if (i < 0) return null;
  return p.childNodes[i + dir] || null;
}

/** 极简 Text 节点 */
class ShimText {
  /* `parentElement` 必须是**派生**的（真实 DOM 里文本节点的 parentElement 就是父元素）。
   * 垫片早期把它写成了恒为 null 的自有属性，于是 `Scanner.collectTextNodes` 的
   * `node.parentElement` 守卫永远拒绝 → 单测里**永远取不到任何文本节点**
   * （跨节点相关的不变式因此无法在单测层锁住，只能靠真浏览器）。 */
  constructor(data) { this.nodeType = 3; this.nodeValue = String(data == null ? '' : data); this.parentNode = null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() { return siblingOf(this, +1); }
  get previousSibling() { return siblingOf(this, -1); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}

/** 极简 Element */
class ShimElement {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.tagName = String(tag || 'DIV').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = Object.assign({}, attrs || {});
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      getPropertyValue(k) { return this._p[k] || ''; }
    };
    this._class = (attrs && attrs.class) || '';
    this.hidden = false;
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() { return siblingOf(this, +1); }
  get previousSibling() { return siblingOf(this, -1); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const sibs = p.children;
    const i = sibs.indexOf(this);
    return (i >= 0 && i + 1 < sibs.length) ? sibs[i + 1] : null;
  }
  get previousElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const sibs = p.children;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  /* 反射属性：真实 DOM 里 `a.href = x` / `img.src = x` 会写回属性，被测代码依赖这个行为 */
  get href() { return this.getAttribute('href'); }
  set href(v) { this.setAttribute('href', v); }
  get src() { return this.getAttribute('src'); }
  set src(v) { this.setAttribute('src', v); }
  get alt() { return this.getAttribute('alt') || ''; }
  set alt(v) { this.setAttribute('alt', v); }
  get target() { return this.getAttribute('target') || ''; }
  set target(v) { this.setAttribute('target', v); }
  get rel() { return this.getAttribute('rel') || ''; }
  set rel(v) { this.setAttribute('rel', v); }
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  get classList() {
    const self = this;
    return {
      add(c) { const s = new Set(self._class.split(/\s+/).filter(Boolean)); s.add(c); self._class = Array.from(s).join(' '); },
      remove(c) { const s = new Set(self._class.split(/\s+/).filter(Boolean)); s.delete(c); self._class = Array.from(s).join(' '); },
      toggle(c, on) { if (on === undefined) on = !this.contains(c); on ? this.add(c) : this.remove(c); },
      contains(c) { return self._class.split(/\s+/).indexOf(c) >= 0; }
    };
  }
  appendChild(n) { if (n && n.parentNode) n.parentNode.removeChild(n); this.childNodes.push(n); if (n) { n.parentNode = this; } return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); if (n) n.parentNode = null; return n; }
  /** 真 DOM 有、垫片一直缺的一个：往里插到某个子节点之前。缺它时排布层（把工具栏控件插到
   *  清空键前面）在单测里直接 `TypeError: insertBefore is not a function` —— 是垫片缺口，不是产品 bug。 */
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n && n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(n);
    this.childNodes.splice(i, 0, n);
    if (n) n.parentNode = this;
    return n;
  }
  replaceChild(n, old) { const i = this.childNodes.indexOf(old); if (i >= 0) { this.childNodes[i] = n; n.parentNode = this; old.parentNode = null; } return old; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return (k in this.attributes) ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  get textContent() {
    let s = '';
    for (const c of this.childNodes) s += (c.nodeType === 3) ? (c.nodeValue || '') : (c.textContent || '');
    return s;
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new ShimText(v));
  }
  /**
   * 极简选择器匹配：支持 `tag` / `.class` / `tag.class` / `*` / `a, b`，
   * 以及**后代组合** `a b`（与真实 DOM 一致）。
   * 本工程里 `table.querySelectorAll('td,th')`、`scope.querySelectorAll('table')`、
   * `root.querySelectorAll('tr')` 等都用到了后代语义，不实现会静默返回空。
   */
  _matchesSelector(el, sel) {
    const tokens = String(sel).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const last = tokens[tokens.length - 1];
    if (!this._matchesSimple(el, last)) return false;
    // 其余 token 必须能在祖先链里按序找到（从右往左匹配）
    let node = el.parentNode;
    let i = tokens.length - 2;
    while (i >= 0) {
      let found = false;
      while (node && node.nodeType === 1) {
        if (this._matchesSimple(node, tokens[i])) { found = true; node = node.parentNode; break; }
        node = node.parentNode;
      }
      if (!found) return false;
      i--;
    }
    return true;
  }
  _matchesSimple(el, p) {
    const m = /^([a-zA-Z0-9*-]*)(?:\.([a-zA-Z0-9_-]+))?$/.exec(p);
    if (!m) return false;
    const tag = m[1] ? m[1].toUpperCase() : '';
    const cls = m[2] || '';
    if (tag && tag !== '*' && el.tagName !== tag) return false;
    if (cls && !el.classList.contains(cls)) return false;
    return true;
  }
  /** 最近的自匹配祖先（含自身）。垫片早期没有它 → `Cells.cellOf()` 的真实表格分支恒为 null，
   *  组合词（td/th 定位）在单测里根本走不起来。 */
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (this._matchesSelector(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (groups.some(g => this._matchesSelector(c, g))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(n) {
    let p = n;
    while (p) { if (p === this) return true; p = p.parentNode; }
    return false;
  }
  get isConnected() { let p = this; while (p && p.nodeType === 1) { if (p._isDocRoot) return true; p = p.parentNode; } return false; }
  attachShadow() { const s = new ShimElement('shadow-root'); s.host = this; this.shadowRoot = s; return s; }
  get rootNode() { let p = this; while (p.parentNode) p = p.parentNode; return p; }
  /** 几何：测试里显式喂 rect（默认 0，由用例设置） */
  getBoundingClientRect() { return this._rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }

  /**
   * 事件：垫片长期**一个监听器都没有** ⇒ `panel.ensure()` 一挂 click 委托就抛（T38），
   * 面板的 DOM 交互通路在单测里根本走不起来。这里只给本工程真正需要的那一层：
   * 同类型多个监听器按注册序、**冒泡**（影子根再接到 host，真实 DOM 里 click 是 composed）、
   * `stopPropagation` 生效。不实现捕获阶段 / once / passive，也不解析事件对象 ——
   * 用例自己传 `{ type, ... }`，缺的回调由这里补上。
   */
  addEventListener(type, fn) {
    this._ev = this._ev || {};
    this._ev[type] = (this._ev[type] || []).concat(fn);
  }
  removeEventListener(type, fn) {
    const list = this._ev && this._ev[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev) {
    const type = ev && ev.type;
    if (!type) return true;
    if (!ev.target) ev.target = this;
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => { ev.defaultPrevented = true; };
    if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => { ev._stop = true; };
    for (let n = this; n; n = n.parentNode || n.host || null) {
      const list = (n._ev && n._ev[type]) || [];
      for (const fn of list.slice()) fn.call(n, ev);
      if (ev._stop) break;
    }
    return !ev.defaultPrevented;
  }

  /**
   * innerHTML —— 垫片里也提供，因为被测代码用它做"HTML 转义"（`div.textContent = s; return div.innerHTML`）
   * 与"插入自产表格"。只支持本工程实际用到的子集：无属性的常规标签 + 文本。
   */
  get innerHTML() { return childNodesToHtml(this); }
  set innerHTML(html) {
    this.childNodes = [];
    for (const node of parseHtml(String(html == null ? '' : html))) this.appendChild(node);
  }
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function escapeHtmlText(s) { return String(s).replace(/[&<>"]/g, (c) => HTML_ESC[c]); }
const HTML_UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function unescapeHtmlText(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent.charAt(0) === '#') {
      const code = ent.charAt(1) === 'x' || ent.charAt(1) === 'X'
        ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return isNaN(code) ? m : String.fromCodePoint(code);
    }
    return (ent in HTML_UNESC) ? HTML_UNESC[ent] : m;
  });
}

function childNodesToHtml(node) {
  let out = '';
  for (const c of node.childNodes || []) {
    if (c.nodeType === 3) { out += escapeHtmlText(c.nodeValue || ''); continue; }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName.toLowerCase();
    if (tag === 'shadow-root' || tag === 'fragment') { out += childNodesToHtml(c); continue; }
    let attrs = '';
    for (const k of Object.keys(c.attributes || {})) attrs += ' ' + k + '="' + escapeHtmlText(c.attributes[k]) + '"';
    out += '<' + tag + attrs + '>' + childNodesToHtml(c) + '</' + tag + '>';
  }
  return out;
}

/** 极简 HTML 解析：标签 + 属性 + 文本（够解析本工程自产的 <table>/<img>/<td rowspan>） */
function parseHtml(html) {
  const root = new ShimElement('fragment');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) {
      const text = unescapeHtmlText(html.slice(last, m.index));
      if (text) top().appendChild(new ShimText(text));
    }
    last = tagRe.lastIndex;
    const tag = m[1].toLowerCase();
    if (m[0].charAt(1) === '/') {
      for (let i = stack.length - 1; i >= 1; i--) {          // 闭合：弹到匹配者（找不到就忽略）
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const attributes = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2] || '')) !== null) {
      const val = (a[2] !== undefined) ? a[2] : (a[3] !== undefined) ? a[3] : (a[4] !== undefined ? a[4] : '');
      attributes[a[1].toLowerCase()] = val;
    }
    const node = new ShimElement(tag, attributes);
    top().appendChild(node);
    const selfClose = m[3] === '/' || /^(br|img|hr|input|meta|link)$/.test(tag);
    if (!selfClose) stack.push(node);
  }
  if (last < html.length) {
    const text = unescapeHtmlText(html.slice(last));
    if (text) top().appendChild(new ShimText(text));
  }
  return root.childNodes.slice();
}

function el(tag, attrs, children) {
  const e = new ShimElement(tag, attrs);
  for (const c of (children || [])) e.appendChild(typeof c === 'string' ? new ShimText(c) : c);
  return e;
}
function txt(s) { return new ShimText(s); }

/** 建一个最小 document 垫片并挂到 globalThis */
function makeDocument() {
  const html = el('html');
  const body = el('body');
  html.appendChild(body);
  html._isDocRoot = true;
  const head = el('head');
  html.appendChild(head);

  const doc = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    createElement: (t) => el(t),
    createTextNode: (s) => txt(s),
    createDocumentFragment: () => { const f = el('fragment'); f.nodeType = 11; return f; },
    createRange: () => ({
      startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
      setStart(n, o) { this.startContainer = n; this.startOffset = o; },
      setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
      selectNodeContents() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      getClientRects() { return []; }
    }),
    createTreeWalker: function (root, whatToShow, filter) {
      const accept = filter && filter.acceptNode ? filter.acceptNode : () => 1;
      const list = [];
      const SHOW_ELEMENT = 1, SHOW_TEXT = 4;
      const hasEl = !!(whatToShow & SHOW_ELEMENT);
      const hasText = !!(whatToShow & SHOW_TEXT);
      // 必须尊重 FILTER_REJECT（2）＝"连子树一起跳过"；
      // 不实现这一点会让 isHighlightableNode 之类"拒绝整个 script/style 子树"的过滤形同虚设。
      /* 必须尊重 whatToShow：真实 TreeWalker **只对通过的节点调用过滤器**
       * （SHOW_TEXT 的 walker 永远不会把元素喂给 `acceptNode`）。
       * 垫片早期对元素也调用过滤器，而 `collectTextNodes` 的 acceptNode 对"没有 nodeValue 的元素"
       * 一律返回 REJECT → 整棵子树被跳过 → 单测里永远取不到文本节点。 */
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) {
            if (hasText && (!filter || accept(c) === 1)) list.push(c);
            continue;
          }
          if (c.nodeType !== 1) continue;
          const verdict = (hasEl && filter) ? accept(c) : 1;
          if (verdict === 2) continue;                 // REJECT：整棵子树跳过
          if (hasEl && verdict === 1) list.push(c);
          walk(c);                                     // ACCEPT 或 SKIP 都继续下钻
        }
      };
      walk(root);
      let i = -1;
      return { nextNode() { i++; return list[i] || null; } };
    },
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    contains: (n) => body.contains(n),
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null
  };
  return doc;
}

/** 安装浏览器垫片（在 require 被测文件之前调用）。
 *  注意：Node 18+ 已在 globalThis 上定义了只读的 `navigator` / 可能的 `location`，
 *  直接赋值会抛 "has only a getter" —— 用 defineProperty 强制覆盖。 */
function defineGlobal(name, value) {
  try {
    Object.defineProperty(global, name, { value, writable: true, configurable: true, enumerable: true });
  } catch (err) {
    try { global[name] = value; } catch (err2) { /* 实在覆盖不了就沿用宿主提供的 */ }
  }
}

function installDOM() {
  const doc = makeDocument();
  defineGlobal('document', doc);
  // KH 挂在 window 上；Node 里 window 可能不存在或不可覆盖，统一指向 globalThis
  defineGlobal('window', global.window || global);
  /* window 的事件通路（2.0.2.2 需求 1）：生产代码会挂 `window.addEventListener('resize'|'pointermove'…)`
   * —— 灯箱全文栏跟手窗口大小、面板拖动都走它。垫片里 `window` 就是 global，而 Node 的 globalThis
   * **没有** addEventListener ⇒ 以前这些分支一挂就抛，"别挂"成了唯一绕法（两处 specs 的注释都记着）。
   * 这里给一个最小实现：按注册序回调、可移除，并暴露 `__khFire(type)` 供单测直接派发一次。 */
  if (typeof global.window.addEventListener !== 'function') {
    const bus = Object.create(null);
    defineGlobal('addEventListener', function (type, fn) {
      if (typeof fn !== 'function') return;
      (bus[type] = bus[type] || []).push(fn);
    });
    defineGlobal('removeEventListener', function (type, fn) {
      const list = bus[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    });
    global.window.__khFire = function (type, ev) {
      for (const fn of (bus[type] || []).slice()) fn(ev || { type: type, preventDefault() {}, stopPropagation() {} });
    };
  }
  defineGlobal('Node', { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  defineGlobal('NodeFilter', { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 });
  defineGlobal('location', { href: 'https://example.com/a/b?x=1', hostname: 'example.com' });
  if (!global.navigator) defineGlobal('navigator', { userAgent: 'node' });
  if (!global.CSS) defineGlobal('CSS', { highlights: new Map() });
  if (!global.Highlight) {
    defineGlobal('Highlight', function (r) {
      this.ranges = r ? [r] : [];
      this.add = (x) => this.ranges.push(x);
      this.delete = () => {};
    });
  }
  return doc;
}

/* ---------------------------------------------------------------- 断言工具 */

const results = { pass: 0, fail: 0, failures: [] };
let currentSuite = '';
/** 异步用例的 pending 列表（test() 支持 async 函数） */
const pending = [];

function suite(name) { currentSuite = name; console.log('\n── ' + name); }

/**
 * 定义用例。**必须是 async 感知的**：test() 返回一个 Promise，
 * 调用方（spec 的 run()）await 它，保证 async 用例在"下一个用例的同步准备代码"
 * 之前就跑完 —— 否则所有 async 用例会堆到 settle() 阶段才依次执行，
 * 期间同步代码已经把它们依赖的共享状态（mem.keywords 等）改掉了。
 */
function test(name, fn) {
  const where = currentSuite ? currentSuite + ' › ' + name : name;
  pending.push((async () => {
    try {
      await fn();
      recordPass(name);
    } catch (err) {
      recordFail(where, name, err);
    }
  })());
  return pending[pending.length - 1];
}

function recordPass(name) {
  results.pass++;
  console.log('  ✓ ' + name);
}

function recordFail(where, name, err) {
  results.fail++;
  results.failures.push({ where, message: err && err.message, stack: err && err.stack });
  console.log('  ✗ ' + name);
  console.log('      ' + (err && err.message));
}

/** 已知的垫片能力缺口：显式记为 skip 并在汇总列出，绝不伪装成通过 */
const skips = [];
function skip(name, reason) {
  skips.push(name + '（' + reason + '）');
  console.log('  ○ ' + name + '  [跳过: ' + reason + ']');
}
/** 在用例里断言"这条依赖垫片能力 X，若 X 不支持就跳过" */
function skipIf(cond, name, reason) {
  if (cond) { skip(name, reason); return true; }
  return false;
}

/** 等待所有异步用例结束（run.js 在调用完所有 spec 后 await 它） */
function settle() { return Promise.all(pending); }

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, (msg ? msg + ' — ' : '') +
    'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function deepEq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, (msg ? msg + ': ' : '') + 'mismatch');
}
function truthy(v, msg) { assert.ok(v, msg || 'expected truthy, got ' + JSON.stringify(v)); }
function falsy(v, msg) { assert.ok(!v, msg || 'expected falsy, got ' + JSON.stringify(v)); }

/** 本次跑完的实测计数。run.js 拿它核对 README 里写死的「当前数字」——
 *  文档里的数字必须由脚本产出（票 #42：2.0.2.6 体检抓到 README 还写着 401/46/1.51.0）。 */
function stats() { return { pass: results.pass, fail: results.fail, skip: skips.length }; }

function report() {
  console.log('\n' + '─'.repeat(60));
  console.log('通过 ' + results.pass + ' · 失败 ' + results.fail + (skips.length ? ' · 跳过 ' + skips.length : ''));
  if (skips.length) {
    console.log('\n跳过的用例（已知垫片能力缺口，需真浏览器覆盖）：');
    for (const s of skips) console.log('  ○ ' + s);
  }
  if (results.fail) {
    console.log('\n失败明细：');
    for (const f of results.failures) console.log('  ✗ ' + f.where + '\n      ' + f.message);
    process.exitCode = 1;
  }
  return results.fail === 0;
}

/**
 * 按 manifest 的 content_scripts 顺序在 Node 里加载内核模块（保证依赖序与浏览器一致）。
 *
 * **幂等**：内核模块是 IIFE，靠 `window.KH = window.KH || {}` 累积注册；
 * 重复执行会把已注册的扩展点重置成空（注册表被重新赋值）→ 后面的 spec 静默拿到半残内核。
 * 因此这里只在**首次**真正执行文件，之后一律返回同一个 KH 实例。
 */
let _kernelCache = null;
function loadKernel(extraFiles) {
  if (_kernelCache && !extraFiles) return _kernelCache;
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = ((manifest.content_scripts || [])[0] || {}).js || [];
  const skip = new Set(['src/build-info.js', 'content/content.js']);
  for (const rel of files) {
    if (skip.has(rel)) continue;
    if (!fs.existsSync(path.join(root, rel))) continue;
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'globalThis', code)(global.window, global.document, global);
  }
  for (const rel of (extraFiles || [])) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    new Function('window', 'document', 'globalThis', code)(global.window, global.document, global);
  }
  if (!extraFiles) _kernelCache = global.window.KH;
  return global.window.KH;
}

/**
 * 【票 #47】工作区私有文件（`_tools/`、`_MIGRATION_CHECKLIST.md`、`_e2e/`）不在公开扩展仓里。
 * 以前这几条检查找不到文件就 `skip` —— 只 clone 扩展仓的人看到的是"绿 + 跳过"，
 * 读起来像"这条检查通过了"，实际一条都没跑。
 *
 * 现在：文件在 ⇒ 返回 true（照常断言）；不在 ⇒ **登记一条可读的失败用例**并返回 false。
 * 判据就是票面那句：单仓检出时要么明红（原因可读），要么根本不跑 —— 不许绿 + 静默跳过。
 *
 * @param {string} name 用例名（会带上一句"工作区私有文件缺失 ⇒ 红，不跳过"）
 * @param {string} file 期望存在的绝对路径
 * @param {string} hint 修法（一句话，进失败详情）
 */
function needWorkspaceFile(name, file, hint) {
  const fs = require('fs');
  let ok = false;
  try { ok = fs.existsSync(file); } catch (e) { ok = false; }   // 权限/非法路径一律按"缺失"处理
  if (ok) return true;
  test(name + '（工作区私有文件缺失 ⇒ 红，不跳过）', () => {
    throw new Error('找不到 ' + file + '\n      ' + hint +
      '\n      票 #47 口径：这类检查**不许静默 skip**（绿+跳过会被读成"已经通过了"）。');
  });
  return false;
}

module.exports = {
  suite, test, eq, deepEq, truthy, falsy, report, settle, skip, skipIf, stats, needWorkspaceFile,
  installDOM, makeDocument, loadKernel, el, txt,
  ShimElement, ShimText
};
