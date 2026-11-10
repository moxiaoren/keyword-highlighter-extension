#!/usr/bin/env node
'use strict';
/* #116 真机验收脚本（临时装置，不入包）
 *
 * 验「写错的 `@字段名` 不再静默」在**真浏览器**里的两个可见面：
 *   A 图片命中关键词弹窗：`一对一@开发这` ⇒ 诊断条出现，写明「不是已配的抓取字段」+ 建议「开发者」；
 *     把它改对 ⇒ 诊断条自动消失（不用重开弹窗）。
 *   B 图上须有的字段值弹窗：`词@开发者^高价` ⇒ 报「把取值后缀写进了指向」。
 *   C 全部正常时诊断条不存在（不留空壳）。
 *
 * 用法：node e2e/verify-116.js
 */
const path = require('path');
const { launch } = require('./harness');

const out = [];
const log = (ok, msg, extra) => {
  out.push((ok ? '✓ ' : '✗ ') + msg + (extra ? ' · ' + extra : ''));
  console.log(out[out.length - 1]);
};

const KW = {
  id: 'e2e116', text: '一对一', fetchEnabled: true, imgOcr: true,
  fetchLabels: '开发者|登记号',
  imgOcrKeyword: '一对一@开发这',
  imgOcrNeed: '词@开发者^高价',
  imgOcrMax: ''
};

(async () => {
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context, extId } = api;
  let failed = 0;
  const t = (ok, msg, extra) => { log(ok, msg, extra); if (!ok) failed++; };
  try {
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.goto('chrome-extension://' + extId + '/options/options.html#sec-keywords', { waitUntil: 'load' });
    await page.waitForTimeout(700);

    /* 用真编辑器打开这条关键词（设置页里「添加关键词」用的就是同一个组件） */
    const opened = await page.evaluate((kw) => {
      window.KH.ui.KeywordEditor.openEditor({ cfg: { keywords: [kw], groups: [] }, keyword: kw });
      return !!document.querySelector('.kh-modal');
    }, KW);
    t(opened, '真编辑器弹窗打开');

    /** 点某个字段标题旁的「修改」，返回诊断条状态 */
    const openList = async (label) => {
      await page.locator('.kh-fld', { hasText: label }).first().locator('.kh-list-btn').click();
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const el = document.querySelector('.kh-issue-list');
        return {
          has: !!el && !el.hidden,
          rows: document.querySelectorAll('.kh-issue-row').length,
          text: el ? String(el.textContent || '') : ''
        };
      });
    };

    /* ================= A 图片命中关键词 ================= */
    const a = await openList('图片命中关键词');
    t(a.has, '写错的指向 ⇒ 诊断条出现（以前是完全静默）');
    t(a.rows === 1, '只报真正写错的那一个（不把左边的普通词拖进来）', 'rows=' + a.rows);
    t(/@开发这/.test(a.text), '点名了写错的那个指向', a.text.slice(0, 60));
    t(/不是已配的抓取字段/.test(a.text), '说清了后果：不会按字段生效');
    t(/开发者/.test(a.text) && /是不是/.test(a.text), '给出最接近的已配字段建议');

    /* 改对 ⇒ 诊断条消失（input 事件即时重算） */
    await page.locator('.kh-list-val').first().fill('一对一@开发者');
    await page.waitForTimeout(250);
    const a2 = await page.evaluate(() => {
      const el = document.querySelector('.kh-issue-list');
      return { has: !!el && !el.hidden, rows: document.querySelectorAll('.kh-issue-row').length };
    });
    t(!a2.has, '改对之后提醒自己消失', JSON.stringify(a2));

    /* 收掉这个列表弹窗（顶层弹窗是列表，下面还有编辑器） */
    await page.locator('.kh-modal-x').last().click();
    await page.waitForTimeout(200);

    /* ================= B 图上须有的字段值 ================= */
    const b = await openList('图上须有的字段值');
    t(b.has && b.rows === 1, '后缀写进指向 ⇒ 单独一类提醒', 'rows=' + b.rows);
    t(/取值后缀/.test(b.text), '说清是「后缀写进了指向」');
    t(/开发者/.test(b.text) && /抓取后续字段/.test(b.text), '告诉用户后缀该写在哪一格');
    await page.locator('.kh-modal-x').last().click();
    await page.waitForTimeout(200);

    /* 关掉第一个编辑器，C 段另开一个干净弹窗（否则两层遮罩互相挡） */
    await page.locator('.kh-modal-x').last().click();
    await page.waitForTimeout(200);

    /* ================= C 全部正常 ⇒ 不留空壳 ================= */
    await page.evaluate(() => {
      const cfg = { keywords: [], groups: [] };
      const kw = {
        id: 'ok', text: '一对一', fetchEnabled: true, imgOcr: true, fetchLabels: '开发者|登记号',
        imgOcrKeyword: '一对一@开发者', imgOcrNeed: '词@登记号', imgOcrMax: ''
      };
      window.KH.ui.KeywordEditor.openEditor({ cfg: cfg, keyword: kw });
    });
    await page.waitForTimeout(400);
    const c = await openList('图片命中关键词');
    t(!c.has, '全部指向合法时，一行提醒都不出现', JSON.stringify(c));

    t(errs.length === 0, '设置页无 JS 报错', errs.slice(0, 2).join(' / '));
  } catch (e) {
    log(false, '脚本异常：' + ((e && e.stack) || e));
    failed++;
  } finally {
    try { await api.close(); } catch (e) { /* 忽略 */ }
  }
  console.log('\n结果：' + out.filter((s) => s[0] === '✓').length + ' 通过 · ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
