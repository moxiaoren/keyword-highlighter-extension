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

  /* 【T6】写法差异统一命名：同值但归一后才相等时，悬停要说是哪种差异，
   * 用户才知道「为什么它说同一家」。标签从 core.pairState 的 how 来。 */
  const DIFF_KIND = {
    'fold-ws': '空格', 'fold-width': '全半角', 'fold-punct': '标点', 'fold-zero': '零宽字符',
    'fold-case': '大小写', 'fold-core': '括号补充', 'fold-admin': '行政区划写法',
    'near': '差一个字', 'contain': '互相包含', 'org': '互相包含'
  };
  function diffKind(how) { return DIFF_KIND[raw(how)] || ''; }

  /* 【T6】下一步只给「用户还能做点什么」的状态；一致/不一致的处置写在原因里就够。 */
  function nextStepFor(state) {
    if (state === 'unset') return '想比对：设置页 › 抓取字段里加上缺的那一行。';
    if (state === 'diff' || state === 'warn') return '人工确认哪一行是对的；这两行本不该比就去设置页 › 软著三方比对改配对。';
    if (state === 'timeout') return '稍后重新打开这张卡会自动重查。';
    return '';
  }

  /**
   * 【T6】悬停降维：最多三句、第一句是结论。
   * 旧写法把 what + tone + note 直接拼成一串，用户要读完才知道结论；
   * 现在第一行固定是「什么 · 结论（差异类型）」，第二行才是原因，第三行是下一步。
   */
  function tipFor(v) {
    const x = v || {};
    const state = raw(x.state);
    const what = raw(x.what);
    const note = raw(x.note);
    const how = raw(x.how);
    const head = (state === 'same' || state === 'ok') ? '一致'
      : (state === 'diff' || state === 'warn') ? '不一致'
        : (state === 'unset') ? '待配置'
          : (state === 'timeout') ? '超时'
            : (state === 'weak') ? '值太短，不参与判等'
              : '无法核实';
    const kind = (state === 'same' && how && how !== 'same') ? diffKind(how) : '';
    const soft = (state === 'unset' || state === 'timeout' || state === 'unknown') ? '（不改底色）' : '';
    const first = (what ? what + '：' : '') + head
      + (kind ? '（写法略有差异：' + kind + '，按同一家处理）' : '') + soft;
    const lines = [first];
    /* note 与结论重复时（「与「X」一致（命中：Y）」）不再单列，避免同一句话说两遍。 */
    const dup = !note || note.indexOf('写法略有差异') >= 0 || /^与「.*」(一致|不一致)/.test(note)
      || note.indexOf(head) === 0;
    if (!dup) lines.push(note);
    const next = nextStepFor(state);
    if (next) lines.push(next);
    return lines.slice(0, 3).join('\n');
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
    const tip = tipFor({ what: what, state: state, note: note, how: x.how });
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
  P.tipFor = tipFor;
  P.diffKind = diffKind;
  P.nextStepFor = nextStepFor;
  P.presentVerdict = presentVerdict;
  P.compareText = compareText;
})();
