const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
(async()=>{
  const {chromium}=require("/tmp/pw/node_modules/playwright");
  const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><div id=main>VIP与普通内容混合</div></body></html>');
  await page.addStyleTag({path:PATH.join(ROOT,"content","content.css")});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
  await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
  await page.addScriptTag({path:PATH.join(ROOT,"content","note-card.js")});
  await page.addScriptTag({path:PATH.join(ROOT,"content","important-note.js")});
  await page.evaluate(async()=>{
    window.__log=[];
    window.KeywordEngine.onHighlight=function(){ window.__log.push(1); };
    window.KWS=[{id:"k1",text:"VIP",enabled:true,note:"VIP客户优先处理",important:true}];
    await KeywordEngine.highlightKeywords(window.KWS,{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    // 创建三个真实插件UI容器，内部塞含关键词文本
    await NoteCard.init();
    const card=document.getElementById("kh-note-card");
    if(card){ card.style.display="block"; card.innerHTML="VIP客户优先处理"; }
    const host=document.createElement("div"); host.id="kh-important-note-host"; host.setAttribute("data-kh-ext-ui","1"); host.style.display="block"; host.textContent="VIP客户优先处理"; document.body.appendChild(host);
    await new Promise(r=>setTimeout(r,1200)); // 触发增量 & 全量重刷路径
    // 触发全量重刷（模拟翻页/切Tab恢复）
    await KeywordEngine.highlightKeywords(window.KWS,{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    await new Promise(r=>setTimeout(r,400));
    const hits=window.KeywordEngine.getPlainHits();
    const list=[];
    let inCard=false,inHost=false,inTip=false;
    hits.forEach(h=>{ list.push(h.textNode.textContent.slice(0,10)); if(card&&card.contains(h.textNode))inCard=true; if(host.contains(h.textNode))inHost=true; const t=document.getElementById("kh-note-tooltip"); if(t&&t.contains(h.textNode))inTip=true; });
    // 主内容应命中
    let mainHit=false;
    hits.forEach(h=>{ if(document.getElementById("main").contains(h.textNode))mainHit=true; });
    window.__result={hits:hits.length,inCard,inHost,inTip,mainHit,list};
  });
  const r=await page.evaluate(()=>window.__result);
  console.log("命中注册表数:",r.hits,"| 主内容命中:",r.mainHit);
  console.log("工具栏tooltip命中:",r.inTip,"| 备注卡片命中:",r.inCard,"| 重要笔记命中:",r.inHost);
  const ok = r.mainHit && !r.inCard && !r.inHost && !r.inTip;
  console.log(ok?"✅ 插件UI容器不再被高亮 (主内容仍正常高亮)":"❌ "+(r.mainHit?"UI容器仍被高亮":"主内容也未高亮"));
  await b.close();process.exit(ok?0:1);
})().catch(e=>{console.error("FATAL",e);process.exit(1);});
