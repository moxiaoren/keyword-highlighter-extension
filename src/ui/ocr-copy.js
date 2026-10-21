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
