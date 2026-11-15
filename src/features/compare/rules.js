/**
 * src/features/compare/rules.js · 比对子系统 · 规则层（R3）
 * ----------------------------------------------------------------------------
 * 全工程唯一的「哪两个值该比、比出什么结论」实现。
 *   · 取数：由调用方注入 `get(field) → {found,value}`，本文件不碰 DOM；
 *   · 判等：一律走 compare/core.js（pairState / keyOf / listHit），不在这里写第二套；
 *   · 呈现：交给 compare/present.js，本文件只产出 state + 说明 + 来源。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});
  const R = (C.Rules = C.Rules || {});
  const keyOf = C.keyOf;

  function raw(v) { return v == null ? '' : String(v); }

  /** 没配比对对时也要和「开发者」比一比的字段：图片里抽到的主体名。 */
  const OWNER_LABELS = ['著作权人', '著作权人名称', '主办单位', 'APP备案主办单位', 'APP备案主办单位名称'];

  /** 总开关：`imgCompare.on === false` 时一律不判。默认 on（老配置没有这个键）。 */
  function enabled(cfg) {
    const ic = cfg && cfg.imgCompare;
    return !(ic && ic.on === false);
  }

  /** 用户配的比对关系 → 归一后的对子表 `[{left,right,kl,kr}]`（方向无关）。 */
  function pairsOf(cfg) {
    const ic = cfg && cfg.imgCompare;
    const rows = ic && ic.rows instanceof Array ? ic.rows : [];
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const p = rows[i] || {};
      const L = raw(p.left).trim();
      const Rr = raw(p.right).trim();
      if (L && Rr) out.push({ left: L, right: Rr, kl: keyOf(L), kr: keyOf(Rr) });
    }
    return out;
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

  /* ---------- ③ 资质里的企业名称 vs 开发者 ---------- */

  /**
   * 营业执照 / 资质里抽到的「企业名称」与卡片里抓取到的「开发者」是否一致。
   * 一致 ⇒ 绿；不一致 ⇒ 黄；缺一边 ⇒ 不涂色（不能假装校验过）。
   * @returns {{state:'same'|'diff'|'unknown', color:string, note:string, company:string, dev:string}}
   */
  function qualVerdict(company, dev) {
    const c = keyOf(company);
    const d = keyOf(dev);
    const rawC = raw(company).trim();
    const rawD = raw(dev).trim();
    if (!c || !d) {
      return {
        state: 'unknown', color: '',
        note: !c ? '没有取到资质里的企业名称' : '卡片里没有「开发者」，无法比对',
        company: rawC, dev: rawD
      };
    }
    if (c === d) return { state: 'same', color: C.COLOR_OK, note: '企业名称与开发者一致', company: rawC, dev: rawD };
    /* 同一家单位的全称 / 简称：只在两边都够长、且互相包含时放行，避免短词误绿。 */
    if (c.length >= 6 && d.length >= 6 && (c.indexOf(d) >= 0 || d.indexOf(c) >= 0)) {
      return { state: 'same', color: C.COLOR_OK, note: '企业名称与开发者写法略有差异，按同一家处理', company: rawC, dev: rawD };
    }
    return { state: 'diff', color: C.COLOR_BAD, note: '企业名称与开发者不一致，请人工确认', company: rawC, dev: rawD };
  }

  /* ---------- ④ 承诺函的承诺对象 ---------- */
  const PROMISE_OTHER = /华为|huawei|小米|xiaomi|oppo|广东欢太|欢太|应用宝|腾讯|荣耀|honor|三星|samsung|魅族|meizu|中兴|努比亚|一加|realme|抖音|快手|百度|阿里/i;
  const PROMISE_GENERIC = /未指定具体平台|各?应用平台|各?应用市场|各?应用商店|各大渠道|所有渠道/;

  /** 放行名单的唯一取值路径（配置 → 默认）。 */
  function promiseOkList(input) {
    let v = input;
    if (v && typeof v === 'object' && !Array.isArray(v)) v = v.promiseOk;
    if (v === undefined || v === null) {
      const d = (KH.Config && KH.Config.defaults && KH.Config.defaults.noteCheck) || null;
      v = d ? d.promiseOk : [];
    }
    if (KH.Config && typeof KH.Config.normalizeNoteCheck === 'function') return KH.Config.normalizeNoteCheck(v).promiseOk;
    return Array.isArray(v) ? v.map((s) => raw(s).trim()).filter(Boolean) : [];
  }

  function listHit(target, list) {
    const kt = keyOf(target);
    if (!kt) return false;
    for (let i = 0; i < list.length; i += 1) {
      const k = keyOf(list[i]);
      if (k && kt.indexOf(k) >= 0) return true;
    }
    return false;
  }

  /**
   * 承诺对象：命中放行名单 ⇒ 绿；无具体平台的泛称 ⇒ 绿；其余 ⇒ 黄交人工。
   * @returns {{state:'ok'|'warn'|'unknown', color:string, note:string, target:string}}
   */
  function promiseVerdict(target, list) {
    const t = raw(target).trim();
    const okList = promiseOkList(list);
    const names = okList.join(' / ');
    if (!t) return { state: 'unknown', color: '', note: '没有取到承诺对象', target: '' };
    if (okList.length && listHit(t, okList)) {
      return { state: 'ok', color: C.COLOR_OK, note: '承诺对象在放行名单（' + names + '）', target: t };
    }
    if (!PROMISE_OTHER.test(t) && PROMISE_GENERIC.test(t)) {
      return { state: 'ok', color: C.COLOR_OK, note: '没有指向具体平台，按应用平台泛称放行', target: t };
    }
    return {
      state: 'warn', color: C.COLOR_BAD, target: t,
      note: okList.length
        ? ('承诺对象不是 ' + names + '，请人工确认')
        : '放行名单为空（设置页 › 样式配置可添加），请人工确认'
    };
  }

  /* ---------- ① 自动行：一个入口出结论 ---------- */

  /**
   * 判定一条自动行该不该上色、上什么色。
   * @param {object} o
   *   o.labels    这一行的全部字段名（合并行可能有多个）
   *   o.value     这一行的值（已剥证据行）
   *   o.dev       卡片里「开发者」的值
   *   o.devPresent 卡片里有没有「开发者」这一行（区分 ⚙待配置 与 ？未查明）
   *   o.cfg       插件配置（imgCompare / noteCheck）
   *   o.get       (field) => {found, value}
   * @returns {null | {what:string, state:string, note:string, source:string, color:string, keyValue:string}}
   */
  function autoVerdict(o) {
    const opts = o || {};
    if (!enabled(opts.cfg)) return null;
    const labels = opts.labels instanceof Array ? opts.labels : [];
    const value = raw(opts.value).trim();
    const dev = raw(opts.dev).trim();
    const get = typeof opts.get === 'function' ? opts.get : () => ({ found: false, value: '' });
    const has = (name) => labels.some((l) => keyOf(l) === keyOf(name));

    if (has('企业名称')) {
      const v = qualVerdict(value, dev);
      let state = v.state;
      let note = v.note;
      if (state === 'unknown' && !opts.devPresent) {
        state = 'unset';
        note = '还没配「开发者」这一行，没法比对（去设置页 › 抓取字段里加上）';
      } else if (state === 'unknown' && !dev) {
        note = '「开发者」这一行是空的，没法比对';
      }
      return { what: '企业名称校验', state: state, note: note, color: state === 'same' ? C.COLOR_OK : (state === 'diff' ? C.COLOR_BAD : ''), source: '本页抓取 · 与开发者比对', keyValue: value };
    }

    if (has('承诺对象')) {
      const v = promiseVerdict(value, opts.cfg && opts.cfg.noteCheck);
      return { what: '承诺对象校验', state: v.state, note: v.note, color: v.color, source: '本页抓取 · 对照放行名单', keyValue: value };
    }

    /* 配置对：行名对上任一侧 ⇒ 取另一侧的卡片值判等。方向无关。 */
    const pairs = pairsOf(opts.cfg);
    let other = '';
    let label = '';
    for (let i = 0; i < labels.length && !other; i += 1) {
      other = otherOf(labels[i], pairs);
      if (other) label = labels[i];
    }
    if (!other) {
      /* ---------- ⑤ T4：主体行兜底与「开发者」比对 ----------
       * 著作权人 / 主办单位这类行没被用户配成比对对时，仍然和开发者比一次：
       * 判等口径完全复用上面的 qualVerdict（归一、≥6 字互相包含），不写第二套。
       * 配置对优先于兜底：用户明确指了别的对侧，就按用户说的比。 */
      const ownerLabel = labels.filter((l) => OWNER_LABELS.some((x) => keyOf(x) === keyOf(l)))[0] || '';
      if (!ownerLabel) return null;
      const whatOwner = '比对「' + ownerLabel + '」↔「开发者」';
      const srcOwner = '本页抓取 · 与开发者比对';
      if (!opts.devPresent) {
        return { what: whatOwner, state: 'unset', color: '', source: srcOwner, keyValue: value,
          note: '还没配「开发者」这一行，没法比对（去设置页 › 抓取字段里加上）' };
      }
      if (!dev) {
        return { what: whatOwner, state: 'unknown', color: '', source: srcOwner, keyValue: value,
          note: '「开发者」这一行是空的，没法比对（不改底色）' };
      }
      const ov = qualVerdict(value, dev);
      if (ov.state === 'same') {
        return { what: whatOwner, state: 'same', color: C.COLOR_OK, source: srcOwner, keyValue: value,
          note: '与「开发者」一致（命中：' + dev + '）' };
      }
      if (ov.state === 'diff') {
        return { what: whatOwner, state: 'diff', color: C.COLOR_BAD, source: srcOwner, keyValue: value,
          note: '与「开发者」不一致（「开发者」= ' + dev + '，这一行 = ' + value + '）' };
      }
      return { what: whatOwner, state: 'unknown', color: '', source: srcOwner, keyValue: value,
        note: '无法核实：两边有一边没取到值（不改底色）' };
    }
    const what = '比对「' + label + '」↔「' + other + '」';
    const src = '本页抓取 · 按你配的比对关系';
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
        note: '与「' + other + '」一致（命中：' + pageV + '）' };
    }
    if (st.state === 'diff') {
      return { what: what, state: 'diff', color: C.COLOR_BAD, source: src, keyValue: value,
        note: '与「' + other + '」不一致（「' + other + '」= ' + pageV + '，这一行 = ' + value + '）' };
    }
    return { what: what, state: 'unknown', color: '', source: src, keyValue: value,
      note: '无法核实：没取到「' + other + '」的值（不改底色）' };
  }


  /* ---------- ④ 软著三方：角色推断 + 逐组判等（原 important-note.js 内实现） ---------- */

  /** 角色推断用的键：与 core.keyOf 同一口径（core 未加载时退回本地等价实现）。 */
  function compareKey(s) {
    if (typeof C.keyOf === 'function') return C.keyOf(s);
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  /**
   * 配置 + OCR 进表行 → 比对计划。
   *   · 哪张图是授权书：该图的进表行里出现了「只在右侧出现」的字段（rightOnly）；
   *     全是双侧字段时退回「有右无左」；一组 rightOnly 都没有 ⇒ docAmbiguous（配置问题）。
   *   · 同角色多张图取并集；右侧值 >1 条 ⇒ 交给 compareProblems 报「授权书内部不一致」。
   * @param {Array<{label:string,value:string,from?:{src:string}}>} rows
   * @param {object} cfg
   * @returns {null | {rows:Array, hasDoc:boolean, docCount:number, docAmbiguous:boolean, rightNames:string[]}}
   */
  function compareOf(rows, cfg) {
    const ic = (cfg && cfg.imgCompare) || null;
    if (!ic || ic.on === false || !ic.rows || !ic.rows.length) return null;
    const leftKeys = new Set();
    const rightKeys = new Set();
    for (let i = 0; i < ic.rows.length; i++) {
      const l = compareKey(ic.rows[i] && ic.rows[i].left);
      const g = compareKey(ic.rows[i] && ic.rows[i].right);
      if (l) leftKeys.add(l);
      if (g) rightKeys.add(g);
    }
    const rightOnly = [];
    rightKeys.forEach((k) => { if (!leftKeys.has(k)) rightOnly.push(k); });
    const rightNames = [];
    if (rightOnly.length) {
      for (let i = 0; i < ic.rows.length; i++) {
        const r = ic.rows[i] || {};
        const rawName = String(r.right || '').trim();
        if (!rawName) continue;
        if (rightOnly.indexOf(compareKey(rawName)) < 0) continue;
        if (rightNames.indexOf(rawName) < 0) rightNames.push(rawName);
      }
    }
    const docAmbiguous = rightOnly.length === 0;
    const bySrc = new Map();
    const loose = new Map();
    const add = (map, k, v) => {
      let a = map.get(k);
      if (!a) { a = []; map.set(k, a); }
      if (a.indexOf(v) < 0) a.push(v);
    };
    for (let i = 0; i < (rows || []).length; i++) {
      const r = rows[i] || {};
      const v = String(r.value == null ? '' : r.value).trim();
      const k = compareKey(r.label);
      if (!v || !k) continue;
      const src = (r.from && r.from.src) || '';
      if (!src) { add(loose, k, v); continue; }
      let m = bySrc.get(src);
      if (!m) { m = new Map(); bySrc.set(src, m); }
      add(m, k, v);
    }
    const ownSrcs = [];
    const docSrcs = [];
    bySrc.forEach((m, src) => {
      let isDoc = false;
      if (rightOnly.length) {
        for (let i = 0; i < rightOnly.length; i++) if (m.has(rightOnly[i])) { isDoc = true; break; }
      } else {
        let hasRight = false;
        let hasLeft = false;
        m.forEach((_v, k) => {
          if (rightKeys.has(k)) hasRight = true;
          if (leftKeys.has(k)) hasLeft = true;
        });
        isDoc = hasRight && !hasLeft;
      }
      (isDoc ? docSrcs : ownSrcs).push(src);
    });
    const collect = (srcList, key) => {
      const out = [];
      for (let i = 0; i < srcList.length; i++) {
        const arr = (bySrc.get(srcList[i]) || new Map()).get(key);
        if (!arr) continue;
        for (let j = 0; j < arr.length; j++) if (out.indexOf(arr[j]) < 0) out.push(arr[j]);
      }
      return out;
    };
    const collectMap = (m, key) => {
      const arr = m.get(key);
      return arr ? arr.slice() : [];
    };
    const list = [];
    for (let i = 0; i < ic.rows.length; i++) {
      const r = ic.rows[i] || {};
      const left = String(r.left || '').trim();
      const right = String(r.right || '').trim();
      if (!left || !right) continue;
      const lk = compareKey(left);
      const rk = compareKey(right);
      list.push({
        left: left, right: right,
        rv: collect(docSrcs, rk),
        /* 图片来源：软著证明优先 → 无来源行 → 授权书图兜底；页面 DOM 值由渲染方补在最前。 */
        lvOcr: collect(ownSrcs, lk).concat(collectMap(loose, lk)).concat(collect(docSrcs, lk))
      });
    }
    return { rows: list, hasDoc: docSrcs.length > 0, docCount: docSrcs.length, docAmbiguous: docAmbiguous, rightNames: rightNames };
  }

  /**
   * 比对计划 → 问题清单。valueOf(field) 由渲染方注入（单测可不传）。
   * 只报：两值不同 / 授权书缺字段 / 软著证明缺字段 / 授权书内部两个值 / 认不出角色。
   * 弱值不参与判等（避免 `12` 撞上 `2024-12-31`）。
   * @returns {Array<{kind:'noDoc'|'noDocAmbig'|'mismatch'|'docMulti'|'missRight'|'missLeft'}>}
   */
  function compareProblems(cmp, valueOf) {
    if (!cmp || !cmp.rows || !cmp.rows.length) return [];
    if (!cmp.hasDoc) {
      if (cmp.docAmbiguous) return [{ kind: 'noDocAmbig' }];
      return [{ kind: 'noDoc', names: cmp.rightNames || [] }];
    }
    const out = [];
    for (let i = 0; i < cmp.rows.length; i++) {
      const r = cmp.rows[i];
      let dom = '';
      try { dom = valueOf ? String(valueOf(r.left) || '').trim() : ''; } catch (e) { dom = ''; }
      const lv = dom || (r.lvOcr[0] || '');
      if (r.rv.length > 1) {
        out.push({ kind: 'docMulti', row: r, lv: lv, rv: r.rv.join(' / ') });
        continue;
      }
      const rv = r.rv[0] || '';
      const st = pairVerdict(lv, rv);
      if (st.state === 'weak' || st.state === 'same' || st.state === 'none') continue;
      if (st.state === 'diff' || st.state === 'conflict' || st.how === 'conflict') out.push({ kind: 'mismatch', row: r, lv: lv, rv: rv });
      else if (st.state === 'only-a' || st.how === 'only-a') out.push({ kind: 'missRight', row: r, lv: lv, rv: rv });
      else if (st.state === 'only-b' || st.how === 'only-b') out.push({ kind: 'missLeft', row: r, lv: lv, rv: rv });
    }
    return out;
  }
  R.enabled = enabled;
  R.pairsOf = pairsOf;
  R.otherOf = otherOf;
  R.pairVerdict = pairVerdict;
  R.qualVerdict = qualVerdict;
  R.promiseVerdict = promiseVerdict;
  R.promiseOkList = promiseOkList;
  R.listHit = listHit;
  R.autoVerdict = autoVerdict;
  R.compareOf = compareOf;
  R.compareProblems = compareProblems;
})();
