/* ============================================================================
 * background/ocr.js · 图片文字识别的**中转站**（background 侧）
 * ----------------------------------------------------------------------------
 * 为什么不把 OCR 直接放内容脚本：内容脚本受**页面 CSP** 约束，`new Worker(blob:)` 被 MV3
 * 扩展页 CSP 禁掉、wasm 也可能被页面策略拦；而 service worker 又不能建 worker（且 30s 空闲
 * 就被杀，长任务必挂）。真浏览器实测结论：只有 **offscreen 文档**这条路稳
 * （证据：_e2e/probe-ocr1~6.js）。
 *
 * 于是职责切成两半：
 *   · offscreen/ocr.js —— 引擎与语言包（重活）
 *   · 本文件 —— 只做三件事：按需创建 offscreen 文档、把请求转过去、把结果送回发起方
 *
 * 【防回环】所有经此中转的消息都带 `to` 标记（'offscreen' / 'background' / 'ui'），
 * 三个上下文各自只处理自己的标记，否则 sendMessage 会在扩展内自己绕圈。
 *
 * 【S1-b · 不变量 5：每条请求**必定**有终态，且终态**只投一次**】
 * 用户现场「识别中…」永久不动的根因：结果这条消息**没有第二个人负责**。
 * offscreen 若被 MV3 杀掉 / 引擎抛错 / 回执丢了，`imageJobs` 里那条 job 就永远躺着，
 * 发起方永远等不到终态（内容脚本的额度也只减不增 ⇒ 累积 4 次整页 OCR 静默全废）。
 * 现在由**本文件**兜到底（它是唯一知道"谁在等"的地方）：
 *   · job 登记时武装看门狗（`armWatchdog`）；
 *   · 判决是**纯函数** `deadlineOf(job)`：没收到过进度 → 起始 + 120s 硬顶；
 *     收到过进度 → 从**最后一次进度**起静默满 60s 才判死（长图/首次下语言包都能续命）；
 *     再与"绝对上限 10 分钟"取 min（防进度刷不完的僵尸 job）；
 *   · `_sweep(now)` 把判决推进到给定时刻（测试直接喂 now，不依赖假计时器）；
 *   · 判死 = 投 `{ok:false, code:'timeout'}` 终态 + 顺手让 offscreen 撤掉这条请求。
 * 【认领不到就**不投**】旧实现在认领不到 job 时改投 `to:'ui'` —— 内容脚本按 `to` 过滤丢掉它，
 * 结果就是"永久识别中"。宁可少投一条，也不许投一条**没人认领**的。
 * ========================================================================= */
'use strict';

