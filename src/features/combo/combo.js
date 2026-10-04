/* ============================================================================
 * src/features/combo/combo.js · 单元格组合词（匹配能力 · 注册式接入）
 * ----------------------------------------------------------------------------
 * 三种形态，同一套结构原语（cells.js）：
 *   ① combo-lr  左右格：左格标题命中 → 取右格 → 右格内匹配核心词（命中标右格）
 *                取值格可由 `cellOffset` 表达式指定（右起视觉列，如 `2` / `1-3` / `1,3,5`）；
 *                留空 = 旧行为（相邻、跳空格），见下面 combo-lr Probe
 *   ② combo-tb  上下格：表头格命中 → 定位该列数据格 → 数据格内匹配核心词
 *   ③ fetch-only 仅抓取：**核心词为空**、只有标题格作为锚点。
 *                命中登记进注册表但不渲染（D2 决策：完全不渲染），
 *                数据供"重要笔记"消费 —— 与旧版 `_highlightFetchOnly`
 *                （keyword-engine.js:1661，那时它还会 replaceChild 插 span）语义一致，
 *                但**去掉了插 span**（旧版唯一残留的 DOM 改造路径，正是策划案要根治的病根）。
 *
 * 三个关键语义（都来自旧版且必须保留）：
 *   · **标题格本身不高亮**（旧版注释："标题本格不高亮"）→ 标题只做定位，命中标在右侧/下方。
 *   · **仅表头生效**（v1.50.0 guard）：tb 的列标题必须命中在表头格上，
 *     否则"数据区某行碰巧含列标题文本"会把整列误判成命中。
 *   · 空单元格不产生命中 → 值后到（异步填充）时可再次进入匹配补上（ST-05）。
 *     实现上不需要"已处理"缓存：本 Probe 是**纯函数式扫描**（每次重建全量重算），
 *     旧版 `_cellVerified` / `_tbColProcessed` 那两个 WeakMap 因此不再需要 ——
 *     缓存与清理的对称性问题（R3/R4）在结构上被消掉了。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const Cells = KH.Cells;

  /** 内核原语（**匹配唯一真源**：匹配逻辑一律从这里取，本文件不得自建遍历/正则） */
  const util = () => (KH.Scanner && KH.Scanner.util) || {};

  /**
   * 罕见字核心的"单节点匹配"：**逐字判定**，复用整页罕见字那一份实现（`KH.RareChar.scanRare`）。
   * 罕见字没有字面模式（`rule.pattern` 为 null），所以走 `matchKeyword` 的 `matchOne` 口子 ——
   * 遍历/守卫/区间口径仍由内核那一份负责。
   */
  function rareOne(node) {
    if (!KH.RareChar || typeof KH.RareChar.scanRare !== 'function') return [];
    return KH.RareChar.scanRare(node.nodeValue || '')
      .map((h) => ({ start: h.index, end: h.index + h.length, text: h.char }));
  }

  /**
   * 组合词定位体检（**只读计数**，挂在扫描上下文上 —— 一次扫描一个对象，扫完即弃）。
   * ---------------------------------------------------------------------------
   * 用途：页面明明是「审核状态：不通过」，组合词却一条都不命中时，要能一眼分清是哪一步断的：
   *   · `cells` 有值、`labeled` = 0 → **标题词**没在格子里匹配上（词不一致 / 不在格子结构里）；
   *   · `labeled` 有值、`withCore` = 0 → 标题找到了，但**它右边/同列那一格没有核心词**
   *     （定位结构不满足：不是表格 / 合并单元格 / 核心词在别的格）；
   *   · `labeled` 有值、`withCore` 也有值 → 定位成功，命中应该出来了（若仍无命中，问题在更下游）。
   * 上限防爆：只为诊断服务，格子多时也不改行为（计数是常数时间）。
   */
  function comboStat(ctx) {
    const s = (ctx && (ctx._comboStat = ctx._comboStat || {
      cells: 0, labeled: 0, withCore: 0, labeledButNoCore: 0, noRight: 0,
      tbHeaders: 0, tbLabeled: 0, tbCells: 0, tbWithCore: 0
    }));
    return s || { cells: 0, labeled: 0, withCore: 0, labeledButNoCore: 0, noRight: 0, tbHeaders: 0, tbLabeled: 0, tbCells: 0, tbWithCore: 0 };
  }

  /**
   * 取**一个格子内**的核心词命中片段（单节点 + 跨文本节点）。
   *
   * 【为什么不能只逐文本节点跑】用户实测缺陷（v1.99.99.8）：页面为了给半个词上色，把核心词拆成了
   *   `<span title="风险" style="color:red">来遇</span>见你` 两个文本节点 —— 逐节点跑 pattern
   *   谁都匹配不上（"来遇"、"见你"都不是「来遇见你」），可用户观感上这就是一个词。
   *   同一页里**普通规则**（走内核的跨节点 run 扫描）能命中，组合规则却漏 →
   *   表现为"同一个词，普通规则亮了、组合规则不亮"。
   *
   * 【做法】调内核**唯一入口** `util.matchKeyword(nodes, pattern, ctx, { within: cell })`：
   *   与普通词**同一份**匹配实现（大小写 / 全词守卫 / 正则多分支 / 空匹配保护 / 跨节点 / 区间映射），
   *   差别**只有** `within`（核心词绝不允许跨出定位到的这一格）。
   *   谁在这里另写一份遍历，就会再犯同一个缺陷 —— meta-check 有红线看着这条。
   */
  function coreHitsInCell(rule, cell, ctx) {
    const U = (ctx && ctx.util) || util();
    if (!cell || typeof U.matchKeyword !== 'function') return [];
    const rare = !!(rule.meta && rule.meta.coreIsRare);
    const r = U.matchKeyword(Cells.textNodesIn(cell, ctx), rule.pattern, ctx, {
      flags: rule.flags,
      within: cell,
      matchOne: rare ? rareOne : null
    });
    return r.single.concat(r.cross);
  }

  /**
   * 取关键词的组合轴：**单一真源在 `KH.Store.axisOf`**（B9）——
   * `cellVerifyAxis`（v1.52 起的老键）与 `comboAxis` 都认，任一为 `tb` 即为上下格。
   * 这里**只做转发**，不再自己写判据：本文件原先那份是 `comboAxis || cellVerifyAxis`
   * （于是 `{ comboAxis:'lr', cellVerifyAxis:'tb' }` 被读成 `lr`），与判重键 / CSV 第 18 列 /
   * 保存归一三处不一致 —— 同一份数据在"判重"和"编译"里是两个方向，正是数据漂移的来源。
   * 加载顺序无虞：`storage.js` 在 manifest 的 content_scripts 里排在 `combo.js` 之前，
   * 且这里是**运行期**查表（编译发生在所有脚本加载完之后）。
   */
  function axisOf(kw) { return KH.Store.axisOf(kw); }

  /**
   * 标题格命中判定。
   * 「整词精确」(cellVerifyMatchMode==='exact') 的语义是**整格相等**（旧版 `_cellTextMatches`
   * 的 exact 分支：`t === k`），不是"格内含该词"——所以它必须在**格子文本**这一层判定，
   * 而不能靠正则的全词边界（那仍是"格内含全词"）。
   * 非 exact 时才按格内文本跑 labelPattern（**含跨文本节点**）。
   *
   * @returns {Array<{start:number,end:number,text:string}>} 命中片段（exact 模式返回整格片段）
   */
  function matchCellLabel(rule, cell, ctx) {
    if (!rule || !rule.labelPattern || !cell) return [];
    const raw = String(cell.textContent || '');
    if (!raw.trim()) return [];
    if (rule.labelExact) {
      const got = rule.labelFlags && rule.labelFlags.caseSensitive ? raw.trim() : raw.trim().toLowerCase();
      const want = String(rule.meta && rule.meta.label || '').trim();
      const need = rule.labelFlags && rule.labelFlags.caseSensitive ? want : want.toLowerCase();
      if (got !== need) return [];
      // 整格命中：把"整格文本"作为片段返回（不是整格全部文本节点，交由下游按节点再定位）
      return [{ wholeCell: true }];
    }
    const U = (ctx && ctx.util) || util();
    if (typeof U.matchKeyword !== 'function') return [];
    const r = U.matchKeyword(Cells.textNodesIn(cell, ctx), rule.labelPattern, ctx, { flags: rule.labelFlags, within: cell });
    return r.single.concat(r.cross);
  }

  function compileCombo(kw, axis, cfg) {
    const B = KH.Compiler;
    const core = String(kw.text == null ? '' : kw.text);
    const label = String(kw.cellVerify == null ? '' : kw.cellVerify);
    /* 核心词可以是「罕见字」：此时核心不是字面词，而是"任意罕见字"，
     * 由 rare-char 的逐字判定在**定位到的格子里**跑（而不是整页扫）。
     * 依据：`src/ui/changelog.js` 早已写明"罕见字规则…也可作为「单元格组合」的右格核心
     * （左格标题词右侧出现罕见字才命中）"——旧实现漏了这条接线。 */
    const coreIsRare = !!(kw.rareChar || kw.kind === 'rare');

    // 标题（cellVerify）的匹配规则（旧版 v1.11.0 结论 + 策划案 §3.3.1，必须保留）：
    //   · 「包含即可」(include，默认) → 标题格文本 `indexOf(标题词) >= 0`
    //   · 「整词精确」(exact)        → 标题格文本 **整格相等**（trim 后 `===`），
    //     对应旧版 `_cellTextMatches` 的 exact 分支；**不是**格内全词边界匹配。
    // 两者语义不同，所以「整格相等」不能在正则层用全词边界表达（那会变成"格内含该词"）。
    const labelExact = (kw.cellVerifyMatchMode === 'exact');
    const labelFlags = {
      caseSensitive: !!kw.cellVerifyCaseSensitive,
      wholeWord: false,
      useRegex: !!kw.cellVerifyUseRegex
    };
    const labelPattern = label ? B.buildPattern(label, labelFlags) : null;
    if (!labelPattern) return null;                    // 没标题就不是组合词，交给其它 Adapter

    const flags = {
      caseSensitive: !!kw.caseSensitive,
      wholeWord: !!kw.wholeWord,
      useRegex: !!kw.useRegex
    };
    /* K71「抓取后续字段」模块总开关（fetchEnabled）：与 compiler.js 的 normal 适配器**同一口径** ——
     * 未启用 ⇒ `meta.fetchLabels` 归一成空串（下游零改动）。缺键（`!== false`）＝照旧抓取。 */
    const fetchOn = kw.fetchEnabled !== false;
    const fetchLabels = fetchOn ? String(kw.fetchLabels == null ? '' : kw.fetchLabels) : '';
    const fetchOnly = !coreIsRare && !core.trim();     // 仅抓取：无核心词（罕见字核心不算"无核心"）
    const pattern = (fetchOnly || coreIsRare) ? null : B.buildPattern(core, flags);
    if (!fetchOnly && !coreIsRare && !pattern) return null;

    const v = B.resolveVisual(kw, cfg);

    /* 图片文字识别：三个字段（开关 / 每处最多 / 命中关键词）由内核**唯一**解析 ——
     * 普通词走的是同一个 `ocrMeta`，所以"图片命中 = 抓取后续字段的一个分支"在两条编译路径上口径一致。 */
    const ocr = B.ocrMeta(kw, { fetchOnly });

    return {
      ruleId: kw.id,
      kind: fetchOnly ? 'fetch-only' : ('combo-' + axis),
      source: 'keyword',
      /** 声明由哪个专用 Probe 负责定位（内核的通用 node-regex 会因此让位，避免"整页扫核心词"） */
      probe: 'combo-' + axis,
      pattern,
      labelPattern,
      labelExact,
      flags,
      labelFlags,
      style: v.style,
      visual: !fetchOnly,                              // 仅抓取：不渲染（D2）
      meta: Object.assign({
        axis,
        label,
        coreRaw: core,
        /** 核心是"任意罕见字"（不是字面词）——Probe 据此改走逐字判定 */
        coreIsRare,
        note: kw.note || '',
        fetchOnly,
        fetchLabels,
        /** 取值格表达式（右起视觉列，如 `2` / `1-3` / `1,3,5`）；空串 = 旧行为（相邻右格、跳空格） */
        cellOffset: String(kw.cellOffset == null ? '' : kw.cellOffset).trim(),
        groupId: kw.groupId || null,
        /** 展示名：面板/统计里不该出现 'hjz#' 这种内部标记 */
        display: coreIsRare ? '罕见字' : (core.trim() || label)
      }, v.meta, ocr, {
        /** 仅抓取天然是"要进面板的数据"，因此必然算重要笔记入口（旧版 specialFetch 语义）；
         * 但模块被关掉（`fetchOn === false`）时它连抓取字段都没有了，就不该再凭空进面板。 */
        important: v.meta.important || (fetchOnly && fetchOn)
      })
    };
  }

  /* ---------------- 注册：① 两个 RuleAdapter ---------------- */

  if (KH.Compiler && KH.Compiler.adapters) {
    KH.Compiler.adapters.register('combo-lr', {
      order: 20,
      /* 注意：**不要**再排除 `kind:'rare' / rareChar` —— 罕见字可以作为组合的核心词
       * （核心 = "任意罕见字"，在定位到的右格里逐字判定）。旧实现两边互相排除，
       * 导致"罕见字 + 组合"落到整页逐字扫描（用户实测缺陷）。 */
      test(kw) {
        return !!(kw && kw.cellVerifyEnabled && kw.cellVerify && axisOf(kw) === 'lr');
      },
      compile(kw, cfg) { return compileCombo(kw, 'lr', cfg); }
    });

    KH.Compiler.adapters.register('combo-tb', {
      order: 30,
      test(kw) {
        return !!(kw && kw.cellVerifyEnabled && kw.cellVerify && axisOf(kw) === 'tb');
      },
      compile(kw, cfg) { return compileCombo(kw, 'tb', cfg); }
    });
  }

  /* ---------------- 注册：② 两个 ScannerProbe ---------------- */

  if (KH.Scanner && KH.Scanner.probes) {
    /* 左右格：锚点 = 标题格 */
    KH.Scanner.probes.register('combo-lr', {
      order: 200,
      applies(rule) {
        if (!rule) return false;
        if (rule.probe) return rule.probe === 'combo-lr';
        return rule.kind === 'combo-lr' || rule.kind === 'fetch-only';
      },
      scan(root, rule, ctx) {
        const hits = [];
        const st = comboStat(ctx);          // 只读计数（诊断用，见 KH.diagnostics().selfCheck）
        const nodes = (ctx && ctx.nodes) || [];
        const fetchOnly = rule.kind === 'fetch-only';
        const seenCells = new Set();          // 标题格只处理一次（格内多个文本节点都会看到同一格）

        for (const node of nodes) {
          const text = node.nodeValue || '';
          if (!text.trim()) continue;
          const cell = Cells.cellOf(node, ctx);
          if (!cell) continue;                 // 不在任何"格子"里 → 不是组合词场景
          if (seenCells.has(cell)) continue;
          seenCells.add(cell);
          st.cells++;

          // 标题命中判定（include / exact 两种语义，见 matchCellLabel）
          if (!matchCellLabel(rule, cell, ctx).length) continue;
          st.labeled++;

          if (fetchOnly) {
            // 「仅抓取」触发判据（旧版 `_fetchNonEmptyPass` v1.8.6 / v1.13.6，**不得回退**）：
            //   是否触发 = **标题词的直接右邻单元格有内容**（含中英数字），
            //   取直接右邻 td、**不用会跳过空格子的 `Cells.nextCell`** —— 否则"右格为空"
            //   会被误判成"无右格"而错误触发（策划案 §7.5 坑 15 点名的历史 bug）。
            //   抓取**内容**仍按 fetchLabels 各标签取右邻（在 Fetch/重要笔记消费期结算）；
            //   这里只判"要不要把这条记录登记进来"。
            if (!KH.Fetch || !KH.Fetch.triggerOk(cell)) continue;
            // 锚点 = 该格**第一个**文本节点。
            // 【为什么必须由 Probe 自己保证"每格只登记一次"】本 Probe 是按文本节点触发的，
            // 一个格子里有多个文本节点（如「申请类型」被页面拆成「申请类型」+ 空文本）时，
            // 去掉重会让同一格登记多条 → 重要笔记面板出现重复卡片、统计虚高。
            // 旧版 `_findRightCell` 只返回首个文本节点，所以它天然只有一条；这里显式去重。
            const anchor = Cells.textNodesIn(cell, ctx)[0] || node;
            const aText = anchor.nodeValue || '';
            hits.push({ rule, node: anchor, start: 0, end: Math.min(1, aText.length), text: '' });
            continue;
          }

          /* 取值格（右格）定位，两种口径：
           *   · **留空 / 表达式无法解析** → 旧行为不变：`Cells.nextCell(cell)`（相邻、跳空格）。
           *   · **填了合法的取值格表达式** → 按视觉列取一组格（`Cells.cellsAtOffsets`）。
           * 两种口径的差别是**刻意设计**：右邻是空格子时"留空"会跳过它、显式写 `1` 则取它；
           * 有合并单元格（colspan）时也会落在不同的格上（详见 cells.js 的 cellsAtOffsets 注释）。
           * 表达式合法但**全部越界** → `cells` 为空 → 本处不产生命中（绝不退化成"最后一个格"、不跨行找）。 */
          const offsetSpec = rule.meta && rule.meta.cellOffset;
          const picked = offsetSpec ? Cells.cellsAtOffsets(cell, offsetSpec) : null;
          const byOffset = !!(picked && picked.valid);
          const right = byOffset ? null : Cells.nextCell(cell);
          const valueCells = byOffset ? picked.cells : (right ? [right] : []);   // 标题本格不高亮 → 命中标在取值格
          /* 【K75 · 这里原来会 pushImgAnchor】——「图片命中」自 .41 起是**「抓取后续字段」的一个分支**，
           * 分支以"这条规则真的命中"为前提。而这里只是"标题词定位到某一格"，核心词命中判定在下面
           * （`core.length` / `hits.push`）才出结果 ⇒ 旧口径会让**没命中**的组合词照样去 OCR。
           * 已删。图片锚点现在**只**来自下面的真命中（`img-ocr.js` 的 `anchorsFor` 只看 hits）。 */
          if (!valueCells.length) { st.noRight++; continue; }
          /* 核心词按"**格内**这一整格的视觉连续文本"判定（含跨文本节点的核心词，
           * 见 `coreHitsInCell`）—— 与普通词的跨节点命中同一份口径。
           * 多格 → **任一命中**即算命中；同一处命中（同一文本节点的同一区间）只登记一次：
           * 多个偏移量可能覆盖同一格（colspan），格与格之间也可能给出重复区间。 */
          const core = [];
          const seenCore = new Map();
          for (const vc of valueCells) {
            for (const m of coreHitsInCell(rule, vc, ctx)) {
              let seg = seenCore.get(m.node);
              if (!seg) { seg = new Set(); seenCore.set(m.node, seg); }
              const key = m.start + ':' + m.end;
              if (seg.has(key)) continue;
              seg.add(key);
              core.push(m);
            }
          }
          if (core.length) st.withCore++; else st.labeledButNoCore++;
          for (const m of core) hits.push(Object.assign({ rule: rule }, m));
        }
        return hits;
      }
    });

    /* 上下格：锚点 = 表头格（仅表头生效） */
    KH.Scanner.probes.register('combo-tb', {
      order: 210,
      applies(rule) {
        if (!rule) return false;
        if (rule.probe) return rule.probe === 'combo-tb';
        return rule.kind === 'combo-tb';
      },
      scan(root, rule, ctx) {
        const hits = [];
        const st = comboStat(ctx);
        const nodes = (ctx && ctx.nodes) || [];
        const seenCells = new Set();

        for (const node of nodes) {
          const text = node.nodeValue || '';
          if (!text.trim()) continue;
          const headerCell = Cells.cellOf(node, ctx);
          if (!headerCell) continue;                    // 不在任何"格子"里 → 不是组合词场景
          if (seenCells.has(headerCell)) continue;
          seenCells.add(headerCell);
          st.tbHeaders++;
          // 列标题命中判定（include / exact，见 matchCellLabel）
          if (!matchCellLabel(rule, headerCell, ctx).length) continue;
          st.tbLabeled++;
          // 注意：**不要**在这里另加"仅表头生效"判断。
          // 「仅表头生效」只对真 `<table>` 成立，旧版 `_locateColumnForHeader`(v1.50.0)
          // 把它写在 table 分支内；无 table 的 div/flex/grid 假表格走
          // `_locateColumnInFakeTable`，**没有任何表头资格检查**。
          // v2 曾把这个守卫提到 Probe 层，导致 `display:grid` 扁平假表格
          // （格子直接是容器的子元素、不存在"行"这一层）整列识别不出来 → 功能收缩。
          // 现在守卫统一落在 `Cells.columnDataCells()` 的 table 分支里，一个地方、一份语义。
          for (const cell of Cells.columnDataCells(headerCell, ctx)) {
            // 空 / 空白单元格不产生命中：值后到时本 Probe 会重跑并补上（ST-05）
            if (!cell.textContent || !cell.textContent.trim()) continue;
            st.tbCells++;
            // 与左右格一样：核心词按"格内视觉连续文本"判定（含跨文本节点）
            const core = coreHitsInCell(rule, cell, ctx);
            if (core.length) st.tbWithCore++;
            for (const m of core) hits.push(Object.assign({ rule: rule }, m));
          }
          /* 【K75 · 这里原来会 pushImgAnchor 整列数据格】——「识别图片文字」是抓取模块的分支，
           * 必须以"核心词真的在这条规则里命中"为前提（用户口径原话："判断命中了普通词/组合词没有…
           * 如果没有命中，那就不需要考虑图片 ocr 和图片关键词"）。整列未命中也被登记成锚点是
           * K53 的旧口径残留，已删；锚点现在只来自 `hits`（下面 `core.length` 那条）。 */
        }
        return hits;
      }
    });
  }

  /* 注意：`matchIn` **不再从这里导出** —— 匹配的唯一实现在内核（`Scanner.util.matchIn` /
   * `matchKeyword`）。如果这里再挂一份"方便调用"的副本，就等于给"组合词自己写一套匹配"
   * 留了后门，而那个缺陷（普通词亮、组合词不亮）正是这么来的。 */
  KH.Combo = { axisOf, compileCombo, matchCellLabel };
})();
