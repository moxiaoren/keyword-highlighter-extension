/**
 * background/taiji.js · 「太极AI 网页通路」（2.0.16 需求）
 * ----------------------------------------------------------------------------
 * 为什么单独一条通道：太极AI 站点没有 OpenAI 兼容接口，它自己那套是
 *   ① POST /api/user/login 拿会话 cookie → ② GET /api/chat/tmpl 拿模型清单
 *   → ③ POST /api/chat/session 建会话 → ④ POST /api/chat/completions 读 SSE。
 * 这套只有站点自己认，所以不能复用 background/ai.js 里的 OpenAI 兼容请求。
 *
 * 三条硬口径（用户 2026-11-23 拍板）：
 *   · 设置页里登录（账号密码只发一次，密码不落盘）：会话靠浏览器 cookie，
 *     所以这里一律带 credentials:'include'，登录一次之后一直有效，换密码再登一次即可。
 *   · 模型自选：清单来自站点 /api/chat/tmpl，选中项存 ai.taiji.model。
 *   · 不开标签页：整条路都是后台 fetch（与 DeepSeek 网页那条要开标签页的通道相反）。
 * 另外给法人检索兜底：repOf(company) 让模型只回人名，由 entity.js 做格式校验。
 *
 * 隐私：账号存本机 storage（可留空）；密码只在登录那一次请求里出现，不写 storage、
 * 不写日志、不进导出。回复内容不落盘。
 * ========================================================================= */

