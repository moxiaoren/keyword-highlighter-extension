/* ============================================================================
 * scripts/impact.js — 变更影响面分析：这次改动**涉及哪些方面**，据此决定回归范围
 * ----------------------------------------------------------------------------
 * 用户定的口径（本项目执行纪律）：
 *   · **改到哪个方面，就回归哪个方面，必须通过**；
 *   · 不相关的方面可以不测；
 *   · **不好判断就全量回归**（本脚本对"未知文件"一律按 all 处理）。
 *
 * 怎么知道"改了什么"：本工作区**没有 git**，所以用「基线快照 + 哈希比对」——
 *   每次成功出包后把交付相关文件的 sha256 写进 release/.impact-baseline.json，
 *   下次出包时与它比对，得出 新增/修改/删除 的清单，再按下面的规则表映射到**方面**。
 *   （基线在 release/ 下：既不进交付包，也不会被 publish-gh 上传。）
 *
 * ── 方面清单（唯一真源；_e2e 的 group 标注、Node 单测的覆盖面都按这套名字对齐）──
 *   hit      命中与匹配：规则编译 / 扫描 / 裁决 / 组合词（左右格·上下格）/ 跨节点 /
 *            全词与正则边界 / 翻页与改值后的重建时机
 *   visual   渲染与着色：纯视觉（只用 Range + CSS.highlights，绝不改 DOM）/ 颜色优先级 /
 *            默认文字色兜底
 *   interact 交互：悬停 tooltip / 备注卡片 / 重要笔记面板 / 灯箱 / 拖拽 / 坐标定位 /
 *            页内编辑器
 *   fetch    抓取与序列化：抓取后续字段 / 多行与表格 / 触发判据 / Markdown ↔ 富文本
 *   site     站点门禁与开关：站点规则（黑白名单·网址级）/ 临时禁用本站 / 全局开关 /
 *            配置热更新必须复核门禁
 *   ui       管理端界面：options / popup / welcome 的布局·控件·保存往返
 *   data     数据层：storage 归一化 / CSV·JSON 导入导出往返 / 存量格式兼容读取
 *
 * ── 测试覆盖分布（改到某方面时，谁在守它）──
 *   hit      → Node: compiler / arbiter / combo-cells ｜ e2e 内容层 2·3·8·7b·7e·7f·7g·全词正则
 *   visual   → Node: compiler.resolveVisual ｜ e2e 内容层 1·7
 *   interact → Node: hit-geometry / important-note ｜ e2e 内容层 5·6·7c·7d
 *   fetch    → Node: fetch / markdown ｜ e2e 内容层 4·7f
 *   site     → Node: hot-update ｜ e2e 内容层 13
 *   ui       → e2e UI 层 8·9·10·11·12（+ 内容层 7d）
 *   data     → Node: storage ｜ e2e：无独立覆盖（`storage.js` 同时映射 ui，改它仍会跑 UI 层）
 *
 * 【2026-10-05】原先的 `update` 方面（双通道探测 / 镜像回退 / 缓存 / SHA256）随
 * `background/update-checker.js` 一起删除：插件入口不再检查线上更新。版本比较的实现搬到了
 * `scripts/lib/version.js`（发版脚本自用）—— 它的用例在 tests/specs/version.test.js，
 * 而 `^scripts/` 规则本就是"不影响交付行为"，所以这里不再需要 update 这个方面。
 *
 * 用法：
 *   node scripts/impact.js                   # 人读报告：改了哪些文件 → 各自方面 → 结论
 *   node scripts/impact.js --aspects         # 只输出 aspect 列表（逗号分隔）或 none / all
 *   node scripts/impact.js --write-baseline  # 把当前状态记为基线（出包成功后调用）
 *   node scripts/impact.js --since <文件>     # 用指定基线文件比对
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ARGV = process.argv.slice(2);
const arg = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };

/** 基线文件：release/ 既不进交付包也不上线（publish-gh 只传站点文件） */
const BASELINE = path.resolve(arg('--since', path.join(ROOT, 'release', '.impact-baseline.json')));

const ALL = 'all', NONE = 'none';

