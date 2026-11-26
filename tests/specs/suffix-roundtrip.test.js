/* tests/specs/suffix-roundtrip.test.js — 后缀「写法 ⇄ 解析」往返（2026-11-15，2.0.11 批2）
 * ----------------------------------------------------------------------------
 * 批 2 把「取哪一格」与「@值格」合成一个位置组、把 #1 变成勾选，面板控件换了，
 * 但**落盘语法一个字节都不能变**。这条用例把 `parseLabelSpec` 与 `suffixTextOf`
 * 对照着钉住：给一段规范写法，解析再拼回来必须逐字相同。
 *
 * 为什么必须往返：解析端是「按优先级从末尾剥、剥一轮换下一条」的循环，
 * 上限恰好 7 轮；写法里同时出现 7 个记号时再多一个就会静默丢后缀。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;

  suite('取值后缀 · 写法与解析往返（2.0.11 批2）');

  await test('★ 每种后缀单独写一遍：拼回来逐字相同', () => {
    const cases = ['#1', '#图', '#图3', '#3', '#0', '#图1,3', '#1,3', '@2', '^锚文本', '%4', '%1-3', '~', '*', '*https://x/?q={v}', '!'];
    for (const sfx of cases) {
      const spec = F.parseLabelSpec('字段 ' + sfx);
      eq(spec.label, '字段', '标签与后缀要分得开：' + sfx);
      eq(F.suffixTextOf(spec), sfx, '往返不一致：' + sfx);
    }
  });

  await test('★ 七个记号一起写也不许丢（解析循环上限刚好 7 轮）', () => {
    const full = '#图3 @2 ! ^锚 %1-3 ~ *tpl';
    const spec = F.parseLabelSpec('字段 ' + full);
    eq(F.suffixTextOf(spec), full, '全写一遍要一个不丢');
    eq(spec.label, '字段', '剥完之后只剩标签');
    truthy(spec.offsetInvalid === false, '@2 是合法位置');
    eq(F.suffixTextOf(F.parseLabelSpec('字段 ' + F.suffixTextOf(spec))), full, '再往返一次仍然稳定');
  });

  await test('★ 点图第几张是「点名」不是「最多几张」', () => {
    const pick = F.parseLabelSpec('字段 #图1,3');
    eq(pick.imgPick.join(','), '1,3', '#图1,3 是点名第 1、3 张');
    truthy(pick.imgOnly === true, '#图 前缀 = 只要图片');
    eq(pick.imgLimit, 0, '点名不写上限（别和 #图3 混了）');
    eq(F.suffixTextOf(F.parseLabelSpec('字段 #1,3')), '#1,3', '文字照留、图只留第 1、3 张');
  });

  await test('★ 写坏的位置只在展示串里标「无效」，不改存储', () => {
    const bad = F.parseLabelSpec('字段 @abc');
    truthy(bad.offsetInvalid === true, '非法位置要判出来（取值时回退右邻格）');
    eq(F.suffixTextOf(bad), '@abc（无效）', '展示串如实标无效，让人看得见');
    eq(F.suffixTextOf(F.parseLabelSpec('字段 @abc（无效）')), '@abc（无效）', '标了无效再读回来仍是无效');
  });

  /* 【2.0.19.2 需求②】锚点三种方向：^甲 之前（老写法）、>甲 之后、^甲>乙 之间。
   * 为什么不是把 ^ 写两遍：字段名本身可以带 ^ 与任意汉字，甲^乙 与「字段名甲 + 锚点乙」
   * 在语法上不可区分，那样改会让老配置静默改义 —— 所以方向用 > 这个此前不参与语义的记号。 */
  await test('★ 2.0.19.2 锚点三方向：写法 ⇄ 解析往返逐字相同', () => {
    for (const sfx of ['^甲方', '>甲方', '^甲方>乙方', '>：', '@2 >甲方', '! >甲方']) {
      const spec = F.parseLabelSpec('字段 ' + sfx);
      eq(spec.label, '字段', '标签与方向后缀要分得开：' + sfx);
      eq(F.suffixTextOf(spec), sfx, '往返不一致：' + sfx);
      eq(F.suffixTextOf(F.parseLabelSpec('字段 ' + F.suffixTextOf(spec))), sfx, '再往返一次要稳定：' + sfx);
    }
    eq(F.parseLabelSpec('字段 ^甲>乙').anchor, '甲');
    eq(F.parseLabelSpec('字段 ^甲>乙').anchorTo, '乙');
    eq(F.parseLabelSpec('字段 ^甲>乙').anchorMode, 'between');
    eq(F.parseLabelSpec('字段 >甲').anchorMode, 'after');
    eq(F.parseLabelSpec('字段 ^甲').anchorMode, 'before');
  });


  await test('★ 2.0.19.2 老写法不被改义：单独的收尾 ^ 仍属于标签本身', () => {
    eq(F.parseLabelSpec('备注^').label, '备注^', '备注^ 不是「取备注之后」，是标签就叫 备注^');
    eq(F.parseLabelSpec('备注^').anchor, '', '没有锚点');
    eq(F.parseLabelSpec('备注^').anchorMode, '', '也没有方向');
  });

  await test('★ 2.0.19.2 人话把方向说清（按钮上不让人背语法）', () => {
    truthy(F.describeSuffix(F.parseLabelSpec('字段 >甲方')).indexOf('之后') >= 0);
    const b = F.describeSuffix(F.parseLabelSpec('字段 ^甲方>乙方'));
    truthy(b.indexOf('甲方') >= 0 && b.indexOf('乙方') >= 0 && b.indexOf('之间') >= 0, b);
  });
};
