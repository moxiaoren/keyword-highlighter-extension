/* ============================================================================
 * popup/editor.js · 独立编辑窗口的引导
 * ----------------------------------------------------------------------------
 * 为什么单独一个文件：MV3 扩展页的 CSP 是 `script-src 'self'` ——
 *   **内联 `<script>` 会被直接拦掉**（实测报 "Executing inline script violates the following
 *   Content Security Policy directive 'script-src 'self''"），编辑器于是根本不弹。
 *
 * 职责只有一件：用与选项页同一份配置打开同一个 `ui.openEditor`，关掉就收窗。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = window.KH;

  /** 编辑器关掉就收窗（保存与取消都算）——窗口只为这一次编辑而生 */
  function bye() {
    setTimeout(() => { try { window.close(); } catch (e) { /* 某些场景不允许脚本关窗，忽略 */ } }, 60);
  }

  (async () => {
    let cfg = {};
    try { cfg = await KH.Store.load(); } catch (e) { /* 读不到就用空配置，编辑器会走 FieldMap 默认值 */ }
    KH.ui.openEditor({
      cfg: cfg,
      bare: true,           // 只留内容：窗口已经有系统标题栏，不再叠遮罩与标题行
      onClose: bye
    });
  })();
})();
