'use strict';
/* src/ui/ocr-copy.js —— **图片文字识别（OCR）用户可见文案的唯一真源**（票 #17 决议 D-17.1）
 * ----------------------------------------------------------------------------
 * 为什么必须只有这一份：
 *   改这一块之前，「同一件事」在不同地方有四套说法 —— 功能名叫「图片识别」「图片文字识别」
 *   「识别图片文字」，而失败原因更糟：引擎侧明明能给出 11 种原因（`src/features/img-ocr.js`
 *   的 `why`），面板折叠标签只认 4 个，`no-src`/`scheme`/`bad-url`/`tainted` 全被压成
 *   「读不到像素」、`fail` 一律「识别失败」；「缺语言包」那句写好的文案还只在**展开后**才看得见。
 *   病根不是文笔，是**没有真源**：改一处漏两处。所以这份表是唯一真源，
 *   面板（`src/features/important-note.js`）、设置页（`options/options.js`）、
 *   弹窗（`popup/popup.js`）一律从 `KH.OcrCopy` 取字，不许再硬编码 OCR 原因文案。
 *
 * 两级文案（同一个键两个字段）：
 *   `tag` —— 折叠态的短标签（多数 ≤8 字，上限见 `MAX_TAG`），一眼看出发生了什么；
 *   `why` —— 展开态的说明，1–2 句，**必须包含"下一步该做什么"**（用户看完能自救才算合格）。
 *
 * 状态类五值（决定标签底色，见 `important-note.js` 的 `.khin-imgtag*`）：
 *   `hit` 绿（命中）／`miss` 灰（未命中）／`wait` 灰（排队中·识别中）／
 *   `note` 中性（读不到图 / 缺资产 —— **不是故障**，别染红）／`bad` 红（真失败）。
 *   ⚠️ 口径要点：**只有 `fail` / `engine-unavailable` / `timeout` 是红的**。
 *   这条是票 #17 新登记的 P0 的修复口径 —— 改之前 `important-note.js` 把所有非 `done`
 *   状态（含 `idle` 排队、`pending` 在跑）都套了 `bad` 类，于是 OCR **正常工作时**面板上
 *   显示的是一个**红底的「识别中…」**，用户第一反应就是「出错了」。
 *
 * 与别处的耦合（改表时一起改）：
 *   · `tests/specs/ocr-copy.test.js` 有**枚举对账**（本表的键集合必须与 `img-ocr.js` 真正会
 *     产出的 `why`/终态集合**完全相等**，多一个少一个都红）—— 所以新增原因要**两边同时改**；
 *   · `tests/specs/important-note.test.js` / `img-ocr.test.js` 断言的是用户可见文案，
 *     改措辞前先跑一遍。
 *
 * 载入方式：content_scripts 与 options/popup 两侧共用（照 `src/ui/fieldmap.js` 的形状），
 * 三处注册点见 `manifest.json` 的 content_scripts.js、`options/options.html`、`popup/popup.html`。
 */
