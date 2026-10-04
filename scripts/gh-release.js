/* scripts/gh-release.js — 给每个版本补 GitHub Release（V1.99.99.15）
 * ----------------------------------------------------------------------------
 * 为什么需要：gh-pages 只承载"自动更新源 + 安装包"，而**人**要看的是 Release 页
 * （历史版本、每个版本改了什么、直接下 zip/crx）。此前 Releases 长期停在老版本，
 * 每次发版都得手动补 —— 现在固化进脚本。
 *
 * 用法：
 *   node scripts/gh-release.js              # 当前 manifest.version：建/更新 release
 *   node scripts/gh-release.js --all        # 把 release/ 里所有有产物的版本都补齐（幂等）
 *   node scripts/gh-release.js --dry        # 只打印将要做什么
 *   node scripts/gh-release.js --prune-above=1.99.99.15   # 删掉版本号大于该值的 Release（含 tag）
 *   node scripts/gh-release.js --prune-test              # **删掉所有测试版 Release（四段版本号，含 tag）**
 *
 * 【用户口径（2026-09）】**线上 Release 只放稳定版**：测试版是内部迭代，不往 Releases 上堆（发完测试版
 * 不用动 Releases）；稳定版发布时，其说明 = **这一段测试版要点的汇总**（见 stableNotes），
 * 而不是把十几条测试版说明原样铺上去。
 *
 * 设计要点：
 *   · **只给稳定版建 Release**：当前 manifest 是测试版（四段版本号）时直接跳过；
 *   · **幂等**：Release 已存在就更新说明、只补缺的附件（不会重复上传、不会报错退出）；
 *   · **说明取自 changelog.js（唯一来源）**，与扩展内"更新日志"逐字一致，不另写一份；
 *   · 附件：zip + crx（手动安装用）；老版本只有 zip 也能补；
 *   · tag 用 `v<version>`，指向仓库默认分支的 HEAD（本地没有 git 历史，只能这样标注）。
 * 凭据与 publish-gh.js 同一套（环境变量 GH_TOKEN / 工作区根目录 _gh_token.txt）。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const DRY = process.argv.indexOf('--dry') >= 0;
const ALL = process.argv.indexOf('--all') >= 0;
const PRUNE_ARG = (process.argv.find((a) => a.indexOf('--prune-above=') === 0) || '').split('=')[1] || '';
const PRUNE_TEST = process.argv.indexOf('--prune-test') >= 0;
/** 测试版 = 四段版本号（1.99.99.17 这种；稳定版是 1.99.100 / 2.0.0 三段） */
const IS_TEST_RE = /^\d+\.\d+\.\d+\.\d+$/;
const isTestVer = (v) => IS_TEST_RE.test(String(v).replace(/^v/, ''));

/** 版本号比较：`v1.99.99.15` 这类四段也支持；返回 -1/0/1 */
function cmpVer(a, b) {
  const p = (s) => String(s).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const A = p(a), B = p(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function readToken() {
  const cands = [
    path.join(ROOT, '..', '..', '_gh_token.txt'),
    path.join(ROOT, '..', '_gh_token.txt'),
    path.join(ROOT, 'release', '.gh_token')
  ];
  for (const f of cands) { try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* next */ } }
  return '';
}
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || readToken();

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
    method: method,
    headers: Object.assign({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'keyword-highlighter-gh-release'
    }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json: json, text: text };
}
function die(m) { console.error('\n✗ ' + m); process.exit(1); }

/** changelog.js 是纯文案表 → 用 Function 取 CHANGELOG，不另写一份说明 */
function changelog() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'changelog.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', src + '\nreturn typeof CHANGELOG !== "undefined" ? CHANGELOG : (window.CHANGELOG || []);');
  try { return fn({}) || []; } catch (e) { return []; }
}
const NOTES_RE = /^\s*【([^】]+)】\s*/;

/** 测试版（1.99.99.x 这条测试线 / 四段版本号）标为 pre-release，稳定版不标。
 * **当前 manifest 版本例外**：它要是正式 Release，才会在 Releases 页显示成「Latest」——
 * 否则最新版会被一堆 pre-release 挤到列表后面（用户实测反馈过"看不出哪个是最新"）。 */
function isPre(v) { return /^\d+\.\d+\.\d+\.\d+$/.test(String(v)) || /^1\.99\./.test(String(v)); }

