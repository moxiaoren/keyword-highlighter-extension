// v1.13.0【问题4b】重要笔记面板「命中的词」聚合展示优化测试
// 规则：note 内容一致的同一条目内，标题集去重 + 值集去重，交叉展示
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/content/important-note.js' });

  const out = await page.evaluate(() => {
    const results = [];
    const renderTags = (entries) => {
      const host = document.createElement('div');
      ImportantNote.renderItems.call({ bodyEl: host, items: [{ note: 'N', entries: entries, imgSize: '', bg: '' }], escapeText: ImportantNote.escapeText, buildTagHtml: ImportantNote.buildTagHtml });
      const kws = host.querySelectorAll('.khin-item-kw');
      const adjs = host.querySelectorAll('.khin-item-adj');
      let html = '';
      for (let i = 0; i < kws.length; i++) html += kws[i].outerHTML + (adjs[i] ? adjs[i].outerHTML : '');
      return html;
    };
    const clearTag = h => (h.replace(/<[^>]+>/g, ''));

    // 1. 组合词 同标题不同值 → 标题1 → a|b
    let h = renderTags([{ kw: '免费', adj: '软件介绍' }, { kw: '付费', adj: '软件介绍' }]);
    const t1 = clearTag(h);
    results.push({ name: '同标题不同值 → 标题→a|b', ok: /软件介绍/.test(t1) && /免费\|付费/.test(t1) && (t1.split('软件介绍').length - 1) === 1, t1 });

    // 2. 组合词 不同标题同值 → 标题1|标题2 → a
    h = renderTags([{ kw: 'A', adj: '标题1' }, { kw: 'A', adj: '标题2' }]);
    const t2 = clearTag(h);
    results.push({ name: '不同标题同值 → 标题1|标题2→a', ok: /标题1\|标题2/.test(t2) && /→ A/.test(t2) && (t2.split('A').length - 1) === 1, t2 });

    // 3. 普通词 多个 → a|b
    h = renderTags([{ kw: 'a' }, { kw: 'b' }]);
    const t3 = clearTag(h);
    results.push({ name: '普通词多词 → a|b', ok: /a\|b/.test(t3) && !/→/.test(t3), t3 });

    // 4. v1.14.0：混合（标题1→a、标题1→b、标题2→a）→ 按标题分组平铺 标题1→a|b + 标题2→a，不再交叉成 标题1|标题2→a|b
    h = renderTags([{ kw: 'a', adj: '标题1' }, { kw: 'b', adj: '标题1' }, { kw: 'a', adj: '标题2' }]);
    const t4 = clearTag(h);
    results.push({ name: '混合 → 平铺 标题1→a|b + 标题2→a (不交叉)', ok: /标题1→ a\|b/.test(t4) && /标题2→ a/.test(t4) && !/标题1\|标题2/.test(t4), t4 });

    return results;
  });

  let all = true;
  for (const r of out) { console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + '  → ' + r.t1 + r.t2 + r.t3 + r.t4); if (!r.ok) all = false; }
  console.log(all ? '✅ 全部通过' : '❌ 有失败');
  await browser.close();
  process.exit(all ? 0 : 2);
})().catch(e => { console.error(e); process.exit(2); });
