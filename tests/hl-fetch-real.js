// 端到端：真实 ImportantNote 面板 —— 验证普通词+fetchLabels / 仅抓取+fetchLabels 在面板实际展示
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <table id="t">
      <tr><td>应用名称</td><td>抖音</td></tr>
      <tr><td>开发者</td><td>某公司</td></tr>
      <tr><td>地址</td><td>北京</td></tr>
      <tr><td>备注</td><td>这是备注内容</td></tr>
    </table>
  </body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  await page.addScriptTag({ path: PATH + '/content/important-note.js' });

  // 普通词 A（只填关键词 抖音，配 fetchLabels=备注）+ 仅抓取 B（标题=应用名称，核心空，fetchLabels=地址）
  const kws = [
    { id: 'A', text: '抖音', enabled: true, important: false, fetchLabels: '备注' },
    { id: 'B', text: '', enabled: true, important: true, cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '地址' }
  ];
  await page.evaluate(() => ImportantNote.init({}));
  await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [kws, cfg]);
  await page.evaluate(() => ImportantNote.refresh());

  const res = await page.evaluate(() => {
    const items = ImportantNote.items || [];
    const detail = items.map(it => ({ note: (it.note || '').slice(0, 120), entries: (it.entries || []).map(e => e.adj || e.kw) }));
    const domSpans = Array.prototype.slice.call(document.querySelectorAll('[data-kh-fetch-only]'))
      .map(s => ({ text: s.textContent, note: (s.getAttribute('data-kh-important-note') || '').slice(0, 120) }));
    const plainA = KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'A')
      .map(h => ({ imp: h.important, note: (h.importantNote || '').slice(0, 120) }));
    return { items: detail, plainA, domSpans };
  });
  console.log('面板 items:', JSON.stringify(res.items, null, 1));
  console.log('普通词A getPlainHits:', JSON.stringify(res.plainA));
  console.log('仅抓取B DOM span:', JSON.stringify(res.domSpans));
  console.log('---');
  const A_ok = res.plainA.some(h => h.imp && h.note.includes('备注内容'));
  const B_ok = res.domSpans.length > 0 && res.domSpans[0].note.includes('北京');
  console.log(A_ok ? '✅ 普通词+fetchLabels 抓取进重要笔记' : '❌ 普通词+fetchLabels 未进重要笔记(抓取为空)');
  console.log(B_ok ? '✅ 仅抓取按fetchLabels(地址)抓到 北京' : '❌ 仅抓取未按fetchLabels(地址)抓(抓到别的或无)');
  await browser.close();
  process.exit(A_ok && B_ok ? 0 : 2);
})().catch(e => { console.error(e); process.exit(2); });
