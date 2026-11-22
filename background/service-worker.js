/**
 * background/service-worker.js · 后台（MV3 Service Worker）
 * ----------------------------------------------------------------------------
 * 职责（严格限定，不含任何高亮业务逻辑）：
 *   1. 安装/更新：写默认值、打开欢迎页
 *   2. 快捷键：转发成统一消息给当前标签页 / 打开设置页
 *   3. 消息路由：统一走 `KH.MSG` 协议常量，禁止硬编码字符串
 *   4. 图标状态：随 globalEnabled 切换亮/灰图标
 *
 * 【2026-10-05 用户口径】后台不再做任何"线上更新"：`background/update-checker.js`、6h 轮询 alarm、
 * 动作栏 ↑ 徽标、`kh:update:*` 两条消息全部删除。更新通道只剩用户自己的本机开关
 * （`chrome.storage.local.khUpdateChannel`，读写见 src/core/channel.js），后台不再读它。
 *
 * 版本号唯一真源：manifest.json（本文件只读，不定义版本字面量）。
 */
'use strict';

importScripts('../src/core/protocol.js', '../src/core/config.js', 'tab-disabled.js', 'ocr.js', 'entity.js', 'policy.js', 'ai.js');

const MSG = self.KH.MSG;
/* 【2.0.7.2 需求⑤】标签页级临时禁用的状态机（storage.session 读写 + 关标签页清键）在旁边的模块里，
 * 这里只做路由与"改完推给那个标签页"。 */
const TabDisabled = self.KH.TabDisabled;

/** 版本唯一来源：manifest */
function currentVersion() {
  try { return chrome.runtime.getManifest().version || '0.0.0'; } catch (e) { return '0.0.0'; }
}

/* ---------------- 图标 ---------------- */

async function updateIcon(globalEnabled) {
  const suffix = globalEnabled ? '' : '-paused';
  const path = {
    16: chrome.runtime.getURL(`icons/icon16${suffix}.png`),
    32: chrome.runtime.getURL(`icons/icon32${suffix}.png`),
    48: chrome.runtime.getURL(`icons/icon48${suffix}.png`),
    128: chrome.runtime.getURL(`icons/icon128${suffix}.png`)
  };
  try { await chrome.action.setIcon({ path }); } catch (e) { console.warn('[KH] 更新图标失败', e); }
}

/* ---------------- 标签页广播 ---------------- */
async function broadcast(type, payload) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, Object.assign({ type }, payload || {})).catch(() => {})));
}

/** 【2.0.7.2 需求⑤】只推给某一个标签页：标签页级禁用的"点完立刻生效"全靠这条
 *  （用户点完按钮不刷新页面就该变灰 / 复原，不能等下一次 boot）。
 *  发不到就当没发过 —— 该页没有内容脚本（chrome:// 内部页、刚打开还没注入）时，
 *  它下次 boot 会自己来问 `TAB_DISABLED_QUERY`。 */
async function notifyTabDisabled(tabId, disabled) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, { type: MSG.TAB_DISABLED_CHANGED, disabled: !!disabled }); }
  catch (e) { /* 见上：没有接收方是正常情况，不是错误 */ }
}

/** 【2.0.14.4 需求】快捷键要"看得见"：标签页级禁用在黑名单页上按下去，页面本来就没高亮，
 *  肉眼看不到任何变化 ⇒ 用户以为快捷键没生效（用户 m12534 的原话就是「点不了/没反应」）。
 *  用 action 徽标闪一下 OFF / ON 1.6 秒当回执，完了清空（徽标平时为空，不占位、不劫持别处）。 */
/** action 徽标的**唯一**写入口**：闪 OFF/ON 与 1.6 秒后清空都从这里走，别再各写一份 setBadgeText ——
 *  两处并写时，后写的会把前一处还没到点的回执提前清掉。 */
function setActionBadge(text) {
  try { chrome.action.setBadgeText({ text: text || '' }); } catch (e) { /* 扩展已卸载：忽略 */ }
}

let flashTabTimer = 0;
async function flashTabState(disabled) {
  try { setActionBadge(disabled ? 'OFF' : 'ON'); } catch (e) { return; }
  if (flashTabTimer) { try { clearTimeout(flashTabTimer); } catch (e) {} }
  flashTabTimer = setTimeout(() => {
    flashTabTimer = 0;
    setActionBadge('');
  }, 1600);
}

/* ---------------- 切页广播（2.0.6.2 需求⑤） ----------------
 * 用户口径：切到**不可高亮**的标签页（黑名单 / 白名单以外 / 该站被禁用 / chrome 内部页）时，
 * 不许把上一个标签页的高亮与重要笔记缓存清掉；切到**可高亮**页时才完全清理
 * （保证同一时刻只有一个标签页在建立高亮与笔记）。
 * 判定留在内容脚本侧（它手里有完整配置与 `SiteRules`），这里只负责把"新页是谁"发出去。 */
chrome.tabs.onActivated.addListener(async (info) => {
  let url = '';
  try {
    const t = await chrome.tabs.get(info.tabId);
    /* 拿不到 url（chrome:// 等内部页、无 host 权限的页）= 不可高亮，正好由内容脚本按空串处理 */
    url = (t && t.url) || '';
  } catch (e) { url = ''; }
  await broadcast(MSG.TAB_SWITCH, { url: url, tabId: info.tabId });
});

/* ---------------- 安装 / 更新 ---------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
});

/* ---------------- 右键任意图 OCR（2.0.1.17 · SPEC 需求 6） ----------------
 * 权限增量只有 `contextMenus`（`host_permissions` 不变 —— 图能不能读由 `<all_urls>` 决定，
 * 而那是本功能之前就有的）。口径见 `SECURITY.md` 附录 B：右键即**逐次显式同意**，
 * 所以不走 `crossOriginSites` 白名单，也不新增任何 storage 键。
 */
