#!/usr/bin/env node
/**
 * 发版前元数据一致性检查（防止「改一处、其他处陈旧」）
 *
 * 运行：node scripts/meta-check.js
 * 建议作为发版固定步骤，或用 git 预提交钩子触发。
 *
 * 校验项：
 *  1) 版本号一致性：manifest ↔ lib/storage.js ↔ lib/changelog.js（最新条目）
 *  2) options.html 是否残留硬编码版本/陈旧默认值（如图片尺寸"默认 180"与默认 70 不符）
 *  3) 是否残留重复的页面区块标题（如重复的「安全说明」）
 *  4) manifest 声明的权限是否在代码中有实际引用（未用=可移除，防止冗余堆积）
 *  5) lib/storage.js 默认配置字段是否有消费方（无消费=已废弃的残留配置）
 *  6) popup/welcome 硬编码版本号残留
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const errors = [];
const warnings = [];

function read(...parts) { return fs.readFileSync(path.join(root, ...parts), 'utf8'); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['.git', 'node_modules', 'scripts'].includes(e.name)) walk(p, out); }
    else if (/\.(js|html|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
function scanInAll(terms) {
  for (const f of walk(root)) {
    const c = fs.readFileSync(f, 'utf8');
    if (terms.some((t) => c.includes(t))) return true;
  }
  return false;
}

// 1) 版本号一致性
const manifest = JSON.parse(read('manifest.json'));
const mv = manifest.version;

const sm = read('lib/storage.js').match(/version:\s*'([^']+)'/);
if (!sm) errors.push('lib/storage.js 缺少 version 默认值');
else if (sm[1] !== mv) errors.push(`版本不一致：manifest.version=${mv}，但 storage.js 默认 version=${sm[1]}`);

const topVer = (read('lib/changelog.js').match(/version:\s*'v([0-9.]+)'/) || [])[1];
if (!topVer) warnings.push('lib/changelog.js 无任何版本条目');
else if (topVer !== mv) errors.push(`版本不一致：manifest=${mv}，但 CHANGELOG 最新条目为 v${topVer}（应同步为新版本）`);

const flatFiles = ['options/options.html', 'popup/popup.html', 'welcome/welcome.html'].map((f) => read(f)).join('\n').replace(/<!--[\s\S]*?-->/g, ''); // 剥离HTML注释，避免把历史版本标记当残留
const hardVer = flatFiles.match(/v\d+\.\d+\.\d+/g) || [];
if (hardVer.length) {
  const stale = [...new Set(hardVer)].filter((v) => v !== 'v' + mv);
  if (stale.length) warnings.push(`检测到硬编码版本号残留（当前发版 v${mv}）：${stale.join(', ')}`);
}

// 2) 陈旧默认值数字（如图片尺寸）
const imgDefault = (read('lib/storage.js').match(/imgSize:\s*(\d+)/) || [])[1];
if (imgDefault) {
  const text = flatFiles.replace(/<[^>]+>/g, ' ').replace(/style="[^"]*"/g, ' ');
  const re = new RegExp(`默认 ?(\\d+)(px)?`, 'g');
  let m; const hits = [];
  while ((m = re.exec(text))) {
    // 排除与当前默认一致及占位符数字（placeholder="默认 70" 之类合法）；只报与默认不一致的
    if (m[1] && m[1] !== imgDefault) hits.push(m[0]);
  }
  if (hits.length) warnings.push(`陈旧尺寸提示（storage 默认 ${imgDefault}px，但文案出现）：${[...new Set(hits)].join(', ')}`);
}

// 3) 重复区块标题
const hCount = {};
for (const h of (read('options/options.html').match(/<h3>([^<]+)<\/h3>/g) || [])) {
  const t = h.replace(/<[^>]+>/g, '').trim();
  hCount[t] = (hCount[t] || 0) + 1;
}
for (const [t, c] of Object.entries(hCount)) if (c > 1) errors.push(`重复区块标题：「${t}」出现 ${c} 次`);

// 4) 权限是否有实际引用
for (const perm of (manifest.permissions || [])) {
  if (!scanInAll([perm])) warnings.push(`权限 "${perm}" 在代码中无引用（若已不需要建议移除）`);
}

// 5) storage 默认字段消费方
const fields = ['adjacentCellNote', 'highlightStyle', 'noteCardStyle', 'importantNote', 'matchSettings', 'noteFormat', 'shadowDOMEnabled', 'stats', 'siteRules', 'siteDisabledMap', 'groups', 'keywords', 'globalEnabled'];
for (const f of fields) {
  if (!scanInAll([f])) warnings.push(`storage 默认字段 "${f}" 无消费方（可能已废弃的残留配置）`);
}

// 6) 旧方案资产/文件是否存在且被引用
for (const rel of ['assets/update-server.js', 'assets/native-host.js']) {
  if (fs.existsSync(path.join(root, rel))) warnings.push(`旧方案文件仍存在（可能已废弃）：${rel}`);
}

console.log('【meta-check】发版一致性检查完成');
if (errors.length) {
  console.log('\n❌ 错误（禁止发版）:');
  errors.forEach((e) => console.log('   - ' + e));
} else {
  console.log('\n✅ 版本号 / 结构 / 冗余 检查通过');
}
if (warnings.length) {
  console.log('\n⚠️ 警告（建议处理后发版）:');
  warnings.forEach((w) => console.log('   - ' + w));
}
console.log(`\n当前 manifest 版本：v${mv}`);
process.exit(errors.length ? 1 : 0);