(function () {
  const MSG = self.KH.MSG;
  const OFFSCREEN_PATH = 'offscreen/ocr.html';
  const RPC_TIMEOUT_MS = 180000;      // 语言包下载 + 建引擎，给足时间
  const NO_PROGRESS_MS = 60000;       // 收到过进度之后，静默多久算死
  const HARD_CAP_MS = 120000;         // 一次进度都没收到时，最多等多久
  const JOB_ABS_MAX_MS = 600000;      // 绝对上限：进度也救不回来的僵尸 job

  /* 识别引擎（S2 / #12）：`auto` 主引擎 + 会话内回落、`ppocr` 只用主引擎、`tesseract` 只用兼容引擎 */
  const ENGINE_MODES = ['auto', 'ppocr', 'tesseract'];
  const DEFAULT_ENGINE = 'auto';

  let seq = 0;
  const imageJobs = new Map();        // requestId -> { requestId, tabId, frameId, isExtPage, at, lastProgressAt, sawProgress, timer }
  const rpcPending = new Map();       // requestId -> { resolve, reject, timer }

  function nextId(prefix) { seq += 1; return prefix + seq + '-' + Date.now().toString(36); }

  /* ---------------- 识别引擎：全链路**唯一**读配置的地方（#16 D-16.1） ----------------
   * 为什么由 background 读、再显式注入 offscreen：
   *   · 真机实测 offscreen 文档只暴露 `csi/loadTimes/runtime` —— `chrome.storage` 在那里是 undefined
   *     （`typeof chrome.storage === "undefined"`，Chrome 154 + 本扩展亲测），它读不了配置；
   *   · 内容脚本读配置要多一次异步往返，而且"用户改了设置"的时刻与"这条 job 排队"的时刻会打架。
   * 于是契约是：**发起方（内容脚本）不传引擎**，background 转发时注入，回执带上**实际**用了哪个引擎。
   * 未知/缺失一律按 `auto`（最保守：主引擎不行还有兜底，且会如实告知）。 */
  function normalizeEngine(v) {
    const s = String(v == null ? '' : v);
    return ENGINE_MODES.indexOf(s) >= 0 ? s : DEFAULT_ENGINE;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { resolve({}); return; }
        chrome.storage.local.get(key, (r) => { void chrome.runtime.lastError; resolve(r || {}); });
      } catch (e) { resolve({}); }
    });
  }

  async function readEngine() {
    const r = await storageGet('imgOcr');
    return normalizeEngine(r && r.imgOcr && r.imgOcr.engine);
  }

  /* ---------------- offscreen 文档生命周期 ---------------- */

  let creating = null;

  /** 建文档的唯一入口（reasons 按浏览器能力选，见 `ensureOffscreen` 的注释） */
  function createOffscreen(reasons) {
    return chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: reasons,
      justification: '在扩展自己的页面里运行本地 OCR 引擎（识别图片中的关键词文字）'
    }).catch((err) => {
      /* 两个标签页同时触发时会撞车：已存在就当成功 */
      const m = String((err && err.message) || err);
      if (!/single offscreen|already/i.test(m)) throw err;
    });
  }

  async function ensureOffscreen() {
    /* 【不变量 8：不许调 `chrome.offscreen.hasDocument`】它是 Chrome 116+ 才有的，
     * 而 manifest 写着 `minimum_chrome_version: 109` —— 109–115 上直接 TypeError，
     * 整条 OCR 链路连门都进不去。109 能用的只有 createDocument：
     * 直接建，撞车（"single offscreen document"）当成功。 */
    const supported = !!(chrome.offscreen && typeof chrome.offscreen.createDocument === 'function');
    if (!supported) throw new Error('当前浏览器不支持 offscreen（需要 Chrome/Edge 109+）');
    if (creating) { await creating; return true; }
    creating = (async () => {
      /* 【S2-d 真机发现（2026-10-06）】`WORKERS` 语义最准（我们确实在扩展页里跑 Worker + wasm），
       * 但它是 **Chrome 124+** 才有的枚举值：109 上 `createDocument` 直接抛
       * `Error at property 'reasons': Error at index 0: Value must be one of AUDIO_PLAYBACK, BLOBS, …`
       * ⇒ 整条 OCR 链路在 109 上**一次都不成功**（失败发生在登记 job 之前，页面连错误回执都收不到，
       * 表现成"永久识别中"）。所以先试准的 `WORKERS`，被拒就退到 `BLOBS` ——
       * 我们本来就用 Blob 把图片字节喂给引擎，这个理由在 109 上同样成立。
       * 【为什么不按版本号判】枚举表没有可查询的 API，而用户可能跑 109–123 之间任何一版；
       * 唯一可靠的做法就是"先试准的、被拒再退"（失败信息里带 `reasons` / `Value must be one of`）。 */
      try {
        await createOffscreen(['WORKERS']);
      } catch (err) {
        const m = String((err && err.message) || err);
        if (!/reasons|Value must be one of/i.test(m)) throw err;
        await createOffscreen(['BLOBS']);
      }
    })();
    try { await creating; } finally { creating = null; }
    return true;
  }

  function toOffscreen(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, () => {
          /* 目标没监听时会有 lastError（例如 offscreen 还没起来），这里不吞不抛，
           * 交给上层超时/重试逻辑处理 —— 读一下 lastError 即可让控制台安静。 */
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  /** 请求-应答（设置页的语言包操作走这里） */
  async function ask(payload) {
    await ensureOffscreen();
    const requestId = nextId('rpc');
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rpcPending.delete(requestId);
        reject(new Error('OCR 引擎响应超时'));
      }, RPC_TIMEOUT_MS);
      rpcPending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
    });
    await toOffscreen(Object.assign({ to: 'offscreen', requestId: requestId }, payload));
    return p;
  }

  /* ---------------- 看门狗：终态的兜底责任人 ---------------- */

  /**
   * 这条 job 最晚活到什么时候（**纯函数**：只读 job 字段，不看时钟）。
   * · 没收到过进度 → `at + HARD_CAP_MS`（120s）：连引擎在不在都不知道，不能无限等；
   * · 收到过进度 → `最后一次进度 + NO_PROGRESS_MS`（60s）：下载/校验/长图都在发进度，
   *   于是"真的在干活"的 job 会一直续命；
   * · 两者都与绝对上限取 min。
   */
  function deadlineOf(job) {
    const basis = job.sawProgress ? (job.lastProgressAt || job.at) : job.at;
    const window = job.sawProgress ? NO_PROGRESS_MS : HARD_CAP_MS;
    return Math.min(basis + window, job.at + JOB_ABS_MAX_MS);
  }

  function armWatchdog(job) {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    const delay = Math.max(50, deadlineOf(job) - Date.now());
    job.timer = setTimeout(() => {
      job.timer = null;
      _sweep();
    }, delay);
    /* node 单测里不许把它变成"进程不退出的理由" */
    if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
  }

  function disarm(job) {
    if (job && job.timer) { clearTimeout(job.timer); job.timer = null; }
  }

  /**
   * 把看门狗推进到 `now`（缺省＝现在），返回本次判死的条数。
   * 抽成"喂时刻"的形式是为了单测能确定性地驱动它（不依赖真实等待）。
   */
  function _sweep(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let killed = 0;
    for (const job of Array.from(imageJobs.values())) {
      if (t < deadlineOf(job)) continue;
      killed += 1;
      /* 先注销再投递：万一投递过程中又有回执进来，`imageJobs` 里已经没有它了 ⇒ 天然幂等 */
      imageJobs.delete(job.requestId);
      disarm(job);
      deliver(job, {
        requestId: job.requestId, ok: false, code: 'timeout',
        error: '识别引擎长时间没有回应（已超时）'
      });
      /* 顺手让 offscreen 把这条撤掉：它可能还排在队列里，别白烧 CPU */
      toOffscreen({ to: 'offscreen', type: MSG.OCR_CANCEL, requestId: job.requestId });
    }
    return killed;
  }

  /* ---------------- 右键入口的地址闸门（SECURITY.md 附录 B.5） ----------------
   * 为什么必须有：扫描链读的是**页面自己已经在显示的图**（同源直接放行、跨域要白名单）；
   * 右键是"替用户去读一个他点名的外部地址" —— 于是私有地址一律拒（回环/内网/链路本地/IPv6 字面量）。
   * 判定**只对 `via:'contextMenu'` 生效**：两条路汇进同一个 `submitImage`，无条件套会把
   * 扫描链对 `http://localhost:3000/` 的既有放行打断，而且表现成"识别中…"这种最难查的形态（B.6）。
   * 顺序照附录 B.5：解析 → 只放 http(s) → 取 hostname → 规范化 → 逐类拒。
   */
  const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

  /** 私有/不可路由的 IPv4 字面量（域名形态直接放行，交给后缀规则） */
  function isPrivateIpv4(host) {
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    for (const p of parts) if (!/^\d{1,3}$/.test(p)) return false;
    const n = parts.map(Number);
    if (n.some((x) => x > 255)) return true;            // 形态像 IP 却越界 ⇒ 宁可保守拒掉
    const a = n[0];
    const b = n[1];
    if (a === 0 || a === 127 || a === 10 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;             // 链路本地（云元数据地址就在这）
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
    return false;
  }

  /** 右键入口能不能去读这个地址（true = 放行） */
  function isContextMenuSrcAllowed(raw) {
    let u = null;
    try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return false; }
    const scheme = String(u.protocol || '').toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') return false;   // data:/blob:/file: 一律拒
    let host = String(u.hostname || '').toLowerCase();
    while (host.length > 1 && host.charAt(host.length - 1) === '.') host = host.slice(0, -1);
    if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') host = host.slice(1, -1);
    if (!host) return false;
    if (host.indexOf(':') >= 0) return false;                       // IPv6 字面量一律拒
    if (host === 'localhost') return false;
    for (const suf of PRIVATE_HOST_SUFFIXES) {
      if (host.slice(-suf.length) === suf) return false;
    }
    if (isPrivateIpv4(host)) return false;
    return true;
  }

  /** 内容脚本的识别请求：不等待结果（结果另外送回该标签页），只登记路由 */
  async function submitImage(msg, sender) { return submitJob(msg, sender, 'image'); }

  /**
   * PDF 文本抽取请求（2.0.6.5 需求②）：路由/看门狗/回执与图片**完全共用**，
   * 差别只有三处 —— requestId 前缀、不注入引擎（PDF 不走 OCR 引擎）、转给 offscreen 的 payload。
   */
  async function submitPdf(msg, sender) { return submitJob(msg, sender, 'pdf'); }

  async function submitJob(msg, sender, kind) {
    /* 闸门必须在**入口**：`via` 不向下转发（`toOffscreen` 只带 src/dataUrl/keyword/engine），
     * 推到 offscreen 就没得判了。拒的时候一个字都不发出去、也不给任何回执（静默）。
     * 【只对 `via:'contextMenu'` 生效】右键菜单是**唯一**能指向任意地址（含内网）的入口，必须拦；
     * 大图里点「OCR 识别」拿的是面板里已经在展示的那张图 —— 与扫描链同一批 src（那条路本来就不
     * 过这道门，data: / 内网图都在里面），再套一遍只会让"图能看却识别不了"，口径反倒不一致。 */
    if (msg && msg.via === 'contextMenu' && !isContextMenuSrcAllowed(msg.src)) {
      return { ok: false, code: 'src-rejected' };
    }
    _sweep();                                    // 顺手清一遍（SW 睡过一觉时也能自愈）
    await ensureOffscreen();
    const requestId = nextId(kind === 'pdf' ? 'pdf' : 'img');
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const isExtPage = /^chrome-extension:\/\//i.test(String((sender && sender.url) || ''));
    /* 引擎在这里定下（唯一读配置的点），随后原样注入 offscreen —— 内容脚本压根不知道这个字段。
     * PDF 抽文字不经过任何引擎，给了也是噪音 ⇒ 空串（offscreen 收到 pdf 任务压根不读它）。 */
    const engine = kind === 'pdf' ? '' : await readEngine();
    const now = Date.now();
    const job = {
      requestId: requestId, tabId: tabId, kind: kind,
      /* frameId 必须记住：同源 iframe 也会跑内容脚本，结果要投回**发起那一帧** */
      frameId: sender ? sender.frameId : undefined,
      /* 用户点名入口的路由标记：内容脚本靠回执上的 `via` 认领（右键 →「截图」卡；大图 → 灯箱等待者） */
      via: (msg && msg.via) ? String(msg.via) : '',
      engine: engine, isExtPage: isExtPage, at: now, lastProgressAt: 0, sawProgress: false, timer: null
    };
    imageJobs.set(requestId, job);
    armWatchdog(job);
    /* 【2.0.2.15 需求②】受理即回执：用户点了右键，面板必须**立刻**出现那张「截图」卡（带"识别中…"），
     * 不能等 offscreen 跑完 —— 真机上 OCR 要几百毫秒到几秒，旧行为是"点完右键像什么都没发生"。
     * 只发给发起的那一帧（内容脚本据此建 pending 条目）；结果仍走 OCR_RESULT。 */
    if (job.via === 'contextMenu') {
      route(job, { type: MSG.OCR_QUEUED, requestId: requestId, src: msg.src, via: 'contextMenu' });
    }
    await toOffscreen(kind === 'pdf'
      ? { to: 'offscreen', type: MSG.OCR_PDF, requestId: requestId, tabId: tabId, src: msg.src, keyword: msg.keyword }
      : {
        to: 'offscreen', type: MSG.OCR_IMAGE, requestId: requestId, tabId: tabId,
        src: msg.src, dataUrl: msg.dataUrl, keyword: msg.keyword, engine: engine
      });
    return { ok: true, requestId: requestId, queued: true };
  }

  /**
   * 结果回送。
   * 【为什么必须重写 `to`】`chrome.runtime.sendMessage` 是**广播**：offscreen 发出来的
   * `{to:'background'}` 消息，扩展里每个上下文（设置页、内容脚本）都会收到一份。
   * 若不在这里把 `to` 改成只属于接收方的标记，接收方就会收到两条（一条直投、一条中转），
   * 而且那条直投的还带着 `to:'background'` —— 实测踩过：内容脚本怎么等都等不到自己的结果。
   * 约定：内容脚本认 `to:'content'`，扩展页（设置页自检）认 `to:'ui'`。
   * 【认领不到就不投】`job == null` 时**什么都不做**（见文件头"认领不到就不投"）。
   */
  /**
   * 按发起方路由投一条消息（内容脚本 vs 扩展页）。
   * `deliver`（识别结果）与「受理即回执」共用这一处，免得两条通路各写一套 to 规则。
   */
  function route(job, out) {
    if (!job) return;
    if (job.tabId == null || job.isExtPage) {
      try { chrome.runtime.sendMessage(Object.assign({}, out, { to: 'ui' })); } catch (e) { /* ignore */ }
      return;
    }
    out.to = 'content';
    try {
      /* 只有确实知道 frameId 时才带 options —— 否则旧浏览器/无 frame 的情形会投错 */
      const p = (typeof job.frameId === 'number')
        ? chrome.tabs.sendMessage(job.tabId, out, { frameId: job.frameId })
        : chrome.tabs.sendMessage(job.tabId, out);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 标签页已经关了：额度由内容脚本自己的 sweep 收口 */ }
  }

  function deliver(job, payload) {
    if (!job) return;
    const base = { type: MSG.OCR_RESULT, requestId: payload.requestId, ok: payload.ok };
    const out = Object.assign({}, payload, base);
    /* 用户点名入口：把路由标记带回给发起方那一帧（内容脚本据此认领）。
     * 只加在**回执**上 —— offscreen 侧一个字都不许知道（见 submitImage 的 toOffscreen）。 */
    if (job.via) out.via = job.via;
    route(job, out);
  }

  /** 出终态的统一出口：注销路由 + 停止看门狗 + 投出去 */
  function settleJob(job, payload) {
    if (!job) return false;
    imageJobs.delete(job.requestId);
    disarm(job);
    deliver(job, payload);
    return true;
  }

  /** 处理来自 offscreen 的回执/结果（由 service-worker 的 onMessage 分派） */
  function onOffscreenMessage(msg) {
    if (!msg || msg.to !== 'background') return false;

    if (msg.type === MSG.OCR_RESULT) {
      const rpc = rpcPending.get(msg.requestId);
      if (rpc) {
        rpcPending.delete(msg.requestId);
        clearTimeout(rpc.timer);
        if (msg.ok) rpc.resolve(msg); else rpc.reject(Object.assign(new Error(msg.error || 'OCR 失败'), { code: msg.code }));
        return true;
      }
      /* ★ 认领不到时不投（旧实现改投 to:'ui'，接收方按 to 过滤丢掉 → 永久"识别中…"） */
      return settleJob(imageJobs.get(msg.requestId), msg) || true;
    }

    /* 进度：广播给所有扩展页（设置页显示下载进度），内容脚本自己按 to 过滤。
     * 【同时当心跳】进度 payload 里**没有 requestId**（语言包下载是全局的），
     * 所以只能给所有在飞的 job 续命 —— 否则"正在下 20MB 语言包"会被硬顶误杀。 */
    if (msg.type === MSG.OCR_PROGRESS) {
      const now = Date.now();
      for (const job of imageJobs.values()) {
        job.sawProgress = true;
        job.lastProgressAt = now;
        armWatchdog(job);
      }
      try { chrome.runtime.sendMessage(Object.assign({}, msg, { to: 'ui' })); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  function cancelTab(tabId) {
    for (const [id, job] of Array.from(imageJobs.entries())) {
      if (job.tabId === tabId) { imageJobs.delete(id); disarm(job); }
    }
    return toOffscreen({ to: 'offscreen', type: MSG.OCR_CANCEL, tabId: tabId });
  }

  self.OcrHost = {
    ensureOffscreen: ensureOffscreen,
    ask: ask,
    submitImage: submitImage,
    submitPdf: submitPdf,
    onOffscreenMessage: onOffscreenMessage,
    cancelTab: cancelTab,
    /** 引擎配置读取（单点；单测直接喂假 storage 调它） */
    readEngine: readEngine,
    normalizeEngine: normalizeEngine,
    ENGINE_MODES: ENGINE_MODES,
    /** 看门狗推进（诊断/回归用）：喂一个时刻，返回判死的条数 */
    _sweep: _sweep,
    _debug: () => ({
      imageJobs: imageJobs.size,
      rpcPending: rpcPending.size,
      jobs: Array.from(imageJobs.values()).map((j) => ({
        requestId: j.requestId, tabId: j.tabId, frameId: j.frameId, at: j.at,
        engine: j.engine,
        lastProgressAt: j.lastProgressAt, sawProgress: j.sawProgress
      }))
    })
  };
})();
