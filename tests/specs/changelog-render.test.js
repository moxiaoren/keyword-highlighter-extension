/* tests/specs/changelog-render.test.js — 更新日志渲染（C7 F-6）
 * ----------------------------------------------------------------------------
 * 缺陷（findings F-6）：更新日志条目是 **Markdown 文本**，但两处渲染各写各的 ——
 *   · `welcome/welcome.js` 直接 `li.innerHTML = it`（标记原样上屏 + innerHTML 汇点）
 *   · `options/options.js` 走 `h('li', { text: String(t) })`（同样把 `**` 与反引号原样印出）
 * 全库实测 1,514 处 `**`、1,250 处反引号，172 个版本条目 —— 用户看到的就是满屏标记。
 *
 * 修后两处都过 `KH.Markdown.toDocFragment`（同一套语法的文档档：认行内代码、
 * **不产出任何链接/图片**）。本 spec 拿**真实数据**（src/ui/changelog.js）逐条渲染，
 * 断言的是"用户真的看不到标记、也点不到示例网址"，而不是某段源码长什么样：
 *   · 不产出 a / img / script / iframe / style（HTML 汇点关闭）
 *   · 成对的 `反引号` 与 `**加粗**` 绝不上屏
 *   · 渲染不吞内容（去掉标记后的文本必须是原文的有序子序列）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');

/** 在 Node 里把 changelog.js 当数据文件跑一遍（它是纯数据：window.CHANGELOG = [...]） */
function loadChangelog() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'changelog.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.CHANGELOG;
}

function ser(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  let s = '';
  for (const c of node.childNodes || []) s += ser(c);
  return s;
}
function walk(node, out) {
  out = out || [];
  for (const c of node.childNodes || []) {
    if (c.nodeType === 1) { out.push(c); walk(c, out); }
  }
  return out;
}
function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
/** a 是否是 b 的有序子序列（渲染只许删标记，不许造字） */
function isSubseq(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++;
  return i === a.length;
}
/** 剥掉块注释与行注释（与 write-honesty 的 code() 同一口径）：旧写法会留在注释里当反面教材 */
function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const M = KH.Markdown;
  const CL = loadChangelog();

  suite('changelog · 渲染（C7 F-6）');

  await test('数据源可读，且两处渲染都指向同一个文档档（单源）', () => {
    truthy(Array.isArray(CL) && CL.length > 100,
      'changelog.js 应能解析出 100+ 个版本条目，实际 ' + (CL && CL.length));
    eq(typeof M.toDocFragment, 'function', '★ 文档档入口必须存在（旧代码根本没有这一档）');
    const opt = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
    const wel = fs.readFileSync(path.join(ROOT, 'welcome', 'welcome.js'), 'utf8');
    truthy(/toDocFragment/.test(opt), '★ options 侧必须走文档档（旧代码是 h(li,{text})）');
    truthy(/toDocFragment/.test(wel), '★ welcome 侧必须走文档档（旧代码是 li.innerHTML = it）');
    /* 断言要看**去掉注释的代码**：旧写法的原样还留在旁边当反面教材的注释里 */
    falsy(/li\.innerHTML\s*=/.test(stripComments(wel)), '★ 条目不许再走 innerHTML');
    const whtml = fs.readFileSync(path.join(ROOT, 'welcome', 'welcome.html'), 'utf8');
    truthy(/src\/platform\/markdown\.js/.test(whtml),
      '★ welcome 页必须真的把渲染器加载进来（否则只能退回纯文本，标记照旧上屏）');
  });

  await test('★全量真实数据渲染：不产出 a / img / script / iframe / style', () => {
    const bad = {};
    let items = 0, codes = 0, pairedTicks = 0, pairedBold = 0;
    for (const rel of CL) {
      for (const it of (rel.items || [])) {
        const raw = String(it);
        items++;
        if (/`[^`]+`/.test(raw)) pairedTicks++;
        if (/\*\*[^*]+\*\*/.test(raw)) pairedBold++;
        const f = M.toDocFragment(raw, document);
        const els = walk(f);
        for (const el of els) {
          const t = el.tagName;
          if (t === 'CODE') codes++;
          if (t === 'A' || t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME' || t === 'STYLE') {
            bad[t] = (bad[t] || 0) + 1;
          }
        }
      }
    }
    truthy(items > 300, '真实条目数应远超 300，实际 ' + items);
    eq(JSON.stringify(bad), '{}', '★ 文档档不许产出这些元素：' + JSON.stringify(bad));
    truthy(pairedTicks > 50, '含成对反引号的条目应 > 50，实际 ' + pairedTicks);
    truthy(codes >= pairedTicks,
      '★ 每个含成对反引号的条目都该渲染出 <code>：code=' + codes + ' 条目=' + pairedTicks);
    truthy(pairedBold > 50, '含成对加粗的条目应 > 50，实际 ' + pairedBold);
  });

  await test('★成对的标记绝不上屏（`反引号` 与 **加粗** 都会被渲染掉）', () => {
    const leaked = [];
    let checked = 0;
    for (const rel of CL) {
      for (const it of (rel.items || [])) {
        const raw = String(it);
        const ticks = countOf(raw, '`');
        const bolds = countOf(raw, '**');
        if (ticks === 0 && bolds === 0) continue;
        const txt = ser(M.toDocFragment(raw, document));
        checked++;
        if (ticks >= 2 && ticks % 2 === 0 && txt.indexOf('`') >= 0) {
          leaked.push('反引号: ' + raw.slice(0, 60));
        }
        if (bolds >= 2 && bolds % 2 === 0 && txt.indexOf('**') >= 0) {
          leaked.push('加粗: ' + raw.slice(0, 60));
        }
      }
    }
    truthy(checked > 200, '带标记的条目应 > 200，实际 ' + checked);
    eq(leaked.length, 0, '★ 标记漏到屏幕上的条目：' + leaked.slice(0, 5).join(' | '));
  });

  await test('★渲染不吞内容：去标记后的文本必须是原文的有序子序列', () => {
    const badText = [];
    for (const rel of CL) {
      for (const it of (rel.items || [])) {
        const raw = String(it);
        const txt = ser(M.toDocFragment(raw, document));
        if (!txt.length || !isSubseq(txt, raw)) badText.push(raw.slice(0, 60));
      }
    }
    eq(badText.length, 0, '★ 渲染出原文里没有的字（或有条目被渲染成空）：' + badText.slice(0, 5).join(' | '));
  });

  await test('★示例网址保持字面文本（不许变成可点外链 / 图片）', () => {
    const withUrl = [];
    for (const rel of CL) {
      for (const it of (rel.items || [])) if (/https?:\/\//.test(String(it))) withUrl.push(String(it));
    }
    truthy(withUrl.length > 0, '真实数据里应有含网址的条目（否则这条断言是空跑）');
    const sample = withUrl[0];
    const f = M.toDocFragment(sample, document);
    eq(f.querySelectorAll('a').length, 0, '★ 不许有链接：' + sample.slice(0, 80));
    truthy(ser(f).indexOf('http') >= 0, '网址要以字面文本留下：' + ser(f).slice(0, 80));
  });
};
