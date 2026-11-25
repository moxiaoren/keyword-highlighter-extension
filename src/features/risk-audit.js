/**
 * src/features/risk-audit.js · 主标题 / 图标的本地风险初筛
 * ----------------------------------------------------------------------------
 * 【2.0.18 · 用户 m24795】口径：
 *   「默认从重要笔记里面获取主标题和图标（icon）字段抓取到的内容，搜索是否涉及蹭词，
 *     资金盘，色情低俗，诈骗等风险内容。」
 *   · 这一段只做本地词库：零联网、零额度、毫秒级。命中的写清「哪个词、属于哪一类」；
 *     图标像素本身认不了仿冒，交给用户点「AI 深查」（面板把名称与图标交给太极AI 联网核验）。
 *   · 词库口径与 2.0.8.7 那版一致（品牌词 + 六类敏感词，含插空格/标点变体归一），
 *     那一版整条功能后来被移除（2.0.16.5），本次按新设计重建、只保留本地这一段。
 *
 * 数据从渲染好的抓取表里取，不重新解析页面：卡片的 .kh-table-fetch 里
 * 已经有字段名与值（图片是安全 img），与隐私政策校验走同一份 DOM。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const Risk = {};

  /* ---------- 词表 ---------- */

  /** 知名应用 / 品牌：命中即「蹭」的嫌疑。中英文常见写法都收。 */
  const BRANDS = [
    '微信', 'wechat', 'weixin', '支付宝', 'alipay', '淘宝', 'taobao', '天猫', 'tmall',
    '京东', 'jingdong', '拼多多', 'pinduoduo', '抖音', 'douyin', 'tiktok',
    '快手', 'kuaishou', '小红书', 'xiaohongshu', '微博', 'weibo',
    '哔哩哔哩', 'bilibili', 'b站', '知乎', 'zhihu', '百度', 'baidu', '腾讯', 'tencent',
    '阿里巴巴', 'alibaba', '字节跳动', 'bytedance', '美团', 'meituan', '饿了么', 'eleme',
    '滴滴', 'didi', '携程', 'ctrip', '去哪儿', 'qunar', '高德', 'amap',
    '华为', 'huawei', '小米', 'xiaomi', '苹果', 'apple', '谷歌', 'google',
    '微软', 'microsoft', '亚马逊', 'amazon', '奈飞', 'netflix', 'paypal', 'visa',
    'mastercard', '银联', 'unionpay', '云闪付', '数字人民币', '中国银行', '工商银行',
    '建设银行', '农业银行', '招商银行', '交通银行', '邮政储蓄', '12306', '交管12123',
    '国家反诈中心', '王者荣耀', '原神', '和平精英', '钉钉', 'dingtalk',
    '企业微信', '飞书', 'zoom', 'telegram', 'whatsapp', 'instagram', 'facebook',
    'youtube', 'twitter', 'chatgpt', 'openai', 'deepseek', '文心一言', '通义千问', 'kimi'
  ];

  /** 敏感内容：按监管口径分类，命中任一词即算高风险。 */
  const SENSITIVE = [
    {
      tag: '赌博',
      words: ['赌博', '博彩', '赌场', 'casino', 'betting', '六合彩', '时时彩', '北京赛车',
        '体育投注', '足球投注', '真人荷官', '百家乐', '老虎机', '彩票代购',
        '私彩', '球彩', '竞猜下注', '德州扑克', '电玩城']
    },
    {
      tag: '色情低俗',
      words: ['色情', '情色', '成人视频', '约炮', '一夜情', '福利姬', '黄片', 'av视频',
        '裸聊', '性爱', '成人社区', '楼凤', '外围女', '低俗', '擦边', '软色情',
        '福利视频', '成人版', '禁片', '偷拍']
    },
    {
      tag: '资金盘',
      words: ['资金盘', '传销', '互助盘', '拆分盘', '返利盘', '庞氏', '挖矿理财', '日息',
        '保本高收益', '稳赚不赔', '躺赚', '拉人头', '发展下线', '静态收益', '动态收益',
        '消费返利', '购物返现', '积分盘', '复利', '量化跟单', '外汇托管']
    },
    {
      tag: '诈骗',
      words: ['诈骗', '刷单', '杀猪盘', '冒充客服', '猜猜我是谁', '中奖领取', '退款理赔',
        '安全账户', '解冻资金', '洗白征信', '征信修复', '代办信用卡', '套现', '跑分',
        '代收款', '四件套', '黑户贷款', '内部渠道下款']
    },
    {
      tag: '违规贷款',
      words: ['秒批', '无抵押贷款', '高利贷', '714高炮', '砍头息', '裸贷', '校园贷',
        '套路贷', '过桥贷', '极速下款', '无视征信']
    },
    {
      tag: '其它',
      words: ['虚拟币', 'usdt', '炒币', 'ico', '代币发行', '交易所返佣', '枪支', '迷药',
        '代开发票', '办证', '黑客接单', '私家侦探']
    }
  ];

  Risk.BRANDS = BRANDS;
  Risk.SENSITIVE = SENSITIVE;
  /** 主标题字段的别名：与 compare/sources.js 的 title 同口径。 */
  Risk.TITLE_ALIASES = ['主标题', '标题', '应用名称', '应用名', '软件名称', 'APP名称', 'app名称'];

  /** 归一：去空格/标点/括号并小写，让「微 信」「微信·」落在同一套比较上。 */
  Risk.normalizeName = function (name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[\s\u3000·．.\-_—–~!！?？,，、:：;；/\\|'"“”‘’()（）\[\]【】《》<>+*&#@$%^&]/g, '');
  };

  /* 【2.0.17.5 · 用户 m26374】类别码与中文名的单一真源：码用于存配置，中文用于卡片与设置页下拉。 */
  Risk.CATS = (typeof KH !== 'undefined' && KH.Config && KH.Config.RISK_CATS) || ['brand', 'gamble', 'porn', 'fund', 'fraud', 'loan', 'other'];
  Risk.CAT_LABEL = { brand: '品牌', gamble: '赌博', porn: '色情低俗', fund: '资金盘', fraud: '诈骗', loan: '违规贷款', other: '其它' };

  /**
   * 生效词库 = 内置基线 − 用户停用 + 用户自定义。
   * 停用按**归一后**比对（用户存的是小写去空白的写法），所以「微 信」停不掉「微信」这种事不会发生。
   * @param {Object} [cfg] 整份配置（读 `cfg.riskLexicon`）；不传 = 纯内置
   * @returns {{brands:string[], cats:Array<{tag:string,words:string[]}>}}
   */
  Risk.lexicon = function (cfg) {
    const lx = (cfg && cfg.riskLexicon) || {};
    const off = {};
    const ds = Array.isArray(lx.disabled) ? lx.disabled : [];
    for (let i = 0; i < ds.length; i++) {
      const k = Risk.normalizeName(ds[i]);
      if (k) off[k] = true;
    }
    const keep = function (w) { return !off[Risk.normalizeName(w)]; };
    const out = { brands: BRANDS.filter(keep), cats: [] };
    for (let i = 0; i < SENSITIVE.length; i++) {
      out.cats.push({ tag: SENSITIVE[i].tag, cat: SENSITIVE[i].cat || '', words: SENSITIVE[i].words.filter(keep) });
    }
    const list = Array.isArray(lx.custom) ? lx.custom : [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      const w = String(it.w == null ? '' : it.w).trim();
      if (!w || !keep(w)) continue;
      const cat = Risk.CATS.indexOf(String(it.cat || '')) >= 0 ? String(it.cat) : 'other';
      if (cat === 'brand') { out.brands.push(w); continue; }
      const tag = Risk.CAT_LABEL[cat] || '其它';
      let g = null;
      for (let k = 0; k < out.cats.length; k++) if (out.cats[k].tag === tag) { g = out.cats[k]; break; }
      if (!g) { g = { tag: tag, cat: cat, words: [] }; out.cats.push(g); }
      g.words.push(w);
    }
    return out;
  };

  /**
   * 名称本地初筛。
   * @param {string} name
   * @param {Object} [cfg] 配置（带自定义词库）；不传 = 纯内置词库
   * @returns {{level:number, verdict:string, hits:Array}}
   *   level 2 = risky（命中禁止类词，或与品牌完全同名）；1 = suspect（名称里含品牌，疑似蹭）；0 = safe
   */
  Risk.screen = function (name, cfg) {
    const n = Risk.normalizeName(name);
    const hits = [];
    if (!n) return { level: 0, verdict: 'safe', hits: hits };
    const lex = Risk.lexicon(cfg);

    for (let i = 0; i < lex.cats.length; i++) {
      const cat = lex.cats[i];
      for (let k = 0; k < cat.words.length; k++) {
        const w = Risk.normalizeName(cat.words[k]);
        if (w && n.indexOf(w) >= 0) {
          hits.push({ kind: 'sensitive', tag: cat.tag, word: cat.words[k] });
        }
      }
    }

    for (let i = 0; i < lex.brands.length; i++) {
      const b = Risk.normalizeName(lex.brands[i]);
      if (!b) continue;
      if (n === b) hits.push({ kind: 'brand', tag: '同名', word: lex.brands[i], exact: true });
      else if (b.length >= 2 && n.indexOf(b) >= 0) hits.push({ kind: 'brand', tag: '蹭品牌', word: lex.brands[i], exact: false });
    }

    let level = 0;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].kind === 'sensitive' || hits[i].tag === '同名') { level = 2; break; }
      level = 1;
    }
    return { level: level, verdict: level >= 2 ? 'risky' : (level === 1 ? 'suspect' : 'safe'), hits: hits };
  };

  /* ---------- 从卡片抓取表里取「主标题 / 图标」 ---------- */

  function sources() {
    const C = (typeof KH !== 'undefined' && KH && KH.Compare) || null;
    return (C && C.Sources) || null;
  }

  function keyOf(s) {
    const S = sources();
    if (S && typeof S.keyOf === 'function') return S.keyOf(s);
    return Risk.normalizeName(s);
  }

  function labelsOf(td) {
    const S = sources();
    if (S && typeof S.labelsOf === 'function') {
      try { return S.labelsOf(td) || []; } catch (e) { /* 落到下面的兜底 */ }
    }
    const out = [];
    if (!td) return out;
    const lbt = td.querySelector ? td.querySelector('.kh-lbt') : null;
    const t = String((lbt || td).textContent || '').trim();
    if (t) out.push(t);
    return out;
  }

  function cellText(td) {
    const S = sources();
    if (S && typeof S.cellValue === 'function') {
      try { return String(S.cellValue(td) || ''); } catch (e) { /* 兜底 */ }
    }
    return String((td && td.textContent) || '').trim();
  }

  /** 图标字段名：图标/icon/logo/应用图标 都算（后缀如 #图 已被字段名解析剥掉）。 */
  function isIconLabel(label) {
    const t = String(label == null ? '' : label).trim().toLowerCase();
    if (!t) return false;
    return /(^|[\s/、,，])(图标|应用图标|app图标|icon|logo)($|[\s/、,，])/.test(t) ||
      /^(图标|应用图标|app图标|icon|logo)$/.test(t);
  }

  function isTitleLabel(label) {
    const k = keyOf(label);
    for (let i = 0; i < Risk.TITLE_ALIASES.length; i++) if (keyOf(Risk.TITLE_ALIASES[i]) === k) return true;
    return false;
  }

  /** 从值格里取第一张图（站内相对地址补成绝对；data: 原样）。 */
  function firstImgSrc(td) {
    if (!td || !td.querySelector) return '';
    const img = td.querySelector('img');
    if (!img) return '';
    const src = String(img.getAttribute('src') || img.src || '').trim();
    if (!src || /^data:/i.test(src)) return src;
    try { return new URL(src, (typeof location !== 'undefined' && location.href) || undefined).href; }
    catch (e) { return src; }
  }

  /**
   * 读一张抓取表里的主标题与图标。
   * @param {Element} tableEl table.kh-table-fetch
   * @returns {{found:boolean,title:string,icon:string}}
   */
  Risk.readCard = function (tableEl) {
    const out = { found: false, title: '', icon: '' };
    if (!tableEl || !tableEl.querySelectorAll) return out;
    const trs = tableEl.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      if (String(tr.className || '').indexOf('kh-merge-row') >= 0) continue;
      if (tr.getAttribute && tr.getAttribute('data-kh-ghost')) continue;
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const labels = labelsOf(tds[0]);
      for (let j = 0; j < labels.length; j++) {
        const label = labels[j];
        if (!out.title && isTitleLabel(label)) {
          const v = cellText(tds.length > 1 ? tds[1] : null).trim();
          if (v) out.title = v;
        }
        if (!out.icon && isIconLabel(label)) {
          const src = firstImgSrc(tds.length > 1 ? tds[1] : tds[0]);
          if (src) out.icon = src;
        }
      }
    }
    out.found = !!(out.title || out.icon);
    return out;
  };

  /**
   * 一张卡片的完整本地初筛：有主标题才判（没有名称无从判断），图标只带出去给 AI 深查。
   * @returns {{ok:boolean,title:string,icon:string,level:number,verdict:string,hits:Array}}
   */
  Risk.auditCard = function (tableEl, cfg) {
    const got = Risk.readCard(tableEl);
    const res = Risk.screen(got.title, cfg);
    return {
      ok: !!got.title,
      title: got.title,
      icon: got.icon,
      level: res.level,
      verdict: res.verdict,
      hits: res.hits
    };
  };

  /* ---------- 自动深查：缓存键 / 结果态（2.0.17.3 · 用户 m25410） ----------
   *
   * 「固定做、不用点」意味着每张卡都会发一次带图请求，所以两点必须自己兜住：
   *   ① **同一张卡不重复查**：键 = 归一化名称 + 图标指纹；命中缓存（30 天）直接回填。
   *   ② **结果可回填**：后端只回答结构化结论，面板按 key 写 chrome.storage.local，重开面板即刻有结论。
   * 图标地址常带时间戳/尺寸参数（同一张图不同 URL），所以指纹去掉 query，只认 origin+pathname。 */
  Risk.AI_TTL = 30 * 24 * 60 * 60 * 1000;

  function hash32(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** 图标指纹：dataURL 只取前缀与长度（整串几十万字符不必进内存哈希）；http(s) 去掉 query/hash。 */
  Risk.iconKey = function (icon) {
    const s = String(icon || '');
    if (!s) return '';
    if (/^data:/i.test(s)) return 'd' + s.length + '-' + hash32(s.slice(0, 4096));
    try {
      const u = new URL(s);
      return 'u' + hash32(u.origin + u.pathname);
    } catch (e) { return 'u' + hash32(s); }
  };

  /** 缓存键；没有主标题就没有键（裸图标判不出「蹭哪个名字」，不查）。 */
  Risk.cacheKey = function (title, icon) {
    const n = Risk.normalizeName(title);
    if (!n) return '';
    return n + '#' + Risk.iconKey(icon);
  };

  /**
   * 把后端结论翻成两格的展示态（ok / warn / bad / unknown）。
   * 过期的缓存不当结论用：宁可用「— 未查明」再查一次，也不拿 30 天前的判断冒充现在。
   * @returns {{title:string, icon:string, verdict:string, ai:Object|null, stale:boolean}}
   */
  Risk.aiState = function (ai) {
    const out = { title: 'unknown', icon: 'unknown', verdict: '', ai: ai || null, stale: false };
    if (!ai) return out;
    out.stale = !!(ai.at && (Date.now() - ai.at > Risk.AI_TTL));
    out.verdict = String(ai.verdict || '');
    const base = out.stale ? 'unknown'
      : (out.verdict === 'risky' ? 'bad' : (out.verdict === 'suspect' ? 'warn' : (out.verdict === 'safe' ? 'ok' : 'unknown')));
    const ir = String(ai.iconRisk || '');
    out.title = base;
    out.icon = (out.stale || !ir || ir === 'unknown') ? 'unknown'
      : (ir === 'risky' ? 'bad' : (ir === 'similar' ? 'warn' : (ir === 'none' ? 'ok' : 'unknown')));
    return out;
  };

  KH.RiskAudit = Risk;
})();
