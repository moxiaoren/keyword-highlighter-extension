/* e2e/shot-dark.js — 2.0.8.13 深色主题实拍（需求④）
 *
 * 目的：证明"设置页/弹窗/笔记面板"三处都能真的变深，而不是只有令牌表好看。
 * 做法：同一个未打包扩展、同一台浏览器 —— 只改 storage 里的 uiTheme，再逐页截图。
 * 产出：docs/ui-v3/audit/2026-11-08/dark/{options-default,popup,welcome,content-panel}.png
 *
 * 用法：node e2e/shot-dark.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./harness');
const server = require('./server');

const OUT = path.join(__dirname, '..', '..', '..', 'docs', 'ui-v3', 'audit', '2026-11-08', 'dark');

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name + '.png');
  for (let i = 0; i < 3; i++) {
    try {
      await page.screenshot({ path: file, animations: 'allow', caret: 'hide', timeout: 5000 });
      console.log('  ✓ ' + name + '.png');
      return;
    } catch (e) {
      if (i === 2) { console.log('  ✗ ' + name + ' 截图失败：' + e.message); return; }
      await page.waitForTimeout(300);
    }
  }
}

(async () => {
  const dir = path.join(__dirname, '..');
  const api = await harness.launch({ extensionDir: dir });
  const srv = await server.start(0);
  try {
    /* 深色 + 跟系统都试：这里用显式 dark（auto 在 CI 机器上取不到系统偏好）。
     * 注意 setConfig 会**整份替换**配置：必须带上 test-config 的基准，否则面板没有笔记可渲染。 */
    const base = require('./test-config');
    const cfg = Object.assign({}, base.CONFIG || {}, { uiTheme: 'dark' });
    await api.setConfig(cfg);

    /* ① 设置页 */
    const opt = await api.extensionPage('options/options.html');
    await opt.waitForSelector('#kw-table', { timeout: 15000 });
    await opt.waitForTimeout(700);
    const themed = await opt.evaluate(() => document.documentElement.getAttribute('data-kh-theme'));
    console.log('设置页 data-kh-theme=' + themed + ' · 下拉=' + await opt.$eval('#ui-theme', (e) => e.value));
    await shot(opt, 'options-default');

    /* ② 弹窗 */
    const pop = await api.extensionPage('popup/popup.html');
    await pop.waitForTimeout(600);
    await shot(pop, 'popup');

    /* ③ 欢迎页 */
    const wel = await api.extensionPage('welcome/welcome.html');
    await wel.waitForTimeout(600);
    await shot(wel, 'welcome');

    /* ④ 笔记面板（content 场景）：就绪信号＝文档根上的 data-kh-state */
    const page = await api.context.newPage();
    await page.setViewportSize({ width: 1256, height: 808 });
    await page.goto(srv.origin + '/list.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
    await page.waitForTimeout(900);
    const host = await page.evaluate(() => {
      const h = document.querySelector('[data-kh-ext-ui]') || document.querySelector('#kh-important-note');
      return h ? (h.id || '(host)') + '=' + String(h.getAttribute('data-kh-theme')) : '(no host)';
    });
    console.log('笔记面板 host data-kh-theme=' + host);
    await shot(page, 'content-panel');
    await page.close();
  } finally {
    if (typeof srv.close === 'function') await srv.close().catch(() => {});
    else if (typeof srv.stop === 'function') await srv.stop();
    await api.close().catch(() => {});
  }
})().catch((e) => { console.error('✗ ' + (e && e.message)); process.exitCode = 1; });
