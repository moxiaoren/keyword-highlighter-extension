/* ============================================================================
 * src/core/registry.js · ⑥Index —— 命中数据单表 + 事件总线
 * ----------------------------------------------------------------------------
 * 铁律（方案 §2 第 2 条）：一切命中信息只在这里。
 *   · 全库废除 `data-kh-*` 作为数据载体（旧版 data-kh-highlighted / data-kh-fetch-only /
 *     data-kh-important / data-kh-cell-verify 全部作废，meta-check #4 校验 0 命中）。
 *   · DOM 上只允许两类插件属性：`data-kh-ext-ui`（自身 UI 标记）、`data-kh-hl-style`（注入样式节点）。
 *   · 幂等只靠本表：`textNode + [start,end] + ruleId` 去重，不再依赖 DOM 标记（旧版双真源，R2）。
 *
 * Hit 数据契约（方案 §3.2）：
 *   {
 *     id, ruleId, textNode, start, end,
 *     kind: 'normal' | 'combo-lr' | 'combo-tb' | 'rare',
 *     visual: boolean,        // false = 仅抓取：Range 照建、可定位/可聚合，但不进 CSS.highlights（D2）
 *     style: { bgColor, textColor } | null,
 *     meta: { fetchText, combo, note, ... },
 *     contentKey              // 统计去重/聚合脏检查用指纹（R6 / UN-09）
 *   }
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 事件名唯一清单 —— 禁止各处硬编码字符串回调（方案 §3.6） */
  const EVENTS = {
    HITS_CHANGED: 'hits:changed',      // 命中表发生变化（统计/重要笔记订阅）
    REBUILD_DONE: 'rebuild:done',      // 一次重建完成
    CONSUME_ONLY: 'consume:only',      // 只重跑了 Consume（命中集不变的"仅消费"快通道，P2）
    CONFIG_CHANGED: 'config:changed',  // 配置热更新
    SITE_STATE: 'site:state'           // 站点启用/禁用切换
  };

  /**
   * 取"某条命中在指定文本节点上的区间段"。
   *   · 普通（单节点）命中：段就是 [start, end)；
   *   · 跨节点命中：按 `segments` 找该节点对应的那一段（首段 [start, 首节点末]、中间整段、末段 [0, endOffset)）。
   * 找不到 → null（说明该命中其实没覆盖这个节点）。
   */
  function segIn(hit, node) {
    if (!hit) return null;
    if (!hit.segments) return hit.textNode === node ? { node, start: hit.start, end: hit.end } : null;
    for (const s of hit.segments) if (s.node === node) return s;
    return null;
  }

  class HitRegistry {
    constructor() {
      /** @type {Map<string, object>} id -> Hit */
      this._hits = new Map();
      /** @type {Map<Text, Set<string>>} textNode -> hitIds（幂等去重 + 定点查询用） */
      this._byNode = new WeakMap();
      /** @type {Map<string, Set<string>>} dedupeKey -> hitIds */
      this._byKey = new Map();
      /** @type {Map<string, Set<string>>} ruleId -> hitIds（按规则聚合/改色用） */
      this._byRule = new Map();
      this._seq = 0;
      this._listeners = new Map();
      /** 文本节点身份编号（WeakMap，不阻碍 GC）——
       *  去重键必须包含"哪个文本节点"，否则同一页面上所有同长度命中会互相顶掉
       *  （真实踩过：600 个 `<span>甲胎蛋白</span>` 只渲染出 1 处高亮）。 */
      this._nodeIds = new WeakMap();
      this._nodeSeq = 0;
    }

    /** 文本节点 → 稳定身份串 */
    _nodeId(node) {
      if (!node) return '0';
      let id = this._nodeIds.get(node);
      if (!id) { id = 'n' + (++this._nodeSeq); this._nodeIds.set(node, id); }
      return id;
    }

    /* ---------------- 事件总线 ---------------- */

    on(evt, fn) {
      if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
      this._listeners.get(evt).add(fn);
      return () => this.off(evt, fn);
    }

    off(evt, fn) {
      const set = this._listeners.get(evt);
      if (set) set.delete(fn);
    }

    emit(evt, payload) {
      const set = this._listeners.get(evt);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (err) { console.error('[KH] 事件处理异常', evt, err); }
      }
    }

    /* ---------------- 写入 ---------------- */

    /**
     * 幂等键：**同一文本节点** + 同一区间 + 同一规则 → 同一条命中。
     * 三个维度缺一不可：漏掉 node 会让同页所有同长度命中互相顶掉；
     * 漏掉区间会让同节点多次命中丢失；漏掉 ruleId 会让多规则命中合并。
     */
    keyOf(ruleId, node, start, end) {
      return ruleId + '\u0000' + this._nodeId(node) + '\u0000' + start + '\u0000' + end;
    }

    /**
     * 登记一条命中。重复登记返回已存在的那条（幂等），不产生新 id。
     * @returns {{hit: object, created: boolean}}
     */
    add(hit) {
      const key = this.keyOf(hit.ruleId, hit.textNode, hit.start, hit.end);
      const existing = this._byKey.get(key);
      if (existing && existing.size) {
        const id = existing.values().next().value;
        return { hit: this._hits.get(id), created: false };
      }
      const id = 'h' + (++this._seq);
      const rec = Object.assign({
        id,
        kind: 'normal',
        visual: true,
        style: null,
        meta: {},
        contentKey: null
      }, hit, { id });

      this._hits.set(id, rec);
      this._indexKey(key, id);
      this._indexRule(rec.ruleId, id);
      /* 【跨节点命中】按**每一段**建索引 —— 否则鼠标点在第二段上时 byNode() 查不到，
       * 悬浮备注 / 点击卡片会在被拆开的词的后半段上失效。单节点命中只有一段，行为不变。 */
      for (const seg of (rec.segments || [{ node: rec.textNode }])) this._indexNode(seg.node, id);
      return { hit: rec, created: true };
    }

    _indexKey(key, id) {
      if (!this._byKey.has(key)) this._byKey.set(key, new Set());
      this._byKey.get(key).add(id);
    }

    _indexRule(ruleId, id) {
      if (!this._byRule.has(ruleId)) this._byRule.set(ruleId, new Set());
      this._byRule.get(ruleId).add(id);
    }

    _indexNode(node, id) {
      if (!node) return;
      let set = this._byNode.get(node);
      if (!set) { set = new Set(); this._byNode.set(node, set); }
      set.add(id);
    }

    /* ---------------- 读取 ---------------- */

    get size() { return this._hits.size; }

    all() { return Array.from(this._hits.values()); }

    /** 只取需要视觉渲染的（`visual === false` 的「仅抓取」命中在此被天然排除，D2） */
    visualOnly() { return this.all().filter(h => h.visual !== false); }

    byId(id) { return this._hits.get(id) || null; }

    byRule(ruleId) {
      const ids = this._byRule.get(ruleId);
      return ids ? Array.from(ids).map(i => this._hits.get(i)).filter(Boolean) : [];
    }

    /** 某文本节点上的全部命中（按 start 升序） */
    byNode(node) {
      const set = this._byNode.get(node);
      if (!set) return [];
      return Array.from(set).map(i => this._hits.get(i)).filter(Boolean).sort((a, b) => a.start - b.start);
    }

    /**
     * 定点命中查询 —— 交互定位的**唯一**入口（方案 §2 第 3 条）。
     * 禁止 `closest('.kh-highlight')` 之类 DOM 反查。
     *
     * 区间口径与 `CSS.highlights` 的 Range 一致：`[start, end)`。
     *   · 用 `offset < end` 而非 `<= end`：相邻命中 `[0,3)` / `[3,6)` 在中缝处只能命中左侧那个
     *     （`<=` 会让两条同时命中，返回哪条取决于遍历顺序 → 不确定行为）。
     *   · 恰好点在命中**右端之外一格**（`offset === end`）时回退到该条：
     *     鼠标点在词尾右侧像素上时 `caretPositionFromPoint` 常给到 end，此时应当命中原词。
     * @param {Text} node 由 pointToRange 得到的文本节点
     * @param {number} offset
     */
    query(node, offset) {
      if (!node) return null;
      const list = this.byNode(node);
      let edge = null;
      for (const h of list) {
        /* 【跨节点命中】`h.start/h.end` 是**起始节点内**的偏移；鼠标点在第二段上时，
         * 该段的区间是 [0, endOffset)（中间段是整段）。所以按"该条命中在本节点上的段"来判包含。 */
        const seg = segIn(h, node);
        if (!seg) continue;
        if (offset >= seg.start && offset < seg.end) return h;
        if (offset === seg.end) edge = h;   // 兜底：只在没有严格区间命中时使用
      }
      return edge;
    }

    /** 按规则聚合统计（重要笔记 / 弹窗计数） */
    countsByRule() {
      const out = {};
      for (const h of this._hits.values()) out[h.ruleId] = (out[h.ruleId] || 0) + 1;
      return out;
    }

    /* ---------------- 清理 ---------------- */

    /** 单条移除 */
    remove(id) {
      const rec = this._hits.get(id);
      if (!rec) return false;
      this._hits.delete(id);
      const key = this.keyOf(rec.ruleId, rec.textNode, rec.start, rec.end);
      const ks = this._byKey.get(key); if (ks) { ks.delete(id); if (!ks.size) this._byKey.delete(key); }
      const rs = this._byRule.get(rec.ruleId); if (rs) { rs.delete(id); if (!rs.size) this._byRule.delete(rec.ruleId); }
      // 与 add 对称：跨节点命中在每一段上都建过索引，移除也要逐段摘掉
      for (const seg of (rec.segments || [{ node: rec.textNode }])) {
        const ns = seg.node && this._byNode.get(seg.node);
        if (ns) ns.delete(id);
      }
      return true;
    }

    /** 全量清空。注意：这只是清表，视觉清理归 rebuilder.js（单一出口），二者必须成对调用。 */
    clear() {
      this._hits.clear();
      this._byKey.clear();
      this._byRule.clear();
      this._byNode = new WeakMap();
      this._seq = 0;
      // 节点身份编号一并重置：同一轮重建内必须稳定，跨轮无需保留
      this._nodeIds = new WeakMap();
      this._nodeSeq = 0;
    }
  }

  KH.EVENTS = EVENTS;
  KH.HitRegistry = HitRegistry;
  /** 单例（门面 KH 与各 feature 一律用这个实例，禁止 new 第二份） */
  KH.registry = new HitRegistry();
})();
