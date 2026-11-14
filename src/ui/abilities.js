/* ============================================================================
 * src/ui/abilities.js · 能力清单唯一真源（台账 2026-11-14 第 1 条 / 方案 a）
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件：欢迎页首屏那三句承诺 + 「它能做什么」那几张卡、README 的能力
 * 段落，原本是三处各写一份的散文。它们不会一起改 —— 上线新功能时漏改一处，
 * 用户读到的就是「文档说的和插件能做的不是一回事」，而这种不一致没有任何红灯。
 *
 * 所以能力清单只在这里定义一次：
 *   · 欢迎页  welcome/welcome.js  运行时按本文件渲染首屏胶囊 + 两层能力卡；
 *   · README  scripts/gen-abilities.js 按本文件生成 ABILITIES 标记块；
 *   · 门禁    scripts/meta-check.js 比对 README 块与本文件、并禁止欢迎页回退成硬编码。
 *
 * 维护规矩（加新功能 = 改这里，别的地方都不动）：
 *   1. 只写**已经能用的**能力。未上线的不许提前写进来（判据：无与现状不符的承诺）。
 *   2. 两层分开：basics = 它能做什么（功能面）；selling = 凭什么用它（取舍面）。
 *   3. 每条都带 anchor：指向界面里真实存在的落点。anchors 里的 probe 是可执行判据
 *      （meta-check 会去对应文件里找这串文字），所以锚点不许写成一句空话。
 *   4. 文案里不要写版本号（版本真源只有 manifest.json，meta-check 会拦字面量）。
 *   5. desc 是纯文本：欢迎页用 textContent 上屏，不认任何标记语法（避免汇点）。
 * ========================================================================= */

const KH_ABILITIES = {
  /* 一句话定位：欢迎页首屏大字、README 首段、CONTEXT.md 的「定位」行必须逐字一致。
   * 改这一句 = 三处同时变；meta-check 会比对 CONTEXT.md 里确实有这句话。 */
  positioning: '在任意网页标出关键词，并把同行信息收进「重要笔记」——只上色，不改动网页。',

  /* 界面锚点表：id → { label, probe: { file, needle } }
   * label 是给人看的路径；probe 是给 meta-check 找的字符串（找不到 = 该锚点已失效）。 */
  anchors: {
    kwManage: { label: '设置页 › 关键词管理', probe: { file: 'options/options.html', needle: '<h2>关键词管理' } },
    groups: { label: '设置页 › 分组管理', probe: { file: 'options/options.html', needle: '<h2>分组管理' } },
    style: { label: '设置页 › 样式配置', probe: { file: 'options/options.html', needle: '<h2>样式配置' } },
    imgOcr: { label: '设置页 › 图片识别', probe: { file: 'options/options.html', needle: '<h2>图片识别' } },
    io: { label: '设置页 › 导入导出', probe: { file: 'options/options.html', needle: '<h2>导入导出' } },
    privacy: { label: '设置页 › 帮助与隐私', probe: { file: 'options/options.html', needle: '<h2>帮助与隐私' } },
    panel: { label: '任意网页 › 重要笔记面板', probe: { file: 'src/features/important-note.js', needle: 'khin-panel' } },
    paint: { label: '任意网页 › 命中处上色', probe: { file: 'src/core/renderer.js', needle: 'highlights' } }
  },

  /* 首屏三枚胶囊：只给 id，文案取 selling 里同一条的 chip（承诺与卖点必须是同一句话，
   * 否则「首屏说不改网页、卡里说支持改写」这种自相矛盾没人会发现）。 */
  heroChips: ['no-touch', 'local-ocr', 'local-data'],

  /* 第一层 · 基础能力：这个插件替你做什么（按使用顺序排，新用户从上往下读） */
  basics: [
    {
      id: 'highlight',
      icon: '🔍',
      title: '关键词高亮',
      desc: '普通词 / 正则 / 全词 / 区分大小写，一条关键词一种匹配方式。命中处只是视觉上色，网页内容一个字都不改。',
      anchor: 'kwManage'
    },
    {
      id: 'combo',
      icon: '▦',
      title: '单元格组合',
      desc: '「左格标题 ＋ 右格核心」或「表头列 ＋ 数据行」：两格都命中才生效，避免只对上半个词就误标。',
      anchor: 'kwManage'
    },
    {
      id: 'fetch-note',
      icon: '📌',
      title: '抓取同行 ＋ 重要笔记',
      desc: '命中后能把同一张表里的其它字段一并抓走，聚合在页面上的「重要笔记」面板里；每个词还能单独写备注，点高亮词就能看。',
      anchor: 'panel'
    },
    {
      id: 'img-ocr',
      icon: '🖼',
      title: '图片文字识别',
      desc: '「截图当值」的格子也能被命中：抓取字段值格里的图识别一次就进面板。网页上的图右键即识别，点开大图后工具条上也能一键 OCR。',
      anchor: 'imgOcr'
    },
    {
      id: 'doc-fill',
      icon: '🧾',
      title: '文书自动补行并比对',
      desc: '营业执照、软著证书、备案函、承诺函、合作协议贴进图片，自动补出企业名称 / 登记号 / 承诺对象等行；补出的企业名称与抓到的「开发者」比对，同一家铺浅绿，不一致铺浅黄提示人工确认。',
      anchor: 'imgOcr'
    },
    {
      id: 'group-color',
      icon: '🎨',
      title: '分组与配色',
      desc: '每个词可单独设底色与文字色，分组设一次组内共用。优先级：分组色 > 词色 > 全局默认。',
      anchor: 'groups'
    }
  ],

  /* 第二层 · 卖点：凭什么选它（用户真正做取舍的地方，每条都要能指到界面上的落点） */
  selling: [
    {
      id: 'no-touch',
      icon: '✨',
      title: '只上色，不改动网页',
      chip: '仅上色 · 不改动网页',
      desc: '高亮走浏览器自带的 CSS 高亮接口，页面里不插任何节点 —— 网页的脚本、表格、复制粘贴都不会被我们动到。',
      anchor: 'paint'
    },
    {
      id: 'local-ocr',
      icon: '🔒',
      title: '识别全在本机',
      chip: '识别全在本机',
      desc: '图片不上传。OCR 在本地跑，唯一的联网动作是首次下载语言包；也可以手动导入语言包，做到完全离线识别。',
      anchor: 'imgOcr'
    },
    {
      id: 'local-data',
      icon: '💾',
      title: '数据只存本机',
      chip: '数据只存本机',
      desc: '关键词、抓取内容、备注都只写进浏览器本地存储（chrome.storage.local），不埋点、不上传、不联网同步。',
      anchor: 'privacy'
    },
    {
      id: 'rules-not-coords',
      icon: '🔁',
      title: '只存规则，不存坐标',
      desc: '库里没有「这段文字在第几行第几列」这类位置数据，每次打开页面按规则重新命中 —— 表格翻页、懒加载、站点改版之后，只要文字还在，高亮自动跟上，也不会留下「锚点已失效」的垃圾数据。',
      anchor: 'paint'
    },
    {
      id: 'portable',
      icon: '📦',
      title: '一份配置能整包搬走',
      desc: '关键词、分组、配色、样式与站点规则可以一起导出成 JSON，换电脑或交给同事直接导入，不用一条条重配。',
      anchor: 'io'
    }
  ]
};

if (typeof window !== 'undefined') { window.KH_ABILITIES = KH_ABILITIES; }
if (typeof module !== 'undefined' && module.exports) { module.exports = KH_ABILITIES; }
