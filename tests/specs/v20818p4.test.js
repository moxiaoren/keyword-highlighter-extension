/* tests/specs/v20818p4.test.js — 2.0.8.19 需求（P4）：软著三方比对
 * ----------------------------------------------------------------------------
 * 业务（用户 2026-11-09 原话）：软著证明里有著作权人、登记号，要与页面上的开发者比对；
 * **不一致就必须有软著授权书**（授权公司、被授权公司、登记号）。三组要一一对上：
 *   开发者 = 被授权公司、著作权人 = 授权公司、两个登记号一致。
 *
 * 口径（Q6–Q8 全部取推荐）：
 *   ① 文档角色借 OCR 条目所属字段（`it.label`）判断，不新增存储：一张图里出现了右侧字段
 *      ⇒ 它是授权书；判角色的锚是「只出现在右侧、从不出现在左侧」的字段（登记号两边都有）。
 *   ② 同角色多张图取**并集**；同一个字段在授权书里出现两个值 ⇒ 报「授权书内部不一致」。
 *   ③ 结论放在合并表格**下方一行**，没有问题就完全不渲染（不留空壳）。
 *   ④ 弱值（<2 字 / 纯 ASCII<4）不参与判等，避免 `12` 撞上 `2024-12-31`。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy } = H;

/** 造一条 OCR 进表行：`from` 是 `ocrExtraRows` 打在行上的不可枚举来源（这里按形状平铺）。 */
const row = (label, value, src) => ({ label: label, value: value, from: { src: src, label: label, kind: 'static' } });

