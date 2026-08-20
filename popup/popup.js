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

  // 快速添加：打开独立弹窗窗口（空间宽裕，避免挤压换行；默认居中显示）
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

    const W = 440, H = 520;
    // 计算居中坐标：尽量放在当前浏览器窗口中央（popup 所在窗口即当前窗口）
    let left = undefined, top = undefined;
    try {
      const focused = await chrome.windows.getCurrent();
      if (focused && focused.width && focused.height) {
        left = Math.round(focused.left + (focused.width - W) / 2);
        top = Math.round(focused.top + (focused.height - H) / 2);
        if (left < 0) left = 0;
        if (top < 0) top = 0;
      }
    } catch (e) { /* 取不到坐标时由系统默认放置 */ }

    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: W,
      height: H,
      left,
      top
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

  // 生成「一键启动自动更新服务」的 cmd（方案①）
  // 内含 update-server.js 的 base64（分块写入 + certutil 解码），双击即可自动建目录+写脚本+启动
  async function generateUpdaterCmd() {
    try {
      const src = await fetch(chrome.runtime.getURL('assets/update-server.js')).then(r => r.text());
      if (!src) return null;
      // UTF-8 安全 base64，分块便于 cmd echo（base64 字符集不含空格/特殊字符，安全）
      const b64 = btoa(unescape(encodeURIComponent(src)));
      const CHUNK = 200;
      const lines = [];
      for (let i = 0; i < b64.length; i += CHUNK) {
        const op = i === 0 ? '>' : '>>';
        lines.push(op + ' "%UP%\\update.b64" echo ' + b64.slice(i, i + CHUNK));
      }
      // 插件目录：优先用户已保存，否则默认
      let extDir = 'D:\\keyword-highlighter-extension';
      try {
        const st = await chrome.storage.local.get('khUpdateExtDir');
        if (st && st.khUpdateExtDir) extDir = st.khUpdateExtDir;
      } catch (e) {}
      const cmd = [
        '@echo off',
        'chcp 65001 >nul',
        'title 关键词高亮扩展 - 一键启动自动更新服务',
        'echo ==============================================',
        'echo   正在生成并启动自动更新服务...',
        'echo ==============================================',
        'echo.',
        'setlocal',
        'REM 目标目录（自动创建，脚本存放于此）',
        'set "UP=%USERPROFILE%\\kh-updater"',
        'if not exist "%UP%" mkdir "%UP%"',
        'echo.',
        'echo [1/3] 正在写入 update-server.js ...',
      ].concat(lines, [
        'certutil -decode "%UP%\\update.b64" "%UP%\\update-server.js" >nul',
        'if not exist "%UP%\\update-server.js" (',
        '  echo [错误] 写入失败，请重试。',
        '  del "%UP%\\update.b64" >nul 2>nul',
        '  pause',
        '  exit /b 1',
        ')',
        'del "%UP%\\update.b64" >nul 2>nul',
        'echo     已写入。',
        'echo.',
        'REM 插件目录（若与默认不同，请修改下一行）',
        'set "KH_EXT_DIR=' + extDir + '"',
        'echo [2/3] 正在启动更新服务...',
        'start "" /min cmd /c "node \"%UP%\\update-server.js\""',
        'echo [3/3] 等待服务就绪...',
        'timeout /t 2 /nobreak >nul',
        'echo.',
        'echo ✅ 自动更新服务已启动！',
        'echo   回到浏览器扩展，点「更新」即可自动覆盖新版。',
        'echo   若提示失败：请确认本扩展目录是否为: %KH_EXT_DIR%',
        'echo.',
        'pause'
      ]);
      return cmd.join('\r\n');
    } catch (e) {
      console.error('[kh] 生成命令失败', e);
      return null;
    }
  }

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
      alert('❌ 自动更新失败：' + (r.msg || '未知错误') + '\n\n请检查本机自动更新服务日志后重试。');
      btnUpdate.hidden = false; // 允许重试
      return;
    }

    // 服务未运行（最常见）：自动生成并下载「一键启动脚本」，双击即可自动建目录+写脚本+启动服务
    updateText.textContent = '正在生成一键启动脚本…';
    const cmdText = await generateUpdaterCmd();
    if (!cmdText) {
      // 生成失败：回退到手动下载 zip
      fallbackManualDownload(r);
      return;
    }
    // 用 Blob URL 下载 cmd（免去用户手动建文件夹/写脚本/打开脚本）
    try {
      const blob = new Blob(['\ufeff' + cmdText], { type: 'text/plain;charset=utf-8' }); // BOM 保证中文不乱码
      const url = URL.createObjectURL(blob);
      chrome.downloads.download(
        { url: url, filename: 'kh-auto-update.cmd', conflictAction: 'overwrite' },
        () => {
          try { URL.revokeObjectURL(url); } catch (e) {}
          updateText.textContent = '已生成一键启动脚本';
          alert(
            'ℹ️ 未检测到本机自动更新服务，已为你生成「kh-auto-update.cmd」。\n\n' +
            '👉 双击运行它（会自动创建文件夹、写入脚本、启动服务），\n' +
            '👉 然后回到本窗口再点一次「更新」，即可自动覆盖新版。\n\n' +
            `新版：v${currentUpdateInfo.latestVersion}\n` +
            '提示：如果插件目录不是 D:\\keyword-highlighter-extension，请先修改 cmd 里那一行。'
          );
        }
      );
      return;
    } catch (e) {
      fallbackManualDownload(r);
    }
  });

  // 回退：下载 zip 到默认下载目录，手动覆盖引导（仅作兜底）
  function fallbackManualDownload(r) {
    if (!currentUpdateInfo || !currentUpdateInfo.zipUrl) return;
    chrome.downloads.download(
      { url: currentUpdateInfo.zipUrl, filename: 'keyword-highlighter-extension.zip' },
      () => {
        const tips = [
          'ℹ️ 已改为手动下载安装包',
          '',
          `新版 v${currentUpdateInfo.latestVersion} 下载完成后：`,
          '1️⃣ 解压覆盖原扩展文件夹',
          '2️⃣ 打开 chrome://extensions',
          '3️⃣ 点扩展卡片上的「⟳ 重新加载」'
        ].join('\n');
        updateText.textContent = '已改为手动下载安装包';
        alert(tips);
      }
    );
  }

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
