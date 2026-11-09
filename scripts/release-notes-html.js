/* scripts/release-notes-html.js — 给每个版本出「一页看懂」的 HTML 说明（V2.0.8.18）
 * ----------------------------------------------------------------------------
 * 为什么需要：changelog.js 是纯文案表，扩展内能看、GitHub Release 也能贴，
 * 但用户说「以后发版都增加 html 说明网页，同步发 release」——要的是一页能直接
 * 打开、看得懂「这版改了什么、为什么改、自检过没过」的静态页。
 *
 * 唯一数据源仍是 `src/ui/changelog.js`（不另写一份文案）：本脚本只负责
 * 「取条目 → 转 HTML → 落盘」，版本号取自 manifest.json。
 *
 * 用法：
 *   node scripts/release-notes-html.js                  # 当前 manifest 版本
 *   node scripts/release-notes-html.js --version=2.0.8.17
 *   node scripts/release-notes-html.js --all            # 所有 changelog 版本各一页 + 索引
 *   node scripts/release-notes-html.js --tests=1017/1018 --meta=61 --e2e=150
 *   node scripts/release-notes-html.js --dry            # 只打印路径，不写文件
 *
 * 产出：
 *   release/notes/v<版本>.html   —— 单版本说明页（gh-pages 会递归发布，站点路径 /notes/v<版本>.html）
 *   release/notes/index.html     —— 索引（--all 时更新，单版本时按已存在页面重建）
 *
 * 页面自包含（内联样式、无外链脚本），深浅色跟随系统；不加载任何第三方资源。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'release', 'notes');
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const SITE = 'https://' + OWNER + '.github.io/' + REPO;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : '';
};
const DRY = argv.indexOf('--dry') >= 0;
const ALL = argv.indexOf('--all') >= 0;
const IS_TEST_RE = /^\d+\.\d+\.\d+\.\d+$/;

function manifestVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
}

/** 与 gh-release.js 同一套取法：changelog.js 是纯文案表，用 Function 取 CHANGELOG */
function changelog() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'changelog.js'), 'utf8');
  const fn = new Function(src + '\n;return CHANGELOG;');
  return fn();
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 只支持 changelog 实际用到的三种行内格式：`代码`、**加粗**、[文字](链接) */
function inline(s) {
  let h = esc(s);
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
    /^https?:\/\//.test(url) ? '<a href="' + url + '">' + text + '</a>' : m
  );
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

/** 条目形如「【修复·xxx】正文」——把方括号里的标签拆成徽标，便于扫读 */
function itemHtml(text) {
  const m = /^【([^】]+)】(.*)$/s.exec(String(text).trim());
  if (!m) return '<li class="item">' + inline(text) + '</li>';
  const tag = m[1];
  const body = m[2].replace(/^\s+/, '');
  const kind = /^修复/.test(tag) ? 'fix' : /^新增/.test(tag) ? 'new' : /^自检/.test(tag) ? 'gate' : /^改动|^优化/.test(tag) ? 'chg' : 'other';
  return (
    '<li class="item item-' + kind + '">' +
    '<span class="tag">' + esc(tag) + '</span>' +
    '<div class="item-body">' + inline(body) + '</div>' +
    '</li>'
  );
}

function gateHtml() {
  const tests = argOf('tests');
  const meta = argOf('meta');
  const e2e = argOf('e2e');
  const rows = [];
  if (tests) rows.push(['单元测试', tests.replace('/', ' / ')]);
  if (meta) rows.push(['meta-check（机械红线）', meta + ' 项']);
  if (e2e) rows.push(['真机 UI 回归', e2e + ' 项']);
  if (!rows.length) return '';
  return (
    '<section class="gates"><h2>门禁</h2><dl>' +
    rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') +
    '</dl></section>'
  );
}

const CSS = `
:root{--bg:#f7f8fa;--card:#fff;--fg:#1b1f24;--muted:#5b6672;--line:#e3e7ec;
--fix:#c0392b;--new:#1f7a4d;--chg:#1f5fa8;--gate:#6b5bd2;--other:#6b7684;}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--card:#1c2024;--fg:#e6e9ec;--muted:#9aa5b1;--line:#2b3138;
--fix:#ff8b80;--new:#6fd39b;--chg:#7fb6f5;--gate:#b3a8ff;--other:#9aa5b1;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:40px 20px 64px}
header .ver{font-size:34px;font-weight:700;letter-spacing:-.5px}
header .meta{color:var(--muted);font-size:14px;margin-top:6px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;margin-left:8px;vertical-align:3px}
.badge.beta{background:#fff0d6;color:#8a5a00}
.badge.stable{background:#e2f4e8;color:#1f7a4d}
@media (prefers-color-scheme:dark){.badge.beta{background:#3a2b12;color:#ffc86b}.badge.stable{background:#14301f;color:#6fd39b}}
ul.items{list-style:none;padding:0;margin:28px 0 0}
.item{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--other);border-radius:10px;
padding:14px 16px;margin-bottom:12px}
.item-fix{border-left-color:var(--fix)}.item-new{border-left-color:var(--new)}
.item-chg{border-left-color:var(--chg)}.item-gate{border-left-color:var(--gate)}
.tag{display:inline-block;font-size:12px;font-weight:700;padding:1px 8px;border-radius:6px;margin-bottom:8px;
color:var(--muted);background:rgba(127,127,127,.12)}
.item-fix .tag{color:var(--fix)}.item-new .tag{color:var(--new)}.item-chg .tag{color:var(--chg)}.item-gate .tag{color:var(--gate)}
.item-body p{margin:0 0 8px}.item-body p:last-child{margin-bottom:0}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(127,127,127,.14);
padding:1px 5px;border-radius:5px}
a{color:var(--chg)}
.gates{margin-top:28px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px}
.gates h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600}
.gates dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px;margin:0}
.gates dl>div{margin:0}
.gates dt{font-size:12px;color:var(--muted)}.gates dd{margin:2px 0 0;font-weight:600;font-variant-numeric:tabular-nums}
footer{margin-top:36px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:16px}
footer a{margin-right:16px}
table.list{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table.list th,table.list td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}
table.list th{color:var(--muted);font-weight:600}table.list tr:last-child td{border-bottom:0}
`;

