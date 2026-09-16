/**
 * v1.13.8: 全词 + 正则含 | 时的词边界 bug（A|B|C 边界只套首/末分支 → B 无边界漏命中）。
 * 用户场景：普通词 "A|B|C" + 勾选 区分大小写/全词/正则，"启动 AI 搭档"不该命中却命中。
 */
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');

async function run() {
  const b = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.addScriptTag({ path: PATH + '/lib/utils.js' });
  await p.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });

  // 1) 纯函数层：buildMatchRegex 词边界
  const pure = await p.evaluate(() => {
    const kw = { text: 'A|B|C', useRegex: true, wholeWord: true, caseSensitive: false };
    const re = Utils.buildMatchRegex(kw);
    const cases = [
      ['启动 AI 搭档', false, 'AI里A前是空格但后跟I，不应命中'],
      ['A', true, '独立A'],
      ['B', true, '独立B'],
      ['C', true, '独立C'],
      ['ABC', false, 'ABC连续不应命中单字符'],
      ['X B Y', true, 'B独立'],
      ['AI', false, 'A后跟I不命中']
    ];
    const out = [];
    for (const [txt, want, desc] of cases) {
      re.lastIndex = 0;
      const got = re.test(txt);
      out.push({ txt, want, got, ok: got === want, desc });
    }
    return out;
  });
  let pureOk = true;
  for (const c of pure) { console.log((c.ok ? '✅' : '❌') + ` 纯[${c.txt}] 期望${c.want} 实际${c.got} | ${c.desc}`); if (!c.ok) pureOk = false; }

  // 2) 引擎全流程：真实 DOM 高亮
  const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' }, pageRebuildSilentMs: 0, pageRebuildGapMs: 0 };
  const kw = { id: 'k1', text: 'A|B|C', useRegex: true, wholeWord: true, caseSensitive: false };
  await p.setContent('<html><body><p id="p1">启动 AI 搭档，这是正常句子</p><p id="p2">单独 B 在中间</p></body></html>');
  await p.evaluate((a) => { KeywordEngine.setupMutationObserver(a[0], a[1]); return KeywordEngine.highlightKeywords(a[0], a[1]); }, [[kw], cfg]);
  await p.waitForTimeout(120);
  const hits = await p.evaluate(() => KeywordEngine._plainHits.filter(h => document.contains(h.textNode)).map(h => h.textNode.textContent.slice(h.start, h.end)));
  console.log('浏览器命中片段:', JSON.stringify(hits));
  // 期望：只有 p2 里的独立 B 命中；p1 "AI" 中的 A 不应命中（A后跟I）
  const badAC = hits.some(t => t === 'A' || t === 'C');
  const hasB = hits.includes('B');
  const brOk = !badAC && hasB && hits.length === 1;

  const ok = pureOk && brOk;
  console.log(ok ? 'ALL PASS' : 'FAIL');
  await b.close();
  process.exit(ok ? 0 : 1);
}
run();
