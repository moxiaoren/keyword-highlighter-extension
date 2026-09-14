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
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"><tr><td>是否刚需 应用标记</td><td>优质</td></tr></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  const info = await page.evaluate(()=>{
    const rt = document.querySelector('td:last-child');
    const all = Array.from(rt.querySelectorAll('*'));
    return {
      cellInnerHTML: rt.innerHTML,
      spans: all.filter(e=>e.hasAttribute&&e.hasAttribute('data-kh-cell-verify-hi-span')).map(e=>`${e.textContent} note=${e.getAttribute('data-kh-important-note')||''}`),
      textNodes: Array.from(rt.childNodes).map(n=>n.nodeType===3?('TEXT"'+n.nodeValue+'"'):(n.tagName+'('+n.textContent+')'))
    };
  });
  console.log(JSON.stringify(info,null,1));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
