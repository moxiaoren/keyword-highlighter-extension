/* ============================================================================
 * welcome/welcome.js · 欢迎 / 更新页
 * ----------------------------------------------------------------------------
 * 统一化要点（保持不回退）：
 *   · 更新日志唯一数据源是 `src/ui/changelog.js`（options 帮助页与 welcome 共用同一份，
 *     旧版存在"两处各写一份、版本不同步"的问题）。
 *   · 版本号唯一来源是 manifest；welcome 只负责"用哪个版本的日志"。
 * 本次改动只针对**呈现**（用户实测："太简陋了。可以简约点，但不能像现在这样过于没设计感"）：
 *   · 状态从"散落的灰字"变成一条信息条（有词 / 没词颜色不同）；
 *   · 更新日志**默认只露前 3 条**、可展开 —— 旧版首装会把当前版本全部条目铺开，实测整页 8889px。
 * ========================================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const manifest = chrome.runtime.getManifest();
  const version = manifest.version;

  $('version').textContent = 'v' + version;

  /** 语义化版本比较（与 background/update-checker.js 同一实现口径） */
  function cmp(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.');
    const pb = String(b).replace(/^v/i, '').split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  const CHANGELOG = window.CHANGELOG || [];

  /** 首屏状态条：如实显示"当前有没有词"，并给出直达设置页的入口 */
  async function renderStatus() {
    const { keywords = [], groups = [] } = await chrome.storage.local.get(['keywords', 'groups']);
    const n = Array.isArray(keywords) ? keywords.length : 0;
    const g = Array.isArray(groups) ? groups.length : 0;
    const box = $('status');
    if (n) {
      box.classList.remove('is-empty');
      $('kw-count').textContent = '已有 ' + n + ' 个关键词' + (g ? ' · ' + g + ' 个分组' : '') +
        '，刷新任意网页即可看到高亮效果。';
    } else {
      box.classList.add('is-empty');
      $('kw-count').textContent = '还没有关键词 —— 加一个之后刷新任意网页就能看到效果（命中的词只是视觉上色，不改动网页内容）。';
    }
  }

  async function renderLog() {
    const { khLastSeenVersion = null } = await chrome.storage.local.get('khLastSeenVersion');
    const isFirst = !khLastSeenVersion;

    // 只展示「上一个看过的版本 → 当前版本」之间的条目；首次安装只展示当前版本
    const entries = isFirst
      ? CHANGELOG.filter((e) => cmp(e.version, version) === 0)
      : CHANGELOG.filter((e) => cmp(e.version, version) <= 0 && cmp(e.version, khLastSeenVersion) > 0);

    $('rel-head').textContent = isFirst ? '本次安装的版本' : '本次更新';

    const box = $('changelog');
    box.innerHTML = '';
    if (!entries.length) {
      box.innerHTML = '<p style="color:var(--text-3);font-size:var(--fs-sm)">暂无新版本说明。</p>';
    } else {
      for (const rel of entries) {
        const wrap = document.createElement('div');
        wrap.className = 'kh-clip';                 // 默认只露前 3 条（见 welcome.css）
        const h = document.createElement('div');
        h.className = 'kh-rel-title';
        h.textContent = rel.version;
        wrap.appendChild(h);
        const ul = document.createElement('ul');
        ul.className = 'kh-rel-items';
        for (const it of rel.items || []) {
          const li = document.createElement('li');
          li.innerHTML = it;   // 日志为本地静态数据，允许富文本（与旧版一致）
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
        box.appendChild(wrap);
      }
      /* 条目多于 3 条才给「展开全部」—— 少于 3 条时按钮没有意义 */
      const total = entries.reduce((s, e) => s + (e.items || []).length, 0);
      const btn = $('btn-toggle-log');
      if (total > 3) {
        btn.hidden = false;
        btn.textContent = '展开全部（' + total + ' 条）';
        btn.addEventListener('click', () => {
          const open = box.classList.toggle('is-open-log');
          for (const el of box.querySelectorAll('.kh-clip')) el.classList.toggle('is-open', open);
          btn.textContent = open ? '收起' : '展开全部（' + total + ' 条）';
        });
      }
    }

    await chrome.storage.local.set({ khLastSeenVersion: version });
  }

  $('btn-open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-open-help').addEventListener('click', () => {
    // 帮助与隐私就在设置页里，带上 hash 直达
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#help') });
  });

  /* Mac 上修饰键是 ⌘ 而不是 Ctrl —— 页面里写死 Ctrl 会让人按不出来。
   * 平台判断只用于**显示**，快捷键本身的注册在 manifest 里（两个平台各一份）。 */
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  if (isMac) {
    for (const k of document.querySelectorAll('.kh-key kbd')) if (k.textContent === 'Ctrl') k.textContent = '⌘';
  }

  renderStatus();
  renderLog();
})();
