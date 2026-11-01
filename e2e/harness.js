'use strict';
/* 真实浏览器 harness：用 playwright-core 装载未打包扩展，跑真浏览器回归。
 *
 * ── 两条路线（2026-10-06 S0 重做；旧实现只有一条死路）──
 * 旧实现走 `chromium.launchPersistentContext(..., args: ['--load-extension=' + extDir])`，
 * 在 **Chrome ≥137 上默认被禁**（本机 154.0.8037.98 实测：扩展根本没注册 SW），
 * 于是真浏览器回归在本机**完全跑不起来** —— 而 S0 的全部意义就是先让门禁跑得起来
 * （见 `_stage/wayfinder-ocr/rollout-18-phased-plan.md` §3）。
 *
 *   **路线①（默认，新浏览器）**：自己 `spawn` 浏览器，只给 `--user-data-dir=<临时>` +
 *     `--remote-debugging-port=0`，**不给任何扩展开关**；从 `<user-data-dir>/DevToolsActivePort`
 *     读回真实端口 → `chromium.connectOverCDP` → `browser.newBrowserCDPSession()`
 *     → `Extensions.loadUnpacked { path }` ⇒ 返回 `{ id }`（**扩展 ID 直接拿到，比从 SW URL 反推更硬**）。
 *     附带好处：浏览器是我们自己 spawn 的，playwright 那两条会**杀掉 MV3 背景页**的默认标志
 *     （`--disable-extensions`、`--disable-component-extensions-with-background-pages`）根本不会出现。
 *   **路线②（回退，老浏览器）**：Chrome <137 没有 `Extensions.loadUnpacked` 这条 CDP 命令
 *     （本机 Chromium 109.0.5414.0 实测报 `'Extensions.loadUnpacked' wasn't found`），
 *     只能靠 `--load-extension` + `--disable-extensions-except` 装载，而那条在**新** Chrome 上已被禁
 *     ⇒ 交给 **playwright 自己的 launcher**（它会补齐老浏览器需要的一整套参数）跑
 *     `launchPersistentContext`。⇒ 两条路线的**参数集必须分开**：playwright 自己管
 *     user-data-dir 与调试通道，不能塞 `--user-data-dir` / `--remote-debugging-port`。
 *     两个实测坑（取证见 `_stage/wayfinder-ocr/IMPL-LOG.md` §S0）：
 *       ① **profile 目录必须在工作区内**（见下面 PROFILES 处的注释）；
 *       ② **老浏览器必须 headed** —— Chromium 109 的 `--headless`（含 `--headless=old`）
 *          压根不加载扩展：CDP target 列表里一个 `chrome-extension` 都没有、也没有 welcome 页。
 *
 * ── 其它口径（沿用旧实现，别动）──
 *   · 扩展 ID 只认**本扩展自己**的 SW 脚本路径 `background/service-worker.js`：为了加载扩展，
 *     组件扩展也会冒 SW（实测：本机同一次启动里还有 `fignfifo…/service_worker.js` 等三条），
 *     随便取一条会让 extId 变成别人的、后面全是 `ERR_FILE_NOT_FOUND`。
 *   · `waitReady` 等 `window.KH.state.booted`；`setConfig` 经 options 页写 `chrome.storage.local`
 *     （内容脚本上下文碰不到 `chrome.storage`）。
 *   · 每个用例用**新开标签页**，互不干扰。
 *
 * ── 环境变量 ──
 *   KH_CHROME / KHE_BROWSER  指定浏览器可执行文件（`KH_CHROME` 与 `scripts/package.js` 同名同义）
 *   KHE_HEADLESS             'new' → `--headless=new`；'old' → `--headless=old`；
 *                            'plain'/'1' → 裸 `--headless`（Chromium 109 那代没有 new/old 之分）
 *   KHE_EXTRA_ARGS           空格分隔的追加启动参数（老浏览器常需 `--no-sandbox --disable-gpu` 之类）
 *   KHE_NO_LEGACY_FALLBACK   '1' ⇒ 路线①失败时不再走路线②（用于确认"到底死在哪条路上"）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

// Linux 沙箱接续：优先用 KHE_BROWSER 环境变量指定浏览器，否则查常见 Chromium 路径。
const LINUX_CANDIDATES = process.env.KHE_BROWSER ? [process.env.KHE_BROWSER] : [
  '/home/sandbox/tools/chr1148-arm64/chrome-linux/chrome',
  '/repo/keyword-highlighter-extension/scripts/.local/chromium/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium'
];

function findBrowser() {
  const explicit = [process.env.KH_CHROME, process.env.KHE_BROWSER].filter(Boolean);
  for (const list of [explicit, LINUX_CANDIDATES, EDGE_CANDIDATES]) {
    for (const p of list) if (p && fs.existsSync(p)) return p;
  }
  throw new Error('找不到浏览器，可用 KHE_BROWSER（或 KH_CHROME）环境变量指定 Chrome/Chromium 可执行文件路径');
}

/** headless 相关的追加参数（两条路线共用同一套语义） */
function headlessArgs() {
  const hl = String(process.env.KHE_HEADLESS || '').trim();
  if (hl === 'new' || hl === 'old') return ['--headless=' + hl];
  /* Chromium 109 那代还没有 `--headless=new/old` 这个区分（`old` 是后来才补的值），只认裸 `--headless`。 */
  if (hl === 'plain' || hl === '1') return ['--headless'];
  return [];
}

