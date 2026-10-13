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
  /* 2.0.1.17 右键任意图 OCR：与 hit/miss 同类的**派生键**（由 `via` 派生，不由 `why` 派生） */
  if (key === 'ctxmenu') return { state: 'done', via: 'contextMenu', text: '识别出来的字' };
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
    eq(C.KEYS.length, 22, '文案表的键数变了 —— 新增/删除原因键请同步本行与 RESERVED');
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
    for (const k of ['lazy', 'invisible', 'too-small', 'no-src', 'scheme', 'bad-url', 'tainted', 'lang-missing', 'model-missing', 'engine-lost', 'truncated']) {
      eq(C.stateClass(itemFor(k)), 'note', k + ' 应该是中性 note（不是故障）');
    }
    /* T21（用户 2026-10-13 拍板）：跨域未授权**单独一类 action** —— 不红（读不到图不是故障），
     * 也不能混进 note（note 是"用户没事可做"的纯告知；这条用户照着域名填一行就能读）。
     * 面板的 imgRowVisibleByDefault() 依赖这个类：默认视图必须把它露出来，不许静默隐藏。 */
    eq(C.stateClass(itemFor('cross-origin')), 'action', '跨域未授权必须是 action 类（默认视图常显）');
    eq(C.icon(itemFor('cross-origin')), '⚙', 'action 类的图标（去设置页动手）');
  });

  await test('★ 右键识别（2.0.1.17）：成功是中性 note、标签「已识别」、悬停带全文', () => {
    const it = itemFor('ctxmenu');
    eq(C.stateClass(it), 'note', '右键识别成功是中性告知（不是命中、更不是故障）');
    eq(C.tag(it), '已识别', '折叠标签');
    truthy(C.why(it).indexOf('识别出来的字') >= 0, '悬停理由必须带出识别全文（用户右键就是为了这段字）');
    /* 失败时**不许**还挂着「已识别」：右键路也走同一条 `keyOf()` 兜底 */
    const failed = { state: 'fail', via: 'contextMenu', error: '识别引擎不可用', errorCode: 'engine-unavailable' };
    eq(C.keyOf(failed), 'engine-unavailable', '失败优先说引擎原因（错误码在表内就直接用它）');
    eq(C.stateClass(failed), 'bad', '失败是红的');
    const silent = { state: 'fail', via: 'contextMenu', error: '说不清' };
    eq(C.keyOf(silent), 'fail', '没有可用的错误码时落到 fail（不得静默）');
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
    /* 样式表里 `wait` / `note` / `action` 三个类必须真有定义，否则"不红"和"要你动手"都是假的 */
    for (const cls of ['khin-imgtag.wait', 'khin-imgtag.note', 'khin-imgtag.action']) {
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

    /* `ctxmenu` 与 hit/miss 同类：**派生键**，生产者是 `img-ocr.js` 的 `via` 标记而不是 `why` 字面量
     * （2.0.1.17 右键任意图 OCR —— SPEC 需求 6） */
    const known = new Set(['queued', 'running', 'hit', 'miss', 'ctxmenu']);
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

  await test('★ S3-⑤：命中词 → 复制它**所在的那一整句**（简展示 + 灯箱全文，票 #22 后需求）', () => {
    /* 用户口径（2026-10-09）：命中"9月"，在"9月份的量，给你了"里就复制这一句。
     * 切分只在句末标点/换行上做 —— 逗号不是边界（宁可多带，不许把一句话切成半截）。 */
    eq(C.sentenceOf('9月份的量，给你了', '9月'), '9月份的量，给你了', '没有句末标点时取到文末');
    eq(C.sentenceOf('第一句。9月份的量，给你了。第三句。', '9月'), '9月份的量，给你了。', '两侧都按句末标点切');
    eq(C.sentenceOf('先9月。再9月！', '9月'), '先9月。', '取第一处出现的那一句');
    eq(C.sentenceOf('甲\n9月乙\n丙', '9月'), '9月乙', '换行也是边界');
    eq(C.sentenceOf('9月。后面', '9月'), '9月。', '句首命中');
    eq(C.sentenceOf('英文!句子?9月好;收尾', '9月'), '9月好;', '半角句末标点同样算边界');
    /* 定位不到就返回空串 —— 由调用方决定退化成什么（面板退化成复制命中词本身，不猜句子） */
    eq(C.sentenceOf('页面里没有这个词', '9月'), '', '找不到 needle 必须返回空串');
    for (const bad of [['', 'x'], [null, 'x'], ['abc', ''], [null, null]]) {
      eq(C.sentenceOf(bad[0], bad[1]), '', '空输入返回空串：' + JSON.stringify(bad));
    }

    const src = read('src/features/important-note.js');
    /* 面板不许自己写中文文案：标题/反馈都从真源取 */
    truthy(/KH\.OcrCopy\.sentenceOf\(it\.text, w\)/.test(src), '词块点击必须用 KH.OcrCopy.sentenceOf 定位句子');
    truthy(/KH\.OcrCopy\.VIEW\.copySentence/.test(src), '词块的可访问名/tooltip 必须来自 VIEW.copySentence');
    truthy(src.indexOf('.khin-imgchip') >= 0, '缺少 .khin-imgchip 样式（没有样式就等于看不见）');
    truthy(src.indexOf('.kh-lb-side') >= 0, '灯箱右侧全文栏缺少样式');
    truthy(/classList\.toggle\('kh-lb-has-side', !!full\)/.test(src), '有全文时灯箱要把图片收窄（否则同屏互相挤）');
    /* ---- 2.0.1.15 需求 7（用户 2026-10-12 裁决）：面板里那条「📋 复制全文」按钮**删掉**，
     * 大图工具栏也不许新增复制按钮（他选定的复制路径 = 进大图 → 在 OCR 全文栏里选中 → Ctrl+C）。
     * 所以这里的断言方向与原来相反：反过来钉"不许复活"。 */
    falsy(/khin-imgcopy/.test(src), '「复制全文」按钮的类名与样式必须删干净（含原来那三条 CSS 规则）');
    falsy(/VIEW\.copyAll/.test(src), '面板不许再读 VIEW.copyAll（按钮没了，读者也就没了）');
    const thumbSeg = src.slice(src.indexOf('thumbWrap.className'), src.indexOf('row.appendChild(thumbWrap)'));
    truthy(thumbSeg.length > 0, '要能找到缩略图容器的构建段');
    eq((thumbSeg.match(/createElement\('button'\)/g) || []).length, 0,
      '缩略图容器里不许再挂任何按钮（用户只批了"进大图选中复制"这一条复制路径）');
    const lb = read('src/ui/ocr-copy.js');
    for (const k of ['textPane', 'copySentence', 'copySentDone', 'copyFailed']) {
      truthy(new RegExp(k + ':').test(lb), 'VIEW 缺键 ' + k + '（文案真源不许散落在面板里）');
    }
    /* 按钮删了，只服务它的两个键也跟着删 —— 留着就是没人读的死字符串 */
    for (const k of ['copyAll', 'copyAllDone']) {
      falsy(new RegExp(k + ':').test(lb), 'VIEW 里不许再留没有读者的键 ' + k);
    }
  });

  /* --------------------------------------------------------------------------
   * 2.0.1.15 需求 5（案④ 定稿）：全文栏 = **浮在大图之上的独立容器** + 工具栏眼睛按钮
   * 用户口径（逐字）："ocr全文栏应该是个单独的临时容器，支持隐藏。开关可以放在工具栏里面"
   *                + "不应该挤占大图容器的空间" ⇒ 默认隐藏，点眼睛才弹出。
   * 真机两轮读数（T18）给出旧结构的病根：全文栏与图**同在 .kh-lb-row 里争宽**（图 84vw + 栏 300px > 100vw）
   * → 1920 视口栏右缘出屏 13.41px、1280 出屏 64.59px；而放大只改 transform（不参与布局），
   * 1.563 倍时整块栏被图盖住。把栏移出行、改成绝对定位浮层后两个毛病同时消失，且**大图尺寸完全不变**
   * （硬判据：有/无全文，图宽一样 —— 1920/1280 两档实测见交付记录）。
   * 下面钉的是这条结构里"改回去就静默复发"的几处锚点。
   * -------------------------------------------------------------------------- */
  await test('★ 需求 5：全文栏浮层 —— 绝对定位不参与大图宽度（有/无全文图一样宽）；T46 起锚点改回 .kh-lb-row', () => {
    const src = read('src/features/important-note.js');
    /* 结构：.kh-lb > .kh-lb-stage > [.kh-lb-row > (‹ + 图 + › + .kh-lb-side) + .kh-lb-bar]
     * T46：浮层的定位祖先从**容器**改回**行**（真机证据：容器锚点与行锚点错位 ⇒ 浮层右缘压住 ›
     * 整 48px、elementFromPoint 命中浮层里的元素）。side 现在是 .kh-lb-row 的绝对定位子元素，
     * 所以 stage 到 side 之间**一个收尾都没有**（行还没关）。 */
    const stageAt = src.indexOf('<div class="kh-lb-stage">');
    const sideAt = src.indexOf('<div class="kh-lb-side" hidden>');
    truthy(stageAt > 0 && sideAt > stageAt, '模板里要能找到 .kh-lb-stage 与 .kh-lb-side');
    eq((src.slice(stageAt, sideAt).match(/<\/div>/g) || []).length, 0,
      'stage 与 side 之间不许有收尾（T46：side 是 .kh-lb-row 的子元素，行还没关）');
    /* T46：全文栏**回到行内**（锚点=行，才不会因容器/行坐标差压住翻页键）；图片仍在行内，
     * img 标签本身一个字不许改。"不抢宽度"**不靠让位**，而由下面那条 position: absolute 断言
     * 保证 —— 谁把浮层改回参与 flex 布局，图宽就会跟着全文栏一起变。 */
    const rowSeg = src.slice(src.indexOf('<div class="kh-lb-row">'), src.indexOf('<div class="kh-lb-bar">'));
    truthy(rowSeg.indexOf('<div class="kh-lb-side"') >= 0,
      'T46：全文栏必须是 .kh-lb-row 的子元素（锚点跟着行；落回容器会与行坐标错位、压住翻页键）');
    truthy(rowSeg.indexOf('<img class="kh-lb-img" alt="">') >= 0, '图片留在行内，img 标签原样');
    /* 案③ 的包裹层已作废：不许留任何残件 */
    falsy(src.indexOf('kh-lb-imgwrap') >= 0, '案③ 包裹层必须清干净（连注释都不留）');
    falsy(/min\(84vw/.test(src), '图的上限回到 84vw，不许再有"收在容器 100% 内"那种让位写法');
    /* 浮层三要素：脱流（absolute）、贴右（right）、压在图上（z-index 高于 .kh-lb img 的 1） */
    const sideRule = (src.match(/\.kh-lb-side \{[\s\S]*?\}/) || [''])[0];
    truthy(sideRule.length > 0, '要有 .kh-lb-side 规则本体');
    truthy(/position:\s*absolute/.test(sideRule), '浮层必须绝对定位（否则仍参与行宽分配）：' + sideRule);
    truthy(/right:\s*\d/.test(sideRule), '浮层贴右侧：' + sideRule);
    const z = Number((sideRule.match(/z-index:\s*(\d+)/) || [0, 0])[1]);
    truthy(z > 1, '浮层层级要高于图（.kh-lb img 是 z-index:1），当前 ' + z);
    /* T41（用户 2026-10-12 裁决方案 2 · 卡片内右侧栏）：坐标基准从"画满视口的 .kh-lb"换成
     * **容器自身** —— 定位祖先由 .kh-lb-stage 的 position:relative 提供（几何口径见下面专测）。 */
    truthy(/\.kh-lb-stage \{[\s\S]*?position:\s*relative/.test(src),
      '.kh-lb-stage 必须成为定位祖先（否则浮层又按整个视口算坐标，越过卡片边框）');
    /* 复制通路的承重件：需求 7 删掉面板按钮后，「进大图 → 在全文里选中 → Ctrl+C」仍是一条通路，
     * 它靠的就是正文区那条 user-select: text（T41 起随正文区走，不再挂在外壳上）—— 谁去掉它，
     * 手工复制就断了（另一条通路是容器自带的复制按钮）。 */
    const sideBodyRule = (src.match(/\.kh-lb-side-t \{[\s\S]*?\}/) || [''])[0];
    truthy(/user-select:\s*text/.test(sideBodyRule),
      '正文区必须保持 user-select:text（手工选中复制的通路）：' + sideBodyRule);
    /* 死规则删干净：它既无作用，又会让人误以为"全文栏出现时会收窄图片" */
    falsy(/\n\s*\.kh-lb-has-side \.kh-lb img\s*\{/.test(src), '死规则（has-side 收窄）不许复活');
    falsy(src.indexOf('56vw') >= 0, '已删死规则的数值不许留在文件里（连注释也别留，免得看着像还有这条规则）');
    /* 被正则钉住的那行 toggle 不许动（它仍标记"这张图有全文"，只是不再承担收窄） */
    truthy(/classList\.toggle\('kh-lb-has-side', !!full\)/.test(src), 'kh-lb-has-side 的 toggle 行不许改');
    /* 点全文栏必须放行，否则在栏里选词/滚动就被当成"点到容器外"关掉灯箱。T46 起浮层在 .kh-lb-row
     * 内（stage 的子树里），`.kh-lb-stage` 那条判定本已覆盖它；这条白名单仍作为复制通路的**承重件**
     * 显式保留：用户已选定「进大图 → 在 OCR 全文里选中 → Ctrl+C」，一旦点全文栏就关灯箱，
     * 全文选不中就复制不了 —— 所以钉两条：正则 + 原样子串（后者便于 grep 复核）。 */
    truthy(/if \(t && side\.contains\(t\)\) return;/.test(src), '浮层里的点击必须放行（否则读/抄全文会被关灯箱）');
    truthy(src.indexOf('if (t && side.contains(t)) return;') >= 0,
      '关闭判定必须含全文栏白名单（原样锚句）：点全文栏不许关灯箱，否则"选中→Ctrl+C"复制通路断掉');
  });

  await test('★ 需求 5：平移夹紧仍按视口算（案④ 不动 clampPan）', () => {
    const src = read('src/features/important-note.js');
    const fn = (src.match(/const clampPan = \(tx, ty\) => \{[\s\S]*?\n      \};/) || [''])[0];
    truthy(fn.length > 0, '要有 clampPan 本体（没匹配到说明它被重写了）');
    truthy(/window\.innerWidth/.test(fn) && /window\.innerHeight/.test(fn),
      '基准是视口：全文栏是浮层、不参与布局，图的可视范围依旧是整个视口');
    falsy(/w\.width|w\.height/.test(fn), 'X/Y 上限不许再取别的盒的尺寸（那是案③ 包裹层的写法，已作废）');
    truthy(/LIGHTBOX_PAN_KEEP/.test(fn), '手感余量（LIGHTBOX_PAN_KEEP = 120）保留，图可摆到整屏、不被拖丢');
  });

  await test('★ 需求 5：全文栏默认隐藏 —— 会话级状态、关大图复位、开关在工具栏、文案取自 VIEW', () => {
    const src = read('src/features/important-note.js');
    const lb = read('src/ui/ocr-copy.js');
    truthy(/let sideHidden = true;/.test(src), '默认隐藏：状态初始就是隐藏（用户口径"点眼睛才弹出"）');
    /* 会话级的两条反证：不许挂 host（host 是缓存宿主，会跨次开灯箱存活）、不许进 chrome.storage */
    falsy(/host\._sideHidden/.test(src), '显示态不许挂到 host 上（会跨次开灯箱存活）');
    falsy(src.indexOf('chrome.storage') >= 0, '显示态不许进扩展存储（那是跨会话的持久状态）');
    truthy(/const close = \(\) => \{ box\.hidden = true; img\.removeAttribute\('src'\); sideHidden = true; \};/.test(src),
      '关大图必须复位成隐藏（= 每次打开都从隐藏态开始）');
    truthy(src.indexOf('side.hidden = !full || sideHidden;') >= 0,
      '显隐用 .kh-lb-side 既有的 hidden（不另写一套隐藏样式）');
    eq((src.match(/\.kh-lb-side\[hidden\]/g) || []).length, 1, '只许有既有那一条隐藏规则');
    /* 开关挂在**现有工具条**上（不新造条），且在浮层 div 之前 —— 说明它确实在工具条里 */
    /* T46 起浮层在 bar **之前**（行内），所以这段切片不能再用"浮层起点"当终点 —— 用 bar 自己的收尾。 */
    const barAt = src.indexOf('<div class="kh-lb-bar">');
    const barSeg = src.slice(barAt, src.indexOf('</div>', barAt));
    truthy(barSeg.indexOf('kh-lb-sidebtn') >= 0, '眼睛按钮挂现有工具条（不新造条）');
    /* 无 OCR 全文 ⇒ 按钮不出现（不是置灰）：没有可切的东西就别摆一个点了没反应的按钮 */
    truthy(/sideBtn\.hidden = !full;/.test(src), '无全文时不出现这枚按钮');
    truthy(/on\(sideBtn, \(\) => \{ sideHidden = !sideHidden; apply\(\); \}\)/.test(src),
      '切换按钮必须走 on() 包装（preventDefault + stopPropagation）');
    truthy(/sideBtn\.textContent = sideHidden \? KH\.OcrCopy\.VIEW\.paneShow : KH\.OcrCopy\.VIEW\.paneHide/.test(src),
      '两个标签都必须取自 VIEW（灯箱不许自己写这两句）');
    for (const k of ['paneHide', 'paneShow']) {
      truthy(new RegExp(k + ':').test(lb), 'VIEW 缺键 ' + k + '（文案真源不许散落在灯箱里）');
    }
  });

  /* --------------------------------------------------------------------------
   * T41（用户 2026-10-12 拍板方案 2 · 卡片内右侧栏 + 一键复制）：全文栏从"挂遮罩的浮层"改成
   * **卡片自带的右侧栏**（案④ 真机读数：贴视口右上角会越过卡片边框 1920 档 69px / 1280 档 17px），
   * 且容器里**自带操作入口**（一键复制 + ×），不再要求用户"先选中再按 Ctrl+C"。
   * T46 更正：坐标基准从 .kh-lb-stage 改回 **.kh-lb-row**（容器锚点会与导航键的行锚点错位 ⇒ 压住 ›）。
   * 复制内容的真源是**服务端 OCR 原文**（条目上的 text），不是屏幕文字 —— 屏幕文字会折行、
   * 会被滚出视口，也可能被别的 UI 拼进来。
   * -------------------------------------------------------------------------- */
  await test('★ 需求 5 / T41：全文栏 = 卡片内右侧栏 + 容器自带一键复制与 ×（与眼睛按钮同一状态）', () => {
    const src = read('src/features/important-note.js');
    const lb = read('src/ui/ocr-copy.js');
    /* ① 结构：.kh-lb-side 在 .kh-lb-row 内（行的绝对定位子元素；T46 把锚点从容器改回行） */
    const stageAt = src.indexOf('<div class="kh-lb-stage">');
    const sideAt = src.indexOf('<div class="kh-lb-side" hidden>');
    truthy(stageAt > 0 && sideAt > stageAt, '模板里要能找到 .kh-lb-stage 与 .kh-lb-side');
    eq((src.slice(stageAt, sideAt).match(/<\/div>/g) || []).length, 0,
      'stage 与 side 之间不许有收尾（T46：side 是 .kh-lb-row 的子元素，行还没关）');
    /* ② 几何（T46 坐标基准 = .kh-lb-row）：贴行上下、右缘让开 48px 导航键 + 12px 间隙；
     * 宽度上限左右各留 60px ⇒ 数学上不可能压到 ‹ ›；纵向 0/0 = 与图片上下边齐平（行高 = 图高）。 */
    const sideRule = (src.match(/\.kh-lb-side \{[\s\S]*?\}/) || [''])[0];
    for (const p of [/top:\s*0/, /right:\s*60px/, /bottom:\s*0/, /width:\s*340px/,
      /max-width:\s*min\(342px,\s*calc\(100% - 120px\)\)/]) {
      truthy(p.test(sideRule), '几何口径 ' + p + ' 必须在 .kh-lb-side 里：' + sideRule);
    }
    truthy(/display:\s*flex/.test(sideRule) && /flex-direction:\s*column/.test(sideRule),
      '外壳必须是纵向分栏（标题栏固定、正文区滚动）：' + sideRule);
    truthy(/overflow:\s*hidden/.test(sideRule), '外壳裁圆角：正文区滚动，外壳不滚（否则标题栏被滚走）');
    /* ③ 正文区：滚动、可选中、等宽行距都由它承担（不是外壳） */
    const bodyRule = (src.match(/\.kh-lb-side-t \{[\s\S]*?\}/) || [''])[0];
    truthy(bodyRule.length > 0, '要有正文区规则本体');
    truthy(/overflow:\s*auto/.test(bodyRule), '滚动只许在正文区：' + bodyRule);
    truthy(/user-select:\s*text/.test(bodyRule), '正文必须可选中（手工复制通路）：' + bodyRule);
    /* ④ 标题栏：左标题、次「共 N 行」、右「复制」+「×」 */
    const hdAt = src.indexOf('<div class="kh-lb-side-hd">');
    truthy(hdAt > sideAt, '标题栏必须在浮层内');
    const hdSeg = src.slice(hdAt, src.indexOf('<div class="kh-lb-side-t"'));
    for (const cls of ['kh-lb-side-h', 'kh-lb-side-n', 'kh-lb-copy', 'kh-lb-sidehide']) {
      truthy(hdSeg.indexOf(cls) >= 0, '标题栏缺 ' + cls);
    }
    /* ⑤ 一键复制：内容 = 服务端 OCR 原文（curText），**不许**回读屏幕文字 */
    truthy(/let curText = '';/.test(src), '要有"当前图的 OCR 原文"这个来源');
    truthy(/curText = full;/.test(src), 'apply() 里必须把条目原文记进 curText（服务端识别结果）');
    truthy(/on\(sideCopy, \(\) => \{\s*\n\s*copyToClipboard\(curText, sr\)/.test(src),
      '复制按钮必须把 curText 交给剪贴板（不是屏幕上的那串字）');
    falsy(/copyToClipboard\(sideText\.textContent/.test(src), '复制内容不许从屏幕文字回读（折行/裁切会污染）');
    truthy(/sideCopy\.hidden = !full;/.test(src), '没有 OCR 文本时复制按钮不出现（不是置灰）');
    /* ⑥ × 与眼睛按钮是**同一个状态**（sideHidden）、同一对文案键；× 随浮层一起隐藏（它在浮层内） */
    truthy(/on\(sideClose, \(\) => \{ sideHidden = true; apply\(\); \}\)/.test(src),
      '× 必须把 sideHidden 置回隐藏并重画（与眼睛按钮同一个状态变量）');
    truthy(/sideClose\.title = KH\.OcrCopy\.VIEW\.paneHide/.test(src), '× 的文案也取自 VIEW');
    /* ⑦ 文案真源：四句都不许在灯箱里写死 */
    for (const k of ['paneCopy', 'paneCopied', 'paneCopyFail', 'paneLines']) {
      truthy(new RegExp(k + ':').test(lb), 'VIEW 缺键 ' + k);
      truthy(src.indexOf('KH.OcrCopy.VIEW.' + k) >= 0, '灯箱没有从真源取 ' + k);
    }
    truthy(/KH\.OcrCopy\.render\(KH\.OcrCopy\.VIEW\.paneLines, \{ n:/.test(src), '「共 N 行」必须走 render 插值');
  });

  /* --------------------------------------------------------------------------
   * T39：浮层的**裁切回归守卫**（T24 真机实测：跨出 .kh-lb-stage 右缘 303.22px）
   * 全文栏能落在视口内，靠的正是它从 stage 右缘**溢出去**；「浮层覆盖大图、不占布局」也正是
   * 需求 5 方案成立的前提。谁给 .kh-lb-stage 加一句裁切，整块全文栏会被**静默**切掉 ——
   * 不报错、也不让别的任何断言变红（模板串里的 CSS 不受 node --check 管辖）。
   * 所以这里反向钉死：LIGHTBOX_STYLE 区间内**每一条选择器含 .kh-lb-stage 的规则**都不许出现
   * 裁切手段 —— overflow / overflow-x / overflow-y 的 hidden|clip、contain 的
   * paint|strict|content、以及任何非 none 的 clip-path（同效的后门写法）。
   * 本断言只防将来回归，不代替 T24 的真机读数。
   * -------------------------------------------------------------------------- */
  await test('★ 需求 5：.kh-lb-stage 不许裁切（全文栏靠跨出它右缘落进视口，加了就静默切掉）', () => {
    const src = read('src/features/important-note.js');
    /* 区间显式限定在 LIGHTBOX_STYLE 模板串本体（首尾反引号之间），不在整文件里裸 match */
    const lbMarker = 'const LIGHTBOX_STYLE = `';
    const lbOpen = src.indexOf(lbMarker);
    truthy(lbOpen >= 0, '找不到 LIGHTBOX_STYLE 定义（灯箱样式被搬走了？守卫会静默失效）');
    const lbClose = src.indexOf('`', lbOpen + lbMarker.length);
    truthy(lbClose > lbOpen, 'LIGHTBOX_STYLE 的模板串没有闭合反引号');
    /* 去注释后再扫规则：注释里提到 .kh-lb-stage / overflow 不算规则内容，否则会误判 */
    const lbCss = src.slice(lbOpen + lbMarker.length, lbClose).replace(/\/\*[\s\S]*?\*\//g, '');
    const lbRules = (lbCss.match(/[^{}]+\{[^{}]*\}/g) || []).map((r) => ({
      sel: r.slice(0, r.indexOf('{')).trim().replace(/\s+/g, ' '),
      body: r.slice(r.indexOf('{')),
    }));
    const stageRules = lbRules.filter((r) => r.sel.indexOf('.kh-lb-stage') >= 0);
    truthy(stageRules.length >= 1,
      '.kh-lb-stage 规则必须能被扫到（扫不到说明区间切错或规则被重写，守卫会静默失效）');
    for (const r of stageRules) {
      const where = '规则 ' + r.sel + ' ' + r.body;
      /* CSS 关键字**大小写不敏感** ⇒ 三条正则都带 /i，否则 OVERFLOW: HIDDEN 能溜过去。
       * /i 不会误伤 clip-path: none —— (?!none\b) 在 /i 下同样放过 NONE。 */
      falsy(/overflow(?:-[xy])?\s*:\s*[^;}]*\b(hidden|clip)\b/i.test(r.body),
        'T24 真机实测：全文栏跨出 .kh-lb-stage 右缘 303.22px 才落在视口内，给 stage 加裁切会静默切掉全文栏（本断言只防将来回归，不代替 T24 的真机读数）：' + where);
      falsy(/contain\s*:\s*[^;}]*\b(paint|strict|content)\b/i.test(r.body),
        'contain: paint|strict|content 同样是裁切（溢出的浮层会被静默切掉），只是不叫 overflow：' + where);
      falsy(/clip-path\s*:\s*(?!none\b)\S/i.test(r.body),
        'clip-path（非 none）同样是裁切：' + where);
    }
  });

  /* --------------------------------------------------------------------------
   * T39 追加 B：LIGHTBOX_STYLE 模板串里的**注释标记必须成对**
   * 事故先例（T25）：面板 STYLE 里多留了一个收尾标记，紧随其后的 .khin-imgchips 规则被浏览器
   * 当非法选择器**整条丢弃** —— 不报错、node --check 也查不出来（模板串里的 CSS 对 JS 解析器
   * 只是一串字符，它只认首尾反引号）。灯箱串同样是模板串 + 大量注释，同一个雷要一起排。
   * -------------------------------------------------------------------------- */
  await test('★ 灯箱模板串里的注释标记必须成对（T25 那次多一个收尾标记，静默丢掉了一整条规则）', () => {
    const src = read('src/features/important-note.js');
    const lbMarker = 'const LIGHTBOX_STYLE = `';
    const lbOpen = src.indexOf(lbMarker);
    truthy(lbOpen >= 0, '找不到 LIGHTBOX_STYLE 定义');
    const lbClose = src.indexOf('`', lbOpen + lbMarker.length);
    truthy(lbClose > lbOpen, 'LIGHTBOX_STYLE 的模板串没有闭合反引号');
    const css = src.slice(lbOpen + lbMarker.length, lbClose);
    const opens = (css.match(/\/\*/g) || []).length;
    const closes = (css.match(/\*\//g) || []).length;
    eq(opens, closes,
      '注释首尾标记必须成对（T25 在面板 STYLE 里多留过一个收尾标记，紧随其后的规则被浏览器当非法选择器静默丢弃，node --check 查不出来）：开 ' + opens + ' 个，收 ' + closes + ' 个');
    /* 顺序扫描：每一个收尾标记之前都必须有尚未闭合的开标记（否则它就是多余的那个） */
    let depth = 0;
    const re = /\/\*|\*\//g;
    let m;
    while ((m = re.exec(css)) !== null) {
      if (m[0] === '/*') { depth++; continue; }
      depth--;
      falsy(depth < 0,
        '第 ' + m.index + ' 字符处出现了孤立的收尾标记（它前面没有未闭合的开标记），它后面的规则会被浏览器静默丢弃：'
        + css.slice(Math.max(0, m.index - 60), m.index + 20).replace(/\s+/g, ' '));
    }
    eq(depth, 0, '扫描结束时还有 ' + depth + ' 个未闭合的开标记（剩下的规则同样会被吞掉）');
  });
};
