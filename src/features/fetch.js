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

  /** 占位符 → 安全 `<img>`（在 esc 之后调用：正文保持转义、图片安全插入） */
  function restoreImgs(html) {
    const escA = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return String(html).replace(
      new RegExp('\u0001KHIMG\u0001([^|]*)\\|([^\u0001]*)\u0001ENDIMG\u0001', 'g'),
      (_, a, u) => {
        let alt = '', src = '';
        try { alt = decodeURIComponent(a); src = decodeURIComponent(u); } catch (err) { return ''; }
        if (!/^https?:\/\//i.test(src)) return '';
        return '<img src="' + escA(src) + '" alt="' + escA(alt) + '" loading="lazy">';
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

    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let n;
    while ((n = walker.nextNode())) {
      /* K79：读这一层的值时跳过它内部嵌的表格（文字与图片都跳过） */
      if (skipNested && insideNestedTable(n, cell)) continue;
      if (n.nodeType === 1) {
        if (n.tagName !== 'IMG') continue;                 // 只关心图片；其它元素继续下钻
        const ph = imgPlaceholder(n);
        if (!ph) continue;
        const g = geoOf(n);
        addSeg(g.top, g.bottom, { img: ph });
        continue;
      }
      if (underInteractive(n, cell)) continue;
      if (underOverlay(n)) continue;                       // 浮层里的文字不算字段内容（只影响抓取）
      const t = (n.nodeValue || '').replace(/[\u00a0\u3000]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!t) continue;
      const g = geoOf(n);
      addSeg(g.top, g.bottom, { text: t });
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
   *   · 可组合：`包名!`、`包名!%6`、`简介%2-3`（`!` 与 `%` 可与 `#`/`@` 任意顺序混写）
   *   修饰从**末尾**逐个剥（所以 `#…` / `@…` / `!` / `%…` 可以任意顺序混写），最多剥多轮。
   */
  const IMG_SUFFIX_RE = /#\s*(图|仅图)?\s*(\d+)?\s*$/;
  const OFFSET_SUFFIX_RE = /@\s*([^@#]*)$/;
  /* `!` = 去内部空白；`%` = 字符截取（%N 前N字 / %a-b 第a到b字）—— 从末尾剥，可与 # / @ 任意混写 */
  const STRIP_SUFFIX_RE = /\s*!\s*$/;
  const SLICE_SUFFIX_RE = /%\s*([^%!@#]*)$/;

  function parseLabelSpec(t) {
    let s = String(t == null ? '' : t).trim();
    let offset = '';
    let imgOnly = false;
    let imgLimit = 0;
    let simple = false;
    let stripSpace = false;
    let sliceSpec = '';
    for (let guard = 0; guard < 6; guard++) {
      const mi = IMG_SUFFIX_RE.exec(s);
      if (mi) {
        /* `#` 后必须是「图 / 仅图 / 数字 / 空白」才算图片选项（正则已锚定 `$`），
         * 所以 `备注#说明` 这种把 `#` 写在标签里的写法不会被误当成后缀。 */
        const only = !!mi[1];
        const n = mi[2] ? parseInt(mi[2], 10) : 0;
        if (only) imgOnly = true;
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
      break;
    }
    return { label: s, simple: simple, imgOnly: imgOnly, imgLimit: imgLimit, offset: offset, offsetInvalid: isOffsetInvalid(offset), stripSpace: stripSpace, sliceSpec: sliceSpec };
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

  /* 对一行值格文本应用字段级修饰：`!` 去内部空白 → `%` 字符截取（顺序固定，先空格后截取）。 */
  function modText(t, item) {
    if (item.stripSpace) t = String(t).replace(/\s+/g, '');
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
   * 按字段的图片选项处理一段内容（**只动图片占位符与文字，不碰 HTML**，调用方随后仍走 escHtml）：
   *   · `imgOnly`  → 只留图片（丢掉文字）
   *   · `imgLimit` → 该字段全局最多保留 N 张图（`budget.n` 跨单元格累计，保证"前 N 张"是整字段的前 N 张）
   * 用户口径："抓取需要支持仅图片、前几张图片的方式"。
   */
  function applyImgPolicy(text, opt, budget) {
    let s = String(text == null ? '' : text);
    const b = budget || { n: 0 };
    /* 【刻意**不按 src 去重**】真实页面里同一张图可能在两列/两行里各出现一次
     * （用户给的结构就是这样：最新版本与历史版本都放了「图一图二」），
     * 去重会直接把其中一列吃空 —— 比"偶尔多一张重复图"糟得多。 */
    if (!opt || (!opt.imgOnly && !opt.imgLimit)) return s;
    if (opt.imgOnly) {
      const keep = [];
      s.replace(IMG_RE, (m) => { keep.push(m); return m; });
      s = keep.join(' ');
      if (!s) return '';
    }
    if (opt.imgLimit > 0) {
      if (b.n == null) b.n = 0;                  // 跨单元格累计，**不重置**（整字段的前 N 张）
      s = s.replace(IMG_RE, (m) => {
        b.n++;
        return b.n <= opt.imgLimit ? m : '';
      });
      s = s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
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
   *  按 (表, 本轮重建) 记忆（`memo.span`），所以每张表每轮只扫一遍。 */
  function tableSpanInfo(table, memo) {
    const store = memo && memo.span;
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
    const info = tableSpanInfo(table, opts && opts.memo);
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
   * 整表兜底的结果与"命中的是哪一行"**无关** ⇒ 可按 (层表格, scope, label) 在 memo 里缓存，
   * 于是"行级优先"带来的额外开销只是每行一次**行内**扫描（小常数），不是每行一次全表扫描。
   */
  function findLabelCellLayered(table, cell, label, scope, memo) {
    const row = hitRowIn(table, cell);
    if (row) {
      const own = ownCellsIn(row, table);
      for (let i = 0; i < own.length; i++) {
        if ((own[i].textContent || '').trim() === label) return { cell: own[i], fromRow: true };
      }
    }
    const k = String(scope) + '\u0001' + label;
    const store = memo && memo.cells;
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
  function resolveLayerCells(cell, items, scope, memo) {
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
        const hit = findLabelCellLayered(L.table, cell, item.label, scope, memo);
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
   * @param {object} [memo] 同一轮重建内复用的缓存盒（见 `blockFor`；不传就逐次计算）
   * @returns {Array<{label:string, cells:Element[], imgs:Element[], byOffset:boolean, invalid:boolean}>}
   */
  function cellsForHit(hitOrCell, cfgOrLabels, memo) {
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
          byOffset: picked.byOffset, invalid: picked.invalid || !!item.offsetInvalid
        });
      }
      return out;
    }
    /* 分层口径与 `extractFor` **同一份实现**（`resolveLayerCells`）——
     * 图片识别因此自动与"你选的抓取层级"同源（§四.5）；`all` 下各层值格的图都进来，
     * 去重交给下游（img-ocr 按 URL / 元素去重）。 */
    const picked = resolveLayerCells(cell, items, sc, memo) || [];
    for (const p of picked) {
      const v = valueCellsOf(p.cell, p.item);
      out.push({
        label: p.label, cells: v.cells, imgs: imgsOfCells(v.cells),
        byOffset: v.byOffset, invalid: v.invalid || !!p.item.offsetInvalid
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
  function rowsForItem(item, target, table, fromRow, memo) {
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
        rows = collectRightBlock(target, table, { stopAtRepeatedLabel: !!fromRow, memo: memo });
      }
    }
    /* `!` 去空白 / `%` 截取：无论来自 @偏移、#1 简单模式还是整块，统一在取值出口做修饰 */
    if (rows && (item.stripSpace || item.sliceSpec)) rows = transformRows(rows, item);
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
   * @param {object} [memo] 同一轮重建内复用的缓存盒（`{html, cells}`，见 `blockFor`）
   * @returns {Array<{label:string, rows:Array<Array<{t:string,rs:number,cs:number}>>}>}
   */
  function extractFor(textNode, rawLabels, scope, memo) {
    const items = parseLabels(rawLabels);
    if (!items.length || !textNode) return [];
    const sc = scopeOf(scope);
    const table = nearestTable(textNode.parentNode);
    if (!table) {
      return extractFromFakeTable(textNode.parentElement, items);
    }
    const cell = anchorCellOf(textNode) || textNode.parentElement;
    const picked = cell ? resolveLayerCells(cell, items, sc, memo) : null;
    if (!picked || !picked.length) return [];

    const entries = [];
    for (const p of picked) {
      const rows = rowsForItem(p.item, p.cell, p.table, p.fromRow, memo);
      if (rows && rows.length) entries.push({ label: p.label, dir: p.dir, idx: p.idx, rows: rows });
    }
    /* K79：多选（当前层 + 内层 / 外层…）时**一律合并**（同名同值去重、值不同加层级后缀）；
     * 只选一层时合并是**恒等变换**（不加后缀）⇒ 单层行为与 K74 完全一致。 */
    return mergeAllLayers(entries);
  }

  /* ------------------------------------------------- 多行表格渲染（唯一实现） */

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
  function rowsToTableHtml(multi) {
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
      return { label: m.label, textLines, grid, rows: m.rows || [], opt: opt, budget: budget };
    });

    let html = '<table class="kh-table kh-table-fetch">';
    for (const it of items) {
      if (it.grid) {
        const total = it.rows.length;
        /* 该字段里是否有图片：决定"纯数字格"要不要当噪音去掉（见下） */
        const fieldHasImg = (it.rows || []).some((line) => line.some((c) => String(c.t).indexOf('\u0001KHIMG\u0001') >= 0));
        let firstInBlock = true;
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
            cells += '<td' + attrs + '>' + escHtml(val) + '</td>';
          }
          html += '<tr>' + (firstInBlock && it.label != null ? '<td class="kh-table-label" rowspan="' + total + '">' + escHtml(it.label) + '</td>' : '') + cells + '</tr>';
          firstInBlock = false;
        }
        continue;
      }
      if (!it.textLines.length) continue;
      const filled = parseBlock(it.textLines, it.label);
      if (!filled.length) continue;

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
        return '<td class="kh-table-label"' + rs + '>' + escHtml(it.label) + '</td>';
      };

      for (const b of filled) {
        if (b.gtitle != null) {
          html += '<tr>' + labelCell() +
            '<td colspan="' + afterLabelColspan + '">' + escHtml(b.gtitle) + '</td></tr>';
        }

        for (const s of b.subs) {
          const cap = s.title == null ? '' : s.title;
          const n = s.lines.length;
          for (let i = 0; i < n; i++) {
            if (!cap) {
              // ④ 无二级标题：内容跨「二级标题 + 内容」两列
              html += '<tr>' + labelCell() +
                '<td colspan="' + afterLabelColspan + '">' + escHtml(s.lines[i]) + '</td></tr>';
            } else if (i === 0) {
              // ③ 首行：二级标题 rowspan + 内容
              html += '<tr>' + labelCell() +
                '<td rowspan="' + n + '">' + escHtml(cap) + '</td><td>' + escHtml(s.lines[i]) + '</td></tr>';
            } else {
              // ③ 续行：只写内容格（第 1、2 列已被两个 rowspan 占住）
              html += '<tr><td>' + escHtml(s.lines[i]) + '</td></tr>';
            }
          }
        }
      }
    }
    html += '</table>';
    return html;
  }

  /** 「标签（内层）/（本层）/（外层）」这类层级后缀剥掉 —— 只用于把 label 映射回它的字段选项。
   *  ⚠️ K79 返工（R4 红牌）：**三个方向的后缀都要认** —— `layerSuffix` 会产出
   *  `（内层）/（内2层）/（本层）/（外层）/（外2层）`，这里漏了「内层/内N层」时，
   *  `截图#图` 这种字段级图片选项在内层那一份上会**被静默丢掉**（`#图` 失效 ⇒ 内表文字漏进卡片）。 */
  function baseLabelOf(label) {
    return String(label == null ? '' : label).replace(/（(?:内层|内\d+层|本层|外层|外\d+层)）$/, '');
  }

  /** 真正算一次（不缓存时走这条）。字段级的图片选项（仅图片 / 前 N 张）按 label 带进渲染。 */
  function computeBlock(textNode, rawLabels, scope, memo) {
    const fetched = extractFor(textNode, rawLabels, scope, memo);
    if (!fetched.length) return null;
    const optOf = {};
    for (const it of parseLabels(rawLabels)) optOf[it.label] = it;
    return rowsToTableHtml(fetched.map(f => ({
      label: f.label, rows: f.rows,
      /* `all` 下同名标签会带层级后缀 → 先按原样查，再退回"剥掉后缀"查 */
      opt: optOf[f.label] || optOf[baseLabelOf(f.label)]
    })));
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
  function blockFor(textNode, rawLabels, cache, scope) {
    const sc = scopeOf(scope);
    if (!cache || !textNode) return computeBlock(textNode, rawLabels, sc, null);
    const root = nearestTable(textNode.parentNode) || textNode.parentElement;
    if (!root) return computeBlock(textNode, rawLabels, sc, null);
    let box = cache.get(root);
    if (!box || typeof box !== 'object' || !box.html) {
      box = { html: new Map(), cells: new Map(), span: new Map() };
      cache.set(root, box);
    }
    const k = String(rawLabels == null ? '' : rawLabels) + '\u0001' + sc + '\u0001' + rowKeyOf(root, textNode);
    if (box.html.has(k)) return box.html.get(k);
    const v = computeBlock(textNode, rawLabels, sc, box);
    box.html.set(k, v);
    return v;
  }

  KH.Fetch = {
    GROUP_TITLES, parseLabels, extractFor, extractFromFakeTable, collectRightBlock,
    cellText, cellVisualText, isInteractive, imgPlaceholder, restoreImgs,
    rowsToTableHtml, blockFor, triggerOk, fakeRightValue, nearestTable, isPlaceholderText,
    /* 图片选项（仅图片 / 前 N 张）：单测直接锁 */
    applyImgPolicy,
    /* 「抓取字段的值格（含图）」**只读访问口**（img-ocr 取图用；不改抓取内容语义） */
    cellsForHit, valueCellsOf, splitLabelTokens, findLabelCell
  };
})();
