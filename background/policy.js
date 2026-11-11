/**
 * background/policy.js · 【2.0.8.15 需求①】把「隐私政策链接」的正文抓回来
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-09）：「我打开链接看隐私政策正文也确实有这两个内容，为什么还是判断
 * 为隐私政策内没有。」——因为此前扩展只拿卡片里抓到的**那一格文字**去比，从没打开过链接。
 * 卡片那一格常常只是「隐私政策」四个字、一个 URL、或一小段摘要，真正文在链接后面。
 *
 * 为什么放在 background：内容脚本里的 fetch 按**页面来源**走 CORS，隐私政策站点不会给
 * 任意商店页放行；service worker 是扩展来源 + `host_permissions:<all_urls>`，才发得出去，
 * 且同一份政策（很多卡片共用）能落 `chrome.storage.local` 缓存，不必每次刷新都重抓。
 *
 * 【2.0.8.22】用户又报了 5 个「打开链接明明有、插件说没有」的站，分三类病根：
 *   ① 静态 HTML 只是空壳 / 模板占位（Vue/React、`${appName}` 由 JS 填）：
 *      正文只有真渲染后才有 ⇒ 静态结果「短」或「缺目标词」时升级到后台标签页，
 *      并且在 complete 之后**继续轮询**（有的站 complete 时 JS 还没跑完，首抓是空串）；
 *   ② 正文根本不在 DOM 里，而是页面再向**同源接口**要数据（`/api/privacy-config/by-app-id?app_id=255`）：
 *      标签页也读不到时，从 HTML 里认出这类接口模板，用页面 URL 上的同名参数填好再 GET 一次，
 *      把 JSON 里的字符串并进正文；
 *   ③ 链接被浏览器强制升级协议 / 证书错误，标签页打开是错误页：
 *      静态 HTML 通常还能抓到，接口兜底也还能用 —— 不许因为标签页失败就丢掉已有正文。
 * 另外补了**编码识别**：GBK/GB2312 站点按 UTF-8 解会整片乱码，正文再长也匹配不上。
 *
 * 口径与已知限制（都要在悬停里如实写出来，不许假装成功）：
 *   · 优先 HTML 正文文字；需要时才真开一张后台标签页（active:false，不抢前台）；
 *   · PDF / 图片形式的政策抓不到（如实返回 ok:false + 原因）；
 *   · 同源接口只做 GET、只带页面 URL 上已有的参数，不猜参数、不跨域；
 *   · 抓回来的是**整页文字**（含导航），匹配用子串，所以多出来的导航文字不影响判定；
 *   · 不猜、不补：抓不到就返回失败，由面板退回「卡片抓取值」并在悬停里写明。
 * ========================================================================= */
'use strict';

