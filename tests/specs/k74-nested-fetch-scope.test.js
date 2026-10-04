/* tests/specs/k74-nested-fetch-scope.test.js — K74「嵌套表格的抓取范围」
 * ----------------------------------------------------------------------------
 * 用户症状（2026-09-22）：命中在**嵌套表格的内层**时什么都抓不到（旧实现只取最内层），
 * 面板因此分成两张卡。本轮把"抓哪一层"做成可选（`fetchScope`），并把行级口径统一为
 * "**命中所在那一行优先，找不到再整表找第一个**"。
 *
 * 这里锁四件事：
 *   A1 内层命中也能抓到外层（`auto` 缺省） / `self` 保持老行为
 *   A3 行级优先（每行重复 `标签|值` 时取命中那一行）+ 表头行形状**行为不变**
 *   A4 五个取值各自真的生效（含"没有外层时 outer1/outermost 等同 self"）
 *   A5 图片识别取图与抓取**同源**（`cellsForHit` 传同一个 scope）
 *   §四.8 缓存不得串味（同表不同行 / 同表不同 scope）
 *
 * 真浏览器侧另见 `_e2e/content.test.js` 的 K74 组（装置 fixtures/nested-hit.html）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 造一张真表格；单元格可以是字符串 / `{text}` / `{table}`（嵌套表）/ `{nodes}`。
 *  顺带补上引擎用到的表格访问器（垫片不实现 HTMLTableElement）—— 嵌套表也要补。 */
