/* scripts/release-audit.js — 发版口径断言（2026-11-12 用户要求）
 * ---------------------------------------------------------------------------
 * 用户原话：「最后发版口径统一性断言。之前版本说过，测试版要 release，而且需要说明 html。
 * 这次没做。以及新增一个要求，稳定版的更新说明应该整理简化所有上个稳定版到这个稳定版的
 * 测试版更新，而不是只整理输出上个测试版的。（因为稳定版时给普通用户看的。）」
 *
 * 断言什么：
 *   1. `.tmp/notes/v<版本>.md` 存在 —— 说明页的**源**必须先写，出包才有东西可发布；
 *   2. `release/notes/v<版本>.html` 存在且含版本号 —— 用户能点开的说明页真的渲染了；
 *   3. 稳定版（三段号）额外要求：说明页必须覆盖「上一个稳定版之后的所有测试版」，
 *      每个测试版号都要在 md / html 里出现 —— 防止稳定版说明只抄了最后一个测试版。
 *
 * 为什么放在出包脚本里而不是 meta-check：写说明页发生在开发末尾，
 * 放进常驻红线会让「还在改代码」的阶段一直红；出包这一步才是「该交说明页了」。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const NS = require('./notes-summary');

function readVersions(root) {
  const p = path.join(root, 'src', 'ui', 'changelog.js');
  const src = fs.readFileSync(p, 'utf8');
  const out = [];
  const re = /version:\s*'([0-9][0-9.]*)'/g;
  let m;
  while ((m = re.exec(src))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

function isStable(v) {
  return NS.isStable(v);
}

/** 稳定版要汇总的测试版：changelog 里排在「本稳定版之后、上一个稳定版之前」的四段号。 */
function betasBetween(versions, stable) {
  const list = (versions || []).map((v) => ({ version: v }));
  return NS.betasBetween(list, stable).map((c) => String(c.version));
}

function textOf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function audit(opts) {
  const root = (opts && opts.root) || path.join(__dirname, '..');
  const version = (opts && opts.version) || JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  const mdPath = path.join(root, '.tmp', 'notes', 'v' + version + '.md');
  const htmlPath = path.join(root, 'release', 'notes', 'v' + version + '.html');
  const errors = [];
  const info = [];
  const md = textOf(mdPath);
  const html = textOf(htmlPath);

  if (!md) {
    errors.push('缺说明页草稿：.tmp/notes/v' + version + '.md（先写说明，再出包）');
  } else {
    if (md.indexOf(version) < 0) errors.push('说明页草稿里没写版本号 ' + version);
    if (md.length < 200) errors.push('说明页草稿太短（' + md.length + ' 字符），不像给用户看的说明');
  }
  if (!html) {
    errors.push('缺说明页 html：release/notes/v' + version + '.html（用 am 渲染草稿后再出包）');
  } else if (html.indexOf(version) < 0) {
    errors.push('说明页 html 里没写版本号 ' + version + '（是不是渲染的是旧草稿？）');
  }

  if (isStable(version)) {
    const betas = betasBetween(readVersions(root), version);
    info.push('稳定版要汇总的测试版：' + (betas.length ? betas.join('、') : '无'));
    if (betas.length) {
      // 汇总段必须是「脚本生成并注入」的那一段，而不是手写几行版本号
      if (md.indexOf(NS.MARK_START) < 0) {
        errors.push('稳定版说明缺汇总段：先跑 `node scripts/notes-summary.js --write`（会写入 ' + NS.MARK_START + ' … ' + NS.MARK_END + '）');
      }
      if (md.indexOf(NS.HEADING_HINT) < 0) {
        errors.push('稳定版说明的汇总段没有「N 个测试版」的标题，看不出覆盖了多少版');
      }
      if (html && html.indexOf(NS.HEADING_HINT) < 0) {
        errors.push('说明页 html 里没有汇总段标题（是不是注入草稿后没重新用 am 渲染？）');
      }
      const headed = (md.match(/^### \d+\.\d+\.\d+\.\d+$/gm) || []).length;
      if (headed < betas.length) {
        errors.push('汇总段只列了 ' + headed + ' 个测试版，应为 ' + betas.length + ' 个（漏版）');
      }
    }
    for (const b of betas) {
      if (md.indexOf(b) < 0) errors.push('稳定版说明没覆盖测试版 ' + b + '（草稿里要逐个列出）');
      if (html && html.indexOf(b) < 0) errors.push('稳定版说明 html 没覆盖测试版 ' + b);
    }
  } else {
    info.push('测试版：说明页只需覆盖本版');
  }

  return { ok: errors.length === 0, version: version, errors: errors, info: info, mdPath: mdPath, htmlPath: htmlPath };
}

function die(m) { console.error('\n✗ ' + m); process.exit(1); }

if (require.main === module) {
  const r = audit({ root: path.join(__dirname, '..') });
  for (const line of r.info) console.log('· ' + line);
  if (!r.ok) {
    console.error('\n✗ 发版口径断言未通过（' + r.version + '）：');
    for (const e of r.errors) console.error('  · ' + e);
    die('先把说明页补齐再出包。');
  }
  console.log('✓ 发版口径断言通过（' + r.version + '）：说明页草稿与 html 都在');
}

module.exports = { audit: audit, betasBetween: betasBetween, isStable: isStable, readVersions: readVersions };