(function () {
  const Policy = {};
  /* 缓存键升版：旧键里可能存着「模板正文/空壳」且 TTL 7 天，换了抓取策略也不能被它粘住。 */
  const CACHE_KEY = 'khPolicyCacheV2';
  const TTL_MS = 7 * 24 * 3600 * 1000;
  /* 失败只记 1 小时：站点临时抽风/证书恢复后不该锁用户 7 天。 */
  const TTL_FAIL_MS = 60 * 60 * 1000;
  /* 缓存正文没覆盖这次的目标词（页面可能更新了）时，10 分钟内不重复升级重抓，避免刷屏打站点。 */
  const RETRY_MS = 10 * 60 * 1000;
  const MAX_ENTRIES = 80;
  const MAX_HTML = 400000;
  const MAX_TEXT = 120000;
  const TIMEOUT_MS = 12000;
  const MIN_TEXT = 40;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  const ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
    mdash: '—', ndash: '–', middot: '·', copy: '©', reg: '®',
    times: '×', divide: '÷', ensp: ' ', emsp: ' ', thinsp: ' '
  };

  function decodeEntities(s) {
    return String(s || '')
      /* 数字实体（含十六进制）：不认识的落回空串，不要留下 `&#123;` 噪声 */
      .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
        const code = parseInt(hex, 16);
        return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      })
      .replace(/&#(\d+);/g, (m, dec) => {
        const code = parseInt(dec, 10);
        return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      })
      .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
      });
  }

  /** HTML → 可读文字：先摘掉不参与正文的节点，再把块级标签换成换行（行内标签直接去掉）。 */
  Policy.stripHtml = function (html) {
    let s = String(html || '');
    /* 注释 / 脚本 / 样式 / noscript / 模板 / svg：内容一律不是「正文」 */
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    s = s.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*\/?>/gi, ' ');
    /* 块级与换行标签：留一个换行，避免相邻两段粘成一个词 */
    s = s.replace(/<\s*(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<\/\s*(p|div|li|tr|h[1-6]|section|article|header|footer|table|thead|tbody|blockquote|pre|dd|dt|ul|ol)\s*>/gi, '\n');
    /* 其余标签一律去掉（行内标签两侧不加空格：中文正文里加空格反而会切断词） */
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    /* 连续空白压成一个空格；连续空行压成一个换行 */
    s = s.replace(/[\u00a0\u3000]/g, ' ').replace(/[ \t\f\v]+/g, ' ');
    s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  };

  /* ---------------- 归一：判定层怎么比，这里就怎么比（只保留够用的最小版本） ---------------- */

  /**
   * 与 src/features/note-check.js 的 `flat()` 同口径：去空白/零宽、全角 ASCII 折半角、小写。
   * 后台不能 import 内容脚本模块（MV3 两个世界），所以这里留一份**只用于判断「够不够长/有没有覆盖目标词」**
   * 的简化版；真正给用户看的判定仍走 note-check，不在这里下结论。
   */
  function flatLite(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000\u200b-\u200f\u2060\ufeff]/g, ' ')
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /** 这次抓回来的正文是否已经包含调用方关心的每个词（最多 4 个，够长才算）。 */
  function covers(text, hints) {
    const h = flatLite(text);
    const list = (hints || []).map((x) => flatLite(x)).filter((x) => x.length >= 2);
    if (!list.length) return true;
    for (let i = 0; i < list.length; i++) if (h.indexOf(list[i]) < 0) return false;
    return true;
  }

  /* ---------------- 缓存 ---------------- */

  function loadCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(CACHE_KEY, (res) => {
          const map = (res && res[CACHE_KEY]) || {};
          resolve(map && typeof map === 'object' ? map : {});
        });
      } catch (e) { resolve({}); }
    });
  }

  function saveCache(map) {
    try {
      const keys = Object.keys(map);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
        for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete map[keys[i]];
      }
      chrome.storage.local.set({ [CACHE_KEY]: map });
    } catch (e) { /* 缓存写失败不影响本次结果 */ }
  }

  /* ---------------- 编码：GBK 站按 UTF-8 解会整片乱码 ---------------- */

  /** 从 Content-Type 或 `<meta charset>` 认字符集（只读前 4KB 的 ASCII 线索）。 */
  function sniffCharset(type, bytes) {
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(String(type || ''));
    if (m) return String(m[1]).toLowerCase();
    let head = '';
    const n = Math.min(bytes.length, 4096);
    for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
    const m2 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    return m2 ? String(m2[1]).toLowerCase() : 'utf-8';
  }

  function decodeBytes(buf, type) {
    let bytes;
    try { bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf); } catch (e) { bytes = null; }
    if (!bytes) return '';
    let cs = sniffCharset(type, bytes);
    /* gb2312 / gbk 一律按超集 gb18030 解，避免生僻字变问号。 */
    if (/^(gb2312|gbk|x-gbk|gb18030)$/i.test(cs)) cs = 'gb18030';
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) { return ''; }
    }
  }

  /* ---------------- 网络 ---------------- */

  /** 读响应体：有 arrayBuffer 就按字节解（能认编码），单测桩只给 text 时退回 text。 */
  async function readBody(res, type) {
    if (res && typeof res.arrayBuffer === 'function') {
      let buf = null;
      try { buf = await res.arrayBuffer(); } catch (e) { buf = null; }
      if (buf) {
        const decoded = decodeBytes(buf, type);
        if (decoded) return decoded;
      }
    }
    try { return String((await res.text()) || ''); } catch (e) { return ''; }
  }

  function getPage(url) {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, TIMEOUT_MS) : 0;
    return fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(async (res) => {
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      const raw = await readBody(res, type);
      return { type: type, html: String(raw || '').slice(0, MAX_HTML) };
    }).catch((err) => {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      throw new Error(aborted ? '请求超时' : ('请求没发出去：' + String((err && err.message) || err)));
    });
  }

  /* ---------------- 兜底①：后台标签页读「渲染后的正文」 ----------------
   * 为什么需要：有些站点的 WAF / 证书链 / 只认真实导航，service worker 的 fetch 会直接
   * 抛 `failed to fetch`（用户 2026-11-09 实测就是这个），但用标签页打开一切正常；
   * 另外 JS 渲染出来的正文只有真导航之后才存在，而且 **complete 时脚本不一定跑完**
   * （用户 2026-11-11 的 toutiao 案例：complete 首抓是 0 字，几秒后才是 2.2 万字）。
   * 所以 complete 只当作「可以开始抓」，空白就继续轮询；读到就停、超时就关。
   * 代价：会短暂开一张后台标签页（active:false），读完立刻关掉；
   * 不抢前台、不改用户当前页。 */
  function readViaTab(url, hints) {
    return new Promise((resolve) => {
      const tabs = (typeof chrome !== 'undefined' && chrome.tabs) || null;
      const scripting = (typeof chrome !== 'undefined' && chrome.scripting) || null;
      if (!tabs || !tabs.create || !scripting || !scripting.executeScript) {
        resolve({ ok: false, reason: '这个浏览器不支持后台标签页读取（缺 tabs/scripting 能力）' });
        return;
      }
      let tabId = 0;
      let done = false;
      let timer = 0;
      let attempts = 0;
      let best = '';
      /* complete 之后：空白多等一会儿（脚本可能还在跑），有字但缺目标词只再补两三下。 */
      const MAX_EMPTY = 9;
      const MAX_PARTIAL = 3;
      const INTERVAL = 700;
      const finish = (out) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { tabs.onUpdated.removeListener(onUpdated); } catch (e) { /* ignore */ }
        if (tabId) {
          try {
            const r = tabs.remove(tabId);
            if (r && typeof r.catch === 'function') r.catch(() => {});
          } catch (e) { /* 已经关了 */ }
        }
        resolve(out);
      };
      const enough = () => flatLite(best).length >= MIN_TEXT && covers(best, hints);
      const settle = () => {
        if (done) return;
        if (flatLite(best).length >= MIN_TEXT) {
          finish({ ok: true, text: best.slice(0, MAX_TEXT), len: best.length });
          return;
        }
        finish({ ok: false, reason: '后台标签页打开后也没读到正文（可能需要登录，或正文是图片/PDF）' });
      };
      const schedule = () => {
        if (done) return;
        const blank = flatLite(best).length === 0;
        const limit = blank ? MAX_EMPTY : MAX_PARTIAL;
        if (attempts >= limit || Date.now() > deadline) { settle(); return; }
        attempts++;
        timer = setTimeout(() => { if (!done) grab(); }, INTERVAL);
      };
      const deadline = Date.now() + 10000;
      const grab = () => {
        if (done) return;
        let p;
        try {
          p = scripting.executeScript({
            target: { tabId: tabId },
            func: function () { return (document.body && document.body.innerText) || ''; }
          });
        } catch (e) {
          finish({ ok: false, reason: '后台标签页读取失败：' + String((e && e.message) || e) });
          return;
        }
        Promise.resolve(p).then((res) => {
          const text = (res && res[0] && typeof res[0].result === 'string') ? res[0].result : '';
          /* 只留最长的：SPA 首帧可能只有导航壳，后续帧才是正文。 */
          if (flatLite(text).length > flatLite(best).length) best = text;
          if (enough()) { finish({ ok: true, text: best.slice(0, MAX_TEXT), len: best.length }); return; }
          schedule();
        }, (e) => {
          /* 错误页（协议被升级 / 证书）注入会直接失败：这时不要傻等。 */
          finish({ ok: false, reason: '后台标签页读不到正文（' + String((e && e.message) || e) + '）' });
        });
      };
      const onUpdated = (id, info) => {
        if (id !== tabId || !info) return;
        if (info.status === 'complete') grab();
      };
      try { tabs.onUpdated.addListener(onUpdated); } catch (e) { finish({ ok: false, reason: '监听标签页失败：' + String((e && e.message) || e) }); return; }
      timer = setTimeout(() => finish({ ok: false, reason: '后台标签页 15 秒没加载完' }), 15000);
      try {
        const created = tabs.create({ url: url, active: false });
        Promise.resolve(created).then((tab) => {
          if (!tab || typeof tab.id !== 'number') { finish({ ok: false, reason: '后台标签页没建起来' }); return; }
          tabId = tab.id;
        }, (e) => finish({ ok: false, reason: '后台标签页没建起来：' + String((e && e.message) || e) }));
      } catch (e) {
        finish({ ok: false, reason: '后台标签页没建起来：' + String((e && e.message) || e) });
      }
    });
  }

  /* ---------------- 兜底②：同源接口兜底 ----------------
   * 有些政策页自己也不含正文：HTML 里只有一段模板
   *   `const apiUrl = `${apiBaseUrl}/api/privacy-config/by-app-id?app_id=${appId}`;`
   * 正文由这个接口返回。标签页读完仍然缺目标词时，把这类模板认出来、用**页面 URL 上已有的**
   * 同名参数填好（appId / app_id / channelId 都认），同源 GET 一次，把 JSON 里的字符串并进正文。
   * 只做 GET、只带页面上已有的参数、只打同源 —— 不猜、不跨站。 */

  function originOf(u) {
    const m = /^(https?:\/\/[^\/?#]+)/i.exec(String(u || ''));
    return m ? m[1] : '';
  }

  /** 取页面 URL 的查询参数，键名归一成「小写、去下划线/连字符」。 */
  function paramsOf(u) {
    const out = {};
    const q = String(u || '').split('#')[0];
    const at = q.indexOf('?');
    if (at < 0) return out;
    const segs = q.slice(at + 1).split('&');
    for (let i = 0; i < segs.length; i++) {
      if (!segs[i]) continue;
      const eq = segs[i].indexOf('=');
      const k0 = eq < 0 ? segs[i] : segs[i].slice(0, eq);
      const v0 = eq < 0 ? '' : segs[i].slice(eq + 1);
      let k = k0;
      let v = v0;
      try { k = decodeURIComponent(k0); } catch (e) { /* 原样 */ }
      try { v = decodeURIComponent(v0.replace(/\+/g, ' ')); } catch (e) { /* 原样 */ }
      const nk = String(k).toLowerCase().replace(/[_\-\s]/g, '');
      if (nk && !Object.prototype.hasOwnProperty.call(out, nk)) out[nk] = v;
    }
    return out;
  }

  /** 把 `${appId}` / `${app_id}` 换成页面 URL 上的值；有一个填不上就整条放弃（不猜）。 */
  function fillTemplate(tpl, params) {
    let ok = true;
    const s = String(tpl).replace(/\$\{\s*([^}]*?)\s*\}/g, (m, name) => {
      const key = String(name).toLowerCase().replace(/[_\-\s]/g, '');
      if (Object.prototype.hasOwnProperty.call(params, key)) return encodeURIComponent(params[key]);
      ok = false;
      return '';
    });
    return ok ? s : null;
  }

  /** 从 HTML 里认接口路径（只要 `/api/...`，带不带查询串都行），最多 6 条。 */
  function apiCandidates(html, params) {
    const out = [];
    const re = /\/api\/[A-Za-z0-9_\-\/.]*(?:\?[^"'`\s<>\\]*)?/g;
    let m;
    let guard = 0;
    while ((m = re.exec(String(html || ''))) !== null && guard++ < 4000) {
      let cand = m[0];
      if (!cand || cand.length > 500) continue;
      if (cand.indexOf('${') >= 0) {
        const filled = fillTemplate(cand, params);
        if (!filled) continue;
        cand = filled;
      }
      if (out.indexOf(cand) < 0) out.push(cand);
      if (out.length >= 6) break;
    }
    return out;
  }

  /** JSON → 所有字符串值（含嵌套），一行一条；解析失败就原样返回。 */
  function collectStrings(v, out, depth) {
    if (out.length > 900 || depth > 6) return;
    if (v == null) return;
    if (typeof v === 'string') { const s = v.trim(); if (s) out.push(s); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return; }
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (let i = 0; i < v.length; i++) collectStrings(v[i], out, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const ks = Object.keys(v);
      for (let j = 0; j < ks.length; j++) collectStrings(v[ks[j]], out, depth + 1);
    }
  }

  function flattenJson(raw) {
    try {
      const data = JSON.parse(String(raw || ''));
      const out = [];
      collectStrings(data, out, 0);
      return out.join('\n').slice(0, 20000);
    } catch (e) {
      return String(raw || '').slice(0, 20000);
    }
  }

  async function probeApi(pageUrl, html, hints) {
    const origin = originOf(pageUrl);
    if (!origin) return '';
    const params = paramsOf(pageUrl);
    const cands = apiCandidates(html, params).slice(0, 4);
    if (!cands.length) return '';
    const parts = [];
    for (let i = 0; i < cands.length; i++) {
      const target = /^https?:\/\//i.test(cands[i]) ? cands[i] : (origin + cands[i]);
      /* 只打同源：页面里可能混着别的站的接口，不能拿用户请求去撞外站。 */
      if (originOf(target) !== origin) continue;
      try {
        const page = await getPage(target);
        const raw = page.html || '';
        const add = (/json/i.test(page.type) || /^\s*[\{\[]/.test(raw)) ? flattenJson(raw) : Policy.stripHtml(raw);
        if (flatLite(add).length >= 2) parts.push(add);
        if (hints.length && covers(parts.join('\n'), hints)) break;
      } catch (e) { /* 单个接口失败不影响其余 */ }
    }
    return parts.join('\n').slice(0, 20000);
  }

  /**
   * @param {string} url 隐私政策链接
   * @param {{hints?: string[]}} [opts] 这次要比对的词（主标题 / 开发者）；用来决定「抓到多深」
   * @returns {Promise<{ok:boolean, text?:string, len?:number, reason?:string, cached?:boolean, url:string, via:string}>}
   */
  Policy.fetchText = async function (url, opts) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, reason: '不是 http(s) 链接', via: 'fetch' };
    const hints = ((opts && opts.hints) || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4);

    const cache = await loadCache();
    const hit = cache[u];
    const now = Date.now();
    if (hit && hit.at && hit.ok && (now - hit.at) < TTL_MS) {
      const needMore = hints.length > 0 && !covers(hit.text || '', hints);
      /* 页面可能更新了：缓存正文没覆盖目标词时，10 分钟后重抓一次；期间先用旧正文（仍然比卡片值强）。 */
      if (!needMore || (now - hit.at) < RETRY_MS) {
        return { ok: true, text: hit.text || '', len: hit.len || 0, reason: '', cached: true, url: u, via: hit.via || 'fetch' };
      }
    } else if (hit && hit.at && !hit.ok && (now - hit.at) < TTL_FAIL_MS) {
      return { ok: false, text: '', len: 0, reason: hit.reason || '', cached: true, url: u, via: hit.via || 'fetch' };
    }

    let html = '';
    let text = '';
    let directErr = '';
    let hardReason = '';
    let via = 'fetch';

    try {
      const p = await getPage(u);
      html = p.html || '';
      if (p.type.indexOf('pdf') >= 0) {
        hardReason = '链接是 PDF，读不出文字';
      } else if (p.type && p.type.indexOf('html') < 0 && p.type.indexOf('text/plain') < 0) {
        hardReason = '链接不是网页（' + p.type + '）';
      } else {
        text = (p.type.indexOf('text/plain') >= 0 ? p.html : Policy.stripHtml(p.html)).slice(0, MAX_TEXT);
      }
    } catch (err) {
      directErr = String((err && err.message) || err);
    }

    const tabReasons = [];
    const thin = () => flatLite(text).length < MIN_TEXT;
    const missHints = () => hints.length > 0 && !covers(text, hints);

    /* 静态结果「太短」或「缺目标词」都升级：短 = 空壳/模板；缺词 = 正文可能是后填的。 */
    if (!hardReason && (thin() || missHints())) {
      const tab = await readViaTab(u, hints);
      if (tab.ok) {
        /* 渲染后的正文常常比静态模板「短」却才有真内容：命中目标词优先，长度只作次要判据。 */
        const tabCovers = hints.length > 0 && covers(tab.text, hints);
        if (tabCovers || flatLite(tab.text).length > flatLite(text).length) { text = tab.text; via = 'tab'; }
      } else {
        tabReasons.push(tab.reason || '后台标签页也没读到');
      }
    }

    /* 仍然不够：正文可能压根不在 DOM 里，而在同源接口的 JSON 里。 */
    if (!hardReason && html && (thin() || missHints())) {
      const extra = await probeApi(u, html, hints);
      if (extra) {
        text = (flatLite(text).length ? (text + '\n' + extra) : extra).slice(0, MAX_TEXT);
        via = (via === 'fetch') ? 'fetch+api' : (via + '+api');
      }
    }

    let out;
    if (hardReason) {
      out = { ok: false, reason: hardReason };
    } else if (flatLite(text).length < MIN_TEXT) {
      const bits = [];
      if (directErr) bits.push(directErr);
      bits.push('页面里没读到正文（可能需要登录或脚本渲染）');
      for (let i = 0; i < tabReasons.length; i++) bits.push('后台标签页：' + tabReasons[i]);
      out = { ok: false, reason: bits.join('；') };
    } else {
      out = { ok: true, text: text, len: text.length };
    }

    cache[u] = { at: Date.now(), ok: !!out.ok, text: out.text || '', len: out.len || 0, reason: out.reason || '', via: via };
    saveCache(cache);
    return Object.assign({ url: u, cached: false, via: via }, out);
  };

  self.KH = self.KH || {};
  self.KH.Policy = Policy;
})();
