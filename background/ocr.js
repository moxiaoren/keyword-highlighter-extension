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
 * ========================================================================= */
'use strict';

(function () {
  const MSG = self.KH.MSG;
  const OFFSCREEN_PATH = 'offscreen/ocr.html';
  const RPC_TIMEOUT_MS = 180000;      // 语言包下载 + 建引擎，给足时间

  let seq = 0;
  const imageJobs = new Map();        // requestId -> { tabId, isExtPage, at }
  const rpcPending = new Map();       // requestId -> { resolve, reject, timer }

  function nextId(prefix) { seq += 1; return prefix + seq + '-' + Date.now().toString(36); }

  /* ---------------- offscreen 文档生命周期 ---------------- */

  let creating = null;

  async function ensureOffscreen() {
    if (!chrome.offscreen) throw new Error('当前浏览器不支持 offscreen（需要 Chrome/Edge 109+）');
    if (await chrome.offscreen.hasDocument()) return true;
    if (creating) { await creating; return true; }
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: '在扩展自己的页面里运行本地 OCR 引擎（识别图片中的关键词文字）'
    }).catch((err) => {
      /* 两个标签页同时触发时会撞车：已存在就当成功 */
      const m = String((err && err.message) || err);
      if (!/single offscreen|already/i.test(m)) throw err;
    });
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

  /** 内容脚本的识别请求：不等待结果（结果另外送回该标签页），只登记路由 */
  async function submitImage(msg, sender) {
    await ensureOffscreen();
    const requestId = nextId('img');
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const isExtPage = /^chrome-extension:\/\//i.test(String((sender && sender.url) || ''));
    imageJobs.set(requestId, { tabId: tabId, isExtPage: isExtPage, at: Date.now() });
    /* 防泄漏：正常都会在结果回来时删掉；万一结果丢了也不至于一直攒着 */
    setTimeout(() => imageJobs.delete(requestId), 5 * 60 * 1000);
    await toOffscreen({
      to: 'offscreen', type: MSG.OCR_IMAGE, requestId: requestId, tabId: tabId,
      src: msg.src, dataUrl: msg.dataUrl, keyword: msg.keyword
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
   */
  function deliver(job, payload) {
    const base = { type: MSG.OCR_RESULT, requestId: payload.requestId, ok: payload.ok };
    if (!job || job.tabId == null || job.isExtPage) {
      try { chrome.runtime.sendMessage(Object.assign({}, payload, base, { to: 'ui' })); } catch (e) { /* ignore */ }
      return;
    }
    chrome.tabs.sendMessage(job.tabId, Object.assign({}, payload, base, { to: 'content' })).catch(() => {});
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
      const job = imageJobs.get(msg.requestId);
      imageJobs.delete(msg.requestId);
      deliver(job, msg);
      return true;
    }

    /* 进度：广播给所有扩展页（设置页显示下载进度），内容脚本自己按 to 过滤 */
    if (msg.type === MSG.OCR_PROGRESS) {
      try { chrome.runtime.sendMessage(Object.assign({}, msg, { to: 'ui' })); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  function cancelTab(tabId) {
    for (const [id, job] of Array.from(imageJobs.entries())) {
      if (job.tabId === tabId) imageJobs.delete(id);
    }
    return toOffscreen({ to: 'offscreen', type: MSG.OCR_CANCEL, tabId: tabId });
  }

  self.OcrHost = {
    ensureOffscreen: ensureOffscreen,
    ask: ask,
    submitImage: submitImage,
    onOffscreenMessage: onOffscreenMessage,
    cancelTab: cancelTab,
    _debug: () => ({ imageJobs: imageJobs.size, rpcPending: rpcPending.size })
  };
})();
