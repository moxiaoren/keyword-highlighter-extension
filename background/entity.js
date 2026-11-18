/**
 * background/entity.js · 【2.0.8.8 需求③】免费免登陆查「法定代表人」
 * ----------------------------------------------------------------------------
 * 用户口径：「在免费免登陆渠道搜索这两个公司是否同法人」。
 * 通道（2026-11-16 实测后定型，按优先级）：
 *   ① 爱企查：用你浏览器里已有的登录态开一个**不激活的后台标签页**，等 JS 渲染后读 DOM
 *      （同 URL 的 fetch 直出 HTML 是 30KB 空壳，取不到「法定代表人」；搜索页结果也是 JS 渲染的）；
 *   ② 360 搜索兜底，换三种问法（见 SO360_QUERIES）；
 *   · 必应结果页是 JS 空壳 —— 已下线；
 *   · 360 的企业卡（`企业名称 … 统一社会信用代码 … 法定代表人 李广朝他投资的 1 家公司`）
 *     与 chinaz / 企查查的工商摘要都还能解析到人名；
 *   · 解析必须「公司名紧贴法定代表人」（nearName 的 45 字 / 无公司名间隔口径），
 *     否则宁可标「未查明」，绝不把一个别家公司的法人安到这家头上。
 *
 * 为什么放在 background：内容脚本里的 fetch 按**页面来源**走 CORS，企业信息站不会给任意商店页
 * 放行；service worker 是扩展来源 + `host_permissions: <all_urls>`，才发得出去，而且结果能
 * 复用 `chrome.storage.local` 缓存（同一家公司在很多卡片里重复出现，不该每次都发请求）。
 *
 * 口径与已知限制：
 *   · 只认「法定代表人」这一个字段，**不判断股权/实际控制人**（同名法人 ≠ 同一实控人）；
 *   · 站点改版、验证码、反爬都会导致查不到 —— 查不到就如实返回 `ok:false`，
 *     由面板保持原样（用户口径：不改底色），绝不猜一个法人名出来；
 *   · 请求串行 + 1.2s 间隔，一次卡片刷新最多 2 个公司，不会打爆对方站点。
 * ========================================================================= */
'use strict';

