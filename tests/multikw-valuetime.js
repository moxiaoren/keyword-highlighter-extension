// 复现问题②：两个不同组合词命中两行，通过「复用行改写单元格文本」触发行级重建，看是否丢词
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
    '<tr><td>是否刚需</td><td>—</td></tr>'+
    '<tr><td>应用标记</td><td>—</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  console.log('首扫(占位—):');
  console.log(JSON.stringify(await snap(page,'首扫')));
  // 值后到：两行右格分别填入真实值（复用行改文本）
  await page.evaluate(()=>{
    const rows=document.querySelectorAll('#tb tr');
    rows[0].cells[1].textContent='是';
    rows[1].cells[1].textContent='高价值';
  });
  await page.waitForTimeout(800);
  console.log('值后到(复用行改写):');
  console.log(JSON.stringify(await snap(page,'值后到')));
  console.log('verifySpans=', (await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length)));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
