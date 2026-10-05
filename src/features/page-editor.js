/* ============================================================================
 * src/features/page-editor.js · 在**当前网页**上弹出与选项页 1:1 的关键词编辑器
 * ----------------------------------------------------------------------------
 * 背景（用户实测）：「右上角插件入口的『＋ 快速添加』实现方式很奇怪，我设想的是
 *   直接在当前页一比一复刻关键词管理界面的添加、编辑弹窗」。
 * 为什么不能留在 popup 里：Chrome 扩展弹窗上限 800×600，而编辑器是**三列 860px**，
 *   挤进去只会塌成一列（实测：popup 本体 348px，模态被强制 sm，三列各 333px 全部竖排且横向溢出）。
 *
 * 做法：popup 发 `kh:editor:open` → 本模块在页面里建一个**独立宿主 + ShadowRoot**，
 *   把 tokens / components 的样式读进来注入 shadow，再用**同一份** `ui.openEditor`
 *   （`mount: shadowRoot`）渲染 —— 于是布局、分区、控件、文案与选项页**逐像素同源**。
 *
 * 为什么样式要进 ShadowRoot 而不是插进页面：
 *   · `tokens.css` / `components.css` 里的变量名是 `--brand` `--text-2` 这类**通用名**，
 *     直接插进页面会把站点自己的同名变量覆盖掉（真实站点里这很常见）；
 *   · 反过来，页面样式（`* { box-sizing }`、按钮全局样式…）也不会污染编辑器。
 *   ShadowRoot 里 `:root` 不匹配，所以要改写成 `:host`。
 *
 * 只由**顶层 frame** 响应：content_scripts 是 all_frames，消息会送到每个 iframe，
 *   不守卫的话每个 iframe 都会弹出一个编辑器。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const HOST_ID = 'kh-page-editor-host';
  const CSS_FILES = ['src/ui/tokens.css', 'src/ui/components/components.css'];

  /** 最近一次 consume 拿到的配置（编辑器要用它做默认值与分组下拉） */
  let latestCfg = null;
  let cssText = null;          // 样式只取一次
  let modalInst = null;

  function hostEl() {
    let host = document.getElementById(HOST_ID);
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-kh-ext-ui', '1');   // 自身 UI 标记：扫描/悬停命中一律跳过
    /* 宿主自身零尺寸、但给一个**最高层级**：ShadowRoot 里的 `.kh-modal-mask` 用的是
     * `--z-toast`（低于重要笔记面板硬编码的 2147483646），不给宿主提权的话
     * 面板会压住编辑器的左列（实测截图里「基本信息」被遮住）。
     * 零尺寸宿主不拦事件，内部的 fixed 遮罩照常接收点击。 */
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style></style>';
    document.body.appendChild(host);
    host._shadow = shadow;
    return host;
  }

  /** 读样式。返回 **true = 两份样式都到手**（含命中缓存）；false = 有缺失，且**不缓存半份**。
   *
   * C7 O-5：旧写法把每一份的失败都吞成 `console.warn`，照样拼出 `cssText` 并把结果当成功
   * —— 用户看到的是**没有样式的白板弹窗**，而 popup 收到 `{ok:true}` 后关掉了自己，
   * 谁都来不及说一句"坏了"。扩展自有资源 fetch 失败只可能是真读不到（缺文件 / 资源被禁），
   * 这时必须**承认失败**：返回 false，让 popup 退回独立窗口（那条路用 `<link>` 加载样式，
   * 不依赖隔离世界的 fetch）。也不要缓存残缺结果，否则后续每次都会"成功"地画出白板。 */
  async function ensureCss(shadow) {
    if (cssText) {
      const el = shadow.querySelector('style');
      if (el && el.textContent !== cssText) el.textContent = cssText;
      return true;
    }
    const parts = [];
    const missing = [];
    for (const rel of CSS_FILES) {
      try {
        const res = await fetch(chrome.runtime.getURL(rel));
        if (res && res.ok === false) throw new Error('HTTP ' + res.status);
        parts.push(await res.text());
      } catch (err) {
        missing.push(rel);
        console.warn('[KH] 编辑器样式读取失败：', rel, err);
      }
    }
    if (missing.length || !parts.length) {
      console.warn('[KH] 页面内编辑器样式不全（缺 ' + missing.length + '/' + CSS_FILES.length +
        '：' + missing.join('、') + '）—— 不在页面里开，改由 popup 退回独立编辑窗口');
      return false;
    }
    /* ShadowRoot 内 `:root` 不匹配 → 改写成 `:host`，否则所有 token 变量都是空的 */
    cssText = parts.join('\n').replace(/:root\b/g, ':host');
    const styleEl = shadow.querySelector('style');
    if (styleEl && styleEl.textContent !== cssText) styleEl.textContent = cssText;
    return true;
  }

  /** 取一份**可信**配置给编辑器用。
   *
   * `latestCfg` 只在内核 rebuild 时由 `consume` 写入，而全局暂停 / 本站禁用 / 无规则时
   * 内核在 `src/core/index.js` 就提前 return 了，**那个文档永远不会 rebuild**
   * ⇒ `latestCfg` 一直是 null。此时必须主动读盘，读不到就返回 null。
   * 绝不能拿 `{}` 顶替：编辑器会把它当默认值与分组下拉的来源，
   * 保存时按「空配置」整表写回，把用户词库覆盖成一个词（历史 P0，见 storage.js `configForWrite`）。 */
  async function currentCfg() {
    if (latestCfg && Array.isArray(latestCfg.keywords)) return latestCfg;
    try {
      if (KH.Store && typeof KH.Store.load === 'function') {
        const cfg = await KH.Store.load();
        if (cfg && Array.isArray(cfg.keywords)) { latestCfg = cfg; return cfg; }
      }
    } catch (err) {
      console.warn('[KH] 页面内编辑器读取配置失败：', err);
    }
    return null;
  }

  /** 打开编辑器（新建；带 keyword 即为编辑）。返回是否打开成功 */
  async function open(keyword) {
    if (!KH.ui || typeof KH.ui.openEditor !== 'function') return false;
    /* 拿不到权威配置就**不在页面里开**：返回 false，popup 会退回独立编辑窗口
     * （那条路自己读盘；读盘失败时写入端也已拒写，见 storage.js）。 */
    const cfg = await currentCfg();
    if (!cfg) return false;
    const host = hostEl();
    /* 样式不全就**别开**（C7 O-5）：撤掉刚建的宿主并返回 false，
     * popup 收到 `{ok:false}` 自然退回独立窗口 —— 用户看到的仍是那个编辑器，
     * 而不是一个没有样式的白板。 */
    if (!(await ensureCss(host._shadow))) {
      /* 撤掉刚建的宿主。写法刻意"父子两可"：真浏览器有 `Element.remove()`，
       * 但单测的 DOM 垫片只有 `removeChild` —— 只写 `host.remove()` 会被下面的
       * catch 吞掉，宿主留在 body 里（z-index 最大的一层空壳），单测也就抓不到。*/
      try {
        if (host.parentNode && typeof host.parentNode.removeChild === 'function') host.parentNode.removeChild(host);
        else if (typeof host.remove === 'function') host.remove();
      } catch (err) { /* 忽略 */ }
      return false;
    }
    if (modalInst) { try { modalInst.close(); } catch (err) { /* 忽略 */ } }
    modalInst = KH.ui.openEditor({
      keyword: keyword || null,
      cfg: cfg,
      mount: host._shadow,               // 挂在页面里的 ShadowRoot 上（不在 popup 内联）
      onSaved: () => { modalInst = null; } // 保存后由 storage.onChanged 触发全页重建
    });
    return true;
  }

  KH.features.register('page-editor', {
    order: 900,                           // 纯交互，不参与视觉裁决
    /** 只是顺手记下最新配置：编辑器要用它生成默认值与分组下拉 */
    consume(hits, cfg) { if (cfg) latestCfg = cfg; },
    clear() { /* 无视觉，不需要清理 */ }
  });

  KH.PageEditor = { open, HOST_ID };
})();
