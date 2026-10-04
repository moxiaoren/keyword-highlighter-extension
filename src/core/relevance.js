/* ============================================================================
 * src/core/relevance.js · 变更相关性预筛（P1）+ 仅消费判定（P2）
 * ----------------------------------------------------------------------------
 * 病根：MutationObserver 是「childList + characterData + subtree」，**任何**无关变动
 * （时钟、动画、广告位、框架重渲染、我们自己以外的任何 DOM 抖动）都会在 1s 静默 + 2s 限频后
 * 触发一次**整页**重建。重页面实测（2000 行 / 12007 文本节点 / 4334 命中）：
 * scan ≈ 707ms、整条 rebuild ≈ 1471ms —— 也就是说页面上无关键个不停时，插件每 2 秒白跑 1.5 秒。
 *
 * 所以这里**先判"这次变动值不值得动"**，再决定动作：
 *
 *   'full'    —— 可能影响命中本身（命中节点的文本被改 / 命中节点被移出文档 /
 *                新增文本里出现任何规则的字面前缀 / 新进来的图要重新识别）→ 走整页重建
 *   'consume' —— 命中集没变，但变动落在"进面板"的命中所在表格里（抓取字段值变了）
 *                → 只重跑 ⑦Consume（抓取 + 面板重绘），省掉扫描 / 匹配 / 重建 Range
 *   'skip'    —— 与命中、抓取、图片识别都不相关 → 什么都不做
 *
 * ============================ 判据的安全性 ============================
 * 预筛只能**放宽**、绝不能收紧 —— 判错最多多重建一次（回到老行为），判漏就会漏命中。
 * 因此：
 *   · 任何规则的模式**拿不到字面前缀**（罕见字 pattern=null、顶层有 `|` 的正则 →
 *     `literalOf` 返回空串）时，一律按"无法预筛"处理 → 文本有变就 'full'；
 *   · 命中节点的文本被原地改写（characterData）时，旧 Range 的偏移已经指向**新文本的同一段**，
 *     不清就会把高亮画在错的字上 → 'full'；
 *   · 命中节点被移出文档（isConnected === false）→ 'full'；
 *   · 判据本身出错（异常 / 拿不到 registry）→ 'full'（保守）。
 *
 * 属性变更不参与判定：观察器选项里 `attributes: false`，这类记录根本不会来
 * （将来若打开属性观察，`img[src]` 变化要按图片识别/抓取口径补上对应分支）。
 * ========================================================================= */
