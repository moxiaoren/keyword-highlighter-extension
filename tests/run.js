/* tests/run.js — 单测入口：node tests/run.js */
'use strict';
const H = require('./harness');

const specs = [
  './specs/compiler.test.js',
  './specs/arbiter.test.js',
  './specs/storage.test.js',
  './specs/fetch.test.js',
  './specs/important-note.test.js',
  './specs/markdown.test.js',
  './specs/update.test.js',
  /* K40 三条用户实测缺陷的不变式（必须有，否则后续更新会把它们改回去） */
  './specs/combo-cells.test.js',
  './specs/hit-geometry.test.js',
  './specs/hot-update.test.js',
  /* 回归范围分类表本身：映射表改错 = 该测的没测，且不会有任何红灯 */
  './specs/impact-mapping.test.js',
  /* 罕见字作为组合核心（规格早已写明，旧实现两边互相排除导致整条失效） */
  './specs/rare-combo.test.js',
  /* 跨节点 run 归并 / 区间映射：普通词与组合词必须共用同一份口径（v1.99.99.8 实测缺陷） */
  './specs/inline-runs.test.js',
  /* 色板与取色器的"合理性"不变式（用户要求：剔除不合理色 + 补必备色 + 5×4 + 可拖动取色器） */
  './specs/color-field.test.js',
  /* 普通词 vs 组合词：匹配结果必须逐字一致（组合词只是多一个"定位在哪个格子"的限制） */
  './specs/match-parity.test.js',
  /* 左右组合词的「指定取值格（右起视觉列）」：留空=旧行为、越界不命中、多格任一命中、colspan 计数 */
  './specs/combo-cell-offset.test.js',
  /* e2e 分组必须自包含 —— 按方面裁组的前提，靠"记得"守不住 */
  './specs/e2e-selfcontained.test.js',
  /* 变更相关性预筛（P1/P2）：无关变动不重建、抓取字段变化只走仅消费、拆词/慢填必须重建 */
  './specs/relevance.test.js',
  /* 延迟裁决的调度时机（K56）：还没安静要自己补排、拖过上限必须裁决、上限不许跳过判据 */
  './specs/scheduler-defer.test.js',
  /* 命中为 0 时的自查（K57）：扫描体检计数 + 三种成因的判读（可见没命中 / 只在隐藏里 / 不在本层文档） */
  './specs/diag-selfcheck.test.js',
  /* 「内容凭空出现」的三条兜底（K60）：动画/过渡、文本量暴涨、保守档指纹 */
  './specs/scheduler-fallback.test.js',
  /* 图片命中：读不出地址的图不许被静默丢掉（K62） */
  './specs/img-ocr.test.js',
  /* K70 编辑弹窗布局：R4 独立验收（红队）的清单层复核 —— 与 R3 的用例换角度，互不替代 */
  './specs/k70-editor-layout-r4.test.js',
  /* K71「抓取后续字段」模块启用：编译层的门 / 迁移规则 / 清理清单在声明层的判定 */
  './specs/k71-fetch-enabled.test.js',
  /* K71 返工复验（R4 独立）：脏值共用函数 / CSV-JSON 口径 / 正文按模块归属 / 门未被动过 */
  './specs/k71-r4-recheck.test.js',
  /* K72 升级兼容与文案收口：A1 导入不丢仅抓取词 / B5 导出即规范形状 / B6 废弃键剔除 / B9 方向单源 / A2·A3·B8 文案 */
  './specs/k72-upgrade-compat.test.js',
  /* K72 复验（R4 独立）：换夹具与写法再判一遍 + B6 落盘对象边界 + B9 运行期哨兵证明单源 */
  './specs/k72-r4-recheck.test.js',
  /* K74 嵌套表格抓取范围：分层抓取 / 行级优先 / 五值生效 / 取图同源 / 缓存不串味 */
  './specs/k74-nested-fetch-scope.test.js',
  /* K74 复验（R4 独立）：自造三层装置 + 自造 rowspan/colspan 形状 + 归一单源哨兵 + 性能修复等价性 */
  './specs/k74-r4-recheck.test.js',
  /* K75 复验（R4 独立）：自造三种假表格形状 × 两种落点 + imgAnchors 不消费 + 默认关的三条路
   * （R3 的 K75 用例加在既有 spec 里：fetch / img-ocr / combo-cell-offset / k71-fetch-enabled） */
  './specs/k75-r4-recheck.test.js',
  /* K76 扫描剪枝口径：`display:contents`（无盒但子树渲染）与 `visibility`（只跳自己）——
   * 旧实现把原生 `checkVisibility` 的布尔值当成"整棵子树不渲染"，于是词在页面上却完全不高亮 */
  './specs/k76-contents-prune.test.js',
  /* K76 复验（R4 独立·红队）：换装置（忠实计算样式/祖先语义 checkVisibility）与角度再判一遍
   * —— 嵌套 contents / 行内与块级标签 / 隐藏祖先的负例 / 退化路径 / 快路径计数哨兵 / 边界持仓 */
  './specs/k76-r4-recheck.test.js',
  /* K77「命中要符合视觉」：折叠内容算数（闭合 `<details>` 正文 / `content-visibility:hidden`）+ 视觉连续不断词
   * （行内判据从**标签名**改为**计算后的 display**）—— 用户 2026-09-22 口径 */
  './specs/k77-visual-flow.test.js',
  /* K78 三项收口：run 祖先上限（8→128）/ 属性变更的取样范围（按所在上下文）
   * —— ① 作者自己折叠的内容（启发式 + 设置开关）见同一 spec 的后续小节 */
  './specs/k78-collapse-and-depth.test.js',
  /* K79 抓取层级口径重梳：内层＝当前层里**任意单元格**的嵌表 / 外层取值排掉内表（文字与图）
   * / 旧值 outer1·outermost → outer、all → self+inner+outer、auto 原样保留 */
  './specs/k79-fetch-layers.test.js',
  /* K79 复验（R4 独立·红队）：另造装置（三层/深层嵌套/th·colspan/同格两表/N 张嵌表/假表格）
   * 与另写判据，逐面拷打内层归属长尾、skipNestedTables 误伤面、旧值逐字等价、仅抓取锚点层判定 */
  './specs/k79-r4-recheck.test.js',
  /* C7 F-1 回归（存储写失败不许被吞）：补上"三个入口 0 行为级测试"之外的最小诚实性网
   * —— 平台写入口行为级 + popup/options/update-checker 源码契约；真机证据见
   * `_stage/wayfinder-kh-ui/probe-f1-postfix.js`（注入配额失败） */
  './specs/write-honesty.test.js',
  /* C7 F-5 / F-6 / F-10 的回归网：
   *   · changelog-render：更新日志（真实 172 个版本）渲染后标记不上屏、不产出链接/图片
   *   · 其余源码契约（「稍后」必须落盘 / welcome 读失败不标记已读 / 单源渲染）在 write-honesty 里
   * 真机证据见 `_stage/wayfinder-kh-ui/probe-f5-postfix.js` 与 `probe-f10f6-postfix.js` */
  './specs/changelog-render.test.js',
  /* C7「可选」清单第二批（O-4 / O-5 / O-6）：
   *   · O-4 popup 首屏不许自相矛盾（源码契约）
   *   · O-5 页内编辑器样式读不到必须认账（行为级：桩 fetch 失败 / 半份 / 恢复 / 缓存）
   *   · O-6 死参数 mode 与失效的内联 sm 弹窗 CSS 清干净
   * 真机证据见 `_stage/wayfinder-kh-ui/probe-o4o5o6-postfix.js`（独立探针，含旧代码阳性对照）；
   * 尚未并入 `_e2e/ui.test.js` 回归组 —— 那是下轮该补的（见交付说明的未验证项）*/
  './specs/optional-batch8.test.js'
];

(async () => {
  for (const rel of specs) {
    try {
      await require(rel)();
    } catch (err) {
      console.error('\n✗ 加载 ' + rel + ' 失败：' + (err && err.message));
      console.error(err && err.stack);
      process.exitCode = 1;
    }
  }
  H.report();
})();
