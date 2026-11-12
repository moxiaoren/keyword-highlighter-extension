/* scripts/notes-summary.js — 稳定版说明的「测试版汇总」（2026-11-12 用户要求）
 * ----------------------------------------------------------------------------
 * 用户原话：「稳定版的更新说明应该整理简化所有上个稳定版到这个稳定版的测试版更新，
 * 而不是只整理，输出上个测试版的。（因为稳定版时给普通用户看的。）」
 *
 * 三个消费者共用这一份数据，避免各写一套口径：
 *   1. `scripts/gh-release.js`  → GitHub Release 正文（稳定版）
 *   2. `scripts/notes-summary.js --write` → 注入 `.tmp/notes/v<稳定版>.md` 的汇总段
 *      （随后由 am 渲染成 release/notes/v<稳定版>.html，所以网页里也有）
 *   3. `scripts/release-audit.js` → 出包前断言「每个测试版都出现在说明页里」
 *
 * 口径：
 *   - 统计范围 = 当前稳定版之下、上一个稳定版之上的全部四段测试版；
 *   - 按测试版从新到旧列出，每条保留「标签 + 正文」，正文过长截断；
 *   - **重复内容只留最新那一版的写法**（同一件事在多个测试版里迭代时，稳定版用户
 *     只需要知道最终形态），去重键 = 去掉空白与标点后的正文；
 *   - 最前面给一段「这一段最该知道的 N 件事」，取最近的若干条要点，供扫读。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const TEST_RE = /^\d+\.\d+\.\d+\.\d+$/;
const MARK_START = '<!-- KH:STABLE-SUMMARY:START -->';
const MARK_END = '<!-- KH:STABLE-SUMMARY:END -->';
const HEADING_HINT = '个测试版'; // html 里靠这句确认汇总段真的渲染了

function isTestVer(v) {
  return TEST_RE.test(String(v).replace(/^v/, '').replace(/-beta$/, ''));
}

function isStable(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v));
}

/** 读 changelog（纯文案表，用 Function 取 CHANGELOG，和 gh-release 同一套取法） */
function readChangelog(root) {
  const dir = root || path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(dir, 'src', 'ui', 'changelog.js'), 'utf8');
  return new Function(src + '\n;return CHANGELOG;')();
}

/** 稳定版要汇总的测试版：changelog 是「新的在前」，取本版之后、上一个稳定版之前的四段号。 */
function betasBetween(changelog, stable) {
  const list = Array.isArray(changelog) ? changelog : [];
  const at = list.findIndex((c) => String(c.version) === String(stable));
  if (at < 0) return [];
  let prevAt = list.length;
  for (let i = at + 1; i < list.length; i++) {
    if (isStable(list[i].version)) { prevAt = i; break; }
  }
  return list.slice(at + 1, prevAt).filter((c) => isTestVer(c.version));
}

/** 上一稳定版号（没有就返回空串） */
function prevStable(changelog, stable) {
  const list = Array.isArray(changelog) ? changelog : [];
  const at = list.findIndex((c) => String(c.version) === String(stable));
  if (at < 0) return '';
  for (let i = at + 1; i < list.length; i++) {
    if (isStable(list[i].version)) return String(list[i].version);
  }
  return '';
}

function splitItem(s) {
  const m = /^【([^】]+)】(.*)$/.exec(String(s).trim());
  if (!m) return { tag: '', body: String(s).trim() };
  return { tag: m[1].trim(), body: m[2].trim() };
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？“”‘’（）()【】\[\]·,.;:!?<>《》—–\-~～]/g, '');
}

