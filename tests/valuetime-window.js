/**
 * 验证根因：组合词「首次加载消失、切回正常」的时序窗口。
 * 假设：init 里 highlightKeywords(首扫) 执行时右格还是空/默认；
 * 随后页面 JS 在【observer 建立前】填充右格真实值 → 该变化不被观察 →
 * 组合词验证失败未被补救 → 缺失；而首扫时普通词内容已在 → 正常 → 只剩组合词缺。
 * 切回标签页触发 refresh→teardown+全量重扫 → 此刻表格已渲染完 → 组合词补齐。
 */
const FS = require('fs');
const PATH = require('path');
const enginePathArg = process.argv[2];
const REPO = PATH.join(__dirname, '..');
const ENGINE = enginePathArg ? PATH.resolve(enginePathArg) : PATH.join(REPO, 'lib', 'keyword-engine.js');
const PW = process.env.PW_PLAYWRIGHT_PATH || '/tmp/pw/node_modules/playwright';
const { chromium } = require(PW);

const KW = (rightVal /* '是'|'否' */) => [
  { id: 'k1', text: '是', enabled: true, important: true, importantNote: '组合词笔记',
    cellVerifyEnabled: true, cellVerify: '刚需应用', cellVerifyMatchMode: 'contain' },
  { id: 'k2', text: '网盘', enabled: true } // 普通词：首扫即命中，不受值后到影响
];
const CFG = { groups: [], highlightStyle: { defaultBgColor: '#ffff00', defaultTextColor: '#000' } };
const hiSel = '[data-kh-cell-verify-hi-span],[data-kh-highlighted],[data-kh-important-note]';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message));
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"></tbody></table></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib', 'utils.js') });
  await page.addScriptTag({ path: ENGINE });

  const mkRow = (title, val) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = title; tr.appendChild(a);
    const b = document.createElement('td'); b.textContent = val; tr.appendChild(b);
    return tr;
  };

  // 模拟真实时序：
  // Phase1: init 首扫（此刻表格右格仍是默认/空）
  // 无法直接传函数，改为 window 定义
  await page.evaluate(() => {
    window.__mkRow = (title, val) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = title; tr.appendChild(a);
      const b = document.createElement('td'); b.textContent = val; tr.appendChild(b);
      return tr;
    };
    document.getElementById('tb').appendChild(window.__mkRow('刚需应用','')); // 右格空
    document.getElementById('tb').appendChild(window.__mkRow('网盘应用','否')); // 普通词
  });
  const kw1 = KW();
  await page.evaluate(({ k, c }) => KeywordEngine.highlightKeywords(k, c), { k: kw1, c: CFG });
  const afterFirstScan = await page.evaluate((sel) => {
    const list = Array.from(document.querySelectorAll('[data-kh-keyword-id]'));
    return { combo: list.filter(e => e.textContent === '是').length, plain: list.filter(e => e.textContent === '网盘').length };
  });
  console.log('首扫后: 组合词(是)命中=', afterFirstScan.combo, ' 普通词(网盘)=', afterFirstScan.plain);

  // Phase2: 页面 JS 在【observer 建立前】填充右格真实值（真实动态表格的异步数据到达）
  await page.evaluate(() => {
    const td = document.querySelector('#tb tr:first-child td:last-child');
    td.textContent = '是'; // 值后到
  });

  // Phase3: 才建立 observer（模拟 init 异步流程中 observer 稍晚建立）
  await page.evaluate(({ k, c }) => KeywordEngine.setupMutationObserver(k, c), { k: kw1, c: CFG });
  await page.waitForTimeout(1500); // 等待 flush/refetch

  const final = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('[data-kh-keyword-id]'));
    return { combo: list.filter(e => e.textContent === '是').length, plain: list.filter(e => e.textContent === '网盘').length,
             importantNote: document.querySelectorAll('[data-kh-important-note]').length };
  });
  console.log('observer建立+等待后: 组合词=', final.combo, ' 普通词=', final.plain, ' 重要笔记=', final.importantNote);
  console.log(final.combo >= 1 ? '  ✅ 组合词已补救' : '  ❌ 组合词缺失 → 复现用户「首次加载消失」');
  console.log(final.plain >= 1 ? '  ✅ 普通词正常' : '  ⚠️ 普通词也未命中');

  // Phase4: 模拟切回标签页 → refresh() 全量重扫
  await page.evaluate(({ k, c }) => KeywordEngine.highlightKeywords(k, c), { k: kw1, c: CFG });
  const afterRefresh = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('[data-kh-keyword-id]'));
    return { combo: list.filter(e => e.textContent === '是').length, importantNote: document.querySelectorAll('[data-kh-important-note]').length };
  });
  console.log('切回(refresh全量)后: 组合词=', afterRefresh.combo, ' 重要笔记=', afterRefresh.importantNote);

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
