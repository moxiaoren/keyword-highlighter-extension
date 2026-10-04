/* tests/specs/combo-cell-offset.test.js — 左右组合词「指定取值格（右起，按视觉列）」
 * ----------------------------------------------------------------------------
 * 新能力：关键词可填**取值格表达式** `cellOffset`，表达"标签格右边第几视觉列/哪几列"。
 * 四条用户口径（必须逐条锁死）：
 *   ① **按视觉列计数**，且只在本行内数（行与行列数可以不同；合并单元格按 colSpan 占多列）；
 *   ② **超出范围 → 不判命中**（不退化成"最后一个格"，也不跨行去找）；
 *   ③ **多格 → 任一命中**；同一处命中不得重复计数；
 *   ④ 抓取字段（`fetchLabels` / `#图`）逻辑完全不受影响。
 *
 * 另有两条刻意的设计差异（注释在 cells.js / combo.js，这里用用例钉住）：
 *   · **留空 = 旧行为**：`Cells.nextCell`（相邻、**跳过纯空格子**）；
 *   · **显式 `1` = 右边第 1 个视觉列所在的格**：右邻是空格子时与"留空"结果不同。
 * 非法输入（`abc` / `0` / `1-` / `1,,2`）**回退旧行为**（不静默失效）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;
  const S = KH.Scanner;
  const Cells = KH.Cells;

  /** dispatch 只需要一个"够用"的配置：视觉解析会读 groups / highlightStyle */
  const CFG = {
    keywords: [], groups: [],
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    matchSettings: {}
  };

  /** 关键词基底（与 match-parity 的 kwBase 同口径：字段齐全，避免 dispatch 读到 undefined） */
  const kwBase = (text, extra) => Object.assign({
    id: 'K', text: text, note: '', groupId: null, enabled: true,
    caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
    important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
    cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr',
    cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
    fetchLabels: '', imgOcr: false, imgOcrMax: '', cellOffset: ''
  }, extra || {});

  /**
   * 一行装置：`[{ text: '资质类型' }, { text: '甲级' }]` → 真表格的一行（首格＝标签格）。
   * `colspan` 显式写在元素上（垫片的属性不反射 `colSpan`，真 DOM 里才有反射）。
   */
  function row(cellsSpec) {
    const tds = cellsSpec.map((s) => {
      const td = H.el('td', null, [s.text == null ? '' : s.text]);
      if (s.colspan > 1) td.colSpan = s.colspan;
      return td;
    });
    const tr = H.el('tr', null, tds);
    const tbody = H.el('tbody', null, [tr]);
    const table = H.el('table', null, [tbody]);
    table.tBodies = [tbody];
    return { root: H.el('div', null, [table]), tr: tr, cells: tds };
  }

  /** 跑一次 combo-lr：返回命中所在文本节点的文本（"命中落在哪个格子"一目了然） */
  function run(cellsSpec, extra, options) {
    const f = row(cellsSpec);
    const rule = C.dispatch(kwBase('核心', extra), CFG);
    truthy(rule, '应编译出 combo-lr 规则' + (extra && extra.cellOffset ? '（cellOffset=' + extra.cellOffset + '）' : ''));
    eq(rule.kind, 'combo-lr', '必须是左右格组合词');
    const hits = S.scan(f.root, [rule], options);
    return {
      f: f,
      rule: rule,
      got: hits.filter(h => h.rule && h.rule.ruleId === 'K').map(h => (h.node && h.node.nodeValue) || '')
    };
  }

  /* ================================================================= 原语层 */

  suite('combo-cell-offset · 表达式解析与取格原语');

  await test('★ 解析：单值 / 区间 / 列表 / 混写（含去重与空格容忍）', () => {
    const P = Cells.parseCellOffsets;
    eq(JSON.stringify(P('2')), JSON.stringify([2]));
    eq(JSON.stringify(P('1-3')), JSON.stringify([1, 2, 3]));
    eq(JSON.stringify(P('1,3,5')), JSON.stringify([1, 3, 5]));
    eq(JSON.stringify(P('1-3,5')), JSON.stringify([1, 2, 3, 5]), '区间与单值可混写');
    eq(JSON.stringify(P(' 2 , 4 ')), JSON.stringify([2, 4]), '允许逗号/区间两侧空格');
    eq(JSON.stringify(P('3-1')), JSON.stringify([1, 2, 3]), '区间写反按区间处理');
    eq(JSON.stringify(P('2,2')), JSON.stringify([2]), '重复值去重');
  });

  await test('★ 解析：空 / 非法 → null（调用方据此回退旧行为）', () => {
    const P = Cells.parseCellOffsets;
    const bad = ['', '   ', null, undefined, 'abc', '0', '1-', '-1', '1,,2', ',1', '1,', '1.5', '1-3,a', '1-99999'];
    const wrong = bad.filter(s => P(s) !== null);
    eq(wrong.length, 0, '这些写法都必须判为"无法解析"：' + JSON.stringify(wrong));
  });

  await test('★ 取格：valid / ok / cells 三个出口的语义（越界 = ok:false，不是"最后一个格"）', () => {
    const f = row([{ text: '资质类型' }, { text: '甲级' }, { text: '乙级' }]);
    const label = f.cells[0];

    const g2 = Cells.cellsAtOffsets(label, '2');
    eq(g2.valid, true, '合法表达式 → valid');
    eq(g2.ok, true);
    eq(g2.cells.length, 1);
    truthy(g2.cells[0] === f.cells[2], '第 2 视觉列＝第 3 个格（乙级）');

    const g9 = Cells.cellsAtOffsets(label, '9');
    eq(g9.valid, true, '越界仍然是"合法表达式"');
    eq(g9.ok, false, '全部越界 → ok:false');
    eq(g9.cells.length, 0, '不得退化成"最后一个格"');

    const g1 = Cells.cellsAtOffsets(label, '1');
    truthy(g1.cells[0] === f.cells[1]);

    const gEmpty = Cells.cellsAtOffsets(label, '');
    eq(gEmpty.valid, false, '留空 → valid:false（＝旧行为）');
    eq(gEmpty.ok, false);
    eq(gEmpty.cells.length, 0);

    const gBad = Cells.cellsAtOffsets(label, 'abc');
    eq(gBad.valid, false, '无法解析 → valid:false（＝旧行为）');
  });

  await test('★ 只在本行内取：上一行/下一行的格子绝不能被选中（不跨行）', () => {
    const tr1 = H.el('tr', null, [H.el('td', null, ['资质类型']), H.el('td', null, ['甲级'])]);
    const tr2 = H.el('tr', null, [H.el('td', null, ['别的标题']), H.el('td', null, ['核心']), H.el('td', null, ['多余'])]);
    const tbody = H.el('tbody', null, [tr1, tr2]);
    const table = H.el('table', null, [tbody]);
    table.tBodies = [tbody];
    const label = tr1.children[0];

    const g3 = Cells.cellsAtOffsets(label, '3');       // 本行只有 2 格 → 越界
    eq(g3.ok, false, '第 3 视觉列在本行不存在 → 不命中（下一行有第 3 格也不算）');
    eq(g3.cells.length, 0);
    truthy(Cells.cellsAtOffsets(label, '1').cells[0] === tr1.children[1], '本行内的第 1 格仍要能取到');
  });

  /* ================================================================= 行为层 */

  suite('combo-cell-offset · 左右格组合词（端到端扫描）');

  await test('★ 留空 = 旧行为：右邻空格子被跳过（能力不得回退）', () => {
    const r = run([{ text: '资质类型' }, { text: '' }, { text: '核心' }], { cellOffset: '' });
    eq(JSON.stringify(r.got), JSON.stringify(['核心']), '留空时仍按旧的 nextCell（跳空）取格');
    eq(r.rule.meta.cellOffset, '', 'meta.cellOffset 空串 = 旧行为');
  });

  await test('★ 显式 `1` 与"留空"刻意不同：空格子不再被跳过', () => {
    const cells = [{ text: '资质类型' }, { text: '' }, { text: '核心' }];
    eq(run(cells, { cellOffset: '1' }).got.length, 0,
      '显式 1 = 右边第 1 个视觉列所在的格（那个空格子）→ 不判命中');
    eq(run(cells, { cellOffset: '2' }).got.length, 1,
      '第 2 视觉列才是"核心" → 命中');
  });

  await test('★ `2`：命中落在"右边第 2 个视觉列"那一格（不是相邻格）', () => {
    const cells = [{ text: '资质类型' }, { text: '甲级' }, { text: '核心' }];
    const r = run(cells, { cellOffset: '2' });
    eq(JSON.stringify(r.got), JSON.stringify(['核心']), '第 2 视觉列＝核心格');
    eq(run(cells, { cellOffset: '1' }).got.length, 0, '第 1 视觉列＝甲级（不含核心）→ 不命中');
  });

  await test('★ `1-3`：任一命中（核心在第 2 格就命中，且只算一条）', () => {
    const cells = [{ text: '资质类型' }, { text: 'x' }, { text: '核心' }, { text: 'y' }];
    eq(JSON.stringify(run(cells, { cellOffset: '1-3' }).got), JSON.stringify(['核心']),
      '三个候选格里任一命中 → 命中');
    eq(run(cells, { cellOffset: '1-1' }).got.length, 0, '只选第 1 格时不命中（限定确实生效）');
  });

  await test('★ `1,3`：列表取格（核心在第 3 格 → 命中）', () => {
    const cells = [{ text: '资质类型' }, { text: 'x' }, { text: 'y' }, { text: '核心' }];
    eq(JSON.stringify(run(cells, { cellOffset: '1,3' }).got), JSON.stringify(['核心']));
    eq(run(cells, { cellOffset: '1' }).got.length, 0, '只选第 1 格 → 不命中');
    eq(run(cells, { cellOffset: '3' }).got.length, 1, '只选第 3 格 → 命中');
  });

  await test('★ `1-3,5`：区间与列表混写（核心在第 5 格 → 命中）', () => {
    const cells = [{ text: '资质类型' }, { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: '核心' }];
    eq(JSON.stringify(run(cells, { cellOffset: '1-3,5' }).got), JSON.stringify(['核心']));
    eq(run(cells, { cellOffset: '1-3' }).got.length, 0, '只写区间时不含第 5 格 → 不命中');
  });

  await test('★ 越界不命中：本行列数不够 → 0 条（不退化成最后一个格）', () => {
    const cells = [{ text: '资质类型' }, { text: '核心' }];
    eq(run(cells, { cellOffset: '3' }).got.length, 0, '第 3 视觉列不存在 → 不命中');
    eq(run(cells, { cellOffset: '2-4' }).got.length, 0, '区间整体越界 → 不命中');
    eq(run(cells, { cellOffset: '5,1' }).got.length, 1, '部分越界不影响有效项（第 1 格命中）');
  });

  await test('★ colspan 视觉列计数：右侧格横跨两列时按视觉列推进', () => {
    /* 视觉列：标签[0]、A[1,2]（colspan=2，文本"核心"）、x[3] */
    const cells = [{ text: '资质类型' }, { text: '核心', colspan: 2 }, { text: 'x' }];
    eq(run(cells, { cellOffset: '3' }).got.length, 0, '第 3 视觉列是 x（不是被跳过的 A）');
    eq(run(cells, { cellOffset: '2' }).got.length, 1, '第 2 视觉列仍落在 A 上 → 命中');
    eq(JSON.stringify(run(cells, { cellOffset: '1-2' }).got), JSON.stringify(['核心']),
      '1-2 都落在同一个格（A）上：去重后只算一条');
    eq(run(cells, { cellOffset: '1-3' }).got.length, 1, '区间含 x 也不重复计数（同一处命中只登记一次）');
  });

  await test('★ 合并的标签格（colspan）：右起从标签格最后一列之后算', () => {
    /* 视觉列：标签[0,1]（colspan=2）、x[2]、核心[3] */
    const cells = [{ text: '资质类型', colspan: 2 }, { text: 'x' }, { text: '核心' }];
    eq(JSON.stringify(run(cells, { cellOffset: '2' }).got), JSON.stringify(['核心']),
      '标签格占两列 → 右边第 2 格＝视觉列 3');
    eq(run(cells, { cellOffset: '1' }).got.length, 0, '右边第 1 格＝视觉列 2＝x（不含核心）');
  });

  await test('★ 非法输入回退旧行为（不静默失效）', () => {
    const cells = [{ text: '资质类型' }, { text: '' }, { text: '核心' }];
    for (const bad of ['abc', '0', '1-', '1,,2']) {
      eq(run(cells, { cellOffset: bad }).got.length, 1,
        '`' + bad + '` 无法解析 → 按旧行为（相邻、跳空）取到"核心"');
    }
  });

  await test('★ 编译期：cellOffset 进 meta（未设/空白 → 空串）', () => {
    const C2 = KH.Compiler;
    eq(C2.dispatch(kwBase('核心', { cellOffset: '2' }), CFG).meta.cellOffset, '2');
    eq(C2.dispatch(kwBase('核心', {}), CFG).meta.cellOffset, '', '未设 → 空串（旧行为）');
    eq(C2.dispatch(kwBase('核心', { cellOffset: '   ' }), CFG).meta.cellOffset, '', '纯空白 → 空串');
  });

  await test('★ K75：组合词 Probe **不再**为图片识别登记锚点（锚点只来自真命中）', () => {
    /* 【口径作废】这条用例原来断言"填了取值格表达式 → `ctx.imgAnchors` 里有一个锚点、
     * 取值格 = 选中的第 2 视觉列"。那是 K53 的旧口径（OCR 是组合词专属、标题词定位到格就登记锚点），
     * 与 .41 起"图片命中 = 「抓取后续字段」的一个分支、以规则命中为前提"自相矛盾 ——
     * 于是"没命中也在跑 OCR"（用户实测报的 ③）。
     * 现在：Probe 不产出任何锚点；OCR 的锚点由**命中**给出（`img-ocr.js` 的 `anchorsFor` 只看 hits），
     * 取图一律走 `Fetch.cellsForHit(命中格, rule.meta)`（K74 的 `fetchScope` 也在这条路上）。 */
    const cells = [{ text: '资质类型' }, { text: '甲级' }, { text: '核心' }];
    const f = row(cells);
    const rule = C.dispatch(kwBase('核心', { imgOcr: true, cellOffset: '2' }), CFG);
    const ctx = {};
    const hits = S.scan(f.root, [rule], { ctx });
    eq((ctx.imgAnchors || []).length, 0, '★ Probe 不许再登记图片锚点（ctx.imgAnchors 应为空）');
    truthy(hits.some(h => h.rule && h.rule.ruleId === 'K'), '真命中照旧产生（命中格就是 OCR 的锚点来源）');

    /* 相反的一面：核心词只在图里、页面上没有 → **一条命中都没有** ⇒ 也就没有锚点 */
    const f2 = row([{ text: '资质类型' }, { text: '与核心词无关' }]);
    const rule2 = C.dispatch(kwBase('核心', { imgOcr: true, cellOffset: '2' }), CFG);
    const ctx2 = {};
    S.scan(f2.root, [rule2], { ctx: ctx2 });
    eq((ctx2.imgAnchors || []).length, 0, '没命中 ⇒ 没有任何图片锚点');
  });

  await test('★ 字段落盘：fieldmap 声明 ↔ sanitizeKeyword 手写白名单必须都认它（否则保存后设置丢失）', () => {
    const FM = KH.FieldMap;
    truthy(FM.byKey('cellOffset'), 'fieldmap 必须声明 cellOffset 字段');
    eq(FM.byKey('cellOffset').sec, 'combo', '归在「单元格组合」分区');
    const stored = FM.toStore({ text: '核心', cellVerifyEnabled: true, cellVerify: '资质类型', cellOffset: '1-3,5' }, KH.Config.defaults);
    const k = KH.Store.sanitizeKeyword(stored, KH.Config.defaults);
    eq(k.cellOffset, '1-3,5', '保存链路不得清洗掉 cellOffset');
    const rt = FM.roundTrip(k, KH.Config.defaults);
    truthy(rt.ok, '表单 ⇄ 存储 往返必须一致：' + rt.diffs.join('、'));
  });

  await test('★ 上下格（tb）不受影响：填了 cellOffset 也仍按整列取格', () => {
    const head = H.el('tr', null, [H.el('th', null, ['资质类型']), H.el('th', null, ['备注'])]);
    const d1 = H.el('tr', null, [H.el('td', null, ['核心']), H.el('td', null, ['x'])]);
    const d2 = H.el('tr', null, [H.el('td', null, ['无关']), H.el('td', null, ['核心'])]);
    const thead = H.el('thead', null, [head]);
    const tbody = H.el('tbody', null, [d1, d2]);
    const table = H.el('table', null, [thead, tbody]);
    /* 垫片不反射 `tHead.rows` / `tBodies.rows`（真 DOM 里是自动的），显式补上 */
    thead.rows = [head]; tbody.rows = [d1, d2];
    table.tHead = thead; table.tBodies = [tbody];
    const root = H.el('div', null, [table]);

    const rule = C.dispatch(kwBase('核心', { comboAxis: 'tb', cellOffset: '3' }), CFG);
    eq(rule.kind, 'combo-tb');
    const hits = S.scan(root, [rule]).filter(h => h.rule && h.rule.ruleId === 'K');
    eq(hits.length, 1, 'tb 轴只取"资质类型"那一列的数据格（cellOffset 对它无效）');
    eq(hits[0].node.nodeValue, '核心');
  });

  await test('★ 抓取字段（fetch-only）不受影响：触发判据仍用不跳空格的右邻', () => {
    /* 仅抓取：无核心词 + 有标题词 + 有抓取字段。触发判据是 `KH.Fetch.triggerOk`（本用例只钉"填了
     * cellOffset 也不改变它"）—— 右格有内容时**仍然**登记一条抓取锚点。 */
    const cells = [{ text: '资质类型' }, { text: '某某公司' }];
    const f = row(cells);
    const rule = C.dispatch(kwBase('', { cellOffset: '3', fetchLabels: '名称' }), CFG);
    eq(rule.kind, 'fetch-only', '空核心 + 抓取字段 = 仅抓取');
    const hits = S.scan(f.root, [rule]).filter(h => h.rule && h.rule.ruleId === 'K');
    eq(hits.length, 1, '抓取注册不受 cellOffset 影响（越界也不改变触发判据）');
    falsy(rule.visual, '仅抓取不渲染（D2）');
  });
};
