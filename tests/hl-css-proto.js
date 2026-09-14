// CSS Custom Highlight 原型验证：
// 核心目标：证明「高亮不摘离文本节点 → 框架对原节点赋值 → characterData 触发 → 引擎按新值重新注册高亮」可闭环
const PATH=require('path');
const ROOT='/home/sandbox/.openclaw/workspace/repo/keyword-highlighter-extension';
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    ::highlight(kw-yellow){ background:#ffff00; color:#000; }
  </style></head><body>
  <table><tbody><tr><td>姓名</td><td><span id="val">张三</span></td></tr></tbody></table>
  </body></html>`);
  // 模拟：捕获原始文本节点引用（就像框架翻页前持有的引用）
  await page.evaluate(()=>{
    window.__tns=[];
    document.querySelectorAll('#val').forEach(el=>{
      // 收集 span 内的文本节点
      el.childNodes.forEach(n=>{ if(n.nodeType===3) window.__tns.push(n); });
    });
  });
  // 用 CSS Highlight 高亮"张三"
  await page.evaluate(()=>{
    const kw='张三';
    const tn=window.__tns[0];
    const idx=tn.nodeValue.indexOf(kw);
    const r=document.createRange();
    r.setStart(tn, idx);
    r.setEnd(tn, idx+kw.length);
    const hl=new Highlight(r);
    CSS.highlights.set('kw-yellow', hl);
    window.__hl=hl;
  });
  // 校验：文本节点仍在文档中（未被摘离）
  const chk1=await page.evaluate(()=>({
    inDoc: document.contains(window.__tns[0]),
    text: window.__tns[0].nodeValue
  }));
  console.log('① 高亮后文本节点 inDoc=', chk1.inDoc, 'text=', chk1.text);

  // 模拟框架翻页：对【原文本节点引用】赋新值(内容变化+触发赋值)
  await page.evaluate(()=>{ window.__tns[0].nodeValue='李四'; });
  // 手动触发"重扫重注册"（对应引擎 characterData 监听后的动作）
  await page.evaluate(()=>{
    const kw='李四';
    const tn=window.__tns[0];
    const idx=tn.nodeValue.indexOf(kw);
    CSS.highlights.clear(); // 清旧
    const r=document.createRange();
    r.setStart(tn, idx);
    r.setEnd(tn, idx+kw.length);
    const hl=new Highlight(r);
    CSS.highlights.set('kw-yellow', hl);
  });
  // 用 getComputedStyle + 高亮区域判定是否命中
  const chk2=await page.evaluate(()=>({
    text: window.__tns[0].nodeValue,
    hlNames: Array.from(CSS.highlights.keys()),
    rng: (()=>{ const r=CSS.highlights.get('kw-yellow').values().next().value; return {start:r.startOffset,end:r.endOffset}; })()
  }));
  console.log('② 框架改值"李四"后：text=', chk2.text, 'hlKeys=', chk2.hlNames, 'range=', JSON.stringify(chk2.rng));
  console.log('结论:', (chk2.text==='李四' && chk2.hlNames.length===1) ? '✅ CSS Highlight 方案可行：文本节点未被摘离，框架可写入新值，可重新注册高亮' : '⚠️ 需进一步排查');
  await b.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
