/**
 * Options 页面脚本
 */
(() => {
  'use strict';

  // 当前编辑状态
  let editingKeywordId = null;
  let editingKeyword = null;
  let editingGroupId = null;
  let editingSiteRuleId = null;
  let allGroups = []; // 分组缓存（用于自动应用分组颜色）

  // DOM 引用
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ========== 导航 ==========
  function initNavigation() {
    $$('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const section = item.dataset.section;
        switchSection(section);
      });
    });
  }

  function switchSection(section) {
    $$('.nav-item').forEach(i => i.classList.remove('active'));
    $$('.section').forEach(s => s.classList.remove('active'));
    
    const navItem = document.querySelector(`.nav-item[data-section="${section}"]`);
    const sectionEl = document.getElementById(`section-${section}`);
    
    if (navItem) navItem.classList.add('active');
    if (sectionEl) sectionEl.classList.add('active');

    // 加载对应数据
    switch (section) {
      case 'keywords': loadKeywords(); break;
      case 'groups': loadGroups(); break;
      case 'styles': loadStyles(); break;
      case 'note-card': loadNoteCardStyles(); break;
      case 'sites': loadSiteRules(); break;
    }
  }

  // ========== 关键词管理 ==========
  let kwState = {
    page: 1,
    pageSize: 50,
    selected: new Set()
  };
  let kwGroups = [];

  async function loadKeywords() {
    const data = await Storage.getAll();
    const keywords = data.keywords || [];
    const groups = data.groups || [];
    kwGroups = groups;
    allGroups = groups;

    // 更新分组筛选（保留用户当前选中的分组，避免重建后被重置）
    const prevGroupFilter = $('#groupFilter').value;
    const groupFilter = $('#groupFilter');
    groupFilter.innerHTML = '<option value="">全部分组</option><option value="__none__">未分组</option>';
    groups.forEach(g => {
      groupFilter.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)}</option>`;
    });
    if (prevGroupFilter && (prevGroupFilter === '__none__' || groups.some(g => g.id === prevGroupFilter))) {
      groupFilter.value = prevGroupFilter;
    }

    // 渲染列表
    renderKeywordList(keywords, groups, data.highlightStyle || Storage.defaults.highlightStyle);
  }

  function getKeywordFilters() {
    return {
      search: ($('#keywordSearch')?.value || '').toLowerCase().trim(),
      group: $('#groupFilter')?.value || '',
      status: $('#statusFilter')?.value || 'all',
      regex: $('#regexFilter')?.value || 'all',
      sort: $('#sortFilter')?.value || 'updated_desc'
    };
  }

  function applyKeywordFiltersAndSort(keywords) {
    const f = getKeywordFilters();
    let list = keywords.filter(k => {
      if (f.search && !(k.text.toLowerCase().includes(f.search) || (k.note || '').toLowerCase().includes(f.search))) return false;
      if (f.group === '__none__') {
        if (k.groupId) return false;
      } else if (f.group && k.groupId !== f.group) {
        return false;
      }
      if (f.status === 'enabled' && !k.enabled) return false;
      if (f.status === 'disabled' && k.enabled) return false;
      if (f.regex === 'plain' && k.useRegex) return false;
      if (f.regex === 'regex' && !k.useRegex) return false;
      return true;
    });

    const sorters = {
      'updated_desc': (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      'created_desc': (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      'name_asc': (a, b) => a.text.localeCompare(b.text, 'zh'),
      'name_desc': (a, b) => b.text.localeCompare(a.text, 'zh')
    };
    list.sort(sorters[f.sort] || sorters['updated_desc']);
    return list;
  }

  function renderKeywordList(keywords, groups, highlightStyle) {
    const filtered = applyKeywordFiltersAndSort(keywords);
    kwState.filtered = filtered;

    // 清理已不存在的选中项
    const idSet = new Set(keywords.map(k => k.id));
    kwState.selected.forEach(id => { if (!idSet.has(id)) kwState.selected.delete(id); });

    // 总数
    $('#keywordTotalCount').textContent = `(${filtered.length}/${keywords.length})`;

    // 分页边界
    const totalPages = Math.max(1, Math.ceil(filtered.length / kwState.pageSize));
    if (kwState.page > totalPages) kwState.page = totalPages;

    const table = $('#keywordTable');
    const body = $('#keywordTableBody');
    const emptyEl = $('#keywordEmpty');

    if (filtered.length === 0) {
      table.style.display = 'none';
      emptyEl.style.display = 'block';
      $('#keywordEmptyText').textContent = keywords.length === 0 ? '还没有添加关键词' : '没有匹配的关键词';
      $('#btnEmptyAdd').style.display = keywords.length === 0 ? 'inline-flex' : 'none';
      $('#pagination').innerHTML = '';
      $('#bulkSelectedCount').textContent = '已选 0 项';
      document.querySelectorAll('[data-bulk]').forEach(b => { b.disabled = true; });
      return;
    }

    table.style.display = 'table';
    emptyEl.style.display = 'none';

    const start = (kwState.page - 1) * kwState.pageSize;
    const pageItems = filtered.slice(start, start + kwState.pageSize);
    const groupMap = {};
    groups.forEach(g => { groupMap[g.id] = g.name; });
    const groupById = {};
    groups.forEach(g => { groupById[g.id] = g; });

    body.innerHTML = pageItems.map(kw => {
      const isSel = kwState.selected.has(kw.id);
      const ruleBadges = [];
      if (kw.useRegex) ruleBadges.push('<span class="badge regex">正则</span>');
      if (kw.caseSensitive) ruleBadges.push('<span class="badge">大小写</span>');
      if (kw.wholeWord) ruleBadges.push('<span class="badge">全词</span>');
      const groupName = kw.groupId && groupMap[kw.groupId]
        ? escapeHtml(groupMap[kw.groupId])
        : '<span style="color:#bbb">—</span>';
      // 重要标识：自身重要 或 所属分组重要
      const grp = kw.groupId ? groupById[kw.groupId] : null;
      const isImportant = !!(kw.important || (grp && grp.important));
      let impBadge = '';
      if (isImportant) {
        let impTitle = '重要';   
        if (kw.importantNote) impTitle = '重要笔记：' + kw.importantNote.slice(0, 120);
        else if (grp && grp.important) impTitle = '所属分组“' + (groupMap[kw.groupId] || '') + '”为重要';
        impBadge = `<span class="imp-badge" title="${escapeHtml(impTitle)}">📌</span>`;
      }
      const noteHtml = kw.note
        ? `<span class="kw-col-note" title="${escapeHtml(kw.note)}">${escapeHtml(kw.note)}</span>`
        : '<span style="color:#ddd">—</span>';
      // 标题关键词（左格）——单元格组合翻转 v1.8.3
      const cellMode = kw.cellVerifyMatchMode === 'exact';
      const cellHtml = (kw.cellVerifyEnabled && kw.cellVerify)
        ? `<span class="cell-val" title="标题关键词(左格)：${escapeHtml(kw.cellVerify)}（右格核心${cellMode ? '整格相等' : '包含'}匹配）">${escapeHtml(kw.cellVerify)}</span><span class="badge ${cellMode ? 'cell-exact' : 'cell-include'}">${cellMode ? '全词' : '包含'}</span>`
        : '<span style="color:#ddd">—</span>';
      // 重要笔记（自身优先，其次分组统一笔记）
      let impNoteHtml = '<span style="color:#ddd">—</span>';
      if (kw.importantNote) {
        impNoteHtml = `<span class="impnote-val" title="${escapeHtml(kw.importantNote)}">📌 ${escapeHtml(kw.importantNote)}</span>`;
      } else if (grp && grp.important && grp.importantNote) {
        impNoteHtml = `<span class="impnote-val grp" title="来自分组“${escapeHtml(groupMap[kw.groupId] || '')}”：${escapeHtml(grp.importantNote)}">📌 ${escapeHtml(grp.importantNote)}</span>`;
      } else if (isImportant) {
        impNoteHtml = '<span class="impnote-val">📌 重要（未填笔记）</span>';
      }
      // 高亮颜色（关键词自身 > 分组 > 全局默认）
      const style = highlightStyle || {};
      const bg = kw.bgColor || (grp && grp.bgColor) || style.defaultBgColor || '#ffff00';
      const tc = kw.textColor || (grp && grp.textColor) || style.defaultTextColor || '#000000';
      const colSrc = kw.bgColor ? '来自关键词' : (grp && grp.bgColor) ? '来自分组' : '全局默认';
      const colorHtml = `<span class="color-swatch" style="background:${escapeHtml(bg)};color:${escapeHtml(tc)};" title="背景 ${bg} / 文字 ${tc}（${colSrc}）">字</span>`;
      return `
        <tr class="${isSel ? 'selected' : ''}" data-id="${kw.id}">
          <td class="col-check"><input type="checkbox" class="row-check" data-id="${kw.id}" ${isSel ? 'checked' : ''}></td>
          <td class="col-kw"><span class="kw-cell"><span class="kw-col-name ${kw.enabled ? '' : 'disabled'}" title="${escapeHtml(kw.text)}">${escapeHtml(kw.text)}</span>${impBadge}</span></td>
          <td class="col-cell">${cellHtml}</td>
          <td class="col-impnote">${impNoteHtml}</td>
          <td class="col-color">${colorHtml}</td>
          <td class="col-group">📁 ${groupName}</td>
          <td class="col-note">${noteHtml}</td>
          <td class="col-rule">${ruleBadges.length ? ruleBadges.join('') : '<span style="color:#ccc">普通</span>'}</td>
          <td class="col-status"><span class="status-pill status-toggle ${kw.enabled ? 'enabled' : 'disabled'}" data-action="toggle" data-id="${kw.id}" title="点击切换启用/禁用">${kw.enabled ? '启用' : '禁用'}</span></td>
          <td class="col-actions">
            <button class="btn-icon" data-action="edit" data-id="${kw.id}" title="编辑">✏️</button>
            <button class="btn-icon" data-action="delete" data-id="${kw.id}" title="删除">🗑️</button>
          </td>
        </tr>
      `;
    }).join('');

    // 行内操作
    body.querySelectorAll('[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await Storage.toggleKeyword(btn.dataset.id);
        loadKeywords();
        notifyContentRefresh();
      });
    });
    body.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kw = keywords.find(k => k.id === btn.dataset.id);
        if (kw) showKeywordModal(kw);
      });
    });
    body.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('确定要删除此关键词吗？此操作不可撤销。')) {
          await Storage.deleteKeyword(btn.dataset.id);
          kwState.selected.delete(btn.dataset.id);
          loadKeywords();
          notifyContentRefresh();
        }
      });
    });

    // 行勾选
    body.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) kwState.selected.add(cb.dataset.id);
        else kwState.selected.delete(cb.dataset.id);
        refreshSelectionUI(body);
      });
    });

    refreshSelectionUI(body);
    renderPagination(totalPages);
  }

  // 更新勾选相关 UI（选中行高亮 + 批量操作按钮状态）
  function refreshSelectionUI(body) {
    if (body) {
      body.querySelectorAll('tr').forEach(tr => {
        tr.classList.toggle('selected', kwState.selected.has(tr.dataset.id));
      });
    }
    const count = kwState.selected.size;
    $('#bulkSelectedCount').textContent = `已选 ${count} 项`;
    const hasSelection = count > 0;
    document.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.disabled = !hasSelection;
    });
  }

  // 分页控件
  function renderPagination(totalPages) {
    const box = $('#pagination');
    if (totalPages <= 1) { box.innerHTML = ''; return; }

    const page = kwState.page;
    let html = `<button class="page-btn" data-page="1" ${page === 1 ? 'disabled' : ''}>«</button>`;
    html += `<button class="page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>`;
    let startP = Math.max(1, page - 3);
    let endP = Math.min(totalPages, startP + 6);
    startP = Math.max(1, endP - 6);
    for (let p = startP; p <= endP; p++) {
      html += `<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
    html += `<button class="page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>›</button>`;
    html += `<button class="page-btn" data-page="${totalPages}" ${page === totalPages ? 'disabled' : ''}>»</button>`;
    html += `<span class="page-info">第 ${page}/${totalPages} 页 · 每页 ${kwState.pageSize} 条</span>`;

    box.innerHTML = html;
    box.querySelectorAll('.page-btn:not(:disabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        kwState.page = parseInt(btn.dataset.page);
        loadKeywords();
      });
    });
  }

  // ===== 批量操作 =====
  async function bulkSetEnabled(enabled) {
    if (kwState.selected.size === 0) return;
    const keywords = await Storage.getKeywords();
    keywords.forEach(k => {
      if (kwState.selected.has(k.id)) { k.enabled = enabled; k.updatedAt = Date.now(); }
    });
    await Storage.set({ keywords });
    loadKeywords();
    notifyContentRefresh();
  }

  async function bulkMoveGroup() {
    if (kwState.selected.size === 0) return;
    const groups = await Storage.getGroups();
    // 用输入框选择目标分组：输入分组名，或留空表示移除分组
    const nameList = groups.map(g => g.name).join('、') || '（无现有分组）';
    const input = prompt(
      `将选中的 ${kwState.selected.size} 个关键词移动至哪个分组？\n现有分组：${nameList}\n\n（输入分组名，或输入 0 移除其分组）`
    );
    if (input === null) return;
    const targetName = input.trim();

    let targetId = '';
    if (targetName && targetName !== '0') {
      const g = groups.find(x => x.name === targetName);
      if (!g) {
        alert('找不到该分组，请使用精确的分组名称。');
        return;
      }
      targetId = g.id;
    }

    const keywords = await Storage.getKeywords();
    keywords.forEach(k => {
      if (kwState.selected.has(k.id)) {
        k.groupId = targetId;
        // 加入分组后自动使用分组颜色
        const g = kwGroups.find(x => x.id === targetId);
        if (g && g.bgColor) {
          k.bgColor = g.bgColor;
          k.textColor = g.textColor || '';
        }
        k.updatedAt = Date.now();
      }
    });
    await Storage.set({ keywords });
    loadKeywords();
    notifyContentRefresh();
  }

  async function bulkDelete() {
    const count = kwState.selected.size;
    if (count === 0) return;
    if (!confirm(`确定要删除选中的 ${count} 个关键词吗？此操作不可撤销。`)) return;
    if (!confirm(`再次确认：真的要删除这 ${count} 个关键词吗？`)) return;

    const keywords = await Storage.getKeywords();
    const newKeywords = keywords.filter(k => !kwState.selected.has(k.id));
    await Storage.set({ keywords: newKeywords });
    kwState.selected.clear();
    loadKeywords();
    notifyContentRefresh();
  }

  function bulkClear() {
    kwState.selected.clear();
    loadKeywords();
  }

  // 帮助与隐私：悬浮目录（列出当前激活 tab 面板内的 h4 小节，点击平滑跳转）
  function buildHelpToc() {
    const toc = $('#helpToc');
    const linksBox = $('#helpTocLinks');
    const content = $('#section-help .help-content');
    if (!toc || !linksBox || !content) return;
    const panels = content.querySelector('.help-tab-panels');
    const tabs = content.querySelectorAll('.help-tab');
    if (!panels || !tabs.length) { toc.style.display = 'none'; return; }

    function render(idx) {
      linksBox.innerHTML = '';
      const panel = panels.children[idx];
      if (!panel) return;
      const h4s = panel.querySelectorAll('h4');
      if (h4s.length <= 1) { toc.style.display = 'none'; return; }
      toc.style.display = '';
      h4s.forEach((h4, i) => {
        if (!h4.id) h4.id = 'help-h4-' + idx + '-' + i;
        const a = document.createElement('a');
        a.href = '#' + h4.id;
        a.textContent = h4.textContent.trim();
        a.addEventListener('click', (e) => {
          e.preventDefault();
          h4.scrollIntoView({ behavior: 'smooth', block: 'start' });
          linksBox.querySelectorAll('a').forEach(x => x.classList.remove('active'));
          a.classList.add('active');
        });
        linksBox.appendChild(a);
      });
    }

    const activeIdx = Array.from(tabs).findIndex(t => t.classList.contains('active'));
    render(activeIdx >= 0 ? activeIdx : 0);
    tabs.forEach((t, i) => t.addEventListener('click', () => render(i)));
  }

  // 关键词表格：列宽拖拽调整（colgroup + 表头拖拽手柄）
  function initTableResize() {
    const table = $('#keywordTable');
    if (!table || table.dataset.resized) return;
    table.dataset.resized = '1';
    const defs = [
      { w: 34 }, { w: 20, pct: 1 }, { w: 104 }, { w: 17, pct: 1 }, { w: 56 },
      { w: 102 }, { w: 16, pct: 1 }, { w: 96 }, { w: 62 }, { w: 92 }
    ];
    const cg = document.createElement('colgroup');
    defs.forEach(d => {
      const c = document.createElement('col');
      c.style.width = (d.pct ? d.w + '%' : d.w + 'px');
      cg.appendChild(c);
    });
    table.insertBefore(cg, table.firstChild);

    const ths = table.querySelectorAll('thead th');
    ths.forEach((th, i) => {
      const col = cg.children[i];
      const rz = document.createElement('div');
      rz.className = 'th-resizer';
      rz.title = '拖动调整列宽';
      th.appendChild(rz);
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!col) return;
        const startX = e.clientX;
        const startW = col.offsetWidth;
        rz.classList.add('resizing');
        document.body.style.userSelect = 'none';
        function onMove(ev) {
          const nw = Math.max(40, startW + (ev.clientX - startX));
          col.style.width = nw + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          rz.classList.remove('resizing');
          document.body.style.userSelect = '';
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // 批量设置 备注 / 重要笔记
  function bulkEditNote() {
    if (kwState.selected.size === 0) return;
    $('#bulkNoteTitle').textContent = `批量设置备注 / 重要笔记（${kwState.selected.size} 项）`;
    $('#bulkNoteValue').value = '';
    $('#bulkImpNoteValue').value = '';
    $('#bulkNoteClear').checked = false;
    $('#bulkImpNoteClear').checked = false;
    $('#bulkImpNoteMark').checked = true;
    $('#bulkNoteResult').textContent = '';
    $('#bulkNoteModal').style.display = 'flex';
  }
  function closeBulkNote() {
    $('#bulkNoteModal').style.display = 'none';
  }
  async function saveBulkNote() {
    if (kwState.selected.size === 0) { closeBulkNote(); return; }
    const noteText = $('#bulkNoteValue').value.trim();
    const impText = $('#bulkImpNoteValue').value.trim();
    const clearNote = $('#bulkNoteClear').checked;
    const clearImp = $('#bulkImpNoteClear').checked;
    const markImp = $('#bulkImpNoteMark').checked;
    if (!noteText && !impText && !clearNote && !clearImp) {
      $('#bulkNoteResult').textContent = '没有要应用的内容';
      return;
    }

    const keywords = await Storage.getKeywords();
    let changed = 0;
    keywords.forEach(k => {
      if (!kwState.selected.has(k.id)) return;
      let ch = false;
      if (clearNote) { if (k.note) { k.note = ''; ch = true; } }
      else if (noteText) { k.note = noteText; ch = true; }
      if (clearImp) { if (k.importantNote) { k.importantNote = ''; ch = true; } }
      else if (impText) { k.importantNote = impText; if (markImp) k.important = true; ch = true; }
      if (ch) { k.updatedAt = Date.now(); changed++; }
    });
    if (changed > 0) {
      await Storage.set({ keywords });
      loadKeywords();
      notifyContentRefresh();
    }
    closeBulkNote();
  }

  // 根据勾选状态显示/隐藏 重要笔记输入（减少弹窗杂乱；单元格期望值常显，无需切换）
  function toggleKwSections() {
    const nw = $('#importantNoteWrap');
    if (nw) nw.style.display = $('#editKwImportant').checked ? 'block' : 'none';
    // v1.8.16 勾选/取消「重要」联动展开/收起对应折叠区（方便所见即所得编辑）
    const impSec = $('#kwImportantSection');
    if (impSec) impSec.classList.toggle('closed', !$('#editKwImportant').checked);
  }

  // ========== 重要笔记富文本编辑（v1.8.16，所见即所得） ==========
  // 富文本笔记编辑器的“当前活动实例”：关键词编辑 / 分组编辑共用同一套所见即所得命令，
  // 打开哪个弹窗就把 curNoteEd 指向哪个编辑器（两个弹窗不会同时打开）。默认回退到关键词编辑器。
  let curNoteEd = null;
  function kwe() { return curNoteEd || $('#editKwImportantNote'); }

  // markdown → 编辑区 HTML（打开弹窗/加载已有内容）
  function setNoteEditorHTML(md) {
    const ed = kwe();
    if (!ed) return;
    ed.innerHTML = (md && String(md).trim()) ? Utils.sanitizeHTML(md) : '';
  }

  // 编辑区 HTML → markdown（保存时序列化，只认白名单结构，其余按纯文本）
  function mdFromNoteEditor() {
    const ed = kwe();
    if (!ed) return '';
    const parts = [];
    ed.childNodes.forEach(c => noteNodeToMD(c, parts));
    let md = parts.join('');
    md = md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n +/g, '\n').trim();
    return md;
  }

  function noteNodeToMD(node, out) {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const t = node.tagName.toLowerCase();
    const kids = Array.from(node.childNodes);
    switch (t) {
      case 'br': out.push('\n'); return;
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        out.push('![' + alt + '](' + src + ')');
        return;
      }
      case 'b': case 'strong': out.push('**'); kids.forEach(c => noteNodeToMD(c, out)); out.push('**'); return;
      case 'i': case 'em': out.push('*'); kids.forEach(c => noteNodeToMD(c, out)); out.push('*'); return;
      case 'a': {
        const href = node.getAttribute('href') || '';
        // v1.8.20: 链接文字就是网址本身（纯 URL 自动转成的链接）→ 保留纯网址，不再包成 [url](url) 弄脏笔记
        if (href && kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE && kids[0].textContent === href) {
          out.push(href);
          return;
        }
        out.push('['); kids.forEach(c => noteNodeToMD(c, out)); out.push('](' + href + ')');
        return;
      }
      case 'table': out.push('\n' + noteTableToMD(node) + '\n'); return;
      case 'p': case 'div': out.push('\n'); kids.forEach(c => noteNodeToMD(c, out)); out.push('\n'); return;
      default: kids.forEach(c => noteNodeToMD(c, out));
    }
  }

  function noteTableToMD(tbl) {
    const rows = [];
    tbl.querySelectorAll('tr').forEach(tr => {
      const cells = Array.from(tr.children).map(td => {
        let s = '';
        td.childNodes.forEach(c => {
          if (c.nodeType === Node.TEXT_NODE) s += c.textContent;
          else if (c.nodeType === Node.ELEMENT_NODE) {
            const ct = c.tagName.toLowerCase();
            if (ct === 'img') s += '![' + (c.getAttribute('alt') || '') + '](' + (c.getAttribute('src') || '') + ')';
            else if (ct === 'a') { // v1.8.20 表格单元格内链接序列化回 [文字](网址)
              const h = c.getAttribute('href') || '';
              const txt = c.textContent || '';
              if (h && txt === h) s += h; // 纯网址链接保留纯网址（与段落处理一致）
              else s += '[' + txt + '](' + h + ')';
            }
            else if (ct === 'br') s += ' ';
            else s += c.textContent;
          }
        });
        return s.trim();
      });
      rows.push(cells.join(' | '));
    });
    if (rows.length) {
      const isSep = rows.length > 1 && /^:?-+\s*\|/.test(rows[1]);
      if (!isSep) rows.splice(1, 0, rows[0].split('|').map(() => '---').join(' | '));
    }
    return rows.map(r => '| ' + r + ' |').join('\n');
  }

  // 在光标处插入图片
  function insertNoteImage() {
    const ed = kwe();
    if (!ed) return;
    const url = (window.prompt('输入图片地址（https:// 或 data: 图片）：') || '').trim();
    if (!url) return;
    if (!/^(https?:\/\/|data:image\/)/i.test(url)) { alert('仅支持 http(s) 或 data: 图片地址'); return; }
    const img = document.createElement('img');
    img.src = url; img.alt = '';
    const sel = window.getSelection();
    let inserted = false;
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(img);
      r.setStartAfter(img); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      inserted = true;
    }
    if (!inserted) ed.appendChild(img);
    ed.focus();
  }

  // v1.8.18 表格行列增删：记录光标/点击所在单元格
  let curTableCell = null;
  function handleCellClick(t) {
    let n = t && t.nodeType === 1 ? t : null; curTableCell = null;
    while (n) { if (n.tagName === 'TD' || n.tagName === 'TH') { curTableCell = n; return; } n = n.parentElement; }
  }
  function trackTableCell() {
    // 只更新到新的表格单元格；若光标不在表格内不主动清空（避免点击工具栏按钮时的 blur/selection 时序丢失已选中的单元格）
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    let n = sel.anchorNode;
    if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement;
    while (n && n.nodeType === Node.ELEMENT_NODE) {
      if (n.tagName === 'TD' || n.tagName === 'TH') { curTableCell = n; return; }
      n = n.parentElement;
    }
  }
  function tableInsertRow(after) {
    const td = curTableCell; if (!td) { alert('请先点击表格里的单元格'); return; }
    const tr = td.closest('tr'); if (!tr) return;
    const nr = tr.cloneNode(false);
    Array.from(tr.cells).forEach(c => { const nc = document.createElement(c.tagName.toLowerCase()); nc.innerHTML = '<br>'; nr.appendChild(nc); });
    if (after) tr.after(nr); else tr.before(nr);
  }
  function tableDeleteRow() {
    const td = curTableCell; if (!td) return;
    const tr = td.closest('tr'); const tbl = tr.closest('table'); if (!tr || !tbl) return;
    if (tbl.rows.length <= 1) { tbl.remove(); curTableCell = null; return; }
    tr.remove();
  }
  function tableInsertCol(after) {
    const td = curTableCell; if (!td) { alert('请先点击表格里的单元格'); return; }
    const tr = td.parentElement; const tbl = td.closest('table'); if (!tr || !tbl) return;
    const idx = Array.prototype.indexOf.call(tr.cells, td);
    tbl.querySelectorAll('tr').forEach(r => {
      const ref = r.cells[idx];
      const nc = document.createElement((ref ? ref.tagName : 'td').toLowerCase()); nc.innerHTML = '<br>';
      if (ref) { if (after) ref.after(nc); else r.insertBefore(nc, ref); }
      else r.appendChild(nc);
    });
  }
  function tableDeleteCol() {
    const td = curTableCell; if (!td) return;
    const tr = td.parentElement; const tbl = td.closest('table'); if (!tr || !tbl) return;
    const idx = Array.prototype.indexOf.call(tr.cells, td);
    tbl.querySelectorAll('tr').forEach(r => { if (r.cells[idx]) r.deleteCell(idx); });
    if (tbl.rows.length === 0) tbl.remove();
    curTableCell = null;
  }
  function tableDeleteAll() {
    const td = curTableCell; if (!td) return;
    const tbl = td.closest('table'); if (!tbl) return;
    tbl.remove(); curTableCell = null;
  }

  // v1.8.20：移除编辑区里的链接（保留其文字为纯文本），用于“删除链接”
  function removeNoteLinkKeepText(a) {
    const r = document.createRange();
    r.selectNodeContents(a);
    const frag = r.extractContents();
    a.replaceWith(frag);
    kwe().focus();
  }

  // v1.8.20：点击编辑区里的链接 → 修改 / 删除（防一点就跳走；历史笔记里的超链接重开后也能这样调整）
  function editNoteLink(a) {
    const curText = a.textContent || '';
    const curHref = a.getAttribute('href') || '';
    const nText = window.prompt('修改链接文字（清空 = 删除该超链接，文字会保留）', curText);
    if (nText === null) return;
    const text = nText.trim();
    if (!text) { removeNoteLinkKeepText(a); kwe().focus(); return; }
    const nHref = window.prompt('链接地址（https://…）', curHref);
    if (nHref === null) return;
    const href = nHref.trim();
    if (!href || !/^(https?:|mailto:|tel:|ftp:)/i.test(href)) {
      if (!href) { removeNoteLinkKeepText(a); kwe().focus(); return; }
      alert('仅支持 http(s) / mailto / tel 等链接地址');
      return;
    }
    a.textContent = text;
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    kwe().focus();
  }

  // v1.8.20：在编辑区光标处插入超链接（先选中文字则直接作为链接文字），所见即所得
  function insertNoteLink() {
    const ed = kwe();
    if (!ed) return;
    const sel = window.getSelection();
    let text = '';
    const hasSel = sel && sel.rangeCount && ed.contains(sel.anchorNode) && sel.toString().trim();
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
    if (!url) { alert('请输入链接地址'); return; }
    if (!/^(https?:|mailto:|tel:|ftp:)/i.test(url) && url !== '#') {
      alert('仅支持 http(s) / mailto / tel 等链接地址');
      return;
    }
    const label = text || url;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(a);
      r.setStartAfter(a); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      ed.appendChild(a);
    }
    ed.focus();
  }

  // 点图 → 修改/删除；点链接 → 修改/删除（v1.8.20）
  function handleNoteEditorClick(e) {
    handleCellClick(e.target);
    if (curTableCell && curTableCell.closest('table')) positionTableHandle();
    else hideTableHandle();
    const t = e.target;
    // v1.8.20：优先处理链接（含表格单元格里的链接），点击可修改/删除，不触发跳转
    const a = t && t.closest ? t.closest('a') : null;
    if (a && kwe().contains(a)) {
      e.preventDefault();
      editNoteLink(a);
      return;
    }
    if (!t || t.tagName !== 'IMG') return;
    e.preventDefault();
    const cur = t.getAttribute('src') || '';
    const inp = window.prompt('修改 / 删除图片\n· 修改：输入新的图片地址\n· 删除：清空留空后点确定', cur);
    if (inp === null) return;
    const v = inp.trim();
    if (!v) { t.remove(); kwe().focus(); return; }
    if (!/^(https?:\/\/|data:image\/)/i.test(v)) { alert('仅支持 http(s) 或 data: 图片地址'); return; }
    t.setAttribute('src', v);
    kwe().focus();
  }

  // 粘贴：只插入纯文本（防带入脏 HTML）
  function handleNoteEditorPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const ed = kwe();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const n = document.createTextNode(text);
      r.insertNode(n);
      r.setStartAfter(n); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      ed.append(document.createTextNode(text));
    }
    ed.focus();
  }

  // v1.8.19 表格右下角 [+ −] 手柄：跟随表格右下角，增删行/列/整表
  let thHandle = null, thMenuEl = null;
  function thEls() {
    if (!thHandle) { thHandle = document.getElementById('kwTableHandle'); thMenuEl = document.getElementById('thMenu'); }
    return thHandle;
  }
  function positionTableHandle() {
    const h = thEls(); if (!h) return;
    const tb = curTableCell ? curTableCell.closest('table') : null;
    if (!tb || !kwe().contains(tb)) { hideTableHandle(); return; }
    const lastRow = tb.rows[tb.rows.length - 1];
    const lastCell = lastRow.cells[lastRow.cells.length - 1];
    const c = lastCell.getBoundingClientRect();
    h.style.left = c.right + 4 + 'px';
    h.style.top = c.bottom - 6 + 'px';
    h.style.display = 'flex';
  }
  function hideTableHandle() {
    const h = thEls(); if (!h) return;
    h.style.display = 'none';
    if (thMenuEl) thMenuEl.style.display = 'none';
  }
  function showTableMenu(plus) {
    const h = thEls(); if (!h) return;
    if (!thMenuEl) return;
    const items = plus ? [
      { label: '＋ 在下方加一行', fn: () => { tableInsertRow(true); } },
      { label: '＋ 在右侧加一列', fn: () => { tableInsertCol(true); } }
    ] : [
      { label: '－ 删除该行', fn: () => { tableDeleteRow(); } },
      { label: '－ 删除该列', fn: () => { tableDeleteCol(); } },
      { label: '－ 删除整表', fn: () => { tableDeleteAll(); } }
    ];
    thMenuEl.innerHTML = '';
    items.forEach(it => {
      const d = document.createElement('div');
      d.className = 'th-menu-item';
      d.textContent = it.label;
      d.addEventListener('click', (e) => { e.stopPropagation(); it.fn(); hideTableHandle(); });
      thMenuEl.appendChild(d);
    });
    thMenuEl.style.display = 'block';
  }
  function initTableHandle() {
    const h = thEls(); if (!h) return;
    document.getElementById('thBtnPlus')?.addEventListener('click', (e) => { e.stopPropagation(); showTableMenu(true); });
    document.getElementById('thBtnMinus')?.addEventListener('click', (e) => { e.stopPropagation(); showTableMenu(false); });
    // 点击编辑区/文档其它处 → 隐藏手柄（点在表格或手柄内不隐藏）
    document.addEventListener('click', (e) => {
      if (h.contains(e.target)) return;
      let n = e.target; let inTbl = false;
      while (n) { if (n.tagName === 'TABLE') { inTbl = true; break; } n = n.parentElement; }
      if (!inTbl) hideTableHandle();
    });
  }

  // v1.8.17 工具栏：加粗 / 斜体（选中文字即见效）
  function runNoteCmd(cmd) {
    const ed = kwe();
    if (!ed) return;
    ed.focus();
    try { document.execCommand(cmd, false, null); } catch (e) {}
  }

  // v1.8.17 工具栏：插入表格（所见即所得）
  function insertNoteTable() {
    const ed = kwe();
    if (!ed) return;
    const rows = Math.min(Math.max(parseInt(window.prompt('表格行数（含表头）：', '2'), 10) || 2, 1), 20);
    const cols = Math.min(Math.max(parseInt(window.prompt('表格列数：', '3'), 10) || 3, 1), 10);
    let h = '<table><tbody>';
    h += '<tr>' + ('<th>表头</th>').repeat(cols) + '</tr>';
    for (let r = 1; r < rows; r++) h += '<tr>' + ('<td>内容</td>').repeat(cols) + '</tr>';
    h += '</tbody></table><p></p>';
    ed.focus();
    try { document.execCommand('insertHTML', false, h); } catch (e) { ed.insertAdjacentHTML('beforeend', h); }
  }

  function showKeywordModal(keyword = null) {
    hideTableHandle();
    editingKeywordId = keyword ? keyword.id : null;
    editingKeyword = keyword || null;
    const modal = $('#keywordModal');
    $('#keywordModalTitle').textContent = keyword ? '编辑关键词' : '添加关键词';
    
    curNoteEd = $('#editKwImportantNote');
    $('#editKwText').value = keyword?.text || '';
    $('#editKwNote').value = keyword?.note || '';
    $('#editKwBgColor').value = keyword?.bgColor || '#ffff00';
    $('#editKwTextColor').value = keyword?.textColor || '#000000';
    $('#editKwCaseSensitive').checked = keyword?.caseSensitive || false;
    $('#editKwWholeWord').checked = keyword?.wholeWord || false;
    $('#editKwUseRegex').checked = keyword?.useRegex || false;
    $('#editKwImportant').checked = keyword?.important || false;
    $('#editKwImportantNote').innerHTML = '';
    setNoteEditorHTML(keyword?.importantNote || '');
    $('#editKwImgSize').value = keyword?.imgSize || '';
    // v1.9.0 笔记底色回显（开关 + 取色器 + hex 输入三处同步）
    const bgVal = (keyword && keyword.impNoteBg) || '';
    $('#editKwImpBgEnable').checked = !!bgVal;
    const normBg = (/^#[0-9a-fA-F]{3}$/.test(bgVal)) ? ('#' + bgVal[1] + bgVal[1] + bgVal[2] + bgVal[2] + bgVal[3] + bgVal[3]) : bgVal;
    if ($('#editKwImpBgColor')) $('#editKwImpBgColor').value = normBg || '#e8f5e9';
    if ($('#editKwImpBgHex')) $('#editKwImpBgHex').value = bgVal || '';
    // v1.8.17 编辑器内重要笔记图片大小与「命中时展示」同步（默认 70px，可用该词「图片缩略尺寸」覆盖）
    const kweImg = kwe();
    if (kweImg) kweImg.style.setProperty('--kh-note-img-size', (parseInt(keyword?.imgSize, 10) || 70) + 'px');
    $('#editKwCellVerifyValue').value = keyword?.cellVerify || '';
    $('#editKwCellVerifyExact').checked = (keyword?.cellVerifyMatchMode === 'exact');
    $('#editKwCellVerifyCase').checked = keyword?.cellVerifyCaseSensitive || false;
    $('#editKwCellVerifyRegex').checked = keyword?.cellVerifyUseRegex || false;
    $('#editKwFetchLabels').value = keyword?.fetchLabels || '';

    // 根据勾选状态显示/隐藏 单元格标注细节 与 重要笔记输入
    toggleKwSections();

    // v1.8.13 编辑已有关键词时，按内容自动展开对应折叠区（无内容保持默认折叠）
    const hasCell = !!(keyword && (keyword.cellVerify || keyword.fetchLabels));
    const hasImp  = !!(keyword && (keyword.important || keyword.importantNote || keyword.impNoteBg));
    const cellSec = $('#kwCellSection');
    const impSec  = $('#kwImportantSection');
    if (cellSec) cellSec.classList.toggle('closed', !hasCell);
    if (impSec)  impSec.classList.toggle('closed', !hasImp);

    // 加载分组选项
    loadGroupOptions(keyword?.groupId || '');

    // 若关键词已属于有颜色的分组，颜色输入框自动改为分组颜色
    if (keyword?.groupId) {
      const g = allGroups.find(x => x.id === keyword.groupId);
      if (g && g.bgColor) {
        $('#editKwBgColor').value = g.bgColor;
        $('#editKwTextColor').value = g.textColor || '#000000';
      }
    }
    
    modal.style.display = 'flex';
    fitModalFooter();
    $('#editKwText').focus();
  }

  // 让「取消/保存」固定在弹窗底部（v1.7.0：不再限制 body 高度、避免出现滚动条，
  // 弹窗随内容增高；仅保留 dialog ≤94% 视口的上限作为极端兜底）
  function fitModalFooter() {
    const dlg = document.querySelector('#keywordModal .modal-dialog');
    const body = document.querySelector('#keywordModal .modal-body');
    if (!dlg || !body) return;
    const maxH = Math.round(window.innerHeight * 0.94);
    dlg.style.maxHeight = maxH + 'px';
    body.style.maxHeight = '';
    body.scrollTop = 0;
  }

  async function loadGroupOptions(selectedId = '') {
    const groups = await Storage.getGroups();
    allGroups = groups;
    const select = $('#editKwGroup');
    select.innerHTML = '<option value="">无分组</option>';
    groups.forEach(g => {
      select.innerHTML += `<option value="${g.id}" ${g.id === selectedId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`;
    });
    // 选择分组时自动应用分组颜色
    select.onchange = () => applyGroupColorToForm();
  }

  // 将当前选中分组的颜色应用到颜色输入框
  function applyGroupColorToForm() {
    const gid = $('#editKwGroup').value;
    if (!gid) return;
    const g = allGroups.find(x => x.id === gid);
    if (g && g.bgColor) {
      $('#editKwBgColor').value = g.bgColor;
      $('#editKwTextColor').value = g.textColor || '#000000';
    }
  }

  async function saveKeyword() {
    const text = $('#editKwText').value.trim();
    // 特殊「仅抓取」模式(v1.8.6)：关键词可留空，但须在「单元格组合」填写标题关键词(左格) + 抓取后续字段
    const ceValue = $('#editKwCellVerifyValue').value.trim();
    const fetchLabelsVal = $('#editKwFetchLabels').value.trim();
    const fetchOnlyMode = !!(ceValue && fetchLabelsVal); // 关键词留空时合法模式
    if (!text && !fetchOnlyMode) {
      alert('请输入关键词文字（或勾选「单元格特别标注」并同时填写标题关键词与抓取后续字段，以「仅抓取」模式使用）');
      return;
    }

    let bgColor = $('#editKwBgColor').value;
    let textColor = $('#editKwTextColor').value;
    const groupId = $('#editKwGroup').value;

    // 同组颜色统一：保存时若属于有颜色的分组，强制使用分组颜色
    const g = allGroups.find(x => x.id === groupId);
    if (g && g.bgColor) {
      bgColor = g.bgColor;
      textColor = g.textColor || '#000000';
    }

    const data = {
      text,
      note: $('#editKwNote').value.trim(),
      groupId,
      bgColor,
      textColor,
      enabled: editingKeyword ? (editingKeyword.enabled !== false) : true,
      caseSensitive: $('#editKwCaseSensitive').checked,
      wholeWord: $('#editKwWholeWord').checked,
      useRegex: $('#editKwUseRegex').checked,
      important: $('#editKwImportant').checked,
      importantNote: mdFromNoteEditor(),
      imgSize: (function(){ const v=($('#editKwImgSize').value||'').trim(); if(!v) return ''; const n=parseInt(v,10); return (!isNaN(n)&&n>=40&&n<=600)? n : ''; })(),
      // v1.9.0 笔记底色：勾选启用，优先取 hex 文本（支持 #abc / #aabbcc / #aabbccdd），否则用取色器值，非法则存空
      impNoteBg: (function(){
        const en = !!($('#editKwImpBgEnable') && $('#editKwImpBgEnable').checked);
        if (!en) return '';
        const h = ($('#editKwImpBgHex') && $('#editKwImpBgHex').value || '').trim();
        const c = ($('#editKwImpBgColor') && $('#editKwImpBgColor').value) || '';
        const v = /^#[0-9a-fA-F]{3,8}$/.test(h) ? h : c;
        return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '';
      })(),
      cellVerifyEnabled: !!$('#editKwCellVerifyValue').value.trim(),
      cellVerify: $('#editKwCellVerifyValue').value.trim(),
      cellVerifyMatchMode: $('#editKwCellVerifyExact').checked ? 'exact' : 'include',
      cellVerifyCaseSensitive: $('#editKwCellVerifyCase').checked,
      cellVerifyUseRegex: $('#editKwCellVerifyRegex').checked,
      fetchLabels: $('#editKwFetchLabels').value.trim()
    };

    try {
      if (editingKeywordId) {
        await Storage.updateKeyword(editingKeywordId, data);
      } else {
        await Storage.addKeyword(data);
      }
      closeKeywordModal();
      loadKeywords();
      notifyContentRefresh();
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  }

  function closeKeywordModal() {
    $('#keywordModal').style.display = 'none';
    editingKeywordId = null;
    curNoteEd = null; // 关闭后回到默认关键词编辑器
    // v1.6.37 独立窗口「?add」模式：关弹窗即关窗口
    if (window.KH_ADD_MODE) { try { window.close(); } catch (e) {} }
  }

  // ========== 分组管理 ==========
  async function loadGroups() {
    const groups = await Storage.getGroups();
    const keywords = await Storage.getKeywords();
    const list = $('#groupList');

    if (groups.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📁</span>
          <p>还没有创建分组</p>
        </div>
      `;
      return;
    }

    list.innerHTML = groups.map(g => {
      const count = keywords.filter(k => k.groupId === g.id).length;
      const colorDot = g.bgColor
        ? `<span class="group-color-dot" style="background:${escapeHtml(g.bgColor)};" title="高亮色 ${escapeHtml(g.bgColor)}"></span>`
        : '';
      const impMark = g.important ? ' <span class="imp-badge" title="此分组为重要，组内关键词命中时弹出置顶笔记">📌</span>' : '';
      return `
        <div class="group-row">
          <span class="group-name">📁 ${colorDot} ${escapeHtml(g.name)}${impMark}</span>
          <span class="group-count">${count} 个关键词</span>
          <div class="kw-actions">
            <button class="btn-icon" data-action="editGroup" data-id="${g.id}" title="编辑">✏️</button>
            <button class="btn-icon" data-action="deleteGroup" data-id="${g.id}" title="删除">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-action="editGroup"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = groups.find(gr => gr.id === btn.dataset.id);
        if (g) showGroupModal(g);
      });
    });

    list.querySelectorAll('[data-action="deleteGroup"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('确定要删除此分组吗？关联的关键词将变为无分组。')) {
          await Storage.deleteGroup(btn.dataset.id);
          loadGroups();
          loadKeywords();
        }
      });
    });
  }

  function showGroupModal(group = null) {
    editingGroupId = group ? group.id : null;
    const modal = $('#groupModal');
    $('#groupModalTitle').textContent = group ? '编辑分组' : '新建分组';
    $('#editGroupName').value = group?.name || '';
    $('#editGroupImportant').checked = !!(group && group.important);
    // 分组统一重要笔记：所见即所得富文本编辑器（与关键词共用同一套命令）
    curNoteEd = $('#editGroupImpNoteRich');
    setNoteEditorHTML((group && group.importantNote) || '');
    const gImgV = (group && group.imgSize) || '';
    const gImgN = parseInt(gImgV, 10);
    if ($('#editGroupImgSize')) $('#editGroupImgSize').value = (gImgN >= 40 && gImgN <= 600) ? gImgN : '';
    const gEdR = $('#editGroupImpNoteRich');
    if (gEdR) gEdR.style.setProperty('--kh-note-img-size', ((gImgN >= 40 && gImgN <= 600) ? gImgN : 70) + 'px');
    // v1.9.4 分组统一重要笔记底色
    const gBg = (group && group.impNoteBg) || '';
    const gBgNorm = /^#[0-9a-fA-F]{3,8}$/.test(gBg) ? gBg : '';
    $('#editGroupImpBgEnable').checked = !!gBgNorm;
    const inpGColor = $('#editGroupImpBgColor');
    const inpGHex = $('#editGroupImpBgHex');
    if (inpGColor) inpGColor.value = gBgNorm || '#e8f5e9';
    if (inpGHex) inpGHex.value = gBgNorm || '';
    // 仅勾选「标记为重要」时显示统一文本/底色区
    const updateImpNoteRow = () => {
      $('#editGroupImportantNoteRow').style.display =
        $('#editGroupImportant').checked ? '' : 'none';
      $('#editGroupImpBgRow').style.display =
        $('#editGroupImportant').checked ? '' : 'none';
    };
    $('#editGroupImportant').onchange = updateImpNoteRow;
    updateImpNoteRow();

    // 载入颜色状态
    const useColor = !!(group && group.bgColor);
    $('#editGroupUseColor').checked = useColor;
    $('#editGroupColorRow').style.display = useColor ? 'flex' : 'none';
    $('#editGroupBgColor').value = (group && group.bgColor) || '#ffff00';
    $('#editGroupTextColor').value = (group && group.textColor) || '#000000';

    modal.style.display = 'flex';
    $('#editGroupName').focus();
  }

  async function saveGroup() {
    const name = $('#editGroupName').value.trim();
    if (!name) {
      alert('请输入分组名称');
      return;
    }
    curNoteEd = $('#editGroupImpNoteRich');

    // 读取颜色设置
    const useColor = $('#editGroupUseColor').checked;
    const groupData = {
      name,
      bgColor: useColor ? $('#editGroupBgColor').value : '',
      textColor: useColor ? $('#editGroupTextColor').value : '',
      important: $('#editGroupImportant').checked,
      importantNote: $('#editGroupImportant').checked ? mdFromNoteEditor() : '',
      imgSize: (function(){
        const v = ($('#editGroupImgSize') && $('#editGroupImgSize').value || '').trim();
        if (!v) return '';
        const n = parseInt(v, 10);
        return (!isNaN(n) && n >= 40 && n <= 600) ? n : '';
      })(),
      // v1.9.3 分组笔记底色：勾选启用，优先取 hex 文本，否则取取色器值，非法则存空（同关键词逻辑）
      impNoteBg: (function(){
        const en = !!($('#editGroupImpBgEnable') && $('#editGroupImpBgEnable').checked);
        if (!en) return '';
        const h = ($('#editGroupImpBgHex') && $('#editGroupImpBgHex').value || '').trim();
        const c = ($('#editGroupImpBgColor') && $('#editGroupImpBgColor').value) || '';
        const v = /^#[0-9a-fA-F]{3,8}$/.test(h) ? h : c;
        return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '';
      })()
    };

    try {
      if (editingGroupId) {
        await Storage.updateGroup(editingGroupId, groupData);
      } else {
        await Storage.addGroup(groupData);
      }
      closeGroupModal();
      loadGroups();
      notifyContentRefresh();
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  }

  function closeGroupModal() {
    $('#groupModal').style.display = 'none';
    editingGroupId = null;
    curNoteEd = null; // 关闭后回到默认关键词编辑器，避免命令误用分组编辑器
  }

  // ========== 高亮样式 ==========
  async function loadStyles() {
    const data = await Storage.get(['highlightStyle']);
    const style = data.highlightStyle || Storage.defaults.highlightStyle;

    $('#hlBgColor').value = style.defaultBgColor;
    $('#hlBgColorText').value = style.defaultBgColor;
    $('#hlTextColor').value = style.defaultTextColor;
    $('#hlTextColorText').value = style.defaultTextColor;
    $('#hlBorderColor').value = style.defaultBorderColor;
    $('#hlBorderColorText').value = style.defaultBorderColor;
    $('#hlBorderWidth').value = style.defaultBorderWidth;
    $('#hlBorderRadius').value = style.defaultBorderRadius;

    updateHighlightPreview();
  }

  function updateHighlightPreview() {
    const previewEl = $('.preview-highlight');
    if (previewEl) {
      previewEl.style.backgroundColor = $('#hlBgColor').value;
      previewEl.style.color = $('#hlTextColor').value;
      previewEl.style.borderBottom = `${$('#hlBorderWidth').value} solid ${$('#hlBorderColor').value}`;
      previewEl.style.borderRadius = $('#hlBorderRadius').value;
    }
  }

  async function saveHighlightStyle() {
    const style = {
      defaultBgColor: $('#hlBgColor').value,
      defaultTextColor: $('#hlTextColor').value,
      defaultBorderColor: $('#hlBorderColor').value,
      defaultBorderWidth: $('#hlBorderWidth').value,
      defaultBorderRadius: $('#hlBorderRadius').value
    };
    await Storage.set({ highlightStyle: style });
    updateHighlightPreview();
    notifyContentRefresh();
  }

  // ========== 备注卡片样式 ==========
  async function loadNoteCardStyles() {
    const data = await Storage.get(['noteCardStyle']);
    const style = data.noteCardStyle || Storage.defaults.noteCardStyle;

    $('#ncBgColor').value = style.bgColor;
    $('#ncBgColorText').value = style.bgColor;
    $('#ncTextColor').value = style.textColor;
    $('#ncTextColorText').value = style.textColor;
    $('#ncBorderColor').value = style.borderColor;
    $('#ncBorderColorText').value = style.borderColor;
    $('#ncBorderWidth').value = style.borderWidth;
    $('#ncBorderRadius').value = style.borderRadius;
    $('#ncMaxWidth').value = style.maxWidth;
    $('#ncShadow').value = style.shadow;
    $('#ncOpacity').value = style.opacity;

    updateNoteCardPreview();
  }

  function updateNoteCardPreview() {
    const card = $('.preview-card');
    if (card) {
      card.style.backgroundColor = $('#ncBgColor').value;
      card.style.color = $('#ncTextColor').value;
      card.style.borderColor = $('#ncBorderColor').value;
      card.style.borderWidth = $('#ncBorderWidth').value;
      card.style.borderRadius = $('#ncBorderRadius').value;
      card.style.maxWidth = $('#ncMaxWidth').value;
      card.style.boxShadow = $('#ncShadow').value;
      card.style.opacity = $('#ncOpacity').value;
    }
  }

  async function saveNoteCardStyle() {
    const style = {
      bgColor: $('#ncBgColor').value,
      textColor: $('#ncTextColor').value,
      borderColor: $('#ncBorderColor').value,
      borderWidth: $('#ncBorderWidth').value,
      borderRadius: $('#ncBorderRadius').value,
      shadow: $('#ncShadow').value,
      maxWidth: $('#ncMaxWidth').value,
      opacity: $('#ncOpacity').value
    };
    await Storage.set({ noteCardStyle: style });
    updateNoteCardPreview();
    notifyContentRefresh();
  }

  // ========== 站点规则 ==========
  async function loadSiteRules() {
    const rules = await Storage.getSiteRules();
    const list = $('#siteRuleList');

    // 注意：UI 已移除「黑名单模式/白名单模式」单选（该概念冗余且误导），
    // 实际生效的是每条规则自身的 type（黑/白）与匹配顺序。

    if (rules.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🌐</span>
          <p>暂无站点规则</p>
        </div>
      `;
      return;
    }

    const matchTypeLabels = {
      'exact': '精确匹配',
      'subdomain': '子域名匹配',
      'prefix': '前缀匹配',
      'regex': '正则表达式'
    };
    const scopeLabels = { host: '域名', url: '网址' };

    list.innerHTML = rules.map(r => `
      <div class="site-rule-row">
        <span class="site-rule-badge ${r.type}">${r.type === 'blacklist' ? '🚫 黑名单' : '✅ 白名单'}</span>
        <span class="site-rule-pattern">${escapeHtml(r.pattern)}</span>
        <span class="site-rule-match-type">${scopeLabels[r.scope] || '域名'} · ${matchTypeLabels[r.matchType] || r.matchType}</span>
        <button class="btn-icon" data-action="deleteSiteRule" data-index="${rules.indexOf(r)}" title="删除">🗑️</button>
      </div>
    `).join('');

    list.querySelectorAll('[data-action="deleteSiteRule"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rules = await Storage.getSiteRules();
        const idx = parseInt(btn.dataset.index);
        rules.splice(idx, 1);
        await Storage.set({ siteRules: rules });
        loadSiteRules();
        notifyContentRefresh();
      });
    });
  }

  function showSiteRuleModal() {
    editingSiteRuleId = null;
    const modal = $('#siteRuleModal');
    $('#siteRuleModalTitle').textContent = '添加站点规则';
    $('#editSiteRuleType').value = 'blacklist';
    $('#editSiteRuleScope').value = 'host';
    updateSiteRuleMatchOptions();
    $('#editSiteRulePattern').value = '';
    updateSiteRuleHint();
    modal.style.display = 'flex';
    $('#editSiteRulePattern').focus();
  }

  // 根据匹配对象（域名/网址）过滤可用的匹配方式
  function updateSiteRuleMatchOptions() {
    const scope = $('#editSiteRuleScope')?.value || 'host';
    const mt = $('#editSiteRuleMatchType');
    const cur = mt.value;
    const hostOptions = [
      ['exact', '域名精确匹配'],
      ['subdomain', '子域名匹配'],
      ['prefix', 'URL 前缀匹配'],
      ['regex', '正则表达式']
    ];
    const urlOptions = [
      ['prefix', 'URL 前缀匹配'],
      ['regex', '正则表达式']
    ];
    const opts = scope === 'url' ? urlOptions : hostOptions;
    mt.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (opts.some(o => o[0] === cur)) mt.value = cur;
    else mt.value = opts[0][0];
  }

  function updateSiteRuleHint() {
    const scope = $('#editSiteRuleScope')?.value || 'host';
    const matchType = $('#editSiteRuleMatchType').value;
    if (scope === 'url') {
      $('#siteRuleHint').textContent = matchType === 'regex'
        ? '输入正则表达式，匹配完整网址，如 ^https://example\\.com/blog'
        : '输入网址前缀，如 https://example.com/blog（仅该分页及其子路径生效/失效）';
      return;
    }
    const hints = {
      'exact': '输入完整域名，如 example.com',
      'subdomain': '输入主域名，如 example.com（匹配 *.example.com）',
      'prefix': '输入 URL 前缀，如 https://example.com/blog',
      'regex': '输入正则表达式，如 example\\.(com|org)'
    };
    $('#siteRuleHint').textContent = hints[matchType] || '';
  }

  async function saveSiteRule() {
    const pattern = $('#editSiteRulePattern').value.trim();
    if (!pattern) {
      alert('请输入匹配模式');
      return;
    }

    const rule = {
      type: $('#editSiteRuleType').value,
      scope: $('#editSiteRuleScope')?.value || 'host',
      matchType: $('#editSiteRuleMatchType').value,
      pattern
    };

    const rules = await Storage.getSiteRules();
    rules.push(rule);
    await Storage.set({ siteRules: rules });
    closeSiteRuleModal();
    loadSiteRules();
    notifyContentRefresh();
  }

  function closeSiteRuleModal() {
    $('#siteRuleModal').style.display = 'none';
    editingSiteRuleId = null;
  }

  // ========== 批量添加关键词 ==========
  // 单元格组合内容匹配：切换开关时显示/隐藏相关配置，并更新示例
  function toggleBulkCellMode() {
    const on = $('#bulkCellMode').checked;
    $('#bulkCellOpts').style.display = on ? 'block' : 'none';
    updateBulkExample();
  }

  async function showBulkModal() {
    $('#bulkModal').style.display = 'flex';
    $('#bulkText').value = '';
    $('#bulkResult').textContent = '';
    $('#bulkCellMode').checked = false;
    $('#bulkCellOpts').style.display = 'none';
    $('#bulkCellImportantNote').value = '';

    // 加载分组选项
    const groups = await Storage.getGroups();
    allGroups = groups;
    const groupSelect = $('#bulkGroup');
    groupSelect.innerHTML = '<option value="">无分组</option>';
    groups.forEach(g => {
      groupSelect.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)}</option>`;
    });
    // 选择分组时自动应用分组颜色
    groupSelect.onchange = () => {
      const g = allGroups.find(x => x.id === groupSelect.value);
      if (g && g.bgColor) {
        $('#bulkBgColor').value = g.bgColor;
        $('#bulkTextColor').value = g.textColor || '#000000';
      }
    };

    updateBulkExample();
    $('#bulkText').focus();
  }

  function closeBulkModal() {
    $('#bulkModal').style.display = 'none';
  }

  // 更新分隔符示例
  function updateBulkExample() {
    const sep = $('#bulkSeparator').value === '\\t' ? '\t' : $('#bulkSeparator').value;
    const cell = $('#bulkCellMode').checked;
    if (cell) {
      $('#bulkExample').textContent = `左格标题1${sep}右格核心1${cell ? sep + '备注1' : ''}\n左格标题2${sep}右格核心2`;
    } else {
      $('#bulkExample').textContent = `关键词1${sep}备注内容1\n关键词2${sep}备注内容2`;
    }
  }

  // 批量解析并添加
  async function saveBulk() {
    const rawText = $('#bulkText').value.trim();
    if (!rawText) {
      alert('请输入内容');
      return;
    }

    const sepRaw = $('#bulkSeparator').value;
    const sep = sepRaw === '\\t' ? '\t' : sepRaw;
    const groupId = $('#bulkGroup').value;
    let bgColor = $('#bulkBgColor').value;
    let textColor = $('#bulkTextColor').value;

    // 同组颜色统一：若属于有颜色的分组，强制使用分组颜色
    const bg = allGroups.find(x => x.id === groupId);
    if (bg && bg.bgColor) {
      bgColor = bg.bgColor;
      textColor = bg.textColor || '#000000';
    }

    const caseSensitive = $('#bulkCaseSensitive').checked;
    const wholeWord = $('#bulkWholeWord').checked;
    const useRegex = $('#bulkUseRegex').checked;
    const dupPolicy = $('#bulkDupPolicy').value;

    // 单元格组合内容匹配相关配置
    const cellMode = $('#bulkCellMode').checked;
    const cellMatchMode = $('#bulkCellExact').checked ? 'exact' : 'include';
    const cellCase = $('#bulkCellCase').checked;
    const cellRegex = $('#bulkCellRegex').checked;
    const cellNote = $('#bulkCellImportantNote').value.trim();
    const cellFetch = $('#bulkFetchLabels').value.trim();

    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const keywords = await Storage.getKeywords();
    let added = 0, skipped = 0, replaced = 0, failed = 0;
    const seen = new Set();

    for (const line of lines) {
      let text, cellVerify = '', note = '';

      // 尝试按分隔符拆分
      const parts = line.split(sep);
      if (parts.length >= 2) {
        if (cellMode) {
          // 单元格组合模式（v1.8.3 翻转）：左格标题[sep]右格核心[sep]备注(可选)
          cellVerify = (parts[0] || '').trim(); // 左格标题词
          text = (parts[1] || '').trim();        // 右格核心（即「关键词」位置内容）
          note = parts.slice(2).join(sep).trim();
        } else {
          text = (parts[0] || '').trim();
          note = parts.slice(1).join(sep).trim();
        }
      } else {
        // 无分隔符
        text = line.trim();
      }

      if (!text) { failed++; continue; }

      // 单元格模式下支持「同前格、不同后格」并存，用「前格+后格」组合去重
      const key = cellMode ? (text + '\u0000' + cellVerify) : text;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);

      // 重复判断：单元格模式按「前格+后格」组合；普通模式仅与「同文本且无验证」的词冲突
      const existing = cellMode
        ? keywords.find(k => k.text === text && (k.cellVerify || '') === cellVerify)
        : keywords.find(k => k.text === text && !(k.cellVerify || ''));
      if (existing) {
        if (dupPolicy === 'skip') {
          skipped++;
          continue;
        } else {
          // 覆盖：更新备注、重要笔记与设置；单元格模式下补上后格验证字段
          Object.assign(existing, {
            note: note || existing.note,
            important: !!cellNote || existing.important,
            importantNote: cellNote || existing.importantNote,
            groupId: groupId || existing.groupId,
            bgColor: bgColor || existing.bgColor,
            textColor: textColor || existing.textColor,
            caseSensitive, wholeWord, useRegex,
            enabled: true,
            updatedAt: Date.now()
          });
          if (cellMode) {
            existing.cellVerifyEnabled = !!cellVerify;
            existing.cellVerify = cellVerify;
            existing.cellVerifyMatchMode = cellMatchMode;
            existing.cellVerifyCaseSensitive = cellCase;
            existing.cellVerifyUseRegex = cellRegex;
            if (cellFetch) existing.fetchLabels = cellFetch;
          }
          replaced++;
          continue;
        }
      }

      // 新增
      const kw = {
        id: 'kw_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9),
        text,
        note,
        groupId,
        bgColor,
        textColor,
        caseSensitive,
        wholeWord,
        useRegex,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (cellMode) {
        kw.important = !!cellNote;
        kw.importantNote = cellNote;
        kw.cellVerifyEnabled = !!cellVerify;
        kw.cellVerify = cellVerify;
        kw.cellVerifyMatchMode = cellMatchMode;
        kw.cellVerifyCaseSensitive = cellCase;
        kw.cellVerifyUseRegex = cellRegex;
        if (cellFetch) kw.fetchLabels = cellFetch;
      }
      keywords.push(kw);
      added++;
    }

    await Storage.set({ keywords });

    $('#bulkResult').textContent = `✅ 新增 ${added}，覆盖 ${replaced}，跳过 ${skipped}${failed ? `，失败 ${failed}` : ''}`;
    loadKeywords();
    notifyContentRefresh();

    // 若全部成功，延迟关闭并提示
    if (failed === 0) {
      setTimeout(() => closeBulkModal(), 1500);
    }
  }

  // ========== 导入导出 ==========
  async function exportJSON() {
    try {
      const jsonStr = await Storage.exportData();
      downloadFile('keyword-highlighter-backup.json', jsonStr, 'application/json');
    } catch (err) {
      alert('导出失败：' + err.message);
    }
  }

  async function exportCSV() {
    try {
      const csvStr = await Storage.exportCSV();
      downloadFile('keyword-highlighter-keywords.csv', csvStr, 'text/csv');
    } catch (err) {
      alert('导出失败：' + err.message);
    }
  }

  function importFile(accept, callback) {
    const input = $('#importFileInput');
    input.accept = accept;
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        await callback(text);
        alert('导入成功！');
        loadKeywords();
        notifyContentRefresh();
      } catch (err) {
        alert('导入失败：' + err.message);
      }
      input.value = '';
    };
    input.click();
  }

  async function importJSON() {
    importFile('.json', async (text) => {
      await Storage.importData(text);
    });
  }

  async function importCSV() {
    importFile('.csv', async (text) => {
      await Storage.importCSV(text);
    });
  }

  async function resetAll() {
    if (!confirm('⚠️ 确定要重置所有数据吗？\n\n这将删除所有关键词、分组、站点规则和自定义样式配置。\n\n此操作不可撤销！')) return;
    if (!confirm('再次确认：真的要删除所有数据吗？')) return;
    
    await Storage.clear();
    await Storage.set(Storage.defaults);
    alert('已重置为默认设置');
    window.location.reload();
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ========== 通知内容脚本刷新 ==========
  async function notifyContentRefresh() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'refresh' }).catch(() => {});
    }
  }

  // ========== 工具函数 ==========
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========== 初始化 ==========
  // 帮助与隐私：按 h3 分组并渲染为横向标签分页，避免页面上无线往下拉长
  function initHelpCollapse() {
    const content = $('#section-help .help-content');
    if (!content) return;

    // 默认展示的功能说明组的标题关键字（用于定位默认激活的 tab）
    const DEFAULT_ACTIVE_KEY = '功能说明';

    // 按 h3 分组：h3 及之后直到下一个 h3 的所有内容为一组
    const groups = [];
    let cur = null;
    Array.from(content.children).forEach((node) => {
      if (node.tagName === 'H3') {
        cur = { title: node, body: [], key: node.textContent || '' };
        groups.push(cur);
      } else if (cur) {
        cur.body.push(node);
      }
    });
    if (groups.length === 0) return;

    content.innerHTML = '';

    // tab 导航条
    const tabBar = document.createElement('div');
    tabBar.className = 'help-tabs';

    // tab 面板区
    const panels = document.createElement('div');
    panels.className = 'help-tab-panels';

    let defaultIdx = 0;
    groups.forEach((g, idx) => {
      // 计算默认激活：优先「功能说明」组
      if (g.key.indexOf(DEFAULT_ACTIVE_KEY) !== -1) defaultIdx = idx;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'help-tab';
      tab.textContent = g.title.textContent;
      tab.dataset.idx = idx;

      const panel = document.createElement('div');
      panel.className = 'help-tab-panel';
      if (idx !== defaultIdx) panel.style.display = 'none';
      g.body.forEach((b) => panel.appendChild(b));

      tabBar.appendChild(tab);
      panels.appendChild(panel);
    });

    // 默认激活
    const tabs = Array.from(tabBar.children);
    if (tabs[defaultIdx]) tabs[defaultIdx].classList.add('active');

    // 切换逻辑
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.help-tab');
      if (!btn) return;
      const idx = parseInt(btn.dataset.idx, 10);
      tabs.forEach((t, i) => {
        t.classList.toggle('active', i === idx);
        panels.children[i].style.display = i === idx ? 'block' : 'none';
      });
    });

    content.appendChild(tabBar);
    content.appendChild(panels);
  }

  async function init() {
    initNavigation();

    // 支持从 popup/欢迎页跳转到指定分区（如 #help -> 帮助与隐私）
    if (location.hash === '#help') switchSection('help');

    // 关键词管理
    $('#btnAddKeyword')?.addEventListener('click', () => showKeywordModal());
    $('#btnEmptyAdd')?.addEventListener('click', () => showKeywordModal());

    // v1.6.36 弹窗章节折叠/展开
    document.querySelectorAll('.collapse-trigger').forEach(tr => {
      tr.addEventListener('click', () => {
        const sec = tr.closest('.collapsible');
        if (sec) sec.classList.toggle('closed');
      });
    });

    // v1.6.37 独立窗口「?add」模式：隐藏后台设置页，只显示「添加关键词」弹窗
    window.KH_ADD_MODE = new URLSearchParams(location.search).has('add');
    if (window.KH_ADD_MODE) {
      const layout = document.querySelector('.app-layout');
      if (layout) layout.style.display = 'none';
      document.body.style.background = '#f7f9fc';
      showKeywordModal();
    }
    $('#keywordSearch')?.addEventListener('input', () => { kwState.page = 1; loadKeywords(); });
    $('#groupFilter')?.addEventListener('change', () => { kwState.page = 1; loadKeywords(); });
    $('#statusFilter')?.addEventListener('change', () => { kwState.page = 1; loadKeywords(); });
    $('#regexFilter')?.addEventListener('change', () => { kwState.page = 1; loadKeywords(); });
    $('#sortFilter')?.addEventListener('change', () => { kwState.page = 1; loadKeywords(); });

    // 表头全选本页 / 批量栏本页全选
    $('#checkAllPage')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.checked = checked;
        if (checked) kwState.selected.add(cb.dataset.id);
        else kwState.selected.delete(cb.dataset.id);
      });
      refreshSelectionUI(document.querySelector('#keywordTableBody'));
    });
    $('#selectAllPage')?.addEventListener('change', (e) => {
      $('#checkAllPage').checked = e.target.checked;
      const checked = e.target.checked;
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.checked = checked;
        if (checked) kwState.selected.add(cb.dataset.id);
        else kwState.selected.delete(cb.dataset.id);
      });
      refreshSelectionUI(document.querySelector('#keywordTableBody'));
    });

    // 批量操作按钮
    initTableResize();
    document.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.bulk;
        switch (action) {
          case 'enable': bulkSetEnabled(true); break;
          case 'disable': bulkSetEnabled(false); break;
          case 'move': bulkMoveGroup(); break;
          case 'note': bulkEditNote(); break;
          case 'delete': bulkDelete(); break;
          case 'clear': bulkClear(); break;
        }
      });
    });
    $('#bulkNoteClose')?.addEventListener('click', closeBulkNote);
    $('#bulkNoteCancel')?.addEventListener('click', closeBulkNote);
    $('#bulkNoteSave')?.addEventListener('click', saveBulkNote);
    $('#bulkNoteModal')?.addEventListener('click', (e) => {
      if (e.target === $('#bulkNoteModal')) closeBulkNote();
    });
    $('#keywordModalClose')?.addEventListener('click', closeKeywordModal);
    $('#keywordModalCancel')?.addEventListener('click', closeKeywordModal);
    $('#keywordModalSave')?.addEventListener('click', saveKeyword);
    $('#keywordModal')?.addEventListener('click', (e) => {
      if (e.target === $('#keywordModal')) closeKeywordModal();
    });

    // 单元格标注 / 重要笔记 勾选时展开对应细节
    $('#editKwImportant')?.addEventListener('change', toggleKwSections);
    // v1.9.0 笔记底色：取色器 ↔ hex 输入 双向同步
    const syncNoteBgInputs = () => {
      const hex = $('#editKwImpBgHex'), color = $('#editKwImpBgColor');
      if (!hex || !color) return;
      let v = (hex.value || '').trim();
      if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      if (/^#[0-9a-fA-F]{6}$/.test(v)) color.value = v;
      else if (color.value) hex.value = color.value;
    };
    $('#editKwImpBgColor')?.addEventListener('input', () => { const c = $('#editKwImpBgColor').value; const hex = $('#editKwImpBgHex'); if (hex) hex.value = c; });
    $('#editKwImpBgHex')?.addEventListener('input', syncNoteBgInputs);
    $('#editKwImpBgHex')?.addEventListener('blur', syncNoteBgInputs);
    // 富文本笔记编辑器（所见即所得）：关键词编辑 / 分组编辑共用同一套命令与表格手柄。
    // 打开哪个弹窗就把 curNoteEd 指向哪个编辑器（见 showKeywordModal / showGroupModal），
    // 工具栏按钮点击时强制把 curNoteEd 指到对应编辑器后再执行。
    function wireNoteEditor(edEl, ids) {
      if (!edEl) return;
      const use = (fn) => () => { curNoteEd = edEl; fn(); };
      edEl.addEventListener('click', handleNoteEditorClick);
      edEl.addEventListener('paste', handleNoteEditorPaste);
      edEl.addEventListener('keyup', () => { trackTableCell(); positionTableHandle(); });
      edEl.addEventListener('keydown', trackTableCell);
      edEl.addEventListener('scroll', positionTableHandle);
      document.addEventListener('selectionchange', () => { if (document.activeElement === edEl) trackTableCell(); });
      $(ids.insertImg)?.addEventListener('click', use(insertNoteImage));
      $(ids.bold)?.addEventListener('click', use(() => runNoteCmd('bold')));
      $(ids.italic)?.addEventListener('click', use(() => runNoteCmd('italic')));
      $(ids.table)?.addEventListener('click', use(insertNoteTable));
      $(ids.link)?.addEventListener('click', use(insertNoteLink));
    }
    initTableHandle();
    wireNoteEditor($('#editKwImportantNote'), { insertImg: 'btnKwNoteInsertImg', bold: 'btnKwNoteBold', italic: 'btnKwNoteItalic', table: 'btnKwNoteTable', link: 'btnKwNoteLink' });
    wireNoteEditor($('#editGroupImpNoteRich'), { insertImg: 'btnGNoteInsertImg', bold: 'btnGNoteBold', italic: 'btnGNoteItalic', table: 'btnGNoteTable', link: 'btnGNoteLink' });
    // 说明文字均采用「ⓘ + 悬浮气泡」展示（CSS hover），无需 JS。


    // 分组管理
    $('#btnAddGroup')?.addEventListener('click', () => showGroupModal());
    $('#editGroupUseColor')?.addEventListener('change', () => {
      $('#editGroupColorRow').style.display = $('#editGroupUseColor').checked ? 'flex' : 'none';
    });
    $('#groupModalClose')?.addEventListener('click', closeGroupModal);
    $('#groupModalCancel')?.addEventListener('click', closeGroupModal);
    $('#groupModalSave')?.addEventListener('click', saveGroup);
    // v1.9.3 分组笔记底色：取色器 ↔ hex 输入双向同步（同关键词逻辑）
    const syncGroupBgInputs = () => {
      const hex = $('#editGroupImpBgHex'), color = $('#editGroupImpBgColor');
      if (!hex || !color) return;
      if (!/^#[0-9a-fA-F]{3,8}$/.test(hex.value.trim())) {
        hex.value = color.value;
      }
    };
    $('#editGroupImpBgColor')?.addEventListener('input', () => {
      const cColor = $('#editGroupImpBgColor'); const cHex = $('#editGroupImpBgHex');
      if (cColor && cHex) cHex.value = cColor.value;
    });
    $('#editGroupImpBgHex')?.addEventListener('input', syncGroupBgInputs);
    $('#editGroupImpBgHex')?.addEventListener('blur', syncGroupBgInputs);
    $('#groupModal')?.addEventListener('click', (e) => {
      if (e.target === $('#groupModal')) closeGroupModal();
    });

    // 高亮样式
    ['hlBgColor', 'hlTextColor', 'hlBorderColor'].forEach(id => {
      $(`#${id}`)?.addEventListener('input', () => {
        $(`#${id}Text`).value = $(`#${id}`).value;
        updateHighlightPreview();
        saveHighlightStyle();
      });
      $(`#${id}Text`)?.addEventListener('input', () => {
        $(`#${id}`).value = $(`#${id}Text`).value;
        updateHighlightPreview();
        saveHighlightStyle();
      });
    });
    ['hlBorderWidth', 'hlBorderRadius'].forEach(id => {
      $(`#${id}`)?.addEventListener('input', () => {
        updateHighlightPreview();
        saveHighlightStyle();
      });
    });
    $('#btnResetHighlightStyle')?.addEventListener('click', async () => {
      await Storage.set({ highlightStyle: Storage.defaults.highlightStyle });
      loadStyles();
      notifyContentRefresh();
    });

    // 备注卡片样式
    ['ncBgColor', 'ncTextColor', 'ncBorderColor'].forEach(id => {
      $(`#${id}`)?.addEventListener('input', () => {
        $(`#${id}Text`).value = $(`#${id}`).value;
        updateNoteCardPreview();
        saveNoteCardStyle();
      });
      $(`#${id}Text`)?.addEventListener('input', () => {
        $(`#${id}`).value = $(`#${id}Text`).value;
        updateNoteCardPreview();
        saveNoteCardStyle();
      });
    });
    ['ncBorderWidth', 'ncBorderRadius', 'ncMaxWidth', 'ncShadow', 'ncOpacity'].forEach(id => {
      $(`#${id}`)?.addEventListener('input', () => {
        updateNoteCardPreview();
        saveNoteCardStyle();
      });
    });
    $('#btnResetNoteCardStyle')?.addEventListener('click', async () => {
      await Storage.set({ noteCardStyle: Storage.defaults.noteCardStyle });
      loadNoteCardStyles();
      notifyContentRefresh();
    });

    // 站点规则
    $('#btnAddSiteRule')?.addEventListener('click', () => showSiteRuleModal());
    $('#siteRuleModalClose')?.addEventListener('click', closeSiteRuleModal);
    $('#siteRuleModalCancel')?.addEventListener('click', closeSiteRuleModal);
    $('#siteRuleModalSave')?.addEventListener('click', saveSiteRule);
    $('#siteRuleModal')?.addEventListener('click', (e) => {
      if (e.target === $('#siteRuleModal')) closeSiteRuleModal();
    });
    $('#editSiteRuleMatchType')?.addEventListener('change', updateSiteRuleHint);
    $('#editSiteRuleScope')?.addEventListener('change', () => {
      updateSiteRuleMatchOptions();
      updateSiteRuleHint();
    });

    // 导入导出
    $('#btnExportJSON')?.addEventListener('click', exportJSON);
    $('#btnExportCSV')?.addEventListener('click', exportCSV);
    $('#btnImportJSON')?.addEventListener('click', importJSON);
    $('#btnImportCSV')?.addEventListener('click', importCSV);
    $('#btnResetAll')?.addEventListener('click', resetAll);

    // 批量添加关键词
    $('#btnBatchImport')?.addEventListener('click', showBulkModal);
    $('#bulkModalClose')?.addEventListener('click', closeBulkModal);
    $('#bulkModalCancel')?.addEventListener('click', closeBulkModal);
    $('#bulkModalSave')?.addEventListener('click', saveBulk);
    $('#bulkModal')?.addEventListener('click', (e) => {
      if (e.target === $('#bulkModal')) closeBulkModal();
    });
    $('#bulkSeparator')?.addEventListener('change', updateBulkExample);
    $('#bulkCellMode')?.addEventListener('change', toggleBulkCellMode);

    // 初始加载
    loadKeywords();
    initHelpCollapse();
    buildHelpToc();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
