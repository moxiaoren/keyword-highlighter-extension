// v1.11.0 修复验证：右格被 span 拆成多文本节点时，组合词正则跨节点匹配
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
function run(label, buildRight, opts){
  return new Promise(resolve=>{
    (async()=>{
      try{
        const {chromium}=require("/tmp/pw/node_modules/playwright");
        const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
        const page=await b.newPage();
        await page.setContent('<!doctype html><html><body>'+buildRight()+'</body></html>');
        await page.addStyleTag({path:PATH.join(ROOT,"content","content.css")});
        await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
        await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
        await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
        await page.evaluate(async(o)=>{
          const combo={id:"c1", text:o.need,
            cellVerifyEnabled:true, cellVerify:"应用名称",
            cellVerifyMatchMode:"include", cellVerifyUseRegex:false, cellVerifyCaseSensitive:false,
            // v1.11.0改指向：核心词匹配开关走 kw.*
            useRegex:o.rx, caseSensitive:false, wholeWord:false,
            important:true,importantNote:"K歌",enabled:true};
          await KeywordEngine.highlightKeywords([combo],{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
          await new Promise(r=>setTimeout(r,400));
          const hits=KeywordEngine.getPlainHits();
          const right=document.getElementById("right");
          let comboHit=false, hitMeta=[];
          hits.forEach(h=>{ if(right.contains(h.textNode)&&h.kwId==="c1"){comboHit=true;hitMeta.push({s:h.start,e:h.end,t:h.textNode.nodeValue});} });
          window.__r={hits:hits.length,comboHit,hitMeta};
        },opts);
        const r=await page.evaluate(()=>window.__r);
        await b.close();
        resolve({label,组合词命中:r.comboHit,命中片段:r.hitMeta});
      }catch(e){ resolve({label,error:String(e)}); }
    })();
  });
}
(async()=>{
  const cases=[
    // B: 免费被span包 → 拆成 全民/免费/K唱歌 三节点
    {name:"B span拆分(免费标红) 正则", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span style="color:red">免费</span>K唱歌</td></tr></table>', rx:true, need:"全民.*K.*歌"},
    // D: 全民被span包
    {name:"D 全民span 正则", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right><span>全民</span>免费K唱歌</td></tr></table>', rx:true, need:"全民.*K.*歌"},
    // E: 包含匹配跨节点(非正则)
    {name:"E span拆分 包含匹配", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span>免费</span>K唱歌</td></tr></table>', rx:false, need:"免费K"},
    // A: 整格纯文本 仍命中
    {name:"A 纯文本 正则", right:()=>'<table border=1><tr><td id=left>应用名称</td><td id=right>全民免费K唱歌</td></tr></table>', rx:true, need:"全民.*K.*歌"},
  ];
  for(const c of cases){
    const r=await run("["+c.name+"]", c.right, {rx:c.rx,need:c.need,exact:false});
    console.log(r.label,"→ 命中:",r.组合词命中,"| 片段:",JSON.stringify(r.命中片段), r.error?("ERR:"+r.error):"");
  }
  process.exit(0);
})();
