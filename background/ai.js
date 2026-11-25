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

  /**
   * 【2.0.18.2 · 用户 m27947】私有地址不外送 + 不带凭据。
   *   用户原话：「私有地址不外送 + 去掉凭据」。理由两条：
   *     ① 图标字节会被 base64 后随 files 发给太极AI 站点 —— 内网图片不该离开内网；
   *     ② 原来 fetch 带 credentials:'include'，等于用用户的内网登录态去 GET 页面给的任意地址，
   *        页面可控时就是「扩展当内网跳板」（盲 SSRF / 带副作用的 GET），必须去掉。
   *   只认 https 公网地址：http、内网、回环、链路本地、单标签主机名（intranet 这类）一律跳过。
   */
  function hostOf(u) {
    try { return String(new URL(u).hostname || '').replace(/^\[|\]$/g, '').toLowerCase(); } catch (e) { return ''; }
  }

  function isPrivateHost(h) {
    if (!h) return true;
    if (h === 'localhost' || /\.(localhost|local|internal|intranet|lan|corp|home)$/.test(h)) return true;
    if (h.indexOf('.') < 0 && h.indexOf(':') < 0) return true;   /* 无点主机名：内网短名 */
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;         /* CGNAT 100.64/10 */
      return false;
    }
    if (h === '::1' || h === '::') return true;
    if (/^::ffff:/.test(h)) return true;                        /* IPv4 映射 */
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;              /* fc00::/7 ULA */
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;              /* fe80::/10 链路本地 */
    return false;
  }

  /** 图标能不能取：'' 可以取；'empty' 没给；'scheme' 非 https；'private' 内网/回环。 */
  AI.iconSkip = function (src) {
    const s = String(src || '').trim();
    if (!s) return 'empty';
    if (/^data:image\//i.test(s)) return '';
    if (!/^https:\/\//i.test(s)) return 'scheme';
    if (isPrivateHost(hostOf(s))) return 'private';
    return '';
  };

  /** 图标 → dataURL。站外图标在内容脚本里按页面来源走 CORS 多半取不到，所以放后台取。 */
  async function iconDataUrl(src) {
    if (/^data:image\//i.test(src)) return src;
    if (AI.iconSkip(src)) return '';
    try {
      const r = await fetch(src, { credentials: 'omit' });
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
      /* 【2.0.19 · 用户 m27658】模型给出的「像哪款违规应用」：卡片上单独一句，比裸词更好理解。 */
      ref: String(o.ref || o.similar || '').slice(0, 40),
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
    /* 【2.0.17.6 · 用户 m26871】开发者/主体一起给模型：名称对得上品牌但开发者是官方主体时不要判蹭品牌。 */
    const dev = String(p.dev || '').trim();
    const prompt = [
      /* 【2.0.19 · 用户 m27658】主判「像不像」：名称/图标与已知色情、资金盘、博彩、诈骗类应用（含马甲、换皮）的相似度；
       * 其次才是蹭正规品牌；直接违规词只作兜底。仍只做分类，不展开细节。 */
      '联网核验这个应用，只做风险分类，不要复述或展开任何违规细节：',
      '①先比对：名称与图标是否与已知的色情软件、资金盘、博彩、诈骗、违规贷款类应用（含其马甲、同名站点、换皮版本）相同或高度相似——像就把该应用名写进 ref，verdict 写 suspect，明显是同一款或换皮写 risky；',
      '②再判蹭牌：名称/图标是否蹭知名正规应用或品牌（开发者/主体是该品牌的官方主体时不算蹭，verdict 写 safe）；',
      '③最后兜底：名称或图标本身是否直接带色情、赌博、资金盘、诈骗、违规贷款的词。',
      '只输出一行 JSON，不要代码块，不要任何解释：',
      '{"verdict":"safe|suspect|risky","ref":"相似的违规应用名，没有写空串","brand":"蹭到的正规品牌或空串","cats":["资金盘"],"iconRisk":"none|similar|risky","why":"30 字以内依据"}',
      '没有附图时 iconRisk 写 unknown。应用名称（主标题-副标题）：' + title
    ].concat(dev ? ['开发者/主体：' + dev] : []).join('\n');
    const files = [];
    const icon = String(p.icon || '').trim();
    /* 内网 / 非 https 的图标不取也不发；卡片上要写明为什么没看图（用户 m27947）。 */
    const iconSkip = icon ? AI.iconSkip(icon) : '';
    if (icon && !iconSkip) {
      const data = await iconDataUrl(icon);
      if (data) files.push({ name: 'icon.png', data: data });
    }
    /* 【2.0.18.3 · m28516】深查收进一个固定对话窗（后台给的 tab<id>#risk）。 */
    const r = await self.KhTaiji.chat({ model: RISK_MODEL, chatId: String(p.chatId || ''), messages: [{ role: 'user', content: prompt }], webSearch: true, files: files });
    if (!r || !r.ok) return r || { ok: false, error: '没有回执' };
    const got = parseRisk(r.text);
    if (!got || !got.verdict) {
      return { ok: false, error: '模型没有按约定回结构化结论（已跳过，不猜）', text: String(r.text || '').slice(0, 400) };
    }
    const out = Object.assign({}, got);
    if (iconSkip) out.iconSkip = iconSkip;
    return { ok: true, data: out, text: String(r.text || '').slice(0, 400) };
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
