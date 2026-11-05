/**
 * src/features/ai-audit.js · 【2.0.8.7 需求②】应用名称 / 图标的合规初筛
 * ----------------------------------------------------------------------------
 * 分工（为什么要分成两段）：
 *   ① 本地初筛（本文件）：品牌词 + 敏感词的正则/包含匹配，**零成本、零联网、毫秒级**。
 *      绝大多数明显违规的（名字里直接写「博彩」「刷单」「微信」）这里就拦下了，
 *      云端调用量因此能降一个数量级 —— 这正是免费额度够用的前提。
 *   ② 云端复核（background/ai.js 的 `AI.audit`）：看得懂图标、能判断「像但没直接证据」。
 *      默认通道是 Cloudflare Workers AI 的免费额度（10,000 neurons/天）。
 *
 * 口径：
 *   · 只做**名字文本**的判断，不猜拼音同音、不做图像比对（那是云端那一步的事）；
 *   · 结论分三档：`risky`（明确违规/同名仿冒）、`suspect`（像、需要人看）、`safe`（本地没疑点）；
 *   · 本地 `safe` **不等于**真安全 —— 图标仿冒、变体字它看不出来，UI 上要如实标注「建议云端复核」。
 * ========================================================================= */

(function () {
  'use strict';

  /* 取全局的方式与其余特性模块一致（`self` 只在 service worker 里有，单测垫片只给 window）。 */
  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const Audit = {};

  /* ---------- 词表 ----------
   * 这些词表只用于"提示有人工复核"，不做自动处罚；改词表不影响云端那一步的结论。 */

  /** 知名应用 / 品牌（命中即「蹭」的嫌疑）。写中文与常见英文写法。 */
  const BRANDS = [
    '微信', 'wechat', 'weixin', '支付宝', 'alipay', '淘宝', 'taobao', '天猫', 'tmall',
    '京东', 'jdcom', 'jingdong', '拼多多', 'pinduoduo', '抖音', 'douyin', 'tiktok',
    '快手', 'kuaishou', '小红书', 'xiaohongshu', 'rednote', '微博', 'weibo',
    '哔哩哔哩', 'bilibili', 'b站', '知乎', 'zhihu', '百度', 'baidu', '腾讯', 'tencent',
    '阿里巴巴', 'alibaba', '字节跳动', 'bytedance', '美团', 'meituan', '饿了么', 'eleme',
    '滴滴', 'didi', '携程', 'ctrip', '去哪儿', 'qunar', '高德', 'amap', '百度地图',
    '华为', 'huawei', '小米', 'xiaomi', '苹果', 'apple', 'google', '谷歌',
    '微软', 'microsoft', '亚马逊', 'amazon', '奈飞', 'netflix', 'paypal', 'visa',
    'mastercard', '银联', 'unionpay', '云闪付', '数字人民币', '中国银行', '工商银行',
    '建设银行', '农业银行', '招商银行', '交通银行', '邮政储蓄', '12306', '交管12123',
    '国家反诈中心', '王者荣耀', '原神', '和平精英', 'qq', '钉钉', 'dingtalk',
    '企业微信', '飞书', 'lark', 'zoom', 'telegram', 'whatsapp', 'instagram', 'facebook',
    'youtube', 'twitter', 'chatgpt', 'openai', 'deepseek', '文心一言', '通义千问', 'kimi'
  ];

  /** 敏感内容：按「监管口径」的六类，命中任一词即高风险。 */
  const SENSITIVE = [
    {
      tag: '赌博',
      words: ['赌博', '博彩', '赌场', 'casino', 'betting', '六合彩', '时时彩', '北京赛车',
        '体育投注', '足球投注', '真人荷官', '百家乐', '老虎机', '棋牌游戏', '彩票代购',
        '私彩', '球彩', '竞猜下注', '德州扑克', '电玩城']
    },
    {
      tag: '色情',
      words: ['色情', '情色', '成人视频', '约炮', '一夜情', '福利姬', '黄片', 'av视频',
        '裸聊', '性爱', 'sm调教', '成人社区', '情趣酒店', '楼凤', '外围女']
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
      tag: '贷款',
      words: ['秒批', '无抵押贷款', '高利贷', '714高炮', '砍头息', '裸贷', '校园贷',
        '套路贷', '过桥贷', '借款app', '极速下款', '无视征信']
    },
    {
      tag: '其它',
      words: ['虚拟币', 'usdt', '炒币', 'ico', '代币发行', '交易所返佣', '枪支', '迷药',
        '开票', '代开发票', '办证', '黑客接单', '私家侦探']
    }
  ];

  Audit.BRANDS = BRANDS;
  Audit.SENSITIVE = SENSITIVE;

  /**
   * 归一：去掉空格、标点、括号，大小写统一。
   * 目的：让 `微 信`、`微信·`、`WeChat` 都能落在同一套比较上（这类变体是最常见的规避手法）。
   */
  Audit.normalizeName = function (name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[\s\u3000·．.\-_—–~!！?？,，、:：;；/\\|'"“”‘’()（）[\]【】《》<>+*&#@$%^&]/g, '');
  };

  /**
   * 本地初筛。
   * @param {string} name 应用名称
   * @returns {{level:number, verdict:string, hits:Array}}
   *   level 2 = risky（明确命中禁止词，或与品牌完全同名）
   *   level 1 = suspect（名字里含品牌词，疑似蹭）
   *   level 0 = safe（本地没看出问题；图标层面仍需人看）
   */
  Audit.screen = function (name) {
    const n = Audit.normalizeName(name);
    const hits = [];
    if (!n) return { level: 0, verdict: 'safe', hits: hits };

    for (let i = 0; i < SENSITIVE.length; i++) {
      const cat = SENSITIVE[i];
      for (let k = 0; k < cat.words.length; k++) {
        const w = Audit.normalizeName(cat.words[k]);
        if (w && n.indexOf(w) >= 0) {
          hits.push({ kind: 'sensitive', tag: cat.tag, word: cat.words[k], why: '名称里直接出现「' + cat.words[k] + '」' });
        }
      }
    }

    for (let i = 0; i < BRANDS.length; i++) {
      const b = Audit.normalizeName(BRANDS[i]);
      if (!b) continue;
      if (n === b) {
        hits.push({ kind: 'brand', tag: '同名', word: BRANDS[i], why: '与知名品牌「' + BRANDS[i] + '」完全同名' });
      } else if (b.length >= 2 && n.indexOf(b) >= 0) {
        hits.push({ kind: 'brand', tag: '蹭品牌', word: BRANDS[i], why: '名称里含知名品牌「' + BRANDS[i] + '」' });
      }
    }

    let level = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.kind === 'sensitive' || h.tag === '同名') level = 2;
      else if (level < 1) level = 1;
    }
    return { level: level, verdict: level >= 2 ? 'risky' : (level === 1 ? 'suspect' : 'safe'), hits: hits };
  };

  /** 云端结论 + 本地结论合成一句人话（面板/设置页共用一份措辞）。 */
  Audit.describe = function (local, cloud) {
    const L = local || { level: 0, hits: [] };
    if (cloud && cloud.risk) {
      if (cloud.risk === 'risky') return '建议拒绝：' + (cloud.summary || '云端判定为明确风险');
      if (cloud.risk === 'suspect') return '需要人工复核：' + (cloud.summary || '云端认为像但证据不足');
    }
    if (L.level >= 2) return '建议拒绝：' + L.hits.map(function (h) { return h.why; }).join('；');
    if (L.level === 1) return '需要人工复核：' + L.hits.map(function (h) { return h.why; }).join('；');
    if (cloud && cloud.risk === 'safe') return '通过：' + (cloud.summary || '本地与云端都没发现问题');
    return '本地没发现问题（图标层面仍需人看，可点「云端复核」）';
  };

  KH.AiAudit = Audit;
})();
