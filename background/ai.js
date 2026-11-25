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

  /* ---------------- 主标题 / 图标「AI 深查」（2.0.18 · m24795） ---------------- */

  /** 图标字节上限：站点单文件 5MB（模板 mFileSize ?? 5），超过就不带图，只按名称核验。 */
  const ICON_MAX = 5 * 1024 * 1024;
  /* 【2.0.17.5 · 用户 m26306】深查固定用这个模型（站点 tmpl 里 imageInput=true 的那个，
   * 名字就是用户在设置页看到的那一条）。**不跟随面板下拉**：核验要稳定可复现，
   * 换模型只换这一处；站点若改名，就代表这条链路要重新对齐。 */
  const RISK_MODEL = 'deepseek::deepseek-v4.1-flash-1017';

  /** Uint8Array → base64（分块，避免 apply 参数爆炸）。 */
  function b64Of(u8) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  /** 图标 → dataURL。站外图标在内容脚本里按页面来源走 CORS 多半取不到，所以放后台取。 */
  async function iconDataUrl(src) {
    if (/^data:image\//i.test(src)) return src;
    if (!/^https?:/i.test(src)) return '';
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (!r.ok) return '';
      const buf = await r.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > ICON_MAX) return '';
      const type = String(r.headers.get('content-type') || 'image/png').split(';')[0].trim();
      if (type.indexOf('image/') !== 0) return '';
      return 'data:' + type + ';base64,' + b64Of(new Uint8Array(buf));
    } catch (e) { return ''; }
  }

  /** 允许的枚举：模型偶尔会自由发挥（「高风险」/「risky」/「是」），统一收敛到这三档。 */
  const RISK_VERDICT = { safe: 'safe', suspect: 'suspect', risky: 'risky' };
  const RISK_ICON = { none: 'none', similar: 'similar', risky: 'risky' };

  function pickVerdict(v) {
    const s = String(v || '').trim().toLowerCase();
    if (/risky|high|非常高|高风险/.test(s)) return 'risky';
    if (/suspect|medium|存疑|可疑|待核/.test(s)) return 'suspect';
    if (/safe|low|安全|无风险/.test(s)) return 'safe';
    return '';
  }

  function pickIconRisk(v) {
    const s = String(v || '').trim().toLowerCase();
    if (/risky|高风险/.test(s)) return 'risky';
    if (/similar|模仿|相似|像/.test(s)) return 'similar';
    if (/none|no|未发现|不像|无关/.test(s)) return 'none';
    return 'unknown';
  }

  /**
   * 从回复里抠出那一行 JSON。模型可能包代码块、加解释、甚至只回半截 ——
   * 依次尝试：整段 → 第一个 { 到最后一个 } → 正则逐字段兜底。都失败就返回 null，
   * 调用方把原文当「未查明」，绝不用猜测冒充结论。
   */
  function parseRisk(text) {
    const s = String(text || '');
    const tryOne = (raw) => {
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') return o;
      } catch (e) { /* 下一手 */ }
      return null;
    };
    let o = tryOne(s.trim());
    if (!o) {
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a >= 0 && b > a) o = tryOne(s.slice(a, b + 1));
    }
    if (!o) return null;
    const cats = [];
    const rawCats = o.cats;
    if (rawCats instanceof Array) {
      for (let i = 0; i < rawCats.length && i < 6; i++) if (rawCats[i]) cats.push(String(rawCats[i]).slice(0, 12));
    } else if (rawCats) cats.push(String(rawCats).slice(0, 12));
    return {
      verdict: pickVerdict(o.verdict) || '',
      brand: String(o.brand || '').slice(0, 40),
      cats: cats,
      iconRisk: pickIconRisk(o.iconRisk),
      why: String(o.why || o.reason || '').slice(0, 160)
    };
  }

  /**
   * 主标题 / 图标的风险核验：交给太极AI **联网**做，返回结构化结论供卡片回填。
   * 【2.0.17.3 · 用户 m25410】从「点一下看一段话」改成「自动跑 + 可回填」：
   * 结论必须是一行 JSON（verdict / brand / cats / iconRisk / why），面板按 key 落缓存，
   * 重开面板直接渲染 —— 所以这里**不容忍自由文本**：解析失败就 ok:false，卡片显示「— 未查明」。
   * @returns {Promise<{ok:boolean, data?:Object, text?:string, error?:string, needLogin?:boolean}>}
   */
  AI.riskCheck = async function (msg) {
    const p = msg || {};
    const title = String(p.title || '').trim();
    if (!title) return { ok: false, error: '没有主标题，没法核验' };
    const ai = await readConfig();
    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };
    if (!self.KhTaiji) return { ok: false, error: '太极AI 通道没加载（扩展需要更新）' };
    const prompt = [
      '联网核验这个应用：①名称是否蹭知名应用/品牌；②图标是否模仿知名应用的图标；③是否涉及资金盘、色情低俗、赌博、诈骗、违规贷款。',
      '只输出一行 JSON，不要代码块，不要任何解释：',
      '{"verdict":"safe|suspect|risky","brand":"蹭到的品牌或空串","cats":["资金盘"],"iconRisk":"none|similar|risky","why":"30 字以内依据"}',
      '没有附图时 iconRisk 写 unknown。应用名称：' + title
    ].join('\n');
    const files = [];
    const icon = String(p.icon || '').trim();
    if (icon) {
      const data = await iconDataUrl(icon);
      if (data) files.push({ name: 'icon.png', data: data });
    }
    const r = await self.KhTaiji.chat({ model: RISK_MODEL, messages: [{ role: 'user', content: prompt }], webSearch: true, files: files });
    if (!r || !r.ok) return r || { ok: false, error: '没有回执' };
    const got = parseRisk(r.text);
    if (!got || !got.verdict) {
      return { ok: false, error: '模型没有按约定回结构化结论（已跳过，不猜）', text: String(r.text || '').slice(0, 400) };
    }
    return { ok: true, data: got, text: String(r.text || '').slice(0, 400) };
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

  self.KhAi = AI;
})();