function notesFor(version, all) {
  const entry = (all || []).find((c) => String(c.version) === String(version));
  const items = (entry && entry.items) || [];
  if (!items.length) return '（本版说明见扩展内「帮助与隐私 → 更新日志」）';
  return items.map((s) => '- ' + String(s).replace(NOTES_RE, '**$1** ').trim()).join('\n');
}

/**
 * **稳定版说明 = 这一段测试版要点的汇总**（用户口径："稳定版更新内容是测试版重点总结"）。
 * changelog 是"新的在前"，所以从开头取到当前版本为止；其中**测试版**（四段版本号）只抽标题当要点，
 * 当前稳定版自己的条目按完整说明列出（它是"这一版到底改了什么"的正式口径）。
 */
function stableNotes(version, all) {
  const list = all || [];
  const idx = list.findIndex((c) => String(c.version) === String(version));
  const upto = idx >= 0 ? list.slice(0, idx + 1) : list;
  const self = upto.find((c) => String(c.version) === String(version));
  const tests = upto.filter((c) => String(c.version) !== String(version) && isTestVer(c.version));
  const out = [];
  if (self && (self.items || []).length) {
    out.push(self.items.map((s) => '- ' + String(s).replace(NOTES_RE, '**$1** ').trim()).join('\n'));
  }
  if (tests.length) {
    out.push('### 本版汇总的测试版要点（' + tests.length + ' 个测试版，从新到旧）');
    for (const t of tests) {
      const titles = (t.items || []).map((s) => {
        const m = NOTES_RE.exec(String(s));
        return '- ' + (m ? m[1] : String(s).slice(0, 40));
      });
      if (titles.length) out.push('**v' + t.version + '**\n' + titles.join('\n'));
    }
  }
  return out.join('\n\n') || '（本版说明见扩展内「帮助与隐私 → 更新日志」）';
}

/** release/ 里该版本的产物：beta 优先，其次正式包 */
function assetsFor(version) {
  const out = [];
  const add = (f) => { const p = path.join(REL, f); if (fs.existsSync(p)) out.push({ name: f, p: p }); };
  add('keyword-highlighter-beta-v' + version + '.zip');
  add('keyword-highlighter-beta-v' + version + '.crx');
  add('keyword-highlighter-v' + version + '.zip');
  add('keyword-highlighter.crx');
  return out;
}

