#!/usr/bin/env node
'use strict';
/* 发版说明页的配图生成器（真浏览器截图，不入包）
 *
 * 说明页（release/notes/v*.html）里的图必须是**真界面**：这个脚本启动真扩展，
 * 在真内容页里调真的 `KH.ImportantNote.panel.decorateMerge` / 真编辑弹窗，然后按元素截屏。
 *
 * 产出：release/notes/img/*.png
 * 用法：node e2e/shots-notes.js
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./harness');
const server = require('./server');

const OUT = path.resolve(__dirname, '..', 'release', 'notes', 'img');

/* 在扩展隔离世界跑：造一张抓取表 + 调真的合并渲染。
 * 关键：必须画在**面板自己的 shadowRoot 里**——STYLE 是随面板 `ensure()` 注入的，
 * 画在 light DOM 里会丢 `.kh-table-fetch` / `.kh-merge-conflict` 的全部样式（黄底、橙条、
 * 感叹号、虚线分隔都来自那份样式表），截出来就是一张没样式的裸表。 */
const PAINT_MERGE = (mergeRows, compare, rows) => {
  const P = window.KH.ImportantNote.panel;
  P.ensure(document);
  const root = P.root;
  root.hidden = false;
  /* 面板根是 fixed 定位：把画板钉在左上角，坐标才稳定 */
  let host = root.querySelector('#e2e-shot');
  if (!host) {
    host = document.createElement('div');
    host.id = 'e2e-shot';
    host.style.cssText = 'position:fixed;left:0;top:0;width:560px;padding:18px;background:#fff;' +
      'font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;z-index:2147483647';
    root.appendChild(host);
  }
  host.innerHTML = '<table class="kh-table-fetch"><tbody>' +
    rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') +
    '</tbody></table>';
  window.KH.ImportantNote.panel.decorateMerge(host, { mergeRows: mergeRows || [], compare: compare || null });
  /* 只截表格本身：画板有 padding，整块截会把下一行残影带进图里 */
  const t = host.querySelector('table');
  const b = (t || host).getBoundingClientRect();
  const r = host.getBoundingClientRect();
  const pad = 10;
  return {
    x: Math.round(b.x) - pad, y: Math.round(b.y) - pad,
    w: Math.round(Math.max(b.width, 380)) + pad * 2, h: Math.round(b.height) + pad * 2,
    hostW: Math.round(r.width)
  };
};

