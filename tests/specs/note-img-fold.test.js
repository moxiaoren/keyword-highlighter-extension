/* tests/specs/note-img-fold.test.js — 命中的图折进卡片（2.0.2.7 · 用户 m00292）
 * ----------------------------------------------------------------------------
 * 用户原话（m00292）："目前重要笔记图片识别模块和卡片字段抓取展示的图片有些重复，可不可以删掉
 * 图片识别模块，复用卡片，命中的话给命中的图片加一层红色边框。点击大图显示 ocr 原文时，标红或
 * 高亮命中的词在哪里。"
 *
 * 口径（为什么不是把那块分区整个删掉）：右键任意图识别（`via === 'contextMenu'`）的结果只进
 * `img-ocr.js` 的 `manual` 表、**不进任何卡片**（它的 `rule` 是 null，`head.build` 眼里没有它），
 * 图片分区是它唯一的显示面。所以做的是「卡片里已经画出来的图不再重复画一行」——重复消失；卡片里
 * 没有的图（右键识别、字段没抓到图…）照旧留着，**不静默**。
 *
 * 本文件只钉 2.0.2.7 新增的三件事：① 折进卡片的过滤；② 命中图的红框与命中词 title；③ 灯箱
 * 「识别原文」栏把命中词标出来。既有分区行为（默认只显示命中 / 收起记忆 / 复制反馈 / 显示全部）
 * 在 `important-note.test.js` 里，一条都不动。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('important-note · 命中的图折进卡片（2.0.2.7 用户 m00292）');

  /** 面板是单例字面量：原型继承造"影子面板"，只改自己的字段（同 important-note.test.js 手法） */
  const shadowPanel = () => Object.create(KH.ImportantNote.panel);

  /** 卡片正文：`renderItems` 把抓取字段生成的表格插进 `.khin-item-note`，图就在表格单元格里 */
  function bodyWithImgs(srcs) {
    const body = H.el('div');
    for (const s of srcs) {
      const im = H.el('img');
      im.setAttribute('src', s);           // 垫片没有网络：src 就是属性，`im.src` 读回同一个值
      const td = H.el('td');
      td.appendChild(im);
      body.appendChild(td);
    }
    return body;
  }
  const expand = (p) => { p.imgSecEl = H.el('div'); p.imgListEl = H.el('div'); p.imgCollapsed = false; };

  /* ==========================================================================
   * ① 折进卡片：卡片里已经有的图，分区不再重复画
   * ========================================================================== */

  await test('★ 卡片里已经画出来的图，分区不再重复画一行', () => {
    const p = shadowPanel();
    expand(p);
    p.bodyEl = bodyWithImgs(['https://ex.com/a.png']);
    p.imgItems = [{ key: 'r|https://ex.com/a.png', src: 'https://ex.com/a.png', state: 'done',
      text: '一对一乙', matched: [{ text: '一对一' }] }];
    eq(p.unfoldedImgItems().length, 0, '卡片里有这张图 ⇒ 分区不再画它');
    p.renderImgSection();
    eq(p.imgListEl.querySelectorAll('.khin-imgitem').length, 0, '一行都不画（重复的缩略图没了）');
    eq(p.imgSecEl.hidden, true, '没东西可画就整块藏起来（这就是"删掉图片识别模块"的观感）');
  });

  await test('★ 卡片里没有那张图 ⇒ 照旧画（右键识别只有这个显示面）', () => {
    const p = shadowPanel();
    expand(p);
    p.bodyEl = bodyWithImgs(['https://ex.com/other.png']);
    p.imgItems = [{ key: 'ctxmenu|https://ex.com/a.png', src: 'https://ex.com/a.png', state: 'done',
      text: 'x', matched: [], via: 'contextMenu' }];
    eq(p.unfoldedImgItems().length, 1, '卡片里没有 ⇒ 留着（静默消失是这张面板明令禁止的失败模式）');
    p.renderImgSection();
    eq(p.imgListEl.querySelectorAll('.khin-imgitem').length, 1, '右键那一行仍然画出来');
  });

  await test('没有 bodyEl（面板还没造壳）/ 没有卡片图 ⇒ 一条都不折', () => {
    const p = shadowPanel();
    p.imgItems = [{ src: 'https://ex.com/a.png', key: 'r|a' }];
    eq(p.unfoldedImgItems().length, 1, '没有卡片 ⇒ 全留着');
    p.bodyEl = bodyWithImgs([]);
    eq(p.unfoldedImgItems().length, 1, '卡片里一张图都没有 ⇒ 全留着');
  });

  /* ==========================================================================
   * ② 命中图的红框与命中词 title
   * ========================================================================== */

  await test('★ 命中的图铺红框并说出命中了哪个词；没命中的不铺', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithImgs(['https://ex.com/a.png', 'https://ex.com/b.png']);
    p.imgItems = [
      { key: 'r|a', src: 'https://ex.com/a.png', state: 'done', text: 't',
        matched: [{ text: '交友' }, { text: '供应商' }] },
      { key: 'r|b', src: 'https://ex.com/b.png', state: 'done', text: 't', matched: [] }
    ];
    p.applyImgMarks();
    const ims = p.bodyEl.querySelectorAll('img');
    eq(ims.length, 2, '装置：卡片里两张图');
    eq(ims[0].classList.contains('khin-imghit'), true, '命中的图铺红框');
    truthy(String(ims[0].title).indexOf('交友') >= 0 && String(ims[0].title).indexOf('供应商') >= 0,
      'title 把命中的词说全');
    eq(ims[1].classList.contains('khin-imghit'), false, '没命中的图不铺红框');

    /* 标记是每轮重建的，不是叠上去的：这一轮没命中了，红框要摘掉 */
    p.imgItems = [{ key: 'r|a', src: 'https://ex.com/a.png', state: 'miss', text: 't', matched: [] }];
    p.applyImgMarks();
    eq(ims[0].classList.contains('khin-imghit'), false, '这一轮没命中 ⇒ 红框摘掉');
  });

  await test('★ 同一张图多条条目（不同关键词）⇒ 取有命中的那条', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithImgs(['https://ex.com/a.png']);
    p.imgItems = [
      { key: 'r1|a', src: 'https://ex.com/a.png', state: 'done', text: 't', matched: [] },
      { key: 'r2|a', src: 'https://ex.com/a.png', state: 'done', text: 't', matched: [{ text: '厂商' }] }
    ];
    p.applyImgMarks();
    const im = p.bodyEl.querySelectorAll('img')[0];
    eq(im.classList.contains('khin-imghit'), true, '先来的没命中、后来的命中 ⇒ 仍要铺红框');
    truthy(String(im.title).indexOf('厂商') >= 0, 'title 说的是命中那条的词');
  });

  /* ==========================================================================
   * ③ 灯箱「识别原文」栏：把命中词标出来
   * ========================================================================== */

  const paint = KH.ImportantNote.paintHits;

  await test('★ 命中处插 mark，原文一字不动', () => {
    eq(typeof paint, 'function', '纯函数已导出（灯箱整条链路在垫片里跑不起来）');
    const el = H.el('div');
    paint(el, '甲。一对一乙。', ['一对一']);
    eq(el.querySelectorAll('mark.kh-lb-hit').length, 1, '命中处一个 mark');
    eq(el.querySelector('mark.kh-lb-hit').textContent, '一对一');
    eq(el.textContent, '甲。一对一乙。', '标出来不等于改内容');
  });

  await test('★ 同一位置命中多个词取最长的（短词不许把长词切碎）', () => {
    const el = H.el('div');
    paint(el, '一对一', ['一', '一对一']);
    eq(el.querySelectorAll('mark.kh-lb-hit').length, 1, '只标一次');
    eq(el.querySelector('mark.kh-lb-hit').textContent, '一对一', '取最长的那个词');
  });

  await test('★ OCR 原文里的尖括号只是文本（不拼 HTML）；没有命中就整段原文', () => {
    const a = H.el('div');
    paint(a, '<b>x</b> 交友', ['交友']);
    eq(a.querySelectorAll('b').length, 0, '页面文本不许当 HTML 拼进来');
    eq(a.textContent, '<b>x</b> 交友', '尖括号原样是字');
    const b = H.el('div');
    paint(b, '原文', []);
    eq(b.querySelectorAll('mark').length, 0, '没命中就不标');
    eq(b.textContent, '原文');
    paint(b, '', ['交友']);
    eq(b.childNodes.length, 0, '空文本 ⇒ 空容器（与原来 textContent = "" 同形）');
  });

  await test('★ 灯箱接线与两份样式（防函数变孤儿）', () => {
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('paintHits(sideText, full, (cur && cur.hits) || []);') >= 0,
      '识别原文栏要走 paintHits（不是直接 textContent）');
    truthy(src.indexOf('hits: hitsBySrc.get(k) || []') >= 0, '相册条目要带上命中词');
    truthy(src.indexOf('.kh-lb-hit') >= 0, '高亮样式存在');
    truthy(src.indexOf('.khin-item-note img.khin-imghit') >= 0, '红框样式存在');
    /* 点原文里的高亮词 = 复制整句：原来这个入口长在面板行的词块上，图折进卡片后那一行不再画
     * ⇒ 能力搬进灯箱（用户 m00292 的"标出命中的词在哪里"顺带把它变成可点的）。 */
    truthy(src.indexOf("classList.contains('kh-lb-hit')") >= 0, '灯箱原文栏要认得出被点的高亮词');
    truthy(src.indexOf(".tagName === 'MARK'") >= 0, '认的是自己画的 mark（命中词是叶子节点）');
    /* 「认高亮词不许走 closest('.kh-*') 反查」由 scripts/meta-check.js 第 4 节那条红线守着（它先剥注
     * 释再扫，比在这边写正则稳）；此处不重复。 */
    truthy(src.indexOf('sentenceOf(curText, w)') >= 0, '点词复制的是它在原文里那一整句');
    truthy(src.indexOf('.kh-lb-hit.copied') >= 0 && src.indexOf('.kh-lb-hit.failed') >= 0,
      '复制成功/失败都要有反馈样式（不许静默）');
  });

  /* ==========================================================================
   * ④ 右键识别的图 → 主模块一张卡片表格（2.0.2.13 · 用户 m03971）
   * ==========================================================================
   * 用户原话（m03971）："右键ocr图片的功能顺便优化一下（也展示在重要笔记主模块里，作为一个卡片
   * 的表格展示，表头（左格内容）固定是截图，不管右键ocr了多少个图片，都放在表头右侧一个单元格内）"。
   * 钉住四件事：① 一张都没有 ⇒ 不多出一条空卡；② 永远一行两格，左格是「截图」；
   * ③ 不管几张图都塞进**同一个**右格（不是一张图一格）；④ 文案取真源，不在面板里写死。
   */

  await test('★ 没有右键识别的图 ⇒ 不出空卡（主模块不多一条白块）', () => {
    const p = shadowPanel();
    p.imgItems = [{ key: 'r|a', src: 'https://ex.com/a.png', state: 'done' }];   // 规则抓到的图，不是右键
    eq(p.ctxItems().length, 0, '只认 via = contextMenu');
    eq(p.ctxCard(document), null, '没有就返回 null');
  });

  await test('★ 一行两格，左格固定「截图」，所有图都在右边同一格', () => {
    const p = shadowPanel();
    p.imgItems = [
      { key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'done', via: 'contextMenu' },
      { key: 'ctxmenu|b', src: 'https://ex.com/b.png', state: 'done', via: 'contextMenu' },
      { key: 'ctxmenu|c', src: 'https://ex.com/c.png', state: 'done', via: 'contextMenu' }
    ];
    const card = p.ctxCard(document);
    truthy(card, '有右键结果就该出卡');
    const rows = card.querySelectorAll('tr');
    eq(rows.length, 1, '永远只有一行（不是一张图一行）');
    const cells = rows[0].querySelectorAll('td');
    eq(cells.length, 2, '左格 + 右格');
    eq(cells[0].textContent, KH.OcrCopy.VIEW.ctxShotLabel, '左格（表头）固定是「截图」');
    eq(cells[0].querySelectorAll('img').length, 0, '左格只放标题，不放图');
    const right = cells[1];
    eq(right.className.indexOf('khin-ctx-cell') >= 0, true, '右格带排布类（flex-wrap，图多也只在这格里折行）');
    eq(right.querySelectorAll('img').length, 3, '三张图全在同一个单元格里');
  });

  await test('★ 同一张图多条条目只画一次（不重复占格）', () => {
    const p = shadowPanel();
    p.imgItems = [
      { key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'done', via: 'contextMenu' },
      { key: 'ctxmenu|a2', src: 'https://ex.com/a.png', state: 'fail', via: 'contextMenu' }
    ];
    const card = p.ctxCard(document);
    eq(card.querySelectorAll('img').length, 1, '按 src 去重');
  });

  await test('★ 只有右键图、没有任何笔记时，主模块也得露出来', () => {
    /* 旧实现 bodyEl.hidden = !items.length ⇒ 只点了右键的用户看到主模块整块消失 */
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('const ctxN = this.ctxItems().length;') >= 0, '渲染时要算上右键那张卡');
    truthy(src.indexOf('this.bodyEl.hidden = !(this.items.length || ctxN);') >= 0,
      '有右键图时笔记区不许藏');
    truthy(src.indexOf('ctxShotLabel') >= 0 && read('src/ui/ocr-copy.js').indexOf("ctxShotLabel: '截图'") >= 0,
      '表头文案取真源（面板里不许写死中文）');
  });

  await test('★ 右键 OCR 结果异步回来时，那张卡要跟着重建（真机抓到：只刷图片分区）', () => {
    /* 现场：右键公网图 ⇒ 提交成功、图片分区计数变成 (1)，但主模块那张「截图」卡一直是 0 格。
     * 根因：KH.ImgOcr.onChange 只调了 panel.renderImg()，它只重建「🖼 图片」分区；
     * 卡片是 renderItems() 里 append 的，不跟着重建就永远等下一次页面变动。
     * 这里钉：① onChange 里两个重建都调；② 重建只换那张卡、别把整块卡片区推倒。 */
    const src = read('src/features/important-note.js');
    /* 注释里也写着这串（:1311/:1329 解释 T63 时提到），取最后一次出现才是真调用点 */
    const at = src.lastIndexOf('KH.ImgOcr.onChange(');
    const cb = src.slice(at, at + 700);
    truthy(cb.indexOf('panel.renderImg()') >= 0, '原来那条刷新留着');
    truthy(cb.indexOf('panel.renderCtxCard()') >= 0, '右键那张卡也要刷新');
    truthy(/renderCtxCard\(\)\s*\{[\s\S]{0,400}?removeChild/.test(src), '重建前先摘掉旧节点（不叠卡）');
    truthy(/renderItems\(\)\s*\{[\s\S]{0,260}?this\.ctxEl = this\.ctxCard\(doc\)/.test(src),
      '整块重建时也要把新卡记到 ctxEl（否则下次 renderCtxCard 摘不到它）');
  });
};
