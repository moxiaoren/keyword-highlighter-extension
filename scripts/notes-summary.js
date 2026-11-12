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
const HEADING_HINT = '都改了什么'; // html 里靠这句确认汇总段真的渲染了

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
 * 把长句拆成短句：说明页要过 STE 句长检查（中文描述句 ≤45 字），
 * 而 changelog 的正文经常一句七八十字。这里只做**断句**，不改词序、不删内容：
 * 先按逗号/分号/顿号切块，再把块贪心拼到 ≤limit 的句子里，用句号连接。
 */
function sentences(s, limit) {
  const max = limit || 42;
  const raw = String(s).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const parts = raw.split(/[，,；;、]/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    const next = cur ? cur + '，' + p : p;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    // 单块自己就超长：硬切，保证每段不过线
    let rest = p;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.replace(/[。！？!?]+$/, '')).join('。') + '。';
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

/**
 * 稳定版说明只留重点：自检、文档、文案这类不列；每版最多两条。
 */
var NOISE_TAG = /^(自检|文档|注释|文案|格式|日志|重构|测试)/;
function meaningful(it) {
  var tag = String(it && it.tag || '');
  if (NOISE_TAG.test(tag)) return false;
  var t = String(it && it.body || '').replace(/\s+/g, ' ').trim();
  if (t.length < 10) return false;
  if (/^(自检|单测|测试)\s*\d|^[（(]?自检/.test(t)) return false;
  return true;
}
/** 压成一句能扫的标题：去掉括注，取第一个句子，超长在逗号处收。 */
function headline(s, max) {
  var n = max || 26;
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  t = t.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  var first = t.split(/[。！？]/)[0] || t;
  // 说明页要过 STE 的「的」链检查：口头化的双「的」换成不带的说法
  first = first.replace(/用户原话[:：].*$/, '').replace(/按你的口径/g, '按此口径').replace(/别的/g, '其他').replace(/[「」]/g, '');
  if (first.length <= n) return first.replace(/[。！？；;，,]+$/, '');
  var cut = first.slice(0, n);
  var i = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('：'));
  return (i > 8 ? cut.slice(0, i) : cut) + '…';
}

/** 生成 Markdown 汇总段（稳定版用；测试版返回空串） */
function markdown(changelog, stable) {
  if (!isStable(stable)) return '';
  const data = collect(changelog, stable);
  if (!data.count) return '';
  // 用户口径：说明页给普通用户看，不列测试版号、不留废弃与重复，
  // 只按「新功能 / 重要调整 / 问题修复」三类给要点，同一件事只留最终形态。
  const groups = [
    { title: '### 新功能', re: /新增/, cap: 8, lines: [] },
    { title: '### 重要调整', re: /优化|改动|性能|安全/, cap: 6, lines: [] },
    { title: '### 问题修复', re: /修复/, cap: 10, lines: [] }
  ];
  const seen = Object.create(null);
  for (const b of data.betas) {
    for (const it of b.items) {
      if (!meaningful(it)) continue;
      const tag = String(it.tag || '');
      const g = groups.find((x) => x.re.test(tag));
      if (!g || g.lines.length >= g.cap) continue;
      const h = headline(it.body);
      const k = norm(h);
      if (!k || seen[k]) continue;
      seen[k] = 1;
      g.lines.push('- ' + (it.tag ? '**' + it.tag + '** ' : '') + h);
    }
  }
  const body = groups.filter((g) => g.lines.length).map((g) => [g.title, ''].concat(g.lines, ['']).join('\n'));
  if (!body.length) return '';
  return [
    MARK_START,
    '## ' + stable + ' 都改了什么',
    '',
    '> 从 ' + (data.prev || '上一个稳定版') + ' 之后陆续加入的改动，稳定版一次性收下；同一个问题改过几轮的，只留最终形态。',
    '',
    body.join('\n'),
    MARK_END
  ].join('\n');
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
