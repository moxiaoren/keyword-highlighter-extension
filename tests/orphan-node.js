// 验证用户假设：高亮 replaceChild 摘离原文本节点 → 框架翻页持有原节点引用赋新值 → 新内容进不了DOM
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
  // 高亮前：模拟框架保存「原始文本节点」引用
  await page.evaluate(()=>{ window.__origTn = document.getElementById('val').firstChild; });
  await page.evaluate(({k,c})=>{KeywordEngine.setupMutationObserver(k,c);KeywordEngine.highlightKeywords(k,c);},{k:KEYWORDS,c:CFG});
  const before = await page.evaluate(()=>({
    origParent: window.__origTn.parentNode ? window.__origTn.parentNode.tagName : 'NULL(已脱离文档)',
    valHtml: document.getElementById('val').innerHTML,
    inDoc: document.contains(window.__origTn)
  }));
  console.log('高亮后:');
  console.log('  原文本节点 parentNode =', before.origParent);
  console.log('  原文本节点是否仍在文档 =', before.inDoc);
  console.log('  右格 innerHTML =', before.valHtml);

  // 模拟框架翻页：对「原始文本节点」赋值下一页内容
  await page.evaluate(()=>{ window.__origTn.nodeValue = '否'; });
  await page.waitForTimeout(600);
  const after = await page.evaluate(()=>({
    valText: document.getElementById('val').textContent.trim(),
    valHtml: document.getElementById('val').innerHTML,
    hiSpan: document.querySelectorAll('[data-kh-cell-verify-hi-span]').length
  }));
  console.log('\n模拟框架对原节点赋值"否"后:');
  console.log('  单元格.textContent =', after.valText, '(应为"否"若赋值生效)');
  console.log('  单元格 innerHTML  =', after.valHtml);
  console.log('  高亮 span 数      =', after.hiSpan);
  console.log('\n结论:', after.valText==='否' ? '✅ 新内容进来了(赋值生效到DOM)' : '❌ 新内容没进来=页面仍是旧值(赋值落在脱离文档的孤儿节点上)');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
