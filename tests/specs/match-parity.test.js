/* tests/specs/match-parity.test.js — **普通词 vs 组合词：匹配结果必须逐字一致**
 * ----------------------------------------------------------------------------
 * 用户口径（2026-09，第二次强调）：
 *   "组合词只是在核心词上加一个定位的限制。处理逻辑应该统一，不要反复出现普通词能实现、
 *    组合词不行的问题，反之亦然。如果确实因为某些原因无法一致，请告知我原因让我决策。"
 *
 * 所以这里用**同一批装置**把同一个词跑两遍：
 *   · 普通词：整页文本节点上匹配；
 *   · 组合词：只在"标题格右侧那一格"里匹配（`cellVerify`）。
 * 除"范围"以外，命中结果必须**完全相同** —— 词文本 / 起点终点 / 是否跨节点 / 分段数 / 命中条数。
 * 任何一边多出或少掉一条，都说明又出现了第二套匹配实现。
 *
 * 这是**行为级**保证；静态红线（meta-check「匹配口径单源」）负责不让第二套实现再长出来，
 * 两者一正一反。真浏览器层的对应断言见 `_e2e` 组 8b。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, el } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;
  const S = KH.Scanner;

  const CFG = {
    keywords: [], groups: [],
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    matchSettings: {}
  };

  /** 建装置：`<table><tr><td>资质类型</td><td>核心</td></tr></table>`（组合词 lr 的真实结构） */
  function fixture(coreParts) {
    const labelCell = el('td', null, ['资质类型']);
    const coreCell = el('td', null, coreParts);
    const tr = el('tr', null, [labelCell, coreCell]);
    const tbody = el('tbody', null, [tr]);
    const table = el('table', null, [tbody]);
    table.tBodies = [tbody];
    return { root: el('div', null, [table]), coreCell: coreCell };
  }

  /** 命中 → 可比较的形状（只留"匹配结果"本身，去掉 rule 引用等无关物） */
  const shape = (h) => ({
    text: h.text,
    start: h.start,
    end: h.end,
    node: (h.node && h.node.nodeValue) || '',
    endNode: h.endNode ? h.endNode.nodeValue : null,
    endOffset: h.endOffset == null ? null : h.endOffset,
    cross: !!h.crossNode,
    segs: h.segments ? h.segments.length : 0
  });
  const shapes = (hits, id) => hits
    .filter((h) => h.rule && h.rule.ruleId === id)
    .map(shape)
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  const kwBase = (id, text, extra) => Object.assign({
    id: id, text: text, note: '', groupId: null, enabled: true,
    caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
    important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
    cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
    cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
    fetchLabels: ''
  }, extra || {});

  const span = (parts) => el('span', null, parts);
  const div = (parts) => el('div', null, parts);

  /* 用例：`core` = 关键词文本（配置里那个词）；`dom` = 右格里的实际结构 */
  const CASES = [
    { name: '① 单节点', core: '审核不通过', dom: ['审核不通过'], want: 1 },
    { name: '② 被 span 拆成两段', core: '审核不通过', dom: ['审核', span(['不通过'])], want: 1 },
    { name: '③ 拆成三段', core: '审核不通过', dom: ['审', span(['核']), '不通过'], want: 1 },
    { name: '④ 中间夹空 span', core: '审核不通过', dom: ['审核', span(['']), span(['不通过'])], want: 1 },
    { name: '⑤ 一格内出现两次', core: '审核不通过', dom: ['审核不通过 和 审核不通过'], want: 2 },
    { name: '⑥ 大小写不敏感', core: 'BUG', dom: ['bug'], want: 1 },
    { name: '⑦ 大小写敏感（应 0 条）', core: 'BUG', dom: ['bug'], flags: { caseSensitive: true }, want: 0 },
    { name: '⑧ 正则多分支', core: 'BUG|FEATURE', dom: ['bug FEATURE'], flags: { useRegex: true }, want: 2 },
    { name: '⑨ 全词·不该命中', core: 'BUG', dom: ['BUGS'], flags: { wholeWord: true }, want: 0 },
    { name: '⑩ 全词·应命中', core: 'BUG', dom: ['BUG ok'], flags: { wholeWord: true }, want: 1 },
    { name: '⑪ 跨节点 + 全词', core: 'BUG', dom: ['BU', span(['GS'])], flags: { wholeWord: true }, want: 0 },
    { name: '⑫ 反例·块级隔开（应 0 条）', core: '审核不通过', dom: [div(['审核']), div(['不通过'])], want: 0 }
  ];

  suite('match-parity · 普通词与组合词的匹配结果必须一致');

  for (const c of CASES) {
    await test('★ ' + c.name + '：普通词 / 组合词 命中完全一致（期望 ' + c.want + ' 条）', () => {
      const f = fixture(c.dom);
      const plain = C.dispatch(kwBase('P', c.core, c.flags), CFG);
      const combo = C.dispatch(kwBase('C', c.core, Object.assign({
        cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr'
      }, c.flags || {})), CFG);
      truthy(plain, c.name + '：普通词应能编译出规则');
      truthy(combo, c.name + '：组合词应能编译出规则');

      const hits = S.scan(f.root, [plain, combo]);
      const a = shapes(hits, 'P');
      const b = shapes(hits, 'C');
      console.log('        普通=' + JSON.stringify(a) + '\n        组合=' + JSON.stringify(b));
      eq(a.length, c.want, c.name + '：普通词命中条数');
      eq(b.length, c.want, c.name + '：组合词命中条数');
      eq(JSON.stringify(b), JSON.stringify(a),
        c.name + '：组合词与普通词的命中结果必须**逐字一致**（差异说明又出现了两套匹配实现）');
    });
  }

  await test('★ 组合词的"定位限制"确实生效（同词在别的格子里不命中 —— 这是唯一的差别）', () => {
    const labelCell = el('td', null, ['资质类型']);
    const coreCell = el('td', null, ['审核不通过']);
    const otherCell = el('td', null, ['审核不通过']);          // 另一格里的同一个词
    const tr1 = el('tr', null, [labelCell, coreCell]);
    const tr2 = el('tr', null, [el('td', null, ['别的标题']), otherCell]);
    const tbody = el('tbody', null, [tr1, tr2]);
    const table = el('table', null, [tbody]);
    table.tBodies = [tbody];
    const root = el('div', null, [table]);

    const plain = C.dispatch(kwBase('P2', '审核不通过'), CFG);
    const combo = C.dispatch(kwBase('C2', '审核不通过', { cellVerifyEnabled: true, cellVerify: '资质类型' }), CFG);
    const hits = S.scan(root, [plain, combo]);
    const a = shapes(hits, 'P2');
    const b = shapes(hits, 'C2');
    console.log('        普通=' + a.length + ' 条 / 组合=' + b.length + ' 条');
    eq(a.length, 2, '普通词：两格各一次 → 2 条');
    eq(b.length, 1, '组合词：只有"资质类型"右格那次 → 1 条（定位限制，不是匹配能力差异）');
    /* 命中的那一条本身必须与普通词完全一致（同文本、同形状） */
    truthy(a.some((x) => JSON.stringify(x) === JSON.stringify(b[0])),
      '组合词那条命中必须与普通词的同一次命中逐字一致');
  });

  await test('★ 罕见字核心：组合词与"整页罕见字规则"用的是同一份逐字判定', () => {
    /* 罕见字规则（kind: rare）整页逐字命中；作为组合核心时只在定位到的格子里判定。
     * 两边都走 `KH.RareChar.scanRare`（内核 matchKeyword 的 matchOne）。
     * `昉` / `谞` 是 e2e 装置 `rare-combo.html` 用的字，确认在字表里。 */
    const f = fixture(['昉谞']);
    const rarePlain = C.dispatch(kwBase('R', 'hjz#', { kind: 'rare' }), CFG);
    const rareCombo = C.dispatch(kwBase('RC', 'hjz#', {
      kind: 'rare', cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr'
    }), CFG);
    truthy(rarePlain && rareCombo, '罕见字（普通 / 组合）都应能编译');
    const hits = S.scan(f.root, [rarePlain, rareCombo]);
    const a = shapes(hits, 'R');
    const b = shapes(hits, 'RC');
    console.log('        整页罕见字=' + JSON.stringify(a) + '\n        组合罕见字=' + JSON.stringify(b));
    truthy(a.length >= 2, '整页罕见字应逐字命中（装置里有 2 个字）');
    eq(JSON.stringify(b), JSON.stringify(a), '同一格内的罕见字命中必须与整页判定完全一致');
  });
};