const MENU_OCR_IMAGE = 'kh-ocr-image';

/** 注册（幂等）：`removeAll` + `create` —— SW 被 MV3 杀掉后菜单由浏览器保留，
 *  但更新/重载会丢，所以安装、更新与每次冷启动都补一次。 */
function registerMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      try {
        chrome.contextMenus.create({
          id: MENU_OCR_IMAGE,
          title: chrome.i18n.getMessage('menuOcrImage') || '用高亮词识别这张图',
          contexts: ['image']
        });
      } catch (e) { console.warn('[KH] 创建右键菜单失败', e); }
    });
  } catch (e) { console.warn('[KH] 注册右键菜单失败', e); }
}

/** B.5 第 1/2 步：只有 handler 拿得到 `info`；地址闸门（3–6 步）在 submitImage 入口，
 *  因为那里才有 `via` 可判（两条路汇入同一个函数 —— 见附录 B.6）。
 *  返回值只是给测试缝用（浏览器不看它）；失败一律静默：`via:'contextMenu'` 的回执
 *  不许往页面 DOM 回显任何东西（B.9）。 */
function onCtxMenuClicked(info, tab) {
  if (!info || info.menuItemId !== MENU_OCR_IMAGE) return;
  if (info.mediaType !== 'image') return;
  if (!info.srcUrl) return;
  return Promise.resolve()
    .then(() => self.OcrHost.submitImage(
      { type: MSG.OCR_IMAGE, src: info.srcUrl, via: 'contextMenu' },
      { tab: { id: (tab && tab.id != null) ? tab.id : null }, frameId: info.frameId || 0 }
    ))
    .catch(() => ({ ok: false, code: 'submit-failed' }));
}

chrome.contextMenus.onClicked.addListener(onCtxMenuClicked);

/* 真机探针的测试缝：原生右键菜单点不动（Chrome 的 UI 不给自动化），探针只能在 SW
 * 上下文里**直接调这个 handler**，传一份与浏览器同形的 `(info, tab)` —— 这才是与生产
 * 完全同形的入口（内容脚本自己 `sendMessage` 冒充右键过不了 `sender.tab` 那一关）。
 * 与 offscreen 的 `self.__khOcrDebug` 同类：只读不写、不参与业务路径。 */
self.__khCtxMenu = { onClicked: onCtxMenuClicked };

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'toggle-highlight': {
      const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
      await chrome.storage.local.set({ globalEnabled: !globalEnabled });
      await updateIcon(!globalEnabled);
      await broadcast(MSG.GLOBAL_CHANGED, { value: !globalEnabled });
      break;
    }
    case 'toggle-site': {
      /* 【2.0.7.2 需求⑤】快捷键改成**标签页级**翻转：以前是把 SITE_TOGGLE 丢给内容脚本，
       * 由它去翻 localStorage 里的 siteDisabledMap（整站）。现在判定权在后台（只有它拿得到
       * tabId 与 session 区），内容脚本只负责"收到推送就上下线"。 */
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length || tabs[0].id == null) break;
      const next = await TabDisabled.setDisabled(tabs[0].id);
      await notifyTabDisabled(tabs[0].id, next);
      /* 徽标回执：黑名单页上页面本来就没高亮，不闪一下等于按了没反应 */
      await flashTabState(next);
      break;
    }
    case 'open-settings':
      chrome.runtime.openOptionsPage();
      break;
  }
});

/** 【2.0.7.2 需求⑤】取消息涉及哪个标签页：设置页/弹窗手上有 tabId 就直接给；
 *  内容脚本给不了（它不知道自己是谁），只能靠 `sender.tab` —— 这也是判定必须留在后台的原因。 */
function tabIdOf(msg, sender) {
  if (msg && msg.tabId != null) return msg.tabId;
  if (sender && sender.tab && sender.tab.id != null) return sender.tab.id;
  return null;
}

/* ---------------- 消息路由（统一协议） ---------------- */

/* ---------------- 【2026-11-18 用户口径】没有地址的 PDF 控件 ----------------
 * 页面把 PDF 做成 `<span class="content-pdf">PDF</span>`，地址只有点开才知道。
 * 约定：内容脚本先发 `MSG.PDF_GRAB{requestId}` 开窗 → 拿到回执后点页面控件 →
 * 这里盯住新开的标签，认出 PDF 就抓住、关掉标签、用 `MSG.PDF_GRAB_RESULT` 回推给原标签页。
 * 认地址的三种形态（实测都会出现）：
 *   ① 直链 `https://.../xxx.pdf`：.pdf 可能在路径里，后面还挂着 ?v=1、#page=2；
 *   ② 跳板页把真地址塞在 ?file= / ?url= 参数里（Chrome 自带 PDF 阅读器就是这样）；
 *   ③ 既不是 .pdf 结尾、参数也解不出来 —— 对新标签做一次 HEAD，content-type 含 pdf 就认。
 * 边界：9 秒窗口、每个 requestId 只回一次、**无论成败都关掉本次点开的新标签**
 * （用户实测 m04718：只认 .pdf 时阅读器地址匹配不上，标签就一直挂着）。
 * 为什么不自己开标签拿地址：地址由页面脚本在点击时才拼出来，DOM 里没有。 */
