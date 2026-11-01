/* scripts/changelog.js — 从应用内更新日志生成仓库根 `CHANGELOG.md`
 *
 * 为什么需要它（而不是手抄）：
 *   版本说明以前有四份——应用内 `src/ui/changelog.js`、`README.md`、`_memory/STATUS.md`、
 *   gh-pages 上的 release notes。改一处必漏三处，于是同一版在四个地方写着不同的数字
 *   （2.0.6.2 的"931 / 930"与"869"就同时存在过）。
 *   现在只认 `src/ui/changelog.js` 一份真源，其余从它生成或核对。
 *
 * 用法：
 *   node scripts/changelog.js          生成/覆盖仓库根 CHANGELOG.md
 *   node scripts/changelog.js --check  只核对：不同步则打印差异摘要并 exit 1（发版流程调用）
 *
 * 退出码：0 = 已同步（或已写入）· 1 = --check 发现不同步 · 2 = 解析不到任何版本条目
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'ui', 'changelog.js');
const OUT = path.join(ROOT, 'CHANGELOG.md');

/* 扫出 `items: [ ... ]` 的结束位置：按括号深度走，跳过字符串字面量。
 * 不能简单找 `] }` ——说明文字里会出现方括号（`#表` 的批量弹窗、`data-raw` 这些）。 */
function endOfArray(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unescape(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (all, seq) => {
    if (seq[0] === 'u') return String.fromCharCode(parseInt(seq.slice(1), 16));
    if (seq === 'n') return '\n';
    if (seq === 't') return '\t';
    return seq;
  });
}

function parseEntries(src) {
  const entries = [];
  const head = /\{\s*version:\s*(['"])([^'"]+)\1\s*,\s*items:\s*\[/g;
  let m;
  while ((m = head.exec(src)) !== null) {
    const openIdx = head.lastIndex - 1;           // 指向 `[`
    const closeIdx = endOfArray(src, openIdx);
    if (closeIdx < 0) continue;
    const body = src.slice(openIdx + 1, closeIdx);
    const items = [];
    const itemRe = /(['"])((?:[^\\]|\\.)*?)\1/gs;
    let s;
    while ((s = itemRe.exec(body)) !== null) items.push(unescape(s[2]).trim());
    entries.push({ version: m[2], items });
    head.lastIndex = closeIdx;
  }
  return entries;
}

function render(entries, shown) {
  const lines = [];
  lines.push('# 更新日志');
  lines.push('');
  lines.push('> 本文件由 `node scripts/changelog.js` 从 `src/ui/changelog.js` 生成，**不要手改**。');
  lines.push('> 要改版本说明，直接改 `src/ui/changelog.js`，再跑一次生成；`--check` 会拦住不同步的提交。');
  lines.push('> 这里只排最近 ' + shown + ' 个版本——完整 ' + entries.length + ' 版历史在扩展内「欢迎页 → 更新日志」里，正文与本文同源。');
  lines.push('');
  lines.push('共 **' + entries.length + '** 个版本，最新 **' + (entries[0] ? entries[0].version : '—') + '**；下列前 ' +
    Math.min(shown, entries.length) + ' 个。');
  lines.push('');
  for (const e of entries.slice(0, shown)) {
    lines.push('## ' + e.version);
    lines.push('');
    for (const it of e.items) lines.push('- ' + it);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const all = process.argv.includes('--all');
  const shown = all ? Infinity : 30;
  if (!fs.existsSync(SRC)) {
    console.error('✗ 找不到 ' + SRC);
    process.exit(2);
  }
  const entries = parseEntries(fs.readFileSync(SRC, 'utf8'));
  if (!entries.length) {
    console.error('✗ 从 src/ui/changelog.js 解析不到任何版本条目（格式变了？）');
    process.exit(2);
  }
  const next = render(entries, shown);

  if (checkOnly) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    if (cur === next) {
      console.log('✓ CHANGELOG.md 与 src/ui/changelog.js 同步（' + entries.length + ' 个版本）');
      return;
    }
    if (cur === null) {
      console.error('✗ CHANGELOG.md 不存在 —— 跑 `node scripts/changelog.js` 生成');
    } else {
      const a = cur.split('\n'), b = next.split('\n');
      const at = a.findIndex((l, i) => l !== b[i]);
      console.error('✗ CHANGELOG.md 与真源不同步（第 ' + (at + 1) + ' 行起）');
      console.error('   文件： ' + String(a[at] || '（EOF）').slice(0, 120));
      console.error('   应为： ' + String(b[at] || '（EOF）').slice(0, 120));
      console.error('   修法： `node scripts/changelog.js` 重新生成');
    }
    process.exit(1);
  }

  fs.writeFileSync(OUT, next, 'utf8');
  console.log('✓ 已生成 ' + path.relative(ROOT, OUT) + '（' + entries.length + ' 个版本，' +
    Buffer.byteLength(next, 'utf8') + ' B）');
}

main();
