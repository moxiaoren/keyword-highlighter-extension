/* ============================================================================
 * scripts/release-beta.js — **独立测试版**：自己的私钥 / 自己的扩展 ID / 自己的更新源
 * ----------------------------------------------------------------------------
 * 与 release.js 的区别（用户选的方案：两者彻底分开）：
 *
 *   release.js      → 正式版：用 release/key.pem 签名，ID = kpakjonpfookjchkfinfhkojiamjcedj
 *   release-beta.js → 测试版：用 release/key-beta.pem 签名，ID = ohjcaheamdifcldcofpblbejlpmgnhjc
 *
 * 测试版包在打包时会**改三处 manifest**：
 *   · `key`          = 测试版公钥（固定 ID：解压安装也认得出是同一个测试版扩展）
 *   · `update_url`   = …/update-beta.xml（测试版**走自己的自动更新通道** ✓）
 *   · `version_name` = "x.y.z beta"（扩展据此知道自己跑在测试通道，检查更新走测试清单）
 *
 * 好处：两个扩展完全隔离 —— 可同时安装、各自自动更新、测试版怎么折腾都不碰正式版 ✓
 * 代价（必须让测试者知道）：
 *   · 测试版是**另一个扩展**：晋级正式版后，装了测试版的人**不会**被自动升到正式版 ✗，
 *     需要卸载测试版再装正式版；
 *   · 测试版有**自己的 storage**：关键词/分组是空的，需要从正式版导出 JSON/CSV 再导入。
 *
 * 用法：
 *   node scripts/release-beta.js              # 出测试版产物到 release/
 *   node scripts/release-beta.js --skip-gates
 *   node scripts/publish-gh.js                # 推上线（与正式版同一个发布器）
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const BASE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const SKIP_GATES = process.argv.indexOf('--skip-gates') >= 0;
const SKIP_E2E = process.argv.indexOf('--skip-e2e') >= 0;   // 透传给 package.js（跳过真浏览器回归，应急）
const TAG = 'v' + VERSION;   // 文件名里已有 beta，别重复

const KEY = path.join(REL, 'key-beta.pem');
const PUB = path.join(REL, 'key-beta.pub.txt');
const ZIP_NAME = 'keyword-highlighter-beta-' + TAG + '.zip';
const CRX_NAME = 'keyword-highlighter-beta-' + TAG + '.crx';

function log(m) { console.log(m); }
function die(m) { console.error('\n✗ ' + m); process.exit(1); }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

function findChromium() {
  const c = [
    process.env.KH_CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const x of c) { try { if (fs.existsSync(x)) return x; } catch (e) { /* 忽略 */ } }
  return null;
}

/* 跨平台（与 release.js 同一口径）：win32 走 powershell，其余用 unzip / zip 系统命令 */
function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -Path "' + zipPath + '" -DestinationPath "' + destDir + '" -Force'], { stdio: 'pipe' });
  } else {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'pipe' });
  }
}
/* 压缩目录为 zip（包内顶层 = 目录名，与官方 Compress-Archive 行为一致） */
function makeZip(dir, zipOut) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -Path "' + dir + '" -DestinationPath "' + zipOut + '" -CompressionLevel Optimal -Force'], { stdio: 'pipe' });
  } else {
    const base = path.basename(dir);
    const cwd0 = process.cwd();
    process.chdir(path.dirname(dir));
    try { execFileSync('zip', ['-q', '-r', zipOut, base], { stdio: 'pipe' }); }
    finally { process.chdir(cwd0); }
  }
}

