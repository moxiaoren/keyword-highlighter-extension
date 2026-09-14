// v1.11.0 排查：验证"插件自身UI容器含关键词是否被全量重刷高亮"
// 用 git stash 方式不可行，这里用参数控制：设置 __disableExtUi 时不用 data-kh-ext-ui（模拟修复前）
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
const USE_FIX = process.env.NOFIX !== "1"; // 默认带修复；NOFIX=1 模拟修复前
(async()=>{
  const {chromium}=require("/tmp/pw/node_modules/playwright");
  const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><div id=main>主体内容VIP在此</div></body></html>');
  await page.addStyleTag({path:PATH.join(ROOT,"content","content.css")});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
  await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
  await page.evaluate(async(PATCH)=>{
    window.KWS=[{id:"k1",text:"VIP",enabled:true,note:"VIP客户优先处理",important:true}];
    await KeywordEngine.highlightKeywords(window.KWS,{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    // 模拟悬浮tooltip：普通div直接放body，内容含关键词
    const t=document.createElement("div");
    t.id="kh-note-tooltip";
    if(PATCH) t.setAttribute("data-kh-ext-ui","1"); // 修复后：带隔离标记（同 note-card.js 真实创建）
    t.style.cssText="position:fixed;background:#fff;display:block;z-index:9999";
    t.textContent="VIP客户优先处理";
    document.body.appendChild(t);
    await new Promise(r=>setTimeout(r,500));
    // 触发全量重刷（模拟 refresh/翻页清建后的整页重扫）
    await KeywordEngine.highlightKeywords(window.KWS,{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    await new Promise(r=>setTimeout(r,400));
    const hits=window.KeywordEngine.getPlainHits();
    let inTip=false, inMain=false; const names=[];
    hits.forEach(h=>{ names.push((h.textNode.textContent||"").slice(0,6)); if(t.contains(h.textNode))inTip=true; if(document.getElementById("main").contains(h.textNode))inMain=true; });
    window.__r={hits:hits.length,inTip,inMain,names};
  }, USE_FIX);
  const r=await page.evaluate(()=>window.__r);
  console.log((USE_FIX?"[修复后]":"[修复前 NOFIX]"),"命中",r.hits,"| tooltip内:",r.inTip,"| main内:",r.inMain,"| 文本:",JSON.stringify(r.names));
  // 断言：修复后 tooltip 不应命中；修复前应命中（证明bug存在）
  if(USE_FIX){ console.log(r.inTip?"❌ 修复无效":"✅ 修复后 tooltip 不再被高亮"); }
  else { console.log(r.inTip?"✅ 复现成功：修复前 tooltip 被高亮":"（修复前此路径未命中，需换方式）"); }
  await b.close();
  process.exit(USE_FIX ? (r.inTip?1:0) : (r.inTip?0:1));
})().catch(e=>{console.error("FATAL",e);process.exit(1);});