(function () {
  const Entity = {};
  const CACHE_KEY = 'khEntityCache';
  const TTL_MS = 7 * 24 * 3600 * 1000;
  /* 查不到的结论只留 6 小时：法人在公示系统里会变，也不该让一次站点抽风
   * 判「永远查不到」。 */
  const MISS_TTL_MS = 6 * 3600 * 1000;
  const MAX_ENTRIES = 200;
  const TIMEOUT_MS = 12000;
  const GAP_MS = 1200;
/* 360 让爱企查先跑多久：给足登录态标签页首屏渲染的时间，又不至于整轮变慢。 */
const SO360_HEADSTART_MS = 1200;
  const MAX_HTML = 400000;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  /* 法定代表人后面紧跟的可能是这些词（表格被拍平后的常见写法），不是人名，必须剔掉。 */
  /* 【2026-11-11】补搜索页的导航/卡片标签词：360 的标题与模块名里也有「法定代表人」，
   * 旧口径把「搜索」当成过法人（用户报「同法人校验一直未查明」的一部分误判）。 */
  const NOT_NAME = new Set([
    '信息', '变更', '姓名', '证明', '身份', '签字', '授权', '委托', '任职', '代表', '是否',
    '为是', '由谁', '的人', '页面', '查询', '数据', '简介', '详情', '为空', '未知', '暂无',
    '搜索', '导航', '反馈', '查看', '企业', '公司', '法人', '股东', '高管', '结果', '官网',
    '电话', '邮箱', '地址', '注册', '资本', '状态', '开业', '存续', '投资', '经营', '成立',
    '参保', '担任', '持股', '统一社会信用代码',
    /* 爱企查详情页的标签本身就是这些字，取相邻格时会把标签当值交上来（2026-11-16 单测抓到）。 */
    '法定代表人', '法人代表', '法定代表'
  ]);

  function normName(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, '')
      .replace(/（[^）]*）|\([^)]*\)/g, '')
      .toLowerCase();
  }

  /* ---------------- 网络 ---------------- */

  let queue = Promise.resolve();
  let lastAt = 0;

  /** 串行 + 最小间隔：两张卡同时缺数据时排队，不要并发打同一个站点。 */
  function serial(fn) {
    const run = queue.then(async () => {
      const wait = Math.max(0, lastAt + GAP_MS - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function getHtml(url) {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, TIMEOUT_MS) : 0;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      throw new Error(aborted ? '请求超时' : ('请求没发出去：' + String((err && err.message) || err)));
    }
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return String(text || '').slice(0, MAX_HTML);
  }

  /* ---------------- 解析 ---------------- */

  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return m; } })
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return m; } });
  }

  /** HTML → 一段拍平的正文（去掉脚本/样式/注释，标签换空格）。 */
  function textOf(html) {
    return decodeEntities(String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 【2.0.8.8 收紧】机构词尾巴：人名里出现这些就不该是人名（"张三工作室" 这类混进来会把法人判错）。 */
  const ORG_TAIL = /公司|集团|企业|工厂|商店|中心|学校|医院|银行|事务所|合作社|研究院|研究所|工作室|经营部|门市|基地|农场|超市|酒店|药房|店|厂|行|社|馆|局|委|院|校|部/;

  /**
   * 这一格是不是「人名」。
   * 收紧口径（2026-11-05 用户：先把解析收紧再发版）：
   *   · 中文 2–5 字（`·` 分隔的少数民族名放宽到 10 字）；
   *   · 命中机构词、或等于查询的公司名本身 → 不是法人。
   */
  function personOk(v, selfName) {
    const s = String(v || '').trim();
    if (!s || s.length < 2) return false;
    if (NOT_NAME.has(s)) return false;
    if (ORG_TAIL.test(s)) return false;
    if (selfName && normName(s) === normName(selfName)) return false;
    if (s.indexOf('·') >= 0) return /^[\u4e00-\u9fa5·]{3,10}$/.test(s);
    return /^[\u4e00-\u9fa5]{2,5}$/.test(s);
  }

  /* 兼容旧名：老单测/调用点还按 nameOk 找。 */
  const nameOk = personOk;

  /* 查询名必须**紧挨在**「法定代表人」前面，才算同一家公司的信息。
   * 【2026-11-16 实证】旧口径是前后 ±400 字里出现过查询名就算（NEAR_CHARS=400）：
   * 360 结果页底部的「其他人还搜 / 相关企业」区块离得太近，杭州矩远科技被判成了
   * 「哔哩哔哩」——别家公司的法人被安到这家头上，比查不到更危险。
   * 现在的口径（按真实企业卡的结构定的）：
   *   · 名字到「法定代表人」之间只能剩「统一社会信用代码 9111… / 企业名称 / 经营范围」这类
   *     卡片字段，长度 ≤ 45 字；
   *   · 这段里出现「公司 / 企业 / 集团」= 中间插了别家名字，一律不认。
   * 宁可标「未查明」，也不给一个错的法人。 */
  const NEAR_BEFORE = 200;
  const NEAR_GAP = 45;

  /** at 处往前 200 字内，queryName 是否紧贴着「法定代表人」，且中间没插别家公司名。 */
  function nearName(text, at, queryName) {
    if (!queryName) return true;
    const n = normName(queryName);
    if (!n) return true;
    const seg = normName(String(text || '').slice(Math.max(0, at - NEAR_BEFORE), at));
    const idx = seg.lastIndexOf(n);
    if (idx < 0) return false;
    const gap = seg.slice(idx + n.length);
    if (gap.length > NEAR_GAP) return false;
    if (/公司|企业|集团/.test(gap)) return false;
    return true;
  }

  /**
   * 从一页 HTML 里抠「法定代表人」。
   * @returns {string} 人名；抠不到返回空串
   */
  Entity.parseRep = function (html, queryName) {
    const raw = String(html || '');
    const selfName = String(queryName || '').trim();

    /* ① 结构化数据：详情页把法人放在 JSON 里（`legalPerson` 等）。
     *    收紧：同页有多个 `legalPerson` 时只认**离查询名最近**的那个（搜索页会列出别家公司）；
     *    全页只有一个时才允许不看位置。 */
    const jsonKeys = ['legalPerson', 'legal_person', 'legalPersonName', 'operName'];
    const hits = [];
    for (let i = 0; i < jsonKeys.length; i++) {
      const re = new RegExp('"' + jsonKeys[i] + '"\s*:\s*"([^"]{2,20})"', 'g');
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (personOk(m[1], selfName)) hits.push({ rep: String(m[1]).trim(), at: m.index });
      }
    }
    if (hits.length) {
      const near = hits.filter((h) => nearName(raw, h.at, selfName));
      if (near.length) return near[0].rep;
      if (hits.length === 1 && !selfName) return hits[0].rep;
      if (hits.length === 1 && nearName(raw, hits[0].at, selfName)) return hits[0].rep;
      /* 多个候选且都不在查询名附近 → 宁可查不到，也不安一个别家公司的法人。 */
      if (selfName) return '';
    }

    /* ② 拍平正文：`法定代表人：雷军` / `法定代表人 雷军`（表格拍平后冒号会丢）。
     * 【2026-11-11】名字常和卡片上的下一段标签粘连（360：「法定代表人 李广朝他投资的 1 家公司」），
     * 必须在边界词处截断；用**懒惰**量词先试 2 字再变长 —— 贪婪会把「李广朝他」当成 4 字人名。 */
    const text = textOf(raw);
    const tail = '他|投资|经营状态|成立日期|注册资本|行政区划|参保|担任|持股|股东|法人|电话|邮箱|地址'
      + '|简介|详情|查看|反馈|统一社会信用代码|[（(，,、；;。\\s]|$';
    const pats = [
      new RegExp('法定代表人[^。；;\\n]{0,10}?[：:]\\s*([\\u4e00-\\u9fa5·]{2,5}?)(?=' + tail + ')', 'g'),
      new RegExp('法人代表[^。；;\\n]{0,10}?[：:]\\s*([\\u4e00-\\u9fa5·]{2,5}?)(?=' + tail + ')', 'g'),
      new RegExp('法定代表人\\s+([\\u4e00-\\u9fa5·]{2,5}?)(?=' + tail + ')', 'g')
    ];
    for (let i = 0; i < pats.length; i++) {
      let m;
      while ((m = pats[i].exec(text)) !== null) {
        if (!personOk(m[1], selfName)) continue;
        if (!nearName(text, m.index, selfName)) continue;
        return String(m[1]).trim();
      }
    }
    return '';
  };

  /* ---------------- 通道 ----------------
   * 【2026-11-16 实证】只剩 360 一个通道，但它要换问法：
   *   · 爱企查搜索页已 302 到反爬空壳（正文里没有「法定代表人」）；
   *   · 必应结果页是 JS 渲染的空壳（正文 1.7KB，没有任何企业卡）；
   *   这两条以前只会各拖 12 秒再报「没解析出」，现在下线。
   * 360 的问法（按实测的产出排序）：
   *   ① 「公司名 法人」——小公司也能搜到 chinaz / 企查查的工商摘要（含法人）；
   *   ② 「"公司名" 法定代表人」——大公司首屏直接是企业卡；
   *   ③ 「公司名 法定代表人」——兜底。
   * 三种都只接受「公司名紧贴法定代表人」的解析（见 nearName 的收紧口径）。
   */
  const SO360_QUERIES = [
    function (name) { return name + ' 法人'; },
    function (name) { return '"' + name + '" 法定代表人'; },
    function (name) { return name + ' 法定代表人'; }
  ];

  /* ---------------- 爱企查（走你浏览器里已有的登录态） ----------------
   * 【2026-11-16 实证】用户登录爱企查后回传的实测：
   *   · 详情页 DOM 里**有**「法定代表人」（段落形如「…法定代表人为叶天。经营范围…」）；
   *   · 但同一个详情页 fetch 直出的 HTML 只有 30KB 空壳，没有这四个字 —— SSR 取不到数；
   *   · 搜索页 fetch 直出 256KB 也没有 company_detail_ 链接（登录态下的结果靠 JS 渲染）。
   *  ⇒ 只能开一个**不激活的后台标签页**，等 JS 渲染出来读 DOM，读完立刻关掉。
   * 不需要新增权限：host_permissions 已是 <all_urls>，scripting 与 tabs 的创建/关闭都在现有权限内。
   * 失败时如实抛错（未登录 / 要验证 / 没这家公司 / 没读出人名），绝不猜一个法人。 */

  /* 整个爱企查通道的时间预算：超了就放弃，把 20s 的查人窗口留给 360。 */
  const AIQ_BUDGET_MS = 9000;
  const AIQ_POLL_MS = 400;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function aiqReady() {
    return !!(self.chrome && chrome.tabs && chrome.scripting
      && typeof chrome.tabs.create === 'function'
      && typeof chrome.scripting.executeScript === 'function');
  }

  async function aiqRunInTab(tabId, fn, args) {
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: fn, args: args || [] });
      return (out && out[0] && out[0].result) || null;
    } catch (e) {
      /* 页面还在加载时 executeScript 会报「Cannot access contents」，继续轮询就行。 */
      return null;
    }
  }

  /* 下面两个函数会被序列化进页面执行，所以必须自包含（不能引用外层变量）。 */

  /** 搜索结果页：有没有指向 company_detail_ 的链接、链接文字是不是这家公司。 */
  function aiqSearchProbe() {
    function norm(s) {
      return String(s == null ? '' : s).replace(/[\s\u00a0\u3000]/g, '')
        .replace(/（[^）]*）|\([^)]*\)/g, '');
    }
    const links = [];
    const as = document.querySelectorAll('a[href*="company_detail_"], a[href*="company-detail"], a[href*="companydetail"]');
    for (let i = 0; i < as.length && links.length < 60; i++) {
      const href = String(as[i].href || '').split('#')[0];
      if (!href) continue;
      links.push({ href: href, text: norm(as[i].textContent).slice(0, 80) });
    }
    const body = (document.body && (document.body.innerText || document.body.textContent)) || '';
    return {
      url: String(location.href),
      gate: String(location.href).indexOf('/cbae/') >= 0,
      needLogin: links.length === 0 && /登录后(?:查看|可见)|请先登录|百度账号登录/.test(body.slice(0, 3000)),
      empty: /没有找到|暂无相关|未找到/.test(body.slice(0, 3000)),
      links: links
    };
  }

  /** 详情页：把「法定代表人」旁边/简介句里的人名候选都交回去，由 background 侧用 personOk 校验。 */
  function aiqDetailProbe() {
    const cands = [];
    function push(v, via) {
      let s = String(v == null ? '' : v).replace(/[\s\u00a0\u3000]+/g, ' ').trim();
      if (!s) return;
      s = s.replace(/^[：:为\s]+/, '');
      const tok = (s.split(/[，,。；;、|\s]/)[0] || '').trim();
      if (!tok || tok.length > 20) return;
      cands.push({ v: tok, via: via });
    }
    /* ① 标签 + 相邻值：<span>法定代表人</span><span>张三</span> 或 <th>/<td>。 */
    const all = document.querySelectorAll('span,div,td,th,dt,dd,p,label,em,i,b,strong,a');
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (el.children && el.children.length) continue;
      const t = String(el.textContent || '').replace(/[\s\u00a0\u3000]/g, '');
      if (t !== '法定代表人' && t !== '法定代表人：' && t !== '法定代表人:') continue;
      const sib = el.nextElementSibling;
      if (sib) push(sib.textContent, 'sib');
      const par = el.parentElement;
      if (par) push(String(par.textContent || '').replace(/法定代表人[：:]?/, ''), 'parent');
    }
    /* ② 简介句：「…法定代表人为叶天。经营范围包括一般项目…」 */
    const body = (document.body && (document.body.innerText || document.body.textContent)) || '';
    const m = body.match(/法定代表人[：:]?\s*为?\s*([\u4e00-\u9fa5·]{2,10})/);
    if (m) push(m[1], 'text');
    return { url: String(location.href), title: String(document.title || ''), cands: cands.slice(0, 10) };
  }

  /**
   * 从候选里挑一个人名（纯函数，单测直接调）。
   * 口径：逐个过 personOk（2–5 字中文 / 少数民族名带 ·、剔除机构词与标签词、不等于公司名本身）。
   * @param {Array<{v:string}>|string[]} cands
   * @param {string} selfName 查询的公司名
   */
  Entity.pickRep = function (cands, selfName) {
    const list = Array.isArray(cands) ? cands : [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] && typeof list[i] === 'object' ? list[i].v : list[i];
      const v = String(raw == null ? '' : raw).trim();
      if (personOk(v, selfName)) return v;
    }
    return '';
  };

  async function fromAiqicha(name) {
    if (!aiqReady()) throw new Error('爱企查通道要标签页与脚本权限');
    const want = normName(name);
    const deadline = Date.now() + AIQ_BUDGET_MS;
    let tabId = 0;
    try {
      const tab = await chrome.tabs.create({
        url: 'https://aiqicha.baidu.com/s?q=' + encodeURIComponent(name),
        active: false
      });
      tabId = (tab && tab.id) || 0;
      if (!tabId) throw new Error('爱企查标签页没开起来');

      /* ① 等搜索结果，挑一条链接文字等于（或包含）查询名的。 */
      let target = '';
      while (Date.now() < deadline) {
        await sleep(AIQ_POLL_MS);
        const st = await aiqRunInTab(tabId, aiqSearchProbe, []);
        if (!st) continue;
        if (st.gate) throw new Error('爱企查要求人机验证（登录态可能失效）');
        if (st.needLogin) throw new Error('爱企查没登录（在浏览器里登录后再试）');
        const links = st.links || [];
        if (!links.length) {
          if (st.empty) throw new Error('爱企查没搜到这家公司');
          continue;
        }
        const exact = links.filter(function (l) { return l.text && normName(l.text) === want; });
        const loose = links.filter(function (l) {
          const t = normName(l.text || '');
          return t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0);
        });
        const pick = exact[0] || loose[0];
        if (pick) { target = pick.href; break; }
        /* 有链接但没有一家对得上：搜索页把相似公司列出来了，别乱点。 */
        throw new Error('爱企查搜索里没有同名公司');
      }
      if (!target) throw new Error('爱企查搜索页没等到结果');

      /* ② 进详情页，等「法定代表人」渲染出来。 */
      await chrome.tabs.update(tabId, { url: target });
      while (Date.now() < deadline) {
        await sleep(AIQ_POLL_MS);
        const st = await aiqRunInTab(tabId, aiqDetailProbe, []);
        if (!st) continue;
        if (String(st.url || '').indexOf('/cbae/') >= 0) throw new Error('爱企查要求人机验证（登录态可能失效）');
        const titleOk = normName(st.title || '').indexOf(want) >= 0;
        if (!titleOk) continue;
        const rep = Entity.pickRep(st.cands, name);
        if (rep) return { rep: rep, source: 'aiqicha', url: target };
      }
      throw new Error('爱企查详情页没读出法定代表人');
    } finally {
      if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) { /* 关不掉也不影响结果 */ } }
    }
  }

  async function fromSo360(name) {
    const errors = [];
    for (let i = 0; i < SO360_QUERIES.length; i++) {
      /* 同一站点连打三枪不礼貌：换问法之间留 600ms。 */
      if (i) await new Promise(function (r) { setTimeout(r, 600); });
      const url = 'https://www.so.com/s?q=' + encodeURIComponent(SO360_QUERIES[i](name));
      try {
        const html = await getHtml(url);
        const rep = Entity.parseRep(html, name);
        if (rep) return { rep: rep, source: 'so360', url: url };
      } catch (err) {
        errors.push(String((err && err.message) || err));
      }
    }
    throw new Error(errors.length
      ? ('360 搜索没给出法定代表人（' + errors[0] + '）')
      : '360 搜索结果里没有这家公司的法定代表人');
  }

  /* ---------------- 缓存 ---------------- */

  async function readCache() {
    try {
      const o = await chrome.storage.local.get(CACHE_KEY);
      const map = o && o[CACHE_KEY];
      return (map && typeof map === 'object') ? map : {};
    } catch (e) { return {}; }
  }

  async function writeCache(map) {
    try {
      const keys = Object.keys(map);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
        for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete map[keys[i]];
      }
      await chrome.storage.local.set({ [CACHE_KEY]: map });
    } catch (e) { /* 写缓存失败不影响本次结果 */ }
  }

  /**
   * 查一家公司的法定代表人。
   * @param {{name:string}} msg
   * @returns {Promise<{ok:true, rep:string, source:string, cached?:boolean}|{ok:false, error:string}>}
   */
  Entity.lookup = async function (msg) {
    const name = String((msg && msg.name) || '').trim();
    if (!name) return { ok: false, error: '公司名为空' };
    const key = normName(name);
    const cache = await readCache();
    const hit = cache[key];
    if (hit && hit.rep && (Date.now() - (hit.at || 0)) < TTL_MS) {
      return { ok: true, rep: hit.rep, source: hit.source || 'cache', cached: true, name: name };
    }
    /* 【2026-11-16】查不到也缓存：同一张卡反复重建、同一家公司在很多卡片里出现，
     * 每次都连打三个 360 问法太浪费，也容易被对方限速。 */
    if (hit && hit.miss && (Date.now() - (hit.at || 0)) < MISS_TTL_MS) {
      return { ok: false, error: hit.error || '未查到', name: name, cached: true };
    }
    /* 只查单位：个人当主体时，面板那边直接按「本人就是法人」处理，不该来打网络。 */
    const errors = [];
    /* 2026-11-16：爱企查优先（用浏览器里的登录态开后台标签页读 DOM，最准），360 兜底。
     * 【2026-11-18 用户问题二】两条通道原来是**串行**的：爱企查 9s 预算用满再交给 360 打三枪，
     * 合计常常超过面板 20s 的等待，卡片就留一个「⏱ 超时」。现在同时起跑：
     * 爱企查先跑，360 延后 SO360_HEADSTART_MS 再上（爱企查先出结论就不白打 360），
     * 谁先给出结论用谁，慢的那条自己结束。 */
    const channels = [fromAiqicha, fromSo360];
    const r = await new Promise(function (resolve) {
      let pending = channels.length;
      let done = false;
      channels.forEach(function (ch, i) {
        const go = function () {
          serial(function () { return ch(name); }).then(function (out) {
            if (done) return;
            done = true;
            resolve(out);
          }).catch(function (err) {
            errors.push(String((err && err.message) || err));
            pending -= 1;
            if (!done && pending === 0) { done = true; resolve(null); }
          });
        };
        if (i === 0) go();
        else setTimeout(go, SO360_HEADSTART_MS);
      });
    });
    if (r && r.rep) {
      cache[key] = { rep: r.rep, source: r.source, at: Date.now(), name: name };
      await writeCache(cache);
      return { ok: true, rep: r.rep, source: r.source, name: name };
    }
    const errText = errors.join('；') || '查询失败';
    cache[key] = { rep: '', miss: true, error: errText, at: Date.now(), name: name };
    await writeCache(cache);
    return { ok: false, error: errText, name: name };
  };

  /* 通道单独暴露：单测要验证「未登录 / 要验证 ⇒ 快速失败并关标签」这条链，不必真开标签页。 */
  Entity.fromAiqicha = fromAiqicha;

  self.KH = self.KH || {};
  self.KH.Entity = Entity;
})();
