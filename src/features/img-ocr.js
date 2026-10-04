/* ============================================================================
 * src/features/img-ocr.js · 图片文字识别（命中口径：图里的字也算命中）
 * ----------------------------------------------------------------------------
 * 解决的真实场景：表格里"金额/供应商/结论"这些值经常是一张截图，文字不在 DOM 里，
 * 现有匹配（只看文本节点）对它无能为力 —— 用户要的是"这个词出现在图片里也算命中"。
 *
 * ============================ 职责与边界 ============================
 *   · 本文件（内容脚本）：**只做采集与结果聚合** —— 从"命中所在表里各个抓取字段的值格"取图，
 *     分类（能不能读）、排队、把识别结果按"图上是否真的出现这个词"标出来。
 *   · offscreen/ocr.js：真正跑 OCR（引擎/语言包都在那边，见该文件顶部注释）。
 *   · important-note.js：只负责把 `KH.ImgOcr.items()` 画进面板的「🖼 图片命中」分区。
 *
 * ============================ 图片命中 = 「抓取后续字段」的一个分支 ============================
 * 【用户确认的口径】取图范围**以抓取字段为准**：
 *   · 前置条件：必须配了「抓取后续字段」+「图片命中关键词」（否则本文件不产生任何条目）；
 *   · 取哪些格：该命中所在表里**所有已配置抓取字段的值格**（值格指向走 `fetchLabels` 的
 *     `@表达式`，见 `Fetch.cellsForHit`），不管字段有没有 `#图` 修饰；
 *   · 匹配口径：「图片命中关键词」当作**正则**（不全词、不区分大小写），
 *     走内核唯一匹配入口 `Scanner.util.matchIn`；**不回落**成规则核心词。
 * 触发（**只看真命中**，K75）：
 *   · 普通词与组合词都走**命中所在格**（`consume(hits…)` 里的命中记录，同一套 `cellOfHit`）。
 *   锚点只用来**定位表/行**，取图仍一律以抓取字段为准；`ruleId|src` 建键天然去重，
 *   所以同一条规则的多条命中不会把同一张图识别两次。
 * 【K75 作废口径】原来还有一条"组合词 Probe 在标题词定位到那一格时就交锚点"的来源
 *   （`ctx.imgAnchors`）—— 它**不看核心词有没有命中**，于是"没命中也在跑 OCR"。
 *   用户口径：「判断命中了普通词/组合词没有…如果没有命中，那就不需要考虑图片 ocr 和图片关键词」。
 *
 * 三条硬边界（与既有纪律一致，meta-check 有红线看着）：
 *   ① **识别结果绝不产生文本高亮**，也不写 `_hits` —— 命中注册表的写入单源仍在 src/core/index.js。
 *   ② 取图范围与**抓取的字段口径同一套定位**：值格由 `KH.Fetch.cellsForHit` 唯一给出，
 *      本文件不自己找格子（否则就会出现"抓取看到的图"和"识别看到的图"不一致）。
 *   ③ 采集只在 ⑦Consume（同步管线）里登记任务；OCR 是**异步**的，结果回来时页面可能已经重建过，
 *      所以按「规则 + 图片地址」做键，并保留一份按地址的识别缓存，重建后直接复用。
 *
 * ============================ 为什么默认只认"读得懂的图" ============================
 * 页面 canvas 读跨域图片会被污染，直接 `fetch` 别人的图又等于替页面发请求。
 * 所以默认只处理：`data:` / `blob:` / 同源 / 页面自己声明过 CORS（`img.crossOrigin`）的图；
 * 跨域图片要**按站点**显式允许（`config.imgOcr.crossOriginSites`，设置页里那个开关）。
 * 不允许时那条会在面板里标成「跨域，未授权识别」，而不是悄悄不显示。
 * ========================================================================= */
