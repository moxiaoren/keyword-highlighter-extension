/* ============================================================================
 * src/core/protocol.js · 全工程唯一消息协议
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件：旧版消息类型散落三套写法 ——
 *   background: { action: 'toggleGlobal' } / { action: 'refresh' }
 *   popup:      { action: 'checkUpdate' } / { action: 'updatePopup' }
 *   content:    无统一约定
 * 结果是"同一件事有多套名字、加了新消息不知道要不要兼容旧名"。v2 收敛为唯一协议：
 *
 *   { type: 'kh:<域>:<动作>', ...payload }
 *
 * 域固定几类：state（读状态）、global（全局开关）、site（站点开关）、
 * rebuild / debug / editor / ocr。
 * 【2026-10-05 变更】原先的 update 域（kh:update:check / kh:update:info）随"插件入口取消线上更新"
 * 一并删除 —— 插件不再检查更新、不再弹更新提示条；更新通道只是本机设置（src/core/channel.js）。
 * 新增消息 = 在 MSG 里登记一个常量，**禁止在业务代码里硬编码字符串**。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 消息类型唯一清单 */
  const MSG = {
    /* ---- state ---- */
    STATE_QUERY: 'kh:state:query',          // 查询当前标签页状态（站内是否高亮/命中数/规则数）
    STATE_REPLY: 'kh:state:reply',          // （广播用）状态回执

    /* ---- rebuild ---- */
    REBUILD_REQUEST: 'kh:rebuild:request',  // 请求内容脚本立即重扫（popup/自动化用）
    REBUILD_DONE: 'kh:rebuild:done',        // 重扫完成回执

    /* ---- global ---- */
    GLOBAL_TOGGLE: 'kh:global:toggle',      // 切换全局开关；payload: { value?: boolean }
    GLOBAL_CHANGED: 'kh:global:changed',    // background 广播给所有标签页

    /* ---- site ---- */
    SITE_TOGGLE: 'kh:site:toggle',          // 临时禁用/启用当前站点
    SITE_CHANGED: 'kh:site:changed',        // 广播

    /* ---- debug（只读诊断；联调 / 真浏览器回归用） ---- */
    DEBUG_HITS: 'kh:debug:hits',            // 返回当前命中注册表快照（不改任何行为）
    DEBUG_DIAG: 'kh:debug:diag',            // 只读诊断：重建计数 / 最近触发来源 / 仅消费次数 / 相关性判定

    /* ---- editor ---- */
    /* popup 的「＋ 快速添加」→ 让**当前网页**弹出与选项页 1:1 的编辑器。
     * 为什么不在 popup 里弹：Chrome 弹窗上限 800×600，而编辑器是三列 860px，
     * 挤进去只会塌成一列（用户实测："实现方式很奇怪，我设想的是直接在当前页一比一复刻"）。 */
    EDITOR_OPEN: 'kh:editor:open',

    /* ---- ocr（图片文字识别；内容脚本 ↔ background ↔ offscreen 文档三段中转） ----
     * 【为什么必须有 offscreen 这一层】MV3 的内容脚本不能建扩展本地 worker（要跨源 + 页面 CSP
     * 会拦 wasm），后台 service worker 又不能建 worker（且 30s 空闲即被杀）——
     * 真浏览器实测（`_e2e/probe-ocr*.js`）：只有在**扩展自己的页面**（offscreen 文档）里
     * `new Worker(chrome.runtime.getURL(...))` + 本地 wasm 才稳。
     * 消息一律经 background 中转（内容脚本不直接与 offscreen 通信），并带 `to` 标记防回环。 */
    OCR_IMAGE: 'kh:ocr:image',              // 识别一张图：{src|dataUrl, keyword, ...} → {requestId}
    OCR_CANCEL: 'kh:ocr:cancel',            // 丢弃某标签页待处理的识别任务（重建/离页时）
    OCR_RESULT: 'kh:ocr:result',            // offscreen → background（再按 requestId 送回发起方）
    OCR_LANG_STATE: 'kh:ocr:langState',     // 语言包状态：每个语言是否已就绪 + 占用字节
    OCR_LANG_DOWNLOAD: 'kh:ocr:langDownload', // 运行时下载（sha256 校验后落本地缓存）
    OCR_LANG_IMPORT: 'kh:ocr:langImport',   // 手动导入（离线；base64 传字节）
    OCR_LANG_CLEAR: 'kh:ocr:langClear',     // 清除本地语言包缓存
    OCR_PROGRESS: 'kh:ocr:progress'         // 进度（语言包下载各阶段 / 排队情况）
  };

  const ACTION_RESULT = { OK: 'ok', ERROR: 'error' };

  KH.MSG = MSG;
  KH.ACTION_RESULT = ACTION_RESULT;

  if (typeof module !== 'undefined' && module.exports) module.exports = { MSG, ACTION_RESULT };
})();
