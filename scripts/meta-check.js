/* scripts/meta-check.js — 交付前静态一致性自检（红灯 = 禁止交付）
 *
 * 为什么需要它（而不是"靠人记住"）：
 *   这次重构的每一条返工，追根到底都不是"手滑"，而是**某条约定只存在于文档和记忆里**：
 *     · 高亮路径被写回 splitText + 包 span（v2.0.0 / v2c 的翻页残留原点）
 *     · observer 漏 characterData（原地改 nodeValue 收不到 → 高亮残留）
 *     · 用"移除/新增内容形态"判定自身写入（误杀 td.textContent=新值 → 不重建）
 *     · 清理出现第二个出口（缓存漏清 → el-table 复用 td 后永不恢复）
 *     · 数值默认值用 `||` 把显式 0 吞掉（测试注入 0 失效 → 假绿）
 *     · 版本号在别处又写一遍（meta-check 自己都得跟着改）
 *   所以把这些约定做成**机械红灯**：谁再写回去，`node scripts/meta-check.js` 直接红。
 *
 * 用法：node scripts/meta-check.js
 * 退出码：0 = 绿灯；1 = 有错误（禁止交付）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const errors = [];
const warnings = [];
const passes = [];

function rel2abs(rel) { return path.join(root, rel); }
function read(rel) { return fs.readFileSync(rel2abs(rel), 'utf8'); }
function exists(rel) { return fs.existsSync(rel2abs(rel)); }

/** 收集工程内所有文件（相对路径，正斜杠）
 * 【为什么整目录跳过 vendor/】那里是**第三方原样引入**的代码（OCR 引擎 tesseract.js 及其
 * wasm 胶水，见 vendor/README.md）：它自带版本号、自带 DOM 操作实现，拿我们的红线（版本单一
 * 真源 / 不得 createElement('span') / 不得 splitText 等）去卡它只会产生假红灯，
 * 而这些红线约束的是**我们写的代码**。交付包里 vendor/ 仍然照发（体积与来源有记录）。 */
function walk(dir, filter, out) {
  out = out || [];
  const abs = rel2abs(dir);
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'vendor') continue;
    const rel = dir === '.' ? name : dir + '/' + name;
    const st = fs.statSync(rel2abs(rel));
    if (st.isDirectory()) walk(rel, filter, out);
    else if (!filter || filter(rel)) out.push(rel);
  }
  return out;
}

/** 该行是否是"有效代码"（整行注释不算），返回去掉行尾注释后的代码 */
function codeOf(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return null;
  const code = line.replace(/\s\/\/.*$/, '');
  // 块注释起止同一行的情况（/* ... */）也去掉
  return code.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ok(name) { passes.push(name); }
function bad(name, detail) { errors.push(name + (detail ? '\n      ' + detail : '')); }
function warn(name, detail) { warnings.push(name + (detail ? '\n      ' + detail : '')); }

/** 在若干文件里按行找 pattern，返回 "file:line  code" 列表 */
function findIn(files, pattern, opts) {
  const o = opts || {};
  const hits = [];
  for (const rel of files) {
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = o.raw ? line : codeOf(line);
      if (code == null) return;
      if (pattern.test(code)) hits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
      pattern.lastIndex = 0;
    });
  }
  return hits;
}

const JS_ALL = walk('.', r => r.endsWith('.js') && !r.startsWith('scripts/'));
/* `src/ui/changelog.js` 是**纯文案表**（一条条字符串，没有任何代码路径），
 * 但它会被下面那些"代码模式"红线扫到 —— 实测踩过一次：更新日志里为了说明历史，写了一句
 * `e.target.closest("[data-kh-highlighted]")`（描述 v1.52 的旧判据），
 * 于是"交互定位不得用 closest('.kh-*') 反查"这条红线**误报**，把可交付的包卡住了。
 * 文档里提到某个写法 ≠ 代码里用了它，所以把它从"运行时代码"集合里摘出去。 */
const JS_SRC = walk('src', r => r.endsWith('.js') && !/^src\/ui\/changelog\.js$/.test(r));
const JS_RUNTIME = JS_SRC.concat(walk('content', r => r.endsWith('.js')));

let manifest = null;
try { manifest = JSON.parse(read('manifest.json')); }
catch (err) { bad('manifest.json 解析失败', String(err.message)); }

/* ============================================================ 1. 版本单一真源 */

