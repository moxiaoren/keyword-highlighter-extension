'use strict';
/* E2E 入口：启动 fixtures 服务 + 真实 Edge（加载未打包扩展），按**方面**跑回归
 *
 * 用法：
 *   node run.js                          # 全跑（不裁剪）
 *   node run.js --aspects=hit,interact   # 只跑覆盖这些方面的组
 *   node run.js --aspects=none           # 什么都不跑（不启动浏览器）——除非真机装置比基线新，见下
 *
 * 用户的规矩：**改到哪个方面就回归哪个方面；不好判断就全量**。
 * 方面清单与"哪些文件属于哪个方面"由 scripts/impact.js 定义（唯一真源），
 * 出包时 package.js 会自动带上这里需要的 --aspects。
 * 组级的裁剪在 t.js 里做：group(name, { aspects: [...] }) 标注，**没标注的组一律照跑**。
 *
 * `none` 不是无条件信任的：`_e2e/` 不在影响面分析的遍历集合里（那套只扫扩展仓库），
 * 只改了真机用例的一轮会被判 `none`，照字面跳过就是**改测试却跳过真机回归 = 假绿**。
 * 所以装置文件比上次验证的基线新时，这里自己把 `none` 升成全量（`deviceNewerThanBaseline()`）。
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./harness');
const { start } = require('./server');
const { CONFIG } = require('./test-config');

/* 扩展根目录（三选一，按顺序）：
 *   ① 环境变量 `KH_EXT_DIR`（CI 或特殊检出结构时指定）；
 *   ② 上一级有 `manifest.json` ⇒ 仓内位置 `work/keyword-highlighter/e2e/`（2026-11-01 起）；
 *   ③ 否则按老位置 `工作区根/_e2e/` 推：扩展在 `../work/keyword-highlighter`。
 * 不写死一个的原因：这套装置既要能在扩展仓内独立跑（CI 里没有工作区），
 * 也要能在老工作区里跑（兼容，探针脚本还留在那边）。 */
const EXT_DIR = process.env.KH_EXT_DIR
  ? path.resolve(process.env.KH_EXT_DIR)
  : (fs.existsSync(path.join(__dirname, '..', 'manifest.json'))
    ? path.resolve(__dirname, '..')
    : path.resolve(__dirname, '../work/keyword-highlighter'));

const argv = process.argv.slice(2);
const RAW = (argv.find((a) => a.indexOf('--aspects=') === 0) || '').split('=')[1] || 'all';
let ASPECTS = RAW.split(',').map((s) => s.trim()).filter(Boolean);
let IS_ALL = ASPECTS.length === 0 || ASPECTS.indexOf('all') >= 0;
const has = (list) => IS_ALL || list.some((a) => ASPECTS.indexOf(a) >= 0);

/* ---- `none` 的守卫：真机装置比基线新 ⇒ 不认这个 none（2026-10-07 用户批准） ----
 * `_e2e/` 在工作区里、不在扩展仓库内（`scripts/impact.js` 里有原话）⇒ 它不在影响面
 * 分析的遍历集合里。于是"只改了真机用例"的那一轮会被判 `none`，而 `none` 在这里是
 * **直接跳过整层**（下面那段处理 `none` 的分支）—— 改测试却跳过真机回归就是**假绿**：本轮实测踩到，
 * 改了 `content.test.js` 之后不带 `--full` 出包，那些新断言一条都不会跑。
 * 对策：装置（用例本体 `*.test.js` + 装置代码）比**上次验证通过的基线**新，就说明这套
 * 装置从没跑过 ⇒ 按全量跑。基线 `release/.impact-baseline.json` 由 `package.js` 出包
 * 成功后写入，所以它天然是"上一次完整验证"的时间戳；找不到基线时也按全量（保守）。 */
