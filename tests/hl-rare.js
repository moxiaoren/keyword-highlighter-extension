/*
 * 罕见字专项测试（v1.12.0，真实浏览器注入法）
 * 覆盖：独立罕见字词高亮、未添加不检测、罕见字组合核心（右格）、重要/备注挂载
 *
 * 运行：node tests/hl-rare.js
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
    window.__cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
    // 独立罕见字词命中文本
    window.__rareHits = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && !m.combo)
      .map(m => m.textNode.nodeValue.slice(m.start, m.end));
    // 罕见字组合（combo:true）命中文本
    window.__rareComboHits = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && m.combo)
      .map(m => m.textNode.nodeValue.slice(m.start, m.end));
    // 独立罕见字词 meta（取第一条）
    window.__rareMeta = (kid) => (KeywordEngine._plainHits || []).find(m => m && m.kwId === kid && !m.combo) || null;
  });

  // ===== 用例1：独立罕见字词 → 命中所有罕见字，常用字不高亮 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = '你好昉这是谞文'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords([{ id: 'rare1', text: 'hjz#', kind: 'rare', enabled: true }], window.__cfg);
  });
  const h1 = await page.evaluate(() => window.__rareHits('rare1'));
  check('独立罕见字：命中昉/谞（常用字不高亮）',
    h1.length === 2 && h1.includes('昉') && h1.includes('谞'), h1);

  // ===== 用例2：未添加 hjz#（无 rare 词）→ 罕见字不检测 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    document.body.appendChild(Object.assign(document.createElement('p'), { textContent: '昉谞文' }));
    await KeywordEngine.highlightKeywords([{ id: 'n1', text: '苹果', enabled: true }], window.__cfg);
  });
  check('未添加罕见字规则 → 不检测', await page.evaluate(() => (KeywordEngine._plainHits || []).length) === 0);

  // ===== 用例3：罕见字组合核心（右格）→ 标题词右侧出现罕见字才命中 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const t = document.createElement('table');
    const tr0 = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = '标题';
    const b = document.createElement('td'); b.textContent = '昉好';
    tr0.appendChild(a); tr0.appendChild(b); t.appendChild(tr0);
    document.body.appendChild(t);
    const kw = { id: 'rc1', text: 'hjz#', kind: 'rare', enabled: true,
      cellVerifyEnabled: true, cellVerify: '标题', cellVerifyMatchMode: 'include' };
    await KeywordEngine.highlightKeywords([kw], window.__cfg);
  });
  const h3 = await page.evaluate(() => window.__rareComboHits('rc1'));
  check('罕见字组合核心：标题右侧昉命中', h3.length === 1 && h3[0] === '昉', h3);

  // ===== 用例4：罕见字组合但右格无罕见字 → 不命中 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const t = document.createElement('table');
    const tr0 = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = '标题';
    const b = document.createElement('td'); b.textContent = '好文';
    tr0.appendChild(a); tr0.appendChild(b); t.appendChild(tr0);
    document.body.appendChild(t);
    const kw = { id: 'rc2', text: 'hjz#', kind: 'rare', enabled: true,
      cellVerifyEnabled: true, cellVerify: '标题', cellVerifyMatchMode: 'include' };
    await KeywordEngine.highlightKeywords([kw], window.__cfg);
  });
  check('罕见字组合：右格无罕见字 → 不命中',
    await page.evaluate(() => (KeywordEngine._plainHits || []).filter(m => m && m.kwId === 'rc2').length) === 0);

  // ===== 用例5：罕见字词带备注 + 重要笔记 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    document.body.appendChild(Object.assign(document.createElement('p'), { textContent: '这是昉字' }));
    await KeywordEngine.highlightKeywords([{ id: 'rare2', text: 'hjz#', kind: 'rare', enabled: true,
      note: '生僻标记', important: true, importantNote: '注意此字' }], window.__cfg);
  });
  const meta5 = await page.evaluate(() => window.__rareMeta('rare2'));
  check('罕见字词：备注与重要笔记挂载',
    !!meta5 && meta5.note === '生僻标记' && meta5.important === true, meta5 ? { note: meta5.note, important: meta5.important } : null);

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(failed.length === 0 ? '✅ 全部 ' + results.length + ' 项通过' : '❌ ' + failed.length + '/' + results.length + ' 项失败');
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
