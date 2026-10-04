/* tests/specs/k79-fetch-layers.test.js — K79「抓取层级口径重梳」
 * ----------------------------------------------------------------------------
 * 用户口径（2026-09-23 定义，逐字）：
 *   · **内层**：命中的单元格**所在层级表格里任意单元格**嵌的内部表格（不一定是值格）；
 *   · **外层**：命中单元格所在层级**外部层级**的表格（这个命中的单元格是更大表格的内层）；
 *   · **当前层**：命中单元格所在层级的表格；
 *   · 默认＝**当前层**，可选内层、外层，可多选；选了内层 ⇒ 只抓比命中层**小**的表；
 *   · **外层取值要排掉内表文字**。
 *
 * 两个用户症状（本轮要钉死的）：
 *   ① 「标题词 + 核心词」组合、核心词留空时，即使勾了「内外都抓」也抓不到内部字段
 *      —— 根因：`仅抓取` 的锚是**标题格**，旧的"只看祖先链"永远看不见**别的格子里**的嵌表；
 *   ② 只勾「仅抓外层」时，外层字段的值里混进了内层表格的文字（不需要的内容）。
 *
 * 反向验证（本文件自带的红队用例，跑 `node tests/run.js` 时同判）：
 *   · R1 把 `innerTablesOf` 退回"祖先链" ⇒ 形状 A 全红；
 *   · R2 去掉 `skipNestedTables` ⇒ 形状 B 全红。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

/** 造一张真表格；单元格可以是字符串 / `{text}` / `{table}`（嵌套表）/ `{nodes}`；
 *  `{th: true}` ⇒ 造 `<th>`（R4-TH 用），`{rs}` / `{cs}` ⇒ 行/列合并 */
function buildTable(rows, attrs) {
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
  t.rows = trs.map((tr, ri) => {
    tr.rowIndex = ri;
    tr.cells = tr.children;
    tr.cells.forEach((td, i) => { td.cellIndex = i; });
    return tr;
  });
  t._trs = trs;
  return t;
}

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

/** `extractFor` 结果 → `标签=值` 扁平串 */
const flat = (list) => (list || []).map((f) => f.label + '=' + (f.rows || []).map((r) => r.map((c) => c.t).join('/')).join('|'));

