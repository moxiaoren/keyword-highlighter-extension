/* ============================================================================
 * scripts/update-config.js — **只重新生成"更新配置"文件**（latest.json / latest-beta.json / update.xml）
 * ----------------------------------------------------------------------------
 * 与 release.js 的分工：
 *   · release.js       ：完整流水线（门禁 → 打包 → 签名 crx → 配置 → 汇总），日常发版用它；
 *   · update-config.js ：**不重新打包**，只用已有产物重新生成/修正更新配置 —— 给自动化用。
 *     典型场景：
 *       a) CI 里先构建产物、再单独生成配置；
 *       b) 手工重打了 zip（或换了 CDN 地址），只想刷新配置不动包；
 *       c) 想给某个已有版本补一份清单（例如把测试版晋级到稳定通道）。
 *
 * 用法：
 *   node scripts/update-config.js --channel beta  --zip dist/keyword-highlighter-v2.1.0.zip
 *   node scripts/update-config.js --channel stable --zip <zip> --crx <crx> [--key <pem>]
 *   node scripts/update-config.js --channel stable --promote-from release/latest-beta.json
 *
 * 关键规则（与 release.js 完全一致，避免两套口径）：
 *   · **appid 必须与线上一致**：优先读线上 update.xml 的 appid，其次由签名密钥推导；
 *   · 测试通道**不生成 update.xml**（那是稳定版专用，改了会把测试版推给所有人）；
 *   · sha256 取自**真实产物字节**，不由调用方口述（口述必然漂移）。
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const BASE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
const UPDATE_XML_URL = BASE + '/update.xml';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const CHANNEL = arg('--channel', 'stable');
const ZIP = arg('--zip', null);
const CRX = arg('--crx', null);
const KEY = arg('--key', null);
const NOTES_ARG = arg('--notes', null);
const PROMOTE_FROM = arg('--promote-from', null);
const VERSION = arg('--version', null);

function log(m) { console.log(m); }
function die(m) { console.error('\n✗ ' + m); process.exit(1); }
if (CHANNEL !== 'beta' && CHANNEL !== 'stable') die('--channel 只能是 beta 或 stable');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();

/** 扩展 ID = SHA256(公钥 DER) 前 16 字节，nibble → a..p */
function extIdFromKeyPem(pem) {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

async function fetchLive() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(UPDATE_XML_URL, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const xml = await res.text();
    const a = xml.match(/<app\s+appid=['"]([^'"]+)['"]/i);
    const c = xml.match(/<updatecheck[^>]*codebase=['"]([^'"]+)['"]/i);
    return a ? { appid: a[1], codebase: c ? c[1] : null } : null;
  } catch (e) { return null; }
}

(async () => {
  fs.mkdirSync(REL, { recursive: true });

  /* 版本与说明的来源优先级：--promote-from 的清单 > --version > manifest */
  let version = VERSION;
  let notes = NOTES_ARG;
  let srcZip = ZIP;
  let srcCrx = CRX;
  if (PROMOTE_FROM) {
    const j = JSON.parse(fs.readFileSync(PROMOTE_FROM, 'utf8'));
    version = version || j.version;
    notes = notes || j.notes;
    if (!srcZip && j.zip) srcZip = path.join(path.dirname(PROMOTE_FROM), path.basename(j.zip));
    log('从晋级源读取：' + PROMOTE_FROM + '（版本 ' + version + '）');
  }
  if (!version) version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  if (!srcZip || !fs.existsSync(srcZip)) die('需要 --zip <路径>（或 --promote-from 指向的清单里能推出 zip）');
  const zipHash = sha256(srcZip);
  log('zip  : ' + path.basename(srcZip) + '  sha256=' + zipHash.slice(0, 16) + '…');

  /* appid：线上优先，其次密钥推导 */
  const live = await fetchLive();
  let appid = live && live.appid;
  const keyPath = KEY || path.join(REL, 'key.pem');
  if (!appid && fs.existsSync(keyPath)) appid = extIdFromKeyPem(fs.readFileSync(keyPath, 'utf8'));
  if (!appid) log('⚠️ 取不到线上 appid，也没有密钥 → update.xml 里的 appid 将留空（Chrome 不会认）');

  /* 清单 */
  const manifestName = CHANNEL === 'beta' ? 'latest-beta.json' : 'latest.json';
  const latest = {
    version: version,
    zip: BASE + '/' + path.basename(srcZip),
    sha256: zipHash,
    notes: notes || ('v' + version + ' 更新'),
    publishedAt: new Date().toISOString().slice(0, 10),
    htmlUrl: 'https://github.com/moxiaoren/keyword-highlighter-extension/releases'
  };
  if (CHANNEL === 'beta') latest.channel = 'beta';
  else if (srcCrx && fs.existsSync(srcCrx)) latest.crx = BASE + '/' + path.basename(srcCrx);
  fs.writeFileSync(path.join(REL, manifestName), JSON.stringify(latest, null, 2) + '\n', 'utf8');
  log('已写：release/' + manifestName + '（版本 ' + version + '）');

  /* update.xml：只在稳定通道生成 */
  if (CHANNEL === 'beta') {
    log('测试通道：**不生成 update.xml**（稳定版专用，改了会把测试版推给所有用户）');
    return;
  }
  if (!srcCrx || !fs.existsSync(srcCrx)) {
    log('⚠️ 没给 --crx：不生成 update.xml（没有 crx 时生成它会让 Chrome 反复拉取失败）');
    return;
  }
  const crxHash = sha256(srcCrx);
  let codebase = BASE + '/' + path.basename(srcCrx);
  if (live && live.codebase) {
    const m = live.codebase.match(/^(.*\/)([^\/]+?)-\d+\.\d+\.\d+[^\/]*\.crx$/i);
    if (m) codebase = m[1] + m[2] + '-' + version + '.crx';
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    '  <app appid="' + (appid || '') + '">',
    '    <updatecheck codebase="' + codebase + '" version="' + version + '" />',
    '  </app>',
    '</gupdate>',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(REL, 'update.xml'), xml, 'utf8');
  log('已写：release/update.xml（appid=' + appid + '，crx sha256=' + crxHash.slice(0, 16) + '…）');
  log('       codebase=' + codebase);
  log('       注意：codebase 指向的文件名必须与你实际上传的 crx 文件名一致');
})().catch((e) => die('异常：' + (e && e.message)));
