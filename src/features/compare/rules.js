/**
 * src/features/compare/rules.js · 比对子系统 · 规则层（R3）
 * ----------------------------------------------------------------------------
 * 全工程唯一的「哪两个值该比、比出什么结论」实现。
 *   · 取数：由调用方注入 `get(field) → {found,value}`，本文件不碰 DOM；
 *   · 判等：一律走 compare/core.js（pairState / keyOf），不在这里写第二套；
 *   · 呈现：交给 compare/present.js，本文件只产出 state + 说明 + 来源。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});
  const R = (C.Rules = C.Rules || {});
  const keyOf = C.keyOf;

  function raw(v) { return v == null ? '' : String(v); }

  /**
   * 【2026-11-16 用户拍板·方案 A】关键词自带的比对对子。
   * 「抓取后续字段」里的 `开发者#比=著作权人` 由 KH.Fetch.parseLabels 读成 cmpOn / cmpTarget，
   * 这里归一成 `[{left,right,kl,kr}]`（同一对只留一条，方向无关）。
   * 这是比对对子的**唯一**来源：设置页那张全局比对表（imgCompare.rows）已随软著三方比对退场。
   */
  function pairsOfLabels(rawLabels) {
    const out = [];
    const F2 = KH.Fetch;
    if (!F2 || typeof F2.parseLabels !== 'function') return out;
    let list = [];
    try { list = F2.parseLabels(rawLabels) || []; } catch (e) { return out; }
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      if (!it.cmpOn) continue;
      const L = raw(it.label).trim();
      const Rr = raw(it.cmpTarget).trim();
      if (!L || !Rr || L === Rr) continue;
      const kl = keyOf(L);
      const kr = keyOf(Rr);
      const sig = [kl, kr].sort().join('\u0001');
      if (!kl || !kr || seen.has(sig)) continue;
      seen.add(sig);
      out.push({ left: L, right: Rr, kl: kl, kr: kr });
    }
    return out;
  }

  /**
   * 这一对是不是「开发者 ↔ 核准主体名称」。
   * 【2026-11-16 用户拍板（甲）】只有这一对要查法人、比同法人；它由 paintEntity 的独立链路出结论，
   * 这里必须让开，否则同一行会挂两枚互相打架的标记。
   */
  function isEntityPair(left, right) {
    const S = C.Sources;
    if (!S || typeof S.fieldKey !== 'function') return false;
    const a = S.fieldKey(left);
    const b = S.fieldKey(right);
    return (a === 'dev' && b === 'entity') || (a === 'entity' && b === 'dev');
  }

  /** 行名对上任一侧时，另一侧叫什么。方向无关：两侧都可能是页面或图片。 */
  function otherOf(label, pairs) {
    const k = keyOf(label);
    if (!k) return '';
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairs[i].kl === k) return pairs[i].right;
      if (pairs[i].kr === k) return pairs[i].left;
    }
    return '';
  }

  /** 两个值像不像：薄包装 core.pairState，口径与表格下方结论行完全一致。 */
  function pairVerdict(a, b) {
    const st = C.pairState ? C.pairState(a, b, { core: true, near: true }) : null;
    if (!st) {
      const x = raw(a).trim();
      const y = raw(b).trim();
      if (!x && !y) return { state: 'none', how: 'none' };
      if (!x) return { state: 'only-b', how: 'only-b' };
      if (!y) return { state: 'only-a', how: 'only-a' };
      return { state: x === y ? 'same' : 'diff', how: x === y ? 'same' : 'conflict' };
    }
    return { state: st.state, how: st.how };
  }

  /* ---------- ① 自动行：一个入口出结论 ---------- */

  /**
   * 判定一条自动行该不该上色、上什么色。
   * @param {object} o
   *   o.labels    这一行的全部字段名（合并行可能有多个）
   *   o.value     这一行的值（已剥证据行）
   *   o.dev       卡片里「开发者」的值
   *   o.devPresent 卡片里有没有「开发者」这一行（区分 ⚙待配置 与 ？未查明）
   *   o.pairs     这个关键词里标了「比对」的字段对（pairsOfLabels 的产出）
   *   o.get       (field) => {found, value}
   * @returns {null | {what:string, state:string, note:string, source:string, color:string, keyValue:string}}
   */
  function autoVerdict(o) {
    const opts = o || {};
    const labels = opts.labels instanceof Array ? opts.labels : [];
    const value = raw(opts.value).trim();
    const get = typeof opts.get === 'function' ? opts.get : () => ({ found: false, value: '' });

    /* 【2026-11-16 用户拍板】判定只认关键词里写的 `#比=对象`（opts.pairs）：
     * 内置三条自动比对、设置页那张全局比对表（imgCompare.rows）与软著三方比对都已退场。
     * 开发者 ↔ 核准主体名称 由 paintEntity 的独立链路出结论（含同法人查询），这里让开。 */
    const pairs = opts.pairs instanceof Array ? opts.pairs : [];
    let other = '';
    let label = '';
    for (let i = 0; i < labels.length && !other; i += 1) {
      const o2 = otherOf(labels[i], pairs);
      /* 【2026-11-16】开发者 ↔ 核准主体名称 让给 paintEntity 的同法人链路：那里查完法人只出一枚结论，
       * 这里再判一次就会在同一行挂两枚互相打架的标记。 */
      if (o2 && !isEntityPair(labels[i], o2)) { other = o2; label = labels[i]; }
    }
    if (!other) return null;
    const what = '比对「' + label + '」↔「' + other + '」';
    const src = '本页抓取 · 按关键词里标的比对';
    const got = get(other) || { found: false, value: '' };
    if (!got.found) {
      return { what: what, state: 'unknown', color: '', source: src, keyValue: value,
        note: '无法核实：这张卡里没有「' + other + '」这一行（图里没认出，或还没配这个抓取字段）' };
    }
    if (!raw(got.value).trim()) {
      return { what: what, state: 'unknown', color: '', source: src, keyValue: value,
        note: '无法核实：「' + other + '」这一行是空的，取不到值（不改底色）' };
    }
    const pageV = raw(got.value).trim();
    const st = pairVerdict(pageV, value);
    if (st.state === 'none' || st.state === 'weak') {
      return { what: what, state: 'unknown', color: '', source: src, keyValue: value,
        note: '无法核实：值太短（弱值），不参与判等（不改底色）' };
    }
    if (st.state === 'same') {
      return { what: what, state: 'same', color: C.COLOR_OK, source: src, keyValue: value,
        how: st.how, note: '「' + other + '」= ' + pageV + '；这一行 = ' + value };
    }
    if (st.state === 'diff') {
      return { what: what, state: 'diff', color: C.COLOR_BAD, source: src, keyValue: value,
        how: 'conflict', note: '「' + other + '」= ' + pageV + '；这一行 = ' + value };
    }
    return { what: what, state: 'unknown', color: '', source: src, keyValue: value,
      note: '无法核实：没取到「' + other + '」的值（不改底色）' };
  }
  R.pairsOfLabels = pairsOfLabels;
  R.isEntityPair = isEntityPair;
  R.otherOf = otherOf;
  R.pairVerdict = pairVerdict;
  R.autoVerdict = autoVerdict;
})();
