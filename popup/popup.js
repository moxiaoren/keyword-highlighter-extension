/**
 * Popup 脚本
 */
document.addEventListener('DOMContentLoaded', async () => {
  // 元素引用
  const globalToggle = document.getElementById('globalToggle');
  const siteName = document.getElementById('siteName');
  const siteBadge = document.getElementById('siteBadge');
  const todayHits = document.getElementById('todayHits');
  const keywordCount = document.getElementById('keywordCount');
  const btnToggleSite = document.getElementById('btnToggleSite');
  const btnToggleSiteText = document.getElementById('btnToggleSiteText');
  const btnToggleSiteIcon = document.getElementById('btnToggleSiteIcon');
  const globalState = document.getElementById('globalState');
  const btnAddKeyword = document.getElementById('btnAddKeyword');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnHelp = document.getElementById('btnHelp');
  // 更新提示条元素
  const updateBanner = document.getElementById('updateBanner');
  const updateText = document.getElementById('updateText');
  const btnUpdate = document.getElementById('btnUpdate');
  const btnUpdateDismiss = document.getElementById('btnUpdateDismiss');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const verBadge = document.getElementById('verBadge');

  let currentHostname = '';

  // 初始化
  async function init() {
    const data = await Storage.getAll();

    // 显示当前插件版本
    try {
      if (verBadge) verBadge.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {}
    
    // 全局开关
    globalToggle.checked = data.globalEnabled;
    updateGlobalState(data.globalEnabled);
    
    // 当前站点
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      try {
        const url = new URL(tabs[0].url);
        currentHostname = url.hostname;
        siteName.textContent = currentHostname;
        
        const siteDisabled = data.siteDisabledMap[currentHostname] || false;
        updateSiteStatus(siteDisabled);
      } catch (e) {
        siteName.textContent = '（无法获取）';
      }
    }

    // 统计
    const hits = await Storage.getTodayHits();
    todayHits.textContent = hits || '0';
    keywordCount.textContent = (data.keywords || []).length;
  }

  function updateGlobalState(enabled) {
    if (!globalState) return;
    globalState.textContent = enabled ? '全局高亮已开启' : '全局高亮已关闭';
  }

  function updateSiteStatus(disabled) {
    siteBadge.textContent = disabled ? '已禁用' : '生效中';
    siteBadge.classList.toggle('disabled', disabled);
    btnToggleSiteIcon.textContent = disabled ? '✅' : '🚫';
    btnToggleSiteText.textContent = disabled ? '启用本站' : '禁用本站';
    btnToggleSite.classList.toggle('site-disabled', disabled);
  }

  // 全局开关
  globalToggle.addEventListener('change', async () => {
    const enabled = globalToggle.checked;
    updateGlobalState(enabled);
    await Storage.set({ globalEnabled: enabled });
    
    // 通知所有标签页刷新
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'toggleGlobal' }).catch(() => {});
    }
  });

  // 临时禁用当前站点
  btnToggleSite.addEventListener('click', async () => {
    if (!currentHostname) return;
    
    const map = await Storage.getSiteDisabledMap();
    const currentlyDisabled = map[currentHostname] || false;
    await Storage.setSiteDisabled(currentHostname, !currentlyDisabled);
    updateSiteStatus(!currentlyDisabled);
    
    // 刷新当前标签页
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'refresh' }).catch(() => {});
    }
  });

  // 快速添加：弹出独立窗口，直接打开「添加关键词」完整弹窗（v1.6.37，不走设置页）
  btnAddKeyword.addEventListener('click', () => {
    openAddWindow();
  });

  // 完整设置：打开设置页（v1.7.0 修复点击无效——此前只声明未绑定事件）
  btnOpenSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 帮助：打开设置页并跳转到「帮助与隐私」分区（v1.7.0 修复点击无效）
  btnHelp.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#help') });
    window.close();
  });

  let addWindowId = null;
  async function openAddWindow() {
    const url = chrome.runtime.getURL('options/options.html?add');
    if (addWindowId !== null) {
      try { await chrome.windows.update(addWindowId, { focused: true }); return; }
      catch (e) { addWindowId = null; }
    }
    const W = 820, H = 680;
    let left = undefined, top = undefined;
    try {
      const f = await chrome.windows.getCurrent();
      if (f && f.width && f.height) {
        left = Math.round(f.left + (f.width - W) / 2);
        top = Math.round(f.top + (f.height - H) / 2);
        if (left < 0) left = 0;
        if (top < 0) top = 0;
      }
    } catch (e) { /* 默认居中 */ }
    const win = await chrome.windows.create({ url, type: 'popup', width: W, height: H, left, top, resizable: false });
    addWindowId = win.id;
    if (addWindowId !== null) {
      chrome.windows.onRemoved.addListener(function onClose(wid) {
        if (wid === addWindowId) {
          addWindowId = null;
          chrome.windows.onRemoved.removeListener(onClose);
        }
      });
    }
  }

  // 监听来自 background 的更新消息
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'updatePopup') {
      init();
    }
  });

  // ===== 更新检测 =====
  let currentUpdateInfo = null;

  // 从 background 获取最新更新信息（缓存）
  function renderUpdateInfo(info) {
    currentUpdateInfo = info;
    if (!info) {
      updateBanner.hidden = true;
      return;
    }
    updateBanner.hidden = false;
    if (info.hasUpdate) {
      updateText.textContent = `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）`;
      btnUpdate.hidden = false;
      btnUpdateDismiss.hidden = false;
    } else {
      updateText.textContent = `已是最新版本 v${info.currentVersion} ✓`;
      btnUpdate.hidden = true;
      btnUpdateDismiss.hidden = true;
    }
  }

  // 主动检查更新：直接在 popup 内执行（不再依赖 background worker 异步响应，避免 worker 休眠导致无回调）
  async function refreshUpdate() {
    updateBanner.hidden = false;
    updateText.textContent = '检查更新中…';
    btnUpdate.hidden = true;
    btnUpdateDismiss.hidden = true;

    // 兜底超时：即使 fetch 卡住也给出提示，避免永远停在“检查中”
    const timeoutId = setTimeout(() => {
      updateText.textContent = '检查更新超时（请检查网络后重试）';
      updateBanner.appendChild(btnCheckUpdate); // 确保按钮可见可重试
    }, 15000);

    let currentVer = '';
    try { currentVer = chrome.runtime.getManifest().version || ''; } catch (e) {}
    const info = await UpdateChecker.check(currentVer);
    clearTimeout(timeoutId);

    if (!info || (info.latestVersion === null && info.hasUpdate === false)) {
      // 远端无 release 或请求失败，两者都返回 hasUpdate=false，但 latestVersion 为 null 表示失败
      if (info && info.latestVersion === null) {
        updateText.textContent = '检查更新失败（无法连接更新源，请稍后重试）';
      } else {
        renderUpdateInfo(info);
      }
      return;
    }
    renderUpdateInfo(info);

    // 同步写缓存，供下次打开 popup 直接展示
    try { await chrome.storage.local.set({ khUpdateInfo: info }); } catch (e) {}
  }

  btnCheckUpdate.addEventListener('click', refreshUpdate);

  // 更新按钮：统一走 crx 自动更新通道（v1.10.0 起移除本机 HTTP / Native 宿主 / zip 手动覆盖三套旧自动更新方案）
  btnUpdate.addEventListener('click', async () => {
    if (!currentUpdateInfo || !currentUpdateInfo.zipUrl) {
      alert('未找到更新包下载地址');
      return;
    }
    // crx 自动更新通道：直接引导下载新版本 .crx（update.xml 的 codebase 必为 .crx）
    if (/\.crx(\?|$)/i.test(currentUpdateInfo.zipUrl)) {
      alert(
        '已检测到新版本 v' + (currentUpdateInfo.latestVersion || '') + '。\n\n' +
        '将为你打开新版本 .crx 下载：\n' + currentUpdateInfo.zipUrl + '\n\n' +
        '👉 下载后到 chrome://extensions 将 .crx 拖入窗口即可覆盖安装；\n' +
        '👉 若该扩展已由策略托管（显示「由贵单位管理」），则会在后台自动更新到新版，无需手动操作。'
      );
      chrome.tabs.create({ url: currentUpdateInfo.zipUrl }).catch(() => {});
      return;
    }
    // 兜底：codebase 非 .crx 时也直接打开下载
    chrome.tabs.create({ url: currentUpdateInfo.zipUrl }).catch(() => {});
  });

  // 稍后：收起提示条
  btnUpdateDismiss.addEventListener('click', () => {
    updateBanner.hidden = true;
    btnUpdate.hidden = true;
    btnUpdateDismiss.hidden = true;
  });

  // 打开 popup 时：先读缓存立即展示，再直接刷新一次（不走 worker，避免无响应）
  (async () => {
    try {
      const res = await chrome.storage.local.get('khUpdateInfo');
      if (res && res.khUpdateInfo) renderUpdateInfo(res.khUpdateInfo);
    } catch (e) {}
    // 静默刷新（仅更新缓存与图标，不显示“检查中”以免干扰）
    let currentVer = '';
    try { currentVer = chrome.runtime.getManifest().version || ''; } catch (e) {}
    const info = await UpdateChecker.check(currentVer);
    if (info && info.latestVersion) {
      try { await chrome.storage.local.set({ khUpdateInfo: info }); } catch (e) {}
    }
  })();

  await init();
});
