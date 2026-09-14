// 方案验证：点击翻页 → 先清高亮(还原firstChild为文本) → 框架数据到达后对firstChild赋新值 → 观察器自动重建
// 关键：清除高亮发生在「框架真正赋值之前」，让赋值落到文档内文本节点
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const KEYWORDS=[{id:'k1',text:'是',enabled:true,important:true,importantNote:'优质',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'}];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false};
(async()=>{
  const b=await require(PW).chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb">'+
    '<tr><td>是否刚需</td><td id="val">是</td></tr>'+
    '</tbody></table>'+
    '<button id="next">下一页</button></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.evaluate(({k,c})=>{KeywordEngine.setupMutationObserver(k,c);KeywordEngine.highlightKeywords(k,c);},{k:KEYWORDS,c:CFG});
  console.log('初始: 高亮span=', await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length));

  // 点击翻页：真实按钮点击 + 先清高亮还原文本（模拟方案核心逻辑）
  await page.evaluate(()=>{ document.getElementById('next').click(); });
  // 方案A：点击后立即清高亮→还原 firstChild 为文本节点
  await page.evaluate(()=>{
    const td=document.getElementById('val');
    // 清掉组合词高亮 span，还原为文本节点（保留 firstChild 可赋值性）
    const span=td.querySelector('[data-kh-cell-verify-hi-span]');
    if(span){ const tn=document.createTextNode(span.textContent); span.parentNode.replaceChild(tn,span); }
  });
  console.log('点击+清高亮后: firstChild=', await page.evaluate(()=>{const fc=document.getElementById('val').firstChild;return fc.nodeType===3?'TEXT('+fc.nodeValue+')':'OTHER';}));

  // 模拟框架异步数据到达后，对 firstChild 赋新值"否"
  await page.evaluate(()=>{ document.getElementById('val').firstChild.nodeValue = '否'; });
  await page.waitForTimeout(600); // 等 MutationObserver 增量/重建
  const after = await page.evaluate(()=>({
    text: document.getElementById('val').textContent.trim(),
    hiSpan: document.querySelectorAll('[data-kh-cell-verify-hi-span]').length
  }));
  console.log('框架赋"否"后: textContent=', after.text, ' (期望=否 新值进来了)');
  console.log('高亮span=', after.hiSpan, '(期望0=不对，"否"不该高亮; 重建按新值正确处理)');
  console.log('结论:', after.text==='否' ? '✅ 方案可行：先清高亮→赋值落文档内→新值进入页面，引擎按新值重建' : '❌ 新值仍未进入');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
