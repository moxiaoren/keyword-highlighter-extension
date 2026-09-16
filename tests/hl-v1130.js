/*
 * v1.13.0 回归测试（真实浏览器注入法）
 * 覆盖：
 *  ① 组合词核心命中超链接内容 → 高亮 + 重要笔记【问题1】
 *  ② 普通词+fetchLabels 未标重要也抓取【问题3a】
 *  ③ 核心留空+标题+fetchLabels 按 fetchLabels 抓取（非标题右侧）【问题3b】
 *  ④ 组合词标签 adj=实际命中标题段【问题4a】
 *  ⑤ 整表刷新后组合词仍生效（右格值更新）【问题2】
 *
 * 运行：node tests/hl-v1130.js
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
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/keyword-engine.js') });

  await page.evaluate(() => {
    window.__cfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
    window.__combo = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && m.combo)
      .map(m => ({
        text: m.textNode.nodeValue.slice(m.start, m.end),
        adj: m.adj, note: m.importantNote, imp: m.important,
        on: m.textNode.parentElement ? m.textNode.parentElement.tagName : null
      }));
    window.__plain = (kid) => (KeywordEngine._plainHits || [])
      .filter(m => m && m.kwId === kid && !m.combo)
      .map(m => ({ text: m.textNode.nodeValue.slice(m.start, m.end), note: m.importantNote }));
    window.__mkTable = (rows) => {
      const t = document.createElement('table');
      rows.forEach(r => { const tr = document.createElement('tr'); r.forEach(c => { const td = document.createElement('td'); td.innerHTML = c; tr.appendChild(td); }); t.appendChild(tr); });
      document.body.appendChild(t); return t;
    };
    window.__fetchOnlyNote = () => {
      const el = document.querySelector('[data-kh-important-note]');
      return el ? (el.getAttribute('data-kh-important-note') || '') : '';
    };
    window.__allC5 = () => (KeywordEngine._plainHits || []).filter(m => m && m.kwId === 'c5').map(m => ({ text: m.textNode.nodeValue.slice(m.start, m.end), adj: m.adj, on: m.textNode.parentElement ? m.textNode.parentElement.tagName : null }));
  });

  // ===== ① 问题1：组合词核心命中 <a> 超链接内容 → 高亮+重要笔记 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    window.__mkTable([['开发者', '<a href="#">南京公司</a>']]);
    await KeywordEngine.highlightKeywords([{
      id: 'c1', text: '南京公司', enabled: true,
      cellVerifyEnabled: true, cellVerify: '开发者', cellVerifyMatchMode: 'include',
      important: true, importantNote: '重要：南京公司'
    }], window.__cfg);
  });
  const r1 = await page.evaluate(() => window.__combo('c1'));
  check('组合词核心命中超链接→高亮+重要笔记',
    r1.length === 1 && r1[0].text === '南京公司' && r1[0].imp === true && /南京公司/.test(r1[0].note || ''),
    r1);

  // ===== ② 问题3a：普通词+fetchLabels 未标重要也抓取 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    // 表格：正文含"公司"，同时有"地址"标签行
    window.__mkTable([['地址', '南京路1号'], ['公司', '某某网络科技']]);
    await KeywordEngine.highlightKeywords([{
      id: 'p1', text: '网络', enabled: true,
      fetchLabels: '地址'   // 未 important
    }], window.__cfg);
  });
  const r2 = await page.evaluate(() => window.__plain('p1'));
  check('普通词+fetchLabels 未标重要→仍抓取进重要笔记',
    r2.length === 1 && r2[0].text === '网络' && /南京路1号/.test(r2[0].note || ''),
    r2);

  // ===== ③ 问题3b：specialFetch（核心留空+标题+fetchLabels）按 fetchLabels 抓取 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    // 第一行标题"审核状态"右侧是"不通过"；第二行"驳回原因"右侧是"内容复杂"
    window.__mkTable([['审核状态', '不通过'], ['驳回原因', '内容复杂详细描述']]);
    await KeywordEngine.highlightKeywords([{
      id: 's1', text: '', enabled: true,
      cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include',
      fetchLabels: '驳回原因'
    }], window.__cfg);
  });
  const r3 = await page.evaluate(() => { const n = window.__fetchOnlyNote(); return { note: n, comboCount: (KeywordEngine._plainHits || []).filter(m => m && m.kwId === 's1').length }; });
  check('核心留空+标题+fetchLabels→按 fetchLabels 抓取(非标题右侧)',
    /内容复杂详细描述/.test(r3.note || '') && !/^不通过/.test((r3.note || '').trim()),
    r3);

  // ===== ④ 问题4a：组合词标题正则命中"软件介绍"，adj=命中段 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    window.__mkTable([['软件介绍', '免费']]);
    await KeywordEngine.highlightKeywords([{
      id: 'c4', text: '免费', enabled: true,
      cellVerifyEnabled: true, cellVerify: '应用名称|软件介绍', cellVerifyUseRegex: true, cellVerifyMatchMode: 'include',
      important: true, importantNote: '免费版'
    }], window.__cfg);
  });
  const r4 = await page.evaluate(() => window.__combo('c4'));
  check('组合词标题正则→adj=实际命中段(软件介绍)',
    r4.length === 1 && r4[0].adj === '软件介绍', r4);

  // ===== ⑤ 问题2：整表刷新后组合词仍生效（右格值 textContent 更新）=====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    window.__mkTable([['审核状态', '']]);   // 初始右格空（模拟页面加载/刷新时异步填充前）
    const kw = [{
      id: 'c5', text: '不通过', enabled: true,
      cellVerifyEnabled: true, cellVerify: '审核状态', cellVerifyMatchMode: 'include',
      important: true, importantNote: '审核不通过'
    }];
    await KeywordEngine.highlightKeywords(kw, window.__cfg);   // 初始：右格空 → 不命中(markDone 不缓存)
    KeywordEngine.setupMutationObserver(kw, window.__cfg);
    // 值后到(刷新/翻页异步填充)：180ms 后填真实值 → mutation 增量重建应命中
    setTimeout(() => { document.querySelector('table tr td:nth-child(2)').textContent = '审核不通过'; }, 180);
  });
  await page.waitForTimeout(900); // 值后到(180) + flush(300) + 余量
  const r5 = await page.evaluate(() => window.__combo('c5'));
  // 整表刷新(翻页)+值后到：组合词应命中且挂到 DOM（on=TD 非 null、重要命中、无残留重复）
  check('整表刷新(翻页)+值后到后组合词仍生效',
    r5.length === 1 && r5[0].imp === true && r5[0].on === 'TD',
    r5);
  await page.evaluate(() => { if (KeywordEngine.observer) { KeywordEngine.observer.disconnect(); KeywordEngine.onHighlight = null; } });

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(failed.length === 0 ? '✅ 全部 ' + results.length + ' 项通过' : '❌ ' + failed.length + '/' + results.length + ' 项失败');
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
