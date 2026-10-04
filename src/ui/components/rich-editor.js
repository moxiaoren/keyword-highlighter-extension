/* ============================================================================
 * src/ui/components/rich-editor.js · 多行内容编辑 + Markdown 富文本（所见即所得）
 * ----------------------------------------------------------------------------
 * 契约单源（方案 §8.3）：多行内容在**四处**必须表现一致 ——
 *   ① 重要笔记面板的"笔记/抓取值"  ② 备注卡片  ③ 抓取表格单元格  ④ 设置页预览
 * 一致的含义（旧版踩过 v1.8.3 的坑，写进这里当契约）：
 *   · 真实换行必须保留：容器 `white-space: pre-line`；
 *   · HTML `<br>` 等价于一个 `\n`（内容脚本侧 cellValue 负责转换）；
 *   · `td` **一律** pre-line，标签列也不得改 `nowrap` —— 否则多行备注会被折叠；
 *   · 行内元素（span/font/a）产生的换行与 `<br>` 同等对待，不合并成一行。
 *
 * 两种形态：
 *   · 默认 = 多行 textarea + 预览（备注等纯文本字段，语法仍按 Markdown 渲染到页面）；
 *   · `wysiwyg: true` = 所见即所得编辑器（重要笔记）：图片/链接/加粗/斜体/表格直接在
 *     框内显示效果，存储仍是干净 Markdown（旧版 v1.8.16~v1.8.20 的完整对等移植）。
 *     —— 语法与安全规则单源在 src/platform/markdown.js，本组件只负责编辑交互。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;
  const MD = () => KH.Markdown;

  /** 只读渲染：与页面侧同契约（走 Markdown 单源，页面看到什么这里就是什么） */
  function render(text, cls) {
    const h = D().h;
    const box = h('div', { class: 'kh-rt ' + (cls || '') });
    const frag = MD().toFragment(text, document);
    box.appendChild(frag);
    return box;
  }

  /* ----------------------------------------------------------
   * 所见即所得编辑器（重要笔记）
   * -------------------------------------------------------- */

  /** contenteditable 里当前选区是否落在编辑器内；不在则把选区挪到编辑器末尾 */
  function ensureSelection(ed) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) return sel;
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    return sel;
  }

  function exec(cmd) {
    try { document.execCommand(cmd, false, null); } catch (e) { /* 老接口，失败静默 */ }
  }

  function wysiwyg(opts) {
    const o = opts || {};
    const h = D().h;
    const ed = h('div', {
      class: 'kh-input kh-rte',
      id: o.id || null,
      contenteditable: 'true',
      'data-placeholder': o.placeholder || '与页面显示一致：图片、加粗、表格、链接直接在框内显示；点图片或链接可修改、删除。'
    });
    // 图片在编辑器里的默认展示大小 = 命中时的缩略尺寸（旧版 v1.8.17 行为：所见即所得）
    const px = parseInt(o.imgSize, 10);
    if (px > 0) ed.style.setProperty('--kh-note-img-size', px + 'px');

    // 装载初始 Markdown
    if (o.value) ed.appendChild(MD().toFragment(String(o.value), document));

    /* ---- 工具栏 ----
     * 【位置】常驻在编辑框**上方**（大众习惯：工具在上、内容在下）。
     *   v2.1.0 之前它在编辑框下方，且按钮带文字（`🖼 图片` 59px、`🔗 链接` 63px、`▦ 表格` 59px、
     *   `✕ 清格式` 69px），6 个按钮共 324px，而这一列内容宽只有 245px —— 实测被挤成两行，
     *   观感很碎。现改为**图标按钮 + title 提示**、按钮间距 3px，整条 184px 单行放下。
     * 【顺序】按通用编辑器习惯：先行内格式（B / I），再插入（链接 / 图片 / 表格），
     *   破坏性的「清空」靠右独立放（靠 `margin-left:auto`），避免误点。
     * 【可达性】图标按钮一律带 `title` 与 `aria-label`，鼠标悬停即可看到中文说明。
     */
    const btn = (label, title, fn, extraCls) => {
      const b = h('button', {
        class: 'kh-mini-btn' + (extraCls ? ' ' + extraCls : ''),
        type: 'button', text: label, title: title, 'aria-label': title
      });
      b.addEventListener('mousedown', (e) => e.preventDefault());  // 防止点击按钮抢走编辑区选区
      b.addEventListener('click', () => { fn(b); sync(); });
      return b;
    };

    /** 找光标所在单元格（表格行列操作的靶心） */
    function curCell() {
      const sel = window.getSelection();
      let n = sel && sel.rangeCount ? sel.anchorNode : null;
      if (n && n.nodeType === 3) n = n.parentElement;
      while (n) {
        if (n.tagName === 'TD' || n.tagName === 'TH') return n;
        n = n.parentElement;
      }
      return null;
    }

    /* ---- 表格行列操作（只供浮动条调用；旧版 v1.8.x 交互：光标进表格才出现加减号） ---- */
    function rowAdd(td) {
      const tr = td.closest('tr');
      const nr = tr.cloneNode(false);
      Array.prototype.forEach.call(tr.cells, (c) => {
        const nc = document.createElement(c.tagName.toLowerCase());
        nc.innerHTML = '<br>';
        nr.appendChild(nc);
      });
      tr.after(nr);
    }
    function rowDel(td) {
      const tr = td.closest('tr');
      const tbl = tr.closest('table');
      if (tbl.rows.length <= 1) { tbl.remove(); return; }
      tr.remove();
    }
    function colAdd(td) {
      const tr = td.parentElement;
      const tbl = td.closest('table');
      const idx = Array.prototype.indexOf.call(tr.cells, td);
      tbl.querySelectorAll('tr').forEach((r) => {
        const ref = r.cells[idx];
        const nc = document.createElement((ref ? ref.tagName : 'td').toLowerCase());
        nc.innerHTML = '<br>';
        if (ref) ref.after(nc); else r.appendChild(nc);
      });
    }
    function colDel(td) {
      const tr = td.parentElement;
      const tbl = td.closest('table');
      const idx = Array.prototype.indexOf.call(tr.cells, td);
      tbl.querySelectorAll('tr').forEach((r) => { if (r.cells[idx]) r.deleteCell(idx); });
      if (!tbl.rows.length || !tbl.rows[0].cells.length) tbl.remove();
    }

    const tools = [];
    /* 行内格式 */
    tools.push(btn('B', '加粗（先选中文字再点）', () => { ed.focus(); ensureSelection(ed); exec('bold'); }, 'is-b'));
    tools.push(btn('I', '斜体（先选中文字再点）', () => { ed.focus(); ensureSelection(ed); exec('italic'); }, 'is-i'));
    tools.push(h('span', { class: 'kh-rt-sep' }));
    /* 插入 */
    tools.push(btn('🔗', '插入超链接（先选中文字则直接作为链接文字）', () => {
      ed.focus();
      const sel = ensureSelection(ed);
      let text = '';
      const hasSel = sel.rangeCount && ed.contains(sel.anchorNode) && sel.toString().trim();
      if (!hasSel) {
        const r0 = window.prompt('链接文字（可先选中一段文字再点此按钮，会直接用它）：', '');
        if (r0 === null) return;
        text = r0.trim();
      } else {
        text = sel.toString().trim();
      }
      const urlR = window.prompt('链接地址（如 https://example.com）：', '');
      if (urlR === null) return;
      const url = urlR.trim();
      if (!url) { D.toast('请输入链接地址', 'error'); return; }
      if (!/^(https?:|mailto:|tel:|ftp:)/i.test(url) && url !== '#') {
        D.toast('仅支持 http(s) / mailto / tel 等链接地址', 'error');
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text || url;
      if (hasSel) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(a);
        r.setStartAfter(a);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        ensureSelection(ed);
        const r = window.getSelection().getRangeAt(0);
        r.insertNode(a);
      }
    }));
    tools.push(btn('🖼', '插入图片（http(s) 或 data: 图片地址）', () => {
      const url = (window.prompt('输入图片地址（https:// 或 data: 图片）：') || '').trim();
      if (!url) return;
      if (!KH.Markdown.IMG_OK.test(url)) { D.toast('仅支持 http(s) 或 data: 图片地址', 'error'); return; }
      ed.focus();
      ensureSelection(ed);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      const sel = window.getSelection();
      if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(img);
        r.setStartAfter(img);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        ed.appendChild(img);
      }
    }));
    tools.push(btn('▦', '插入表格（所见即所得）', () => {
      const rowsInput = window.prompt('表格行数（含表头）：', '2');
      if (rowsInput === null) return;
      const colsInput = window.prompt('表格列数：', '3');
      if (colsInput === null) return;
      const rows = Math.min(Math.max(parseInt(rowsInput, 10) || 2, 1), 20);
      const cols = Math.min(Math.max(parseInt(colsInput, 10) || 3, 1), 10);
      const tbl = document.createElement('table');
      tbl.className = 'kh-table';
      for (let r = 0; r < rows; r++) {
        const tr = tbl.insertRow(-1);
        for (let c = 0; c < cols; c++) {
          const cell = tr.insertCell(-1);
          cell.textContent = r === 0 ? '表头' : '内容';
        }
      }
      ed.focus();
      ensureSelection(ed);
      const sel = window.getSelection();
      if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(tbl);
        const tail = document.createElement('div');
        tail.appendChild(document.createElement('br'));
        r.setStartAfter(tbl);
        r.insertNode(tail);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        ed.appendChild(tbl);
      }
    }));

    /* ---- 表格浮动操作条：光标点进表格才出现（行±/列±/删表），离开即隐藏 ----
     * 旧版 v1.8.x 就是这个交互：工具栏不常驻表格按钮，加减号随选中浮现。
     * 定位：相对 wrap（position:relative），贴在表格右上角；表格贴顶时改到下方。
     * ed 内部滚动（max-height 320）与弹窗滚动都会改变表格视口位置，所以滚动时
     * 要重算（capture 捕获弹窗滚动容器的 scroll）。
     */
    const tblBar = h('div', { class: 'kh-tbl-float', hidden: '' });
    const tblBtn = (label, title, fn) => {
      const b = h('button', { class: 'kh-mini-btn', type: 'button', text: label, title });
      b.addEventListener('mousedown', (e) => e.preventDefault());  // 不抢编辑区选区
      b.addEventListener('click', () => {
        ed.focus();
        const td = curCell();
        if (!td) { tblBar.hidden = true; return; }
        fn(td);
        sync();
      });
      return b;
    };
    tblBar.appendChild(tblBtn('行+', '在光标行下方插入一行', rowAdd));
    tblBar.appendChild(tblBtn('行−', '删除光标所在行（只剩一行时删除整个表格）', rowDel));
    tblBar.appendChild(tblBtn('列+', '在光标列右侧插入一列', colAdd));
    tblBar.appendChild(tblBtn('列−', '删除光标所在列（只剩一列时删除整个表格）', colDel));
    tblBar.appendChild(tblBtn('✕', '删除整个表格', (td) => { td.closest('table').remove(); }));

    function hideTblBar() { tblBar.hidden = true; }

    function placeTblBar() {
      const td = curCell();
      const tbl = td && td.closest('table');
      if (!tbl || !ed.contains(tbl)) { hideTblBar(); return; }
      tblBar.hidden = false;                       // 先显示再量尺寸，hidden 时宽高为 0
      const wr = wrap.getBoundingClientRect();
      const trc = tbl.getBoundingClientRect();
      const bw = tblBar.offsetWidth, bh = tblBar.offsetHeight;
      let top = trc.top - wr.top - bh - 2;
      if (top < 0) top = trc.bottom - wr.top + 2;
      let left = trc.right - wr.left - bw;
      left = Math.max(0, Math.min(left, wr.width - bw));
      tblBar.style.top = Math.round(top) + 'px';
      tblBar.style.left = Math.round(left) + 'px';
    }

    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) { hideTblBar(); return; }
      placeTblBar();
    });
    ed.addEventListener('scroll', () => { if (!tblBar.hidden) placeTblBar(); });
    /* capture：弹窗 body 等外层容器滚动时也要跟着挪 */
    document.addEventListener('scroll', () => { if (!tblBar.hidden) placeTblBar(); }, true);
    document.addEventListener('mousedown', (e) => {
      if (!tblBar.hidden && !wrap.contains(e.target)) hideTblBar();
    });
    /* 破坏性操作靠右独立放（`margin-left:auto`），与编辑动作隔开、避免误点。
     * 用 🗑 而不是 ✕ —— ✕ 在工具栏右端容易被读成"关闭这一节"。 */
    const clearBtn = btn('🗑', '清空笔记（会二次确认）', () => {
      if (!window.confirm('清空当前笔记全部内容？')) return;
      ed.textContent = '';
    }, 'kh-rt-clear');

    /* ---- 点图片 / 链接 → 修改或删除（旧版 v1.8.20 交互） ---- */
    ed.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG') {
        e.preventDefault();
        const cur = t.getAttribute('src') || '';
        const next = (window.prompt('修改图片地址（清空 = 删除该图片）：', cur) || '').trim();
        if (next === null) return;
        if (!next) { t.remove(); return; }
        if (!KH.Markdown.IMG_OK.test(next)) { D.toast('仅支持 http(s) 或 data: 图片地址', 'error'); return; }
        t.src = next;
        sync();
        return;
      }
      const a = t && t.closest ? t.closest('a') : null;
      if (a && ed.contains(a)) {
        e.preventDefault();
        const curText = a.textContent || '';
        const nText = window.prompt('修改链接文字（清空 = 删除该超链接，文字会保留）', curText);
        if (nText === null) return;
        const text = nText.trim();
        if (!text) {
          const frag = document.createDocumentFragment();
          while (a.firstChild) frag.appendChild(a.firstChild);
          a.replaceWith(frag);
          sync();
          return;
        }
        const nHref = window.prompt('链接地址（https://…）', a.getAttribute('href') || '');
        if (nHref === null) return;
        const href = nHref.trim();
        if (!href || !/^(https?:|mailto:|tel:|ftp:)/i.test(href)) {
          if (!href) {
            const frag = document.createDocumentFragment();
            while (a.firstChild) frag.appendChild(a.firstChild);
            a.replaceWith(frag);
            sync();
            return;
          }
          D.toast('仅支持 http(s) / mailto / tel 等链接地址', 'error');
          return;
        }
        a.textContent = text;
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        sync();
      }
    });

    /* ---- 粘贴自动清成纯文本（旧版行为：粘贴不带外来样式/标签） ---- */
    ed.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text == null) return;
      document.execCommand('insertText', false, text);
    });

    const bar = h('div', { class: 'kh-rt-toolbar' }, tools.concat([clearBtn]));

    function sync() {
      if (typeof o.onChange === 'function') o.onChange(getValue());
    }

    function getValue() { return KH.Markdown.fromEditor(ed); }
    function setValue(v) {
      ed.textContent = '';
      const md = v == null ? '' : String(v);
      if (md.trim()) ed.appendChild(KH.Markdown.toFragment(md, document));
      sync();
    }

    /* wrap 是浮动条的定位基准（position:relative），同时包住 ed 与 tblBar
     * 【顺序】工具栏在**上**、编辑框在**下**（大众习惯）。
     * 【不再有提示行】原先那句「点框内图片/链接可改可删；表格内可加减行列」已按用户要求删掉 ——
     * 图片/链接点一下就有提示、表格浮条自己会冒出来，不需要常驻一行说明占高度。 */
    const wrap = h('div', { class: 'kh-rte-wrap' }, [ed, tblBar]);
    const el = h('div', { class: 'kh-rt-editor kh-rt-wysiwyg' }, [bar, wrap]);
    el.getValue = getValue;
    el.setValue = setValue;
    el.focus = () => ed.focus();
    return el;
  }

  /* ----------------------------------------------------------
   * 纯文本多行（备注等；渲染契约与页面一致，走 Markdown 单源）
   * -------------------------------------------------------- */

  function plain(opts) {
    const o = opts || {};
    const h = D().h;

    const ta = h('textarea', {
      class: 'kh-input kh-textarea',
      id: o.id || null,
      rows: String(o.rows || 2),
      placeholder: o.placeholder || '支持 Markdown：**加粗**、*斜体*、[文字](网址)、![说明](图片网址)、| a | b | 表格；多行换行原样保留'
    });
    ta.value = o.value == null ? '' : String(o.value);

    const preview = render('', 'kh-rt-preview');
    const box = h('div', { class: 'kh-rt-preview-box' }, [
      h('div', { class: 'kh-rule-hint', text: '预览（与页面实际效果一致）' }),
      preview
    ]);
    box.hidden = true;

    const toggle = h('button', { class: 'kh-mini-btn', type: 'button', text: '预览' });
    toggle.addEventListener('click', () => {
      const show = box.hidden;
      if (show) {
        preview.textContent = '';
        preview.appendChild(MD().toFragment(ta.value, document));
      }
      box.hidden = !show;
      toggle.classList.toggle('is-on', show);
    });

    const count = h('span', { class: 'kh-rt-count' });

    const tools = h('div', { class: 'kh-rt-tools' }, [toggle, count]);

    function fire() {
      count.textContent = ta.value.length ? ta.value.length + ' 字' : '';
      if (typeof o.onChange === 'function') o.onChange(ta.value);
    }
    ta.addEventListener('input', fire);
    fire();

    /* 工具行**不塞进编辑器自己的竖排里**：它由调用方放到字段标题行右侧
     * （弹窗里一个「预览」按钮独占一行太浪费）。`toolsRow` 是给调用方用的出口。 */
    const el = h('div', { class: 'kh-rt-editor' }, [ta, box]);
    el.toolsRow = tools;
    el.getValue = () => ta.value;
    el.setValue = (v) => { ta.value = v == null ? '' : String(v); fire(); };
    el.focus = () => ta.focus();
    return el;
  }

  /**
   * 可编辑多行控件。
   * @param {object} opts { value, onChange, rows, placeholder, wysiwyg, imgSize }
   * @returns {HTMLElement} 带 getValue / setValue / focus
   */
  function create(opts) {
    return (opts && opts.wysiwyg) ? wysiwyg(opts) : plain(opts);
  }

  ui.RichText = { render };
  ui.RichEditor = { create, render };
})();
