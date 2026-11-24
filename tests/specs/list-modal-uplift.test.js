/* tests/specs/list-modal-uplift.test.js — 列表弹窗「批 1」纯呈现改造（2026-11-14，2.0.11）
 * ----------------------------------------------------------------------------
 * 用户原话：「优化一下添加关键词界面里的那几个输入窗点击之后弹出的管理列表弹窗。现在修改调整起来
 * 有些麻烦。帮忙设计一套交互体验好一点，管理便捷的 ui……但不要功能缩水。」
 *
 * 批 1 只改呈现，**存储串一个字都不动**（解析顺序 / 回写口径 / `|` 连接都没碰）：
 *   ① 头两行（快加框 + 筛选）整块吸顶，且快加框排在筛选前面（主路径是录词）；
 *   ② 三类行型各有类型名与 data-rowtype（词条 / 抓取字段 / 图片词）；
 *   ③ 从快加框加一条**不把焦点抢进新行**（连续录入不回跳）；行内回车仍进新行；
 *   ④ 批量条分区：批量改在左，删除在右（危险操作隔离）；
 *   ⑤ 勾选被筛选隐藏时出现在警告条里，删除按钮带条数；
 *   ⑥ 后缀图例一项一行（查记号不用在 151 字长句里找）。
 *
 * 真机观感由 e2e 覆盖；这里锁结构、文案与「不回抢焦点」这类毫秒级行为。
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

  const mkTok = (val) => KH.ui.Fields.create(FM.byKey('fetchLabels'), val || '', {});
  const lastModalEl = () => {
    const all = document.body.querySelectorAll('.kh-modal');
    return all[all.length - 1];
  };
  const openList = (ctrl) => {
    ctrl.el.querySelector('.kh-list-btn').dispatchEvent({ type: 'click' });
    return lastModalEl();
  };
  const boxOf = (modal) => modal.querySelector('.kh-list-box');

  suite('列表弹窗 · 批1 纯呈现改造（2.0.11）');

  await test('★ 吸顶头：快加框排在筛选之前，且两行同一个 .kh-list-head 容器', () => {
    const modal = openList(mkTok('开发者'));
    const box = boxOf(modal);
    const head = box.querySelector('.kh-list-head');
    truthy(head, '要有一个整块吸顶的头容器');
    const kids = head.children.map((el) => el.className || '');
    eq(kids.length, 2, '头容器里正好两行');
    truthy(/kh-list-addbar/.test(kids[0]), '第一行是快加框（主路径是录词）');
    truthy(/kh-list-toolbar/.test(kids[1]), '第二行才是筛选/全选/计数');
    truthy(box.querySelector('.kh-list-add') !== null, '快加输入框还在头里');
    KH.ui.Modal.closeAll();
  });

  await test('★ 行型：抓取字段弹窗标 tok，并给出类型名与一行「怎么录」', () => {
    const modal = openList(mkTok('开发者'));
    const box = boxOf(modal);
    eq(String(box.getAttribute('data-rowtype')), 'tok', '抓取字段是 tok');
    const type = box.querySelector('.kh-list-type');
    truthy(type, '要有类型名徽标');
    eq(String(type.textContent), '抓取字段', '类型名要说人话');
    const hint = box.querySelector('.kh-list-kicker-t');
    truthy(hint && String(hint.textContent).indexOf('回车') >= 0, '副标题要说清怎么接着录');
    const src = read('src/ui/components/fields.js');
    truthy(/isKv \? 'kv' : 'plain'/.test(src), '三种行型都要有 data-rowtype');
    truthy(/\.kh-list-box\[data-rowtype="tok"\] \.kh-lrow/.test(read('src/ui/components/components.css')),
      '行型要落到样式上（左侧色条），否则只是加了个属性');
    KH.ui.Modal.closeAll();
  });

  await test('★ 从快加框加一条：清空输入框、**不抢焦点**（连续录入不回跳）；行内回车仍进新行', () => {
    const modal = openList(mkTok('开发者'));
    const add = modal.querySelector('.kh-list-add');
    add.value = '被授权公司';
    add.dispatchEvent({ type: 'keydown', key: 'Enter' });
    eq(String(add.value), '', '加完要清空输入框，接着录下一条');
    const src = read('src/ui/components/fields.js');
    truthy(/keepFocus: true/.test(src), '快加路径要显式 keepFocus');
    truthy(/const keepFocus = !!\(opts && opts\.keepFocus\);/.test(src), '行内回车这条路径不能被一起关掉');
    truthy(/const focusInp = keepFocus \? null :/.test(src), 'keepFocus 时必须真的不调用 focus()');
    /* 垫片没有 activeElement，所以这里锁的是**实现口径**：keepFocus ⇒ focusInp 为 null；
     * 真机焦点行为由 e2e 的连续录入用例覆盖。 */
    KH.ui.Modal.closeAll();
  });

  await test('★ 批量条：删除在危险区（右侧带分隔），并带条数', () => {
    const modal = openList(mkTok('开发者|被授权公司'));
    const opsBar = modal.querySelector('.kh-list-ops');
    truthy(opsBar, '批量条要在');
    const kvModal = openList(KH.ui.Fields.create(FM.byKey('imgOcrKeyword'), '一对一', {}));
    const kvOps = kvModal.querySelector('.kh-list-ops');
    truthy(kvOps.querySelector('.kh-list-ops-grp'), '图片词弹窗的「批量改」要单独一组');
    eq(kvOps.querySelector('.kh-list-ops-grp').getAttribute('data-grp'), 'bulk', '这组是批量改');
    /* 垫片只认简单类名，复合选择器（`.a.b`）查不到 ⇒ 先按单个类取，再判 is-danger。 */
    const danger = opsBar.querySelectorAll('.kh-list-ops-grp')
      .filter((el) => /is-danger/.test(String(el.className)))[0];
    truthy(danger, '删除要单独进危险区');
    truthy(/删除选中/.test(String(danger.textContent)), '危险区里是删除按钮');
    const src = read('src/ui/components/fields.js');
    truthy(/delBtn\.textContent = vis \? '删除选中（' \+ vis \+ ' 条）'/.test(src), '按钮要报条数（按可见的算），别让人猜删几条');
    truthy(/\.kh-list-ops-grp\.is-danger \{ margin-left: auto/.test(read('src/ui/components/components.css')),
      '危险区要推到右侧并加分隔线');
    KH.ui.Modal.closeAll();
  });

  await test('★ 勾选被筛选隐藏：警告条说明「只删可见的，隐藏的留下」', () => {
    const src = read('src/ui/components/fields.js');
    truthy(/const hiddenPicked = \(\) => pickedRows\(\)\.filter/.test(src), '要能数出隐藏的勾选');
    truthy(/删除只作用于可见的/.test(src), '警告要说清删除口径：只删可见勾选');
    truthy(/const list = all\.filter\(\(r\) => !\(r\.el && r\.el\.hidden\)\)/.test(src), '删除时要跳过被筛选隐藏的行');
    truthy(/另有 ' \+ hid \+ ' 条被筛选隐藏，已保留/.test(src), '删完要点明哪几条被留下了');
    truthy(/paintBulk\(\);/.test(src), '筛选变化后要刷新警告条');
    truthy(/const bulkWarn = h\('div', \{ class: 'kh-list-warn', hidden: true \}\)/.test(src), '警告条默认不占位');
    truthy(/已删除 ' \+ list\.length \+ ' 条/.test(src), '删完要点明删了几条');
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-list-warn\[hidden\] \{ display: none; \}/.test(css), 'hidden 必须真的不显示（flex 会压过默认样式）');
    KH.ui.Modal.closeAll();
  });

  await test('★ 后缀图例：一项一行，且七个记号一个不少（解析口径没变）', () => {
    const modal = openList(mkTok('开发者'));
    const legend = modal.querySelector('.kh-lbl-legend');
    truthy(legend, '抓取字段弹窗要有图例');
    const rows = legend.querySelectorAll('.kh-legend-row');
    truthy(rows.length >= 10, '每项独立成行，实际 ' + rows.length + ' 行');
    const codes = rows.map((r) => String(r.querySelector('.kh-legend-code') && r.querySelector('.kh-legend-code').textContent));
    for (const k of ['#图', '#0', '@2', '^锚文本', '%4', '~', '*', '!', '| 或 ｜']) {
      truthy(codes.some((c) => c.indexOf(k) >= 0), '图例里要能单独查到 ' + k + '：' + codes.join(' / '));
    }
    const t = legend.textContent;
    truthy(t.indexOf('回车') >= 0, '仍要说清「回车添加下一条」');
    truthy(legend.querySelectorAll('.kh-legend-val').length === rows.length, '每行都要有白话解释');
    KH.ui.Modal.closeAll();
  });

  /* ── 批 2：结构归并（还是只动呈现，存储串与解析顺序不变） ───────────────── */

  await test('★ 后缀面板：预览排在最前，「取哪一格」与「@值格」合成一组', () => {
    const modal = openList(mkTok('开发者'));
    const detail = modal.querySelector('.kh-lrow-detail');
    truthy(detail, '抓取字段行要带后缀面板');
    const kids = detail.children.map((el) => el.className || '');
    const iPrev = kids.findIndex((c) => /kh-sfx-preview/.test(c));
    const iGrid = kids.findIndex((c) => /kh-sfx-grid/.test(c));
    truthy(iPrev >= 0 && iGrid >= 0, '预览块与设置区都在：' + kids.join(' / '));
    truthy(iPrev < iGrid, '预览要排在设置前面（展开就能看到取到的值）');
    const labels = detail.querySelectorAll('.kh-sfx-label').map((el) => String(el.textContent));
    truthy(labels.some((t) => t.indexOf('从哪取') >= 0), '位置组改成「从哪取（位置）」：' + labels.join(' / '));
    truthy(labels.some((t) => t.indexOf('要哪种图') >= 0), '图选项单独一组「要哪种图」');
    falsy(labels.some((t) => t.indexOf('取哪一格') >= 0), '旧的「取哪一格」要消失（和 @ 讲的是同一件事）');
    falsy(labels.some((t) => t.indexOf('值格位置') >= 0), '旧的「值格位置 @」要消失（已并入位置组）');
    truthy(detail.querySelectorAll('.kh-sfx-check').length >= 1, '#1 变成位置组里的一个勾选');
    truthy(detail.querySelector('.kh-sfx-apply') !== null, '要有「把这套取值应用到勾选的条目」');
    KH.ui.Modal.closeAll();
  });

  await test('★ 批量设取值：没勾选任何条目时先说清怎么用', () => {
    const modal = openList(mkTok('开发者'));
    const btn = modal.querySelector('.kh-sfx-apply');
    truthy(btn, '按钮要在');
    btn.dispatchEvent({ type: 'click' });
    const toastEl = document.body.querySelector('.kh-toast');
    truthy(toastEl, '点它要有提示（不能静默）');
    truthy(/勾选/.test(String(toastEl.textContent)), '提示要说清「先勾选要一起改的条目」：' + toastEl.textContent);
    KH.ui.Modal.closeAll();
  });

  await test('★ 有未保存改动时关窗先确认；没改动就直接关', () => {
    const modal = openList(mkTok(''));
    const add = modal.querySelector('.kh-list-add');
    add.value = '新字段';
    modal.querySelector('.kh-list-addbtn').dispatchEvent({ type: 'click' });
    eq(KH.ui.Modal.depth(), 1, '加了一条，列表弹窗还开着');
    modal.querySelector('.kh-modal-x').dispatchEvent({ type: 'click' });
    eq(KH.ui.Modal.depth(), 2, '有改动时点 × 要先弹确认');
    const cf = lastModalEl();
    eq(String(cf.querySelector('.kh-modal-title').textContent), '有未保存的修改', '确认框要说清是什么事');
    cf.querySelector('.kh-btn-danger').dispatchEvent({ type: 'click' });
    eq(KH.ui.Modal.depth(), 0, '「放弃修改」之后两个都关掉');

    const clean = openList(mkTok(''));
    clean.querySelector('.kh-modal-x').dispatchEvent({ type: 'click' });
    eq(KH.ui.Modal.depth(), 0, '没改过就直接关，不啰嗦');
  });

  /* 【2.0.16.8 · m21101】用户原话：「指向字段太长的话现在会挤压，导致词看不清看不见」。
   * 压人的是「指向」按钮上的字段名：以前固定 180px 且不换行，长名字直接吃掉词输入框。
   * 这里锁三件事：按钮文字只留短摘要（完整清单进 title）、行允许换行、上限改成 em。 */
  await test('★ 2.0.16.8 长字段名不再把词挤没：指向收成短摘要，完整清单在悬停里（m21101）', () => {
    const longName = 'APP电子版权认证证书页内信息';
    /* `@字段` 只在**已配的抓取字段**里才算作用域（`knownFields` 从框面 data-raw 读），
     * 所以先摆一个只带 data-raw 的框面当基线，否则这条词会被当成「全部字段」。 */
    /* 复用**第一个**框面：`knownFields` 用 querySelector 取第一处，另加一个反而读不到（踩过）。 */
    const face = document.body.querySelector('[data-for="fld-fetchLabels"]') || document.createElement('div');
    if (!face.parentNode) document.body.appendChild(face);
    face.setAttribute('data-for', 'fld-fetchLabels');
    face.setAttribute('data-raw', longName);
    const modal = openList(KH.ui.Fields.create(FM.byKey('imgOcrKeyword'), '核心词@' + longName, {}));
    const btn = modal.querySelector('.kh-lrow-scope');
    truthy(btn, '图片命中词的行里要有「指向」按钮');
    const txt = String(btn.textContent);
    truthy(txt.length <= 9, '按钮文字必须是短摘要（≤8 字 + 省略号），实际：' + txt);
    truthy(txt.indexOf('…') >= 0, '截断要有可见省略号：' + txt);
    truthy(String(btn.title || '').indexOf(longName) >= 0, '完整字段名要在 title 里能读回：' + btn.title);
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-lrow-main \{[^}]*flex-wrap: wrap/.test(css), '这一行要允许换行，否则按钮只能挤词');
    truthy(/\.kh-lrow-scope \{\s*flex: 0 1 auto; min-width: 0; max-width: min\(10em, 44%\)/.test(css),
      '指向按钮的上限要跟字号走、且不超过行宽 44%');
    truthy(/\.kh-scope-opt > span \{ min-width: 0; overflow-wrap: anywhere; \}/.test(css), '指向面板里的长字段名要能折行');
    truthy(/const SCOPE_NAME_MAX = 8;/.test(read('src/ui/components/fields.js')), '截断长度写成常量，便于以后调');
    KH.ui.Modal.closeAll();
  });

  /* 【2.0.16.8 · m21072】用户原话：「图片关键词、动态词的指向设置，只应该指向有图片的抓取字段，
   * 现在全都列出来了，选文本字段没有意义」。判据只用值规格里显式的 `#0`（明确不要图片）：
   * 这类字段默认不出现在候选里；勾掉「只列会出图的字段」能看见全部（不静默删字段）。 */
  await test('★ 2.0.16.8 指向候选默认只列会出图的字段，写了 #0 的要收起来（m21072）', () => {
    const face = document.body.querySelector('[data-for="fld-fetchLabels"]') || document.createElement('div');
    if (!face.parentNode) document.body.appendChild(face);
    face.setAttribute('data-for', 'fld-fetchLabels');
    face.setAttribute('data-raw', '文本字段#0|截图#图');
    const modal = openList(KH.ui.Fields.create(FM.byKey('imgOcrKeyword'), '核心词@截图', {}));
    const btn = modal.querySelector('.kh-lrow-scope');
    truthy(btn, '要有「指向」按钮');
    btn.dispatchEvent({ type: 'click' });
    const panel = modal.querySelector('.kh-scope-panel');
    truthy(panel && panel.hidden === false, '点「指向」要打开面板');
    const opts = Array.prototype.slice.call(panel.querySelectorAll('.kh-scope-opt'));
    const byText = (name) => opts.filter((l) => String(l.textContent).trim().indexOf(name) === 0)[0];
    const dead = byText('文本字段');
    const lit = byText('截图');
    truthy(dead && lit, '两个字段都该建成候选行（只是隐藏，不是删掉）');
    eq(dead.hidden, true, '写了 #0 的字段默认不出现在候选里');
    eq(lit.hidden, false, '写了 #图 的字段必须在候选里');
    const note = panel.querySelector('.kh-scope-filter-note');
    truthy(note && /已隐藏 1 个/.test(String(note.textContent)), '要说明隐藏了几个，别让用户以为字段没了：' + (note && note.textContent));
    const only = panel.querySelector('.kh-scope-onlyimg');
    truthy(only && only.checked === true, '默认勾上「只列会出图的字段」');
    only.checked = false;
    only.dispatchEvent({ type: 'change' });
    eq(dead.hidden, false, '勾掉之后要能看见全部字段（含 #0）');
    KH.ui.Modal.closeAll();
  });
};
