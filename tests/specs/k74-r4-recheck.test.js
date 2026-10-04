/* tests/specs/k74-r4-recheck.test.js — K74「嵌套表格抓取范围」的 **R4 独立复验**（红队口径）
 * ----------------------------------------------------------------------------
 * 与 R3 的 `k74-nested-fetch-scope.test.js` **互不替代**：这里全部用 R4 自己造的装置与写法，
 * 按契约 §五 A1–A7 的判定锚独立判一遍，并额外钉住 R3 自述里那三处需要独立验证的点：
 *   ① 两处性能修复：`collectRightBlock` 的 rowspan 裁剪**逐位等价**（注入 maxSpan=9999 等价于
 *      "从第 0 行回放"）+ `stopAtRepeatedLabel` 的**两个方向**（rowspan=3 合并标签不许被截断；
 *      下一行重复同一标签必须收尾）；
 *   ② 缓存不串味（同表不同行 / 不同 scope）；
 *   ③ `all` 的输出顺序与 §四.4 的相容性判断；
 *   ④ `fetchScope` 的归一只有一份函数（源码 + 运行期哨兵）。
 *
 * 反向验证（R4 自跑）的目标用例就在本文件里：
 *   ① 只截断候选链（`tableChain` → 单表）→ A1/A2 族红；
 *   ② 去掉行级优先 → A3 族红；
 *   ③ 忽略 `fetchScope` → A4 族红；
 *   ④ 缓存键去掉行号/scope → 缓存族红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 造一张真表格（R4 自己的版本：支持 `{rs,cs}` 行/列合并）。
 *  顺带补上引擎用到的表格访问器（垫片不实现 HTMLTableElement）。 */
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
  t.rows = trs.map((tr, ri) => {
    tr.rowIndex = ri;
    tr.cells = tr.children;
    tr.cells.forEach((td, i) => { td.cellIndex = i; });
    return tr;
  });
  t._trs = trs;
  return t;
}

/** 取某格里第一个非空文本节点（喂 `extractFor` / `blockFor`） */
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

