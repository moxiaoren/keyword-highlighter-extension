(function () {
  'use strict';
  /* background/webai.js —— 「自定义网页 AI」通路（2.0.19 · 用户 m28030）
   * ----------------------------------------------------------------------------
   * 公司内网 AI 往往只有网页版、没有 API，而且网址只该留在用户本机。这里不写死任何站点：
   *   设置页给 4 个值 —— 网址 / 输入框 / 发送按钮 / 回答区（CSS 选择器），
   *   后台开一个**不抢前台**的标签页加载它（复用你已登录的会话），
   *   把问题写进输入框、点发送，再轮询回答区文字，稳定下来就是把回复整段交回面板。
   *
   * 三条硬约束：
   *   ① 数据不出内网：这里从不 fetch 外部，也不经过太极AI；
   *   ② 不抢焦点：标签页 active:false，提问期间用户还能干别的；
   *   ③ 页面改版只影响这一条通路，靠设置页「点选元素」重选即可，不用改代码。
   */

  const W = {};
  const TAB_TIMEOUT = 20000;   /* 等标签页加载完的上限 */
  const ANSWER_TIMEOUT = 180000; /* 等回答结束的绝对上限 */
  const POLL_MS = 350;

  function nowMs() { return Date.now(); }

  function errText(e) {
    if (!e) return '未知错误';
    return String((e && e.message) || e);
  }

  /* 只接受 http(s)：javascript:/data: 之类不能当「网页」打开。 */
  function okUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  /* 同源同路径的标签页视为同一个「通道页」，避免每问一句开一个新页。 */
  function samePage(a, b) {
    try {
      const x = new URL(a); const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch (e) { return false; }
  }

  function waitTabComplete(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
        clearTimeout(timer);
        resolve(ok);
      };
      const onUpd = (id, info) => { if (id === tabId && info && info.status === 'complete') finish(true); };
      chrome.tabs.onUpdated.addListener(onUpd);
      const timer = setTimeout(() => finish(false), TAB_TIMEOUT);
      /* 已经在 complete 的标签页不会再发事件，先探一次。 */
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) { finish(false); return; }
        if (t && t.status === 'complete') finish(true);
      });
    });
  }

  /* 找到（或新建）承载这个 AI 页的标签页，返回 tabId。 */
  async function ensureTab(url, keep) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { tabs = []; }
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (t && !t.incognito && t.url && samePage(t.url, url)) return t.id;
    }
    const tab = await chrome.tabs.create({ url: url, active: false, pinned: !!keep });
    const ok = await waitTabComplete(tab.id);
    if (!ok) throw new Error('页面 20 秒内没有加载完（网址或内网连通性可能有问题）');
    return tab.id;
  }

  async function run(tabId, func, args) {
    const out = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [] });
    return (out && out[0]) ? out[0].result : null;
  }

  /* 注入到页面里：把文字写进输入框（兼容 input/textarea 与 contenteditable）。 */
  function fillPage(p) {
    const text = String(p.text || '');
    let el = null;
    try { el = document.querySelector(p.inputSel); } catch (e) { return { ok: false, error: '输入框选择器写错了（浏览器解析不了）' }; }
    if (!el) return { ok: false, error: '这个页面上找不到输入框（选择器可能过期了，重新点选一次）' };
    try {
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
      } else {
        el.textContent = text;
      }
      el.focus();
      /* React / Vue 受控输入只认 input 事件，光改 value 不会进框架状态。 */
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { return { ok: false, error: '写不进输入框：' + String((e && e.message) || e) }; }
    return { ok: true };
  }

  /* 注入到页面里：点发送（没配按钮就按 Enter）。 */
  function sendPage(p) {
    if (p.sendSel) {
      let btn = null;
      try { btn = document.querySelector(p.sendSel); } catch (e) { return { ok: false, error: '发送按钮选择器写错了' }; }
      if (!btn) return { ok: false, error: '找不到发送按钮（选择器可能过期了）' };
      try { btn.click(); } catch (e) { return { ok: false, error: '按钮点不动：' + String((e && e.message) || e) }; }
      return { ok: true, how: 'click' };
    }
    let el = null;
    try { el = document.querySelector(p.inputSel); } catch (e) { el = null; }
    if (!el) return { ok: false, error: '请输入发送按钮，或让输入框能按 Enter 发送' };
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opt));
    el.dispatchEvent(new KeyboardEvent('keyup', opt));
    return { ok: true, how: 'enter' };
  }

  /* 注入到页面里：读回答区当前文字。 */
  function readPage(p) {
    let el = null;
    try { el = document.querySelector(p.answerSel); } catch (e) { return { ok: false, error: '回答区选择器写错了' }; }
    if (!el) return { ok: false, error: '这个页面上找不到回答区（选择器可能过期了）' };
    return { ok: true, text: String(el.innerText || el.textContent || '') };
  }

  /* 注入到页面里：确认三个选择器都能命中（设置页「测试」用）。 */
  function probePage(p) {
    const hit = (sel) => {
      if (!sel) return true;
      try { return !!document.querySelector(sel); } catch (e) { return false; }
    };
    return {
      ok: true,
      title: String(document.title || ''),
      input: hit(p.inputSel),
      send: hit(p.sendSel),
      answer: hit(p.answerSel)
    };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* 把面板发来的对话压成一句问题：网页版 AI 自己保留上下文，这里只给最后一问。 */
  W.promptOf = function (messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role === 'user') {
        const t = String(m.content || m.text || '').trim();
        if (t) return t;
      }
    }
    return '';
  };

  /* 主入口：问一句，等它稳定，返回整段回答。 */
  W.ask = async function (opts) {
    const o = opts || {};
    const c = o.custom || {};
    const url = okUrl(c.url);
    if (!url) return { ok: false, error: '还没在设置页填「自定义网页 AI」的网址' };
    if (!c.input) return { ok: false, error: '还没选输入框（设置页可以点「点选元素」）' };
    const answerSel = c.answer || c.input;
    const text = String(o.text || '').trim();
    if (!text) return { ok: false, error: '没有要发送的内容' };
    const idleMs = Math.max(400, Number(c.idleMs) || 1200);

    let tabId = 0;
    try { tabId = await ensureTab(url, c.keepTab !== false); }
    catch (e) { return { ok: false, error: errText(e) }; }

    let base = '';
    try {
      const b = await run(tabId, readPage, [{ answerSel: answerSel }]);
      if (b && b.ok) base = String(b.text || '');
    } catch (e) { /* 读不到基准不影响提问，退化成整段返回 */ }

    try {
      const filled = await run(tabId, fillPage, [{ inputSel: c.input, text: text }]);
      if (!filled || !filled.ok) return { ok: false, error: (filled && filled.error) || '写不进输入框' };
      const sent = await run(tabId, sendPage, [{ inputSel: c.input, sendSel: c.send || '' }]);
      if (!sent || !sent.ok) return { ok: false, error: (sent && sent.error) || '发送失败' };
    } catch (e) {
      return { ok: false, error: '注入失败：' + errText(e) + '（内网页面可能需要允许扩展脚本）' };
    }

    /* 轮询：文字变了就记时间，安静满 idleMs 视为答完。 */
    const started = nowMs();
    let last = '';
    let lastChange = 0;
    let seen = false;
    while (nowMs() - started < ANSWER_TIMEOUT) {
      await sleep(POLL_MS);
      let cur = '';
      try {
        const r = await run(tabId, readPage, [{ answerSel: answerSel }]);
        if (r && r.ok) cur = String(r.text || '');
        else if (r && r.error) return { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: '读取回答时页面关了或跳走了（' + errText(e) + '）' };
      }
      const grown = base && cur.indexOf(base) === 0 ? cur.slice(base.length) : cur;
      if (grown !== last) { last = grown; lastChange = nowMs(); if (grown.trim()) seen = true; continue; }
      if (seen && lastChange && nowMs() - lastChange >= idleMs) break;
    }

    const answer = String(last || '').trim();
    if (!answer) return { ok: false, error: '等了 3 分钟没看到回答区出现新内容（选择器可能选错了，或这一步被页面拦了）' };
    return { ok: true, text: answer };
  };

  /* 设置页「测试」：打开页面、看三个选择器能不能命中。 */
  W.probe = async function (custom) {
    const c = custom || {};
    const url = okUrl(c.url);
    if (!url) return { ok: false, error: '请先填网址（要 http:// 或 https://）' };
    let tabId = 0;
    try { tabId = await ensureTab(url, c.keepTab !== false); }
    catch (e) { return { ok: false, error: errText(e) }; }
    try {
      const r = await run(tabId, probePage, [{ inputSel: c.input || '', sendSel: c.send || '', answerSel: c.answer || '' }]);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读不到页面' };
      return { ok: true, title: r.title, input: !!r.input, send: !!r.send, answer: !!r.answer };
    } catch (e) { return { ok: false, error: errText(e) }; }
  };

  /* ---------------- 「点选元素」：注入一层遮罩，点哪儿就把哪儿的 CSS 路径带回来 ----------------
   * 只在用户点「点选元素」时跑一次；不给页面留任何常驻监听。 */
  const pickWaiters = {};
  let pickSeq = 0;

  function pickerInPage(id) {
    try { if (window.__khPickerStop) window.__khPickerStop(); } catch (e) { /* ignore */ }
    const box = document.createElement('div');
    box.setAttribute('data-kh-picker', '1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2f6fb5;background:rgba(47,111,181,0.12);border-radius:3px;box-sizing:border-box;display:none;';
    const tip = document.createElement('div');
    tip.textContent = '点一下要选的元素（Esc 取消）';
    tip.style.cssText = 'position:fixed;z-index:2147483647;left:12px;top:12px;padding:6px 10px;background:#2f6fb5;color:#fff;font:12px/1.5 system-ui,sans-serif;border-radius:6px;pointer-events:none;';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);

    const pathOf = (el) => {
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(s + '#' + n.id); break; }
        const cls = [];
        for (let i = 0; i < n.classList.length && cls.length < 2; i++) {
          const c = n.classList[i];
          if (/^[A-Za-z][\w-]*$/.test(c)) cls.push(c);
        }
        if (cls.length) s += '.' + cls.join('.');
        const p = n.parentElement;
        if (p) {
          const sibs = [];
          for (let i = 0; i < p.children.length; i++) if (p.children[i].tagName === n.tagName) sibs.push(p.children[i]);
          if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
        }
        parts.unshift(s);
        n = p;
        if (n === document.body) break;
      }
      return parts.join(' > ');
    };

    let cur = null;
    const onMove = (e) => {
      const t = e.target;
      if (!t || t === box || t === tip) return;
      cur = t;
      const r = t.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };
    const stop = () => {
      document.removeEventListener('mouseover', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      try { box.remove(); tip.remove(); } catch (e) { /* ignore */ }
      window.__khPickerStop = null;
    };
    const send = (sel) => { try { chrome.runtime.sendMessage({ type: 'kh:ai:webPicked', id: id, sel: sel || '' }); } catch (e) { /* ignore */ } };
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = cur || e.target;
      const sel = t ? pathOf(t) : '';
      stop();
      send(sel);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); stop(); send(''); } };
    document.addEventListener('mouseover', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.__khPickerStop = stop;
    return true;
  }

  W.pick = function (opts) {
    const tabId = opts && opts.tabId;
    if (!tabId) return Promise.resolve({ ok: false, error: '没有可点选的标签页' });
    const id = 'p' + (++pickSeq);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); delete pickWaiters[id]; resolve(v); };
      const timer = setTimeout(() => finish({ ok: false, error: '30 秒内没有在页面上点选' }), 30000);
      pickWaiters[id] = finish;
      chrome.scripting.executeScript({ target: { tabId: tabId }, func: pickerInPage, args: [id] })
        .catch((e) => finish({ ok: false, error: '注入点选脚本失败：' + errText(e) }));
    });
  };

  /* 页面点完回执：把结果交给正在等的那个 promise。 */
  W.picked = function (msg) {
    const f = pickWaiters[msg && msg.id];
    if (typeof f !== 'function') return false;
    const sel = String((msg && msg.sel) || '');
    f(sel ? { ok: true, selector: sel } : { ok: false, error: '已取消' });
    return true;
  };

  self.KhWebAi = W;
})();