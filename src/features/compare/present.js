/**
 * src/features/compare/present.js · 比对子系统 · 呈现层（R3）
 * ----------------------------------------------------------------------------
 * 全工程唯一的「结论 → 用户看得见的东西」实现：非颜色标记、底色、悬停文案、证据行。
 * 判定结果从 rules.js 来，本文件不做判等、不认字段名。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});
  const P = (C.Present = C.Present || {});

  function raw(v) { return v == null ? '' : String(v); }

  /** 「没结论」时悬停必须说清是哪一种，否则 ⚙/？/⏱ 看起来一样。 */
  function toneOf(v, what) {
    if (!v) return '';
    if (v.state === 'unset') return '待配置（不改底色）';
    if (v.state === 'timeout') return '超时（不改底色）';
    if (v.color) return '';
    return (raw(what).indexOf('比对「') === 0) ? '无法核实（不改底色）' : '未查明（不改底色）';
  }

  /**
   * 一条判定结论 → 可直接落到行上的四件事。
   * @param {{what:string, state:string, note:string, color?:string, source?:string, value?:string, url?:string, at?:number}} v
   * @returns {{state:string, color:string, mark:object|null, tip:string, evidence:object}}
   */
  function presentVerdict(v) {
    const x = v || {};
    const state = raw(x.state);
    const what = raw(x.what);
    const note = raw(x.note);
    const color = x.color || (C.colorOf ? C.colorOf(state) : '');
    const mark = C.markOf ? C.markOf(state) : null;
    const tone = toneOf({ state: state, color: color }, what);
    const tip = what ? (tone ? (what + '：' + tone + '\n' + note) : (what + '：' + note)) : note;
    return {
      state: state,
      color: color || '',
      mark: mark,
      tip: tip,
      evidence: {
        value: raw(x.value),
        source: raw(x.source),
        url: raw(x.url),
        at: typeof x.at === 'number' ? x.at : 0
      }
    };
  }

  P.toneOf = toneOf;
  P.presentVerdict = presentVerdict;
})();
