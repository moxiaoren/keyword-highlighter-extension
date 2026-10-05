/* ============================================================================
 * src/core/index.js · 门面 KH —— 全工程唯一对外 API
 * ----------------------------------------------------------------------------
 * 铁律（方案 §3.3）：options / popup / content / features **一律不许自己实现管线**，
 *   只能调这里。新增功能 = 注册扩展点，不是改内核。
 *
 * 单一管线（8 阶段，方案 §3.1）：
 *   Load ──▶ Compile ──▶ Scan ──▶ Resolve ──▶ Index ──▶ Render ──▶ Consume ──▶ Clear
 *   读配置    编译规则    扫候选     裁决重叠     建单表     唯一渲染    消费数据    唯一清理
 *
 * 与方案原文的一处顺序修正（评审记录）：
 *   原顺序写作 …Resolve → Render → Index → Consume，实现时调整为 …Resolve → **Index → Render** → Consume。
 *   原因：Range 缓存（`hit._range`）必须挂在**注册表里的同一条记录**上，否则每次重建都要重算 Range，
 *   且 RendererPlugin 无法按 id 关联视觉；把 Index 提到 Render 之前可做到"一个 Hit 对象贯穿全管线"。
 *   该调整不改变任何对外行为与验收项，仅影响阶段编号顺序。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** feature 注册表 —— 第五个注册点（管线外的数据消费方：统计 / 重要笔记 / 备注卡 / 快捷键） */
  const features = (KH.createRegistry ? KH.createRegistry('Feature') : null);
  KH.features = features;

  /**
   * 元素内第一个非空文本节点（纯结构遍历，不做任何 class/属性反查）。
   * 供 pointToRange 在 caret 落在元素上时下钻取文本；找不到（纯装饰元素/纯空白）返回 null，
   * 调用链随后的几何命中回退会接管。
   * 【v2.0.0 实测教训】此函数曾**只被调用、从未被定义** —— 平时 caret 都直接落在文本节点上，
   * 一旦落到元素（命中词边缘 / 命中文字被浮层遮住 / caret 返回宿主元素），交互定位直接抛
   * "firstTextNode is not defined"，悬停与点击在真实页面上**全部静默失效**。
   * 夹具的悬停/点击点都取在文本正中（caret 恒返文本节点），测试全绿也发现不了 ——
   * 直到 F13d 浮层夹具把这条路径踩了出来。
   */
  function firstTextNode(el) {
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {        if (n.nodeValue && n.nodeValue.trim().length) return n;
      }
    } catch (err) { /* el 可能已脱离文档等，尽力而为 */ }
    return null;
  }

  const state = {
    config: null,
    rules: [],
    siteEnabled: false,
    booted: false
  };

  /* ---------------- 公共 API ---------------- */

  const KH_API = {
    /** 版本**不在代码里定义**，运行时读 manifest（唯一真源，见方案 §2 第 5 条 / meta-check #1） */
    get version() {
      try { return chrome.runtime.getManifest().version; } catch (e) { return '0.0.0'; }
    },

    get state() { return state; },
    get config() { return state.config; },
    get rules() { return state.rules; },

    /**
     * 就绪标记（`<html data-kh-state="on|off">`）—— 页面 DOM 上**唯一**的状态观察点。
     * 内容脚本运行在隔离世界，页面自己的脚本 / DevTools / 自动化测试**看不到 `window.KH`**，
     * 所以诊断与真浏览器回归都读这个属性（它不参与匹配、不影响布局）。
     *
     * 【为什么必须由内核来写】它必须反映**每一次**状态变化。此前只有 content.js 在
     * "启动 / 配置热更新 / 快捷键消息"三条路径上写它 —— 而 **URL 变化触发的那次重评**
     * 走的是内核自己的 `boot()`，不经过那三条路 → 标记会停在旧值（诊断会看错）。
     * 现在由 `boot()` / `applyConfig()` 统一发布，content.js 的 `markState` 只是转调。
     */
    markState(ok) {
      try { document.documentElement.setAttribute('data-kh-state', ok ? 'on' : 'off'); }
      catch (err) { /* documentElement 不可写时忽略 */ }
    },

    /**
     * 定点定位 —— 交互定位的唯一入口（铁律 §2 第 3 条）。
     * 回退链（R5）：`caretPositionFromPoint`（标准） → `caretRangeFromPoint`（Chromium/Safari 私有）
     *   → **几何命中**（注册表 Range 矩形测试） → `null`。**绝不**回退到 `closest('.kh-*')` /
     *   `data-kh-*` 之类 DOM 反查。
     *
     * 旧版缺陷（keyword-engine.js:2153-2156）：只用 `caretRangeFromPoint`，无标准 API 回退，
     * 非 Chromium 内核（如 Firefox）点击定位直接失效。
     * 另一处细节：标准 API 存在但**该点返回 null**（点在空白处/元素间隙）时，
     * 旧写法会直接放弃；此处仍继续尝试私有 API，只有两条都拿不到才返回 null。
     *
     * 回退③（v2.0.0 实测补）：caret 两条 API 在真实页面上还有三类拿不到"注册表认识"的
     * 文本节点的场景 —— 命中文字被浮层盖住（element-ui 固定列 / 吸顶工具条 / 弹层，
     * caret 落在浮层上）、open Shadow 内容（caret 被重定向到宿主元素）、`user-select:none`
     * 文本。此时改用注册表里命中的 Range 做矩形命中测试（数据仍只来自注册表，无 DOM 反查）：
     * 点落在任一命中矩形的**精确范围**内 → 立即返回；否则取带 3px 容差的最近命中。
     * 仅在 caret 路径全部落空时才走这里，正常页面零开销。
     */
    pointToRange(x, y) {
      let node = null, offset = 0;

      if (document.caretPositionFromPoint) {
        try {
          const pos = document.caretPositionFromPoint(x, y);
          if (pos && pos.offsetNode) { node = pos.offsetNode; offset = pos.offset || 0; }
        } catch (err) { /* 某些内核签名不同会抛，落到下一条 */ }
      }
      if (!node && document.caretRangeFromPoint) {
        try {
          const r = document.caretRangeFromPoint(x, y);
          if (r) { node = r.startContainer; offset = r.startOffset; }
        } catch (err) { /* 同上 */ }
      }
      if (node) {
        if (node.nodeType !== 3) {
          // 落在元素上：向下取最近文本节点（纯结构遍历，不做任何 class/属性反查）
          const t = firstTextNode(node);
          if (t) { node = t; offset = Math.min(offset, node.nodeValue.length); }
        }
        if (node.nodeType === 3) return { node, offset };
      }

      /* ---- 回退③：几何命中（caret 路径全部落空才到这里） ---- */
      return this._hitByGeometry(x, y);
    },

    /**
     * 原始命中（Scanner 产出）→ 注册表记录。
     *
     * 【跨节点命中】`inline-run-regex` 探针会产出跨文本节点的命中（如 `审核<span red>不通过</span>`）：
     *   · `start/end` 仍是**起始节点内**的偏移（end ＝ 起始节点里剩下的长度）；
     *   · 真正的终点在 `endNode/endOffset`；
     *   · `segments` 是本条命中覆盖的每一段 `{node, start, end}` —— 注册表按它给**每个**节点建索引，
     *     否则鼠标点在第二段上时 `registry.query` 查不到（悬浮备注 / 点击卡片会失效）。
     * 单节点命中不带 endNode，行为与以前完全一致（向后兼容）。
     */
    _hitRecord(r, extra) {
      const rec = Object.assign({
        ruleId: r.rule.ruleId,
        textNode: r.node,
        start: r.start,
        end: r.end
      }, extra || {});
      if (r.endNode && r.endNode !== r.node) {
        rec.endNode = r.endNode;
        rec.endOffset = r.endOffset;
        rec.crossNode = true;
        /* 段由 Scanner 探针直接给出（它才算得准匹配覆盖了哪些节点）。
         * **不要**在这里用 `Scanner.util.carrier()` 反推：carrier 可能返回行内**元素**
         * （其 nodeValue 为 null），反推会抛异常 —— 实测这会让整轮重建中断、高亮全空。 */
        rec.segments = Array.isArray(r.segments) ? r.segments : [{ node: r.node, start: r.start, end: r.end }];
      }
      return rec;
    },

    /**
     * 几何命中回退：遍历注册表，用各命中的 Range 矩形做坐标命中测试。
     * Range 优先复用渲染层缓存的 `hit._range`（同一份对象，不另建第二真源）。
     *
     * 【必须有最大距离上限】`TOL` 只决定"是否算精确包含"，**不能**当最近命中的距离上限：
     * 旧实现无条件 `return best`，于是在**没有文本的空白区域**（空单元格 / 空行 / 图片区）
     * 悬停时 —— caret 两条 API 都返回 null → 落到这里 → 没有任何矩形精确包含该点，
     * 就把**几百像素外**的最近命中当成本地命中返回 → 备注 tooltip 在空白处弹出
     * （用户实测："视频封面"空白行悬停弹出"包名"行的备注）。
     * 加上限后，超出 `MAX_DIST` 一律返回 null，调用方自然认为"该点没有命中"。
     * 取 20px：本回退的真实用途（浮层盖住命中文字 / open Shadow / user-select:none）
     * 都是"鼠标紧贴命中矩形"的场景，其中正对覆盖物的情形本就走"精确包含"分支（距离 0），
     * 到不了这里；只有亚像素取整、命中矩形比视觉文字略小这类误差才会用到最近命中，
     * 量级是个位数像素。20px 足够覆盖误差，又能把"隔了一个单元格/一整行"的误判挡掉。
     * @returns {{node: Text, offset: number}|null} 返回命中的文本节点与区间起点，
     *          调用方经 `registry.query(node, offset)` 拿到同一条命中记录。
     */
    _hitByGeometry(x, y) {
      if (!KH.registry || typeof KH.registry.all !== 'function') return null;
      const TOL = 3;
      const MAX_DIST = 20;
      let best = null, bestDist = Infinity;
      for (const h of KH.registry.all()) {
        const tn = h.textNode;
        if (!tn || !tn.isConnected) continue;
        let range = h._range || null;
        if (!range || range.startContainer !== tn) {
          try {
            range = document.createRange();
            range.setStart(tn, Math.min(h.start, tn.nodeValue.length));
            /* 跨节点命中：终点在 endNode/endOffset，否则几何回退只量得到第一段 */
            if (h.endNode && h.endNode !== tn && h.endNode.isConnected) {
              range.setEnd(h.endNode, Math.min(h.endOffset || 0, h.endNode.nodeValue.length));
            } else {
              range.setEnd(tn, Math.min(h.end, tn.nodeValue.length));
            }
          } catch (err) { continue; }                 // 区间越界等异常：跳过该条
        }
        let rects;
        try { rects = range.getClientRects(); } catch (err) { continue; }
        for (const rc of rects) {
          if (!rc || (rc.width === 0 && rc.height === 0)) continue;
          const dx = x < rc.left - TOL ? rc.left - x : (x > rc.right + TOL ? x - rc.right : 0);
          const dy = y < rc.top - TOL ? rc.top - y : (y > rc.bottom + TOL ? y - rc.bottom : 0);
          if (dx === 0 && dy === 0) return { node: tn, offset: h.start };   // 精确包含：直接命中
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; best = { node: tn, offset: h.start }; }
        }
      }
      if (best && bestDist <= MAX_DIST * MAX_DIST) return best;
      return null;
    },

    /** 命中查询（配合 pointToRange 使用） */
    hitAtPoint(x, y) {
      const p = this.pointToRange(x, y);
      if (!p) return null;
      return KH.registry.query(p.node, p.offset);
    },

    /** 全量重建：唯一入口 */
    rebuild(opts) {
      return KH_API.run(opts && opts.root ? opts.root : document.body, (opts && opts.source) || 'manual');
    },

    /**
     * 配置热更新：重新编译规则并按需重建。
     *
     * 【必须复核站点门禁】(实测缺陷：白名单 / 「禁用本站」不生效)
     *   旧实现只管重编译 + 无条件 rebuild，**完全不重评站点门禁** —— 于是：
     *     · options 里新增一条白名单规则 → storage 变更 → 本函数 → rebuild
     *       → 本该失效的站点**仍然高亮**（白名单形同虚设）；
     *     · popup「禁用本站」写 siteDisabledMap → storage 变更 → 本函数 → rebuild
     *       → 高亮**被重新点亮**，而随后 nudge 的 SITE_CHANGED（走 boot）又把它关掉 ——
     *       两条路径竞态，谁后到谁说了算 → 表现为"禁用本站时灵时不灵 / 无效"。
     *   现在与 `boot()` 用**同一套判据**（globalEnabled / SiteRules / 规则数），
     *   失效则直接 `destroy()` 下线，并从返回值把真实状态告诉调用方（就绪标记据此更新）。
     * @returns {Promise<{total:number,rendered:number,skipped:number,source:string,siteEnabled:boolean}>}
     */
    async applyConfig(patch) {
      const merged = KH.Config.merge(Object.assign({}, state.config || {}, patch || {}));
      const normalized = KH.Config.normalize(merged).config;
      state.config = normalized;
      state.rules = KH.Compiler.compileAll(normalized);
      KH.registry.emit(KH.EVENTS.CONFIG_CHANGED, normalized);

      // 还没启动过：boot() 会自己按最新配置上线，这里不抢跑
      if (!state.booted) return { total: 0, rendered: 0, skipped: 0, source: 'config', siteEnabled: false };

      const active = normalized.globalEnabled !== false &&
        (KH.SiteRules ? KH.SiteRules.shouldHighlight(location.hostname, location.href, normalized) : true) &&
        state.rules.length > 0;
      state.siteEnabled = !!active;

      if (!active) {
        this.destroy();                       // 关观察器 + 清高亮，切到失效态必须收干净
        this.markState(false);
        return { total: 0, rendered: 0, skipped: 0, source: 'config', siteEnabled: false };
      }

      // 观察器/翻页通道按新配置重挂
      KH.Scheduler.setupObserver(normalized);
      KH.Scheduler.setupFingerprintWatcher(normalized);
      /* 逐条守卫：调度侧通道是"可选能力"，某个方法缺失（老内核 / 单测替身）不该把热更新整条打断 */
      if (typeof KH.Scheduler.setupAnimWatcher === 'function') KH.Scheduler.setupAnimWatcher(normalized);
      if (typeof KH.Scheduler.setupGrowthWatcher === 'function') KH.Scheduler.setupGrowthWatcher(normalized);
      KH.Scheduler.setupPageClickWatcher(normalized);
      KH.Scheduler.setupVisibilityWatcher(normalized);
      const r = this.rebuild({ source: 'config' });
      r.siteEnabled = true;
      this.markState(true);
      return r;
    },

    /**
     * 跑一次完整管线。
     * 注意：Rebuilder.clear 与 Registry.clear 都在 ⑧Clear 阶段成对调用，别处禁止再清。
     */
    run(root, source) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const target = root || document.body;
      /* 计数器（只给诊断/真浏览器回归看，不参与任何判定）：
       * 用来断言"无关变更不重建"与"字段变化只走仅消费"。
       * 记**来源**是必须的：可见性/URL/指纹等其它通道也会重建，只看总数会把它们的账算到变更预筛头上。 */
      state.rebuildCount = (state.rebuildCount || 0) + 1;
      state.lastRebuildSource = source || '';
      state.mutationRebuildCount = (state.mutationRebuildCount || 0) + ((source === 'mutation') ? 1 : 0);

      // ⑧ Clear（先清后建，方案 §4.2）—— 抑制窗口覆盖整个重建过程
      KH.Rebuilder.enterRebuild();
      try {
        KH.Rebuilder.clear(null, { reason: 'rebuild' });

        // ③ Scan
        // `shadow` 来自配置 `shadowDOMEnabled`（旧版默认 true）：开启时扫描器会逐层进入
        // Shadow Root 取文本 —— TreeWalker 不跨 Shadow 边界，不给这个开关就永远扫不到
        // Web Component 页面里的内容（旧版 `setupShadowDOMObserver` 的能力，不能丢）。
        const shadow = !(state.config && state.config.shadowDOMEnabled === false);
        /* 扫描上下文由**管线**持有：Probe 往里放"不产生命中但下游要用"的定位结果
         * （目前是图片识别锚点），⑦Consume 时同一个对象再交给 Feature。 */
        const scanCtx = {};
        const raw = KH.Scanner.scan(target, state.rules, { shadow, ctx: scanCtx });
        /* 组合词定位体检（只读）：挂到 `_lastScan` 上 —— 命中为 0 时诊断要能分清
         * "标题词没找到" 还是 "标题找到了、旁边那格没有核心词"（两种的修法完全不同）。 */
        if (scanCtx._comboStat && KH.Scanner._lastScan) KH.Scanner._lastScan.combo = scanCtx._comboStat;

        // ④ Resolve
        const { resolved, shadowed } = KH.Arbiter.resolve(raw);

        // ⑥ Index（先建单表，让 Range/视觉/统计共用同一条记录）
        const hl = (state.config && state.config.highlightStyle) || {};
        const created = [];
        /* 单条命中登记出错**不得中断整轮重建**（与"单个 Probe 出错不影响管线"同一原则）——
         * 实测踩过：`_hitRecord` 里一个 null.nodeValue 直接把整轮重建打挂，页面高亮全空、
         * 表现为"所有功能一起失效"，排查成本极高。这里逐条隔离。 */
        const addOne = (r, extra) => {
          try {
            const { hit, created: isNew } = KH.registry.add(KH_API._hitRecord(r, extra));
            if (isNew) created.push(hit);
          } catch (err) {
            console.error('[KH] 命中登记失败（已隔离，不影响其它命中）:', err);
          }
        };
        for (const r of resolved) {
          addOne(r, {
            kind: r.rule.kind,
            visual: r.rule.visual !== false,
            // 样式解析只在这里发生一次：规则自带 > 全局默认（唯一默认值源 = Config.defaults.highlightStyle）
            // 走兜底分支说明用的就是**全局默认文字色** → 标 textIsDefault，
            // 渲染层据此保留原网页文字色（除非与原色分不开，见 renderer 的感知判据）
            style: r.rule.style || { bgColor: hl.defaultBgColor, textColor: hl.defaultTextColor, textIsDefault: true },
            meta: Object.assign({ text: r.text }, r.rule.meta || {}),
            contentKey: r.rule.ruleId + '|' + (r.node ? r.node.nodeValue.slice(0, 32) : '') + '|' + r.start + '-' + r.end
          });
        }
        // 被裁决覆盖的命中不渲染，但仍登记（供统计/聚合/仅抓取使用）
        for (const r of shadowed) {
          addOne(r, {
            kind: r.rule.kind,
            visual: false,
            style: null,
            meta: Object.assign({ text: r.text, shadowed: true }, r.rule.meta || {}),
            contentKey: r.rule.ruleId + '|shadowed|' + r.start + '-' + r.end
          });
        }

        // ⑤ Render（唯一渲染实现；仅渲染 visual !== false 的）
        const visual = KH.registry.visualOnly().filter(h => !h.meta.shadowed);
        const rendered = KH.Renderer.render(visual);

        // ⑦ Consume（feature 统一消费，禁止各自监听 DOM）
        if (features) {
          for (const [label, feat] of features.entries()) {
            if (!feat || typeof feat.consume !== 'function') continue;
            try { feat.consume(KH.registry.all(), state.config, scanCtx); }
            catch (err) { console.error('[KH] feature consume 异常:', label, err); }
          }
        }

        KH.registry.emit(KH.EVENTS.HITS_CHANGED, { total: KH.registry.size, rendered: rendered.rendered, source });
        KH.registry.emit(KH.EVENTS.REBUILD_DONE, { source, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 });
        return { total: KH.registry.size, rendered: rendered.rendered, skipped: rendered.skipped, source };
      } finally {
        KH.Rebuilder.exitRebuild(60);
      }
    },

    /**
     * 【只读诊断】popup「🩺 诊断」按钮用：给出现场数据，回答"这个页面为什么重建这么多次 / 为什么卡"。
     * 只读、不改任何状态；字段含义见 `_checkpoint.md` 与 `tests/E2E-REPORT.md` K54。
     */
    diagnostics() {
      const rel = (KH.Relevance && KH.Relevance.last) || null;
      const groups = (KH.Renderer && KH.Renderer._groups) ? KH.Renderer._groups.size : -1;
      return {
        ok: true,
        url: (typeof location !== 'undefined' ? location.href : ''),
        booted: !!state.booted,
        siteEnabled: !!state.siteEnabled,
        rules: (state.rules || []).length,
        hits: KH.registry ? KH.registry.size : -1,
        groups: groups,
        rebuildCount: state.rebuildCount || 0,
        mutationRebuildCount: state.mutationRebuildCount || 0,
        consumeOnlyCount: state.consumeOnlyCount || 0,
        lastRebuildSource: state.lastRebuildSource || null,
        /** 变更处理方式（K58）：smart=相关性预筛 / always=任何变动都整页重建（保守） */
        changeHandling: (state.config && state.config.changeHandling) || 'smart',
        /* 调度侧现场(K56)：观察器回调次数 / 裁决轮到的次数 / "拖过上限不等安静直接判"的次数。
         * 「回调在涨、裁决也在涨，但重建为 0」= 记录被静默窗口一直顺延（翻页后不亮的现场）。 */
        observerFire: (KH.Scheduler && KH.Scheduler._observerFireCount) || 0,
        drainCount: (KH.Scheduler && KH.Scheduler._drainCount) || 0,
        deferCapped: (KH.Scheduler && KH.Scheduler._deferCappedCount) || 0,
        /* K60：CSS 动画/过渡兜底触发过几次（"内容是被动画显出来的"现场看这个数） */
        animFallback: (KH.Scheduler && KH.Scheduler._animCount) || 0,
        /* K60：「文本量暴涨」兜底触发过几次（"记录丢了/换 body 空隙"现场看这个数） */
        growthFallback: (KH.Scheduler && KH.Scheduler._growthCount) || 0,
        /* K62：图片加载完成后补扫过几次（懒加载图的现场看这个数） */
        imgLoadFallback: (KH.Scheduler && KH.Scheduler._imgLoadCount) || 0,
        lastVerdict: rel ? rel.verdict : null,
        lastVerdictRecords: rel ? rel.recs : null,
        imgOcr: (KH.ImgOcr && typeof KH.ImgOcr._debug === 'function') ? KH.ImgOcr._debug() : null,
        /* 「为什么一个都没命中」自查（K57，只读、按需）。见 selfCheck() 顶部注释。 */
        selfCheck: (typeof this.selfCheck === 'function') ? this.selfCheck() : null
      };
    },

    /**
     * 【只读自查】回答"这个页面为什么一个都没命中"（K57）。
     * ---------------------------------------------------------------------------
     * 只读、按需调用（用户点 🩺 诊断时），**不参与任何判定、不改任何状态**。
     * 三层信息，逐层排除：
     *   ① 这一层文档的规模：textContent / innerText 长度、文本节点数、图 / 画布 / iframe / 影子根数量；
     *   ② 上一轮扫描的体检计数（`KH.Scanner._lastScan`）：**扫到多少文本节点、被可见性剪掉多少子树、命中几条**；
     *   ③ 逐条规则的字面词在 textContent（含隐藏）与 innerText（仅可见）里各出现几次。
     * 判读（也是 verdict 的自动结论）：
     *   · 词在 innerText 里出现却没命中 → **匹配/定位**的问题（这是真 bug，要查）；
     *   · textContent 有、innerText 没有 → 词在**不可见**内容里（折叠/未激活标签页），扫描按可见性剪枝，属正常；
     *   · 两边都没有 → 词不在**这一层文档**里：内容可能在同源子框架 / 图片 / 画布 / 还没渲染。
     */
    selfCheck() {
      const out = { frame: null, doc: null, scan: null, words: [], iframes: [], verdict: '' };
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t0Self = now();
      const countOf = (s, sub, cap) => {
        if (!s || !sub) return 0;
        let n = 0; let i = 0;
        const max = cap || 999;
        while (n < max) { const j = s.indexOf(sub, i); if (j < 0) break; n++; i = j + sub.length; }
        return n;
      };
      try {
        out.frame = {
          top: (typeof window !== 'undefined') && window.top === window.self,
          href: (typeof location !== 'undefined' ? location.href : '')
        };
        const body = document.body || document.documentElement;
        const textContent = (body && body.textContent) || '';
        const innerText = (body && body.innerText) || '';
        let textNodes = 0;
        let shadowRoots = 0;
        try {
          const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
          let n;
          while ((n = w.nextNode())) { textNodes++; if (textNodes > 200000) break; }
        } catch (e) { /* 只读自查，拿不到就算了 */ }
        try {
          /* 影子根：只数**开放**的（闭合的连网站自己也拿不到）；上限 30000 个元素，避免大页面卡住 */
          const all = document.querySelectorAll('*');
          const cap = Math.min(all.length, 30000);
          for (let i = 0; i < cap; i++) if (all[i].shadowRoot) shadowRoots++;
          out.doc = {
            textContentLen: textContent.length,
            innerTextLen: innerText.length,
            textNodes: textNodes,
            elements: all.length,
            imgs: document.images ? document.images.length : 0,
            canvases: document.querySelectorAll('canvas').length,
            shadowRoots: shadowRoots
          };
        } catch (e) { /* 同上 */ }

        /* 同源子框架：能读就读它的文本规模与该框架自己的命中数（**不递归调用 diagnostics**，避免套娃） */
        try {
          const list = document.querySelectorAll('iframe');
          for (let i = 0; i < list.length && i < 10; i++) {
            const f = list[i];
            const item = { src: String(f.src || f.getAttribute('src') || '').slice(0, 160), sameOrigin: false, textLen: -1, khHits: -1, khRules: -1, khBooted: false };
            try {
              const d = f.contentDocument;
              if (d) {
                item.sameOrigin = true;
                item.textLen = ((d.body && d.body.textContent) || '').length;
                const w2 = f.contentWindow;
                if (w2 && w2.KH) {
                  item.khHits = (w2.KH.registry && w2.KH.registry.size) || 0;
                  item.khRules = (w2.KH.rules || []).length;
                  item.khBooted = !!(w2.KH.state && w2.KH.state.booted);
                }
              }
            } catch (e) { /* 跨域：只能给出 src */ }
            out.iframes.push(item);
          }
        } catch (e) { /* 同上 */ }

        if (!out.doc) {
          out.doc = { textContentLen: textContent.length, innerTextLen: innerText.length, textNodes: textNodes, elements: -1, imgs: -1, canvases: -1, shadowRoots: shadowRoots };
        }

        /* 逐词自查：只查**有字面词**的规则（正则/罕见字逐字判定拿不到字面词，如实标注条数） */
        const U = (KH.Scanner && KH.Scanner.util) || null;
        /* 走**公开 getter**（而不是闭包里的 state）—— 单测才能替身化规则表；行为完全一致。 */
        const rules = ((this && this.rules) || state.rules || []);
        const words = [];
        let noLiteral = 0;
        for (const r of rules) {
          let lit = '';
          try { lit = (U && U.literalOf && r && r.pattern && r.pattern.source) ? U.literalOf(r.pattern.source) : ''; } catch (e) { lit = ''; }
          if (!lit) { noLiteral++; continue; }
          words.push({ word: lit, inText: countOf(textContent, lit), inInner: countOf(innerText, lit) });
        }
        words.sort((a, b) => (b.inText - a.inText) || (b.inInner - a.inInner));
        out.words = words.slice(0, 10);
        out.noLiteral = noLiteral;
        out.scan = (KH.Scanner && KH.Scanner._lastScan) || null;
        out.combo = (out.scan && out.scan.combo) || null;
        out.shadowDOMEnabled = !(state.config && state.config.shadowDOMEnabled === false);

        /* 其它"词可能待在哪儿"的通道（**只在命中=0 时才算**）：文字高亮只看得见**文本节点**，
         * 而这几种地方的关键词都是"看不见的" —— 表单控件的 value、title/placeholder 这类属性、
         * 可编辑区（扫描默认跳过）、开放影子根（取决于"影子 DOM"开关）。 */
        const hitsNow = KH.registry ? KH.registry.size : -1;
        if (!hitsNow) {
          const chan = { form: '', attr: '', editable: '', shadow: '' };
          try {
            const ctrls = document.querySelectorAll('input, textarea, select');
            for (let i = 0; i < ctrls.length && i < 500; i++) {
              const el = ctrls[i];
              chan.form += ' ' + (el.value == null ? '' : el.value);
            }
          } catch (e) { /* 只读自查 */ }
          try {
            const all = document.querySelectorAll('*');
            const cap = Math.min(all.length, 30000);
            for (let i = 0; i < cap; i++) {
              const el = all[i];
              if (!el.getAttribute) continue;
              const t = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('alt');
              if (t) chan.attr += ' ' + t;
              if (el.isContentEditable && el.textContent) chan.editable += ' ' + el.textContent;
              if (el.shadowRoot && el.shadowRoot.textContent) chan.shadow += ' ' + el.shadowRoot.textContent;
            }
          } catch (e) { /* 同上 */ }
          for (const w of out.words) {
            w.inForm = countOf(chan.form, w.word);
            w.inAttr = countOf(chan.attr, w.word);
            w.inEditable = countOf(chan.editable, w.word);
            w.inShadow = countOf(chan.shadow, w.word);
          }
          out.channels = {
            formLen: chan.form.length, attrLen: chan.attr.length,
            editableLen: chan.editable.length, shadowLen: chan.shadow.length
          };
        }

        const hits = KH.registry ? KH.registry.size : -1;
        /* 逐规则命中明细（K59）：用户说"某个格子不亮"时，第一个要回答的问题是
         * **是哪条规则命中的、我要的那条规则到底命中了没有** ——
         * 这一行能立刻把"规则没命中"和"命中了但画在别处"分开。 */
        try {
          const counts = {};
          if (KH.registry && typeof KH.registry.all === 'function') {
            for (const h of KH.registry.all()) {
              const id = h && h.ruleId;
              if (!id) continue;
              counts[id] = (counts[id] || 0) + 1;
            }
          }
          const byId = {};
          for (const r of rules) if (r && r.ruleId) byId[r.ruleId] = r;
          const list = [];
          for (const id of Object.keys(counts)) {
            const r = byId[id] || null;
            let w = '';
            let lb = '';
            try { w = (U && U.literalOf && r && r.pattern && r.pattern.source) ? U.literalOf(r.pattern.source) : ''; } catch (e) { w = ''; }
            try { lb = (U && U.literalOf && r && r.labelPattern && r.labelPattern.source) ? U.literalOf(r.labelPattern.source) : ''; } catch (e) { lb = ''; }
            list.push({ ruleId: id, word: w || '(无字面词)', label: lb, hits: counts[id] });
          }
          list.sort((a, b) => b.hits - a.hits);
          out.rulesWithHits = list.length;
          out.rulesWithoutHits = Math.max(0, rules.length - list.length);
          out.ruleHits = list.slice(0, 20);

          /* 组合词"定位现场"（K59）：对**核心词明明在可见文本里、却一条都没命中**的组合词规则，
           * 现场取一处核心词，把它所在格子的结构打出来：
           *   格子标签/跨列跨行、格内文本、同行各格文本、左右邻居、标签词在同格还是同行。
           * 有了这一段，就不需要用户去翻 DOM 或截图 —— 结构不满足是"哪一处不满足"直接写在报告里。 */
          const hitIds = {};
          for (const it of list) hitIds[it.ruleId] = it.hits;
          const misses = [];
          for (const r of rules) {
            if (!r || !r.labelPattern) continue;                 // 只看组合词（它才依赖结构定位）
            if (hitIds[r.ruleId]) continue;                      // 有命中的不用查
            let w = '';
            let lb = '';
            try { w = (U && U.literalOf) ? U.literalOf(r.pattern.source) : ''; } catch (e) { w = ''; }
            try { lb = (U && U.literalOf) ? U.literalOf(r.labelPattern.source) : ''; } catch (e) { lb = ''; }
            if (!w) continue;
            if (innerText.indexOf(w) < 0) continue;              // 页面上根本没这个词 → 不是定位问题
            misses.push({ ruleId: r.ruleId, w: w, lb: lb });
          }
          out.comboTrace = [];
          if (misses.length && U && typeof U.collectTextNodes === 'function') {
            const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
            const visNodes = U.collectTextNodes(document.body, {});
            for (const m of misses.slice(0, 3)) {
              const node = visNodes.find((n) => (n.nodeValue || '').indexOf(m.w) >= 0);
              const tr = { word: m.w, label: m.lb, found: !!node };
              if (node) {
                const el = node.parentElement;
                /* 分开写单个选择器（而不是 `closest('td,th')`）：单测垫片的选择器匹配只支持简单的单个标签，
                 * 逗号写法在真机没问题、在垫片会静默返回 null —— 分开写两边都准，代价可忽略。 */
                const cell = (el && el.closest)
                  ? (el.closest('td') || el.closest('th') || el.closest('div') || el.closest('li')
                    || el.closest('dd') || el.closest('dt') || el.closest('p') || el.closest('span'))
                  : null;
                if (cell) {
                  tr.tag = String(cell.tagName || '').toLowerCase();
                  if (cell.colSpan > 1) tr.colSpan = cell.colSpan;
                  if (cell.rowSpan > 1) tr.rowSpan = cell.rowSpan;
                  tr.text = cut(cell.textContent, 40);
                  const row = cell.closest ? cell.closest('tr') : null;
                  /* `tr.cells` 是真表格的接口；假表格（div 行 / grid 容器）没有它 —— 退化成 children，
                   * 这样"同行有哪些格"在两种结构下都拿得到。 */
                  const rowEls = (row && row.cells) ? [].slice.call(row.cells)
                    : ((row && row.children) ? [].slice.call(row.children) : null);
                  if (rowEls) tr.rowCells = rowEls.slice(0, 8).map((c) => cut(c.textContent, 16));
                  if (cell.previousElementSibling) tr.prev = cut(cell.previousElementSibling.textContent, 20);
                  if (cell.nextElementSibling) tr.next = cut(cell.nextElementSibling.textContent, 20);
                  const scope = row ? (row.textContent || '') : (((cell.parentElement && cell.parentElement.textContent) || ''));
                  tr.labelInCell = !!(m.lb && (cell.textContent || '').indexOf(m.lb) >= 0);
                  tr.labelInScope = !!(m.lb && scope.indexOf(m.lb) >= 0);
                }
              }
              out.comboTrace.push(tr);
            }
          }
        } catch (e) { /* 只读自查 */ }
        const visible = words.filter((x) => x.inInner > 0);
        const hiddenOnly = words.filter((x) => x.inText > 0 && x.inInner === 0);
        const inForm = out.words.filter((x) => x.inForm > 0);
        const inAttr = out.words.filter((x) => x.inAttr > 0);
        const inEditable = out.words.filter((x) => x.inEditable > 0);
        const inShadow = out.words.filter((x) => x.inShadow > 0);
        const sameOriginFrameWithText = out.iframes.filter((f) => f.sameOrigin && (f.textLen > 0 || f.khHits > 0));
        /* 组合词定位现场的补充说明（命中为 0 且词在可见文本里时，最需要知道"断在哪一步"） */
        const cb = out.combo;
        let comboHint = '';
        if (cb) {
          if ((cb.cells > 0 || cb.tbHeaders > 0) && (cb.labeled + cb.tbLabeled) === 0) {
            comboHint = '组合词定位：检查了 ' + (cb.cells + cb.tbHeaders) + ' 个格子，**标题词一次都没匹配上**'
              + '（左右轴 ' + cb.cells + ' 格 / 上下轴表头 ' + cb.tbHeaders + ' 格）→ 要么标题词与页面用词不一致，要么这些格子不在组合词认可的结构里。';
          } else if ((cb.labeled + cb.tbLabeled) > 0 && (cb.withCore + cb.tbWithCore) === 0) {
            comboHint = '组合词定位：标题词命中 ' + (cb.labeled + cb.tbLabeled) + ' 个格子，但**它旁边/下方那一格都没有核心词**'
              + '（左右轴：无右格 ' + cb.noRight + ' 次；上下轴数据格 ' + cb.tbCells + ' 个）→ 定位结构不满足（可能不是表格、或合并单元格把值挪到了别处）。';
          } else if ((cb.withCore + cb.tbWithCore) > 0) {
            comboHint = '组合词定位：标题命中 ' + (cb.labeled + cb.tbLabeled) + ' 格，其中 ' + (cb.withCore + cb.tbWithCore)
              + ' 格找到了核心词 —— 定位本身是成功的，若仍无命中，问题在更下游（裁决/渲染）。';
          }
        }
        /* `verdictKind` = 与 `verdict` 同源的**无词判据**（枚举，不含任何用户词/页面文本）。
         * 用途：popup 的「诊断·仅计数」模式要一份能安全外发的结论 —— 直接复用 `verdict` 会把用户关键词
         * 与表格原文一起复制出去（C7 O-2）。两处同源：kind 在同一分支里赋值，不会与文案漂移。 */
        if (hits > 0) {
          out.verdictKind = 'hit';
          out.verdict = '有命中（' + hits + ' 条），不是"一个都没命中"的问题。';
        } else if (visible.length && visible.every((x) => x.inEditable > 0 && x.inEditable >= x.inInner)) {
          /* 可见文本里确实有，但**全都在可编辑区**里 —— 扫描默认跳过可编辑内容（避免干扰用户正在输入的东西） */
          out.verdictKind = 'editable-visible';
          out.verdict = '词在**可编辑区**（contenteditable）的可见文本里（例如「' + visible[0].word
            + '」出现 ' + visible[0].inInner + ' 次，其中可编辑区内 ' + visible[0].inEditable
            + ' 次）→ 扫描默认跳过可编辑内容，所以不命中。';
        } else if (visible.length) {
          out.verdictKind = 'visible-miss';
          out.verdict = '⚠ 有 ' + visible.length + ' 条规则的词就在**可见文本**里（例如「' + visible[0].word + '」出现 '
            + visible[0].inInner + ' 次）却一条都没命中 → 是**匹配/定位**的问题，不是"词不在页面上"。请把这条诊断发我。'
            + (comboHint ? (' ' + comboHint) : '');
        } else if (hiddenOnly.length) {
          out.verdictKind = 'hidden-only';
          out.verdict = '词只在**不可见**内容里（textContent 有、innerText 没有，例如「' + hiddenOnly[0].word
            + '」）→ 该区域当前是折叠/未激活状态，扫描按可见性剪枝，所以不命中；等内容显出来（class/style/hidden 变化）会自动补上高亮。';
        } else if (inShadow.length) {
          out.verdictKind = 'shadow';
          out.verdict = '词在**开放影子根**里（例如「' + inShadow[0].word + '」）→ 当前"影子 DOM"开关='
            + (out.shadowDOMEnabled ? '开' : '**关**（关掉就扫不到，打开即可）') + '；若已开着却仍不命中，请把这条诊断发我。';
        } else if (inForm.length) {
          out.verdictKind = 'form';
          out.verdict = '词在**表单控件的值**里（例如「' + inForm[0].word + '」）→ input / textarea / select 的 value **不是文本节点**，'
            + '文字高亮天生看不见它（这类内容目前只能靠图片识别那条路）。若要覆盖，需要换成"给控件本身加醒目标记"的渲染方式 —— 属于新能力，可另行评估。';
        } else if (inAttr.length) {
          out.verdictKind = 'attr';
          out.verdict = '词只出现在**属性**里（title / placeholder / aria-label / alt，例如「' + inAttr[0].word
            + '」）→ 页面上并没有可见的那个词（属性通常只在悬停提示/无障碍里用），所以没有可高亮的目标。';
        } else if (inEditable.length) {
          out.verdictKind = 'editable';
          out.verdict = '词在**可编辑区**（contenteditable）里（例如「' + inEditable[0].word
            + '」）→ 扫描默认跳过可编辑内容（避免干扰用户正在输入的东西），所以不命中。';
        } else if (sameOriginFrameWithText.length) {
          out.verdictKind = 'same-origin-frame';
          out.verdict = '本层文档里一个规则词都没有，但**同源子框架里有文本/命中** → 正文在 iframe 里（见下面的子框架清单）。';
        } else if (out.doc.imgs > 0 || out.doc.canvases > 0) {
          out.verdictKind = 'img-canvas';
          out.verdict = '本层文档里一个规则词都没有，而页面里有 ' + out.doc.imgs + ' 张图 / ' + out.doc.canvases
            + ' 个画布 → 内容可能是**图片或画布画出来的字**，文字命中无从下手'
            + '（图里的字要靠「抓取后续字段」的「识别图片文字」那条路 —— 普通词与组合词都能用，'
            + '前提是先把要抓的「字段」填上、并配「图片命中关键词」）。';
        } else {
          out.verdictKind = 'none';
          out.verdict = '本层文档里一个规则词都没有，也没看到 iframe / 图片 / 画布 → 内容可能在**影子根**(开放影子根 '
            + out.doc.shadowRoots + ' 个)里，或还没渲染出来（懒加载 / 需要滚动），也可能规则词与页面用词不一致（对照下面的逐词计数）。';
        }
        out.ms = Math.round(now() - t0Self);
      } catch (err) {
        out.verdictKind = 'error';
        out.verdict = '自查失败：' + String((err && err.message) || err);
      }
      return out;
    },

    /**
     * 【仅消费】命中集不变、只有**抓取字段**变化时的快通道（P2）。
     *
     * 场景：轮询刷新的表格里，命中的词一个字没变，但它**同行单元格**里的字段值变了 ——
     * 面板上的抓取表格需要跟着更新，可页面内容整体没变。
     * 老做法是走整页重建（Clear+Scan+Resolve+Index+Render+Consume）：重页面实测约 1.5 秒，
     * 而这里只重跑 ⑦Consume（抓取 + 面板重绘）—— 扫描/匹配/重建 Range 全都省掉。
     *
     * 三条安全前提（任一不成立就别调它，走 run()）：
     *   ① 命中集与命中节点都没变（没有命中节点的文本被原地改写、也没被移出文档）；
     *   ② 变更落在某个"进面板"的命中（important / fetchLabels）所在的表格里；
     *   ③ 不涉及图片识别要重采的东西（新图进来必须走 run()）。
     *
     * @param {string} source 触发来源（日志/事件用）
     */
    consumeOnly(source) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      /* Fetch 的结果缓存是"每轮 Consume 新建的 WeakMap"（见 important-note.collectEffective），
       * 所以这里天然会重算抓取 —— 不需要额外失效；
       * 但 `ctx.consumeOnly = true` 必须传下去：img-ocr 的 consume 会把"本轮锚点"当成全集重建，
       * 不告诉它这是仅消费，它会把已有图片命中条目清空。 */
      const scanCtx = { consumeOnly: true, imgAnchors: [] };
      if (features) {
        for (const [label, feat] of features.entries()) {
          if (!feat || typeof feat.consume !== 'function') continue;
          try { feat.consume(KH.registry.all(), state.config, scanCtx); }
          catch (err) { console.error('[KH] feature consume(仅消费) 异常:', label, err); }
        }
      }
      state.consumeOnlyCount = (state.consumeOnlyCount || 0) + 1;
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      KH.registry.emit(KH.EVENTS.CONSUME_ONLY, { source, ms, total: KH.registry.size });
      return { total: KH.registry.size, source, ms, consumeOnly: true };
    },

    /** 全量下线 */
    destroy() {
      KH.Scheduler.teardownAll();
      KH.Rebuilder.clear(null, { reason: 'destroy' });
      KH.registry.emit(KH.EVENTS.HITS_CHANGED, { total: 0, rendered: 0, source: 'destroy' });
    },

    /**
     * 启动。由 content/content.js 调用，是全页唯一的启动入口。
     *
     * 【站点状态切换必须能"下线"】(旧版 content.js:59-103 `reEvaluateSite` 的语义，不得丢)
     *   同一个入口同时承担三种情形：
     *     · 首次启动
     *     · 配置变更后的重建（globalEnabled / 关键词）
     *     · **URL 变化后的站点规则重评** —— `scope:'url'` 的规则可能让本页由生效转失效（或反之），
     *       所以 URL 监听回调必须走 `boot()` 而不是直接 `rebuild()`
     *       （旧版只 rebuild 不重评 → 网址级规则中途失效时高亮残留）。
     *   因此任何提前 return 的分支都必须先 `destroy()`（上面已在入口清一次），
     *   保证"切到失效态"时页面上的高亮被收干净。
     * @returns {Promise<boolean>} 是否成功进入高亮态
     */
    async boot() {
      if (state.booted) this.destroy();
      const { config } = await KH.Config.load();
      state.config = config;
      state.rules = KH.Compiler.compileAll(config);
      state.booted = true;                 // 即使下面提前返回，也已完成一次"启动"（后续会先 destroy）

      /* 【URL 监听必须在站点门禁之前武装】(用户实测缺陷：列表→详情页不高亮、刷新才正常)
       * 旧实现把 setupUrlWatcher 放在门禁检查**之后**，于是"当前页不生效、点进详情页才生效"
       * 这类配置（网址级白名单/黑名单，或本页被临时禁用）下，当前页**根本没有监听路由** ——
       * 点进本应生效的详情页也永远不会重评、不会高亮，只能靠刷新（刷新是全新文档 → 走正常启动）。
       * 现在无论本页是否生效，先保证"路由变化能被发现"，再由 boot() 自己重评门禁。 */
      KH.Scheduler.setupUrlWatcher(() => {
        KH_API.boot().catch(err => console.error('[KH] URL 变更后重评站点规则失败', err));
      });

      if (config.globalEnabled === false) { state.siteEnabled = false; this.markState(false); return false; }

      const host = location.hostname;
      state.siteEnabled = KH.SiteRules ? KH.SiteRules.shouldHighlight(host, location.href, config) : true;
      if (!state.siteEnabled) { this.markState(false); return false; }
      if (!state.rules.length) { this.markState(false); return false; }

      // 先建观察器再首扫：值后到的变化才在观察范围内（旧版 v1.10.11 的教训，ST-05）
      KH.Scheduler.setupObserver(config);
      KH.Scheduler.setupFingerprintWatcher(config);
      if (typeof KH.Scheduler.setupAnimWatcher === 'function') KH.Scheduler.setupAnimWatcher(config);
      if (typeof KH.Scheduler.setupGrowthWatcher === 'function') KH.Scheduler.setupGrowthWatcher(config);
      KH.Scheduler.setupPageClickWatcher(config);
      KH.Scheduler.setupVisibilityWatcher(config);

      this.rebuild({ source: 'boot' });
      this.markState(true);
      return true;
    }
  };

  /* 注意：必须用 defineProperties 而不是 Object.assign ——
     Object.assign 会把 getter 求值成**当时的静态快照**（读一次就定死），
     导致 `KH.rules` 在编译完成后仍返回空数组（真实踩过的坑）。 */
  Object.defineProperties(KH, Object.getOwnPropertyDescriptors(KH_API));

  /** 供 Node 单测使用（无 window 时导出到 globalThis） */
  if (typeof module !== 'undefined' && module.exports) module.exports = KH;
})();
