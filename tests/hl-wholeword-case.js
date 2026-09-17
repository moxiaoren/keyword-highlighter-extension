/*
 * v1.14.0 需求3复现：普通词 关键字 A|B|C + 勾选 区分大小写/全词/正则
 * 用户案例：原句「Bug修改」（B 为 Bug 的一部分，全词不该命中）；「A+」（评估 A 是否命中）
 *
 * 运行：node tests/hl-wholeword-case.js
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

  await page.evaluate(() => {
    window.__hits = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && !m.combo)
      .map(m => m.textNode.nodeValue.slice(m.start, m.end));
    window.__hlCount = () => document.querySelectorAll('::highlight(kh-*)').length;
  });

  // 构造关键词：A|B|C，三种匹配方式全勾
  const kw = {
    id: 'abc',
    text: 'A|B|C',
    enabled: true,
    useRegex: true,
    caseSensitive: true,
    wholeWord: true
  };
  const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };

  // ===== 用例：原文「Bug修改」 → B 不该命中（B 是 Bug 词汇的一部分）=====
  await page.evaluate(async ({ kw, cfg }) => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = 'Bug修改'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords([kw], cfg);
  }, { kw, cfg });
  const hBug = await page.evaluate(() => window.__hits('abc'));
  check('「Bug修改」：全词下 B 不命中（Bug 是整体词）', hBug.length === 0 || !hBug.includes('B'), hBug);

  // ===== 用例：原文「A+」 → 观察 A 是否命中 =====
  await page.evaluate(async ({ kw, cfg }) => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = 'A+'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords([kw], cfg);
  }, { kw, cfg });
  const hA = await page.evaluate(() => window.__hits('abc'));
  check('「A+」：A 是否命中（当前行为观察，供评估）', true, { hits: hA });

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
})();
