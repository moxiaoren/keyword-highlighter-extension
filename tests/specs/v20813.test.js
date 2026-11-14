'use strict';
/* 2.0.8.13 需求①：内容格省略改成「自适应」——够短整段显示，超出一行才收成一行。
 * 用户原话：「最多一行多余的截断省略，但实测还是完整展示了」⇒ 反过来也不能把短值切掉。
 * 2.0.8.14 需求②：补「每轮重绘不许先摘裁剪类再量」的缓存契约（那一下就是一闪）。
 * 2026-11-11 需求③：用户报「链接配了超链接 + 只显示一行，反复跳动，意图展开的样子」。
 * 根因：旧写法在**可见元素**上摘/加 `.kh-val-tight` 来量高，line-clamp 又改变排版上下文，
 * 宽度缓存永远命中不了 ⇒ 每轮都摘一次＝每轮闪一次。现在改成离屏克隆量高 + 结果缓存。
 */
const fs = require('fs');
const path = require('path');
const { test, truthy, falsy } = require('../harness');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SRC = 'src/features/important-note.js';

module.exports = function run() {
test('量高度用离屏克隆：可见元素一个类都不动（动了就是用户看到的那一闪）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipOverflow');
  truthy(i >= 0, '要有一个独立的离屏量高函数 clipOverflow');
  const seg = src.slice(i, i + 1400);
  truthy(/cloneNode\(true\)/.test(seg), '克隆节点量，不碰可见元素');
  truthy(/classList\.remove\('kh-val-tight'\)/.test(seg), '克隆上先摘裁剪类再量（否则量到的是裁过的高度）');
  truthy(/scrollHeight/.test(seg), '高度取 scrollHeight');
  truthy(/position = 'absolute'/.test(seg), '克隆必须离屏绝对定位，不能把表格撑开');
  truthy(/removeChild\(probe\)/.test(seg), '量完必须移除克隆');
  truthy(/getComputedStyle/.test(seg) && /lh \* 1\.35/.test(seg), '行高按计算样式取；阈值＝1.35 行');
});

test('默认整段显示：基础规则不是 clamp', () => {
  const src = read(SRC);
  /* 行首锚定：深色主题块里有同名选择器的颜色覆盖，indexOf 会先抓到它 */
  const i = src.search(/\n    \.kh-table \.kh-val-box \{/);
  const seg = src.slice(i, i + 220);
  truthy(/display:\s*block/.test(seg), '默认 block（不裁剪）');
  truthy(!/-webkit-line-clamp/.test(seg), '基础规则里不能再有 clamp');
});

test('★ 整块重排就同步量：量的是面板根，不再有摘要列的行级入口', () => {
  const src = read(SRC);
  /* 【2.0.8.14 需求②】新卡挂进文档立刻量（不等双 rAF，否则先按展开态绘一两帧再收行 = 一闪）。
   * 【台账 #2】摘要列删掉后，逐行量两个入口随之消失；悬窗每次 renderItems 结束**整块量一次**
   * 覆盖所有卡片（量的是 this.root，不再依赖 rowsEl）。 */
  const hits = (src.match(/clipValueBoxes\(/g) || []).length;
  truthy(hits >= 3, 'clipValueBoxes 至少 3 处（定义 1 + scheduleClip 内 1 + 整块 1），实际 ' + hits);
  truthy(/const clipRoot = this\.root \|\| null;/.test(src), '★ 量的对象必须是面板根（摘要列的 rowsEl 已删）');
  truthy(/clipValueBoxes\(clipRoot\);/.test(src), '整块重排后要同步量');
  truthy(/scheduleClip\(clipRoot\);/.test(src), '整块重排后还要补一帧（等字体/换行落定）');
  falsy(/clipValueBoxes\(row\)/.test(src), '行级入口随摘要列一起删净');
});

test('量不出来就不裁（未挂载元素 scrollHeight=0，不能被当成"超长"）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  const seg = src.slice(i, i + 1800);
  truthy(/isConnected/.test(seg), '未挂载直接跳过');
  truthy(/if \(need !== tight\) el\.classList\.toggle\('kh-val-tight', need\)/.test(seg),
    '只有判定与当前状态不同才动类名（幂等校准，不做无谓重排）');
});

test('【2.0.8.14 + 2026-11-11】文字与宽度没变就不重量：缓存命中先于任何测量与类名操作', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  const seg = src.slice(i, i + 1800);
  truthy(/__khClipTxt/.test(seg) && /__khClipW/.test(seg) && /__khClipNeed/.test(seg),
    '要按「文字 + 可用宽度」缓存判定结果（含 need 布尔值）');
  const cache = seg.indexOf('__khClipTxt === txt');
  const measure = seg.indexOf('clipOverflow(el, w)');
  truthy(cache >= 0 && measure > cache, '缓存命中必须先于重量，否则等于没省');
  truthy(!/classList\.remove\('kh-val-tight'\)/.test(seg),
    '可见元素上不再摘类名（摘的那一帧就是用户看到的「反复跳动」）');
  truthy(/function clipContentWidth/.test(src) && /closest\('td'\)/.test(src),
    '可用宽度取单元格内容宽（与 line-clamp 无关），不能直接用被裁元素的 clientWidth');
});
};