const PDF_GRAB_URL = /\.pdf(?=$|[?#&/])/i;
const PDF_GRAB_PARAMS = ['file', 'url', 'src', 'pdf', 'download'];
const PDF_GRAB_TTL = 9000;
/* 【2.0.14.7 · B 档】点击后多久内的导航才算这次抓取的产物。太宽会把用户自己的跳转认成 PDF。 */
const PDF_GRAB_NAV_MS = 4000;
const PDF_HOOK_KEY = '__khPdfHook';
function grabParamUrl(u) {
  try {
    const s = String(u == null ? '' : u);
    const qi = s.indexOf('?');
    if (qi < 0) return '';
    const sp = new URLSearchParams(s.split('#')[0].slice(qi + 1));
    for (const k of PDF_GRAB_PARAMS) {
      const raw = sp.get(k);
      if (!raw) continue;
      let v = raw;
      try { v = decodeURIComponent(raw); } catch (e) { v = raw; }
      if (/^https?:/i.test(v)) return v;
    }
  } catch (e) { /* 非法 URL → 当没解到 */ }
  return '';
}
function pdfDirectOf(u) {
  const s = String(u == null ? '' : u).trim();
  if (!/^https?:/i.test(s)) return '';
  const noHash = s.split('#')[0];
  return PDF_GRAB_URL.test(noHash) ? noHash : '';
}
function pdfUrlOf(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  return pdfDirectOf(s) || pdfDirectOf(grabParamUrl(s));
}
function headIsPdf(u) {
  const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  const t = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) {} }, 2500);
  return fetch(u, { method: 'HEAD', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
    .then((r) => String((r.headers && r.headers.get('content-type')) || '').toLowerCase().indexOf('pdf') >= 0)
    .catch(() => false)
    .then((ok) => { clearTimeout(t); return ok; });
}

/* 【2026-11-18 用户口径②】抓地址不能再抢前台。
 * 页面多半是「点一下 → window.open / 开个新标签」，这一步发生在**页面的主世界**，隔离世界改不到；
 * 所以用 `chrome.scripting.executeScript({ world: 'MAIN' })` 临时按一个钩子：
 *   · 覆盖 window.open：拿到地址就**不真的开窗**；
 *   · 捕获阶段拦 .pdf 锚点：preventDefault，把地址截下来；
 * 抓到后用 `CustomEvent('kh:pdf:grabbed')` 交给内容脚本（跨世界传值只能走 DOM 事件），
 * 内容脚本回 `MSG.PDF_GRAB_DONE` 收工 —— 从头到尾**没有新标签**，前台不会被抢。
 * 钩子装不上（站点 CSP / 旧内核）就退回「盯新标签」：新标签一出现立刻压后台、原标签切回前台。
 * 两个函数是注入到页面里跑的，必须自包含，拿不到本文件的任何东西。 */
function mainWorldPdfHook(rid, KEY, clickMode) {
  var doc = document;
  var prev = window[KEY];
  try { if (prev && typeof prev.stop === 'function') prev.stop(); } catch (e) {}
  var st = { rid: rid, stopped: false, open: window.open, stub: null, click: null, timer: 0 };
  /* 还原 window.open 前先确认「现在挂的还是我们那个」：页面自己换过就不许覆盖。 */
  function restoreOpen() {
    try { if (st.stub && window.open === st.stub) window.open = st.open; } catch (e) {}
    st.stub = null;
  }
  function send(url) {
    if (st.stopped) return;
    var u = String(url == null ? '' : url).trim();
    if (!u) return;
    try {
      doc.dispatchEvent(new CustomEvent('kh:pdf:grabbed', { detail: JSON.stringify({ requestId: rid, url: u }) }));
    } catch (e) {}
  }
  /* clickMode=false（用户自己点）：**一个字节都不改页面** —— 不覆盖 window.open、不挂监听。
   * clickMode=true（插件替用户点）：只接管 window.open 一下，截到地址立刻还原。
   * 【用户实测 m05720】旧写法把 window.open 一直挂到 9 秒超时，页面自己的开窗全被吞掉；
   * 现在截到（或 8 秒自愈定时器到期）就一定还原。 */
  if (clickMode) {
    st.stub = function (u) {
      try { if (u) send(u); } catch (e) {}
      restoreOpen();
      /* 页面可能拿返回值当窗口用（`.focus()` / `.close()`），给个哑对象比 null 安全。 */
      return { focus: function () {}, close: function () {}, closed: false, location: { href: String(u || '') } };
    };
    try { window.open = st.stub; } catch (e) { st.stub = null; }
  }
  /* 唯一会动页面行为的地方：**我们自己的合成点击**落在「有明确 .pdf 地址的锚点」上时，
   * 截下地址并拦掉默认跳转（地址已知，不必真开标签）。
   * 【用户实测 2026-11-18】旧写法对 PDF 控件内的一切合成点击都 preventDefault + stopPropagation，
   * 而真实站点是「控件本身没有 href、由页面自己的 click 监听去 window.open」——
   * 拦掉冒泡，页面脚本压根不执行，window.open 一次都没调 ⇒ 永远抓不到地址。
   * 现在：控件的地址未知时**不拦**，让页面自己跑，靠 st.stub 截 window.open。
   * 用户真点的（isTrusted）一律不碰。 */
  st.click = function (ev) {
    try {
      if (!clickMode || (ev && ev.isTrusted)) return;
      var t = ev && ev.target;
      if (!t || !t.closest) return;
      var a = t.closest('a[href], area[href]');
      var href = a ? (a.href || a.getAttribute('href') || '') : '';
      /* 【2.0.14.6 · 用户 m13895】内容脚本替用户点之前会给控件打 `data-kh-pdf-arm`。
       * 标记内的一切 http(s) 锚点都截下 href 并拦掉跳转 —— 不再看 .pdf 后缀。
       * 服务端返回 PDF 的 `/download?id=1` 这类地址旧实现认不出，只能让页面真开一个标签、
       * 后台再压到后台并关掉（页签栏会闪）。现在地址在点击当场就拿到了。
       * 注意：页面若用 location.href / form 导航，没有可拦的锚点，仍走「开标签→关标签」兜底。 */
      var armed = null;
      try { armed = t.closest('[data-kh-pdf-arm]'); } catch (e2) { armed = null; }
      if (armed && href && /^https?:/i.test(href)) { send(href); ev.preventDefault(); return; }
      var known = href && /^https?:/i.test(href) && /\.pdf(?=$|[?#&/])/i.test(href.split('#')[0]);
      if (!known) return;
      send(href);
      ev.preventDefault();
    } catch (e) {}
  };
  if (clickMode) doc.addEventListener('click', st.click, true);
  st.stop = function () {
    if (st.stopped) return;
    st.stopped = true;
    restoreOpen();
    try { doc.removeEventListener('click', st.click, true); } catch (e) {}
    try { if (st.timer) clearTimeout(st.timer); } catch (e) {}
    st.timer = 0;
    try { if (window[KEY] === st) delete window[KEY]; } catch (e) {}
  };
  /* 页面内自愈：后台标签页被回收 / stop 没送到时，8 秒后也一定还原（绝不长期劫持）。 */
  try { st.timer = setTimeout(function () { try { st.stop(); } catch (e) {} }, 8000); } catch (e) {}
  window[KEY] = st;
}
function mainWorldPdfHookStop(KEY) {
  try { if (window[KEY] && typeof window[KEY].stop === 'function') window[KEY].stop(); } catch (e) {}
}
function khPdfHookInstall(tabId, requestId, clickMode) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        args: [requestId, PDF_HOOK_KEY, !!clickMode],
        func: mainWorldPdfHook
      }, () => {
        /* 【2.0.14.4 · 用户 m12586】以前无条件 resolve(true)：注入失败（受保护页面 / 权限变更）
         * 也回报"钩子已就位"，内容脚本照样去点，页面自己开的新标签就把前台抢走了。
         * 现在如实回报 —— 装不上就让调用方走"盯新标签 + 立刻压回后台"那条路。 */
        const err = chrome.runtime.lastError;
        resolve(!err);
      });
    } catch (e) { resolve(false); }
  });
}
function khPdfHookStop(tabId) {
  try {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      args: [PDF_HOOK_KEY],
      func: mainWorldPdfHookStop
    }, () => { void chrome.runtime.lastError; });
  } catch (e) {}
}

