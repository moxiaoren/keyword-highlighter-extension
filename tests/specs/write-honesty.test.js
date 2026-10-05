/* tests/specs/write-honesty.test.js — C7 F-1 回归：**存储写失败必须让用户看见**
 * ----------------------------------------------------------------------------
 * 缺陷原状（三处同族，都是"把失败当成功"）：
 *   ① `src/platform/storage.js` 的 `Store.patch()`：`new Promise((resolve) => s.set(safe, resolve))`
 *      —— chrome 写失败时**不抛错**，只把错误放进 `chrome.runtime.lastError`（回调照常被调用），
 *      无条件 resolve ⇒ 调用方以为写成功了；
 *   ② `popup/popup.js` 的 `write()`：同样无条件 `resolve(true)`；全局开关只判 `if (!res)`
 *      ⇒ background 折出来的 `{ok:false}` 被当成成功，照报「已暂停全局高亮」；
 *      站点卡先翻卡片再写、不看返回值 ⇒ 写失败时卡片显示「已禁用」而页面照常高亮；
 *   ③ `background/update-checker.js` 的 `UpdateChannel.set()` 空 catch 吞错 + `options.js` 的
 *      `mutate()` 让异常逃逸成 unhandled rejection（用户零提示，界面按"成功"重渲染）。
 *
 * 为什么是**源码级契约**：这三处都是 IIFE + 完整 popup/options DOM（`chrome.tabs.query`、
 *   `KH.ui.dom` 全套），垫片跑不起来；行为级证据由真机探针
 *   `_stage/wayfinder-kh-ui/probe-f1-postfix.js`（注入配额失败）提供。
 *   本文件钉的是"代码里必须存在的那几条诚实性"，**旧代码逐条都过不了**。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 取 `needle` 之后 `len` 个字符（源码片段断言用） */
