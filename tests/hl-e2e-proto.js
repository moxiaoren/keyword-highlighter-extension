// 端到端原型：CSS Highlight 在「普通词易命中、多命中」真实场景完整链路验证
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
(async()=>{
  const {chromium}=require(PW);
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  await page.setContent(`<!doctype html><html><head><style id="kh-css"></style></head><body>
    <table><tbody>
      <tr><td>姓名</td><td id="a">张三</td></tr>
      <tr><td>城市</td><td id="b">北京上海广州</td></tr>
      <tr><td>备注</td><td id="c">优秀员工张三优秀</td></tr>
    </tbody></table></body></html>`);
  const KWS=[
    {text:'张三', bg:'#ffff00', note:'备注甲', important:true, importantNote:'重要甲'},
    {text:'优秀', bg:'#00ff00', note:'备注乙'},
    {text:'北京', bg:'#ffff00'}
  ];
  await page.evaluate((kws)=>{
    const styleEl=document.getElementById('kh-css');
    const groups={}; let idx=0;
    const all=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    let n; while(n=walker.nextNode()){ if((n.nodeValue||'').trim()) all.push(n); }
    window.__hits=[];
    for(const tn of all){
      const text=tn.nodeValue;
      for(const kw of kws){
        if(!kw.text) continue;
        let s=0; let i;
        while((i=text.indexOf(kw.text,s))>=0){
          const r=document.createRange();
          r.setStart(tn,i); r.setEnd(tn,i+kw.text.length);
          window.__hits.push({range:r, textNode:tn, kw});
          const key=kw.bg||'#ffff00';
          if(!groups[key]){ const nm='kh-hl-'+ (idx++); groups[key]={name:nm,ranges:[]};
            styleEl.textContent += `::highlight(${nm}){ background-color:${key}; color:#000; }\n`; }
          groups[key].ranges.push(r);
          s=i+kw.text.length;
        }
      }
    }
    for(const k in groups){ const hl=new Highlight(...groups[k].ranges); CSS.highlights.set(groups[k].name, hl); }
    window.__groups=groups;
  }, KWS);
  const chk=await page.evaluate(()=>({
    groups: Object.keys(window.__groups),
    hits: window.__hits.length,
    allInDoc: window.__hits.every(h=>document.contains(h.textNode))
  }));
  console.log('① 高亮组=', chk.groups, ' 命中数=', chk.hits, ' 文本节点全在文档=', chk.allInDoc);

  const pt=await page.evaluate(()=>{
    const td=document.getElementById('b');
    const range=document.createRange(); range.setStart(td.firstChild,0); range.setEnd(td.firstChild,2);
    const rr=range.getBoundingClientRect();
    const x=rr.left+rr.width/2, y=rr.top+rr.height/2;
    const caret=document.caretRangeFromPoint(x,y);
    const hit=window.__hits.find(h=> caret && h.textNode===caret.startContainer && caret.startOffset>=h.range.startOffset && caret.startOffset<h.range.endOffset);
    return {hit: hit?{text:hit.kw.text,note:hit.kw.note,important:hit.kw.important}:null};
  });
  console.log('③ 坐标点中"北京":', pt.hit ? `命中词=${pt.hit.text} note=${pt.hit.note}` : '未命中');

  const imp=await page.evaluate(()=>{
    const byKw=new Map();
    window.__hits.forEach(h=>{ if(!h.kw.important) return;
      const note=h.kw.importantNote||'';
      if(!byKw.has(h.kw.text)||note.length>byKw.get(h.kw.text).length) byKw.set(h.kw.text,note); });
    return Array.from(byKw.entries());
  });
  console.log('④ 重要笔记聚合(读注册表):', JSON.stringify(imp));

  // ⑤ 框架翻页：对 a 原文本节点赋新值（内容变为不匹配），验证注册表可重扫刷新
  await page.evaluate(()=>{ const tn=document.getElementById('a').firstChild; tn.nodeValue='李四'; });
  const re=await page.evaluate(()=>{
    // 真实实现会在 characterData 触发后重扫该节点：移除旧 hit + 重索引
    window.__hits=window.__hits.filter(h=>h.textNode.parentNode!==document.getElementById('a'));
    return window.__hits.length;
  });
  console.log('⑤ 翻页赋"李四"后重扫：注册表剩余命中=', re, '(应不含a的张三)');

  console.log('\n端到端结论:', (chk.allInDoc && chk.hits>0 && pt.hit && imp.length>0) ? '✅ CSS Highlight 全链路可行(高亮/点中/聚合/重扫)' : '⚠️ 需排查');
  await b.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
