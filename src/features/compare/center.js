/**
 * src/features/compare/center.js · 比对子系统 · 校验中心（T5）
 * ----------------------------------------------------------------------------
 * 设置页「校验中心」的唯一数据源：把当前真正在生效的三处配置汇总成几句话，
 * 并标出「默认」还是「你改过」。纯函数，不碰 DOM、不读存储（调用方把 cfg 传进来）。
 *   · 图怎么取      —— 抓取字段 + 识别引擎 + 每张上限 + 跨域放行站点
 *   · 谁和谁比      —— 各关键词「抓取后续字段」里标了「比对」的字段对（`#比=对象`）；
 *                      设置页那张全局比对表、内置三条与软著三方比对都已退场（2026-11-16）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const C = (KH.Compare = KH.Compare || {});

  function raw(v) { return v == null ? '' : String(v); }

  function defaults() {
    return (KH.Config && KH.Config.defaults) || {};
  }

  /** 所有关键词的抓取字段 → {empty, count, imageCount}；抓取字段是**每条关键词自己的**（不是全局配置键）。 */
  function fetchInfo(cfg) {
    const kws = (cfg && cfg.keywords instanceof Array) ? cfg.keywords : [];
    let count = 0;
    let imageCount = 0;
    for (let i = 0; i < kws.length; i += 1) {
      const text = raw(kws[i] && kws[i].fetchLabels).trim();
      if (!text) continue;
      const items = text.split(/[\n\r|｜]+/).map((s) => s.trim()).filter(Boolean);
      count += items.length;
      for (let j = 0; j < items.length; j += 1) if (/#图/.test(items[j])) imageCount += 1;
    }
    return { empty: count === 0, count: count, imageCount: imageCount };
  }

  function ocrItem(cfg) {
    const ic = (cfg && cfg.imgOcr) || {};
    const def = defaults().imgOcr || {};
    const engine = raw(ic.engine || def.engine || 'auto');
    const max = Number(ic.defaultMax != null ? ic.defaultMax : def.defaultMax);
    const sites = ic.crossOriginSites && typeof ic.crossOriginSites === 'object'
      ? Object.keys(ic.crossOriginSites).length : 0;
    const f = fetchInfo(cfg);
    let fetchText;
    if (f.empty) fetchText = '还没配抓取字段：图里的值不会进表';
    else if (f.imageCount) fetchText = '抓取字段 ' + f.count + ' 个，其中 ' + f.imageCount + ' 个「只要图片」';
    else fetchText = '抓取字段 ' + f.count + ' 个，但没勾「只要图片」：图里的值不会进表';
    const engineText = engine === 'auto' ? '识别引擎自动（主引擎，失败兜底）'
      : (engine === 'ppocr' ? '只用主引擎' : '只用兼容引擎');
    const maxText = '每张最多识别 ' + (isFinite(max) ? max : 4) + ' 张';
    const siteText = sites ? '，跨域放行 ' + sites + ' 个站点' : '';
    const changed = !f.empty || engine !== 'auto' || (isFinite(max) && max !== 4) || sites > 0;
    return {
      key: 'ocr', title: '图怎么取', changed: changed,
      text: fetchText + '；' + engineText + '；' + maxText + siteText,
      hint: '在关键词编辑弹窗 › 重要笔记 › 抓取后续字段里改'
    };
  }

  /** 各关键词里标了「比对」的字段对（只汇总，不给改：真源在每条关键词的抓取字段里）。 */
  function pairsInfo(cfg) {
    const F = KH.Fetch;
    const kws = (cfg && cfg.keywords instanceof Array) ? cfg.keywords : [];
    const out = [];
    const seen = new Set();
    if (!F || typeof F.parseLabels !== 'function') return out;
    for (let i = 0; i < kws.length; i += 1) {
      const text = raw(kws[i] && kws[i].fetchLabels).trim();
      if (!text) continue;
      let list = [];
      try { list = F.parseLabels(text) || []; } catch (e) { list = []; }
      for (let j = 0; j < list.length; j += 1) {
        const it = list[j] || {};
        if (!it.cmpOn) continue;
        const left = raw(it.label).trim();
        const right = raw(it.cmpTarget).trim();
        if (!left || !right || left === right) continue;
        const sig = [left, right].sort().join('\u0001');
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(left + ' ↔ ' + right);
      }
    }
    return out;
  }

  function pairItem(cfg) {
    const list = pairsInfo(cfg);
    if (!list.length) {
      return { key: 'pairs', title: '谁和谁比', changed: false,
        text: '没标：抓取字段之间不做判等（开发者 ↔ 核准主体名称 是单独一条链路，不受这里影响）',
        hint: '想比两个字段，在关键词编辑弹窗 › 抓取后续字段里勾「比对」并选对象' };
    }
    return { key: 'pairs', title: '谁和谁比', changed: true, text: '已标：' + list.join('；'),
      hint: '在关键词编辑弹窗 › 抓取后续字段里改；两边都可以是页面或图片' };
  }

  /** @returns {Array<{key,title,text,changed,hint,tag}>} 两项，顺序固定。 */
  function summary(cfg) {
    const mk = (it) => Object.assign({ hint: '' }, it, { tag: it.changed ? '已改' : '默认' });
    return [mk(ocrItem(cfg)), mk(pairItem(cfg))];
  }

  C.Center = C.Center || {};
  C.Center.summary = summary;
})();
