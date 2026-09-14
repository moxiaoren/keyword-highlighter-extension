const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const KW=[
  {id:'k1',text:'是',enabled:true,important:true,importantNote:'优质A',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'},
  {id:'k2',text:'高价值',enabled:true,important:true,importantNote:'优质B',cellVerifyEnabled:true,cellVerify:'应用标记',cellVerifyMatchMode:'contain'}
];
const CFG={groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000'}};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent('<!doctype html><html><body><table><tbody id="tb"><tr><td>是否刚需 应用标记</td><td>是 高价值</td></tr></tbody></table></body></html>');
  await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
  await page.addScriptTag({path:ENGINE});
  const r1 = await page.evaluate(()=>{
    const td = document.querySelectorAll('#tb td')[1];
    return { rightTxt: td.textContent.trim(), leftTxt: td.parentElement.cells[0].textContent.trim() };
  });
  console.log('右格=',r1.rightTxt,' 左格=',r1.leftTxt);
  // 传入 compiled keywords 到 evaluate
  const args = { kws: KW, cfg: CFG };
  await page.evaluate((args)=>{
    const compiled = KeywordEngine._compileKeywords(args.kws, args.cfg);
    KeywordEngine._highlightInRoot(document.querySelectorAll('#tb td')[1], compiled, args.cfg);
  }, args);
  const r2 = await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length);
  console.log('对【右格td单独】_highlightInRoot后 spans=', r2, ' (0=右格单独重扫无法命中组合词)');
  // 对照：对整行 tr 重扫
  await page.evaluate((args)=>{
    document.querySelectorAll('[data-kh-cell-verify-hi-span]').forEach(s=>s.outerHTML=s.textContent);
    const compiled = KeywordEngine._compileKeywords(args.kws, args.cfg);
    KeywordEngine._highlightInRoot(document.querySelector('#tb tr'), compiled, args.cfg);
  }, args);
  const r3 = await page.evaluate(()=>document.querySelectorAll('[data-kh-cell-verify-hi-span]').length);
  console.log('对【整行tr】_highlightInRoot后 spans=', r3, ' (2=整行重扫能命中组合词)');
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
