/* tests/specs/ocr-noise.test.js — 【2.0.16.6 · 用户 m19162 问题② / m19982】
 * ----------------------------------------------------------------------------
 * 现场：OCR 把「上海利多星证券咨询有限公司」抄成
 *   「上海利多星证券咨城化 L派千夕日江光次沟古阳八司证券咨询有限公司」，
 * 这串噪声原样进表、还当了比对基准。
 *
 * 用户口径（m19385 选 A）：只提示、不改判定；同时更希望从 OCR 侧少出这种结果。
 * 于是本版只有两件事，这里各钉一条：
 *   ① 行文本卫生 cleanLineText：只清长行里夹在汉字之间的孤立 1–2 个字母（短行是内容，不许动）；
 *   ② 值可疑判据 _looksGarbled + 进表行不可枚举的 suspect 标记：值一个字不改，
 *      只让渲染层标「⚠ 识别可能有误」。判据要能区分正常公司名（含括号别称 / 3M / 英文缩写）。
 * ========================================================================= */
'use strict';
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy, loadKernel } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 现场噪声值（真值：上海利多星证券咨询有限公司） */
const NOISE = '上海利多星证券咨城化 L派千夕日江光次沟古阳八司证券咨询有限公司';

/** 把 offscreen/ocr.js 装进最小沙盒：只要纯判决层（不跑像素、不建 worker） */
function loadOcrPure() {
  const self = { KH: { MSG: {} }, addEventListener() {}, postMessage() {} };
  const chrome = { runtime: { getURL: (r) => r, sendMessage() {}, onMessage: { addListener() {} } } };
  new Function(
    'self', 'chrome', 'Tesseract', 'OffscreenCanvas', 'createImageBitmap', 'fetch', 'indexedDB',
    read('offscreen/ocr.js')
  )(self, chrome, {}, {}, async () => ({}), async () => ({}), {});
  return self.__khOcrPure;
}

