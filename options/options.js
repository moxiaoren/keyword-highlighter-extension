/* ============================================================================
 * options/options.js · 设置页逻辑
 * ----------------------------------------------------------------------------
 * 统一化约定（这就是"后续相关功能调用都统一"的落点）：
 *   · 读写配置 → 一律 `KH.Store.*`（不自己拼 chrome.storage 键名，不自己写默认值）
 *   · 字段映射 → 一律 `KH.FieldMap`（弹窗 / 批量栏 / CSV 同一份字段表）
 *   · 弹窗     → 一律 `KH.ui.Modal` / `KH.ui.openEditor`（底栏固定、Esc 关闭）
 *   · 版本号   → 一律 `chrome.runtime.getManifest()`（不从存储读）
 *   · 更新日志 → 一律 `window.CHANGELOG`（单源 src/ui/changelog.js）
 * 内容脚本侧无需接收"刷新"消息：写 storage 后由 `chrome.storage.onChanged`
 * 自动热更新（见 content/content.js）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = window.KH;
  const ui = KH.ui;
  const D = ui.dom;
  const { h, clear } = D;
  /** 字段表：全页唯一的字段声明来源（src/ui/fieldmap.js）。**必须放在 KH 之后** ——
   *  放到 KH 之前会踩 TDZ（`Cannot access 'KH' before initialization`），整个设置页白屏。 */
  const fm = KH.FieldMap;
  /** 注意：这里是 **getElementById** 语义（写 id 不带 #）；要写选择器请用 document.querySelector */
  const $ = (id) => document.getElementById(id);

  let cfg = null;            // 当前配置（KH.Store.load() 的结果）
  let table = null;          // 关键词表格实例
  let filtered = [];         // 当前筛选后的关键词
  let selection = new Set(); // 选中的关键词 id
  let updating = false;      // 自己写入 → storage 事件回环抑制

  /* ==================================================================== 工具 */

  const groupOf = (id) => (cfg.groups || []).find(g => g && g.id === id) || null;

  /** 关键词"实际生效底色"＝分组色 > 词色 > 全局默认（与内核 resolveVisual 同序） */
  function effectiveBg(kw) {
    const g = groupOf(kw.groupId);
    return (g && g.bgColor) || kw.bgColor || cfg.highlightStyle.defaultBgColor || '';
  }
  function effectiveImportant(kw) {
    const g = groupOf(kw.groupId);
    return !!(kw.important || (g && g.important));
  }
  function typeOf(kw) {
    if (kw.kind === 'rare' || String(kw.text || '').trim() === KH.Store.RARE_KEYWORD) return 'rare';
    if (kw.cellVerifyEnabled && kw.cellVerify) {
      if (!String(kw.text || '').trim() && String(kw.fetchLabels || '').trim()) return 'fetch';
      return (kw.comboAxis === 'tb') ? 'tb' : 'lr';
    }
    return 'plain';
  }

  /** 写 storage → 重新载入 → 重绘（唯一入口，避免各处各写一遍）
   *  写失败**必须说出口**：配额顶满 / 存储被禁用时旧写法让异常逃逸成 unhandled rejection
   *  （用户零提示），而界面已经按"写成功"的假设重渲染（C7 F-1）。 */
  async function mutate(fn) {
    updating = true;
    try {
      await fn();
      cfg = await KH.Store.load();
      renderAll();
    } catch (err) {
      D.toast('保存失败：' + ((err && err.message) || err), 'error');
      try { cfg = await KH.Store.load(); renderAll(); } catch (e2) { /* 读也失败：保持现状 */ }
    } finally {
      updating = false;
    }
  }

  async function reload() { cfg = await KH.Store.load(); renderAll(); }

  /* ==================================================================== 顶部 / 页脚 */

  function renderHeader() {
    const m = chrome.runtime.getManifest();
    $('version').textContent = 'v' + m.version;
    // 侧边栏底部的版本徽标：同样动态读 manifest（单一真源，绝不写版本字面量）
    $('sidebar-version').textContent = 'v' + m.version;
    $('ver-help').textContent = m.version;
    $('ver-build').textContent = (window.KH && window.KH.BUILD_TIME) || 'dev';
    $('foot-version').textContent = 'v' + m.version + ' · build ' + ((window.KH && window.KH.BUILD_TIME) || 'dev');

    const on = cfg.globalEnabled !== false;
    $('head-state').textContent = on ? '高亮已开启' : '已暂停';
    $('btn-toggle-global').textContent = on ? '暂停高亮' : '恢复高亮';
    updateSiteButton();
  }

  /**
   * 「当前站点开关」必须反映**当前站点**的状态 —— 固定文案"当前站点开关"会让它看起来
   * 像个不知道干嘛的按钮，和旁边的状态文字语义打架（用户审查 UI 时指出的那类问题）。
   * 状态来自内容脚本协议（与 popup 同一通道）；当前页没有内容脚本（chrome:// 等）时如实说明。
   */
  async function updateSiteButton() {
    const btn = $('btn-site-toggle');
    let host = '';
    let siteOn = null;   // true=高亮中 / false=已禁用 / null=未知（无内容脚本）
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) { try { host = new URL(tab.url).hostname || ''; } catch (_) { host = ''; } }
      if (tab && tab.id != null) {
        try {
          const st = await chrome.tabs.sendMessage(tab.id, { type: KH.MSG.STATE_QUERY });
          if (st && st.siteEnabled != null) siteOn = !!st.siteEnabled;
        } catch (_) { /* 该页没有内容脚本 */ }
      }
    } catch (_) { /* tabs 查询不可用 */ }
    const tag = host.length > 24 ? host.slice(0, 23) + '…' : host;
    btn.textContent = siteOn === null
      ? '本站开关（当前页不适用）'
      : (siteOn ? '本站：高亮中' + (tag ? ' · ' + tag : '')
                : '本站：已禁用' + (tag ? ' · ' + tag : ''));
  }

  $('btn-toggle-global').addEventListener('click', async () => {
    // 一律走统一协议，由 background 落盘 + 广播（不自己写 globalEnabled）
    const res = await chrome.runtime.sendMessage({ type: KH.MSG.GLOBAL_TOGGLE });
    if (res && res.ok === false) D.toast('切换失败：' + res.error, 'error');
    await reload();
  });

  $('btn-site-toggle').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: KH.MSG.SITE_TOGGLE });
    if (res && res.ok) D.toast(res.disabled ? ('已临时禁用 ' + res.host) : ('已恢复 ' + res.host), 'ok');
    else D.toast('无法解析当前标签页地址', 'error');
    await reload();
  });

  /* ==================================================================== ① 关键词管理 */

  const COLUMNS = [
    { key: '__check', class: 'col-check' },
    {
      key: 'text', class: 'col-kw', label: '关键词', sortable: true, width: 150,
      render(kw) {
        const txt = String(kw.text || '').trim() || (typeOf(kw) === 'fetch' ? '（仅抓取）' : '—');
        const box = h('div', { class: 'kh-kw-cell' });
        box.appendChild(h('span', { class: 'kh-kw-text', text: txt }));
        if (typeOf(kw) === 'rare') box.appendChild(h('span', { class: 'mr-chip mr-chip-rare', text: '罕见' }));
        /* 【为什么这里不再打「上下格」标签】用户实测："上下格匹配是在核心关键词增加一个上下格，
         * 左右格又没有区分 —— 这种区分方式有点怪"。方向是**这一对怎么写**的属性，
         * 挂在核心词上既不对称、也不是它自己的属性；现在统一挪到「标题词」列做前缀箭头
         * （见下面 cellVerify 列），核心词这一列只留"这个词本身是什么"的信息（如「罕见」）。 */
        return box;
      }
    },
    {
      key: 'match', class: 'col-kw-match', label: '核心词匹配', width: 104,
      title: '点击修改核心词匹配方式（在弹窗中勾选，保存即生效）',
      render(kw) {
        // 匹配规则以「胶囊 + 点开小弹窗」呈现（旧版 .kw-match-pill / .mr-chip 交互，保留）
        return ui.MatchChip.create({
          part: 'core',
          rare: typeOf(kw) === 'rare',
          value: kw,
          onChange: (patch) => mutate(() => KH.Store.patchKeywords([kw.id], () => patch))
        });
      }
    },
    {
      /* 【列名去掉"(左格)"】用户实测指出："标题词（左格）事实上，上下匹配也是这里展示" ——
       * 这一列同时承载左右格的标题词与上下格的表头词，写死"(左格)"是错的表述。
       * 方向改由**前缀箭头**表达（见 render），一眼就能区分两种组合方式。 */
      key: 'cellVerify', class: 'col-cell', label: '标题关键词', sortable: true, width: 124,
      title: '单元格组合的标题词：左右格模式下是左格标题，上下格模式下是表头列名（前缀箭头标方向：← 左格 / ↑ 表头）',
      render(kw) {
        const v = String(kw.cellVerify || '').trim();
        if (!v) return h('span', { class: 'kh-dim', text: '—' });
        const tb = kw.comboAxis === 'tb';
        /* 箭头语义：标题词**在哪个方位** —— ← 左格（左右格模式）/ ↑ 表头（上下格模式）。
         * 与核心词列解耦：方向属于"这一对"，不属于核心词自己。 */
        const arrow = h('span', {
          class: 'kh-axis-arrow' + (tb ? ' is-tb' : ''),
          text: tb ? '↑' : '←',
          title: tb ? '上下格：这个词是表头列名，核心词命中其下数据行的任意一行即算命中'
            : '左右格：这个词是左格标题，右侧单元格须含核心词'
        });
        return h('span', { class: 'kh-cell-label' }, [arrow, h('span', { text: v })]);
      }
    },
    {
      key: 'titleMatch', class: 'col-title-match', label: '标题词匹配', width: 104,
      title: '点击修改标题词匹配方式（需勾选「单元格组合」，在弹窗中勾选）',
      render(kw) {
        if (!(kw.cellVerifyEnabled && kw.cellVerify)) return h('span', { class: 'kh-dim', text: '—' });
        return ui.MatchChip.create({
          part: 'title', value: kw,
          onChange: (patch) => mutate(() => KH.Store.patchKeywords([kw.id], () => patch))
        });
      }
    },
    {
      key: 'imp', class: 'col-impnote', label: '重要笔记', width: 78,
      render(kw) {
        if (!effectiveImportant(kw)) return h('span', { class: 'kh-dim', text: '—' });
        const g = groupOf(kw.groupId);
        const fromGroup = !kw.important && g && g.important;
        return h('span', {
          class: 'imp-badge', text: '📌 重要',
          title: fromGroup ? ('由分组「' + (g.name || '') + '」标记为重要') : '该关键词标记为重要'
        });
      }
    },
    {
      /* 高亮颜色：**与编辑弹窗同形** —— 两个颜色胶囊（`●底` / `●文`），
       * 各点各开选色浮层、选完即落库（不用进编辑弹窗）。
       * 色点显示的是**有效色**（分组色 > 自身色 > 全局默认），
       * `is-on` 则表示"这个词自己设了色"（否则是继承来的）—— 两者信息都不丢，各在 tooltip 里写明。 */
      key: 'color', class: 'col-color', label: '高亮颜色', width: 104,
      render(kw) {
        const g = groupOf(kw.groupId);
        const bgEff = effectiveBg(kw);
        const fgEff = (g && g.textColor) || kw.textColor || cfg.highlightStyle.defaultTextColor;
        const fromGroupBg = !!(g && g.bgColor && !kw.bgColor);
        const fromGroupFg = !!(g && g.textColor && !kw.textColor);
        const box = h('span', { class: 'kh-row-ops' });

        const mk = (field, label, eff, own, fromGroup) => {
          const c = ui.ColorField.chip({
            label: label, dot: eff, on: !!own,
            title: label + '：' + (eff || '未设色')
              + (fromGroup ? '（继承分组「' + (g.name || '未命名') + '」）' : (own ? '（本词已设）' : '（跟随全局默认）'))
          });
          let pop = null;
          let committed = false;                 // 是否点过「确定」（决定关浮层时要不要还原色点）
          const original = kw[field] || '';
          const revertDot = () => {              // 还原色点：自己设过色 → 显示该色；否则显示继承来的有效色
            c.setValue(original);
            if (!original) c.setDot(eff);
          };
          c.el.addEventListener('click', (e) => {
            e.stopPropagation();
            pop = ui.Popover.open(c.el, ui.ColorField.panel({
              value: original,
              fallback: eff,          // 未设色时取色器从"继承来的有效色"起步
              /* 草稿预览：只更新色点，**不落库**；真正的落库在「确定」（onChange）。
               * 这样"拖动一半"或"点开看看"都不会改到配置（用户实测要求：加确认步骤）。 */
              onInput: (v) => {
                if (v) c.setValue(v);
                else { c.setValue(''); c.setDot(eff); }
              },
              onChange: (v) => {
                committed = true;
                c.setValue(v);
                if (!v) c.setDot(eff);
                mutate(() => KH.Store.patchKeywords([kw.id], () => ({ [field]: v })));
              },
              onDone: () => { if (pop) pop.close(); }        // 确定 / 取消都收浮层
            }), () => { if (!committed) revertDot(); });      // Esc / 点外面关掉 → 草稿丢弃，色点还原
          });
          return c.el;
        };

        box.appendChild(mk('bgColor', '底', bgEff, kw.bgColor, fromGroupBg));
        box.appendChild(mk('textColor', '文', fgEff, kw.textColor, fromGroupFg));
        return box;
      }
    },
    {
      key: 'group', class: 'col-group', label: '分组', sortable: true, width: 96,
      render(kw) {
        const g = groupOf(kw.groupId);
        return g ? h('span', { class: 'kh-group-tag', text: g.name || '(未命名)' })
          : h('span', { class: 'kh-dim', text: '—' });
      }
    },
    {
      key: 'note', class: 'col-note', label: '备注', sortable: true, width: 150,
      render(kw) {
        const t = String(kw.note || '').trim();
        return t ? ui.RichText.render(t, 'kh-note-cell') : h('span', { class: 'kh-dim', text: '—' });
      }
    },
    {
      key: 'status', class: 'col-status', label: '状态', width: 72,
      render(kw) {
        const on = kw.enabled !== false;
        const btn = h('button', {
          class: 'kh-switch-btn ' + (on ? 'is-on' : ''), type: 'button',
          /* 文案用「启用 / 停用」——与 v1.52.0 的胶囊口径一致，
           * 也跟同页其它地方（「点击停用」「批量 停用」）一致；原先的「已启用/已停用」是 v2 自己加长的。 */
          text: on ? '启用' : '停用', title: on ? '点击停用' : '点击启用'
        });
        btn.addEventListener('click', () => mutate(() => KH.Store.patchKeywords([kw.id], () => ({ enabled: !on }))));
        return btn;
      }
    },
    {
      /* 操作列：只剩 编辑 / 删除。
       * 「复制」已按用户要求去掉 —— v1.52.0 的操作列本来就只有 ✏️编辑 / 🗑️删除，
       * 复制是 v2 多加的；按钮样式也改成胶囊（见 options.css 的 .kh-link-btn）。
       * 列宽给到 112：两个胶囊各 ~46px + 间距 6 = 98，单元格内边距 16 → 需要 114 里的 ~98。
       * 原先的 96 正好卡在边界上（实测 78 = 78），换个字体/DPI 就会出问题
       * —— 布局不能靠"恰好装得下"，得留余量（见 设计偏好.md 第 4 条）。 */
      key: 'actions', class: 'col-actions', label: '操作', width: 112,
      render(kw) {
        const box = h('span', { class: 'kh-row-ops' });
        const edit = h('button', { class: 'kh-link-btn', type: 'button', text: '编辑' });
        const del = h('button', { class: 'kh-link-btn kh-link-danger', type: 'button', text: '删除' });
        edit.addEventListener('click', () => openKeyword(kw));
        del.addEventListener('click', () => removeKeywords([kw.id], '关键词「' + (String(kw.text || '').trim() || kw.cellVerify || '') + '」'));
        box.appendChild(edit); box.appendChild(del);
        return box;
      }
    }
  ];

  function passFilter(kw) {
    const q = ($('kw-search').value || '').trim().toLowerCase();
    if (q) {
      const hay = [kw.text, kw.cellVerify, kw.note, kw.importantNote, kw.fetchLabels]
        .map(v => String(v || '').toLowerCase()).join('\n');
      if (hay.indexOf(q) < 0) return false;
    }
    const g = $('kw-filter-group').value;
    if (g === '__none__') { if (kw.groupId) return false; }
    else if (g && kw.groupId !== g) return false;

    const st = $('kw-filter-status').value;
    if (st === 'on' && kw.enabled === false) return false;
    if (st === 'off' && kw.enabled !== false) return false;

    const ax = $('kw-filter-axis').value;
    if (ax && typeOf(kw) !== ax) return false;
    return true;
  }

  /**
   * 筛选栏「排序」的**唯一**实现（最近更新 / 最近添加 / 名称 A→Z / 名称 Z→A）。
   * `sortPref` 记在本页内存里：存储变化、批量操作都会触发整页重绘，
   * 只读 <select> 的话，用户刚选的排序会在下一次重绘时"悄悄回退成默认"。
   * 名称排序用 localeCompare('zh')：中文按拼音、英文按字母，混排不会退化成"按码点"。
   */
  const SORT_VALUES = ['updated-desc', 'created-desc', 'text-asc', 'text-desc'];
  let sortPref = SORT_VALUES[0];

  function sortState() {
    const v = ($('kw-filter-sort') || {}).value;
    if (SORT_VALUES.indexOf(v) >= 0) { sortPref = v; return v; }
    return SORT_VALUES.indexOf(sortPref) >= 0 ? sortPref : SORT_VALUES[0];
  }

  function createSortSpec() {
    const s = sortState();
    return {
      apply(a, b) {
        if (s === 'text-asc' || s === 'text-desc') {
          const dir = (s === 'text-asc') ? 1 : -1;
          const ta = String(a.text || '').trim() || String(a.cellVerify || '').trim();
          const tb = String(b.text || '').trim() || String(b.cellVerify || '').trim();
          const byName = ta.localeCompare(tb, 'zh');
          if (byName !== 0) return byName * dir;
          return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);   // 同名词按更新时间兜底，顺序才稳定
        }
        const key = (s === 'created-desc') ? 'createdAt' : 'updatedAt';
        return (Number(b[key]) || 0) - (Number(a[key]) || 0);
      }
    };
  }

  function renderKeywordTable() {
    const sel = $('kw-filter-group');
    const cur = sel.value;
    clear(sel);
    sel.appendChild(h('option', { value: '', text: '全部分组' }));
    sel.appendChild(h('option', { value: '__none__', text: '未分组' }));
    for (const g of cfg.groups || []) sel.appendChild(h('option', { value: g.id, text: g.name || '(未命名)' }));
    sel.value = (cur && Array.from(sel.options).some(o => o.value === cur)) ? cur : '';

    filtered = (cfg.keywords || []).filter(passFilter);
    // 选中集合只保留仍存在的 id（避免"删掉不可见的选中项"或删完残留计数）
    const alive = new Set((cfg.keywords || []).map(k => k.id));
    for (const id of Array.from(selection)) if (!alive.has(id)) selection.delete(id);

    const total = (cfg.keywords || []).length;
    $('kw-count').textContent = '共 ' + total + ' 条' + (filtered.length !== total ? '（筛出 ' + filtered.length + ' 条）' : '');

    if (!table) {
      table = ui.DataTable.create({
        columns: COLUMNS,
        rows: filtered,
        pageSize: 50,
        filterSort: createSortSpec(),
        getRowId: (kw) => kw.id,
        emptyText: total ? '没有符合筛选条件的关键词' : '还没有关键词，点筛选栏「＋ 添加」开始',
        onSelectionChange(sel2) { selection = sel2; syncBatchBar(); }
      });
      $('kw-table').appendChild(table.el);
    } else {
      table.setFilterSort(createSortSpec());
      table.setRows(filtered);
      table.setSelected(selection);
    }
    syncBatchBar();
  }

  function syncBatchBar() {
    const n = selection.size;
    // 文案与策划案 §5.2.1 对齐：常驻显示「已选 N 项」
    $('batch-info').textContent = '已选 ' + n + ' 项';
    for (const id of ['batch-enable', 'batch-disable', 'batch-group', 'batch-color', 'batch-match', 'batch-note', 'batch-delete', 'batch-clear']) {
      $(id).disabled = n === 0;
    }
    syncPageSelectAll();
  }

  /**
   * 「本页全选」与表头复选框必须**同源**：都取 DataTable 的 pageIds()。
   * 若这里自己按 filtered 切片算"本页"，一旦表格改了分页口径就会两处不一致
   * （一处选 50 条、另一处选 30 条这类诡异现象）。
   */
  function syncPageSelectAll() {
    const cb = $('batch-select-page');
    if (!cb) return;
    const ids = table ? table.pageIds() : [];
    const picked = ids.filter(id => selection.has(id)).length;
    cb.disabled = ids.length === 0;
    cb.checked = ids.length > 0 && picked === ids.length;
    cb.indeterminate = picked > 0 && picked < ids.length;
  }

  function openKeyword(kw) {
    ui.openEditor({ keyword: kw, cfg, onSaved: reload });
  }

  async function removeKeywords(ids, label) {
    const ok = await D.confirmBox('确定删除 ' + label + '？\n此操作不可撤销。', { title: '删除确认', danger: true, saveLabel: '删除' });
    if (!ok) return;
    await mutate(() => KH.Store.removeKeywords(ids));
    for (const id of ids) selection.delete(id);
    syncBatchBar();
    D.toast('已删除', 'ok');
  }

  $('btn-kw-add').addEventListener('click', () => ui.openEditor({ cfg, onSaved: reload }));
  $('kw-search').addEventListener('input', () => renderKeywordTable());
  $('kw-filter-group').addEventListener('change', () => renderKeywordTable());
  $('kw-filter-status').addEventListener('change', () => renderKeywordTable());
  $('kw-filter-axis').addEventListener('change', () => renderKeywordTable());
  $('kw-filter-sort').addEventListener('change', () => { sortState(); renderKeywordTable(); });
  $('btn-filter-reset').addEventListener('click', () => {
    $('kw-search').value = ''; $('kw-filter-group').value = '';
    $('kw-filter-status').value = ''; $('kw-filter-axis').value = '';
    $('kw-filter-sort').value = SORT_VALUES[0]; sortPref = SORT_VALUES[0];
    renderKeywordTable();
  });

  // 关键词管理页内的「📥 批量导入」：与「导入导出」共用同一条导入实现（见 importJSONText / importCSVText）
  $('btn-batch-import').addEventListener('click', () => { $('file-batch-import').value = ''; $('file-batch-import').click(); });
  $('file-batch-import').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importAnyFile(file);
  });

  /* ---------------- 批量栏 ---------------- */

  const batchIds = () => Array.from(selection);

  $('batch-enable').addEventListener('click', async () => {
    const n = selection.size;
    await mutate(() => KH.Store.patchKeywords(batchIds(), () => ({ enabled: true })));
    D.toast('已启用 ' + n + ' 条', 'ok');
  });
  $('batch-disable').addEventListener('click', async () => {
    const n = selection.size;
    await mutate(() => KH.Store.patchKeywords(batchIds(), () => ({ enabled: false })));
    D.toast('已停用 ' + n + ' 条', 'ok');
  });
  $('batch-clear').addEventListener('click', () => { table.clearSelection(); });

  /**
   * 「本页全选」：勾上=把**本页**所有行加入选中集合，再点一下=只把本页移出选中集合。
   * 语义刻意与表头复选框一致（旧版 `checkAllPage` 就是"本页"，跨页累选靠逐行勾选）：
   * "全选"若跨页，用户点一次删除就会清掉看不见的页，这是不可接受的破坏性误操作。
   */
  $('batch-select-page').addEventListener('change', (e) => {
    const ids = table ? table.pageIds() : [];
    if (e.target.checked) ids.forEach(id => selection.add(id));
    else ids.forEach(id => selection.delete(id));
    table.setSelected(selection);
  });

  /* ---- 批量弹窗的字段体构建：**统一走共享字段工厂** ----
   * 四个批量弹窗（分组 / 颜色 / 匹配 / 备注·笔记）原先各写一套控件形态：
   * 裸 `<select>`、旧色块、「真勾选框 + 两行文字」的行 —— 与关键词/分组弹窗的
   * 「开关胶囊 / 颜色胶囊 / id+for 契约」完全不是一套。这里统一收口。
   *
   * id 前缀用 `fld-b-`：批量字段与关键词字段有同名键（bgColor/note/importantNote…），
   * 同前缀会在弹窗堆叠时让"按 id 定位"产生歧义。
   */
  function fieldBody(specs, values, opts) {
    const o = opts || {};
    const prefix = o.idPrefix || 'fld-b-';
    const body = h('div', { class: o.cls || 'kh-editor-sec-body' });
    const controls = [], items = [], touched = new Set();
    for (const f of specs) {
      const c = ui.Fields.create(f, values[f.key], {
        idPrefix: prefix, groups: cfg.groups, imgSize: cfg.importantNote && cfg.importantNote.imgSize
      });
      controls.push(c);
      items.push({ spec: f, ctrl: c });
    }
    ui.Fields.layout(items, body);
    /* 记录"用户碰过哪些字段"：批量语义里"没碰过 = 不修改"，
     * 而 read() 只能给出当前值（胶囊未碰过也是"未选中"），所以需要单独记一笔。
     * 同时给胶囊打 `is-touched`：点两下＝显式关闭，用**虚线边框**跟"没碰过"区分开
     * （否则"关掉了"和"没动过"长得一模一样，用户没法预判保存后会写什么）。 */
    const mark = (e) => {
      const t = e.target;
      if (!t || !t.id || t.id.indexOf(prefix) !== 0) return;
      touched.add(t.id.slice(prefix.length));
      const chip = t.closest ? t.closest('.kh-fld-chip') : null;
      if (chip) chip.classList.add('is-touched');
    };
    body.addEventListener('change', mark, true);
    body.addEventListener('input', mark, true);
    return {
      body, controls, touched,
      read: () => { const out = {}; for (const c of controls) out[c.key] = c.read(); return out; }
    };
  }

  $('batch-group').addEventListener('click', () => {
    const specs = [{
      key: 'groupId', label: '移入分组', type: 'select', width: 2,
      options: [{ v: '', t: '（移出分组）' }].concat((cfg.groups || []).map(g => ({ v: g.id, t: g.name || '(未命名)' })))
    }];
    const fb = fieldBody(specs, { groupId: '' });
    ui.Modal.open({
      title: '批量设置分组（选中 ' + selection.size + ' 条）', size: 'sm',
      body: fb.body,
      onSave: async () => {
        const v = fb.read();
        await mutate(() => KH.Store.patchKeywords(batchIds(), () => ({ groupId: v.groupId || null })));
        D.toast('分组已更新', 'ok');
      }
    });
  });

  $('batch-color').addEventListener('click', () => {
    /* 颜色：与编辑弹窗同形的**颜色胶囊**（`● 底` / `● 文`），点开选色浮层。
     * "没点过 = 不修改"由 `spec.onChange` 保证 —— 只有真的选了色（或点了「清除」）才回调。 */
    let bg = null, fg = null;
    const specs = [
      { key: 'bgColor', label: '底色', short: '底', type: 'color', chip: true,
        hint: '批量设置背景色（点「清除」＝设为继承）', onChange: (v) => { bg = v; } },
      { key: 'textColor', label: '文字颜色', short: '文', type: 'color', chip: true,
        hint: '批量设置文字颜色（点「清除」＝设为继承）', onChange: (v) => { fg = v; } }
    ];
    const fb = fieldBody(specs, { bgColor: '', textColor: '' });
    ui.Modal.open({
      title: '批量设置颜色（选中 ' + selection.size + ' 条）', size: 'sm',
      body: h('div', { class: 'kh-editor-sec-body' }, [
        h('p', { class: 'kh-muted', text: '没点过的颜色不会被修改；点「清除」＝设为继承（回退到分组色 / 全局默认色）。' }),
        fb.body
      ]),
      onSave: async () => {
        const patch = {};
        if (bg !== null) patch.bgColor = bg;
        if (fg !== null) patch.textColor = fg;
        if (!Object.keys(patch).length) { D.toast('请先选择要修改的颜色（或用「清除」）', 'info'); return false; }
        await mutate(() => KH.Store.patchKeywords(batchIds(), () => patch));
        D.toast('颜色已更新', 'ok');
      }
    });
  });
  /**
   * 批量「⚙️ 匹配」—— 必须覆盖**两组共 6 个开关**：
   *   核心词：caseSensitive / wholeWord / useRegex
   *   标题词：cellVerifyMatchMode(exact) / cellVerifyCaseSensitive / cellVerifyUseRegex
   * 旧版 v1.52.0 就是 6 项；只做 3 项会让"批量设标题词规则"这个刚需整块缺失。
   *
   * 为什么用浮层而不是模态：策划案 §5.2.1 要求匹配规则"点开是小勾选弹窗"，
   * 这里复用胶囊弹窗的浮层实现（options.js 不再另写第二套浮层）。
   *
   * ★ 文案**直接取自 `chip.js` 的 PARTS**（匹配开关文案的唯一来源）——
   *   原先这里手写了 `区分大小写` / `整词`，于是「大小写 → Aa」那次全局改名它没跟上：
   *   同一个开关在表格里叫 `Aa`、在批量弹窗里叫"区分大小写"、还多一个"整词"。
   *   改成从 PARTS 派生之后，这类漂移在结构上不可能再发生。
   *
   * 标题词 3 项会**跳过非组合词**（普通词没有标题格，硬写 cellVerify* 就是脏数据）。
   */
  $('batch-match').addEventListener('click', () => {
    const ids = batchIds();
    const comboIds = ids.filter(id => {
      const kw = (cfg.keywords || []).find(k => k.id === id);
      return !!(kw && kw.cellVerifyEnabled && kw.cellVerify);
    });
    const P = ui.MatchChip.PARTS;
    /* PARTS 里 `type: "exact"` 的是"两态"字段（include ↔ exact）—— 工厂的 select+chip 支持两态胶囊 */
    const specOf = (f) => (f.type === 'exact'
      ? { key: f.key, label: f.label, hint: f.hint, type: 'select', chip: true, onValue: 'exact', offValue: 'include' }
      : { key: f.key, label: f.label, hint: f.hint, type: 'bool', chip: true });
    const coreFb = fieldBody(P.core.fields.map(specOf), {});
    const titleFb = fieldBody(P.title.fields.map(specOf), {});
    const panel = h('div', { class: 'kh-pop-inner' }, [
      h('div', { class: 'kh-pop-title', text: '批量匹配方式（共 ' + ids.length + ' 条）' }),
      h('div', { class: 'kh-pop-group-title', text: '核心词 · 全部选中项' }),
      coreFb.body,
      h('div', { class: 'kh-pop-group-title', text: '标题词（需勾选「单元格组合」）· ' + comboIds.length + ' 条' }),
      titleFb.body,
      h('div', { class: 'kh-pop-foot', text: comboIds.length
        ? '点一下就开启，再点一下=关闭（虚线框）；没点过的项不会被修改。'
        : '⚠️ 选中项里没有组合词：标题词 3 项会被跳过（普通词没有标题格）。' })
    ]);
    let pop = null;
    const applyBtn = h('button', { class: 'kh-mini-btn kh-pop-apply', type: 'button', text: '应用到选中的 ' + ids.length + ' 条' });
    applyBtn.addEventListener('click', async () => {
      /* 只有"点过"的项才写进 patch：没点过＝保持原样；点两下＝显式关闭（false / include）。
       * 胶囊的初始态是未选中，所以不能只看 read() 的布尔值（那分不出"没碰过"和"关掉了"）。 */
      const coreVals = coreFb.read(), titleVals = titleFb.read();
      const corePatch = {}, titlePatch = {};
      for (const k of Object.keys(coreVals)) if (coreFb.touched.has(k)) corePatch[k] = coreVals[k];
      for (const k of Object.keys(titleVals)) if (titleFb.touched.has(k)) titlePatch[k] = titleVals[k];
      const hasCore = Object.keys(corePatch).length > 0;
      const hasTitle = Object.keys(titlePatch).length > 0 && comboIds.length > 0;
      if (!hasCore && !hasTitle) { D.toast('请先点选要应用的匹配项', 'info'); return; }
      if (pop) pop.close();
      await mutate(() => KH.Store.patchKeywords(ids, (kw) => {
        // 每次 patch 都重新算：标题词只给"当前这条确实是组合词"的行
        const p = Object.assign({}, corePatch);
        if (kw && kw.cellVerifyEnabled && kw.cellVerify) Object.assign(p, titlePatch);
        return p;
      }));
      D.toast('已更新 ' + ids.length + ' 条匹配方式', 'ok');
    });
    panel.appendChild(h('div', { class: 'kh-pop-actions' }, [applyBtn]));
    pop = ui.Popover.open($('batch-match'), panel, null, { className: 'kh-popover-wide' });
  });

  $('batch-note').addEventListener('click', () => {
    /* 两个"开关胶囊 + 对应编辑器"：开关没勾就不写该字段（内容留空＝清空）。
     * 开关用胶囊、编辑器用 RichEditor —— 与关键词/分组弹窗同一套控件语言。 */
    const specs = [
      { key: 'setNote', label: '备注', type: 'bool', chip: true, hint: '勾选后才会覆盖选中项的备注（留空＝清空）' },
      { key: 'note', label: '备注内容', type: 'textarea', rows: 3, width: 2, placeholder: '留空＝清空该字段' },
      { key: 'setImp', label: '重要笔记', type: 'bool', chip: true, hint: '勾选后才会覆盖选中项的重要笔记（留空＝清空）' },
      { key: 'importantNote', label: '重要笔记内容', type: 'richtext', width: 2,
        placeholder: '与页面显示一致：图片、加粗、表格、链接直接在框内显示；留空＝清空' }
    ];
    const fb = fieldBody(specs, {});
    ui.Modal.open({
      title: '批量备注 / 重要笔记（选中 ' + selection.size + ' 条）', size: 'md',
      body: h('div', { class: 'kh-editor-sec-body' }, [
        h('p', { class: 'kh-muted', text: '先点选要修改的字段：没点的字段不会被修改，内容留空表示清空该字段。' }),
        fb.body
      ]),
      onSave: async () => {
        const v = fb.read();
        const patch = {};
        if (v.setNote) patch.note = v.note || '';
        if (v.setImp) patch.importantNote = v.importantNote || '';
        if (!Object.keys(patch).length) { D.toast('请先勾选要修改的字段', 'info'); return false; }
        await mutate(() => KH.Store.patchKeywords(batchIds(), () => patch));
        D.toast('已更新', 'ok');
      }
    });
  });

  $('batch-delete').addEventListener('click', () => removeKeywords(batchIds(), '选中的 ' + selection.size + ' 条关键词'));

  /* ==================================================================== ② 分组 */

  function renderGroups() {
    const box = $('group-list');
    clear(box);
    const groups = cfg.groups || [];
    if (!groups.length) {
      box.appendChild(h('div', { class: 'kh-empty', text: '还没有分组。分组可统一配色，并整组标记「重要」。' }));
      return;
    }
    for (const g of groups) {
      const count = (cfg.keywords || []).filter(k => k.groupId === g.id).length;
      const row = h('div', { class: 'kh-group-row' }, [
        h('span', { class: 'kh-color-dot', style: 'background:' + (g.bgColor || cfg.highlightStyle.defaultBgColor), title: g.bgColor || '未设色（跟随全局默认）' }),
        h('span', { class: 'kh-group-name', text: g.name || '(未命名)' }),
        g.important ? h('span', { class: 'imp-badge', text: '📌 重要' }) : null,
        g.impNoteUseHlColor ? h('span', { class: 'kh-tag-mini', text: '复用底色' }) : null,
        h('span', { class: 'kh-group-count', text: count + ' 条关键词' })
      ]);
      const ops = h('span', { class: 'kh-row-ops' });
      const edit = h('button', { class: 'kh-link-btn', type: 'button', text: '编辑' });
      const del = h('button', { class: 'kh-link-btn kh-link-danger', type: 'button', text: '删除' });
      edit.addEventListener('click', () => openGroup(g));
      del.addEventListener('click', async () => {
        const ok = await D.confirmBox('删除分组「' + (g.name || '') + '」？\n组内 ' + count + ' 条关键词不会被删除，会移出分组。', { title: '删除分组', danger: true, saveLabel: '删除' });
        if (!ok) return;
        await mutate(() => KH.Store.removeGroup(g.id));
        D.toast('分组已删除', 'ok');
      });
      ops.appendChild(edit); ops.appendChild(del);
      row.appendChild(ops);
      box.appendChild(row);
    }
  }

  /**
   * 分组编辑弹窗：字段**全部由共享工厂渲染**（`ui.Fields.create` + `FieldMap.GROUP_FIELDS`），
   * 与关键词编辑弹窗同一套控件语言（开关胶囊 / 颜色胶囊 / 行内字段 / id+for 契约）。
   *
   * 与关键词弹窗**刻意不同**的两处（原版 1.52.0 就是如此，不是偷懒）：
   *   · 宽度 `md` 而不是 `lg` —— 原版分组弹窗是 `modal-sm`，本来就更小；6 个字段撑 860px 会大片留白；
   *   · **没有分区卡片** —— 原版分组弹窗是 `.form-group` 平铺；只有一张卡还带折叠标题没有意义。
   * 这两条如果用户要求统一，改这里即可（字段本身不用动）。
   */
  function openGroup(group) {
    const g = group || KH.Store.newGroup({});
    const fields = fm.GROUP_FIELDS;
    const body = h('div', { class: 'kh-editor-sec-body' });
    const controls = [];
    const items = [];

    for (const f of fields) {
      /* 取值口径复用 FieldMap.coerce（按 spec.type 收口），不再为分组另写一份 */
      const c = ui.Fields.create(f, fm.coerce(f, g[f.key]), {
        idPrefix: 'fld-g-', groups: cfg.groups, imgSize: g.imgSize
      });
      controls.push(c);
      items.push({ spec: f, ctrl: c });
    }
    // 胶囊成行 / 竖线分隔 / 半行整行流式：与关键词弹窗**共用同一份排布实现**（ui.Fields.layout）
    ui.Fields.layout(items, body);

    const readAll = () => {
      const out = {};
      for (const c of controls) out[c.key] = c.read();
      return out;
    };

    ui.Modal.open({
      title: group ? '编辑分组' : '新建分组', size: 'md',
      body: body,
      onSave: async () => {
        const v = readAll();
        const nm = String(v.name || '').trim();
        if (!nm) { D.toast('请填写分组名称', 'error'); return false; }
        const dup = (cfg.groups || []).find(x => x.name === nm && (!group || x.id !== group.id));
        if (dup) { D.toast('分组「' + nm + '」已存在', 'error'); return false; }
        await mutate(() => KH.Store.upsertGroup({
          id: group ? group.id : undefined, name: nm,
          bgColor: v.bgColor || '', textColor: v.textColor || '',
          important: !!v.important, impNoteUseHlColor: !!v.impNoteUseHlColor,
          importantNote: v.importantNote || '',
          imgSize: v.imgSize === '' || v.imgSize == null ? '' : v.imgSize
        }));
        D.toast(group ? '分组已保存' : '分组已创建', 'ok');
      }
    });
  }

  $('btn-group-add').addEventListener('click', () => openGroup(null));

  /* ==================================================================== ③ 高亮样式 */

  let hlBg = null, hlFg = null;

  async function saveNested(patch) {
    // 嵌套配置必须整体写（storage 侧只做一层合并，写半截会丢兄弟键）
    const next = {};
    for (const k of Object.keys(patch)) next[k] = Object.assign({}, cfg[k] || {}, patch[k]);
    await mutate(() => KH.Store.patch(next));
  }

  function renderHighlightStyle() {
    const hl = cfg.highlightStyle;
    /* 颜色控件统一成**颜色胶囊**（`● 底` / `● 文`），与编辑弹窗、批量弹窗同形。
     * `allowEmpty: false`：全局默认色必须有一个值（浮层里因此不会出现「清除」）。 */
    if (!hlBg) {
      hlBg = ui.ColorField.create({
        value: hl.defaultBgColor, allowEmpty: false, chip: true, label: '底',
        title: '全局默认背景色（关键词未单独设色时使用）',
        onChange: (v) => { if (v) saveNested({ highlightStyle: { defaultBgColor: v } }); }
      });
      hlFg = ui.ColorField.create({
        value: hl.defaultTextColor, allowEmpty: false, chip: true, label: '文',
        title: '全局默认文字色（关键词未单独设色时使用）',
        onChange: (v) => { if (v) saveNested({ highlightStyle: { defaultTextColor: v } }); }
      });
      $('hl-bg').appendChild(hlBg);
      $('hl-fg').appendChild(hlFg);
    } else {
      hlBg.setValue(hl.defaultBgColor);
      hlFg.setValue(hl.defaultTextColor);
    }
    $('hl-preview').style.background = hl.defaultBgColor;
    $('hl-preview').style.color = hl.defaultTextColor;
  }

  $('btn-hl-reset').addEventListener('click', async () => {
    await mutate(() => KH.Store.patch({ highlightStyle: KH.Config.defaults.highlightStyle }));
    D.toast('已恢复默认高亮色', 'ok');
  });

  /* ==================================================================== ④ 备注卡片 */

  /* 字段清单已收进 `fm.NOTE_CARD_FIELDS`（原先这里另有一份 NC_FIELDS，与其它表单各写一套） */

  function renderNoteCardStyle() {
    const box = $('nc-fields');
    clear(box);
    /* 统一走共享字段工厂：三个颜色是与编辑弹窗同形的**颜色胶囊**，
     * 其余是带 `id=fld-nc-<key>` + label for 的文本字段（原来手写、没有 id）。 */
    const values = {};
    for (const f of fm.NOTE_CARD_FIELDS) values[f.key] = cfg.noteCardStyle[f.key];
    const items = [];
    for (const f of fm.NOTE_CARD_FIELDS) {
      const spec = f.type === 'color'
        ? Object.assign({}, f, { onChange: (v) => { if (v) saveNested({ noteCardStyle: { [f.key]: v } }); } })
        : Object.assign({}, f, { onChange: undefined });
      const c = ui.Fields.create(spec, values[f.key], { idPrefix: 'fld-nc-' });
      items.push({ spec, ctrl: c });
      if (f.type !== 'color') {
        /* 文本类字段没有 spec.onChange 通道：直接监听内部 input 的 change（与旧实现同语义） */
        const inp = c.el.querySelector('input');
        if (inp) inp.addEventListener('change', () => saveNested({ noteCardStyle: { [f.key]: inp.value } }));
      }
    }
    ui.Fields.layout(items, box);
    const s = cfg.noteCardStyle;
    const pv = $('nc-preview');
    pv.style.background = s.bgColor;
    pv.style.color = s.textColor;
    pv.style.border = s.borderWidth + ' solid ' + s.borderColor;
    pv.style.borderRadius = s.borderRadius;
    pv.style.boxShadow = s.shadow;
    pv.style.maxWidth = s.maxWidth;
    pv.style.opacity = s.opacity;
    pv.style.fontSize = s.fontSize;
  }

  $('btn-nc-reset').addEventListener('click', async () => {
    await mutate(() => KH.Store.patch({ noteCardStyle: KH.Config.defaults.noteCardStyle }));
    D.toast('已恢复默认卡片样式', 'ok');
  });

  /* ==================================================================== ⑤ 站点 */

  /* 文案单一来源在 FieldMap（弹窗下拉与列表展示共用一套，避免"同一个下拉两套说法"） */
  const SCOPE_TEXT = fm.SITE_SCOPE_TEXT;
  const MATCH_TEXT = fm.SITE_MATCH_TEXT;

  function renderSites() {
    const box = $('site-rule-list');
    clear(box);
    const rules = cfg.siteRules || [];
    if (!rules.length) {
      box.appendChild(h('div', { class: 'kh-empty', text: '还没有站点规则：默认所有网站都会高亮。' }));
    } else {
      for (const r of rules) {
        const isWhite = r.type === 'whitelist';
        const row = h('div', { class: 'kh-site-row' }, [
          h('span', { class: 'kh-tag ' + (isWhite ? 'kh-tag-ok' : 'kh-tag-no'), text: isWhite ? '✅ 白名单' : '🚫 黑名单' }),
          h('span', { class: 'kh-site-pattern', text: r.pattern }),
          h('span', { class: 'kh-site-meta', text: (SCOPE_TEXT[r.scope] || '域名') + ' · ' + (MATCH_TEXT[r.matchType] || '精确') })
        ]);
        const ops = h('span', { class: 'kh-row-ops' });
        const edit = h('button', { class: 'kh-link-btn', type: 'button', text: '编辑' });
        const del = h('button', { class: 'kh-link-btn kh-link-danger', type: 'button', text: '删除' });
        edit.addEventListener('click', () => openSiteRule(r));
        del.addEventListener('click', async () => {
          const ok = await D.confirmBox('删除规则「' + r.pattern + '」？', { title: '删除站点规则', danger: true, saveLabel: '删除' });
          if (!ok) return;
          await mutate(() => KH.Store.patch({ siteRules: (cfg.siteRules || []).filter(x => x !== r) }));
        });
        ops.appendChild(edit); ops.appendChild(del);
        row.appendChild(ops);
        box.appendChild(row);
      }
    }

    const dis = $('site-disabled-list');
    clear(dis);
    const hosts = Object.keys(cfg.siteDisabledMap || {});
    if (!hosts.length) {
      dis.appendChild(h('span', { class: 'kh-muted', text: '当前没有被临时禁用的站点。' }));
    } else {
      for (const host of hosts) {
        const btn = h('button', { class: 'kh-mini-btn', type: 'button', text: host + ' ✕', title: '点击恢复该站点高亮' });
        btn.addEventListener('click', async () => {
          const map = Object.assign({}, cfg.siteDisabledMap);
          delete map[host];
          await mutate(() => KH.Store.patch({ siteDisabledMap: map }));
        });
        dis.appendChild(btn);
      }
    }
  }

  function openSiteRule(rule) {
    const r = rule || { type: 'blacklist', pattern: '', matchType: 'exact', scope: 'domain' };
    /* 统一走共享字段工厂（原先是四处手写 `.kh-fld`，没有 id/for） */
    const fb = fieldBody(fm.SITE_RULE_FIELDS, r, { idPrefix: 'fld-sr-' });

    ui.Modal.open({
      title: rule ? '编辑站点规则' : '添加站点规则', size: 'sm',
      body: fb.body,
      onSave: async () => {
        const v = fb.read();
        const p = String(v.pattern || '').trim();
        if (!p) { D.toast('请填写站点或网址', 'error'); return false; }
        const item = { type: v.type, pattern: p, matchType: v.matchType, scope: v.scope };
        const list = (cfg.siteRules || []).slice();
        const idx = rule ? list.indexOf(rule) : -1;
        if (idx >= 0) list[idx] = item; else list.push(item);
        await mutate(() => KH.Store.patch({ siteRules: list }));
        D.toast('站点规则已保存', 'ok');
      }
    });
  }

  $('btn-site-add').addEventListener('click', () => openSiteRule(null));

  /* ==================================================================== ⑥ 导入导出 */

  const expScope = () => ({
    keywords: $('exp-keywords').checked,
    siteRules: $('exp-site').checked,
    siteDisabled: $('exp-disabled').checked,
    styles: $('exp-styles').checked
  });
  const impScope = () => ({
    keywords: $('imp-keywords').checked,
    siteRules: $('imp-site').checked,
    siteDisabled: $('imp-disabled').checked,
    styles: $('imp-styles').checked
  });
  const impMode = () => (document.querySelector('input[name=imp-mode]:checked') || {}).value || 'merge';

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  $('btn-export-json').addEventListener('click', () => {
    const sc = expScope();
    if (!sc.keywords && !sc.siteRules && !sc.siteDisabled && !sc.styles) { D.toast('请至少勾选一块内容', 'error'); return; }
    KH.Store.download('keyword-highlighter-' + stamp() + '.json', KH.Store.exportJSON(sc, cfg), 'application/json');
    D.toast('已导出 JSON', 'ok');
  });

  $('btn-export-csv').addEventListener('click', () => {
    KH.Store.download('keyword-highlighter-keywords-' + stamp() + '.csv', KH.Store.exportCSV(cfg), 'text/csv');
    D.toast('已导出 CSV（关键词、组合方向等 18 列）', 'ok');
  });

  /* Excel 表格导出：.xls = HTML 单表，Excel 原生识别 */

  $('btn-export-xls').addEventListener('click', () => {

    KH.Store.download('keyword-highlighter-keywords-' + stamp() + '.xls', KH.Store.exportExcelTable(cfg), 'application/vnd.ms-excel');

    D.toast('已导出 Excel 表格（可直接用 Excel 打开）', 'ok');

  });

  $('btn-import-json').addEventListener('click', () => { $('file-json').value = ''; $('file-json').click(); });
  $('btn-import-csv').addEventListener('click', () => { $('file-csv').value = ''; $('file-csv').click(); });

  /**
   * JSON 导入 —— **唯一实现**。
   * 「导入导出」页两个按钮和「关键词管理」页的批量导入都走这里：
   * 导入是要覆盖/合并用户数据的破坏性操作，绝不能存在第二份"简化版"逻辑
   * （两份逻辑迟早一份忘了确认框、一份忘了勾选范围）。
   */
  async function importJSONText(text) {
    let preview = null;
    try { preview = KH.Store.previewJSON(text); } catch (err) { D.toast('JSON 解析失败：' + err.message, 'error'); return; }
    const has = preview.has;
    const sc = impScope();
    const nothing = !(sc.keywords && has.keywords) && !(sc.siteRules && has.siteRules)
      && !(sc.siteDisabled && has.siteDisabled) && !(sc.styles && has.styles);
    if (nothing) { D.toast('文件内容与勾选范围没有交集，请调整勾选', 'error'); return; }

    const mode = impMode();
    const lines = [
      '文件包含：' + [has.keywords ? '关键词' : '', has.siteRules ? '站点规则' : '', has.siteDisabled ? '禁用状态' : '', has.styles ? '样式配置' : ''].filter(Boolean).join('、'),
      '导入方式：' + (mode === 'merge' ? '合并（追加去重）' : '覆盖（替换被勾选的块）')
    ];
    if (mode === 'overwrite') lines.push('', '⚠️ 覆盖会清掉现有对应数据，建议先导出备份。');
    const ok = await D.confirmBox(lines.join('\n'), { title: '确认导入', danger: mode === 'overwrite', saveLabel: '开始导入' });
    if (!ok) return;
    try {
      let stats = null;
      await mutate(async () => { stats = await KH.Store.importJSON(text, { include: sc, mode }, cfg); });
      D.toast('导入完成：新增关键词 ' + stats.keywords + ' 条 / 分组 ' + stats.groups + ' 个 / 站点规则 ' + stats.siteRules + ' 条', 'ok');
    } catch (err) {
      D.toast('导入失败：' + err.message, 'error');
    }
  }

  /** CSV 导入 —— 同上，唯一实现（列数 17/18 兼容由 Store.importCSV 负责） */
  async function importCSVText(text) {
    try {
      let stats = null;
      await mutate(async () => { stats = await KH.Store.importCSV(text, cfg); });
      D.toast('CSV 导入完成：新增 ' + stats.added + ' 条，跳过重复 ' + stats.skipped + ' 条'
        + (stats.groupsCreated ? '，新建分组 ' + stats.groupsCreated + ' 个' : ''), 'ok');
    } catch (err) {
      D.toast('CSV 导入失败：' + err.message, 'error');
    }
  }

  /**
   * 「📥 批量导入」：一个入口吃 CSV + JSON（按扩展名分发，扩展名缺失时按 MIME 兜底）。
   * 比让用户先想清楚"我要导的是哪种格式"更省事，且两条分支各自复用的仍是同一份实现。
   */
  async function importAnyFile(file) {
    if (!file) return;
    const name = String(file.name || '');
    const isCsv = /\.csv$/i.test(name) || (!/\.json$/i.test(name) && /csv/i.test(file.type || ''));
    const text = await file.text();
    if (isCsv) await importCSVText(text);
    else await importJSONText(text);
  }

  $('file-json').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importJSONText(await file.text());
  });

  $('file-csv').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importCSVText(await file.text());
  });

  $('btn-reset').addEventListener('click', async () => {
    const sc = {
      keywords: $('rst-keywords').checked,
      siteRules: $('rst-site').checked,
      siteDisabled: $('rst-site').checked,
      styles: $('rst-styles').checked
    };
    if (!sc.keywords && !sc.siteRules && !sc.styles) { D.toast('请至少勾选一块内容', 'error'); return; }
    const ok = await D.confirmBox(
      '将清空：' + [sc.keywords ? '关键词与分组' : '', sc.siteRules ? '站点规则/禁用状态' : '', sc.styles ? '样式与配置' : ''].filter(Boolean).join('、')
      + '\n\n⚠️ 此操作不可撤销，建议先导出备份。',
      { title: '重置数据', danger: true, saveLabel: '确认重置' }
    );
    if (!ok) return;
    await mutate(() => KH.Store.reset(sc, cfg));
    D.toast('已重置', 'ok');
  });

  /* ==================================================================== ⑦ 匹配默认值与性能 */

  const PF_KEYS = ['shadowDOMEnabled', 'suspendInactiveTab', 'pageResidualClean', 'pageRebuildOnChange', 'scanCollapsedCustom'];

  function renderPerf() {
    const ms = cfg.matchSettings || {};
    $('ms-defaultCaseSensitive').checked = !!ms.defaultCaseSensitive;
    $('ms-defaultWholeWord').checked = !!ms.defaultWholeWord;
    $('ms-defaultUseRegex').checked = !!ms.defaultUseRegex;

    for (const k of PF_KEYS) $('pf-' + k).checked = !!cfg[k];
    $('pf-changeHandling').value = (cfg.changeHandling === 'always') ? 'always' : 'smart';
    $('pf-silent').value = cfg.pageRebuildSilentMs;
    $('pf-gap').value = cfg.pageRebuildGapMs;
    $('pf-imgSize').value = (cfg.importantNote || {}).imgSize || '';
  }

  for (const k of ['defaultCaseSensitive', 'defaultWholeWord', 'defaultUseRegex']) {
    $('ms-' + k).addEventListener('change', async (e) => {
      const on = e.target.checked;
      await saveNested({ matchSettings: { [k]: on } });
      D.toast(on ? '已设为新建默认（仅影响以后新建）' : '已取消该默认值', 'ok');
    });
  }

  for (const k of PF_KEYS) {
    $('pf-' + k).addEventListener('change', async (e) => {
      await mutate(() => KH.Store.patch({ [k]: e.target.checked }));
    });
  }

  /* 变更处理方式（K58）：smart = 相关性预筛（默认）；always = 任何变动都整页重建（旧行为、最保守） */
  $('pf-changeHandling').addEventListener('change', async () => {
    const v = ($('pf-changeHandling').value === 'always') ? 'always' : 'smart';
    await mutate(() => KH.Store.patch({ changeHandling: v }));
    D.toast(v === 'always'
      ? '已切换为保守：任何页面变动都会整页重建（更费资源）'
      : '已切换为智能：只在与命中相关时重建（省资源）', 'ok');
  });

  $('pf-silent').addEventListener('change', async () => {
    const v = Math.max(0, parseInt($('pf-silent').value, 10) || 0);
    await mutate(() => KH.Store.patch({ pageRebuildSilentMs: v }));
  });
  $('pf-gap').addEventListener('change', async () => {
    const v = Math.max(0, parseInt($('pf-gap').value, 10) || 0);
    await mutate(() => KH.Store.patch({ pageRebuildGapMs: v }));
  });
  $('pf-imgSize').addEventListener('change', async () => {
    const v = parseInt($('pf-imgSize').value, 10);
    await saveNested({ importantNote: { imgSize: (isNaN(v) || v <= 0) ? KH.Config.defaults.importantNote.imgSize : v } });
  });

  /* ==================================================================== ⑧ 更新日志（单源） */

  /**
   * 更新日志条目 → `<li>`：走 Markdown **单源**渲染（`toDocFragment` = 认 `` `行内代码` ``、
   * **不产出任何链接/图片**）。旧写法 `h('li', { text: String(t) })` 把 `**加粗**` 与
   * `` `命令` `` 的标记原样印给用户（全库 1,514 处 `**`、1,250 处反引号；C7 F-6），
   * 而"welcome 与 options 各写各的口径"正是这条缺陷的根因 —— 现在两处共用同一个入口。
   */
  function changelogLi(text) {
    const md = KH.Markdown;
    const li = document.createElement('li');
    let frag = null;
    if (md && typeof md.toDocFragment === 'function') {
      try { frag = md.toDocFragment(String(text), document); } catch (err) {
        console.warn('[KH] options：更新日志条目渲染失败，退回纯文本 ——', err && err.message);
      }
    }
    if (frag) li.appendChild(frag); else li.textContent = String(text);
    return li;
  }

  function renderChangelog() {
    const box = $('changelog-list');
    clear(box);
    const toc = $('ver-toc');
    if (toc) clear(toc);
    const list = (typeof window.CHANGELOG !== 'undefined' && Array.isArray(window.CHANGELOG)) ? window.CHANGELOG : [];
    if (!list.length) { box.appendChild(h('div', { class: 'kh-muted', text: '暂无更新日志' })); return; }
    // 全量渲染 + 为每条版本生成锚点，右侧悬浮目录可点击跳转
    for (const entry of list) {
      const items = Array.isArray(entry.items) ? entry.items : [String(entry.items || '')];
      const ver = String(entry.version || '');
      const lid = 'chg-' + ver.replace(/[^\w.]/g, '_');
      box.appendChild(h('div', { class: 'kh-log-item', id: lid }, [
        h('div', { class: 'kh-log-ver', text: ver }),
        h('ul', { class: 'kh-log-list' }, items.map(changelogLi))
      ]));
      if (toc) {
        toc.appendChild(h('a', {
          class: 'kh-ver-toc-item', href: '#' + lid, text: ver,
          on: { click: (ev) => {
            ev.preventDefault();
            const t = document.getElementById(lid);
            if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } }
        }));
      }
    }
    const foot = h('div', { class: 'kh-ver-foot' });
    const more = h('button', { class: 'kh-mini-btn', type: 'button', text: '查看完整更新日志（欢迎页）' });
    more.addEventListener('click', () => window.open('../welcome/welcome.html', '_blank'));
    foot.appendChild(more);
    box.appendChild(foot);
  }

  /* ==================================================================== 启动 */

  /**
   * 左侧固定侧边栏的分区（id 与 .kh-tab 的 data-tab 一一对应）。
   * 变更记录：
   *   · 原「匹配与性能」不再单独成区 —— 控件已并入「帮助与隐私」；
   *   · 原「高亮样式」+「备注卡片样式」两个分区**合并为「样式」**（用户 2026-09 要求：
   *     "两个菜单合并成样式，里面内容也合并起来"）—— 它们都是"全局默认外观"，分开只是多一次点击。
   *     ⚠️ 策划案里的 7 分区已被用户覆盖为 6 分区，改导航前先看 e2e 的"侧边栏分区"断言。
   */
  const SECTIONS = ['keywords', 'groups', 'style', 'ocr', 'sites', 'data', 'help'];

  function showSection(id) {
    const target = SECTIONS.indexOf(id) >= 0 ? id : 'keywords';
    for (const s of SECTIONS) {
      const sec = $('sec-' + s);
      if (sec) sec.hidden = (s !== target);
    }
    setActiveTab(target);
  }

  /** 高亮当前分区（点击与 hash 直达共用同一处，避免两套"谁在激活"的判断） */
  function setActiveTab(id) {
    for (const a of document.querySelectorAll('.kh-tab')) {
      const on = a.dataset.tab === id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  }

  function renderTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.kh-tab'));
    for (const a of tabs) {
      a.addEventListener('click', (e) => {
        // 自己切分区（不依赖浏览器对 #hash 的滚动）：切完回到内容顶部，否则会停在上一节的中段
        e.preventDefault();
        const id = a.dataset.tab;
        if (SECTIONS.indexOf(id) < 0) return;
        const sec = $('sec-' + id);
        if (sec) {
          try { history.replaceState(null, '', '#' + sec.id); } catch (err) { /* file:// 等场景忽略 */ }
        }
        showSection(id);
        const main = document.querySelector('.kh-main');
        if (main && main.scrollIntoView) main.scrollIntoView({ block: 'start' });
        else window.scrollTo(0, 0);
      });
    }
    // 帮助与隐私：内部二级 Tab 分页（一屏一类，逻辑独立、不干扰外层分区切换）
    const helpTabs = document.getElementById('help-tabs');
    if (helpTabs) {
      const helpPans = Array.prototype.slice.call(document.querySelectorAll('#sec-help .kh-hpanel'));
      helpTabs.addEventListener('click', (e) => {
        const b = e.target.closest('.kh-htab');
        if (!b) return;
        const pan = b.dataset.hpan;
        for (const tb of helpTabs.querySelectorAll('.kh-htab')) tb.classList.toggle('active', tb === b);
        for (const p of helpPans) p.classList.toggle('active', p.dataset.hpan === pan);
      });
    }

    // 支持从 popup / 欢迎页带 hash 跳进来（如 options.html#help）
    const fromHash = String(location.hash || '').replace(/^#sec-/, '').replace(/^#/, '');
    showSection(SECTIONS.indexOf(fromHash) >= 0 ? fromHash : 'keywords');
  }

  function renderAll() {
    renderHeader();
    renderKeywordTable();
    renderGroups();
    renderHighlightStyle();
    renderNoteCardStyle();
    renderOcr();
    renderSites();
    renderPerf();
  }

  /* ============================================================ 图片识别（OCR）
   * 语言包管理（下载 / 手动导入 / 清除 / 自检）+ 跨域图片的**按站点**授权。
   *
   * 【为什么语言包要有"手动导入"】隐私承诺是"除了本项目自己的语言包地址，不访问任何网络"。
   * 有些环境（内网/离线机）连那一次下载都不该发生 —— 那就把 `chi_sim.traineddata.gz` /
   * `eng.traineddata.gz` 手动选进来，全程零联网（校验里会标出"与官方包一致/来自本地文件"）。
   */
  let ocrWired = false;

  function ocrSend(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
      } catch (e) { resolve(null); }
    });
  }

  function ocrRow(key, info) {
    const row = document.createElement('div');
    row.className = 'kh-form-row';
    row.setAttribute('data-ocr-lang', key);

    const fld = document.createElement('div');
    fld.className = 'kh-form-fld';
    const name = document.createElement('div');
    name.className = 'kh-fld-label';
    name.textContent = (info.label || key) + '（' + key + '，' + Math.round((info.fileBytes || 0) / 1024) + ' KB）';
    const state = document.createElement('div');
    state.className = 'kh-muted';
    state.setAttribute('data-ocr-state', key);
    state.textContent = info.cached ? ('已就绪（本地缓存 ' + Math.round((info.cachedBytes || 0) / 1024) + ' KB）')
      : (info.local ? '已就绪（扩展目录里的离线包）' : '未下载');
    fld.appendChild(name);
    fld.appendChild(state);
    row.appendChild(fld);

    const mkBtn = (id, text, title) => {
      const b = document.createElement('button');
      b.className = 'kh-mini-btn';
      b.type = 'button';
      b.id = id;
      b.textContent = text;
      b.title = title;
      return b;
    };
    row.appendChild(mkBtn('btn-ocr-dl-' + key, '下载', '从项目主页下载并校验（sha256）后存到本地'));
    row.appendChild(mkBtn('btn-ocr-import-' + key, '手动导入', '选择本地的 ' + info.file + '（完全离线）'));
    row.appendChild(mkBtn('btn-ocr-clear-' + key, '清除', '删除本地缓存（下次需要重新下载或导入）'));
    return row;
  }

  /** 当前识别档位（K67）：fast（默认）/ best（高精度）。所有语言包操作都跟着它走。 */
  function ocrQuality() {
    return (cfg && cfg.imgOcr && cfg.imgOcr.quality) === 'best' ? 'best' : 'fast';
  }

  function renderOcrLangs() {
    const box = $('ocr-lang-list');
    if (!box) return;
    box.textContent = '语言包状态读取中…';
    return ocrSend({ type: KH.MSG.OCR_LANG_STATE, quality: ocrQuality() }).then((res) => {
      if (!res || !res.ok) { box.textContent = '读取失败：' + ((res && res.error) || '未知错误'); return; }
      box.textContent = '';
      const langs = (res.state && res.state.langs) || {};
      if (res.state && res.state.available === false) {
        const p = document.createElement('p');
        p.className = 'kh-muted';
        p.textContent = '本机还没有高精度语言包。请在下面的「语言包」里下载（只从本项目主页，下载后做 sha256 校验），'
          + '或在这台机器上用「手动导入」喂一个标准模型包（tessdata 的 chi_sim.traineddata）。'
          + '现在也可以先把档位留在「快速」。';
        box.appendChild(p);
      }
      for (const key of Object.keys(langs)) box.appendChild(ocrRow(key, langs[key]));
      const tip = document.createElement('p');
      tip.className = 'kh-muted';
      tip.textContent = '说明：下载只发生在本项目主页（moxiaoren.github.io），下载后会做 sha256 校验，校验不一致直接丢弃；'
        + '手动导入的包若与官方包一致会标注「校验一致」。引擎空闲约 90 秒后自动释放。';
      box.appendChild(tip);
    });
  }

  function renderOcrSites() {
    const box = $('ocr-site-list');
    if (!box) return;
    const map = (cfg && cfg.imgOcr && cfg.imgOcr.crossOriginSites) || {};
    const hosts = Object.keys(map).filter((h) => map[h]);
    box.textContent = '';
    if (!hosts.length) {
      const p = document.createElement('p');
      p.className = 'kh-muted';
      p.textContent = '（还没有授权任何站点：跨域图片会被标成「跨域（未授权）」）';
      box.appendChild(p);
      return;
    }
    for (const host of hosts) {
      const row = document.createElement('div');
      row.className = 'kh-form-row';
      row.setAttribute('data-ocr-site', host);
      const fld = document.createElement('div');
      fld.className = 'kh-form-fld';
      const t = document.createElement('div');
      t.className = 'kh-fld-label';
      t.textContent = host;
      fld.appendChild(t);
      row.appendChild(fld);
      const del = document.createElement('button');
      del.className = 'kh-mini-btn';
      del.type = 'button';
      del.textContent = '移除';
      del.addEventListener('click', () => {
        const next = Object.assign({}, (cfg.imgOcr && cfg.imgOcr.crossOriginSites) || {});
        delete next[host];
        mutate(() => KH.Store.patch({ imgOcr: Object.assign({}, cfg.imgOcr, { crossOriginSites: next }) }))
          .then(() => renderOcrSites());
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function renderOcr() {
    if (!$('sec-ocr')) return;
    if (!ocrWired) { ocrWired = true; wireOcr(); }
    const sel = $('ocr-quality');
    if (sel) sel.value = ocrQuality();
    renderOcrLangs();
    renderOcrSites();
  }

  function wireOcr() {
    const importFile = $('ocr-import-file');
    let importLang = '';

    document.addEventListener('click', (e) => {
      const id = e.target && e.target.id ? String(e.target.id) : '';
      let m = /^btn-ocr-dl-(.+)$/.exec(id);
      if (m) {
        const lang = m[1];
        e.target.disabled = true;
        e.target.textContent = '下载中…';
        ocrSend({ type: KH.MSG.OCR_LANG_DOWNLOAD, lang: lang, quality: ocrQuality() }).then((res) => {
          e.target.disabled = false;
          e.target.textContent = '下载';
          if (!res || !res.ok) { D.toast('下载失败：' + ((res && res.error) || '未知错误'), 'error'); return; }
          D.toast((res.verified ? '语言包已下载并校验通过' : '语言包已保存') + '（' + Math.round(res.bytes / 1024) + ' KB）', 'ok');
          renderOcrLangs();
        });
        return;
      }
      m = /^btn-ocr-import-(.+)$/.exec(id);
      if (m && importFile) { importLang = m[1]; importFile.value = ''; importFile.click(); return; }
      m = /^btn-ocr-clear-(.+)$/.exec(id);
      if (m) {
        ocrSend({ type: KH.MSG.OCR_LANG_CLEAR, langs: [m[1]], quality: ocrQuality() }).then((res) => {
          if (!res || !res.ok) { D.toast('清除失败', 'error'); return; }
          D.toast('已清除本地语言包', 'ok');
          renderOcrLangs();
        });
      }
    });

    if (importFile) {
      importFile.addEventListener('change', () => {
        const f = importFile.files && importFile.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          const b64 = String(fr.result || '').split(',')[1] || '';
          ocrSend({ type: KH.MSG.OCR_LANG_IMPORT, lang: importLang, base64: b64, name: f.name, quality: ocrQuality() }).then((res) => {
            if (!res || !res.ok) { D.toast('导入失败：' + ((res && res.error) || '未知错误'), 'error'); return; }
            D.toast(res.official ? '导入成功（sha256 与官方包一致）' : '导入成功（本地文件，未与官方包比对）', 'ok');
            renderOcrLangs();
          });
        };
        fr.readAsDataURL(f);
      });
    }

    const qualitySel = $('ocr-quality');
    if (qualitySel) {
      qualitySel.addEventListener('change', async () => {
        const q = qualitySel.value === 'best' ? 'best' : 'fast';
        await mutate(() => KH.Store.patch({ imgOcr: Object.assign({}, cfg.imgOcr, { quality: q }) }));
        D.toast(q === 'best'
          ? '已切换到高精度识别（更准、单张更慢；语言包按这一档单独保存，切换档位后才需要下载）'
          : '已切换到快速识别（省流量、更快）', 'ok');
        renderOcrLangs();          // 语言包状态按档位重读（两档各自独立）
      });
    }

    const addBtn = $('btn-ocr-site-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const inp = $('ocr-site-input');
        const host = String((inp && inp.value) || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
        if (!host) { D.toast('请输入站点域名，如 example.com', 'error'); return; }
        const next = Object.assign({}, (cfg.imgOcr && cfg.imgOcr.crossOriginSites) || {});
        next[host] = true;
        mutate(() => KH.Store.patch({ imgOcr: Object.assign({}, cfg.imgOcr, { crossOriginSites: next }) })).then(() => {
          if (inp) inp.value = '';
          D.toast('已允许读取 ' + host + ' 的跨域图片', 'ok');
          renderOcrSites();
        });
      });
    }

    const testBtn = $('btn-ocr-selftest');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        const out = $('ocr-selftest-result');
        const cv = document.createElement('canvas');
        cv.width = 520; cv.height = 80;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 520, 80);
        g.fillStyle = '#000'; g.font = '30px "Microsoft YaHei", SimHei, sans-serif';
        g.fillText('关键词自检 A12345', 12, 50);
        if (out) out.textContent = '识别中…';
        const done = (msg) => {
          if (out) {
            out.textContent = msg.ok
              ? ('✓ 识别成功（' + Math.round(msg.confidence || 0) + '% / ' + msg.ocrMs + 'ms）：' + String(msg.text || '').replace(/\s+/g, ' ').trim())
              : ('✗ ' + (msg.error || '识别失败') + (msg.code === 'lang-missing' ? ' —— 请先下载或导入语言包' : ''));
          }
        };
        chrome.runtime.onMessage.addListener(function once(m) {
          if (!m || m.type !== KH.MSG.OCR_RESULT || m.to !== 'ui') return false;
          chrome.runtime.onMessage.removeListener(once);
          done(m);
          return false;
        });
        ocrSend({ type: KH.MSG.OCR_IMAGE, dataUrl: cv.toDataURL('image/png'), keyword: '关键词' });
      });
    }
  }

  // 存储变化即重绘（popup 或其它标签页改配置时本页跟随；自己写入时跳过，避免抖动）
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || updating) return;
      reload().catch(() => { /* 扩展上下文失效时忽略 */ });
    });
  }

  /* 帮助卡里的快捷键 = `chrome.commands.getAll()` 的**真值**，不抄 manifest 的愿望。
   * 真机教训：open-settings 原本建议 `Ctrl+Shift+O`，被 Chrome 自带「书签管理器」占用后
   * 建议键被**静默丢弃**（getAll 回 shortcut:""），写死的卡面教用户按一个不存在的键。 */
  const KH_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  const KH_MAC_LABEL = { Command: '⌘', Ctrl: '⌘', MacCtrl: '⌃', Alt: '⌥' };
  async function renderShortcuts() {
    let cmds = null;
    try { cmds = await chrome.commands.getAll(); } catch (e) { return; }   // 读不到 → 保留静态兜底
    if (!Array.isArray(cmds)) return;
    for (const el of document.querySelectorAll('kbd[data-kh-cmd]')) {
      const hit = cmds.find((c) => c && c.name === el.dataset.khCmd);
      const parts = String((hit && hit.shortcut) || '').split('+').map(s => s.trim()).filter(Boolean);
      if (!parts.length) {
        el.textContent = '未分配';
        el.classList.add('is-unset');
        el.title = '浏览器没给这条命令分按键（多半被浏览器自带快捷键占用），可在扩展快捷键页自行设置';
        continue;
      }
      const shown = KH_MAC ? parts.map(p => KH_MAC_LABEL[p] || p) : parts;
      el.textContent = shown.join('+');
    }
  }

  reload().then(() => { renderChangelog(); renderTabs(); renderShortcuts(); }).catch(err => {
    console.error('[KH] 设置页初始化失败', err);
    D.toast('初始化失败：' + (err && err.message), 'error');
  });
})();
