/* tests/specs/tip-t6.test.js — 【T6】悬停降维：结论在第一句，最多三句
 * ----------------------------------------------------------------------------
 * 专家报告 pm.md T6：每条 tip ≤ 3 句，第一句是结论；「写法略有差异」统一成
 * 一句 + 差异类型（空格 / 全半角 / 标点 / 括号补充 / 差一个字…）。
 * 本文件只测呈现层纯函数与规则层产出的 how，不碰 DOM。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const P = KH.Compare.Present;
  const R = KH.Compare.Rules;

  suite('悬停降维 · T6（结论先行 / 最多三句 / 差异类型）');

  await test('一致：第一句就是结论，且带差异类型', () => {
    const tip = P.tipFor({ what: '比对「著作权人」↔「开发者」', state: 'same', how: 'fold-core', note: '「开发者」= 北京甲科技有限公司；这一行 = 北京甲科技（集团）有限公司' });
    const lines = tip.split('\n');
    truthy(lines.length <= 3, tip);
    truthy(lines[0].indexOf('一致') >= 0, lines[0]);
    truthy(lines[0].indexOf('写法略有差异：括号补充') >= 0, lines[0]);
  });

  await test('不一致：第一句结论，第三句给下一步', () => {
    const tip = P.tipFor({ what: '比对「著作权人」↔「开发者」', state: 'diff', how: 'conflict', note: '「开发者」= 北京甲；这一行 = 上海乙' });
    const lines = tip.split('\n');
    truthy(lines.length <= 3, tip);
    truthy(lines[0].indexOf('不一致') >= 0, lines[0]);
    truthy(lines[lines.length - 1].indexOf('人工确认') >= 0, tip);
  });

  await test('待配置：说清不改底色，并指到设置页', () => {
    const tip = P.tipFor({ what: '企业名称校验', state: 'unset', note: '还没配「开发者」这一行' });
    const lines = tip.split('\n');
    truthy(lines.length <= 3, tip);
    truthy(lines[0].indexOf('待配置') >= 0 && lines[0].indexOf('不改底色') >= 0, lines[0]);
    truthy(tip.indexOf('设置页 › 抓取字段') >= 0, tip);
  });

  await test('无法核实 / 超时：各有自己的结论词，不再共用「未查明」', () => {
    const u = P.tipFor({ what: '比对「著作权人」↔「开发者」', state: 'unknown', note: '这张卡里没有「开发者」这一行' });
    truthy(u.split('\n')[0].indexOf('无法核实') >= 0, u);
    const t = P.tipFor({ what: '同法人校验', state: 'timeout', note: '20 秒没有回执' });
    truthy(t.split('\n')[0].indexOf('超时') >= 0, t);
    truthy(t.indexOf('稍后重新打开') >= 0, t);
  });

  await test('差异类型映射：常见的五种都有人话', () => {
    eq(P.diffKind('fold-ws'), '空格');
    eq(P.diffKind('fold-width'), '全半角');
    eq(P.diffKind('fold-punct'), '标点');
    eq(P.diffKind('near'), '差一个字');
    eq(P.diffKind('contain'), '互相包含');
    eq(P.diffKind('same'), '');
  });

  await test('规则层：同值不再重复「一致」，只说两边原值', () => {
    const v = R.qualVerdict('北京甲科技有限公司', '北京甲科技有限公司');
    eq(v.state, 'same');
    eq(v.how, 'same');
    eq(v.note, '');
    const c = R.qualVerdict('北京甲科技有限公司', '北京甲科技有限');
    eq(c.state, 'same');
    eq(c.how, 'contain');
    truthy(c.note.indexOf('北京甲科技有限公司') >= 0, c.note);
  });

  await test('★ 配置对按括号补充判同 ⇒ 悬停第一句带「括号补充」', () => {
    const cfg = { imgCompare: { on: true, rows: [{ left: '著作权人', right: '开发者' }] } };
    const v = R.autoVerdict({
      labels: ['著作权人'], value: '北京甲科技（集团）有限公司', dev: '北京甲科技有限公司', devPresent: true,
      cfg: cfg, get: () => ({ found: true, value: '北京甲科技有限公司' })
    });
    eq(v.state, 'same');
    eq(v.how, 'fold-core');
    const pres = P.presentVerdict(Object.assign({ value: '北京甲科技（集团）有限公司', url: 'https://x', at: 1 }, v));
    truthy(pres.tip.split('\n')[0].indexOf('括号补充') >= 0, pres.tip);
    truthy(pres.tip.split('\n').length <= 3, pres.tip);
  });
};
