// 验证 queryPlainHitAt 普通词坐标命中 + 重要笔记聚合 + 备注卡片
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const KWS=[
  {id:'k1',text:'刚需',enabled:true,important:true,importantNote:'客户刚需',bgColor:'#ffff00'},
  {id:'k2',text:'优质',enabled:true,important:true,importantNote:'评分优质',bgColor:'#00ff00',note:'优质客户'},
  {id:'k3',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'是否刚需',important:true,importantNote:'组合笔记',bgColor:'#ff8c00'}
];
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'+
    '<table><tbody>'+
    '<tr><td>是否刚需</td><td>是</td></tr>'+
    '<tr><td>描述</td><td id="d">优质客户刚需</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.evaluate((kws)=>{ window.__kw=kws; }, KWS);
  await page.evaluate(({k,c})=>{ KeywordEngine.setupMutationObserver(k,c); KeywordEngine.highlightKeywords(k,c); },{k:KWS,c:{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000',defaultBorderColor:'transparent',defaultBorderWidth:'1px',defaultBorderRadius:'2px'},shadowDOMEnabled:false}});
  await page.waitForTimeout(100);
  const r=await page.evaluate(()=>{
    const hits=KeywordEngine.getPlainHits().map(h=>({text:h.text,kwId:h.kwId,note:h.note,important:h.important,impNote:h.importantNote}));
    const imp=KeywordEngine.getImportantPlainHits().map(h=>({text:h.text,note:h.note,bg:h.bg,adj:h.adj}));
    // 坐标命中"优质"所在 td 中心
    const td=document.querySelector('td#d');
    const rect=td.getBoundingClientRect();
    const meta=KeywordEngine.queryPlainHitAt(rect.left+rect.width/2, rect.top+rect.height/2);
    return {hits, imp, hit: meta?{text:meta.textNode.nodeValue.slice(meta.start,meta.end),note:meta.note}:null, rect:{x:rect.left, y:rect.top, w:rect.width, h:rect.height}};
  });
  console.log(JSON.stringify(r,null,2));
  await b.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