const DEVICE_FILES = ['run.js', 't.js', 'harness.js', 'server.js', 'test-config.js'];
function deviceNewerThanBaseline() {
  const baseline = path.resolve(EXT_DIR, 'release/.impact-baseline.json');
  let base = 0;
  try { base = fs.statSync(baseline).mtimeMs; }
  catch (e) { return '找不到上次验证的基线（' + path.relative(path.resolve(__dirname, '..'), baseline) + '）'; }
  const names = fs.readdirSync(__dirname).filter((f) => /\.test\.js$/.test(f) || DEVICE_FILES.indexOf(f) >= 0);
  let newest = null;
  for (const f of names) {
    let st = null;
    try { st = fs.statSync(path.join(__dirname, f)); } catch (e) { continue; }
    if (st.mtimeMs > base && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { name: f, mtimeMs: st.mtimeMs };
  }
  if (!newest) return '';
  return newest.name + '（' + new Date(newest.mtimeMs).toISOString() + '）比基线（' + new Date(base).toISOString() + '）新';
}

if (RAW === 'none') {
  const stale = deviceNewerThanBaseline();
  if (!stale) {
    console.log('本次变更不涉及交付行为（none）→ 跳过真浏览器回归。');
    process.exit(0);
  }
  console.log('本次变更不涉及交付行为（none），但真机装置比上次验证的基线新：' + stale);
  console.log('  → 不认这个 none（改测试却跳过真机回归 = 假绿），按全量跑。');
  /* `--aspects` 的真源是 **process.argv** —— t.js 在 require 时自己再解析一遍。
   * 只改本文件的局部 ASPECTS 是不够的：实测会出现"浏览器起来了、组被全裁掉（通过 0 · 失败 0）"，
   * 那比直接跳过还假。所以把 argv 里的那一项也改掉。 */
  const ai = process.argv.findIndex((a) => a.indexOf('--aspects=') === 0);
  if (ai >= 0) process.argv[ai] = '--aspects=all';
  ASPECTS = ['all'];
  IS_ALL = true;
}

/* 各方面由哪一层覆盖（改了这里的对应关系，要同步 impact.js 顶部的覆盖分布表）
 * 注意：UI 层各分组**共用同一个 options 页面且状态累积**，所以它按"整层"跑 ——
 * 只要选中 ui 就把 UI 层全部组都跑；data 方面没有独立的 e2e 覆盖（由 Node 单测兜）。 */
const CONTENT_ASPECTS = ['hit', 'visual', 'interact', 'fetch', 'site'];
const UI_ASPECTS = ['ui'];
const WANT_CONTENT = has(CONTENT_ASPECTS);
const WANT_UI = has(UI_ASPECTS);
if (!WANT_CONTENT && !WANT_UI) {
  console.log('本次只涉及 ' + ASPECTS.join('/') + '：真浏览器 e2e 未覆盖这些方面' +
    '（由 Node 单测覆盖）→ 跳过真浏览器回归。');
  process.exit(0);
}

(async () => {
  const { server, origin } = await start(8801);
  let api = null;
  let failed = false;
  try {
    console.log('浏览器: ' + require('./harness').findBrowser());
    console.log('扩展目录: ' + EXT_DIR);
    console.log('回归方面: ' + (IS_ALL ? 'all（不裁剪）' : ASPECTS.join(' / ')) +
      '  →  ' + [WANT_CONTENT ? '内容层' : '', WANT_UI ? 'UI 层' : ''].filter(Boolean).join(' + '));
    api = await launch({ extensionDir: EXT_DIR });
    console.log('扩展 ID: ' + api.extId + '（装载方式: ' + api.loadHow + '）');
    /* 新 profile 首次装扩展会自动开一张 welcome 页；留着会干扰按页数判定的用例（S0 加的）。 */
    await api.closeInstallTabs();
    await api.setConfig(CONFIG);
    console.log('配置已注入（keywords=' + CONFIG.keywords.length + '，silent/gap=0）\n');

    const ctx = { api, origin };
    let okContent = true, okUi = true;
    if (WANT_CONTENT) okContent = await require('./content.test')(ctx);
    else console.log('\n— 跳过内容层（本次不涉及 ' + CONTENT_ASPECTS.join('/') + ' 任一方面）');
    if (WANT_UI) okUi = await require('./ui.test')(ctx);
    else console.log('\n— 跳过 UI 层（本次不涉及 ' + UI_ASPECTS.join('/') + ' 任一方面）');
    failed = !(okContent && okUi);
  } catch (err) {
    console.error('\n运行期异常：', err && err.message);
    console.error(err && err.stack);
    failed = true;
  } finally {
    if (api) {
      try {
        const page = await api.context.newPage();
        await page.goto('chrome-extension://' + api.extId + '/options/options.html');
        await page.evaluate(() => { window.__KH_E2E_DONE__ = true; });
        await page.close();
      } catch (e) { /* ignore */ }
      await api.close();
    }
    server.close();
  }
  if (failed) process.exitCode = 1;
})();
