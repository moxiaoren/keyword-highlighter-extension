/* tests/specs/text-norm.test.js — 「算不算同一个值」的唯一口径（2.0.8.18 需求①）
 * ----------------------------------------------------------------------------
 * 为什么单独一条 spec：
 *   这条需求的原点不是"某个函数算错了"，而是**同一个问题被四个地方各判了一次**
 *   （`ImgOcr.judgeInfo` 子串 / `ocrFieldHit` 全齐 / `ocrExtraRows` 任一 / `decorateMerge` 精确回表）。
 *   四份实现各自能跑，但只要它们不一致，用户就会看到"面板说没命中、表里却出了行"。
 *   所以这里不看调用方，只钉死被收敛出来的那一份口径本身：
 *     · 折叠必须**分级可解释**（verdict 要说清是哪一级相等），不能笼统返回 true；
 *     · 命中区间必须落在**原文**上（面板画词块 / 复制整句都靠它）；
 *     · 纯 ASCII 短值必须**拒绝参与判定**（`12` 命中 `2024-12-31` 是用户现场 S3）。
 *   调用方是否真的用了这份实现，由 `scripts/meta-check.js` 的哨兵管（那是"禁止回退成第二份实现"）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy, loadKernel } = H;

module.exports = async function run() {
  suite('text-norm · 值一致判定（空白/全半角/零宽/大小写/边界/弱判据）');
  const KH = loadKernel();
  const TN = KH.TextNorm;
  truthy(TN, 'KH.TextNorm 必须挂上内核（manifest 里漏登记就会红在这里）');
  if (!TN) return;

  /* ------------------------------------------------------------------ verdict */
  await test('★ verdict 分级：same 之后依次 fold-ws → fold-width → fold-zero → fold-case', () => {
    eq(TN.verdict('abc1234', 'abc1234'), 'same', '原样相同');
    eq(TN.verdict('abc 1234', 'abc1234'), 'fold-ws', 'OCR 字距会插空格');
    eq(TN.verdict('ａｂｃ１２３４', 'abc1234'), 'fold-width', '全角（OCR 最常见的一种）');
    eq(TN.verdict('ab\u200Bc1234', 'abc1234'), 'fold-zero', '零宽字符不可见但会打断 indexOf');
    eq(TN.verdict('ABC1234', 'abc1234'), 'fold-case', '只差大小写');
    eq(TN.verdict('abc1234', 'abc1235'), 'conflict', '真的不一样');
    eq(TN.verdict('abc1234', ''), 'only-a', '一侧为空 = 缺数据，不是冲突');
    eq(TN.verdict('', ''), 'none', '两侧都空');
  });

  await test('★ 归一只用于比较：不改变调用方的原值（不做不可逆覆盖）', () => {
    const a = 'ＡＢＣ 1234';
    const snapshot = String(a);
    TN.verdict(a, 'abc1234');
    eq(a, snapshot, 'verdict 不许回写 / 不许就地改造入参');
  });

  /* ------------------------------------------------------------------ keyOf */
  await test('keyOf：空白 / 全半角 / 零宽 / 大小写全折，用于去重与标签匹配', () => {
    eq(TN.keyOf(' Ａ Ｂ\u3000Ｃ '), 'abc', '全角 + 全角空格 + 普通空白一起折');
    eq(TN.keyOf('ab\u200Bc'), 'abc', '零宽剥离');
  });

  /* --------------------------------------------------------------- findInText */
  await test('★ findInText：全角命中要映射回**原文**区间（面板词块与复制整句靠它）', () => {
    const text = '开发者：公司ＡＢＣ１２３４（盖章）';
    const hit = TN.findInText(text, 'abc1234');
    truthy(hit, '全角值必须能找到');
    eq(hit.text, 'ＡＢＣ１２３４', '返回的 text 是原文切片（保留全角，不改写成半角）');
    eq(text.slice(hit.start, hit.end), hit.text, '区间必须与原文对得上');
    eq(hit.key, 'abc1234', 'key 是折叠后的判据键');
  });

  await test('★ findInText：纯 ASCII 判据要词边界（`abc1234` 不许命中 `abc12345`）', () => {
    falsy(TN.findInText('编号 abc12345 结束', 'abc1234'), '右侧是数字 ⇒ 不是同一个值');
    truthy(TN.findInText('编号 abc1234 结束', 'abc1234'), '两侧都是空格 ⇒ 命中');
    truthy(TN.findInText('编号：abc1234，盖章', 'abc1234'), '中文标点也算边界');
  });

  await test('★ findInText：短值不许当判据（S3 `12` 命中 `2024-12-31`）', () => {
    falsy(TN.findInText('日期 2024-12-31', '12'), '`12` 太短 ⇒ 返回 null（调用方记为"判据不可用"，不是"没命中"）');
    falsy(TN.findInText('编号 abc', 'abc'), '3 位 ASCII 也弱');
    truthy(TN.findInText('日期 2024-12-31', '12', { allowWeak: true }), '显式 allowWeak 时才允许（诊断用）');
  });

  await test('中文两字是有效判据（`张三` 不该被当成弱值）', () => {
    truthy(TN.findInText('负责人：张三', '张三'), '中文没有词边界概念，两字即有意义');
    falsy(TN.isWeak('张三'), 'isWeak 只针对纯 ASCII');
  });

  /* -------------------------------------------------------------------- isWeak */
  await test('isWeak：分界值（4 位 ASCII 起步，其余 2 字起步）', () => {
    eq(TN.isWeak('12'), true);
    eq(TN.isWeak('abc'), true);
    eq(TN.isWeak('abcd'), false);
    eq(TN.isWeak('ab12'), false);
    eq(TN.isWeak('张'), true);
    eq(TN.isWeak('张三'), false);
  });

  /* ------------------------------------------------------------------- equal */
  await test('equal：折叠出来的相等算相等；weak 不下结论（既不算等也不算冲突）', () => {
    eq(TN.equal('ＡＢＣ１２３４', 'abc1234'), true);
    eq(TN.equal('abc1234', 'abc1235'), false);
    eq(TN.equal('ab', 'ab'), true, '原样相同就是相同');
    eq(TN.verdict('ab', 'abc'), 'weak', '短值之间的"不同"不许报成 conflict');
  });
};
