/* tests/specs/compiler.test.js — 匹配器：正则构建 / 全词边界 / 视觉与重要笔记解析 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;

  suite('compiler · buildPattern');

  await test('普通词：转义正则元字符（含 . 与 * 不算元字符）', () => {
    const re = C.buildPattern('a.b*c', { caseSensitive: false, wholeWord: false, useRegex: false });
    truthy(re.test('xa.b*cy'), '字面量模式应能匹配自身');
    falsy(re.test('axbyc'), '未转义的话 . 会吞字符');
  });

  await test('不区分大小写：默认加 i flag', () => {
    const re = C.buildPattern('AbC', { caseSensitive: false, wholeWord: false, useRegex: false });
    truthy(re.test('xxabcxx'));
  });

  await test('区分大小写：不加 i flag', () => {
    const re = C.buildPattern('AbC', { caseSensitive: true, wholeWord: false, useRegex: false });
    falsy(re.test('xxabcxx'));
    truthy(re.test('xxAbCxx'));
  });

  await test('全词：中文也用 Unicode 词边界（\\b 对纯中文永远匹配不到）', () => {
    const re = C.buildPattern('关键词', { caseSensitive: false, wholeWord: true, useRegex: false });
    truthy(re.test('这里的 关键词 命中'), '两侧是空白，应命中');
    falsy(re.test('关键词组'), '右侧延续词字符 → 不是独立全词');
  });

  await test('★ 全词 + 正则含 | ：必须整体加组，否则中间分支漏边界（策划案 §7.1 坑 1）', () => {
    // buildPattern 带 `g`（多命中遍历前提），所以每次断言都用**新副本**，
    // 不能复用同一个带 g 的对象连续 test()（那会因 lastIndex 残留而假阴性）。
    const mk = () => new RegExp(C.buildPattern('BUG|FEATURE|FIX',
      { caseSensitive: true, wholeWord: true, useRegex: true }).source, 'u');
    // 若没整体加 (?:)，会变成 (?<!B)BUG|FEATURE|FIX(?!B) → 中间分支无边界
    falsy(mk().test('xFEATUREy'), 'FEATURE 两侧是词字符 → 应被边界挡掉');
    truthy(mk().test('x FEATURE y'), '独立 FEATURE 应命中');
    truthy(mk().test('x BUG y'), '独立 BUG 应命中');
    falsy(mk().test('xBUGy'), 'BUG 两侧是词字符 → 应被挡掉');
    truthy(mk().test('x FIX y'), '第三个分支独立出现也应命中');
  });

  await test('★ 多命中：同一文本里所有分支都要产出，且必须带 g（K7 回归）', () => {
    const pat = C.buildPattern('BUG|FEATURE', { caseSensitive: true, wholeWord: true, useRegex: true });
    truthy(pat.flags.indexOf('g') >= 0,
      'buildPattern 必须带 g，否则 exec 循环只拿到第一个匹配；flags=' + pat.flags);
    const text = 'xBUGy aaa xFEATUREy bbb BUG ccc FEATURE ddd';
    // 按扫描侧的消费方式：复制一份再遍历
    const re = new RegExp(pat.source, pat.flags);
    const got = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      got.push(m[0] + '@' + m.index);
    }
    deepEq(got, ['BUG@24', 'FEATURE@32'],
      '独立 BUG 与第二个分支 FEATURE 都要命中；实际 ' + JSON.stringify(got));
  });

  await test('全词 + 正则：启用 Unicode 边界时必须带 u flag', () => {
    const re = C.buildPattern('词', { caseSensitive: false, wholeWord: true, useRegex: false });
    truthy(re.flags.indexOf('u') >= 0, 'flags=' + re.flags);
  });

  await test('非法正则 → 返回 null（不抛，交给上层跳过该词）', () => {
    eq(C.buildPattern('(', { useRegex: true }, {}), null);
  });

  await test('空模式 → 仍可构造（调用方负责判空）', () => {
    const re = C.buildPattern('', {});
    truthy(re, '空串能构造出正则');
  });

  suite('compiler · resolveVisual（颜色/重要/图片优先级）');

  const cfg = {
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    groups: [
      { id: 'g1', name: '组一', bgColor: '#111111', textColor: '#eeeeee', important: true, importantNote: '组笔记', impNoteUseHlColor: true, imgSize: 88 },
      { id: 'g2', name: '组二', bgColor: '', textColor: '', important: false }
    ]
  };

  await test('★ 颜色优先级：分组色 > 关键词色 > 全局默认（旧版 v1.52 口径）', () => {
    const a = C.resolveVisual({ groupId: 'g1', bgColor: '#222222', textColor: '#333333' }, cfg);
    eq(a.style.bgColor, '#111111', '分组色应压过关键词色');
    eq(a.style.textColor, '#eeeeee');
    const b = C.resolveVisual({ groupId: 'g2', bgColor: '#222222', textColor: '#333333' }, cfg);
    eq(b.style.bgColor, '#222222', '分组没设色 → 用关键词色');
    const c = C.resolveVisual({ groupId: null, bgColor: '', textColor: '' }, cfg);
    eq(c.style.bgColor, '#ff9500', '都没有 → 全局默认');
    eq(c.style.textColor, '#000000');
  });

  await test('重要：关键词重要 或 分组重要', () => {
    truthy(C.resolveVisual({ groupId: 'g1' }, cfg).meta.important, '分组重要 → 命中重要');
    truthy(C.resolveVisual({ groupId: 'g2', important: true }, cfg).meta.important, '关键词自报重要');
    falsy(C.resolveVisual({ groupId: 'g2' }, cfg).meta.important);
  });

  await test('重要笔记：关键词自身优先，否则用分组的（且分组必须重要）', () => {
    eq(C.resolveVisual({ groupId: 'g1' }, cfg).meta.importantNote, '组笔记');
    /* 【K71 裁定 2】"该词自己的"笔记正文要**乘 `kw.important`**（「重要笔记」模块开关）：
     * 抓取开关只让卡片进面板，不该把"没勾重要笔记"的正文一起带进去。分组级那半条不动。 */
    eq(C.resolveVisual({ groupId: 'g1', important: true, importantNote: '自己的' }, cfg).meta.importantNote, '自己的',
      '勾了「重要笔记」→ 本词正文优先（与旧口径一致）');
    eq(C.resolveVisual({ groupId: 'g1', importantNote: '自己的' }, cfg).meta.importantNote, '组笔记',
      '★ 没勾「重要笔记」→ 本词自己的正文不参与，落回分组那条');
    eq(C.resolveVisual({ groupId: 'g2', important: true, importantNote: '' }, cfg).meta.importantNote, '', '分组不重要 → 不继承组笔记');
  });

  await test('复用高亮底色：勾了才铺，且铺的是"实际生效底色"', () => {
    eq(C.resolveVisual({ groupId: 'g1' }, cfg).meta.impNoteBg, '#111111', '应铺分组色');
    eq(C.resolveVisual({ groupId: 'g2', important: true, impNoteUseHlColor: true, bgColor: '#abcdef' }, cfg).meta.impNoteBg, '#abcdef');
    eq(C.resolveVisual({ groupId: 'g2', impNoteUseHlColor: true, bgColor: '#abcdef' }, cfg).meta.impNoteBg, '',
      '★ 没勾「重要笔记」→ 本词的复用底色不参与（与正文同一归属）');
    eq(C.resolveVisual({ groupId: 'g2' }, cfg).meta.impNoteBg, '', '没勾 → 空串＝不铺');
  });

  await test('图片尺寸：关键词自身 > 分组（且分组必须重要）', () => {
    eq(C.resolveVisual({ groupId: 'g1' }, cfg).meta.imgSize, 88, '继承分组尺寸');
    eq(C.resolveVisual({ groupId: 'g1', important: true, imgSize: 40 }, cfg).meta.imgSize, 40, '自身尺寸优先');
    eq(C.resolveVisual({ groupId: 'g1', imgSize: 40 }, cfg).meta.imgSize, 88,
      '★ 没勾「重要笔记」→ 本词自己的尺寸不参与，落回分组那条');
    eq(C.resolveVisual({ groupId: 'g2', important: true, imgSize: '' }, cfg).meta.imgSize, '');
  });

  suite('compiler · 适配器派发');

  await test('普通词走 normal 适配器，且带 fetchLabels 的普通词不会被拒收（策划案 §7 的 P2 实测坑）', () => {
    const rules = C.compileAll({
      highlightStyle: cfg.highlightStyle,
      groups: [],
      keywords: [{ id: 'k1', text: '补丁', fetchLabels: '备注', enabled: true }]
    });
    eq(rules.length, 1);
    eq(rules[0].kind, 'normal');
    truthy(rules[0].meta.important, '配了抓取字段的普通词应自动进重要笔记（旧版 wantFetch）');
  });

  await test('禁用的关键词不编译', () => {
    const rules = C.compileAll({ keywords: [{ id: 'k', text: 'x', enabled: false }] });
    eq(rules.length, 0);
  });
};
