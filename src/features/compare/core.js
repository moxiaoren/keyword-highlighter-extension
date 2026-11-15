/**
 * src/features/compare/core.js · 比对子系统 · 判等核心（R1）
 * ----------------------------------------------------------------------------
 * 全工程唯一的「两个值是不是一样 / 是不是同一法人 / 在不在放行名单 / 正文里有没有」
 * 判定实现。旧 note-check.js 的五套判等在这里收成一套，之后 note-check.js 删除。
 *
 * 纪律（重写也不许碰，见 docs/比对子系统重写-设计.md 第八节）：
 *   ① 本文件纯函数：不做 IO、不碰 DOM、不认识字段名、不读配置存储；
 *   ② keyOf 只做 1:1 折叠（去括号补充在 coreOf 里），不做 NFKC、不去标点；
 *   ③ 结论标签只增不改：老调用方读到的 state 字符串原样保留（same/diff/unknown/timeout/unset/weak/none）；
 *   ④ 颜色只有 COLOR_OK / COLOR_BAD 两个值，不在别处再抄一份。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});

  /* ---------- 颜色（单一来源，面板直接取） ---------- */
  C.COLOR_OK = '#e6f4ea';
  C.COLOR_BAD = '#fdf3d7';

  function raw(v) { return v == null ? '' : String(v); }
  function TN() { return KH.TextNorm || null; }

  /* ---------- 归一（判据专用，绝不回写） ---------- */

  /** 字段名/主体名归一：去括号补充 + 空白/全半角/标点/零宽/大小写折叠。
   *  与 TextNorm.keyOf 的差别只有一处：**先删括号补充**（「某某（松江）公司」= 「某某公司」）。
   *  会改变长度，所以只能进判据，不许拿它映射原文区间。 */
  function keyOf(v) {
    const T = TN();
    const s = raw(v);
    if (T) return T.keyOf(T.coreOf(s));
    return s.replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /** 正文归一：去掉段落哨兵，供「在正文里找子串」用（跨行命中）。 */
  function flat(v) {
    const T = TN();
    if (T) return T.flatOf(v);
    return raw(v).replace(/[\u00a0\u3000\u200b-\u200f\u2060\ufeff]/g, ' ')
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  C.keyOf = keyOf;
  C.flat = flat;

  /* ---------- ① 两个值像不像同一个 ---------- */

  const SAME_TAGS = {
    same: 1, 'fold-ws': 1, 'fold-width': 1, 'fold-punct': 1,
    'fold-zero': 1, 'fold-case': 1, 'fold-core': 1, 'fold-admin': 1, near: 1
  };

  /**
   * @param {string} a 左值（页面/抓取）
   * @param {string} b 右值（图里 OCR / 资质）
   * @param {{core?:boolean, admin?:boolean, near?:boolean, org?:boolean}} [opts]
   *   core/admin/near 透传 TextNorm.verdict；org:true = 两边 >=6 字且互相包含也算同一家。
   * @returns {{state:'same'|'diff'|'unknown'|'weak'|'none', how:string, missing:''|'a'|'b'|'both', a:string, b:string}}
   */
  function pairState(a, b, opts) {
    const o = opts || {};
    const T = TN();
    const A = raw(a).trim();
    const B = raw(b).trim();
    if (!A && !B) return { state: 'none', how: 'none', missing: 'both', a: A, b: B };
    if (!A) return { state: 'unknown', how: 'only-b', missing: 'a', a: A, b: B };
    if (!B) return { state: 'unknown', how: 'only-a', missing: 'b', a: A, b: B };
    const tag = T ? T.verdict(A, B, o) : (A === B ? 'same' : 'conflict');
    if (SAME_TAGS[tag]) return { state: 'same', how: tag, missing: '', a: A, b: B };
    if (tag === 'weak') return { state: 'weak', how: 'weak', missing: '', a: A, b: B };
    if (o.org) {
      const ka = keyOf(A);
      const kb = keyOf(B);
      if (ka.length >= 6 && kb.length >= 6 && (ka.indexOf(kb) >= 0 || kb.indexOf(ka) >= 0)) {
        return { state: 'same', how: 'contain', missing: '', a: A, b: B };
      }
    }
    return { state: 'diff', how: tag === 'conflict' ? 'conflict' : tag, missing: '', a: A, b: B };
  }

  C.pairState = pairState;

  /* ---------- ② 两个主体是不是同一法人 ---------- */

  /* 个人名判定的反面清单：带这些字样的当「单位」，其余 2–6 个字的中文名当「个人」。 */
  const ORG_WORDS = [
    '公司', '集团', '企业', '工作室', '中心', '商店', '店', '厂', '研究所', '所', '学院', '学校',
    '医院', '研究院', '大学', '部', '局', '委员会', '协会', '学会', '基金会', '合作社', '事务所',
    '经营部', '门市', '商行', '商城', '基地', '农场', '银行', '支行', '分行', '通讯', '网络',
    '科技', '信息', '传媒', '文化', '商贸', '贸易', '电子', '实业', '投资', '管理', '咨询',
    '服务', '技术', '有限', '股份', '合伙', '个体', '单位', '组织', '社', '行', '馆', '城', '站'
  ];

  /** 看起来是不是「个人」（自然人）—— 个人当主体时，本人就是法人。 */
  function isPersonName(name) {
    const n = keyOf(name);
    if (!n) return false;
    for (let i = 0; i < ORG_WORDS.length; i += 1) if (n.indexOf(ORG_WORDS[i]) >= 0) return false;
    /* 中点「·」在 keyOf 里会被折成「.」（中英标点 1:1 折叠），两种都认：少数民族名两种写法都常见。 */
    return /^[\u4e00-\u9fa5·.]{2,6}$/.test(n) || /^[a-z][a-z .]{2,30}$/.test(n);
  }

  /** 一方的「法人」是谁：个人 = 本人；单位 = 查到的法人名（没有就空串）。 */
  function repOf(side) {
    const s = side || {};
    const name = keyOf(s.name);
    if (!name) return '';
    if (isPersonName(name)) return name;
    return keyOf(s.rep);
  }

  /**
   * 同法人判定。unknown = 名字没取到 / 有单位但没查到法人 ⇒ 不改底色（不能假装校验过）。
   * @returns {{state:'same'|'diff'|'unknown', how:string, by:'name'|'rep'|''}}
   */
  function legalRep(a, b) {
    const na = keyOf(a && a.name);
    const nb = keyOf(b && b.name);
    if (!na || !nb) return { state: 'unknown', how: 'missing-name', by: '' };
    if (na === nb) return { state: 'same', how: 'name', by: 'name' };
    const ra = repOf(a);
    const rb = repOf(b);
    if (!ra || !rb) return { state: 'unknown', how: 'missing-rep', by: '' };
    return { state: ra === rb ? 'same' : 'diff', how: ra === rb ? 'rep' : 'rep-diff', by: 'rep' };
  }

  C.legalRep = legalRep;
  C.isPersonName = isPersonName;
  C.repOf = repOf;

  /* ---------- ③ 承诺对象放行名单 ---------- */

  /* 明确点名了别家平台 ⇒ 即使行文里也带「应用平台」也不放行。反面清单不随配置走。 */
  const PROMISE_OTHER = /华为|huawei|小米|xiaomi|oppo|广东欢太|欢太|应用宝|腾讯|荣耀|honor|三星|samsung|魅族|meizu|中兴|努比亚|一加|realme|抖音|快手|百度|阿里/i;
  const PROMISE_GENERIC = /未指定具体平台|各?应用平台|各?应用市场|各?应用商店|各大渠道|所有渠道/;

  /** 放行名单唯一取值路径：调用方给 → 用它；没给 → 配置默认；清洗一律走 Config。 */
  function promiseOkList(input) {
    let src = input;
    if (src && typeof src === 'object' && !Array.isArray(src)) src = src.promiseOk;
    if (src === undefined || src === null) {
      const d = (KH.Config && KH.Config.defaults && KH.Config.defaults.noteCheck) || null;
      src = d ? d.promiseOk : [];
    }
    const CFG = KH.Config || null;
    if (CFG && typeof CFG.normalizeNoteCheck === 'function') return CFG.normalizeNoteCheck(src).promiseOk;
    return Array.isArray(src) ? src.map((s) => raw(s).trim()).filter(Boolean) : [];
  }

  /** 名单项按**字面子串**匹配（两侧都 keyOf）：用户填的通配符不会被当成通配。返回命中的那一项。 */
  function listHit(target, list) {
    const kt = keyOf(target);
    if (!kt) return '';
    for (let i = 0; i < list.length; i += 1) {
      const k = keyOf(list[i]);
      if (k && kt.indexOf(k) >= 0) return raw(list[i]);
    }
    return '';
  }

  /**
   * @returns {{state:'ok'|'warn'|'unknown', how:string, hit:string, list:string[]}}
   *   ok   = 命中放行名单 / 无具体平台的泛称
   *   warn = 点名了别家平台，或名单为空且认不出
   */
  function allowList(target, list) {
    const t = raw(target).trim();
    const names = promiseOkList(list);
    if (!t) return { state: 'unknown', how: 'empty', hit: '', list: names };
    const hit = names.length ? listHit(t, names) : '';
    if (hit) return { state: 'ok', how: 'list', hit: hit, list: names };
    if (!PROMISE_OTHER.test(t) && PROMISE_GENERIC.test(t)) {
      return { state: 'ok', how: 'generic', hit: '', list: names };
    }
    return { state: 'warn', how: names.length ? 'miss' : 'empty-list', hit: '', list: names };
  }

  C.allowList = allowList;
  C.promiseOkList = promiseOkList;
  C.listHit = listHit;

  /* ---------- ④ 正文里有没有（隐私政策） ---------- */

  const ORG_SUFFIX_WORDS = ['公司', '中心', '集团', '银行', '医院', '学校', '大学', '学院', '工作室',
    '事务所', '合作社', '协会', '基金会', '研究院', '研究所', '融媒体', '报社', '电视台', '出版社'];

  function orgLike(s) {
    const v = raw(s);
    if (v.length < 8) return false;
    for (let i = 0; i < ORG_SUFFIX_WORDS.length; i += 1) if (v.indexOf(ORG_SUFFIX_WORDS[i]) >= 0) return true;
    return false;
  }

  function chineseCount(s) {
    const m = raw(s).match(/[\u4e00-\u9fa5]/g);
    return m ? m.length : 0;
  }

  /**
   * 命中程度：0 没命中 / 1 原文一致 / 2 只差括号补充或标题后缀 /
   *          3 单位名行政区划写法不同 / 4 长词只差 1 个字。
   */
  function policyMatch(hay, needle, kind) {
    const T = TN();
    const h = flat(hay);
    let n = flat(needle);
    if (!h || !n) return { hit: false, mode: 0 };
    n = n.replace(/(…|\.\.\.).*$/, '');
    if (n.length < 2) return { hit: false, mode: 0 };
    if (h.indexOf(n) >= 0) return { hit: true, mode: 1 };

    const core = T ? flat(T.coreOf(needle)).replace(/(…|\.\.\.).*$/, '') : n;
    if (core.length >= 4 && core !== n && h.indexOf(core) >= 0) return { hit: true, mode: 2 };

    if (orgLike(core)) {
      const bare = T ? T.stripAdmin(core) : core.replace(/[省市区县]/g, '');
      if (bare.length >= 6 && (h.indexOf(bare) >= 0 || (T ? T.stripAdmin(h) : h.replace(/[省市区县]/g, '')).indexOf(bare) >= 0)) {
        return { hit: true, mode: 3 };
      }
    }

    if (kind === 'title') {
      const t = n.replace(/(?:app|客户端|安卓版|ios版|手机版|平台版)$/i, '');
      if (t.length >= 2 && t !== n && h.indexOf(t) >= 0) return { hit: true, mode: 2 };
    }

    if (n.length >= 6 && n.length <= 40 && chineseCount(n) >= 4 && T && T.nearAt(h, n) >= 0) {
      return { hit: true, mode: 4 };
    }
    return { hit: false, mode: 0 };
  }

  /** 兼容薄导出：只要「命中没有」/ 只要命中程度（旧调用方的两个入口）。 */
  function contains(hay, needle, kind) { return policyMatch(hay, needle, kind).hit; }
  function matchMode(hay, needle, kind) { return policyMatch(hay, needle, kind).mode; }

  /** 「隐私政策链接」抓到的东西在正文里有没有：整串没有就退一步只看域名。null = 没这个字段。 */
  function linkHit(policy, link) {
    const t = raw(link).trim();
    if (!t) return null;
    const f = flat(policy);
    if (f.indexOf(flat(t)) >= 0) return true;
    const m = /^https?:\/\/([^/?#]+)/i.exec(t);
    if (!m) return false;
    const host = raw(m[1]).replace(/^www\./i, '').toLowerCase();
    return host ? f.indexOf(host) >= 0 : false;
  }

  /**
   * @returns {null | {ok:boolean, items:Array, missing:string[], len:number}}
   *   null = 这张卡没有可校验的内容（没有正文 / 没有可比的项）
   */
  function policyVerdict(fields) {
    const f = fields || {};
    const policy = raw(f.policy).trim();
    if (flat(policy).length < 8) return null;
    const items = [];
    const add = (key, needle) => {
      const v = raw(needle).trim();
      if (!v) return;
      const r = policyMatch(policy, v, key);
      items.push({ key: key, needle: v, hit: r.hit, mode: r.mode });
    };
    add('title', f.title);
    add('dev', f.dev);
    const lh = linkHit(policy, f.link);
    if (lh !== null) items.push({ key: 'content', needle: raw(f.link).trim(), hit: lh });
    if (!items.length) return null;
    const missing = [];
    if (!raw(f.title).trim()) missing.push('title');
    if (!raw(f.dev).trim()) missing.push('dev');
    return { ok: items.every((it) => it.hit), items: items, missing: missing, len: flat(policy).length };
  }

  C.policyMatch = policyMatch;
  C.contains = contains;
  C.matchMode = matchMode;
  C.linkHit = linkHit;
  C.policyVerdict = policyVerdict;

  /* ---------- ⑤ 非颜色标记（唯一文案真源） ---------- */

  const MARKS = {
    same: { icon: '✔', text: '一致' },
    ok: { icon: '✔', text: '一致' },
    diff: { icon: '⚠', text: '待确认' },
    warn: { icon: '⚠', text: '待确认' },
    unknown: { icon: '？', text: '未查明' },
    timeout: { icon: '⏱', text: '超时' },
    unset: { icon: '⚙', text: '待配置' }
  };

  /** @returns {{state:string, icon:string, text:string, label:string}|null} */
  function markOf(state) {
    const s = raw(state);
    const m = MARKS[s];
    if (!m) return null;
    return { state: s, icon: m.icon, text: m.text, label: m.icon + ' ' + m.text };
  }

  /** 底色：只有一个来源。weak/none/unknown/unset/timeout 都不涂色。 */
  function colorOf(state) {
    const s = raw(state);
    if (s === 'same' || s === 'ok') return C.COLOR_OK;
    if (s === 'diff' || s === 'warn') return C.COLOR_BAD;
    return '';
  }

  C.markOf = markOf;
  C.colorOf = colorOf;
})();
