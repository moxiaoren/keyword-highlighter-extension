/* tests/specs/scope-issues.test.js — #116 需求：写错的 `@字段名` 不再静默
 * ----------------------------------------------------------------------------
 * 业务（用户 2026-11-10 原话）：「@字段名 写错时在设置页给出提示，而不是静默不生效」。
 *
 * 现状带来的坑：`splitScope` 遇到配不上的 `@…` 会停手、把整段按普通词处理 —— 这是 2.0.7.1
 * 为了让"把 `@` 当普通字符"的老配置一个字都不变而定的。代价是字段名打错一个字母之后，
 * 规则看着配了、实际不按字段生效，界面上没有任何提示。
 *
 * 本轮只加**诊断**、不改判定：
 *   · `scopeIssues(raw, known)` → `[{chip, name, kind:'unknown'|'suffix', suggest}]`
 *   · `scopeIssuesOf(rule)`    → 把 `imgOcrKeyword` 与 `imgOcrNeed` 两个字段一起诊断
 *   · UI 在「修改」弹窗顶部列出来；保存时也 toast 提醒一次（只提醒、不拦保存）
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy } = H;

const names = (list) => (list || []).map((it) => it.name);

module.exports = async function run() {
  const KH = H.loadKernel();
  const I = KH.ImgOcr;
  const known = ['开发者', '著作权人', '登记号'];

  suite('#116 · 指向诊断 scopeIssues');

  await test('★ 配得上的指向一条都不报（含 #表 标记）', () => {
    eq(I.scopeIssues('一对一@开发者', known).length, 0);
    eq(I.scopeIssues('登记号@登记号#表', known).length, 0, '词尾的 #表 不能被当成指向的一部分');
    eq(I.scopeIssues('a@开发者@著作权人', known).length, 0, '连写多个合法指向');
  });

  await test('★ 没有指向 / 空串 ⇒ 空清单', () => {
    eq(I.scopeIssues('', known).length, 0);
    eq(I.scopeIssues('普通词|另一个词', known).length, 0);
    eq(I.scopeIssues(null, known).length, 0);
  });

  await test('★ 名字打错 ⇒ unknown，并给出最接近的已配字段', () => {
    const r = I.scopeIssues('一对一@应用名', ['应用名称', '开发者']);
    eq(r.length, 1);
    eq(r[0].kind, 'unknown');
    eq(r[0].name, '应用名');
    eq(r[0].suggest, '应用名称', '少打一个字 ⇒ 前缀关系直接建议');
  });

  await test('★ 连写里只有最后一个配不上：只报那一个（不猜左侧的普通词）', () => {
    const r = I.scopeIssues('一对一@开发者@开发这', known);
    eq(names(r).join(','), '开发这');
    eq(r[0].suggest, '开发者', '编辑距离 1 ⇒ 建议');
  });

  await test('★ 把取值后缀写进指向 ⇒ suffix（这类永远配不上）', () => {
    const r = I.scopeIssues('a@开发者^高价', known);
    eq(r.length, 1);
    eq(r[0].kind, 'suffix');
    eq(r[0].name, '开发者^高价');
    eq(r[0].suggest, '开发者', '剥掉后缀后能对上 ⇒ 建议裸字段名');
  });

  await test('★ 后缀写在词上（不是指向里）是合法写法，不能报', () => {
    eq(I.scopeIssues('开发者^高价@开发者', known).length, 0);
  });

  await test('★ 一个抓取字段都没配时，任何指向都报 unknown 且没有建议', () => {
    const r = I.scopeIssues('词@截图', []);
    eq(r.length, 1);
    eq(r[0].kind, 'unknown');
    eq(r[0].suggest, '');
  });

  await test('★ 差得远的名字不给建议（不乱猜）', () => {
    const r = I.scopeIssues('词@完全不同的名字', known);
    eq(r.length, 1);
    eq(r[0].suggest, '');
  });

  await test('★ 多个词各自有病，一条不落', () => {
    const r = I.scopeIssues('a@开发这|b@登记号|c@著作权任', known);
    eq(names(r).join(','), '开发这,著作权任');
  });

  await test('★ 大小写与空白不影响命中判断（与 splitScope 同口径）', () => {
    eq(I.scopeIssues('x@ Dev Eloper ', ['DevEloper']).length, 0);
  });

  await test('★ scopeIssuesOf 把两个带指向的字段一起诊断并标明归属', () => {
    const rule = { meta: { fetchLabels: '开发者|著作权人|登记号', imgOcrKeyword: '词@开发这', imgOcrNeed: '词@开发者^高价' } };
    const r = I.scopeIssuesOf(rule);
    eq(r.length, 2);
    eq(r.filter((it) => it.field === 'imgOcrKeyword').length, 1);
    eq(r.filter((it) => it.field === 'imgOcrNeed')[0].kind, 'suffix');
  });

  await test('★ 实现住在 core/scope.js：设置页没有 ImgOcr 也能诊断', () => {
    const S = KH.Scope;
    eq(typeof S.scopeIssues, 'function');
    eq(S.scopeIssues('词@开发这', known).length, 1);
    eq(S.scopeIssuesOf({ fetchLabels: '开发者', imgOcrNeed: '词@开发者^高价' }).length, 1);
  });

  await test('★ ImgOcr 的入口只是转发，和 KH.Scope 同一份结果', () => {
    const S = KH.Scope;
    const a = JSON.stringify(I.scopeIssues('一对一@开发这|x@著作权任', known));
    const b = JSON.stringify(S.scopeIssues('一对一@开发这|x@著作权任', known));
    eq(a, b);
  });

  await test('★ 诊断不改判定：有问题的词在 scopedRaw 里仍按旧口径当普通词', () => {
    eq(I.scopeIssues('一对一@开发这', known).length, 1);
    eq(I.scopedRaw('一对一@开发这', '开发者', known), '一对一@开发这', '旧行为一个字不变');
  });
};
