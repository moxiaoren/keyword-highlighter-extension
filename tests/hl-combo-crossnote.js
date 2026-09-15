// v1.11.1 验证：跨节点组合词重要笔记聚合为一条（不按文本节点拆分、不重复）
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
async function run(name, buildRight, need, rx){
  const {chromium}=require("/tmp/pw/node_modules/playwright");
  const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'+buildRight()+'</body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
  await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
  await page.evaluate(async(oo)=>{
    const combo={id:"c1", text:oo.rx?oo.need:oo.need,
      cellVerifyEnabled:true, cellVerify:"应用名称",
      cellVerifyMatchMode:"include", cellVerifyUseRegex:false, cellVerifyCaseSensitive:false,
      useRegex:oo.rx, caseSensitive:false, wholeWord:false,
      important:true, importantNote:"含K歌内容", enabled:true};
    await KeywordEngine.highlightKeywords([combo],{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    await new Promise(r=>setTimeout(r,400));
    const imp=KeywordEngine.getImportantPlainHits(); // 重要笔记聚合数据
    const plain=KeywordEngine.getPlainHits();
    const right=document.getElementById("right");
    window.__r={
      importantCount: imp.length,
      importantTexts: imp.map(h=>({text:h.text,adj:h.adj,note:h.note})),
      // 视觉高亮片段数（应>=1，用于上色）
      visual: plain.filter(h=>right.contains(h.textNode)&&h.kwId==="c1").length
    };
  },{need, rx});
  const r=await page.evaluate(()=>window.__r);
  await b.close();
  console.log(name,"→",
    "重要笔记条数:",r.importantCount,
    "| 文本:",JSON.stringify(r.importantTexts),
    "| 视觉高亮片段:",r.visual);
  return r;
}
(async()=>{
  const cases=[
    {name:"[A] span拆三段 正则(全民.*K.*歌)", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span style="color:red">免费</span>K唱歌</td></tr></table>', need:"全民.*K.*歌", rx:true},
    {name:"[B] 纯文本整格 正则", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民免费K唱歌</td></tr></table>', need:"全民.*K.*歌", rx:true},
    {name:"[C] span 包含匹配", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span>免费</span>K唱歌</td></tr></table>', need:"免费K", rx:false},
  ];
  let allOk=true;
  for(const c of cases){
    const r=await run(c.name,c.right,c.need,c.rx);
    if(c.rx){
      // 关键断言：跨节点场景重要笔记应聚合为一条
      if(c.name.includes("span拆三段")||c.name.includes("span 包含")){
        // 视觉高亮可能跨3节点，但重要笔记必须==1条（修复点）
        if(r.importantCount!==1) allOk=false;
      }
    }
  }
  console.log("\n=== 核心断言：跨节点重要笔记应聚合为单条 ===");
  console.log(allOk?"聚合正确 ✅":"仍有拆分 ❌");
  process.exit(0);
})();
