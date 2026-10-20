/* tests/specs/ocr-long-image.test.js — 长图分块与方向纠正（S1-c · 不变量 1–4）
 * ----------------------------------------------------------------------------
 * 合同 §4 判据 1/2 那两条硬线（1080×8000 长图必须出现 200/200 行、rot90/180/270 必须命中）
 * **只能在真机上量**（`_e2e/probe-ocr-long.js`）。**这张 spec 管的是"判决"，不是像素**：
 *   · 不变量 1 —— 全部行被丢掉（`rawLines>0` 而 `lines=0`）**必须**带告知字段，
 *                 不许静默返回一个干净的"未命中"（这正是今天长图的现场：0/200 行而回执 `ok:true`）；
 *   · 不变量 2 —— 触到块数上限必须带覆盖信息（共几块 / 用了前几块 / 覆盖到原图哪一行）；
 *   · 不变量 3 —— 未就绪（语言包 / 引擎）必须如实回报，**不得**静默降级成另一次"识别成功但没命中"；
 *   · 不变量 4 —— 试转的**触发判据与判决**是纯函数（喂数据出结论，不碰引擎/画布/时钟），
 *                 且"同数取 conf 高 / 只有严格更优才采用"这两条规则可被钉住。
 *
 * 【为什么连"假引擎"都要装】只测纯函数的话，"回执里到底有没有那个字段"没人验 ——
 * 判决写得再对、没人接，照样能全绿。所以这里把 `offscreen/ocr.js` 装进一个
 * **假引擎 + 假画布 + 假 IndexedDB**的沙盒里，让它**真的跑一遍 `runJob`**：
 * 脚本按 `recognize` 的调用次序喂行数据，于是"第几次识别会出现什么"完全可控，
 * 回执的形状（notice / coverage / orientation / 逐块 progress）就成了可断言的事实。
 * （同款手法先例：`tests/specs/ocr-link.test.js` 把 `background/ocr.js` 装进假消息层。）
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MSG = {
  OCR_RESULT: 'ocr:result',
  OCR_PROGRESS: 'ocr:progress',
  OCR_IMAGE: 'kh:ocr:image',
  OCR_CANCEL: 'kh:ocr:cancel',
  OCR_LANG_STATE: 'kh:ocr:lang:state',
  OCR_LANG_DOWNLOAD: 'kh:ocr:lang:download',
  OCR_LANG_IMPORT: 'kh:ocr:lang:import',
  OCR_LANG_CLEAR: 'kh:ocr:lang:clear'
};

/** 语言包清单（假）：两个 fast 包都有 —— `pickLangs` 于是能选出 `chi_sim`+`eng` */
const MANIFEST = {
  packs: {
    chi_sim: { file: 'chi_sim.traineddata.gz', label: '简体中文', bytes: 1730011, sha256: 'A' },
    eng: { file: 'eng.traineddata.gz', label: '英文', bytes: 1984273, sha256: 'B' }
  }
};

/** 假 IndexedDB：够 `ensureLang` 用（缓存里 get 到非空字节就算"已就绪"，不去碰真实 IDB） */
function fakeIDB(store) {
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const tx = {
        oncomplete: null, onerror: null, onabort: null,
        objectStore: () => ({
          get: (k) => ({ result: store[k] }),
          put: (v, k) => { store[k] = v; return { result: k }; },
          delete: (k) => { delete store[k]; return { result: undefined }; }
        })
      };
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
      return tx;
    }
  };
  return {
    open: () => {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    }
  };
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > (ms || 4000)) throw new Error('等待超时（假引擎没有在预期内产出回执）');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 把 `offscreen/ocr.js` 装进沙盒。
 * @param {{lines:(i:number)=>({conf?:number, lines?:Array<{t:string,conf?:number,y?:number,x?:number}>}|null)}} script
 *   假引擎脚本：`lines(i)` = 第 `i` 次 `recognize` 返回的原始行（tesseract 形状，含 bbox）。
 * @param {{manifest?:object|null}} [opts] `manifest: null` = 清单都读不到；`{packs:{}}` = 清单在但一个包都没有
 */
