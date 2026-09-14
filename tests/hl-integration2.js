// 集成测试2：聚焦「普通词」格在框架翻页赋值时，新值能进DOM（CSS Highlight 不摘离文本节点）
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const kws=[
  {id:'k1',text:'刚需',enabled:true,important:true,importantNote:'客户刚需',bgColor:'#ffff00'},
  {id:'k2',text:'优质',enabled:true,important:true,importantNote:'评分优质',bgColor:'#00ff00',note:'优质客户'}
];
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><div id="app"><table id="t"><tbody id="tb">'+
    '<tr><td data-t="desc">这是刚需客户需求</td></tr>'+
    '<tr><td data-t="grade">优质客户</td></tr>'+
    '</tbody></table></div></body></html>');
  await page.evaluate((kws)=>{ window.__store={keywords:kws, comboFlipped:true, globalEnabled:true, siteRules:[],siteDisabled:{}, suspendInactiveTab:true, highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}, groups:[] }; }, kws);
  await page.addScriptTag({content:`(function(){ window.chrome={ runtime:{onMessage:{addListener(){}},sendMessage(){}}, storage:{ local:{ async get(keys){ const k=window.__store||{}; if(keys==null)return k; const ks=Array.isArray(keys)?keys:[keys]; const out={};ks.forEach(x=>out[x]=k[x]);return out; }, async set(obj){Object.assign(window.__store,obj);}, async remove(k){delete window.__store[k];} } } }; })();`});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','storage.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','important-note.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','note-card.js')});
  await page.addScriptTag({path:PATH.join(ROOT,'content','content.js')});
  await page.waitForTimeout(600);

  const s1=await page.evaluate(()=>{
    const tn=document.querySelector('td[data-t="desc"]').firstChild;
    return { hl: Array.from(CSS.highlights.keys()), inDoc: document.contains(tn), text: tn.nodeValue };
  });
  console.log('① 普通词高亮: groups=', s1.hl, ' 文本节点在文档=', s1.inDoc, ' 格文本=', s1.text);

  // 记录原始文本节点引用（模拟框架持有）
  await page.evaluate(()=>{ window.__descTn = document.querySelector('td[data-t="desc"]').firstChild; });

  // ② 框架翻页：对原文本节点引用赋新值（把整格换成下一页内容）
  await page.evaluate(()=>{ window.__descTn.nodeValue='下一行全新内容'; });
  await page.waitForTimeout(600);
  const s2=await page.evaluate(()=>({ val: document.querySelector('td[data-t="desc"]').textContent.trim() }));
  console.log('② 翻页赋"下一行全新内容"后 格文本=', s2.val, '→', s2.val==='下一行全新内容'?'✅新值进DOM':'❌残留');

  // ③ 翻页后再赋一个含关键词的值，验证能重新高亮新词
  await page.evaluate(()=>{ window.__descTn.nodeValue='新增优质需求'; });
  await page.waitForTimeout(600);
  const s3=await page.evaluate(()=>({
    val: document.querySelector('td[data-t="desc"]').textContent.trim(),
    hits: (typeof KeywordEngine!=='undefined'&&KeywordEngine.getImportantPlainHits)?KeywordEngine.getImportantPlainHits().map(h=>h.text):[]
  }));
  console.log('③ 再赋"新增优质需求"后 格文本=', s3.val, ' 注册表重要词=', JSON.stringify(s3.hits));
  await b.close();
  console.log('\n结论:', s2.val==='下一行全新内容'?'✅ 普通词根因已解决：翻页新值能进DOM':'❌ 普通词仍残留');
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