/** 取图结果 → `标签:src,src` */
const srcOf = (list) => (list || []).map((f) => f.label + ':' + (f.imgs || []).map((i) => i.getAttribute('src')).join(','));

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;
  const C = KH.Config;
  const FM = KH.FieldMap;

  /* ==================== 装置 ==================== */

  /** 形状 A：内表在**另一个单元格**里（用户真实页面形状）。
   *  命中「甲词」在**外层表**第 1 行；嵌表在**同一行第 4 格**（不是「驳回原因」的值格）。 */
  function shapeA() {
    const inner = buildTable([['驳回原因', '内层驳回A'], ['备注', '内层备注A']]);
    const outer = buildTable([
      ['命中格', '甲词', '附件', { table: inner }],
      ['驳回原因', '外层驳回A'],
      ['详情', '外层详情A']
    ]);
    return { inner: inner, outer: outer, hit: textNodeIn(outer._trs[0].children[1]) };
  }

  /** 形状 B：内表就在**标签的值格**里（边界形状）。命中在**内层表**里。 */
  function shapeB() {
    const inner = buildTable([['驳回原因', '内层驳回B'], ['命中格', '乙词']]);
    const outer = buildTable([
      ['驳回原因', { table: inner }],
      ['详情', '外层详情B']
    ]);
    return { inner: inner, outer: outer, hit: textNodeIn(inner._trs[1].children[1]) };
  }

  /* ==================== A1 内层＝任意单元格里的嵌表 ==================== */

  suite('K79 · A1 内层＝当前层里**任意单元格**嵌的表（形状 A）');

  await test('★ 症状①：命中在外层表，勾「内外都抓」必须抓到**别的格子里**那张内表的字段', () => {
    const d = shapeA();
    const self = flat(F.extractFor(d.hit, '驳回原因', 'self'));
    const inner = flat(F.extractFor(d.hit, '驳回原因', 'inner'));
    const both = flat(F.extractFor(d.hit, '驳回原因', 'self+inner'));
    console.log('        形状A: self=' + JSON.stringify(self) + ' inner=' + JSON.stringify(inner) +
      ' self+inner=' + JSON.stringify(both));
    deepEq(self, ['驳回原因=外层驳回A'], '当前层＝命中所在的**外层**表（本层只有外层的值）');
    deepEq(inner, ['驳回原因=内层驳回A'],
      '★ 内层＝当前层里任意单元格嵌的表（**不是**祖先链，也不是值格）—— 症状① 的根因就在这');
    deepEq(both, ['驳回原因（内层）=内层驳回A', '驳回原因（本层）=外层驳回A'],
      '★ 内外都抓：同名不同值 ⇒ 两份并带层级后缀，顺序「内层 → 本层」');
    /* 内层不只"驳回原因"这一层：嵌表里的**别的**标签同样只能从内层方向读到 */
    deepEq(flat(F.extractFor(d.hit, '备注', 'self')), [], '外层没有「备注」⇒ 当前层抓不到');
    deepEq(flat(F.extractFor(d.hit, '备注', 'inner')), ['备注=内层备注A'], '★ 内层方向的标签读得到');
  });

  await test('★ 反向（R1）：内层方向必须走 `innerTablesOf`（把实现退回祖先链就会全红）', () => {
    const d = shapeA();
    deepEq(flat(F.extractFor(d.hit, '备注', 'inner')), ['备注=内层备注A'],
      'R1：只要"内层"不是从**当前层里找嵌表**，这一条必红');
    /* 只勾「仅抓内层」时**不许**混进当前层的值（用户口径：选了内层就只抓比命中层小的表） */
    deepEq(flat(F.extractFor(d.hit, '驳回原因', 'inner')), ['驳回原因=内层驳回A'],
      '★ 只勾内层 ⇒ 不含本层的「外层驳回A」');
    /* 三方向全选时，外层的值也必须与"只抓本层"一致（不是内层那份） */
    const all = flat(F.extractFor(d.hit, '驳回原因', 'self+inner+outer'));
    eq(all.length, 2, '★ 形状 A 没有外层祖先 ⇒ 三方向全选＝当前层 + 内层（两份）');
    truthy(all.join('|').indexOf('外层驳回A') >= 0 && all.join('|').indexOf('内层驳回A') >= 0, '两份都在且各自正确');
  });

  await test('★ 内层命中时「当前层/外层」的定义（命中格在内表里）', () => {
    const d = shapeB();
    deepEq(flat(F.extractFor(d.hit, '驳回原因', 'self')), ['驳回原因=内层驳回B'],
      '当前层＝命中格**直接所在**的那张表（这里是内表）');
    /* 外层那张表的「驳回原因」值格**只装了内表**：排掉嵌表后它自己就是空的 ⇒ 整项不展示。
     * 这是"不许把内表文字当成外层值"的必然结果（症状② 的反面：宁可不显示，也不显示错的）。 */
    const outer = flat(F.extractFor(d.hit, '驳回原因', 'outer'));
    console.log('        形状B outer=' + JSON.stringify(outer));
    deepEq(outer, [], '★ 外层的值格里只有嵌表 ⇒ 排掉后为空、不产生这一项');
    deepEq(flat(F.extractFor(d.hit, '驳回原因', 'self+outer')),
      ['驳回原因=内层驳回B'],
      '★ 内外一起抓也不会凭空多出一项"外层驳回＝内表全文"');
    deepEq(flat(F.extractFor(d.hit, '命中格', 'outer')), [],
      '★ 命中文字「乙词」在外层表里根本不存在 ⇒ 外层方向不许把它当值');
  });

  /* ==================== A2 外层取值排掉内表 ==================== */

  suite('K79 · A2 外层取值排掉内表文字与图片');

  await test('★ 症状②：值格里嵌了表 ⇒ 外层的值只取**值格自己**的文字（不含嵌表文字）', () => {
    const inner = buildTable([['驳回原因', '内层驳回C'], ['命中格', '丙词']]);
    const outer = buildTable([
      ['驳回原因', { nodes: [inner, H.txt('外层驳回C')] }],
      ['详情', '外层详情C']
    ]);
    const hit = textNodeIn(inner._trs[1].children[1]);
    const outerRead = flat(F.extractFor(hit, '驳回原因', 'outer'));
    const selfRead = flat(F.extractFor(hit, '驳回原因', 'self'));
    console.log('        外层排掉内表: outer=' + JSON.stringify(outerRead) + ' self=' + JSON.stringify(selfRead));
    deepEq(selfRead, ['驳回原因=内层驳回C'], '当前层＝命中所在的嵌表');
    deepEq(outerRead, ['驳回原因=外层驳回C'],
      '★ 外层的值格＝「嵌表 + 外层驳回C」⇒ 只取值格**自己**的那段文字');
    truthy(outerRead.join('|').indexOf('内层驳回C') < 0, 'R2：出现「内层驳回C」即说明嵌表文字混进了外层的值');
  });

  await test('★ 值格**只有**嵌表时：外层不许把内表文字当值（症状②的另一种长相）', () => {
    const inner = buildTable([['驳回原因', '内层驳回D'], ['命中格', '丁词']]);
    const outer = buildTable([
      ['附件', { table: inner }],
      ['详情', '外层详情D']
    ]);
    const hit = textNodeIn(inner._trs[1].children[1]);
    const outerRead = flat(F.extractFor(hit, '附件', 'outer'));
    console.log('        值格只有嵌表: outer=' + JSON.stringify(outerRead));
    deepEq(outerRead, [], '★ 排掉嵌表后值格自己＝空 ⇒ 不产生这一项（宁可不显示，也不显示内表文字）');
    truthy(outerRead.join('|').indexOf('内层驳回D') < 0, 'R2：嵌表文字不许当外层值');
    truthy(outerRead.join('|').indexOf('外层详情D') < 0, '★ 也不许越界吞掉下一个字段的值');
  });

  await test('★ 值格里的嵌表图片不算这个字段的图（与文字同一口径）', () => {
    const imgIn = H.el('img', { src: 'https://ex.com/nested.png', alt: '内表图' });
    const inner = buildTable([['截图', { nodes: [imgIn] }], ['命中格', '戊词']]);
    const outer = buildTable([['截图', { table: inner }], ['详情', '外层详情E']]);
    const hit = textNodeIn(inner._trs[1].children[1]);
    const outerImgs = srcOf(F.cellsForHit(hit, { meta: { fetchLabels: '截图', fetchScope: 'outer' } }));
    const selfImgs = srcOf(F.cellsForHit(hit, { meta: { fetchLabels: '截图', fetchScope: 'self' } }));
    console.log('        嵌表图: outer=' + JSON.stringify(outerImgs) + ' self=' + JSON.stringify(selfImgs));
    deepEq(outerImgs, ['截图:'], '★ 外层「截图」的值格里只有嵌表 ⇒ 它的图不算外层的图');
    deepEq(selfImgs, ['截图:https://ex.com/nested.png'], '★ 同一张图从**它自己那一层**读得到（不丢）');
  });

  /* ==================== A3 内层 N 份 ==================== */

  suite('K79 · A3 当前层里有 N 张嵌表（跨行重复的后果：用户已知并接受）');

  await test('★ 两张嵌表都有同名标签 ⇒ 两份带「内层 / 内2层」后缀', () => {
    const i1 = buildTable([['驳回原因', '内层一']]);
    const i2 = buildTable([['驳回原因', '内层二']]);
    const outer = buildTable([
      ['命中格', '己词', '甲附件', { table: i1 }, '乙附件', { table: i2 }]
    ]);
    const hit = textNodeIn(outer._trs[0].children[1]);
    const inner = flat(F.extractFor(hit, '驳回原因', 'inner'));
    console.log('        两张嵌表: inner=' + JSON.stringify(inner));
    deepEq(inner, ['驳回原因（内层）=内层一', '驳回原因（内2层）=内层二'],
      '★ 内层是"当前层里所有嵌表"⇒ N 份；同名不同值按文档序加后缀（用户口径：接受这个后果）');
    deepEq(flat(F.extractFor(hit, '驳回原因', 'self')), [], '当前层自己没有该标签');
  });

  /* ==================== A4 归一 / 界面 / 契约 ==================== */

  suite('K79 · A4 归一值、界面选项与兼容映射');

  await test('★ 方向表与默认值（唯一真源）', () => {
    deepEq(C.FETCH_DIRECTIONS, ['self', 'inner', 'outer'], '方向只有这三个、顺序固定');
    eq(C.FETCH_SCOPE_DEFAULT, 'self', '★ 默认＝当前层');
    for (const sc of C.FETCH_SCOPES) eq(C.normalizeFetchScope(sc), sc, '合法规范值原样：' + sc);
    /* 组合值：去重 + 固定顺序（导出/CSV 往返稳定） */
    eq(C.normalizeFetchScope('outer+inner'), 'inner+outer', '组合去重且顺序固定');
    eq(C.normalizeFetchScope('outer+outer+self'), 'self+outer', '重复项去重');
    /* 旧值映射（changelog 必须披露：外层/最外层合并成 outer） */
    eq(C.normalizeFetchScope('outer1'), 'outer');
    eq(C.normalizeFetchScope('outermost'), 'outer');
    eq(C.normalizeFetchScope('all'), 'self+inner+outer');
    eq(C.normalizeFetchScope('auto'), 'auto', '★ auto 是兼容值：**不**映射成 self+outer（否则存量配置会突然多出外层字段）');
    /* 描述（消费侧唯一入口） */
    deepEq(C.fetchScopeSpec('auto'), { scope: 'auto', dirs: ['self', 'outer'], nearestOnly: true }, 'auto＝就近一层');
    deepEq(C.fetchScopeSpec('all'), { scope: 'self+inner+outer', dirs: ['self', 'inner', 'outer'], nearestOnly: false }, 'all＝三方向逐层合并');
    deepEq(C.fetchScopeSpec(undefined), { scope: 'auto', dirs: ['self', 'outer'], nearestOnly: true },
      '★ 缺键 → auto（这个键 2.0.0.1 才加；缺键＝那时的配置，口径必须照旧）');
    /* 「默认＝当前层」由**编辑器 def** 承担，不由归一处承担 —— 这两个概念不许混 */
    eq(C.FETCH_SCOPE_DEFAULT, 'self', '新默认的常量＝当前层');
    eq(KH.FieldMap.byKey('fetchScope').def(C.defaults), 'self', '★ 新建关键词落库时写的就是 self');
  });

  await test('★ 界面：选项＝FETCH_SCOPES 逐字、默认当前层、hint 讲清三方向与"内表不混入"', () => {
    const f = FM.byKey('fetchScope');
    deepEq(f.options.map((o) => o.v), C.FETCH_SCOPES, '选项值必须与唯一真源逐字一致');
    eq(f.def(C.defaults), 'self', '★ 编辑器默认＝当前层');
    const hint = String(f.hint);
    truthy(hint.indexOf('当前层') >= 0 && hint.indexOf('内层') >= 0 && hint.indexOf('外层') >= 0, 'hint 要出现三个方向名');
    truthy(hint.indexOf('内层文字') >= 0, 'hint 要写明"内层文字不会混进外层的值"');
    truthy(C.FETCH_SCOPES.length === 8, '八档：auto + 三个方向的 7 个非空子集');
    deepEq(f.options.map((o) => o.t).filter((t) => !t), [], '每档都要有中文文案（不留空白档）');
  });

  await test('★ 写路径幂等：归一后再归一值不变（存储/导出/CSV 往返不漂移）', () => {
    for (const sc of C.FETCH_SCOPES.concat(['outer1', 'outermost', 'all', 'SELF', 'inner+self'])) {
      const once = C.normalizeFetchScope(sc);
      eq(C.normalizeFetchScope(once), once, '幂等：' + sc + ' → ' + once);
    }
    falsy(/tableChain/.test(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'features', 'fetch.js'), 'utf8')),
      '★ 旧的"祖先链"实现（tableChain）必须删净，不能再被顺手用回来（R1 的源码级哨兵）');
  });

  /* ==================== A5 标签格是 <th> 的三种形状（R4-TH 返工） ==================== */

  suite('K79 · A5 标签格是 `<th>`：行表头要读本行、真表头行照旧跳过（R4 红牌返工）');

  await test('★ 行表头（`<th>` 与 `<td>` 混排）⇒ 读**本行自己的值格**，绝不读下一行（R4 最小复现）', () => {
    /* R4 的真机最小复现：`<tr><th>驳回原因</th><td>内层驳回</td></tr><tr><th>后续字段</th><td>后续值</td></tr>`
     * 旧判据"这一格是 `<th>` ⇒ 表头行"会让 `startRow` 跳到下一行 ⇒ 读到「后续字段」的值。 */
    const t = buildTable([
      [{ th: true, text: '驳回原因' }, '内层驳回 R4Z2'],
      [{ th: true, text: '后续字段' }, '后续值 R4Z3']
    ]);
    const hit = textNodeIn(t._trs[0].children[1]);        // 命中落在值格里
    const got = flat(F.extractFor(hit, '驳回原因', 'self'));
    console.log('        行表头 th: ' + JSON.stringify(got));
    deepEq(got, ['驳回原因=内层驳回 R4Z2'], '★ 行表头必须读本行自己的值格');
    truthy(got.join('|').indexOf('后续值 R4Z3') < 0, '★ 绝不许把下一行另一个字段的值当成本字段的值');
    /* 等价性：同一形状把 `<th>` 换成 `<td>` ⇒ 逐字同值（取值口径只跟"是不是表头行"有关） */
    const tTd = buildTable([['驳回原因', '内层驳回 R4Z2'], ['后续字段', '后续值 R4Z3']]);
    const hitTd = textNodeIn(tTd._trs[0].children[1]);
    eq(flat(F.extractFor(hitTd, '驳回原因', 'self')).join('|'), got.join('|'), '★ `th` 行表头与 `td` 标签逐字等价');
  });

  await test('★ 真表头行（**整行**都是 `<th>`）⇒ 仍按表头处理：兄弟 th 不许当值（K74 口径不变）', () => {
    const t = buildTable([
      [{ th: true, text: '供应商' }, { th: true, text: '备注' }],
      ['华为技术有限公司', '高价值']
    ]);
    const hit = textNodeIn(t._trs[0].children[0]);        // 锚点就是表头那一格（仅抓取形状）
    const got = flat(F.extractFor(hit, '供应商', 'self'));
    console.log('        真表头行: ' + JSON.stringify(got));
    eq(got.length, 1, '真表头行标签必须仍能找到（不许变空）');
    truthy(got[0].indexOf('备注') < 0, '★ 表头行里的其它 `<th>`（列标题）不许被当成值');
  });

  await test('★ 只有一格 `<th>` 的"标题行"（值在下面）⇒ 不许把标签自己当值（不回归）', () => {
    const t = buildTable([
      [{ th: true, text: '驳回原因' }],
      ['资质材料不清晰']
    ]);
    const hit = textNodeIn(t._trs[1].children[0]);
    const got = flat(F.extractFor(hit, '驳回原因', 'self'));
    console.log('        单格 th 标题行: ' + JSON.stringify(got));
    deepEq(got, ['驳回原因=资质材料不清晰'], '★ 标签行整行跳过、值取下方那一行（这形状必须保持老行为）');
  });
};
