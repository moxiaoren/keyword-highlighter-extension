// 复现问题②（用户真实场景）：两个组合词在不同行命中，笔记内容相同
// k1=是否刚需-是，k2=应用标记-高价值，两者的重要笔记内容都相同(如"优质")
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'优质',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'高价值',enabled:true,important:true,importantNote:'优质',cellVerifyEnabled:true,cellVerify:'应用标记',cellVerifyMatchMode:'contain'}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
const snap=async(page,l)=>page.evaluate(({l})=>({
  l,
  spans:Array.from(document.querySelectorAll('[data-kh-cell-verify-hi-span]')).map(e=>({t:e.textContent,note:e.getAttribute('data-kh-important-note')||'',cellv:e.getAttribute('data-kh-cell-verify')||''}))
}),{l});
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb">'+
    '<tr><td>是否刚需</td><td>是</td></tr>'+
    '<tr><td>应用标记</td><td>高价值</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  console.log('首扫:');
  console.log(JSON.stringify(await snap(page,'首扫')));
  // 模拟消失-出现：整表替换
  await page.evaluate(()=>{const tb=document.getElementById('tb');tb.innerHTML='<tr><td>是否刚需</td><td>是</td></tr><tr><td>应用标记</td><td>高价值</td></tr>';});
  await page.waitForTimeout(800);
  console.log('整表替换后:');
  console.log(JSON.stringify(await snap(page,'重建后')));
  console.log('verifySpans=', (await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length)));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
