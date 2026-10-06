/* tests/specs/ocr-link.test.js — 图片 OCR 的**链路所有权**（S1-b · 不变量 5 / 7 / 8；S2 · 不变量 6）
 * ----------------------------------------------------------------------------
 * 这张 spec 锁的是「图片 OCR 会不会卡在中间态」这一类硬伤（票 #16 ②③④）。四条不变量：
 *   · 不变量 5 —— 每一条 `kh:ocr:image` 都**必须**有一个终态（ok / fail / timeout / engine-lost），
 *                 终态必**归还一次**额度（幂等）；判决必须是纯函数（喂 now，不依赖假计时器）。
 *   · 不变量 6（S2）—— background 转发的 payload **必含** `engine`（引擎配置全链路只有它读）；
 *   · 不变量 7 —— `offscreen/**` 不得出现 `chrome.storage`（offscreen 文档没有这个 API）。
 *   · 不变量 8 —— `chrome.offscreen.hasDocument` 全仓零命中（它是 Chrome 116+，而 manifest 写着 109）。
 *
 * 【为什么 `background/ocr.js` 必须"自己装一遍"】它不进 content_scripts（manifest 里没有它），
 * 内核 `tests/bootstrap.js` 的 loadKernel 只按 manifest 加载内容脚本 —— 拿不到它。
 * 这里用 `new Function('self','chrome', 源码)` 给它一个**假的消息层**：
 * 于是"看门狗有没有真的投出终态""认领不到时投给了谁"都成了可断言的事实，而不是靠读代码猜。
 * （同款手法先例：`tests/specs/color-field.test.js:27`、`tests/specs/optional-batch8.test.js:107`）
 *
 * 【为什么要带"负样本"】不变量 7 今天是**绿**的（offscreen 里本来就没写 chrome.storage）。
 * 一个永远为绿的守卫等于没有守卫 —— 所以每条静态守卫都要先喂一段"确实违规"的样本证明它真会红。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------- 静态守卫工具（不变量 7 / 8 共用） ---------------- */

const TEXT_EXT = /\.(js|json|html|css|md|txt)$/i;

/** 列出一个目录下的全部文本文件（相对仓库根，正斜杠） */
function filesUnder(dir) {
  const abs = path.join(ROOT, dir);
  const out = [];
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    const rel = dir + '/' + name;
    const full = path.join(ROOT, rel);
    if (fs.statSync(full).isDirectory()) out.push.apply(out, filesUnder(rel));
    else if (TEXT_EXT.test(name)) out.push(rel);
  }
  return out;
}

/**
 * 在若干目录里找"含违禁串"的文件。
 * @param {RegExp} rx 违禁串（不带 g，避免 lastIndex 残留）
 * @param {string[]} dirs 仓库内相对目录
 * @returns {string[]} 违规文件的相对路径
 */
function offenders(rx, dirs) {
  const hits = [];
  for (const d of dirs) {
    for (const rel of filesUnder(d)) {
      if (rx.test(read(rel))) hits.push(rel);
    }
  }
  return hits;
}

/* ---------------- 假的消息层：把 background/ocr.js 装起来 ---------------- */

/**
 * @param {object} MSG KH.MSG
 * @param {{t:number}} [clock] 假时钟：把源码里的 `Date.now()` 接到 `clock.t`。
 *   看门狗判决是"喂时刻"的纯函数，但**续命**要把"进度到达的时刻"记进 job ——
 *   不给时钟就只能拿真实时间当进度时刻，与 `_sweep(未来时刻)` 对不上（第一版就是这么错的）。
 * @param {{storage?:object|null}} [opts] `storage` = 假 `chrome.storage.local.get` 的返回值
 *   （S2 起 background 要读 `imgOcr.engine` 并注入 payload，不变量 6 靠它驱动）。
 * @returns {{host:object, toOffscreen:object[], toUi:object[], toTab:object[]}}
 *   toOffscreen = background → offscreen；toUi = background → 扩展页（runtime.sendMessage）；
 *   toTab = background → 内容脚本（tabs.sendMessage，带 frameId）
 */
