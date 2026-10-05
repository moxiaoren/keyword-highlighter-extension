/* scripts/lib/version.js — 版本号比较的**单一实现**（发版脚本共用）
 * ----------------------------------------------------------------------------
 * 【为什么它单独存在】
 *   这段比较逻辑原本寄生在 `background/update-checker.js` —— 那是扩展运行时的"检查线上更新"
 *   模块。2026-10-05 用户裁决：插件入口不再有"线上更新"（只留下稳定/测试版的通道切换），
 *   那个模块整个删掉；而发版脚本（release.js 的版本回退守卫、bump-version.js 的"不许降版"）
 *   恰恰只借用了它一个函数。
 *   所以把它搬到 scripts/lib/ 独立成文件 —— 别让"删掉运行时模块"顺手把发版守卫的判据也删了。
 *
 * 【口径（别改）】浏览器自身的比较规则是**逐段数值比较**，且预发布后缀小于同号正式版：
 *   · 2.0.2.0 == 2.0.2      → 第四位写 0 不算"更高"（晋级时版本号必须真的变大）
 *   · 2.1.0.1 >  2.1.0      → 测试版号（四段）高于同前缀的三段号
 *   · 2.2.0-beta.1 < 2.2.0  → 预发布后缀让同号版本变"更旧"
 *   实测踩点：稳定版与测试版的版本不变量（见 check-channels.js）就建立在这些等式上。
 * ========================================================================= */
'use strict';

/** 拆成 [核心段, 预发布后缀]：v2.1.0-beta.1 → 核心段 2.1.0、后缀 beta.1 */
function splitVer(v) {
  const s = String(v == null ? '' : v).replace(/^v/i, '').trim();
  const i = s.indexOf('-');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** 比较两个版本号：a > b → 1；a < b → -1；相等 → 0 */
function compareVersions(a, b) {
  const [ca, pa] = splitVer(a);
  const [cb, pb] = splitVer(b);
  const na = ca.split('.');
  const nb = cb.split('.');
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(na[i] || '0', 10) || 0;
    const y = parseInt(nb[i] || '0', 10) || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (pa === pb) return 0;
  if (!pa) return 1;   // 有后缀 < 无后缀（2.2.0-beta.1 < 2.2.0）
  if (!pb) return -1;
  return pa > pb ? 1 : -1;
}

module.exports = { splitVer, compareVersions };
