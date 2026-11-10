/* 指向（`@字段名`）诊断：**只回答"这一条指向能不能生效"，不参与命中判定**
 *
 * 为什么单独成模块：这句话要在**两个世界**里都能跑 ——
 *   · 内容脚本（页内委派编辑器）：`KH.ImgOcr` 在，但走的是同一套解析；
 *   · 设置页 / 独立编辑窗口：**不加载** `src/features/img-ocr.js`（那是内容特性），
 *     于是从前把诊断写在 img-ocr 里，设置页里 `KH.ImgOcr` 是 undefined，提醒永远不出现 ——
 *     「指向写错静默不生效」正是在设置页编辑时最容易发生。
 * 所以解析规则（与 `img-ocr.js` 的 `splitScope` 严格同构）下沉到这里，两边共用一份。
 *
 * 硬约束：**诊断不改判定**。这里一个字都不写回配置，也不改变 `scopedRaw` 的取舍；
 * 老用户把 `@` 当普通字符的写法必须继续原样工作（所以"配不上就当普通词"是规则，不是缺陷）。
 */
(function (root) {
  const KH = (root.KH = root.KH || {});

  const WHITE_ALL = /\s+/g;
  const KV_MARK = /(?:#|＃)\s*(?:表|kv)\s*$/i;
  /* 取值后缀（`^锚点` `!` `%`）绝不可能出现在**字段名**里：它属于「抓取后续字段」那一格 */
  const SUFFIX_RE = /[!^%]/;

  function norm(s) {
    return String(s == null ? '' : s).replace(WHITE_ALL, '').trim().toLowerCase();
  }

  function sameField(a, b) {
    return !!norm(a) && norm(a) === norm(b);
  }

  /** 已配置的抓取字段裸名：优先用 `KH.Fetch.parseLabels`（唯一权威解析），没有就退回本地切分 */
  function knownOf(raw) {
    const out = [];
    const push = (name) => {
      const v = String(name == null ? '' : name).trim();
      if (v && out.indexOf(v) < 0) out.push(v);
    };
    const F = KH.Fetch;
    if (F && typeof F.parseLabels === 'function') {
      try {
        for (const it of (F.parseLabels(raw) || [])) push(it && it.label);
        return out;
      } catch (e) { /* 落到本地切分 */ }
    }
    /* 本地切分与 `splitLabelTokens` 同口径：`|` `｜` 永远是分隔符；`,` `，` 只在不属于
     * `@1,3` 这种值格表达式时才算。这里只给设置页兜底（那边其实也加载了 fetch.js）。 */
    for (const chunk of String(raw == null ? '' : raw).split(/[|｜]/)) {
      let cur = '';
      for (const piece of chunk.split(/[,，]/)) {
        const p = piece.trim();
        if (!p) continue;
        if (cur && /@[0-9\s-]+$/.test(cur) && /^[0-9\s-]+$/.test(p)) { cur += ',' + p; continue; }
        if (cur) push(cur);
        cur = p;
      }
      if (cur) push(cur);
    }
    return out;
  }

  /** 一个词 → `{name, scopes, mark, rest}`（与 `splitScope` 同一套规则；`rest` 是"剩下的普通词"） */
  function splitChip(chip, known) {
    let s = String(chip == null ? '' : chip).trim();
    let mark = '';
    const km = KV_MARK.exec(s);
    if (km) { mark = km[0]; s = s.slice(0, km.index).trim(); }
    const list = known || [];
    const scopes = [];
    for (;;) {
      const m = /@([^@\s]+)$/.exec(s);
      if (!m) break;
      const name = m[1].trim();
      let hit = '';
      for (const k of list) if (sameField(k, name)) { hit = k; break; }
      if (!hit) break;
      if (scopes.indexOf(hit) < 0) scopes.unshift(hit);
      s = s.slice(0, m.index).trim();
    }
    return { name: s, scopes: scopes, mark: mark, rest: s + mark };
  }

  /** 编辑距离（只用来给"是不是某个已配字段"的建议，不做模糊判定） */
  function dist(a, b) {
    const x = String(a || ''), y = String(b || '');
    const m = x.length, n = y.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function suggestOf(name, known) {
    const n = String(name || '');
    if (!n) return '';
    for (const k of (known || [])) {
      if (k === n) return k;
      if (k.indexOf(n) === 0 || n.indexOf(k) === 0) return k;   // 前缀关系：少打/多打了尾巴
    }
    let best = '', bestD = 99;
    for (const k of (known || [])) {
      if (Math.abs(k.length - n.length) > 1) continue;          // 差太多就不猜，免得指错
      const d = dist(n, k);
      if (d < bestD) { bestD = d; best = k; }
    }
    return bestD <= 1 ? best : '';
  }

  /** 一条词 → 第一个生效不了的指向；没有就 `null`（与 splitScope 同构：只要有一个配不上，
   *  它后面（更靠左）的那些 `@` 也不再生效，所以只报**最靠右**的那个问题点） */
  function issueOf(chip, known) {
    let s = String(chip == null ? '' : chip).trim();
    const km = KV_MARK.exec(s);
    if (km) s = s.slice(0, km.index).trim();
    const list = known || [];
    for (;;) {
      const m = /@([^@\s]+)$/.exec(s);
      if (!m) return null;
      const name = m[1].trim();
      let hit = false;
      for (const k of list) if (sameField(k, name)) { hit = true; break; }
      if (!hit) {
        return {
          chip: String(chip == null ? '' : chip),
          name: name,
          kind: SUFFIX_RE.test(name) ? 'suffix' : 'unknown',
          suggest: suggestOf(name, list)
        };
      }
      s = s.slice(0, m.index).trim();
    }
  }

  /**
   * 诊断一批词（`|` 分隔或数组）。
   * @param {string|string[]} raw 词串
   * @param {string[]} known 已配的抓取字段裸名（调用方给；不给自己从 `KH.Fetch` 推）
   * @returns {Array<{chip:string,name:string,kind:'unknown'|'suffix',suggest:string}>}
   */
  function scopeIssues(raw, known) {
    const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[|｜\n]/);
    const out = [];
    for (const chip of list) {
      if (!String(chip == null ? '' : chip).trim()) continue;
      const bad = issueOf(chip, known);
      if (bad) out.push(bad);
    }
    return out;
  }

  /** 一条关键词配置 → 两个指向字段的问题（`imgOcrKeyword` / `imgOcrNeed`），带 `field` 归属 */
  function scopeIssuesOf(meta, known) {
    const m = meta || {};
    const kn = known || knownOf(m.fetchLabels);
    const out = [];
    for (const field of ['imgOcrKeyword', 'imgOcrNeed']) {
      for (const it of scopeIssues(m[field], kn)) out.push(Object.assign({ field: field }, it));
    }
    return out;
  }

  KH.Scope = {
    scopeIssues: scopeIssues,
    scopeIssuesOf: scopeIssuesOf,
    splitChip: splitChip,
    sameField: sameField,
    knownOf: knownOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