/** `extractFor` 结果 → `标签=值` 扁平串（便于断言与打印） */
const flat = (list) => (list || []).map((f) => f.label + '=' + (f.rows || []).map((r) => r.map((c) => c.t).join('/')).join('|'));

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;
  const C = KH.Config;
  const S = KH.Store;
  const FM = KH.FieldMap;

  /* ============================== 三层装置（R4 自己的） ==============================
   * outer → mid → inner；命中文本「你好」放在 **inner 的值格**（设计形态：标签在左、值在右）。
   * 标签分布刻意设计：
   *   · `驳回原因`：三层都有、值不同 → 用来**逐值识别取到了哪一层** + `all` 的后缀/去重
   *   · `只在外层`：只有最外层有 → `auto` 的"本层没有才外扩"；`self` 抓不到
   *   · `共同同值`：三层同值 → `all` 只留最内层、不加后缀
   */
  function threeLevels() {
    const inner = mkTable([
      [{ text: '驳回原因' }, { text: '内层驳回' }],
      [{ text: '共同同值' }, { text: '同值X' }],
      [{ text: '命中格' }, { text: '你好' }]
    ]);
    const mid = mkTable([
      [{ text: '驳回原因' }, { text: '中层驳回' }],
      [{ text: '中层独有' }, { text: '中层独有值' }],
      [{ text: '共同同值' }, { text: '同值X' }],
      [{ text: '详情' }, { table: inner }]
    ]);
    const outer = mkTable([
      [{ text: '驳回原因' }, { text: '外层驳回' }],
      [{ text: '只在外层' }, { text: '外层独有' }],
      [{ text: '共同同值' }, { text: '同值X' }],
      [{ text: '详情' }, { table: mid }]
    ]);
    const hitCell = inner._trs[2].children[1];
    return { outer: outer, mid: mid, inner: inner, hitCell: hitCell, hitNode: textNodeIn(hitCell) };
  }

  /* ==================================== A1 ==================================== */

  suite('K74 复验 · A1 内层命中也能抓到外层（R4 自己的三层装置）');

  await test('★ 三方向逐值：self＝本层、inner＝本层里的嵌表（没有就回落本层）、outer＝所有祖先层（带层级后缀）', () => {
    const d = threeLevels();
    /* 命中在**最内层**：当前层＝inner，外层＝mid / outer（由近到远） */
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'self')), ['驳回原因=内层驳回'],
      '★ self ＝当前层（命中格所在层）');
    deepEq(flat(F.extractFor(d.hitNode, '中层独有', 'self')), [], '★ self 不许外扩（中层的东西抓不到）');
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'inner')), ['驳回原因=内层驳回'],
      '★ inner：当前层里没有嵌表 ⇒ 回落当前层（K74 承诺"任何取值都不许变空"）');
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'outer')),
      ['驳回原因（外层）=中层驳回', '驳回原因（外2层）=外层驳回'],
      '★ outer ＝所有祖先层，同名不同值 ⇒ 加「外层 / 外2层」后缀（由近到远）');
    deepEq(flat(F.extractFor(d.hitNode, '共同同值', 'outer')), ['共同同值=同值X'],
      '★ 同名同值 ⇒ 去重只留一份、**不加后缀**');
    deepEq(flat(F.extractFor(d.hitNode, '只在外层', 'outer')), ['只在外层=外层独有'],
      '★ 只有一层有该标签 ⇒ 不加后缀（卡片保持干净）');
    /* 旧值一律映射到新方向：outer1 / outermost → outer（口径合并，changelog 有披露） */
    for (const legacy of ['outer1', 'outermost']) {
      deepEq(flat(F.extractFor(d.hitNode, '驳回原因', legacy)), flat(F.extractFor(d.hitNode, '驳回原因', 'outer')),
        '★ 旧值 ' + legacy + ' → outer（逐字一致）');
    }
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'all')),
      ['驳回原因（本层）=内层驳回', '驳回原因（外层）=中层驳回', '驳回原因（外2层）=外层驳回'],
      '★ 旧值 all → self+inner+outer：三层同名不同值 ⇒ 按 本层 → 外层 → 外2层 的顺序');
    deepEq(flat(F.extractFor(d.hitNode, '只在外层', 'all')), ['只在外层=外层独有'], 'all 下只有最外层有 ⇒ 一份、无后缀');
  });

  await test('★ auto（旧值·一字不变）：逐标签「本层优先、就近一层」，命中在最内层时也能外扩到最外层', () => {
    const d = threeLevels();
    deepEq(flat(F.extractFor(d.hitNode, '只在外层', 'auto')), ['只在外层=外层独有'],
      '★ auto 本层/中层都没有 ⇒ 一直外扩到最外层（存量行为不许变）');
    deepEq(flat(F.extractFor(d.hitNode, '中层独有', 'auto')), ['中层独有=中层独有值'], 'auto 就近命中一层即停');
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'auto')), ['驳回原因=内层驳回'], '★ auto ＝本层有就用本层（不外扩）');
    /* auto 与 self 的差别只在"本层没有时"：本层没有的标签 auto 会外扩 */
    deepEq(flat(F.extractFor(d.hitNode, '只在外层', 'self')), [], 'self 抓不到（对照组）');
    /* 嵌套表里的格子**不属于**宿主层（层级语义）—— 顺手把这条钉子钉住 */
    const inner2 = mkTable([[{ text: '嵌套里的标签' }, { text: '嵌套里的值' }], [{ text: '命中' }, { text: '你好' }]]);
    const outer2 = mkTable([[{ text: '宿主' }, { table: inner2 }]]);
    const hit2 = textNodeIn(inner2._trs[1].children[1]);
    deepEq(flat(F.extractFor(hit2, '嵌套里的标签', 'self')), ['嵌套里的标签=嵌套里的值'], '本层（内层）自己的标签当然取得到');
    deepEq(flat(F.extractFor(hit2, '嵌套里的标签', 'outer')), [], '★ 内层表格的格子不算外层"自己的"格子 ⇒ 外层找不到它');
    void outer2;
  });

  /* ==================================== A3 ==================================== */

  suite('K74 复验 · A3 行级口径：命中那一行优先，找不到再整表找（每层都成立）');

  await test('★ 每行都重复「标签|值」：取**命中那一行**的值（老实现取第 1 行）', () => {
    const t = mkTable([
      [{ text: '驳回原因' }, { text: '第一条的值' }],
      [{ text: '驳回原因' }, { text: '第二条的值' }],
      [{ text: '驳回原因' }, { text: '第三条的值' }]
    ]);
    const hit2 = textNodeIn(t._trs[1].children[1]);
    const hit3 = textNodeIn(t._trs[2].children[1]);
    deepEq(flat(F.extractFor(hit2, '驳回原因', 'self')), ['驳回原因=第二条的值'], '★ 命中第 2 行 ⇒ 取第 2 行的值');
    deepEq(flat(F.extractFor(hit3, '驳回原因', 'self')), ['驳回原因=第三条的值'], '★ 命中第 3 行 ⇒ 取第 3 行的值');
  });

  await test('★ 命中行里没有该标签 ⇒ 整表兜底（deep.html Z 组形状：每行一对「标签|值」+ 命中在第三行）', () => {
    const t = mkTable([
      [{ text: '驳回原因' }, { text: '外层文字第一行' }],
      [{ text: '运营备注' }, { text: '高价值需跟进' }],
      [{ text: '审核不通过' }, { text: '命中行' }]
    ]);
    const hit = textNodeIn(t._trs[2].children[1]);
    const got = flat(F.extractFor(hit, '驳回原因|运营备注', 'self'));
    console.log('        兜底（Z 组形状）: ' + JSON.stringify(got));
    deepEq(got, ['驳回原因=外层文字第一行', '运营备注=高价值需跟进'],
      '★ 命中行没有这两个标签 ⇒ 必须整表兜底，且不许把下一字段挤掉（行为不变）');
  });

  await test('★ 行级优先在**每一层**都成立（外层也适用：包住命中的那一行有标签就取那一行）', () => {
    /* ① 外层"包住命中的那一行"**没有**该标签（嵌套表放在「详细」行）⇒ 该层退回整表第一个。
     *    这就是 deep.html Z 组的合成行为："行级优先 + 整表兜底"。 */
    const innerA = mkTable([[{ text: '内层占位' }, { text: '你好' }]]);
    const outerA = mkTable([
      [{ text: '驳回原因' }, { text: '外层第一条' }],
      [{ text: '详细' }, { table: innerA }]
    ]);
    const hitA = textNodeIn(innerA._trs[0].children[1]);
    deepEq(flat(F.extractFor(hitA, '驳回原因', 'outermost')), ['驳回原因=外层第一条'],
      '外层命中行没有该标签 ⇒ 必须兜底取整表第一个（行为不变）');

    /* ② 外层命中行**有**该标签，且它上面还有一行同名标签 ⇒ 必须取命中那一行的（不是第一行） */
    const innerB = mkTable([[{ text: '内层占位' }, { text: '你好' }]]);
    const outerB = mkTable([
      [{ text: '驳回原因' }, { text: '外层第一条' }],
      [{ text: '驳回原因' }, { text: '外层第二条' }, { table: innerB }]
    ]);
    const hitB = textNodeIn(innerB._trs[0].children[1]);
    const gotB = flat(F.extractFor(hitB, '驳回原因', 'outermost'));
    console.log('        外层行级优先: ' + JSON.stringify(gotB));
    truthy(gotB.length === 1 && gotB[0].indexOf('外层第二条') >= 0 && gotB[0].indexOf('外层第一条') < 0,
      '★ 外层"包住命中的那一行"里有该标签 ⇒ 必须取那一行的值（老实现会取外层第一条）：' + JSON.stringify(gotB));
  });

  await test('★ R4 自造**真·表头行**（`<th>`）独立表：标签在表头、值在下面的数据行 ⇒ 走的必须是"整表兜底"（＝K74 之前的路径）', () => {
    const t = mkTable([
      [{ text: '供应商', th: true }, { text: '备注', th: true }],
      [{ text: '华为技术有限公司' }, { text: '高价值' }],
      [{ text: '命中词' }, { text: '你好' }]
    ]);
    const hit = textNodeIn(t._trs[2].children[1]);
    const got = flat(F.extractFor(hit, '供应商', 'self'));
    console.log('        表头行（th）: ' + JSON.stringify(got));
    truthy(got.length === 1, '★ 表头行标签必须仍能找到（不许变空）');
    falsy(got[0].indexOf('备注') >= 0, '★ 表头行里的其它 th（列标题）不许被当成值');
    /* "行为不变"的硬判据：这一形状走的是**整表兜底**（fromRow=false ⇒ stopAtRepeatedLabel=false），
     * 所以结果必须与"显式关掉 stopRepeat 的直接调用"逐字相同 —— 与 K74 之前的路径等价。 */
    const direct = JSON.stringify(F.collectRightBlock(t._trs[0].children[0], t, { stopAtRepeatedLabel: false, memo: { span: new Map() } }));
    const viaExtract = JSON.stringify(F.extractFor(hit, '供应商', 'self')[0].rows);
    eq(viaExtract, direct, '★ 表头行形状必须走"整表兜底"这条老路径（禁止启用 stopRepeat / 行级优先）');
    deepEq(flat(F.extractFor(hit, '供应商', 'auto')), got, 'auto 在本层能找到 ⇒ 与 self 同值（不外扩）');
  });

  /* ==================================== A4 ==================================== */

  suite('K74 复验 · A4 五个取值逐值生效 + 边界 + 归一');

  await test('★ self / outer / auto / all 逐值 + 旧值 outer1·outermost·all 的映射（含后缀/去重/顺序）', () => {
    const d = threeLevels();
    const got = {};
    for (const sc of ['self', 'outer', 'outer1', 'outermost', 'auto', 'all']) {
      got[sc] = flat(F.extractFor(d.hitNode, '驳回原因|共同同值|只在外层', sc));
    }
    console.log('        逐值: ' + JSON.stringify(got));
    deepEq(got.self, ['驳回原因=内层驳回', '共同同值=同值X'], 'self＝只本层（本层没有「只在外层」）');
    deepEq(got.outer, [
      '驳回原因（外层）=中层驳回', '驳回原因（外2层）=外层驳回',
      '共同同值=同值X', '只在外层=外层独有'
    ], '★ outer＝所有祖先层：同名不同值加后缀、同值去重不加后缀');
    deepEq(got.outer1, got.outer, '★ 旧值 outer1 → outer（逐字一致）');
    deepEq(got.outermost, got.outer, '★ 旧值 outermost → outer（逐字一致）');
    deepEq(got.auto, ['驳回原因=内层驳回', '共同同值=同值X', '只在外层=外层独有'],
      'auto＝逐标签"本层优先"：本层有的取本层，本层没有的（只在外层）外扩到最外层（旧值一字不变）');
    deepEq(got.all, [
      '驳回原因（本层）=内层驳回', '驳回原因（外层）=中层驳回', '驳回原因（外2层）=外层驳回',
      '共同同值=同值X', '只在外层=外层独有'
    ], '★ 旧值 all → self+inner+outer：值不同的同名标签按"本层→逐层向外"加后缀；同值只留本层不加后缀');
    /* 顺序判断（见报告）：label-major（标签声明顺序，标签内由内向外） */
    const labels = got.all.map((s) => s.split('=')[0]);
    deepEq(labels.filter((l) => l.indexOf('驳回原因') === 0), ['驳回原因（本层）', '驳回原因（外层）', '驳回原因（外2层）'],
      '同一标签内必须"本层在前、逐层向外"（§四.4）');
    /* 组合值：方向可选、可多选，且**只抓取那个方向** */
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'self+outer')),
      ['驳回原因（本层）=内层驳回', '驳回原因（外层）=中层驳回', '驳回原因（外2层）=外层驳回'],
      '★ self+outer ＝ 本层 + 所有外层（本装置内层为空 ⇒ 与 all 同值）');
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', 'outer+self')),
      flat(F.extractFor(d.hitNode, '驳回原因', 'self+outer')),
      '★ 组合值规范化：与书写顺序无关');
  });

  await test('★ 没有外层／没有内层：任何取值都不许变空、不许抛错（K74 承诺）', () => {
    const t = mkTable([[{ text: '驳回原因' }, { text: '单层值' }], [{ text: '命中' }, { text: '你好' }]]);
    const hit = textNodeIn(t._trs[1].children[1]);
    for (const sc of ['auto', 'self', 'inner', 'outer', 'outer1', 'outermost', 'all',
      'self+inner', 'self+outer', 'inner+outer', 'self+inner+outer']) {
      deepEq(flat(F.extractFor(hit, '驳回原因', sc)), ['驳回原因=单层值'], '单层表 ' + sc + ' 不许变空');
    }
  });

  await test('★ 归一：缺键/非法 → auto（存量保守）；旧值 auto/outer1/outermost/all 各有确定映射', () => {
    eq(C.normalizeFetchScope(undefined), 'auto', '★ 缺键 → auto（这个键 2.0.0.1 才加，缺键＝那时的配置口径）');
    eq(C.normalizeFetchScope(null), 'auto', 'null → auto');
    eq(C.normalizeFetchScope('x'), 'auto', '非法值 → auto');
    eq(C.normalizeFetchScope(''), 'auto', '空串 → auto');
    eq(C.normalizeFetchScope('auto'), 'auto', '旧值 auto 原样保留（就近一层，存量配置行为不变）');
    eq(C.normalizeFetchScope('outer1'), 'outer', '★ 旧值 outer1 → outer');
    eq(C.normalizeFetchScope('outermost'), 'outer', '★ 旧值 outermost → outer');
    eq(C.normalizeFetchScope('all'), 'self+inner+outer', '★ 旧值 all → 三方向全选');
    for (const sc of ['self', 'inner', 'outer', 'self+inner', 'self+outer', 'inner+outer', 'self+inner+outer']) {
      eq(C.normalizeFetchScope(sc), sc, '合法值原样：' + sc);
    }
    /* 大小写不敏感 + 组合值顺序/去重（导出/CSV 往返稳定） */
    eq(C.normalizeFetchScope('SELF'), 'self', '大写 → 小写');
    eq(C.normalizeFetchScope('Outer1'), 'outer', '混合大小写的旧值也认');
    eq(C.normalizeFetchScope('inner+self'), 'self+inner', '★ 组合值：去重 + 固定顺序（与书写顺序无关）');
    /* 消费侧同判：extractFor 传非法值 ⇒ 按 auto 处理（不静默改变存量行为） */
    const d = threeLevels();
    deepEq(flat(F.extractFor(d.hitNode, '驳回原因', '不存在的值')), flat(F.extractFor(d.hitNode, '驳回原因', 'auto')),
      '★ 消费侧非法值必须等同 auto');
    deepEq(flat(F.extractFor(d.hitNode, '只在外层', '不存在的值')), ['只在外层=外层独有'],
      '★ 非法值与缺键同判（auto 允许外扩）—— 与 2.0.0.1 的缺省行为逐字一致');
    /* 「默认＝当前层」由编辑器 def 承担，不由归一承担（两者不许混为一谈） */
    eq(FM.byKey('fetchScope').def(C.defaults), 'self', '★ 编辑器默认＝当前层');
  });

  await test('★ 显式 self 保存一次后仍是 self（写路径与读路径共用同一个归一）', async () => {
    const saved = JSON.parse(JSON.stringify(global.__MEM__));
    try {
      global.__MEM__.keywords = []; global.__MEM__.groups = [];
      const out = await S.upsertKeyword({ id: 'r4-scope', text: '范围词', fetchScope: 'self' }, C.defaults);
      eq(out.fetchScope, 'self', '★ 保存后不许被翻成 auto');
      const back = (await S.load()).keywords.find((k) => k.id === 'r4-scope');
      eq(back.fetchScope, 'self', '★ 重新读出来仍是 self');
      eq(S.sanitizeKeyword({ text: 'x', fetchScope: 'x' }, C.defaults).fetchScope, 'auto', '★ 非法值经写路径 → auto');
      eq(S.sanitizeKeyword({ text: 'x' }, C.defaults).fetchScope, 'auto', '★ 缺键经写路径 → auto（存量关键词升级后不丢外层字段）');
      eq(S.sanitizeKeyword({ text: 'x', fetchScope: 'all' }, C.defaults).fetchScope, 'self+inner+outer', '★ 旧值 all 经写路径规范化');
      eq(S.sanitizeKeyword({ text: 'x', fetchScope: 'inner+self' }, C.defaults).fetchScope, 'self+inner', '★ 组合值经写路径规范化');
    } finally {
      for (const k of Object.keys(global.__MEM__)) delete global.__MEM__[k];
      Object.assign(global.__MEM__, saved);
    }
  });

  await test('★ "同一个归一函数"：源码只有一份定义，且消费/写路径运行期查表（哨兵证明）', () => {
    const cfgSrc = readSrc('src/core/config.js');
    const storeSrc = readSrc('src/platform/storage.js');
    const fetchSrc = readSrc('src/features/fetch.js');
    eq((cfgSrc.match(/function\s+normalizeFetchScope\s*\(/g) || []).length, 1, 'config.js 里只许有一处定义');
    falsy(/function\s+normalizeFetchScope/.test(storeSrc), 'storage.js 不许再定义一份');
    falsy(/function\s+normalizeFetchScope/.test(fetchSrc), 'fetch.js 不许再定义一份');
    truthy(/fetchScope:\s*KH\.Config\.normalizeFetchScope\(/.test(storeSrc), '写路径必须调同一个函数');
    truthy(/scopeOf\(v\)\s*\{\s*return\s+KH\.Config\.normalizeFetchScope\(v\)/.test(fetchSrc), '消费侧 scopeOf 必须转发');

    const savedFn = C.normalizeFetchScope;
    try {
      C.normalizeFetchScope = () => 'self';
      const d = threeLevels();
      deepEq(flat(F.extractFor(d.hitNode, '只在外层', 'auto')), [], '★ 换成哨兵后 extractFor 立刻按 self 走 ⇒ 消费侧是运行期查表');
      eq(S.sanitizeKeyword({ text: 'x', fetchScope: 'all' }, C.defaults).fetchScope, 'self', '★ 写路径同样运行期查表');
    } finally {
      C.normalizeFetchScope = savedFn;
    }
    eq(C.normalizeFetchScope('all'), 'self+inner+outer', '哨兵已复位');
  });

  /* ==================================== A5 ==================================== */

  suite('K74 复验 · A5 取图与抓取同源（cellsForHit）');

  await test('★ cellsForHit：outer 取外层值格的图；all 内外的图都在；缺省＝当前层；显式 auto 才外扩', () => {
    const imgOuter = H.el('img', { src: 'https://ex.com/outer.png', alt: '外层图' });
    const imgInner = H.el('img', { src: 'https://ex.com/inner.png', alt: '内层图' });
    const inner = mkTable([
      [{ text: '截图' }, { nodes: [imgInner] }],
      [{ text: '命中' }, { text: '你好' }]
    ]);
    const outer = mkTable([
      [{ text: '截图' }, { nodes: [imgOuter] }],
      [{ text: '详情' }, { table: inner }]
    ]);
    const hitCell = inner._trs[1].children[1];
    const srcs = (r) => (r || []).map((x) => x.label + ':' + x.imgs.map((i) => i.getAttribute('src')).join(','));
    const meta = (scope) => ({ meta: { fetchLabels: '截图', fetchScope: scope } });

    const selfR = srcs(F.cellsForHit(hitCell, meta('self')));
    const outerR = srcs(F.cellsForHit(hitCell, meta('outer')));
    const outer1R = srcs(F.cellsForHit(hitCell, meta('outer1')));
    const allR = srcs(F.cellsForHit(hitCell, meta('all')));
    const autoR = srcs(F.cellsForHit(hitCell, meta('auto')));
    const defR = srcs(F.cellsForHit(hitCell, '截图'));
    console.log('        cellsForHit: self=' + JSON.stringify(selfR) + ' outer=' + JSON.stringify(outerR) +
      ' all=' + JSON.stringify(allR) + ' 缺省=' + JSON.stringify(defR));
    truthy(selfR.join('|').indexOf('inner.png') >= 0, 'self 取本层值格的图');
    truthy(outerR.join('|').indexOf('outer.png') >= 0 && outerR.join('|').indexOf('inner.png') < 0,
      '★ outer 必须取**外层**值格的图（且不含内层图）');
    deepEq(outer1R, outerR, '★ 旧值 outer1 → outer：取图结果逐字一致');
    truthy(allR.join('|').indexOf('outer.png') >= 0 && allR.join('|').indexOf('inner.png') >= 0, '★ all 内外两层值格的图都在');
    deepEq(defR, selfR, '★ 只传 labels 字符串 ⇒ scope 缺省＝当前层（本层有「截图」⇒ 取本层那张图）');
    truthy(autoR.join('|').indexOf('inner.png') >= 0, '★ 显式 auto 仍按"本层优先"（老调用点行为不变）');
    /* 同源：cellsForHit 与 extractFor 选的是同一层 */
    const autoFetch = flat(F.extractFor(textNodeIn(hitCell), '截图', 'auto'));
    truthy(autoFetch.length === 1, 'auto 抓取也只取一层');
    deepEq(flat(F.extractFor(textNodeIn(hitCell), '截图', 'outer')).length, 1, 'outer 抓取与取图同源（都取外层那一格）');
    void outer;
  });

  /* ============================== §四.8 缓存 ============================== */

  suite('K74 复验 · §四.8 缓存不得串味');

  await test('★ 同表不同行：两次 blockFor 结果必须各自正确（缓存键含行号）', () => {
    const t = mkTable([
      [{ text: '驳回原因' }, { text: '第一条' }],
      [{ text: '驳回原因' }, { text: '第二条' }],
      [{ text: '驳回原因' }, { text: '第三条' }]
    ]);
    const cache = new WeakMap();
    const a = F.blockFor(textNodeIn(t._trs[0].children[1]), '驳回原因', cache, 'self');
    const b = F.blockFor(textNodeIn(t._trs[1].children[1]), '驳回原因', cache, 'self');
    const c = F.blockFor(textNodeIn(t._trs[2].children[1]), '驳回原因', cache, 'self');
    console.log('        缓存/不同行: ' + JSON.stringify([a, b, c].map((s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 40))));
    truthy(a.indexOf('第一条') >= 0 && a.indexOf('第二条') < 0, '第 1 行命中 ⇒ 只有第一条');
    truthy(b.indexOf('第二条') >= 0 && b.indexOf('第一条') < 0, '★ 第 2 行命中 ⇒ 只有第二条（旧键会串成第一条）');
    truthy(c.indexOf('第三条') >= 0 && c.indexOf('第一条') < 0, '★ 第 3 行命中 ⇒ 只有第三条');
  });

  await test('★ 同表同 labels、不同 scope：缓存必须分清（键漏 scope 时会错）', () => {
    const d = threeLevels();
    const cache = new WeakMap();
    const self_ = F.blockFor(d.hitNode, '驳回原因', cache, 'self');
    const outer1 = F.blockFor(d.hitNode, '驳回原因', cache, 'outer1');
    const outermost = F.blockFor(d.hitNode, '驳回原因', cache, 'outermost');
    const all = F.blockFor(d.hitNode, '驳回原因', cache, 'all');
    truthy(self_.indexOf('内层驳回') >= 0 && self_.indexOf('中层驳回') < 0, 'self 只有内层值');
    truthy(outer1.indexOf('中层驳回') >= 0 && outer1.indexOf('内层驳回') < 0, '★ outer1 只有中层值');
    truthy(outermost.indexOf('外层驳回') >= 0 && outermost.indexOf('内层驳回') < 0, '★ outermost 只有外层值');
    truthy(all.indexOf('内层驳回') >= 0 && all.indexOf('中层驳回') >= 0 && all.indexOf('外层驳回') >= 0, '★ all 三层都在');
    /* 顺序无关的稳定性：再取一次 self 仍是内层（不被别的 scope 污染） */
    truthy(F.blockFor(d.hitNode, '驳回原因', cache, 'self').indexOf('内层驳回') >= 0, '回头再取 self 仍正确');
  });

  await test('★ 带 cache 与不带 cache 完全一致（诊断路径不走缓存也必须同结果）', () => {
    const d = threeLevels();
    const cache = new WeakMap();
    for (const sc of ['self', 'outer1', 'outermost', 'auto', 'all']) {
      const withCache = F.blockFor(d.hitNode, '驳回原因|共同同值|只在外层', cache, sc);
      const noCache = F.blockFor(d.hitNode, '驳回原因|共同同值|只在外层', null, sc);
      eq(withCache, noCache, 'scope=' + sc + ' 时带/不带 cache 必须逐字一致');
    }
  });

  /* ==================== R3 的两处性能修复：独立等价性/边界判定 ==================== */

  suite('K74 复验 · 性能修复①：rowspan 裁剪回放必须**逐位等价**于从第 0 行回放');

  /** 用注入 `memo.span` 的方式把"裁剪版"与"从 0 行回放版"都跑出来（不改实现）。
   *  `tableSpanInfo` 先查 `memo.span.has(table)` ⇒ 注入 `maxSpan=9999` 就是"从 0 回放"。 */
  const fakeMemo = (table) => ({ span: new Map([[table, { hasSpan: true, maxSpan: 9999 }]]) });
  const realMemo = () => ({ span: new Map() });
  const blockOf = (cell, table, memo, stopRepeat) =>
    JSON.stringify(F.collectRightBlock(cell, table, { stopAtRepeatedLabel: !!stopRepeat, memo: memo }));

  await test('★ 多形状（rowspan=3 标签 / colspan / 多级表头 / 值跨多行）逐格对比：裁剪版 ≡ 从 0 行回放版', () => {
    const shapes = {};
    /* 形状 1：标签格 rowspan=3（下一行同列没有标签格，被合并） */
    shapes.rowspan3 = mkTable([
      [{ text: '驳回原因', rs: 3 }, { text: '值1' }],
      [{ text: '值2' }],
      [{ text: '值3' }],
      [{ text: '下一个字段' }, { text: '别的值' }]
    ]);
    /* 形状 2：colspan 合并（标签右侧跨两列的合并格） */
    shapes.colspan = mkTable([
      [{ text: '驳回原因' }, { text: '跨两列的值', cs: 2 }],
      [{ text: '含 colspan 的行' }, { text: 'A' }],
      [{ text: '再一行' }, { text: 'B' }]
    ]);
    /* 形状 3：多级表头（两行 th 之后再数据行）+ 第 2 列有 rowspan */
    shapes.multihead = mkTable([
      [{ text: '一级表头' }, { text: '一级表头2' }],
      [{ text: '二级A' }, { text: '二级B' }],
      [{ text: '驳回原因', rs: 2 }, { text: '多行值1' }],
      [{ text: '多行值2' }],
      [{ text: '运营备注' }, { text: '备注值' }]
    ]);
    /* 形状 4：标签 rowspan=2 + 值格也跨行（值本身 rowspan） */
    shapes.bothSpan = mkTable([
      [{ text: '标签长', rs: 2 }, { text: '值格跨2行', rs: 2 }],
      [],
      [{ text: '尾巴标签' }, { text: '尾巴值' }]
    ]);

    let compared = 0;
    const bad = [];
    for (const [name, t] of Object.entries(shapes)) {
      for (const tr of t._trs) {
        for (const cell of tr.children) {
          for (const stop of [false, true]) {
            const a = blockOf(cell, t, realMemo(), stop);
            const b = blockOf(cell, t, fakeMemo(t), stop);
            compared++;
            if (a !== b) bad.push(name + ' r' + tr.rowIndex + ' c' + cell.cellIndex + ' stop=' + stop + '\n  裁剪=' + a + '\n  回放=' + b);
          }
        }
      }
    }
    console.log('        等价性对比格数=' + compared + ' 不一致=' + bad.length);
    deepEq(bad, [], '★ 裁剪版与"从 0 行回放版"必须逐位相同（不一致：' + JSON.stringify(bad.slice(0, 2)) + '）');
    truthy(compared >= 20, '对比样本要够（实际 ' + compared + '）');
  });

  await test('★ 无 rowspan 的表：裁剪分支整段跳过，结果同样与"从 0 回放"逐位相同', () => {
    const t = mkTable([
      [{ text: '驳回原因' }, { text: '第一条' }],
      [{ text: '驳回原因' }, { text: '第二条' }],
      [{ text: '运营备注' }, { text: '备注' }],
      [{ text: '驳回原因' }, { text: '第三条' }]
    ]);
    for (const tr of t._trs) {
      for (const cell of tr.children) {
        eq(blockOf(cell, t, realMemo(), false), blockOf(cell, t, fakeMemo(t), false), 'r' + tr.rowIndex + ' c' + cell.cellIndex);
      }
    }
  });

  suite('K74 复验 · 性能修复②：stopAtRepeatedLabel 的两个方向');

  await test('★ rowspan=3 的标签格（下一行同列**没有**标签格）：值仍必须收满 3 行（不许被误截）', () => {
    const t = mkTable([
      [{ text: '驳回原因', rs: 3 }, { text: '值1' }],
      [{ text: '值2' }],
      [{ text: '值3' }],
      [{ text: '下一个字段' }, { text: '别的值' }]
    ]);
    const label = t._trs[0].children[0];
    const rows = F.collectRightBlock(label, t, { stopAtRepeatedLabel: true, memo: realMemo() });
    const texts = rows.map((r) => r.map((c) => c.t).join('/'));
    console.log('        rowspan=3 收尾: ' + JSON.stringify(texts));
    deepEq(texts, ['值1', '值2', '值3'], '★ 合并标签的三行值必须都收满（stopRepeat 不许提前截断）');
    deepEq(F.collectRightBlock(label, t, { stopAtRepeatedLabel: false, memo: realMemo() }).map((r) => r.map((c) => c.t).join('/')),
      ['值1', '值2', '值3'], '关掉 stopRepeat 同值（这条形状本来就不会越界）');
  });

  await test('★ 下一行同列**重复同一标签**：值只收到本行为止（新记录），关掉标志就会越界（证明这条修复真的在起作用）', () => {
    const t = mkTable([
      [{ text: '驳回原因' }, { text: '第一条的值' }],
      [{ text: '驳回原因' }, { text: '第二条的值' }],
      [{ text: '驳回原因' }, { text: '第三条的值' }]
    ]);
    const label0 = t._trs[0].children[0];
    const withStop = F.collectRightBlock(label0, t, { stopAtRepeatedLabel: true, memo: realMemo() }).map((r) => r.map((c) => c.t).join('/'));
    const without = F.collectRightBlock(label0, t, { stopAtRepeatedLabel: false, memo: realMemo() }).map((r) => r.map((c) => c.t).join('/'));
    console.log('        stopRepeat: on=' + JSON.stringify(withStop) + ' off=' + JSON.stringify(without));
    deepEq(withStop, ['第一条的值'], '★ 命中行的值只到本行（下一行重复同一标签＝下一条记录）');
    truthy(without.length > withStop.length, '对照：关掉标志就会把下面几行都收进来（这正是 800 行退化的根因）');
    /* "值就在标签列"的两列表（无 colspan 可 > col 的列）行为不变：仍要求 !labelIsLastColumn */
    const twoCol = mkTable([[{ text: '应用名称' }], [{ text: 'com.aaa' }], [{ text: '应用名称' }], [{ text: 'com.bbb' }]]);
    const twoRows = F.collectRightBlock(twoCol._trs[0].children[0], twoCol, { stopAtRepeatedLabel: true, memo: realMemo() }).map((r) => r.map((c) => c.t).join('/'));
    console.log('        两列表（值在标签列）: ' + JSON.stringify(twoRows));
    truthy(twoRows.length >= 2, '「值就在标签列」的两列表必须继续按"标签行 + 后续值行"收集（既有行为）');
  });

  /* ==================================== A6 ==================================== */

  suite('K74 复验 · A6 编辑器声明与落库');

  await test('★ 字段声明：位置（fetch 分区首个仍是输入框）、五档文案逐字、csv 0、def auto', () => {
    const keys = FM.fieldsOf('fetch').map((f) => f.key);
    console.log('        fetch 分区字段顺序: ' + JSON.stringify(keys));
    eq(keys[0], 'fetchLabels', '★ K71 不变式：fetch 分区第一项仍是输入框');
    const iOn = keys.indexOf('fetchEnabled');
    eq(keys[iOn + 1], 'fetchScope', '★ fetchScope 必须紧跟 fetchEnabled 之后');
    const f = FM.byKey('fetchScope');
    eq(f.label, '抓取范围', 'label');
    eq(f.type, 'select', 'type');
    eq(f.sec, 'fetch', '分区');
    eq(f.csv, 0, '不进 CSV（18 列契约）');
    eq(f.def(C.defaults), 'self', '★ 默认＝当前层（K79 起重梳；旧默认 auto 仍作为可选项保留）');
    deepEq(f.options.map((o) => o.v), C.FETCH_SCOPES, '★ 选项值与 Config.FETCH_SCOPES 逐字一致（唯一真源）');
    deepEq(f.options.map((o) => o.t), ['自动（就近一层）', '当前层', '内层', '外层',
      '当前层 + 内层', '当前层 + 外层', '内层 + 外层', '当前层 + 内层 + 外层'], '★ 八档界面文案逐字');
    truthy(String(f.hint).indexOf('嵌套表格') >= 0, 'hint 要说清"嵌套表格抓哪一层"');
    truthy(String(f.hint).indexOf('内层文字') >= 0, '★ hint 要说明"内层文字不会混进外层的值"');
  });

  await test('★ 字段表驱动护栏：每个键都能原样过 sanitizeKeyword（含新键 fetchScope=三方向全选）', () => {
    let bad = [];
    for (const f of FM.KEYWORD_FIELDS) {
      const v = f.type === 'bool' ? true
        : (f.type === 'int' ? 3
          : (f.type === 'select' ? (f.options ? f.options[f.options.length - 1].v : 'x') : 'v'));
      const out = S.sanitizeKeyword(Object.assign({ text: 'x' }, { [f.key]: v }), C.defaults);
      if (!(f.key in out)) bad.push(f.key + ' 丢失');
      if (f.key === 'fetchScope' && out.fetchScope !== 'self+inner+outer') bad.push('fetchScope 没有原样返回：' + out.fetchScope);
    }
    deepEq(bad, [], '★ 字段表驱动护栏必须覆盖新键');
  });

  await test('★ 与 K71 的门一致：fetchEnabled=false 时无论 scope 选什么，抓取都必须为 0（门在 meta.fetchLabels）', () => {
    const Comp = KH.Compiler;
    const off = Comp.dispatch({ id: 'r4-gate', text: '甲词', fetchEnabled: false, fetchScope: 'self+inner+outer', fetchLabels: '驳回原因' }, C.defaults);
    eq(off.meta.fetchLabels, '', '未启用 ⇒ meta.fetchLabels 归一成空串（下游据此不抓）');
    eq(off.meta.fetchScope, 'self+inner+outer', 'scope 仍会带进 meta（但 labels 空 ⇒ 取图层也取不到）');
    const on = Comp.dispatch({ id: 'r4-gate', text: '甲词', fetchEnabled: true, fetchScope: 'self+inner+outer', fetchLabels: '驳回原因' }, C.defaults);
    eq(on.meta.fetchLabels, '驳回原因', '启用后照旧');
    eq(on.meta.fetchScope, 'self+inner+outer', 'scope 原样带进 meta（供 important-note / img-ocr 消费）');
    const illegal = Comp.dispatch({ id: 'r4-gate', text: '甲词', fetchEnabled: true, fetchScope: '乱写的', fetchLabels: '驳回原因' }, C.defaults);
    eq(illegal.meta.fetchScope, 'auto', '★ 非法值在编译层也归一成 auto（同一个函数；与 2.0.0.1 的缺省行为一致）');
    const legacy = Comp.dispatch({ id: 'r4-gate', text: '甲词', fetchEnabled: true, fetchScope: 'outermost', fetchLabels: '驳回原因' }, C.defaults);
    eq(legacy.meta.fetchScope, 'outer', '★ 旧值 outermost 在编译层归一成 outer');
    /* 组合词路径同样拿到 fetchScope（R3 说挂在共用出口 ocrMeta 上；combo.js 一行未改） */
    const combo = Comp.dispatch({ id: 'r4-combo', text: '核心', cellVerifyEnabled: true, cellVerify: '表头', comboAxis: 'tb', cellVerifyMatchMode: 'include', fetchLabels: '驳回原因', fetchScope: 'outer1' }, C.defaults);
    eq(combo.meta.fetchScope, 'outer', '★ 组合词也必须拿到 fetchScope（共用出口，旧值归一）');
    eq(combo.meta.fetchLabels, '驳回原因', '组合词的 labels 照旧');
  });

  /* ==================================== A7 ==================================== */

  suite('K74 复验 · A7 文案与文档');

  await test('★ README / BROWSER-CHECKLIST A37 / E2E-REPORT 都补了 K74；changelog 引用自检（脚本单独跑）', () => {
    const readme = readSrc('README.md');
    const checklist = readSrc('tests/BROWSER-CHECKLIST.md');
    const report = readSrc('tests/E2E-REPORT.md');
    truthy(readme.indexOf('嵌套表格') >= 0, 'README 必须补"嵌套表格可选抓哪一层"');
    truthy(/抓取范围/.test(readme), 'README 提到「抓取范围」');
    const i = checklist.indexOf('A37');
    truthy(i >= 0, '要有 A37 那节');
    const block = checklist.slice(i, i + 2600);
    truthy(/抓取范围/.test(block) && /嵌套/.test(block), '★ A37 必须补「抓取范围」的人工验收项');
    truthy(/nested-hit|probe-nested-hit/.test(block), 'A37 要给出装置/探针命令');
    truthy(/K74/.test(report), 'E2E-REPORT 必须补 K74 一节');
    truthy(/嵌套表格/.test(report) || /fetchScope/.test(report), 'K74 那节要写到点子上');
  });
};
