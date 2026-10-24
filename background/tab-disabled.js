/* ============================================================================
 * background/tab-disabled.js · 标签页级临时禁用（【2.0.7.2 需求⑤】）
 * ----------------------------------------------------------------------------
 * 用户口径：「禁用本站，改成禁用本标签页 —— 只针对这个标签页，不管打开什么网址都不走高亮，
 * 关闭这个标签页就自动取消禁用。其他标签页不受影响。」
 *
 * 三个决定，每条对应上面那句话里的一个从句：
 *   ① 键是 **tabId**，不是 hostname —— 按 hostname 记就必然错两头：同站点的别的标签页跟着被禁
 *      （用户要的是"只这个标签页"），而这个标签页跳到别的域名又会漏禁（用户要的是"不管打开什么网址"）。
 *   ② 存 `chrome.storage.session` —— 它随浏览器进程结束自动清空，正好满足"重启/重装不残留"；
 *      存 local 就变成跨会话的永久禁用（上一版 storage.local.siteDisabledMap 的病根）。
 *      权限不需要新增：manifest 已有 `storage`，session 区是同一条权限下的另一个分区。
 *   ③ 关标签页 = 立刻删键（`service-worker.js` 的 `tabs.onRemoved` 调 `clearTab`）。
 *      不删也能"消失"（页面没了自然不高亮），但 **tabId 会被浏览器复用** ——
 *      残留记录会让新标签页一开就是禁用态，所以必须主动删。
 *
 * 为什么单列一个文件：service-worker.js 只管路由；这份状态本身要能被单测直接加载
 * （`tests/specs/tab-disable.test.js` 注入假 chrome.storage.session 跑）。
 * ========================================================================= */
'use strict';

(function () {
  const KH = (typeof self !== 'undefined' ? (self.KH = self.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** session 区里的唯一键：`{ "<tabId>": true }` */
  const KEY = 'disabledTabs';

  /** session 区拿不到时（旧浏览器 / 单测垫片没装）当"没有禁用记录"，绝不把异常抛给调用方 */
  function area() {
    try { return chrome.storage.session || null; } catch (e) { return null; }
  }

  async function readAll() {
    const st = area();
    if (!st) return {};
    const got = await st.get(KEY);
    return (got && got[KEY]) || {};
  }

  /** 写回整表；空表就删键 —— 留个 `{}` 会让"当前没有任何禁用"看起来像"有记录"，排查时误判 */
  async function writeAll(map) {
    const st = area();
    if (!st) return;
    if (Object.keys(map).length) await st.set({ [KEY]: map });
    else await st.remove(KEY);
  }

  const TabDisabled = {
    KEY,

    async isDisabled(tabId) {
      if (tabId == null) return false;
      const map = await readAll();
      return !!map[String(tabId)];
    },

    /**
     * 设定某个标签页的禁用态，返回写完之后该标签页的**真实值**。
     * `on === undefined` ⇒ 翻转（快捷键 `toggle-site` 与设置页那个按钮走的是"切一下"）。
     * tabId 缺失时抛错而不是静默成功 —— 没有 tabId 就无从谈起"标签页级"。
     */
    async setDisabled(tabId, on) {
      if (tabId == null) throw new Error('缺少 tabId');
      const map = await readAll();
      const key = String(tabId);
      const next = (on === undefined) ? !map[key] : !!on;
      if (next) map[key] = true; else delete map[key];
      await writeAll(map);
      return next;
    },

    /** 标签页关闭 → 立刻删键（tabId 会被复用，留着就是"新标签页一开就灰"）。返回是否真删了。 */
    async clearTab(tabId) {
      if (tabId == null) return false;
      const map = await readAll();
      const key = String(tabId);
      if (!map[key]) return false;
      delete map[key];
      await writeAll(map);
      return true;
    }
  };

  KH.TabDisabled = TabDisabled;
})();
