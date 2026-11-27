/* ============================================================================
 * src/features/fetch.js · 「抓取后续字段」唯一实现（提取 / 视觉行 / 合并块 / 多行表格）
 * ----------------------------------------------------------------------------
 * 为什么单独成一个文件：旧版把这一整块散在 keyword-engine.js 的 10 个私有方法里
 *   `_extractFetched`(705) `_extractFetchedFromTable`(721) `_extractFetchedFromFakeTable`(765)
 *   `_fakeRightValue`(806) `_isInteractive`(900) `_cellText`(964) `_collectRightBlock`(1002)
 *   `_rowsToTableMulti`(1066) `_cellVisualText`(1615) `_fetchNonEmptyPass`(1581) `_imgPlaceholder`(941)
 * 而 v2 重构时**把这一整块丢了**，只留下"取同行右邻单元格的 textContent"一句 —— 于是：
 *   · 多行备注（驳回原因/审核结果描述）换行被折叠、flex 并排被拆行   （附录A §8）
 *   · 标签格 rowspan 合并时，超出合并范围的右侧内容整块抓不到        （策划案 §7.3 坑 8）
 *   · 层级内容（基本信息/测试信息/资质信息 两级分组）退化成两列平铺
 *   · `#1` 简单模式、`|｜,，` 多分隔符、图片占位还原全部失效
 * 本文件把这些算法**原样收拢成单一声明**：所有抓取消费方（重要笔记面板）只调
 * `Fetch.blockFor(hit)` / `Fetch.triggerOk(cell)`，不再各写一套。
 *
 * 与旧版逐条对齐（不得回退）：
 *   ① 触发判据 ≠ 抓取内容：触发 = **直接右邻 td 有内容**（不跳过空格子）；
 *      抓取内容按 fetchLabels；目标为空 → 不显示、**不回退抓标题右格**。   （策划案 §7.5 坑 15）
 *   ② 视觉行提取：flex 同行（top 差 ≤8px）合并成一行、真实 block 换行保留；
 *      按钮/链接等交互控件文本剔除。                                     （附录A §8.2）
 *   ③ 合并块：标签格 rowspan 右侧一路向下抓，直到左侧列出现新标签为止。 （策划案 §7.3 坑 8）
 *   ④ 两级分组标题识别 + 多行表格渲染（保留 rowspan/colspan）。          （v1.6.44 / v1.7.4）
 *   ⑤ 图片：协议白名单（http/https），`data:` 占位图与非法协议丢弃，相对路径转绝对。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 抓取渲染的两级分组识别的固定标题词（旧版 FETCH_GROUP_TITLES，v1.6.42） */
  const GROUP_TITLES = ['基本信息', '测试信息', '资质信息', '运营备注'];

  /** 图片占位符包裹符（正文仍整体转义，图片单独还原为安全 <img>） */
  const IMG_OPEN = '\u0001KHIMG\u0001';
  const IMG_CLOSE = '\u0001ENDIMG\u0001';

  /* PDF 占位符（2.0.6.5 需求②）与图片占位符同一套机制：正文整体转义后，只把占位符还原成安全元素。
   * 为什么不能直接留 PDF 元素：`<embed>`/`<iframe>` 在面板里会真去加载阅读器（用户口径是
   * 「无需展示 pdf 源文件，只需要 pdf 占位」），而且 Chrome 的 PDF 插件内容读不到文字。 */
  const PDF_OPEN = '\u0001KHPDF\u0001';
  const PDF_CLOSE = '\u0001ENDPDF\u0001';

  /**
   * 这个元素指向的 PDF 地址（绝对化的 http(s)；不是 PDF 就回 ''）。
   * 认的是**页面自己声明的引用**：`<a href>`、`<iframe src>`、`<embed src>`、`<object data>`，
   * 以及【2.0.7.1 需求④】「点击才跳转」的控件 —— 真地址常藏在 `data-*` / `onclick` / `title`
   * / `aria-label` / `download` 里，主地址只是个 `/download/123` 或 `javascript:;`。
   * `.pdf` 出现在整串地址的任意位置（查询串里也算，如 `/view?file=a.pdf`），
   * 也认 `type="application/pdf"`。
   */
  const PDF_URL_RE = /\.pdf(?:[?#&]|$)/i;
  /* 「地址像下载/预览入口」：用来兜住 `href="/doc/view?id=3"` + 文字写 PDF 的控件 */
  const PDF_ENTRY_RE = /pdf|download|file|attach|view|preview|doc/i;
  /* 真地址可能藏在哪些属性里（`download` 只当"这是 PDF"的证据，不当地址：它多是文件名） */
  const PDF_URL_ATTRS = ['data-url', 'data-href', 'data-src', 'data-file', 'data-download', 'data-path', 'onclick'];

  /** 属性值 → 绝对化地址（过协议闸门；`onclick="open('/a/x.pdf')"` 这种从字符串里摘一个地址） */
  function absPdfUrl(raw) {
    let u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    /* `onclick="open('/a/x.pdf')"` / 提示串：先把引号里的 .pdf 地址摘出来 */
    const quoted = u.match(/['"]([^'"]+\.pdf[^'"]*)['"]/i);
    if (quoted) u = quoted[1];
    else if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:/i.test(u) && !/^\/\//i.test(u)) {
      return '';                       /* `javascript:void(0)` 之类不是地址 */
    }
    let abs = '';
    try { abs = new URL(u, location.href).href; } catch (err) { return ''; }
    if (!/^https?:/i.test(abs)) return '';
    return abs;
  }

  function pdfRefOf(el) {
    if (!el || !el.getAttribute) return '';
    const attr = (n) => String((el.getAttribute && el.getAttribute(n)) || '');
    const tag = String(el.tagName || '').toUpperCase();
    let primary = '';
    if (tag === 'A') primary = attr('href');
    else if (tag === 'OBJECT') primary = attr('data');
    else if (tag === 'IFRAME' || tag === 'EMBED') primary = attr('src');
    else return '';
    const type = (attr('type') + ' ' + attr('data-type')).toLowerCase();
    const declared = /application\/(?:x-)?pdf/.test(type);
    /* 1) 主地址自己就是 PDF（`#` 后是锚点/分页，不算地址的一部分） */
    const abs = absPdfUrl(primary);
    if (abs && (PDF_URL_RE.test(abs.split('#')[0]) || declared)) return abs;
    /* 2) 点击跳转控件：真地址在提示属性里（`href` 只是跳板页/脚本） */
    for (const name of PDF_URL_ATTRS) {
      const u = absPdfUrl(attr(name));
      if (u && PDF_URL_RE.test(u.split('#')[0])) return u;
    }
    /* 3) 控件自己说"这是 PDF"（标题/文字/下载名/类名），主地址就是那个 PDF 入口。
     * 只放「地址看起来就像下载/预览入口」的，别把普通页面上一个写着 PDF 的链接也吞进来。 */
    const label = [attr('title'), attr('aria-label'), attr('download'), attr('data-title'),
      attr('onclick'), String(el.textContent == null ? '' : el.textContent),
      String(el.className == null ? '' : el.className)].join(' ');
    if (abs && /\bpdf\b/i.test(label) && PDF_ENTRY_RE.test(abs)) return abs;
    return '';
  }

  /** `<a>/<iframe>/<embed>/<object>` → 可还原占位符（正文里留一条「PDF」痕迹，点击才去抽文字） */
  /* 【2026-11-18 用户口径】没有地址的 PDF 控件＝`<span class="content-pdf">PDF</span>` 这类：
   * 地址只有点开才知道。这里替用户点一次，由后台盯住新开的标签把 `.pdf` 地址抓回来；
   * 取到后与 `<a href>` 完全同一条链路（占位 → 后台抽字 → 命中/进表/比对）。
   * 只认 `.pdf` 地址、9 秒窗口、抓到即关标签；同一个元素只试一次。 */
  const AUTO_PDF_SEL = '.content-pdf, [class*="content-pdf"], [data-pdf]';
  const autoPdfCache = new WeakMap();
  const autoPdfByKey = (typeof Map === 'function') ? new Map() : null;
  const autoPdfTried = typeof WeakSet === 'function' ? new WeakSet() : null;
  const autoPdfClicking = typeof WeakSet === 'function' ? new WeakSet() : null;
  let autoPdfDirty = false;
  let autoPdfRefreshTimer = 0;
  let autoPdfClickBound = false;
  let autoPdfLastAt = 0;
  function autoPdfHostOf(el) {
    try { return (el && el.closest) ? el.closest(AUTO_PDF_SEL) : null; } catch (e) { return null; }
  }
  /* 一个控件 = 一张牌。`closest` 取的是**最近的**匹配节点，所以 `<span class="content-pdf">` 里
   * 套 `<i class="content-pdf-icon">` 时里外两层都算"控件"，各出一张同址占位（用户实测：
   * 一个 APP电子版权证书的 PDF 在面板里冒出 3 张牌）；外层 `<td class="…content-pdf…">`
   * 同理。这里只认**簇里最外层**那一个（自己没有祖先也匹配），其余节点交给它。 */
  function autoPdfRootOf(node) {
    let root = (autoPdfHostOf(node) === node) ? node : autoPdfHostOf(node);
    if (!root) return null;
    let p = root.parentElement || root.parentNode || null;
    for (let i = 0; p && i < 8; i++, p = p.parentElement || p.parentNode || null) {
      if (autoPdfHostOf(p) === p) root = p;
    }
    return root;
  }
  function autoPdfControlOf(node) {
    if (!node || node.nodeType !== 1 || !node.closest) return null;
    return (autoPdfHostOf(node) === node && autoPdfRootOf(node) === node) ? node : null;
  }
  /* 取**紧挨着控件的那一格**文字当行标签，而不是整行第一格。
   * 【2.0.15 · 用户 m11077】现场是「一个 PDF 控件挂在两个标题格（左）后面」：
   *   | 标题A | 标题B | PDF |
   * 旧实现取第一格（标题A）⇒ 地址被记到「标题A」名下；之后再按标签订阅回来的地址
   * 就可能落到同名但不同的字段上（用户看到的「配的是 B，抓回来却是别处的」）。
   * 紧邻的标题才是这个控件自己的名字；取不到再退回第一格（老页面兜底）。 */
  function autoPdfRowLabel(host) {
    try {
      const tr = (host && host.closest) ? host.closest('tr') : null;
      if (!tr || !tr.querySelector) return '';
      const cells = tr.children || [];
      let cell = host;
      while (cell && cell.parentNode !== tr) cell = cell.parentNode;
      const idx = cell ? Array.prototype.indexOf.call(cells, cell) : -1;
      for (let i = idx - 1; i >= 0; i--) {
        const c = cells[i];
        if (!c || (c.contains && c.contains(host))) continue;
        const t = String(c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 40);
      }
      const head = tr.querySelector('th, td');
      if (!head || head === host || (head.contains && head.contains(host))) return '';
      return String(head.innerText || head.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    } catch (e) { return ''; }
  }
  /** 页地址 + **行标签 + 行内下标**：页面重画/换顺序后地址还能找回来。
   *  【2.0.14 · 问题③】旧键是「控件在全页同类控件里的下标」——渲染顺序一变，两个字段的地址就互换，
   *  面板会把两个独立 PDF 显示成「A/B」合并形式。行标签是字段自己的名字，重画不会变。 */
  /* 控件签名（2.0.15 · PDF 错指）：只用来区分「看起来不是一个东西」的控件。
   * 标签 + 行内下标相同的两个控件，长得一模一样时仍然没法区分（那本来就是同一处）；
   * 但一个写「PDF」、一个写「查看」、类名也不同时，签名不同 ⇒ 绝不会互相领走对方的地址。
   * 【为什么必须加】旧键只有「页 + 行标签 + 行内下标」，后台里大量字段的行标签是同一段
   * 通用文字（甚至为空、退回整页下标），于是另一行抓到的地址被当成这一行的地址填进占位
   * （用户实测：一个 APP电子版权证书的地址铺满三个不同字段）。
   * 签名只取语义上稳定、且与地址无关的部分：标签名 + 类名 + 自身文字。别把 data-pdf/
   * title 里可能出现的 URL 算进来，否则地址一换签名就变、复用直接失效。 */
  function autoPdfSigOf(node) {
    if (!node || !node.getAttribute) return '';
    const cls = String(node.className == null ? '' : node.className).replace(/\s+/g, ' ').trim().slice(0, 60);
    const txt = String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim().slice(0, 24);
    return [String(node.tagName || '').toUpperCase(), cls, txt].join('|').slice(0, 120);
  }
  /* 同标签 + 同签名的控件在页面上可能有好几个（三个字段都用「PDF」样式的控件、行标签又是同一段
   * 通用文字）。签名只能证明「长得一样」，证明不了「是同一个」⇒ 再按文档序补一个序号。
   * 序号随文档序走：重画后顺序不变 ⇒ 还能复用；一旦前面增删了控件，序号会移——
   * 这时宁可重新点一次，也不许把别人的地址填进来（用户的「指向错误」代价远大于多点一次）。 */
  function autoPdfOrdOf(host, label, sig) {
    if (!label) return 0;
    try {
      const all = document.querySelectorAll(AUTO_PDF_SEL);
      let n = 0;
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el === host) break;
        if (autoPdfSigOf(el) === sig && autoPdfRowLabel(el) === label) n++;
      }
      return n;
    } catch (e) { return 0; }
  }
  function autoPdfKeyOf(host) {
    if (!host || typeof document === 'undefined' || !document.querySelectorAll) return '';
    const base = (typeof location !== 'undefined' && location.href) ? String(location.href).split('#')[0] : '';
    const label = autoPdfRowLabel(host);
    const sig = autoPdfSigOf(host);
    const ord = autoPdfOrdOf(host, label, sig);
    if (label) {
      let inRow = 0;
      try {
        const tr = host.closest('tr');
        const same = tr ? tr.querySelectorAll(AUTO_PDF_SEL) : [];
        for (let i = 0; i < same.length; i++) { if (same[i] === host) { inRow = i; break; } }
      } catch (e) { inRow = 0; }
      return base + '#r:' + label + ':' + inRow + ':' + sig + ':o' + ord;
    }
    let idx = -1;
    try {
      const all = document.querySelectorAll(AUTO_PDF_SEL);
      for (let i = 0; i < all.length; i++) { if (all[i] === host) { idx = i; break; } }
    } catch (e) { idx = -1; }
    if (idx < 0) return '';
    /* 取不到行：退回整页下标（老页面兜底）。下标会随重画漂移，所以同样带签名 ——
     * 漂到别的控件身上时签名对不上，宁可当作「还没抓到」再点一次，也不许张冠李戴。 */
    return base + '#' + idx + ':' + sig + ':o' + ord;
  }
  function autoPdfOf(el) {
    const host = autoPdfHostOf(el) || el;
    if (!host) return '';
    const hit = autoPdfCache.get(host);
    if (hit) return hit;
    if (!autoPdfByKey) return '';
    const key = autoPdfKeyOf(host);
    const rec = key ? autoPdfByKey.get(key) : null;
    /* 记录是 `{url, sig}`：签名对不上就不认这条记录（那是另一行/另一个控件抓到的），
     * 绝不把别处的地址当成本控件的地址 —— 用户 m12161 的「指向错误」就是这么来的。 */
    const url = rec && rec.url && (!rec.sig || rec.sig === autoPdfSigOf(host)) ? rec.url : '';
    if (url) autoPdfCache.set(host, url);
    return url || '';
  }
  /* 抓到地址 → 必须重算一轮：面板里的抓取结果是渲染时的一次性快照（important-note 的
   * collectEffective），PDF 条目也只在 img-ocr 的 build 里建（consumeOnly 会整体早退）。
   * 防递归：抓取本来就发生在 build 内部，所以延后一拍、同一批只重算一次。 */
  function scheduleAutoPdfRefresh() {
    if (autoPdfRefreshTimer) return;
    /* 一页里可能有好几个这种控件：把重算节流到 1.5s 一次，别让整页连续重建 */
    const wait = Math.max(120, 1500 - (Date.now() - autoPdfLastAt));
    autoPdfRefreshTimer = setTimeout(() => {
      autoPdfRefreshTimer = 0;
      if (!autoPdfDirty) return;
      autoPdfLastAt = Date.now();
      autoPdfDirty = false;
      try { const p = KH.ImportantNote && KH.ImportantNote.panel; if (p && p.host && p.refresh) p.refresh(); } catch (e) {}
      try { if (KH.rebuild) KH.rebuild({ source: 'auto-pdf' }); } catch (e) {}
    }, wait);
  }
  /* 【2.0.15 · PDF 错指】这里**不拦同址**：两个字段拿到同一份 PDF 是合法形态
   * （一行标题格里挂着一个 PDF、两个标签共用它），面板按"内容一致"合并成一列也是预期行为
   * （用户口径 m11077：「如果确实一样，合并是合理且符合预期的」）。
   * 要修的是"配的是 A、抓回来的却是 B 的地址"——那属于认领错了标签，
   * 由后台的按标签认领 + 每页同时只允许一个抓取窗口来保证，不在这里做地址去重。 */
  function rememberAutoPdf(el, url) {
    const host = autoPdfHostOf(el) || el;
    if (!host || !url) return;
    const val = String(url);
    const mark = (node) => {
      if (!node) return;
      autoPdfCache.set(node, val);
      if (autoPdfByKey) {
        const key = autoPdfKeyOf(node);
        if (key) autoPdfByKey.set(key, { url: val, sig: autoPdfSigOf(node) });
      }
    };
    mark(host);
    /* 控件簇最外层也要记一份：取值时只认最外层（见 autoPdfControlOf），否则「外层类名也含
     * content-pdf」的页面里地址记在了里层、取值却问外层 ⇒ 拿不到地址，占位与文字都错。 */
    const root = autoPdfRootOf(host);
    if (root && root !== host) mark(root);
    autoPdfDirty = true;
    scheduleAutoPdfRefresh();
  }
  /** 开一次抓取窗口：doClick=true 替用户点控件；false 只等用户自己点（不模拟点击）。
   *  两条回执都认：①主世界钩子截到地址 → `kh:pdf:grabbed` 事件，**根本不产生新标签**，前台不被打断；
   *  ②钩子没装上 → 后台盯新标签，再用 `MSG.PDF_GRAB_RESULT` 兜回来。 */
  function openGrabWindow(host, doClick, onDone) {
    const MSG = KH.MSG || {};
    const rt = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
    if (!rt || !rt.sendMessage || !MSG.PDF_GRAB) { if (onDone) onDone(''); return; }
    const requestId = 'khp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let finished = false;
    /* 【2.0.14.5 · 用户 m13119】串行队列要能知道「这一份结束了（抓到/没抓到都一样）」，
     * 否则一次超时就把后面所有 PDF 卡死。`settled` 保证回调只走一次。 */
    let took = '';
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { if (onDone) onDone(took); } catch (e) {}
    };
    const cleanup = (markDone) => {
      if (markDone) finished = true;
      try { rt.onMessage.removeListener(onMsg); } catch (e) {}
      try {
        if (typeof document !== 'undefined' && document.removeEventListener) {
          document.removeEventListener('kh:pdf:grabbed', onGrab, true);
        }
      } catch (e) {}
      if (autoPdfClicking) autoPdfClicking.delete(host);
    };
    function take(url) {
      if (finished || !url) return;
      /* 页面把相对地址（assets/x.pdf）交给 window.open 是常态：取到的原始参数必须先绝对化。 */
      const u = absPdfUrl(url);
      if (!u) return;
      cleanup(true);
      took = u;
      rememberAutoPdf(host, u);
      settle();
    }
    function onMsg(m) {
      if (!m || m.type !== MSG.PDF_GRAB_RESULT || m.requestId !== requestId) return;
      take(m.url);
    }
    function onGrab(ev) {
      let d = ev && ev.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
      if (!d || d.requestId !== requestId) return;
      take(d.url);
      /* 钩子已经截到地址：叫后台立刻撤钩子，别干等 9 秒超时 */
      try { rt.sendMessage({ type: MSG.PDF_GRAB_DONE, requestId: requestId, url: d.url }, () => { void rt.lastError; }); } catch (e) {}
    }
    try {
      rt.onMessage.addListener(onMsg);
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('kh:pdf:grabbed', onGrab, true);
      /* click=真：这次是插件替用户点控件（钩子可以拦，不产生新标签）。
       * click=假：用户自己点的，**不许影响页面自身行为** —— 钩子只旁听地址，标签照常打开、也不关。 */
      /* key 是控件令牌（autoPdfTokenKey）：同标签页跳转会把页面带走，地址得靠它跨过重载认领回来 */
      rt.sendMessage({ type: MSG.PDF_GRAB, requestId: requestId, click: !!doClick, key: autoPdfTokenKey(host) }, (res) => {
        if (rt.lastError) { cleanup(true); settle(); return; }
        /* 后台把钩子装好才回话：armed=true 就去点（点下去不会被开成新标签）；
         * armed=false 说明钩子装不上，仍点一次，靠后台把新标签压到后台再关掉。 */
        if (doClick) setTimeout(() => {
          try {
            if (finished) return;
            /* 【2.0.14.6 · 用户 m13895】主世界钩子靠这个标记认出「这次点击是插件发起的」。
             * 标记内的锚点不论有没有 .pdf 后缀，钩子都截下 href 并拦掉跳转 —— 服务端返回 PDF 的
             * `/download?id=1` 这类地址旧实现认不出来，只能真开一个标签再由后台关掉（页签栏就闪了）。 */
            try { host.setAttribute('data-kh-pdf-arm', String(requestId)); } catch (e) {}
            host.click();
          } catch (e) {}
          /* 只活到这次点击派发完：200ms 后摘掉，别让页面后续点击被误拦。 */
          setTimeout(() => { try { host.removeAttribute('data-kh-pdf-arm'); } catch (e) {} }, 200);
        }, res && res.armed ? 20 : 60);
      });
      /* 替用户点的那次只用等一个抓取窗口：钩子命中是即时的，钩子没装上时后台也会在
       * 开标签后一两秒内认出 PDF。等太久会让串行队列在坏页面上一步一步拖满 9 秒。 */
      setTimeout(() => { if (!finished) { cleanup(true); settle(); } }, doClick ? 6500 : 12000);
    } catch (e) { cleanup(true); settle(); }
  }
  /* 脚本 click 可能被页面当成不可信事件丢掉（isTrusted=false）→ 用户真点时也开一个抓取窗口，
   * 这次不再模拟点击，只盯他点开的新标签：抓得到就记住地址，抓完由后台把标签关掉。 */
  function bindAutoPdfUserClick() {
    if (autoPdfClickBound || typeof document === 'undefined' || !document.addEventListener) return;
    autoPdfClickBound = true;
    document.addEventListener('click', (ev) => {
      const t = ev && ev.target;
      if (!t || !t.closest) return;
      let host = null;
      try { host = t.closest(AUTO_PDF_SEL); } catch (e) { host = null; }
      if (!host || autoPdfOf(host)) return;
      if (autoPdfClicking && autoPdfClicking.has(host)) return;
      if (autoPdfClicking) autoPdfClicking.add(host);
      openGrabWindow(host, false);
    }, true);
  }
  const autoPdfTriedByKey = (typeof Map === 'function') ? new Map() : null;
  /* 一页最多点 24 次：一个值格挂三份 PDF 也要够用（旧值 8 在「证书 3 份 + 授权书 1 份 + 别的行」时就截断）。 */
  const AUTO_PDF_MAX_GRABS = 24;
  let autoPdfGrabCount = 0;
  /* 【2.0.14.5 · 用户 m13119】抓 PDF 必须**一份一份来**：
   * 旧实现每次取文都直接开抓取窗口，一个值格里三份 PDF 就是三次点击同时发生 —— 页面瞬间开三个
   * 标签，而后台同一页只留一个抓取会话（`PDF_GRAB_BY_TAB`），后来的把先来的顶掉，先前那份 PDF
   * 的地址就记到了别人头上（用户看到的「没对齐标题单元格」）。
   * 现在只入队：点一份 → 等地址回来（抓到或超时）→ 记下 → 再点下一份，直到这一格没有控件。
   * 好处还不止是「不乱跳」：地址一回来就 `rememberAutoPdf` → 面板重画，占位是**一张一张补上**的。 */
  const autoPdfQueue = [];
  const autoPdfQueued = (typeof WeakSet === 'function') ? new WeakSet() : null;
  let autoPdfRunning = false;
  /* 【2.0.14.7 · 用户 m13895 B 档】同标签页跳转（location.href / 表单提交）抓到的地址存在后台，
   * 页面被拨回来后内容脚本是重新注入的 —— 这里按控件令牌把地址认领回来，
   * 否则这一格会一直显示「正在抓取」，然后重新点一次、再跳一次。 */
  function applyPdfStash() {
    const MSG = KH.MSG || {};
    const rt = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
    if (!rt || !rt.sendMessage || !MSG.PDF_STASH_QUERY || typeof document === 'undefined') return;
    const pageUrl = String(location.href || '').split('#')[0];
    try {
      rt.sendMessage({ type: MSG.PDF_STASH_QUERY, pageUrl: pageUrl }, (res) => {
        if (rt.lastError || !res || !res.items || !res.items.length) return;
        const want = {};
        for (const it of res.items) if (it && it.key && it.url) want[it.key] = it.url;
        let got = 0;
        for (const el of document.querySelectorAll(AUTO_PDF_SEL)) {
          const ctl = autoPdfControlOf(el);
          if (!ctl || autoPdfOf(ctl)) continue;
          const u = want[autoPdfTokenKey(ctl)];
          if (!u) continue;
          rememberAutoPdf(ctl, u);
          got++;
        }
        if (got) scheduleAutoPdfRefresh();
      });
    } catch (e) {}
  }
  function kickAutoPdf(el) {
    const host = autoPdfHostOf(el);
    if (!host || autoPdfOf(host) || (autoPdfTried && autoPdfTried.has(host))) return;
    if (autoPdfQueued && autoPdfQueued.has(host)) return;
    if (autoPdfClicking && autoPdfClicking.has(host)) return;
    /* 【用户实测 m05720】页面每重画一次控件就换新节点，WeakSet 记不住它 ⇒ 反复开抓取窗口，
     * 主世界钩子一轮接一轮挂上去，页面自己的 window.open 与点击就全被吞了。
     * 再按「页地址 + 控件签名 + 序号」记一份（m12161：同标签不同控件不能互相顶），
     * 并给一页最多 24 次的上限。 */
    const key = autoPdfKeyOf(host);
    if (key && autoPdfTriedByKey && autoPdfTriedByKey.has(key)) return;
    if (autoPdfGrabCount >= AUTO_PDF_MAX_GRABS) return;
    if (autoPdfQueued) autoPdfQueued.add(host);
    autoPdfQueue.push({ host: host, key: key });
    autoPdfQueuePump();
  }
  /** 队列泵：同一时刻只有一个抓取窗口在跑；结束后隔一拍再点下一份（连点太快页面会合并事件）。 */
  function autoPdfQueuePump() {
    if (autoPdfRunning) return;
    const job = autoPdfQueue.shift();
    if (!job) return;
    autoPdfRunning = true;
    autoPdfGrabCount++;
    bindAutoPdfUserClick();
    let settled = false;
    const done = (url) => {
      if (settled) return;
      settled = true;
      autoPdfRunning = false;
      if (autoPdfQueued) autoPdfQueued.delete(job.host);
      if (autoPdfTried) autoPdfTried.add(job.host);
      /* 没抓到才记「试过」：抓到了由 `autoPdfOf(host)` 挡第二次，不需要再吃一条重试配额。 */
      if (!url && job.key && autoPdfTriedByKey) autoPdfTriedByKey.set(job.key, Date.now());
      setTimeout(autoPdfQueuePump, url ? 120 : 60);
    };
    openGrabWindow(job.host, true, done);
  }
  /** 【2.0.14.6 · 用户 m13311】「先一次性填入占用，再按顺序认领地址」用的临时地址键：
   * 取控件键（页地址 + 行标签 + 同签名序号）的哈希，**同一个控件永远同一个临时牌**，
   * 不同字段的控件各算各的 —— 否则表格按「内容一致」合并时，两张不同字段的等待牌会被并成一列。 */
  function autoPdfTokenKey(host) {
    const k = String(autoPdfKeyOf(host) || '');
    let h = 2166136261;
    for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return (h >>> 0).toString(36);
  }
  function pdfPlaceholder(el) {
    const src = pdfRefOf(el) || autoPdfOf(el);
    const enc = (s) => encodeURIComponent(s == null ? '' : String(s)).replace(/'/g, '%27');
    const name = String((el.getAttribute && (el.getAttribute('title') || el.getAttribute('download'))) || '');
    if (src) return PDF_OPEN + enc(name) + '|' + enc(src) + PDF_CLOSE;
    /* 【2.0.14.6 · m13311】地址还没抓到：只要是自动抓取控件，就先占一个位（`#pend:<hash>`），
     * 牌子上写「抓取中」；地址一回来，`rememberAutoPdf` 触发面板重画，这张牌换成真地址。
     * 普通 `<a>` / iframe 不在此列（它们的地址由 `pdfRefOf` 给，没有就是没有）。 */
    const ctl = autoPdfControlOf(el);
    if (!ctl) { kickAutoPdf(el); return ''; }
    kickAutoPdf(ctl);
    return PDF_OPEN + enc(name || 'PDF') + '|' + enc('#pend:' + autoPdfTokenKey(ctl)) + PDF_CLOSE;
  }

  /** 交互控件标签：命中即剔出正文（「编辑」「查看更多」「收起」等动态控件不抓） */
  const SKIP_TAGS = {
    BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, FORM: 1,
    IFRAME: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IMG: 1, OBJECT: 1, EMBED: 1, HR: 1
  };
  const INTERACTIVE_ROLES = [
    'button', 'link', 'menuitem', 'menu', 'checkbox', 'radio', 'switch',
    'tab', 'combobox', 'slider', 'dialog', 'toolbar', 'navigation'
  ];

  /**
   * **弱控件信号**：中文后台"操作列"的类名（`opt-col` / `operate` / `caozuo` / `handle` / `cell-ops` …）
   * 与 `style="cursor:pointer"`。
   *
   * 为什么不单独判：这些词太泛，`edit-area` / `opt-desc` 这类**包着真内容的外层容器**也会命中。
   * 所以弱信号还必须**该元素的整段文字由"操作词"拼成**（见 `ACTION_LABELS`）——
   * 操作列的文案无非「编辑 / 删除 / 查看更多」及其组合，
   * 而 `<div class="edit-area">南京市</div>` 的文字是正文，不会被误删。
   * 本项目的既定取向是「宁可多抓、不可丢内容」：认不出的操作词只会**漏判**（多显示一条），
   * 不会把真内容删掉。
   */
  const WEAK_ACTION_CLS = /\b(ops?|opts?|operate|operation|edit|del|delete|remove|modify|handle|caozuo|tool|tools|toolbar|action|actions|link|more|btn|button)\b/i;

  /**
   * 操作词表（**只收"操作"语义、不收可能当值的词**）。
   * 故意**不含**「通过 / 驳回 / 启用 / 停用 / 审核 / 关闭 / 提交 / 保存 / 确定 / 取消」——
   * 这些在审核后台里太常作为**字段值**出现（状态列、审核结果列），
   * 万一被误判成控件就会整条内容丢失。它们若真是按钮，基本都是真 `<button>`（已由标签判据兜住）。
   */
  const ACTION_WORD = '(?:编辑|修改|删除|移除|新增|添加|新建|查看|详情|更多|操作|设置|配置|重置|展开|收起|下载|上传|导入|导出|复制|同步|刷新|处理|指派|分配|撤回|撤销|去处理|查看明细)';
  /** 整段文字 = 若干操作词的拼接（`编辑`、`编辑删除`、`查看更多`、`批量删除`… 中间空白忽略） */
  const ACTION_LABELS = new RegExp('^(?:' + ACTION_WORD + ')+$');
  /** 弱信号允许的最长文字（操作标签都很短；超过一律按内容保留） */
  const WEAK_TEXT_MAX = 16;

  /** 弱信号本身（不含"整段是操作词"守卫） */
  function weakControlSignal(node) {
    const cls = node.className ? String(node.className) : '';
    if (cls && WEAK_ACTION_CLS.test(cls)) return true;
    const style = String((node.getAttribute && node.getAttribute('style')) || '');
    return /cursor\s*:\s*pointer/i.test(style);
  }

  /** 弱信号 + "整段文字都是操作词"守卫（见 `WEAK_ACTION_CLS` 注释） */
  function weakControlElement(node) {
    if (!node.getAttribute) return false;
    if (!weakControlSignal(node)) return false;
    const t = String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, '');
    if (!t || t.length > WEAK_TEXT_MAX) return false;
    return ACTION_LABELS.test(t);
  }

  /**
   * 操作型链接：`href="javascript:..."`（含 `javascript:void(0)`）永远是"点了执行动作"，
   * 不可能是真跳转，因此判为控件。
   * **`href="#"` 故意不算** —— SPA 里用 `#` 占位的正文链接很常见（`<a href="#">应用名</a>`），
   * 把它当控件会把真内容整条丢掉；宁可漏判这一个形态。
   */
  function actionHref(node) {
    const href = String((node.getAttribute && node.getAttribute('href')) || '').trim();
    return /^javascript:/i.test(href);
  }

  /**
   * 是否属于交互控件（旧版 `_isInteractive`，v1.7.9 / v1.13.0 结论 + v2.1.0 加固）。
   * 注意：**纯文字 `<a>` 放行**（组合词核心命中内容常是 `<td><a>南京公司</a></td>`），
   * 只有带显式交互特征（onclick / role=button / 控件 class / 查看更多类中文 / `javascript:` 伪协议）才跳过。
   *
   * 【只服务抓取】本函数只被 `cellText` / `cellVisualText` / `triggerOk` 使用（都在 features/fetch.js 内）；
   * 组合词读的是原生 `textContent`，不受这里影响 —— 所以放宽控件识别**不会**动到高亮/组合词。
   */
  function isInteractive(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'BR') return false;
    if (SKIP_TAGS[tag]) return true;
    if (!node.getAttribute) return false;

    const cls = node.className ? String(node.className) : '';
    /** 类名 / 内联 cursor 的判据（`<a>` 与非 `<a>` 共用，避免两边规则漂移） */
    const clsHit = () => {
      if (cls && /\b(btn|button|link|more|toggle|expand|collapse|operation|action)\b/i.test(cls)) return true;
      if (cls && /查看更多|收起|展开|更多|操作/.test(cls)) return true;
      return weakControlElement(node);
    };

    if (tag === 'A') {
      if (node.getAttribute('onclick') || node.getAttribute('onmousedown') || node.getAttribute('onpointerdown')) return true;
      // ⚠️ role 白名单里**不能**有 `link` —— 每个 `<a>` 都是 link，会把正文链接一并误杀
      const aRole = String(node.getAttribute('role') || '').toLowerCase();
      if (aRole === 'button' || aRole === 'menuitem' || aRole === 'checkbox' || aRole === 'switch' || aRole === 'tab') return true;
      if (actionHref(node)) return true;
      return clsHit();
    }

    const role = String(node.getAttribute('role') || '').toLowerCase();
    if (role && INTERACTIVE_ROLES.indexOf(role) >= 0) return true;
    if (node.getAttribute('onclick') || node.getAttribute('onmousedown') || node.getAttribute('onpointerdown')) return true;
    if (node.getAttribute('contenteditable') != null) return true;
    return clsHit();
  }

  /** 沿父链向上查是否有交互祖先（直到 cell / 边界），有则整段文本剔除 */
  function underInteractive(node, stopAt) {
    let p = node && node.parentElement;
    while (p && p !== stopAt) {
      if (isInteractive(p)) return true;
      p = p.parentElement;
    }
    return false;
  }

  /* ---------------------------------------------------------------- 图片 */

  /**
   * 该图片是不是"网页自己的看图器/浮层"里的临时大图。
   *
   * 【用户实测】原网页的"看大图"实现方式就是在单元格里**再加一个 div 容器**放大图；
   * 我们把它当成字段内容抓了下来 → 面板里凭空多出一张大图（用户："没必要"）。
   * 判据（保守，宁少勿多）：向上最多 6 层找一个 `position: fixed|absolute` 且**覆盖视口 60% 以上**的祖先。
   *
   * **只跳过图片**：容器里的文字照旧参与扫描/命中（用户明确要求"原网页新容器文本命中还是要的"），
   * 所以拦截点放在 `imgPlaceholder` 里（图片的唯一入口），不动文本那条路径。
   */
  function underOverlay(el) {
    try {
      if (typeof getComputedStyle !== 'function' || typeof window === 'undefined') return false;
      if (overlayCache.has(el)) return overlayCache.get(el);      // 每个元素只算一次（全页文本节点都要问它）
      let hit = false;
      let n = el && el.parentElement;
      for (let d = 0; n && d < 6; d++, n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.position !== 'fixed' && st.position !== 'absolute') continue;
        const r = n.getBoundingClientRect();
        if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6) { hit = true; break; }
      }
      overlayCache.set(el, hit);
      return hit;
    } catch (err) { /* 取不到样式 → 当普通内容 */ }
    return false;
  }
  /** 浮层判定缓存（WeakMap：不阻止 GC；每轮重建新建，不存在跨轮陈旧） */
  const overlayCache = new WeakMap();

  /**
   * `<img>` → 可还原占位符（旧版 `_imgPlaceholder`，v1.50.x）。
   * 协议白名单与 sanitize 一致：仅 http(s)（含 `//` 相对协议、相对路径转绝对）；
   * `data:image/` 视为占位图丢弃；`javascript:` 等非法协议丢弃。
   * v1.99.99.13 起：**页面的看图器浮层里的图不抓**（见 `underOverlay`，用户实测要求）。
   */
  function imgPlaceholder(img) {
    if (!img) return null;
    if (underOverlay(img)) return null;                 // 网页自己的大图浮层：不是字段内容
    let src = (img.getAttribute && img.getAttribute('src')) || '';
    if (!src) return null;
    if (/^data:image\//i.test(src)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^https?:/i.test(src) && !/^\/\//i.test(src)) return null;
    try { src = new URL(src, location.href).href; } catch (err) { /* 保留原样 */ }
    if (!/^https?:\/\//i.test(src)) return null;
    const alt = (img.getAttribute && img.getAttribute('alt')) || '';
    const enc = (s) => encodeURIComponent(s == null ? '' : String(s)).replace(/'/g, '%27');
    return IMG_OPEN + enc(alt) + '|' + enc(src) + IMG_CLOSE;
  }

  /**
   * 占位符 → 安全 `<img>` / PDF 占位（在 esc 之后调用：正文保持转义、只还原安全元素）。
   * PDF 那条（2.0.6.5 需求②）只还原成**占位标记**，真去抽文字由 `KH.PdfOcr` 按需触发 ——
   * 面板渲染时不该为一张表格里的十个 PDF 发十个请求。
   */
  function restoreImgs(html) {
    const escA = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const out = String(html).replace(
      new RegExp('\u0001KHIMG\u0001([^|]*)\\|([^\u0001]*)\u0001ENDIMG\u0001', 'g'),
      (_, a, u) => {
        let alt = '', src = '';
        try { alt = decodeURIComponent(a); src = decodeURIComponent(u); } catch (err) { return ''; }
        if (!/^https?:\/\//i.test(src)) return '';
        return '<img src="' + escA(src) + '" alt="' + escA(alt) + '" loading="lazy">';
      }
    );
    return out.replace(
      new RegExp('\u0001KHPDF\u0001([^|]*)\\|([^\u0001]*)\u0001ENDPDF\u0001', 'g'),
      (_, n, u) => {
        let name = '', src = '';
        try { name = decodeURIComponent(n); src = decodeURIComponent(u); } catch (err) { return ''; }
        /* 【2.0.14.6 · m13311】先占位：地址还没抓到的那些也立刻出牌（灰边 + 「抓取中」），
         * 地址回来后面板重画就换成 `data-khpdf=<真地址>`，三态框由 `KH.ImportantNote` 挂。 */
        if (/^#pend:/.test(src)) {
          return '<span class="khin-pdf khin-pdf-pending" data-khpdf="" data-khpdf-pend="' + escA(src.slice(6)) + '" title="正在抓取 PDF 地址…">PDF</span>';
        }
        if (!/^https?:\/\//i.test(src)) return '';
        /* `data-khpdf` 是 PDF 条目与占位标记之间的**唯一约定**（`KH.PdfOcr` 按它挂三态与点击） */
        return '<span class="khin-pdf" data-khpdf="' + escA(src) + '" title="' + escA(name || src) + '">PDF</span>';
      }
    );
  }

  /* ---------------------------------------------------------- 单元格文本 */

  const BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, TR: 1, UL: 1, OL: 1, SECTION: 1,
    HEADER: 1, FOOTER: 1, BR: 1, TABLE: 1
  };

  /**
   * 单元格正文提取（旧版 `_cellText`，v1.7.9）。
   *   mergeLines=true  → 简单模式：换行/连续空白压成单空格，同行多子元素合并（「工具 张三 日期」）
   *   mergeLines=false → 整块模式：**保留换行**作多行分隔，仅剔除控件、压缩行内空白、清空行
   * 这是"多行驳回原因不折叠"的底层保证（附录A §8.4）。
   */
  /**
   * 该节点是否位于 `root` **内部嵌套的** `<table>` 里（K79）。
   * 用途：读**某一层**的值时跳过它里面嵌的表格 —— 内表算**独立的一层**，
   * 它的文字不该混进外层的值里（用户 2026-09-23 拍板"排掉"）。
   */
  function insideNestedTable(node, root) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    for (let d = 0; el && el !== root && d < 64; d++, el = el.parentElement) {
      if (el.nodeType === 1 && el.tagName === 'TABLE') return true;
    }
    return false;
  }

  function cellText(el, mergeLines, opts) {
    if (!el) return '';
    const skipNested = !!(opts && opts.skipNestedTables);
    const segs = [];
    /* 同一次取值里，同一个 PDF 只留一条占位（控件常有多层节点同时命中） */
    const pdfSeen = {};
    const walk = (node) => {
      if (node.nodeType === 3) {
        /* 浮层里的文字不算字段内容（`underOverlay` 从**父元素**往上找，所以这里传文本节点是对的） */
        if (!underOverlay(node)) segs.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'BR') { segs.push('\n'); return; }
      if (tag === 'IMG') { const ph = imgPlaceholder(node); if (ph) segs.push(ph); return; }
      /* PDF 引用（2.0.6.5 需求②）：与图片共用占位符机制。
       * `<a>` 的文字往往就是真内容（「下载说明书」）⇒ 占位符塞进去后**继续**遍历它的文字；
       * `<iframe>/<embed>/<object>` 本身没有文字 ⇒ 塞完就返回（它们内部也不该抓）。 */
      if (tag === 'A' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
        const pdf = pdfPlaceholder(node);
        if (pdf) {
          segs.push(pdf);
          if (tag !== 'A') return;
        }
      }
      /* 【2026-11-18 用户口径】没有地址的 PDF 控件（`<span class="content-pdf">PDF</span>`）：
       * 地址靠点一次取（见 autoPdfOf / kickAutoPdf）。取到了就当引用处理（正文只留占位）；
       * 还没取到就照旧读它那几个字，下一轮重建会补上。 */
      /* 【2.0.15 · 一个 PDF 冒出 3 张牌】只让控件簇最外层那一个出占位，并在一次取值内按地址
       * 去重；别的字段的控件各有各的地址，不会被这次去重吃掉（用户口径：抓取字段与占位一一对应）。 */
      const ctl = autoPdfControlOf(node);
      if (ctl) {
        const src = autoPdfOf(ctl);
        if (!src) {
          /* 【2.0.14.6 · m13311】没地址也先占位：按「控件」去重（临时牌各是各的），
           * 不能按空的 src 去重 —— 那样一格三份 PDF 只会剩一张牌。 */
          kickAutoPdf(ctl);
          const kk = 'p:' + autoPdfTokenKey(ctl);
          if (pdfSeen[kk]) return;
          pdfSeen[kk] = 1;
          const pending = pdfPlaceholder(ctl);
          if (pending) { segs.push(pending); return; }
        } else if (pdfSeen[src]) return;
        else {
          pdfSeen[src] = 1;
          const autoPdf = pdfPlaceholder(ctl);
          if (autoPdf) { segs.push(autoPdf); return; }
        }
      } else if (autoPdfOf(node)) {
        const autoPdf = pdfPlaceholder(node);
        if (autoPdf) { segs.push(autoPdf); return; }
      }
      if (isInteractive(node)) return;
      /* K79：读这一层的值时**跳过它内部嵌的表格**（内表算独立的一层，见 `insideNestedTable`） */
      if (skipNested && tag === 'TABLE' && node !== el) return;
      /* 网页自己看图器浮层里的内容**整块不算字段内容**（用户实测：点开大图后残留 `1/5` 这种计数文字）。
       * 注意：**只影响抓取** —— 扫描/命中那条路径完全不经过这里，浮层里的文字该命中还是命中。 */
      if (underOverlay(node)) return;
      const isBlock = !!BLOCK_TAGS[tag] || /^H[1-6]$/.test(tag);
      if (isBlock && segs.length) segs.push('\n');
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    };
    walk(el);
    const s = segs.join('').replace(/\u00a0/g, ' ');
    if (mergeLines) return s.replace(/[ \t\u3000\r\n]+/g, ' ').trim();
    return s
      .replace(/\u3000/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r?\n+/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/^[\n ]+/, '')
      .replace(/[\n ]+$/, '')
      .trim();
  }

  /**
   * 布局感知提取（旧版 `_cellVisualText`，v1.8.9）—— **视觉行**而非块级切行。
   * 网页常用 flex 把多个 div/span 排在同一行：此时各段 `getBoundingClientRect().top`
   * 接近（≤8px）→ 合为一行；真正换行（不同 top）才分行。
   * 附录A §8.2 明确要求"既要合对 flex 同行、又要保真实换行"，两个方向都要对。
   * 图片按位置并入所在行（纯图单元格也能拿到图片）。
   *
   * 【v1.99.99.10 两处修正（都是用户实测：一格多图被渲染成一列多行）】
   *   ① **按文档顺序**处理文本与图片。旧实现先扫完全部文本节点、再单独扫全部图片，
   *      于是"图在文前 / 图文交替"的单元格里图片被整体挪到末尾 —— 与网页观感不符。
   *      现在一次 TreeWalker（SHOW_TEXT | SHOW_ELEMENT）按文档序处理，顺序即原样。
   *   ② 图片之间按**垂直重叠**判是否同一行（旧实现只比 top 差 ≤8px）。
   *      真实站点的一行缩略图是 `display:inline-block` + `vertical-align:middle`，
   *      高矮不一时 top 差会超过 8px（实测 4 张图 top=139/130/142/134，最大差 12px），
   *      于是 4 张图被判成 4 行 → 面板里变成"一列 4 行单图"。
   *      现在：顶对齐（旧口径）**或**垂直范围重叠 ≥ 较小者的 50% → 同一行。
   */
  function cellVisualText(cell, opts) {
    const skipNested = !!(opts && opts.skipNestedTables);
    if (!cell || typeof document === 'undefined' || !document.createRange) return cellText(cell, false, opts);
    const rows = [];

    /** 内容矩形（拿不到就给 null，由调用方回退）。
     *  **元素**（图片）必须用它自己的 `getBoundingClientRect()`：对 `<img>` 这类替换元素，
     *  `Range.selectNodeContents()` 选的是"它的子节点"（没有）→ 得到一个**零高度**的矩形，
     *  于是"垂直重叠"判据永远不成立（实测：4 张一行缩略图仍被拆成 4 行）。 */
    const rectOf = (node) => {
      try {
        if (node.nodeType === 1 && node.getBoundingClientRect) {
          const eb = node.getBoundingClientRect();
          if (eb && (eb.top || eb.height)) return eb;
        }
        const r = document.createRange();
        r.selectNodeContents(node);
        const b = r.getBoundingClientRect();
        if (b && (b.top || b.height)) return b;
      } catch (err) { /* 脱离文档/空节点 → 回退 */ }
      return null;
    };
    /** 同一视觉行：顶对齐（旧口径）或垂直范围明显重叠（同行缩略图高矮不一） */
    const sameLine = (row, top, bottom) => {
      if (!row) return false;
      if (Math.abs(row.top - top) <= 8) return true;
      const minH = Math.min(row.bottom - row.top, bottom - top);
      const overlap = Math.min(row.bottom, bottom) - Math.max(row.top, top);
      return minH > 0 && overlap >= minH * 0.5;
    };
    /** 追加一段（文本或图片）到"最后一个视觉行"，不在同一行就开新行 */
    const addSeg = (top, bottom, part) => {
      const last = rows[rows.length - 1];
      if (sameLine(last, top, bottom)) {
        last.parts.push(part);
        last.top = Math.min(last.top, top);          // 行高向下/向上扩展，后续段仍能并进来
        last.bottom = Math.max(last.bottom, bottom);
        return last;
      }
      const row = { top: top, bottom: bottom, parts: [part] };
      rows.push(row);
      return row;
    };
    const geoOf = (node) => {
      const b = rectOf(node);
      if (!b) { const t = rows.length * 100; return { top: t, bottom: t + 1 }; }
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    };

    /* 先按文档序收候选段（**不算几何**），再决定要不要排视觉行。
     * 绝大多数单元格只有一段文字，给它算 `Range` 矩形纯属白付"每格一次 layout 读取"；
     * 实测重页面（2000 行表格 / 2334 条命中）里这项开销占重要笔记结算的绝大部分
     * （见 `_e2e/probe-perf-mem.js` 的 `blockFor` 计数）。分段顺序仍是文档序，
     * 只有在候选 ≥2 段时才需要按矩形判断"是不是同一视觉行"。 */
    const cands = [];
    const pdfSeen = {};
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let n;
    while ((n = walker.nextNode())) {
      /* K79：读这一层的值时跳过它内部嵌的表格（文字与图片都跳过） */
      if (skipNested && insideNestedTable(n, cell)) continue;
      if (n.nodeType === 1) {
        if (n.tagName !== 'IMG') {
          /* PDF 引用（2.0.6.5 需求②）：`cellText` 那条 walk 已经会放占位符，这里**必须也放**、
           * 且判据一致 —— 值格取文走的是 `textOfCells` → 本函数，不补这一段时，真机表现是
           * 面板里只剩「下载 PDF」几个字、根本没有占位牌可点（占位符整段被吞掉）。
           * `<a>` 的文字照旧继续下钻（"下载说明书"往往就是真内容）。 */
          /* 同一份 PDF 的多层节点（`content-pdf` 套 `content-pdf-icon`）只算一张牌：
           * 旧写法每个匹配节点各放一次 ⇒ 面板里 3 张同址占位。 */
          const ref = pdfRefOf(n);
          if (ref) {
            if (!pdfSeen[ref]) { pdfSeen[ref] = 1; const ph = pdfPlaceholder(n); if (ph) cands.push({ node: n, ph: ph }); }
            continue;
          }
          const ctl = autoPdfControlOf(n);
          if (ctl) {
            const src = autoPdfOf(ctl);
            if (!src) {
              /* 同 `cellText`：等待中的牌按控件去重，一格几份就出几张 */
              kickAutoPdf(ctl);
              const kk = 'p:' + autoPdfTokenKey(ctl);
              if (!pdfSeen[kk]) {
                pdfSeen[kk] = 1;
                const ph3 = pdfPlaceholder(ctl);
                if (ph3) cands.push({ node: n, ph: ph3 });
              }
            } else if (!pdfSeen[src]) {
              pdfSeen[src] = 1;
              const ph2 = pdfPlaceholder(ctl);
              if (ph2) cands.push({ node: n, ph: ph2 });
            }
          }
          continue;
        }
        const ph = imgPlaceholder(n);
        if (ph) cands.push({ node: n, ph: ph });
        continue;
      }
      if (underInteractive(n, cell)) continue;
      if (underOverlay(n)) continue;                       // 浮层里的文字不算字段内容（只影响抓取）
      const t = (n.nodeValue || '').replace(/[\u00a0\u3000]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!t) continue;
      cands.push({ node: n, text: t });
    }
    if (!cands.length) return '';
    /* 单段 ⇒ 视觉行分组没有意义，直接给结果（省掉这一格的矩形读取） */
    if (cands.length === 1) return cands[0].ph != null ? cands[0].ph : cands[0].text;
    for (const c of cands) {
      const g = geoOf(c.node);
      addSeg(g.top, g.bottom, c.ph != null ? { img: c.ph } : { text: c.text });
    }
    return rows
      .map((r) => r.parts.map((p) => (p.img != null ? p.img : p.text)).join(' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  /* ------------------------------------------------------------ 触发判据 */

  /**
   * 触发判据（旧版 `_fetchNonEmptyPass`，v1.8.6 / v1.13.6 + v2.1.0 加固）：
   *   **直接右邻单元格存在且有正文（含中英数字）** 才算这条记录"有内容"。
   * 关键：**不能用会跳过空格子的 `_findRightCell`** —— 那会把"右格为空"误判成"无右格"
   * （策划案 §7.5 坑 15 明确点名的历史 bug）。
   *
   * 【控件不算内容】判据走 `cellText`，它按 `isInteractive` 剔除 `<button>` / `role=button` /
   * `opt-col|operate|caozuo|edit` 这类操作列、`javascript:` 伪协议操作链接与 `cursor:pointer` 控件，
   * 所以"右格只有一个【编辑】按钮"不会触发抓取；右格是"真内容 + 按钮"时按钮文字也不会混进判断。
   * 右邻格本身是控件（如 `<td class="el-button">`）同样判为空。
   *
   * 【占位串不算内容】剔除控件后剩下的文字还要过 `isPlaceholderText`（**与"下一字段"判据同一口径**）：
   * `-` / `--` / `——` / `~` / `/` 以及 `无` / `暂无` / `N/A` / `null` 都算"没有内容"，
   * 因此 **`-` 加一个按钮** 依然判空（按钮先被剔除，剩下 `-`），不会因为多了个控件就变成"有内容"。
   */
  function triggerOk(cell) {
    if (!cell || !cell.parentElement) return false;
    const nx = cell.nextElementSibling;
    if (nx && /^TD|TH$/i.test(nx.tagName)) {
      if (isInteractive(nx)) return false;                 // 右邻格本身就是控件
      const right = cellText(nx, false) || '';
      if (isPlaceholderText(right)) return false;          // 占位串 = 没有内容
      /* 仅图片也算内容（v1.99.99.12）：右格只有 `<img>`、没有任何文字时同样要显示该条。
       * 不靠"占位符里含 alt/url 字母"这种偶然性质，直接认图片占位符。 */
      if (right.indexOf('\u0001KHIMG\u0001') >= 0) return true;
      return /[\p{L}\p{N}]/u.test(right);
    }
    // 假表格：看右邻兄弟（跨层向上，与 _fakeRightValue 同口径）
    const v = fakeRightValue(cell);
    if (isPlaceholderText(v)) return false;
    return /[\p{L}\p{N}]/u.test(v || '');
  }

  /* -------------------------------------------------------- fetchLabels 解析 */

  /**
   * 解析 fetchLabels（旧版 v1.6.36 / v1.7.8；v1.99.99.12 扩展图片选项；本版扩展「值格指向」）：
   *   · 分隔符 `|` `｜` `,` `，`
   *   · 字段末尾 `#1` = **简单模式**：只取右侧相邻第一个单元格，不做整块多行表格
   *     （如「资质类型#1」）
   *   · 字段末尾 `#图`  = **仅图片**：该字段只保留图片，丢掉文字
   *   · 字段末尾 `#N`（N≥2）= **最多 N 张图**：图片超出部分丢掉，文字照旧
   *   · 可组合：`#图3` = 仅图片 + 最多 3 张
   *     （用户要求"抓取需要支持仅图片、前几张图片的方式"。放在字段名后缀里而不是新配置项，
   *      是为了**每个字段可以不一样**，且与既有的 `#1` 简单模式同一套写法、不必加界面控件。）
   *   · 字段末尾 `@表达式` = **值格指向**（本版新增，用户确认）：
   *     语法与关键词的 `cellOffset` **完全一致**（`2` / `1-3` / `1,3` / `1-3,5`，右起视觉列、仅本行内），
   *     含义是"标签格右边第几格才是该字段的值格"。
   *     · 例：`应用截图@2`、`应用截图@1-3#图`、`应用截图#图@2`（**修饰与偏移顺序无关**）
   *     · 留空 = 旧行为（右邻格）；表达式非法/越界 = **回退右邻格**（绝不报错、绝不变空值）
   *   · 字段末尾 `!` = **去内部空白**：去掉该字段所有空白（包名等连续标识符字段，排版空格要剔掉，
   *     例：`com.example.app lite` → `com.example.applite`，配 `包名!`）
   *   · 字段末尾 `%N`（N≥1）= **取前 N 个字符**；`%a-b` = **取第 a 到 b 个字符**（1-based 闭区间，
   *     例：`%2-3` 取第2、3字）。按 Unicode 码点切（中文/emoji 不拆半）；非法/越界 = **保留全文**
   *   · 字段末尾 `^锚文本`（2.0.2.4 新增）= **取锚点首次出现之前的文本**（并 trim）：抓取格里常被
   *     塞上「复制」「高价值」这类控件/角标文字，而**前缀长度不固定**，`%N` 定长切不动它。
   *     例：格文本 `abc [复制]高价值 [图标]` + `名称^[复制]` → `abc`。
   *     · 锚点是**字面文本**（不走正则、区分大小写）；**找不到锚点 = 保留全文**（同 `@`/`%` 的容错哲学）
   *   · 可组合：`包名!`、`包名!%6`、`简介%2-3`、`名称!^[复制]%3`（`!`/`^`/`%` 可与 `#`/`@` 任意顺序混写）
   *   修饰从**末尾**逐个剥（所以 `#…` / `@…` / `!` / `^…` / `%…` 可以任意顺序混写），最多剥多轮。
   *   执行顺序固定：`!` 去空白 → `^` 按锚点切 → `%` 按码点截取（与书写顺序无关）。
   */
  const IMG_SUFFIX_RE = /#\s*(图|仅图)?\s*(\d+)?\s*$/;
  /* 【2.0.9.2 需求】`#图1,3` / `#1,3` = **点名第几张图**（1 起数，跨格累计，与"前 N 张"同一套序号）。
   * 为什么必须用逗号：`#图3` 早有"最多 3 张"的语义，直接把 3 解释成"第 3 张"会改掉老配置；
   * 逗号列表只在**至少两个序号**时成立，单序号仍走老规则（`#1` 右邻一格、`#图1` 只留 1 张）。 */
  const IMG_PICK_RE = /#\s*(图|仅图)?\s*(\d+(?:\s*[,，]\s*\d+)+)\s*$/;
  /* 【2.0.8.14 需求①】字符类必须**排斥全部后缀记号**（`@ # ^ ! ~ * %`）：
   * 旧写法只排 `@ # ^`，于是 `名称@2~!` 的 `@` 会把 `2~!` 整串当表达式捕获 ⇒ 判非法、
   * `@2` 静默失效、`~`/`!` 也跟着被吞（用户实测：「@2 会被误读，从而都失效」）。 */
  /* 【2.0.19.2 需求②】`>` 是「取锚点之后」的记号，必须同 `^` 一样从各后缀的字符类里排斥，
   * 否则 `名称@2>甲方` 会被 `@` 表达式整串吃成 `2>甲方`（判非法 ⇒ `@2` 与新记号一起静默失效）。 */
  const OFFSET_SUFFIX_RE = /@\s*([^@#^!~*%<>]*)$/;
  /* `!` = 去内部空白；`^` = 取锚点之前的文本；`%` = 字符截取（%N 前N字 / %a-b 第a到b字）
   * —— 都从末尾剥，可与 # / @ 任意混写。三者的字符类互斥，避免 `名称@2^锚` 这种写法被 `@` 表达式吞掉。
   * 【2.0.8.14 需求①】同 OFFSET：`~`/`*` 也要排斥，否则 `%3~`、`^锚*` 会被一起吃掉。 */
  const STRIP_SUFFIX_RE = /\s*!\s*$/;
  const ANCHOR_SUFFIX_RE = /\^\s*([^\^%!@#~*<>]+)$/;
  /* 【2.0.19.2 需求②】锚点三种方向：
   *   `^甲方`     = 取「甲方」**之前**（2.0.2.4 起的老写法，语义不变）
   *   `>甲方`     = 取「甲方」**之后**（到本格末尾；trim 两端）
   *   `^甲方>乙方` = 取两者**之间**（各取首次出现，甲方在前、乙方在其后）
   * 为什么用 `>` 而不是把 `^` 写两遍：字段名本身可能带 `^`/任意汉字，
   * `甲^乙` 与「字段名甲 + 锚点乙」在语法上**不可区分**，会让老配置静默改义。
   * `>` 此前不参与任何后缀语义，配上 `^` 一起读也很直观（从甲之后到乙之前）。 */
  const ANCHOR_BETWEEN_RE = /\^\s*([^\^%!@#~*<>]+?)\s*>\s*([^\^%!@#~*<>]+)$/;
  const ANCHOR_AFTER_RE = />\s*([^\^%!@#~*<>]+)$/;
  const SLICE_SUFFIX_RE = /%\s*([^%!@#^~*<>]*)$/;
  /* 【2.0.8.8 需求④】`~` = 该字段内容格**不完整展示**（只裁显示，值不变）。放最后匹配，不影响既有后缀。 */
  const CLIP_SUFFIX_RE = /~\s*(\d{0,3})\s*$/;
  /* 【2026-11-16】抓取字段之间的比对标记：`#比` / `#比=对象`（必须在最末）。 */
  const CMP_SUFFIX_RE = /(?:#|＃)\s*(?:比|cmp)\s*(?:=\s*([^|｜\s~@#!%^]+))?\s*$/i;
  /* 【2.0.19.3 · m03229 ②③④】三个**字段级**选项（跟着字段串走，不再挂关键词上 ——
   * 用户原话：「这应该是针对某一个抓取字段修改的配置」）：
   *   `#占` = 这个字段里的图按小占位展示（带文件名，点开仍看大图）
   *   `~N`  = 只显示一行，并限制显示 N 个字（1–200；只写 `~` 沿用老行为 = 只折一行不数字数）
   *   `#期` = 这个字段自动抓期限（`#期=别名,别名` 可补证书里对它的叫法）
   * 必须在图片选项之前剥：`#` 后不是「图/数字」时 IMG_SUFFIX_RE 也会命中 `#`。 */
  const PH_SUFFIX_RE = /(?:#|＃)\s*占\s*$/;
  const TERM_SUFFIX_RE = /(?:#|＃)\s*期\s*(?:=\s*([^|｜\s~@#!%^*<>]+))?\s*$/;
  /* 【2.0.8.12 需求①】`*` = 该字段内容格**做成超链接**（值本身是网址就直链，否则按模板拼）。
   *  `*` 后面紧跟的是可选的链接模板（`{v}` 会被替换成 URL 编码后的值）；只放行 http/https，
   *  其它协议（javascript: / data: …）一律不生成链接 —— 笔记里的值来自任意网页，不能当可执行入口。 */
  const LINK_SUFFIX_RE = /\*(\S*)\s*$/;

  function parseLabelSpec(t) {
    let s = String(t == null ? '' : t).trim();
    let offset = '';
    /* 【2026-11-16 用户拍板·方案 A】抓取字段之间的比对：`开发者#比=著作权人`。
     * 含义＝这一行的值要和「著作权人」那一行的值比（同名＝一致）。
     * 标记必须收尾（与 #表 / #比 同一套写法），不写对象的 `#比` 单独存在＝还没指定对手。
     * ⚠️ 必须最先剥：`#` 后面没有「图/数字」时 `IMG_SUFFIX_RE` 也会命中 `#`，
     *    排在它后面这条标记就会被当成图片选项吃掉，字段名跟着变成 `开发者#比=著作权人` ⇒ 整条静默失效。 */
    let cmpOn = false;
    let cmpTarget = '';
    let imgOnly = false;
    let imgLimit = 0;
    let imgPick = [];
    let noImg = false;
    let simple = false;
    let stripSpace = false;
    let anchor = '';
    /* 2.0.19.2 需求②：锚点方向。'before'（默认，老行为）/ 'after' / 'between' */
    let anchorMode = '';
    let anchorTo = '';
    let sliceSpec = '';
    let clip = false;
    /* 2.0.19.3：字段级显示/进表选项 */
    let clipChars = 0;
    let ph = false;
    let term = false;
    let termLabels = [];
    let link = false;
    let linkTpl = '';
    for (let guard = 0; guard < 8; guard++) {
      const mcmp = CMP_SUFFIX_RE.exec(s);
      if (mcmp) {
        cmpOn = true;
        cmpTarget = String(mcmp[1] || '').trim();
        s = s.slice(0, mcmp.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      /* 【2.0.19.2 需求②】锚点方向必须在 `~`/`*`/`%/`@` 之前剥：
       * 它们的字符类都是"一直吃到末尾"，先剥的话 `>甲方` 会被当成链接模板/表达式的一部分。 */
      /* 【2.0.19.3】`#占` / `#期` 与 `#比` 同族：都是 `#` 收尾标记，紧跟比对之后、图片选项之前剥。 */
      const mph = PH_SUFFIX_RE.exec(s);
      if (mph) {
        ph = true;
        s = s.slice(0, mph.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const mtm = TERM_SUFFIX_RE.exec(s);
      if (mtm) {
        term = true;
        termLabels = String(mtm[1] || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
        s = s.slice(0, mtm.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const mb = ANCHOR_BETWEEN_RE.exec(s);
      if (mb && mb[1].trim() && mb[2].trim()) {
        anchor = mb[1].trim();
        anchorTo = mb[2].trim();
        anchorMode = 'between';
        s = s.slice(0, mb.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const maf = ANCHOR_AFTER_RE.exec(s);
      if (maf && maf[1].trim()) {
        anchor = maf[1].trim();
        anchorMode = 'after';
        s = s.slice(0, maf.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      /* `~` 必须**最先**剥：其它后缀的正则都允许"尾巴上还有别的字符"，
       * 最后剥的话 `%20~` 会被切片正则整串吃成 `20~`、`@2~` 变成非法位置。
       * 它只是显示选项（值一个字不改），先剥掉不影响任何取值语义。 */
      const mc = CLIP_SUFFIX_RE.exec(s);
      if (mc) {
        clip = true;
        const cn = parseInt(mc[1] || '', 10);
        clipChars = (cn >= 1 && cn <= 200) ? cn : 0;
        s = s.slice(0, mc.index).replace(/^[ 　]+|[ 　]+$/g, '');
        continue;
      }
      /* `*` 与 `~` 同族：都只是**显示选项**，先剥掉不影响任何取值语义。 */
      const mlk = LINK_SUFFIX_RE.exec(s);
      if (mlk) {
        const tpl = mlk[1] || '';
        /* 【2.0.8.14 需求①】`*` 后面紧跟**别的后缀记号**（`*~@2` / `*!%3`）时不能当模板开头：
         * 模板是 `\S*` 贪婪的，会把 `~@2` 整串吞进 linkTpl ⇒ `@2` 被误读成超链接后缀、其它后缀全失效。
         * 这种情况只摘掉 `*` 本身（`*` 仍然生效），后面的记号留给各自的规则继续剥。 */
        if (/^[~@#^!%<>]/.test(tpl)) {
          link = true;
          linkTpl = '';
          s = s.slice(0, mlk.index) + s.slice(mlk.index + 1);
          continue;
        }
        link = true;
        linkTpl = tpl;
        s = s.slice(0, mlk.index).replace(/^[ 　]+|[ 　]+$/g, '');
        continue;
      }
      const mp = IMG_PICK_RE.exec(s);
      if (mp) {
        /* 点名第几张图：`#图1,3` = 只要第 1、3 张图；`#1,3` = 文字照留、图只留第 1、3 张。 */
        imgPick = parseImgPick(mp[2]);
        if (mp[1]) imgOnly = true;
        s = s.slice(0, mp.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const mi = IMG_SUFFIX_RE.exec(s);
      if (mi) {
        /* `#` 后必须是「图 / 仅图 / 数字 / 空白」才算图片选项（正则已锚定 `$`），
         * 所以 `备注#说明` 这种把 `#` 写在标签里的写法不会被误当成后缀。 */
        const only = !!mi[1];
        const n = mi[2] ? parseInt(mi[2], 10) : 0;
        if (only) imgOnly = true;
        /* `#0`（2.0.2.5 需求①）= 这个字段**不要图**：图既不参与图片识别，也不带进抓取内容。
         * 多字段里截图、icon、logo 都带图时，用它点名"哪几个字段的图不认"。
         * 老版本里 `#0` 被剥掉后什么都不设（等于没写）⇒ 这不是改语义，是补上它本来就该有的语义。 */
        if (mi[2] && n === 0) noImg = true;
        /* `#1`（且没写"图"）= 历史语义：简单模式；`#图1` 才是"仅图片且最多 1 张" */
        if (n > 0) { if (!only && n === 1) simple = true; else imgLimit = n; }
        s = s.slice(0, mi.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const mo = OFFSET_SUFFIX_RE.exec(s);
      if (mo) {
        /* 【刻意把"不像表达式的 `@xxx`"也当表达式剥掉】否则 `应用截图@abc` 会变成
         * `label === '应用截图@abc'` → 表里找不到标签 → **整条字段静默失效**。
         * 剥掉之后由 `cellsAtOffsets` 判非法 → 回退右邻格，正是用户要的"非法就按没写处理"。 */
        offset = mo[1].replace(/\s+/g, '');
        s = s.slice(0, mo.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const ms = SLICE_SUFFIX_RE.exec(s);
      if (ms) {
        /* `%` 字符截取：`%N`=前N字；`%a-b`=第a到b字。非法表达式由 `applySlice` 判 → 保留全文。 */
        sliceSpec = ms[1].replace(/\s+/g, '');
        s = s.slice(0, ms.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const st = STRIP_SUFFIX_RE.exec(s);
      if (st) {
        /* `!` = 去内部空白（包名等连续标识符字段，排版空格要剔掉，如 `com.example.app lite` → 无空格） */
        stripSpace = true;
        s = s.slice(0, st.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      const ma = ANCHOR_SUFFIX_RE.exec(s);
      if (ma && ma[1].trim()) {
        /* `^锚文本` = 取锚点**首次出现之前**的文本（trim）。锚点是字面文本：不走正则、区分大小写。
         * `^` 后面没有实义字符（如标签就叫 `备注^`）⇒ **不当后缀**，`^` 留作标签自己的字符。 */
        anchor = ma[1];
        anchorMode = 'before';
        s = s.slice(0, ma.index).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
        continue;
      }
      break;
    }
    return { label: s, simple: simple, imgOnly: imgOnly, imgLimit: imgLimit, imgPick: imgPick, noImg: noImg, offset: offset, offsetInvalid: isOffsetInvalid(offset), stripSpace: stripSpace, anchor: anchor, anchorMode: anchorMode, anchorTo: anchorTo, sliceSpec: sliceSpec, clip: clip, clipChars: clipChars, ph: ph, term: term, termLabels: termLabels, link: link, linkTpl: linkTpl, cmpOn: cmpOn, cmpTarget: cmpTarget };
  }

  /**
   * 字段后缀的**展示串**（只给界面看：重要笔记表格的字段名格 + 编辑器里的胶囊徽标）。
   * 与 `parseLabelSpec` 一一对应 —— 改语法时这里必须同步，单测有一条把两者对照着钉住。
   * 返回空串 = 这个字段没写任何后缀（界面就不加那个徽标，与历史渲染逐字节一致）。
   */
  function suffixTextOf(it) {
    if (!it) return '';
    const out = [];
    /* `#0`＝该字段不要图，独占一行：它和 `#图`/`#N` 是相反意图，能同时写出来只说明用户写错了，
     * 此时以 `#0` 为准（展示串也照实写出来，让用户一眼看见自己写了什么）。 */
    if (it.noImg) out.push('#0');
    else if (it.imgPick && it.imgPick.length) out.push('#' + (it.imgOnly ? '图' : '') + it.imgPick.join(','));
    else if (it.imgOnly) out.push(it.imgLimit ? '#图' + it.imgLimit : '#图');
    else if (it.imgLimit) out.push('#' + it.imgLimit);
    else if (it.simple) out.push('#1');
    /* 「（无效）」只是展示标记：`@abc（无效）` 再读回来时它会被当成 offset 的一部分，
     * 不剥掉就会越标越多（`@abc（无效）（无效）`）。剥掉后展示串幂等。 */
    if (it.offset) out.push('@' + String(it.offset).replace(/（无效）$/, '') + (it.offsetInvalid ? '（无效）' : ''));
    if (it.stripSpace) out.push('!');
    /* 2.0.19.2 需求②：方向不同、展示串也不同，且必须能被 `parseLabelSpec` 读回同一语义
     * （单测把两者对照钉住：suffixTextOf 的产物再解析必须得到同样的 anchor/anchorMode/anchorTo）。 */
    if (it.anchor) {
      if (it.anchorMode === 'after') out.push('>' + it.anchor);
      else if (it.anchorMode === 'between' && it.anchorTo) out.push('^' + it.anchor + '>' + it.anchorTo);
      else out.push('^' + it.anchor);
    }
    if (it.sliceSpec) out.push('%' + it.sliceSpec);
    if (it.clip) out.push(it.clipChars ? ('~' + it.clipChars) : '~');
    if (it.ph) out.push('#占');
    if (it.term) out.push('#期' + (it.termLabels && it.termLabels.length ? ('=' + it.termLabels.join(',')) : ''));
    if (it.link) out.push('*' + (it.linkTpl || ''));
    return out.join(' ');
  }

  /**
   * 【2.0.8.13 需求①】后缀 → **人话**（给字段行上的按钮用；`suffixTextOf` 仍然是落盘语法）。
   * 用户不该为了看懂"这字段怎么取值"去记 `@2#图3!`；按钮上直接写「右数第 2 格 · 图最多 3 张 · 去空格」，
   * 真要抄语法就看 `title`（那里放 `suffixTextOf` 的原串）。
   * 空配置返回 ''（调用方显示「默认：右邻这一格」）。
   */
  function describeSuffix(it) {
    if (!it) return '';
    const out = [];
    const off = String(it.offset || '').trim();
    if (off) out.push(it.offsetInvalid ? ('值格 @' + off + '（无效）') : ('值格：右数第 ' + off + ' 格'));
    if (it.imgPick && it.imgPick.length) out.push((it.imgOnly ? '只留图：' : '文字与图：') + '第 ' + it.imgPick.join('、') + ' 张');
    else if (it.noImg) out.push('不要图片');
    else if (it.imgOnly) out.push(it.imgLimit ? ('只留图（最多 ' + it.imgLimit + ' 张）') : '只留图');
    else if (it.imgLimit) out.push('图最多 ' + it.imgLimit + ' 张');
    else if (it.simple) out.push('只读右邻一格');
    if (it.stripSpace) out.push('去空格');
    if (it.anchor) {
      if (it.anchorMode === 'after') out.push('取「' + it.anchor + '」之后');
      else if (it.anchorMode === 'between' && it.anchorTo) out.push('取「' + it.anchor + '」到「' + it.anchorTo + '」之间');
      else out.push('截到「' + it.anchor + '」之前');
    }
    const sp = String(it.sliceSpec || '');
    if (sp) out.push(/^\d+\s*-\s*\d+$/.test(sp) ? ('取第 ' + sp.replace(/\s*-\s*/, '–') + ' 个字') : ('取前 ' + sp + ' 个字'));
    if (it.clip) out.push(it.clipChars ? ('只显示一行、最多 ' + it.clipChars + ' 字') : '只显示一行');
    if (it.ph) out.push('图片按占位展示');
    if (it.term) out.push('自动抓期限');
    if (it.link) out.push(it.linkTpl ? '做成链接（用模板）' : '做成链接');
    return out.join(' · ');
  }

  /* `^` 对**单段文本**做「锚点之前」截取。
   *  锚点找不到（或本身为空）→ **保留全文**（`@`/`%` 同款容错：绝不报错、绝不变空值）。
   *  锚点在开头 → 结果是空串（前面确实什么都没有，这是真实结果，不是容错分支）。 */
  function applyAnchor(t, anchor, mode, anchorTo) {
    if (anchor == null || anchor === '') return t;
    const s = String(t);
    const i = s.indexOf(anchor);
    if (i < 0) return t;
    /* 【2.0.19.2 需求②】方向：默认/'' = 之前（老行为，逐字节不变）；
     * `after` = 锚点之后到本格末尾；`between` = 甲之后到**甲后面第一个**乙之前。
     * 乙找不到 / 乙在甲之前 ⇒ 保留全文（与"锚点找不到"同一条容错，绝不返回空串）。 */
    if (mode === 'after') return s.slice(i + anchor.length).trim();
    if (mode === 'between') {
      if (anchorTo == null || anchorTo === '') return t;
      const j = s.indexOf(anchorTo, i + anchor.length);
      if (j < 0) return t;
      return s.slice(i + anchor.length, j).trim();
    }
    return s.slice(0, i).trim();
  }

  /* `%` 表达式对**单段文本**做字符截取。
   *  `%N`  (N≥1)：取**前 N 个字符**；`%a-b`：取**第 a 到 b 个字符**（1-based 闭区间）。
   *  按 Unicode 码点切（`Array.from`）—— 中文 / emoji 不会被拆成半个。
   *  表达式非法 / 越界（a<1、b>长度、a>b、负数、非数字）→ **保留全文**（同 `@` 的容错哲学）。 */
  function applySlice(t, spec) {
    if (spec == null || spec === '') return t;
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec);
    if (!m) return t;                       // 非法表达式 → 保留全文
    const chars = Array.from(String(t));
    const a = parseInt(m[1], 10);
    if (m[2] != null) {
      let lo = a, hi = parseInt(m[2], 10);
      if (lo < 1) lo = 1;
      if (hi > chars.length) hi = chars.length;
      if (lo > hi) return t;                // 越界区间 → 保留全文
      return chars.slice(lo - 1, hi).join('');
    }
    const n = Math.min(Math.max(a, 0), chars.length);   // `%0` → 空，`%超长` → 全文
    return chars.slice(0, n).join('');
  }

  /* 对一行值格文本应用字段级修饰：`!` 去内部空白 → `^` 按锚点切 → `%` 字符截取（顺序固定，与书写顺序无关）。 */
  function modText(t, item) {
    if (item.stripSpace) t = String(t).replace(/\s+/g, '');
    if (item.anchor) t = applyAnchor(t, item.anchor, item.anchorMode, item.anchorTo);
    if (item.sliceSpec) t = applySlice(t, item.sliceSpec);
    return t;
  }

  /* 对 `rows` 里每个值格文本应用字段级修饰（简单 `#1` / `@`偏移 / 整块表格**三条路径统一收口**）。
   *  `rows` = 数组的数组：外层每行、内层每格（真实多列格同样逐格处理）。 */
  function transformRows(rows, item) {
    for (const line of rows) {
      for (const c of line) {
        if (c && typeof c.t === 'string') c.t = modText(c.t, item);
      }
    }
    return rows;
  }

  /** 表达式本身是否**无法解析**（越界要拿到具体一行才知道，见 `cellsForHit` 的 invalid） */
  function isOffsetInvalid(spec) {
    if (!spec) return false;
    const Cells = KH.Cells;
    if (!Cells || typeof Cells.parseCellOffsets !== 'function') return false;
    return !Cells.parseCellOffsets(spec);
  }

  function parseLabels(raw) {
    return splitLabelTokens(raw)
      .map(parseLabelSpec)
      .filter(it => it.label);
  }

  /**
   * 按分隔符切 fetchLabels：`|` `｜` **永远是**分隔符；
   * `,` `，` 只有在**不属于 `@表达式`** 时才算分隔符 ——
   * 值格表达式 `1,3` / `1-3,5` 里的逗号必须留给表达式本身
   * （否则 `应用截图@1,3` 会被切成 `应用截图@1` + `3` 两个字段 → 静默失效）。
   * 判据只看 `@` 之后的尾巴是否只由「数字/连字符/空白」组成、且下一段也是 —— 足够保守：
   * `应用截图@2,乙` 不会被误合（`乙` 不是表达式片段）。
   *
   * ⚠️ 同一套规则在 `src/platform/storage.js` 的 `normalizeLabels` 里也有一份：
   * 字段在**保存时**就要按同样口径归一化，而管理端（options/popup）**不加载**本文件
   * （见两个 html 的 script 清单），所以那是同一语义的第二个必需实现，不是漏改。
   */
  function splitLabelTokens(raw) {
    const out = [];
    for (const chunk of String(raw == null ? '' : raw).split(/[|｜]/)) {
      let cur = '';
      for (const piece of chunk.split(/[,，]/)) {
        const p = piece.trim();
        if (!p) continue;
        if (cur && /@[0-9\s-]+$/.test(cur) && /^[0-9\s-]+$/.test(p)) { cur += ',' + p; continue; }
        /* 【2.0.9.2】`#图1,3` / `#1,3` 的逗号属于「点名第几张图」后缀，不能当字段分隔符
         * （否则 `截图#图1,3` 会被切成 `截图#图1` + `3` 两个字段，第三个序号静默失效）。 */
        if (cur && /#\s*(?:图|仅图)?\s*\d+$/.test(cur) && /^\d+$/.test(p)) { cur += ',' + p; continue; }
        if (cur) out.push(cur);
        cur = p;
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  /** 图片占位符（`imgPlaceholder` 产出）的正则：`\u0001KHIMG\u0001alt|url\u0001ENDIMG\u0001` */
  const IMG_RE = new RegExp('\u0001KHIMG\u0001[^|]*\\|[^\u0001]*\u0001ENDIMG\u0001', 'g');

  /**
   * 剔掉图片占位符，**只留文字**。`#0`（不要图）与图片动态关键词的判据比较共用这一份 ——
   * 判据类比较（"这个值在不在图上"）绝不该把 `\u0001KHIMG\u0001alt|url\u0001ENDIMG\u0001` 当成文字的一部分，
   * 否则值与 OCR 文本永远对不上（2.0.4 需求② 真机红就是这么来的：老实现取 `textContent` 没有占位符，
   * 换到行文本后占位符跟着进来了）。
   */
  /* PDF 占位（KHPDF 哨兵）：它不是图片、也不参与「前 N 张」的序号，但在「#图」（只留图片）
   * 字段里必须留下 —— 用户 2026-11-18 口径：「抓取字段仅图片的后缀，把这种 pdf 也内容可进范围」。 */
  const PDF_RE = new RegExp('\u0001KHPDF\u0001[^|]*\\|[^\u0001]*\u0001ENDPDF\u0001', 'g');

  function stripImgPlaceholders(text) {
    return String(text == null ? '' : text).replace(IMG_RE, '');
  }

  /** 占位串**一律**剥掉（图片 `KHIMG` + PDF `KHPDF`）：判据比较只看文字。
   *  【2.0.14.4 · m12710】用户现场：`著作权人#比` 取到的候选值里混着 PDF 占位串
   *  （`\u0001KHPDF\u0001|url\u0001ENDPDF\u0001下载`），于是「页面上没取到值」被误说成
   *  「图上有值但不同」。剥完只剩文字，两种情形才分得清。 */
  function stripAllPlaceholders(text) {
    return stripImgPlaceholders(text).replace(PDF_RE, '');
  }

  /**
   * `1,3` / `1，3` → `[1,3]`（1 起数、去重、升序、最多 12 个）。
   * 序号是**整字段的图片序号**（跨格累计，和 `#N` 的"前 N 张"同一套计数），不是"这一格里第几张"。
   */
  function parseImgPick(text) {
    const out = [];
    for (const part of String(text == null ? '' : text).split(/[,，]/)) {
      const n = parseInt(part, 10);
      if (!(n >= 1 && n <= 99)) continue;
      if (out.indexOf(n) < 0) out.push(n);
    }
    out.sort((a, b) => a - b);
    return out.slice(0, 12);
  }

  /**
   * 按字段的图片选项处理一段内容（**只动图片占位符与文字，不碰 HTML**，调用方随后仍走 escHtml）：
   *   · `imgOnly`  → 只留图片（丢掉文字）
   *   · `imgLimit` → 该字段全局最多保留 N 张图（`budget.n` 跨单元格累计，保证"前 N 张"是整字段的前 N 张）
   *   · `imgPick`  → 只保留点名的第几张图（序号同样跨单元格累计）
   *   · `noImg`（`#0`）→ 图**全不要**（丢掉图片占位符、文字照留）
   * 用户口径："抓取需要支持仅图片、前几张图片的方式"，以及"图片可以配成抓第一张和第三张"。
   */
  function applyImgPolicy(text, opt, budget) {
    let s = String(text == null ? '' : text);
    const b = budget || { n: 0 };
    /* 【`#0` = 该字段不要图（2.0.2.5 需求①）】占位符剔干净、文字原样留下；
     * 图片识别那一侧由 `img-ocr` 按 `cellsForHit` 返回的 `noImg` 跳过（这里不再管识别）。 */
    if (opt && opt.noImg) {
      s = stripImgPlaceholders(s);
      return s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
    }
    if (!opt) return s;
    const pick = (Array.isArray(opt.imgPick) && opt.imgPick.length) ? opt.imgPick : null;
    const limit = opt.imgLimit > 0 ? opt.imgLimit : 0;
    if (!opt.imgOnly && !limit && !pick) return s;
    /* 【刻意**不按 src 去重**】真实页面里同一张图可能在两列/两行里各出现一次
     * （用户给的结构就是这样：最新版本与历史版本都放了「图一图二」），
     * 去重会直接把其中一列吃空 —— 比"偶尔多一张重复图"糟得多。 */
    if (b.n == null) b.n = 0;                    // 跨单元格累计，**不重置**
    const kept = [];
    s = s.replace(IMG_RE, (m) => {
      b.n++;
      const keep = pick ? (pick.indexOf(b.n) >= 0) : (!limit || b.n <= limit);
      if (keep) kept.push(m);
      return keep ? m : '';
    });
    s = s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
    /* 只留图：文字一个不留（占位符按序号/上限过滤后的那份）。
     * 【2026-11-18 用户口径】PDF 附件也算「内容」——它既不是文字、也不占图片名额，
     * 所以「#图」字段里要照常留下 PDF 占位（否则配了「仅图片」就再也看不到那份 PDF）。 */
    if (opt.imgOnly) {
      const comb = new RegExp(IMG_RE.source + '|' + PDF_RE.source, 'g');
      const merged = [];
      let hit;
      let n = 0;
      while ((hit = comb.exec(s))) {
        const m = hit[0];
        if (m.indexOf('\u0001KHIMG\u0001') === 0) {
          n++;
          const keepImg = pick ? (pick.indexOf(n) >= 0) : (!limit || n <= limit);
          if (keepImg) merged.push(m);
        } else {
          merged.push(m);
        }
      }
      return merged.length ? merged.join(' ') : '';
    }
    return s;
  }

  /**
   * 空值判定**唯一口径**：`-` / `—` / `–` / `－` / `~` / `/` 等符号占位串，
   * 以及 `无` / `暂无` / `N/A` / `null` 这类"没有内容"的文字占位串。
   *
   * 为什么必须单独判、且必须只有一处：
   *   · 抓取块的「下一字段」判据是"标签列有内容且右侧全空"，而**空值行的标签列常写 `-`**
   *     （用户明确要求"备注为空显示 `-`"）。若不把 `-` 当占位，空值行会被误判成"下一字段开始"，
   *     把后面的真实值整段截掉 —— 实测踩到：仅抓取模式下第 1 行右格是 `-`，
   *     第 2 行的真实包名就再也抓不出来（策划案 §7.5 坑 15「触发判据 ≠ 抓取内容」要防的正是这类语义错）。
   *   · **触发判据**（`triggerOk`）问的也是"右格有没有内容"，必须用同一份口径 ——
   *     否则就会出现"`-` 算空、`无` 算内容"这种同一概念两套规则的漂移
   *     （用户实测问到：`-` 加一个按钮时算不算空）。
   *
   * 【词表是白名单，一行的成本】漏收的占位串只会**多显示一条**（值就是那个占位串），
   * 不会丢内容；已有词误伤才会丢内容，所以只收"无歧义 = 没有值"的串，
   * 且**全串锚定**（`^…$`）—— `无理由退货` 这种真值不会被误判。
   */
  const PLACEHOLDER_WORDS = /^(?:无|暂无|没有|无数据|暂无数据|未填写|未设置|未配置|n\/?a|null|none|undefined|nil)$/i;

  function isPlaceholderText(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return true;
    if (/^[-—–－~～/\\|*·．.、\s]+$/.test(t)) return true;   // 纯符号占位（`-` / `--` / `——` / `/` …）
    return PLACEHOLDER_WORDS.test(t);
  }

  /* ---------------------------------------------------------- 合并块抓取 */

  /** 表内 rowspan 概况（`{hasSpan, maxSpan}`）—— 供 `collectRightBlock` 决定"回放哪几行"。
   *  按 (表, 本轮重建) 记忆（`box.span`），所以每张表每轮只扫一遍。 */
  function tableSpanInfo(table, box) {
    const store = box && box.span;
    if (store && store.has(table)) return store.get(table);
    let maxSpan = 1;
    let hasSpan = false;
    const trs = ownRowsOf(table);
    for (const tr of trs) {
      const cells = tr.cells || tr.children || [];
      for (const td of cells) {
        const rs = td.rowSpan || 1;
        if (rs > 1) { hasSpan = true; if (rs > maxSpan) maxSpan = rs; }
      }
    }
    const info = { hasSpan: hasSpan, maxSpan: maxSpan };
    if (store) store.set(table, info);
    return info;
  }

  /**
   * 收集标签格右侧的合并块（旧版 `_collectRightBlock`，v1.6.37 / v1.7.3）。
   * 标签格可能是 rowspan 合并多行的单元格，右侧为未合并的每行单元格。
   * 返回 `[[{t, rs, cs}, ...], ...]`：每行一个数组，rs/cs 为原表格的 rowspan/colspan。
   *
   * 抓取范围**不限于 label 的 rowspan**：右侧内容常纵向延伸超过合并范围；
   * 一路向下抓，直到"超过 label 合并范围后 label 所在列出现新内容"（视为下一字段开始）
   * 或表格结束。
   *
   * 【K74 · `opts.stopAtRepeatedLabel`】只在"标签格取自**命中所在那一行**"时传 true：
   * 该行的下一行若在同一列又出现**同一个标签文字**，那就是下一条记录（"每行重复 标签|值"的键值表），
   * 本字段到此为止。为什么必须加这条（实测数据）：不加时，这类表里每一行的标签格都会把
   * **下面所有行**收成自己的值 —— 800 行的表上每个命中各生成几十 KB 的 HTML，
   * 整页就绪从"毫秒级"退化到 **20s+**（`_e2e` 的「18. 重页面性能预算」由绿转红）。
   * 判据与既有的"新字段起始行（标签文字**不同**）"同源（见下面 `nextField` 的第二条），
   * 只是把"同一个标签文字"也算成边界；仍然要求 `!labelIsLastColumn`
   * ——"值就在标签列"的两列表（`应用名称 | 包名`）行为不变。
   */
  function collectRightBlock(cell, table, opts) {
    const stopRepeat = !!(opts && opts.stopAtRepeatedLabel);    const rowIdx = cell.parentElement ? cell.parentElement.rowIndex : -1;
    /* 【2.0.6.3 需求⑥】右侧取值的边界：同一张卡里还配了别的字段时，右邻格只要**整格等于另一个
     * 字段名**就收尾 —— 否则「授权方 | 合肥… | 被授权方 | 沈阳…」这种一行多字段的表，会把下一个
     * 字段名连同它的值一起并进上一个字段（用户现场：`被授权方|沈阳喜焱…` 后面拖着 `授权方`）。
     * 只认整格相等，不做包含匹配：值里恰好出现别的字段名（「开发者：授权方代表」）不受影响。 */
    const squashLbl = (v) => String(v == null ? '' : v).replace(/[\s\u3000]+/g, '');
    const otherLabels = new Set();
    ((opts && opts.labels) || []).forEach((l) => {
      const k = squashLbl(l);
      if (k) otherLabels.add(k);
    });
    const selfKey = squashLbl(opts && opts.selfLabel ? opts.selfLabel : (cell.textContent || ''));
    const isOtherLabel = (txt) => {
      const k = squashLbl(txt);
      return !!k && k !== selfKey && otherLabels.has(k);
    };
    if (rowIdx < 0) return [];
    const rowspan = cell.rowSpan || 1;
    const col = cell.cellIndex;
    const nRows = table.rows.length;

    const colUsage = {};
    const occupy = (c, span, rs) => {
      for (let k = 0; k < span; k++) {
        const key = c + k;
        colUsage[key] = Math.max(colUsage[key] || 0, rs);
      }
    };
    const step = (tds) => {
      let c = 0;
      const out = [];
      for (const t of tds) {
        while (colUsage[c]) c++;
        const cs = t.colSpan || 1;
        const rs = t.rowSpan || 1;
        out.push({ td: t, col: c });
        occupy(c, cs, rs);
        c += cs;
      }
      Object.keys(colUsage).forEach(k => { colUsage[k]--; if (colUsage[k] <= 0) delete colUsage[k]; });
      return out;
    };

    // 前置：处理标签上方各行，建立列占用（兼容标签前有合并的表格）
    /* 【K74 · 只回放"可能仍然挂着 rowspan"的那几行】原来是无条件从第 0 行回放到 rowIdx-1，
     * 于是**逐行**调用时整体退化成 O(行数²)：3000 行页面实测 21s（预算 12s）。
     * 正确性：第 r 行起、`rowSpan = s` 的格子在"处理第 R 行之前"仍挂着 ⟺ r + s > R；
     * 而 s ≤ 表内最大 rowSpan（记 K）⇒ 只有 r > R - K 的行才可能有悬挂行span
     * ⇒ 从 `max(0, R-K)` 开始回放的结果与从 0 开始**逐位相同**。
     * 表里根本没有 rowspan（绝大多数表）时 K 不起作用，直接跳过整段回放。 */
    const info = tableSpanInfo(table, opts && opts.box);
    const replayFrom = info.hasSpan ? Math.max(0, rowIdx - info.maxSpan) : rowIdx;
    for (let r = replayFrom; r < rowIdx && r < nRows; r++) step(table.rows[r].cells);

    /**
     * 【起始行 = 标签格自身所在行】（与旧版 `_collectRightBlock` 一致）
     *   旧版就把"标签行 + 其右侧格子"算作该字段内容的一部分（rowspan 形式的字段名尤其如此）。
     *   改成"标签下一行"会让「仅抓取」（标签在表头、值在下方）整块抓空 —— 实测踩到。
     *
     * 【「下一字段」判据】= 标签列的格子**没有被上方 rowspan 占用**（即它真的是本列的一个新格子）
     *   且该格有内容、且标签列右侧全空 → 视为下一个字段的开始。
     *
     *   为什么不能只用"标签列有内容"：同一列在不同表格里含义完全不同 ——
     *     · 多列字段表：标签列是"字段名区"，出现新内容 = 新字段（要收尾）；
     *     · 两列表（字段名 | 值）：标签列**本身就是值列**，第 1 行是字段名、后续行是值，
     *       每一步都在标签列有内容 —— 只看"有内容"会把第 2 行起的真实值全部截断。
     *   区分办法：看该行这个位置是"被上方 rowspan 占位后自动落位"还是"真实存在的新格子"。
     *   真实拖尾（同列独立格子）→ 当成同字段的多行内容继续收集；
     *   被占位落位 → 与上面是同一逻辑列，继续收集。
     *   本判据在"多行内容 / rowspan 合并块 / 两列表 / 表头式标签"四种布局下都给出正确结果。
     */
    /** 标签格本身是不是"表头格"——用它决定是否把标签行算作内容：
     *  `<tr><th>驳回原因</th><th>运营备注</th></tr>` 这种"标签在表头、值在下方"的表格，
     *  标签行的其它格子是**列标题**，必须跳过；而字段名直接写在数据格里的表格
     *  （`<td>驳回原因</td>`），标签行本身就是内容行。
     *
     *  ⚠️ **K79 返工（R4 红牌 R4-TH）**：判据原来只看"这一格是 `<th>`"，于是**行表头**
     *  `<tr><th>驳回原因</th><td>值</td></tr>`（键值表里非常常见的写法）也被当成表头行 ⇒
     *  `startRow` 跳到下一行 ⇒ **该字段读到的是下一行的值**（真机最小复现：读到「后续字段」的值）。
     *  现在收窄成"**整行都是 `<th>`**，或该行在 `<thead>` 里"才算表头行：
     *   · 真表头（一行全是列标题）照旧跳过 ✓
     *   · 行表头 + 值格（`th` 与 `td` 混排）⇒ 不是表头行 ⇒ 读本行自己的值格 ✓
     *   · 只有一格 `<th>` 的"标题行"（值在下面）⇒ 整行都是 TH ⇒ 仍算表头行 ✓（不回归） */
    function isHeaderLikeCell(cell) {
      if (!cell) return false;
      const tr = cell.closest ? cell.closest('tr') : null;
      const table = cell.closest ? cell.closest('table') : null;
      if (tr) {
        const head = table ? (table.tHead || table.querySelector('thead')) : null;
        if (head && head.contains(tr)) return true;                    // 在 <thead> 里 ⇒ 表头行
        const tds = (tr.cells && tr.cells.length) ? tr.cells : (tr.children || []);
        if (tds.length) {
          for (let i = 0; i < tds.length; i++) {
            const c = tds[i];
            if (!c || c.tagName !== 'TH') return false;                // 有 td 混排 ⇒ 不是表头行（行表头形状）
          }
          return true;                                                 // 整行都是 th ⇒ 真表头行
        }
      }
      /* 垫片 / 极端结构下拿不到"行"⇒ 退回旧的"看标签名"（保守：当表头处理） */
      return cell.tagName === 'TH';
    }

    const startLabel = cellVisualText(cell);          // 起始标签文本（新字段判据要用）
    const startRow = isHeaderLikeCell(cell) ? (rowIdx + rowspan) : rowIdx;
    const labelBottom = rowIdx + rowspan;
    const headerLike = isHeaderLikeCell(cell);
    const rows = [];
    for (let r = startRow; r < nRows; r++) {
      const cells = step(table.rows[r].cells);
      const line = [];
      let labelCell = null;
      for (const c of cells) {
        if (c.col === col) { labelCell = c.td; continue; }
        if (c.col > col) {
          const txt = cellVisualText(c.td, { skipNestedTables: true });   // K79：值里不含内表文字
          if (isOtherLabel(txt)) break;                                   // 【2.0.6.3 需求⑥】撞到别的字段名就收尾
          if (txt || (c.td.rowSpan || 1) > 1 || (c.td.colSpan || 1) > 1) {
            line.push({ t: txt, rs: c.td.rowSpan || 1, cs: c.td.colSpan || 1 });
          }
        }
      }
      /**
       * 标签列右侧**没有任何列**的表（典型是两列表「字段名 | 值」）：
       * 它的值就在标签列本身 —— 第 1 行是字段名，之后每行是值。
       * 必须把标签列的格子也算进内容，否则「仅抓取」这类两列表永远抓不到东西
       * （实测踩到：`应用名称 | 包名` 两列，值全在标签列，`c.col > col` 恒为空 → 抓取块为空）。
       * 判据用"标签列是不是最后一列"，两种表都能兼顾。
       */
      const labelIsLastColumn = !cells.some(c => c.col > col);
      if (labelIsLastColumn && labelCell) {
        const txt = cellVisualText(labelCell);
        if (txt) line.push({ t: txt, rs: labelCell.rowSpan || 1, cs: labelCell.colSpan || 1 });
      }

      // 新字段起始行：标签格不是表头格（即标签写在数据格里）、标签列不是最后一列、
      // 标签列有真实内容（非 `-` 占位）、且本行标签列右侧没有任何内容。
      const isOwnCell = !!(labelCell && !isPlaceholderText(cellVisualText(labelCell)));
      let nextField = !headerLike && !labelIsLastColumn && r >= labelBottom && isOwnCell && line.length === 0;
      /* 新字段起始行（补充判据）：本行是**真实的新标签格**、标签文字与起始标签**不同**、
       * 且本字段**已经收集到内容** → 同样是新字段的开始。
       *
       * 为什么必须有这一条：上面那条要求"本行右侧为空"，而「标签 | 值」这种最常见的两列表里，
       * 下一个字段那一行**右侧恰恰有值** → 被判成"同字段的又一行内容"，于是**字段块一路越界**：
       * 实测（极端场景体检）驳回原因的值里混进了「高价值需跟进 / 命中行…」，
       * 后面的字段内容被吞掉又重复渲染。判据只在"值取自右侧列"时生效（`!labelIsLastColumn`），
       * 所以"值就在标签列"的两列表（`应用名称 | 包名`）行为不变。
       * rowspan 合并的标签（如上例中跨两行的「驳回原因」）仍算同字段 —— 它的 `isOwnCell` 为假。 */
      if (!nextField && !headerLike && !labelIsLastColumn && r >= labelBottom && isOwnCell &&
          (rows.length || line.length) && cellVisualText(labelCell) !== startLabel) {
        /* ⚠️ K79：守卫从 `rows.length &&` 放宽成 `(rows.length || line.length) &&` ——
         * "取值排除嵌套表格文字"之后，本字段的值**可能在清空后变空**（形状 B：外层「驳回原因」的值格就是内表）。
         * 那时 `rows.length` 仍是 0、旧守卫不成立 ⇒ 块继续往下走，把**下一行另一个字段的值**当成了本字段的内容
         * （真机实测：吃到了下一行的 `外层详情B`）。本行既然有内容、标签又换了，就是新字段。 */
        nextField = true;
      }
      /* K74：标签取自命中行时，"同一列又出现同一个标签"＝下一条记录（见函数头注释） */
      if (!nextField && stopRepeat && !headerLike && !labelIsLastColumn && r >= labelBottom &&
          isOwnCell && rows.length && cellVisualText(labelCell) === startLabel) {
        nextField = true;
      }
      if (nextField) break;                  // 新字段起始行：本行不含本字段内容，直接收尾
      if (line.length) rows.push(line);
    }
    return rows;
  }

  /* ---------------------------------------------------------- 假表格抓取 */

  /** 取「标签元素」右侧内容（旧版 `_fakeRightValue`）：同父右邻兄弟 → 逐层向上找父级右邻兄弟 */
  function fakeRightValue(labelEl) {
    if (!labelEl) return '';
    let sib = labelEl.nextElementSibling;
    while (sib) {
      const v = cellText(sib, true);
      if (v) return v;
      sib = sib.nextElementSibling;
    }
    let p = labelEl.parentElement;
    for (let d = 0; p && d < 6; d++, p = p.parentElement) {
      const ps = p.nextElementSibling;
      if (ps) {
        const v = cellText(ps, true);
        if (v) return v;
      }
    }
    return '';
  }

  /**
   * 假表格里"命中所在的**那一行**、以及这一行里的标签元素"（K75 的唯一作用域口径）。
   *
   * 判据：从命中元素**向上**找第一个满足下面三条的祖先 `el` ——
   *   ① `el` 不是 `body` / `html`（不许整页找）；
   *   ② `el` 有 **≥2 个元素子节点**（"一行里至少两格"）；
   *   ③ `el` 的某个**直接子节点** `k` 满足 `k.textContent.trim() === label`
   *   ⇒ 作用域 = `el`（那一行），标签元素 = `k`（值 = `k` 的右邻）。
   *
   * 【为什么从"命中元素"向上走、而不是拿"命中节点的父元素"回退（K75 返工 · R4 红牌）】
   * 命中文本常被页面套在**值格内的行内元素**里（`<span>/<em>/<b>/<a>`）。上一版拿
   * `textNode.parentElement` 当入口、并在拿不到行时回退"它自己的父级" ⇒ 入口落在**值格**上，
   * 而标签那一侧的作用域是**行**（`.row`/`li`）⇒ 两侧不同层、标签被判掉 ⇒ **静默不抓**
   * （div 键值表在真实站点很常见，站点给命中词套个 `<span style>` 就命中此形态）。
   * 按"直接子节点里有该标签"来定行，"命中直接落格"与"命中落格内行内元素"归到同一层；
   * 同时 ③ 天然挡住"标签在别的行"（那一行的整段文本 ≠ 单个标签）、"标题里的命中"
   * （祖先的孩子里没有整段等于标签的）与"裸文本"（`<p>` 没有 ≥2 个元素子节点）。
   */
  function findFakeLabelInRow(startEl, label) {
    if (!startEl || startEl.nodeType !== 1 || !label) return null;
    let el = startEl;
    while (el && el.nodeType === 1) {
      if (el === document.body || el === document.documentElement) break;
      const kids = el.children || [];
      if (kids.length >= 2) {
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          if ((k.textContent || '').trim() === label) return { scope: el, labelEl: k };
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 假表格抓取（旧版 `_extractFetchedFromFakeTable`，v1.13.4）：
   * 无 `<table>` 时，在**命中所属的那一行**里找「文本==标签」的**直接子节点**，取其右邻内容。
   *
   * 【K75 收窄】作用域不再是"向上找到含全部标签的祖先（最坏一路到 body）"，而是
   * "命中那一行 + 标签必须是这一行的直接子节点"（判据与来龙去脉见 `findFakeLabelInRow`）：
   *   · 这一行里没有该标签 ⇒ 本字段不抓（不生成值行）；
   *   · 一个字段都抓不到 ⇒ 整条不产生卡片（用户要的"不要多出一张无关的卡"）；
   *   · 命中不在任何行容器里（标题 / 段落 / 裸文本）⇒ 直接返回空。
   * 真 `<table>` 路径**一行未改**（K74 的"命中行优先 → 整表兜底"照旧）。
   */
  function extractFromFakeTable(startEl, items) {
    if (!startEl) return [];
    const out = [];
    for (const item of items) {
      const found = findFakeLabelInRow(startEl, item.label);
      if (!found) continue;
      const val = fakeRightValue(found.labelEl);
      if (val) out.push({ label: item.label, rows: [[{ t: val, rs: 1, cs: 1 }]] });
    }
    return out;
  }

  /* --------------------------------------------------------------- 主入口 */

  function nearestTable(el) {
    let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'TABLE') n = n.parentNode;
    return (n && n.tagName === 'TABLE') ? n : null;
  }

  /* ================================ K74 · 抓取范围（分层） ================================
   * 用户症状：命中在**嵌套表格的内层**时什么都抓不到（旧实现只取 `nearestTable` ＝最内层），
   * 面板因此分成两张卡（内层那张没有抓取值）。
   * 口径（§四）：按 `fetchScope` 决定抓哪一层；**所有层**都"命中所在那一行优先，找不到再整表找第一个"。
   * 组合词的**定位**一行不动（`combo.js` / `cells.js` 不碰）—— 本轮只改抓取与取图的层级。
   */

  /** fetchScope 的唯一归一在 `KH.Config.normalizeFetchScope`（读/写/消费三处同一个函数） */
  function scopeOf(v) { return KH.Config.normalizeFetchScope(v); }

  /** 从 `'labels'` / `{fetchLabels}` / `{meta:{fetchLabels,fetchScope}}` / CompiledRule 里取 scope */
  function scopeFromArg(v) {
    if (v == null || typeof v === 'string') return undefined;
    if (v.meta && v.meta.fetchScope !== undefined) return v.meta.fetchScope;
    if (v.fetchScope !== undefined) return v.fetchScope;
    return undefined;
  }

  /** 该格在**指定层**表格里所在的行；不在这一层就继续往上找（外层行） */
  function hitRowIn(table, cell) {
    let el = cell;
    while (el) {
      if (el.nodeType === 1 && el.tagName === 'TR' && nearestTable(el.parentNode) === table) return el;
      if (el === table) break;
      el = el.parentNode;
    }
    return null;
  }

  /**
   * 本层表格**自己**的格子 / 行 —— 必须排除嵌套表格里的那些。
   * 为什么单列这两个函数：`table.querySelectorAll('td, th')` 会把内层表格的格子一起捞出来，
   * 在外层找标签时就可能命中"内层那个同名列"，层级语义直接失效。
   */
  function ownCellsOf(table) {
    const all = table.querySelectorAll('td, th');
    const out = [];
    for (let i = 0; i < all.length; i++) if (nearestTable(all[i].parentNode) === table) out.push(all[i]);
    return out;
  }
  function ownCellsIn(row, table) {
    const all = row.querySelectorAll('td, th');
    const out = [];
    for (let i = 0; i < all.length; i++) if (nearestTable(all[i].parentNode) === table) out.push(all[i]);
    return out;
  }
  function ownRowsOf(table) {
    const all = table.querySelectorAll('tr');
    const out = [];
    for (let i = 0; i < all.length; i++) if (nearestTable(all[i].parentNode) === table) out.push(all[i]);
    return out;
  }

  /** 同表里「文本 == 标签」的格子。唯一实现，抓取内容与只读访问口共用。
   *  K74 起只在本层**自己的**格子里找（见 `ownCellsOf`）；`row` 给了就先在这一行里找。 */
  function findLabelCell(table, label) {
    if (!table || !label) return null;
    const cells = ownCellsOf(table);
    for (let i = 0; i < cells.length; i++) {
      if ((cells[i].textContent || '').trim() === label) return cells[i];
    }
    return null;
  }

  /**
   * 分层找标签格（§四.2）：**该层表格里包含命中的那一行优先**，该行没有才退回"整表找第一个"。
   * 为什么必须留整表兜底：标签写在表头行 / 单独一行是**常见形状**
   * （`_e2e/fixtures/deep.html` 的 Z 组：标签在 1~2 行、命中在第 3 行），只认命中行会把这类用法砸掉。
   * 整表兜底的结果与"命中的是哪一行"**无关** ⇒ 可按 (层表格, scope, label) 在 box 里缓存，
   * 于是"行级优先"带来的额外开销只是每行一次**行内**扫描（小常数），不是每行一次全表扫描。
   */
  function findLabelCellLayered(table, cell, label, scope, box) {
    const row = hitRowIn(table, cell);
    if (row) {
      const own = ownCellsIn(row, table);
      for (let i = 0; i < own.length; i++) {
        if ((own[i].textContent || '').trim() === label) return { cell: own[i], fromRow: true };
      }
    }
    const k = String(scope) + '\u0001' + label;
    const store = box && box.cells;
    if (store) {
      let per = store.get(table);
      if (!per) { per = new Map(); store.set(table, per); }
      if (per.has(k)) return per.get(k);
      const found = { cell: findLabelCell(table, label), fromRow: false };
      per.set(k, found);
      return found;
    }
    return { cell: findLabelCell(table, label), fromRow: false };
  }

  /* ---- K79：三个方向的层级展开（当前层 / 内层 / 外层），用户 2026-09-23 定义 ---- */

  /** 当前层这张表里**嵌着的表**（任意单元格、任意深度；DOM 顺序）——「内层」方向 */
  function innerTablesOf(table) {
    const out = [];
    if (!table || !table.querySelectorAll) return out;
    const all = table.querySelectorAll('table');
    for (let i = 0; i < all.length; i++) if (all[i] !== table) out.push(all[i]);
    return out;
  }

  /** 当前层的**祖先表**（由近到远）——「外层」方向 */
  function outerTablesOf(table) {
    const out = [];
    let el = table && table.parentNode;
    while (el) {
      if (el.nodeType === 1 && el.tagName === 'TABLE') out.push(el);
      el = el.parentNode;
    }
    return out;
  }

  /** 按选中的方向展开成**有序层列表**：内层 → 当前层 → 外层 */
  function layersFor(cell, dirs) {
    const anchor = nearestTable(cell);
    if (!anchor) return null;
    const out = [];
    if (dirs.indexOf('inner') >= 0) innerTablesOf(anchor).forEach((t, i) => out.push({ table: t, dir: 'inner', idx: i }));
    if (dirs.indexOf('self') >= 0) out.push({ table: anchor, dir: 'self', idx: 0 });
    if (dirs.indexOf('outer') >= 0) outerTablesOf(anchor).forEach((t, i) => out.push({ table: t, dir: 'outer', idx: i }));
    return out;
  }

  /**
   * 把 items 解析成 `[{ item, label, table, cell, dir, idx, fromRow }]`
   * （`dir` = `'inner' | 'self' | 'outer'`，`idx` = 该方向内序号）。
   * 旧值 `auto` 由 `fetchScopeSpec().nearestOnly` 表达：**就近优先、只取第一层命中的**。
   * 返回 `null` ＝没有真表格（调用方走假表格路径）。
   */
  function resolveLayerCells(cell, items, scope, box) {
    const spec = (KH.Config && typeof KH.Config.fetchScopeSpec === 'function')
      ? KH.Config.fetchScopeSpec(scope)
      : { dirs: ['self'], nearestOnly: false };
    const layers = layersFor(cell, spec.dirs);
    if (!layers) return null;
    /* ⚠️ 选了某个方向、但这张表**没有那一层**时（典型：只勾「外层」而这张表就是最外层；
     * 存量 `outer1` / `outermost` 都映射到 `outer`）⇒ **回落当前层，绝不允许变空** ——
     * 这是 K74 就立下的承诺（"没有外层时等同本层"），R4 当年专门有一条用例守着（"不许变空"）。 */
    const use = layers.length ? layers : [{ table: nearestTable(cell), dir: 'self', idx: 0 }];
    const picked = [];
    for (const item of items) {
      for (const L of use) {
        const hit = findLabelCellLayered(L.table, cell, item.label, scope, box);
        if (!hit.cell) continue;
        picked.push({ item, label: item.label, table: L.table, cell: hit.cell, dir: L.dir, idx: L.idx, fromRow: hit.fromRow });
        if (spec.nearestOnly) break;               // 旧 auto：就近命中一层就停
      }
    }
    return picked;
  }

  /** 右邻格（**不跳空格**：值本身就是图时，会跳空格的 `nextCell` 会把它跳过） */
  function rightCellOf(labelCell) {
    const Cells = KH.Cells;
    const raw = (Cells && typeof Cells.nextCellRaw === 'function') ? Cells.nextCellRaw(labelCell) : null;
    if (raw) return raw;
    const nx = labelCell && labelCell.nextElementSibling;
    return (nx && nx.nodeType === 1) ? nx : null;
  }

  /**
   * 某标签格的**值格**（用户确认的新语法：`@表达式` 与关键词的 `cellOffset` 同语法）。
   *
   * @returns {{cells:Element[], byOffset:boolean, invalid:boolean}}
   *   · 有 `@表达式` 且**能解析、至少取到一格** → 那些格（视觉列序、去重），`byOffset:true`；
   *   · 表达式非法 / 越界 → **回退右邻格**（用户口径：不得报错、不得变空值），`invalid:true`；
   *   · 没写表达式 → 右邻格（历史行为）。
   */
  function valueCellsOf(labelCell, item) {
    const spec = item && item.offset;
    if (spec) {
      const Cells = KH.Cells;
      if (Cells && typeof Cells.cellsAtOffsets === 'function') {
        const picked = Cells.cellsAtOffsets(labelCell, spec);
        if (picked && picked.ok) return { cells: picked.cells, byOffset: true, invalid: false };
        const one = rightCellOf(labelCell);
        return { cells: one ? [one] : [], byOffset: false, invalid: true };
      }
    }
    const one = rightCellOf(labelCell);
    return { cells: one ? [one] : [], byOffset: false, invalid: false };
  }

  /** 把一组值格的文本按视觉列顺序**只用非空**的拼接（多格文本字段：`\n` 分隔） */
  function textOfCells(cells) {
    const parts = [];
    for (const c of (cells || [])) {
      const t = cellVisualText(c);
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }

  /** 一组格子里的 `<img>`（按格子顺序、再去重——同一格里的图只算一次） */
  function imgsOfCells(cells) {
    const out = [];
    const seen = new Set();
    for (const c of (cells || [])) {
      if (!c || typeof c.querySelectorAll !== 'function') continue;
      for (const im of c.querySelectorAll('img')) {
        if (seen.has(im)) continue;
        /* K79：值格里**嵌表**里的图不算这个字段的图 —— 与文字同一口径
         * （值格自己的内容才是这个字段的值；嵌表的内容只从「内层」方向读）。
         * 判据用 `insideNestedTable(im, c)`：从图往上走，先遇到 `<table>` 就是嵌表里的图。 */
        if (insideNestedTable(im, c)) continue;
        seen.add(im);
        out.push(im);
      }
    }
    return out;
  }

  /** 命中/格子的**定位格**：命中文本节点 → 所在 td/th（假表格 → 最近的格子元素） */
  function anchorCellOf(hitOrCell) {
    if (!hitOrCell) return null;
    if (hitOrCell.anchorCell && hitOrCell.anchorCell.nodeType === 1) return hitOrCell.anchorCell;
    /* 图片识别的锚点对象是 `{ rule, cell }`（见 img-ocr 的 anchorsFor），也要能直接喂进来 */
    if (hitOrCell.cell && hitOrCell.cell.nodeType === 1) return hitOrCell.cell;
    const n = hitOrCell.textNode || hitOrCell.node || hitOrCell;
    if (!n || !n.nodeType) return null;
    if (n.nodeType === 1) return (n.closest ? (n.closest('td,th') || n) : n);
    const el = n.parentElement;
    if (!el) return null;
    const Cells = KH.Cells;
    if (Cells && typeof Cells.cellOf === 'function') {
      try { const c = Cells.cellOf(n, null); if (c) return c; } catch (e) { /* 落回下面的兜底 */ }
    }
    if (el.closest) { const td = el.closest('td,th'); if (td) return td; }
    return el;
  }

  /** 从参数里取 labels 原文：`'标签串'` / `{fetchLabels}` / `CompiledRule`（`rule.meta.fetchLabels`）都认 */
  function labelsFromArg(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (v.meta && v.meta.fetchLabels !== undefined) return String(v.meta.fetchLabels == null ? '' : v.meta.fetchLabels);
    if (v.fetchLabels !== undefined) return String(v.fetchLabels == null ? '' : v.fetchLabels);
    return '';
  }

  /**
   * **只读访问口**：某一次命中（或某个格子）所在表里，各「抓取后续字段」的**值格**与其中的图片。
   *
   * 用途：图片识别（`img-ocr.js`）取图**以抓取字段为准**（用户确认的第 3 条）——
   * 不管字段有没有 `#图` 修饰，都要把这些值格里的图全部拿去做 OCR。
   * 值格指向走 `@表达式`（见 `valueCellsOf`）；**本函数不改任何抓取内容的语义**
   * （`#图` / `#N` / 跨格累计 / 去重仍在 `rowsToTableHtml` + `applyImgPolicy` 里）。
   *
   * @param {Text|Element|object} hitOrCell 命中文本节点 / 格子元素 / 命中记录（带 `textNode`）/ 锚点（带 `anchorCell`）
   * @param {string|object} [cfgOrLabels] labels 原文，或带 `fetchLabels` / `meta.fetchScope` 的配置/编译结果
   * @param {object} [box] 同一轮重建内复用的缓存盒（见 `blockFor`；不传就逐次计算）
   * @returns {Array<{label:string, cells:Element[], imgs:Element[], byOffset:boolean, invalid:boolean, noImg:boolean}>}（noImg = 该字段写了 `#0`，不要图）
   */
  function cellsForHit(hitOrCell, cfgOrLabels, box) {
    const items = parseLabels(labelsFromArg(cfgOrLabels));
    const out = [];
    if (!items.length) return out;
    const cell = anchorCellOf(hitOrCell);
    if (!cell) return out;
    const sc = scopeOf(scopeFromArg(cfgOrLabels));
    const table = nearestTable(cell);
    if (!table) {
      /* 假表格（无真 `<table>`）：层级概念不成立，维持既有行为（§二） */
      for (const item of items) {
        const target = findLabelElInScope(cell, item.label);
        if (!target) continue;
        const picked = valueCellsOf(target, item);
        out.push({
          label: item.label, cells: picked.cells, imgs: imgsOfCells(picked.cells),
          byOffset: picked.byOffset, invalid: picked.invalid || !!item.offsetInvalid,
          noImg: !!item.noImg
        });
      }
      return out;
    }
    /* 分层口径与 `extractFor` **同一份实现**（`resolveLayerCells`）——
     * 图片识别因此自动与"你选的抓取层级"同源（§四.5）；`all` 下各层值格的图都进来，
     * 去重交给下游（img-ocr 按 URL / 元素去重）。 */
    const picked = resolveLayerCells(cell, items, sc, box) || [];
    for (const p of picked) {
      const v = valueCellsOf(p.cell, p.item);
      out.push({
        label: p.label, cells: v.cells, imgs: imgsOfCells(v.cells),
        byOffset: v.byOffset, invalid: v.invalid || !!p.item.offsetInvalid,
        noImg: !!p.item.noImg
      });
    }
    return out;
  }

  /** 假表格（无 `<table>`）：在**命中那一行**里找"文本 == 标签"的**直接子节点**
   *  （K75：不再向上越界到 body；也不再把"命中节点的父元素"当入口 —— 见 `findFakeLabelInRow`） */
  function findLabelElInScope(cell, label) {
    const found = findFakeLabelInRow(cell, label);
    return found ? found.labelEl : null;
  }

  /** 逐项取「值」（`@表达式` / `#1` 简单模式 / 右邻整块）—— `extractFor` 的唯一实现。
   *  `fromRow`：标签格是否取自"命中所在那一行"（决定要不要在重复标签处收尾，见 `collectRightBlock`）。 */
  function rowsForItem(item, target, table, fromRow, box, labels) {
    let rows = null;
    let usedOffset = false;
    /* 值格指向（`@表达式`）：合法且取到格 → 按视觉列序取那些格；
     * 文本多格用 `\n` 拼接（渲染侧再按行拆开），图片随之进入 applyImgPolicy 的 `#图`/`#N` 口径。
     * 表达式非法/越界 → **按"没写表达式"处理**（下面的既有分支），不报错、不变空值。 */
    if (item.offset) {
      const picked = valueCellsOf(target, item);
      if (picked.byOffset) {
        usedOffset = true;
        const t = textOfCells(picked.cells);
        if (t) rows = [[{ t: t, rs: 1, cs: 1 }]];
      }
    }
    if (!usedOffset) {
      if (item.simple) {
        // 简单模式：取标签行右侧相邻第一个单元格（跳过按钮、合并同格多子元素文本）
        const tr = target.parentElement;
        const right = tr && tr.cells ? tr.cells[target.cellIndex + 1] : null;
        if (right) {
          const val = cellText(right, true);
          if (val) rows = [[{ t: val, rs: 1, cs: 1 }]];
        }
      } else {
        rows = collectRightBlock(target, table, {
          stopAtRepeatedLabel: !!fromRow,
          box: box,
          labels: labels || null,
          selfLabel: item.label
        });
      }
    }
    /* `!` 去空白 / `^` 锚点截取 / `%` 字符截取：无论来自 @偏移、#1 简单模式还是整块，统一在取值出口做修饰 */
    if (rows && (item.stripSpace || item.anchor || item.sliceSpec)) rows = transformRows(rows, item);
    return rows;
  }

  /* ---- 多层的合并规则（K79 三方向：内层 → 当前层 → 外层） ---- */

  /** 层级后缀：内层 / 内n层、本层、外层 / 外n层 */
  function layerSuffix(dir, idx) {
    if (dir === 'inner') return (idx === 0) ? '（内层）' : ('（内' + (idx + 1) + '层）');
    if (dir === 'outer') return (idx === 0) ? '（外层）' : ('（外' + (idx + 1) + '层）');
    return '（本层）';
  }
  /** 层的排序：内层 → 当前层 → 外层（同方向内按 idx） */
  const LAYER_RANK = { inner: 0, self: 1, outer: 2 };
  const layerOrder = (e) => (LAYER_RANK[e.dir] == null ? 1 : LAYER_RANK[e.dir]) * 100 + (e.idx || 0);
  /** rows 的规范化文本（用来判"同名标签在两层取到的值是否相同"） */
  function rowsText(rows) {
    return (rows || []).map(r => (r || []).map(c => String(c && c.t != null ? c.t : '')).join('\u0001')).join('\u0002');
  }
  /**
   * 多层的合并：**同名标签值相同 → 只留最内层那一份**（不重复展示）；
   * **值不同 → 两份都留并加层级后缀**（内层/本层/外层…）。顺序＝标签声明顺序，同一标签内按 `layerOrder`。
   * 没有同名冲突的标签**不加后缀**（多数卡片保持干净）。
   */
  function mergeAllLayers(entries) {
    const byLabel = new Map();
    for (const e of entries) {
      if (!byLabel.has(e.label)) byLabel.set(e.label, []);
      byLabel.get(e.label).push(e);
    }
    const out = [];
    for (const [label, list] of byLabel) {
      list.sort((a, b) => layerOrder(a) - layerOrder(b));
      const uniq = [];
      const seen = new Set();
      for (const e of list) {
        const t = rowsText(e.rows);
        if (seen.has(t)) continue;
        seen.add(t);
        uniq.push(e);
      }
      if (uniq.length === 1) out.push({ label: label, rows: uniq[0].rows });
      else uniq.forEach(e => out.push({ label: label + layerSuffix(e.dir, e.idx), rows: e.rows }));
    }
    return out;
  }

  /**
   * 抓取命中所在（按 fetchScope 选定的）层级里 fetchLabels 各标签对应的值。
   * @param {Text} textNode 命中文本节点（定位层级 / 行）
   * @param {string} rawLabels fetchLabels 原文
   * @param {string} [scope] fetchScope（缺省 `'auto'`）
   * @param {object} [box] 同一轮重建内复用的缓存盒（`{html, cells}`，见 `blockFor`）
   * @returns {Array<{label:string, rows:Array<Array<{t:string,rs:number,cs:number}>>}>}
   */
  function extractFor(textNode, rawLabels, scope, box) {
    const items = parseLabels(rawLabels);
    if (!items.length || !textNode) return [];
    const sc = scopeOf(scope);
    const table = nearestTable(textNode.parentNode);
    if (!table) {
      return extractFromFakeTable(textNode.parentElement, items);
    }
    const cell = anchorCellOf(textNode) || textNode.parentElement;
    const picked = cell ? resolveLayerCells(cell, items, sc, box) : null;
    if (!picked || !picked.length) return [];

    const entries = [];
    /* 【2.0.6.3 需求⑥】把本卡所有字段名带下去：右侧取值遇到「另一个字段名整格」就收尾。 */
    const allLabels = items.map((it) => it.label);
    for (const p of picked) {
      const rows = rowsForItem(p.item, p.cell, p.table, p.fromRow, box, allLabels);
      if (rows && rows.length) entries.push({ label: p.label, dir: p.dir, idx: p.idx, rows: rows });
    }
    /* K79：多选（当前层 + 内层 / 外层…）时**一律合并**（同名同值去重、值不同加层级后缀）；
     * 只选一层时合并是**恒等变换**（不加后缀）⇒ 单层行为与 K74 完全一致。 */
    return mergeAllLayers(entries);
  }

  /* ------------------------------------------------- 多行表格渲染（唯一实现） */

  /** 缩略图 → 占位小牌（2.0.19.1）：只认 `restoreImgs` 生成的固定形状（src/alt 均已转义）。
   *  `data-khimg` / `data-khimg-name` 是面板点击委托的唯一约定（和 `data-khpdf` 同一思路）。 */
  function imgToPlaceholder(html) {
    return String(html).replace(
      /<img src="([^"]*)" alt="([^"]*)" loading="lazy">/g,
      (m, src, alt) => {
        const name = alt && alt.trim() ? alt : '';
        /* 【2.0.19.9 · 用户 m05814】两个问题一起解：
         *  ① 太宽 —— 文件名会把占位撑成小胶囊；现在牌面只有一个图标（图标由 CSS ::before 画）。
         *  ② 勾了占位后 OCR 命中/比对失效 —— 牌面原来写着「🖼 文件名」，那是**真实文本**，
         *     任何读表格文字的环节（比对基准、进表取值）都会把它当成字段值 ⇒ 永远对不上。
         *     现在元素文本**留空**（等同「这张图没有文字」，与占位前的语义一致），
         *     文件名只放 title 与 data-khimg-name（悬停/灯箱照旧看得到）。 */
        return '<span class="khin-imgph" data-khimg="' + src + '" data-khimg-name="' + alt + '"'
          + ' title="' + (name || '图片') + '"></span>';
      }
    );
  }

  const escHtml = (s) => {
    const d = document.createElement('div');
    d.textContent = (s == null ? '' : String(s));
    return restoreImgs(d.innerHTML);
  };
  const trimSp = (s) => String(s).replace(/^[ \u3000]+|[ \u3000]+$/g, '');

  /** 固定标题词识别（双通道之一）：整行等于 / 以「标题词 + 空白」开头 */
  function knownTitle(s) {
    const t = String(s).trim();
    for (const k of GROUP_TITLES) {
      if (t === k) return k;
      if (t.indexOf(k) === 0 && /[ \u3000]/.test(t.charAt(k.length) || ' ')) return k;
    }
    return null;
  }
  const NUM_RE = /^\s*\d+[、.．:：]\s*/;

  /**
   * 解析一个块的文本行为「一级分组 + 二级标题」两级结构（旧版 v1.6.44 + v1.7.4）。
   * 标题行识别双通道：① 含 tab 的行 = 标题 + 内容；② 匹配固定标题词的行。
   * 编号行（`1、 xxx`）不识别为分组标题。与左列标签同名的行视为网页重复标题，只保留其后内容。
   */
  function parseBlock(textLines, label) {
    const blocks = [];
    let curBlock = null;
    let curSub = null;
    const ensureBlock = (g) => { const b = { gtitle: g, subs: [] }; blocks.push(b); return b; };

    for (let i = 0; i < textLines.length; i++) {
      const ln = textLines[i];
      const ti = ln.indexOf('\t');
      if (ti >= 0) {
        const title = trimSp(ln.slice(0, ti));
        const rest = trimSp(ln.slice(ti + 1));
        if (label != null && title === String(label)) {
          if (!curBlock) curBlock = ensureBlock(null);
          if (rest) {
            if (!curSub) { curSub = { title: null, lines: [] }; curBlock.subs.push(curSub); }
            curSub.lines.push(rest);
          }
          continue;
        }
        curSub = { title, lines: rest ? [rest] : [] };
        if (!curBlock) curBlock = ensureBlock(null);
        curBlock.subs.push(curSub);
        continue;
      }
      if (label != null && ln === String(label)) continue;
      /**
       * **固定标题词必须无条件下判**（不能受"下一行是否含 tab"的启发式约束）。
       * 实测（用户真实样例）：`运营备注` 下面紧跟的是**纯文本行**（如"请修改。"），
       * 不含 tab；若把 knownTitle 放到 lookahead 条件之后，这一行会被当成**内容**，
       * 于是既丢了子标题、又把子标题文字混进上一段内容里。
       */
      const kt = knownTitle(ln);
      if (kt) {
        const rest = trimSp(ln.slice(kt.length));
        curSub = { title: kt, lines: rest ? [rest] : [] };
        if (!curBlock) curBlock = ensureBlock(null);
        curBlock.subs.push(curSub);
      } else if (!NUM_RE.test(ln) && i + 1 < textLines.length &&
                 (textLines[i + 1].indexOf('\t') >= 0 || knownTitle(textLines[i + 1]) !== null)) {
        curBlock = ensureBlock(ln);   // 一级分组标题行（如「32位包:」）
        curSub = null;
      } else {
        if (!curBlock) curBlock = ensureBlock(null);
        if (!curSub) { curSub = { title: null, lines: [] }; curBlock.subs.push(curSub); }
        curSub.lines.push(ln);
      }
    }
    return blocks
      .map(b => ({ gtitle: b.gtitle, subs: b.subs.filter(s => s.lines.length > 0) }))
      .filter(b => b.subs.length > 0);
  }

  /**
   * 多块合并渲染成**一个** `<table class="kh-table kh-table-fetch">`（旧版 `_rowsToTableMulti`，v1.7.6）。
   * 多字段合并为同一张表的多行展示，不拆成多个独立小表；
   * 每个 label 作为左列独立一块（rowspan = 该块行数）；真实多列格保留 rowspan/colspan。
   * 返回 HTML 字符串（供重要笔记面板 / 备注卡片插入）。
   *
   * 【为什么带 `kh-table-fetch` 这个标记类】本表**没有表头行**：第一行就是数据
   * （`[字段 label][二级标题/分组标题][内容]`）。而 Markdown / 富文本表格的第一行**是**表头。
   * 两者共用 `.kh-table` 时，`.kh-table tr:first-child td` 那条"首行当表头"的着色规则
   * 会把「基本信息 / 驳回字段：X / 32位包:」也刷上底色（用户反馈："每列第一个单元格都标了底色"）。
   * 因此用标记类把两类表分开，只给**字段 label 格**上色。
   */
  function rowsToTableHtml(multi, opts) {
    /* 【2.0.19.2 · m02412 需求①】「展示字数」：这条规则填了 N（1–200）⇒ 卡片里的值只显示前 N 个字
     * 加省略号、并且单行（与 `~` 后缀同一套裁切样式），悬停 title 仍是全文、复制/进表也是全文。
     * 填 0 / 缺键 = 不按字数裁，沿用原来的自适应一行。 */
    /* 【2.0.19.3 · m03229 ③】展示字数改成**字段级**（`~N` 后缀），关键词级的 `valueChars` 只留作兼容兜底。 */
    const limG = Math.max(0, Math.min(200, Math.round(Number(opts && opts.valueChars) || 0)));
    const limOf = (it) => {
      const n = Math.max(0, Math.min(200, Math.round(Number(it && it.opt && it.opt.clipChars) || 0)));
      return n || limG;
    };
    const items = (multi || []).map((m) => {
      const opt = m.opt || null;                 // 该字段的图片选项（仅图片 / 前 N 张）
      const budget = { n: 0 };                   // "前 N 张"是**整字段**的前 N 张（跨单元格累计）
      const textLines = [];
      let grid = false;
      for (const line of m.rows || []) {
        if (line.length === 1 && /[\r\n]/.test(line[0].t)) {
          const parts = String(applyImgPolicy(line[0].t, opt, budget)).split(/\r?\n/).map(trimSp).filter(Boolean);
          textLines.push.apply(textLines, parts);
        } else if (line.length === 1) {
          const one = trimSp(applyImgPolicy(line[0].t, opt, budget));
          if (one) textLines.push(one);
        } else {
          grid = true;
        }
      }
      return { label: m.label, textLines, grid, rows: m.rows || [], opt: opt, budget: budget, ocr: !!m.ocr };
    });

    /* 【2.0.2.17 需求②】同一张卡片（同一块）里，**内容完全一致**的字段合并成一列：
     * 标签用 `/` 连接（`应用功能类型/资质类型`），值只写一遍。
     * 判据用渲染输入里的**内容**，不猜标签、也不做模糊归一：值不同 ⇒ 不合并。
     * ⚠️ 签名**不能**直接 `JSON.stringify([rows, opt])`（2.0.2.18 修的）：`opt` 是字段级选项
     * 对象，里面带 `label`（每个字段都不同）⇒ 真机里任何两个字段的签名都不相等，合并永远
     * 不触发（单测当时喂的是 `opt:null`，所以没抓到）。同理 `rows` 里的 `rs/cs` 是排版提示，
     * 相同内容在 grid 分支会被加上，也不该参与比较。 */
    /* 【2.0.6.2 需求③】空格必须**不参与**比较：抓取值来自 `cellVisualText`（多段用空格拼），
     * OCR 值来自引擎的 `joinParts`（字距一宽就插空格）——`A公司` 与 `A 公司` 是同一个值，
     * 按原样比就永远合不上，这正是用户看到的「OCR 行和抓取行同值却不合并」。
     * 只压空白，不做别的模糊归一（大小写/标点仍算不同）：归一过度会把真不同的值并成一条。 */
    /* 【2.0.8.18】签字口径收敛到 `KH.TextNorm.stripWs`（全工程唯一实现）：
     * 这里只要"压掉空白"，不要大小写/全半角折叠 —— 合并签名与"值一致判定"是两件事，
     * 后者由 `KH.TextNorm.verdict` 负责（会区分 fold-ws / fold-width / fold-case）。
     * 分开的原因：签名只回答"能不能并成一条"，把 `ABC` 与 `abc` 也并掉会改变既有版面。 */
    const squashVal = (v) => KH.TextNorm.stripWs(v);
    const contentOf = (it) => (it.rows || []).map((line) => (line || []).map((c) => squashVal(c && c.t)));
    const imgPolicyOf = (opt) => [!!(opt && opt.imgOnly), (opt && opt.imgLimit) || 0, !!(opt && opt.noImg), (opt && opt.imgPick || []).join(',')];
    const sigOf = (it) => JSON.stringify([contentOf(it), it.ocr ? 'ocr' : imgPolicyOf(it.opt)]);
    const contentSigOf = (it) => JSON.stringify(contentOf(it));
    /* 合并后的字段名用 `\u0001` 当分隔符（不落进笔记 HTML）：用户自己的字段名里可能带 `/`，
     * 用 `/` 拼再按 `/` 切就会把「运营/商务」误认成两个合并字段、抬头只显示「商务」（2.0.6.2 需求⑦）。 */
    const LBL_SEP = '\u0001';
    const bySig = new Map();
    const byContent = new Map();
    const merged = [];
    for (const it of items) {
      const sig = sigOf(it);
      const csig = contentSigOf(it);
      let prev = bySig.get(sig);
      /* 【2.0.6.2 需求③】OCR 行没有"图片策略"可言（`opt:null`），严格签名永远对不上抓取字段
       * ⇒ 只要**有一侧是 OCR 行**、内容（压掉空白后）相同就合并。两条都是抓取字段时仍按严格签名比
       * （`#图` 与普通字段的图片语义不能被吞掉）。 */
      if (!prev) {
        const cand = byContent.get(csig);
        if (cand && (it.ocr || cand.ocr)) prev = cand;
      }
      if (prev) {
        /* 【2.0.2.19 需求②】OCR 行与抓取字段同值合并时，**图上原件里的字段名排前面**：
         * 用户口径「抓取 `员工名字|张三`」+「图里 `姓名|张三`」⇒「`姓名/员工名字` | 张三」——
         * 证件/截图上的叫法才是这条信息的本名，抓取别名是页面自己的说法。
         * 两条都是 OCR 行时保持"先见者在先"（同一批识别结果，没有谁更权威）。 */
        prev.label = (it.ocr && !prev.ocr) ? (it.label + LBL_SEP + prev.label) : (prev.label + LBL_SEP + it.label);
        if (!prev.ocr) prev.ocr = !!it.ocr;
        continue;
      }
      bySig.set(sig, it);
      if (!byContent.has(csig)) byContent.set(csig, it);
      merged.push(it);
    }

    /* 【2.0.2.17 需求①】字段名格**只放名字**：后缀（`#图3` / `#0` / `!` / `^高价` / `%4` …）是抓取口径，
     * 属于设置页的事；塞进笔记里既占宽度又要用户去猜。编辑器的胶囊预览里照旧看得到后缀。
     * 过长省略仍由 `.kh-lbt`（max-width + ellipsis）负责，悬停的 `title` 带完整标签。 */
    /* 【2.0.6.1 需求⑥】合并出来的 `开发者/核准主体名称/著作权人` 太占地方：**抬头只写最短的那个**，
     * 后面跟一个聚合数量，点数量展开看全部（`<details>` 原生就能展开，不用挂 JS，笔记 HTML 存进卡片也照样工作）。
     * 单个字段名（没有 `/`）一个字都不改，老笔记的 `.kh-lbt` 包裹逻辑也不受影响。 */
    const labelCellHtml = (label) => {
      const parts = String(label == null ? '' : label).split(LBL_SEP).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) return escHtml(label);
      let best = parts[0];
      for (const p of parts) if (p.length < best.length) best = p;
      return '<span class="kh-lbt" title="' + escHtml(parts.join('/')) + '">' + escHtml(best) + '</span>'
        + '<details class="kh-table-more"><summary title="共 ' + parts.length + ' 个字段名，点开看全部">'
        + parts.length + '</summary><div class="kh-table-all">' + parts.map(escHtml).join('<br>') + '</div></details>';
    };
    const labelHtml = (it, attrs) => '<td class="kh-table-label"' + (attrs || '') + '>' + labelCellHtml(it.label) + '</td>';

    /* 【v2.0.1.15 需求 2 · 外壳由内容构造】本函数返回 `''` = 有行但**有效值全空**
     * （值 `trim` 后为空即视为空 ⇒ 值不显示、字段名也不显示，整块不渲染）。
     * 判定点**唯一**：每个字段先渲进局部 `buf` + 局部 `anyVal`，出块前 `if (!anyVal) continue;`。
     * 空卡片两种形态都在此收口：① 文本分支的空壳表（原先两条 continue 后仍拼 `</table>`）；
     * ② grid 分支的「有 label 表头 + 空 `<td>`」（原先根本没有字段级判空）。
     * ⚠️ 判空**不许**二次调用 `applyImgPolicy`（`it.budget` 跨格累计有状态，跑两遍会吃掉「前 N 张」预算）。 */
    /* 【2.0.8.8 需求④】内容格「不完整展示」（后缀 `~`）：**只裁显示**，抓到的值一个字不改。
     * 必须多包一层 div：直接对 `td` 用 max-height / line-clamp 在真浏览器里不生效
     * （表格单元格的 display 被规整成 table-cell，clamp 只认 -webkit-box 子元素）。
     * 悬停 `title` 给全文（去掉图片占位符、空白折成一格，避免多行塞进属性）。 */
    const clipOn = (it) => !!(limOf(it) > 0 || (it && it.opt && it.opt.clip));
    /* 【2.0.8.12 需求①】`*`：把这一格的内容做成超链接。两条路径：
     *  ① 值本身是 http(s) 网址 → 直接当 href；
     *  ② 写了模板（`*https://x/?q={v}`）→ 用 URL 编码后的值替换 `{v}`。
     * 其余情况（不是网址、也没模板、值里带图片占位符）**照原样显示成文字**，绝不生成 href ——
     * 宁可点不动，也不把一段任意网页文字变成可点击的 javascript:/data: 入口。 */
    const hrefOf = (it, raw) => {
      const opt = (it && it.opt) || null;
      if (!opt || !opt.link) return '';
      if (String(raw).indexOf('\u0001KHIMG\u0001') >= 0) return '';
      const v = String(raw == null ? '' : raw).trim();
      if (!v) return '';
      const tpl = String(opt.linkTpl || '').trim();
      const url = tpl ? tpl.split('{v}').join(encodeURIComponent(v)) : v;
      return /^https?:\/\//i.test(url) ? url : '';
    };
    /* 【2.0.16.6】可疑值徽标：只加标记，不动原文。`⚠` 与文案都由调用方（`ocrExtraRows`）带进来，
     * 本文件不写中文 —— 文案唯一真源在 `src/ui/ocr-copy.js`。 */
    const suspectTag = (it) => (it && it.suspect)
      ? '<span class="kh-val-suspect" title="' + escHtml(it.suspectTip || '') + '">⚠</span>'
      : '';
    const valInner = (it, raw) => {
      const href = hrefOf(it, raw);
      const lim = limOf(it);
      /* 展示字数：先把图片占位符压成空白再数字数（占位符是内部标记，不该算进"字数"）。
       * 超了才换成"前 N 字 + …"，并且**丢掉链接/图片**（截断后的残句点开也没用）。 */
      let html = escHtml(raw);
      if (lim > 0) {
        const plain = stripImgPlaceholders(String(raw == null ? '' : raw)).replace(/\s+/g, ' ').trim();
        if (plain.length > lim) html = escHtml(plain.slice(0, lim)) + '…';
      }
      /* 【2.0.19.3 · m03229 ②】`#占` = **这个字段**里的图换成小占位牌（带文件名），点开仍看大图。
       * 只认 escHtml → restoreImgs 产出的固定形状，页面内容不进这条正则。 */
      if (it && it.opt && it.opt.ph) html = imgToPlaceholder(html);
      const body = (href
        ? '<a class="kh-val-link" href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + html + '</a>'
        : html) + suspectTag(it);
      if (!clipOn(it)) return body;
      const full = stripImgPlaceholders(raw).replace(/\s+/g, ' ').trim();
      /* 【2.0.19.8 · 用户 m05608】裁切只影响**看**，不许影响**用**：
       * 值格以后会被 readFields / 比对基准 / 隐私政策链接读取，若它们拿 textContent，
       * 读到的就是「前 N 字 + …」⇒ 政策正文只剩 11 字、链接变成半截 URL 发不出去。
       * 所以把完整值同时写进 data-khfull，读取方优先用它。 */
      return '<div class="kh-val-box" data-khfull="' + escHtml(full) + '" title="' + escHtml(full) + '">' + body + '</div>';
    };
    const valCell = (it, attrs, raw) =>
      '<td' + (attrs || '') + (clipOn(it) ? ' class="kh-val-clip"' : '') + '>' + valInner(it, raw) + '</td>';

    let body = '';
    for (const it of merged) {
      if (it.grid) {
        const total = it.rows.length;
        /* 该字段里是否有图片：决定"纯数字格"要不要当噪音去掉（见下） */
        const fieldHasImg = (it.rows || []).some((line) => line.some((c) => String(c.t).indexOf('\u0001KHIMG\u0001') >= 0));
        let firstInBlock = true;
        let buf = '';
        let anyVal = false;
        for (const line of it.rows) {
          let cells = '';
          for (const c of line) {
            let attrs = '';
            if (c.rs > 1) attrs += ' rowspan="' + c.rs + '"';
            if (c.cs > 1) attrs += ' colspan="' + c.cs + '"';
            let val = applyImgPolicy(c.t, it.opt, it.budget);
            /* 【图片字段里的"纯数字格"不是内容】用户实测：截图字段的两个版本列里，
             * 历史版本为空的那一格页面写的是计数 `0`，展示出来就是"后面多出一个单独的 0 单元格"。
             * 判据：本字段**别处有图片** + 本格**没有图片** + 本格文字是**纯数字** → 视为计数，留空
             * （留空而不是删格，列才对得齐）。 */
            if (fieldHasImg && !/\u0001KHIMG\u0001/.test(String(c.t)) && /^\s*\d+\s*$/.test(String(c.t))) val = '';
            /* 判空只看**最终写入的 val**（已过 applyImgPolicy + 上面的纯数字抑制）—— 本格只算一次 */
            if (String(val).trim()) anyVal = true;
            cells += valCell(it, attrs, val);
          }
          buf += '<tr>' + (firstInBlock && it.label != null ? labelHtml(it, ' rowspan="' + total + '"') : '') + cells + '</tr>';
          firstInBlock = false;
        }
        /* 值格全空 ⇒ 连 label 表头一起不渲染（空卡片形态②） */
        if (!anyVal) continue;
        body += buf;
        continue;
      }
      /* 文本分支：「值」只认 `s.lines[i]`；`b.gtitle`（一级分组标题）、`label`、`s.title`（二级标题）
       * 都不算值 —— 只有标题没有值的块 = 空字段。原先两条 continue 收敛进下方唯一判定点。 */
      const filled = parseBlock(it.textLines, it.label);

      const blockTotal = filled.reduce(
        (n, b) => n + (b.gtitle != null ? 1 : 0) + b.subs.reduce((m2, s) => m2 + s.lines.length, 0), 0);

      /**
       * 列模型固定 **3 列**：`[本字段 label][二级标题][内容]`（与旧版 1.52.0 `_rowsToTableMulti` 同构）。
       *
       * 【四条规则都是真浏览器量几何 + 展开网格定下来的，走过弯路，记录在此】
       *
       * ① **label 列只在第 1 行出现一次，`rowspan = 本块总行数`**（旧版口径）。
       *    绝不在续行补"空 label 格"：多补一格会把它后面的格子整体右移一列，
       *    实测就是把「理由」挤到最右侧成为独立一列（用户截图圈出的问题）。
       *
       * ② **一级分组标题 `colspan=2`**，跨满 label 之外的整行（= 「二级标题 + 内容」两列），
       *    从而纵向覆盖下方全部子项，渲染成一条分组横条。
       *
       * ③ **二级标题 `rowspan = 该标题下的行数`**，只在首行出现；续行**只写内容格**，
       *    靠 label(①) 与二级标题(③) 两个 rowspan 各占住一列，内容自然落到第 3 列 ——
       *    与首行内容**严格同列**（真浏览器实测：两者左缘都为 [342]，用户要的"填在前面"）。
       *    这里曾经写成"续行补 `<td colspan=2>` 把内容吞进去"，虽然也同列，
       *    但会让表格多出一个 0 宽的幽灵列，且平白多出空格子，已回退到旧版的干净写法。
       *
       * ④ **没有二级标题的子块**：内容格 `colspan=2` 直接占满「二级标题 + 内容」两列，
       *    不留空列、右缘与有标题的行对齐。
       */
      /** label 之外的两列宽度（「二级标题 + 内容」）：一级分组标题与无标题内容格都用它跨满 */
      const afterLabelColspan = 2;
      let labelDone = false;
      /** label 列：只在第 1 行输出一次，rowspan 覆盖整块（其余行为空字符串，不占格） */
      const labelCell = () => {
        if (labelDone) return '';
        labelDone = true;
        const rs = blockTotal > 1 ? ' rowspan="' + blockTotal + '"' : '';
        return labelHtml(it, rs);
      };

      let buf = '';
      let anyVal = false;
      for (const b of filled) {
        if (b.gtitle != null) {
          buf += '<tr>' + labelCell() +
            '<td colspan="' + afterLabelColspan + '">' + escHtml(b.gtitle) + '</td></tr>';
        }

        for (const s of b.subs) {
          const cap = s.title == null ? '' : s.title;
          const n = s.lines.length;
          for (let i = 0; i < n; i++) {
            if (String(s.lines[i]).trim()) anyVal = true;
            if (!cap) {
              // ④ 无二级标题：内容跨「二级标题 + 内容」两列
              buf += '<tr>' + labelCell() +
                valCell(it, ' colspan="' + afterLabelColspan + '"', s.lines[i]) + '</tr>';
            } else if (i === 0) {
              // ③ 首行：二级标题 rowspan + 内容
              buf += '<tr>' + labelCell() +
                '<td rowspan="' + n + '">' + escHtml(cap) + '</td>' + valCell(it, '', s.lines[i]) + '</tr>';
            } else {
              // ③ 续行：只写内容格（第 1、2 列已被两个 rowspan 占住）
              buf += '<tr>' + valCell(it, '', s.lines[i]) + '</tr>';
            }
          }
        }
      }
      /* 无有效值 ⇒ 连 label 一起不渲染（空卡片形态①） */
      if (!anyVal) continue;
      body += buf;
    }
    return body ? '<table class="kh-table kh-table-fetch">' + body + '</table>' : '';
  }

  /** 「标签（内层）/（本层）/（外层）」这类层级后缀剥掉 —— 只用于把 label 映射回它的字段选项。
   *  ⚠️ K79 返工（R4 红牌）：**三个方向的后缀都要认** —— `layerSuffix` 会产出
   *  `（内层）/（内2层）/（本层）/（外层）/（外2层）`，这里漏了「内层/内N层」时，
   *  `截图#图` 这种字段级图片选项在内层那一份上会**被静默丢掉**（`#图` 失效 ⇒ 内表文字漏进卡片）。 */
  function baseLabelOf(label) {
    return String(label == null ? '' : label).replace(/（(?:内层|内\d+层|本层|外层|外\d+层)）$/, '');
  }

  /**
   * 真正算一次（不缓存时走这条）。字段级的图片选项（仅图片 / 前 N 张）按 label 带进渲染。
   * `extras` = 【2.0.2.17 需求⑥】图片 OCR 命中的「键：值」行（`{label, value}`），与抓取字段
   * 并进**同一张表** —— 这样合并（需求②）、裁切、悬停全文全都自动一致，不必给 OCR 行另开一套渲染。
   * 【2.0.2.19 需求②】同值合并走 `rowsToTableHtml` 那一处（唯一实现），这里只把 OCR 行标成
   * `ocr:true` —— 合并时字段名的先后由它决定（见那一处的注释）。
   */
  function computeBlock(textNode, rawLabels, scope, box, extras, opts) {
    const fetched = extractCached(textNode, rawLabels, scope, box);
    /* 【2.0.16.6】`suspect` / `suspectTip` 由 `ocrExtraRows` 挂在行上（非枚举，只在运行期）：
     * 渲染层据此标「⚠」，值本身一个字不改。 */
    const extraItems = (extras || []).map((e) => ({
      label: e && e.label, rows: [[{ t: e && e.value }]], opt: null, ocr: true,
      suspect: !!(e && e.suspect), suspectTip: String((e && e.suspectTip) || '')
    }));
    if (!fetched.length && !extraItems.length) return null;
    const optOf = {};
    for (const it of parseLabels(rawLabels)) optOf[it.label] = it;
    const html = rowsToTableHtml(fetched.map(f => ({
      label: f.label, rows: f.rows,
      /* `all` 下同名标签会带层级后缀 → 先按原样查，再退回"剥掉后缀"查 */
      opt: optOf[f.label] || optOf[baseLabelOf(f.label)]
    })).concat(extraItems), opts);
    /* 【2.0.19.1 · m01400 第 3 条】这条规则选了「图片按占位展示」：把已渲染好的缩略图换成一枚
     * 小占位（带文件名）。只认 `restoreImgs` 产出的那一种固定形状，页面内容不进这条正则。 */
    return html;
  }

  /** 命中格在**根表格**里所在的行号（缓存键的一部分；见 `blockFor`） */
  function rowKeyOf(root, textNode) {
    const cell = anchorCellOf(textNode) || textNode.parentElement;
    const tr = cell ? hitRowIn(root, cell) : null;
    if (!tr) return '-';
    if (typeof tr.rowIndex === 'number') return String(tr.rowIndex);   // 浏览器里 O(1)
    const rows = ownRowsOf(root);                                       // 垫片兜底
    const i = rows.indexOf(tr);
    return i >= 0 ? String(i) : '-';
  }

  /**
   * 命中文本节点所在的**取值根**：最近的表格；假表格 / 裸 div 布局下退到它的父元素。
   * 抽出来只因为同一个取法在 `cacheBox` / `extractCached` / `blockFor` 里逐字抄了三遍（R1-3③）
   * —— 三处的后续判断（拿不到根 ⇒ 退化到无缓存路径）也必须一致，抄一份就差一份。
   */
  function fetchRoot(textNode) {
    return textNode && (nearestTable(textNode.parentNode) || textNode.parentElement);
  }

  /** `cache`（WeakMap<表格根, 盒>）里取/建**同一只**盒；盒里三张表各管一摊。
   *  抓取表格（`html`）与取值（`values`，见 `extractCached`）共用它 ⇒ 不重复取值。 */
  function cacheBox(cache, textNode) {
    const root = fetchRoot(textNode);
    if (!root) return null;
    let box = cache.get(root);
    if (!box || typeof box !== 'object' || !box.html) {
      box = { html: new Map(), values: new Map(), cells: new Map(), span: new Map() };
      cache.set(root, box);
    }
    if (!box.values) box.values = new Map();
    return box;
  }

  /**
   * `extractFor` 的**带缓存**版本：同一轮重建内，同一 `(表格根, 命中行, labels, scope)` 只算一次。
   * 取值是 `collectRightBlock` 级的 DOM 走查 ⇒ 不缓存就等于在同一张表格上重复付开销
   * （`computeBlock` 是它的消费者）。
   * 键与 `blockFor` 的 `html` 键同构（同一个盒、同一套判据），因此两者的"同键必然同值"前提一致。
   */
  function extractCached(textNode, rawLabels, scope, box) {
    if (!box || !textNode) return extractFor(textNode, rawLabels, scope, box);
    const root = fetchRoot(textNode);
    if (!root) return extractFor(textNode, rawLabels, scope, box);
    const k = String(rawLabels == null ? '' : rawLabels) + '\u0001' + scopeOf(scope) + '\u0001' + rowKeyOf(root, textNode);
    if (box.values.has(k)) return box.values.get(k);
    const v = extractFor(textNode, rawLabels, scope, box);
    box.values.set(k, v);
    return v;
  }

  /**
   * 命中 → 抓取渲染片段（供重要笔记条目）。
   * `fetchLabels` 为空 = 不抓（不是"抓全部右列"）；
   * 配了标签但目标为空 → 返回空，**不回退抓标题右格**。
   *
   * 【必须支持"每轮重建复用"】标签格查找是 O(表格单元格数) 的，而它此前被**每一个重要命中**
   * 调用一次 → O(命中数 × 单元格数)：实测 800 行表格（1734 命中）光这一项就要 **31 秒**。
   * cache 由调用方**每轮重建新建**（见 important-note 的 collectEffective），因此不会陈旧。
   *
   * 【K74 §四.8 硬约束：缓存键必须包含"命中所在行"与 scope】加了"命中行优先"之后，
   * **同一张表的不同行可能给出不同结果**，旧的 `(root, labels)` 键会串味。
   * 本实现选 **方案 (a)**：键 ＝ `root + 行号 + labels + scope`（`cache` 是 `WeakMap<root, 盒>`，
   * 盒里 `html` 用这个键）。**为什么仍然正确**：一次结果只由
   * `(根表格, 命中在该表里的行, labels, scope)` 唯一决定 ——
   *   · 同一行里的两个命中：每一层的"命中行"都相同（内层同行 ⇒ 它们必落在外层同一个 `td` 里 ⇒ 外层行也相同），
   *     行内扫描的格子集合也相同 ⇒ 结果逐字相同；
   *   · 不同行 ⇒ 键不同，各算各的。
   * 行级优先的额外开销只是"每行一次**行内**扫描"；"整表找第一个"的兜底结果与行号无关，
   * 因此按 `(层表格, scope, label)` 在 `box.cells` 里再缓存一层 ⇒ 不会退化成每行一次全表扫描。
   * 【性能实测】`_e2e` 的 800 行 / 3000 行重页面预算用例仍绿（见 R3 报告）。
   */
  function blockFor(textNode, rawLabels, cache, scope, extras, opts) {
    const sc = scopeOf(scope);
    /* 【2.0.2.17 需求⑥】带 OCR 附加行时**绕开缓存**：缓存键是 `(表格, 行, labels, scope)`，
     * 而 OCR 行按**命中所属规则**不同而不同 —— 同一格被两个关键词用到会串味。附加行为空时照常吃缓存。 */
    const hasExtra = !!(extras && extras.length);
    if (!cache || !textNode || hasExtra) return computeBlock(textNode, rawLabels, sc, null, extras, opts);
    const root = fetchRoot(textNode);
    if (!root) return computeBlock(textNode, rawLabels, sc, null, extras, opts);
    const box = cacheBox(cache, textNode);
    if (!box) return computeBlock(textNode, rawLabels, sc, null, extras, opts);
    /* 缓存键要带占位开关：同一次重建里两条规则可能共用同一张表、同一组标签，
     * 但一条要占位、一条要缩略图 —— 不带就会串味（后渲染的那条拿到前一条的 HTML）。 */
    const k = String(rawLabels == null ? '' : rawLabels) + '\u0001' + sc + '\u0001'
      + rowKeyOf(root, textNode);
    if (box.html.has(k)) return box.html.get(k);
    const v = computeBlock(textNode, rawLabels, sc, box, extras, opts);
    box.html.set(k, v);
    return v;
  }

  KH.Fetch = {
    GROUP_TITLES, parseLabels, extractFor, extractFromFakeTable, collectRightBlock,
    cellText, cellVisualText, isInteractive, imgPlaceholder, restoreImgs,
    /* PDF 引用识别（2.0.6.5 需求②）：占位符与 DOM 两条路必须用**同一判据**，否则条目与占位
     * 标记对不上号（一个按页面元素建条目、一个按渲染出来的 `data-khpdf` 挂状态）。 */
    pdfRefOf, pdfPlaceholder,
    /* 【2026-11-18 用户口径】没有地址的 PDF 控件：只读判据 + 单测注入口（点一次→抓新标签地址） */
    AUTO_PDF_SEL, autoPdfHostOf, autoPdfControlOf, autoPdfOf, autoPdfKeyOf, autoPdfTokenKey, rememberAutoPdf, absPdfUrl, applyPdfStash,
    rowsToTableHtml, blockFor, triggerOk, fakeRightValue, nearestTable, isPlaceholderText,
    /* 图片选项（仅图片 / 前 N 张）：单测直接锁 */
    applyImgPolicy,
    /** 图片占位符剥离（只留文字）：`#0` 与图片动态关键词的判据比较共用（见 `stripImgPlaceholders`） */
    stripImgPlaceholders,
    /** 图片 + PDF 占位串一起剥（抓取字段取值进比对基准时用；见 `stripAllPlaceholders`） */
    stripAllPlaceholders,
    /** 层级后缀剥离（内层/本层/外层）：把 label 归一到字段名（`computeBlock` 的字段选项与单测用） */
    baseLabelOf,
    /* 「抓取字段的值格（含图）」**只读访问口**（img-ocr 取图用；不改抓取内容语义） */
    cellsForHit, valueCellsOf, splitLabelTokens, findLabelCell,
    /* 【2.0.2.4 需求④】后缀语法的两个只读口子：编辑器（options 页）用它画「字段胶囊」预览 ——
     * options 页**不加载**本文件之外任何抓取实现，语法必须只有这一份，所以直接从这儿取。 */
    parseLabelSpec, suffixTextOf, describeSuffix,
    /* 「原文 → 取到」预览：编辑器不让用户手敲后缀了，结构化设置完要能当场看见取到什么。
     * `modText` 是 `!`/`^`/`%` 的唯一实现（图片选项由 `applyImgPolicy` 管，这里不碰），
     * 所以预览必须走它 —— 界面另写一份就会和真实抓取二次漂移。 */
    previewValue: (t, it) => modText(String(t == null ? '' : t), it)
  };
})();
