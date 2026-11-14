/* scripts/gen-abilities.js — 把 src/ui/abilities.js 渲染成 README 的能力块
 *
 * 为什么要有它：README 的能力段落原来是手写的第二份散文，跟欢迎页那份各改各的。
 * 现在两处都从 src/ui/abilities.js 取：欢迎页运行时渲染，README 由本脚本生成。
 *
 * 用法：
 *   node scripts/gen-abilities.js          只看结果（stdout），不动文件
 *   node scripts/gen-abilities.js --write  把 README 里的块就地重写
 *   node scripts/meta-check.js 也会 require 本文件做一致性比对（--check 用 renderBlock）
 *
 * 块里只放**索引**（名字 + 一句概括 + 界面落点），不复述 README 下面那张
 * 「它做什么」长表 —— 那张表写的是边界条件与坑，篇幅应该是索引的十倍。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = 'src/ui/abilities.js';
const README = 'README.md';

const BEGIN = '<!-- ABILITIES:BEGIN 由 scripts/gen-abilities.js 从 src/ui/abilities.js 生成，勿手改 -->';
const END = '<!-- ABILITIES:END -->';

/* 数据源是「浏览器 + node 双导出」的纯数据文件：这里用 new Function 把它当数据跑，
 * 不 require（它没有 module.exports 之外的依赖，但 require 会走模块缓存，改了数据不重载）。 */
function loadAbilities(file) {
  const p = file || path.join(ROOT, SRC);
  const src = fs.readFileSync(p, 'utf8');
  const sandbox = { exports: {} };
  new Function('module', 'window', src)(sandbox, undefined);
  const A = sandbox.exports;
  if (!A || !Array.isArray(A.basics) || !Array.isArray(A.selling)) {
    throw new Error(SRC + ' 结构不对：需要 basics[] 与 selling[]');
  }
  return A;
}

/* 一句话概括：从 desc 里取「够用的一小段」——
 * 只取第一句会把「图片不上传。」这种五个字的残句放进 README（读者拿不到信息），
 * 所以短于 24 字就继续接下一句；超过 90 字则在最近的逗号处收口加省略号。 */
function gist(desc) {
  const s = String(desc || '').trim();
  if (!s) return '';
  const parts = s.split(/(?<=[。；])/).filter((x) => x.trim());
  let out = '';
  for (const p of parts) {
    out += p;
    if (out.length >= 24) break;
  }
  out = out.replace(/[。；]$/, '');
  if (out.length > 90) {
    const cut = out.lastIndexOf('，', 88);
    out = (cut > 40 ? out.slice(0, cut) : out.slice(0, 88)) + '…';
  }
  return out;
}

function whereOf(A, item) {
  const a = (A.anchors || {})[item.anchor];
  return (a && a.label) || '';
}

function line(A, item) {
  const g = gist(item.desc);
  const w = whereOf(A, item);
  return '- **' + item.title + '**' + (g ? ' —— ' + g : '') + (w ? '（界面落点：' + w + '）' : '');
}

function renderBlock(A) {
  const a = A || loadAbilities();
  const out = [];
  out.push(BEGIN);
  out.push('');
  out.push('## 基础能力 / 卖点');
  out.push('');
  out.push('> 这一段由 ' + SRC + ' 生成（跑 node scripts/gen-abilities.js --write 重写），**不要手改**。');
  out.push('> 加新功能只改那一份数据 —— 欢迎页首屏与卡片的同一份文案会跟着变，不用两处各改一遍。');
  out.push('> 每条都带「界面落点」，指的是设置页 / 页面上真实存在的那一节，可以直接点过去。');
  out.push('');
  out.push('**基础能力**（这个插件替你做什么）');
  out.push('');
  (a.basics || []).forEach((it) => out.push(line(a, it)));
  out.push('');
  out.push('**卖点**（凭什么选它）');
  out.push('');
  (a.selling || []).forEach((it) => out.push(line(a, it)));
  out.push('');
  out.push(END);
  return out.join('\n');
}

function applyToReadme(text, block) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < b) return null;                     /* 没有标记块 = 交给调用方决定怎么报错 */
  return text.slice(0, b) + block + text.slice(e + END.length);
}

function main() {
  const write = process.argv.includes('--write');
  const A = loadAbilities();
  const block = renderBlock(A);
  if (!write) {
    process.stdout.write(block + '\n');
    return;
  }
  const p = path.join(ROOT, README);
  const next = applyToReadme(fs.readFileSync(p, 'utf8'), block);
  if (next == null) {
    console.error('README.md 里没有 ABILITIES:BEGIN / END 标记块，先手工插一次再 --write');
    process.exit(1);
  }
  fs.writeFileSync(p, next, 'utf8');
  console.log('已重写 README.md 的能力块（' + (A.basics.length + A.selling.length) + ' 条）');
}

if (require.main === module) main();

module.exports = { BEGIN, END, SRC, README, loadAbilities, renderBlock, applyToReadme, gist };