function loadOffscreen(script, opts) {
  const o = opts || {};
  const manifest = o.manifest === undefined ? MANIFEST : o.manifest;
  const posts = [];
  const listeners = [];
  const calls = { recognize: 0, params: [] };
  const store = {
    'kh-ocr-lang-v1/chi_sim.traineddata': new Uint8Array(8),
    'kh-ocr-lang-v1/eng.traineddata': new Uint8Array(8)
  };

  const self = {};
  self.KH = { MSG: MSG };
  /* 假 blob：尺寸是**真读数**（几何断言全靠它），字节由尺寸推导 —— 同尺寸 ⇒ 同字节（按图去重可测）、
   * 不同尺寸 ⇒ 不同字节（不许误去重）。真机走的是真实图片字节，这里只为让「同图只识别一次」可复现。 */
  const fakeBlob = (w, h) => {
    const bytes = new Uint8Array(64);
    const ww = w >>> 0;
    const hh = h >>> 0;
    for (let i = 0; i < 4; i++) {
      bytes[i] = (ww >> (8 * i)) & 255;
      bytes[4 + i] = (hh >> (8 * i)) & 255;
    }
    return { __w: w, __h: h, arrayBuffer: async () => bytes.buffer };
  };
  const chrome = {
    runtime: {
      getURL: (rel) => 'chrome-extension://kh/' + rel,
      sendMessage: (m) => posts.push(m),
      onMessage: { addListener: (fn) => listeners.push(fn) }
    }
  };
  const fetchStub = async (u) => {
    const s = String(u);
    if (s.indexOf('lang-manifest.json') >= 0) {
      if (!manifest) return { ok: false, status: 404, json: async () => { throw new Error('HTTP 404'); } };
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (s.indexOf('data:,') === 0) {
      const m = /W=(\d+);H=(\d+)/.exec(s) || [0, 1080, 800];
      return { ok: true, status: 200, blob: async () => fakeBlob(Number(m[1]), Number(m[2])) };
    }
    return { ok: false, status: 404, blob: async () => fakeBlob(1, 1) };
  };

  const Tesseract = {
    createWorker: async () => {
      if (o.workerFails) throw Object.assign(new Error('引擎建不起来'), { code: 'engine-unavailable' });
      return {
        setParameters: async (p) => { calls.params.push(p.tessedit_pageseg_mode); },
        recognize: async () => {
          const i = calls.recognize++;
          const got = (script.lines ? script.lines(i) : null) || { conf: 90, lines: [] };
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

  /* 假画布：尺寸是真的（几何断言靠它），像素是常量（不测像素，像素归真机探针） */
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
    cv.convertToBlob = async () => ({ __blob: true, width: cv.width, height: cv.height });
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
    self: self,
    posts: posts,
    calls: calls,
    /** 派发一条消息给 offscreen（`to: 'offscreen'` 是它唯一认的投递标记）。
     *  【S2 起 payload 必须带 `engine`】本装置假的是 Tesseract，所以默认声明 `engine: 'tesseract'`
     *  —— 缺了它 offscreen 会如实回 `missing-engine`（契约如此，见 tests/specs/ocr-engine.test.js）。 */
    job: (msg) => listeners.forEach((fn) => fn(Object.assign({ to: 'offscreen', engine: 'tesseract' }, msg), {}, () => {})),
    result: (id) => waitFor(() => posts.find((p) => isResult(p, id))),
    progress: (id) => posts.filter((p) => p.type === MSG.OCR_PROGRESS && p.requestId === id)
  };
}

module.exports = async function run() {
  suite('OCR 长图分块与方向：判决层 + 假引擎端到端（S1-c）');

  /* ---------------- 纯判决层（不变量 2 / 4；D-14.1 / D-14.3） ---------------- */

  await test('★ 不变量 2：1080×8000 按**原图**切块 —— 步长 1360、末块贴底（D-14.1 样张验算）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    truthy(P, '★ offscreen/ocr.js 必须导出纯判决层 self.__khOcrPure（planChunks / scaleFor / judgeOrientation / needsRotation / rotationsFor / noticeOf / overlapBands / mergeOverlap）');
    const plan = P.planChunks(1080, 8000);
    eq(plan.chunks.length, 6, '8000 高 ⇒ 6 块（0 / 1360 / 2720 / 4080 / 5440 / 6800）');
    eq(plan.chunks[0].y, 0);
    eq(plan.chunks[0].h, 1600, '首块 1600 高（原图坐标）');
    eq(plan.chunks[1].y, 1360, '步长 = 块高 1600 − 重叠 240');
    const last = plan.chunks[plan.chunks.length - 1];
    eq(last.y, 6800);
    eq(last.h, 1200, '末块贴底：不足一整块时按剩余高度，别在图上"切过头"');
    eq(plan.coverage.coveredTo, 8000);
    eq(plan.coverage.truncated, false);
    eq(P.planChunks(1080, 8001).chunks.length, 6, 'D-14.1 的样张验算：1080×8001 ⇒ 6 块');
    eq(P.planChunks(1080, 900).chunks.length, 1, '短图仍是一块（不许把今天的单块路径弄坏）');
  });

  await test('★ 不变量 2：块高 ≤1600 时块内 1:1；放宽到 2000 时最多缩到 0.8', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    eq(P.scaleFor(1080, 1600), 1, '块高 1600 ⇒ **1:1 不缩**（20px 字高要保住，这是长图能认出来的前提）');
    eq(P.scaleFor(1080, 2000), 0.8, '块高放宽到 2000 ⇒ 缩到 0.8（MAX_EDGE=1600 的硬顶）');
    truthy(P.scaleFor(48, 20) > 1, '过小的块仍要放大（沿用 TARGET_H 的口径）');
  });

  await test('★ 2.0.4 需求③：小图一律 2× 重采（角标十来像素高 ⇒ det 读成「29」）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 用户报的那张：395×700 的缩略图，左上角「2026」只有十来像素高，1:1 送进去只认成「29」 */
    eq(P.scaleFor(395, 700), 2, '★ 小图必须放大再识别：瓶颈是每行在像素上的绝对高度（DENSE_RESCALE 处已诊断过）');
    eq(P.scaleFor(800, 400), 2, '800 是边界（放宽到 MAX_EDGE=1600 以内）');
    eq(P.scaleFor(801, 400), 1, '超过 800 就仍 1:1 —— 否则放大后越过 MAX_EDGE 那道墙');
    eq(P.scaleFor(1080, 1600), 1, '长图的块仍不放大（回归闸）');
  });

  await test('★ 2.0.4 需求③：非文字被认成文字（短且低分）必须丢掉，正常短词不误伤', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure.keepLine;
    eq(typeof P, 'function', 'keepLine 必须挂在纯判决层才能钉住这条口径');
    eq(P({ t: '周 OL', conf: 62 }), false, '★ 图标/装饰图形硬给出来的两个字母（用户报的那条「周 OL」）');
    eq(P({ t: '29', conf: 70 }), false, '「2026」被读成「29」也属同一类垃圾（短、低分）');
    eq(P({ t: 'OL', conf: 90 }), true, '高分的短词照留（真字号小标题/缩写）');
    eq(P({ t: '招标公告', conf: 60 }), true, '长行低分仍可能是艺术字正文 ⇒ 不在收紧范围');
    eq(P({ t: '张', conf: 99 }), false, '单字仍不许（既有口径不变）');
    eq(P({ t: '###', conf: 99 }), false, '纯符号仍不许（既有口径不变）');
    eq(P(null), false, '脏数据不许抛');
  });

  await test('★ 2.0.6 需求①：薄画布上的通栏文字行不许被当边框丢掉（宽图底边余块丢字）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 一块 1600×120 的宽条，margin 32 ⇒ 画布 1664×184（≈306k）。一条通栏文字框 1560×70 = 109k
     * ⇒ 旧口径 35.7% ⇒ 被当边框丢掉；而它本来就是这一块里唯一的一行字。 */
    eq(P.isFrameBox(1560, 70, 1664, 184, 1664 * 184), false,
      '★ 宽高没都占满 ⇒ 是正文，不是边框（旧口径会丢这一行）');
    eq(P.isFrameBox(1600, 180, 1664, 184, 1664 * 184), true, '两个方向都占满 ⇒ 这才是边框/底图');
    eq(P.isFrameBox(1580, 180, 1664, 184, 1664 * 184), true, '边框不必贴满：两边都 ≥70% 就算');
    eq(P.isFrameBox(1560, 90, 1664, 184, 1664 * 184), false, '只横向占满（高 49%）⇒ 大号正文，别丢');
    eq(P.isFrameBox(120, 60, 1664, 184, 1664 * 184), false, '小块本来就不是边框');
    eq(P.isFrameBox(1560, 70, 0, 0, 306176), true, '画布尺寸未知 ⇒ 沿用旧口径（只看面积），行为不变');
    eq(P.isFrameBox(1560, 70, 1664, 184, 0), false, '面积未知 ⇒ 不判（旧代码同样跳过）');
    /* ★ 方向闸不能一路放宽：横排两张证书那种图上，每张纸自己的边框框约 350×470 / 720×500（占一半），
     * 一经保留就会把那一整页的行并成一行 —— 2.0.6 真机 e2e ②b-2 就是这么红的。整页画布仍按面积判。 */
    eq(P.isFrameBox(350, 470, 720, 500, 720 * 500), true, '★ 整页画布：纸的边框框照样当边框丢掉');
    eq(P.FRAME_PAGE_EDGE, 400, '整页画布的分界（两边都到 400 才算一整页）');
    eq(P.FRAME_FULL_RATIO, 0.9, '窄条/小块上必须几乎铺满才算边框');
  });

  await test('★ 2.0.6 需求③：同行多段文字按框间距拼，中文不许凭空多空格', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* ① 词被框切成两段、间隙只有 2px ⇒ 贴回去（旧实现一律空格 ⇒「华为技术有限 公司」） */
    eq(P.joinParts([{ t: '华为技术有限', x: 0, x2: 400 }, { t: '公司', x: 402, x2: 460 }], 40),
      '华为技术有限公司', '★ 断词接回去不许带空格');
    /* ② 表格两格：间隙 80px ≫ 0.6 行高 ⇒ 仍留空格（列与列之间该有分隔） */
    eq(P.joinParts([{ t: '姓名', x: 0, x2: 60 }, { t: '张三', x: 140, x2: 220 }], 40),
      '姓名 张三', '不同列仍然留空格');
    /* ③ 前段以分隔符结尾 ⇒ 直接贴（`词：` + `值`） */
    eq(P.joinParts([{ t: '供应商：', x: 0, x2: 100 }, { t: '华为', x: 130, x2: 200 }], 40),
      '供应商：华为', '冒号后直接贴值');
    /* ④ 英文单词之间必须留空格，哪怕间隙很小（6px > 1px） */
    eq(P.joinParts([{ t: 'Hello', x: 0, x2: 50 }, { t: 'world', x: 56, x2: 110 }], 40),
      'Hello world', '英文相邻不许粘连');
    /* ⑤ 英文真的粘在一起（间隙 ≤1px）⇒ 接回去 */
    eq(P.joinParts([{ t: 'Hel', x: 0, x2: 30 }, { t: 'lo', x: 31, x2: 50 }], 40),
      'Hello', '粘在一起的英文片段要接回去');
    /* ⑥ 坐标缺失 ⇒ 退回空格（没有依据就不猜） */
    eq(P.joinParts([{ t: '甲' }, { t: '乙' }], 40), '甲 乙', '没有坐标 ⇒ 留空格');
    eq(P.joinParts(null, 40), '', '脏数据不许抛');
    eq(P.joinParts([{ t: '' }, { t: '乙', x: 0, x2: 10 }], 40), '乙', '空段跳过');
  });

  await test('★ 2.0.6 需求①：被切块切散的同一条物理行必须拼回一行（「词：」+「值」不许串行）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    eq(typeof P.stitchRows, 'function', 'stitchRows 必须挂在纯判决层才能钉住这条口径');
    /* 用户现场：图上是一行「词：值」，OCR 出来是「词：」「值」两行。
     * 机制：图比 MAX_EDGE 宽 ⇒ layoutChunks 沿 x 切块（左块只有「词：」、右块只有「值」），
     * 两块文本**不同** ⇒ mergeOverlap 的"逐字相等"配不上 ⇒ 两行一起活到 text。 */
    const split = [
      { t: '供应商：', conf: 96, x: 10, y: 100, y2: 140, ci: 0, cells: [{ t: '供应商：', x: 10, x2: 110 }] },
      { t: '华为技术有限公司', conf: 92, x: 1000, y: 102, y2: 142, ci: 1, cells: [{ t: '华为技术有限公司', x: 1000, x2: 1300 }] }
    ];
    const out = P.stitchRows(split);
    eq(out.length, 1, '★ 同一行带的两段必须并成一行（这是"串行"的直接解药）');
    eq(out[0].t, '供应商：华为技术有限公司', '★ 分隔符结尾直接贴，不许多一个空格（下游按「词：值」取值）');
    eq((out[0].cells || []).length, 2, '单元格要跟着带过来（重要笔记的表格形式靠它）');
  });

  await test('★ 2.0.6 需求①：重叠带重复片段只并单元格，文字不许重复一遍', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 块间有 240px 重叠 ⇒ 右块会把左块读过的尾巴再读一次（`有限公司`）：
     * 拼行时若原样追加，值就成了「华为技术有限公司 有限公司」。 */
    const out = P.stitchRows([
      { t: '供应商：华为技术有限公司', conf: 95, x: 10, y: 100, y2: 140, ci: 0, cells: [{ t: '供应商：', x: 10, x2: 110 }, { t: '华为技术有限公司', x: 120, x2: 400 }] },
      { t: '有限公司', conf: 90, x: 1400, y: 101, y2: 141, ci: 1, cells: [{ t: '有限公司', x: 1400, x2: 1520 }] }
    ]);
    eq(out.length, 1);
    eq(out[0].t, '供应商：华为技术有限公司', '★ 重复片段不许让文字翻倍');
    eq((out[0].cells || []).length, 2, '重复片段整段丢掉（留着单元格会把「有限公司」再拼进值里）');
  });

  await test('★ 2.0.6 需求①：不同物理行绝不拼（行距 40px 的两行仍是两行）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    const out = P.stitchRows([
      { t: '供应商：', conf: 95, x: 10, y: 100, y2: 140, ci: 0 },
      { t: '地址：深圳市', conf: 95, x: 10, y: 140, y2: 180, ci: 0 },
      { t: '招标公告', conf: 95, x: 600, y: 100, y2: 140, ci: 0 }
    ]);
    eq(out.length, 2, '上下两行不许并；同一行的两段要并');
    eq(out[0].t, '供应商：招标公告', '同一行按 x 从左到右拼');
    eq(out[1].t, '地址：深圳市');
    /* 单块图（linesFromPpocr 已经并过行）走这里必须**原样返回**，不新建对象 */
    const same = [{ t: '一行', conf: 99, x: 1, y: 1, y2: 9, ci: 0 }];
    eq(P.stitchRows(same)[0], same[0], '没有可拼的 ⇒ 原样返回（单块路径零变化）');
    eq(P.stitchRows(null).length, 0, '脏数据不许抛');
    eq(P.stitchRows([{ t: '' }, null]).length, 0, '空文本不进行');
  });

  await test('★ 不变量 2：4 万像素高的长图必须整张覆盖（T23：块数上限 8 → 40）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    const plan = P.planChunks(1080, 40000);
    eq(plan.coverage.truncated, false, '旧上限 8 块在 14321px 就开始丢内容；4 万像素的整页长图不许再丢');
    eq(plan.coverage.relaxed, false, '块数够用 ⇒ 块高保持 1600（1:1，不降采样）');
    eq(plan.chunks.length, 30, '(40000 − 1600) / 1360 向上取整 + 1 = 30 块');
    eq(plan.coverage.usedChunks, 30);
    eq(plan.coverage.droppedChunks, 0, '一块都不许丢');
    eq(plan.coverage.coveredTo, 40000, '末块贴底 ⇒ 整张覆盖到最后一行');
  });

  await test('★ 不变量 2：只有超过块数上限才截断，且如实给出覆盖范围（T23 新上限 40）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    const plan = P.planChunks(1080, 72000);
    eq(plan.coverage.truncated, true);
    eq(plan.coverage.relaxed, true, '先放宽块高到 2000 重算块数（不许一上来就截断）');
    eq(plan.chunks.length, 40, '仍超 ⇒ 只用前 40 块');
    eq(plan.coverage.usedChunks, 40);
    eq(plan.coverage.coveredTo, 70640, '覆盖原图前 70640px = 39×1760 + 2000');
    eq(plan.coverage.totalH, 72000);
    truthy(plan.coverage.droppedChunks > 0, '丢掉多少块也要给数（面板要说「共 N 块，已识别前 40 块」）');
  });

  await test('★ 不变量 4：试转判决是纯函数（行数最多者胜 / 同数取 conf / 只有严格更优才采用）', () => {
    const J = loadOffscreen({ lines: () => null }).self.__khOcrPure.judgeOrientation;
    const win = J([{ deg: 0, lines: 10, conf: 90 }, { deg: 180, lines: 4, conf: 95 }]);
    eq(win.deg, 0, '首遍行数最多 ⇒ 用首遍');
    eq(win.adopted, false);
    eq(win.suspicious, false, '对手明显更差 ⇒ 不是"方向可疑"');

    const adopt = J([{ deg: 0, lines: 2, conf: 90 }, { deg: 180, lines: 9, conf: 60 }]);
    eq(adopt.deg, 180, '行数**严格更多** ⇒ 采用');
    eq(adopt.adopted, true);

    const tie = J([{ deg: 0, lines: 5, conf: 70 }, { deg: 270, lines: 5, conf: 95 }]);
    eq(tie.deg, 270, '行数相同取 conf 高者');
    eq(tie.adopted, true);

    const flat = J([{ deg: 0, lines: 5, conf: 70 }, { deg: 270, lines: 5, conf: 70 }]);
    eq(flat.deg, 0);
    eq(flat.adopted, false, '打平不算更优');
    eq(flat.suspicious, true, '★ 有对手打平却没采用 ⇒ 保留首遍并标「方向可疑」');

    const tiny = J([{ deg: 0, lines: 5, conf: 70 }, { deg: 180, lines: 5, conf: 70.5 }]);
    eq(tiny.adopted, false, 'conf 差不到 1 分不算"更优"（同一档识别的抖动就在这个量级）');

    const input = [{ deg: 0, lines: 5, conf: 70 }, { deg: 180, lines: 6, conf: 71 }];
    const snap = JSON.stringify(input);
    deepEq(J(input), J(input), '同输入同输出');
    eq(JSON.stringify(input), snap, '判决不许改写入参（纯函数）');
  });

  await test('★ 不变量 4：触发判据与试转遍数（D-14.3 三条判据 / 额外 2 遍与 3 遍）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    const N = P.needsRotation, R = P.rotationsFor;
    truthy(N({ conf: 65, lines: 2, rawLines: 10, text: 'ab' }), 'conf<70 ⇒ 试转');
    /* 【S2-d 真机回归样本（2026-10-06）】PP-OCR 在**倒置**图上首遍会读出 3 行 conf 59 的"貌似合理"
     * 文本（真机：`lines=3 / rawLines=4 / conf=59`）—— 既不是空文本，也不满足"保留行 < rawLines×0.5"。
     * 旧条件 `conf<70 && lines<3` 因此**一次试转都不做**（`tried=0`），`rot180` 被判未命中。
     * 这条样本就是那次事故的最小复现，钉住"只看 conf"这个换引擎后的校准。 */
    truthy(N({ conf: 59, lines: 3, rawLines: 4, text: '一二三' }),
      '★ rot180 回归样本：conf 59 / 保留 3 行也必须试转（旧条件在这里漏判）');
    truthy(N({ conf: 90, lines: 4, rawLines: 10, text: '' }), 'text 为空 ⇒ 试转');
    truthy(N({ conf: 90, lines: 4, rawLines: 10, text: 'abcd' }), '保留行 < rawLines×0.5 ⇒ 试转');
    falsy(N({ conf: 92, lines: 10, rawLines: 10, text: 'abcdefghij' }), '读得干净 ⇒ 不试转（不许无脑 3×）');
    deepEq(P.ROT_ORDER, [180, 270, 90], '试转顺序 180 → 270 → 90');
    eq(R({ lines: 0, text: '' }), 3, '首遍全空 ⇒ 放宽到 3 遍（共 4 遍）');
    /* 放宽条件与触发条件**必须同源** —— 两次真机事故（S1-c 的 90°、S2-d 的 180°）都是这两处不同源。
     * 2026-10-06 换引擎后触发条件从 `conf<70 && lines<3` 变成只看 `conf<70`，这里同步跟着改。 */
    eq(R({ lines: 1, text: 'x' }), 3, '只读到 1 行（几乎没读到）⇒ 同样放宽到 3 遍');
    eq(R({ conf: 59, lines: 3, text: '一二三' }), 3, '★ rot180 回归样本：低置信也要试满 3 遍（90° 那一遍必须走到）');
    eq(R({ conf: 92, lines: 8, text: 'xxxxxxxx' }), 2, '读得干净 ⇒ 常规只额外 2 遍（共 3 遍）');
    /* 【S3-① 小角度纠偏】`pickTilt` 判据：只在 (1.5°, 9°] 里挑，且必须比 0° 强 ≥8%。
     * 真机事故的最小复现：整幅歪 5° ⇒ conf 0 / 行 0/12（歪 2° 尚有 58%），而试转只做 90 的倍数。 */
    const T = P.pickTilt;
    eq(T([{ deg: 0, v: 1000 }, { deg: 5, v: 1300 }]), 5, '★ 5° 候选明显更强（+30%）⇒ 纠 5°');
    eq(T([{ deg: 0, v: 1000 }, { deg: -6, v: 1400 }, { deg: 8, v: 1200 }]), -6, '取最强那个（含负角）');
    eq(T([{ deg: 0, v: 1000 }, { deg: 4, v: 1050 }]), 0, '只强 5%（<8%）⇒ 宁可不纠，别把好图转歪');
    eq(T([{ deg: 0, v: 1000 }, { deg: 20, v: 9000 }]), 0, '超过 9° 不归它管（交给试转那套）');
    eq(T([{ deg: 0, v: 1000 }, { deg: 1, v: 9000 }]), 0, '不到 1.5° 不算倾斜');
    eq(T([{ deg: 0, v: 1000 }]), 0, '只有 0° ⇒ 不纠');
    deepEq(P.TILT_CANDIDATES, [-8, -6, -4, -2, 2, 4, 6, 8], '候选角不含 0（0 由调用方补）');
    /* 【S3-③ 采用闸】真机事故：首遍读空时 270° 那遍给出 5 行 conf 80 全垃圾，靠"行数多"被采用。
     * 22 例真机的"真阳性采用"conf 是 92–100 ⇒ 85 这条线分开它们。 */
    const IC = P.isCredible;
    eq(P.ADOPT_MIN_CONF, 85, '线是 85（真阳性 92–100 vs 垃圾采用 80）');
    truthy(IC({ conf: 92, lines: 5 }), '★ rot90 那种真阳性（conf 92）必须放行');
    truthy(IC({ conf: 100, lines: 11 }), '小角度纠偏（conf 100）放行');
    falsy(IC({ conf: 80, lines: 5 }), '★ 密排图那次垃圾采用（conf 80）必须拦下');
    falsy(IC({ conf: 0, lines: 0 }), 'conf 0 不可信');
    truthy(IC({ conf: 90, lines: 1 }, { minConf: 80 }), '闸门可被显式覆盖（A/B 实测用）');
    /* 【S3-⑤ 密排重采倍数】3 不是随手取的：det 把长边取 clamp(0.75×长边, 960, 1920)、我们的重采显式
     * 覆盖 scaleFor ⇒ k=2 只能到 30px 行高，900k ≥ 2560（k≥2.84）才顶到 det 的 1920 上限（42.7px）
     * ⇒ 3 是"拿到 det 最大分辨率"的最小倍数（109 上 2× 救不回密排页）。改这个值必须重跑 109 用例集。 */
    eq(P.DENSE_RESCALE, 3, '密排重采倍数 = 3（顶到 det 1920 上限的最小倍数）；改它要重跑 109 的 22 例');
    /* 【S3-⑥ 密排切带】横带计划：横图也必须按 y 切 —— `layoutChunks` 沿长边切，横图会被切成竖带、
     * 把每行从中间切断（实测：竖切 2 条在 154 上只剩 1 行）。条数与重叠都是真机量出来的：
     * 109 上 2 条（364 高、重叠 128）det 只给 2–5 行且关键词仍丢，3 条（264 高、重叠 64）关键词回来。 */
    eq(P.DENSE_BANDS, 3, '切带三条（109 实测：2 条 364 高救不回关键词，3 条 264 高能）');
    const bp = P.bandPlan(900, 600);
    eq(bp.chunks.length, 3, '900×600 ⇒ 3 条');
    truthy(bp.chunks.every((c) => c.x === 0 && c.w === 900 && c.axis === 'y'),
      '★ 每条都是**横带**（x=0、全宽），不许切成竖带（竖带会切断每行）');
    eq(bp.chunks[0].y, 0, '第一条从 0 开始');
    eq(bp.chunks[1].y, 200, '步进是等分（ceil(600/3)）—— 带高不随重叠膨胀');
    eq(bp.chunks[0].h, 264, '带高 = 等分 + 重叠（264 = 200 + 64）');
    const bLast = bp.chunks[bp.chunks.length - 1];
    eq(Math.min(600, bLast.y + bLast.h), 600, '必须覆盖到图底（不许少读一半）');
    truthy(bp.chunks[1].y < bp.chunks[0].y + bp.chunks[0].h, '相邻两条有重叠 ⇒ 不会正好把一行切成两半');
    truthy(bp.overlap >= 24 && bp.overlap < P.MIN_OVERLAP,
      '★ 密排带的重叠**故意小于**海报那套的 MIN_OVERLAP（重叠越大带越高，带里行越多 det 越丢）');
    eq(bp.coverage.usedChunks, 3, 'coverage 如实写"用了 3 块"（面板照这个告知）');
    eq(bp.coverage.coveredTo, 600);
    falsy(bp.coverage.truncated, '三条不会触发截断');
    eq(P.bandPlan(900, 8000).chunks.length, 3, '长图也切三条（是否启用由接线处的"单块 + h≥400"闸门决定）');
    /* 档位：同一张图在某个带高下读得到、换个带高就读不到（109 常规字重那张：3 条 ✗、4 条 ✗、5 条 ✓）
     * ⇒ 从粗到细两档，接线处逐档扫、命中即停。 */
    const plans = P.denseBandPlans(900, 600);
    eq(plans.length, 2, '两档：3 条 → 5 条');
    eq(plans[0].chunks.length, 3);
    eq(plans[1].chunks.length, 5, '细档 5 条（每条 160 高 = 120 + 40 重叠）');
    eq(plans[1].chunks[0].h, 160);
    eq(plans[1].chunks[1].y, 120, '细档步进 = ceil(600/5) = 120');
    eq(Math.min(600, plans[1].chunks[4].y + plans[1].chunks[4].h), 600, '细档也要覆盖到图底');
    eq(P.denseBandPlans(900, 10).length, 2, '矮图照样两档（3 条 vs 5 条）—— 条数不同才试');
    eq(P.denseBandPlans(900, 2).length, 1, '矮到两档条数相同 ⇒ 只留一档（不白扫一遍）');

    /* 【S3-⑥ 候选取舍】关键词命中优先于行数/置信度 —— 154 上"两条横带"有 16 行却恰好丢了关键词那行。 */
    const PB = P.picksBetter;
    truthy(PB({ lines: 7, conf: 99 }, { lines: 16, conf: 84 }, 1, 0),
      '★ 命中 1 个的 7 行候选胜过多 9 行但零命中的候选（只看行数会挑错）');
    truthy(PB({ lines: 16, conf: 84 }, { lines: 7, conf: 99 }, 1, 0), '反过来同样成立：命中数说了算');
    truthy(PB({ lines: 3, conf: 90 }, { lines: 8, conf: 60 }, 0, 0), '都零命中 ⇒ 可信（conf 90）胜不可信（conf 60）');
    falsy(PB({ lines: 8, conf: 60 }, { lines: 3, conf: 90 }, 0, 0), '不可信的行多也赢不了可信的');
    truthy(PB({ lines: 8, conf: 90 }, { lines: 3, conf: 90 }, 0, 0), '同等条件下行多者胜');
    falsy(PB({ lines: 3, conf: 90 }, { lines: 8, conf: 90 }, 0, 0), '行少者不胜');
    truthy(PB({ lines: 3, conf: 95 }, { lines: 3, conf: 90 }, 0, 0), '行数相同 ⇒ conf 高者胜');
  });

  /* ---------------- 第 4 项：长图跨块同一行重复（T08 真机取证后补） ---------------- */

  await test('★ 第 4 项：重叠带必须从 plan 实际几何算（不许写死 240）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    const plan6 = P.planChunks(1080, 8000);
    const b6 = P.overlapBands(plan6.chunks);
    eq(b6.length, 5, '6 块 ⇒ 相邻 5 条重叠带');
    eq(b6[0].a, 0);
    eq(b6[0].b, 1);
    eq(b6[0].lo, 1360, '第 0/1 块的重叠带 = [1360, 1600]（= 下一块的起点）');
    eq(b6[0].hi, 1600);
    eq(b6[0].axis, 'y');
    truthy(b6.every((x) => x.hi - x.lo === plan6.overlap), '带高 = 计划的 overlap（240）');
    /* 密排那套（S3-⑥ 切带）带高只有 64 —— 写死 240 会错到 4 倍，正是本函数要求"从几何算"的原因 */
    const bp = P.bandPlan(900, 600);
    const bb = P.overlapBands(bp.chunks);
    eq(bb.length, 2);
    eq(bb[1].lo, 400);
    eq(bb[1].hi, 464, '密排带高 64（= bandPlan 的 overlap），不是 240');
    truthy(bb.every((x) => x.hi - x.lo === bp.overlap));
    /* 换块高 ⇒ 重叠跟着变（overlapFor(800) 夹到下限 128），进一步证明不是常量 */
    const p8 = P.planChunks(1080, 3000, { chunkH: 800 });
    const b8 = P.overlapBands(p8.chunks);
    eq(p8.overlap, 128);
    eq(b8[0].hi - b8[0].lo, 128, '块高 800 ⇒ 重叠 128');
    eq(P.overlapBands(plan6.chunks.slice(0, 1)).length, 0, '只有一块 ⇒ 没有重叠带');
    eq(P.overlapBands([]).length, 0, '空计划 ⇒ 空数组');
    /* 横带（axis x）也要按 x 算 —— layoutChunks 在横图上沿长边切竖带 */
    const hz = P.planChunks(8000, 1080);
    const bz = P.overlapBands(hz.chunks);
    eq(bz[0].axis, 'x', '横图切的是竖带 ⇒ 重叠带按 x 轴算');
    eq(bz[0].hi - bz[0].lo, hz.overlap);
  });

  await test('★ 2.0.2.5 需求②：块在**任一**方向都不许超过上限（竖图的横带也要切竖列）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 用户案例 1：2480×3360。旧版只沿长边切 ⇒ 横带 2480×1600，长边 = **图宽 2480** > MAX_EDGE(1600)
     * ⇒ `scaleFor` 缩到 0.645、厂商 det 再 ×0.75 ⇒ 有效 0.48，正文整行消失（真机只读到 8 行、
     * 软件名称/版本/著作权人 全丢；同一张图裁 1600×1600 能读到 10 行）。 */
    const p = P.planChunks(2480, 3360);
    eq(p.chunks.length, 6, '2480×3360 ⇒ 3 行 × 2 列 = 6 块（块高/列宽 1600，重叠 240、步长 1360）');
    truthy(p.chunks.every((c) => c.w <= 1600 && c.h <= 1600), '每一边都不许超过 1600（否则块内就得缩、小字丢在那一刀上）');
    const c0 = p.chunks[0], c1 = p.chunks[1];
    eq(c0.x + ':' + c0.y + ':' + c0.w + ':' + c0.h, '0:0:1600:1600', '首块 = 左上 1600×1600');
    eq(c1.x + ':' + c1.y + ':' + c1.w + ':' + c1.h, '1360:0:1120:1600', '同带右块起点 1360、末列贴边截断到 1120');
    truthy(p.chunks.every((c) => P.scaleFor(c.w, c.h) === 1), '★ 6 块全部落回"1:1 不缩"——任何一块被缩都会把它那一块的小字抹掉');
    eq(p.coverage.totalChunks, 6);
    eq(p.coverage.coveredTo, 3360, '覆盖率照旧覆盖到图底');

    /* 二维下"相邻"≠"下标相邻"：跨列、跨行都要算重叠带 */
    const b = P.overlapBands(p.chunks);
    truthy(b.length > 0 && b.every((x) => x.hi > x.lo), '每条带都非空');
    truthy(b.some((x) => x.a === 0 && x.b === 1 && x.axis === 'x' && x.lo === 1360 && x.hi === 1600),
      '★ 同一横带里左右两块算 x 轴邻接');
    truthy(b.some((x) => x.a === 0 && x.b === 2 && x.axis === 'y' && x.lo === 1360 && x.hi === 1600),
      '★ 上下两带的同列两块算 y 轴邻接（下标差 2，旧口径"只配下标相邻"直接漏掉它）');

    /* 一维切块与旧口径逐条等价：窄长图跨轴 1080 < 1600 ⇒ 一根横带都不多切 */
    const p1 = P.planChunks(1080, 8000);
    eq(p1.chunks.length, 6, '窄长图仍是 6 块（不许把今天的单列路径弄坏）');
    eq(P.overlapBands(p1.chunks).length, 5, '窄长图仍是 5 条带');
    truthy(p1.chunks.every((c) => c.x === 0 && c.w === 1080), '窄长图仍然整幅宽（跨轴没超上限就不切）');
  });

  await test('★ 2.0.2.5 · 独立验收 H1：矩形不相交的两块绝不许产出重叠带', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 2480×3360 的 6 块里，c0(0,0,1600,1600) 与 c5(1360,2720,1120,640)：x 部分相交、y 完全不相交。
     * 旧版只判单轴 ⇒ 产出 x 带 [1360,1600]；那条带的池子只按 x 过滤、**y 不设限**
     * ⇒ 相距两三千像素的两条同文本行会被配成"同一物理行"互删（静默丢字）。 */
    const c0 = { x: 0, y: 0, w: 1600, h: 1600 };
    const c5 = { x: 1360, y: 2720, w: 1120, h: 640 };
    eq(P.overlapBands([c0, c5]).length, 0, 'y 完全不相交 ⇒ 一条带都不许有（哪怕 x 部分相交）');
    /* 真交叠的接缝仍要在：对角相邻的 c0/c3 共享 [1360,1600]×[1360,1600] ⇒ x、y 各一条 */
    const c3 = { x: 1360, y: 1360, w: 1120, h: 1600 };
    const b3 = P.overlapBands([c0, c3]);
    eq(b3.length, 2, '对角真交叠 ⇒ x、y 各一条带');
    truthy(b3.every((x) => x.lo === 1360 && x.hi === 1600), '两条带都收在共享矩形 [1360,1600] 上');
    /* 整张计划：每条带的两块都必须真的相交（旧版 444 条带里 270 条不相交 = 61%） */
    const p = P.planChunks(2480, 3360);
    const bs = P.overlapBands(p.chunks);
    const hit = (b) => {
      const a = p.chunks[b.a], c = p.chunks[b.b];
      return !(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y);
    };
    eq(bs.filter((b) => !hit(b)).length, 0, '不相交的带必须是 0 条，实际 ' + bs.length + ' 条里 ' + bs.filter((b) => !hit(b)).length);
    /* 一维路径逐条不变 */
    eq(P.overlapBands(P.planChunks(1080, 8000).chunks).length, 5, '窄长图仍是 5 条带');
  });

  await test('★ H1 第二道：x 带的池子不设 y 限 ⇒ 配对必须再要一条垂直容差', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 横带里左右相邻两列：y 跨度相同 ⇒ 只有 x 带；池子按 x 过滤后 y 完全不设限 */
    const pair = [{ x: 0, y: 0, w: 1600, h: 1600 }, { x: 1360, y: 0, w: 1120, h: 1600 }];
    eq(P.overlapBands(pair).length, 1, '左右邻居：只有 x 轴邻接（y 上互相含住 ⇒ 不算邻接）');
    eq(P.overlapBands(pair)[0].axis, 'x');
    const L = (t, y, ci, x) => ({ t: t, conf: 95, y: y, x: x == null ? 1400 : x, ci: ci });
    eq(P.mergeOverlap([L('备注', 200, 0), L('备注', 2800, 1)], pair).merged, 0,
      '★ 同文本但 y 差 2600 ⇒ 不是同一物理行，绝不许互删');
    eq(P.mergeOverlap([L('备注', 200, 0), L('备注', 203, 1)], pair).merged, 1, 'y 差 3 ⇒ 同一物理行，照旧去重');
  });

  await test('★ 第 4 项：mergeOverlap 四条同时成立才丢 + 一对一（含反向守卫）', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 两块：块 0 = y∈[0,400]、块 1 = y∈[264,664] ⇒ 重叠带 = [264, 400] */
    const pair = [
      { x: 0, y: 0, w: 900, h: 400, axis: 'y' },
      { x: 0, y: 264, w: 900, h: 400, axis: 'y' }
    ];
    const L = (t, y, ci, x) => ({ t: t, conf: 95, y: y, x: x == null ? 10 : x, ci: ci });

    eq(P.OVERLAP_MATCH_X, 16, '实测 |Δx| ≤ 5px ⇒ 取 ~3 倍余量 16（回执 overlap.maxDx 会如实上报，供再收）');

    /* ① 同带 + ci 不同 + 文本相等 + |Δx| ≤ 16 ⇒ 丢一条；保留 y 较小者 */
    const a = P.mergeOverlap([L('abcd', 320, 0), L('abcd', 300, 1)], pair);
    eq(a.merged, 1);
    eq(a.lines.length, 1);
    eq(a.lines[0].y, 300, '保留 y 较小者（同一行在两块里的 y 换算差是噪声）');
    eq(a.lines[0].ci, 1, '留下的是块 1 那条（y 更小）');
    eq(a.maxDy, 20, '回执如实报配对的 |Δy| 上界');
    eq(a.maxDx, 0);

    /* ② **这就是真机复现的那一类**：两次识别只差空白位置，旧的 `prev.t === l.t` 严格全等判不中 */
    const ws = P.mergeOverlap([L('第75行12.00', 300, 0), L('第75行 12.00', 300, 1)], pair);
    eq(ws.merged, 1, '★ 空白位置不同 = 同一行（keyOf 删掉全部空白）；严格全等会漏，这就是用户看到的重复行');
    eq(ws.lines.length, 1);
    /* 但**大小写仍不折**（大小写是真实文本差异） */
    eq(P.mergeOverlap([L('Abcd', 300, 0), L('abcd', 300, 1)], pair).merged, 0, '大小写不同 ⇒ 不当同一行');
    eq(P.keyOf(' 第75行 12.00 '.replace(/\s+/g, '')), '第75行12.00');
    eq(P.keyOf('第75行12.00'), P.keyOf('第75行 12.00'), 'keyOf 只删空白');
    eq(P.keyOf('   '), '', '全空白 ⇒ 空键（不许当有效文本去配对）');
    eq(P.mergeOverlap([L('  ', 300, 0), L('   ', 300, 1)], pair).merged, 0, '空键不配对');

    /* ③ ci 必须不同：同块内两条归旧的 prev-only 那道兜底，不归这里 */
    eq(P.mergeOverlap([L('abcd', 300, 0), L('abcd', 350, 0)], pair).merged, 0, '同块两条 ⇒ 不在这里去重');
    /* ④ 必须落在同一重叠带内 */
    eq(P.mergeOverlap([L('abcd', 100, 0), L('abcd', 300, 1)], pair).merged, 0, '块 0 那条在带外（y=100 < 264）⇒ 不配对');
    eq(P.mergeOverlap([L('abcd', 300, 0), L('abcd', 600, 1)], pair).merged, 0, '块 1 那条在带外（y=600 > 400）⇒ 不配对');
    /* ⑤ |Δx| ≤ 16（边界：16 配对、17 不配对） */
    const dxOk = P.mergeOverlap([L('abcd', 300, 0, 10), L('abcd', 300, 1, 26)], pair);
    eq(dxOk.merged, 1, '|Δx| = 16 正好在闸内');
    eq(dxOk.maxDx, 16);
    eq(P.mergeOverlap([L('abcd', 300, 0, 10), L('abcd', 300, 1, 27)], pair).merged, 0,
      '|Δx| = 17 ⇒ 不当同一行（实测只到 5px，17 已是别的列）');

    /* ⑥ 一对一（**反向守卫**）：原图里真的重复两遍的文本，被两块各读两次 = 4 行 ⇒ 只配掉 2 条、仍留 2 条 */
    const dup = P.mergeOverlap([
      L('abc', 300, 0), L('abc', 340, 0), L('abc', 300, 1), L('abc', 340, 1)
    ], pair);
    eq(dup.merged, 2, '2 对 2 ⇒ 只能配掉 2 条');
    eq(dup.lines.length, 2, '★ 仍留 2 条：真重复的内容不许被吃成 1 条');
    /* 一对一：块 0 一条 vs 块 1 两条 ⇒ 只配掉一对 */
    const one2 = P.mergeOverlap([L('abc', 300, 0), L('abc', 300, 1), L('abc', 340, 1)], pair);
    eq(one2.merged, 1);
    eq(one2.lines.length, 2, '块 0 只有一条 ⇒ 块 1 那条多余的必须留着');

    /* ⑦ 没有重叠带（两块不相接）/ 只有一块 ⇒ 原样返回、merged=0（不改今天的单块路径） */
    const apart = P.mergeOverlap([L('abcd', 300, 0), L('abcd', 300, 1)],
      [{ x: 0, y: 0, w: 900, h: 100, axis: 'y' }, { x: 0, y: 200, w: 900, h: 100, axis: 'y' }]);
    eq(apart.merged, 0, '两块之间没有重叠区 ⇒ 不去重');
    eq(apart.lines.length, 2);
    const single = [L('abcd', 300, 0)];
    eq(P.mergeOverlap(single, [pair[0]]).merged, 0, '只有一块 ⇒ identity');
    truthy(P.mergeOverlap(single, [pair[0]]).lines === single, 'identity 必须原样返回同一个数组引用');
    eq(P.mergeOverlap(single, null).merged, 0, '没有 chunks ⇒ identity');
    eq(P.mergeOverlap([], pair).merged, 0, '没有行 ⇒ identity');
    /* ⑧ 没挂 ci 的行（老路径/未接线）一律不动 */
    eq(P.mergeOverlap([{ t: 'abcd', conf: 95, y: 300, x: 10 }, { t: 'abcd', conf: 95, y: 300, x: 10 }], pair).merged, 0,
      '没有 ci 就没法判"来自不同块" ⇒ 一条都不动');
  });

  await test('★ T22：OCR 错字造成的近失重复（第二遍配对）—— 保守，只吃同一物理行', () => {
    const P = loadOffscreen({ lines: () => null }).self.__khOcrPure;
    /* 与上一条同一套几何：块 0 = y∈[0,400]、块 1 = y∈[264,664] ⇒ 重叠带 = [264,400] */
    const pair = [
      { x: 0, y: 0, w: 900, h: 400, axis: 'y' },
      { x: 0, y: 264, w: 900, h: 400, axis: 'y' }
    ];
    const L = (t, y, ci, x, conf) => ({ t: t, conf: conf == null ? 95 : conf, y: y, x: x == null ? 10 : x, ci: ci });

    eq(P.NEAR_MATCH_DICE, 0.8, 'Dice 线 0.8：真机样本 0.93，而「第12行/第13行」这类兄弟行只有 0.75 ⇒ 两边都分开');
    eq(P.NEAR_MATCH_MAX_DY, 8, '同一物理行实测 |Δy| ≤ 5px（tight/flat 0–5、tall 2–4）⇒ 8 贴着实测；行距 24 的相邻行 |Δy| ≥ 19');
    eq(P.NEAR_CONF_MARGIN, 4, '真机那条真错字对 conf=92（错字「最进」）× 96（正确「跟进」）⇒ 差 4 才敢配对');

    /* ① 真机那一类：同一物理行、两块各读一次、各有错字（Dice 0.93）、**错字那条 conf 更低**
     * ⇒ 只留一条，且留下的必须是 conf 高的正确读法（第一版"留 y 小"把真值吃了：474 → 473） */
    const nm = P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 92), L('第377行2026-10-12', 305, 1, 10, 96)], pair);
    eq(nm.merged, 0, '逐字不等 ⇒ 第一遍不动它（这就是用户看到的残留重复）');
    eq(nm.near, 1, '★ 第二遍近失配对吃掉一条');
    eq(nm.lines.length, 1);
    eq(nm.lines[0].t, '第377行2026-10-12', '★ 留 conf 更高的那条（92 的错字那条被丢）');
    eq(nm.lines[0].conf, 96);
    /* ①b 反过来：conf 高的是「慎377行」那条 ⇒ 留下的也换过来（不是按 y、不是按 ci） */
    const nm2 = P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 96), L('第377行2026-10-12', 305, 1, 10, 92)], pair);
    eq(nm2.lines.length, 1);
    eq(nm2.lines[0].t, '慎377行 2026-10-12');
    /* ①c conf 一样（差 < 4）⇒ **两条都留**：宁可让用户看到重复，也不许猜错内容 */
    eq(P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 95), L('第377行2026-10-12', 305, 1, 10, 95)], pair).near, 0,
      'conf 差 0 < 4 ⇒ 不动（T22 红线：不许误删真实内容）');
    eq(P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 95), L('第377行2026-10-12', 305, 1, 10, 98)], pair).near, 0,
      'conf 差 3 < 4 ⇒ 也不动（差 4 才是真机验过的线）');

    /* ② 反向守卫：同样一对错字（conf 差够），但相距 80px（**不同物理行**）⇒ 一条都不许吃 */
    eq(P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 92), L('第377行2026-10-12', 380, 1, 10, 96)], pair).near, 0,
      '|Δy| = 80 ⇒ 不是同一行（真机里那对假匹配跨 139–148px，就靠这条挡）');
    /* ③ 反向守卫：Dice 不够（兄弟行「第12行/第13行」= 0.75）⇒ 不吃 */
    eq(P.mergeOverlap([L('第12行 12.00', 300, 0, 10, 90), L('第13行 12.00', 305, 1, 10, 96)], pair).near, 0,
      'Dice 0.75 < 0.8 ⇒ 宁可留重复，也不吃内容');
    /* ④ 短串（`keyOf` 长度 < 6）换**单字 Dice**：同一物理行上各带一个错字的短句必须配掉 ——
     *    用户真机样本：原文「你好啊」，切片 A 读成「尔好啊」、切片 B 读成「你好阿」。
     *    二元组 Dice = 0（{尔好,好啊} ∩ {你好,好阿} = ∅）⇒ 旧实现永远分两行。 */
    eq(P.NEAR_MATCH_SHORT_DICE, 1 / 3, '短串阈值 1/3：3 字里至少对上 1 个字（用户样本正好踩在这条线上）');
    const shortM = P.mergeOverlap([L('尔好啊', 300, 0, 10, 90), L('你好阿', 305, 1, 10, 96)], pair);
    eq(shortM.near, 1, '★ 两个错字的三字短句也要配掉（旧实现：长度闸 + 二元 Dice 双重漏过）');
    eq(shortM.lines.length, 1);
    eq(shortM.lines[0].t, '你好阿', '留 conf 高的那条');
    /* ④b 短串里一个字都对不上 ⇒ 仍不配（反向守卫：单字度量不是"随便配"） */
    eq(P.mergeOverlap([L('ab1', 300, 0, 10, 90), L('xy2', 305, 1, 10, 96)], pair).near, 0, '零交集仍不配');
    /* ④c 长×短不配（原长度闸的职责原样保留） */
    eq(P.mergeOverlap([L('ab1', 300, 0, 10, 90), L('abcdefg', 305, 1, 10, 96)], pair).near, 0, '长×短不配');
    eq(P.mergeOverlap([L('ab1', 300, 0, 10, 90), L('ab1cd', 305, 1, 10, 96)], pair).near, 0, '短串长度差 ≤ 1（差 2 已是别的内容）');
    eq(P.mergeOverlap([L('ab1', 300, 0, 10, 90), L('ab12', 305, 1, 10, 96)], pair).near, 1,
      '短串差一个字（多认/少认一个）⇒ 配掉，留字数多的那条');
    /* ④d 短串 conf 持平：几何已断言同一条物理行 ⇒ **不拿"分不出谁更对"当留两行的借口**，
     *    改按 字数 → y 定序，仍是只留一条（这正是用户要的"同一句话别出现两次"）。 */
    const shortTie = P.mergeOverlap([L('尔好啊', 300, 0, 10, 95), L('你好阿', 305, 1, 10, 95)], pair);
    eq(shortTie.near, 1, '短串同一物理行 + 几何吻合 ⇒ conf 持平也合并');
    eq(shortTie.lines.length, 1);
    eq(shortTie.lines[0].t, '尔好啊', 'conf 持平、字数相同 ⇒ 留 y 较小者（靠上那条）');
    /* ⑤ 长度差 > 2 不配（防「短串是长串子串」） */
    eq(P.mergeOverlap([L('北京 上海 广州', 300, 0, 10, 90), L('北京 上海 广州南站 东', 305, 1, 10, 96)], pair).near, 0,
      '长度差过大不配');
    /* ⑥ |Δx| 仍受 OVERLAP_MATCH_X 约束 */
    eq(P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 92), L('第377行2026-10-12', 305, 1, 40, 96)], pair).near, 0,
      '|Δx| = 30 > 16 ⇒ 不是同一列');
    /* ⑦ 一对一：原图里真的重复两遍（4 行）⇒ 只配掉 2 条、仍留 2 条 */
    const dup = P.mergeOverlap([
      L('慎377行 2026-10-12', 300, 0, 10, 92), L('慎377行 2026-10-12', 340, 0, 10, 96),
      L('第377行2026-10-12', 300, 1, 10, 96), L('第377行2026-10-12', 340, 1, 10, 92)
    ], pair);
    eq(dup.lines.length, 2, '★ 真重复的内容不许被吃成 1 条');
    /* ⑧ 逐字相等的仍走第一遍，两条通路不重叠 */
    const ex = P.mergeOverlap([L('供应商 甲', 300, 0, 10, 95), L('供应商甲', 305, 1, 10, 95)], pair);
    eq(ex.merged, 1);
    eq(ex.near, 0, 'keyOf 相等 ⇒ 第一遍就吃掉，不该记到近失上');
    /* ⑨ ci 必须不同：同块两条不许靠近失配对 */
    eq(P.mergeOverlap([L('慎377行 2026-10-12', 300, 0, 10, 92), L('第377行2026-10-12', 305, 0, 10, 96)], pair).near, 0,
      '同块 ⇒ 不在这里去重');
  });

  await test('★ 第 4 项（端到端）：相邻两块各读一次的同一行只留一条，回执如实报 overlap', async () => {
    /* 真机取证（1080×11560/480 行）的形状：同一物理行被相邻两块各读一次，
     * 两次只在空白位置不同 —— 第 0 块读成「供应商 甲」（bbox y0=1400 ⇒ 原图 y=1400），
     * 第 1 块读成「供应商甲」（bbox y0=40 ⇒ y=1360+40=1400）⇒ 都落在重叠带 [1360,1600] 里。 */
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 92, lines: [{ t: '供应商 甲', conf: 92, y: 1400, x: 4 }] }
        : i === 1
          ? { conf: 92, lines: [{ t: '供应商甲', conf: 92, y: 40, x: 4 }] }
          : { conf: 92, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r8', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('r8');
    eq(res.ok, true);
    eq(res.rawLines, 2, '两块各读出 1 行（原始 2 行）');
    eq(res.lines, 1, '★ 同一物理行只留一条（旧代码在 sort 前只比 prev、且要 t 严格全等 ⇒ 这里会留 2 条）');
    eq(res.overlap.merged, 1, '回执必须如实报"合并了几条"');
    eq(res.overlap.near, 0, 'T22 近失那一路不该抢第一遍的活（keyOf 相等 ⇒ near 记 0）');
    eq(res.overlap.maxDy, 0);
    eq(res.overlap.maxDx, 0);
    eq(res.bands, 6, '既有字段保持不动（additive）');
    eq(res.coverage.usedChunks, 6);
    eq(res.text.split('\n').length, 1, '文本里也只有一行');
    truthy(res.text.indexOf('供应商 甲') >= 0, '同 y 时留先出现的那条（块 0）');
    eq(env.calls.recognize, 6, '长图 6 块 ⇒ 6 次识别（去重不该多跑一遍）');
  });

  await test('★ 2.0.6 需求②：长图某块读空、但别的块证明这块有字 ⇒ 单独重采补回来', async () => {
    /* 6 块长图（1080×8000，块高 1600、重叠 240 ⇒ 块 i 覆盖 y = [1360i, 1360i+1600]）。
     * 假引擎给的是**块内坐标**（`linesFrom` 会加块偏移）：块 2 的 bbox y=1430 ⇒ 原图 4150，
     * 正落在块 3 的范围 [4080,5680] 里 ⇒ 旁证成立。块 3（第 4 次识别）读空 ⇒ 第 7 次识别
     * （块 3 放大重采）必须发生，否则那一块的字永久消失、回执还说成功。 */
    const env = loadOffscreen({
      lines: (i) => (i === 2
        ? { conf: 92, lines: [{ t: '招标公告 供应商', conf: 92, y: 1430, x: 4 }] }
        : i === 3
          ? { conf: 0, lines: [] }
          : i === 6
            ? { conf: 93, lines: [{ t: '补回来的字 4200', conf: 93, y: 120, x: 4 }] }
            : { conf: 92, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'rretry', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('rretry');
    eq(env.calls.recognize, 7, '★ 6 块 + 1 次补采（只补有旁证的空块）');
    eq(res.ok, true);
    truthy(res.text.indexOf('补回来的字') >= 0, '★ 补采到的行必须进结果');
    eq(res.coverage.usedChunks, 6, '切块计划不变（补采不重排块）');
  });

  await test('★ 2.0.6 需求②：读空的块没有旁证（本来就是空白带）⇒ 不许白跑一遍', async () => {
    const env = loadOffscreen({
      lines: (i) => (i === 0 ? { conf: 92, lines: [{ t: '招标公告 供应商', conf: 92, y: 20, x: 4 }] } : { conf: 92, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'rnoret', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('rnoret');
    eq(env.calls.recognize, 6, '★ 空白带读空属正常，重采会把长图成本翻倍');
    eq(res.ok, true);
  });

  await test('★ 用户真机复现（端到端）：三字短句被两个切片各读一次、各带一个错字 ⇒ 只留一条', async () => {
    /* 用户原话：原文「你好啊」，一个切片 OCR 成「尔好啊」、另一个成「你好阿」，会分两行展示。
     * 形状照 T22 那对（同一物理行 y=1400，块 1 的块内 y = 1400 − 1360 = 40）。 */
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 90, lines: [{ t: '尔好啊', conf: 90, y: 1400, x: 4 }] }
        : i === 1
          ? { conf: 96, lines: [{ t: '你好阿', conf: 96, y: 40, x: 4 }] }
          : { conf: 96, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'rshort', tabId: 7, keyword: '你好', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('rshort');
    eq(res.ok, true);
    eq(res.lines, 1, '★ 同一条物理行只留一条（旧实现：长度闸 + 二元 Dice 双重漏过 ⇒ 这里留 2 条）');
    eq(res.overlap.near, 1, '这一对记在近失配对的账上');
    eq(res.overlap.merged, 0, '逐字不等 ⇒ 第一遍不该认领它');
    eq(res.text.split('\n').length, 1, '最终文本里也只有一行');
    truthy(res.text.indexOf('你好阿') >= 0, '留 conf 高的那条');
    truthy(res.text.indexOf('尔好啊') < 0, 'conf 低的那条不许留下');
  });

  await test('★ T22 兜底（端到端）：同块相邻两条只差空白 ⇒ 只留一条（重叠带外 1px 那对真机残留）', async () => {
    /* 真机取证（tight 样张第 171 行）：同一物理行被相邻两块各读一次，块 2 那条 y=4079 落在重叠带
     * 下界(4080)**外 1px** ⇒ mergeOverlap 的入池闸收不到它；旧兜底又是 `prev.t === l.t` 严格全等
     * ⇒ 两行一路活到 text（用户看到重复行）。这里用"同一块内两条"把第一遍/第二遍都摘掉，
     * 只剩兜底能兜住 —— 它必须按 `keyOf`（去空白）归一化判同一行。 */
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 99, lines: [
            { t: '第171行12.00', conf: 99, y: 4079, x: 4 },
            { t: '第171行 12.00', conf: 100, y: 4084, x: 4 }
          ] }
        : { conf: 92, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r22', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('r22');
    eq(res.ok, true);
    eq(res.lines, 1, '★ 空白差异不算两行（旧兜底严格全等 ⇒ 这里会留 2 条）');
    eq(res.text.split('\n').length, 1, '落在页面文本里的也只有一行');
    eq(res.overlap.merged, 0, '第一遍（跨块逐字相等）没参与');
    eq(res.overlap.near, 0, '第二遍（近失配对）也没参与 —— 这活是兜底干的');
    truthy(res.text.indexOf('第171行 12.00') >= 0, '★ 留 conf 高的那条（100 > 99）—— 真机靠这条选对原图写法「第171行 12.00」');
    truthy(res.text.indexOf('第171行12.00') < 0, 'conf 低的那条不许留下');
  });

  await test('★ T22 兜底（端到端）：conf 持平时保 y 较小那条（同一条线两种读法不许两条都留）', async () => {
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 95, lines: [
            { t: '供应商甲', conf: 95, y: 1400, x: 4 },
            { t: '供应商 甲', conf: 95, y: 1403, x: 4 }
          ] }
        : { conf: 92, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r22b', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('r22b');
    eq(res.ok, true);
    eq(res.lines, 1, 'conf 持平也是一条（否则用户看到重复行）');
    truthy(res.text.indexOf('供应商甲') >= 0, 'y 较小的那条胜出');
  });

  await test('★ 不变量 1：告知字段的判决（全丢 / 截断 / 方向可疑 / 唯一允许静默的情形）', () => {
    const F = loadOffscreen({ lines: () => null }).self.__khOcrPure.noticeOf;
    eq(F({ lines: 0, rawLines: 20, conf: 0 }), 'no-text', '★ 全部 rawLines>0 而 lines=0 ⇒ **必须**告知（今天正是静默丢）');
    eq(F({ lines: 0, rawLines: 0, conf: 0 }), 'no-text', '一个字都没认出来，也不许假装"没有关键词"');
    eq(F({ lines: 9, rawLines: 12, conf: 88, truncated: true }), 'truncated', '触上限且读到了字 ⇒ 告知截断');
    eq(F({ lines: 9, rawLines: 12, conf: 88, suspicious: true }), 'tilted', '方向可疑 ⇒ 告知不可靠');
    eq(F({ lines: 9, rawLines: 12, conf: 40 }), 'tilted', '试转后仍 conf<50 ⇒ 不可靠');
    eq(F({ lines: 9, rawLines: 9, conf: 88 }), null, '**唯一**允许静默"未命中"：读到字、方向可信、确实没命中关键词');
  });

  await test('★ 没有关键词时不许赌 ASCII（2.0.1.17 右键任意图 OCR ⇒ 中文图要认得出）', () => {
    const F = loadOffscreen({ lines: () => null }).self.__khOcrPure.langsForKeyword;
    eq(F('').join('+'), 'chi_sim+eng', '★ 空关键词 ⇒ 中英双包（旧实现按 ASCII 判 ⇒ 只给 eng，中文图必然报「没认出文字」）');
    eq(F(undefined).join('+'), 'chi_sim+eng', '缺字段同上（右键入口本来就不带关键词）');
    eq(F('   ').join('+'), 'chi_sim+eng', '只有空白也当没有');
    eq(F('华为').join('+'), 'chi_sim+eng', '有关键词时口径不变');
    eq(F('AWS').join('+'), 'eng', '纯 ASCII 关键词仍只上 eng（快一倍）');
  });

  /* ---------------- 假引擎端到端：回执里到底有没有那些字段 ---------------- */

  await test('★ 不变量 1（端到端）：所有行被丢光 ⇒ 回执必须带 notice=no-text', async () => {
    const env = loadOffscreen({
      lines: () => ({ conf: 30, lines: [{ t: 'Tory', conf: 30, y: 20 }, { t: 'rr i', conf: 20, y: 60 }] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r1', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=800' });
    const res = await env.result('r1');
    eq(res.ok, true);
    eq(res.lines, 0, '低置信度行全被 keepLine 丢掉 —— 这正是今天"0 行而回执 ok:true"的现场');
    truthy(res.rawLines > 0, 'rawLines>0 是这条不变量的前提');
    eq(res.notice, 'no-text', '★ 必须带告知字段：rawLines>0 而 lines=0 不许静默返回"未命中"');
  });

  await test('★ D-14.4（端到端）：长图逐块回 progress，每条都带 requestId / index / total / hits', async () => {
    const env = loadOffscreen({
      lines: (i) => ({
        conf: 92,
        lines: [{ t: '供应商 名单 ' + i, conf: 92, y: 20 }, { t: '第二行 ' + i, conf: 90, y: 60 }]
      })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r2', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res = await env.result('r2');
    eq(res.bands, 6, '1080×8000 ⇒ 6 块');
    eq(res.coverage.usedChunks, 6);
    eq(res.coverage.truncated, false);
    eq(res.lines, 12, '每块 2 行 × 6 块');
    eq(res.notice, null, '读得干净又没截断 ⇒ 不许乱标告知字段');
    eq(env.calls.recognize, 6, '每块只识别一次（试转没被触发时不许白跑）');

    const prog = env.progress('r2');
    eq(prog.length, 6, '★ 每块完成回一次 progress（面板才能显示「识别中 3/6」）');
    eq(prog[0].index, 1);
    eq(prog[0].total, 6);
    eq(prog[5].index, 6);
    truthy(prog.every((p) => p.requestId === 'r2'), 'progress 必须带 requestId（否则 background 只能当全局脉冲续命）');
    truthy(prog.every((p) => p.phase === 'band'), 'phase 供面板区分「下载语言包」与「识别分块」');
    truthy(prog[0].hits >= 1, '进度里带上"已确认命中几处"，面板才能先说「已命中 2 处」');
    truthy(prog.every((p) => callsOf(env.calls.params, '6').length >= 6), '每块必须走 PSM 6（整块版面），不许再回 PSM 11');
  });

  await test('★ 不变量 4（端到端）：首遍全空 ⇒ 试转 180/270/90，只有严格更优才采用（并复用那一遍）', async () => {
    /* 【S3-② 之后的调用序】0=首遍 · 1=密排放大重采（首遍全空 ⇒ 会触发）· 2/3/4=180/270/90。
     * 所以"只有 90° 那遍读得到"写成 `i === 4`；识别总次数从 4 变 5。（这条也是"多了一次重采"的钉子） */
    const env = loadOffscreen({
      lines: (i) => (i === 4
        ? { conf: 91, lines: [{ t: '供应商 甲', conf: 91, y: 20 }, { t: '供应商 乙', conf: 90, y: 60 }] }
        : { conf: 0, lines: [] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r3', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=800' });
    const res = await env.result('r3');
    eq(res.orientation.deg, 90, '★ 转 90° 那遍行数最多 ⇒ 采用它');
    eq(res.orientation.adopted, true);
    eq(res.orientation.tried, 3, '首遍全空 ⇒ 放宽到 3 遍（180 / 270 / 90 都试过）');
    deepEq(res.orientation.candidates.map((c) => c.deg), [0, 180, 270, 90], '候选里要留下全部试过的角度（面板/探针要能复盘）');
    truthy(res.lines >= 2);
    eq(env.calls.recognize, 5, '采用的那一遍要**复用**；5 = 首遍 + 密排放大重采 + 3 遍试转（已识别的块不重复烧）');
  });

  await test('★ S3-⑥（端到端）：密排小图"读到一些行却零命中" ⇒ 按横带切三条重扫；长图不许再叠一层', async () => {
    /* 109 真机形状：900×600/24 行小字，首遍/重采都只读到几行、一个字都没命中（conf 还很高 ⇒
     * 采用闸拦不住）。切成三条横带后每遍只喂十几行，det 召回上去且关键词回来了。 */
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 95, lines: [{ t: '费用结算说明', conf: 95, y: 20 }] }              // 首遍：1 行、零命中
        : i === 1
          ? { conf: 92, lines: [{ t: '供应商 甲', conf: 92, y: 20 }, { t: '明细一', conf: 90, y: 60 }] }
          : { conf: 91, lines: [{ t: '供应商 乙', conf: 91, y: 20 }, { t: '明细二', conf: 90, y: 60 }] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r5', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=900;H=600' });
    const res = await env.result('r5');
    eq(res.ok, true);
    eq(env.calls.recognize, 4, '首遍 + 三条横带（首遍有行 ⇒ 不触发 3× 重采；结果可信 ⇒ 不试转）');
    eq(res.bands, 3, '采用的就是切带那一遍 ⇒ 面板如实说"分 3 块"');
    eq(res.coverage.usedChunks, 3);
    eq(res.lines, 6, '三条各 2 行 ⇒ 6 行（这是"整体替换"，不是把两遍文本并起来）');
    truthy(res.text.indexOf('供应商') >= 0, '★ 关键词必须回来（这正是 109 那例不绿的原因）');
    eq(res.notice, null, 'conf 91、没截断、方向可信 ⇒ 命中就是命中，不许挂告知字段');

    /* 长图（1080×8000）本来就按 1600 切了 6 块：再叠 3 条横带只会把块变大（4800 → 8000）⇒ 必须拦住。 */
    const env2 = loadOffscreen({
      lines: () => ({ conf: 95, lines: [{ t: '费用结算说明', conf: 95, y: 20 }] })
    });
    env2.job({ type: MSG.OCR_IMAGE, requestId: 'r6', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=8000' });
    const res2 = await env2.result('r6');
    eq(env2.calls.recognize, 6, '长图 6 块就 6 次识别 —— 不许再叠一层切带');
    eq(res2.bands, 6, '仍然是原来的 6 块');
    eq(res2.lines, 6, '每块 1 行');
  });

  await test('★ S3-⑥（端到端）：粗档（3 条）没命中 ⇒ 再加密到细档（5 条）；命中即停', async () => {
    /* 真机量到的形状：同一张图换个带高就读得到/读不到（109 常规字重那张 3 条 ✗、5 条 ✓）。
     * 所以接线处逐档扫 —— 第 1 档扫完仍零命中就加密一档，命中即停（粗档能成时不花细档的钱）。 */
    const env = loadOffscreen({
      lines: (i) => (i === 0
        ? { conf: 95, lines: [{ t: '费用结算说明', conf: 95, y: 20 }] }                       // 整图：1 行、零命中
        : i <= 3
          ? { conf: 90, lines: [{ t: '明细一', conf: 90, y: 20 }] }                            // 粗档 3 条：都零命中
          : { conf: 91, lines: [{ t: '供应商 丙', conf: 91, y: 20 }, { t: '明细二', conf: 91, y: 60 }] })
    });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r7', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=900;H=600' });
    const res = await env.result('r7');
    eq(env.calls.recognize, 9, '整图 1 次 + 粗档 3 条 + 细档 5 条（粗档没命中 ⇒ 才加密）');
    eq(res.bands, 5, '最终采用的是细档 ⇒ 面板如实说"分 5 块"');
    eq(res.lines, 10, '细档 5 条各 2 行');
    truthy(res.text.indexOf('供应商') >= 0, '★ 细档把关键词捞回来了');
  });

  await test('★ 不变量 3（端到端）：语言包未就绪必须如实回报，不许静默降级', async () => {
    const env = loadOffscreen({ lines: () => null }, { manifest: { packs: {} } });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'r4', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=1080;H=800' });
    const res = await env.result('r4');
    eq(res.ok, false, '★ 未就绪不许回 ok:true');
    eq(res.code, 'lang-missing', '必须带上"缺语言包"这个可执行的原因');
    eq(env.posts.filter((p) => p.type === MSG.OCR_RESULT && p.requestId === 'r4' && p.ok).length, 0,
      '★ 绝不能降级成一次"识别成功但没命中"');
    eq(env.calls.recognize, 0, '未就绪时一次识别都不许发起');
  });

  await test('★ 不变量 1/2 的"有人接"：回执字段必须真的接到用户可见的地方', () => {
    const img = read('src/features/img-ocr.js');
    const note = read('src/features/important-note.js');
    /* 2.0.2.15：条目状态词表（COPY）随「图片命中」分区删除，`notice` 三态不再翻译成短标签 ——
     * 现在它只落成条目的 `why`（灯箱/卡片都用得着"这图里没认出字"这条事实）。 */
    truthy(/notice/.test(img), 'img-ocr.js 必须消费回执的 notice（映射成条目 why）');
    truthy(/coverPx/.test(img), 'truncated 的覆盖像素必须有值可填（引擎侧要报实数）');
    truthy(/no-text|tilted|truncated/.test(img), 'notice 的三种取值至少要被条目接住');
    /* 灯箱把识别全文交到用户眼前 —— 回执里的 text 不能断在半路 */
    truthy(/text:\s*textBySrc/.test(note) || /cur && cur\.text/.test(note), '灯箱必须读条目上的识别全文');
  });

  /* ==================================================================
   * 图片命中 · 关键词命中数（2.0.2.4 需求③）
   *   用户现场：OCR 读成「登记 号」、图片命中词是「登记号」⇒ 面板说没命中。
   *   引擎侧这个计数有两个消费者，坏起来都不轻：
   *     ① 面板文案「已命中 N 处」—— 必须与内容脚本（按剔空白判）口径一致；
   *     ② **加密档重试的闸门**：`hitsOf(base.lines) === 0` 才从粗到细再识别好几轮 ⇒
   *        空白造成的假 0 会白白多跑最贵的那几档，正是用户说的"浪费资源"。
   * ================================================================== */
  suite('图片命中 · 关键词命中数（空白不得挡住命中 · 2.0.2.4 需求③）');

  await test('★ countHits：两侧都剔空白后按「行」计数', () => {
    const F = loadOffscreen({ lines: () => null }).self.__khOcrPure.countHits;
    eq(typeof F, 'function', 'countHits 必须挂在纯判决层 self.__khOcrPure 上（它是重试闸门，要能钉）');
    eq(F([{ t: '登记 号' }], '登记号'), 1, '原样 indexOf 会数成 0 的那种行');
    eq(F([{ t: '登记号' }], '登记号'), 1, '原样命中不许回归');
    eq(F([{ t: '登记 号' }], '登 记号'), 1, '关键词自带空白也剔');
    eq(F([{ t: '登记 号码' }], '登记号'), 1, '剔空白后是子串即算命中（与内容侧同口径）');
    eq(F([{ t: '登记 号' }, { t: '另一个 登记 号' }], '登记号'), 2, '按行计数：一行最多加一');
    eq(F([{ t: '无 关' }], '登记号'), 0);
    eq(F([{ t: '登记 号' }], '美女,登记号'), 1, '多词任一中即算命中（分隔符口径不变）');
    eq(F([], '登记号'), 0);
    eq(F([{ t: '登记 号' }], ''), 0, '没配关键词 ⇒ 0（不许把"没配词"说成命中）');
  });

  await test('★ 端到端：只差一个空白的两种写法 ⇒ 识别次数必须一样（空白不许买来额外重试）', async () => {
    const run = async (lineText) => {
      const env = loadOffscreen({ lines: () => ({ conf: 95, lines: [{ t: lineText, conf: 95, y: 20 }] }) });
      env.job({ type: MSG.OCR_IMAGE, requestId: 'r9', tabId: 7, keyword: '登记号', dataUrl: 'data:,W=900;H=600' });
      return { res: await env.result('r9'), calls: env.calls.recognize };
    };
    const spaced = await run('登记 号 A123');
    const tight = await run('登记号 A123');
    eq(spaced.res.ok, true, '两种写法都要正常出结果');
    /* ★ 这一条就是"浪费资源"的入口：空白导致假 0 命中 ⇒ 加密档（粗/细两轮共 8 次）白跑 */
    eq(spaced.calls, tight.calls, '空白不许买来额外的加密档重试');
  });

  /* ==================================================================
   * 需求②（2.0.2.4）：**同一张图只识别一次**
   *
   * 【用户原话】「关键词a，抓取字段：截图，图片命中词，一对一；关键词b，抓取字段：截图，
   *   图片命中词，美女。这种情况会重复识别，浪费资源。同一个抓取字段，即使被多个词调用
   *   图片ocr命中，也只需要识别一次就行。」
   * 【为什么内容侧的去重不够】内容侧按 `src` **串**去重（img-ocr.js 的 `inflight`/`textCache`）：
   *   跨源 blob: 走 canvas 的回执里没有 src、srcset 换址后字符串变了、200 条 FIFO 挤掉旧图——
   *   三种情况下同一张图都会被再识别一遍。引擎侧按**图片字节**缓存整笔回执，才兜得住。
   * 【为什么要按档隔离】语言包决定模型、引擎决定路径；vendor 的 `globalImageCache` 只认字节
   *   不认语言，直接吃它的缓存会串档 ⇒ 我们自建一层，键里带引擎与语言包。
   * ================================================================== */
  suite('图片命中 · 同图只识别一次（2.0.2.4 需求②）');

  const LINES = () => ({ conf: 95, lines: [{ t: '供应商 甲', conf: 95, y: 20 }] });

  await test('★ 同一张图（同字节）换了 src 串 ⇒ 只识别一次，第二笔如实标 cached', async () => {
    const env = loadOffscreen({ lines: LINES });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c1', tabId: 7, keyword: '供应商', src: 'https://a.example/1.png', dataUrl: 'data:,W=300;H=200' });
    const first = await env.result('c1');
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c2', tabId: 7, keyword: '供应商', src: 'https://b.example/2.png', dataUrl: 'data:,W=300;H=200' });
    const second = await env.result('c2');
    eq(first.ok, true, '第一笔要正常出结果');
    eq(env.calls.recognize, 1, '同一张图（字节相同）只许烧一次识别 —— src 串不同不是重识别的理由');
    eq(second.cached, true, '命中缓存要如实标记（真机与单测都靠它核对"只烧了一次"）');
    eq(second.text, first.text, '缓存命中的文本必须与原识别一致');
    eq(second.lines, first.lines, '行数等读数一并复用');
    eq(second.engine, 'tesseract', '引擎字段不许因缓存而缺失');
  });

  await test('★ 换一个关键词、本词在既有文本里命中 ⇒ 复用那一笔（票 #33 判据：调用数 = 1）', async () => {
    const env = loadOffscreen({ lines: () => ({ conf: 95, lines: [{ t: '供应商 甲 美女 乙', conf: 95, y: 20 }] }) });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c3', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=300;H=200' });
    await env.result('c3');
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c4', tabId: 7, keyword: '美女', dataUrl: 'data:,W=300;H=200' });
    const r4 = await env.result('c4');
    eq(env.calls.recognize, 1, '同一张图两个关键词 ⇒ 引擎只许烧一次（关键词不进缓存键）');
    eq(r4.cached, true, '复用那一笔要如实标 cached');
    eq(r4.text, '供应商 甲 美女 乙', '复用的文本与首笔一致');
  });

  await test('★ 换一个关键词且本词一个字都没配上、上一笔又没跑过加密档 ⇒ 不许拿"为别的词选的档"当结论', async () => {
    /* 保守方向：这一笔按自己的关键词跑完整条判决链（与加缓存前的行为一致 —— 缓存只会少烧钱，
     * 不许把"旧路径本来能改好的结果"吃掉）。LINES 里没有「美女」，且 base 有行、图高 200 < 400
     * ⇒ 上一笔压根没触发关键词驱动的加密档，那就不放行。 */
    const env = loadOffscreen({ lines: LINES });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c7', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=300;H=200' });
    await env.result('c7');
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c8', tabId: 7, keyword: '美女', dataUrl: 'data:,W=300;H=200' });
    const r8 = await env.result('c8');
    eq(env.calls.recognize, 2, '没配上的词必须自己重跑一遍判决链');
    eq(r8.cached === true, false, '没复用缓存就不许假装命中缓存');
  });

  await test('★ 不同的图（不同字节）不许互相顶替', async () => {
    const env = loadOffscreen({ lines: LINES });
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c5', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=300;H=200' });
    await env.result('c5');
    env.job({ type: MSG.OCR_IMAGE, requestId: 'c6', tabId: 7, keyword: '供应商', dataUrl: 'data:,W=300;H=201' });
    const r6 = await env.result('c6');
    eq(env.calls.recognize, 2, '字节不同（尺寸不同）⇒ 必须各识别一次');
    eq(r6.cached === true, false, '不同图不许被当成缓存命中');
  });

  await test('★ 缓存键必须含引擎与语言包、且**不得**含关键词（票 #33）', () => {
    const src = read('offscreen/ocr.js');
    const m = src.match(/const cacheKey = imgHash[^;]*;/);
    truthy(m, '缓存键必须按图片字节建（`const cacheKey = imgHash ? …`）');
    truthy(/kind/.test(m[0]) && /langs\.join/.test(m[0]), '引擎与语言包必须进键 —— 少了它们就会跨档串结果');
    eq(/keyword/i.test(m[0]), false, '关键词不许进缓存键：它只允许影响进度提示与要不要加密档重试');
  });
};

/** 小工具：数一下数组里等于某值的元素（读起来比 filter().length 顺） */
function callsOf(arr, v) {
  return arr.filter((x) => String(x) === String(v));
}
