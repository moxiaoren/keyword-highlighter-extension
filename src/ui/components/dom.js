/* ============================================================================
 * src/ui/components/dom.js · 组件层共用的最小 DOM 工具
 * ----------------------------------------------------------------------------
 * 只放"三端都会用到、且必须一模一样"的几个原语。**不放任何业务逻辑**。
 * 为什么要有它：旧版 options.js 里 `document.createElement` + `appendChild` 出现
 * 数百次，每处都自己拼 class 名与属性，改一处样式要全库搜。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});

  /**
   * 建元素。
   *   h('div', { class: 'kh-card', text: '标题' }, [child, '文本'])
   * 约定：`text` 一律走 textContent（**绝不 innerHTML**，用户输入不得进 HTML 解析器）。
   */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'class') el.className = v;
        else if (k === 'html') continue;              // 显式拒绝：本层不提供 HTML 注入口
        else if (k === 'dataset') { for (const d of Object.keys(v)) el.dataset[d] = v[d]; }
        else if (k === 'on') { for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]); }
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function clear(el) { if (el) el.textContent = ''; return el; }

  /**
   * ⚠️ 这两个是 **querySelector 语义**（要写 `#id`）。
   * 刻意不叫 `$` / `$$`：页面脚本里 `$('some-id')` 的惯例是 getElementById，
   * 两者混用会静默返回 null（实测踩到：设置页每个 `$('btn-x')` 都拿到 null，
   * 首个 `addEventListener` 直接抛错，整页停止渲染）。
   * 页面脚本请自行声明 `const $ = (id) => document.getElementById(id)`。
   */
  function sel(selector, root) { return (root || document).querySelector(selector); }
  function selAll(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  /** 稳定 id（key 用；不用于 DOM id） */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** 表单控件取值：统一从这里拿，避免各处 typeof 判断 */
  function valueOf(el) {
    if (!el) return '';
    if (el.type === 'checkbox') return !!el.checked;
    return el.value;
  }

  /**
   * 轻量提示。挂在 document.body 上（标 `data-kh-ext-ui`），
   * 这样即便在内容脚本场景也不会被误判为页面变化。
   */
  let toastHost = null;
  let toastTimer = null;
  /* 提示挂在哪：默认 document.body；当编辑器跑在页面里（Shadow DOM）时由 Modal 把 mount 传进来，
   * 否则提示会落在 shadow 外面、**拿不到组件样式**（变成一个没样式的裸文本块）。 */
  let toastMount = null;
  function setToastMount(mount) { toastMount = mount || null; }
  function toast(message, type) {
    const parent = (toastMount && toastMount.isConnected !== false) ? toastMount : document.body;
    if (!toastHost || toastHost.parentNode !== parent) {
      if (toastHost && toastHost.parentNode) toastHost.parentNode.removeChild(toastHost);
      toastHost = h('div', { class: 'kh-toast', 'data-kh-ext-ui': '1', role: 'status' });
      parent.appendChild(toastHost);
    }
    toastHost.textContent = String(message);
    toastHost.className = 'kh-toast kh-toast-' + (type || 'info');
    toastHost.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastHost) toastHost.hidden = true; }, 2600);
  }

  /** 确认框（统一走弹窗样式，不用原生 confirm —— 原生在扩展页里会阻塞渲染且有样式割裂） */
  function confirmBox(message, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const body = h('p', { class: 'kh-confirm-text', text: message });
      ui.Modal.open({
        title: o.title || '请确认',
        body,
        saveLabel: o.saveLabel || '确定',
        cancelLabel: o.cancelLabel || '取消',
        danger: !!o.danger,
        onSave: () => { resolve(true); return true; },
        onClose: () => resolve(false)
      });
    });
  }

  ui.dom = { h, clear, sel, selAll, uid, valueOf, toast, setToastMount, confirmBox };
})();
