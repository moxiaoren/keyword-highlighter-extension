/* ============================================================================
 * scripts/release.js — 线上发版一条命令
 * ----------------------------------------------------------------------------
 * 把"发版"从手工多步（打包 → 写清单 → 算哈希 → 生成 update.xml → 打 crx → 上传）
 * 收敛成一条命令，跑完在 `release/` 里得到**可直接上传**的全套文件：
 *
 *   release/
 *     keyword-highlighter.crx           crx（**唯一分发物**：浏览器自动更新与手动安装都读它）
 *     latest.json                       发布清单（版本 / 地址 / SHA256 / 说明）
 *     update.xml                        gupdate 清单 → Chrome 自动更新读它
 *     keyword-highlighter-v<版本>.zip   解压包（**默认不产出**；加 `--with-zip` 才出）
 *     key.pem                           签名私钥（**只在本机**；换机器要带走，否则扩展 ID 会变）
 *     PUBLISH.md                        上传步骤
 *
 * 用法：
 *   node scripts/release.js              跑门禁 → 打包 → 生成清单 → 打 crx → 汇总
 *   node scripts/release.js --skip-gates 跳过门禁（只重打产物时用）
 *   node scripts/release.js --with-zip   额外产出 zip（默认只出 crx；zip 只在明确要时才给）
 *   （测试版不走本脚本）                  node scripts/release-beta.js
 *                                        测试版是**另一个扩展**：自己的密钥、自己的更新源、
 *                                        包内 manifest 三处都不同 ⇒ 整套产物只能由它出
 *
 * 关键设计：
 *   · **appid 必须与线上一致**：先生成 update.xml 时优先复用**线上已发布的那份**里的 appid，
 *     其次用签名密钥推导，最后才由参数指定 —— appid 不一致 Chrome 会直接拒绝更新。
 *   · **密钥稳定**：`release/key.pem` 一旦生成就不再改（换了它扩展 ID 就变，等于换了一个扩展）。
 *   · 产物哈希取自**这次真正打出来的包**，说明取自 changelog，都是唯一来源。
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VERSION = MANIFEST.version;
const ZIP_NAME = 'keyword-highlighter-v' + VERSION + '.zip';
/* ⚠️ 这两个**必须**是 `let`：第 ⑤ 步会沿用线上 crx 的目录/前缀约定把它们改写成
 * `release/keyword-highlighter-extension-<版本>.crx`（见下面的 `CRX_DIR` / `CRX_NAME` 赋值）。
 * 2026-09-22 实测事故：`CRX_NAME` 原本是 `const`、而 `CRX_DIR` 压根没声明 ——
 * 于是**晋级稳定版**这条路一跑到第 ⑤ 步就 `ReferenceError: CRX_DIR is not defined`
 * （修掉之后会接着撞 `Assignment to constant variable`）。
 * 为什么一直没被发现：稳定通道自 1.51.0 之后**再没跑过 `--promote`**，只有测试版在迭代。
 * 教训：**发版脚本的每条分支都要真的跑一遍**（哪怕是空跑），别只跑常用那条。 */
let CRX_NAME = 'keyword-highlighter.crx';
let CRX_DIR = '';
const BASE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
const UPDATE_XML_URL = BASE + '/update.xml';

const argv = process.argv.slice(2);
const SKIP_GATES = argv.indexOf('--skip-gates') >= 0;
/* `--with-zip`：**默认不发 zip**。用户 2026-10-05 口径 —— 分发物只有 crx，zip 只在明确要时才出。
 * 注意它只是"本次多出一个 zip 产物"，并不是"只发 zip"：crx 永远是必产项。 */
const WITH_ZIP = argv.indexOf('--with-zip') >= 0;
/* 旧的 `--no-crx`（zip-only 发布）已删除：既没有程序性调用者，又与"crx 必产"直接冲突。
 * 这里显式报错而不是静默忽略 —— 静默会让 `--no-crx` 看起来还在工作，实际却发了 crx。 */
