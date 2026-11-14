/* tests/specs/abilities.test.js — 能力清单唯一真源（台账 2026-11-14 第 1 条）
 * ----------------------------------------------------------------------------
 * 这份单测盯的不是文案好不好读，而是「能不能被别处安全消费」：
 *   ① 定位句会被逐字搬进 README 与 CONTEXT.md，所以它必须干净（纯文本、无版本号）；
 *   ② 两层条数与 id：少一条 = 少一个能力没人知道，重复 id = 锚点指向错的那条；
 *   ③ anchors.probe 是「这个界面落点还在」的可执行判据 —— 文件没了或文字改了，
 *      欢迎页的卡片就点不到东西，而页面本身不会报错；
 *   ④ heroChips 与 selling 的 chip 必须同源（首屏承诺 = 卖点原话）。
 * meta-check 负责比 README 块与欢迎页 HTML 契约，本文件负责数据自身的自洽。
 * ------------------------------------------------------------------------- */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'src', 'ui', 'abilities.js'));

function hasVersion(s) { return /[0-9]+\.[0-9]+\.[0-9]+/.test(s); }
/* 只认「真的会被当成标记」的形状：标签开头或 HTML 实体。
 * 不能一律禁 > ——「分组色 > 词色」这种优先级写法是正常文案。 */
function hasMarkup(s) { return /<[a-zA-Z\/!]/.test(s) || /&(#?[a-zA-Z0-9]+);/.test(s); }
function readRoot(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

module.exports = async function run() {
  suite('能力清单真源（src/ui/abilities.js）');

  await test('定位句：纯文本、无版本号、以句号收尾、20–60 字', () => {
    const p = A.positioning;
    eq(typeof p, 'string', 'positioning 必须是字符串');
    truthy(p.length >= 20 && p.length <= 60, '定位句应在 20–60 字之间，实际 ' + p.length + ' 字');
    falsy(hasMarkup(p), '定位句要上屏为纯文本，不许带 < > &');
    falsy(hasVersion(p), '定位句不许写版本号（版本真源只有 manifest.json）');
    eq(p.slice(-1), '。', '定位句以中文句号收尾');
  });

  await test('两层条数：basics ≥ 6、selling ≥ 5，且 id 两层合起来不重', () => {
    truthy(Array.isArray(A.basics) && A.basics.length >= 6, '基础能力至少 6 条，实际 ' + (A.basics || []).length);
    truthy(Array.isArray(A.selling) && A.selling.length >= 5, '卖点至少 5 条，实际 ' + (A.selling || []).length);
    const ids = A.basics.concat(A.selling).map((x) => x.id);
    ids.forEach((id) => truthy(typeof id === 'string' && id.length > 0, '每条都要有 id'));
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    eq(dup.length, 0, 'id 重复：' + dup.join(', '));
  });

  await test('每条 desc 是干净纯文本：≥ 20 字、无标记字符、无版本号', () => {
    A.basics.concat(A.selling).forEach((x) => {
      const d = x.desc;
      truthy(typeof d === 'string' && d.length >= 20, x.id + ' 的 desc 至少 20 字（太短说明没写清）');
      falsy(hasMarkup(d), x.id + ' 的 desc 会被 textContent 上屏，不许带 < > &');
      falsy(hasVersion(d), x.id + ' 的 desc 不许写版本号');
    });
  });

  await test('每个 anchor 都在 anchors 表里，且 probe 真能在对应文件命中', () => {
    const anchors = A.anchors || {};
    A.basics.concat(A.selling).forEach((x) => {
      truthy(Object.prototype.hasOwnProperty.call(anchors, x.anchor), x.id + ' 的 anchor「' + x.anchor + '」不在 anchors 表里');
    });
    Object.keys(anchors).forEach((k) => {
      const p = anchors[k].probe || {};
      truthy(p.file && p.needle, 'anchors.' + k + ' 缺 probe（file + needle）');
      let src = null;
      try { src = readRoot(p.file); } catch (e) { src = null; }
      truthy(src !== null, 'anchors.' + k + ' 的落点文件不存在：' + p.file);
      truthy(src.indexOf(p.needle) >= 0, 'anchors.' + k + ' 的探针在 ' + p.file + ' 里找不到「' + p.needle + '」');
    });
  });

  await test('heroChips 三枚各唯一对应一条带 chip 的卖点（文案不允许两份）', () => {
    const chips = A.heroChips || [];
    eq(chips.length, 3, '首屏胶囊是三枚');
    eq(new Set(chips).size, chips.length, 'heroChips 不许重复');
    chips.forEach((id) => {
      const hit = A.selling.filter((s) => s.id === id);
      eq(hit.length, 1, 'heroChips 的「' + id + '」必须恰好对应一条卖点，实际 ' + hit.length + ' 条');
      truthy(typeof hit[0].chip === 'string' && hit[0].chip.length > 0, '卖点 ' + id + ' 必须带 chip（首屏要显示它）');
    });
  });
};
