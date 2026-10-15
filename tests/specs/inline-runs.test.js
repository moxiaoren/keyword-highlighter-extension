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

  /* ============================================================================
   * 2.0.2.5 需求③：**零宽断言只定位、不消耗**（用户拍板口径 A）
   * ----------------------------------------------------------------------------
   * 用户实测：左右格词核心写 `^(?=.*夜)(?=.*播放).*`、页面内容是「清享夜私播放器」时，
   * 高亮的是**整段**「清享夜私播放器」——因为 `.*` 是消耗字符的，两条断言只做了门控。
   * 新口径：**当且仅当**（① 源码含正向零宽断言 `(?=…)`/`(?<=…)`）**且**
   * （② 整体匹配恰好吃光整段文本：`m.index===0 && m[0].length===文本长度`）时，
   * 才把上报区间收窄为"正向断言圈定的区间"（各参与区间的最小 start / 最大 end）。
   * 其余一切情况必须**逐字节不变**（这里是"不许误伤"的反向锁）。
   *
   * 两条路径（单节点 `matchIn` / 跨节点 `matchInlineRuns`）走**同一份**收窄实现 ——
   * 跨节点那条的"整段文本"＝ run 的拼接文本。
   * ========================================================================== */
  suite('zero-width · 零宽断言只定位不消耗（2.0.2.5 需求③ 口径 A）');

  const quiet = { util: { crossNodeBoundaryIsWord: () => false } };
  const hitOf = (pat, node) => U.matchIn(pat, node, quiet, {});
  const USER_RE = /^(?=.*夜)(?=.*播放).*/;

  await test('★ 用户原例：「清享夜私播放器」→ 只亮「夜私播放」（不是整段）', () => {
    const hits = hitOf(USER_RE, H.txt('清享夜私播放器'));
    eq(hits.length, 1, '应命中一条');
    eq(hits[0].start, 2, 'start 应收窄到「夜」的位置 2');
    eq(hits[0].end, 6, 'end 应收窄到「播放」之后 6');
    eq(hits[0].text, '夜私播放', 'text 必须同步切成收窄后的子串（面板/表格拿它当命中文本）');
  });

  await test('★ 同一模式于「夜私播放器」→ start=0,end=4', () => {
    const hits = hitOf(USER_RE, H.txt('夜私播放器'));
    eq(hits.length, 1);
    eq(hits[0].start, 0);
    eq(hits[0].end, 4);
    eq(hits[0].text, '夜私播放');
  });

  await test('★ 无断言的正则逐字节不变（不吃光 / 吃光两种都不许动）', () => {
    const hits = hitOf(/夜.*播放/, H.txt('清享夜私播放器'));
    eq(hits.length, 1);
    eq(hits[0].start, 2, '没有断言 → 区间必须是正则自己给的 [2,6)');
    eq(hits[0].end, 6);
    eq(hits[0].text, '夜私播放', '不得因为文本里含「夜/播放」被二次收窄');
    const whole = hitOf(/.*/, H.txt('清享夜私播放器'));
    eq(whole.length, 1);
    eq(whole[0].start, 0); eq(whole[0].end, 7); eq(whole[0].text, '清享夜私播放器',
      '整体匹配吃光整段、但源码无断言 → 仍不许动');
  });

  await test('★ 断言存在但整体匹配没吃光整段文本 → 不收窄', () => {
    const a = hitOf(/夜(?=私)/, H.txt('清享夜私播放器'));
    eq(a.length, 1);
    eq(a[0].start, 2, 'm.index!==0 → 保持原区间（断言圈定的 [3,4) 不得夺权）');
    eq(a[0].end, 3); eq(a[0].text, '夜');
    const b = hitOf(/播放(?=器)/, H.txt('清享夜私播放器'));
    eq(b.length, 1);
    eq(b[0].start, 4, '整体匹配没到文本末尾（长度 2 ≠ 7）→ 保持原区间');
    eq(b[0].end, 6); eq(b[0].text, '播放');
  });

  await test('★ 负向断言只做门控、不参与区间（命中的「夜」也不许圈定）', () => {
    const hits = hitOf(/^(?!夜)(?=.*播放).*/, H.txt('清享夜私播放器'));
    eq(hits.length, 1);
    eq(hits[0].start, 4, '只有正向 (?=.*播放) 参与 → [4,6)');
    eq(hits[0].end, 6);
    eq(hits[0].text, '播放', '负向断言 (?!夜) 的内容「夜」命中第 2 位，也不得把 start 拉到 2');
  });

  await test('★ 正向后顾断言 (?<=…) 同样参与圈定', () => {
    /* 整体匹配吃光整段（`^清享夜私播放器`），结尾的 (?<=播放器) 在位置 7 成立 → 圈定 [4,7) */
    const hits = hitOf(/^清享夜私播放器(?<=播放器)/, H.txt('清享夜私播放器'));
    eq(hits.length, 1);
    eq(hits[0].start, 4); eq(hits[0].end, 7);
    eq(hits[0].text, '播放器', '后顾断言的内容也是"定位"，必须参与区间');
  });

  await test('★ 断言内容非法 → 不抛异常且保持原区间', () => {
    /* 这类源码**整体编译不过**（`/(?=[)/ ` = Unterminated character class），真机上根本到不了
     * 收窄这一步；这里直接喂给共用原语，锁"收窄自身绝不抛、算不出就原区间"这条底线。 */
    eq(U.assertionRange({ source: '^(?=[).*', flags: 'g' }, '清享夜私播放器', 0, 7), null,
      '字符类没闭合（`(?=[`）→ 该断言不参与');
    eq(U.assertionRange({ source: '(?=*)', flags: 'g' }, 'abc', 0, 3), null,
      '编译抛错的断言内容（`*`）→ 捕获后不参与，绝不抛');
    eq(U.assertionRange({ source: '(?=^)', flags: 'g' }, 'abc', 0, 3), null,
      '剥完锚点后为空的断言 → 不参与');
    eq(U.assertionRange({ source: '(?=b)', flags: 'g' }, 'abc', 0, 2), null,
      '断言命中但整体匹配没吃光文本（mEnd 2 ≠ 3）→ 原区间');
  });

  await test('★ 全词守卫按「收窄前」的整体匹配区间判定（收窄只影响上报区间）', () => {
    const seen = [];
    const ctx = { util: { crossNodeBoundaryIsWord: (n, s, e) => { seen.push([s, e]); return true; } } };
    const hits = U.matchIn(USER_RE, H.txt('清享夜私播放器'), ctx, { wholeWord: true });
    eq(hits.length, 0, '守卫拒绝 → 该命中不得上报');
    eq(JSON.stringify(seen[0]), JSON.stringify([0, 7]), '守卫拿到的必须是收窄前的整体匹配区间 [0,7)');
  });

  await test('★ 跨节点（matchInlineRuns）走同一份收窄：收窄后仍跨两段', () => {
    const p = H.el('p', null, ['清享夜', H.el('span', null, ['私播放器'])]);
    const root = H.el('div', null, [p]);
    const hits = U.matchInlineRuns(nodesOf(root), re('^(?=.*夜)(?=.*播放).*'));
    eq(hits.length, 1, '应命中一条跨节点命中');
    const h = hits[0];
    eq(h.text, '夜私播放', 'text 应是收窄后的子串（"整段文本"＝ run 的拼接文本）');
    eq(h.node.nodeValue, '清享夜'); eq(h.start, 2); eq(h.end, 3);
    eq(h.endNode.nodeValue, '私播放器'); eq(h.endOffset, 3);
    eq(h.segments.length, 2, '收窄后的区间仍跨两段 → 两段都要建索引');
  });

  await test('★ 跨节点无断言 → 逐字节不变（整段拼接文本）', () => {
    const p = H.el('p', null, ['清享', H.el('span', null, ['夜私播放器'])]);
    const root = H.el('div', null, [p]);
    const hits = U.matchInlineRuns(nodesOf(root), re('.*播放器'));   // 吃光整个 run 文本
    eq(hits.length, 1);
    eq(hits[0].text, '清享夜私播放器', '没有断言 → 不许收窄');
    eq(hits[0].segments.length, 2);
  });

  await test('收窄后只覆盖单段 → 跨节点这条路不产出（交给逐节点路径，避免双计数）', () => {
    const p = H.el('p', null, ['清享', H.el('span', null, ['夜私播放器'])]);
    const root = H.el('div', null, [p]);
    eq(U.matchInlineRuns(nodesOf(root), re('^(?=.*夜)(?=.*播放).*')).length, 0,
      '收窄后落在第二段内 → 按原样跳过（segs<2），由逐节点路径给同一条命中');
    const one = hitOf(USER_RE, nodesOf(root)[1]);
    eq(one.length, 1);
    eq(one[0].text, '夜私播放', '逐节点路径对同一模式也收窄，两条路径口径一致');
  });

  await test('★ 2.0.2.5 · 独立验收 H2：收窄后落回单节点、而逐节点路径给不出 ⇒ 命中不许消失', () => {
    /* 运行语境里的 `^清享` + 断言：run 上匹配吃光整段、收窄成 `播放`（只落在第二段），
     * 而逐节点路在第二段上缺 `清享`、在第一段上缺 `播放` ⇒ 两条路都给不出，
     * 旧实现（`segs<2 → continue`）下这条命中**整条消失**。 */
    const p = H.el('p', null, ['清享', H.el('span', null, ['夜私播放器'])]);
    const root = H.el('div', null, [p]);
    const pat = re('^清享(?=.*播放).*');
    const ns = nodesOf(root);
    eq(U.matchInlineRuns(ns, pat).length, 0, '跨节点清单里仍不放单节点命中（函数契约不变）');
    const got = KH.Scanner.util.matchKeyword(ns, pat, { util: { crossNodeBoundaryIsWord: () => false } }, {});
    eq(got.cross.length, 0);
    eq(got.single.length, 1, '回收进单节点命中，实际 ' + JSON.stringify(got.single.map((s) => s.text)));
    eq(got.single[0].node.nodeValue, '夜私播放器');
    eq(got.single[0].start + ':' + got.single[0].end, '2:4',
      '段内偏移：run 里 [4,6)（"播放"）换算到第二段（run 偏移 2 起）= [2,4)');
    eq(got.single[0].text, '播放', '范围 = 断言圈定的区间');
  });

  await test('★ H2 不双计数：逐节点路径已给出同一条 ⇒ 回收的命中必须被丢掉', () => {
    const p = H.el('p', null, ['清享', H.el('span', null, ['夜私播放器'])]);
    const root = H.el('div', null, [p]);
    const got = KH.Scanner.util.matchKeyword(
      nodesOf(root), re('^(?=.*夜)(?=.*播放).*'),
      { util: { crossNodeBoundaryIsWord: () => false } }, {});
    eq(got.single.length, 1, '用户原例：只许有一条（逐节点给 [0,4) 的"夜私播放"，回收的同区间被去重）');
    eq(got.single[0].text, '夜私播放');
  });
};
