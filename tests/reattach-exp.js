// 方案可行性实验：高亮时把被摘离的原始文本节点接回 DOM，验证框架对该引用赋值能触发重建出新值
// 核心：框架翻页持有 td.firstChild（或持久引用）赋新值，若该节点在 DOM 内→ characterData 触发→重建
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const KEYWORDS=[{id:'k1',text:'是',enabled:true,important:true,importantNote:'优质',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'}];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false};
(async()=>{
  const b=await require(PW).chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody>'+
    '<tr><td>是否刚需</td><td id="val">是</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.evaluate(()=>{ window.__origTn = document.getElementById('val').firstChild; });
  await page.evaluate(({k,c})=>{KeywordEngine.setupMutationObserver(k,c);KeywordEngine.highlightKeywords(k,c);},{k:KEYWORDS,c:CFG});
  console.log('① 高亮后（预期原节点被摘离）:', await page.evaluate(()=>({inDoc:document.contains(window.__origTn), valHtml:document.getElementById('val').innerHTML})));

  // 模拟方案：清除高亮时「原样接回原始节点」——用一个真实可用的 API，先看引擎是否已有保留原始节点的能力
  // 我们先手动模拟：把高亮 span 还原，并让 firstChild 重新成为可赋值的文本节点
  await page.evaluate(()=>{
    const td=document.getElementById('val');
    const span=td.querySelector('[data-kh-cell-verify-hi-span]');
    if(span){ const tn=document.createTextNode(span.textContent); span.parentNode.replaceChild(tn,span); }
  });
  console.log('\n② 清高亮后，td.firstChild:', await page.evaluate(()=>{
    const fc=document.getElementById('val').firstChild;
    return { tag: fc.nodeType===3?'TEXT':'OTHER', val: fc.nodeValue, inDoc: document.contains(fc) };
  }));

  // 模拟框架翻页：对「清高亮后的 firstChild」赋新值（框架常用写法）
  await page.evaluate(()=>{ document.getElementById('val').firstChild.nodeValue = '否'; });
  // 触发一遍 MutationObserver（characterData）→ 应增量重建
  const after = await page.evaluate(()=>({
    text: document.getElementById('val').textContent.trim(),
    hiSpan: document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,
    html: document.getElementById('val').innerHTML
  }));
  console.log('\n③ 对清高亮后的firstChild赋"否" + 等待重建:');
  console.log('  textContent =', after.text, '(期望"否"=新值进来了)');
  console.log('  高亮span    =', after.hiSpan, '(期望1=重建高亮了新值)');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
