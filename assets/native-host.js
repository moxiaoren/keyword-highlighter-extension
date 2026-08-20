/**
 * 关键词高亮扩展 - Native Messaging 原生宿主
 *
 * 方案②：最彻底的"真·一键"自动更新。
 * 通过 Chrome Native Messaging 与扩展 popup 通信：
 *   扩展 point("更新") → sendNativeMessage → 本宿主收到 {type:'update'}
 *   → 自动 下载 ZIP → 解压 → 覆盖插件目录 → 回执 {ok:true}
 *   再由扩展 chrome.runtime.reload() 应用新代码。
 *
 * 运行方式：由 Chrome 自动拉起（注册表指向 kh-native-host.cmd 包装脚本，实际调用本文件）。
 * 首次部署：双击 popup 生成的 kh-register-native.cmd 完成注册。
 *
 * 依赖：
 *   - Node.js
 *   - Windows 自带 tar.exe / PowerShell（解压 zip）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

/* ================= 配置（从环境变量注入，由注册脚本写入） ================= */
// 插件目录绝对路径（注册脚本通过 set KH_EXT_DIR=... 传入，子进程继承）
const EXT_DIR = process.env.KH_EXT_DIR || 'D:\\keyword-highlighter-extension';
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const HOST_NAME = 'com.kh.nativehost';
/* ======================================================================== */

function log(msg) { console.error(`[native-host ${new Date().toLocaleString()}] ${msg}`); }

// ------------- 更新核心（与 update-server.js 同逻辑） -------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'kh-native-host' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      https.get(u, { headers: { 'User-Agent': 'kh-native-host' } }, (res) => {
        if ([301, 302, 307].includes(res.statusCode) && res.headers.location) {
          res.resume(); return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve()));
        f.on('error', reject);
        res.on('error', (e) => { f.destroy(); reject(e); });
      }).on('error', reject);
    };
    doGet(url);
  });
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const q = (p) => '"' + String(p).replace(/"/g, '\\"') + '"';
  try { execSync(`tar -xf ${q(zipPath)} -C ${q(destDir)}`, { stdio: 'pipe' }); return; } catch (e) {}
  const ps = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')"`;
  execSync(ps, { stdio: 'pipe' });
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      if (fs.existsSync(d)) { try { fs.unlinkSync(d); } catch (_) {} }
      fs.copyFileSync(s, d);
    }
  }
}

function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

