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

  let currentHostname = '';

  // 初始化
  async function init() {
    const data = await Storage.getAll();
    
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
    showQuickAddDialog();
  });

  // 打开设置页
  btnOpenSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 帮助
  btnHelp.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  });

  // 快速添加弹窗
  function showQuickAddDialog() {
    // 移除旧弹窗
    const oldOverlay = document.querySelector('.quick-add-overlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'quick-add-overlay';
    overlay.innerHTML = `
      <div class="quick-add-dialog">
        <h3>快速添加关键词</h3>
        <input type="text" id="quickKwText" placeholder="关键词文字 *" maxlength="100">
        <textarea id="quickKwNote" placeholder="备注内容（支持 Markdown）"></textarea>
        <label class="quick-opt"><input type="checkbox" id="quickKwImportant"> 📌 标记为重要</label>
        <textarea id="quickKwImportantNote" placeholder="重要笔记（可选，命中时右上角置顶显示，支持 Markdown）"></textarea>
        <div class="dialog-actions">
          <button class="btn-cancel" id="quickCancel">取消</button>
          <button class="btn-save" id="quickSave">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const kwText = overlay.querySelector('#quickKwText');
    const kwNote = overlay.querySelector('#quickKwNote');

    overlay.querySelector('#quickCancel').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.querySelector('#quickSave').addEventListener('click', async () => {
      const text = kwText.value.trim();
      if (!text) {
        alert('请输入关键词文字');
        return;
      }

      try {
        await Storage.addKeyword({
          text,
          note: kwNote.value.trim(),
          importantNote: overlay.querySelector('#quickKwImportantNote').value.trim(),
          important: overlay.querySelector('#quickKwImportant').checked,
          groupId: '',
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
          enabled: true
        });
        overlay.remove();
        
        // 更新计数
        const data = await Storage.get(['keywords']);
        keywordCount.textContent = (data.keywords || []).filter(k => k.enabled).length;
        
        // 刷新标签页
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'refresh' }).catch(() => {});
        }
      } catch (err) {
        alert('添加失败：' + err.message);
      }
    });

    // 点击空白关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    kwText.focus();
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

  // 主动检查更新（向 background 发起新请求）
  function refreshUpdate() {
    updateBanner.hidden = false;
    updateText.textContent = '检查更新中…';
    btnUpdate.hidden = true;
    btnUpdateDismiss.hidden = true;
    chrome.runtime.sendMessage({ action: 'checkUpdate' }, (resp) => {
      const info = resp && resp.info;
      renderUpdateInfo(info);
      if (!info) {
        updateText.textContent = '检查更新失败（离线或网络异常）';
      }
    });
  }

  btnCheckUpdate.addEventListener('click', refreshUpdate);

  // 更新按钮：下载新版本 zip，并引导安装
  btnUpdate.addEventListener('click', () => {
    if (!currentUpdateInfo || !currentUpdateInfo.zipUrl) {
      alert('未找到更新包下载地址');
      return;
    }
    // 开始下载 zip 到默认下载目录
    chrome.downloads.download(
      { url: currentUpdateInfo.zipUrl, filename: 'keyword-highlighter-extension.zip' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          alert('下载失败：' + chrome.runtime.lastError.message);
          return;
        }
        const tips = [
          '✅ 已开始下载新版本安装包',
          '',
          `新版 v${currentUpdateInfo.latestVersion} 下载完成后：`,
          '1️⃣ 解压覆盖原扩展文件夹',
          '2️⃣ 打开 chrome://extensions',
          '3️⃣ 点扩展卡片上的「⟳ 重新加载」',
          '',
          '即完成更新（无需移除扩展）'
        ].join('\n');
        if (currentUpdateInfo.notes) {
          updateText.textContent = `本次更新：${currentUpdateInfo.notes}`;
        } else {
          updateText.textContent = `已开始下载 v${currentUpdateInfo.latestVersion}`;
        }
        btnUpdate.hidden = true;
        btnUpdateDismiss.hidden = true;
        alert(tips);
      }
    );
  });

  // 稍后：收起提示条
  btnUpdateDismiss.addEventListener('click', () => {
    updateBanner.hidden = true;
    btnUpdate.hidden = true;
    btnUpdateDismiss.hidden = true;
  });

  // 打开 popup 时，先读缓存，再后台刷新（不阻塞 UI）
  chrome.runtime.sendMessage({ action: 'getUpdateInfo' }, (resp) => {
    if (resp && resp.info) renderUpdateInfo(resp.info);
    // 静默触发一次后台检查（不弹提示，仅刷新 storage）
    chrome.runtime.sendMessage({ action: 'checkUpdate' });
  });

  await init();
});
