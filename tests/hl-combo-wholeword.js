/*
 * v1.14.0 需求③深入排查：组合词 核心词/标题词 正则含 | 时是否无全词边界
 *
 * 运行：node tests/hl-combo-wholeword.js
 */
const PATH = require('path');
const { chromium } = require('/tmp/pw/node_modules/playwright');
const CHROME = '/opt/chrome-linux/chrome';
const REPO = PATH.resolve(__dirname, '..');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  → ' + JSON.stringify(detail) : ''));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/utils.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/rare-char.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/keyword-engine.js') });
  const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };

  await page.evaluate(() => {
    window.__comboHits = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && m.combo)
      .map(m => m.textNode.nodeValue.slice(m.start, m.end));
    window.__plainHits = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && !m.combo)
      .map(m => m.textNode.nodeValue.slice(m.start, m.end));
  });

  // ===== 场景1：组合词，核心词=正则 A|B|C，右格文本「Bug修改」，未勾全词(非exact) =====
  // 预期当前实现：cellVerifyPass 用裸正则 /A|B|C/i.test('Bug修改') → B 命中（无全词边界）→ 缺陷
  await page.evaluate(async ({ cfg }) => {
    document.body.innerHTML = '';
    const tb = document.createElement('table');
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = '应用名称';
    const td2 = document.createElement('td'); td2.textContent = 'Bug修改';
    tr.appendChild(td1); tr.appendChild(td2);
    const tbody = document.createElement('tbody'); tbody.appendChild(tr);
    tb.appendChild(tbody);
    document.body.appendChild(tb);
    await KeywordEngine.highlightKeywords([{
      id: 'c1', text: 'A|B|C', cellVerify: '应用名称', cellVerifyEnabled: true,
      useRegex: true, caseSensitive: true, wholeWord: false, enabled: true
    }], cfg);
  }, { cfg });
  const ch1 = await page.evaluate(() => window.__comboHits('c1'));
  check('组合词核心词 正则A|B|C + 右格"Bug修改" 未勾全词 → B是否裸命中(观察)', true, ch1);

  // ===== 场景2：同一组合词，勾了全词(wholeWord=true → 核心词 exact 整格) =====
  await page.evaluate(async ({ cfg }) => {
    document.body.innerHTML = '';
    const tb = document.createElement('table');
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = '应用名称';
    const td2 = document.createElement('td'); td2.textContent = 'Bug修改';
    tr.appendChild(td1); tr.appendChild(td2);
    const tbody = document.createElement('tbody'); tbody.appendChild(tr);
    tb.appendChild(tbody);
    document.body.appendChild(tb);
    await KeywordEngine.highlightKeywords([{
      id: 'c2', text: 'A|B|C', cellVerify: '应用名称', cellVerifyEnabled: true,
      useRegex: true, caseSensitive: true, wholeWord: true, enabled: true
    }], cfg);
  }, { cfg });
  const ch2 = await page.evaluate(() => window.__comboHits('c2'));
  check('组合词核心词 全词→整格equal 右格"Bug修改"→不命中', ch2.length === 0, ch2);

  // ===== 场景3：普通词 A|B|C 全词+正则，页面纯文本「Bug修改」→ B 不命中（应正确）=====
  await page.evaluate(async ({ cfg }) => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = 'Bug修改'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords([{ id: 'p1', text: 'A|B|C', useRegex: true, caseSensitive: true, wholeWord: true, enabled: true }], cfg);
  }, { cfg });
  const ph1 = await page.evaluate(() => window.__plainHits('p1'));
  check('普通词 A|B|C 全词 → 纯文本"Bug修改" B不命中（v1.13.8已正确）', ph1.length === 0 || !ph1.includes('B'), ph1);

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + '/' + results.length);
  process.exit(failed.length ? 1 : 0);
})();
