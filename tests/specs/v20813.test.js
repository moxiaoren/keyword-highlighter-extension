'use strict';
/* 2.0.8.13 需求①：内容格省略改成「自适应」——够短整段显示，超出一行才收成一行。
 * 用户原话：「最多一行多余的截断省略，但实测还是完整展示了」⇒ 反过来也不能把短值切掉。
 * 2.0.8.14 需求②：补「每轮重绘不许先摘裁剪类再量」的缓存契约（那一下就是一闪）。 */
const fs = require('fs');
const path = require('path');
const { test, truthy } = require('../harness');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SRC = 'src/features/important-note.js';

module.exports = function run() {
test('量高度前先摘掉裁剪类（否则 scrollHeight 是被裁过的，永远判"放得下"）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  truthy(i >= 0, '要有一个统一的量高函数 clipValueBoxes');
  const seg = src.slice(i, i + 2400);
  const rm = seg.indexOf("classList.remove('kh-val-tight')");
  const measure = seg.indexOf('el.scrollHeight');
  truthy(rm >= 0 && measure > rm, '必须先 remove 再读 scrollHeight（顺序反了就失效）');
  truthy(/getComputedStyle/.test(seg), '行高要按计算样式取，不能写死像素');
  truthy(/lh\s*\*\s*1\.35/.test(seg), '阈值＝一行行高的 1.35 倍（允许行内上下留白）');
});

test('默认整段显示：基础规则不是 clamp', () => {
  const src = read(SRC);
  /* 行首锚定：深色主题块里有同名选择器的颜色覆盖，indexOf 会先抓到它 */
  const i = src.search(/\n    \.kh-table \.kh-val-box \{/);
  const seg = src.slice(i, i + 220);
  truthy(/display:\s*block/.test(seg), '默认 block（不裁剪）');
  truthy(!/-webkit-line-clamp/.test(seg), '基础规则里不能再有 clamp');
});

test('三个入口都要量：展开新卡、切换展开态、整块重排', () => {
  const src = read(SRC);
  /* 【2.0.8.14 需求②】新增"同步量一次"的三个入口：新卡挂进文档立刻量（不等双 rAF，
   * 否则新卡先按展开态绘一两帧再收行 = 一闪）。所以这里数的是 clipValueBoxes 的调用点。 */
  const hits = (src.match(/clipValueBoxes\(/g) || []).length;
  truthy(hits >= 4, 'clipValueBoxes 至少 4 处（定义 1 + 调用 3），实际 ' + hits);
  truthy(/if \(open\) clipValueBoxes\(row\);/.test(src), '展开新卡挂进文档后要同步量');
  truthy(/this\.applyImgMarksToEl\(card\); clipValueBoxes\(card\);/.test(src), '切换展开态重建卡片后要同步量');
  truthy(/clipValueBoxes\(clipRoot\);/.test(src), '整块重排后要同步量');
  truthy(/scheduleClip\(clipRoot\);/.test(src), '整块重排后还要补一帧（等字体/换行落定）');
});

test('量不出来就不裁（未挂载元素 scrollHeight=0，不能被当成"超长"）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  const seg = src.slice(i, i + 2400);
  truthy(/isConnected/.test(seg), '未挂载直接跳过');
  truthy(/if \(el\.scrollHeight > lh \* 1\.35\) el\.classList\.add\('kh-val-tight'\);/.test(seg), '只有真的超一行才加类');
});

test('【2.0.8.14】文字与可用宽度没变就不再摘类重量（每轮摘一次就是一次闪）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  const seg = src.slice(i, i + 2400);
  truthy(/__khClipTxt/.test(seg) && /__khClipW/.test(seg), '要按「文字 + 可用宽度」缓存上次的判定');
  const skip = seg.indexOf('__khClipTxt === txt');
  const rm = seg.indexOf("classList.remove('kh-val-tight')");
  truthy(skip >= 0 && skip < rm, '缓存命中必须先于"摘类名"，否则等于没省');
});
};