(async () => {
  log('关键词高亮 · **独立测试版**   版本 ' + VERSION);
  if (!fs.existsSync(KEY)) die('缺测试版密钥：' + KEY + '\n  先生成一把：node scripts/release-beta.js 需要 release/key-beta.pem（见 RELEASE.md）');
  if (!fs.existsSync(PUB)) die('缺测试版公钥文本：' + PUB);
  fs.mkdirSync(REL, { recursive: true });

  /* ① 门禁 + 常规打包（复用正式版那套，保证产物内容一致） */
  {
    const pkgArgs = [];
    if (SKIP_GATES) pkgArgs.push('--skip-gates');
    if (SKIP_E2E) pkgArgs.push('--skip-e2e');
    log('\n[1] 门禁 + 打包（复用 package.js）' + (SKIP_E2E ? '（跳过真机 e2e）' : ''));
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/package.js'), ...pkgArgs], { cwd: ROOT, stdio: 'inherit' });
  }
  const srcZip = path.join(ROOT, 'dist', 'keyword-highlighter-v' + VERSION + '.zip');
  if (!fs.existsSync(srcZip)) die('没找到打包产物：' + srcZip);

  /* ② 解包 → 改 manifest 三处 → 重打成"测试版 zip" */
  log('\n[2] 改 manifest（key / update_url / version_name）并重打成测试版包');
  const work = path.join(ROOT, 'dist', '_beta');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  extractZip(srcZip, work);
  const inner = path.join(work, 'keyword-highlighter-extension');
  const mfPath = path.join(inner, 'manifest.json');
  if (!fs.existsSync(mfPath)) die('包里没有 manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.key = fs.readFileSync(PUB, 'utf8').trim();                 // 固定测试版 ID
  mf.update_url = BASE + '/update-beta.xml';                    // 测试版自己的自动更新源
  mf.version_name = VERSION + ' beta';                          // 扩展据此走测试通道
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n', 'utf8');
  log('    key（固定 ID）/ update_url=' + mf.update_url + ' / version_name=' + mf.version_name);

  const betaZip = path.join(REL, ZIP_NAME);
  fs.rmSync(betaZip, { force: true });
  makeZip(inner, betaZip);
  log('    release/' + ZIP_NAME + '  sha256=' + sha256(betaZip).slice(0, 16) + '…');

  /* ③ 用测试版私钥签 crx */
  log('\n[3] 用测试版密钥签 crx');
  const browser = findChromium();
  let crxOk = false;
  if (!browser) log('    ⚠️ 本机没找到 Chrome/Edge，跳过 crx（zip 仍可用）');
  else {
    try {
      execFileSync(browser, ['--pack-extension=' + inner, '--pack-extension-key=' + KEY, '--no-message-box'], { stdio: 'inherit' });
      const produced = inner + '.crx';
      if (fs.existsSync(produced)) { fs.copyFileSync(produced, path.join(REL, CRX_NAME)); fs.rmSync(produced, { force: true }); crxOk = true; log('    release/' + CRX_NAME); }
      else log('    ⚠️ 浏览器没产出 crx');
    } catch (e) { log('    ⚠️ 打 crx 失败：' + (e && e.message)); }
  }
  fs.rmSync(work, { recursive: true, force: true });

  /* ④ 测试版自己的配置：latest-beta.json + update-beta.xml */
  log('\n[4] 生成测试版配置');
  const betaId = (() => {
    const b64 = fs.readFileSync(PUB, 'utf8').trim();
    const der = Buffer.from(b64, 'base64');
    const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
    let id = ''; for (const c of hex) id += String.fromCharCode(97 + parseInt(c, 16));
    return id;
  })();
  const latest = {
    version: VERSION,
    channel: 'beta',
    zip: BASE + '/' + ZIP_NAME,
    sha256: sha256(betaZip),
    notes: '测试版 ' + VERSION,
    publishedAt: new Date().toISOString().slice(0, 10),
    htmlUrl: 'https://github.com/moxiaoren/keyword-highlighter-extension/releases'
  };
  fs.writeFileSync(path.join(REL, 'latest-beta.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8');
  log('    release/latest-beta.json（版本 ' + VERSION + '）');
  if (crxOk) {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
      '  <app appid="' + betaId + '">',
      '    <updatecheck codebase="' + BASE + '/' + CRX_NAME + '" version="' + VERSION + '" />',
      '  </app>',
      '</gupdate>',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(REL, 'update-beta.xml'), xml, 'utf8');
    log('    release/update-beta.xml（appid=' + betaId + ' ← 测试版自己的 ID）');
  }

  log('\n测试版产物：release/' + ZIP_NAME + '、latest-beta.json' + (crxOk ? '、' + CRX_NAME + '、update-beta.xml' : ''));
  log('发布：node scripts/publish-gh.js');
  log('安装给测试者：拖 crx 进 chrome://extensions（或解压 zip 用「加载已解压的扩展程序」）');
  log('⚠️ 测试版是**另一个扩展**（ID ' + betaId + '）：与正式版可共存，但晋级正式版后不会被自动升级，需手动换装。');
})().catch((e) => die('异常：' + (e && e.message)));
