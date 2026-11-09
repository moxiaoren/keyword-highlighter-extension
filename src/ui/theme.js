/* ============================================================================
 * src/ui/theme.js · 界面主题（浅色 / 深色 / 跟随系统）
 * ----------------------------------------------------------------------------
 * 【2.0.8.13 需求④】用户要的是「能切、默认跟系统」，不是"再来一套皮肤"：
 *   · 真值只有一个 `config.uiTheme`（`auto` / `light` / `dark`，默认 `auto`）；
 *   · 本文件把它解析成**实际生效的**主题，并写到 `<html data-kh-theme="dark">`；
 *   · 样式侧只在 `tokens.css` 里写 `:root[data-kh-theme="dark"]` 的令牌覆盖，
 *     组件 CSS 一律只认 `var(--token)` —— 于是"加主题"不必碰任何组件样式。
 *
 * 为什么不把 `[data-kh-theme="auto"]` 也做成一套 CSS：
 *   媒体查询与用户显式选择是两种来源，写两套同值令牌 = 两份真值，改一处漏一处。
 *   这里把 `auto` **在 JS 里解析**成 light/dark，样式侧只认最终的 light/dark 两态。
 *
 * 面板（content script）不共用这套：它跑在别人的页面上，**绝不能改宿主文档的属性** ——
 * 面板把自己的 shadow host 打上 `data-kh-theme`，深色样式写在注入样式里的 `:host([data-kh-theme="dark"])`。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});

  const MODES = ['auto', 'light', 'dark'];
  const ATTR = 'data-kh-theme';
  const MODE_ATTR = 'data-kh-theme-mode';

  function normMode(mode) {
    const m = String(mode == null ? '' : mode).trim().toLowerCase();
    return MODES.indexOf(m) >= 0 ? m : 'auto';
  }

  /** 系统当前偏好（取不到就当浅色：宁可浅色也不要黑屏） */
  function systemMode() {
    try {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  /** `auto` 在这里落成具体主题；返回实际生效值 */
  function resolve(mode) {
    const m = normMode(mode);
    return m === 'auto' ? systemMode() : m;
  }

  /** 只写最终态：light 时**摘掉**属性（浅色令牌就是默认值，不另写一遍） */
  function apply(mode) {
    const m = normMode(mode);
    const el = document.documentElement;
    const real = m === 'auto' ? systemMode() : m;
    if (real === 'dark') el.setAttribute(ATTR, 'dark');
    else el.removeAttribute(ATTR);
    el.setAttribute(MODE_ATTR, m);
    return real;
  }

  let watching = false;
  /** 跟随系统：只有当前是 auto 时才重绘（用户显式选了浅/深，系统切换不该改他的选择） */
  function watch() {
    if (watching) return;
    watching = true;
    try {
      const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      const on = () => {
        if (document.documentElement.getAttribute(MODE_ATTR) === 'auto') apply('auto');
      };
      if (mq.addEventListener) mq.addEventListener('change', on);
      else if (mq.addListener) mq.addListener(on);
    } catch (e) { /* 老浏览器没有媒体查询监听：保持首帧解析结果 */ }
  }

  /**
   * 页面启动时调一次：先从 storage 读真值（不依赖 Config 是否已加载），再写属性、挂系统监听。
   * 读失败（扩展上下文失效 / 无权限）→ 按 auto 处理，绝不因此让页面报错。
   */
  async function boot() {
    let mode = 'auto';
    try {
      const got = await chrome.storage.local.get('uiTheme');
      mode = got && got.uiTheme;
    } catch (e) { mode = 'auto'; }
    const real = apply(mode);
    watch();
    return real;
  }

  ui.theme = { MODES, ATTR, normMode, resolve, apply, boot };
})();
