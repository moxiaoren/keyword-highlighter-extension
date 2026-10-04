/* tests/specs/color-field.test.js — 色板与取色器的"合理性"不变式
 * ----------------------------------------------------------------------------
 * 用户实测要求（2026-09）：
 *   "底色、字体颜色可选颜色较少，且字体颜色连最基本的黑色都没有。请梳理哪些颜色直接列出来合理，
 *    剔除不合理的颜色、补充必备颜色，可选从 5*3 改成 5*4，且在下方增加一个颜色条，让用户可拖动选择颜色。"
 *
 * 这里锁的是**可机械验证**的那部分（纯数据 + 纯数学，毫秒级）：
 *   · 色板规模 = 5 列 × 4 行；无重复；名字唯一；
 *   · 第 1 行是中性灰阶（含**纯黑与纯白** —— 用户点名的缺口）；
 *   · 第 4 行是浅色底（高亮度 + 低饱和，作高亮底色用）；中间两行是彩色（不是灰、也不是浅底）；
 *   · 默认底色 `#ff9500` 必须在色板里（否则用户无法把颜色选回默认）；
 *   · hex ⇄ hsv 换算自洽（取色器全靠它，算错就会"拖到哪都不是那个色"）。
 * 交互层（拖动是否真的改色、5×4 是否真的排成 5 列 4 行）由 `_e2e/ui.test.js` 组 9b 在真浏览器里锁。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  /* ⚠️ 只加载这一个 UI 文件：**不能**再调 loadKernel（它会把内核注册表重置成空）。
   * color-field.js 对 ui.dom / ui.Popover 都是**惰性**取用，所以单独执行它是安全的。 */
  require('../bootstrap');
  const file = path.join(__dirname, '..', '..', 'src', 'ui', 'components', 'color-field.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'globalThis', fs.readFileSync(file, 'utf8'))(global.window, global.document, global);
  const CF = global.window.KH.ui.ColorField;
  const P = CF.PALETTE;

  const rgbOf = (hex) => CF.hexToRgb(hex);
  const isGray = (hex) => { const c = rgbOf(hex); return c.r === c.g && c.g === c.b; };
  const maxOf = (hex) => { const c = rgbOf(hex); return Math.max(c.r, c.g, c.b); };
  const spreadOf = (hex) => { const c = rgbOf(hex); return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b); };
  const isPale = (hex) => maxOf(hex) >= 200 && spreadOf(hex) <= 90;
  const dist = (a, b) => {
    const x = rgbOf(a), y = rgbOf(b);
    return Math.sqrt(Math.pow(x.r - y.r, 2) + Math.pow(x.g - y.g, 2) + Math.pow(x.b - y.b, 2));
  };

  suite('color-field · 色板（5 列 × 4 行）');

  await test('★ 规模：5 列 × 4 行 = 20 色，全部合法 hex 且无重复', () => {
    eq(CF.PALETTE_COLUMNS, 5, '列数必须是 5');
    eq(P.length, 20, '色板必须是 20 色（5 列 × 4 行），实际 ' + P.length);
    eq(P.length % CF.PALETTE_COLUMNS, 0, '色板必须能整除列数（才能排满整行）');
    for (const x of P) truthy(CF.HEX.test(x.color), '色值必须合法：' + JSON.stringify(x));
    const hexes = P.map((x) => x.color);
    eq(new Set(hexes).size, 20, '色板里不得有重复色值');
    eq(new Set(P.map((x) => x.name)).size, 20, '每个色都要有唯一名字（进 tooltip）');
    for (const x of P) truthy(x.name && x.name.length >= 2, '色名不能为空：' + JSON.stringify(x));
  });

  await test('★ 第 1 行必须是中性灰阶，且含纯黑与纯白（用户点名的缺口）', () => {
    const row1 = P.slice(0, 5).map((x) => x.color);
    console.log('        第 1 行: ' + JSON.stringify(row1));
    for (const c of row1) truthy(isGray(c), '第 1 行必须是中性色（r=g=b）：' + c);
    truthy(row1.indexOf('#000000') >= 0, '必须有**纯黑**（字体颜色最基础的一档，旧色板没有）');
    truthy(row1.indexOf('#ffffff') >= 0, '必须有**纯白**（深底色上要能配出可读文字）');
    // 灰阶要**拉开档位**（黑→白之间至少 3 档，且两两差异明显）
    eq(row1.length, 5, '灰阶应是 5 档');
    for (let i = 1; i < row1.length; i++) {
      truthy(maxOf(row1[i]) - maxOf(row1[i - 1]) >= 30,
        '灰阶档位应拉开（相邻两档至少差 30）：' + row1[i - 1] + ' → ' + row1[i]);
    }
  });

  await test('★ 第 4 行是浅色底，中间两行是彩色（行语义不得混）', () => {
    const mid = P.slice(5, 15).map((x) => x.color);
    const pale = P.slice(15).map((x) => x.color);
    console.log('        中间两行: ' + JSON.stringify(mid));
    console.log('        浅色底行: ' + JSON.stringify(pale));
    for (const c of pale) truthy(isPale(c), '第 4 行每色都应是"浅色底"（亮且不浓）：' + c);
    for (const c of mid) {
      falsy(isPale(c), '中间两行不该混进"浅色底"（那是第 4 行的用途）：' + c);
      truthy(!isGray(c), '中间两行应是彩色，不该是灰阶：' + c);
    }
  });

  await test('★ 默认底色必须在色板里（否则用户选不回默认色）', () => {
    truthy(P.map((x) => x.color).indexOf(CF.DEFAULT_COLOR) >= 0,
      '全局默认底色 ' + CF.DEFAULT_COLOR + ' 必须在色板里');
  });

  await test('色板里不得有"看起来一样"的两色（两两 RGB 距离 ≥ 25）', () => {
    let worst = { d: 1e9, a: '', b: '' };
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const d = dist(P[i].color, P[j].color);
        if (d < worst.d) worst = { d: d, a: P[i].color, b: P[j].color };
      }
    }
    console.log('        最接近的一对: ' + worst.a + ' / ' + worst.b + ' 距离 ' + worst.d.toFixed(1));
    truthy(worst.d >= 25, '色板里有两色过近（' + worst.a + ' / ' + worst.b + '）→ 属于"不合理的重复"');
  });

  suite('color-field · 颜色换算（取色器依赖）');

  await test('★ hex → hsv → hex 往返一致（色板 20 色全覆盖）', () => {
    for (const x of P) {
      const hsv = CF.hex2hsv(x.color);
      eq(CF.hsv2hex(hsv.h, hsv.s, hsv.v), x.color, '往返必须回到原色：' + x.color);
    }
  });

  await test('★ 已知色值的 hsv 分量正确（色相条/浓淡区靠它对齐）', () => {
    const cases = [
      ['#ff0000', 0, 1, 1], ['#00ff00', 120, 1, 1], ['#0000ff', 240, 1, 1],
      ['#ffffff', null, 0, 1], ['#000000', null, null, 0], ['#808080', null, 0, null]
    ];
    for (const c of cases) {
      const hsv = CF.hex2hsv(c[0]);
      if (c[1] != null) eq(Math.round(hsv.h), c[1], c[0] + ' 的色相');
      if (c[2] != null) eq(Math.round(hsv.s * 100) / 100, c[2], c[0] + ' 的饱和');
      if (c[3] != null) eq(Math.round(hsv.v * 100) / 100, c[3], c[0] + ' 的明度');
    }
  });

  await test('取色器能取到纯黑（拖到最暗）—— 旧色板里根本选不出黑色', () => {
    /* 浓淡明暗区：横向 = 饱和，纵向 = 明度（底部 = 最暗）。取色器用 hsv2hex(h,s,v) 落色：
     * 只要有**任意** s 在 v=0 时都得到 #000000，用户在色板上就一定能拖出黑色。 */
    for (const s of [0, 0.5, 1]) eq(CF.hsv2hex(200, s, 0), '#000000', 'v=0 必须是最黑（s=' + s + '）');
    eq(CF.hsv2hex(200, 0, 1), '#ffffff', 's=0,v=1 必须是最白');
  });

  await test('HEX 正则：3 位/6 位合法，其余非法（色值输入框的判据）', () => {
    for (const ok of ['#fff', '#FFF', '#000000', '#ff9500']) truthy(CF.HEX.test(ok), ok + ' 应合法');
    for (const bad of ['#12345', '#1234567', 'ff9500', 'red', '', '#gggggg']) falsy(CF.HEX.test(bad), bad + ' 应非法');
  });
};
