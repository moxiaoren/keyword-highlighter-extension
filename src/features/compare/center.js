/**
 * src/features/compare/center.js · 比对子系统 · 校验中心（T5）
 * ----------------------------------------------------------------------------
 * 设置页「校验中心」的唯一数据源：把当前真正在生效的三处配置汇总成几句话，
 * 并标出「默认」还是「你改过」。纯函数，不碰 DOM、不读存储（调用方把 cfg 传进来）。
 *   · 图怎么取      —— 抓取字段 + 识别引擎 + 每张上限 + 跨域放行站点
 *   · 谁和谁比      —— imgCompare.on / rows（另有内置的三条兜底规则）
 *   · 放行哪些平台  —— noteCheck.promiseOk（承诺对象）
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

  function pairItem(cfg) {
    const ic = (cfg && cfg.imgCompare) || {};
    const on = ic.on !== false;
    const rows = (ic.rows instanceof Array ? ic.rows : []).filter((r) => r && raw(r.left).trim() && raw(r.right).trim());
    if (!on) {
      return { key: 'pairs', title: '谁和谁比', changed: true,
        text: '已关闭：自动行的比对一律不判（企业名称 / 承诺对象 / 主体行也不判）',
        hint: '要恢复比对，打开「软著三方比对」里的总开关' };
    }
    if (!rows.length) {
      return { key: 'pairs', title: '谁和谁比', changed: false,
        text: '没配额外的对。内置仍在跑：企业名称 ↔ 开发者、著作权人 / 主办单位 ↔ 开发者、承诺对象 ↔ 放行名单',
        hint: '想比别的字段，在下面「软著三方比对」里加一组' };
    }
    const text = rows.map((r) => raw(r.left).trim() + ' ↔ ' + raw(r.right).trim()).join('；');
    return { key: 'pairs', title: '谁和谁比', changed: true, text: text,
      hint: '加的对优先于内置兜底；两边都可以是页面或图片' };
  }

  function allowItem(cfg) {
    let list = [];
    try {
      const src = (cfg && cfg.noteCheck != null) ? cfg.noteCheck : defaults().noteCheck;
      list = KH.Config && typeof KH.Config.normalizeNoteCheck === 'function'
        ? KH.Config.normalizeNoteCheck(src).promiseOk
        : ((src && src.promiseOk) || []);
    } catch (e) { list = []; }
    const def = (defaults().noteCheck && defaults().noteCheck.promiseOk) || ['vivo', '维沃', '天宸'];
    const changed = JSON.stringify(list) !== JSON.stringify(def);
    const text = list.length ? list.join('、') : '空：只放行「没点具体平台的泛称」，其余都要人工确认';
    return {
      key: 'allow', title: '放行哪些平台', changed: changed, text: text,
      hint: changed ? '这是你自己改过的名单（默认：' + def.join('、') + '）' : '当前就是默认名单'
    };
  }

  /** @returns {Array<{key,title,text,changed,hint,tag}>} 三项，顺序固定。 */
  function summary(cfg) {
    const mk = (it) => Object.assign({ hint: '' }, it, { tag: it.changed ? '已改' : '默认' });
    return [mk(ocrItem(cfg)), mk(pairItem(cfg)), mk(allowItem(cfg))];
  }

  C.Center = C.Center || {};
  C.Center.summary = summary;
})();
