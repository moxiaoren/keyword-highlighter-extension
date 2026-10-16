/* tests/specs/cands-int-field.test.js — 【2.0.2.7 需求①②】候选胶囊 + 数值值胶囊
 * ----------------------------------------------------------------------------
 * 用户原话：1、"添加关键词里面，核心词、标题词、图片命中词，是不是也可以复用。输入+胶囊的形式。
 * 另外，为了美观。是不是可以只展示胶囊，然后点击一个按钮，弹出输入框。"
 *          2、"添加关键词-重要笔记模块，图片大小、字号，占的空间有点大。可不可以也改成点击按钮显示修改，
 * 常态以胶囊简约展示当前设定。"
 * 规范原话："② 数值胶囊（图片尺寸、字号）① 候选胶囊(统一以输入框内部胶囊形式展示，普通匹配就一个胶囊，
 * 增加就点击输入框末尾的+按钮，这样可以么。)"
 *
 * 这里锁**控件层**（毫秒级、无浏览器）：
 *   · `cands`：常态只画胶囊；**输入框仍在 DOM 里**（`getElementById('<id>')` 随时取得到 —— 保存往返与
 *     自动化装置都直接取它）；`read()` 没动过时**逐字**回原串；回车＝把这一段收成胶囊 + 清空输入框；
 *   · **切分口径跟着「正则」开关走**：普通模式 `|` 是普通字符 ⇒ 整串一个胶囊 + 一行提示；正则模式才按
 *     `|` 摊开。`compiler.js` 普通模式会把整串转义（写 `A|B` 匹配的是字面量 `A|B`），
 *     所以普通模式切出多个候选就是**骗人**；
 *   · `int`：常态是**值胶囊**（留空显示「默认」），输入框（`#fld-imgSize` 这类 id）仍在 DOM 里，
 *     `read()` 仍走 `FieldMap.coerce`。
 * 浮层位置/点击热区/真机观感由 `_e2e/ui.test.js` 覆盖。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const FM = KH.FieldMap;

  /** 造一个控件（`{}` = 默认 ctx：`idPrefix` 缺省 `fld-`） */
  const mk = (key, val) => KH.ui.Fields.create(FM.byKey(key), val, {});
  const textOf = (ctrl, sel) => ctrl.el.querySelectorAll(sel).map((el) => el.textContent);
  /** 输入框可能被浮层借走（`attachPop`）—— 先在本控件里找，找不到就去浮层里找 */
  const inpOf = (ctrl) => {
    const own = ctrl.el.querySelector('input');
    if (own) return own;
    const pop = document.body.querySelector('.kh-pop-edit');
    return pop && pop.querySelector('input');
  };
  const type = (ctrl, text) => { const inp = inpOf(ctrl); inp.value = text; inp.dispatchEvent({ type: 'input' }); };
  const enter = (ctrl) => inpOf(ctrl).dispatchEvent({ type: 'keydown', key: 'Enter' });

  suite('候选胶囊 + 数值值胶囊（2.0.2.7 需求①②）');

  await test('★ 接线：三个候选词字段换成 cands（CSV 列号一个字不动）', () => {
    for (const [key, csv] of [['text', 1], ['cellVerify', 13], ['imgOcrKeyword', 0]]) {
      const f = FM.byKey(key);
      eq(f.type, 'cands', key + ' 要用候选胶囊控件');
      eq(f.csv, csv, key + ' 的 CSV 列号必须未动（只换控件形态）');
    }
    eq(FM.byKey('text').regexKey, 'useRegex', '核心词的切分口径跟它的「正则」开关走');
    eq(FM.byKey('cellVerify').regexKey, 'cellVerifyUseRegex', '标题词跟它自己的「正则」开关走');
    eq(FM.byKey('imgOcrKeyword').regexAlways, true, '图片命中词恒为正则（没有开关），按 | 切永远是对的');
    for (const key of ['imgSize', 'noteFontSize', 'imgOcrMax']) {
      eq(FM.byKey(key).type, 'int', key + ' 仍是数值字段（换成值胶囊是控件内部的事）');
    }
  });

  await test('★ 普通模式：`|` 是普通字符 ⇒ **整串一个胶囊** + 一行提示（切了就是骗人）', () => {
    /* 垫片里 `document.getElementById` 恒为 null ⇒ 兄弟开关取不到 ⇒ 走普通模式这条保守路径 */
    const ctrl = mk('text', 'A|B');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 1, '普通模式不许按 | 摊成两个候选');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), 'A|B', '整串当**一个**词展示');
    eq(ctrl.read(), 'A|B', '★ 没动过 ⇒ read() 逐字回原串');
    const tip = ctrl.el.querySelector('.kh-cand-tip');
    truthy(tip, '要有提示位');
    truthy(tip.textContent.indexOf('正则') >= 0,
      '要说清"要多个候选请勾正则"：' + tip.textContent);
    eq(tip.hidden, false, '值里真有 | 时提示要露出来');
  });

  await test('★ 普通模式且值里没有 `|` ⇒ 提示不露（别天天挂着一条警告）', () => {
    const ctrl = mk('text', '华为');
    eq(ctrl.el.querySelector('.kh-cand-tip').hidden, true, '没有歧义就不提示');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '华为', '一个词一个胶囊');
  });

  await test('★ 正则模式（图片命中词恒为正则）：按 `|` 摊开，read() 仍是整串原文', () => {
    const raw = '一对一|A.C';
    const ctrl = mk('imgOcrKeyword', raw);
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '一对一/A.C', '正则模式下 | 才是"或"');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 2, '两个候选两个胶囊');
    eq(ctrl.read(), raw, '★ read() 必须回整串原文（分隔符一个字都不许被控件归一）');
    const del = ctrl.el.querySelectorAll('.kh-lbl-del')[0];
    truthy(del && del.getAttribute('title'), '✕ 要有 title（说清删的是哪个候选）');
  });

  await test('★ 输入框仍活在 DOM 里（id 不变 + 常态藏着，`getElementById` 取得到）', () => {
    const text = mk('text', '华为');
    const t = text.el.querySelector('input');
    truthy(t, '★ 输入框必须在控件里（不是"没有"，只是常态 `display:none`）');
    eq(t.getAttribute('id'), 'fld-text', 'id 必须还是 `fld-<key>` —— 保存/装置都直接按它取节点');
    const k = mk('imgOcrKeyword', '一对一');
    eq(k.el.querySelector('input').getAttribute('id'), 'fld-imgOcrKeyword', '候选字段同理');
    truthy(text.el.querySelector('.kh-cand-add'), '末尾要有「+」按钮（唯一的录入入口）');
  });

  await test('★ 没回车直接保存 ⇒ 待定内容也一并带上；回车 ⇒ 收成胶囊并清空输入框', () => {
    const ctrl = mk('imgOcrKeyword', '一对一');
    type(ctrl, '美女');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '一对一/美女', '边打边看（还没回车也先画出来）');
    eq(ctrl.read(), '一对一|美女', '★ 待定内容也要带上（不许丢数据）');
    enter(ctrl);
    eq(inpOf(ctrl).value, '', '★ 回车后输入框不留内容（用户原话：输入框可以不保留内容）');
    eq(ctrl.read(), '一对一|美女', '收成胶囊后值一个字都没变');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '一对一/美女', '胶囊一个不多一个不少');
  });

  await test('★ ✕ 按候选删；点胶囊把那一个候选载回输入框改（位置不动）', () => {
    const ctrl = mk('imgOcrKeyword', '一对一|美女');
    ctrl.el.querySelectorAll('.kh-lbl-del')[0].dispatchEvent({ type: 'click' });
    eq(ctrl.read(), '美女', '删掉第一个候选');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '美女', '预览跟着重画');

    const again = mk('imgOcrKeyword', '一对一|美女');
    again.el.querySelectorAll('.kh-lbl-chip')[1].dispatchEvent({ type: 'click' });
    eq(inpOf(again).value, '美女', '★ 点胶囊 ⇒ 那一个候选的原文进了输入框');
    eq(again.read(), '一对一|美女', '只是载回来，值一个字节都不许变');
    type(again, '帅哥');
    enter(again);
    eq(again.read(), '一对一|帅哥', '★ 只改那一个候选，位置也不动');
  });

  await test('★ 数值字段：常态只显值胶囊（留空＝「默认」），数字框仍在同一 id 上', () => {
    const c = mk('imgSize', 70);
    truthy(c.el.querySelector('.kh-num-box'), '要有值胶囊容器');
    const inp = c.el.querySelector('input');
    truthy(inp, '★ 数字框仍在控件里（只是常态藏着）');
    eq(inp.getAttribute('id'), 'fld-imgSize', 'id 必须还是 `fld-imgSize`');
    eq(inp.getAttribute('type'), 'number', '仍是数字框（上下限/步进还挂在它身上）');
    /* 垫片里 `h('input',{value})` 只落**属性**、property 不反射（真机上 `<input value=70>` 的
     * `input.value` 就是 '70'）—— 这里按真机口径把值喂进去，再派发一次 input 让胶囊刷新。 */
    inp.value = '70'; inp.dispatchEvent({ type: 'input' });
    eq(textOf(c, '.kh-num-btn').join('/'), '70', '常态就把当前值写在按钮上');
    eq(c.read(), 70, 'read() 仍走 FieldMap.coerce（存储契约不变）');

    const empty = mk('noteFontSize', '');
    const inp2 = empty.el.querySelector('input');
    inp2.value = ''; inp2.dispatchEvent({ type: 'input' });
    eq(textOf(empty, '.kh-num-btn').join('/'), '默认', '留空 ⇒ 按钮写「默认」');
    eq(empty.read(), '', '留空仍是留空（不许被控件写成默认值）');
  });

  await test('★ 候选框是"输入框样子"的框：胶囊装在框里、空态显占位、末尾一个 +', () => {
    /* 用户口径 m02566（"好丑"第一条）：一个输入框，里面展示胶囊内容；点 `+` 弹出小输入框编辑、
     * 回车回到展示模式。旧实现是"标签一行 + 旁边几颗胶囊 + ＋"（`＋` 还会被挤到第二行），
     * 既不像输入框，也和旁边的真输入框不成一族。 */
    const ctrl = mk('text', '华为');
    const frame = ctrl.el.querySelector('.kh-cand-field');
    truthy(frame, '要有候选框（`.kh-cand-field`）');
    truthy(frame.querySelector('.kh-lbl-preview') && frame.querySelector('.kh-cand-add'),
      '框里装的是"胶囊 + ＋"');
    eq(frame.querySelector('.kh-lbl-name').textContent, '华为', '胶囊在框**里面**');
    const empty = mk('text', '');
    const ph = empty.el.querySelector('.kh-cand-field .kh-cand-ph');
    truthy(ph && !ph.hidden, '空框要显占位文字（否则看不出这是个空输入框）');
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-cand-field\s*\{[^}]*min-height:\s*30px/.test(css),
      '框要有 30px 高（＝普通输入框高 ⇒ 字段盒高与相邻字段一致、才可能行对齐）');
    truthy(/\.kh-cand-field\s*\{[^}]*border:\s*1px solid/.test(css), '框要有输入框那样的边框');
    falsy(/\.kh-cand-row\s*\{/.test(css), '旧的"胶囊行"已作废（胶囊要装进框里）');
    truthy(/\.kh-cand-tip\s*\{[^}]*flex:\s*0 0 auto/.test(css),
      '提示行在**列**容器里不能写 `flex: 1 1 100%`（basis 会被当成高度用）');
  });
};
