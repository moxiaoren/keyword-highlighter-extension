// 复现「备注一行被拆三行」历史bug：验证 _cellVisualText 在不同备注结构下的拆分行为
// 场景：仅抓取模式（关键词留空+标题关键词"备注信息"+fetchLabels）命中后提取右侧备注
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();

  // 测试用例：右侧备注格的不同结构
  const cases = {
    // 1. flex 三个同行 div（最典型——历史 v1.8.9 修复场景）
    flex3: '<table><tr><td>备注信息</td><td style="display:flex"><div>备注1内容</div><div>备注2内容</div><div>备注3内容</div></td></tr></table>',
    // 2. flex + 内嵌"编辑"按钮
    flexBtn: '<table><tr><td>备注信息</td><td style="display:flex"><div>备注A</div><button>编辑</button><div>备注B</div></td></tr></table>',
    // 3. flex + span 包裹的编辑按钮
    flexBtnSpan: '<table><tr><td>备注信息</td><td style="display:flex"><div>备注A</div><span><button>编辑</button></span><div>备注B</div></td></tr></table>',
    // 4. flex 多 div 每个带 padding/margin（top 可能不同）
    flexMargin: '<table><tr><td>备注信息</td><td style="display:flex"><div style="margin-top:3px">备注甲</div><div>备注乙</div><div style="margin-top:2px">备注丙</div></td></tr></table>',
    // 5. 真换行（多行备注）
    reallines: '<table><tr><td>备注信息</td><td><div>第一行</div><div>第二行</div><div>第三行</div></td></tr></table>',
  };

  for (const [name, html] of Object.entries(cases)) {
    await page.setContent('<!doctype html><html><body>'+html+'</body></html>');
    await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
    await page.addScriptTag({path:ENGINE});
    // 直接调用 _cellVisualText 提取右侧备注格
    const res = await page.evaluate(()=>{
      const td = document.querySelector('td:nth-child(2)') || document.querySelector('td:last-child');
      const text = KeywordEngine._cellVisualText(td);
      const visual = Array.from(td.querySelectorAll('div,span,button')).map(d=>{
        const r=d.getBoundingClientRect();
        return (d.textContent||'').trim()+'@top'+Math.round(r.top);
      });
      return { text, visual };
    });
    console.log(`\n[${name}]`);
    console.log('  提取结果(\\n分隔行):', JSON.stringify(res.text.split('\n')));
    console.log('  元素top:', res.visual.join(' | '));
    console.log('  行数=', res.text.split('\n').length);

  }
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
