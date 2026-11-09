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
  /* 列表弹窗的查询**限定在最后打开的那个弹窗**里：前面用例失败时可能留下没关的弹窗，
   * 全 document 查会把别人的行读进来（本轮实测踩到）。 */
  const lastModalEl = () => {
    const all = document.body.querySelectorAll('.kh-modal');
    return all[all.length - 1];
  };
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

  await test('★ 两段 ⇒ 两个胶囊（只写名字），read() 仍是整串原文', () => {
    const raw = '名称^[复制]|备注#图';
    const ctrl = mk(raw);
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '名称/备注', '胶囊里只放**字段名**');
    eq(textOf(ctrl, '.kh-lbl-suffix').join('/'), '', '★ 2026-11-02：添加关键词弹窗里不展示后缀内容');
    eq(textOf(ctrl, '.kh-lbl-chip').length, 2, '两段两个胶囊');
    eq(ctrl.read(), raw, '★ read() 必须回整串原文（分隔符/后缀一个字都不许被控件归一）');
    const del = ctrl.el.querySelectorAll('.kh-lbl-del')[0];
    truthy(del && del.getAttribute('title'), '删除按钮要有 title（说清删的是哪一段）');
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    eq(lastModalEl().querySelectorAll('.kh-list-val').map((el) => el.getAttribute('value')).join('/'),
      '名称/备注', '★ 行里只放名字（后缀不再要求手敲）');
    eq(lastModalEl().querySelectorAll('.kh-lrow-suffix').map((el) => el.textContent).join('/'),
      '取值：截到「[复制]」之前/取值：只留图', '★ 行按钮用「取值：…」人话回显，点开才是结构化设置');
    KH.ui.Modal.closeAll();
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

  await test('★ 后缀图例搬进「修改」弹窗：默认收起、点开能查到（`!` / `%` / `^` 不许再是"只有更新日志里才知道"的功能）', () => {
    const ctrl = mk('名称');
    falsy(ctrl.el.querySelector('.kh-lbl-legend'), '添加弹窗里不再挂图例（后缀内容整体搬进列表弹窗）');
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    const legend = lastModalEl().querySelectorAll('.kh-lbl-legend')[0];
    truthy(legend, '「修改」弹窗里要有一处后缀图例');
    eq(String(legend.firstElementChild && legend.firstElementChild.tagName).toLowerCase(), 'summary',
      '收起态要为 `<details><summary>后缀怎么写…`（点 summary 展开，原生行为）');
    falsy(legend.getAttribute && legend.getAttribute('open'), '默认收起（没有 open 属性）');
    const t = legend.textContent;
    for (const key of ['#图', '#0', '@', '!', '^锚文本', '%']) {
      truthy(t.indexOf(key) >= 0, '图例里要提到 ' + key + '：' + t);
    }
    falsy(/undefined/.test(t), '图例文案不许出现 undefined');
    truthy(t.indexOf('回车') >= 0, '图例要说清"回车添加下一条"（否则用户不知道加完怎么接着加）');
    KH.ui.Modal.closeAll();
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

  await test('★ 点胶囊打开「修改」弹窗：整串按行摊开，改一行后位置不动（2026-11-02）', () => {
    const ctrl = mk('名称^[复制]|备注#图');
    ctrl.el.querySelectorAll('.kh-lbl-chip')[0].dispatchEvent({ type: 'click' });
    truthy(KH.ui.Modal.isOpen(), '★ 点胶囊 ⇒ 打开列表弹窗');
    const vals = lastModalEl().querySelectorAll('.kh-list-val');
    eq(vals.map((el) => el.getAttribute('value')).join('/'), '名称/备注',
      '行里只有名字，后缀与名字分开（不再整串摊在输入框里）');
    vals[0].value = '标题';
    vals[0].dispatchEvent({ type: 'input' });
    lastModalEl().querySelector('.kh-modal-foot .kh-btn-primary').dispatchEvent({ type: 'click' });
    eq(ctrl.read(), '标题^[复制]|备注#图', '★ 只改名字，原后缀自动保留；位置也不动');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '标题/备注', '预览跟着重画');
  });

  await test('★ 在「修改」弹窗里清空一行再保存 = 删掉那一条（不留空条目）', () => {
    const ctrl = mk('名称|备注');
    ctrl.el.querySelectorAll('.kh-lbl-chip')[0].dispatchEvent({ type: 'click' });
    const vals = lastModalEl().querySelectorAll('.kh-list-val');
    vals[0].value = '';
    vals[0].dispatchEvent({ type: 'input' });
    lastModalEl().querySelector('.kh-modal-foot .kh-btn-primary').dispatchEvent({ type: 'click' });
    eq(ctrl.read(), '备注', '清空那一条就是把它删掉');
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


  /* 【2.0.2.17 需求③】用户原话："这四个输入框，点击空白后变成文本内容支持批量修改已实现。
   * 但是当内容过长时，输入框并不能完全展示这些内容。改成过长时，默认展开输入框。"
   * 做法 = 文本态换成 textarea，行数按内容算（上限 9 行，再多滚动）。
   * 真浏览器的高矮由 `_e2e/ui.test.js` 量；这里锁"是文本域、值全在、回车收回、存储契约不变"。 */
  await test('★ 需求③：文本态改由「修改」列表弹窗承担（整串按行摊开，保存后仍是原文）', () => {
    const ctrl = mk('包名|截图#图|资质类型@1|icon');
    const box = ctrl.el;
    const ta = box.querySelector('.kh-cand-ta');
    truthy(ta, 'textarea 节点还在（列表模式下不再露面，但控件与保存路径不动）');
    truthy(ta.hidden, '常态藏起来');
    box.querySelector('.kh-cand-field').dispatchEvent({ type: 'click' });
    truthy(KH.ui.Modal.isOpen(), '★ 点框面 ⇒ 打开「修改」列表弹窗（2026-11-02 口径）');
    const vals = lastModalEl().querySelectorAll('.kh-list-val').map((el) => el.getAttribute('value'));
    eq(vals.join('|'), '包名|截图|资质类型|icon', '整串按行摊开（名字与后缀分开，`|` 位置不变）');
    const row = lastModalEl().querySelectorAll('.kh-list-val')[3];
    row.value = '新词';
    row.dispatchEvent({ type: 'input' });
    lastModalEl().querySelector('.kh-modal-foot .kh-btn-primary').dispatchEvent({ type: 'click' });
    eq(ctrl.read(), '包名|截图#图|资质类型@1|新词', '保存后仍是整串原文（只换那一行，位置不变）');
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

  await test('★ 胶囊只画名字（不画后缀徽标）；后缀在「修改」弹窗里按原文回显', () => {
    const ctrl = mkNeed('开发者 ! ^高价');
    eq(textOf(ctrl, '.kh-lbl-name').join('/'), '开发者', '名字仍是名字');
    eq(textOf(ctrl, '.kh-lbl-suffix').join('/'), '', '★ 2026-11-02：添加关键词弹窗里不展示后缀内容');
    eq(ctrl.read(), '开发者 ! ^高价', '★ read() 仍回整串原文（存储契约不变）');
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    const vals = lastModalEl().querySelectorAll('.kh-list-val').map((el) => el.getAttribute('value'));
    eq(vals.join('/'), '开发者', '★ 行里只放字段名（后缀进结构化面板）');
    eq(String(lastModalEl().querySelector('.kh-lrow-suffix').textContent), '取值：去空格 · 截到「高价」之前',
      '★ 行按钮用「取值：…」人话回显');
    KH.ui.Modal.closeAll();
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

  /* 【2.0.8.14 需求①】交互面板勾的「只显示一行（~）」「做成超链接（*）」保存时整条丢失：
   * 根因是落盘函数 `suffixOf` 只拼到 `%` 就收工。这里用「构造 spec → suffixOf → parseLabelSpec
   * 读回」的往返把五个取值修饰与两个显示修饰一起钉住（只有手打生效的现象不许再回来）。 */
  suite('抓取字段后缀 · 交互态落盘往返（2.0.8.14 需求①）');

  await test('★ suffixOf 必须把 ~ 与 * 写进落盘串，且能被 parseLabelSpec 原样读回', () => {
    const spec = {
      noImg: false, imgOnly: false, imgLimit: 0, simple: false,
      offset: '2', stripSpace: true, anchor: '', sliceSpec: '',
      clip: true, link: true, linkTpl: 'https://x.test/?q={v}'
    };
    const s = KH.ui.Fields.suffixOf(spec);
    eq(s, '@2!~*https://x.test/?q={v}', '★ `~` 必须在 `*` 之前（解析端先剥 *，它一直吃到行尾）');
    const back = KH.Fetch.parseLabelSpec('字段' + s);
    eq(back.offset, '2');
    eq(back.stripSpace, true);
    eq(back.clip, true, '★ 勾选「只显示一行」保存后必须还在');
    eq(back.link, true, '★ 勾选「做成超链接」保存后必须还在');
    eq(back.linkTpl, 'https://x.test/?q={v}');
  });

  await test('★ 没勾 ~ / * 时落盘串不变（历史数据一个字节都不动）', () => {
    eq(KH.ui.Fields.suffixOf({ offset: '2', stripSpace: true }), '@2!');
    eq(KH.ui.Fields.suffixOf({ noImg: true }), '#0');
    eq(KH.ui.Fields.suffixOf({}), '');
  });

  await test('★ `名称@2~!*` 这种混写：落盘串的每一段都能各自读回（不互相误读）', () => {
    const p = KH.Fetch.parseLabelSpec('名称' + KH.ui.Fields.suffixOf({ offset: '2', stripSpace: true, clip: true, link: true }));
    eq(p.label, '名称');
    eq(p.offset, '2');
    eq(p.stripSpace, true);
    eq(p.clip, true);
    eq(p.link, true);
    eq(p.linkTpl, '');
  });
};
