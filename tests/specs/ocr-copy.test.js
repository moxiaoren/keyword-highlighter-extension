/* tests/specs/ocr-copy.test.js — OCR 用户可见文案的**唯一真源**（票 #17 D-17.1）
 * ----------------------------------------------------------------------------
 * 落地四条不变量（口径见 `_stage/wayfinder-ocr/rollout-18-phased-plan.md` §2.1）：
 *   9  面板条目的状态类：`idle`/`pending` **不得**归入 `bad`（进行中 ≠ 失败）
 *   10 `src/ui/ocr-copy.js` 是 OCR 文案的唯一真源（面板不得再硬编码；三处注册不得漏）
 *   11 `ocr-copy` 的键集合与 `img-ocr.js` **真正会产出的** why/终态集合对账（多一个少一个都红）
 *   12 `imgOcr` 存储白名单不得包含 10 个引擎参数中的任何一个（参数一律不给可配）
 *
 * 为什么这几条要进回归网：
 *   ① 不变量 9 是一条**真实缺陷**的修复（票 #17 新登记的 P0）—— 修复前 `important-note.js`
 *      把所有非 `done` 状态（含 `idle` 排队、`pending` 在跑）都套了 `bad` 类，于是 OCR
 *      **正常工作时**面板上显示的是一个**红底的「识别中…」**，用户第一反应是「出错了」。
 *      这种"靠人记得别改回去"的口径必须有断言，否则下次重构会静默复活。
 *   ② 不变量 11 是**证据式**对账而不是手抄清单：它直接去 `img-ocr.js` 源码里扫出所有
 *      `why` 字面量与 `classify()` 的返回字面量，再和文案表比集合 —— 引擎侧新增一种原因
 *      而文案表没跟上时，这里会红（而不是等用户看到「识别失败」四个字）。
 *   ③ 不变量 12 对应票 #17 D-17.7 的裁决「10 个引擎参数**全不给可配**」：
 *      唯一允许它们出现的地方是只读的「高级信息」折叠，**绝不能进存储白名单**。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 10 个引擎参数（票 #17 D-17.7：一律不给可配；只允许出现在只读「高级信息」里）
 *  S1-c 起分块参数换成 CHUNK_H / CHUNK_MAX（块高与块数上限），旧的 POSTER_MIN_H / MAX_BANDS 已删 */
const ENGINE_PARAMS = [
  'MAX_EDGE', 'TARGET_H', 'CHUNK_H', 'CHUNK_MAX', 'IDLE_MS',
  'PSM', 'CANVAS_MAX_EDGE', 'MIN_EDGE', 'CACHE_MAX', 'MAX_INFLIGHT'
];

/**
 * 文案表里**暂时还没有生产者**的键 —— 每个都必须写明归属票号。
 * 为什么允许"预留"：S1 与换引擎零耦合，而这些终态是 #12/#14/#16 的实现轮产物；
 * 先把文案与判定口径钉死，等生产者到位就自动生效（`keyOf()` 对表内键是直通的）。
 * **不允许出现没有票号的预留键** —— 那就是"加了键没人做"。
 */
const RESERVED = {
  'model-missing': '#12（主引擎模型未就绪）',
  'engine-unavailable': '#16（offscreen 能力不存在）',
  'engine-lost': '#16（引擎被销毁时在飞的 job）',
  timeout: '#16（看门狗：无进度 60s / 硬顶 120s）'
};

