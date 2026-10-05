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

  /* 更新日志唯一数据源。**取不到时必须能与「没有新版本」区分开**（C7 F-10）：
   * 旧写法 `window.CHANGELOG || []` 把"脚本没加载出来"伪装成"空日志"，再照常标记已读 ——
   * 用户既看不到这次更新，也没有任何提示，而且下次打开依然什么都没有。 */
  const CHANGELOG = Array.isArray(window.CHANGELOG) ? window.CHANGELOG : null;

  /* 日志条目是 Markdown（反引号 / 加粗 / 裸网址），必须过 `KH.Markdown` 的**单源**渲染。
   * 拿不到渲染器时退回**纯文本**（如实显示标记），绝不静默丢内容、也绝不 innerHTML。 */
  function docFragment(text) {
    const md = (window.KH && window.KH.Markdown) || null;
    if (!md || typeof md.toDocFragment !== 'function') return null;
    try { return md.toDocFragment(String(text), document); } catch (err) {
      console.warn('[KH] welcome：更新日志条目渲染失败，退回纯文本 ——', err && err.message);
      return null;
    }
  }

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
    /* 「读失败」与「没有新版本」是两件事（C7 F-10）：旧写法上一步 get 一 reject，
     * 下面那条 `set(...已读)` 就再也到不了；而日志数据取不到时它又会**照常标记已读**。
     * 两种失败都会让用户从此看不到这次更新的说明，页面上还毫无提示。 */
    let lastSeen = null;
    let readOk = false;
    try {
      const got = await chrome.storage.local.get('khLastSeenVersion');
      lastSeen = (got && got.khLastSeenVersion) || null;
      readOk = true;
    } catch (err) {
      console.warn('[KH] welcome：读取 khLastSeenVersion 失败，本次不标记已读 ——', err && err.message);
    }
    const isFirst = !lastSeen;

    // 只展示「上一个看过的版本 → 当前版本」之间的条目；首次安装只展示当前版本
    const entries = (CHANGELOG || []).filter((e) => isFirst
      ? cmp(e.version, version) === 0
      : (cmp(e.version, version) <= 0 && cmp(e.version, lastSeen) > 0));

    $('rel-head').textContent = isFirst ? '本次安装的版本' : '本次更新';

    const box = $('changelog');
    box.innerHTML = '';
    if (!CHANGELOG) {
      // 数据没加载出来时**不许**说「暂无新版本说明」——那不是事实
      $('rel-head').textContent = '更新日志';
      box.innerHTML = '<p style="color:var(--text-3);font-size:var(--fs-sm)">更新日志数据没能加载（changelog.js 未就绪），请重新打开本页；在它恢复之前不会标记「已读」。</p>';
      return;
    }
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
          /* 旧写法 `li.innerHTML = it`：日志里的 `**加粗**` 与 `` `命令` `` 是标记，
           * 会原样印给用户（全库 1,514 处 `**`、1,250 处反引号）；而且 innerHTML 是汇点。
           * 现在过单源渲染器（文本→节点），并在 `plain` 档下**不产出链接/图片**。 */
          const frag = docFragment(it);
          if (frag) li.appendChild(frag); else li.textContent = String(it);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
        box.appendChild(wrap);
      }
      /* 「展开全部」必须按**屏幕上真被藏起来的条数**给，不能按总条数算。
       * 真机教训：折叠是**每块**只露前 3 条（welcome.css:155 的 li:nth-child(n + 4)），
       * 而这里原来把所有版本的总条数拿来判 `total > 3` ⇒ 当这次更新的条目分散在各块、
       * 每块都不超过 3 条时（实际数据里 khLastSeenVersion = 2.0.0.10 / 2.0.0.9 就是这么两段），
       * 按钮照样出现，点了却一条都不变 —— 死按钮；而且按钮上的数字（总条数）也不是「要展开的条数」。
       * 现在直接问浏览器：被 CSS 藏起来的 li 到底有几条；一条都没藏就**不给按钮**。 */
      const btn = $('btn-toggle-log');
      const hiddenCount = [...box.querySelectorAll('.kh-rel-items li')]
        .filter((li) => getComputedStyle(li).display === 'none').length;
      btn.hidden = true;
      if (hiddenCount > 0) {
        btn.hidden = false;
        btn.textContent = '展开全部（' + hiddenCount + ' 条）';
        btn.addEventListener('click', () => {
          const open = box.classList.toggle('is-open-log');
          for (const el of box.querySelectorAll('.kh-clip')) el.classList.toggle('is-open', open);
          btn.textContent = open ? '收起' : '展开全部（' + hiddenCount + ' 条）';
        });
      }
    }

    /* 只有**确实读到过**上次记录，才允许把这次看到的内容标记成已读。
     * 写失败照实记日志（不吞）：下次打开还会显示同一批条目 —— 宁可见两遍，不许一次都见不到。 */
    if (!readOk) return;
    try {
      await chrome.storage.local.set({ khLastSeenVersion: version });
    } catch (err) {
      console.warn('[KH] welcome：写入 khLastSeenVersion 失败，这次更新说明下次打开还会显示 ——', err && err.message);
    }
  }

  $('btn-open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-open-help').addEventListener('click', () => {
    // 帮助与隐私就在设置页里，带上 hash 直达
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#help') });
  });

  /* 快捷键卡面必须来自 `chrome.commands.getAll()` 的**真值**，不能写死。
   * 真机教训：`manifest.json` 里给 open-settings 写的 suggested_key 是 `Ctrl+Shift+O`，
   * 但这条被 Chrome 自带的「书签管理器」占用 ⇒ Chrome **静默丢弃**建议键，
   * `getAll()` 回 `shortcut:""`，而写死的卡面照样教用户去按 —— 按了没反应。
   * 所以：① manifest 换成没被占用的 Ctrl+Shift+Y；② 卡面按真值重画，
   * 读不到或未分配时如实写「未分配」，不再复制 manifest 的愿望。 */
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  /* mac 上 chrome 回 "Command+Shift+H" 这种写法；Alt=Option、MacCtrl=Control */
  const MAC_LABEL = { Command: '⌘', Ctrl: '⌘', MacCtrl: '⌃', Alt: '⌥' };
  function comboParts(shortcut) {
    const parts = String(shortcut || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    return MAC ? parts.map((p) => MAC_LABEL[p] || p) : parts;
  }
  async function renderShortcuts() {
    let cmds = null;
    try { cmds = await chrome.commands.getAll(); } catch (e) { return; }   // 读不到 → 保留静态兜底
    if (!Array.isArray(cmds)) return;
    for (const box of document.querySelectorAll('[data-kh-cmd]')) {
      const hit = cmds.find((c) => c && c.name === box.dataset.khCmd);
      const parts = hit ? comboParts(hit.shortcut) : null;
      if (!parts) {
        box.innerHTML = '<kbd class="is-unset">未分配</kbd>';
        box.title = '浏览器没给这条命令分按键（多半被浏览器自带快捷键占用），可在扩展快捷键页自行设置';
        continue;
      }
      box.textContent = '';
      parts.forEach((label, i) => {
        if (i) {
          const plus = document.createElement('span');
          plus.className = 'kh-plus';
          plus.textContent = '+';
          box.appendChild(plus);
        }
        const k = document.createElement('kbd');
        k.textContent = label;
        box.appendChild(k);
      });
    }
  }

  /* 本页停留期间，用户在别处加了词 → 状态条要跟着变（C7 F-10：welcome 页原本对
   * storage 变化一无所知，永远显示打开那一刻的旧数字）。
   * **刻意不**在这里重画更新日志：本页自己写 khLastSeenVersion 会触发事件，
   * 重画的结果是"刚展示给你看的更新说明立刻消失"——那比不刷新更糟。
   * 日志的基准变化留给下次打开。 */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes || (!changes.keywords && !changes.groups)) return;
      renderStatus().catch((err) => console.warn('[KH] welcome：状态条刷新失败 ——', err && err.message));
    });
  } catch (err) {
    console.warn('[KH] welcome：storage.onChanged 不可用，状态条不会自动刷新 ——', err && err.message);
  }

  /* 三个渲染各自兜底：旧写法三个裸调用（`renderStatus(); renderLog(); renderShortcuts();`）
   * 谁先 reject 谁就把整页剩下的渲染**一起带走**，且是 unhandled rejection —— 用户零提示。 */
  const boot = (fn, what) => fn().catch((err) => console.warn('[KH] welcome：' + what + ' 渲染失败 ——', err && err.message));
  boot(renderStatus, '状态条');
  boot(renderLog, '更新日志');
  boot(renderShortcuts, '快捷键卡');
})();
