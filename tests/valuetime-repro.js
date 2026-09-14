/**
 * 精确复现用户症状：组合词「值后到」= 右格初始为空/默认值，真实值后异步填充。
 * 对照三种触发方式：textContent=、nodeValue原地改、单元格重建。
 * 目标：确认首扫之后增量链路能否把组合词高亮/重要笔记补上。
 */
const FS = require('fs');
const PATH = require('path');
const enginePathArg = process.argv[2];
const REPO = PATH.join(__dirname, '..');
const ENGINE = enginePathArg ? PATH.resolve(enginePathArg) : PATH.join(REPO, 'lib', 'keyword-engine.js');
const PW = process.env.PW_PLAYWRIGHT_PATH || '/tmp/pw/node_modules/playwright';
const { chromium } = require(PW);

const KW = [
  { id: 'k1', text: '是', enabled: true, important: true, importantNote: '组合词重要笔记A',
    cellVerifyEnabled: true, cellVerify: '刚需应用', cellVerifyMatchMode: 'contain' }
];
const CFG = { groups: [], highlightStyle: { defaultBgColor: '#ffff00', defaultTextColor: '#000' } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message));
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"></tbody></table></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib', 'utils.js') });
  await page.addScriptTag({ path: ENGINE });

  // 构造初始行：左格标题、右格为空
  await page.evaluate(() => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = '刚需应用'; tr.appendChild(a);
    const b = document.createElement('td'); tr.appendChild(b); // 右格空
    document.getElementById('tb').appendChild(tr);
  });

  const hits = async () => page.evaluate(() => document.querySelectorAll('[data-kh-cell-verify-hi-span]').length);
  const notes = async () => page.evaluate(() => document.querySelectorAll('[data-kh-important-note]').length);

  // 首扫（此时右格为空）
  await page.evaluate(({k,c}) => KeywordEngine.highlightKeywords(k, c), {k:KW, c:CFG});
  console.log('首扫(右格空) 组合词命中:', await hits(), ' 重要笔记:', await notes());

  // 建立 observer
  await page.evaluate(({k,c}) => KeywordEngine.setupMutationObserver(k, c), {k:KW, c:CFG});

  const scenario = process.argv[3] || 'textContent';
  if (scenario === 'textContent') {
    // 右格真实值后到：textContent= 赋值（新增TEXT节点）
    await page.evaluate(() => { document.querySelector('#tb tr td:last-child').textContent = '是'; });
  } else if (scenario === 'nodeValue') {
    // 右格真实值后到：先建空字符再 nodeValue 原地改
    await page.evaluate(() => {
      const td = document.querySelector('#tb tr td:last-child');
      const t = document.createTextNode(''); td.appendChild(t);
      t.nodeValue = '是';
    });
  }
  // 等待 flush(300ms)+refetch
  await page.waitForTimeout(1500);

  const h = await hits(), n = await notes();
  console.log(`\n[${scenario}] 值后到后 组合词命中=${h} 重要笔记=${n}`);
  console.log(h >= 1 && n >= 1 ? '  ✅ 增量补救成功' : '  ❌ 增量补救失败 → 与用户症状一致（消失）');

  await browser.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
