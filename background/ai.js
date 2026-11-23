/**
 * background/ai.js · 面板「AI 助手」的**唯一请求出口**
 * ----------------------------------------------------------------------------
 * 【2.0.16.4 · 用户 m19483】只保留太极AI 一条通路。
 *   用户原话：「只保留太极 AI，其余 AI 接口和调用路径全部移除」。
 *   因此删掉了两条老通路：
 *     · DeepSeek 网页对话（要开 chat.deepseek.com 标签页，靠 content/web-chat.js 打字读回复）；
 *     · OpenAI 兼容 API（设置里填 baseUrl / apiKey / model 那条）。
 *   对话一律转给 background/taiji.js：走站点自己的登录会话（cookie）、模型清单与 SSE。
 *   好处：不再出现任何对话页标签页，也不用用户自备 Key。
 * 仍然放在后台的原因：内容脚本里的 fetch 按**页面来源**走 CORS，站点不会给任意网站放行；
 *   service worker 是扩展自己的来源 + host_permissions: <all_urls> 才发得出去。
 *
 * 隐私：账号存本机 storage；密码只在登录那一次请求里出现，不写 storage、不写日志、不进导出。
 * ========================================================================= */

(function () {
  'use strict';

  const AI = {};

  /** 当前配置里的 `ai` 段（读 storage → Config.merge/normalize 这条唯一归一）。 */
  function readConfig() {
    return Promise.resolve()
      .then(() => chrome.storage.local.get(null))
      .then((all) => {
        const C = self.KH && self.KH.Config;
        if (!C || typeof C.merge !== 'function') return {};
        const merged = C.merge(all || {});
        const normalized = (typeof C.normalize === 'function') ? C.normalize(merged).config : merged;
        return (normalized && normalized.ai) || {};
      })
      .catch(() => ({}));
  }

  /**
   * 发一次对话（面板 AI 分页、设置页「测试连接」共用）。
   * @param {{messages?: Array, model?: string, override?: Object, timeoutMs?: number}} msg
   * @returns {Promise<{ok:boolean, text?:string, error?:string, needLogin?:boolean, usage?:Object}>}
   */
  AI.chat = async function (msg) {
    const payload = msg || {};
    const ai = await readConfig();
    if (ai.enabled === false) return { ok: false, error: 'AI 助手已在设置里关闭' };
    if (!self.KhTaiji) return { ok: false, error: '太极AI 通道没加载（扩展需要更新）' };
    return self.KhTaiji.chat(payload);
  };

  /** 设置页「测试连接」：发一句最短的，确认真能收到回复。 */
  AI.test = function (override) {
    return AI.chat({ messages: [{ role: 'user', content: '你好' }], override: override || null });
  };

  /* ---------------- 太极AI：设置页的登录 / 模型清单 / 退出 ---------------- */

  AI.taijiLogin = function (msg) {
    return (self.KhTaiji && self.KhTaiji.login) ? self.KhTaiji.login(msg || {})
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
  };
  AI.taijiModels = function () {
    return (self.KhTaiji && self.KhTaiji.models) ? self.KhTaiji.models()
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
  };
  AI.taijiLogout = function () {
    return (self.KhTaiji && self.KhTaiji.logout) ? self.KhTaiji.logout()
      : Promise.resolve({ ok: false, error: '太极AI 通道没加载（扩展需要更新）' });
  };

  self.KhAi = AI;
})();