/** KHE_EXTRA_ARGS：空格分隔的追加启动参数（老浏览器常需要 --no-sandbox / --disable-gpu 之类才起得来） */
function extraArgs() {
  return String(process.env.KHE_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
}

/** 路线①的启动参数：**不给任何扩展开关** —— 扩展由 CDP 装载；调试端口交给 Chrome 自己挑 */
function spawnArgs(userDataDir, o) {
  return [
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=0',
    '--window-size=' + ((o.viewport && o.viewport.width) || 1280) + ',' + ((o.viewport && o.viewport.height) || 900),
    '--no-first-run',
    '--no-default-browser-check',
    // 这两条只是"别让浏览器自己搞事"，与扩展加载无关
    '--disable-features=Translate,msEdgeSidebarV2',
    '--disable-blink-features=AutomationControlled'
  ].concat(headlessArgs(), extraArgs(), o.extraArgs || []);
}

/** 路线②的启动参数：**不能**带 --user-data-dir / --remote-debugging-port（playwright 自己管） */
function legacyArgs(extDir, o) {
  return [
    '--disable-extensions-except=' + extDir,
    '--load-extension=' + extDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2',
    '--disable-blink-features=AutomationControlled'
  ].concat(headlessArgs(), extraArgs(), o.extraArgs || []);
}

/** 等 `<user-data-dir>/DevToolsActivePort` 写出端口（第一行是端口，第二行是 browser ws 路径） */
function waitDevToolsPort(userDataDir, ms) {
  const f = path.join(userDataDir, 'DevToolsActivePort');
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      try {
        const first = fs.readFileSync(f, 'utf8').split('\n')[0];
        if (first && Number(first)) return res(Number(first));
      } catch (e) { /* 还没写出来 */ }
      if (Date.now() - t0 > ms) return rej(new Error('DevToolsActivePort 未出现（' + ms + 'ms）：' + f));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 本扩展自己的 SW 判据（脚本路径固定） */
const OURS = (w) => /\/background\/service-worker\.js(\?|$)/.test(w.url());

/** 等本扩展的 service worker 起来；SW 已经起来时立刻返回 */
async function waitOurSW(context, timeout) {
  let sw = context.serviceWorkers().find(OURS);
  if (sw) return sw;
  try { return await context.waitForEvent('serviceworker', { predicate: OURS, timeout: timeout || 20000 }); }
  catch (e) { return null; }
}

async function launch(opts) {
  const o = opts || {};
  const extDir = path.resolve(o.extensionDir);
  const exe = findBrowser();
  const legacyAllowed = process.env.KHE_NO_LEGACY_FALLBACK !== '1';
  /* 默认 profile 放**工作区内**（`_e2e/_profiles/`），**不要用 `os.tmpdir()`**：
   * 实测 Chromium 109 在 `%TEMP%` 与 `F:\` 根下都起不来（headed 报
   * `process_singleton_win.cc(420) Lock file can not be created! Error code: 5`，
   * spawn 路线则是 30s 等不到 `DevToolsActivePort`），换成工作区内的目录立刻就起来了；
   * 完整取证见 `_stage/wayfinder-ocr/IMPL-LOG.md` §S0。Chrome 154 两条路都行，
   * 统一用工作区目录可以少一个坑。
   * KHE_PROFILE_DIR：覆盖成指定目录（**会被 harness 删掉**，当一次性目录用）。 */
  const PROFILES = path.join(__dirname, '_profiles');
  fs.mkdirSync(PROFILES, { recursive: true });
  const userDataDir = process.env.KHE_PROFILE_DIR
    ? path.resolve(process.env.KHE_PROFILE_DIR)
    : fs.mkdtempSync(path.join(PROFILES, 'kh-e2e-'));
  fs.mkdirSync(userDataDir, { recursive: true });

  let browser = null;      // 路线①才有（路线②是 playwright 的 persistent context）
  let proc = null;         // 路线①自己 spawn 的进程
  let context = null;
  let extId = null;
  let sw = null;
  let how = '';
  let route1Err = null;

  /** 路线①：自己 spawn 一个浏览器并连上去 */
  const bootManaged = async (args) => {
    /* 先清掉上一轮留下的 DevToolsActivePort：重试时会复用同一个 user-data-dir，
     * 不清就会在 Chrome 重写它之前读到**旧端口**、连到一个已经死掉的浏览器。 */
    try { fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true }); } catch (e) { /* ignore */ }
    /* stdio:'ignore' 是刻意的：受限沙箱里 spawn 的**管道**会被拒（EPERM），ignore 不受影响。 */
    const p = spawn(exe, args, { stdio: 'ignore' });
    p.on('error', () => { /* 起不来由 waitDevToolsPort 的超时兜底 */ });
    const port = await waitDevToolsPort(userDataDir, 30000);
    const b = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    return { browser: b, proc: p, context: b.contexts()[0] || (await b.newContext()) };
  };

  const teardownManaged = async () => {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { if (proc) proc.kill(); } catch (e) { /* ignore */ }
    browser = null; proc = null; context = null;
    await sleep(500);
  };

  try {
    /* ================= 路线①：自己 spawn + CDP Extensions.loadUnpacked ================= */
    try {
      const b = await bootManaged(spawnArgs(userDataDir, o));
      browser = b.browser; proc = b.proc; context = b.context;
      how = 'cdp';
      const cdp = await browser.newBrowserCDPSession();
      const r = await cdp.send('Extensions.loadUnpacked', { path: extDir });
      extId = (r && (r.id || (r.extension && r.extension.id))) || null;
      if (!extId) throw new Error('Extensions.loadUnpacked 没有返回 id');
    } catch (e1) {
      route1Err = e1;
      await teardownManaged();
      if (!legacyAllowed) {
        throw new Error('路线①（spawn + CDP）失败，且 KHE_NO_LEGACY_FALLBACK=1 已禁用回退：' + e1.message);
      }
      /* ================= 路线②：playwright 自己拉起来 + --load-extension ================= */
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: exe,
        headless: false,                 // 老浏览器配合下面 args 里的 --headless* 生效
        viewport: o.viewport || { width: 1280, height: 900 },
        ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
        args: legacyArgs(extDir, o)
      });
      how = 'legacy';
    }

    sw = await waitOurSW(context, 20000);
    if (!sw) {
      const seen = context.serviceWorkers().map((w) => w.url()).join('\n    ') || '(一个都没有)';
      throw new Error(
        '扩展的 service worker 没起来：找不到 background/service-worker.js。\n' +
        '  浏览器: ' + exe + '\n' +
        '  装载方式: ' + how + (extId ? ('（CDP 返回 id=' + extId + '）') : '') + '\n' +
        '  路线①失败原因: ' + (route1Err ? route1Err.message : '(未失败)') + '\n' +
        '  当前 SW 列表:\n    ' + seen + '\n' +
        '  · 请确认 work/keyword-highlighter/manifest.json 在扩展目录根部；老浏览器可加 KHE_HEADLESS=old 或 KHE_EXTRA_ARGS。'
      );
    }
    /* extId 兜底：路线②（或 CDP 没返回 id 时）从 SW URL 反推 */
    if (!extId) extId = new URL(sw.url()).host;

    const api = { context, sw, extId, userDataDir, browserPath: exe, loadHow: how, browser };

    /** 打开扩展自己的页面（同源 → 可访问 chrome.storage） */
    api.extensionPage = async (rel) => {
      const page = await context.newPage();
      await page.goto('chrome-extension://' + extId + '/' + rel, { waitUntil: 'load' });
      return page;
    };

    /** 探测扩展是否在目标标签页里就绪（content script 已加载） */
    api.waitReady = async (page, timeout) => {
      await page.waitForFunction(() => !!(window.KH && window.KH.state && window.KH.state.booted), null, { timeout: timeout || 15000 });
    };

    /** 写测试配置（经扩展自己的页面，避免直接碰 chrome.storage 的上下文限制） */
    api.setConfig = async (cfg) => {
      const page = await api.extensionPage('options/options.html');
      await page.evaluate(async (c) => {
        await new Promise((res) => chrome.storage.local.clear(res));
        await new Promise((res) => chrome.storage.local.set(c, res));
      }, cfg);
      await page.close();
    };

    /** 关掉**安装时自动打开**的欢迎页（新 profile 首次装扩展会开一张），免得干扰用例的页数断言 */
    api.closeInstallTabs = async () => {
      for (const p of context.pages()) {
        const u = p.url();
        if (/^chrome-extension:\/\/[^/]+\/(welcome|options)\//.test(u) || u === 'about:blank') {
          try { await p.close(); } catch (e) { /* ignore */ }
        }
      }
    };

    api.close = async () => {
      if (how === 'legacy') {
        try { await context.close(); } catch (e) { /* ignore */ }
      } else {
        await teardownManaged();
      }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    };

    return api;
  } catch (e) {
    if (how === 'legacy') { try { await context.close(); } catch (e2) { /* ignore */ } }
    else await teardownManaged();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    throw e;
  }
}

module.exports = { launch, findBrowser };
