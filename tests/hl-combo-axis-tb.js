/*
 * v1.14.x→v1.50.0 上下格组合词（列×行）回归
 * 背景：目标=表头某列命中「列关键词」→ 该列数据区某行命中「行关键词」→ 交叉的单元格文本高亮。
 * 支持：同表（thead/首行表头）、表头/数据区分成两个独立 <table>（列名/列序号对齐）、
 *       正则/包含/整格的行关键词、重要笔记、图片列/无文字单元格跳过、多表格实例。
 * 运行：node tests/hl-combo-axis-tb.js
 */
const PATH = require('path');
const { chromium } = require('/tmp/pw/node_modules/playwright');
const CHROME = '/opt/chrome-linux/chrome';
const REPO = PATH.resolve(__dirname, '..');

function mkkw(over) {
  return Object.assign({
    id: 'k1', text: '吃饭', enabled: true, useRegex: false, caseSensitive: false, wholeWord: false,
    cellVerifyEnabled: true, cellVerify: '名称', cellVerifyMatchMode: 'include', cellVerifyUseRegex: false,
    comboAxis: 'tb', important: false, importantNote: ''
  }, over);
}

const CASES = [
  // === 命中（应输出高亮片段）===
  ['同表 thead 表头', '<table><thead><tr><th>名称</th><th>其他</th></tr></thead><tbody><tr><td>吃饭了</td><td>x</td></tr><tr><td>喝水</td><td>y</td></tr></tbody></table>', mkkw(), ['吃饭'], ['吃饭']],
  ['首行表头(无thead)', '<table><tr><th>名称</th><th>值</th></tr><tr><td>我已经吃饭了</td><td>z</td></tr></table>', mkkw(), ['吃饭'], ['吃饭']],
  ['表头/数据区分两表(列名对齐)', '<div><table><thead><tr><th>名称</th><th>其他</th></tr></thead></table><table><tbody><tr><td>今天吃饭了</td><td>a</td></tr><tr><td>跑步了</td><td>b</td></tr></tbody></table></div>', mkkw(), ['吃饭'], ['吃饭']],
  ['数据表无表头(列序号回退)', '<div><table><thead><tr><th>名称</th></tr></thead></table><table><tbody><tr><td>吃饭了</td></tr><tr><td>跑步</td></tr></tbody></table></div>', mkkw(), ['吃饭'], ['吃饭']],
  ['行关键词 正则(吃.*饭)', '<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>我今天吃过饭了</td></tr></tbody></table>', mkkw({ text: '吃.*饭', useRegex: true }), ['吃过饭'], ['吃过饭']],
  ['行关键词 区分大小写', '<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>AB 吃饭</td></tr><tr><td>ab x</td></tr></tbody></table>', mkkw({ text: 'AB', caseSensitive: true, useRegex: false, wholeWord: true }), ['AB'], ['AB']],
  ['重要笔记标注', '<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>吃饭了</td></tr></tbody></table>', mkkw({ important: true, importantNote: '备注X' }), ['吃饭'], ['吃饭']],
  // === 不命中 ===
  ['无匹配行词', '<table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>喝水</td></tr></tbody></table>', mkkw(), [], []],
  ['列关键词不对', '<table><thead><tr><th>地址</th></tr></thead><tbody><tr><td>吃饭了</td></tr></tbody></table>', mkkw(), [], []],
  ['无表格', '<p>吃饭了</p>', mkkw(), [], []],
  // === 多表格实例：只命中目标表 ===
  ['多表格只命中含列词的表', '<div><table><tbody><tr><td>吃饭了</td></tr></tbody></table><table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>吃饭了</td></tr></tbody></table></div>', mkkw(), ['吃饭'], ['吃饭']],
  // === Element UI el-table（固定表头：表头表+数据表两个独立 <table>，同在一个 inner-wrapper）===
  ['el-table 固定表头跨表', '<div class="el-table__inner-wrapper"><div class="el-table__header-wrapper"><table class="el-table__header"><colgroup><col><col></colgroup><thead class="el-table__header"><tr><th>名称</th><th>操作</th></tr></thead></table></div><div class="el-table__body-wrapper"><table class="el-table__body"><colgroup><col><col></colgroup><tbody><tr><td>今天吃饭了</td><td><button>编辑</button></td></tr><tr><td>跑步了</td><td><button>编辑</button></td></tr></tbody></table></div></div>', mkkw(), ['吃饭'], ['吃饭']],
  ['el-table 多行只命中目标行', '<div class="wrap"><div class="a"><table><thead><tr><th>名称</th><th>值</th></tr></thead></table></div><div class="b"><table><tbody><tr><td>喝水</td><td>1</td></tr><tr><td>我去吃饭了</td><td>2</td></tr></tbody></table></div></div>', mkkw(), ['吃饭'], ['吃饭']],
  ['el-table 精确锁定body表(前面有同列名无关表)', '<div class="el-table__inner-wrapper"><div><table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>喝水</td></tr></tbody></table></div><div class="el-table__header-wrapper"><table class="el-table__header"><thead><tr><th>名称</th><th>操作</th></tr></thead></table></div><div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr><td>吃饭了</td><td><button>编辑</button></td></tr></tbody></table></div></div>', mkkw(), ['吃饭'], ['吃饭']],
  ['el-table body表直接class命中', '<div><div><table class="el-table__header"><thead><tr><th>名称</th></tr></thead></table></div><div><table class="el-table__body"><tbody><tr><td>已经吃饭了</td></tr></tbody></table></div></div>', mkkw(), ['吃饭'], ['吃饭']],
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/utils.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/rare-char.js') });
  await page.addScriptTag({ path: PATH.join(REPO, 'lib/keyword-engine.js') });

  let fails = 0;
  for (const [name, html, kw, expectSegs, expectSegsExact] of CASES) {
    await page.evaluate(async ({ html, kw }) => {
      document.body.innerHTML = html;
      KeywordEngine._plainHits = [];
      KeywordEngine._tbColProcessed = new WeakMap();
      await KeywordEngine.highlightKeywords([kw], { groups: [], highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000' } });
      window.__hits = (KeywordEngine._plainHits || []).map(m => ({
        seg: (m.textNode.nodeValue || '').slice(m.start, m.end), adj: m.adj, imp: !!m.important, impNote: m.importantNote || ''
      }));
    }, { html, kw });
    const hits = await page.evaluate(() => window.__hits);
    const segs = hits.map(h => h.seg);
    const ok = segs.length === expectSegs.length && expectSegsExact.every(s => segs.includes(s));
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' [' + name + '] 命中=' + JSON.stringify(segs));
    // 重要笔记断言
    if (name === '重要笔记标注') {
      const okImp = hits.length > 0 && hits[0].imp === true && hits[0].impNote === '备注X' && hits[0].adj === '名称';
      if (!okImp) fails++;
      console.log((okImp ? '✅' : '❌') + '   [重要笔记 meta: imp=' + (hits[0] && hits[0].imp) + ' note=' + (hits[0] && hits[0].impNote) + ' adj=' + (hits[0] && hits[0].adj) + ']');
    }
  }

  await browser.close();
  console.log(fails ? '\n' + fails + ' 项失败' : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试错误:', e); process.exit(2); });
