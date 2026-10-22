/* tests/specs/labels-field.test.js — 「字段」控件的**可编辑胶囊**（2.0.2.4 需求④ → 2.0.2.6 升级）
 * ----------------------------------------------------------------------------
 * 用户原话（2.0.2.4 需求 4）："整体梳理字段填入方式和展示形式，还有 #、@、！、% 等字段后缀补充功能，
 * 思考能否以更好的方式实现（比如，多字段逐个填入，填入后拆分为多个胶囊。这些补充限制作为后缀展示。）"
 * 用户原话（2.0.2.6 升级）："字段配置输入显示胶囊之后，输入框可以不保留内容。点击胶囊之后可以修改。"
 *
 * 【2.0.2.6 改了什么】输入框从"整串的唯一真源"变成**只承载正在录/正在改的那一段** —— 回车把这
 * 一段收成胶囊（框随之为空，接着录下一段），点胶囊把那一段原文载回框里改。已确定的段存在控件内部。
 * 没有待定内容时 `read()` **逐字返回原文**（下面的空段/原文保真断言就是为了钉住这一点）；有待定
 * 内容时（写了没回车就保存）也要一并带上，不许丢数据。这里锁的是：
 *   · 每段一个胶囊 = 名字 + 后缀徽标，`✕` 删**那一段**（按序号删，重复段只少一个）；
 *   · `read()` 必须仍回**整串原文** —— 值/分隔符/CSV 第 17 列的存储契约一个字都不许被控件改掉；
 *   · 回车收胶囊 + 清空输入框；点胶囊载回那一段改（位置不动）；
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
   * 【2.0.2.6】初值由 `create()` 直接吃进控件状态（已确定的段），所以这里**不再**往输入框里塞一遍
   * —— 输入框现在只承载"正在录的那一段"，塞进去等于把同一串当待定内容再加一次（胶囊会翻倍）。
   */
  const mk = (val) => KH.ui.Fields.create(FM.byKey('fetchLabels'), val, {});
  const textOf = (ctrl, sel) => ctrl.el.querySelectorAll(sel).map((el) => el.textContent);
  /* 【2.0.2.11 票 #63】控件换成 `cands` ⇒ 输入框常态在框里、**点胶囊编辑时会被搬进浮层**，
   * 所以要两步找：先在控件里找，找不到就到浮层里找（与 `cands-int-field.test.js` 同一手法）。 */
  const inpOf = (ctrl) => {
    const own = ctrl.el.querySelector('input');
    if (own) return own;
    const pop = document.body.querySelector('.kh-pop-edit');
    return pop && pop.querySelector('input');
  };
  /** 模拟"往输入框里打字"（垫片里 property 不反射，得自己赋值再派发 input）。 */
  const type = (ctrl, text) => {
    const inp = inpOf(ctrl);
    inp.value = text;
    inp.dispatchEvent({ type: 'input' });
  };
  const enter = (ctrl) => inpOf(ctrl).dispatchEvent({ type: 'keydown', key: 'Enter' });

  suite('字段控件 · 可编辑胶囊（2.0.2.4 需求④ + 2.0.2.6 升级）');

  await test('★ 接线：字段控件与关键词同一族（2.0.2.11 起是 cands）；选项页先加载抓取实现（语法只有一份）', () => {
    /* 【2.0.2.11 票 #63】从 `labels` 换成 `cands`：用户要求「抓取后续字段输入框统一成关键词和
     * 标题词的 ui 和交互模式」⇒ 同一套胶囊 + 浮层录入 + `+`。抓取字段特有的一律靠
     * `token`（解析后缀画徽标）与 `clamp`（单行裁切 + 展开/收起）两件开关，不另造控件形态。 */
    eq(FM.byKey('fetchLabels').type, 'cands', '抓取字段要用能画胶囊的候选控件');
    eq(FM.byKey('fetchLabels').token, true, '抓取字段要解析后缀（否则 `#图3` 看不出是指什么）');
    eq(FM.byKey('fetchLabels').clamp, true, '抓取字段默认单行裁切（用户口径 m01713：尺寸不变、超出隐藏）');
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
    /* `✕` 是胶囊里的一颗按钮，点它**不该**顺带触发"点胶囊 = 改这一段"（否则删完会有一段被载进输入框） */
    eq(inpOf(ctrl).value, '', '✕ 不许被"点胶囊改这一段"接管');

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

  await test('★ 后缀图例默认收起、点开能查到（`!` / `%` / `^` 不许再是"只有更新日志里才知道"的功能）', () => {
    const ctrl = mk('名称');
    const legend = ctrl.el.querySelectorAll('.kh-lbl-legend')[0];
    truthy(legend, '要有一处后缀图例');
    /* 【2.0.2.10 票 #58】改 `<details>` 默认收起：常驻时这段 151 字的说明实测 83px / 5 行，
     * 把「字段」控件撑到 135px。信息不删，只是折叠 —— 所以下面仍逐字核对内容。
     * 判据用 DOM 形状（首个子元素是 `summary` + 没有 `open` 属性），不依赖 shim 是否实现了 `.open`。 */
    eq(String(legend.firstElementChild && legend.firstElementChild.tagName).toLowerCase(), 'summary',
      '收起态要为 `<details><summary>后缀怎么写…`（点 summary 展开，原生行为）');
    falsy(legend.getAttribute && legend.getAttribute('open'), '默认收起（没有 open 属性）');
    const t = legend.textContent;
    for (const key of ['#图', '#0', '@', '!', '^锚文本', '%']) {
      truthy(t.indexOf(key) >= 0, '图例里要提到 ' + key + '：' + t);
    }
    /* 反向：图例别把语法写成"仅图片 / 前 N 张"之外的东西 —— 语法真源在 Fetch.parseLabelSpec */
    falsy(/\bundefined\b/.test(t), '图例文案不许出现 undefined');
    truthy(t.indexOf('回车') >= 0, '图例要说清"回车收成胶囊"（否则用户不知道框为什么空着）');
  });

  await test('★ 回车把这一段收成胶囊，输入框不留内容（2.0.2.6 升级：接着录下一段）', () => {
    const ctrl = mk('名称');
    type(ctrl, '备注#图');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 2, '还没回车也要先按解析结果显示（边打边看，老行为不变）');
    eq(ctrl.read(), '名称|备注#图', '★ 没回车就直接保存 ⇒ 待定内容也要一并带上（不许丢数据）');

    enter(ctrl);
    eq(inpOf(ctrl).value, '', '★ 回车后输入框不留内容');
    eq(ctrl.read(), '名称|备注#图', '收成胶囊后值一个字都没变');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 2, '胶囊还是一个不多一个不少');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '名称/备注', '顺序仍是录入顺序');
  });

  await test('★ 点胶囊把那一段的原文载回输入框改，改完位置不动（2.0.2.6 升级）', () => {
    const ctrl = mk('名称^[复制]|备注#图');
    ctrl.el.querySelectorAll('.kh-lbl-chip')[0].dispatchEvent({ type: 'click' });
    eq(inpOf(ctrl).value, '名称^[复制]', '★ 点胶囊 ⇒ 这一段原文进了输入框');
    eq(ctrl.read(), '名称^[复制]|备注#图', '只是载回来，值一个字节都不许变');
    truthy(inpOf(ctrl).classList.contains('is-editing'), '输入框要标出"正在改这一段"');

    type(ctrl, '标题^[复制]');
    enter(ctrl);
    eq(ctrl.read(), '标题^[复制]|备注#图', '★ 只改那一段，位置也不动');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '标题/备注', '预览跟着重画');
    falsy(inpOf(ctrl).classList.contains('is-editing'), '改完退出编辑态');

    /* 点第二段改：下标必须按**原始段序号**，别被上一轮编辑串位 */
    ctrl.el.querySelectorAll('.kh-lbl-chip')[1].dispatchEvent({ type: 'click' });
    eq(inpOf(ctrl).value, '备注#图', '点第二段载回的是第二段');
  });

  await test('★ 编辑中把输入框清空再回车 = 删掉那一段（不是留个空段）', () => {
    const ctrl = mk('名称|备注');
    ctrl.el.querySelectorAll('.kh-lbl-chip')[0].dispatchEvent({ type: 'click' });
    type(ctrl, '');
    enter(ctrl);
    eq(ctrl.read(), '备注', '清空那一段就是把它删掉');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '备注', '预览里也不留空胶囊');
  });

  /* ================= 【2.0.2.16 需求③】四个候选框口径统一 =================
   * 用户口径：「这四个输入框风格、格式需要作为门禁统一，一处修改四处都统一」。
   * 门禁两层：① 四个字段都用同一份 `cands` 实现、同一组开关（不许哪个字段自己长特例）；
   * ② 造出来的控件结构逐项相同（万一将来有人给某一个框加个 if，这条会红）。
   * 宽度这类真要排版的判据在真机层（`_e2e/ui.test.js`）量，垫片没有布局引擎。
   * 【2.0.3 需求②】第五个：`imgOcrNeed`（原「还需图上有」→「图片动态关键词」）从 `text` 升进这一族
   * —— 用户要求「和关键词、标题关键词、抓取字段、图片命中关键词一样的交互逻辑」，并且点名
   * 「写入门禁，一处改其他都一致改」。所以它必须**进这张表**：谁以后只改一个框，这里就红。 */
  suite('候选框口径统一（2.0.2.16 需求③ · 2.0.3 起五条）');
  const CANDS_KEYS = ['text', 'cellVerify', 'fetchLabels', 'imgOcrKeyword', 'imgOcrNeed'];
  const shapeOf = (key) => {
    const ctl = KH.ui.Fields.create(FM.byKey(key), '', {});
    const el = ctl.el;
    const n = (sel) => el.querySelectorAll(sel).length;
    const cls = String(el.className || '').split(/\s+/);
    return {
      box: cls.indexOf('kh-cand-box') >= 0,
      clamp: cls.indexOf('kh-cand-clamp') >= 0,
      inp: n('.kh-input'),
      preview: n('.kh-lbl-preview'),
      frame: n('.kh-cand-field'),
      add: n('.kh-cand-add'),
      btn: n('.kh-clamp-btn'),
      texttip: n('.kh-cand-texttip'),
    };
  };

  await test('★ 四个框是同一份控件、同一组开关（关键词/标题关键词/字段/图片命中关键词）', () => {
    for (const key of CANDS_KEYS) {
      const spec = FM.byKey(key);
      eq(spec.type, 'cands', key + ' 必须走 cands 这一份实现（风格统一靠它，不是各写一套）');
      eq(spec.clamp, true, key + ' 必须默认单行裁切 + 展开（四个框同一口径）');
    }
    const base = shapeOf(CANDS_KEYS[0]);
    for (const key of CANDS_KEYS.slice(1)) {
      const got = shapeOf(key);
      for (const k of Object.keys(base)) eq(got[k], base[k], key + ' 的结构项 ' + k + ' 必须与关键词框一致');
    }
  });

  await test('★ 门禁：候选框实现与共享样式只许有一份（复制粘贴第二套就红）', () => {
    const fieldsSrc = read('src/ui/components/fields.js');
    eq((fieldsSrc.match(/case 'cands':/g) || []).length, 1, '`cands` 只许有一个实现分支');
    const css = read('src/ui/components/components.css');
    for (const sel of ['.kh-cand-field', '.kh-cand-clamp', '.kh-lbl-preview', '.kh-cand-texttip']) {
      truthy(css.indexOf(sel) >= 0, sel + ' 必须在共享样式里定义（四个框共用一份）');
    }
    /* 文本态的三条规则必须挂在 `.kh-cand-box` 作用域下 —— 否则会波及设置页的「置顶排序」胶囊 */
    eq((css.match(/\.kh-cand-box\.is-texed/g) || []).length >= 3, true, '文本态规则要成组（文本域/藏框面/占整行）');
    /* 2.0.2.17 需求③：文本态从单行 `input` 换成 textarea（内容长了自己长高），仍只许有一份 */
    eq((css.match(/\.kh-cand-box\.is-texed > \.kh-cand-ta \{/g) || []).length, 1, '文本态的文本域规则只许有一份');
    eq((css.match(/\.kh-cand-box\.is-texed > \.kh-cand-field/g) || []).length, 1, '文本态藏起框面的规则只许有一份');
    /* 旧口径不许留：单行 input 撑满文本态的那条规则已经作废（会与 textarea 同显两个框） */
    eq((css.match(/\.kh-cand-box\.is-texed > \.kh-input/g) || []).length, 0, '单行 input 的文本态规则必须删净');
    /* 【2.0.2.18 真机修·门禁】「文本态按内容长高」在真机上被两条 CSS 卡死过，这里钉住：
     *   ① `.kh-input` 的 `height: 30px` 会把 textarea 压成恒定一行 ⇒ 必须显式 `height: auto`；
     *   ② `font: inherit` 是简写，会重置 `line-height`（实测 23.1px）⇒ `line-height` 必须写在它后面。 */
    const taRule = (css.match(/\.kh-cand-box\.is-texed > \.kh-cand-ta \{([\s\S]*?)\}/) || [])[1] || '';
    truthy(/height:\s*auto/.test(taRule), '文本域必须显式 height:auto（否则被 .kh-input 的 30px 压成一行）');
    const iFont = taRule.indexOf('font:');
    const iLH = taRule.indexOf('line-height');
    truthy(iLH >= 0, '文本域必须写 line-height（JS 按它算行数）');
    truthy(iFont < 0 || iLH > iFont, 'line-height 必须写在 font 简写之后（简写会把它重置掉）');
    /* JS 侧同样不许硬编码行高：行高/内边距要从计算样式里量（真机是 23.1px，不是 20px） */
    truthy(/getComputedStyle/.test(fieldsSrc), '行高要实测，不许硬编码');
  });

  /* 【2.0.2.17 需求③】用户原话："这四个输入框，点击空白后变成文本内容支持批量修改已实现。
   * 但是当内容过长时，输入框并不能完全展示这些内容。改成过长时，默认展开输入框。"
   * 做法 = 文本态换成 textarea，行数按内容算（上限 9 行，再多滚动）。
   * 真浏览器的高矮由 `_e2e/ui.test.js` 量；这里锁"是文本域、值全在、回车收回、存储契约不变"。 */
  await test('★ 需求③：文本态用 textarea（整串全显，不是单行横向滚动），回车收回值不变', () => {
    const ctrl = mk('包名|截图#图|资质类型@1|icon');
    const box = ctrl.el;
    const ta = box.querySelector('.kh-cand-ta');
    truthy(ta, '文本态要有一块自己的 textarea（单行 input 装不下一整串）');
    truthy(ta.hidden, '常态藏起来（不许与胶囊同显）');
    box.querySelector('.kh-cand-field').dispatchEvent({ type: 'click' });
    truthy(box.classList.contains('is-texed'), '点框面空白 ⇒ 进文本态');
    eq(ta.hidden, false, '文本态要露出 textarea');
    eq(ta.value, '包名|截图#图|资质类型@1|icon', '整串原样摊开（`|` 与后缀都保留）');
    ta.value = '包名|截图#图|资质类型@1|icon|新词';
    ta.dispatchEvent({ type: 'keydown', key: 'Enter' });
    eq(ctrl.read(), '包名|截图#图|资质类型@1|icon|新词', '回车把改动收回胶囊，读出来仍是整串原文');
    falsy(box.classList.contains('is-texed'), '回了胶囊态');
    truthy(ta.hidden, 'textarea 再藏起来');
    /* 行数按内容算：上限 9 行（再多走滚动），且不许写成固定行数——固定行数 = 长内容又看不全 */
    const src = read('src/ui/components/fields.js');
    truthy(/ta\.rows = Math\.max\(1, Math\.min\(9,/.test(src), '行数要按内容算，并封顶 9 行');
    truthy(/ta\.scrollHeight/.test(src), '量的是内容真实高度（scrollHeight），不是字数估算');
  });

  /* 【2.0.6.1 需求②】用户原话：「普通匹配按字面找词：这里写的 . * + ? … 要当正则用请勾上「正则」
   * —— 图片动态关键词在添加正则词之后还是存在这种提示。帮忙看看是历史文案残留，还是真的没有
   * 生效」。查清是两头都错位：这框填的是**抓取字段名**（可带 `!`/`^` 取值修饰），后缀不参与命中；
   * 它的匹配也不是字面匹配（`img-ocr.js` 的 judge：不分大小写、非全词、剔全部空白）。
   * ⇒ 该框不弹这句，且胶囊按「名字 + 后缀徽标」画（让"名字是名字、修饰是修饰"看得见）。 */
  suite('图片动态关键词 · 文案与胶囊口径（2.0.6.1 需求②）');
  const mkNeed = (val) => KH.ui.Fields.create(FM.byKey('imgOcrNeed'), val, {});

  await test('★ 配件位声明：imgOcrNeed 走 suffixChip，其余四个候选框不受影响', () => {
    eq(FM.byKey('imgOcrNeed').suffixChip, true, '图片动态关键词要按「名字+后缀徽标」画');
    eq(FM.byKey('imgOcrNeed').csvSplit, true, '逗号分隔的口径不许被顺手改掉');
    ['text', 'cellVerify', 'fetchLabels', 'imgOcrKeyword'].forEach((k) => {
      falsy(FM.byKey(k).suffixChip, k + ' 不声明 suffixChip（`^` 在这几个框里就是正则元字符）');
    });
  });

  await test('★ 胶囊只显示名字：`开发者 ! ^高价` ⇒ 名字「开发者」、不画后缀徽标', () => {
    const ctrl = mkNeed('开发者 ! ^高价');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '开发者', '★ 用户担心的「后缀也参与命中」在界面上就看得见不成立');
    eq(textOf(ctrl, '.kh-lbl-suffix').join('/'), '',
      '【2.0.7.1 需求③】后缀只用来认字段名、不改取值（取值走「抓取字段」），画成徽标会被误读成"改值"');
    eq(ctrl.read(), '开发者 ! ^高价', '★ read() 仍回整串原文（存储契约不变）');
  });

  await test('★ 不弹「普通匹配按字面找词…」（历史错位文案）；别的候选框照旧弹', () => {
    const need = mkNeed('开发者 ! ^高价');
    const tip = need.el.querySelector('.kh-cand-tip');
    truthy(tip, '提示节点还在（只是内容为空）');
    eq(String(tip.textContent || ''), '', '★ 图片动态关键词不许再出现这句');
    truthy(tip.hidden, '也不许占据任何位置');
    const kw = KH.ui.Fields.create(FM.byKey('text'), 'a.b', {});
    const kwTip = kw.el.querySelector('.kh-cand-tip');
    truthy(kwTip && /普通匹配按字面找词/.test(String(kwTip.textContent || '')),
      '关键词框照旧提醒（那里 `*` `.` 真是字面量）');
  });
};