if (argv.indexOf('--no-crx') >= 0) {
  console.error('\n✗ --no-crx 已删除：发版一律产出 crx（crx 才是浏览器的分发物）。');
  console.error('  · 想连 zip 一起出：node scripts/release.js --with-zip');
  console.error('  · 只想重生成清单、不重新打包：node scripts/update-config.js');
  process.exit(1);
}
const FORCE_NEW_KEY = argv.indexOf('--force-new-key') >= 0;
const PROMOTE = argv.indexOf('--promote') >= 0;
/* 【本脚本只发稳定版】测试版是**另一个扩展**：自己的密钥 `release/key-beta.pem`（⇒ 扩展 ID
 * `ohjcaheamdifcldcofpblbejlpmgnhjc`）、自己的 `update-beta.xml` 自动更新通道、包内 manifest 三处都不同。
 * 它的整套产物只能由 `scripts/release-beta.js` 出 —— 本脚本里那套旧 beta 分支已于 2026-10-05 **删除**，
 * 并且 `--channel beta` 在这里**显式报错**：绝不静默当成"发稳定版"（静默最危险 —— 会把测试版用户
 * 留在没有更新源的旧 crx 上）。 */
const CH_I = argv.indexOf('--channel');
if (CH_I >= 0 && argv[CH_I + 1] !== 'stable') {
  const got = argv[CH_I + 1];
  console.error('\n✗ --channel 只接受 stable（收到：' + (got === undefined ? '(空)' : got) + '）');
  if (got === 'beta') {
    console.error('  测试版请跑：node scripts/release-beta.js [--skip-gates] [--skip-e2e]\n' +
      '  它是测试版的唯一实现，产物含 latest-beta.json 与 update-beta.xml（测试版用户靠后者自动升级）');
  }
  process.exit(1);
}
const KEY_ARG = (() => { const i = argv.indexOf('--key'); return i >= 0 ? argv[i + 1] : null; })();

function log(msg) { console.log(msg); }
function step(n, msg) { console.log('\n[' + n + '] ' + msg); }
function die(msg) { console.error('\n✗ ' + msg); process.exit(1); }

/** 找本机的 Chromium 系浏览器（用于打 crx） */
function findChromium() {
  const cands = [
    process.env.KH_CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ } }
  return null;
}

/** 扩展 ID = SHA256(公钥 DER) 前 16 字节，每个 nibble 映射到 a..p */
function extIdFromKeyPem(pem) {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

/** 读取线上已发布的 update.xml，拿它的 appid（保证与线上一致） */
async function fetchPublished() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(UPDATE_XML_URL, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/<app\s+appid=['"]([^'"]+)['"]/i);
    const c = xml.match(/<updatecheck[^>]*codebase=['"]([^'"]+)['"]/i);
    const v = xml.match(/<updatecheck[^>]*version=['"]([^'"]+)['"]/i);
    return m ? { appid: m[1], codebase: c ? c[1] : null, version: v ? v[1] : null } : null;
  } catch (e) { return null; }
}

