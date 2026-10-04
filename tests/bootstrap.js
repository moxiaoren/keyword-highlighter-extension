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
      lastError: null
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

module.exports = { KH, mem: global.__MEM__, H };
