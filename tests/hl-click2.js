// 调试 queryPlainHitAt offset
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const KWS=[
  {id:'k2',text:'优质',enabled:true,note:'优质客户'},
  {id:'k1',text:'刚需',enabled:true}
];
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<html><body><p id="p">优质客户刚需优质</p></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.evaluate(({k,c})=>{ KeywordEngine.setupMutationObserver(k,c); KeywordEngine.highlightKeywords(k,c); },{k:KWS,c:{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false}});
  const r=await page.evaluate(()=>{
    const p=document.getElementById('p');
    const tn=p.firstChild;
    const rect=p.getBoundingClientRect();
    // 从文本节点各处取 caret
    const pts=[];
    for(let f=0.2;f<=0.9;f+=0.2){
      const x=rect.left+rect.width*f, y=rect.top+rect.height/2;
      const caret=document.caretRangeFromPoint(x,y);
      pts.push({f, x, y, startContainer: caret? (caret.startContainer.nodeType===3?'TEXT':'EL'):null,
        offset: caret? caret.startOffset: -1, txt: caret&&caret.startContainer.nodeType===3? caret.startContainer.nodeValue:'-'});
    }
    const hits=KeywordEngine._plainHits.map(m=>({text:tn.nodeValue.slice(m.start,m.end),s:m.start,e:m.end,note:m.note}));
    // 测试 caretRangeFromPoint 中点
    const cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
    const caretMid=document.caretRangeFromPoint(cx,cy);
    const midHit=KeywordEngine.queryPlainHitAt(cx,cy);
    return {tnText:tn.nodeValue, pts, hits, caretMid: caretMid&&caretMid.startContainer.nodeType===3?{off:caretMid.startOffset, txt:caretMid.startContainer.nodeValue}:null, midHit: midHit?midHit.start:null};
  });
  console.log(JSON.stringify(r,null,2));
  await b.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
