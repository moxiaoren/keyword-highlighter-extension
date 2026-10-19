/* tests/specs/hit-geometry.test.js — 几何命中回退的**距离上限**
 * ----------------------------------------------------------------------------
 * 回归背景（K40）：`_hitByGeometry` 的 `TOL = 3` 只用于判断「是否算精确包含」，
 * **不是**最近命中的距离上限；旧实现无条件 `return best`，于是在没有文字的空白区域
 * （空单元格 / 空行 / 图片区）悬停时，会把几百像素外的命中当成本地命中
 * → 备注 tooltip 在空白处弹出（用户实测缺陷，1.99.99.3 修复，上限 20px）。
 *
 * 这里锁两条相反的风险：
 *   ① 远处命中**不得**被当成本地命中（否则空白处误弹备注）；
 *   ② 命中矩形内 / 容差内的近处命中**仍要**能命中（否则浮层盖住文字等场景会失效）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/** 造一条命中：Range 矩形固定为给定 rect（`_range.startContainer === textNode` → 走缓存分支） */
function hitWithRect(node, rect) {
  return {
    textNode: node, start: 0, end: 4,
    _range: { startContainer: node, getClientRects: () => [rect] }
  };
}

const RECT = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 };

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('hit-geometry · 坐标兜底定位的距离上限（K40 不变式）');

  await test('★ 远处命中不得被当成本地命中（空白处不得误弹备注）', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const real = KH.registry;
    KH.registry = { all: () => [hitWithRect(node, RECT)], query: () => null };
    try {
      eq(KH._hitByGeometry(150, 500), null, '380px 外：必须返回 null（旧实现会返回这条命中）');
      eq(KH._hitByGeometry(150, 400), null, '280px 外：必须返回 null');
      eq(KH._hitByGeometry(150, 145), null, '距底边 25px（超上限 20px）：必须返回 null');
      eq(KH._hitByGeometry(150, 141), null, '距底边 21px（刚超上限）：必须返回 null');
      truthy(KH._hitByGeometry(150, 140), '距底边恰好 20px（上限边界，含）：仍算命中');
    } finally { KH.registry = real; }
  });

  await test('★ 命中矩形内 / 容差内仍要能命中（上限不得把功能一并砍掉）', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const real = KH.registry;
    KH.registry = { all: () => [hitWithRect(node, RECT)], query: () => null };
    try {
      truthy(KH._hitByGeometry(150, 110), '矩形正中：应命中');
      truthy(KH._hitByGeometry(202, 110), '右边缘 2px（TOL=3 内）：应命中');
      truthy(KH._hitByGeometry(150, 128), '底边下方 8px（上限内）：应命中');
      truthy(KH._hitByGeometry(158, 130), '斜向 10px（上限内）：应命中');
    } finally { KH.registry = real; }
  });

  await test('离得最近的命中胜出（多条时取最近，而不是第一条）', () => {
    const near = H.txt('近'); near.isConnected = true;
    const far = H.txt('远'); far.isConnected = true;
    const real = KH.registry;
    KH.registry = {
      all: () => [
        hitWithRect(far, { left: 600, top: 600, right: 700, bottom: 620, width: 100, height: 20 }),
        hitWithRect(near, RECT)
      ],
      query: () => null
    };
    try {
      const r = KH._hitByGeometry(150, 130);
      truthy(r && r.node === near, '应返回最近的那条命中');
    } finally { KH.registry = real; }
  });

  await test('注册表里的命中已脱离文档（isConnected=false）→ 忽略', () => {
    const gone = H.txt('已移除');
    gone.isConnected = false;
    const real = KH.registry;
    KH.registry = { all: () => [hitWithRect(gone, RECT)], query: () => null };
    try {
      eq(KH._hitByGeometry(150, 110), null, '脱离文档的命中不该参与定位');
    } finally { KH.registry = real; }
  });

  /* ================= 【2.0.2.16 需求⑥】命中必须落在「词」上 =================
   * 用户实测：单元格里只有命中词时，鼠标进到格子任意位置（离词很远）、点格子空白处，
   * 备注悬浮卡/点击卡都会弹。机制是 caret 在同一段文字的空白区把 offset 给到该命中段末，
   * `registry.query` 的"点词尾右侧像素"兜底就认了。这里锁住"只有点落在高亮矩形上才算"。 */
  suite('hitAtPoint · 命中必须落在词上（2.0.2.16 需求⑥）');
  const stub = (hit, offset) => {
    const realRegistry = KH.registry;
    const realPoint = KH.pointToRange;
    KH.registry = { query: () => hit, all: () => [hit] };
    KH.pointToRange = () => ({ node: hit.textNode, offset: offset });
    return () => { KH.registry = realRegistry; KH.pointToRange = realPoint; };
  };

  await test('★ 同一段文字里离词很远（caret 落到段末）：不许弹卡', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const hit = hitWithRect(node, RECT);
    const restore = stub(hit, 4);
    try {
      eq(KH.hitAtPoint(560, 110), null, '★ 同一行文字右侧 360px（旧实现因 offset===end 兜底返回命中）');
      eq(KH.hitAtPoint(150, 300), null, '词下方 180px 的空白单元格区域');
    } finally { restore(); }
  });

  await test('★ 落在命中词矩形上 / 词尾 2px 容差内：仍要弹卡', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const hit = hitWithRect(node, RECT);
    const restore = stub(hit, 4);
    try {
      truthy(KH.hitAtPoint(150, 110), '词的正中：应命中');
      truthy(KH.hitAtPoint(202, 110), '词尾右侧 2px（3px 容差内）：应命中');
    } finally { restore(); }
  });

  await test('量不到矩形时保持旧行为（浮层盖住文字 / Shadow DOM 仍能弹卡）', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const hit = { textNode: node, start: 0, end: 4 };   // 没有 _range
    const restore = stub(hit, 4);
    try {
      truthy(KH.hitAtPoint(999, 999), '矩形不可用 ⇒ 不因新判据把功能砍掉');
    } finally { restore(); }
  });

  /* 跨节点命中（`审核<span>不通过</span>`）与折行命中的一条 Range 会量出**多个**矩形：
   * 只认第一个的话，点在后半段/第二行就被判成"不在词上"（真机红：第二段点不出备注卡）。 */
  await test('★ 一条命中量出多个矩形时，点在**后半段**上也算命中', () => {
    const node = H.txt('审核');
    node.isConnected = true;
    const second = { left: 200, top: 100, right: 300, bottom: 120, width: 100, height: 20 };
    const hit = {
      textNode: node, start: 0, end: 5, meta: { note: '备注' },
      _range: { startContainer: node, getClientRects: () => [RECT, second] }
    };
    const restore = stub(hit, 5);
    try {
      const r = KH.hitAtPoint(250, 110);
      truthy(r === hit, '点在后半段矩形正中：应返回这条命中');
      truthy(r && r.meta && r.meta.note, '备注卡读的是 meta.note，必须带着它');
    } finally { restore(); }
  });

  /* 几何兜底的返回值必须是**命中记录**：`_hitByGeometry` 自己只造 `{node, offset}` 定位，
   * 直接返回它会让 `hit.meta` 为空 ⇒ 备注卡静默不出。 */
  await test('★ 几何兜底必须回命中记录（带 meta），不许回裸定位', () => {
    const node = H.txt('审核不通过');
    node.isConnected = true;
    const hit = hitWithRect(node, RECT);
    hit.meta = { note: '备注' };
    const restore = stub(hit, 4);
    try {
      const r = KH.hitAtPoint(215, 110);         // 词尾右侧 15px：出 3px 容差、仍在 20px 上限内
      truthy(r === hit, '应回同一条命中记录');
      truthy(r && r.meta && r.meta.note === '备注', '兜底路径也要带上 meta（否则备注卡读不到 note）');
    } finally { restore(); }
  });
};
