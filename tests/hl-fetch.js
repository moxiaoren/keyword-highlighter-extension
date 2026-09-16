// v1.13.4 抓取字段修复回归：
//  A 普通词(无标题)+fetchLabels      HTML 表格
//  B 仅抓取(核心留空)+fetchLabels     HTML 表格
//  C 普通词(无标题)+fetchLabels      假表格(div/flex)
//  D 仅抓取(核心留空)+fetchLabels    假表格(div/flex)
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });

  const HTML_TBL = `<table id="t"><tr><td>应用名称</td><td>抖音</td></tr><tr><td>开发者</td><td>某公司</td></tr><tr><td>地址</td><td>北京</td></tr></table>`;
  const FAKE_TBL = `<div class="frow"><span>应用名称</span><span>抖音</span></div><div class="frow"><span>开发者</span><span>某公司</span></div><div class="frow"><span>地址</span><span>北京</span></div>`;

  // A: HTML 普通词 抖音 + fetchLabels=地址
  await page.setContent(`<!doctype html><html><body>${HTML_TBL}</body></html>`);
  await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [[{ id: 'A', text: '抖音', enabled: true, fetchLabels: '地址' }], cfg]);
  const A = await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'A').map(h => h.importantNote || '').join(''));
  console.log('A HTML 普通词+fetchLabels:', A ? '✅' : '❌', A.includes('北京') ? '(含 北京)' : '');

  // B: HTML 仅抓取 标题应用名称 核心留空 + fetchLabels=开发者
  await page.setContent(`<!doctype html><html><body>${HTML_TBL}</body></html>`);
  await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [[{ id: 'B', text: '', enabled: true, important: true, cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '开发者' }], cfg]);
  const B = await page.evaluate(() => { const s = document.querySelector('[data-kh-fetch-only]'); return s ? (s.getAttribute('data-kh-important-note') || '') : ''; });
  console.log('B HTML 仅抓取按标签:', B ? '✅' : '❌', B.includes('某公司') ? '(含 某公司)' : '');

  // C: 假表格 普通词 抖音 + fetchLabels=地址
  await page.setContent(`<!doctype html><html><body>${FAKE_TBL}</body></html>`);
  await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [[{ id: 'C', text: '抖音', enabled: true, fetchLabels: '地址' }], cfg]);
  const C = await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'C').map(h => h.importantNote || '').join(''));
  console.log('C 假表格 普通词+fetchLabels:', C ? '✅' : '❌', C.includes('北京') ? '(含 北京)' : '');

  // D: 假表格 仅抓取 标题应用名称 核心留空 + fetchLabels=开发者
  await page.setContent(`<!doctype html><html><body>${FAKE_TBL}</body></html>`);
  await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [[{ id: 'D', text: '', enabled: true, important: true, cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '开发者' }], cfg]);
  const D = await page.evaluate(() => { const s = document.querySelector('[data-kh-fetch-only]'); return s ? (s.getAttribute('data-kh-important-note') || '') : ''; });
  console.log('D 假表格 仅抓取按标签:', D ? '✅' : '❌', D.includes('某公司') ? '(含 某公司)' : '');

  const pass = A.includes('北京') && B.includes('某公司') && C.includes('北京') && D.includes('某公司');
  console.log(pass ? '✅ 抓取字段（HTML+假表格 × 普通词+仅抓取）全部通过' : '❌ 存在未通过项');
  await browser.close();
  process.exit(pass ? 0 : 2);
})().catch(e => { console.error(e); process.exit(2); });
