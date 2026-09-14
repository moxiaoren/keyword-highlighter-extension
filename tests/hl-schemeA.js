// v1.11.0 方案A验证：组合词跨节点命中整段 + 普通词"免费"重叠
// 期望：组合词高亮覆盖整段，普通词"免费"视觉让位(无独立高亮)但保留 _plainHits(备注/点击可用)
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
(async()=>{
  const {chromium}=require("/tmp/pw/node_modules/playwright");
  const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'
    +'<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span style="color:red">免费</span>K唱歌</td></tr></table>'
    +'</body></html>');
  await page.addStyleTag({path:PATH.join(ROOT,"content","content.css")});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
  await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
  await page.evaluate(async()=>{
    const kws=[
      {id:"n1",text:"免费",enabled:true,note:"免费备注",useRegex:false,wholeWord:false},
      {id:"c1",text:"全民.*K.*歌",cellVerifyEnabled:true,cellVerify:"应用名称",cellVerifyMatchMode:"include",
       cellVerifyUseRegex:false,cellVerifyCaseSensitive:false,useRegex:true,caseSensitive:false,wholeWord:false,
       important:true,importantNote:"K歌",enabled:true},
    ];
    await KeywordEngine.highlightKeywords(kws,{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    await new Promise(r=>setTimeout(r,400));
    const hits=KeywordEngine.getPlainHits();
    // 检查普通词n1与组合词c1 是否都在 _plainHits（数据都在）
    const right=document.getElementById("right");
    let n1_any=false,c1_any=false;
    hits.forEach(h=>{if(right.contains(h.textNode)){if(h.kwId==='n1')n1_any=true;if(h.kwId==='c1')c1_any=true;}});
    // 检查CSS.highlights: 组合词c1应有range; 普通词n1的range应已被让位移除(不独立高亮)
    const hlRange={}; 
    try{ for(const name of [...CSS.highlights.keys()]){ hlRange[name]=CSS.highlights.get(name).size||0; } }catch(e){}
    // 定位普通词n1的range是否还在CSS.highlights里(被让位则不在)
    let n1Visual=false;
    const n1hit=hits.find(h=>h.kwId==='n1'&&right.contains(h.textNode));
    if(n1hit){ const hl=CSS.highlights.get(n1hit._hlName||''); n1Visual=!!hl&&[...hl].some(r=>((r.startContainer===n1hit.textNode)&&r.startOffset===n1hit.start)); }
    window.__r={n1_data:n1_any, c1_data:c1_any, n1_visual:n1Visual, hl:hlRange, hits:hits.length};
  });
  const r=await page.evaluate(()=>window.__r);
  console.log('普通词数据保留(_plainHits):',r.n1_data);
  console.log('组合词数据保留:',r.c1_data);
  console.log('普通词视觉让位(不再独立高亮):',!r.n1_visual);
  console.log('CSS.highlights:',JSON.stringify(r.hl));
  await page.screenshot({path:'/tmp/kw_schemeA.png'});
  await b.close();
  process.exit(0);
})();
