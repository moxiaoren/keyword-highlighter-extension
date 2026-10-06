'use strict';
/* scripts/regression-areas.js — 回归范围的**单一真源**：区域（area）表 + 三级升级规则
 * ----------------------------------------------------------------------------
 * 用户口径（2026-09）：现在只有"方面"一级（hit / visual / interact / fetch / site / ui / data），
 * 太粗 —— 只改了「关键词添加弹窗」也要把整个 UI 层跑一遍。要再细一层：
 *
 *   区域级（最省） → 方面级（退一级） → 全量（实在判断不了）
 *
 * 这张表同时服务两处（**唯一真源**，别处不许再抄一份）：
 *   ① 真浏览器回归选组：`_e2e/t.js` 用 `nameRe` 把**组名**映射到区域
 *      —— 好处是**不用给 26 个 group() 一个个加标签**，新组只要名字里带关键词就自动归类；
 *      名字匹配不上任何区域 → **视为"必须跑"**（保守，绝不因为分类没覆盖而漏跑）。
 *   ② 出包门禁选范围：`scripts/impact.js` 用 `fileRe` 把**改动文件**映射到区域；
 *      共享文件显式列多个区域（改 fields.js 会同时影响关键词/分组/站点三处弹窗）。
 *
 * 三级升级规则（`classify()`，写死在代码里，不靠人记）：
 *   · 改动全落在区域表里、且不碰"危险文件" → level='areas'（只跑这些区域）
 *   · 有文件没被区域表覆盖，但方面表能覆盖        → level='aspects'（跑那些方面）
 *   · 有文件两边都覆盖不了 / 碰到危险文件 / 无改动 → level='all'（全量）
 */

/** 危险文件：动了它们就别想省 —— 直接全量（它们是所有功能的共同底座） */
const DANGER_RE = [
  /^manifest\.json$/,
  /^src\/core\/index\.js$/,
  /^src\/core\/scanner\.js$/,
  /^src\/core\/scheduler\.js$/,
  /^src\/core\/renderer\.js$/,
  /^src\/core\/rebuilder\.js$/,
  /^src\/core\/arbiter\.js$/,
  /^src\/core\/compiler\.js$/,
  /^src\/core\/registry\.js$/,
  /^src\/core\/config\.js$/,
  /^src\/core\/relevant?\.js$/
];

/**
 * 区域表。
 *   key     —— `--areas=` 里用的名字
 *   label   —— 人能看懂的中文
 *   nameRe  —— **组名**匹配（真浏览器回归选组用）
 *   fileRe  —— **文件路径**匹配（出包门禁选范围用）
 *   implies —— 该文件被改动时，**必须一起跑**的区域（共享文件用；见 `areasOfFile`）
 */
