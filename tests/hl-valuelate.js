// v1.13.1 值后到回归：初始右格空→异步填充真实值→组合词应命中
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <table id="tbl"><tr><td>审核状态</td><td id="right"></td></tr></table>
  </body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });

  const cfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
  const kw = [{ id: 'c5', text: '不通过', enabled: true, important: true, importantNote: 'x', cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include' }];

  // 打桩
  await page.evaluate(() => {
    window.__L = [];
    const log = (m) => window.__L.push(m);
    // v1.13.9: incrementalHighlight 已废弃（v1.13.5 整页重建不再调用），不再打桩。
    const origText = KeywordEngine._highlightTextNode.bind(KeywordEngine);
    KeywordEngine._highlightTextNode = function (tn, c, cfg2, vj) { log('textNode=' + (tn.nodeValue || '').slice(0, 10)); return origText.apply(this, arguments); };
    const origPass = KeywordEngine.cellVerifyPass.bind(KeywordEngine);
    KeywordEngine.cellVerifyPass = function (tn, m, kwk) { const r = origPass.apply(this, arguments); log('cellVerifyPass(' + (m && m[0]) + ')=' + r); return r; };
  });

  await page.evaluate((args) => {
    const [k, c] = args;
    KeywordEngine.setupMutationObserver(k, c);
    return '__inject';
  }, [kw, cfg]);
  await page.evaluate((args) => {
    const [k, c] = args;
    return KeywordEngine.highlightKeywords(k, c);
  }, [kw, cfg]);
  console.log('init ok');
  console.log('初始 snap:', JSON.stringify(await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'c5').length)));

  await page.evaluate(() => { document.getElementById('right').textContent = '审核不通过'; });
  console.log('已填右格，等待 mutation...');
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'c5').length);
  console.log('值后到 snap len:', after);
  console.log('--- 日志 ---');
  const logs = await page.evaluate(() => window.__L);
  console.log(logs.join('\n'));
  console.log(after ? '✅ 命中' : '❌ 未命中');
  await browser.close();
  process.exit(after ? 0 : 2);
})().catch(e => { console.error(e); process.exit(2); });
