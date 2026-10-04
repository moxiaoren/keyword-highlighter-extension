/* scripts/sync-mirrors.js — 把线上（gh-pages 分支）四份发布清单同步回仓库镜像
 *
 * 为什么需要：
 *   CI 发布**不回写 main**（工作流只推 gh-pages），所以仓库 `release/` 里的四份清单是**镜像**，
 *   发布一次就落后一次。2026-10-04 实测踩到两回：`check-channels.js --live --deep` 拿镜像当
 *   基准，把自洽的线上链误报成失败；镜像与线上不一致也会让"本地自检"看起来是绿的其实早已脱节。
 *   发布之后跑一次本脚本，镜像与线上逐字节对齐（含 sha256 / 版本），本地自检才重新有意义。
 *
 * 数据来源：
 *   `https://api.github.com/repos/<OWNER>/<REPO>/contents/<file>?ref=gh-pages`（`Accept: application/vnd.github.raw`
 *   ⇒ 直接拿该分支上的**原始字节**，不经 Pages CDN，不会拿到缓存里的旧版本）。
 *   公开仓库无需令牌（未认证限流 60 次/小时，本脚本一次最多 4 次请求）。
 *
 * 用法：
 *   node scripts/sync-mirrors.js            # 同步并打印 旧→新（字节数 / sha256 / 版本）
 *   node scripts/sync-mirrors.js --dry-run  # 只看差异不写盘
 *   任一文件拉取或写入失败即 exit 1（不静默跳过）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const BRANCH = 'gh-pages';
const FILES = ['latest.json', 'update.xml', 'latest-beta.json', 'update-beta.xml'];
const DRY = process.argv.slice(2).indexOf('--dry-run') >= 0;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const head = (s) => String(s).slice(0, 16) + '…';

function versionOf(name, text) {
  if (name.slice(-5) === '.json') {
    try { return 'version=' + (JSON.parse(text).version || '?'); } catch { return 'version=解析失败'; }
  }
  const m = text.match(/<updatecheck\s[^>]*version="([^"]+)"/i);
  return 'version=' + (m ? m[1] : '?');
}

async function main() {
  if (typeof fetch !== 'function') { console.error('✗ 本机 Node 无 fetch，无法同步'); process.exit(1); }
  console.log('=== 同步仓库镜像 ← gh-pages 分支（' + OWNER + '/' + REPO + '）===');
  let failed = 0;
  let changed = 0;
  for (const name of FILES) {
    const url = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + name + '?ref=' + BRANCH;
    let buf;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'kh-sync-mirrors' }, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      console.error('  ✗ release/' + name + ' 拉取失败：' + e.message);
      failed++;
      continue;
    }
    const local = path.join(REL, name);
    const old = fs.existsSync(local) ? fs.readFileSync(local) : null;
    const same = old && old.equals(buf);
    const text = buf.toString('utf8');
    const line = 'release/' + name + '  ' + (old ? old.length + ' B → ' : '（缺）→ ') + buf.length + ' B  '
      + (same ? '未变' : sha256(old || Buffer.alloc(0)).slice(0, 4) + '… → ' + head(sha256(buf))) + '  ' + versionOf(name, text);
    if (same) { console.log('  = ' + line); continue; }
    if (DRY) { console.log('  ~ ' + line + '（--dry-run，未写）'); changed++; continue; }
    try { fs.writeFileSync(local, buf); } catch (e) { console.error('  ✗ release/' + name + ' 写入失败：' + e.message); failed++; continue; }
    console.log('  ✓ ' + line);
    changed++;
  }
  console.log('  镜像改动 ' + changed + ' 个，失败 ' + failed + ' 个'
    + (DRY ? '（--dry-run）' : '') + '；同步后请跑 node scripts/check-channels.js --live --deep 复核');
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('✗ 同步异常：' + e.message); process.exit(1); });
