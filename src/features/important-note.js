/* ============================================================================
 * src/features/important-note.js · 重要笔记面板（⑦Consume 消费者）
 * ----------------------------------------------------------------------------
 * 数据来源（只读注册表，不监听 DOM —— 功能一律通过 ⑦Consume 取数）：
 *   `registry.all()` 里 `meta.important === true` 的命中。
 *
 * 本文件承载四条**用户打磨过很久**的既有语义，重构时必须逐条复现：
 *
 * ① 聚合分卡铁律（附录A §5.7 / 策划案 §3.4）：
 *      先按**内容(note)一致**分卡 —— 内容不一致**绝不**进同一卡；
 *      卡内标签再按「标题 / 关键词」形态聚合：
 *        同标题多值   → `🔖 标题 → a|b`
 *        多标题同值   → `🔖 标题1|标题2 → a`
 *        无标题多词   → `🔖 a|b`
 *        值、标题都不同 → **平铺不交叉**
 *    （旧版 content/important-note.js:253-299 收集 + :438-480 buildTagHtml 的分支。
 *      v2 重构时丢掉了这套语义，退化成"一条命中一张卡 + 标签写死 `标题：x`"。）
 *
 * ② 抓取内容的多行格式（附录A §8）：
 *      · 提取层用**视觉行**（flex 同行合并、真实换行保留、控件剔除）
 *      · 渲染层用**多行表格**（保留 rowspan/colspan、两级分组标题）
 *      · 展示容器一律 `white-space: pre-line`（**不得**用 normal，否则 `\n` 折叠成空格）
 *      算法单源在 `src/features/fetch.js`，本文件只负责插进 DOM。
 *
 * ③ 面板形态（策划案 §5.2.3 / §3.4）：
 *      **左上角**置顶（v1.52.0 口径，K26 用户确认；策划案那三处"右上角"已作废，meta-check 有红线钉住）、
 *      可拖动（按头部/FAB）、标题栏 **双击收起为圆形 FAB、再双击展开**、
 *      Shadow DOM 隔离、聚合多条命中、**单条可关闭（本次页面会话）**。
 *
 * ④ 图片：抓取字段里的 `<img>` 以缩略图展示（点击看原图），
 *      尺寸由每词 `imgSize`（分组可统一）覆盖，宽高统一**等比**（不裁剪）。
 *
 * 与旧版的差：旧版靠给命中处**插 span + `data-kh-important*` 属性**把数据带出来
 * （keyword-engine.js:1661-1695），既是数据载体又是 DOM 改造，双违规。
 * v2 数据全在注册表里 —— 页面 DOM 里**零插件节点**（UN-01/02）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const HOST_ID = 'kh-important-note-host';

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .khin-wrap {
      position: fixed; z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      user-select: none;
    }
    /* ---------- 收起态：圆形 FAB ---------- */
    .khin-fab {
      width: 48px; height: 48px; border-radius: 50%;
      background: linear-gradient(135deg, #3579c2, #5fb0ee); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; cursor: move; position: relative;
      box-shadow: 0 4px 14px rgba(74, 144, 217, .4);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .khin-fab:hover { transform: scale(1.06); }
    .khin-fab-badge {
      position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 9px; background: #e53935; color: #fff;
      font-size: 12px; font-weight: 600; line-height: 18px; text-align: center;
      border: 2px solid #fff;
    }
    /* ---------- 展开态：面板 ---------- */
    .khin-panel {
      width: 360px; min-width: 220px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 24px); background: #fff;
      border: 1px solid #e3e8f0; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18);
      overflow: hidden; display: flex; flex-direction: column;
      resize: both; animation: khin-in .16s ease-out;
    }
    .khin-wrap[hidden] { display: none !important; }
    @keyframes khin-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .khin-header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(180deg, #fff, #eaf1fb);
      border-bottom: 1px solid #eef1f6; cursor: move; flex-shrink: 0;
    }
    .khin-header-icon { font-size: 16px; }
    .khin-header-title { font-size: 14px; font-weight: 600; color: #3579c2; flex: 1; }
    .khin-header-count { font-size: 12px; color: #3579c2; background: #eaf1fb; border-radius: 10px; padding: 1px 8px; }
    .khin-header-btn {
      background: none; border: none; cursor: pointer; font-size: 15px;
      color: #8a8a8a; padding: 2px 4px; border-radius: 4px; line-height: 1;
    }
    .khin-header-btn:hover { color: #333; background: rgba(0,0,0,.05); }
    .khin-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 0; }
    .khin-body::-webkit-scrollbar { width: 5px; }
    .khin-body::-webkit-scrollbar-thumb { background: #d8d8d8; border-radius: 3px; }
    .khin-body::-webkit-scrollbar-track { background: transparent; }
    .khin-item { padding: 9px 12px; border-bottom: 1px solid #f3f3f3; }
    .khin-item:last-child { border-bottom: none; }
    .khin-item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 5px; }
    .khin-item-tags { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; min-width: 0; }
    .khin-item-kw {
      font-size: 12px; font-weight: 600; color: #3579c2; background: #eaf1fb;
      border-radius: 4px; padding: 1px 7px; max-width: 200px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
    }
    .khin-item-adj {
      font-size: 12px; font-weight: 600; color: #2e7d32; background: #e8f5e9;
      border-radius: 4px; padding: 1px 7px; max-width: 200px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
    }
    .khin-item-close {
      background: none; border: none; cursor: pointer; color: #bbb;
      font-size: 13px; padding: 2px 4px; border-radius: 4px; line-height: 1; flex-shrink: 0;
    }
    .khin-item-close:hover { color: #e53935; background: #ffe9e9; }
    /* 内容 / 标签可选中复制；外壳保持 user-select:none 仅避免误选 */
    .khin-item-note, .khin-item-tags, .khin-item-kw, .khin-item-adj, .kh-table {
      user-select: text; -webkit-user-select: text;
    }
    .khin-item-note ::selection, .kh-table ::selection { background: #a6d3ff; color: inherit; }
    /* 重要笔记正文：**必须保留换行**（旧版 v1.8.3 教训；Markdown 渲染会在行间产生 \\n 文本节点） */
    .khin-item-note {
      font-size: 13px; line-height: 1.6; color: #333;
      white-space: pre-line; word-break: break-word; overflow-wrap: break-word;
    }
    .khin-item-note a { color: #1a73e8; text-decoration: none; }
    .khin-item-note a:hover { text-decoration: underline; }
    .khin-item-note b, .khin-item-note strong { font-weight: 600; color: #1f2937; }
    .khin-item-note img, .khin-item-body img {
      max-width: var(--kh-img-size, 70px); max-height: var(--kh-img-size, 70px);
      width: auto; height: auto;          /* 等比缩放，**不裁剪** */
      border-radius: 4px; margin: 4px 8px 4px 0;
      display: inline-block; vertical-align: middle; cursor: pointer;
    }
    .khin-item-note img:hover, .khin-item-body img:hover { opacity: .92; }
    .khin-item-body { margin-top: 4px; }
    .khin-empty { padding: 20px; text-align: center; color: #aaa; font-size: 13px; }
    /* 抓取后续字段渲染的多行表格：**所有**单元格保留换行（v1.8.3）
     * 宽度（v1.99.99.11 用户实测要求）：**按内容收缩**，不再无条件 width:100%。
     *   用户原话："表格总宽度总是等于重要笔记宽度…避免明明就一列，结果宽度上还是填满了重要笔记"。
     *   width:auto + max-width:100% = 内容短就窄（贴合观看习惯），内容长仍撑到容器宽度后换行、不溢出。 */
    .kh-table { border-collapse: collapse; margin-top: 4px; width: auto; max-width: 100%; }
    .kh-table td {
      border: 1px solid #d3dae3; padding: 3px 8px; font-size: 12px; line-height: 1.5;
      background: #fff; text-align: left; vertical-align: middle;
      white-space: pre-line; word-break: break-word;
    }
    /* 抓取表格没有表头行：**只有**字段 label 格上色（它是左列列标题，右侧全是它的内容）。
       绝不能按"首行当表头"着色 —— 那会把「基本信息 / 驳回字段：X / 32位包:」也标成行标题。 */
    .kh-table .kh-table-label {
      background: var(--kh-brand-soft, #eaf1fb); font-weight: 600; color: var(--kh-text, #1f2937);
    }
    /* ---- 🖼 图片命中分区（面板下半部分，独立成块；默认折叠） ---- */
    .khin-imgsec { border-top: 1px solid rgba(148,163,184,.35); margin-top: 2px; }
    .khin-imgsec[hidden] { display: none; }
    .khin-imghead {
      display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
      padding: 6px 2px 4px; font-size: 12px; font-weight: 600; color: var(--kh-text, #1f2937);
    }
    .khin-imghead .khin-imgcount { color: #64748b; font-weight: 500; }
    /* 「显示全部 / 只看命中」= 人工复核入口（用户 2026-10-06：面板以命中为目的，
       没命中的图默认不展示，但必须留一条能打开的渠道）。放在题头右侧、箭头左边。 */
    .khin-imghead .khin-imgall {
      margin-left: auto; color: #2563eb; font-size: 11px; font-weight: 500;
      cursor: pointer; text-decoration: underline;
    }
    .khin-imghead .khin-imgall[hidden] { display: none; }
    .khin-imghead .khin-imgarrow { margin-left: auto; color: #94a3b8; font-size: 11px; }
    /* 默认视图里一条都没有时的说明行（不能悄悄空白：那看起来就是坏了） */
    .khin-imgnone { color: #94a3b8; font-size: 12px; padding: 2px 0 4px; }
    .khin-imglist { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 4px; }
    .khin-imgitem { display: flex; gap: 8px; align-items: flex-start; }
    .khin-imgthumb {
      width: 56px; height: 56px; flex: 0 0 56px; object-fit: cover; border-radius: 6px;
      border: 1px solid rgba(148,163,184,.45); background: #f1f5f9; cursor: zoom-in;
    }
    .khin-imgmeta { min-width: 0; flex: 1; font-size: 12px; line-height: 1.5; color: #334155; }
    .khin-imgkw { font-weight: 600; color: #0f172a; }
    .khin-imgtag { font-size: 11px; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    /* 本次识别的真实耗时（S3-④）：只在有值时挂载，字号比标签再小一档、不抢主信息 */
    .khin-imgcost { font-size: 10px; color: #94a3b8; margin-left: 4px; font-variant-numeric: tabular-nums; }
    .khin-imgtag.hit { background: #dcfce7; color: #166534; }
    .khin-imgtag.miss { background: #f1f5f9; color: #64748b; }
    .khin-imgtag.bad { background: #fee2e2; color: #991b1b; }
    /* 进行中（wait 类）与「读不到图 / 缺资产」（note 类）**都不是故障，不许染红** ——
     * 票 #17 新登记的 P0：修复前所有非 done 状态都套 bad 类，于是 OCR 正常工作时
     * 面板上显示的是**红底的「识别中…」**，用户第一反应就是「出错了」。
     * 状态类由唯一真源 KH.OcrCopy.stateClass() 给出（见 src/ui/ocr-copy.js 文件头）。
     * ⚠️ 这段样式在模板字符串里，注释里**不能出现反引号**（会把模板提前闭合）。 */
    .khin-imgtag.wait { background: #e2e8f0; color: #475569; }
    .khin-imgtag.note { background: #f1f5f9; color: #475569; }
    /* 复制识别文本的小按钮（识别出来的长串编号/理由，用户常要粘到别处） */
    .khin-imgcopy {
      margin-left: 4px; padding: 0 5px; font-size: 11px; line-height: 16px; cursor: pointer;
      border: 1px solid rgba(148,163,184,.55); border-radius: 4px; background: #fff; color: #475569;
    }
    .khin-imgcopy:hover { background: #f1f5f9; }
    .khin-imgtext {
      margin-top: 2px; color: #475569; white-space: pre-wrap; word-break: break-word;
      max-height: 84px; overflow: auto; background: rgba(148,163,184,.12); border-radius: 4px; padding: 3px 5px;
    }
    .khin-imgtext[hidden] { display: none; }
    .khin-imgempty { font-size: 12px; color: #64748b; padding: 2px 0 6px; }
  `;

  /** 图片协议白名单（与内容脚本 sanitize 同口径：仅 http(s)） */
  const IMG_PROTOCOL_OK = /^https?:\/\//i;

  /** 灯箱允许的图片来源：http(s) 之外还允许 `data:image/*`
   *  —— v1.52 起"抓取到的图片"就可能是内嵌的 data URI（旧版注释写着"data: 内嵌图无需跳转"），
   *  它本身就是原图数据，在灯箱里显示是安全的（`<img src>` 不执行脚本）。 */
  const LIGHTBOX_SRC_OK = /^(https?:\/\/|data:image\/)/i;

  /* =================== 看大图（灯箱） ===================
   * 旧行为是 `window.open(src, '_blank')`（新标签页）——用户实测反馈："查看大图的效果是跳出新的标签页，
   * 或者下载。可以做成当前标签页展示大图么"。现改为**当前页内的灯箱**：
   *   · 单独一个 `[data-kh-ext-ui]` 宿主挂在 body 上（不放在面板的 ShadowRoot 里 ——
   *     否则会被面板的定位/尺寸裁剪，做不到"盖住整个视口"）；
   *   · 图片等比适配视口（max 92vw/86vh），不放大到失真以上；
   *   · 保留一个「在新标签页打开」的兜底入口（需要另存/发给别人时用）。
   *
   * v1.99.99.8 按用户要求补上**缩放 / 旋转 / 上一张 下一张**（相册只按同一个表格单元格归组）。
   *
   * v1.99.99.11 按用户实测再改三处交互：
   *   · **点图片不再退出**（用户原话："放大图点击图片就退出大图模式，这不符合预期"）——
   *     现在点图片是**拖动平移**（pointer 捕获；双击复位），只有**点图片以外的遮罩区域**才退出；
   *   · 「上一张 / 下一张」从下方工具条挪到**图片两侧**（48×48 大按钮，原来 30×26 太小按不准）；
   *     单张时**隐藏**（不是置灰 —— 绝对定位后隐藏不会再导致布局跳动）；
   *   · 张数指示留在下方工具条（`1 / 2`，tooltip 里写全"第 1 张 / 共 2 张"）。
   *
   * v1.99.99.12 又按用户实测微调三处：
   *   · **容器收紧 + 容器内点击一律不退出**：整块内容（[上一张][图][下一张] + 下方工具条）是一个
   *     **有界的容器**(`.kh-lb-stage`)，容器**内部**任何点击都不关；只有点容器外的暗色遮罩（或 Esc）才关。
   *     （原来"点遮罩即关"的判定范围是整屏，紧贴图片的空白也会误关。）
   *   · 左右按钮**贴着图片**（容器内 flex 排布、间距 12px），不再钉在视口两端；
   *   · **放大后图片不再压住按钮**：图片 z-index 低于按钮与工具条（`transform` 不改布局盒，
   *     但会视觉溢出压到按钮上 → 按钮点不到；现在按钮/工具条都在图片之上）。
   * 平移有**边界**（最多把图挪到还能看见一角），缩放变化后会重新夹紧 —— 不会把图拖丢。
   */
  const LIGHTBOX_ID = 'kh-note-lightbox';
  const LIGHTBOX_ZOOM_MIN = 0.25;
  const LIGHTBOX_ZOOM_MAX = 8;
  const LIGHTBOX_ZOOM_STEP = 1.25;
  /** 平移边界余量：即使图比视口小，也允许挪这么多（手感不死板），但不允许挪出视野丢掉 */
  const LIGHTBOX_PAN_SLACK = 60;
  const LIGHTBOX_STYLE = `
    .kh-lb { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.78);
      display: flex; align-items: center; justify-content: center; cursor: default; }
    .kh-lb[hidden] { display: none !important; }
    /* 容器：有界的一块（图片 + 左右按钮 + 下方工具条）。**容器内点击一律不关** —— 关闭只认容器外的遮罩。
     * v1.99.99.18 用户反馈："明确大图容器范围，目前没有做区分" → 容器给**实心底色 + 边框 + 圆角阴影**，
     * 与暗色遮罩明显区分；按钮也改成**不透明底色 + 描边 + 白字**，避免"按钮和图片颜色接近时看不清"。 */
    .kh-lb-stage {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 12px; max-width: 96vw; max-height: 96vh;
      border: 1px solid rgba(255,255,255,.18); border-radius: 12px;
      background: rgba(22,26,34,.94);                      /* 实心底色：一眼看出"这是插件的容器" */
      box-shadow: 0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.35);
      cursor: default;
    }
    .kh-lb-row { display: flex; align-items: center; gap: 12px; }
    .kh-lb img { max-width: 84vw; max-height: 78vh; width: auto; height: auto;
      position: relative; z-index: 1;                 /* 图片在下层：放大溢出时不许压住按钮 */
      border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.45); background: #fff;
      transform-origin: center center; transition: transform .12s ease-out;
      cursor: grab; touch-action: none; -webkit-user-drag: none; user-select: none; }
    .kh-lb img.kh-lb-dragging { cursor: grabbing; transition: none; }
    /* 左右翻页：紧贴图片两侧（容器内 flex），大点击区（48×48）；层级高于图片。
     * 底色**不透明**（rgba(0,0,0,.42) 那种会被浅色图片透上来）→ 用实心底 + 亮描边 + 白字。 */
    .kh-lb-nav {
      position: relative; z-index: 2;
      flex: 0 0 auto;
      width: 48px; height: 48px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid rgba(255,255,255,.45); border-radius: 50%;
      background: #39404e; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,.6);
      box-shadow: 0 2px 10px rgba(0,0,0,.45);
      font: inherit; font-size: 24px; line-height: 1; cursor: pointer; }
    .kh-lb-nav:hover { background: #4b5464; border-color: rgba(255,255,255,.75); }
    .kh-lb-nav[hidden] { display: none !important; }
    .kh-lb-bar { position: relative; z-index: 2; display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: #e8eef7; cursor: default; }
    /* 工具条按钮：同样改成实心底色（原来是透明底 + 半透明边框，压在图上会糊成一片） */
    .kh-lb-btn, .kh-lb-open { height: 26px; padding: 0 10px; border: 1px solid rgba(255,255,255,.45);
      border-radius: 999px; background: #39404e; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,.6);
      font: inherit; font-size: 12px; cursor: pointer; }
    .kh-lb-btn { min-width: 30px; padding: 0 8px; }
    .kh-lb-btn:hover, .kh-lb-open:hover { background: #4b5464; border-color: rgba(255,255,255,.75); }
    .kh-lb-idx { min-width: 40px; text-align: center; opacity: .9; font-variant-numeric: tabular-nums; }
    .kh-lb-sep { opacity: .35; }
    .kh-lb-hint { opacity: .75; }
  `;

  /** 打开灯箱。`gallery`/`index` 为同一单元格内的相册（省略即单张）。返回是否打开成功 */
  function openLightbox(src, alt, gallery, index) {
    if (!src || !LIGHTBOX_SRC_OK.test(src)) return false;   // javascript: 等不处理
    let host = document.getElementById(LIGHTBOX_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = LIGHTBOX_ID;
      host.setAttribute('data-kh-ext-ui', '1');             // 自身 UI 标记：不参与扫描/悬停命中
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<style>' + LIGHTBOX_STYLE + '</style>' +
        '<div class="kh-lb" hidden>' +
        '<div class="kh-lb-stage">' +
        '<div class="kh-lb-row">' +
        '<button class="kh-lb-nav kh-lb-prev" type="button" title="上一张（←）" aria-label="上一张">‹</button>' +
        '<img class="kh-lb-img" alt="">' +
        '<button class="kh-lb-nav kh-lb-next" type="button" title="下一张（→）" aria-label="下一张">›</button>' +
        '</div>' +
        '<div class="kh-lb-bar">' +
        '<span class="kh-lb-idx"></span>' +
        '<span class="kh-lb-sep">|</span>' +
        '<button class="kh-lb-btn kh-lb-out" type="button" title="缩小（-）">－</button>' +
        '<button class="kh-lb-btn kh-lb-in" type="button" title="放大（+）">＋</button>' +
        '<button class="kh-lb-btn kh-lb-rot" type="button" title="旋转 90°（R）">⟳</button>' +
        '<button class="kh-lb-btn kh-lb-reset" type="button" title="复位（也可双击图片）">复位</button>' +
        '<span class="kh-lb-sep">|</span>' +
        '<button class="kh-lb-open" type="button">在新标签页打开</button>' +
        '<span class="kh-lb-hint">拖动图片可平移；点图片外区域或按 Esc 关闭</span>' +
        '</div></div></div>';
      const box = sr.querySelector('.kh-lb');
      const img = sr.querySelector('.kh-lb-img');
      const prev = sr.querySelector('.kh-lb-prev');
      const next = sr.querySelector('.kh-lb-next');
      const idxEl = sr.querySelector('.kh-lb-idx');
      const close = () => { box.hidden = true; img.removeAttribute('src'); };
      /** 平移夹紧：最多让图挪到"还能看见"的范围（缩放变化后也要重夹，别把图拖丢） */
      const clampPan = (tx, ty) => {
        const r = img.getBoundingClientRect();
        const limX = Math.max(0, r.width - window.innerWidth) / 2 + LIGHTBOX_PAN_SLACK;
        const limY = Math.max(0, r.height - window.innerHeight) / 2 + LIGHTBOX_PAN_SLACK;
        return {
          x: Math.min(limX, Math.max(-limX, tx)),
          y: Math.min(limY, Math.max(-limY, ty))
        };
      };
      /* 状态 → 视图：图片地址/alt、张数、左右按钮显隐、缩放/旋转/平移 */
      const apply = () => {
        const g = host._gallery || [];
        const i = host._idx || 0;
        const cur = g[i];
        if (cur) {
          img.setAttribute('src', cur.src);
          if (cur.alt) img.setAttribute('alt', cur.alt); else img.removeAttribute('alt');
        }
        const multi = g.length > 1;
        prev.hidden = !multi;                               // 单张：隐藏（不是置灰）
        next.hidden = !multi;
        idxEl.textContent = multi ? ((i + 1) + ' / ' + g.length) : '';
        idxEl.setAttribute('title', multi ? ('第 ' + (i + 1) + ' 张 / 共 ' + g.length + ' 张') : '');
        const p = clampPan(host._tx || 0, host._ty || 0);
        host._tx = p.x;
        host._ty = p.y;
        img.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px) scale(' +
          (host._scale || 1) + ') rotate(' + (host._rot || 0) + 'deg)';
      };
      const step = (d) => {
        const g = host._gallery || [];
        if (g.length < 2) return;                           // 单张：不循环到自己
        host._idx = (host._idx + d + g.length) % g.length;  // 首尾循环
        host._tx = 0; host._ty = 0;                         // 换图回到居中
        apply();
      };
      const zoom = (f) => {
        const s = Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, (host._scale || 1) * f));
        host._scale = Math.round(s * 1000) / 1000;
        apply();
      };
      const rotate = () => { host._rot = ((host._rot || 0) + 90) % 360; apply(); };
      const resetView = () => { host._scale = 1; host._rot = 0; host._tx = 0; host._ty = 0; apply(); };
      const on = (el, fn) => el.addEventListener('click', (e) => {
        e.preventDefault();                                 // 别把按钮点击当成页面交互
        e.stopPropagation();
        fn();
      });
      on(prev, () => step(-1));
      on(next, () => step(1));
      on(sr.querySelector('.kh-lb-in'), () => zoom(LIGHTBOX_ZOOM_STEP));
      on(sr.querySelector('.kh-lb-out'), () => zoom(1 / LIGHTBOX_ZOOM_STEP));
      on(sr.querySelector('.kh-lb-rot'), rotate);
      on(sr.querySelector('.kh-lb-reset'), resetView);

      /* 图片：**拖动平移**（不再"点一下就退出"）。pointer 捕获 → 拖出图片范围也不丢指针。
       * 双击 = 复位（放大后想一步回到原始视图时的出口）。 */
      let drag = null;
      img.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, tx: host._tx || 0, ty: host._ty || 0 };
        img.classList.add('kh-lb-dragging');
        try { img.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也还能靠 move */ }
      });
      img.addEventListener('pointermove', (e) => {
        if (!drag) return;
        e.preventDefault();
        host._tx = drag.tx + (e.clientX - drag.x);
        host._ty = drag.ty + (e.clientY - drag.y);
        apply();
      });
      const endDrag = () => { drag = null; img.classList.remove('kh-lb-dragging'); };
      img.addEventListener('pointerup', endDrag);
      img.addEventListener('pointercancel', endDrag);
      img.addEventListener('lostpointercapture', endDrag);
      img.addEventListener('dblclick', (e) => { e.preventDefault(); resetView(); });

      /* 关闭：只在**点到容器（图片 + 左右按钮 + 工具条那一块）以外**时关。
       * v1.99.99.12 用户口径："减小容器范围，改成点击容器内都不会退出" ——
       * 判定用 `stage.contains(target)` 而不是"点在图片上吗"：容器内的空白（图与按钮之间的间隙、
       * 工具条周围的留白）也一律不关，只有容器外的暗色遮罩才算"点出去了"。 */
      const stage = sr.querySelector('.kh-lb-stage');
      const bar = sr.querySelector('.kh-lb-bar');
      box.addEventListener('click', (e) => {
        const t = e.target;
        if (t && stage.contains(t)) return;
        if (bar && t && bar.contains(t)) return;
        close();
      });
      sr.querySelector('.kh-lb-open').addEventListener('click', (e) => {
        e.stopPropagation();                                // 别顺带把灯箱关了
        const s = img.getAttribute('src');
        if (s) window.open(s, '_blank', 'noopener');
      });
      /* 键盘：只在灯箱真的开着时拦，避免影响页面自身行为 */
      document.addEventListener('keydown', (e) => {
        if (box.hidden) return;
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key === 'ArrowLeft') { e.stopPropagation(); step(-1); return; }
        if (e.key === 'ArrowRight') { e.stopPropagation(); step(1); return; }
        if (e.key === '+' || e.key === '=') { e.stopPropagation(); zoom(LIGHTBOX_ZOOM_STEP); return; }
        if (e.key === '-' || e.key === '_') { e.stopPropagation(); zoom(1 / LIGHTBOX_ZOOM_STEP); return; }
        if (e.key === 'r' || e.key === 'R') { e.stopPropagation(); rotate(); return; }
      }, true);
      host._apply = apply;
      host._close = close;
      document.body.appendChild(host);
    }
    const list = (gallery && gallery.length) ? gallery : [{ src: src, alt: alt || '' }];
    let idx = (typeof index === 'number' && index >= 0 && index < list.length) ? index : -1;
    if (idx < 0) {
      for (let i = 0; i < list.length; i++) if (list[i].src === src) { idx = i; break; }
    }
    if (idx < 0) idx = 0;
    host._gallery = list;
    host._idx = idx;
    host._scale = 1;                                        // 每次打开复位；翻页时保留当前缩放
    host._rot = 0;
    host._tx = 0;
    host._ty = 0;
    host._apply();
    host.shadowRoot.querySelector('.kh-lb').hidden = false;
    return true;
  }

  /* =================== 取数与聚合 =================== */

  function escText(s) {
    const d = document.createElement('div');
    d.textContent = (s == null ? '' : String(s));
    return d.innerHTML;
  }

  const head = {
    /**
     * 命中 → 卡片标签 HTML（`🔖 … / → …`），逐条对齐旧版 buildTagHtml 的四个分支。
     * entries: [{ kw, adj }]
     */
    tagHtml(entries) {
      const plainVals = new Set();
      const combo = new Map();       // adj -> Set<kw>
      for (const e of entries || []) {
        if (!e || !e.kw) continue;
        if (e.adj) {
          if (!combo.has(e.adj)) combo.set(e.adj, new Set());
          combo.get(e.adj).add(e.kw);
        } else {
          plainVals.add(e.kw);
        }
      }
      const out = [];
      // 无标题普通词：多值聚合 🔖 a|b
      if (plainVals.size) {
        out.push('<span class="khin-item-kw">🔖 ' + Array.from(plainVals).map(escText).join('|') + '</span>');
      }
      const adjs = Array.from(combo.keys());
      if (adjs.length) {
        const valUnion = new Set();
        adjs.forEach(a => combo.get(a).forEach(v => valUnion.add(v)));
        const allSingle = adjs.every(a => combo.get(a).size === 1);
        if (allSingle && valUnion.size === 1) {
          // 多标题同值 → 标题合并，箭头随关键词模块
          const val = Array.from(valUnion)[0];
          out.push('<span class="khin-item-kw">🔖 ' + adjs.map(escText).join('|') + '</span>' +
                   '<span class="khin-item-adj">→ ' + escText(val) + '</span>');
        } else if (allSingle) {
          // 各标题单值但值彼此不同 → 逐条平铺，不交叉
          for (const a of adjs) {
            const only = Array.from(combo.get(a))[0];
            out.push('<span class="khin-item-kw">🔖 ' + escText(a) + '</span>' +
                     '<span class="khin-item-adj">→ ' + escText(only) + '</span>');
          }
        } else {
          // 存在某标题多值 → 按标题分开，同标题多值聚合
          for (const a of adjs) {
            const vals = Array.from(combo.get(a));
            if (!vals.length) continue;
            out.push('<span class="khin-item-kw">🔖 ' + escText(a) + '</span>' +
                     '<span class="khin-item-adj">→ ' + vals.map(escText).join('|') + '</span>');
          }
        }
      }
      return out.join('');
    },

    /**
     * 命中集 → 卡片列表。
     * 两级聚合：先按**内容(note)** 分卡（内容不一致绝不进同一卡），
     * 卡内 entries 去重后交给 tagHtml 做形态聚合。
     * @param {object[]} hits  registry 命中
     * @param {Set<string>} ignored 本次会话被用户关掉的笔记内容
     */
    build(hits, ignored) {
      const rawMap = new Map();     // note\0kw\0adj -> { note, kw, adj, imgSize, bg }
      for (const h of hits || []) {
        if (!h || !h.meta) continue;
        let note = String(h.meta.importantNote || '').trim();
        const fieldsHtml = h.meta.fetchHtml || '';
        // 重要笔记正文 = 用户重要笔记（Markdown）+ 抓取字段的多行表格
        if (fieldsHtml) note = note ? (note + '\n' + fieldsHtml) : fieldsHtml;
        if (!note) continue;                                   // 空内容忽略
        if (ignored && ignored.has(note)) continue;
        const kw = String(h.meta.text || h.meta.display || '').trim();
        if (!kw) continue;
        const adj = String(h.meta.label || '').trim();
        const key = note + '\u0000' + kw + '\u0000' + adj;
        if (rawMap.has(key)) continue;                         // 去重
        rawMap.set(key, {
          note, kw, adj,
          imgSize: h.meta.imgSize || '',
          bg: h.meta.impNoteBg || ''
        });
      }

      const noteMap = new Map();    // note -> { note, imgSize, bg, entrySet }
      rawMap.forEach((r) => {
        let g = noteMap.get(r.note);
        if (!g) { g = { note: r.note, imgSize: r.imgSize, bg: r.bg, entrySet: new Set() }; noteMap.set(r.note, g); }
        if (!g.imgSize && r.imgSize) g.imgSize = r.imgSize;
        if (!g.bg && r.bg) g.bg = r.bg;
        g.entrySet.add(r.kw + '\u0000' + (r.adj || ''));
      });

      const items = [];
      noteMap.forEach((g) => {
        const entries = [];
        g.entrySet.forEach((k) => {
          const i = k.indexOf('\u0000');
          entries.push({ kw: k.slice(0, i), adj: k.slice(i + 1) });
        });
        items.push({ note: g.note, entries, imgSize: g.imgSize || '', bg: g.bg || '' });
      });
      return items;
    },

    /**
     * 内容脏检查：命中集合未变 → 不重建 DOM（避免无关变化导致闪烁/重播入场动画）。
     *
     * 【key 必须含 imgSize】单卡尺寸是靠 `renderItems` 给该卡写**内联** `--kh-img-size`
     * （`el.style.setProperty('--kh-img-size', item.imgSize + 'px')`）生效的，
     * 而它是**渲染期**写的：key 不含 imgSize 时，"只改某词/分组的图片尺寸、内容一字未变"
     * 会判成不脏 → 跳过 renderContent → 卡片尺寸不刷新（把词级尺寸删掉时更糟：
     * 旧的内联值会一直残留）。所以尺寸变化必须算脏。
     */
    changed(oldItems, newItems) {
      if ((oldItems || []).length !== (newItems || []).length) return true;
      const key = (it) => (it.note || '') + '\u0001' + (it.bg || '') + '\u0001' + (it.imgSize || '') + '\u0001' +
        (it.entries || []).map(e => (e.kw || '') + '\u0003' + (e.adj || '')).sort().join('\u0002');
      const oldKeys = new Set((oldItems || []).map(key));
      for (const it of newItems) if (!oldKeys.has(key(it))) return true;
      return false;
    }
  };

  /* =================== 面板 =================== */

  const panel = {
    host: null,
    root: null,          // shadow 内的 .khin-wrap
    panelEl: null,
    bodyEl: null,
    countEl: null,
    minimized: false,
    items: [],
    ignored: new Set(),  // 本次页面会话内已被用户关闭的笔记（按 note 文本）
    /* ---- 🖼 图片命中（KH.ImgOcr 的结果；**独立分区**，与重要笔记卡片互不影响） ---- */
    imgItems: [],
    imgCollapsed: true,  // 默认折叠（图片识别是异步来的，先折叠不抢视线）
    /* 「用户手动收起过」**只对当时那批条目有效**（见 `imgSameBatch`）：连同收起那一刻的
     * 条目键一起记，条目换代（提交后翻页 / 重新扫描）即作废 —— 不做整页范围的长期记忆。 */
    imgUserCollapsed: false,
    imgCollapsedKeys: [],
    /* 「显示全部」这个人工复核视图（用户 2026-10-06：面板以命中为目的，没命中的图默认不展示）。
     * 和上面的收起记忆同一套口径：**按批**有效，条目换代（提交后翻页 / 重新扫描）就回到"只看命中"。 */
    imgShowAll: false,
    imgShowAllKeys: [],
    imgSecEl: null,
    imgListEl: null,
    imgCountEl: null,
    imgAllEl: null,
    imgArrowEl: null,
    pos: { left: 20, top: 20 },
    dragState: null,

    ensure(doc) {
      if (this.host && this.host.isConnected) return this.host;
      const host = doc.createElement('div');
      host.id = HOST_ID;
      // 插件自身 UI 的唯一标记：内容脚本遍历 / 清理 / observer 据此整体跳过
      host.setAttribute('data-kh-ext-ui', '1');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>' + STYLE + '</style><div class="khin-wrap" hidden></div>';
      this.root = shadow.querySelector('.khin-wrap');
      doc.body.appendChild(host);
      this.host = host;
      this.setDefaultPosition();
      this.applyPosition();

      /* 点击缩略图 → **当前页灯箱看大图**（用户实测要求；旧行为是新标签页）。
       * data: 内嵌图同样支持（本身就是原图数据），只有非 http(s) 协议才不处理。
       * 相册范围 = **同一个表格单元格内的图片**（用户口径："针对同单元格内，两个单元格各一张
       * 不需要识别到下一张上一张"）→ 取不到单元格时退化到最近的 table，再没有就只当单张。 */
      this.root.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'IMG' || !t.src) return;
        e.preventDefault();
        const scope = (t.closest && (t.closest('td, th') || t.closest('table'))) || null;
        const all = scope ? Array.prototype.slice.call(scope.querySelectorAll('img')) : [t];
        const list = [];
        let index = 0;
        for (let i = 0; i < all.length; i++) {
          const im = all[i];
          const s = im.src || '';                            // 用**解析后**的绝对地址，和 t.src 同一口径
          if (!s || !LIGHTBOX_SRC_OK.test(s)) continue;       // 占位/非法协议不进相册
          if (im === t) index = list.length;
          list.push({ src: s, alt: im.getAttribute('alt') || '' });
        }
        if (!list.length) return;
        openLightbox(list[index].src, list[index].alt, list, index);
      });
      return host;
    },

    /**
     * 默认**左上角**。
     *   · v1.52.0 就是左上角 —— 原实现里写着 `// 默认左上角` + `{ left: gap, top: gap }`；
     *   · v2 重构时按`策划案`三处"页面右上角"（§3.4 概述 / §5 行为 / §9.3 组件说明）改成了右上角，
     *     用户实测后确认**预期是左上角**，已恢复（规格那三处属于过时口径，见 tests/E2E-REPORT.md K26）。
     *   左上角更合理的原因：它是"聚合置顶"的常驻件，左上角在阅读流起点；
     *   右上角既容易和页面自带的右侧栏打架，也容易被浏览器滚动条压住。
     *   ⚠️ 改这里之前先看 meta-check 的"重要笔记面板默认位置"红线 —— 那条是为了防止
     *     "照规格再改回去"而钉的，要改必须先有决定。
     */
    setDefaultPosition() {
      const gap = 20;
      this.pos = { left: gap, top: gap };
    },

    applyPosition() {
      if (!this.root) return;
      const width = this.minimized ? 56 : 360;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - 48);
      this.pos.left = Math.max(8, Math.min(this.pos.left, maxLeft));
      this.pos.top = Math.max(8, Math.min(this.pos.top, maxTop));
      this.root.style.left = this.pos.left + 'px';
      this.root.style.top = this.pos.top + 'px';
    },

    startDrag(e) {
      if (e.button === 2) return;                              // 忽略右键
      if (e.target && e.target.tagName === 'BUTTON') return;   // 按钮上不拖
      e.preventDefault();
      const rect = this.root.getBoundingClientRect();
      const state = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
      this.dragState = state;
      const move = (ev) => {
        if (!this.dragState) return;
        this.pos.left = state.startLeft + (ev.clientX - state.startX);
        this.pos.top = state.startTop + (ev.clientY - state.startY);
        this.applyPosition();
      };
      const up = () => {
        this.dragState = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },

    /** 渲染（幂等；内容未变则不重建 DOM） */
    render(items, cfg) {
      const doc = document;
      this.ensure(doc);
      const imgSize = (cfg && cfg.importantNote && cfg.importantNote.imgSize) || 70;
      this.host.style.setProperty('--kh-img-size', imgSize + 'px');

      /* 图片命中与重要笔记**共用这块面板**（用户口径：图片命中要有地方看，且不占页面）；
       * 但两者独立：没有重要笔记的关键词，它识别到的图片照样要显示。 */
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];

      if (!items.length && !this.imgItems.length) {
        this.items = items;
        this.hide();
        return;
      }
      /* 外壳还没建过也必须走 renderContent：`head.changed([], [])` 是 false，
       * 光看内容新旧会漏掉"整页只有图片命中、面板还没建"这种情况（实测踩过：
       * 面板宿主建出来了、里面却没有 🖼 分区）。 */
      const dirty = !this.panelEl || this.minimized || head.changed(this.items, items);
      this.items = items;
      if (dirty) this.renderContent();
      else this.renderImgSection();
      this.show();
    },

    /** 图片命中变化时（异步结果回来）只刷图片分区，不重建笔记卡片 */
    renderImg() {
      if (!this.root) return;
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];
      if (!this.panelEl) {
        /* 还没建过面板（例如整页只有图片命中、且首次渲染时列表为空）→ 走完整渲染 */
        this.render(this.items, KH.config);
        return;
      }
      this.renderImgSection();
      if (!this.items.length && !this.imgItems.length) this.hide();
      else this.show();
    },

    renderContent() {
      if (!this.root) return;
      /* 计数 = 笔记卡片 + 图片命中（图片命中也在这块面板里，用户看不到的地方不该有"隐藏条目"） */
      const count = this.items.length + ((this.imgItems && this.imgItems.length) || 0);

      // 收起态：整块换成圆形 FAB（双击展开 —— 避免拖动位置时误展开）
      if (this.minimized) {
        this.panelEl = null;
        this.bodyEl = null;
        this.countEl = null;
        this.root.innerHTML =
          '<div class="khin-fab" title="重要笔记（' + count + ' 条）">📌' +
          '<span class="khin-fab-badge">' + count + '</span></div>';
        const fab = this.root.querySelector('.khin-fab');
        fab.addEventListener('pointerdown', (e) => this.startDrag(e));
        fab.addEventListener('dblclick', () => {
          this.minimized = false;
          this.renderContent();
          this.applyPosition();
        });
        return;
      }

      // 展开态：外壳只创建一次（避免每次命中变化重播入场动画 → 闪烁）
      if (!this.panelEl) {
        this.root.innerHTML =
          '<div class="khin-panel">' +
            '<div class="khin-header">' +
              '<span class="khin-header-icon">📌</span>' +
              '<span class="khin-header-title">重要笔记</span>' +
              '<span class="khin-header-count">0 条</span>' +
              '<button class="khin-header-btn" data-act="min" title="收起为小按钮">—</button>' +
            '</div>' +
            '<div class="khin-body"></div>' +
            '<div class="khin-imgsec" hidden>' +
              '<div class="khin-imghead">' +
                '<span>🖼 图片命中</span>' +
                '<span class="khin-imgcount"></span>' +
                '<span class="khin-imgall" data-act="all" hidden></span>' +
                '<span class="khin-imgarrow">展开 ▾</span>' +
              '</div>' +
              '<div class="khin-imglist"></div>' +
            '</div>' +
          '</div>';
        this.panelEl = this.root.querySelector('.khin-panel');
        this.bodyEl = this.root.querySelector('.khin-body');
        this.countEl = this.root.querySelector('.khin-header-count');
        this.imgSecEl = this.root.querySelector('.khin-imgsec');
        this.imgListEl = this.root.querySelector('.khin-imglist');
        this.imgCountEl = this.root.querySelector('.khin-imgcount');
        this.imgAllEl = this.root.querySelector('.khin-imgall');
        this.imgArrowEl = this.root.querySelector('.khin-imgarrow');
        /* 「显示全部」= 人工复核入口（用户 2026-10-06）：切视图**不**收起/展开分区
         * （那是题头的活），并且要连同当时的条目键记下来 —— 换代即作废。 */
        this.imgAllEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.imgShowAll = !this.imgShowAll;
          this.imgShowAllKeys = this.imgShowAll
            ? (this.imgItems || []).map((it) => String(it.key || ''))
            : [];
          this.imgCollapsed = false;   // 点了"显示全部"就是想看，不能还收着
          this.renderImgSection();
        });
        this.root.querySelector('.khin-imghead').addEventListener('click', (e) => {
          e.stopPropagation();
          this.imgCollapsed = !this.imgCollapsed;
          /* 记住"用户手动收起来过"：**只记到这批条目为止** —— 连同当时的条目键一起记，
           * 条目换代就作废（用户 2026-10-06 口径：提交后翻到下一页是全新场景，不该被上一页
           * 的收起动作长期压住；那时只要有命中就要照常自动展开）。 */
          this.imgUserCollapsed = this.imgCollapsed;
          this.imgCollapsedKeys = this.imgCollapsed
            ? (this.imgItems || []).map((it) => String(it.key || ''))
            : [];
          this.renderImgSection();
          this.applyPosition();
        });

        const header = this.panelEl.querySelector('.khin-header');
        header.addEventListener('pointerdown', (e) => this.startDrag(e));
        // 双击标题栏收起为 FAB（策划案 §5.2.3）
        header.addEventListener('dblclick', () => {
          this.minimized = true;
          this.renderContent();
          this.applyPosition();
        });
        this.panelEl.querySelector('[data-act="min"]').addEventListener('click', (e) => {
          e.stopPropagation();
          this.minimized = true;
          this.renderContent();
          this.applyPosition();
        });
      }

      if (this.countEl) this.countEl.textContent = count + ' 条';
      this.renderItems();
      this.renderImgSection();
    },

    /**
     * 图片命中分区。
     * 展示口径（用户 2026-10-06 确认）：缩略图 + 命中词 + 「是否真在图里出现」标记 + 可展开的识别文本；
     * 点缩略图走**现有灯箱**看大图。
     * **默认只显示命中**（外加"真失败"这类必须露出来的）—— 其余条目（未命中 / 排队中 /
     * 没认出文字 / 读不到图…）进题头上的「显示全部」人工复核视图，见 `imgRowVisible`。
     * 一条都没有时留一行说明（`.khin-imgnone`），不许悄悄空白 —— 空白看起来就是"坏了"。
     */
    /**
     * 记下的那批键**全都还在**吗（纯函数，不碰 DOM —— 好单测；两个"按批"的记忆共用一套判据）。
     *
     * 判据：记下那一刻的键**全都还在** ⇒ 仍是同一批。于是：
     *   · 同一页里异步结果陆续回来（旧键都还在）→ 记忆有效，不被自动展开打断；
     *   · 提交后翻页 / 重新扫描（有键消失）→ 记忆作废，新场景里有命中照常自动展开。
     *
     * 为什么必须有这一层：只记一个布尔值就等于**整页范围的长期记忆** —— 用户提交后翻到
     * 下一页，那是全新场景，却再也不自动展开了（用户 2026-10-06 明确否决这种长期记忆）。
     *
     * 空列表 = "重建清底的瞬间"（ImgOcr 的条目会被清掉再重建，见 img-ocr.js 的 clear），
     * 不是换代：这一轮分区本来就没东西可显示，记忆留着，等条目回来再用键判断。
     * 判成换代的话，用户一收起、页面稍有变动就作废 ⇒ 又变回"每轮都被弹开"。
     */
    stillSameBatch(keys, list) {
      const ks = keys || [];
      if (!ks.length) return false;
      const now = (list || []).map((it) => String(it.key || ''));
      if (!now.length) return true;
      return ks.every((k) => now.indexOf(k) >= 0);
    },

    imgSameBatch(list) {
      if (this.imgUserCollapsed !== true) return false;
      return this.stillSameBatch(this.imgCollapsedKeys, list);
    },

    /** 「显示全部」这份视图记忆还属于这批条目吗（口径同 `imgSameBatch`：换代就回到"只看命中"） */
    imgShowAllSameBatch(list) {
      if (this.imgShowAll !== true) return false;
      return this.stillSameBatch(this.imgShowAllKeys, list);
    },

    /**
     * 一条图片条目在**当前视图**下要不要显示（纯函数，不碰 DOM —— 好单测）。
     *
     * 口径（用户 2026-10-06）：这个功能的主要目的是**命中**，没命中的图不必展示，
     * 另留「显示全部」做人工复核入口。但**真失败必须露出来**（`bad` 类：识别失败 /
     * 超时 / 引擎不可用）—— 否则就退回 D-14.5 明令禁止的"静默"：用户看到空面板以为功能坏了。
     * 状态类只从唯一真源 `KH.OcrCopy.stateClass()` 取，这里**不另立一套枚举**。
     */
    imgRowVisible(it) {
      if (this.imgShowAll === true) return true;
      return this.imgRowIsHitOrBad(it);
    },

    /** 默认视图本身会不会显示它（与当前视图无关）—— 「显示全部」的**条目数**要用它数：
     *  若拿 `list.length - shown.length` 数，切到复核视图后 shown 就成全量、hiddenN 变 0，
     *  按钮当场消失 ⇒ 只进不出（`VIEW.onlyHits` 永远渲染不出来）。 */
    imgRowIsHitOrBad(it) {
      const cls = KH.OcrCopy.stateClass(it);
      return cls === 'hit' || cls === 'bad';
    },

    imgRowHiddenCount(list) {
      return (list || []).filter((it) => !this.imgRowIsHitOrBad(it)).length;
    },

    /** 还没跑完的条目数（纯函数）：默认视图把它们藏起来了，但计数与空视图必须说出来 ——
     *  否则"藏起来 + 结果没回来"看起来就是"这次没有命中"（在结果出来之前下结论）。 */
    imgBusyCount(list) {
      return (list || []).filter((it) => KH.OcrCopy.stateClass(it) === 'wait').length;
    },

    renderImgSection() {
      if (!this.imgSecEl) return;
      const list = this.imgItems || [];
      /* 【命中就自动展开（K69）】用户报的：图里识别出关键词了，分区却还是收着的，得手动点开才看得到。
       * 规则：**只要有命中的条目就默认展开**；用户手动收起来过就尊重他 —— 但这份"尊重"只对
       * **当时那批条目**有效（`imgSameBatch`）：换代了就作废，新场景里照样自动展开。 */
      if (!this.imgSameBatch(list)) { this.imgUserCollapsed = false; this.imgCollapsedKeys = []; }
      /* 「显示全部」这份视图记忆同理按批作废（用户 2026-10-06：不做整页范围的长期记忆） */
      if (this.imgShowAll === true && !this.imgShowAllSameBatch(list)) {
        this.imgShowAll = false;
        this.imgShowAllKeys = [];
      }
      /* 【默认只显示命中】（用户 2026-10-06）：这个功能的主要目的是命中，没命中的图不必占版面；
       * 「显示全部」把其余条目（未命中 / 排队中 / 没认出文字 / 读不到图…）留给人工复核。
       * 哪条算"都要显示"由 `imgRowVisible` 一处决定（命中 + 真失败），这里不再各判一次。 */
      const shown = list.filter((it) => this.imgRowVisible(it));
      /* 要复核的条数按**默认口径**数（与当前视图无关）：切到「显示全部」后按钮要变成
       * 「只看命中」留着，点得回去 —— 否则这个复核入口只进不出。 */
      const hiddenN = this.imgRowHiddenCount(list);
      /* 【还没跑完就不许说"没有命中"】默认视图把"识别中"的行也藏起来了，于是"藏起来 + 还没回来"
       * 会显示成"这次没有命中" —— 那是在结果出来之前下结论。所以计数与空视图都要把在跑的数量说出来。 */
      const busyN = this.imgBusyCount(list);
      if (this.imgCountEl) {
        this.imgCountEl.textContent = (shown.length ? '(' + shown.length + ')' : '') +
          (busyN ? KH.OcrCopy.render(KH.OcrCopy.VIEW.busy, { n: busyN }) : '');
      }
      if (this.imgAllEl) {
        this.imgAllEl.hidden = !hiddenN;
        this.imgAllEl.textContent = hiddenN
          ? KH.OcrCopy.render(this.imgShowAll ? KH.OcrCopy.VIEW.onlyHits : KH.OcrCopy.VIEW.showAll, { n: hiddenN })
          : '';
      }
      if (this.imgUserCollapsed !== true && list.some((it) => it.state === 'done' && it.matched && it.matched.length)) {
        this.imgCollapsed = false;
      }
      if (this.imgArrowEl) this.imgArrowEl.textContent = this.imgCollapsed ? '展开 ▾' : '收起 ▴';
      if (!list.length) { this.imgSecEl.hidden = true; this.imgListEl.textContent = ''; return; }
      this.imgSecEl.hidden = false;
      if (this.imgCollapsed) { this.imgListEl.textContent = ''; return; }

      const doc = document;
      this.imgListEl.textContent = '';
      /* 默认视图一条都没有（全是未命中/排队中…）⇒ 留一行说明：复核入口就在题头上，
       * 但**不许悄悄空白** —— 空白看起来就是"坏了"（D-14.5 的如实告知）。 */
      if (!shown.length) {
        const none = doc.createElement('div');
        none.className = 'khin-imgnone';
        none.textContent = KH.OcrCopy.render(
          busyN ? KH.OcrCopy.VIEW.noneHitBusy : KH.OcrCopy.VIEW.noneHit,
          { n: busyN || hiddenN }
        );
        this.imgListEl.appendChild(none);
        return;
      }
      for (const it of shown) {
        const row = doc.createElement('div');
        row.className = 'khin-imgitem';
        row.setAttribute('data-kh-ocr-key', it.key);

        const thumb = doc.createElement('img');
        thumb.className = 'khin-imgthumb';
        if (LIGHTBOX_SRC_OK.test(it.src || '')) thumb.src = it.src;
        thumb.alt = it.keyword || '';
        thumb.title = '点开看大图';
        row.appendChild(thumb);

        const meta = doc.createElement('div');
        meta.className = 'khin-imgmeta';
        const head = doc.createElement('div');
        const kw = doc.createElement('span');
        kw.className = 'khin-imgkw';
        kw.textContent = '🖼 ' + (it.keyword || '') + (it.label ? '（' + it.label + '）' : '');
        head.appendChild(kw);
        const tag = doc.createElement('span');
        /* 状态类只从唯一真源取（`hit`/`miss`/`wait`/`note`/`bad`）：进行中不再是红的 */
        tag.className = 'khin-imgtag ' + KH.OcrCopy.stateClass(it);
        tag.textContent = this.imgTagText(it);
        tag.title = it.error || '';
        head.appendChild(tag);
        meta.appendChild(head);

        const textEl = doc.createElement('div');
        textEl.className = 'khin-imgtext';
        textEl.setAttribute('data-kh-ocr-text', '1');
        const hit = it.state === 'done' && it.matched && it.matched.length;
        const body = it.state === 'done' ? (it.text || '（图里没识别出文字）') : this.imgWhyText(it);
        /* 【命中的条目默认就展开识别文本（K69）】命中就是要给人看的：直接显示"图里认出了什么"，
         * 未命中的条目仍然收起（面板不会被长文本撑开）。 */
        textEl.textContent = hit ? ('命中「' + it.matched.map((m) => m.text).join('、') + '」：' + body) : body;
        textEl.hidden = !hit;
        meta.appendChild(textEl);
        /* 点标题右侧的标记 → 展开/收起识别文本（未命中的默认收起） */
        tag.style.cursor = 'zoom-in';
        tag.title = hit ? '点一下收起/展开识别文本' : (it.error || '点一下展开识别文本');
        tag.addEventListener('click', (e) => {
          e.stopPropagation();
          textEl.hidden = !textEl.hidden;
        });
        head.appendChild(tag);

        /* 本次识别的**真实**耗时（S3-④ 用户裁决）：数字来自回执（`img-ocr.js:445` 存在条目上），
         * 文案与格式一律走真源 `KH.OcrCopy.costLabel/costTip` —— 面板不许自己拼数字或写中文。
         * 没有值（排队中 / 还没跑到）时 `costLabel` 返回空串 ⇒ 连 span 都不挂，不留空标签。
         * 【位置】必须在这句 `head.appendChild(tag)` **之后** —— 上面第 850 行已经 append 过一次 tag，
         * 而 appendChild 对已存在的子节点是"移动"：插在 850 与 870 之间会被这一次挪到 cost 后面去。 */
        const cost = doc.createElement('span');
        cost.className = 'khin-imgcost';
        cost.textContent = KH.OcrCopy.costLabel(it);
        cost.title = KH.OcrCopy.costTip(it);
        if (cost.textContent) head.appendChild(cost);
        if (it.state === 'done' && String(it.text || '').trim()) {
          const copy = doc.createElement('button');
          copy.className = 'khin-imgcopy';
          copy.type = 'button';
          copy.title = '复制识别到的文字';
          copy.textContent = '📋';
          copy.addEventListener('click', (e) => {
            e.stopPropagation();
            const txt = String(it.text || '');
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt);
              else throw new Error('no clipboard');
              copy.textContent = '✓';
            } catch (err) {
              /* 剪贴板不可用（老浏览器/无权限）→ 退化成"展开文本让用户自己选" */
              textEl.hidden = false;
              copy.textContent = '✗';
            }
            setTimeout(() => { copy.textContent = '📋'; }, 1200);
          });
          head.appendChild(copy);
        }
        meta.appendChild(head);
        /* ★ 别漏这一行：一张卡片行 = 缩略图 + 文本块（文本块里才有 tag/识别文本）。
         * 实测踩过：加「📋 复制识别文本」时把这一行弄丢了 → 行里没有 tag 与文本 →
         * 「图片文字识别」那条 e2e 的等待条件（两个 tag 都不是"识别中"）永远不成立 → 91s 超时。 */
        row.appendChild(meta);
        this.imgListEl.appendChild(row);
      }
    },

    /* 折叠标签 / 展开说明一律从**唯一真源** `KH.OcrCopy` 取（票 #17 D-17.1）。
     * 措辞上的任何改动都应该去改 `src/ui/ocr-copy.js` —— 不要在这里写死中文：
     * 之前正是"同一个原因在面板 / 设置页 / 弹窗各写一套"，改一处漏两处。
     * （原 K63 的「把图片所在域名直接写出来」口径已搬进 ocr-copy.js 的 `cross-origin` 条目。） */
    imgTagText(it) {
      return KH.OcrCopy.tag(it);
    },

    imgWhyText(it) {
      return KH.OcrCopy.why(it);
    },

    renderItems() {
      if (!this.bodyEl) return;
      const doc = document;
      this.bodyEl.textContent = '';
      for (const item of this.items) {
        const el = doc.createElement('div');
        el.className = 'khin-item';
        if (item.imgSize) el.style.setProperty('--kh-img-size', item.imgSize + 'px');
        // 「复用高亮底色」：铺该词实际底色（分组色 > 词色 > 全局默认）；空串不铺
        if (/^#[0-9a-fA-F]{3,8}$/.test(item.bg || '')) el.style.background = item.bg;

        const headEl = doc.createElement('div');
        headEl.className = 'khin-item-head';
        const tagsEl = doc.createElement('div');
        tagsEl.className = 'khin-item-tags';
        tagsEl.innerHTML = head.tagHtml(item.entries);
        const closeBtn = doc.createElement('button');
        closeBtn.className = 'khin-item-close';
        closeBtn.title = '本次页面不再显示';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.ignored.add(item.note);
          this.refresh();
        });
        headEl.appendChild(tagsEl);
        headEl.appendChild(closeBtn);
        el.appendChild(headEl);

        const noteEl = doc.createElement('div');
        noteEl.className = 'khin-item-note';
        noteEl.appendChild(this.noteFragment(doc, item.note));
        el.appendChild(noteEl);
        this.bodyEl.appendChild(el);
      }
    },

    /**
     * 笔记内容 → DOM 片段。
     * 内容里**混有**两类东西：
     *   · 用户写的 Markdown（`KH.Markdown.toFragment`）
     *   · 抓取字段生成的 `<table class="kh-table kh-table-fetch">` HTML（`KH.Fetch.rowsToTableHtml`）
     * 抓取表格是本插件自己生成的**可信结构**，必须原样插入而不是当 Markdown 文本转义掉；
     * 因此先把表格片段摘出来，其余按 Markdown 渲染，最后按原顺序拼回。
     */
    noteFragment(doc, note) {
      const frag = doc.createDocumentFragment();
      const src = String(note == null ? '' : note);
      // 兼容不带 `kh-table-fetch` 标记的旧串（历史数据 / 已缓存的笔记内容），两种都认
      const re = /<table class="kh-table(?: kh-table-fetch)?">[\s\S]*?<\/table>/g;
      let last = 0;
      let m;
      const pushMd = (text) => {
        if (!text) return;
        frag.appendChild(KH.Markdown.toFragment(text, doc));
      };
      while ((m = re.exec(src)) !== null) {
        pushMd(src.slice(last, m.index));
        const tmp = doc.createElement('div');
        tmp.innerHTML = m[0];          // 本插件自产表格（值已在 Fetch 内转义，图片已走协议白名单）
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        last = m.index + m[0].length;
      }
      pushMd(src.slice(last));
      return frag;
    },

    /** 用户关掉某条后重算（不重建注册表） */
    refresh() {
      if (!this.host) return;
      const hits = (KH.registry && typeof KH.registry.all === 'function') ? KH.registry.all() : [];
      const effective = collectEffective(hits);
      this.render(head.build(effective, this.ignored), KH.config);
    },

    /* 显隐写成**幂等**的：重复 show/hide 不再写 attribute（少一次 DOM 变更，
     * 也避免把 hidden 属性翻转成"每次重建都抖一下"） */
    show() { if (this.root && this.root.hidden) this.root.hidden = false; },
    hide() { if (this.root && !this.root.hidden) this.root.hidden = true; },

    /**
     * 重建前清底：**不动显隐**（只保留外壳）。
     *
     * 【为什么不能在这里 hide()】旧实现是 `this.hide()`，于是每个重建周期都
     * `hide()`（⑧Clear，rebuilder 的 feature clear 钩子）→ `show()`（⑦Consume 的 render）。
     * 而 `.khin-wrap[hidden]` 是 `display:none`，它会**取消** `.khin-panel` 的入场动画 `khin-in`
     * （opacity 0→1 / 160ms）；重新显示时动画**从 0 重播** → 面板整体闪一下。
     * 关键在于同一次同步管线里、clear 与 consume 之间**必然发生一次强制样式刷新**
     * （scanner / renderer / fetch 里都有 getComputedStyle / getBoundingClientRect），
     * 浏览器因此真的"看见"了 display:none —— 光看代码只觉得"hide 一下再 show"，
     * 完全不像 bug（真浏览器实测：面板 opacity 掉到 0；把该动画置空后 opacity 全程为 1）。
     *
     * 显隐的唯一决定权在 `render()`：有内容 → show()，无内容 → hide()；
     * 彻底下线走 clear({reason:'destroy'}) → destroy()。这与 note-card 是同一条纪律
     * （重建不碰交互 UI，见 note-card.js 顶部注释）。
     */
    emptyKeepShell() { /* 故意留空：重建期间不隐藏 */ },

    destroy() {
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null;
      this.root = null;
      this.panelEl = null;
      this.bodyEl = null;
      this.countEl = null;
      this.dragState = null;
      this.ignored.clear();
      this.items = [];
    }
  };

  /**
   * 从注册表命中里筛出"内容有效的"重要命中。
   *
   * 抓取内容与**触发判据**都在这里结算一次（唯一出口）：
   *   · 触发判据（策划案 §7.5 坑 15 / 附录A §8）：配了 fetchLabels 的「仅抓取」命中，
   *     必须按标签**确实抓到内容**才算这条记录有效；抓不到 → 不显示、**不回退抓标题右格**。
   *   · 每轮重建都重算（值后到/异步填充后自动补上），不缓存"未命中"结论。
   */
  function collectEffective(hits) {
    const list = (hits || []).filter(h => h && h.meta && h.meta.important);
    const effective = [];
    /* 【每轮重建复用抓取结果】否则大表格上**每个命中**都会重新枚举整张表 →
     * O(命中数 × 单元格数)，实测 1734 命中要 31 秒（页面卡死）。
     * 见 Fetch.blockFor 的说明：同一张表 + 同一组标签，结果完全相同。 */
    const fetchCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
    for (const h of list) {
      try {
        h.meta.fetchHtml = (KH.Fetch && h.textNode)
          ? (KH.Fetch.blockFor(h.textNode, h.meta.fetchLabels, fetchCache, h.meta.fetchScope) || '')
          : '';
      } catch (err) {
        h.meta.fetchHtml = '';
      }
      // 仅抓取：抓不到内容即视为无内容（旧版 v1.13.6「空值守卫」）
      if (h.meta.fetchOnly && !h.meta.fetchHtml) continue;
      effective.push(h);
    }
    return effective;
  }

  /* =================== 注册为 Feature（⑦Consume 消费者） =================== */

  if (KH.features) {
    KH.features.register('important-note', {      /** @param {object[]} hits 注册表全量命中 @param {object} cfg 当前配置 */
      consume(hits, cfg) {
        const list = (hits || []).filter(h => h && h.meta && h.meta.important);
        /* 图片命中与重要笔记**共用这块面板**：只要还有图片条目，panel.host 不存在时也得建出来，
         * 否则"这个词没开重要笔记、只有图片命中"就永远看不到东西（用户明确要求这种也要显示）。 */
        const imgCount = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items().length : 0;
        if (!list.length && !imgCount && !panel.host) return;    // 从没出现过：连外壳都不造
        panel.render(head.build(collectEffective(hits), panel.ignored), cfg);
      },

      clear(root, opts) {
        const reason = (opts && opts.reason) || 'rebuild';
        if (reason === 'destroy' || root) panel.destroy();
        /* 切标签页（visibility）：保持原有"收起"语义（隐藏的标签页不绘制，观感无差；
         * 但语义上"暂停即收起"仍是旧口径，不擅自改） */
        else if (reason === 'visibility') panel.hide();
        /* 重建（rebuild）：**绝不动显隐** —— 否则入场动画每次重建都重播 → 闪烁 */
        else panel.emptyKeepShell();
      }
    });
  }

  /* 图片识别的结果是**异步**回来的（OCR 在 offscreen 文档里跑），面板得自己刷新，
   * 不能等下一次页面重建 —— 否则用户要等页面变动才看见识别结果。 */
  if (KH.ImgOcr && typeof KH.ImgOcr.onChange === 'function') {
    KH.ImgOcr.onChange(() => panel.renderImg());
  }

  KH.ImportantNote = { panel, head, collectEffective, IMG_PROTOCOL_OK };
})();
