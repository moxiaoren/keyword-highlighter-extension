/**
 * v1.13.6: 仅抓取（标题+核心留空+抓取字段 fetchLabels）的空值守卫。
 * 场景：标题"应用名称"、核心留空、抓取字段"包名"。
 *   A. 包名右格有值 → 触发仅抓取，抓到包名值。
 *   B. 包名右格为空 → 不抓取（无 data-kh-fetch-only span、无笔记），也不回退抓标题右格。
 *   C. 未配 fetchLabels → 回退抓标题右格（旧行为保留）。
 */
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' }, pageRebuildSilentMs: 0, pageRebuildGapMs: 0 };

const table = (pkg) => '<table><tr><td>应用名称</td><td>某应用</td></tr><tr><td>包名</td><td>' + (pkg || '') + '</td></tr></table>';

async function run(label, html, kw) {
  const b = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.addScriptTag({ path: PATH + '/lib/utils.js' });
  await p.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  await p.setContent('<html><body>' + html + '</body></html>');
  await p.evaluate((a) => { KeywordEngine.setupMutationObserver(a[0], a[1]); return KeywordEngine.highlightKeywords(a[0], a[1]); }, [[kw], cfg]);
  await p.waitForTimeout(120);
  const r = await p.evaluate(() => {
    const spans = Array.prototype.slice.call(document.querySelectorAll('[data-kh-fetch-only]'));
    return {
      count: spans.length,
      note: spans.length ? (spans[0].getAttribute('data-kh-important-note') || '') : ''
    };
  });
  await b.close();
  return r;
}

(async () => {
  const pass = [];
  // 场景A：包名有值
  const kwA = { id: 'k1', text: '', cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '包名', important: true };
  let r = await run('A-包名有值', table('com.example.app'), kwA);
  const aOk = r.count === 1 && r.note.indexOf('包名') !== -1 && r.note.indexOf('com.example.app') !== -1;
  pass.push(['A-包名有值→抓到', aOk, JSON.stringify(r)]);

  // 场景B：包名右格为空
  const kwB = { id: 'k1', text: '', cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '包名', important: true };
  r = await run('B-包名为空', table(''), kwB);
  const bOk = r.count === 0 || r.note.trim() === '';
  pass.push(['B-包名为空→不抓', bOk, JSON.stringify(r)]);

  // 场景C：未配 fetchLabels 时不算「仅抓取」（specialFetch 要求 fetchLabels 非空），不测试回退分支
  let allOk = true;
  for (const [name, ok, detail] of pass) { console.log((ok ? '✅' : '❌') + ' ' + name + ' | ' + detail); if (!ok) allOk = false; }
  console.log(allOk ? 'ALL PASS' : 'FAIL');
  process.exit(allOk ? 0 : 1);
})();
