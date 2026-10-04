/* ============================================================================
 * src/core/scheduler.js · ⑦Consume 之调度侧 —— 唯一触发源仲裁
 * ----------------------------------------------------------------------------
 * 一切"什么时候重建"的决策只在这里。4 条信号通道：
 *   ① MutationObserver  —— childList + characterData + subtree（**必须含 characterData**）
 *   ② URL 变化           —— pushState/replaceState 拦截 + popstate/hashchange + 600ms 轮询兜底
 *   ③ 内容指纹轮询（R13）—— URL 不变 + 无 DOM 事件 + 直接替换表格内容的极端翻页
 *   ④ 分页点击捕获（D4） —— 默认关；开启后与上面三条共用同一限频计数器
 *
 * 关键统一点（R14）：**四条通道共用一个 `lastRebuildAt`**。
 *   旧版 `_prcLastRebuild`（click）与 `_lastUrlRebuild`（URL）是两套独立口径，互相压制
 *   （content.js:31-32,80-90），一次误触发的 click 重建会把紧随其后的真实 URL 重建压掉。
 *
 * 自身写入抑制（方案 §4.2 ✚补充②）：
 *   靠"重建抑制窗口"（`Rebuilder.inRebuildWindow`），**绝不用"移除内容/新增内容形态"判定自身写入**
 *   —— 那会把页面真实的 `td.textContent = 新值` 误杀（removed=旧高亮span+旧文本、
 *   added=新文本，形态完全一致）→ 不重建 → 残留。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const Scheduler = {
    _observer: null,
    /** 观察参数（唯一一份，主文档与各 ShadowRoot 共用）
     *  `characterData: true` 必须有（`nodeValue =` 是原地改值，不发 childList）；
     *  `attributes: false` —— 属性变化不参与（class 切换不改变文本内容，避免噪声）。 */
    /* 观察范围：childList + characterData + subtree + **属性**（v1.99.99.22 启用）。
     * 【为什么要观察属性】折叠面板展开 / 抽屉拉开 / Tab 切换 / `hidden` 去掉 / 换图都是**属性变化**，
     * 不产生 childList 或 characterData —— 不观察就永远等不到重建，内容露出来了却不亮。
     * ⚠️ `attributeFilter` 与 `attributes:true` **必须同进同退**：实测把它们错配成
     * （`attributes:false` + `attributeFilter:[...]`）会让 `observe()` **直接抛错** →
     * boot 中断 → 全页零变更检测（那一轮的幽灵红就是这么来的）。改成关掉时两个一起删。 */
    _observerOptions: {
      childList: true, characterData: true, subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'src', 'srcset']
    },
    /** 已挂上观察器的 ShadowRoot 集合（teardown 时随 disconnect 一起失效） */
    _shadowRoots: null,
    _timers: { silent: null, poll: null, fingerprint: null, growth: null, trailing: null, shadow: null },
    _lastMutationAt: 0,
    /** ⏳ 延迟裁决的**上限**（ms）：静默窗口最多只能把裁决顺延这么久，到点必须判一次。
     *  【为什么必须有上限】静默窗口的判据是"距最后一次变动 ≥ silentMs"，而页面上源源不断的
     *  无关变动（计时器刷状态点、轮播改 style/class）会一直刷新 `_lastMutationAt` →
     *  每一次裁决都被顺延 → **真正的内容替换永远轮不到裁决**（实测：换内容后 9 秒内零重建、
     *  命中为 0，切走标签页再切回才好）。上限一到就**不再等安静**，拿攒下的记录直接判一次：
     *  判错最多多重建一次（只是费点资源），判漏才是事故。 */
    _DEFER_CAP_MS: 3000,
    /** 当前这批记录的"最早攒到时刻"（延迟上限的起点；裁决后清零） */
    _drainFirstPendingAt: 0,
    /** 诊断：因为拖过上限而"不等安静直接判"的次数 */
    _deferCappedCount: 0,
    /** 四条通道共用的唯一限频时间戳（R14） */
    _lastRebuildAt: 0,
    /** 限频窗口内被合并的尾随请求来源（见 request() 注释） */
    _pendingSource: null,
    _lastHref: '',
    /** URL 变化的回调与分发器（只挂一次事件，但回调每次 setup 都刷新 —— 见 setupUrlWatcher） */
    _urlOnChange: null,
    _urlFire: null,
    _lastFingerprint: '',
    _config: null,

    /** 真正执行重建（唯一出口；限频与尾随合并都在 request 里判定） */
    _fire(source) {
      this._lastRebuildAt = Date.now();
      /* 记下"这一轮重建看到的文本总量"：之后若文本量暴涨（内容长出来了），
       * 而观察器又一条记录都没给（换 body 空隙 / CSS 动画显出来 / 记录丢失），
       * 由 growth 通道补一次（见 growthVerdict）。 */
      this._scanTextLen = this.textLen();
      this._pendingSource = null;
      clearTimeout(this._timers.trailing);
      this._timers.trailing = null;
      KH.rebuild({ source });
      return true;
    },

    /**
     * 请求一次重建；所有通道都必须走这里，以获得统一限频仲裁（R14）。
     *
     * 【为什么必须带"尾随合并（trailing）"】
     *   单纯 `if (now - last < gap) return false` 会**静默丢弃**请求。真实会造成残留：
     *   页面在限频窗口内连着变两次（A→B→C），第一次重建把 `_lastRebuildAt` 推到 T，
     *   第二次变化被丢弃；而指纹轮询在采样时**已经更新过 `_lastFingerprint`**，
     *   于是这条通道也不会再触发 → 高亮永远停在 B（与页面显示 C 不一致）。
     *   修法：窗口内的请求**记一次尾随**，在窗口结束时补跑（多次合并成一次），
     *   使"最终一致性"与"限频"同时成立。旧版 `_prcLastRebuild` / `_lastUrlRebuild`
     *   都是"直接丢弃"语义，这也是它翻页偶发残留的来源之一。
     *
     * @param {string} source 触发来源（mutation / url / fingerprint / page-click / visibility / …）
     * @param {{gap?: number}} [opts] gap 覆盖全局最小间隔（如可见性恢复传 0 = 立即）
     * @returns {boolean} 本次是否**立即**执行了重建
     */
    request(source, opts) {
      const o = opts || {};
      const cfg = this._config || {};
      // 【必须用 != null，不能用 ||】显式传入的 `0` 是**合法值**：
      //   测试注入（`pageRebuildSilentMs:0, pageRebuildGapMs:0`）与"可见性恢复立即重建"
      //   都要 gap=0。`|| 2000` 会把 0 吞成默认值 → "页面一变动必须立刻重建"静默失效，
      //   测试里表现为"等 700ms 读到过早状态"（策划案 §7.4 坑 13 的同类错误）。
      const gap = o.gap != null ? o.gap : (cfg.pageRebuildGapMs != null ? cfg.pageRebuildGapMs : 2000);
      const now = Date.now();

      if (gap <= 0) return this._fire(source);

      const since = now - this._lastRebuildAt;
      if (since >= gap) return this._fire(source);

      // 限频窗口内：合并成一次尾随请求，窗口一结束就补跑 —— 绝不静默丢弃
      this._pendingSource = source;
      clearTimeout(this._timers.trailing);
      this._timers.trailing = setTimeout(() => {
        this._timers.trailing = null;
        const src = this._pendingSource;
        if (src) this._fire(src);
      }, gap - since);
      return false;
    },

    /* ---------------- ① MutationObserver ---------------- */

    /** 攒变更记录（静默窗口内可能来好几批，末尾**统一判一次**"值不值得动"；
     *  逐批判会让"先命中变更、后无关变更"被后一批把结论拉低）。上限由 Relevance 内部兜。 */
    _stashRecords(records) {
      if (!this._pendingRecords) this._pendingRecords = [];
      /* 记下**这批记录最早什么时候攒到** —— 延迟上限（_DEFER_CAP_MS）的计时起点。
       * 空了再攒才算"新一批"，中途追加不刷新起点（否则上限自己也会被无限顺延）。 */
      if (!this._pendingRecords.length) this._drainFirstPendingAt = Date.now();
      if (this._pendingRecords.length >= 4000) return;
      for (const r of records) {
        if (this._pendingRecords.length >= 4000) break;
        this._pendingRecords.push(r);
      }
    },

    /**
     * 静默窗口结束后的统一裁决（P1/P2）。
     *   'skip'    → 什么都不做（与命中/抓取/图片都不相关的变动）
     *   'consume' → 只重跑 ⑦Consume（命中集不变、只有抓取字段变了）
     *   'full'    → 走原来的整页重建
     * 判据与安全性见 src/core/relevance.js 顶部：预筛只许放宽，判错最多多重建一次，判漏才是事故。
     */
    /** 排一次裁决（**没在排就不重复排**）。
     * 【为什么不能再 clearTimeout + 重新 setTimeout】那样写会被"源源不断到来的记录"无限延后：
     * 每来一批就重置计时器 → 只要页面上还有任何相关记录在刷新 `_lastMutationAt`，裁决就永远轮不到
     * （实测：`_drainCount` 在属性变化时**不增长**，表现为"显现出来的内容一直不亮"）。
     * 改成"已排就不再排"：**第一次变动之后 silentMs 内必定裁决一次**，`_drainMutations` 内部再做静默判断，
     * 最多多等一轮，绝不会饿死。 */
    _scheduleDrain(silentMs) {
      if (this._timers.silent) return;
      this._timers.silent = setTimeout(() => {
        this._timers.silent = null;
        this._drainMutations(silentMs);
      }, silentMs);
    },

    _drainMutations(silentMs) {
      this._drainCount = (this._drainCount || 0) + 1;                   // 诊断：裁决有没有轮到
      const waited = Date.now() - this._lastMutationAt;                 // 距最后一次变动过了多久
      if (waited < (silentMs || 0) - 10) {
        /* 【还没安静下来】→ 必须**再排一次**（按"剩下的静默时间"）。
         * 旧版这里直接 return，指望"下一条记录到来时顺手排"——可最后一批变动之后不会再有记录，
         * 于是那一批记录永远躺在 `_pendingRecords` 里（表现：翻页后一直不亮）。 */
        const deferredFor = this._drainFirstPendingAt ? (Date.now() - this._drainFirstPendingAt) : 0;
        if (!this._drainFirstPendingAt || deferredFor < this._DEFER_CAP_MS) {
          this._scheduleDrain(Math.max(20, (silentMs || 0) - waited));
          return;
        }
        /* 已经拖够久了（页面在持续变动）→ 再等就是饿死：**不等安静，直接判** */
        this._deferCappedCount = (this._deferCappedCount || 0) + 1;
      }
      this._drainFirstPendingAt = 0;
      const recs = this._pendingRecords || [];
      this._pendingRecords = [];
      const verdict = (KH.Relevance && typeof KH.Relevance.classify === 'function')
        ? KH.Relevance.classify(recs, this._config)
        : 'full';
      if (verdict === 'skip') return;
      if (verdict === 'consume' && typeof KH.consumeOnly === 'function') {
        try { KH.consumeOnly('mutation'); }
        catch (err) { console.error('[KH] 仅消费失败，回退整页重建:', err); this.request('mutation'); }
        return;
      }
      this.request('mutation');
    },

    /**
     * 把某个 ShadowRoot 挂到**同一个**观察器上。
     * 为什么复用同一个 observer 而不是像旧版那样再开一个 `shadowObserver`：
     *   多一个 observer 就多一条能触发重建的通道，而"什么时候重建"必须只有一个限频口径
     *   （R14 / UN-11）。MutationObserver 支持 observe 多个 target，挂进来即可，
     *   通道数不变、抑制窗口不变、限频不变。
     */
    observeShadowRoot(sr) {
      if (!sr || !this._observer) return;
      if (!this._shadowRoots) this._shadowRoots = new Set();
      if (this._shadowRoots.has(sr)) return;
      this._shadowRoots.add(sr);
      try { this._observer.observe(sr, this._observerOptions); }
      catch (err) { /* 非法 target / 已失效的 root → 忽略 */ }
    },

    /** 在某个新加入的节点子树里，把新出现的 ShadowRoot（含嵌套）全挂上 */
    mountShadowRootsIn(node) {
      if (!node || !this._observer) return;
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      if (KH.Scanner && KH.Scanner.shadowRootOf) {
        const self = KH.Scanner.shadowRootOf(node);
        if (self) this.observeShadowRoot(self);
      }
      if (KH.Scanner && KH.Scanner.collectShadowRoots) {
        for (const sr of KH.Scanner.collectShadowRoots(node)) this.observeShadowRoot(sr);
      }
    },

    /**
     * 补挂"晚挂的 ShadowRoot"，**发现新增就请求一次重建**。
     *
     * 为什么需要（真浏览器实测）：`attachShadow` **不产生任何 MutationRecord** ——
     * 宿主元素先插入并静置、之后再 `attachShadow` + 填内容，文档树上"什么都没发生"：
     * 观察器收不到记录、`_shadowRoots` 也不增加 → 9s 内零高亮、零重建；
     * 而手动 `KH.rebuild()` 立刻命中（扫描器进得去 Shadow，缺的只是"触发"）。
     * 真实形态：自定义元素**晚升级**（bundle 异步加载后才 `customElements.define`，
     * 在 `connectedCallback` 里 `attachShadow`）、微前端 strictStyleIsolation。
     *
     * 成本可控：`collectShadowRoots` 用 TreeWalker 逐元素看一眼 `shadowRoot`
     * （不分配整页 NodeList），2s 一次、页面隐藏时跳过、重建窗口内跳过。
     */
    sweepShadowRoots() {
      if (!this._observer) return;                    // 未启用观察（门禁不通过 / 关掉了自动重建）
      const before = this._shadowRoots ? this._shadowRoots.size : 0;
      this.mountShadowRootsIn(document.body || document.documentElement);
      const after = this._shadowRoots ? this._shadowRoots.size : 0;
      if (after > before) this.request('shadow');
    },

    setupObserver(cfg) {
      this.teardownObserver();
      this._config = cfg || this._config;
      if (!this._config || this._config.pageRebuildOnChange === false) return;

      // 同上：`0` 是合法值（测试注入要求"零静默、立即重建"），必须用 != null 判定
      const silentMs = (this._config.pageRebuildSilentMs != null) ? this._config.pageRebuildSilentMs : 1000;
      const shadowOn = this._config.shadowDOMEnabled !== false;   // 旧版默认 true

      this._observer = new MutationObserver((records) => {
        this._observerFireCount = (this._observerFireCount || 0) + 1;   // 诊断：回调到底有没有被调用
        /* 自身写入抑制窗口内：**记录不能丢** —— MutationObserver 只投递一次，丢了就永远补不上。
         * 实测（_e2e/probe-relevance.js）：启动后立刻注入内容 → 记录落在抑制窗口里被 return 掉 →
         * 既没重建也没有兜底（以前是"指纹轮询"这条独立通道碰巧兜住的，P1 已把它在有观察器时收口）。
         * 所以这里改成"先攒着，窗口过去再统一判"。 */
        if (KH.Rebuilder && KH.Rebuilder.inRebuildWindow) {
          this._stashRecords(records);
          this._scheduleDrain(silentMs);
          return;
        }

        // 新出现的 Shadow 宿主：先把它的 ShadowRoot 挂上（否则 Shadow 内部后续变化永不被观察）
        if (shadowOn) {
          for (const rec of records) {
            for (const n of rec.addedNodes) this.mountShadowRootsIn(n);
          }
        }

        let relevant = false;
        for (const rec of records) {
          const t = rec.target;
          // 仅过滤插件自身 UI（唯一允许的过滤）
          if (t && t.nodeType === 1 && t.hasAttribute && t.hasAttribute(KH.Scanner.UI_ATTR)) continue;
          if (KH.Scanner.isOwnUI(t)) continue;
          // ★ 关键补充：`childList` 记录的 `target` 是**父节点**，不是被插入的节点。
          //   我们"把面板/卡片宿主挂到 body 上"时 target 就是 body ——
          //   上面的 isOwnUI(body) 当然是 false，于是"挂自己 UI"这一步会被当成页面变化，
          //   触发一次重建 → ⑧Clear 立刻把刚弹出的卡片 hide 掉（F13 实测：卡片建了又立刻隐藏）。
          //   这里改为看**新增/移除的节点本身**：它们全部带 `data-kh-ext-ui` 时，这次变更就是
          //   我们自己的 UI 挂/摘，跳过。判定依据是**显式标记**而非"内容形态"，
          //   因此不会误杀页面真实的 `td.textContent = 新值`（那种记录里 addedNodes 是普通文本节点）。
          if (rec.type === 'childList' && (rec.addedNodes.length || rec.removedNodes.length)) {
            let onlyOwnUI = true;
            for (const n of rec.addedNodes) if (!KH.Scanner.isOwnUI(n)) { onlyOwnUI = false; break; }
            if (onlyOwnUI) {
              for (const n of rec.removedNodes) if (!KH.Scanner.isOwnUI(n)) { onlyOwnUI = false; break; }
            }
            if (onlyOwnUI) continue;
          }
          relevant = true;
          break;
        }
        if (!relevant) return;

        this._lastMutationAt = Date.now();
        this._stashRecords(records);
        // 静默窗口：距最后一次变动 ≥ silentMs 才重建，避开高频动态竞态（排一次即可，见 _scheduleDrain）
        this._scheduleDrain(silentMs);
      });

      /* 记下**当时**观察的是哪个节点：body 被页面/框架换掉后，观察器会一直盯着那个已脱离文档的旧节点
       * —— 表现是"观察器活着但回调永远不触发"，页面上的变动全丢（实测：整页零重建、也不高亮）。 */
      this._observeTarget = document.body || document.documentElement;
      /* 【绝不能再让 observe() 的失败静默】它抛错的话：`_observer` 与 `_observeTarget` 都是"看起来正常"的，
       * 但一条 MutationRecord 都收不到 → 全页零变更处理（实测现象：observerFire:0 / queued:0，而手动 rebuild 一切正常）。 */
      try {
        this._observer.observe(this._observeTarget, this._observerOptions);
        this._observeError = null;
      } catch (err) {
        this._observeError = String((err && err.message) || err);
        console.error('[KH] MutationObserver.observe 失败（变更将完全收不到）:', err);
      }

      // 首扫前就把已存在的 ShadowRoot 全挂上
      if (shadowOn) this.mountShadowRootsIn(document.body || document.documentElement);

      /* 定期补挂"晚挂的 ShadowRoot"（`attachShadow` 不产生 MutationRecord，见 sweepShadowRoots） */
      clearInterval(this._timers.shadow);
      this._timers.shadow = setInterval(() => {
        if (document.hidden) return;
        if (KH.Rebuilder && KH.Rebuilder.inRebuildWindow) return;
        try { this.sweepShadowRoots(); } catch (err) { /* 尽力而为，绝不因它中断 */ }
        try { this.ensureObserverTarget(); } catch (err) { /* 看门狗同样绝不中断别人 */ }
      }, 2000);
    },

    /**
     * 观察目标看门狗：目标节点被换掉（`document.body` 被页面/框架重建）时重新挂观察器。
     * 【为什么必须有】观察器只认**节点身份**：body 被替换后它盯着的是脱离文档的旧节点，
     * 回调永远不再触发 —— 页面上的变动全丢，表现为"高亮再也不更新"（实测：`observerFire:0` 而观察器存在）。
     * 每 2 秒随"补挂 ShadowRoot"的定时器一起校验一次，开销可忽略。
     */
    ensureObserverTarget() {
      if (!this._observer) return;
      const want = document.body || document.documentElement;
      if (!want || want === this._observeTarget) return;
      try { this._observer.disconnect(); } catch (e) { /* ignore */ }
      this._observeTarget = want;
      this._observer.observe(want, this._observerOptions);
      try { this.mountShadowRootsIn(want); } catch (e) { /* ignore */ }
      this._observerRearmCount = (this._observerRearmCount || 0) + 1;
    },

    teardownObserver() {
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      this._shadowRoots = null;
      clearTimeout(this._timers.silent);
      clearInterval(this._timers.shadow);
      this._timers.shadow = null;
    },

    /* ---------------- ② URL 变化 ---------------- */

    /**
     * URL 变化监听（pushState/replaceState 包装 + popstate/hashchange + 600ms 轮询兜底）。
     *
     * 【本函数会被反复调用，且**每次都必须把轮询重建起来**】
     *   `boot()` 在**初始启动 + 每次 URL 变化后的重评**时都会调它，而 boot() 入口的
     *   `destroy()` → `teardownAll()` 会把这里的轮询 `clearInterval` 掉。
     *   旧实现用 `if (this._urlBound) return` 把**整段**挡住 → 轮询**永不重建**，
     *   于是"第一次路由切换之后，SPA 的路由变化对扩展完全不可见"
     *   （真浏览器实测：主世界 pushState 后 2.5s 零重建、`_lastHref` 冻结在旧 URL）。
     *   所以拆成两段：事件只挂一次（`_urlBound` 守它），**回调与轮询每次刷新**。
     *
     * 【为什么必须有轮询】隔离世界改写的 `history.pushState` 拦不到页面自己在主世界的调用，
     *   而 pushState 不触发 popstate/hashchange —— 轮询是唯一能发现 pushState 路由的通道。
     */
    setupUrlWatcher(onUrlChange) {
      if (onUrlChange) this._urlOnChange = onUrlChange;

      if (!this._urlBound) {
        this._urlBound = true;
        const self = this;
        this._urlFire = () => { if (self._urlOnChange) self._urlOnChange(location.href); };
        try {
          const op = history.pushState, or = history.replaceState;
          history.pushState = function () { const r = op.apply(this, arguments); self._urlFire(); return r; };
          history.replaceState = function () { const r = or.apply(this, arguments); self._urlFire(); return r; };
        } catch (err) {
          console.warn('[KH] history 拦截失败（可能被 CSP/框架冻结），已退回轮询兜底', err);
        }
        window.addEventListener('popstate', this._urlFire);
        window.addEventListener('hashchange', this._urlFire);
      }

      // 轮询兜底：很多 SPA 框架缓存了原生 history 引用，上面的包装与事件都不触发
      this._lastHref = location.href;      // 重取基线，顺带消掉"包装命中 + 轮询再命中"的重复触发
      clearInterval(this._timers.poll);
      this._timers.poll = setInterval(() => {
        if (location.href !== this._lastHref) {
          this._lastHref = location.href;
          if (this._urlOnChange) this._urlOnChange(location.href);
        }
      }, 600);
    },

    /* ---------------- ③ 内容指纹轮询（R13） ---------------- */

    /**
     * 轻量指纹：文本总长 + 首尾采样。
     *
     * 【不能用 innerText】它是**强制布局**的读操作（要算可见性、换行、样式），
     * 实测 2 万元素页面上单次 **5.4ms**，而 `textContent` 只要 **0.8ms**；
     * 这里默认**每秒**跑一次 → 大页面上等于每秒卡一下主线程
     * （用户报的"长时间无响应"里，这一条是持续性的放大器）。
     * `textContent` 只走 DOM 树、不触发布局。
     */
    fingerprint(root) {
      const el = root || document.body;
      if (!el) return '';
      const text = el.textContent || '';
      return text.length + '|' + text.slice(0, 64) + '|' + text.slice(-64);
    },

    setupFingerprintWatcher(cfg) {
      clearInterval(this._timers.fingerprint);
      this._config = cfg || this._config;
      if (!this._config || this._config.pageResidualClean === false) return;
      /* 【收口】这条通道的原意是"没有 MutationObserver 时的翻页清扫兜底"（注释一直这么写），
       * 但实现上它**一直在跑**（默认每秒一次）→ 任何文本变化都会在 1s 内触发一次**整页重建**。
       * 实测（_e2e/probe-relevance.js）：无关变动也照样 rebuild，P1 的变更预筛被它整个盖过去了。
       * 现在按原意收口：有观察器（childList + characterData + subtree）时它不参与；
       * 观察器被关掉（pageRebuildOnChange:false）或环境没有 CSS.highlights 时才当兜底跑。
       * 翻页残留的安全性由 P1 判据接管：换页时旧命中节点会被移出文档 → 判 'full'（relevance.js ②）。 */
      /* 【判据不能只看 `_observer` 是否存在】它可能活着却盯错了节点（见 ensureObserverTarget），
       * 那时页面变动全丢 —— 这种情况必须让指纹通道兜底，否则就是"两条通道同时失效"。 */
      const target = this._observeTarget;
      /* 【K61 实测后回退：保守档**不再**跑这条每秒全文指纹】
       * v1.99.99.30 一度在保守档把它放开（因为 .17 就是这么跑的），但 `probe-mode-ab.js` 量出来：
       * 1500 行页面上**空闲 5 秒** CPU 2433ms、自发整页重建 2 次（每次约 1.5s）、长任务 1153ms、堆 +6.8MB ——
       * 而同期智能档只有 71ms/0 次/0ms/0.1MB，且**两档命中与高亮区间完全一致（3251/3251）**。
       * 也就是说这份开销**换不来任何功能**：它想覆盖的"内容凭空出现"现场，已经由
       * 动画/过渡兜底（`setupAnimWatcher`）与文本量暴涨兜底（`setupGrowthWatcher`）覆盖，
       * 而后两者的空闲成本合计只有 ~7ms/秒。所以这里退回收口状态：只有"观察器不在了"才跑指纹。 */
      if (this._observer && target && (document.body || document.documentElement) === target) return;
      // 只在"无 CSS.highlights"或用户显式开启时消耗；CSS.highlights 环境下 observer 已覆盖绝大多数
      // 同上：`0` 是合法值（测试注入要求"零轮询间隔"），必须用 != null 判定
      const interval = (this._config.pageFingerprintIntervalMs != null) ? this._config.pageFingerprintIntervalMs : 1000;
      this._lastFingerprint = this.fingerprint();

      this._timers.fingerprint = setInterval(() => {
        if (document.hidden) return;
        if (KH.Rebuilder && KH.Rebuilder.inRebuildWindow) return;
        const fp = this.fingerprint();
        if (fp === this._lastFingerprint) return;
        this._lastFingerprint = fp;
        this.request('fingerprint');
      }, interval);
    },

    /* ---------------- ③b 「内容凭空长出来」兜底（K60） ---------------- */

    /** 当前文档文本总长（只读、不触发布局：`textContent` 走 DOM 树，`innerText` 会强制布局） */
    textLen() {
      const el = document.body;
      return el && el.textContent ? el.textContent.length : 0;
    },

    /**
     * 判定"要不要因为文本量暴涨而补一次重建"（纯函数，便于单测）。
     *
     * 【为什么需要它】有几种现场会"内容出现了，但我们一条变动记录都没收到"：
     * 观察器在换 body / 重挂的空隙里、内容由 CSS 动画显出来、或者框架的渲染方式让记录丢了。
     * 实测现场（用户报的"提交后不高亮、刷新才好"）：`上一轮扫描: 文本节点=29`，而同一时刻文档里
     * 有 512 个文本节点 —— 也就是说**内容是在那次扫描之后长出来的**，之后再也没有重建。
     *
     * 【为什么不用旧版的"每秒全文指纹"】那样任何文本变化（时钟跳秒、数字滚动）都会整页重建，
     * 正是 P1 要治的浪费。这里只看**文本总长是否显著增长**：内容"长出来"必然让长度大幅增加，
     * 而同一块文本被改写（时钟/计数）长度基本不变。
     */
    growthVerdict(lastLen, nowLen) {
      const before = Math.max(0, lastLen || 0);
      const now = Math.max(0, nowLen || 0);
      const grew = now - before;
      if (grew <= 0) return false;
      return grew >= Math.max(300, Math.round(before * 0.15));
    },

    setupGrowthWatcher(cfg) {
      clearInterval(this._timers.growth);
      this._timers.growth = null;
      this._config = cfg || this._config;
      if (!this._config || this._config.pageRebuildOnChange === false) return;
      const interval = (this._config.pageFingerprintIntervalMs != null) ? this._config.pageFingerprintIntervalMs : 1000;
      this._scanTextLen = this.textLen();

      this._timers.growth = setInterval(() => {
        if (document.hidden) return;
        if (KH.Rebuilder && KH.Rebuilder.inRebuildWindow) return;
        const now = this.textLen();
        if (!this.growthVerdict(this._scanTextLen, now)) return;
        this._growthCount = (this._growthCount || 0) + 1;
        this.request('growth');
      }, interval);
    },

    /* ---------------- ③c CSS 动画/过渡兜底（K60） ---------------- */

    /**
     * 【为什么必须有这条通道】CSS 动画 / 过渡把内容"显出来"时**不产生任何 MutationRecord**：
     * 变的是样式计算结果，DOM 一个节点、一个属性都没动 —— 观察器、判据、指纹（文本长度）全都没信号。
     * 实测现场（用户报的"提交后不高亮、刷新才好"）：
     *   提交后框架用动画淡入详情区 → 我们那次重建发生在动画**之前** → `上一轮扫描: 文本节点=29 命中=0`；
     *   等动画把内容显出来时，**没有任何变动记录**，于是永远不会再扫 → 高亮 0、面板空；
     *   刷新页面时首扫发生在动画之后 → 命中 4、一切正常。旧版（.17）能工作是因为它那条**每秒指纹轮询**在跑。
     * 做法：动画/过渡结束时补一次重建请求（限频与静默窗口照旧，不会变成"每帧重建"）。
     */
    setupAnimWatcher(cfg) {
      this._config = cfg || this._config;
      if (this._animHandler) {
        document.removeEventListener('animationend', this._animHandler, true);
        document.removeEventListener('transitionend', this._animHandler, true);
        this._animHandler = null;
      }
      if (!this._config || this._config.pageRebuildOnChange === false) return;
      this._animHandler = (e) => {
        const t = e && e.target;
        /* 插件自己的动画（面板淡入等）不算页面内容变化 */
        if (t && t.nodeType === 1 && KH.Scanner && typeof KH.Scanner.isOwnUI === 'function' && KH.Scanner.isOwnUI(t)) return;
        this._animCount = (this._animCount || 0) + 1;
        this.request('anim');
      };
      document.addEventListener('animationend', this._animHandler, true);
      document.addEventListener('transitionend', this._animHandler, true);

      /* 图片**加载完成**也是"看不见的变动"（K62）：懒加载图要等进视口/滚动才拿到 src 并解码，
       * 那一刻 DOM 属性可能早就设好了（那条由属性观察负责），但"像素真正就绪"没有任何记录。
       * 图片命中（OCR）恰恰需要"图已经在那儿"才拿得到，所以这里补一次重建请求（限频照旧）。
       * 只认 `IMG`，且插件自己的 UI（面板缩略图）不算。 */
      if (this._imgLoadHandler) {
        document.removeEventListener('load', this._imgLoadHandler, true);
        this._imgLoadHandler = null;
      }
      this._imgLoadHandler = (e) => {
        const t = e && e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (KH.Scanner && typeof KH.Scanner.isOwnUI === 'function' && KH.Scanner.isOwnUI(t)) return;
        this._imgLoadCount = (this._imgLoadCount || 0) + 1;
        this.request('img-load');
      };
      document.addEventListener('load', this._imgLoadHandler, true);
    },

    /* ---------------- ④ 分页点击捕获（默认关，D4） ---------------- */

    setupPageClickWatcher(cfg) {
      this._config = cfg || this._config;
      if (this._pageClickHandler) {
        document.removeEventListener('click', this._pageClickHandler, true);
        this._pageClickHandler = null;
      }
      if (!this._config || this._config.pageResidualClean === false || this._config.pageCleanClick !== true) return;

      this._pageClickHandler = (e) => {
        const el = e.target;
        const node = el && el.closest ? el.closest(
          'button,a,li,[role="button"],.pagination,.pager,.page,.ant-pagination,' +
          '[class*="pagination"],[class*="-page"],[class*="page-"]'
        ) : null;
        if (!node) return;
        const label = (node.textContent || '').trim();
        const aria = node.getAttribute('aria-label') || '';
        const isPage = /下一页|上一页|首页|末页|‹|›|«|»|…|\.\.\./.test(label) ||
                       /页|page/i.test(aria) ||
                       /^\d{1,3}$/.test(label);
        if (isPage) this.request('page-click');
      };
      document.addEventListener('click', this._pageClickHandler, true);
    },

    /* ---------------- 可见性 / 生命周期 ---------------- */

    setupVisibilityWatcher(cfg) {
      this._config = cfg || this._config;
      if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
      if (!this._config || this._config.suspendInactiveTab === false) return;
      this._visHandler = () => {
        if (document.hidden) {
          // 省资源：只清**视觉**、保留命中表与缓存（切回时 request(gap:0) 立即重建）。
          // 必须走 Rebuilder.clear（唯一清理出口）—— 直接调 Renderer.clear() 就是
          // 第二条视觉清理路径（策划案 §4.7 / 附录A §4：清理只有一条实现）。
          if (KH.Rebuilder) KH.Rebuilder.clear(null, { visual: true, registry: false, reason: 'visibility' });
        } else {
          this.request('visibility', { gap: 0 });
        }
      };
      document.addEventListener('visibilitychange', this._visHandler);
    },

    /** 全量下线（destroy / 切站点 / 插件停用） */
    teardownAll() {
      this.teardownObserver();
      clearInterval(this._timers.poll);
      clearInterval(this._timers.fingerprint);
      clearInterval(this._timers.growth);
      clearTimeout(this._timers.trailing);
      this._timers.poll = null;
      this._timers.fingerprint = null;
      this._timers.growth = null;
      this._timers.trailing = null;
      this._pendingSource = null;
      this._lastRebuildAt = 0;
      if (this._pageClickHandler) {
        document.removeEventListener('click', this._pageClickHandler, true);
        this._pageClickHandler = null;
      }
      if (this._animHandler) {
        document.removeEventListener('animationend', this._animHandler, true);
        document.removeEventListener('transitionend', this._animHandler, true);
        this._animHandler = null;
      }
      if (this._imgLoadHandler) {
        document.removeEventListener('load', this._imgLoadHandler, true);
        this._imgLoadHandler = null;
      }
      if (this._visHandler) {
        document.removeEventListener('visibilitychange', this._visHandler);
        this._visHandler = null;
      }
    }
  };

  KH.Scheduler = Scheduler;
})();
