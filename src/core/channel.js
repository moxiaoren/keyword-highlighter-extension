/* ============================================================================
 * src/core/channel.js · 更新通道（稳定版 / 测试版）——**只存一个本机设置，不触网**
 * ----------------------------------------------------------------------------
 * 【2026-10-05 用户口径】插件入口取消"线上更新"：不再检查更新、不再弹更新提示条、不再下载更新包。
 * 只留下这一个开关 —— 告诉用户"我这台机器走稳定版还是测试版"。
 * 于是原先 `background/update-checker.js` 里的 UpdateChecker / UpdateChannel 整套东西都删了，
 * 只把**通道这一小块**留下来独立成文件：它与"拉远端清单"无关，只碰 chrome.storage.local 一个键。
 *
 * 【为什么 isBetaPackage 与 get 分开】显示口径必须等于**决策口径**：用户设置是"稳定版"、
 * 而手上这个包本身就是测试版包（manifest 里写了 beta）时，界面不许显示成「稳定版」，
 * 也不许让人把它切走（切了也回不到稳定通道）。旧版把这两件事混在一起，
 * 于是被强制成测试版的包在界面上写着「稳定版」（C7 O-1 附带项 / P-03）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const KEY = 'khUpdateChannel';

  /** 这个包本身是不是"独立测试版包"：manifest 里 version_name / update_url 带 beta */
  function isBetaPackage() {
    try {
      const mf = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest() : null;
      if (!mf) return false;
      return /beta/i.test(String(mf.version_name || '')) || /beta/i.test(String(mf.update_url || ''));
    } catch (e) { return false; }
  }

  const UpdateChannel = {
    KEY: KEY,
    isBetaPackage: isBetaPackage,

    /** 用户设置（缺省 / 脏值一律按稳定版） */
    get: function () {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(KEY, function (r) {
            const err = chrome.runtime.lastError;
            /* 读失败只影响本次显示（回落稳定版），如实记一笔即可，不打断渲染 */
            if (err) console.warn('[KH] 读取更新通道失败：', err.message || err);
            resolve((r && r[KEY]) === 'beta' ? 'beta' : 'stable');
          });
        } catch (e) { resolve('stable'); }
      });
    },

    /** 写失败**必须抛**（不许空 catch 吞掉）：调用方要能如实说"切换失败"。
     *  旧版在这里吞错 ⇒ 界面报「已切到测试版」而磁盘零写入，用户以为通道换了、
     *  实际还是老通道（C7 F-1 同族；write-honesty ③ 钉着这一条）。 */
    set: function (ch) {
      const v = ch === 'beta' ? 'beta' : 'stable';
      return new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.set({ [KEY]: v }, function () {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error('本地存储写入失败（通道未切换）：' + (err.message || err)));
            else resolve(v);
          });
        } catch (e) { reject(new Error('本地存储写入失败（通道未切换）')); }
      });
    },

    /** 实际生效通道：包本身是测试版 ⇒ beta（且不可切换）；否则按用户设置。
     *  ⚠️ 必须**经由 `UpdateChannel.isBetaPackage` 调用**（不是闭包直呼）：真机回归要能桩掉
     *  「这个包本身是 beta」，桩点只有落在对象属性上才生效 —— 直呼闭包会让桩看起来没作用，
     *  测出来的是假绿（C7 O-1 的 forced-beta 用例就栽在这上面）。 */
    effective: function () {
      if (UpdateChannel.isBetaPackage()) return Promise.resolve('beta');
      return UpdateChannel.get();
    }
  };

  KH.UpdateChannel = UpdateChannel;

  if (typeof module !== 'undefined' && module.exports) module.exports = { UpdateChannel: UpdateChannel, KH_UPDATE_CHANNEL_KEY: KEY };
})();
