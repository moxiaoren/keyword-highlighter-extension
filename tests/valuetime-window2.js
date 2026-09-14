/** 验证修复方案：先 setupMutationObserver，再 highlightKeywords */
const FS=require('fs'),PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=process.argv[2]?PATH.resolve(process.argv[2]):PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'笔记',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'网盘',enabled:true}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(()=>{window.__mkRow=(t,v)=>{const tr=document.createElement('tr');const a=document.createElement('td');a.textContent=t;tr.appendChild(a);const c=document.createElement('td');c.textContent=v;tr.appendChild(c);return tr;};});
  // Phase1: 初始表格，右格空（模拟首扫时数据未到）
  await page.evaluate(()=>{document.getElementById('tb').appendChild(window.__mkRow('刚需应用',''));document.getElementById('tb').appendChild(window.__mkRow('网盘应用','否'));});
  const kw1=KW;
  // 修复方案：先建 observer，再首扫
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  const s1=await page.evaluate(()=>({combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,plain:document.querySelectorAll('[data-kh-highlighted]').length}));
  console.log('Phase1首扫后: 组合词=',s1.combo,'普通词=',s1.plain);
  // Phase2: 值后到，observer 已建立 → 应被捕获
  await page.evaluate(()=>{document.querySelector('#tb tr:first-child td:last-child').textContent='是';});
  await page.waitForTimeout(1500);
  const s2=await page.evaluate(()=>({combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,note:document.querySelectorAll('[data-kh-important-note]').length}));
  console.log('Phase2值后到后: 组合词=',s2.combo,'重要笔记=',s2.note);
  console.log(s2.combo>=1?'  ✅ 修复：组合词被补救':'  ❌ 仍缺失');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
