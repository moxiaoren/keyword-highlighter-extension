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
};
