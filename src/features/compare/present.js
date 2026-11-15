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


  /**
   * 问题清单 → 表格下方那一行结论（无问题 ⇒ 空串 ⇒ 不渲染）。
   * 文案全部来自 KH.OcrCopy.VIEW；右侧字段名从配置取值后拼进来，不写死。
   */
  function compareText(problems, hasDoc) {
    if (!problems || !problems.length) return '';
    const V = (KH.OcrCopy && KH.OcrCopy.VIEW) || {};
    const render = (KH.OcrCopy && typeof KH.OcrCopy.render === 'function')
      ? KH.OcrCopy.render
      : (t, o) => String(t).replace(/\{(\w+)\}/g, (m, k) => (o && o[k] != null ? String(o[k]) : ''));
    const msgs = [];
    const namesOf = (arr) => (arr || []).map((n) => '「' + n + '」').join('');
    for (let i = 0; i < problems.length; i++) {
      const p = problems[i];
      if (p.kind === 'noDoc') {
        msgs.push(render(V.cmpNoDoc || '', { names: namesOf(p.names) }));
      } else if (p.kind === 'noDocAmbig') {
        msgs.push(V.cmpNoDocAmbig || '');
      } else if (p.kind === 'mismatch') {
        msgs.push(render(V.cmpMismatch || '', { left: p.row.left, right: p.row.right, lv: p.lv, rv: p.rv }));
      } else if (p.kind === 'docMulti') {
        msgs.push(render(V.cmpDocMulti || '', { right: p.row.right, vals: p.rv }));
      } else if (p.kind === 'missRight') {
        msgs.push(render(V.cmpMissRight || '', { right: p.row.right }));
      } else if (p.kind === 'missLeft') {
        msgs.push(render(V.cmpMissLeft || '', { left: p.row.left }));
      }
    }
    const out = [];
    for (let i = 0; i < msgs.length; i++) if (msgs[i] && out.indexOf(msgs[i]) < 0) out.push(msgs[i]);
    return out.join(V.cmpSep || '；');
  }
  P.toneOf = toneOf;
  P.presentVerdict = presentVerdict;
  P.compareText = compareText;
})();
