// 真实场景：同一右格含两个值（如"是 高价值"），两个组合词分别命中其中不同值
// 左格="是否刚需 应用标记"，右格="是 高价值"（同一格两值）
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'优质A',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'高价值',enabled:true,important:true,importantNote:'优质B',cellVerifyEnabled:true,cellVerify:'应用标记',cellVerifyMatchMode:'contain'}
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
    '<tr><td>是否刚需 应用标记</td><td>是 高价值</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  console.log('首扫:');
  console.log(JSON.stringify(await snap(page,'首扫')));
  // 值后到：整格文本重写，触发 cell 级重建
  await page.evaluate(()=>{const td=document.querySelector('#tb td:last-child');td.innerHTML='是 高价值';});
  await page.waitForTimeout(800);
  console.log('整格重写(值后到):');
  console.log(JSON.stringify(await snap(page,'重写后')));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
