/* ============================================================================
 * src/ui/components/data-table.js · 数据表格（排序 / 分页 50 / 整页全选）
 * ----------------------------------------------------------------------------
 * 覆盖矩阵第 17 项要求"筛选/排序/分页 50/批量栏/匹配规则独立列/胶囊弹窗"，
 * 其中**表格本体**抽成本组件；筛选栏与批量栏属于页面级（options.js），
 * 因为它们要跟"筛选结果"和"选中集合"联动，塞进表格反而要往外抛一堆回调。
 *
 * 交互约束（沿用旧版，不得回退）：
 *   · 每页 50 条 + 可直接跳页；
 *   · 表头复选框 = **只作用于本页**（旧版 `checkAllPage` 的语义，名字里就写了 Page），
 *     跨页累选靠逐行勾选；这样"全选"不会误删其它页的数据；
 *   · 翻页/排序/筛选**不丢选中**（选中集合按 id 存，不按行号）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;

  const PAGE_SIZE = 50;

  /**
   * @param {object} opts
   *   columns    [{ key, label, class, width, sortable, title, render(row), compare(a,b) }]
   *   rows       数据
   *   getRowId   (row) => id
   *   pageSize   默认 50
   *   emptyText  空态文案
   *   onSelectionChange (Set<id>) => void
   * @returns {object} { el, setRows, selected(), clearSelection, setSelected, page, refresh }
   */
  function create(opts) {
    const o = opts || {};
    const h = D().h;
    const pageSize = o.pageSize || PAGE_SIZE;

    let rows = (o.rows || []).slice();
    let sort = null;                    // { key, dir: 1 | -1 } ← 点表头的三态排序
    let filterSort = o.filterSort || null; // 筛选栏的排序（apply 是纯函数）——与表头排序互不干扰
    const selected = new Set();
    let page = 1;

    const thead = h('thead');
    const tbody = h('tbody');
    const table = h('table', { class: 'kh-table-grid' }, [thead, tbody]);

    const pagerInfo = h('span', { class: 'kh-pager-info' });
    const jump = h('input', { class: 'kh-input kh-jump', type: 'number', min: '1', title: '输入页码后回车跳转' });
    const btnFirst = h('button', { class: 'kh-mini-btn', type: 'button', text: '« 首页' });
    const btnPrev = h('button', { class: 'kh-mini-btn', type: 'button', text: '‹ 上一页' });
    const btnNext = h('button', { class: 'kh-mini-btn', type: 'button', text: '下一页 ›' });
    const btnLast = h('button', { class: 'kh-mini-btn', type: 'button', text: '末页 »' });
    const pager = h('div', { class: 'kh-pager' }, [pagerInfo, h('span', { class: 'kh-pager-sp' }), btnFirst, btnPrev, jump, btnNext, btnLast]);

    const el = h('div', { class: 'kh-data-table' }, [h('div', { class: 'kh-table-scroll' }, [table]), pager]);

    const getRowId = o.getRowId || ((r) => (r && r.id) || '');
    const pageCount = () => Math.max(1, Math.ceil(rows.length / pageSize));
    const pageRows = () => rows.slice((page - 1) * pageSize, page * pageSize);

    function fireSel() {
      if (typeof o.onSelectionChange === 'function') o.onSelectionChange(new Set(selected));
    }

    /* ---------------- 表头 ---------------- */

    function renderHead() {
      D().clear(thead);
      const tr = h('tr');
      const checkAll = h('input', { type: 'checkbox', title: '全选本页' });
      checkAll.addEventListener('change', () => {
        const pr = pageRows();
        if (checkAll.checked) pr.forEach(r => selected.add(getRowId(r)));
        else pr.forEach(r => selected.delete(getRowId(r)));
        renderBody();
        fireSel();
      });
      for (const col of o.columns) {
        if (col.key === '__check') {
          tr.appendChild(h('th', { class: col.class || 'col-check' }, [checkAll]));
          continue;
        }
        const th = h('th', { class: (col.class || '') + (col.sortable ? ' is-sortable' : ''), title: col.title || '' },
          [h('span', { text: col.label || '' })]);
        if (col.sortable) {
          th.appendChild(h('span', { class: 'kh-sort-mark', text: (sort && sort.key === col.key) ? (sort.dir > 0 ? '▲' : '▼') : '⇅' }));
          th.addEventListener('click', () => {
            if (sort && sort.key === col.key) sort = (sort.dir > 0) ? { key: col.key, dir: -1 } : null;
            else sort = { key: col.key, dir: 1 };
            render();
          });
        }
        if (col.width) th.style.width = col.width + 'px';
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      // 表头勾选框状态需与"本页是否全选"同步（不能只在点击时更新）
      const pr = pageRows();
      const picked = pr.filter(r => selected.has(getRowId(r))).length;
      checkAll.checked = pr.length > 0 && picked === pr.length;
      checkAll.indeterminate = picked > 0 && picked < pr.length;
    }

    /* ---------------- 表体 ---------------- */

    function renderBody() {
      D().clear(tbody);
      const list = pageRows();
      if (!list.length) {
        tbody.appendChild(h('tr', {}, [h('td', { class: 'kh-table-empty', colspan: String(o.columns.length), text: o.emptyText || '没有数据' })]));
        return;
      }
      for (const row of list) {
        const id = getRowId(row);
        const tr = h('tr', { 'data-id': id });
        if (selected.has(id)) tr.classList.add('is-selected');
        for (const col of o.columns) {
          if (col.key === '__check') {
            const cb = h('input', { type: 'checkbox', checked: selected.has(id) ? true : null });
            cb.addEventListener('change', () => {
              if (cb.checked) selected.add(id); else selected.delete(id);
              tr.classList.toggle('is-selected', cb.checked);
              renderHead();
              fireSel();
            });
            tr.appendChild(h('td', { class: col.class || 'col-check' }, [cb]));
            continue;
          }
          const td = h('td', { class: col.class || '' });
          const content = col.render ? col.render(row) : (row[col.key] == null ? '' : String(row[col.key]));
          if (content != null) td.appendChild(typeof content === 'string' ? document.createTextNode(content) : content);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    /* ---------------- 分页 ---------------- */

    function renderPager() {
      const pc = pageCount();
      if (page > pc) page = pc;
      pagerInfo.textContent = rows.length ? ('共 ' + rows.length + ' 条 · 第 ' + page + '/' + pc + ' 页') : '共 0 条';
      jump.value = String(page);
      jump.max = String(pc);
      btnFirst.disabled = btnPrev.disabled = page <= 1;
      btnNext.disabled = btnLast.disabled = page >= pc;
      jump.disabled = pc <= 1;
    }

    btnFirst.addEventListener('click', () => go(1));
    btnPrev.addEventListener('click', () => go(page - 1));
    btnNext.addEventListener('click', () => go(page + 1));
    btnLast.addEventListener('click', () => go(pageCount()));
    jump.addEventListener('change', () => go(parseInt(jump.value, 10) || 1));
    jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(parseInt(jump.value, 10) || 1); } });

    function go(p) {
      page = Math.min(Math.max(1, p || 1), pageCount());
      renderHead(); renderBody(); renderPager();
    }

    function render() {
      applySort();
      renderHead(); renderBody(); renderPager();
    }

    /**
     * 行序统一在这里定（**先筛选栏排序、后表头排序**）。
     * 分成两步而不是"筛选栏自己排好再塞进来"的原因：
     *   `setRows()` 不重置表头排序态，若靠外部预排，下一次任何重绘（勾选/翻页/表头去排序）
     *   都会被表头排序覆盖回去 —— 用户看到的就是"排序选择被悄悄改回"。
     * `Array.prototype.sort` 自 ES2019 起稳定，因此等值项保持调用方给的顺序。
     */
    function applySort() {
      if (filterSort && typeof filterSort.apply === 'function') {
        rows.sort((a, b) => filterSort.apply(a, b) || 0);
      }
      if (sort) {
        const col = o.columns.find(c => c.key === sort.key);
        const cmp = (col && col.compare) || ((a, b) => String(a[sort.key] == null ? '' : a[sort.key]).localeCompare(String(b[sort.key] == null ? '' : b[sort.key]), 'zh'));
        rows.sort((a, b) => cmp(a, b) * sort.dir);
      }
    }

    render();

    return {
      el,
      setRows(next) { rows = (next || []).slice(); page = 1; render(); },
      refresh: render,
      selected: () => new Set(selected),
      clearSelection() { selected.clear(); render(); fireSel(); },
      setSelected(ids) { selected.clear(); for (const id of ids || []) selected.add(id); render(); fireSel(); },
      /** 筛选栏排序：只换规则，不碰表头排序态（{ apply(a,b) } 为纯函数，字段差异由调用方决定） */
      setFilterSort(spec) { filterSort = spec || null; render(); },
      /** 本页行 id —— 批量栏「本页全选」与表头复选框必须用**同一份**"本页"定义，否则两处语义会漂 */
      pageIds() { return pageRows().map(getRowId); },
      get page() { return page; },
      get pageSize() { return pageSize; }
    };
  }

  ui.DataTable = { create, PAGE_SIZE };
})();
