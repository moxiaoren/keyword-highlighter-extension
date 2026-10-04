/* ============================================================================
 * src/core/scanner.js · ③Scan + 扩展点② ScannerProbe + 跨节点边界
 * ----------------------------------------------------------------------------
 * 职责：在给定的 root 里遍历文本节点，产出**原始候选命中**（RawHit）。
 *   · 不判断重叠、不渲染、不写注册表 —— 那是 arbiter / renderer / registry 的事。
 *   · 遍历顺序固定：TreeWalker + SHOW_TEXT + 跳过插件自身 UI 子树（`data-kh-ext-ui`）。
 *   · `options.shadow === true`（对应配置 `shadowDOMEnabled`，旧版默认 true）时，
 *     额外逐层进入 Shadow Root —— TreeWalker 按规范不跨 Shadow 边界，必须显式取 root
 *     （`collectShadowRoots`，与 Scheduler 共用同一份遍历）。
 *
 * 扩展点②使用方式（新增一种"定位方式"，例如"命中图片"、canvas 旁文本）：
 *   KH.Scanner.probes.register('image-alt', {
 *     applies(rule) { return rule.kind === 'normal'; },
 *     scan(root, rule, ctx) { return [ {node, start, end, text} ]; }
 *   });
 *   —— 内核文件 diff = 0（UN-06 验收）。
 *   注意：Probe 返回的坐标若能落成 Range 则后续走统一渲染；不能落 Range 的（如图片）
 *   由 Renderer 插件负责视觉，`Range` 为 null 时 Registry 仍登记（供聚合/统计）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** RawHit 契约：{ rule, node: Text|null, start, end, text, rangeHint } */

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);
  /** 插件自身 UI 宿主标记（唯一允许出现在 DOM 上的插件属性之一，铁律 §2 第 2 条） */
  const UI_ATTR = 'data-kh-ext-ui';

  /**
   * 该节点是否属于插件自身 UI（含 Shadow 宿主的宿主节点）。
   *
   * 【必须跨 Shadow 边界上溯】DOM 里 `parentElement` 链**在 Shadow 边界处截断**
   * （ShadowRoot 的直接子元素的 `parentElement` 是 null）。
   * 我们自己的面板/卡片内容全在各自的 ShadowRoot 里 —— 一旦开启 Shadow 内扫描
   * （`options.shadow`），若不做跨边界上溯，就会把自己 UI 里的文字当成页面文字去匹配
   * （旧版 v1.13.x 踩过的"备注卡片里的关键词被自己高亮"）。用 `getRootNode()` 出边界，
   * 检查该 root 的 host，再继续向上，直到 document。
   */
  function isOwnUI(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute(UI_ATTR)) return true;
      el = el.parentElement;
    }
    // 已到本 root 顶部（或压根没有 parentElement）→ 看看是不是某个 ShadowRoot 内部
    const root = node && node.getRootNode ? node.getRootNode() : null;
    if (root && root.host && root !== document) return isOwnUI(root.host);
    return false;
  }

  /** 该元素的 ShadowRoot（closed 模式取不到 → null；某些沙箱元素会抛，一并吞掉） */
  function shadowRootOf(el) {
    try { return (el && el.shadowRoot) || null; } catch (err) { return null; }
  }

  /**
   * 收集 root 子树内**全部（含嵌套）**的 ShadowRoot。
   * 唯一实现：Scanner（决定扫哪些文本）与 Scheduler（决定观察哪些子树）共用同一份遍历，
   * 避免两处各自写一套"找 shadow root"逻辑而漂移。
   * 用 TreeWalker(SHOW_ELEMENT) 而不是 querySelectorAll('*')：
   * 后者会为整页分配一个巨大的 NodeList，而这里只需要逐个元素看一眼 `shadowRoot`。
   *
   * 注意两个容易写错的点（都实测踩过）：
   *   · `createTreeWalker` 是 **Document 上的方法**，元素/ShadowRoot 上**没有**
   *     （`document.body.createTreeWalker === undefined`）——所以创建一律走 `document`，
   *     判断入参能不能当 root 要看 `nodeType`（元素 1 / 文档 9 / 片段 11），
   *     绝不能拿 `root.createTreeWalker` 当可用性守卫（对元素恒为 undefined → 永远返回空）。
   *   · TreeWalker 不跨 Shadow 边界，所以嵌套 Shadow 必须递归各自处理。
   */
  function collectShadowRoots(root, out) {
    const list = out || [];
    if (!root) return list;
    const t = root.nodeType;
    if (t !== 1 && t !== 9 && t !== 11) return list;   // 只有 元素/文档/DocumentFragment 能当 root
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let el;
    while ((el = walker.nextNode())) {
      const sr = shadowRootOf(el);
      if (!sr) continue;
      list.push(sr);
      collectShadowRoots(sr, list);       // TreeWalker 不跨边界 → 嵌套 Shadow 递归处理
    }
    return list;
  }

  /**
   * 元素渲染状态（**只看计算样式**的三态）—— 剪枝 / 透明判定 / 变更相关性判据的**底层原语**。
   *
   * ⚠️ **决策不要直接读它，要读 `rendersSubtree(el)`**：本函数看不见"只有原生 `checkVisibility`
   *    能识破的隐藏"（典型：闭合 `<details>` 的 UA `::details-content{content-visibility:hidden}`，
   *    那种内容的三种样式看起来都是"可见"）。详见 `rendersSubtree` 的注释。
   *
   *   `0` = 正常渲染（**含"自身没有布局盒、但子树照常渲染"的 `display:contents`**）
   *   `1` = 自身不可见（`visibility:hidden|collapse`）
   *   `2` = **整棵子树都不渲染**（`display:none` / `content-visibility:hidden`）
   *
   * ⚠️ `1` 与 `2` 在**扫描**里的后果是一样的：整棵子树都不扫。这是**刻意的保守口径**，
   * 由 `_e2e/content.test.js` 组 8d ⑥ 锁着（`visibility:hidden` 祖先里再自己 `visibility:visible`
   * 的写法极罕见，不值得为它放宽成"只跳自己、继续下钻"）。这里仍把两者分开，
   * 是因为它们在**语义**上不同（`visibility` 本来可被后代覆盖）—— 以后要放宽时改一处即可。
   *
   * 【为什么不能直接用原生 `checkVisibility` 的布尔值（v1.99.99.16 ~ 2.0.0.2 的真实缺陷，K76 修）】
   *   `display:contents` 的元素**没有布局盒** ⇒ 原生 `checkVisibility({checkVisibilityCSS:true})` 对它
   *   **一律返回 false**（真浏览器实测读数 `{"disp":"contents","self":false,"kid":true}`），
   *   可它的**子元素照常渲染**。旧实现把这个 false 直接当成"整棵子树不渲染" ⇒ 整行 `REJECT`
   *   ⇒ **被 `display:contents` 包住的词根本进不了扫描**，用户侧看起来就是"这个词没命中"。
   *   同理 `visibility` 也不是"剪子树"的理由（它可被后代覆盖）。
   *   这两条**本来就写在注释里**，只是实现一直在走另一套口径；本函数把实现与口径对齐。
   *
   * ⚠️ 不能先看 `hidden` 属性：`hidden` 只是"默认样式"钩子，页面完全可以用 CSS 覆盖它
   * （`[hidden]{display:flex}` 这类写法不少见）—— 先看属性会把**显式显示出来的**内容误判成隐藏。
   * 所以只有**拿不到计算样式**时才退化成"只看 `hidden` 属性"的保守判定（单测垫片走的就是这条路）。
   */
  function renderState(el) {
    if (!el || el.nodeType !== 1) return 0;
    try {
      if (typeof getComputedStyle !== 'function') {
        return (el.hasAttribute && el.hasAttribute('hidden')) ? 2 : 0;
      }
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.contentVisibility === 'hidden') return 2;
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return 1;
      return 0;
    } catch (e) { return 0; }
  }

  /**
   * 该元素是否是"**无盒放行**"的那一种：`display:contents`（自身没有布局盒，但子树照常渲染），
   * 且自身三种样式都不表示隐藏（`display:contents` + `visibility:hidden` 的子树是**继承隐藏**的，不许放行）。
   *
   * 为什么必须把"三者同时成立"写在一处、只读一次样式：它是原生 `checkVisibility` 判否时**唯一**
   * 允许推翻它的理由（见 `rendersSubtree`），拆成两次判断既慢又容易走样。
   */
  function contentsPassThrough(el) {
    try {
      if (typeof getComputedStyle !== 'function') return false;
      const st = getComputedStyle(el);
      return st.display === 'contents'
        && st.contentVisibility !== 'hidden'
        && st.visibility !== 'hidden' && st.visibility !== 'collapse';
    } catch (e) { return false; }
  }

  /**
   * 该元素的**子树会不会被渲染出来** —— 扫描剪枝 / 跨节点透明判定 / 变更相关性共用的**唯一判据**。
   *
   * 判序（顺序本身就是成本设计）：
   *   ① 原生 `checkVisibility` 当**快路径** —— 判"可见" ⇒ 直接 `true`，**零额外开销**
   *      （实测这条快路径决定了 collectNodes 是 ~100ms 还是 150ms）；
   *   ② 它判**否**时**只允许一种情况推翻**：`contentsPassThrough`（`display:contents`）。
   *      其余一律当"不渲染" —— 包括 `display:none` / `content-visibility:hidden` / `visibility:hidden`
   *      （后两者是**保守口径**，见 `_e2e/content.test.js` 组 8d ⑥），以及
   *      **只有原生 API 看得见的隐藏**；
   *   ③ 拿不到 `checkVisibility` 时退化成"三样式法"（`renderState(el) === 0`）。
   *
   * 【②为什么必须收窄（K76 的 R4 在真浏览器上抓到的回退）】
   *   原生 `checkVisibility` 判否的原因不止一种。K76 第一版把"判否"整个交给三样式法定性，
   *   于是**闭合 `<details>` 里的词开始命中**（真机 A/B：K76 = 1 处 / K76 前的发布副本 = 0 处）：
   *   Chromium 用 UA 伪元素 `::details-content{content-visibility:hidden}` 藏内容，
   *   子元素自身的 `content-visibility` 计算值仍是 `visible`、`display` 也是 block
   *   ⇒ **三样式法看不出这层隐藏，只有 `checkVisibility` 看得见**。
   *   而"页面上看不见的词不许命中"是 v1.99.99.16 就定下的用户口径 ⇒ 只允许 `display:contents` 例外。
   *
   * @param {Element} el
   * @param {{passthrough?: boolean}} [diag] 传入时回填"这次是不是靠 `display:contents` 放行的"（诊断计数用）
   */
  function rendersSubtree(el, diag) {
    if (diag) diag.passthrough = false;
    if (!el || el.nodeType !== 1) return true;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })) return true;
      } catch (e) { return renderState(el) === 0; }
      if (contentsPassThrough(el)) { passthroughSet.add(el); if (diag) diag.passthrough = 'contents'; return true; }
      if (collapsedInPlace(el)) { passthroughSet.add(el); if (diag) diag.passthrough = 'collapsed'; return true; }
      /* ① K78：作者自己用 `display:none` 收起、旁边有展开控件的内容（**启发式 + 开关**，见其注释） */
      if (customCollapseExpandable(el)) { passthroughSet.add(el); if (diag) diag.passthrough = 'custom'; return true; }
      /* 祖先已经判为"可读内容"（上面三类之一）⇒ 它的**子树照旧**；自身若还带真隐藏（`display:none`/`visibility`）就不放行。
       * ⚠️ 这一步必须放在三类判定**之后**：否则嵌套的同类形状（如 contents 里再套 contents）会被"继承"短路掉理由，
       * 计数与诊断就丢了（R4 的 R4-2 正是守这一点的）。
       * 也不能省掉它：R4 实测 `<ul role=menu style="display:none">` 这个块被判放行、可 `<li>` 里的词却没进扫描范围
       * —— 每个元素各判一次时，内层旁边没有控件就又被剪掉，出现"块放行了、块里的字没放行"的不一致。 */
      if (renderState(el) === 0 && passedThroughAncestor(el)) return true;
      return false;
    }
    return renderState(el) === 0 || collapsedInPlace(el) || customCollapseExpandable(el);
  }

  /**
   * 该元素是否处在「**折叠在原位、可展开**」的内容里 —— K77 新增的第二类放行（第一类是 `display:contents`）。
   *
   * 用户口径（2026-09-22 原话）：①「内容过长、被临时折叠、可以展开的 ⇒ 我要能够命中」；
   * ②「展开后，**内容和前面接续**，视觉上是一个完整连续整体才算」；
   * ③「它**不同**于弹窗增加显示的文本、网页自己的悬停文本」。
   * ⇒ 只认**两类语义明确的折叠**：
   *   ① **闭合 `<details>` 的内容区**（`<summary>` 子树之外）—— 原生折叠控件，展开后在同一个容器里接着读；
   *   ② 祖先链上靠 **`content-visibility: hidden`** 被跳过渲染的（含 `hidden="until-found"`）—— 内容在原位、占位、可展开。
   * **不认**（与 v1.99.99.16 一致）：
   *   · `display:none` —— 隐藏菜单 / 抽屉 / 弹窗关闭态；它们与"作者自己做的展开更多"在 CSS 层**完全同形**，无法区分（见契约 §二 的登记项）；
   *   · `visibility:hidden|collapse` —— 保守口径，`_e2e/content.test.js` 组 8d ⑥ 锁着。
   * 所以本函数**先沿"自身→祖先"确认没有被显式隐藏，再判是不是折叠**（顺序不能反：
   * `<details><div style="display:none">` 这种"折叠里又真隐藏"的，必须仍然不扫）。
   */
  function collapsedInPlace(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (typeof getComputedStyle !== 'function') return false;   // 拿不到样式就不放行（保守）
      let n = el;
      let details = null;
      /* 祖先**没有深度限定**（口径上"折叠里的内容"与嵌套层数无关）——这里给一个宽松安全上限，
       * 只为防病态 DOM（几千层）把这条"仅原生判否时才走"的路径拖长。
       * ⚠️ K77 的 R4 复验实测（真机 · 自造装置）：原先的 `depth < 8` 会让**嵌套 7 层以上**的折叠内容漏扫
       * （span→details 之间 6 层 ⇒ 命中；7/8/9 层 ⇒ 0）——**已按此修**（8 → 128）。 */
      for (let depth = 0; n && n.nodeType === 1 && depth < 128; depth++, n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.display === 'none') return false;                            // 真·隐藏 ⇒ 不是折叠
        if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
        if (st.contentVisibility === 'hidden') return true;                 // 折叠在原位（②）
        if (!details && n.tagName === 'DETAILS' && !n.open) details = n;    // 记下闭合的 <details>，链路走完再判
      }
      if (details) {
        const s = details.querySelector ? details.querySelector('summary') : null;
        if (!s || !s.contains(el)) return true;                             // 折叠的正文（①；不在 summary 子树里）
      }
    } catch (e) { return false; }
    return false;
  }

  /** 作者自己做的"展开 / 更多"控件常见文案（**只用于 ① 的启发式**，宁可漏判不误收） */
  const EXPAND_WORDS = /展开|更多|详情|查看全部|显示全部|全文|展开全部|全部内容|more|show|expand|detail|view\s*all/i;

  /** 该元素是否"大到算浮层"（与 `fetch.js` 的 `underOverlay` 同判据，但这里**自己实现窄版**，不跨模块依赖） */
  function isBigOverlay(node) {
    try {
      if (!node.getBoundingClientRect || typeof window === 'undefined') return false;
      const r = node.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6;
    } catch (e) { return false; }
  }

  /** 该元素之前（同容器内、最近几个兄弟）有没有**可见的内容** —— ① 的"同一个容器里接着读" */
  function hasVisibleBefore(el) {
    let n = el.previousElementSibling, hops = 0;
    while (n && hops < 4) {
      if (String(n.textContent || '').trim()) {
        const st = (typeof getComputedStyle === 'function') ? getComputedStyle(n) : null;
        if (!st || (st.display !== 'none' && st.visibility !== 'hidden' && st.visibility !== 'collapse')) return true;
      }
      n = n.previousElementSibling; hops++;
    }
    /* 往上看一层容器：`<div>前半段<button>展开</button></div><div style="display:none">…</div>` 这种
     * "控件与内容各自一个兄弟块"的结构，控件的**前一个兄弟**才是可见前文。 */
    const up = el.parentElement && el.parentElement.previousElementSibling;
    if (up && String(up.textContent || '').trim()) {
      const st = (typeof getComputedStyle === 'function') ? getComputedStyle(up) : null;
      if (!st || (st.display !== 'none' && st.visibility !== 'hidden')) return true;
    }
    return false;
  }

  /** 弹层语义的 `role`（菜单 / 列表 / 对话框 / 提示…）—— 那是"另一层 UI"，不是"折叠起来的长内容" */
  const POPUP_ROLES = /^(menu|menubar|listbox|option|dialog|alertdialog|tooltip|tabpanel|tree|treegrid|grid|combobox)$/i;

  /** 该元素自己是不是一个"展开控件"（只看硬信号：`aria-controls` 指向它 / `aria-expanded=false` / 按钮+展开词） */
  function isExpandTrigger(t, el) {
    if (!t || t.nodeType !== 1) return false;
    const tag = String(t.tagName || '').toUpperCase();
    const role = (t.getAttribute && t.getAttribute('role')) || '';
    /* ⚠️ K78 的 R4 证伪：**弹层触发器不是展开控件** —— `aria-haspopup` / 弹层角色都表示"点开的是另一个界面"。 */
    if (POPUP_ROLES.test(String(role))) return false;
    /* 标签页控件（`role=tab` / 带 `aria-selected`）管的是"另一层 UI"，不是展开长内容（R4 黄-1 候选②） */
    if (/^tab$/i.test(String(role)) || (t.hasAttribute && t.hasAttribute('aria-selected'))) return false;
    const hov = t.getAttribute && t.getAttribute('aria-haspopup');
    if (hov && hov !== 'false') return false;
    const ac = (t.getAttribute && t.getAttribute('aria-controls')) || '';
    if (ac) {                                   // 最硬的信号：它声明自己控制哪一块
      const id = String(ac).replace(/^#/, '').split(/\s+/)[0];
      let n = el;
      for (let d = 0; n && d < 8; d++, n = n.parentElement) if (n.id && n.id === id) return true;
    }
    /* 文案匹配只认"声明了自己是控件的"：`BUTTON` / `SUMMARY` / `[role=button]`。
     * **不认裸 `<a>`** —— 链接是导航（`<a>更多</a>` + 隐藏 `<ul>` 是站内下拉菜单的经典写法），R4 实测误收。 */
    const wordTagged = tag === 'BUTTON' || tag === 'SUMMARY' || /button/i.test(String(role));
    if (!wordTagged) return false;
    const words = EXPAND_WORDS.test(String(t.textContent || '').trim());
    if (t.hasAttribute && t.hasAttribute('aria-expanded')) {
      return String(t.getAttribute('aria-expanded')) === 'false' || words;
    }
    return words;
  }

  /** ① 的前置：`el` 之前紧邻着（最多 3 个兄弟内，或包一层容器里）一个"展开控件" */
  function hasExpandTrigger(el) {
    let n = el.previousElementSibling, hops = 0;
    while (n && hops < 3) {
      if (isExpandTrigger(n, el)) return true;
      /* 控件常常包在一层容器里：往里看一眼（只认这几类标签，不递归） */
      if (n.querySelector) {
        const inner = n.querySelector('button, a, summary, [role="button"], [aria-expanded]');
        if (inner && isExpandTrigger(inner, el)) return true;
      }
      n = n.previousElementSibling; hops++;
    }
    return false;
  }

  /**
   * ①「**作者自己用 `display:none` 收起来、旁边有展开控件**的内容」—— K78 新增的第三类放行。
   *
   * 用户口径（2026-09-23）：这类内容**就在原位、点一下展开、接着上文读** ⇒ 与闭合 `<details>` 同类，应当命中。
   * 但它与"隐藏菜单 / 抽屉 / 弹窗关闭态"**在 CSS 层完全同形**（都是 `display:none` 的块），所以只能**启发式**，
   * 而且**必须六条同时成立**（缺一不可）—— 宁可漏判，不许把隐藏菜单又放回来（那正是 v1.99.99.16 投诉过的事）：
   *   ① 设置开关 `scanCollapsedCustom` 开着（**默认开**；关掉就完全回到旧行为）；
   *   ② 让它不渲染的原因**正是 `display:none`**（`visibility` / `content-visibility` 各有各的口径，不归这条管）；
   *   ③ 折叠块的容器里，它**之前有可见内容**（"同一个容器里接着读"）；
   *   ④ 它**紧邻一个展开控件**（`aria-controls` 指向它 / `aria-expanded="false"` / 按钮且文案命中展开词表）；
   *   ⑤ 不是**浮层**（`fixed|absolute` 且覆盖视口 ≥60%）；
   *   ⑥ 自身/祖先没有 `visibility:hidden`。
   */
  function customCollapseExpandable(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const cfg = (typeof window !== 'undefined' && window.KH && window.KH.state && window.KH.state.config) || null;
      if (cfg && cfg.scanCollapsedCustom === false) return false;       // ①
      if (typeof getComputedStyle !== 'function') return false;
      let sawNone = false;
      let n = el;
      /* ⚠️ 这里**不能**在遇到 `display:none` 时 `break`：⑤（不是浮层）与⑥（没有 visibility 隐藏）要沿**整条祖先链**判，
       * 而"让它隐藏的那个 `display:none`"往往就在链中间 —— break 之后浮层判定永远不生效（本函数自己踩过）。 */
      for (let d = 0; n && n.nodeType === 1 && d < 128; d++, n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;    // ⑥
        if (st.contentVisibility === 'hidden') return false;                            // 不归这条管
        /* 自身就是"定位弹层"⇒ 不是流内折叠（R4 的收窄建议；折叠起来的长内容几乎都在流里） */
        if (d === 0 && (st.position === 'absolute' || st.position === 'fixed')) return false;
        if ((st.position === 'fixed' || st.position === 'absolute') && isBigOverlay(n)) return false;  // ⑤
        if (st.display === 'none') sawNone = true;                                      // ②
      }
      if (!sawNone) return false;
      /* 列表 / 导航容器 ⇒ 更像"菜单、导航"，不是"折叠起来的长文本"（R4 黄-1 候选①；口径是**宁可漏判**） */
      const tagOfEl = String(el.tagName || '').toUpperCase();
      if (tagOfEl === 'UL' || tagOfEl === 'OL' || tagOfEl === 'NAV' || tagOfEl === 'MENU') return false;
      /* 弹层语义 ⇒ 不是"折叠起来的长内容"（R4 的收窄建议：标准 ARIA 菜单会被误收） */
      const roleOf = (el.getAttribute && el.getAttribute('role')) || '';
      if (POPUP_ROLES.test(String(roleOf))) return false;
      const hovv = el.getAttribute && el.getAttribute('aria-haspopup');
      if (hovv && hovv !== 'false') return false;
      if (el.querySelector) {
        const r = el.querySelector('[role]');
        const rr = r && ((r.getAttribute && r.getAttribute('role')) || '');
        if (rr && POPUP_ROLES.test(String(rr))) return false;
      }
      if (!hasVisibleBefore(el)) return false;                          // ③
      if (!hasExpandTrigger(el)) return false;                          // ④
      return true;
    } catch (e) { return false; }
  }

  /**
   * 一个 root（Element / ShadowRoot / Document）内的可扫描文本节点。
   *
   * 【V1.99.99.16：隐藏内容不再参与命中】用户实测："命中了一个词，但当前页面没有，
   * 怀疑是把网页隐藏容器里的内容命中了 —— 至少要容器外显了才命中"。
   * 旧实现只对**跨节点**那条路顺手跳过了"直接父级隐藏"，单节点路径完全不判可见性，
   * 而且只看直接父级 → 祖先 `display:none` 里的文本照样被命中（页面上一片空白却有高亮）。
   * 现在：**以元素为单位剪枝**，判据只有 `rendersSubtree` 一份 ——
   * `display:none` / `content-visibility:hidden` / `visibility:hidden` / **UA 伪元素隐藏**（闭合 `<details>`）
   * 直接 `REJECT`（整棵子树跳过；后几种是**保守口径**，见组 8d ⑥ 与 `rendersSubtree` 的注释），
   * `display:contents`（自身无盒、子树照常渲染）**照常下钻** —— 这一条以前被原生
   * `checkVisibility` 误判成"不可见"，于是里面的词完全不高亮（K76）。
   * 顺带的好处：大段隐藏 DOM（折叠菜单 / 离屏抽屉 / 虚拟滚动缓存）不再被遍历，扫描更快。
   */
  /** 视觉行内级的记忆化缓存：**每轮扫描整体换新**（见 `collectTextNodes`）—— 样式可能变，不许跨轮陈旧。
   *  声明放在这里（而不是靠近 `isVisualInline`）是为了**在 `collectTextNodes` 之前**完成初始化：
   *  `collectTextNodes` 里会给它换新，`let` 若声明在调用点之后就成了 TDZ 陷阱。 */
  let visualInlineCache = new WeakMap();

  /** 本轮扫描里"被判定为可读内容"的块（`display:contents` / 折叠 / ①）—— 它们的**子树照旧扫**（见 `rendersSubtree`）。
   *  同样**每轮换新**（样式/结构随时变）。 */
  let passthroughSet = new WeakSet();

  /** 该元素的祖先里有没有"已被判定为可读内容"的块（只在原生判否那条罕见路径上问） */
  function passedThroughAncestor(el) {
    let n = el.parentElement;
    for (let d = 0; n && n.nodeType === 1 && d < 128; d++, n = n.parentElement) if (passthroughSet.has(n)) return true;
    return false;
  }

  function walkTextNodes(root, out, opts) {
    const stats = opts && opts.stats;   // 只读计数（诊断用，见 scan 里的 _lastScan）
    /* 「为什么只扫到这么几个文本节点」要能回答：按**拒绝原因**分类计数。
     * 实测现场：整页 512 个文本节点，扫描只收到 29 个、剪枝计数却只有 10 ——
     * 因为剪枝计数数的是**元素**（一个不可见祖先能吃掉几百个文本节点），
     * 而"可编辑区 / script-style / 空文本"这些是按**文本节点**逐个拒的，以前一个都没记。 */
    const rej = stats ? (stats.rejects = stats.rejects || { invisible: 0, skipTag: 0, ownUI: 0, editable: 0, empty: 0, orphan: 0 }) : null;
    /* 剪枝判据的回填位（复用同一个对象：`acceptNode` 每个元素都会跑，别在里面新分配） */
    const info = { passthrough: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP_TAGS.has(node.tagName)) { if (rej) rej.skipTag++; return NodeFilter.FILTER_REJECT; }
          if (node.hasAttribute && node.hasAttribute(UI_ATTR)) { if (rej) rej.ownUI++; return NodeFilter.FILTER_REJECT; }
          if (isOwnUI(node)) { if (rej) rej.ownUI++; return NodeFilter.FILTER_REJECT; }
          /* 剪枝：判据全部交给 `rendersSubtree`（原生快路径 + **只允许 `display:contents` 推翻判否**）。 */
          info.passthrough = false;
          if (!rendersSubtree(node, info)) {
            if (stats) stats.prunedInvisible++;
            if (rej) rej.invisible++;
            return NodeFilter.FILTER_REJECT;
          }
          if (stats) {
            if (info.passthrough === 'contents') stats.contentsPassThrough++;
            else if (info.passthrough === 'collapsed') stats.collapsedPassThrough++;   // 折叠在原位（K77）
            else if (info.passthrough === 'custom') stats.customCollapsePassThrough++; // ① 作者自己折叠的（K78）
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        const p = node.parentElement;
        if (!p) { if (rej) rej.orphan++; return NodeFilter.FILTER_REJECT; }
        if (SKIP_TAGS.has(p.tagName)) { if (rej) rej.skipTag++; return NodeFilter.FILTER_REJECT; }
        if (p.isContentEditable && !opts.includeEditable) { if (rej) rej.editable++; return NodeFilter.FILTER_REJECT; }
        if (p.hasAttribute && p.hasAttribute(UI_ATTR)) { if (rej) rej.ownUI++; return NodeFilter.FILTER_REJECT; }
        if (isOwnUI(p)) { if (rej) rej.ownUI++; return NodeFilter.FILTER_REJECT; }
        if (!node.nodeValue || !node.nodeValue.length) { if (rej) rej.empty++; return NodeFilter.FILTER_REJECT; }
        if (stats) stats.textNodes++;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    /* 走 SHOW_ELEMENT|SHOW_TEXT 是为了"按元素剪枝"，但收集的**只能有文本节点** */
    while ((n = walker.nextNode())) { if (n.nodeType === 3) out.push(n); }
    return out;
  }

  /**
   * 收集可扫描文本节点（跳过插件 UI / script / 可编辑区）。
   *
   * `options.shadow === true` 时**额外进入 Shadow Root 内部** —— 这是旧版
   * `shadowDOMEnabled`（默认 true，`setupShadowDOMObserver` / `_highlightInRoot(shadowRoot)`）
   * 的等价能力，重构不能丢：TreeWalker 按规范**不会**跨越 Shadow 边界，
   * 所以 Shadow 内的文本必须靠 `collectShadowRoots` 显式取出来单独走一遍。
   */
  function collectTextNodes(root, options) {
    const opts = options || {};
    const out = [];
    if (!root) return out;
    /* 视觉行内级的记忆化缓存**每轮扫描换新**：样式随时可能变（class 切换），跨轮复用会把词切断或漏切。
     * 放在这里是因为它是"收集文本节点"的唯一入口（`scan` 与组合词的格内扫描都走它）。 */
    visualInlineCache = new WeakMap();
    passthroughSet = new WeakSet();
    walkTextNodes(root, out, opts);
    if (opts.shadow) {
      for (const sr of collectShadowRoots(root)) walkTextNodes(sr, out, opts);
    }
    return out;
  }

  /* ==================================================================
   * 跨文本节点词边界守卫（cross-node boundary guard）
   * ------------------------------------------------------------------
   * 【语义定稿 —— 很容易理解反，这里写清楚】
   *   它是**负向守卫（作废误判）**，不是"跨节点拼接命中"。
   *   策划案原文（plan.md:292）：
   *     "页面把连续文本拆成相邻节点（如 BUG 被另一词 span 拆成 `B` + `<span>UG</span>`），
   *      命中字符贴节点首/尾时，正则 lookahead/lookbehind 只看当前文本节点内部 → 误判 `B` 为独立全词。
   *      修复：命中贴节点末尾→查右邻兄弟首个可见字符、贴开头→查左邻兄弟末字符，
   *      若延续词字符(/[\p{L}\p{N}_]/u)则作废命中。"
   *   旧版对应实现：keyword-engine.js:183-234 `_crossNodeBoundaryIsWord`（v1.14.1【3】）。
   *
   *   为什么单独需要它：`Compiler.buildPattern` 的全词边界用 `(?<!词字符)…(?!词字符)`，
   *   而**节点边界处没有字符**，两侧断言天然通过 → 拆开的词会被误判成独立全词。
   *
   *   为什么不需要"拼接命中"：旧版 v1.10.x~v1.52.0 的匹配始终在**单个文本节点内**完成，
   *   `<b>关</b>键词` 本就不命中「关键词」。这是既有行为，本次重构**不对齐升级**（避免改动语义）。
   * ================================================================== */

  /** 词字符判定（唯一实现；字符类与 Compiler.buildPattern 的边界类严格一致） */
  const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
  function isWordChar(ch) { return !!ch && WORD_CHAR_RE.test(ch); }

  /**
   * 可作为"文本延续载体"的行内元素白名单。
   * 采用**白名单**而非块级黑名单：拿不准的元素一律当边界，
   * 因为"少作废一次"只是漏一个误判，"多作废一次"会让用户真词漏高亮（更糟）。
   */
  /** 退化用的标签名白名单 —— **只在拿不到 `getComputedStyle` 时**才用（老环境 / 单测垫片）。
   *  正常路径的判据是 `isVisualInline`（看计算后的 `display`），不再看标签名。 */
  const INLINE_TAGS = new Set([
    'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
    'CODE', 'FONT', 'LABEL', 'ABBR', 'CITE', 'Q', 'TIME', 'VAR', 'KBD', 'SAMP',
    'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'BIG', 'TT'
  ]);

  /** 计算样式里属于"**行内级**"的 `display` 值（`contents` 无盒但不换行，同样算行内流） */
  const INLINE_DISPLAYS = new Set([
    'contents', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
    'ruby', 'ruby-base', 'ruby-text'
  ]);

  /** 该元素在**视觉上**是不是行内级（跨节点 run 可以穿透它）。
   *
   * 【K77：判据从"标签名"改成"计算后的 display"】用户口径「命中要符合视觉」——
   *   · `<div style="display:inline">` 视觉上就在同一行里，旧口径按 `DIV` 把它当断行边界 ⇒ **凭空切断词**；
   *   · 反过来 `<span style="display:block">` 是真的另起一块，旧口径又会误穿透；
   *   · `display:contents` 的包装（无盒）以前也被当成块级 —— 这就是"横跨 `display:contents` 边界的拆词不命中"的根因。
   * 排除 `float` 与 `absolute|fixed`（脱离行内流，视觉上是另起一块）。
   *
   * ⚠️ 这段在**热路径**上（`directCarrier` 对每个文本节点、每层祖先都会问）⇒ 用 `WeakMap` 记忆化，
   * 照 `fetch.js` 的 `overlayCache` 同一做法。拿不到 `getComputedStyle` 时退化回 `INLINE_TAGS`（= K76 行为）。
   */
  function isVisualInline(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'BR') return false;                    // 换行 = 天然边界
    if (SKIP_TAGS.has(el.tagName)) return false;              // script/style/textarea…
    if (el.hasAttribute && el.hasAttribute(UI_ATTR)) return false;
    const hit = visualInlineCache.get(el);
    if (hit !== undefined) return hit;
    let ok;
    try {
      if (typeof getComputedStyle !== 'function') ok = INLINE_TAGS.has(el.tagName);
      else {
        const st = getComputedStyle(el);
        ok = INLINE_DISPLAYS.has(st.display)
          && st.position !== 'absolute' && st.position !== 'fixed'
          && (!st.float || st.float === 'none');
      }
    } catch (e) { ok = INLINE_TAGS.has(el.tagName); }
    visualInlineCache.set(el, ok);
    return ok;
  }

  /** 该节点能否作为"被拆开的词的延续载体"（文本节点 / **视觉行内**元素；块级与 <br> 一律视为边界） */
  function isCarrier(node) {
    if (!node) return false;
    if (node.nodeType === 3) return !!(node.nodeValue || '').trim();
    if (node.nodeType !== 1) return false;
    if (!isVisualInline(node)) return false;                  // 视觉上另起一块 → 边界
    return !!(node.textContent || '').trim();
  }

  /** 该元素当前是否**不可见**（display:none / visibility:hidden|collapse / content-visibility:hidden）。
   *  用于"跨节点命中"的透明判定（不占位的元素不该把词切断）。
   *  口径与扫描剪枝**同源**（`rendersSubtree`）—— 这一点在 K76 之前是错的：旧实现直接取
   *  `checkVisibility` 的布尔值，于是 `display:contents` 的父元素被当成"隐藏"，
   *  它下面的文本会被踢出跨节点 run（词被凭空切断）。 */
  function isHiddenEl(el) {
    /* ⚠️ 这里**不能**用 `renderState`（只看三样式）：
     * `display:contents` 的父元素会因此被判成"隐藏"而把词切断，
     * 而闭合 `<details>` 里的内容又会因此被判成"可见"。统一走 `rendersSubtree`。 */
    return !rendersSubtree(el);
  }

  /** 本身是行内元素（可被冒泡穿透），且不是插件 UI —— 判据唯一实现在 `isVisualInline`。
   *  保留这个名字只为下文语义可读；K77 起它看的是**计算后的 display**，不是标签名。 */
  function isInlineElement(el) { return isVisualInline(el); }

  /**
   * 在**同一层**内找该方向最近的可延续载体。
   * @returns {Node|null|undefined} 找到 → 节点；明确撞到块级/BR 边界 → null；
   *                               本层已无兄弟（可继续向上冒泡）→ **undefined**
   */
  function directCarrier(node, dir) {
    let n = dir > 0 ? node.nextSibling : node.previousSibling;
    while (n) {
      if (isCarrier(n)) return n;
      /* 空行内元素（`<span></span>` 这类）视觉上什么都不占 → **透明跳过**，
       * 与上面"全空白文本节点 → 跳过继续找"同一口径。
       * 旧实现把它当边界，于是 `审核<span></span>不通过` 既**不命中**跨节点整词，
       * 又会让全词「审核」被误判成独立词（极端场景体检实测抓到的缺口）。 */
      if (n.nodeType === 1) {
        if (isVisualInline(n) && !String(n.textContent || '').trim()) {
          n = dir > 0 ? n.nextSibling : n.previousSibling;
          continue;
        }
        return null;                       // 块级 / <br> / script → 边界，停止
      }
      n = dir > 0 ? n.nextSibling : n.previousSibling; // 全空白文本节点 → 跳过继续找
    }
    return undefined;
  }

  /**
   * 跨（行内）父级向上冒泡的延续载体查找。
   *
   * 【v2 相对旧版的增强，属"补齐漏判"而非改语义】
   *   旧版 `_nextVisibleNode/_prevVisibleNode`（keyword-engine.js:199-206）**只看同层兄弟**，
   *   因此 `关<b>键</b>词` 这种"命中被包在行内标签里"的拆词方式它判不出来
   *   （`<b>` 内的文本节点没有兄弟 → 直接返回"无延续"）→ 「键」被误判为独立全词。
   *   这属于旧版逐步实现留下的覆盖缺口。v2 沿**行内祖先链**继续向上看一层，
   *   直到撞到非行内祖先（块级容器本身就是天然边界）为止 —— 语义仍严格是
   *   "延续词字符则作废"，只是把判定范围补全。
   */
  function carrier(node, dir) {
    let cur = node;
    /* 深度上限只是"防病态 DOM 造成长链"的兜底 —— **口径上"词是否被拆开"与嵌套层数无关**。
     * ⚠️ K78 起 8 → 128：K77 的 R4 真机实测过**同族**的 `collapsedInPlace` 在 7 层以上漏扫，
     * 这条路同理（一个词被十几层行内 `<span>` 拆开时要照样接得上）。 */
    for (let depth = 0; cur && depth < 128; depth++) {
      const found = directCarrier(cur, dir);
      if (found !== undefined) return found;           // 找到载体 或 明确边界
      const p = cur.parentElement;
      if (!isVisualInline(p)) return null;             // 父级视觉上不是行内 → 边界
      cur = p;
    }
    return null;
  }

  /** 取节点文本的首/末**可见**字符（忽略首尾空白）；isLast=true 取末字符 */
  function edgeChar(node, isLast) {
    if (!node) return '';
    const raw = node.nodeType === 3 ? (node.nodeValue || '') : (node.textContent || '');
    const t = isLast ? raw.replace(/\s+$/, '') : raw.replace(/^\s+/, '');
    if (!t) return '';
    return isLast ? t[t.length - 1] : t[0];
  }

  /**
   * 跨文本节点词边界守卫 —— 全工程唯一实现。
   * @returns {boolean} true = 该命中其实处在**被拆开的词**的首/尾，是误判，应作废
   */
  /**
   * 把一批（文档序）文本节点按"**视觉上连续的行内 run**"归组。
   *
   * 【唯一实现】内核的 `inline-run-regex`（整页跨节点命中）与组合词 Probe 的"格内跨节点核心词"
   *   必须用**同一份**口径：两处各写一份 run 归并，只要有一处走偏，就会出现
   *   "同一个词，普通规则亮、组合规则不亮"这类极难排查的不一致。
   *
   * @param {Node[]} nodes 文档序文本节点
   * @param {object} [opts]
   * @param {Element} [opts.within] run 只允许在本元素内延伸（组合词：核心词不许跨出定位到的格子）
   * @returns {Array<{nodes: Node[], text: string}>} 每项一段连续文本（含只含单节点的 run）
   */
  function buildInlineRuns(nodes, opts) {
    const within = (opts && opts.within) || null;
    /* 当前节点能否续在 run 尾巴上：
     *   · 左邻载体正好是 run 的最后一个节点 → 续；
     *   · `carrier()` 跨过行内元素时返回的是**元素**（`审<span>核</span>不通过` 里的 <span>），
     *     所以判据要允许"该元素**包含**当前 run 的最后一个节点"；
     *   · 空 / 隐藏的行内元素视觉上不占位 → 透明跳过继续往前找
     *     （`审核<span></span>不通过`、`审核<span style="display:none">XX</span>不通过`）。 */
    const chains = (prev, lastNode, depth) => {
      if (!prev || !lastNode || (depth || 0) > 6) return false;
      if (within && !within.contains(prev)) return false;   // 不许跨出限定范围（如：单元格）
      if (prev === lastNode) return true;
      if (prev.nodeType === 1) {
        if (prev.contains(lastNode)) return true;           // 行内元素包着它
        if (!String(prev.textContent || '').trim() || isHiddenEl(prev)) {
          return chains(carrier(prev, -1), lastNode, (depth || 0) + 1);
        }
      }
      return false;
    };
    const runs = [];
    let run = null;
    for (const node of nodes || []) {
      /* `within`：范围外的节点根本不参与聚 run。
       * 两道守卫都要有 ——
       *   · 这里（节点级）：范围外的文本不许进 run；
       *   · `chains()` 里（载体级）：本范围内的**第一个**节点的左邻载体若在范围外
       *     （如"上一格"的行内元素），run 也不许往那边延伸。
       * 只做载体级会漏：`carrier()` 返回的可能是**包着本范围的那个元素**，
       * 而"元素包含自己"恒为真 → 守卫形同虚设。 */
      if (within && !within.contains(node)) continue;
      /* 隐藏文本（display:none / visibility:hidden）**不参与聚 run**：
       *   `审核<span style="display:none">XX</span>不通过` 在用户眼里就是连着的"审核不通过"，
       *   隐藏的 "XX" 不该把词切断（冷门体检实测：修前整词不命中）。
       *   只影响"跨节点命中"这条路径 —— 单节点匹配照旧扫描隐藏内容，其它既有行为不受影响。 */
      if (node.parentElement && isHiddenEl(node.parentElement)) continue;
      if (run && chains(carrier(node, -1), run.nodes[run.nodes.length - 1], 0)) {
        run.nodes.push(node);
        run.text += node.nodeValue;
      } else {
        run = { nodes: [node], text: node.nodeValue };
        runs.push(run);
      }
    }
    return runs;
  }

  /**
   * 在"视觉连续的行内 run"上跑 pattern，产出**只跨文本节点**的命中（区间已映射回每一段）。
   *
   * 单节点就能匹配到的一律不在这里产出（交给逐节点路径）——否则同位置双命中，
   * 统计与备注会重复计数。这样对既有行为**完全可加**。
   *
   * 【词边界不需要额外守卫】run 是"极大连续文本"，正则的 lookbehind/lookahead 看到的就是
   *   真实相邻字符（run 两端是块级边界，那里本来就没有字符）。于是全词判定在跨节点时也自然正确：
   *   `审核<span>不通过</span>` 下全词「审核」不会命中（后面真的跟着"不"）。
   *
   * @returns {Array<{node,start,end,endNode,endOffset,segments,crossNode,text}>}
   */
  function matchInlineRuns(nodes, pattern, opts) {
    const out = [];
    if (!pattern) return out;
    /* `opts.runs` = 调用方已经算好的 run 列表（**按规则复用**：run 归并与规则无关，
     * 每次 scan 只该建一次；见 `inline-run-regex` 探针的 `ctx._runs`）。 */
    const runs = (opts && opts.runs) || buildInlineRuns(nodes, opts);
    /* 【性能·K77 补】跨节点这条路也要做**字面前缀预筛**（单节点那条 `matchIn:643` 早就有）：
     * 不含字面前缀的 run 直接跳过 ⇒ 一次 `indexOf` 换掉一次整段正则扫描。
     * 为什么 K77 才暴露：新的"视觉行内级"判据会把更多包装算成可穿透 ⇒ **run 变长**，
     * 真机门禁第 18 组（3000 行页面）因此越过 12s 预算（实测 12065ms）——这里就是那笔开销的对冲。
     * 语义不变：`literalOf` 已保证"有顶层分支时放弃预筛、取不到前缀时返回空串"。 */
    const lit = literalOf(pattern.source);
    const ci = pattern.flags.indexOf('i') >= 0;
    for (const r of runs) {
      if (r.nodes.length < 2) continue;
      if (lit) {
        if (ci) { if (r.text.toUpperCase().indexOf(lit.toUpperCase()) < 0) continue; }
        else if (r.text.indexOf(lit) < 0) continue;
      }
      const re = regexOf(pattern);
      let m;
      while ((m = re.exec(r.text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }   // 防空匹配死循环
        const start = m.index, end = m.index + m[0].length;
        /* 把 [start,end) 映射成**每一段 (node, 段区间)** —— 段由这里算准，
         * 下游（index/registry/renderer）直接照用，不再靠 carrier 反推节点
         * （carrier 可能返回行内**元素**，反推会踩到 nodeValue 为 null）。 */
        const segs = [];
        let acc = 0;
        for (const n of r.nodes) {
          const len = n.nodeValue.length;
          const s0 = Math.max(start, acc), e0 = Math.min(end, acc + len);
          if (e0 > s0) segs.push({ node: n, start: s0 - acc, end: e0 - acc });
          acc += len;
          if (acc >= end) break;
        }
        if (segs.length < 2) continue;                         // 实际没跨节点 → 交给逐节点路径
        const first = segs[0], last = segs[segs.length - 1];
        /* `start/end` 的口径与命中模型一致：**都指起始节点内的偏移**
         * （于是 `end` ＝ 起始节点里从 start 到该段末尾），真正的终点在 endNode/endOffset。 */
        out.push({
          node: first.node, start: first.start, end: first.end,
          endNode: last.node, endOffset: last.end, segments: segs, crossNode: true, text: m[0]
        });
      }
    }
    return out;
  }

  /**
   * 已编译正则缓存（V1.99.99.15）。
   *
   * 【为什么必须有】同一条规则要在**整页每个文本节点**上跑一次 `exec`，而旧实现每次
   * `new RegExp(source, flags)` —— 2000 行页面上实测 **scan 阶段 1240ms**（占整条 rebuild 的 61%），
   * 其中相当一部分纯粹花在"重复编译同一个正则"上（10 条规则 × 上万文本节点 = 十万级编译）。
   * 正则是**不可变**的（同 source+flags 编译结果完全一致），缓存后每次只重置 `lastIndex`。
   * 缓存键 = source + flags（不同规则的条数有限，不会无限增长）。
   */
  const reCache = new Map();
  function regexOf(pattern) {
    const want = pattern.flags.indexOf('g') >= 0 ? pattern.flags : pattern.flags + 'g';
    const key = pattern.source + '\u0000' + want;
    let re = reCache.get(key);
    if (!re) { re = new RegExp(pattern.source, want); reCache.set(key, re); }
    re.lastIndex = 0;                       // 复用前必须归零（`g` 正则的 lastIndex 是有状态的）
    return re;
  }

  /**
   * 从模式源码里取"字面前缀"（V1.99.99.15）。
   *
   * 【用途】纯词规则（`审核不通过`）在整页每个文本节点上都要 `exec` 一次，而绝大多数节点
   * 根本不含这个词。字面前缀可以用**最便宜的 `indexOf`** 先把这些节点挡掉，只有可能命中的
   * 节点才去跑正则 —— 语义完全不变（前缀都不在，匹配不可能成立）。
   * 正则规则（`a|b`、`\d+`）取不到非空前缀时自动退化为"不过滤"。
   */
  const literalCache = new Map();
  function literalOf(source) {
    /* ⚠️ **有顶层分支（`a|b`）时必须放弃预筛**：`安.*车主|好.*车主` 里 `安` 只是**第一个分支**的前缀，
     * 命中第二/第三个分支的文本根本不含 `安` —— 用 `安` 去 `indexOf` 会把它们全挡掉
     * （用户实测：组合词核心写 `安.*车主|好.*车主|平.*车主` 时"多个不生效"）。
     * 字符类里的 `|`（`[a|b]`）也一并保守放弃（少省一点，不会误杀）。 */
    if (/(^|[^\\])\|/.test(source)) return '';
    let lit = literalCache.get(source);
    if (lit !== undefined) return lit;
    let out = '';
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\\') {                       // 转义
        const nx = source[i + 1];
        if (nx === undefined) break;
        /* ⚠️【K77 的 R4 复验证伪】**只有"被转义的字面字符"才是字面量**。
         * 原实现把**每个**转义都当成"第二个字符就是字面量"⇒ `\d+` 取到前缀 `"d"`、`\w+` 取到 `"w"`、
         * `\bcat` 取到 `"bcat"`、`\x41` 取到 `"x41"`、`a\nb` 取到 `"anb"` —— 于是预筛要求文本里
         * 真的出现那个**字母**，`\d+` 这类关键词被**静默挡成 0 命中**（真机实测：`/\d+/gi` 在
         * 「订单号 12345」单节点 0 命中、在跨节点 `["第","12","3号"]` 也是 0 —— 正则本身是匹配的）。
         * 这跟本函数自己的注释承诺（"`\d+` 取不到前缀 ⇒ 不过滤"）直接矛盾。
         * 现在：转义后面是**字母或数字**（`\d \D \w \W \s \S \b \B \p \P \x \u \c \k \1..\9 \n \t \0`…）
         * 一律**放弃预筛**（`return ''`）；只有 `\.` `\-` `\\` 这类才是字面量。
         * 保守方向是对的：放弃预筛只是少省一点，**漏杀才是事故**。 */
        if (/[A-Za-z0-9]/.test(nx)) return '';
        out += nx; i++; continue;
      }
      if ('^$.*+?()[]{}|'.indexOf(ch) >= 0) break;   // 元字符 → 前缀到此为止
      out += ch;
    }
    literalCache.set(source, out);
    return out;
  }

  /**
   * 在**一个文本节点**内跑一个模式，产出命中片段。
   * 大小写 / 全词 / 正则的语义由 `pattern`（编译期）与 `flags` 决定；
   * 全词模式会走**跨节点词边界守卫**（贴节点首/尾且邻字符仍是词字符 → 作废）。
   *
   * **唯一实现**：普通词（`node-regex`）与组合词（核心词、标题词）都走这里 ——
   * 组合词与普通词的差别**只有定位范围**，匹配语义必须一模一样。
   * 谁要是再写第二份遍历，就会出现"同一个词，普通规则亮、组合规则不亮"（v1.99.99.8 实测缺陷）。
   */
  function matchIn(pattern, node, ctx, flags) {
    const out = [];
    if (!pattern || !node) return out;
    const text = node.nodeValue || '';
    if (!text) return out;
    /* 字面前缀预筛：不含前缀的节点直接跳过（省掉绝大多数 exec；语义不变，见 literalOf） */
    const lit = literalOf(pattern.source);
    if (lit) {
      if (pattern.flags.indexOf('i') >= 0) {
        if (text.toUpperCase().indexOf(lit.toUpperCase()) < 0) return out;
      } else if (text.indexOf(lit) < 0) return out;
    }
    const util = (ctx && ctx.util) || {};
    const guard = util.crossNodeBoundaryIsWord || (ctx && ctx.crossNodeBoundaryIsWord) || crossNodeBoundaryIsWord;
    const needGuard = !!(flags && flags.wholeWord);
    const re = regexOf(pattern);              // 缓存复用（见 regexOf：省掉十万级重复编译）
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }   // 防空匹配死循环
      const start = m.index, end = m.index + m[0].length;
      if (needGuard && guard(node, start, end)) continue;
      out.push({ start: start, end: end, text: m[0] });
    }
    return out;
  }

  /**
   * **唯一的"关键词匹配"入口**：在一批文本节点上跑同一个模式，产出命中片段。
   *
   * 普通词 = 在整页文本节点上跑；组合词 = 在**定位到的那个格子**里的文本节点上跑（`opts.within`）。
   * 除"范围"以外的每一项（大小写 / 全词边界 / 正则多分支 / 空匹配保护 / 跨文本节点 / 区间映射）
   * 都必须来自这一份实现 —— 这是"普通词能命中、组合词也要能命中"（反之亦然）的结构保证。
   *
   * @param {Node[]} nodes 文档序文本节点
   * @param {RegExp|null} pattern 编译后的模式；"无字面模式"的规则（罕见字逐字判定）传 `null` 并用 `opts.matchOne`
   * @param {object} ctx 扫描上下文（提供 `util` / `crossNodeBoundaryIsWord`）
   * @param {object} [opts]
   * @param {object} [opts.flags] 匹配开关（`wholeWord` 等）
   * @param {Element} [opts.within] 只允许在该元素**内**匹配并聚 run（组合词＝定位到的格子）
   * @param {function} [opts.matchOne] 自定义"单节点匹配" `(node) => [{start,end,text}]`
   * @returns {{single: RawHit[], cross: RawHit[]}} `single`＝单节点命中，`cross`＝真跨节点命中
   */
  function matchKeyword(nodes, pattern, ctx, opts) {
    const o = opts || {};
    const list = nodes || [];
    const one = typeof o.matchOne === 'function'
      ? o.matchOne
      : (pattern ? (node) => matchIn(pattern, node, ctx, o.flags) : () => []);
    const single = [];
    for (const node of list) {
      const got = one(node) || [];
      for (const m of got) single.push({ node: node, start: m.start, end: m.end, text: m.text });
    }
    /* 跨节点部分只补"真跨节点"的命中（单节点能匹配到的已在上面产出）→ 不重复计数 */
    const cross = pattern ? matchInlineRuns(list, pattern, { within: o.within }) : [];
    return { single: single, cross: cross };
  }

  function crossNodeBoundaryIsWord(node, start, end) {
    const text = (node && node.nodeValue) || '';
    // 命中贴节点末尾 → 右邻首个可见字符若延续词字符，说明词还没结束
    if (end === text.length) {
      if (isWordChar(edgeChar(carrier(node, +1), false))) return true;
    }
    // 命中始自节点开头 → 左邻末个可见字符若延续词字符，说明词是从左边开始的
    if (start === 0) {
      if (isWordChar(edgeChar(carrier(node, -1), true))) return true;
    }
    return false;
  }

  /* ---------------- 扩展点②：ScannerProbe ---------------- */

  const probes = KH.createRegistry ? KH.createRegistry('ScannerProbe') : null;

  /* ---- 内置 Probe ①：单节点正则扫描（普通词 / 全词 / 正则的默认定位方式） ---- */
  if (probes) probes.register('node-regex', {
    order: 100,
    /**
     * **只接管"没有指定专用 Probe"的规则**（`rule.probe` 为空）。
     * 这是踩出来的：组合词规则也带 `pattern`（那是它的**核心词**模式），
     * 如果这里同时接管，就会退化成"整页扫核心词"——
     * `KW.comboLR('肝癌','诊断')` 于是把「未配标题的行」里的「肝癌」也标了出来
     * （反例 `肝癌家族史阳性` 被误命中，F04/ST-04 直接变红）。
     * 与 Adapter 的 `order` 派发对称：**规则自己声明由谁扫，内核不猜**。
     */
    applies(rule) { return !!rule.pattern && !rule.probe; },
    scan(root, rule, ctx) {
      const nodes = (ctx && ctx.nodes) || collectTextNodes(root, ctx && ctx.options);
      /* 逐节点匹配走内核**唯一入口** `matchKeyword`（守卫、g 兜底、空匹配保护都在它里面，
       * 见 meta-check 2b/2c 与"匹配口径单源"红线）。组合词用的是同一个函数，只是带 `within`。 */
      const hits = matchKeyword(nodes, rule.pattern, ctx, { flags: rule.flags }).single;
      for (const h of hits) h.rule = rule;
      return hits;
    }
  });

  /* ---- 内置 Probe ②：跨文本节点（行内 run）扫描 ----
   * 【为什么需要】用户实测场景：页面为了给"不通过"上色，把「审核不通过」拆成了
   *   `审核<span style="color:#e53935">不通过</span>` 两个文本节点。单节点扫描看不到这个词，
   *   但**用户观感上它们是连着的** —— 应该命中，并且两段各自的颜色都保留。
   *
   * 【做法】`matchInlineRuns()`（本文件，**内核与组合词共用**）把"相邻行内"的文本节点串成 run
   *   （run 内文本在视觉上连续），在 run 的拼接文本上匹配，再把 [start,end) 映射回 (node, offset)。
   *
   * 【只产出真正跨节点的命中】单节点能匹配到的一律交给 node-regex ——
   *   否则同位置会双命中（统计与备注重复计数）。这样对既有行为**完全可加**。
   */
  if (probes) probes.register('inline-run-regex', {
    order: 90,                       // 先于 node-regex（100）
    applies(rule) { return !!rule.pattern && !rule.probe; },
    scan(root, rule, ctx) {
      const nodes = (ctx && ctx.nodes) || collectTextNodes(root, ctx && ctx.options);
      /* 【按 scan 复用 run 归并】run 只跟"节点序列"有关、与规则无关；旧实现对**每条规则**都重建一次
       * （每条规则一次全页 `carrier()` 遍历 + 隐藏元素 `getComputedStyle`），规则一多就是纯浪费。
       * 现在挂在 ctx 上，一次 scan 只建一次。 */
      let runs = ctx && ctx._runs;
      if (!runs) { runs = buildInlineRuns(nodes); if (ctx) ctx._runs = runs; }
      const hits = matchInlineRuns(nodes, rule.pattern, { runs: runs });
      for (const h of hits) h.rule = rule;
      return hits;
    }
  });

  const Scanner = {
    probes,
    collectTextNodes,
    collectShadowRoots,
    shadowRootOf,
    isOwnUI,
    UI_ATTR,

    /** 跨节点词边界守卫（内核能力，经 ctx 传给所有 Probe；不是注册点） */
    crossNodeBoundaryIsWord,

    /**
     * 供 Probe 复用的结构/文本原语。
     * 放在这里的原因：像"组合词"这种定位方式需要"按行/列找相邻单元格"这类结构遍历，
     * 但**不允许**它把逻辑写进内核文件；内核只提供原语，策略由 Probe 决定。
     * 这样新增定位方式不必改内核（meta-check #T 也会校验跨节点守卫仍单源）。
     */
    util: {
      /**
       * **子树会不会被渲染出来**（`true`/`false`）—— 剪枝 / 跨节点透明判定 / 变更相关性共用的**唯一判据**。
       * 判序：原生 `checkVisibility` 快路径 → 判否时**只允许 `display:contents` 推翻** → 拿不到原生 API 才退回三样式法。
       * 为什么不能只读 `renderState`：它看不见"只有原生 API 能识破的隐藏"（闭合 `<details>` 的 `::details-content`）。
       */
      rendersSubtree,
      /**
       * 元素渲染状态（`0` 正常 / `1` 自身不可见 / `2` 整棵子树不渲染）—— **只看计算样式的底层原语**。
       * ⚠️ 它**不是**决策入口（看不见 UA 伪元素隐藏）；要判"该不该扫"请用上面的 `rendersSubtree`。
       * `relevance.js` 判"变更块是否可见"也走 `rendersSubtree`：显隐口径必须与扫描剪枝同源。
       */
      renderState,
      /** 是否处在"**折叠在原位、可展开**"的内容里（闭合 `<details>` 的正文 / `content-visibility:hidden`）—— K77 的第二类放行 */
      collapsedInPlace,
      /** ① 作者自己用 `display:none` 收起、旁边有展开控件的内容（启发式 + `scanCollapsedCustom` 开关）—— K78 */
      customCollapseExpandable,
      isWordChar,
      isCarrier,
      carrier,
      edgeChar,
      crossNodeBoundaryIsWord,
      collectTextNodes,
      /** 子树内文本节点（跳过插件 UI / script / 可编辑区）—— **唯一实现**，组合词也用它 */
      textNodesIn(root, options) { return collectTextNodes(root, options); },
      /** 视觉连续的行内 run 归并（**唯一实现**：内核跨节点扫描 + 组合词格内跨节点核心词共用） */
      buildInlineRuns,
      /** 在 run 上匹配并映射回各段（只产出**真跨节点**的命中） */
      matchInlineRuns,
      /** 单文本节点匹配（含全词跨节点守卫 / `g` 兜底 / 空匹配保护） */
      matchIn,
      /** 字面前缀（"不含这个前缀就一定不可能命中"）—— 扫描内部与**变更预筛**共用同一份判据 */
      literalOf,
      /** **唯一的关键词匹配入口**：普通词=整页、组合词=某个格子，其余语义完全一致 */
      matchKeyword
    },

    /**
     * @param {Node} root 扫描根（整页重建传 document.body；局部增量传变更容器）
     * @param {CompiledRule[]} rules
     * @param {object} [options]
     * @returns {RawHit[]}
     */
    scan(root, rules, options) {
      /* 扫描体检计数（K57）：只读累加，不参与任何判定。
       * 用途：命中为 0 时回答"是**根本没扫到文本**（词不在这一层文档 / 全被可见性剪掉），
       * 还是**扫到了却没有命中**（匹配口径 / 组合词定位的问题）" —— 这两种情况的修法完全不同。 */
      const stats = { textNodes: 0, prunedInvisible: 0, contentsPassThrough: 0, collapsedPassThrough: 0, customCollapsePassThrough: 0, rules: (rules || []).length, hits: 0, ms: 0 };
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const nodes = collectTextNodes(root, Object.assign({}, options, { stats }));
      /* 扫描上下文：可以由管线**注入**（`options.ctx`）。
       * 为什么要能注入：Probe 定位到的东西不都会变成"命中"（典型就是图片识别 ——
       * 目标格里 DOM 文本没有那个词，压根不会有命中），但它们得让 ⑦Consume 的 Feature 看见。
       * 注入时把内部字段补齐；不注入时行为与以前完全一致（每次新建）。 */
      const ctx = (options && options.ctx) || {};
      ctx.root = root;
      ctx.nodes = nodes;
      ctx.nodeSet = new Set(nodes);   // O(1) 判断"这个文本节点属于本次扫描范围"
      ctx.options = options || {};
      ctx.crossNodeBoundaryIsWord = crossNodeBoundaryIsWord;
      ctx.util = Scanner.util;
      /** 图片识别锚点（combo Probe 写入；img-ocr Feature 在 Consume 阶段读取） */
      if (!Array.isArray(ctx.imgAnchors)) ctx.imgAnchors = [];
      const raw = [];
      const ordered = (probes ? probes.entries() : []).sort((a, b) => (a[1].order || 999) - (b[1].order || 999));
      for (const rule of rules || []) {
        for (const [name, probe] of ordered) {
          if (probe.applies && !probe.applies(rule, ctx)) continue;
          /**
           * 单个 Probe 出错**不得影响其它 Probe / 整条管线**。
           * 这是踩过的真坑：P2 里 `rare-char` 的 `scan` 抛了一个 ReferenceError
           * （重构时把函数留在了内层作用域），结果**首次重建整条流水线直接中断**，
           * 页面上所有功能一起失效 —— 表现为"四个不相干的功能用例同时变红"，
           * 排查成本极高。注册点意味着"内核必须对注册方保持防御性"。
           */
          let hits = [];
          try {
            hits = probe.scan(root, rule, ctx) || [];
          } catch (err) {
            console.error('[KH] ScannerProbe 执行异常（已隔离，不影响其它 Probe）:', name, err);
            continue;
          }
          for (const h of hits) raw.push(h);
        }
      }
      stats.hits = raw.length;
      stats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      stats.at = Date.now();              // 这一轮扫描发生的时刻（诊断要能算出"多久没扫了"）
      Scanner._lastScan = stats;          // 只读诊断出口（见 KH.diagnostics().selfCheck）
      return raw;
    }
  };

  KH.Scanner = Scanner;
})();
