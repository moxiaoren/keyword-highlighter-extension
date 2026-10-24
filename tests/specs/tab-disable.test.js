/* tests/specs/tab-disable.test.js — 【2.0.7.2 需求⑤】标签页级临时禁用
 * ----------------------------------------------------------------------------
 * 用户口径（原文）：「禁用本站，改成禁用本标签页 —— 只针对这个标签页，不管打开什么网址都不走高亮，
 * 关闭这个标签页就自动取消禁用。其他标签页不受影响。」
 *
 * 这份 spec 钉的是那句话里的四个从句，逐条对应一组断言：
 *   ① 键是 **tabId**（不是 hostname）⇒ 同一个站点的别的标签页不受影响；
 *   ② 判定是"本页被禁用就一票否决" ⇒ 该标签页里打开任何网址都不高亮（跨域跳转同样）；
 *   ③ 存在 `chrome.storage.session`（不是 local）⇒ 浏览器重启/重装扩展后零残留；
 *   ④ 关标签页 = `tabs.onRemoved` 里立刻删键（tabId 会被浏览器复用，残留会让新标签页一开就灰）；
 * 外加一条链路契约：后台改完必须**只推给那个标签页**，内容脚本收到就当场重评 ——
 * 用户点完按钮不该等刷新（Lead 的硬要求）。
 *
 * 为什么能在 Node 里跑：`background/tab-disabled.js` 只依赖 `chrome.storage.session` 的
 * get/set/remove 三个方法，注入一个内存版就够；`src/features/site-rules.js` 的判据是纯函数。
 * 两个模块都在**独立的 KH 命名空间**里加载（`self` / `window` 各传一个假对象），
 * 不污染 bootstrap 里那个共享内核（别的 spec 会替换 `KH.SiteRules`，这里不吃那份状态）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 去注释后再断言：契约只看**代码**（注释里解释"为什么不再写 siteDisabledMap"不算又写了一次） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 内存版 chrome.storage.session（真机形状：get/set/remove 都回 Promise） */
function fakeSession() {
  const mem = {};
  return {
    _mem: mem,
    async get(key) {
      const out = {};
      if (typeof key === 'string') { if (key in mem) out[key] = mem[key]; }
      else if (Array.isArray(key)) for (const k of key) { if (k in mem) out[k] = mem[k]; }
      else Object.assign(out, mem);
      return out;
    },
    async set(obj) { Object.assign(mem, obj); },
    async remove(key) { for (const k of [].concat(key)) delete mem[k]; }
  };
}

/** 加载 background/tab-disabled.js。`self` 传假对象 ⇒ 挂到独立的 KH 上，不碰共享内核 */
function freshTabDisabled(session) {
  const fakeSelf = { KH: {} };
  const code = readSrc('background/tab-disabled.js');
  // eslint-disable-next-line no-new-func
  new Function('chrome', 'self', code)({ storage: { session } }, fakeSelf);
  return fakeSelf.KH.TabDisabled;
}

/** 加载 src/features/site-rules.js 的**独立实例**（`window` 也给假对象，同上） */
function freshSiteRules() {
  const fakeWindow = { KH: {} };
  const code = readSrc('src/features/site-rules.js');
  // eslint-disable-next-line no-new-func
  new Function('window', code)(fakeWindow);
  return fakeWindow.KH.SiteRules;
}

