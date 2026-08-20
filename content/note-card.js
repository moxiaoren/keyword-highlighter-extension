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
   * 绑定事件
   */
  bindEvents() {
    // 备注卡片只在“点击高亮词”时显示；悬停仅显示浏览器原生 title 文本悬浮框
    document.addEventListener('click', (e) => {
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
    });

    // 关闭按钮
    this.card.querySelector('.kh-note-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.unpinCard();
    });

    // 复制按钮
    this.card.querySelector('.kh-note-copy-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
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
    });

    // 键盘 Enter 打开备注
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement && document.activeElement.closest('[data-kh-highlighted]')) {
        e.preventDefault();
        const el = document.activeElement.closest('[data-kh-highlighted]');
        this.pinCard(el);
      }
    });
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
    if (this.pinnedCard) {
      this.unpinCard();
    }
    this.showCard(keywordEl);
    this.pinnedCard = this.card;
    this.pinnedKeywordEl = keywordEl;
    this.card.classList.add('kh-note-pinned');
    keywordEl.classList.add('kh-highlight-active');
    
    // 重新定位（因为卡片可能改变了尺寸）
    requestAnimationFrame(() => {
      this.positionCard(keywordEl);
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
    this.card.classList.remove('kh-note-pinned');
    this.card.style.display = 'none';
  },

  hideCard() {
    this.card.style.display = 'none';
  },

  /**
   * 销毁
   */
  destroy() {
    if (this.card && this.card.parentNode) {
      this.card.parentNode.removeChild(this.card);
    }
    this.card = null;
  }
};

if (typeof window !== 'undefined') {
  window.NoteCard = NoteCard;
}
