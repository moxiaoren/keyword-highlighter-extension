// v1.10.17: 悬浮tooltip + 滚动跟随验证
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage({viewport:{width:800,height:600}});
  await page.setContent('<!doctype html><html><head><style>body{margin:0;height:2000px;}p{font-size:18px;}</style></head><body>'+
    '<div style="height:600px"></div><p id="p">优质客户刚需</p>'+
    '</body></html>');
  // inject css
  await page.addStyleTag({path:PATH.join(ROOT,'content','content.css')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','storage.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.addScriptTag({content:`window.__store={get:async(k)=>{if(k==='noteCardStyle')return {noteCardStyle:{bgColor:'#fff',textColor:'#222',borderColor:'#e3e8f0',borderWidth:'1px',borderRadius:'12px',shadow:'0 8px 26px rgba(0,0,0,.16)',maxWidth:'320px',opacity:'0.97',fontSize:'14px'}};return {};},set:async()=>{}};window.chrome={storage:{local:{get:(k,cb)=>cb({}),set:(o,cb)=>{if(cb)cb();}}},runtime:{onMessage:{addListener:()=>{}}}};`});
  await page.addScriptTag({path:PATH.join(ROOT,'content','note-card.js')});
  await page.evaluate(async (kws)=>{
    window.KWS=kws;
    await KeywordEngine.highlightKeywords(kws,{groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'},shadowDOMEnabled:false});
    await NoteCard.init();
  }, [{id:'k1',text:'刚需',enabled:true,note:'客户刚需备注',important:true},{id:'k2',text:'优质',enabled:true,note:'评分优质备注'}]);
  await page.waitForTimeout(150);
  // 先滚动到 p 元素使其进入视口可见
  await page.evaluate(()=>{ document.getElementById('p').scrollIntoView({block:'center'}); });
  await page.waitForTimeout(300);
  // 悬浮测试：鼠标移到"刚需"上
  const p=await page.evaluate(()=>{const p=document.getElementById('p');const r=p.getBoundingClientRect();return {x:r.left+10,y:r.top+5};});
  console.log('目标坐标:', JSON.stringify(p));
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(250);
  const tip1=await page.evaluate(()=>{const t=document.getElementById('kh-note-tooltip');return t?{display:t.style.display,show:t.classList.contains('kh-tip-show'),text:(t.querySelector('.kh-tip-body')||{}).textContent}:null;});
  console.log('悬浮"刚需":', JSON.stringify(tip1));

  // 点击出卡片
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
  const card1=await page.evaluate(()=>{const c=document.getElementById('kh-note-card');return c?{display:c.style.display,body:(c.querySelector('.kh-note-body')||{}).textContent,pos:{top:c.style.top,left:c.style.left}}:null;});
  console.log('点击卡片:', JSON.stringify(card1));

  // 滚动后卡片是否跟随(重新定位)
  const cardTopBefore = card1 && card1.pos.top;
  await page.evaluate(()=>{ window.scrollBy(0,120); });
  await page.waitForTimeout(400);
  const card2=await page.evaluate(()=>{const c=document.getElementById('kh-note-card');return c?{pos:{top:c.style.top,left:c.style.left}}:null;});
  console.log('滚动后卡片:', JSON.stringify(card2), '滚动前top:', cardTopBefore);

  const tipOk = tip1 && tip1.show===true && /备注/.test(tip1.text||'');
  const cardOk = card1 && card1.display==='block' && /备注/.test(card1.body||'');
  const followOk = cardOk && card2 && cardTopBefore!==card2.pos.top; // 滚动后位置变化=跟随
  console.log('=== 断言 ===', JSON.stringify({tipOk,cardOk,followOk,top1:cardTopBefore,top2:card2&&card2.pos.top}));
  console.log((tipOk&&cardOk&&followOk)?'✅ 悬浮/点击/滚动跟随 全部通过':`❌ ${!tipOk?'悬浮失败 ':''}${!cardOk?'点击失败 ':''}${!followOk?'跟随失败 ':''}`);
  await b.close();
  process.exit((tipOk&&cardOk&&followOk)?0:1);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
