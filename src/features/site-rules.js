/* ============================================================================
 * src/features/site-rules.js · 站点规则（域名级 + 网址级 + 本地临时禁用）
 * ----------------------------------------------------------------------------
 * 语义**逐条对齐旧版 v1.52.0 `utils.js`**（不得改动判定顺序，否则线上行为会变）：
 *   ⓪ 标签页级临时禁用最优先（【2.0.7.2 需求⑤】只活在本页内存里，见下方 `tabDisabled`）
 *   ① 历史站点级禁用（siteDisabledMap 存量）其次 —— 命中即不高亮
 *      （旧按钮写的就是它；按钮改成标签页级后不再写它，但**存量继续生效** ——
 *        老用户升级不该被静默改变高亮行为，要撤销请到设置页那份「历史站点级禁用」列表里点掉）
 *   ② 网址级规则（scope='url'）先判；命中即按其 type 决定（whitelist=生效 / blacklist=不生效）
 *   ③ 再判域名级规则；命中同上
 *   ④ 一条都没命中：**存在任意白名单则默认不生效，否则默认生效**
 *
 * 统一化改造：旧版这个逻辑与"写 siteDisabledMap"分散在 content.js / service-worker.js /
 * options.js 三处各自实现（且 service-worker 用独立的 setSiteDisabled 包装）。
 * v2 收敛到本模块，三端一律调这里。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /* 【2.0.7.2 需求⑤】标签页级临时禁用 —— **只活在这个文档的内存里**：
   *   · 判定本身在 background 侧做（`chrome.storage.session` 只有扩展自己的页面/后台能读，
   *     内容脚本读不到；tabId 也只有 background 从 `sender.tab` 拿得到），
   *     内容脚本只在启动与收到推送时把结论记在这里；
   *   · 为什么不落 local：关了标签页、重启浏览器都该自动消失 —— 落了 local 就退化成
   *     "永久禁用整站"，正好是上一版被投诉的那个行为；
   *   · 为什么判据放在本模块：站点门禁的唯一实现是 `shouldHighlight`（`KH.boot()` 与
   *     `applyConfig()` 两条路径都经它），加在这里两条路径同时生效；分头改两处迟早漏一处。 */
  let tabDisabled = false;

  const SiteRules = {
    /** 本页是否被标签页级临时禁用（内容脚本启动时问 background、以及后台推送变更时写进来） */
    markTabDisabled(on) { tabDisabled = !!on; },
    isTabDisabled() { return tabDisabled; },

    /** 单条规则匹配（字段名与存储完全一致，防串位） */
    match(hostname, rule, url) {
      if (!rule || !rule.pattern) return false;
      const type = rule.matchType || 'exact';

      if (rule.scope === 'url') {
        const target = url || '';
        switch (type) {
          case 'prefix': return target.startsWith(rule.pattern);
          case 'regex':
            try { return new RegExp(rule.pattern).test(target); } catch (e) { return false; }
          default: return false;   // 网址级只支持 prefix / regex（与旧版一致）
        }
      }

      switch (type) {
        case 'exact': return hostname === rule.pattern;
        case 'subdomain': return hostname === rule.pattern || hostname.endsWith('.' + rule.pattern);
        case 'prefix': return hostname.startsWith(rule.pattern);
        case 'regex':
          try { return new RegExp(rule.pattern).test(hostname); } catch (e) { return false; }
        default: return false;
      }
    },

    /**
     * @param {string} hostname
     * @param {string} url
     * @param {object} cfg 完整配置
     * @returns {boolean}
     */
    shouldHighlight(hostname, url, cfg) {
      const rules = (cfg && cfg.siteRules) || [];
      const disabled = (cfg && cfg.siteDisabledMap) || {};

      /* 标签页级临时禁用：命中即"这个标签页里的任何网址都不走高亮"。
       * 只认内存标记（见文件上部 `tabDisabled`），不读任何存储 —— 内容脚本读不到 session 区。 */
      if (tabDisabled) return false;

      if (disabled[hostname]) return false;

      if (!rules.length) return true;

      for (const rule of rules) {
        if (rule.scope === 'url' && this.match(hostname, rule, url)) return rule.type === 'whitelist';
      }
      for (const rule of rules) {
        if (rule.scope !== 'url' && this.match(hostname, rule, url)) return rule.type === 'whitelist';
      }

      const hasWhitelist = rules.some(r => r.type === 'whitelist');
      return !hasWhitelist;
    },

    /** 本地临时禁用/启用当前站点（写 siteDisabledMap；该字段不随导出分享） */
    async toggleLocal(hostname) {
      const store = chrome.storage.local;
      const { siteDisabledMap = {} } = await store.get('siteDisabledMap');
      const next = !siteDisabledMap[hostname];
      if (next) siteDisabledMap[hostname] = true; else delete siteDisabledMap[hostname];
      await store.set({ siteDisabledMap });
      return !next; // 返回值语义：true = 该站点当前启用高亮
    }
  };

  KH.SiteRules = SiteRules;
})();
