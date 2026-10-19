/* tests/specs/ocr-copy.test.js — OCR 界面文案的**唯一真源**（票 #17 D-17.1）
 * ----------------------------------------------------------------------------
 * 2.0.2.15 起这个模块只剩两件事（条目状态词表 COPY/CLASS/tag/why/stateClass 全删，
 * 因为「🖼 图片命中」分区删掉之后它们再没有任何读者）：
 *   ① `VIEW` —— 面板 / 灯箱 / 设置页共用的界面文案，谁都不许在自己文件里写死中文；
 *   ② `render()` 占位符替换 + `sentenceOf()` 句子定位（灯箱词块"复制它所在那一整句"）。
 *
 * 这里钉三件事：
 *   A. VIEW 的每条都是非空字符串、占位符只有 {n} / {host} 这一套（写错占位符等于文案静默失效）；
 *   B. `sentenceOf()` 的切句口径（用户 2026-10-09：命中「9月」要复制「9月份的量，给你了」整句）；
 *   C. 源码契约：面板与灯箱从 VIEW 取字（不许硬编码），且删掉的词表**不许复活**。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 允许出现的占位符（`render()` 在面板/灯箱里真正会传的字段） */
const PLACEHOLDERS = ['n', 'host', 'matched'];

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.OcrCopy;

  suite('OCR 文案唯一真源（票 #17 D-17.1 / 不变量 9–12）');

  await test('★ 不变量 10：VIEW 每条都是非空中文串，占位符只有 {n}/{host}', () => {
    truthy(C && C.VIEW, '必须导出 VIEW');
    const bad = [];
    for (const [k, v] of Object.entries(C.VIEW)) {
      if (typeof v !== 'string' || !v.trim()) bad.push(k + ': 空/非字符串');
      const slots = [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const s of slots) if (PLACEHOLDERS.indexOf(s) < 0) bad.push(k + ': 未知占位符 {' + s + '}');
      /* 未闭合的 `{` 会让 render() 留下半个占位符，肉眼看是文案里的乱码 */
      if ((String(v).split('{').length - 1) !== slots.length) bad.push(k + ': 有未闭合的 {');
    }
    eq(bad.length, 0, 'VIEW 文案有问题：' + bad.join('；'));
    /* 2.0.2.15 需求①的四个键是这次新增的语义，缺一个灯箱就会瞎 */
    for (const k of ['paneOcr', 'paneOcrBusy', 'paneOcrTip', 'paneOcrFail', 'paneOcrDenied']) {
      truthy(typeof C.VIEW[k] === 'string' && C.VIEW[k], '缺 VIEW.' + k + '（大图一键 OCR 的按钮语义）');
    }
  });

  await test('★ render()：占位符替换，缺值就留原样（便于发现写错）', () => {
    eq(C.render('重要笔记（{n} 条）', { n: 3 }), '重要笔记（3 条）', '数字替换');
    eq(C.render('重要笔记（{n} 条）', {}), '重要笔记（{n} 条）', '缺值留原样');
    eq(C.render('跨域（未授权 {host}）', { host: 'a.com' }), '跨域（未授权 a.com）', '域名替换');
    eq(C.render('没有占位符', { n: 1 }), '没有占位符', '无占位符原样返回');
    eq(C.render(null, {}), '', 'null 安全');
  });

  await test('★ S3-⑤：命中词 → 复制它**所在的那一整句**（灯箱词块，票 #22 后需求）', () => {
    /* 用户口径（2026-10-09）：命中"9月"，在"9月份的量，给你了"里就复制这一句。
     * 切分只在句末标点/换行上做 —— 逗号不是边界（宁可多带，不许把一句话切成半截）。 */
    eq(C.sentenceOf('9月份的量，给你了', '9月'), '9月份的量，给你了', '没有句末标点时取到文末');
    eq(C.sentenceOf('第一句。9月份的量，给你了。第三句。', '9月'), '9月份的量，给你了。', '两侧都按句末标点切');
    eq(C.sentenceOf('先9月。再9月！', '9月'), '先9月。', '取第一处出现的那一句');
    eq(C.sentenceOf('甲\n9月乙\n丙', '9月'), '9月乙', '换行也是边界');
    eq(C.sentenceOf('9月。后面', '9月'), '9月。', '句首命中');
    eq(C.sentenceOf('英文!句子?9月好;收尾', '9月'), '9月好;', '半角句末标点同样算边界');
    eq(C.sentenceOf('页面里没有这个词', '9月'), '', '找不到 needle 必须返回空串');
    for (const bad of [['', 'x'], [null, 'x'], ['abc', ''], [null, null]]) {
      eq(C.sentenceOf(bad[0], bad[1]), '', '空输入返回空串：' + JSON.stringify(bad));
    }
  });

  await test('★ 不变量 10：面板与灯箱的中文都从 VIEW 取（源码契约）', () => {
    const note = read('src/features/important-note.js');
    /* 面板：题头 / 折叠 / FAB / 截图卡 / 命中提示 */
    for (const k of ['noteExpand', 'noteCollapse', 'fabLabel', 'minTip', 'ctxShotLabel', 'imgHitTip']) {
      truthy(note.indexOf('VIEW.' + k) >= 0, 'important-note.js 必须从 VIEW.' + k + ' 取字（不许自己写中文）');
    }
    /* 灯箱：全文栏那一枚按钮的两种语义都在 VIEW 里 */
    for (const k of ['paneHide', 'paneShow', 'paneOcr', 'textPane', 'copySentence']) {
      truthy(note.indexOf('VIEW.' + k) >= 0, '灯箱必须从 VIEW.' + k + ' 取字');
    }
  });

  await test('★ 2.0.2.15：删掉的条目状态词表不许复活（面板已无状态渲染面）', () => {
    const src = read('src/ui/ocr-copy.js');
    for (const dead of ['const COPY =', 'function keyOf(', 'function stateClass(', 'function costLabel(', 'const CLASS =', 'const ICON =']) {
      falsy(src.indexOf(dead) >= 0, '条目状态词表已随「图片命中」分区删除，不许复活：' + dead);
    }
    /* 搬进 ocr-copy 的那些原因句不得在面板里复活 */
    const MOVED = ['读不到像素', '图还没加载', '图当前不可见', '原图太小', '识别引擎还没准备好语言包', '跨域（未授权'];
    const note = read('src/features/important-note.js');
    const back = MOVED.filter((s) => note.indexOf(s) >= 0);
    eq(back.length, 0, 'important-note.js 里不该再硬编码这些文案：' + back.join('、'));
  });

  await test('★ 不变量 12：三处注册点都带 ocr-copy.js（content / options / popup）', () => {
    truthy(read('manifest.json').indexOf('src/ui/ocr-copy.js') >= 0, 'manifest content_scripts 必须载入 ocr-copy.js');
    truthy(read('options/options.html').indexOf('ocr-copy.js') >= 0, '设置页必须载入 ocr-copy.js');
    truthy(read('popup/popup.html').indexOf('ocr-copy.js') >= 0, '弹窗必须载入 ocr-copy.js');
  });
};
