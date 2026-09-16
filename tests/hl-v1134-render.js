// 贴近真实：setupMutationObserver + 重要笔记面板，多行相同组合词，多次「相同重渲染 + 值改后改回」混合操作
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
function rows(v, n) { let h = '<table><tbody>'; for (let i = 0; i < n; i++) { h += `<tr><td>审核状态</td><td>${v}</td></tr>`; } return h + '</tbody></table>'; }
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  await page.addScriptTag({ path: PATH + '/content/important-note.js' });
  const kw = { id: 'c5', text: '审核不通过', enabled: true, important: true, importantNote: '审核不通过说明', cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include' };
  await page.setContent(`<!doctype html><html><body>${rows('审核不通过', 4)}</body></html>`);
  await page.evaluate(() => ImportantNote.init({}));
  await page.evaluate((a) => { KeywordEngine.setupMutationObserver(a[0], a[1]); KeywordEngine.highlightKeywords(a[0], a[1]); }, [[kw], cfg]);
  const report = () => page.evaluate(() => ({
    alive: KeywordEngine._plainHits.filter(x => x.combo && document.contains(x.textNode)).length,
    dead: KeywordEngine._plainHits.filter(x => x.combo && !document.contains(x.textNode)).length,
    imp: KeywordEngine.getImportantPlainHits().length,
    panel: (ImportantNote.items || []).length
  }));

  let lost = false, seq = 1;
  const ops = [
    () => page.evaluate(x => { document.querySelector('table').innerHTML = x; }, rows('审核不通过', 4)), // 相同重渲染
    () => page.evaluate(x => { document.querySelector('table').innerHTML = x; }, rows('审核中', 4)),      // 改值
    () => page.evaluate(x => { document.querySelector('table').innerHTML = x; }, rows('审核不通过', 4)), // 改回
    () => page.evaluate(x => { document.querySelector('table').innerHTML = x; }, rows('审核不通过', 4))   // 相同重渲染
  ];
  console.log('初始', JSON.stringify(await report()));
  for (let iter = 1; iter <= 12; iter++) {
    const opIdx = (iter - 1) % ops.length;
    await ops[opIdx]();
    await page.waitForTimeout(450);
    const st = await report();
    // opIdx=1 是“审核中”内容 → 不应命中；其余是“审核不通过” → 必须 4 行全部恢复
    const expect = (opIdx === 1) ? 0 : 4;
    const ok = st.alive === expect && st.imp === expect && st.dead === 0;
    if (!ok) { lost = true; console.log(`iter${iter}(op${opIdx}): ${JSON.stringify(st)} 期望${expect} ❌`); }
    else console.log(`iter${iter}(op${opIdx}): alive=${st.alive} imp=${st.imp} dead=${st.dead} ✅`);
  }
  console.log(lost ? '❌ 复现丢失' : '✅ 12 次混合操作组合词/重要笔记均恢复');
  await browser.close();
  process.exit(lost ? 3 : 0);
})().catch(e => { console.error(e); process.exit(2); });
