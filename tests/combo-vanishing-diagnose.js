/**
 * 专项定位：组合词高亮/重要笔记「首次加载丢失、切回标签页恢复」复现
 * 模拟真实动态表格：首扫(highlightKeywords) → 框架异步填充/重排。
 * 场景隔离，逐个输出命中情况。
 * 用法：PW_PLAYWRIGHT_PATH=... node tests/combo-vanishing-diagnose.js [engine.js]
 */
const FS = require('fs');
const PATH = require('path');
const enginePathArg = process.argv[2];
const REPO = PATH.join(__dirname, '..');
const ENGINE = enginePathArg ? PATH.resolve(enginePathArg) : PATH.join(REPO, 'lib', 'keyword-engine.js');
const UTILS = PATH.join(REPO, 'lib', 'utils.js');
const PW = process.env.PW_PLAYWRIGHT_PATH || '/tmp/pw/node_modules/playwright';
const { chromium } = require(PW);

const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ffff00', defaultTextColor: '#000' } };
const kw = [
  { id: 'c1', text: '是', enabled: true, cellVerifyEnabled: true, cellVerify: '刚需应用', cellVerifyMatchMode: 'contain' },
];
const comboSelector = '[data-kh-cell-verify-hi-span]';

function baseHtml() {
  return `<!doctype html><html><body>
<table id="t"><tbody id="tb"><tr><td id="l">刚需应用</td><td id="r">否</td></tr></tbody></table>
</body></html>`;
}

const scenarios = {
  // A: 首扫时右格为默认值"否"，随后 characterData 改写为"是"（模拟 nodeValue 原地改）
  a_characterData: async (page) => {
    await page.setContent(baseHtml());
    await page.evaluate(({ cfg, kw }) => KeywordEngine.highlightKeywords(kw, cfg), { cfg, kw });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.setupMutationObserver(kw, cfg), { cfg, kw });
    await page.evaluate(() => { document.getElementById('r').firstChild.nodeValue = '是'; }); // characterData
    await page.waitForTimeout(900);
    return { hits: await page.evaluate(s => document.querySelectorAll(s).length, comboSelector),
             title: await page.evaluate(() => document.querySelector('#l').textContent) };
  },
  // B: 首扫后 textContent 赋值（新增TEXT节点触发）
  b_textContent: async (page) => {
    await page.setContent(baseHtml());
    await page.evaluate(({ cfg, kw }) => KeywordEngine.highlightKeywords(kw, cfg), { cfg, kw });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.setupMutationObserver(kw, cfg), { cfg, kw });
    await page.evaluate(() => { document.getElementById('r').textContent = '是'; });
    await page.waitForTimeout(900);
    return { hits: await page.evaluate(s => document.querySelectorAll(s).length, comboSelector),
             title: await page.evaluate(() => document.querySelector('#l').textContent) };
  },
  // C: 首扫命中后，整容器(tbody)被替换重建（removedNodes+addedNodes）——模拟翻页/懒加载
  c_containerRebuild: async (page) => {
    await page.setContent(baseHtml());
    await page.evaluate(({ cfg, kw }) => KeywordEngine.highlightKeywords(kw, cfg), { cfg, kw });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.setupMutationObserver(kw, cfg), { cfg, kw });
    // 先命中
    await page.evaluate(() => { document.getElementById('r').textContent = '是'; });
    await page.waitForTimeout(700);
    const before = await page.evaluate(s => document.querySelectorAll(s).length, comboSelector);
    // 整体重建 tbody
    await page.evaluate(() => {
      const tb = document.getElementById('tb');
      const nh = document.createElement('tr');
      nh.innerHTML = '<td>刚需应用</td><td>是</td>';
      document.getElementById('t').replaceChild(nh, document.getElementById('tb').firstChild);
    });
    await page.waitForTimeout(1000);
    const after = await page.evaluate(s => document.querySelectorAll(s).length, comboSelector);
    return { before, after };
  },
  // D: 首扫时右格已是"是"，随后无关文本改变（同容器其它文本）→ 不应误清已命中的组合词
  d_otherTextChangeInContainer: async (page) => {
    await page.setContent(baseHtml());
    await page.evaluate(({ cfg, kw }) => KeywordEngine.highlightKeywords(kw, cfg), { cfg, kw });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.setupMutationObserver(kw, cfg), { cfg, kw });
    const before = await page.evaluate(s => document.querySelectorAll(s).length, comboSelector);
    await page.evaluate(() => { document.getElementById('l').textContent = '刚需应用'; }); // 左格文本变化
    await page.waitForTimeout(900);
    const after = await page.evaluate(s => document.querySelectorAll(s).length, comboSelector);
    return { before, after };
  },
  // E: 首扫时右格为空，随后填充"是"（更贴近真实：初始无值）
  e_emptyThenFill: async (page) => {
    await page.setContent(baseHtml());
    await page.evaluate(() => { document.getElementById('r').textContent = ''; });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.highlightKeywords(kw, cfg), { cfg, kw });
    await page.evaluate(({ cfg, kw }) => KeywordEngine.setupMutationObserver(kw, cfg), { cfg, kw });
    await page.evaluate(() => { document.getElementById('r').textContent = '是'; });
    await page.waitForTimeout(900);
    return { hits: await page.evaluate(s => document.querySelectorAll(s).length, comboSelector),
             title: await page.evaluate(() => document.querySelector('#l').textContent) };
  },
};

(async () => {
  console.log('引擎: ' + ENGINE);
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  for (const [name, fn] of Object.entries(scenarios)) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`  [${name}] ⚠️ pageerror: ${e.message}`));
    await page.addScriptTag({ path: UTILS });
    await page.addScriptTag({ path: ENGINE });
    try { const r = await fn(page); console.log(`  ${name}: ${JSON.stringify(r)}`); }
    catch (e) { console.log(`  ${name}: ❌ ${e.message}`); }
    await page.close();
  }
  await browser.close();
  console.log('（hits=data-kh-cell-verify-hi-span 数量；组合词命中期望=1）');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
