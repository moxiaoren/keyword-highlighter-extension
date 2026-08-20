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

      const target = e.target.closest('[data-kh-highlighted]');
      if (!target) {
        // 点击页面其他位置，关闭已固定的卡片
        if (this.pinnedCard) {
          this.unpinCard();
        }
        return;
      }

      e.stopPropagation();
      if (this.pinnedCard && this.pinnedKeywordEl === target) {
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

    this._handlers = { onClick, onKeydown, onClose, onCopy };
  },

  /**
   * 显示卡片
   */
  showCard(keywordEl) {
    const note = keywordEl.getAttribute('data-kh-note');
    if (!note) return;

    const keywordText = keywordEl.textContent;
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
      this._handlers = null;
    }
    if (this.card && this.card.parentNode) {
      this.card.parentNode.removeChild(this.card);
    }
    this.card = null;
    this.pinnedCard = null;
    this.pinnedKeywordEl = null;
    this.copyButton = null;
  }
};

if (typeof window !== 'undefined') {
  window.NoteCard = NoteCard;
}
