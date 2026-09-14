// 验证 _cellVerified 缓存漏洞：
// 组合词右格已高亮(记录 _cellVerified) → 页面复用该行把右格 textContent 从"是"改成"否"
// (旧高亮 span 被移除重建为裸文本) → 再改回"是"。此时若增量因 _cellVerified 缓存跳过重建 → 组合词消失。
const FS=require('fs'),PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=process.argv[2]?PATH.resolve(process.argv[2]):PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[{id:'k1',text:'是',enabled:true,important:true,importantNote:'备注A',cellVerifyEnabled:true,cellVerify:'刚需应用',cellVerifyMatchMode:'contain'}];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
const snap=async(page,l)=>page.evaluate(({l})=>({l,combo:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length,note:document.querySelectorAll('[data-kh-important-note]').length}),{l});
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  await page.evaluate(()=>{window.__mkRow=(t,v)=>{const tr=document.createElement('tr');const a=document.createElement('td');a.textContent=t;tr.appendChild(a);const c=document.createElement('td');c.textContent=v;tr.appendChild(c);return tr;};});
  await page.evaluate(()=>{document.getElementById('tb').appendChild(window.__mkRow('刚需应用','是'));});
  const kw1=KW;
  await page.evaluate(({k,c})=>KeywordEngine.setupMutationObserver(k,c),{k:kw1,c:CFG});
  await page.evaluate(({k,c})=>KeywordEngine.highlightKeywords(k,c),{k:kw1,c:CFG});
  console.log(await snap(page,'初始'));

  // 方式A：textContent 整体改"否"（旧 span 移除重建裸文本）
  await page.evaluate(()=>{document.querySelector('#tb tr td:last-child').textContent='否';});
  await page.waitForTimeout(500);
  console.log(await snap(page,'改否'));

  // 方式B：再改回"是"（复用同一行）
  await page.evaluate(()=>{document.querySelector('#tb tr td:last-child').textContent='是';});
  await page.waitForTimeout(800);
  const s=await snap(page,'改回是');
  console.log(s, s.combo>=1&&s.note>=1?'  ✅ 恢复':'  ❌ 组合词/笔记消失(_cellVerified未清导致)');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
