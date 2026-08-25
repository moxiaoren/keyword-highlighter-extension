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
      version: 'v1.6.25',
      items: ['右上角弹窗界面焕新：状态反馈更直观（全局开关实时提示、站点禁用态变绿色）、布局与交互优化；修复「帮助」按钮误跳欢迎页的问题（改为直接进入帮助页）；关键词数量改为显示全部关键词总数。']
    },
    {
      version: 'v1.6.24',
      items: ['帮助页悬浮目录改为右侧竖排展示，内容过长自动省略、吸顶跟随滚动；窄屏（小于820px）时自动回落为顶部横排。']
    },
    {
      version: 'v1.6.23',
      items: ['更新后自动打开欢迎页并弹窗展示近期更新；帮助与隐私新增悬浮目录；功能说明与常见问题补充「单元格组合关键词匹配」详解；关键词列表重要笔记标识不再挤压换行，并设置最小列宽。']
    },
    {
      version: 'v1.6.22',
      items: ['关键词管理表格优化：长内容省略隐藏、支持表头拖拽调整列宽、点击状态列直接启用/禁用（移除操作列开关按钮）、颜色列只显示色块不再显示色值。']
    },
    {
      version: 'v1.6.21',
      items: ['批量操作新增「备注/重要笔记」：勾选多条后可批量设置统一备注、重要笔记（可选同时标记为重要），也可一键清空。']
    },
    {
      version: 'v1.6.20',
      items: ['优化关键词管理表格展示：新增「后格期望值 / 重要笔记 / 高亮颜色」三列并调整列顺序，管理页一目了然。']
    },
    {
      version: 'v1.6.19',
      items: [
        '前格相同、后格不同可并存：去重改为按「前格+后格」组合判断，可加多条同前词不同后格的规则。',
        '后格匹配方式可选「包含 / 全词(整体相等)」。',
        '关键词弹窗梳理：单元格标注与重要笔记改为「勾选才展开细节」，界面更清爽；重要笔记小圆钮改为双击展开，避免拖动误展开。',
        '修复重新高亮（切站点/刷新）时单元格验证失效：需拼接首次高亮拆开的相邻文本节点后再验证。'
      ]
    },
    {
      version: 'v1.6.18',
      items: [
        '新增「单元格特别标注」验证：关键词可独立勾选并填写“后一个单元格期望值”。命中后校验其横向右侧相邻格【包含】该值才生效（高亮/重要笔记），不含则整条不生效。',
        '支持 HTML 表格 td 或文本中用 | / Tab 分隔（如 是否刚需|否）。与重要笔记互相独立、不依赖分组；取代原 v1.6.17 的自动识别相邻值展示。'
      ]
    },
    {
      version: 'v1.6.17',
      items: [
        '新增「相邻单元格特别标注」：命中重要关键词时，自动识别其横向右侧相邻单元格的值（HTML 表格 td，或 | / Tab 分隔的假表格），以「→ 相邻值」附加在重要笔记中展示。',
        '默认开启，可在「备注卡片样式」设置页关闭；识别不到相邻格时不影响原有功能。'
      ]
    },
    {
      version: 'v1.6.16',
      items: [
        '修复导入数据丢失——JSON 导入恢复 globalEnabled 与 siteDisabledMap，并对分组颜色等字段做结构兜底；CSV 导入恢复分组关联（缺失时自动创建同名分组），避免关键词脱离分组导致分组高亮色丢失。'
      ]
    },
    {
      version: 'v1.6.15',
      items: [
        '「检测更新」改为读取 crx 自动更新通道（update.xml），不再依赖 GitHub Releases API，国内网络下也能正常检测；「更新」按钮对 crx 版自动切换为下载新版 .crx 引导安装。'
      ]
    },
    {
      version: 'v1.6.14',
      items: [
        '重要笔记聚合优化：同一页面命中多个关键词、笔记内容一致时合并为一条展示，并在条目标签中列举命中了哪些关键词。'
      ]
    },
    {
      version: 'v1.6.13',
      items: [
        '分组可统一配置重要笔记展示文本：分组标记为「重要」后可填写统一说明，组内重要关键词命中时统一展示该文本（关键词自身已填写的优先）。',
        '重要笔记悬浮窗默认位置改为左上角；分组统一文本下不同关键词各自展示，不再互相覆盖。'
      ]
    },
    {
      version: 'v1.6.12',
      items: [
        '新增「原生一键更新」（方案B）：点「更新」可生成 kh-register-native.cmd，双击一次注册原生宿主，之后通过 Chrome 原生通信真正一键全自动覆盖新版。'
      ]
    },
    {
      version: 'v1.6.11',
      items: [
        '点「更新」若未检测到本机自动更新服务，自动生成并下载 kh-auto-update.cmd，双击即可自动建目录+写脚本+启动服务。'
      ]
    },
    {
      version: 'v1.6.10',
      items: [
        '修正常见问题 Q&A 中站点规则判定顺序的描述（未命中取决于是否存在白名单）。'
      ]
    },
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
