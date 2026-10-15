/* tests/specs/labels-field.test.js — 「字段」控件的**胶囊预览**（2.0.2.4 需求④）
 * ----------------------------------------------------------------------------
 * 用户原话（2.0.2.4 需求 4）："整体梳理字段填入方式和展示形式，还有 #、@、！、% 等字段后缀补充功能，
 * 思考能否以更好的方式实现（比如，多字段逐个填入，填入后拆分为多个胶囊。这些补充限制作为后缀展示。）"
 *
 * 用户已明确录入方式**不变**（还是单框 `|` 批量，如 `关键词a@1|关键词b#图`），所以这里锁的是
 * 「写进去的那串**当场解析给你看**」这一层：
 *   · 每段一个胶囊 = 名字 + 后缀徽标，`✕` 删**那一段**（按序号删，重复段只少一个）；
 *   · `read()` 必须仍回**整串原文** —— 值/分隔符/CSV 第 17 列的存储契约一个字都不许被控件改掉；
 *   · 后缀图例常显（`!` / `%` / `^` 历史上零提示，只活在更新日志里）；
 *   · 选项页必须**先**加载抓取实现（语法只有一份：`KH.Fetch`）。
 *
 * 真机观感（截图 / 点击热区）由 `_e2e/ui.test.js` 覆盖；这里只锁得住的部分，毫秒级。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const FM = KH.FieldMap;

  /**
   * 造一个「字段」控件并驱动到指定值。
   * 垫片里 `h('input', {value})` 只落在**属性**上（property 不反射），要自己赋 `inp.value` 再派发
   * `input` 才会走 `draw()` —— 真浏览器里初值天然可读，这里补的是垫片的差。
   */
  const mk = (val) => {
    const ctrl = KH.ui.Fields.create(FM.byKey('fetchLabels'), val, {});
    const inp = ctrl.el.querySelector('input');
    inp.value = val;
    inp.dispatchEvent({ type: 'input' });
    return ctrl;
  };
  const textOf = (ctrl, sel) => ctrl.el.querySelectorAll(sel).map((el) => el.textContent);

  suite('字段控件 · 胶囊预览（2.0.2.4 需求④）');

  await test('★ 接线：字段控件是 labels 类型；选项页先加载抓取实现（语法只有一份）', () => {
    eq(FM.byKey('fetchLabels').type, 'labels', '抓取字段要用能画胶囊的控件');
    eq(FM.byKey('fetchLabels').csv, 17, 'CSV 还是第 17 列（只换控件形态，不动落盘位置）');
    const html = read('options/options.html');
    const iFetch = html.indexOf('../src/features/fetch.js');
    const iFields = html.indexOf('../src/ui/components/fields.js');
    truthy(iFetch > 0, '选项页必须加载抓取实现（胶囊的后缀解析走它）');
    truthy(iFields > 0, '选项页当然要加载字段控件');
    truthy(iFetch < iFields, '★ 抓取实现必须排在字段控件**之前** —— 否则加载期 KH.Fetch 还没有，胶囊会静默退化');
  });

  await test('★ 两段 ⇒ 两个胶囊（名字 + 后缀徽标分开写），read() 仍是整串原文', () => {
    const raw = '名称^[复制]|备注#图';
    const ctrl = mk(raw);
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '名称/备注', '胶囊里只放**字段名**（后缀单独一节）');
    eq(textOf(ctrl, '.kh-lbl-suffix').join('/'), '^[复制]/#图', '后缀要原样摊开给用户看');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 2, '两段两个胶囊');
    eq(ctrl.read(), raw, '★ read() 必须回整串原文（分隔符/后缀一个字都不许被控件归一）');
    const del = ctrl.el.querySelectorAll('.kh-lbl-del')[0];
    truthy(del && del.getAttribute('title'), '删除按钮要有 title（说清删的是哪一段）');
  });

  await test('★ ✕ 按**段序号**删（重复段只少一个），不是"按文本删全部"', () => {
    const ctrl = mk('一对一#图|美女#图');
    ctrl.el.querySelectorAll('.kh-lbl-del')[0].dispatchEvent({ type: 'click' });
    eq(ctrl.read(), '美女#图', '删掉第一段');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '美女', '预览要跟着重画');

    const dup = mk('备注|备注');
    dup.el.querySelectorAll('.kh-lbl-del')[0].dispatchEvent({ type: 'click' });
    eq(dup.read(), '备注', '重复的两段删一个只少一个（按序号删；按文本删会把两个一起删掉）');
  });

  await test('没写后缀不画徽标；首尾/连续 `|` 的空段不画胶囊', () => {
    const plain = mk('名称|备注');
    eq(textOf(plain, '.kh-lbl-chip').length, 2, '两段两个胶囊');
    eq(textOf(plain, '.kh-lbl-suffix').length, 0, '没写后缀 ⇒ 一个徽标都不许画');
    for (const [raw, want] of [['名称|', 1], ['|名称', 1], ['名称||备注', 2]]) {
      const c = mk(raw);
      eq(textOf(c, '.kh-lbl-chip').length, want, '空段不画胶囊：' + raw);
      eq(c.read(), raw, '预览只是"看"，原文不许被它改写：' + raw);
    }
  });

  await test('★ 后缀图例常显（`!` / `%` / `^` 不许再是"只有更新日志里才知道"的功能）', () => {
    const ctrl = mk('名称');
    const legend = ctrl.el.querySelectorAll('.kh-lbl-legend')[0];
    truthy(legend, '要有一行后缀图例');
    const t = legend.textContent;
    for (const key of ['#图', '@', '!', '^锚文本', '%']) {
      truthy(t.indexOf(key) >= 0, '图例里要提到 ' + key + '：' + t);
    }
    /* 反向：图例别把语法写成"仅图片 / 前 N 张"之外的东西 —— 语法真源在 Fetch.parseLabelSpec */
    falsy(/\bundefined\b/.test(t), '图例文案不许出现 undefined');
  });
};
