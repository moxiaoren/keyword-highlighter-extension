// 复现「已高亮/重要笔记 → 过一会自动消失」
// 用与 content.js 相同顺序：先 setupMutationObserver 再 highlightKeywords（v1.10.11）
// 观察首扫自身引入的 DOM 写入被 observer 捕捉后，300ms flush 重建是否会清掉成果
const FS=require('fs'),PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=process.argv[2]?PATH.resolve(process.argv[2]):PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'笔记A',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'网盘',enabled:true}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  page.on('pageerror',e=>console.log('  ⚠️ pageerror:',e.message));
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(()=>{
    window.__mkRow=(t,v)=>{const tr=document.createElement('tr');const a=document.createElement('td');a.textContent=t;tr.appendChild(a);const c=document.createElement('td');c.textContent=v;tr.appendChild(c);return tr;};
    document.getElementById('tb').appendChild(window.__mkRow('刚需应用','是'));
    document.getElementById('tb').appendChild(window.__mkRow('网盘应用','否'));
  });
  const kw1=KW;
  // content.js v1.10.11 顺序：先 observer，再首扫
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  const snap=async(lbl)=>page.evaluate(({l})=>{
    return {lbl:l,
      combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,
      plain:document.querySelectorAll('[data-kh-highlighted]').length,
      note:document.querySelectorAll('[data-kh-important-note]').length,
      imp:document.querySelectorAll('[data-kh-important]').length};
  },{l:lbl});
  console.log(await snap('首扫后(立即)'));
  await page.waitForTimeout(500);
  console.log(await snap('+500ms'));
  await page.waitForTimeout(1000);
  console.log(await snap('+1500ms'));
  // 再触发一次列表刷新（移除再插入整行，模拟换页）
  await page.evaluate(()=>{const tb=document.getElementById('tb');tb.innerHTML='';setTimeout(()=>{tb.appendChild(window.__mkRow('刚需应用','是'));tb.appendChild(window.__mkRow('网盘应用','否'));},50);});
  console.log(await snap('换页后(立即)'));
  await page.waitForTimeout(1000);
  console.log(await snap('换页后+1000ms'));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