(async () => {
  log('关键词高亮 · 发版流水线   版本 ' + VERSION + '   通道 稳定版（stable）');
  log('仓库根：' + ROOT);

  /* ---------------------------------------------------------------- ① 门禁 */
  if (!SKIP_GATES) {
    step(1, '门禁：meta-check / 单元测试 / integrity');
    const gates = [
      ['scripts/meta-check.js', '架构红线'],
      ['tests/run.js', '单元测试'],
      ['tests/integrity.js', '完整性']
    ];
    for (const [rel, label] of gates) {
      process.stdout.write('    ' + label + ' … ');
      try {
        execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, stdio: 'pipe' });
        log('通过');
      } catch (err) {
        log('失败');
        const out = (err.stdout || Buffer.from('')).toString() + (err.stderr || Buffer.from('')).toString();
        die('门禁未通过（' + label + '），已中止发版：\n' + out.split('\n').slice(-14).join('\n'));
      }
    }
  } else {
    step(1, '门禁：已跳过（--skip-gates）');
  }

  /* PROMOTE_ALSO_BETA：晋级稳定版时，**顺带把测试通道也出成同一版本**。
   * 规程要求"稳定版与测试版都发同一个号"——装了测试版的人本来就是那个号，两边最终一致 ✓。
   * 具体做法：调用 release-beta.js（它用测试版密钥出 crx + 写 latest-beta.json / update-beta.xml）。 */
  if (PROMOTE) {
    step('1b', '晋级：同时出测试通道的包（同版本）');
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/release-beta.js'), '--skip-gates'], { cwd: ROOT, stdio: 'inherit' });
    } catch (e) {
      log('    ⚠️ 测试通道出包失败（不影响稳定版）：' + (e && e.message));
    }
  }

  /* ------------------------------------------------------- ② 打包 + 清单 */
  step(2, '打包 zip 并生成发布清单');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/package.js')], { cwd: ROOT, stdio: 'inherit' });
  const zipPath = path.join(ROOT, 'dist', ZIP_NAME);
  const latestPath = path.join(ROOT, 'dist', 'latest.json');
  if (!fs.existsSync(zipPath)) die('没找到打包产物：' + zipPath);
  if (!fs.existsSync(latestPath)) die('没找到发布清单：' + latestPath);
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  const zipHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
  if (latest.sha256 !== zipHash) die('清单里的 sha256 与 zip 不一致（' + latest.sha256 + ' vs ' + zipHash + '）');
  log('    zip sha256 = ' + zipHash.slice(0, 16) + '…  ✓ 与清单一致');

  /* --------------------------------------- ②b 同步一键安装脚本（权威副本） */
  /* 站点上的 kh-autoupdate.bat 只有**一份权威副本**：`scripts/kh-autoupdate.bat`。
   * 这里与 `scripts/publish-gh.js` 用**同一条规则**：缺源硬失败、字节相同不写、
   * 字节不同才拷进 release/ 并打印一行。
   * 为什么 release.js 里也必须做一次：CI（.github/workflows/release.yml）稳定通道跑的是
   * `node scripts/release.js --channel stable`，**整条路径不经过 publish-gh.js**；
   * 而 gh-pages 发布带 `keep_files: true` ⇒ 少了这一步，站点上那份会在 CI 路径下
   * 永久冻结在最后一版、发版全程却显示成功（AUDIT.md F-63 / U-4 的同一机制）。
   * 位置：打包/清单校验之后、任何写 release/ 或发布的动作之前（下面两条分支都会走到这里）。 */
  (function syncBatFromWorkspace() {
    const src = path.join(ROOT, 'scripts', 'kh-autoupdate.bat');
    if (!fs.existsSync(src)) {
      die('缺 kh-autoupdate.bat 权威副本：' + src + '\n' +
          '  站点上的安装脚本只能由这一份供源（唯一权威副本）——发布中止，避免 gh-pages 上的副本永久冻结。');
    }
    try {
      const dst = path.join(REL, 'kh-autoupdate.bat');
      const a = fs.readFileSync(src), b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (!b || !a.equals(b)) { fs.mkdirSync(REL, { recursive: true }); fs.copyFileSync(src, dst); log('已同步 kh-autoupdate.bat 到发布目录（唯一权威副本来自 scripts/kh-autoupdate.bat）'); }
    } catch (e) { die('同步 kh-autoupdate.bat 到 release/ 失败：' + (e && e.message)); }
  })();

  /* 线上 appid 提前取：密钥段要据此判断"能不能安全地打 crx" */
  const published = await fetchPublished();
  const publishedIdEarly = published && published.appid;

  /* ---------- 版本回退守卫（KH_GUARD_VERSION） ----------
   * 浏览器**永远不会降级**扩展：update.xml/latest.json 里的版本号比本机已装的小，它就直接忽略 ✗。
   * 所以"测试版 2.2.4 → 稳定版 2.0.0"这种回退是危险的：所有装过测试版的人**永远收不到稳定版** ✗。
   * 这里在发稳定通道前对比线上测试通道的版本，比它低就**中止**（要强行发必须显式加 --force-version）。 */
  /* 这里在发稳定通道前对比线上测试通道的版本，比它低就**中止**（要强行发必须显式加 --force-version）。
   * 本脚本只发稳定版 ⇒ 这道闸**恒执行**（测试版那条路由 scripts/release-beta.js 负责）。 */
  try {
    const mirrors = [
      'https://moxiaoren.github.io/keyword-highlighter-extension/latest-beta.json',
      'https://cdn.jsdelivr.net/gh/moxiaoren/keyword-highlighter-extension@gh-pages/latest-beta.json'
    ];
    let betaVer = null;
    for (const u of mirrors) {
      try {
        const c = new AbortController(); const tm = setTimeout(() => c.abort(), 10000);
        const r = await fetch(u + '?t=' + Date.now(), { cache: 'no-store', signal: c.signal });
        clearTimeout(tm);
        if (r.ok) { const j = await r.json(); if (j && j.version) { betaVer = String(j.version); break; } }
      } catch (e) { /* 试下一个镜像 */ }
    }
    if (!betaVer) {
      /* fail-closed（2026-10-04 起）：取不到线上测试版版本 ⇒ **中止发布**。
       * 以前这里只打一行"跳过回退检查"就继续发 —— 那等于把上面那条铁律交给运气：
       * 镜像抖动 / 网络不通时，一个**比线上测试版更低**的稳定版会照常发出去，
       * 而它一旦发出去就收不回（浏览器不降级 ⇒ 装过测试版的人再也收不到稳定版）✗。 */
      die('版本回退检查无法完成：取不到线上测试通道版本（latest-beta.json 两个镜像都没通）✗\n' +
          '  浏览器不会降级扩展 ⇒ 无法确认本次稳定版 ' + VERSION + ' 是否高于线上测试版，宁可不发 ✗\n' +
          '  正确做法：等 Pages / jsDelivr 恢复后重跑（CI 里通常只是镜像抖动，重跑一次即可）✓\n' +
          '  确认线上测试通道为空、或本次只面向全新安装渠道时，加 --force-version 显式放行。');
    }
    const cmp = require(path.join(ROOT, 'scripts', 'lib', 'version.js')).compareVersions;
    const d = cmp(VERSION, betaVer);
    log('    线上测试通道版本 = ' + betaVer + '，本次稳定版 = ' + VERSION + ' → ' + (d < 0 ? '更低 ✗' : '不低 ✓'));
    if (d < 0 && argv.indexOf('--force-version') < 0) {
      die('版本号回退被拒绝：稳定版 ' + VERSION + ' 低于线上测试版 ' + betaVer + ' ✗\n' +
          '  浏览器不会降级扩展 → 装过测试版 ' + betaVer + ' 的人**永远收不到**这个稳定版 ✗\n' +
          '  正确做法：稳定版用**比它更高的三段号**（测试版 ' + betaVer + ' ⇒ 晋级后应为更高的 x.y.z，' +
          '例如 node scripts/bump-version.js release）✓\n' +
          '  确实要强行发（只面向全新安装）时加 --force-version。');
    }
  } catch (e) { log('    （回退检查异常，已跳过：' + (e && e.message) + '）'); }

  /* ------------------------------------------------------------ ③ 密钥 */
  step(3, '准备签名密钥（决定扩展 ID，一旦生成不可更换）');
  fs.mkdirSync(REL, { recursive: true });
  const keyPath = KEY_ARG ? path.resolve(KEY_ARG) : path.join(REL, 'key.pem');
  let keyPem;
  if (fs.existsSync(keyPath)) {
    keyPem = fs.readFileSync(keyPath, 'utf8');
    log('    复用已有密钥：' + keyPath);
  } else if (process.env.KH_KEY_PEM) {
    keyPem = process.env.KH_KEY_PEM;
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    log('    来自环境变量 KH_KEY_PEM，已写入 ' + keyPath);
  } else if (publishedIdEarly && !FORCE_NEW_KEY) {
    /* 线上已有 appid 却没有密钥：**绝不能**自己造一把 —— 造出来的 crx 扩展 ID 与线上不同，
     * Chrome 会当成另一个扩展直接拒绝更新 ✗。这种情况只能让用户提供原密钥。 */
    die('线上已发布的扩展 ID 是 ' + publishedIdEarly + '，但本机没有对应签名密钥。\n' +
        '  · 打 crx 必须用**当初发布时那把** key.pem，否则扩展 ID 会变、Chrome 拒绝更新；\n' +
        '  · 请把原密钥放到 release/key.pem，或用 --key <路径> / 环境变量 KH_KEY_PEM 指定；\n' +
        '  · 若确实要换一个新扩展 ID（等于重新发布一个扩展），加 --force-new-key 明确确认。\n' +
        '  （本脚本不再支持"跳过 crx"：crx 是唯一交付物，跳过它就没有可上传的包了。）');
  } else {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    keyPem = privateKey;
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    log('    已生成新密钥：release/key.pem  ⚠️ 请备份并保密；丢失后扩展 ID 会变');
  }
  const derivedId = extIdFromKeyPem(keyPem);
  log('    由密钥推导的扩展 ID：' + derivedId);

  /* appid：优先用线上已发布的那份（保证 Chrome 认得出是同一个扩展） */
  const publishedId = publishedIdEarly;
  let appid = derivedId;
  if (publishedId && publishedId !== derivedId) {
    if (!FORCE_NEW_KEY) die('密钥与线上 appid 不一致：线上 ' + publishedId + '，本机密钥推导 ' + derivedId + '。');
    log('    ⚠️ 已按 --force-new-key 使用新扩展 ID：' + derivedId + '（线上仍是 ' + publishedId + '）');
    appid = derivedId;
  } else if (publishedId) {
    log('    与线上 appid 一致 ✓');
  } else {
    log('    （未取到线上 update.xml，按本机密钥推导值生成）');
  }

  /* ------------------------------------------------------------- ④ crx */
  step(4, '打 crx（用本机 Chromium 打包，非商店分发）');
  /* package.js 跑完会清掉 dist/stage-build，所以这里**自己解包**一份用于打 crx */
  const stageDir = path.join(REL, '.stage');
  const inner = path.join(stageDir, 'keyword-highlighter-extension');
  let crxOk = false;
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(inner, { recursive: true });
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -Path "' + zipPath + '" -DestinationPath "' + stageDir + '" -Force'], { stdio: 'pipe' });
    } else {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', stageDir], { stdio: 'pipe' });
    }
  } catch (e) { /* 下面会按"目录不存在"跳过 */ }
  const browser = findChromium();
  if (!browser) {
    log('    ✗ 本机没找到 Chrome/Edge —— 打不出 crx');
  } else if (!fs.existsSync(inner)) {
    log('    ✗ 没解出可打包目录（dist/' + ZIP_NAME + ' 解包失败）');
  } else {
    try {
      /* Chrome 会把 crx 输出在**被包的目录旁边**：<...>/keyword-highlighter-extension.crx */
      execFileSync(browser, ['--pack-extension=' + inner, '--pack-extension-key=' + keyPath, '--no-message-box'], { stdio: 'inherit' });
      const produced = inner + '.crx';
      if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(REL, CRX_NAME));
        fs.rmSync(produced, { force: true });
        crxOk = true;
        log('    已生成 release/' + CRX_NAME);
      } else {
        log('    ✗ 浏览器没有产出 crx（可能被安全策略拦下）');
      }
    } catch (err) {
      log('    ✗ 打 crx 失败：' + (err && err.message));
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  /* crx 必产的兜底（2026-10-05 用户口径："后续都改成 crx，zip 只有我说需要时才提供"）：
   * 以前 crx 打不出来还能退回"只发 zip 通道"（`--no-crx`），现在那条路删了、zip 默认也不发 ——
   * 所以这里**必须硬失败**。否则第 ⑤ 步照样写一份 update.xml 指向不存在的 crx，
   * 就是 2026-09-22 那类"发布日志全 ✓、用户端自动更新 404"的事故。 */
  if (!crxOk) {
    die('crx 没打出来，而它是本次唯一的交付物（默认不再发 zip）。\n' +
        '  · 装一个 Chrome/Edge，或用环境变量 KH_CHROME 指定浏览器路径；\n' +
        '  · 确认 dist/' + ZIP_NAME + ' 能正常解包（解包失败也会走到这里）；\n' +
        '  · 只想重新生成清单、不重新打包：node scripts/update-config.js');
  }

  /* -------------------------------------------------- ⑤ update.xml + 汇总 */
  step(5, '生成 update.xml 并汇总到 release/');
  /* 沿用线上 codebase 的目录与前缀（只把版本号换成本次版本） */
  let codebase = BASE + '/' + CRX_NAME;
  if (published && published.codebase) {
    const m = published.codebase.match(/^(.*\/)([^\/]+?)-\d+\.\d+\.\d+[^\/]*\.crx$/i);
    if (m) {
      CRX_DIR = m[1].replace(BASE + '/', '').replace(/^\//, '');
      CRX_NAME = m[2] + '-' + VERSION + '.crx';
      codebase = m[1] + CRX_NAME;
      log('    沿用线上 crx 路径约定：' + codebase.replace(BASE + '/', ''));
      if (crxOk) {
        fs.mkdirSync(path.join(REL, CRX_DIR), { recursive: true });
        const flat = path.join(REL, 'keyword-highlighter.crx');
        if (fs.existsSync(flat)) { fs.renameSync(flat, path.join(REL, CRX_DIR, CRX_NAME)); log('    crx 已放到 ' + CRX_DIR + '/' + CRX_NAME); }
      }
    }
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    '  <app appid="' + appid + '">',
    '    <updatecheck codebase="' + codebase + '" version="' + VERSION + '" />',
    '  </app>',
    '</gupdate>',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(REL, 'update.xml'), xml, 'utf8');
  /* zip 默认不发（用户口径：分发物只有 crx）。要 zip 时加 `--with-zip`。 */
  if (WITH_ZIP) fs.copyFileSync(zipPath, path.join(REL, ZIP_NAME));
  fs.copyFileSync(latestPath, path.join(REL, 'latest.json'));
  /* ⚠️ `latest.json` 里的 `crx` / `zip` 都必须是**真实存在**的那个地址。
   * `package.js` 写的是扁平名 `keyword-highlighter.crx`，但本脚本第 ④ 步把 crx 改名成
   * `release/keyword-highlighter-extension-<版本>.crx`（沿用线上约定）——**扁平名在站点上从来不存在**
   * （2026-09-22 实测 gh-pages 树里没有 `keyword-highlighter.crx`）⇒ 那是个假链接。
   * 不发 zip 时同样不能留着 zip 地址：`scripts/publish-gh.js` 的预检会拿 `latest.json.zip` 去上传列表里
   * 找文件，找不到就**中止发布**；即使绕过预检，站点上也会多一个 404 的下载地址。
   * 所以不发货就把 zip / sha256 明确置空（空串＝本次没有，而不是"地址还在、文件没了"）。 */
  {
    const lj = JSON.parse(fs.readFileSync(path.join(REL, 'latest.json'), 'utf8'));
    lj.crx = codebase;
    if (!WITH_ZIP) { lj.zip = ''; lj.sha256 = ''; }
    fs.writeFileSync(path.join(REL, 'latest.json'), JSON.stringify(lj, null, 2) + '\n', 'utf8');
    log('    latest.json 的 crx 指向已对齐成真实文件：' + codebase.replace(BASE + '/', ''));
    if (!WITH_ZIP) log('    latest.json 的 zip / sha256 已置空（本次不发 zip）');
  }

  /* crx 的落盘位置与站点位置（2026-10-05 干跑修正）：
   *   站点路径 = CRX_DIR + CRX_NAME（稳定版 CRX_DIR='release/'，沿用线上 codebase 约定）
   *   本地路径 = 'release/' + 站点路径 ⇒ 实际在 release/release/…（见第⑤步的 fs.renameSync）
   * 以前这里一律硬拼 'release/' + CRX_NAME ⇒ 文档里的源路径少一层（照着敲 file not found）、
   * 目标目录也少一层（crx 应进 gh-pages/release/，不是根目录）。 */
  const crxSite = CRX_DIR + CRX_NAME;                       // 例：release/keyword-highlighter-extension-2.0.1.3.crx
  const crxLocal = 'release/' + crxSite;                    // 例：release/release/keyword-highlighter-extension-2.0.1.3.crx
  const crxDestDir = CRX_DIR.replace(/\/+$/, '');           // 例：release；无子目录时为空串
  const shipped = ['latest.json', 'update.xml', CRX_NAME];
  if (WITH_ZIP) shipped.push(ZIP_NAME);
  const flatSrc = ['release/latest.json', 'release/update.xml'];
  if (WITH_ZIP) flatSrc.push('release/' + ZIP_NAME);
  const gitCmds = [
    'git clone -b gh-pages https://github.com/moxiaoren/keyword-highlighter-extension.git gh-pages'
  ];
  if (crxDestDir) gitCmds.push('mkdir -p gh-pages/' + crxDestDir + '        # crx 在子目录里，先建目录');
  gitCmds.push('cp ' + flatSrc.join(' ') + ' gh-pages/');
  if (crxSite !== CRX_NAME || crxDestDir) {
    gitCmds.push('cp ' + crxLocal + ' gh-pages/' + (crxDestDir ? crxDestDir + '/' : ''));
  } else {
    gitCmds.push('cp ' + crxLocal + ' gh-pages/');
  }
  gitCmds.push('cd gh-pages && git add -A && git commit -m "release v' + VERSION + '" && git push');
  const publish = [
    '# 上传步骤（把 release/ 里的文件放到 gh-pages 的**对应位置**）',
    '',
    '**首选**：`node scripts/publish-gh.js`（自动递归枚举 release/、保持目录层级、还带清单预检）。下面是手工兜底。',
    '',
    '需要上传的文件（' + shipped.length + ' 个' + (WITH_ZIP ? '，含 zip' : '，**不含 zip**（本次只发 crx）') + '）：',
    '  - latest.json                      → ' + BASE + '/latest.json',
    '  - update.xml                       → ' + UPDATE_XML_URL + '（manifest.update_url 指向它）',
    '  - ' + crxSite + (crxSite === CRX_NAME ? '' : '   （本地文件：' + crxLocal + '）'),
    WITH_ZIP ? '  - ' + ZIP_NAME + '   ← `--with-zip` 额外产出（"解压加载"用）'
      : '  （zip 默认不发；确实要 zip：node scripts/release.js --with-zip）',
    '',
    '不要上传：key.pem（签名私钥，只留在本机 / 放进 CI 的 Secret）',
    '',
    '## 两种上传方式',
    '',
    '### A. 有 git（推荐）',
    '```',
    ...gitCmds,
    '```',
    '',
    '### B. 无 git：在 GitHub 网页上把这 ' + shipped.length + ' 个文件替换掉即可'
      + (crxDestDir ? '（crx 在 ' + crxDestDir + '/ 目录下，别放到根目录）' : ''),
    '',
    '## 上传后自检（30 秒）',
    '1. 浏览器打开 ' + UPDATE_XML_URL + ' → 应看到 version="' + VERSION + '" 与 codebase 指向 ' + crxSite,
    '2. 打开 ' + BASE + '/latest.json → 它的 crx 字段应与上一步的 codebase 一致'
      + (WITH_ZIP ? '，sha256 应与本地 release/latest.json 一致'
        : '（本次没发 zip，zip / sha256 字段为空是预期的）'),
    '3. 装了扩展的机器：等浏览器自动更新（或完全退出浏览器再启动）后，扩展详情页的版本号应变成 ' + VERSION,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(REL, 'PUBLISH.md'), publish, 'utf8');

  log('    release/update.xml  （appid=' + appid + '）');
  log('    release/latest.json');
  if (WITH_ZIP) log('    release/' + ZIP_NAME);
  log('    release/' + CRX_NAME);
  log('    release/PUBLISH.md');

  /* ------------------------------------------------------------- 小结 */
  const files = fs.readdirSync(REL).filter((f) => f !== 'key.pem');
  log('\n发版产物就绪（release/）：' + files.join('、'));
  log('上传步骤见 release/PUBLISH.md；密钥 release/key.pem 请勿上传、务必备份。');
  if (!WITH_ZIP) log('提示：本次只发 crx（没产出 zip）。需要 zip 时加 --with-zip。');
})().catch((err) => {
  console.error('\n✗ 发版流水线异常：' + (err && err.message));
  console.error(err && err.stack);
  process.exit(1);
});
