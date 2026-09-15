// v1.11.1 fix 回归：跨节点 aggText=命中区间 + 单列表格分隔行剔除
const PATH=require("path");
const ROOT="/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension";
const {chromium}=require("/tmp/pw/node_modules/playwright");
(async()=>{
  const b=await chromium.launch({executablePath:"/opt/chrome-linux/chrome",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,"lib","utils.js")});
  await page.addScriptTag({content:"window.__store={get:async()=>({}),set:async()=>{}};"});
  await page.addScriptTag({path:PATH.join(ROOT,"lib","keyword-engine.js")});
  await page.evaluate(async()=>{
    // 右格含 span 拆分 + 括号后缀，正则只命中「全民免费K歌」
    document.body.innerHTML='<table border=1><tr><td id=left>应用名称</td><td id=right>全民<span>免费</span>K歌唱 （32/64位应用）</td></tr></table>';
    const combo={id:"c1", text:"全民.*K.*歌",
      cellVerifyEnabled:true, cellVerify:"应用名称",
      cellVerifyMatchMode:"include", cellVerifyUseRegex:false, cellVerifyCaseSensitive:false,
      useRegex:true, caseSensitive:false, wholeWord:false,
      important:true, importantNote:"K歌内容", enabled:true};
    await KeywordEngine.highlightKeywords([combo],{groups:[],highlightStyle:{defaultBgColor:"#ffff00",defaultTextColor:"#000"},shadowDOMEnabled:false});
    await new Promise(r=>setTimeout(r,400));
    const imp=KeywordEngine.getImportantPlainHits();
    window.__r1 = {
      count: imp.length,
      texts: imp.map(h=>h.text),
    };
    // 单列表格分隔行应被剔除
    const html = Utils._buildTable('| 类型 |\n| --- |\n| 应用 |\n| 软件 |');
    const rows = (html.match(/<tr>/g)||[]).length;
    window.__r2 = { html, rows, hasDash: html.includes('---') };
  });
  const r1=await page.evaluate(()=>window.__r1);
  const r2=await page.evaluate(()=>window.__r2);
  await b.close();

  console.log("=== 问题1 跨节点重要笔记文本 ===");
  console.log("条数:",r1.count,"文本:",JSON.stringify(r1.texts));
  const ok1 = r1.count===1 && r1.texts[0]==="全民免费K歌";
  console.log(ok1?"✅ 只展示命中区间「全民免费K歌」，未带括号内容":"❌ 仍含多余内容");

  console.log("\n=== 问题2 单列表格分隔行 ===");
  console.log("tr行数(应为3):",r2.rows,"| 含---:",r2.hasDash);
  const ok2 = r2.rows===3 && !r2.hasDash;
  console.log(ok2?"✅ 分隔行「---」已剔除":"❌ 分隔行未剔除");
  console.log("\nALL:", (ok1&&ok2)?"PASS ✅":"FAIL ❌");
  await b.close();
  process.exit(ok1&&ok2?0:1);
})();