'use strict';

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 单次判定里最多累积多少条记录；超过就懒得逐条看，直接 'full'（保守） */
  const MAX_RECORDS = 800;
  /** 新增子树文本的采样上限（字符）。超过上限说明变动很大，直接 'full' 更划算 */
  const MAX_TEXT = 40000;

  function rulesOf() {
    return (KH.rules && KH.rules.length) ? KH.rules : [];
  }

  /** 某个规则是否"无法用字面前缀预筛" */
  function unfilterable(rule) {
    const U = (KH.Scanner && KH.Scanner.util) || {};
    if (typeof U.literalOf !== 'function') return true;        // 拿不到预筛能力 → 保守
    /* 只检查**存在**的模式：
     *   · 普通词没有 labelPattern（组合才有）—— 那不是"无法预筛"，是"这个轴不产生命中"；
     *   · 仅抓取没有 pattern（核心为空）—— 命中由 labelPattern 决定 ✓ 也能预筛；
     *   · 罕见字规则两个模式都没有（靠逐字判定 matchOne）→ **任何文本都可能命中** ⇒ 无法预筛。 */
    const ps = [rule.pattern, rule.labelPattern].filter(Boolean);
    if (!ps.length) return true;
    /* 注意：literalOf 收的是**模式源码字符串**（它内部按 source 建缓存），不是 RegExp 对象 */
    for (const p of ps) if (!U.literalOf(p.source)) return true;
    return false;
  }

  /** 文本里是否出现任一规则的字面前缀（大小写按各自 flag 决定，与 matchIn 的预筛同口径） */
  function textMayMatch(text, rules) {
    if (!text) return false;
    const U = KH.Scanner.util;
    for (const rule of rules) {
      for (const p of [rule.pattern, rule.labelPattern]) {
        if (!p) continue;
        const lit = U.literalOf(p.source);
        if (!lit) return true;                                  // 无法预筛 → 认为可能命中
        const ci = p.flags.indexOf('i') >= 0;
        const hay = ci ? text.toLowerCase() : text;
        const needle = ci ? lit.toLowerCase() : lit;
        if (hay.indexOf(needle) >= 0) return true;
      }
    }
    return false;
  }

  /* 【bisect 用】先退回最简版：只看节点自身（原先就是这一版）。
   * 上一版改成"沿 parentElement 往上走 + 出 shadow（getRootNode().host）"，
   * 却让「图片文字识别」那条 e2e 从绿变红 —— 先摘掉这一处，单独验证是不是它。 */
  function isOwnUI(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute && node.hasAttribute(KH.Scanner.UI_ATTR)) return true;
    return !!(KH.Scanner.isOwnUI && KH.Scanner.isOwnUI(node));
  }

  /** 元素里有没有图（新图进来要重新采：图片识别） */
  function hasImage(el) {
    if (!el || el.nodeType !== 1) return false;
    if (String(el.tagName || '').toUpperCase() === 'IMG') return true;
    return !!(el.querySelector && el.querySelector('img'));
  }

  function imgOcrOn() {
    return rulesOf().some((r) => r.meta && r.meta.imgOcr);
  }

  /** 命中节点里"会进面板"的那些（important / fetchLabels）—— 只有它们才需要"仅消费" */
  function panelHits() {
    const all = (KH.registry && KH.registry.all) ? KH.registry.all() : [];
    const out = [];
    for (const h of all) {
      if (!h || !h.meta) continue;
      if (h.meta.important || h.meta.fetchLabels) out.push(h);
    }
    return out;
  }

  /** 命中节点的最近表格作用域（抓取读的是同行/同表，所以判"同一张表"就够） */
  function scopeOf(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return null;
    try { return el.closest('table') || el.parentElement || null; } catch (e) { return null; }
  }

  /**
   * 命中节点的"抓取可读范围"。
   *
   * 抓取（Fetch）读的是**同行/同表**里的其它格子，而且真实站点上有两种结构会跑出"同一张表"：
   *   · **假表格**（div / flex / grid 拼的表格，没有 `<table>`）：`closest('table')` 直接落空；
   *   · **el-table 那种"表头表 + 数据表"分离**：抓取可能去**另一张表**取值。
   * 所以这里把「格子 / 行 / 表 / 表的父容器 / 假表格容器」都收进来，并且后面**双向**判包含。
   */
  function fetchScopes(node) {
    const out = [];
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return out;
    try {
      const cell = (KH.Cells && KH.Cells.cellOf) ? KH.Cells.cellOf(node, {}) : null;
      const row = (cell && KH.Cells.rowOf) ? KH.Cells.rowOf(cell) : null;
      if (cell) out.push(cell);
      if (row) out.push(row);
      const table = el.closest ? el.closest('table') : null;
      if (table) {
        out.push(table);
        if (table.parentElement) out.push(table.parentElement);      // el-table 的外层容器（两张表的共同父）
      }
      if (KH.Cells && KH.Cells.fakeContainerOf && cell) {
        const fc = KH.Cells.fakeContainerOf(cell);
        if (fc) out.push(fc);
      }
      if (!out.length) out.push(el);
    } catch (e) {
      out.push(el);                                                  // 任何取不到 → 退化成"就这一格"
    }
    return out;
  }

  /** 我们的高亮组是否还在（页面可能自己调了 `CSS.highlights.clear()`）——不在就必须重建自愈。
   *  这是 e2e「clear() 后自愈」那条用例逼出来的：页面清掉高亮**不产生任何 mutation**，
   *  P1 的预筛又可能把随后那次无关变动判成 skip → 高亮永远回不来（实测门禁变红：实际 0）。 */
  function highlightsHealthy() {
    try {
      if (typeof CSS === 'undefined' || !CSS.highlights) return true;      // 环境没有 CSS.highlights：不参与判定
      const g = (KH.Renderer && KH.Renderer._groups) ? KH.Renderer._groups : null;
      if (!g || !g.size) return true;                                      // 本来就没有高亮组
      for (const name of g.keys()) {
        if (!CSS.highlights.has || !CSS.highlights.has(name)) return false;
      }
      return true;
    } catch (e) { return true; }
  }

  /** 判定一次变更批次该做什么。
   * @param {MutationRecord[]} records
   * @param {object} [cfg]
   * @returns {'full'|'consume'|'skip'}
   */
  function classify(records, cfg) {
    const verdict = classifyInner(records, cfg);
    /* 留档最近一次判定（诊断 / 真浏览器回归断言用；不改任何行为） */
    KH.Relevance.last = { verdict: verdict, at: Date.now(), recs: (records || []).length };
    return verdict;
  }

  function classifyInner(records, cfg) {
    try {
      /* ---- 「保守模式」：任何变动都整页重建（用户可在设置页切换）----
       * 这是 P1/P2 之前的**旧行为**的等价物：不做相关性预筛、也不走"仅消费"快通道。
       * 为什么要留这个开关：预筛是"判多只是多算一次、判漏才是事故"的取舍，但用户遇到
       * "页面变了却怎么都不亮"时，需要一条**能立刻排除预筛嫌疑**的路（先切保守、看现象是否消失）。
       * 注意：静默窗口与重建最小间隔**照旧生效** —— 否则会退化成"每条变动都重建"（比旧版更费）。 */
      if (cfg && cfg.changeHandling === 'always') return 'full';
      if (!records || !records.length) return 'skip';
      if (records.length > MAX_RECORDS) return 'full';
      const rules = rulesOf();
      /* 高亮被外部清掉（页面/别的扩展调了 CSS.highlights.clear()）→ 必须借这次机会重建自愈 */
      if (!highlightsHealthy()) return 'full';
      const img = imgOcrOn();
      const noPrefilter = rules.some(unfilterable);

      /* ---- ① 文本：原地改写 + 新增子树 ---- */
      let textSeen = 0;
      let textAll = '';
      let ctxText = '';                      // 变化节点所在"格子"的整段文本（跨节点/慢填的上下文）
      let ctxSeen = 0;
      /**
       * 取"**该节点所在的上下文文本**"（= 判断"这次变动有没有可能命中"的取样口径，**唯一实现**）。
       * `childList` 分支与 `attributes` 分支**共用**它 —— K78·④ 修的就是属性分支原来只取"被改元素自身文本"。
       */
      const ctxOf = (node) => {
        try {
          const el = node && (node.nodeType === 1 ? node : node.parentElement);
          if (!el) return '';
          const cell = (el.closest && el.closest('td,th')) || null;
          /* 表格里就用**格子**整段文本；非表格场景只取"自己 + 前后各几个兄弟"。
           * ⚠️ 绝不能退化成"父容器的整段文本"：往 body 追加任何一个 <p>，父容器就是 body，
           *    整页文本里必然含关键词前缀 → 预筛失效、无关变动也重建（实测踩过）。 */
          if (cell) return String(cell.textContent || '');
          /* 只跟**行内**兄弟拼（与内核 buildInlineRuns 的口径一致）：
           * 表格/段落这类块级兄弟不能算进"同一个词"的上下文 —— 否则往表格旁边追加一个 <p>，
           * 它的前一个兄弟就是整张表，表里的词全被当成"这个变动可能命中"（实测踩过）。
           * 拆词场景（`<span>华</span><span>为</span>`）两边都是行内元素 ✓ 照样覆盖。 */
          const INLINE = /^(SPAN|A|B|I|EM|STRONG|SMALL|LABEL|CODE|FONT|U|S|SUB|SUP|MARK|TIME|ABBR|BDI|BDO|CITE|Q|SAMP|VAR)$/;
          const inlineOk = (n) => !!n && n.nodeType === 1 && INLINE.test(String(n.tagName || '').toUpperCase());
          let t = String(el.textContent || '');
          let n = el.previousElementSibling, c = 0;
          while (inlineOk(n) && c < 3) { t = (n.textContent || '') + t; n = n.previousElementSibling; c++; }
          n = el.nextElementSibling; c = 0;
          while (inlineOk(n) && c < 3) { t += (n.textContent || ''); n = n.nextElementSibling; c++; }
          return t.slice(0, 2000);
        } catch (e) { return ''; }
      };
      const addCtx = (node) => {
        const t = ctxOf(node);
        if (!t) return;
        ctxSeen += t.length;
        if (ctxSeen > MAX_TEXT) return;
        ctxText += ' ' + t;
      };
      const addedRoots = [];
      const changedRoots = [];
      const attrRecords = [];
      for (const rec of records) {
        const t = rec.target;
        if (isOwnUI(t)) continue;
        if (rec.type === 'characterData') {
          const nv = String((t && t.nodeValue) || '');
          textSeen += nv.length;
          if (textSeen > MAX_TEXT) return 'full';
          textAll += nv;
          addCtx(t);
          changedRoots.push(t);
        } else if (rec.type === 'childList') {
          /* 【只收"增删的节点"，不收 rec.target（父节点）】target 往往是 body / 大容器，
           * 拿它去判"是否落在命中所在的表格里"会把**任何**追加到 body 的东西都判成抓取相关
           * （实测：往 body 追加一个与业务无关的 <p> 被误判成 consume）。 */
          for (const n of rec.addedNodes || []) {
            if (isOwnUI(n)) continue;
            changedRoots.push(n);
            addedRoots.push(n);
            addCtx(n);
            if (n.nodeType === 3) {
              const nv = String(n.nodeValue || '');
              textSeen += nv.length;
              if (textSeen > MAX_TEXT) return 'full';
              textAll += nv;
            } else if (n.nodeType === 1 && n.textContent) {
              textSeen += n.textContent.length;
              if (textSeen > MAX_TEXT) return 'full';
              textAll += n.textContent;
            }
          }
          for (const n of rec.removedNodes || []) {
            if (isOwnUI(n)) continue;
            changedRoots.push(n);
          }
        } else if (String(rec.type).indexOf('attribute') === 0) {
          /* ⚠️ `MutationRecord.type` 的实际取值是 **`'attributes'`（复数）** ——
           * 一开始写成 `=== 'attribute'` 导致属性记录**永不匹配**、判据永远 skip
           * （现象：显现出来的内容一直不亮；单测当时也用错了字符串，所以没抓到）。
           * 这里用前缀匹配兼容两种写法。 */
          attrRecords.push(rec);
        }
      }

      const all = (KH.registry && KH.registry.all) ? KH.registry.all() : [];

      /* ---- ②b 属性变化（class / style / hidden / src / srcset）----
       * 【为什么必须看它】"折叠面板展开/抽屉拉开/Tab 切换/`hidden` 去掉"这类显隐是**属性变化**，
       * 不产生 childList/characterData —— 不观察就永远等不到重建，内容露出来了却不亮（唯一还剩的漏命中口子）。
       * 这类记录很频繁，所以：① 观察器用 attributeFilter 只投这五个；② 下面按属性分档判，
       * 只有"现在可见 + 子树里可能有关键词"或"图换了需要重采"才算相关，其余直接放过。 */
      if (attrRecords.length) {
        /* 显隐口径与扫描剪枝**同源**（`Scanner.util.rendersSubtree`）—— 见下面 `visible` 处的说明 */
        const U = (KH.Scanner && KH.Scanner.util) || {};
        for (const rec of attrRecords) {
          const t = rec.target;
          if (!t || t.nodeType !== 1 || isOwnUI(t)) continue;
          const name = String(rec.attributeName || '');
          const tag = String(t.tagName || '').toUpperCase();
          if (name === 'src' || name === 'srcset') {
            if (tag === 'IMG' || hasImage(t)) {
              if (img) return 'full';                 // 有图片识别 → 要重新采集
              return 'consume';                       // 否则抓取里的图/字段可能变了 → 刷面板
            }
            continue;
          }
          /* class / style / hidden：显隐变化。
           * ⚠️ 口径必须与扫描剪枝**同源**（`Scanner.util.rendersSubtree`）：
           *   · 旧实现直接取 `checkVisibility` 的布尔值 ⇒ `display:contents` 的元素被当成"变成不可见"，
           *     于是"这块现在可能有关键词 ⇒ 值得重建"那条分支永远不走（K76 修的）；
           *   · 反过来只看"三种样式"也不行 ⇒ 闭合 `<details>` 那类**只有原生 API 看得见**的隐藏
           *     会被当成"可见"（K76 的 R4 在真浏览器上抓到的回退）。
           * `rendersSubtree` 把这两头都照顾到了。 */
          const visible = (typeof U.rendersSubtree === 'function') ? U.rendersSubtree(t) : true;
          if (visible) {
            /* 现在是可见的：只有"这块子树里可能出现关键词"才值得重建（预算内取样）。
             * ⚠️【K78·④】取样范围是**所在上下文**，不是"被改元素自身的文本"：
             * R4 实测 `<div class="blk">辰</div><span>式词</span>` 改 `blk` 的 class 时，
             * 自身文本只有 `辰` ⇒ 预筛判"不可能命中" ⇒ **该重建也不重建**（拆词永远接不上）。
             * 现在与 `childList` 分支**共用同一份取样**（`ctxOf`：格子整段 / 自己 + 行内兄弟 ±3）。 */
            const txt = (ctxOf(t) || String(t.textContent || '')).slice(0, MAX_TEXT);
            if (!txt) continue;
            if (noPrefilter || textMayMatch(txt, rules)) return 'full';
          } else {
            /* 变成不可见：里面的命中会被扫描的可见性剪枝剔掉 → 需要重建 */
            for (const h of all) {
              if (h && h.textNode && t.contains && t.contains(h.textNode)) return 'full';
            }
          }
        }
      }

      /* ---- ② 命中节点被改写 / 被移出文档 → 必须完整重建 ---- */
      const hitNodes = new Set();
      for (const h of all) if (h && h.textNode) hitNodes.add(h.textNode);
      for (const rec of records) {
        if (rec.type === 'characterData' && hitNodes.has(rec.target)) return 'full';
      }
      for (const n of hitNodes) {
        if (!n || n.isConnected === false) return 'full';        // 被移出文档：Range 已失效
      }

      /* ---- ③ 新增/变更的文本里有没有可能命中（拿不到字面前缀时一律算"可能有"） ----
       * 【为什么不能只看"变化的那段文本"】跨文本节点命中是这插件的基本能力
       * （页面把词拆成 `审<span>核</span>不通过`）—— 值**慢慢填**的时候（先 `华`，几秒后才补 `为`），
       * 变化的那一段往往只是词的**一小块**，本身不含完整前缀 → 只测它就会漏命中。
       * 所以再拿"变化节点所在**格子**的整段文本"当上下文测一遍（格子是天然的上界，成本可控）。 */
      if (textAll || ctxText) {
        if (noPrefilter || textMayMatch(textAll, rules) || textMayMatch(ctxText, rules)) return 'full';
      }

      /* ---- ④ 新进来的图：图片识别要重采 → 完整重建 ---- */
      if (img) {
        for (const n of addedRoots) {
          if (n.nodeType === 1 && hasImage(n)) return 'full';
        }
      }

      /* ---- ⑤ 命中集不变：变动是否落在"进面板"的命中**可读范围**里 → 仅消费 ----
       * 用户点名的场景：翻页后左右格文本一字不变，只有"具体驳回原因"这类**抓取字段**变了 ——
       * 面板必须跟着刷（走这里，1ms 级），而不是什么都不做、也不是整页重建。 */
      const ph = panelHits();
      if (ph.length && changedRoots.length) {
        for (const h of ph) {
          const scopes = fetchScopes(h.textNode);
          for (const scope of scopes) {
            for (const r of changedRoots) {
              if (!r) continue;
              const rEl = (r.nodeType === 3) ? r.parentElement : r;
              if (!rEl) continue;
              if ((scope.contains && scope.contains(rEl)) || (rEl.contains && rEl.contains(scope))) return 'consume';
              /* el-table 那种"表头表 + 数据表"分离：变更在**另一张表**里、但两张表同属一个外层容器 */
              try {
                const rt = rEl.closest ? rEl.closest('table') : null;
                if (rt && rt.parentElement && scope.contains && scope.contains(rt.parentElement)) return 'consume';
              } catch (e) { /* 取不到就算了，继续看下一个 */ }
            }
          }
        }
      }
      return 'skip';
    } catch (err) {
      /* 判据出错 = 判不了 → 按老行为完整重建（绝不因为"省资源"而漏命中） */
      console.error('[KH] 变更相关性判定异常（已保守回退整页重建）:', err);
      return 'full';
    }
  }

  KH.Relevance = { classify, textMayMatch, unfilterable, MAX_RECORDS, MAX_TEXT };
})();
