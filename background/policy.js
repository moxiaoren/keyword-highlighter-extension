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
 * 口径与已知限制（都要在悬停里如实写出来，不许假装成功）：
 *   · 只抓 HTML 正文文字，不执行页面脚本 —— JS 渲染出来的政策、登录后才可见的政策抓不到；
 *   · PDF / 图片形式的政策抓不到（如实返回 ok:false + 原因）；
 *   · 抓回来的是**整页文字**（含导航），匹配用子串，所以多出来的导航文字不影响判定；
 *   · 不猜、不补：抓不到就返回失败，由面板退回「卡片抓取值」并在悬停里写明。
 * ========================================================================= */
'use strict';

(function () {
  const Policy = {};
  const CACHE_KEY = 'khPolicyCache';
  const TTL_MS = 7 * 24 * 3600 * 1000;
  const MAX_ENTRIES = 80;
  const MAX_HTML = 400000;
  const MAX_TEXT = 120000;
  const TIMEOUT_MS = 12000;
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

  /* ---------------- 网络 ---------------- */

  function getPage(url) {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, TIMEOUT_MS) : 0;
    return fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
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
      const raw = await res.text();
      return { type: type, html: String(raw || '').slice(0, MAX_HTML) };
    }).catch((err) => {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      throw new Error(aborted ? '请求超时' : ('请求没发出去：' + String((err && err.message) || err)));
    });
  }

  /**
   * @param {string} url 隐私政策链接
   * @returns {Promise<{ok:boolean, text?:string, len?:number, reason?:string, cached?:boolean, url:string}>}
   */
  Policy.fetchText = async function (url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, reason: '不是 http(s) 链接' };
    const cache = await loadCache();
    const hit = cache[u];
    if (hit && hit.at && (Date.now() - hit.at) < TTL_MS) {
      return { ok: !!hit.ok, text: hit.text || '', len: hit.len || 0, reason: hit.reason || '', cached: true, url: u };
    }
    let out;
    try {
      const page = await getPage(u);
      if (page.type.indexOf('pdf') >= 0) {
        out = { ok: false, reason: '链接是 PDF，读不出文字' };
      } else if (page.type && page.type.indexOf('html') < 0 && page.type.indexOf('text/plain') < 0) {
        out = { ok: false, reason: '链接不是网页（' + page.type + '）' };
      } else {
        const text = (page.type.indexOf('text/plain') >= 0 ? page.html : Policy.stripHtml(page.html)).slice(0, MAX_TEXT);
        out = text.replace(/\s/g, '').length >= 40
          ? { ok: true, text: text, len: text.length }
          : { ok: false, reason: '页面里没读到正文（可能需要登录或脚本渲染）' };
      }
    } catch (err) {
      out = { ok: false, reason: String((err && err.message) || err) };
    }
    cache[u] = { at: Date.now(), ok: !!out.ok, text: out.text || '', len: out.len || 0, reason: out.reason || '' };
    saveCache(cache);
    return Object.assign({ url: u, cached: false }, out);
  };

  self.KH = self.KH || {};
  self.KH.Policy = Policy;
})();
