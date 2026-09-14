// 集成测试：content.js 全链路（普通词 CSS Highlight + 翻页赋值 + 重要笔记 + 备注点击）
// 加载 content.js(需 mock chrome) + lib 依赖，模拟真实翻页场景
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const kws=[
  {id:'k1',text:'刚需',enabled:true,important:true,importantNote:'客户刚需',bgColor:'#ffff00'},
  {id:'k2',text:'优质',enabled:true,important:true,importantNote:'评分优质',bgColor:'#00ff00',note:'优质客户'},
  {id:'k3',text:'是',enabled:true,cellVerifyEnabled:true,cellVerify:'是否刚需',important:true,importantNote:'组合笔记',bgColor:'#ff8c00'}
];
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body>'+
    '<div id="app"><table id="t"><tbody id="tb">'+
    '<tr><td>是否刚需</td><td data-v="1">是</td><td>备注</td></tr>'+
    '<tr><td>资质</td><td>优质</td><td>刚需客户</td></tr>'+
    '</tbody></table></div>'+
    '</body></html>');
  // mock chrome 全局
  await page.evaluate((kws)=>{ window.__store={keywords:kws, comboFlipped:true, globalEnabled:true, siteRules:[],siteDisabled:{}, suspendInactiveTab:true, highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}, groups:[] }; }, kws);
  // 注入 mock chrome + Storage
  await page.addScriptTag({content:`
    (function(){
      const store={};
      window.chrome={
        runtime:{ onMessage:{addListener(){}}, sendMessage(){} },
        storage:{ local:{ async get(keys){
            const k = window.__store||{};
            if(keys==null) return k;
            const ks=Array.isArray(keys)?keys:[keys];
            const out={}; ks.forEach(x=>out[x]=k[x]); return out;
          }, async set(obj){ Object.assign(window.__store, obj); }, async remove(k){ delete window.__store[k]; } } }
      };
    })();
  `});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','storage.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','important-note.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','note-card.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','content.js')});
  await page.waitForTimeout(600);

  // ① 普通词高亮（CSS Highlight）检查：文本节点仍在 DOM
  const s1=await page.evaluate(()=>{
    const app=document.querySelector('#app');
    const tn=document.querySelector('td[data-v="1"]').firstChild;
    return {
      hlNames: Array.from(CSS.highlights.keys()),
      textInDoc: document.contains(tn),
      tdText: document.querySelector('td[data-v="1"]').textContent.trim(),
      appUnchanged: document.querySelector('#app').childNodes.length>0
    };
  });
  console.log('① 高亮后: highlight组=', s1.hlNames, ' 文本节点在文档=', s1.textInDoc, ' td文本=', s1.tdText);

  // 记录原始文本节点引用（模拟框架翻页前持有的引用）
  await page.evaluate(()=>{ window.__origTn = document.querySelector('td[data-v="1"]').firstChild; });

  // ② 模拟框架翻页：对原始文本节点引用赋新值（改为"否"）
  await page.evaluate(()=>{ window.__origTn.nodeValue='否'; });
  await page.waitForTimeout(600);
  const s2=await page.evaluate(()=>({
    val: document.querySelector('td[data-v="1"]').textContent.trim(),
    highlightNames: Array.from(CSS.highlights.keys()),
    plainHits: (typeof KeywordEngine!=='undefined'&&KeywordEngine._plainHits)?KeywordEngine._plainHits.length:0
  }));
  console.log('② 翻页赋"否"后: td文本=', s2.val, '(期望=否 → 新值进DOM)');

  // ③ 重要笔记聚合（读引擎注册表）
  const s3=await page.evaluate(()=>{
    const imp=window.ImportantNote||null;
    const hits=(typeof KeywordEngine!=='undefined'&&KeywordEngine.getImportantPlainHits)?KeywordEngine.getImportantPlainHits():[];
    return { hits: hits.map(h=>({text:h.text,note:h.note,bg:h.bg})) };
  });
  console.log('③ 重要笔记(引擎注册表):', JSON.stringify(s3.hits));

  // ④ 备注点击：普通词"优质"坐标命中
  const s4=await page.evaluate(()=>{
    const td=Array.from(document.querySelectorAll('td')).find(t=>t.textContent.trim()==='优质');
    const r=document.createRange(); r.selectNodeContents(td);
    const rect=r.getBoundingClientRect();
    const meta=(typeof KeywordEngine!=='undefined'&&KeywordEngine.queryPlainHitAt)?KeywordEngine.queryPlainHitAt(rect.left+rect.width/2, rect.top+rect.height/2):null;
    return meta?{kwId:meta.kwId, note:meta.note}:null;
  });
  console.log('④ 备注点击命中"优质":', JSON.stringify(s4), s4&&s4.note?('→ note='+s4.note):'');

  await b.close();
  console.log('\n结论:', (s1.textInDoc && s2.val==='否') ? '✅ 新值进DOM+文本节点未摘离' : '❌ 根因未解决');
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
