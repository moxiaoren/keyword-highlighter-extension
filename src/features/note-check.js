/**
 * src/features/note-check.js · 【2.0.8.8 需求②③】卡片里的两处「合规小校验」
 * ----------------------------------------------------------------------------
 * 只做**判定**，不联网、不画界面：
 *   ① 隐私政策校验：抓取字段「隐私政策」有正文时，看卡片里的「主标题」「开发者」
 *      以及「隐私政策链接」抓到的内容，在不在这段隐私政策正文里。
 *   ② 同法人校验：同一张卡同时有「开发者」和「核准主体名称」时，判断两边是不是同一
 *      法定代表人（个人当主体时，本人就是法人）。法人数据由 background/entity.js 查，
 *      本文件只比较结果。
 * 面板（important-note.js）只负责把结论画成行底色与徽标，判定口径全在这里，便于单测。
 * ========================================================================= */

(function () {
  'use strict';

  /* 取全局的方式与其余特性模块一致（`self` 只在 service worker 里有，单测垫片只给 window）。 */
  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const NoteCheck = {};

  /* ---------- 颜色（单一来源） ----------
   * 用户口径：都在 ⇒ 浅绿；有缺 ⇒ 浅黄（隐私政策行）；同法人 ⇒ 浅绿、不同 ⇒ 浅黄（两行）。
   * 只在这里定义一次，面板直接用；不要再在 CSS 里抄第二份色值。 */
  NoteCheck.COLOR_OK = '#e6f4ea';
  NoteCheck.COLOR_BAD = '#fdf3d7';

  /* ---------- 字段名归一 ---------- */
  /** 去空白、全角括号转半角、小写：表里写法可能带空格或全角冒号。 */
  function keyOf(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, '')
      .replace(/（）/g, '()')
      .replace(/[：:]/g, '')
      .toLowerCase();
  }

  /** 正文归一：去所有空白（含全角空格）+ 零宽字符，全角 ASCII 折成半角，再小写。
   *  隐私政策常把公司名断行写；也常把括号/字母写成全角（`ＡＢＣ（中国）`），
   *  只比原样字符会「明明有却说没有」——先折平再比。 */
  function flat(s) {
    return String(s == null ? '' : s)
      /* 零宽与方向控制：肉眼看不见，却会让 indexOf 直接失配 */
      .replace(/[\u00a0\u3000\u200b-\u200f\u2060\ufeff]/g, ' ')
      /* 全角 ASCII（！＂＃…～）折半角：全角/半角混写不该改变结论 */
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /* ---------- 字段别名 ----------
   * 用户配的抓取字段名可能带后缀（`隐私政策#表` 之类由 fetch 层解析成纯标签），
   * 也可能写成同义词；这里按「一个字段接受哪些写法」列出来。 */
  const FIELDS = {
    title: ['主标题', '标题', '应用名称', '应用名', '软件名称'],
    dev: ['开发者', '开发者名称', '开发商', '开发公司'],
    entity: ['核准主体名称', '核准主体', '主体名称', '主办单位名称', '主办单位'],
    link: ['隐私政策链接', '隐私政策地址', '隐私权政策链接', '政策链接', '隐私链接'],
    policy: ['隐私政策', '隐私权政策', '隐私政策内容']
  };

  /** 某一行左列是不是我们要的字段；返回字段 key（`title` / `dev` / …）或空串。 */
  NoteCheck.fieldKey = function (label) {
    const k = keyOf(label);
    if (!k) return '';
    const keys = Object.keys(FIELDS);
    for (let i = 0; i < keys.length; i++) {
      const list = FIELDS[keys[i]];
      for (let j = 0; j < list.length; j++) if (keyOf(list[j]) === k) return keys[i];
    }
    return '';
  };

  /**
   * 从一张 `table.kh-table-fetch` 里取出我们关心的字段值。
   * 跳过合并行（`tr.kh-merge-row` 的左列是自定义标题，可能正好叫「开发者」之类的同名字段）。
   * @returns {{title:string, dev:string, entity:string, link:string, policy:string}}
   */
  /**
   * 取单元格里「字段名」的纯文本，**跳过我们自己插进去的小标**（`.kh-policy-flag`）。
   *
   * 2.0.8.9 修：`paintPolicy` 会把「名」「开」两枚徽标 append 进左列，之后再读
   * `td.textContent` 就变成「隐私政策名开」，`fieldKey` 的全等匹配必然落空 ⇒ 该行从
   * `fields` 里凭空消失 ⇒ 已经涂绿的卡片下一轮被判成「没有」、或者干脆不涂色。
   * 用户报的「隐私政策里明明有，小标却说没有；有时候底色变绿了还说没有」就是这条。
   * 所以字段名一律从这里取，不要直接读 `textContent`。
   *
   * ⚠️ 只能**从末尾按徽标逆序剥**，不能 `split(text).join('')` 全局删：
   *   字段名本身就可能含「名」（`应用名称` / `软件名称`）。全局删会把字吃掉、字段又丢一次 ——
   *   那正是这条修复要根治的现象，换成另一个入口复发而已。
   *   徽标是 append 进去的，所以一定是**后缀**；不是后缀（结构被动过）就不动，宁可这条不认。
   */
  NoteCheck.labelText = function (td) {
    if (!td) return '';
    /* 合并行（2.0.8.14 修）：`fetch.js` 把「值完全相同」的字段并成一行，标签格长这样
     *   `<span class="kh-lbt">开发者</span><details>2 + 开发者 / 核准主体名称</details>`
     * 直接读 textContent 会得到「开发者2开发者核准主体名称」，`fieldKey` 全等匹配必然落空
     * ⇒ 该行被当成不认识的字段 ⇒ `readFields` 里 dev / entity 是空 ⇒ 只校验主标题就涂绿
     * （假绿），同法人校验也整条跳过。用户报的「应用名称和开发者是否一致似乎还是有问题」
     * 就是这条：开发者与核准主体名称同值时**必然**走到。
     * 所以合并行取 `.kh-lbt` 的文本（最短的那个字段名），展开区交给 `labelsOf`。 */
    const lbt = td.querySelector ? td.querySelector('.kh-lbt') : null;
    if (lbt) return String(lbt.textContent || '');
    let s = String(td.textContent || '');
    const flags = td.querySelectorAll ? td.querySelectorAll('.kh-policy-flag') : [];
    for (let i = flags.length - 1; i >= 0; i--) {
      const t = String(flags[i].textContent || '');
      if (!t) continue;
      if (s.slice(-t.length) === t) s = s.slice(0, -t.length);
    }
    /* 判定小标（✔一致 / ⚠待确认 / ？未查明）也是 append 的后缀，同样从右端剥掉：
     * 不剥的话下一轮 labelsOf 会读到「企业名称✔ 一致」，字段名认不出来 ⇒ 判定整条失效。 */
    const marks = td.querySelectorAll ? td.querySelectorAll('.kh-verdict') : [];
    for (let i = marks.length - 1; i >= 0; i--) {
      const t = String(marks[i].textContent || '');
      if (!t) continue;
      if (s.slice(-t.length) === t) s = s.slice(0, -t.length);
    }
    /* 徽标排在展开区后面，所以先剥徽标、再剥展开区（<details> 的计数与全部字段名）。 */
    const more = td.querySelector ? td.querySelector('.kh-table-more') : null;
    if (more) {
      const t = String(more.textContent || '');
      if (t && s.slice(-t.length) === t) s = s.slice(0, -t.length);
    }
    return s;
  };

  /**
   * 一行左列里**所有**字段名（合并行会带回多个；普通行只有一个）。
   * 来源两处，哪个在就用哪个：
   *   · `.kh-lbt[title]` —— `fetch.js` 用 `/` 把全部字段名连起来（用户字段名极少数才含 `/`，
   *     所以这条只当粗线索，真正的准绳是下面那条）；
   *   · `.kh-table-all` 的子节点 —— 字段名之间是 `<br>`，逐段收不会把名字粘在一起。
   * @returns {string[]} 原文（未归一），可能为空
   */
  NoteCheck.labelsOf = function (td) {
    const out = [];
    const push = (s) => {
      const t = String(s == null ? '' : s).trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    };
    if (!td) return out;
    const lbt = td.querySelector ? td.querySelector('.kh-lbt') : null;
    if (lbt) {
      const title = lbt.getAttribute ? String(lbt.getAttribute('title') || '') : '';
      if (title) title.split('/').forEach(push);
      push(lbt.textContent);
    }
    const all = td.querySelector ? td.querySelector('.kh-table-all') : null;
    if (all && all.childNodes) {
      let buf = '';
      for (let i = 0; i < all.childNodes.length; i++) {
        const n = all.childNodes[i];
        /* 真 DOM 里 br 的 nodeName / tagName 都是 BR；单测垫片只给 tagName。两处都认。 */
        const tag = String((n && (n.tagName || n.nodeName)) || '').toUpperCase();
        if (n && n.nodeType === 1 && tag === 'BR') { push(buf); buf = ''; continue; }
        buf += String((n && n.textContent) || '');
      }
      push(buf);
    }
    if (!out.length) push(NoteCheck.labelText(td));
    return out;
  };

  /** 一行左列可能是哪几个字段 key（合并行 ⇒ 多个）；读值统一走 `readFields`。 */
  NoteCheck.fieldKeysOf = function (td) {
    const out = [];
    const labels = NoteCheck.labelsOf(td);
    for (let i = 0; i < labels.length; i++) {
      const k = NoteCheck.fieldKey(labels[i]);
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  };

  NoteCheck.readFields = function (tableEl) {
    const out = { title: '', dev: '', entity: '', link: '', policy: '' };
    if (!tableEl || !tableEl.querySelectorAll) return out;
    const trs = tableEl.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      if (String(tr.className || '').indexOf('kh-merge-row') >= 0) continue;
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const keys = NoteCheck.fieldKeysOf(tds[0]);
      if (!keys.length) continue;
      const val = tds.length > 1 ? String(tds[1].textContent || '').trim() : '';
      /* 合并行里几个字段共用一个值 —— 它们本来就是因为值完全相同才被并到一起的。 */
      for (let j = 0; j < keys.length; j++) if (!out[keys[j]]) out[keys[j]] = val;
    }
    return out;
  };

  /* ---------- ① 隐私政策校验 ---------- */

  /** 这个值看起来是一条 http(s) 链接吗？
   *  抓取表里「隐私政策」那一格有时抓到的不是正文，而是链接本身（用户实测：
   *  打开链接明明是正文，判定却说没有 —— 因为那一格只有 URL）。 */
  NoteCheck.looksLikeUrl = function (s) {
    return /^https?:\/\/\S+$/i.test(String(s == null ? '' : s).trim());
  };

  /**
   * 这张卡能从哪儿取到「隐私政策链接」：
   *   ① 抓取值本身就是 URL（抓到的就是链接）；
   *   ② 另有「隐私政策链接」字段是 URL。
   * 返回 `{url, from:'policy'|'link'}` 或 `null`。只做选取，不发请求。
   */
  NoteCheck.policySource = function (fields) {
    const f = fields || {};
    const p = String(f.policy || '').trim();
    if (NoteCheck.looksLikeUrl(p)) return { url: p, from: 'policy' };
    const l = String(f.link || '').trim();
    if (NoteCheck.looksLikeUrl(l)) return { url: l, from: 'link' };
    return null;
  };

  /* 单位名常见后缀：只在「像单位名」的时候才允许行政区划写法差异，
   * 普通短词/人名绝不近似（单字、两字近似会全员命中，宁可标没查到也不假绿）。 */
  const ORG_SUFFIX_WORDS = ['公司', '中心', '集团', '银行', '医院', '学校', '大学', '学院', '工作室',
    '事务所', '合作社', '协会', '基金会', '研究院', '研究所', '融媒体', '报社', '电视台', '出版社'];

  /** 去掉括号补充说明：「某某公司（松江报社）」→「某某公司」。全角/半角括号都认。 */
  function coreOf(s) {
    return String(s == null ? '' : s).replace(/[（(][^）)]*[）)]/g, '');
  }

  /** 像不像一个单位名（要有单位后缀，且去掉括号后仍够长）。 */
  function orgLike(s) {
    if (String(s || '').length < 8) return false;
    for (let i = 0; i < ORG_SUFFIX_WORDS.length; i++) if (String(s).indexOf(ORG_SUFFIX_WORDS[i]) >= 0) return true;
    return false;
  }

  /**
   * 去掉行政区划单字（省/市/区/县）：同一家单位在卡片与政策正文里常一个写全称
   * 「上海市松江区融媒体中心」、一个写简称「上海松江融媒体中心」（用户 2026-11-11 的
   * 松江案例）。只在 `orgLike` 成立时用，且要求剩余长度 ≥ 6，避免把普通词比成一家。
   */
  function stripAdmin(s) {
    return String(s || '').replace(/[省市区县]/g, '');
  }

  /**
   * 子串判定：正文与目标都归一后比较；目标不足 2 个字符不判（单字人名/单字母会全员命中，
   * 宁可标「没查到」也不假绿）。目标里带 `…`/`...` 的截断值只取省略号之前那段。
   *
   * 三种「正文里其实有」的写法差异都算命中（都由用户实测案例逼出来的）：
   *   ① 括号补充：卡片写「银飞数智（广东）科技有限公司」，正文只写「银飞数智科技有限公司」；
   *   ② 行政区划：卡片「上海市松江区融媒体中心」，正文「上海松江融媒体中心」；
   *   ③ 标题后缀：卡片「某某清理大师APP」，正文只写「某某清理大师」。
   * 近似只放宽「写法」，不放宽「是不是同一家」：单位名必须带单位后缀且至少 8 字。
   */
  NoteCheck.contains = function (hay, needle, kind) {
    return NoteCheck.matchMode(hay, needle, kind) > 0;
  };

  /**
   * 命中程度：0=没命中，1=原文一致，2=只差括号补充/标题后缀，3=单位名行政区划写法不同，
   * 4=长词里只差 1 个字（卡片值被 OCR/录入认错，正文是另一个字）。
   * 界面据此在「找到了」后面补一句「写法略有差异」，避免用户以为插件在乱认。
   */
  NoteCheck.matchMode = function (hay, needle, kind) {
    const h = flat(hay);
    let n = flat(needle);
    if (!h || !n) return 0;
    n = n.replace(/(…|\.\.\.).*$/, '');
    if (n.length < 2) return 0;
    if (h.indexOf(n) >= 0) return 1;

    /* ① 去掉括号补充说明再比（正文里常省略「（松江报社、…）」这类注释）。 */
    const core = flat(coreOf(needle)).replace(/(…|\.\.\.).*$/, '');
    if (core.length >= 4 && core !== n && h.indexOf(core) >= 0) return 2;

    /* ② 单位名：行政区划写法不同也算同一家（上海市松江区 ↔ 上海松江）。 */
    if (orgLike(core)) {
      const bare = stripAdmin(core);
      if (bare.length >= 6 && (h.indexOf(bare) >= 0 || stripAdmin(h).indexOf(bare) >= 0)) return 3;
    }

    /* ③ 标题带 APP / 客户端 / 平台后缀，正文只写名字。 */
    if (kind === 'title') {
      const t = n.replace(/(?:app|客户端|安卓版|ios版|手机版|平台版)$/i, '');
      if (t.length >= 2 && t !== n && h.indexOf(t) >= 0) return 2;
    }

    /* ④ 【2026-11-11】卡片值被 OCR/录入错了 1 个字，正文里其实是另一个字
     * （用户案例：卡片「飞翔的红蜻挺」，正文是「飞翔的红蜻蜓」）。
     * 只在**长词 + 有足够多汉字**时放宽：短词放 1 个字就变成另一家了，宁可判红；
     * 纯数字/编号不许近似（登记号差一位就是另一个号）。 */
    if (n.length >= 6 && n.length <= 40 && chineseCount(n) >= 4 && nearIndexOf(h, n) >= 0) return 4;
    return 0;
  };

  function chineseCount(s) {
    const m = String(s == null ? '' : s).match(/[\u4e00-\u9fa5]/g);
    return m ? m.length : 0;
  }

  /** 在 h 里找与 n **等长、只差 1 个字符**的窗口；找不到返回 -1。 */
  function nearIndexOf(h, n) {
    const len = n.length;
    if (h.length < len) return -1;
    for (let i = 0; i + len <= h.length; i++) {
      let diff = 0;
      for (let j = 0; j < len; j++) {
        if (h.charCodeAt(i + j) !== n.charCodeAt(j)) {
          diff++;
          if (diff > 1) break;
        }
      }
      if (diff === 1) return i;
    }
    return -1;
  }

  /** 「隐私政策链接」抓到的东西在正文里有没有：整串没有就退一步只看域名。 */
  function linkHit(policy, link) {
    const raw = String(link || '').trim();
    if (!raw) return null;                    // 没这个字段：不参与判定
    const f = flat(policy);
    if (f.indexOf(flat(raw)) >= 0) return true;
    const m = /^https?:\/\/([^/?#]+)/i.exec(raw);
    if (!m) return false;
    const host = String(m[1] || '').replace(/^www\./i, '').toLowerCase();
    if (!host) return false;
    return f.indexOf(host) >= 0;
  }

  /**
   * @param {{title,dev,link,policy}} fields
   * @returns {null | {ok:boolean, items:Array<{key:string, needle:string, hit:boolean}>}}
   *          `null` = 这张卡没有可校验的内容（没有隐私政策正文 / 没有可比的项）
   */
  NoteCheck.policyVerdict = function (fields) {
    const f = fields || {};
    const policy = String(f.policy || '').trim();
    /* 正文太短多半抓的是「查看隐私政策」这种按钮文字，不当正文用（否则永远全红）。 */
    if (flat(policy).length < 8) return null;
    const items = [];
    const add = (key, needle) => {
      const v = String(needle || '').trim();
      if (!v) return;
      const mode = NoteCheck.matchMode(policy, v, key);
      items.push({ key: key, needle: v, hit: mode > 0, mode: mode });
    };
    add('title', f.title);
    add('dev', f.dev);
    const lh = linkHit(policy, f.link);
    if (lh !== null) items.push({ key: 'content', needle: String(f.link || '').trim(), hit: lh });
    if (!items.length) return null;
    /* `missing` 给悬停文案用：没抓到的项不出结论，但要让用户看见「这一项没校验」，
     * 而不是以为「已经校验过并且通过了」。 */
    const missing = [];
    if (!String(f.title || '').trim()) missing.push('title');
    if (!String(f.dev || '').trim()) missing.push('dev');
    return { ok: items.every((it) => it.hit), items: items, missing: missing, len: flat(policy).length };
  };

  /* ---------- ② 同法人校验 ---------- */

  /* 个人名判定的反面清单：带这些字样的当「单位」，其余 2–6 个字的中文名当「个人」。 */
  const ORG_WORDS = [
    '公司', '集团', '企业', '工作室', '中心', '商店', '店', '厂', '研究所', '所', '学院', '学校',
    '医院', '研究院', '大学', '部', '局', '委员会', '协会', '学会', '基金会', '合作社', '事务所',
    '经营部', '门市', '商行', '商城', '基地', '农场', '银行', '支行', '分行', '通讯', '网络',
    '科技', '信息', '传媒', '文化', '商贸', '贸易', '电子', '实业', '投资', '管理', '咨询',
    '服务', '技术', '有限', '股份', '合伙', '个体', '单位', '组织', '社', '行', '馆', '城', '站'
  ];

  /** 归一：去空白、去掉括号里的补充说明、全角括号转半角、小写。 */
  function entityNorm(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, '')
      .replace(/（[^）]*）|\([^)]*\)/g, '')
      .toLowerCase();
  }
  NoteCheck.entityNorm = entityNorm;

  /** 这个主体名看起来是不是「个人」（自然人）。 */
  NoteCheck.isPersonName = function (name) {
    const n = entityNorm(name);
    if (!n) return false;
    for (let i = 0; i < ORG_WORDS.length; i++) if (n.indexOf(ORG_WORDS[i]) >= 0) return false;
    /* 个体工商户常见写法带「·」的少数民族名，或 2–6 个中文/字母；再长就不当人名（避免误判）。 */
    return /^[\u4e00-\u9fa5·]{2,6}$/.test(n) || /^[a-z][a-z .]{2,30}$/.test(n);
  };

  /**
   * 一方的「法人」是谁：
   *   · 个人当主体 ⇒ 法定代表人是本人（用户口径）；
   *   · 单位 ⇒ 用查到的法人名；查不到就是空串。
   * @param {{name:string, rep?:string}} side
   */
  NoteCheck.repOf = function (side) {
    const s = side || {};
    const name = entityNorm(s.name);
    if (!name) return '';
    if (NoteCheck.isPersonName(name)) return name;
    return entityNorm(s.rep);
  };

  /**
   * @param {{name:string, rep?:string}} a 开发者一侧
   * @param {{name:string, rep?:string}} b 核准主体一侧
   * @returns {'same'|'diff'|'unknown'}  unknown = 有单位没查到法人（用户口径：不改底色）
   */
  NoteCheck.sameLegalRep = function (a, b) {
    const na = entityNorm(a && a.name);
    const nb = entityNorm(b && b.name);
    if (!na || !nb) return 'unknown';
    if (na === nb) return 'same';            // 同一主体：不用查也是同法人
    const ra = NoteCheck.repOf(a);
    const rb = NoteCheck.repOf(b);
    if (!ra || !rb) return 'unknown';
    return ra === rb ? 'same' : 'diff';
  };

  /* ---------- ③ 资质里的企业名称 vs 开发者 ---------- */

  /**
   * 营业执照 / 资质里抽到的「企业名称」与卡片里抓取到的「开发者」是否一致。
   * 用户口径（2026-11-13）：一致 ⇒ 绿；不一致 ⇒ 黄；缺一边 ⇒ 不涂色（不能假装校验过）。
   * @returns {{state:'same'|'diff'|'unknown', color:string, note:string, company:string, dev:string}}
   */
  NoteCheck.qualVerdict = function (company, dev) {
    const c = entityNorm(company);
    const d = entityNorm(dev);
    const rawC = String(company == null ? '' : company).trim();
    const rawD = String(dev == null ? '' : dev).trim();
    if (!c || !d) {
      return {
        state: 'unknown',
        color: '',
        note: !c ? '没有取到资质里的企业名称' : '卡片里没有「开发者」，无法比对',
        company: rawC,
        dev: rawD
      };
    }
    if (c === d) return { state: 'same', color: NoteCheck.COLOR_OK, note: '企业名称与开发者一致', company: rawC, dev: rawD };
    /* 同一家单位的全称 / 简称：只在两边都够长、且互相包含时放行，避免短词误绿。 */
    if (c.length >= 6 && d.length >= 6 && (c.indexOf(d) >= 0 || d.indexOf(c) >= 0)) {
      return { state: 'same', color: NoteCheck.COLOR_OK, note: '企业名称与开发者写法略有差异，按同一家处理', company: rawC, dev: rawD };
    }
    return { state: 'diff', color: NoteCheck.COLOR_BAD, note: '企业名称与开发者不一致，请人工确认', company: rawC, dev: rawD };
  };

  /* ---------- ④ 承诺函的承诺对象 ---------- */
  /* 明确点名了别家平台 ⇒ 即使行文里也带「应用平台」也不放行。这份表是「反面清单」，
   * 与放行名单不同：它不随配置走（配置只决定放行什么，不决定谁算别家）。 */
  const PROMISE_OTHER = /华为|huawei|小米|xiaomi|oppo|广东欢太|欢太|应用宝|腾讯|荣耀|honor|三星|samsung|魅族|meizu|中兴|努比亚|一加|realme|抖音|快手|百度|阿里/i;
  const PROMISE_GENERIC = /未指定具体平台|各?应用平台|各?应用市场|各?应用商店|各大渠道|所有渠道/;

  /** 名单项按**字面子串**匹配：转义元字符后拼成一条正则（用户填 `.*` 不会被当成通配）。 */
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 放行名单的唯一取值路径（【台账 #7】名单可配）：
   *   · 调用方给 `list`（面板传 `cfg.noteCheck`）→ 用它；
   *   · 没给 → 回退 `KH.Config.defaults.noteCheck.promiseOk`（默认 vivo / 维沃 / 天宸）；
   *   · 清洗一律走 `KH.Config.normalizeNoteCheck`，本文件不再写第二份去重/限量逻辑。
   * @returns {string[]}
   */
  NoteCheck.promiseOkList = function (raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.promiseOk;
    if (raw === undefined || raw === null) {
      const d = (typeof KH !== 'undefined' && KH.Config && KH.Config.defaults && KH.Config.defaults.noteCheck) || null;
      raw = d ? d.promiseOk : [];
    }
    const C = (typeof KH !== 'undefined' && KH.Config) || null;
    if (C && typeof C.normalizeNoteCheck === 'function') return C.normalizeNoteCheck(raw).promiseOk;
    return Array.isArray(raw) ? raw.map(s => String(s == null ? '' : s).trim()).filter(Boolean) : [];
  };

  /**
   * 承诺对象判定：命中放行名单 ⇒ 绿；无具体平台的泛称 ⇒ 绿；
   * 其余平台（华为、小米、OPPO、广东欢太…）与认不出的写法 ⇒ 黄，交人工确认。
   * 名单为空也照样判：此时没有任何平台被放行，说明里必须直说「名单为空」，
   * 否则用户会以为是插件没认出 vivo（【台账 #7】判据：改名单无需改代码即生效）。
   * @param {string} target 承诺对象原文
   * @param {string[]|{promiseOk:string[]}} [list] 放行名单；省略回退默认名单
   * @returns {{state:'ok'|'warn'|'unknown', color:string, note:string, target:string}}
   */
  NoteCheck.promiseVerdict = function (target, list) {
    const raw = String(target == null ? '' : target).trim();
    const okList = NoteCheck.promiseOkList(list);
    const names = okList.join(' / ');
    if (!raw) return { state: 'unknown', color: '', note: '没有取到承诺对象', target: '' };
    const hit = okList.length ? new RegExp(okList.map(escapeRe).join('|'), 'i').test(raw) : false;
    if (hit) {
      return { state: 'ok', color: NoteCheck.COLOR_OK, note: '承诺对象在放行名单（' + names + '）', target: raw };
    }
    if (!PROMISE_OTHER.test(raw) && PROMISE_GENERIC.test(raw)) {
      return { state: 'ok', color: NoteCheck.COLOR_OK, note: '没有指向具体平台，按应用平台泛称放行', target: raw };
    }
    return {
      state: 'warn',
      color: NoteCheck.COLOR_BAD,
      target: raw,
      note: okList.length
        ? ('承诺对象不是 ' + names + '，请人工确认')
        : '放行名单为空（设置页 › 样式配置可添加），请人工确认'
    };
  };

  /* ---------- ⑤ 判定三态的非颜色标记（台账 #3/#4/#5） ---------- */

  /**
   * 一致 / 不一致 / 未查明三态的**非颜色**标记（图标 + 两字文案）。
   * 为什么必须有：颜色只能算辅助 —— 灰度截图、色觉障碍、打印出来时
   * 「浅绿一致 / 浅黄不一致 / 不涂色未查明」三态长得一模一样（WCAG 1.4.1 要求信息不单靠颜色）。
   * 图标与文案只写这一份：面板层 `setVerdictMark` 直接取，单测也断言这里，别在两处各写一套。
   * @param {string} state same|ok（一致）/ diff|warn（待确认）/ unknown（未查明）
   * @returns {{state:string, icon:string, text:string, label:string}|null} 不认识的态返回 null
   */
  NoteCheck.verdictMark = function (state) {
    const s = String(state == null ? '' : state);
    const map = {
      same: { icon: '✔', text: '一致' },
      ok: { icon: '✔', text: '一致' },
      diff: { icon: '⚠', text: '待确认' },
      warn: { icon: '⚠', text: '待确认' },
      unknown: { icon: '？', text: '未查明' },
      /* 【台账 #8】超时和「查不到法人 / 未查明」不是一回事：20 秒没回执要单独说得出来。 */
      timeout: { icon: '⏱', text: '超时' }
    };
    const m = map[s];
    if (!m) return null;
    return { state: s, icon: m.icon, text: m.text, label: m.icon + ' ' + m.text };
  };

  KH.NoteCheck = NoteCheck;
})();
