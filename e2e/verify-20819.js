#!/usr/bin/env node
'use strict';
/* 2.0.8.19 真机验收脚本（临时装置，不入包）
 *
 * 验 #117 软著三方比对的全部用户可见面，且都在**真浏览器**里跑：
 *   A 设置页：分 tab 深链 → 折叠块能展开 → 加行 → 存进 chrome.storage → 刷新回显 → 删行 → 无 JS 报错
 *   B 结论行：在真内容页的**扩展隔离世界**里调真的 `KH.ImportantNote.panel.decorateMerge`
 *      · 对不上 ⇒ 表格下方一行结论，写明两边原值；对得上的组不刷屏
 *      · 全对上 ⇒ 结论行被摘掉（不留空壳红字）
 *      · 没认出授权书 ⇒ 只报这一件事
 *      · 表格空 + 授权书侧无值 ⇒ 一行都不渲染（证据门）
 *      · 重复渲染不叠加
 *   注：内容脚本跑在隔离世界，主世界拿不到 window.KH，所以走 CDP 的 executionContext。
 *
 * 用法：node e2e/verify-20819.js
 */
const path = require('path');
const { launch } = require('./harness');
const server = require('./server');

const out = [];
const log = (ok, msg, extra) => {
  out.push((ok ? '✓ ' : '✗ ') + msg + (extra ? ' · ' + extra : ''));
  console.log(out[out.length - 1]);
};

/* 在隔离世界里跑：拿已有 host（没有就建），必要时重置表格，然后画。 */
const PAINT = (compare, reset) => {
  let host = document.getElementById('e2e-cmp-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'e2e-cmp-host';
    document.body.appendChild(host);
  }
  if (reset || !host.querySelector('table.kh-table-fetch')) {
    host.innerHTML = '<table class="kh-table-fetch"><tbody>'
      + '<tr><td>著作权人</td><td>甲公司</td></tr>'
      + '<tr><td>登记号</td><td>abc1234</td></tr>'
      + '</tbody></table>';
  }
  window.KH.ImportantNote.panel.decorateMerge(host, { mergeRows: [], compare: compare });
  const line = host.querySelector('.kh-compare-line');
  const table = host.querySelector('table.kh-table-fetch');
  return {
    text: line ? String(line.textContent || '') : '',
    exists: !!line,
    count: host.querySelectorAll('.kh-compare-line').length,
    afterTable: !!(line && table && line.previousElementSibling === table),
    role: line ? line.getAttribute('role') : '',
    sig: line ? line.getAttribute('data-kh-cmp-sig') : ''
  };
};