/** 一次抓取会话：钩子抓到地址 → finish(url)；钩子没装上 → 盯新标签（新标签一律压后台）。
 *  map 以 requestId 索引，`[MSG.PDF_GRAB_DONE]` 靠它找到对应会话收工。 */
const PDF_GRABS = new Map();
/* 【2.0.15 · PDF 错指】每个页面标签同时只允许一个抓取窗口：
 * 旧实现允许多个 requestId 在同一页并行等待（各字段各开一个），谁的窗口都愿意认领下一个新标签
 * ⇒ 字段 A 等的标签被字段 B 的会话先认领，A 就存下了 B 的地址（用户 m10954 的现场）。
 * 抓取本来就是"点一下、开一个标签"的串行动作，同一页并行没有意义。 */
const PDF_GRAB_BY_TAB = new Map();
function openPdfGrab(tabId, requestId, clickMode, key) {
  const st = { done: false, createdId: 0, click: !!clickMode, armAt: Date.now(), timer: null, poll: null, probed: new Set(), onCreated: null, onUpdated: null, onNav: null, onNavTarget: null, finish: null, key: String(key || ''), pageUrl: '', navPending: '' };
  /* 记住原页地址：同标签页跳转后要拨回来，也用来认出「这次导航不是本页」 */
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab) st.pageUrl = String(tab.url || tab.pendingUrl || '').split('#')[0];
    });
  } catch (e) {}
  /* 同一页上一个窗口必须收工（它等的那次点击已经过去了，留着只会抢别人的标签） */
  const prevTab = PDF_GRAB_BY_TAB.get(tabId);
  if (prevTab && prevTab !== st && prevTab.finish) prevTab.finish('');
  function stopWatch() {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.poll) { clearInterval(st.poll); st.poll = null; }
    if (st.onCreated) { try { chrome.tabs.onCreated.removeListener(st.onCreated); } catch (e) {} }
    if (st.onUpdated) { try { chrome.tabs.onUpdated.removeListener(st.onUpdated); } catch (e) {} }
    if (st.onNav) { try { chrome.webNavigation.onBeforeNavigate.removeListener(st.onNav); } catch (e) {} }
    if (st.onNavTarget) { try { chrome.webNavigation.onCreatedNavigationTarget.removeListener(st.onNavTarget); } catch (e) {} }
  }
  function closeTab(id) {
    if (!id || id === tabId) return;
    try { chrome.tabs.remove(id); } catch (e) {}
  }
  function backToPage() {
    try { chrome.tabs.update(tabId, { active: true }); } catch (e) {}
  }
  st.finish = function (url) {
    if (st.done) return;
    st.done = true;
    stopWatch();
    khPdfHookStop(tabId);
    if (PDF_GRABS.get(requestId) === st) PDF_GRABS.delete(requestId);
    if (PDF_GRAB_BY_TAB.get(tabId) === st) PDF_GRAB_BY_TAB.delete(tabId);
    /* 只有「插件替用户点」那次才允许关标签/切前台；用户自己点的标签一律不碰（用户口径 m05354） */
    /* 【2.0.14.7 · B 档】同标签页跳转时页面会被带走、内容脚本随之重载，这条结果消息没人接。
     * 地址另存一份（按控件令牌），内容脚本重新注入后自己来问。 */
    if (st.click && url && st.key && st.pageUrl) stashPdf(st.pageUrl, st.key, url);
    if (st.click) { closeTab(st.createdId); backToPage(); }
    try { chrome.tabs.sendMessage(tabId, { type: MSG.PDF_GRAB_RESULT, requestId: requestId, url: url || '' }); } catch (e) {}
  };
  /* 只认「本页自己开出来的」标签：openerTabId 必须等于正在抓取的页面。
   * 为什么不再无条件认领：抓取窗口最长 9 秒（PDF_GRAB_TTL），这段时间里用户
   * 自己开的标签、或插件替另一个字段点开的 PDF，都会被当成这一轮的产物，
   * 于是 A 字段存下 B 的地址（两字段同值被面板合并成「A/B」），
   * 或者反过来把用户的标签关掉（m10954 的现场）。 */
  function isOurs(tab) {
    if (!tab || tab.id == null || tab.id === tabId) return false;
    if (tab.openerTabId == null || tab.openerTabId !== tabId) return false;
    /* 「替用户点」的那次：只认点击之后 3 秒内出现的标签。
     * 更晚出现的是用户自己后来开的（跳转/新窗口），不能算作这次点击的产物。 */
    if (st.click && Date.now() - st.armAt > 3000) return false;
    return true;
  }
  function consider(id, u) {
    if (st.done || !id) return;
    const direct = pdfUrlOf(u);
    if (direct) { if (!st.createdId) st.createdId = id; st.finish(direct); return; }
    const http = /^https?:/i.test(String(u || '')) ? String(u).split('#')[0] : grabParamUrl(u);
    if (!http || st.probed.has(http)) return;
    st.probed.add(http);
    headIsPdf(http).then((ok) => { if (ok) { if (!st.createdId) st.createdId = id; st.finish(http); } });
  }
  st.onCreated = (tab) => {
    if (st.done || !isOurs(tab)) return;
    if (!st.createdId) st.createdId = tab.id;
    if (tab.id !== st.createdId) return;
    /* 只有「插件替用户点」的那次才压后台：用户自己点开的标签必须正常打开（用户口径 m05354） */
    if (st.click) {
      try { chrome.tabs.update(tab.id, { active: false }); } catch (e) {}
      backToPage();
    }
    consider(tab.id, tab.url || tab.pendingUrl);
  };
  st.onUpdated = (id, info, tab) => {
    if (st.done || id === tabId) return;
    /* 还没认领时也只接受本页发起的标签（openerTabId 对不上就跳过，见 isOurs） */
    if (!st.createdId) { if (!isOurs(tab)) return; st.createdId = id; }
    if (id !== st.createdId) return;
    /* 【2.0.14.4 · 用户 m12586】替用户点出来的标签会抢前台：一认领就压回后台，
     * 并把前台还给原标签页。只对 click 模式这么做 —— 用户自己点开的（click=false）不许动，
     * 那是他自己要看的标签。 */
    if (st.click) {
      try { chrome.tabs.update(id, { active: false }); } catch (e) {}
      try { chrome.tabs.update(tabId, { active: true }); } catch (e) {}
    }
    consider(id, (info && info.url) || (tab && tab.url));
  };
  /* 【2.0.14.7 · 用户 m13895 B 档】两种「不产生新标签」的形态也要能拿到地址：
   * ① location.href = … / 表单提交把 PDF 送到**当前标签页**（没有 window.open 可拦）；
   * ② 子 frame 里 window.open（主世界钩子只装在顶层 frame，抓不到）。
   * 只在「替用户点」的会话里、且点击后 4 秒内生效；地址必须真的像 PDF（headIsPdf）才认。 */
  function navCandidate(u) {
    const s = String(u || '').split('#')[0];
    if (!/^https?:/i.test(s)) return '';
    if (st.probed.has(s)) return '';
    st.probed.add(s);
    return s;
  }
  /* 同标签页跳转：先让它走，700ms 后看地址有没有真的变过去。
   * 变了（浏览器已经把页面带到 PDF）就拨回原页 —— 地址已先记下，重载后由内容脚本认领；
   * 没变（服务端 Content-Disposition 直接下载）就只收地址，页面一次都不重载。 */
  function restoreThenFinish(u) {
    if (st.done || st.navPending === u) return;
    st.navPending = u;
    setTimeout(() => {
      if (st.done) return;
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (st.done) return;
          const cur = String((tab && (tab.url || tab.pendingUrl)) || '').split('#')[0];
          if (cur && st.pageUrl && cur !== st.pageUrl) {
            try { chrome.tabs.update(tabId, { url: st.pageUrl }); } catch (e) {}
          }
          st.finish(u);
        });
      } catch (e) { st.finish(u); }
    }, 700);
  }
  st.onNav = (d) => {
    if (st.done || !d || d.frameId !== 0 || d.tabId !== tabId) return;
    if (Date.now() - st.armAt > PDF_GRAB_NAV_MS) return;
    const u = navCandidate(d.url);
    if (!u || u === st.pageUrl) return;
    headIsPdf(u).then((ok) => { if (ok && !st.done) restoreThenFinish(u); });
  };
  st.onNavTarget = (d) => {
    if (st.done || !d || d.sourceTabId !== tabId) return;
    if (Date.now() - st.armAt > PDF_GRAB_NAV_MS) return;
    const u = navCandidate(d.url);
    if (!u || u === st.pageUrl) return;
    headIsPdf(u).then((ok) => {
      if (!ok || st.done) return;
      if (!st.createdId && d.tabId != null) st.createdId = d.tabId;
      st.finish(u);
    });
  };
  /* 两个模式都旁听新标签：用户自己点开的那次也能把地址记下来（不压后台、不关标签、不切前台） */
  {
    chrome.tabs.onCreated.addListener(st.onCreated);
    chrome.tabs.onUpdated.addListener(st.onUpdated);
    if (st.click && chrome.webNavigation) {
      try { chrome.webNavigation.onBeforeNavigate.addListener(st.onNav); } catch (e) {}
      try { chrome.webNavigation.onCreatedNavigationTarget.addListener(st.onNavTarget); } catch (e) {}
    }
  }
  /* onUpdated 会漏（同一 URL 重复上报、标签页定向前就先定位）→ 300ms 轮询兜底 */
  st.poll = setInterval(() => {
    if (st.done || !st.createdId) return;
    try {
      chrome.tabs.get(st.createdId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        consider(st.createdId, tab.url || tab.pendingUrl);
      });
    } catch (e) {}
  }, 300);
  st.timer = setTimeout(() => st.finish(''), PDF_GRAB_TTL);
  PDF_GRABS.set(requestId, st);
  PDF_GRAB_BY_TAB.set(tabId, st);
  return st;
}
async function pdfGrab(msg, sender) {
  const requestId = String((msg && msg.requestId) || '');
  const tabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : -1;
  if (!requestId || tabId < 0) return { ok: false, error: '没有可回推的标签页' };
  const clickMode = !!(msg && msg.click);
  const prev = PDF_GRABS.get(requestId);
  if (prev && prev.finish) prev.finish('');
  openPdfGrab(tabId, requestId, clickMode, (msg && msg.key) || '');
  /* 先把钩子装好再回话：内容脚本拿到 `{armed:true}` 才去点，否则仍有竞态 */
  const armed = await khPdfHookInstall(tabId, requestId, clickMode);
  return { ok: true, armed: armed, click: clickMode, requestId: requestId };
}
/* 【2.0.14.7 · B 档】同标签页跳转抓到的地址要跨过一次页面重载：存 storage.session，
 * 内容脚本重新注入后按控件令牌（autoPdfTokenKey）认领回来。5 分钟过期、最多 40 条。 */
