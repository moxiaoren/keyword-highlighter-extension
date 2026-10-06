/* tests/bootstrap.js — 全局只做一次的准备工作
 *
 * 为什么单独拆出来：
 *   content_scripts 里的模块是 IIFE，靠 `window.KH = window.KH || {}` 累积注册。
 *   如果每个 spec 各自 loadKernel 一次，第二次执行会因为默认参数求值顺序把已注册的
 *   扩展点重置掉（注册表被重新赋值成空 Map）→ 后面的 spec 静默拿到半残内核。
 *   所以：**DOM 垫片 + chrome 垫片 + 内核加载只做一次**，所有 spec 共用同一份实例。
 */
'use strict';
const H = require('./harness');

/** 内存版 chrome.storage.local（spec 可直接读写 global.__MEM__ 造/查数据） */
function installChrome() {
  const mem = {};
  const sent = [];        // 内容脚本发出的 OCR 请求（驱动"结果回来"用）
  const listeners = [];   // chrome.runtime.onMessage 的监听器（单进程里就是内容脚本自己）
  global.__OCR_SENT__ = sent;
  global.__OCR_LISTENERS__ = listeners;
  const local = {
    get(keys, cb) {
      const out = {};
      if (keys == null) Object.assign(out, mem);
      else if (typeof keys === 'string') { if (keys in mem) out[keys] = mem[keys]; }
      else if (Array.isArray(keys)) { for (const k of keys) if (k in mem) out[k] = mem[k]; }
      else { for (const k of Object.keys(keys)) out[k] = (k in mem) ? mem[k] : keys[k]; }
      if (typeof cb === 'function') { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set(obj, cb) { Object.assign(mem, obj); if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete mem[k]; if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); },
    clear(cb) { for (const k of Object.keys(mem)) delete mem[k]; if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); }
  };
  const chrome = {
    storage: { local, onChanged: { addListener() {} } },
    runtime: {
      getManifest: () => ({ version: '2.0.0' }),
      id: 'test-extension',
      getURL: (p) => 'chrome-extension://test/' + p,
      lastError: null,
      /* 【单测要能把"结果回来"这条路驱动起来】真机上内容脚本是被 `chrome.runtime.onMessage`
       * 唤醒的；装置里不给同样的形状，"结果回来 ⇒ 归还额度 ⇒ 补发队列"这条链在单测里根本跑不到
       * —— 而这条链正是「一页多图卡在排队中」那个缺陷所在（见 img-ocr.test.js 末尾那条用例）。
       * `sendMessage` 照真机形状**同步回调 `{requestId}`**（真机 background 也会立刻回执），
       * 否则 `awaitingId` 会一直涨、额度提前用光，测出来的并发上限就不是 4 了。 */
      sendMessage(msg, cb) {
        sent.push(msg);
        const requestId = 'r' + sent.length;
        if (typeof cb === 'function') cb({ requestId: requestId });
        return requestId;
      },
      onMessage: { addListener: (fn) => listeners.push(fn) }
    }
  };
  Object.defineProperty(global, 'chrome', { value: chrome, writable: true, configurable: true });
  global.__MEM__ = mem;
  return mem;
}

H.installDOM();
installChrome();
const KH = H.loadKernel();
// 管理端信封（options / popup 专用，**不在 content_scripts 清单里**）——
// 单测需要它来验证字段单源 / CSV / 导入导出契约，所以显式补加载一次。
H.loadKernel(['src/platform/storage.js']);

/**
 * 把"还没投递结果的 OCR 请求"逐个投递，驱动「结果回来 ⇒ 归还额度 ⇒ 补发队列」到收敛。
 * `from` = 只投递这个下标之后的请求（前面的用例可能也发过请求，别替它们投递）。
 * 返回投递条数。`reply(msg, i)` 可定制回执（例如造失败）。
 */
function driveOcrResults(reply, from) {
  const sent = global.__OCR_SENT__ || [];
  const listeners = global.__OCR_LISTENERS__ || [];
  const start = Number(from) || 0;
  let delivered = 0;
  for (let i = start; i < sent.length && delivered < 2000; i++) {
    if (sent[i].__delivered) continue;
    sent[i].__delivered = true;
    delivered += 1;
    const base = {
      type: 'kh:ocr:result', to: 'content', requestId: 'r' + (i + 1),
      ok: true, text: '华为', confidence: 96, src: sent[i].src || ''
    };
    const msg = Object.assign(base, (typeof reply === 'function' ? reply(sent[i], i) : null) || {});
    for (const fn of listeners) fn(msg);
  }
  return delivered;
}

module.exports = { KH, mem: global.__MEM__, H, driveOcrResults };