(async () => {
  const srv = await server.start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context, extId } = api;
  let failed = 0;
  const t = (ok, msg, extra) => { log(ok, msg, extra); if (!ok) failed++; };
  try {
    /* ================= A 设置页 ================= */
    const opts = await context.newPage();
    const errs = [];
    opts.on('pageerror', (e) => errs.push(String(e && e.message || e)));
    opts.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    /* 设置页是分 tab 的，#sec-ocr 默认 hidden，必须深链才激活 */
    await opts.goto('chrome-extension://' + extId + '/options/options.html#sec-ocr', { waitUntil: 'load' });
    await opts.waitForTimeout(900);

    const a0 = await opts.evaluate(() => {
      const d = document.getElementById('ocr-adv-compare');
      const sum = d ? d.querySelector('summary') : null;
      return {
        has: !!d,
        summary: sum ? sum.textContent.trim() : '',
        rows: document.querySelectorAll('#cmp-rows .kh-compare-row').length,
        muted: (document.querySelector('#cmp-rows .kh-muted') || {}).textContent || '',
        hasAdd: !!document.getElementById('cmp-add')
      };
    });
    t(a0.has, '设置页有「软著三方比对」折叠块', a0.summary);
    t(a0.hasAdd, '有「+ 添加一组」按钮');
    t(a0.rows === 0 && /还没配/.test(a0.muted), '初始是空态引导', a0.muted.slice(0, 40));

    /* 折叠块默认收起 ⇒ 先像用户那样点开 summary（顺便验证它真的能展开） */
    await opts.click('#ocr-adv-compare > summary');
    await opts.waitForTimeout(200);
    const opened = await opts.evaluate(() => {
      const d = document.getElementById('ocr-adv-compare');
      const b = document.getElementById('cmp-add');
      return { open: !!(d && d.open), visible: !!(b && b.offsetParent) };
    });
    t(opened.open && opened.visible, '点标题能展开，按钮变得可见', JSON.stringify(opened));

    /* 加第一组：著作权人 = 授权公司 */
    await opts.click('#cmp-add');
    await opts.waitForTimeout(120);
    const n1 = await opts.evaluate(() => document.querySelectorAll('#cmp-rows .kh-compare-row').length);
    t(n1 === 1, '点一次「+ 添加一组」多一行', 'rows=' + n1);

    await opts.evaluate(() => {
      const row = document.querySelector('#cmp-rows .kh-compare-row');
      const l = row.querySelector('.kh-cmp-left');
      const r = row.querySelector('.kh-cmp-right');
      l.value = '著作权人'; r.value = '授权公司';
      l.dispatchEvent(new Event('change', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await opts.waitForTimeout(700);
    const st1 = await opts.evaluate(async () => {
      const cfg = await new Promise((res) => chrome.storage.local.get(null, res));
      return cfg.imgCompare || null;
    });
    t(!!st1 && !!st1.rows && st1.rows.length === 1, '保存进 chrome.storage.local（不是只改内存）',
      JSON.stringify(st1));
    t(!!st1 && st1.on === true, '配了行就自动置 on=true', JSON.stringify(st1 && st1.on));
    t(!!st1 && st1.rows[0].left === '著作权人' && st1.rows[0].right === '授权公司',
      '存的是左右两个字段名', JSON.stringify(st1 && st1.rows[0]));

    /* 刷新后还在（回显走归一函数）；刷新会回到收起态，所以先点开再看 */
    await opts.reload({ waitUntil: 'load' });
    await opts.waitForTimeout(600);
    await opts.goto('chrome-extension://' + extId + '/options/options.html#sec-ocr', { waitUntil: 'load' });
    await opts.waitForTimeout(600);
    await opts.click('#ocr-adv-compare > summary');
    await opts.waitForTimeout(200);
    const back = await opts.evaluate(() => {
      const row = document.querySelector('#cmp-rows .kh-compare-row');
      if (!row) return null;
      return { l: row.querySelector('.kh-cmp-left').value, r: row.querySelector('.kh-cmp-right').value };
    });
    t(!!back && back.l === '著作权人' && back.r === '授权公司', '刷新后回显仍在', JSON.stringify(back));

    /* 再加一组同名字段（登记号 = 登记号）：这是软著场景里唯一「两边同名字段」的组 */
    await opts.click('#cmp-add');
    await opts.waitForTimeout(120);
    await opts.evaluate(() => {
      const rows = document.querySelectorAll('#cmp-rows .kh-compare-row');
      const row = rows[rows.length - 1];
      const l = row.querySelector('.kh-cmp-left');
      const r = row.querySelector('.kh-cmp-right');
      l.value = '登记号'; r.value = '登记号';
      l.dispatchEvent(new Event('change', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await opts.waitForTimeout(700);
    const st2 = await opts.evaluate(async () => {
      const cfg = await new Promise((res) => chrome.storage.local.get(null, res));
      return (cfg.imgCompare || {}).rows || [];
    });
    t(st2.length === 2 && st2[1].left === '登记号', '第二组（同名字段）也能存', JSON.stringify(st2));

    /* 删掉第一组 */
    await opts.evaluate(() => {
      const row = document.querySelector('#cmp-rows .kh-compare-row');
      row.querySelector('button').click();
    });
    await opts.waitForTimeout(700);
    const st3 = await opts.evaluate(async () => {
      const cfg = await new Promise((res) => chrome.storage.local.get(null, res));
      return (cfg.imgCompare || {}).rows || [];
    });
    t(st3.length === 1 && st3[0].left === '登记号', '删行真的从配置里删掉了', JSON.stringify(st3));
    t(errs.length === 0, '设置页全程无 JS 报错', errs.slice(0, 2).join(' | '));

    /* ================= B 结论行（扩展隔离世界） ================= */
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let extCtx = 0;
    cdp.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.origin && String(c.origin).indexOf('chrome-extension://') === 0) extCtx = c.id;
    });
    await cdp.send('Runtime.enable');
    await page.goto(srv.origin + '/hidden-hit.html', { waitUntil: 'load' });
    /* 内容脚本是 document_idle 注入；等它把 state 挂到 <html> 上 */
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
    for (let i = 0; i < 60 && !extCtx; i++) await page.waitForTimeout(100);
    t(extCtx > 0, '找到扩展隔离世界（内容脚本上下文）', 'ctxId=' + extCtx);

    const inExt = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expression, contextId: extCtx, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error('扩展世界抛错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const paint = (cmp, reset) => inExt('(' + PAINT.toString() + ')(' + JSON.stringify(cmp) + ',' + !!reset + ')');

    /* B1 对不上：著作权人「甲」vs 授权书「乙」⇒ 一行结论；登记号两边一致 ⇒ 不出 */
    const b1 = await paint({
      hasDoc: true, docCount: 1,
      rows: [
        { left: '著作权人', right: '授权公司', rv: ['乙公司'], lvOcr: [] },
        { left: '登记号', right: '登记号', rv: ['abc1234'], lvOcr: ['abc1234'] }
      ]
    }, true);
    t(b1.exists, '对不上 ⇒ 表格下方出现结论行');
    t(/著作权人与授权公司不一致/.test(b1.text), '结论点名是哪一组', b1.text);
    t(b1.text.indexOf('甲公司') >= 0 && b1.text.indexOf('乙公司') >= 0, '两边原值都写出来', b1.text);
    t(b1.text.indexOf('登记号') < 0, '对得上的登记号不进结论（不刷屏）', b1.text);
    t(b1.afterTable, '结论行紧贴在表格下面');
    t(b1.role === 'status', '结论行带 role=status（读屏能听到）', b1.role);

    /* B2 全对上 ⇒ 摘掉（同一张表重画，验证是「消失」不是「没画」） */
    const b2 = await paint({
      hasDoc: true, docCount: 1,
      rows: [{ left: '著作权人', right: '授权公司', rv: ['甲公司'], lvOcr: [] }]
    }, false);
    t(!b2.exists, '全对上 ⇒ 结论行被摘掉（不留空壳）', JSON.stringify(b2));

    /* B3 没有授权书 ⇒ 一条明确结论（不是三条「缺字段」） */
    const b3 = await paint({
      hasDoc: false, docCount: 0,
      rows: [{ left: '著作权人', right: '授权公司', rv: [], lvOcr: [] }]
    }, false);
    const cnt3 = (b3.text.match(/⚠/g) || []).length;
    t(b3.exists && /未识别到软著授权书/.test(b3.text), '没认出授权书 ⇒ 明说这一件事', b3.text);
    t(cnt3 === 1, '缺授权书只报一条，不罗列三组缺字段', 'count=' + cnt3);

    /* B4 证据门：表格空、授权书侧也没值 ⇒ 一行都不许出现 */
    const b4 = await inExt('(' + (function (compare) {
      let host = document.getElementById('e2e-cmp-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'e2e-cmp-host';
        document.body.appendChild(host);
      }
      host.innerHTML = '<table class="kh-table-fetch"><tbody></tbody></table>';
      window.KH.ImportantNote.panel.decorateMerge(host, { mergeRows: [], compare: compare });
      return { exists: !!host.querySelector('.kh-compare-line') };
    }).toString() + ')(' + JSON.stringify({
      hasDoc: true, docCount: 1,
      rows: [{ left: '著作权人', right: '授权公司', rv: [], lvOcr: [] }]
    }) + ')');
    t(!b4.exists, '没有任何证据 ⇒ 不渲染（避免每个页面都多一行红字）', JSON.stringify(b4));

    /* B5 重画幂等：同样内容再画一次，结论行不叠加 */
    const b5 = await paint({
      hasDoc: true, docCount: 1,
      rows: [{ left: '著作权人', right: '授权公司', rv: ['乙公司'], lvOcr: [] }]
    }, true);
    const b5b = await paint({
      hasDoc: true, docCount: 1,
      rows: [{ left: '著作权人', right: '授权公司', rv: ['乙公司'], lvOcr: [] }]
    }, false);
    t(b5.exists && b5b.count === 1, '重复渲染不叠加结论行', 'count=' + b5b.count);

    console.log('\n' + (failed ? ('✗ 失败 ' + failed + ' 条') : '✓ 全部通过（' + out.length + ' 条）'));
  } finally {
    try { await api.close(); } catch (e) { /* ignore */ }
    try { srv.server.close(); } catch (e) { /* ignore */ }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('脚本自身失败：', e && e.stack || e);
  process.exit(2);
});
