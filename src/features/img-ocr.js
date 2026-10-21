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
 *   · important-note.js：只负责把 `KH.ImgOcr.items()` 画进面板最上面那张「截图」表。
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
  /**
   * 【S1-b · 额度按 **token** 记账，不再按 src 数数】
   * 旧实现用 `inflightCount` + `inflight`(Set of src)，结果回来时靠 `if (msg.src)` 才归还 ——
   * 而 `viaCanvas`（blob:/画布那条路）的回执**没有 src** ⇒ 额度只减不增，
   * 累积 4 次（MAX_INFLIGHT）整页 OCR 静默全废（票 #16 ③ 的根因）。
   * 现在 `held`(token → 记账) 是唯一真源、`pending`(requestId → token) 负责认领，
   * 归还＝`held.delete(token)` ⇒ **天然幂等**（重复归还不会多减，也不会还成负数）。
   */
  const held = new Map();          // token -> { key, src, reqId, at }
  /** requestId → token（结果回来时定位该还哪一笔） */
  const pending = new Map();
  /** 已经发出去、还没拿到 requestId 的那几笔（窗口极短，但额度必须算上） */
  let awaitingId = 0;
  /** 正在识别中的 src：只用于"同一张图别重复提交"的去重（**与额度无关**） */
  const inflight = new Set();
  /**
   * 【2.0.1.17 右键任意图 OCR】用户手动点名的图（key = `ctxmenu|<src>`）。
   * 为什么单开一张表、而不是塞进 `items`：`items` 每轮扫描都被**整体重造**（`items = next`），
   * 而右键识别的结果不属于任何规则、不会由 `build()` 重新产出来 —— 塞进去下一次页面变动就没了。
   * 它与 `items` 的关系是"并集"：面板读 `items()`，本表在 `build()` 里并回去、`clear()` 时按档清。
   */
  const manual = new Map();
  /**
   * 【2.0.6.1 需求⑨】失败备忘：src → 失败时刻。引擎报错 / 超时后，同一张图在本会话里
   * 不再自动重排（`FAIL_MEMO_MS` 后放行一次）。没有这张表时，页面每次重扫都会把它当新条目
   * 再提交一遍 —— 用户体感就是"图里根本没字，却一直很慢、页面还卡"。
   * 右键手动识别**不写这张表**（用户主动点名的那一次，必须真的再跑）。
   */
  const failSrc = new Map();
  const FAIL_MEMO_MS = 10 * 60 * 1000;
  let tokenSeq = 0;
  /**
   * 超过这么久还没有终态 → 内容脚本**自己判死**。
   * 比后台硬顶（120s）宽，是为了"后台先判"这条优先级：正常情况下后台的 `timeout` 先到，
   * 这一层只兜真实存在的场景 —— MV3 把 service worker 杀了，回执永远不会来。
   */
  const JOB_STALE_MS = 150000;
  /** 收口定时器（只在有在途请求时武装；`unref` 是不拖住 node 单测进程） */
  let sweepTimer = null;
  /** 订阅者（面板） */
  const listeners = [];

  /** 当前占用了几笔额度（在途 + 刚发出还没拿到 requestId 的） */
  function quotaUsed() { return held.size + awaitingId; }

  /** 归还一笔额度（**幂等**：认领不到就什么都不做） */
  function releaseHold(token) {
    if (!token) return false;
    const rec = held.get(token);
    if (!rec) return false;
    held.delete(token);
    if (rec.reqId) pending.delete(rec.reqId);
    if (rec.src) inflight.delete(rec.src);
    return true;
  }

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

  /** 绝对化图片地址（缓存/等待者的键必须统一：相对地址在不同上下文里指的不是同一张图） */
  function absOf(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const base = (typeof document !== 'undefined' && document.baseURI) || location.href;
      return new URL(s, base).href;
    } catch (e) { return s; }
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
    /* 【名额只算"真能识别的图"（2.0.2.5 需求① · 多抓取字段时 OCR 不拉起）】
     * 老口径 `out.length >= max` 连**根本识别不了**的图（跨域未授权 / 懒加载 / 无 src / 原图太小）
     * 一起吃名额，而且当场 `return` ⇒ 排在前面的字段里放 logo、图标、懒加载占位图的那些，
     * 会把额度吃光，真正的「截图」字段连条目都建不出来（探针 B/C 现场：好图连一条都没有）。
     * 现在：`okCount` 只数能识别并提交的图，名额被它独占；扫描**不再因坏图提前终止**（继续往后找好图）。
     * 坏图仍留"原因条目"给面板诊断（K62），但另用一个 whyCount 限流，最多 `max` 条 ——
     * 免得一个格子里几十张懒加载占位图把面板刷满。 */
    let okCount = 0;
    let whyCount = 0;
    const pushWhy = (img, cls) => {
      if (whyCount >= max) return;
      whyCount++;
      out.push({ img: img, cls: cls, idx: out.length });
    };
    for (const cell of (anchor.valueCells || [])) {
      if (!cell || !cell.querySelectorAll) continue;
      for (const img of cell.querySelectorAll('img')) {
        if (okCount >= max) return out;
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
        if (!cls.ok) { pushWhy(img, cls); continue; }
        /* 【按原图判"值不值得识别"（K68）】容器把图压得很小不算"不可见" —— 见 pixelVerdict 顶部注释 */
        const pv = pixelVerdict(img);
        if (pv !== 'ok') { pushWhy(img, { ok: false, why: pv, src: cls.src }); continue; }
        okCount++;
        out.push({ img: img, cls: cls, idx: out.length });
      }
    }
    return out;
  }

  /* ---------------- 图上是否真的出现这个词（与文本同一套匹配实现） ---------------- */

  /** `imgOcrKeyword` → 正则（编译一次、多处复用）。留空 = 没有匹配口径（不再回落核心词）。 */
  const ocrPatternCache = new Map();

  /* ---------------- 【2.0.4 需求①】「键值行进表」后缀标记 ----------------
   * 用户口径：图上 `X：Y` 这种键值行并进重要笔记的抓取表，**必须先对那个词配一个后缀标记**才生效。
   * 旧行为是"凡是命中行的 `X：Y` 都进表"⇒ 范围过大：`一对一时间选择范围11:30.` 会被拆成
   * 「一对一时间选择范围 | 11:30.」塞进卡片（用户报的就是这条）。
   * 现在标记写在「图片命中关键词」的**那一个胶囊末尾**，`#表` / `#kv` 两种写法都认：
   * `一对一#表|包名` ⇒ 只有「一对一」会往表里补行，「包名」只做命中判定。
   * 标记必须**逐词**给 —— 一个词误配不波及其它词，这就是"收严"的全部含义。 */
  const KV_MARK = /(?:#|＃)\s*(?:表|kv)\s*$/i;
  const kvChips = (raw) => String(raw == null ? '' : raw).split(/[|｜]/);

  /** 去掉标记后的关键词原文（喂 `buildPattern` / 空白容忍重试）：标记本身绝不能被当成匹配字面 */
  function stripKvMarks(raw) {
    return kvChips(raw).map((c) => c.replace(KV_MARK, '').trim()).filter(Boolean).join('|');
  }

  /** 带标记的那些词（标记已剥掉）——**只有它们**允许把图上「词 + 分隔符 + 值」并进抓取表 */
  function kvWords(raw) {
    return kvChips(raw).filter((c) => KV_MARK.test(c))
      .map((c) => c.replace(KV_MARK, '').trim()).filter(Boolean);
  }

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
    const raw = stripKvMarks(rule && rule.meta && rule.meta.imgOcrKeyword).trim();
    if (!raw) return null;
    return patternOf(raw);
  }

  /**
   * 关键词原文 → 编译后的模式（带缓存）。**唯一**的正则构造点仍是 `Compiler.buildPattern`：
   * 空白容忍那条路要的是"同一个词、剔空白后的字面"，所以它按**剔空白后的字面**再编译一次 ——
   * 与用户手打「登记号」拿到的模式完全等价，缓存键因此可以直接共用关键词原文。
   * @param {string} rawKey 关键词（或它的剔空白形态）
   */
  function patternOf(rawKey) {
    if (!KH.Compiler || typeof KH.Compiler.buildPattern !== 'function') return null;
    if (ocrPatternCache.has(rawKey)) return ocrPatternCache.get(rawKey);
    const built = KH.Compiler.buildPattern(rawKey, { caseSensitive: false, wholeWord: false, useRegex: true });
    ocrPatternCache.set(rawKey, built || null);
    return built || null;
  }

  /* 【2.0.6.1 需求①⑦ · 口径变更（用户原话）】
   * 「图片关键词（包括动态关键词）命中是需要忽略 ocr 结果里的空格的。现在登记号，识别成
   *   登 记 号，或者登记 号等就不判为命中了。」
   * 旧口径（票 #34）只剔**行内**空白、`\r`/`\n` 留着 ⇒ OCR 把一整串公司名折成两行、把
   * 「登记号」读成一行一个字的时候，静态词与动态判据**都**判不中，用户看到的是
   * 「图上明明有，却说没命中」。现在两侧一律剔掉**全部空白（含换行）**：换行只是检测框
   * 切行留下的版面痕迹，不是语义。
   * 两个常量必须**同时**认全部空白：`unshrinkRange` 靠"跳过被剔掉的字符"做下标映射，
   * 口径不一致会逐行错位（命中块就画到别的字上）。 */
  const WHITE_CHAR = /\s/;
  const WHITE_ALL = /\s+/g;

  /**
   * 把「剔空白文本」里的区间映射回**原文**区间。
   * 【为什么必须映射】命中片段要喂给 `OcrCopy.sentenceOf(text, needle)`，而它是在**原文**里
   * `indexOf` —— 给一个剔过空白的版本就定位不到整句，用户点词块复制就复制不到东西。
   * 映射不到（区间越界）返回 null，调用方丢掉这一条，不许猜。
   */
  function unshrinkRange(text, from, to) {
    let seen = 0;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (WHITE_CHAR.test(text.charAt(i))) continue;
      if (seen === from) start = i;
      seen += 1;
      if (seen === to) return (start >= 0) ? { start: start, end: i + 1 } : null;
    }
    return null;
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
    const raw = String(text || '');
    /* 内核唯一匹配入口：造一个**脱离文档**的文本节点，把整段识别文本当成"一个文本节点" */
    const run = (pat, src) => {
      try {
        return U.matchIn(pat, document.createTextNode(src), { util: U },
          { caseSensitive: false, wholeWord: false, useRegex: true }) || [];
      } catch (e) {
        return [];
      }
    };
    const direct = run(pattern, raw);
    if (direct.length) return direct;
    /* 【空白容忍 · 2.0.2.4 需求③】OCR 把「登记号」读成「登记 号」是常态（分栏/字距/表格线都会插空白），
     * 而"图片命中关键词"是人手打的 —— 一字之差就整条不命中，用户看到的是"识别了却说没命中"。
     * 口径：**原样匹配不中时**，两侧各剔一次空白再试一次（顺序固定，先"文本剔空白"这条最常见）。
     * 两条纪律：
     *   ① 只在"直接匹配失败"后才走这条路 —— 不改变既有语义，零额外开销；
     *   ② 命中片段与区间**映射回原文**（见 `unshrinkRange`），面板上的词块与复制整句照旧可用；
     *   ③ 剔的只是**行内空白**（`WHITE_ALL` 不含 `\r`/`\n`）—— 跨行的词不算命中（票 #34 口径）。 */
    const rawKeyword = stripKvMarks(rule && rule.meta && rule.meta.imgOcrKeyword).trim();
    const compactKeyword = rawKeyword.replace(WHITE_ALL, '');
    const textHasWs = WHITE_CHAR.test(raw);
    /* 两侧都没有空白 ⇒ 直接匹配已经就是终局，不走第二条路（零额外开销） */
    if (!textHasWs && compactKeyword === rawKeyword) return direct;
    const compact = textHasWs ? raw.replace(WHITE_ALL, '') : raw;
    const tries = [];
    if (textHasWs) tries.push({ pat: pattern, text: compact });
    if (compactKeyword !== rawKeyword) {
      const pat2 = patternOf(compactKeyword);
      if (pat2) tries.push({ pat: pat2, text: compact });
    }
    for (const t of tries) {
      const hits = run(t.pat, t.text);
      if (!hits.length) continue;
      const out = [];
      for (const m of hits) {
        const r = unshrinkRange(raw, m.start, m.end);
        if (r) out.push({ start: r.start, end: r.end, text: raw.slice(r.start, r.end) });
      }
      if (out.length) return out;
    }
    return direct;
  }

  /**
   * 【2.0.2.19 需求③】动态命中的**唯一判决点**。
   * 用户口径：「图片命中关键词配置支持配置抓取字段内容（动态结果）：例如配置抓取字段 姓名、截图，
   * 若 姓名 抓到的值是 张三 且截图图里也有 张三 则判命中；姓名是张三而图里没有张三则不命中」
   * ⇒ 动态判据 = **`imgOcrNeed` 里点名的那几个抓取字段**抓到的值，必须出现在识别文本里。
   *
   * 三条纪律（为什么不按"全部抓取字段"一刀切）：
   *   ① **留空即旧行为**：没填 `imgOcrNeed` 就一行都不变，存量配置不该因为升级而少命中；
   *   ② 配了就与静态「图片命中关键词」是**且**关系（用户原话的"且"）：静态词命中 + 每个点名值都在图上；
   *   ③ 只填 `imgOcrNeed`、不填静态词也算一条合法配置（用户例子里就只有 姓名、截图 两个字段）——
   *      此时"值出现在图上"就是命中的全部条件。
   * 比较口径与「图片命中关键词」同一条：剔行内空白、不分大小写（OCR 把「张 三」读散是常态）。
   * @param {object} rule 规则快照（提供 `meta.imgOcrKeyword`）
   * @param {string} text 识别文本
   * @param {string[]} need 动态判据值（`needOf` 归一后的；空数组 = 没有动态要求）
   */
  function judgeInfo(rule, text, need) {
    const raw = String(text || '');
    const stat = matchedInText(rule, raw);
    const hasStatic = !!stripKvMarks(rule && rule.meta && rule.meta.imgOcrKeyword).trim();
    const dyn = (need || []).filter(Boolean);
    if (!dyn.length) return { hits: stat, missingValues: [], staticMiss: false };
    const flat = raw.replace(WHITE_ALL, '').toLowerCase();
    const found = [];
    /* 【2.0.6.1 需求③】缺失的值**全收集**再返回：面板要把「图上找不到哪几个值」说出来，
     * 否则用户只看到"没命中"却不知道差在哪（这正是本批需求①报的现象）。 */
    const missingValues = [];
    for (const v of dyn) {
      /* `need` 通常已由 `needOf` 归一（小写 + 剔空白），这里再兜一次：判决点自己把两侧弄成同口径，
       * 免得调用方（含单测与后续新入口）拿"原样大小写"的值进来就静默不命中。 */
      const needle = String(v == null ? '' : v).replace(WHITE_ALL, '').toLowerCase();
      if (!needle) continue;
      const at = flat.indexOf(needle);
      if (at < 0) { missingValues.push(String(v)); continue; }
      /* 命中块要落在**原文**里（面板上的词块与"复制整句"靠它），所以映射回未剔空白的区间 */
      const span = unshrinkRange(raw, at, at + needle.length);
      found.push(span
        ? { start: span.start, end: span.end, text: raw.slice(span.start, span.end) }
        : { start: 0, end: 0, text: needle });
    }
    /* 【2.0.6.2 需求①】静态词与动态值**各判各的，不再互相清零**。
     * 旧写法两处都是"一票否决"：`if (missingValues.length) return { hits: [] }`（缺一个动态值 ⇒ 连
     * 静态命中一起清）与 `hits: stat.length ? stat.concat(found) : []`（静态词没判中 ⇒ 动态命中一起清）。
     * 用户现场（m08130 第 1 条）正是这个耦合：先只配「图片动态关键词」（`imgOcrKeyword` 为空 ⇒ 走
     * 「值在图上即命中」），之后往「图片命中关键词」加一个词 ⇒ `hasStatic` 变真、判决改走 AND 分支，
     * 新词一旦没判中（正则写法 / 空白 / 大小写细节），**整条命中也跟着归零** ⇒ 用户看到的就是
     * 「OCR 里明明有命中词，加了个词反而不生效」。
     * 现在：命中的定义回到用户直觉——**OCR 文本里出现命中词或动态值就算命中**；
     * 「动态值没凑齐」与「静态词没中」作为**诊断**带出去（`missingValues` / `staticMiss`），
     * 由面板决定怎么解释（KV 行仍按动态值过滤，见 `ocrExtraRows`）。 */
    return {
      hits: stat.concat(found),
      missingValues: missingValues,
      staticMiss: !!(hasStatic && !stat.length)
    };
  }

  /** 判决 = `judgeInfo().hits`（唯一实现；诊断字段由 `judgeInfo` 带出） */
  function judge(rule, text, need) {
    return judgeInfo(rule, text, need).hits;
  }

  /**
   * 【2.0.4 需求②】`imgOcrNeed` 点名的抓取字段 → 动态判据值表（`need`）。
   *
   * 用户口径（原话）：「是否可以改成和抓取字段**一模一样**，默认正则、不区分大小写」。
   * 旧实现的病根有两处，都在取值的**来源**上：
   *   ① 字段名匹配直接拿 `cellsForHit` 的 `label`（已被 `parseLabels` 剥成裸名）去和用户原文比
   *      ⇒ 用户在「图片动态关键词」里照抄 `开发者^高价`（跟抓取字段一个写法）时**永远匹配不上**，
   *      整条动态判据被静默丢掉（不是不生效，是根本没算）；
   *   ② 值取的是**值格的 textContent 原文**，没走 `rowsForItem` 的 `!`/`^`/`%` 修饰
   *      ⇒ 笔记表里显示的是修饰后的干净值，判据里却是带尾巴的原始值，图上当然找不到。
   * 现在：值一律走 `Fetch.extractFor` —— **与重要笔记表格同一份取值实现**（同一份分层、同一份修饰），
   * 字段名按 `parseLabelSpec` / `baseLabelOf` 归一后比（后缀写不写都认）。这就是"一模一样"。
   *
   * 三条纪律（不变）：值太短不参与（图上"1"/"是"到处都是，拿它当判据只会假命中）；
   * 占位词（无/暂无/`-`）跳过；留空即旧行为（一行不改）。
   */
  const NEED_MIN_LEN = 2;

  /** 图片动态关键词原文 → 要看的抓取字段名（后缀可写可不写，按裸名比） */
  function needNames(rawLabels) {
    const out = [];
    const parse = (KH.Fetch && typeof KH.Fetch.parseLabelSpec === 'function') ? KH.Fetch.parseLabelSpec : null;
    for (const w of String(rawLabels || '').split(/[,，、|;]/)) {
      const s = w.trim();
      if (!s) continue;
      let name = s;
      if (parse) {
        try { const p = parse(s); if (p && p.label) name = String(p.label).trim(); } catch (e) { name = s; }
      }
      if (name && out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  /**
   * 【2.0.6.1 需求①③】`needOf` 的**带诊断版**：除了判据值，还要说清「点名的字段里有哪个
   * 根本没取到值」。
   *
   * 为什么必须带出来：旧实现三处都 `return []` —— 字段名写错、字段不在抓取字段里、
   * 锚点取不到，全都会静默变成"没有动态要求"，于是**永远不命中且毫无提示**。
   * 用户报的正是这个观感（「难道加的字段名也参与命中，那不就是永远也不会命中么」）。
   * 现在解析不出来 → `missing` 里点名，面板照实说「抓取字段 X 没取到值」，不再静默。
   *
   * @returns {{values: string[], want: string[], missing: string[]}}
   *   `values` 已归一（剔全部空白 + 小写），喂 `judge`；
   *   `want` 是用户点名的字段名（已剥后缀）；
   *   `missing` 是**点名了但没在抓取结果里出现**的字段名。
   */
  function needInfo(hitOrCell, rule) {
    const meta = (rule && rule.meta) || {};
    const want = needNames(meta.imgOcrNeed);
    const info = { values: [], want: want, missing: [] };
    if (!want.length) return info;                    // 留空即旧行为：没有动态判据
    const Fetch = KH.Fetch || {};
    if (typeof Fetch.extractFor !== 'function') { info.missing = want.slice(); return info; }
    const anchor = (hitOrCell && hitOrCell.cell) ? hitOrCell.cell : hitOrCell;
    if (!anchor) { info.missing = want.slice(); return info; }
    let entries = [];
    try {
      entries = Fetch.extractFor(anchor, meta.fetchLabels || '', meta.fetchScope, null) || [];
    } catch (e) { info.missing = want.slice(); return info; }
    const out = [];
    const seen = [];
    const base = (typeof Fetch.baseLabelOf === 'function') ? Fetch.baseLabelOf : ((s) => s);
    for (const en of entries) {
      const label = String((en && en.label) || '').trim();
      if (!label) continue;
      let bare = label;
      try { bare = String(base(label) || label); } catch (e) { bare = label; }
      if (want.indexOf(label) < 0 && want.indexOf(bare) < 0) continue;
      if (seen.indexOf(label) < 0) seen.push(label);
      if (seen.indexOf(bare) < 0) seen.push(bare);
      for (const row of (en.rows || [])) {
        for (const c of (row || [])) {
          const raw = String((c && c.t) || '');
          if (!raw) continue;
          if (typeof Fetch.isPlaceholderText === 'function' && Fetch.isPlaceholderText(raw)) continue;
          /* 先剔图片占位符（`\u0001KHIMG\u0001alt|url\u0001ENDIMG\u0001`）再剔空白：
           * 只删开头那个标记会把 url 留在值里，值与 OCR 文本就永远对不上（真机抓到的红）。
           * 剥离实现只有一份，与 `#0`（不要图）共用。 */
          const plain = (typeof Fetch.stripImgPlaceholders === 'function') ? Fetch.stripImgPlaceholders(raw) : raw;
          /* 逐格一个判据（沿用旧口径：格子里的值各自比）；空白/换行一律剔（与 `judge` 同口径） */
          const t = plain.replace(WHITE_ALL, '').replace(/[\r\n]+/g, '').toLowerCase();
          if (t.length < NEED_MIN_LEN) continue;
          if (out.indexOf(t) < 0) out.push(t);
        }
      }
    }
    info.values = out;
    info.missing = want.filter((n) => seen.indexOf(n) < 0);
    return info;
  }

  /** 只要值（判决点与单测的既有入口）：`needInfo().values` */
  function needOf(hitOrCell, rule) {
    return needInfo(hitOrCell, rule).values;
  }

  /* ---------------- 【2.0.2.19 需求②⑤】按列带排版（纯函数：吃 `linesOf`，不吃 DOM） ---------------- */

  /* 列间空白 ≥ 图宽 4% 才算"分列"（再窄就是同一列里的字距）；单格 ≥ 图宽 55% 算通栏（标题/正文段），
   * 不参与分列判断 —— 否则一条居中标题就能把两栏桥接成一栏。 */
  const COL_GAP_RATIO = 0.04;
  const COL_WIDE_RATIO = 0.55;
  const COL_MAX = 4;

  /**
   * `lineList` → 列带模型（需求②「图里是表格就排成表格」与需求⑤「横排两张图 ⇒ 左右两格」共用）。
   *
   * 判据只有一条：**行的单元格坐标**。同一物理行里若有多个框（`cells` 多于一格）⇒ 那就是表格的一行；
   * 全图被一条宽空白带分成 N 段 ⇒ 就是 N 列。两者都靠坐标，不靠猜文字内容。
   * @param {Array} lines `linesOf()` 的形状（`[{cells:[{t,x,x2}], t}]`）
   * @returns {{width:number, cols:number, bands:Array<{x:number,x2:number}>,
   *            rows:Array<{cols:string[], wide?:string}>}}
   *   `cols < 2` ⇒ 调用方按纯文本渲染（旧行为，零风险）。
   */
  /* 【2.0.6 需求③】同一格里两段文字要不要空格，看框与框之间的**实际间距**：
   * 词被检测框切成两段时间隙只有几个像素，硬加空格就会写出「华为技术有限 公司」「供应商： 华为」；
   * 真正的两列之间总有大段空白。与 `offscreen/ocr.js` 的 `joinParts` 同一条口径（隔着一道 offscreen
   * 边界拿不到那支函数，所以这里是同一规则的第二个落点，改一处必须同改两处）。 */
  const TIGHT_GAP_RATIO = 0.6;

  /**
   * 把识别结果的行 → 列带模型（表格）。
   * @param {Array} lines `[{t,cells:[{t,x,x2}],y,y2}]`（引擎回执里的 `lineList`）
   * @returns {{width:number,cols:number,bands:Array,rows:Array}}
   */
  function layout(lines) {
    const list = lines || [];
    const cells = [];
    let width = 0;
    for (let i = 0; i < list.length; i++) {
      const cs = (list[i] && list[i].cells) || [];
      for (const c of cs) {
        const t = String((c && c.t) || '').replace(WHITE_ALL, ' ').trim();
        const x = Number(c && c.x);
        const x2 = Number(c && c.x2);
        if (!t || !isFinite(x) || !isFinite(x2) || x2 <= x) continue;
        cells.push({ t: t, x: x, x2: x2, line: i, w: x2 - x });
        if (x2 > width) width = x2;
      }
    }
    if (!width || cells.length < 2) return { width: width, cols: 1, bands: [], rows: [] };
    const gap = width * COL_GAP_RATIO;
    const wideW = width * COL_WIDE_RATIO;
    /* 只拿"非通栏"格定列带：通栏行（标题、条文正文）跨越多列是常态，让它参与就会被桥成 1 列 */
    const narrow = cells.filter((c) => c.w < wideW).sort((a, b) => (a.x - b.x) || (a.x2 - b.x2));
    if (!narrow.length) return { width: width, cols: 1, bands: [], rows: [] };
    const bands = [];
    for (const c of narrow) {
      const cur = bands[bands.length - 1];
      if (!cur || c.x - cur.x2 >= gap) bands.push({ x: c.x, x2: c.x2 });
      else if (c.x2 > cur.x2) cur.x2 = c.x2;
    }
    /* 列太多 ⇒ 不是"表格/分栏"，是被切碎的文字：退回纯文本（宁可不好看，不可看不出话） */
    if (bands.length < 2 || bands.length > COL_MAX) return { width: width, cols: 1, bands: [], rows: [] };
    const bandOf = (c) => {
      const cx = (c.x + c.x2) / 2;
      for (let j = 0; j < bands.length; j++) if (cx >= bands[j].x && cx <= bands[j].x2) return j;
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < bands.length; j++) {
        const d = cx < bands[j].x ? bands[j].x - cx : cx - bands[j].x2;
        if (d < bestD) { bestD = d; best = j; }
      }
      return best;
    };
    const byLine = [];
    for (let i = 0; i < list.length; i++) byLine.push([]);
    for (const c of cells) byLine[c.line].push(c);
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const row = byLine[i];
      row.sort((a, b) => a.x - b.x);
      if (!row.length) continue;
      /* 整行只有一个通栏格 ⇒ 通栏行（标题/正文段），铺满整张表 */
      if (row.length === 1 && row[0].w >= wideW) {
        rows.push({ wide: row[0].t, cols: [] });
        continue;
      }
      const slots = new Array(bands.length).fill('');
      const prevIn = new Array(bands.length).fill(null);
      const lineH = Math.max(1, (Number(list[i] && list[i].y2) - Number(list[i] && list[i].y)) || 0);
      const limit = Math.max(2, lineH * TIGHT_GAP_RATIO);
      for (const c of row) {
        const j = bandOf(c);
        const prev = prevIn[j];
        /* 同一格里前一段以分隔符收尾、或两段之间只有几个像素 ⇒ 直接贴；真有列间距才留空格 */
        const glue = !prev || (c.x - prev.x2) <= limit || /[：:｜|＝=]\s*$/.test(slots[j]);
        slots[j] = prev ? slots[j] + (glue ? '' : ' ') + c.t : c.t;
        prevIn[j] = c;
      }
      rows.push({ cols: slots });
    }
    return { width: width, cols: bands.length, bands: bands, rows: rows };
  }

  const XLAT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const xesc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => XLAT[ch]);

  /**
   * 列带模型 → 表格 HTML（`cols < 2` 或没有任何一行时返回 ''，调用方走纯文本）。
   * 空槽输出空 `<td>`：横向两栏要靠它保持列对齐（左右两格各自成列）。
   */
  function layoutHtml(lay) {
    const l = lay || {};
    if (!l.cols || l.cols < 2 || !l.rows || !l.rows.length) return '';
    let body = '';
    for (const r of l.rows) {
      if (r.wide != null) {
        body += '<tr><td class="kh-ocr-wide" colspan="' + l.cols + '">' + xesc(r.wide) + '</td></tr>';
        continue;
      }
      let tds = '';
      for (let j = 0; j < l.cols; j++) tds += '<td>' + xesc((r.cols || [])[j] || '') + '</td>';
      body += '<tr>' + tds + '</tr>';
    }
    return '<table class="kh-ocr-table">' + body + '</table>';
  }

  /* ---------------- 提交与回收 ---------------- */

  /**
   * 自己收口：`background` 被 MV3 杀掉、或消息彻底丢了时，内容脚本不能永远等下去。
   * 归还额度 + 把条目落到终态（`errorCode='timeout'`，面板据此说人话）。
   * @param {number} [now] 判决时刻（缺省＝现在；测试喂时刻用）
   * @returns {number} 本次收口的条数
   */
  function sweepStale(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let n = 0;
    for (const [token, rec] of Array.from(held.entries())) {
      if (t - rec.at < JOB_STALE_MS) continue;
      if (rec.reqId) pending.delete(rec.reqId);
      if (rec.src) inflight.delete(rec.src);
      held.delete(token);
      n += 1;
      const it = items.get(rec.key);
      if (it && it.state === 'pending') {
        it.state = 'fail';
        it.error = '识别引擎长时间没有回应（已超时）';
        it.errorCode = 'timeout';
      }
      failTwin(rec.src, rec.key, '识别引擎长时间没有回应（已超时）', 'timeout');   // T55
      if (rec.src) failSrc.set(rec.src, t);            // 需求⑨：超时也别下一轮又排一遍
    }
    if (n) notify();
    if (n) pump();                                   // 超时收口也归还了额度 ⇒ 补发队里的图
    if (!held.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    return n;
  }

  /** 有在途请求时才武装收口定时器（自终止：`sweepStale` 里空了就关） */
  function armSweep() {
    if (sweepTimer || !held.size) return;
    sweepTimer = setInterval(() => { sweepStale(); }, 5000);
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  /**
   * 【T55】**同一张图的条目要整组走**：两条规则抓同一字段时，同一个 `src` 会各建一条条目
   * （键 = `ruleId|src`）。识别是按**图片**算的 —— 提交按 `src` 去重，结果 / 超时 / 同步失败
   * 也都必须扇给同 `src` 的另一条，否则孪生条目会永远停在「识别中」。
   * @param {string} src 图片地址（空串＝没地址、按序号建的条目，不参与分组）
   * @param {string} [exceptKey] 已经单独处理过的那条，避免重复写
   */
  function sameSrcItems(src, exceptKey) {
    const out = [];
    if (!src) return out;
    for (const it of items.values()) if (it.src === src && it.key !== exceptKey) out.push(it);
    return out;
  }

  /** 同 `src` 的孪生条目一起落失败态（只动还在等结果的那条） */
  function failTwin(src, exceptKey, error, code) {
    for (const it of sameSrcItems(src, exceptKey)) {
      if (it.state !== 'pending') continue;
      it.state = 'fail';
      it.error = error;
      if (code) it.errorCode = code;
    }
  }

  function submit(entry, cfg) {
    if (quotaUsed() >= MAX_INFLIGHT) return false;
    const cls = entry.cls;
    /* 【T55】这张图**已经在飞**就不重复发：旧实现顶部只看额度，排队循环按条目逐条提交
     * ⇒ 两条规则抓同一张图时各发一次（4 张图 = 8 次识别）。这里只把它置「识别中」，
     * 结果回来由 `onResult` 扇给同 `src` 的每条（缓存与额度都只按图片算一次）。 */
    if (cls.src && inflight.has(cls.src)) { entry.state = 'pending'; return false; }
    let payload = null;
    if (cls.viaCanvas) {
      let dataUrl = null;
      try { dataUrl = canvasDataUrl(entry.img); } catch (e) { dataUrl = null; }
      if (!dataUrl) { entry.state = 'blocked'; entry.why = 'tainted'; return false; }
      /* 【必须同时带 src】回执里的 src 是"这笔结果属于哪张图"的唯一线索（写缓存与兜底认领都要它）。
       * 旧实现只发 dataUrl ⇒ 回执没 src ⇒ 按 src 归还额度的老逻辑永远还不掉（#16 ③）。 */
      payload = { dataUrl: dataUrl, src: cls.src };
    } else {
      payload = { src: cls.src };
    }
    tokenSeq += 1;
    const token = 't' + tokenSeq;
    held.set(token, { key: entry.key, src: cls.src, reqId: null, at: Date.now() });
    awaitingId += 1;
    if (cls.src) inflight.add(cls.src);
    entry.state = 'pending';
    try {
      chrome.runtime.sendMessage(Object.assign({
        type: MSG.OCR_IMAGE,
        keyword: (entry.rule && entry.rule.meta && entry.rule.meta.display) || entry.keyword || ''
        /* 【S2 引擎选择不从这里发】`imgOcr.engine` 由 **background 单点读取并注入**（#16 D-16.1）：
         * offscreen 读不到 `chrome.storage`，而内容脚本读又会让"用户改了设置"与"这条 job 排队"
         * 两个时刻打架。所以发起方只管发图与关键词，回执里带**实际**用了哪个引擎。 */
      }, payload), (res) => {
        void chrome.runtime.lastError;
        awaitingId = Math.max(0, awaitingId - 1);
        if (res && res.requestId) {
          const rec = held.get(token);
          if (rec) rec.reqId = res.requestId;
          pending.set(res.requestId, token);
        } else {
          releaseHold(token);
          entry.state = 'fail';
          entry.error = (res && res.error) || 'OCR 引擎未响应';
          failTwin(cls.src, entry.key, entry.error, '');   // T55：这张图的孪生条目一起落失败
          notify();
          pump();                                    // 额度已归还 ⇒ 把队里的接着发
        }
      });
    } catch (e) {
      awaitingId = Math.max(0, awaitingId - 1);
      releaseHold(token);
      entry.state = 'fail';
      entry.error = String((e && e.message) || e);
      failTwin(cls.src, entry.key, entry.error, '');     // T55：同上
      notify();
      pump();                                        // 同上：同步失败也占过一次额度
    }
    armSweep();
    return true;
  }

  /**
   * 【补发：额度一归还就把队里的接着发】（用户报「一页多图卡在排队中」）
   *
   * 没有它的话：`submit()` 满额时**直接返回 false**（见上），而所有"归还额度"的出口
   * （同步失败 / 回执没带 requestId / 结果回来 / 超时收口）以前都只管归还、**不再看队列**
   * ⇒ 一页里超过 `MAX_INFLIGHT`（4）的图在**静态页面**上会一直停在「排队中…」，
   * 要等下一次重建/扫描才可能被顺带提交。
   * 实测（9 张图一页）：3 张完成后，其余 6 张在 +30s 与 +90s 两次取样都还没被提交。
   *
   * 重入用 `pumping` 挡住：`submit()` 里同步失败会立刻走到归还路径、再回调 `pump()`，
   * 不挡的话递归深度＝剩余图片数（长页面会爆栈）。挡住之后由**最外层那一趟**继续往下发。
   */
  let pumping = false;
  function pump() {
    if (pumping) return 0;
    pumping = true;
    let n = 0;
    try {
      for (const it of items.values()) {
        if (quotaUsed() >= MAX_INFLIGHT) break;
        if (it.state !== 'idle') continue;
        if (submit(it)) n += 1;             // 失败的会在 submit 内部落到 fail/blocked，不会在这里打转
      }
    } finally { pumping = false; }
    if (n) notify();
    return n;
  }

  /**
   * 采纳一条「右键识别」的回执（2.0.1.17 · SPEC 需求 6）。
   * 为什么单开一条路：这条结果**不是扫描链发起的** —— 没有规则、没有命中、`held`/`pending`
   * 里也没有它的账（`via` 只在 `background` 的回执上加，见 `background/ocr.js` 的 `deliver`），
   * 所以不能走 token 认领。键按 `src` 去重：同一张图重复右键只留一行，且**取最新一次**
   * （用户刚点的就是它）。失败也要建行 —— SPEC `L274`：识别服务不可用时必须如实告知，不得静默。
   */
  function adoptContextMenu(msg) {
    const src = String(msg.src || '');
    const key = 'ctxmenu|' + (src || ('#' + String(msg.requestId || '')));
    let it = manual.get(key);
    if (!it) {
      it = {
        key: key, ruleId: '@ctxmenu', rule: null,
        keyword: '', label: '',
        src: src, cls: { ok: true, src: src, host: hostOfSrc(src) }, host: hostOfSrc(src),
        state: 'pending', matched: [], text: '', conf: 0, via: 'contextMenu'
      };
      manual.set(key, it);
    }
    /* 【2.0.2.15 需求②】**受理即回执**（background 的 OCR_QUEUED）：用户点完右键那一刻就把行建出来，
     * 面板因此立刻画出「截图」卡（带"识别中…"）。旧行为只在结果/失败回来时才建行 ——
     * 用户点完右键，屏幕上什么都不会发生，像功能坏了。这里不改状态（仍是 pending），
     * 结果/失败交给下面的分支在原地改。 */
    if (msg.accepted) { notify(); return; }
    it.engine = msg.engine || '';
    it.engineReason = msg.engineReason || '';
    if (msg.ok) {
      it.state = 'done';
      it.text = String(msg.text || '');
      it.conf = msg.confidence || 0;
      it.ocrMs = msg.ocrMs;
      it.why = msg.notice || '';
      it.coverPx = (msg.coverage && msg.coverage.coveredTo) || 0;
      it.coverage = msg.coverage || null;
      /* 顺手进缓存（2.0.2.15）：大图里点「OCR 识别」、以及灯箱拿全文都走 `textOf(src)`，
       * 右键识别的那张图必须和扫描链一样能被 `textOf` 读到 —— 否则同一张图会再识别一次，
       * 且灯箱开着时结果回来也刷不出全文。 */
      const ck = absOf(it.src);
      if (ck) cachePut(ck, { text: it.text, conf: it.conf, at: Date.now(), ocrMs: it.ocrMs });
    } else {
      it.state = 'fail';
      it.error = msg.error || '识别失败';
      it.errorCode = msg.code || '';
      /* 失败时**不许**留着成功态的 why：`ocr-copy.js` 的 `keyOf()` 会先认表内 why，
       * 留着就会把一次失败说成「已识别」。只有引擎明确的 lang-missing 才写进 why。 */
      it.why = (msg.code === 'lang-missing') ? 'lang-missing' : '';
    }
    notify();
  }

  /* ---------------- 大图里点「OCR 识别」（2.0.2.15 需求①） ---------------- */

  /** 灯箱那边等着的识别：requestId → 结算器 */
  const oneWaits = new Map();

  /** 灯箱文案（真源 `KH.OcrCopy.VIEW`；这里只在没加载到真源时给 ASCII 兜底） */
  function lightboxText(key, fallback) {
    const V = (KH.OcrCopy && KH.OcrCopy.VIEW) || {};
    return V[key] || fallback;
  }

  /** 这张图已经认出来的文字（空串 = 还没有）。缓存优先，其次看现有条目（扫描链/右键都可能已经认过）。 */
  function textOf(raw) {
    const s = absOf(raw);
    if (!s) return '';
    const c = textCache.get(s) || textCache.get(String(raw || ''));
    if (c && c.text) return String(c.text);
    for (const it of allItems()) {
      if (it && it.text && it.src && absOf(it.src) === s) return String(it.text);
    }
    return '';
  }

  /**
   * 这张图的**结构化行**（`{t,y,x,cells:[{t,x,x2}]}`，2.0.2.19 需求②⑤）。
   * 面板排版表格/左右双栏要用单元格坐标；缓存优先，条目兜底（与 `textOf` 同一条取数路）。
   * @returns {object[]} 空数组 = 不知道版式（照旧按纯文本展示）
   */
  function linesOf(raw) {
    const s = absOf(raw);
    if (!s) return [];
    const c = textCache.get(s) || textCache.get(String(raw || ''));
    if (c && c.lineList && c.lineList.length) return c.lineList;
    for (const it of allItems()) {
      if (it && it.lineList && it.lineList.length && it.src && absOf(it.src) === s) return it.lineList;
    }
    return [];
  }

  /** 大图 OCR 的回执：回填缓存 + 叫醒等它的那一个（不进 items/manual —— 它不挂在任何规则上） */
  function adoptLightbox(msg) {
    const text = String(msg.text || '');
    if (msg.ok && msg.src) {
      cachePut(absOf(msg.src), {
        text: text, conf: msg.confidence || 0, at: Date.now(), ocrMs: msg.ocrMs,
        lineList: msg.lineList || []
      });
    }
    const w = oneWaits.get(msg.requestId);
    if (w) {
      oneWaits.delete(msg.requestId);
      if (w.timer) clearTimeout(w.timer);
      if (msg.ok) w.resolve(text);
      else w.reject(Object.assign(new Error(msg.error || lightboxText('paneOcrFail', 'OCR failed')), { code: msg.code || '' }));
    }
    notify();
  }

  /**
   * 认一张图，返回识别文本（大图灯箱那枚「OCR 识别」按钮就等这个）。
   * 已有文本直接回（不重复跑引擎）；结果只进缓存、不进面板 —— 灯箱是临时视图，
   * 在「重要笔记」里多出一行反而是噪声。
   */
  function ocrOne(raw) {
    const src = absOf(raw) || String(raw || '');
    if (!src) return Promise.reject(new Error(lightboxText('paneOcrFail', 'OCR failed')));
    const hit = textOf(src);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, text) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(text);
      };
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        done(new Error(lightboxText('paneOcrFail', 'OCR failed')));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: MSG.OCR_IMAGE, src: src, via: 'lightbox' }, (res) => {
          if (settled) return;
          if (!res || !res.ok) {
            const code = String((res && res.code) || '');
            done(Object.assign(new Error(code === 'src-rejected'
              ? lightboxText('paneOcrDenied', 'This image address is not allowed')
              : lightboxText('paneOcrFail', 'OCR failed')), { code: code }));
            return;
          }
          /* 兜底超时：background 的看门狗会先到；这一层只防"回执永远不来"（SW 被杀） */
          const timer = setTimeout(() => {
            oneWaits.delete(res.requestId);
            done(Object.assign(new Error(lightboxText('paneOcrFail', 'OCR failed')), { code: 'timeout' }));
          }, JOB_STALE_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
          oneWaits.set(res.requestId, {
            src: src, timer: timer,
            resolve: (t) => done(null, t), reject: (e) => done(e)
          });
        });
      } catch (e) { done(e); }
    });
  }

  /** 结果回来（background 中转） */
  function onResult(msg) {
    /* 【右键任意图 OCR】先认领这一类：它没有 token 账可对，硬走下面的额度逻辑只会空转 */
    if (msg.via === 'contextMenu') { adoptContextMenu(msg); return; }
    /* 大图里点的「OCR 识别」：不属扫描链、也不进面板，只回填缓存 + 叫醒灯箱那一边 */
    if (msg.via === 'lightbox') { adoptLightbox(msg); return; }
    /* ① 先把这笔账认出来**按 token** 归还 —— 与 src 无关，这是 #16 ③ 的根治点 */
    let token = pending.get(msg.requestId) || null;
    const src = msg.src || '';
    if (!token && src) {
      /* 兜底：结果带 src 但 requestId 对不上（页面重建 / 消息重投）→ 按 src 找回那一笔 */
      for (const [t, rec] of held) { if (rec.src && rec.src === src) { token = t; break; } }
    }
    const rec = token ? held.get(token) : null;
    const key = rec ? rec.key : null;
    if (token) releaseHold(token);      /* 幂等：认领不到就没有副作用 */

    const text = String(msg.text || '');
    if (msg.ok && src) {
      cachePut(src, {
        text: text, conf: msg.confidence || 0, at: Date.now(), ocrMs: msg.ocrMs,
        lineList: msg.lineList || []
      });
    }

    /* 结果对应的那条（可能因为页面重建而不在了：那就只更新缓存，不动 UI） */
    const entry = key ? items.get(key) : null;
    /* 【T55】结果属于**一张图**：同 `src` 的条目要一起更新（两条规则各一条）。
     * 旧实现写成 `entry ? [entry] : 同 src 全部` ⇒ 命中 token 那张时孪生条目拿不到结果。 */
    const targets = [];
    if (entry) targets.push(entry);
    for (const it of sameSrcItems(src, entry ? entry.key : null)) targets.push(it);
    for (const it of targets) {
      if (msg.ok) {
        it.state = 'done';
        it.text = text;
        it.conf = msg.confidence || 0;
        /* 【2.0.6.1 需求①③⑦】命中判定与"差在哪"一次算完：`missingValues` = 点名的动态值里
         * 图上没找到的那几个 —— 面板照实说出来，不再只给一个"没命中"。 */
        const ji = judgeInfo(it.rule, text, it.need);
        it.matched = ji.hits;
        it.needMissingValues = ji.missingValues;
        it.lineList = msg.lineList || [];
        it.ocrMs = msg.ocrMs;
        /* 引擎**如实告知**的"结果不完整/不可靠"（不变量 1/2，D-14.5）：
         * `no-text`（一个字没认出）/`tilted`（方向可疑）/`truncated`（只读了前 8 块）。
         * `why` 直接沿用引擎给的 notice 键 —— `ocr-copy.js` 认得这几个键，
         * 且 `keyOf` 里 hit 优先：真命中就照常说命中，不拿"截断"掩盖已找到的词。 */
        it.why = msg.notice || '';
        it.coverPx = (msg.coverage && msg.coverage.coveredTo) || 0;
        it.coverage = msg.coverage || null;
        /* 实际用了哪个引擎（#12/#16）：`engineReason` 非空 = 这次是**回落**跑的。
         * 面板据此在展开说明里写清"已从 PP-OCR 回落到兼容引擎：<原因>" —— 宁可让用户知道慢，
         * 也不许让他以为"主引擎一直在正常工作"。 */
        it.engine = msg.engine || '';
        it.engineReason = msg.engineReason || '';
      } else {
        it.state = 'fail';
        it.error = msg.error || '识别失败';
        it.errorCode = msg.code || '';
        it.engine = msg.engine || '';
        it.engineReason = msg.engineReason || '';
        if (msg.code === 'lang-missing') it.why = 'lang-missing';
        /* 需求⑨：失败的图记一笔，别让下一轮扫描再排一次（右键手动那种条目不记） */
        if (it.src && !/^ctxmenu\|/.test(it.key)) failSrc.set(it.src, Date.now());
      }
    }
    if (targets.length) notify();
    pump();                                          // 结果回来＝额度归还 ⇒ 补发队里的图
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
      if (!String(rule.meta.imgOcrKeyword || '').trim()
        && !String(rule.meta.imgOcrNeed || '').trim()) return;
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
      /* 【2.0.2.19 需求③】这些抓取字段的值同时是**动态关键词**（见 `judge`）。
       * 【2.0.4 需求②】取值改走 `Fetch.extractFor`（与重要笔记表格同一份实现），
       * 所以锚点/字段名都从 `anchor.cell` 重算 —— 不再复用 `cellsForHit` 的裸名字典。
       * 【2.0.6.1 需求①③】改用 `needInfo`：`needMissing` 是「点名了却没取到值」的字段名，
       * 面板据此把「为什么不命中」说出来（旧实现这条路全是静默 `[]`）。 */
      const ni = needInfo(anchor.cell, rule);
      const need = ni.values;
      const needWant = ni.want;
      const needMissing = ni.missing;
      const valueCells = [];
      const labelOfImg = new Map();
      for (const f of fields) {
        /* 【字段级抠图开关 `#0`（2.0.2.5 需求①后段）】多个抓取字段里不止一个带图时（截图 + icon + logo），
         * 用 `icon#0` 点名"这个字段的图不参与图片识别"；它的图同时也被 applyImgPolicy 从抓取内容里剔掉。
         * 判定在 Fetch 侧（`cellsForHit` 返回的 `noImg`），这里只照办 —— 不在本模块养第二套后缀语法。 */
        if (f.noImg) continue;
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
        /* 【2.0.6.2 需求①】缓存读和写要同键：右键/灯箱写的是 `absOf(src)`，扫描链写的是原始
         * `src`，这里只按原始 src 查 ⇒ 经过绝对化的同一张图会被当成没识别过、掉回 idle 重排队
         * （失败一次还会落进 `failSrc` 冻 10 分钟）。两边都试一遍，顺序与 `textOf` 一致。 */
        const cached = src ? (textCache.get(src) || textCache.get(absOf(src))) : null;
        const item = {
          key: key, ruleId: rule.ruleId, rule: rule,
          /* 面板行的关键词标签显示**图片命中关键词**（用户确认第 6 条）——它才是"在图里找什么" */
          keyword: String((rule.meta && rule.meta.imgOcrKeyword) || ''),
          label: String(labelOfImg.get(got.img) || ''),
          src: src, cls: cls, host: cls.host || '',
          state: 'idle', matched: [], text: '', conf: 0,
          need: need, needWant: needWant, needMissing: needMissing,
          needMissingValues: [], lineList: [],
          cellText: String((anchor.cell && anchor.cell.textContent) || '').trim().slice(0, 120)
        };
        if (cached) {
          item.state = 'done';
          item.text = cached.text;
          item.conf = cached.conf;
          const ji = judgeInfo(rule, cached.text, need);
          item.matched = ji.hits;
          item.needMissingValues = ji.missingValues;
          item.lineList = cached.lineList || [];
          /* 【耗时徽标必须跟着缓存走】(K80 · 真机踩到) 条目表每次重建都从缓存重建，
           * 而 `ocrMs` 此前只活在**当时那个条目对象**上 ⇒ 页面一有变动（重建）耗时徽标就空了。
           * 真机表现：E2E「每个图片条目都该显示本次识别耗时」变红（`cost:""`）。
           * 缓存里带上它之后，重建出来的条目照旧显示**这张图那次识别**的耗时。 */
          item.ocrMs = cached.ocrMs;
        } else if (!cls.ok) {
          item.state = 'blocked';
          item.why = cls.why;
        } else if (failSrc.has(src) && Date.now() - failSrc.get(src) < FAIL_MEMO_MS) {
          /* 【2.0.6.1 需求⑨】这张图刚识别失败过（引擎报错 / 超时 / 无文字且 rescue 全跑空），
           * 同一次会话里**不再重新排队**。旧行为：页面每一次重扫都把它当新条目、再提交一遍，
           * 于是"没文字的图也要跑好几秒"在面板反复重建时成倍放大（用户说的"没文字也耗时很长、
           * 页面卡顿"多半就是这条）。失败信息仍照实显示，10 分钟后自动允许重试一次。 */
          item.state = 'fail';
          item.why = 'retry-later';
        } else if (inflight.has(src)) {
          item.state = 'pending';
        }
        next.set(key, item);
      }
    }
    /* 右键识别的条目不属于任何规则：扫描链重建时**并回去**，别把它冲掉（用户手动要的那一行
     * 不该因为页面变动就消失；它自己有过结果、也留在 `manual` 里）。
     * 【2.0.6.2 需求①】并回去时补一次判决：这类条目 `rule` 是 null、`matched` 是空，于是
     * "事后给它加图片命中关键词"永远算不出命中（不是没重算，是根本没有算的地方）。用**当前配置**
     * 的规则补判，命中就挂上那条规则 —— 之后面板能解释、KV 行也能出。 */
    let manualRules = null;
    for (const pair of manual) {
      if (next.has(pair[0])) continue;
      const it = pair[1];
      if (it && it.text && (!it.matched || !it.matched.length)) {
        if (!manualRules) manualRules = KH.Compiler.compileAll(cfg) || [];
        for (const r of manualRules) {
          const meta2 = r.meta || {};
          if (!meta2.imgOcr) continue;
          const ji = judgeInfo(r, it.text, []);
          if (!ji.hits.length) continue;
          it.matched = ji.hits;
          it.rule = r;
          it.ruleId = r.ruleId;
          it.keyword = String(meta2.imgOcrKeyword || '');
          break;
        }
      }
      next.set(pair[0], it);
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
         * 图片相关的变更本来就会判成 'full'（见 relevance.js ④），所以这里直接不动是最安全的。
         *
         * 【本早退的**前提**，T52 写显】上面那句"图片相关的变更必然判 'full'"不是自动成立的，
         * 它靠的是「`imgOcr` 在核心签名里」这一件事：改它 ⇒ 核心签名变 ⇒ 整页重建 ⇒ 走的是
         * 非 consumeOnly 路径 ⇒ `classify()` 用新配置重算。**别把 `imgOcr` 移进 `index.js` 的
         * `UI_ONLY_KEYS`**（T36b 正是这么干的，结果跨域白名单 `crossOriginSites` 的页面侧唯一读点
         * —— 本文件 `:190` 的 `crossOriginAllowed`，只在 `build()` 里跑 —— 在已打开的页面上不生效，
         * 要等一次真正的整页重建；回归编号 F1）。除非哪天把 `build()` 改成能安全合并"部分命中"，
         * 否则这个早退与那条分类是绑在一起的。 */
        if (ctx && ctx.consumeOnly) return;
        build(cfg, ctx, hits);
        notify();
      },
      /**
       * 重建清底：条目清掉但**缓存留着**（同一张图不必反复识别）。
       * 【签名必须与调用方一致】`src/core/rebuilder.js:111` 调的是 `feat.clear(root, o)`，
       * 旧实现写成 `clear(reason)` ⇒ 形参收到的是 `root`（恒为 null/元素），
       * `reason === 'destroy'` **永远不成立** —— 销毁时在途额度与去重集根本不清，
       * 下一次挂载就白少 4 个可用额度（S1-b 顺手修掉的附带缺陷）。
       * 【`pending` 不再在重建时清】它记的是"在途请求该还哪一笔账"，不是本轮扫描状态：
       * 清了会让晚到的结果认领不到（额度要等 150s 收口才回）。
       */
      clear(root, opts) {
        const destroy = !!(opts && opts.reason === 'destroy');
        /* 销毁（换页/停用）连 `manual` 一起清；普通重建只把扫描链条目清底，
         * 右键识别的行**留着**（它不属于本轮命中，清掉就等于用户白右键一次） */
        if (destroy) manual.clear();
        /* 失败备忘跟着会话走：换页/停用才清（普通重扫保留，否则页面一动就又开始重排） */
        if (destroy) failSrc.clear();
        items = new Map(Array.from(manual));
        if (destroy) {
          held.clear();
          pending.clear();
          awaitingId = 0;
          inflight.clear();
          if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
        }
        notify();
      }
    });
  }

  /* 结果经 background 回到内容脚本（`to:'content'` 才是给我们的，别的上下文的消息不认） */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return false;
      if (msg.to && msg.to !== 'content') return false;
      /* 受理即回执（右键那一刻）：先把行建出来，面板立刻有东西可画 */
      if (msg.type === MSG.OCR_QUEUED) {
        adoptContextMenu({ src: msg.src, requestId: msg.requestId, accepted: true });
        return false;
      }
      if (msg.type !== MSG.OCR_RESULT) return false;
      onResult(msg);
      return false;
    });
  }

  /**
   * 面板读的就是这个：扫描链条目 + 右键识别的条目（**并集**，键不重复）。
   * 两张表分开存是因为生命周期不同（见 `manual` 的注释：一条随扫描重建生灭、一条由用户手动产生），
   * 但对读者必须是一个列表 —— 否则右键识别的结果在面板上根本不存在。
   */
  function allItems() {
    const out = Array.from(items.values());
    for (const pair of manual) if (!items.has(pair[0])) out.push(pair[1]);
    return out;
  }

  KH.ImgOcr = {
    items: allItems,
    /**
     * 关掉右键那张「截图」卡（2.0.2.16 需求⑦）：把这些手动条目整批丢掉。
     * 只清 `manual`，**不动 `textCache`** —— 用户说的是"这张卡不再显示"，不是"忘掉识别结果"；
     * 同一张图之后再右键仍然命中缓存，不必重跑引擎。`notify()` 会让面板重画那张卡（没有条目就不画）。
     */
    clearManual() {
      if (!manual.size) return;
      manual.clear();
      notify();
    },
    /** 当前在途额度（≥1 = 有识别在飞）。调度侧用它给重建让路（见 `scheduler.js:_deferToOcr`）
     *  —— 重建是同步全页扫描，一跑起来就把识别结果挤在门外。 */
    inflightCount: () => quotaUsed(),
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
        items: items.size, cache: textCache.size, pending: pending.size,
        /* `popup/popup.js:197` 读的就是这个键 ⇒ 键名不许改，含义＝当前占用的额度 */
        inflight: quotaUsed(),
        blocked: blocked,
        states: Array.from(items.values()).map((i) => i.key + ':' + i.state)
      };
    },
    classify: classify,
    /** 大图灯箱用：认一张图 / 取这张图已认出的文字（2.0.2.15 需求①）
     *  `linesOf` = 同一份结果的**结构化行**（含单元格坐标，2.0.2.19 需求②⑤ 排版用） */
    ocrOne: ocrOne,
    textOf: textOf,
    linesOf: linesOf,
    matchedInText: matchedInText,
    /** 动态命中判决 + 抓取值表（2.0.2.19 需求③；单测用）
     *  【2.0.4 需求②】`needOf(hitOrCell, rule)` 改成吃锚点格 + 规则（值走 `Fetch.extractFor`）。 */
    judge: judge, needOf: needOf, needNames: needNames,
    /** 【2.0.6.1 需求①③】带诊断的两个入口：
     *  `judgeInfo(rule,text,need)` → `{hits, missingValues}`（图上找不到的那些动态值）
     *  `needInfo(hitOrCell,rule)`  → `{values,want,missing}`（点名了却没取到值的字段名） */
    judgeInfo: judgeInfo, needInfo: needInfo,
    /** 【2.0.4 需求①】「键值行进表」标记：`kvWords(raw)` = 带 `#表`/`#kv` 标记的词（已剥标记）；
     *  `stripKvMarks(raw)` = 去掉标记的关键词原文（喂匹配用）。重要笔记那边读同一份实现。 */
    kvWords: kvWords, stripKvMarks: stripKvMarks,
    /** 列带排版（2.0.2.19 需求②⑤）：`layout(lineList)` → 模型；`layoutHtml(模型)` → 表格 HTML */
    layout: layout, layoutHtml: layoutHtml,
    /** 匹配口径的唯一编译点（诊断/单测用；见 `ocrPatternOf`） */
    ocrPatternOf: ocrPatternOf,
    build: build,
    /** 结果/收口的手动驱动（诊断与单测用：不依赖真实消息往返） */
    _onResult: onResult,
    _sweep: sweepStale
  };
})();
