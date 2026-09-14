// 复现问题①：普通重要笔记抓取字段，右侧备注是 flex 同行多元素，被拆成多行表格
// 页面：组合词 左格=标题、右格flex三个div；组合词配置 fetchLabels 抓取"备注"
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
// 组合词命中"刚需应用"+右格"备注"，抓取字段=fetchLabels:"备注"
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'预设',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain',fetchLabels:'备注'}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
const HTML='<!doctype html><html><body><table><tbody id="tb">'+
  '<tr><td>刚需应用</td><td id="note">是</td></tr>'+
  '<tr><td>备注</td><td style="display:flex"><div>备注1内容</div><div>备注2内容</div><div>备注3内容</div></td></tr>'+
  '</tbody></table></body></html>';
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent(HTML);
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:KW,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:KW,c:CFG});
  await page.waitForTimeout(300);
  const res = await page.evaluate(()=>{
    const span = document.querySelector('[data-kh-cell-verify-hi-span]');
    return { note: span ? (span.getAttribute('data-kh-important-note')||'') : '(无span)' };
  });
  console.log('重要笔记内容:');
  console.log(res.note);
  // 展示为纯文本行（去掉HTML标签）
  const plain = res.note.replace(/<[^>]+>/g,'|').replace(/\n+/g,'\n').split('\n').map(s=>s.replace(/\|+/g,'|').trim()).filter(Boolean);
  console.log('行数=', plain.length, ' 内容行=', JSON.stringify(plain));
  console.log(plain.length<=5?'  ✅ 未拆成三行(视为单块)':'  ⚠️ 观察是否为多行');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
