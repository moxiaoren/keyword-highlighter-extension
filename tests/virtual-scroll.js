// 虚拟滚动场景：滚动时回收视口外 DOM 行(移除) + 插入新行(新增)
// 模拟内容需要滚动才出现。验证首扫后 + 高频滚动回收/重建 下组合词/重要笔记是否稳定
const FS=require('fs'),PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=process.argv[2]?PATH.resolve(process.argv[2]):PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'备注A',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'网盘',enabled:true}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  page.on('pageerror',e=>console.log('  ⚠️ pageerror:',e.message));
  await page.setContent('<!doctype html><html><body><div id="wrap" style="height:400px;overflow:auto"><table><tbody id="tb"></tbody></table></div></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(()=>{
    window.__mkRow=(t,v,idx)=>{const tr=document.createElement('tr');tr.setAttribute('data-idx',idx);
      const a=document.createElement('td');a.textContent=t;tr.appendChild(a);
      const c=document.createElement('td');c.textContent=v;tr.appendChild(c);return tr;};
  });
  // 初始渲染前 20 行（首屏），全带组合词右格=是
  await page.evaluate(()=>{const tb=document.getElementById('tb');for(let i=0;i<20;i++)tb.appendChild(window.__mkRow('刚需应用','是',i));});
  const kw1=KW;
  // content.js 顺序：先 observer 后首扫
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  const snap=async(lbl)=>page.evaluate(({l})=>({lbl:l,
    combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,
    note:document.querySelectorAll('[data-kh-important-note]').length,
    rows:document.querySelectorAll('#tb tr').length}),{l:lbl});
  console.log(await snap('初始'));
  // 模拟滚动：反复 移除全部行→delay→插入新20行  (虚拟滚动回收+重建的简化)
  for(let round=1;round<=6;round++){
    await page.evaluate(()=>{const tb=document.getElementById('tb');tb.innerHTML='';
      const wrap=document.getElementById('wrap');wr=null;},undefined);
    await page.evaluate(({r})=>{const tb=document.getElementById('tb');const st=r*20;
      for(let i=st;i<st+20;i++)tb.appendChild(window.__mkRow('刚需应用','是',i));},{r:round});
    await page.waitForTimeout(700); // 等 flush+refetch(600ms)
    const s=await snap('滚动#'+round); console.log(s,
      s.combo>=20&&s.note>=20?'  ✅':'  ❌ combo或note不足');
  }
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
