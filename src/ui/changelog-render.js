/* src/ui/changelog-render.js — 版本说明的**唯一**渲染入口（台账 2026-11-14 第 10 条）
 * ----------------------------------------------------------------------------
 * 背景：welcome 与 options 各写一套「版本块 + 条目」的构造，条目的 Markdown 口径已经
 * 统一成 `KH.Markdown.toDocFragment`，但 DOM 结构、未读判据仍各写各的 —— 改一处漏一处。
 *
 * 这里只做三件事，两页都从这里取：
 *   ① `itemEl`  条目文本 → `<li>`（单源 Markdown 渲染，取不到渲染器就纯文本）；
 *   ② `entryEl` / `renderInto` 版本块 → DOM（类名、锚点由调用方给，结构只有一种）；
 *   ③ `pickEntries` 未读/已读切分（唯一判据：当前版本与 lastSeen 之后算未读）。
 * 欢迎页的「本版说明已读，点开回看」用的就是这里的 `SUMMARY`，不许在页面里另写一句。
 */
(function () {
  'use strict';
  const KH = (window.KH = window.KH || {});

  /** 语义化版本比较（与 scripts/lib/version.js 同一口径；本文件不依赖脚本目录） */
  function cmpVersion(a, b) {
    const pa = String(a == null ? '' : a).replace(/^v/i, '').split('.');
    const pb = String(b == null ? '' : b).replace(/^v/i, '').split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /** 条目 → `<li>`：走 Markdown 单源（认行内代码、不产出链接/图片）；拿不到就如实显示原文 */
  function itemEl(text, doc) {
    const d = doc || document;
    const md = KH.Markdown;
    const li = d.createElement('li');
    let frag = null;
    if (md && typeof md.toDocFragment === 'function') {
      try { frag = md.toDocFragment(String(text), d); } catch (err) {
        console.warn('[KH] 更新日志条目渲染失败，退回纯文本 ——', err && err.message);
      }
    }
    if (frag) li.appendChild(frag); else li.textContent = String(text);
    return li;
  }

  /** 一个版本块：标题 + 条目列表。类名与锚点由调用方给，DOM 结构只在这里定义 */
  function entryEl(entry, opts) {
    const o = opts || {};
    const d = o.doc || document;
    const e = entry || {};
    const ver = String(e.version || '');
    const wrap = d.createElement('div');
    wrap.className = o.itemClass || 'kh-log-item';
    if (typeof o.anchorId === 'function') {
      const id = o.anchorId(ver);
      if (id) wrap.id = id;
    }
    const title = d.createElement('div');
    title.className = o.titleClass || 'kh-log-ver';
    title.textContent = ver;
    wrap.appendChild(title);
    const ul = d.createElement('ul');
    ul.className = o.listClass || 'kh-log-list';
    const items = Array.isArray(e.items) ? e.items : [String(e.items || '')];
    for (const it of items) ul.appendChild(itemEl(it, d));
    wrap.appendChild(ul);
    return wrap;
  }

  /** 把若干版本块画进容器（先清空） */
  function renderInto(box, entries, opts) {
    const o = opts || {};
    const d = o.doc || document;
    if (!box) return box;
    box.textContent = '';
    for (const e of entries || []) box.appendChild(entryEl(e, o));
    return box;
  }

  /** 未读/已读切分：欢迎页只画 `unread`，已读的连同样式一起不进版面 */
  function pickEntries(list, opts) {
    const o = opts || {};
    const version = String(o.version || '');
    const lastSeen = o.lastSeen || null;
    const cmp = typeof o.cmp === 'function' ? o.cmp : cmpVersion;
    const unread = [], read = [];
    for (const e of list || []) {
      const v = String((e && e.version) || '');
      const vsCurrent = cmp(v, version);
      if (vsCurrent > 0) continue;                       // 比当前版本新：旧版本残留数据，不上屏
      if (vsCurrent === 0) {
        if (lastSeen && cmp(lastSeen, version) >= 0) read.push(e); else unread.push(e);
        continue;
      }
      if (!lastSeen) continue;                           // 首装只看当前版本
      if (cmp(v, lastSeen) > 0) unread.push(e); else read.push(e);
    }
    return { unread, read };
  }

  /* 已全部读过时欢迎页唯一的那一行 —— 两页共用，别处不许另写一句（单测会核对） */
  const SUMMARY = '本版说明已读，点开回看';

  KH.ChangelogRender = {
    cmpVersion: cmpVersion,
    itemEl: itemEl,
    entryEl: entryEl,
    renderInto: renderInto,
    pickEntries: pickEntries,
    SUMMARY: SUMMARY
  };
})();