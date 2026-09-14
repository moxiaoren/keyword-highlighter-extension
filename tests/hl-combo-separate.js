// v1.11.0 改指向验证：标题词(cellVerify)与核心词(text)匹配开关完全分离
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
function run(label, o){
  return new Promise(resolve=>{
    (async()=>{
      try{
        const {chromium}=require("/tmp/pw/node_modules/playwright");
        const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
        const page=await b.newPage();
        await page.setContent('<!doctype html><html><body><table border=1><tr><td id=left>'+o.left+'</td><td id=right>'+o.right+'</td></tr></table></body></html>');
        await page.addStyleTag({path:PATH.join(ROOT,"content","content.css")});
        await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
        await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
        await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
        await page.evaluate(async(o)=>{
          const combo={id:"c1",
            text:o.core,                          // 核心词(右格)
            cellVerifyEnabled:true, cellVerify:o.title,  // 标题词(左格)
            // 标题词匹配（组合词区开关）
            cellVerifyMatchMode:o.tExact?"exact":"include",
            cellVerifyCaseSensitive:!!o.tCase, cellVerifyUseRegex:!!o.tRegex,
            // 核心词匹配（基本区开关）
            wholeWord:!!o.cExact, caseSensitive:!!o.cCase, useRegex:!!o.cRegex,
            important:true,importantNote:"命中",enabled:true};
          await KeywordEngine.highlightKeywords([combo],{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
          await new Promise(r=>setTimeout(r,400));
          const hits=KeywordEngine.getPlainHits();
          const right=document.getElementById("right");
          let inRight=[]; hits.forEach(h=>{if(right.contains(h.textNode))inRight.push(h.textNode.nodeValue.slice(h.start,h.end));});
          window.__r={hit:inRight.length>0, txt:inRight};
        },o);
        const r=await page.evaluate(()=>window.__r);
        await b.close();
        resolve({label,期待:o.expect,结果:r.hit,命中文本:r.txt});
      }catch(e){ resolve({label,期待:o.expect,error:String(e)}); }
    })();
  });
}
(async()=>{
  const cases=[
    // 标题词全词：左"包名"，标题词全词(exact)，标题格恰好"包名" → 标题精确匹配生效
    {name:"标题词全词=精确匹配标题格", left:"包名", right:"ab其他", core:"ab", title:"包名", tExact:true, cExact:false, expect:true},
    // 标题词全词：左"包名xx"，标题词全词，标题格"包名xx"不是恰"包名" → 不命中(精确)
    {name:"标题词全词-不精确则不命中", left:"包名xx", right:"ab", core:"ab", title:"包名", tExact:true, cExact:false, expect:false},
    // 标题词包含：左"包名xx"，标题词非全词 → 命中(包含)
    {name:"标题词包含-命中", left:"包名xx", right:"ab", core:"ab", title:"包名", tExact:false, cExact:false, expect:true},
    // 核心词整格：右"ab其他"，核心全词(exact) → 不命中(整格不等于ab)
    {name:"核心词整格-右格有他文不命中", left:"包名", right:"ab其他", core:"ab", title:"包名", tExact:false, cExact:true, expect:false},
    // 核心词整格：右恰"ab"，核心全词(exact) → 命中
    {name:"核心词整格-整格相等命中", left:"包名", right:"ab", core:"ab", title:"包名", tExact:false, cExact:true, expect:true},
    // 标题词正则：标题词用正则
    {name:"标题词正则", left:"A12B", right:"ab", core:"ab", title:"A\\d+B", tExact:false, tRegex:true, cExact:false, expect:true},
    // 组合：标题词全词+核心词整格都满足
    {name:"标题精确+核心整格", left:"包名", right:"ab", core:"ab", title:"包名", tExact:true, cExact:true, expect:true},
  ];
  for(const c of cases){
    const r=await run("["+c.name+"]", c);
    const pass = r.error? false : (r.结果===c.expect);
    console.log((pass?"✅":"❌"),r.label,"期待",c.expect,"→",r.结果, r.error?("ERR:"+r.error):("命中["+r.命中文本+"]"));
  }
  process.exit(0);
})();
