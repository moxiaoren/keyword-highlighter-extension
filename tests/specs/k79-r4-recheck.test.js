/* tests/specs/k79-r4-recheck.test.js — K79「抓取层级口径重梳」的 **R4 独立复验（红队）**
 * ----------------------------------------------------------------------------
 * 与实现者自己的 `k79-fetch-layers.test.js` / `k74-*` **互不替代**：本文件的装置、判据、
 * 断言形状全部由 R4 另造，按用户 2026-09-23 口径**逐字**独立判一遍，并专打契约 §六
 * 「交给 R4 的拷打面」的四个面：
 *
 *   面①「内层＝当前层里任意单元格的嵌表」的**归属长尾**：
 *        · 嵌表在**命中行之外**（别的行 / 别的列）；
 *        · 嵌表**深度嵌套**（内层的内层）⇒ 一次全收，「内层/内2层」与表的层级**无关**；
 *        · 嵌表在 `<th>` 格里、在 `colspan` 格里；同一格里两张嵌表；
 *        · 锚点表里嵌表的**定义域**：嵌入的中间层表自己那层的标签**不算**锚点层的内层。
 *   面② `skipNestedTables` 的**误伤面**（值格自己的文字照旧算值、只有嵌表内容被排除）：
 *        · 「附件」格只有嵌表 ⇒ 该层无值（用户真正想要的图只能从「内层」方向读）；
 *        · 外层文字写在嵌表**前后** ⇒ 排掉内表后中间只剩一个换行；
 *        · 值格自己的 `<img>` 照旧算，嵌表里的图不算；
 *        · 值格只有嵌表 + 下一行还有别的字段 ⇒ **整块取值越界**（黄牌，已用 2.0.0.5 实测比对定性）。
 *   面③ 旧值兼容：`outer1`/`outermost` ≡ `outer` 的**逐字等价**（含多层顺序/去重/后缀）、
 *        `all` → `self+inner+outer`、`auto` 原样保留且**只取就近一层**、缺键/非法 → `auto`。
 *   面④ 组合词「仅抓取」锚在**标题格**时的层判定：与普通词（命中格）逐条对照；
 *        `cellVerify` 各方向（含 tb 轴的标题格锚点）；假表格（无真 `<table>`）路径不受分层影响。
 *
 * 反向验证（R4 自跑，2 轮；目标用例 = 本文件 `R4-0` 的 `缺键/非法 → auto` 两条）：
 *   · M1：`normalizeFetchScope` 的 `if (!picked.length) return 'auto';` → `return 'self';`
 *   · M2：`fetchScopeSpec` 的 `auto` 分支 `dirs: ['self','outer']` → `dirs: ['self']`
 *   两轮都只让本文件的目标用例变红（并附源码级哨兵），复原后 sha256 逐字节回原值。
 *
 * ★ 垫片差异（R4 独立核实，写装置时必须绕开）：
 *   ① 垫片**不提供** `HTMLTableElement.rows` / `HTMLTableRowElement.cells`（真浏览器有）
 *      ⇒ 装置必须自己按真实 DOM 口径补上：`rows` = 挂在本表里的 `tr`（`nearestTable(tr.parentNode) === t`）、
 *      `cells` = 本行**直接子** td/th。补完再取格，一律用 `._trs[i].cells[j]`。
 *   ② `textNodeIn(cell)` 是深度优先的：**当某一格里含嵌套表时，它可能落进嵌套表内部的文本**
 *      （尤其当内表排在该格自有文字之前）⇒ 锚点就跑到内层表去了、整条判定跟着错。
 *      所以锚点格要么不含嵌表，要么直接用 `{ cell: 该格 }` 喂给 `cellsForHit`
 *      （`textNodeIn` 只在"格子里没有嵌表"时用）。
 *   （已核实：用 `appendChild` 搭的装置**不会**把内表的 tr/td 挂进外层 tr，`tr.children` 就是真实口径；
 *   `querySelectorAll('tr')` 会包含内表的行 —— 那是正常的后代查询语义，不是垫片缺陷。）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 最近的真 `<table>` 祖先（含自身）——垫片没有表格作用域语义，自己走一遍 */
function nearestTableOf(el) {
  let n = el;
  while (n && n.nodeType === 1) {
    if (n.tagName === 'TABLE') return n;
    n = n.parentNode;
  }
  return null;
}

/** R4 自己的制表器：`{th, rs, cs, table, nodes, text}`；顺带补上垫片缺的表格访问器
 *  （`rows` / `cells` 见文件头"垫片差异"）。 */
