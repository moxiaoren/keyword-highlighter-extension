#!/usr/bin/env node
'use strict';
/* 走查探针（随 e2e 入仓，打包时排除 e2e/）：一次真浏览器会话里实测三件事
 * ① 有没有首启引导页（真访问 chrome-extension://<id>/welcome/welcome.html）
 * ② 判定底色到底怎么落进 DOM（计算样式/伪元素/子图标/文字），并算 WCAG 对比度
 * ③ 判定的「证据」在界面上能拿到什么（悬停文案 / 有没有可点的来源）
 * 用法：node e2e/probe-review.js
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./harness');
const server = require('./server');

const PAINT = (cases) => {
  const P = window.KH.ImportantNote.panel;
  const NC = window.KH.NoteCheck;
  P.ensure(document);
  const root = P.root;
  root.hidden = false;
  let host = root.querySelector('#e2e-probe');
  if (!host) {
    host = document.createElement('div');
    host.id = 'e2e-probe';
    host.style.cssText = 'position:fixed;left:0;top:0;width:560px;padding:18px;background:#fff;' +
      'font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;z-index:2147483647';
    root.appendChild(host);
  }
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    host.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      c.rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') +
      '</tbody></table>';
    const table = host.querySelector('table');
    let callErr = '';
    try { P.paintAuto(table, { dev: c.dev || '' }, NC); } catch (e) { callErr = String(e && e.message || e); }
    const rows = [];
    const trs = table.querySelectorAll('tr');
    for (let j = 0; j < trs.length; j++) {
      const tr = trs[j];
      const tds = tr.querySelectorAll('td');
      const cs = (td) => getComputedStyle(td);
      const before = (td) => { const b = getComputedStyle(td, '::before'); return (b && b.content) || ''; };
      rows.push({
        label: tds[0] ? tds[0].textContent.trim() : '',
        value: tds[1] ? tds[1].textContent.trim() : '',
        bg: tds[0] ? cs(tds[0]).backgroundColor : '',
        bg2: tds[1] ? cs(tds[1]).backgroundColor : '',
        fg: tds[1] ? cs(tds[1]).color : '',
        before: tds[0] ? before(tds[0]) : '',
        kids: tds[1] ? tds[1].querySelectorAll('img,svg,i,.kh-ico,[class*=icon],[class*=badge],[class*=tag]').length : 0,
        tip: tds[0] ? (tds[0].title || '') : '',
        tip2: tds[1] ? (tds[1].title || '') : '',
        sig: tr.getAttribute('data-kh-auto-sig') || ''
      });
    }
    out.push({ name: c.name, callErr, rows });
  }
  /* 面板上还有哪些可点的东西（找「来源/证据」类入口） */
  const all = root.querySelectorAll('button,a,[role=button],.btn,[class*=btn]');
  const clickable = [];
  for (let i = 0; i < all.length && clickable.length < 40; i++) {
    const t = String(all[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (t) clickable.push(t.slice(0, 24));
  }
  const evid = [];
  const txt = root.querySelectorAll('*');
  for (let i = 0; i < txt.length; i++) {
    const t = String(txt[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 60 && /证据|来源|命中原文|抓取时间|查看原文/.test(t)) evid.push(t.slice(0, 60));
    if (evid.length > 12) break;
  }
  return {
    cases: out,
    colors: { OK: NC.COLOR_OK, BAD: NC.COLOR_BAD },
    panelClickables: clickable,
    evidenceishText: evid,
    hasQual: typeof NC.qualVerdict === 'function',
    hasPromise: typeof NC.promiseVerdict === 'function'
  };
};

/* WCAG 相对亮度 / 对比度 */
function lum(rgb) {
  const m = String(rgb).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  const f = (v) => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

(async () => {
  const srv = await server.start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context } = api;
  const report = { at: new Date().toISOString(), welcome: {}, options: {}, paint: null, contrast: null, errors: [] };
  try {
    /* 扩展 id：只认 background 的 service worker */
    let id = '';
    for (let i = 0; i < 80 && !id; i++) {
      const sws = context.serviceWorkers();
      for (const sw of sws) {
        const m = String(sw.url()).match(/^chrome-extension:\/\/([a-p]+)\//);
        if (m && String(sw.url()).indexOf('service-worker') >= 0) { id = m[1]; break; }
      }
      if (!id) await new Promise((r) => setTimeout(r, 250));
    }
    report.extId = id;

    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 1000 });

    /* ① 首启引导页 */
    if (id) {
      try {
        const resp = await page.goto('chrome-extension://' + id + '/welcome/welcome.html', { waitUntil: 'load', timeout: 15000 });
        report.welcome = {
          url: page.url(),
          status: resp ? resp.status() : null,
          title: await page.title().catch(() => ''),
          bodyText: (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 300),
          nodeCount: await page.evaluate(() => document.querySelectorAll('*').length).catch(() => -1)
        };
      } catch (e) {
        report.welcome = { error: String(e && e.message || e) };
      }
      try {
        await page.goto('chrome-extension://' + id + '/options/options.html', { waitUntil: 'load', timeout: 20000 });
        report.options = {
          title: await page.title().catch(() => ''),
          textLen: (await page.evaluate(() => document.body ? document.body.innerText.length : 0)).slice ? 0 : 0
        };
        report.options.textLen = await page.evaluate(() => document.body.innerText.length).catch(() => -1);
      } catch (e) { report.options = { error: String(e && e.message || e) }; }
    }

    /* ②③ 判定上色 + 证据：真内容页里的隔离世界 */
    await page.goto(srv.origin + '/hidden-hit.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
    const cdp = await context.newCDPSession(page);
    let extCtx = 0;
    cdp.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.origin && String(c.origin).indexOf('chrome-extension://') === 0) extCtx = c.id;
    });
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 80 && !extCtx; i++) await page.waitForTimeout(100);

    const cases = [
      { name: '企业名称与开发者一致', dev: '某某科技有限公司', rows: [['企业名称', '某某科技有限公司']] },
      { name: '企业名称与开发者不一致', dev: '某某科技有限公司', rows: [['企业名称', '别的网络科技有限公司']] },
      { name: '承诺对象取泛称', dev: '', rows: [['承诺对象', 'vivo 手机（含 iQOO）']] },
      { name: '承诺对象为空', dev: '', rows: [['承诺对象', '']] }
    ];
    const r = await cdp.send('Runtime.evaluate', {
      expression: '(' + PAINT.toString() + ')(' + JSON.stringify(cases) + ')',
      contextId: extCtx, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      report.errors.push('扩展世界抛错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    } else {
      report.paint = r.result.value;
      const cs = r.result.value.cases || [];
      report.contrast = cs.map((c) => ({
        name: c.name,
        rows: (c.rows || []).map((row) => ({
          label: row.label, bg: row.bg, fg: row.fg,
          fgOnBg: ratio(row.fg, row.bg),
          bgOnWhite: ratio(row.bg, 'rgb(255,255,255)'),
          bgOnPageWhite: ratio(row.bg, 'rgb(255,255,255)')
        }))
      }));
    }
    await page.close();
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    try { await api.browser.close(); } catch (e) { /* ignore */ }
    try { if (api.proc) api.proc.kill(); } catch (e) { /* ignore */ }
    try { srv.close && srv.close(); } catch (e) { /* ignore */ }
  }
  fs.mkdirSync(path.join(__dirname, '_out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '_out', 'review-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})();
