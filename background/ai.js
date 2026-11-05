/**
 * background/ai.js · 重要笔记面板「AI 助手」的**唯一请求出口**（2.0.8.4 需求④）
 * ----------------------------------------------------------------------------
 * 为什么必须放在后台：
 *   内容脚本里的 `fetch` 走**页面来源**的 CORS 口径，`api.deepseek.com` 不会给任意网站放行；
 *   service worker 是扩展自己的来源，又有 `host_permissions: <all_urls>`，才发得出去。
 *   设置页的「测试连接」也复用 `KhAi.chat`（只有一份实现，测的就是真发请求的那条路）。
 *
 * 协议：OpenAI 兼容的 `POST {baseUrl}/chat/completions`
 *   { model, messages:[{role,content}], max_tokens, stream:false, temperature? }
 *   headers: Authorization: Bearer <apiKey>（没填 key 就不带，本地/中转服务可能不需要）
 * 回执：{ ok:true, text } | { ok:false, error }（错误原文照抄，不做"友好化"改写 ——
 *   用户要能拿它去搜/去问服务商；面板负责把原文显示出来）。
 *
 * 口径（用户 2026-11-03 拍板）：
 *   · 支持各类 API —— 只要求 OpenAI 兼容；默认值来自 `Config.defaults.ai`（DeepSeek 官方）。
 *   · **纯自由对话**：不带页面标题 / URL / 笔记内容，发出去的只有用户自己打的那几句。
 *   · key 只存在本机 storage，不写日志、不回显、不进导出。
 * ========================================================================= */

