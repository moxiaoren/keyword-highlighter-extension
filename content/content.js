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
  let suspendEnabled = true; // (v1.10.5) 标签页隐藏时暂停高亮开关，从配置读取默认开
  // v1.10.8：上次「URL 变化触发的全页先清后建」时间戳。同站点路由变化（翻页 ?page=2、切 Tab）
  // 的兜底重建需限频，防止高频路由抖动（如搜索联想连续改 query）反复清建导致闪烁。
  let _lastUrlRebuild = 0;
  // v1.10.14：翻页残留自动清扫状态
  let _prcEnabled = true;      // 总开关
  let _prcClick = true;        // 分页点击捕获开关
  let _prcMinGap = 2000;       // 最短重建间隔
  let _prcLastRebuild = 0;     // 上次重建时间戳（与 URL 重建共用同一限频口径，避免双套连击）
  let _prcBound = false;       // 是否已绑定

  /**
   * (v1.10.14) 页内「先清后建」重建（带限频）。
   * 供分页点击捕获 / 内容指纹轮询调用：内容变化后清旧高亮并重新高亮，避免上一页残留。
   */
  function prcClean(trigger) {
    if (!siteEnabled) return;
    const now = Date.now();
    if (now - _prcLastRebuild < _prcMinGap) return;  // 限频，防高动态/连点反复清建
    _prcLastRebuild = now;
    console.debug('[KeywordHighlighter] 翻页残留自动清扫:', trigger);
    refresh();
  }

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

      if (should === siteEnabled) {
        // v1.10.8：状态未变但 URL 变了（同站点翻页/切 Tab/筛选）。
        // 翻页时框架若复用行、只对单元格文本赋值，而高亮已把框架持有的文本节点摘离文档，
        // 改写会落在脱离文档的节点上、DOM 不产生任何变化事件，观察器收不到信号，
        // 上一页高亮/抓取值就残留到下一页（且新值进不来）。此处主动做一次
        // 「先清后建」兜底（refresh = teardown 清旧标记 + 重新高亮）。
        // 外层已有 150ms 防抖合并连续跳转；再限频 800ms 防高频路由抖动反复清建。
        if (should && siteEnabled) {
          const now = Date.now();
          if (now - _lastUrlRebuild >= 800) {
            _lastUrlRebuild = now;
            await refresh();
          }
        }
        return; // 状态未变，无需处理（清建兜底已在上文完成）
      }

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
   * (v1.10.16) 历史说明：此前「复用行改单元格文本时改写落在被高亮摘离文档的旧节点上→DOM 无事件→残留」。
   * 该根因已由 v1.10.15（普通词）+ v1.10.16（组合词）统一改为 CSS Highlight（文本节点不摘离）根治。
   * 此处仅保留「分页控件点击捕获」作为主动重建信号（快速精准），v1.10.15 起已移除内容指纹轮询。
   */
  function setupPageResidualClean() {
    if (_prcBound) return;
    _prcBound = true;
    // 实时读取配置（currentConfig 由异步 init 填充，refreshed 后也会更新；此处每次动作前重读）
    const readCfg = () => {
      const c = currentConfig || {};
      _prcEnabled = c.pageResidualClean !== false;
      _prcClick = _prcEnabled && c.pageCleanClick !== false;
      _prcMinGap = (c.pageCleanMinGap && c.pageCleanMinGap > 0) ? c.pageCleanMinGap : 2000;
    };
    readCfg();

    // ① 分页控件点击捕获：capture 阶段优先截获，命中分页特征即触发重建
    if (_prcClick) {
      document.addEventListener('click', (e) => {
        if (!siteEnabled) return;
        readCfg();
        if (!_prcClick) return;
        const el = e.target;
        const node = el && el.closest ? el.closest('button,a,li,[role="button"],.pagination,.pager,.page,.ant-pagination,[class*="pagination"],[class*="-page"],[class*="page-"]') : null;
        if (!node) return;
        const isPage = (() => {
          // 文本特征：下一页/上一页/首页/末页/纯数字页码/省略号/箭头
          const label = node.textContent.trim() || node.getAttribute('aria-label') || '';
          if (/下一页|上一页|首页|末页|‹|›|«|»|…|\.\.\./.test(label)) return true;
          // aria-label 含「页」
          const aria = node.getAttribute('aria-label') || '';
          if (/页|page/i.test(aria)) return true;
          // 纯数字页码按钮（1~3 位数字）
          if (/^\d{1,3}$/.test(label)) return true;
          return false;
        })();
        if (isPage) prcClean('click:' + (node.textContent.trim() || node.getAttribute('aria-label') || '').slice(0, 12));
      }, true);
    }

    // ② 内容指纹轮询：v1.10.15 起移除。
    // 根因：普通词高亮已改 CSS Custom Highlight，文本节点不再被摘离，框架翻页对原节点赋值
    // 会直接写入 DOM 并触发 characterData → MutationObserver 增量重建自动完成，无需指纹采样兜底。
    // （组合词仍整格重建，同样走 DOM 事件。指纹轮询已冗余，故删除。）
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
      suspendEnabled = data.suspendInactiveTab !== false;

      // 无论是否高亮都初始化置顶笔记组件（供各分支统一清理）；传入配置以读取相邻单元格标注开关
      await ImportantNote.init(data);

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
      // 值刷新重抓 v1.10.7 起由引擎的 MutationObserver 统一调度（见 setupMutationObserver 内 scheduleRefetch），
      // 与高亮批次解耦、不受编辑区防护影响；这里只负责面板刷新，避免两处重复触发重抓。
      KeywordEngine.onHighlight = () => {
        ImportantNote.refresh();
      };

      // 执行高亮
      // 【v1.10.11 修复】先建立 MutationObserver 再执行首扫：真实动态表格中
      // 首扫时组合词右格往往还是空/默认值，真实值（值后到）可能在首扫之后、
      // observer 建立之前填充——该变化若不被观察会导致组合词验证失败后永不补救
      // （用户症状：首次加载组合词/重要笔记缺失，切回标签页触发全量重扫才恢复）。
      // 调整顺序后首扫之后的任何 DOM 变化（含值后到）都在观察范围内，增量链路会捕获并补救。
      KeywordEngine.setupMutationObserver(currentKeywords, data);
      await KeywordEngine.highlightKeywords(currentKeywords, data);
      ImportantNote.refresh();
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

  // 标签页隐藏时暂停高亮（断开观察器+清理），重新可见时重建（节省后台资源，默认开启可在设置中关闭）
  function setupVisibilitySuspend() {
    if (window.__kh_visBound) return;
    window.__kh_visBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!suspendEnabled) return;
      try {
        if (document.hidden) {
          // 仅当本页处于「应高亮」状态才下线；禁用态本无高亮，跳过避免无谓清理
          if (siteEnabled) teardown();
        } else {
          // 切回可见：若状态为应高亮则重建（init 内部会再次评估是否禁用）
          if (siteEnabled) refresh();
        }
      } catch (err) {
        console.error('[KeywordHighlighter] 可见性切换处理失败:', err);
      }
    });
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setupUrlChangeListener();
      setupVisibilitySuspend();
      setupPageResidualClean();
    });
  } else {
    init();
    setupUrlChangeListener();
    setupVisibilitySuspend();
    setupPageResidualClean();
  }
})();
