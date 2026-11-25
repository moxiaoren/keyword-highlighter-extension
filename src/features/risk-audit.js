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
  /** 开发者/主体字段的别名：优先走 Compare.Sources 的 dev / entity 口径，这里再兜住常见写法。 */
  Risk.DEV_ALIASES = ['开发者', '开发者名称', '开发商', '开发公司', '研发商', '运营者', '运营主体', '公司名称'];

  /* 【2.0.17.6 · 用户 m26871】品牌 → 官方主体关键词：名字对得上只说明「叫这个名字」，是不是官方要看谁在做。
   * 两条判据，先①后②：
   *   ① 主体名自带品牌名 —— 「支付宝（中国）网络技术有限公司」包含「支付宝」；
   *   ② 主体名带这里登记的关键词 —— 「深圳市腾讯计算机系统有限公司」不含「微信」，但腾讯是微信的官方主体。
   * 只收工商/集团层面的主体关键词，不收产品名，避免把「腾讯会议」判成「微信」的官方主体。 */
  const OWNERS = {
    '微信': ['腾讯', 'tencent'], wechat: ['腾讯', 'tencent'], weixin: ['腾讯'],
    '支付宝': ['支付宝', '蚂蚁', '阿里巴巴', 'alibaba'], alipay: ['支付宝', '蚂蚁', '阿里巴巴', 'alibaba'],
    '淘宝': ['淘宝', '阿里巴巴', 'alibaba'], taobao: ['淘宝', '阿里巴巴', 'alibaba'],
    '天猫': ['天猫', '阿里巴巴', 'alibaba'], tmall: ['天猫', '阿里巴巴', 'alibaba'],
    '京东': ['京东', 'jingdong'], jd: ['京东', 'jingdong'], jingdong: ['京东', 'jingdong'],
    '拼多多': ['拼多多', '寻梦'], pinduoduo: ['拼多多', '寻梦'],
    '抖音': ['字节', 'bytedance', '微播视界'], douyin: ['字节', 'bytedance', '微播视界'], tiktok: ['字节', 'bytedance'],
    '快手': ['快手', '达佳'], kuaishou: ['快手', '达佳'],
    '小红书': ['行吟', '小红书'],
    '微博': ['新浪', 'sina', '微梦'], weibo: ['新浪', 'sina', '微梦'],
    '哔哩哔哩': ['哔哩哔哩', '幻电', 'bilibili'], bilibili: ['哔哩哔哩', '幻电', 'bilibili'],
    '知乎': ['知乎', '智者'], zhihu: ['知乎', '智者'],
    '百度': ['百度', 'baidu'], baidu: ['百度', 'baidu'],
    '腾讯': ['腾讯', 'tencent'], tencent: ['腾讯', 'tencent'],
    '阿里巴巴': ['阿里巴巴', 'alibaba'], alibaba: ['阿里巴巴', 'alibaba'],
    '美团': ['三快', '美团', 'meituan'], meituan: ['三快', '美团', 'meituan'],
    '饿了么': ['拉扎斯', '饿了么'],
    '滴滴': ['滴滴', '小桔', 'didi'], didi: ['滴滴', '小桔', 'didi'],
    '携程': ['携程', 'ctrip'], ctrip: ['携程', 'ctrip'],
    '去哪儿': ['去哪儿', 'qunar'], qunar: ['去哪儿', 'qunar'],
    '高德': ['高德', 'amap'], amap: ['高德', 'amap'],
    '华为': ['华为', 'huawei'], huawei: ['华为', 'huawei'],
    '小米': ['小米', 'xiaomi'], xiaomi: ['小米', 'xiaomi'],
    '苹果': ['苹果', 'apple'], apple: ['苹果', 'apple'],
    '谷歌': ['谷歌', 'google'], google: ['谷歌', 'google'],
    '微软': ['微软', 'microsoft'], microsoft: ['微软', 'microsoft'],
    '亚马逊': ['亚马逊', 'amazon'], amazon: ['亚马逊', 'amazon'],
    netflix: ['netflix'], '奈飞': ['netflix'],
    paypal: ['paypal'], visa: ['visa'], mastercard: ['mastercard'],
    '银联': ['银联', 'unionpay'], unionpay: ['银联', 'unionpay'], '云闪付': ['银联', 'unionpay'],
    '12306': ['中国铁路', '12306'], '交管12123': ['公安部', '交管'], '反诈中心': ['公安部', '反诈'],
    '王者荣耀': ['腾讯'], '企业微信': ['腾讯'], '和平精英': ['腾讯'],
    '原神': ['米哈游', 'mihoyo'],
    '钉钉': ['钉钉', '阿里巴巴', 'alibaba'], dingtalk: ['钉钉', '阿里巴巴', 'alibaba'],
    '飞书': ['飞书', '字节', 'bytedance'],
    chatgpt: ['openai'], openai: ['openai'],
    deepseek: ['深度求索', 'deepseek'],
    '文心一言': ['百度'], '通义千问': ['阿里巴巴', '阿里云'], kimi: ['月之暗面'],
    '数字人民币': ['中国人民银行']
  };

  /** 开发者是不是该品牌的官方主体；是则回 {brand,owner}，否则 null。
   *  判据要求「名称里确实出现了这个品牌」—— 只凭开发者是腾讯，不会把「记账小本」判成官方。 */
  function officialOf(dev, n, lex) {
    const d = Risk.normalizeName(dev);
    if (!d || !n) return null;
    for (let i = 0; i < lex.brands.length; i++) {
      const raw = lex.brands[i];
      const b = Risk.normalizeName(raw);
      if (!b || b.length < 2) continue;
      if (n.indexOf(b) < 0) continue;
      /* ① 主体名自带品牌（「支付宝（中国）网络技术有限公司」）。 */
      if (d.indexOf(b) >= 0) return { brand: raw, owner: String(dev).trim() };
      /* ② 品牌登记过官方主体关键词（「深圳市腾讯计算机系统有限公司」对微信）。 */
      const keys = OWNERS[b] || [];
      for (let k = 0; k < keys.length; k++) {
        const kw = Risk.normalizeName(keys[k]);
        if (kw && d.indexOf(kw) >= 0) return { brand: raw, owner: String(dev).trim() };
      }
    }
    return null;
  }

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
    const out = { brands: BRANDS.filter(keep), cats: [], notes: {} };
    for (let i = 0; i < SENSITIVE.length; i++) {
      out.cats.push({ tag: SENSITIVE[i].tag, cat: SENSITIVE[i].cat || '', words: SENSITIVE[i].words.filter(keep) });
    }
    const list = Array.isArray(lx.custom) ? lx.custom : [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      const w = String(it.w == null ? '' : it.w).trim();
      if (!w || !keep(w)) continue;
      const cat = Risk.CATS.indexOf(String(it.cat || '')) >= 0 ? String(it.cat) : 'other';
      const note = String(it.note == null ? '' : it.note).trim();
      if (note) out.notes[Risk.normalizeName(w)] = note;
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
   * @param {string} [dev] 开发者 / 主体（抓取字段的「开发者」「备案主办单位」）；用来区分「正版」与「蹭品牌」
   * @returns {{level:number, verdict:string, hits:Array, official:string}}
   *   level 2 = risky（命中禁止类词，或与品牌同名/含品牌但不是官方主体）；1 = suspect（含品牌，暂无证据是官方）；
   *   0 = safe（含「名称对得上品牌、开发者正是官方主体」的正版）
   */
  Risk.screen = function (name, cfg, dev) {
    const n = Risk.normalizeName(name);
    const hits = [];
    const out = { level: 0, verdict: 'safe', hits: hits, official: '' };
    if (!n) return out;
    const lex = Risk.lexicon(cfg);
    const who = officialOf(dev, n, lex);
    const devText = String(dev == null ? '' : dev).trim();

    for (let i = 0; i < lex.cats.length; i++) {
      const cat = lex.cats[i];
      for (let k = 0; k < cat.words.length; k++) {
        const w = Risk.normalizeName(cat.words[k]);
        if (w && n.indexOf(w) >= 0) {
          hits.push({ kind: 'sensitive', tag: cat.tag, word: cat.words[k], note: lex.notes[w] || '' });
        }
      }
    }

    for (let i = 0; i < lex.brands.length; i++) {
      const raw = lex.brands[i];
      const b = Risk.normalizeName(raw);
      if (!b) continue;
      const mine = !!(who && Risk.normalizeName(who.brand) === b);
      if (n === b) {
        /* 同名：开发者是官方主体 → 正版；有开发者但不是官方 → 冒充；连开发者都没有 → 同名待核。 */
        const note0 = lex.notes[b] || '';
        if (mine) hits.push({ kind: 'brand', tag: '官方', word: raw, exact: true, official: true, note: note0 });
        else if (devText) hits.push({ kind: 'brand', tag: '冒充', word: raw, exact: true, note: note0 });
        else hits.push({ kind: 'brand', tag: '同名', word: raw, exact: true, note: note0 });
      } else if (b.length >= 2 && n.indexOf(b) >= 0) {
        if (mine) hits.push({ kind: 'brand', tag: '官方', word: raw, exact: false, official: true });
        else hits.push({ kind: 'brand', tag: '蹭品牌', word: raw, exact: false });
      }
    }

    let level = 0;
    let offWord = '';
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].kind === 'sensitive') { level = 2; break; }
    }
    if (level < 2) {
      /* 官方结论只在「没有别的非官方命中」时成立：叫「微信分身」但开发者是腾讯，仍要人看一眼。 */
      let soft = false;
      let off = false;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (h.kind !== 'brand') continue;
        if (h.official) { off = true; if (!offWord) offWord = h.word; continue; }
        if (h.tag === '冒充' || h.tag === '同名') { level = 2; break; }
        soft = true;
      }
      if (level < 2) level = soft ? 1 : 0;
    }
    out.level = level;
    out.verdict = level >= 2 ? 'risky' : (level === 1 ? 'suspect' : 'safe');
    out.official = level <= 1 ? offWord : '';
    return out;
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

  /** 副标题行：与主标题用「-」连成一个名称参与判定（2.0.18 · 用户 m27217）。 */
  function isSubLabel(label) {
    const S = sources();
    if (S && typeof S.fieldKey === 'function') {
      try { if (S.fieldKey(label) === 'subtitle') return true; } catch (e) { /* 落到别名 */ }
    }
    const k = keyOf(label);
    const aliases = ['副标题', '应用副标题', '子标题', '短标题', '一句话简介'];
    for (let i = 0; i < aliases.length; i++) if (keyOf(aliases[i]) === k) return true;
    return false;
  }

  /** 开发者/主体行：先认 Sources 的 dev（开发者）与 entity（备案主办单位），再用别名兜底。 */
  function isDevLabel(label) {
    const S = sources();
    if (S && typeof S.fieldKey === 'function') {
      try {
        const k = S.fieldKey(label);
        if (k === 'dev' || k === 'entity') return true;
      } catch (e) { /* 落到别名 */ }
    }
    const k = keyOf(label);
    for (let i = 0; i < Risk.DEV_ALIASES.length; i++) if (keyOf(Risk.DEV_ALIASES[i]) === k) return true;
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
    const out = { found: false, title: '', subtitle: '', name: '', icon: '', dev: '' };
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
        if (!out.subtitle && isSubLabel(label)) {
          const v = cellText(tds.length > 1 ? tds[1] : null).trim();
          if (v) out.subtitle = v;
        }
        if (!out.icon && isIconLabel(label)) {
          const src = firstImgSrc(tds.length > 1 ? tds[1] : tds[0]);
          if (src) out.icon = src;
        }
        if (!out.dev && isDevLabel(label)) {
          const d = cellText(tds.length > 1 ? tds[1] : null).trim();
          if (d) out.dev = d;
        }
      }
    }
    /* 主标题与副标题用「-」连成一个名称：风险判定 / AI 核验 / 缓存键都认这一个。 */
    out.name = out.title + (out.subtitle ? '-' + out.subtitle : '');
    out.found = !!(out.title || out.icon);
    return out;
  };

  /**
   * 一张卡片的完整本地初筛：有主标题才判（没有名称无从判断），图标只带出去给 AI 深查。
   * @returns {{ok:boolean,title:string,icon:string,level:number,verdict:string,hits:Array}}
   */
  Risk.auditCard = function (tableEl, cfg) {
    const got = Risk.readCard(tableEl);
    const res = Risk.screen(got.name || got.title, cfg, got.dev);
    return {
      ok: !!got.title,
      title: got.title,
      subtitle: got.subtitle,
      name: got.name || got.title,
      icon: got.icon,
      dev: got.dev,
      official: res.official,
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

  /** 缓存键；没有主标题就没有键（裸图标判不出「蹭哪个名字」，不查）。
   *  开发者进指纹：同名不同开发者是两种结论（正版 vs 冒充），不能共用旧缓存。 */
  Risk.cacheKey = function (title, icon, dev) {
    const n = Risk.normalizeName(title);
    if (!n) return '';
    const d = Risk.normalizeName(dev);
    return n + '#' + Risk.iconKey(icon) + (d ? '#' + hash32(d) : '');
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
