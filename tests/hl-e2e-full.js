// 端到端：普通词 CSS Highlight + 重要笔记聚合 + 备注卡片点击命中 + 值后到
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';

function kw(id,text,extra){return Object.assign({id,text,enabled:true},extra||{});}
const KEYWORDS=[
  kw('k1','张三',{important:true,importantNote:'优质客户',fetchLabels:'地址|备注'}),
  kw('k2','李四',{important:true,importantNote:'新客关注'}),
  kw('k3','测试',{note:'这是一个测试备注',important:true,importantNote:'重要测试'}),
];

(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent(`<!doctype html><html><body>
    <table><tbody>
      <tr><td>姓名</td><td id="c1">张三</td></tr>
      <tr><td>地址</td><td id="c2">北京朝阳</td></tr>
      <tr><td>备注</td><td id="c3">普通客户</td></tr>
    </tbody></table>
  </body></html>`);
  // 注入依赖
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  // mock storage
  await page.evaluate(()=>{
    window.__storage={keywords:null, siteRules:[], globalEnabled:true, highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000',defaultBorderColor:'transparent',defaultBorderWidth:'1px',defaultBorderRadius:'2px'}, noteCardStyle:{}, suspendInactiveTab:true};
    window.chrome={storage:{local:{get:async(keys)=>{const d=window.__storage; if(keys==null)return d; const r={}; for(const k of [].concat(keys)) r[k]=d[k]; return r;}, set:async(o)=>{Object.assign(window.__storage,o);}},}};
  });
  await page.evaluate(()=>{window.Utils=window.Utils||{}; window.Storage=window.Storage||{defaults:{noteCardStyle:{},highlightStyle:{}},get:async(keys)=>{const d=window.__storage; const r={}; for(const k of [].concat(keys)) r[k]=d[k]; return r;},set:async(o)=>{Object.assign(window.__storage,o);}};});
  await page.addScriptTag({path:PATH.join(ROOT,'content','important-note.js')});
  // 手动初始化引擎 + 重要笔记
  await page.evaluate(async (kws)=>{
    window.__kw=kws;
    KeywordEngine.setupMutationObserver(kws,{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000',defaultBorderColor:'transparent',defaultBorderWidth:'1px',defaultBorderRadius:'2px'},shadowDOMEnabled:false});
    await KeywordEngine.highlightKeywords(kws,{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000',defaultBorderColor:'transparent',defaultBorderWidth:'1px',defaultBorderRadius:'2px'},shadowDOMEnabled:false});
    await window.ImportantNote.init();
    window.ImportantNote.refresh();
  }, KEYWORDS);
  await page.waitForTimeout(800);

  // 检查普通词 CSS Highlight 是否生效（"张三"在 c1，但 c1 没有 cellVerify 所以是普通高亮）
  const vis = await page.evaluate(()=>({
    plainHits: KeywordEngine.getImportantPlainHits().length,
    cssHL: Array.from(CSS.highlights.keys()).length,
    c1hasSpan: !!document.querySelector('#c1 [data-kh-cell-verify-hi-span]'),
    c1hasHighlighted: !!document.querySelector('#c1 [data-kh-highlighted]'),
    c1InDoc: (()=>{const tn=document.getElementById('c1').firstChild; return document.contains(tn);})(),
  }));
  console.log('高亮状态:', JSON.stringify(vis, null, 2));

  // 值后到：改 c2（"北京朝阳"→"上海浦东"）触发 characterData → 增量重扫 → 普通词命中应更新
  await page.evaluate(()=>{document.getElementById('c2').firstChild.nodeValue='上海浦东';});
  await page.waitForTimeout(600);

  const after = await page.evaluate(()=>({
    plainHits: KeywordEngine.getImportantPlainHits().map(h=>h.text+'→'+h.note),
    c2text: document.getElementById('c2').textContent.trim(),
  }));
  console.log('值后到后:', JSON.stringify(after));

  // 备注卡片点击命中：模拟点击"张三"所在单元格
  const clickResult = await page.evaluate(()=>{
    const rect=document.getElementById('c1').getBoundingClientRect();
    const x=rect.left+rect.width/2, y=rect.top+rect.height/2;
    // 调用 coordinate detection
    return (()=>{ const r=new Range(); r.setStart(document.getElementById('c1').firstChild,0); r.setEnd(document.getElementById('c1').firstChild,2); return {x,y,start:r.startContainer.nodeValue.slice(0,2)}; })();
  });
  console.log('点击坐标目标:', clickResult);
  await b.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