function clip(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  const n = max || 90;
  if (t.length <= n) return t;
  // 尽量在句号/分号处收尾，别把一句话从中间切断
  const head = t.slice(0, n + 30);
  let cut = -1;
  for (const ch of ['。', '；']) {
    const i = head.indexOf(ch);
    if (i > 10 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut > 0) return head.slice(0, cut + 1);
  return t.slice(0, n - 1) + '…';
}

/**
 * 把一段测试版的改动整理成结构化数据。
 * @returns {{count:number, prev:string, betas:Array<{version:string, items:Array<{tag:string, body:string}>}>, lines:number}}
 */
function collect(changelog, stable) {
  const betas = betasBetween(changelog, stable);
  const seen = Object.create(null);
  const out = [];
  for (const b of betas) {
    const kept = [];
    for (const raw of b.items || []) {
      const it = splitItem(raw);
      // 去重键取「标签 + 正文第一句」：同一件事在不同测试版里常只改后半句
      //（「…改法 A」→「…改法 B」），稳定版用户只需要最终形态。
      const clause = String(it.body).split(/[，,。；;：:]/)[0];
      const key = norm((it.tag ? it.tag + ' ' : '') + clause);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      kept.push({ tag: it.tag, body: clip(it.body, 90) });
    }
    if (!(b.items || []).length) continue;
    // 每版都留小节：即使条目全被去重（只改了前面已写过的东西），
    // 稳定版读者也要能看到「这一段确实有这个测试版」。
    out.push({ version: String(b.version), items: kept, deduped: kept.length === 0 });
  }
  return { count: out.length, prev: prevStable(changelog, stable), betas: out };
}

/** 生成 Markdown 汇总段（稳定版用；测试版返回空串） */
function markdown(changelog, stable) {
  if (!isStable(stable)) return '';
  const data = collect(changelog, stable);
  if (!data.count) return '';
  const from = data.prev ? data.prev : '上一个稳定版';
  const lines = [];
  lines.push(MARK_START);
  lines.push('## 从 ' + from + ' 到 ' + stable + '：' + data.count + ' 个测试版都改了什么');
  lines.push('');
  lines.push('> 稳定版会收下这一段的全部改动；同一条在多个测试版里迭代过的，这里只保留最终形态。');
  lines.push('');

  const quick = [];
  for (const b of data.betas) {
    for (const it of b.items) {
      if (quick.length >= 8) break;
      quick.push((it.tag ? '**' + it.tag + '** ' : '') + it.body);
    }
    if (quick.length >= 8) break;
  }
  if (quick.length) {
    lines.push('### 最该知道的 ' + quick.length + ' 件');
    lines.push('');
    for (const q of quick) lines.push('- ' + q);
    lines.push('');
  }

  for (const b of data.betas) {
    lines.push('### ' + b.version);
    lines.push('');
    if (!b.items.length) {
      lines.push('- 这一版只调整了上面已列出的条目，最终形态见前文。');
      lines.push('');
      continue;
    }
    for (const it of b.items) {
      lines.push('- ' + (it.tag ? '**' + it.tag + '** ' : '') + it.body);
    }
    lines.push('');
  }
  lines.push(MARK_END);
  return lines.join('\n');
}

/** 把汇总段写进说明页草稿：有标记就替换，没有就追加到末尾 */
function inject(md, section) {
  const text = String(md || '');
  if (!section) return text;
  const a = text.indexOf(MARK_START);
  const b = text.indexOf(MARK_END);
  if (a >= 0 && b > a) return text.slice(0, a) + section + text.slice(b + MARK_END.length);
  const tail = text.replace(/\s+$/, '');
  return tail + '\n\n' + section + '\n';
}

function die(m) { console.error('\n✗ ' + m); process.exit(1); }

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const hit = argv.find((x) => x.indexOf('--' + name + '=') === 0);
    return hit ? hit.slice(name.length + 3) : '';
  };
  const root = path.join(__dirname, '..');
  const version = arg('version') || JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  const changelog = readChangelog(root);
  const section = markdown(changelog, version);
  if (!section) die(version + ' 不是稳定版，或它下面没有测试版可汇总。');
  if (argv.indexOf('--write') < 0) {
    console.log(section);
    return;
  }
  const mdPath = path.join(root, '.tmp', 'notes', 'v' + version + '.md');
  if (!fs.existsSync(mdPath)) die('没有说明页草稿：' + mdPath + '（先写草稿，再注入汇总）');
  const before = fs.readFileSync(mdPath, 'utf8');
  fs.writeFileSync(mdPath, inject(before, section), 'utf8');
  const after = fs.readFileSync(mdPath, 'utf8');
  const n = (after.match(/^### \d+\.\d+\.\d+\.\d+$/gm) || []).length;
  console.log('✓ 已写入汇总段：' + mdPath + '（' + n + ' 个测试版，' + section.length + ' 字符）');
}

module.exports = {
  MARK_START: MARK_START,
  MARK_END: MARK_END,
  HEADING_HINT: HEADING_HINT,
  isStable: isStable,
  isTestVer: isTestVer,
  readChangelog: readChangelog,
  betasBetween: betasBetween,
  prevStable: prevStable,
  collect: collect,
  markdown: markdown,
  inject: inject,
};
