/**
 * 后台 Service Worker
 * 处理快捷键、图标状态更新、统计等
 */
'use strict';

// 加载本地存储模块（Service Worker 环境）
importScripts('../lib/storage.js', '../lib/update-checker.js');

// 更新检测：启动/安装时 + 每 6 小时检查一次，结果存入 storage 供 popup 读取
const UPDATE_CHECK_INTERVAL_MIN = 360; // 6 小时

// 当前本地版本（以 manifest 为准）
function currentVersion() {
  try {
    return chrome.runtime.getManifest().version || '0.0.0';
  } catch (e) {
    return Storage.defaults.version || '0.0.0';
  }
}

async function checkForUpdates() {
  const info = await UpdateChecker.check(currentVersion());
  await chrome.storage.local.set({ khUpdateInfo: info });
  // 有更新时在图标上显示角标提示（方案 B：popup 内提供详细提示与更新入口）
  if (info && info.hasUpdate) {
    chrome.action.setBadgeBackgroundColor({ color: '#e53935' }).catch(() => {});
    chrome.action.setBadgeText({ text: '↑' }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
  return info;
}


// 安装/更新时初始化
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // 首次安装，打开欢迎页
    chrome.tabs.create({
      url: chrome.runtime.getURL('welcome/welcome.html')
    });

    // 初始化默认配置
    await Storage.set({
      globalEnabled: true,
      version: '1.0.0'
    });
  }

  // 更新后自动打开欢迎页，展示近期更新（welcome 页会按版本差异弹出更新日志）
  if (details.reason === 'update') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }

  // 每次安装/更新后立即检查更新
  checkForUpdates();

  // 创建定时检查 alarm
  chrome.alarms.create('checkUpdate', { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
});

// 浏览器启动时也检查一次
chrome.runtime.onStartup.addListener(() => {
  checkForUpdates();
});

// 快捷键处理
chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'toggle-highlight':
      await toggleGlobalHighlight();
      break;
    case 'toggle-site':
      await toggleCurrentSite();
      break;
    case 'open-settings':
      chrome.runtime.openOptionsPage();
      break;
  }
});

/**
 * 切换全局高亮
 */
async function toggleGlobalHighlight() {
  const data = await Storage.get(['globalEnabled']);
  const newState = !data.globalEnabled;
  await Storage.set({ globalEnabled: newState });
  
  // 更新图标
  updateIcon(newState);
  
  // 通知所有标签页刷新
  notifyAllTabs('toggleGlobal');
}

/**
 * 临时禁用/启用当前站点
 */
async function toggleCurrentSite() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;

  const url = new URL(tabs[0].url);
  const hostname = url.hostname;

  const map = await Storage.getSiteDisabledMap();
  if (map[hostname]) {
    await Storage.setSiteDisabled(hostname, false);
  } else {
    await Storage.setSiteDisabled(hostname, true);
  }

  notifyAllTabs('refresh');
  
  // 更新弹出窗口
  chrome.runtime.sendMessage({ action: 'updatePopup' }).catch(() => {});
}

/**
 * 通知所有标签页
 */
async function notifyAllTabs(action) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
  }
}

/**
 * 更新工具栏图标状态
 */
async function updateIcon(globalEnabled) {
  const iconSuffix = globalEnabled ? '' : '-paused';

  // 必须用完整 URL，相对路径会触发 "Failed to fetch"
  chrome.action.setIcon({
    path: {
      '16': chrome.runtime.getURL(`icons/icon16${iconSuffix}.png`),
      '32': chrome.runtime.getURL(`icons/icon32${iconSuffix}.png`),
      '48': chrome.runtime.getURL(`icons/icon48${iconSuffix}.png`),
      '128': chrome.runtime.getURL(`icons/icon128${iconSuffix}.png`)
    }
  }).catch(err => console.warn('更新图标失败:', err));
}

// 监听来自 popup 的消息（手动检查更新 / 读取已缓存更新信息）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'checkUpdate') {
    checkForUpdates().then((info) => sendResponse({ ok: true, info }));
    return true; // 异步响应
  }
  if (message && message.action === 'getUpdateInfo') {
    chrome.storage.local.get('khUpdateInfo').then((res) => {
      sendResponse({ ok: true, info: res.khUpdateInfo || null });
    });
    return true;
  }
  return false;
});

// 监听存储变更，更新图标
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.globalEnabled) {
    updateIcon(changes.globalEnabled.newValue);
  }
});

// 初始化图标
(async () => {
  const data = await Storage.get(['globalEnabled']);
  updateIcon(data.globalEnabled);
})();

// 定期清理旧统计数据（超过30天）
chrome.alarms.create('cleanupStats', { periodInMinutes: 1440 }); // 每天一次

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cleanupStats') {
    // 统计保留30天，目前简化实现不清除
    console.debug('[KeywordHighlighter] 统计清理检查');
  }
  if (alarm.name === 'checkUpdate') {
    checkForUpdates();
  }
});
