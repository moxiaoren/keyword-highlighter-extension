/**
 * Welcome 页面脚本
 * 首次打开时若本地版本号有更新，弹出「更新日志」。
 */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnStart').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById('btnAddFirst').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ===== 更新日志弹窗 =====
  const VERSION_KEY = 'kh_welcome_seen_version';

  // 更新日志（倒序：最新在上）
  // CHANGELOG 由 lib/changelog.js 提供（单源化，options 帮助页与 welcome 弹窗共用）

  const currentVersion = chrome.runtime.getManifest().version; // e.g. "1.6.4"

  chrome.storage.local.get([VERSION_KEY], (res) => {
    const seen = res[VERSION_KEY];
    // 仅当版本有更新（或首次安装）时展示更新日志
    if (seen === currentVersion) return;

    renderChangelog();
    const overlay = document.getElementById('changelogOverlay');
    overlay.style.display = 'flex';
    const closeChangelog = () => {
      overlay.style.display = 'none';
      chrome.storage.local.set({ [VERSION_KEY]: currentVersion });
    };
    document.getElementById('changelogGotIt').addEventListener('click', closeChangelog);
    document.getElementById('changelogClose').addEventListener('click', closeChangelog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeChangelog();
    });
  });

  function renderChangelog() {
    const body = document.getElementById('changelogBody');
    body.innerHTML = CHANGELOG.map(function (entry) {
      var isLatest = entry.version === 'v' + currentVersion;
      var label = isLatest ? ' (当前版本)' : '';
      var itemsHtml = entry.items.map(function (it) {
        return '<li>' + it + '</li>';
      }).join('');
      return '<div class="changelog-entry">'
        + '<div class="changelog-version">' + entry.version + label + '</div>'
        + '<ul>' + itemsHtml + '</ul>'
        + '</div>';
    }).join('');
  }
});
