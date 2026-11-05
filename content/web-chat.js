/**
 * content/web-chat.js · 「DeepSeek 网页对话」的**页面侧驱动**（2.0.8.5 需求：AI 助手默认免 Key）
 * ------------------------------------------------------------------------------------------------
 * 为什么要有这一层：
 *   chat.deepseek.com 没有公开接口，网页版对话靠登录态 + 站点自己的请求签名（PoW）才能发出去；
 *   扩展在后台直接调它的接口既拿不到签名也算不出题目。**唯一稳的办法是让一个真页面替你操作**：
 *   在这个标签页里把文字打进输入框、按回车、再把回复读出来。于是：
 *     · 标签页 = 用户的登录态（免 Key、免配置）
 *     · 本脚本 = 手，负责"打字 + 读回"
 *     · 后台 KhAi = 调度，面板 = 界面（用户看到的仍是插件自己的 AI 分页，不是嵌网页）
 *
 * 与后台的约定（消息类型都在 src/core/protocol.js 的 MSG 里）：
 *   WEB_PING  → { ok, loggedIn, url, at }          —— 后台判断"能不能用/要不要登录"
 *   WEB_ASK   → { ok, requestId }                   —— 立即回执，回复用 WEB_CHUNK 增量推
 *   WEB_CHUNK → { requestId, text, done, error }    —— text 是**全量**文本（不是 delta），面板直接覆盖
 *   WEB_NEW   → { ok }                              —— 开新对话（面板点"清空"时同步，免得上下文串台）
 *   WEB_STOP  → { ok }                              —— 中断当前这次（用户点停止 / 后台超时兜底）
 *
 * 选择器口径：网页是 React 应用，class 名带哈希、改版会变，所以**每一处都给多级兜底**，
 * 并且 `probe()` 会把"认出了哪个"报给设置页的自检按钮 —— 出问题时用户一键就能把诊断发回来。
 * ============================================================================================== */