module.exports = async function run() {
  const KH = H.loadKernel();
  const C = KH.Config;
  const N = KH.ImportantNote;
  const V = KH.OcrCopy.VIEW;

  /* ================= ① 配置归一 ================= */

  suite('2.0.8.19 · P4 比对配置的归一');

  await test('★ 左右字段都去空白；任一侧为空的行直接丢', () => {
    const r = C.normalizeImgCompare({ rows: [{ left: ' 开发者 ', right: ' 被授权公司 ' }, { left: '', right: '授权公司' }] });
    eq(r.on, true, '默认开着（配了行就该跑）');
    eq(r.rows.length, 1);
    eq(r.rows[0].left, '开发者');
    eq(r.rows[0].right, '被授权公司');
  });

  await test('★ 同一组左右字段只留一次（大小写/空白不同也算同一组）', () => {
    const r = C.normalizeImgCompare({
      rows: [{ left: 'Reg No', right: 'A' }, { left: 'reg  no', right: ' a ' }]
    });
    eq(r.rows.length, 1);
  });

  await test('★ 最多 12 组（配置面板一行一组，再多也放不下）', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ left: 'L' + i, right: 'R' + i });
    eq(C.normalizeImgCompare({ rows: rows }).rows.length, 12);
  });

  await test('★ 不配 / 配空 ⇒ 关闭，且 compareOf 直接返回 null（零成本）', () => {
    const cfg = { imgCompare: C.normalizeImgCompare({}) };
    eq(N.compareOf([row('开发者', '公司a', 'A')], cfg), null);
  });

  /* ================= ② 角色识别（哪张图是授权书） ================= */

  suite('2.0.8.19 · P4 授权书角色识别');

  const cfgOf = (rows) => ({ imgCompare: C.normalizeImgCompare({ on: true, rows: rows }) });
  const ROWS = [
    { left: '开发者', right: '被授权公司' },
    { left: '著作权人', right: '授权公司' },
    { left: '登记号', right: '登记号' }
  ];

  await test('★ 图里有「授权公司」⇒ 这张图是授权书；软著证明那张不算', () => {
    const rows = [
      row('著作权人', '甲公司', 'soft'),
      row('登记号', 'abfx', 'soft'),
      row('授权公司', '甲公司', 'auth'),
      row('被授权公司', '乙公司', 'auth'),
      row('登记号', 'abfx', 'auth')
    ];
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    eq(cmp.hasDoc, true);
    eq(cmp.docCount, 1);
    /* 右侧（授权书侧）的值取授权书那张图 */
    eq(cmp.rows[1].rv[0], '甲公司');
    /* 登记号两边都有：不能因为它在右侧字段表里就把软著证明误判成授权书 */
    eq(cmp.docCount, 1, '只认一张授权书');
  });

  await test('★ 没有授权书 ⇒ hasDoc=false（结论改成「需要授权书」）', () => {
    const rows = [row('著作权人', '甲公司', 'soft'), row('登记号', 'abfx', 'soft')];
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    eq(cmp.hasDoc, false);
    eq(cmp.docCount, 0);
  });

  await test('★ 授权书有多页 ⇒ 同角色取并集；同字段两个值 ⇒ 报内部不一致', () => {
    const rows = [
      row('授权公司', '甲公司', 'auth1'),
      row('被授权公司', '乙公司', 'auth1'),
      row('授权公司', '丙公司', 'auth2')
    ];
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const r = cmp.rows[1];
    eq(r.rv.length, 2, '并集两个值');
    const probs = N.compareProblems(cmp, () => '');
    truthy(probs.some((p) => p.kind === 'docMulti'), '同字段两个值要报内部不一致');
  });

  /* ================= ③ 判等与问题清单 ================= */

  suite('2.0.8.19 · P4 判等与结论文案');

  const baseRows = () => ([
    row('著作权人', '甲公司', 'soft'),
    row('登记号', 'abfx', 'soft'),
    row('授权公司', '甲公司', 'auth'),
    row('被授权公司', '乙公司', 'auth'),
    row('登记号', 'abfx', 'auth')
  ]);
  const domOf = (map) => (field) => map[field] || '';

  await test('★ 三组全对上 ⇒ 没有问题、也不渲染结论', () => {
    const cmp = N.compareOf(baseRows(), cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    eq(probs.length, 0);
    eq(N.compareText(probs, cmp.hasDoc), '');
  });

  await test('★ 配了比对但没有授权书 ⇒ 一句话让它去补，不罗列三条缺字段', () => {
    const rows = [row('著作权人', '甲公司', 'soft'), row('登记号', 'abfx', 'soft')];
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    eq(cmp.hasDoc, false);
    const probs = N.compareProblems(cmp, domOf({ 开发者: '丁公司' }));
    eq(probs.length, 1);
    eq(probs[0].kind, 'noDoc');
    eq(N.compareText(probs, cmp.hasDoc), V.cmpNoDoc);
  });

  await test('★ 有授权书仍不一致 ⇒ 逐组报「图上是 X / 授权书是 Y」', () => {
    const rows = baseRows();
    rows[2] = row('授权公司', '戊公司', 'auth');
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    eq(probs.length, 1);
    const text = N.compareText(probs, cmp.hasDoc);
    truthy(text.indexOf('著作权人') >= 0, text);
    truthy(text.indexOf('甲公司') >= 0 && text.indexOf('戊公司') >= 0, text);
    truthy(text.indexOf(V.cmpNoDoc) < 0, '有授权书就不再提授权书');
  });

  await test('★ 全半角/空白差异算「一致」（走 TextNorm，不误报）', () => {
    const rows = baseRows();
    rows[3] = row('被授权公司', '乙公 司', 'auth');
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    eq(probs.length, 0, '空白不该造成不一致');
  });

  await test('★ 授权书缺字段 ⇒ 报「缺『被授权公司』」，不报不一致', () => {
    const rows = baseRows().filter((r) => r.label !== '被授权公司');
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    truthy(probs.some((p) => p.kind === 'missRight'), JSON.stringify(probs));
    const text = N.compareText(probs, cmp.hasDoc);
    truthy(text.indexOf('缺「被授权公司」') >= 0, text);
  });

  await test('★ 弱值不参与判等（`12` 不能撞出冲突）', () => {
    const rows = baseRows();
    rows[4] = row('登记号', '12', 'auth');
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    eq(probs.length, 0, '两边都太短 ⇒ 不当成"对不上"');
  });

  await test('★ 多条结论用配置的分隔符连起来，重复文案只留一条', () => {
    const rows = baseRows();
    rows[2] = row('授权公司', '戊公司', 'auth');
    rows[3] = row('被授权公司', '己公司', 'auth');
    const cmp = N.compareOf(rows, cfgOf(ROWS));
    const probs = N.compareProblems(cmp, domOf({ 开发者: '乙公司' }));
    const text = N.compareText(probs, cmp.hasDoc);
    truthy(text.indexOf(V.cmpSep) >= 0, text);
    eq(text.split(V.cmpSep).length, 2, '两组不一致 = 两条结论');
  });
};
