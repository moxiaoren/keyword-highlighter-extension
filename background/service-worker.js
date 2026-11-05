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

importScripts('../src/core/protocol.js', '../src/core/config.js', 'tab-disabled.js', 'ocr.js', 'entity.js', 'ai.js');

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
    registerMenus();
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
    try { host = new URL(url).hostname; } catch (e) { return { ok: false, error: '无法解析主机名' }; }
    if (!host) return { ok: false, error: '无法解析主机名' };

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
  [MSG.ENTITY_LOOKUP]: (msg) => self.KH.Entity.lookup(msg || {}),

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

  /* ---- ocr：内容脚本/设置页 → background → offscreen 文档（引擎在那里跑） ---- */
  [MSG.OCR_IMAGE]: (msg, sender) => self.OcrHost.submitImage(msg, sender),
  /* PDF 抽文字：与图片共用一套路由与看门狗，只是 offscreen 那边不跑引擎 */
  [MSG.OCR_PDF]: (msg, sender) => self.OcrHost.submitPdf(msg, sender),

  [MSG.OCR_CANCEL]: (msg, sender) => self.OcrHost.cancelTab(
    (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId
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
  'kh:ocr:selftest': (msg) => self.OcrHost.submitImage(msg, { tab: null, url: 'chrome-extension://ui/' })
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
