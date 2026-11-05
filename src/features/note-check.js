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

  /** 正文归一：去所有空白（含全角空格）+ 小写 —— 隐私政策常把公司名断行写。 */
  function flat(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000\u200b]/g, ' ')
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
  NoteCheck.readFields = function (tableEl) {
    const out = { title: '', dev: '', entity: '', link: '', policy: '' };
    if (!tableEl || !tableEl.querySelectorAll) return out;
    const trs = tableEl.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      if (String(tr.className || '').indexOf('kh-merge-row') >= 0) continue;
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const key = NoteCheck.fieldKey(tds.length ? tds[0].textContent : '');
      if (!key || out[key]) continue;
      out[key] = tds.length > 1 ? String(tds[1].textContent || '').trim() : '';
    }
    return out;
  };

  /* ---------- ① 隐私政策校验 ---------- */

  /**
   * 子串判定：正文与目标都归一后比较；目标不足 2 个字符不判（单字人名/单字母会全员命中，
   * 宁可标「没查到」也不假绿）。目标里带 `…`/`...` 的截断值只取省略号之前那段。
   */
  NoteCheck.contains = function (hay, needle) {
    const h = flat(hay);
    let n = flat(needle);
    if (!h || !n) return false;
    n = n.replace(/(…|\.\.\.).*$/, '');
    if (n.length < 2) return false;
    return h.indexOf(n) >= 0;
  };

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
      items.push({ key: key, needle: v, hit: NoteCheck.contains(policy, v) });
    };
    add('title', f.title);
    add('dev', f.dev);
    const lh = linkHit(policy, f.link);
    if (lh !== null) items.push({ key: 'content', needle: String(f.link || '').trim(), hit: lh });
    if (!items.length) return null;
    return { ok: items.every((it) => it.hit), items: items };
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

  KH.NoteCheck = NoteCheck;
})();
