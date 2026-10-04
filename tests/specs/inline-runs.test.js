/* tests/specs/inline-runs.test.js — 跨文本节点：run 归并 + 区间映射（内核原语）
 * ----------------------------------------------------------------------------
 * 回归背景（v1.99.99.8 用户实测缺陷）：
 *   页面为了给半个词上色，会把一个词拆成多个文本节点 ——
 *   `<span title="风险" style="color:red">来遇</span>见你`。
 *   普通关键词走内核的「跨节点 run 扫描」，能命中；**组合词**却漏，
 *   用户看到的是"同一个词，普通规则亮了、组合规则不亮"。
 *
 * 修复方式：把 run 归并 / 区间映射提成内核原语（`Scanner.util.buildInlineRuns` /
 * `matchInlineRuns`），内核与组合词 Probe **共用同一份口径**（防止两边再次走偏）。
 * 这里锁的就是这份口径本身（纯逻辑、毫秒级）；行为层由 `_e2e` 的
 * `fixtures/combo-xnode.html`（组 8b）覆盖。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, el } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const U = KH.Scanner.util;

  const nodesOf = (root) => U.textNodesIn(root);
  const re = (s) => new RegExp(s, 'g');

  suite('inline-runs · 跨节点 run 归并（普通词与组合词共用同一份口径）');

  await test('行内元素两侧的文本归成一个 run；块级元素之间绝不串', () => {
    const p1 = el('p', null, ['审核', H.el('span', null, ['不通过'])]);
    const p2 = H.el('p', null, ['来遇']);
    const p3 = H.el('p', null, ['见你']);
    const root = H.el('div', null, [p1, p2, p3]);
    const texts = U.buildInlineRuns(nodesOf(root)).map((r) => r.text);
    console.log('        runs = ' + JSON.stringify(texts));
    truthy(texts.indexOf('审核不通过') >= 0, '行内 <span> 两侧应归成一 run，实际 ' + JSON.stringify(texts));
    eq(texts.indexOf('来遇见你'), -1, '块级 <p> 之间不得串成 run（串起来就是过度命中）');
  });

  await test('空行内元素不切断 run（`审核<span></span>不通过` 仍是一个词）', () => {
    const p = H.el('p', null, ['审核', H.el('span', null, ['']), H.el('span', null, ['不通过'])]);
    const root = H.el('div', null, [p]);
    const hits = U.matchInlineRuns(nodesOf(root), re('审核不通过'));
    eq(hits.length, 1, '空 span 视觉上不占位 → 不应被当成词边界');
  });

  await test('★ 区间映射：start/end 在首段，endNode/endOffset 在末段，segments 逐段给出', () => {
    const p = H.el('p', null, ['审核', H.el('span', null, ['不通过'])]);
    const root = H.el('div', null, [p]);
    const hits = U.matchInlineRuns(nodesOf(root), re('审核不通过'));
    eq(hits.length, 1, '应命中一条跨节点命中');
    const h = hits[0];
    eq(h.crossNode, true, '应标记 crossNode');
    eq(h.text, '审核不通过', 'text 应是整个词');
    eq(h.node.nodeValue, '审核', '起点应在第一段');
    eq(h.start, 0, 'start 应为 0');
    eq(h.end, 2, 'end 应是首段内的结束偏移（2）');
    eq(h.endNode.nodeValue, '不通过', '终点应在第二段');
    eq(h.endOffset, 3, 'endOffset 应是末段内的结束偏移（3）');
    eq(h.segments.length, 2, '应逐段给出 2 段（下游按段建索引，第二段才能点）');
  });

  await test('单节点就能匹配的 → 这里**不产出**（与逐节点路径双计数会重复命中）', () => {
    const root = H.el('div', null, [H.el('p', null, ['审核不通过'])]);
    eq(U.matchInlineRuns(nodesOf(root), re('审核不通过')).length, 0, '单节点命中一律交给 node-regex');
  });

  await test('★ within 限定：不许跨出给定范围（组合词核心只在本格判定）', () => {
    const a = H.el('span', null, ['来遇']);
    const b = H.el('span', null, ['见你']);
    const outer = H.el('span', null, [a, b]);
    const all = nodesOf(outer);
    eq(U.matchInlineRuns(all, re('来遇见你')).length, 1, '不设限：行内相邻 → 应跨节点命中');
    eq(U.matchInlineRuns(all, re('来遇见你'), { within: a }).length, 0,
      'within=a：第二个节点在范围外 → 绝不许拼成一个词（否则核心词会跨出定位到的单元格）');
  });

  await test('`textNodesIn` 仍是"格内文本节点"的取法（组合词依赖它给 run 喂节点）', () => {
    const cell = H.el('td', null, ['软件介绍', H.el('span', null, ['来遇']), '见你']);
    eq(nodesOf(cell).length, 3, '应取到 3 个文本节点，实际 ' + nodesOf(cell).length);
    eq(nodesOf(cell).map((n) => n.nodeValue).join('|'), '软件介绍|来遇|见你');
  });
  await test('★ 多分支正则（`安.*车主|好.*车主`）：第二/第三个分支也必须命中（字面前缀预筛不得误杀）', () => {
    /* 用户实测：组合词核心写 `安.*车主|好.*车主|平.*车主` 时"多个不生效"。根因是字面前缀预筛
     * 取了 `安` 当"必须出现"的前缀 —— 命中第二/第三分支的文本不含 `安`，于是被挡在正则之前。 */
    const U = nodesOf ? null : null;   // 占位（下面直接用 matchIn，避免依赖外层变量）
    const root = H.el('div', null, [
      H.el('p', null, ['安装车主']),
      H.el('p', null, ['好牌车主']),
      H.el('p', null, ['平台车主'])
    ]);
    const pat = /安.*车主|好.*车主|平.*车主/g;
    const ctx = { util: { crossNodeBoundaryIsWord: () => false } };
    const got = [];
    for (const n of nodesOf(root)) {
      for (const m of U === null ? require('../bootstrap').KH.Scanner.util.matchIn(pat, n, ctx, {}) : []) got.push(m.text);
    }
    console.log('        多分支命中 = ' + JSON.stringify(got));
    eq(got.length, 3, '三个分支各应命中一次，实际 ' + JSON.stringify(got));
  });

  suite('scan-nodes · 隐藏内容不参与扫描（V1.99.99.16）');

  /** 用 inline style 当 computed style 的桩（垫片没有 getComputedStyle）。
   *  `visibility` 是**继承**属性，所以这里按祖先链算 —— 桩不模拟继承的话，
   *  `visibility:hidden` 祖先里的无样式子元素会被误当成可见，测出来的是桩的错。 */
  const withStyleStub = (fn) => {
    const visOf = (e) => {
      for (let n = e; n; n = n.parentElement) {
        const s = (n.getAttribute && n.getAttribute('style')) || '';
        if (/visibility:\s*hidden/.test(s)) return 'hidden';
        if (/visibility:\s*visible/.test(s)) return 'visible';
      }
      return 'visible';
    };
    /* `display`：内联样式优先；没写就看 `hidden` 属性 —— 忠实模拟 UA 样式表里的 `[hidden]{display:none}`。
     * K76 起扫描剪枝读的是**计算样式**（`Scanner.util.renderState`），桩不模拟这条 UA 规则
     * 就会把"hidden 属性 ⇒ 整块跳过"测成**假红**（真浏览器里那本来就是 display:none）。 */
    const dispOf = (e) => {
      const s = (e.getAttribute && e.getAttribute('style')) || '';
      if (/display:\s*none/.test(s)) return 'none';
      if (/display:\s*[a-z-]+/.test(s)) return 'block';        // 页面用内联样式覆盖了 UA 的 [hidden]
      return (e.hasAttribute && e.hasAttribute('hidden')) ? 'none' : 'block';
    };
    global.getComputedStyle = (e) => {
      const s = (e.getAttribute && e.getAttribute('style')) || '';
      return {
        display: dispOf(e),
        visibility: visOf(e),
        contentVisibility: /content-visibility:\s*hidden/.test(s) ? 'hidden' : 'visible'
      };
    };
    try { return fn(); } finally { delete global.getComputedStyle; }
  };

  await test('★ 祖先 display:none 的文本不采集（隔两层也算）；可见的照旧', () => {
    const hidden = H.el('div', { style: 'display:none' });
    hidden.appendChild(H.el('div', null, [H.el('section', null, ['隐藏词'])]));
    const root = H.el('div', null, [hidden, H.el('p', null, ['正常词'])]);
    withStyleStub(() => {
      const nodes = nodesOf(root);
      console.log('        采集到 = ' + JSON.stringify(nodes.map((n) => n.nodeValue)));
      eq(nodes.length, 1, '只应采集可见那一条');
      eq(nodes[0].nodeValue, '正常词');
    });
  });

  await test('visibility:hidden 的元素文本不采集；同层可见的照旧', () => {
    /* 注：「visibility:hidden 祖先里、后代自己 visible 要能命中」这条只在**真浏览器**里测
     * （`_e2e` 组 8d 的 ⑥）—— 垫片的 computed style 是桩，测不出真实的继承/覆盖语义。 */
    const root = H.el('div', null, [
      H.el('p', { style: 'visibility:hidden' }, ['看不到']),
      H.el('p', null, ['看得到'])
    ]);
    withStyleStub(() => {
      const vals = nodesOf(root).map((n) => n.nodeValue);
      console.log('        采集到 = ' + JSON.stringify(vals));
      eq(vals.length, 1, '隐藏那条不该采集');
      eq(vals[0], '看得到');
    });
  });

  await test('hidden 属性 / content-visibility:hidden 也整块跳过', () => {
    const a = H.el('div', { hidden: '' });
    a.appendChild(H.txt('甲'));
    const b = H.el('div', { style: 'content-visibility:hidden' });
    b.appendChild(H.txt('乙'));
    const root = H.el('div', null, [a, b, H.el('p', null, ['丙'])]);
    withStyleStub(() => {
      const vals = nodesOf(root).map((n) => n.nodeValue);
      eq(JSON.stringify(vals), JSON.stringify(['丙']), '实际 ' + JSON.stringify(vals));
    });
  });
};
