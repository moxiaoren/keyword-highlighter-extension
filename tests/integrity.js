'use strict';
/* 一致性体检：① manifest/HTML 引用的脚本与样式都存在；② JS 里引用的 id 都在 HTML 里；
 * ③ 没有重复 id；④ HTML 标签配平 + 帮助面板父链；⑤ CSS 里引用的 var(--x) 都有定义
 * （tokens/components/页面样式范围内）；⑥ 交付包里不得有测试/调试文件 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* ---------- 1. script/link 引用存在 ---------- */
const HTMLS = ['options/options.html', 'popup/popup.html', 'welcome/welcome.html'];
for (const html of HTMLS) {
  if (!exists(html)) { problems.push('缺少 ' + html); continue; }
  const src = read(html);
  const refs = [];
  for (const m of src.matchAll(/<script\s+src="([^"]+)"/g)) refs.push(m[1]);
  for (const m of src.matchAll(/<link[^>]+href="([^"]+)"/g)) refs.push(m[1]);
  for (const r of refs) {
    if (/^https?:/.test(r)) continue;
    const abs = path.normalize(path.join(path.dirname(html), r)).replace(/\\/g, '/');
    if (!exists(abs)) problems.push(html + ' 引用了不存在的资源: ' + r + ' → ' + abs);
  }
  notes.push(html + ': ' + refs.length + ' 个资源引用全部存在');
}

/* ---------- 2. id 重复 / JS 引用缺失 ---------- */
for (const html of HTMLS) {
  if (!exists(html)) continue;
  const src = read(html);
  const ids = [...src.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  const seen = new Set();
  const dups = [];
  for (const id of ids) { if (seen.has(id)) dups.push(id); seen.add(id); }
  if (dups.length) problems.push(html + ' 有重复 id: ' + [...new Set(dups)].join(', '));

  // 同目录 JS 里 $('xxx') / getElementById('xxx') 引用的 id
  const jsDir = path.dirname(html);
  const jsFiles = fs.readdirSync(path.join(ROOT, jsDir)).filter(f => f.endsWith('.js'));
  const missing = new Set();
  const unused = new Set(ids);
  for (const jf of jsFiles) {
    const js = read(jsDir + '/' + jf);
    for (const m of js.matchAll(/(?:\$|getElementById)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) {
      const id = m[1];
      if (!seen.has(id)) missing.add(id + ' (' + jf + ')');
      unused.delete(id);
    }
  }
  if (missing.size) problems.push(html + ' 的 JS 引用了不存在的 id: ' + [...missing].join(', '));
  notes.push(html + ': ' + ids.length + ' 个 id，重复 0，JS 缺失引用 ' + missing.size);
}

/* ---------- 3. HTML 标签配平 + 帮助面板父链 ----------
 * 为什么加（issue #20）：options.html 的 `perf` 面板曾经少一个 `</div>`，于是紧跟其后的
 * `about` 面板被并进 perf 里、跟着它的 display:none 一起量到 0×0 —— 用户看到的是
 * 「关于面板整块空白」。而 ①②③ 全绿：**少一个闭合标签，既有检查一个都看不见**。
 * `kh-hpanel` 的父链单独查：帮助页签面板靠 `#sec-help .kh-hpanel` 找（options.js 切换逻辑），
 * 面板一旦被别的面板吞进去，页签就切不动它。 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const PANEL_PARENT = { 'options/options.html': 'sec-help' };
for (const html of HTMLS) {
  if (!exists(html)) continue;
  /* 注释里的 `<div>`、脚本与样式里的 `<` 都不是标签（脚本里有字符串，样式里有选择器） */
  const src = read(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '<style></style>');
  const stack = [];
  let opened = 0;
  const errs = [];
  const describe = (e) => e ? ('<' + e.tag + (e.id ? '#' + e.id : (e.cls ? '.' + e.cls.split(/\s+/)[0] : '')) + '>') : '文档结尾';
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:'[^']*'|"[^"]*"|[^>'"])*)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (closing) {
      const top = stack.pop();
      if (!top || top.tag !== tag) errs.push('</' + tag + '> 与 ' + describe(top) + ' 不配平');
    } else if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) {
      opened++;                                   // 空元素（<br> / <img …> / <svg …/>）：不进栈
    } else {
      const id = (attrs.match(/\bid="([^"]*)"/) || [])[1] || '';
      const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1] || '';
      const want = PANEL_PARENT[html];
      if (want && /\bkh-hpanel\b/.test(cls)) {
        const parent = stack[stack.length - 1];
        if (!parent || parent.id !== want) {
          errs.push('帮助面板 ' + describe({ tag, id, cls }) + ' 嵌在 ' + describe(parent) +
            ' 里，应在 #' + want + ' 的直接子级');
        }
      }
      opened++;
      stack.push({ tag, id, cls });
    }
  }
  if (stack.length) errs.push('未闭合: ' + stack.map(describe).join(' → '));
  if (errs.length) errs.forEach(e => problems.push(html + ' 结构: ' + e));
  else notes.push(html + ': ' + opened + ' 个标签配平，' +
    (PANEL_PARENT[html] ? '帮助面板父链指向 #' + PANEL_PARENT[html] : '无面板父链约束'));
}

