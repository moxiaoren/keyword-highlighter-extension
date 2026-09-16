/**
 * v1.13.7: 仅抓取（标题"应用名称" + 核心留空 + 抓取字段"包名"）的判定逻辑，按用户澄清分离：
 *   ① 触发判据 = 标题词(应用名称)右侧是否有内容；标题右格没内容 → 不抓取。
 *   ② 抓取内容 = 按 fetchLabels(包名) 找标签右邻；包名右格有值 → 展示表格「包名 | 内容」；
 *      包名右格为空 → 抓取不到，不显示（不回退抓标题右格）。
 * 场景：
 *   A. 标题右格有内容 + 包名有值 → 触发，展示 包名|com.example.app
 *   B. 标题右格为空           → 不触发（无 data-kh-fetch-only）
 *   D. 标题右格有内容 + 包名空 → 触发但抓不到 → 不显示（count 0）
 */
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' }, pageRebuildSilentMs: 0, pageRebuildGapMs: 0 };

const table = (title, pkg) => '<table><tr><td>应用名称</td><td>' + (title || '') + '</td></tr><tr><td>包名</td><td>' + (pkg || '') + '</td></tr></table>';

async function run(html, kw) {
  const b = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.addScriptTag({ path: PATH + '/lib/utils.js' });
  await p.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  await p.setContent('<html><body>' + html + '</body></html>');
  await p.evaluate((a) => { KeywordEngine.setupMutationObserver(a[0], a[1]); return KeywordEngine.highlightKeywords(a[0], a[1]); }, [[kw], cfg]);
  await p.waitForTimeout(120);
  const r = await p.evaluate(() => {
    const spans = Array.prototype.slice.call(document.querySelectorAll('[data-kh-fetch-only]'));
    return { count: spans.length, note: spans.length ? (spans[0].getAttribute('data-kh-important-note') || '') : '' };
  });
  await b.close();
  return r;
}

(async () => {
  const pass = [];
  const kwA = { id: 'k1', text: '', cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '包名', important: true };
  // A: 标题右格有内容 + 包名有值
  let r = await run(table('某应用', 'com.example.app'), kwA);
  const aOk = r.count === 1 && r.note.indexOf('包名') !== -1 && r.note.indexOf('com.example.app') !== -1;
  pass.push(['A 标题右格有内容+包名有值 → 抓包名表格', aOk, JSON.stringify(r)]);

  // B: 标题右格为空 → 不触发
  r = await run(table('', 'com.example.app'), kwA);
  const bOk = r.count === 0;
  pass.push(['B 标题右格为空 → 不抓', bOk, JSON.stringify(r)]);

  // D: 标题右格有内容 + 包名右格空 → 触发但抓不到 → 不显示
  r = await run(table('某应用', ''), kwA);
  const dOk = r.count === 0;
  pass.push(['D 标题右格有内容+包名空 → 不显示', dOk, JSON.stringify(r)]);

  let allOk = true;
  for (const [name, ok, detail] of pass) { console.log((ok ? '✅' : '❌') + ' ' + name + ' | ' + detail); if (!ok) allOk = false; }
  console.log(allOk ? 'ALL PASS' : 'FAIL');
  process.exit(allOk ? 0 : 1);
})();
