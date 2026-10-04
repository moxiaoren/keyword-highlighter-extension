/* ============================================================================
 * content/content.js · 内容脚本入口（唯一启动点）
 * ----------------------------------------------------------------------------
 * 职责只有四件事，**不含任何业务逻辑**（铁律 §2：不许自己实现管线）：
 *   1. 调用 `KH.boot()` 启动
 *   2. 监听 storage 变化 → `KH.applyConfig()`
 *   3. 响 background 的快捷键消息（切换全局 / 切换本站 / 打开设置）
 *   4. 页面卸载时 `KH.destroy()`
 * ========================================================================= */

(function () {
  'use strict';

  if (window.__KH_CONTENT_BOOTED__) return;   // 防重复注入（all_frames + 动态注入可能叠加）
  window.__KH_CONTENT_BOOTED__ = true;

  const KH = window.KH;
  if (!KH) {
    console.warn('[KH] 核心模块未加载，内容脚本退出');
    return;
  }

  /* ---------------- ① 启动 ---------------- */

  /**
   * 就绪标记（`<html data-kh-state="on|off">`）—— 实现已收敛到内核 `KH.markState`
   * （原因：URL 变化触发的那次重评走内核 `boot()`，不经过内容脚本的这几条路径，
   *  标记必须由内核统一发布才不会停在旧值）。这里保留同名转调，避免调用点散落。
   */
  function markState(ok) {
    if (KH.markState) { KH.markState(ok); return; }
    try { document.documentElement.setAttribute('data-kh-state', ok ? 'on' : 'off'); }
    catch (err) { /* documentElement 不可写时忽略 */ }
  }

  KH.boot().then((ok) => {
    markState(ok);
    console.debug('[KH] boot', ok ? '高亮态' : '未启用',
      'v' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?'),
      'build ' + (KH.BUILD_TIME || 'dev'));
  }).catch((err) => {
    markState(false);
    console.error('[KH] boot 失败', err);
  });

  /* ---------------- ② 配置热更新 ---------------- */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      const patch = {};
      for (const k of keys) patch[k] = changes[k].newValue;
      /* applyConfig 会**复核站点门禁**（白名单 / 禁用本站 / 全局开关都走这条路径），
       * 返回的 siteEnabled 是这次热更新后的真实状态，就绪标记必须跟着它走 ——
       * 否则白名单生效、高亮已经下线，标记却仍停在 on（诊断与回归都会看错）。 */
      KH.applyConfig(patch)
        .then((res) => markState(!!(res && res.siteEnabled)))
        .catch(err => console.error('[KH] 配置热更新失败', err));
    });
  } catch (err) {
    console.warn('[KH] storage.onChanged 不可用（扩展上下文已失效？）', err);
  }

  /* ---------------- ③ 快捷键 / 消息路由（统一协议，禁止硬编码字符串） ---------------- */

  const MSG = KH.MSG;

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      switch (msg.type) {
        case MSG.GLOBAL_CHANGED:
          /* 全局开关也要过门禁：全局开了但本站被白名单排除 / 被临时禁用时，
           * 实际仍处于失效态 —— 标记与回执都按 applyConfig 的真实结果给。 */
          KH.applyConfig({ globalEnabled: !!msg.value })
            .then((res) => {
              const on = !!(res && res.siteEnabled);
              markState(on);
              sendResponse({ ok: true, globalEnabled: !!msg.value, siteEnabled: on });
            })
            .catch(e => sendResponse({ ok: false, error: String(e) }));
          return true;

        case MSG.SITE_CHANGED:
          // 「临时禁用本站」已由 background 落盘（siteDisabledMap），这里只需按新状态重评并上线/下线
          KH.boot().then(ok => { markState(ok); sendResponse({ ok: true, siteEnabled: ok }); })
            .catch(e => sendResponse({ ok: false, error: String(e) }));
          return true;

        case MSG.SITE_TOGGLE: {
          // 兜底路径：万一 background 没在跑（例如扩展刚更新过、SW 尚未唤醒），
          // 由内容脚本自己翻转本机禁用状态并落盘 —— storage.onChanged 会把状态同步到其它标签页。
          (async () => {
            try {
              const host = location.hostname;
              const { siteDisabledMap = {} } = await chrome.storage.local.get('siteDisabledMap');
              const next = !siteDisabledMap[host];
              if (next) siteDisabledMap[host] = true; else delete siteDisabledMap[host];
              await chrome.storage.local.set({ siteDisabledMap });
              const ok = await KH.boot();
              markState(ok);
              sendResponse({ ok: true, host, disabled: next, siteEnabled: ok });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;
        }

        case MSG.REBUILD_REQUEST:
          try {
            const r = KH.rebuild({ source: 'request' });
            sendResponse(Object.assign({ ok: true, type: MSG.REBUILD_DONE }, r));
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
          return false;

        case MSG.EDITOR_OPEN:
          /* popup 的「＋ 快速添加」→ 在当前网页弹 1:1 编辑器。
           * 只由**顶层 frame** 响应：all_frames=true 时消息会送到每个 iframe，
           * 不守卫的话每个 iframe 都会弹一个编辑器；
           * 非顶层**不回话**（返回 false 且不调 sendResponse），让顶层那次的回执生效。 */
          if (window.top !== window) return false;
          (async () => {
            try {
              const ok = await KH.PageEditor.open(msg.keyword || null);
              sendResponse({ ok: !!ok });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case MSG.STATE_QUERY:
          sendResponse({
            ok: true,
            siteEnabled: !!KH.state.siteEnabled,
            globalEnabled: !!(KH.config && KH.config.globalEnabled),
            hits: KH.registry.size,
            rules: KH.rules.length,
            version: KH.version,
            // 扩展点登记情况（诊断用；UN-06 据此验证"新功能只注册不改内核"）
            adapters: KH.Compiler ? KH.Compiler.adapters.names() : [],
            probes: KH.Scanner ? KH.Scanner.probes.names() : [],
            features: KH.features ? KH.features.names() : []
          });
          return false;

        /**
         * 命中快照（**只读诊断**，不改任何高亮行为）。
         * 为什么需要：内容脚本在隔离世界，页面主世界（DevTools 控制台 / 真浏览器自动化）
         * 看不到 `window.KH`，而"到底哪些词、在哪个节点、什么区间命中了"只有注册表知道。
         * 没有这个口子，真浏览器回归只能靠"肉眼 + 截图"，无法自动断言
         * （`tests/` 里的 Node 单测覆盖纯逻辑，几何/布局类必须真浏览器验证）。
         * `msg.fetch === true` 时附带抓取结果，便于核对抓取链路口径。
         */
        /* ---- 只读诊断（P1/P2 之后新增）----
         * popup 的「🩺 诊断」按钮读它：重建次数 / 最近触发来源 / 仅消费次数 / 最近一次相关性判定 /
         * 高亮组与命中规模 / 图片识别的排队情况。**只读**，不改任何行为，
         * 用来回答"这个页面为什么重建这么多次、为什么卡"（见 tests/E2E-REPORT.md K54）。 */
        case MSG.DEBUG_DIAG: {
          sendResponse(KH.diagnostics ? KH.diagnostics() : { ok: false, error: 'KH.diagnostics 不可用' });
          return;
        }

        case MSG.DEBUG_HITS: {
          const fetchOn = !!(msg && msg.fetch);
          const dump = {
            total: KH.registry ? KH.registry.size : -1,
            rules: (KH.rules || []).map(r => ({
              kind: r.kind, probe: r.probe, ruleId: r.ruleId, raw: r.raw,
              label: r.meta && r.meta.label, core: r.meta && r.meta.coreRaw,
              pattern: r.pattern ? r.pattern.source : null,
              labelPattern: r.labelPattern ? r.labelPattern.source : null
            })),
            // 自检：当前页面 DOM 上出现过的全部插件属性（应只有 data-kh-ext-ui / -state / -hl-style）
            attrs: (function () {
              const seen = new Set();
              try {
                for (const el of document.querySelectorAll('*')) {
                  for (const a of Array.from(el.attributes || [])) if (a.name.indexOf('data-kh') === 0) seen.add(a.name);
                }
              } catch (e) { /* ignore */ }
              return Array.from(seen);
            })(),
            hits: (KH.registry && KH.registry.all ? KH.registry.all() : []).map(h => ({
              id: h.id,
              ruleId: h.ruleId,
              kind: h.kind,
              visual: h.visual !== false,
              textNode: h.textNode ? (h.textNode.nodeValue || '').slice(0, 60) : null,
              parentTag: h.textNode && h.textNode.parentElement ? h.textNode.parentElement.tagName : null,
              start: h.start,
              end: h.end,
              hitText: h.textNode ? (h.textNode.nodeValue || '').slice(h.start, h.end) : '',
              meta: h.meta ? {
                display: h.meta.display, label: h.meta.label, fetchLabels: h.meta.fetchLabels,
                fetchOnly: h.meta.fetchOnly, important: h.meta.important,
                importantNote: h.meta.importantNote, note: h.meta.note,
                axis: h.meta.axis, imgSize: h.meta.imgSize, impNoteBg: h.meta.impNoteBg
              } : null,
              fetchHtml: fetchOn && KH.Fetch && h.textNode
                ? (function () { try { return KH.Fetch.blockFor(h.textNode, h.meta && h.meta.fetchLabels) || ''; } catch (e) { return 'ERR:' + e.message; } })()
                : undefined
            }))
          };
          sendResponse({ ok: true, dump });
          return false;
        }

        default:
          return false;
      }
    });
  } catch (err) {
    console.warn('[KH] runtime.onMessage 不可用', err);
  }

  /* ---------------- ④ 卸载 / 前后退缓存（bfcache） ---------------- */

  /**
   * 【进入 bfcache 时**不要**下线】用户实测过一类"刷新就好"的毛病，这也是一条：
   * 旧实现在 `pagehide` 里**无条件** `destroy()`，而页面进入"后退/前进缓存"时同样会发
   * `pagehide`（此时 `event.persisted === true`，页面只是被冻结、随时会原样恢复）——
   * 下线把高亮与全部状态清掉，而恢复时没有任何事件把它救回来（全库此前没有 `pageshow` 处理）
   * → 从缓存回来的页面永久不高亮，只能刷新。
   * 所以：`persisted === true`（进缓存）→ 什么都不做，保持现成状态，恢复即可用；
   *       `persisted === false`（真卸载）→ 照旧下线，释放资源。
   */
  window.addEventListener('pagehide', (e) => {
    if (e && e.persisted) return;
    try { KH.destroy(); } catch (err) { /* 页面正在销毁，忽略 */ }
    markState(false);
  });

  /**
   * 【从 bfcache 恢复 → 重新启动一次】兜底：万一状态已被清掉（例如真卸载路径先跑过、
   * 或浏览器/扩展更新导致旧上下文失效），恢复时必须能自己站起来，而不是等用户刷新。
   * `boot()` 本身幂等（内部先 destroy 再按最新配置上线），在这里调用是安全的。
   */
  window.addEventListener('pageshow', (e) => {
    if (!(e && e.persisted)) return;
    KH.boot().then(markState).catch((err) => {
      markState(false);
      console.error('[KH] bfcache 恢复后重启失败', err);
    });
  });
})();