/** 方面清单（键名 = 传给 _e2e/run.js --aspects= 的名字） */
const ASPECTS = {
  hit: '命中与匹配（编译/扫描/裁决/组合词/跨节点/边界/重建时机）',
  visual: '渲染与着色（纯视觉不改 DOM/颜色优先级/文字色兜底）',
  interact: '交互（悬停/卡片/面板/灯箱/拖拽/坐标定位/页内编辑器）',
  fetch: '抓取与序列化（抓取字段/多行表格/触发判据/Markdown）',
  site: '站点门禁与开关（站点规则/禁用本站/全局开关/热更新门禁）',
  ui: '管理端界面（options/popup/welcome 布局·控件·保存往返）',
  data: '数据层（storage 归一化/CSV·JSON 往返/兼容读取）'
};

/* ---------------- 参与判定的文件集 ---------------- */
/* 交付内容 + 测试 + 构建脚本；**不含**产物目录（dist/release）与依赖，
 * 否则每次打包都会因产物变化被判成"有改动"。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'release', 'build', 'coverage',
  '_stage', '_audit', '_out', '_tools', '.vscode', '.idea'
]);

function walk(dir, out) {
  const abs = path.join(ROOT, dir);
  let names;
  try { names = fs.readdirSync(abs); } catch (e) { return out; }
  for (const name of names) {
    const rel = dir === '.' ? name : dir + '/' + name;
    let st;
    try { st = fs.statSync(path.join(ROOT, rel)); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(rel, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

function hashOf(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}

/* ---------------- 规则表：文件 → 方面 ----------------
 * **顺序即优先级**，第一个命中为准 —— 所以"具体文件"要写在"整个目录"前面。
 * 拿不准的一律 ALL（宁多测，不漏测）。 */