async function doUpdate() {
  log('查询最新版本...');
  const release = await httpGetJson(API_URL);
  if (!release || !release.tag_name) throw new Error('获取 release 信息失败');
  const zipAsset = (release.assets || []).find(a => a && /\.zip$/i.test(a.name));
  const zipUrl = zipAsset ? zipAsset.browser_download_url : release.zipball_url;
  if (!zipUrl) throw new Error('未找到 zip 下载地址');
  if (!fs.existsSync(EXT_DIR)) throw new Error(`插件目录不存在: ${EXT_DIR}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-nh-'));
  const zipPath = path.join(tmpDir, 'plugin.zip');
  log(`下载 ${release.tag_name} ...`);
  await downloadFile(zipUrl, zipPath);

  const stat = fs.statSync(zipPath);
  if (stat.size < 100) throw new Error('下载文件过小');
  if (fs.readFileSync(zipPath).slice(0, 2).toString('latin1') !== 'PK') throw new Error('不是有效 zip');

  const extractDir = path.join(tmpDir, 'extract');
  extractZip(zipPath, extractDir);

  let srcRoot = extractDir;
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  const dirs = entries.filter(d => d.isDirectory());
  const candidates = [srcRoot, ...dirs.map(d => path.join(extractDir, d.name))];
  let chosen = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) { chosen = c; break; }
  }
  if (!chosen) throw new Error('解压内容没有 manifest.json');

  const manifest = readJsonFile(path.join(chosen, 'manifest.json'));
  const newVersion = manifest && manifest.version ? `v${manifest.version}` : release.tag_name;
  log(`覆盖到 ${EXT_DIR} → ${newVersion}`);
  copyDir(chosen, EXT_DIR);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  log(`✅ 完成: ${newVersion}`);
  return { changed: newVersion };
}

// ------------- 注册模式：生成 host 所需文件并写入注册表 -------------
// 用法：node native-host.js --register <扩展ID> [插件目录]
// 由 popup 生成的 kh-register-native.cmd 调用；一切路径/转义都在 JS 里处理
function registerHost() {
  const args = process.argv.slice(2);
  const extId = (args[1] || 'YOUR_EXTENSION_ID').trim();
  const extDir = (args[2] || EXT_DIR).trim();
  const dir = path.join(os.homedir(), 'kh-updater');
  fs.mkdirSync(dir, { recursive: true });

  // 1) kh-start.cmd：设插件目录环境变量并启动宿主
  const startCmd =
    '@echo off\r\n' +
    'set "KH_EXT_DIR=' + extDir + '"\r\n' +
    'node "%~dp0native-host.js"\r\n';
  // 用正斜杠避免 JS 字符串里的反斜杠转义混乱（写文件时转绝对路径用双反斜杠更稳）
  const startPath = path.join(dir, 'kh-start.cmd');
  fs.writeFileSync(startPath, startCmd, 'utf8');

  // 2) manifest.json：path 用正斜杠（Windows 进程启动接受正斜杠，且 JSON 无需转义）
  const manifest = {
    name: HOST_NAME,
    description: 'keyword-highlighter-extension auto-update native host',
    path: startPath.replace(/\\/g, '/'),
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + extId + '/']
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // 3) 注册到系统（当前用户 HKCU；Chrome 与 Edge）
  const regs = [
    ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME, manifestPath],
    ['HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME, manifestPath]
  ];
  for (const [key, val] of regs) {
    try {
      execSync(`reg add "${key}" /ve /t REG_SZ /d "${val}" /f`, { stdio: 'pipe' });
      log('注册成功: ' + key);
    } catch (e) {
      log('注册失败: ' + key + ' → ' + (e && e.message));
    }
  }

  log('✅ 原生宿主已注册\n  宿主文件:' + startPath + '\n  插件目录:' + extDir);
  return { ok: true, extId, extDir, dir };
}

// ------------- Native Messaging 协议（stdin/stdout，长度前缀大端 JSON） -------------

// 读 stdin 为 Buffer
function readStdinAll(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// 从 message buffer 中解析 Native Messaging 消息（可多条）
function parseMessages(buf) {
  const msgs = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off); // Chrome 用小端长度前缀
    off += 4;
    if (off + len > buf.length) break;
    const payload = buf.slice(off, off + len).toString('utf8');
    off += len;
    try { msgs.push(JSON.parse(payload)); } catch (e) {}
  }
  return msgs;
}

function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0); // 输出同样用小端
  process.stdout.write(Buffer.concat([header, json]));
}

// 入口
if (process.argv[2] === '--register') {
  registerHost();
  process.exit(0);
}

// 主循环
async function main() {
  log('原生宿主已启动, EXT_DIR=' + EXT_DIR);
  const buf = await readStdinAll(process.stdin);
  const msgs = parseMessages(buf);
  for (const msg of msgs) {
    if (!msg || msg.type === 'ping') { sendMessage({ ok: true, pong: true }); continue; }
    if (msg.type === 'update') {
      try {
        const r = await doUpdate();
        sendMessage({ ok: true, changed: r.changed });
      } catch (e) {
        log('更新失败: ' + (e && e.message || e));
        sendMessage({ ok: false, error: String(e && e.message || e) });
      }
      continue;
    }
    sendMessage({ ok: false, error: 'unknown type: ' + (msg && msg.type) });
  }
  // 结束后退出（Chrome 会关闭 stdin）
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error(e); process.exit(1); });
