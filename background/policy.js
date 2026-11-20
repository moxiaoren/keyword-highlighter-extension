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
  /* V3（2.0.12.2）：抓取策略改了（够长的模板页也要读渲染结果），旧缓存里可能粘着「模板正文」。 */
  const CACHE_KEY = 'khPolicyCacheV3';
  const TTL_MS = 7 * 24 * 3600 * 1000;
  /* 失败只记 1 小时：站点临时抽风/证书恢复后不该锁用户 7 天。 */
  /* 【2026-11-11】失败缓存从 1 小时缩到 10 分钟：协议/证书这类失败多半是瞬时的，
   * 修好后用户不该再等一小时才看到「其实能抓到」（sknow 案例里失败缓存正是「怎么改都没好」的一部分）。 */
  const TTL_FAIL_MS = 10 * 60 * 1000;
  /* 缓存正文没覆盖这次的目标词（页面可能更新了）时，10 分钟内不重复升级重抓，避免刷屏打站点。 */
  const RETRY_MS = 10 * 60 * 1000;
  const MAX_ENTRIES = 80;
  const MAX_HTML = 400000;
  const MAX_TEXT = 120000;
  const TIMEOUT_MS = 12000;
  const MIN_TEXT = 40;
  /* 【2026-11-11 sknow 案例】正文已经够长（>3000 字）时，个别提示词缺失（卡片标题有错别字、
   * 开发者写法不同）**不再升级去开后台标签页**：静态 HTML 里已经有整篇政策，开标签页既慢又会
   * 撞上 Chrome 的协议升级错误页，把「其实读到了」的结论污染成「没抓到」。 */
  const STRONG_TEXT = 3000;
  /* 【2.0.12.2】用户 2026-11-17 案例：ysxy.html?appName=…&appTheme=…
   * 静态 HTML 里「企业信息信用查询帮 / 上海昂思通…」出现 0 次，正文 7845 字全是模板；
   * 页内脚本 params.get('appName') → decodeURIComponent → 写进 DOM，渲染后正文里才有。
   * 所以「正文够长」不等于「内容齐」：HTML 里有从 URL 取参写 DOM 的痕迹时，值得开一次
   * 后台标签页读渲染结果（active:false，读完就关）。 */
  const PARAM_DRIVEN_RE = /(?:URLSearchParams|location\.search|location\.href|params\.get\s*\(|searchParams\.get\s*\()/i;
  function paramDriven(html, url) {
    if (String(url || '').indexOf('?') < 0) return false;
    return PARAM_DRIVEN_RE.test(String(html || ''));
  }
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

  /** 解出来有多少个 U+FFFD（替换字符）：用来判断「这个字符集猜错了」。 */
  function badCount(s) {
    let n = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xfffd) n++;
    return n;
  }

  function decodeBytes(buf, type) {
    let bytes;
    try { bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf); } catch (e) { bytes = null; }
    if (!bytes) return '';
    let cs = sniffCharset(type, bytes);
    /* gb2312 / gbk 一律按超集 gb18030 解，避免生僻字变问号。 */
    if (/^(gb2312|gbk|x-gbk|gb18030)$/i.test(cs)) cs = 'gb18030';
    const tryDecode = (name) => {
      try { return new TextDecoder(name).decode(bytes); } catch (e) { return null; }
    };
    let out = tryDecode(cs);
    if (out == null) out = tryDecode('utf-8') || '';
    /* 【2026-11-19 用户报障】OSS 上的 .txt 没有 charset、内容其实是 GBK：按 UTF-8 硬解
     * 出来是 7000 多个 U+FFFD，正文等于全丢（「画质猫」案例）。解出替换字符就按 GBK 再解一遍，
     * 谁坏得少用谁 —— 不认识字符集的站也救得回来。 */
    if (cs !== 'gb18030') {
      const bad = badCount(out);
      if (bad > 0) {
        const alt = tryDecode('gb18030');
        if (alt != null && badCount(alt) < bad) return alt;
      }
    }
    return out;
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

  /* ---------------- 协议回退（2026-11-11 sknow 案例） ----------------
   * 有的站只在 http 上能打开：直接导航 https 会撞证书错误（`ERR_TLS_CERT_ALTNAME_INVALID`），
   * Chrome 停在一张「此网站不支持安全连接」的错误页；而用户手里的链接常常是从地址栏复制来的
   * `https://…`。这时**不是站点没正文**，是协议用错了。两个协议都试一遍，谁读到正文用谁。 */
  const ERR_PAGE_RE = /^(chrome-error:\/\/|edge-error:\/\/|chrome:\/\/neterror|about:neterror)/i;

  function isErrorPageUrl(u) {
    return ERR_PAGE_RE.test(String(u || ''));
  }

  function otherScheme(u) {
    const m = /^(https?):\/\//i.exec(String(u || ''));
    if (!m) return '';
    return (m[1].toLowerCase() === 'http' ? 'https' : 'http') + String(u).slice(m[1].length);
  }

  /* ---------------- 兜底①：后台标签页读「渲染后的正文」 ----------------
   * 为什么需要：有些站点的 WAF / 证书链 / 只认真实导航，service worker 的 fetch 会直接
   * 抛 `failed to fetch`（用户 2026-11-09 实测就是这个），但用标签页打开一切正常；
   * 另外 JS 渲染出来的正文只有真导航之后才存在，而且 **complete 时脚本不一定跑完**
   * （用户 2026-11-11 的 toutiao 案例：complete 首抓是 0 字，几秒后才是 2.2 万字）。
   * 所以 complete 只当作「可以开始抓」，空白就继续轮询；读到就停、超时就关。
   * 代价：会短暂开一张后台标签页（active:false），读完立刻关掉；
   * 不抢前台、不改用户当前页。 */
  /** 同一个页面的两种写法（只看主机与路径，忽略协议与末尾斜杠）。 */
  function samePage(a, b) {
    const norm = (u) => {
      const m = /^(https?):\/\/([^\/?#]+)([^?#]*)/i.exec(String(u || ''));
      if (!m) return '';
      const host = m[2].toLowerCase().replace(/:80$|:443$/, '');
      const p = (m[3] || '/').replace(/\/+$/, '') || '/';
      return host + p;
    };
    const x = norm(a);
    return !!x && x === norm(b);
  }

  /* ---------------- 兜底①·b：复用用户已经开着的那张页 ----------------
   * 有的站只支持 http，Chrome 会把它升级成 https 并停在一张「此网站不支持安全连接」的
   * 拦截页上；这时**任何**程序化导航都过不去（拦截页也注入不了脚本）。
   * 但用户手动点过「继续访问网站」之后，那张页就是有正文的 —— 直接读它，不再开新页。 */
  async function readOpenTab(url, hints) {
    const tabs = (typeof chrome !== 'undefined' && chrome.tabs) || null;
    const scripting = (typeof chrome !== 'undefined' && chrome.scripting) || null;
    if (!tabs || !tabs.query || !scripting || !scripting.executeScript) return { ok: false };
    let list = null;
    try { list = await tabs.query({}); } catch (e) { return { ok: false }; }
    if (!Array.isArray(list)) return { ok: false };
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || typeof t.id !== 'number' || !samePage(t.url, url)) continue;
      let res = null;
      try {
        res = await scripting.executeScript({
          target: { tabId: t.id },
          func: function () { return (document.body && document.body.innerText) || ''; }
        });
      } catch (e) { continue; }
      const text = (res && res[0] && typeof res[0].result === 'string') ? res[0].result : '';
      if (flatLite(text).length >= MIN_TEXT) {
        return { ok: true, text: text.slice(0, MAX_TEXT), covers: hints.length > 0 && covers(text, hints) };
      }
    }
    return { ok: false };
  }

  /* 【2.0.14.4 · m12586 A 档】同一时刻只允许一张后台标签页：读完（成功/失败/超时）才轮到下一个。
   * 用户现场：同时触发几次「读取隐私政策」会连开好几张后台标签，页签栏一片闪、还互相抢执行机会。
   * 串行之后：任何时刻最多一张、读完立刻关，用户看到的就是「页签栏短暂闪一下」。 */
  let tabQueue = Promise.resolve();
  function readViaTab(url, hints) {
    const run = () => readViaTabOnce(url, hints);
    const next = tabQueue.then(run, run);
    tabQueue = next.then(() => null, () => null);
    return next;
  }

  function readViaTabOnce(url, hints) {
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
          /* 错误页（协议被升级 / 证书）注入会直接失败：这时不要傻等，并且明确告诉调用方
           * 「是错误页」，让它换另一个协议再试一次。 */
          const msg = String((e && e.message) || e);
          finish({
            ok: false,
            errorPage: /error page/i.test(msg),
            reason: '后台标签页读不到正文（' + msg + '）'
          });
        });
      };
      const onUpdated = (id, info) => {
        if (id !== tabId || !info) return;
        /* 协议被升级时标签页会停在 `chrome-error://chromewebdata/`：先于注入判定，
         * 这样调用方可以立刻换协议重试，而不是等 15 秒超时。 */
        if (info.url && isErrorPageUrl(info.url)) {
          finish({ ok: false, errorPage: true, reason: '浏览器把链接换成了另一个协议，打开的是错误页' });
          return;
        }
        if (info.status === 'complete') grab();
      };
      try { tabs.onUpdated.addListener(onUpdated); } catch (e) { finish({ ok: false, reason: '监听标签页失败：' + String((e && e.message) || e) }); return; }
      timer = setTimeout(() => finish({ ok: false, reason: '后台标签页 15 秒没加载完' }), 15000);
      try {
        const created = tabs.create({ url: url, active: false });
        Promise.resolve(created).then((tab) => {
          if (!tab || typeof tab.id !== 'number') { finish({ ok: false, reason: '后台标签页没建起来' }); return; }
          tabId = tab.id;
          if (tab.url && isErrorPageUrl(tab.url)) {
            finish({ ok: false, errorPage: true, reason: '浏览器把链接换成了另一个协议，打开的是错误页' });
          }
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

  /** 响应体是不是「JSON 字符串里装着 HTML」（163yu 回 application/json，body 却是整页网页）。 */
  function unwrapJsonHtml(raw) {
    const s = String(raw || '').trim();
    if (!s || (s.charAt(0) !== '"' && s.charAt(0) !== '{' && s.charAt(0) !== '[')) return '';
    try {
      const v = JSON.parse(s);
      if (typeof v === 'string' && /<\s*(?:!doctype|html|body|head|div|p|h1|meta)\b/i.test(v)) return v;
      if (v && typeof v === 'object') {
        const ks = ['html', 'content', 'body', 'data'];
        for (let i = 0; i < ks.length; i++) {
          const x = v[ks[i]];
          if (typeof x === 'string' && /<\s*(?:!doctype|html|body|div|p)\b/i.test(x)) return x;
        }
      }
    } catch (e) { /* 不是 JSON，交给原逻辑 */ }
    return '';
  }

  /** <script> 里的中文串并入正文（dengban 案例：正文全在脚本的对象字面量里）。 */
  function scriptStrings(html) {
    const src = String(html || '');
    const out = [];
    const seen = {};
    let size = 0;
    const blocks = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m;
    let guard = 0;
    while ((m = blocks.exec(src)) !== null && guard++ < 120) {
      const js = m[1] || '';
      /* 下限 2：产品名常常只有两个字（dengban 的「灯伴」），4 字起会把它们漏掉。 */
      const lits = /"((?:[^"\\\n]|\\.){2,400})"|'((?:[^'\\\n]|\\.){2,400})'/g;
      let q;
      let g2 = 0;
      while ((q = lits.exec(js)) !== null && g2++ < 400) {
        const raw = q[1] || q[2] || '';
        if (!/[\u4e00-\u9fa5]/.test(raw)) continue;
        const t = decodeEntities(raw
          .replace(/\\u([0-9a-fA-F]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\[nrt]/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'"));
        if (flatLite(t).length < 2 || seen[t]) continue;
        seen[t] = 1;
        out.push(t);
        size += t.length;
        if (size > 40000) return out.join('\n');
      }
    }
    return out.join('\n');
  }

  /** 页面里的 iframe 地址（suanya 案例：正文全在这个跨域 iframe 里，主文档一无所有）。 */
  function frameSources(html, pageUrl) {
    const src = String(html || '');
    const re = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    const out = [];
    let m;
    let guard = 0;
    while ((m = re.exec(src)) !== null && guard++ < 60) {
      let abs = '';
      try { abs = new URL(m[1], pageUrl).toString(); } catch (e) { abs = ''; }
      if (!/^https?:\/\//i.test(abs) || out.indexOf(abs) >= 0) continue;
      out.push(abs);
      if (out.length >= 3) break;
    }
    return out;
  }

  /** 拉 iframe 正文（扩展有 host 权限，不必去碰页面；跨域也能读）。命中目标词就停。 */
  async function readFrames(pageUrl, html, hints) {
    const list = frameSources(html, pageUrl);
    if (!list.length) return '';
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const page = await getPage(list[i]);
        const unwrapped = unwrapJsonHtml(page.html);
        const srcHtml = unwrapped || page.html || '';
        let body = (/json/i.test(page.type) && !unwrapped) ? flattenJson(srcHtml) : Policy.stripHtml(srcHtml);
        const extra = scriptStrings(srcHtml);
        if (extra && flatLite(body).length < STRONG_TEXT) body += '\n' + extra;
        if (flatLite(body).length >= 2) parts.push(body.slice(0, 60000));
        if (hints.length && covers(parts.join('\n'), hints)) break;
      } catch (e) { /* 单个 iframe 拉不到不影响主结论 */ }
    }
    return parts.join('\n');
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

    const alt = otherScheme(u);
    const order = [u];
    if (alt && alt !== u) order.push(alt);
    const tried = [];
    let pageUrl = u;

    /* 两个协议各试一次：http 站被浏览器升级成 https 时，https 会撞证书错误；
     * 反过来把 https 链接降成 http 也能救「只在 http 上活着」的老站点。
     * 一旦某个协议读到正文（≥ MIN_TEXT）就停，不拿后面的失败覆盖已有正文。 */
    for (let i = 0; i < order.length; i++) {
      const cu = order[i];
      tried.push(cu);
      try {
        const p = await getPage(cu);
        const isText = p.type.indexOf('text/plain') >= 0;
        const isJson = /json/i.test(p.type);
        const isHtml = !p.type || p.type.indexOf('html') >= 0;
        /* 【2.0.14】响应头说 JSON、body 其实是「JSON 字符串里装着整页 HTML」（163yu）：
         * 先拆包按 HTML 取正文；只有真 JSON 才按值压平 —— 否则整篇政策被当成「不是网页」丢掉。 */
        const unwrapped = isJson ? unwrapJsonHtml(p.html) : '';
        const srcHtml = unwrapped || p.html;
        let body = isText ? srcHtml : ((isJson && !unwrapped) ? flattenJson(srcHtml) : Policy.stripHtml(srcHtml));
        /* 正文全写在 <script> 里的站（dengban）：脚本里的中文串并入正文。 */
        if (isHtml || unwrapped) {
          const extra = scriptStrings(srcHtml);
          if (extra) body += '\n' + extra;
        }
        body = body.slice(0, MAX_TEXT);
        if (p.type.indexOf('pdf') >= 0) {
          if (!flatLite(text).length) hardReason = '链接是 PDF，读不出文字';
        } else if (!isText && !isJson && !isHtml) {
          if (!flatLite(text).length) hardReason = '链接不是网页（' + p.type + '）';
        } else if (flatLite(body).length > flatLite(text).length || (!html && (isHtml || !!unwrapped))) {
          /* 【2.0.14】主体是 <img>/<iframe>、静态文本为空时也要留住 html ——
           * 后面要靠它找 iframe 地址（suanya 案例：正文全在跨域 iframe 里）。 */
          if (flatLite(body).length > flatLite(text).length) text = body;
          html = srcHtml || '';
          pageUrl = cu;
        }
      } catch (err) {
        if (!directErr) directErr = String((err && err.message) || err);
      }
      if (flatLite(text).length >= MIN_TEXT) break;   // 这个协议已经读到正文
    }

    const tabReasons = [];
    let blockedByTls = false;
    const flatLen = () => flatLite(text).length;
    const thin = () => flatLen() < MIN_TEXT;
    const missHints = () => hints.length > 0 && !covers(text, hints);
    /* 「正文已经够长、只是缺个提示词」不再升级：卡片标题有错别字（红蜻挺/红蜻蜓）也会走到这里，
     * 而这时静态 HTML 里其实已经有整篇政策 —— 去开标签页纯属自找错误页。 */
    const needDeep = () => !hardReason && (thin() || (missHints() && (flatLen() < STRONG_TEXT || paramDriven(html, pageUrl))));

    /* 【2.0.14 方案 C】浏览器把 http 升级成 https、停在「不支持安全连接」错误页时，
     * 后台标签页一个字的正文都读不到（错误页注入不了，扩展也点不了它）。
     * 这里完全绕开标签页：直接用扩展 fetch 抓 http 版，并把脚本中文串、跨域 iframe 一起并进来。 */
    const httpAltOf = (x) => /^https:\/\//i.test(String(x || '')) ? 'http://' + String(x).slice(8) : '';
    const httpFallback = async (x) => {
      const cand = httpAltOf(x);
      if (!cand) return null;
      if (tried.indexOf(cand) < 0) tried.push(cand);
      let p;
      try { p = await getPage(cand); } catch (e) { return null; }
      const isText = p.type.indexOf('text/plain') >= 0;
      const isJson = /json/i.test(p.type);
      const isHtml = !p.type || p.type.indexOf('html') >= 0;
      if (!isText && !isJson && !isHtml) return null;
      const unwrapped = isJson ? unwrapJsonHtml(p.html) : '';
      const srcHtml = unwrapped || p.html;
      let body = isText ? srcHtml : ((isJson && !unwrapped) ? flattenJson(srcHtml) : Policy.stripHtml(srcHtml));
      if (isHtml || unwrapped) {
        const extra = scriptStrings(srcHtml);
        if (extra) body += '\n' + extra;
      }
      const framed = await readFrames(cand, srcHtml, hints);
      if (framed) body += '\n' + framed;
      return { text: body.slice(0, MAX_TEXT), url: cand };
    };

    /* 静态结果「太短」或「缺目标词且正文不长」才升级：短 = 空壳/模板；缺词 = 正文可能是后填的。
     * 标签页落在错误页时，换另一个协议再试一次（sknow：https 证书错误、http 才有正文）。 */
    if (needDeep()) {
      const tabOrder = [pageUrl].concat(order.filter((x) => x !== pageUrl));
      for (let i = 0; i < tabOrder.length; i++) {
        const cu = tabOrder[i];
        if (tried.indexOf(cu) < 0) tried.push(cu);
        const tab = await readViaTab(cu, hints);
        if (tab.ok) {
          /* 渲染后的正文常常比静态模板「短」却才有真内容：命中目标词优先，长度只作次要判据。 */
          const tabCovers = hints.length > 0 && covers(tab.text, hints);
          if (tabCovers || flatLite(tab.text).length > flatLen()) { text = tab.text; via = 'tab'; }
          break;
        }
        tabReasons.push((cu === u ? '' : '换 ' + cu.split(':')[0] + ' 后 ') + (tab.reason || '后台标签页也没读到'));
        /* 错误页（多半是 https 证书拦截）：先看用户是不是已经把这张页打开、点过「继续访问」了 —— 读那张。 */
        if (tab.errorPage) {
          const share = await readOpenTab(cu, hints);
          if (share.ok) {
            text = share.text;
            via = 'tab';
            tabReasons.pop();
            break;
          }
          blockedByTls = true;
          /* 方案 C：别让用户去点错误页 —— 直接抓 http 版正文。 */
          const fb = await httpFallback(cu);
          if (fb && (covers(fb.text, hints) || flatLite(fb.text).length > flatLen())) {
            text = fb.text;
            via = 'fetch+http';
            pageUrl = fb.url;
            break;
          }
        }
        /* 只有「错误页」才值得换协议重试；登录墙/空壳换协议也一样。 */
        if (!tab.errorPage) break;
      }
    }

    /* 正文可能整段在 iframe 里（suanya：主文档只有一个跨域 iframe，静态抓和标签页都读不到）。 */
    if (needDeep()) {
      const framed = await readFrames(pageUrl, html, hints);
      if (framed) {
        text = (flatLen() ? (text + '\n' + framed) : framed).slice(0, MAX_TEXT);
        via = (via === 'fetch') ? 'fetch+frame' : (via + '+frame');
      }
    }

    /* 仍然不够：正文可能压根不在 DOM 里，而在同源接口的 JSON 里。 */
    if (needDeep()) {
      const extra = await probeApi(pageUrl, html, hints);
      if (extra) {
        text = (flatLen() ? (text + '\n' + extra) : extra).slice(0, MAX_TEXT);
        via = (via === 'fetch') ? 'fetch+api' : (via + '+api');
      }
    }

    let out;
    if (hardReason) {
      out = { ok: false, reason: hardReason };
    } else if (flatLen() < MIN_TEXT) {
      const bits = [];
      if (directErr) bits.push(directErr);
      bits.push('页面里没读到正文（可能需要登录或脚本渲染）');
      for (let i = 0; i < tabReasons.length; i++) bits.push('后台标签页：' + tabReasons[i]);
      if (tried.length > 1) bits.push('试过的地址：' + tried.join('、'));
      if (blockedByTls) bits.push('这个站只支持 http，浏览器把链接升级成 https 后停在安全提示页（错误页读不到正文）。扩展已经直接抓过 http 版，' + (flatLen() ? '但正文里仍然缺要核对的内容' : '但页面靠脚本渲染、静态抓不到正文') + '；要彻底免点，可在浏览器设置里关掉「始终使用安全连接」');
      out = { ok: false, reason: bits.join('；') };
    } else {
      out = { ok: true, text: text, len: text.length };
    }

    /* 成功时两个协议键都写：卡里链接这次写 http、下次写 https 时不必再抓一遍。 */
    const entry = { at: Date.now(), ok: !!out.ok, text: out.text || '', len: out.len || 0, reason: out.reason || '', via: via };
    cache[u] = entry;
    if (out.ok && alt && alt !== u) cache[alt] = Object.assign({}, entry);
    saveCache(cache);
    return Object.assign({ url: u, cached: false, via: via, tried: tried.slice() }, out);
  };

  self.KH = self.KH || {};
  self.KH.Policy = Policy;
})();