/** 造一条能命中某个键的最小 item（用于分辨率测试） */
function itemFor(key) {
  if (key === 'queued') return { state: 'idle' };
  if (key === 'running') return { state: 'pending' };
  if (key === 'hit') return { state: 'done', matched: [{ text: '一对一' }], text: '一对一' };
  if (key === 'miss') return { state: 'done', text: '别的字', keyword: '一对一' };
  if (key === 'fail') return { state: 'fail', error: '引擎炸了' };
  return { state: 'blocked', why: key, host: 'cdn.example.com' };
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.OcrCopy;

  suite('OCR 文案唯一真源（票 #17 D-17.1 / 不变量 9–12）');

  await test('★ 不变量 10：`KH.OcrCopy` 已注册，四个入口齐全', () => {
    truthy(C, 'src/ui/ocr-copy.js 没有注册 KH.OcrCopy（manifest 的 content_scripts 里加了吗？）');
    for (const fn of ['keyOf', 'tag', 'why', 'stateClass']) {
      eq(typeof C[fn], 'function', '缺少 KH.OcrCopy.' + fn);
    }
    truthy(Array.isArray(C.KEYS), 'KEYS 必须是数组');
    /* 键数写死是刻意的：新增一个原因键就必须来改这一行（顺带被迫想清楚归属与文案） */
    eq(C.KEYS.length, 21, '文案表的键数变了 —— 新增/删除原因键请同步本行与 RESERVED');
  });

  await test('★ 不变量 10：三处注册都在，且真源排在消费者之前', () => {
    const mf = JSON.parse(read('manifest.json'));
    const cs = ((mf.content_scripts || [])[0] || {}).js || [];
    truthy(cs.indexOf('src/ui/ocr-copy.js') >= 0, 'manifest.json 的 content_scripts 没注册 src/ui/ocr-copy.js');
    truthy(read('options/options.html').indexOf('../src/ui/ocr-copy.js') >= 0, 'options/options.html 没引入');
    truthy(read('popup/popup.html').indexOf('../src/ui/ocr-copy.js') >= 0, 'popup/popup.html 没引入');
    truthy(cs.indexOf('src/ui/ocr-copy.js') < cs.indexOf('src/features/important-note.js'),
      'src/ui/ocr-copy.js 必须排在 src/features/important-note.js 之前（消费者先拿到真源）');
  });

  await test('★ 不变量 9：进行中（idle / pending）不得归入 bad —— 票 #17 那条 P0 的修复口径', () => {
    eq(C.stateClass({ state: 'idle' }), 'wait', 'idle 必须是 wait（排队中不是失败）');
    eq(C.stateClass({ state: 'pending' }), 'wait', 'pending 必须是 wait（识别中不是失败）');
    eq(C.tag({ state: 'idle' }), '排队中…', 'idle 的折叠标签');
    eq(C.tag({ state: 'pending' }), '识别中…', 'pending 的折叠标签');
    /* 反过来也要钉死：**只有三个键是红的** —— 否则"别染红"会被改成"全都别染红" */
    const red = C.KEYS.filter((k) => (C.dump().class[k] || 'note') === 'bad').sort();
    eq(red.join(','), 'engine-unavailable,fail,timeout', '允许标红（bad 类）的键只能是这三个');
    /* 「读不到图 / 缺资产」必须是中性 note，不是红 */
    for (const k of ['cross-origin', 'lazy', 'invisible', 'too-small', 'no-src', 'scheme', 'bad-url', 'tainted', 'lang-missing', 'model-missing', 'engine-lost', 'truncated']) {
      eq(C.stateClass(itemFor(k)), 'note', k + ' 应该是中性 note（不是故障）');
    }
  });

  await test('★ 不变量 9：面板不再自己写死状态类与文案（源码契约）', () => {
    const src = read('src/features/important-note.js');
    truthy(/KH\.OcrCopy\.stateClass\(it\)/.test(src), 'important-note.js 的状态类必须来自 KH.OcrCopy.stateClass');
    truthy(/KH\.OcrCopy\.tag\(it\)/.test(src), '折叠标签必须来自 KH.OcrCopy.tag');
    truthy(/KH\.OcrCopy\.why\(it\)/.test(src), '展开说明必须来自 KH.OcrCopy.why');
    /* 旧写法必须换成唯一真源：**正面钉住那一行赋值**，比"否定一个宽松正则"稳
     * （`it.state === 'done' ?` 在"选正文还是选说明"那里是合法用法，不能一律禁） */
    truthy(/tag\.className = 'khin-imgtag ' \+ KH\.OcrCopy\.stateClass\(it\);/.test(src),
      'important-note.js 的标签类必须来自 KH.OcrCopy.stateClass（原来那句"非 done 一律 bad"必须已删除）');
    /* 搬进 ocr-copy 的那些句子不得在面板里复活 */
    const MOVED = ['读不到像素', '图还没加载', '图当前不可见', '原图太小', '识别引擎还没准备好语言包', '跨域（未授权'];
    const back = MOVED.filter((s) => src.indexOf(s) >= 0);
    eq(back.length, 0, 'important-note.js 里不该再硬编码这些文案（改文案请去 src/ui/ocr-copy.js）：' + back.join('、'));
    /* 样式表里 `wait` / `note` 两个类必须真有定义，否则"不红"是假的 */
    for (const cls of ['khin-imgtag.wait', 'khin-imgtag.note']) {
      truthy(src.indexOf(cls) >= 0, '缺少样式 ' + cls + '（状态类没有样式就等于没生效）');
    }
  });

  await test('★ 不变量 11：键集合与 img-ocr.js 真正会产出的 why/终态对账', () => {
    const src = read('src/features/img-ocr.js');
    const produced = new Set();
    /* `why` 的两种写法：对象字面量 `why: 'x'` 与赋值 `why = 'x'` */
    for (const m of src.matchAll(/why\s*[:=]\s*'([A-Za-z][\w-]*)'/g)) produced.add(m[1]);
    /* `classify()` 的返回字面量（`'ok' | 'invisible' | 'too-small'`）—— 只收非 ok 的 */
    for (const m of src.matchAll(/return\s*'(invisible|too-small)'/g)) produced.add(m[1]);
    /* `state==='fail'` 且 why 不在表内时归 `fail`（`keyOf()` 的兜底） */
    produced.add('fail');

    /* 引擎侧"如实告知"的键（`offscreen/ocr.js` 的 `noticeOf()` 返回值，S1-c/D-14.5）：
     * 它们的**生产者不在内容脚本**，而是经回执 `notice` 字段由 `img-ocr.js` 中转到条目上 ——
     * 所以对账要把"引擎产出"与"内容脚本中继"两段合起来看，否则这几个键会被误判成孤儿。 */
    const eng = read('offscreen/ocr.js');
    for (const m of eng.matchAll(/return\s*'(no-text|tilted|truncated)'/g)) produced.add(m[1]);
    /* 只认产出不够：引擎产了、内容脚本不接，面板上依旧是死键 —— 中继必须在 */
    for (const k of ['no-text', 'tilted', 'truncated']) {
      if (produced.has(k)) {
        truthy(/msg\.notice/.test(src), '引擎会产出 `' + k + '`，但 img-ocr.js 没中继回执的 `notice` 字段');
      }
    }

    const noCopy = [];
    for (const r of produced) if (C.KEYS.indexOf(r) < 0) noCopy.push(r);
    eq(noCopy.length, 0, 'img-ocr.js 会产出、但文案表里没有的原因：' + noCopy.join('、'));

    const known = new Set(['queued', 'running', 'hit', 'miss']);
    const orphan = C.KEYS.filter((k) => !produced.has(k) && !known.has(k) && !RESERVED[k]);
    eq(orphan.length, 0, '文案表里既没有生产者、也没登记归属票号的键：' + orphan.join('、'));

    for (const k of Object.keys(RESERVED)) {
      truthy(/^#\d+/.test(RESERVED[k]), '预留键 ' + k + ' 的归属必须写成 `#<票号>（原因）`');
    }
  });

  await test('★ 不变量 11 配套：每条原因都取得出非空的两级文案，且标签不超长', () => {
    const bad = [];
    for (const k of C.KEYS) {
      const it = itemFor(k);
      const gotKey = C.keyOf(it);
      if (gotKey !== k) bad.push(k + '：keyOf 归到了 ' + gotKey);
      const t = C.tag(it);
      const w = C.why(it);
      if (!t || !t.trim()) bad.push(k + '：折叠标签为空');
      if (!w || w.trim().length < 3) bad.push(k + '：展开说明为空/过短');
      /* 长度上限只卡**模板**：真实域名有长有短，那是数据不是文案（见 ocr-copy.js 的 MAX_TAG 注释） */
      const tpl = C.dump().copy[k].tag;
      if (tpl.length > C.MAX_TAG) bad.push(k + '：标签模板 ' + tpl.length + ' 字，超过上限 ' + C.MAX_TAG + '（' + tpl + '）');
      /* 占位符必须都被替换掉：残留 `{` 说明 varsOf 少给了一个变量 */
      if (/\{\w+\}/.test(t) || /\{\w+\}/.test(w)) bad.push(k + '：文案里有没被替换的占位符（' + t + ' / ' + w + '）');
    }
    eq(bad.length, 0, bad.join('\n      '));
    /* 跨域那条是唯一故意更长的：域名必须写出来（原 K63 口径），单独钉一下 */
    truthy(C.tag({ state: 'blocked', why: 'cross-origin', host: 'cdn.a.com' }).indexOf('cdn.a.com') >= 0,
      '跨域标签必须带出图片所在域名（否则用户不知道该授权谁）');
    /* 兜底：完全不认识的原因 → fail，且 error 缺失时有兜底串（不许出现 undefined/空） */
    eq(C.keyOf({ state: 'fail', why: '没见过的原因' }), 'fail', '不认识的原因必须兜底成 fail');
    truthy(C.why({ state: 'fail' }).indexOf('undefined') < 0, 'fail 的说明不许出现 undefined');
    /* done 态的三类「告知」必须顶掉"未命中"（S1-c / D-14.5）——
     * 长图只读了一半 / 一个字都没认出来，说成"未命中"就是撒谎 */
    for (const k of ['no-text', 'tilted', 'truncated']) {
      eq(C.keyOf({ state: 'done', why: k, text: '图里读到的字', keyword: '一对一' }), k,
        'done 且 why=' + k + ' 时必须显示原因，不许一句话说成未命中');
      eq(C.stateClass({ state: 'done', why: k }), 'note', k + ' 是「图/结果本身的问题」，不是引擎故障 ⇒ 中性底色');
    }
    eq(C.keyOf({ state: 'done', text: '别的字', keyword: '一对一' }), 'miss', '没有告知的 done 仍是未命中');
  });

  await test('★ 不变量 12：10 个引擎参数不得进存储白名单（票 #17 D-17.7：全不给可配）', () => {
    const st = read('src/platform/storage.js');
    const hits = ENGINE_PARAMS.filter((p) => new RegExp('\\b' + p + '\\b').test(st));
    eq(hits.length, 0, 'storage.js 里出现了引擎参数（它们是实现细节，不给用户调）：' + hits.join('、'));
    /* imgOcr 的写路径白名单 = 这三个键；再多就说明"又给 imgOcr 加配置了" */
    const keys = [];
    for (const m of st.matchAll(/^\s*(imgOcr\w*)\s*:/gm)) if (keys.indexOf(m[1]) < 0) keys.push(m[1]);
    eq(keys.sort().join(','), 'imgOcr,imgOcrKeyword,imgOcrMax',
      'imgOcr 的存储白名单变了 —— 新增键必须说明来意（票 #17 定的是"参数不给可配"）');
  });

  await test('★ S3-④：面板显示本次识别**真实**耗时（数字来自回执，不写死文案）', () => {
    /* 格式：秒 + 一位小数（803 → 0.8s / 1245 → 1.2s / 长图 11s → 11.0s） */
    eq(C.costLabel({ ocrMs: 803 }), '0.8s', '803ms 要显示成 0.8s');
    eq(C.costLabel({ ocrMs: 1245 }), '1.2s', '1245ms 要显示成 1.2s');
    eq(C.costLabel({ ocrMs: 11000 }), '11.0s', '长图 11s 要显示成 11.0s');
    /* 没有真实耗时 ⇒ 空串（面板据此不挂徽标）。**不许显示 0.0s / undefined / NaN**：
     * 排队中或引擎没跑到时，替引擎报"0 秒"就是在撒谎。 */
    for (const bad of [{}, { ocrMs: 0 }, { ocrMs: -1 }, { ocrMs: 'x' }, { ocrMs: null }, null]) {
      eq(C.costLabel(bad), '', '没有真实耗时时必须返回空串：' + JSON.stringify(bad));
    }
    truthy(C.costTip({ ocrMs: 803 }).indexOf('0.8s') >= 0, '悬停说明要带出同一个数字');
    eq(C.costTip({}), '', '没有耗时就没有悬停说明');
    /* 源码契约：面板必须从真源取，且样式必须真有定义（没样式＝看不见） */
    const src = read('src/features/important-note.js');
    truthy(/KH\.OcrCopy\.costLabel\(it\)/.test(src), '面板必须从 KH.OcrCopy.costLabel 取耗时（不许自己拼数字）');
    truthy(/KH\.OcrCopy\.costTip\(it\)/.test(src), '耗时徽标的悬停说明必须来自 KH.OcrCopy.costTip');
    truthy(src.indexOf('.khin-imgcost') >= 0, '缺少 .khin-imgcost 样式（没有样式就等于看不见）');
    /* 面板里不许出现"秒"这类中文（文案真源在 ocr-copy.js，这条防的是又写一套） */
    eq(src.indexOf('识别耗时'), -1, '面板里不该硬编码"识别耗时"（改文案请去 src/ui/ocr-copy.js）');
  });
};
