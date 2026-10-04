/* ============================================================================
 * src/features/combo/cells.js · 单元格 / 行 / 列 结构解析（组合词专用原语）
 * ----------------------------------------------------------------------------
 * 为什么单独一层：
 *   组合词的定位不是"文本匹配"，而是"结构定位 + 文本匹配"：
 *     · 左右格（lr）：左格标题命中 → 取右格 → 在右格里匹配核心词
 *     · 上下格（tb）：表头格命中 → 定位该列全部数据格 → 在数据格里匹配核心词
 *   这一层只回答"谁是格子 / 谁是表头 / 这一列有哪些数据格"，不做任何匹配、
 *   不写注册表、不渲染 —— 于是 lr / tb / 抓取字段三种功能共用同一套结构解析
 *   （旧版这部分散在 keyword-engine.js:229-410 的 8 个私有方法里，各自只服务一个调用点）。
 *
 * 与旧版的对应关系（逐条沿用其启发式，不重新发明）：
 *   cellOf            ← _fakeHeaderCell (256)
 *   columnDataCells   ← _locateColumnForHeader + _dataRows + _findColumnInOtherTable (231-402)
 *                       「仅表头生效」守卫**只保留在真 table 分支**（旧版就是这么写的）
 *   fakeColumnCells   ← _locateColumnInFakeTable (_locateColumnInFakeTableByGeo 几何兜底) (269-308)
 *   columnLabel       ← 旧版无对应物（旧版抓取字段走"标签文本找容器"），v2 新增，
 *                       供"把列映射回表头文字"用；一并补上旧版在假表格上没做的形态区分
 *   fakeContainerOf / fakeRowOf / isFakeHeaderCell
 *                     ← 旧版把"行容器形式"和"扁平形式"混在 _locateColumnInFakeTable 里，
 *                       这里显式拆开（display:grid 的格子是容器的直接子元素，没有"行"这一层）
 *
 * 【铁律 3 的边界说明】这里确实会读 DOM 结构（closest / children / 几何），
 *   但它是**扫描期的上下文定位**，不是"用 DOM 反查命中"：
 *   命中仍然只由 (textNode, start, end) 三元组表示，交互定位仍只走
 *   `pointToRange()` + `registry.query()`，全库不写任何 `data-kh-*` 数据载体。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /* 这里**刻意不再有** SKIP_TAGS / isOwnUI 这类"哪些文本可扫描"的判据 ——
   * 那份判据只有内核 `collectTextNodes` 一份（见下面的 textNodesIn）。 */

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    // 不用 getComputedStyle（全页遍历太贵）：只做便宜的可见性/尺寸判断
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!r && !r.width && !r.height;
  }

  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return (r.width || r.height) ? r : null;
  }

  /* ---------------- 按 scan 的结果缓存（V1.99.99.15 性能体检） ----------------
   * 【为什么】组合词探针是**按规则**跑的，而"格内文本节点 / 文本属于哪个格子 / 表头列的数据格"
   * 这三件事只跟 DOM 有关、与规则无关 —— 旧实现每条组合词规则都要重算一遍：
   * 实测 2000 行页面（12007 个文本节点）里 combo-lr 507ms + combo-tb 444ms，占整个 scan 的 **80%**。
   * 【为什么安全】缓存挂在**本次 scan 的 ctx** 上（`Scanner.scan` 每次新建 ctx）：
   * DOM 变了就是下一轮 scan、换一份新缓存，不存在跨轮陈旧。没有 ctx（单测直接调）则不缓存。
   */
  function cacheOf(ctx, name) {
    if (!ctx || typeof ctx !== 'object') return null;
    if (!ctx.__cellsCache) ctx.__cellsCache = {};
    if (!ctx.__cellsCache[name]) ctx.__cellsCache[name] = new WeakMap();
    return ctx.__cellsCache[name];
  }
  function cached(ctx, name, key, make) {
    const c = cacheOf(ctx, name);
    if (!c || key == null) return make();
    if (c.has(key)) return c.get(key);
    const v = make();
    c.set(key, v);
    return v;
  }

  /**
   * 单元格内的可扫描文本节点。
   *
   * **必须委托内核**（`Scanner.util.textNodesIn` = `collectTextNodes`）：
   * "哪些文本算可扫描"只有一份判据（跳过 script/style/textarea、插件自身 UI、可编辑区、空文本），
   * 组合词与普通词必须扫到**完全相同的文本**。旧实现在这里又抄了一份过滤器 ——
   * 两份只要有一处走偏，就会出现"同一个词，普通规则亮、组合规则不亮"（v1.99.99.8 实测缺陷）。
   * meta-check 有红线禁止本文件再自建 TreeWalker。
   */
  function textNodesIn(el, ctx) {
    return cached(ctx, 'nodes', el, () => {
      const U = (KH.Scanner && KH.Scanner.util) || {};
      if (typeof U.textNodesIn !== 'function') return [];   // 内核未就绪：宁可空，也不静默换一套口径
      return U.textNodesIn(el);
    });
  }

  /**
   * 文本节点 → 所在"格子"元素。
   * 真表格取 td/th；假表格（div/flex/grid/li）取"最近一个其父含 ≥2 个直接子元素的元素"
   * —— 旧版 `_fakeHeaderCell`（v1.51.0）的启发式，逐字沿用：
   * 它能正确识别 `.row > .label + .value`（子元素 ≥2）与 `li > span*`（≥2），
   * 对普通段落（父级是 body）返回 null，所以普通正文不会被误当成格子。
   */
  function cellOf(node, ctx) {
    return cached(ctx, 'cellOf', node, () => {
      const el0 = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el0 || el0.nodeType !== 1) return null;
      const real = el0.closest ? el0.closest('td,th') : null;
      if (real) return real;

      let el = el0;
      while (el && el !== document.body) {
        const p = el.parentElement;
        if (p && p !== document.body && p.children && p.children.length >= 2 &&
            Array.prototype.indexOf.call(p.children, el) >= 0) return el;
        el = p;
      }
      return null;
    });
  }

  /** 右邻格子（左右格组合词用；跳过纯空白文本节点造成的空元素） */
  function nextCell(cell) {
    if (!cell) return null;
    let n = cell.nextElementSibling;
    while (n) {
      if (n.nodeType === 1 && n.textContent && n.textContent.trim()) return n;
      n = n.nextElementSibling;
    }
    return null;
  }

  /**
   * 右邻格子（**不跳过"文本为空"的格子**）—— 图片识别专用原语。
   *
   * 【为什么不能直接用 nextCell】`nextCell` 会跳过 `textContent` 为空的格子（那是给文本命中
   * 用的口径："右格没有文本"就不算命中）。而图片识别的前提恰恰是**值就是一张图、格子里没有文本** ——
   * 真浏览器实测（_e2e/probe-ocr10.js）：值格只有 `<img>` 时 `nextCell` 直接返回 null，
   * 于是"要识别的那一格"被跳过，锚点根本登记不上（面板永远没有图片命中）。
   *
   * 语义 = "同一行里紧挨着的下一个格子"：
   *   · 真表格：下一个 td / th；
   *   · 假表格（div / flex / grid）：格子就是同级元素，直接取下一个（排除 script/style 之类）。
   */
  function nextCellRaw(cell) {
    const n = cell && cell.nextElementSibling;
    if (!n || n.nodeType !== 1) return null;
    const tag = String(n.tagName || '').toUpperCase();
    if (tag === 'TD' || tag === 'TH') return n;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'TEMPLATE') return null;
    if (n.getAttribute && n.getAttribute('data-kh-ext-ui')) return null;
    return n;
  }

  /* ---------------- 真表格原语 ---------------- */

  /**
   * 表头行 = thead 的第一行；没有 thead 时 = **第一条"真表头行"**（见下）。
   *
   * 【为什么要跳过"标题行"】真实站点常见这种结构：
   *   ```
   *   <tr><td colspan="2">某某申请表</td></tr>   ← 整行一格、横跨全表 = 标题
   *   <tr><td>名称</td><td>备注</td></tr>        ← 真正的表头（而且用的是 td）
   *   <tr><td>甲</td><td>x</td></tr>
   *   ```
   * 旧实现直接取 `rows[0]`，于是"标题行"被当成表头 → 真正的表头（td）不再被 `isHeaderCell` 认可
   * → **上下格匹配整列失效**（实测：10 种表格结构里只有这一种不命中，`probe-tb.js`）。
   * 判据取"该行只有 1 个格、且这一格横跨了全表的列数"——标题行的典型特征，误判风险低。
   */
  function isTitleRow(row, colCount) {
    if (!row || !row.cells || row.cells.length !== 1) return false;
    const span = row.cells[0].colSpan || 1;
    return colCount > 1 && span >= colCount;
  }

  /** 全表列数（按"有最多格的行"算，用于识别横跨全表的标题行） */
  function columnCount(table) {
    let max = 1;
    const rows = (table && table.rows) || [];
    for (let i = 0; i < rows.length; i++) {
      const n = (rows[i].cells && rows[i].cells.length) || 0;
      if (n > max) max = n;
    }
    return max;
  }

  function firstHeaderRow(table) {
    if (!table) return null;
    if (table.tHead && table.tHead.rows && table.tHead.rows.length) return table.tHead.rows[0];
    const rows = table.rows || [];
    const cols = columnCount(table);
    for (let i = 0; i < rows.length; i++) {
      if (isTitleRow(rows[i], cols)) continue;      // 标题行不是表头
      return rows[i] || null;
    }
    return rows[0] || null;
  }

  /**
   * 一行的**格子列表**（视觉列计算的唯一取数口）。
   *   · 真表格行：`row.cells`（td/th 集合，带 `colSpan`）；
   *   · 假表格行（div/flex/grid 的"行容器"）：直接子元素，`colSpan` 不存在 → 一律视为 1 列。
   * 为什么假表格也要能算视觉列：取值格表达式（`cellsAtOffsets`）按"右起第几视觉列"取格，
   * 而假表格同样有"这一行有几格"的概念 —— 不补这条，假表格上显式写 `1` 会退化成"留空"。
   */
  function rowCellList(row) {
    if (!row) return [];
    if (row.cells && row.cells.length) return Array.prototype.slice.call(row.cells);
    return row.children ? Array.prototype.slice.call(row.children) : [];
  }

  /**
   * 表头格在整行里的**视觉列序号**（累加前面各格的 colSpan），而不是 `row.cells` 的数组下标。
   *
   * 为什么必须区分：`<tr><th colspan="2">其它</th><th>名称</th></tr>` 里，
   * 「名称」的数组下标是 1，但它实际占的是第 3 列（序号 2）；而数据行是 `<tr><td>a</td><td>b</td><td>甲</td></tr>`
   * → 用下标去取数据列会取到 `b`，与表头错位 → **整列不命中**（极端场景体检实测：M2 用例）。
   */
  function visualColumnIndex(row, cell) {
    let idx = 0;
    const cells = rowCellList(row);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === cell) return idx;
      idx += cells[i].colSpan || 1;
    }
    return -1;
  }

  /** 反向：某行的**第 colIdx 个视觉列**落在哪个格上（跨 colSpan 时返回该格） */
  function cellAtVisualColumn(row, colIdx) {
    let idx = 0;
    const cells = rowCellList(row);
    for (let i = 0; i < cells.length; i++) {
      const span = cells[i].colSpan || 1;
      if (colIdx >= idx && colIdx < idx + span) return cells[i];
      idx += span;
    }
    return null;
  }

  /* ---------------- 取值格表达式（左右组合词"右起第几格"） ---------------- */

  /** 区间展开的**防爆上限**：`1-99999` 这种写法不可能是用户本意，判为非法而不是展开成十万项 */
  const MAX_OFFSET_RANGE = 200;

  /**
   * 解析「取值格表达式」→ 右起偏移量列表（升序、去重）。
   *
   * 语法（用户口径）：`2` ／ `1-3` ／ `1,3,5` ／ `1-3,5`（区间与单值可混写）。
   *   · 偏移量 **k ≥ 1**：`k` = "标签格右边第 k 个**视觉列**"（见 `cellsAtOffsets` 的定位口径）；
   *   · `0` / 负数 / 空项（`1,` / `,1` / `1,,2`）/ 其它字符 → **无法解析**，返回 `null`；
   *   · 区间两端顺序写反（`3-1`）按区间处理（等价 `1-3`），不比这更宽松。
   *
   * 【为什么"无法解析"要返回 null 而不是空列表】口径是"留空 / 无法解析 → 旧行为"：
   * 用户手滑写错一个字符不该让整条规则**静默失效**（那比写成旧行为更难排查），
   * 所以调用方拿到 null 就走原来的"相邻右格"。
   */
  function parseCellOffsets(spec) {
    const s = String(spec == null ? '' : spec).trim();
    if (!s) return null;
    const out = [];
    const parts = s.split(',');
    for (const raw of parts) {
      const p = raw.trim();
      if (!p) return null;                                   // "1," / ",1" / "1,,2"
      let m = /^(\d+)$/.exec(p);
      if (m) {
        const k = parseInt(m[1], 10);
        if (!(k >= 1)) return null;                          // 0 或超长数字
        out.push(k);
        continue;
      }
      m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (m) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (!(a >= 1) || !(b >= 1)) return null;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi - lo > MAX_OFFSET_RANGE) return null;
        for (let k = lo; k <= hi; k++) out.push(k);
        continue;
      }
      return null;                                           // `abc` / `1-` / `-1` / `1.5`
    }
    return Array.from(new Set(out)).sort((x, y) => x - y);
  }

  /**
   * 取值格（左右组合词专用原语）：按「右起第几视觉列」取标签格右侧的一组格。
   *
   * 定位口径（**只在本行内数，绝不跨行**）：
   *   设标签格占据视觉列 `[c0, c0+span-1]`（`c0 = visualColumnIndex`，`span = colSpan`），
   *   则"右边第 k 格" = **覆盖视觉列 `c0 + span - 1 + k` 的那个格**；
   *   本行没有任何格覆盖这一列 → 这一项无效（全部项都无效 → `ok:false`，调用方据此**不判命中**，
   *   绝不退化成"取最后一个格"）。
   *
   * 【`1` 与"留空"刻意不同】留空走旧行为 `nextCell`（**跳过纯空格子**，取"右边第一个有文本的格"），
   * 显式写 `1` 则是"右边第 1 个**视觉列**所在的格" —— 右邻是空格子时前者跳过、后者取它，
   * 有合并单元格（colspan）时两者也会落在不同的格上。这是刻意设计：留空 = 历史行为不变，
   * 显式写数字 = 严格按视觉列（用户要的就是"按列"这个确定性）。
   *
   * @returns {{valid:boolean, ok:boolean, cells:Element[]}}
   *   `valid` = 表达式能解析（空串/非法 → false，调用方回退旧行为）；
   *   `ok`    = 表达式能解析**且**至少取到一个格（越界 → false）；
   *   `cells` = 命中的格（按偏移量升序、去重 —— 同一格被多个偏移量覆盖时只出现一次）。
   */
  function cellsAtOffsets(labelCell, spec) {
    const offsets = parseCellOffsets(spec);
    const res = { valid: !!offsets, ok: false, cells: [] };
    if (!offsets || !labelCell) return res;
    const row = labelCell.parentElement;                     // 只在本行内取（绝不跨行去找）
    if (!row) return res;
    const base = visualColumnIndex(row, labelCell);           // 复用视觉列计算（colspan 安全）
    if (base < 0) return res;                                 // 结构异常：标签格不在本行格列表里
    const span = labelCell.colSpan || 1;
    const seen = new Set();
    for (const k of offsets) {
      const cell = cellAtVisualColumn(row, base + span - 1 + k);
      if (!cell || seen.has(cell)) continue;                  // 去重：同一格只取一次
      seen.add(cell);
      res.cells.push(cell);
    }
    res.ok = res.cells.length > 0;
    return res;
  }

  /**
   * 表的数据行。
   *
   * 【thead 里的行永远是表头，不是数据行】—— 这条不变量是 el-table 上下格组合词的关键：
   * el-table 的**表头表是"纯 thead、无 tbody"**（表头与数据分属两张 `<table>`）。
   * 多级表头（`thead.is-group`，表头有两行 `<tr>`）时，命中列标题的那一行是**下层**：
   *   tBodies 分支因为表头表没有 tbody 而被跳过 → 落到下面的 `table.rows` 兜底循环 →
   *   旧实现只排除 `headerRow`，于是把**上层表头行**当成"数据行"返回。
   * 后果：`columnDataCells` 拿着上层表头格当数据格（非空）→ **提前 return**，
   * 永远走不到 `columnInOtherTable` → 跨表定位失效 → **整列不命中**（用户实测：多级表头 el-table 上
   * 上下格组合词整列失效；单级表头因为兜底循环恰好返回空而正常，所以一直没被发现）。
   */
  function dataRows(table, headerRow) {
    const rows = [];
    const cols = columnCount(table);
    const theadRows = new Set();
    if (table.tHead && table.tHead.rows) {
      for (let i = 0; i < table.tHead.rows.length; i++) theadRows.add(table.tHead.rows[i]);
    }
    const push = (r) => {
      if (r && r !== headerRow && !theadRows.has(r) && !isTitleRow(r, cols)) rows.push(r);
    };
    if (table.tBodies && table.tBodies.length) {
      for (let b = 0; b < table.tBodies.length; b++) {
        const tb = table.tBodies[b];
        for (let i = 0; i < tb.rows.length; i++) push(tb.rows[i]);
      }
      return rows;
    }
    for (let i = 0; i < table.rows.length; i++) push(table.rows[i]);
    return rows;
  }

  /**
   * 某表某列的 td（只取 td，自然跳过表头 th）。
   * 用**视觉列序号**取格（`cellAtVisualColumn`），不用 `children[colIdx]` 数组下标 ——
   * 数据表里若有横跨多列的格（colspan），下标与表头列序号会错位，取到相邻列 → 整列不命中。
   * 这与同表分支 `columnDataCells` 的口径保持一致（那边一直用视觉列对齐）。
   */
  function columnTdCells(table, colIdx) {
    const cells = [];
    if (!table || colIdx < 0) return cells;
    for (let i = 0; i < table.rows.length; i++) {
      const td = cellAtVisualColumn(table.rows[i], colIdx);
      if (td && td.tagName === 'TD') cells.push(td);
    }
    return cells;
  }

  /** 从表头格向上爬到"含 ≥2 个 table 的最近公共祖先"（el-table 的固定表头 = 表头表 + 数据表两块） */
  function findColumnScope(headerCell) {
    const body = document.body;
    let el = (headerCell && headerCell.parentElement) || body;
    while (el && el !== body) {
      if (el.querySelectorAll && el.querySelectorAll('table').length >= 2) return el;
      el = el.parentElement;
    }
    return body;
  }

  /** el-table 结构特征定位数据表（比列序号通用对齐更准，规避无关表误取） */
  function findElTableBody(headerCell, headerTable, scope) {
    const headerWrapper = headerCell.closest ? headerCell.closest('.el-table__header-wrapper') : null;
    if (headerWrapper && headerWrapper.parentElement) {
      const bodyWrapper = headerWrapper.parentElement.querySelector('.el-table__body-wrapper');
      if (bodyWrapper) {
        /* 带固定列（el-table__fixed / el-table__fixed-right）时，wrapper 里可能还有固定列的数据表；
         * 那张表列不全，取错会整列错位 —— 优先挑非固定列的主数据表，实在没有才退回第一张。
         * （Element UI 里固定列表通常在 .el-table__fixed-body-wrapper 下、与 body-wrapper 平级，
         *  但不同版本/主题的 DOM 有差异，这里按 class 判据兜住。）*/
        const cands = bodyWrapper.querySelectorAll('table');
        let pick = null;
        for (let i = 0; i < cands.length; i++) {
          const t = cands[i];
          if (t === headerTable) continue;
          if (String(t.className || '').indexOf('fixed') >= 0) continue;
          pick = t; break;
        }
        if (!pick) {
          const t = bodyWrapper.querySelector('table');
          if (t && t !== headerTable) pick = t;
        }
        if (pick) return pick;
      }
    }
    if (scope && scope.querySelectorAll) {
      const ts = scope.querySelectorAll('table');
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t === headerTable || t.contains(headerCell)) continue;
        const cls = String(t.className || '');
        if (cls.indexOf('el-table__body') >= 0 && cls.indexOf('header') < 0 && cls.indexOf('fixed') < 0) return t;
      }
    }
    return null;
  }

  /** 跨表定位该列数据格：① el-table 结构特征 ② 列名一致 / 列序号对齐 */
  function columnInOtherTable(headerCell, colIndex) {
    const table = headerCell.closest ? headerCell.closest('table') : null;
    const colName = (headerCell.textContent || '').trim();
    const scope = findColumnScope(headerCell);

    const bodyTable = findElTableBody(headerCell, table, scope);
    if (bodyTable) {
      const cells = columnTdCells(bodyTable, colIndex);
      if (cells.length) return cells;
    }
    const tables = scope.querySelectorAll('table');
    for (let t = 0; t < tables.length; t++) {
      const tbl = tables[t];
      if (tbl === table || tbl.contains(headerCell)) continue;
      let idx = -1;
      const head = firstHeaderRow(tbl);
      if (head) {
        idx = Array.prototype.findIndex.call(head.cells, (c) => (c.textContent || '').trim() === colName);
      }
      if (idx < 0) idx = colIndex;      // 回退：两表列序号对齐
      if (idx < 0) continue;
      const cells = columnTdCells(tbl, idx);
      if (cells.length) return cells;
    }
    return [];
  }

  /* ---------------- 假表格原语 ---------------- */

  /** 容器内所有"格子"（行容器形式 `ul>li>span` 取子格；扁平形式 `grid>div` 取直接子元素） */
  function fakeCellsUnder(container) {
    const out = [];
    if (!container || !container.children) return out;
    const kids = Array.from(container.children);
    for (const child of kids) {
      if (child.children && child.children.length >= 2) {
        for (const c of Array.from(child.children)) out.push(c);
      } else {
        out.push(child);
      }
    }
    return out;
  }

  /**
   * 假表格的"容器"元素。两种形态（旧版 v1.51.0 只处理了第 ① 种，第 ② 种是它在
   * 几何兜底里顺带覆盖的，v2 显式区分，避免"扁平容器被当成行"的错判）：
   *   ① 行容器形式 `ul > li > span` / `.tbody > .row > .cell`
   *      —— 格子的父是"行"，行还有**同样带多个子元素的兄弟行** → 容器 = 行的父
   *   ② 扁平形式 `display:grid/flex` 把所有格子铺平，或"单行容器" `.row > div`
   *      —— 格子直属容器 → 容器 = 格子的父
   */
  function fakeContainerOf(cell) {
    const row = cell && cell.parentElement;
    if (!row) return null;
    const parent = row.parentElement;
    if (parent && parent !== document.body && row.children && row.children.length >= 2) {
      let siblingRows = 0;
      for (const s of parent.children) {
        if (s !== row && s.children && s.children.length >= 2) siblingRows++;
      }
      if (siblingRows >= 1) return parent;
    }
    return row;                                   // 扁平形式：父元素本身就是容器
  }

  /** 容器内的"行容器"元素（行容器形式返回行的父下的一行；扁平形式返回 null） */
  function fakeRowOf(cell) {
    const c = fakeContainerOf(cell);
    return c && cell.parentElement !== c ? cell.parentElement : null;
  }

  /** 该格是否是该"假表格"的表头行里的格子 */
  function isFakeHeaderCell(cell) {
    const container = fakeContainerOf(cell);
    if (!container || !container.children) return false;

    // ① 行容器形式：首行即表头（旧版口径）
    const row = fakeRowOf(cell);
    if (row) return container.firstElementChild === row;

    // ② 扁平形式：看容器里是"一排"还是"多排"
    const cells = fakeCellsUnder(container);
    const r = rectOf(cell);
    if (!r || !cells.length) return false;
    let min = Infinity, max = -Infinity;
    for (const c of cells) {
      const rc = rectOf(c);
      if (!rc) continue;
      if (rc.top < min) min = rc.top;
      if (rc.top > max) max = rc.top;
    }
    if (!isFinite(min)) return false;
    // 单排容器（`.row > div` 这类"一行假表"）→ 首格就是标题格
    if (max - min <= 2) return cells[0] === cell;
    // 多排容器（grid 铺平）→ 与容器内最上一排对齐者视为表头
    return r.top <= min + 2;
  }

  /** 假表格：按行结构取同列格子；无兄弟行时退回几何对齐（旧版 _locateColumnInFakeTableByGeo） */
  function fakeColumnCells(headerCell) {
    const headerRow = headerCell.parentElement;
    const colIndex = headerRow ? Array.prototype.indexOf.call(headerRow.children, headerCell) : -1;
    const container = headerRow ? headerRow.parentElement : null;
    const cells = [];
    if (colIndex >= 0 && container && container !== document.body && (container.children || []).length) {
      for (let i = 0; i < container.children.length; i++) {
        const row = container.children[i];
        if (row === headerRow || !row.children || !row.children[colIndex]) continue;
        const cell = row.children[colIndex];
        if (!cell || isHidden(cell)) continue;
        cells.push(cell);
      }
      if (cells.length) return cells;
    }

    // 几何兜底：表头格下方、水平中心对齐的可见格子；去嵌套只留叶子级
    const hr = rectOf(headerCell);
    if (!hr) return [];
    const hcx = hr.left + hr.width / 2;
    const cand = [];
    const els = (document.body || document).querySelectorAll('div,span,li,p,section,td,th,a');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el === headerCell || el.contains(headerCell)) continue;
      if (isHidden(el)) continue;
      const r = rectOf(el);
      if (!r || r.height < 8) continue;
      if (!(el.textContent || '').trim()) continue;
      if (r.top < hr.top - 2) continue;                                        // 必须在下方
      const cx = r.left + r.width / 2;
      if (Math.abs(cx - hcx) > Math.max(hr.width, r.width) * 0.9) continue;     // 同列
      cand.push(el);
    }
    return cand.filter(c => !cand.some(o => o !== c && o.contains(c)));
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 表头格 → 该列的数据格列表。
   *
   * **「仅表头生效」只对真 `<table>` 成立** —— 这是旧版的原始口径，必须分清：
   *   · 真表格（v1.50.0 `_locateColumnForHeader`）：列关键词必须命中在表头行上，
   *     否则"数据区某行碰巧含列关键词文本"会把整列误判成命中 → 这里返回 []。
   *   · 假表格（v1.51.0 `_locateColumnInFakeTable`）：**没有任何表头资格检查**，
   *     直接按"行结构 → 几何对齐"找同列格子。
   * 为什么假表格不检查：div/flex/grid 布局里常常根本没有"行"这一层
   *   （`display:grid` 的格子是容器的直接子元素），无从判断"哪一排是表头"；
   *   旧版因此在假表格上主动放弃了该守卫，v2 沿用（擅自收紧 = 功能收缩）。
   */
  function columnDataCells(headerCell, ctx) {
    if (!headerCell) return [];
    return cached(ctx, 'colCells', headerCell, () => columnDataCellsUncached(headerCell));
  }

  function columnDataCellsUncached(headerCell) {
    const table = headerCell.closest ? headerCell.closest('table') : null;
    if (!table) return fakeColumnCells(headerCell);       // 假表格：不判表头资格
    if (!isHeaderCell(headerCell)) return [];             // 真表格：仅表头生效

    const headerRow = headerCell.closest('tr');
    if (!headerRow) return [];
    const colIndex = visualColumnIndex(headerRow, headerCell);   // 视觉列序号（colspan 安全）
    if (colIndex < 0) return [];

    const cells = dataRows(table, headerRow).map(r => cellAtVisualColumn(r, colIndex)).filter(Boolean);
    if (cells.length) return cells;
    return columnInOtherTable(headerCell, colIndex);   // 表头/数据分属两表（el-table）
  }

  /** 该格是否为"表头格"（真表格语义：TH，或所在行就是表头行） */
  function isHeaderCell(cell) {
    if (!cell) return false;
    const table = cell.closest ? cell.closest('table') : null;
    if (table) {
      if (cell.tagName === 'TH') return true;
      const hdr = firstHeaderRow(table);
      return !!hdr && cell.closest('tr') === hdr;
    }
    return isFakeHeaderCell(cell);
  }

  /** 该格所在列的列标签文本（抓取字段用：把"哪一列"映射回表头文字） */
  function columnLabel(cell) {
    if (!cell) return '';
    const table = cell.closest ? cell.closest('table') : null;
    if (table) {
      const hdr = firstHeaderRow(table);
      if (!hdr || hdr === cell.closest('tr')) return '';
      const idx = Array.prototype.indexOf.call(cell.closest('tr').children, cell);
      const h = hdr.children[idx];
      return h ? (h.textContent || '').trim() : '';
    }
    // 假表：容器内同列、且被判为表头格的那个
    const container = fakeContainerOf(cell);
    if (!container) return '';
    const cells = fakeCellsUnder(container);
    const r = rectOf(cell);
    if (!r) return '';
    for (const c of cells) {
      if (!isFakeHeaderCell(c)) continue;
      const rc = rectOf(c);
      if (!rc) continue;
      if (Math.abs((rc.left + rc.width / 2) - (r.left + r.width / 2)) <= Math.max(rc.width, r.width) * 0.6) {
        return (c.textContent || '').trim();
      }
    }
    return '';
  }

  KH.Cells = {
    cellOf, nextCell, nextCellRaw, rowOf: (cell) => (cell ? cell.parentElement : null),
    isHeaderCell, columnDataCells, columnLabel,
    textNodesIn, isHidden, rectOf,
    firstHeaderRow, dataRows, columnTdCells, fakeCellsUnder, isTitleRow, columnCount, visualColumnIndex, cellAtVisualColumn,
    /* 取值格表达式（左右组合词"指定取值格"）：解析与取格都只在这一层，combo.js 只做策略 */
    parseCellOffsets, cellsAtOffsets,
    fakeContainerOf, fakeRowOf, isFakeHeaderCell
  };
})();
