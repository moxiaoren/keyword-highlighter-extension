// 对比 _cellText(块级分行) 与 _cellVisualText(视觉行) 在 flex 同行元素下的差异
// 若重要笔记走 _cellText 路径，flex 同行会被拆成多行 = "一行拆三行"
const PATH=require('path');
const REPO=PATH.join(__dirname,'..');
const ENGINE=PATH.join(REPO,'lib','keyword-engine.js');
const PW=process.env.PW_PLAYWRIGHT_PATH||'/tmp/pw/node_modules/playwright';
const {chromium}=require(PW);
const cases = {
  flex3: '<table><tr><td>备注信息</td><td style="display:flex"><div>备注1内容</div><div>备注2内容</div><div>备注3内容</div></td></tr></table>',
  flexBtnSpan: '<table><tr><td>备注信息</td><td style="display:flex"><div>备注A</div><span><button>编辑</button></span><div>备注B</div></td></tr></table>',
  flexMargin: '<table><tr><td>备注信息</td><td style="display:flex"><div style="margin-top:3px">备注甲</div><div>备注乙</div><div style="margin-top:2px">备注丙</div></td></tr></table>',
};
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await b.newPage();
  for (const [name,html] of Object.entries(cases)) {
    await page.setContent('<!doctype html><html><body>'+html+'</body></html>');
    await page.addScriptTag({path:PATH.join(REPO,'lib','utils.js')});
    await page.addScriptTag({path:ENGINE});
    const res = await page.evaluate(()=>{
      const td = document.querySelectorAll('td')[1];
      return { cellText: KeywordEngine._cellText(td, false), visualText: KeywordEngine._cellVisualText(td) };
    });
    console.log(`\n[${name}]`);
    console.log('  _cellText(块级分行)      :', JSON.stringify(res.cellText.split('\n')));
    console.log('  _cellVisualText(视觉行)   :', JSON.stringify(res.visualText.split('\n')));
  }
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1);});
