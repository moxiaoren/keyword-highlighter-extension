// 验证用户假说：多个界面命中内容相同(左格 审核状态 / 右格 审核不通过)，
// 但「抓取字段(地址)」抓到的实际值不同。下一页时若被误判"已处理"则不高亮/不进重要笔记/抓取不更新。
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
function table(addr) {
  return `<table><tbody>
    <tr><td>审核状态</td><td>审核不通过</td></tr>
    <tr><td>地址</td><td>${addr}</td></tr>
  </tbody></table>`;
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  const kw = { id: 'c5', text: '审核不通过', enabled: true, important: true, importantNote: '审核不通过说明', cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include', fetchLabels: '地址' };

  const report = () => page.evaluate(() => {
    const combo = KeywordEngine._plainHits.filter(h => h.combo && document.contains(h.textNode));
    const imp = KeywordEngine.getImportantPlainHits();
    return {
      combo: combo.length,
      note: imp.map(h => (h.note || '').replace(/\u0002/g, '')).join('\n').slice(0, 160),
      addrCell: (() => { const tds = document.querySelectorAll('td'); for (let i = 0; i < tds.length; i++) if (tds[i].textContent.trim() === '地址') return tds[i].nextElementSibling ? tds[i].nextElementSibling.textContent.trim() : null; return null; })()
    };
  });

  // 场景：首页 地址=北京
  await page.setContent(`<!doctype html><html><body>${table('北京')}</body></html>`);
  await page.evaluate((a) => { KeywordEngine.setupMutationObserver(a[0], a[1]); KeywordEngine.highlightKeywords(a[0], a[1]); }, [[kw], cfg]);
  console.log('首页(地址=北京):', JSON.stringify(await report()));

  // 下一页A：只改「地址」行的值 北京→上海（右格"审核不通过"节点保持不变复用）
  await page.evaluate(() => {
    const tds = document.querySelectorAll('td');
    let addrValTd = null;
    for (let i = 0; i < tds.length; i++) { if (tds[i].textContent.trim() === '地址') { addrValTd = tds[i].nextElementSibling; } }
    addrValTd.textContent = '上海';
  });
  await page.waitForTimeout(1600);
  console.log('下一页A(仅地址→上海,复用右格):', JSON.stringify(await report()));

  // 下一页B：整表替换(新节点) 地址=广州，右格仍是 审核不通过
  await page.evaluate((h) => { document.querySelector('table').innerHTML = h; }, table('广州'));
  await page.waitForTimeout(1600);
  console.log('下一页B(整表替换,地址=广州):', JSON.stringify(await report()));

  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
