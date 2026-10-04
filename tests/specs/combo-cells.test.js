/* tests/specs/combo-cells.test.js — 组合词结构原语：`dataRows` 的 thead 不变式
 * ----------------------------------------------------------------------------
 * 回归背景（K40）：el-table 的表头表是「**纯 thead、无 tbody**」，表头与数据分属两张 `<table>`。
 * 多级表头（`thead.is-group` 有两行）时，旧 `dataRows` 只排除「命中那一行」，
 * 把**上层表头行**当数据行返回 → `columnDataCells` 提前 return → 跨表定位被短路
 * → 上下格组合词**整列失效**（用户实测缺陷，1.99.99.3 修复）。
 *
 * 这里锁死那条不变式：**thead 里的行永远是表头，绝不作数据行**。
 * 单级表头时旧实现"恰好"返回空所以看不出问题，因此必须显式覆盖多级表头。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/** el-table 表头表：纯 thead（无 tbody）、thead 两行（分组表头）。dataRows 只读这些字段，普通对象即可 */
function headerOnlyTable() {
  const upper = { cells: [{ tagName: 'TH', colSpan: 2 }, { tagName: 'TH', colSpan: 2 }] };
  const lower = { cells: [{ tagName: 'TH' }, { tagName: 'TH' }, { tagName: 'TH' }, { tagName: 'TH' }] };
  return { tHead: { rows: [upper, lower] }, tBodies: [], rows: [upper, lower] };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const Cells = KH.Cells;

  suite('combo-cells · 数据行判定（K40 不变式）');

  await test('★ 多级表头的表头表（纯 thead）：除命中行外，其它表头行也不得算数据行', () => {
    const table = headerOnlyTable();
    const rows = Cells.dataRows(table, table.tHead.rows[1]);   // 命中列标题在**下层**行
    eq(rows.length, 0,
      '表头表里没有数据行 —— 必须返回空，调用方才会落到 columnInOtherTable 做跨表定位');
    truthy(Cells.dataRows(table, table.tHead.rows[0]).length === 0,
      '命中行换成上层时同样为空（与命中哪一行无关）');
  });

  await test('★ 正常表（thead + tbody）：数据行 = tbody 行，表头行不算', () => {
    const head = { cells: [{ tagName: 'TH' }] };
    const d1 = { cells: [{ tagName: 'TD' }] };
    const d2 = { cells: [{ tagName: 'TD' }] };
    const table = { tHead: { rows: [head] }, tBodies: [{ rows: [d1, d2] }], rows: [head, d1, d2] };
    const rows = Cells.dataRows(table, head);
    eq(rows.length, 2);
    truthy(rows[0] === d1 && rows[1] === d2, '应原样返回 tbody 的两行');
  });

  await test('无 thead 的裸表：数据行照旧能取到（加固不得收缩既有能力）', () => {
    const d1 = { cells: [{ tagName: 'TD' }] };
    const d2 = { cells: [{ tagName: 'TD' }] };
    const table = { tHead: null, tBodies: [], rows: [d1, d2] };
    eq(Cells.dataRows(table, null).length, 2);
  });

  await test('横跨全表的"标题行"仍被排除（K32 既有口径不得被破坏）', () => {
    const title = { cells: [{ tagName: 'TD', colSpan: 2 }] };
    const d1 = { cells: [{ tagName: 'TD' }, { tagName: 'TD' }] };
    const table = { tHead: null, tBodies: [], rows: [title, d1] };
    const rows = Cells.dataRows(table, null);
    eq(rows.length, 1);
    truthy(rows[0] === d1, '整行一格的标题行不是数据行');
  });

  await test('跨表取列用视觉列对齐（colspan 安全），不是数组下标', () => {
    /* 数据行首格 colspan=2 → 「第 2 视觉列」落在第 2 个格（下标 1）上，数组下标会取错列 */
    const t = {
      rows: [{ cells: [{ tagName: 'TD', colSpan: 2 }, { tagName: 'TD', colSpan: 1 }] }]
    };
    const cells = Cells.columnTdCells(t, 2);
    eq(cells.length, 1);
    truthy(cells[0] === t.rows[0].cells[1], '视觉列 2 应落在第 2 个格上');
  });
};
