/* ============================================================================
 * src/ui/fieldmap.js · 表单 ⇄ 存储 的**唯一**字段声明 + 往返校验（R12 / UN-08）
 * ----------------------------------------------------------------------------
 * 病根（旧版实测）：同一个字段在四个地方各写一遍 ——
 *   options 编辑弹窗、批量设置、CSV 导入、CSV 导出。
 * 于是出现"弹窗能改、批量改不动""CSV 导出的列和导入的列对不上""新增字段只改了
 * 一处"这类问题。根因不是手滑，而是**没有单一声明**。
 *
 * v2 收敛：`KEYWORD_FIELDS` 是关键词字段的**唯一清单**，每一行同时声明
 *   key（存储键） · label（展示名） · type（控件类型） · form（表单分组） · csv（CSV 列序）
 * 上面四条路径一律遍历这张表：新增一个字段 = 加一行，四端同时生效。
 *
 * 往返校验（R12 / 验收 UN-08）：`roundTrip()` 做「表单 → 存储 → 再读回」的三段比对，
 * 每个字段都必须字节级一致；任何 `toStore` / `toForm` 的不对称都会被它抓出来。
 * 它不是"多余的自测"：CSV 与 JSON 两条导入路径都靠它保证"11 个字段填→存→重读一致，
 * 且交叉无污染"。
 *
 * 铁律：本文件**不定义任何默认值**。字段默认值只从两处来 ——
 *   · `Config.defaults`（全局默认，如默认底色）
 *   · `Config.defaults.matchSettings.*`（新建关键词的匹配开关初值）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /**
   * 表单分区（弹窗横向紧凑布局用；顺序即渲染顺序）。
   *
   * 【**只有 3 个分区** —— 这是策划案 §5.2.2 的布局铁律，v2 一度漂成 6 个独立卡片】
   * 规格原文：
   *   · 基本信息：关键词输入框、分组选择、备注(Markdown)；**右侧列容纳匹配规则 + 高亮颜色**
   *   · 单元格组合（可折叠）：组合方向、标题关键词(左格)、匹配方式、**抓取后续字段**
   *   · 重要笔记（可折叠）：标记为重要、富文本编辑器、图片尺寸、复用关键词高亮底色
   * 所以「匹配规则」「高亮与分组」不该各成一张卡（它们是"这一个关键词"的属性，
   * 独立成卡只会让弹窗更长、还得多看一眼才知道属于谁），「抓取后续字段」也归在单元格组合里。
   * 用户实测把这个偏离指出来了，这里按规格收回来。
   *
   * `col` = 这一节放在第几列。**为什么显式指定列，而不是让浏览器自动排**：
   *   ① 逐行栅格（旧实现）里一行最高的卡片决定行高，矮卡片下面必留空洞
   *      （实测「匹配规则」112px 挨着「单元格组合」296px，同一行下面空了 184px）；
   *   ② CSS 多列（`column-count`）能消空洞，但**任何卡片高度变化都会重新均衡所有列** ——
   *      拉一下备注框、某节内容变高，整个弹窗就跳一次；
   *   ③ 显式分列后每列是**独立的 flex 竖列**：卡片在列内首尾相接，且某张卡片变高只推它自己那一列。
   */
  /* 【K71 文案清理】`hint` 是**可见**的那一句（一律短句，≤18 字符，否则标题行会折行、
   * 整个弹窗被顶高 —— K70 实测 548→565px）；`hintTitle` 是它的 tooltip，长解释住在这里。
   * 用户点名原则：**模块标题已经写了模块名，正文不得再重复一遍** —— 所以 hint 里不出现
   * 本模块的标题字符串（`_e2e` 有一条按「body 文本不含标题」判定的用例盯着）。 */
  const FORM_SECTIONS = [
    { id: 'basic', title: '基本信息', hint: '关键词 / 匹配 / 备注 / 高亮',
      hintTitle: '这一节是这条关键词的身份：词本身、分组、备注、命中后的高亮颜色', col: 1 },
    { id: 'combo', title: '单元格组合', hint: '左格 + 右格都命中才生效',
      hintTitle: '左格标题 + 右格核心，两格都命中才生效', col: 2 },
    /* 「抓取后续字段」**独立成区**：它早就不只服务组合词了 —— 普通关键词也能抓取，
     * 所以把它塞进「单元格组合」是错的（用户实测指出）。这里与 combo 同列但**是独立卡片**。 */
    { id: 'fetch', title: '抓取后续字段', hint: '命中后把同行的其它字段抓进重要笔记',
      hintTitle: '命中后把同一行里指定的字段抓进重要笔记（普通词也能抓）', col: 2 },
    { id: 'imp', title: '重要笔记', hint: '命中后进左上角面板',
      hintTitle: '重要笔记 / 抓取值 / 图片命中都汇总到页面左上角那个面板', col: 3 }
  ];

  /**
   * 组合方向（comboAxis）决定同一批字段该怎么称呼 —— **唯一一份方向文案表**。
   * 为什么放这里：编辑弹窗要按方向改写「标题关键词(左格)/列关键词(表头)」等标签，
   * 若把这份文案写进 keyword-editor.js 就等于又开了一张字段表（第二次"两处各写一遍"）。
   * 因此：字段清单与方向文案同住 fieldmap.js，弹窗只负责把文案贴到控件上。
   */
  const AXIS_LABELS = {
    lr: {
      cellVerify: '标题关键词(左格)',
      cellVerifyMatchMode: '标题词匹配',
      hint: '左格 + 右格都命中才生效',
      hintTitle: '左格标题 + 右格核心，两格都命中才生效'
    },
    tb: {
      cellVerify: '列关键词(表头)',
      cellVerifyMatchMode: '列词匹配',
      hint: '表头列 + 数据行交叉命中',
      hintTitle: '表头列 + 数据行交叉命中（仅表头生效）'
    }
  };

  /**
   * 【抓取范围（fetchScope）的值 → 界面文案】**唯一一份**界面措辞（K79 口径重梳后）。
   * 取值表（与归一）唯一一份在 `Config.FETCH_SCOPES` / `normalizeFetchScope`；这里只是文案，
   * 且回归网里有一条"两份取值逐字一致"的用例钉着（与 chip.js PARTS ↔ fieldmap 的 label 同手法），
   * 所以不靠"记得改两处"，也不需要在加载期依赖 `KH.Config`。
   *
   * 口径（用户 2026-09-23）：**当前层** = 命中格所在的表；**内层** = 当前层里嵌着的表；
   * **外层** = 当前层的祖先表（命中格是更大表格的内层）。三方向可组合。
   * `auto` 是旧口径的兼容值（**就近优先、只取一层**），保留给存量配置。
   */
  const FETCH_SCOPE_TEXT = [
    ['auto', '自动（就近一层）'],
    ['self', '当前层'],
    ['inner', '内层'],
    ['outer', '外层'],
    ['self+inner', '当前层 + 内层'],
    ['self+outer', '当前层 + 外层'],
    ['inner+outer', '内层 + 外层'],
    ['self+inner+outer', '当前层 + 内层 + 外层']
  ];

  /**
   * 关键词字段唯一清单。
   *   type: text | textarea | bool | int | select | color
   *   csv :  CSV 18 列中的第几列（1-based；0＝不参与 CSV）—— **表头文案在 storage.js 里另有一份硬编码**，
   *          改这里的 label 不影响 CSV 契约。
   *   sec :  表单分区 id
   *   def :  (cfg) => 初值   ← 只从 Config 派生，禁止字面量
   *   width: 2 = 弹窗里占满整行（默认半行，两个半行字段自动并排）
   *   chip : true = 渲染成**紧凑开关胶囊**而不是"复选框 + 文字"占一行（弹窗空间省一半）
   *
   * 【chip 的文案是单一来源】匹配开关的文案（正则 / Aa / 全词）必须与
   * `src/ui/components/chip.js` 的 `PARTS` **逐字一致** —— 那一份同时供关键词表格的
   * 「核心词匹配 / 标题词匹配」列、悬停 tooltip、批量设置使用。meta-check 有红线校验三者不漂移。
   */
  const KEYWORD_FIELDS = [
    /* ---- 基本信息 ---- */
    /* 关键词与**分组**并排（分组"跟在关键词后面"，与「标题关键词 | 组合方向」同一手法），
     * 两个都是半行 → 自动成一行。 */
    { key: 'text', label: '关键词', type: 'text', sec: 'basic', csv: 1, required: true,
      def: () => '' },
    { key: 'groupId', label: '分组', type: 'select', sec: 'basic', csv: 3, groupSource: true, def: () => null },
    /* 核心词的三个匹配开关：**紧跟关键词那一行**（与标题词那边同一套胶囊、同一套文案）。
     * 声明顺序 = 胶囊顺序，与 chip.js PARTS 保持一致（正则 → Aa → 全词）。 */
    { key: 'useRegex', label: '正则', type: 'bool', sec: 'basic', csv: 7, chip: true,
      hint: '正则表达式匹配（管道 | 可写多个候选）',
      def: (cfg) => !!(cfg.matchSettings || {}).defaultUseRegex },
    { key: 'caseSensitive', label: 'Aa', type: 'bool', sec: 'basic', csv: 5, chip: true,
      hint: '区分大小写',
      def: (cfg) => !!(cfg.matchSettings || {}).defaultCaseSensitive },
    { key: 'wholeWord', label: '全词', type: 'bool', sec: 'basic', csv: 6, chip: true,
      hint: '整词匹配（两侧不得是字母/数字/下划线）',
      def: (cfg) => !!(cfg.matchSettings || {}).defaultWholeWord },
    /* 高亮颜色：与匹配规则三个胶囊**同一行**（胶囊去掉勾选框后窄了，5 个一行放得下），
     * 两组之间插一条**竖线分隔**（`sepBefore`，用户实测要求）—— 竖线比单纯留白更能说明"这是另一组"。
     * 标签用单字 `底` / `文`（`short`），完整名进 tooltip —— 245px 的容器里，
     * 双字标签 5 个放不下（实测 262px），单字才留得出放分隔线的余量。 */
    { key: 'bgColor', label: '底色', short: '底', type: 'color', sec: 'basic', csv: 8, chip: true, sepBefore: true, def: () => '' },
    { key: 'textColor', label: '文字颜色', short: '文', type: 'color', sec: 'basic', csv: 9, chip: true, def: () => '' },
    { key: 'note', label: '备注', type: 'textarea', sec: 'basic', csv: 2, rows: 4, width: 2,
      def: () => '' },
    /* 启用：`head: true` = 渲染到**分区标题行右侧**，不占正文一行
     * （用户实测："放右上角避免占空间，或者干脆删掉 —— 反正关键词管理的表格处可以改"；
     *  这里选前者：既省空间又保留入口。关键词表格的「状态」列同样可以切换。） */
    { key: 'enabled', label: '启用', type: 'bool', sec: 'basic', csv: 4, chip: true, head: true, def: () => true },

    /* ---- 单元格组合 ---- */
    /* 「启用」（原「启用组合」，K70）：不再走正文的胶囊行，改 `head: true` →
     * 渲染到**本分区标题行右侧**的插槽（与「基本信息」那颗同一形态、同一文案）。
     * 用户实测要求："图中两个胶囊按钮改为参考放在模块右上角，名称统一为启用"。
     * ⚠️ **只改显示文案与挂载位置**：key / csv 列序 / 判定逻辑 / id 一律不动。 */
    { key: 'cellVerifyEnabled', label: '启用', type: 'bool', sec: 'combo', csv: 12, chip: true, head: true, def: () => false },
    { key: 'cellVerify', label: '标题关键词(左格)', type: 'text', sec: 'combo', csv: 13, def: () => '' },
    { key: 'comboAxis', label: '组合方向', type: 'select', sec: 'combo', csv: 0,
      options: [{ v: 'lr', t: '左右格' }, { v: 'tb', t: '上下格' }], def: () => 'lr' },
    /* 标题词的三个开关：与核心词**同一套胶囊、同一套文案**（含「全词」——
     * 它在标题词这边的实现就是 cellVerifyMatchMode='exact'，表格列里也是这么显示的）。 */
    { key: 'cellVerifyUseRegex', label: '正则', type: 'bool', sec: 'combo', csv: 16, chip: true,
      hint: '标题词按正则匹配', def: () => false },
    { key: 'cellVerifyCaseSensitive', label: 'Aa', type: 'bool', sec: 'combo', csv: 15, chip: true,
      hint: '标题词区分大小写', def: () => false },
    { key: 'cellVerifyMatchMode', label: '全词', type: 'select', sec: 'combo', csv: 14, chip: true,
      hint: '标题词整词精确匹配', onValue: 'exact', offValue: 'include',
      options: [{ v: 'include', t: '包含即可' }, { v: 'exact', t: '整词精确' }], def: () => 'include' },
    /* 取值格（右起视觉列）——**只对左右格（lr）有意义**：
     * 留空 = 历史行为（标签格右侧**相邻、跳过空格子**的那一格）；填了才按表达式取格。
     * 为什么不做成 select：取值可以是一组（`1-3` / `1,3,5`），下拉表达不了。 */
    { key: 'cellOffset', label: '取值格（右起）', type: 'text', sec: 'combo', csv: 0,
      /* C4：原来的 `placeholder: '默认'` 在空值时**恒显**「默认」，是用户点名的冗余 ——
       * 直接删掉这个属性（不是换成别的字）：含义全部收进 `hint` → 容器 tooltip。 */
      hint: '左右格专用：取值格从标签格右边第几格（按视觉列，仅本行内）。'
        + '如 `2` / `1-3` / `1,3,5`（可混写 `1-3,5`）。'
        + '留空＝右侧相邻格（跳过空格子）；显式 `1`＝右边第 1 个视觉列所在的格，两者在有空格子/合并单元格时可能不同。'
        + '超出本行列数＝不命中。',
      def: () => '' },
    /* ---- 抓取后续字段（独立分区：普通词也能抓取，不再只服务组合词）---- */
    { key: 'fetchLabels', label: '字段', type: 'text', sec: 'fetch', csv: 17, width: 2,
      placeholder: '如：名称｜备注',
      /* C1：模块标题已经叫「抓取后续字段」，正文里的 label 再写一遍就是冗余 → 缩成「字段」。
       * `@表达式` 的语义写准：它是**按标签格所在行**从右数第几格（与组合方向零耦合），
       * 所以措辞里不再拿「取值格（右起）」当参照（那个字段在上下档正好是禁用态，越说越乱）。 */
      hint: '留空＝不抓取。后缀：`#1` 只取右邻一格；`#图` 仅图片；`#3` 最多 3 张图；`#图3` 仅图片且最多 3 张（例「截图#图3」）。'
        + '值格指向：`@表达式` 按**本行**从右数第几格（`2` / `1-3` / `1,3` / `1-3,5`），'
        + '如「应用截图@2」「应用截图@1-3#图」「应用截图#图@2」（修饰与偏移顺序无关，可混写）；'
        + '留空＝右邻格，表达式非法/越界＝回退右邻格。',
      def: () => '' },
    /* 「抓取后续字段」模块的**总开关**（K71）：与另三颗胶囊同形态（label/chip/head/type 逐项同形），
     * `csv: 0` = 不进 CSV（存储契约仍是 18 列）。
     * 【K75 · 默认改关】`def` 由 `true` 改成 **`false`**（用户原话："抓取后续字段的启用改为默认关闭"）
     * —— 新建关键词时该模块默认未勾选，与「单元格组合」「重要笔记」一致。
     * ⚠️ **迁移规则一个字没改**：`normalizeFetchEnabled` 仍是"**缺键** ⇒ 按非空 `fetchLabels` 反推
     * （＝true）；键存在 ⇒ 一律尊重" ⇒ **存量配置照旧抓取**（默认值只影响"新建"）。
     * ⚠️ 位置必须**紧跟 `fetchLabels` 之后**：`fieldsOf('fetch')[0]` 仍是那个输入框（既有不变式），
     * 而 `head: true` 的字段渲染进标题行插槽，与正文顺序无关。 */
    { key: 'fetchEnabled', label: '启用', type: 'bool', sec: 'fetch', csv: 0, chip: true, head: true,
      hint: '关闭＝不抓取：本模块字段置灰、已填内容保留', def: () => false },
    /* 「抓取范围」（K74）：**嵌套表格时抓哪一层**。位置必须在 `fetchEnabled` 之后 ——
     * `fieldsOf('fetch')[0]` 仍是那个输入框（K71 的既有不变式）。
     * `csv: 0`（仍是 18 列契约）；未启用抓取模块时由 `syncFetch` 一并禁用。 */
    { key: 'fetchScope', label: '抓取范围', type: 'select', sec: 'fetch', csv: 0, def: () => 'self',
      options: FETCH_SCOPE_TEXT.map((pair) => ({ v: pair[0], t: pair[1] })),
      hint: '嵌套表格时抓哪一层的数据（K79 重梳）：**当前层**＝命中所在的那张表；**内层**＝当前层里嵌着的表；'
        + '**外层**＝包着当前层的表（命中格是更大表格的内层）。可组合，例如「当前层 + 外层」。'
        + '取值时**内层文字不会混进外层的值**；同名标签只有值不同才加「（内层）/（本层）/（外层）」后缀。'
        + '「自动（就近一层）」是旧行为：本层有就用本层、没有才往外找一层。' },

    /* ---- 图片文字识别（图片命中 = 「抓取后续字段」的一个分支）----
     * 【K70 挂载位置】这三个控件原在「单元格组合」里，用户实测要求归到本模块
     * （"识别图片相关内容归到抓取后续字段模块"）：声明顺序落在这里 → 渲染在本分区
     * `抓取后续字段` 输入框**下方**。**只是搬家**：字段名 / 存储键 / 联动 / 保存拦截全不动。
     * 【前置条件（用户确认）】必须配了「抓取后续字段」才允许勾选 —— 图片就是从**这些字段的值格**
     * 里取的（`fetchLabels` 里的 `@表达式` 决定值格指向）；没配抓取字段就无从取图。
     * 勾选后必须填「图片命中关键词」：它是**唯一**的匹配口径（不再回落成规则核心词）。
     * 前置条件由三层共同保证：编辑器禁用（keyword-editor 的 syncFetch）、保存拦截、`Config.normalize` 兜底。
     * 不再限于组合词：普通词命中后同样按"命中所在表里的抓取字段"取图。
     * 上限留空 = 用 `Config.defaults.imgOcr.defaultMax`（默认值不在业务代码里写第二份）。 */
    /* ⚠️ 这三个字段**刻意不用 chip**：它们是「抓取字段」这一类的前置条件说明，不是匹配开关；
     * 渲染成普通勾选行 / 输入行的语义更清楚（核心词与标题词的匹配规则那两排胶囊也必须保持
     * "只有正则/Aa/全词"，真浏览器回归里有一条断言专门盯"同一套说法"）。 */
    { key: 'imgOcr', label: '识别图片文字', type: 'bool', sec: 'fetch', csv: 0,
      /* C6/C8：控件行已经有「识别图片文字」这五个字，tooltip 不再复述它、也不复述模块名
       * （用户点名的原则：模块标题写了模块名，正文不得再写一遍；tooltip 口径保持一致）。
       * 【K75 · 口径补一句】前提是**这条规则真的命中**（用户原话："判断命中了普通词/组合词没有…
       * 如果没有命中，那就不需要考虑图片 ocr 和图片关键词"）—— 图是从"命中那一处配置的字段值格"里取的。 */
      hint: '图片里的字也算命中：识别各字段值格里的图片（需先在上面填好字段；'
        + '且**这条规则真的命中**时才会识别 —— 没命中就不看图片）',
      def: () => false },
    { key: 'imgOcrKeyword', label: '图片命中关键词', type: 'text', sec: 'fetch', csv: 0,
      placeholder: '如：一对一',
      hint: '按**正则**匹配识别出的图片文字（不区分大小写、不要求整词）。'
        + '如 `一对一` / `A.C`；留空则不该勾选「识别图片文字」。',
      def: () => '' },
    { key: 'imgOcrMax', label: '每处最多', type: 'int', sec: 'fetch', csv: 0, inline: true,
      placeholder: '默认',
      /* C5：「每处最多」是**张数**，原来吃的是 int 分支硬编码的"默认尺寸"提示，写错了对象。 */
      hint: '每处最多识别几张（留空＝用全局默认张数）', def: () => '' },

    /* ---- 重要笔记 ---- */
    /* K70：「重要」→ 文案改「启用」并 `head: true`（本分区标题行右侧，与另两颗同形态）。
     * 于是正文只剩 `[底色] 尺寸：[__]` 一行（原来三件事挤一行）。 */
    { key: 'important', label: '启用', type: 'bool', sec: 'imp', csv: 10, chip: true, head: true, def: () => false },
    { key: 'impNoteUseHlColor', label: '底色', type: 'bool', sec: 'imp', csv: 0, chip: true,
      hint: '复用关键词高亮底色（重要笔记卡片背景）；留空则用卡片自身的底色',
      def: () => false },
    /* 标签从「图片尺寸(px)」缩到「尺寸」：原标题占 78px，把这个窄容器里的输入框挤得只剩一点点
     * （用户实测："图片大小前面的文本不用这么长，挤压太多输入框位置"）。冒号由 inline 模式的 CSS 补。 */
    { key: 'imgSize', label: '尺寸', type: 'int', sec: 'imp', csv: 0, inline: true,
      hint: '图片的显示尺寸（留空＝用全局默认）', def: () => '' },
    // richtext = 所见即所得（图片/链接/加粗/斜体/表格）；存储仍是干净 Markdown（与旧版一致）
    /* C2：模块标题已经叫「重要笔记」，正文 label 再写一遍就是冗余 → 改「笔记内容」。
     * key / type / csv 列序 / 往返一律不动（纯显示文案）。 */
    { key: 'importantNote', label: '笔记内容', type: 'richtext', sec: 'imp', csv: 11, rows: 4, width: 2, def: () => '' }
  ];

  /** 不属于"用户可编辑字段"但必须原样保留的元数据（往返校验要校验它们不变形） */
  const META_KEYS = ['id', 'createdAt', 'updatedAt', 'kind', 'fetchOnly'];

  const byKey = new Map(KEYWORD_FIELDS.map(f => [f.key, f]));

  /** 按类型强制取值 —— 表单控件给的值五花八门（'true'/'on'/'1'/null），只在这里收口 */
  function coerce(field, v) {
    switch (field.type) {
      case 'bool': return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
      case 'int': {
        if (v === '' || v == null) return '';
        const n = parseInt(v, 10);
        return isNaN(n) ? '' : n;
      }
      case 'select':
        if (field.options) return field.options.some(o => o.v === v) ? v : field.options[0].v;
        return v == null ? null : v;        // groupId 等动态选项由调用方校验
      default: return v == null ? '' : String(v);
    }
  }

  /** 新建时的初值（全部从 Config 派生） */
  function defaults(cfg) {
    const out = {};
    for (const f of KEYWORD_FIELDS) out[f.key] = coerce(f, f.def(cfg));
    return out;
  }

  /** 表单值 → 存储对象。**唯一**实现：任何写入路径（弹窗/批量/CSV/JSON）都必须经它 */
  function toStore(form, cfg) {
    const base = defaults(cfg || {});
    const merged = Object.assign({}, base, form || {});
    const kw = {};
    for (const f of KEYWORD_FIELDS) kw[f.key] = coerce(f, merged[f.key]);
    // 元数据原样透传（id 等），未知键不进入存储（避免脏字段循环落盘）
    for (const k of META_KEYS) if (form && form[k] !== undefined) kw[k] = form[k];
    // 组合词一致性：没勾选组合就没标题词，避免"勾了又取消"留下半截状态
    if (!kw.cellVerifyEnabled) {
      kw.cellVerify = '';
      kw.cellVerifyMatchMode = 'include';
      kw.cellVerifyCaseSensitive = false;
      kw.cellVerifyUseRegex = false;
    }
    return kw;
  }

  /** 存储对象 → 表单值（同一份清单，保证两侧完全对称） */
  function toForm(kw) {
    const out = {};
    for (const f of KEYWORD_FIELDS) out[f.key] = coerce(f, kw ? kw[f.key] : undefined);
    for (const k of META_KEYS) if (kw && kw[k] !== undefined) out[k] = kw[k];
    return out;
  }

  /**
   * 往返校验：表单 → 存储 → 再读回，逐字段比对。
   * @returns {{ok:boolean, diffs:string[]}}
   */
  function roundTrip(kw, cfg) {
    const diffs = [];
    const stored = toStore(toForm(kw), cfg);
    const back = toForm(stored);
    for (const f of KEYWORD_FIELDS) {
      const a = coerce(f, kw ? kw[f.key] : undefined);
      const b = back[f.key];
      if (a !== b) diffs.push(f.key + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
    }
    // 交叉污染检查：不该出现的键不得被写进存储
    const allowed = new Set(KEYWORD_FIELDS.map(f => f.key).concat(META_KEYS));
    for (const k of Object.keys(stored)) if (!allowed.has(k)) diffs.push('出现越界键: ' + k);
    return { ok: diffs.length === 0, diffs };
  }

  /** 供 CSV 列序使用：列号 → 字段（CSV 契约与字段声明同源，不另写一份表头映射） */
  function csvColumns() {
    const cols = new Array(KH.Store.CSV_HEADERS.length).fill(null);
    for (const f of KEYWORD_FIELDS) if (f.csv > 0) cols[f.csv - 1] = f;
    return cols;
  }

  /**
   * 【分组字段清单】分组编辑弹窗的字段声明。
   * 与 `KEYWORD_FIELDS` 同一份风格，交给**同一个** `ui.Fields.create` 渲染 ——
   * 这样"分组弹窗的控件形态"不需要单独维护：关键词那边改成胶囊，这边自动也是胶囊。
   * 文案沿用关键词弹窗的口径（底/文/重要/底色/尺寸），完整含义进 tooltip。
   * id 前缀用 `fld-g-`：分组与关键词有 6 个同名字段键（bgColor/textColor/important/…），
   * 用同一前缀会让"按 id 定位"在弹窗堆叠时产生歧义。
   */
  const GROUP_FIELDS = [
    { key: 'name', label: '分组名称', type: 'text', required: true, width: 2, placeholder: '分组名称' },
    { key: 'bgColor', label: '底色', short: '底', type: 'color', chip: true,
      hint: '统一背景色：组内关键词未单独设色时使用' },
    { key: 'textColor', label: '文字颜色', short: '文', type: 'color', chip: true,
      hint: '统一文字色：组内关键词未单独设色时使用' },
    /* 竖线分隔：上面两个是"统一配色"，下面两个是"行为开关"，与关键词弹窗同一手法 */
    { key: 'important', label: '重要', type: 'bool', chip: true, sepBefore: true,
      hint: '整组标记为「重要」：组内命中都进重要笔记面板' },
    { key: 'impNoteUseHlColor', label: '底色', type: 'bool', chip: true,
      hint: '复用高亮底色（组内关键词的笔记卡片背景）；留空则用卡片自身的底色' },
    { key: 'importantNote', label: '分组重要笔记', type: 'richtext', width: 2,
      placeholder: '分组统一的重要笔记（分组标记为重要时生效）；图片、加粗、表格、链接直接在框内显示' },
    { key: 'imgSize', label: '尺寸', type: 'int', inline: true }
  ];

  /**
   * 【备注卡片样式字段】与 `GROUP_FIELDS` 同一风格，交给同一个 `ui.Fields.create` 渲染。
   * 三个颜色也统一成**颜色胶囊**（原来用的是旧色块），其余是文本输入。
   * 这些是"全局默认值"，不允许留空（`allowEmpty: false` 由调用方给 —— 颜色胶囊的浮层里没有「清除」）。
   */
  const NOTE_CARD_FIELDS = [
    { key: 'bgColor', label: '底色', short: '底', type: 'color', chip: true, hint: '备注卡片背景色' },
    { key: 'textColor', label: '文字颜色', short: '文', type: 'color', chip: true, hint: '备注卡片文字颜色' },
    { key: 'borderColor', label: '边框颜色', short: '框', type: 'color', chip: true, hint: '备注卡片边框颜色' },
    { key: 'borderWidth', label: '边框宽度', type: 'text', placeholder: '如 1px' },
    { key: 'borderRadius', label: '圆角', type: 'text', placeholder: '如 8px' },
    { key: 'shadow', label: '阴影', type: 'text', width: 2, placeholder: '如 0 4px 12px rgba(0,0,0,.12)' },
    { key: 'maxWidth', label: '最大宽度', type: 'text', placeholder: '如 360px' },
    { key: 'opacity', label: '不透明度', type: 'text', placeholder: '如 1' },
    { key: 'fontSize', label: '字号', type: 'text', placeholder: '如 13px' }
  ];

  /**
   * 【站点规则的两组文案】单一来源 —— 弹窗里的下拉选项与列表里的展示都从这里取。
   * 原先 options.js 里写了一份 `MATCH_TEXT`（精确/含子域名/URL 前缀/正则）给列表用，
   * 又在弹窗里另写了一份（精确/含子域/前缀/正则）—— 同一个下拉两套说法。
   */
  const SITE_SCOPE_TEXT = { domain: '域名', url: '网址' };
  const SITE_MATCH_TEXT = { exact: '精确', subdomain: '含子域名', prefix: 'URL 前缀', regex: '正则' };

  /**
   * 【站点规则字段】交给同一个 `ui.Fields.create` 渲染。
   * 原来这四处是手写的 `.kh-fld`，**没有 id/for**，外部无法按 id 逐字段定位（保存往返也就没法自动断言）。
   */
  const SITE_RULE_FIELDS = [
    { key: 'type', label: '规则类型', type: 'select', width: 2, options: [
      { v: 'blacklist', t: '🚫 黑名单（这些站点不高亮）' },
      { v: 'whitelist', t: '✅ 白名单（只有这些站点高亮）' }
    ] },
    { key: 'scope', label: '匹配对象', type: 'select',
      options: Object.keys(SITE_SCOPE_TEXT).map(k => ({ v: k, t: SITE_SCOPE_TEXT[k] })) },
    { key: 'matchType', label: '匹配方式', type: 'select',
      options: Object.keys(SITE_MATCH_TEXT).map(k => ({ v: k, t: SITE_MATCH_TEXT[k] })) },
    { key: 'pattern', label: '站点 / 网址', type: 'text', required: true, width: 2, placeholder: '如 example.com' }
  ];

  KH.FieldMap = {
    KEYWORD_FIELDS, GROUP_FIELDS, NOTE_CARD_FIELDS, SITE_RULE_FIELDS, FORM_SECTIONS, META_KEYS,
    SITE_SCOPE_TEXT, SITE_MATCH_TEXT,
    byKey: (k) => byKey.get(k) || null,
    fieldsOf: (sec) => KEYWORD_FIELDS.filter(f => f.sec === sec),
    /** 组合方向文案（弹窗按当前方向取用；未知方向一律按默认 lr 处理） */
    axisLabels: (axis) => AXIS_LABELS[axis === 'tb' ? 'tb' : 'lr'],
    coerce, defaults, toStore, toForm, roundTrip, csvColumns
  };
})();
