/* tests/specs/ocr-engine.test.js — 识别引擎选型与回落（S2-b）
 * ----------------------------------------------------------------------------
 * S2 把主引擎换成了 PP-OCR（ppu-paddle-ocr + onnxruntime-web，WASM 单线程），Tesseract 退成
 * **兼容/兜底**引擎，用户可见的选择从"档位"变成 `imgOcr.engine = auto | ppocr | tesseract`。
 * 这张 spec 锁的是这次换引擎**最容易悄悄坏掉**的东西 —— 而它们全都不报错、只默默降级：
 *
 *   ① **引擎裁决**（#12 §3）：`ppocr` 起来就用它；起不来时 `auto` 回落 Tesseract 并**带上原因**，
 *      而 `ppocr` 档**不许**回落（那一档是给排障用的，"偷偷退回"会让排障结论完全失真）。
 *   ② **回落必须按会话持久**：不持久的话每一张图都要白等一次失败（长图 8 块 = 白等 8 次）。
 *   ③ **回执必带 `engine` + `engineReason`**（不变量 6）：这是"用户能不能知道自己被降级了"的唯一依据。
 *   ④ **缺 `engine` 就不许猜**：payload 的 `engine` 由 background 注入，缺失时如实回 `missing-engine`。
 *   ⑤ **档位彻底消失**：`offscreen/**` 与 `background/**` 里不许再有 `quality` 管道
 *      （旧口径下 `best` 会被丢两次 —— 见票 #16 ①；现在连这个概念都不该存在）。
 *   ⑥ **配置迁移**：存量 `imgOcr.quality` 落 `engine='auto'` 并置 `migrated.ocrEngine`，
 *      且那个废弃键**必须被删掉**（否则每次读都重新触发一次"迁移提示"）。
 *
 * 【怎么测】`offscreen/ocr.js` 是普通 IIFE（不进 content_scripts），用 `new Function` 给它一个假
 * 运行环境：假 IDB / 假画布 / 假 fetch / 假 Tesseract，外加一个 `self.__khOcrImport` 钩子顶替
 * 动态 `import()` —— 于是"主引擎建不起来""模型没缓存"这类分支在 node 里也能真跑一遍。
 * 手法与 `tests/specs/ocr-long-image.test.js:90` 同款（那张 spec 测的是长图几何，这张测引擎裁决）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 兼容引擎的语言包清单（快档两包即可，S2 起没有档位维度） */
const LANG_MANIFEST = {
  _base: 'https://example.test/lang',
  packs: {
    chi_sim: { file: 'chi_sim.traineddata.gz', bytes: 8, sha256: 'A'.repeat(64), label: '简体中文' },
    eng: { file: 'eng.traineddata.gz', bytes: 8, sha256: 'B'.repeat(64), label: '英文' }
  }
};
/** 主引擎模型清单（三件；sha256 在这里不重要 —— 测试走"缓存命中"或"站点 404"两条路） */
const MODEL_MANIFEST = {
  _base: 'https://example.test/models',
  cacheKey: 'kh-ocr-model-v1',
  files: {
    detection: { file: 'det.onnx', bytes: 3, sha256: 'C'.repeat(64) },
    recognition: { file: 'rec.onnx', bytes: 3, sha256: 'D'.repeat(64) },
    dictionary: { file: 'dict.txt', bytes: 3, sha256: 'E'.repeat(64) }
  }
};
/** 模型在 IDB 里的键 = `<cacheKey>/<文件名>`（与 `offscreen/ocr.js` 的 `modelCacheKeyOf` 同一口径） */
const MODEL_KEYS = ['kh-ocr-model-v1/det.onnx', 'kh-ocr-model-v1/rec.onnx', 'kh-ocr-model-v1/dict.txt'];

/* ---------------- 装置 ---------------- */