const PDF_STASH_KEY = 'khPdfStash';
const PDF_STASH_TTL = 5 * 60 * 1000;
function stashGet() {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.session) { resolve([]); return; }
      chrome.storage.session.get(PDF_STASH_KEY, (o) => {
        void chrome.runtime.lastError;
        const list = (o && Array.isArray(o[PDF_STASH_KEY])) ? o[PDF_STASH_KEY] : [];
        resolve(list);
      });
    } catch (e) { resolve([]); }
  });
}
async function stashPdf(pageUrl, key, url) {
  if (!pageUrl || !key || !url) return;
  const now = Date.now();
  const list = (await stashGet()).filter((x) => x && x.pageUrl && now - x.at < PDF_STASH_TTL);
  list.push({ pageUrl: String(pageUrl).split('#')[0], key: String(key), url: String(url), at: now });
  try { chrome.storage.session.set({ [PDF_STASH_KEY]: list.slice(-40) }); } catch (e) {}
}
async function pdfStashQuery(msg) {
  const page = String((msg && msg.pageUrl) || '').split('#')[0];
  const now = Date.now();
  const list = (await stashGet()).filter((x) => x && now - x.at < PDF_STASH_TTL && x.pageUrl === page);
  return { ok: true, items: list.map((x) => ({ key: x.key, url: x.url })) };
}
function pdfGrabDone(msg) {
  const requestId = String((msg && msg.requestId) || '');
  const st = PDF_GRABS.get(requestId);
  if (!st) return { ok: false };
  const raw = String((msg && msg.url) || '');
  st.finish(pdfUrlOf(raw) || raw);
  return { ok: true };
}
/** 点 PDF 小标看**正文**：内容脚本自己开标签会被站点拦，统一由这里开。 */
function pdfOpen(msg) {
  const raw = String((msg && msg.url) || '');
  const url = pdfUrlOf(raw) || raw;
  if (!/^https?:/i.test(url)) return { ok: false, error: '地址不可用' };
  try {
    chrome.tabs.create({ url: url, active: true });
    return { ok: true, url: url };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
const HANDLERS = {
  [MSG.STATE_QUERY]: async () => {
    const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
    return { ok: true, globalEnabled, version: currentVersion() };
  },

  [MSG.GLOBAL_TOGGLE]: async (msg) => {
    const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
    const next = (msg.value === undefined) ? !globalEnabled : !!msg.value;
    await chrome.storage.local.set({ globalEnabled: next });
    await updateIcon(next);
    await broadcast(MSG.GLOBAL_CHANGED, { value: next });
    return { ok: true, globalEnabled: next };
  },

  [MSG.SITE_TOGGLE]: async (msg, sender) => {
    const url = (msg.url || (sender && sender.tab && sender.tab.url) || '');
    let host = '';
    let proto = '';
    try { const u = new URL(url); host = u.hostname; proto = u.protocol; } catch (e) { return { ok: false, error: '无法解析主机名' }; }
    if (!host) return { ok: false, error: '无法解析主机名' };
    /* 2.0.8.11 C4：只接受普通网页。设置页/弹窗发这条消息时 `sender.tab` 指向扩展自己的页面，
     * 旧逻辑会把 `chrome-extension://<扩展 id>` 的 hostname（=扩展 id）写进 siteDisabledMap，
     * 从此用户永远看不到"这条规则是哪来的"。非 http(s) 一律拒绝且不落盘。 */
    if (proto !== 'http:' && proto !== 'https:') {
      return { ok: false, error: '当前页不是普通网页，没有本站开关' };
    }

    const { siteDisabledMap = {} } = await chrome.storage.local.get('siteDisabledMap');
    const next = !siteDisabledMap[host];
    if (next) siteDisabledMap[host] = true; else delete siteDisabledMap[host];
    await chrome.storage.local.set({ siteDisabledMap });
    await broadcast(MSG.SITE_CHANGED, { host, disabled: next });
    return { ok: true, host, disabled: next };
  },

  /* ---- 【2.0.7.2 需求⑤】标签页级临时禁用：问 / 设 ----
   * 为什么是"问"而不是直接让内容脚本读：`chrome.storage.session` 只有扩展自己的页面与后台能读；
   * tabId 也只有后台从 `sender.tab` 拿得到（内容脚本不知道自己属于哪个标签页）。
   * 所以判定一律由后台做，内容脚本只接收结论。 */
  [MSG.TAB_DISABLED_QUERY]: async (msg, sender) => {
    const tabId = tabIdOf(msg, sender);
    return { ok: true, tabId, disabled: await TabDisabled.isDisabled(tabId) };
  },

  [MSG.TAB_DISABLED_SET]: async (msg, sender) => {
    const tabId = tabIdOf(msg, sender);
    if (tabId == null) return { ok: false, error: '缺少 tabId' };
    /* msg.disabled 省略 = 翻转（快捷键语义）；给了就按给定值写（按钮语义，幂等、不怕连点） */
    const next = await TabDisabled.setDisabled(tabId, (msg && msg.disabled === undefined) ? undefined : !!msg.disabled);
    await notifyTabDisabled(tabId, next);
    return { ok: true, tabId, disabled: next };
  },

  /* ---- 【2.0.8.4 需求④】AI 对话助手：内容脚本 / 设置页 → background（请求在这里发） ----
   * 只做转发，不在这里拼提示词（"纯自由对话，不带页面内容"的口径由面板那边只发用户输入保证）。 */
  [MSG.AI_CHAT]: (msg) => self.KhAi.chat(msg || {}),
  /* 【2.0.8.7 需求②】AI 审核（名称/图标）：多模态一条独立通道，见 background/ai.js 的 AI.audit。 */
  [MSG.AI_AUDIT]: (msg) => self.KhAi.audit(msg || {}),

  /* ---- 【2.0.8.8 需求③】查法定代表人（免费免登陆：爱企查 → 必应，见 background/entity.js）----
   * 只读查询：失败一律回 `{ok:false,error}`，面板据此保持原底色（用户口径：未查明不改色）。 */
  [MSG.ENTITY_LOOKUP]: (msg, sender) => {
    const name = String((msg && msg.name) || '').trim();
    const p = self.KH.Entity.lookup(msg || {});
    /* 【用户 m07376 问题二】面板只等 20 秒，而爱企查标签页常常要更久。
     * 结果晚到也要送回去：同一标签页里的面板收到 ENTITY_READY 就地重画，
     * 用户不用关卡片重开（以前只写后台缓存，面板停在「⏱ 超时」）。 */
    const tabId = (sender && sender.tab && sender.tab.id) || 0;
    if (tabId) {
      p.then((res) => {
        if (!res || !res.ok || !res.rep) return;
        try { chrome.tabs.sendMessage(tabId, { type: MSG.ENTITY_READY, name: name, rep: String(res.rep) }); } catch (e) { /* 标签页已关 */ }
      }, () => { /* 查询失败：面板自己按未查明收口 */ });
    }
    return p;
  },

  /* ---- 【2.0.8.15 需求①】隐私政策链接正文（用户口径：打开链接明明有，判定却说没有）----
   * 内容脚本里的 fetch 按页面来源走 CORS，政策站点不会放行；这里用扩展来源抓 + 7 天缓存，
   * 只回 HTML 正文文字，抓不到就 `{ok:false, reason}`，面板退回卡片抓取值并写明原因。 */
  [MSG.POLICY_TEXT]: (msg) => self.KH.Policy.fetchText((msg && msg.url) || '', { hints: (msg && msg.hints) || [] }),
  /* 【2.0.14.6 · A 档】机会式缓存：用户自己打开过的政策页，内容脚本把正文送回后台存缓存。只读、无网络。 */
  [MSG.POLICY_CACHE]: (msg) => self.KH.Policy.rememberText((msg && msg.url) || '', (msg && msg.text) || ''),
  [MSG.POLICY_CACHE_CLEAR]: () => self.KH.Policy.clearCache(),

  /* ---- 【2.0.8.5】网页对话（免 Key）：面板 → 后台 → chat.deepseek.com 上的 content/web-chat.js ----
   * 这三条都是"开标签页 / 自检 / 开新对话"，真正的提问走长连接（见文件末尾的 onConnect）。 */
  [MSG.AI_WEB_OPEN]: () => self.KhAi.openWeb(),
  [MSG.AI_WEB_PROBE]: () => self.KhAi.probeWeb(),
  [MSG.AI_WEB_NEW]: () => self.KhAi.newWebChat(),

  /* 网页侧推回来的增量：按 requestId 交给 KhAi，它会转给发起这次提问的那条长连接。 */
  [MSG.WEB_CHUNK || 'kh:web:chunk']: (msg) => { self.KhAi.onWebChunk(msg); return { ok: true }; },

  /* 面板在"还没配置"时给的一键入口：内容脚本调 chrome.runtime.openOptionsPage 不可靠（老内核没有）。 */
  [MSG.AI_OPEN_OPTIONS]: async () => {
    try { await chrome.runtime.openOptionsPage(); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  },

  /* ---- 【2026-11-18 用户口径】没有地址的 PDF 控件：点一次，把新标签的 .pdf 地址抓回来 ---- */
  [MSG.PDF_GRAB]: (msg, sender) => pdfGrab(msg, sender),
  [MSG.PDF_GRAB_DONE]: (msg) => pdfGrabDone(msg),
  [MSG.PDF_STASH_QUERY]: (msg) => pdfStashQuery(msg),
  [MSG.PDF_OPEN]: (msg) => pdfOpen(msg),

  /* ---- ocr：内容脚本/设置页 → background → offscreen 文档（引擎在那里跑） ---- */
  [MSG.OCR_IMAGE]: (msg, sender) => self.OcrHost.submitImage(msg, sender),
  /* PDF 抽文字：与图片共用一套路由与看门狗，只是 offscreen 那边不跑引擎 */
  [MSG.OCR_PDF]: (msg, sender) => self.OcrHost.submitPdf(msg, sender),

  [MSG.OCR_CANCEL]: (msg, sender) => self.OcrHost.cancelTab(
    (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId,
    msg.pageId
  ),

  [MSG.OCR_LANG_STATE]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_DOWNLOAD]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_IMPORT]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_LANG_CLEAR]: (msg) => self.OcrHost.ask(msg),
  /* 主引擎的模型资产（S2-c）：同样走 ask（请求-应答，等它下完/校验完再回设置页） */
  [MSG.OCR_MODEL_STATE]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_MODEL_DOWNLOAD]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_MODEL_IMPORT]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_MODEL_CLEAR]: (msg) => self.OcrHost.ask(msg),
  [MSG.OCR_SELFTEST]: (msg) => self.OcrHost.submitImage(msg, { tab: null, url: 'chrome-extension://ui/' })
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* offscreen 文档的回执/结果先给中转站（它按 requestId 决定"回 promise"还是"送回标签页"） */
  if (msg && msg.to === 'background' && self.OcrHost && self.OcrHost.onOffscreenMessage(msg)) return false;
  /* ⚠️ 带 `to` 标记的消息是**我们自己发出去的**（发给 offscreen / 广播给 UI）：
   * onMessage 是"所有扩展上下文都能收到"的，不在这里挡掉，背景自己就会把
   * `{to:'offscreen', type: ocr:image}` 当成"内容脚本的识别请求"再转发一次 → 无限自圈。 */
  if (msg && msg.to) return false;
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // 异步响应
});

