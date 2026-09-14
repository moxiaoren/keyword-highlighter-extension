// 复现「已高亮 → 过一会消失」：模拟真实虚拟列表/懒加载页面
// 关键竞态：某行组合词已高亮成功后，容器被 removedNodes 触发「先清后建」，
// 清建瞬间新行右格还是占位/空 → 重扫扫不出 → 组合词高亮丢失；
// 若此后真实值填入的 DOM 变化不再正确触发补救 → 永久消失。
const FS=require('fs'),PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=process.argv[2]?PATH.resolve(process.argv[2]):PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'备注A',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'网盘',enabled:true}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  page.on('pageerror',e=>console.log('  ⚠️ pageerror:',e.message));
  await page.setContent('<!doctype html><html><body><div id="wrap" style="height:300px;overflow:auto"><table><tbody id="tb"></tbody></table></div></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(()=>{window.__mkRow=(t,v)=>{const tr=document.createElement('tr');const a=document.createElement('td');a.textContent=t;tr.appendChild(a);const c=document.createElement('td');c.textContent=v;tr.appendChild(c);return tr;};});
  // 初始：20 行，含组合词(右格=是) 与 普通词
  await page.evaluate(()=>{const tb=document.getElementById('tb');for(let i=0;i<20;i++)tb.appendChild(i%3===0?window.__mkRow('刚需应用','是'):window.__mkRow('网盘应用','否'));});
  const kw1=KW;
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  const snap=async(l)=>page.evaluate(({l})=>({l,combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,note:document.querySelectorAll('[data-kh-important-note]').length,plain:document.querySelectorAll('[data-kh-highlighted]').length,rows:document.querySelectorAll('#tb tr').length}),{l});
  console.log(await snap('初始'));

  // 模拟真实行为：滚动后容器整体替换成【占位行(右格空)】，随后某几行异步填入真实值
  await page.evaluate(()=>{
    const tb=document.getElementById('tb');
    tb.innerHTML=''; // 移除旧行 → removedNodes 触发容器级重建队列
    // 立即插入占位行（右格空），模拟动态框架先插骨架
    for(let i=0;i<20;i++) tb.appendChild(window.__mkRow('刚需应用','  ')); // 占位，右格空
    // 异步填入真实值（分 2 批，模拟分批加载）
    setTimeout(()=>{
      const rows=tb.querySelectorAll('tr');
      for(let i=0;i<12;i++) rows[i].cells[1].textContent='是';
    }, 80);
    setTimeout(()=>{
      const rows=tb.querySelectorAll('tr');
      for(let i=12;i<20;i++) rows[i].cells[1].textContent='是';
    }, 250); // 靠近 flush 时机
  });
  console.log(await snap('替换+占位后(立即)'));
  await page.waitForTimeout(500);
  console.log(await snap('+500ms(部分填值)'));
  await page.waitForTimeout(800);
  console.log(await snap('+1300ms(应全部填值)'));
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