module.exports = async function run() {
  const KH = loadKernel();
  const IN = KH.ImportantNote;
  truthy(IN, 'KH.ImportantNote 必须可用');

  suite('2.0.16.6 ①：行文本卫生只清长行里的孤立字母');
    const P = loadOcrPure();
    truthy(P && typeof P.cleanLineText === 'function',
      '★ offscreen/ocr.js 必须导出纯函数 cleanLineText（self.__khOcrPure.cleanLineText）');

    await test('★ 长行里「汉字 + 空格 + 1–2 个字母 + 汉字」⇒ 字母连同空格被清掉（现场噪声）', () => {
      const got = P.cleanLineText(NOISE);
      falsy(/\sL派/.test(got), '孤立字母 L 必须消失：' + got);
      eq(got, '上海利多星证券咨城化派千夕日江光次沟古阳八司证券咨询有限公司',
        '只删那一个字母与它两侧空格，别的一个字不动');
    });

    await test('★ 短行里的字母是内容：上海A股上市公司 一个字都不许改', () => {
      eq(P.cleanLineText('上海A股上市公司'), '上海A股上市公司',
        '短行的字母是真实内容（代号/缩写），删了就是改数据');
    });

    await test('★ 正常长公司名 / 带括号别称 / 3 个字母的缩写都不动', () => {
      eq(P.cleanLineText('上海利多星证券咨询有限公司'), '上海利多星证券咨询有限公司');
      eq(P.cleanLineText('精河县融媒体中心（精河县广播电视台）'), '精河县融媒体中心（精河县广播电视台）');
      eq(P.cleanLineText('北京某某科技股份有限公司上海分公司（以下简称乙方）'),
        '北京某某科技股份有限公司上海分公司（以下简称乙方）',
        '字母≥3 的缩写不在清理范围（只认孤立的 1–2 个字母）');
    });

    await test('★ 空值 / null ⇒ 原样返回（不许把 undefined 变成字符串 undefined）', () => {
      eq(P.cleanLineText(''), '');
      eq(P.cleanLineText(null), '');
      eq(P.cleanLineText(undefined), '');
    });

  suite('2.0.16.6 ②：可疑值的判据（只认抄花了的形状，正常名不误报）');
    truthy(typeof IN._looksGarbled === 'function',
      '★ KH.ImportantNote._looksGarbled 必须导出（纯函数，单测直接钉）');

    await test('★ 现场噪声值 ⇒ 可疑', () => {
      truthy(IN._looksGarbled(NOISE), '这串就是用户报的那条，必须判可疑');
    });

    await test('★ 正常值一律不误报（括号别称 / 3M / 英文缩写 / 编号）', () => {
      const ok = [
        '上海利多星证券咨询有限公司',
        '精河县融媒体中心（精河县广播电视台）',
        '3M中国有限公司',
        '北京 ABC 科技有限公司',
        '华为 Mate 60',
        '2018SR959779',
        '软著登字第18265307号',
        '2021SRE008519',
        ''
      ];
      for (const v of ok) falsy(IN._looksGarbled(v), '不该判可疑：' + v);
    });

    /* 假 OCR 条目：ocrExtraRows 只认 done + text + 命中 */
    const item = {
      ruleId: 'r1', state: 'done', label: '资质证书', src: 'img-1',
      matched: [{ text: '著作权人' }],
      lineList: [],
      text: '计算机软件著作权登记证书\n著作权人：' + NOISE + '\n登记号：2018SR959779'
    };
    const withItems = (items, fn) => {
      const orig = KH.ImgOcr.items;
      KH.ImgOcr.items = () => items;
      try { return fn(); } finally { KH.ImgOcr.items = orig; }
    };
    const META = { pinId: 'r1', imgOcr: true, imgOcrKeyword: '著作权人#表', fetchLabels: '资质证书#图' };

    await test('★ 可疑值照常进表、一个字不改，只在行上打不可枚举的 suspect', () => {
      const rows = withItems([item], () => IN.ocrExtraRows(META));
      eq(rows.length, 1, '著作权人 这一行仍在表里：' + JSON.stringify(rows));
      eq(rows[0].label, '著作权人');
      eq(rows[0].value, NOISE, '★ 值必须原样保留（用户口径 A：只提示，不改判定）');
      eq(rows[0].suspect, true, '行上要能看出可疑');
      truthy(String(rows[0].suspectTip || '').length > 0, '悬停要说明为什么可疑（文案来自 ocr-copy）');
      falsy(Object.prototype.propertyIsEnumerable.call(rows[0], 'suspect'),
        'suspect 必须不可枚举 —— 行的对外形状仍是 {label, value}');
      eq(JSON.stringify(rows[0]), JSON.stringify({ label: '著作权人', value: NOISE }),
        'JSON 序列化后不许多出字段（既有深比较断言不能被打破）');
    });

    await test('★ 正常值不带 suspect（不误标）', () => {
      const clean = Object.assign({}, item, {
        text: '计算机软件著作权登记证书\n著作权人：上海利多星证券咨询有限公司\n登记号：2018SR959779'
      });
      const rows = withItems([clean], () => IN.ocrExtraRows(META));
      eq(rows.length, 1);
      eq(rows[0].value, '上海利多星证券咨询有限公司');
      eq(rows[0].suspect, undefined, '正常值不许挂 suspect');
    });

  suite('2.0.16.6 ③：标记必须真的被渲染层用上（否则等于没做）');
    await test('★ 取值链 / 渲染链 / 文案三处都在（源码契约）', () => {
      const fetch = read('src/features/fetch.js');
      truthy(fetch.indexOf('kh-val-suspect') >= 0,
        'fetch.js 必须给可疑值渲染徽标（kh-val-suspect）');
      truthy(fetch.indexOf('suspect: !!(e && e.suspect)') >= 0,
        '额外行必须把 suspect 带到渲染项上');
      const note = read('src/features/important-note.js');
      truthy(note.indexOf("Object.defineProperty(row, 'suspect'") >= 0,
        'ocrExtraRows 必须给行打 suspect');
      truthy(note.indexOf('.kh-table .kh-val-suspect') >= 0,
        '徽标样式必须在面板样式表里');
      const copy = read('src/ui/ocr-copy.js');
      truthy(copy.indexOf('imgSuspectTip') >= 0, '悬停文案必须在 ocr-copy.js（唯一真源）');
      truthy(copy.indexOf('imgSuspect:') >= 0, '徽标文案必须在 ocr-copy.js');
    });
};