(function () {
  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /**
   * 折叠态标签的长度上限（**针对模板**，占位符按字面长度算）。
   * 绝大多数标签都压在 8 字以内（「排队中…」「缺语言包」「原图太小」）；
   * **唯一故意更长的是 `cross-origin`**（「跨域（未授权 {host}）」）—— 域名是用户要照着填的
   * 那一部分，砍掉它就等于把"下一步该做什么"砍掉（原 K63 口径）。
   * 注意：渲染后可能比上限更长（真实域名有长有短）—— **域名是数据、不是文案**，
   * 所以这条只卡模板；由 `tests/specs/ocr-copy.test.js` 硬查，别在文案里随手写长句。
   */
  const MAX_TAG = 16;

  /**
   * 引擎回落原因的"人话"（S2 / #12 §3）：`engineReason` 是**机器码**（来自回执），
   * 面板上直接印 `asset-missing` 等于没说 —— 用户要知道的是"为什么降级了、要不要管"。
   * 键就是回执里会出现的 code，多一个少一个都由 `tests/specs/ocr-copy.test.js` 对账。
   */
  const ENGINE_REASON = {
    'asset-missing': '模型文件没准备好（设置页可下载或导入）',
    'module-load-failed': '引擎模块加载失败',
    'init-failed': '引擎初始化失败',
    'engine-unavailable': '引擎不可用',
    'missing-engine': '识别请求里没带引擎信息',
    'sha-mismatch': '模型文件校验没通过'
  };

  /**
   * 文案表（**唯一真源**）。键名与 `src/features/img-ocr.js` 的 `state`/`why` 同名，
   * 这样枚举对账可以直接比对集合，不用维护第二张映射表。
   *
   * 占位符（`render()` 替换）：`{text}` 识别文本 ｜ `{matched}` 命中片段 ｜ `{keyword}` 关键词
   * ｜ `{host}` 图片所在域名 ｜ `{error}` 引擎错误串 ｜ `{n}` 秒数 ｜ `{px}` 像素高度。
   */
  const COPY = {
    /* ---- 进行中（两态必须分开：排队 ≠ 在跑；都用 `wait` 类，不是故障）---- */
    queued: {
      tag: '排队中…',
      why: '前面的图识别完就轮到它（同时最多 4 张在跑）。'
    },
    running: {
      tag: '识别中…',
      why: '识别在本机进行，图片不上传。'
    },

    /* ---- 有结果 ---- */
    hit: { tag: '命中：{text}', why: '命中「{matched}」：{text}' },
    miss: { tag: '未命中', why: '图里识别出的文字没有匹配「{keyword}」。识别文本：{text}' },

    /* ---- 读完了、但结果不可用（S1-c / D-14.5）----
     * 这三条与 `hit`/`miss` 同级，都是 `done` 态。**必须顶掉「未命中」**：
     * 长图只读了一半、或者一个字都没认出来，面板说"未命中"就是撒谎 ——
     * 用户会以为"图里没有这个词"，而真相是"这张图根本没被读完/根本没读出字"。 */
    'no-text': {
      tag: '没认出文字',
      why: '这张图太小、太糊，或者文字是竖排/艺术字 —— 没能识别出可用的文字。截得更大更清晰再试会好一些。'
    },
    tilted: {
      tag: '方向可能不正',
      why: '这张图的方向可能不正（180°/270°/90° 都试过，没有更优的），识别结果不可靠。把图转正后重试会更准。'
    },

    /* ---- 缺资产（可自救，`note` 类）---- */
    'model-missing': {
      tag: '缺识别模型',
      why: '主引擎模型还没下载。到设置页「图片文字识别 → 主引擎模型」下载，或切到「只用兼容引擎」。'
    },
    'lang-missing': {
      tag: '缺语言包',
      why: '兼容引擎的语言包还没准备好。到设置页「图片文字识别 → 兼容引擎语言包」下载或手动导入。'
    },

    /* ---- 引擎问题（`engine-unavailable`/`timeout` 是红，`engine-lost` 不是）---- */
    'engine-unavailable': {
      tag: '引擎不可用',
      why: '当前浏览器不支持离线识别（需要 offscreen 能力）。'
    },
    'engine-lost': {
      tag: '引擎已释放',
      why: '识别引擎在跑的过程中被释放了，下一次识别会重新启动它。'
    },
    timeout: {
      tag: '识别超时',
      why: '这张图超过 {n} 秒没有进展，已中止。长图请重试或改用更小的截图。'
    },

    /* ---- 图本身的问题（`note` 类：都读不到图，不是引擎故障）---- */
    truncated: {
      tag: '图太大·已截断',
      why: '这张图太长，只识别了前 {chunks} 块（覆盖原图前 {px} px / 共 {total} px）。要完整识别请把图切成两张，或先裁掉不需要的部分再试。'
    },
    /* 原 K63 口径（必须保留）：跨域这条要把**图片所在域名**直接写出来 ——
     * 用户照着填就能授权，不用猜是"本站"还是"图片站"。 */
    'cross-origin': {
      tag: '跨域（未授权 {host}）',
      why: '这张图来自 {host}，默认不代为读取。到设置页「图片文字识别 → 跨域图片」把 {host} 加进去即可（也可以直接授权本站点）。'
    },
    lazy: {
      tag: '图还没加载',
      why: '这张图是懒加载、还没真正加载出来；等它加载完会自动重扫一次。'
    },
    invisible: {
      tag: '图当前不可见',
      why: '这张图当前不可见（折叠/未展开），显出来之后会自动识别。'
    },
    'too-small': {
      tag: '原图太小',
      why: '这张图的**原始尺寸**太小（两边都不到 24px），识别也认不出；如果页面上看着不小，说明它本来就是被放大的小图。'
    },
    'no-src': {
      tag: '图没有地址',
      why: '这个位置上没有可读的图片地址（可能是占位/背景图）。'
    },
    scheme: {
      tag: '协议不支持',
      why: '这张图用的协议（如 `blob:` / `chrome:`）读不到像素。'
    },
    'bad-url': {
      tag: '地址无效',
      why: '这张图的地址解析不了（可能是相对地址写坏了）。'
    },
    tainted: {
      tag: '像素被污染',
      why: '这张图所在画布被跨域内容污染，浏览器不允许读出像素。'
    },

    /* ---- 兜底真失败（红）---- */
    fail: {
      tag: '识别失败',
      why: '{error}'
    }
  };

  /**
   * 键 → 状态类。**没列在这里的键一律 `note`**（中性）——
   * 「读不到图」不是故障，把它染红是本轮要修的那个 P0。
   */
  const CLASS = {
    hit: 'hit',
    miss: 'miss',
    queued: 'wait',
    running: 'wait',
    fail: 'bad',
    'engine-unavailable': 'bad',
    timeout: 'bad'
  };

  /** 本表认识的键（枚举对账用；**必须与 `img-ocr.js` 真正会产出的集合完全相等**） */
  const KEYS = Object.keys(COPY);

  /**
   * "读过了、但结果不可用"的三类告知（S1-c / D-14.5）—— 也是 `done` 态。
   * 必须在 `miss` 之前判：`truncated`（长图只读了前 8 块）/`no-text`（一个字都没认出来）/
   * `tilted`（方向可疑）。判据与生产者都在 `offscreen/ocr.js` 的 `noticeOf()`。
   */
  const NOTICE = { truncated: true, 'no-text': true, tilted: true };

  /** 展开态说明里 `{error}` 缺省时用的兜底串（键 `fail` 专用） */
  const FALLBACK_ERROR = '识别引擎报了一个未说明的错误。';

  /**
   * 把一个 item 归到某个键。**这是全工程唯一的口径**（`important-note.js` 只管渲染）。
   *
   * 归约顺序刻意写成"从具体到笼统"：
   *   ① `done` 先看**告知**（`why` 属于 `NOTICE` 的三种：截断/没认出文字/方向可疑）——
   *      这三条比 `miss` 具体，必须顶掉"未命中"；再按有没有命中分 `hit`/`miss`；
   *   ② `idle`/`pending` 分 `queued`/`running`（**这两态在修复前被合并成「识别中…」**）；
   *   ③ `blocked` 直接用 `why`（`img-ocr.js` 的 `readable()`/`classify()` 产物）；
   *   ④ 其余（`fail` 与 #12/#14/#16 新增的终态）—— `why`/`errorCode` 只要在表里就照用，
   *      这样新终态**加进文案表就自动生效**，不用再来改这个函数；
   *   ⑤ 都不认 ⇒ `fail`（兜底，且会在枚举对账里暴露出来）。
   *
   * @param {{state?:string, why?:string, errorCode?:string, matched?:Array}} it
   * @returns {string} COPY 里的键
   */
  function keyOf(it) {
    const o = it || {};
    const state = String(o.state || '');
    if (state === 'done') {
      if (o.matched && o.matched.length) return 'hit';
      if (o.why && NOTICE[o.why]) return String(o.why);
      return 'miss';
    }
    if (state === 'idle') return 'queued';
    if (state === 'pending') return 'running';
    if (state === 'blocked') return COPY[o.why] ? String(o.why) : 'fail';
    const cand = String(o.why || o.errorCode || '');
    if (COPY[cand]) return cand;
    return 'fail';
  }

  /** 值替换：`{k}` → `vars[k]`（缺失就留原样，便于发现占位符写错） */
  function render(tpl, vars) {
    const v = vars || {};
    return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] == null ? m : String(v[k])));
  }

  /** 把 item 摊平成占位符取值（所有键共用一份，省得每个分支自己拼） */
  function varsOf(it) {
    const o = it || {};
    const text = String(o.text || '').replace(/\s+/g, ' ').trim();
    return {
      text: text || '（图里没识别出文字）',
      matched: (o.matched || []).map((m) => m && m.text).filter(Boolean).join('、'),
      keyword: o.keyword || '',
      host: o.host || '它所在的域名',
      error: o.error ? String(o.error) : FALLBACK_ERROR,
      /* 看门狗两档（#16 D-16.2）：无进度 60s / 硬顶 120s —— 报最靠近的那个 */
      n: o.limitMs ? Math.round(o.limitMs / 1000) : 120,
      px: o.coverPx || 0,
      /* 截断告知（D-14.5 ②）要报实数：识别了几块 / 共多少块 / 覆盖到原图第几 px、原图共多高 */
      chunks: (o.coverage && o.coverage.usedChunks) || 0,
      total: (o.coverage && o.coverage.totalH) || 0
    };
  }

  /** 折叠态短标签（≤`MAX_TAG` 视觉字符） */
  function tag(it) {
    return render(COPY[keyOf(it)].tag, varsOf(it));
  }

  /**
   * 回落告知（S2 / #12 §3 / 票 #17 D-17.3）：**实际引擎只出现在展开说明里**（折叠标签不动 ——
   * 标签是"发生了什么"，引擎是"怎么发生的"，塞进标签只会让它变长且难认）。
   * `engineReason` 非空 = 这一条是**降级**跑的；空 = 用的就是用户选的那个引擎，不加废话。
   */
  function engineNote(it) {
    const r = String((it && it.engineReason) || '');
    if (!r) return '';
    return ' 引擎：已从 PP-OCR 回落到兼容引擎（' + (ENGINE_REASON[r] || r) + '）。';
  }

  /**
   * 本次识别的**真实**耗时徽标（S3-④ 用户裁决：面板显示真实耗时，而不是写死一句
   * "约 0.8 秒/张"的静态文案 —— 静态文案会过期，回执里的数字不会）。
   *
   * 数字来源：`offscreen/ocr.js` 回执的 `ocrMs`（= `performance.now() − t1`，从 job 开始
   * 到出结果，**含**预处理与引擎 det+rec，**不含**排队等待）→ `background/ocr.js:240`
   * 原样透传 → `src/features/img-ocr.js:445` 存在条目上 → 面板读这里。
   *
   * 没有值（排队中 / 引擎没跑到）就返回**空串**，面板据此不挂这个徽标 ——
   * 绝不能显示 "0.0s" 或空标签（那是在替引擎撒谎）。
   */
  function costLabel(it) {
    const ms = Number(it && it.ocrMs);
    if (!isFinite(ms) || ms <= 0) return '';
    return (ms / 1000).toFixed(1) + 's';
  }

  /** 耗时徽标的悬停说明（中文文案一律在真源里写，面板不许自己拼） */
  function costTip(it) {
    const label = costLabel(it);
    return label ? '本次识别耗时 ' + label + '（不含排队等待）' : '';
  }

  /** 展开态说明（1–2 句，含下一步动作） */
  function why(it) {
    return render(COPY[keyOf(it)].why, varsOf(it)) + engineNote(it);
  }

  /** 状态类：`hit` / `miss` / `wait` / `note` / `bad`（决定底色，见文件头口径） */
  function stateClass(it) {
    const key = keyOf(it);
    return CLASS[key] || 'note';
  }

  /** 给别处用的只读快照（测试与诊断读它，不要直接改 `COPY`） */
  function dump() {
    return {
      maxTag: MAX_TAG, keys: KEYS.slice(), copy: JSON.parse(JSON.stringify(COPY)),
      class: Object.assign({}, CLASS), engineReason: Object.assign({}, ENGINE_REASON)
    };
  }

  KH.OcrCopy = {
    MAX_TAG: MAX_TAG,
    KEYS: KEYS,
    keyOf: keyOf,
    tag: tag,
    why: why,
    costLabel: costLabel,
    costTip: costTip,
    stateClass: stateClass,
    render: render,
    dump: dump
  };
})();
