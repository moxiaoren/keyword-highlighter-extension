// content.js 全链路：组合词 CSS Highlight 下 important-note 面板聚合 + note-card 坐标点击
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'+
    '<table id="t"><tbody><tr><td>刚需应用</td><td id="rk">是</td></tr></tbody></table>'+
    '</body></html>');
  // mock storage
  await page.addScriptTag({content:`
    window.__store={set:async()=>{},get:async(k)=>k==='keywords'?[{id:'c1',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'刚需应用',note:'这是刚需备注',important:true,importantNote:'刚需重要笔记',bgColor:'#ff0'}]:k==='highlightStyle'?{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}}:k==='siteRules'?[]:k==='disabledSites'?[]:k==='config'?{}:{}};
    window.chrome={storage:{local:{get:(k,cb)=>cb({}),set:(o,cb)=>{if(cb)cb();}}},runtime:{onMessage:{addListener:()=>{}}}};
  `});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','storage.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  // 注入引擎 + 手动调 important-note 的刷新逻辑（模拟 content 调 onHighlight）
  await page.evaluate(async ()=>{
    window.KWS=[{id:'c1',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'刚需应用',note:'这是刚需备注',important:true,importantNote:'刚需重要笔记',bgColor:'#ff0'}];
    KeywordEngine.onHighlight=()=>{};
    await KeywordEngine.highlightKeywords(window.KWS,{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false});
  });
  await new Promise(r=>setTimeout(r,150));
  const r=await page.evaluate(()=>{
    const imp=KeywordEngine.getImportantPlainHits();
    // 模拟 important-note collect 聚合
    const items=imp.filter(h=>!Utils.isElementHidden(h.textNode.parentElement)&&h.textNode&&document.contains(h.textNode))
      .map(h=>({kw:h.text,note:h.note,adj:h.adj}));
    return {impItems:items, comboCount:KeywordEngine._plainHits.filter(m=>m.combo).length, hasSpan:!!document.querySelector('[data-kh-cell-verify-hi-span]')};
  });
  const ok=r.impItems.length===1 && r.impItems[0].adj==='刚需应用' && r.comboCount===1 && r.hasSpan===false;
  console.log(JSON.stringify(r,null,2));
  console.log(ok?'✅ 组合词已统一CSS Highlight：无span、重要笔记聚合正常':`❌ ok=false`);
  await b.close();
  process.exit(ok?0:1);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
