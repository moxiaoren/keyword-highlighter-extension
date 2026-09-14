/**
 * v1.10.9-b1 专项复现：验证「先高亮后消失」已修复。
 * 复现 1.10.8 的 bug 时间线：
 *  ① 页面初始渲染并高亮（用户看到高亮）
 *  ② 触发列表刷新：先移除旧节点(触发容器级重建)，再异步插入新节点(触发增量)
 *  ③ 断言：刷新后高亮仍然存在、且为正确内容（不消失）
 * 用法：PW_PLAYWRIGHT_PATH=... node tests/vanishing-repro.js [engine.js]
 */
const FS = require('fs');
const PATH = require('path');
const enginePathArg = process.argv[2];
const REPO = PATH.join(__dirname, '..');
const ENGINE = enginePathArg ? PATH.resolve(enginePathArg) : PATH.join(REPO, 'lib', 'keyword-engine.js');
const UTILS = PATH.join(REPO, 'lib', 'utils.js');
const PW = process.env.PW_PLAYWRIGHT_PATH || '/tmp/pw/node_modules/playwright';
const { chromium } = require(PW);

const SIMPLE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="app">
  <table id="tbl"><tbody id="tbody"></tbody></table>
</div>
<script>
window.refreshList = function(cb){
  var tb = document.getElementById('tbody');
  while (tb.firstChild) tb.removeChild(tb.firstChild);
  setTimeout(function(){
    var rows = ['刚需应用','是','网盘应用','否','输入法应用','是'];
    for (var i=0;i<rows.length;i+=2){
      var tr=document.createElement('tr');
      var a=document.createElement('td'); a.textContent=rows[i]; tr.appendChild(a);
      var b=document.createElement('td'); b.textContent=rows[i+1]; tr.appendChild(b);
      tb.appendChild(tr);
    }
    cb();
  }, 100);
};
window.__hits = function(){ return document.querySelectorAll('[data-kh-cell-verify-hi-span],[data-kh-highlighted]').length; };
window.__titles = function(){
  var out=[];
  document.querySelectorAll('tr').forEach(function(tr){
    if (tr.querySelector('[data-kh-cell-verify-hi-span],[data-kh-highlighted]')) out.push(tr.cells[0].textContent);
  });
  return out;
};
window.__init = function(){ document.getElementById('tbody').innerHTML='';
  ['刚需应用','是','网盘应用','否'].forEach(function(v,i){ var tr=document.createElement('tr');
    var a=document.createElement('td'); a.textContent=(i%2===0?v:['','刚需应用','','网盘应用'][i]); tr.appendChild(a);
    var b=document.createElement('td'); b.textContent=(i%2===1?v:['是','','否',''][i]); tr.appendChild(b);
    document.getElementById('tbody').appendChild(tr); }); };
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message));

  await page.setContent(SIMPLE_HTML);
  await page.addScriptTag({ path: UTILS });
  await page.addScriptTag({ path: ENGINE });

  await page.evaluate(() => window.__init());
  const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ffff00', defaultTextColor: '#000' } };
  const kw = [
    { id: 'k1', text: '刚需应用', enabled: true, cellVerifyEnabled: true, cellVerify: '是', cellVerifyMatchMode: 'contain' },
    { id: 'k2', text: '网盘应用', enabled: true },
    { id: 'k3', text: '输入法应用', enabled: true }
  ];

  const run = async (label, fn) => {
    try { const r = await fn(); console.log('  ✅ ' + label + ' → ' + JSON.stringify(r)); return r; }
    catch (e) { console.log('  ❌ ' + label + ' → ' + e.message); return { err: e.message }; }
  };

  await run('初始高亮(应 2 命中)', async () => {
    await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords(kw, cfg), { kw, cfg });
    await page.waitForTimeout(400);
    return { hits: await page.evaluate(() => window.__hits()), titles: await page.evaluate(() => window.__titles()) };
  });

  await run('列表刷新(先删后插)后高亮仍存在', async () => {
    await page.evaluate(({ kw, cfg }) => { KeywordEngine.setupMutationObserver(kw, cfg); }, { kw, cfg });
    await page.evaluate(() => new Promise(res => window.refreshList(res)));
    await page.waitForTimeout(1200);
    return { hits: await page.evaluate(() => window.__hits()), titles: await page.evaluate(() => window.__titles()) };
  });

  await run('再次高频连续刷新 5 次', async () => {
    for (let i = 0; i < 5; i++) { await page.evaluate(() => new Promise(res => window.refreshList(res))); await page.waitForTimeout(450); }
    await page.waitForTimeout(1000);
    return { hits: await page.evaluate(() => window.__hits()), titles: await page.evaluate(() => window.__titles()) };
  });

  await browser.close();
  console.log('\n（hits 命中数量；消失 bug 表现为刷新后 hits=0）');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
