/**
 * background/service-worker.js · 后台（MV3 Service Worker）
 * ----------------------------------------------------------------------------
 * 职责（严格限定，不含任何高亮业务逻辑）：
 *   1. 安装/更新：写默认值、打开欢迎页、启动更新轮询
 *   2. 快捷键：转发成统一消息给当前标签页 / 打开设置页
 *   3. 消息路由：统一走 `KH.MSG` 协议常量，禁止硬编码字符串
 *   4. 图标状态：随 globalEnabled 切换亮/灰图标
 *   5. 定时任务：更新检查（6h）
 *
 * 版本号唯一真源：manifest.json（本文件只读，不定义版本字面量）。
 */
'use strict';

importScripts('../src/core/protocol.js', 'update-checker.js', 'ocr.js');

const MSG = self.KH.MSG;
const UPDATE_CHECK_INTERVAL_MIN = 360;   // 6 小时

/** 版本唯一来源：manifest */
function currentVersion() {
  try { return chrome.runtime.getManifest().version || '0.0.0'; } catch (e) { return '0.0.0'; }
}

/* ---------------- 更新通道 ---------------- */

async function checkForUpdates() {
  const info = await self.UpdateChecker.check(currentVersion());
  await chrome.storage.local.set({ khUpdateInfo: info });
  try {
    if (info && info.hasUpdate) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
      await chrome.action.setBadgeText({ text: '↑' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* 图标 API 偶发失败不影响主流程 */ }
  return info;
}

/* ---------------- 图标 ---------------- */

async function updateIcon(globalEnabled) {
  const suffix = globalEnabled ? '' : '-paused';
  const path = {
    16: chrome.runtime.getURL(`icons/icon16${suffix}.png`),
    32: chrome.runtime.getURL(`icons/icon32${suffix}.png`),
    48: chrome.runtime.getURL(`icons/icon48${suffix}.png`),
    128: chrome.runtime.getURL(`icons/icon128${suffix}.png`)
  };
  try { await chrome.action.setIcon({ path }); } catch (e) { console.warn('[KH] 更新图标失败', e); }
}

/* ---------------- 标签页广播 ---------------- */
async function broadcast(type, payload) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, Object.assign({ type }, payload || {})).catch(() => {})));
}

/* ---------------- 安装 / 更新 ---------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    /* 【升级后必须清掉上一次检查的结论】否则缓存里那份 "hasUpdate:true"（当时本地还是旧版本）
     * 会让弹窗一直显示「发现新版本 v<刚装上的这个版本>」（实测 bug）。徽标也一起清，避免残留 ↑。 */
    try {
      await chrome.storage.local.remove('khUpdateInfo');
      await chrome.action.setBadgeText({ text: '' });
    } catch (e) { /* 存储/徽标失败不影响安装流程 */ }
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
  await checkForUpdates();
  chrome.alarms.create('checkUpdate', { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdates();
  chrome.alarms.create('checkUpdate', { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
});

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'toggle-highlight': {
      const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
      await chrome.storage.local.set({ globalEnabled: !globalEnabled });
      await updateIcon(!globalEnabled);
      await broadcast(MSG.GLOBAL_CHANGED, { value: !globalEnabled });
      break;
    }
    case 'toggle-site': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) break;
      await chrome.tabs.sendMessage(tabs[0].id, { type: MSG.SITE_TOGGLE }).catch(() => {});
      break;
    }
    case 'open-settings':
      chrome.runtime.openOptionsPage();
      break;
  }
});

/* ---------------- 消息路由（统一协议） ---------------- */

const HANDLERS = {
  [MSG.STATE_QUERY]: async () => {
    const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
    return { ok: true, globalEnabled, version: currentVersion() };
  },

  [MSG.GLOBAL_TOGGLE]: async (msg) => {
    const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
    const next = (msg.value === undefined) ? !globalEnabled : !!msg.value;
    await chrome.storage.local.set({ globalEnabled: next });
    await updateIcon(next);
    await broadcast(MSG.GLOBAL_CHANGED, { value: next });
    return { ok: true, globalEnabled: next };
  },

  [MSG.SITE_TOGGLE]: async (msg, sender) => {
    const url = (msg.url || (sender && sender.tab && sender.tab.url) || '');
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return { ok: false, error: '无法解析主机名' }; }
    if (!host) return { ok: false, error: '无法解析主机名' };

    const { siteDisabledMap = {} } = await chrome.storage.local.get('siteDisabledMap');
    const next = !siteDisabledMap[host];
    if (next) siteDisabledMap[host] = true; else delete siteDisabledMap[host];
    await chrome.storage.local.set({ siteDisabledMap });
    await broadcast(MSG.SITE_CHANGED, { host, disabled: next });
    return { ok: true, host, disabled: next };
  },

  [MSG.UPDATE_CHECK]: async () => ({ ok: true, info: await checkForUpdates() }),

  [MSG.UPDATE_INFO]: async () => {
    const { khUpdateInfo = null } = await chrome.storage.local.get('khUpdateInfo');
    return { ok: true, info: khUpdateInfo };
  },

  /* ---- ocr：内容脚本/设置页 → background → offscreen 文档（引擎在那里跑） ---- */
  [MSG.OCR_IMAGE]: (msg, sender) => self.OcrHost.submitImage(msg, sender),

  [MSG.OCR_CANCEL]: (msg, sender) => self.OcrHost.cancelTab(
    (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId
  ),

  [MSG.OCR_LANG_STATE]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_DOWNLOAD]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_IMPORT]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_CLEAR]: (msg) => self.OcrHost.ask(msg),
  'kh:ocr:selftest': (msg) => self.OcrHost.submitImage(msg, { tab: null, url: 'chrome-extension://ui/' })
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* offscreen 文档的回执/结果先给中转站（它按 requestId 决定"回 promise"还是"送回标签页"） */
  if (msg && msg.to === 'background' && self.OcrHost && self.OcrHost.onOffscreenMessage(msg)) return false;
  /* ⚠️ 带 `to` 标记的消息是**我们自己发出去的**（发给 offscreen / 广播给 UI）：
   * onMessage 是"所有扩展上下文都能收到"的，不在这里挡掉，背景自己就会把
   * `{to:'offscreen', type: ocr:image}` 当成"内容脚本的识别请求"再转发一次 → 无限自圈。 */
  if (msg && msg.to) return false;
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // 异步响应
});

/* 标签页关闭 → 丢掉它在排队的识别任务（免得为一个已经不存在的页面白烧 CPU） */
chrome.tabs.onRemoved.addListener((tabId) => {
  try { self.OcrHost.cancelTab(tabId); } catch (e) { /* ignore */ }
});

/* ---------------- 存储变更 → 图标 ---------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.globalEnabled) updateIcon(changes.globalEnabled.newValue);
});

/* ---------------- 定时任务 ---------------- */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUpdate') checkForUpdates();
});

/* ---------------- 冷启动自检 ---------------- */

(async () => {
  const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
  await updateIcon(globalEnabled);
  chrome.alarms.create('checkUpdate', { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
})();