function pageShell(title, body) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' + CSS + '</style></head>' +
    '<body><div class="wrap">' + body + '</div></body></html>\n'
  );
}

function renderVersion(entry, version) {
  const isTest = IS_TEST_RE.test(version);
  const date = argOf('date') || new Date().toISOString().slice(0, 10);
  const items = (entry && entry.items) || [];
  const body =
    '<header><div class="ver">高亮词助手 ' + esc(version) + '</div>' +
    '<div class="meta">' + esc(date) + ' · ' + (isTest ? '测试版' : '稳定版') +
    '<span class="badge ' + (isTest ? 'beta' : 'stable') + '">' + (isTest ? '测试版' : '稳定版') + '</span></div>' +
    '<div class="meta">这一版改了什么、为什么改；条目与扩展内「更新日志」同源。</div></header>' +
    (items.length
      ? '<ul class="items">' + items.map(itemHtml).join('') + '</ul>'
      : '<p class="meta">changelog 里没有这一版的条目（发布前先补 changelog.js）。</p>') +
    gateHtml() +
    '<footer><a href="' + SITE + '/notes/">全部版本说明</a>' +
    '<a href="https://github.com/' + OWNER + '/' + REPO + '/releases">Releases</a>' +
    '<a href="' + SITE + '/">项目主页</a></footer>';
  return pageShell('高亮词助手 ' + version + ' 更新说明', body);
}

function writeFile(rel, content) {
  const abs = path.join(OUT_DIR, rel);
  if (DRY) {
    console.log('[dry] ' + path.relative(ROOT, abs) + '  (' + content.length + ' B)');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  console.log('写 ' + path.relative(ROOT, abs) + '  (' + content.length + ' B)');
}

function renderIndex(versions) {
  const rows = versions
    .map((v) => {
      const href = 'v' + v.version + '.html';
      const exists = fs.existsSync(path.join(OUT_DIR, href));
      const kind = IS_TEST_RE.test(v.version) ? '测试版' : '稳定版';
      const first = (v.items && v.items[0]) || '';
      const brief = first.length > 60 ? first.slice(0, 60) + '…' : first;
      return (
        '<tr><td>' +
        (exists ? '<a href="' + esc(href) + '">' + esc(v.version) + '</a>' : esc(v.version)) +
        '</td><td>' + kind + '</td><td>' + (v.items || []).length + '</td><td>' + esc(brief) + '</td></tr>'
      );
    })
    .join('');
  const body =
    '<header><div class="ver">高亮词助手 · 版本说明</div>' +
    '<div class="meta">每个版本一页：改了什么、为什么改、门禁过没过。</div></header>' +
    '<table class="list"><thead><tr><th>版本</th><th>通道</th><th>条目</th><th>第一条</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<footer><a href="' + SITE + '/">项目主页</a>' +
    '<a href="https://github.com/' + OWNER + '/' + REPO + '/releases">Releases</a></footer>';
  return pageShell('高亮词助手 · 版本说明', body);
}

function main() {
  const cl = changelog();
  const byVer = new Map(cl.map((e) => [String(e.version).replace(/^v/, ''), e]));
  const target = (argOf('version') || manifestVersion()).replace(/^v/, '');
  if (ALL) {
    let n = 0;
    for (const entry of cl) {
      const v = String(entry.version).replace(/^v/, '');
      if (!/^\d+\.\d+/.test(v)) continue;
      writeFile('v' + v + '.html', renderVersion(entry, v));
      n++;
    }
    writeFile('index.html', renderIndex(cl));
    console.log('共 ' + n + ' 个版本页 + 索引');
    return;
  }
  const entry = byVer.get(target);
  if (!entry) {
    console.error('changelog.js 里没有 ' + target + ' 的条目 —— 先在 src/ui/changelog.js 顶部补一条再出页。');
    process.exitCode = 1;
    return;
  }
  writeFile('v' + target + '.html', renderVersion(entry, target));
  writeFile('index.html', renderIndex(cl));
}

main();
