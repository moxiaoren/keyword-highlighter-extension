'use strict';
/* src/ui/ocr-copy.js —— **OCR 用户可见文案的唯一真源**（票 #17 决议 D-17.1）
 * ----------------------------------------------------------------------------
 * 2.0.2.15 清场：面板的「🖼 图片命中」分区整个删掉之后，原来那套**条目状态词表**
 * （COPY / CLASS / ICON / tag() / why() / stateClass() / costLabel() …）**再没有任何读者**，
 * 一并删除 —— 留着就是第二份会过期的说法。现在这个模块只负责两件事：
 *
 *   ① `VIEW`：面板、灯箱、欢迎页共用的**界面文案**（谁都不许在自己文件里写死中文）；
 *   ② `render()` 占位符替换 + `sentenceOf()` 句子定位（灯箱词块"复制它所在那一整句"）。
 *
 * 载入方式：content_scripts 与 options/popup 两侧共用（照 `src/ui/fieldmap.js` 的形状），
 * 注册点见 `manifest.json` 的 content_scripts.js、`options/options.html`、`popup/popup.html`。
 */
(function () {
  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /**
   * 界面文案表。面板 / 灯箱 / 欢迎页一律从这里取字，谁都不许在自己文件里写死中文
   * （`tests/specs/ocr-copy.test.js` 与 `tests/specs/note-img-fold.test.js` 的源码契约会红）。
   * 占位符由 `render()` 替换：`{n}` 条数 / `{host}` 域名。
   */
  const VIEW = {
    /* F3.4（2.0.1.16，用户 2026-10-13 拍板「展开笔记 ▾ / 展开图片 ▾」）：分区题头按分区各自命名，
     * 逐字相同的两个按钮读屏分不清展开的是哪一块。2.0.2.15 起「🖼 图片」分区已删 ⇒ 只剩笔记区这一对，
     * 措辞不变（arrow 字符与措辞一样是文案，真源只在这里；面板不许自己写）。 */
    noteExpand: '展开笔记 ▾',
    noteCollapse: '收起笔记 ▴',
    /* ---- 2026-10-09 简约展示：命中词块 / 光箱全文栏 ----
     * 面板不许自己写这些字（源码契约会红），一律从这张表取。
     * 2.0.1.15 需求 7：面板那条「📋 复制全文」按钮按用户裁决删除，只服务它的两个文案键
     * 一并删掉（全仓已无读者，留着就是没人读的死字符串）；复制全文改走大图里
     * 的选中复制（见 .kh-lb-side 的 user-select: text）。 */
    textPane: '识别出的文字',
    copySentence: '复制这句话',
    /* ---- 灯箱右栏可隐藏（2.0.1.15 需求 5）----
     * 右侧全文栏在窄视口下会挤占图片空间，用户要能临时收起；按钮的两个标签同样只认这张表
     * （灯箱/面板不许自己写这两句 —— 源码契约会红）。 */
    paneHide: '隐藏全文',
    paneShow: '显示全文',
    /* ---- 大图里一键 OCR（2.0.2.15 需求①）----
     * 用户口径：按钮就放在「隐藏/显示全文」那个位置；还没识别的图它是「OCR 识别」，
     * 认完（或本来就有文本）才变回「隐藏/显示全文」。所以这四个键是这个位置的另一半语义，
     * 灯箱不许自己写中文（源码契约会红）。
     *   paneOcr      —— 未识别的按钮面
     *   paneOcrBusy  —— 点下去到结果回来之间（此时按钮置灰）
     *   paneOcrTip   —— 未识别时的悬停说明（说清"点了会发生什么"）
     *   paneOcrFail / paneOcrDenied —— 失败原因（挂 title，按钮回到可再点的「OCR 识别」）；
     *     Denied 专指"这个地址不允许扩展去读"（私网/本机地址被入口闸门拦下）。 */
    paneOcr: 'OCR 识别',
    paneOcrBusy: '识别中…',
    paneOcrTip: '识别这张图里的文字（识别后在这里显示全文）',
    paneOcrFail: '识别失败，点这里重试',
    paneOcrDenied: '这个地址不允许识别（仅限公网图片）',
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
    /* ---- 形态只剩悬窗一种（【台账 #2】删掉 2026-11-03 的贴边条/摘要列）----
     * 用户原话：「重要笔记悬浮窗优化（还是之前说的内容过多，主次不分明，遮挡页面等问题）」。
     * 面板里一个中文都不许自己写：条数、收起、定位、复制、空态全在这里。 */
    /* 【台账 #2】只剩一种形态：收起 = 换回那颗圆形小按钮。 */
    collapseBtn: '收起',
    collapseTip: '收起成小圆钮',
    locate: '定位',
    locateTip: '在页面里定位第一个命中词',
    copyAll: '复制这几条',
    copied: '已复制',
    rowsEmpty: '还没有笔记',
    ctxSub: '右键识别的图',
    rowCount: '{n} 处',
    /* 【2.0.8.4 需求③】浮窗单卡收起/展开：逐卡折叠，只留标签行。
     * 箭头是装饰，真实语义挂在这两句悬停说明上（读屏靠 title / aria-expanded）。 */
    cardCollapse: '收起这张卡片',
    cardExpand: '展开这张卡片',
    /* 【2.0.8.6 需求①】图文合并里「默认不展示」的那几行：卡片底部一个开关，{n} = 几条。 */
    mergeMore: '显示 {n} 条合并行',
    mergeLess: '收起合并行',
    /* 【2.0.8.18 需求②·P1】合并行的两路值不一致时，表里只放一个值，另一路摊在悬停里。
     * 文案只在这里写一次：面板的 title、`both` 策略的分隔符都取这几句。 */
    conflictTipOcr: '图片上的值：',
    conflictTipFetch: '页面抓取值：',
    conflictTipBoth: '（两个值都显示：左＝页面抓取值，右＝图片上的值）',
    conflictTipWeak: '这个值太短，没参与一致性判定（可能只是日期/编号的一部分）',
    conflictTipOnlyA: '图片上没识别到这个值，用的是页面抓取值',
    conflictTipOnlyB: '页面没抓到这个字段，用的是图片上的值',
    conflictBothSep: ' ｜ ',
    /* 【2.0.8.19 · P4】软著三方比对的结论行（表格下方一行；没问题就不渲染）。
     * {left}/{right} = 字段名；{lv}/{rv} = 两边的原值；{vals} = 授权书内部的多个值。
     * 口径与 2.0.8.7 的「有值才进表」一致：只报**必须让人看见**的差，缺数据另算一种。 */
    /* 【2.0.8.21 缺陷②】原来把「授权公司 / 被授权公司 / 登记号」写死在文案里：用户配的是
     * `著作权人 ↔ 授权方` 时，提示里说着一堆自己没配的字段名。改成按**实际配置的右侧字段名**拼
     * （`{names}` = 「授权公司」「被授权公司」这种串，由 `compareText` 从配置里取）。 */
    cmpNoDoc: '⚠ 未识别到软著授权书（图上没找到{names}），无法比对',
    /* 【2.0.8.21 缺陷①】两边配的是同名字段（如 `登记号 ↔ 登记号`）时，任何一张图都同时"在左也在右"，
     * 靠字段名判断不出哪张是授权书。这时说"没找到授权书"是误导——用户明明放了。 */
    cmpNoDocAmbig: '⚠ 无法判断哪张图是授权书：配置的字段两边同名，请至少配一组不同名的字段（如 开发者 ↔ 被授权公司）',
    cmpMismatch: '⚠ {left}与{right}不一致：图上是「{lv}」/ 授权书是「{rv}」',
    cmpMissRight: '⚠ 缺「{right}」（授权书未识别到该字段）',
    cmpMissLeft: '⚠ 缺「{left}」（软著证明或页面未识别到该字段）',
    cmpDocMulti: '⚠ 「{right}」在授权书里出现了两个值（{vals}）',
    cmpSep: '；',
    /* ----【2.0.8.4 需求④】AI 对话助手（面板里的第二个页签，贴边与浮窗共用）----
     * 口径：纯自由对话 —— 不把页面标题 / URL / 笔记内容发出去（用户 2026-11-03 拍板），
     * 占位符里把这句话写清楚，免得用户以为助手"能看见页面"。 */
    tabNote: '笔记',
    tabAi: 'AI 助手',
    aiSend: '发送',
    aiSendTip: '发送（Enter 发送，Shift+Enter 换行）',
    aiPlaceholder: '问点什么…（纯自由对话，不会带上页面内容）',
    aiThinking: '正在回复…',
    aiNeedKey: '当前是 API 模式但还没配好：去设置页「样式 → AI 助手」填接口地址和 Key；想免 Key 就在那里把模式切回「网页对话」。',
    aiOpenOptions: '去设置',
    aiClear: '清空',
    aiClearTip: '清空对话（网页模式会同时在对话页开一个新对话）',
    /* ----【2.0.8.7 需求②】审核入口：查应用名称 / 图标是否蹭知名品牌、是否涉敏感内容。
     * 口径：本地词库先筛（免费、不上传），云端只复核"看图"这件事，走 Cloudflare 免费额度。 */
    aiAudit: '审核',
    aiAuditTip: '查应用名称 / 图标：有没有蹭知名品牌、有没有涉赌博色情资金盘诈骗（本地词库免费，云端走 Cloudflare 免费额度）',
    aiAuditName: '应用名称（可留空）',
    aiAuditPick: '选图标',
    aiAuditPickDone: '换一张',
    aiAuditRun: '开始审核',
    aiAuditRunning: '审核中…',
    aiAuditNeed: '先填一个应用名称，或选一张图标。',
    aiAuditLocalOnly: '只跑了本地词库（不上传任何东西）。',
    aiAuditNoKey: '还没填 Cloudflare 账号 ID / Token，云端那步跳过了；要复核去设置页「AI 审核」填一下。',
    aiAuditFail: '云端审核失败',
    aiAuditEmptyName: '（未填名称）',
    aiEmpty: '还没有对话',
    /* ----【2.0.8.5】网页对话（默认免 Key）：状态带 / 头像 / 开场白 / 去登录 ---- */
    aiModeWeb: 'DeepSeek 网页对话',
    aiModeWebTip: '走 chat.deepseek.com 的登录态，免 Key；会有一个对话页标签页在后台替你发消息',
    aiModeApi: 'API 模式',
    aiModeApiTip: '走设置页里填的 OpenAI 兼容接口',
    aiNotReady: '未配置',
    aiAvMe: '我',
    aiCopy: '复制',
    aiGoLogin: '去登录',
    aiSeed1: '用一句话解释什么是 CSS Highlight',
    aiSeed2: '帮我把这段话改得更简洁',
    aiSeed3: '给我三个起名思路',
    /* 【2.0.2.7 用户 m00292】卡片里那张图被 OCR 命中了（红框 + 悬停说出命中的是哪个词）。 */
    imgHitTip: '这张图里出现了「{matched}」',
    /* ---- 【2.0.6.1 需求⑧】图片 OCR 边框三态（蓝=识别中 / 红=命中 / 绿=无命中）----
     * 用户原话：「识别中给蓝色边框，命中给红色边框（保持），没命中给绿色边框」。三态之外还有
     * 「识别失败」——它不能挂蓝框（像还在跑），也不该挂红框，所以归到「无命中」的绿框，
     * 悬停里说实话（失败原因）。文案真源在这里，面板不许自己写。 */
    imgBusyTip: '正在识别这张图…',
    imgMissTip: '已识别，未命中',
    imgMissValue: '图上没找到要的值',
    imgMissField: '字段没取到值',
    imgMissEmpty: '没识别出文字',
    imgFailTip: '识别失败',
    /* ---- 【2.0.6.5 需求②】PDF 占位（用户口径：不展示源文件，只要占位；蓝框识别中 /
     * 绿框无命中 / 命中加红框；点击后展示全文与命中内容）。话术与图片三态一一对应，
     * 只是把"这张图"换成"这份 PDF"。与图片一样：面板里不许自己写中文。 ---- */
    pdfBusyTip: '正在读这份 PDF…',
    pdfMissTip: '已读完，未命中',
    pdfEmptyTip: '没抽到文字，可能是扫描件',
    pdfHitTip: '这份 PDF 里出现了「{matched}」',
    pdfFailTip: '这份 PDF 读不出文字',
    /* 【2.0.2.13 · 用户 m03971】右键识别的图折进「重要笔记」主模块，作为一张表格卡片：
     * 左格（表头）固定叫「截图」，所有右键识别的图都塞进它右边那一格。
     * 这句是**表头内容**，不是按钮文案 —— 面板不许自己写死（源码契约会红）。 */
    ctxShotLabel: '截图',
    /* 右键识别那张卡的两种瞬时状态（2.0.2.15 需求②：受理即展示，所以"识别中"必须说得出来） */
    ctxBusy: '识别中…',
    ctxFail: '识别失败',
    removeTip: '本次页面不再显示',
    /* ---- T41（用户 2026-10-12 拍板方案 2）：灯箱全文栏自带的操作入口 ----
     * 复制成功/失败要就地反馈（失败必须说出来，不许静默）；「共 N 行」是次要信息。
     * 失败文案不写"点图放大"——这按钮本来就在大图里，那样等于让用户绕圈。 */
    paneCopy: '复制',
    paneCopied: '已复制',
    paneCopyFail: '复制失败，请手动选中文字',
    paneLines: '共 {n} 行'
  };

  /** 值替换：`{k}` → `vars[k]`（缺失就留原样，便于发现占位符写错） */
  function render(tpl, vars) {
    const v = vars || {};
    return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] == null ? m : String(v[k])));
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

  KH.OcrCopy = {
    VIEW: VIEW,
    render: render,
    sentenceOf: sentenceOf
  };
})();
