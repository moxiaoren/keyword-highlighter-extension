/* tests/specs/diag-selfcheck.test.js — 「为什么一个都没命中」自查（K57 / v1.99.99.26）
 * ----------------------------------------------------------------------------
 * 现场：用户在一张内部管理页上点 🩺 诊断，拿到的是
 *   `规则=100 命中=0 高亮组=0 / 观察器回调=3597 裁决=104 / 重建 34 次`
 * —— 说明"该重建的时候也重建了"，但**一条命中都没有**。此时"没有高亮"是必然结果，
 * 真正要回答的是：**为什么 0 命中**？三种可能，修法完全不同：
 *   ① 词就在**可见文本**里却没命中 → 匹配/定位的问题（真 bug）；
 *   ② 词只出现在**不可见**内容里（textContent 有、innerText 无）→ 折叠/未激活，扫描按可见性剪枝，正常；
 *   ③ 词在**这一层文档**里根本没有 → 内容在 iframe / 图片 / 画布 / 影子根 / 还没渲染。
 * 本文件锁死：扫描体检计数（②③的判据来源）+ 自查判读（①②③各一条）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

const rulePlain = (src) => ({ pattern: new RegExp(src, 'g'), labelPattern: null, flags: {}, meta: {} });

/** 造一个带文本的子容器（垫片的 `el(tag, attrs, children)` 不收纯文本，用 innerHTML 更直观） */
function boxWith(html, hidden) {
  const d = H.el('div');
  d.innerHTML = html;
  if (hidden) d.setAttribute('hidden', '');
  return d;
}
function drop(node) {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');

  /** 替身化规则表 / 命中表，跑完还原（单测共用同一份内核实例） */
  function withRules(rules, hits, fn) {
    const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
    const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
    Object.defineProperty(KH, 'rules', { value: rules, configurable: true });
    if (hits !== undefined) Object.defineProperty(KH, 'registry', { value: { all: () => [], size: hits }, configurable: true });
    try { return fn(); } finally {
      if (dRules) Object.defineProperty(KH, 'rules', dRules);
      if (dReg) Object.defineProperty(KH, 'registry', dReg);
    }
  }

  suite('诊断自查：命中为 0 时到底卡在哪一层（K57）');

  await test('★ 扫描体检：不可见子树要记一笔、可见命中数如实、规则数如实（②③的判据来源）', () => {
    const rules = KH.Compiler.compileAll({ groups: [], keywords: [{ id: 'k1', text: '华为', enabled: true }] });
    eq(rules.length, 1, '前置：应编译出 1 条规则');

    const box = H.el('div');
    const vis = boxWith('审核 华为 通过');
    const hid = boxWith('隐藏 华为 通过', true);   // 垫片没有 getComputedStyle/checkVisibility，`hidden` 属性就是"不渲染"的口径
    box.appendChild(vis);
    box.appendChild(hid);

    const hits = KH.Scanner.scan(box, rules);
    eq(hits.length, 1, '只应命中可见那一段（隐藏子树被剪掉）');
    truthy(KH.Scanner._lastScan, '扫描必须留下体检计数（诊断要用）');
    eq(KH.Scanner._lastScan.hits, 1, '体检里的命中数要与返回的命中数一致');
    eq(KH.Scanner._lastScan.rules, 1, '体检要记下这次扫了几条规则');
    truthy(KH.Scanner._lastScan.textNodes >= 1, '可见文本节点要被计数');
    truthy(KH.Scanner._lastScan.prunedInvisible >= 1, '不可见子树被剪掉时必须计数 —— 这正是"命中为 0"最常见的那个原因');
    truthy(KH.Scanner._lastScan.ms >= 0, '体检要带耗时');
  });

  await test('★ 判读①：词就在**可见文本**里却没命中 → 必须报"匹配/定位问题"，不能说"词不在页面上"', () => {
    document.body.innerText = '审核状态 不通过';            // 只有可见文本（垫片没有 innerText，这里手动给）
    const box = boxWith('审核状态 不通过');
    document.body.appendChild(box);
    try {
      withRules([rulePlain('不通过')], 0, () => {
        const sc = KH.selfCheck();
        eq(sc.words[0].word, '不通过', '逐词自查要能取出规则的字面词');
        truthy(sc.words[0].inInner > 0, '这个词在可见文本里（诊断必须看得见这一点）');
        truthy(sc.verdict.indexOf('匹配') >= 0, '结论应为"匹配/定位问题"，实际：' + sc.verdict);
        eq(sc.verdict.indexOf('不可见'), -1, '不能误报成"词只在不可见内容里"');
      });
    } finally { drop(box); delete document.body.innerText; }
  });

  await test('★ 判读②：词只在**不可见**内容里（textContent 有、innerText 无）→ 报"折叠/未激活，属正常"', () => {
    document.body.innerText = '审核状态 通过';              // 可见文本里**没有**"驳回原因"
    const box = boxWith('驳回原因 材料不全', true);
    document.body.appendChild(box);
    try {
      withRules([rulePlain('驳回原因')], 0, () => {
        const sc = KH.selfCheck();
        eq(sc.words[0].inText > 0, true, '这个词在含隐藏的文本里（textContent）');
        eq(sc.words[0].inInner, 0, '可见文本里没有它');
        truthy(sc.verdict.indexOf('不可见') >= 0, '结论应为"词只在不可见内容里"，实际：' + sc.verdict);
      });
    } finally { drop(box); delete document.body.innerText; }
  });

  await test('★ 判读③：本层文档里一个规则词都没有 → 必须指向 iframe / 图片 / 画布 / 影子根 / 还没渲染', () => {
    document.body.innerText = '审核状态 通过';
    withRules([rulePlain('这个词页面上绝对没有')], 0, () => {
      const sc = KH.selfCheck();
      eq(sc.words[0].inText, 0, '这个词在两个口径里都不该出现');
      truthy(sc.verdict.indexOf('本层文档里一个规则词都没有') >= 0, '结论应指出"词不在这一层文档里"，实际：' + sc.verdict);
      truthy(sc.verdict.indexOf('影子根') >= 0 || sc.verdict.indexOf('iframe') >= 0 || sc.verdict.indexOf('画布') >= 0,
        '结论要给出下一步去看哪里（iframe/图片/画布/影子根/未渲染）');
    });
    delete document.body.innerText;
  });

  await test('★ 有命中时不得说"一个都没命中"（自查自己不能误导）', () => {
    withRules([rulePlain('不通过')], 3, () => {
      const sc = KH.selfCheck();
      truthy(sc.verdict.indexOf('有命中') >= 0, '命中>0 时结论应先说明有命中，实际：' + sc.verdict);
      eq(sc.verdict.indexOf('一个规则词都没有'), -1, '不能同时给出"词不在页面上"的结论');
    });
  });

  await test('★ 脏规则不许把自查搞崩（null / 无 pattern / 拿不到字面词的正则）', () => {
    withRules([null, {}, { pattern: null }, { pattern: /安.*车主|好.*车主/g }], 0, () => {
      const sc = KH.selfCheck();                       // 不抛异常即可
      truthy(typeof sc.verdict === 'string' && sc.verdict.length > 0, '即使规则表很脏也要给出结论');
      eq(sc.words.length, 0, '拿不到字面词的规则不进逐词表');
      truthy(sc.noLiteral >= 1, '拿不到字面词的规则要如实计数（正则多分支/罕见字逐字判定）');
    });
  });

  /* ------------------------------------------------------------------
   * 下面三条是"词不在文本节点里"的三种通道 —— 真机上最容易被误判成"没渲染/影子根"的三处。
   * ------------------------------------------------------------------ */

  await test('★ 判读④：词在**表单控件的值**里 → 必须报"表单控件的值"，不许赖给影子根/没渲染', () => {
    document.body.innerText = '审核状态';                  // 可见文本里**没有**"不通过"
    const box = boxWith('');
    const inp = H.el('input');
    inp.value = '不通过';                                  // 垫片没有原生 value，直接给属性（自查只读 el.value）
    box.appendChild(inp);
    document.body.appendChild(box);
    try {
      withRules([rulePlain('不通过')], 0, () => {
        const sc = KH.selfCheck();
        eq(sc.words[0].inInner, 0, '可见文本里没有它');
        truthy(sc.words[0].inForm > 0, '必须能从表单控件的 value 里找到它');
        truthy(sc.verdict.indexOf('表单控件') >= 0, '结论应指向表单控件的值，实际：' + sc.verdict);
      });
    } finally { drop(box); delete document.body.innerText; }
  });

  await test('★ 判读⑤：词只在**属性**（title/placeholder/aria-label/alt）里 → 必须如实说清', () => {
    document.body.innerText = '审核状态';
    const box = boxWith('');
    const cell = H.el('span');
    cell.setAttribute('title', '不通过');
    box.appendChild(cell);
    document.body.appendChild(box);
    try {
      withRules([rulePlain('不通过')], 0, () => {
        const sc = KH.selfCheck();
        truthy(sc.words[0].inAttr > 0, '必须能从属性里找到它');
        truthy(sc.verdict.indexOf('属性') >= 0, '结论应指向"只出现在属性里"，实际：' + sc.verdict);
      });
    } finally { drop(box); delete document.body.innerText; }
  });

  await test('★ 判读⑥：词只在**可编辑区**或**开放影子根**里 → 必须分别指出（不是"没渲染"）', () => {
    document.body.innerText = '审核状态 不通过';            // 真机上可编辑区的文字**也**算可见文本
    const editBox = boxWith('不通过');
    editBox.isContentEditable = true;
    const host = H.el('div');
    host.shadowRoot = { textContent: '驳回原因' };
    document.body.appendChild(editBox);
    document.body.appendChild(host);
    try {
      withRules([rulePlain('不通过')], 0, () => {
        const sc = KH.selfCheck();
        truthy(sc.words[0].inEditable > 0, '必须能从可编辑区里找到它');
        truthy(sc.verdict.indexOf('可编辑') >= 0,
          '可见文本里全都是可编辑区的内容 → 结论应指出"扫描跳过可编辑区"，实际：' + sc.verdict);
      });
      withRules([rulePlain('驳回原因')], 0, () => {
        const sc = KH.selfCheck();
        eq(sc.words[0].inText, 0, '影子根里的文本不在 light DOM 的 textContent 里');
        truthy(sc.words[0].inShadow > 0, '必须能从开放影子根里找到它');
        truthy(sc.verdict.indexOf('影子根') >= 0, '结论应指出影子根，实际：' + sc.verdict);
      });
    } finally { drop(editBox); drop(host); delete document.body.innerText; }
  });

  await test('★ 组合词定位体检：标题格命中、右格却没核心词 → 必须记成"定位失败"（不是无声无息）', () => {
    const mk = (right) => {
      const table = H.el('table');
      const tr = H.el('tr');
      const a = H.el('td'); a.innerHTML = '审核状态';
      const b = H.el('td'); b.innerHTML = right;
      tr.appendChild(a); tr.appendChild(b); table.appendChild(tr);
      return table;
    };
    /* `probe` 字段必须有：内核的普通文本 Probe 只在 `!rule.probe` 时接管，
     * 真实组合词规则正是靠这个字段声明"由我来扫"（否则会退化成整页扫核心词）。 */
    const comboRule = {
      kind: 'combo-lr', probe: 'combo-lr', pattern: /不通过/g, labelPattern: /审核状态/g,
      flags: {}, labelFlags: {}, meta: {}
    };

    const ctx1 = {};
    const hits1 = KH.Scanner.scan(mk('通过'), [comboRule], { ctx: ctx1 });
    eq(hits1.length, 0, '右格是「通过」→ 不该命中');
    truthy(ctx1._comboStat, '组合词定位体检必须留下计数');
    truthy(ctx1._comboStat.labeled >= 1, '标题格「审核状态」应被判为命中');
    eq(ctx1._comboStat.withCore, 0, '右格没有核心词');
    truthy(ctx1._comboStat.labeledButNoCore >= 1, '必须记成"标题命中但右格没核心词" —— 这正是定位失败的现场');

    const ctx2 = {};
    const hits2 = KH.Scanner.scan(mk('不通过'), [comboRule], { ctx: ctx2 });
    eq(hits2.length, 1, '右格就是核心词 → 必须命中（体检不许改变行为）');
    truthy(ctx2._comboStat.withCore >= 1, '定位成功也要计数（用于区分"定位失败"和"下游失败"）');
    eq(ctx2._comboStat.labeledButNoCore, 0, '定位成功时不该记失败');
  });

  await test('★ 命中明细：能说清"哪条规则命中了几次、还有几条一次都没命中"（K59）', () => {
    document.body.innerText = '审核状态 不通过';
    const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
    Object.defineProperty(KH, 'registry', {
      value: { size: 3, all: () => [{ ruleId: 'k1' }, { ruleId: 'k1' }, { ruleId: 'k1' }] },
      configurable: true
    });
    try {
      withRules([{ ruleId: 'k1', pattern: /不通过/g }, { ruleId: 'k2', pattern: /驳回原因/g }], undefined, () => {
        const sc = KH.selfCheck();
        eq(sc.ruleHits.length, 1, '只有 k1 有命中');
        eq(sc.ruleHits[0].word, '不通过', '命中明细要能显示规则的字面词');
        eq(sc.ruleHits[0].hits, 3, '命中次数要如实');
        eq(sc.rulesWithHits, 1);
        eq(sc.rulesWithoutHits, 1, 'k2 一次都没命中 —— 用户说"某个格子不亮"时最需要知道这一条');
      });
    } finally { if (dReg) Object.defineProperty(KH, 'registry', dReg); }
  });

  await test('★ 组合词在命中明细里要带上标签词（否则"不通过"命中了哪条规则分不清）', () => {
    document.body.innerText = '审核状态 不通过';
    const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
    Object.defineProperty(KH, 'registry', {
      value: { size: 1, all: () => [{ ruleId: 'c1' }] },
      configurable: true
    });
    try {
      withRules([{ ruleId: 'c1', pattern: /不通过/g, labelPattern: /审核状态/g }], undefined, () => {
        const sc = KH.selfCheck();
        eq(sc.ruleHits[0].word, '不通过');
        eq(sc.ruleHits[0].label, '审核状态', '组合词必须同时给出核心词与标签词');
        eq(sc.ruleHits[0].hits, 1);
      });
    } finally { if (dReg) Object.defineProperty(KH, 'registry', dReg); }
  });

  await test('★ 组合词未命中现场：核心词在可见文本里却零命中 → 必须报出它所在格子的结构（K59）', () => {
    document.body.innerText = '审核状态 不通过';
    const box = boxWith('<table><tbody><tr><td>备注</td><td>不通过</td></tr></tbody></table>');
    document.body.appendChild(box);            // 同行里**没有**标签词「审核状态」→ 组合词定位必然失败
    const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
    Object.defineProperty(KH, 'registry', { value: { size: 0, all: () => [] }, configurable: true });
    try {
      withRules([{ ruleId: 'c1', pattern: /不通过/g, labelPattern: /审核状态/g }], undefined, () => {
        const sc = KH.selfCheck();
        eq(sc.comboTrace.length, 1, '核心词在可见文本里、却零命中 → 应当给出一条"定位现场"');
        eq(sc.comboTrace[0].word, '不通过');
        eq(sc.comboTrace[0].label, '审核状态');
        eq(sc.comboTrace[0].found, true, '可见文本里能找到这个词');
        eq(sc.comboTrace[0].tag, 'td', '要指出核心词所在格是什么标签');
        truthy(Array.isArray(sc.comboTrace[0].rowCells), '要列出同行各格（用来判断标签是不是在别的行/别处）');
        eq(sc.comboTrace[0].labelInCell, false, '这一格里没有标签词');
        eq(sc.comboTrace[0].labelInScope, false, '同一行里也没有标签词 —— 这正是"定位不到"的原因');
      });
    } finally {
      if (dReg) Object.defineProperty(KH, 'registry', dReg);
      drop(box); delete document.body.innerText;
    }
  });

  await test('★ 组合词未命中现场：有命中的规则不该被当成"未命中"来查（避免噪音）', () => {
    document.body.innerText = '审核状态 不通过';
    const box = boxWith('<table><tbody><tr><td>审核状态</td><td>不通过</td></tr></tbody></table>');
    document.body.appendChild(box);
    const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
    Object.defineProperty(KH, 'registry', { value: { size: 1, all: () => [{ ruleId: 'c1' }] }, configurable: true });
    try {
      withRules([{ ruleId: 'c1', pattern: /不通过/g, labelPattern: /审核状态/g }], undefined, () => {
        const sc = KH.selfCheck();
        eq(sc.comboTrace.length, 0, '这条组合词已经命中了 → 不该出现在"未命中现场"里');
        eq(sc.rulesWithHits, 1);
        eq(sc.rulesWithoutHits, 0);
      });
    } finally {
      if (dReg) Object.defineProperty(KH, 'registry', dReg);
      drop(box); delete document.body.innerText;
    }
  });
};
