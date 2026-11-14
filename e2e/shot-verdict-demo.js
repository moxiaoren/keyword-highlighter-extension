#!/usr/bin/env node
'use strict';
/* 演示用截图（随 e2e 入仓，打包时排除 e2e/）：真浏览器里造两张抓取卡片，画上三态标记，只截这块区域。
 * 一张卡一张表：decorateChecks 一次只处理容器里的第一张表，塞两张会让第二张画不到。
 * 默认落到 e2e/_out/verdict-states.png（不进仓）；喂演示页时用 KH_SHOT_OUT 指到 docs/demo/img。
 * zoom 1.35 是为了截图更清楚，演示页按 1x 展示。
 * 用法：node e2e/shot-verdict-demo.js
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./harness');
const server = require('./server');

const OUT = process.env.KH_SHOT_OUT || path.resolve(__dirname, '_out', 'verdict-states.png');

(async () => {
  const srv = await server.start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context } = api;
  let code = 0;
  try {
    const page = await context.newPage();
    await page.goto(srv.origin + '/hidden-hit.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });

    await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.id = 'e2e-shot';
      wrap.style.cssText = 'position:fixed;left:16px;top:16px;width:520px;background:#fff;padding:10px 12px 16px;' +
        'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;zoom:1.35;z-index:2147483647';
      const card = (id, cap, rows) => {
        const box = document.createElement('div');
        box.id = id;
        box.setAttribute('data-shot', '1');
        box.innerHTML = '<div style="margin:12px 0 6px;font-size:12px;color:#64748b">' + cap + '</div>' +
          '<table class="kh-table kh-table-fetch"><tbody>' + rows.map((r) =>
            '<tr><td class="kh-table-label">' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') +
          '</tbody></table>';
        wrap.appendChild(box);
      };
      card('e2e-shot-a', '① 有「开发者」信息：企业名称与开发者同值 / 承诺对象是白名单外的平台', [
        ['开发者', '北京知行灵动科技有限公司'],
        ['企业名称', '北京知行灵动科技有限公司'],
        ['承诺对象', '华为技术有限公司']
      ]);
      card('e2e-shot-b', '② 缺「开发者」信息：判不了，不涂色但留标记', [
        ['企业名称', '北京知行灵动科技有限公司']
      ]);
      document.body.appendChild(wrap);
    });

    const cdp = await context.newCDPSession(page);
    let extCtx = 0;
    cdp.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.origin && String(c.origin).indexOf('chrome-extension://') === 0) extCtx = c.id;
    });
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 80 && !extCtx; i++) await page.waitForTimeout(100);
    if (!extCtx) throw new Error('找不到内容脚本所在的扩展隔离世界');
    const r = await cdp.send('Runtime.evaluate', {
      expression: '(function(){var bs=document.querySelectorAll("[data-shot]");' +
        'for(var i=0;i<bs.length;i++){window.KH.ImportantNote.panel.decorateChecks(bs[i],{});}return bs.length;})()',
      contextId: extCtx, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('扩展世界抛错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));

    const box = await page.evaluate(() => {
      const b = document.getElementById('e2e-shot').getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, clip: box });
    console.log('✓ ' + OUT + '  ' + Math.round(box.width) + 'x' + Math.round(box.height));
    await page.close();
  } catch (e) {
    code = 1;
    console.error('✗ ' + (e && e.message || e));
  } finally {
    try { await api.close(); } catch (e) { /* ignore */ }
    try { await srv.close(); } catch (e) { /* ignore */ }
  }
  process.exit(code);
})();