const after = (src, needle, len) => {
  const i = src.indexOf(needle);
  return i < 0 ? '' : src.slice(i, i + (len || 400));
};
/** 取两个锚点之间的源码（含头不含尾） */
const between = (src, a, b) => {
  const i = src.indexOf(a);
  if (i < 0) return '';
  const j = src.indexOf(b, i + a.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
};
/** 去注释后再断言：契约只看**代码**，不能因为自己的说明里写了「旧写法如何如何」而误判 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

module.exports = async function run() {
  const { KH, mem } = require('../bootstrap');
  const S = KH.Store;

  suite('write-honesty · 平台写入口（行为级）');

  await test('★ Store.patch 写失败必须 reject（不许把失败当成功）', async () => {
    const saved = JSON.parse(JSON.stringify(mem));
    const local = chrome.storage.local;
    const realSet = local.set;
    try {
      /* 造一次"配额顶满"：chrome 的真实行为是 —— 不抛错，回调照常调用 + lastError 有值 */
      local.set = function (obj, cb) {
        chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
        if (typeof cb === 'function') { cb(); return undefined; }
        return Promise.resolve();
      };
      let threw = null;
      try { await S.patch({ globalEnabled: false }); } catch (err) { threw = err; }
      truthy(threw, '★ 写失败必须抛错（旧写法无条件 resolve ⇒ 调用方以为成功）');
      truthy(/写入失败/.test(String(threw && threw.message)), '错误信息应说清是本地存储写入失败：' + (threw && threw.message));
    } finally {
      local.set = realSet;
      chrome.runtime.lastError = null;
      for (const k of Object.keys(mem)) delete mem[k];
      Object.assign(mem, saved);
    }
  });

  await test('★ 写成功时 patch 照常 resolve（没把正常路径一起改坏）', async () => {
    const saved = JSON.parse(JSON.stringify(mem));
    try {
      await S.patch({ globalEnabled: false });
      eq(mem.globalEnabled, false, '正常写必须真的落盘');
    } finally {
      for (const k of Object.keys(mem)) delete mem[k];
      Object.assign(mem, saved);
    }
  });

  suite('write-honesty · popup / options / update-checker（源码契约）');

  await test('★ popup.write() 读 lastError 并如实回报（不再无条件 resolve(true)）', () => {
    const src = readSrc('popup/popup.js');
    const body = code(between(src, 'function write(obj) {', '\n  async function activeTab'));
    truthy(body, '应能找到 write() 函数体');
    truthy(/chrome\.runtime\.lastError/.test(body), '★ write() 必须读 chrome.runtime.lastError');
    truthy(/resolve\(!err\)/.test(body), '★ 返回值必须取决于 lastError');
    falsy(/resolve\(true\)/.test(body), '★ 不许再无条件下 resolve(true)');
  });

  await test('★ popup：全局开关认得 background 的 {ok:false}（旧写法只判 !res）', () => {
    const src = readSrc('popup/popup.js');
    const body = code(between(src, "$('chk-global').addEventListener", "$('btn-site').addEventListener"));
    truthy(/res && res\.ok === false/.test(body), '★ 必须显式判 {ok:false}');
    truthy(/renderGlobalState\(!value\)/.test(body), '失败要把乐观渲染回滚');
    truthy(/保存失败/.test(body), '失败要给出用户可见提示');
    truthy(/const ok = await write\(/.test(body), 'background 不可达时仍走直接落盘兜底，但要看返回值');
  });

  await test('★ popup：站点卡「先落盘、成了再翻卡片」', () => {
    const src = readSrc('popup/popup.js');
    const body = code(between(src, "$('btn-site').addEventListener", '快速添加'));
    const w = body.indexOf('await write({ siteDisabledMap: map })');
    const flip = body.indexOf('setSiteDisabledView(next, true)');
    truthy(w >= 0, '应能看到写盘调用');
    truthy(flip >= 0, '应能看到卡片翻转调用');
    truthy(w < flip, '★ 写盘必须在翻卡片**之前**（旧代码顺序相反且不看返回值）');
    truthy(/if \(!okWrite\)/.test(body), '★ 写失败必须提前 return，不翻卡片、不报成功');
    truthy(/保存失败/.test(body), '失败要有用户可见提示');
  });

  await test('★ 通道切换：写失败不许报「已切到…」', () => {
    const checker = readSrc('background/update-checker.js');
    const setBody = code(between(checker, 'async set(ch) {', '\n  }\n};'));
    truthy(setBody, '应能找到 UpdateChannel.set 函数体');
    falsy(/catch/.test(setBody), '★ set() 不许再空 catch 吞错（要让调用方拿到 rejection）');
    truthy(/await chrome\.storage\.local\.set/.test(setBody), '仍要真的写盘');

    const popup = readSrc('popup/popup.js');
    const chBody = code(between(popup, "$('btn-channel').addEventListener", '$(\'btn-update-dismiss\')'));
    truthy(/catch \(err\)/.test(chBody), '★ popup 必须接住 set 抛出的失败');
    truthy(/切换失败/.test(chBody), '失败要有用户可见提示');
    truthy(/return;/.test(chBody), '失败要提前返回，不许继续报成功、不许触发检查更新');
  });

  await test('★ options.mutate() 写失败要 toast（旧写法让异常逃逸成 unhandled rejection）', () => {
    const src = readSrc('options/options.js');
    const body = code(between(src, 'async function mutate(fn) {', 'async function reload()'));
    truthy(body, '应能找到 mutate() 函数体');
    truthy(/catch \(err\)/.test(body), '★ 必须接住写失败');
    truthy(/D\.toast\('保存失败：'/.test(body), '★ 失败必须给用户可见提示');
    truthy(/cfg = await KH\.Store\.load\(\)/.test(body), '失败后要把磁盘真值读回来对账（不假装成功）');
  });

  /* ---------------- C7 F-2：站点卡判据 = 内容脚本真值 ---------------- */

  await test('★ 站点卡：判据取自内容脚本真值，不再只读 siteDisabledMap', () => {
    const src = readSrc('popup/popup.js');
    const body = code(between(src, 'async function renderSite(', '/* ---------------- 更新通道'));
    truthy(body, '应能找到 renderSite 函数体');
    truthy(/eff === null/.test(body), '内容脚本不可达要有降级分支');
    truthy(/当前页面不支持站点设置/.test(body), '降级文案');
    truthy(/globalEnabled === false/.test(body), '★ 全局暂停要单独归因（badge 说实话：已暂停）');
    truthy(/setSiteBlockedView\(true, '已禁用'/.test(body), '★ 网址规则挡掉的页面不得再显示「生效中」');
    truthy(/网址规则/.test(body), '要告诉用户去哪改（设置页规则）');
  });

  await test('★ 站点卡：render() 把内容脚本真值喂进 renderSite（STATE_QUERY，不靠 background）', () => {
    const src = readSrc('popup/popup.js');
    const helper = code(between(src, 'async function contentSiteEnabled(tab) {', 'async function askBackground'));
    truthy(helper, '应能找到 contentSiteEnabled');
    truthy(/chrome\.tabs\.sendMessage\(tab\.id, \{ type: MSG\.STATE_QUERY \}\)/.test(helper), '★ 必须问内容脚本要 siteEnabled');
    falsy(/siteDisabledMap/.test(helper), 'helper 不该再摸 siteDisabledMap（判据与按钮文案分离）');

    const renderBody = code(between(src, 'async function render() {', '/* ---------------- 事件绑定'));
    truthy(/const eff = await contentSiteEnabled\(tab\)/.test(renderBody), 'render() 必须取真值');
    truthy(/await renderSite\(eff, globalOn\)/.test(renderBody), '★ 真值必须传进 renderSite（旧写法是无参 renderSite()）');
  });

  /* ---------------- C7 F-3：手动检查更新必须 force ---------------- */

  await test('★ 手动「检查更新」带 force（旧写法只读 6h 缓存）', () => {
    const src = code(readSrc('popup/popup.js'));
    truthy(/askBackground\(\{ type: MSG\.UPDATE_CHECK, force: !!interactive \}\)/.test(src),
      '★ popup 必须把 interactive 翻成 force 发给后台');
  });

  await test('★ background 转发 force：UPDATE_CHECK handler 不得再丢 payload', () => {
    const sw = code(readSrc('background/service-worker.js'));
    truthy(/async function checkForUpdates\(force\)/.test(sw), 'checkForUpdates 要接受 force');
    truthy(/self\.UpdateChecker\.check\(currentVersion\(\), \{ force: !!force \}\)/.test(sw), '★ force 必须透传进 UpdateChecker.check');
    truthy(/\[MSG\.UPDATE_CHECK\]: async \(msg\) => \(\{ ok: true, info: await checkForUpdates\(!!\(msg && msg\.force\)\) \}\)/.test(sw),
      '★ handler 必须转发 msg.force（旧写法 `async () =>` 直接丢掉）');
    truthy(/await checkForUpdates\(\);/.test(sw), 'onInstalled 那条保持不带 force');
    truthy(/checkForUpdates\(\);\s*\n\s*\}\);\s*\n\s*\}\);/.test(sw) || /alarm\.name === 'checkUpdate'\) checkForUpdates\(\);/.test(sw),
      '周期性 alarm 那条保持不带 force（仍吃缓存，不给更新源添压力）');
  });

  /* ---------------- C7 F-12：卡面快捷键必须来自真值 ---------------- */

  await test('★ manifest：open-settings 不得再用被浏览器占用的 Ctrl+Shift+O', () => {
    const mf = JSON.parse(readSrc('manifest.json'));
    const cmds = mf.commands || {};
    truthy(cmds['toggle-highlight'] && cmds['toggle-site'] && cmds['open-settings'], '三条命令都要在');
    for (const name of Object.keys(cmds)) {
      truthy(cmds[name].suggested_key && cmds[name].suggested_key.default, name + ' 要有 default 建议键');
      truthy(cmds[name].suggested_key.mac, name + ' 要有 mac 建议键');
    }
    /* 真机读数：Ctrl+Shift+O 由 Chrome 的「书签管理器」占用，suggested_key 会被**静默丢弃**
     * （`chrome.commands.getAll()` 回 shortcut:""）⇒ 用户按了没反应。这条不许改回去。 */
    eq(cmds['open-settings'].suggested_key.default === 'Ctrl+Shift+O', false, '★ 不许退回被占用的 Ctrl+Shift+O');
  });

  await test('★ 卡面两条路径都按 chrome.commands.getAll() 真值渲染，不再写死', () => {
    const wjs = code(readSrc('welcome/welcome.js'));
    const wBody = between(wjs, 'async function renderShortcuts()', 'boot(renderStatus,');
    truthy(wBody, '应能找到 welcome 的 renderShortcuts');
    truthy(/await chrome\.commands\.getAll\(\)/.test(wBody), '★ 必须读真值');
    truthy(/未分配/.test(wBody), '★ 真值里没有按键时要如实写「未分配」（不许抄 manifest 的愿望）');
    truthy(/is-unset/.test(wBody), '未分配要有专门的样式钩子');
    truthy(/boot\(renderShortcuts, '快捷键卡'\)/.test(wjs),
      '初始化时必须调用（走 boot 兜底：单个渲染失败不许把整页剩下的渲染一起带走）');
    falsy(/querySelectorAll\('\.kh-key kbd'\)[\s\S]{0,120}textContent === 'Ctrl'/.test(wjs),
      '旧的「把所有 Ctrl 换成 ⌘」写死替换必须退休（改由真值 + MAC_LABEL 映射）');

    const ojs = code(readSrc('options/options.js'));
    const oBody = between(ojs, 'async function renderShortcuts()', 'reload().then(');
    truthy(oBody, '应能找到 options 的 renderShortcuts');
    truthy(/await chrome\.commands\.getAll\(\)/.test(oBody), '★ 必须读真值');
    truthy(/未分配/.test(oBody), '★ 未分配要如实显示');
    truthy(/renderShortcuts\(\)/.test(between(ojs, 'reload().then(', '})();')), '初始化时必须调用');
  });

  await test('★ 静态兜底与说明文案：不再教人按 Ctrl+Shift+O，也不再声称「在任何网页上生效」', () => {
    const wh = readSrc('welcome/welcome.html');
    const oh = readSrc('options/options.html');
    for (const [name, html] of [['welcome.html', wh], ['options.html', oh]]) {
      falsy(/Ctrl\+Shift\+O/.test(html), name + ' 不许再写死 Ctrl+Shift+O');
      for (const cmd of ['toggle-highlight', 'toggle-site', 'open-settings']) {
        truthy(html.indexOf('data-kh-cmd="' + cmd + '"') >= 0, name + ' 要有 ' + cmd + ' 的真值占位');
      }
    }
    falsy(/在任何网页上生效/.test(wh), '★ toggle-site 走内容脚本，浏览器内置页/扩展商店/PDF 上无效，不许这么写');
    truthy(/在普通网页上生效/.test(wh), '要改写成实话');
    truthy(/未分配/.test(oh) && /未分配/.test(wh), '两页都要解释「未分配」是什么');
  });

  /* ---------------- C7 F-13：「展开全部」必须按真被折叠的条数给 ---------------- */

  await test('★ 更新日志的「展开全部」按屏幕真值判，不再按所有版本的总条数', () => {
    const wjs = code(readSrc('welcome/welcome.js'));
    const body = between(wjs, 'async function renderLog()', 'await chrome.storage.local.set({ khLastSeenVersion');
    truthy(body, '应能找到 renderLog 主体');
    /* 判据：问浏览器「被 CSS 藏起来的 li 有几条」——折叠规则在 welcome.css，不在这里复制常数 */
    truthy(/getComputedStyle\(li\)\.display === 'none'/.test(body), '★ 必须按计算样式数真被藏起来的条目');
    truthy(/btn\.hidden = true/.test(body), '先复位按钮，避免二次渲染残留');
    truthy(/hiddenCount > 0/.test(body), '一条都没藏起来就不给按钮（死按钮的根因）');
    falsy(/total > 3/.test(body), '★ 旧的「总条数 > 3」判据必须退休');
    falsy(/const total = entries\.reduce/.test(body), '★ 总条数这个量与「展开」无关，不许再参与判据与文案');
    truthy(/'展开全部（' \+ hiddenCount \+ ' 条）'/.test(body), '按钮数字必须是「要展开的条数」');
    truthy(/open \? '收起' : '展开全部（' \+ hiddenCount \+ ' 条）'/.test(body), '收起后文案要还原同一个数字');
  });

  await test('★ 折叠规则（CSS 每块露前 3 条）与判据同源，DOM 结构不许变', () => {
    const css = readSrc('welcome/welcome.css');
    truthy(/\.kh-clip:not\(\.is-open\) \.kh-rel-items li:nth-child\(n \+ 4\)\s*\{\s*display:\s*none;\s*\}/.test(css),
      '★ welcome.css 的折叠规则变了的话，按计算样式数的判据也跟着变，这条钉住两者同源');
    const wjs = code(readSrc('welcome/welcome.js'));
    truthy(/wrap\.className = 'kh-clip'/.test(wjs), '每块要挂 .kh-clip（CSS 折叠的锚点）');
    truthy(/ul\.className = 'kh-rel-items'/.test(wjs), '条目列表要挂 .kh-rel-items');
    truthy(/const li = document\.createElement\('li'\);/.test(wjs) && /ul\.appendChild\(li\);/.test(wjs),
      '条目要真的建成 li（否则计算样式数不到）—— C7 F-6 把建成方式从 innerHTML 换成了节点渲染');
  });

  /* ---------------- C7 F-14：第二级失败（独立窗口）不许零反馈 ---------------- */

  await test('★ 独立编辑窗口开不出来时必须明说（不再零 toast、零日志地停在原地）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    const body = between(wjs, 'async function openQuickAdd(', 'KH.popupOpenQuickAdd');
    truthy(body, '应能找到 openQuickAdd 主体');
    /* ① windows.create 之后必须紧跟 catch + 明说文案（旧写法后面是 window.close()，直接不成立） */
    truthy(/await chrome\.windows\.create\([\s\S]{0,300}?\}\s*catch \(err\)[\s\S]{0,200}?无法打开编辑窗口/.test(body),
      '★ windows.create 必须在 try 内、失败要 toast「无法打开编辑窗口…」');
    truthy(/无法打开编辑窗口，请重试或到设置页添加/.test(body), '★ 文案要给出下一步（重试 / 到设置页添加）');
    truthy(/return 'failed'/.test(body), '★ 失败要如实返回，不能假装开成了（旧写法紧接着 window.close()）');
    /* ② 调用处兜底：意外异常也不许变成 unhandled rejection */
    const caller = between(wjs, "$('btn-add').addEventListener", 'KH.popupOpenQuickAdd');
    truthy(/openQuickAdd\(null\)\.catch\(/.test(caller), '★ 调用处必须接住 rejection（旧写法只有 openQuickAdd(null);）');
  });

  /* ---------------- C7 F-4：IPC 必须有超时（否则弹窗永久半渲染） ---------------- */

  await test('★ 三类 IPC 都要有超时原语，且「超时」与「不可用」必须区分', () => {
    const wjs = code(readSrc('popup/popup.js'));
    truthy(/function withTimeout\(/.test(wjs), '★ 旧代码里根本没有超时原语：内容脚本/后台卡住就永远 await');
    const nudge = between(wjs, 'async function nudgeContent(', 'async function contentSiteEnabled(');
    truthy(/withTimeout\(/.test(nudge), '★ nudgeContent 必须带超时');
    const site = between(wjs, 'async function contentSiteEnabled(', 'async function askBackground(');
    truthy(/withTimeout\(/.test(site), '★ contentSiteEnabled 也在 render() 的串行链上（F-2 之后新增的第三次 IPC）');
    const ask = between(wjs, 'async function askBackground(', 'function toast(');
    truthy(/withTimeout\(/.test(ask), '★ askBackground 必须带超时');
    truthy(/\{ timedOut: true \}/.test(ask), '★ 超时要回 `{timedOut:true}`：与"不可用"的 null 混为一谈就分不清该说什么');
  });

  await test('★ 更新检查的超时只有一处来源（不再两个同长计时器抢先后）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    const body = between(wjs, 'async function checkUpdate(', 'async function render(');
    truthy(body, '应能找到 checkUpdate 主体');
    truthy(/const res = await askBackground\(\{ type: MSG\.UPDATE_CHECK/.test(body), '超时交给 askBackground 自己兜');
    falsy(/Promise\.race\(\[askBackground\(\{ type: MSG\.UPDATE_CHECK/.test(body),
      '★ 旧写法又并了一个同样 15s 的 settled 计时器：谁先到点决定的只是提示文案，等于把结论交给运气');
    falsy(/updateTimer/.test(wjs), '★ updateTimer 这个重复兜底要整体退场（留着就是两条超时来源）');
  });

  await test('★ 全局开关：后台超时不许当成功，必须走直接落盘兜底并如实回报', () => {
    const wjs = code(readSrc('popup/popup.js'));
    const body = between(wjs, "$('chk-global').addEventListener", "$('btn-site').addEventListener");
    truthy(body, '应能找到全局开关处理器');
    truthy(/if \(!res \|\| res\.timedOut\)/.test(body),
      '★ 旧写法只判 !res，而 `{timedOut:true}` 是真值 ⇒ 掉进 else 分支当成功，用户以为开关保存了');
    truthy(/const ok = await write\(\{ globalEnabled: value \}\)/.test(body), '兜底必须是"自己落盘 + 看返回值"');
  });

  await test('★ 「＋ 快速添加」路径超时后落到独立窗口，且点击路径的超时明显短于数据路径', () => {
    const wjs = code(readSrc('popup/popup.js'));
    const body = between(wjs, 'async function openQuickAdd(', 'KH.popupOpenQuickAdd');
    truthy(/withTimeout\(\s*chrome\.tabs\.sendMessage\(id, \{ type: KH\.MSG\.EDITOR_OPEN \}\)/m.test(body),
      '★ EDITOR_OPEN 必须是带超时的调用（旧写法是裸 await，卡住就没有任何反应）');
    truthy(/EDITOR_OPEN[\s\S]{0,400}?return null;[\s\S]{0,120}?if \(r && r\.ok\)/.test(body),
      '★ 超时要按"没答复"处理（回 null）⇒ 自然落到独立窗口兜底，不许假装成功');
    const m = wjs.match(/const EDITOR_TIMEOUT_MS = (\d+);/);
    truthy(m, '要有独立的点击路径超时常量');
    truthy(Number(m[1]) > 0 && Number(m[1]) < 15000,
      '★ 点击路径超时必须比 15s 短：兜底窗口与页面委派等价，让人对着没反应的按钮等 15s 是坏体验');
  });

  /* ---------------- C7 F-7：tooltip 不许与实现反向 ---------------- */

  await test('★ 快速添加的 tooltip 与实现同向（不再声称"在当前弹窗内添加"）', () => {
    const html = readSrc('popup/popup.html');
    const btn = between(html, 'id="btn-add"', '>');
    truthy(/title="在网页上加词（弹窗会关闭）"/.test(btn),
      '★ 两条路（委托网页 / 另开独立窗口）都会关掉本弹窗，tooltip 必须这么说');
    truthy(html.indexOf('在当前弹窗内快速添加关键词') < 0,
      '★ 旧文案与实现相反：用户看到"在当前弹窗内"，点下去弹窗却消失了');
    /* 顶部注释里那句「在弹窗内联」同样要清掉（留着就是下一个人照抄的模板） */
    const raw = readSrc('popup/popup.js');
    truthy(raw.indexOf("KH.ui.openEditor({mode: 'popup'})") < 0,
      '★ 旧注释声称「快速添加 → KH.ui.openEditor({mode:\'popup\'})，在弹窗内联」，与实际两条路都不符');
    truthy(/MSG\.EDITOR_OPEN/.test(raw) && /popup\/editor\.html/.test(raw),
      '注释要写清真实的两条路：页面委派（EDITOR_OPEN）+ 独立编辑窗口（popup/editor.html）');
  });

  /* ---------------- C7 F-8：更新按钮判据必须与下载处理器同源 ---------------- */

  await test('★ 「更新」按钮能不能点与下载处理器同源（crx-only 不再灰得没解释）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    truthy(/function updateDownloadUrl\(info\)/.test(wjs), '★ 要有一个共同判据函数（两份表达式必然漂移）');
    truthy(/return info\.zipUrl \|\| info\.crxUrl \|\| '';/.test(wjs), '判据本体：zip 或 crx 有一即可');
    const render = between(wjs, 'function renderUpdateInfo(', 'function showChecking(');
    truthy(/const dlUrl = updateDownloadUrl\(info\);/.test(render), '★ 渲染侧必须走共同判据');
    truthy(/btnUpdate\.disabled = !dlUrl;/.test(render), '★ 用同一个变量决定禁用');
    truthy(render.indexOf('!info.zipUrl') < 0, '★ 旧判据「只看 zipUrl」必须退场');
    truthy(/btnUpdate\.title = dlUrl/.test(render), '★ 可点/灰掉都要有解释性 title（灰着且零解释正是 F-8 的另一半）');
    const handler = between(wjs, "$('btn-update').addEventListener", "$('btn-channel')");
    truthy(/const url = updateDownloadUrl\(info\);/.test(handler), '★ 处理器侧走同一个函数才叫同源');
    truthy(handler.indexOf('info.zipUrl || info.crxUrl') < 0, '★ 处理器侧也不许再写第二份表达式');
  });

  /* ---------------- C7 F-5：「稍后」必须落盘（否则重开弹窗/下一次轮询就回来） ---------------- */

  await test('★「稍后」要把"这一版看过了"写进 storage（不是只关 UI）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    truthy(/const DISMISS_KEY = 'khUpdateDismissed';/.test(wjs), '★ 要有专门的落盘键');
    const body = between(wjs, "$('btn-update-dismiss').addEventListener", "$('btn-help').addEventListener");
    truthy(body, '应能找到「稍后」处理器');
    truthy(/await write\(\{ \[DISMISS_KEY\]: ver \}\)/.test(body),
      '★ 旧写法只有 renderUpdateInfo(null)：UI 关掉是真的，"稍后"这件事是假的');
    truthy(/忽略失败/.test(body) && /toast\(/.test(body),
      '★ 写失败必须说出来（只关 UI 不落盘 = 用户以为按钮坏了）');
    truthy(/dismissedVersion = ver/.test(body), '写入成功才记进内存');
  });

  await test('★同一条更新信息被再次广播 / 重开弹窗时不许再弹（换新版才重新提示）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    truthy(/function isDismissed\(info\)/.test(wjs), '★ 要有"这条正是被忽略的那一版"的判据');
    truthy(/String\(info\.latestVersion \|\| ''\) === String\(dismissedVersion\)/.test(wjs),
      '★ 比的是**版本**不是布尔：比布尔的话下一版也永远不提示');
    const render = between(wjs, 'async function render(', '/* ---------------- 事件绑定');
    truthy(/await loadDismissed\(\);/.test(render), '★ render() 必须先读回忽略记录，再决定展不展示');
    truthy(/!isDismissed\(cachedInfo\)/.test(render), '★ 展示前过判据');
    truthy(/if \(info && info\.hasUpdate && !isDismissed\(info\)\) renderUpdateInfo\(info\);/.test(wjs),
      '★ background 每 6h 的广播路径同样要过判据');
  });

  await test('★用户主动点「检查更新 / 切通道」时忽略记录要清掉（否则点了没反应）', () => {
    const wjs = code(readSrc('popup/popup.js'));
    const body = between(wjs, 'async function checkUpdate(', 'async function render(');
    truthy(/if \(interactive\) await clearDismissed\(\);/.test(body),
      '★ interactive = 用户明确要看，必须先清忽略记录');
    truthy(/async function clearDismissed\(\)/.test(wjs), '清记录也要如实回报成败（不许默默失败）');
  });

  /* ---------------- C7 F-10：welcome 的失败路径（读失败 ≠ 没有新版本） ---------------- */

  await test('★把"数据源取不到"与"没有新版本"分开（不许伪装成空日志再标记已读）', () => {
    const wjs = code(readSrc('welcome/welcome.js'));
    truthy(/const CHANGELOG = Array\.isArray\(window\.CHANGELOG\) \? window\.CHANGELOG : null;/.test(wjs),
      '★ 旧写法 `window.CHANGELOG || []` 把"脚本没加载出来"伪装成"空日志"');
    truthy(/if \(!CHANGELOG\)/.test(wjs), '★ 取不到数据要走单独分支');
    truthy(/更新日志数据没能加载/.test(wjs), '★ 要如实说，并给出下一步（重新打开本页）');
    truthy(/更新日志数据没能加载[\s\S]{0,240}?return;/.test(wjs),
      '★ 这条路径必须提前 return —— 否则照样往下走到"标记已读"');
  });

  await test('★读 khLastSeenVersion 失败时不许标记已读（下次打开还能看到）', () => {
    const wjs = code(readSrc('welcome/welcome.js'));
    truthy(/let readOk = false;/.test(wjs),
      '★ 旧写法直接解构 await 的结果：get 一 reject 就整段抛出，用户从此再也看不到这次更新');
    truthy(/读取 khLastSeenVersion 失败，本次不标记已读/.test(wjs), '读失败要如实记一笔');
    const mark = wjs.indexOf('if (!readOk) return;');
    const set = wjs.indexOf('khLastSeenVersion: version');
    truthy(mark > 0 && set > mark, '★ 标记已读必须被 readOk 挡在门内，且写在它后面');
    truthy(/写入 khLastSeenVersion 失败[\s\S]{0,160}?下次打开还会显示/.test(wjs),
      '★ 写失败也要留痕：宁可见两遍，不许一次都见不到');
  });

  await test('★welcome 三个渲染各自兜底 + 订阅 storage 变化（一个坏掉不许带走整页）', () => {
    const wjs = code(readSrc('welcome/welcome.js'));
    truthy(/const boot = \(fn, what\) => fn\(\)\.catch\(/.test(wjs),
      '★ 旧写法是三个裸调用：谁先 reject 谁把后面的一起带走，且是 unhandled rejection');
    ['renderStatus', 'renderLog', 'renderShortcuts'].forEach((fn) => {
      truthy(new RegExp('boot\\(' + fn + ',').test(wjs), fn + ' 必须走 boot 兜底');
    });
    truthy(/chrome\.storage\.onChanged\.addListener\(/.test(wjs),
      '★ 旧代码对 storage 变化一无所知：状态条永远是打开那一刻的旧数字');
    truthy(/\(!changes\.keywords && !changes\.groups\)/.test(wjs), '只在关键词/分组变化时刷新状态条');
    truthy(/renderStatus\(\)\.catch\(/.test(wjs), '状态条刷新也要兜底');
    truthy(/onChanged 不可用/.test(wjs), 'addListener 本身失败要有降级日志（不静默）');
  });

  /* ---------------- C7 F-6：更新日志渲染单源（标记不上屏 / 不产链接） ---------------- */

  await test('★文档档是"同一套语法 + 两个开关"，不是第三份渲染实现', () => {
    const md = code(readSrc('src/platform/markdown.js'));
    truthy(/function toDocFragment\(md, doc\) \{ return toFragment\(md, doc, \{ code: true, plain: true \}\); \}/.test(md),
      '★ 文档档必须复用 toFragment，只带 code/plain 两个开关');
    truthy(/KH\.Markdown = \{ toFragment, toDocFragment,/.test(md), '要对外导出（两处调用方共用）');
    truthy(/if \(o\.code && text\[i\] === '`'\)/.test(md), '行内代码分支必须受 o.code 控制（默认关 = 笔记行为不变）');
    truthy(/if \(!o\.plain && \(m = \/\^!\\\[/.test(md), '图片分支要受 o.plain 控制');
    truthy(/if \(!o\.plain && \(m = \/\^\\\[/.test(md), '链接分支要受 o.plain 控制');
    truthy(/if \(!o\.plain && \(m = BARE_URL\.exec/.test(md), '裸网址分支要受 o.plain 控制');
    truthy(/inline\(c\.trim\(\), doc, kids, opts\);/.test(md), '★ 开关要传到表格单元格（漏一处就是半开半闭）');
    truthy(/inline\(lines\[i\], doc \|\| document, kids, o\);/.test(md), '★ 开关要传到段落行');
  });

  await test('★options 侧的更新日志条目也走同一个入口（旧代码是 h(li,{text}) 原样印标记）', () => {
    const ojs = code(readSrc('options/options.js'));
    truthy(/function changelogLi\(text\)/.test(ojs), '★ options 要有一个明确的条目渲染函数');
    truthy(/md\.toDocFragment\(String\(text\), document\)/.test(ojs), '★ 走文档档，不是 h(li,{text})');
    truthy(ojs.indexOf("h('li', { text: String(t) })") < 0, '★ 旧写法必须退场');
    const body = between(ojs, 'function changelogLi(', 'function renderChangelog(');
    truthy(/li\.textContent = String\(text\)/.test(body),
      '★ 渲染器不可用时退回**纯文本**（如实显示标记），不许静默丢内容');
  });
};
