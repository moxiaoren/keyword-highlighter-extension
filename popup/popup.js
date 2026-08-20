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
    keywordCount.textContent = (data.keywords || []).filter(k => k.enabled).length;
  }

  function updateSiteStatus(disabled) {
    if (disabled) {
      siteBadge.textContent = '已禁用';
      siteBadge.classList.add('disabled');
      btnToggleSiteText.textContent = '启用本站';
    } else {
      siteBadge.textContent = '生效中';
      siteBadge.classList.remove('disabled');
      btnToggleSiteText.textContent = '禁用本站';
    }
  }

  // 全局开关
  globalToggle.addEventListener('change', async () => {
    const enabled = globalToggle.checked;
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

  // 快速添加关键词
  btnAddKeyword.addEventListener('click', () => {
    openQuickAddWindow();
  });

  // 打开设置页
  btnOpenSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 帮助
  btnHelp.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  });

  // 快速添加：打开独立弹窗窗口（空间宽裕，避免挤压换行）
  let quickAddWindowId = null;
  async function openQuickAddWindow() {
    const url = chrome.runtime.getURL('popup/quick-add.html');
    // 若已存在则聚焦；否则新建
    if (quickAddWindowId !== null) {
      try {
        const win = await chrome.windows.get(quickAddWindowId);
        if (win) {
          await chrome.windows.update(quickAddWindowId, { focused: true });
          return;
        }
      } catch (e) { quickAddWindowId = null; }
    }
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: 440,
      height: 520
    });
    quickAddWindowId = win.id;
    // 窗口关闭时清引用
    if (quickAddWindowId !== null) {
      chrome.windows.onRemoved.addListener(function onClose(winId) {
        if (winId === quickAddWindowId) {
          quickAddWindowId = null;
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
        updateText.textContent = '检查更新失败（无法连接 GitHub，请稍后重试）';
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

  // 本机自动覆盖辅助服务地址（方案 B+）；服务未运行则回退到手动下载
  const UPDATER_BASE = 'http://127.0.0.1:8787';

  // 尝试调用本机辅助服务自动更新
  // 返回 { ok:boolean, reachable:boolean, msg:string }
  //  - ok=true 更新成功
  //  - reachable=false 服务未启动/不可达
  //  - reachable=true 且 ok=false，则 msg 为服务端返回的错误
  function tryAutoUpdate() {
    return new Promise((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000); // 3 秒超时
      fetch(UPDATER_BASE + '/update', {
        method: 'POST',
        signal: ctrl.signal
      }).then(async (res) => {
        clearTimeout(timer);
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (data && data.ok) return resolve({ ok: true, reachable: true, msg: '' });
        // 服务在跑但更新失败，返回具体错误
        if (data) return resolve({ ok: false, reachable: true, msg: data.msg || '更新失败' });
        return resolve({ ok: false, reachable: true, msg: '服务响应异常(' + res.status + ')' });
      }).catch(() => {
        clearTimeout(timer);
        resolve({ ok: false, reachable: false, msg: '' }); // 服务未跑/网络失败
      });
    });
  }

  // 更新按钮
  btnUpdate.addEventListener('click', async () => {
    if (!currentUpdateInfo || !currentUpdateInfo.zipUrl) {
      alert('未找到更新包下载地址');
      return;
    }

    // 优先：本机辅助服务自动覆盖
    updateText.textContent = '正在自动更新…';
    btnUpdate.hidden = true;
    btnUpdateDismiss.hidden = true;

    const r = await tryAutoUpdate();
    if (r.ok) {
      alert('✅ 已自动覆盖新版文件\n\n正在重新加载扩展，请稍候…');
      // 触发扩展重载，使新代码生效
      setTimeout(() => { chrome.runtime.reload(); }, 500);
      return;
    }

    // 服务可达但更新失败：透出具体错误
    if (r.reachable) {
      alert('❌ 自动更新失败：' + (r.msg || '未知错误') + '\n\n已改为手动下载安装包。请检查辅助服务日志。');
    }
    // 回退：下载 zip 到默认下载目录，手动覆盖引导
    if (currentUpdateInfo.zipUrl) {
      chrome.downloads.download(
        { url: currentUpdateInfo.zipUrl, filename: 'keyword-highlighter-extension.zip' },
        (downloadId) => {
          const tips = [
            (r.reachable ? 'ℹ️ 自动更新失败，已改为手动下载' : 'ℹ️ 未检测到本机自动更新服务，已改为手动下载'),
            '',
            `新版 v${currentUpdateInfo.latestVersion} 下载完成后：`,
            '1️⃣ 解压覆盖原扩展文件夹',
            '2️⃣ 打开 chrome://extensions',
            '3️⃣ 点扩展卡片上的「⟳ 重新加载」',
            '',
            '提示：启动本机辅助服务后，点「更新」即可自动覆盖。'
          ].join('\n');
          updateText.textContent = '已改为手动下载安装包';
          alert(tips);
        }
      );
    }
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