function mkTable(rows, attrs) {
  const t = H.el('table', attrs || null);
  const tbody = H.el('tbody');
  t.appendChild(tbody);
  const trs = [];
  for (const cells of rows) {
    const tr = H.el('tr');
    for (const c of cells) {
      const td = H.el(c && c.th ? 'th' : 'td');
      if (c && c.rs) td.rowSpan = c.rs;
      if (c && c.cs) td.colSpan = c.cs;
      if (typeof c === 'string') td.appendChild(H.txt(c));
      else if (c && c.table) td.appendChild(c.table);
      else if (c && c.nodes) for (const n of c.nodes) td.appendChild(n);
      else if (c && c.text != null) td.appendChild(H.txt(c.text));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    trs.push(tr);
  }
  /* 真实 DOM 口径：本表的行 = 挂在**本表**里的 tr；本行的格 = 本行直接子 td/th。
   *  先规整**内层表**再规整本表（`querySelectorAll('table')` 是文档序、由浅到深）——
   *  否则本表的 `cells` 会被后一轮按内表覆写。 */
  const norm = (node) => {
    for (const tr of node.querySelectorAll('tr')) {
      tr.cells = [];
      for (const c of (tr.childNodes || [])) {
        if (c.nodeType === 1 && (c.tagName === 'TD' || c.tagName === 'TH')) tr.cells.push(c);
      }
    }
    node.rows = node.querySelectorAll('tr').filter((tr) => nearestTableOf(tr.parentNode) === node);
    node.rows.forEach((tr, ri) => { tr.rowIndex = ri; tr.cells.forEach((td, i) => { td.cellIndex = i; }); });
  };
  const inner2 = t.querySelectorAll('table').filter((x) => x !== t);
  for (let i = inner2.length - 1; i >= 0; i--) norm(inner2[i]);
  norm(t);
  t._trs = trs;
  return t;
}

/** 取该格里第一个非空文本节点（喂 `extractFor` / `cellsForHit`） */
function textNodeIn(cell) {
  const walk = (n) => {
    for (const c of (n.childNodes || [])) {
      if (c.nodeType === 3 && String(c.nodeValue || '').trim()) return c;
      if (c.nodeType === 1) { const got = walk(c); if (got) return got; }
    }
    return null;
  };
  return walk(cell);
}

/** `[[标签, 值], …]` → 一行一格的键值表（标签在左列、值在右列） */
const kv = (...pairs) => mkTable(pairs);

const flat = (list) => (list || []).map((f) => f.label + '=' + (f.rows || []).map((r) => r.map((c) => c.t).join('/')).join('|'));
const imgsOf = (list) => (list || []).map((f) => f.label + ':' + (f.imgs || []).map((i) => i.getAttribute('src')).join(','));
const labelsOf = (list) => (list || []).map((f) => f.label);

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;
  const C = KH.Config;
  const FM = KH.FieldMap;

  const L2 = '驳回原因|详情';
  const L3 = '驳回原因|备注|详情';

  /* ==================================================================
   * R4-0 · 归一层：旧值逐字等价 + 缺键/非法 → auto（**反向验证的目标用例**）
   * ================================================================== */
  suite('K79-R4 · R4-0 归一层：`outer1`/`outermost` ≡ `outer`、`all`、`auto`、缺键/非法');

  await test('★ R4-0a 合法值：三方向 7 个非空子集 + auto 逐字原样（写路径幂等）', () => {
    const canon = ['self', 'inner', 'outer', 'self+inner', 'self+outer', 'inner+outer', 'self+inner+outer'];
    for (const v of canon.concat(['auto'])) {
      eq(C.normalizeFetchScope(v), v, '规范值原样：' + v);
      eq(C.normalizeFetchScope(C.normalizeFetchScope(v)), v, '幂等：' + v);
    }
    eq(C.normalizeFetchScope('outer+self'), 'self+outer', '逆序输入 → 固定顺序');
    eq(C.normalizeFetchScope('inner+inner+outer'), 'inner+outer', '重复方向去重');
    eq(C.normalizeFetchScope('SELF+Inner'), 'self+inner', '大小写不敏感（历史脏值）');
    eq(C.normalizeFetchScope(['outer', 'self']), 'self+outer', '数组形态同样归一');
  });

  await test('★ R4-0b 旧值平移：`outer1`/`outermost` → `outer`（**不是** self+outer）、`all` → 三方向', () => {
    for (const old of ['outer1', 'outermost']) {
      eq(C.normalizeFetchScope(old), 'outer', '★ 旧「只取一层」的两个档位都并入 outer 方向（有意合并）');
      deepEq(C.fetchScopeSpec(old), { scope: 'outer', dirs: ['outer'], nearestOnly: false },
        '★ 旧档位**不许**退化成 nearestOnly（那是 auto 的语义）：' + old);
    }
    eq(C.normalizeFetchScope('all'), 'self+inner+outer');
    deepEq(C.fetchScopeSpec('all'), { scope: 'self+inner+outer', dirs: ['self', 'inner', 'outer'], nearestOnly: false });
    eq(C.normalizeFetchScope('self'), 'self', '旧 self 语义不变');
    eq(C.normalizeFetchScope('outermost+inner'), 'inner+outer', '旧值参与合并时同样去重');
  });

  await test('★ R4-0c `auto` 原样保留（不映射成 self+outer）：就近优先、只取一层', () => {
    eq(C.normalizeFetchScope('auto'), 'auto', '★ auto 是兼容值，必须原样留着');
    deepEq(C.fetchScopeSpec('auto'), { scope: 'auto', dirs: ['self', 'outer'], nearestOnly: true },
      '★ 只取就近一层的语义由 nearestOnly 承担');
    eq(C.normalizeFetchScope('auto+self'), 'auto', '★ auto 出现在任何位置都短路成 auto（旧行为：就近优先）');
    eq(C.normalizeFetchScope('Auto'), 'auto');
  });

  await test('★ R4-0d 缺键 / 空 / 全非法 → `auto`（**反向验证目标**），且 `self` 是新默认（由编辑器 def 承担）', () => {
    eq(C.normalizeFetchScope(undefined), 'auto', '★ 缺键 → auto（这个键 2.0.0.1 才加；缺键＝那时的配置，口径照旧）');
    eq(C.normalizeFetchScope(null), 'auto', 'null → auto');
    eq(C.normalizeFetchScope(''), 'auto', '空串 → auto');
    eq(C.normalizeFetchScope('   '), 'auto', '空白串 → auto');
    eq(C.normalizeFetchScope('bogus'), 'auto', '全非法 → auto');
    eq(C.normalizeFetchScope('+'), 'auto', '只有分隔符 → auto');
    eq(C.normalizeFetchScope('near'), 'auto', '从未存在过的档位名 → auto');
    deepEq(C.fetchScopeSpec(undefined), { scope: 'auto', dirs: ['self', 'outer'], nearestOnly: true });
    eq(C.FETCH_SCOPE_DEFAULT, 'self', '新默认常量 = 当前层');
    eq(FM.byKey('fetchScope').def(C.defaults), 'self', '★「默认＝当前层」落在编辑器字段默认值上');
    truthy(C.FETCH_SCOPES.indexOf('auto') >= 0, 'auto 必须在合法值表里（界面可选、导入不报错）');
  });

  await test('★ R4-0e 源码级哨兵：缺键→auto 与 auto 的 dirs 字面量各只有一处', () => {
    const cfg = readSrc(path.join('src', 'core', 'config.js'));
    truthy(/if \(!picked\.length\) return 'auto';/.test(cfg),
      '★ 归一处"缺键/空/全非法 → auto"的写法必须还在（改回 self 就是悄悄少抓外层字段）');
    truthy(/dirs: \['self', 'outer'\], nearestOnly: true/.test(cfg),
      '★ auto 的展开必须是 self+outer 且 nearestOnly（改一处就红）');
    truthy(/LEGACY_FETCH_SCOPES = \{ self: 'self', outer1: 'outer', outermost: 'outer', all: 'self\+inner\+outer' \}/.test(cfg),
      '★ 旧值映射表逐字（outer1/outermost 都 → outer）');
  });

  /* ==================================================================
   * R4-1 · 三方向独立判定（选择了某方向就必须排除别的方向的值）
   * ================================================================== */
  suite('K79-R4 · R4-1 三方向逐字独立（含"选了内层不含本层值"）');

  await test('★ R4-1a 三层装置：self / inner / outer 各自只看自己那一层', () => {
    const inner = kv(['驳回原因', '内层丙'], ['备注', '内层备注丙']);
    const outer = mkTable([
      ['命中格', '丙词', { table: inner }],
      ['驳回原因', '外层丙'],
      ['详情', '外层详情丙']
    ]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const self = flat(F.extractFor(hit, L3, 'self'));
    const inr = flat(F.extractFor(hit, L3, 'inner'));
    const out = flat(F.extractFor(hit, L3, 'outer'));
    console.log('        [R4-1a] self=' + JSON.stringify(self) + ' inner=' + JSON.stringify(inr) + ' outer=' + JSON.stringify(out));
    deepEq(self, ['驳回原因=外层丙', '详情=外层详情丙'],
      '★ 当前层＝命中格直接所在的那张表；「备注」只在内表里 ⇒ 当前层不许有它');
    deepEq(inr, ['驳回原因=内层丙', '备注=内层备注丙'],
      '★ 只勾内层 ⇒ 只抓比命中层**小**的表：本层的「外层丙 / 外层详情丙」一格都不许混进来');
    deepEq(out, self, '★ 这张表就是最外层（无祖先表）⇒ 空层回落当前层：与「只抓本层」逐字相同（不许变空）');
    deepEq(flat(F.extractFor(hit, L3, 'self+inner')),
      ['驳回原因（内层）=内层丙', '驳回原因（本层）=外层丙', '备注=内层备注丙', '详情=外层详情丙'],
      '★ 多选：**标签为主序**（同一标签的各层挨着，再轮到下一个标签）、同名异值加后缀、同标签内「内层 → 本层」');
    deepEq(flat(F.extractFor(hit, L3, 'inner+outer')), inr,
      '★ inner+outer（**没勾当前层**）：只有内层有值 ⇒ 只给内层那份；外层方向在这张最外层表上无可取层时' +
      '**不回落到当前层**（否则"没勾当前层却拿到当前层的值"，与"只勾内层不含本层值"自相矛盾）');
    truthy(inr.join('|').indexOf('外层丙') < 0, '★ 内层方向不许含本层的值');
    truthy(self.join('|').indexOf('内层丙') < 0, '★ 当前层方向不许含内层的值');
  });

  await test('★ R4-1b 外层方向没有祖先表 ⇒ **回落当前层**（K74"不许变空"的承诺）', () => {
    const inner = kv(['驳回原因', '内层丁']);
    const outer = kv(['驳回原因', '外层丁'], ['附件', { table: inner }]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const out = flat(F.extractFor(hit, '驳回原因', 'outer'));
    console.log('        [R4-1b] 只勾外层但无祖先表 = ' + JSON.stringify(out));
    deepEq(out, ['驳回原因=外层丁'],
      '★ 选了外层但这张表就是最外层 ⇒ 回落当前层（**值不加「（本层）」后缀**，单层是恒等变换）');
    eq(labelsOf(F.extractFor(hit, '驳回原因', 'outer')).join('|'), '驳回原因', '后缀不许凭空出现');
  });

  await test('★ R4-1c 有祖先表时：外层方向**只**给祖先层的值，且外2层按远近排序', () => {
    const inner = kv(['驳回原因', '内层戊']);
    const mid = kv(['驳回原因', '中层戊'], ['附件', { table: inner }], ['详情', '中层详情戊']);
    const top = kv(['驳回原因', '顶层戊'], ['附件', { table: mid }], ['详情', '顶层详情戊']);
    const hitMid = textNodeIn(mid._trs[0].cells[1]);
    eq(flat(F.extractFor(hitMid, '驳回原因', 'self')).join('|'), '驳回原因=中层戊', '当前层 = mid');
    deepEq(flat(F.extractFor(hitMid, '驳回原因', 'outer')), ['驳回原因=顶层戊'], '★ 外层 = 祖先表（近的先）');
    deepEq(flat(F.extractFor(hitMid, '驳回原因', 'inner')), ['驳回原因=内层戊'], '★ 内层 = mid 里的嵌表');
    const hitIn = textNodeIn(inner._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'outer')),
      ['驳回原因（外层）=中层戊', '驳回原因（外2层）=顶层戊'],
      '★ 外层方向含**多层**：同名异值 ⇒ 近的「外层」、远的「外2层」');
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'self')), ['驳回原因=内层戊'], '当前层 = inner');
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'inner')), ['驳回原因=内层戊'],
      '★ inner 是叶子表、没有嵌表 ⇒ 内层方向回落当前层（不变空）');
  });

  /* ==================================================================
   * R4-2 · 面①：归属长尾（跨行 / 深度 / th / colspan / 同格两张 / 定义域）
   * ================================================================== */
  suite('K79-R4 · R4-2 内层归属长尾（任意单元格嵌表）');

  await test('★ R4-2a 嵌表在**命中行之外**的行里，仍算内层（用户口径：任意单元格）', () => {
    const inner = kv(['驳回原因', '别的行的内层']);
    const outer = mkTable([
      ['命中格', '己词', '附件', '无'],
      ['驳回原因', '本层己'],
      ['详情', '本层详情己', { table: inner }]
    ]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hit, '驳回原因', 'inner')), ['驳回原因=别的行的内层'],
      '★ 内层不限定"命中行"：任意单元格（含命中行之外）的嵌表都算');
    deepEq(flat(F.extractFor(hit, '驳回原因', 'self')), ['驳回原因=本层己'], '同一次命中，当前层照旧只看本层');
  });

  await test('★ R4-2b 深度嵌套：锚点表的下钻深度**全部**算内层，后缀与表的实际深度无关', () => {
    const leaf = kv(['驳回原因', '叶层']);
    const deep = kv(['驳回原因', '深层'], ['附件', { table: leaf }]);
    const outer = mkTable([['命中格', '庚词', { table: deep }]]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const inr = flat(F.extractFor(hit, '驳回原因', 'inner'));
    console.log('        [R4-2b] 深度嵌套 inner=' + JSON.stringify(inr));
    deepEq(inr, ['驳回原因（内层）=深层', '驳回原因（内2层）=叶层'],
      '★ 内层＝当前层里**所有深度**的嵌表（DOM 序）：deep 是内层、leaf 是内2层');
    /* 归属长尾判定：leaf 其实是 deep 的嵌表（"内层的内层"），却按**锚点层**统一编号。
     * 这是"内层＝锚点层里所有嵌表"（用户口径"任意单元格"）的直接推论，
     * 记黄牌级别的语义粗糙，不是回退（旧实现根本没有内层方向）。 */
  });

  await test('★ R4-2c 嵌表在 `<th>` 格里 / 在 `colspan` 格里：同样算内层，且不重复计数', () => {
    const i1 = kv(['驳回原因', 'th 里的内层']);
    const i2 = kv(['驳回原因', 'colspan 里的内层']);
    const outer = mkTable([
      [{ th: true, text: '命中格' }, '辛词', { th: true, table: i1 }],
      [{ cs: 2, table: i2 }, 'x']
    ]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const inr = flat(F.extractFor(hit, '驳回原因', 'inner'));
    console.log('        [R4-2c] th/colspan inner=' + JSON.stringify(inr));
    deepEq(inr, ['驳回原因（内层）=th 里的内层', '驳回原因（内2层）=colspan 里的内层'],
      '★ 格子标签（th/td）与合并（colspan）都不影响归属；每张表只算一次（没有重复项）');
  });

  await test('★ R4-2d 同一个格里两张嵌表：两张都收，按 DOM 序编号', () => {
    const a = kv(['驳回原因', '同格一']);
    const b = kv(['驳回原因', '同格二']);
    const outer = mkTable([['命中格', '壬词', { nodes: [a, b] }]]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hit, '驳回原因', 'inner')),
      ['驳回原因（内层）=同格一', '驳回原因（内2层）=同格二'],
      '★ 同格里 N 张嵌表＝N 层（用户已接受 N 份后果），顺序＝DOM 序');
  });

  await test('★ R4-2e N 张嵌表（跨行 3 张）＝ 3 份，值/顺序/后缀逐字可预测', () => {
    const i1 = kv(['驳回原因', '行1内层']);
    const i2 = kv(['驳回原因', '行2内层']);
    const i3 = kv(['驳回原因', '行3内层']);
    const outer = mkTable([
      ['命中格', '癸词', { table: i1 }],
      ['驳回原因', '本层癸', { table: i2 }],
      ['详情', '本层详情癸', { table: i3 }]
    ]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const inr = flat(F.extractFor(hit, '驳回原因', 'inner'));
    console.log('        [R4-2e] 3 张嵌表 inner=' + JSON.stringify(inr));
    deepEq(inr, ['驳回原因（内层）=行1内层', '驳回原因（内2层）=行2内层', '驳回原因（内3层）=行3内层'],
      '★ 每张嵌表各成一层（用户知情接受）；这一层里**不含**本层的「本层癸」');
    deepEq(flat(F.extractFor(hit, '驳回原因', 'self+inner')).slice(0, 3), inr, '多选时内层三段在最前、顺序不变');
    deepEq(flat(F.extractFor(hit, '驳回原因', 'self')), ['驳回原因=本层癸'], '当前层只取本层那一格的值');
  });

  await test('★ R4-2f 定义域：嵌表的**中间层表自己**的标签不算锚点层的内层', () => {
    const leaf = kv(['驳回原因', '叶值']);
    const mid = kv(['驳回原因', { table: leaf }], ['备注', '中层备注']);
    const outer = mkTable([['命中格', '子词', { table: mid }]]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const selfRead = flat(F.extractFor(hit, '驳回原因', 'self'));
    const midRead = flat(F.extractFor(hit, '驳回原因', 'self+inner'));
    console.log('        [R4-2f] 定义域 self=' + JSON.stringify(selfRead) + ' self+inner=' + JSON.stringify(midRead));
    deepEq(selfRead, [], '★ 当前层（锚点表）自己没有该标签：嵌表里的标签不许被当成当前层的值');
    deepEq(midRead, ['驳回原因=叶值'],
      '★ 「内层」列表同时含 mid 与 leaf；mid 的该标签值格排掉嵌表后为空 ⇒ 该标签只剩 leaf 一份 ⇒ **单份不加后缀**');
    const leaf2 = kv(['驳回原因', '叶值2']);
    const mid2 = kv(['驳回原因', { nodes: [leaf2, H.txt('中层值2')] }]);
    const outer2 = mkTable([['命中格', '子词2', { table: mid2 }]]);
    const hit2 = textNodeIn(outer2._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hit2, '驳回原因', 'self+inner')),
      ['驳回原因（内层）=中层值2', '驳回原因（内2层）=叶值2'],
      '★ 反向对照：mid 那一层**有自己的文字值**时，mid 与 leaf 都要出现并带后缀');
  });

  /* ==================================================================
   * R4-3 · 面②：skipNestedTables 的误伤面（外层取值排掉内表：文字与图片）
   * ================================================================== */
  suite('K79-R4 · R4-3 外层取值排掉内表（文字与图片）与它的误伤面');

  await test('★ R4-3a 外层值格＝「嵌表 + 自己的文字」⇒ 只取自己的文字', () => {
    const inner = kv(['驳回原因', '内层丑'], ['备注', '内层备注丑']);
    const outer = mkTable([
      ['驳回原因', { nodes: [inner, H.txt('外层丑')] }],
      ['详情', '外层详情丑']
    ]);
    const hit = textNodeIn(outer._trs[1].cells[1]);
    const out = flat(F.extractFor(hit, L2, 'outer'));
    console.log('        [R4-3a] outer=' + JSON.stringify(out));
    deepEq(out, ['驳回原因=外层丑', '详情=外层详情丑'], '★ 只取值格自己的那段文字；内表文字归「内层」方向');
    truthy(out.join('|').indexOf('内层丑') < 0, '★ 嵌表文字不许混进外层的值');
    const inHit = textNodeIn(inner._trs[0].cells[1]);
    deepEq(flat(F.extractFor(inHit, L2, 'self')), ['驳回原因=内层丑'],
      '当前层（命中所在的表）上，L2 里只有「驳回原因」这一条（「备注」不在 L2 里）');
    deepEq(flat(F.extractFor(inHit, L2, 'outer')), ['驳回原因=外层丑', '详情=外层详情丑'],
      '★ 同一条规则反过来：命中在内表时，外层方向取到的正是"排掉内表后"的值');
  });

  await test('★ R4-3b 值格**只有**嵌表 ⇒ 该层无值（宁可不显示，也不显示错的）', () => {
    const inner = kv(['驳回原因', '内层寅']);
    const outer = kv([['附件', { table: inner }], ['详情', '外层详情寅']]);
    const hit = textNodeIn(inner._trs[0].cells[1]);
    const out = flat(F.extractFor(hit, '附件', 'outer'));
    console.log('        [R4-3b] outer=' + JSON.stringify(out));
    deepEq(out, [], '★ 排掉嵌表后值格自己为空 ⇒ 不产生这一项');
    truthy(out.join('|').indexOf('外层详情寅') < 0, '★ 也不许越界把下一个字段的值当成它的值');
  });

  await test('★ R4-3c 图片：值格自己的图照旧算，嵌表里的图不算（同一张图从它自己那层读得到）', () => {
    const nestedImg = H.el('img', { src: 'https://ex.com/r4-nested.png' });
    const ownImg = H.el('img', { src: 'https://ex.com/r4-own.png' });
    const inner = mkTable([['截图', { nodes: [nestedImg] }], ['备注', '内层备注卯']]);
    const outer = mkTable([
      ['截图', { nodes: [inner, ownImg] }],
      ['详情', '外层详情卯']
    ]);
    const hit = textNodeIn(outer._trs[1].cells[1]);
    const outerImgs = imgsOf(F.cellsForHit(hit, { meta: { fetchLabels: '截图', fetchScope: 'outer' } }));
    /* 内层那张图：锚点直接给**格子**（那一格里只有 <img>、没有文本节点，喂文本节点会拿到 null） */
    const innerCellHit = { cell: inner._trs[0].cells[1] };
    const selfImgs = imgsOf(F.cellsForHit(innerCellHit, { meta: { fetchLabels: '截图', fetchScope: 'self' } }));
    console.log('        [R4-3c] outer=' + JSON.stringify(outerImgs) + ' inner-self=' + JSON.stringify(selfImgs));
    deepEq(outerImgs, ['截图:https://ex.com/r4-own.png'],
      '★ 外层的「截图」只算值格自己的图（嵌表里的那张被排除）');
    deepEq(selfImgs, ['截图:https://ex.com/r4-nested.png'], '★ 嵌表里那张图从它自己那一层读得到，没丢');
  });

  await test('★ R4-3d 误伤面（黄牌）：外层文字写在嵌表**前后** ⇒ 中间只剩一个换行', () => {
    const inner = kv(['驳回原因', '内层辰']);
    const outer = mkTable([
      ['驳回原因', { nodes: [H.txt('外层前'), inner, H.txt('外层后')] }],
      ['详情', '外层详情辰']
    ]);
    const hit = textNodeIn(outer._trs[1].cells[1]);
    const out = flat(F.extractFor(hit, '驳回原因', 'outer'));
    console.log('        [R4-3d] 前后文字并接 = ' + JSON.stringify(out));
    deepEq(out, ['驳回原因=外层前\n外层后'],
      '★ 现状：嵌表被换成**一个换行** ⇒ 页面上被一整张表隔开的两段文字，读数里成了相邻两行');
    truthy(out.join('|').indexOf('内层辰') < 0, '口径本身（排掉内表文字）是对的');
  });

  await test('★ R4-3e 误伤面（黄牌）：值格里嵌表 ⇒ 该层只剩"值格自己"那点文字', () => {
    const shot = mkTable([['截图', { nodes: [H.el('img', { src: 'https://ex.com/r4-shot.png' })] }]]);
    const outer = mkTable([['附件', { nodes: [H.txt('见附件'), shot] }], ['详情', '外层详情巳']]);
    const hit = textNodeIn(outer._trs[1].cells[1]);
    const out = flat(F.extractFor(hit, '附件', 'self'));
    const outImg = imgsOf(F.cellsForHit(hit, { meta: { fetchLabels: '附件', fetchScope: 'self' } }));
    const innerCellHit = { cell: shot._trs[0].cells[1] };
    const innerImgs = imgsOf(F.cellsForHit(innerCellHit, { meta: { fetchLabels: '截图', fetchScope: 'self' } }));
    console.log('        [R4-3e] 附件 self=' + JSON.stringify(out) + ' imgs=' + JSON.stringify(outImg) +
      ' | 内层读截图 imgs=' + JSON.stringify(innerImgs));
    deepEq(out, ['附件=见附件'], '★ "值格自己的文字才算值"的直接后果');
    deepEq(outImg, ['附件:'], '★ 用户真正想要的那张截图不算这个字段的图（只能从「内层」方向读「截图」）');
    deepEq(innerImgs, ['截图:https://ex.com/r4-shot.png'], '★ 那张图确实没丢：它从内层方向读得到');
  });

  await test('★ R4-3f（黄牌·既有非本轮）表头格标签 + 值格只有嵌表 ⇒ 整块取值越界吃到下一行别的字段', () => {
    /* 形状：表头格「驳回原因」在 row0；它的"值格"（row1 col1）里**只有一张嵌表**；
     * 下一行（row2 col1）才属于别的字段。
     * 与 2.0.0.5 实测对照（同一装置、同一垫片；2.0.0.5 用 dist/keyword-highlighter-v2.0.0.5.zip
     * 解出的源码跑）：
     *   2.0.0.5 ⇒ `驳回原因=驳回原因\n内层重复|甲应用`（**内表文字 + 下一行值一起吞**）
     *   2.0.0.6 ⇒ `驳回原因=甲应用`（内表文字不吞了，**仍然**吞下一行的值）
     * ⇒ 越界**不是 K79 引入的**：两条"新字段起始行"判据在 2.0.0.5 里同样带 `!headerLike` 门槛
     *   （旧版 `fetch.js:689/699/704`），K79 只是去掉了内表文字那层噪音、让越界更显眼。 */
    const inner0 = kv(['驳回原因', '内层重复']);
    const t = mkTable([
      [{ th: true, text: '驳回原因' }, { th: true, text: '其它' }],
      ['x', { table: inner0 }],
      ['应用名称', '甲应用']
    ]);
    const anchor = textNodeIn(t._trs[0].cells[0]);
    const selfRead = flat(F.extractFor(anchor, '驳回原因', 'self'));
    const innerRead = flat(F.extractFor(anchor, '驳回原因', 'inner'));
    console.log('        [R4-3f] header-self=' + JSON.stringify(selfRead) + ' inner=' + JSON.stringify(innerRead));
    deepEq(innerRead, ['驳回原因=内层重复'], '★ 内层方向那一份是对的（这一层没有毛病）');
    deepEq(selfRead, ['驳回原因=甲应用'],
      '★ 黄牌实测：当前层把 row2 的「甲应用」当成本字段的值（两条新字段判据都带 `!headerLike`）');
    truthy(selfRead.join('|').indexOf('内层重复') < 0, '★ 至少内表文字不再混进当前层的值（K79 这一半是对的）');
    const inner1 = kv(['驳回原因', '内层重复2']);
    const t2 = mkTable([
      [{ th: true, text: '驳回原因' }, { th: true, text: '其它' }],
      [{ nodes: [inner1, H.txt('本层值2')] }, 'x'],
      ['应用名称', '甲应用2']
    ]);
    const anchor2 = textNodeIn(t2._trs[0].cells[0]);
    deepEq(flat(F.extractFor(anchor2, '驳回原因', 'self')), ['驳回原因=x|甲应用2'],
      '★ 对照：值格有自己的文字时也**照样越界**（读到本行第 1 列的 `x` 与下一行的「甲应用2」）；' +
      '同一形状在 2.0.0.5 上把内表全文 + 下一行值一起吞 ⇒ 这一族是**既有黄牌**，不是 K79 的红牌');
  });

  await test('★ R4-3g（黄牌·既有非本轮）两列表「标签 | 值格只有嵌表」⇒ 值变空即收尾（不再越界）', () => {
    /* 实测对照（同一装置）：
     *   2.0.0.5 ⇒ `驳回原因=内层字段\n内层值`（把内表全文当值）
     *   2.0.0.6 ⇒ `[]`（值格排掉嵌表后为空 ⇒ 该字段不出现，**没有**越界吃到 row1） */
    const inner0 = kv(['内层字段', '内层值']);
    const t = mkTable([
      ['驳回原因', { table: inner0 }],
      ['应用名称', '甲应用']
    ]);
    const anchor = textNodeIn(t._trs[0].cells[0]);
    const selfRead = flat(F.extractFor(anchor, '驳回原因', 'self'));
    console.log('        [R4-3g] 当前层（值格只有嵌表）=' + JSON.stringify(selfRead));
    deepEq(selfRead, [], '★ 值格排掉嵌表后为空 ⇒ 当前层无值（不显示错的），且没有越界吞 row1');
    truthy(selfRead.join('|').indexOf('甲应用') < 0, '★ 不许把下一行别的字段的值吞成本字段的值');
    truthy(selfRead.join('|').indexOf('内层值') < 0, '★ 也不许把内表文字当成当前层的值（K79 的改进点）');
    deepEq(flat(F.extractFor(anchor, '内层字段', 'inner')), ['内层字段=内层值'],
      '★ 内表里的字段从「内层」方向照旧读得到');
  });

  /* ==================================================================
   * R4-4 · 合并规则：同名同值去重 / 异值后缀 / 顺序（本层→外层→外2层，内层在最前）
   * ================================================================== */
  suite('K79-R4 · R4-4 多层合并（值相同去重 / 值不同后缀 / 顺序）');

  await test('★ R4-4a 同名**同值** ⇒ 只留一份、且不加后缀（最内层优先）', () => {
    const inner = kv(['驳回原因', '同值'], ['备注', '内层备注午']);
    const outer = kv(['驳回原因', '同值'], ['附件', { table: inner }], ['详情', '外层详情午']);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    const both = flat(F.extractFor(hit, L3, 'self+inner'));
    console.log('        [R4-4a] ' + JSON.stringify(both));
    deepEq(both, ['驳回原因=同值', '备注=内层备注午', '详情=外层详情午'],
      '★ 同名同值去重后只剩一条**不带后缀**（保留排序最靠前那份）；不同名的标签不许被牵连');
  });

  await test('★ R4-4b 同名**异值** ⇒ 两份都留 + 后缀；顺序＝本层→外层→外2层，且内层在全表最前', () => {
    const inner = kv(['驳回原因', '内层未'], ['详情', '内层详情未']);
    const mid = kv(['驳回原因', '中层未'], ['附件', { table: inner }], ['详情', '中层详情未']);
    const top = kv(['驳回原因', '顶层未'], ['附件', { table: mid }], ['详情', '顶层详情未']);
    const hitIn = textNodeIn(inner._trs[0].cells[1]);
    const out = flat(F.extractFor(hitIn, L2, 'self+inner+outer'));
    console.log('        [R4-4b] ' + JSON.stringify(out));
    deepEq(out, [
      '驳回原因（本层）=内层未',
      '驳回原因（外层）=中层未',
      '驳回原因（外2层）=顶层未',
      '详情（本层）=内层详情未',
      '详情（外层）=中层详情未',
      '详情（外2层）=顶层详情未'
    ], '★ 标签为主序；同一标签内 本层 → 外层 → 外2层（由内向外）');
    const hitTop = textNodeIn(top._trs[0].cells[1]);
    const out2 = flat(F.extractFor(hitTop, L2, 'self+inner+outer'));
    console.log('        [R4-4b-外层命中] ' + JSON.stringify(out2));
    eq(out2[0], '驳回原因（内层）=中层未', '★ 内层方向的两张嵌表（mid、inner）排在最前，近的为「内层」');
    eq(out2[1], '驳回原因（内2层）=内层未', '★ 更深的嵌表是「内2层」');
    truthy(out2.indexOf('详情（本层）=顶层详情未') >= 0, '★ 本层的值也在（本表无祖先表 ⇒ 外层方向回落本层）');
  });

  await test('★ R4-4c 单层选择时合并是**恒等变换**（不加后缀、顺序＝标签声明顺序）', () => {
    const outer = kv(['驳回原因', '外层申'], ['详情', '外层详情申']);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    for (const sc of ['self', 'outer1', 'outermost', 'auto']) {
      deepEq(flat(F.extractFor(hit, '详情|驳回原因', sc)), ['详情=外层详情申', '驳回原因=外层申'],
        '★ 后缀不许出现在单层结果里；顺序＝声明顺序（' + sc + '）');
    }
  });

  /* ==================================================================
   * R4-5 · 面③/④：旧值在真实装置上的等价 + 仅抓取锚点 + tb 轴与假表格
   * ================================================================== */
  suite('K79-R4 · R4-5 旧值逐字等价、仅抓取锚点、tb 轴与假表格');

  await test('★ R4-5a `outer1` / `outermost` / `outer` 在三层装置上**逐字等价**', () => {
    const inner = kv(['驳回原因', '内层戌'], ['备注', '备注戌']);
    const mid = kv(['驳回原因', '中层戌'], ['附件', { table: inner }]);
    const top = kv(['驳回原因', '顶层戌'], ['附件', { table: mid }]);
    const hitIn = textNodeIn(inner._trs[0].cells[1]);
    for (const labs of ['驳回原因', '备注', L2]) {
      const a = flat(F.extractFor(hitIn, labs, 'outer'));
      const b = flat(F.extractFor(hitIn, labs, 'outer1'));
      const c = flat(F.extractFor(hitIn, labs, 'outermost'));
      deepEq(b, a, '★ outer1 ≡ outer（逐字）：' + labs);
      deepEq(c, a, '★ outermost ≡ outer（逐字）：' + labs);
      console.log('        [R4-5a] ' + labs + ' → ' + JSON.stringify(a));
    }
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'outer')),
      ['驳回原因（外层）=中层戌', '驳回原因（外2层）=顶层戌'],
      '★ 登记：outer1/outermost 现在是"外层方向"（多层合并），不再是"只取一层"');
  });

  await test('★ R4-5b `all` ≡ `self+inner+outer`（同一装置逐字对照）', () => {
    const inner = kv(['驳回原因', '内层亥']);
    const mid = kv(['驳回原因', '中层亥'], ['附件', { table: inner }]);
    const top = kv(['驳回原因', '顶层亥'], ['附件', { table: mid }]);
    const hitIn = textNodeIn(inner._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'all')),
      flat(F.extractFor(hitIn, '驳回原因', 'self+inner+outer')),
      '★ all 与显式三方向逐字相同');
    const hitMid = textNodeIn(mid._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hitMid, '驳回原因', 'all')),
      ['驳回原因（内层）=内层亥', '驳回原因（本层）=中层亥', '驳回原因（外层）=顶层亥'],
      '★ all 的顺序：内层 → 本层 → 外层');
  });

  await test('★ R4-5c `auto` 在多层装置上**只取就近一层**（顺序：先本层，本层没有才往外）', () => {
    const inner = kv(['驳回原因', '内层甲'], ['备注', '内层备注甲']);
    const mid = kv(['驳回原因', '中层甲'], ['附件', { table: inner }], ['详情', '中层详情甲']);
    const top = kv(['驳回原因', '顶层甲'], ['附件', { table: mid }]);
    const hitIn = textNodeIn(inner._trs[0].cells[1]);
    deepEq(flat(F.extractFor(hitIn, '驳回原因', 'auto')), ['驳回原因=内层甲'],
      '★ 本层命中 ⇒ 不再往外找（旧 auto 的"就近一层"）');
    deepEq(flat(F.extractFor(hitIn, '详情', 'auto')), ['详情=中层详情甲'],
      '★ 本层没有 ⇒ 就近命中一层即停（不许把 top 的也并进来）');
    for (const labs of ['驳回原因', '详情', '备注']) {
      deepEq(flat(F.extractFor(hitIn, labs, undefined)), flat(F.extractFor(hitIn, labs, 'auto')),
        '★ 缺键 ≡ auto（逐字）：' + labs);
    }
    deepEq(flat(F.extractFor(hitIn, '备注', 'auto')), ['备注=内层备注甲'], '本层有就直接给本层');
  });

  await test('★ R4-5d 面④：组合词「仅抓取」锚在**标题格**（非命中格）时的层判定', () => {
    /* 真实形状：标题词「应用名称」在标题格，值格在它右边；内表挂在**另一个格**里。
     * 仅抓取登记的是标题格的**第一个文本节点**（见 combo.js:273）⇒ 锚点＝标题格。 */
    const inner = kv(['包名', '内层包名'], ['驳回原因', '内层驳回']);
    const outer = mkTable([
      ['应用名称', '甲应用', '附件', { table: inner }],
      ['驳回原因', '外层驳回'],
      ['详情', '外层详情']
    ]);
    const anchor = textNodeIn(outer._trs[0].cells[0]);
    eq(F.nearestTable(anchor.parentNode) === outer, true, '锚点格所在层＝外层表');
    deepEq(flat(F.extractFor(anchor, '包名', 'self')), [],
      '★ 仅抓取＋当前层：本层没有「包名」⇒ 空（这正是症状① 的旧表现）');
    deepEq(flat(F.extractFor(anchor, '包名', 'inner')), ['包名=内层包名'],
      '★ 仅抓取＋内层：别的格子里的嵌表**必须**读得到（症状① 的修复）');
    deepEq(flat(F.extractFor(anchor, '包名|驳回原因', 'self+inner')),
      ['包名=内层包名', '驳回原因（内层）=内层驳回', '驳回原因（本层）=外层驳回'],
      '★ 多选：内外两份都在、同名异值带后缀');
    const coreHit = textNodeIn(outer._trs[0].cells[1]);
    deepEq(flat(F.extractFor(coreHit, '包名', 'inner')), ['包名=内层包名'],
      '★ 左右格组合词（核心词命中值格）的层判定与仅抓取一致（锚点同为外层表里的格子）');
    deepEq(flat(F.extractFor(coreHit, '包名', 'self')), [], '★ 一致地：当前层没有该标签就是空');
  });

  await test('★ R4-5e 面④：tb 轴（表头格锚点）与 lr 轴（值格锚点）方向一致', () => {
    const inner = kv(['驳回原因', 'tb 内层驳回']);
    const dataCell = mkTable([['驳回原因', 'tb 本层驳回']]);
    const t = mkTable([
      [{ th: true, text: '包名' }, { th: true, text: '驳回原因' }],
      ['甲应用', { table: dataCell }],
      ['乙应用', { table: inner }]
    ]);
    const LB = '驳回原因|其它';        // 带第二个标签 ⇒ 不走 parseLabels 的历史"简单模式"
    const headerAnchor = textNodeIn(t._trs[0].cells[1]);
    const lrAnchor = textNodeIn(t._trs[1].cells[0]);
    /* tb 轴核心词命中在**第二张嵌表的数据格**里 ⇒ 锚点＝内表自己的格 */
    const tbAnchor = textNodeIn(inner._trs[0].cells[1]);
    console.log('        [R4-5e] lr=' + JSON.stringify(flat(F.extractFor(lrAnchor, LB, 'self'))) +
      ' header-inner=' + JSON.stringify(flat(F.extractFor(headerAnchor, LB, 'inner'))));
    /* ① **单层**判定：表头锚点与 lr 锚点**在同一行** ⇒ 命中行优先取到同一个标签格（表头格），
     * 两者必须逐字一致（轴不同、锚点行相同 ⇒ 层判定不许有差别） */
    deepEq(flat(F.extractFor(lrAnchor, LB, 'self')), flat(F.extractFor(headerAnchor, LB, 'self')),
      '★ lr 轴锚点（同行左侧格）与表头锚点的当前层读数逐字一致');
    /* ② **内层**判定：两张嵌表都算内层（tb/lr/表头三种锚点必须逐字一致） */
    const inr = flat(F.extractFor(headerAnchor, LB, 'inner'));
    deepEq(inr, ['驳回原因（内层）=tb 本层驳回', '驳回原因（内2层）=tb 内层驳回'],
      '★ 表头格锚点：内层＝该表里**两张**嵌表（顺序＝DOM 序）');
    deepEq(flat(F.extractFor(lrAnchor, LB, 'inner')), inr, '★ lr 轴锚点与表头锚点的内层判定逐字一致');
    /* tb 轴的核心词命中在内表的数据格里 ⇒ **当前层就是内表**（它自己没有嵌表 ⇒ 内层方向空）；
     * 与表头锚点（当前层＝外层表、内层＝两张）形成"锚点所在层决定一切"的对照。 */
    deepEq(flat(F.extractFor(tbAnchor, LB, 'self')), ['驳回原因=tb 内层驳回'],
      '★ tb 轴锚点在内表里 ⇒ 当前层＝内表（值正确）');
    deepEq(flat(F.extractFor(tbAnchor, LB, 'inner')), ['驳回原因=tb 内层驳回'],
      '★ 内表自己没有嵌表 ⇒ 内层方向**回落当前层**（K74"不许变空"），读数＝内表那一格的值');
    /* ③ 登记（非本轮回退）：这一形状里"标签列右侧没有列"⇒ `labelIsLastColumn` 为真 ⇒
     * `collectRightBlock` 走的是"值就在标签列"那条老路径（`fetch.js:700-702`，**不带**
     * `skipNestedTables`），于是当前层读到的是标签列那个格子的全文（含嵌表文字）。
     * 这是 K79 有意没碰的既有语义（两列表「应用名称 | 包名」靠它取值），不是本轮回退。 */
    deepEq(flat(F.extractFor(headerAnchor, LB, 'self')),
      ['驳回原因=驳回原因\ntb 本层驳回|驳回原因\ntb 内层驳回'],
      '★ 登记：该形状走"值就在标签列"老路径 ⇒ 当前层会读到嵌表文字（既有语义，K79 未改）');
  });

  await test('★ R4-5f 假表格（无真 `<table>`）路径不受分层影响', () => {
    const row = H.el('div', { class: 'row' });
    row.appendChild(H.el('span', null, ['包名']));
    row.appendChild(H.el('span', null, ['甲应用']));
    const body = H.el('div');
    body.appendChild(row);
    document.body.appendChild(body);
    const anchor = row.childNodes[0].childNodes[0];
    eq(F.nearestTable(anchor.parentNode), null, '装置前提：这一段里没有真 <table>');
    deepEq(flat(F.extractFor(anchor, '包名', 'self')), ['包名=甲应用'], '假表格：当前层照旧从右邻取');
    deepEq(flat(F.extractFor(anchor, '包名', 'inner')), ['包名=甲应用'], '★ 假表格没有层级概念 ⇒ 与当前层同行为（不空）');
    deepEq(flat(F.extractFor(anchor, '包名', 'outer')), ['包名=甲应用'], '★ 外层方向同样不变空');
    deepEq(flat(F.extractFor(anchor, '包名', 'self+inner+outer')), ['包名=甲应用'], '★ 多选在假表格上不产生重复项');
    deepEq(flat(F.extractFor(anchor, '包名', 'auto')), ['包名=甲应用'], 'auto 在假表格上照旧');
    document.body.removeChild(body);
  });

  /* ==================================================================
   * R4-6 · 单源与不可达面（编辑器全不勾 / 选项表）
   * ================================================================== */
  suite('K79-R4 · R4-6 单源、选项表与不可达状态');

  await test('★ R4-6a `fetchScope` 的归一只有一份（源码 + 运行期哨兵）', () => {
    const src = readSrc(path.join('src', 'features', 'fetch.js'));
    truthy(!/function\s+normalizeFetchScope/.test(src),
      '★ fetch.js 里不许再有一份自己的归一实现（应统一调 KH.Config）');
    truthy(/scopeOf\(v\) \{ return KH\.Config\.normalizeFetchScope\(v\); \}/.test(src),
      '★ 消费侧的 scopeOf 必须**转调** Config 的那一个（单源）');
    truthy(/fetchScopeSpec\(/.test(src), '消费侧必须走 `fetchScopeSpec`（唯一入口）');
    const inner = kv(['驳回原因', '内层归一']);
    const outer = kv(['驳回原因', '本层归一'], ['附件', { table: inner }]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    for (const dirty of ['OUTERMOST', ' all ', 'outer1', 'bogus', '', null, undefined]) {
      const want = C.normalizeFetchScope(dirty);
      deepEq(flat(F.extractFor(hit, '驳回原因', dirty)),
        flat(F.extractFor(hit, '驳回原因', want)),
        '★ 脏值 ' + JSON.stringify(dirty) + ' ⇒ 与归一值 ' + want + ' 逐字同行为');
    }
  });

  await test('★ R4-6c 字段级图片选项（`#图`）在内层那一份上**不许丢**（baseLabelOf 必须认内层后缀）', () => {
    /* 背景：`computeBlock` 渲染时把「驳回原因（内层）」映射回字段选项要用 `baseLabelOf`，
     * 而它只剥 `本层/外层/外n层`。内层是 K79 新增的后缀 ⇒ 不补的话，
     * 「驳回原因#图」（只保留图片）在内层那一份上会**静默失效**（显示空/带文字）。
     * 这里用渲染产物（blockFor 的 HTML）来判，而不是只看 extractFor。 */
    const nestedImg = H.el('img', { src: 'https://ex.com/r4-inner-opt.png' });
    const ownImg = H.el('img', { src: 'https://ex.com/r4-outer-opt.png' });
    const inner = mkTable([['截图', { nodes: [nestedImg, H.txt('内层截图文字')] }], ['备注', '内层备注']]);
    const outer = mkTable([
      ['命中格', '丁丁词', { table: inner }],
      ['截图', { nodes: [ownImg, H.txt('外层截图文字')] }],
      ['详情', '外层详情']
    ]);
    const hit = textNodeIn(outer._trs[0].cells[1]);
    /* ① 先确认 extractFor 这一层：内层/本层两份都在（带后缀） */
    deepEq(labelsOf(F.extractFor(hit, '截图#图', 'self+inner')),
      ['截图（内层）', '截图（本层）'], '★ 两份标签都带层级后缀');
    /* ② 再看渲染产物：`#图` = 只保留图片 ⇒ 两份都该只剩 <img>、丢掉文字 */
    const html = F.blockFor(hit, '截图#图', null, 'self+inner') || '';
    console.log('        [R4-6c] html=' + JSON.stringify(html.replace(/\s+/g, ' ')));
    truthy(html.indexOf('r4-inner-opt.png') >= 0, '内层那份的图在（图本身没丢）');
    truthy(html.indexOf('r4-outer-opt.png') >= 0, '本层那份的图也在');
    const innerTextLeaked = html.indexOf('内层截图文字') >= 0;
    const outerTextLeaked = html.indexOf('外层截图文字') >= 0;
    console.log('        [R4-6c] 内层文字泄漏=' + innerTextLeaked + ' 本层文字泄漏=' + outerTextLeaked);
    /* ★ 红牌实测（本文件唯一一条"两份待遇不一致"的证据）：
     *   本层那一份：`#图` 生效（文字被丢掉）；内层那一份：`#图` **被静默忽略**（文字漏出来）。
     * 根因：`baseLabelOf`（fetch.js:1431）只剥 `本层|外层|外\d+层`，
     *   ⇒ `optOf['截图（内层）']` 取不到 ⇒ `opt` 为 undefined ⇒ 该行按"没有图片选项"渲染。
     * 修法（一行）：把 `内层|内\d+层` 加进那个替换的 alternation。 */
    truthy(!outerTextLeaked, '★ 本层那一份：`#图` 生效（丢掉文字）');
    truthy(!innerTextLeaked,
      '★ 红牌：内层那一份必须同样生效。现状 = `baseLabelOf` 剥不掉「（内层）」⇒ 该字段的 `#图` 被忽略、文字漏出');
  });

  await test('★ R4-6b 界面：8 档选项与 FETCH_SCOPES 逐字一致、def=self、文案非空', () => {
    const f = FM.byKey('fetchScope');
    deepEq(f.options.map((o) => o.v), C.FETCH_SCOPES, '★ 选项值＝唯一真源（顺序也要一致）');
    eq(f.def(C.defaults), 'self', '新建关键词落库即 self');
    eq(f.options.filter((o) => !String(o.t || '').trim()).length, 0, '每档都有中文文案');
    eq(C.FETCH_SCOPES.length, 8, 'auto + 7 个非空子集');
    eq(f.options.filter((o) => o.v === '').length, 0, '★ 没有空档 ⇒ "全不勾"不可达（契约 §三.4 的回落分支不可达）');
  });
};
