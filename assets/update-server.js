/**
 * 关键词高亮扩展 - 自动覆盖辅助服务
 *
 * 方案 B+：本机常驻脚本，让插件"点一下更新"即可自动完成 下载 → 解压 → 覆盖 → 重载。
 *
 * 运行方式（Windows）：
 *   node D:\kh-updater\update-server.js
 *
 * 或做成开机自启更方便（见文件底部说明）。
 *
 * 依赖：
 *   - Node.js（需已安装）
 *   - Windows 自带的 PowerShell（用于解压 zip，无需额外安装）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

/* ================= 配置（按需修改） ================= */
const PORT = 8787;                    // 本地服务端口（插件默认请求此端口）
// 插件目录绝对路径：优先取环境变量 KH_EXT_DIR（由生成的 cmd 配置），否则用默认值
const EXT_DIR = process.env.KH_EXT_DIR || 'D:\\keyword-highlighter-extension';
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const ALLOWED_ORIGIN = '*';           // 跨域：允许扩展 popup 请求（chrome-extension:// 来源）
/* =================================================== */

// 简易日志
function log(msg) { console.log(`[${new Date().toLocaleString()}] ${msg}`); }
function errLog(msg) { console.error(`[${new Date().toLocaleString()}] [ERROR] ${msg}`); }

// ------------- HTTP 工具 -------------
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'kh-updater'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    // 递归跟随重定向；只有拿到最终 200 响应时才创建写入流，避免并发写坏文件
    const doGet = (u) => {
      https.get(u, { headers: { 'User-Agent': 'kh-updater' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          res.resume();
          if (res.headers.location) return doGet(res.headers.location);
          return reject(new Error('重定向无目标地址'));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve()); });
        file.on('error', reject);
        res.on('error', (e) => { file.destroy(); reject(e); });
      }).on('error', reject);
    };
    doGet(url);
  });
}

// ------------- zip 解压（优先 bsdtar，退回 .NET ZipFile） -------------
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const q = (p) => '"' + String(p).replace(/"/g, '\"') + '"';

  // 方式一：Windows 10+ 自带 tar.exe（bsdtar），对 zip 兼容性最好
  try {
    execSync(`tar -xf ${q(zipPath)} -C ${q(destDir)}`, { stdio: 'pipe' });
    return;
  } catch (e) {
    // 静默，尝试方式二
  }

  // 方式二：.NET ZipFile.ExtractToDirectory（比 Expand-Archive 可靠）
  const ps = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')"`;
  execSync(ps, { stdio: 'pipe' });
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      if (fs.existsSync(d)) {
        try { fs.unlinkSync(d); } catch (e) { /* 忽略被占用 */ }
      }
      fs.copyFileSync(s, d);
    }
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// ------------- 核心：执行更新 -------------
async function doUpdate() {
  // 1. 拉取 latest release
  log('正在查询最新版本...');
  const release = await httpGetJson(API_URL);
  if (!release || !release.tag_name) throw new Error('获取 release 信息失败');

  const zipAsset = (release.assets || []).find(a => a && /\.zip$/i.test(a.name));
  const zipUrl = zipAsset ? zipAsset.browser_download_url : release.zipball_url;
  if (!zipUrl) throw new Error('未找到 zip 下载地址');

  // 2. 校验插件目录存在
  if (!fs.existsSync(EXT_DIR)) throw new Error(`插件目录不存在: ${EXT_DIR}`);

  // 3. 下载 zip 到临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-update-'));
  const zipPath = path.join(tmpDir, 'plugin.zip');
  log(`正在下载 ${release.tag_name} ...`);
  await downloadFile(zipUrl, zipPath);

  // 校验下载文件：存在、非空、是 zip（PK 魔数）
  const stat = fs.statSync(zipPath);
  if (stat.size < 100) throw new Error('下载的文件过小，疑似下载失败');
  const head = fs.readFileSync(zipPath).slice(0, 2).toString('latin1');
  if (head !== 'PK') throw new Error('下载的文件不是有效的 zip 格式');
  log(`下载完成，大小 ${stat.size} 字节`);

  // 4. 解压
  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  log('正在解压...');
  extractZip(zipPath, extractDir);

  // 5. 定位解压后的插件根目录（zip 内可能是单层目录）
  let srcRoot = extractDir;
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  const dirs = entries.filter(d => d.isDirectory());
  // 若解压出来是单层目录且里面含 manifest.json，则用这层
  const candidates = [srcRoot, ...dirs.map(d => path.join(extractDir, d.name))];
  let chosen = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) { chosen = c; break; }
  }
  if (!chosen) throw new Error('解压内容中没有找到 manifest.json');

  // 6. 备份旧目录（可选），并覆盖
  const manifest = readJsonFile(path.join(chosen, 'manifest.json'));
  const newVersion = manifest && manifest.version ? `v${manifest.version}` : release.tag_name;
  log(`准备覆盖到 ${EXT_DIR}，新版本 ${newVersion}`);

  // 覆盖：逐文件替换
  copyDir(chosen, EXT_DIR);

  // 7. 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  log(`✅ 更新完成，已覆盖为 ${newVersion}`);
  return { changed: newVersion, checkedAt: Date.now() };
}

// ------------- HTTP 服务 -------------
const server = http.createServer((req, res) => {
  const respond = (status, obj) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(obj));
  };

  // CORS 预检
  if (req.method === 'OPTIONS') { respond(204, {}); return; }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/health' && req.method === 'GET') {
    respond(200, { ok: true, msg: 'kh-updater is running' });
    return;
  }

  if (url.pathname === '/update' && req.method === 'POST') {
    doUpdate().then(
      (r) => respond(200, { ok: true, ...r }),
      (e) => { errLog(String(e && e.message || e)); respond(500, { ok: false, msg: String(e && e.message || e) }); }
    );
    return;
  }

  respond(404, { ok: false, msg: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`kh-updater 已启动: http://127.0.0.1:${PORT}`);
  log(`插件目录: ${EXT_DIR}`);
  log(`检测仓库: ${OWNER}/${REPO}`);
});

/* ================== 开机自启说明（可选） ==================
 * 想让脚本随 Windows 启动自动运行：
 *  1. 把本文件放到 D:\kh-updater\update-server.js
 *  2. Win+R 输入 shell:startup 回车，打开启动文件夹
 *  3. 在里面新建一个 update-server.cmd，内容：
 *       @echo off
 *       start "" /min node "D:\kh-updater\update-server.js"
 *  这样每次开机它会在后台静默运行，无需手动启动。
 * ======================================================= */