const AREAS = [
  { key: 'combo', label: '组合词（左右格 / 上下格 / 单元格结构）', nameRe: /组合词|上下格|左右格|单元格|7b\./, fileRe: /^src\/features\/combo\// },
  { key: 'xnode', label: '跨文本节点命中（拆词 / 行内 run / 全词边界）', nameRe: /跨文本节点|拆词|全词|8b\.|8c\./, fileRe: /^src\/features\/rare-char\.js$/ },
  { key: 'fetch', label: '后续字段抓取（含图片策略 / 多行表格）', nameRe: /抓取|7f\./, fileRe: /^src\/features\/fetch\.js$/ },
  { key: 'rare', label: '罕见字规则', nameRe: /罕见字/, fileRe: /^src\/features\/rare-char\.js$/ },
  { key: 'kwtable', label: '关键词表格 / 筛选 / 批量操作', nameRe: /关键词表格|筛选|批量|9\. options/, fileRe: /^src\/ui\/components\/data-table\.js$/ },
  { key: 'editor', label: '关键词编辑弹窗（含富文本 / 保存往返）', nameRe: /编辑弹窗|关键词弹窗|快速添加|7d\./, fileRe: /^src\/ui\/components\/(keyword-editor|rich-editor)\.js$/ },
  /* fields.js 是**共享**的：关键词弹窗 / 分组弹窗 / 站点规则弹窗都用它 —— 改动必须三个区域一起跑。
   * ⚠️ 它自己的 key 没有组会命中（组名里没有"字段工厂"这种词），所以**必须靠 implies 展开**，
   *    否则门禁会"选中一个空区域 → 一个组都不跑"（比全量还危险：假绿）。 */
  { key: 'fields', label: '字段工厂（弹窗控件形态的公共层）', nameRe: /控件/, fileRe: /^src\/ui\/components\/fields\.js$/,
    implies: ['editor', 'groupsites', 'options', 'popup'] },
  { key: 'color', label: '色板 / 取色器 / 颜色胶囊', nameRe: /色板|取色/, fileRe: /^src\/ui\/components\/color-field\.js$/, implies: ['editor', 'groupsites', 'options'] },
  { key: 'groupsites', label: '分组与站点规则', nameRe: /分组|站点规则|11\. options/, fileRe: /^src\/features\/site-rules\.js$/ },
  { key: 'popup', label: '弹窗（工具栏 / 站点卡 / 通道开关 / 快速添加）', nameRe: /popup|12\. popup/, fileRe: /^popup\// },
  /* 面板也认领两个 OCR 组（2026-10-07）：它们断言的就是**面板里的 OCR 分区**
   * （条目渲染 / 耗时徽标 / 「显示全部」往返 / 队列补发），而改 `important-note.js` 选中的是
   * `--areas=panel` —— 不认领就是"面板改坏了，一条用例都没跑"（假绿）。 */
  { key: 'panel', label: '重要笔记面板 / 备注卡片 / 灯箱', nameRe: /面板|笔记|卡片|灯箱|7c|图片文字识别|图片命中/, fileRe: /^src\/features\/(important-note|note-card)\.js$/ },
  /* 补 `图片命中`：组名是「图片命中：普通词 + 抓取字段取图（…）」，旧 nameRe 匹配不上，
   * 那组只靠 `/抓取/` 落到 fetch ⇒ 改 img-ocr 相关时它裁不掉（保守，但白跑一整组）。 */
  { key: 'imgocr', label: '图片文字识别', nameRe: /图片文字识别|图片识别|图片命中|图片 OCR/, fileRe: /^src\/features\/img-ocr\.js$|^offscreen\// },
  { key: 'relevance', label: '变更相关性（不重建 / 仅消费）', nameRe: /变更相关性/, fileRe: /^src\/core\/relevance\.js$/ },
  { key: 'attrs', label: '属性观察（显隐变化）', nameRe: /属性观察/, fileRe: /^src\/features\/page-editor\.js$/ },
  { key: 'dynamic', label: '动态页面（SPA / bfcache / ShadowRoot / 虚拟滚动 / iframe）', nameRe: /SPA|bfcache|ShadowRoot|影子|虚拟滚动|iframe|布局改写|7e\.|7g\./, fileRe: /^src\/platform\//, implies: ['options', 'popup'] },
  { key: 'perf', label: '重页面性能预算', nameRe: /性能|重页面|18\./, fileRe: /^src\/core\/(scheduler|scanner)\.js$/ },
  { key: 'options', label: '设置页外壳（侧边栏 / 分区 / 导入导出 / 帮助）', nameRe: /侧边栏|分区|导入导出|帮助|8\. options/ },
  { key: 'storage', label: '存储 / 导入导出 / 配置', nameRe: /导入导出|CSV|存储/, fileRe: /^src\/platform\/storage\.js$/, implies: ['options', 'popup'] }
];

/** 组名 → 命中的区域 key 列表（空数组 = 分类没覆盖 → 调用方必须**保守地跑**它） */
function areasOfGroupName(name) {
  const s = String(name || '');
  const hit = [];
  for (const a of AREAS) if (a.nameRe && a.nameRe.test(s)) hit.push(a.key);
  return hit;
}

/** 改动文件 → 命中的区域 key 列表（**已展开 implies**；空 = 没有任何区域认领这个文件） */
function areasOfFile(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const hit = new Set();
  for (const a of AREAS) {
    /* 有些区域只用于"组名归类"、不认领文件（例如 options 外壳：改它就该退到方面级跑整个 UI 层） */
    if (!a.fileRe || !a.fileRe.test(s)) continue;
    hit.add(a.key);
    for (const k of (a.implies || [])) hit.add(k);
  }
  return Array.from(hit);
}

function isDangerous(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return DANGER_RE.some((re) => re.test(s));
}

/**
 * 三级判定（出包门禁用）。
 * @param {string[]} paths 改动文件（相对扩展根目录）
 * @param {(p:string)=>string[]|null} aspectsOf 兜底的"方面"查询（由 impact.js 提供）
 * @returns {{level:'none'|'areas'|'aspects'|'all', areas:string[], aspects:string[], reason:string}}
 */
function classify(paths, aspectsOf) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { level: 'none', areas: [], aspects: [], reason: '没有改动' };

  /* 危险文件 → 直接全量 */
  const danger = list.filter(isDangerous);
  if (danger.length) return { level: 'all', areas: [], aspects: [], reason: '危险文件：' + danger.slice(0, 3).join('、') };

  /* 区域判定：**每一个**文件都要有区域认领，否则不能只跑区域 */
  const areaSet = new Set();
  const unowned = [];
  for (const p of list) {
    const a = areasOfFile(p);
    if (!a.length) unowned.push(p);
    for (const k of a) areaSet.add(k);
  }
  /* 方面侧：`[]`（文档/测试/脚本）表示"明确与本插件行为无关"，不算 unowned ——
   * 否则改个 README 会被判成全量（实测踩到）。 */
  const aspectSet = new Set();
  let aspectUnknown = false;
  let aspectIrrelevant = new Set();
  if (typeof aspectsOf === 'function') {
    for (const p of list) {
      const a = aspectsOf(p);
      if (a === 'all') return { level: 'all', areas: [], aspects: [], reason: '方面表判定全量：' + p };
      if (!a) { aspectUnknown = true; continue; }
      if (!a.length) { aspectIrrelevant.add(p); continue; }
      for (const k of a) aspectSet.add(k);
    }
  } else {
    aspectUnknown = true;
  }
  const reallyUnowned = unowned.filter((p) => !aspectIrrelevant.has(p));

  if (!reallyUnowned.length) {
    if (aspectSet.size === 0 && !aspectUnknown) {
      return { level: 'none', areas: Array.from(areaSet), aspects: [], reason: '只动了文档/测试/脚本' };
    }
    return { level: 'areas', areas: Array.from(areaSet), aspects: Array.from(aspectSet), reason: '全部文件都有区域归属' };
  }
  if (!aspectUnknown && aspectSet.size) {
    return { level: 'aspects', areas: Array.from(areaSet), aspects: Array.from(aspectSet), reason: '未被区域覆盖：' + reallyUnowned.slice(0, 3).join('、') };
  }
  return { level: 'all', areas: Array.from(areaSet), aspects: Array.from(aspectSet), reason: '区域与方面都判断不了' };
}

module.exports = { AREAS, areasOfGroupName, areasOfFile, isDangerous, classify, DANGER_RE };