function fakeIDB(store) {
  return {
    open: () => {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          close: () => {},
          transaction: () => {
            const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
            tx.objectStore = () => ({
              get: (k) => ({ result: store[k] }),
              put: (v, k) => { store[k] = v; return {}; },
              delete: (k) => { delete store[k]; return {}; }
            });
            /* 真实 IDB 的 complete 事件在微/宏任务之后；这里推到下一个宏任务，与 idbRun 的
             * "先取 req、后挂 oncomplete" 的顺序兼容 */
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
          }
        };
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > (ms || 800)) throw new Error('等待超时（装置问题，不是产品问题）');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 装一份 `offscreen/ocr.js`。
 * @param {object} [opts]
 *   · `models: true`  —— IDB 里预置三件模型（主引擎"资产已就绪"）
 *   · `ppocr: 'init-fail'` —— ppu 服务 `initialize()` 抛错（主引擎起不来，最常见）
 *   · `ppocr: 'no-module'` —— 连 `import('vendor/ppu-paddle-ocr/web/index.js')` 都失败
 *   · `ppocr: 'ok'`（默认）—— 主引擎可用，`recognize` 返回一行「PP-OCR 认出来的字」
 *   · `tesseract: {lines:(i)=>…}` —— 假 Tesseract 每次 `recognize` 返回什么
 */
function loadOffscreen(opts) {
  const o = opts || {};
  const MSG = require('../bootstrap').KH.MSG;
  const posts = [];
  const listeners = [];
  const calls = { recognize: 0, params: [], ppocrAttempts: 0, ppocrInit: 0, tessWorker: 0, imports: [] };
  const store = {
    'kh-ocr-lang-v1/chi_sim.traineddata': new Uint8Array(8),
    'kh-ocr-lang-v1/eng.traineddata': new Uint8Array(8)
  };
  if (o.models) for (const k of MODEL_KEYS) store[k] = new Uint8Array([1, 2, 3]);

  const self = {};
  self.KH = { MSG: MSG };
  const chrome = {
    runtime: {
      getURL: (rel) => 'chrome-extension://kh/' + rel,
      sendMessage: (m) => posts.push(m),
      onMessage: { addListener: (fn) => listeners.push(fn) }
    }
  };

  const fetchStub = async (u) => {
    const s = String(u);
    if (s.indexOf('lang-manifest.json') >= 0) return { ok: true, status: 200, json: async () => LANG_MANIFEST };
    if (s.indexOf('models-manifest.json') >= 0) return { ok: true, status: 200, json: async () => MODEL_MANIFEST };
    if (s.indexOf('data:') === 0) {
      const m = /W=(\d+);H=(\d+)/.exec(s) || [0, 320, 60];
      return { ok: true, status: 200, blob: async () => ({ __w: Number(m[1]), __h: Number(m[2]) }) };
    }
    /* 站点上的模型字节：故意 404（`models:true` 时根本不会走到这里） */
    return { ok: false, status: 404, blob: async () => ({ __w: 1, __h: 1 }) };
  };

  /* 动态 import 的替身：ppu 的入口 → 假服务；ORT 胶水 → 假 env（真机上这两个都是真的文件） */
  self.__khOcrImport = (spec) => {
    calls.imports.push(spec);
    if (/ort\.wasm\.min\.mjs$/.test(spec)) return { env: { wasm: {}, logLevel: '' } };
    if (/ppu-paddle-ocr\/web\/index\.js$/.test(spec)) {
      if (o.ppocr === 'no-module') throw Object.assign(new Error('模块加载失败'), { code: 'module-load-failed' });
      calls.ppocrAttempts += 1;
      const script = o.ppocr || 'ok';
      return {
        PaddleOcrService: class FakePaddleOcrService {
          constructor(options) { this.options = options; calls.ppocrOptions = options; }
          async initialize() {
            calls.ppocrInit += 1;
            if (script === 'init-fail') throw Object.assign(new Error('模型没起来'), { code: 'init-failed' });
          }
          async destroy() {}
          async recognize() {
            calls.recognize += 1;
            if (script === 'recognize-fail') throw Object.assign(new Error('识别崩了'), { code: 'ocr-failed' });
            /* 上游形状：`lines` 是"行 → 词条数组"，置信度 0–1、坐标是 box */
            return {
              text: 'PP 认出来的供应商',
              confidence: 0.99,
              lines: [[{ text: 'PP', confidence: 0.98, box: { x: 4, y: 20, width: 40, height: 20 } },
                { text: '认出来的供应商', confidence: 0.99, box: { x: 50, y: 20, width: 120, height: 20 } }]]
            };
          }
        }
      };
    }
    throw new Error('测试装置没准备的模块：' + spec);
  };

  const Tesseract = {
    createWorker: async () => {
      calls.tessWorker += 1;
      if (o.tesseractFails) throw Object.assign(new Error('引擎建不起来'), { code: 'engine-unavailable' });
      return {
        setParameters: async (p) => { calls.params.push(p.tessedit_pageseg_mode); },
        recognize: async () => {
          const i = calls.recognize++;
          const got = (o.tesseract && o.tesseract.lines ? o.tesseract.lines(i) : null) || { conf: 90, lines: [{ t: '供应商甲', conf: 92, y: 20, x: 4 }] };
          return {
            data: {
              confidence: got.conf == null ? 90 : got.conf,
              lines: (got.lines || []).map((l, k) => ({
                text: l.t,
                confidence: l.conf == null ? 90 : l.conf,
                bbox: { y0: l.y == null ? 20 + k * 40 : l.y, x0: l.x == null ? 4 : l.x }
              }))
            }
          };
        },
        terminate: async () => {}
      };
    }
  };

  const OffscreenCanvasStub = function (w, h) {
    const cv = { __canvas: true, width: Math.max(1, w | 0), height: Math.max(1, h | 0) };
    const ctx = {
      fillStyle: '', imageSmoothingEnabled: true, imageSmoothingQuality: '',
      fillRect() {}, drawImage() {}, translate() {}, rotate() {}, putImageData() {},
      getImageData: (x, y, ww, hh) => ({
        data: new Uint8ClampedArray(Math.max(4, ww * hh * 4)).fill(200),
        width: ww, height: hh
      })
    };
    cv.getContext = () => ctx;
    /* 两个引擎拿数据的方式不同：Tesseract 吃 Blob，PP-OCR 那条路走 `arrayBuffer()` */
    cv.convertToBlob = async () => ({
      __blob: true, width: cv.width, height: cv.height,
      arrayBuffer: async () => new ArrayBuffer(Math.max(4, cv.width * cv.height))
    });
    return cv;
  };
  const createImageBitmapStub = async (src) => {
    if (src && (src.__canvas || src.__blob)) return { width: src.width, height: src.height, close() {} };
    return { width: (src && src.__w) || 100, height: (src && src.__h) || 100, close() {} };
  };

  new Function(
    'self', 'chrome', 'Tesseract', 'OffscreenCanvas', 'createImageBitmap', 'fetch', 'indexedDB',
    read('offscreen/ocr.js')
  )(self, chrome, Tesseract, OffscreenCanvasStub, createImageBitmapStub, fetchStub, fakeIDB(store));

  const isResult = (p, id) => p.type === MSG.OCR_RESULT && p.requestId === id;
  return {
    self: self, posts: posts, calls: calls,
    job: (msg) => listeners.forEach((fn) => fn(Object.assign({ to: 'offscreen' }, msg), {}, () => {})),
    /** 派一条识别任务并等它的终态回执 */
    async run(engine, id) {
      this.job({ type: MSG.OCR_IMAGE, requestId: id, tabId: 3, keyword: '供应商', src: 'data:image/png;base64,x', engine: engine });
      return waitFor(() => posts.find((p) => isResult(p, id)));
    }
  };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');

  suite('识别引擎选型与回落（S2-b · 不变量 6 / 判据 ④）');

  /* ==================================================================
   * 引擎裁决（#12 §3）
   * ================================================================== */

  await test('★ `ppocr` 档主引擎起不来：如实报 engine-unavailable，**不许**偷偷回落', async () => {
    const env = loadOffscreen({ models: true, ppocr: 'init-fail' });
    const r = await env.run('ppocr', 'r1');
    eq(r.ok, false, 'ppocr 档失败时不许报成功');
    eq(r.code, 'engine-unavailable', '要能一眼看出"是引擎不可用"');
    eq(r.engine, 'ppocr', '回执要说明它想用的是哪个引擎');
    eq(r.engineReason, 'init-failed', '要带上真实原因（init-failed），不能只说"失败了"');
    eq(env.calls.tessWorker, 0, 'ppocr 档**一次都不许**碰兼容引擎（偷偷退回会让排障结论失真）');
  });

  await test('★ `auto` 档主引擎起不来：回落兼容引擎，且带原因、会话内持久', async () => {
    const env = loadOffscreen({ models: true, ppocr: 'init-fail' });
    const r = await env.run('auto', 'a1');
    eq(r.ok, true, 'auto 档有兜底引擎可用，就应当成功');
    eq(r.engine, 'tesseract', '回执必须说清"这次实际是兼容引擎在干活"');
    eq(r.engineReason, 'init-failed', '回落原因必须非空（用户据此知道自己被降级了）');
    truthy(r.text.indexOf('供应商') >= 0, '结果来自兼容引擎');
    eq(env.calls.ppocrAttempts, 1, '第一次试过主引擎');

    /* 会话内持久：第二条不许再试一次主引擎（否则每张图都白等一次失败） */
    const r2 = await env.run('auto', 'a2');
    eq(r2.ok, true);
    eq(r2.engine, 'tesseract');
    eq(r2.engineReason, 'init-failed', '回落状态要一直带着原因，不能第二条就变成"没原因"');
    eq(env.calls.ppocrAttempts, 1, '★ 回落必须按会话持久：第二次不许再试主引擎');
  });

  await test('★ `auto` 档主引擎可用：用它，且**一次都不碰**兼容引擎', async () => {
    const env = loadOffscreen({ models: true });
    const r = await env.run('auto', 'p1');
    eq(r.ok, true);
    eq(r.engine, 'ppocr', '主引擎可用就必须用它（这正是换引擎的全部意义）');
    eq(r.engineReason, '', '没回落 ⇒ 原因为空（空字符串而不是 undefined，便于 UI 判断）');
    eq(env.calls.tessWorker, 0, '不许为了"保险"再把兼容引擎也建起来');
    truthy(r.text.indexOf('PP') >= 0, '文本来自 PP-OCR 的结果');
    /* 置信度必须换算成 0–100：上游是 0–1，而 `keepLine` 的 55 分线与面板显示都用百分制 */
    truthy(r.confidence > 55, 'PP-OCR 的 0–1 置信度必须 ×100（否则每行都会被当低置信度丢掉）：' + r.confidence);
    eq(env.calls.recognize, 1, '一块只识别一次');
  });

  await test('★ 主引擎可用但**识别**时崩了：如实报错，不掩盖成"没命中"', async () => {
    const env = loadOffscreen({ models: true, ppocr: 'recognize-fail' });
    const r = await env.run('auto', 'p2');
    eq(r.ok, false, '识别失败就是失败，不许报 ok:true + 空文本（那会被面板说成"未命中"）');
    eq(r.engine, 'ppocr', '要说明当时用的是主引擎');
  });

  await test('★ 模型资产缺失（清单在、站点 404）⇒ 回落原因必须是 `asset-missing`，不是笼统的失败', async () => {
    const env = loadOffscreen({});
    const r = await env.run('auto', 'm1');
    eq(r.ok, true);
    eq(r.engine, 'tesseract');
    eq(r.engineReason, 'asset-missing', '缺资产与"引擎初始化失败"要分得开 —— 前者是发版/网络问题，后者是兼容性问题');
  });

  await test('★ `tesseract` 档：只走兼容引擎，一次都不试主引擎', async () => {
    const env = loadOffscreen({ models: true });
    const r = await env.run('tesseract', 't1');
    eq(r.ok, true);
    eq(r.engine, 'tesseract');
    eq(env.calls.ppocrAttempts, 0, '用户明确选了兼容引擎，就不许再动主引擎（省内存也省等待）');
    truthy(env.calls.params.length >= 1, '兼容引擎那条路仍要设 PSM');
  });

  await test('★ 缺 `engine`（payload 契约被破坏）⇒ 如实回 missing-engine，两种引擎都不许建', async () => {
    const env = loadOffscreen({ models: true });
    const r = await env.run(undefined, 'n1');
    eq(r.ok, false);
    eq(r.code, 'missing-engine', 'payload 少了 engine 是**契约被破坏**，不许猜一个默认值顶上去');
    eq(r.engine, null, '不知道就是不知道（null，不是编一个名字）');
    eq(env.calls.tessWorker, 0, '不许顺手建兼容引擎');
    eq(env.calls.ppocrAttempts, 0, '也不许顺手建主引擎');
  });

  /* ==================================================================
   * 档位彻底消失 + 配置迁移
   * ================================================================== */

  await test('★ 判据 ④（前半）：引擎层里不再有 `quality` 管道', () => {
    for (const rel of ['offscreen/ocr.js', 'background/ocr.js']) {
      const src = read(rel);
      /* 【坑】先把注释挖掉再扫，而且**保留换行与列位**（用空格顶替）—— 否则行号会漂，
       * 而且"解释为什么删掉档位"的那段注释会把守卫自己打红（S1-b 踩过同一个坑）。 */
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
      const hits = [];
      code.split(/\r?\n/).forEach((line, i) => {
        if (/\bquality\s*[:,)]/.test(line) || /\bnormQuality\b/.test(line) || /\b_std\b/.test(line)) {
          hits.push(rel + ':' + (i + 1) + '  ' + src.split(/\r?\n/)[i].trim().slice(0, 100));
        }
      });
      eq(hits.length, 0, rel + ' 里还有档位管道（S2 起只认 `imgOcr.engine`）：\n      ' + hits.join('\n      '));
    }
  });

  await test('★ 配置迁移：存量 quality → engine=auto + migrated.ocrEngine，且废弃键被删掉', () => {
    const C = KH.Config;
    for (const legacy of ['best', 'fast', 'nonsense']) {
      const r = C.normalize({ imgOcr: { defaultMax: 4, quality: legacy } });
      eq(r.config.imgOcr.engine, 'auto', '存量档位 ' + legacy + ' 一律落 auto（换引擎后"更准"由主引擎承担）');
      eq(r.config.migrated.ocrEngine, true, '要留下"还没告知过"的标记，设置页据此给一次性提示');
      eq('quality' in r.config.imgOcr, false, '废弃键必须从读出来的配置里删掉（否则每次读都重新触发迁移）');
    }
    /* 已经在用 engine 的配置：不许被误标成"待迁移" */
    const y = C.normalize({ imgOcr: { engine: 'ppocr' }, migrated: { ocrEngine: false } });
    eq(y.config.imgOcr.engine, 'ppocr', '合法值必须原样保留');
    eq(y.config.migrated.ocrEngine, false, '没有存量档位就不该提示迁移');
    /* 非法/缺失 → auto；标记保持用户/设置页写的值 */
    eq(C.normalize({ imgOcr: { engine: 'gpu' } }).config.imgOcr.engine, 'auto', '非法引擎值回退 auto');
    eq(C.normalize({}).config.imgOcr.engine, 'auto', '缺省就是 auto');
    eq(C.normalize({}).config.migrated.ocrEngine, false, '默认不提示迁移');
    /* 迁移标记是"待告知"而不是"发生过"：设置页写回 false 之后，再读也不许自己翻回 true */
    const after = C.normalize({ imgOcr: { engine: 'auto' }, migrated: { ocrEngine: false } });
    eq(after.config.migrated.ocrEngine, false, '清除后不许自己翻回 true（否则提示关不掉）');
  });

  await test('★ 内容脚本不传引擎：payload 里不许出现 engine 字段（由 background 单点注入）', () => {
    const src = read('src/features/img-ocr.js');
    falsy(/\bengine\s*:/.test(src), 'img-ocr.js 不许自己塞 engine —— 契约是"发起方不传、background 注入"'
      + '（两处都能配引擎时，"用户改了设置"与"这条 job 排队"的时刻就会打架）');
  });
};
