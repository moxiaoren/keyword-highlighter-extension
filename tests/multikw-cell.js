// 复现问题②：两个不同组合词命中同一右格（内容相同，如都命中"优质"），重建后是否只留一个词
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);

// 两个组合词，命中同一右格"优质"，笔记内容都设为"优质"类
const KW=[
  {id:'k1',text:'优质',enabled:true,important:true,importantNote:'优质词A',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'优质',enabled:true,important:true,importantNote:'优质词B',cellVerifyEnabled:true,cellVerify:'应用标记',cellVerifyMatchMode:'contain'}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
const snap=async(page,l)=>page.evaluate(({l})=>({
  l,
  verifySpans:Array.from(document.querySelectorAll('[data-kh-cell-verify-hi-span]')).map(e=>({t:e.textContent,note:e.getAttribute('data-kh-important-note')})),
  kwids:Array.from(document.querySelectorAll('[data-kh-keyword-id]')).map(e=>e.getAttribute('data-kh-keyword-id'))
}),{l});
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb">'+
    '<tr><td>是否刚需</td><td>优质</td></tr>'+
    '<tr><td>应用标记</td><td>优质</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  const kw1=KW;
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  console.log('首扫后:');
  console.log(JSON.stringify(await snap(page,'首扫'),null,1));
  console.log('verifySpans数=', (await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length)));
  // 触发一次重建（改一个不影响命中格的其它单元格），模拟"消失-出现"
  await page.evaluate(()=>{const tb=document.getElementById('tb');const tr=document.createElement('tr');const a=document.createElement('td');a.textContent='其他';tr.appendChild(a);const c=document.createElement('td');c.textContent='x';tr.appendChild(c);tb.insertBefore(tr,tb.firstChild);});
  await page.waitForTimeout(500);
  console.log('新增一行后(触发重建):');
  console.log(JSON.stringify(await snap(page,'重建后'),null,1));
  console.log('verifySpans数=', (await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length)));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
