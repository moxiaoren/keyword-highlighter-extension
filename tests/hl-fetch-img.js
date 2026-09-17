// v1.50.x 抓取字段图片展示回归：
// A 文字+图片混合          地址单元格含 <img> → 重要笔记抓取结果含 <img src>
// B 纯图片单元格           地址单元格只有 <img>（无文字） → 仍能抓到图片
// C 非法协议(javascript:)  <img src="javascript:..."> → 不产生 <img>
// D 相对路径/无 http base   相对 src 在无网络 base 下安全降级（不注入、不崩溃、不产生非法 img）
// E 纯文字抓取不受影响
const PATH = '/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const { chromium } = require('/tmp/pw/node_modules/playwright');
const cfg = { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } };
const IMG = 'https://img.example.com/supporter-audit/image/20260916/a.jpg';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.addScriptTag({ path: PATH + '/lib/utils.js' });
  await page.addScriptTag({ path: PATH + '/lib/keyword-engine.js' });
  let fails = 0;

  const run = async (html, kw) => {
    await page.setContent('<!doctype html><html><body>' + html + '</body></html>');
    await page.evaluate((a) => KeywordEngine.highlightKeywords(a[0], a[1]), [kw, cfg]);
    return page.evaluate(() => KeywordEngine.getPlainHits().map(h => h.importantNote || '').join('\n'));
  };

  // A 文字+图片
  const A = await run(`<table><tr><td>应用名称</td><td>抖音</td></tr><tr><td>地址</td><td>北京 <img src="${IMG}" alt="pic"> 海淀</td></tr></table>`, [{ id: 'A', text: '抖音', enabled: true, fetchLabels: '地址' }]);
  const okA = A.includes('<img') && A.includes(IMG);
  console.log((okA ? '✅' : '❌') + ' [A 文字+图片] note 含 <img>与url: ' + okA);
  if (!okA) fails++;

  // B 纯图片单元格
  const B = await run(`<table><tr><td>应用名称</td><td>抖音</td></tr><tr><td>封面</td><td><img src="${IMG}" alt="cover"></td></tr></table>`, [{ id: 'B', text: '抖音', enabled: true, fetchLabels: '封面' }]);
  const okB = B.includes('<img') && B.includes(IMG);
  console.log((okB ? '✅' : '❌') + ' [B 纯图单元格] note 含 <img>: ' + okB);
  if (!okB) fails++;

  // C 非法协议 javascript:
  const C = await run(`<table><tr><td>应用名称</td><td>抖音</td></tr><tr><td>地址</td><td><img src="javascript:alert(1)" alt="bad"> 北京</td></tr></table>`, [{ id: 'C', text: '抖音', enabled: true, fetchLabels: '地址' }]);
  const okC = !C.includes('javascript:') && !/src="javascript/i.test(C);
  console.log((okC ? '✅' : '❌') + ' [C 非法src被拦截] 无 javascript 注入: ' + okC);
  if (!okC) fails++;

  // D 相对路径（无 http base，about:blank）→ 安全降级：不产生非法 img、不崩溃
  const D = await run(`<table><tr><td>应用名称</td><td>抖音</td></tr><tr><td>图片</td><td><img src="/img/rel.jpg" alt="rel"></td></tr></table>`, [{ id: 'D', text: '抖音', enabled: true, fetchLabels: '图片' }]);
  const okD = !/src="(?!https?:)/i.test(D); // 不产生非 http(s) 的 img src
  console.log((okD ? '✅' : '❌') + ' [D 相对路径安全降级] 无非http img: ' + okD + ' | note含rel=' + D.includes('rel'));
  if (!okD) fails++;

  // E 纯文字不受影响
  const E = await run(`<table><tr><td>应用名称</td><td>抖音</td></tr><tr><td>地址</td><td>北京</td></tr></table>`, [{ id: 'E', text: '抖音', enabled: true, fetchLabels: '地址' }]);
  const okE = E.includes('北京') && !E.includes('<img');
  console.log((okE ? '✅' : '❌') + ' [E 纯文字不受影响] 含北京且无<img>: ' + okE);
  if (!okE) fails++;

  await browser.close();
  console.log(fails ? '\n' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试错误:', e); process.exit(2); });
