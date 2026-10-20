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

  await test('★ 普通模式：`|` 也是「多个词」的分隔符（2.0.2.11 票 #65）', () => {
    /* 垫片里 `document.getElementById` 恒为 null ⇒ 兄弟开关取不到 ⇒ 走普通模式这条路径。
     * 2.0.2.11 起**两种模式都按 | 切**，差别只在"每段怎么编译"（`compiler.js` 普通模式逐段 escape）。 */
    const ctrl = mk('text', 'A|B');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), 'A/B', '★ 普通模式也按 | 摊开（一次配两个词，两个都生效）');
    eq(ctrl.read(), 'A|B', '★ 没动过 ⇒ read() 逐字回原串');
    const tip = ctrl.el.querySelector('.kh-cand-tip');
    truthy(tip, '要有提示位');
    eq(tip.hidden, true, '`|` 已是分隔符，不再需要"| 不是或"的警告');
  });

  await test('★ 普通模式下写了正则式子 ⇒ 提示"按字面匹配"（别以为生效了）', () => {
    const ctrl = mk('text', 'A.C');
    const tip = ctrl.el.querySelector('.kh-cand-tip');
    eq(tip.hidden, false, '段里出现正则元字符时要露出来');
    truthy(tip.textContent.indexOf('正则') >= 0, '要说清"要当正则用请勾上正则"：' + tip.textContent);
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), 'A.C', '胶囊仍按字面显示');
  });

  await test('★ 普通模式且值里没有正则元字符 ⇒ 提示不露（别天天挂着一条警告）', () => {
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
    /* 【2.0.2.11 票 #64】imgSize / noteFontSize 搬进富文本工具栏 ⇒ 控件本身就是那颗按钮，
     * 不再套一层 `.kh-fld` 外壳。判据放成"自己就是容器，或里面有容器"，两者都算。 */
    truthy(c.el.classList.contains('kh-num-box') || c.el.querySelector('.kh-num-box'),
      '要有值胶囊容器');
    const inp = c.el.querySelector('input');
    truthy(inp, '★ 数字框仍在控件里（只是常态藏着）');
    eq(inp.getAttribute('id'), 'fld-imgSize', 'id 必须还是 `fld-imgSize`');
    eq(inp.getAttribute('type'), 'number', '仍是数字框（上下限/步进还挂在它身上）');
    /* 垫片里 `h('input',{value})` 只落**属性**、property 不反射（真机上 `<input value=70>` 的
     * `input.value` 就是 '70'）—— 这里按真机口径把值喂进去，再派发一次 input 让胶囊刷新。 */
    inp.value = '70'; inp.dispatchEvent({ type: 'input' });
    eq(textOf(c, '.kh-num-btn').join('/'), '▭70', '常态就把当前值写在按钮上（`▭` 前缀区分尺寸/字号）');
    eq(c.read(), 70, 'read() 仍走 FieldMap.coerce（存储契约不变）');

    const empty = mk('noteFontSize', '');
    const inp2 = empty.el.querySelector('input');
    inp2.value = ''; inp2.dispatchEvent({ type: 'input' });
    /* 【2.0.2.11 票 #64】工具栏里「字号」那颗带 `A` 前缀（与「尺寸」`▭` 区分），留空就只显前缀字 */
    eq(textOf(empty, '.kh-num-btn').join('/'), 'A', '留空 ⇒ 按钮只显示前缀字（默认）');
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
    /* 【2.0.2.16 需求⑤】这句提示从"flex 里的一整行"改成**浮层**：以前它占一行 ⇒ 一出现就把
     * 字段盒撑高、整张卡的字段跟着往下掉（用户："破坏了页面结果布局"）。现在绝对定位挂在框下方。 */
    truthy(/\.kh-cand-tip\s*\{[^}]*position:\s*absolute/.test(css),
      '★ 提示必须是浮层（绝对定位），不许再参与列布局');
    truthy(/\.kh-cand-tip\s*\{[^}]*top:\s*calc\(100% \+ 3px\)/.test(css), '浮层挂在框下方');
    truthy(/\.kh-cand-box\s*\{[^}]*position:\s*relative/.test(css),
      '定位父级是字段盒本身（否则浮层会跑到弹窗左上角）');
    falsy(/\.kh-cand-tip\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(css),
      '旧的"占一行"写法（flex: 0 0 auto + width: 100%）已作废');
  });

  await test('★ 2.0.2.10：图片 OCR 三件排进同一子块；备注/笔记内容标了 grow；备注占位只留一行', () => {
    /* 用户口径（2026-10-18）："因为加了图片ocr相关功能，导致整个添加关键词界面布局有点怪"。
     * 实测抓取卡的子元素是「候选框 h49 → 抓取范围 h49 → 裸勾选框 h17 → 候选框 h49 → 内联数字 h24」，
     * 三种高度在 `align-items: flex-end` 下各自换行成阶梯 ⇒ 看着像三件不相干的东西。
     * 这里锁**排布契约**：三件落进同一个 `.kh-fld-sub`，勾选行独占一行（宽度 2）。 */
    const h = KH.ui.dom.h;
    const body = h('div', { class: 'kh-editor-sec-body' });
    document.body.appendChild(body);
    const items = ['fetchLabels', 'fetchScope', 'imgOcr', 'imgOcrKeyword', 'imgOcrNeed', 'imgOcrMax']
      .map((k) => ({ spec: FM.byKey(k), ctrl: mk(k, '') }));
    KH.ui.Fields.layout(items, body);

    const subs = body.querySelectorAll('.kh-fld-sub');
    eq(subs.length, 1, '抓取卡只该有一个字段子块（图片 OCR 四件）');
    const sub = subs[0];
    const cls = Array.from(sub.childNodes).map((k) => String(k.className));
    /* 【2.0.3 需求②】子块从三件变四件：图片动态关键词也是一个候选框（与图片命中关键词同宽度整行），
     * 张数仍是内联半行 —— 顺序：开关 / 命中关键词 / 动态关键词 / 张数。 */
    eq(cls.length, 4, '子块里正好四件（勾选行 + 图片命中关键词 + 图片动态关键词 + 张数）：' + cls.join(' / '));
    truthy(cls.some((c) => /kh-fld-bool/.test(c)), '「识别图片文字」在子块里');
    eq(cls.filter((c) => /kh-cand-box/.test(c)).length, 2, '两个候选框（图片命中关键词 + 图片动态关键词）在子块里');
    truthy(cls.some((c) => /kh-fld-inline/.test(c)), '「张数」在子块里');
    eq(body.childNodes.length, 3, '正文三个直接子元素：字段 / 抓取范围 / 子块（勾选行不再跟抓取范围挤一行）');
    truthy(/kh-fld-bool-wide/.test(String(mk('imgOcr', '').el.className)),
      '「识别图片文字」是子块的开关行，要独占一行（否则 17px 高的勾选行会底对齐浮在上一行右端）');
    eq(FM.byKey('imgOcr').width, 2, 'imgOcr 声明为整行（width: 2）');

    /* 票 #56：两处可写区标 grow（列高撑满后由 CSS 把余高交给它们，别再留成卡内死白） */
    eq(FM.byKey('note').grow, true, '备注是 grow 字段');
    eq(FM.byKey('importantNote').grow, true, '笔记内容是 grow 字段');

    /* 票 #55：占位文字只留一行；完整语法搬进 hint（title），信息不丢 */
    const note = FM.byKey('note');
    truthy(String(note.placeholder || '').length <= 24,
      '备注占位要短（现 ' + String(note.placeholder || '').length + ' 字；原来 66 字把 4 行框填满）');
    truthy(/表格/.test(String(note.hint || '')), '完整语法（含表格）要留在 tooltip 里');
  });

  await test('★ 2.0.2.11 票 #63：抓取字段＝关键词同款胶囊 + 后缀徽标 + 默认裁切/可展开', () => {
    /* 用户要求 2（m01695）：「抓取后续字段输入框统一成关键词和标题词的 ui 和交互模式
     * （词的数量过多时，可以增加输入框宽度）」；口径（m01713）：「宽度高度都默认不变，
     * 超出隐藏超出部分。但支持手动展开/收起」。 */
    const ctrl = mk('fetchLabels', '名称#图|备注');
    eq(ctrl.el.querySelectorAll('.kh-lbl-chip').length, 2, '两个字段各一颗胶囊（与关键词同一套胶囊）');
    const badges = ctrl.el.querySelectorAll('.kh-lbl-suffix');
    eq(badges.length, 1, '带后缀的那颗要画徽标（`#图` 要看得出来是指什么）');
    truthy(ctrl.el.querySelector('.kh-lbl-legend'), '后缀图例还要在（折在 details 里）');

    const box = ctrl.el.classList.contains('kh-cand-clamp') ? ctrl.el : ctrl.el.querySelector('.kh-cand-clamp');
    truthy(box, '抓取字段的框要带 `kh-cand-clamp`（默认单行裁切）');
    falsy(box.classList.contains('is-open'), '默认不展开（尺寸和普通输入框一样高）');
    const toggle = ctrl.el.querySelector('.kh-clamp-btn');
    truthy(toggle, '要有「展开/收起」钮');
    toggle.dispatchEvent({ type: 'click' });
    truthy(box.classList.contains('is-open'), '点一下展开（词多时能一次看全）');
    toggle.dispatchEvent({ type: 'click' });
    falsy(box.classList.contains('is-open'), '再点收回单行');
    eq(ctrl.read(), '名称#图|备注', '展开收起不许动值');
    /* 抓取字段的切法必须与落盘口径一致（`｜` 与 `@表达式` 里的逗号都算分隔符）：
     * 控件切得比落盘粗，就会出现「界面一个胶囊、保存后两个字段」。 */
    const half = mk('fetchLabels', '名称｜备注');
    eq(half.el.querySelectorAll('.kh-lbl-chip').length, 2, '全角 ｜ 也要当分隔符');
  });

  await test('★ 票 #66：每个候选框都单行裁切（关键词/标题关键词/图片命中关键词），展开钮只在真溢出时出现', () => {
    /* 用户口径 m02382：「胶囊过多，过长时没有按要求维持原来的输入框，一行展示（冗余的不展示）。
     * 展开后才完整展示」。2.0.2.11 只给抓取字段开了 `clamp`，关键词与标题关键词仍会被胶囊撑成
     * 2–3 行 —— 字段盒高度跟着长，旁边的字段就被顶歪。 */
    for (const k of ['text', 'cellVerify', 'imgOcrKeyword', 'fetchLabels']) {
      const c = mk(k, '');
      truthy(c.el.classList.contains('kh-cand-clamp'), k + ' 要带 `kh-cand-clamp`（默认单行裁切）');
      const btn = c.el.querySelector('.kh-clamp-btn');
      truthy(btn, k + ' 要有「展开/收起」钮（占位存在，溢出才显示）');
      /* 垫片没有布局引擎（`scrollWidth` 恒 undefined ⇒ 判"没溢出"）⇒ 这里锁的是"无溢出时藏起来" */
      eq(btn.hidden, true, k + ' 空框时展开钮要藏着（没东西可展开）');
    }
    const c = mk('text', '2018年|2024年|百度知道|阿里巴巴');
    const btn = c.el.querySelector('.kh-clamp-btn');
    btn.dispatchEvent({ type: 'click' });
    truthy(c.el.classList.contains('is-open'), '点开 ＝ 展开（换行全显）');
    eq(btn.hidden, false, '展开态按钮必须看得见（否则没法收起）');
    eq(c.read(), '2018年|2024年|百度知道|阿里巴巴', '展开收起不许动值');
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-cand-clamp \.kh-cand-field\s*\{[^}]*flex-wrap:\s*nowrap/.test(css),
      '裁切态框内不许换行（否则胶囊多了照样把框撑高）');
    truthy(/\.kh-cand-clamp \.kh-cand-field > \.kh-lbl-preview\s*\{[^}]*overflow:\s*hidden/.test(css),
      '胶囊行自己要 overflow:hidden（不然会把框撑宽、把 + 顶出去）');
    truthy(/\.kh-cand-clamp\.is-open \.kh-cand-field\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '展开态才换行');
  });

  await test('★ 2.0.2.11 票 #64：底色/尺寸/字号搬进笔记工具栏，与加粗/表格同一行；「笔记内容」标题删除', () => {
    /* 用户要求 4（m01695）：三者放进 B/I/U/链接/图片/表格那一行，并删掉「笔记内容」标题。 */
    const h = KH.ui.dom.h;
    const body = h('div', { class: 'kh-editor-sec-body' });
    document.body.appendChild(body);
    const items = ['impNoteUseHlColor', 'imgSize', 'noteFontSize', 'importantNote']
      .map((k) => ({ spec: FM.byKey(k), ctrl: mk(k, '') }));
    KH.ui.Fields.layout(items, body);

    const bar = body.querySelector('.kh-rt-toolbar');
    truthy(bar, '笔记编辑器要有工具栏');
    const barCls = Array.from(bar.childNodes).map((k) => String(k.className));
    eq(barCls.filter((c) => /kh-tool-field/.test(c)).length, 3,
      '三件都要在工具栏行里：' + barCls.join(' / '));
    const iTool = barCls.findIndex((c) => /kh-tool-field/.test(c));
    const iClear = barCls.findIndex((c) => /kh-rt-clear/.test(c));
    truthy(iTool >= 0 && iClear > iTool, '三件要排在「清空」之前（清空是行尾那颗）');
    truthy(!!bar.querySelector('.kh-tool-toggle'), '底色渲染成一个图标开关（与加粗同级的小钮，不是下拉框）');
    eq(Array.from(body.childNodes).filter((k) => /kh-tool-field/.test(String(k.className))).length, 0,
      '三件不该再单独占正文行');

    eq(FM.byKey('importantNote').noLabel, true, '关键词弹窗里的「笔记内容」标题要删掉');
    eq(String(body.textContent || '').indexOf('笔记内容'), -1, '正文里不许再出现「笔记内容」这行字');
  });
};
