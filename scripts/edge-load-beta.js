/* ============================================================================
 * scripts/edge-load-beta.js — 把测试版落到固定目录，供 Edge/Chrome「加载解压缩的扩展」
 * ----------------------------------------------------------------------------
 * 为什么需要它：**解压加载的扩展不会自动更新** ✗
 *   Chromium 对 unpacked 扩展**直接忽略** manifest 里的 `update_url` ——
 *   所以本机的"更新"只能是：把新包覆盖到目录 → 到 edge://extensions 点一次「刷新 ⟳」。
 *   （`.crx` 的静默自动更新只对"正常安装的 crx"生效：商店上架 / 企业策略强制安装。
 *     本机策略被 Edge 判 [BLOCKED]、又没上架商店，所以那条路在这台机器上不可用 ✗。）
 *
 * 关键点：测试版 manifest 里写了 `key`，所以**目录内容换了、扩展 ID 也不变** ✓
 *   → 刷新后仍是同一个扩展，关键词/分组等配置**不会丢** ✓
 *
 * 用法：
 *   node scripts/edge-load-beta.js                # 用本地 release/ 里最新的测试版 zip
 *   node scripts/edge-load-beta.js --online       # **从线上拉最新测试版**（校验 SHA256 后覆盖）
 *   node scripts/edge-load-beta.js --zip <路径>    # 指定 zip
 *   node scripts/edge-load-beta.js --dir <目录>    # 指定落盘目录（默认 <工作区>/build/edge-beta）
 *
 * 本地没有 beta zip 时会**自动**走线上路径（换台机器也能用 ✓）。
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const USE_ONLINE = argv.indexOf('--online') >= 0;

/** 默认落盘目录：<工作区>/build/edge-beta（放 build/ 下以标明它是构建产物，不是源码分支；仍方便在文件选择框里找到） */
const DEFAULT_DIR = path.resolve(ROOT, '..', '..', 'build', 'edge-beta');
const DIR = path.resolve(arg('--dir', DEFAULT_DIR));
const BETA_ID = 'ohjcaheamdifcldcofpblbejlpmgnhjc';

function log(m) { console.log(m); }
function die(m) { console.error('\n✗ ' + m); process.exit(1); }

/** 扩展 ID = SHA256(公钥 DER) 前 16 字节，nibble 映射 a..p */
function extIdFromKey(keyB64) {
  if (!keyB64) return '(未设置 key)';
  const der = Buffer.from(String(keyB64), 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const c of hex) id += String.fromCharCode(97 + parseInt(c, 16));
  return id;
}

/** 找本地最新测试版 zip */
function findLocalZip() {
  const explicit = arg('--zip', null);
  if (explicit) return path.resolve(explicit);
  const rel = path.join(ROOT, 'release');
  if (!fs.existsSync(rel)) return null;
  const zips = fs.readdirSync(rel)
    .filter((f) => /^keyword-highlighter-beta-.*\.zip$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(rel, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return zips.length ? path.join(rel, zips[0].f) : null;
}

/** 从线上清单拉最新测试版（三镜像回退） */
async function fetchOnlineManifest() {
  const mirrors = [
    'https://moxiaoren.github.io/keyword-highlighter-extension/latest-beta.json',
    'https://cdn.jsdelivr.net/gh/moxiaoren/keyword-highlighter-extension@gh-pages/latest-beta.json',
    'https://raw.githubusercontent.com/moxiaoren/keyword-highlighter-extension/gh-pages/latest-beta.json'
  ];
  for (const u of mirrors) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 12000);
      const r = await fetch(u + '?t=' + Date.now(), { cache: 'no-store', signal: c.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.zip) { log('线上清单：' + u + '\n            → v' + j.version + '  (' + path.basename(j.zip) + ')'); return j; }
    } catch (e) { /* 试下一个镜像 */ }
  }
  return null;
}

/** 下载 + 校验 + 落盘 */
async function installFromOnline() {
  const j = await fetchOnlineManifest();
  if (!j) die('三个镜像都拉不到 latest-beta.json（网络受限？可以先跑 release-beta.js 用本地包）');
  const tmpZip = path.join(ROOT, 'release', '_online-beta.zip');
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
  log('正在下载：' + j.zip);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 60000);
  const r = await fetch(j.zip + '?t=' + Date.now(), { cache: 'no-store', signal: c.signal });
  clearTimeout(t);
  if (!r.ok) die('下载失败：HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(tmpZip, buf);
  const got = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  if (j.sha256 && got !== String(j.sha256).toUpperCase()) {
    fs.rmSync(tmpZip, { force: true });
    die('线上包 SHA256 校验失败（期望 ' + String(j.sha256).slice(0, 16) + '…，实际 ' + got.slice(0, 16) + '…），已拒绝覆盖本地目录');
  }
  log('  已下载 ' + (buf.length / 1024).toFixed(1) + ' KB，SHA256 校验通过 ✓');
  install(tmpZip);
  fs.rmSync(tmpZip, { force: true });
}

/** 解压 → 校验 manifest → 整体替换目录（避免替换到一半留下半个目录，浏览器会报扩展损坏） */
function install(zipPath) {
  if (!zipPath || !fs.existsSync(zipPath)) die('找不到 zip：' + zipPath);
  log('源包：' + zipPath + '  (' + (fs.statSync(zipPath).size / 1024).toFixed(1) + ' KB)');
  const tmp = DIR + '.__new';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -Path "' + zipPath + '" -DestinationPath "' + tmp + '" -Force'], { stdio: 'pipe' });
  } catch (e) { die('解压失败：' + (e && e.message)); }

  const inner = path.join(tmp, 'keyword-highlighter-extension');
  const mfPath = path.join(inner, 'manifest.json');
  if (!fs.existsSync(mfPath)) die('包里没有 manifest.json，可能不是本扩展的包');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const id = extIdFromKey(mf.key);

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DIR), { recursive: true });
  fs.renameSync(inner, DIR);
  fs.rmSync(tmp, { recursive: true, force: true });

  log('');
  log('已落盘：' + DIR);
  log('  version      = ' + mf.version);
  log('  version_name = ' + mf.version_name);
  log('  扩展 ID      = ' + id + (id === BETA_ID ? '  ✓ 测试版 ID（刷新后配置不丢）' : ''));
  log('');
  log('接下来只有一步：打开 edge://extensions → 点该扩展卡片上的「刷新」⟳');
  log('（刷新只是让浏览器重读这个目录；解压加载的扩展不会自动更新，这一步无法省略）');
}

(async () => {
  const local = findLocalZip();
  if (!local || USE_ONLINE) {
    if (!local) log('本地没有 beta zip → 改为从**线上**拉取最新测试版');
    await installFromOnline();
  } else {
    install(local);
  }
})().catch((e) => die('异常：' + (e && e.message)));