function loadHost(MSG, clock, opts) {
  const o = opts || {};
  const toOffscreen = [];
  const toUi = [];
  const toTab = [];
  const chromeStub = {
    offscreen: {
      /* 真实语义：首次建成功、之后 reject "single offscreen document already exists" */
      createDocument: () => Promise.resolve()
    },
    runtime: {
      lastError: null,
      sendMessage: (payload, cb) => {
        if (payload && payload.to === 'offscreen') toOffscreen.push(payload);
        else toUi.push(payload);
        if (typeof cb === 'function') cb();
      }
    },
    tabs: {
      sendMessage: (tabId, payload, options) => {
        toTab.push({ tabId: tabId, frameId: options && options.frameId, options: options, payload: payload });
        return Promise.resolve();
      }
    }
  };
  if ('storage' in o) {
    chromeStub.storage = o.storage === null ? undefined : {
      local: {
        get: (key, cb) => { cb(o.storage || {}); }
      }
    };
  }
  const selfStub = { KH: { MSG: MSG } };
  const dateStub = { now: () => (clock ? clock.t : Date.now()) };
  /* 源码里 `self.KH.MSG` / `chrome.*` / `Date` 都是自由变量 → 由形参接管（不碰真实全局） */
  new Function('self', 'chrome', 'Date', read('background/ocr.js'))(selfStub, chromeStub, dateStub);
  return { host: selfStub.OcrHost, toOffscreen: toOffscreen, toUi: toUi, toTab: toTab };
}

