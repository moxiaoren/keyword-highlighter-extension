/* ============================================================================
 * offscreen/ocr.js · 图片文字识别（OCR）引擎封装（跑在 MV3 offscreen 文档里）
 * ----------------------------------------------------------------------------
 * 它只做四件事，业务（哪个词、哪个格子、怎么展示）一律不在这里：
 *   ① **语言包投递**：把语言包字节弄进 tesseract 读得到的地方（本地缓存优先）
 *   ② **引擎生命周期**：按语言集合建 worker、空闲即销毁（省内存）
 *   ③ **串行队列**：一次只识别一张图（CPU 密集，并发只会互相拖慢）
 *   ④ **结果回传**：统一 `{type: ocr:result, to:'background', requestId, ...}`
 *
 * ============================ 真浏览器实测得到的三条铁律 ============================
 * （_e2e/probe-ocr1~6.js，证据见 tests/E2E-REPORT.md「图片文字识别」小节）
 *
 * ① `langPath` **必须显式给**，而且要给一个"扩展内的本地目录"。
 *    tesseract 在 langPath 为空时会**自己去 jsDelivr CDN** 拉语言包（实测抓到
 *    `cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim/4.0.0_best_int/...`）。
 *    我们的隐私承诺是"除了本项目自己的语言包地址，不访问任何网络"，所以：
 *      · worker 的 langPath 固定 = `chrome-extension://<id>/vendor/lang`（本地目录，
 *        没放包时只会 404，**永远不会**退化成上网）；
 *      · 真正的语言包字节由**我们自己**取（下载 + sha256 校验 / 手动导入 / 本地文件）
 *        后写进 tesseract 的 IndexedDB 缓存，worker 读缓存 → 断网可用（实测 442ms 起引擎）。
 *
 * ② 语言包不能靠"把字节塞进 langs 参数"（`{code,data}`）—— 该版本 worker 里那条分支
 *    会导致 `initialization failed`（实测 4 种组合全败：gz/解压 × 单/双语言）。
 *    能用的只有两条：可访问的 langPath，或 tesseract 自己的缓存。我们选了后者（可校验）。
 *
 * ③ 缓存键 = `<cachePath>/<lang>.traineddata`，库 = `keyval-store` / 表 `keyval`，
 *    值是**解压后**的 traineddata（库代码：先按 gzip 魔数解压、再写缓存，所以写缓存也必须写解压后的）。
 * ========================================================================= */
'use strict';