if (manifest) {
  // 版本号字面量的合法归属只有 manifest 与 changelog；
  // 占位版本 '0.0.0' 是"读不到 manifest 时的降级返回值"，不是第二真源，放行。
  const VERSION_ALLOWED = new Set(['manifest.json', 'src/ui/changelog.js']);
  const VERSION_LITERAL = /['"](\d+\.\d+\.\d+)['"]/g;
  const offenders = [];
  for (const rel of walk('.', r => /\.(js|html|css)$/.test(r))) {
    if (VERSION_ALLOWED.has(rel)) continue;
    // tests/ 里刻意模拟 manifest 版本（垫片 getManifest 返回值），不算第二真源
    if (rel.indexOf('tests/') === 0) continue;
    read(rel).split(/\r?\n/).forEach((line, i) => {
      let m;
      VERSION_LITERAL.lastIndex = 0;
      while ((m = VERSION_LITERAL.exec(line)) !== null) {
        if (m[1] === '0.0.0') continue;                 // 降级占位，不是版本声明
        offenders.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
      }
    });
  }
  if (offenders.length) bad('出现版本号字面量（版本唯一真源是 manifest.json）', offenders.join('\n      '));
  else ok('除 manifest / changelog 外无版本号字面量（0.0.0 降级占位已放行）');

  // changelog 最新版本必须等于 manifest.version（changelog 里写作 'v2.x.y'，manifest 不带 v）
  try {
    const cl = read('src/ui/changelog.js');
    const m = /version:\s*['"]v?(\d+(?:\.\d+){1,3})['"]/.exec(cl);   // 2~4 段：测试版是四段号（1.99.99.1）
    if (!m) warn('无法从 src/ui/changelog.js 解析出最新版本号，跳过一致性比对');
    else if (m[1] !== manifest.version) bad('changelog 最新版本与 manifest.version 不一致', m[1] + ' vs ' + manifest.version);
    else ok('版本一致：v' + manifest.version);
  } catch (err) { warn('changelog 校验跳过：' + err.message); }
}

/* ============================================ 2. 最高优先级铁律：高亮不改 DOM */

const SPLIT_PATTERNS = [
  { re: /\.splitText\s*\(/, desc: 'splitText（把文本节点摘成孤儿 → 翻页残留/新内容进不来）' },
  { re: /\.surroundContents\s*\(/, desc: 'surroundContents（等价于包 span）' },
  { re: /document\.createElement\(\s*['"]span['"]\s*\)/, desc: "createElement('span')（高亮必须用 CSS.highlights，不得造节点）" }
];
const splitHits = [];
for (const p of SPLIT_PATTERNS) {
  splitHits.push.apply(splitHits, findIn(JS_RUNTIME, p.re).map(h => '[' + p.desc + '] ' + h));
}
if (splitHits.length) {
  bad('高亮路径必须"纯视觉、绝不改 DOM"：发现拆/包文本节点的代码', splitHits.join('\n      '));
} else {
  ok('无 splitText / surroundContents / 造 span 的高亮实现（高亮纯视觉成立）');
}

/* ============ 2b. 多命中正则必须带 g（否则只命中第一个分支 / 死循环） ============ */

/**
 * 为什么单列一条红线：
 *   扫描/组合词的核心循环是 `while ((m = re.exec(text)) !== null)`，它靠 `lastIndex` 推进。
 *   正则**缺 `g`** 时 `exec` 每次都返回同一个首个匹配 → 轻则只命中第一个词
 *   （实测：全词 + 正则 `BUG|FEATURE` 只命中 BUG、FEATURE 永远漏，K7），重则 `while` 死循环。
 *   曾经为了躲"lastIndex 状态污染"把 `g` 去掉，把多命中能力整个打掉 —— 这条红线就是那次事故的护栏。
 */
// ① 构造正则的地方必须带 g
const BUILD_PATTERN_FILE = 'src/core/compiler.js';
const bpHits = findIn([BUILD_PATTERN_FILE], /let jsFlags = ['"]{2}\s*;/);
if (bpHits.length) {
  bad('buildPattern 的初始 flags 不能为空（必须含 g，否则多命中遍历只拿到第一个匹配）', bpHits.join('\n      '));
} else if (!/let jsFlags = 'g'/.test(read(BUILD_PATTERN_FILE))) {
  warn('未能在 buildPattern 里识别到 `let jsFlags = \'g\'`，请人工确认多命中前提仍在');
} else {
  ok('buildPattern 初始 flags 含 g（多命中遍历前提成立）');
}

// ② 遍历点必须做 `g` 兜底：出现 `new RegExp(x.pattern.source, x.pattern.flags)` 且同文件有 exec 循环
const TO_LOOP_FILES = ['src/core/scanner.js', 'src/features/combo/combo.js'];
const risky = [];
for (const rel of TO_LOOP_FILES) {
  if (!exists(rel)) continue;
  const src = read(rel);
  const hasLoop = /while\s*\(\(m\s*=\s*\w+\.exec\(/.test(src);
  const hasGuard = /flags\.indexOf\(['"]g['"]\)\s*>=\s*0/.test(src);
  if (hasLoop && !hasGuard) risky.push(rel + '（有 exec 循环但没有 `g` 兜底）');
}
if (risky.length) {
  bad('多命中遍历点必须对 flags 做 `g` 兜底', risky.join('\n      '));
} else {
  ok('多命中遍历点均有 `g` 兜底（scanner / combo）');
}

/* ============ 2c. exec 多命中循环不得依赖 `!re.global` 早退 ============ */

// `if (!re.global) break;` 会让"缺 g"从死循环变成**静默只命中第一个**，更难发现；
// 现在统一用 g 兜底，就不该再需要这种早退。
const earlyBreak = findIn(TO_LOOP_FILES, /if\s*\(!re\.global\)\s*break/);
if (earlyBreak.length) {
  bad('exec 多命中循环不得用 `if (!re.global) break` 掩盖缺 g（应改为确保 g 并遍历全部）', earlyBreak.join('\n      '));
} else {
  ok('exec 多命中循环无 `!re.global` 早退');
}

/* ============================ 3. CSS.highlights.set 只能出现在渲染层一个文件 ============================ */

const HL_SET_ALLOWED = ['src/core/renderer.js'];
const hlSetHits = findIn(JS_RUNTIME, /CSS\.highlights\.(set|delete)\s*\(/)
  .filter(h => !HL_SET_ALLOWED.some(a => h.startsWith(a)));
if (hlSetHits.length) {
  bad('CSS.highlights 的写入只允许出现在 ' + HL_SET_ALLOWED.join(', ') + '（渲染唯一实现）', hlSetHits.join('\n      '));
} else {
  ok('CSS.highlights 写入单源（' + HL_SET_ALLOWED.join(', ') + '）');
}

/* ============================ 3b. 默认文字色不得无条件覆盖网页原色 ============================ */
/* 用户实测场景：网页里本来标红的字，被命中后变成黑色。
 * 根因是 `::highlight` 规则里无条件写 `color`。现在只允许两种写法：
 *   · variant='auto' → **不写 color**（保留原网页文字色）
 *   · variant='fix'  → 写兜底色（原色与底色分不开时，保证看得见）
 *   · 显式字色（关键词/分组设过）→ 照旧强制
 * 这条红线钉住的是"整个渲染层不许再回到无条件写 color 的写法"。 */
if (exists('src/core/renderer.js')) {
  const R = read('src/core/renderer.js');
  /* auto 分支必须产出**空**颜色（＝规则里不写 color）。第一次写的判据只检查了
   * 旧的"无条件拼接"写法，反向验证时把 `color = ''` 改成 `color = style.textColor`
   * 它居然还是绿的 —— 红线太窄。收紧成"分支里必须赋空值"。
   * 注意：真正权威的护栏是 e2e 的行为用例（红字命中后仍落在不带 color 的组），
   * 这条静态检查只做早期预警。 */
  const autoEmpty = /variant\s*===\s*'auto'[\s\S]{0,80}?color\s*=\s*''/.test(R);
  const hasPercept = /MIN_DELTA_E/.test(R) && /readableOn/.test(R);
  const uncond = /::highlight\([^)]*\)\{background-color:'\s*\+\s*style\.bgColor\s*\+\s*';color:/.test(R);
  if (!autoEmpty) bad('renderer 的 auto 分支必须让 color 为空（保留原网页文字色），否则会把网页标红的字刷成黑字');
  else if (!hasPercept) bad('renderer 缺少感知判据（readableOn / MIN_DELTA_E）—— 决定何时该兜底');
  else if (uncond) bad('renderer 仍在无条件写 color（会把网页标红的字刷成黑字）');
  else ok('默认文字色不覆盖网页原色（auto 保留 / fix 兜底，判据 ΔE）');
}

/* ============================ 3c. 跨节点命中：只产出真正跨节点的 ============================ */
/* 用户实测要求：`审核(黑)<span red>不通过</span>` 应当命中「审核不通过」，且两段各自保留颜色。
 * 实现是新增的 `inline-run-regex` 探针（把相邻行内文本节点拼成 run 再匹配）。
 * 红线盯两件事：
 *   ① 探针必须存在（否则"被元素拆开的词"又回到不命中）；
 *   ② **必须跳过单节点命中**（`segs.length < 2` → continue）—— 否则单节点部分会与 node-regex
 *      在同位置双命中，统计与备注重复计数。 */
if (exists('src/core/scanner.js')) {
  const S = read('src/core/scanner.js');
  if (!/inline-run-regex/.test(S)) bad('scanner 缺少跨节点（inline run）探针 —— 被元素拆开的词会不命中');
  else if (!/segs\.length\s*<\s*2[\s\S]{0,60}continue/.test(S)) {
    bad('跨节点探针必须跳过"实际没跨节点"的命中（否则与 node-regex 重复命中/重复计数）');
  } else ok('跨节点命中：仅产出真正跨节点的命中（与单节点探针不重复）');
}

/* ============ 3d. 匹配口径单源（普通词 / 组合词 必须走同一个入口） ============ */
/* 用户口径（2026-09）："组合词只是在核心词上加一个定位的限制。处理逻辑应该统一，
 * 不要反复出现普通词能实现、组合词不行的问题，反之亦然。"
 *
 * 实测事故（v1.99.99.8 修的）：组合词 Probe 自己逐文本节点跑核心词正则，而普通词走的是内核
 * 的跨节点 run 扫描 → 页面把一个词拆成 `<span>来遇</span>见你` 时，普通规则亮、组合规则不亮。
 * 光靠"记得改两边"守不住，所以钉两条静态红线：
 *   ① `src/features/combo/combo.js` 不得自建正则/自建遍历 —— 匹配一律走内核 `util.matchKeyword`
 *      （`new RegExp(` 出现在这里 = 又开了一套匹配实现）；
 *   ② `src/features/combo/cells.js` 不得自建文本节点过滤器（`createTreeWalker` / 自己抄一份
 *      SKIP_TAGS）—— 必须委托内核 `Scanner.util.textNodesIn`，否则"组合词能扫到的文本"
 *      会和普通词不一致。 */
{
  const comboFile = 'src/features/combo/combo.js';
  const cellsFile = 'src/features/combo/cells.js';
  const combo = exists(comboFile) ? read(comboFile) : '';
  const cells = exists(cellsFile) ? read(cellsFile) : '';
  const issues = [];
  if (/new RegExp\s*\(/.test(combo)) {
    issues.push(comboFile + '：出现了自建正则（必须用内核 util.matchKeyword 的匹配口径）');
  }
  if (!/util\.matchKeyword|U\.matchKeyword|\.matchKeyword\s*\(/.test(combo)) {
    issues.push(comboFile + '：没有调用内核 util.matchKeyword（匹配口径必须单源）');
  }
  if (combo && /for\s*\([^)]*\bof\b[^)]*\)\s*\{[\s\S]{0,160}?\.exec\s*\(/.test(combo)) {
    issues.push(comboFile + '：还有自建的 exec 遍历循环（匹配必须交给内核）');
  }
  if (/createTreeWalker/.test(cells)) {
    issues.push(cellsFile + '：自建了文本节点过滤器（必须委托 Scanner.util.textNodesIn）');
  }
  if (!/util\.textNodesIn|U\.textNodesIn|Scanner\.util/.test(cells)) {
    issues.push(cellsFile + '：没有委托内核 textNodesIn（"哪些文本可扫描"必须单源）');
  }
  if (issues.length) {
    bad('普通词与组合词必须共用同一套匹配实现（组合词只是多一个"定位在哪个格子"的限制）', issues.join('\n      '));
  } else {
    ok('匹配口径单源（组合词经内核 util.matchKeyword，不做第二套遍历/过滤）');
  }
}

/* ============ 3e. 后台模块必须挂到 self（service worker 里没有 window） ============ */
/* 实测事故：重写 update-checker 时只写了 window.UpdateChecker —— service worker 里没有 window，
 * 于是 self.UpdateChecker 为 undefined，popup 点「检查更新」永远显示"失败"（用户报的 bug）。
 * 这类"模块没挂上"的错在单测里发现不了（单测直接 require 模块），必须静态兜住。
 * 【2026-10-05】update-checker.js 已随"插件入口取消线上更新"删除；此处改盯仍然存在的后台模块
 * `background/ocr.js`（同一类风险：它必须挂 self.OcrHost，否则 service-worker 里的 OCR 路由取不到它）。 */
if (exists('background/ocr.js')) {
  const OCR = read('background/ocr.js');
  /* 必须是 **非 window** 的挂载（G. / self.）—— 只查子串的话 window.OcrHost 也能蒙混过关 ✗ */
  const assignsNonWindow = /(^|[^.\w])(G|self)\.OcrHost\s*=\s*(\{|OcrHost)/.test(OCR);
  if (!assignsNonWindow) {
    bad('background/ocr.js 必须把 OcrHost 挂到 self（service worker 里没有 window，否则后台取不到它）');
  } else ok('后台模块挂到 self（service worker 可用）');
}


/* ==================== 3d. 交付包不得含私钥/发布目录（安全红线） ==================== */
/* 实测事故：发布脚本在仓库根建 release/ 并放了 key.pem，打包时整包体积翻倍、**私钥被打进分发包**。
 * 这类事故靠记性防不住，必须由代码兜死 —— 这里静态盯住"排除清单里必须有 release 与密钥后缀"。 */
if (exists('scripts/package.js')) {
  const PK = read('scripts/package.js');
  const noRelease = /EXCLUDE_DIRS\s*=\s*\[[^\]]*'release'/.test(PK);
  /* 用**朴素子串**判断，不套正则 —— 嵌套正则的转义本身就是新的出错点（第一版就写错了 ✗） */
  const noKey = PK.indexOf('EXCLUDE_KEY_RE') >= 0 && PK.indexOf('pem') >= 0 && PK.indexOf('crx') >= 0;
  if (!noRelease) bad('打包排除清单缺少 release/ —— 发布产物（含签名私钥）会被打进交付包');
  else if (!noKey) bad('打包缺少"密钥/证书/已签名包一律排除"的兜底规则');
  else ok('交付包排除 release/ 与密钥文件（私钥不可能进包）');
}

/* ============================== 4. 交互定位不得回退到 DOM 反查 ============================== */

const CLOSEST_HITS = findIn(JS_RUNTIME, /closest\s*\(\s*['"][^'"]*kh-[^'"]*['"]/);
if (CLOSEST_HITS.length) {
  bad("交互定位不得用 closest('.kh-*') 反查（命中只存在于注册表，必须走坐标定位）", CLOSEST_HITS.join('\n      '));
} else {
  ok('交互定位无 DOM 反查（closest 反查命中）');
}

if (!/caretPositionFromPoint|caretRangeFromPoint/.test(read('src/core/index.js'))) {
  bad('src/core/index.js 缺少坐标定位（caretPositionFromPoint / caretRangeFromPoint）');
} else {
  ok('坐标定位存在（caretPositionFromPoint → caretRangeFromPoint → 几何兜底）');
}

/* ============================ 5. MutationObserver 必须含 characterData ============================ */

const obsSrc = read('src/core/scheduler.js');
// 允许对象跨行（多行声明），所以按"从 _observerOptions 到其后第一个 }"取块
const obsIdx = obsSrc.indexOf('_observerOptions');
const scannerOpts = obsIdx < 0 ? null : [null, obsSrc.slice(obsIdx, obsSrc.indexOf('}', obsIdx) + 1)];
if (!scannerOpts) {
  bad('src/core/scheduler.js 找不到 _observerOptions（observer 配置单源）');
} else if (!/characterData\s*:\s*true/.test(scannerOpts[1])) {
  bad('MutationObserver 必须带 characterData:true（原地改 nodeValue 不发 childList，漏配 → 高亮残留）',
    scannerOpts[1].trim());
} else {
  ok('MutationObserver 含 characterData:true');
}

// 禁止"用 mutation 形态判定自身写入"的写法
const SHAPE_FILTER = findIn(['src/core/scheduler.js'],
  /removedAllOurs|addedAllText|removedNodes\.every|addedNodes\.every/);
if (SHAPE_FILTER.length) {
  bad('禁止用"移除/新增内容形态"判定自身写入（会把 td.textContent=新值 误杀 → 不重建）', SHAPE_FILTER.join('\n      '));
} else {
  ok('未使用 mutation 形态过滤（自身写入只靠重建抑制窗口 + data-kh-ext-ui 显式标记）');
}

/* ============================ 6. 数值默认值不得用 || 吞掉显式 0 ============================ */

/**
 * 只针对**来自配置的数值项**。判据是"右侧默认值看起来像个毫秒数"（>=100 的整数），
 * 这样 `imgSize || ''`（空串语义，0 不是合法配置）不会被误报，
 * 而 `pageRebuildGapMs || 2000`（把显式 0 吞掉）一定被抓。
 */
const FALSY_ZERO_KEYS = [
  'pageRebuildSilentMs', 'pageRebuildGapMs', 'pageFingerprintIntervalMs'
];
const falsyHits = [];
for (const rel of JS_RUNTIME) {
  read(rel).split(/\r?\n/).forEach((line, i) => {
    const code = codeOf(line);
    if (!code) return;
    for (const k of FALSY_ZERO_KEYS) {
      const re = new RegExp('\\.' + k + '\\s*\\|\\|\\s*(\\d+)');
      const m = re.exec(code);
      if (m && parseInt(m[1], 10) >= 100) {
        falsyHits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
      }
    }
  });
}
if (falsyHits.length) {
  bad('数值配置必须用 `!= null` 取默认值，不能用 `||`（会把显式 0 吞成默认值 → 测试注入失效）',
    falsyHits.join('\n      '));
} else {
  ok('数值配置未用 || 吞 0');
}

/* ============================ 7. 清理只有一个出口 ============================ */

// 除 rebuilder 外，不得直接调用 Renderer.clear()
const clearHits = findIn(JS_RUNTIME, /KH\.Renderer\.clear\s*\(/)
  .filter(h => !h.startsWith('src/core/rebuilder.js'));
if (clearHits.length) {
  bad('视觉清理只能经 Rebuilder.clear（唯一出口）；禁止直接调 Renderer.clear', clearHits.join('\n      '));
} else {
  ok('视觉清理单源（Rebuilder.clear）');
}

// 命中表只能由 registry 自身与门面 index.js 写
const registryAddHits = findIn(JS_RUNTIME, /KH\.registry\.add\s*\(/)
  .filter(h => !h.startsWith('src/core/index.js'));
if (registryAddHits.length) {
  bad('命中注册表只允许门面（src/core/index.js）写入；feature 不得自行登记命中', registryAddHits.join('\n      '));
} else {
  ok('命中注册表写入单源（src/core/index.js）');
}

/* ============================ 8. 废弃配置键不得重新出现 ============================ */

const DEPRECATED = [
  'noteFormat', 'comboFlipped', 'defaultBorderColor', 'defaultBorderWidth', 'defaultBorderRadius'
];
const depHits = [];
for (const rel of JS_RUNTIME) {
  read(rel).split(/\r?\n/).forEach((line, i) => {
    const code = codeOf(line);
    if (!code) return;
    for (const k of DEPRECATED) {
      // 只在"写入 config"的位置算命中：`k: value` 形式；config.js 的 DEPRECATED_KEYS 声明处放行
      if (rel === 'src/core/config.js') continue;
      if (new RegExp('\\b' + k + '\\s*:').test(code)) depHits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
    }
  });
}
if (depHits.length) {
  bad('已废弃的配置键不得再写入/声明（见 策划案 §6 ✚定稿）', depHits.join('\n      '));
} else {
  ok('无废弃配置键回流');
}

/* ============================ 9. 禁止"组合词左右翻转"迁移 ============================ */

const swapHits = findIn(JS_RUNTIME, /_ensureComboMigrated|comboFlipped\s*\)|_flipped\s*=\s*true/);
if (swapHits.length) {
  bad('不得重新实现组合词左右翻转迁移（v1.8.4 已闭环；二次翻转会翻坏已正确的词）', swapHits.join('\n      '));
} else {
  ok('无组合词翻转迁移（存量数据只宽容读取、不改写）');
}

/* ============================ 10. manifest 完整性 ============================ */

if (manifest) {
  const required = ['manifest_version', 'name', 'version', 'description', 'default_locale',
    'icons', 'action', 'options_page', 'background', 'content_scripts', 'permissions',
    'host_permissions', 'commands', 'update_url'];
  const missing = required.filter(k => manifest[k] === undefined);
  if (missing.length) bad('manifest 缺少必需键：' + missing.join(', '));
  else ok('manifest 必需键齐全');

  // 引用的文件都存在
  const refs = [];
  if (manifest.background) refs.push(manifest.background.service_worker);
  if (manifest.options_page) refs.push(manifest.options_page);
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  Object.values(manifest.icons || {}).forEach(v => refs.push(v));
  (manifest.content_scripts || []).forEach(cs => {
    (cs.js || []).forEach(f => refs.push(f));
    (cs.css || []).forEach(f => refs.push(f));
  });
  const badRefs = refs.filter(r => r && !exists(r));
  if (badRefs.length) bad('manifest 引用了不存在的文件', badRefs.join('\n      '));
  else ok('manifest 引用的资源都存在（' + refs.length + ' 项）');

  // content_scripts 里声明的每个 js 都要在仓库里，且顺序必须让依赖先加载
  const csJs = (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js) || [];
  const ORDER_RULES = [
    ['src/core/protocol.js', 'src/core/config.js'],
    ['src/core/config.js', 'src/core/registry.js'],
    ['src/core/registry.js', 'src/core/index.js'],
    ['src/core/index.js', 'src/features/site-rules.js'],
    ['src/features/combo/cells.js', 'src/features/combo/combo.js'],
    ['src/features/combo/combo.js', 'src/features/fetch.js'],
    ['src/features/fetch.js', 'src/features/important-note.js'],
    ['src/features/img-ocr.js', 'src/features/important-note.js'],
    ['src/platform/markdown.js', 'src/features/important-note.js'],
    ['src/features/important-note.js', 'content/content.js']
  ];
  const orderBad = [];
  for (const pair of ORDER_RULES) {
    const a = csJs.indexOf(pair[0]);
    const b = csJs.indexOf(pair[1]);
    if (a < 0 || b < 0) { orderBad.push('清单缺少 ' + (a < 0 ? pair[0] : pair[1])); continue; }
    if (a > b) orderBad.push(pair[0] + ' 必须在 ' + pair[1] + ' 之前');
  }
  if (orderBad.length) bad('content_scripts 加载顺序不满足依赖', orderBad.join('\n      '));
  else ok('content_scripts 加载顺序满足依赖');

  // 权限使用情况
  const allRuntime = JS_RUNTIME.concat(walk('background', r => r.endsWith('.js'))).map(read).join('\n');
  (manifest.permissions || []).forEach(p => {
    const used = p === 'storage' ? /chrome\.storage/.test(allRuntime)
      : p === 'alarms' ? /chrome\.alarms/.test(allRuntime)
        : true;
    if (!used) warn('声明了但没用到权限：' + p);
  });
  if ((manifest.permissions || []).indexOf('storage') < 0) bad('缺少 storage 权限');
} else {
  bad('缺少 manifest.json');
}

/* ============ 10b. 交付目录不得含 `_` 开头的路径（Chromium 加载前提） ============
 * Chrome / Edge / 华为浏览器（都是 Chromium 系）加载未打包扩展时**拒绝**任何以 `_` 开头的
 * 文件或目录名，只有 Chrome 自己保留的 `_locales` / `_metadata` 例外。
 * 用户实测踩到过：把工作区根目录（含 `_audit` / `_stage` / `_e2e` / `_tools`）当扩展目录选进去，
 * 直接报 "Cannot load extension with file or directory name _audit"。
 * 这条守的是**交付目录自身**：工程里一旦长出 `_dump/` 或 `_tmp.js`，出包即红灯
 * （package.js 的 walk() 只挡了顶层 `_` 文件，`_` 目录会漏网，所以在源头兜住）。
 */
const SHIP_EXCLUDE = ['tests', 'scripts', 'dist', 'node_modules', '.git'];
(function checkUnderscorePath() {
  const badPaths = [];
  const scan = (dir) => {
    const abs = rel2abs(dir);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const r = dir === '.' ? name : dir + '/' + name;
      if (SHIP_EXCLUDE.indexOf(r) >= 0) continue;
      if (fs.statSync(rel2abs(r)).isDirectory()) {
        if (name[0] === '_' && name !== '_locales' && name !== '_metadata') badPaths.push(r + '/');
        scan(r);
      } else if (name[0] === '_') {
        badPaths.push(r);
      }
    }
  };
  scan('.');
  if (badPaths.length) {
    bad('交付目录含 `_` 开头的路径 —— Chromium 系浏览器会拒绝加载扩展：\n      ' + badPaths.join('\n      '));
  } else {
    ok('交付目录无 `_` 开头的路径（Chromium 加载前提成立）');
  }
})();

/* ============================ 11. UI 契约：字段单源 + 保存往返 ============================ */

if (exists('src/ui/fieldmap.js')) {
  const fm = read('src/ui/fieldmap.js');
  // KEYWORD_FIELDS 必须仍是唯一声明：别处不得再写一份字段数组
  const second = findIn(JS_SRC.filter(r => r !== 'src/ui/fieldmap.js'), /KEYWORD_FIELDS\s*=\s*\[/);
  if (second.length) bad('关键词字段清单必须只有 src/ui/fieldmap.js 一份', second.join('\n      '));
  else ok('关键词字段清单单源（src/ui/fieldmap.js）');

  if (!/function roundTrip/.test(fm)) bad('fieldmap 缺少 roundTrip（保存往返校验）');
  else ok('保存往返校验存在（字段↔控件不对称会被当场抛错）');

  /**
   * 分区必须有合法的 `col`（弹窗分列打包用）。
   * 缺了会被兜成第 1 列 → 某一列被塞满、另外两列空着，"矮卡片拼一列"的效果就没了；
   * 所以这里必须每条都有、且落在 1..3。
   */
  const COL_MAX = 3;
  const secRows = (fm.match(/\{\s*id:\s*'[a-z]+',\s*title:[^}]*\}/g) || []);
  const colBad = secRows.filter((s) => {
    const m = /col:\s*(\d+)/.exec(s);
    return !m || Number(m[1]) < 1 || Number(m[1]) > COL_MAX;
  });
  if (!secRows.length) bad('读不到 FORM_SECTIONS 条目（正则失配，需同步 meta-check）');
  else if (colBad.length) bad('FORM_SECTIONS 有分区缺少合法的 col（1..' + COL_MAX + '）：\n      ' + colBad.join('\n      '));
  else ok('分区列位齐全（' + secRows.length + " 节都有 col，弹窗按列打包）");

  /**
   * 匹配开关的**胶囊文案必须与 chip.js 的 PARTS 逐字一致**。
   * 同一批开关在四处露面：关键词表格的「核心词匹配 / 标题词匹配」列、悬停 tooltip、
   * 批量设置、编辑弹窗。四处四套说法（旧版弹窗写「区分大小写 / 全词匹配 / 正则表达式」，
   * 表格写「大小写 / 全词 / 正则」）就是"同一件事两处不一样"的典型 —— 用户实测提出来了。
   * 这里把它变成机械约束：后续谁改了任一处，出包即红灯。
   */
  if (exists('src/ui/components/chip.js')) {
    const chipSrc = read('src/ui/components/chip.js');
    const partLabels = {};                       // key -> 胶囊文案
    const reChip = /\{\s*key:\s*'([a-zA-Z]+)',\s*label:\s*'([^']+)'/g;
    let cm;
    while ((cm = reChip.exec(chipSrc)) !== null) partLabels[cm[1]] = cm[2];
    // fieldmap 里的字段是多行对象，按 `key:` 切块，块内找 label / chip
    const blocks = fm.split(/\{\s*key:\s*'/).slice(1);
    const drift = [];
    for (const b of blocks) {
      const key = /^([a-zA-Z]+)'/.exec(b);
      const label = /label:\s*'([^']+)'/.exec(b);
      if (!key || !label) continue;
      if (!/\bchip:\s*true/.test(b)) continue;   // 只有胶囊字段要求文案一致
      // 注意 `key` 是正则匹配数组，键名在 `key[1]`（写成 key.key 会恒为 undefined → 判据永不触发）
      const k = key[1];
      if (partLabels[k] && partLabels[k] !== label[1]) {
        drift.push(k + '：fieldmap「' + label[1] + '」≠ chip.js「' + partLabels[k] + '」');
      }
    }
    if (!Object.keys(partLabels).length) bad('读不到 chip.js 的 PARTS 文案（正则失配，需同步 meta-check）');
    else if (drift.length) bad('匹配开关胶囊文案在两处不一致（表格列与编辑弹窗必须同一套说法）：\n      ' + drift.join('\n      '));
    else ok('匹配开关胶囊文案单源（fieldmap ↔ chip.js PARTS 一致，' + Object.keys(partLabels).length + ' 项）');
  }

  // fetchLabels 必须读自己的输入框：editor 里不得出现 cvInput.value.split 赋给 fetchLabels 的写法
  // （字段控件已抽到 components/fields.js，所以两个文件都要查 —— 只查一个会变成"看着有红线其实没覆盖"）
  if (exists('src/ui/components/keyword-editor.js')) {
    const ed = read('src/ui/components/keyword-editor.js') + read('src/ui/components/fields.js');
    if (/fetchLabels[\s\S]{0,120}(cvInput|cv\w*Input)\.value/.test(ed)) {
      bad('fetchLabels 疑似读了标题词输入框（附录A §7 串位 bug）');
    } else {
      ok('无 fetchLabels ↔ 标题词输入框串位写法');
    }
  }
  /* 字段控件的 id 契约：必须集中在共享工厂里生成，且 label 绑 for。
   * 分散到各表单各写一份，就会出现"某一边的控件没有 id、外部定位不到"（分组弹窗就漏过）。 */
  if (exists('src/ui/components/fields.js')) {
    const F = read('src/ui/components/fields.js');
    const okId = /id\s*=\s*\(c\.idPrefix \|\| 'fld-'\)\s*\+\s*spec\.key/.test(F);
    const okFor = /for:\s*id/.test(F);
    if (!okId) bad('fields.js 未统一生成 id="<idPrefix><key>"（外部按 id 逐字段定位的契约）');
    else if (!okFor) bad('fields.js 的 label 未绑定 for（无障碍 + 点标签聚焦）');
    else ok('字段 id 契约单源（fields.js 统一生成 id + label for）');
    // 分组弹窗必须走共享工厂，不许再手写控件
    if (exists('options/options.js')) {
      const O = read('options/options.js');
      const gStart = O.indexOf('function openGroup');
      const gEnd = O.indexOf('/* ==================================================================== ③', gStart);
      const seg = gStart >= 0 && gEnd > gStart ? O.slice(gStart, gEnd) : '';
      if (!seg) bad('找不到 openGroup 片段（meta-check 的定位标记可能已失效）');
      else if (!/ui\.Fields\.create/.test(seg)) bad('分组弹窗必须用共享字段工厂 ui.Fields.create 渲染控件（不许手写第二套）');
      else if (/kh-check/.test(seg)) bad('分组弹窗还在用旧的勾选框样式（.kh-check），应统一为开关胶囊');
      else ok('分组弹窗与关键词弹窗共用字段工厂（控件形态不会各自漂移）');
      /* 【已确认的允许差异】用户 2026-09 拍板：分组弹窗**保持 md 宽度、不加分区卡片**，理由是
       * 原版 1.52.0 的分组弹窗本来就是 modal-sm + .form-group 平铺，只有一张卡的量。
       * 钉成红线是为了防止以后"统一大扫除"顺手改掉 —— 要改必须先改这条判据（即先有决定）。 */
      if (seg) {
        const why = '分组弹窗刻意与关键词弹窗不同（用户已确认）：原版 1.52.0 就是 modal-sm + 无分区卡片，'
          + '只有一张卡的量。要改请先更新这条红线与 设计偏好.md 的"已确认的允许差异"。';
        if (!/size:\s*'md'/.test(seg)) bad('分组弹窗宽度应保持 md（' + why + '）');
        else if (/kh-editor-sec['"\s]/.test(seg)) bad('分组弹窗不该加分区卡片（' + why + '）');
        else ok('分组弹窗保持「md 宽度 + 无分区卡片」的既定差异（用户已确认）');
      }
    }
  } else {
    bad('缺少 src/ui/components/fields.js（表单字段控件的唯一实现）');
  }

  /* 【跨界面一致性】options.js 里**不许再手写字段容器**。
   * 用户 2026-09 明确要求"样式控件统一"；历史上每个弹窗各写一套的结果就是
   * 批量弹窗/站点规则/备注卡片样式落后于关键词弹窗（勾选框、旧色块、没有 id/for）。
   * 全部字段必须经 `ui.Fields.create`（+ `ui.Fields.layout`）出来。 */
  if (exists('options/options.js')) {
    const O = read('options/options.js');
    const hand = [];
    const pats = [
      [/class:\s*'kh-fld'/, "手写字段容器 class:'kh-fld'"],
      [/class:\s*'kh-fld-label'/, "手写字段标签 class:'kh-fld-label'"],
      [/class:\s*'kh-check'/, "旧勾选框 class:'kh-check'"]
    ];
    for (const [re, desc] of pats) if (re.test(O)) hand.push(desc);
    if (hand.length) bad('options.js 仍在手写字段控件（' + hand.join('；') + '）；应一律走 ui.Fields.create + ui.Fields.layout');
    else ok('options.js 无手写字段控件（全部经 ui.Fields 工厂，控件形态不会各自漂移）');
  }
} else {
  bad('缺少 src/ui/fieldmap.js');
}

/* ============================ 12. 抓取「多行内容」契约 ============================ */
/* 重要笔记面板的默认位置：**左上角**（v1.52.0 口径）。
 * 红线理由：v2 曾照`策划案`三处"页面右上角"改成右上角，用户实测后确认预期是左上角。
 * 规格那三处属过时口径 —— 钉住它是为了防止以后又来一次"照规格对齐"。要改先改这条判据。 */
if (exists('src/features/important-note.js')) {
  const IN = read('src/features/important-note.js');
  const m = IN.match(/setDefaultPosition\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
  if (!m) bad('找不到 important-note.js 的 setDefaultPosition（meta-check 定位标记可能已失效）');
  else if (/innerWidth\s*-/.test(m[1])) bad('重要笔记面板默认位置被改成了右侧；应为左上角（v1.52.0 口径，用户已确认；策划案那三处"右上角"是过时口径）');
  else if (!/left:\s*gap/.test(m[1])) bad('重要笔记面板默认位置应显式写成左上角 `{ left: gap, top: gap }`');
  else ok('重要笔记面板默认左上角（v1.52.0 口径；策划案"右上角"已作废）');
}

if (exists('src/features/fetch.js')) {
  const f = read('src/features/fetch.js');
  const must = [
    ['cellVisualText', '视觉行提取（flex 同行合并 / 真实换行保留）'],
    ['collectRightBlock', 'rowspan 合并块抓取'],
    ['rowsToTableHtml', '多行表格渲染（两级分组）'],
    ['triggerOk', '仅抓取触发判据'],
    ['#\\s*1', 'fetchLabels 的 #1 简单模式'],
    ['[|｜,，]', '抓取字段多分隔符']
  ];
  const miss = must.filter(([re]) => !new RegExp(re).test(f)).map(([, d]) => d);
  if (miss.length) bad('src/features/fetch.js 缺少既有抓取能力：' + miss.join('；'));
  else ok('抓取单源能力齐全（视觉行/合并块/多行表格/触发判据/#1/多分隔符）');

  /**
   * 触发判据的「控件不算内容」契约（用户明确要求：右格只有按钮 → 不当成有内容）。
   * 三条缺一不可，否则会静默回退成"按钮文字也算内容"：
   *   ① `triggerOk` 自己要先排除"右邻格本身就是控件"；
   *   ② 弱信号类名表（opt-col / operate / caozuo / cell-ops …）要在；
   *   ③ 弱信号必须配"整段文字都是操作词"的守卫，否则会把
   *      `<div class="edit-area">南京市</div>` 这类"类名像操作、装的是正文"的容器整段删掉（丢内容）。
   */
  const ctrlMust = [
    [/isInteractive\(nx\)/, 'triggerOk 未排除"右邻格本身就是控件"'],
    [/WEAK_ACTION_CLS/, '缺少弱控件类名表（操作列 class 识别）'],
    [/ACTION_LABELS/, '缺少"整段文字都是操作词"守卫（会把正文容器误删）'],
    [/javascript:/, '缺少 javascript: 伪协议操作链接识别'],
    [/isPlaceholderText\(right\)/, 'triggerOk 未与"下一字段"判据共用 isPlaceholderText（空值口径会漂移）'],
    [/PLACEHOLDER_WORDS/, '缺少文字占位串词表（无 / 暂无 / N/A / null）']
  ];
  const ctrlMiss = ctrlMust.filter(([re]) => !re.test(f)).map(([, d]) => d);
  if (ctrlMiss.length) bad('抓取触发判据的"控件不算内容"契约被破坏：' + ctrlMiss.join('；'));
  else ok('触发判据排除控件/按钮（含操作列 class 与"整段是操作词"守卫）');
} else {
  bad('缺少 src/features/fetch.js（抓取唯一实现）');
}

// 多行展示必须保留换行
const preWrapFiles = [
  ['src/features/important-note.js', /white-space:\s*pre-(line|wrap)/],
  ['src/features/note-card.js', /white-space:\s*pre-(line|wrap)/]
];
for (const [rel, re] of preWrapFiles) {
  if (!exists(rel)) { bad('缺少 ' + rel); continue; }
  if (!re.test(read(rel))) bad(rel + ' 的多行容器缺少 white-space: pre-line/pre-wrap（\\n 会被折叠成一空格）');
  else ok(rel + ' 保留换行（pre-line/pre-wrap）');
}

/* ================= 12b. 抓取表格「首行不是表头」着色契约 =================
 * 为什么单列一条红线：
 *   抓取表格的第一行是**数据**（[字段 label][二级标题/分组标题][内容]），
 *   而 Markdown / 富文本表格的第一行**是**表头。两者共用 `.kh-table` 时，
 *   一条 `.kh-table tr:first-child td { background: … }` 会把
 *   「基本信息 / 驳回字段：X / 32位包:」全刷上底色 —— 用户实测反馈过
 *   "为什么每列第一个单元格都标了底色"。着色只能落在字段 label 格上。
 */
if (exists('src/features/fetch.js')) {
  const fj = read('src/features/fetch.js');
  if (fj.indexOf('kh-table-fetch') < 0) {
    bad('src/features/fetch.js 的抓取表格缺少 kh-table-fetch 标记类（会被"首行当表头"着色误伤）');
  } else if (fj.indexOf('kh-table-label') < 0) {
    bad('src/features/fetch.js 未给字段 label 格打 kh-table-label（列标题无处着色）');
  } else {
    ok('抓取表格带 kh-table-fetch / kh-table-label 标记（首行不着色）');
  }
}

if (exists('content/content.css')) {
  const cc = read('content/content.css');
  // 允许的写法：`.kh-table:not(.kh-table-fetch) tr:first-child td`
  // 判据要精确：`(?![\w:.-])` 避免把 `.kh-table-fetch` / `.kh-table:not(...)` 误当成无差别写法
  const badFirstRow = /\.kh-table(?![\w:.-])\s+tr:first-child/.test(cc);
  if (badFirstRow) {
    bad('content/content.css 存在无差别的 `.kh-table tr:first-child td` 表头着色 —— ' +
        '会把抓取表格的首行（真实数据）也刷上底色，必须写成 `.kh-table:not(.kh-table-fetch) tr:first-child td`');
  } else if (!/\.kh-table\s+\.kh-table-label/.test(cc)) {
    bad('content/content.css 缺少 `.kh-table .kh-table-label` 着色（字段 label 格应作为列标题着色）');
  } else {
    ok('表头着色只作用于真表头（Markdown/富文本），抓取表格只给字段 label 格上色');
  }
}

/* ============================ 13. 重要笔记聚合契约 ============================ */

if (exists('src/features/important-note.js')) {
  const ino = read('src/features/important-note.js');
  const aggMust = [
    ['tagHtml', '标签形态聚合（🔖 标题 → 关键词）'],
    ['🔖', '标签前缀'],
    ['dblclick', '双击收起/展开'],
    ['khin-fab', '圆形 FAB 收起态'],
    ['ignored', '单条关闭（本次会话）'],
    ['importantNote', '面板读的是重要笔记而不是备注']
  ];
  const miss = aggMust.filter(([re]) => ino.indexOf(re) < 0).map(([, d]) => d);
  if (miss.length) bad('重要笔记面板缺少既有能力：' + miss.join('；'));
  else ok('重要笔记能力齐全（内容分卡/标签聚合/FAB/单条关闭）');
  /* 【2026-09-22 删除一条自相矛盾的僵尸检查（K72 / R0）】
   * 这里原本是 `if (!/innerWidth - w - gap|innerWidth - width/.test(ino)) warn('面板默认位置疑似不在右上角（策划案 §3.4）')`。
   * 两个问题：① 它与上面第 645-653 行的**红线**（"必须是左上角"，用户已确认）**方向相反**，是策划案过时口径的残留；
   * ② 它**永远不触发**——不是因为面板在右边，而是因为 `important-note.js` 里拖动限位那行
   * `Math.max(8, window.innerWidth - width - 8)` 恰好命中了这个正则 ⇒ 这条检查一直是空转的死代码。
   * 删掉它不影响任何判定（`warn` 从未触发，通过数仍是 46），但留着迟早有人"照它把面板改回右上角"。 */
}

/* ============================ 14. 样式不得硬编码色值 ============================ */

const CSS_FILES = walk('src', r => r.endsWith('.css')).concat(walk('.', r => r.endsWith('.css') && (r.startsWith('options/') || r.startsWith('popup/') || r.startsWith('welcome/') || r.startsWith('content/'))));
const colorHits = [];
for (const rel of CSS_FILES) {
  if (rel === 'src/ui/tokens.css') continue;
  // 先整体去掉 /* ... */ 注释，避免把注释里提到的 rgba() 当成实际色值
  const css = read(rel).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  css.split(/\r?\n/).forEach((line, i) => {
    // 允许：① 自定义属性**声明**（--xxx: #hex —— 这些就是 token 定义处）
    //       ② 纯黑/纯白 rgba 叠加（阴影、遮罩）
    if (/^\s*--[a-z0-9-]+\s*:/i.test(line)) return;
    const m = line.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g);
    if (!m) return;
    const allNeutral = m.every(s => /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(s) || /^rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)]/.test(s));
    if (!allNeutral) colorHits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
  });
}
if (colorHits.length) warn('CSS 中出现硬编码色值（建议改用 tokens.css 变量）', colorHits.slice(0, 20).join('\n      '));
else ok('CSS 无硬编码色值（除 tokens.css）');

/* ============================ 15. 游离文件 / 测试资产 ============================ */

const TESTS = walk('tests', r => /\.(js|html)$/.test(r));
if (!TESTS.length) warn('没有测试资产（tests/），重构缺少回归网');
else ok('测试资产 ' + TESTS.length + ' 个');

/* ============================ 16. 语法自检（防止手改后残留半句） ============================ */

let syntaxBad = 0;
for (const rel of JS_ALL.concat(walk('background', r => r.endsWith('.js'))).concat(walk('scripts', r => r.endsWith('.js')))) {
  try {
    // 只做语法检查，不执行
    new Function(read(rel).replace(/^\s*importScripts\([^)]*\);?/gm, ''));
  } catch (err) {
    // content script / 带 IIFE 的模块用 new Function 可能因顶层 return 报错，忽略该情况
    if (/return/i.test(String(err.message)) && /^\s*return/m.test(read(rel))) continue;
    syntaxBad++;
    bad('语法检查失败：' + rel, String(err.message));
  }
}
if (!syntaxBad) ok('JS 语法自检通过（' + JS_ALL.length + ' 个文件）');

/* ============================ 17. 版本/构建信息一致 ============================ */

if (exists('src/build-info.js')) ok('存在 src/build-info.js（构建时间徽标）');
else warn('缺少 src/build-info.js（帮助页"构建时间"会显示 —）');

/* ------------------------------------------------------------------ 输出 */

console.log('\n=== meta-check · 关键词高亮 v2 ===\n');
passes.forEach(p => console.log('  ✓ ' + p));
if (warnings.length) console.log('');
warnings.forEach(w => console.log('  ⚠ ' + w));
if (errors.length) console.log('');
errors.forEach(e => console.log('  ✗ ' + e));
console.log('\n通过 ' + passes.length + ' · 警告 ' + warnings.length + ' · 错误 ' + errors.length);

if (errors.length) {
  console.log('\n红灯：禁止交付。\n');
  process.exit(1);
}
console.log('\n绿灯。\n');
