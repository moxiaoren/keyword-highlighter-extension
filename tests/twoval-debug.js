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
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"><tr><td>是否刚需 应用标记</td><td>是 高价值</td></tr></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  const afterFirst = await page.evaluate(()=>({hi:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length, html:document.querySelector('#tb td:last-child').innerHTML}));
  console.log('首扫 verify spans=', afterFirst.hi, ' html=',afterFirst.html);
  // 记录 cell 的 _cellVerified 状态 (通过内部 WeakMap 无法直接读，用命中数推断)
  await page.evaluate(()=>{const td=document.querySelector('#tb td:last-child');td.innerHTML='是 高价值';});
  await page.waitForTimeout(900);
  const after= await page.evaluate(()=>({hi:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length, html:document.querySelector('#tb td:last-child').innerHTML, tr:document.querySelector('#tb tr').outerHTML}));
  console.log('重写后 verify spans=', after.hi,'\n tr html=',after.tr);
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