/* 打开真编辑弹窗并点开「图片命中关键词」的列表窗 */
const OPEN_EDITOR = (kw) => {
  const api = window.KH.ui && window.KH.ui.KeywordEditor;
  if (!api) return 'no-api';
  api.openEditor({ cfg: { keywords: [kw], groups: [] }, keyword: kw });
  return 'ok';
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await server.start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context } = api;
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 1000 });
    const cdp = await context.newCDPSession(page);
    let extCtx = 0;
    cdp.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.origin && String(c.origin).indexOf('chrome-extension://') === 0) extCtx = c.id;
    });
    await cdp.send('Runtime.enable');
    await page.goto(srv.origin + '/hidden-hit.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
    for (let i = 0; i < 60 && !extCtx; i++) await page.waitForTimeout(100);
    if (!extCtx) throw new Error('没找到扩展隔离世界');

    const inExt = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expression, contextId: extCtx, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error('扩展世界抛错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const paintMerge = (rows, mergeRows, compare) =>
      inExt('(' + PAINT_MERGE.toString() + ')(' + JSON.stringify(mergeRows || []) + ',' + JSON.stringify(compare || null) + ',' + JSON.stringify(rows) + ')');

    const shoot = async (name, rect) => {
      if (!rect) throw new Error('没有画板');
      await page.screenshot({
        path: path.join(OUT, name),
        clip: { x: Math.max(0, rect.x - 1), y: Math.max(0, rect.y - 1), width: rect.w + 2, height: rect.h + 2 },
        animations: 'disabled'
      });
      console.log('✓ ' + name + ' ' + rect.w + 'x' + rect.h);
    };

    /* ① 2.0.8.19 冲突行：页面值 abc1234 vs 图上值 ABX9999 ⇒ 浅黄底 + 左橙条 + 感叹号 */
    let rect = await paintMerge(
      [['著作权人', '甲公司'], ['登记号', 'abc1234']],
      [{ field: '登记号', title: '登记号', hit: true, value: 'abc1234', ocrValue: 'ABX9999', from: 'need', onConflict: 'mark' }],
      null
    );
    await page.waitForTimeout(200);
    await shoot('conflict-row.png', rect);

    /* ② 2.0.8.21 结论行：著作权人 甲 vs 授权书 乙 ⇒ 表格下方一行结论 */
    rect = await paintMerge(
      [['著作权人', '甲公司'], ['登记号', 'abc1234']],
      [],
      { hasDoc: true, docCount: 1, rows: [
        { left: '著作权人', right: '授权公司', rv: ['乙公司'], lvOcr: [] },
        { left: '登记号', right: '登记号', rv: ['abc1234'], lvOcr: ['abc1234'] }
      ] }
    );
    await page.waitForTimeout(200);
    await shoot('compare-line.png', rect);

    /* ③ 2.0.8.21 判不出授权书：只配同名字段 ⇒ 明说，不罗列三条缺字段 */
    rect = await paintMerge(
      [['登记号', 'abc1234']],
      [],
      { hasDoc: false, docCount: 0, docAmbiguous: true, rightNames: ['登记号'], rows: [
        { left: '登记号', right: '登记号', rv: [], lvOcr: [] }
      ] }
    );
    await page.waitForTimeout(200);
    await shoot('no-doc-ambiguous.png', rect);

    /* ④ 2.0.8.20 编辑弹窗顶部的指向提醒 */
    await inExt('(' + OPEN_EDITOR.toString() + ')(' + JSON.stringify({
      word: '一对一', note: '', imgOcr: true, imgOcrKeyword: '一对一@开发这',
      fetchEnabled: true, fetchLabels: '开发者@2|被授权公司'
    }) + ')');
    await page.waitForTimeout(700);
    /* 用 JS 点开「图片命中关键词」的列表窗（Playwright 的 text 选择器会等 actionability） */
    const clicked = await inExt(`(() => {
      const flds = Array.from(document.querySelectorAll('.kh-fld'));
      const f = flds.find(el => /图片命中关键词/.test(el.textContent || ''));
      const b = f && f.querySelector('.kh-list-btn');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()`);
    await page.waitForTimeout(600);
    const dbg = await inExt(`(() => Array.from(document.querySelectorAll('.kh-modal')).map((m, i) => {
      const r = m.getBoundingClientRect();
      return { i: i, cls: m.className, pos: getComputedStyle(m).position, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), t: (m.textContent || '').replace(/\\s+/g, ' ').slice(0, 30) };
    }))()`);
    console.log('  弹窗：' + JSON.stringify(dbg));
    const modalRect = await inExt(`(() => {
      const ms = Array.from(document.querySelectorAll('.kh-modal'));
      const m = ms[ms.length - 1];
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!modalRect) throw new Error('编辑弹窗没打开（' + clicked + '）');
    /* 弹窗里有持续过渡动画：必须 animations:'disabled'，否则 Playwright 等「画面稳定」会超时 */
    /* clip + animations:'disabled' 在这页会挂住（实测 Timeout 30000ms），
     * 改成「收起画板 → 把弹窗滚到视口顶 → 整页截图」，构图也更好看。 */
    await inExt(`(() => {
      const P = window.KH.ImportantNote.panel;
      if (P && P.root) P.root.hidden = true;
      const ms = Array.from(document.querySelectorAll('.kh-modal'));
      const m = ms[ms.length - 1];
      if (m) m.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'editor-reminder.png'), animations: 'disabled' });
    console.log('✓ editor-reminder.png ' + rect.w + 'x' + Math.min(470, rect.h));

    console.log('\n产出目录：' + OUT);
  } finally {
    try { await api.close(); } catch (e) { /* ignore */ }
    try { srv.server.close(); } catch (e) { /* ignore */ }
  }
})().catch((e) => {
  console.error('截图失败：', e && e.stack || e);
  process.exit(1);
});