function buildTable(rows, attrs) {
  const t = H.el('table', attrs || null);
  const tbody = H.el('tbody');
  t.appendChild(tbody);
  const trs = [];
  for (const cells of rows) {
    const tr = H.el('tr');
    for (const c of cells) {
      const td = H.el('td');
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

/** 取某格里文本节点的引用（喂 `extractFor` 用） */
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

/** 把 `extractFor` 的结果压成 `标签=值` 便于断言 */
function flat(list) {
  return (list || []).map((f) => f.label + '=' + (f.rows || []).map((r) => r.map((c) => c.t).join('/')).join('|'));
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;
  const Config = KH.Config;

  /* ------------------------------------------------------------------ 三层装置 */
  /* outer → mid → inner；命中在 **inner** 的第 4 行（"命中格 | 你好"）。
   * 标签在各层的分布是刻意设计的：
   *   · `驳回原因` 三层都有、值各不相同 → `all` 必须出三份并带层级后缀
   *   · `只在外层` 只在最外层 → 测 `auto` 的"本层没有才外扩"
   *   · `共同` 三层同值 → `all` 只留最内层、**不加后缀**
   *   · `差异` 三层都有、值不同 → 同 `驳回原因`（多标签顺序用） */
  function threeLevels() {
    const inner = buildTable([
      ['驳回原因', '内层驳回'],
      ['共同', '同值'],
      ['差异', '内层差异'],
      ['命中格', '你好']
    ], { class: 'inner' });
    const mid = buildTable([
      ['驳回原因', '中层驳回'],
      ['共同', '同值'],
      ['差异', '中层差异'],
      ['详情', { table: inner }]
    ], { class: 'mid' });
    const outer = buildTable([
      ['驳回原因', '外层驳回'],
      ['只在外层', '外层独有'],
      ['共同', '同值'],
      ['差异', '外层差异'],
      ['详情', { table: mid }]
    ], { class: 'outer' });
    const hitCell = inner._trs[3].children[1];
    return { outer: outer, mid: mid, inner: inner, hitCell: hitCell, hitNode: textNodeIn(hitCell) };
  }

  suite('K74 · A1 内层命中也能抓到外层（K79 起：新增默认＝当前层；缺键/auto 仍是就近一层）');

  await test('★ auto：内层命中 → 本层没有就外扩一层；★ 缺键（老配置）也必须还是 auto', () => {
    const f = threeLevels();
    truthy(f.hitNode, '装置里应能取到内层的命中文本节点');

    /* A1 的核心：`只在外层` 只有最外层有 —— auto 必须外扩拿到它 */
    const auto = flat(F.extractFor(f.hitNode, '驳回原因|只在外层', 'auto'));
    eq(auto[0], '驳回原因=内层驳回', 'auto 本层有就用本层');
    eq(auto[1], '只在外层=外层独有', '★ auto 本层没有 → 外扩（就近一层）');
    /* ⚠️ K79 决策：**缺键（＝2.0.0.1 之前存的配置）仍归一到 auto** —— 口径没变过，
     * 不许因为"默认改成当前层"就把存量配置的外层字段悄悄掐掉。「默认当前层」由编辑器 def 承担。 */
    const dflt = flat(F.extractFor(f.hitNode, '驳回原因|只在外层'));
    eq(dflt.join('~'), auto.join('~'), '★ 缺键 ≡ auto（存量兼容：不多抓、也不少抓）');
    const self = flat(F.extractFor(f.hitNode, '驳回原因|只在外层', 'self'));
    eq(self.length, 1, '★ self 只认本层：`只在外层` 抓不到（＝新建关键词的默认）');
    eq(self[0], '驳回原因=内层驳回');
    eq(KH.FieldMap.byKey('fetchScope').def(Config.defaults), 'self', '★ 编辑器默认＝当前层（新建关键词从 self 起步）');
  });

  await test('★ 单层表（无嵌套）：**所有**取值都必须照旧抓到（不许变空）', () => {
    const t = buildTable([['驳回原因', '唯一层值'], ['命中', '你好']]);
    const node = textNodeIn(t._trs[1].children[1]);
    for (const sc of ['auto', 'self', 'inner', 'outer', 'self+inner', 'self+outer', 'inner+outer', 'self+inner+outer', 'outer1', 'outermost', 'all']) {
      eq(flat(F.extractFor(node, '驳回原因', sc))[0], '驳回原因=唯一层值',
        '没有那一层时 ' + sc + ' 必须**回落本层**（不许变空 —— K74 就立下的承诺，K79 继续守）');
    }
  });

  suite('K74 · A3 行级口径：命中所在那一行优先，找不到再整表找');

  await test('★ 每行都重复一对「标签|值」→ 取**命中那一行**的值（老实现取第 1 行）', () => {
    const t = buildTable([
      ['驳回原因', '别的行值', 'x'],
      ['备注', 'x', 'y'],
      ['驳回原因', '命中行值', '你好']
    ]);
    const node = textNodeIn(t._trs[2].children[2]);
    /* 默认是"右邻整块"模式 → 命中行的值 + 同行右侧的其余格都会进来；
     * 关键是**必须来自命中那一行**（别的行的值一个都不许出现） */
    const got = flat(F.extractFor(node, '驳回原因', 'self'))[0];
    truthy(got.indexOf('命中行值') >= 0, '★ 必须取命中那一行的值，实际 ' + JSON.stringify(got));
    falsy(got.indexOf('别的行值') >= 0, '★ 绝不能取到别的行的值，实际 ' + JSON.stringify(got));
  });

  await test('★ 命中行里没有该标签 → 整表兜底（表头行形状行为不变，deep.html 的 Z 组）', () => {
    const t = buildTable([
      ['驳回原因', '表头行值'],
      ['运营备注', '表头备注'],
      ['命中', '你好']
    ]);
    const node = textNodeIn(t._trs[2].children[1]);
    const got = flat(F.extractFor(node, '驳回原因|运营备注', 'self'));
    eq(got.join('~'), '驳回原因=表头行值~运营备注=表头备注',
      '★ 标签写在别的行（表头行/首行）是常见形状，必须照旧抓到两个字段');
  });

  await test('★ 命中行优先在**每一层**都成立（外层行里也有同名标签时取外层那一行）', () => {
    /* 外层：第 1 行有个"备注"；**包住内层表格的那一行（第 3 行）**另有"备注" */
    const inner = buildTable([['命中', '你好']]);
    const outer = buildTable([
      ['备注', '外层别的行'],
      ['占位', 'x'],
      ['详情', { table: inner }, '备注', '外层命中行']
    ]);
    void outer;
    const node = textNodeIn(inner._trs[0].children[1]);
    eq(flat(F.extractFor(node, '备注', 'outermost'))[0], '备注=外层命中行',
      '★ 向外层找时也要"外层命中所在那一行优先"');
  });

  suite('K74 · A4 各取值各自生效（K79：三方向 + 旧值兼容）');

  await test('★ self / outer / auto / self+inner+outer 逐值断言（三层装置）', () => {
    const f = threeLevels();
    const labels = '驳回原因|只在外层|共同|差异';

    eq(flat(F.extractFor(f.hitNode, labels, 'self')).join('~'),
      '驳回原因=内层驳回~共同=同值~差异=内层差异', 'self ＝ 当前层');

    /* K79：`outer` 是**外层方向**（所有祖先层，由近到远），不再是"只取一层" */
    eq(flat(F.extractFor(f.hitNode, labels, 'outer')).join('~'),
      '驳回原因（外层）=中层驳回~驳回原因（外2层）=外层驳回~只在外层=外层独有~共同=同值~'
      + '差异（外层）=中层差异~差异（外2层）=外层差异',
      'outer ＝ 外层方向：祖先层由近到远都取；同名异值带后缀、同值只留最近那一层');
    eq(flat(F.extractFor(f.hitNode, labels, 'outermost')).join('~'),
      flat(F.extractFor(f.hitNode, labels, 'outer')).join('~'),
      '★ 旧值 outermost 与 outer1 都归一成 `outer`（同一方向）');

    eq(flat(F.extractFor(f.hitNode, labels, 'auto')).join('~'),
      '驳回原因=内层驳回~只在外层=外层独有~共同=同值~差异=内层差异', 'auto ＝ 本层优先、缺了才外扩（旧行为原样保留）');

    /* self+inner+outer：同名异值 → 各层带后缀；同名同值只留最近一层；独有标签不加后缀 */
    const all = flat(F.extractFor(f.hitNode, labels, 'self+inner+outer'));
    eq(all.join('~'),
      '驳回原因（本层）=内层驳回~驳回原因（外层）=中层驳回~驳回原因（外2层）=外层驳回~'
      + '只在外层=外层独有~共同=同值~差异（本层）=内层差异~差异（外层）=中层差异~差异（外2层）=外层差异',
      '三方向全选 ＝ 各层合并（同名异值带层级后缀、同值只留最近层、独有标签不加后缀；顺序＝标签声明顺序、同标签内层→本层→外层）');
    eq(flat(F.extractFor(f.hitNode, labels, 'all')).join('~'), all.join('~'),
      '★ 旧值 all 归一成 self+inner+outer，结果逐字一致');
  });

  await test('★ 非法 / 缺失的 fetchScope 一律归一成**旧口径 auto**（不抛、不变空、不悄悄改行为）', () => {
    const f = threeLevels();
    /* ⚠️ K79 决策：缺键 / 空 / 全非法 → **`auto`**（就近优先、只取一层）。
     * 这个键是 2.0.0.1 才加的 ⇒ 缺键只可能来自"那时之前存的配置"，当时口径就是 auto；
     * 归一处改成 self 会让这些配置**悄悄少抓外层字段**。「默认＝当前层」由编辑器 `def` 承担。 */
    for (const bad of [undefined, null, '', 'x', 0, 'outer2', 'SELF-ISH']) {
      eq(flat(F.extractFor(f.hitNode, '驳回原因', bad)).join('~'), '驳回原因=内层驳回',
        'scope=' + JSON.stringify(bad) + ' 应归一成 auto（本层有就用本层）');
      eq(flat(F.extractFor(f.hitNode, '只在外层', bad)).join('~'), '只在外层=外层独有',
        'scope=' + JSON.stringify(bad) + ' ⇒ auto 允许外扩（与 2.0.0.1 的缺省行为一致）');
    }
    /* 大小写不敏感：`SELF` / `OUTER1` 是**合法值的另一种写法**，不是非法值 */
    eq(flat(F.extractFor(f.hitNode, '只在外层', 'SELF')).length, 0, 'SELF → self（当前层，抓不到"只在外层"）');
    eq(flat(F.extractFor(f.hitNode, '驳回原因', 'OUTER1'))[0], '驳回原因（外层）=中层驳回', 'OUTER1 → outer（外层方向）');

    /* 归一函数本身（读 / 写 / 消费三处共用这一个） */
    eq(Config.normalizeFetchScope('SELF'), 'self', '大小写不敏感');
    eq(Config.normalizeFetchScope('outermost'), 'outer', '★ 旧值 outermost → outer');
    eq(Config.normalizeFetchScope('outer1'), 'outer', '★ 旧值 outer1 → outer');
    eq(Config.normalizeFetchScope('all'), 'self+inner+outer', '★ 旧值 all → 三方向全选');
    eq(Config.normalizeFetchScope('auto'), 'auto', '★ 旧值 auto **原样保留**（就近一层，存量行为不变）');
    eq(Config.normalizeFetchScope('inner+self'), 'self+inner', '★ 组合值：去重 + 固定顺序（导出/CSV 往返稳定）');
    eq(Config.normalizeFetchScope('x'), 'auto', '★ 非法 → auto（与缺键同判，存量保守）');
    eq(Config.normalizeFetchScope(undefined), 'auto', '★ 缺键 → auto（2.0.0.1 之前的配置照旧）');
    eq(Config.normalizeFetchScope('self'), 'self', '★ 显式 self 原样（新建关键词的默认就是它，见 FieldMap def）');
  });

  suite('K74 · A5 图片识别取图与抓取同源');

  await test('★ cellsForHit：外层方向取外层值格的图；三方向全选时内外的图都在', () => {
    const imgOuter = H.el('img', { src: 'https://ex.com/outer.png', alt: '外层图' });
    const imgInner = H.el('img', { src: 'https://ex.com/inner.png', alt: '内层图' });
    const inner = buildTable([['截图', { nodes: [imgInner] }], ['命中', '你好']]);
    const outer = buildTable([['截图', { nodes: [imgOuter] }], ['详情', { table: inner }]]);
    const node = textNodeIn(inner._trs[1].children[1]);

    const bySelf = F.cellsForHit(node, { meta: { fetchLabels: '截图', fetchScope: 'self' } });
    eq(bySelf.length, 1);
    eq(bySelf[0].imgs.length, 1, 'self 只取本层的值格图');
    eq(bySelf[0].imgs[0].getAttribute('src'), 'https://ex.com/inner.png');

    const byOuter = F.cellsForHit(node, { meta: { fetchLabels: '截图', fetchScope: 'outer' } });
    eq(byOuter.length, 1);
    eq(byOuter[0].imgs[0].getAttribute('src'), 'https://ex.com/outer.png',
      '★ 外层方向取的是**外层**值格里的图（与抓取同源）');
    const byOuter1 = F.cellsForHit(node, { meta: { fetchLabels: '截图', fetchScope: 'outer1' } });
    eq(byOuter1.length, 1, '★ 旧值 outer1 归一成 outer，取图结果一致');
    eq(byOuter1[0].imgs[0].getAttribute('src'), 'https://ex.com/outer.png');

    const byAll = F.cellsForHit(node, { meta: { fetchLabels: '截图', fetchScope: 'all' } });
    const srcs = byAll.reduce((acc, f) => acc.concat(f.imgs.map((im) => im.getAttribute('src'))), []);
    eq(srcs.join('~'), 'https://ex.com/inner.png~https://ex.com/outer.png',
      '★ 三方向全选（旧值 all）下内外的图都要在（按层序由内向外）');
    void outer;
  });

  await test('★ 只传 labels 字符串时 scope 缺键＝auto（存量兼容）；显式 self/outer 各自生效', () => {
    const inner = buildTable([['命中', '你好']]);
    const outer = buildTable([['截图', { nodes: [H.el('img', { src: 'https://ex.com/o.png' })] }], ['详情', { table: inner }]]);
    const node = textNodeIn(inner._trs[0].children[1]);
    const got = F.cellsForHit(node, '截图');
    eq(got.length, 1, '★ 缺键 ≡ auto：本层没有「截图」⇒ 外扩到外层（2.0.0.1 的行为一字不变）');
    eq(got[0].imgs[0].getAttribute('src'), 'https://ex.com/o.png');
    const selfOnly = F.cellsForHit(node, { meta: { fetchLabels: '截图', fetchScope: 'self' } });
    eq(selfOnly.length, 0, '★ 显式 self ＝当前层：本层没有就**不**外扩');
    void outer;
  });

  suite('K74 · §四.8 缓存不得串味（键含行号与 scope）');

  await test('★ 同表不同行：blockFor 两次结果必须各自正确（旧键 root+labels 会串味）', () => {
    /* 每行一对「驳回原因|值」，命中在第 1 行与第 3 行的**第 3 格**里 */
    const t2 = buildTable([
      ['驳回原因', '第一行的值', '你好'],
      ['备注', 'x', 'y'],
      ['驳回原因', '第三行的值', '你好']
    ]);
    const hit0 = textNodeIn(t2._trs[0].children[2]);
    const hit2 = textNodeIn(t2._trs[2].children[2]);
    const cache = new WeakMap();
    const a = F.blockFor(hit0, '驳回原因', cache, 'auto');
    const b = F.blockFor(hit2, '驳回原因', cache, 'auto');
    truthy(a && a.indexOf('第一行的值') >= 0, '第 1 行的命中要拿到第 1 行的值，实际 ' + JSON.stringify(a));
    truthy(b && b.indexOf('第三行的值') >= 0,
      '★ 第 3 行的命中要拿到第 3 行的值（缓存键漏掉行号时这里会拿到第 1 行的值），实际 ' + JSON.stringify(b));
    /* 同一行再问一次 → 命中缓存且结果一致 */
    eq(F.blockFor(hit0, '驳回原因', cache, 'auto'), a, '同一行再问一次结果一致（走缓存）');
  });

  await test('★ 同表同 labels、不同 scope：缓存必须分清（键漏 scope 时会错）', () => {
    const inner = buildTable([['驳回原因', '内层值'], ['命中', '你好']]);
    const outer = buildTable([['驳回原因', '外层值'], ['详情', { table: inner }]]);
    const node = textNodeIn(inner._trs[1].children[1]);
    const cache = new WeakMap();
    const self = F.blockFor(node, '驳回原因', cache, 'self');
    const outerScope = F.blockFor(node, '驳回原因', cache, 'outermost');
    truthy(self && self.indexOf('内层值') >= 0, 'self → 内层值，实际 ' + JSON.stringify(self));
    truthy(outerScope && outerScope.indexOf('外层值') >= 0,
      '★ outermost → 外层值（键漏 scope 时第二次会拿到 self 的缓存结果），实际 ' + JSON.stringify(outerScope));
    eq(F.blockFor(node, '驳回原因', cache, 'self'), self, '再问 self 仍一致');
    void outer;
  });

  await test('★ 不传 cache 时逐次计算，结果与带 cache 完全一致（诊断路径）', () => {
    const f = threeLevels();
    for (const sc of ['auto', 'self', 'outer1', 'outermost', 'all']) {
      const withCache = F.blockFor(f.hitNode, '驳回原因|共同', new WeakMap(), sc);
      const noCache = F.blockFor(f.hitNode, '驳回原因|共同', null, sc);
      eq(noCache, withCache, 'scope=' + sc + '：带 cache 与不带 cache 必须一致');
    }
  });
};
