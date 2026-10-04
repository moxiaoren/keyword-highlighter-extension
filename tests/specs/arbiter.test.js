/* tests/specs/arbiter.test.js — 重叠命中裁决：优先级与确定性 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 造一条 RawHit。★ 必须共用同一个 node 引用，否则 overlaps 会因"不同文本节点"判为不冲突 */
const NODE = {};
function hit(ruleId, start, end, kind, priority) {
  return { rule: { ruleId, kind: kind || 'normal', priority: priority || 0 }, node: NODE, start, end, text: 'x' };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const A = KH.Arbiter;

  suite('arbiter · 重叠与优先级');

  await test('不重叠 → 全部保留，shadowed 为空', () => {
    const r = A.resolve([hit('a', 0, 3), hit('b', 5, 8)]);
    eq(r.resolved.length, 2);
    eq(r.shadowed.length, 0);
  });

  await test('★ 长匹配优先（附录A §1.5 第 1 顺位）', () => {
    const r = A.resolve([hit('short', 0, 2), hit('long', 0, 6)]);
    eq(r.resolved.length, 1);
    eq(r.resolved[0].rule.ruleId, 'long', '覆盖范围更长者胜');
    eq(r.shadowed.length, 1);
    eq(r.shadowed[0].rule.ruleId, 'short', '被覆盖者仍登记（统计/聚合不丢数据）');
  });

  await test('★ 长度相同 → 更小的 kwId（配置靠前者）优先（附录A §1.5 第 3 顺位）', () => {
    const r = A.resolve([hit('kw_b', 0, 4), hit('kw_a', 0, 4)]);
    eq(r.resolved[0].rule.ruleId, 'kw_a');
  });

  await test('长度也相同、kwId 也相同 → 先登记者胜（start 小者）', () => {
    const r = A.resolve([hit('same', 6, 9), hit('same', 1, 4)]);
    eq(r.resolved.length, 2, '不重叠 → 都保留');
    // 同 id 且重叠时才比 start
    const r2 = A.resolve([hit('same', 2, 5), hit('same', 0, 3)]);
    eq(r2.resolved[0].start, 0, 'start 小者先');
  });

  await test('显式 priority 参与排序（长度相同才生效）', () => {
    const r = A.resolve([hit('a', 0, 4, 'normal', 0), hit('b', 0, 4, 'normal', 5)]);
    eq(r.resolved[0].rule.ruleId, 'b', 'priority 大者胜');
  });

  await test('★ 完全重叠：结果确定（同一输入多次裁决结果一致 → 重建不闪烁）', () => {
    const mk = () => [hit('x', 0, 5), hit('y', 0, 5), hit('z', 0, 5)];
    const a = A.resolve(mk()).resolved.map(h => h.rule.ruleId).join(',');
    const b = A.resolve(mk()).resolved.map(h => h.rule.ruleId).join(',');
    eq(a, b);
    eq(a, 'x', 'kwId 字典序最小者胜');
  });

  await test('相邻不重叠（end == start）不算冲突', () => {
    const r = A.resolve([hit('a', 0, 3), hit('b', 3, 6)]);
    eq(r.resolved.length, 2);
  });

  await test('不同文本节点之间永不冲突', () => {
    const h1 = hit('a', 0, 10); const h2 = hit('b', 0, 10);
    h2.node = {};                       // 不同 node 引用
    const r = A.resolve([h1, h2]);
    eq(r.resolved.length, 2);
  });

  await test('输入不被修改（纯函数）', () => {
    const input = [hit('a', 0, 3), hit('b', 0, 5)];
    const before = input.map(h => h.rule.ruleId).join(',');
    A.resolve(input);
    eq(input.map(h => h.rule.ruleId).join(','), before, '不得就地排序调用方的数组');
  });

  suite('arbiter · overlaps');

  await test('overlaps 判定：相交为真，相邻为假', () => {
    const a = { node: 'n', start: 0, end: 5 };
    const b = { node: 'n', start: 3, end: 8 };
    const c = { node: 'n', start: 5, end: 9 };
    truthy(A.overlaps(a, b));
    falsy(A.overlaps(a, c));
  });

  suite('arbiter · 跨文本节点命中的重叠（v1.99.99.10）');

  /** 跨节点命中：`node/start/end` 只描述第一段，其余在 segments 里 */
  function xhit(ruleId, segs) {
    const first = segs[0], last = segs[segs.length - 1];
    return {
      rule: { ruleId: ruleId, kind: 'normal' },
      node: first.node, start: first.start, end: first.end,
      endNode: last.node, endOffset: last.end, segments: segs, crossNode: true, text: 'x'
    };
  }

  await test('★ 起点在不同节点、但视觉范围重叠 → 必须判为重叠（旧实现漏判 → 两段高亮叠涂）', () => {
    /* 装置：`审<span>核</span>不通过`
     *   「审核不」= A[0..1] + B[0..1] + C[0..1]   （起点在 A）
     *   「核不」  =            B[0..1] + C[0..1]   （起点在 B，与上一条不同节点）
     * 旧 `overlaps` 因 `a.node !== b.node` 直接返回 false → 两条都被渲染。 */
    const A1 = {}, B1 = {}, C1 = {};
    const long = xhit('long', [{ node: A1, start: 0, end: 1 }, { node: B1, start: 0, end: 1 }, { node: C1, start: 0, end: 1 }]);
    const short = xhit('short', [{ node: B1, start: 0, end: 1 }, { node: C1, start: 0, end: 1 }]);
    truthy(A.overlaps(long, short), '跨节点命中在 B/C 两段上是重叠的，必须判为冲突');
    const r = A.resolve([long, short]);
    eq(r.resolved.length, 1, '视觉重叠的命中只应渲染一条，实际 ' + r.resolved.length);
    eq(r.resolved[0].rule.ruleId, 'long', '长匹配优先（覆盖范围更长）');
    eq(r.shadowed.length, 1, '被覆盖的那条仍要登记（统计/聚合不丢数据）');
  });

  await test('跨节点命中与单节点命中重叠 → 也要判出来', () => {
    const A1 = {}, B1 = {};
    const cross = xhit('cross', [{ node: A1, start: 0, end: 1 }, { node: B1, start: 0, end: 2 }]);
    const single = { rule: { ruleId: 'single', kind: 'normal' }, node: B1, start: 0, end: 1, text: 'x' };
    truthy(A.overlaps(cross, single), '跨节点命中的第二段与单节点命中重叠');
    truthy(A.overlaps(single, cross), '参数顺序反过来也要成立');
    eq(A.resolve([cross, single]).resolved.length, 1);
  });

  await test('跨节点命中之间**确实不重叠**时 → 都保留（不得误判）', () => {
    const A1 = {}, B1 = {}, C1 = {};
    const h1 = xhit('a', [{ node: A1, start: 0, end: 2 }, { node: B1, start: 0, end: 1 }]);
    const h2 = xhit('b', [{ node: B1, start: 1, end: 3 }, { node: C1, start: 0, end: 2 }]);
    falsy(A.overlaps(h1, h2), 'B 段上是 [0,1) 与 [1,3)，相邻不重叠');
    eq(A.resolve([h1, h2]).resolved.length, 2);
  });

  await test('单节点命中的快速通道不受影响（同一节点相交才算冲突）', () => {
    const n1 = {}, n2 = {};
    falsy(A.overlaps({ node: n1, start: 0, end: 5 }, { node: n2, start: 0, end: 5 }));
    truthy(A.overlaps({ node: n1, start: 0, end: 5 }, { node: n1, start: 4, end: 9 }));
  });

  await test('spansOf：单节点 = 一段；跨节点 = 各段原样', () => {
    const n = {};
    eq(A.spansOf({ node: n, start: 1, end: 3 }).length, 1);
    const segs = [{ node: n, start: 0, end: 1 }, { node: {}, start: 0, end: 1 }];
    eq(A.spansOf({ node: n, start: 0, end: 1, segments: segs }).length, 2);
  });
};
