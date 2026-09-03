/**
 * 置顶悬浮重要笔记组件
 * 当页面命中「重要」关键词（关键词自身重要 或 所属分组重要）且该关键词配置了重要笔记时，
 * 在页面右上角生成一个可移动、可展开/收起的小组件，聚合展示所有命中的重要笔记。
 *
 * 特性：
 * - 单页仅一个实例（幂等注入）
 * - 多条命中聚合展示，可单条关闭（本次页面会话内不再弹）
 * - 笔记内容一致的多个命中自动合并为一条，并在条目标签中列举命中了哪些关键词
 * - Shadow DOM 隔离样式，不污染页面
 * - 可拖动，默认右上角，不跨页面记忆位置
 */
const ImportantNote = {
  host: null,        // 宿主容器（实际挂在 document.body）
  root: null,        // shadow 内根
  panelEl: null,     // 展开态面板外壳（仅创建一次，避免重复播放入场动画导致闪烁）
  bodyEl: null,      // 面板条目容器
  countEl: null,     // 面板条数徽标
  minimized: false,  // 是否为收起态（圆形按钮）；默认展开
  items: [],         // 当前命中的笔记集合
  ignored: new Set(),// 本次页面会话内已忽略的笔记（按 note 文本）
  pos: { left: 0, top: 24 },
  dragState: null,
  observer: null,    // 独立 DOM 观察器（监听增/删/改，保证无命中时隐藏面板）
  _mutTimer: null,

  STYLE: `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .khin-wrap {
      position: fixed;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      user-select: none;
    }
    /* 收起态：圆形小按钮 */
    .khin-fab {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ff8a3d, #ff5722);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(255, 87, 34, 0.4);
      position: relative;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .khin-fab:hover { transform: scale(1.06); }
    .khin-fab-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      border-radius: 9px;
      background: #e53935;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      line-height: 18px;
      text-align: center;
      border: 2px solid #fff;
    }
    /* 展开态：面板 */
    .khin-panel {
      width: 360px;
      min-width: 220px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 24px);
      background: #fff;
      border: 1px solid #e3e3e3;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.18);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      resize: both;               /* 右下角拖拽调整大小（v1.6.43） */
      animation: khin-in 0.16s ease-out;
    }
    @keyframes khin-in {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .khin-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: linear-gradient(135deg, #fff7f0, #ffecdb);
      border-bottom: 1px solid #f3e0cf;
      cursor: move;
      flex-shrink: 0;
    }
    .khin-header-icon { font-size: 16px; }
    .khin-header-title { font-size: 14px; font-weight: 600; color: #bf360c; flex: 1; }
    .khin-header-count { font-size: 12px; color: #e64a19; background: #ffe0b2; border-radius: 10px; padding: 1px 8px; }
    .khin-header-btn {
      background: none; border: none; cursor: pointer; font-size: 15px;
      color: #8a8a8a; padding: 2px 4px; border-radius: 4px; line-height: 1;
    }
    .khin-header-btn:hover { color: #333; background: rgba(0,0,0,0.05); }
    .khin-body {
      flex: 1 1 auto;
      min-height: 0;
      max-height: none;
      overflow-y: auto;
      padding: 6px 0;
    }
    .khin-body::-webkit-scrollbar { width: 5px; }
    .khin-body::-webkit-scrollbar-thumb { background: #d8d8d8; border-radius: 3px; }
    .khin-body::-webkit-scrollbar-track { background: transparent; }
    .khin-item {
      padding: 9px 12px;
      border-bottom: 1px solid #f3f3f3;
    }
    .khin-item:last-child { border-bottom: none; }
    .khin-item-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 6px; margin-bottom: 5px;
    }
    .khin-item-tags {
      display: flex; flex-wrap: wrap; gap: 5px; flex: 1; min-width: 0;
    }
    .khin-item-kw {
      font-size: 12px; font-weight: 600; color: #e64a19;
      background: #fff1e6; border-radius: 4px; padding: 1px 7px;
      max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex-shrink: 0;
    }
    .khin-item-adj {
      font-size: 12px; font-weight: 600; color: #2e7d32;
      background: #e8f5e9; border-radius: 4px; padding: 1px 7px;
      max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex-shrink: 0;
    }
    /* 内容/标签支持选中复制（v1.7.9）；面板外壳 keep user-select:none 仅避免误选 */
    .khin-item-body, .khin-item-tags, .khin-item-kw, .khin-item-adj, .kh-table {
      user-select: text; -webkit-user-select: text;
    }
    .khin-item-body::selection, .khin-item-tags::selection,
    .khin-item-kw::selection, .khin-item-adj::selection,
    .kh-table ::selection { background: #a6d3ff; color: inherit; }
    .khin-item-close {
      background: none; border: none; cursor: pointer;
      color: #bbb; font-size: 13px; padding: 2px 4px; border-radius: 4px; line-height: 1;
      flex-shrink: 0;
    }
    .khin-item-close:hover { color: #e53935; background: #ffe9e9; }
    .khin-item-body {
      font-size: 13px; line-height: 1.6; color: #333;
      white-space: pre-wrap;   /* 保留换行等排版格式 */
      word-break: break-word; overflow-wrap: break-word;
    }
    .khin-item-body a { color: #1a73e8; text-decoration: none; }
    .khin-item-body a:hover { text-decoration: underline; }
    /* 重要笔记内图片（v1.8.0），自适应不撑破面板 */
    .khin-item-body img { max-width: 100%; height: auto; border-radius: 4px; margin: 4px 0; display: block; }
    .khin-empty { padding: 20px; text-align: center; color: #aaa; font-size: 13px; }
    /* 抓取后续字段渲染的 Excel 表格 */
    .kh-table { border-collapse: collapse; margin-top: 4px; width: 100%; }
    .kh-table td { border: 1px solid #d3dae3; padding: 3px 8px; font-size: 12px; line-height: 1.5; background: #fff; text-align: left; vertical-align: middle; }
  `,

  async init(config = null) {
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'kh-important-note-host';
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${this.STYLE}</style><div class="khin-wrap"></div>`;
    this.root = shadow.querySelector('.khin-wrap');
    document.body.appendChild(this.host);

    this.setDefaultPosition();
    this.applyPosition();
    // 不在此渲染内容：面板外壳延迟到首次有命中时才创建，
    // 保证入场动画只播放一次，避免首载多条命中时反复重建闪烁。
    this.hide();
    this.bindDrag();
    this.observeChanges();
  },

  /**
   * 独立监听 DOM 变化：无论新增/删除/文本改动都刷新面板
   * （高亮引擎只监听新增，页面删除重要关键词时不会触发重高亮，因此需自行监听）
   */
  observeChanges() {
    if (this.observer) return;
    this.observer = new MutationObserver(() => {
      if (this._mutTimer) return;
      this._mutTimer = setTimeout(() => {
        this._mutTimer = null;
        this.refresh();
      }, 250);
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  },

  setDefaultPosition() {
    // 默认左上角
    const gap = 20;
    this.pos = { left: gap, top: gap };
  },

  applyPosition() {
    if (!this.root) return;
    // 按当前形态限制可拖范围：收起时小圆按钮可贴近窗口右缘
    const width = this.minimized ? 56 : 360;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const clampLeft = Math.max(8, Math.min(this.pos.left, maxLeft));
    const clampTop = Math.max(8, Math.min(this.pos.top, window.innerHeight - 48));
    this.pos.left = clampLeft;
    this.pos.top = clampTop;
    this.root.style.left = clampLeft + 'px';
    this.root.style.top = clampTop + 'px';
  },

  /**
   * 刷新面板：扫描页面上所有重要命中，聚合展示。
   * 带「内容脏检查」——仅当命中集合真正变化时才重建 DOM（避免无关 DOM 变化触发重建导致闪烁）；
   * 命中集合未变时只保持显示，不重建、不重放入场动画。
   */
  refresh() {
    if (!this.host) return;
    const els = document.querySelectorAll('[data-kh-important="1"]');
    // 同一关键词可能命中在页面多处，各命中点所在表格不同→抓到字段数不同（0/1/2 个），
    // 若直接按 note 文本聚合，会出现「无字段/少字段」的多个冗余版本笔记。
    // 修复(v1.7.5)：先按关键词分组，每组保留「抓取字段最完整」（表格数最多）的那份 note，
    // 再按 note 文本聚合（不同关键词若笔记相同仍合并为一条）。
    const bestByKw = new Map();  // keyword -> { note, tc, adj }
    els.forEach(el => {
      // 隐藏元素（display:none / visibility:hidden / hidden）里的命中不应展示，避免误报
      if (Utils.isElementHidden(el)) return;
      const note = (el.getAttribute('data-kh-important-note') || '').trim();
      if (!note) return;
      if (this.ignored.has(note)) return;
      const keyword = (el.textContent || '').trim();
      // 单元格特别标注（v1.6.18）：直接读取验证通过时记录的期望值；未启用验证则为空
      const adj = el.getAttribute('data-kh-cell-verify') || '';
      const tc = (note.match(/<table/g) || []).length;  // 表格数=抓取字段完整度
      const cur = bestByKw.get(keyword);
      if (!cur || tc > cur.tc) bestByKw.set(keyword, { note, tc, adj });
    });

    // 按「笔记文本」聚合：若多个关键词命中的笔记内容一致，则合并为一条
    const noteMap = new Map();  // note -> { note, entryMap: Map<keyword, adj> }
    bestByKw.forEach((v, keyword) => {
      const note = v.note;
      if (!noteMap.has(note)) noteMap.set(note, { note, entryMap: new Map() });
      const grp = noteMap.get(note);
      if (!grp.entryMap.has(keyword)) grp.entryMap.set(keyword, v.adj || '');
    });

    // 合并结果：每条 = { note, entries:[{kw, adj}] }，关键词列表用于列举命中了哪些词
    const newItems = [];
    noteMap.forEach(g => {
      const entries = [];
      g.entryMap.forEach((adj, kw) => entries.push({ kw, adj }));
      newItems.push({ note: g.note, entries });
    });

    // 无命中：直接隐藏
    if (newItems.length === 0) {
      this.items = newItems;
      this.hide();
      return;
    }

    // 内容脏检查：命中集合未变则不重建 DOM
    const changed = this._itemsChanged(newItems);
    this.items = newItems;
    if (changed) {
      this.renderContent();
    }
    this.show();
  },

  /**
   * 比较新旧命中集合是否发生变化（按 笔记文本 + 关键词 组合判断）
   */
  _itemsChanged(newItems) {
    if (this.items.length !== newItems.length) return true;
    // 按「笔记文本 + 排序后的关键词+相邻值」比较
    const key = (it) => (it.note || '') + '\u0001' + (it.entries || [])
      .map(e => (e.kw || '') + '\u0003' + (e.adj || ''))
      .sort().join('\u0002');
    const oldKeys = new Set(this.items.map(key));
    for (const it of newItems) {
      if (!oldKeys.has(key(it))) return true;
    }
    return false;
  },

  render() {
    this.renderContent();
  },

  renderContent() {
    if (!this.root) return;
    const count = this.items.length;

    // 收起态：整块替换为圆形小按钮
    if (this.minimized) {
      this.panelEl = null;
      this.bodyEl = null;
      this.countEl = null;
      this.root.innerHTML = `
        <div class="khin-fab" title="重要笔记（${count} 条）">
          📌
          <span class="khin-fab-badge">${count}</span>
        </div>
      `;
      this.root.querySelector('.khin-fab').addEventListener('pointerdown', (e) => this.startDrag(e));
      // 双击展开（改自单击），避免拖动位置时误展开
      this.root.querySelector('.khin-fab').addEventListener('dblclick', () => {
        this.minimized = false;
        this.renderContent();
        this.applyPosition();
      });
      return;
    }

    // 展开态：面板外壳只创建一次，后续命中变化仅更新内部内容，
    // 避免每次 innerHTML 整块重建导致 .khin-panel 的入场动画反复重放（闪烁）。
    if (!this.panelEl) {
      this.root.innerHTML = `
        <div class="khin-panel">
          <div class="khin-header">
            <span class="khin-header-icon">📌</span>
            <span class="khin-header-title">重要笔记</span>
            <span class="khin-header-count">0 条</span>
            <button class="khin-header-btn" data-act="min" title="收起为小按钮">—</button>
          </div>
          <div class="khin-body"></div>
        </div>
      `;
      this.panelEl = this.root.querySelector('.khin-panel');
      this.bodyEl = this.root.querySelector('.khin-body');
      this.countEl = this.root.querySelector('.khin-header-count');

      this.panelEl.querySelector('.khin-header').addEventListener('pointerdown', (e) => this.startDrag(e));
      this.panelEl.querySelector('[data-act="min"]').addEventListener('click', () => {
        this.minimized = true;
        this.renderContent();
        this.applyPosition();
      });
    }

    if (this.countEl) this.countEl.textContent = `${count} 条`;
    this.renderItems();
  },

  /**
   * 渲染/更新面板内的笔记条目（只替换 body 内容，不影响面板外壳）
   */
  renderItems() {
    if (!this.bodyEl) return;
    const itemsHtml = this.items.map(item => {
      const bodyHtml = Utils.sanitizeHTML(item.note);
      // 同一笔记可能命中多个关键词，逐个标签列举；期望值标注用关键词生效背景色高亮（v1.7.9）
      const kwTags = (item.entries || []).map(e => {
        const adjTag = e.adj ? `<span class="khin-item-adj">→ ${this.escapeText(e.adj)}</span>` : '';
        return `<span class="khin-item-kw">🔖 ${this.escapeText(e.kw)}</span>${adjTag}`;
      }).join(' ');
      return `
        <div class="khin-item" data-note="${encodeURIComponent(item.note)}">
          <div class="khin-item-head">
            <div class="khin-item-tags">${kwTags}</div>
            <button class="khin-item-close" title="本次页面不再显示">✕</button>
          </div>
          <div class="khin-item-body">${bodyHtml}</div>
        </div>
      `;
    }).join('');

    this.bodyEl.innerHTML = itemsHtml;

    this.bodyEl.querySelectorAll('.khin-item-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemEl = btn.closest('.khin-item');
        const note = decodeURIComponent(itemEl.getAttribute('data-note'));
        this.ignored.add(note);
        this.refresh();
      });
    });
  },

  escapeText(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  show() {
    if (this.root) this.root.style.display = 'block';
  },

  hide() {
    if (this.root) this.root.style.display = 'none';
  },

  // ===== 拖动 =====
  startDrag(e) {
    if (e.button === 2) return; // 忽略右键
    e.preventDefault();
    const rect = this.root.getBoundingClientRect();
    this.dragState = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
    const onMove = (ev) => {
      if (!this.dragState) return;
      const dx = ev.clientX - this.dragState.startX;
      const dy = ev.clientY - this.dragState.startY;
      this.pos.left = this.dragState.startLeft + dx;
      this.pos.top = this.dragState.startTop + dy;
      this.applyPosition();
    };
    const onUp = () => {
      this.dragState = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  },

  bindDrag() {
    // root 事件委托已在 renderContent 内给 header/fab 绑定
  },

  /**
   * 销毁（刷新/清理时）
   */
  destroy() {
    if (this.host && this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
    this.host = null;
    this.root = null;
    this.panelEl = null;
    this.bodyEl = null;
    this.countEl = null;
    this.ignored.clear();
    this.items = [];
  }
};

if (typeof window !== 'undefined') {
  window.ImportantNote = ImportantNote;
}
