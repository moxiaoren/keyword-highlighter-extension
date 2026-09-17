/*
 * v1.14.1【3】普通词全词匹配「跨文本节点词边界判定」回归
 * 背景：页面把连续文本拆成相邻节点（如 “1、修复若干 B<span>UG</span>” —— “BUG” 被另一词的 span 拆断），
 *      全词命中若紧贴节点首/尾，须检查相邻兄弟节点延续字符，否则误判独立词命中。
 * 运行：node tests/hl-wholeword-frag.js
 */
const PATH = require('path');
const { chromium } = require('/tmp/pw/node_modules/playwright');
const CHROME = '/opt/chrome-linux/chrome';
const REPO = PATH.resolve(__dirname, '..');

// 普通词 A|B|C + 区分大小写 + 全词 + 正则
const KW = { id: 'abc', text: 'A|B|C', enabled: true, useRegex: true, caseSensitive: true, wholeWord: true };
// [名称, HTML, 期望命中数]
const CASES = [
  // —— 跨节点被拆：期望不命中 ——
  ['碎片 B+span(UG)',        '<td>1、修复若干 B<span style="color:red">UG</span></td>', 0],
  ['碎片 B+span(UG) 无样式', '<td>1、修复若干 B<span>UG</span></td>', 0],
  ['碎片 前词B+span(UG)',    '<td>若干B<span>UG</span></td>', 0],
  // —— 连续文本（未拆）：期望不命中 ——
  ['连续 BUG',               '<td>1、修复若干 BUG</td>', 0],
  ['连续「Bug修改」',         '<td>「Bug修改」修复了一些已知问题</td>', 0],
  // —— 正常全词独立命中：期望命中 ——
  ['独立 B/C',               '<td>甲 B 乙 端 C 丙</td>', 2],
  ['独立 B 在节点尾',          '<td>甲 B</td>', 1],
  ['独立 B 后接非词 span',     '<td>甲 B<span>-</span></td>', 1],
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/utils.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/rare-char.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/keyword-engine.js') });

  let fails = 0;
  for (const [name, html, expect] of CASES) {
    await page.evaluate(async ({ html, KW }) => {
      document.body.innerHTML = html;
      KeywordEngine._plainHits = [];
      await KeywordEngine.highlightKeywords([KW], { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } });
      window.__segs = (KeywordEngine._plainHits || []).map(m => (m.textNode.nodeValue || '').slice(m.start, m.end));
    }, { html, KW });
    const segs = await page.evaluate(() => window.__segs);
    const ok = segs.length === expect;
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' [' + name + '] 命中=' + segs.length + ' 期望=' + expect + (segs.length ? ' ' + JSON.stringify(segs) : ''));
  }
  await browser.close();
  console.log(fails ? '\n' + fails + ' 项失败' : '\n✅ 全部 ' + CASES.length + ' 项通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试错误:', e); process.exit(2); });