(function () {
  'use strict';

  const T = {};
  /** 站点地址发现：这个纯 HTTP 端点回一个 https 站点地址（桥也是这么找站点的）。 */
  const APP_URL = 'http://api.taijiai666.com/app-url.txt';
  /** 站点只认这个 UA（桥里同一串）；换 UA 会被当成别的客户端。 */
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TaijiBridge/1.1';
  /** 允许的站点域名（与桥的 allowlist 一致；域名换了只要还在这个后缀下就不用改代码）。
   * 【2.0.16.1 · 用户 m18091】补上**品牌域名** taijiai666.com：
   * 用户看到的是 https://www.taijiai666.com/，而它 301 到真实宿主 ai.zhuangxiuyunying.xyz，
   * 于是「用户照着品牌名手填的站点地址」必须能进白名单，再由 resolveRedirect 跟到真实 origin。 */
  const ALLOW = ['ai.zhuangxiuyunying.xyz', 'taijiai666.com'];
  /** 真实宿主（app-url.txt 回的那个）。已经是它就不用再跟重定向，省一次请求。 */
  const CANON_HOST = 'ai.zhuangxiuyunying.xyz';
  const APP_URL_TIMEOUT = 6000;
  /** 等站点数据的最长时间；SSE 期间按"多久没新数据"算（空闲超时，不是总时长）。 */
  const IDLE_MS = 90000;
  /** 单次回复最多留多少字符（面板放不下更多；也防站点抽风灌满内存）。 */
  const MAX_REPLY = 20000;
  const ERR_MAX = 300;

  /* 站点把推理过程内联在正文里：可能成对出现，也可能只给结束符。两种都处理（口径同桥）。 */
  const OPENERS = ['<think>', ' thinking'];
  const CLOSERS = ['</think>', '<｜end▁of▁thinking｜>'];

  function firstOf(buf, list) {
    const low = String(buf || '').toLowerCase();
    let best = -1;
    let hit = '';
    for (let i = 0; i < list.length; i++) {
      const at = low.indexOf(list[i].toLowerCase());
      if (at >= 0 && (best < 0 || at < best)) { best = at; hit = list[i]; }
    }
    return best < 0 ? null : { index: best, marker: hit };
  }

  /** 去掉 think 块：没有开标记却先出现结束符时，前面那段也算推理（站点只给结束符）。 */
  function stripThink(text) {
    let rest = String(text || '');
    let out = '';
    for (let guard = 0; guard < 50; guard++) {
      const close = firstOf(rest, CLOSERS);
      const open = firstOf(rest, OPENERS);
      if (open && (!close || open.index < close.index)) {
        out += rest.slice(0, open.index);
        rest = rest.slice(open.index + open.marker.length);
        const c2 = firstOf(rest, CLOSERS);
        rest = c2 ? rest.slice(c2.index + c2.marker.length) : '';
        continue;
      }
      if (close) { rest = rest.slice(close.index + close.marker.length); continue; }
      out += rest;
      break;
    }
    return out.replace(/^\s+/, '');
  }
  T.stripThink = stripThink;

  function errText(e) {
    return String((e && e.message) || e || '').slice(0, ERR_MAX);
  }

  /** 读配置（与 ai.js 同一条归一：Config.merge → normalize；这里只要 ai 那一段）。 */
  async function readAi() {
    let all = {};
    try { all = await chrome.storage.local.get(null); } catch (e) { all = {}; }
    const C = (self.KH && self.KH.Config) || {};
    if (!C || typeof C.merge !== 'function') return {};
    const merged = C.merge(all || {});
    const normalized = (typeof C.normalize === 'function') ? C.normalize(merged).config : merged;
    return (normalized && normalized.ai) || {};
  }

  /* ---------------- 站点地址 ---------------- */

  let baseCache = { at: 0, base: '' };

  function allowedBase(base) {
    if (!base) return false;
    try {
      const u = new URL(base);
      if (u.protocol !== 'https:') return false;
      for (let i = 0; i < ALLOW.length; i++) {
        const host = ALLOW[i];
        if (u.hostname === host || u.hostname.slice(-(host.length + 1)) === ('.' + host)) return true;
      }
      return false;
    } catch (e) { return false; }
  }
  T.allowedBase = allowedBase;

  /**
   * 【2.0.16.1 · 用户 m18091】品牌域名 → 真实宿主。
   * 为什么必须用 GET 去跟：站点是 301，而 **POST 跟随 301 会被浏览器改成 GET**、
   * 请求体和 cookie 语义都会变 —— 所以先在站点的任意 GET 上问出最终 origin，再拿它发真请求。
   * 跟到的 origin 仍要过白名单（重定向到别处就作废，绝不把用户消息送到白名单之外）。
   * @param {string} base 已过白名单的站点地址
   * @returns {Promise<string>} 真实 origin（不带尾斜杠）
   */
  async function resolveRedirect(base) {
    try { if (new URL(base).hostname === CANON_HOST) return base; } catch (e) { return base; }
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, APP_URL_TIMEOUT);
    try {
      res = await fetch(base + '/', { method: 'GET', redirect: 'follow', credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      return base;                       /* 跟不动就按原地址试，不让跟随失败挡住登录 */
    }
    clearTimeout(timer);
    let origin = '';
    try { origin = new URL(res && res.url ? res.url : base).origin; } catch (e) { origin = ''; }
    if (!origin || origin === base) return base;
    if (!allowedBase(origin)) throw new Error('站点跳转到了白名单之外（' + origin + '）');
    return origin;
  }
  T.resolveRedirect = resolveRedirect;

  async function resolveBase(force) {
    const ai = await readAi();
    const manual = String((ai.taiji && ai.taiji.base) || '').trim();
    if (!force && baseCache.base && (Date.now() - baseCache.at) < 10 * 60 * 1000) return baseCache.base;
    if (manual && allowedBase(manual)) {
      const real = await resolveRedirect(manual);
      baseCache = { at: Date.now(), base: real };
      return real;
    }
    let txt = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, APP_URL_TIMEOUT);
      const res = await fetch(APP_URL, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      txt = String(await res.text()).trim();
    } catch (e) {
      throw new Error('取站点地址失败（' + errText(e) + '）');
    }
    if (!/^https:\/\//i.test(txt)) throw new Error('取站点地址失败（app-url.txt 不是 https 地址）');
    const candidate = txt.replace(/\/+$/, '').split(/\s+/)[0];
    if (!allowedBase(candidate)) throw new Error('站点地址不在白名单（' + candidate + '）');
    baseCache = { at: Date.now(), base: candidate };
    return candidate;
  }

  /* ---------------- 请求 ---------------- */

  /**
   * 发一个站点 API 请求。
   * 关键：credentials:'include' —— 登录拿到的会话就在浏览器 cookie 里，
   * 我们不读也不存 cookie 值（扩展读不到 Set-Cookie，也不需要）。
   */
  async function api(path, opt) {
    const o = opt || {};
    const base = await resolveBase(o.forceBase);
    const url = base + path;
    const ctrl = new AbortController();
    const idle = Number(o.idleMs) > 0 ? Number(o.idleMs) : IDLE_MS;
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, idle);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let res;
    try {
      res = await fetch(url, {
        method: o.method || 'GET',
        headers: headers,
        body: o.body ? JSON.stringify(o.body) : undefined,
        credentials: 'include',
        cache: 'no-store',
        signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
      throw new Error(aborted ? ('站点 ' + Math.round(idle / 1000) + ' 秒没响应') : ('站点请求没发出去：' + errText(err)));
    }
    return { res: res, url: url, clear: function () { clearTimeout(timer); } };
  }

  async function readJson(out) {
    let text = '';
    try { text = await out.res.text(); } catch (e) { text = ''; }
    out.clear();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!out.res.ok && (!json || json.code === undefined)) {
      throw new Error('站点 HTTP ' + out.res.status + '（' + String(text || '').slice(0, ERR_MAX) + '）');
    }
    return json || {};
  }

  /**
   * 模型清单归一：站点可能回字符串，也可能回对象；统一成 {id, name}。
   * 【2.0.16.2 · 用户实测】站点 `/api/chat/tmpl` 的真实形状是 `{label:'GPT-6.2-sol', value:'openai::gpt-6.2-sol', attr:{modelType:'chat'}}`
   * —— 旧实现只认 `model|id|name`，`value` 读不到 ⇒ 167 个模型全被丢掉，设置页显示「没有可用模型」。
   * 顺带按 `attr.modelType` 剔掉生图/嵌入类：它们进对话列表只会在发消息时失败。
   */
  function normModels(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      let id = '';
      let name = '';
      if (typeof m === 'string') { id = m; name = m; }
      else if (m && typeof m === 'object') {
        /* `value` 是站点真实模型 id（openai::gpt-6.2-sol），`label` 是给人看的名字 */
        id = String(m.value || m.model || m.id || m.name || '').trim();
        name = String(m.label || m.name || m.title || id).trim();
        const kind = String((m.attr && m.attr.modelType) || m.modelType || '').toLowerCase();
        if (kind && kind !== 'chat') continue;
      }
      if (!id) continue;
      out.push({ id: id, name: name || id });
    }
    return out;
  }
  T.normModels = normModels;

  async function tmplRaw(forceBase) {
    const out = await api('/api/chat/tmpl', { forceBase: forceBase });
    const json = await readJson(out);
    if (json.code !== 0) {
      const err = new Error(json.msg || json.message || ('站点返回 code=' + json.code));
      err.needLogin = (json.code === 401 || json.code === 403 || /登录|未授权|token/i.test(String(err.message)));
      throw err;
    }
    return normModels(json.data && json.data.models);
  }

  /** 【2.0.16.1】当前真实站点（品牌域名已跟到真实 origin）；拿不到就给空串，绝不因此让登录失败。 */
  async function baseNow() {
    try { return await resolveBase(); } catch (e) { return ''; }
  }

  /* ---------------- 对外：登录 / 模型 / 对话 ---------------- */

  /** 设置页「登录」：账号密码只用这一次，成功后会话留在浏览器 cookie 里。 */
  T.login = async function (msg) {
    const account = String((msg && msg.account) || '').trim();
    const password = String((msg && msg.password) || '');
    if (!account) return { ok: false, error: '请填账号' };
    if (!password) return { ok: false, error: '请填密码' };
    try {
      const out = await api('/api/user/login', { method: 'POST', body: { account: account, password: password } });
      const json = await readJson(out);
      if (json.code !== 0) {
        return { ok: false, error: '登录失败：' + String(json.msg || json.message || ('code=' + json.code)).slice(0, ERR_MAX) };
      }
      const models = await tmplRaw();
      return { ok: true, models: models, base: await baseNow() };
    } catch (err) {
      return { ok: false, error: '登录失败：' + errText(err) };
    }
  };

  /** 看当前会话还能不能用 + 拿模型清单（设置页打开时刷一次）。 */
  T.models = async function () {
    try {
      const models = await tmplRaw();
      return { ok: true, models: models, base: await baseNow() };
    } catch (err) {
      return { ok: false, needLogin: !!err.needLogin, error: errText(err) };
    }
  };

  async function createSession(model, forceBase) {
    const out = await api('/api/chat/session', { method: 'POST', body: { model: model }, forceBase: forceBase });
    const json = await readJson(out);
    const id = json && json.data && json.data.id;
    if (json.code !== 0 || !id) throw new Error('站点建会话失败（code=' + (json.code == null ? '?' : json.code) + '）');
    return String(id);
  }

  /** 把对话数组压成站点要的一整段 text（站点只收 text，不收 messages）。 */
  function flatten(messages) {
    const parts = [];
    if (!Array.isArray(messages)) return '';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] || {};
      const content = String(m.content == null ? '' : m.content).trim();
      if (!content) continue;
      if (m.role === 'system') parts.unshift(content);
      else if (m.role === 'assistant') parts.push('（上文回答）' + content);
      else parts.push(content);
    }
    return parts.join('\n\n').slice(0, 12000);
  }
  T.flatten = flatten;

  /** 读 SSE：每行 data: {...}；type=string 是增量，type=object 是汇总（aiText/用量）。 */
  async function readStream(out) {
    const ctype = String((out.res.headers && out.res.headers.get('content-type')) || '');
    if (!ctype.includes('event-stream')) {
      const json = await readJson(out);
      if (json.code !== 0 && json.code !== undefined) throw new Error('站点返回错误 code=' + json.code);
      const txt = stripThink(String((json.data && json.data.aiText) || ''));
      return { text: txt, usage: null };
    }
    const reader = out.res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let usage = null;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        buf = buf.replace(/\r\n/g, '\n');
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 2);
          if (!chunk) continue;
          const lines = chunk.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.indexOf('data:') !== 0) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let j = null;
            try { j = JSON.parse(payload); } catch (e) { continue; }
            if (j.code !== undefined && j.code !== 0) {
              const e = new Error('站点流错误 code=' + j.code);
              /* 401/403 = 会话过期：上层据此提示「到设置页重新登录」，别只说「站点流错误」。 */
              e.needLogin = (j.code === 401 || j.code === 403);
              throw e;
            }
            if (j.type === 'string' && typeof j.data === 'string') {
              full += j.data;
              if (full.length > MAX_REPLY * 4) throw new Error('站点回复过长，已截断');
            } else if (j.type === 'object' && j.data && typeof j.data === 'object') {
              if (j.data.aiText && !full) full = String(j.data.aiText);
              usage = {
                prompt_tokens: j.data.promptTokens || 0,
                completion_tokens: j.data.completionTokens || 0,
                total_tokens: j.data.useTokens || 0
              };
            }
          }
        }
      }
    } finally {
      try { out.clear(); } catch (e) { /* ignore */ }
    }
    return { text: stripThink(full), usage: usage };
  }

  /**
   * 发一次对话（面板 AI 分页与设置页「测试连接」共用这一条）。
   * msg: {messages?, model?, override?, timeoutMs?}
   * 回执：{ok:true, text, usage} | {ok:false, error}
   */
  T.chat = async function (msg) {
    const payload = msg || {};
    const ai = await readAi();
    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };
    const tj = ai.taiji || {};
    const override = (payload.override && typeof payload.override === 'object') ? payload.override : {};
    const model = String(override.model || payload.model || tj.model || '').trim();
    try {
      let useModel = model;
      if (!useModel) {
        const list = await tmplRaw();
        if (!list.length) return { ok: false, error: '站点没有回可用模型（先在设置页点「刷新模型」）' };
        useModel = list[0].id;
      }
      const text = flatten(Array.isArray(payload.messages) ? payload.messages : []);
      if (!text) return { ok: false, error: '没有要发送的内容' };
      const sid = await createSession(useModel);
      const out = await api('/api/chat/completions', {
        method: 'POST',
        body: { text: text, sessionId: sid, model: useModel },
        idleMs: Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : IDLE_MS
      });
      const got = await readStream(out);
      if (!got.text) return { ok: false, error: '站点没有返回内容' };
      return { ok: true, text: got.text.slice(0, MAX_REPLY), usage: got.usage };
    } catch (err) {
      const needLogin = !!(err && err.needLogin);
      const extra = needLogin ? '（会话失效，请到设置页重新登录）' : '';
      /* needLogin 要回给面板：它据此把「去登录」按钮改成指向设置页。 */
      return { ok: false, needLogin: needLogin, error: errText(err) + extra };
    }
  };

  /** 设置页「测试连接」：发一句最短的话，确认整条链路（会话 + 流式）真的通。 */
  T.test = function (override) {
    return T.chat({ messages: [{ role: 'user', content: '你好' }], override: override || null, timeoutMs: 30000 });
  };

  /* ---------------- 法人检索兜底 ---------------- */

  const REP_PROMPT = [
    '你只做一件事：根据公司名给出它的法定代表人姓名。',
    '要求：只输出姓名本身（2~5 个汉字，名字中间可以有「·」），不要输出任何解释、标点或前缀。',
    '如果你不确定这家公司或它的法定代表人，就只输出四个字：不确定。'
  ].join('\n');

  /** 从模型回复里抠出人名（容忍「答案是：张三」「张三。」这类包装）。 */
  function pickName(reply) {
    const raw = String(reply || '').trim();
    if (!raw || /不确定|不知道|无法确认|查不到/.test(raw.slice(0, 40))) return '';
    const m = raw.match(/[\u4e00-\u9fa5]{1,8}·[\u4e00-\u9fa5]{1,8}|[\u4e00-\u9fa5]{2,5}/g);
    if (!m || !m.length) return '';
    for (let i = 0; i < m.length; i++) {
      const cand = m[i];
      if (/法定代表人|公司|有限|集团|企业|不确定|答案|姓名|法人/.test(cand)) continue;
      return cand;
    }
    return '';
  }
  T.pickName = pickName;

  /**
   * 用模型补法人检索：只在本地三条通道（搜狗/爱企查/360）都没结论时调用。
   * 返回 {ok:true, rep} 或 {ok:false, error}；人名格式由 entity.js 用 personOk 再验一次。
   */
  T.repOf = async function (name, timeoutMs) {
    const company = String(name || '').trim();
    if (!company) return { ok: false, error: '公司名为空' };
    const ai = await readAi();
    if (!ai || ai.enabled === false) return { ok: false, error: 'AI 助手已关闭' };
    const res = await T.chat({
      messages: [{ role: 'system', content: REP_PROMPT }, { role: 'user', content: '公司名：' + company }],
      /* 它是第四条通道、和本地三家并发跑：给个上限，别把面板 20 秒的等待吃满。 */
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000
    });
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'AI 没返回' };
    const rep = pickName(res.text);
    if (!rep) return { ok: false, error: 'AI 没给出确定的人名' };
    return { ok: true, rep: rep };
  };

  self.KhTaiji = T;
})();
