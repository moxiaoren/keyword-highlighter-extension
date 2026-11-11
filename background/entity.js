/**
 * background/entity.js · 【2.0.8.8 需求③】免费免登陆查「法定代表人」
 * ----------------------------------------------------------------------------
 * 用户口径：「在免费免登陆渠道搜索这两个公司是否同法人」。
 * 通道顺序（2026-11-11 实测后调整）：360 搜索企业卡 → 爱企查(百度) → 必应搜索摘要 →
 * 都失败就标「未查明」，卡片不改底色。
 * 为什么换 360 打头：实测爱企查搜索页 302 到反爬校验页（正文里根本没有「法定代表人」），
 * 必应结果区只有别家百科/无关页；360 的搜索结果首屏直接是企业卡
 * （`企业名称 … 统一社会信用代码 … 法定代表人 李广朝他投资的 1 家公司 经营状态 开业`），
 * 是三者里唯一稳定能解析出人名的。
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
  const MAX_ENTRIES = 200;
  const TIMEOUT_MS = 12000;
  const GAP_MS = 1200;
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
    '参保', '担任', '持股', '统一社会信用代码'
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

  /* 查询名出现在「法定代表人」附近多远以内，才算同一家公司的信息。
   * 为什么需要它：必应结果页、爱企查搜索页都会带上**别家公司**的卡片/推荐位，
   * 全页乱抠会把隔壁公司的法人安到这家头上（用户要的就是把这种误判去掉）。 */
  const NEAR_CHARS = 400;

  /** at 处前后 window 内有没有出现 queryName（忽略空白/大小写）。 */
  function nearName(text, at, queryName) {
    if (!queryName) return true;
    const n = normName(queryName);
    if (!n) return true;
    const from = Math.max(0, at - NEAR_CHARS);
    const seg = String(text || '').slice(from, at + NEAR_CHARS);
    return normName(seg).indexOf(n) >= 0;
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

  /* ---------------- 两个通道 ---------------- */

  /* 360 搜索：实测三者里唯一稳定给出企业卡的渠道。
   * 首屏就是「企业名称 … 统一社会信用代码 … 法定代表人 李广朝他投资的 1 家公司 经营状态 开业」。 */
  async function fromSo360(name) {
    const url = 'https://www.so.com/s?q=' + encodeURIComponent(name + ' 法定代表人');
    const html = await getHtml(url);
    const rep = Entity.parseRep(html, name);
    if (!rep) throw new Error('360 搜索结果里没解析出法定代表人');
    return { rep: rep, source: 'so360', url: url };
  }

  async function fromAiqicha(name) {
    const url = 'https://aiqicha.baidu.com/s?q=' + encodeURIComponent(name);
    const html = await getHtml(url);
    const rep = Entity.parseRep(html, name);
    if (!rep) throw new Error('爱企查页面没解析出法定代表人');
    return { rep: rep, source: 'aiqicha', url: url };
  }

  async function fromBing(name) {
    const q = name + ' 法定代表人';
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN';
    const html = await getHtml(url);
    const rep = Entity.parseRep(html, name);
    if (!rep) throw new Error('必应结果里没解析出法定代表人');
    return { rep: rep, source: 'bing', url: url };
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
    /* 只查单位：个人当主体时，面板那边直接按「本人就是法人」处理，不该来打网络。 */
    const errors = [];
    /* 顺序：360 先（实测只有它稳定给企业卡）→ 爱企查 → 必应兜底。 */
    const channels = [fromSo360, fromAiqicha, fromBing];
    for (let i = 0; i < channels.length; i++) {
      try {
        const r = await serial(() => channels[i](name));
        cache[key] = { rep: r.rep, source: r.source, at: Date.now(), name: name };
        await writeCache(cache);
        return { ok: true, rep: r.rep, source: r.source, name: name };
      } catch (err) {
        errors.push(String((err && err.message) || err));
      }
    }
    return { ok: false, error: errors.join('；') || '查询失败', name: name };
  };

  self.KH = self.KH || {};
  self.KH.Entity = Entity;
})();
