/* ============================================================================
 * src/ui/components/modal.js · 统一弹窗（三端共用）
 * ----------------------------------------------------------------------------
 * 旧版问题（方案 §8.2 明确要求修正）：
 *   ① 「添加/编辑」在 options 里是弹窗，在 popup 里却是**另开一个窗口跳设置页**
 *      —— 同一次操作两套交互（R8：popup 必须能内联弹）。
 *   ② 弹窗底部按钮跟着内容滚，表单一长就找不到「保存」。
 *   ③ 内容多时出现"双层滚动条"（外层遮罩也滚 + 内层也滚）。
 * 本实现一次性解决：
 *   · 遮罩不滚（`overflow:hidden` + flex 居中），滚动只发生在 `.kh-modal-body`；
 *   · 头/底 `flex:0 0 auto`，**固定不随内容滚动**；
 *   · 同一实现挂 options / popup 两个页面，差别只有宽度档位（`size`）。
 *
 * 支持弹窗堆叠（如"弹窗内再确认"）：后开的一定在顶层，Esc/遮罩只作用于顶层。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;

  /** 打开中的弹窗栈（顶层 = 最后一个） */
  const stack = [];

  function top() { return stack.length ? stack[stack.length - 1] : null; }

  function closeTop() {
    const inst = top();
    if (inst) inst.close();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const inst = top();
    if (!inst) return;
    e.stopPropagation();
    // Esc：优先交给实例自己的钩子（例如胶囊小弹窗要先关掉自己）
    if (inst.onEsc && inst.onEsc() === true) return;
    inst.close();
  }, true);

  /**
   * @param {object} opts
   *   title      标题（字符串或节点）
   *   body       内容（节点，或返回节点的函数）
   *   footer     自定义底栏（给了就不生成默认的取消/保存）
   *   saveLabel  保存按钮文案
   *   size       'sm' | 'md' | 'lg'
   *   onSave     返回 false / Promise<false> 则**不关闭**（校验失败场景）
   *   onClose    关闭后回调（无论是保存还是取消）
   *   onEsc      返回 true 表示"我自己处理了 Esc"
   * @returns {object} 实例 { close, setBusy, el }
   */
  function open(opts) {
    const o = opts || {};
    const h = D().h;

    const bodyEl = h('div', { class: 'kh-modal-body' });
    const content = (typeof o.body === 'function') ? o.body() : o.body;
    if (content) bodyEl.appendChild(content);

    const footerEl = h('div', { class: 'kh-modal-foot' });
    const inst = {
      el: null, close, setBusy, onEsc: o.onEsc || null
    };

    if (o.footer) {
      footerEl.appendChild(o.footer);
    } else {
      const cancel = h('button', { class: 'kh-btn', type: 'button', text: o.cancelLabel || '取消' });
      const save = h('button', {
        class: 'kh-btn ' + (o.danger ? 'kh-btn-danger' : 'kh-btn-primary'), type: 'button',
        text: o.saveLabel || '保存'
      });
      cancel.addEventListener('click', () => close());
      save.addEventListener('click', async () => {
        if (!o.onSave) return close();
        setBusy(true);
        try {
          const r = await o.onSave();
          if (r === false) { setBusy(false); return; }   // 校验未过：保持打开
          close();
        } catch (err) {
          setBusy(false);
          D().toast('保存失败：' + ((err && err.message) || err), 'error');
        }
      });
      footerEl.appendChild(cancel);
      footerEl.appendChild(save);
      inst.saveBtn = save;
    }

    const headEl = h('div', { class: 'kh-modal-head' }, [
      h('div', { class: 'kh-modal-title', text: o.title == null ? '' : String(o.title) }),
      h('button', { class: 'kh-modal-x', type: 'button', title: '关闭', text: '×', on: { click: () => close() } })
    ]);

    /* `bare: true` = **只留内容**：去掉遮罩底色与弹窗自己的标题行。
     * 用在"独立编辑窗口"（popup/editor.html）里 —— 那个场景已经有系统标题栏显示标题，
     * 再叠一层深色遮罩 + 一层标题行就是三层框，观感很丑（用户实测："外面这一圈有点难看，
     * 不能去掉只留里面的内容么"）。Esc 关闭与底部按钮都照常可用。 */
    const bare = !!o.bare;
    const dialog = h('div', {
      class: 'kh-modal kh-modal-' + (o.size || 'md') + (bare ? ' is-bare' : ''),
      role: 'dialog', 'aria-modal': 'true'
    }, bare ? [bodyEl, footerEl] : [headEl, bodyEl, footerEl]);

    const mask = h('div', { class: 'kh-modal-mask' + (bare ? ' is-bare' : ''), 'data-kh-ext-ui': '1' }, [dialog]);
    if (o.maskClose !== false) {
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    }

    /* 挂载点：默认 document.body（选项页 / popup）。
     * 内容脚本里要弹同一个编辑器时传 `mount: shadowRoot` —— 这样 tokens 与组件样式
     * 都活在 Shadow DOM 内，既不与页面样式打架，也不会把 `--brand` 之类的通用变量**注入页面**。
     * 同时把挂载点交给 toast：否则提示会落在 shadow 外、拿不到组件样式。 */
    (o.mount || document.body).appendChild(mask);
    if (o.mount && D().setToastMount) D().setToastMount(o.mount);
    const rec = { close, setBusy, onEsc: inst.onEsc, mask, dialog };
    inst.el = dialog;
    inst.mask = mask;
    stack.push(rec);

    // 聚焦第一个可编辑控件（键盘用户不必自己 Tab）
    const first = bodyEl.querySelector('input:not([type=hidden]), textarea, select, button');
    if (first) setTimeout(() => { try { first.focus(); } catch (e) { /* 隐藏元素忽略 */ } }, 0);

    function setBusy(busy) {
      dialog.classList.toggle('kh-busy', !!busy);
      const btns = footerEl.querySelectorAll('button');
      for (const b of btns) b.disabled = !!busy;
    }

    function close() {
      const i = stack.findIndex(r => r.close === close);
      if (i < 0) return;
      stack.splice(i, 1);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (typeof o.onClose === 'function') { try { o.onClose(); } catch (e) { /* 回调异常不影响关闭 */ } }
    }

    return inst;
  }

  ui.Modal = {
    open,
    close: closeTop,
    closeAll() { while (stack.length) closeTop(); },
    isOpen: () => stack.length > 0,
    depth: () => stack.length
  };
})();
