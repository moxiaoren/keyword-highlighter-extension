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
    /* 键盘焦点环自己给（F4.7，用户 2026-10-13 拍板「做吧」）。原来全靠 Chromium 默认环：
     * 默认环的配色由浏览器定、与面板的蓝紫主题无关，深色主题下不够显眼。只认 :focus-visible
     * —— 鼠标点击不留环；色走 tokens 的 --brand-deep（本项目面板模板是门禁的扫描盲区，
     * 这里按同文件既有写法给字面兜底）。 */
    :focus-visible { outline: 2px solid var(--brand-deep, #3579c2); outline-offset: 1px; }
    .khin-wrap {
      /* 面板默认宽度的**唯一真源**（T26 / 用户 2026-10-12：200 → 250）。
       * 设置页选了别的值 ⇒ panel.render() 把同一个变量写成这一元素上的**内联**样式（内联压过本行）
       * ⇒ 面板宽度与命中词块的上限一起跟着走；没设过（或 JS 还没跑到）就走这个默认。
       * 变量定义处全文件只有这一处：测试会拿它跟 config 的默认值对表，防两处漂移。 */
      --khin-panel-w: 250px;
      position: fixed; z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      user-select: none;
    }
    /* ---------- 收起态：圆形 FAB ---------- */
    /* 收起态 FAB 现在是真按钮（T29 / F4.1：原来是个 div，只绑了 dblclick ⇒ 键鼠都只有
     * 「双击」这一条隐性通路，能收不能开）。做成 <button> 后要自己清掉 UA 的按钮皮：
     * 边框，以及表单控件不继承字体 —— 二者都得显式盖掉，否则圆里多一圈框、字号变默认。 */
    .khin-fab {
      width: 48px; height: 48px; border-radius: 50%;
      background: linear-gradient(135deg, #3579c2, #5fb0ee); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; cursor: move; position: relative;
      border: 0; font-family: inherit;
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
    /* ---------- 展开态：面板 ----------
     * 默认宽 250px（用户 2026-10-12；2026-10-11 那轮的 360 → 300 → 200 已是上一版口径），
     * **可经设置页调整**（变量 --khin-panel-w，定义处在 .khin-wrap）。
     * min-width 必须跟着抬到 200px（用户 2026-10-13 拍板：160 → 200）—— CSS 里 min-width 压过 width，只改 width 等于白改。
     * 宽度不再写死在这里：唯一真源是 .khin-wrap 上的 --khin-panel-w；applyPosition() 的水平钳位
     * 读面板**实测**宽度，也不再抄一个字面量。 */
    .khin-panel {
      width: var(--khin-panel-w); min-width: 200px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 24px); background: #fff;
      border: 1px solid #e3e8f0; border-radius: 12px;
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
    /* ---- 📝 笔记区题头（2026-10-11 用户：笔记与图片都很长时互相抢占 ⇒ 两边都能收起，
            收一边就把空间让给另一边）---- */
    .khin-notebar {
      display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;
      padding: 5px 10px 4px; font-size: 12px; font-weight: 600; color: var(--kh-text, #1f2937);
      flex: 0 0 auto; white-space: nowrap;
    }
    .khin-notebar[hidden] { display: none; }
    .khin-notebar .khin-notecount { color: #64748b; font-weight: 500; }
    /* 次要灰字统一 #64748b（白底 ≈4.76:1，过 WCAG AA 的 4.5:1）：原来四处用 #94a3b8
     * （≈2.57:1，连大字门槛 3:1 都不到）⇒「展开/收起」这类唯一的操作线索读不出来。
     * T29 / F4.5：本行 + 题头箭头 + 空说明行 + 耗时徽标四处同批改。 */
    .khin-notebar .khin-notearrow { margin-left: auto; color: #64748b; font-size: 11px; }
    /* 正文至少留得住一行（用户 2026-10-07 的"被挤没"就是缩到 0 了）—— 再多交给它自己滚 */
    .khin-body { flex: 1 1 auto; min-height: 60px; overflow-y: auto; padding: 6px 0; }
    .khin-body.khin-collapsed { display: none; }
    /* 整页只有图片命中时这份列表是空的，但它仍占着 min-height:60px 的 flex 槽位
     * ⇒ 面板顶部白出一条 60px 的带子（T29 / F6.1）。它必须和别的分区一样有自己的
     * [hidden] 兜底：display:none 才不参与 flex 布局（visibility/opacity 都不行）。 */
    .khin-body[hidden] { display: none; }
    .khin-body::-webkit-scrollbar { width: 5px; }
    .khin-body::-webkit-scrollbar-thumb { background: #d8d8d8; border-radius: 3px; }
    .khin-body::-webkit-scrollbar-track { background: transparent; }
    /* 紧凑档（用户 2026-10-07：条目一多就"占地方"）—— 字号与行距各降一档、内边距收紧，
     * 一条正文的竖向占用约 34px → 24px；层级与可读性不变，只是不再松松垮垮。 */
    /* 条目 = **一张圆角卡片**（需求 3，2026-10-13）：旧样式是平铺列表 + 一条 1px 分隔线，
     * 条目一多就糊成一片、看不出"一条到哪儿结束"。现在卡片自己带浅底 + 细边 + 8px 圆角，
     * 间隔由 margin 提供（分隔线退场），面板白底上一眼能数清几条。
     * 内边距是**派生宽度的另一半契约**：这里改数值，.khin-item-kw/.khin-item-adj 的减数必须同步改。 */
    .khin-item {
      margin: 0 6px 6px; padding: 7px 10px;
      background: #f8fafc; border: 1px solid #eef1f6; border-radius: 8px;
    }
    .khin-item:last-child { margin-bottom: 0; }
    .khin-item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
    .khin-item-tags { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
    /* 命中词块的上限是**派生的**：一个词块不许超过面板里那一行的可用宽度
     * （- 62px ≈ 卡片外边距 12 + 边框 2 + 内边距 20 + 关闭按钮与间隙 28），250px 面板下 ≈ 188px ——
     * 面板宽度一改它自己跟着走，不留会过期的字面量；卡片内边距一改也必须回来改这个减数。 */
    .khin-item-kw {
      font-size: 11px; font-weight: 600; color: #3579c2; background: #eaf1fb;
      border-radius: 4px; padding: 1px 6px; max-width: calc(var(--khin-panel-w) - 62px);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
    }
    .khin-item-adj {
      font-size: 11px; font-weight: 600; color: #2e7d32; background: #e8f5e9;
      border-radius: 4px; padding: 1px 6px; max-width: calc(var(--khin-panel-w) - 62px);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
    }
    .khin-item-close {
      background: none; border: none; cursor: pointer; color: #bbb;
      font-size: 13px; padding: 2px 4px; border-radius: 4px; line-height: 1; flex-shrink: 0;
    }
    .khin-item-close:hover { color: #e53935; background: #ffe9e9; }
    /* 命中计数小标：一张卡命中多个时才出现（N>1），点了在下面铺开下拉。 */
    .khin-tag-more {
      flex: 0 0 auto; font-size: 10px; font-weight: 600; line-height: 15px; padding: 0 5px;
      border: 1px solid rgba(53,121,194,.45); border-radius: 8px;
      background: #eaf1fb; color: #3579c2; cursor: pointer;
    }
    .khin-tag-more:hover { background: #d8e7fa; }
    /* 下拉：整行铺开（flex-basis 100%），最多 20 条、超出在列表体内滚动。
       条目一律单行 + ellipsis —— 只做视觉省略，DOM 里仍是完整文本。 */
    .khin-tag-list { flex: 1 1 100%; min-width: 0; margin-top: 3px; }
    .khin-tag-list-h { font-size: 10px; color: #64748b; margin-bottom: 2px; }
    .khin-tag-list-b { max-height: 132px; overflow-y: auto; }
    .khin-tag-item {
      font-size: 11px; color: #334155; padding: 1px 4px; border-radius: 3px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .khin-tag-item:hover { background: #f1f5f9; }
    .khin-tag-item.khin-tag-on { background: #eaf1fb; color: #3579c2; font-weight: 600; }
    /* 内容 / 标签可选中复制；外壳保持 user-select:none 仅避免误选 */
    .khin-item-note, .khin-item-tags, .khin-item-kw, .khin-item-adj, .kh-table,
    .khin-tag-list-h, .khin-tag-item {
      user-select: text; -webkit-user-select: text;
    }
    .khin-item-note ::selection, .kh-table ::selection { background: #a6d3ff; color: inherit; }
    /* 重要笔记正文：**必须保留换行**（旧版 v1.8.3 教训；Markdown 渲染会在行间产生 \\n 文本节点）
     * 字号走 CSS 变量（2026-10-09 用户裁决：默认比上一版再小一号，并在设置页可配）。
     * 变量由 panel.render() 从 config.importantNote.fontSize 写到 host 上（同 --kh-img-size 手法）。 */
    .khin-item-note {
      font-size: var(--kh-note-fs, 11px); line-height: 1.45; color: #333;
      white-space: pre-line; word-break: break-word; overflow-wrap: break-word;
    }
    .khin-item-note a { color: #1a73e8; text-decoration: none; }
    .khin-item-note a:hover { text-decoration: underline; }
    .khin-item-note b, .khin-item-note strong { font-weight: 600; color: #1f2937; }
    /* 图片样式只服务 .khin-item-note（T29 / F1.1：那条并排的 .khin-item-body 选择器与
     * .khin-item-body / .khin-empty 两条规则全仓零引用 —— 面板里没有任何元素带这些类，
     * 留着只会让人以为"还有另一套正文容器"；同类死样式 .khin-imgempty 也已删） */
    .khin-item-note img {
      max-width: var(--kh-img-size, 70px); max-height: var(--kh-img-size, 70px);
      width: auto; height: auto;          /* 等比缩放，**不裁剪** */
      border-radius: 4px; margin: 4px 8px 4px 0;
      display: inline-block; vertical-align: middle; cursor: pointer;
    }
    .khin-item-note img:hover { opacity: .92; }
    /* 右键识别的图都挤在**同一个单元格**里（用户 m03971）：横向排、图多了自动折行仍不换格。
     * 图本身的尺寸/圆角沿用上面 .khin-item-note img，这里只负责排布。 */
    .khin-ctx-cell { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 2px 0; }
    /* 解码前 img 是 0×0，flex 行里会被挤成一条细缝（真机截图抓到过：缩略图只剩 10px 宽）。
     * 宽度先按 --kh-img-size 占位，高度等图解码后自己长 —— 仍然等比、不裁剪。 */
    .khin-ctx-cell img { width: var(--kh-img-size, 70px); height: auto; min-height: 20px; }
    /* 【2.0.2.7 用户 m00292】卡片里被 OCR 命中的图铺一层红框（用户原话："命中的话给命中的图片
     * 加一层红色边框"）—— 这是"这张图里有你要的词"的唯一视觉提示，因为分区那一行已经不重复画了。
     * 用 outline 而不是 border：outline 不参与布局，图不会被挤动一格（点开大图还能看原文里标出来的词）。 */
    .khin-item-note img.khin-imghit, .khin-imgthumb.khin-imghit { outline: 2px solid #ef4444; outline-offset: 1px; }
    /* 抓取后续字段渲染的多行表格：**所有**单元格保留换行（v1.8.3）
     * 宽度（v1.99.99.11 用户实测要求）：**按内容收缩**，不再无条件 width:100%。
     *   用户原话："表格总宽度总是等于重要笔记宽度…避免明明就一列，结果宽度上还是填满了重要笔记"。
     *   width:auto + max-width:100% = 内容短就窄（贴合观看习惯），内容长仍撑到容器宽度后换行、不溢出。 */
    .kh-table { border-collapse: collapse; margin-top: 4px; width: auto; max-width: 100%; }
    .kh-table td {
      border: 1px solid #d3dae3; padding: 3px 8px; font-size: var(--kh-note-fs, 11px); line-height: 1.5;
      background: #fff; text-align: left; vertical-align: middle;
      white-space: pre-line; word-break: break-word;
    }
    /* 抓取表格没有表头行：**只有**字段 label 格上色（它是左列列标题，右侧全是它的内容）。
       绝不能按"首行当表头"着色 —— 那会把「基本信息 / 驳回字段：X / 32位包:」也标成行标题。 */
    .kh-table .kh-table-label {
      background: var(--kh-brand-soft, #eaf1fb); font-weight: 600; color: var(--kh-text, #1f2937);
    }
    /* 字段标题格里的文本（= 设置「抓取字段」里填的那个名字）**不必整段展示**，省下的宽度留给内容。
     * 用户 2026-10-11 原话："抓取字段的标题内容可以不完整展示…实际抓取到的内容展示还是需要完整展示的，节省宽度"。
     * 做法：标题文本包一层 .kh-lbt（见下方 noteFragment 的补包裹），**宽度上限 + 单行裁切**，
     * 内容格（值）**一律不截断** —— 让位的是标题，不是抓取到的内容；全文仍挂在 title 上，悬停即读回。
     * 上限写成一个变量，现场觉得太窄/太宽只改这一处。
     * 三条被真机实测淘汰的写法（改回去会红，别试）：
     * ① 「white-space:nowrap」+「text-overflow:ellipsis」（观感最好）：nowrap 把这一列的**最小内容宽度**抬到标题
     *    全文，auto 布局的表格再也压不下去 —— 真机实测表宽 185px > 容器 178px，既有用例「表格宽度按内容
     *    收缩」当场变红；「overflow:hidden」不改固有尺寸，救不回来。
     * ② 「-webkit-line-clamp:1」（含 -webkit-inline-box / -webkit-box）：Chromium 把计算 display 归一到
     *    inline-block / flow-root，**line-clamp 在表格里不生效**（真机 5 个行盒、内容照旧换行堆叠）；而且
     *    被省略的部分仍计进 scrollHeight，拿 scrollHeight 判「裁在一行」也会误判。
     * ③ 块级「display:block」：块盒会让 innerText 在格末多一个换行，「字段名与它第一个值在同一行」的既有口径
     *    （真机值行数 5 那条用例）被算成 6 行 —— 视觉没变、文本口径变了。
     * 结论：inline 档盒子（不抬最小宽度、不加换行）+ max-width 设上限 + max-height 裁到一行。 */
    .kh-table .kh-table-label .kh-lbt {
      display: inline-block; max-width: var(--kh-lbt-maxw, 8em); max-height: 1.5em;
      overflow: hidden; vertical-align: bottom;
    }
    /* 【2.0.2.4 需求④】字段名后面的**后缀徽标**（#图3 / @2 / ! / ^锚文本 / %4）：
       让用户看得出这一格的取值为什么长这样。淡、小、单行；**不放进 .kh-lbt**（那层要裁切标题，
       放进去后缀会被裁掉），所以 noteFragment 的补包裹要把它原样搬出来（见那里的注释）。 */
    .kh-table .kh-table-suffix {
      margin-left: 4px; font-weight: 400; font-size: 9px; line-height: 1.5;
      color: var(--kh-text-3, #94a3b8); white-space: nowrap;
    }
    /* ---- 🖼 图片命中分区（面板下半部分，独立成块；默认折叠） ---- */
    /* 两个滚动区各自管自己（用户 2026-10-07）：面板总高受视口限制，OCR 分区若允许被压缩，
     * 它就会把上面的笔记列表挤到近零（"互相抢占展示"）；若不许压缩又会被 .khin-panel 的
     * overflow:hidden 直接裁掉（"超过浏览器高度就看不到全部、也没有滚动条"）。所以：分区不参与
     * 收缩（flex:0 0 auto）但封顶半屏，超出部分交给 .khin-imglist 自己滚 —— 上下各一条滚动条。 */
    .khin-imgsec {
      border-top: 1px solid rgba(148,163,184,.35); margin-top: 2px;
      /* 封顶收紧到 40vh（用户 2026-10-11：矮屏下 50vh 让图区吃到 260px，笔记区只剩 165px
       * 且上下双滚动条）。实测（_stage/ui-review-2026-10-11，**当时面板宽 200px**）：200×900 图区
       * 实高 312px 由内容决定、不受此上限影响；200×520 下 40vh = 208px，笔记区 165 → ≈217px。
       * 别再往上加 —— 加回去就是拿笔记区换图区。 */
      flex: 0 0 auto; min-height: 0; max-height: 40vh;
      display: flex; flex-direction: column;
    }
    .khin-imgsec[hidden] { display: none; }
    /* 矮屏（视口 ≤520px）再收一档（用户 2026-10-11 现场：矮屏下正文被压成半截）。
     * 40vh 在 520px 高处仍吃掉 208px，正文只剩 ≈217px —— 只赢 9px，一次微调就翻盘；
     * 30vh ⇒ 图区 ≈156px / 正文 ≈269px，正文**明显**比图区高，才符合"打开面板是为了看正文"。
     * 只改封顶，**不碰 flex: 0 0 auto**（改了就是破 2026-10-07 的"两个分区互相抢占"契约）。 */
    @media (max-height: 520px) {
      .khin-imgsec { max-height: 30vh; }
    }
    /* 题头一行要放下：图标+短标题 / 计数 / 「全部 N」复核入口 / 折叠箭头。
     * 面板窄时**不许折行**（2026-10-11 用户现场截图：折成两行把标题挤碎）——
     * nowrap + overflow:hidden，让计数这一格先让位（它最短、含义最不依赖宽度）。 */
    .khin-imghead {
      display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;
      /* 左右 6px：与笔记卡片的左缘对齐（.khin-item 的 margin 是 0 6px）——
       * 两个分区共用同一道竖线，面板里不会一个贴边、一个缩进 */
      padding: 4px 6px 3px; font-size: 12px; font-weight: 600; color: var(--kh-text, #1f2937);
      flex: 0 0 auto; flex-wrap: nowrap; overflow: hidden; white-space: nowrap;
    }
    .khin-imghead .khin-imgtitle { flex: 0 0 auto; }
    .khin-imghead .khin-imgcount {
      color: #64748b; font-weight: 500; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    /* 「显示全部 / 只看命中」= 人工复核入口（用户 2026-10-06：面板以命中为目的，
       没命中的图默认不展示，但必须留一条能打开的渠道）。放在题头右侧、箭头左边。
       2026-10-11 曾为 200px 收窄改短标签「全部 N / 只命中」；F2.1（2.0.1.16）默认宽已回
       250px，文案恢复成自解释的「显示全部 N / 只看命中」，title 仍挂完整句兜底。 */
    .khin-imghead .khin-imgall {
      margin-left: auto; color: #2563eb; font-size: 11px; font-weight: 500;
      cursor: pointer; text-decoration: underline; flex: 0 0 auto; white-space: nowrap;
    }
    .khin-imghead .khin-imgall[hidden] { display: none; }
    .khin-imghead .khin-imgarrow { margin-left: auto; color: #64748b; font-size: 11px; flex: 0 0 auto; white-space: nowrap; }
    /* 没有「全部 N」时箭头才吃 margin-left:auto；两者都有时只有前者吃（否则中间撕出一个大空隙） */
    .khin-imghead .khin-imgall:not([hidden]) + .khin-imgarrow { margin-left: 0; }
    /* 默认视图里一条都没有时的说明行（不能悄悄空白：那看起来就是坏了） */
    .khin-imgnone { color: #64748b; font-size: 12px; padding: 2px 6px 4px; }
    /* 分区封顶后由这份列表自己滚（min-height:0 是关键：否则 flex 子项不肯缩到内容高度以下，
     * 出不了滚动条，还是会顶破面板） */
    .khin-imglist {
      /* 左右 6px：与笔记卡片的左缘对齐（.khin-item 的 margin 是 0 6px），两个分区共用一道竖线 */
      display: flex; flex-direction: column; gap: 6px; padding: 2px 6px 4px;
      flex: 1 1 auto; min-height: 0; overflow-y: auto;
    }
    .khin-imglist::-webkit-scrollbar { width: 5px; }
    .khin-imglist::-webkit-scrollbar-thumb { background: #d8d8d8; border-radius: 3px; }
    .khin-imglist::-webkit-scrollbar-track { background: transparent; }
    .khin-imgitem { display: flex; gap: 6px; align-items: flex-start; }
    /* 缩略图列（44px，在行里不参与压缩）。2.0.1.15 需求 7：用户裁决删掉它下面那条「复制全文」
     * 按钮，容器保留 flex column + gap（缩略图本身仍按列排，宽度 44px 不变）。 */
    .khin-imgthumbwrap { flex: 0 0 44px; display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
    .khin-imgthumb {
      width: 44px; height: 44px; flex: 0 0 44px; object-fit: cover; border-radius: 8px;
      border: 1px solid rgba(148,163,184,.45); background: #f1f5f9; cursor: zoom-in;
    }
    .khin-imgmeta { min-width: 0; flex: 1; font-size: 11px; line-height: 1.4; color: #334155; }
    /* 一行里 = 关键词（可省） + 状态图标+短标签（必看） + 耗时（可省）。
     * 让位顺序（T29 / F2.2 修正）：关键词先 ellipsis → 还不够时状态标签自己缩到 2em 后再 ellipsis
     * （完整措辞在 tag.title 里读得回）→ 耗时绝不参与让位。
     * 原来标签是 flex: 0 0 auto 且没有上限 ⇒ 长标签（最多 16 字）先吃满自己需要的宽度、把关键词压到 0，
     * 再把行尾的耗时连同省略号一起裁掉 —— 同一列表里别的行有耗时、这几行没有，看着就像没识别。 */
    .khin-imgrow { display: flex; align-items: baseline; gap: 3px; min-width: 0; flex-wrap: nowrap; overflow: hidden; }
    .khin-imgkw {
      font-weight: 600; color: #0f172a; flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .khin-imgtag {
      font-size: 11px; border-radius: 4px; padding: 0 4px; white-space: nowrap;
      flex: 0 1 auto; min-width: 2em; overflow: hidden; text-overflow: ellipsis;
    }
    /* 状态图标（2026-10-11 用户裁决：面板窄时放不下「未命中/识别中…」这类长标签，
     * 图标让同类状态一眼可分）。它是**装饰**，单独一个 span —— 不许拼进
     * .khin-imgtag 的文本里：那是状态标签的唯一措辞（_e2e/content.test.js 多处
     * 用 tag.indexOf('命中') === 0、eq(tag,'命中') 钉着「标签只说结论」）。
     * aria-hidden：语义已在标签里，读屏不必把图标再念一遍。 */
    .khin-imgico {
      flex: 0 0 auto; font-size: 11px; font-weight: 700; white-space: nowrap;
    }
    /* 本次识别的真实耗时（S3-④）：只在有值时挂载，字号比标签再小一档、不抢主信息 */
    .khin-imgcost {
      font-size: 10px; color: #64748b; flex: 0 0 auto; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    /* 「命中」这一族改用语义 token（T29 / F5.2）：面板原来写的是 #dcfce7 / #166534
     * （Tailwind green-100/800），与 tokens 的 --success-soft (#e9f7ef) / --success-strong (#15803d)
     * 是同一个概念的两套值 ⇒ 面板里的绿与设置页、弹窗对不上。四处同批改完（标签/.图标/词块）；
     * 都带 fallback，而 fallback 给的就是 token 的值，不是旧绿 —— 取不到变量也不许退回旧值。 */
    .khin-imgtag.hit { background: var(--success-soft, #e9f7ef); color: var(--success-strong, #15803d); }
    .khin-imgtag.miss { background: #f1f5f9; color: #64748b; }
    .khin-imgtag.bad { background: #fee2e2; color: #991b1b; }
    /* 进行中（wait 类）与「读不到图 / 缺资产」（note 类）**都不是故障，不许染红** ——
     * 票 #17 新登记的 P0：修复前所有非 done 状态都套 bad 类，于是 OCR 正常工作时
     * 面板上显示的是**红底的「识别中…」**，用户第一反应就是「出错了」。
     * 状态类由唯一真源 KH.OcrCopy.stateClass() 给出（见 src/ui/ocr-copy.js 文件头）。
     * ⚠️ 这段样式在模板字符串里，注释里**不能出现反引号**（会把模板提前闭合）。 */
    .khin-imgtag.wait { background: #e2e8f0; color: #475569; }
    .khin-imgtag.note { background: #f1f5f9; color: #475569; }
    /* T21（用户 2026-10-13 拍板）：跨域未授权既不是故障（不许红）也不是普通告知（用户没事可做）——
     * 它是"去设置页把这个域名填进去就行" ⇒ 用 info 那一族语义色（与上面的 hit 一样走 token + fallback，
     * 不新造色值）。它同时是唯一的 action 类，默认视图常显，见 imgRowVisibleByDefault()。 */
    .khin-imgtag.action { background: var(--info-soft, #e7f0fc); color: var(--info, #1565c0); }
    /* 图标跟着同一个状态类走色（类名仍由 KH.OcrCopy.stateClass 给，面板不自己挑字符） */
    .khin-imgico.hit { color: var(--success-strong, #15803d); }
    .khin-imgico.miss { color: #94a3b8; }
    .khin-imgico.bad { color: #b91c1c; }
    .khin-imgico.wait { color: #64748b; }
    .khin-imgico.note { color: #64748b; }
    .khin-imgico.action { color: var(--info, #1565c0); }
    /* 命中词块（2026-10-09 用户裁决）：面板上只留命中的词，点它复制**它所在的整句**，
     * 整段识别文本改到光箱右侧与悬停说明里 —— 面板不再被一张图的长文本撑开。
     * 缩略图下那条「复制全文」按钮已按用户 2026-10-12 裁决删除，样式与类名一并删净；
     * 复制全文改走「进大图 → 在 OCR 全文栏里选中 → Ctrl+C」，大图工具栏也不许新增
     * 复制按钮 —— 那条通路的承重件是下方 .kh-lb-side 的 user-select: text。 */
    .khin-imgchips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
    .khin-imgchip {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 0 6px; font-size: 11px; line-height: 17px; border-radius: 9px; cursor: copy;
      background: var(--success-soft, #e9f7ef); color: var(--success-strong, #15803d);
      border: 1px solid rgba(22,101,52,.25);
    }
    .khin-imgchip:hover { background: #bbf7d0; }
    /* 同图合并行里"这一行词块是哪个关键词命中的"小标（2.0.2.4 需求②）：只做归属区分，
     * 不抢缩略图与词块的分量 —— 用中性灰，**不用**命中绿（它不是命中内容本身）。 */
    .khin-imgchipkw {
      align-self: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 10px; line-height: 15px; color: #64748b;
    }
    .khin-imgchip.copied { background: var(--success-strong, #15803d); color: #fff; }
    /* 复制失败：就地红一下（T29 / F3.1）。原来只有 title 换了一句话 —— 那要悬停才看得见，
     * 用户点完鼠标早已移开；剪贴板不可用是最常见的失败，必须一眼看出没复制上。
     * 复用 .khin-imgtag.bad 那对现成的红（不新增色值），与 .copied 在同一次 1200ms 复位里清掉。 */
    .khin-imgchip.failed { background: #fee2e2; color: #991b1b; border-color: rgba(153,27,27,.35); }
  `;

  /** 图片协议白名单（与内容脚本 sanitize 同口径：仅 http(s)） */
  const IMG_PROTOCOL_OK = /^https?:\/\//i;

  /** 灯箱允许的图片来源：http(s) 之外还允许 `data:image/*`
   *  —— v1.52 起"抓取到的图片"就可能是内嵌的 data URI（旧版注释写着"data: 内嵌图无需跳转"），
   *  它本身就是原图数据，在灯箱里显示是安全的（`<img src>` 不执行脚本）。 */
  const LIGHTBOX_SRC_OK = /^(https?:\/\/|data:image\/)/i;

  /**
   * 命中词去重列表：一段识别文本里同一个词命中多次只留一块
   * （同一句，复制出来一样 —— 多块只是噪声）。
   * @param {{matched?:Array}} it OCR 条目
   * @returns {string[]}
   */
  function hitWords(it) {
    const out = [];
    const seen = Object.create(null);
    const list = (it && it.matched) || [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i] && list[i].text ? String(list[i].text) : '';
      if (!w || seen[w]) continue;
      seen[w] = 1;
      out.push(w);
    }
    return out;
  }

  /**
   * 图片地址绝对化（只为了**比较**）：卡片里的 `<img src>` 由 `KH.Fetch.imgPlaceholder()` 归一成
   * 绝对地址，而 OCR 条目的 `src` 是引擎侧给的（可能是相对值）—— 两边放进同一个坐标系才能认出
   * "这张图卡片里已经有了"。没有 `location`（单测垫片）或解析失败时原样返回，绝不抛。
   */
  function absSrc(src) {
    const s = String(src == null ? '' : src);
    if (!s) return '';
    const base = (typeof location !== 'undefined' && location && location.href) ? location.href : '';
    if (!base) return s;
    try { return new URL(s, base).href; } catch (e) { return s; }
  }

  /**
   * 把识别原文里的命中词标出来（灯箱右侧「识别原文」栏）—— **只建文本节点**，不拼 HTML：
   * OCR 原文来自被识别的页面，`innerHTML` 拼进去等于把页面文本当代码。
   * 同一位置命中多个词时取最长的（`一对一` 不该被短词 `一` 切碎）；非命中段落整段复制，
   * 所以代理对（emoji）不会被从中间切开。
   * @param {Element} el 目标容器（先清空）
   * @param {string} text 识别原文
   * @param {string[]} words 命中词
   */
  function paintHits(el, text, words) {
    if (!el) return;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    /* 清空走 textContent = ''（垫片与真 DOM 同形）；下面一律用 appendChild 建**节点**，
     * 全程不碰 innerHTML —— OCR 原文是这个页面里的文本，不是可以当代码拼的东西。 */
    el.textContent = '';
    const full = String(text == null ? '' : text);
    if (!full) return;
    const list = (words || []).map((w) => String(w == null ? '' : w)).filter((w) => w)
      .sort((a, b) => b.length - a.length);
    if (!list.length) { el.appendChild(doc.createTextNode(full)); return; }
    let at = 0;
    while (at < full.length) {
      let best = -1;
      let hit = '';
      for (const w of list) {
        const i = full.indexOf(w, at);
        if (i >= 0 && (best < 0 || i < best)) { best = i; hit = w; }
      }
      if (best < 0) break;
      if (best > at) el.appendChild(doc.createTextNode(full.slice(at, best)));
      const mk = doc.createElement('mark');
      mk.className = 'kh-lb-hit';
      mk.textContent = hit;
      mk.title = KH.OcrCopy.VIEW.copySentence;
      el.appendChild(mk);
      at = best + hit.length;
    }
    if (at < full.length) el.appendChild(doc.createTextNode(full.slice(at)));
  }

  /**
   * 复制到剪贴板，返回 `Promise<boolean>`（false = 两条路都不通）。
   *
   * `navigator.clipboard` 在没有焦点/无权限时会 **reject**（不是抛异常），所以两条路都要接。
   * 兜底用临时 `<textarea>` + `execCommand('copy')`（老浏览器/无 clipboard API 时唯一能用的办法）。
   *
   * @param {string} text 要复制的文本
   * @param {Node} [hostEl] 临时节点的落点（优先面板 ShadowRoot：页面 observer 看不到影子树里的变动，
   *   不会因为"复制一下"就触发一次页面重建）。缺省挂 body。
   */
  function copyToClipboard(text, hostEl) {
    const txt = String(text == null ? '' : text);
    if (!txt) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(txt).then(() => true, () => legacyCopy(txt, hostEl));
    }
    return Promise.resolve(legacyCopy(txt, hostEl));
  }

  function legacyCopy(txt, hostEl) {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('data-kh-ext-ui', '1');       // 自身 UI 标记：不参与扫描/悬停
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
      const at = (hostEl && hostEl.isConnected) ? hostEl : document.body;
      at.appendChild(ta);
      ta.select();
      const ok = !!(document.execCommand && document.execCommand('copy'));
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

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
  /** 平移边界：图可以摆到**整屏任意位置**，但至少要有这么多像素还留在视口内（不至于被拖丢）。
   * 旧口径是「图边贴视口边 + 60 余量」，图比视口小时被 Math.max(0, …) 压成 0 ⇒ 大图常态
   * （84vw < 视口宽）只剩 60px 可挪，用户反馈「拖动范围有点小」（T43 放开）。
   * 回程出口只有复位按钮与双击复位两处，都早已存在 —— 不需要新增恢复入口。 */
  const LIGHTBOX_PAN_KEEP = 120;
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
      position: relative;              /* T41：全文栏的定位祖先 —— 坐标按容器算，不再按整个视口算 */
      border: 1px solid rgba(255,255,255,.18); border-radius: 12px;
      background: rgba(22,26,34,.94);                      /* 实心底色：一眼看出"这是插件的容器" */
      box-shadow: 0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.35);
      cursor: default;
    }
    .kh-lb-row { position: relative; display: flex; align-items: center; gap: 12px; }
    /* 图片（2.0.1.15 需求 5 案④）：**大图尺寸完全不变** —— 全文栏移出这一行之后，行里只剩
     * 图片 + 左右按钮，84vw 的上限在任何视口都放得下（1920：行 1733 < 容器 1843；1280：行 1195 < 1228）。
     * 所以这里既不需要包裹层、也不需要 overflow 剪裁：「有全文 / 无全文」图宽完全相同。 */
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
    /* 全文栏（2.0.1.15 需求 5 → T41 视觉重做 → T46 锚点修正 → 2.0.2.1 需求 4）：**独立的可拖动悬浮容器**。
     *   · position: fixed ⇒ 坐标按**视口**算（不再借 .kh-lb-row 当定位祖先）：拖到哪儿就停在哪儿，
     *     行变宽/变窄也不跟着飘。左/上/高由 JS 写（dockSide() 默认停靠、拖动时实时改写）。
     *   · 默认停靠 = **大图右侧并排**（dockSide 的首选位）；视口右侧放不下时退回**行内右侧**
     *     —— 那一档与 T46 定稿位逐像素一致（右缘让开 48px 导航键 + 12px 间隙），所以
     *     「结构上压不到 ‹/›」这条没有回退：T46 的病根是"浮层锚容器、导航锚行"两套基准错位，
     *     现在浮层两个位次都以**图的实际矩形**为基准算，且都不越进导航所在的那条带。
     *   · **默认可见**（用户 2.0.2.1 口径："默认在大图容器右侧并排展示"）——
     *     旧版"默认隐藏、点眼睛才弹出"已作废；眼睛按钮与浮层自带的 × 仍是**同一个状态**。
     *   · 仍然**不参与行宽分配**（脱流）⇒「有全文 / 无全文」图一样宽（T41 验收项，不许回退）；
     *     层级也仍高于图与导航（图 z-index:1、导航 z-index:2、本层 z-index:3）⇒ 放大溢出盖不住它。
     *   · 外壳只管分栏与圆角：标题栏（也是**拖动抓手**）与两个按钮固定，**滚动只在正文区**（.kh-lb-side-t）。 */
    .kh-lb-side {
      position: fixed; left: 0; top: 0; z-index: 3;
      width: 340px; max-width: min(342px, calc(100vw - 16px));
      display: flex; flex-direction: column; overflow: hidden;
      border-radius: 12px; background: rgba(22,26,34,.97);
      border: 1px solid rgba(255,255,255,.22);
      box-shadow: 0 16px 48px rgba(0,0,0,.6);
      color: #e8eef7; font-size: 12px; line-height: 1.5;
    }
    .kh-lb-side[hidden] { display: none !important; }
    .kh-lb-side-hd {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 8px 7px 10px; border-bottom: 1px solid rgba(255,255,255,.13);
      user-select: none; -webkit-user-select: none;
      /* 标题栏 = 拖动抓手（需求 4）：抓手光标 + 不参与触屏滚动手势，pointermove 才收得到 */
      cursor: move; touch-action: none;
    }
    /* 抓手纹样：拖动这条通路没有天然的可发现性（不像按钮有边框），给一个淡纹当提示 */
    .kh-lb-side-hd::before { content: '⠿'; opacity: .5; font-size: 13px; line-height: 1; }
    .kh-lb-side-h { font-weight: 600; font-size: 12px; }
    /* 「共 N 行」是次要信息：靠 margin-right:auto 吃掉空档，把两个按钮顶到右侧 */
    .kh-lb-side-n { font-weight: 400; font-size: 11.5px; opacity: .55; margin-right: auto; }
    /* 容器自带的两个操作入口（复制 / 关闭）：同一个胶囊形态；复制成功转绿、失败转红并换文案 */
    .kh-lb-side-abtn {
      height: 24px; padding: 0 9px; border: 1px solid rgba(255,255,255,.35);
      border-radius: 999px; background: #39404e; color: #fff;
      font: inherit; font-size: 11.5px; line-height: 1; cursor: pointer;
    }
    .kh-lb-side-abtn:hover { background: #4b5464; }
    .kh-lb-side-abtn.ok { background: var(--success-strong, #15803d); color: #fff; }
    .kh-lb-side-abtn.bad { background: #fee2e2; color: #991b1b; }
    .kh-lb-side-x { min-width: 24px; padding: 0 6px; }
    /* 正文区：滚动与选中复制都在它身上（标签栏与按钮因此永远可见） */
    .kh-lb-side-t {
      flex: 1 1 auto; overflow: auto; padding: 10px 12px 12px;
      white-space: pre-wrap; word-break: break-word;
      user-select: text; -webkit-user-select: text; cursor: text;
      font-size: 12.5px; line-height: 1.7;
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.28) transparent;
    }
    .kh-lb-side-t::-webkit-scrollbar { width: 9px; }
    .kh-lb-side-t::-webkit-scrollbar-thumb { background: rgba(255,255,255,.26); border-radius: 999px; }
    .kh-lb-side-t::-webkit-scrollbar-track { background: transparent; }
    /* 【2.0.2.7 用户 m00292】识别原文里命中词的高亮（用户原话："点击大图显示 ocr 原文时，
     * 标红或高亮命中的词在哪里"）—— 底色高亮 + 深红字，两种都能看见；paintHits 只建
     * mark.kh-lb-hit，这里负责它长什么样。 */
    .kh-lb-hit {
      background: #fde047; color: #991b1b; font-weight: 600;
      border-radius: 3px; padding: 0 2px; cursor: pointer;
    }
    /* 点一下就复制整句（反馈与面板词块同一套视觉语言：绿=复制上了，红=两条路都不通）。
     * 【为什么高亮词可点】原来"点词复制整句"的入口长在面板那一行的词块上，图折进卡片之后那一行
     * 不再重复画 ⇒ 能力搬到这里，不丢：命中词在原文里，点它复制的就是它所在的那句话。 */
    .kh-lb-hit.copied { background: #bbf7d0; }
    .kh-lb-hit.failed { background: #fecaca; color: #7f1d1d; }
    /* 【已删】原来这里有一条 has-side 后代选择器（"全文栏出现就把图片收窄"）：
     *   · 它本来就是**死规则** —— 类挂在 .kh-lb 自身、不在它的祖先链上，选择器要求的后代关系
     *     永远不成立（真机实测匹配数为 0），真实生效的一直只有上面 .kh-lb img 的 84vw；
     *   · 它表达的口径（图给全文栏让位）也已被用户否决：全文栏是浮层，大图尺寸不变。
     * 所以是**删除**，不是改选择器。注释里不留旧规则的数值，免得看着像还有这条规则。 */
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
        /* 全文栏（T46）：DOM 顺序 = 图 → 导航（‹/›）→ 浮层。浮层排在行内最后，与两个导航键共用
         * 同一个定位祖先（.kh-lb-row 的 position:relative），右缘只可能落在导航外侧的间隙里 ——
         * 上一版把它挂成容器的直接子元素（行与工具条之后）时，真机实测它压住 › 按钮达 48px
         * （= 整个按钮宽）并挡住点击；根因与修法见 .kh-lb-side 的几何注释。 */
        '<div class="kh-lb-side" hidden>' +
        '<div class="kh-lb-side-hd">' +
        '<span class="kh-lb-side-h"></span>' +
        '<span class="kh-lb-side-n"></span>' +
        '<button class="kh-lb-side-abtn kh-lb-copy" type="button"></button>' +
        '<button class="kh-lb-side-abtn kh-lb-side-x kh-lb-sidehide" type="button">×</button>' +
        '</div>' +
        '<div class="kh-lb-side-t" data-kh-lb-text="1"></div>' +
        '</div>' +
        '</div>' +
        '<div class="kh-lb-bar">' +
        '<span class="kh-lb-idx"></span>' +
        '<span class="kh-lb-sep">|</span>' +
        '<button class="kh-lb-btn kh-lb-out" type="button" title="缩小（-）">－</button>' +
        '<button class="kh-lb-btn kh-lb-in" type="button" title="放大（+）">＋</button>' +
        '<button class="kh-lb-btn kh-lb-rot" type="button" title="旋转 90°（R）">⟳</button>' +
        '<button class="kh-lb-btn kh-lb-reset" type="button" title="复位（也可双击图片）">复位</button>' +
        '<button class="kh-lb-btn kh-lb-sidebtn" type="button" hidden></button>' +
        '<span class="kh-lb-sep">|</span>' +
        '<button class="kh-lb-open" type="button">在新标签页打开</button>' +
        '<span class="kh-lb-hint">滚轮缩放；拖动图片可平移；拖动全文栏标题可移动，双击复位；点图片外区域或按 Esc 关闭</span>' +
        '</div>';
      const box = sr.querySelector('.kh-lb');
      const img = sr.querySelector('.kh-lb-img');
      const prev = sr.querySelector('.kh-lb-prev');
      const next = sr.querySelector('.kh-lb-next');
      const idxEl = sr.querySelector('.kh-lb-idx');
      /* 右侧全文栏（用户 m00631 口径：全文不再占据面板，点图放大后看这里）——
       * 标题文案也来自唯一真源 KH.OcrCopy，面板不许自己写中文。 */
      const side = sr.querySelector('.kh-lb-side');
      const sideText = sr.querySelector('.kh-lb-side-t');
      const sideLines = sr.querySelector('.kh-lb-side-n');
      const sideCopy = sr.querySelector('.kh-lb-copy');
      const sideClose = sr.querySelector('.kh-lb-sidehide');
      const sideBtn = sr.querySelector('.kh-lb-sidebtn');
      sr.querySelector('.kh-lb-side-h').textContent = KH.OcrCopy.VIEW.textPane;
      /* 「×」与工具条上的眼睛按钮是**同一个状态**（sideHidden），只是入口不同：
       * 悬停说明也取自同一对 VIEW 键，不另写一套中文。 */
      sideClose.title = KH.OcrCopy.VIEW.paneHide;
      sideClose.setAttribute('aria-label', KH.OcrCopy.VIEW.paneHide);
      sideCopy.textContent = KH.OcrCopy.VIEW.paneCopy;
      sideCopy.title = KH.OcrCopy.VIEW.paneCopy;
      /* 当前这张图的 **OCR 原文**（条目上的 text，即服务端识别结果）—— 一键复制只认它。
       * 刻意不读 sideText.textContent：那是屏幕上的字，会被折行、被滚出视口，也可能被 UI 拼进来。 */
      let curText = '';
      /* 全文栏的显示态（2.0.2.1 需求 4）：**会话级**、**默认可见**（用户口径："默认在大图容器右侧并排展示"）。
       * 只在这次开灯箱期间有效：close() 复位成可见，于是每次打开都从"并排展示"这一档开始。
       * 刻意做成闭包变量：挂 host 上会跨次开灯箱存活（host 是缓存的 DOM 宿主），
       * 存进扩展的持久化存储更会跨会话 —— 那都不是"临时收起全文"该有的生命周期。 */
      let sideHidden = false;
      const close = () => { box.hidden = true; img.removeAttribute('src'); sideHidden = false; };
      /** 平移夹紧：图可以摆到**整屏任意位置**，只保证「至少 LIGHTBOX_PAN_KEEP 像素仍在视口内」，
       * 所以怎么拖都不会把图丢掉（缩放变化后也要重夹，继续走它）。
       * 推导：图中心在原点、宽 w，平移 tx 后跨度是 [tx − w/2, tx + w/2]；要求至少 KEEP 像素仍落在
       * 视口 [−W/2, W/2] 内 ⇒ tx ≥ −(W+w)/2 + KEEP 且 tx ≤ (W+w)/2 − KEEP
       * ⇒ 对称上界就是 (W+w)/2 − KEEP（Y 同构）。
       * 旧式「图边贴视口边」在图比视口小时会被 Math.max(0, …) 压成 0（T43 换掉）。
       * r 是含 transform 的实测盒 ⇒ 缩放/旋转后自动跟着变，不用另写分支。 */
      const clampPan = (tx, ty) => {
        const r = img.getBoundingClientRect();
        const limX = Math.max(0, (window.innerWidth + r.width) / 2 - LIGHTBOX_PAN_KEEP);
        const limY = Math.max(0, (window.innerHeight + r.height) / 2 - LIGHTBOX_PAN_KEEP);
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
        /* 全文栏：有识别文本才谈得上显示（没识别出文字的图不摆空栏），且**默认可见** —— 用户口径
         * "默认在大图容器右侧并排展示"（收起入口 = 工具条眼睛按钮 / 浮层自带的 ×）。
         * 本栏是浮层，它的显隐**不影响图片宽度**（T41 验收项，不许回退）。 */
        const full = (cur && cur.text) ? String(cur.text) : '';
        curText = full;                     /* 一键复制的唯一数据源（服务端 OCR 原文，不读屏幕文字） */
        side.hidden = !full || sideHidden;
        /* 默认停靠（需求 4）只对"还没被拖过"的这一档生效：拖动过之后位置由 host._sidePos 说了算。
         * apply() 也会被翻页/缩放/换图回调触发，不能每次都把用户摆好的位置推回默认位。 */
        if (!side.hidden && !host._sideMoved) dockSide();
        /* 【2.0.2.7 用户 m00292】原文里把命中词标出来（`paintHits` 只建文本节点，原文一字不动，
         * 命中的那几段套上 `<mark class="kh-lb-hit">`）—— 命中词在 OCR 条目上（`hitWords`），
         * 由开灯箱那一处随相册条目一起带进来。 */
        paintHits(sideText, full, (cur && cur.hits) || []);
        sideLines.textContent = full ? KH.OcrCopy.render(KH.OcrCopy.VIEW.paneLines, { n: full.split(/\r?\n/).length }) : '';
        sideCopy.hidden = !full;            /* 没有 OCR 文本 ⇒ 按钮不出现（不是置灰） */
        box.classList.toggle('kh-lb-has-side', !!full);
        /* 眼睛按钮：没识别出文字就没有可切的东西 ⇒ **不出现**（与 prev/next 单张时 hidden 同一手法；
         * 置灰不可点会留下一个点了没反应的按钮，那才是噪声）。
         * 文案取自真源 KH.OcrCopy.VIEW，灯箱不许自己写这两句。 */
        sideBtn.hidden = !full;
        sideBtn.textContent = sideHidden ? KH.OcrCopy.VIEW.paneShow : KH.OcrCopy.VIEW.paneHide;
        idxEl.textContent = multi ? ((i + 1) + ' / ' + g.length) : '';
        idxEl.setAttribute('title', multi ? ('第 ' + (i + 1) + ' 张 / 共 ' + g.length + ' 张') : '');
        /* 平移：**先把本次缩放/旋转写进 transform，再夹紧**（T43 追加）。clampPan 读的是活的
         * getBoundingClientRect，顺序反了它拿到的就是上一次留下的尺寸 —— 从 4× 缩回 1× 时会按
         * 旧的大盒算出很大的边界，平移量原样留下，用户看到的就是"缩回来后图飞出去"（要等下一次
         * apply() 才收回）。夹紧若真的改了值才写第二次；没夹紧就不多写一次 style。 */
        const tx0 = host._tx || 0, ty0 = host._ty || 0;
        const s = host._scale || 1, rot = host._rot || 0;
        img.style.transform = 'translate(' + tx0 + 'px, ' + ty0 + 'px) scale(' + s + ') rotate(' + rot + 'deg)';
        const p = clampPan(tx0, ty0);
        host._tx = p.x;
        host._ty = p.y;
        if (p.x !== tx0 || p.y !== ty0) {
          img.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px) scale(' + s + ') rotate(' + rot + 'deg)';
        }
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

      /* 默认停靠（2.0.2.1 需求 4）：**大图右侧并排展示**。
       *   · 首选位 = 图右缘 + 12 间隙 + 48 导航 + 12 间隙 ⇒ 落在导航**外侧**那条空档里，
       *     结构上不可能压到 ‹/›（T46 那条缺陷的判据，不许回退）；
       *   · 视口右侧放不下（大图/窄屏的常态）⇒ 退回**行内右侧**：右缘齐图右缘
       *     （让开 12 + 48 那条导航带），左缘随宽度往左长 —— 与 T46 定稿的 right: 60px 逐像素等价。
       *     注意别写成 r.right + 12：那正是导航带的起点，会压住 › 头 12px（T47-A 判据是重叠 = 0）；
       *   · 纵向与图上下齐平、高度取图高（浮层自己滚，不撑破视口）；
       *   · 图还没解码完（rect 全 0，正是开灯箱那一刻的常态）⇒ 先按一个中庸高度摆上，
       *     解码后由 img 的 load 回调重摆一次（否则会拿 0 高摆出一条 120px 的窄条）。 */
      const dockSide = () => {
        const r = img.getBoundingClientRect();
        const gap = 12;
        const w = side.offsetWidth || 340;
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = r.right + gap + 48 + gap;
        if (x + w > vw - gap) x = r.right - w;
        x = Math.max(gap, Math.min(x, Math.max(gap, vw - w - gap)));
        const y = Math.max(gap, Math.min(r.top, Math.max(gap, vh - 120)));
        const h = Math.min(Math.max(120, r.height || 320), Math.max(120, vh - y - gap));
        side.style.left = Math.round(x) + 'px';
        side.style.top = Math.round(y) + 'px';
        side.style.height = Math.round(h) + 'px';
      };

      /* 拖动全文栏（需求 4）：抓手 = 标题栏。坐标走**视口**（.kh-lb-side 是 position:fixed）。
       * 夹紧只保证标题栏还留在视野里（最坏也留 80px 宽、40px 高）—— 拖动是这条通路唯一的位移出口，
       * 拖出去找不回来等于把识别全文弄丢；双击标题栏可复位回默认停靠位（回程出口）。 */
      let paneDrag = null;
      const paneHd = sr.querySelector('.kh-lb-side-hd');
      paneHd.title = KH.OcrCopy.VIEW.paneDrag;
      paneHd.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;   // 复制 / × 交给按钮
        const pr = side.getBoundingClientRect();
        paneDrag = { x: e.clientX, y: e.clientY, left: pr.left, top: pr.top };
        e.preventDefault();
        try { paneHd.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也还能靠 move */ }
      });
      paneHd.addEventListener('pointermove', (e) => {
        if (!paneDrag) return;
        e.preventDefault();
        const w = side.offsetWidth || 340;
        const x = Math.min(window.innerWidth - 80, Math.max(80 - w, paneDrag.left + (e.clientX - paneDrag.x)));
        const y = Math.min(window.innerHeight - 40, Math.max(0, paneDrag.top + (e.clientY - paneDrag.y)));
        host._sideMoved = true;                     /* 拖过之后 apply() 不许再把位置推回默认位 */
        side.style.left = Math.round(x) + 'px';
        side.style.top = Math.round(y) + 'px';
      });
      const endPaneDrag = () => { paneDrag = null; };
      paneHd.addEventListener('pointerup', endPaneDrag);
      paneHd.addEventListener('pointercancel', endPaneDrag);
      paneHd.addEventListener('lostpointercapture', endPaneDrag);
      paneHd.addEventListener('dblclick', (e) => {
        e.preventDefault();
        host._sideMoved = false;
        dockSide();
      });
      /* 图解码完才拿得到真实矩形 ⇒ 默认停靠要在 load 后再摆一次（首次打开那一刻 rect 还是 0）。 */
      img.addEventListener('load', () => {
        if (!box.hidden && !side.hidden && !host._sideMoved) dockSide();
      });
      /* 开灯箱期间改窗口大小也要跟手（2.0.2.2 需求 1；原「下版本修复预录」那一条）——不然浮层停在
       * 旧视口坐标上，窗口一变小整条可能偏出视野。两条限制缺一不可：
       *   · 浮层藏着（眼睛收起）时不摆，免得再展开时跳一下；
       *   · **只对没被手动拖过的那一档跟手** —— 用户拖到的位置就是他的意图，resize 不许抢走。
       *     双击标题栏复位会把 `_sideMoved` 归 false ⇒ 之后重新跟手（回程出口没被削掉）。 */
      window.addEventListener('resize', () => {
        if (!box.hidden && !side.hidden && !host._sideMoved) dockSide();
      });

      /* 滚轮缩放（需求 5）：作用域 = 整块遮罩，但**正文区里滚 = 读文本**，不抢它的滚动。
       * 每 100px 滚动 ≈ 一档（LIGHTBOX_ZOOM_STEP）并夹在 ±2 档内 —— 滚轮与触控板的 deltaY
       * 量纲差得远（行模式一滚就是 3），不夹的话一次能跳四倍。 */
      box.addEventListener('wheel', (e) => {
        if (side.contains(e.target)) return;
        e.preventDefault();
        const k = Math.max(-2, Math.min(2, e.deltaY / 100));
        if (k) zoom(Math.pow(LIGHTBOX_ZOOM_STEP, -k));
      }, { passive: false });

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
      /* 隐藏/显示右侧全文栏（需求 5）：用 on() 包装 —— 它做 preventDefault + stopPropagation，
       * 否则这次点击会继续冒泡给 box 的关闭判定（按钮在 stage 内，虽然也不会关，但别留这个口子）。 */
      on(sideBtn, () => { sideHidden = !sideHidden; apply(); });
      /* 一键复制（T41 / 用户本次新增要求）：复制的是 curText —— 服务端 OCR 原文，不是屏幕文字，
       * 也不是面板里的词。无文本时按钮已被 apply() 隐藏，所以这里不必判空（空串会被 copyToClipboard 拒掉）。
       * 失败不静默：按钮就地转红并换成失败文案，1.2s 后复原（与面板词块的失败反馈同一套视觉语言）。 */
      let copyFxTimer = 0;
      on(sideCopy, () => {
        copyToClipboard(curText, sr).then((ok) => {
          sideCopy.textContent = ok ? KH.OcrCopy.VIEW.paneCopied : KH.OcrCopy.VIEW.paneCopyFail;
          sideCopy.classList.toggle('ok', ok);
          sideCopy.classList.toggle('bad', !ok);
          clearTimeout(copyFxTimer);
          copyFxTimer = setTimeout(() => {
            sideCopy.textContent = KH.OcrCopy.VIEW.paneCopy;
            sideCopy.classList.remove('ok');
            sideCopy.classList.remove('bad');
          }, 1200);
        });
      });
      /* 「×」= 隐藏全文栏：与眼睛按钮共用同一个状态变量、共用一次 apply()，文案也取自同一对 VIEW 键，
       * 所以两者永远不会不同步。它在浮层内 ⇒ 浮层隐藏时它一起隐藏（用户口径）。 */
      on(sideClose, () => { sideHidden = true; apply(); });
      /* 点原文里的高亮词 = 复制它所在的一整句：原来这个入口长在面板那一行的词块（.khin-imgchip）上，
       * 图折进卡片之后那一行不再重复画 ⇒ 能力搬到这里，不丢（命中词就在原文里，点它有话可说）。
       * 反馈与词块同一套视觉语言：绿=复制上了，红=两条路都不通；1.2s 后各自复原。
       * 【为什么不用上面那个 on()】它只转发无参回调，这里要 e.target 才知道点的是哪个词。
       * 【为什么每个 mark 各自 setTimeout】共享一个 timer 时，1.2s 内连点两处会把先点的那处永久留绿。 */
      sideText.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        /* 命中词是叶子节点（mark 里只有文字）⇒ 点的就是它，不必反查祖先：全仓红线禁止
         * closest('.kh-*') 反查（那条红线是给"页面命中"定的：命中只存在于注册表、必须走坐标定位）。
         * 这里认的是本文件自己画出来的 mark，不是页面命中，所以按标签 + 类名直接认。 */
        const t = e && e.target;
        const mk = (t && t.tagName === 'MARK' && t.classList &&
          t.classList.contains('kh-lb-hit')) ? t : null;
        if (!mk) return;
        const w = String(mk.textContent || '');
        copyToClipboard(KH.OcrCopy.sentenceOf(curText, w) || w, sr).then((ok) => {
          mk.classList.toggle('copied', !!ok);
          mk.classList.toggle('failed', !ok);
          setTimeout(() => {
            mk.classList.remove('copied');
            mk.classList.remove('failed');
          }, 1200);
        });
      });
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

      /* 关闭：只在**按下点也在容器（图片 + 翻页键 + 工具条 + 浮层）以外**时，抬手/点击才关。
       * v1.99.99.12 用户口径："减小容器范围，改成点击容器内都不会退出"；T46 真机又抓到两个反向误关：
       *   · 在浮层里按下、往容器外拖（选词 / 滚动惯性）松手 —— click 的目标会退化成公共祖先 .kh-lb 自己，
       *     容器里查不到它 ⇒ 被当成"点遮罩"把灯箱关掉；
       *   · 从被浮层盖住的地方起手拖动、松手落在容器外 —— 同上。
       * 所以判定改成以**按下的位置**为准（pointerdown 记一次，click 只读它），抬手落点不再决定关不关。 */
      const stage = sr.querySelector('.kh-lb-stage');
      const bar = sr.querySelector('.kh-lb-bar');
      let pressInStage = false;
      box.addEventListener('pointerdown', (e) => {
        const t = e.target;
        pressInStage = !!(t && stage.contains(t));
      });
      box.addEventListener('click', (e) => {
        const t = e.target;
        if (pressInStage) return;                           /* 按下在容器内 ⇒ 这一下不算"点遮罩" */
        if (t && stage.contains(t)) return;
        /* 浮层现在就在容器内的行里，下面这条是兜底（T46 之前它在容器外，必须单列）—— 少了它，
         * 在栏里点一下选词就会被当成"点到容器外"而把灯箱关掉（这栏存在的意义就是让人读和抄）。 */
        if (t && side.contains(t)) return;
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
    host._sideMoved = false;                                // 全文栏每次打开都回到默认停靠位（需求 4）
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

  /* 下拉最多渲染多少条（超出只显示总数，条目不再增多） */
  const TAG_LIST_MAX = 20;

  /* FAB 长按否决阈值（T40 / T37 真机取证）：收起态那颗 📌 既是"展开"按钮、又是"拖动"把手，
   * 按住约 1 秒不动再松手 ⇒ 浏览器眼里就是一次普通 click ⇒ 面板自己弹开（鼠标与触屏都复现）。
   * 判据：按住 ≥ 该阈值且期间无位移 ⇒ 不当作点击；快击照旧展开，拖完仍由 dragMoved 否决。
   * 不用定时器：按下记时间戳、click 里比时长即可（键盘 Enter/空格不派发 pointerdown，
   * 时间戳缺席 ⇒ heldMs 为 0 ⇒ 放行，键盘可达性不受影响）。 */
  const FAB_LONG_PRESS_MS = 600;

  /* 命中词块的复制反馈窗口（T63 · 真机 e2e 抓到的真产品缺陷）：
   * 点 chip 后点亮 `.copied` / `.failed` 并换 title，这段反馈持续 IMG_COPY_MS 后复位。
   * 原来是裸字面量写死在 setTimeout 里，现在**重建重放与到点复位读的是同一个数**（两处口径
   * 必须一致），所以抽成常量 —— 顺带把窗口长度变成可查的契约。 */
  const IMG_COPY_MS = 1200;

  /* 命中文本的规范形：去首尾空白。**比较与显示都用它** ——
     口径是"去首尾空白后按码点数比"，所以先归一再比。 */
  const tagText = (s) => String(s == null ? '' : s).trim();

  const head = {
    /**
     * 命中集 → 有效条目（顺序 = 入参顺序 = 文档序，全程**不排序**）。
     * 一条 = 有 kw（去首尾空白后非空）；空文本命中不参与比较、也不计入命中数。
     * @returns {Array<{kw: string, adj: string}>}
     */
    tagEntries(entries) {
      const out = [];
      for (const e of entries || []) {
        if (!e) continue;
        const kw = tagText(e.kw);
        if (!kw) continue;
        out.push({ kw, adj: tagText(e.adj) });
      }
      return out;
    },

    /**
     * 命中 → 卡片标签 HTML（单条形态：`🔖 标题 → 关键词` / `🔖 关键词`）。
     * **一张卡命中多个时默认只展示最短的那一个**；命中数 > 1 时后面追加一个计数小标，
     * 点小标由 panel.renderTags 就地铺开下拉（本函数只出串，不碰 DOM）。
     * 「最短」= 去首尾空白后按**码点数**（[...s].length，不是 String.length，避免代理对误算）；
     * 并列最短取**文档序第一个** —— 只做挑选，不排序、不随机（同一输入必得同一输出）。
     * @param {Array<{kw: string, adj: string}>} entries
     * @param {number} [pickIdx] 用户从下拉里选过的条目序号（见 panel.pickedTags）；非法则回到最短
     */
    tagHtml(entries, pickIdx) {
      const list = this.tagEntries(entries);
      if (!list.length) return '';
      let best = 0;
      if (typeof pickIdx === 'number' && pickIdx >= 0 && pickIdx < list.length) {
        best = pickIdx;
      } else {
        for (let i = 1; i < list.length; i++) {
          if ([...list[i].kw].length < [...list[best].kw].length) best = i;
        }
      }
      const e = list[best];
      let html = e.adj
        ? '<span class="khin-item-kw">🔖 ' + escText(e.adj) + '</span>' +
          '<span class="khin-item-adj">→ ' + escText(e.kw) + '</span>'
        : '<span class="khin-item-kw">🔖 ' + escText(e.kw) + '</span>';
      /* 命中 1 个：不出小标、不可展开。
       * 悬停说明（title）**不在这一层挂** —— 字符串层只出元素骨架 + 计数，
       * 免得"命中文本进属性"的口子有任何先例（说明文案在 renderTags 的 DOM 层挂）。 */
      if (list.length > 1) {
        html += '<button class="khin-tag-more" type="button" data-kh-tag-more="1">' +
                list.length + '</button>';
      }
      return html;
    },

    /**
     * 下拉内容 HTML（纯函数：数组进、字符串出；测试走 `KH.ImportantNote.head.*`，
     * 没有面板 DOM 通路，所以**可断言的那一层就是这条串**）。
     * 头行给总数、体里最多 TAG_LIST_MAX 条（超出只少渲染条目，不截断文本）。
     * 安全：每条命中**各自**过 escText；且**绝不把命中文本拼进任何 HTML 属性** ——
     * escText 只转义 & < >，双引号/单引号原样放行，拼进属性就是注入面。
     * 列表项的完整文本因此走 DOM 层 `el.title = kw`（见 panel.renderTags）。
     * @param {Array<{kw: string, adj: string}>} entries
     * @param {number} [max] 覆盖上限（默认 TAG_LIST_MAX）
     */
    tagListHtml(entries, max) {
      const list = this.tagEntries(entries);
      if (!list.length) return '';
      const cap = (typeof max === 'number' && isFinite(max) && max > 0)
        ? Math.floor(max) : TAG_LIST_MAX;
      let body = '';
      for (let i = 0; i < list.length && i < cap; i++) {
        /* 下拉条目要能键盘选中（T29 / F4.3：原来只能点，键盘打开了也选不了）。
         * role + tabindex 让它进 Tab 序列、被读屏当按钮念；Enter/空格的绑定在
         * panel.renderTags 的 DOM 层（元素每次重画都是新的，直接绑、不用委托）。
         * 命中文本仍只做文本内容、绝不进任何属性（escText 不转义引号）。 */
        body += '<div class="khin-tag-item" data-kh-tag-idx="' + i + '" role="button" tabindex="0">' +
                escText(list[i].kw) + '</div>';
      }
      return '<div class="khin-tag-list">' +
               '<div class="khin-tag-list-h">' +
                 escText(KH.OcrCopy.render(KH.OcrCopy.VIEW.hitsTotal, { n: list.length })) +
               '</div>' +
               '<div class="khin-tag-list-b">' + body + '</div>' +
             '</div>';
    },

    /**
     * 命中集 → 卡片列表。
     * 两级聚合：先按**内容(note)** 分卡（内容不一致绝不进同一卡），
     * 卡内 entries 去重后交给 tagHtml 做形态聚合。
     * 每条卡片还带 `pinIds`（来源规则的 `ruleId` 集合），只服务「置顶排序」的匹配（见 sortByPins）。
     * @param {object[]} hits  registry 命中
     * @param {Set<string>} ignored 本次会话被用户关掉的笔记内容
     */
    build(hits, ignored) {
      const rawMap = new Map();     // note\0kw\0adj -> { note, kw, adj, pinIds, imgSize, bg }
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
        /* 置顶排序的匹配键（2.0.2.6）：规则身份 `ruleId`（命中登记时由 core/index.js 写进 `meta.pinId`）。
         * **它只并入集合、不参与去重键** —— 普通词「价格」与组合词「价格×单价」的卡片文本都是「价格」，
         * 两张卡本来就该合成一条记录（去重键是 note\0kw\0adj），拆开会让同一张卡上的词显示两遍。 */
        const pinId = String(h.meta.pinId || '').trim().toLowerCase();
        const key = note + '\u0000' + kw + '\u0000' + adj;
        const prev = rawMap.get(key);
        if (prev) { if (pinId) prev.pinIds.add(pinId); continue; }   // 去重（但把 pinId 收进来）
        rawMap.set(key, {
          note, kw, adj,
          pinIds: new Set(pinId ? [pinId] : []),
          imgSize: h.meta.imgSize || '',
          noteFontSize: h.meta.noteFontSize || '',
          bg: h.meta.impNoteBg || ''
        });
      }

      const noteMap = new Map();    // note -> { note, imgSize, noteFontSize, bg, entrySet, pinIds }
      rawMap.forEach((r) => {
        let g = noteMap.get(r.note);
        if (!g) { g = { note: r.note, imgSize: r.imgSize, noteFontSize: r.noteFontSize, bg: r.bg, entrySet: new Set(), pinIds: new Set() }; noteMap.set(r.note, g); }
        if (!g.imgSize && r.imgSize) g.imgSize = r.imgSize;
        if (!g.noteFontSize && r.noteFontSize) g.noteFontSize = r.noteFontSize;
        if (!g.bg && r.bg) g.bg = r.bg;
        g.entrySet.add(r.kw + '\u0000' + (r.adj || ''));
        r.pinIds.forEach((p) => g.pinIds.add(p));
      });

      const items = [];
      noteMap.forEach((g) => {
        const entries = [];
        g.entrySet.forEach((k) => {
          const i = k.indexOf('\u0000');
          entries.push({ kw: k.slice(0, i), adj: k.slice(i + 1) });
        });
        items.push({ note: g.note, entries, pinIds: Array.from(g.pinIds), imgSize: g.imgSize || '', noteFontSize: g.noteFontSize || '', bg: g.bg || '' });
      });
      return items;
    },

    /**
     * 内容脏检查：命中集合未变 → 不重建 DOM（避免无关变化导致闪烁/重播入场动画）。
     *
     * 【key 必须含 imgSize / noteFontSize】单卡的尺寸与字号都是靠 `renderItems` 给该卡写**内联**
     * `--kh-img-size` / `--kh-note-fs`（`el.style.setProperty(…)`）生效的，
     * 而它们是**渲染期**写的：key 不含这两个键时，"只改某词/分组的图片尺寸或字号、内容一字未变"
     * 会判成不脏 → 跳过 renderContent → 卡片尺寸/字号不刷新（把词级值删掉时更糟：
     * 旧的内联值会一直残留）。所以尺寸与字号变化必须算脏。
     */
    changed(oldItems, newItems) {
      if ((oldItems || []).length !== (newItems || []).length) return true;
      const key = (it) => (it.note || '') + '\u0001' + (it.bg || '') + '\u0001' + (it.imgSize || '') + '\u0001' +
        (it.noteFontSize || '') + '\u0001' +
        (it.entries || []).map(e => (e.kw || '') + '\u0003' + (e.adj || '')).sort().join('\u0002');
      const oldKeys = new Set((oldItems || []).map(key));
      for (const it of newItems) if (!oldKeys.has(key(it))) return true;
      return false;
    },

    /**
     * 置顶排序表（2.0.2.5 需求④）：`cfg.importantNote.pinOrder` → 关键词数组，最多 `KH.Config.NOTE_PIN_MAX` 个。
     * 解析口径（分隔符 / trim / 丢空 / 去重 / 截断）的**唯一真源**是 `KH.Config.pinOrderKeys`
     * —— 设置页保存前调的是同一个函数，别在这里抄第二份。
     * 【2.0.2.6】表里的值现在是**关键词 id**（设置页下拉框给的），不再是手写的卡片文本；
     * 旧的文本值照旧生效（见 `sortByPins` 的两路匹配）。
     */
    parsePins(cfg) {
      const raw = cfg && cfg.importantNote ? cfg.importantNote.pinOrder : '';
      return KH.Config.pinOrderKeys(raw);
    },

    /**
     * 按置顶表**稳定**排序：命中的卡片按 `pins` 里的先后排到最前；未命中的卡片保持原有相对顺序
     * （`Array.prototype.sort` 自 ES2019 起稳定 ⇒ rank 相同的一律不动）。
     * 一张卡命中多个置顶项时取**最靠前**的那个下标（卡上挂了两个词时，用户写在前面的那个说了算）。
     *
     * 匹配两路，都 trim 后不区分大小写**精确相等**（不做包含匹配）：
     *   · 卡片关键词 `entries[].kw`（= `meta.text`）—— 2.0.2.5 的手写文本口径，保留兼容；
     *   · 卡片来源规则的 id `pinIds`（= `meta.pinId` = `ruleId`）—— 2.0.2.6 起设置页下拉框的口径。
     * 第二路是必需的：正则词的卡片文本是**运行时命中的页面文本**、罕见字的卡片文本是那个生僻字，
     * 两者都无法从配置侧枚举出来；而且它还能区分「普通词『价格』」与「组合词『价格×单价』」
     * （两张卡的 `kw` 都是「价格」，只有 ruleId 不同）。
     * 空表 ⇒ 原样返回（调用方据此跳过排序，旧行为一字不变）；始终返回新数组，不动入参。
     */
    sortByPins(items, pins) {
      const list = (items || []).slice();
      const order = (pins || []).map((p) => tagText(p).toLowerCase());
      if (!order.length) return list;
      const rankOf = (it) => {
        let best = order.length;
        const consider = (v) => {
          const k = tagText(v).toLowerCase();
          if (!k) return;
          const i = order.indexOf(k);
          if (i >= 0 && i < best) best = i;
        };
        for (const e of (it && it.entries) || []) consider(e && e.kw);
        for (const p of (it && it.pinIds) || []) consider(p);
        return best;
      };
      return list.sort((a, b) => rankOf(a) - rankOf(b));
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
    /* 上一轮用过的置顶表签名（见 `render`）：卡间顺序不进 `head.changed`，靠它认
     * "用户改了置顶排序"。空串 = 没配/没排序过（与 `pins.join()` 的空表结果一致 ⇒ 首轮不误判脏）。 */
    pinSig: '',
    /* 📝 笔记区收起（2026-10-11 用户：笔记与图片两边都很长时互相抢占 ⇒ 两边都能收，收一边让另一边）。
     * 与图片分区的"按批作废"口径**不同**：这里只翻转标记，用户收起就保持收起
     * —— 它是用户对视图的选择，不该被下一批结果自动弹开（图片那边有"命中必须露出来"的硬要求，这没有）。 */
    noteCollapsed: false,
    ignored: new Set(),  // 本次页面会话内已被用户关闭的笔记（按 note 文本）
    /* 标签下拉的展开态 / 选中的命中序号（均按 note 文本挂**面板侧**）。
     * 不许挂 head：标签区每次重建（head.changed() 判脏 → renderContent() → renderItems()），
     * 挂在 head 上会被重置，展开中的下拉会自己合上。 */
    expandedTags: new Set(),
    pickedTags: new Map(),
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
    /* 复制反馈的**面板级待显示状态**（T63 真机缺陷）：这份瞬时反馈原来只活在 chip 节点的
     * classList 上，而 `renderImgSection()` 每次都把列表整体重建
     * （`this.imgListEl.textContent = ''`，:1554 那一行）—— 只要 OCR 状态变一变
     * （`KH.ImgOcr.onChange(() => panel.renderImg())`）就重建一次 ⇒ 被点的那颗 chip 当场游离，
     * 类名留在死节点上，屏幕上的绿框约 1/4 秒就没了（qa 的真机读数：ms≈94–330 整段 childList 删+加）。
     * 现在记在面板上：建 chip 时命中同一 key 且仍在窗口内就补上类与 title（重建自动重放），
     * 窗口一到由 imgClearCopyMark 复位。key = 条目稳定键 + '|' + 命中词 —— 同一个词在**别的条目**
     * 里是另一块，不许互相点亮。 */
    imgCopyMark: { key: '', ok: false, at: 0 },
    imgSecEl: null,
    imgListEl: null,
    imgCountEl: null,
    imgAllEl: null,
    imgArrowEl: null,
    pos: { left: 20, top: 20 },
    dragState: null,
    /* FAB 本次按下的时间戳（T40）：pointerdown 记；**pointerup 结算**成 fabHeldMs（T41）。
     * 默认 0/未记录 = 放行 —— 键盘 Enter/空格激活不派发指针事件，靠的就是这个语义。 */
    fabPressAt: 0,
    /* FAB 这次按住的毫秒数（T41）：由 startDrag 的 pointerup / pointercancel 结算，
     * click 只读。默认 0 = 放行（键盘激活、或根本没有手势那一次 click）。 */
    fabHeldMs: 0,
    /* FAB 上一次展开面板的时刻（T60）。存在的唯一理由：**同一次鼠标双击的第二次落点**。
     * 一次双击的派发序是 down/up/click(1) → down/up/click(2) → dblclick；click(1) 落点就是 FAB，
     * :1264 的 click 里会 openPanel() ⇒ renderContent() 当场把 `.khin-fab` 换壳成
     * `.khin-panel`+`.khin-header`（FAB 中心与标题栏那一行必然相交）⇒ 紧随其后的 click(2) 与
     * dblclick 就落在刚生成的标题栏上，命中 :1377 的「双击收起」⇒ 面板闪一下又收回去（T60 症状）。
     * 默认 0 = 没有刚展开过 ⇒ 标题栏双击照常收起。 */
    fabOpenedAt: 0,

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
        /* OCR 结果按 `src` 建索引：相册条目带上识别全文，灯箱右侧才能显示（用户 m00631 口径）。
         * `imgItems` 就是本面板当前的 OCR 条目；两边都过 `absSrc` 归一，防"相对 vs 绝对"对不上。
         * 【2.0.2.7 用户 m00292】命中词另建一份同键索引：灯箱「识别原文」栏要把它们标出来
         * （`paintHits`）。同一张图多条条目（不同关键词命中）时取**并集**，别丢词。 */
        const textBySrc = new Map();
        const hitsBySrc = new Map();
        for (const it of (this.imgItems || [])) {
          const k = absSrc(it && it.src);
          if (!k) continue;
          if (it.text) textBySrc.set(k, String(it.text));
          const ws = hitWords(it);
          if (ws.length) hitsBySrc.set(k, (hitsBySrc.get(k) || []).concat(ws));
        }
        const list = [];
        let index = 0;
        for (let i = 0; i < all.length; i++) {
          const im = all[i];
          const s = im.src || '';                            // 用**解析后**的绝对地址，和 t.src 同一口径
          if (!s || !LIGHTBOX_SRC_OK.test(s)) continue;       // 占位/非法协议不进相册
          if (im === t) index = list.length;
          const k = absSrc(s);
          list.push({ src: s, alt: im.getAttribute('alt') || '',
            text: textBySrc.get(k) || '', hits: hitsBySrc.get(k) || [] });
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
      /* 一次 rect 读，横纵共用（省一次强制布局）。
       * 水平钳位用**面板实测宽度**：原来写死 360，与 `.khin-panel { width }` 成了两处真源 ——
       * 改 CSS 后钳位不跟着动；用户自己 `resize: both` 拉宽后更会算出错的 maxLeft（拖到右侧越界）。
       * 量不到时（hidden ⇒ display:none ⇒ width 0）钳位自然失效，此时面板不可见，无需钳位。 */
      const rect = this.root.getBoundingClientRect();
      const width = this.minimized ? 56 : rect.width;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      /* 纵向钳位按**面板自己的实际高度**算（用户 2026-10-07：光有滚动条不够，还得滚得到）。
       * 原来按固定 48px 留白，面板一高就能被拖到视口外，下半截连同滚动条一起看不见；
       * 面板本身有 max-height: calc(100vh - 24px)，所以这里能让它整块留在视口内。 */
      const h = this.minimized ? 48 : (rect.height || 0);
      const maxTop = Math.max(8, window.innerHeight - Math.min(h, window.innerHeight - 16) - 8);
      this.pos.left = Math.max(8, Math.min(this.pos.left, maxLeft));
      this.pos.top = Math.max(8, Math.min(this.pos.top, maxTop));
      this.root.style.left = this.pos.left + 'px';
      this.root.style.top = this.pos.top + 'px';
    },

    startDrag(e) {
      if (e.button === 2) return;                              // 忽略右键
      const hitFab = (el) => !!(el && el.classList && el.classList.contains('khin-fab'));
      const t = e.target;
      /* 按钮上不拖 —— 但收起态 FAB 例外（T29 / F4.1：它现在同时是"展开"按钮，
       * 一起拦掉就把拖动把手废了）。FAB 里的 📌 / 徽标是两个 span，也算在把手内。
       * 判定只看命中的元素自身与其父亲（不用 closest 反查 —— meta-check 对带 kh- 的
       * closest 直接红灯，那条红线的教训已经踩过一次）。 */
      const inFab = hitFab(t) || !!(t && t.tagName === 'SPAN' && hitFab(t.parentNode));
      if (t && t.tagName === 'BUTTON' && !inFab) return;
      e.preventDefault();
      const rect = this.root.getBoundingClientRect();
      const state = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top, moved: false };
      this.dragState = state;
      const move = (ev) => {
        if (!this.dragState) return;
        /* 挪过 3px 才算"拖"：FAB 同时是按钮，拖着挪位置时末尾也会补一个 click ——
         * 不区分就会"拖完面板自己弹开"（原来只绑 dblclick，正是为了躲这个）。 */
        if (Math.abs(ev.clientX - state.startX) + Math.abs(ev.clientY - state.startY) > 3) state.moved = true;
        this.pos.left = state.startLeft + (ev.clientX - state.startX);
        this.pos.top = state.startTop + (ev.clientY - state.startY);
        this.applyPosition();
      };
      const up = () => {
        this.dragMoved = !!state.moved;      // 留给 FAB 的 click 判定：这一次是拖还是点
        /* T41：按住时长在指针抬起时**结算**（不是在 click 里现算）。计时源必须是指针事件 ——
         * click 的派发延迟是浏览器行为（触屏抬起后还要等一次双击/缩放手势判定），
         * 拿它当计时源会把一次快速轻点误判成长按。缺省 0 ⇒ 没有指针手势的激活（键盘）一律放行。 */
        if (this.fabPressAt) { this.fabHeldMs = Date.now() - this.fabPressAt; this.fabPressAt = 0; }
        this.dragState = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      /* 触屏被系统接管（滚动/多指手势）时不会有 pointerup：同样结算并清干净，
       * 否则残留的时间戳会把下一次真实点击当成长按否决掉。 */
      window.addEventListener('pointercancel', up);
    },

    /** 渲染（幂等；内容未变则不重建 DOM） */
    render(items, cfg) {
      const doc = document;
      this.ensure(doc);
      /* 图片尺寸与正文字号都走 `KH.Config` 的**唯一归一函数**（2.0.2.6 需求③ 收口）：
       * 边界常量与设置页数字输入的 min/max 是同一对，越界夹紧、坏值回默认 —— 手改 storage /
       * 导入旧备份塞进 0 / 负数 / 9999 时，面板不许变成一行一个字或一张图占满整屏（配置是信任边界）。 */
      const imgSize = KH.Config.normalizeImgSize(cfg && cfg.importantNote && cfg.importantNote.imgSize);
      this.host.style.setProperty('--kh-img-size', imgSize + 'px');
      const noteFs = KH.Config.normalizeNoteFontSize(cfg && cfg.importantNote && cfg.importantNote.fontSize);
      this.host.style.setProperty('--kh-note-fs', noteFs + 'px');

      /* 面板默认宽度（T26 / 用户 2026-10-12：200 → 250，且设置页可调）：同 imgSize 手法写成 CSS
       * 变量。写在 this.root（= .khin-wrap，变量定义处也在那条规则里 ⇒ 内联压过规则里的默认值），
       * 面板宽度与命中词块的上限共用这一个变量。
       * 归一只有 config 的 normalizePanelWidth 一处（读路径 normalize 调的是同一个函数）：手改
       * storage / 导入旧备份塞进 0 / 负值 / 非数字时回默认 250，越界夹到 200–1200 ——
       * 面板宽度是布局承重值，坏值绝不许把它变成 0 宽。 */
      this.root.style.setProperty('--khin-panel-w',
        KH.Config.normalizePanelWidth(cfg && cfg.notePanelWidth) + 'px');

      /* 图片命中与重要笔记**共用这块面板**（用户口径：图片命中要有地方看，且不占页面）；
       * 但两者独立：没有重要笔记的关键词，它识别到的图片照样要显示。 */
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];

      /* 置顶排序（2.0.2.5 需求④）：配置 → 关键词表 → 命中的卡片稳定地抽到最前。
       * 必须排在**脏判据之前**算：`head.changed` 比的是"每张卡的内容"（note/底色/字号/词条集合），
       * 卡间顺序变了它照样返回 false ⇒ 顺序变没变得靠 `pinSig` 自己认，
       * 否则用户改了「置顶排序」，`render` 会走 else 只刷图片分区，屏上不重排。
       * 空表时 `sorted` 就是原数组、`pinSig` 为空串 ⇒ 与旧版逐字节一致（不多一次拷贝、不多一次重建）。 */
      const pins = head.parsePins(cfg);
      const pinSig = pins.join('\u0001');
      const pinChanged = this.pinSig !== pinSig;
      this.pinSig = pinSig;
      const sorted = pins.length ? head.sortByPins(items, pins) : items;

      if (!sorted.length && !this.imgItems.length) {
        this.items = sorted;
        this.hide();
        return;
      }
      /* 外壳还没建过也必须走 renderContent：`head.changed([], [])` 是 false，
       * 光看内容新旧会漏掉"整页只有图片命中、面板还没建"这种情况（实测踩过：
       * 面板宿主建出来了、里面却没有 🖼 分区）。 */
      const dirty = !this.panelEl || this.minimized || pinChanged || head.changed(this.items, sorted);
      this.items = sorted;
      if (dirty) this.renderContent();
      else this.renderImgSection();
      this.show();
    },

    /** 图片命中变化时（异步结果回来）只刷图片分区，不重建笔记卡片 */
    renderImg() {
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];
      /* 【2.0.1.17 右键任意图 OCR】整页既没有笔记、也没有图片命中时，外壳从未被造过
       * （见本文件底部 `consume` 的 `if (!list.length && !imgCount && !panel.host) return;`），
       * 而右键识别是用户**主动**要的一次动作 —— 结果必须能显示。
       * 旧实现首行是 `if (!this.root) return;` ⇒ 这种情况下面板永远不出现（用户以为功能坏了）。
       * 但**不能无条件**走完整渲染：`render()` 一进来就 `ensure()` 造壳 ⇒ 整页明明没东西也会
       * 多出一个空宿主（K71 的「两者都关 ⇒ 面板不存在」就是这么红的）。所以只在真有右键条目时补渲染。 */
      if (!this.root && !this.imgItems.some((it) => it && it.via === 'contextMenu')) return;
      if (!this.panelEl) {
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

      // 收起态：整块换成圆形 FAB（单击/双击/回车都能展开 —— 拖动收尾不算，见 startDrag）
      if (this.minimized) {
        this.panelEl = null;
        this.bodyEl = null;
        this.countEl = null;
        /* FAB 是真按钮（T29 / F4.1）：原来是个 div、只绑了 dblclick ⇒ 键盘够不着、鼠标单击
         * 也没反应，只有「双击」这一条隐性通路（能收不能开）。现在 click 展开、dblclick 保留
         * （用户双击习惯不变）、pointerdown 仍交给拖动；计数进 aria-label，📌 与徽标都是装饰。
         * 文案取自 KH.OcrCopy.VIEW（面板不许自己写这几句中文）。 */
        this.root.innerHTML =
          '<button class="khin-fab" type="button"><span aria-hidden="true">📌</span>' +
          '<span class="khin-fab-badge" aria-hidden="true">' + count + '</span></button>';
        const fab = this.root.querySelector('.khin-fab');
        const fabLabel = KH.OcrCopy.render(KH.OcrCopy.VIEW.fabLabel, { n: count });
        fab.title = fabLabel;
        fab.setAttribute('aria-label', fabLabel);
        /* 展开的唯一通路（FAB click / FAB dblclick / 键盘激活）。
         * `suppressMs` 只给测试注入时钟用（生产调用一律不带参数、也不传事件对象 ⇒ 取当前时刻）；
         * 展开前先清窗口：上一次留下的时刻不该吞掉这一次的标题栏双击（这一行**无条件覆盖**就已
         * 同时完成「清上一次」与「记这一次」，不必再单写一句 cleanup）。 */
        const openPanel = (suppressMs) => {
          this.minimized = false;
          this.fabOpenedAt = typeof suppressMs === 'number' ? suppressMs : Date.now();
          this.renderContent();
          this.applyPosition();
        };
        fab.addEventListener('pointerdown', (e) => {
          this.fabPressAt = Date.now();      // T40：按住时长的起点（键盘不走这里 ⇒ 缺席=放行）
          this.fabHeldMs = 0;                // 清上一次的结算值：新的一次按下不该继承旧时长
          this.dragMoved = false;            // 每次按下先清上一次的拖动标记：拖动若没派发 click，
                                             // 别让它留在 true 上吞掉下一次键盘激活（T40 顺手补）
          this.startDrag(e);
        });
        fab.addEventListener('click', (e) => {
          /* 键盘激活（Enter / 空格）派发的 click 没有指针手势：detail === 0，且前面没有 pointerdown
           * ⇒ 一律放行，并清掉可能残留的手势状态（拖动收尾没派发 click、pointercancel 之后留下的
           * 旧值），否则键盘这一次会被上一次手势的旧状态吞掉。 */
          const keyboard = !e || e.detail === 0;
          if (keyboard) { this.dragMoved = false; this.fabHeldMs = 0; openPanel(); return; }
          if (this.dragMoved) { this.dragMoved = false; this.fabHeldMs = 0; return; }   // 刚才是拖动，不是点
          /* 长按否决（T40）：按住 ≥600ms 且没位移 ⇒ 不当作点击（真机取证：按住约 1 秒松手会误开面板）。
           * 时长由 startDrag 的 pointerup **结算**（T41：计时源必须是指针事件 —— click 的派发延迟
           * 是浏览器行为，触屏抬起后还要等双击/缩放手势判定，拿它当计时源会把快速轻点误判成长按）；
           * 这里只读结算值，缺席（没有 pointerdown）⇒ 0 ⇒ 放行。 */
          const heldMs = this.fabHeldMs;
          this.fabHeldMs = 0;
          if (heldMs >= FAB_LONG_PRESS_MS) return;
          openPanel();
        });
        fab.addEventListener('dblclick', () => openPanel());
        /* 键盘：原生 <button> 的 Enter 与空格都会派发 click ⇒ 键盘通路到此闭合，
         * 不必再补 keydown（补了会双触发）。 */
        return;
      }

      // 展开态：外壳只创建一次（避免每次命中变化重播入场动画 → 闪烁）
      if (!this.panelEl) {
        /* 题头措辞（含箭头字符）一律取自 KH.OcrCopy.VIEW（F3.4：原来两个题头逐字相同，
         * 读屏听不出展开的是哪一块）；aria-controls 各自指向受控区（笔记正文 / 图片列表）。 */
        this.root.innerHTML =
          '<div class="khin-panel">' +
            '<div class="khin-header">' +
              '<span class="khin-header-icon" aria-hidden="true">📌</span>' +
              '<span class="khin-header-title">重要笔记</span>' +
              '<span class="khin-header-count">0 条</span>' +
              '<button class="khin-header-btn" data-act="min">—</button>' +
            '</div>' +
            '<div class="khin-notebar" role="button" tabindex="0" aria-expanded="true" aria-controls="khin-note-body" hidden>' +
              '<span class="khin-notetitle">📝 笔记</span>' +
              '<span class="khin-notecount"></span>' +
              '<span class="khin-notearrow">' + KH.OcrCopy.VIEW.noteCollapse + '</span>' +
            '</div>' +
            '<div class="khin-body" id="khin-note-body"></div>' +
            '<div class="khin-imgsec" hidden>' +
              '<div class="khin-imghead" role="button" tabindex="0" aria-expanded="false" aria-controls="khin-img-list">' +
                '<span class="khin-imgtitle">🖼 图片</span>' +
                '<span class="khin-imgcount" role="status" aria-live="polite"></span>' +
                '<span class="khin-imgall" data-act="all" hidden></span>' +
                '<span class="khin-imgarrow">' + KH.OcrCopy.VIEW.imgExpand + '</span>' +
              '</div>' +
              '<div class="khin-imglist" id="khin-img-list"></div>' +
            '</div>' +
          '</div>';
        this.panelEl = this.root.querySelector('.khin-panel');
        this.bodyEl = this.root.querySelector('.khin-body');
        this.countEl = this.root.querySelector('.khin-header-count');
        this.noteBarEl = this.root.querySelector('.khin-notebar');
        this.noteCountEl = this.root.querySelector('.khin-notecount');
        this.noteArrowEl = this.root.querySelector('.khin-notearrow');
        this.imgSecEl = this.root.querySelector('.khin-imgsec');
        this.imgListEl = this.root.querySelector('.khin-imglist');
        this.imgCountEl = this.root.querySelector('.khin-imgcount');
        this.imgAllEl = this.root.querySelector('.khin-imgall');
        this.imgArrowEl = this.root.querySelector('.khin-imgarrow');
        this.imgHeadEl = this.root.querySelector('.khin-imghead');
        this.imgTitleEl = this.root.querySelector('.khin-imgtitle');
        /* 分区标题的完整语义挂 title（可见短标签「🖼 图片」只是缩写）—— 四条面板标题文案
         * 一律取自 KH.OcrCopy.VIEW（T29 / F1.2：原来写死在面板里，改文案的人改不动）。 */
        if (this.imgTitleEl) this.imgTitleEl.title = KH.OcrCopy.VIEW.imgSectionTip;
        /* 两个题头都是"整行可点的 div"，键盘完全够不着（T29 / F4.2）：补 role/tabindex/
         * aria-expanded 之后，回车与空格要跟点击做同一件事。范式照抄命中词块那段
         * （给元素各自直接绑 —— 不用 closest 反查父节点，那是 meta-check 的红线）。 */
        const onActivate = (el, fn) => el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); }
        });
        const toggleNotes = () => {
          this.noteCollapsed = !this.noteCollapsed;
          this.applyNoteCollapsed();
        };
        /* 笔记区收起/展开（2026-10-11 用户：两边都很长时互相抢占，收一边让另一边）。
         * 只翻转标记 + 换类名，不重建 DOM —— 展开时正文还在（收起期间不重渲染也不清空）。 */
        this.noteBarEl.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleNotes();
        });
        onActivate(this.noteBarEl, toggleNotes);
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
        const toggleImgs = () => {
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
        };
        this.imgHeadEl.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleImgs();
        });
        onActivate(this.imgHeadEl, toggleImgs);

        const header = this.panelEl.querySelector('.khin-header');
        header.addEventListener('pointerdown', (e) => this.startDrag(e));
        // 双击标题栏收起为 FAB（策划案 §5.2.3）
        header.addEventListener('dblclick', () => {
          /* T60：同一次鼠标双击的**第二次落点**。若这块标题栏是不久前刚被 FAB 的 click(1) 换壳出来的，
           * 这一下 dblclick 不是用户新起的手势，不许当成「双击收起」——否则面板刚展开就被收回去。
           * 一次性：命中即清零（不清就是永久抑制，展开久了再双击标题栏将永远收不起来）。
           * ponytail: 600ms 是浏览器双击间隔上限（沿用 FAB_LONG_PRESS_MS），用户「点开、停顿、再双击标题栏收起」会被吞掉一次；真要精确就得在 FAB 换壳时吞掉紧随其后的那一次 click/dblclick（事件层面认序列，而不是拿时间窗近似）。
           * 只在 fabOpenedAt 非 0 时生效 ⇒ 未经过 FAB 展开的面板（例如页面刷新后恢复）不受影响。 */
          const sinceFabOpen = Date.now() - this.fabOpenedAt;
          if (this.fabOpenedAt && sinceFabOpen >= 0 && sinceFabOpen < FAB_LONG_PRESS_MS) { this.fabOpenedAt = 0; return; }
          this.minimized = true;
          this.renderContent();
          this.applyPosition();
        });
        const minBtn = this.panelEl.querySelector('[data-act="min"]');
        minBtn.title = KH.OcrCopy.VIEW.minTip;      // 文案真源（T29 / F1.2）
        minBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.minimized = true;
          this.renderContent();
          this.applyPosition();
        });
      }

      if (this.countEl) this.countEl.textContent = count + ' 条';
      /* 笔记区题头：只在**真有笔记**时露出来（整页只有图片命中时，多一行「📝 笔记 0 条」是噪声） */
      if (this.noteBarEl) {
        this.noteBarEl.hidden = !this.items.length;
        if (this.noteCountEl) this.noteCountEl.textContent = this.items.length + ' 条';
      }
      /* 笔记列表整块没有时也要藏（T29 / F6.1）：它带 min-height:60px，空着就是面板顶部
       * 一条 60px 白带（整页只有图片命中时最明显）。[hidden] 的规则与收起态并列写在 CSS 里。
       * 【2.0.2.13】右键识别的那张「截图」卡也住在这一块里 ⇒ 只有它时不能藏（否则点了右键，
       * 主模块整块消失，图只留在底部附属区）。 */
      const ctxN = this.ctxItems().length;
      if (this.bodyEl) this.bodyEl.hidden = !(this.items.length || ctxN);
      this.applyNoteCollapsed();
      this.renderItems();
      this.renderImgSection();
    },

    /** 笔记区的收起态落到 DOM（收起时正文整块藏起来，空间让给图片分区；两边都能收，对称） */
    applyNoteCollapsed() {
      if (!this.bodyEl) return;
      const collapsed = this.noteCollapsed === true;
      this.bodyEl.classList.toggle('khin-collapsed', collapsed);
      if (this.noteArrowEl) {
        this.noteArrowEl.textContent = collapsed ? KH.OcrCopy.VIEW.noteExpand : KH.OcrCopy.VIEW.noteCollapse;
      }
      /* 收起态也要说给读屏听（T29 / F4.2）：视觉上换了箭头字符，aria-expanded 才是
       * 辅助技术读得懂的那一位。这里已确保 bodyEl（= 面板在展开态）存在，题头就在。 */
      if (this.noteBarEl) this.noteBarEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
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
     * **要用户动手的告知（`action` 类：跨域未授权）同样常显**（T21，用户 2026-10-13 拍板）——
     * 藏进复核视图等于把答案锁在用户找不到的地方，而这条恰恰一句话就能解决。
     * 状态类只从唯一真源 `KH.OcrCopy.stateClass()` 取，这里**不另立一套枚举**。
     */
    imgRowVisible(it) {
      if (this.imgShowAll === true) return true;
      return this.imgRowVisibleByDefault(it);
    },

    /** 默认视图本身会不会显示它（与当前视图无关）—— 「显示全部」的**条目数**要用它数：
     *  若拿 `list.length - shown.length` 数，切到复核视图后 shown 就成全量、hiddenN 变 0，
     *  按钮当场消失 ⇒ 只进不出（`VIEW.onlyHits` 永远渲染不出来）。 */
    imgRowVisibleByDefault(it) {
      const cls = KH.OcrCopy.stateClass(it);
      /* T21：`action`（跨域未授权）与命中和真失败一样常显 —— 它不是"没命中"，
       * 是"把这个域名授权一次就能读"，用户照折叠标签里的域名去设置页填一行就解决。 */
      if (cls === 'hit' || cls === 'bad' || cls === 'action') return true;
      /* 【2.0.1.17 右键任意图 OCR】用户**自己点名**的那张图（右键识别）必须常显：
       * 状态类是中性 `note`（"已识别"不是命中也不是故障），但它是用户主动要的一次动作 ——
       * 默认视图把它折进复核视图就等于"右键之后什么都没发生"。 */
      return !!(it && it.via === 'contextMenu');
    },

    imgRowHiddenCount(list) {
      return (list || []).filter((it) => !this.imgRowVisibleByDefault(it)).length;
    },

    /** 还没跑完的条目数（纯函数）：默认视图把它们藏起来了，但计数与空视图必须说出来 ——
     *  否则"藏起来 + 结果没回来"看起来就是"这次没有命中"（在结果出来之前下结论）。 */
    imgBusyCount(list) {
      return (list || []).filter((it) => KH.OcrCopy.stateClass(it) === 'wait').length;
    },

    /** 卡片正文里已经画出来的图片地址（绝对化）—— 用来回答"这张图卡片里有没有"。
     *  取 src 的口径与相册扫描（`.khin-imghit` 上面那处 `im.src`）一致：img.src 是解析后的绝对地址。 */
    cardedSrcs() {
      const out = new Set();
      if (!this.bodyEl || typeof this.bodyEl.querySelectorAll !== 'function') return out;
      for (const im of this.bodyEl.querySelectorAll('img')) {
        const s = absSrc(im.currentSrc || im.getAttribute('src') || im.src);
        if (s) out.add(s);
      }
      return out;
    },

    /**
     * 分区本轮到画哪些条目（2.0.2.7 用户 m00292：**卡片里已经有的图不重复画**）。
     * 纯过滤，不改状态、不碰 DOM（好单测）：卡片里找不到这张图的条目（右键识别、字段没抓到图、
     * 卡片还没渲染出来…）一律留着 —— 静默消失是这张面板明令禁止的失败模式。
     */
    unfoldedImgItems() {
      const all = this.imgItems || [];
      if (!all.length) return all;
      const carded = this.cardedSrcs();
      if (!carded.size) return all;
      return all.filter((it) => {
        const s = absSrc(it && it.src);
        return !s || !carded.has(s);
      });
    },

    /**
     * 把 OCR 结果标到卡片里那些图上（2.0.2.7 用户 m00292：命中的图加红框）。
     *
     * 命中 ⇒ `.khin-imghit`（红框）+ title 说出命中的词；只是识别过没命中的图把原分区那一行的
     * 状态原因挂成 title（`imgWhyText`）—— 那一行现在不重复画了，原因得以 title 存活，不丢信息。
     * 同一张图多条条目（不同关键词）时优先取**有命中**的那条；卡片里没有对应条目的图（面板装饰图、
     * 行内图标）不碰。只在 `renderImgSection()` 首行调用：卡片是整体重建的，标记必须跟着重建走。
     */
    applyImgMarks() {
      if (!this.bodyEl || typeof this.bodyEl.querySelectorAll !== 'function') return;
      const at = new Map();
      for (const it of (this.imgItems || [])) {
        const s = absSrc(it && it.src);
        if (!s) continue;
        const prev = at.get(s);
        if (!prev || (!hitWords(prev).length && hitWords(it).length)) at.set(s, it);
      }
      for (const im of this.bodyEl.querySelectorAll('img')) {
        const s = absSrc(im.currentSrc || im.getAttribute('src') || im.src);
        const it = s ? at.get(s) : null;
        if (im.classList) im.classList.remove('khin-imghit');
        if (!it) continue;
        const words = hitWords(it);
        if (words.length) {
          if (im.classList) im.classList.add('khin-imghit');
          im.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.imgHitTip, { matched: words.join('、') });
        } else {
          im.title = this.imgWhyText(it);
        }
      }
    },

    /**
     * 同一张图的多条条目并成一组（2.0.2.4 需求② · 纯函数，不碰 DOM —— 好单测）。
     *
     * 【为什么】不同关键词抓同一个字段 = 同一张图被识别一次、各自命中不同的词：
     * 面板上就该是**一行**缩略图 + 每个关键词一行命中词块，而不是同一张缩略图铺两遍。
     * 【归并键】`src` 串（同一张图在条目里就是同一个 src）。**没有 src 的条目一律各自成组**
     * （跨域读不到 / 被拦下的条目 `src` 可能为空，按空值归并会把不相干的图并成一行）。
     * 组内保持原顺序、组间保持首次出现顺序。
     */
    groupImgItems(list) {
      const groups = [];
      const at = new Map();
      let seq = 0;
      for (const it of (list || [])) {
        const src = String((it && it.src) || '');
        const g = src || ('#' + (seq++) + String((it && it.key) || ''));
        let i = src ? at.get(src) : undefined;
        if (i === undefined) { i = groups.length; if (src) at.set(src, i); groups.push({ items: [] }); }
        groups[i].items.push(it);
      }
      return groups;
    },

    renderImgSection() {
      if (!this.imgSecEl) return;
      /* 【2.0.2.7 用户 m00292】先把命中标记落到卡片上（红框 + 命中词 title），再画这张分区。
       * 写在这里是**唯一一处**：renderContent / renderImg / 「显示全部」点击 / 题头折叠四条路
       * 最后都汇到本方法，卡片整体重建时标记跟着重算（旧框也在这一趟里被摘掉）。 */
      this.applyImgMarks();
      const all = this.imgItems || [];
      /* 【2.0.2.7 用户 m00292】卡片里已经画出来的图不在分区里重复一行（用户原话："图片识别模块和
       * 卡片字段抓取展示的图片有些重复…可不可以删掉图片识别模块，复用卡片"）；卡片里没有的图仍然
       * 留在这里、不静默 —— 右键识别那条路**只有**这张显示面（img-ocr.js 的 manual 表不进卡片）。
       * 「收起过」这份记忆按**全量**条目算（`all`）：折叠不该被"这张图恰好也在卡片里"打断。 */
      const list = this.unfoldedImgItems();
      /* 【命中就自动展开（K69）】用户报的：图里识别出关键词了，分区却还是收着的，得手动点开才看得到。
       * 规则：**只要有命中的条目就默认展开**；用户手动收起来过就尊重他 —— 但这份"尊重"只对
       * **当时那批条目**有效（`imgSameBatch`）：换代了就作废，新场景里照样自动展开。 */
      if (!this.imgSameBatch(all)) { this.imgUserCollapsed = false; this.imgCollapsedKeys = []; }
      /* 「显示全部」这份视图记忆同理按批作废（用户 2026-10-06：不做整页范围的长期记忆） */
      if (this.imgShowAll === true && !this.imgShowAllSameBatch(all)) {
        this.imgShowAll = false;
        this.imgShowAllKeys = [];
      }
      /* 【默认只显示命中】（用户 2026-10-06）：这个功能的主要目的是命中，没命中的图不必占版面；
       * 「显示全部」把其余条目（未命中 / 排队中 / 没认出文字 / 读不到图…）留给人工复核。
       * 哪条算"都要显示"由 `imgRowVisible` 一处决定（命中 + 真失败 + 要你动手的 action），这里不再各判一次。 */
      const shown = list.filter((it) => this.imgRowVisible(it));
      /* 【2.0.2.4 需求②】同一张图的多条命中并成一行：行数按**组**数，条目数口径不变
       * （「显示全部」的收起点数仍按条目数数，那是复核入口的语义）。 */
      const groups = this.groupImgItems(shown);
      /* 要复核的条数按**默认口径**数（与当前视图无关）：切到「显示全部」后按钮要变成
       * 「只看命中」留着，点得回去 —— 否则这个复核入口只进不出。 */
      const hiddenN = this.imgRowHiddenCount(list);
      /* 【还没跑完就不许说"没有命中"】默认视图把"识别中"的行也藏起来了，于是"藏起来 + 还没回来"
       * 会显示成"这次没有命中" —— 那是在结果出来之前下结论。所以计数与空视图都要把在跑的数量说出来。 */
      const busyN = this.imgBusyCount(list);
      if (this.imgCountEl) {
        this.imgCountEl.textContent = (groups.length ? '(' + groups.length + ')' : '') +
          (busyN ? KH.OcrCopy.render(KH.OcrCopy.VIEW.busy, { n: busyN }) : '');
      }
      if (this.imgAllEl) {
        this.imgAllEl.hidden = !hiddenN;
        this.imgAllEl.textContent = hiddenN
          ? KH.OcrCopy.render(this.imgShowAll ? KH.OcrCopy.VIEW.onlyHits : KH.OcrCopy.VIEW.showAll, { n: hiddenN })
          : '';
        /* 文案本身已自解释（F2.1）；title 仍挂完整句，范围口径写清楚 */
        this.imgAllEl.title = this.imgShowAll ? KH.OcrCopy.VIEW.onlyHitsTip : KH.OcrCopy.VIEW.showAllTip;
      }
      if (this.imgUserCollapsed !== true && list.some((it) => it.state === 'done' && it.matched && it.matched.length)) {
        this.imgCollapsed = false;
      }
      if (this.imgArrowEl) {
        this.imgArrowEl.textContent = this.imgCollapsed ? KH.OcrCopy.VIEW.imgExpand : KH.OcrCopy.VIEW.imgCollapse;
      }
      /* 题头的 role/tabindex/aria-expanded 让它成为可操作控件（T29 / F4.2）：视觉上只是
       * 箭头字符在变，读屏读的是这一位。放在早退之前 —— 空列表时状态也得是对的。 */
      if (this.imgHeadEl) this.imgHeadEl.setAttribute('aria-expanded', this.imgCollapsed ? 'false' : 'true');
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
      for (const g of groups) {
        /* 【2.0.2.4 需求②】组内第一条管缩略图与状态（状态取"先命中的那条"，真源文案一字不改），
         * 组内每条的关键词命中词各占一行词块（下面那个 `g.items` 循环）——
         * 同一张图只铺一遍，命中词一个不少。 */
        const it = g.items.find((x) => KH.OcrCopy.stateClass(x) === 'hit') || g.items[0];
        const row = doc.createElement('div');
        row.className = 'khin-imgitem';
        row.setAttribute('data-kh-ocr-key', g.items.map((x) => String((x && x.key) || '')).join(' '));

        /* 缩略图。它下面原来挂一条固定的「📋 复制全文」按钮（2026-10-09 用户裁决加的），
         * 2.0.1.15 需求 7 用户又裁定删掉 —— 复制全文改走大图里的选中复制。 */
        const thumbWrap = doc.createElement('div');
        thumbWrap.className = 'khin-imgthumbwrap';
        const thumb = doc.createElement('img');
        thumb.className = 'khin-imgthumb';
        if (LIGHTBOX_SRC_OK.test(it.src || '')) thumb.src = it.src;
        thumb.alt = it.keyword || '';
        /* 【票 #45】分区缩略图自己也要有「命中了什么」的提示（红框 + title）：不能指望
         * `applyImgMarks()` —— 它只扫 `.khin-body` 里的图，而缩略图在 `.khin-imgsec`（与 body 是
         * 兄弟，见上面的 DOM 骨架），何况它是在本函数**首行**跑的，那时这张缩略图还没被建出来。
         * title 与卡片里那层红框同一口径（`imgHitTip`）；没命中就说清为什么（`imgWhyText`）。 */
        const thumbWords = hitWords(it);
        if (thumbWords.length) {
          thumb.className += ' khin-imghit';
          thumb.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.imgHitTip, { matched: thumbWords.join('、') });
        } else {
          thumb.title = this.imgWhyText(it);
        }
        thumbWrap.appendChild(thumb);
        row.appendChild(thumbWrap);

        const meta = doc.createElement('div');
        meta.className = 'khin-imgmeta';
        const head = doc.createElement('div');
        head.className = 'khin-imgrow';
        const kw = doc.createElement('span');
        kw.className = 'khin-imgkw';
        /* 行内不再重复「🖼 」（用户 2026-10-11：面板刚收到 200px 那会儿关键词格只剩 84px）——
         * 整块都在「🖼 图片」分区标题底下，行内再挂一个图标是冗余的，省下的宽度全给关键词。
         * 【2.0.2.4 需求②】同图合并行里有几个关键词就都列出来（去重、保持原顺序）——
         * 否则合并之后"You看不出这行是哪几个词抓的"。 */
        const names = [];
        for (const x of g.items) {
          const n = (x.keyword || '') + (x.label ? '（' + x.label + '）' : '');
          if (n && names.indexOf(n) < 0) names.push(n);
        }
        kw.textContent = names.join('、');
        /* 面板窄时关键词要能被 ellipsis 截断 ⇒ 全称挂 title，别让信息真的丢 */
        kw.title = kw.textContent;
        head.appendChild(kw);
        /* 图标 + 短标签（2026-10-11 用户裁决：面板窄时放不下「未命中/识别中…」这类长标签，
         * 图标让同类状态一眼可分）。图标同样只从真源取，面板不自己挑字符；
         * 但它是**独立 span**：`tag.textContent` 必须保持"只说结论"（'命中'/'未命中'…）
         * —— 真机与单测都拿它当状态措辞比对（`content.test.js:3127/3132/3176/3230/3289`）。 */
        const ico = doc.createElement('span');
        ico.className = 'khin-imgico ' + KH.OcrCopy.stateClass(it);
        ico.textContent = KH.OcrCopy.icon(it);
        ico.setAttribute('aria-hidden', 'true');
        head.appendChild(ico);
        const tag = doc.createElement('span');
        /* 状态类只从唯一真源取（`hit`/`miss`/`wait`/`note`/`bad`）：进行中不再是红的 */
        tag.className = 'khin-imgtag ' + KH.OcrCopy.stateClass(it);
        tag.textContent = this.imgTagText(it);
        /* 悬停看完整理由（未命中时里面就有识别文本）：面板上不铺长文本，
         * 但"这个结论是怎么来的"必须查得到 —— 文案一律走真源，面板不写中文。 */
        tag.title = this.imgWhyText(it);
        head.appendChild(tag);
        /* 本次识别的**真实**耗时（S3-④ 用户裁决）：数字来自回执（`img-ocr.js:445` 存在条目上），
         * 文案与格式一律走真源 `KH.OcrCopy.costLabel/costTip` —— 面板不许自己拼数字或写中文。
         * 没有值（排队中 / 还没跑到）时 `costLabel` 返回空串 ⇒ 连 span 都不挂，不留空标签。
         * 【位置】必须在 appendChild(tag) 之后 —— appendChild 对已存在的子节点是"移动"，
         * 插在 tag 之前会被后一次 append 挪到 tag 前面去（实测踩过）。 */
        const cost = doc.createElement('span');
        cost.className = 'khin-imgcost';
        cost.textContent = KH.OcrCopy.costLabel(it);
        cost.title = KH.OcrCopy.costTip(it);
        if (cost.textContent) head.appendChild(cost);
        meta.appendChild(head);

        /* 命中词块（2026-10-09 用户裁决）：面板上只留**命中的词**，点它复制它所在的整句；
         * 一段里同一个词命中多次只给一块（同一句，复制出来一样）。
         * 整段识别文本搬去灯箱右侧（点缩略图放大）与上面的悬停说明。
         * 【2.0.2.4 需求②】合并行里**每个关键词一行词块**：图只铺一遍，但"哪个词命中了什么"
         * 一条都不能丢。单条组（绝大多数）行为与合并前完全一致（不加归属小标）。 */
        for (const mem of g.items) {
        const words = hitWords(mem);
        if (!words.length) continue;
          const chips = doc.createElement('div');
          chips.className = 'khin-imgchips';
          if (g.items.length > 1) {
            const owner = doc.createElement('span');
            owner.className = 'khin-imgchipkw';
            owner.textContent = (mem.keyword || '') + (mem.label ? '（' + mem.label + '）' : '');
            owner.title = owner.textContent;
            chips.appendChild(owner);
          }
          for (const w of words) {
            const chip = doc.createElement('span');
            chip.className = 'khin-imgchip';
            chip.textContent = w;
            chip.title = KH.OcrCopy.VIEW.copySentence;
            /* 稳定键（T63）：列表每次重建都把 chip 整批换新，靠它把这颗认回来、把反馈重放上去。
             * 用条目已有的 key（img-ocr.js 的 `ruleId|src`，面板别处也用它）+ 命中词 ——
             * **不许**用条目下标（条目对象上没有 idx，写 `it.idx` 恒为 undefined，两张图里的同一个词
             * 会互相点亮），也不许只用命中词（两个条目里的同一个词会串台）。 */
            const copyKey = String(mem.key || '') + '|' + w;
            chip.dataset.k = copyKey;
            /* 重建重放（T63）：命中同一键且这笔反馈还在窗口内 ⇒ 当场补上 —— 否则整段重建会把屏幕上
             * 的绿框吃掉（真机 ms≈94–330 就重建，绿框约 1/4 秒就没了）。 */
            const mark = this.imgCopyMark;
            if (mark && mark.key === copyKey && Date.now() - mark.at < IMG_COPY_MS) {
              this.imgApplyCopyMark(chip, mark.ok);
            }
            /* 可用键盘操作（Tab 进来、Enter/空格触发）——它是个按钮，不是装饰 */
            chip.setAttribute('role', 'button');
            chip.setAttribute('tabindex', '0');
            const copySentence = () => {
              /* 【为什么标记与点亮都挪到 resolve 之前】2.0.2.2 全量真机首跑 1 红（读数
               * `{"onNode":"copied","inShadowRoot":"none","connected":false}`）：点击后、剪贴板写入
               * resolve 之前若刚好发生一次面板重建，旧写法把标记与类都写到**闭包里那颗已经游离的**
               * chip 上 —— 屏上那颗既没被重放（重建发生时尚无标记）也再没人点亮，绿框整段丢失。
               * 现在当帧先乐观点亮 + 落标记：此后任何一次重建都能靠标记重放回来；真结果回来若失败，
               * 再按稳定键把**活着**的那颗就地改红（at 不变 ⇒ 复位定时器仍只排一个，到点照旧全清）。
               * 定位不到整句（原文里没这个词 / 没有任何句末标点）就退回命中词本身 —— 不猜。 */
              const at = Date.now();
              this.imgCopyMark = { key: copyKey, ok: true, at: at };
              this.imgApplyCopyMark(chip, true);
              setTimeout(() => this.imgClearCopyMark(copyKey, at), IMG_COPY_MS);
              copyToClipboard(KH.OcrCopy.sentenceOf(mem.text, w) || w, this.root).then((ok) => {
                if (ok) return;
                /* 还是这一笔才改判（晚到的旧 promise 不许把刚点的那一笔改成红的） */
                const m = this.imgCopyMark;
                if (m && m.key === copyKey && m.at === at) this.imgCopyMark = { key: copyKey, ok: false, at: at };
                this.imgApplyCopyMarkByKey(copyKey, false);
              });
            };
            chip.addEventListener('click', (e) => {
              e.stopPropagation();
              copySentence();
            });
            chip.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); copySentence(); }
            });
            chips.appendChild(chip);
          }
          meta.appendChild(chips);
        }

        /* ★ 别漏这一行：一张卡片行 = 缩略图 + 文本块（文本块里才有 tag/耗时/命中词块）。
         * 实测踩过：加「📋 复制识别文本」时把这一行弄丢了 → 行里没有 tag →
         * 「图片文字识别」那条 e2e 的等待条件（两个 tag 都不是"识别中"）永远不成立 → 91s 超时。 */
        row.appendChild(meta);
        this.imgListEl.appendChild(row);
      }
    },

    /**
     * 给 chip 点亮 / 熄灭这一次复制反馈（T63）：**只有这一处**写这两个类与 title ——
     * 建 chip 时的重放与点击当场都走它，两条通路的口径不会各自漂移。
     *
     * 复制失败要就地红一下（T29 / F3.1）：原来只有 title 换了句字，那得悬停才看得见，而用户点完
     * 鼠标早移开了。剪贴板不可用（非 https / 无焦点）是最常见的失败，必须一眼看出没复制上；
     * 与 copied 共用同一次 IMG_COPY_MS 复位，文案仍是真源里的 VIEW.copyFailed。
     */
    imgApplyCopyMark(chip, ok) {
      chip.classList.toggle('copied', ok);
      chip.classList.toggle('failed', !ok);
      chip.title = ok ? KH.OcrCopy.VIEW.copySentDone : KH.OcrCopy.VIEW.copyFailed;
    },

    /**
     * 按稳定键把反馈打到**当前活着**的那颗 chip 上。
     * 为什么需要它：列表每次重建都整批换新，闭包/参数里那颗可能早就游离了 —— 直接往上写类，
     * 屏幕上什么都不会发生（2.0.2.2 真机那条缺陷就是这个形状）。所以一律按 `dataset.k` 重找。
     */
    eachLiveChip(key, fn) {
      const live = this.imgListEl ? this.imgListEl.querySelectorAll('.khin-imgchip') : [];
      for (const chip of live) {
        if (chip.dataset.k !== key) continue;
        fn(chip);
      }
    },

    imgApplyCopyMarkByKey(key, ok) {
      this.eachLiveChip(key, (chip) => this.imgApplyCopyMark(chip, ok));
    },

    /**
     * 复制反馈窗口到点复位（T63）。两步分开做：
     *  ① 标记：只清「还是这一笔」（key 与 at 都对得上）—— 晚到的旧定时器不许清掉刚点的那一笔；
     *  ② 屏幕：在**活着的**列表里按稳定键把当前那颗 chip 找回来复位。闭包里那颗早就游离了
     *     （列表每次重建都整批换新），所以必须重找。
     * **不**用命中词拼 CSS 选择器：关键词是用户输入，含引号/方括号会当场抛错。
     */
    imgClearCopyMark(key, at) {
      const mark = this.imgCopyMark;
      if (mark && mark.key === key && mark.at === at) this.imgCopyMark = { key: '', ok: false, at: 0 };
      this.eachLiveChip(key, (chip) => {
        chip.classList.remove('copied');
        chip.classList.remove('failed');
        chip.title = KH.OcrCopy.VIEW.copySentence;
      });
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

    /**
     * 标签区就地重画（展开/收起/选条都走这里，**绝不走 refresh()/render()**）。
     * 为什么必须就地：`head.changed()` 在 entries 未变时判"不脏" ⇒ render() 整个空转、
     * 界面不更新（render 里的 dirty 判定），所以这里只重画这一个容器。
     * 只负责画；点击委托在 renderItems 里挂一次（每次点都读实时状态，不吃闭包快照）。
     */
    renderTags(tagsEl, item) {
      const entries = (item && item.entries) || [];
      const list = head.tagEntries(entries);
      const picked = this.pickedTags.get(item.note);
      const open = this.expandedTags.has(item.note);
      tagsEl.innerHTML = head.tagHtml(entries, picked);
      if (open) tagsEl.insertAdjacentHTML('beforeend', head.tagListHtml(entries));
      const more = tagsEl.querySelector('[data-kh-tag-more]');
      if (more) {
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
        /* 悬停说明走 DOM 属性，不进字符串层（文案真源在 KH.OcrCopy.VIEW） */
        more.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.moreHits, { n: list.length });
        /* 交互定位一律**直接绑元素**，不用 closest 反查（meta-check 红线：closest 里出现 kh- 一律拒收）。
         * 元素每次重画都是新的 ⇒ 监听器随之重建：既不会叠加，也不会吃到旧的展开态快照。 */
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.expandedTags.has(item.note)) this.expandedTags.delete(item.note);
          else this.expandedTags.add(item.note);
          this.renderTags(tagsEl, item);
        });
      }
      /* 完整命中文本只在这里落到 DOM 属性上 —— escText 不转义引号，拼进 HTML 属性就是注入面 */
      const items = tagsEl.querySelectorAll('.khin-tag-item');
      for (let i = 0; i < items.length; i++) {
        if (!list[i]) continue;
        items[i].title = list[i].kw;
        if (i === picked) items[i].className += ' khin-tag-on';
        /* 下拉条目原来只有 click —— 能展开、选不了（T29 / F4.3）。role/tabindex 写在
         * 展开后的那段 HTML 串里（见 tagListHtml），键盘激活的绑定与 click 共用同一处。 */
        const pickOne = (e) => {
          e.stopPropagation();
          this.pickedTags.set(item.note, i);
          this.renderTags(tagsEl, item);
        };
        items[i].addEventListener('click', pickOne);
        items[i].addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickOne(e); }
        });
      }
    },

    /**
     * 右键识别的那些图（2.0.2.13 · 用户 m03971）。
     *
     * 为什么单列一张卡：右键识别**不属于任何规则**（`ruleId` 是 `@ctxmenu`），它没有命中词、
     * 没有抓取字段，所以永远进不了笔记卡片。以前只活在「🖼 图片」分区里 —— 用户点了右键，
     * 结果掉到面板底部一个附属区，看着像"没发生"。现在把这几张图当成一张卡片表格放回主模块。
     * 只认有 `src` 的条目（读不到地址的图放不进 <img>，留在图片分区里带原因，不静默丢）。
     */
    ctxItems() {
      return (this.imgItems || []).filter((it) => it && it.via === 'contextMenu' && absSrc(it && it.src));
    },

    /**
     * 右键识别 → 一张卡片表格（用户 m03971 原话：*「作为一个卡片的表格展示，表头（左格内容）
     * 固定是截图，不管右键 ocr 了多少个图片，都放在表头右侧一个单元格内」*）。
     *
     * 于是不管几张图，永远是**一行两格**：左格写死「截图」（文案真源 `KH.OcrCopy.VIEW.ctxShotLabel`），
     * 右格把所有图并排塞进去（`.khin-ctx-cell` 是 flex-wrap，图多了往下折行 —— 但仍是同一个单元格）。
     * 一张都没有 ⇒ 返回 `null`，主模块不多出一条空卡。
     *
     * 图直接用 `<img>`：点击走宿主上那条**现有**的 IMG 委托（`root.addEventListener('click')`），
     * 灯箱会把同一个 `td` 里的图拼成相册、并带上各自的 OCR 全文与命中词 —— 不必另写一套。
     */
    ctxCard(doc) {
      const list = this.ctxItems();
      if (!list.length) return null;
      const el = doc.createElement('div');
      el.className = 'khin-item khin-item-ctx';
      const noteEl = doc.createElement('div');
      noteEl.className = 'khin-item-note';

      const table = doc.createElement('table');
      table.className = 'kh-table kh-table-fetch';
      const tr = doc.createElement('tr');
      const th = doc.createElement('td');
      th.className = 'kh-table-label';
      const label = KH.OcrCopy.VIEW.ctxShotLabel;
      const lbt = doc.createElement('span');
      lbt.className = 'kh-lbt';
      lbt.textContent = label;
      lbt.title = label;
      th.appendChild(lbt);
      const td = doc.createElement('td');
      td.className = 'khin-ctx-cell';

      const seen = new Set();
      let drawn = 0;
      for (const it of list) {
        const src = absSrc(it.src);
        if (!src || seen.has(src)) continue;      // 同一张图多条条目只画一次（相册里同理）
        seen.add(src);
        const im = doc.createElement('img');
        im.setAttribute('src', it.src);           // 原串进 DOM：相对地址交给浏览器解析，与抓取表格一致
        im.setAttribute('alt', String(it.label || ''));
        im.setAttribute('loading', 'lazy');
        td.appendChild(im);
        drawn++;
      }
      if (!drawn) return null;
      tr.appendChild(th);
      tr.appendChild(td);
      table.appendChild(tr);
      noteEl.appendChild(table);
      el.appendChild(noteEl);
      return el;
    },

    /* 只重建右键那张「截图」卡：OCR 结果异步回来时用它补一块，标签区与已有卡片原地不动
     * （整块 `renderItems()` 重跑会把用户正在看的标签/滚动位置一起丢掉）。 */
    renderCtxCard() {
      if (!this.bodyEl) return;
      if (this.ctxEl && this.ctxEl.parentNode) this.ctxEl.parentNode.removeChild(this.ctxEl);
      this.ctxEl = this.ctxCard(document);
      if (this.ctxEl) this.bodyEl.insertBefore(this.ctxEl, this.bodyEl.firstChild || null);
      this.bodyEl.hidden = !(this.items.length || this.ctxEl);
    },

    renderItems() {
      if (!this.bodyEl) return;
      const doc = document;
      this.bodyEl.textContent = '';
      this.ctxEl = this.ctxCard(doc);
      if (this.ctxEl) this.bodyEl.appendChild(this.ctxEl);
      for (const item of this.items) {
        const el = doc.createElement('div');
        el.className = 'khin-item';
        if (item.imgSize) el.style.setProperty('--kh-img-size', item.imgSize + 'px');
        /* 词级正文字号（2.0.2.2 需求 2）：卡级内联 `--kh-note-fs` 盖掉宿主级那个全局字号。
         * 该变量由 `.khin-item-note`（笔记正文）与抓取字段表格统一消费，所以写在这一层就能同时管住两者。 */
        if (item.noteFontSize) el.style.setProperty('--kh-note-fs', item.noteFontSize + 'px');
        // 「复用高亮底色」：铺该词实际底色（分组色 > 词色 > 全局默认）；空串不铺
        if (/^#[0-9a-fA-F]{3,8}$/.test(item.bg || '')) el.style.background = item.bg;

        const headEl = doc.createElement('div');
        headEl.className = 'khin-item-head';
        const tagsEl = doc.createElement('div');
        tagsEl.className = 'khin-item-tags';
        this.renderTags(tagsEl, item);
        const closeBtn = doc.createElement('button');
        closeBtn.className = 'khin-item-close';
        closeBtn.title = KH.OcrCopy.VIEW.removeTip;   // 文案真源（T29 / F1.2）
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
     * 这类表格是本插件自己生成的**可信结构**，必须原样插入而不是当 Markdown 文本转义掉；
     * 因此先把表格片段摘出来，其余按 Markdown 渲染，最后按原顺序拼回。
     */
    noteFragment(doc, note) {
      const frag = doc.createDocumentFragment();
      const src = String(note == null ? '' : note);
      // 兼容不带 `kh-table-fetch` 标记的旧串（历史数据 / 已缓存的笔记内容），两种都认
      // `check` 分支只为**旧笔记**保留（2.0.2.2 生成的核对结论表还留在用户已存的笔记里，
      // 丢了它会被当纯文本原样吐出来、标签可见）；2.0.2.4 起不再生成该类表格。
      const re = /<table class="kh-table(?: kh-table-(?:fetch|check))?">[\s\S]*?<\/table>/g;
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
        /* 字段标题格补一层 .kh-lbt：抓取表格是**存进笔记**的 HTML，历史笔记里没有这层包裹，
         * 只改生成侧等于只对新笔记生效。这里就地补（幂等：已包裹的不重复包），
         * 「标题可截断、内容不截断」才对**所有**笔记一致（见 STYLE 里 .kh-lbt 的说明）。 */
        for (const td of tmp.querySelectorAll('td.kh-table-label')) {
          const first = td.firstElementChild;
          if (first && first.className === 'kh-lbt') continue;
          /* 【2.0.2.4 需求④】字段名格现在可能是「名字 + 后缀徽标」两段：徽标**不许**进 .kh-lbt
           * （那层 max-height:1.5em + max-width:8em 会把后缀裁掉），所以先把它摘出来、包完再搬回。
           * 名字只取"除徽标以外"的子节点文本 —— 老笔记（没有徽标）走这条也逐字不变。 */
          const suf = td.querySelector('.kh-table-suffix');
          let txt = '';
          for (const n of Array.prototype.slice.call(td.childNodes)) {
            if (n.nodeType === 1 && n.className === 'kh-table-suffix') continue;
            txt += (n.textContent || '');
          }
          const span = doc.createElement('span');
          span.className = 'kh-lbt';
          span.title = txt;            // 全文在悬停里可读回，截断只发生在视觉上
          span.textContent = txt;
          td.textContent = '';
          td.appendChild(span);
          if (suf) td.appendChild(suf);
        }
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
      /* 置顶签名随面板一起清：下次 render 从干净态重建，别拿上一站（另一个页面/另一次启动）的
       * 置顶表去比"顺序变没变"。 */
      this.pinSig = '';
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
    KH.ImgOcr.onChange(() => {
      panel.renderImg();
      /* 右键识别的结果同样走这条路回来，而那张「截图」卡是卡片区的一部分 —— 不跟着重建
       * 就永远只在下次页面变动时才出现（2.0.2.13 真机验证抓到）。只重建这一张，不动整块。 */
      panel.renderCtxCard();
    });
  }

  /* `paintHits` 直接导出给单测：灯箱要在垫片里走完 openLightbox 那条路成本太高（宿主/影子根/
   * 相册/停靠都在里面），而这个函数是纯 DOM 构造，喂文本就能验。 */
  KH.ImportantNote = { panel, head, collectEffective, IMG_PROTOCOL_OK, paintHits };
})();
