/* scripts/package.js — 交付打包（zip 解压包）
 *
 * 用法：node scripts/package.js
 * 产物：dist/keyword-highlighter-v<manifest.version>.zip
 *
 * 为什么要脚本而不是手敲 zip：
 *   ① 打包前**强制**先跑 meta-check + 单测，红灯直接中止（防止把红灯版本交给用户）；
 *   ② 排除测试与工具（tests/ scripts/ dist/ 以及 *.md），只装扩展真正需要的东西；
 *   ③ 版本号从 manifest 读，避免"包名版本 ≠ 扩展版本"；
 *   ④ 包内统一多一层 `keyword-highlighter-extension/` 目录，解压即覆盖同一文件夹。
 *
 * 交付方式（用户既定）：zip 解压覆盖同一文件夹 → chrome://extensions 点 ⟳ 重新加载。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');       // latest.json 里的 sha256（与更新检测的校验口径一致）
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');               // runGate 用**临时文件**收子进程输出（不用管道：受限沙箱会拒 spawn 的管道，EPERM）

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VERSION = MANIFEST.version;
const PREFIX = 'keyword-highlighter-extension';

/** 不进入交付包的目录（相对仓库根，正斜杠） */
const EXCLUDE_DIRS = ['tests', 'scripts', 'dist', 'release', 'node_modules', '.git', '.github'];   // release/ 含签名私钥，绝不能进交付包
const EXCLUDE_FILE_RE = /\.(md|log|map)$/i;
/** 私钥 / 证书 / 已签名包**一律不进交付包**。
 *  实测踩到过一次：发布脚本在仓库根建了 release/ 并在里面放了 key.pem，
 *  结果整包体积翻倍、**私钥被打进了分发包** —— 这类事故必须由代码兜死，不能靠记性。 */
const EXCLUDE_KEY_RE = /\.(pem|key|p12|pfx|crx|jks)$/i;
/** 凭据文件也绝不进交付包（万一有人把 token 放在仓库里） */
const EXCLUDE_TOKEN_RE = /(^|[._-])gh[_.-]?token|token.*\.txt$|^\.env/i;

/* ---------------- 应急开关 ----------------
 * 说明：这两个开关**只在真有急事时用**，平时出包必须让门禁全绿。
 * （旧版本这里没有任何参数解析，release-beta.js 传进来的 --skip-gates 被静默忽略 —— 已修） */
const ARGV = process.argv.slice(2);
const SKIP_GATES = ARGV.indexOf('--skip-gates') >= 0;   // 应急：连 meta-check / 单测 / integrity 一起跳过
const SKIP_E2E = ARGV.indexOf('--skip-e2e') >= 0;       // 应急：只跳真浏览器回归
const FORCE_FULL = ARGV.indexOf('--full') >= 0;         // 不信影响面结论时：强制全跑真浏览器回归

/** 真浏览器回归需要本机有 Chromium 系浏览器（找不到就明确警告并跳过，不静默） */
function findBrowser() {
  const cands = [
    process.env.KH_CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ } }
  return null;
}

function walk(dir, out) {
  const abs = path.join(ROOT, dir);
  for (const name of fs.readdirSync(abs)) {
    const rel = dir === '.' ? name : dir + '/' + name;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.includes(rel)) continue;
      walk(rel, out);
    } else {
      if (EXCLUDE_FILE_RE.test(rel)) continue;
      if (EXCLUDE_KEY_RE.test(rel)) continue;          // 私钥/证书/签名包
      if (EXCLUDE_TOKEN_RE.test(rel)) continue;        // 凭据文件
      if (/^_/.test(path.basename(rel))) continue;      // 临时/调试文件
      out.push(rel);
    }
  }
  return out;
}

