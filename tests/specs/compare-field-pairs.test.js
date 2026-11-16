/* tests/specs/compare-field-pairs.test.js — 「抓取字段之间的比对」（方案 A：勾「比对」+ 必填对象）
 * ----------------------------------------------------------------------------
 * 【2.0.11 · 用户 m01003 拍板】「选 A，每行加「比对」勾选 + 后缀指定搭档。配置对比，必须指定对象。」
 *   · 「抓取后续字段」每行多一枚「比对」勾选；勾上后行内出现「和谁比」下拉，选完落盘成
 *     `开发者#比=著作权人`（标记必须收尾；单独 `#比` 无对象 = 没指定对手，允许保存但不判）。
 *   · 判定：两边都有值才判，归一化相等 = 一致，不等 = 待确认并点名；缺一边 = 未查明；不涂色。
 * 【2026-11-16 · 用户 m01013】只有「开发者 ↔ 核准主体名称（含同类主体名）」这一对查法人比同法人，
 *   由 paintEntity 的独立链路出结论；其它字段对一律纯字面比，这里必须让开，不能双判。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy, loadKernel } = H;

module.exports = async function run() {
  const KH = loadKernel();
  const F = KH.Fetch;
  const R = KH.Compare && KH.Compare.Rules;
  truthy(F && typeof F.parseLabelSpec === 'function', 'KH.Fetch.parseLabelSpec 必须可用');
  truthy(R && typeof R.pairsOfLabels === 'function', 'KH.Compare.Rules.pairsOfLabels 必须可用');

  suite('2.0.11 抓取字段比对：存储写法 `#比=对象`');

    await test('★ 勾了并选了对象 ⇒ 读出 cmpOn + cmpTarget，字段名保持干净', () => {
      const sp = F.parseLabelSpec('开发者#比=著作权人');
      eq(sp.label, '开发者');
      eq(sp.cmpOn, true);
      eq(sp.cmpTarget, '著作权人');
    });

    await test('★ 只勾没选对象 ⇒ cmpOn 有、对象为空（允许存，但不判）', () => {
      const sp = F.parseLabelSpec('开发者#比');
      eq(sp.label, '开发者');
      eq(sp.cmpOn, true);
      eq(sp.cmpTarget, '');
    });

    await test('没勾 ⇒ 两个字段都不出现', () => {
      const sp = F.parseLabelSpec('开发者');
      eq(sp.cmpOn, false);
      eq(sp.cmpTarget, '');
    });

    await test('★ 与既有后缀共存：`#图` / `~` 照旧生效', () => {
      const sp = F.parseLabelSpec('开发者#图2#比=著作权人');
      eq(sp.label, '开发者');
      eq(sp.imgOnly, true);
      eq(sp.imgLimit, 2);
      eq(sp.cmpTarget, '著作权人');
      const clip = F.parseLabelSpec('开发者#比=著作权人~');
      eq(clip.label, '开发者');
      eq(clip.clip, true);
      eq(clip.cmpTarget, '著作权人');
    });

    await test('★ 英文写法 `#cmp=对象` 等价', () => {
      const sp = F.parseLabelSpec('开发者#cmp=著作权人');
      eq(sp.label, '开发者');
      eq(sp.cmpOn, true);
      eq(sp.cmpTarget, '著作权人');
    });

  suite('2.0.11 抓取字段比对：成对（pairsOfLabels）');

    await test('★ 一条带对象的写法 ⇒ 一对（字段键已归一）', () => {
      const ps = R.pairsOfLabels('开发者#比=著作权人');
      eq(ps.length, 1);
      eq(ps[0].left, '开发者');
      eq(ps[0].right, '著作权人');
      truthy(!!ps[0].kl && !!ps[0].kr, '两侧都要有归一后的字段键');
    });

    await test('★ 没选对象 / 自己跟自己 都不成对', () => {
      eq(R.pairsOfLabels('开发者#比').length, 0);
      eq(R.pairsOfLabels('开发者#比=开发者').length, 0);
      eq(R.pairsOfLabels('开发者|著作权人').length, 0);
    });

    await test('★ 正反两个方向写只留一对（方向无关）', () => {
      const ps = R.pairsOfLabels('开发者#比=著作权人,著作权人#比=开发者');
      eq(ps.length, 1);
    });

    await test('★ 多个字段混排：没勾的行不受影响', () => {
      const ps = R.pairsOfLabels('截图|开发者#比=核准主体名称|著作权人#比=主办单位');
      eq(ps.length, 2);
      eq(ps.map((p) => p.left + '~' + p.right).join(','), '开发者~核准主体名称,著作权人~主办单位');
    });

  suite('2.0.11 抓取字段比对：只让「开发者 ↔ 主体名」给法人链路');

    await test('★ 开发者 ↔ 核准主体名称（含同类主体名）算主体对', () => {
      eq(R.isEntityPair('开发者', '核准主体名称'), true);
      eq(R.isEntityPair('核准主体名称', '开发者'), true);
      eq(R.isEntityPair('开发者', '主办单位'), true);
    });

    await test('★ 其它字段对一律不算主体对（纯字面比）', () => {
      eq(R.isEntityPair('开发者', '著作权人'), false);
      eq(R.isEntityPair('著作权人', '主办单位'), false);
      eq(R.isEntityPair('截图', '开发者'), false);
    });

  suite('2.0.11 抓取字段比对：判定（autoVerdict 吃 opts.pairs）');

    const getOf = (map) => (f) => {
      const v = map[f];
      return v == null ? { found: false, value: '' } : { found: true, value: String(v) };
    };

    await test('★ 关键词内对子：名字一致 ⇒ 一致（不查法人）', () => {
      const pairs = R.pairsOfLabels('著作权人#比=开发者');
      const v = R.autoVerdict({
        labels: ['著作权人'],
        value: '北京知行灵动科技有限公司',
        cfg: { imgCompare: { on: true, rows: [] } },
        pairs: pairs,
        get: getOf({ 开发者: '北京知行灵动科技有限公司' })
      });
      truthy(!!v, '配了关键词内对子就要判');
      eq(v.state, 'same');
    });

    await test('★ 名字不同 ⇒ 待确认（diff），并说清是跟谁比', () => {
      const pairs = R.pairsOfLabels('著作权人#比=开发者');
      const v = R.autoVerdict({
        labels: ['著作权人'],
        value: '华为技术有限公司',
        cfg: { imgCompare: { on: true, rows: [] } },
        pairs: pairs,
        get: getOf({ 开发者: '北京知行灵动科技有限公司' })
      });
      eq(v.state, 'diff');
      truthy(String(v.note || v.what || '').length > 0, '要给出人话说明');
    });

    await test('★ 对手那一侧是空 ⇒ 未查明（不涂色）', () => {
      const pairs = R.pairsOfLabels('著作权人#比=开发者');
      const v = R.autoVerdict({
        labels: ['著作权人'],
        value: '华为技术有限公司',
        cfg: { imgCompare: { on: true, rows: [] } },
        pairs: pairs,
        get: getOf({ 开发者: '' })
      });
      eq(v.state, 'unknown');
      eq(v.color, '');
    });

    await test('★ 开发者 ↔ 核准主体名称 让给法人链路：autoVerdict 不判', () => {
      const pairs = R.pairsOfLabels('核准主体名称#比=开发者');
      const v = R.autoVerdict({
        labels: ['核准主体名称'],
        value: '华为技术有限公司',
        cfg: { imgCompare: { on: true, rows: [] } },
        pairs: pairs,
        get: getOf({ 开发者: '北京知行灵动科技有限公司' })
      });
      eq(v, null);
    });

    await test('★ 设置页那张全局比对表已退场：只认关键词内对子（cfg 里的 rows 不再生效）', () => {
      const v = R.autoVerdict({
        labels: ['著作权人'],
        value: '北京知行灵动科技有限公司',
        cfg: { imgCompare: { on: true, rows: [{ left: '著作权人', right: '开发者' }] } },
        pairs: [],
        get: getOf({ 开发者: '北京知行灵动科技有限公司' })
      });
      eq(v, null, '★ 没标 #比 ⇒ 一律不判');
    });
};
