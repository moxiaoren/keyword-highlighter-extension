// v1.13.3 回归：提交/刷新【复用同一 cell，值变化后再改回】组合词应重新命中。
// 场景还原：首次「审核状态→审核不通过」命中；提交把右格改「审核中」(组合词临时不匹配)；
// 再次提交改回「审核不通过」——此时组合词应恢复高亮+重要笔记。
// 修复前：命中后的 _cellVerified 缓存 + hasResidualMarks 依赖文本节点是否在树内(脱离即漏判)，
//         → 改回后走增量(文本节点被跳过)不重扫 → 组合词永久丢失(残留命中的文本节点已脱离)。
// 修复后：①组合词命中所属行(rowRef)让 hasResidualMarks 按行识别 → 内容变化触发整行先清后建重验；
//         ②markDone 失效检测兜底。
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <table id="tbl"><tr><td>审核状态</td><td id="right">审核不通过</td></tr></table>
  </body></html>`);
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });

  const cfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
  const kw = [{ id: 'c5', text: '不通过', enabled: true, important: true, importantNote: '审核不通过说明', cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include' }];

  await page.evaluate((args) => { const [k, c] = args; KeywordEngine.setupMutationObserver(k, c); return 1; }, [kw, cfg]);
  await page.evaluate((args) => { const [k, c] = args; return KeywordEngine.highlightKeywords(k, c); }, [kw, cfg]);

  const snap = () => page.evaluate(() => {
    const hits = KeywordEngine.getPlainHits().filter(h => String(h.kwId) === 'c5');
    return { len: hits.length, imp: hits.filter(h => h.important).length, tnAlive: hits.every(h => !!(h.textNode && h.textNode.parentNode)) };
  });

  const first = await snap();
  console.log('首次命中:', JSON.stringify(first));

  // 提交①：右格改为「审核中」（组合词临时不匹配）
  await page.evaluate(() => { document.getElementById('right').textContent = '审核中'; });
  await page.waitForTimeout(1100);
  const mid = await snap();
  console.log('改「审核中」后:', JSON.stringify(mid));

  // 提交②：改回「审核不通过」（组合词应恢复）
  await page.evaluate(() => { document.getElementById('right').textContent = '审核不通过'; });
  await page.waitForTimeout(1100);
  const after = await snap();
  console.log('改回「审核不通过」后:', JSON.stringify(after));

  const ok = after.len > 0 && after.imp > 0 && after.tnAlive;
  console.log(ok ? '  ✅ 值改回后组合词重新命中（高亮+重要笔记存活）' : '  ❌ 值改回后组合词丢失');
  await browser.close();
  process.exit(ok ? 0 : 2);
})().catch(e => { console.error(e); process.exit(2); });