function copyInto(fromRel, toRoot) {
  const src = path.join(ROOT, fromRel);
  const dst = path.join(toRoot, PREFIX, fromRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/* ---------------- 回归数字：只认本次打包**实测**到的门禁输出 ----------------
 * 用户 2026-10-04 裁决：发布文案里的回归数字「自动调整，不写死」。
 * 真源 = 本次打包**实际执行**的门禁进程 stdout 汇总行，而不是任何手写数字或存档文件：
 *   meta-check.js → `通过 N · 警告 M · 错误 E`（N = 机械红线项数）
 *   tests/run.js  → `通过 N · 失败 M`（单测条数）
 *   _e2e 真机两层 → 标题 `内容层真浏览器测试` / `UI 层真浏览器测试` 之后的 `通过 N · 失败 M`
 * 读不到的项**不写**；一项都读不到就整条【回归】不加（宁缺毋假，不留占位符）。 */
const GATE = { meta: '', unit: '', e2e: '' };
let gateSeq = 0;

/** 跑一个门禁脚本并**捕获**输出（原来用 stdio:'inherit'，数字读不回来）。
 *  输出照旧原样回显；退出码非 0 时抛出 —— 调用处的 try/catch 与旧行为完全一致。
 *  ⚠ 刻意**不用管道**：Windows 沙箱等受限环境下 spawn 的管道会被拒（实测 spawnSync EPERM），
 *    所以把 stdout/stderr 重定向到临时文件再读回。代价是回显变成"跑完一次性贴出"（非流式）。 */
function runGate(scriptPath, args, cwd) {
  const outFile = path.join(os.tmpdir(), 'kh-gate-' + process.pid + '-' + (gateSeq++) + '.out');
  const errFile = outFile.replace(/\.out$/, '.err');
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [scriptPath].concat(args || []), {
      cwd: cwd || ROOT, stdio: ['ignore', fdOut, fdErr], maxBuffer: 64 * 1024 * 1024
    });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  let out = '';
  let err = '';
  try { out = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* 读不到就当没有 */ }
  try { err = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* 读不到就当没有 */ }
  try { fs.rmSync(outFile, { force: true }); fs.rmSync(errFile, { force: true }); } catch (e) { /* 清理失败不影响出包 */ }
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(scriptPath + ' 退出码 ' + r.status);
  return out;
}

/** 拼【回归】行：读不到的项不写，全读不到返回 null（调用方据此**不加**这一行） */
function regressionLine() {
  const pick = (text, re) => { const m = String(text).match(re); return m ? Number(m[1]) : null; };
  const parts = [];

  /* 单测条数：tests/run.js → `通过 N · 失败 M`（可带 ` · 跳过 K`） */
  const units = pick(GATE.unit, /通过 (\d+) · 失败 \d+/);
  if (units !== null) parts.push('单测 **' + units + '** 条');

  /* 机械红线项数：meta-check.js → `通过 N · 警告 M · 错误 E` */
  const reds = pick(GATE.meta, /通过 (\d+) · 警告 \d+ · 错误 \d+/);
  if (reds !== null) parts.push('机械红线 **' + reds + '** 项');

  /* 真机两层共用同一个累加器（_e2e/t.js 的 results），所以：
   *   内容层 = 「内容层真浏览器测试」之后的通过数；
   *   UI 层  = 「UI 层真浏览器测试」之后的通过数 − 内容层（**推导量**，不是直接读数）。
   * 任一层没跑（数 0 / 标题缺失 / --skip-e2e）就**整项不写**，不写 0 冒充结果。 */
  const mC = GATE.e2e.match(/内容层真浏览器测试[\s\S]*?通过 (\d+) · 失败 \d+/);
  const mU = GATE.e2e.match(/UI 层真浏览器测试[\s\S]*?通过 (\d+) · 失败 \d+/);
  if (mC && mU) {
    const c = Number(mC[1]);
    const u = Number(mU[1]) - c;
    if (c > 0 && u > 0) parts.push('真浏览器回归 **内容层 ' + c + ' + UI 层 ' + u + '**');
  }

  if (!parts.length) return null;
  return '【回归】' + parts.join(' · ') + '（本次打包实测，未跑到的项不列）';
}

function main() {
  console.log('=== 交付前自检 ===\n');
  if (SKIP_GATES) console.error('⚠️ --skip-gates：已跳过 meta-check / 单测 / integrity（仅限应急，别当常规手段）');

  // ① meta-check（红灯禁止出包）
  try {
    if (!SKIP_GATES) GATE.meta = runGate(path.join(ROOT, 'scripts/meta-check.js'));
  } catch (err) {
    console.error('\n✗ meta-check 红灯，禁止打包。');
    process.exit(1);
  }

  // ② 单测
  console.log('');
  try {
    if (!SKIP_GATES) GATE.unit = runGate(path.join(ROOT, 'tests/run.js'));
  } catch (err) {
    console.error('\n✗ 单测失败，禁止打包。');
    process.exit(1);
  }

  // ②b 结构一致性（脚本/id/CSS 变量引用是否都成立）
  console.log('');
  try {
    if (!SKIP_GATES) execFileSync(process.execPath, [path.join(ROOT, 'tests/integrity.js')], { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    console.error('\n✗ 结构一致性检查失败，禁止打包。');
    process.exit(1);
  }

  // ②c 真浏览器回归（**用户规矩：改到哪个方面就回归哪个方面；不好判断就全量**）
  /* 两层保障：
   *   ① 与 meta-check / 单测 / integrity 同级 —— 红灯禁止打包（应急用 --skip-e2e）；
   *   ② **回归范围由 scripts/impact.js 按本次真实改动算**（基线哈希比对，无需 git）：
   *      它把改动文件映射到**方面**（hit 命中 / visual 渲染 / interact 交互 / fetch 抓取 /
   *      site 站点门禁 / ui 管理端 / data 数据层 / update 更新通道），再交给 e2e 按方面裁组；
   *      只动测试/脚本/文档 → none（不跑浏览器层）；
   *      **拿不准一律 all**（未知文件 / 影响面大的文件 / 没有基线）。--full 可强制全跑。 */
  let e2eSelector = '--aspects=all';        // 传给 _e2e/run.js 的**选择器片段**（区域 / 方面 / 全量）
  if (!SKIP_E2E) {
    console.log('\n=== 变更影响面（scripts/impact.js）===');
    try {
      console.log(execFileSync(process.execPath, [path.join(ROOT, 'scripts/impact.js')], { encoding: 'utf8', cwd: ROOT }).trim());
      /* `--areas` 输出三级结论的"选择器片段"：`--areas=a,b` / `--aspects=x,y` / `--aspects=all` / `none`。
       * 三级顺序（区域 → 方面 → 全量）与区域表都在 scripts/regression-areas.js（单一真源）。 */
      const sel = execFileSync(process.execPath, [path.join(ROOT, 'scripts/impact.js'), '--areas'], { encoding: 'utf8', cwd: ROOT }).trim();
      e2eSelector = sel || '--aspects=all';
    } catch (e) {
      console.error('⚠️ 影响面分析失败，保守按全量处理：' + (e && e.message));
      e2eSelector = '--aspects=all';
    }
    if (FORCE_FULL) { console.log('\n--full：忽略影响面结论，强制全跑'); e2eSelector = '--aspects=all'; }
  }

  if (SKIP_E2E) {
    console.error('\n⚠️ --skip-e2e：已跳过真浏览器回归（这一步本应必过）');
  } else if (e2eSelector === 'none') {
    console.log('\n本次变更不涉及交付行为（none）→ 跳过真浏览器回归。');
  } else {
    console.log('\n=== 真浏览器回归（_e2e/run.js ' + e2eSelector + '）===');
    const e2eDir = path.join(ROOT, '..', '..', '_e2e');
    const e2eRun = path.join(e2eDir, 'run.js');
    if (!fs.existsSync(e2eRun)) {
      console.error('⚠️ 找不到 ' + e2eRun + '，跳过真浏览器回归（这一步本应必过，请检查工作区是否完整）');
    } else if (!findBrowser()) {
      console.error('⚠️ 本机找不到 Edge/Chrome，跳过真浏览器回归（这一步本应必过）');
    } else {
      try {
        GATE.e2e = runGate(e2eRun, [e2eSelector], e2eDir);
      } catch (err) {
        console.error('\n✗ 真浏览器回归失败，禁止打包（确有急事可加 --skip-e2e，但请把它当红灯对待）。');
        process.exit(1);
      }
    }
  }

  // ③ 暂存到 dist/stage-build/<PREFIX>/… 再压缩（避免 tar 的路径前缀问题）
  //    注意：暂存目录**不能**叫 `_stage` —— `_` 开头在扩展目录里是 Chromium 保留名，
  //    打包中途崩了会留下它，之后 `work/keyword-highlighter` 这个开发目录就再也加载不进浏览器了。
  console.log('\n=== 打包 v' + VERSION + ' ===');
  const files = walk('.', []).sort();

  /* ③b 包内**任何一级**路径都不得以 `_` 开头（Chrome 只放行 `_locales` / `_metadata`）。
   *    否则浏览器加载时报 "Cannot load extension with file or directory name _xxx"。
   *    walk() 只挡了顶层 `_` 文件，`_` 目录会漏网 —— 出包前在这里兜死。 */
  const badPaths = files.filter((f) => f.split('/').some(
    (seg) => seg[0] === '_' && seg !== '_locales' && seg !== '_metadata'));
  if (badPaths.length) {
    console.error('\n✗ 包内含 `_` 开头的路径，Chromium 系浏览器会拒绝加载：');
    console.error('  ' + badPaths.join('\n  '));
    process.exit(1);
  }

  const distDir = path.join(ROOT, 'dist');
  const stageDir = path.join(distDir, 'stage-build');
  rmrf(stageDir);
  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of files) copyInto(f, stageDir);

  const zipPath = path.join(distDir, 'keyword-highlighter-v' + VERSION + '.zip');
  rmrf(zipPath);

  const stageInner = path.join(stageDir, PREFIX);
  let ok = false;
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -Path "' + stageInner + '" -DestinationPath "' + zipPath + '" -CompressionLevel Optimal -Force'
      ], { stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-q', '-r', '-X', zipPath, PREFIX], { stdio: 'inherit', cwd: stageDir });
    }
    ok = fs.existsSync(zipPath);
  } catch (err) {
    console.error('压缩失败：' + (err && err.message));
  }

  rmrf(stageDir);

  /* ③ 顺带产出**发布清单 latest.json** —— 这是"zip 通道"的单一数据源。
   *    更新检测会读它拿版本 / 下载地址 / **SHA256** / 更新说明；发版时把它和 zip 一起丢到 gh-pages 即可。
   *    放在这里生成而不是手写：版本与哈希都必须与**这次真正打出来的包**一致，手写必然会漂移。
   *    `notes` 取自 src/ui/changelog.js 里当前版本的条目（唯一来源，不另写一份）；
   *    【回归】那一行**不写死**：数字由本次打包**实测**到的门禁输出注入（见 regressionLine()），
   *    读不到的项不写、全读不到就整条不加（用户 2026-10-04 裁决：自动调整，不写死）。 */
  try {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
    let notes = '';
    try {
      const clPath = path.join(ROOT, 'src', 'ui', 'changelog.js');
      const sandbox = { window: {} };
      const src = fs.readFileSync(clPath, 'utf8');
      new Function('window', src)(sandbox.window);
      const list = sandbox.window.CHANGELOG || [];
      const hit = list.filter((e) => String(e.version).replace(/^v/i, '') === VERSION)[0];
      if (hit && (hit.items || []).length) {
        /* 取**最新**的三条：changelog 的数组里新条目插在末尾那条【保持不回退】之前，
         * 所以要先剔掉"保持不回退"、再取最后三条并反转（最新的排最前）。 */
        const real = hit.items
          .map((s) => String(s).replace(/`/g, ''))
          .filter((s) => s.indexOf('【保持不回退】') !== 0);
        notes = real.slice(-3).reverse().join('\n\n');
        if (notes.length > 900) notes = notes.slice(0, 900) + '…';
        /* 【回归】数字不写死：用本次打包**实测**到的门禁输出拼出来；一项都没有就整条不加。
         * 前置拼接（回归放最前）＝既有排版；截断在**前**、注入在**后**，实测数字不会被截掉。 */
        const regression = regressionLine();
        if (regression) notes = notes ? regression + '\n\n' + notes : regression;
      }
    } catch (e) { notes = ''; }
    const BASE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
    const latest = {
      version: VERSION,
      zip: BASE + '/' + path.basename(zipPath),
      crx: BASE + '/keyword-highlighter.crx',
      sha256: hash,
      notes: notes || ('v' + VERSION + ' 更新'),
      publishedAt: new Date().toISOString().slice(0, 10),
      htmlUrl: 'https://github.com/moxiaoren/keyword-highlighter-extension/releases'
    };
    const latestPath = path.join(distDir, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n', 'utf8');
    console.log('✓ 发布清单：dist/latest.json  （sha256=' + hash.slice(0, 16) + '…）');
    console.log('  发版动作：把 latest.json + update.xml + ' + path.basename(zipPath) + ' 一起放到 gh-pages 根目录');
  } catch (e) {
    console.error('（latest.json 生成失败，不影响 zip：' + (e && e.message) + '）');
  }

  if (!ok) {
    console.error('\n✗ 打包失败：本机没有可用的压缩工具（Windows 需要 PowerShell，其它平台需要 zip）。');
    console.error('  可手动打包：把以下文件按同样目录结构压成 zip（顶层目录 ' + PREFIX + '/）：');
    console.error('  ' + files.join('\n  '));
    process.exit(1);
  }

  const size = fs.statSync(zipPath).size;
  console.log('\n✓ 产物：' + path.relative(ROOT, zipPath).replace(/\\/g, '/') +
    '  (' + files.length + ' 个文件, ' + (size / 1024).toFixed(1) + ' KB)');
  console.log('\n安装：解压覆盖到扩展所在文件夹 → chrome://extensions → 点 ⟳ 重新加载。');
  console.log('真浏览器验收请照 tests/BROWSER-CHECKLIST.md 逐条过一遍。');

  /* ④ 出包成功后，把当前状态记为**影响面基线**（scripts/impact.js 下次据此算范围）。
   *    刻意不在 --skip-gates / --skip-e2e 的应急运行时写：否则会把"没验过的改动"
   *    记成基线，下次就被判成"无改动"而跳过回归 —— 那等于把应急开关变成永久豁免。 */
  if (!SKIP_GATES && !SKIP_E2E) {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/impact.js'), '--write-baseline'], { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      console.error('⚠️ 写影响面基线失败（不影响本次出包）：' + (e && e.message));
    }
  } else {
    console.log('（应急运行：本次不更新影响面基线，下次出包仍会按完整改动算范围）');
  }
}

main();