/* ---------- 4. CSS var 定义 ---------- */
const CSS_DEFS = new Set();
const CSS_FILES = [];
(function walkCss(dir) {
  for (const n of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + '/' + n;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walkCss(rel);
    else if (n.endsWith('.css')) CSS_FILES.push(rel);
  }
})('.');
for (const f of CSS_FILES) {
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/gi)) CSS_DEFS.add(m[1]);
}
const UNDEF = new Map();
for (const f of CSS_FILES) {
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!CSS_DEFS.has(m[1])) {
      if (!UNDEF.has(m[1])) UNDEF.set(m[1], []);
      UNDEF.get(m[1]).push(f);
    }
  }
}
if (UNDEF.size) {
  for (const [v, files] of UNDEF) problems.push('CSS 变量未定义: ' + v + '  (用于 ' + [...new Set(files)].join(', ') + ')');
} else {
  notes.push('CSS: ' + CSS_FILES.length + ' 个文件，所有 var(--x) 都有定义（' + CSS_DEFS.size + ' 个变量）');
}

/* ---------- 5. manifest 一致性 ---------- */
const mf = JSON.parse(read('manifest.json'));
const cs = (mf.content_scripts || [])[0] || {};
for (const f of (cs.js || []).concat(cs.css || [])) if (!exists(f)) problems.push('manifest content_scripts 引用不存在: ' + f);
for (const f of Object.values(mf.icons || {})) if (!exists(f)) problems.push('manifest icons 引用不存在: ' + f);
if (mf.background && !exists(mf.background.service_worker)) problems.push('manifest service_worker 不存在');
if (mf.action && mf.action.default_popup && !exists(mf.action.default_popup)) problems.push('manifest popup 不存在');
if (mf.options_page && !exists(mf.options_page)) problems.push('manifest options_page 不存在');
notes.push('manifest: v' + mf.version + '，权限 ' + JSON.stringify(mf.permissions) + '，命令 ' + Object.keys(mf.commands || {}).join(','));

/* ---------- 6. 交付包里不得有测试/调试文件 ---------- */
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  const zips = fs.readdirSync(dist).filter(f => f.endsWith('.zip'));
  notes.push('dist: ' + (zips.join(', ') || '(空)'));
}

console.log('=== 体检结果 ===\n');
notes.forEach(n => console.log('  ✓ ' + n));
if (problems.length) {
  console.log('');
  problems.forEach(p => console.log('  ✗ ' + p));
  console.log('\n发现 ' + problems.length + ' 个问题');
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