(function () {
  'use strict';

  if (window.__khWebChatLoaded) return;
  window.__khWebChatLoaded = true;

  const MSG = (function () {
    try { return (self.KH && self.KH.MSG) || {}; } catch (e) { return {}; }
  })();
  const T_PING = MSG.WEB_PING || 'kh:web:ping';
  const T_ASK = MSG.WEB_ASK || 'kh:web:ask';
  const T_NEW = MSG.WEB_NEW || 'kh:web:new';
  const T_STOP = MSG.WEB_STOP || 'kh:web:stop';
  const T_CHUNK = MSG.WEB_CHUNK || 'kh:web:chunk';

  /** 一次提问最多等多久（网页版最慢也在十几秒内出完整答案；留足余量给长回答）。 */
  const ASK_TIMEOUT_MS = 180000;
  /** 文本连续多久没变算"这条回复说完了"。 */
  const SETTLE_MS = 900;
  /** 轮询步长（DOM 变化没有可靠事件可挂，轮询最省事，120ms 对人眼足够跟手）。 */
  const TICK_MS = 120;

  let current = null;

  /* ---------------------------------------------------------------- 选择器 */

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /** 输入框：官方 id → 可编辑框 → 带占位符的多行框，逐级退让。 */
  function findComposer() {
    const list = [
      'textarea#chat-input',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ];
    for (let i = 0; i < list.length; i++) {
      const all = document.querySelectorAll(list[i]);
      for (let j = all.length - 1; j >= 0; j--) if (visible(all[j])) return all[j];
    }
    return null;
  }

  /** 发送按钮：只在"回车没生效"时当兜底用。 */
  function findSendButton() {
    const list = [
      '[data-testid="send-button"]',
      'button[aria-label="Send"]',
      'button[aria-label*="发送"]',
      'div[role="button"][aria-label="Send"]',
      'div[role="button"][aria-label*="发送"]'
    ];
    for (let i = 0; i < list.length; i++) {
      const el = document.querySelector(list[i]);
      if (visible(el)) return el;
    }
    /* 最后一级：输入框右侧那一列按钮里、看起来是"发送"的那个（不含"上传/附件/联网"）。 */
    const btns = document.querySelectorAll('div[role="button"],button');
    for (let i = 0; i < btns.length; i++) {
      const el = btns[i];
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (!visible(el)) continue;
      if (/send|发送|提交/.test(label) && !/stop|停止|attach|附件|上传/.test(label)) return el;
    }
    return null;
  }

  /** 助手回复块：网页版用 `.ds-markdown` 渲染每条回答（同一页会有多条，取最后一条）。 */
  function replyBlocks() {
    return Array.prototype.slice.call(
      document.querySelectorAll('.ds-markdown, div[class*="ds-markdown--block"]')
    );
  }

  /** "正在生成"的迹象（有停止按钮 / 光标闪动），用来避免把半句话当成答案。 */
  function generating() {
    const btns = document.querySelectorAll('button,div[role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const el = btns[i];
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
      if (!visible(el)) continue;
      if (/^(停止|Stop)$/i.test(label) || /停止生成|Stop generating/i.test(label)) return true;
    }
    return false;
  }

  function isLoggedIn() {
    const href = location.href;
    if (/[?&]from=.*sign_in/.test(href) || /sign_in|login/i.test(location.pathname)) return false;
    return !!findComposer();
  }

  function probe() {
    const composer = findComposer();
    const send = findSendButton();
    const blocks = replyBlocks();
    return {
      ok: !!(composer || blocks.length),
      loggedIn: isLoggedIn(),
      url: location.href,
      title: document.title,
      composer: composer ? (composer.tagName.toLowerCase() + (composer.id ? '#' + composer.id : '')) : '',
      send: send ? (send.tagName.toLowerCase() + '[aria-label=' + (send.getAttribute('aria-label') || send.textContent || '').slice(0, 20) + ']') : '',
      blocks: blocks.length,
      at: Date.now()
    };
  }

  /* ---------------------------------------------------------------- 输入 */

  /** 往输入框写字：受控组件必须走原生 setter + input 事件，直接赋 value 会被 React 忽略。 */
  function typeText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      /* contenteditable：先全选再插入，等价于用户粘贴 —— React 能收到 input 事件。 */
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }
    return String(el.value != null ? el.value : el.textContent || '').length;
  }

  /** 按回车发送（网页版默认 Enter 发送、Shift+Enter 换行）。 */
  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function clickEl(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
    if (typeof el.click === 'function') { try { el.click(); } catch (e) { /* 已点过 */ } }
  }

  /* ---------------------------------------------------------------- 主流程 */

  function send(extra) {
    try {
      chrome.runtime.sendMessage(extra, function () { void (chrome.runtime && chrome.runtime.lastError); });
    } catch (e) { /* 扩展刚被重载：这一次的增量丢掉即可，后台会按超时报错 */ }
  }

  function stopCurrent(reason) {
    if (!current) return;
    const req = current;
    current = null;
    clearInterval(req.timer);
    if (req.observed) req.observed.disconnect();
    send({ type: T_CHUNK, requestId: req.requestId, text: req.text || '', done: true, error: reason || '' });
  }

  function ask(msg) {
    const requestId = String(msg.requestId || '');
    const text = String(msg.text || '');
    if (!requestId) return { ok: false, error: '缺少 requestId' };
    if (!text.trim()) return { ok: false, error: '空消息' };
    if (current) stopCurrent('被新的一次提问打断');

    const composer = findComposer();
    if (!composer) return { ok: false, needLogin: !isLoggedIn(), error: '没找到输入框（可能未登录，或网页改版了）' };

    const before = replyBlocks().length;
    const req = {
      requestId: requestId,
      text: '',
      before: before,
      startedAt: Date.now(),
      lastChangeAt: Date.now(),
      timer: 0,
      observed: null,
      sent: false,
      clicked: false
    };
    current = req;

    typeText(composer, text);
    pressEnter(composer);
    req.sent = true;

    /* 兜底 1：回车没把消息发出去（有些版本把 Enter 当换行）→ 1.2s 后点发送按钮。 */
    setTimeout(function () {
      if (current !== req) return;
      const grew = replyBlocks().length > req.before;
      if (!grew && !req.clicked) {
        const btn = findSendButton();
        if (btn) { req.clicked = true; clickEl(btn); }
      }
    }, 1200);

    req.timer = setInterval(function () {
      if (current !== req) return;
      const now = Date.now();
      if (now - req.startedAt > ASK_TIMEOUT_MS) { stopCurrent('等回复超时（' + Math.round(ASK_TIMEOUT_MS / 1000) + 's）'); return; }

      const blocks = replyBlocks();
      const grew = blocks.length > req.before;
      if (!grew) {
        /* 还没出回复：如果连用户那条消息都没出现，说明发送没成功，试试点按钮。 */
        if (!req.clicked && now - req.startedAt > 2500) {
          const btn = findSendButton();
          if (btn) { req.clicked = true; clickEl(btn); }
        }
        return;
      }

      const el = blocks[blocks.length - 1];
      const now_text = String(el.innerText || el.textContent || '').trim();
      if (now_text !== req.text) { req.text = now_text; req.lastChangeAt = now; send({ type: T_CHUNK, requestId: requestId, text: now_text, done: false }); }

      const settled = now - req.lastChangeAt > SETTLE_MS;
      if (settled && req.text && !generating()) stopCurrent('');
    }, TICK_MS);

    return { ok: true, requestId: requestId };
  }

  /** 开新对话：优先点页面上的"开启新对话"，找不到就回首页（首页就是新对话）。 */
  function newChat() {
    const nodes = document.querySelectorAll('a,button,div[role="button"]');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
      if (!visible(el)) continue;
      if (/^(开启新对话|新建对话|New chat|新的对话)$/i.test(label)) { clickEl(el); return { ok: true, how: 'click' }; }
    }
    if (location.pathname !== '/' ) { location.href = 'https://chat.deepseek.com/'; return { ok: true, how: 'nav' }; }
    return { ok: true, how: 'already-new' };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === T_PING) {
      sendResponse({ ok: true, loggedIn: isLoggedIn(), url: location.href, probe: probe() });
      return true;
    }
    if (msg.type === T_ASK) {
      const r = ask(msg || {});
      sendResponse(r);
      return true;
    }
    if (msg.type === T_NEW) { sendResponse(newChat()); return true; }
    if (msg.type === T_STOP) { stopCurrent('用户停止'); sendResponse({ ok: true }); return true; }
    return;
  });

  /* 供设置页"自检"在页面控制台里手动调用：`__khWebChat.probe()` */
  window.__khWebChat = { probe: probe, ask: ask, newChat: newChat, stop: function () { stopCurrent('用户停止'); } };
})();
