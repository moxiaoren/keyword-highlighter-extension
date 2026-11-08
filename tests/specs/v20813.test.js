'use strict';
/* 2.0.8.13 需求①：内容格省略改成「自适应」——够短整段显示，超出一行才收成一行。
 * 用户原话：「最多一行多余的截断省略，但实测还是完整展示了」⇒ 反过来也不能把短值切掉。 */
const fs = require('fs');
const path = require('path');
const { test, truthy } = require('../harness');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SRC = 'src/features/important-note.js';

test('量高度前先摘掉裁剪类（否则 scrollHeight 是被裁过的，永远判"放得下"）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  truthy(i >= 0, '要有一个统一的量高函数 clipValueBoxes');
  const seg = src.slice(i, i + 900);
  const rm = seg.indexOf("classList.remove('kh-val-tight')");
  const measure = seg.indexOf('scrollHeight');
  truthy(rm >= 0 && measure > rm, '必须先 remove 再读 scrollHeight（顺序反了就失效）');
  truthy(/getComputedStyle/.test(seg), '行高要按计算样式取，不能写死像素');
  truthy(/lh\s*\*\s*1\.35/.test(seg), '阈值＝一行行高的 1.35 倍（允许行内上下留白）');
});

test('默认整段显示：基础规则不是 clamp', () => {
  const src = read(SRC);
  const i = src.indexOf('.kh-table .kh-val-box {');
  const seg = src.slice(i, i + 220);
  truthy(/display:\s*block/.test(seg), '默认 block（不裁剪）');
  truthy(!/-webkit-line-clamp/.test(seg), '基础规则里不能再有 clamp');
});

test('三个入口都要量：展开新卡、切换展开态、整块重排', () => {
  const src = read(SRC);
  const hits = (src.match(/scheduleClip\(/g) || []).length;
  truthy(hits >= 4, 'scheduleClip 至少 4 处调用（定义 1 + 调用 3）');
  truthy(/if \(open\) scheduleClip\(body\);/.test(src), '展开新卡后要量');
  truthy(/if \(body\) scheduleClip\(body\);/.test(src), '切换展开态后要量');
  truthy(/scheduleClip\(this\.rowsEl \|\| this\.root \|\| null\)/.test(src), '整块重排后要量');
});

test('量不出来就不裁（未挂载元素 scrollHeight=0，不能被当成"超长"）', () => {
  const src = read(SRC);
  const i = src.indexOf('function clipValueBoxes');
  const seg = src.slice(i, i + 900);
  truthy(/isConnected/.test(seg), '未挂载直接跳过');
  truthy(/if \(el\.scrollHeight > lh \* 1\.35\) el\.classList\.add\('kh-val-tight'\);/.test(seg), '只有真的超一行才加类');
});