(async () => {
  if (!TOKEN) die('缺少凭据：设置 GH_TOKEN，或把 token 放到工作区根目录 _gh_token.txt');
  if (!fs.existsSync(REL)) die('没有 release/ 目录 —— 先跑 node scripts/release.js');

  const me = await api('GET', '/user');
  if (!me.ok) die('token 无效或已过期（HTTP ' + me.status + '）');
  const repo = await api('GET', '/repos/' + OWNER + '/' + REPO);
  if (!repo.ok) die('读不到仓库（HTTP ' + repo.status + '）');
  const def = (repo.json && repo.json.default_branch) || 'main';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cl = changelog();

  /* ① 清理模式：删 release + tag */
  if (PRUNE_ARG || PRUNE_TEST) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const r = await api('GET', '/repos/' + OWNER + '/' + REPO + '/releases?per_page=100&page=' + page);
      if (!r.ok || !r.json || !r.json.length) break;
      all.push.apply(all, r.json);
      if (r.json.length < 100) break;
    }
    /* `--prune-test`：删掉所有**测试版**（四段版本号）Release —— 用户口径"线上 Release 只放稳定版"；
     * `--prune-above=vX`：删掉版本号大于 X 的（当初用来清 2.x 那批失效测试版）。 */
    const targets = PRUNE_TEST
      ? all.filter((x) => isTestVer(x.tag_name))
      : all.filter((x) => cmpVer(x.tag_name, PRUNE_ARG) > 0);
    console.log((PRUNE_TEST ? '测试版（四段版本号）' : '大于 v' + PRUNE_ARG) + ' Release：' +
      (targets.length ? targets.map((x) => x.tag_name).join(', ') : '（无）'));
    for (const t of targets) {
      if (DRY) { console.log('  · 将删 ' + t.tag_name + '（id=' + t.id + '）'); continue; }
      const del = await api('DELETE', '/repos/' + OWNER + '/' + REPO + '/releases/' + t.id);
      console.log('  ' + (del.ok ? '已删 Release ' : '✗删除失败 ') + t.tag_name + (del.ok ? '' : '（HTTP ' + del.status + '）'));
      const tag = await api('DELETE', '/repos/' + OWNER + '/' + REPO + '/git/refs/tags/' + t.tag_name);
      console.log('    ' + (tag.ok ? '已删 tag ' : 'tag 未删 ') + t.tag_name + (tag.ok ? '' : '（HTTP ' + tag.status + '）'));
    }
    console.log('\n清理完成：' + (DRY ? '（dry run，未真的删）' : '删了 ' + targets.length + ' 个'));
    console.log('查看：https://github.com/' + OWNER + '/' + REPO + '/releases');
    return;
  }

  let versions = [];
  if (ALL) {
    const seen = {};
    for (const f of fs.readdirSync(REL)) {
      const m = /^keyword-highlighter(?:-beta)?-v(\d+\.\d+\.\d+(?:\.\d+)?)\.(?:zip|crx)$/.exec(f);
      if (m && !seen[m[1]]) { seen[m[1]] = 1; versions.push(m[1]); }
    }
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } else {
    versions = [manifest.version];
  }
  console.log('凭据用户：' + (me.json && me.json.login) + ' · 目标：' + versions.join(', ') + (DRY ? '（--dry 只打印）' : ''));

  let created = 0, updated = 0, skipped = 0;
  for (const v of versions) {
    const tag = 'v' + v;
    /* **线上 Release 只放稳定版**（用户口径）：测试版是内部迭代，发测试版时不动 Releases。 */
    if (isTestVer(v)) { console.log('  ○ ' + tag + '：测试版 → 不建 Release（Release 只放稳定版）'); skipped++; continue; }
    const assets = assetsFor(v);
    if (!assets.length) { console.log('  ○ ' + tag + '：没有产物文件，跳过'); skipped++; continue; }
    if (DRY) { console.log('  · 将建/更新 ' + tag + '（附件 ' + assets.length + ' 个）'); continue; }

    const body = stableNotes(v, cl) + '\n\n---\n安装：下载 `kh-autoupdate.bat`（见 [项目主页](https://' + OWNER + '.github.io/' + REPO + '/)）一键安装，' +
      '或下载本页 zip/crx 手动加载。\n';
    const exist = await api('GET', '/repos/' + OWNER + '/' + REPO + '/releases/tags/' + tag);
    let rel = null;
    if (exist.ok && exist.json && exist.json.id) {
      rel = (await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/releases/' + exist.json.id, {
        body: body, name: tag, draft: false, prerelease: false
      })).json || exist.json;
      updated++;
      console.log('  ↻ ' + tag + '：已存在 → 更新说明');
    } else {
      const made = await api('POST', '/repos/' + OWNER + '/' + REPO + '/releases', {
        tag_name: tag, target_commitish: def, name: tag, body: body, draft: false, prerelease: false
      });
      if (!made.ok) { console.log('  ✗ ' + tag + ' 建 Release 失败（HTTP ' + made.status + '）：' + String(made.text).slice(0, 160)); continue; }
      rel = made.json;
      created++;
      console.log('  ＋ ' + tag + '：新建');
    }
    /* 附件：只补缺的（已存在同名附件就跳过，避免 422）；二进制要走 uploads 通道 */
    const have = {};
    for (const a of ((rel && rel.assets) || [])) have[a.name] = 1;
    for (const a of assets) {
      if (have[a.name]) continue;
      const buf = fs.readFileSync(a.p);
      const res = await fetch('https://uploads.github.com/repos/' + OWNER + '/' + REPO + '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(a.name), {
        method: 'POST',
        headers: Object.assign({
          Accept: 'application/vnd.github+json',
          'Content-Type': /\.crx$/.test(a.name) ? 'application/x-chrome-extension' : 'application/zip',
          'Content-Length': String(buf.length),
          'User-Agent': 'keyword-highlighter-gh-release'
        }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
        body: buf
      });
      console.log('    ' + (res.ok ? '↑ ' : '✗ ') + a.name + '（' + Math.round(buf.length / 1024) + ' KB）' + (res.ok ? '' : ' HTTP ' + res.status));
    }
  }
  console.log('\n完成：新建 ' + created + ' · 更新 ' + updated + ' · 跳过 ' + skipped);
  console.log('查看：https://github.com/' + OWNER + '/' + REPO + '/releases');
})().catch((e) => { console.error('异常：', e && e.message); process.exitCode = 1; });
