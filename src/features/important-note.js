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
     * 加一层红色边框"）—— 这是"这张图里有你要的词"的唯一视觉提示（2.0.2.15 起也是**唯一**的图片
     * 命中显示面：底部那个「🖼 图片」分区已随右键识别折进主模块一并删除）。
     * 用 outline 而不是 border：outline 不参与布局，图不会被挤动一格（点开大图还能看原文里标出来的词）。 */
    .khin-item-note img.khin-imghit { outline: 2px solid #ef4444; outline-offset: 1px; }
    /* 【2.0.6.1 需求⑧】图片 OCR 边框三态（用户原话：识别中蓝、命中红、没命中绿）。
     * 仍是 outline（不参与布局、不挤动图）：蓝=排队/识别中，绿=已识别但没命中（含识别失败，
     * 失败原因走 title，不另占一态）。 */
    .khin-item-note img.khin-imgbusy { outline: 2px solid #3b82f6; outline-offset: 1px; }
    .khin-item-note img.khin-imgmiss { outline: 2px solid #22c55e; outline-offset: 1px; }
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
    /* 【2.0.6.1 需求⑥】同值字段合并后的抬头：只写最短那个名字，后面跟一个「共 N 个」的小标，
     * 点开（原生 details 元素，无需 JS）列出全部字段名。老笔记里没有它，就照旧只显示 .kh-lbt。 */
    .kh-table .kh-table-more { display: inline-block; margin-left: 3px; vertical-align: bottom; }
    .kh-table .kh-table-more > summary {
      display: inline-block; cursor: pointer; list-style: none; font-weight: 400; font-size: 9px;
      line-height: 1.6; padding: 0 4px; border-radius: 7px;
      color: var(--kh-brand, #2563eb); background: var(--kh-bg, #fff);
      border: 1px solid var(--kh-brand-soft, #eaf1fb);
    }
    .kh-table .kh-table-more > summary::-webkit-details-marker { display: none; }
    .kh-table .kh-table-all {
      margin-top: 2px; font-weight: 400; font-size: 10px; line-height: 1.5;
      color: var(--kh-text-2, #475569); white-space: normal;
    }
    /* 【2.0.2.17 需求①】字段名格不再带后缀（#图3 / @2 / ! / ^锚文本 / %4 都留在设置页）⇒
       原来给徽标用的那层样式只剩右键「截图」卡的状态小字（识别中…／识别失败）还在用，
       所以把它改名成它真正的用途，免得以后有人以为字段名还带徽标。 */
    .kh-table .khin-ctxstate {
      margin-left: 4px; font-weight: 400; font-size: 9px; line-height: 1.5;
      color: var(--kh-text-3, #94a3b8); white-space: nowrap;
    }
  `;

  /** 图片协议白名单（与内容脚本 sanitize 同口径：仅 http(s)） */
  const IMG_PROTOCOL_OK = /^https?:\/\//i;

  /** 灯箱允许的图片来源：http(s) 之外还允许 `data:image/*`
   *  —— v1.52 起"抓取到的图片"就可能是内嵌的 data URI（旧版注释写着"data: 内嵌图无需跳转"），
   *  它本身就是原图数据，在灯箱里显示是安全的（`<img src>` 不执行脚本）。 */
  const LIGHTBOX_SRC_OK = /^(https?:\/\/|data:image\/)/i;

  /**
   * 【2.0.6.1 需求③⑧】「已识别但没命中」要用**人话**说清卡在哪一步：旧实现只把它当"没命中"，
   * 用户看不出是「动态判据的值图上没有」还是「点名的字段根本没取到值」还是「图里压根没字」。
   * @param {object} it OCR 条目（`ImgOcr.items()` 的一项）
   * @returns {string} 空串 = 命中或无需解释
   */
  function missReason(it) {
    const V = (KH.OcrCopy && KH.OcrCopy.VIEW) || {};
    const R = (tpl, vars) => (tpl ? KH.OcrCopy.render(tpl, vars || {}) : '');
    const miss = (it && Array.isArray(it.needMissing)) ? it.needMissing : [];
    const gone = (it && Array.isArray(it.needMissingValues)) ? it.needMissingValues : [];
    if (miss.length) return (V.imgMissField || '') + '：' + miss.join('、');
    if (gone.length) return (V.imgMissValue || '') + '：' + gone.join('、');
    if (!String((it && it.text) || '').trim()) return V.imgMissEmpty || '';
    return '';
  }

  /* 【2.0.6.1 需求⑧】图片 OCR 边框三态（蓝=识别中 / 红=命中 / 绿=无命中）。 */
  const IMG_MARK_CLS = ['khin-imghit', 'khin-imgbusy', 'khin-imgmiss'];
  /** 同一张图多条条目时的取舍顺序：命中 > done > fail > pending/idle */
  function rankOf(it) {
    const st = String((it && it.state) || '');
    const hit = hitWords(it).length ? 100 : 0;
    return hit + (st === 'done' ? 10 : st === 'fail' ? 5 : st === 'pending' ? 2 : 1);
  }

  /** 给一张图挂状态框（三态 + 悬停说明）；`it` 为空就只清状态 */
  function markOneImg(im, it) {
    if (!im || !im.classList) return;
    for (let i = 0; i < IMG_MARK_CLS.length; i++) im.classList.remove(IMG_MARK_CLS[i]);
    if (!it) {
      if (im.removeAttribute) im.removeAttribute('title');
      return;
    }
    const V = (KH.OcrCopy && KH.OcrCopy.VIEW) || {};
    const st = String(it.state || '');
    const words = hitWords(it);
    if (st === 'done' && words.length) {
      im.classList.add('khin-imghit');
      im.title = KH.OcrCopy.render(KH.OcrCopy.VIEW.imgHitTip, { matched: words.join('、') });
      return;
    }
    if (st === 'done' || st === 'fail') {
      im.classList.add('khin-imgmiss');
      const why = st === 'fail' ? (V.imgFailTip || '') : missReason(it);
      im.title = (V.imgMissTip || '') + (why ? '（' + why + '）' : '');
      return;
    }
    im.classList.add('khin-imgbusy');
    im.title = V.imgBusyTip || '';
  }

  /**
   * 【2.0.6.1 需求④】卡片重建时把旧卡里已经解码好的 `<img>` 搬过来（按 `src` 配对）。
   * 见 `renderItems` 的调用点：正文一变就要重建那张卡，但图常常一字未变，换新就会重新解码 ——
   * 用户看到的「闪一下」多半来自这里。
   */
  function carryImgs(from, to) {
    if (!from || !from.querySelectorAll || !to.querySelectorAll) return;
    const olds = new Map();
    const srcs = from.querySelectorAll('img');
    for (let k = 0; k < srcs.length; k++) {
      const s0 = srcs[k].getAttribute('src') || '';
      if (s0 && !olds.has(s0)) olds.set(s0, srcs[k]);
    }
    if (!olds.size) return;
    const news = Array.prototype.slice.call(to.querySelectorAll('img'));
    for (const im of news) {
      const s0 = im.getAttribute('src') || '';
      const old = s0 && olds.get(s0);
      if (!old) continue;
      olds.delete(s0);                       // 同一张旧图只搬一次（一个格子里同图可能出现两次）
      if (im.parentNode) im.parentNode.replaceChild(old, im);
    }
  }

  /**
   * 把 OCR 状态标到卡片里那些图上（抽成函数：面板重建与识别结果回来都要走同一份判据）。
   * @param {Element} bodyEl 卡片的正文容器
   * @param {Array} imgItems `ImgOcr.items()`
   */
  function applyImgMarksTo(bodyEl, imgItems) {
    if (!bodyEl || typeof bodyEl.querySelectorAll !== 'function') return;
    const at = new Map();
    for (const it of (imgItems || [])) {
      const s = absSrc(it && it.src);
      if (!s) continue;
      const prev = at.get(s);
      if (!prev || rankOf(it) > rankOf(prev)) at.set(s, it);
    }
    for (const im of bodyEl.querySelectorAll('img')) {
      const s = absSrc(im.currentSrc || im.getAttribute('src') || im.src);
      markOneImg(im, s ? (at.get(s) || null) : null);
    }
  }

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
   * 【2.0.2.19 需求②⑤】这张图的 OCR 行有没有"列结构"（表格 / 横排两栏）。
   * 有 ⇒ 返回列带模型，`null` ⇒ 按纯文本渲染（旧行为）。
   * 分析在 `KH.ImgOcr.layout`（纯函数，吃 `linesOf` 的坐标），这里只做容错与"值不值得排表"的把关。
   * @param {string} src 图片地址（与 `textOf` 同键）
   */
  function ocrLayoutOf(src) {
    if (!src || !KH.ImgOcr || typeof KH.ImgOcr.linesOf !== 'function') return null;
    try {
      const lay = KH.ImgOcr.layout(KH.ImgOcr.linesOf(src));
      return (lay && lay.cols >= 2 && lay.rows && lay.rows.length) ? lay : null;
    } catch (e) { return null; }
  }

  /**
   * 把列带模型画进容器，命中词照样标红（复用 `paintHits` 的**建节点**写法，不用 innerHTML 拼原文）。
   * 表格 HTML 本身来自 `KH.ImgOcr.layoutHtml`（逐格转义过），所以这里可以安全 `innerHTML`。
   * @returns {boolean} true = 画成了表格；false = 调用方该走纯文本
   */
  function paintOcrTable(el, lay, words) {
    if (!el || !lay || !KH.ImgOcr || typeof KH.ImgOcr.layoutHtml !== 'function') return false;
    const html = KH.ImgOcr.layoutHtml(lay);
    if (!html) return false;
    el.innerHTML = html;
    const tds = el.querySelectorAll('td');
    for (let i = 0; i < tds.length; i++) paintHits(tds[i], tds[i].textContent, words);
    return true;
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
    /* 【2.0.2.19 需求②⑤】OCR 全文排成表格时（图里是表格 / 横排两栏）。
     * 容器是 white-space: pre-wrap 的，表格必须自己把空白规则收回去 —— 否则单元格里的
     * 缩进会被原样放大，列宽全被空格吃掉。 */
    .kh-ocr-table {
      border-collapse: collapse; white-space: normal; width: 100%;
      font-size: 12.5px; line-height: 1.6;
    }
    .kh-ocr-table td {
      padding: 1px 8px 1px 0; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.10);
    }
    .kh-ocr-table tr:last-child td { border-bottom: 0; }
    .kh-ocr-table td.kh-ocr-wide { padding-right: 0; color: rgba(255,255,255,.92); }
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
        /* 全文优先取**实时**那份（`KH.ImgOcr.textOf` 会读缓存/条目），相册条目自带的 `cur.text`
         * 只是打开灯箱那一刻的快照 —— 右键识别的那张图，结果常常是灯箱已经开着才回来。 */
        const cachedText = (KH.ImgOcr && typeof KH.ImgOcr.textOf === 'function')
          ? KH.ImgOcr.textOf(cur && cur.src) : '';
        const full = String(cachedText || (cur && cur.text) || '');
        curText = full;                     /* 一键复制的唯一数据源（服务端 OCR 原文，不读屏幕文字） */
        side.hidden = !full || sideHidden;
        /* 默认停靠（需求 4）只对"还没被拖过"的这一档生效：拖动过之后位置由 host._sidePos 说了算。
         * apply() 也会被翻页/缩放/换图回调触发，不能每次都把用户摆好的位置推回默认位。 */
        if (!side.hidden && !host._sideMoved) dockSide();
        /* 【2.0.2.7 用户 m00292】原文里把命中词标出来（`paintHits` 只建文本节点，原文一字不动，
         * 命中的那几段套上 `<mark class="kh-lb-hit">`）—— 命中词在 OCR 条目上（`hitWords`），
         * 由开灯箱那一处随相册条目一起带进来。 */
        /* 【2.0.2.19 需求②⑤】图里本身是表格（同一物理行多个格子）或横排两栏时，排成表格比一整段
         * 纯文本更好读（用户口径：软著横排 ⇒ 左右两个单元格；图里表格 ⇒ 表格形式）。排不出来
         * （专栏 < 2）就退回老样子 —— 一字不变，零回归。`curText` 仍是纯文本，复制不受影响。 */
        if (!paintOcrTable(sideText, ocrLayoutOf(cur && cur.src), (cur && cur.hits) || [])) {
          paintHits(sideText, full, (cur && cur.hits) || []);
        }
        sideLines.textContent = full ? KH.OcrCopy.render(KH.OcrCopy.VIEW.paneLines, { n: full.split(/\r?\n/).length }) : '';
        sideCopy.hidden = !full;            /* 没有 OCR 文本 ⇒ 按钮不出现（不是置灰） */
        box.classList.toggle('kh-lb-has-side', !!full);
        /* 【2.0.2.15 需求①】这枚按钮**常驻**（位置就是原来「隐藏/显示全文」那一个）：
         *   · 有识别文本 ⇒ 「隐藏全文 / 显示全文」（老行为，一字不变）；
         *   · 还没识别 ⇒ 「OCR 识别」，点了就地认这张图；认完 apply() 自然把它换成「隐藏全文」，
         *     右侧全文栏随之出现 —— 不用另开一条 UI 通路。
         * 识别中置灰并显示"识别中…"；失败退回「OCR 识别」可再点，错误原因挂 title。
         * 文案一律取自真源 KH.OcrCopy.VIEW（灯箱不许自己写中文）。 */
        sideBtn.hidden = false;
        sideBtn.disabled = !!(cur && cur.busy);
        sideBtn.textContent = full
          ? (sideHidden ? KH.OcrCopy.VIEW.paneShow : KH.OcrCopy.VIEW.paneHide)
          : ((cur && cur.busy) ? KH.OcrCopy.VIEW.paneOcrBusy : KH.OcrCopy.VIEW.paneOcr);
        sideBtn.title = full
          ? (sideHidden ? KH.OcrCopy.VIEW.paneShow : KH.OcrCopy.VIEW.paneHide)
          : ((cur && cur.ocrError) || KH.OcrCopy.VIEW.paneOcrTip);
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
      /* 同一枚按钮两种活（2.0.2.15 需求①）：有文本 ⇒ 隐藏/显示全文；没文本 ⇒ 就地 OCR 这张图。
       * 用 on() 包装 —— 它做 preventDefault + stopPropagation，否则这次点击会继续冒泡给 box 的关闭判定。 */
      on(sideBtn, () => {
        const g = host._gallery || [];
        const cur = g[host._idx || 0];
        /* 判据用 `curText`（apply() 刚算出来的**实时**全文），不是 `cur.text`：
         * 右键识别的那张图，文本是灯箱开着时由缓存补进来的，条目自带的 `cur.text` 还是空快照 ——
         * 拿 `cur.text` 判会把它当成"还没识别"，于是点眼睛按钮又去识别一遍，收起/展开就失灵了。 */
        if (curText) { sideHidden = !sideHidden; apply(); return; }
        if (!cur || cur.busy) return;
        if (!KH.ImgOcr || typeof KH.ImgOcr.ocrOne !== 'function') return;
        cur.busy = true;
        cur.ocrError = '';
        sideHidden = false;                  // 认出来就直接看全文（用户点这枚按钮要的就是这个结果）
        apply();
        KH.ImgOcr.ocrOne(cur.src).then((text) => {
          cur.busy = false;
          cur.text = String(text || '');
          apply();
        }, (err) => {
          cur.busy = false;
          cur.ocrError = String((err && err.message) || KH.OcrCopy.VIEW.paneOcrFail);
          apply();
        });
      });
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
        /* `→ 后半截` 只在**和前半截不是同一个词**时才显示（2.0.2.17 需求④）。
         * 典型就是「仅抓取」：没有核心词，`combo.js` 的 `display` 只能退回标签词
         * （`core.trim() || label`），于是标签渲染成「🔖 标题 → 标题」—— 同一句话写两遍，
         * 白占一行宽度。判据用"两段相等"而不是 `meta.fetchOnly`：任何模式只要前后重复就不显示。 */
        let adj = String(h.meta.label || '').trim();
        if (adj === kw) adj = '';
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
    /* 【2.0.4 需求④】卡片复用缓存（见 `renderItems`）：上一轮每张卡对应的**正文串**。
     * 正文没变的卡留用原元素（连里面的 `<img>` 一起），只重画标签区；
     * 旧版每次 `textContent=''` 整块重建 ⇒ 图重新解码、滚动位置归零 = 用户看到的"闪"。 */
    cardNotes: [],
    cardEls: [],
    /* 右键「截图」卡的内容签名（见 `renderCtxCard`）：OCR 状态每变一次都会调它，
     * 签名没变就不拆不建，省掉一次 `<img>` 重载。 */
    ctxSigCache: null,
    /* 📝 笔记区收起（2026-10-11 用户：笔记很长时把空间让给别的部分）。
     * 只翻转标记，用户收起就保持收起 —— 它是用户对视图的选择，不该被下一批结果自动弹开。 */
    noteCollapsed: false,
    ignored: new Set(),  // 本次页面会话内已被用户关闭的笔记（按 note 文本）
    /* 标签下拉的展开态 / 选中的命中序号（均按 note 文本挂**面板侧**）。
     * 不许挂 head：标签区每次重建（head.changed() 判脏 → renderContent() → renderItems()），
     * 挂在 head 上会被重置，展开中的下拉会自己合上。 */
    expandedTags: new Set(),
    pickedTags: new Map(),
    /* ---- 图片识别结果（KH.ImgOcr）----
     * 2.0.2.15 起只服务两件事：右键识别的图进主模块那张「截图」卡；命中的图在卡片上加红框。
     * 底部那个「🖼 图片」分区（折叠/显示全部/命中词块/复制反馈）已整体删除 —— 用户口径：
     * 右键结果已经立刻出现在主模块里，图片分区就是同一个东西的第二份展示面。 */
    imgItems: [],
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
          /* 条目没有文本时再问一次缓存（2.0.2.15 需求①：在大图里认过的图，下次打开还得看得见全文） */
          const cachedText = (KH.ImgOcr && typeof KH.ImgOcr.textOf === 'function') ? KH.ImgOcr.textOf(s) : '';
          list.push({ src: s, alt: im.getAttribute('alt') || '',
            text: textBySrc.get(k) || cachedText || '', hits: hitsBySrc.get(k) || [] });
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

    /* 【2.0.4 需求④】`metrics` 可选：拖动时由 `startDrag` 把**按下那一刻**量到的尺寸传进来，
     * 每帧不再 `getBoundingClientRect()` —— 那是"写样式→读布局"的强制同步刷新，
     * pointermove 每次都做一遍就是用户说的"拖着不跟手"（帧率被布局卡住，指针位置追不上手指）。
     * 拖动期间面板尺寸不会变（内容没动），沿用按下时那一次量值完全等价。 */
    applyPosition(metrics) {
      if (!this.root) return;
      /* 一次 rect 读，横纵共用（省一次强制布局）。
       * 水平钳位用**面板实测宽度**：原来写死 360，与 `.khin-panel { width }` 成了两处真源 ——
       * 改 CSS 后钳位不跟着动；用户自己 `resize: both` 拉宽后更会算出错的 maxLeft（拖到右侧越界）。
       * 量不到时（hidden ⇒ display:none ⇒ width 0）钳位自然失效，此时面板不可见，无需钳位。 */
      const rect = metrics || this.root.getBoundingClientRect();
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
      /* 【2.0.4 需求④】尺寸在按下时量一次，拖动全程复用（见 applyPosition 的说明）。 */
      const metrics = { width: rect.width, height: rect.height };
      this.dragState = state;
      /* 【2.0.6.1 需求④】指针事件比屏幕刷新快（一次 pointermove 一批，一帧能来好几个），
       * 每个都写一遍 left/top 等于让浏览器同帧反复重排面板 —— 手感上就是"拖着发涩"。
       * 这里只记最后一次坐标，真正落盘交给一帧一次（rAF）；抬手时同步 flush 一帧，
       * 保证松手那一刻停在指针位置。没有 rAF 的环境（单测垫片）退化成同步写。 */
      let rafId = 0;
      let pending = null;
      const flush = () => {
        rafId = 0;
        if (!pending || !this.dragState) return;
        const p = pending;
        pending = null;
        this.pos.left = state.startLeft + (p.x - state.startX);
        this.pos.top = state.startTop + (p.y - state.startY);
        this.applyPosition(metrics);
      };
      const move = (ev) => {
        if (!this.dragState) return;
        /* 挪过 3px 才算"拖"：FAB 同时是按钮，拖着挪位置时末尾也会补一个 click ——
         * 不区分就会"拖完面板自己弹开"（原来只绑 dblclick，正是为了躲这个）。 */
        if (Math.abs(ev.clientX - state.startX) + Math.abs(ev.clientY - state.startY) > 3) state.moved = true;
        pending = { x: ev.clientX, y: ev.clientY };
        if (rafId) return;
        if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(flush) || 0;
        if (!rafId) flush();
      };
      const up = () => {
        /* 抬手先把最后一帧落下去，再拆监听：否则松手瞬间的位置会被丢掉（停在上一帧）。 */
        if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        flush();
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

      /* 右键识别的图与重要笔记**共用这块面板**（用户 m03971：右键结果作为一张「截图」卡放进主模块）；
       * 但两者独立：一个笔记都没有、只有右键识别的图时，面板照样要出现。 */
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];

      /* 置顶排序（2.0.2.5 需求④）：配置 → 关键词表 → 命中的卡片稳定地抽到最前。
       * 必须排在**脏判据之前**算：`head.changed` 比的是"每张卡的内容"（note/底色/字号/词条集合），
       * 卡间顺序变了它照样返回 false ⇒ 顺序变没变得靠 `pinSig` 自己认，
       * 否则用户改了「置顶排序」，`render` 会走 else 只刷卡片上的红框与「截图」卡，屏上不重排。
       * 空表时 `sorted` 就是原数组、`pinSig` 为空串 ⇒ 与旧版逐字节一致（不多一次拷贝、不多一次重建）。 */
      const pins = head.parsePins(cfg);
      const pinSig = pins.join('\u0001');
      const pinChanged = this.pinSig !== pinSig;
      this.pinSig = pinSig;
      const sorted = pins.length ? head.sortByPins(items, pins) : items;

      if (!sorted.length && !this.ctxItems().length) {
        this.items = sorted;
        this.hide();
        return;
      }
      /* 外壳还没建过也必须走 renderContent：`head.changed([], [])` 是 false，
       * 光看内容新旧会漏掉"整页只有右键识别的图、面板还没建"这种情况（实测踩过：
       * 面板宿主建出来了、里面却没有那张「截图」卡）。 */
      const dirty = !this.panelEl || this.minimized || pinChanged || head.changed(this.items, sorted);
      this.items = sorted;
      if (dirty) this.renderContent();
      else {
        /* 卡片没变 ⇒ 只补两块会变的东西：图上的命中红框、右键那张「截图」卡 */
        this.applyImgMarks();
        this.renderCtxCard();
      }
      this.show();
    },

    /**
     * 图片识别状态变了（异步结果回来 / 右键受理 / 识别失败）时的**局部**刷新：只重画图上的命中标记
     * 与那张「截图」卡，不重建笔记卡片（整块重跑会把用户正在看的标签与滚动位置一起丢掉）。
     */
    renderImg() {
      this.imgItems = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function') ? KH.ImgOcr.items() : [];
      /* 【2.0.1.17 右键任意图 OCR】整页既没有笔记、也没有右键识别的图时，外壳从未被造过
       * （见本文件底部 `consume` 的早退），而右键识别是用户**主动**要的一次动作 —— 结果必须能显示。
       * 但**不能无条件**走完整渲染：`render()` 一进来就 `ensure()` 造壳 ⇒ 整页明明没东西也会
       * 多出一个空宿主（K71 的「两者都关 ⇒ 面板不存在」就是这么红的）。所以只在真有右键条目时补渲染。 */
      if (!this.root && !this.ctxItems().length) return;
      if (!this.panelEl) {
        this.render(this.items, KH.config);
        return;
      }
      this.applyImgMarks();
      this.renderCtxCard();
      if (!this.items.length && !this.ctxItems().length) this.hide();
      else this.show();
    },

    renderContent() {
      if (!this.root) return;
      /* 计数 = 笔记卡片 + 右键识别的图（那张「截图」卡也是用户眼里的内容，
       * 只有它的时候计数不许是 0 —— 那会让人以为面板里是空的） */
      const count = this.items.length + this.ctxItems().length;

      // 收起态：整块换成圆形 FAB（单击/双击/回车都能展开 —— 拖动收尾不算，见 startDrag）
      if (this.minimized) {
        this.panelEl = null;
        this.bodyEl = null;
        this.countEl = null;
        /* 【2.0.6.1 需求④】收起态**不再每轮重写 FAB**。
         * 旧写法无条件 `root.innerHTML = …`：整页每次重扫（页面自己动一下就算）都把 FAB 连同监听器
         * 一起换新 —— 用户看到的就是「没操作、没变动，面板也一直在重建闪一下」。FAB 上只有计数与
         * aria 文案会变，计数没变就什么都不用做（元素与监听器原样留用）。
         * `fabCount` 在展开态被重置成 -1（那里整块换了 DOM），所以收回来时必然重建一次。 */
        const fabNow = this.root.querySelector ? this.root.querySelector('.khin-fab') : null;
        if (fabNow && this.fabCount === count) return;
        this.fabCount = count;
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
        this.fabCount = -1;   // 收起态那份 FAB 已被整块换掉（见上面 `this.minimized` 分支的说明）
        /* 题头措辞（含箭头字符）一律取自 KH.OcrCopy.VIEW（F3.4：原来两个题头逐字相同，
         * 读屏听不出展开的是哪一块）；aria-controls 指向受控区。
         * 【2.0.2.15】底部「🖼 图片」分区已删除（右键识别折进主模块那张「截图」卡之后，
         * 它是同一批结果的第二份展示面）。 */
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
          '</div>';
        this.panelEl = this.root.querySelector('.khin-panel');
        this.bodyEl = this.root.querySelector('.khin-body');
        this.countEl = this.root.querySelector('.khin-header-count');
        this.noteBarEl = this.root.querySelector('.khin-notebar');
        this.noteCountEl = this.root.querySelector('.khin-notecount');
        this.noteArrowEl = this.root.querySelector('.khin-notearrow');
        /* 笔记题头是"整行可点的 div"，键盘完全够不着（T29 / F4.2）：补 role/tabindex/
         * aria-expanded 之后，回车与空格要跟点击做同一件事（给元素直接绑，不用 closest 反查）。 */
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
      /* 命中红框跟着卡片一起重建：卡片是整体换新的，标记必须在这一趟重算（旧框也在这趟摘掉） */
      this.applyImgMarks();
    },

    /** 笔记区的收起态落到 DOM（收起时正文整块藏起来，只留题头一行） */
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
     * 把 OCR 结果标到卡片里那些图上（2.0.2.7 用户 m00292：命中的图加红框）。
     *
     * 【2.0.6.1 需求⑧】边框三态：识别中（pending/idle）= 蓝框、命中 = 红框（保持 2.0.2.7 的观感）、
     * 完成但没命中 = 绿框；识别失败也归绿框（它不该装成"还在跑"），悬停里说失败原因。
     * 悬停同样三态：命中说命中了什么，没命中说清卡在哪（动态判据值 / 点名字段没取到值 / 没字）。
     * 判据只在 applyImgMarksTo 一处，面板重建与识别结果回来都走它。
     */
    applyImgMarks() {
      applyImgMarksTo(this.bodyEl, this.imgItems);
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
     * 右键识别的那些图（2.0.2.13 · 用户 m03971；2.0.2.15 用户 m00001 ②）。
     *
     * 为什么单列一张卡：右键识别**不属于任何规则**（`ruleId` 是 `@ctxmenu`），它没有命中词、
     * 没有抓取字段，所以永远进不了笔记卡片。2.0.2.15 起底部那个「🖼 图片」分区已经删除，
     * 这张卡就是右键结果**唯一**的展示面。
     * 只认有 `src` 的条目（读不到地址的图放不进 <img>）—— 但**受理那一刻**背景侧就给回执、
     * 内容侧已建好 `state:'pending'` 的行，所以图会立刻出现，不必等识别跑完。
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
      /* 【2.0.2.16 需求⑦】右键识别的卡也要能关：关掉 = 这一批手动条目整批作废（`clearManual`）。
       * 文案走 `VIEW.removeTip`（"本次页面不再显示"），与笔记卡的 ✕ 同一句口径 —— 面板不许自己写死。
       * 关掉**不清文字缓存**：再右键同一张图不必重跑引擎（见 `KH.ImgOcr.clearManual` 的注释）。 */
      const headEl = doc.createElement('div');
      headEl.className = 'khin-item-head';
      const tagsEl = doc.createElement('div');
      tagsEl.className = 'khin-item-tags';
      const closeBtn = doc.createElement('button');
      closeBtn.className = 'khin-item-close';
      closeBtn.title = KH.OcrCopy.VIEW.removeTip;
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (KH.ImgOcr && typeof KH.ImgOcr.clearManual === 'function') KH.ImgOcr.clearManual();
      });
      headEl.appendChild(tagsEl);
      headEl.appendChild(closeBtn);
      el.appendChild(headEl);
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
      /* 还有图在识别（或刚失败）就写在标题格旁边：用户右键完立刻看到图，
       * 得知道"文字还在路上" —— 否则会以为识别压根没跑。 */
      const busy = list.some((it) => it.state === 'pending' || it.state === 'idle');
      const failed = !busy && list.some((it) => it.state === 'fail');
      if (busy || failed) {
        const st = doc.createElement('span');
        st.className = 'khin-ctxstate';
        st.textContent = busy ? KH.OcrCopy.VIEW.ctxBusy : KH.OcrCopy.VIEW.ctxFail;
        th.appendChild(st);
      }
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
    /* 右键卡的内容签名：图地址（解析后）+ 状态 + 标签。状态 or 图变了才值得重建
     * （pending→done 会让标题格多一句「识别中/失败」、灯箱里多一份 OCR 全文）。 */
    ctxSig() {
      return this.ctxItems()
        .map((it) => [absSrc(it.src), it.state || '', String(it.label || '')].join('\u0001'))
        .join('\u0002');
    },

    renderCtxCard() {
      if (!this.bodyEl) return;
      /* 【2.0.4 需求④】签名没变就**不拆不建**：这张卡唯一会变的内容是 OCR 状态与图清单，
       * 而 `renderImg()`（OCR 每变一次就调）走的正是这里 —— 旧写法每次都把卡连 `<img>` 换新，
       * 图重新解码，卡就会闪一下。签名一致时直接留着。 */
      const sig = this.ctxSig();
      if (!this.ctxEl || sig !== this.ctxSigCache) {
        if (this.ctxEl && this.ctxEl.parentNode) this.ctxEl.parentNode.removeChild(this.ctxEl);
        this.ctxEl = this.ctxCard(document);
        this.ctxSigCache = sig;
        /* 【2.0.2.16 需求⑦】右键那张「截图」卡排**最下方** —— 它是用户随手识别的产物，
         * 不该压在设置里的卡片（尤其是置顶排序排到最前的那些）上面。只在这里 append，
         * 不参与 `sortByPins`：卡间排序是笔记卡之间的事，右键卡不进那张表。 */
        if (this.ctxEl) this.bodyEl.appendChild(this.ctxEl);
      }
      this.bodyEl.hidden = !(this.items.length || this.ctxEl);
    },

    renderItems() {
      if (!this.bodyEl) return;
      const doc = document;
      /* 【2.0.4 需求④】不再 `bodyEl.textContent = ''` 整块重建。
       * 旧写法每次重画都把卡片连同里面的 `<img>` 一起换新 ⇒ 浏览器重新解码、重排、
       * 滚动位置归零，用户看到的就是「看板频繁闪一下」。改为**按序复用**：
       * 正文串（note）没变的卡留用原元素，只重画标签区与内联样式；变了才重建那一张。
       * `note` 是卡片里唯一承重的内容（抓取表格、OCR 追加的键值行都在串里），
       * 所以"复用"不会漏更新；顺序变了就按新顺序落位。 */
      const prevEls = this.cardEls || [];
      const prevNotes = this.cardNotes || [];
      const els = [];
      const notes = [];
      /* 右键卡永远排最后：先摘下来，收尾统一由 `renderCtxCard()` 追加 */
      if (this.ctxEl && this.ctxEl.parentNode) this.ctxEl.parentNode.removeChild(this.ctxEl);
      /* 卡级内联样式两个分支都要落：复用旧卡时必须能**清掉**旧值（词级图片尺寸/字号/底色
       * 都可能在这两条笔记之间被改过 —— 只"有值才写"等于让旧值留在卡上）。 */
      const styleOf = (el, item) => {
        if (item.imgSize) el.style.setProperty('--kh-img-size', item.imgSize + 'px');
        else if (el.style && typeof el.style.removeProperty === 'function') el.style.removeProperty('--kh-img-size');
        /* 词级正文字号（2.0.2.2 需求 2）：卡级内联 `--kh-note-fs` 盖掉宿主级那个全局字号。
         * 该变量由 `.khin-item-note`（笔记正文）与抓取字段表格统一消费，所以写在这一层就能同时管住两者。 */
        if (item.noteFontSize) el.style.setProperty('--kh-note-fs', item.noteFontSize + 'px');
        else if (el.style && typeof el.style.removeProperty === 'function') el.style.removeProperty('--kh-note-fs');
        // 「复用高亮底色」：铺该词实际底色（分组色 > 词色 > 全局默认）；空串不铺
        el.style.background = /^#[0-9a-fA-F]{3,8}$/.test(item.bg || '') ? item.bg : '';
      };
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const note = String(item.note == null ? '' : item.note);
        const prevEl = prevEls[i] || null;
        let el = (prevEl && prevNotes[i] === note) ? prevEl : null;
        if (el) {
          /* 复用：标签区要按当前状态重画（展开/选中/命中序号都在里面），正文与 `<img>` 不动 */
          const tagsEl = el.firstElementChild && el.firstElementChild.firstElementChild;
          if (tagsEl) this.renderTags(tagsEl, item);
        } else {
          el = doc.createElement('div');
          el.className = 'khin-item';
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
          noteEl.appendChild(this.noteFragment(doc, note));
          el.appendChild(noteEl);
          carryImgs(prevEl, el);
        }
        styleOf(el, item);
        els.push(el);
        notes.push(note);
        /* 落位：同一位置已经是对的元素就跳过，避免无谓的 DOM 移动（移动即重排） */
        const cur = this.bodyEl.children[i];
        if (cur !== el) this.bodyEl.insertBefore(el, cur || null);
      }
      /* 条数变少了：把不在本次名单里的旧卡摘掉（按"在不在名单"判，
       * 挪过位的老卡不会被误删） */
      const keep = new Set(els);
      const kids = Array.prototype.slice.call(this.bodyEl.children);
      for (const child of kids) {
        if (!keep.has(child)) this.bodyEl.removeChild(child);
      }
      this.cardEls = els;
      this.cardNotes = notes;
      /* 【2.0.2.16 需求⑦】右键「截图」卡排**最下方**，由 renderCtxCard 收尾追加；
       * 它自己也带签名闸，没变化就不重建。 */
      this.renderCtxCard();
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
          /* 【2.0.2.17 需求①】字段名格只剩名字（后缀不再进笔记），于是这里回到最简单的一步：
           * 整格文本包进 `.kh-lbt` —— 截断只发生在视觉上，全文在 `title` 里可悬停读回。 */
          const txt = td.textContent || '';
          const span = doc.createElement('span');
          span.className = 'kh-lbt';
          span.title = txt;            // 全文在悬停里可读回，截断只发生在视觉上
          span.textContent = txt;
          td.textContent = '';
          td.appendChild(span);
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
      /* 【2.0.4 需求④】复用缓存/签名随面板一起清：host 已经没了，留着只是悬空引用 */
      this.cardEls = [];
      this.cardNotes = [];
      this.ctxEl = null;
      this.ctxSigCache = null;
    }
  };

  /**
   * 【2.0.2.17 需求⑥ / 2.0.4 需求①】图片 OCR 命中成功 ⇒ 把图上的「键：值」并进抓取字段表。
   *
   * 【2.0.4 收严口径（用户裁决）】旧行为是"凡是命中行里的 `X：Y` 都进表"，范围太大：
   * `一对一时间选择范围11:30.` 被拆成「一对一时间选择范围 | 11:30.」塞进卡片。
   * 现在**必须先给那个词配后缀标记**（写在「图片命中关键词」的胶囊末尾，`#表` / `#kv` 都认）：
   *   · 没标记的词 ⇒ 只做命中判定，**一行都不进表**（不再有"所有词都生效"）；
   *   · 标记是**逐词**的，一个词误配不波及其它词；
   *   · 进表时**标题格 = 那个命中词本身**（不是图上认出来的任意文字），值 = 紧跟其后的分隔符之后的内容。
   * 分隔符适度放宽（用户口径）：`：`/`:`/`｜`/`|`/`＝`/`=`，以及**空白**（OCR 把「词 值」读散很常见）。
   * 表格形式（图里就是两格）也照这个口径：**首格必须等于命中词**，值取它后面的格子。
   *
   * 两条纪律不变：只取命中行（整篇 OCR 抄进卡片会把表格撑爆）；同一 `词+值` 只留一条。
   */
  const squashWs = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  /** 键值行：命中词 + 分隔符 + 值。`{也` 之外的标点不算分隔符（`一对一时间范围11:30` 因此不会误拆）。 */
  const KV_LEAD_SEP = /^(?:\s*[：:｜|＝=]\s*|\s+)(\S[\s\S]*)$/;
  /** 命中词做**字面**匹配（可以带正则元字符），词内允许被 OCR 读散出空白 */
  function kvLiteralRe(word) {
    const chars = String(word || '').trim().split('');
    if (!chars.length) return null;
    const body = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    try { return new RegExp(body, 'i'); } catch (e) { return null; }
  }
  /** 这一行里命中词之后的部分：`hit`=命中，`sep`=紧跟分隔符，`value`=分隔符之后的内容 */
  function kvSegInLine(line, re) {
    const m = re.exec(line);
    if (!m) return { hit: false, sep: false, value: '' };
    const after = line.slice(m.index + m[0].length);
    const v = KV_LEAD_SEP.exec(after);
    if (v) return { hit: true, sep: true, value: String(v[1]).trim() };
    /* 分隔符后面是空的 —— OCR 常把「值」换到下一行（`词：` / `值`） */
    return { hit: true, sep: /^\s*[：:｜|＝=]\s*$/.test(after), value: '' };
  }
  /** 这一行里「命中词 + 分隔符 + 值」的值（没有就返回空串） */
  function kvValueInLine(line, re) {
    return kvSegInLine(line, re).value;
  }

  /* ---------------- 值被 OCR 换行拆到下一行（`词：` / `值`） ----------------
   * 只在「命中词后面紧跟着分隔符、但分隔符后是空的」时才往下看，且必须过三道闸，
   * 否则宁可不进表 —— 这条功能最贵的错误就是「拉一段无关正文进卡片」：
   *   ① 下一行自己长得像「字段：值」（有冒号且左边短）⇒ 认为那是另一条，不偷；
   *   ② 下一行含别的命中词 ⇒ 不偷（它属于那一条）；
   *   ③ 单行太长（> KV_NEXT_LEN）⇒ 多半是正文段落，停。
   * 最多吃 KV_NEXT_MAX 行（值本身再折一行还能接住，再长就停）。 */
  const KV_NEXT_MAX = 2;
  const KV_NEXT_LEN = 40;
  const KV_NEXT_LABEL = /^\s*[^\s：:｜|＝=]{1,16}\s*[：:]/;
  const KV_LEAD_ONLY = /^\s*[：:｜|＝=]\s*/;
  function kvNextValue(lines, from, word, matchers) {
    const parts = [];
    let used = 0;
    for (let i = from; i < lines.length && used < KV_NEXT_MAX; i++) {
      let t = String(lines[i] == null ? '' : lines[i]).trim();
      if (!t) continue;
      if (!used) t = t.replace(KV_LEAD_ONLY, '');   /* 万一分隔符自己也落在下一行开头 */
      if (!t) continue;
      used++;
      if (KV_NEXT_LABEL.test(t)) break;
      let otherWord = false;
      for (const mt of matchers) {
        if (mt.word === word) continue;
        if (mt.re.test(t)) { otherWord = true; break; }
      }
      if (otherWord) break;
      if (squashWs(t).length > KV_NEXT_LEN) break;
      parts.push(t);
    }
    return parts.join(' ').trim();
  }

  function ocrExtraRows(meta) {
    const ruleId = meta && meta.pinId;
    if (!ruleId || !meta.imgOcr) return [];
    if (!KH.ImgOcr || typeof KH.ImgOcr.items !== 'function') return [];
    /* 只有被标记的词才进表（唯一实现：`KH.ImgOcr.kvWords`，与匹配口径同一份标记语法） */
    const words = (typeof KH.ImgOcr.kvWords === 'function') ? (KH.ImgOcr.kvWords(meta.imgOcrKeyword) || []) : [];
    if (!words.length) return [];
    const matchers = [];
    for (const w of words) {
      const re = kvLiteralRe(w);
      if (re) matchers.push({ word: String(w).trim(), re: re });
    }
    if (!matchers.length) return [];
    let list = [];
    try { list = KH.ImgOcr.items() || []; } catch (e) { return []; }
    const out = [];
    const seen = new Set();
    const pushRow = (label, value) => {
      const sig = label + '\u0000' + value;
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ label: label, value: value });
    };
    for (const it of list) {
      /* 【2.0.6.1 需求⑦】把「行」与「命中」拉回同一条判据：条目的动态判据（`imgOcrNeed`）没满足时
       * `judge` 判**未命中**——不高亮、不加红框；旧写法只看 `state==='done'`，于是这种条目照样往表里
       * 塞一行「词 | 值」，用户看到「表格里有这行，OCR 全文里却不高亮、图也没有红框」这套自相矛盾的画面。
       * （`needMissingValues` 由 `ImgOcr.judgeInfo` 带出，只有动态判据失败的条目才有它。） */
      if (!it || it.ruleId !== ruleId || it.state !== 'done' || !it.text) continue;
      if (it.needMissingValues && it.needMissingValues.length) continue;
      const rawLines = String(it.text).split(/\r?\n/);
      for (let li = 0; li < rawLines.length; li++) {
        const line = rawLines[li].trim();
        if (!line) continue;
        const cells = (it.lineList && it.lineList[li] && it.lineList[li].cells) || [];
        for (const mt of matchers) {
          /* ① 表格形式：搜到「格文本 == 命中词」的格 ⇒ 值 = 它后面的格（标题格就是那个词） */
          let vi = -1;
          for (let i = 0; i < cells.length; i++) {
            if (squashWs(cells[i] && cells[i].t) === squashWs(mt.word)) { vi = i; break; }
          }
          let rowDone = false;
          if (vi >= 0 && vi < cells.length - 1) {
            const value = cells.slice(vi + 1)
              .map((c) => String((c && c.t) || '').trim()).filter(Boolean).join(' ').trim();
            if (value) { pushRow(mt.word, value); rowDone = true; }
          }
          if (rowDone) continue;
          /* ② 文本行：命中词 + 分隔符 + 值（**标题格必须是这个词**，值只取分隔符之后） */
          const seg = kvSegInLine(line, mt.re);
          if (!seg.hit) continue;
          if (seg.value) { pushRow(mt.word, seg.value); continue; }
          /* ③ 值被 OCR 换行拆到下面（图里是 `词：值`，识别成 `词：` / `值`）：
           * 只认「词后紧跟着分隔符」这一种（表格里词格后为空也算），其余一律不往下看。 */
          if (!seg.sep && vi < 0) continue;
          if (seg.sep && vi >= 0 && vi < cells.length - 1) continue; /* 后面有格但为空 ⇒ 不偷下一行 */
          const next = kvNextValue(rawLines, li + 1, mt.word, matchers);
          if (next) pushRow(mt.word, next);
        }
      }
    }
    return out;
  }

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
          ? (KH.Fetch.blockFor(h.textNode, h.meta.fetchLabels, fetchCache, h.meta.fetchScope, ocrExtraRows(h.meta)) || '')
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
        /* 右键识别的图与重要笔记**共用这块面板**：只要还有右键识别的图，panel.host 不存在时也得建出来，
         * 否则"这个词没开重要笔记、只有右键结果"就永远看不到东西（用户 m00001 ②）。 */
        const ctxCount = (KH.ImgOcr && typeof KH.ImgOcr.items === 'function')
          ? KH.ImgOcr.items().filter((it) => it && it.via === 'contextMenu').length : 0;
        if (!list.length && !ctxCount && !panel.host) return;    // 从没出现过：连外壳都不造
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
   * 不能等下一次页面重建 —— 否则用户要等页面变动才看见识别结果。
   * 右键识别同样走这条路：受理即展示（pending 行）与结果回来都在 `renderImg` 里落地。
   * 灯箱还开着时也要跟着刷（全文栏与「OCR 识别/隐藏全文」按钮的换脸都靠它）。
   * 【2.0.2.17 需求⑥】OCR 命中后笔记里要多出「键：值」行 ⇒ 结果变化时**笔记也要重建**；
   * 用指纹挡一道，避免每个条目每次状态抖动都把整块笔记重画一遍。 */
  let ocrNoteSigSeen = '';
  function ocrNoteSig() {
    if (!KH.ImgOcr || typeof KH.ImgOcr.items !== 'function') return '';
    try {
      return (KH.ImgOcr.items() || []).map((it) => [
        it && it.ruleId, it && it.key, it && it.state,
        String((it && it.text) || '').length, ((it && it.matched) || []).length
      ].join(':')).join(';');
    } catch (e) { return ''; }
  }
  if (KH.ImgOcr && typeof KH.ImgOcr.onChange === 'function') {
    KH.ImgOcr.onChange(() => {
      panel.renderImg();
      const sig = ocrNoteSig();
      if (sig !== ocrNoteSigSeen) {
        ocrNoteSigSeen = sig;
        if (panel.host) panel.refresh();     // OCR 行可能刚补进抓取字段表
      }
      const h = document.getElementById(LIGHTBOX_ID);
      if (h && typeof h._apply === 'function') h._apply();
    });
  }

  /* `paintHits` 直接导出给单测：灯箱要在垫片里走完 openLightbox 那条路成本太高（宿主/影子根/
   * 相册/停靠都在里面），而这个函数是纯 DOM 构造，喂文本就能验。 */
  KH.ImportantNote = { panel, head, collectEffective, IMG_PROTOCOL_OK, paintHits, ocrExtraRows };
})();
