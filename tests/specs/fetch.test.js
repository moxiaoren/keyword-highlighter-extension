/* tests/specs/fetch.test.js — 抓取单源：标签解析 / 视觉行 / 合并块 / 多行表格 / 触发判据 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** 造一个真表格：tr 由 td 组成 */
function table(rows) {
  const t = H.el('table');
  const tbody = H.el('tbody');
  t.appendChild(tbody);
  for (const cells of rows) {
    const tr = H.el('tr');
    for (const c of cells) {
      const td = H.el('td');
      if (typeof c === 'string') td.appendChild(H.txt(c));
      else if (c && c.html) { for (const n of c.html) td.appendChild(n); }
      else if (c && c.text != null) td.appendChild(H.txt(c.text));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  // 补上引擎用到的表格访问器（垫片不实现 HTMLTableElement）
  t.rows = tbody.children.map((tr, ri) => {
    tr.rowIndex = ri;                 // collectRightBlock 用它定位行
    tr.cells = tr.children;
    tr.cells.forEach((td, i) => { td.cellIndex = i; });
    return tr;
  });
  return t;
}

module.exports = async function run() {
  const { KH, H: Boot } = require('../bootstrap');
  const doc = global.document;
  const F = KH.Fetch;

  suite('fetch · parseLabels（分隔符与 #1 简单模式）');

  await test('四种分隔符都能切：| ｜ , ，', () => {
    const items = F.parseLabels('甲|乙｜丙,丁，戊');
    eq(items.map(i => i.label).join(','), '甲,乙,丙,丁,戊');
  });

  await test('★ 末尾 #1 = 简单模式（只取右邻一格），其余为整块模式', () => {
    const items = F.parseLabels('资质类型#1|驳回原因');
    eq(items[0].label, '资质类型');
    eq(items[0].simple, true);
    eq(items[1].label, '驳回原因');
    eq(items[1].simple, false);
  });

  await test('# 与 1 之间允许空格：`甲# 1`', () => {
    const items = F.parseLabels('甲# 1');
    eq(items[0].label, '甲');
    eq(items[0].simple, true);
  });

  await test('空白项被剔除', () => {
    eq(F.parseLabels(' | 甲 | | 乙 | ').length, 2);
    eq(F.parseLabels('').length, 0);
    eq(F.parseLabels(null).length, 0);
  });

  suite('fetch · cellVisualText（图文顺序 / 视觉行）');

  await test('★ 图文混排：图片必须留在**原位置**（不得被挪到行尾）', () => {
    /* 用户实测：`先看文字<div><img></div>再看结尾文字` 抓出来是「先看文字 / 再看结尾文字 / 图」。
     * 旧实现先扫完全部文本节点、再单独扫全部图片 → 图片永远落在最后。
     * 垫片没有真实几何（矩形全 0 → 走 fallback top），所以这里锁的是**文档顺序**；
     * "同一视觉行"（几何重叠）由 `_e2e` 组 4 的真浏览器用例锁。 */
    const td = H.el('td');
    td.appendChild(H.txt('先看文字'));
    const box = H.el('div');
    box.appendChild(H.el('img', { src: 'https://ex.com/a.png', alt: '图A' }));
    td.appendChild(box);
    td.appendChild(H.txt('再看结尾文字'));
    const lines = F.cellVisualText(td).split('\n');
    console.log('        cellVisualText = ' + JSON.stringify(lines));
    eq(lines.length, 3, '应是三行（文字 / 图 / 文字），实际 ' + JSON.stringify(lines));
    truthy(lines[0].indexOf('先看文字') >= 0, '第一行是文字，实际 ' + JSON.stringify(lines[0]));
    truthy(/KHIMG/.test(lines[1]), '第二行必须是**图片**（留在原位置），实际 ' + JSON.stringify(lines[1]));
    truthy(lines[2].indexOf('再看结尾文字') >= 0, '第三行是文字，实际 ' + JSON.stringify(lines[2]));
  });

  await test('★ 一格多图：按文档顺序逐张保留（顺序不得改变）', () => {
    const td = H.el('td');
    ['甲', '乙', '丙'].forEach((alt) => {
      const li = H.el('li');
      li.appendChild(H.el('img', { src: 'https://ex.com/' + alt + '.png', alt: alt }));
      td.appendChild(li);
    });
    const lines = F.cellVisualText(td).split('\n');
    console.log('        多图行数 = ' + lines.length);
    eq(lines.length, 3, '垫片无几何：每张图各自一行（真浏览器里同一视觉行会合成一行）');
    const at = (a) => lines.findIndex((l) => l.indexOf(encodeURIComponent(a)) >= 0);
    truthy(at('甲') < at('乙') && at('乙') < at('丙'), '三张图的顺序必须与文档一致，实际 ' + JSON.stringify(lines));
  });

  suite('fetch · 图片选项（仅图片 / 前 N 张 / 去重，v1.99.99.12）');

  const PH = (alt, src) => '\u0001KHIMG\u0001' + encodeURIComponent(alt) + '|' + encodeURIComponent(src) + '\u0001ENDIMG\u0001';

  await test('parseLabels：`#图` 仅图片、`#3` 最多 3 张、`#图3` 组合；`#1` 仍是简单模式（不得被抢）', () => {
    const p = F.parseLabels('截图#图|图标#3|混合#图3|资质类型#1|名称');
    console.log('        ' + JSON.stringify(p));
    eq(p.length, 5);
    truthy(p[0].imgOnly && p[0].imgLimit === 0, '`#图` = 仅图片、不限张数');
    truthy(!p[1].imgOnly && p[1].imgLimit === 3, '`#3` = 最多 3 张（文字照旧）');
    truthy(p[2].imgOnly && p[2].imgLimit === 3, '`#图3` = 仅图片且最多 3 张');
    truthy(p[3].simple && !p[3].imgOnly && p[3].imgLimit === 0, '`#1` **仍是简单模式**（历史语义不能被图片选项抢走）');
    truthy(!p[4].imgOnly && !p[4].imgLimit && !p[4].simple, '无后缀 = 原样');
  });

  await test('★ applyImgPolicy：仅图片丢掉文字、保留图片', () => {
    const txt = '附件说明 ' + PH('图一', 'https://ex.com/a.png') + ' 以及 ' + PH('图二', 'https://ex.com/b.png');
    const out = F.applyImgPolicy(txt, { imgOnly: true, imgLimit: 0 }, { n: 0 });
    console.log('        仅图片 = ' + JSON.stringify(out));
    truthy(out.indexOf('附件说明') < 0 && out.indexOf('以及') < 0, '文字应被丢掉');
    eq(out.match(/KHIMG/g).length, 2, '两张图都要保留');
  });

  await test('★ applyImgPolicy：前 N 张按**整字段**累计（跨单元格）', () => {
    const budget = { n: 0 };
    const a = F.applyImgPolicy(PH('1', 'https://ex.com/1.png') + ' ' + PH('2', 'https://ex.com/2.png'), { imgOnly: false, imgLimit: 3 }, budget);
    const b = F.applyImgPolicy(PH('3', 'https://ex.com/3.png') + ' ' + PH('4', 'https://ex.com/4.png'), { imgOnly: false, imgLimit: 3 }, budget);
    console.log('        第一格 = ' + JSON.stringify(a) + ' 第二格 = ' + JSON.stringify(b));
    eq(a.match(/KHIMG/g).length, 2, '第一格两张都留');
    eq(b.match(/KHIMG/g).length, 1, '第二格只留第 3 张（整字段前 3 张）');
    truthy(b.indexOf(encodeURIComponent('4')) < 0, '第 4 张应被丢掉');
  });

  await test('★ 同一张图在两列各出现一次 → **两列都要保留**（刻意不去重）', () => {
    /* 用户给的结构里"最新版本/历史版本"两列放的是同一批图；按 src 去重会把一列吃空。 */
    const budget = { n: 0 };
    const one = PH('图一', 'https://ex.com/same.png');
    const out = F.applyImgPolicy(one + ' ', null, budget) + F.applyImgPolicy(one, null, budget);
    eq((out.match(/KHIMG/g) || []).length, 2, '同一 src 出现两次（两列）必须都保留');
  });

  await test('★ 仅图片的右格也算"有内容"（仅抓取模式要显示该条）', () => {
    const tbl = table([[{ html: [H.el('td')] }]]);   // 占位，下面手工拼更直观
    const tr = H.el('tr');
    const label = H.el('td'); label.appendChild(H.txt('应用截图'));
    const val = H.el('td');
    val.appendChild(H.el('img', { src: 'https://ex.com/a.png', alt: '图一' }));
    tr.appendChild(label); tr.appendChild(val);
    const tbody = H.el('tbody'); tbody.appendChild(tr);
    tbl.appendChild(tbody);
    truthy(F.triggerOk(label), '右格只有一张图、没有任何文字 → 仍应算"有内容"');
    const empty = H.el('td'); empty.appendChild(H.txt('-'));
    const tr2 = H.el('tr'); const l2 = H.el('td'); l2.appendChild(H.txt('备注'));
    tr2.appendChild(l2); tr2.appendChild(empty);
    const tb2 = H.el('tbody'); tb2.appendChild(tr2); tbl.appendChild(tb2);
    falsy(F.triggerOk(l2), '占位串 `-` 依旧不算内容（不得连坐）');
  });

  await test('★ 网页自己看图器浮层里的大图不抓（只跳图片，文字照旧）', () => {
    /* 用户实测：原网页"看大图"就是在单元格里再加一个 div 容器放大图 → 被我们抓成"又一张图"。
     * 判据：祖先里有 position:fixed|absolute 且覆盖视口 ≥60% 的容器 → 该图不算字段内容。 */
    const td = H.el('td');
    td.appendChild(H.txt('正常文字'));
    td.appendChild(H.el('img', { src: 'https://ex.com/thumb.png', alt: '缩略' }));
    global.getComputedStyle = (el) => ({ position: el.getAttribute && el.getAttribute('data-pos') || 'static' });
    const plain = (w, h) => ({ width: w, height: h });
    const origInnerW = global.window.innerWidth, origInnerH = global.window.innerHeight;
    global.window.innerWidth = 1000; global.window.innerHeight = 800;

    /* ① 普通父级（static）→ 照抓 */
    truthy(F.imgPlaceholder(td.querySelectorAll('img')[0]), '普通位置上的图应照旧抓');

    /* ② 浮层容器（absolute + 覆盖整屏）→ 不抓 */
    const overlay = H.el('div', { 'data-pos': 'absolute' });
    const big = H.el('img', { src: 'https://ex.com/big.png', alt: '大图' });
    overlay.appendChild(big);
    td.appendChild(overlay);
    overlay.getBoundingClientRect = () => plain(1000, 800);        // 覆盖视口
    falsy(F.imgPlaceholder(big), '浮层里的大图不该被当成字段内容');
    /* ③ 浮层里的文字也**不算字段内容**（用户实测：点开大图后残留 `1/5` 计数文字）。
     * 注意这**只影响抓取** —— 命中/高亮走的是扫描路径，不经过 cellText。 */
    overlay.appendChild(H.txt('1/5'));
    const got = F.cellText(td, false);
    console.log('        cellText = ' + JSON.stringify(got));
    truthy(got.indexOf('1/5') < 0, '浮层里的计数文字不该进抓取值');
    truthy(got.indexOf('正常文字') >= 0, '浮层外的正常文字照旧抓');
    /* 可视行路径同理 */
    truthy(F.cellVisualText(td).indexOf('1/5') < 0, 'cellVisualText 也不该带出浮层文字');

    /* ④ 覆盖面积不够的容器（小图/局部容器）→ 仍然抓 */
    const small = H.el('div', { 'data-pos': 'absolute' });
    const img2 = H.el('img', { src: 'https://ex.com/small.png', alt: '小图' });
    small.appendChild(img2);
    small.getBoundingClientRect = () => plain(120, 80);
    td.appendChild(small);
    truthy(F.imgPlaceholder(img2), '小型绝对定位容器里的图（如普通画廊）应照旧抓');

    global.window.innerWidth = origInnerW; global.window.innerHeight = origInnerH;
    delete global.getComputedStyle;
  });

  suite('fetch · cellText（换行保留 / 控件剔除）');

  await test('★ 整块模式保留换行（多行驳回原因不得被折叠）', () => {
    const td = H.el('td');
    td.appendChild(H.txt('第一行'));
    td.appendChild(H.el('br'));
    td.appendChild(H.txt('第二行'));
    eq(F.cellText(td, false), '第一行\n第二行');
  });

  await test('简单模式把换行压成单空格', () => {
    const td = H.el('td');
    td.appendChild(H.txt('甲'));
    td.appendChild(H.el('br'));
    td.appendChild(H.txt('乙'));
    eq(F.cellText(td, true), '甲 乙');
  });

  await test('★ 块级元素之间产生换行（<div>a</div><div>b</div> → a\\nb）', () => {
    const td = H.el('td');
    const d1 = H.el('div'); d1.appendChild(H.txt('a'));
    const d2 = H.el('div'); d2.appendChild(H.txt('b'));
    td.appendChild(d1); td.appendChild(d2);
    eq(F.cellText(td, false), 'a\nb');
  });

  await test('★ 按钮/交互控件文本被剔除（"编辑"等不抓）', () => {
    const td = H.el('td');
    td.appendChild(H.txt('真实内容'));
    const btn = H.el('button'); btn.appendChild(H.txt('编辑'));
    td.appendChild(btn);
    eq(F.cellText(td, false), '真实内容');
  });

  await test('纯文字 <a> 放行（组合词核心常在链接里）', () => {
    const td = H.el('td');
    const a = H.el('a'); a.appendChild(H.txt('南京公司'));
    td.appendChild(a);
    eq(F.cellText(td, false), '南京公司');
  });

  await test('带 onclick 的 <a> 视为控件跳过', () => {
    const td = H.el('td');
    td.appendChild(H.txt('真'));
    const a = H.el('a', { onclick: 'x()' }); a.appendChild(H.txt('查看更多'));
    td.appendChild(a);
    eq(F.cellText(td, false), '真');
  });

  suite('fetch · 图片协议白名单');

  await test('非 http(s) 协议一律丢弃（javascript: / data: 占位图）', () => {
    const mk = (src) => { const i = H.el('img', { src }); return i; };
    eq(F.imgPlaceholder(mk('javascript:alert(1)')), null);
    eq(F.imgPlaceholder(mk('data:image/png;base64,AAA')), null, 'data: 占位图丢弃');
    eq(F.imgPlaceholder(mk('')), null);
    truthy(F.imgPlaceholder(mk('https://a.com/x.png')), 'https 应保留');
  });

  await test('相对路径转绝对后保留', () => {
    const p = F.imgPlaceholder(H.el('img', { src: '/img/a.png' }));
    truthy(p, '相对路径应转绝对并保留');
    // 占位符里 url 是 encodeURIComponent 过的（不依赖内部包裹符常量）
    truthy(p.indexOf(encodeURIComponent('https://example.com/img/a.png')) >= 0, p);
  });

  await test('restoreImgs 只还原 http(s)，其它丢弃', () => {
    const ok = F.restoreImgs(F.imgPlaceholder(H.el('img', { src: 'https://a.com/x.png', alt: '说明' })));
    truthy(ok.indexOf('<img src="https://a.com/x.png"') >= 0, ok);
    truthy(ok.indexOf('alt="说明"') >= 0);
    // 伪造一个非法协议的占位符（结构固定：\u0001KHIMG\u0001alt|src\u0001ENDIMG\u0001）
    const evil = '\u0001KHIMG\u0001a|' + encodeURIComponent('javascript:alert(1)') + '\u0001ENDIMG\u0001';
    eq(F.restoreImgs(evil), '', '非法协议必须还原为空');
  });

  suite('fetch · rowsToTableHtml（多行表格 / 两级分组）');

  await test('单块多行文本 → 一个表格，label 列 rowspan = 行数', () => {
    const html = F.rowsToTableHtml([{ label: '驳回原因', rows: [[{ t: '第一行\n第二行', rs: 1, cs: 1 }]] }]);
    truthy(html.indexOf('<table class="kh-table kh-table-fetch">') === 0);
    truthy(html.indexOf('rowspan="2"') >= 0, '两行内容应让 label 跨两行：' + html);
    truthy(html.indexOf('第一行') >= 0 && html.indexOf('第二行') >= 0);
  });

  await test('★ 真实多列格保留 rowspan/colspan', () => {
    const rows = [
      [{ t: 'A', rs: 1, cs: 1 }, { t: 'B', rs: 2, cs: 1 }],
      [{ t: 'C', rs: 1, cs: 1 }]
    ];
    const html = F.rowsToTableHtml([{ label: '字段', rows }]);
    truthy(html.indexOf('rowspan="2"') >= 0, 'B 的 rowspan 应保留：' + html);
  });

  await test('多块合并进同一张表（不拆成多个小表）', () => {
    const html = F.rowsToTableHtml([
      { label: '字段一', rows: [[{ t: 'v1', rs: 1, cs: 1 }]] },
      { label: '字段二', rows: [[{ t: 'v2', rs: 1, cs: 1 }]] }
    ]);
    eq((html.match(/<table/g) || []).length, 1, '只应有一个 table');
    truthy(html.indexOf('字段一') >= 0 && html.indexOf('字段二') >= 0);
  });

  await test('★ 含 tab 的行被识别为「标题 + 内容」两级结构', () => {
    const html = F.rowsToTableHtml([{ label: '信息', rows: [[{ t: '基本信息\t内容A\n内容B', rs: 1, cs: 1 }]] }]);
    truthy(html.indexOf('基本信息') >= 0);
    truthy(html.indexOf('内容A') >= 0);
  });

  await test('固定标题词（基本信息/测试信息/资质信息/运营备注）单独成行', () => {
    const html = F.rowsToTableHtml([{ label: '信息', rows: [[{ t: '运营备注', rs: 1, cs: 1 }, { t: '值', rs: 1, cs: 1 }]] }]);
    truthy(html.indexOf('运营备注') >= 0);
    truthy(html.indexOf('值') >= 0);
  });

  suite('fetch · 用户真实样例：审测一体审核结果描述（多行合并）');

  /** 把生成的 HTML 拆成"每行有多少格"，用于断言列对齐 */
  const rowsOf = (html) => html.split('<tr>').slice(1).map(s => {
    const row = s.split('</tr>')[0];
    return Array.from(row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)).map(m => ({
      attrs: m[1], t: m[2].replace(/<[^>]*>/g, '')
    }));
  });
  const cellWith = (rows, txt) => {
    for (const r of rows) for (const c of r) if (c.t.trim() === txt) return c;
    return null;
  };

  /**
   * 按 HTML 的 rowspan/colspan **展开成真正的网格**，返回 `grid[行][列] = cell|null`。
   * `null` = 该格被上方某个 rowspan 占住（浏览器里就是"没有这个 td"）。
   *
   * 【为什么必须这样断言】`<td rowspan>` 的行本来就不该有自己的一格，
   * 所以"每行 td 个数一致"是个错误判据；真正要守的是**展开后列数一致 + 目标文字落在第几列**。
   */
  const gridOf = (rows) => {
    const occ = [];        // occ[列] = 还压着几行
    const out = [];
    for (const r of rows) {
      for (let k = 0; k < occ.length; k++) if (occ[k] > 0) occ[k]--;
      const line = [];
      let col = 0;
      for (const c of r) {
        while (occ[col] > 0) col++;
        const cs = parseInt((/colspan="(\d+)"/.exec(c.attrs) || [0, '1'])[1], 10);
        const rs = parseInt((/rowspan="(\d+)"/.exec(c.attrs) || [0, '1'])[1], 10);
        for (let k = 0; k < cs; k++) occ[col + k] = rs;
        line[col] = c;
        col += cs;
      }
      // 补齐本行宽度：既算自己写下的格，也算被上方 rowspan 占住、本行没有 td 的列
      const width = Math.max(col, occ.length);
      for (let k = 0; k < width; k++) if (!(k in line)) line[k] = null;
      out.push(line);
    }
    return out;
  };

  // 版本 A：简洁版（2026-08-28）
  const VER_A = [
    '审测一体审核结果描述\t', '基本信息\t', '驳回字段：主标题', '1、 请修改；',
    '驳回字段：图标', '1、 请修改；', '', '测试信息\t', '1、 重新提交；', '', '运营备注\t', '请修改。'
  ].join('\n');

  // 版本 B：含 32位/64位 包分组（2026-08-31）
  const VER_B = [
    '审测一体审核结果描述\t', '32位包:', '运营备注\t',
    '请修改后重新提交，谢谢合作！如有疑问，请联系在线客服咨询。', '64位包:', '基本信息\t',
    '驳回字段：应用截图', '1、 需汉语翻译；', '驳回字段：软件介绍', '1、 应用内容或功能', '',
    '测试信息\t', '1、 功能问题', '', '资质信息\t', '1、 行业资质处提交：', '', '运营备注\t',
    '请修改后重新提交，谢谢合作！如有疑问，请联系在线客服咨询。'
  ].join('\n');

  await test('版本 A：组标题按子项行数跨行合并（基本信息 rowspan=4）', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_A, rs: 1, cs: 1 }]] }]));
    const base = cellWith(rows, '基本信息');
    truthy(base, '应有「基本信息」组标题');
    eq(base.attrs.replace(/\s/g, ''), 'rowspan="4"', '「基本信息」应跨 4 行（驳回字段：主标题 + 理由 + 驳回字段：图标 + 理由）');
    truthy(cellWith(rows, '测试信息'), '应有「测试信息」');
    truthy(cellWith(rows, '运营备注'), '应有「运营备注」');
    truthy(cellWith(rows, '驳回字段：主标题'), '应有「驳回字段：主标题」');
    truthy(cellWith(rows, '请修改。'), '应有运营备注内容「请修改。」');
  });

  await test('★ 抓取表格带 kh-table-fetch 标记，且只有字段 label 格带 kh-table-label', () => {
    const html = F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_B, rs: 1, cs: 1 }]] }]);
    truthy(html.indexOf('<table class="kh-table kh-table-fetch">') === 0,
      '表格必须带 kh-table-fetch 标记（否则会被"首行当表头"的着色规则刷底色）：' + html.slice(0, 60));
    const rows = rowsOf(html);
    const marked = rows.flat().filter(c => /kh-table-label/.test(c.attrs));
    eq(marked.length, 1, '只有字段 label 格该带 kh-table-label，实际 ' + marked.length + ' 个');
    eq(marked[0].t.trim(), '审测一体审核结果描述');
    // 分组标题 / 二级标题 / 内容都不是"行标题"，一律不许上色
    for (const t of ['32位包:', '64位包:', '基本信息', '驳回字段：应用截图', '测试信息', '资质信息', '运营备注']) {
      const c = cellWith(rows, t);
      truthy(c, '应有「' + t + '」');
      truthy(c.attrs.indexOf('kh-table-label') < 0,
        '「' + t + '」对整张表来说是 label 的内容、不是行标题，不该带 kh-table-label');
    }
  });

  await test('★ 版本 A：label 只用一格 rowspan=6 覆盖全表，不逐行补空格', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_A, rs: 1, cs: 1 }]] }]));
    const all = rows.flat();
    const labels = all.filter(c => c.t.trim() === '审测一体审核结果描述');
    eq(labels.length, 1, 'label 只应出现一次（旧版 1.52.0 口径），实际 ' + labels.length + ' 次');
    truthy(/rowspan="6"/.test(labels[0].attrs), 'label 应跨全表 6 行，实际 ' + JSON.stringify(labels[0].attrs));
  });

  await test('★ 版本 A：展开网格每行 3 列，理由与「驳回字段」严格同列', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_A, rs: 1, cs: 1 }]] }]));
    const grid = gridOf(rows);
    eq(grid.length, 6, '版本 A 应有 6 行，实际 ' + grid.length);
    grid.forEach((line, i) => eq(line.length, 3,
      '第 ' + (i + 1) + ' 行展开后应为 3 列，实际 ' + line.length + ' :: ' + JSON.stringify(line.map(c => c && c.t.trim()))));

    // 第 0 列：label（rowspan 占住其余行）
    eq(grid[0][0].t.trim(), '审测一体审核结果描述');
    for (let i = 1; i < 6; i++) eq(grid[i][0], null, '第 ' + (i + 1) + ' 行第 0 列应被 label 的 rowspan 占住');

    // 第 1 列：组标题「基本信息」跨 4 行
    eq(grid[0][1].t.trim(), '基本信息');
    eq(grid[0][1].attrs.replace(/\s/g, ''), 'rowspan="4"');
    for (const i of [1, 2, 3]) eq(grid[i][1], null, '第 ' + (i + 1) + ' 行第 1 列应被「基本信息」的 rowspan 占住');

    // 第 2 列（内容列）：4 行标题/理由全部落在同一列 —— 这是用户截图指出的错列问题的回归护栏
    eq(grid[1][2].t.trim(), '1、 请修改；', '理由必须与「驳回字段：主标题」同列（第 2 列）');
    eq(grid[2][2].t.trim(), '驳回字段：图标');
    eq(grid[3][2].t.trim(), '1、 请修改；');
    eq(grid[2][2].attrs.indexOf('rowspan'), -1, '「驳回字段：图标」只占 1 行，不应带 rowspan');

    eq(grid[4][1].t.trim(), '测试信息');
    eq(grid[4][2].t.trim(), '1、 重新提交；');
    eq(grid[5][1].t.trim(), '运营备注');
    eq(grid[5][2].t.trim(), '请修改。');
  });

  await test('★ 版本 B：32位包 / 64位包 跨列覆盖下方子项', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_B, rs: 1, cs: 1 }]] }]));
    const g32 = cellWith(rows, '32位包:');
    const g64 = cellWith(rows, '64位包:');
    truthy(g32, '应有「32位包:」');
    truthy(g64, '应有「64位包:」');
    truthy(/colspan="\d+"/.test(g32.attrs), '「32位包:」必须跨列（colspan），实际 ' + JSON.stringify(g32.attrs));
    truthy(/colspan="\d+"/.test(g64.attrs), '「64位包:」必须跨列（colspan），实际 ' + JSON.stringify(g64.attrs));
    // 覆盖宽度应大于等于"二级标题+内容"两列才能盖住下方子项
    const cs32 = parseInt(/colspan="(\d+)"/.exec(g32.attrs)[1], 10);
    truthy(cs32 >= 2, '「32位包:」的 colspan 应 ≥2 才能覆盖子项，实际 ' + cs32);
    // 包分组下的子项都在
    for (const t of ['运营备注', '基本信息', '测试信息', '资质信息', '驳回字段：应用截图', '1、 功能问题']) {
      truthy(cellWith(rows, t), '应有「' + t + '」');
    }
  });

  await test('★ 版本 B：组标题跨行合并（基本信息 rowspan=4）', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_B, rs: 1, cs: 1 }]] }]));
    const base = cellWith(rows, '基本信息');
    truthy(base, '应有「基本信息」');
    eq(base.attrs.replace(/\s/g, ''), 'rowspan="4"', '「基本信息」应跨 4 行');
  });

  await test('★ 版本 B：展开网格每行 3 列，且没有任何一行多补空格子', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_B, rs: 1, cs: 1 }]] }]));
    const grid = gridOf(rows);
    eq(grid.length, 10, '版本 B 应有 10 行（2 个包分组标题 + 8 个子项行），实际 ' + grid.length);
    grid.forEach((line, i) => {
      eq(line.length, 3, '第 ' + (i + 1) + ' 行展开后应为 3 列，实际 ' + line.length +
        ' :: ' + JSON.stringify(line.map(c => c && c.t.trim())));
      // 不允许出现"空 label 补位格"——它会把后面所有格子整体右移一列
      truthy(!(line[0] && line[0].t.trim() === ''),
        '第 ' + (i + 1) + ' 行出现空 label 补位格（会导致列错位）');
    });

    // 两个包分组标题跨「二级标题 + 内容」两列
    for (const i of [0, 2]) {
      eq(grid[i][1].t.trim(), i === 0 ? '32位包:' : '64位包:');
      eq(grid[i][2], null, '分组标题行第 2 列应被 colspan 覆盖');
    }
    // 32位包 下的运营备注
    eq(grid[1][1].t.trim(), '运营备注');
    eq(grid[1][2].t.trim().slice(0, 6), '请修改后重新');
    // 64位包 下：基本信息 rowspan=4，其 4 行标题/理由全部落在第 2 列
    eq(grid[3][1].t.trim(), '基本信息');
    eq(grid[3][1].attrs.replace(/\s/g, ''), 'rowspan="4"');
    eq(grid[3][2].t.trim(), '驳回字段：应用截图');
    eq(grid[4][2].t.trim(), '1、 需汉语翻译；', '理由必须与「驳回字段：应用截图」同列（第 2 列）');
    eq(grid[5][2].t.trim(), '驳回字段：软件介绍');
    eq(grid[6][2].t.trim(), '1、 应用内容或功能');
    for (const i of [4, 5, 6]) eq(grid[i][1], null, '第 ' + (i + 1) + ' 行第 1 列应被「基本信息」的 rowspan 占住');
    // 其余三个分组
    eq(grid[7][1].t.trim(), '测试信息'); eq(grid[7][2].t.trim(), '1、 功能问题');
    eq(grid[8][1].t.trim(), '资质信息'); eq(grid[8][2].t.trim(), '1、 行业资质处提交：');
    eq(grid[9][1].t.trim(), '运营备注'); eq(grid[9][2].t.trim().slice(0, 6), '请修改后重新');
    // label 仍只出现一次、跨全表
    const labels = rows.flat().filter(c => c.t.trim() === '审测一体审核结果描述');
    eq(labels.length, 1, 'label 只应出现一次，实际 ' + labels.length + ' 次');
    truthy(/rowspan="10"/.test(labels[0].attrs), 'label 应跨全表 10 行，实际 ' + JSON.stringify(labels[0].attrs));
  });

  await test('★ 版本 B：分组标题 colspan 覆盖「二级标题 + 内容」两列（真浏览器几何已验）', () => {
    const rows = rowsOf(F.rowsToTableHtml([{ label: '审测一体审核结果描述', rows: [[{ t: VER_B, rs: 1, cs: 1 }]] }]));
    const g32 = cellWith(rows, '32位包:');
    const cs32 = parseInt(/colspan="(\d+)"/.exec(g32.attrs)[1], 10);
    // 表格共 3 列：label 占第 0 列，分组标题跨剩下的第 1、2 列
    eq(cs32, 2, '「32位包:」colspan 应为 2（label 之外的整行），实际 ' + cs32);
    eq(g32.attrs.replace(/\s/g, ''), 'colspan="2"');
    // 二级标题行：[label(已被 rowspan 占)] + [二级标题] + [内容] = 2 个 td
    const dataRow = rows.find(r => r.some(c => c.t.trim() === '驳回字段：应用截图'));
    truthy(dataRow, '应有含二级标题的数据行');
    eq(dataRow.length, 2, '二级标题行应为 2 格（二级标题 + 内容；label 由 rowspan 占位），实际 ' + dataRow.length);
  });

  await test('内容被 HTML 转义（防注入）', () => {
    const html = F.rowsToTableHtml([{ label: 'x', rows: [[{ t: '<script>alert(1)</script>', rs: 1, cs: 1 }]] }]);
    falsy(html.indexOf('<script>') >= 0, '标签必须被转义：' + html);
    truthy(html.indexOf('&lt;script&gt;') >= 0);
  });

  suite('fetch · collectRightBlock（rowspan 合并块）');

  await test('★ 标签格 rowspan=2 → 右侧两行内容都抓到（策划案 §7.3 坑 8）', () => {
    // 真实浏览器里 rowspan=2 的第一格占掉下一行的第一列，所以第二行 DOM 里只有 1 个 td，
    // 但它对应**第 2 列**；collectRightBlock 自己按 colSpan/rowSpan 算逻辑列，必须能对齐。
    const t = table([['标签', '行1'], ['行2']]);
    const r0 = t.rows[0];
    r0.children[0].rowSpan = 2;
    t.rows[1].children[0].cellIndex = 1;      // 真实 DOM 的 cellIndex 就是 1
    const rows = F.collectRightBlock(r0.children[0], t);
    const flat = rows.map(line => line.map(c => c.t).join('|')).join(' / ');
    truthy(flat.indexOf('行1') >= 0, flat);
    truthy(flat.indexOf('行2') >= 0, '合并范围外的下一行也必须抓到：' + flat);
  });

  suite('fetch · triggerOk（触发判据）');

  await test('★ 直接右邻格有内容 → 触发', () => {
    const t = table([['应用名称', 'com.foo.bar']]);
    truthy(F.triggerOk(t.rows[0].children[0]));
  });

  await test('★ 直接右邻格为空 → 不触发（不得跳过空格子找更右的）', () => {
    const t = table([['应用名称', '', '有内容但在更右']]);
    falsy(F.triggerOk(t.rows[0].children[0]), '右邻为空即不触发（不跳格）');
  });

  await test('右邻只有符号/破折号 → 不触发', () => {
    const t = table([['应用名称', '-']]);
    falsy(F.triggerOk(t.rows[0].children[0]));
  });

  await test('纯按钮右格 → 不触发（按钮文本被剔除后为空）', () => {
    const t = H.el('table');
    const tbody = H.el('tbody'); t.appendChild(tbody);
    const tr = H.el('tr'); tbody.appendChild(tr);
    const td1 = H.el('td'); td1.appendChild(H.txt('应用名称'));
    const td2 = H.el('td'); const b = H.el('button'); b.appendChild(H.txt('编辑')); td2.appendChild(b);
    tr.appendChild(td1); tr.appendChild(td2);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; });
    t.rows = [tr];
    falsy(F.triggerOk(td1));
  });

  /* ============ 触发判据的"控件不算内容"契约（用户明确要求：右格只有按钮 → 不当有内容） ============ */

  /** 造一行 [标题格][右格 nodes...]，返回标题格 */
  const labelCellWith = (labelText, nodes) => {
    const t = H.el('table');
    const tbody = H.el('tbody'); t.appendChild(tbody);
    const tr = H.el('tr'); tbody.appendChild(tr);
    const td1 = H.el('td'); td1.appendChild(H.txt(labelText));
    const td2 = H.el('td');
    for (const n of nodes) td2.appendChild(n);
    tr.appendChild(td1); tr.appendChild(td2);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; });
    tr.rowIndex = 0; t.rows = [tr];
    return { label: td1, right: td2 };
  };
  const spanOf = (cls, text, attrs) => {
    const s = H.el('span', Object.assign({ class: cls }, attrs || {}));
    if (text) s.appendChild(H.txt(text));
    return s;
  };
  const divOf = (cls, text) => {
    const d = H.el('div', { class: cls });
    if (text) d.appendChild(H.txt(text));
    return d;
  };
  const withText = (tag, attrs, text) => {
    const e = H.el(tag, attrs || {});
    if (text) e.appendChild(H.txt(text));
    return e;
  };

  // 真实后台里"右格只有控件"的常见形态 —— 全部不许触发
  const CONTROL_ONLY = [
    ['<button>编辑</button>', [withText('button', {}, '编辑')]],
    ['<span class="el-button el-button--text">操作</span>', [spanOf('el-button el-button--text', '操作')]],
    ['<span class="ant-btn">编辑</span>', [spanOf('ant-btn', '编辑')]],
    ['<span class="layui-btn">编辑</span>', [spanOf('layui-btn', '编辑')]],
    ['<el-button>编辑</el-button>', [withText('el-button', { class: 'el-button' }, '编辑')]],
    ['<a class="el-link">删除</a>', [withText('a', { class: 'el-link' }, '删除')]],
    ['<a class="el-link" href="javascript:;">删除</a>', [withText('a', { class: 'el-link', href: 'javascript:;' }, '删除')]],
    ['<a href="javascript:void(0)">编辑</a>', [withText('a', { href: 'javascript:void(0)' }, '编辑')]],
    ['<div class="operation"><span>编辑</span><span>删除</span></div>',
      [(() => { const d = divOf('operation'); d.appendChild(spanOf('', '编辑')); d.appendChild(spanOf('', '删除')); return d; })()]],
    ['<div class="opt-col"><span>编辑</span></div>',
      [(() => { const d = divOf('opt-col'); d.appendChild(spanOf('', '编辑')); return d; })()]],
    ['<div class="cell-ops"><span>编辑</span></div>',
      [(() => { const d = divOf('cell-ops'); d.appendChild(spanOf('', '编辑')); return d; })()]],
    ['<span class="operate">编辑</span>', [spanOf('operate', '编辑')]],
    ['<span class="caozuo">编辑</span>', [spanOf('caozuo', '编辑')]],
    ['<a class="edit">编辑</a>', [withText('a', { class: 'edit' }, '编辑')]],
    ['<div role="button">编辑</div>', [withText('div', { role: 'button' }, '编辑')]],
    ['<span onclick="edit()">编辑</span>', [spanOf('', '编辑', { onclick: 'edit()' })]],
    ['<span style="cursor:pointer">编辑</span>', [spanOf('', '编辑', { style: 'cursor:pointer' })]],
    ['<span class="iconfont icon-edit">&#xe600;</span>', [spanOf('iconfont icon-edit', '\ue600')]]
  ];

  for (const [desc, nodes] of CONTROL_ONLY) {
    await test('★ 右格只有控件 → 不触发：' + desc, () => {
      const { label } = labelCellWith('应用名称', nodes);
      falsy(F.triggerOk(label), '右格只有控件时不得算作"有内容"');
    });
  }

  // 类名带操作词、但装的确实是正文 —— 绝不许误删（本项目取向：宁可多抓、不可丢内容）
  const MUST_KEEP = [
    ['<div class="edit-area">南京市江宁区某某科技有限公司</div>', [divOf('edit-area', '南京市江宁区某某科技有限公司')], '南京市江宁区某某科技有限公司'],
    ['<div class="opt-desc">这条是真实的备注内容，不能被吞</div>', [divOf('opt-desc', '这条是真实的备注内容，不能被吞')], '这条是真实的备注内容，不能被吞'],
    ['<div class="edit-area"><div>南京市</div></div>',
      [(() => { const d = divOf('edit-area'); d.appendChild(divOf('', '南京市')); return d; })()], '南京市'],
    ['<a href="/detail/123">南京公司</a>', [withText('a', { href: '/detail/123' }, '南京公司')], '南京公司'],
    ['<a href="#">南京公司</a>（# 占位链接：宁可漏判也不丢内容）', [withText('a', { href: '#' }, '南京公司')], '南京公司']
  ];

  for (const [desc, nodes, expect] of MUST_KEEP) {
    await test('★ 类名像操作列但装的是正文 → 仍算内容：' + desc, () => {
      const { label, right } = labelCellWith('应用名称', nodes);
      truthy(F.triggerOk(label), '不得把真内容误判成空');
      const text = F.cellText(right, false);
      truthy(text.indexOf(expect) >= 0, '正文应保留 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(text));
    });
  }

  await test('★ 右格"正文 + 按钮" → 触发，且正文里不许混进按钮文字', () => {
    const { label, right } = labelCellWith('应用名称', [
      H.txt('com.foo.real'),
      (() => { const d = divOf('operation'); d.appendChild(spanOf('', '编辑')); d.appendChild(spanOf('', '删除')); return d; })()
    ]);
    truthy(F.triggerOk(label));
    eq(F.cellText(right, false), 'com.foo.real');
  });

  await test('★ 右邻格**本身**是控件（<td class="el-button">）→ 不触发', () => {
    const t = H.el('table');
    const tbody = H.el('tbody'); t.appendChild(tbody);
    const tr = H.el('tr'); tbody.appendChild(tr);
    const td1 = H.el('td'); td1.appendChild(H.txt('应用名称'));
    const td2 = H.el('td', { class: 'el-button' }); td2.appendChild(H.txt('编辑'));
    tr.appendChild(td1); tr.appendChild(td2);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; });
    tr.rowIndex = 0; t.rows = [tr];
    falsy(F.triggerOk(td1), '右邻格自身是控件时不算有内容');
  });

  await test('★ 只有图片的右格仍算内容（图片是抓取值的一种，清单要求缩略图展示）', () => {
    const { label } = labelCellWith('应用名称', [H.el('img', { src: 'https://a.com/icon.png' })]);
    truthy(F.triggerOk(label), '图片属于内容：抓取支持 <img> 缩略图，不应判空');
  });

  /* ============ 占位串 = 空（用户实测问到：`-` 后面还挂了个按钮时算不算空） ============ */

  await test('占位串口径：符号占位 + 文字占位都算空，真值不算空', () => {
    const empty = ['', '   ', '-', '--', '——', '~', '～', '/', '\\', '.', '、', '- -',
      '无', '暂无', '没有', '无数据', '暂无数据', '未填写', '未设置', '未配置', 'N/A', 'n/a', 'null', 'None', 'undefined'];
    for (const s of empty) truthy(F.isPlaceholderText(s), JSON.stringify(s) + ' 应判为空');
    const notEmpty = ['无理由退货', 'N/A 待补', '0', '否', '待定', '未知', '空运', 'null值', 'com.foo'];
    for (const s of notEmpty) falsy(F.isPlaceholderText(s), JSON.stringify(s) + ' 不该判为空（全串锚定）');
  });

  // 「占位串 ± 控件」—— 剔除控件后仍必须判空
  const PLACEHOLDER_WITH_CONTROL = [
    ['`-` 单独', [H.txt('-')]],
    ['`-` + <button>编辑</button>', [H.txt('-'), withText('button', {}, '编辑')]],
    ['`-` + 操作列',
      [H.txt('-'), (() => { const d = divOf('opt-col'); d.appendChild(spanOf('', '编辑')); d.appendChild(spanOf('', '删除')); return d; })()]],
    ['`-` + <a href="javascript:;">删除</a>', [H.txt('-'), withText('a', { class: 'el-link', href: 'javascript:;' }, '删除')]],
    ['`-` + <br> + <button>编辑</button>', [H.txt('-'), H.el('br'), withText('button', {}, '编辑')]],
    ['`——` + <button>编辑</button>', [H.txt('——'), withText('button', {}, '编辑')]],
    ['`~` + <button>编辑</button>', [H.txt('~'), withText('button', {}, '编辑')]],
    ['`/` + <button>编辑</button>', [H.txt('/'), withText('button', {}, '编辑')]],
    ['`无` + <button>编辑</button>', [H.txt('无'), withText('button', {}, '编辑')]],
    ['`暂无` + <button>编辑</button>', [H.txt('暂无'), withText('button', {}, '编辑')]],
    ['`N/A` + <button>编辑</button>', [H.txt('N/A'), withText('button', {}, '编辑')]]
  ];
  for (const [desc, nodes] of PLACEHOLDER_WITH_CONTROL) {
    await test('★ 右格「占位串 + 控件」→ 仍算空，不显示该条：' + desc, () => {
      const { label, right } = labelCellWith('应用名称', nodes);
      const text = F.cellText(right, false);
      falsy(F.triggerOk(label), 'cellText=' + JSON.stringify(text) + ' 应判空');
    });
  }

  await test('★ 占位串后面跟真内容 → 仍算内容（占位符只管"整串就是占位"）', () => {
    const { label } = labelCellWith('应用名称', [H.txt('-'), H.txt(' 备注：需补材料')]);
    truthy(F.triggerOk(label), '"- 备注：需补材料" 含真内容，不能判空');
  });

  suite('fetch · extractFor 端到端');

  await test('按标签在**同表**里找「文本==标签」的格子，取其右侧内容', () => {
    // 表里有三个标签行；命中在「应用名称」行，抓取按 fetchLabels 找「包名」这一行
    const t = table([
      ['应用名称', 'com.foo', ''],
      ['包名', 'com.bar.pkg'],
      ['运营备注', '备注内容']
    ]);
    const tn = t.rows[0].children[0].childNodes[0];
    const got = F.extractFor(tn, '包名');
    eq(got.length, 1);
    eq(got[0].label, '包名');
    truthy(JSON.stringify(got[0].rows).indexOf('com.bar.pkg') >= 0, JSON.stringify(got[0].rows));
  });

  await test('★ fetchLabels 为空 → 不抓（不是"抓全部右列"）', () => {
    const t = table([['关键词', '值一', '值二']]);
    eq(F.extractFor(t.rows[0].children[0].childNodes[0], '').length, 0);
  });

  await test('★ 目标标签为空 → 不抓，也不回退抓标题右格', () => {
    const t = table([['关键词', '标题右格的值', ''], ['其它', 'x']]);
    const tn = t.rows[0].children[0].childNodes[0];
    eq(F.extractFor(tn, '不存在的标签').length, 0, '找不到标签必须返回空，绝不回退');
  });

  await test('#1 简单模式只取右侧相邻一个单元格', () => {
    const t = table([['关键词', 'x'], ['资质类型', '甲类', '乙类']]);
    const tn = t.rows[0].children[0].childNodes[0];
    const got = F.extractFor(tn, '资质类型#1');
    eq(got.length, 1);
    const flat = JSON.stringify(got[0].rows);
    truthy(flat.indexOf('甲类') >= 0, flat);
    falsy(flat.indexOf('乙类') >= 0, '简单模式不应把更右的也抓进来');
  });

  await test('blockFor：抓到内容返回表格 HTML，抓不到返回 null', () => {
    const t = table([['关键词', 'x'], ['备注', '多行\n内容']]);
    const tn = t.rows[0].children[0].childNodes[0];
    const html = F.blockFor(tn, '备注');
    truthy(html && html.indexOf('<table') === 0, String(html));
    eq(F.blockFor(tn, '不存在'), null);
  });

  suite('fetch · 假表格（无 <table>）');

  await test('★ div/flex 假表格：按标签找元素取右邻兄弟', () => {
    // 真实页面结构：每行一个 div，标签与值各自一个 span；
    // 标签文本在更内层元素里（真实页面常见：<span class="lbl"><b>包名</b></span>），
    // 否则 scope 会停在标签自身的元素上（与原版一致的行为）。
    const wrap = H.el('div');
    wrap.innerHTML = '<div class="r"><span class="lbl"><b>包名</b></span><span>com.foo</span></div>';
    doc.body.appendChild(wrap);
    const label = wrap.querySelectorAll('span')[0];
    const got = F.extractFromFakeTable(label, [{ label: '包名', simple: false }]);
    eq(got.length, 1);
    truthy(JSON.stringify(got[0].rows).indexOf('com.foo') >= 0, JSON.stringify(got[0].rows));
    doc.body.removeChild(wrap);
  });

  await test('标签元素右侧无内容 → 返回空', () => {
    const wrap = H.el('div');
    wrap.innerHTML = '<div class="r"><span class="lbl"><b>包名</b></span></div>';
    doc.body.appendChild(wrap);
    const label = wrap.querySelectorAll('span')[0];
    eq(F.extractFromFakeTable(label, [{ label: '包名', simple: false }]).length, 0);
    doc.body.removeChild(wrap);
  });

  /* ------------------------------------------------------------------
   * K75：假表格**不再越界**（用户 ①）
   *   旧实现从命中元素一路向上找"文本含全部标签的祖先"，最坏接受 `body`
   *   ⇒ 命中词出现在**正文标题/段落**里时，会抓到页面上任意一张表的标签、
   *     让面板多出一张内容不相关的卡。
   *   现在：作用域 = **命中所属的那个（假）行容器**，且标签必须与命中**同一行容器**；
   *   命中不在任何行容器里 ⇒ 直接返回空。
   * ------------------------------------------------------------------ */

  await test('★ 命中在 `<h1>` 标题里（不在任何行容器）→ 假表格路径必须返回空（不许抓别处那张表）', () => {
    const wrap = H.el('div');
    wrap.innerHTML = '<h1>命中词在标题里</h1>'
      + '<table><tbody><tr><td>驳回原因</td><td>资质材料不清晰</td></tr></tbody></table>';
    doc.body.appendChild(wrap);
    try {
      const h1 = wrap.querySelectorAll('h1')[0];
      const got = F.extractFromFakeTable(h1, [{ label: '驳回原因', simple: false }]);
      console.log('        h1 命中 → 假表格抓取 = ' + JSON.stringify(got));
      eq(got.length, 0, '★ 标题里的命中不在行容器里 ⇒ 返回空（旧实现会拿包裹层/body 当容器，抓到那张真表格的值）');
    } finally {
      /* 【必须 finally】断言失败时不清理会把 '驳回原因' 留在共享的 document.body 里，
       * 污染后面所有 spec（实测：反向验证时 diag-selfcheck 因此假红）。 */
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 命中与标签**同一行容器** → 照旧抓到（假表格能力不许回退）', () => {
    const wrap = H.el('div');
    wrap.innerHTML = '<div class="row">'
      + '<span class="cell">命中词</span><span class="cell">驳回原因</span><span class="cell">资质材料不清晰</span>'
      + '</div>';
    doc.body.appendChild(wrap);
    try {
      const hitEl = wrap.querySelectorAll('.cell')[0];
      const got = F.extractFromFakeTable(hitEl, [{ label: '驳回原因', simple: false }]);
      eq(got.length, 1, '同一行容器里应能抓到：' + JSON.stringify(got));
      truthy(JSON.stringify(got[0].rows).indexOf('资质材料不清晰') >= 0, JSON.stringify(got[0].rows));
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 命中在 `body` 直下（无行容器）→ 返回空', () => {
    const p = H.el('p');
    p.appendChild(H.txt('裸文本里的命中词'));
    doc.body.appendChild(p);
    try {
      const got = F.extractFromFakeTable(p, [{ label: '驳回原因', simple: false }]);
      eq(got.length, 0, 'body 直下的裸文本没有"行容器" ⇒ 不许抓');
    } finally {
      doc.body.removeChild(p);
    }
  });

  /* ------------------------------------------------------------------
   * K75 返工（R4 红牌回归锁）：命中落在**值格内的行内元素**里
   *   站点常给命中词套一层行内元素（`<span>` / `<em>` / `<b>`），真实链路的入口是
   *   `extractFromFakeTable(textNode.parentElement, …)` ⇒ 入口就是**那一层行内元素**，不是值格。
   *   上一版在拿不到"行"时回退"入口自己的父级"，于是命中侧停在**值格**、标签侧停在**行**，
   *   两侧不同层 ⇒ 标签被判掉 ⇒ **静默不抓**（R4 实测：浏览器抓取表 [0]、「纯乙值」消失）。
   *   下面三种行容器形状 × 三种行内落点**都必须照旧抓到**；值格有 ≥2 个元素子节点时同样。
   * ------------------------------------------------------------------ */

  const INLINE_SHAPES = [
    {
      name: '扁平 div 行（.label + .value > span）',
      html: '<div class="row"><div class="label">驳回原因</div>'
        + '<div class="value">资质材料<span class="note">命中词</span></div></div>',
      hitSel: '.note'
    },
    {
      name: '列表假表格（li > span.lbl + span.val > em）',
      html: '<ul><li><span class="lbl">驳回原因</span>'
        + '<span class="val">资质材料<em>命中词</em></span></li></ul>',
      hitSel: 'em'
    },
    {
      name: 'grid 假表格（.k + .v > b）',
      html: '<div class="grid"><div class="k">驳回原因</div>'
        + '<div class="v">资质材料<b>命中词</b></div></div>',
      hitSel: 'b'
    }
  ];

  await test('★ 命中落在值格内的**行内元素**里（span/em/b × 3 种行容器形状）⇒ 必须照旧抓到', () => {
    const seen = [];
    for (const s of INLINE_SHAPES) {
      const wrap = H.el('div');
      wrap.innerHTML = s.html;
      doc.body.appendChild(wrap);
      try {
        /* 入口与生产完全一致：`textNode.parentElement`（命中文本节点 → 行内元素那一层） */
        const hit = wrap.querySelectorAll(s.hitSel)[0].childNodes[0];
        const got = F.extractFromFakeTable(hit.parentElement, [{ label: '驳回原因', simple: false }]);
        seen.push(s.name + '=' + JSON.stringify(got.map((g) => g.rows)));
        eq(got.length, 1, s.name + '：命中在值格内的行内元素里也必须抓到（R4 红牌形态）');
        truthy(JSON.stringify(got[0].rows).indexOf('资质材料命中词') >= 0,
          s.name + '：' + JSON.stringify(got[0].rows));
      } finally {
        doc.body.removeChild(wrap);
      }
    }
    console.log('        行内落点 × 3 形状: ' + seen.join(' | '));
  });

  await test('★ 值格有 **≥2 个元素子节点**、命中在内层那个子节点里 ⇒ 抓取与取图都要对', () => {
    const wrap = H.el('div');
    wrap.innerHTML = '<div class="row">'
      + '<div class="label">驳回原因</div>'
      + '<div class="value"><span class="a">资质材料</span>'
      + '<span class="b">命中词<img src="https://ex.com/v.png"></span></div>'
      + '</div>';
    doc.body.appendChild(wrap);
    try {
      const hit = wrap.querySelectorAll('.b')[0].childNodes[0];       // 「命中词」文本节点
      const img = wrap.querySelectorAll('img')[0];
      /* ① 抓取路径：从行内元素向上走 ⇒ 行容器 = .row，标签 = .label，值 = 右邻 .value */
      const got = F.extractFromFakeTable(hit.parentElement, [{ label: '驳回原因', simple: false }]);
      console.log('        多子格内层落点: ' + JSON.stringify(got.map((g) => g.rows)));
      eq(got.length, 1, '值格多子节点、命中在内层 ⇒ 照旧抓到：' + JSON.stringify(got));
      truthy(JSON.stringify(got[0].rows).indexOf('资质材料命中词') >= 0, JSON.stringify(got[0].rows));
      /* ② OCR 读口（`findLabelElInScope` 同一口径）：定位格是内层 .b，也要找到 .row 里的标签 */
      const cells = F.cellsForHit(hit, { fetchLabels: '驳回原因' });
      eq(cells.length, 1, 'OCR 读口在"多子格内层落点"下也要认出标签：' + cells.map((c) => c.label).join(','));
      truthy(cells[0].cells.length === 1 && cells[0].cells[0] === wrap.querySelectorAll('.value')[0],
        '值格 = 标签的右邻（整格）');
      eq(cells[0].imgs.length, 1, '值格里的图仍要取得到（节点可能整个吞在命中文字旁边）');
      truthy(cells[0].imgs[0] === img, '取到的就是值格里的那张图');
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 同一页两行**都有同一个标签**：只认命中那一行，绝不跨行取到别的值', () => {
    const wrap = H.el('div');
    wrap.innerHTML = '<div class="row"><span class="lbl">驳回原因</span>'
      + '<span class="val">资质材料<span class="note">命中词</span></span></div>'
      + '<div class="row"><span class="lbl">驳回原因</span><span class="val">另一行的值</span></div>';
    doc.body.appendChild(wrap);
    try {
      const hit = wrap.querySelectorAll('.note')[0].childNodes[0];
      const got = F.extractFromFakeTable(hit.parentElement, [{ label: '驳回原因', simple: false }]);
      const flat = JSON.stringify(got);
      eq(got.length, 1, flat);
      truthy(flat.indexOf('资质材料命中词') >= 0, '命中那一行的值必须抓到：' + flat);
      falsy(flat.indexOf('另一行的值') >= 0, '另一行同标签的值**不许**越界进来：' + flat);
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  /* ==================================================================
   * 抓取字段「值格指向」：`@表达式`（与关键词 cellOffset 同语法，向后兼容）
   *   · 语法：`2` / `1-3` / `1,3` / `1-3,5`；`#图` `#N` 与它**顺序无关**，可混写；
   *   · 非法 / 越界 → **回退右邻格**（不报错、不变空值）；
   *   · 文本多格 → 按视觉列序用 `\n` 拼非空；图片多格 → 按序全取。
   * ================================================================== */

  suite('fetch · fetchLabels 的 @值格指向（解析）');

  await test('★ `@2` / `@1-3` 解析成 offset（label 与修饰分离）', () => {
    const p = F.parseLabels('应用截图@2|名称@1-3');
    eq(p.length, 2);
    eq(p[0].label, '应用截图'); eq(p[0].offset, '2');
    eq(p[1].label, '名称'); eq(p[1].offset, '1-3');
    truthy(!p[0].offsetInvalid && !p[1].offsetInvalid);
  });

  await test('★ `@1,3` / `@1-3,5`：表达式里的逗号**不是字段分隔符**', () => {
    const a = F.parseLabels('应用截图@1,3');
    eq(a.length, 1, '`@1,3` 必须是一个字段（逗号在表达式里）：' + JSON.stringify(a));
    eq(a[0].label, '应用截图'); eq(a[0].offset, '1,3');
    const b = F.parseLabels('截图@1-3,5|名称');
    eq(b.length, 2);
    eq(b[0].offset, '1-3,5');
    eq(b[1].label, '名称');
    /* 没写 `@` 时逗号**照旧**是分隔符（不得连带改掉旧行为） */
    eq(F.parseLabels('甲,乙，丙').map(i => i.label).join('|'), '甲|乙|丙');
  });

  await test('★ `#图@2` 与 `@2#图` 完全等价（修饰与偏移顺序无关）', () => {
    const a = F.parseLabels('应用截图#图@2')[0];
    const b = F.parseLabels('应用截图@2#图')[0];
    eq(a.label, '应用截图'); eq(b.label, '应用截图');
    eq(a.offset, '2'); eq(b.offset, '2');
    eq(a.imgOnly, true); eq(b.imgOnly, true);
    /* `#N` 与 `@` 混写同理 */
    const c = F.parseLabels('截图@2#图3')[0];
    eq(c.label, '截图'); eq(c.offset, '2'); eq(c.imgOnly, true); eq(c.imgLimit, 3);
    /* `#1` 的"简单模式"历史语义不许被 `@` 抢走 */
    const d = F.parseLabels('资质类型@2#1')[0];
    eq(d.simple, true); eq(d.offset, '2');
  });

  await test('★ 非法表达式：照旧解析出 label，并标出 offsetInvalid（消费侧据此回退右邻格）', () => {
    const p = F.parseLabels('应用截图@abc')[0];
    eq(p.label, '应用截图', '不得把 `@abc` 留在标签里（否则整条字段静默失效）');
    eq(p.offset, 'abc');
    eq(p.offsetInvalid, true);
    eq(F.parseLabels('应用截图@0')[0].offsetInvalid, true, '`0` 不是合法偏移（k≥1）');
  });

  suite('fetch · 值格指向的消费（多格文本 / 多格图片 / 回退）');

  await test('★ 文本字段给了多格 → 按视觉列顺序把**非空**文本用 \\n 拼接', () => {
    const t = table([['应用截图', '甲', '乙', '', '丙']]);
    const tn = t.rows[0].children[0].childNodes[0];
    const got = F.extractFor(tn, '应用截图@1-3');
    eq(got.length, 1);
    eq(got[0].rows[0][0].t, '甲\n乙', '空值格不参与拼接（第 3 格为空）');
  });

  await test('★ 表达式越界 / 非法 → 回退"右邻格"（不报错、不变空值）', () => {
    const t = table([['应用截图', '甲', '乙']]);
    const tn = t.rows[0].children[0].childNodes[0];
    for (const bad of ['9', 'abc', '0']) {
      const got = F.extractFor(tn, '应用截图@' + bad);
      eq(got.length, 1, '`@' + bad + '` 应回退而不是消失');
      eq(got[0].rows[0][0].t, '甲', '`@' + bad + '` 应回退成右邻格（甲）');
    }
  });

  await test('★ cellsForHit：只读访问口给出「值格 + 其中的图片」，且不改抓取内容', () => {
    const imgA = H.el('img', { src: 'https://ex.com/a.png' });
    const imgB = H.el('img', { src: 'https://ex.com/b.png' });
    const t = table([
      ['应用截图', { html: [imgA] }, { html: [imgB] }],
      ['名称', '甲', '乙']
    ]);
    const label = t.rows[0].children[0];
    const got = F.cellsForHit(label, '应用截图@1-2|名称');
    eq(got.length, 2);
    eq(got[0].label, '应用截图');
    eq(got[0].byOffset, true);
    eq(got[0].cells.length, 2);
    eq(got[0].imgs.length, 2, '多格图片按序全取');
    truthy(got[0].imgs[0] === imgA && got[0].imgs[1] === imgB, '图片顺序 = 视觉列顺序');
    /* 只读：不得改动抓取内容语义（这里只读一次内容，确认两条字段都在） */
    const content = F.extractFor(t.rows[1].children[0].childNodes[0], '应用截图@1-2|名称');
    eq(content.length, 2);
  });

  await test('★ cellsForHit：非法 / 越界表达式 → 回退右邻格并标 invalid', () => {
    const img = H.el('img', { src: 'https://ex.com/a.png' });
    const t = table([['应用截图', { html: [img] }, '丙']]);
    const label = t.rows[0].children[0];
    const okRight = F.cellsForHit(label, '应用截图');
    eq(okRight[0].cells.length, 1);
    truthy(okRight[0].cells[0] === t.rows[0].children[1], '留空 = 右邻格');
    eq(okRight[0].invalid, false);
    for (const bad of ['abc', '0', '9']) {
      const got = F.cellsForHit(label, '应用截图@' + bad);
      eq(got.length, 1);
      truthy(got[0].cells[0] === t.rows[0].children[1], '`@' + bad + '` 必须回退右邻格');
    }
    const inv = F.cellsForHit(label, '应用截图@abc')[0];
    eq(inv.invalid, true, '非法表达式要标出来（可选口径：供诊断看）');
  });

  await test('★ 带 `#图` / `#N` 的字段：cellsForHit 照样给出值格里的图（不受图片修饰影响）', () => {
    const img = H.el('img', { src: 'https://ex.com/a.png' });
    const t = table([['应用截图', { html: [img] }, '丙']]);
    const label = t.rows[0].children[0];
    const a = F.cellsForHit(label, '应用截图#图')[0];
    const b = F.cellsForHit(label, '应用截图#图1')[0];
    const c = F.cellsForHit(label, '应用截图#3')[0];
    for (const g of [a, b, c]) {
      eq(g.imgs.length, 1, '取图范围以字段为准，与有没有图片修饰无关');
      truthy(g.imgs[0] === img);
    }
  });

  suite('fetch · 命中记录也能当锚点（img-ocr 走 hits 那条路）');

  await test('★ cellsForHit 接受命中文本节点 / 命中记录（textNode）', () => {
    const img = H.el('img', { src: 'https://ex.com/a.png' });
    const t = table([['应用类型', '交友'], ['应用截图', { html: [img] }]]);
    const tn = t.rows[0].children[1].childNodes[0];
    const byNode = F.cellsForHit(tn, { fetchLabels: '应用截图' });
    eq(byNode.length, 1);
    truthy(byNode[0].imgs[0] === img);
    const byHit = F.cellsForHit({ textNode: tn }, '应用截图');
    eq(byHit.length, 1);
    truthy(byHit[0].imgs[0] === img);
  });

  suite('fetch · 字段后缀 `!` 去空白 / `%` 字符截取');

  await test('`!` = 去内部空白标记，标签本身被剥干净', () => {
    const it = F.parseLabels('包名!')[0];
    eq(it.label, '包名');
    eq(it.stripSpace, true);
    eq(it.sliceSpec, '');
  });

  await test('`%N` 与 `%a-b` = 字符截取标记', () => {
    const a = F.parseLabels('简介%4')[0];
    eq(a.label, '简介'); eq(a.sliceSpec, '4');
    const b = F.parseLabels('简介%2-3')[0];
    eq(b.label, '简介'); eq(b.sliceSpec, '2-3');
    eq(a.stripSpace, false);
  });

  await test('`!` 与 `%` 可与 `#`/`@` 任意顺序混写', () => {
    const a = F.parseLabels('包名!%6')[0];
    eq(a.stripSpace, true); eq(a.sliceSpec, '6');
    const b = F.parseLabels('包名!@2')[0];
    eq(b.stripSpace, true); eq(b.offset, '2');
    const c = F.parseLabels('资质类型#1')[0];
    eq(c.simple, true); eq(c.stripSpace, false);   // 旧语法不破坏
  });

  await test('★ `包名!` 去掉 span 间排版空格（整块 + 简单两条路径）', () => {
    const sp = H.el('span'); sp.appendChild(H.txt('com.example.app'));
    const st = H.el('span'); st.appendChild(H.txt('lite'));
    const mk = () => table([['关键词', 'x'], ['包名', { html: [sp, H.txt(' '), st] }]]);
    // 整块路径
    let tn = mk().rows[0].children[0].childNodes[0];
    let got = F.extractFor(tn, '包名!');
    eq(got[0].rows[0][0].t, 'com.example.applite');
    // 简单模式路径（#1）
    tn = mk().rows[0].children[0].childNodes[0];
    got = F.extractFor(tn, '包名!#1');
    eq(got[0].rows[0][0].t, 'com.example.applite');
    // 对照组：不处理时不吞原有词界空格
    const t2 = table([['关键词', 'x'], ['备注', '网易 严选']]);
    const n2 = t2.rows[0].children[0].childNodes[0];
    truthy(JSON.stringify(F.extractFor(n2, '备注')).indexOf('网易 严选') >= 0, '未加!的普通字段词间空格必须保留');
  });

  await test('★ `%N` 取前 N 字符 / `%a-b` 取第 a~b 字符（按码点切，越界·非法回退全文）', () => {
    const t = table([['关键词', 'x'], ['简介', 'abcdef']]);
    const tn = t.rows[0].children[0].childNodes[0];
    eq(F.extractFor(tn, '简介%4')[0].rows[0][0].t, 'abcd');
    eq(F.extractFor(tn, '简介%2-3')[0].rows[0][0].t, 'bc');
    eq(F.extractFor(tn, '简介#1%4')[0].rows[0][0].t, 'abcd');
    eq(F.extractFor(tn, '简介%99')[0].rows[0][0].t, 'abcdef', '越界应保留全文');
    eq(F.extractFor(tn, '简介%a')[0].rows[0][0].t, 'abcdef', '非法表达式应保留全文');
  });

  await test('★ `!%` 组合：先去空格再截取；中文按字切不拆半', () => {
    const t = table([['关键词', 'x'], ['简介', '关键词 高亮']]);
    const tn = t.rows[0].children[0].childNodes[0];
    eq(F.extractFor(tn, '简介!#1%4')[0].rows[0][0].t, '关键词高亮'.slice(0, 4));   // 去空格后前4字
    eq(F.extractFor(tn, '简介%2-3')[0].rows[0][0].t, '键词');
  });
};
