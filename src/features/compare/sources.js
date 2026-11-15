/**
 * src/features/compare/sources.js · 比对子系统 · 来源层（R2）
 * ----------------------------------------------------------------------------
 * 只回答「这张卡里有什么」：字段别名、从单元格里认出字段名、取字段值。
 * 不判等（core.js）、不决定比谁（rules.js）、不画界面（present.js）。
 *
 * 从 2.0.8.8 的 note-check.js 搬来，行为逐字保留，尤其是**从右端逆序剥徽标**：
 * 面板会往左列 append 判定标记、往值格 append 证据行；一旦用 textContent 直接读，
 * 下一轮就把「企业名称✔ 一致」当成字段名、把证据文字当成值。
 */
(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});
  const Sources = {};

  function TN() { return (typeof KH !== 'undefined' && KH.TextNorm) || null; }

  /** 字段名归一：去括号补充 + TextNorm 五级折叠。 */
  function keyOf(s) {
    const t = TN();
    if (t) return t.keyOf(t.coreOf(s));
    return String(s == null ? '' : s).replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, '').replace(/（）/g, '()').replace(/[：:]/g, '').toLowerCase();
  }
  Sources.keyOf = keyOf;

  /* 字段别名：一个字段接受哪些写法。新增文档类型时只往这里加一行。 */
  const FIELDS = {
    title: ['主标题', '标题', '应用名称', '应用名', '软件名称'],
    dev: ['开发者', '开发者名称', '开发商', '开发公司'],
    /* APP备案主办单位 是 OcrAuto 给「备案核准」类文档登记的行名（record-app 映射）。 */
    entity: ['核准主体名称', '核准主体', '主体名称', '主办单位名称', '主办单位', 'APP备案主办单位', 'APP备案主办单位名称'],
    link: ['隐私政策链接', '隐私政策地址', '隐私权政策链接', '政策链接', '隐私链接'],
    policy: ['隐私政策', '隐私权政策', '隐私政策内容']
  };
  Sources.FIELDS = FIELDS;

  /** 某一行左列是不是我们要的字段；返回 key（title/dev/entity/link/policy）或空串。 */
  Sources.fieldKey = function (label) {
    const k = keyOf(label);
    if (!k) return '';
    const keys = Object.keys(FIELDS);
    for (let i = 0; i < keys.length; i += 1) {
      const list = FIELDS[keys[i]];
      for (let j = 0; j < list.length; j += 1) if (keyOf(list[j]) === k) return keys[i];
    }
    return '';
  };

  /**
   * 单元格里的纯字段名。
   * 只能从末尾按徽标逆序剥，不能全局删：字段名本身就可能含「名」（应用名称）。
   * 合并行（fetch.js 把同值字段并成一行）取 .kh-lbt 的最短名，展开区交给 labelsOf。
   */
  Sources.labelText = function (td) {
    if (!td) return '';
    const lbt = td.querySelector ? td.querySelector('.kh-lbt') : null;
    if (lbt) return String(lbt.textContent || '');
    let s = String(td.textContent || '');
    /* 三类小标都是 append 进去的，按 DOM 顺序**从后往前**逐段剥：
     * 判定标记可能排在政策徽标之后（先画徽标、后画笔标），按类分组剥会漏（'隐私政策名'）。 */
    const nodes = td.querySelectorAll ? td.querySelectorAll('.kh-policy-flag, .kh-verdict, .kh-table-more') : [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const t = String(nodes[i].textContent || '');
      if (!t) continue;
      if (s.slice(-t.length) === t) s = s.slice(0, -t.length);
    }
    return s;
  };

  /** 一行左列里所有字段名（合并行多个）。优先 .kh-table-all 的 <br> 分段，其次 .kh-lbt[title]。 */
  Sources.labelsOf = function (td) {
    const out = [];
    const push = (s) => {
      const t = String(s == null ? '' : s).trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    };
    if (!td) return out;
    const lbt = td.querySelector ? td.querySelector('.kh-lbt') : null;
    if (lbt) {
      const title = lbt.getAttribute ? String(lbt.getAttribute('title') || '') : '';
      if (title) title.split('/').forEach(push);
      push(lbt.textContent);
    }
    const all = td.querySelector ? td.querySelector('.kh-table-all') : null;
    if (all && all.childNodes) {
      let buf = '';
      for (let i = 0; i < all.childNodes.length; i += 1) {
        const n = all.childNodes[i];
        const tag = String((n && (n.tagName || n.nodeName)) || '').toUpperCase();
        if (n && n.nodeType === 1 && tag === 'BR') { push(buf); buf = ''; continue; }
        buf += String((n && n.textContent) || '');
      }
      push(buf);
    }
    if (!out.length) push(Sources.labelText(td));
    return out;
  };

  Sources.fieldKeysOf = function (td) {
    const out = [];
    const labels = Sources.labelsOf(td);
    for (let i = 0; i < labels.length; i += 1) {
      const k = Sources.fieldKey(labels[i]);
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  };

  /** 取单元格里的值：剥掉 append 进去的证据行（从右端逆序），返回原文。 */
  Sources.cellValue = function (td) {
    if (!td) return '';
    let v = String(td.textContent || '').trim();
    const boxes = td.querySelectorAll ? td.querySelectorAll('.kh-evidence') : [];
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const t = String(boxes[i].textContent || '');
      if (t && v.slice(-t.length) === t) v = v.slice(0, -t.length).trim();
    }
    return v;
  };

  /** 这张卡里五个基础字段；合并行几个字段共用一个值。 */
  Sources.readFields = function (tableEl) {
    const out = { title: '', dev: '', entity: '', link: '', policy: '' };
    if (!tableEl || !tableEl.querySelectorAll) return out;
    const trs = tableEl.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i += 1) {
      const tr = trs[i];
      if (String(tr.className || '').indexOf('kh-merge-row') >= 0) continue;
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const keys = Sources.fieldKeysOf(tds[0]);
      if (!keys.length) continue;
      const val = tds.length > 1 ? Sources.cellValue(tds[1]) : '';
      for (let j = 0; j < keys.length; j += 1) if (!out[keys[j]]) out[keys[j]] = val;
    }
    return out;
  };

  /**
   * 按配置里的名字取任意一行：{found, value}。
   * found=true 且 value='' 表示「行在、值是空的」——调用方据此区分 ⚙ 待配置 与 ？ 未查明。
   * 合并行里任一名字命中即可取到共用值。
   */
  Sources.field = function (tableEl, label) {
    const want = keyOf(label);
    if (!tableEl || !tableEl.querySelectorAll || !want) return { found: false, value: '' };
    const trs = tableEl.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i += 1) {
      const tr = trs[i];
      if (String(tr.className || '').indexOf('kh-merge-row') >= 0) continue;
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const labels = Sources.labelsOf(tds[0]);
      let hit = false;
      for (let j = 0; j < labels.length; j += 1) if (keyOf(labels[j]) === want) { hit = true; break; }
      if (!hit) continue;
      return { found: true, value: tds.length > 1 ? Sources.cellValue(tds[1]) : '' };
    }
    return { found: false, value: '' };
  };

  Sources.looksLikeUrl = function (s) {
    return /^https?:\/\/\S+$/i.test(String(s == null ? '' : s).trim());
  };

  /** 这张卡从哪儿取「隐私政策链接」：抓取值本身是 URL，或另有链接字段。 */
  Sources.policySource = function (fields) {
    const f = fields || {};
    const p = String(f.policy || '').trim();
    if (Sources.looksLikeUrl(p)) return { url: p, from: 'policy' };
    const l = String(f.link || '').trim();
    if (Sources.looksLikeUrl(l)) return { url: l, from: 'link' };
    return null;
  };

  C.Sources = Sources;
})();