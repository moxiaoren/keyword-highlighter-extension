/* v1.50.0 UI 冒烟：关键词弹窗「上下格」组合方向 保存/回显 + 批量方向 */
const PATH = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('/tmp/pw/node_modules/playwright');
const CHROME = '/opt/chrome-linux/chrome';
const REPO = PATH.resolve(__dirname, '..');
const OPTIONS = pathToFileURL(PATH.join(REPO, 'options/options.html')).href;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__store = {};
    const st = {
      async get(keys) {
        if (keys == null) return { ...window.__store };
        const ks = Array.isArray(keys) ? keys : [keys];
        const o = {}; for (const k of ks) if (k in window.__store) o[k] = window.__store[k];
        return o;
      },
      async set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); },
      async remove(ks) { (Array.isArray(ks)?ks:[ks]).forEach(k => delete window.__store[k]); },
      async clear() { window.__store = {}; }
    };
    window.chrome = {
      runtime: { getManifest: () => ({ version: '1.14.1', manifest_version: 3 }), getURL: u => u, onMessage: { addListener(){}, removeListener(){} } },
      storage: { local: st, sync: st, onChanged: { addListener(){} } },
      tabs: { async query(){ return []; }, async sendMessage(){ return undefined; } }
    };
  });
  await page.goto(OPTIONS, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  let fails = 0;
  // 用例A：新增普通关键词弹窗，切上下格，填列/行关键词，保存
  await page.click('#btnAddKeyword');
  await page.waitForSelector('#keywordModal', { timeout: 3000 });
  // 展开单元格组合区
  await page.evaluate(() => document.getElementById('kwCellSection').classList.remove('closed'));
  await page.fill('#editKwText', '吃饭');
  await page.selectOption('#editKwComboAxis', 'tb');
  await page.fill('#editKwCellVerifyValue', '名称');
  await page.check('#editKwCaseSensitive');
  const lblCol = await page.textContent('#lblKwColKey');
  const panelTitle = await page.evaluate(() => document.querySelector('#kwCellSection .match-panel-title').textContent);
  await page.click('#keywordModalSave');
  await page.waitForTimeout(400);
  const kw = await page.evaluate(() => (window.__store.keywords || [])[0]);
  const okA = kw && kw.text === '吃饭' && kw.comboAxis === 'tb' && kw.cellVerify === '名称' && kw.caseSensitive === true;
  console.log((okA?'✅':'❌') + ` [新增-上下格] comboAxis=${kw&&kw.comboAxis} cellVerify=${kw&&kw.cellVerify} lbl='${lblCol}' panelTitle='${panelTitle}'`);
  if (!okA) fails++;

  // 用例B：编辑该词回显（应回到 tb）→ 切回左右格保存
  await page.evaluate(() => { document.querySelector(`[data-action="edit"][data-id="${ (window.__store.keywords[0]).id }"]`).click(); });
  await page.waitForTimeout(300);
  const axisVal = await page.evaluate(() => document.getElementById('editKwComboAxis').value);
  await page.selectOption('#editKwComboAxis', 'lr');
  await page.click('#keywordModalSave');
  await page.waitForTimeout(300);
  const kw2 = await page.evaluate(() => (window.__store.keywords || [])[0]);
  const okB = axisVal === 'tb' && kw2.comboAxis === 'lr';
  console.log((okB?'✅':'❌') + ` [编辑回显→切回左右] 回显axis=${axisVal} 保存后comboAxis=${kw2.comboAxis}`);
  if (!okB) fails++;

  await browser.close();
  console.log(fails ? `\n${fails} 项失败` : '\n✅ UI 冒烟全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试错误:', e); process.exit(2); });
