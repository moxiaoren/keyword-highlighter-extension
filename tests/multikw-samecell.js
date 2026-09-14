// 复现问题②（真正场景）：同一右格单元格被两个不同组合词同时命中
// 页面：左格同时含"是否刚需"和"应用标记"两个标题文本，右格="优质"，两组合词都命中同一右格
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'优质',enabled:true,important:true,importantNote:'优质词A',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'优质',enabled:true,important:true,importantNote:'优质词B',cellVerifyEnabled:true,cellVerify:'应用标记',cellVerifyMatchMode:'contain'}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
const snap=async(page,l)=>page.evaluate(({l})=>({
  l,
  spans:Array.from(document.querySelectorAll('[data-kh-cell-verify-hi-span]')).map(e=>e.getAttribute('data-kh-important-note')||e.textContent)
}),{l});
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb">'+
    '<tr><td>是否刚需 应用标记</td><td>优质</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  const kw1=KW;
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  console.log('首扫后:');
  console.log(JSON.stringify(await snap(page,'首扫')));
  // 触发一次重建（整表替换，模拟消失-出现）
  await page.evaluate(()=>{const tb=document.getElementById('tb');tb.innerHTML='<tr><td>是否刚需 应用标记</td><td>优质</td></tr>';});
  await page.waitForTimeout(800);
  console.log('整表替换后(重建):');
  console.log(JSON.stringify(await snap(page,'重建后')));
  console.log('verifySpans数=', (await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length)));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
