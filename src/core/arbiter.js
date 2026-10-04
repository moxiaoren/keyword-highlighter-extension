/* ============================================================================
 * src/core/arbiter.js · ④Resolve —— 重叠命中裁决
 * ----------------------------------------------------------------------------
 * 职责：把 RawHit[] 收敛为**互不重叠**的 ResolvedHit[]，并给出确定性优先级。
 *   · 纯函数式、无 DOM 依赖 → 可在 Node 里单测（tools/tests/specs/unit-arbiter）。
 *   · 裁决规则必须确定：同一输入永远同一输出（否则重建会闪烁）。
 *
 * 优先级（从高到低，**定稿口径见附录A §1.5**）：
 *   1. 长匹配优先（length 大者胜）
 *   2. 显式权重 rule.priority 大者胜（留给未来"命中图片"等能力做显式压级）
 *   3. 更小的关键词标识（kwId / ruleId）胜 —— 即"配置顺序靠前"的词优先
 *   4. 稳定兜底：start 升序 → 先登记者胜（保证同一输入永远同一输出，重建不闪烁）
 *
 * 【与 v2 早前实现的差异（有意修正）】早前把「组合词 kind 权重」放在第一位，
 * 于是"短组合词"会压掉"覆盖它的长普通词"，与附录A §1.5 的定稿口径不符。
 * 组合词的格子级 Range 本来就通常更长，靠"长度优先"已能自然胜出，
 * 不需要额外的 kind 加权 —— 加权反而让点击/聚合取到的命中与规格不一致。
 *
 * 绝不 discard：被覆盖的命中仍保留在 `shadowed` 里，供"仅抓取/统计/聚合"继续使用
 * —— 这是旧版「同一词既高亮又要抓取值」场景不丢数据的保障。
 *
 * 【v1.99.99.10 修正：跨文本节点命中的重叠判定】
 *   旧 `overlaps()` 只比"起始节点 + 区间"，而跨节点命中的 `node` 只是**第一段**：
 *   `审<span>核</span>不通过` 里「核不」（起点在 span 内）与「审核不」（起点在 span 前）
 *   互相重叠却判不出来 → 同一段文字被两个高亮组叠着涂。
 *   现在按 `segments` 展开逐段比较（单节点命中走原快速通道，性能不变）。
 *   这会让"谁压谁"的结果更严格：视觉重叠的命中只渲染一个，另一个进 `shadowed`（数据照旧保留）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** kind 权重仅作**显式 priority 缺省时的参考**，不参与主排序（保留导出供诊断/测试） */
  const KIND_WEIGHT = {
    'combo-tb': 40,
    'combo-lr': 35,
    'rare': 20,
    'normal': 10
  };

  /** ruleId 通常是 `kw_<base36时间>_<随机>`，同批次生成时前缀相同 —— 直接字典序即可稳定 */
  function rank(a, b) {
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la !== lb) return lb - la;                       // ① 长匹配优先

    const pa = a.rule.priority || 0;
    const pb = b.rule.priority || 0;
    if (pa !== pb) return pb - pa;                       // ② 显式权重

    const ra = String(a.rule.ruleId);
    const rb = String(b.rule.ruleId);
    if (ra !== rb) return ra < rb ? -1 : 1;              // ③ 更小的 kwId 胜（配置靠前者优先）

    if (a.start !== b.start) return a.start - b.start;   // ④ 先登记者胜
    return (a.seq || 0) - (b.seq || 0);
  }

  /**
   * 一条命中占用的文本区间列表。
   *
   * 【为什么必须展开 segments】跨文本节点命中的 `node/start/end` **只描述第一段**
   *   （真正的终点在 `endNode/endOffset`，各段在 `segments` 里）。只比第一段的话，
   *   "起点在不同节点、但视觉范围重叠"的两条命中判不出来 —— 例如
   *   `审<span>核</span>不通过` 里「核不」与「审核不」都跨节点且互相重叠：
   *   前者起点在 `<span>` 内、后者起点在 span 前的文本节点，`a.node !== b.node` 直接返回 false
   *   → 两条都被渲染 → **同一段文字被两个高亮组叠着涂**（观感是颜色糊在一起）。
   */
  function spansOf(h) {
    if (h && h.segments && h.segments.length) return h.segments;
    return [{ node: h ? h.node : null, start: h ? h.start : 0, end: h ? h.end : 0 }];
  }

  function overlaps(a, b) {
    const ac = !!(a && a.segments && a.segments.length);
    const bc = !!(b && b.segments && b.segments.length);
    /* 快速通道：两条都是单节点命中（绝大多数）→ 与旧实现完全一致，不产生额外开销
     * （裁决是 O(n²)，1800 命中时约 160 万次比较，这里不能每次分配数组） */
    if (!ac && !bc) {
      if (!a || !b || a.node !== b.node) return false;
      return a.start < b.end && b.start < a.end;
    }
    const A = ac ? a.segments : spansOf(a);
    const B = bc ? b.segments : spansOf(b);
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < B.length; j++) {
        const x = A[i], y = B[j];
        if (!x || !y || x.node !== y.node) continue;
        if (x.start < y.end && y.start < x.end) return true;
      }
    }
    return false;
  }

  const Arbiter = {
    KIND_WEIGHT,
    rank,
    overlaps,
    spansOf,

    /**
     * @param {RawHit[]} raw
     * @returns {{resolved: RawHit[], shadowed: RawHit[]}}
     */
    resolve(raw) {
      // 先登记"输入序"（先登记者胜的兜底依据）—— 同一输入永远同一输出
      const list = (raw || []).slice();
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].seq == null) list[i].seq = i;
      const sorted = list.sort(rank);
      const resolved = [];
      const shadowed = [];
      for (const h of sorted) {
        let conflict = false;
        for (const r of resolved) {
          if (overlaps(h, r)) { conflict = true; break; }
        }
        if (conflict) shadowed.push(h);
        else resolved.push(h);
      }
      return { resolved, shadowed };
    }
  };

  KH.Arbiter = Arbiter;
})();