/** 临时准备一个全局 chrome（内容脚本侧要它才发得出消息），用完**原样恢复** */
async function withChrome(stub, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'chrome');
  const prev = global.chrome;
  global.chrome = stub;
  try {
    return await fn();
  } finally {
    if (had) global.chrome = prev;
    else delete global.chrome;
  }
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const MSG = KH.MSG;
  const O = KH.ImgOcr;

  suite('图片 OCR 链路所有权：终态 / 额度 / 静态守卫（S1-b）');

  /* ==================================================================
   * 不变量 5（后台侧）：每条请求都必须有终态，且终态只投一次
   * ================================================================== */

  await test('★ 不变量 5：引擎不回话 → 硬顶 120s 由看门狗给 timeout，且只给一次', async () => {
    const clock = { t: 1000000 };
    const m = loadHost(MSG, clock);
    await m.host.submitImage(
      { src: 'https://a.test/x.png', keyword: '华为' },
      { tab: { id: 7 }, frameId: 3, url: 'https://a.test/page' }
    );

    const jobs = m.host._debug().jobs;
    eq(jobs.length, 1, '提交后必须登记成一条 job —— 生命周期归 background，不是 offscreen 自说自话');
    const job = jobs[0];
    eq(job.tabId, 7, 'job 必须记住发起方标签页');
    eq(job.frameId, 3, 'job 必须记住 frameId（结果要投回**同一个 frame**）');
    eq(typeof job.at, 'number', 'job 必须记住起始时刻（看门狗判决要它）');
    eq(m.toOffscreen.length, 1, '要真的把活派给 offscreen');

    eq(m.host._sweep(job.at + 119000), 0, '不到硬顶（119s）不许判超时');
    eq(m.toTab.length, 0, '没到硬顶就不该有任何结果投出去');

    eq(m.host._sweep(job.at + 121000), 1, '过硬顶（120s）必须判超时 —— 这是「永久识别中」的唯一解药');
    eq(m.toTab.length, 1, '终态必须**真的投给发起方**一次（旧实现丢结果时这里恒为 0）');
    eq(m.toTab[0].tabId, 7, '投给发起方那个标签页');
    eq(m.toTab[0].frameId, 3, '投递必须带 frameId（多 frame 页面里不然会投错 frame）');
    eq(m.toTab[0].payload.to, 'content', '给内容脚本的结果 to 必须是 content');
    eq(m.toTab[0].payload.ok, false, '超时是失败终态');
    eq(m.toTab[0].payload.code, 'timeout', '原因码必须是 timeout（面板据此说人话）');
    eq(m.toTab[0].payload.requestId, job.requestId, '终态必须回显 requestId（发起方靠它对账）');
    eq(m.host._debug().jobs.length, 0, '判超时后 job 必须注销，不许留着再判一次');

    eq(m.host._sweep(job.at + 600000), 0, '幂等：同一条不许再给第二个终态');
    eq(m.toTab.length, 1, '幂等：投递总数不许涨');
  });

  await test('★ 不变量 5：progress 续命 —— 有进度就不许被 120s 硬顶砍掉；静默满 60s 才砍', async () => {
    const clock = { t: 1000000 };
    const m = loadHost(MSG, clock);
    await m.host.submitImage(
      { src: 'https://a.test/y.png', keyword: '华为' },
      { tab: { id: 8 }, frameId: 0, url: 'https://a.test/page' }
    );
    const at = m.host._debug().jobs[0].at;

    /* 语言包下载/校验会一直发进度（`downloadLang` 的 download/verify/store）。
     * 旧实现只能在 180s 的 RPC 超时上干等，用户看到的是"卡住"；新口径：进度就是心跳。 */
    for (let t = 30000; t <= 240000; t += 30000) {
      clock.t = at + t;                 /* 进度**到达时刻**也必须走假时钟（第一版没走，于是与 sweep 的未来时刻对不上） */
      m.host.onOffscreenMessage({
        to: 'background', type: MSG.OCR_PROGRESS,
        job: 'lang', lang: 'chi_sim', quality: 'fast', phase: 'download'
      });
      eq(m.host._sweep(clock.t), 0, '第 ' + (t / 1000) + 's：刚收到过进度，不许判超时');
    }
    eq(m.toTab.length, 0, '★ 持续有进度的 job 不许被硬顶砍掉（否则长图/首次下语言包必假超时）');

    eq(m.host._sweep(at + 300000 + 1000), 1, '最后一条进度之后静默满 60s → 判超时');
    eq(m.toTab.length, 1, '判超时也要真的投出去');
    eq(m.toTab[0].payload.code, 'timeout');
  });

  await test('★ 不变量 5：结果先到即终态；认领不到的 requestId **不许**改投扩展页', async () => {
    const m = loadHost(MSG);
    await m.host.submitImage(
      { src: 'https://a.test/z.png', keyword: '华为' },
      { tab: { id: 9 }, frameId: 2, url: 'https://a.test/page' }
    );
    const id = m.host._debug().jobs[0].requestId;

    m.host.onOffscreenMessage({
      to: 'background', type: MSG.OCR_RESULT, requestId: id, ok: true, text: '华为', src: 'https://a.test/z.png'
    });
    eq(m.toTab.length, 1, '结果到了要立刻投给发起方');
    eq(m.toTab[0].payload.ok, true);
    eq(m.toTab[0].payload.text, '华为');
    eq(m.host._debug().jobs.length, 0, '出终态后 job 注销（看门狗不许再判一次）');
    eq(m.host._sweep(Date.now() + 600000), 0, '★ 已经有终态的 job，看门狗不许再给第二个终态');
    eq(m.toTab.length, 1);

    /* 旧实现的靶心：认领不到 job 时投 `to:'ui'` —— 内容脚本按 `to` 过滤丢掉，
     * 于是「永久识别中 + 额度只减不增」，累积 4 次整页 OCR 静默全废。 */
    const uiBefore = m.toUi.length;
    const handled = m.host.onOffscreenMessage({
      to: 'background', type: MSG.OCR_RESULT, requestId: 'img404-1', ok: true, text: 'x'
    });
    eq(handled, true, '这条消息仍要认领（否则会被别的监听者再处理一遍）');
    eq(m.toUi.length, uiBefore, '★ 认领不到的 requestId 不许改投扩展页（旧实现就是死在这）');
    eq(m.toTab.length, 1, '更不许瞎投给某个标签页');
  });

  await test('★ 不变量 5：扩展页（设置页自检）的结果仍投 to:ui —— 那条路不能砍', async () => {
    const m = loadHost(MSG);
    /* service-worker 就是这么派自检的：没有 tab、url 是扩展页 */
    await m.host.submitImage(
      { src: 'data:image/png;base64,iVBORw0KGgo=', keyword: '华为' },
      { tab: null, url: 'chrome-extension://ui/options.html' }
    );
    const id = m.host._debug().jobs[0].requestId;
    m.host.onOffscreenMessage({
      to: 'background', type: MSG.OCR_RESULT, requestId: id, ok: true, text: '华为'
    });
    eq(m.toTab.length, 0, '扩展页没有标签页，不能投 tabs.sendMessage');
    eq(m.toUi.length, 1, '必须投 to:ui（设置页自检据此显示结果）');
    eq(m.toUi[0].to, 'ui');
  });

  /* ==================================================================
   * 不变量 6（后台侧 · S2）：转发的 payload **必含** `engine`，且值是 storage 里那个
   * —— 引擎配置全链路**只有 background 读**（offscreen 读不到 chrome.storage），
   * 所以"注入"这一步错了，offline 那边只能靠猜，用户也就不知道自己被降级了。
   * ================================================================== */

  await test('★ 不变量 6：payload 必含 engine，且等于 storage 里的 imgOcr.engine', async () => {
    for (const [stored, want] of [['ppocr', 'ppocr'], ['tesseract', 'tesseract'], ['auto', 'auto']]) {
      const m = loadHost(MSG, null, { storage: { imgOcr: { engine: stored } } });
      await m.host.submitImage({ src: 'data:image/png;base64,x', keyword: '华为' }, { tab: { id: 7 }, frameId: 0, url: 'https://a.com/' });
      const got = m.toOffscreen.find((p) => p.type === MSG.OCR_IMAGE);
      truthy(got, '没有转发给 offscreen 的 OCR_IMAGE');
      eq(got.engine, want, 'storage 里是 ' + stored + '，转发时必须是 ' + want);
      eq(m.host._debug().jobs[0].engine, want, 'job 台账也要记下当时的引擎（排障要看）');
    }
  });

  await test('★ 不变量 6：脏值/缺失/读不到 storage 一律按 auto —— 绝不猜成"只用主引擎"', async () => {
    const cases = [
      [{ storage: { imgOcr: { engine: 'best' } } }, 'auto', '旧的档位值（best）'],
      [{ storage: { imgOcr: {} } }, 'auto', 'imgOcr 存在但没这个键'],
      [{ storage: {} }, 'auto', 'storage 是空的'],
      [{ storage: null }, 'auto', '连 chrome.storage 都没有（老浏览器/被裁剪的环境）']
    ];
    for (const [opts, want, why] of cases) {
      const m = loadHost(MSG, null, opts);
      await m.host.submitImage({ src: 'data:image/png;base64,x', keyword: 'x' }, { tab: { id: 1 }, frameId: 0, url: 'https://a.com/' });
      eq(m.toOffscreen.find((p) => p.type === MSG.OCR_IMAGE).engine, want, why + ' ⇒ 必须是 ' + want);
    }
  });

  /* ==================================================================
   * 不变量 8 / 7：静态守卫（各带负样本，证明守卫不是永远为绿）
   * ================================================================== */

  await test('★ 不变量 8：不许**调用** `chrome.offscreen.hasDocument`（它是 116+，manifest 写 109）', () => {
    const dirs = ['background', 'offscreen', 'src', 'content', 'options', 'popup'];
    /* 口径＝"调用形式"（`…hasDocument(`），不是"提到这个名字"：
     * 代码里**应当**能写出这个 API 名来注释"为什么不许用" —— 第一版守卫就打了自己的注释。 */
    const callRx = /chrome\.offscreen\.hasDocument\s*\(/;
    const bad = offenders(callRx, dirs);
    eq(bad.length, 0, '★ 不许再调 hasDocument（109–115 上直接 TypeError）：命中 = ' + bad.join(', '));

    /* 负样本：同一个正则喂违规**调用**必须命中（守卫不空转） */
    eq(callRx.test('if (await chrome.offscreen.hasDocument()) return true;'), true,
      '负样本：违规调用必须被同一个正则命中');
    /* 正样本：说明性注释不算违规（这正是第一版的假阳性） */
    eq(callRx.test('/* 不许调 `chrome.offscreen.hasDocument`（116+） */'), false,
      '注释里提到 API 名不该被当成违规');

    /* 正样本：能力检测 + try-create 才是 109 能走的写法 */
    truthy(/chrome\.offscreen\s*&&\s*typeof\s+chrome\.offscreen\.createDocument\s*===\s*'function'/.test(read('background/ocr.js')),
      '必须改成"能力检测 + 直接建文档"（撞车当成功）');
  });

  await test('★ 不变量 7：`offscreen/**` 不许出现 chrome.storage（offscreen 文档没有这个 API）', () => {
    const rx = /chrome\.storage/;
    const bad = offenders(rx, ['offscreen']);
    eq(bad.length, 0, '★ offscreen 里不许读写 chrome.storage（拿不到，会是 undefined 报错）：命中 = ' + bad.join(', '));

    /* 负样本：同一个正则喂一段违规样本必须命中（守卫不空转） */
    eq(rx.test('const v = await chrome.storage.local.get(k);'), true, '负样本：违规写法必须被命中');
    truthy(filesUnder('offscreen').length > 0, '扫描面必须非空（否则"零命中"是假的）');
  });

  await test('★ 109 兼容：offscreen 的 reasons 必须有 BLOBS 兜底（WORKERS 是 124+ 才有的枚举）', () => {
    const src = read('background/ocr.js');
    /* 【真机证据（2026-10-06，S2-d）】Chromium 109 上 `reasons: ['WORKERS']` 会直接抛
     * `Error at property 'reasons': … Value must be one of AUDIO_PLAYBACK, BLOBS, …`
     * ⇒ 整条 OCR 链路在 109 上**一次都不成功**（探针实测：12 次请求全部静默超时）。
     * 兜底是"先试 WORKERS、被拒退 BLOBS"（`_e2e/probe-109-diag.js` 实测 BLOBS 在 109 上 ok）。
     * 静态守卫只钉"兜底还在"；真机那半见 `_e2e/probe-s2d-thresholds.js` 的 109 运行记录。 */
    truthy(/createOffscreen\(\['WORKERS'\]\)/.test(src), '先把语义最准的 WORKERS 试一遍');
    truthy(/createOffscreen\(\['BLOBS'\]\)/.test(src), 'WORKERS 被拒后必须退到 BLOBS（109 认它）');
    truthy(/reasons\|Value must be one of/i.test(src), '兜底只许在"枚举非法"时发生（其它错误照样抛）');
    /* 负样本：reason 直接写死的旧写法必须已消失 */
    falsy(/reasons:\s*\['WORKERS'\]\s*,\s*\n\s*justification/.test(src), '不许再有"一条路写死 WORKERS"的写法');
  });

  /* ==================================================================
   * 不变量 5（内容脚本侧）：额度按 token 记账、终态必归还、归还幂等
   * ================================================================== */

  await test('★ 不变量 5：额度按 token 记账 —— 结果**不带 src** 也必须归还，且归还幂等', async () => {
    const sent = [];
    const stub = {
      runtime: {
        lastError: null,
        sendMessage: (payload, cb) => {
          sent.push(payload);
          if (typeof cb === 'function') cb({ ok: true, requestId: 'img' + sent.length, queued: true });
        }
      }
    };

    await withChrome(stub, async () => {
      /* 从干净台账起步：走**真实销毁路径**（`src/core/rebuilder.js:111` 就是 `feat.clear(root, o)`）。
       * 顺带锁住签名 —— 旧实现写成 `clear(reason)`，而调用方传的是 `(root, opts)`，
       * 于是 `reason === 'destroy'` 永远不成立、销毁时额度根本不清零（S1-b 顺手修掉的附带缺陷）。 */
      const feat = KH.features.get('img-ocr');
      truthy(feat && typeof feat.clear === 'function', 'img-ocr 必须是注册过的功能（销毁路径要它）');
      feat.clear(null, { reason: 'destroy' });

      const imgs = [];
      for (let i = 0; i < 5; i++) {
        const im = H.el('img');
        im.setAttribute('src', 'data:image/png;base64,AAAA' + i);
        im.naturalWidth = 100;
        im.naturalHeight = 100;
        imgs.push(im);
      }
      const a = (function () {
        const valueCell = H.el('td');
        for (const im of imgs) valueCell.appendChild(im);
        const labelCell = H.el('td');
        labelCell.appendChild(H.txt('应用截图'));
        const tr = H.el('tr');
        tr.appendChild(labelCell); tr.appendChild(valueCell);
        tr.cells = tr.children;
        tr.cells.forEach((td, i) => { td.cellIndex = i; });
        tr.rowIndex = 0;
        const tbody = H.el('tbody'); tbody.appendChild(tr);
        const table = H.el('table'); table.appendChild(tbody);
        table.rows = [tr];
        const rule = {
          ruleId: 'kOcrLink', pattern: /华为/g, labelPattern: /供应商/g, flags: {}, labelFlags: {},
          meta: {
            imgOcr: true, imgOcrMax: 9, display: '华为', label: '供应商',
            fetchLabels: '应用截图', imgOcrKeyword: '华为'
          }
        };
        return { rule: rule, anchorCell: labelCell, valueCells: [valueCell], table: table, labelCell: labelCell, valueCell: valueCell };
      })();

      let tn = null;
      (function walk(n) {
        for (const c of (n.childNodes || [])) {
          if (c.nodeType === 3 && String(c.nodeValue || '').trim()) { tn = c; return true; }
          if (c.nodeType === 1 && walk(c)) return true;
        }
        return false;
      })(a.anchorCell);

      O.build({}, {}, [{ ruleId: a.rule.ruleId, meta: a.rule.meta, textNode: tn }]);
      const items = O.items();
      eq(items.length, 5, '5 张图都该登记成条目');
      eq(sent.length, 4, '★ 在途上限 4：第 5 条不许发出去（额度是硬闸）');
      eq(O._debug().inflight, 4, '在途额度 = 4（`popup/popup.js:197` 读的就是这个键）');

      /* ★ #16 ③ 的靶心：viaCanvas / blob: 那条路回来的结果**不带 src**。
       * 旧实现 `if (src) inflightCount--` ⇒ 额度永不归还，累积 4 次整页 OCR 静默全废。
       * 【2026-10-06 补发之后的语义】归还的额度会被**队里第 5 张立刻接管** ⇒
       * 在途仍是 4（上限），但 `sent` 从 4 涨到 5 —— 这比"在途减 1"更能证明额度真的还回来了
       * （没还的话第 5 张永远发不出去）。 */
      O._onResult({ requestId: 'img1', ok: true, text: '华为' });
      eq(O._debug().inflight, 4, '★ 结果不带 src 也必须归还额度（旧实现会卡在 4、第 5 张永远发不出去）');
      eq(sent.length, 5, '归还的额度必须被队里那张接管（补发）');

      O._onResult({ requestId: 'img1', ok: true, text: '华为' });
      eq(O._debug().inflight, 4, '幂等：同一条结果再来一次不许把额度还成负的/多还，也不许重复补发');
      eq(sent.length, 5, '幂等：不许因为重复结果又多发一张');

      /* 兜底收口：background 被 MV3 杀掉时不会有任何回执，内容脚本必须自己判死 */
      const n = O._sweep(Date.now() + 200000);
      eq(n, 4, '★ 超过 JOB_STALE_MS（150s）的在途请求必须被内容脚本自己收口（此时在途＝4）');
      eq(O._debug().inflight, 0, '收口后额度归零，下一个标签页/下一次重建还能继续用');
      const timedOut = O.items().filter((it) => it.state === 'fail' && it.errorCode === 'timeout');
      eq(timedOut.length, 4, '收口的条目必须落到终态 fail + errorCode=timeout（面板于是能说人话）');
      eq(O._sweep(Date.now() + 400000), 0, '幂等：收口过的请求不许再收一次');
    });
  });

  await test('★ 不变量 5：canvas/blob 那条路的 payload 也要带 src（幂等归还的前提）', () => {
    const src = read('src/features/img-ocr.js');
    /* 结构断言：canvas 分支的 payload 必须同时带 dataUrl 与 src —— 只发 dataUrl 时回执没有 src，
     * 靠 src 归还额度的旧实现必然泄漏（这是 #16 ③ 的根因，行为已在上一用例锁住）。 */
    truthy(/dataUrl:\s*dataUrl[\s\S]{0,80}?src:\s*cls\.src/.test(src),
      'canvas 分支的 payload 必须带上 src（回执才有 src 可对账）');
    falsy(/quality:\s*\(cfg[\s\S]{0,120}?'best'\s*:\s*'fast'\)/.test(src),
      'quality 是死代码（两处都被丢，永远到不了引擎）—— S1 必须删掉它');
  });
};
