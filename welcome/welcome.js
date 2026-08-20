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
  const CHANGELOG = [
    {
      version: 'v1.6.9',
      items: [
        '备注与重要笔记字段新增「ⓘ」格式说明小标（Markdown/换行说明）。',
        '帮助与隐私的黑白名单说明扩展为「常见问题 Q&A」，覆盖更多通用问题。'
      ]
    },
    {
      version: 'v1.6.8',
      items: [
        '移除冗余且误导的「黑名单/白名单模式」单选，规则是否生效由每条规则自身类型决定。',
        '帮助与隐私的黑白名单说明改为「Q&A」形式，并补充常见问题案例。'
      ]
    },
    {
      version: 'v1.6.7',
      items: [
        '修复「重要笔记误报」——页面隐藏元素（display:none 的菜单/模板/隐藏层）里含关键词时不再触发高亮与重要笔记。'
      ]
    },
    {
      version: 'v1.6.6',
      items: [
        '新增「黑白名单详解」帮助板块并同步欢迎页宣传。',
        '快速添加弹窗改为在当前浏览器窗口居中显示，不再固定在左上角。',
        '帮助与隐私改为横向标签分页，默认展示功能说明，查找更清晰。'
      ]
    },
    {
      version: 'v1.6.5',
      items: [
        '修复「检查更新无反应」——改为在弹窗内直接检测（不再依赖后台线程异步响应），并给网络请求加超时保护，失败或超时会有明确提示。'
      ]
    },
    {
      version: 'v1.6.4',
      items: [
        '快速添加关键词改为独立弹窗，空间更大不易挤压；重要笔记改为勾选后才展开。',
        '重要笔记与备注卡片支持保留换行等排版格式。',
        '界面焕新：帮助与隐私改为折叠式分区，打开主页自动弹出更新日志。'
      ]
    },
    {
      version: 'v1.6.3',
      items: [
        '修复站内分页切换后高亮残留（取消延迟高亮定时器）。'
      ]
    },
    {
      version: 'v1.6.2',
      items: [
        '修复一键自动更新在部分 Windows 环境下解压失败；优化失败提示。'
      ]
    },
    {
      version: 'v1.6.1',
      items: [
        'popup 新增当前版本号显示。'
      ]
    },
    {
      version: 'v1.6.0',
      items: [
        '新增一键自动更新：配合本机辅助服务，点击更新自动完成下载→解压→覆盖→重载。'
      ]
    }
  ];

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
