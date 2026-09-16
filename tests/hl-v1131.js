// v1.13.1【问题④排查】组合词多词命中只高亮一个 复现
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');

const mkCfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // 场景A：同标题不同值，两行
  await page.setContent(`<!doctype html><html><body><table id="tA">
    <tr><td>应用名称</td><td>a</td></tr>
    <tr><td>应用名称</td><td>b</td></tr></table></body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  const kwA = [
    { id: 'A1', text: 'a', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用名称', cellVerifyMatchMode: 'include' },
    { id: 'A2', text: 'b', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用名称', cellVerifyMatchMode: 'include' }
  ];
  await page.evaluate((args) => { const [k, c] = args; KeywordEngine.setupMutationObserver(k, c); return KeywordEngine.highlightKeywords(k, c); }, [kwA, mkCfg]);
  await page.waitForTimeout(200);
  const hitsA = await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId).startsWith('A')).map(h => ({ id: h.kwId, adj: h.adj, t: h.textNode.nodeValue.slice(h.start, h.end) })));
  console.log('场景A 同标题不同值(应用名称→a + 应用名称→b):', JSON.stringify(hitsA));
  console.log(hitsA.length === 2 ? '  ✅ 两个都命中' : '  ❌ 只命中 ' + hitsA.length + ' 个', '预期2(a+b)');

  // 场景B：不同标题同值，两行
  await page.setContent(`<!doctype html><html><body><table id="tB">
    <tr><td>应用名称</td><td>a</td></tr>
    <tr><td>应用标题</td><td>a</td></tr></table></body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  const kwB = [
    { id: 'B1', text: 'a', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用名称', cellVerifyMatchMode: 'include' },
    { id: 'B2', text: 'a', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用标题', cellVerifyMatchMode: 'include' }
  ];
  await page.evaluate((args) => { const [k, c] = args; KeywordEngine.setupMutationObserver(k, c); return KeywordEngine.highlightKeywords(k, c); }, [kwB, mkCfg]);
  await page.waitForTimeout(200);
  const hitsB = await page.evaluate(() => KeywordEngine.getPlainHits().filter(h => String(h.kwId).startsWith('B')).map(h => ({ id: h.kwId, adj: h.adj, t: h.textNode.nodeValue.slice(h.start, h.end), on: h.textNode.parentElement ? h.textNode.parentElement.tagName : null })));
  console.log('场景B 不同标题同值(应用名称→a + 应用标题→a):', JSON.stringify(hitsB));
  console.log(hitsB.length === 2 ? '  ✅ 两个都命中' : '  ❌ 只命中 ' + hitsB.length + ' 个', '预期2');
  // 场景C：同标题不同值，落在【同一右格】(应用名称 | a b)  → 检查命中数 + CSS.highlights range 数
  await page.setContent(`<!doctype html><html><body><table id="tC">
    <tr><td>应用名称</td><td>a b</td></tr></table></body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  const kwC = [
    { id: 'C1', text: 'a', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用名称', cellVerifyMatchMode: 'include' },
    { id: 'C2', text: 'b', enabled: true, important: true, importantNote: '你好', cellVerifyEnabled: true, cellVerify: '应用名称', cellVerifyMatchMode: 'include' }
  ];
  await page.evaluate((args) => { const [k, c] = args; KeywordEngine.setupMutationObserver(k, c); return KeywordEngine.highlightKeywords(k, c); }, [kwC, mkCfg]);
  await page.waitForTimeout(200);
  const hitsC = await page.evaluate(() => {
    const ranges = Array.from(CSS.highlights.values()).reduce((n, hl) => n + (hl ? hl.size : 0), 0);
    return {
      hits: KeywordEngine.getPlainHits().filter(h => String(h.kwId).startsWith('C')).map(h => ({ id: h.kwId, t: h.textNode.nodeValue.slice(h.start, h.end) })),
      cssRanges: ranges
    };
  });
  console.log('场景C 同格 a b:', JSON.stringify(hitsC));
  console.log(hitsC.hits.length === 2 ? '  ✅ 两个都命中' : '  ❌ 只命中 ' + hitsC.hits.length + ' 个', '| CSS.highlights ranges=', hitsC.cssRanges);

  // 场景D：面板 refresh 聚合（用独立全新 page，避免 window 残留场景C 真实 KeywordEngine）—— 现象2 展示只显示一个
  const page2 = await browser.newPage();
  await page2.setContent('<!doctype html><html><body></body></html>');
  await page2.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page2.addScriptTag({ path: PATH + '/content/important-note.js' });
  const panel = await page2.evaluate(() => {
    const results = {};
    const run = (plainHits) => {
      const inst = Object.create(ImportantNote);
      inst.host = document.createElement('div');
      inst.ignored = new Set();
      inst.items = [];
      inst.renderContent = function () {};
      inst.show = function () {}; inst.hide = function () {};
      inst._itemsChanged = function () { return true; };
      window.KeywordEngine = { getImportantPlainHits: function () { return plainHits; } };
      inst.refresh();
      return inst.items;
    };
    const mk = (text, note, adj) => { const t = document.createTextNode(text); document.body.appendChild(t); return { text: text, note: note, adj: adj, textNode: t }; };
    results.B = run([mk('a', '你好', '应用名称'), mk('a', '你好', '应用标题')]);
    results.A = run([mk('a', '你好', '应用名称'), mk('b', '你好', '应用名称')]);
    return results;
  });
  const bEntries = panel.B && panel.B[0] ? panel.B[0].entries.map(e => e.adj).filter(Boolean) : [];
  const aEntries = panel.A && panel.A[0] ? panel.A[0].entries.map(e => e.kw) : [];
  console.log('场景D 面板聚合-B(不同标题同值) items:', JSON.stringify(panel.B));
  console.log(bEntries.length === 2 && bEntries.includes('应用名称') && bEntries.includes('应用标题') ? '  ✅ B 两个 adj 都保留' : '  ❌ B 只 ' + bEntries.length + ' 个 adj: ' + bEntries);
  console.log('场景D 面板聚合-A(同标题不同值) items:', JSON.stringify(panel.A));
  console.log(aEntries.length === 2 && aEntries.includes('a') && aEntries.includes('b') ? '  ✅ A 两个值都保留' : '  ❌ A 只 ' + aEntries.length + ' 个');
  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
