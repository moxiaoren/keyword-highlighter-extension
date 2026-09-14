/**
 * 悬浮备注卡片系统
 */
const NoteCard = {
  card: null,
  pinnedCard: null,
  pinnedKeywordEl: null,
  isHovering: false,
  hideTimer: null,
  copyButton: null,
  _handlers: null, // 保存事件监听引用，便于 destroy 时解绑

  /**
   * 初始化备注卡片系统
   */
  async init() {
    this.createCard();
    this.bindEvents();
  },

  /**
   * 创建备注卡片 DOM
   */
  createCard() {
    if (this.card) return;

    this.card = document.createElement('div');
    this.card.id = 'kh-note-card';
    this.card.className = 'kh-note-card';
    this.card.setAttribute('data-kh-ext-ui', '1'); // v1.10.18：插件UI容器不参与高亮（备注含关键词不被高亮）
    this.card.setAttribute('role', 'tooltip');
    this.card.innerHTML = `
      <div class="kh-note-header">
        <span class="kh-note-keyword"></span>
        <div class="kh-note-actions">
          <button class="kh-note-copy-btn" title="复制备注">📋</button>
          <button class="kh-note-close-btn" title="关闭">✕</button>
        </div>
      </div>
      <div class="kh-note-body"></div>
      <div class="kh-note-arrow"></div>
    `;

    this.copyButton = this.card.querySelector('.kh-note-copy-btn');
    this.card.style.display = 'none';
    document.body.appendChild(this.card);

    // 悬浮备注 tooltip（v1.10.17，CSS Highlight 无 DOM 节点挂原生 title，自制轻量悬浮）
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'kh-note-tooltip';
    this.tooltip.setAttribute('data-kh-ext-ui', '1'); // v1.10.18：插件UI容器不参与高亮（备注含关键词不被高亮）
    this.tooltip.style.display = 'none';
    document.body.appendChild(this.tooltip);

    // 应用样式
    this.applyCardStyle();
  },

  /**
   * 应用备注卡片样式
   */
  async applyCardStyle() {
    const data = await Storage.get(['noteCardStyle']);
    const style = data.noteCardStyle || Storage.defaults.noteCardStyle;

    const card = this.card;
    card.style.backgroundColor = style.bgColor;
    card.style.color = style.textColor;
    card.style.borderColor = style.borderColor;
    card.style.borderWidth = style.borderWidth;
    card.style.borderRadius = style.borderRadius;
    card.style.boxShadow = style.shadow;
    card.style.maxWidth = style.maxWidth;
    card.style.opacity = style.opacity;
    card.style.fontSize = style.fontSize;
  },

  /**
   * 绑定事件（具名处理器存入 _handlers，destroy 时可解绑）
   */
  bindEvents() {
    if (this._handlers) return; // 避免重复绑定

    // 点击页面（document 级事件委托；card 被销毁后仍可能触发，故加 this.card 防御）
    const onClick = (e) => {
      if (!this.card) return; // card 未创建或已销毁
      // 点击卡片内部（复制/关闭按钮）不处理
      if (e.target.closest('#kh-note-card')) return;

      // v1.10.15【CSS Custom Highlight】优先命中组合词 span，否则尝试普通词坐标命中（虚拟命中对象）
      let target = e.target.closest('[data-kh-highlighted]');
      if (!target) {
        target = this.resolveHitAt(e.clientX, e.clientY);
      }
      if (!target) {
        // 点击页面其他位置，关闭已固定的卡片
        if (this.pinnedCard) {
          this.unpinCard();
        }
        return;
      }

      e.stopPropagation();
      const pinned = this.pinnedCard ? this.pinnedKeywordEl : null;
      const sameHit = pinned === target ||
        (pinned && pinned._virtual && target && target._virtual && pinned.meta === target.meta);
      if (pinned && sameHit) {
        // 再次点击同一高亮词取消固定
        this.unpinCard();
      } else {
        // 显示并固定备注卡片
        this.pinCard(target);
      }
    };
    document.addEventListener('click', onClick);

    // 键盘 Enter 打开备注
    const onKeydown = (e) => {
      if (!this.card) return; // card 未创建或已销毁
      if (e.key === 'Enter' && document.activeElement && document.activeElement.closest('[data-kh-highlighted]')) {
        e.preventDefault();
        const el = document.activeElement.closest('[data-kh-highlighted]');
        this.pinCard(el);
      }
    };
    document.addEventListener('keydown', onKeydown);

    // 关闭/复制按钮
    const onClose = (e) => {
      e.stopPropagation();
      this.unpinCard();
    };
    const onCopy = async (e) => {
      e.stopPropagation();
      if (!this.card) return;
      const bodyEl = this.card.querySelector('.kh-note-body');
      const text = bodyEl.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
        const btn = this.card.querySelector('.kh-note-copy-btn');
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      } catch (err) {
        console.warn('复制失败:', err);
      }
    };
    this.card.querySelector('.kh-note-close-btn').addEventListener('click', onClose);
    this.card.querySelector('.kh-note-copy-btn').addEventListener('click', onCopy);

    // (v1.10.17) 悬浮备注 tooltip：移入命中点显示，移出隐藏。用 setTimeout 节流避免频繁坐标命中。
    let tooltipTimer = null;
    let tooltipPos = null;
    const onMouseMove = (e) => {
      // 卡片/卡片内容上不显示 tooltip
      if (this.tooltip && e.target && this.tooltip.contains(e.target)) return;
      if (this.card && e.target && this.card.contains(e.target)) return;
      tooltipPos = { x: e.clientX, y: e.clientY };
      if (tooltipTimer) return;
      tooltipTimer = setTimeout(() => {
        tooltipTimer = null;
        const p = tooltipPos; tooltipPos = null;
        if (!p) return;
        const hit = this.resolveHitAt(p.x, p.y);
        if (hit && hit.meta && hit.meta.note) {
          this.showTooltip(hit.textContent, hit.meta.note, p.x, p.y);
        } else {
          this.hideTooltip();
        }
      }, 60);
    };
    const onMouseLeave = () => { if (this.tooltip) this.hideTooltip(); };
    // (v1.10.17) 滚动/窗口尺寸变化：已固定卡片跟随高亮词重新定位
    const onScroll = () => { this.repositionOnScroll(); };
    const onResize = () => { this.repositionOnScroll(); };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    this._handlers = { onClick, onKeydown, onClose, onCopy, onMouseMove, onMouseLeave, onScroll, onResize };
  },

  /**
   * (v1.10.15) 坐标命中检测：普通词 CSS Highlight 无 DOM 元素，
   * 用引擎坐标命中返回「虚拟命中对象」，兼容现有 showCard/pinCard/positionCard。
   */
  resolveHitAt(x, y) {
    let meta = null;
    try {
      if (typeof KeywordEngine !== 'undefined' && typeof KeywordEngine.queryPlainHitAt === 'function') {
        meta = KeywordEngine.queryPlainHitAt(x, y);
      }
    } catch (e) { /* 引擎未就绪忽略 */ }
    if (!meta) return null;
    if (!meta.note) return null; // 无备注的高亮不设热区
    const tn = meta.textNode;
    return {
      _virtual: true,
      meta: meta,
      textContent: (tn && tn.nodeValue) ? tn.nodeValue.slice(meta.start, meta.end) : '',
      getAttribute: (name) => {
        if (name === 'data-kh-note') return meta.note || null;
        return null;
      },
      getBoundingClientRect: () => {
        try {
          if (meta.range) return meta.range.getBoundingClientRect();
        } catch (e) {}
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
      },
      classList: {
        add: () => {},
        remove: () => {}
      }
    };
  },

  /**
   * (v1.10.17) 显示悬浮备注 tooltip（CSS Highlight 命中，坐标定位）。只显示备注内容（不显示关键词）。
   */
  showTooltip(keywordText, note, x, y) {
    if (!this.tooltip) return;
    try { this.tooltip.innerHTML = Utils.sanitizeHTML(note || ''); }
    catch (e) { this.tooltip.textContent = note || ''; }
    // 定位：默认右下偏移，翻转防溢出视口
    const tw = this.tooltip.offsetWidth || 200;
    const th = this.tooltip.offsetHeight || 40;
    let left = x + 14;
    let top = y + 14;
    if (left + tw > window.innerWidth - 8) left = x - tw - 14;
    if (top + th > window.innerHeight - 8) top = y - th - 14;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    this.tooltip.style.left = left + 'px';
    this.tooltip.style.top = top + 'px';
    this.tooltip.style.display = 'block';
    requestAnimationFrame(() => { if (this.tooltip) this.tooltip.classList.add('kh-tip-show'); });
  },

  /**
   * (v1.10.17) 隐藏悬浮备注 tooltip。
   */
  hideTooltip() {
    if (!this.tooltip) return;
    this.tooltip.classList.remove('kh-tip-show');
    this.tooltip.style.display = 'none';
  },

  /**
   * (v1.10.17) 滚动/尺寸变化时：若卡片已固定，用命中对象实时坐标重新定位（跟随高亮词）。
   */
  repositionOnScroll() {
    if (this.pinnedCard && this.pinnedKeywordEl) {
      requestAnimationFrame(() => { if (this.card && this.pinnedKeywordEl) this.positionCard(this.pinnedKeywordEl); });
    }
  },

  /**
   * 显示卡片
   */
  showCard(keywordEl) {
    let note = null;
    if (keywordEl._virtual) {
      note = keywordEl.getAttribute('data-kh-note');
    } else {
      note = keywordEl.getAttribute('data-kh-note');
    }
    if (!note) return;

    const keywordText = keywordEl.textContent || (keywordEl._virtual ? '' : '');
    this.card.querySelector('.kh-note-keyword').textContent = keywordText;
    this.card.querySelector('.kh-note-body').innerHTML = Utils.sanitizeHTML(note);

    // 定位
    this.positionCard(keywordEl);
    this.card.style.display = 'block';
  },

  /**
   * 定位卡片
   */
  positionCard(keywordEl) {
    const elRect = keywordEl.getBoundingClientRect();
    const cardRect = this.card.getBoundingClientRect();
    const cardWidth = cardRect.width || parseInt(this.card.style.maxWidth) || 320;
    const cardHeight = cardRect.height || 100;

    const pos = Utils.calculateNotePosition(elRect, cardWidth, cardHeight);
    this.card.style.top = pos.top + 'px';
    this.card.style.left = pos.left + 'px';
  },

  /**
   * 固定卡片
   */
  pinCard(keywordEl) {
    if (!this.card) return; // card 未创建或已销毁时防御
    if (this.pinnedCard) {
      this.unpinCard();
    }
    this.showCard(keywordEl);
    this.pinnedCard = this.card;
    this.pinnedKeywordEl = keywordEl;
    this.card.classList.add('kh-note-pinned');
    if (keywordEl) keywordEl.classList.add('kh-highlight-active');
    
    // 重新定位（因为卡片可能改变了尺寸）
    requestAnimationFrame(() => {
      if (this.card) this.positionCard(keywordEl);
    });
  },

  /**
   * 取消固定
   */
  unpinCard() {
    this.pinnedCard = null;
    if (this.pinnedKeywordEl) {
      this.pinnedKeywordEl.classList.remove('kh-highlight-active');
      this.pinnedKeywordEl = null;
    }
    if (this.card) this.card.classList.remove('kh-note-pinned');
    if (this.card) this.card.style.display = 'none';
  },

  hideCard() {
    if (this.card) this.card.style.display = 'none';
  },

  /**
   * 销毁（刷新/清理时）
   */
  destroy() {
    // 解绑 document 级事件监听
    if (this._handlers) {
      document.removeEventListener('click', this._handlers.onClick);
      document.removeEventListener('keydown', this._handlers.onKeydown);
      document.removeEventListener('mousemove', this._handlers.onMouseMove);
      document.removeEventListener('mouseleave', this._handlers.onMouseLeave);
      document.removeEventListener('scroll', this._handlers.onScroll, true);
      window.removeEventListener('resize', this._handlers.onResize);
      this._handlers = null;
    }
    if (this.card && this.card.parentNode) {
      this.card.parentNode.removeChild(this.card);
    }
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    this.card = null;
    this.tooltip = null;
    this.pinnedCard = null;
    this.pinnedKeywordEl = null;
    this.copyButton = null;
  }
};

if (typeof window !== 'undefined') {
  window.NoteCard = NoteCard;
}