const RULES = [
  /* 不影响交付行为的：测试自身 / 构建脚本 / 文档 / CI
   * （联调装置 _e2e/ 在工作区里、不在本仓库内，本来就不在遍历集合里） */
  { re: /^tests\//, aspects: [] },
  { re: /^scripts\//, aspects: [] },
  { re: /\.md$/i, aspects: [] },
  { re: /^\.github\//, aspects: [] },

  /* ---- 内核 ---- */
  { re: /^src\/core\/compiler\.js$/, aspects: ['hit'] },
  { re: /^src\/core\/scanner\.js$/, aspects: ['hit'] },
  { re: /^src\/core\/arbiter\.js$/, aspects: ['hit'] },
  { re: /^src\/core\/registry\.js$/, aspects: ['hit'] },
  { re: /^src\/core\/renderer\.js$/, aspects: ['visual'] },
  { re: /^src\/core\/rebuilder\.js$/, aspects: ['visual'] },
  /* 门面：管线(run)=hit、坐标定位(pointToRange)=interact、启动与热更新门禁=site */
  { re: /^src\/core\/index\.js$/, aspects: ['hit', 'interact', 'site'] },
  /* 调度器：观察器/指纹=hit、页面点击=interact、URL 变化重评站点规则=site */
  { re: /^src\/core\/scheduler\.js$/, aspects: ['hit', 'interact', 'site'] },
  { re: /^src\/core\/config\.js$/, aspects: ALL },         // 配置默认值与归一化：三端共用，影响面难枚举
  /* 消息协议：内容脚本 / 后台 / 管理端三端共用，改它必须全跑 */
  { re: /^src\/core\/protocol\.js$/, aspects: ALL },
  { re: /^src\/core\//, aspects: ALL },                    // 内核新增文件 → 拿不准，全跑

  /* ---- 功能层 ---- */
  { re: /^src\/features\/combo\//, aspects: ['hit'] },
  { re: /^src\/features\/rare-char\.js$/, aspects: ['hit'] },
  { re: /^src\/features\/fetch\.js$/, aspects: ['fetch'] },
  { re: /^src\/features\/site-rules\.js$/, aspects: ['site'] },
  { re: /^src\/features\/important-note\.js$/, aspects: ['interact'] },
  { re: /^src\/features\/note-card\.js$/, aspects: ['interact'] },
  { re: /^src\/features\/page-editor\.js$/, aspects: ['interact', 'ui'] },
  { re: /^src\/features\//, aspects: ALL },                // 新增功能文件 → 拿不准，全跑

  /* ---- 平台层 ---- */
  { re: /^src\/platform\/markdown\.js$/, aspects: ['fetch'] },
  { re: /^src\/platform\/storage\.js$/, aspects: ['data', 'ui'] },
  { re: /^src\/platform\//, aspects: ALL },

  /* ---- UI 源码 ---- */
  { re: /^src\/ui\/components\//, aspects: ['ui', 'interact'] },   // 内容层页内编辑器也用
  { re: /^src\/ui\/tokens\.css$/, aspects: ['visual', 'ui'] },
  { re: /^src\/build-info\.js$/, aspects: ['ui'] },                // 版本徽标
  { re: /^src\/ui\//, aspects: ['ui'] },
  { re: /^src\//, aspects: ALL },                                  // src 下其它 → 全跑

  /* ---- 内容脚本 / 后台 ---- */
  { re: /^content\/content\.css$/, aspects: ['visual'] },
  { re: /^content\//, aspects: ['hit', 'interact', 'site'] },      // 入口：启动门禁 + 消息路由
  { re: /^background\//, aspects: ['ui', 'site', 'interact'] },

  /* ---- 管理端页面 ---- */
  { re: /^(options|popup|welcome)\//, aspects: ['ui'] },

  /* ---- 影响面最大：一律全跑 ---- */
  { re: /^manifest\.json$/, aspects: ALL },
  { re: /^(icons|_locales)\//, aspects: ALL }
];

/** 没有规则命中 → 未知文件，按用户口径"不好判断就全量回归" */
function aspectsOf(rel) {
  for (const r of RULES) if (r.re.test(rel)) return { aspects: r.aspects, why: null };
  return { aspects: ALL, why: '未归类文件 → 拿不准，全量回归' };
}

function whyOf(rel) {
  for (const r of RULES) if (r.re.test(rel)) {
    if (r.aspects === ALL) return '影响面大 → 全量';
    if (!r.aspects.length) return '不影响交付行为';
    return r.aspects.join(' + ');
  }
  return '未归类 → 全量';
}

/**
 * 合并多个路径 → 结论。
 * 任一条要求 all → all；否则取并集；一条都没有 → none。
 * **纯函数**：只做字符串判断，不读文件、不碰文件系统 —— 所以可以安全地拿任意路径来验证映射表
 * （`node scripts/impact.js --paths=src/core/renderer.js,popup/popup.js`）。
 */
function combine(paths) {
  if (!paths.length) return { list: [], text: NONE, all: false };
  let all = false;
  const picked = new Set();
  for (const rel of paths) {
    const a = aspectsOf(rel).aspects;
    if (a === ALL) { all = true; break; }
    for (const x of a) picked.add(x);
  }
  if (all) return { list: [ALL], text: ALL, all: true };
  const list = Array.from(picked).sort();
  /* 有改动、但一条方面都没命中（例如只改了 tests/scripts/文档）→ none。
   * 注意**不能**返回空串：调用方会把空串当成"没拿到结论"而兜底成全量回归。 */
  return { list, text: list.length ? list.join(',') : NONE, all: false };
}

/* ---------------- 主流程 ---------------- */

function main() {
  /* 纯查询模式：给一串路径，直接打印映射结果（不读文件、不比对基线）—— 验证映射表用 */
  const pathsArg = ARGV.find((a) => a.indexOf('--paths=') === 0);
  if (pathsArg) {
    const paths = pathsArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    console.log('路径 → 方面映射（纯函数，未读取任何文件）：');
    for (const p of paths) console.log('  ' + p.padEnd(44) + ' → ' + whyOf(p));
    const r = combine(paths);
    console.log('\n合并结论：**' + r.text + '**' + (r.all ? '（含影响面大/未归类的改动 → 全量回归）' : ''));
    process.exit(0);
  }

  const files = walk('.', []).sort();
  const current = {};
  for (const rel of files) { const h = hashOf(rel); if (h) current[rel] = h; }

  if (ARGV.indexOf('--write-baseline') >= 0) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      version: manifest.version,
      fileCount: Object.keys(current).length,
      files: current
    }, null, 2) + '\n', 'utf8');
    console.log('已写入基线：' + BASELINE + '（' + Object.keys(current).length + ' 个文件，版本 ' + manifest.version + '）');
    process.exit(0);
  }

  let base = null;
  try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { base = null; }

  /** 没有基线（首次/被删）→ 无法判断影响面 → 按用户口径全量回归 */
  if (!base || !base.files) {
    if (ARGV.indexOf('--aspects') >= 0) { console.log(ALL); process.exit(0); }
    console.log('变更影响面：**' + ALL + '**（没有基线可比对 → 拿不准，全量回归）');
    console.log('  基线文件：' + BASELINE + (fs.existsSync(BASELINE) ? '' : '（不存在）'));
    console.log('  首次出包成功后会写入基线，之后即可按方面选范围。');
    process.exit(0);
  }

  const changed = [];
  for (const rel of Object.keys(current)) {
    if (!(rel in base.files)) changed.push({ rel, kind: '新增' });
    else if (base.files[rel] !== current[rel]) changed.push({ rel, kind: '修改' });
  }
  for (const rel of Object.keys(base.files)) {
    if (!(rel in current)) changed.push({ rel, kind: '删除' });
  }

  const result = combine(changed.map((c) => c.rel));

  if (ARGV.indexOf('--aspects') >= 0) { console.log(result.text); process.exit(0); }

  /* `--areas`：三级回归范围（区域 → 方面 → 全量），输出**可直接拼给 _e2e/run.js 的参数片段**。
   * 区域表与升级规则都在 `scripts/regression-areas.js`（单一真源，dev 侧选组用的是同一张表）。
   * 约定输出：`--areas=a,b` / `--aspects=x,y` / `--aspects=all` / `none`（调用方原样使用）。 */
  if (ARGV.indexOf('--areas') >= 0) {
    const A = require('./regression-areas');
    const r = A.classify(changed.map((c) => c.rel), (p) => {
      const one = combine([p]);
      return one.all ? 'all' : one.list;             // 复用同一张方面表，不另写一份
    });
    if (r.level === 'none') { console.log('none'); process.exit(0); }
    if (r.level === 'areas' && r.areas.length) { console.log('--areas=' + r.areas.join(',')); process.exit(0); }
    if (r.level === 'aspects' && r.aspects.length) { console.log('--aspects=' + r.aspects.join(',')); process.exit(0); }
    console.log('--aspects=all');
    process.exit(0);
  }

  console.log('变更影响面分析（基线版本 ' + (base.version || '?') + '，比对于 ' + base.generatedAt + '）');
  console.log('');
  if (!changed.length) {
    console.log('  自上次出包以来**没有任何交付相关改动** → 范围 none（真浏览器回归可跳过）');
    process.exit(0);
  }
  console.log('  改动的文件（' + changed.length + ' 个）：');
  for (const c of changed) {
    console.log('    [' + c.kind + '] ' + c.rel.padEnd(44) + ' → ' + whyOf(c.rel));
  }
  console.log('');
  if (result.all) {
    console.log('  结论：**全量回归**（有影响面大/未归类的改动）');
  } else if (!result.list.length) {
    console.log('  结论：**none** —— 只改了测试 / 构建脚本 / 文档，不影响交付行为（真浏览器回归可跳过）');
  } else {
    console.log('  结论方面：**' + result.list.join(' / ') + '**');
    for (const a of result.list) console.log('    · ' + a + ' —— ' + (ASPECTS[a] || '?'));
    console.log('  （Node 单测始终全跑；真浏览器回归只跑覆盖这些方面的组）');
  }
}

/* 只有被直接执行时才跑主流程 —— 被 require 时只导出纯函数，便于安全地验证映射表 */
if (require.main === module) main();

module.exports = { aspectsOf, whyOf, combine, ASPECTS, RULES, ALL, NONE, BASELINE };
