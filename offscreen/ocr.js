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
   * 识别档位（K67）：`fast` = 现在用的 4.0.0_fast 小模型；`best` = 标准 LSTM 大模型（更准、更慢）。
   * 实现方式：给语言码加后缀（`chi_sim` → `chi_sim_std`）—— 于是**缓存键与 worker 语言码天然分开**，
   * 两档可以共存、切换不用重新下载；包由「设置页 → 图片识别」按当前档位下载或手动导入。
   */
  const QUALITY_SUFFIX = { fast: '', best: '_std' };
  const normQuality = (q) => (q === 'best' ? 'best' : 'fast');
  const codeOf = (lang, quality) => String(lang || '') + (QUALITY_SUFFIX[normQuality(quality)] || '');
  /** 档位对应的包表：fast 走 `packs`，best 走 `variants.best.packs`（未提供时报错，不偷偷降级） */
  function packsOf(m, quality) {
    if (normQuality(quality) === 'best') {
      /* 高精度档还没随站点提供时返回空表（设置页会显示"尚未提供"），
       * 真要用它识别时由 `packOf` 抛出明确提示 —— 不在这里抛，免得只是打开设置页就报错。 */
      return (m && m.variants && m.variants.best && m.variants.best.packs) || {};
    }
    return (m && m.packs) || {};
  }
  function packOf(m, lang, quality) {
    const packs = packsOf(m, quality);
    const pack = packs[lang];
    if (!pack) throw Object.assign(new Error('未知语言：' + lang), { code: 'lang-unknown' });
    return pack;
  }

  /** 关键词要哪些语言：含中日韩统一表意文字 → 中英双包；纯 ASCII → 只 eng（快一倍） */
  function langsForKeyword(text, quality) {
    const q = normQuality(quality);
    return (CJK_RE.test(String(text == null ? '' : text)) ? ['chi_sim', 'eng'] : ['eng']).map((l) => codeOf(l, q));
  }

  /**
   * 实际可用的语言码：**清单里没有该档位的包就丢掉它**（K67）。
   * 例：高精度档只提供了中文包时，中文关键词仍可按 `chi_sim_std` 识别（标准中文模型对拉丁字母也够用），
   * 而不是因为缺 `eng_std` 整张图都识别不了。一个包都没有时给明确提示。
   */
  async function pickLangs(keyword, quality) {
    const m = await getManifest();
    const packs = packsOf(m, quality);
    const want = langsForKeyword(keyword, quality);
    const got = want.filter((code) => !!packs[String(code).replace(/_std$/, '')]);
    if (!got.length) {
      throw Object.assign(new Error(normQuality(quality) === 'best'
        ? '还没有可用的高精度语言包（请到设置页 → 图片识别 → 语言包 里下载或手动导入）'
        : '语言包未就绪（请到设置页 → 图片识别 → 语言包 里下载或手动导入）'),
      { code: 'lang-missing', quality: normQuality(quality) });
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
  async function ensureLang(code) {
    const m = await getManifest();
    const quality = /_std$/.test(String(code)) ? 'best' : 'fast';
    const lang = String(code).replace(/_std$/, '');
    const pack = packOf(m, lang, quality);
    const cached = await idbGet(cacheGetKey(code));
    if (cached && cached.length) return { lang: lang, quality: quality, source: 'cache', bytes: cached.length };
    if (await hasLocalPack(pack.file)) return { lang: lang, quality: quality, source: 'local', bytes: pack.bytes };
    throw Object.assign(new Error('语言包未就绪：' + (pack.label || lang)), { code: 'lang-missing', lang: lang, quality: quality });
  }

  /**
   * 运行时下载：自己 fetch → sha256 校验 → 解压 → 写缓存。
   * 只有**用户主动点「下载」**或首次识别缺包且用户已同意时才会走到这里；
   * 校验不通过一律不落盘（宁可报错也不把坏包喂给引擎）。
   */
  async function downloadLang(lang, opts) {
    const m = await getManifest();
    const quality = normQuality(opts && opts.quality);
    const pack = packOf(m, lang, quality);
    const code = codeOf(lang, quality);
    const src = String((opts && opts.base) || m._base).replace(/\/$/, '') + '/' + pack.file;
    emitProgress({ job: 'lang', lang: lang, quality: quality, phase: 'download', url: src });
    const res = await fetch(src + (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error('下载失败（HTTP ' + res.status + '）'), { code: 'download-failed' });
    const gzBytes = new Uint8Array(await res.arrayBuffer());
    emitProgress({ job: 'lang', lang: lang, quality: quality, phase: 'verify', bytes: gzBytes.length });
    const sha = await sha256Hex(gzBytes);
    if (pack.sha256 && sha !== String(pack.sha256).toUpperCase()) {
      throw Object.assign(new Error('语言包校验不一致（可能被截断或篡改），已丢弃'), {
        code: 'sha-mismatch', expect: pack.sha256, got: sha
      });
    }
    const plain = isGzip(gzBytes) ? await gunzip(gzBytes) : gzBytes;
    emitProgress({ job: 'lang', lang: lang, quality: quality, phase: 'store', bytes: plain.length });
    await idbPut(cacheGetKey(code), plain);
    emitProgress({ job: 'lang', lang: lang, quality: quality, phase: 'done', bytes: plain.length });
    return { lang: lang, quality: quality, bytes: plain.length, gzBytes: gzBytes.length, sha256: sha, verified: true };
  }

  /** 手动导入（完全离线）：用户挑了本地文件 → 校验（能对上就用官方 sha256 标注）→ 写缓存 */
  async function importLang(lang, base64, opts) {
    const m = await getManifest();
    const quality = normQuality(opts && opts.quality);
    const pack = packOf(m, lang, quality);
    const code = codeOf(lang, quality);
    const bin = atob(String(base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw Object.assign(new Error('文件是空的'), { code: 'import-empty' });
    const sha = await sha256Hex(bytes);
    const official = !!pack.sha256 && sha === String(pack.sha256).toUpperCase();
    const plain = isGzip(bytes) ? await gunzip(bytes) : bytes;
    await idbPut(cacheGetKey(code), plain);
    return {
      lang: lang, quality: quality, bytes: plain.length, gzBytes: bytes.length, sha256: sha,
      official: official, name: (opts && opts.name) || pack.file
    };
  }

  async function clearLangs(langs, quality) {
    const m = await getManifest();
    const q = normQuality(quality);
    const list = (langs && langs.length) ? langs : Object.keys(packsOf(m, q));
    for (const l of list) await idbDel(cacheGetKey(codeOf(l, q)));
    return { cleared: list, quality: q };
  }

  /** 语言包状态（设置页展示用；顺带告诉它本地目录里有没有可用的离线包） */
  async function langState(quality) {
    const m = await getManifest();
    const q = normQuality(quality);
    const packs = packsOf(m, q);
    const out = { cacheKey: CACHE_KEY, base: m._base, quality: q, available: Object.keys(packs).length > 0, langs: {} };
    for (const lang of Object.keys(packs)) {
      const pack = packs[lang];
      const cached = await idbGet(cacheGetKey(codeOf(lang, q)));
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
    engine.timer = setTimeout(() => { destroyEngine('idle'); }, IDLE_MS);
  }

  async function destroyEngine(why) {
    if (!engine) return;
    const e = engine;
    engine = null;
    clearTimeout(e.timer);
    try { await e.worker.terminate(); } catch (err) { /* 销毁失败无所谓 */ }
  }

  async function getEngine(langs) {
    const key = langs.slice().sort().join('+');
    if (engine && engine.key === key) { touchEngine(); return engine.worker; }
    if (engine) await destroyEngine('switch');
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

  /* ---------------- 图片 → 可识别输入 ---------------- */

  /** 小图放大目标高度（tesseract 对 x-height 很敏感：截图越小越认不出） */
  const TARGET_H = 96;
  const MAX_SCALE = 4;
  /** 高度超过它就认为"一图里混了多块内容"（海报 / 长截图）→ 切条识别 */
  const POSTER_MIN_H = 700;
  /** 切条上限（防止超长图把识别时间拖爆） */
  const MAX_BANDS = 4;
  /** PSM 11 = 稀疏文本：文字散落在图片各处（海报、截图拼贴）时的正确版面假设 */
  const PSM_SPARSE = '11';

  /** 从已处理好的 PNG 里裁一条横带（再识别）：条与条之间重叠，避免正好切断一行字 */
  async function cropBlob(blob, x, y, w, h) {
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, -x, -y);
    bmp.close();
    return await cv.convertToBlob({ type: 'image/png' });
  }

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
   * 预处理：**过大的缩小、过小的放大**，再灰度化 + 对比度拉伸 + 深底反色 + 留白边（K64）。
   *
   * 【为什么必须做】表格里的"值"基本都是 200~400px 宽的小截图，而 tesseract 对过小的字
   * （x-height 太小、JPEG 糊、彩色底）识别率会断崖式下降 —— 实测"彩色底 + 界面杂讯 + JPEG"那张
   * 直接认成乱码（置信度 40）。四步都是低风险且对正常图无害的：
   *   ① 小图按整数倍放大到高度 ≥ 96（高质量插值）；
   *   ② 灰度化（彩色底/彩色字对二值化判断是干扰）；
   *   ③ 2%~98% 分位对比度拉伸（浅灰字/低对比度截图的主要救命手段）；
   *   ④ 整图偏暗（深底浅字）时反色 —— LSTM 模型是按"浅底深字"训练的；
   *   ⑤ 四周留一圈白边（紧贴边缘的文字会被切掉/误判）。
   */
  async function prepareBlob(blob) {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      throw Object.assign(new Error('这张图无法解码（可能不是图片或已失效）'), { code: 'decode-failed' });
    }
    const w0 = bitmap.width, h0 = bitmap.height;
    let scale = 1;
    if (Math.max(w0, h0) > MAX_EDGE) scale = MAX_EDGE / Math.max(w0, h0);          // 过大 → 缩
    else if (h0 < TARGET_H) scale = Math.min(MAX_SCALE, TARGET_H / h0);            // 过小 → 放大
    const cw = Math.max(1, Math.round(w0 * scale));
    const ch = Math.max(1, Math.round(h0 * scale));
    const margin = Math.max(8, Math.round(Math.max(cw, ch) * 0.02));
    const cv = new OffscreenCanvas(cw + margin * 2, ch + margin * 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, margin, margin, cw, ch);
    bitmap.close();

    const pre = { scale: Number(scale.toFixed(2)), gray: false, invert: false, span: 0 };
    try {
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

    const out = await cv.convertToBlob({ type: 'image/png' });
    /* `singleLine` 用**原始高度**判断：表格里的一行值基本都 ≤40px 高 */
    return { blob: out, w: cv.width, h: cv.height, scaled: scale !== 1, pre: pre, singleLine: h0 <= 40 };
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
    const reply = (payload) => post(Object.assign({
      requestId: job.requestId, tabId: job.tabId, src: job.src, keyword: job.keyword
    }, payload));
    try {
      const langs = await pickLangs(job.keyword, job.quality);
      const worker = await getEngine(langs);
      const got = await bytesFromRequest(job);
      const fit = await prepareBlob(got.blob);
      const t1 = performance.now();
      const setPsm = async (psm) => {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            user_defined_dpi: '300',
            preserve_interword_spaces: '1'
          });
        } catch (e) { /* 个别内核不支持某个参数：忽略，继续按默认跑 */ }
      };
      /**
       * 【大幅图要**切条**识别（K65）】实测那张营销海报（1080×1920：紫色渐变 + 装饰字 + 手机截图 + 人物照片）
       * 整张丢进去是一片乱码 —— 因为一张图里混了多种字号/底色/照片，默认版面分割必然切错。
       * 做法：高度 ≥ POSTER_MIN_H 时切成若干**互相重叠**的横条，每条单独识别（PSM 11「稀疏文本」：
       * 专为"文字散落在图片各处"设计的版面假设），最后按顺序合并文本。
       * 我们的用途只是"图里有没有出现这个关键词"，所以合并文本即可，不需要版面还原。
       */
      const bands = [];
      if (fit.h >= POSTER_MIN_H) {
        const step = Math.max(200, Math.round(fit.h * 0.5));
        for (let y = 0; y < fit.h && bands.length < MAX_BANDS; y += step) {
          const bh = Math.min(fit.h - y, Math.round(step * 1.4));
          if (bh <= 0) break;
          bands.push([y, bh]);
          if (y + bh >= fit.h) break;
        }
      }
      /* 【按「行」过滤 + 按位置排序（K66）】整张海报丢给引擎时，照片与装饰图形会产生大量垃圾"行"
       * （用户看到的 `Tory` / `rr i` / `Ve` 就是这些）。tesseract 每条行都带**置信度与坐标**，
       * 于是这里做三件事，把面板里的文本收拾成"人能读的样子"：
       *   ① 丢掉置信度过低（<55）或"一半以上不是字/数字/字母"的行；
       *   ② 按 y 坐标排序（切条是分块识别的，顺序本来就是乱的）；
       *   ③ 相邻且文字相同的行去重（切条之间是重叠的，同一行会被识别两次）。 */
      const linesFrom = (res, yOffset) => {
        const arr = (res && res.data && res.data.lines) || [];
        const out = [];
        for (const ln of arr) {
          const t = String((ln && ln.text) || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          const bbox = (ln && ln.bbox) || {};
          out.push({ t: t, conf: (ln && ln.confidence) || 0, y: (bbox.y0 || 0) + (yOffset || 0), x: bbox.x0 || 0 });
        }
        return out;
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
      let conf = 0;
      let psm = '';
      let passes = 0;
      let rawLines = 0;
      let allLines = [];
      if (bands.length > 1) {
        for (const [y, bh] of bands) {
          const band = await cropBlob(fit.blob, 0, y, fit.w, bh);
          await setPsm(PSM_SPARSE);
          const r = await timeout(worker.recognize(band), 60000, '识别');
          passes += 1;
          const got2 = linesFrom(r, y);
          rawLines += got2.length;
          allLines = allLines.concat(got2);
        }
        psm = PSM_SPARSE + '(切条' + bands.length + ')';
      } else {
        const psm1 = fit.singleLine ? '7' : '6';
        await setPsm(psm1);
        let res = await timeout(worker.recognize(fit.blob), 60000, '识别');
        passes = 1;
        psm = psm1;
        const conf1 = (res && res.data && res.data.confidence) || 0;
        if (conf1 < 70) {
          try {
            await setPsm(PSM_SPARSE);
            const res2 = await timeout(worker.recognize(fit.blob), 60000, '识别');
            passes = 2;
            const conf2 = (res2 && res2.data && res2.data.confidence) || 0;
            if (conf2 > conf1) { res = res2; psm = PSM_SPARSE; }
          } catch (e) { /* 第二遍失败不影响第一遍结果 */ }
        }
        const got2 = linesFrom(res, 0);
        rawLines = got2.length;
        allLines = allLines.concat(got2);
        conf = (res && res.data && res.data.confidence) || 0;
      }
      const finalLines = tidy(allLines);
      if (bands.length > 1) {
        conf = finalLines.length ? Math.round(finalLines.reduce((s, l) => s + l.conf, 0) / finalLines.length) : 0;
      }
      const text = finalLines.map((l) => l.t).join('\n');
      reply({
        ok: true,
        text: text,
        confidence: conf,
        langs: langs,
        w: fit.w, h: fit.h, scaled: fit.scaled,
        psm: psm, passes: passes, pre: fit.pre, bands: bands.length,
        lines: finalLines.length, rawLines: rawLines,
        queueMs: Math.round(t1 - t0), ocrMs: Math.round(performance.now() - t1),
        totalMs: Math.round(performance.now() - t0)
      });
    } catch (err) {
      reply({ ok: false, code: (err && err.code) || 'ocr-failed', error: String((err && err.message) || err) });
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
    langs: (engine && engine.langs) || []
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
        src: msg.src, dataUrl: msg.dataUrl, keyword: msg.keyword
      });
      /* 图片任务是"排进队列"：**不能**在这里 post 回执 —— background 收到回执就把它当成
       * 最终结果（并且把 requestId 的路由记录删掉），真正的识别结果随后到达时就无处可送了。
       * 所以这条只 sendResponse，最终结果由 runJob 单独 post。 */
      settle(Promise.resolve({ queued: queue.length + (draining ? 1 : 0) }), true);
      return true;
    }
    if (msg.type === MSG.OCR_CANCEL) return settle(Promise.resolve({ cancelled: cancelForTab(msg.tabId) }));
    if (msg.type === MSG.OCR_LANG_STATE) return settle(langState(msg.quality).then((s) => ({ state: s, engine: engine ? engine.key : null })));
    if (msg.type === MSG.OCR_LANG_DOWNLOAD) return settle(downloadLang(msg.lang, { base: msg.base, force: msg.force, quality: msg.quality }));
    if (msg.type === MSG.OCR_LANG_IMPORT) return settle(importLang(msg.lang, msg.base64, { name: msg.name, quality: msg.quality }));
    if (msg.type === MSG.OCR_LANG_CLEAR) return settle(clearLangs(msg.langs, msg.quality).then((r) => { if (engine) destroyEngine('lang-cleared'); return r; }));
    /* 设置页「自检」：跑一张内置小图，确认引擎真的能用（不依赖任何网页） */
    if (msg.type === 'kh:ocr:selftest') {
      enqueue({ requestId: msg.requestId, tabId: msg.tabId, keyword: msg.keyword || '供应商', dataUrl: msg.dataUrl });
      return settle(Promise.resolve({ queued: 1 }));
    }
    return false;
  });
})();
