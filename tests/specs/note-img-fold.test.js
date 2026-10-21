/* tests/specs/note-img-fold.test.js — 图在面板里的落点（2.0.2.7 m00292 → 2.0.2.15 m00001）
 * ----------------------------------------------------------------------------
 * 2.0.2.15 用户原话（m00001 ② + m00168）："既然右键 ocr 也出现在重要笔记版主模块，而且右键 ocr
 * 后立刻展示了。那图片 ocr 分区可以彻底删除了。"
 *
 * 于是这里钉的不再是"折进卡片、别的照旧画一行"，而是**只有两个图片显示面**：
 *   ① 卡片里抓到的图 —— 命中时铺红框 + title 说出命中的词（`applyImgMarks`）；
 *   ② 右键识别的图 —— 主模块顶部那张一行两格的「截图」卡（`ctxCard`，受理即出现）；
 * 外加灯箱「识别出的文字」栏的命中高亮（`paintHits`）。
 * 底部那个「🖼 图片」分区连同它的方法/状态/样式/CSS 一起删了 —— 下面第一条就是"它真的没了"的契约。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  suite('important-note · 图只有两个显示面（2.0.2.15 删掉图片分区）');

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

  /* ==========================================================================
   * ⓪ 契约：图片分区真的删净了（不是只藏起来）
   * ========================================================================== */

  await test('★ 分区的方法 / 状态 / 样式 / 文案都没了（删净，不留半口气）', () => {
    const src = read('src/features/important-note.js');
    const copy = read('src/ui/ocr-copy.js');
    for (const dead of ['renderImgSection', 'unfoldedImgItems', 'imgRowVisible', 'groupImgItems',
      'imgUserCollapsed', 'imgCollapsed', 'imgSameBatch', 'stillSameBatch', 'cardedSrcs',
      'imgSectionTip', 'imgShowAll', 'imgExpand', 'imgNone', 'imgUserHidden']) {
      falsy(src.indexOf(dead) >= 0, 'important-note.js 里不该再有 ' + dead);
    }
    for (const cls of ['khin-imgsec', 'khin-imghead', 'khin-imgitem', 'khin-imgrow', 'khin-imgnone']) {
      falsy(src.indexOf(cls) >= 0, '样式类也不该再有 ' + cls);
    }
    /* 面板级真源：只服务那个分区的键随它一起删（留着就是没人读的死字符串） */
    for (const key of ['imgSectionTip', 'imgShowAll', 'imgExpand', 'imgNone', 'noneHit', 'noneHitBusy']) {
      falsy(copy.indexOf(key + ':') >= 0, 'ocr-copy.js 里不该再有无人读的 ' + key);
    }
    /* 面板只剩一个题头：笔记区那个。图片区题头连键盘可达性一起没了 */
    eq((src.match(/khin-notebar/g) || []).length > 0, true, '笔记区题头还在');
    falsy(src.indexOf('khin-imgbar') >= 0, '图片区题头没了');
  });

  /* ==========================================================================
   * ① 卡片里的图：命中铺红框、title 说出命中的词
   * ========================================================================== */

  await test('★ 命中的图铺红框并说出命中了哪个词；没命中的铺绿框且说清为什么没中', () => {
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
    /* 【2.0.6.1 需求⑧】没命中不再"什么都不说"：绿框 + 说清已识别未命中 */
    eq(ims[1].classList.contains('khin-imgmiss'), true, '没命中的图铺绿框（用户口径：没命中给绿色）');
    truthy(String(ims[1].title).indexOf('未命中') >= 0, 'title 要说出「已识别，未命中」：' + ims[1].title);

    /* 标记是每轮重建的，不是叠上去的：这一轮没命中了，红框要摘掉 */
    p.imgItems = [{ key: 'r|a', src: 'https://ex.com/a.png', state: 'done', text: 't', matched: [] }];
    p.applyImgMarks();
    eq(ims[0].classList.contains('khin-imghit'), false, '这一轮没命中 ⇒ 红框摘掉');
    eq(ims[0].classList.contains('khin-imgmiss'), true, '⇒ 换成绿框');
  });

  /* 【2.0.6.1 需求⑧】蓝=识别中、红=命中、绿=无命中（失败也绿，悬停说失败） */
  await test('★ 边框三态：识别中蓝、命中红、无命中绿；失败算无命中但悬停说失败', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithImgs(['https://ex.com/p.png', 'https://ex.com/f.png', 'https://ex.com/h.png']);
    p.imgItems = [
      { key: 'r|p', src: 'https://ex.com/p.png', state: 'pending', text: '', matched: [] },
      { key: 'r|f', src: 'https://ex.com/f.png', state: 'fail', text: '', matched: [] },
      { key: 'r|h', src: 'https://ex.com/h.png', state: 'done', text: 't', matched: [{ text: 'x' }] }
    ];
    p.applyImgMarks();
    const ims = p.bodyEl.querySelectorAll('img');
    eq(ims[0].classList.contains('khin-imgbusy'), true, '识别中 = 蓝框');
    eq(ims[0].classList.contains('khin-imgmiss'), false, '识别中不许提前判绿');
    eq(ims[1].classList.contains('khin-imgmiss'), true, '失败归绿框（不能装成还在跑）');
    truthy(String(ims[1].title).indexOf('失败') >= 0, '失败原因挂 title：' + ims[1].title);
    eq(ims[2].classList.contains('khin-imghit'), true, '命中 = 红框');

    /* 同一张图多条条目：识别中压不过已完成（否则结果回来了还一直蓝） */
    p.imgItems = [
      { key: 'r1|h', src: 'https://ex.com/h.png', state: 'pending', text: '', matched: [] },
      { key: 'r2|h', src: 'https://ex.com/h.png', state: 'done', text: 't', matched: [] }
    ];
    p.applyImgMarks();
    eq(ims[2].classList.contains('khin-imgbusy'), false, 'done 压过 pending（结果回来就别再显示识别中）');
    eq(ims[2].classList.contains('khin-imgmiss'), true);
  });

  await test('★ 没命中的解释要说到点上：动态值没找到 / 点名字段没取到值 / 没字', () => {
    const p = shadowPanel();
    p.bodyEl = bodyWithImgs(['https://ex.com/1.png', 'https://ex.com/2.png', 'https://ex.com/3.png']);
    p.imgItems = [
      { key: 'r|1', src: 'https://ex.com/1.png', state: 'done', text: '整个公司名被折成两行',
        matched: [], needMissingValues: ['徐州启明星教育科技有限公司'] },
      { key: 'r|2', src: 'https://ex.com/2.png', state: 'done', text: 't',
        matched: [], needMissing: ['著作权人'] },
      { key: 'r|3', src: 'https://ex.com/3.png', state: 'done', text: '   ', matched: [] }
    ];
    p.applyImgMarks();
    const t = p.bodyEl.querySelectorAll('img').map((im) => String(im.title || ''));
    truthy(t[0].indexOf('徐州启明星教育科技有限公司') >= 0, '★ 图上有字、只是动态值没对上 ⇒ 说出是哪个值：' + t[0]);
    truthy(t[1].indexOf('著作权人') >= 0, '★ 点名字段没取到值 ⇒ 说出是哪个字段：' + t[1]);
    truthy(t[2].indexOf('没识别出文字') >= 0, '★ 图里没字 ⇒ 直说：' + t[2]);
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

  await test('没有 bodyEl（面板还没造壳）⇒ 不抛也不画', () => {
    const p = shadowPanel();
    p.imgItems = [{ src: 'https://ex.com/a.png', key: 'r|a', matched: [{ text: 'x' }] }];
    p.applyImgMarks();          // 不该抛
    eq(1, 1);
  });

  /* ==========================================================================
   * ② 灯箱「识别出的文字」栏：把命中词标出来
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
    /* 点原文里的高亮词 = 复制整句：面板行上的词块随图片分区一起删了 ⇒ 这条能力只在灯箱里有 */
    truthy(src.indexOf("classList.contains('kh-lb-hit')") >= 0, '灯箱原文栏要认得出被点的高亮词');
    truthy(src.indexOf(".tagName === 'MARK'") >= 0, '认的是自己画的 mark（命中词是叶子节点）');
    truthy(src.indexOf('sentenceOf(curText, w)') >= 0, '点词复制的是它在原文里那一整句');
    truthy(src.indexOf('.kh-lb-hit.copied') >= 0 && src.indexOf('.kh-lb-hit.failed') >= 0,
      '复制成功/失败都要有反馈样式（不许静默）');
  });

  /* ==========================================================================
   * ③ 右键识别的图 → 主模块一张卡片表格（2.0.2.13 · m03971；2.0.2.15 起是唯一显示面）
   * ==========================================================================
   * 用户原话（m03971）："右键ocr图片的功能顺便优化一下（也展示在重要笔记主模块里，作为一个卡片
   * 的表格展示，表头（左格内容）固定是截图，不管右键ocr了多少个图片，都放在表头右侧一个单元格内）"。
   * 2.0.2.15（m00001 ②）再补一条：**受理那一刻就要出现**，不许等识别跑完。
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
    eq(cells[0].textContent.trim(), KH.OcrCopy.VIEW.ctxShotLabel, '左格（表头）固定是「截图」');
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

  await test('★ 受理即出现：图还在识别时也有卡，并在标题格旁说「识别中…」', () => {
    const p = shadowPanel();
    p.imgItems = [{ key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'pending', via: 'contextMenu' }];
    const card = p.ctxCard(document);
    truthy(card, '识别没跑完也得先出卡（用户 m00001 ②：右键那一刻就要看见）');
    eq(card.querySelectorAll('img').length, 1, '图本身立刻画出来');
    truthy(card.textContent.indexOf(KH.OcrCopy.VIEW.ctxBusy) >= 0, '并且说清"文字还在路上"');
  });

  await test('★ 识别失败也要说出来（不许静默留一张图）', () => {
    const p = shadowPanel();
    p.imgItems = [{ key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'fail', via: 'contextMenu' }];
    const card = p.ctxCard(document);
    truthy(card.textContent.indexOf(KH.OcrCopy.VIEW.ctxFail) >= 0, '失败原因（无文字）要挂在卡上');
  });

  await test('★ 只有右键图、没有任何笔记时，主模块也得露出来', () => {
    /* 旧实现 bodyEl.hidden = !items.length ⇒ 只点了右键的用户看到主模块整块消失 */
    const src = read('src/features/important-note.js');
    truthy(src.indexOf('const ctxN = this.ctxItems().length;') >= 0, '渲染时要算上右键那张卡');
    truthy(src.indexOf('this.bodyEl.hidden = !(this.items.length || ctxN);') >= 0,
      '有右键图时笔记区不许藏');
    truthy(src.indexOf('if (!sorted.length && !this.ctxItems().length)') >= 0,
      '整页既没笔记也没有右键图才允许整块不显示');
    truthy(src.indexOf('ctxShotLabel') >= 0 && read('src/ui/ocr-copy.js').indexOf("ctxShotLabel: '截图'") >= 0,
      '表头文案取真源（面板里不许写死中文）');
  });

  await test('★ 右键 OCR 状态变了 ⇒ 那张卡跟着重建（受理 / 结果 / 失败三条路）', () => {
    /* 现场（2.0.2.13）：右键公网图 ⇒ 提交成功，但主模块那张「截图」卡一直是 0 格。
     * 根因：KH.ImgOcr.onChange 只调了 panel.renderImg()，卡是 renderItems() 里 append 的，
     * 不跟着重建就永远等下一次页面变动。2.0.2.15 把刷新统一落在 renderImg() 里。 */
    const src = read('src/features/important-note.js');
    const at = src.lastIndexOf('KH.ImgOcr.onChange(');
    const cb = src.slice(at, at + 300);
    truthy(cb.indexOf('panel.renderImg()') >= 0, '识别状态变化要刷新面板');
    truthy(/renderImg\(\)\s*\{[\s\S]{0,900}?renderCtxCard\(\)/.test(src), 'renderImg 里要重建那张卡');
    truthy(/renderCtxCard\(\)\s*\{[\s\S]{0,500}?removeChild/.test(src), '重建前先摘掉旧节点（不叠卡）');
    /* 2.0.4 需求④ 起「建卡 + 记 ctxEl + 落位」收在 renderCtxCard 一处（renderItems 循环后调它，
     * 它自带签名闸）。契约不变：整块重建时新卡仍要记到 ctxEl，否则下次摘不到。 */
    truthy(/renderItems\(\)\s*\{[\s\S]{0,4000}?this\.renderCtxCard\(\);/.test(src),
      '整块重建时也要把新卡记到 ctxEl（现在由 renderCtxCard 统一建卡）');
    truthy(/renderCtxCard\(\)\s*\{[\s\S]{0,900}?this\.ctxEl = this\.ctxCard\(document\)/.test(src),
      'ctxEl 的赋值点必须在 renderCtxCard 里（唯一实现）');
  });

  /* ==========================================================================
   * ④ 右键那张卡：可关闭、排最下方、不干扰置顶排序（2.0.2.16 需求⑦）
   * ==========================================================================
   * 用户原话（m01585-7）："要支持关闭（视为之前添加的图片 OCR 都取消）；排序放在最下方；
   * 不要影响设置卡片置顶排序"。
   */

  await test('★ 卡上有 ✕，点了整批取消手动 OCR（面板不自己动内部表）', () => {
    const p = shadowPanel();
    p.imgItems = [{ key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'done', via: 'contextMenu' }];
    const card = p.ctxCard(document);
    const head = card.querySelector('.khin-item-head');
    truthy(head, '卡上要有题头行（✕ 挂在这里，与笔记卡同构）');
    const btn = head.querySelector('.khin-item-close');
    truthy(btn, '★ 必须有 ✕（用户要求：右键 OCR 的卡要能关）');
    eq(btn.title, KH.OcrCopy.VIEW.removeTip, '悬停文案取面板真源（面板里不许写死）');
    eq(btn.textContent, '✕');
    /* 记下 clearManual 被调了几次（真实面板里它会 notify ⇒ 面板重画） */
    const imgOcr = KH.ImgOcr;
    const realClear = imgOcr && imgOcr.clearManual;
    let calls = 0;
    imgOcr.clearManual = () => { calls++; };
    try {
      btn.dispatchEvent({ type: 'click' });
    } finally { imgOcr.clearManual = realClear; }
    eq(calls, 1, '★ 点 ✕ 走 clearManual（整批作废，不是只藏这张卡）');
  });

  await test('★ 这张卡排最下方，且不进置顶排序（笔记卡在上，右键产物在下）', () => {
    const src = read('src/features/important-note.js');
    /* 整块重建：先画完全部笔记卡，再由 renderCtxCard（唯一建卡点）把右键卡 append 到最后 */
    truthy(/renderItems\(\)\s*\{[\s\S]{0,4000}?this\.renderCtxCard\(\);/.test(src),
      '★ 右键卡必须排在笔记卡之后（笔记卡循环结束才创建/追加）');
    /* 单选刷新：也只许 append，不许插到最前（2.0.4 起前面多了签名闸，放宽字符窗） */
    truthy(/renderCtxCard\(\)\s*\{[\s\S]{0,1500}?this\.bodyEl\.appendChild\(this\.ctxEl\)/.test(src),
      '重建那张卡时同样 append（append = 最下方）');
    falsy(src.indexOf('insertBefore(this.ctxEl') >= 0, '★ 旧实现是插到最前，这条锁着别回去');
    /* 置顶排序只作用于笔记卡：ctx 卡不进那张表 */
    truthy(src.indexOf('const sorted = pins.length ? head.sortByPins(items, pins) : items;') >= 0,
      '置顶排序仍然只排笔记卡');
    falsy(/sortByPins\([^)]*ctx/.test(src), '★ 右键卡不许进置顶排序（不许影响设置里的卡片顺序）');
  });

  await test('★ 边框状态不许"先全清再全加"（2.0.6.2 需求④：那是自激闪烁的源头）', () => {
    const src = read('src/features/important-note.js');
    const fn = /function markOneImg\(im, it(?:, kind)?\)[\s\S]{0,2400}?\n  \}/.exec(src);
    truthy(fn, 'markOneImg 应当存在');
    const body = fn[0];
    /* 旧写法每次都 remove 三态再 add 一遍：`class` 属性连跳两次，而调度器的 MutationObserver
     * 正好盯着 `class`（attributeFilter:['class']）⇒ 自己触发自己，页面越静它越扫。 */
    falsy(/classList\.remove\(IMG_MARK_CLS\[i\]\);\s*\n\s*\}/.test(body),
      '★ 不许无条件清三态：只写真正变了的那个（否则每次重扫都自激重跑）');
    truthy(body.indexOf('if (cls !== want && im.classList.contains(cls)) im.classList.remove(cls);') >= 0,
      '★ 幂等写法：与目标状态相同就一个字节都不动');
    truthy(body.indexOf('if (have !== tip) {') >= 0, 'title 同样只在变了才写');
  });
};
