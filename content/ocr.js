/**
 * 图片文字 OCR 命中（v1.6.31）
 *
 * 方案B：对页面图片做本地 OCR 识别，命中「现有关键词」后：
 *  1) 在图片角落叠加一个角标（如 🔍 命中数），缩略图即可见，无需点开大图；
 *  2) 命中的是「重要」关键词且有重要笔记时，注入离屏占位元素并触发
 *     ImportantNote.refresh()，与文字命中共用同一个左上角悬浮窗聚合展示。
 *
 * 设计要点：
 *  - 全部资源本地化（assets/ocr/*），图片不出浏览器，无隐私外泄；
 *  - OCR 引擎复用单个 worker，按可见性分批处理，节流避免卡页面；
 *  - 跳过小图/图标/装饰图（尺寸与面积阈值）；
 *  - 关键词匹配完全复用 Utils.buildMatchRegex，与文字高亮同一套规则；
 *  - 依赖页面自带灯箱，角标独立 fixed 定位跟随图片，滚动/缩放时同步位置。
 */
const ImageOCR = {
  worker: null,           // tesseract worker
  workerReady: false,
  workerLoading: false,
  keywords: [],           // 启用的关键词（含编译后 regex）
  config: null,
  queue: [],              // 待识别图片数组
  processing: false,
  processingImg: null,    // 记录当前已注入占位的图片，避免重复注入
  observedImgs: new Set(),// 已处理的图片元素
  badges: new Map(),      // img -> badge element
  placeholders: new Set(),// 离屏占位元素（重要笔记）
  observer: null,         // 监听新图片 (懒识别)
  scrollTimer: null,
  _visibleSet: new Set(), // 当前可见状态
  enabled: true,

  // ---------- 生命周期 ----------
  async init(keywords, config) {
    // 构建分组映射（用于计算有效重要笔记：自身优先，分组统一笔记兜底）
    const groups = (config && config.groups) || [];
    const groupMap = {};
    groups.forEach(g => { groupMap[g.id] = g; });

    this.keywords = (keywords || []).filter(k => k && k.enabled)
      .map(kw => {
        const re = Utils.buildMatchRegex(kw);
        if (!re) return null;
        const group = groupMap[kw.groupId];
        const effectiveImportant = !!(kw.important || (group && group.important));
        const effectiveImportantNote =
          (kw.importantNote && String(kw.importantNote).trim()) ||
          (group && group.important && group.importantNote && String(group.importantNote).trim()) || '';
        return { ...kw, regex: re, effectiveImportant, effectiveImportantNote };
      }).filter(k => k !== null);
    this.config = config || {};

    if (this.keywords.length === 0) return;
    this.enabled = true;
    this.cleanupVisuals(); // 清掉上次残留
    this.setupObserver();
    this.scan();
  },

  destroy() {
    this.enabled = false;
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.scrollTimer) { clearTimeout(this.scrollTimer); this.scrollTimer = null; }
    this.queue = [];
    this.cleanupVisuals();
    if (this.worker && this.workerReady) {
      try { this.worker.terminate(); } catch (e) {}
    }
    this.worker = null;
    this.workerReady = false;
    this.workerLoading = false;
  },

  /** 清理角标和占位元素 */
  cleanupVisuals() {
    this.badges.forEach(badge => { if (badge.parentNode) badge.parentNode.removeChild(badge); });
    this.badges.clear();
    this.placeholders.forEach(el => { if (el.parentNode) el.parentNode.removeChild(el); });
    this.placeholders.clear();
    this.processingImg = null;
  },

  // ---------- 图片收集 ----------
  /** 是否值得识别的图片（跳过小图标/装饰图） */
  _isCandidate(img) {
    if (!img || img.nodeType !== Node.ELEMENT_NODE || img.tagName !== 'IMG') return false;
    if (this.observedImgs.has(img)) return false;
    // 已在 DOM 外/隐藏的跳过
    if (!img.isConnected) return false;
    if (Utils.isElementHidden(img)) return false;
    // 尺寸阈值：自然尺寸与显示尺寸都要够大（图标/emoji/装饰跳过）
    const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (nw < 120 || nh < 40) return false;            // 自然尺寸过小
    if (nw * nh < 8000) return false;                  // 面积过小
    // 显示尺寸：避免巨大的空白占位图（如 1x1 拉伸）
    const rect = img.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 30) return false;
    // 跳过 SVG/data: 占位与懒加载空壳
    const src = (img.currentSrc || img.src || '');
    if (!src || src === 'about:blank') return false;
    if (/^data:\s*(image\/(gif|bmp))/.test(src)) return false; // gif/bmp 易失败
    return true;
  },

  setupObserver() {
    if (this.observer) return;
    const debouncedScan = Utils.debounce(() => this.scan(), 400);
    this.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          const hasImg = [...m.addedNodes].some(n =>
            n.nodeType === Node.ELEMENT_NODE && (n.tagName === 'IMG' || n.querySelector('img')));
          if (hasImg) { debouncedScan(); break; }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  },

  /** 全页扫描，加入队列 */
  scan() {
    if (!this.enabled) return;
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      if (this._isCandidate(img)) {
        // 加入可见性感知队列；懒识别：仅优先处理接近可见的
        this.queue.push(img);
        this.observedImgs.add(img);
      }
    }
    this._schedule();
  },

  _schedule() {
    // 节流：避免一次性全跑；每批处理少量，间隔让出主线程
    if (this.processing) return;
    this.processing = true;
    this._processBatch();
  },

  async _processBatch() {
    // 按可见性排序：可见优先
    this.queue.sort((a, b) => {
      const va = this._isNearVisible(a) ? 1 : 0, vb = this._isNearVisible(b) ? 1 : 0;
      return vb - va;
    });
    let handled = 0;
    while (this.queue.length && handled < 3) {
      const img = this.queue.shift();
      if (!img.isConnected) { this.observedImgs.delete(img); continue; }
      try {
        if (!this._isNearVisible(img)) { this.queue.push(img); break; } // 不可见则延后
        await this._processOne(img);
      } catch (e) {
        // 单图失败不影响整体（跨域/CORS 等）
      }
      handled++;
    }
    this.processing = false;
    if (this.queue.length) {
      // 还有剩余：500ms 后再继续（分批，避免阻塞页面）
      setTimeout(() => { if (this.enabled) this._schedule(); }, 500);
    }
  },

  _isNearVisible(img) {
    const r = img.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return r.bottom > -200 && r.top < vh + 200;
  },

  // ---------- 单图识别 ----------
  async _processOne(img) {
    // 跨域图需 CORS 才能绘 canvas；无法读取则跳过
    let imgDataUrl;
    try {
      imgDataUrl = await this._imgToDataURL(img);
    } catch (e) {
      return; // CORS/无法读取，跳过
    }

    const worker = await this._getWorker();
    if (!worker) return;

    const res = await worker.recognize(imgDataUrl);
    const ocrText = (res && res.data && res.data.text) ? res.data.text : '';

    const hits = this._matchKeywords(ocrText);
    if (hits.length === 0) return;

    // 命中：加角标 + 重要笔记
    this._addBadge(img, hits.length);
    const imp = hits.filter(h => h.effectiveImportant && h.effectiveImportantNote);
    if (imp.length) {
      this._injectImportantNotes(img, imp);
    }
  },

  /** 将图片转为 dataURL（处理跨域；用 dataURL 传给 worker 最稳，避免 ImageData 反序列化问题） */
  _imgToDataURL(img) {
    return new Promise((resolve, reject) => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) return reject(new Error('no size'));
      const cv = document.createElement('canvas');
      cv.width = Math.min(nw, 1200);   // 限制最大处理尺寸，提速
      cv.height = Math.round(nh * (cv.width / nw));
      const ctx = cv.getContext('2d');
      if (!ctx) return reject(new Error('no ctx'));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      try {
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      } catch (e) {
        reject(e); // 跨域污染
      }
    });
  },

  /** 复用 Worker（懒创建，单例） */
  async _getWorker() {
    if (this.workerReady) return this.worker;
    if (this.workerLoading) {
      // 等待加载完成
      while (this.workerLoading) { await new Promise(r => setTimeout(r, 200)); }
      return this.workerReady ? this.worker : null;
    }
    this.workerLoading = true;
    try {
      const base = chrome.runtime.getURL('assets/ocr/');
      const worker = await Tesseract.createWorker('chi_sim', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'tesseract-core-simd.wasm.js',
        langPath: base
      });
      this.worker = worker;
      this.workerReady = true;
      return worker;
    } catch (e) {
      console.warn('[KeywordHighlighter] OCR worker 初始化失败:', e);
      return null;
    } finally {
      this.workerLoading = false;
    }
  },

  // ---------- 匹配 ----------
  /** 用现有关键词正则匹配 OCR 文本 */
  _matchKeywords(ocrText) {
    // 归一化空白（OCR 常产生多余空格/换行）
    const text = String(ocrText).replace(/\s+/g, ' ');
    const results = [];
    for (const kw of this.keywords) {
      let m;
      kw.regex.lastIndex = 0;
      let found = false;
      while ((m = kw.regex.exec(text)) !== null) {
        found = true;
        if (m[0].length === 0) { kw.regex.lastIndex++; continue; }
        break; // 只需要判断是否命中
      }
      if (found) {
        results.push(kw);
      }
    }
    return results;
  },

  // ---------- 视觉呈现 ----------
  /** 图片角落叠加命中角标（fixed 定位跟随图片） */
  _addBadge(img, count) {
    if (this.badges.has(img)) return;
    const badge = document.createElement('div');
    badge.className = 'kh-ocr-badge';
    badge.textContent = '🔍 ' + count;
    badge.setAttribute('title', '图片含命中关键词 ' + count + ' 处');
    (document.body || document.documentElement).appendChild(badge);
    this.badges.set(img, badge);
    this._positionBadge(img, badge);
    this._bindPositionUpdate(img, badge);
  },

  _positionBadge(img, badge) {
    if (!badge || !badge.parentNode) return;
    const r = img.getBoundingClientRect();
    badge.style.top = Math.max(6, r.top + 4) + 'px';
    badge.style.left = Math.max(6, r.right - 80) + 'px';
  },

  _bindPositionUpdate(img, badge) {
    const update = () => this._positionBadge(img, badge);
    if (this.scrollUpdate) return;
    // 滚动/缩放时更新位置（被动监听，低开销）
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    this.scrollUpdate = update;
  },

  /** 注入离屏占位元素，复用重要笔记悬浮窗 */
  _injectImportantNotes(img, impKeywords) {
    // 每个重要笔记一行；按 关键词+笔记 去重
    const added = new Set();
    for (const kw of impKeywords) {
      const key = kw.text + '\u0000' + kw.effectiveImportantNote;
      if (added.has(key)) continue;
      added.add(key);
      const el = document.createElement('span');
      el.className = 'kh-ocr-important-holder';
      el.setAttribute('data-kh-important', '1');
      el.setAttribute('data-kh-important-note', kw.effectiveImportantNote);
      el.textContent = kw.text;  // 悬浮窗里作为关键词标签展示
      // 离屏定位（display:block 且不可见区域），避免 isElementHidden 过滤又不出现在页面
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
      (document.body || document.documentElement).appendChild(el);
      this.placeholders.add(el);
    }
    // 触发悬浮窗刷新（ImportantNote.refresh 扫描 [data-kh-important]）
    if (typeof ImportantNote !== 'undefined' && ImportantNote.refresh) {
      ImportantNote.refresh();
    }
  }
};

if (typeof window !== 'undefined') {
  window.ImageOCR = ImageOCR;
}
