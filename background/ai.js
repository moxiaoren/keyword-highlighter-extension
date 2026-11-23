/**
 * background/ai.js · 面板「AI 助手」的**唯一请求出口**
 * ----------------------------------------------------------------------------
 * 【2.0.16.4 · 用户 m19483】只保留太极AI 一条通路。
 *   用户原话：「只保留太极 AI，其余 AI 接口和调用路径全部移除」。
 *   因此删掉了两条老通路：
 *     · DeepSeek 网页对话（要开 chat.deepseek.com 标签页，靠 content/web-chat.js 打字读回复）；
 *     · OpenAI 兼容 API（设置里填 baseUrl / apiKey / model 那条）。
 *   对话一律转给 background/taiji.js：走站点自己的登录会话（cookie）、模型清单与 SSE。
 *   好处：不再出现任何对话页标签页，也不用用户自备 Key。
 * 仍然放在后台的原因：内容脚本里的 fetch 按**页面来源**走 CORS，站点不会给任意网站放行；
 *   service worker 是扩展自己的来源 + host_permissions: <all_urls> 才发得出去。
 *
 * 隐私：账号存本机 storage；密码只在登录那一次请求里出现，不写 storage、不写日志、不进导出。
 * ========================================================================= */

(function () {
  'use strict';

  const AI = {};

  /** 当前配置里的 `ai` 段（读 storage → Config.merge/normalize 这条唯一归一）。 */
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

  /**
   * 发一次对话（面板 AI 分页、设置页「测试连接」共用）。
   * @param {{messages?: Array, model?: string, override?: Object, timeoutMs?: number}} msg
   * @returns {Promise<{ok:boolean, text?:string, error?:string, needLogin?:boolean, usage?:Object}>}
   */
  AI.chat = async function (msg) {
    const payload = msg || {};
    const ai = await readConfig();
    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };
    if (!self.KhTaiji) return { ok: false, error: '太极AI 通道没加载（扩展需要更新）' };
    return self.KhTaiji.chat(payload);
  };

  /** 设置页「测试连接」：发一句最短的，确认真能收到回复。 */
  AI.test = function (override) {
    return AI.chat({ messages: [{ role: 'user', content: '你好' }], override: override || null });
  };

  /* ---------------- 太极AI：设置页的登录 / 模型清单 / 退出 ---------------- */

  AI.taijiLogin = function (msg) {
    return (self.KhTaiji && self.KhTaiji.login) ? self.KhTaiji.login(msg || {})
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
  };
  AI.taijiModels = function () {
    return (self.KhTaiji && self.KhTaiji.models) ? self.KhTaiji.models()
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
  };
  AI.taijiLogout = function () {
    return (self.KhTaiji && self.KhTaiji.logout) ? self.KhTaiji.logout()
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
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
