#!/usr/bin/env node
/**
 * 关键词高亮插件 - 翻页残留自动清扫集成测试（真实浏览器 + mock chrome）
 * 验证 v1.10.14 的 setupPageResidualClean：
 *  ① 分页点击捕获：点击「下一页/页码」→ 触发 prcClean（日志「翻页残留自动清扫: click:...」）
 *  ② 内容指纹轮询：表格内容变化 → 触发 prcClean（「fingerprint-change」）且高亮重建无残留
 */
'use strict';
const FS=require('fs'), PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';

const KEYWORDS=[{id:'k1',text:'是',enabled:true,important:true,importantNote:'优质',cellVerifyEnabled:true,cellVerify:'是否刚需',cellVerifyMatchMode:'contain'}];

const SCRIPT = (kwJson) => `
// ---- mock chrome ----
const __store = { globalEnabled:true, shadowDOMEnabled:true, suspendInactiveTab:true,
  pageResidualClean:true, pageCleanClick:true, pageCleanPoll:true, pageCleanPollMs:200, pageCleanMinGap:300, comboFlipped:true,
  highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000000'},
  siteRules:[], siteDisabledMap:{}, keywords:${kwJson}, groups:[] };
globalThis.chrome = {
  storage:{ local:{ async get(k){ if(k===null) return {...__store}; const arr=Array.isArray(k)?k:[k]; const o={}; for(const a of arr) if(a in __store) o[a]=__store[a]; return o; },
    async set(items){ Object.assign(__store,items); } } },
  runtime:{ onMessage:{ addListener(fn){ globalThis.__onMsg=fn; } }, sendMessage(){ return Promise.resolve({success:true}); } }
};
// ---- 页面结构 ----
document.body.innerHTML = '<table id="t"><tbody id="tb">' +
  '<tr><td>是否刚需</td><td>是</td></tr>' +
  '<tr><td>应用标记</td><td>高价值</td></tr>' +
  '</tbody></table>' +
  '<div class="pagination"><button id="nextPage">下一页</button><button class="page-num">2</button></div>';
`;

(async()=>{
  const b=await require(PW).chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  const logs=[];
  page.on('console', m=>{ const t=m.text(); if(/翻页残留自动清扫|已加载|初始化失败|fingerprint|click:/.test(t)) logs.push('['+m.type()+'] '+t); });
  await page.addScriptTag({content: SCRIPT(JSON.stringify(KEYWORDS))});
  await page.addScriptTag({path: PATH.join(ROOT,'lib','utils.js')});
  await page.addScriptTag({path: PATH.join(ROOT,'lib','storage.js')});
  await page.addScriptTag({path: PATH.join(ROOT,'lib','keyword-engine.js')});
  await page.addScriptTag({path: PATH.join(ROOT,'content','important-note.js')});
  await page.addScriptTag({path: PATH.join(ROOT,'content','note-card.js')});
  await page.addScriptTag({path: PATH.join(ROOT,'content','content.js')});
  await page.waitForTimeout(600);
  const before = await page.evaluate(()=>({hi:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length, spans:Array.from(document.querySelectorAll('[data-kh-highlighted]')).length}));
  console.log('首扫: 组合词span=',before.hi,' 普通高亮span=',before.spans);

  // ① 分页点击捕获
  logs.length=0;
  await page.evaluate(()=>document.getElementById('nextPage').click());
  await page.waitForTimeout(300);
  console.log('分页点击 日志:', logs.filter(l=>/click:/.test(l))[0]||'(未触发)');
  console.log('① 分页点击捕获:', logs.some(l=>/click:/.test(l)) ? '✅ 通过' : '❌ 失败');

  // ② 内容指纹轮询：模拟「直接替换表格内容且无 URL 变化」→ 应触发 fingerprint-change 并重建
  logs.length=0;
  await page.evaluate(()=>{
    // 模拟翻页：整表内容替换，旧高亮标记随节点消失，新内容为新行
    const tb=document.getElementById('tb');
    tb.innerHTML='<tr><td>是否刚需</td><td>是</td></tr><tr><td>应用标记</td><td>高价值</td></tr><tr><td>其他</td><td>否</td></tr>';
  });
  await page.waitForTimeout(700); // 等指纹轮询(200ms) + 重建
  const after = await page.evaluate(()=>({hi:document.querySelectorAll('[data-kh-cell-verify-hi-span]').length}));
  const fpLog = logs.find(l=>/fingerprint/.test(l));
  console.log('内容替换后 组合词span=',after.hi, ' 指纹日志=',fpLog||'(未触发)');
  console.log('② 指纹轮询触发并重建:', (fpLog && after.hi>=1) ? '✅ 通过' : '❌ 失败');

  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