'use strict';

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const MSG = KH.MSG;

  /** 传给 OCR 前在内容脚本里缩放的上限（只有 blob: 需要在这里读像素） */
  const CANVAS_MAX_EDGE = 1200;
  /** 小于这个尺寸的图不识别（图标/角标/分隔线，识别出来只会是噪声） */
  const MIN_EDGE = 24;
  /** 按图片地址缓存识别文本（跨重建复用）；上限防止长会话里无限增长 */
  const CACHE_MAX = 200;
  /** 同时最多提交几张（引擎侧本来就是串行的，这里只是别把消息队列灌爆） */
  const MAX_INFLIGHT = 4;

  /** 当前这轮扫描的图片命中项：key = ruleId|src */
  let items = new Map();
  /** src → {text, conf, at}，跨重建复用（LRU：超上限丢最旧的） */
  const textCache = new Map();
  /** requestId → key（结果回来时定位；结果里也带 src，双保险） */
  const pending = new Map();
  /** 正在识别中的 src，避免同一张图重复提交 */
  const inflight = new Set();
  /** 订阅者（面板） */
  const listeners = [];

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error('[KH] 图片命中订阅者异常:', e); }
    }
  }

  function cachePut(src, rec) {
    textCache.set(src, rec);
    if (textCache.size > CACHE_MAX) {
      const oldest = textCache.keys().next();
      if (!oldest.done) textCache.delete(oldest.value);
    }
  }

  /* ---------------- 取图与分类 ---------------- */

  function isExtUi(el) {
    // 插件自己的 UI（面板/编辑器）不参与识别
    for (let n = el; n; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('data-kh-ext-ui')) return true;
    }
    return false;
  }

  /**
   * 「这张图值不值得识别」——**看原图像素，不看容器显示尺寸**（K68）。
   *
   * 实测缺陷（用户报的）：表格里把缩略图用 CSS 压成很小（`width:8px`），而原图其实是
   * 1000×600 的截图、足够 OCR；旧判据只看 `getBoundingClientRect()`，于是判成
   * 「图当前不可见」直接跳过 —— 明明是能识别的。
   * 现在：
   *   ① **原图**最小边 ≥ MIN_EDGE → 识别（我们本来就是取**原图**去识别，容器多小都无所谓，
   *      识别前的预处理还会按需放大）；
   *   ② 原图尺寸**未知**（还没加载完 / SVG 无内在尺寸）→ 退回看显示尺寸：够大就识别、0×0 判 `invisible`；
   *   ③ 原图明确小于 MIN_EDGE → `too-small`（放大显示也变不出像素来，识别认不出）。
   * @returns {'ok'|'invisible'|'too-small'}
   */
  function pixelVerdict(img) {
    const natW = img.naturalWidth || 0;
    const natH = img.naturalHeight || 0;
    let rw = 0;
    let rh = 0;
    if (img.getBoundingClientRect) {
      try { const r = img.getBoundingClientRect(); rw = r.width || 0; rh = r.height || 0; } catch (e) { /* 忽略 */ }
    }
    const naturalKnown = natW > 0 || natH > 0;
    const naturalEnough = natW >= MIN_EDGE && natH >= MIN_EDGE;
    /* ① 原图像素够 → 识别（**容器压得再小都不算"不可见"** —— 我们识别的是原图） */
    if (naturalEnough) return 'ok';
    /* ② 完全没有布局盒（0×0）= 真的没渲染 → 报"不可见"（对用户可操作：展开/滚动出来） */
    if (!(rw > 0 && rh > 0)) return 'invisible';
    /* ③ 渲染着但原图尺寸未知（还没加载完 / SVG 无内在尺寸）→ 用显示尺寸兜底判断 */
    if (!naturalKnown) return (rw >= MIN_EDGE && rh >= MIN_EDGE) ? 'ok' : 'too-small';
    /* ④ 原图明确小于 MIN_EDGE → 放大显示也变不出像素来，直接判"原图太小" */
    return 'too-small';
  }

  function hostOfSite() {
    try { return location.hostname || ''; } catch (e) { return ''; }
  }

  /** 归一化域名：去协议 / 去路径 / 去端口 / 小写 —— 用户手输 `https://cdn.a.com/x.png` 或带端口也要能匹配 */
  function normHost(s) {
    return String(s == null ? '' : s)
      .trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '');
  }

  /** 图片地址所在的域名（拿不到就空串） */
  function hostOfSrc(src) {
    try { return normHost(new URL(src, location.href).hostname); } catch (e) { return ''; }
  }

  /**
   * 该域名是否被授权读取跨域图片。
   * 【K63 修的关键点：**两个域名都认**】旧实现只比对 `location.hostname`（当前页面所在站点），
   * 可用户看到「这张图来自其它网站」时的自然做法是**把图片所在域名**加进白名单 ——
   * 于是授权了却依然提示未授权（实测用户反馈）。现在：
   *   ① 授权"当前站点"→ 该站点上的所有跨域图都放行（旧口径，保持兼容）；
   *   ② 授权"图片所在域名"→ 只放行这个域名的图（更精确，也更符合直觉）。
   * 两侧都做归一化，避免 `https://a.com/`、`a.com:443` 这类写法匹配不上。
   */
  function crossOriginAllowed(cfg, src) {
    const map = (cfg && cfg.imgOcr && cfg.imgOcr.crossOriginSites) || {};
    const keys = Object.keys(map).filter((k) => map[k]).map(normHost);
    if (!keys.length) return false;
    const page = normHost(hostOfSite());
    if (page && keys.indexOf(page) >= 0) return true;
    const img = hostOfSrc(src);
    return !!(img && keys.indexOf(img) >= 0);
  }

  /**
   * 懒加载的"真地址"藏在哪个属性上（进视口才写进 `src`）。
   * 只用于**报告原因**：我们不替页面发请求，所以拿到 data-* 也不直接去取；
   * 等它真加载出来（`load` 事件）会由调度器补一次重建（见 scheduler 的图片 load 通道）。
   */
  function lazySrcOf(img) {
    if (!img || !img.getAttribute) return '';
    const attrs = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-echo', 'data-original-src'];
    for (const a of attrs) {
      const v = img.getAttribute(a);
      if (v) return v;
    }
    return '';
  }

  /**
   * 这张图能不能识别、怎么把像素送到引擎。
   * 【必须始终带上 src（K62）】失败分支也要把地址带出来 —— 否则 `build()` 里那句
   * `if (!src) continue` 会把"跨域未授权 / 懒加载没加载 / 协议不认识"这些条目**整条丢掉**，
   * 面板上什么都不显示、诊断里 `条目=0`，用户完全看不出发生了什么
   * （实测：跨域图与 display:none 里的图都表现为"OCR 毫无反应"）。
   * @returns {{ok:boolean, why?:string, src?:string, viaCanvas?:boolean}}
   */
  function classify(img, cfg) {
    const src = img.currentSrc || img.getAttribute('src') || img.src || '';
    if (!src) {
      const lazy = lazySrcOf(img);
      if (lazy) return { ok: false, why: 'lazy', src: lazy };   // 懒加载：等 load 之后再扫
      return { ok: false, why: 'no-src' };
    }
    if (/^data:/i.test(src)) return { ok: true, src: src };
    if (/^blob:/i.test(src)) return { ok: true, src: src, viaCanvas: true };
    if (!/^https?:/i.test(src)) return { ok: false, why: 'scheme', src: src };
    let sameOrigin = false;
    try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch (e) { return { ok: false, why: 'bad-url', src: src }; }
    if (sameOrigin) return { ok: true, src: src };
    if (img.crossOrigin) return { ok: true, src: src };          // 页面自己声明了 CORS：像素可读
    if (crossOriginAllowed(cfg, src)) return { ok: true, src: src };  // 站点级显式授权（当前站点 或 图片域名）
    /* 未授权时**必须带上图片所在域名**：面板与诊断要能直接告诉用户"把哪个域名加进白名单" */
    return { ok: false, why: 'cross-origin', src: src, host: hostOfSrc(src) };
  }

  /** blob: 只能在这里读像素（跨源画布会抛异常 → 交给上层标成"读不出来"） */
  function canvasDataUrl(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (!w || !h) return null;
    const scale = Math.min(1, CANVAS_MAX_EDGE / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  }

  /** 一个锚点（= 一次标题命中定位到的一个/一列取值格）里要识别的图片，按文档序、受每锚点上限约束 */
  function collectImages(anchor, cfg) {
    const rule = anchor.rule;
    const max = Math.max(1, (rule.meta && rule.meta.imgOcrMax) || 1);
    const out = [];
    const seen = new Set();
    for (const cell of (anchor.valueCells || [])) {
      if (!cell || !cell.querySelectorAll) continue;
      for (const img of cell.querySelectorAll('img')) {
        if (out.length >= max) return out;
        if (isExtUi(img)) continue;
        const cls = classify(img, cfg);
        const key = cls.src || '';
        if (key && seen.has(key)) continue;          // 同一格里重复贴同一张图只算一次
        if (key) seen.add(key);
        if (img.getAttribute && img.getAttribute('data-kh-ocr-skip') != null) continue;
        /* 【不可见也要留条目（K62）】以前这里直接 `continue` —— 于是"值在图里、但那一块当前是折叠的"
         * 表现成"条目=0、面板什么都没有"，用户完全看不出原因。
         * 但**分类失败的原因更具体，要优先保留**：懒加载的图本来就可能还没尺寸，
         * 那时报 'lazy'（等它加载）比报 'invisible' 有用得多。 */
        if (!cls.ok) { out.push({ img: img, cls: cls, idx: out.length }); continue; }
        /* 【按原图判"值不值得识别"（K68）】容器把图压得很小不算"不可见" —— 见 pixelVerdict 顶部注释 */
        const pv = pixelVerdict(img);
        if (pv !== 'ok') { out.push({ img: img, cls: { ok: false, why: pv, src: cls.src }, idx: out.length }); continue; }
        out.push({ img: img, cls: cls, idx: out.length });
      }
    }
    return out;
  }

  /* ---------------- 图上是否真的出现这个词（与文本同一套匹配实现） ---------------- */

  /** `imgOcrKeyword` → 正则（编译一次、多处复用）。留空 = 没有匹配口径（不再回落核心词）。 */
  const ocrPatternCache = new Map();

  /**
   * 「图片命中关键词」的**唯一编译点**（用户确认的匹配口径）：
   *   `useRegex: true` + `wholeWord: false` + `caseSensitive: false`
   * 即"当作正则、不要求整词、不区分大小写"。
   *
   * 【为什么不再回落成规则核心词】用户确认："图片命中关键词"是唯一口径，留空就不该处于
   * 勾选状态（`Config.normalize` 已把这种存量脏配置的开关关掉）。回落会让"填了 A、却按 B 命中"
   * 这种看不懂的行为出现。
   *
   * 【为什么走 `Compiler.buildPattern`】正则构造全工程只有一份（转义 / 全词边界 / `g` 兜底 /
   * 非法正则返回 null 都在那里）；在这里自己 `new RegExp` 就是第二份实现。
   */
  function ocrPatternOf(rule) {
    const raw = String((rule && rule.meta && rule.meta.imgOcrKeyword) || '').trim();
    if (!raw) return null;
    if (!KH.Compiler || typeof KH.Compiler.buildPattern !== 'function') return null;
    let re = ocrPatternCache.get(raw);
    if (!re) {
      re = KH.Compiler.buildPattern(raw, { caseSensitive: false, wholeWord: false, useRegex: true });
      ocrPatternCache.set(raw, re || null);
    }
    return re || null;
  }

  /**
   * 识别文本里是否出现「图片命中关键词」。
   * 匹配实现**必须复用内核唯一入口** `Scanner.util.matchIn`（大小写 / 空匹配保护 / `g` 兜底都在它里面）：
   * 造一个**脱离文档**的文本节点，把整段识别文本当成"一个文本节点"跑同一个入口 ——
   * 于是"图片命中"与"文本命中"的匹配语义不会打架。
   */
  function matchedInText(rule, text) {
    const U = (KH.Scanner && KH.Scanner.util) || {};
    const pattern = ocrPatternOf(rule);
    if (!pattern || typeof U.matchIn !== 'function') return [];
    try {
      const node = document.createTextNode(text || '');
      return U.matchIn(pattern, node, { util: U }, { caseSensitive: false, wholeWord: false, useRegex: true }) || [];
    } catch (e) {
      return [];
    }
  }

  /* ---------------- 提交与回收 ---------------- */

  let inflightCount = 0;

  function submit(entry, cfg) {
    if (inflightCount >= MAX_INFLIGHT) return false;
    const cls = entry.cls;
    let payload = null;
    if (cls.viaCanvas) {
      let dataUrl = null;
      try { dataUrl = canvasDataUrl(entry.img); } catch (e) { dataUrl = null; }
      if (!dataUrl) { entry.state = 'blocked'; entry.why = 'tainted'; return false; }
      payload = { dataUrl: dataUrl };
    } else {
      payload = { src: cls.src };
    }
    inflightCount += 1;
    inflight.add(cls.src);
    entry.state = 'pending';
    try {
      chrome.runtime.sendMessage(Object.assign({
        type: MSG.OCR_IMAGE,
        keyword: (entry.rule && entry.rule.meta && entry.rule.meta.display) || entry.keyword || '',
        /* 识别档位（K67）：跟配置走 —— 引擎按 `_std` 后缀选包，两档缓存互不覆盖 */
        quality: (cfg && cfg.imgOcr && cfg.imgOcr.quality) === 'best' ? 'best' : 'fast'
      }, payload), (res) => {
        void chrome.runtime.lastError;
        if (res && res.requestId) pending.set(res.requestId, entry.key);
        else { inflightCount = Math.max(0, inflightCount - 1); inflight.delete(cls.src); entry.state = 'fail'; entry.error = (res && res.error) || 'OCR 引擎未响应'; notify(); }
      });
    } catch (e) {
      inflightCount = Math.max(0, inflightCount - 1);
      inflight.delete(cls.src);
      entry.state = 'fail';
      entry.error = String((e && e.message) || e);
    }
    return true;
  }

  /** 结果回来（background 中转） */
  function onResult(msg) {
    const key = pending.get(msg.requestId) || null;
    if (key) pending.delete(msg.requestId);
    const src = msg.src || '';
    if (src) { inflight.delete(src); inflightCount = Math.max(0, inflightCount - 1); }

    const text = String(msg.text || '');
    if (msg.ok && src) cachePut(src, { text: text, conf: msg.confidence || 0, at: Date.now() });

    /* 结果对应的那条（可能因为页面重建而不在了：那就只更新缓存，不动 UI） */
    const entry = key ? items.get(key) : null;
    const targets = entry ? [entry] : Array.from(items.values()).filter((it) => it.src && it.src === src);
    for (const it of targets) {
      if (msg.ok) {
        it.state = 'done';
        it.text = text;
        it.conf = msg.confidence || 0;
        it.matched = matchedInText(it.rule, text);
        it.ocrMs = msg.ocrMs;
      } else {
        it.state = 'fail';
        it.error = msg.error || '识别失败';
        it.errorCode = msg.code || '';
        if (msg.code === 'lang-missing') it.why = 'lang-missing';
      }
    }
    if (targets.length) notify();
  }

  /* ---------------- Feature：⑦Consume 采集 ---------------- */

  /**
   * 本轮要处理的「锚点」= `{ rule, cell }`，来源**只有一个**：
   *   · `hits`：**真命中所在格**（普通词与组合词走同一套 `cellOfHit`）。
   * 锚点**只用来定位"在哪张表/哪一行"**：取图范围一律以「抓取后续字段」为准（见 build）。
   *
   * 【K75】原来还有第二条来源 `ctx.imgAnchors`（组合词 Probe 在"标题词定位到那一格"时就登记，
   * **不看核心词有没有命中**）。用户口径：「判断命中了普通词/组合词没有…如果没有命中，
   * 那就不需要考虑图片 ocr 和图片关键词」⇒ 那条来源已删（生产方也删了，见 combo.js）。
   *
   * 准入条件（第 1/2 条，保持不变）：
   *   · `meta.imgOcr` 未勾选 → 跳过；
   *   · `meta.fetchLabels` 为空 → 跳过（没配抓取字段就无从取图）；
   *   · `meta.imgOcrKeyword` 为空 → 跳过（没有匹配口径，条目只会是噪声）。
   */
  function anchorsFor(ctx, hits) {
    const out = [];
    const seen = new Set();
    const push = (rule, cell) => {
      if (!rule || !rule.meta || !cell) return;
      if (!rule.meta.imgOcr) return;
      if (!String(rule.meta.fetchLabels || '').trim()) return;
      if (!String(rule.meta.imgOcrKeyword || '').trim()) return;
      const key = String(rule.ruleId) + '|' + idxOf(cell);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ rule: rule, cell: cell });
    };
    for (const h of (hits || [])) {
      if (!h || !h.meta || !h.meta.imgOcr || !h.textNode) continue;
      /* 命中记录带的是 rule.meta 的快照（没有 pattern/labelPattern，本 Feature 也不需要） */
      push({ ruleId: h.ruleId, meta: h.meta }, cellOfHit(h, ctx));
    }
    return out;
  }

  /** 元素身份键（只为"同一格不重复处理"去重；用自增序号，避免给页面元素挂属性） */
  const cellIds = new WeakMap();
  let cellSeq = 0;
  function idxOf(el) {
    if (!el || typeof el !== 'object') return '?';
    let id = cellIds.get(el);
    if (!id) { id = ++cellSeq; cellIds.set(el, id); }
    return String(id);
  }

  function cellOfHit(h, ctx) {
    const Cells = KH.Cells;
    if (Cells && typeof Cells.cellOf === 'function') {
      try { const c = Cells.cellOf(h.textNode, ctx || {}); if (c) return c; } catch (e) { /* 落回兜底 */ }
    }
    const el = h.textNode.parentElement;
    if (!el) return null;
    if (el.closest) { const td = el.closest('td,th'); if (td) return td; }
    return el;
  }

  function build(cfg, ctx, hits) {
    const next = new Map();
    for (const anchor of anchorsFor(ctx, hits)) {
      const rule = anchor.rule;
      /* 取图范围 = 按**同一个 `fetchScope`** 选定的层级里，所有已配置抓取字段的值格
       * （不管字段有没有 `#图` 修饰）—— K74 §四.5：你选哪一层抓字段，就从哪一层的值格取图。
       * `Fetch.cellsForHit` 是只读访问口，抓取内容的既有语义（#图/#N/跨格累计/去重）一点不动。 */
      const fields = (KH.Fetch && typeof KH.Fetch.cellsForHit === 'function')
        ? KH.Fetch.cellsForHit(anchor.cell, rule.meta || '')
        : [];
      if (!fields.length) continue;
      const valueCells = [];
      const labelOfImg = new Map();
      for (const f of fields) {
        for (const c of (f.cells || [])) valueCells.push(c);
        for (const im of (f.imgs || [])) if (!labelOfImg.has(im)) labelOfImg.set(im, f.label);
      }
      if (!valueCells.length) continue;
      /* 【不能因为"读不出地址"就丢掉条目（K62）】跨域/懒加载/协议不认识的图都要**留在表里**并带上原因，
       * 否则面板什么都不显示、诊断是「条目=0」，用户完全不知道发生了什么。没有 src 的用序号兜底做键。 */
      for (const got of collectImages({ rule: rule, valueCells: valueCells, anchorCell: anchor.cell }, cfg)) {
        const cls = got.cls;
        const src = cls.src || '';
        const key = rule.ruleId + '|' + (src || ('#' + got.idx));
        if (next.has(key)) continue;
        const cached = src ? textCache.get(src) : null;
        const item = {
          key: key, ruleId: rule.ruleId, rule: rule,
          /* 面板行的关键词标签显示**图片命中关键词**（用户确认第 6 条）——它才是"在图里找什么" */
          keyword: String((rule.meta && rule.meta.imgOcrKeyword) || ''),
          label: String(labelOfImg.get(got.img) || ''),
          src: src, cls: cls, host: cls.host || '',
          state: 'idle', matched: [], text: '', conf: 0,
          cellText: String((anchor.cell && anchor.cell.textContent) || '').trim().slice(0, 120)
        };
        if (cached) {
          item.state = 'done';
          item.text = cached.text;
          item.conf = cached.conf;
          item.matched = matchedInText(rule, cached.text);
        } else if (!cls.ok) {
          item.state = 'blocked';
          item.why = cls.why;
        } else if (inflight.has(src)) {
          item.state = 'pending';
        }
        next.set(key, item);
      }
    }
    items = next;
    /* 采集完再统一排队（先建表再提交，避免结果回来时条目还没建） */
    for (const it of items.values()) {
      if (it.state === 'idle') submit(it, cfg);
    }
  }

  if (KH.features) {
    KH.features.register('img-ocr', {
      /**
       * @param {object[]} hits 注册表命中 —— 普通词与组合词**都走这条路**：
       *   用"命中所在格"当锚点（K75 起**唯一**来源；`ctx.imgAnchors` 那条旧路已删）。
       * @param {object} cfg 当前配置
       * @param {object} ctx 扫描上下文（管线注入）
       */
      consume(hits, cfg, ctx) {
        /* 【仅消费通道要跳过这里】P2 的快通道只重跑 ⑦Consume 来刷"抓取字段"，
         * 它给的 hits 里没有本轮的全部命中 —— 照常 build 会把已有图片命中**清空**。
         * 图片相关的变更本来就会判成 'full'（见 relevance.js ④），所以这里直接不动是最安全的。 */
        if (ctx && ctx.consumeOnly) return;
        build(cfg, ctx, hits);
        notify();
      },
      /** 重建清底：条目清掉但**缓存留着**（同一张图不必反复识别） */
      clear(reason) {
        items = new Map();
        pending.clear();
        if (reason === 'destroy') {
          inflight.clear();
          inflightCount = 0;
        }
        notify();
      }
    });
  }

  /* 结果经 background 回到内容脚本（`to:'content'` 才是给我们的，别的上下文的消息不认） */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== MSG.OCR_RESULT) return false;
      if (msg.to && msg.to !== 'content') return false;
      onResult(msg);
      return false;
    });
  }

  KH.ImgOcr = {
    items: () => Array.from(items.values()),
    onChange: onChange,
    notify: notify,
    /** 诊断/回归用 */
    _debug: () => {
      /* 「没识别成功」的**原因分布**（K62）：用户现场是「条目=0」，但"条目=0"与
       * "条目都在但全是跨域未授权/懒加载"是两种完全不同的情形，必须能分开看。 */
      const blocked = {};
      for (const it of items.values()) {
        if (it.state === 'blocked' || it.state === 'fail') {
          let why = it.why || it.errorCode || it.error || 'unknown';
          /* 跨域必须带上**图片所在域名**：用户的下一步动作就是把它加进白名单 */
          if (it.why === 'cross-origin' && it.host) why = 'cross-origin:' + it.host;
          blocked[why] = (blocked[why] || 0) + 1;
        }
      }
      return {
        items: items.size, cache: textCache.size, pending: pending.size, inflight: inflightCount,
        blocked: blocked,
        states: Array.from(items.values()).map((i) => i.key + ':' + i.state)
      };
    },
    classify: classify,
    matchedInText: matchedInText,
    /** 匹配口径的唯一编译点（诊断/单测用；见 `ocrPatternOf`） */
    ocrPatternOf: ocrPatternOf,
    build: build
  };
})();
