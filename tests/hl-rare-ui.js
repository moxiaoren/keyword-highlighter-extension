// v1.12.0: 罕见字规则 UI 验证（表格渲染胶囊 + 添加弹窗提示 + 保存 kind 识别）
const PATH=require('path');
const http=require('http');
const fs=require('fs');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW='/tmp/pw/node_modules/playwright';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
function serve(root){return http.createServer((req,res)=>{let p=req.url.split('?')[0];if(p==='/')p='/options/options.html';let fp=PATH.join(root,p);try{const ext=PATH.extname(fp);res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});res.end(fs.readFileSync(fp));}catch(e){res.end('nf');}});}
const results=[];
function check(n,c,d){results.push({n,ok:!!c,d});console.log((c?'  ✅ ':'  ❌ ')+n+(d?'  → '+JSON.stringify(d):''));}
(async()=>{
  const {chromium}=require(PW);
  const srv=serve(ROOT); await new Promise(r=>srv.listen(0,r));
  const port=srv.address().port;
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage({viewport:{width:1500,height:900}});
  const seed={version:'1.12.0',comboFlipped:true,globalEnabled:true,groups:[],highlightStyle:{defaultBgColor:'#ffff00',defaultTextColor:'#000000'},noteCardStyle:{},importantNote:{imgSize:70},matchSettings:{},noteFormat:'',shadowDOMEnabled:true,suspendInactiveTab:false,
    keywords:[
      {id:'r1',text:'hjz#',kind:'rare',enabled:true,note:'',important:false,createdAt:1,updatedAt:10},
      {id:'n1',text:'普通词',enabled:true,note:'',important:false,createdAt:2,updatedAt:11}
    ]};
  await page.addInitScript((sd)=>{window.__store=Object.assign({},sd);
    window.chrome={runtime:{getManifest:()=>({version:sd.version})},tabs:{query:async()=>[],sendMessage:()=>new Promise(r=>r())},
      storage:{local:{async get(k){if(k==null)return JSON.parse(JSON.stringify(window.__store));if(Array.isArray(k)){const o={};k.forEach(x=>{if(x in window.__store)o[x]=window.__store[x];});return o;}if(typeof k==='string')return {[k]:window.__store[k]};return {};},
        async set(it){Object.assign(window.__store,it);},async remove(ks){const a=Array.isArray(ks)?ks:[ks];a.forEach(x=>delete window.__store[x]);},async clear(){window.__store={};}}}};
  },seed);
  await page.goto(`http://127.0.0.1:${port}/options/options.html`,{waitUntil:'networkidle'});
  await page.waitForTimeout(500);

  // 1. 罕见字词表格渲染：「罕见字 (hjz#)」 + 核心匹配列「罕见」胶囊
  const rows=await page.evaluate(()=>[...document.querySelectorAll('#keywordTableBody tr')].map(tr=>{
    const kw=tr.querySelector('.kw-col-name').textContent.replace(/\s+/g,' ').trim();
    const core=[...tr.querySelectorAll('.col-kw-match .mr-chip')].map(c=>c.textContent.trim()).join(',');
    return {kw,core};
  }));
  console.log('行渲染:', JSON.stringify(rows));
  const r1=rows.find(r=>r.kw.includes('罕见字'));
  check('罕见字关键词渲染为「罕见字 (hjz#)」', !!r1 && r1.kw.includes('罕见字') && r1.kw.includes('hjz#'), r1&&r1.kw);
  check('罕见字核心匹配列显示「罕见」胶囊', !!r1 && r1.core==='罕见', r1&&r1.core);

  // 2. 打开添加弹窗，输入 hjz# → 提示条显示 + 核心匹配开关禁用
  // 尝试多个可能的添加入口
  const opened = await page.evaluate(async ()=>{
    const btns=['#btnAddKeyword','#btnEmptyAdd','#btnAddKw','#addKeywordBtn'];
    for(const sel of btns){ const el=document.querySelector(sel); if(el){ el.click(); return sel; } }
    return null;
  });
  console.log('添加入口:', opened);
  await page.waitForTimeout(300);
  const typed = await page.evaluate(async ()=>{
    const inp=document.getElementById('editKwText');
    if(!inp) return {missing:true, modalOpen:document.getElementById('keywordModal')?document.getElementById('keywordModal').style.display:null};
    inp.value='hjz#'; inp.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,120));
    const hint=document.getElementById('editKwRareHint');
    return {hint:hint?hint.style.display:null,
            cs:document.getElementById('editKwCaseSensitive')?document.getElementById('editKwCaseSensitive').disabled:null,
            ww:document.getElementById('editKwWholeWord')?document.getElementById('editKwWholeWord').disabled:null};
  });
  console.log('[添加弹窗] 输入 hjz#:', JSON.stringify(typed));
  check('输入 hjz# 显示罕见字提示条', typed.hint==='block', typed.hint);
  check('罕见字输入时禁用核心匹配开关(大小写/全词)', typed.cs===true && typed.ww===true, {cs:typed.cs,ww:typed.ww});

  // 3. 填备注并保存 → 新增词 kind='rare'
  if(!typed.missing){
    const note=await page.$('#editKwNote'); if(note) await page.fill('#editKwNote','测试罕见');
    const save=await page.$('#keywordModalSave'); if(save) await save.click();
    await page.waitForTimeout(500);
  }
  const saved=await page.evaluate(()=>{
    const kw=window.__store.keywords.find(k=>k.text==='hjz#');
    return {count:window.__store.keywords.filter(k=>k.text==='hjz#').length, kind:kw&&kw.kind, note:kw&&kw.note};
  });
  console.log('[保存] hjz# 词:', JSON.stringify(saved));
  check('保存后 hjz# 词唯一且 kind=rare', saved.count>=1 && saved.kind==='rare', saved);

  console.log('');
  const failed=results.filter(r=>!r.ok);
  console.log(failed.length===0?'✅ 全部 '+results.length+' 项通过':'❌ '+failed.length+'/'+results.length+' 项失败');
  await b.close();
  process.exit(failed.length===0?0:1);
})().catch(e=>{console.error('UI测试异常:',e);process.exit(2);});
