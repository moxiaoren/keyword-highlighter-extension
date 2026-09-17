/*
 * v1.50.0 tb 组合词「值后到 / 整页重建缓存」回归
 * 背景（内部 agent 排查 + 代码证据）：
 *  - 修改1：整页重建 _removeHighlightsInRoot 只清了左右格 _cellVerified，漏清 tb 的 _tbColProcessed
 *           → 重建后 tb 被 stale 缓存跳过、永不补高亮（el-table 复用 td、数据异步后到/手动重建即铁证）。
 *  - 修改2：_highlightComboTbCol 原“无条件 done.add”，占位/未命中单元格被标记 → 值后到被卡死。
 *           改为“命中才标记”。
 *  - 修改3：_locateColumnForHeader 加“仅表头(TH/首行)生效”，数据区碰巧含列关键词文本不再误触发。
 * 运行：node tests/hl-combo-tb-value-late.js
 */
const PATH = require('path');
const { chromium } = require('/tmp/pw/node_modules/playwright');
const CHROME = '/opt/chrome-linux/chrome';
const REPO = PATH.resolve(__dirname, '..');

function mkkw(over) {
  return Object.assign({
    id: 'k1', text: '吃饭', enabled: true, useRegex: false, caseSensitive: false, wholeWord: false,
    cellVerifyEnabled: true, cellVerify: '名称', cellVerifyMatchMode: 'include', cellVerifyUseRegex: false,
    comboAxis: 'tb', important: false, importantNote: ''
  }, over);
}
const CFG = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/utils.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/rare-char.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/keyword-engine.js') });

  // el-table 结构：表头表(thead)+数据表(body)同一 inner-wrapper
  const EL = `<div class="el-table__inner-wrapper">`
    + `<div class="el-table__header-wrapper"><table class="el-table__header"><thead><tr><th>名称</th><th>操作</th></tr></thead></table></div>`
    + `<div class="el-table__body-wrapper"><table class="el-table__body"><tbody>`
    + `<tr><td class="c0">${'__VAL__'}</td><td><button>编辑</button></td></tr>`
    + `</tbody></table></div></div>`;

  let fails = 0;

  // Case 1（修改2）：值后到——首扫占位文本不命中→不标记缓存，填充真实值后可补高亮
  let html1 = EL.replace('__VAL__', '加载中…');
  await page.evaluate(({ html, kw, cfg }) => { document.body.innerHTML = html; }, { html: html1, kw: mkkw(), cfg: CFG });
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c1a = await page.evaluate(() => (KeywordEngine._plainHits || []).length);
  // 填充真实数据 → 再次高亮
  await page.evaluate(() => { document.querySelector('.el-table__body .c0').textContent = '我已经吃饭了'; });
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c1b = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  const ok1 = c1a === 0 && c1b.length === 1 && c1b[0] === '吃饭';
  console.log((ok1 ? '✅' : '❌') + ` [值后到·占位不命中→填充后可补] 首扫=${c1a} 二次=${JSON.stringify(c1b)}`);
  if (!ok1) fails++;

  // Case 2（修改1）：整页重建清 _tbColProcessed 后仍可重新高亮
  await page.evaluate(() => { document.body.innerHTML = `<div style="display:none"></div>`; KeywordEngine._plainHits = []; KeywordEngine._cellVerified = new WeakMap(); KeywordEngine._tbColProcessed = new WeakMap(); });
  let html2 = EL.replace('__VAL__', '已经吃饭了');
  await page.evaluate(({ html, kw, cfg }) => { document.body.innerHTML = html; }, { html: html2, kw: mkkw(), cfg: CFG });
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c2a = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  // 模拟整页重建路径（rebuildAll 的核心：先 _removeHighlightsInRoot 清缓存，再重新高亮）
  await page.evaluate(() => KeywordEngine._removeHighlightsInRoot(document.body));
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c2b = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  const ok2 = c2a.length === 1 && c2a[0] === '吃饭' && c2b.length === 1 && c2b[0] === '吃饭';
  console.log((ok2 ? '✅' : '❌') + ` [整页重建清缓存后可重新高亮] 重建前=${JSON.stringify(c2a)} 重建后=${JSON.stringify(c2b)}`);
  if (!ok2) fails++;

  // Case 3（修改3）：数据区某格碰巧含列关键词文本，不应误触发 tb（仅表头生效）
  const html3 = `<table><thead><tr><th>类型</th><th>标签</th></tr></thead><tbody>`
    + `<tr><td>甲</td><td>名称</td></tr>`
    + `<tr><td>乙</td><td>吃饭了</td></tr>`
    + `</tbody></table>`;
  await page.evaluate(() => { document.body.innerHTML = ''; KeywordEngine._plainHits = []; KeywordEngine._tbColProcessed = new WeakMap(); });
  await page.evaluate(({ html, kw, cfg }) => { document.body.innerHTML = html; }, { html: html3, kw: mkkw(), cfg: CFG });
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c3 = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  const ok3 = c3.length === 0;
  console.log((ok3 ? '✅' : '❌') + ` [仅表头生效·数据区含列词不误命中] 命中=${JSON.stringify(c3)}`);
  if (!ok3) fails++;

  // Case 4（removeAllHighlights destroy 路径）：切标签页/开关插件后 tb 应自动恢复高亮
  await page.evaluate(() => { document.body.innerHTML = '<div style="display:none"></div>'; KeywordEngine._plainHits = []; KeywordEngine._cellVerified = new WeakMap(); KeywordEngine._tbColProcessed = new WeakMap(); });
  let html4 = EL.replace('__VAL__', '已经吃饭了');
  await page.evaluate(({ html, kw, cfg }) => { document.body.innerHTML = html; }, { html: html4, kw: mkkw(), cfg: CFG });
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c4a = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  // 模拟 destroy 路径（切换标签页/开关插件）：removeAllHighlights 应同时清左右格+tb 缓存
  await page.evaluate(() => KeywordEngine.removeAllHighlights());
  await page.evaluate(({ kw, cfg }) => KeywordEngine.highlightKeywords([kw], cfg), { kw: mkkw(), cfg: CFG });
  const c4b = await page.evaluate(() => (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end)));
  const ok4 = c4a.length === 1 && c4a[0] === '吃饭' && c4b.length === 1 && c4b[0] === '吃饭';
  console.log((ok4 ? '✅' : '❌') + ` [destroy路径·切标签/开关插件后恢复] 前=${JSON.stringify(c4a)} 后=${JSON.stringify(c4b)}`);
  if (!ok4) fails++;

  await browser.close();
  console.log(fails ? `\n${fails} 项失败` : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试错误:', e); process.exit(2); });