(function () {
  const MSG = self.KH.MSG;

  /** 语言包本地缓存的键前缀（= tesseract 的 cachePath；改这里等于让旧缓存自动失效） */
  const CACHE_KEY = 'kh-ocr-lang-v1';
  const IDB_DB = 'keyval-store';
  const IDB_STORE = 'keyval';
  const MANIFEST_URL = 'vendor/tesseract/lang-manifest.json';
  /** 可选：完全离线时把 `<file>` 放进扩展目录的这里，引擎直接读本地文件（无需缓存） */
  const LOCAL_LANG_DIR = 'vendor/lang';

  /* ---- 主引擎（PP-OCR）的资产（S2）----
   * ORT 胶水 + wasm **随包**（MV3 的 `script-src 'self'` 禁远程脚本，而胶水就在 import 链上）；
   * 模型三件**运行时下载**（6.27MB，多数用户根本用不到），走站点 + 清单双闸（sha256 + bytes）。 */
  const ORT_GLUE_PATH = 'vendor/ort/ort.wasm.min.mjs';
  const ORT_DIR_PATH = 'vendor/ort/';
  const PPU_ENTRY_PATH = 'vendor/ppu-paddle-ocr/web/index.js';
  const MODEL_MANIFEST_URL = 'vendor/ppocr/models-manifest.json';
  /** 模型缓存键前缀：**清单里的 `cacheKey` 才是真源**，这只是清单读不到时的兜底（改这里等于换缓存） */
  const MODEL_CACHE_KEY = 'kh-ocr-model-v1';
  /** 主引擎冷启动（两个 session + 三份资产就位）给足时间：首次要下 6.27MB */
  const PPOCR_CREATE_TIMEOUT_MS = 180000;
  /** 识别引擎（#12）：`auto` 主引擎 + 会话内回落、`ppocr` 只用主引擎、`tesseract` 只用兼容引擎 */
  const ENGINE_PPOCR = 'ppocr';
  const ENGINE_TESSERACT = 'tesseract';
  const ENGINE_MODES = ['auto', ENGINE_PPOCR, ENGINE_TESSERACT];
  /** 识别前的最长边上限（表格截图通常 <1000px；再大只是白烧 CPU） */
  const MAX_EDGE = 1600;
  /** 空闲多久销毁引擎（worker 常驻约几十 MB，闲着就该还回去） */
  const IDLE_MS = 90000;
  /** 单个语言集合的建引擎超时 */
  const CREATE_TIMEOUT_MS = 90000;

  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

  /* ---------------- 小工具 ---------------- */

  function url(rel) { return chrome.runtime.getURL(rel); }

  function timeout(promise, ms, tag) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('超时：' + tag + '（' + ms + 'ms）')), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  async function sha256Hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function isGzip(bytes) { return bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------------- IndexedDB（tesseract 用的就是 idb-keyval：库名/表名固定） ---------------- */

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onerror = () => reject(req.error || new Error('打不开 IndexedDB'));
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function idbRun(mode, fn) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务中止')); };
    });
  }

  const cacheGetKey = (lang) => CACHE_KEY + '/' + lang + '.traineddata';
  const idbGet = (key) => idbRun('readonly', (st) => st.get(key));
  const idbPut = (key, val) => idbRun('readwrite', (st) => st.put(val, key));
  const idbDel = (key) => idbRun('readwrite', (st) => st.delete(key));

  /* ---------------- 语言包清单 ---------------- */

  let manifestPromise = null;
  function getManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch(url(MANIFEST_URL)).then((r) => {
        if (!r.ok) throw new Error('读不到语言包清单（HTTP ' + r.status + '）');
        return r.json();
      }).catch((e) => { manifestPromise = null; throw e; });
    }
    return manifestPromise;
  }

  /**
   * 兼容/兜底引擎（Tesseract）的语言包表。
   * 【S2 起档位取消（#12 裁决）】原来这里是 `packsOf(m, quality)` —— `fast` 走 `packs`、
   * `best` 走 `variants.best.packs`。现在清单里**只有快档两包**，"更准"由主引擎（PP-OCR）承担，
   * 所以整个档位维度（含缓存键后缀 `_std`、语言码后缀）一并删掉。
   * 用户可见的选择只剩 `imgOcr.engine`，而它选的是**引擎**，不是包。
   */
  function packsOf(m) { return (m && m.packs) || {}; }
  function packOf(m, lang) {
    const pack = packsOf(m)[lang];
    if (!pack) throw Object.assign(new Error('未知语言：' + lang), { code: 'lang-unknown' });
    return pack;
  }

  /** 关键词要哪些语言：含中日韩统一表意文字 → 中英双包；纯 ASCII → 只 eng（快一倍） */
  function langsForKeyword(text) {
    return CJK_RE.test(String(text == null ? '' : text)) ? ['chi_sim', 'eng'] : ['eng'];
  }

  /**
   * 实际可用的语言码：**清单里没有的包就丢掉它**。
   * 例：只下到中文包时，中文关键词仍可按 `chi_sim` 识别（标准模型对拉丁字母也够用），
   * 而不是因为缺 `eng` 整张图都识别不了。一个包都没有时给明确提示。
   */
  async function pickLangs(keyword) {
    const m = await getManifest();
    const packs = packsOf(m);
    const got = langsForKeyword(keyword).filter(function (code) { return !!packs[code]; });
    if (!got.length) {
      throw Object.assign(new Error('语言包未就绪（请到设置页 → 图片识别 → 兼容引擎语言包 里下载或手动导入）'),
        { code: 'lang-missing' });
    }
    return got;
  }

  /* ---------------- 语言包投递 ---------------- */

  /** 各语言的本地文件是否存在（可选路径；不存在不是错误） */
  async function hasLocalPack(file) {
    try {
      const r = await fetch(url(LOCAL_LANG_DIR + '/' + file), { cache: 'no-store' });
      return !!r.ok;
    } catch (e) { return false; }
  }

  /**
   * 保证某语言"引擎读得到"：
   *   ① 本地缓存里已有解压后的数据 → 直接可用（tesseract 会读缓存）
   *   ② 扩展目录里放了本地包 → 也直接可用（langPath 指向那里）
   *   ③ 都没有 → 报 `lang-missing`（**绝不偷偷上网**；用户去设置页下载或手动导入）
   */
  async function ensureLang(lang) {
    const m = await getManifest();
    const pack = packOf(m, lang);
    const cached = await idbGet(cacheGetKey(lang));
    if (cached && cached.length) return { lang: lang, source: 'cache', bytes: cached.length };
    if (await hasLocalPack(pack.file)) return { lang: lang, source: 'local', bytes: pack.bytes };
    throw Object.assign(new Error('语言包未就绪：' + (pack.label || lang)), { code: 'lang-missing', lang: lang });
  }

  /**
   * 运行时下载：自己 fetch → sha256 校验 → 解压 → 写缓存。
   * 只有**用户主动点「下载」**或首次识别缺包且用户已同意时才会走到这里；
   * 校验不通过一律不落盘（宁可报错也不把坏包喂给引擎）。
   */
  async function downloadLang(lang, opts) {
    const m = await getManifest();
    const pack = packOf(m, lang);
    const src = String((opts && opts.base) || m._base).replace(/\/$/, '') + '/' + pack.file;
    emitProgress({ job: 'lang', lang: lang, phase: 'download', url: src });
    const res = await fetch(src + (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error('下载失败（HTTP ' + res.status + '）'), { code: 'download-failed' });
    const gzBytes = new Uint8Array(await res.arrayBuffer());
    emitProgress({ job: 'lang', lang: lang, phase: 'verify', bytes: gzBytes.length });
    const sha = await sha256Hex(gzBytes);
    if (pack.sha256 && sha !== String(pack.sha256).toUpperCase()) {
      throw Object.assign(new Error('语言包校验不一致（可能被截断或篡改），已丢弃'), {
        code: 'sha-mismatch', expect: pack.sha256, got: sha
      });
    }
    const plain = isGzip(gzBytes) ? await gunzip(gzBytes) : gzBytes;
    emitProgress({ job: 'lang', lang: lang, phase: 'store', bytes: plain.length });
    await idbPut(cacheGetKey(lang), plain);
    emitProgress({ job: 'lang', lang: lang, phase: 'done', bytes: plain.length });
    return { lang: lang, bytes: plain.length, gzBytes: gzBytes.length, sha256: sha, verified: true };
  }

  /** 手动导入（完全离线）：用户挑了本地文件 → 校验（能对上就用官方 sha256 标注）→ 写缓存 */
  async function importLang(lang, base64, opts) {
    const m = await getManifest();
    const pack = packOf(m, lang);
    const bin = atob(String(base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw Object.assign(new Error('文件是空的'), { code: 'import-empty' });
    const sha = await sha256Hex(bytes);
    const official = !!pack.sha256 && sha === String(pack.sha256).toUpperCase();
    const plain = isGzip(bytes) ? await gunzip(bytes) : bytes;
    await idbPut(cacheGetKey(lang), plain);
    return {
      lang: lang, bytes: plain.length, gzBytes: bytes.length, sha256: sha,
      official: official, name: (opts && opts.name) || pack.file
    };
  }

  async function clearLangs(langs) {
    const m = await getManifest();
    const list = (langs && langs.length) ? langs : Object.keys(packsOf(m));
    for (const l of list) await idbDel(cacheGetKey(l));
    return { cleared: list };
  }

  /** 语言包状态（设置页展示用；顺带告诉它本地目录里有没有可用的离线包） */
  async function langState() {
    const m = await getManifest();
    const packs = packsOf(m);
    const out = { cacheKey: CACHE_KEY, base: m._base, available: Object.keys(packs).length > 0, langs: {} };
    for (const lang of Object.keys(packs)) {
      const pack = packs[lang];
      const cached = await idbGet(cacheGetKey(lang));
      out.langs[lang] = {
        label: pack.label || lang,
        file: pack.file,
        fileBytes: pack.bytes,
        sha256: pack.sha256,
        cached: !!(cached && cached.length),
        cachedBytes: (cached && cached.length) || 0,
        local: await hasLocalPack(pack.file)
      };
    }
    return out;
  }

  /* ---------------- 引擎（worker）生命周期 ---------------- */

  let engine = null;          // { key, worker, langs, timer }
  let creating = null;        // 建引擎中的 promise（并发请求共用一次创建）

  function corePathOf() {
    /* 只用 simd+lstm 版：minimum_chrome_version 105 起 SIMD 必然可用，
     * 少带一份 3.8MB 的非 SIMD 内核（体积换确定性）。 */
    return url('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js');
  }

  function touchEngine() {
    if (!engine) return;
    clearTimeout(engine.timer);
    engine.timer = setTimeout(() => { destroyEngine(); }, IDLE_MS);
  }

  /* 批次九死代码扫描：原签名 `destroyEngine(why)` 的 `why` 在函数体里从未出现（3 个调用点
   * 传的 'idle'/'switch'/'lang-cleared' 也没人读）—— 按死参数清理，签名与调用点一并去掉形参。
   * 若将来要查"引擎为什么被销毁"，再把理由接进日志即可。 */
  async function destroyEngine() {
    if (!engine) return;
    const e = engine;
    engine = null;
    clearTimeout(e.timer);
    try { await e.worker.terminate(); } catch (err) { /* 销毁失败无所谓 */ }
  }

  async function getEngine(langs) {
    const key = langs.slice().sort().join('+');
    if (engine && engine.key === key) { touchEngine(); return engine.worker; }
    if (engine) await destroyEngine();
    if (creating) await creating.catch(() => {});
    if (engine && engine.key === key) { touchEngine(); return engine.worker; }

    creating = (async () => {
      for (const l of langs) await ensureLang(l);
      const worker = await timeout(Tesseract.createWorker(langs, 1, {
        workerPath: url('vendor/tesseract/worker.min.js'),
        corePath: corePathOf(),
        /* ★ 关键：不给 blob（MV3 扩展页 CSP 会拦 blob: worker），并且 langPath 固定为
         *   扩展内本地目录 —— 永远不让它有机会自己去 CDN 拉包。 */
        workerBlobURL: false,
        langPath: url(LOCAL_LANG_DIR),
        cachePath: CACHE_KEY,
        gzip: true
      }), CREATE_TIMEOUT_MS, '建立 OCR 引擎');
      engine = { key: key, worker: worker, langs: langs.slice(), timer: null };
      touchEngine();
      return worker;
    })();
    try {
      return await creating;
    } finally {
      creating = null;
    }
  }

  /* ---------------- 主引擎：PP-OCR（onnxruntime-web WASM 单线程 + ppu-paddle-ocr） ----------------
   * 【为什么这么接（两条都是真机踩出来的，详见 decision-12）】
   *  ① `ort.env.wasm.wasmPaths` 必须在 `import('ppu-paddle-ocr/web')` **之前**赋值：ppu 的
   *     `web/platform.web.js` 在模块顶层就调 `applyDefaultWasmPaths()`，它一旦先跑，wasmPaths
   *     就被钉死在 jsDelivr —— MV3 的 CSP 下取不到，引擎直接起不来。所以两个都用动态 import。
   *  ② `processing.engine` 必须显式 `'canvas-native'`：默认 `'opencv'` 要外部 cv.js（我们没有）。
   *  ③ **不用上游默认模型地址**（那是指向 Hugging Face 的 `.ort`）：我们从自己的站点取 `.onnx`，
   *     下完先卡 sha256 + 字节数再落 IndexedDB ⇒ 断网可用、也不会有"悄悄出网拉第三方"这种事。 */

  /**
   * 动态 import 的**间接层**：真机就是原生 import；单测用 `self.__khOcrImport` 注入假引擎
   * （否则"引擎建不起来要回落"这类分支根本没法在 node 里测）。与 `self.__khOcrPure` 同样
   * 只做诊断/回归用途，不参与业务逻辑。
   */
  function dynImport(spec) {
    const f = self.__khOcrImport;
    return f ? Promise.resolve(f(spec)) : import(spec);
  }

  let ortPromise = null;
  function getOrt() {
    if (!ortPromise) {
      ortPromise = (async () => {
        const mod = await dynImport(url(ORT_GLUE_PATH));
        /* ★ 顺序不能变：先把 env 配好，再去让 ppu import 它 */
        mod.env.wasm.wasmPaths = url(ORT_DIR_PATH);
        mod.env.wasm.numThreads = 1;        // MV3 无交叉源隔离 ⇒ 本来就只能单线程，显式钉死
        mod.env.logLevel = 'error';
        return mod;
      })().catch((e) => { ortPromise = null; throw e; });
    }
    return ortPromise;
  }

  let modelManifestPromise = null;
  function getModelManifest() {
    if (!modelManifestPromise) {
      modelManifestPromise = fetch(url(MODEL_MANIFEST_URL)).then((r) => {
        if (!r.ok) throw new Error('读不到模型清单（HTTP ' + r.status + '）');
        return r.json();
      }).catch((e) => { modelManifestPromise = null; throw e; });
    }
    return modelManifestPromise;
  }

  const modelCacheKeyOf = (cacheKey, file) => cacheKey + '/' + file;
  /** `_loadResource` 认 `ArrayBuffer` 才当"已给数据"，所以要**切出正好那一截**（IDB 里可能是视图） */
  function toArrayBuffer(bytes) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  /**
   * 让三件模型"引擎读得到"：缓存优先；缺件才从站点下载，并**过双闸**（sha256 + 字节数）再落盘。
   * 校验不过一律不落盘 —— 宁可报错，也不把坏模型喂给 ONNX Runtime（那边的报错信息毫无可读性）。
   */
  async function ensureModels() {
    const m = await getModelManifest();
    const cacheKey = String(m.cacheKey || MODEL_CACHE_KEY);
    const entries = Object.keys(m.files || {}).map((k) => ({ slot: k, meta: m.files[k] }));
    if (!entries.length) throw Object.assign(new Error('模型清单是空的'), { code: 'asset-missing' });
    const base = String(m._base || '').replace(/\/$/, '');
    const out = {};
    for (const e of entries) {
      const key = modelCacheKeyOf(cacheKey, e.meta.file);
      let bytes = await idbGet(key);
      if (!bytes || !bytes.length) {
        if (!base) throw Object.assign(new Error('模型清单没有 _base，取不到：' + e.meta.file), { code: 'asset-missing', file: e.meta.file });
        emitProgress({ job: 'model', file: e.meta.file, phase: 'download', bytes: e.meta.bytes });
        const res = await fetch(base + '/' + e.meta.file, { cache: 'no-store' });
        if (!res.ok) throw Object.assign(new Error('模型下载失败（HTTP ' + res.status + '）：' + e.meta.file), { code: 'asset-missing', file: e.meta.file });
        bytes = new Uint8Array(await res.arrayBuffer());
        emitProgress({ job: 'model', file: e.meta.file, phase: 'verify', bytes: bytes.length });
        const sha = await sha256Hex(bytes);
        if (e.meta.sha256 && sha !== String(e.meta.sha256).toUpperCase()) {
          throw Object.assign(new Error('模型校验不一致，已丢弃：' + e.meta.file),
            { code: 'sha-mismatch', file: e.meta.file, expect: e.meta.sha256, got: sha });
        }
        if (e.meta.bytes && bytes.length !== Number(e.meta.bytes)) {
          throw Object.assign(new Error('模型字节数不对，已丢弃：' + e.meta.file),
            { code: 'sha-mismatch', file: e.meta.file, expect: e.meta.bytes, got: bytes.length });
        }
        emitProgress({ job: 'model', file: e.meta.file, phase: 'store', bytes: bytes.length });
        await idbPut(key, bytes);
        emitProgress({ job: 'model', file: e.meta.file, phase: 'done', bytes: bytes.length });
      }
      out[e.slot] = toArrayBuffer(bytes);
    }
    return { slots: out, count: entries.length, cacheKey: cacheKey, base: base };
  }

  /* ---- 模型资产：设置页那四条（状态 / 下载 / 导入 / 清除）----
   * 为什么 state 与 clear 是**整组**语义：det 找框、rec 认字、dict 是字符集，少一件识别不出东西，
   * 所以"半套模型"没有意义；只有导入按件（三件 6.27MB，用户可能分几次拿到文件）。 */

  /** 三件模型的缓存状态（只读，不下载任何东西） */
  async function modelState() {
    const m = await getModelManifest();
    const cacheKey = String(m.cacheKey || MODEL_CACHE_KEY);
    const entries = Object.keys(m.files || {}).map((k) => ({ slot: k, meta: m.files[k] }));
    const out = { cacheKey: cacheKey, base: m._base, available: entries.length > 0, files: {}, cachedBytes: 0, totalBytes: 0 };
    for (const e of entries) {
      const got = await idbGet(modelCacheKeyOf(cacheKey, e.meta.file));
      const n = (got && got.length) || 0;
      out.cachedBytes += n;
      out.totalBytes += Number(e.meta.bytes || 0);
      out.files[e.slot] = {
        label: e.meta.label || e.slot, file: e.meta.file,
        bytes: e.meta.bytes, sha256: e.meta.sha256,
        cached: n > 0, cachedBytes: n
      };
    }
    return out;
  }

  /** 下载三件（`force` = 先清缓存再下）。逐件卡 sha256 + 字节数，任何一件不过就整组失败、不写半套。 */
  async function downloadModels(force) {
    const m = await getModelManifest();
    const cacheKey = String(m.cacheKey || MODEL_CACHE_KEY);
    if (force) {
      for (const k of Object.keys(m.files || {})) await idbDel(modelCacheKeyOf(cacheKey, m.files[k].file));
    }
    const got = await ensureModels();
    return { cacheKey: got.cacheKey, files: got.count, verified: true };
  }

  /**
   * 手动导入**一件**（完全离线）：用户挑本地文件 → 与清单比对 sha256 → 落缓存。
   * 对不上官方 sha256 也允许存（用户可能拿的是同版本的另一种构建），但**如实标注** `official:false`，
   * 让设置页把话说清楚 —— 不许把"没校验过"说成"官方件"。
   */
  async function importModel(slot, base64, opts) {
    const m = await getModelManifest();
    const cacheKey = String(m.cacheKey || MODEL_CACHE_KEY);
    const meta = (m.files || {})[slot];
    if (!meta) throw Object.assign(new Error('未知的模型件：' + slot), { code: 'model-unknown' });
    const bin = atob(String(base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw Object.assign(new Error('文件是空的'), { code: 'import-empty' });
    const sha = await sha256Hex(bytes);
    const official = !!meta.sha256 && sha === String(meta.sha256).toUpperCase();
    await idbPut(modelCacheKeyOf(cacheKey, meta.file), bytes);
    return {
      slot: slot, file: meta.file, bytes: bytes.length, sha256: sha,
      official: official, name: (opts && opts.name) || meta.file
    };
  }

  /** 清模型缓存（整组或指定几件）。清完把主引擎也销毁 —— 它手里正握着旧的 session。 */
  async function clearModels(slots) {
    const m = await getModelManifest();
    const cacheKey = String(m.cacheKey || MODEL_CACHE_KEY);
    const want = (slots && slots.length) ? slots : Object.keys(m.files || {});
    const cleared = [];
    for (const s of want) {
      const meta = (m.files || {})[s];
      if (!meta) continue;
      await idbDel(modelCacheKeyOf(cacheKey, meta.file));
      cleared.push(s);
    }
    if (cleared.length) await destroyPpocr();
    return { cleared: cleared };
  }

  let ppocr = null;            // { svc, timer }
  let ppocrCreating = null;    // 建引擎中的 promise（并发请求共用一次创建）

  /**
   * 会话级的引擎状态（#12 §3：回落**按会话持久化**，首次主动告知、绝不静默）。
   * 存在这里就够 —— offscreen 文档的生命周期就是这个"会话"；它被杀之后重新建，
   * 那时重新试主引擎也是对的（可能只是刚才那次网络不好）。
   */
  const session = { engine: '', reason: '' };

  function touchPpocr() {
    if (!ppocr) return;
    clearTimeout(ppocr.timer);
    ppocr.timer = setTimeout(() => { destroyPpocr(); }, IDLE_MS);
  }

  async function destroyPpocr() {
    if (!ppocr) return;
    const e = ppocr;
    ppocr = null;
    clearTimeout(e.timer);
    try { await e.svc.destroy(); } catch (err) { /* 销毁失败无所谓 */ }
  }

  async function getPpocr() {
    if (ppocr) { touchPpocr(); return ppocr.svc; }
    if (ppocrCreating) return ppocrCreating;
    ppocrCreating = (async () => {
      try {
        await getOrt();                                  // ① 先配 env（顺序见上面两条坑）
        const got = await ensureModels();                // ② 三件模型就位（缓存优先，缺件才下）
        const mod = await dynImport(url(PPU_ENTRY_PATH)); // ③ 这时才轮到 ppu 去 import ORT
        const svc = new mod.PaddleOcrService({
          model: {
            detection: got.slots.detection,
            recognition: got.slots.recognition,
            charactersDictionary: got.slots.dictionary
          },
          session: { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
          /* 【用户裁决（2026-10-06）：质量优先】`mainThreadYieldMs` 只影响"让不让出主线程"，
           * 不改变任何数学结果 ⇒ 纯速度旋钮、零质量风险（PoC 里把 init 从 187ms 降到 41.7ms 的
           * 就是这个变体）。 */
          recognition: { mainThreadYieldMs: 10 },
          processing: { engine: 'canvas-native' },
          debugging: { verbose: false, debug: false }
        });
        await timeout(svc.initialize(), PPOCR_CREATE_TIMEOUT_MS, '建立 PP-OCR 引擎');
        ppocr = { svc: svc, timer: null };
        touchPpocr();
        return svc;
      } finally {
        ppocrCreating = null;
      }
    })();
    return ppocrCreating;
  }

  /**
   * 决定这条 job 用哪个引擎（#12 §3 的回落顺序：`ppocr` → `tesseract(fast)` → 不可用）。
   * 返回 `{ kind, reason }`（`reason` 非空 = 已回落）；`ppocr` 模式下建不起来则返回 `{ fail }`
   * —— **如实报错，不偷偷退回**（那一档就是给排障用的）。
   * 会话里已经回落过就不再重试主引擎：否则以后每张图都要白等一次失败。
   */
  async function chooseEngine(want) {
    const mode = ENGINE_MODES.indexOf(want) >= 0 ? want : '';
    if (!mode) return { fail: { code: 'missing-engine', engine: null, engineReason: 'missing-engine' } };
    if (mode === ENGINE_TESSERACT || (mode === 'auto' && session.engine === ENGINE_TESSERACT)) {
      return { kind: ENGINE_TESSERACT, reason: mode === ENGINE_TESSERACT ? '' : session.reason };
    }
    try {
      await getPpocr();
      session.engine = ENGINE_PPOCR;
      session.reason = '';
      return { kind: ENGINE_PPOCR, reason: '' };
    } catch (e) {
      const reason = (e && e.code) || 'init-failed';
      if (mode === ENGINE_PPOCR) {
        return { fail: {
          code: 'engine-unavailable', engine: ENGINE_PPOCR, engineReason: reason,
          error: String((e && e.message) || e)
        } };
      }
      session.engine = ENGINE_TESSERACT;
      session.reason = reason;
      return { kind: ENGINE_TESSERACT, reason: reason };
    }
  }

  /**
   * PP-OCR 的结果 → 我们的行结构 `{t, conf, y, x}`。
   * 上游形状：`res.lines` 是「行 → 词条数组」，词条 `{text, confidence, box:{x,y,width,height}}`，
   * 坐标在**我们传进去那张画布**的像素空间里（含白边）—— 所以还原公式与 tesseract 那条完全一致。
   * 【置信度必须 ×100】上游是 0–1，而我们全链路（`keepLine` 的 55 分线、`needsRotation` 的 70 分线、
   * 面板显示）都用 0–100 —— 不换算的话每一行都会被当成"低置信度"丢掉。
   */
  function linesFromPpocr(res, chunk, pre) {
    const arr = (res && res.lines) || [];
    const out = [];
    const sc = (pre && pre.scale) || 1;
    const mg = (pre && pre.margin) || 0;
    const inv = (v) => (v === Infinity ? 0 : v);
    for (const items of arr) {
      if (!items || !items.length) continue;
      let y = Infinity, x = Infinity, sum = 0, n = 0;
      const parts = [];
      for (const it of items) {
        const box = (it && it.box) || {};
        if (typeof box.y === 'number' && box.y < y) y = box.y;
        if (typeof box.x === 'number' && box.x < x) x = box.x;
        sum += Number((it && it.confidence) || 0);
        n += 1;
        const t = String((it && it.text) || '').replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      const text = parts.join(' ').trim();
      if (!text) continue;
      out.push({
        t: text,
        conf: n ? Math.round((sum / n) * 100) : 0,
        y: (chunk ? chunk.y : 0) + Math.max(0, Math.round((inv(y) - mg) / sc)),
        x: (chunk ? chunk.x : 0) + Math.max(0, Math.round((inv(x) - mg) / sc))
      });
    }
    return out;
  }

  /* ---------------- 图片 → 可识别输入 ---------------- */

  /** 小图放大目标高度（tesseract 对 x-height 很敏感：截图越小越认不出） */
  const TARGET_H = 96;
  const MAX_SCALE = 4;

  /* ---------------- 长图分块与方向：参数与**纯判决层**（S1-c；口径见 D-14） ----------------
   * 【为什么不再"先缩后切"】旧路径把整张长图先降采样到 MAX_EDGE=1600（1080×8000 → 216×1600），
   * 再按**缩后高度**切 4 条 —— 正文小字在降采样那一步就没了，后面的 `keepLine` 把它们全部滤掉，
   * 于是回执是"识别成功、0 行"。**表现成"未命中"，不是报错**。
   * 现在的口径：**按原图切块、块内 1:1**。块高 1600 时不做任何缩放，20px 的字进去还是 20px。
   * 下面这些全是**纯函数**（喂尺寸/统计出结论，不碰引擎、画布、时钟），
   * 通过 `self.__khOcrPure` 暴露给测试：判决逻辑与像素处理分开，才好钉住。
   */
  /** 块高（原图坐标）：≤1600 时块内 1:1，所以这个数直接决定"小字保不保得住" */
  const CHUNK_H = 1600;
  /** 块间重叠：≈6 行（40px 行距），足够渡过被切断的整行 */
  const CHUNK_OVERLAP = 240;
  const MIN_OVERLAP = 128;
  /** 块数上限；超了先把块高放宽到 2000 重算，仍超才截断（且**必须如实告知**） */
  const CHUNK_MAX = 8;
  const CHUNK_H_RELAXED = 2000;
  /** PSM 6 = 统一文本块（版式规整的一段正文），PSM 7 = 单行（表格里的一行值） */
  const PSM_BLOCK = '6';
  const PSM_SINGLE = '7';
  /** 试转顺序（D-14.3）：180 最常见，其次 270，最后 90 */
  const ROT_ORDER = [180, 270, 90];

  /** 块间重叠长度：块高的 15%，但在 [MIN_OVERLAP, CHUNK_OVERLAP] 之间夹住 */
  function overlapFor(chunkH) {
    const byRatio = Math.round(chunkH * 0.15);
    return Math.max(MIN_OVERLAP, Math.min(CHUNK_OVERLAP, byRatio));
  }

  /** 单块缩放系数：**块高 ≤1600 ⇒ 1:1 不缩**；块高 1600–2000 时最多缩到 0.8（MAX_EDGE 硬顶） */
  function scaleFor(w, h) {
    const W = Math.max(1, Math.round(w || 0));
    const Hh = Math.max(1, Math.round(h || 0));
    const max = Math.max(W, Hh);
    if (max > MAX_EDGE) return MAX_EDGE / max;
    if (Hh < TARGET_H) return Math.min(MAX_SCALE, TARGET_H / Hh);
    return 1;
  }

  /** 沿**长边**切块：竖图切横带、横图切竖带（否则 8000×1080 那种图压根切不动） */
  function layoutChunks(w, h, chunkH) {
    const overlap = overlapFor(chunkH);
    const step = Math.max(1, chunkH - overlap);
    const vertical = h >= w;
    const span = vertical ? h : w;
    const out = [];
    for (let p = 0; p < span; p += step) {
      const len = Math.min(chunkH, span - p);
      if (len <= 0) break;
      out.push({
        x: vertical ? 0 : p, y: vertical ? p : 0,
        w: vertical ? w : len, h: vertical ? len : h,
        axis: vertical ? 'y' : 'x'
      });
      if (p + len >= span) break;
    }
    if (!out.length) out.push({ x: 0, y: 0, w: w, h: h, axis: vertical ? 'y' : 'x' });
    return out;
  }

  /**
   * 切块计划（纯函数）。超上限时**先放宽块高到 2000 重算**，仍超才截断，
   * 并在 `coverage` 里把"共几块 / 用了前几块 / 覆盖到原图哪一行 / 丢了几块"全都写上 ——
   * 面板要照这个如实告知（不许悄悄少读一半还说"未命中"）。
   */
  function planChunks(w, h, opt) {
    const W = Math.max(1, Math.round(w || 0));
    const H = Math.max(1, Math.round(h || 0));
    let chunkH = (opt && opt.chunkH) ? Math.round(opt.chunkH) : CHUNK_H;
    let all = layoutChunks(W, H, chunkH);
    let relaxed = false;
    if (all.length > CHUNK_MAX && chunkH < CHUNK_H_RELAXED) {
      chunkH = CHUNK_H_RELAXED;
      all = layoutChunks(W, H, chunkH);
      relaxed = true;
    }
    const truncated = all.length > CHUNK_MAX;
    const used = truncated ? all.slice(0, CHUNK_MAX) : all;
    const last = used[used.length - 1];
    return {
      w: W, h: H, chunkH: chunkH, overlap: overlapFor(chunkH),
      chunks: used,
      coverage: {
        totalH: H, totalChunks: all.length, usedChunks: used.length,
        coveredTo: last ? Math.min(H, last.y + last.h) : 0,
        truncated: truncated, relaxed: relaxed,
        droppedChunks: Math.max(0, all.length - used.length)
      }
    };
  }

  /**
   * 密排带之间的重叠：约 2 行（密排行距 ~20px），夹在 [24, MIN_OVERLAP]。
   * 比 `overlapFor` 的 128 下限小是有意的 —— 见 `bandPlan` 注释（重叠越大带越高，带里行越多 det 越容易丢）。
   */
  const denseBandOverlap = (base) => Math.max(24, Math.min(MIN_OVERLAP, Math.round(base * 0.32 / 8) * 8));

  /**
   * **密排切带计划**（纯函数，S3-⑥）：把图按横带切成 `n` 条（默认 `DENSE_BANDS`；**不沿长边** ——
   * 横图那样会被切成竖带、把每行从中间切断）。步进等分 `base = ceil(H/n)`、相邻重叠 2–3 行。
   * 返回形状与 `planChunks` 一致（`chunks` / `coverage` / `chunkH`），所以 `scanFrame` 与
   * `chosen.plan.coverage`（面板的"分几块"告知）都能直接用。
   *
   * 重叠为什么比海报那套小：`overlapFor` 的 128 下限是按 1600 高的海报条标定的；密排行距只有 ~20px，
   * 128 会把带高撑到半个图高。**带里行数越少，det 召回越稳**。
   * 为什么条数要**逐级加密**：109 上量到的是"这个形状在某个带高下能读到、换个带高就读不到"，
   * 900×600/24 行的常规字重图 —— 1 条（整图）✗、3 条（264 高）✗、4 条（198 高）✗、**5 条（160 高）✓**；
   * 同一张图的粗体版 3 条就能 ✓ ⇒ 与其猜一个"最优带高"，不如**从粗到细试两档**（见 `denseBandPlans`）。
   */
  function bandPlan(w, h, n) {
    const W = Math.max(1, Math.round(w || 0));
    const H = Math.max(1, Math.round(h || 0));
    const cnt = Math.max(2, Math.min(12, Math.round(n || DENSE_BANDS)));
    const base = Math.max(1, Math.ceil(H / cnt));        // 等分步进 ⇒ 正好 cnt 条
    const ov = denseBandOverlap(base);
    const out = [];
    for (let p = 0; p < H && out.length < cnt; p += base) {
      out.push({ x: 0, y: p, w: W, h: Math.min(H - p, base + ov), axis: 'y' });
    }
    const last = out[out.length - 1];
    return {
      w: W, h: H, chunkH: base, overlap: ov, axis: 'y', chunks: out,
      coverage: {
        totalH: H, totalChunks: out.length, usedChunks: out.length,
        coveredTo: last ? Math.min(H, last.y + last.h) : 0,
        truncated: false, relaxed: false, droppedChunks: 0
      }
    };
  }

  /**
   * **要试的切带档位**（纯函数，S3-⑥）：从粗到细两档（`DENSE_BANDS` → `DENSE_BANDS_FINE`）。
   * 接线处逐档扫、**一旦命中关键词就不试更细的**（命中就够，别烧时间）；粗档能成时只花粗档的钱。
   * 两档条数相同时只留一档（矮图：`ceil(H/3) == ceil(H/5)`，例如 H=10）。
   */
  function denseBandPlans(w, h) {
    const a = bandPlan(w, h, DENSE_BANDS);
    const b = bandPlan(w, h, DENSE_BANDS_FINE);
    return b.chunks.length > a.chunks.length ? [a, b] : [a];
  }

  /** 小角度纠偏的**候选角度**（拍屏/PPT 常见 2–8°；90 的倍数不在这里，那些走试转） */
  const TILT_CANDIDATES = [-8, -6, -4, -2, 2, 4, 6, 8];

  /**
   * 选小角度纠偏量（纯函数）。输入 = 每个候选角度的"行投影方差"，输出 = **要纠的角度**（0 = 不纠）。
   *   · 只在 |θ| ∈ (1.5°, 9°] 里挑（更大的交给试转那套 90/180/270）；
   *   · 必须**明显**优于 0°（≥8%）—— 把一张本来摆正的图转歪，比不转更糟；
   *   · 没有"行结构"的图（0° 方差本身就极低，例如整张是躺倒/竖排的）由调用方先挡掉（见 `estimateTilt`）。
   * 这里只负责**多给一个候选**，采用与否仍由 `judgeOrientation` 的"严格更优才采用"决定。
   */
  function pickTilt(cands) {
    const list = (cands || []).filter((c) => c && isFinite(c.deg) && isFinite(c.v));
    let zero = null, best = null;
    for (const c of list) {
      if (c.deg === 0) { zero = c.v; continue; }
      const a = Math.abs(c.deg);
      if (a <= 1.5 || a > 9) continue;
      if (!best || c.v > best.v) best = c;
    }
    if (!best) return 0;
    if (zero === null) return best.deg;
    return best.v >= zero * 1.08 ? best.deg : 0;
  }

  /**
   * 【S3-③ 采用闸】一个候选要被**采用**，光"行数更多"不够。
   * 真机事故（`_e2e/probe-s3-dense-diag.js`）：密排图首遍读空（conf 0、行 0），随后 270° 那遍给出
   * **5 行 conf 80 的全垃圾**，靠"行数多"被采用 ⇒ 面板显示一堆乱码。首遍读空时试转**最容易**产出
   * 这种"行多但全是垃圾"的帧。
   * 判据：被采用的候选 conf 必须 ≥ `ADOPT_MIN_CONF`。**依据（22 例真机）**：真正对的采用 conf 是
   * 92–100（rot90 92 / rot270 93 / rot180 98 / 小角度纠偏 99–100），而那次垃圾采用 conf 80
   * ⇒ 85 这条线正好分开它们。低于线就**不采用**：宁可如实报"没读到"（D-14.5 的告知字段会说），
   * 也不把乱码当识别结果喂给面板。
   */
  const ADOPT_MIN_CONF = 85;
  /**
   * 【S3-⑤ 密排重采倍数】首遍一个字都没读到 ⇒ 把同一帧按此倍数重采再扫（见 `scanFrame(0,false,k)`）。
   * **为什么是 3、而不是 2 或 4**（真机 + 代码算出来的，不是试出来的）：
   *   · det 把长边取 `clamp(0.75×长边, 960, 1920)`（`vendor/ppu-paddle-ocr/core/detection/box-geometry.js:1`），
   *     我们的重采**显式覆盖** `scaleFor` ⇒ 不撞 `MAX_EDGE=1600` 那道墙；
   *   · 密排样张（900×600 / 20px 行）：k=2 ⇒ det 长边 1350 ⇒ 行高 **30px**；900k ≥ 2560（k≥2.84）才顶到
   *     det 的 **1920 上限** ⇒ 行高 **42.7px**。**3 是"能拿到 det 最大分辨率"的最小倍数**，再大只是更糊；
   *   · 而糊要算账：109 上 30px 的模糊放大 0 框、26.7px 的**清晰**重画 9 框 ⇒ 尺寸不是唯一变量。
   * 所以这次把 2 → 3 是有依据的一步（S3：109 上 2× 没救回密排页）。
   */
  const DENSE_RESCALE = 3;
  /**
   * 【S3-⑥ 密排切带（E 方案）】把一页切成几条**横带**逐条识别。为什么必须有它（真机实测，109）：
   *   · 900×600 / 24 行 / 20px：首遍 det **0 框**；`DENSE_RESCALE` 3× 重采只出 **5 行且关键词那行仍丢**
   *     （109 的 22 例就是这一例不绿）；换成横带逐条识别 ⇒ **关键词命中**。
   *   · 切带为什么有用：det 的**行召回**在"一页 24 行小字"上只有 ~20%，切成几段后每遍十几行 ⇒ ~50%。
   *     这是**一次喂进去的行数**问题，不是像素高度问题 —— 所以放大（B）救不了、切带（E）能救。
   *   · 为什么分**两档**（3 条 → 5 条）：同一张图在某个带高下能读到、换个带高就读不到（109 实测
   *     常规字重那张：3 条 ✗、4 条 ✗、**5 条 ✓**；粗体那张 3 条就 ✓）⇒ 不猜"最优带高"，粗档先试、
   *     不中再加密（`denseBandPlans`，命中即停）。
   *   · 为什么是**横**带：`layoutChunks` 沿长边切（长图必须这样），但**横图**会被切成竖带 ⇒ 每行从中间
   *     切断，关键词正好断在边界上就永远读不出来（实测竖切 2 条：109 得 9 行、154 得 1 行）。
   *   · 代价：只在"已经读到一些行、却一个字都没命中"时触发（见 `runJob` 里的接线），正常图零成本。
   */
  const DENSE_BANDS = 3;
  const DENSE_BANDS_FINE = 5;
  /**
   * 选更该采用的候选（纯函数）。顺序＝① **关键词命中多者胜** ② 可信者（conf ≥ `ADOPT_MIN_CONF`）胜
   * ③ 保留行多者胜 ④ conf 高者胜。
   * 关键词排第一是实测逼出来的：154 上"2 条横带"候选有 **16 行**却恰好丢了关键词那行，而 3× 重采候选
   * 只有 **7 行**但命中 ⇒ **只看行数会挑错**，而本功能的目的就是找关键词。
   * `ha`/`hb` 由调用方用 `hitsOf` 算（本函数不碰关键词表，保持纯）。
   */
  function picksBetter(a, b, ha, hb) {
    const A = a || {}, B = b || {};
    const xa = Number(ha) || 0, xb = Number(hb) || 0;
    if (xa !== xb) return xa > xb;
    const ca = isCredible(A) ? 1 : 0, cb = isCredible(B) ? 1 : 0;
    if (ca !== cb) return ca > cb;
    const la = Number(A.lines) || 0, lb = Number(B.lines) || 0;
    if (la !== lb) return la > lb;
    return (Number(A.conf) || 0) > (Number(B.conf) || 0);
  }
  function isCredible(st, opt) {
    const o = opt || {};
    const min = Number(o.minConf == null ? ADOPT_MIN_CONF : o.minConf);
    return (Number((st || {}).conf) || 0) >= min;
  }

  /** 首遍之后要不要试转（D-14.3 的三条判据，任一成立即试） */
  function needsRotation(st) {
    const o = st || {};
    const conf = Number(o.conf) || 0;
    const lines = Number(o.lines) || 0;
    const rawLines = Number(o.rawLines) || 0;
    const text = String(o.text == null ? '' : o.text).trim();
    /* 【2026-10-06 · 换引擎后重新校准（S2-d 真机实测）】原来是 `conf < 70 && lines < 3`。
     * 那个 `lines < 3` 是**按 Tesseract 的失败形态**定的：tesseract 在倒置图上通常只给 1–2 行，
     * 于是"行少"能当触发条件。PP-OCR 不一样 —— 它在倒置图上会读出 **3 行 conf 59** 的"貌似合理"
     * 文本（真机样本：`lines 3 / rawLines 4 / conf 59`），旧条件因此**一次试转都不做**，
     * `rot180` 直接被判未命中（判据 2 要求 rot90/180/270 **100%**）。
     * 现在只按**置信度**触发：PP-OCR 正确方向 ≥98.8、错方向落在 58–67（`#19` A/B 实测），
     * 70 这条线正好把它们分开。代价有界 —— 只在 `conf < 70` 时多扫 2–3 遍，
     * 而 `conf < 70` 本身已经说明"这一遍不可信"，宁可多试一遍，也不要把倒置图当正常图报未命中。 */
    if (conf < 70) return true;
    if (text === '') return true;
    if (rawLines > 0 && lines < rawLines * 0.5) return true;
    return false;
  }

  /**
   * 额外试转几遍。**放宽条件必须与触发条件同源**（S1-c 真机修订，见 IMPL-LOG）：
   * 触发里"几乎没读到东西"就是 `conf<70 && lines<3` 与 `text===''` 这两条，所以放宽条件
   * 取同一档 `lines<3 || text===''` ⇒ 3 遍（共 4 遍）；常规情形 2 遍（共 3 遍）。
   *
   * 为什么不能只按"全空"放宽：横向躺倒的中文样张**常能读出 1–2 行乱码**（实测 20 行里留 1 行、
   * conf 66），按旧口径只试 180/270 —— **需要 90° 修正的样张就永远试不到 90**，实测表现是
   * `notice:'tilted'`，而那张图本来是好的。修正是**放宽**而不是改顺序：180→270→90 不变
   * （D-14.3），只是让 90 那一遍在"几乎没读到"时一定走到。
   */
  function rotationsFor(st) {
    const o = st || {};
    const conf = Number(o.conf) || 0;
    const text = String(o.text == null ? '' : o.text).trim();
    /* 【必须与 `needsRotation` 的**第一条**同源】放宽条件与触发条件取同一档：
     * `conf < 70`（或一个字都没读到）⇒ 试满 3 遍（共 4 遍），否则 2 遍（共 3 遍）。
     * 不同源就会重演 S1-c 与 S2-d 各踩过一次的同族事故 —— "需要 90° 修正"的图永远试不到 90。
     * 2026-10-06 换引擎后触发条件由 `conf<70 && lines<3` 改成只看 `conf<70`，这里同步跟着改。 */
    return (conf < 70 || text === '') ? ROT_ORDER.length : ROT_ORDER.length - 1;
  }

  /**
   * 试转判决（纯函数）。**只有严格更优才采用**：
   *   · 保留行数多者胜；
   *   · 行数相同 ⇒ conf 高者胜，但要高出 ≥1 分（同档识别的抖动就在 1 分内）；
   *   · 打平 ⇒ 用首遍，并标 `suspicious`（面板要说"方向可能不正，结果不可靠"）。
   */
  function judgeOrientation(cands) {
    const arr = (cands || []).map((c) => ({
      deg: Number(c && c.deg) || 0, lines: Number(c && c.lines) || 0, conf: Number(c && c.conf) || 0
    }));
    if (!arr.length) return { deg: 0, adopted: false, suspicious: false, candidates: arr, base: null };
    const base = arr[0];
    let best = base;
    let sawRival = false;
    for (let i = 1; i < arr.length; i++) {
      const c = arr[i];
      if (c.lines > best.lines) best = c;
      else if (c.lines === best.lines && c.conf >= best.conf + 1) best = c;
      if (c.lines > 0 && c.lines >= base.lines) sawRival = true;
    }
    const adopted = best !== base;
    return {
      deg: adopted ? best.deg : base.deg, adopted: adopted,
      suspicious: sawRival && !adopted, candidates: arr, base: base
    };
  }

  /**
   * 告知字段判决（纯函数，D-14.5）。返回 `null` 表示**允许**静默"未命中"
   * （唯一情形：读到了字、方向可信、确实没匹配上）。
   */
  function noticeOf(st) {
    const o = st || {};
    const lines = Number(o.lines) || 0;
    if (o.truncated) return 'truncated';          // 只读了前 8 块 → 先说要紧的（图没被读完）
    if (lines === 0) return 'no-text';            // rawLines>0 而 lines=0：字读出来了但全被丢掉
    if (o.suspicious) return 'tilted';
    const conf = Number(o.conf);
    if (isFinite(conf) && conf > 0 && conf < 50) return 'tilted';
    return null;
  }

  const PURE = {
    CHUNK_H: CHUNK_H, CHUNK_OVERLAP: CHUNK_OVERLAP, CHUNK_MAX: CHUNK_MAX,
    CHUNK_H_RELAXED: CHUNK_H_RELAXED, MIN_OVERLAP: MIN_OVERLAP, ROT_ORDER: ROT_ORDER.slice(),
    overlapFor: overlapFor, scaleFor: scaleFor, layoutChunks: layoutChunks, planChunks: planChunks,
    bandPlan: bandPlan, denseBandPlans: denseBandPlans, DENSE_BANDS: DENSE_BANDS,
    needsRotation: needsRotation, rotationsFor: rotationsFor,
    TILT_CANDIDATES: TILT_CANDIDATES.slice(), pickTilt: pickTilt,
    ADOPT_MIN_CONF: ADOPT_MIN_CONF, isCredible: isCredible,
    DENSE_RESCALE: DENSE_RESCALE, picksBetter: picksBetter,
    judgeOrientation: judgeOrientation, noticeOf: noticeOf
  };
  self.__khOcrPure = PURE;

  /** 直方图分位数（用于对比度拉伸；O(n) 累加，成本可忽略） */
  function percentileOf(hist, total, p) {
    let acc = 0;
    const want = total * p;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
    return 255;
  }

  async function bytesFromRequest(req) {
    if (req.dataUrl) {
      const res = await fetch(req.dataUrl);
      return { blob: await res.blob(), origin: 'data' };
    }
    if (req.src) {
      /* 扩展页有 <all_urls> 主机权限：跨域图片也能读（页面 canvas 会被跨域污染，这里不会）。
       * credentials 省略 = 不带用户 cookie，避免"顺手把登录态带给图片服务器"。 */
      const res = await fetch(req.src, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) throw Object.assign(new Error('图片读取失败（HTTP ' + res.status + '）'), { code: 'decode-failed' });
      return { blob: await res.blob(), origin: 'src' };
    }
    throw Object.assign(new Error('请求里没有图片'), { code: 'decode-failed' });
  }

  /**
   * 预处理：**裁剪（可选）+ 缩放 + 灰度化 + 对比度拉伸 + 深底反色 + 留白边**（K64）。
   *
   * 【为什么必须做】表格里的"值"基本都是 200~400px 宽的小截图，而 tesseract 对过小的字
   * （x-height 太小、JPEG 糊、彩色底）识别率会断崖式下降 —— 实测"彩色底 + 界面杂讯 + JPEG"那张
   * 直接认成乱码（置信度 40）。四步都是低风险且对正常图无害的：
   *   ① 过大缩、过小放大（`opts.scale` 可由分块器指定；块高 ≤1600 时指定 **1** = 原图 1:1）；
   *   ② 灰度化（彩色底/彩色字对二值化判断是干扰）；
   *   ③ 2%~98% 分位对比度拉伸（浅灰字/低对比度截图的主要救命手段）；
   *   ④ 整图偏暗（深底浅字）时反色 —— LSTM 模型是按"浅底深字"训练的；
   *   ⑤ 四周留一圈白边（紧贴边缘的文字会被切掉/误判）。
   * `opts.sx/sy/sw/sh` 是**源矩形**（分块用）：裁剪与缩放**一趟完成**，
   * 不落中间 PNG —— 长图 6 块能省 6 次编解码。
   */
  async function prepareBlob(blob, opts) {
    const o = opts || {};
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      throw Object.assign(new Error('这张图无法解码（可能不是图片或已失效）'), { code: 'decode-failed' });
    }
    const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(o.sx || 0)));
    const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(o.sy || 0)));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(o.sw || (bitmap.width - sx))));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(o.sh || (bitmap.height - sy))));
    const scale = o.scale ? o.scale : scaleFor(sw, sh);
    const cw = Math.max(1, Math.round(sw * scale));
    const ch = Math.max(1, Math.round(sh * scale));
    const margin = Math.max(8, Math.round(Math.max(cw, ch) * 0.02));
    const cv = new OffscreenCanvas(cw + margin * 2, ch + margin * 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, margin, margin, cw, ch);
    bitmap.close();

    const pre = { scale: Number(scale.toFixed(2)), gray: false, invert: false, span: 0 };
    try {
      /* 【S2-d (b) 主引擎这条路默认跳过预处理】`raw:true` 时直接从这里跳出去，落到下面那个
       * 已经存在的 catch（它本来就是"像素处理失败就用缩放后的原图"）⇒ 语义一致、改动最小。
       * 为什么可以跳：PP-OCR 自带检测+识别两段网络，PoC 里喂**原始像素**就拿到 conf 0.9987（值格小图）
       * 与 0.985（整页）；而这段预处理每张要跑 `getImageData`（900×600 ⇒ 2.16MB）+ 54 万像素 LUT
       * 循环 + `putImageData`。兼容引擎（Tesseract）仍走完整预处理 —— 那条路的引擎本来就吃它。
       * 真机上若发现低对比度图变差，把这个判断去掉即可（一行回退）。 */
      if (o.raw) throw Object.assign(new Error('raw-mode: 跳过预处理'), { __skip: true });
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = img.data;
      const hist = new Uint32Array(256);
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        d[i] = d[i + 1] = d[i + 2] = y;
        hist[y] += 1;
        sum += y;
      }
      const total = cv.width * cv.height;
      const mean = sum / total;
      const lo = percentileOf(hist, total, 0.02);
      const hi = percentileOf(hist, total, 0.98);
      const span = Math.max(1, hi - lo);
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        const o = Math.round(((v - lo) * 255) / span);
        lut[v] = o < 0 ? 0 : (o > 255 ? 255 : o);
      }
      for (let i = 0; i < d.length; i += 4) {
        const v = lut[d[i]];
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
      pre.gray = true;
      pre.span = hi - lo;
      if (mean < 110) {                                    // 深底浅字 → 反色
        const g2 = ctx.getImageData(0, 0, cv.width, cv.height);
        const dd = g2.data;
        for (let i = 0; i < dd.length; i += 4) { dd[i] = 255 - dd[i]; dd[i + 1] = 255 - dd[i + 1]; dd[i + 2] = 255 - dd[i + 2]; }
        ctx.putImageData(g2, 0, 0);
        pre.invert = true;
      }
    } catch (e) { /* 像素读不出来（极少见）→ 就用缩放后的原图 */ }

    /* 【省掉一次白做的 PNG 编码】`noBlob` 由**消费方**决定，不由引擎喜好决定：ppocr 路径在
     * `recognizeChunk` 里直接吃画布（`pre.canvas`）⇒ 这里的 `convertToBlob` 在 ppocr 下**产出的字节没人读**
     * （900×600 实测它是 prepareBlob 里最贵的一步）。兼容引擎走 `worker.recognize(blob)`，必须保留。
     * 注意与 `raw` 的区别：`raw` 是"连预处理一起跳过"（只作真机 A/B 用，默认不开）；
     * `noBlob` 只删掉**没人用的那一步**，预处理一字不少。 */
    const out = (o.raw || o.noBlob) ? null : await cv.convertToBlob({ type: 'image/png' });
    /* `singleLine` 用**源矩形高度**判断：表格里的一行值基本都 ≤40px 高（单块长图 ⇒ false） */
    return {
      blob: out, canvas: cv, w: cv.width, h: cv.height,
      scale: scale, scaled: scale !== 1, pre: pre,
      rect: { x: sx, y: sy, w: sw, h: sh }, margin: margin,
      singleLine: sh <= 40
    };
  }

  /**
   * 量出**原图**尺寸（只解码、不做任何处理）。
   *
   * 必须有这一步：切块与"块内 1:1"都建立在**原图坐标**上。旧路径拿"降采样后的画布尺寸"去切条，
   * 于是 1080×8000 先被缩成 216×1600 —— 正文小字在那一刻就没了，后面怎么切都救不回来。
   */
  async function measureBlob(blob) {
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      throw Object.assign(new Error('这张图无法解码（可能不是图片或已失效）'), { code: 'decode-failed' });
    }
    const w = bmp.width, h = bmp.height;
    bmp.close();
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  /* ---------------- 串行队列 ---------------- */

  const queue = [];
  let draining = false;

  function enqueue(job) {
    if (job.tabId != null) queue.push(job);
    else queue.unshift(job);          // 无标签页来源（设置页自检）优先
    drain();
  }

  function cancelForTab(tabId) {
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].tabId === tabId) { queue.splice(i, 1); n++; }
    }
    return n;
  }

  /**
   * 按 requestId 撤掉排队中的那一条（background 判超时时发 `OCR_CANCEL {requestId}`）。
   * 只能撤**还没开跑**的：已在跑的那条没有取消点（WASM 单线程），
   * 但它的结果回到 background 时路由已注销，会被安静丢掉 —— 不会再打扰用户，
   * 也不占内容脚本的额度（那边已按 token 归还）。
   */
  function cancelForRequest(requestId) {
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].requestId === requestId) { queue.splice(i, 1); n++; }
    }
    return n;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        await runJob(job);
      }
    } finally {
      draining = false;
    }
  }

  async function runJob(job) {
    const t0 = performance.now();
    let kind = '';
    let engineReason = '';
    const reply = (payload) => post(Object.assign({
      requestId: job.requestId, tabId: job.tabId, src: job.src, keyword: job.keyword
    }, payload));
    try {
      /* 引擎裁决（含会话内回落）。`engine` 由 background 注入（#16 D-16.1：这里是**消费者**），
       * 契约是「payload 必含 engine」—— 缺了就如实报 `missing-engine`，不做任何猜测。 */
      const plan = await chooseEngine(job.engine);
      if (plan.fail) { reply(Object.assign({ ok: false }, plan.fail)); return; }
      kind = plan.kind;
      engineReason = plan.reason;
      let langs = [];
      let worker = null;
      let ppocrSvc = null;
      if (kind === ENGINE_PPOCR) {
        ppocrSvc = await getPpocr();                      // 已在 chooseEngine 里建好 ⇒ 这里命中缓存
      } else {
        langs = await pickLangs(job.keyword);             // 兼容引擎才需要语言包（主引擎自带中英）
        worker = await getEngine(langs);
      }
      const got = await bytesFromRequest(job);
      /* **原图尺寸**，不是预处理后的画布尺寸：切块与"块内 1:1"都建立在原图坐标上 */
      const orig = await measureBlob(got.blob);
      const t1 = performance.now();
      /* PSM 只有 Tesseract 有（PP-OCR 是"检测给框 + 逐框识别"，没有这个旋钮） */
      const setPsm = async (psm) => {
        if (!worker) return;
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            user_defined_dpi: '300',
            preserve_interword_spaces: '1'
          });
        } catch (e) { /* 个别内核不支持某个参数：忽略，继续按默认跑 */ }
      };
      /* 【关键词在这里只用于**进度提示**】内容脚本那边的匹配可能带正则/大小写口径，
       * 这里的 `hits` 只服务"识别中 3/6，已命中 2 处"这句面板文案 —— 不是判定真源。 */
      const keys = String(job.keyword || '').split(/[,，、|]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const hitsOf = (lines) => {
        if (!keys.length) return 0;
        let n = 0;
        for (const l of lines) {
          const t = l.t.toLowerCase();
          for (const k of keys) { if (t.indexOf(k) >= 0) { n += 1; break; } }
        }
        return n;
      };
      /* 【按「行」过滤 + 按位置排序（K66）】整张海报丢给引擎时，照片与装饰图形会产生大量垃圾"行"
       * （用户看到的 `Tory` / `rr i` / `Ve` 就是这些）。tesseract 每条行都带**置信度与坐标**，
       * 于是这里做三件事，把面板里的文本收拾成"人能读的样子"：
       *   ① 丢掉置信度过低（<55）或"一半以上不是字/数字/字母"的行；
       *   ② 按 y 坐标排序（切条是分块识别的，顺序本来就是乱的）；
       *   ③ 相邻且文字相同的行去重（切条之间是重叠的，同一行会被识别两次）。 */
      const linesFrom = (res, chunk, pre) => {
        const arr = (res && res.data && res.data.lines) || [];
        const out = [];
        const sc = (pre && pre.scale) || 1;
        const mg = (pre && pre.margin) || 0;
        for (const ln of arr) {
          const t = String((ln && ln.text) || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          const bbox = (ln && ln.bbox) || {};
          /* 画布坐标（含白边、可能缩过）→ **原图坐标**：跨块的 y 才可比、去重才有效。
           * 旧代码把缩后坐标直接当原图坐标用，长图上"同一行"根本对不上（重叠去重因此形同虚设）。 */
          out.push({
            t: t, conf: (ln && ln.confidence) || 0,
            y: (chunk ? chunk.y : 0) + Math.round(((bbox.y0 || 0) - mg) / sc),
            x: (chunk ? chunk.x : 0) + Math.max(0, Math.round(((bbox.x0 || 0) - mg) / sc))
          });
        }
        return out;
      };
      /**
       * 识别**一块**：两种引擎在这里归一成同一种行结构 `{t, conf(0–100), y, x}`。
       * PSM 由调用方先设（只有 Tesseract 有那个旋钮）；这里只管把这一块的字节喂给当前引擎。
       */
      const recognizeChunk = async (pre, chunk) => {
        if (kind === ENGINE_PPOCR) {
          /* (a) 直接把**画布**交给引擎（PoC 就是这么喂的：`service.recognize(canvas)`）——
           * 省掉我们这边的 `convertToBlob` PNG 编码 + 引擎侧的再解码一次。 */
          const r = await timeout(ppocrSvc.recognize(pre.canvas || pre.blob, { noCache: true, flatten: false }), 120000, '识别');
          return linesFromPpocr(r, chunk, pre);
        }
        const r = await timeout(worker.recognize(pre.blob), 60000, '识别');
        return linesFrom(r, chunk, pre);
      };
      const keepLine = (l) => {
        if (l.conf < 55) return false;
        const chars = l.t.replace(/\s/g, '');
        if (chars.length < 2) return false;
        const wordish = (chars.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
        return wordish / chars.length >= 0.5;
      };
      const tidy = (all) => {
        const kept = all.filter(keepLine).sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const out = [];
        for (const l of kept) {
          const prev = out[out.length - 1];
          if (prev && prev.t === l.t && Math.abs(prev.y - l.y) < 18) continue;   // 切条重叠 → 同一行重复
          out.push(l);
        }
        return out;
      };
      /* ---- 帧（方向）与块：**全都按需惰性构造** —— 不试转，就一次多余的活都不干 ---- */
      const frames = new Map();        // deg -> {deg, blob, w, h, plan}
      const prepped = new Map();       // `${deg}:${块高}:${i}` -> prepareBlob 的结果

      /** 把整图转 deg 度（**只在试转真的发生时**才被调用） */
      async function rotateBlob(blob, w, h, deg) {
        const bmp = await createImageBitmap(blob);
        /* 【任意角度（S3-① 小角度纠偏要用）】外接矩形按 |cos|/|sin| 算；
         * 90 的整数倍自动退化成原来的 `swap ? h : w`。 */
        const rad = (deg * Math.PI) / 180;
        const cw = Math.ceil(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
        const ch = Math.ceil(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
        const cv = new OffscreenCanvas(Math.max(1, cw), Math.max(1, ch));
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.translate(cv.width / 2, cv.height / 2);
        ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(bmp, -w / 2, -h / 2);
        bmp.close();
        return { blob: await cv.convertToBlob({ type: 'image/png' }), w: cv.width, h: cv.height };
      }

      /** 把图按 deg 倾斜后**逐行求暗像素和**，返回行间方差（越"成行"越大）。O(w·h) */
      function rowVarOf(g, w, h, deg) {
        const t = Math.tan((deg * Math.PI) / 180);
        const sums = new Float64Array(h);
        for (let y = 0; y < h; y++) {
          let s = 0;
          for (let x = 0; x < w; x++) {
            const yy = (y + (x - w / 2) * t) | 0;
            if (yy >= 0 && yy < h) s += 255 - g[yy * w + x];
          }
          sums[y] = s;
        }
        let m = 0;
        for (let y = 0; y < h; y++) m += sums[y];
        m /= h;
        let v = 0;
        for (let y = 0; y < h; y++) { const q = sums[y] - m; v += q * q; }
        return v / h;
      }

      /**
       * 估小角度倾斜（S3-①）。整图缩到 ≤360px 宽，对 `TILT_CANDIDATES + 0°` 各算一次行投影方差。
       * 只在**需要试转**时才被调用（正常图零成本）。两道闸：
       *   ① 结构闸：0° 的方差太低（整幅没有"成行的字"，例如图是躺倒的）⇒ 直接弃权，交给试转；
       *   ② 相对闸：候选要明显优于 0°（≥8%），由纯函数 `pickTilt` 判。
       */
      async function estimateTilt(blob) {
        let bmp = null;
        try { bmp = await createImageBitmap(blob); } catch (e) { return 0; }
        const sc = Math.min(1, 360 / bmp.width);
        const w = Math.max(32, Math.round(bmp.width * sc));
        const h = Math.max(32, Math.round(bmp.height * sc));
        const cv = new OffscreenCanvas(w, h);
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const d = ctx.getImageData(0, 0, w, h).data;
        const g = new Uint8Array(w * h);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        const vars = [0].concat(TILT_CANDIDATES).map((deg) => ({ deg: deg, v: rowVarOf(g, w, h, deg) }));
        let zero = 0;
        for (const v of vars) if (v.deg === 0) zero = v.v;
        if (zero < 0.02 * h * 255 * 255) return 0;      // 结构闸
        return pickTilt(vars);
      }

      async function frameFor(deg) {
        const k = String(deg);
        if (frames.has(k)) return frames.get(k);
        let f;
        if (!deg) {
          /* 首帧直接用**原图 blob**（不先整图预处理）—— 每一块自己裁自己缩，块内 1:1 */
          f = { deg: 0, blob: got.blob, w: orig.w, h: orig.h };
        } else {
          const r = await rotateBlob(got.blob, orig.w, orig.h, deg);
          f = { deg: deg, blob: r.blob, w: r.w, h: r.h };
        }
        f.plan = planChunks(f.w, f.h);
        frames.set(k, f);
        return f;
      }

      /**
       * 取"某帧第 i 块"的识别输入：**裁剪与缩放一趟做完**（不落中间 PNG），
       * 块高 ≤1600 时 scale 由 `scaleFor` 判成 1 ⇒ 原图 1:1。
       * 缓存按 `${deg}:${i}` 存 —— 被采用的那一帧已经识别过的块，不会再为了"重头跑一遍"烧第二次。
       */
      async function chunkFor(f, i, k) {
        const kk = k && k !== 1 ? k : 1;
        /* 缓存键要带**块高**：密排切带用的是另一套 `chunks`（`bandPlan`），
         * 若仍按 `deg:i` 存，`bandPlan` 的第 0 块会撞上整图那次的第 0 块、喂错图。 */
        const key = f.deg + ':' + f.plan.chunkH + ':' + i + (kk !== 1 ? '@' + kk : '');
        if (prepped.has(key)) return prepped.get(key);
        const c = f.plan.chunks[i];
        /* 【质量优先：主引擎**也**走完整预处理】S2-d 实测"跳过预处理（灰度+2%–98% 拉伸+深底反色）"
         * 只省 23ms（3%），而用户 2026-10-06 明确裁决**质量优先**（尤其艺术字/低对比度图不能认不出）
         * ⇒ 这里不传 `raw`，两条引擎同一套预处理。`prepareBlob` 的 `raw` 开关保留着，
         * 仅供真机上做"同图 A/B 对照"（省 23ms 换来什么代价，要有实测才敢开）。 */
        /* `kk>1` = **密排放大**（S3-②）：同一块按 kk 倍重采一次；不传就照 `scaleFor` 的常规判断。
         * 显式给 `scale` 会覆盖 prepareBlob 内部的 scaleFor ⇒ 几何换算（`pre.scale`）照样自洽。 */
        const pre = await prepareBlob(f.blob, Object.assign(
          { sx: c.x, sy: c.y, sw: c.w, sh: c.h },
          kk !== 1 ? { scale: kk * scaleFor(c.w, c.h) } : null,
          /* ppocr 吃画布 ⇒ 别产出没人读的 PNG（tesseract 仍需 blob） */
          kind === ENGINE_PPOCR ? { noBlob: true } : null
        ));
        prepped.set(key, pre);
        return pre;
      }

      /**
       * 识别一帧（整图的一个方向）：逐块裁 + 预处理 + 识别。
       *
       * **PSM 6「统一文本块」而不是过去的 PSM 11「稀疏文本」**：块内 1:1 之后，每块就是版式规整的
       * 一段正文，6 才是对的假设（11 是为"文字散落各处"设计的，用在整块正文上会把表格读成垃圾）。
       * 同时**废止**了旧的"整图 conf<70 ⇒ 换 PSM 11 再跑一遍"——那是对**同一张不旋转的图**重跑，
       * 长图/转 180° 那种图白烧一倍时间，还是认不出来（D-14.3 明确删除）。
       * 每块识别完回一次 progress，面板才能说"识别中 3/6，已命中 2 处"。
       */
      async function scanFrame(deg, tell, k, plan) {
        const f0 = await frameFor(deg);
        /* `plan` = 换一套切块计划再扫这一帧（S3-⑥ 密排切带用 `bandPlan`）。
         * **不改进缓存里的帧**（`frames` 复用同一对象），否则切带那次会把整图计划顶掉。 */
        const f = plan ? Object.assign({}, f0, { plan: plan }) : f0;
        const chunks = f.plan.chunks;
        const lines = [];
        let rawLines = 0, confSum = 0, keptN = 0, passes = 0, psm = PSM_BLOCK, pre0 = null;
        for (let i = 0; i < chunks.length; i++) {
          const pre = await chunkFor(f, i, k);
          if (i === 0) { pre0 = pre; psm = (chunks.length === 1 && pre.singleLine) ? PSM_SINGLE : PSM_BLOCK; }
          await setPsm(psm);
          const raw = await recognizeChunk(pre, chunks[i]);
          passes += 1;
          rawLines += raw.length;
          const kept = raw.filter(keepLine);
          keptN += kept.length;
          for (const l of kept) confSum += l.conf;
          lines.push.apply(lines, raw);
          if (tell) {
            emitProgress({
              phase: 'band', requestId: job.requestId,
              index: i + 1, total: chunks.length, hits: hitsOf(kept)
            });
          }
        }
        return {
          deg: deg, lines: lines, plan: f.plan, passes: passes, psm: psm, pre0: pre0,
          stat: {
            conf: keptN ? Math.round(confSum / keptN) : 0,
            lines: keptN, rawLines: rawLines,
            text: lines.filter(keepLine).map((l) => l.t).join('\n')
          }
        };
      }

      /* ---- 首遍 0°（逐块报进度）+ 方向判决（D-14.3）---- */
      let base = await scanFrame(0, true);
      let orientation = {
        deg: 0, adopted: false, suspicious: false, tried: 0,
        candidates: [{ deg: 0, lines: base.stat.lines, conf: base.stat.conf }]
      };
      let chosen = base;
      /* 【S3-② 密排放大】诊断结论（`_e2e/probe-s3-dense-diag.js`，真机）：900×600 / 24 行 / 20px 的
       * 密排图，**检测阶段只出 6 个框、首遍 conf 0**；把同一份内容按 2× 分辨率画（40px/行）则
       * conf 98、文本基本正确 ⇒ 瓶颈是"每行在像素上的**绝对高度**"，不是版式、也不是模型容量。
       * 所以：**首遍一个字都没读到**时，把同一帧按 `DENSE_RESCALE` 倍重采再扫一遍；只有行数更多才采用
       * （与试转/纠偏同一个"严格更优"法则）⇒ 正常图零成本（`lines===0` 时才发生）。
       * 【S3-⑤】倍数由 2 提到 3：109 上 2× 救不回密排页（`probe-s3-dense-diag.js`：1× 0 框、
       * 2× 重采仍 0 行、清晰 2× 重画 9/24 行且关键词那行靠运气丢了）。3 是"顶到 det 1920 上限"的
       * 最小倍数（详见 `DENSE_RESCALE` 处推导）。 */
      if (base.stat.lines === 0) {
        try {
          const s2 = await scanFrame(0, false, DENSE_RESCALE);
          if (picksBetter(s2.stat, base.stat, hitsOf(s2.lines), hitsOf(base.lines))) { base = s2; chosen = s2; }
        } catch (e) { /* 放大失败就用原结果，不许拖垮首遍 */ }
      }
      /* 【S3-⑥ 密排切带（E 方案）】触发条件**故意很窄**，只覆盖实测到的那个形状：
       * "引擎读到了一些行、却一个字都没命中"（109 密排页＝4–5 行、conf 95、关键词全丢 —— 注意
       * conf 高**不能**当"读全了"的证据，`isCredible` 在这里救不了场）。再加两道闸：
       *   · `orig.h ≥ 400`：值格那种矮图（320×60）没必要切；
       *   · `usedChunks === 1 && !truncated`：**这一帧本来就是整块喂进去的**。长图已经按 1600 切块，
       *     再叠一层横带只会把块变大（4800 → 8000），越切越糟；而正常图（行都读到了）也不会
       *     进这个分支 ⇒ 代价只落在"小图密排读不动"这一类上。
       * 采用仍走 `picksBetter`（关键词命中优先）⇒ 154 那边 B 已经命中、根本不进这里，零回归。
       * 档位从粗到细（`denseBandPlans`）：**一旦命中关键词就停**（粗档能成只花粗档的钱；
       * 109 那张常规字重图要第 2 档（5 条）才命中，粗体那张第 1 档（3 条）就成）。 */
      if (orig.h >= 400 && base.stat.lines > 0 && hitsOf(base.lines) === 0
          && base.plan.coverage.usedChunks === 1 && !base.plan.coverage.truncated) {
        for (const plan of denseBandPlans(orig.w, orig.h)) {
          if (hitsOf(base.lines) > 0) break;              // 上一档已经命中 ⇒ 不再加密
          try {
            const s3 = await scanFrame(0, false, 1, plan);
            if (picksBetter(s3.stat, base.stat, hitsOf(s3.lines), hitsOf(base.lines))) { base = s3; chosen = s3; }
          } catch (e) { /* 切带失败就用原结果 */ }
        }
      }
      /* ⚠ 必须在 2× 重采**之后**再算：重采可能把 base 换掉（否则会在"已读空的旧 stat"上判试转）。 */
      const baseNeeds = needsRotation(base.stat);
      /* 【S3-① 补口（第二版，实测修正）】第一版用"行召回偏低"当预兆（`needsTiltProbe`）——**判不出来**：
       * 2° 那张检测到 7/8 行、conf 95，"保留 < 检测×0.8"不成立，纠偏依旧没跑（实测 7/12 不变）。
       * 结论：倾斜**没有**可靠的廉价预兆，那就**每次都估一次** —— 估计本身只要几毫秒（缩到 360px 宽
       * 的行投影），真正贵的"多扫一帧"只在估到非零角度时才发生；而且是否采用仍由 `judgeOrientation`
       * 的"严格更优"把关 ⇒ 摆在正处的图只多花 ~15ms，质量零风险（22 例实测 21 例逐字不变）。 */
      {
        const scans = { 0: base };
        const cands = orientation.candidates;
        if (baseNeeds) {
          const tries = rotationsFor(base.stat);          // 首遍全空 ⇒ 3 遍，否则 2 遍
          for (let i = 0; i < tries; i++) {
            const deg = ROT_ORDER[i];
            let s = null;
            try { s = await scanFrame(deg, false); } catch (e) { s = null; }   // 试转失败不拖垮首遍结果
            orientation.tried += 1;
            if (!s) continue;
            scans[deg] = s;
            cands.push({ deg: deg, lines: s.stat.lines, conf: s.stat.conf });
          }
        }
        /* 【S3-① 小角度纠偏】90/180/270 那三遍对"整幅歪 2–8°"的图是白跑（真机实测：歪 5° ⇒
         * conf 0、行 0/12、关键词全丢，而歪 2° 还有 58%）。这里**在既有判决之下**再加候选：
         * 估出倾斜角，按 ±角 各转一帧去识别（符号约定不靠推导、靠实测 —— 两个都试），
         * 采用与否仍由 `judgeOrientation`（保留行更多者胜、同数 conf 高 ≥1 分者胜）决定
         * ⇒ **对本来正常的图零副作用**。只在 `needsRotation` 已成立时才走这段，正常图不花这个钱。 */
        let tiltDeg = 0;
        try {
          const est = await estimateTilt(got.blob);
          if (est) {
            for (const d2 of [est, -est]) {
              const s2 = await scanFrame(d2, false);
              orientation.tried += 1;
              if (s2) { scans[d2] = s2; cands.push({ deg: d2, lines: s2.stat.lines, conf: s2.stat.conf }); }
            }
            tiltDeg = est;
          }
        } catch (e) { /* 估不出来就算了，不许拖垮首遍结果 */ }
        const verdict = judgeOrientation(cands);
        /* 【S3-③ 采用闸】"行数更多"之外还要求候选**可信**（conf ≥ 85，见 `isCredible`）。
         * 被否掉时不采用 ⇒ `chosen` 仍是首遍（哪怕它是空的），并标 `suspicious`
         * ⇒ D-14.5 的告知字段会如实说"方向可能不正/没读到"，而不是把乱码当结果喂给面板。 */
        const win = verdict.adopted && scans[verdict.deg] ? scans[verdict.deg] : null;
        /* 【S3-③ 采用闸（第二版：看本功能自己的真值）】第一版只卡 conf ≥85 —— **误伤真阳性**：
         * 22 例复跑时 `rot270` 那次的采用候选 conf 落在 80 被拦掉，关键词从"命中"变"漏"
         * （而那是真的认出来了：倒置图那行确实读对）。所以闸门改成：
         *   · 候选里**含关键词** ⇒ 一律放行（垃圾文本恰好含"一对一/供应商"的概率极低）；
         *   · 只有"低置信 **且** 一个字都没配上"才拦 —— 那正是密排图那次 5 行全乱码的情形。 */
        const winHits = win ? hitsOf(win.lines) : 0;
        const reject = !!(win && win.stat.lines > 0 && winHits === 0 && !isCredible(win.stat));
        orientation = {
          deg: reject ? 0 : verdict.deg,
          adopted: reject ? false : verdict.adopted,
          suspicious: reject ? true : verdict.suspicious,
          tried: orientation.tried, candidates: verdict.candidates,
          /* 估到的小角度倾斜（0 = 没估/弃权）。只作**观测**用：真正被采用的是 `deg`。 */
          tilt: tiltDeg,
          rejected: reject ? ('low-conf ' + win.stat.conf) : ''
        };
        if (!reject && win) chosen = win;
      }

      const finalLines = tidy(chosen.lines);
      const text = finalLines.map((l) => l.t).join('\n');
      const cov = chosen.plan.coverage;
      /* 告知字段（不变量 1/2，D-14.5）：`null` = 唯一允许静默"未命中"的情形 */
      const notice = noticeOf({
        lines: finalLines.length, rawLines: chosen.stat.rawLines,
        conf: chosen.stat.conf, truncated: cov.truncated, suspicious: orientation.suspicious
      });
      reply({
        ok: true,
        /* 【不变量 6】回执必须带**实际**用了哪个引擎 + 回落原因（`engineReason` 空 = 没回落）。
         * 这两个字段是"用户能不能知道自己被降级了"的唯一依据，background 原样透传。 */
        engine: kind,
        engineReason: engineReason,
        text: text,
        confidence: chosen.stat.conf,
        langs: langs,
        w: orig.w, h: orig.h,
        scaled: !!(chosen.pre0 && chosen.pre0.scaled),
        psm: chosen.psm, passes: chosen.passes,
        pre: (chosen.pre0 && chosen.pre0.pre) || {},
        bands: cov.usedChunks,
        lines: finalLines.length, rawLines: chosen.stat.rawLines,
        notice: notice, coverage: cov, orientation: orientation,
        queueMs: Math.round(t1 - t0), ocrMs: Math.round(performance.now() - t1),
        totalMs: Math.round(performance.now() - t0)
      });
    } catch (err) {
      reply({
        ok: false, code: (err && err.code) || 'ocr-failed',
        error: String((err && err.message) || err),
        engine: kind || null, engineReason: engineReason || ''
      });
    }
  }

  /* ---------------- 消息 ---------------- */

  function post(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: MSG.OCR_RESULT, to: 'background' }, payload));
    } catch (e) { /* 后台不在？下次再说 */ }
  }

  function emitProgress(p) {
    try { chrome.runtime.sendMessage(Object.assign({ type: MSG.OCR_PROGRESS, to: 'background' }, p)); } catch (e) { /* ignore */ }
  }

  /* 诊断钩子（真浏览器回归 / 排查用；不参与业务逻辑，读写都不会产生副作用） */
  self.__khOcrDebug = () => ({
    engine: engine ? { key: engine.key, langs: engine.langs } : null,
    creating: !!creating,
    queue: queue.length,
    draining: draining,
    langs: (engine && engine.langs) || [],
    /** 主引擎（PP-OCR）与会话级回落状态（S2）：`session.reason` 非空 = 本次会话已回落 */
    ppocr: !!ppocr,
    ppocrCreating: !!ppocrCreating,
    session: { engine: session.engine, reason: session.reason }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== 'offscreen') return false;
    const t0 = performance.now();

    /* 统一回执：既 post 给 background（它按 requestId 决定"兑现 promise"还是"送回标签页"），
     * 也 sendResponse（同一次 sendMessage 的直接回调）。
     * 【为什么必须 post】background 侧是用 `toOffscreen()` 转发 + `OCR_RESULT` 回执来兑现
     * RPC promise 的；只 sendResponse 的话，那个 promise 会一直等到超时 —— 实测踩过：
     * 语言包状态查询永远返回"OCR 引擎响应超时"。 */
    const settle = (promise, noPost) => {
      Promise.resolve(promise).then(
        (r) => {
          const payload = Object.assign({ ok: true, ms: Math.round(performance.now() - t0) }, r);
          if (!noPost) post(Object.assign({ requestId: msg.requestId, tabId: msg.tabId }, payload));
          try { sendResponse(payload); } catch (e) { /* 没有回调也能用 */ }
        },
        (err) => {
          const payload = {
            ok: false, code: (err && err.code) || 'error',
            error: String((err && err.message) || err), ms: Math.round(performance.now() - t0)
          };
          post(Object.assign({ requestId: msg.requestId, tabId: msg.tabId }, payload));
          try { sendResponse(payload); } catch (e) { /* ignore */ }
        }
      );
      return true;
    };

    if (msg.type === MSG.OCR_IMAGE) {
      enqueue({
        requestId: msg.requestId, tabId: msg.tabId,
        src: msg.src, dataUrl: msg.dataUrl, keyword: msg.keyword,
        /* 引擎由 background 注入（#16 D-16.1：内容脚本不传）。缺失时 `chooseEngine` 会如实回
         * `missing-engine` —— 我们**不猜**，猜错了就是"用户以为在用主引擎、其实一直在用兜底"。 */
        engine: msg.engine
      });
      /* 图片任务是"排进队列"：**不能**在这里 post 回执 —— background 收到回执就把它当成
       * 最终结果（并且把 requestId 的路由记录删掉），真正的识别结果随后到达时就无处可送了。
       * 所以这条只 sendResponse，最终结果由 runJob 单独 post。 */
      settle(Promise.resolve({ queued: queue.length + (draining ? 1 : 0) }), true);
      return true;
    }
    if (msg.type === MSG.OCR_CANCEL) {
      /* 【必须按字段分别撤】旧实现无条件调 `cancelForTab(msg.tabId)`：
       * background 判超时时只带 requestId（无 tabId）⇒ 比的是 `undefined`，
       * 而设置页自检的 job 正好**没有 tabId** ⇒ 会把自检那条误撤掉（潜在 bug，S1-b 一并修）。 */
      let cancelled = 0;
      if (msg.requestId) cancelled += cancelForRequest(msg.requestId);
      if (msg.tabId != null) cancelled += cancelForTab(msg.tabId);
      return settle(Promise.resolve({ cancelled: cancelled }));
    }
    /* 语言包只服务**兼容引擎**（主引擎自带中英能力，没有"包"这个维度）。
     * 老设置页仍会带 `quality` 字段过来 —— 一律忽略（档位在 S2 已被 `imgOcr.engine` 取代）。 */
    if (msg.type === MSG.OCR_LANG_STATE) return settle(langState().then((s) => ({ state: s, engine: engine ? engine.key : null })));
    if (msg.type === MSG.OCR_LANG_DOWNLOAD) return settle(downloadLang(msg.lang, { base: msg.base, force: msg.force }));
    if (msg.type === MSG.OCR_LANG_IMPORT) return settle(importLang(msg.lang, msg.base64, { name: msg.name }));
    if (msg.type === MSG.OCR_LANG_CLEAR) return settle(clearLangs(msg.langs).then((r) => { if (engine) destroyEngine(); return r; }));
    /* 主引擎的模型资产（S2-c）：四条与语言包那四条一一对应 */
    if (msg.type === MSG.OCR_MODEL_STATE) return settle(modelState());
    if (msg.type === MSG.OCR_MODEL_DOWNLOAD) return settle(downloadModels(msg.force));
    if (msg.type === MSG.OCR_MODEL_IMPORT) return settle(importModel(msg.slot, msg.base64, { name: msg.name }));
    if (msg.type === MSG.OCR_MODEL_CLEAR) return settle(clearModels(msg.slots));
    /* 设置页「自检」：跑一张内置小图，确认引擎真的能用（不依赖任何网页） */
    if (msg.type === 'kh:ocr:selftest') {
      enqueue({ requestId: msg.requestId, tabId: msg.tabId, keyword: msg.keyword || '供应商', dataUrl: msg.dataUrl });
      return settle(Promise.resolve({ queued: 1 }));
    }
    return false;
  });
})();
