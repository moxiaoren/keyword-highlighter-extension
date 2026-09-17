/*
 * v1.14.0 专项测试（真实浏览器注入法）
 * ① 重要笔记聚合：内容一致才同卡；标签按形态聚合、值标题都不同/有标题+无标题混合则平铺不交叉
 * ② 重要笔记底色：勾选「复用关键词高亮底色」则铺该词高亮色，未勾选不铺
 *
 * 运行：node tests/hl-v1140.js
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
  await page.addScriptTag({ path: PATH.join(REPO, 'content/important-note.js') });

  // ========== ① buildTagHtml 各形态 ==========
  const t = (entries) => page.evaluate((entries) => ImportantNote.buildTagHtml(entries), entries);

  // 一、同标题多值 → 🔖 标题 → a|b
  const r1 = await t([
    { kw: 'a', adj: '应用名称' },
    { kw: 'b', adj: '应用名称' }
  ]);
  const norm = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  check('同标题多值 → 🔖 应用名称 → a|b', norm(r1) === '🔖 应用名称→ a|b', norm(r1));

  // 二、多标题同值 → 🔖 标题1|标题2 → a
  const r2 = await t([
    { kw: 'a', adj: '应用名称' },
    { kw: 'a', adj: '应用标题' }
  ]);
  check('多标题同值 → 🔖 应用名称|应用标题 → a', norm(r2) === '🔖 应用名称|应用标题→ a', norm(r2));

  // 三、无标题多词普通词 → 🔖 a|b
  const r3 = await t([{ kw: 'a', adj: '' }, { kw: 'b', adj: '' }]);
  check('无标题多词 → 🔖 a|b（一个标签）', norm(r3) === '🔖 a|b' && (r3.match(/khin-item-kw/g) || []).length === 1, norm(r3));

  // 四、值标题都不同（标题1→a + 标题2→b）→ 平铺两条，不交叉
  const r4 = await t([
    { kw: 'a', adj: '应用名称' },
    { kw: 'b', adj: '应用标题' }
  ]);
  const kwN4 = (r4.match(/khin-item-kw/g) || []).length;
  check('值标题都不同 → 平铺2条(应用名称→a / 应用标题→b) 不交叉',
    kwN4 === 2 && norm(r4).includes('应用名称→ a') && norm(r4).includes('应用标题→ b') && !norm(r4).includes('|'), norm(r4));

  // 五、有标题 + 无标题混合（普通词 a + 组合词 应用名称→a）→ 平铺两条
  const r5 = await t([
    { kw: 'a', adj: '' },
    { kw: 'a', adj: '应用名称' }
  ]);
  const kwN5 = (r5.match(/khin-item-kw/g) || []).length;
  check('无标题+有标题混合 → 平铺2条(🔖 a / 🔖 应用名称→a)',
    kwN5 === 2 && norm(r5).indexOf('🔖 a') === 0 && norm(r5).includes('🔖 应用名称→ a'), norm(r5));

  // 六、同一标题多值 + 另一标题单值 → 按标题分组：标题1→a|b、标题2→c
  const r6 = await t([
    { kw: 'a', adj: '应用名称' },
    { kw: 'b', adj: '应用名称' },
    { kw: 'c', adj: '应用标题' }
  ]);
  const kwN6 = (r6.match(/khin-item-kw/g) || []).length;
  check('同标题多值+另标题单值 → 应用名称→a|b + 应用标题→c 两条',
    kwN6 === 2 && norm(r6).includes('应用名称→ a|b') && norm(r6).includes('应用标题→ c'), norm(r6));

  // ========== ② refresh 按内容分组：内容不一致 → 不同卡 ==========
  // 用 DOM span 注入：keyword 同为「软件介绍」，但 note 分别为 免费/付费 → 应两张卡
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    await ImportantNote.init({}).catch(() => {}); // 可能已 init：destroy 后重建
  });
  await page.evaluate(() => {
    // 先销毁重建，隔离状态
    if (ImportantNote.host) { ImportantNote.destroy(); }
    const mk = (kw, note, adj) => {
      const s = document.createElement('span');
      s.setAttribute('data-kh-important', '1');
      s.setAttribute('data-kh-important-note', note);
      s.setAttribute('data-kh-cell-verify', adj || '');
      s.textContent = kw;
      document.body.appendChild(s);
    };
    mk('软件介绍', '免费', '应用名称');
    mk('软件介绍', '付费', '应用标题');
  });
  await page.evaluate(() => ImportantNote.init({}).then(() => ImportantNote.refresh()));
  const items1 = await page.evaluate(() => (ImportantNote.items || []).map(i => ({ note: i.note, tags: i.entries.map(e => e.adj + '→' + e.kw) })));
  await page.evaluate(() => { if (ImportantNote.host) ImportantNote.destroy(); });
  check('内容不一致(免费/付费) → 两张不同卡片',
    items1.length === 2 && items1.some(i => i.note === '免费') && items1.some(i => i.note === '付费'), items1);

  // ========== ③ 需求② 底色复用 ==========
  // 勾选 impNoteUseHlColor → important bg = 该词高亮底色
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = '目标文本'; document.body.appendChild(p);
    window.__cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
    await KeywordEngine.highlightKeywords([{ id: 'k1', text: '目标', enabled: true, important: true, importantNote: '要点', bgColor: '#ff0000', impNoteUseHlColor: true }], window.__cfg);
  });
  const bgOn = await page.evaluate(() => {
    const h = KeywordEngine.getImportantPlainHits()[0];
    return h ? h.bg : '';
  });
  check('勾选复用 → important 底色=该词高亮色 #ff0000', bgOn === '#ff0000', bgOn);

  // 未勾选 → 无底色
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = '目标'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords([{ id: 'k2', text: '目标', enabled: true, important: true, importantNote: '要点', bgColor: '#ff0000' }], window.__cfg);
  });
  const bgOff = await page.evaluate(() => {
    const h = KeywordEngine.getImportantPlainHits()[0];
    return h ? h.bg : '(无)';
  });
  check('未勾选 → important 底色为空(不铺)', bgOff === '', bgOff);

  // 分组勾选复用 → 组内关键词(未单独勾选) 用其高亮色
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const p = document.createElement('p'); p.textContent = '目标'; document.body.appendChild(p);
    await KeywordEngine.highlightKeywords(
      [{ id: 'k3', text: '目标', enabled: true, groupId: 'g1', bgColor: '#00ff00' }],
      { groups: [{ id: 'g1', name: 'G', important: true, importantNote: '组要点', impNoteUseHlColor: true }], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } }
    );
  });
  const bgG = await page.evaluate(() => { const h = KeywordEngine.getImportantPlainHits()[0]; return h ? h.bg : '(无)'; });
  check('分组勾选复用 → 组内词底色用其高亮色 #00ff00', bgG === '#00ff00', bgG);

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
})();