(function () {
  'use strict';

  const AI = {};

  /** 请求超时（ms）：流式没开、模型慢时给足一分钟；到点如实报"超时"而不是永远转圈。 */
  const TIMEOUT_MS = 60000;
  /** 错误体最多回传多少字符（整页 HTML 错误页只截开头，面板里放得下也看得清）。 */
  const ERR_TEXT_MAX = 400;

  /** 当前配置（读 storage → 走 Config.merge/normalize 这条**唯一**归一，不在这里抄默认值） */
  function readConfig() {
    return Promise.resolve()
      .then(() => chrome.storage.local.get(null))
      .then((all) => {
        const C = self.KH && self.KH.Config;
        if (!C || typeof C.merge !== 'function') return {};
        const merged = C.merge(all || {});
        const normalized = (typeof C.normalize === 'function') ? C.normalize(merged).config : merged;
        return (normalized && normalized.ai) || {};
      })
      .catch(() => ({}));
  }

  /** `{baseUrl}` → 完整的 chat/completions 地址（用户已经填到端点就不重复拼）。 */
  function endpointOf(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
  }

  /** 把消息数组洗成协议要求的形状（只留 role/content；空内容丢弃） */
  function cleanMessages(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const m = list[i] || {};
      const role = (m.role === 'assistant') ? 'assistant' : 'user';
      const content = String(m.content == null ? '' : m.content);
      if (!content.trim()) continue;
      out.push({ role: role, content: content.slice(0, 8000) });
    }
    return out;
  }

  /**
   * 发一次对话请求。
   * @param {{messages?: Array, override?: Object}} msg  `override` 只给设置页「测试连接」用：
   *        用页面上**还没保存**的那几项去试，避免"先存再测"把坏配置存进去。
   * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
   */
  AI.chat = async function (msg) {
    const payload = msg || {};
    const stored = await readConfig();
    const override = (payload.override && typeof payload.override === 'object') ? payload.override : null;
    const C = (self.KH && self.KH.Config) || {};
    /* 变量名刻意不叫 `cfg`：单测的「配置键守卫」会把 `cfg.<键>` 当成顶层配置读点，
     * 这里的 enabled/baseUrl/model… 都是 `ai` 下面的子键（不是 Config.defaults 的顶层键）。 */
    const ai = (typeof C.normalizeAi === 'function')
      ? C.normalizeAi(Object.assign({}, stored, override || {}))
      : Object.assign({}, stored, override || {});

    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };
    const url = endpointOf(ai.baseUrl);
    if (!url) return { ok: false, error: '还没填接口地址（设置 → AI 助手）' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' };

    const messages = cleanMessages(payload.messages);
    if (!messages.length) return { ok: false, error: '没有要发送的内容' };
    const sys = String(ai.system || '').trim();
    if (sys) messages.unshift({ role: 'system', content: sys.slice(0, 4000) });

    const body = {
      model: ai.model || '',
      messages: messages,
      max_tokens: ai.maxTokens || 800,
      stream: false
    };

    const headers = { 'Content-Type': 'application/json' };
    if (ai.apiKey) headers.Authorization = 'Bearer ' + ai.apiKey;

    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, TIMEOUT_MS) : 0;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      return { ok: false, error: aborted ? ('请求超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒）') : ('请求没发出去：' + String((err && err.message) || err)) };
    }
    if (timer) clearTimeout(timer);

    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }

    if (!res.ok) {
      /* 错误原文优先取 JSON 里的 error.message（各家都在这），没有就截原文。
       * ⚠️ 绝不把请求头/Key 打进错误里 —— 这里只碰响应体。 */
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || text;
      } catch (e) { /* 不是 JSON：原样截断 */ }
      detail = String(detail || '').slice(0, ERR_TEXT_MAX);
      return { ok: false, error: 'HTTP ' + res.status + (detail ? '：' + detail : ''), status: res.status };
    }

    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    const choice = data && data.choices && data.choices[0];
    const content = choice && ((choice.message && choice.message.content) || choice.text);
    if (!content) {
      /* 200 但没有内容：把原文截一段回去（多半是协议不兼容 / 中转返回了别的东西） */
      const raw = String(text || '').slice(0, ERR_TEXT_MAX);
      return { ok: false, error: '接口没有返回内容' + (raw ? '：' + raw : '') };
    }
    return { ok: true, text: String(content) };
  };

  /* ==========================================================================
   * 网页对话模式（2.0.8.5）：界面还是插件自己的 AI 分页，后台去驱动 chat.deepseek.com
   * --------------------------------------------------------------------------
   * 为什么要一个真标签页：网页版没有公开接口，请求要靠站点自己的登录态与签名（PoW），
   * 后台算不出来。所以这里只做三件事：
   *   1) 找/开一个 chat.deepseek.com 标签页（**后台开、不抢焦点**，用户可最小化）；
   *   2) 把这一句话交给 content/web-chat.js（它负责打字、回车、读回复）；
   *   3) 把它推回来的增量转给面板（长连接在 service-worker.js 里）。
   * 用户口径：纯自由对话 —— 只发用户自己打的那句，不带页面内容；上下文由网页版自己维持，
   * 面板点「清空」时会要求网页开新对话（否则会串台）。
   * ======================================================================== */
  const WEB_ORIGIN = 'https://chat.deepseek.com/';
  const WEB_WAIT_MS = 30000;
  const WEB_ANSWER_MS = 180000;
  const pending = new Map();
  let seq = 0;
  let webTab = 0;

  function msgOf() {
    try { return (self.KH && self.KH.MSG) || {}; } catch (e) { return {}; }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 找一个已打开的对话页（用户自己开着的那张优先，避免重复开一堆）。 */
  async function findWebTab() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' }); } catch (e) { tabs = []; }
    for (let i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id) return tabs[i].id;
    return 0;
  }

  /** 等到页面里的 content script 能应答（新开的标签页要加载 + 注入，给足 30s）。 */
  async function waitReady(tabId) {
    const T = msgOf();
    const started = Date.now();
    let lastErr = '';
    while (Date.now() - started < WEB_WAIT_MS) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: T.WEB_PING || 'kh:web:ping' });
        if (res && res.ok) return res;
      } catch (err) {
        lastErr = String((err && err.message) || err);
      }
      await sleep(400);
    }
    throw new Error('对话页没有响应（' + (lastErr || '超时') + '）');
  }

  /** 拿到一个可用的对话页；没有就后台开一个（不抢当前标签页的焦点）。 */
  async function ensureWebTab() {
    let id = await findWebTab();
    if (!id) {
      const tab = await chrome.tabs.create({ url: WEB_ORIGIN, active: false });
      id = tab && tab.id;
      if (!id) throw new Error('打不开对话页（浏览器拒绝了新建标签页）');
    }
    webTab = id;
    return id;
  }

  /** 面板点「打开对话页」/「去登录」：把标签页切到前台（这一刻就是为了让人看见，故意抢焦点）。 */
  AI.openWeb = async function () {
    const id = await ensureWebTab();
    try { await chrome.tabs.update(id, { active: true }); } catch (e) { /* 关掉了就当无事发生 */ }
    try { const t = await chrome.tabs.get(id); if (t && t.windowId) await chrome.windows.update(t.windowId, { focused: true }); } catch (e) { /* ignore */ }
    return { ok: true, tabId: id };
  };

  /** 设置页「自检」：把页面侧认到的选择器原样带回来（认不出时用户能一键发回诊断）。 */
  AI.probeWeb = async function () {
    try {
      const id = await ensureWebTab();
      const res = await waitReady(id);
      return { ok: true, tabId: id, probe: (res && res.probe) || {}, loggedIn: !!(res && res.loggedIn) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  /** 网页侧的增量回包：按 requestId 找回发起者。 */
  AI.onWebChunk = function (msg) {
    const id = String((msg && msg.requestId) || '');
    if (!id) return;
    const req = pending.get(id);
    if (!req) return;
    req.text = String(msg.text || '');
    if (typeof req.onChunk === 'function') { try { req.onChunk(req.text); } catch (e) { /* 面板那边已关 */ } }
    if (msg.done) finish(id, msg.error ? String(msg.error) : '');
  };

  function finish(requestId, error) {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    if (req.timer) clearTimeout(req.timer);
    try { req.resolve({ ok: !error, text: req.text || '', error: error || '' }); } catch (e) { /* ignore */ }
  }

  /**
   * 网页版提问。
   * @param {{messages:Array, onChunk?:Function}} msg
   * @returns {Promise<{ok:boolean, text?:string, error?:string, needLogin?:boolean}>}
   */
  AI.askWeb = async function (msg) {
    const payload = msg || {};
    const stored = await readConfig();
    const C = (self.KH && self.KH.Config) || {};
    const ai = (typeof C.normalizeAi === 'function') ? C.normalizeAi(stored) : stored;
    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };

    const messages = cleanMessages(payload.messages);
    if (!messages.length) return { ok: false, error: '没有要发送的内容' };
    /* 网页版自己会记住上文，所以只发**最后一句用户消息**；发整段历史反而会重复两遍上下文。 */
    let last = null;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { last = messages[i]; break; }
    const text = last ? last.content : messages[messages.length - 1].content;

    let tabId;
    let ready;
    try {
      tabId = await ensureWebTab();
      ready = await waitReady(tabId);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    if (!ready.loggedIn) {
      return { ok: false, needLogin: true, error: '对话页还没登录：点下面的「去登录」，登录一次就好（之后一直有效）。' };
    }

    const requestId = 'w' + Date.now().toString(36) + '_' + (++seq);
    const T = msgOf();
    const promise = new Promise((resolve) => {
      pending.set(requestId, { text: '', resolve: resolve, onChunk: payload.onChunk, timer: 0 });
    });
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: T.WEB_ASK || 'kh:web:ask', requestId: requestId, text: text });
      if (!res || !res.ok) {
        pending.delete(requestId);
        return { ok: false, needLogin: !!(res && res.needLogin), error: String((res && res.error) || '对话页没有接受这次提问') };
      }
    } catch (err) {
      pending.delete(requestId);
      return { ok: false, error: '对话页没接住（' + String((err && err.message) || err) + '）' };
    }

    /* 后台这一侧的硬超时：网页一直不结束（比如用户手动停在那儿）时，别让面板永远转圈。 */
    const entry = pending.get(requestId);
    if (entry) {
      entry.timer = setTimeout(() => {
        try { chrome.tabs.sendMessage(tabId, { type: T.WEB_STOP || 'kh:web:stop' }); } catch (e) { /* ignore */ }
        finish(requestId, '等回复超时（' + Math.round(WEB_ANSWER_MS / 1000) + ' 秒）');
      }, WEB_ANSWER_MS);
    }
    return promise;
  };

  /** 面板点「清空」时同步网页开新对话，免得下一次问题还带着上一轮的上下文。 */
  AI.newWebChat = async function () {
    try {
      const id = await ensureWebTab();
      const T = msgOf();
      await chrome.tabs.sendMessage(id, { type: T.WEB_NEW || 'kh:web:new' });
      return { ok: true };
    } catch (e) { return { ok: false }; }
  };

  /** 设置页「测试连接」：网页模式就发一句最短的。 */
  AI.test = function (override) {
    return AI.chat({ messages: [{ role: 'user', content: '你好' }], override: override || null });
  };

  /* ==========================================================================
   * 【2.0.8.7 需求②】AI 审核：应用名称 / 图标是否蹭品牌、是否涉敏感内容
   * --------------------------------------------------------------------------
   * 为什么单开一条通道（不复用 AI.chat）：
   *   · AI.chat 的 `cleanMessages` 只收纯字符串 content（自由对话的既有口径），带不了图；
   *   · 审核要的是**结构化结论**，而且默认走 Cloudflare Workers AI 的免费额度
   *     （10,000 neurons/天，一张 512px 图标约 5~9 neurons ⇒ 约 1000~2000 次/天）。
   * 端点：CF 的 OpenAI 兼容地址 `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/chat/completions`
   * 图片：直接放 base64 data URL（`image_url.url` 支持 data URI，不需要先传到别处）。
   * 隐私：只在用户点「云端复核」时发出；token 只存本机，不写日志、不进导出。
   * ======================================================================== */
  const AUDIT_TIMEOUT_MS = 90000;
  const AUDIT_IMAGE_MAX = 3 * 1024 * 1024;

  const AUDIT_PROMPT = [
    '你是应用商店的合规审核员。判断下面这个【应用名称】与【图标】是否：',
    '1) 蹭知名应用或品牌：名称、图标、配色与某知名 App 高度相似，会让用户误以为是它或它的官方产品；',
    '2) 涉敏感内容：赌博/博彩、色情、资金盘/传销/返利盘、诈骗/刷单/杀猪盘、违规贷款/征信修复、虚拟货币交易。',
    '只输出一个 JSON 对象，不要任何解释文字，字段如下：',
    '{"risk":"safe|suspect|risky","brands":[{"name":"品牌名","why":"为什么像"}],',
    '"sensitive":[{"tag":"赌博|色情|资金盘|诈骗|贷款|其它","why":"依据"}],"summary":"一句话结论"}',
    'risk 口径：safe=没有疑点；suspect=像但没有直接证据；risky=明确违规或明确仿冒。',
    '看不到图标时按名称判断，并在 summary 里说明「未提供图标」。'
  ].join('\n');

  function auditEndpoint(accountId) {
    const id = String(accountId || '').trim();
    if (!id) return '';
    return 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(id) + '/ai/v1/chat/completions';
  }

  /** 宽松地从模型回复里抠出 JSON（有的模型会套 ```json 或前后加话）。 */
  function parseAuditJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    const direct = tryParse(raw);
    if (direct && typeof direct === 'object') return direct;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { const j = tryParse(fence[1].trim()); if (j) return j; }
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) { const j = tryParse(raw.slice(a, b + 1)); if (j) return j; }
    return null;
  }

  /**
   * 审核一次：{ name, image?, override? }
   * @returns {Promise<{ok:boolean, audit?:Object, text?:string, error?:string, needSetup?:boolean}>}
   */
  AI.audit = async function (msg) {
    const payload = msg || {};
    const C = (self.KH && self.KH.Config) || {};
    const stored = await readConfigAll();
    const raw = Object.assign({}, (stored && stored.aiAudit) || {}, payload.override || {});
    const A = (typeof C.normalizeAiAudit === 'function') ? C.normalizeAiAudit(raw) : raw;

    if (A.enabled === false) return { ok: false, error: 'AI 审核已在设置里关闭' };
    const name = String(payload.name == null ? '' : payload.name).trim().slice(0, 120);
    const image = String(payload.image == null ? '' : payload.image);
    if (!name && !image) return { ok: false, error: '先填应用名称或选一张图标' };
    if (image && image.length > AUDIT_IMAGE_MAX) return { ok: false, error: '图标太大了（超过 3 MB），换一张小图' };
    if (!/^data:image\//i.test(image) && image) return { ok: false, error: '图标格式不对（要 data:image/... 的 base64）' };
    if (A.localOnly) return { ok: false, error: '设置里勾了「只跑本地词库」，云端复核已跳过', needSetup: true };
    const url = auditEndpoint(A.accountId);
    if (!url || !A.token) return { ok: false, error: '还没填 Cloudflare 账号 ID / API Token（设置 → AI 审核）', needSetup: true };

    const userText = '应用名称：' + (name || '（未提供）') + (image ? '\n图标：见附图。' : '\n图标：未提供。');
    const userContent = [{ type: 'text', text: userText }];
    if (image) userContent.push({ type: 'image_url', image_url: { url: image } });

    const body = {
      model: A.model || (C.AI_AUDIT_MODEL_DEFAULT || '@cf/meta/llama-3.2-11b-vision-instruct'),
      messages: [
        { role: 'system', content: AUDIT_PROMPT },
        { role: 'user', content: userContent }
      ],
      max_tokens: 700,
      stream: false
    };
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A.token };

    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, AUDIT_TIMEOUT_MS) : 0;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST', headers: headers, body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined, credentials: 'omit', cache: 'no-store'
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      return { ok: false, error: aborted ? ('等结果超时（' + Math.round(AUDIT_TIMEOUT_MS / 1000) + ' 秒）') : ('请求没发出去：' + String((err && err.message) || err)) };
    }
    if (timer) clearTimeout(timer);

    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = (j && j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].code))
          || (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || text;
      } catch (e) { /* 非 JSON：原样截断 */ }
      const hint = (res.status === 429) ? '（免费额度可能用完了，UTC 0 点重置）'
        : (/3040|capacity/i.test(String(detail || '')) ? '（模型暂时没容量，稍后重试或换个模型）' : '');
      return { ok: false, error: 'HTTP ' + res.status + hint + '：' + String(detail || '').slice(0, 300) };
    }

    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    const choice = data && data.choices && data.choices[0];
    const content = choice && ((choice.message && choice.message.content) || choice.text);
    if (!content) return { ok: false, error: '接口没有返回内容：' + String(text || '').slice(0, 200) };

    const parsed = parseAuditJson(content);
    if (!parsed) return { ok: true, audit: null, text: String(content).slice(0, 2000), error: '模型没按 JSON 回，下面是原文' };
    return { ok: true, audit: parsed, text: String(content).slice(0, 2000) };
  };

  /** 读整份配置（审核要 aiAudit，`readConfig` 只回 ai）。 */
  function readConfigAll() {
    return Promise.resolve()
      .then(() => chrome.storage.local.get(null))
      .then((all) => {
        const C = self.KH && self.KH.Config;
        if (!C || typeof C.merge !== 'function') return {};
        const merged = C.merge(all || {});
        return (typeof C.normalize === 'function') ? (C.normalize(merged).config || merged) : merged;
      })
      .catch(() => ({}));
  }

  self.KhAi = AI;
})();