module.exports = async function run() {
  suite('2.0.7.2 需求⑤ · 标签页级临时禁用（存取）');

  await test('★ 全新 session 区 = 零禁用（浏览器重启 / 重装扩展不残留）', async () => {
    const session = fakeSession();
    const T = freshTabDisabled(session);
    eq(await T.isDisabled(7), false, '空 session 区必须是"不禁用"');

    /* 禁用 → 模拟浏览器退出（session 区被清空）→ 重新问一次 */
    await T.setDisabled(7, true);
    eq(await T.isDisabled(7), true, '前置：刚禁用的应当是真值');
    for (const k of Object.keys(session._mem)) delete session._mem[k];
    eq(await T.isDisabled(7), false, '★ session 区清空后必须回到"不禁用"（存 local 就做不到）');
  });

  await test('★ 只作用于那一个 tabId（同站点别的标签页不受影响）', async () => {
    const T = freshTabDisabled(fakeSession());
    await T.setDisabled(42, true);
    eq(await T.isDisabled(42), true, '被点的那个标签页应禁用');
    eq(await T.isDisabled(43), false, '★ 同站点的另一个标签页不许跟着被禁（所以键必须是 tabId，不是 hostname）');
  });

  await test('★ 关标签页立刻删键（tabId 会被复用，残留会让新标签页一开就灰）', async () => {
    const session = fakeSession();
    const T = freshTabDisabled(session);
    await T.setDisabled(42, true);
    eq(await T.clearTab(42), true, 'clearTab 应回报"确实删了"');
    eq(await T.isDisabled(42), false, '关掉后该 tabId 不应再是禁用态');
    eq(Object.keys(session._mem).length, 0, '清空之后不该留下空表（留 `{}` 会让排查把"没禁用"看成"有记录"）');
    eq(await T.clearTab(42), false, '再删一次应回报"没东西可删"（幂等）');
  });

  await test('★ 省略 disabled = 翻转（快捷键那一路的语义）', async () => {
    const T = freshTabDisabled(fakeSession());
    eq(await T.setDisabled(5), true, '第一次：未禁用 → 禁用');
    eq(await T.setDisabled(5), false, '第二次：禁用 → 恢复');
    eq(await T.isDisabled(5), false, '翻转回来之后必须真的没记录');
  });

  suite('2.0.7.2 需求⑤ · 门禁（任何网址都不高亮 / 恢复后照旧 / 存量仍生效）');

  await test('★ 本页被禁用 ⇒ 任何网址都不高亮；恢复后照旧；历史 siteDisabledMap 仍生效', async () => {
    const S = freshSiteRules();
    const cfg = { siteRules: [] };

    eq(S.shouldHighlight('a.test', 'https://a.test/x', cfg), true, '前置：默认应高亮');

    S.markTabDisabled(true);
    eq(S.shouldHighlight('a.test', 'https://a.test/x', cfg), false, '★ 本标签页被禁用后不该高亮');
    eq(S.shouldHighlight('other.test', 'https://other.test/y', cfg), false,
      '★ 同一个标签页跳到别的网址（跨域）也不许高亮 —— 这正是"不能按 hostname 记"的原因');

    S.markTabDisabled(false);
    eq(S.shouldHighlight('a.test', 'https://a.test/x', cfg), true, '恢复后应重新高亮（否则"关掉标签页才恢复"就成了唯一出路）');

    /* 存量：老版本「禁用本站」留下的 siteDisabledMap 继续生效（升级不悄悄改变老用户的高亮行为） */
    const legacy = { siteRules: [], siteDisabledMap: { 'a.test': true } };
    eq(S.shouldHighlight('a.test', 'https://a.test/x', legacy), false, '★ 历史站点级禁用必须继续生效');
    eq(S.shouldHighlight('b.test', 'https://b.test/x', legacy), true, '历史禁用只对名单里的站点生效');
    /* 新实例默认是未禁用（标记只活在本页内存里，不会串到别的页面实例） */
    eq(freshSiteRules().isTabDisabled(), false, '新页面实例默认不是禁用态');
  });

  suite('2.0.7.2 需求⑤ · 链路契约（点完立刻生效 / 关标签页即取消）');

  await test('★ 后台：改完只推给那一个标签页；关标签页清键；不再写 siteDisabledMap', () => {
    const sw = readSrc('background/service-worker.js');
    truthy(/notifyTabDisabled\s*\(tabId,\s*next\)/.test(sw),
      '★ 设完状态必须推 `TAB_DISABLED_CHANGED` 给那个标签页（否则点完不刷新就不生效）');
    truthy(/function notifyTabDisabled\(tabId, disabled\)/.test(sw), '推送实现应在（只发给一个 tabId）');
    const onRemoved = sw.slice(sw.indexOf('chrome.tabs.onRemoved.addListener'));
    truthy(/TabDisabled\.clearTab\(tabId\)/.test(onRemoved.slice(0, 600)),
      '★ `tabs.onRemoved` 必须清掉该 tabId 的禁用记录（"关掉标签页自动取消"的硬保证）');
    falsy(/siteDisabledMap\s*:\s*map/.test(sw), '后台不得再整表写 siteDisabledMap（老路径只读不写）');
    truthy(/importScripts\([^)]*tab-disabled\.js/.test(sw), '标签页禁用模块要 importScripts 进来');
  });

  await test('★ 内容脚本：启动先问后台、收到推送当场重评；不再自己写 siteDisabledMap', () => {
    const c = readSrc('content/content.js');
    const cCode = code(c);
    truthy(/TAB_DISABLED_QUERY/.test(cCode), '★ 启动阶段要问后台"我这个标签页是否被禁用"');
    truthy(/bootWithTabState\(\)/.test(cCode), '启动必须走 bootWithTabState（先对齐禁用态再 boot，顺序不能反）');
    const hot = cCode.slice(cCode.indexOf('case MSG.TAB_DISABLED_CHANGED'));
    truthy(/markTabDisabled\(!!msg\.disabled\)/.test(hot), '★ 收到推送必须立刻更新标记');
    truthy(/KH\.boot\(\)/.test(hot.slice(0, 700)), '★ 收到推送必须当场重评上下线（不许等刷新）');
    falsy(/siteDisabledMap/.test(cCode),
      '★ 内容脚本不得再读写 siteDisabledMap（那正是审计 F-30 说的"三份内联写者"之一）');
    truthy(/tabDisabled:/.test(cCode), 'STATE_QUERY 要回 tabDisabled（弹窗据此把按钮显示成"恢复"）');
  });

  await test('★ 弹窗：按钮走后台的标签页通道，卡片不再由 siteDisabledMap 决定', () => {
    const p = code(readSrc('popup/popup.js'));
    truthy(/MSG\.TAB_DISABLED_SET/.test(p), '★ popup 的按钮必须发 TAB_DISABLED_SET（判定与落盘都在后台）');
    truthy(/tabDisabled/.test(p), '弹窗要读内容脚本回报的 tabDisabled');
    falsy(/write\(\{\s*siteDisabledMap/.test(p), '★ popup 不得再写 siteDisabledMap');
    const html = readSrc('popup/popup.html');
    truthy(/id="btn-site-text">禁用本标签页/.test(html), '按钮文案应是「禁用本标签页」');
    falsy(/id="btn-site-text">禁用本站/.test(html), '「禁用本站」的按钮文案应已退场');
  });
};
