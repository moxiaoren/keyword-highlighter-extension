// v1.11.1: 核心词匹配列/标题词匹配列(各自跟随对应词) + 单组弹窗 + 批量修改 UI 验证
const PATH=require('path');
const http=require('http');
const fs=require('fs');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
function serve(root){return http.createServer((req,res)=>{let p=req.url.split('?')[0];if(p==='/')p='/options/options.html';let fp=PATH.join(root,p);try{if(res.headersSent)return;const ext=PATH.extname(fp);res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});res.end(fs.readFileSync(fp));}catch(e){try{if(!res.headersSent)res.writeHead(404);}catch(_){}res.end('nf');}});}
(async()=>{
  const {chromium}=require(PW);
  const srv=serve(ROOT); await new Promise(r=>srv.listen(0,r));
  const port=srv.address().port;
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage({viewport:{width:1500,height:900}});
  const seed={version:'1.11.1',comboFlipped:true,globalEnabled:true,groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000000'},noteCardStyle:{},importantNote:{imgSize:70},matchSettings:{},noteFormat:'',shadowDOMEnabled:true,suspendInactiveTab:false,pageResidualClean:false,
    keywords:[
      {id:'k1',text:'刚需',enabled:true,note:'',important:false,caseSensitive:true,wholeWord:false,useRegex:false,createdAt:1,updatedAt:100},
      {id:'k2',text:'否',enabled:true,note:'',important:false,cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'exact',cellVerifyCaseSensitive:false,cellVerifyUseRegex:true,caseSensitive:false,wholeWord:true,useRegex:false,createdAt:2,updatedAt:101},
      {id:'k3',text:'优质',enabled:true,note:'',important:false,caseSensitive:false,wholeWord:false,useRegex:false,createdAt:3,updatedAt:102}
    ]};
  await page.addInitScript((sd)=>{window.__store=Object.assign({},sd);
    window.chrome={runtime:{getManifest:()=>({version:sd.version})},tabs:{query:async()=>[],sendMessage:()=>new Promise(r=>r())},
      storage:{local:{async get(k){if(k==null)return JSON.parse(JSON.stringify(window.__store));if(Array.isArray(k)){const o={};k.forEach(x=>{if(x in window.__store)o[x]=window.__store[x];});return o;}if(typeof k==='string')return {[k]:window.__store[k]};return {};},
        async set(it){Object.assign(window.__store,it);},async remove(ks){const a=Array.isArray(ks)?ks:[ks];a.forEach(x=>delete window.__store[x]);},async clear(){window.__store={};}}}};
  },seed);
  await page.goto(`http://127.0.0.1:${port}/options/options.html`,{waitUntil:'networkidle'});
  await page.waitForTimeout(300);

  // 1. 校验两列渲染（核心列跟随关键词、标题列跟随标题词）
  const rows=await page.evaluate(()=>[...document.querySelectorAll('#keywordTableBody tr')].map(tr=>{
    const kw=tr.querySelector('.kw-col-name').textContent.trim();
    const core=tr.querySelector('.col-kw-match').textContent.replace(/\s+/g,' ').trim();
    const coreChips=[...tr.querySelectorAll('.col-kw-match .mr-chip')].map(c=>c.textContent.trim());
    const title=tr.querySelector('.col-title-match').textContent.replace(/\s+/g,' ').trim();
    const titleChips=[...tr.querySelectorAll('.col-title-match .mr-chip')].map(c=>c.textContent.trim());
    return {kw,core,coreChips,title,titleChips};
  }));
  console.log('行渲染:', JSON.stringify(rows,null,1));
  const k1=rows.find(r=>r.kw==='刚需'), k2=rows.find(r=>r.kw==='否'), k3=rows.find(r=>r.kw==='优质');
  const pass1 = k1.coreChips.length===1 && k1.coreChips[0]==='大小写' && k1.title.trim()==='—';
  const pass2core = k2.coreChips.includes('全词') && k2.coreChips.length===1;
  const pass2title = k2.titleChips.sort().join()==='正则,全词'.split(',').sort().join(); // 正则 + 全词(标题)
  const pass3 = k3.core.trim()==='默认' && k3.title.trim()==='—';
  console.log(`[1]普通词核心列=${pass1} 组合词核心列=${pass2core} 组合词标题列=${pass2title} 默认/空=${pass3}`);

  // 2a. 点 k2 核心列 → 只显示核心组弹窗
  await page.click('#keywordTableBody tr[data-id="k2"] .col-kw-match .kw-match-pill');
  await page.waitForTimeout(200);
  const mCore=await page.evaluate(()=>({title:document.getElementById('matchRuleTitle').textContent,open:document.getElementById('matchRuleModal').style.display,
    corePanel:document.getElementById('matchRuleCorePanel').style.display,titlePanel:document.getElementById('matchRuleTitlePanel').style.display,
    coreWw:document.getElementById('mrCoreWhole').checked,coreCs:document.getElementById('mrCoreCase').checked,
    titleRx:document.getElementById('mrTitleRegex').checked}));
  console.log('[2a]核心弹窗:', JSON.stringify(mCore));
  const pass4 = mCore.title.includes('核心') && mCore.corePanel!=='none' && mCore.titlePanel==='none' && mCore.coreWw===true;

  await page.click('#matchRuleClose'); await page.waitForTimeout(120);

  // 2b. 点 k2 标题列 → 只显示标题组弹窗
  await page.click('#keywordTableBody tr[data-id="k2"] .col-title-match .kw-match-pill');
  await page.waitForTimeout(200);
  const mTitle=await page.evaluate(()=>({title:document.getElementById('matchRuleTitle').textContent,
    corePanel:document.getElementById('matchRuleCorePanel').style.display,titlePanel:document.getElementById('matchRuleTitlePanel').style.display,
    titleRx:document.getElementById('mrTitleRegex').checked,titleWw:document.getElementById('mrTitleWhole').checked,titleCs:document.getElementById('mrTitleCase').checked}));
  console.log('[2b]标题弹窗:', JSON.stringify(mTitle));
  const pass5 = mTitle.title.includes('标题词') && mTitle.corePanel==='none' && mTitle.titlePanel!=='none' && mTitle.titleRx===true && mTitle.titleWw===true;

  // 3. 标题弹窗勾选"区分大小写" + 保存 → 存储更新 + 表格刷新
  await page.check('#mrTitleCase');
  await page.click('#matchRuleSave');
  await page.waitForTimeout(300);
  const saved=await page.evaluate(()=>{const k=window.__store.keywords.find(x=>x.id==='k2');return {tCs:k.cellVerifyCaseSensitive,tMode:k.cellVerifyMatchMode,tRx:k.cellVerifyUseRegex,cWw:k.wholeWord};});
  console.log('[3]保存后:', JSON.stringify(saved));
  const pass6 = saved.tCs===true && saved.tMode==='exact' && saved.tRx===true && saved.cWw===true;
  await page.waitForTimeout(200);
  const after=await page.evaluate(()=>({closed:document.getElementById('matchRuleModal').style.display,
    titleChips:[...document.querySelectorAll('#keywordTableBody tr[data-id="k2"] .col-title-match .mr-chip')].map(c=>c.textContent.trim())}));
  console.log('[4]刷新后:', JSON.stringify(after));
  const pass7 = after.closed==='none' && after.titleChips.includes('大小写') && after.titleChips.includes('正则');

  // 5. 批量：勾选 k1,k3 → 批量开 核心正则 + 清空标题词
  await page.check('#keywordTableBody tr[data-id="k1"] .row-check');
  await page.check('#keywordTableBody tr[data-id="k3"] .row-check');
  await page.waitForTimeout(100);
  await page.click('[data-bulk="matchrule"]');
  await page.waitForTimeout(200);
  await page.check('#bmrCoreRegex');
  await page.click('#bulkMatchRuleSave');
  await page.waitForTimeout(500);
  const bulkAfter=await page.evaluate(()=>({k1:window.__store.keywords.find(x=>x.id==='k1').useRegex,k3:window.__store.keywords.find(x=>x.id==='k3').useRegex}));
  console.log('[5]批量后:', JSON.stringify(bulkAfter));
  const pass8 = bulkAfter.k1===true && bulkAfter.k3===true;

  console.log('\n=== 结果 ===');
  const ok=pass1&&pass2core&&pass2title&&pass3&&pass4&&pass5&&pass6&&pass7&&pass8;
  console.log('普通词列:',pass1,'组合核心:',pass2core,'组合标题:',pass2title,'默认:',pass3,'核心弹窗:',pass4,'标题弹窗:',pass5,'保存:',pass6,'刷新:',pass7,'批量:',pass8);
  console.log(ok?'ALL PASS ✅':'FAIL ❌');
  await b.close(); srv.close(); process.exit(ok?0:1);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
