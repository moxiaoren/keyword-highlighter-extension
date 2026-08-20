/**
 * 内容脚本入口
 * 负责初始化高亮引擎和备注卡片系统
 */
(() => {
  'use strict';

  // 避免重复注入
  if (window.__kh_initialized) return;
  window.__kh_initialized = true;

  let currentKeywords = [];
  let currentConfig = null;
  // 记录当前会话是否处于「本页面应高亮」状态，用于判断 URL 变化后是否需要切换
  let siteEnabled = null;
  // 记录上次评估用的 URL，避免同一个路由变化重复处理
  let lastEvaluatedUrl = null;
  // 保存历史 API 原始实现，避免重复包装
  let _patched = false;
  // 轮询用：记住上次看到的 URL，用于兜底检测（覆盖不走 pushState/replaceState/hashchange 的 SPA 跳转）
  let _polledUrl = null;
  let _pollTimer = null;

  /**
   * 清理当前会话的高亮、观察器与笔记卡片（站内分页切换/禁用时用于「下线」）
   */
  function teardown() {
    KeywordEngine.destroy(); // 清空高亮 + 断开所有观察器
    NoteCard.destroy?.();
    ImportantNote.hide();
  }

  /**
   * 重新评估当前 URL 是否应高亮；状态变化时触发上线/下线（处理 SPA 站内分页切换）
   */
  async function reEvaluateSite() {
    const url = window.location.href;
    if (url === lastEvaluatedUrl) return;
    lastEvaluatedUrl = url;

    try {
      const data = currentConfig || await Storage.getAll();
      const hostname = Utils.getHostname();
      const should = await Utils.shouldHighlightForSite(
        hostname,
        data.siteRules || [],
        data.siteDisabledMap || {},
        url
      );

      if (should === siteEnabled) return; // 状态未变，无需处理

      if (should) {
        // 从「关」到「开」（例如黑名单分页切回白名单分页）
        siteEnabled = true;
        await refresh();
      } else {
        // 从「开」到「关」（例如白名单分页切到黑名单分页）：立即下线
        siteEnabled = false;
        teardown();
      }
    } catch (err) {
      console.error('[KeywordHighlighter] 站点规则评估失败:', err);
    }
  }

  /**
   * 监听 SPA 站内路由变化。
   * 采用「事件监听 + URL 轮询」双保险：
   * - 事件监听（pushState/replaceState/popstate/hashchange）作为快速路径；
   * - URL 轮询作为兜底：很多 SPA 框架缓存了原生 history 方法引用，
   *   直接调用原生实现而不走我们包装的版本，事件可能不触发；
   *   轮询比对 location.href 无论何种跳转方式都必然能捕获变化。
   */
  function setupUrlChangeListener() {
    if (_patched) return;
    _patched = true;

    // 防抖：同一次路由跳转可能触发多次
    const debounced = Utils.debounce(reEvaluateSite, 150);

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      debounced();
      return result;
    };
    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      debounced();
      return result;
    };
    window.addEventListener('popstate', debounced);
    window.addEventListener('hashchange', debounced);

    // 兜底轮询：每 600ms 检查一次 URL，变化即触发重估（防抖内部再去重）
    _polledUrl = window.location.href;
    const poll = () => {
      const url = window.location.href;
      if (url !== _polledUrl) {
        _polledUrl = url;
        debounced();
      }
      _pollTimer = setTimeout(poll, 600);
    };
    _pollTimer = setTimeout(poll, 600);
  }

  /**
   * 主初始化
   */
  async function init() {
    try {
      // 每次重新初始化先彻底清理旧状态，避免跨状态残留（观察器/高亮/卡片）
      teardown();

      const data = await Storage.getAll();
      currentConfig = data;

      // 无论是否高亮都初始化置顶笔记组件（供各分支统一清理）
      await ImportantNote.init();

      if (!data.globalEnabled) {
        console.debug('[KeywordHighlighter] 全局已暂停');
        siteEnabled = false;
        ImportantNote.hide();
        return;
      }

      // 检查站点是否禁用
      const hostname = Utils.getHostname();
      const shouldHighlight = await Utils.shouldHighlightForSite(
        hostname,
        data.siteRules || [],
        data.siteDisabledMap || {},
        window.location.href
      );
      siteEnabled = shouldHighlight;

      if (!shouldHighlight) {
        console.debug('[KeywordHighlighter] 当前站点已禁用');
        ImportantNote.hide();
        return;
      }

      currentKeywords = (data.keywords || []).filter(k => k.enabled);
      if (currentKeywords.length === 0) {
        ImportantNote.hide();
        return;
      }

      // 初始化备注卡片系统
      await NoteCard.init();

      // 绑定置顶悬浮重要笔记刷新回调
      KeywordEngine.onHighlight = () => { ImportantNote.refresh(); };

      // 执行高亮
      await KeywordEngine.highlightKeywords(currentKeywords, data);
      ImportantNote.refresh();
      KeywordEngine.setupMutationObserver(currentKeywords, data);
      if (data.shadowDOMEnabled) {
        KeywordEngine.setupShadowDOMObserver(currentKeywords, data);
      }

      console.debug(`[KeywordHighlighter] 已加载 ${currentKeywords.length} 个关键词`);
    } catch (err) {
      console.error('[KeywordHighlighter] 初始化失败:', err);
    }
  }

  /**
   * 刷新高亮（配置变更时）
   */
  async function refresh() {
    // 保留 lastEvaluatedUrl 之外的状态清理交由 init 内的 teardown 完成
    await init();
  }

  /**
   * 监听来自 popup/options 的消息
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message.action) {
        case 'refresh':
          await refresh();
          sendResponse({ success: true });
          break;

        case 'toggleGlobal':
          await refresh();
          sendResponse({ success: true });
          break;

        case 'getStats':
          const hits = await Storage.getTodayHits();
          sendResponse({ hits });
          break;

        case 'reapplyStyle':
          await NoteCard.applyCardStyle();
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    })();
    return true; // 保持消息通道开放
  });

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setupUrlChangeListener();
    });
  } else {
    init();
    setupUrlChangeListener();
  }
})();
