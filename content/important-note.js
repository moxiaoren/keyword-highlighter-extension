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
      background: linear-gradient(135deg, #3579c2, #5fb0ee);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(74, 144, 217, 0.4);
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
      border: 1px solid #e3e8f0;
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
      background: linear-gradient(180deg, #ffffff, #eaf1fb);
      border-bottom: 1px solid #f3e0cf;
      cursor: move;
      flex-shrink: 0;
    }
    .khin-header-icon { font-size: 16px; }
    .khin-header-title { font-size: 14px; font-weight: 600; color: #3579c2; flex: 1; }
    .khin-header-count { font-size: 12px; color: #3579c2; background: #eaf1fb; border-radius: 10px; padding: 1px 8px; }
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
      font-size: 12px; font-weight: 600; color: #3579c2;
      background: #eaf1fb; border-radius: 4px; padding: 1px 7px;
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
    /* 重要笔记内图片（v1.8.2）：缩略显示，点击开新标签页看原图；不等比裁剪，完整等比缩放 */
    .khin-item-body img { max-width: var(--kh-img-size, 70px); max-height: var(--kh-img-size, 70px); width: auto; height: auto; border-radius: 4px; margin: 4px 8px 4px 0; display: inline-block; vertical-align: middle; cursor: pointer; }
    .khin-item-body img:hover { opacity: .92; }
    .khin-empty { padding: 20px; text-align: center; color: #aaa; font-size: 13px; }
    /* 抓取后续字段渲染的 Excel 表格 */
    .kh-table { border-collapse: collapse; margin-top: 4px; width: 100%; }
    .kh-table td { border: 1px solid #d3dae3; padding: 3px 8px; font-size: 12px; line-height: 1.5; background: #fff; text-align: left; vertical-align: middle; white-space: pre-line; /* 保留单元格内换行（备注多行内容不折叠）v1.8.3 */ }
  `,

  async init(config = null) {
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'kh-important-note-host';
    this.host.setAttribute('data-kh-ext-ui', '1'); // v1.10.18：插件UI容器不参与高亮（备注含关键词不被高亮）
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${this.STYLE}</style><div class="khin-wrap"></div>`;
    this.root = shadow.querySelector('.khin-wrap');
    document.body.appendChild(this.host);

    // v1.8.17：全局重要笔记图片默认尺寸 70px（每词可单独在编辑弹窗「图片缩略尺寸」覆盖，取值 40-600；
    // 主页「重要笔记」配置模块已移除）。与编辑器内所见即所得展示使用同一 imgSize，保持大小一致。
    this.host.style.setProperty('--kh-img-size', '70px');

    // v1.8.2：点击重要笔记内的缩略图 → 新标签页打开原图（data: 图已内嵌、无需跳转）
    this.root.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.src && !/^data:image\//i.test(t.src)) {
        e.preventDefault();
        window.open(t.src, '_blank', 'noopener');
      }
    });

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
    // v1.10.16【统一 CSS Highlight】普通词与组合词重要命中均已迁入引擎内存注册表；来源①仅剩「仅抓取」透明 span。此处合并两来源，统一聚合。
    // v1.14.0【1】聚合修复：不再按命中词(keyword)压多条内容——原来同 keyword 命中多篇不同内容时
    // 只留表格最全一篇却把多个标题全塞进 Set（导致内容不一致的词聚到一张卡、内容丢失）。现改为：
    // 逐条收集「内容(note)+值(kw)+标题(adj)」原始命中并去重，先按【内容】分组（内容一致才同卡），
    // 卡片内标签再按「同标题多值/多标题同值/无标题多值」聚合；值标题都不同、或有标题+无标题混合则平铺多条、不交叉。
    const rawMap = new Map(); // key = note\u0000kw\u0000adj -> { note, kw, adj, imgSize, bg }
    const addRaw = (kw, note, adj, imgSize, bg) => {
      note = (note || '').trim();
      if (!note) return;                 // 忽略空内容
      if (this.ignored.has(note)) return;
      kw = (kw || '').trim();
      if (!kw) return;                   // v1.9.1 跳过 keyword 为空
      adj = (adj || '').trim();
      const key = note + '\u0000' + kw + '\u0000' + adj;
      if (rawMap.has(key)) return;       // 去重
      rawMap.set(key, { note: note, kw: kw, adj: adj, imgSize: imgSize || '', bg: bg || '' });
    };
    // ① DOM 残留 span（仅抓取透明 span）命中
    const els = document.querySelectorAll('[data-kh-important="1"]');
    els.forEach(el => {
      if (Utils.isElementHidden(el)) return;
      addRaw(el.textContent || '', el.getAttribute('data-kh-important-note') || '',
        el.getAttribute('data-kh-cell-verify') || '', el.getAttribute('data-kh-important-img-size') || '',
        el.getAttribute('data-kh-important-bg') || '');
    });
    // ② 普通词引擎注册表命中（CSS Highlight）
    try {
      const plainHits = (typeof KeywordEngine !== 'undefined' && typeof KeywordEngine.getImportantPlainHits === 'function')
        ? KeywordEngine.getImportantPlainHits() : [];
      for (const h of plainHits) {
        if (!h || !h.textNode) continue;
        if (Utils.isElementHidden(h.textNode.parentElement)) continue;
        addRaw(h.text, h.note, h.adj, h.imgSize, h.bg);
      }
    } catch (e) { /* 引擎未就绪时跳过普通词命中 */ }
    // 第一维度=【笔记内容】：内容一致才放同一张卡片
    const noteMap = new Map(); // note -> { note, imgSize, bg, entrySet:Set<"kw\u0000adj"> }
    rawMap.forEach(r => {
      let grp = noteMap.get(r.note);
      if (!grp) { grp = { note: r.note, imgSize: r.imgSize, bg: r.bg, entrySet: new Set() }; noteMap.set(r.note, grp); }
      if (!grp.imgSize && r.imgSize) grp.imgSize = r.imgSize;
      if (!grp.bg && r.bg) grp.bg = r.bg;
      grp.entrySet.add(r.kw + '\u0000' + (r.adj || ''));
    });

    // 合并结果：每条 = { note, entries:[{kw, adj}], imgSize, bg }
    const newItems = [];
    noteMap.forEach(g => {
      const entries = [];
      g.entrySet.forEach(k => { const i = k.indexOf('\u0000'); entries.push({ kw: k.slice(0, i), adj: k.slice(i + 1) }); });
      newItems.push({ note: g.note, entries: entries, imgSize: g.imgSize || '', bg: g.bg || '' });
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
    const key = (it) => (it.note || '') + '\u0001' + (it.bg || '') + '\u0001' + (it.entries || [])
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
      // v1.9.1：笔记底色铺满整条卡片（含标题/标签区），校验为合法 hex 才应用，防注入
      const bg = /^#[0-9a-fA-F]{3,8}$/.test(item.bg || '') ? item.bg : '';
      // v1.14.0【1】同一卡片（内容一致）前提下，标签按形态聚合、不交叉：
      //   同标题多值 → 🔖 标题 → a|b；多标题同值 → 🔖 标题1|标题2 → a；无标题多词 → 🔖 a|b；
      //   值标题都不同 / 有标题+无标题混合 → 平铺多条直接展示。
      const kwTags = this.buildTagHtml(item.entries || []);
      return `
        <div class="khin-item" style="${item.imgSize ? `--kh-img-size:${item.imgSize}px;` : ''}${bg ? `background:${bg};` : ''}" data-note="${encodeURIComponent(item.note)}">
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

  /**
   * v1.14.0【1】构建卡片标签区 HTML（平铺多条、不交叉）：
   * - 无标题普通词：多值聚合 → 🔖 a|b
   * - 组合词（有标题）：
   *     · 同标题多值 → 🔖 标题 → a|b
   *     · 多标题同值 → 🔖 标题1|标题2 → a（标题合并）
   *     · 各标题单值但值不同（标题1→值1+标题2→值2）→ 逐条平铺，不交叉
   *     · 某标题多值 → 按标题分组「标题 → 值1|值2」多条平铺
   * - 有标题 + 无标题混合：普通词与组合词各自成标签平铺
   */
  buildTagHtml(entries) {
    const plainVals = new Set(); // 无标题普通词值集
    const combo = new Map();     // adj -> Set<值>，组合词按标题分组
    for (const e of entries || []) {
      if (!e || !e.kw) continue;
      if (e.adj) {
        if (!combo.has(e.adj)) combo.set(e.adj, new Set());
        combo.get(e.adj).add(e.kw);
      } else {
        plainVals.add(e.kw);
      }
    }
    const out = [];
    // 无标题普通词组：多值聚合
    if (plainVals.size) {
      out.push(`<span class="khin-item-kw">🔖 ${Array.from(plainVals).map(v => this.escapeText(v)).join('|')}</span>`);
    }
    const adjs = Array.from(combo.keys());
    if (adjs.length) {
      const valUnion = new Set();
      adjs.forEach(a => combo.get(a).forEach(v => valUnion.add(v)));
      const allSingle = adjs.every(a => combo.get(a).size === 1);
      if (allSingle && valUnion.size === 1) {
        // 多标题同值 → 标题合并
        const val = Array.from(valUnion)[0];
        out.push(`<span class="khin-item-kw">🔖 ${adjs.map(t => this.escapeText(t)).join('|')}</span><span class="khin-item-adj">→ ${this.escapeText(val)}</span>`);
      } else if (allSingle) {
        // 各标题单值但值彼此不同 → 逐条平铺，不交叉
        for (const a of adjs) {
          const v = Array.from(combo.get(a))[0];
          out.push(`<span class="khin-item-kw">🔖 ${this.escapeText(a)}</span><span class="khin-item-adj">→ ${this.escapeText(v)}</span>`);
        }
      } else {
        // 存在某标题多值：按标题分开，同标题多值聚合
        for (const a of adjs) {
          const vals = Array.from(combo.get(a));
          if (!vals.length) continue;
          out.push(`<span class="khin-item-kw">🔖 ${this.escapeText(a)}</span><span class="khin-item-adj">→ ${vals.map(v => this.escapeText(v)).join('|')}</span>`);
        }
      }
    }
    return out.join('');
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
