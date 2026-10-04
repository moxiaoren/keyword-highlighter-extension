/* ============================================================================
 * popup/popup.js · 工具栏弹窗逻辑（策划案 §5.1 / §3.11）
 * ----------------------------------------------------------------------------
 * 统一化要点（与 v2 架构一致，勿回退）：
 *   · 全局开关 → `MSG.GLOBAL_TOGGLE`，由 background 统一落盘 + 广播 + 换图标
 *   · 站点禁用 → **storage.siteDisabledMap 为主**（内容脚本经 storage.onChanged
 *     必然生效），`MSG.SITE_TOGGLE` 只作 best-effort 通知
 *   · 版本显示 → `chrome.runtime.getManifest().version`（manifest 是唯一真源）
 *   · 快速添加 → `KH.ui.openEditor({mode:'popup'})`，**在弹窗内联**弹编辑器，
 *     不跳设置页、不另开窗口
 *   · 关键词数 → **直接读配置**（`cfg.keywords` 条数，按条目计、含已停用条目），
 *     与命中统计无关（命中统计功能已于 1.99.99.19 整体移除，弹窗不再读 `stats`）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = window.KH;
  const D = KH.ui.dom;
  const MSG = KH.MSG;
  /** getElementById 语义（写 id 不带 #） */
  const $ = (id) => document.getElementById(id);
  /** 更新检测超时兜底：不让提示条永远停在「检查更新中…」 */
  const UPDATE_TIMEOUT_MS = 15000;

  let cfg = null;
  let hostname = '';
  let currentUpdateInfo = null;
  let updateTimer = null;

  /* ---------------- 通用小工具 ---------------- */

  function read(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (r) => resolve(r || {})); }
      catch (e) { resolve({}); }
    });
  }

  function write(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve(true)); }
      catch (e) { resolve(false); }
    });
  }

  async function activeTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return (tabs && tabs[0]) || null;
    } catch (e) { return null; }
  }

  /** 向当前标签页内容脚本发消息；content script 不在（chrome:// 等）则返回 null 由调用方降级 */
  async function nudgeContent(type, payload) {
    const tab = await activeTab();
    if (!tab || tab.id == null) return null;
    try { return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, payload || {})); }
    catch (e) { return null; }
  }

  /** 向 background 发消息（background 不可用时返回 null） */
  async function askBackground(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (e) { return null; }
  }

  function toast(msg, type) {
    try { D.toast(msg, type || 'ok'); } catch (e) { /* 组件层不可用不影响主流程 */ }
  }

  /* 🩺 诊断（只读）：把"整页重建次数 / 其中变更通道多少次 / 最近触发来源 / 仅消费次数 / 最近一次相关性判定 /
   * 高亮组与命中规模 / 图片识别排队"整理成一段文本 → 复制到剪贴板 + 打到控制台。
   * 【为什么放 popup】用户反馈"某页卡"时，第一件要知道的就是"到底重不重建、因为什么重建"；
   * 有这行数据就不必靠猜（解读可对照 tests/E2E-REPORT.md K54 的判据表）。 */
  (function wireDiag() {
    const btn = document.getElementById('btn-diag');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const tab = await activeTab();
      const d = tab ? await nudgeContent(MSG.DEBUG_DIAG) : null;
      if (!d || !d.ok) {
        toast('拿不到诊断信息（当前标签页不是普通网页，或内容脚本未注入）', 'error');
        return;
      }
      const lines = [
        '关键词高亮 · 只读诊断',
        '页面: ' + d.url,
        '状态: booted=' + d.booted + ' 本站生效=' + d.siteEnabled + ' 规则=' + d.rules + ' 命中=' + d.hits + ' 高亮组=' + d.groups,
        '整页重建: ' + d.rebuildCount + ' 次（其中变更通道 ' + d.mutationRebuildCount + ' 次）'
          + (d.lastRebuildSource ? '，最近来源=' + d.lastRebuildSource : ''),
        '仅消费(抓取字段变化): ' + d.consumeOnlyCount + ' 次'
          + (d.lastVerdict ? '，最近一次变更判定=' + d.lastVerdict + '（' + d.lastVerdictRecords + ' 条记录）' : ''),
        /* 调度侧现场：判断"页面变了却一直不重建"到底卡在哪一步（K55） */
        '调度: 观察器回调=' + d.observerFire + ' 次，裁决=' + d.drainCount + ' 次'
          + '，其中"拖过上限直接判"=' + d.deferCapped + ' 次'
          + '，动画/过渡兜底=' + (d.animFallback || 0) + ' 次，文本量暴涨兜底=' + (d.growthFallback || 0) + ' 次'
          + '，变更处理=' + (d.changeHandling === 'always' ? '保守（任何变动都整页重建 + 每秒指纹兜底）' : '智能（相关性预筛）'),
        d.imgOcr ? ('图片识别: 条目=' + d.imgOcr.items + ' 缓存=' + d.imgOcr.cache + ' 排队=' + d.imgOcr.pending + ' 在途=' + d.imgOcr.inflight
          + (d.imgOcr.blocked && Object.keys(d.imgOcr.blocked).length
            ? ('｜未识别原因: ' + Object.keys(d.imgOcr.blocked).map((k) => k + '×' + d.imgOcr.blocked[k]).join(' '))
            : '')) : '图片识别: 未启用'
      ];
      /* 「为什么一个都没命中」自查（K57）：命中=0 时才是重点，所以逐词/子框架/结论只在命中=0 时附上 */
      const sc = d.selfCheck;
      if (sc && sc.doc) {
        const f = sc.frame || {};
        lines.push('文档: 本层框架=' + (f.top ? '是' : '⚠ 否（这份诊断来自 iframe）')
          + ' 文本=' + sc.doc.textContentLen + '字（可见 ' + sc.doc.innerTextLen + '字）'
          + ' 文本节点=' + sc.doc.textNodes + ' 元素=' + sc.doc.elements
          + ' 图=' + sc.doc.imgs + ' 画布=' + sc.doc.canvases
          + ' 影子根=' + sc.doc.shadowRoots + ' iframe=' + (sc.iframes || []).length);
        if (sc.scan) {
          const rj = sc.scan.rejects || {};
          const aged = sc.scan.at ? Math.round((Date.now() - sc.scan.at) / 1000) : null;
          lines.push('上一轮扫描: 文本节点=' + sc.scan.textNodes + ' 规则=' + sc.scan.rules
            + ' 命中=' + sc.scan.hits + '（' + sc.scan.ms + 'ms）'
            + (aged == null ? '' : '，发生在 ' + aged + ' 秒前')
            + '｜没收进来的文本节点: 不可见子树=' + (rj.invisible == null ? sc.scan.prunedInvisible : rj.invisible)
            + ' script/style=' + (rj.skipTag || 0) + ' 可编辑区=' + (rj.editable || 0)
            + ' 插件自身UI=' + (rj.ownUI || 0) + ' 空文本=' + (rj.empty || 0) + ' 无父节点=' + (rj.orphan || 0));
        }
        if (!d.hits) {
          for (const fr of (sc.iframes || [])) {
            lines.push('子框架: ' + (fr.sameOrigin ? '' : '跨域 ') + fr.src
              + ' 文本=' + fr.textLen + '字 该框架规则=' + fr.khRules + ' 命中=' + fr.khHits + ' 已上线=' + fr.khBooted);
          }
          /* 词"待在别的通道里"的计数（表单值 / 属性 / 可编辑区 / 影子根）—— 只列有值的，避免刷屏 */
          const other = (sc.words || []).filter((w) => w.inForm || w.inAttr || w.inEditable || w.inShadow);
          if (other.length) {
            lines.push('其它通道(表单值/属性/可编辑/影子根): ' + other.slice(0, 5)
              .map((w) => w.word + '=' + w.inForm + '/' + w.inAttr + '/' + w.inEditable + '/' + w.inShadow).join(' | '));
          }
          /* 组合词定位体检：标题词找到了没有、旁边那格有没有核心词 */
          if (sc.combo) {
            lines.push('组合词定位: 左右轴 检查格=' + sc.combo.cells + ' 标题命中=' + sc.combo.labeled
              + ' 右格含核心词=' + sc.combo.withCore + ' 无右格=' + sc.combo.noRight
              + '；上下轴 表头格=' + sc.combo.tbHeaders + ' 标题命中=' + sc.combo.tbLabeled
              + ' 数据格=' + sc.combo.tbCells + ' 含核心词=' + sc.combo.tbWithCore);
          }
        }
        if (sc.verdict) lines.push('自查结论: ' + sc.verdict);
        /* 逐规则命中明细 + 逐词（**总是打印**）：用户说"某个格子不亮"时,
         * 这一行能立刻区分"那条规则根本没命中"和"命中了但画在别处"（K59）。 */
        if (sc.words && sc.words.length) {
          lines.push('逐词(规则词在"含隐藏文本/可见文本"里各出现几次): '
            + sc.words.map((w) => w.word + '=' + w.inText + '/' + w.inInner).join(' | ')
            + (sc.noLiteral ? ('（另有 ' + sc.noLiteral + ' 条正则/逐字规则无法用字面词自查）') : ''));
        }
        if (sc.ruleHits) {
          lines.push('命中明细: ' + (sc.ruleHits.length
            ? sc.ruleHits.map((r) => r.word + (r.label ? ('(组合·' + r.label + ')') : '') + '×' + r.hits).join(' | ')
            : '（没有任何规则命中）')
            + ' —— 有命中的规则 ' + sc.rulesWithHits + ' 条 / 没命中的规则 ' + sc.rulesWithoutHits + ' 条');
        }
        /* 组合词"定位现场"：核心词在可见文本里却没命中的组合词，把它所在格子的结构打出来 */
        for (const tr of (sc.comboTrace || [])) {
          lines.push('组合词未命中现场: 「' + tr.word + '」' + (tr.label ? ('（标签「' + tr.label + '」）') : '')
            + (tr.found ? '' : ' —— 可见文本里找不到这个词')
            + (tr.tag ? (' → 所在格 <' + tr.tag + (tr.colSpan ? (' colspan=' + tr.colSpan) : '') + (tr.rowSpan ? (' rowspan=' + tr.rowSpan) : '') + '>')
              + ' 格内="' + tr.text + '"'
              + (tr.prev ? ' 左邻="' + tr.prev + '"' : '')
              + (tr.next ? ' 右邻="' + tr.next + '"' : '')
              + (tr.rowCells ? ' 同行格=' + JSON.stringify(tr.rowCells) : '（不在 <tr> 里）')
              + ' 标签在同格=' + (tr.labelInCell ? '是' : '否') + '/在同行=' + (tr.labelInScope ? '是' : '否') : ''));
        }
      }
      lines.push('解读: 整页重建长期偏高且来源多为 mutation/fingerprint → 该页有大量"看起来相关"的变动；仅消费次数多为正常（抓取字段在刷新）。');
      const text = lines.join('\n');
      console.log('[KH 诊断]\n' + text);
      try { await navigator.clipboard.writeText(text); toast('诊断信息已复制到剪贴板', 'ok'); }
      catch (e) { toast('已输出到控制台（剪贴板不可用）', 'ok'); }
    });
  })();

  /* ---------------- 渲染：头部 / 站点卡 ---------------- */

  function renderGlobalState(enabled) {
    $('chk-global').checked = !!enabled;
    $('global-state').textContent = enabled ? '全局已开启' : '全局已暂停';
  }

  function setSiteDisabledView(disabled, known) {
    if (!known) {
      const badge = $('site-badge');
      badge.textContent = '不可用';
      badge.classList.remove('is-disabled');
      badge.classList.add('is-unknown');
      $('btn-site').disabled = true;
      $('btn-site-icon').textContent = '🚫';
      $('btn-site-text').textContent = '禁用本站';
      return;
    }
    const badge = $('site-badge');
    badge.classList.remove('is-unknown');
    badge.textContent = disabled ? '已禁用' : '生效中';
    badge.classList.toggle('is-disabled', !!disabled);

    $('btn-site').disabled = false;
    $('btn-site-icon').textContent = disabled ? '✅' : '🚫';
    $('btn-site-text').textContent = disabled ? '启用本站' : '禁用本站';
    $('btn-site').classList.toggle('is-site-disabled', !!disabled);
    $('btn-site').title = disabled ? '重新启用本站高亮' : '临时禁用本站高亮';
  }

  /* ---------------- 渲染：关键词数（配置项计数，与命中统计无关） ---------------- */

  /**
   * 「关键词数」= 已配置条目数（按条目计，含已停用条目，与「关键词数」字面一致）。
   * @param {Array=} list 显式传入的关键词数组（storage 变更时用）；缺省则取当前配置
   */
  function renderKeywordCount(list) {
    const arr = list || (cfg && cfg.keywords) || [];
    $('keyword-count').textContent = String(arr.length);
  }

  /* ---------------- 渲染：站点状态（storage 为主口径） ---------------- */

  async function renderSite() {
    if (!hostname) {
      $('site-name').textContent = '（无法获取）';
      setSiteDisabledView(false, false);
      return;
    }
    $('site-name').textContent = hostname;
    $('site-name').title = hostname;
    const { siteDisabledMap } = await read(['siteDisabledMap']);
    setSiteDisabledView(!!((siteDisabledMap || {})[hostname]), true);
  }

  /* ---------------- 更新通道（复用 background 既有机制） ---------------- */

  /**
   * 状态机：null=隐藏；'checking'=检查中；有 hasUpdate 才展示提示条。
   * 已是最新版本/检查失败都不占位（结果由「🔄 检查更新」链接的 toast 反馈）。
   */
  function renderUpdateInfo(info) {
    const banner = $('update-banner');
    const btnUpdate = $('btn-update');
    const btnDismiss = $('btn-update-dismiss');
    currentUpdateInfo = info || null;

    if (!info) {
      banner.hidden = true;
      $('update-text').textContent = '检查更新中…';   // 复位为初始加载态
      return;
    }

    if (info.hasUpdate) {
      banner.hidden = false;
      $('update-text').textContent = '发现新版本 v' + (info.latestVersion || '?') +
        '（当前 v' + (info.currentVersion || '') + '）';
      /* 通道来源与更新说明放进 tooltip：提示条很窄，但排查"为什么说没更新"时很有用 */
      $('update-text').title = '更新源：' + (info.channel || '未知') +
        (info.source ? '（' + info.source + '）' : '') +
        (info.publishedAt ? '\n发布时间：' + info.publishedAt : '') +
        (info.notes ? '\n\n' + info.notes : '');
      btnUpdate.hidden = false;
      btnDismiss.hidden = false;
      btnUpdate.disabled = !info.zipUrl;
      return;
    }

    // 无新版本 → 收起提示条，同时清掉按钮，避免"看不见却能被点到"
    banner.hidden = true;
    btnUpdate.hidden = true;
    btnDismiss.hidden = true;
  }

  function showChecking(text) {
    const banner = $('update-banner');
    banner.hidden = false;
    $('update-text').textContent = text || '检查更新中…';
    $('btn-update').hidden = true;
    $('btn-update-dismiss').hidden = true;
  }

  /**
   * @param {boolean} interactive 用户主动点击：失败/无更新也要给 toast 反馈
   */
  async function checkUpdate(interactive) {
    showChecking('检查更新中…');
    clearTimeout(updateTimer);

    // 兜底：background / fetch 卡住也要给出结论，不留在"检查中"
    const settled = new Promise((resolve) => {
      updateTimer = setTimeout(() => resolve({ timedOut: true }), UPDATE_TIMEOUT_MS);
    });
    const res = await Promise.race([askBackground({ type: MSG.UPDATE_CHECK }), settled]);
    clearTimeout(updateTimer);

    if (!res || res.timedOut) {
      renderUpdateInfo(null);
      if (interactive) toast(res && res.timedOut ? '检查更新超时，请稍后重试' : '更新通道不可用', 'error');
      return;
    }

    const info = res.info || null;
    // latestVersion 为 null 表示远端不可达（update-checker 的失败约定）
    if (!info || (info.latestVersion === null && !info.hasUpdate)) {
      renderUpdateInfo(null);
      /* 把后台的**具体失败原因**带出来：原来只有一句笼统的“无法连接更新源”，
       * 分不清是“后台报错”还是“三个镜像都拉不到”（用户实测就卡在这一点）。 */
      if (interactive) toast('检查更新失败' + (res && res.error ? '：' + String(res.error).slice(0, 80) : '（无法连接更新源）'), 'error');
      return;
    }

    renderUpdateInfo(info);
    if (interactive && !info.hasUpdate) toast('已是最新版本 v' + (info.currentVersion || ''), 'ok');
  }

  /* ---------------- 总刷新 ---------------- */

  async function render() {
    let version = '';
    try { version = chrome.runtime.getManifest().version || ''; } catch (e) { version = ''; }
    $('version').textContent = 'v' + (version || '—');
    $('version').title = '当前版本 ' + (version || '未知');

    cfg = await KH.Store.load();

    // 当前站点 hostname：只有 http(s) 页面才有"站点"语义
    // （chrome:// / edge:// / about: 等 new URL() 也能解析出 hostname，但不是可管理站点）
    const tab = await activeTab();
    hostname = '';
    if (tab && tab.url) {
      try {
        const u = new URL(tab.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') hostname = u.hostname || '';
      } catch (e) { hostname = ''; }
    }

    // 全局开关：storage 为准（background 落盘），background 不在也能显示正确
    const { globalEnabled } = await read(['globalEnabled']);
    const bg = await askBackground({ type: MSG.STATE_QUERY });
    renderGlobalState(bg && bg.globalEnabled !== undefined ? bg.globalEnabled : (globalEnabled !== false));

    await renderSite();
    renderKeywordCount();

    // 有缓存的更新信息（background 6h 轮询写的 khUpdateInfo）就直接展示
    const cached = await askBackground({ type: MSG.UPDATE_INFO });
    const cachedInfo = cached && cached.info;
    if (cachedInfo && cachedInfo.hasUpdate) renderUpdateInfo(cachedInfo);
    else renderUpdateInfo(null);
  }

  /* ---------------- 事件绑定 ---------------- */

  // 全局开关：交给 background 统一落盘 + 广播（协议 GLOBAL_TOGGLE）
  $('chk-global').addEventListener('change', async (e) => {
    const value = !!e.target.checked;
    renderGlobalState(value);   // 乐观渲染（background 回执可能修正）
    const res = await askBackground({ type: MSG.GLOBAL_TOGGLE, value });
    if (!res) {
      await write({ globalEnabled: value });   // background 不可用：直接落盘兜底
      toast(value ? '已开启全局高亮' : '已暂停全局高亮', 'ok');
      return;
    }
    renderGlobalState(res.globalEnabled !== undefined ? res.globalEnabled : value);
    toast(value ? '已开启全局高亮' : '已暂停全局高亮', 'ok');
  });

  // 站点禁用：storage 为主（内容脚本 storage.onChanged 必然生效），消息仅作提醒
  $('btn-site').addEventListener('click', async () => {
    if (!hostname) { toast('当前页面不支持站点设置', 'error'); return; }
    const { siteDisabledMap = {} } = await read(['siteDisabledMap']);
    const next = !siteDisabledMap[hostname];
    const map = Object.assign({}, siteDisabledMap);
    if (next) map[hostname] = true; else delete map[hostname];
    await write({ siteDisabledMap: map });

    setSiteDisabledView(next, true);
    const reply = await nudgeContent(MSG.SITE_CHANGED, { host: hostname, disabled: next });
    toast(next ? '已禁用本站高亮' : '已启用本站高亮', 'ok');
    if (!reply) console.info('[KH] popup：内容脚本未响应，站点状态已写入 storage，页面刷新后同样生效');
  });

  /* 快速添加：与关键词管理界面**一模一样**的独立编辑器（用户实测要求："单独弹出一个一模一样的弹出"）。
   *  ① 首选**委托当前网页**：860px 三列原地覆盖在页面上，观感就是选项页那个弹窗；
   *  ② 委托不了时（chrome:// / 扩展页 / 内容脚本还没注入，例如刚重载扩展未刷新页面）
   *     **另开一个独立编辑窗口**（popup/editor.html，920×500，同一套 UI）——
   *     绝不回退成"塞进 348px 的插件弹窗里"（那正是用户否掉的观感）。
   * 说明：v2 早期把"另开窗口"列为要避免的做法（R8），但那是针对"跳设置页、还得自己再点添加"；
   *   这里开的是**只装编辑器的独立窗口**，用户看到的就是那个弹窗本身，语义与观感都成立。
   */
  async function openQuickAdd(tabId) {
    try {
      let id = tabId;
      if (id == null) {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        id = t && t.id;
      }
      if (id != null) {
        const r = await chrome.tabs.sendMessage(id, { type: KH.MSG.EDITOR_OPEN });
        if (r && r.ok) { window.close(); return 'page'; }   // 已在页面上弹出 → 弹窗功成身退
      }
    } catch (err) { /* 内容脚本不可达 → 走独立窗口 */ }
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup/editor.html'),
      type: 'popup', width: 920, height: 500
    });
    window.close();
    return 'window';
  }

  $('btn-add').addEventListener('click', () => { openQuickAdd(null); });
  /* 供真浏览器回归直接驱动（等价于点按钮，但可以指定目标标签页） */
  KH.popupOpenQuickAdd = openQuickAdd;

  // 更新提示条 / 检查更新链接（统一走 background 的 kh:update:* 通道）
  $('btn-check-update').addEventListener('click', () => checkUpdate(true));

  /* 下载更新包：**先校验 SHA256 再打开下载地址**。
   * 升级点：旧逻辑直接打开 URL —— 用户拿到的包对不对无从判断；
   * 现在清单里带 sha256 时先下载校验，不一致直接拒绝（下载链路被劫持 / 文件损坏都能挡住）。
   * 兼容：清单没给 sha256 时跳过校验但照常可用；只有 crx 地址时走 crx 通道。 */
  $('btn-update').addEventListener('click', async () => {
    const info = currentUpdateInfo;
    if (!info) { toast('没有可用的更新信息', 'error'); return; }
    const url = info.zipUrl || info.crxUrl;
    if (!url) { toast('未找到更新包下载地址', 'error'); return; }
    if (info.sha256 && typeof UpdateChecker !== 'undefined') {
      toast('正在校验更新包（SHA256）…');
      const v = await UpdateChecker.downloadAndVerify(url, info.sha256);
      if (!v.ok) { toast(v.reason || '更新包校验失败', 'error'); return; }
      toast('校验通过，正在打开下载地址', 'ok');
    }
    try {
      await chrome.tabs.create({ url: url });
    } catch (e) {
      toast('打开下载地址失败', 'error');
      return;
    }
    if (!info.sha256) toast('已打开 v' + (info.latestVersion || '') + ' 下载地址', 'ok');
  });

  /* 更新通道切换：稳定版 ←→ 测试版。
   * 测试版读 latest-beta.json（提前发出的下一个版本号），稳定版读 latest.json ——
   * 两份清单分开，所以稳定用户永远不会被推测试版。
   * 注：crx 通道（Chrome 自动更新）无法分通道，测试版只能走 zip 通道更新。 */
  async function renderChannel() {
    const ch = await KH.UpdateChannel.get();
    const btn = $('btn-channel');
    if (btn) {
      btn.textContent = ch === 'beta' ? '测试版' : '稳定版';
      btn.title = '更新通道：' + (ch === 'beta' ? '测试版（只影响你本机）' : '稳定版') + '，点一下切换';
    }
  }
  if ($('btn-channel')) {
    $('btn-channel').addEventListener('click', async () => {
      const next = (await KH.UpdateChannel.get()) === 'beta' ? 'stable' : 'beta';
      await KH.UpdateChannel.set(next);
      await renderChannel();
      toast('已切到' + (next === 'beta' ? '测试版' : '稳定版') + '，正在重新检查…', 'ok');
      checkUpdate(true);
    });
  }

  $('btn-update-dismiss').addEventListener('click', () => {
    renderUpdateInfo(null);
  });

  // 帮助：跳到设置页「帮助与隐私」分区（v1 曾出现点击无效，这里保证绑定 + 可测）
  $('btn-help').addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sec-help') });
      window.close();
    } catch (e) { toast('打开帮助失败', 'error'); }
  });

  // 完整设置
  $('btn-options').addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
      window.close();
    } catch (e) { toast('打开设置页失败', 'error'); }
  });

  // 外部变更（background 广播 / 其它弹窗页 / 内容脚本）→ 实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.globalEnabled) renderGlobalState(changes.globalEnabled.newValue !== false);
    if (changes.siteDisabledMap && hostname) {
      setSiteDisabledView(!!((changes.siteDisabledMap.newValue || {})[hostname]), true);
    }
    if (changes.keywords) renderKeywordCount(changes.keywords.newValue);
    if (changes.khUpdateInfo) {
      const info = changes.khUpdateInfo.newValue;
      if (info && info.hasUpdate) renderUpdateInfo(info);
    }
  });

  renderChannel();          // 更新通道徽标（稳定版 / 测试版）
  render().catch((err) => {
    console.error('[KH] popup 初始化失败', err);
    setSiteDisabledView(false, false);
  });
})();
