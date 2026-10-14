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

    /* ---- 有结果 ----
     * `hit` 的折叠标签**不带识别文本**（2026-10-09 用户裁决）：命中词就在面板上传成
     * 可点的词块（见 `VIEW.copySentence`），整段文本只在光箱右侧与悬停说明里，
     * 免得一张图把面板撑成一大块。 */
    hit: { tag: '命中', why: '命中「{matched}」：{text}' },
    miss: { tag: '未命中', why: '图里识别出的文字没有匹配「{keyword}」。识别文本：{text}' },
    /* 【2.0.1.17 右键任意图 OCR】用户自己点名的图：没有关键词可匹配 ⇒ 既不是命中也不是未命中。
     * 它是"你要的那段字"，所以标签说「已识别」、悬停直接把全文摊给他看。 */
    ctxmenu: { tag: '已识别', why: '这是你右键识别的那张图。识别文本：{text}' },

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
   * 「🖼 图片命中」分区的**展示筛选**文案（用户 2026-10-06 口径）：这个功能的主要目的是命中，
   * 未命中的图默认不展示，另留「显示全部」这个人工复核入口。`{n}` = 被收起的条目数（`busy` 那个是"N 张还在识别中"）。
   *
   * ⚠️ 这些**不是**条目状态，所以**不进 `COPY`** —— `COPY` 的键集合必须与 `img-ocr.js`
   * 真正会产出的终态集合**完全相等**（`tests/specs/ocr-copy.test.js` 枚举对账，多一个少一个都红）。
   * 判断用 `stateClass()`（`hit`/`bad`/`action` 常显，其余进复核），面板不许自己再列一套状态。
   */
  const VIEW = {
    /* F2.1（2.0.1.16）：默认宽已回 250px，「题头一行放不下」这个前提消失 ⇒ 把 2026-10-11
     * 为 200px 做的短标签（「全部 {n}」/「只命中」）恢复成**自解释**文案：进出有动词
     * （显示 / 只看）、筛选含义写在字面上，不再要求用户先悬停才知道「只命中」是个筛选开关。
     * title 里的完整句保留做兜底（范围口径仍值得写清）。 */
    showAll: '显示全部 {n}',
    onlyHits: '只看命中',
    showAllTip: '显示全部：连未命中 / 排队中 / 没认出文字的图一起放出来人工复核',
    onlyHitsTip: '只看命中：回到默认视图（只留命中与真失败）',
    noneHit: '这次没有命中的图片（{n} 张没有命中，点「显示全部」人工复核）',
    /* 还有条目在跑时**不许**说"没有命中" —— 那是在结果出来之前下结论（面板只能如实说"还在识别"） */
    noneHitBusy: '图片还在识别中（{n} 张），结果出来会显示在这里',
    busy: '·识别中{n}',
    /* 状态图标（2026-10-11 用户要求"配置 200px 用图标+短标签"）：200px 下一行要同时放
     * 关键词 + 状态 + 耗时，纯文字标签会被挤成折行 ⇒ 每条前缀一枚图标，扫一眼就分得清。
     * 图标只进面板显示层（`tag()` 的文案不变，设置页/光箱/测试读到的还是纯短标签）。 */
    expandTip: '展开分区',
    collapseTip: '收起分区',
    /* F3.4（2.0.1.16，用户 2026-10-13 拍板「展开笔记 ▾ / 展开图片 ▾」）：两个分区题头原来
     * 一律写「展开 ▾ / 收起 ▴」—— 逐字相同的两个按钮，目视与读屏都分不清展开的是哪一块，
     * 所以按分区各自命名。箭头字符与措辞一样是文案，真源只在这里（F1.2：面板不许自己写）。 */
    noteExpand: '展开笔记 ▾',
    noteCollapse: '收起笔记 ▴',
    imgExpand: '展开图片 ▾',
    imgCollapse: '收起图片 ▴',
    /* ---- 2026-10-09 简约展示：命中词块 / 光箱全文栏 ----
     * 面板不许自己写这些字（源码契约会红），一律从这张表取。
     * 2.0.1.15 需求 7：面板那条「📋 复制全文」按钮按用户裁决删除，只服务它的两个文案键
     * 一并删掉（全仓已无读者，留着就是没人读的死字符串）；复制全文改走大图里
     * 的选中复制（见 .kh-lb-side 的 user-select: text）。 */
    textPane: '识别出的文字',
    copySentence: '复制这句话',
    copySentDone: '已复制这句',
    copyFailed: '复制失败，请点图放大后手动选中文字',
    openLarge: '点开看大图',
    /* ---- 灯箱右栏可隐藏（2.0.1.15 需求 5）----
     * 右侧全文栏在窄视口下会挤占图片空间，用户要能临时收起；按钮的两个标签同样只认这张表
     * （灯箱/面板不许自己写这两句 —— 源码契约会红）。 */
    paneHide: '隐藏全文',
    paneShow: '显示全文',
    /* ---- 全文栏可拖动（2.0.2.1 需求 4）----
     * 默认停靠在大图右侧，但用户能把它拖到顺手的位置；这句话是标题栏的 title，
     * 也是「怎么把它弄回去」的唯一提示（双击标题栏复位），所以必须写在真源里。 */
    paneDrag: '拖动这里移动全文栏（双击回到大图右侧）',
    /* ---- 2026-10-12 重要笔记卡的「多命中」面 ----
     * 一张卡命中多个时默认只展最短一条，右侧计数小标 + 点开的下拉（2.0.1.15 需求 1）。
     * 悬停说明 / 下拉头行同样不许在面板里写死。 */
    moreHits: '点开看全部 {n} 个命中',
    hitsTotal: '共 {n} 条',
    /* ---- 面板四处标题文案的归真源（2.0.1.15 的 UI 修复批）----
     * 这四句原来写死在 important-note.js 里，改文案的人根本找不到它们；面板自订契约要求
     * 措辞一律来这张表。{n} 是「重要笔记」小按钮上的条目数。可见短标签（🖼 图片）本身
     * 是缩写，完整语义挂同一元素的 title。 */
    fabLabel: '重要笔记（{n} 条）',
    minTip: '收起为小按钮',
    imgSectionTip: '图片命中',
    removeTip: '本次页面不再显示',
    /* ---- T41（用户 2026-10-12 拍板方案 2）：灯箱全文栏自带的操作入口 ----
     * 复制成功/失败要就地反馈（失败必须说出来，不许静默）；「共 N 行」是次要信息。
     * 失败文案不写"点图放大"——这按钮本来就在大图里，那样等于让用户绕圈。 */
    paneCopy: '复制',
    paneCopied: '已复制',
    paneCopyFail: '复制失败，请手动选中文字',
    paneLines: '共 {n} 行'
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
    timeout: 'bad',
    /* T21（用户 2026-10-13 拍板修）：跨域未授权**不是**故障、也不是未命中 —— 它是"你把这个域名
     * 授权一次就能读"。给独立一类 `action` 而不是 `note`，两个理由：
     * ① 默认视图必须露出来（藏进复核视图就是静默：面板空着，用户以为 OCR 坏了，而答案就在设置页）；
     * ② 底色/图标要跟"读不到图的其它原因"（note 类是纯告知，用户没什么可做的）区分开。 */
    'cross-origin': 'action',
    /* 右键识别（2.0.1.17）：用户手动的动作，成功了就是一句中性告知（跟"读不到图"的理由同级，
     * 都不是故障）。它**默认视图常显**不是靠这个类，而是靠 `important-note.js` 的
     * `imgRowVisibleByDefault()` 里那条 `via === 'contextMenu'` —— 用户手动要的行不许被折叠规则藏掉。 */
    ctxmenu: 'note'
  };

  /**
   * 状态类 → 图标（2026-10-11 用户裁决：200px 宽面板下 OCR 行改「图标 + 短标签」）。
   * 按 `stateClass()` 的六个类取值，不是按键 —— 同一类的东西给同一枚图标，扫一眼就能分类：
   * ✓ 命中 / ✕ 未命中 / ⟳ 还没跑完 / ⚠ 真失败 / ℹ 读不到图这类中性告知 /
   * ⚙ 要你动手（跨域未授权：去设置页把域名加进去）。
   */
  const ICON = { hit: '✓', miss: '✕', wait: '⟳', bad: '⚠', note: 'ℹ', action: '⚙' };

  /** 本表认识的键（枚举对账用；**必须与 `img-ocr.js` 真正会产出的集合完全相等**） */
  const KEYS = Object.keys(COPY);

  /**
   * "读过了、但结果不可用"的三类告知（S1-c / D-14.5）—— 也是 `done` 态。
   * 必须在 `miss` 之前判：`truncated`（长图超过块数上限，只读了前若干块）/`no-text`（一个字都没认出来）/
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
      /* ④ 右键识别（2.0.1.17）：没有关键词可匹配 ⇒ 既非命中亦非未命中。
       *    放在 NOTICE 之后：引擎说"图太大只读了前 8 块 / 一个字没认出"比「已识别」具体得多。 */
      if (o.via === 'contextMenu') return 'ctxmenu';
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

  /**
   * 句末标点 —— 句子切分只用这些（中英句号/叹问号/分号/换行）。
   * 逗号、空格**不算**边界：原文用 `,` 断句时，"一句话"宁可切大一点，
   * 也不要因为一个逗号就只复制半句（用户要的是"它所在的那句"）。
   */
  const SENT_END = /[。！？!?;；\n\r]/;

  /**
   * 取 `text` 里**包含** `needle` 第一次出现位置的那一整句（2026-10-09 用户口径：
   * 命中「9月」，原文是「9月份的量，给你了」⇒ 复制这一整句，不是那两个字）。
   *
   * 找不到 `needle`、或原文没有任何边界可切时返回 `''` —— 调用方据此回退到命中词
   * 本身（**不猜、不截一段**）。`needle` 可能跨句末标点出现（识别文本里词被换行切开），
   * 这时以第一次出现处为准。
   *
   * @param {string} text 识别出的原文
   * @param {string} needle 命中的词
   * @returns {string} 含 `needle` 的那一句（带句末标点，已 trim）；定位不到则 `''`
   */
  function sentenceOf(text, needle) {
    const s = String(text == null ? '' : text);
    const n = String(needle == null ? '' : needle);
    if (!n) return '';
    const at = s.indexOf(n);
    if (at < 0) return '';
    let start = 0;
    for (let i = at - 1; i >= 0; i -= 1) {
      if (SENT_END.test(s.charAt(i))) { start = i + 1; break; }
    }
    let end = s.length;
    for (let i = at + n.length; i < s.length; i += 1) {
      if (SENT_END.test(s.charAt(i))) { end = i + 1; break; }
    }
    return s.slice(start, end).trim();
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

  /** 状态类：`hit` / `miss` / `wait` / `note` / `bad` / `action`（决定底色与常显与否，见文件头口径） */
  function stateClass(it) {
    const key = keyOf(it);
    return CLASS[key] || 'note';
  }

  /** 状态图标（配合短标签用；未知类一律中性 ℹ —— 与 `stateClass` 的兜底同口径） */
  function icon(it) {
    return ICON[stateClass(it)] || ICON.note;
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
    VIEW: VIEW,
    keyOf: keyOf,
    tag: tag,
    icon: icon,
    why: why,
    costLabel: costLabel,
    costTip: costTip,
    stateClass: stateClass,
    sentenceOf: sentenceOf,
    render: render,
    dump: dump
  };
})();
