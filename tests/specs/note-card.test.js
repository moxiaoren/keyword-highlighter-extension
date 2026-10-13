/* tests/specs/note-card.test.js — 备注卡片的「配置刷新」（T57）
 * ----------------------------------------------------------------------------
 * 真机事故：在**已经打开**的页面上改「笔记卡配色」，卡片不变色，刷新页面/整页重建才变。
 * 分类是对的（`noteCardStyle` 的页面侧读点只在 ⑦Consume，见 `config-noop.test.js` 的 T36b），
 * 坏在 `src/features/note-card.js` 的 `bind(configRef)`：`_bound` 那个一次性早退把**每次
 * `consume` 新传进来的 `() => cfg` 闭包**一起冻住了 ⇒ `show()` 与两处读点永远拿到 boot 那次的
 * 对象。而且 `card` 是**模块单例**（`note-card.js:485` 的 `KH.NoteCard`），整页重建也不会重置
 * `_bound`，所以「把它从 UI-only 键里摘出去、靠整页重建生效」这条路修不了这个病。
 *
 * 本 spec 与 `config-noop.test.js` 的 T57 两条**换角度**，不重复：
 *   那边钉「第二次 bind 的新引用必须生效 / 显示态必须当场落色」；
 *   这边钉**契约与代价**——对外形状一个字不许动、监听不许退化成重复装、
 *   引用没变（页面自身变动的重建）不许动 UI、卡片没显示时不许碰 DOM。
 * 垫片里没有真 DOM 事件管线：把 `document.addEventListener` 换成记录器，
 * 拿到 `bind` 装上的**可调用**处理器，只观测"引用取到的值"，不测布局。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('note-card · 配置刷新必须到达卡片（T57）');

  const card = KH.NoteCard;
  const entries = (KH.features && typeof KH.features.entries === 'function') ? KH.features.entries() : [];
  const found = entries.find(([label]) => label === 'note-card');

  /** 隔离现场：装"可调用的监听"记录器 + 把卡片清成"没绑过"的干净状态。
   *  body(handlers) 里边测边断言，退出时无论成败一律还原（含垫片全局）。 */
  function sandbox(body) {
    const docAdd = document.addEventListener;
    const winAdd = global.addEventListener;
    const raf = global.requestAnimationFrame;
    const scanner = KH.Scanner;
    const hitAt = KH.hitAtPoint;
    const snap = {
      bound: card._bound, ref: card._configRef, lastCfg: card._lastCfg,
      box: card.box, host: card.host, show: card.show
    };
    const handlers = {};
    try {
      global.addEventListener = () => { };
      global.requestAnimationFrame = () => 0;
      document.addEventListener = (type, h) => { (handlers[type] = handlers[type] || []).push(h); };
      card._bound = false; card._configRef = undefined; card._lastCfg = undefined;
      card.box = null; card.host = null;
      KH.Scanner = { isOwnUI: () => false };
      KH.hitAtPoint = () => ({ meta: { note: '备注正文', display: '命中词' } });
      return body(handlers);
    } finally {
      card._bound = snap.bound; card._configRef = snap.ref; card._lastCfg = snap.lastCfg;
      card.box = snap.box; card.host = snap.host; card.show = snap.show;
      KH.Scanner = scanner; KH.hitAtPoint = hitAt;
      document.addEventListener = docAdd;
      if (winAdd === undefined) delete global.addEventListener; else global.addEventListener = winAdd;
      if (raf === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = raf;
    }
  }

  await test('★ 对外契约不变：注册名 / consume(hits, cfg) / bind(configRef)', () => {
    truthy(found, 'note-card 必须注册在 feature 表里（KH.features.entries()）');
    eq(found[0], 'note-card', '注册名不许改');
    eq(typeof found[1].consume, 'function', 'consume 必须还在');
    eq(found[1].consume.length, 2, 'consume 形参仍是 (hits, cfg)');
    eq(typeof card.bind, 'function', 'bind 必须还在');
    eq(card.bind.length, 1, 'bind(configRef) 形参仍是 1 个');
  });

  await test('★ 第二次 bind 的引用必须生效：拿到的配置是最新那次，不是 boot 那次', () => {
    const cfgBoot = { noteCardStyle: { bgColor: '#aaaaaa' } };
    const cfgNew = { noteCardStyle: { bgColor: '#123456' } };
    let shownCfg = '没走到 show（用例自身失效）';
    sandbox((handlers) => {
      card.show = (hit, x, y, cfg) => { shownCfg = cfg; };   // 只观测引用取到什么
      card.bind(() => cfgBoot);           // boot / 首次 consume 传进来的引用
      card.bind(() => cfgNew);            // 已打开页面上的一次真配置变更
      const click = (handlers.click || [])[0];
      truthy(typeof click === 'function', '前置：bind 必须真的挂上 click 监听（否则本用例测不到东西）');
      click({ target: {}, clientX: 10, clientY: 10 });
    });
    eq(shownCfg, cfgNew, '★ 必须用**最新**引用取配置 —— 拿到 boot 那次就是真机事故：'
      + '已打开页面改「笔记卡配色」不变色、刷新才变（`_bound` 把配置引用一起冻住了）');
  });

  await test('★ 引用可刷新，监听仍然只装一次（`_bound` 的语义不许被顺手拆掉）', () => {
    sandbox((handlers) => {
      card.bind(() => ({}));
      card.bind(() => ({}));
      card.bind(() => ({}));
      eq(card._bound, true, '三次 bind 之后必须仍处于已绑定态');
      eq((handlers.click || []).length, 1, '★ click 只许装一份监听（重复装＝一次点击触发多次）');
      eq((handlers.keydown || []).length, 1, '★ keydown 同样只许一份（Enter 打开备注不许触发多次）');
    });
  });

  await test('★ 卡片正显示时 consume 必须当场把新配色落到 host（不能等关掉再点开）', () => {
    truthy(found, '前置：feature 表里必须有 note-card');
    const consume = found[1].consume;
    const snap = {
      bound: card._bound, ref: card._configRef, lastCfg: card._lastCfg,
      box: card.box, host: card.host
    };
    let writes = [];
    try {
      card._bound = true;                       // 隔离：不重装监听
      card.box = { hidden: false };             // visible === true（卡片正开着）
      card.host = { style: { setProperty: (k, v) => { writes.push([k, String(v)]); } } };
      card._lastCfg = { noteCardStyle: { bgColor: '#aaaaaa' } };
      consume([], { noteCardStyle: { bgColor: '#123456', borderColor: '#00ff00', fontSize: '18px' } }, {});
      const w = (k) => { const hit = writes.filter((p) => p[0] === k); return hit.length ? hit[hit.length - 1][1] : null; };
      eq(w('--kh-nc-bg'), '#123456', '★ 卡片开着时改底色必须当场写进 host 样式（老事故：只能刷新才变）');
      eq(w('--kh-nc-bd'), '#00ff00', '边框色同样当场落（不是只落一个键）');
      eq(w('--kh-nc-fs'), '18px', '字号同样当场落');
    } finally {
      card._bound = snap.bound; card._configRef = snap.ref; card._lastCfg = snap.lastCfg;
      card.box = snap.box; card.host = snap.host;
    }
  });

  await test('★ 两条老契约不许被改掉：引用没变不碰 UI / 卡片没显示不碰 DOM', () => {
    const consume = found[1].consume;
    const snap = {
      bound: card._bound, ref: card._configRef, lastCfg: card._lastCfg,
      box: card.box, host: card.host
    };
    let writes = 0;
    try {
      card._bound = true;
      /* ① 同一份 cfg 再 consume 一次 = 页面自身变动触发的重建：
       * 参考对象没换就说明配置没变，不许动正在显示的交互 UI（v2.0.0 百度页事故的原契约）。 */
      const cfg = { noteCardStyle: { bgColor: '#123456' } };
      card.box = { hidden: false };
      card.host = { style: { setProperty: () => { writes++; } } };
      card._lastCfg = cfg;
      consume([], cfg, {});
      eq(writes, 0, '★ 引用没变＝不是配置变更，不许重写样式（那会打断/闪一下正显示的卡片）');

      /* ② 卡片没显示（host 不存在）：不许 ensure、不许造 DOM。
       * `applyStyle` 写的是 `this.host.style`，被提到 `visible` 判断之外会直接抛异常。 */
      card.box = null; card.host = null;
      consume([], { noteCardStyle: { bgColor: '#654321' } }, {});
      eq(card.host, null, '★ 卡片没显示时 consume 不许造 host（每次重建都建 DOM＝白干活）');
    } finally {
      card._bound = snap.bound; card._configRef = snap.ref; card._lastCfg = snap.lastCfg;
      card.box = snap.box; card.host = snap.host;
    }
  });
};