/* ---------------- 【2.0.8.5】AI 助手长连接（流式回包） ----------------
 * 为什么不用 sendMessage：`sendMessage` 只能"一问一答"一次回执，而网页对话是**边生成边出字**，
 * 面板要一行行地显示出来（否则要等十几秒才蹦出整段，体验差）。
 * 约定：面板 connect({name:'kh:ai'}) 后发
 *   { action:'ask', mode:'web'|'api', messages:[…] }
 * 后台回
 *   { type:'chunk', text }         —— 追加/覆盖的**全量**文本（面板直接覆盖最后一条）
 *   { type:'done',  text }         —— 成功结束（text 是最终全文）
 *   { type:'error', error, needLogin }
 * 同一条连接上可以连续问多轮；面板关掉（port 断开）时把没结束的请求标记为放弃。 */
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== ((MSG && MSG.AI_PORT) || 'kh:ai')) return;
  let busy = false;
  port.onDisconnect.addListener(() => { busy = false; });

  port.onMessage.addListener((msg) => {
    const m = msg || {};
    if (m.action === 'new') {
      Promise.resolve()
        .then(() => self.KhAi.newWebChat())
        .then((r) => { try { port.postMessage({ type: 'newChat', ok: !!(r && r.ok) }); } catch (e) { /* 面板已关 */ } })
        .catch(() => {});
      return;
    }
    if (m.action !== 'ask') return;
    if (busy) { try { port.postMessage({ type: 'error', error: '上一条还在回，等它说完' }); } catch (e) {} return; }
    busy = true;
    const post = (obj) => { try { port.postMessage(obj); } catch (e) { /* 页面关了 */ } };
    const mode = (m.mode === 'api') ? 'api' : 'web';
    const run = (mode === 'api')
      ? Promise.resolve().then(() => self.KhAi.chat({ messages: m.messages }))
        .then((r) => (r && r.ok ? { ok: true, text: r.text } : { ok: false, error: (r && r.error) || '请求失败' }))
      : self.KhAi.askWeb({ messages: m.messages, onChunk: (text) => post({ type: 'chunk', text: text }) });
    Promise.resolve(run)
      .then((r) => {
        busy = false;
        if (r && r.ok) post({ type: 'done', text: String(r.text || '') });
        else post({ type: 'error', error: String((r && r.error) || '请求失败'), needLogin: !!(r && r.needLogin) });
      })
      .catch((err) => { busy = false; post({ type: 'error', error: String((err && err.message) || err) }); });
  });
});

