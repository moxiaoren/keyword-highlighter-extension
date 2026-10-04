/* ============================================================================
 * src/features/site-rules.js · 站点规则（域名级 + 网址级 + 本地临时禁用）
 * ----------------------------------------------------------------------------
 * 语义**逐条对齐旧版 v1.52.0 `utils.js:364-425`**（不得改动判定顺序，否则线上行为会变）：
 *   ① 本地临时禁用（siteDisabledMap）最优先 —— 命中即不高亮
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

  const SiteRules = {
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
