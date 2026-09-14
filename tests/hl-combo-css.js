// 组合词统一 CSS Highlight 后：重要笔记聚合 + 备注点击坐标命中 + 值后到 专项验证
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'+
    '<table id="t"><tbody>'+
    '<tr id="r1"><td>刚需应用</td><td id="rk1">否</td></tr>'+
    '<tr id="r2"><td>网盘应用</td><td id="rk2">是</td></tr>'+
    '</tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  const kws=[
    {id:'c1',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'刚需应用',note:'这是刚需备注',important:true,importantNote:'刚需重要笔记',bgColor:'#ff0'},
    {id:'c2',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'网盘应用',important:true,importantNote:'网盘重要笔记',bgColor:'#0f0'}
  ];
  await page.evaluate(({k,c})=>{ KeywordEngine.setupMutationObserver(k,c); return KeywordEngine.highlightKeywords(k,c); },{k:kws,c:{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false}});
  await page.waitForTimeout(100);
  let r=await page.evaluate(()=>{
    const imp=KeywordEngine.getImportantPlainHits().map(h=>({text:h.text,note:h.note,adj:h.adj}));
    // 备注点击：取 r2 右格"是"（命中且有备注刚需备注）的正中央
    const rk=document.getElementById('rk2');
    const c=document.createRange(); c.selectNodeContents(rk.firstChild); const rc=c.getBoundingClientRect();
    const hit=KeywordEngine.queryPlainHitAt(rc.left+rc.width/2, rc.top+rc.height/2);
    return {imp, hit: hit?{text:hit.textNode.nodeValue.slice(hit.start,hit.end),adj:hit.adj,note:hit.note,combo:hit.combo}:null, cx:rc.left+rc.width/2, cy:rc.top+rc.height/2, combo:KeywordEngine._plainHits.filter(m=>m.combo).length};
  });
  console.log('① 初始:', JSON.stringify(r));
  // 值后到：r1 右格从"否"改成"是"
  await page.evaluate(()=>{ document.getElementById('rk1').textContent='是'; });
  await page.waitForTimeout(700);
  r=await page.evaluate(()=>{
    const imp=KeywordEngine.getImportantPlainHits().map(h=>({text:h.text,note:h.note,adj:h.adj}));
    // 值后到后 r1右格已是"是"，且 c1 配置了备注(note=这是刚需备注) → 坐标命中
    const rk=document.getElementById('rk1');
    const c=document.createRange(); c.selectNodeContents(rk.firstChild); const rc=c.getBoundingClientRect();
    const hit=KeywordEngine.queryPlainHitAt(rc.left+rc.width/2, rc.top+rc.height/2);
    return {imp, combo:KeywordEngine._plainHits.filter(m=>m.combo).length,
      hit: hit?{text:hit.textNode.nodeValue.slice(hit.start,hit.end),adj:hit.adj,note:hit.note,combo:hit.combo,start:hit.start,end:hit.end}:null,
      cx:rc.left+rc.width/2, cy:rc.top+rc.height/2};
  });
  console.log('② 值后到(rk1否→是):', JSON.stringify(r));
  // 断言核心：①初始组合词命中仅 r2(网盘|是)；②值后到后 r1 也命中(刚需|是)且有备注；③备注点击命中 r1
  const hitOk = r.hit && r.hit.text==='是' && r.hit.adj==='刚需应用' && r.hit.note==='这是刚需备注' && r.hit.combo===true;
  const ok = r.combo===2 && r.imp.some(i=>i.adj==='刚需应用') && r.imp.some(i=>i.adj==='网盘应用') && hitOk;
  console.log(ok?'✅ 组合词重要笔记+值后到+备注点击 全部通过':`❌ 失败 hitOk=${hitOk}`);
  await b.close();
  process.exit(ok?0:1);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