/* 【2.0.12.10 性能·旧页拖累 OCR —— 这里故意不挂 chrome.tabs.onUpdated】试过，撤掉了：
 * 导航开始时就按 tabId 撤整个标签页的任务，看起来最直接，但事件是**异步**送到后台的，
 * 而新页面内容脚本排队可能更早 ⇒ 上一条取消会把**新页面**刚排上的图当旧页的撤掉。
 * 真机实测（700×900 密排 8 张）：这条监听在时，A 页首图 14.9s → 20.0s / 23.1s，去掉就回到 14.9s。
 * 现在的取消只来自两处，都不会误伤：①页面自己的 pagehide（带 pageId，见
 * src/features/img-ocr.js，后台 cancelTab(tabId, pageId) 只撤同一页）；②标签页关闭（onRemoved）。
 * 页面崩溃等 pagehide 收不到的情形，由 offscreen 的看门狗兜底（无进度 120s / 绝对 10 分钟）。
 */
/* 标签页关闭 → 丢掉它在排队的识别任务（免得为一个已经不存在的页面白烧 CPU）；
 * 顺手清掉它的标签页级禁用记录（【2.0.7.2 需求⑤】"关掉标签页就自动取消"的硬保证：
 * 靠"页面没了自然不高亮"是不够的，tabId 会被浏览器复用，残留记录会让新标签页一开就是灰的） */
chrome.tabs.onRemoved.addListener((tabId) => {
  try { self.OcrHost.cancelTab(tabId); } catch (e) { /* ignore */ }
  TabDisabled.clearTab(tabId).catch(() => {});
});

/* ---------------- 存储变更 → 图标 ---------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.globalEnabled) updateIcon(changes.globalEnabled.newValue);
});

/* ---------------- 冷启动自检 ---------------- */

(async () => {
  registerMenus();
  const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
  await updateIcon(globalEnabled);
})();

