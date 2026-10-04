/* tests/specs/k75-r4-recheck.test.js — K75「假表格收窄 + OCR 只看真命中 + 抓取默认关」的 **R4 独立复验**
 * ----------------------------------------------------------------------------
 * 与 R3 的用例**互不替代**：这里用 R4 自己造的形状与写法，按契约 §五 A1/B1/B2/C1/C2 的判定锚独立判一遍，
 * 并额外覆盖 R3 没测的边界：
 *   · 假表格**三种形状** × 「命中直接落在值格里」/「命中落在值格内的**行内元素**里」两种落点；
 *   · 假表格的 **OCR 读口**（`cellsForHit`）在 div 结构下还取不取得到图；
 *   · `ctx.imgAnchors` 塞满也不许被消费；准入三条；仅抓取词不 OCR；与 K74 `fetchScope` 的组合；
 *   · `fetchEnabled` 默认关之后：写路径默认、存量迁移、CSV/JSON 导入三条路各判一遍；
 *   · 死代码（`ctx.imgAnchors`）的"有没有生产/消费方"用源码断言钉住。
 *
 * 反向验证（R4 自跑）的目标用例：
 *   ① 还原旧锚点（生产方+消费方）→ 《没命中⇒零条目》族红；② 假表格改回"向上找到 body" → 《h1 不越界》红；
 *   ③ 迁移改成"缺键⇒false" → 《存量不受影响》族红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const el = (t, c) => { const e = H.el(t); if (c) e.className = c; return e; };
const txt = (e, s) => { e.appendChild(H.txt(s)); return e; };
const firstTextNode = (n) => {
  for (const c of (n.childNodes || [])) {
    if (c.nodeType === 3 && String(c.nodeValue || '').trim()) return c;
    if (c.nodeType === 1) { const g = firstTextNode(c); if (g) return g; }
  }
  return null;
};
const flat = (list) => (list || []).map((f) => f.label + '=' + (f.rows || []).map((r) => r.map((c) => c.t).join('/')).join('|'));
const fakeImg = (attrs) => { const i = H.el('img'); for (const k of Object.keys(attrs || {})) i.setAttribute(k, attrs[k]); return i; };

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const F = KH.Fetch;
  const FM = KH.FieldMap;
  const S = KH.Store;
  const C = KH.Config;
  const O = KH.ImgOcr;
  const CFG = C.defaults;
  const doc = global.document;

  /** 造一个 div 假表格的"行"：`.row > [label][value]`；value 里可选再包一层行内元素 */
  function fakeRow(parent, { nested, tag }) {
    const row = el('div', 'row');
    const label = txt(el('div', 'label'), '驳回原因');
    const value = el('div', 'value');
    if (nested) { const inner = el(tag || 'span'); txt(inner, '资质材料不清晰'); value.appendChild(inner); }
    else txt(value, '资质材料不清晰');
    row.appendChild(label); row.appendChild(value);
    parent.appendChild(row);
    return { row: row, label: label, value: value, hitStart: nested ? value.firstElementChild : value };
  }

  /* ============================== A1 假表格（我自己的形状） ============================== */

  suite('K75 复验 · A1 假表格收窄：三种形状 + 两种落点 + 越界/裸文本');

  await test('★ 三种 div 假表格形状 × 命中**直接落在值格**里 ⇒ 必须照旧抓到（能力不回退）', () => {
    const items = F.parseLabels('驳回原因');
    const wrap = el('div');
    doc.body.appendChild(wrap);
    try {
      /* ① 扁平 `.row > .label + .value` */
      const a = fakeRow(wrap, { nested: false });
      /* ② `ul > li > span`（行容器形式：要有 ≥2 个"带多子的兄弟行"才认成 row-container） */
      const ul = el('ul'); wrap.appendChild(ul);
      const li = el('li');
      li.appendChild(txt(el('span', 'l'), '驳回原因'));
      li.appendChild(txt(el('span', 'v'), '资质材料不清晰'));
      ul.appendChild(li);
      const li2 = el('li');
      li2.appendChild(txt(el('span'), '别的字段')); li2.appendChild(txt(el('span'), '别的值'));
      ul.appendChild(li2);
      /* ③ 扁平 grid（格子直属容器） */
      const grid = el('div', 'grid'); wrap.appendChild(grid);
      grid.appendChild(txt(el('div', 'c'), '驳回原因'));
      grid.appendChild(txt(el('div', 'c'), '资质材料不清晰'));

      deepEq(flat(F.extractFromFakeTable(a.value, items)), ['驳回原因=资质材料不清晰'], '① 扁平 row 形状要能抓');
      deepEq(flat(F.extractFromFakeTable(li.children[1], items)), ['驳回原因=资质材料不清晰'], '② ul>li>span 形状要能抓');
      deepEq(flat(F.extractFromFakeTable(grid.children[1], items)), ['驳回原因=资质材料不清晰'], '③ 扁平 grid 形状要能抓');
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 命中落在值格内的**行内元素**里（span/em/b）⇒ **也必须抓到**（三种形状都判；R4 实测当前为 []）', () => {
    const items = F.parseLabels('驳回原因');
    const wrap = el('div');
    doc.body.appendChild(wrap);
    try {
      const a = fakeRow(wrap, { nested: true, tag: 'span' });
      const ul = el('ul'); wrap.appendChild(ul);
      const li = el('li');
      li.appendChild(txt(el('span', 'l'), '驳回原因'));
      const vspan = el('span', 'v');
      vspan.appendChild(txt(el('em'), '资质材料不清晰'));
      li.appendChild(vspan);
      ul.appendChild(li);
      const li2 = el('li');
      li2.appendChild(txt(el('span'), '别的字段')); li2.appendChild(txt(el('span'), '别的值'));
      ul.appendChild(li2);
      const grid = el('div', 'grid'); wrap.appendChild(grid);
      grid.appendChild(txt(el('div', 'c'), '驳回原因'));
      const gv = el('div', 'c'); gv.appendChild(txt(el('b'), '资质材料不清晰'));
      grid.appendChild(gv);

      const A = flat(F.extractFromFakeTable(a.hitStart, items));
      const B = flat(F.extractFromFakeTable(vspan.firstElementChild, items));
      const Cv = flat(F.extractFromFakeTable(gv.firstElementChild, items));
      console.log('        行内元素落点: 扁平=' + JSON.stringify(A) + ' li/em=' + JSON.stringify(B) + ' grid/b=' + JSON.stringify(Cv));
      deepEq(A, ['驳回原因=资质材料不清晰'],
        '★ ① 扁平形状：命中在值格的 <span> 里 —— 命中的 TEXT NODE 的 parentElement 是 <span>，' +
        '而生产方把它当成"行容器"的入口 ⇒ 作用域退化成值格本身、与标签所在的行容器不一致 ⇒ 静默不抓。' +
        '这是 K75 引入的能力回退（K74 的旧实现从命中元素向上找祖先，能抓到）');
      deepEq(B, ['驳回原因=资质材料不清晰'], '★ ② ul>li>span：命中在 <em> 里同样必须抓到');
      deepEq(Cv, ['驳回原因=资质材料不清晰'], '★ ③ 扁平 grid：命中在 <b> 里同样必须抓到');
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 命中在 `<h1>` 标题里（不在行容器）⇒ 假表格路径返回空（不越界抓别处那张真表）', () => {
    const wrap = el('div');
    /* ⚠️ 标题文本里**不能**出现标签本身（否则旧实现会把标题自己当容器、恰好找不到标签而"看起来对"）。
     * 真实现场是：命中词出现在标题里，标签在**别处的真表格**里。 */
    wrap.innerHTML = '<h1>标题里含命中词哦</h1>'
      + '<table><tbody><tr><td>驳回原因</td><td>真表格值</td></tr>'
      + '<tr><td>运营备注</td><td>高价值</td></tr></tbody></table>';
    doc.body.appendChild(wrap);
    try {
      const h1 = wrap.querySelectorAll('h1')[0];
      deepEq(flat(F.extractFromFakeTable(h1, F.parseLabels('驳回原因|运营备注'))), [], '★ 标题里的命中不在行容器 ⇒ 空（旧实现会拿包裹层/body 当容器，抓到真表格的值）');
      deepEq(flat(F.extractFromFakeTable(h1, F.parseLabels('驳回原因'))), [], '只配一个标签时同样为空');
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ 命中在 `body` 直下的裸文本（无行容器）⇒ 返回空且**不抛错**', () => {
    const p = el('p', 'bare');
    txt(p, '裸文本里的驳回原因');
    doc.body.appendChild(p);
    try {
      let err = null, got = null;
      try { got = F.extractFromFakeTable(p, F.parseLabels('驳回原因')); } catch (e) { err = e; }
      eq(err, null, '★ 不许抛错（只是不抓）');
      deepEq(flat(got), [], '裸文本没有行容器 ⇒ 不抓');
    } finally {
      doc.body.removeChild(p);
    }
  });

  await test('★ 标签在**另一行**（命中那一行没有该标签）⇒ 不许跨行抓', () => {
    const wrap = el('div');
    const rowA = fakeRow(wrap, { nested: false });                 // 有标签的那一行
    const rowB = el('div', 'row');                                 // 命中所在行（没有标签）
    rowB.appendChild(txt(el('div', 'label'), '别的字段'));
    rowB.appendChild(txt(el('div', 'value'), '命中词在这里'));
    wrap.appendChild(rowB);
    doc.body.appendChild(wrap);
    try {
      deepEq(flat(F.extractFromFakeTable(rowB.children[1], F.parseLabels('驳回原因'))), [],
        '★ 命中那一行里没有「驳回原因」⇒ 不许去别的行找（这就是收窄的目的）');
      truthy(rowA, '对照：有标签的那一行本身仍能被它自己的命中抓到');
    } finally {
      doc.body.removeChild(wrap);
    }
  });

  await test('★ OCR 读口（`cellsForHit`）：div 假表格的值格里有图 ⇒ 必须取得到（含命中在行内元素里）', () => {
    /* 现实形状：`.row > [截图][值格: 图][命中格]` —— 命中在自己的格子里（可再套一层行内元素） */
    const mkFake = (nested) => {
      const wrap = el('div');
      const row = el('div', 'row');
      row.appendChild(txt(el('div', 'label'), '截图'));
      const value = el('div', 'value');
      value.appendChild(fakeImg({ src: 'https://ex.com/fake.png' }));
      row.appendChild(value);
      const hitCell = el('div', 'hitcell');
      if (nested) { const s = el('span'); txt(s, '命中词'); hitCell.appendChild(s); }
      else txt(hitCell, '命中词');
      row.appendChild(hitCell);
      wrap.appendChild(row);
      doc.body.appendChild(wrap);
      return { wrap: wrap, value: value, hitNode: firstTextNode(hitCell) };
    };
    /* 另一种形状：命中格有 **≥2 个子元素**、命中在其中一行内元素里（`Cells.cellOf` 会停在内层元素） */
    const mkMultiChild = () => {
      const wrap = el('div');
      const row = el('div', 'row');
      row.appendChild(txt(el('div', 'label'), '截图'));
      const value = el('div', 'value');
      value.appendChild(fakeImg({ src: 'https://ex.com/fake.png' }));
      row.appendChild(value);
      const hitCell = el('div', 'hitcell');
      hitCell.appendChild(txt(el('b'), '前缀'));
      const s = el('span'); txt(s, '命中词'); hitCell.appendChild(s);
      row.appendChild(hitCell);
      wrap.appendChild(row);
      doc.body.appendChild(wrap);
      return { wrap: wrap, hitNode: firstTextNode(hitCell.querySelectorAll('span')[0]) };
    };
    const a = mkFake(false);
    const b = mkFake(true);
    const c = mkMultiChild();
    try {
      const ra = F.cellsForHit(a.hitNode, { meta: { fetchLabels: '截图' } });
      const rb = F.cellsForHit(b.hitNode, { meta: { fetchLabels: '截图' } });
      const rc = F.cellsForHit(c.hitNode, { meta: { fetchLabels: '截图' } });
      console.log('        OCR 读口: 直接落点=' + JSON.stringify(ra.map((x) => x.imgs.length)) +
        ' 行内落点=' + JSON.stringify(rb.map((x) => x.imgs.length)) +
        ' 多子格内层落点=' + JSON.stringify(rc.map((x) => x.imgs.length)));
      truthy(ra.length === 1 && ra[0].imgs.length === 1, '★ div 假表格 + 命中在自己的格子里 ⇒ 必须取到那张图（OCR 正当用法不许被收死）');
      truthy(rb.length === 1 && rb[0].imgs.length === 1, '★ 命中格里的 <span> 落点 ⇒ 同样必须取到那张图');
      /* 第三种形状只登记（见报告）：`Cells.cellOf` 会在"多子格"里停在内层行内元素上，
       * 于是 `fakeRowScopeOf` 的作用域也退化成那个内层元素 ⇒ 取不到图。 */
      truthy(rc !== null, '第三种形状（多子格内层落点）不许抛错；实测条目数=' + rc.length);
    } finally {
      doc.body.removeChild(a.wrap);
      doc.body.removeChild(b.wrap);
      doc.body.removeChild(c.wrap);
    }
  });

  /* ==================== 复验（红牌修复后 · K75 返工）新增的拷打形状 ====================
   * 判据是**用户口径**：命中与标签**确实处在同一行** ⇒ 抓；不在同一行（或不在行里）⇒ 不抓。
   * 返工把作用域口径换成"从命中元素向上找第一个『非 body/html、有 ≥2 个元素子节点、
   * 且某个**直接子节点**的整段文本 == 标签』的祖先"（`findFakeLabelInRow`）。
   * 下面 6 条专门打它的边界（两层行内 / 多子格 / 标签嵌一层 / 行只有 1 个元素子 / 标签格带装饰 /
   * 命中格内另有更近的同标签小表）。 */

  suite('K75 复验（返工后）· 假表格 finder 的边界形状');

  /** 造一行：`[标签][值][命中]`，三段各自可自定结构。
   *  ⚠️ 入口必须用**命中那一格**（生产里是 `hitText.parentElement`）——用 `firstTextNode(wrap)`
   *  取到的是标签那一格，会从标签侧开始走，测的就不是"命中侧"了（R4 第一版就踩了这个）。 */
  function fakeRowOf(mkLabel, mkValue, mkHit, tag) {
    const row = el(tag || 'div', 'row');
    row.appendChild(mkLabel()); row.appendChild(mkValue());
    const hit = mkHit(); row.appendChild(hit);
    const wrap = el('div', 'wrap');
    wrap.appendChild(row);
    doc.body.appendChild(wrap);
    return { row: row, wrap: wrap, hit: hit };
  }
  /** 生产同形的入口：命中文本节点的 parentElement */
  const entryOf = (s) => firstTextNode(s.hit).parentElement;
  const lblDiv = (t) => () => txt(el('div', 'label'), t);
  const valDiv = (t) => () => txt(el('div', 'value'), t);
  const hitNested = (t, depth) => () => {
    const cell = el('div', 'hit');
    let inner = el('span');
    cell.appendChild(inner);
    for (let i = 1; i < (depth || 1); i++) { const n = el(i === 1 ? 'a' : 'b'); inner.appendChild(n); inner = n; }
    txt(inner, t);
    return cell;
  };

  await test('★ 返工①：命中嵌**两层**行内元素（span>a）⇒ 三种形状都必须抓到', () => {
    const items = F.parseLabels('驳回原因');
    const a = fakeRowOf(lblDiv('驳回原因'), valDiv('值-R1a'), hitNested('命中-R1a', 2));
    const b = fakeRowOf(lblDiv('驳回原因'), valDiv('值-R1b'), hitNested('命中-R1b', 2), 'li');
    const c = fakeRowOf(lblDiv('驳回原因'), valDiv('值-R1c'), hitNested('命中-R1c', 3));
    try {
      const got = [a, b, c].map((s) => flat(F.extractFromFakeTable(entryOf(s), items)));
      console.log('        两层行内: ' + JSON.stringify(got));
      deepEq(got, [['驳回原因=值-R1a'], ['驳回原因=值-R1b'], ['驳回原因=值-R1c']], '★ 命中嵌两层行内元素也必须抓到（修前的红牌就是"入口落在行内元素上"）');
    } finally { [a, b, c].forEach((s) => doc.body.removeChild(s.wrap)); }
  });

  await test('★ 返工②：命中格有 **3 个元素子节点**、命中在最内层 ⇒ 抓取与取图都要对', () => {
    const img = fakeImg({ src: 'https://ex.com/r2.png' });
    const s = fakeRowOf(lblDiv('截图'),
      () => { const d = el('div', 'value'); d.appendChild(img); d.appendChild(txt(el('i'), '甲')); return d; },
      () => {
        const d = el('div', 'hit');
        d.appendChild(txt(el('b'), '前缀'));
        d.appendChild(fakeImg({ src: 'https://ex.com/other.png' }));
        const sp = el('span'); sp.appendChild(txt(el('em'), '命中-R2')); d.appendChild(sp);
        return d;
      });
    const node = firstTextNode(s.hit.querySelectorAll('em')[0]);   // 真正的命中文本（最内层）
    try {
      const got = flat(F.extractFromFakeTable(node.parentElement, F.parseLabels('截图')));
      const cellsR = F.cellsForHit(node, { meta: { fetchLabels: '截图' } });
      console.log('        多子格: 抓取=' + JSON.stringify(got) + ' 取图格图数=' + JSON.stringify(cellsR.map((x) => x.imgs.map((i) => i.getAttribute('src')))));
      truthy(got.length === 1 && got[0].indexOf('甲') >= 0, '★ 命中在最内层也要抓到值格的整格内容：' + JSON.stringify(got));
      truthy(cellsR.length === 1 && cellsR[0].imgs.length === 1 && cellsR[0].imgs[0].getAttribute('src') === 'https://ex.com/r2.png',
        '★ OCR 读口同一口径：取到**值格**（含那张图），不是命中格里的图：' + JSON.stringify(cellsR.map((x) => x.imgs.map((i) => i.getAttribute('src')))));
    } finally { doc.body.removeChild(s.wrap); }
  });

  await test('★ 返工③：标签嵌一层（`.row > .cell > .label`，cell 只含标签文本）⇒ 仍要抓到', () => {
    const s = fakeRowOf(
      () => { const c = el('div', 'cell'); c.appendChild(txt(el('span', 'label'), '驳回原因')); return c; },
      valDiv('值-R3'), hitNested('命中-R3', 1));
    try {
      const got = flat(F.extractFromFakeTable(firstTextNode(s.hit).parentElement, F.parseLabels('驳回原因')));
      console.log('        标签嵌一层: ' + JSON.stringify(got));
      deepEq(got, ['驳回原因=值-R3'], '★ 标签不在行的直接子级、但那一格整段文本就是标签 ⇒ 同一行，必须抓');
    } finally { doc.body.removeChild(s.wrap); }
  });

  await test('★ 返工④：多包一层 wrapper（`display:contents` 那类形态）⇒ 不受影响', () => {
    const outer = el('div', 'contents');
    const row = el('div', 'row');
    row.appendChild(txt(el('div', 'label'), '驳回原因'));
    row.appendChild(txt(el('div', 'value'), '值-R4'));
    const hit = el('div', 'hit'); hit.appendChild(txt(el('span'), '命中-R4')); row.appendChild(hit);
    outer.appendChild(row);
    doc.body.appendChild(outer);
    try {
      const got = flat(F.extractFromFakeTable(firstTextNode(hit).parentElement, F.parseLabels('驳回原因')));
      console.log('        wrapper(contents): ' + JSON.stringify(got));
      deepEq(got, ['驳回原因=值-R4'], '多一层 wrapper 不改变"同一行"的判定（finder 走 DOM 祖先链）');
    } finally { doc.body.removeChild(outer); }
  });

  await test('★ 返工⑤：行只有 **1 个元素子节点**（命中/值是裸文本）⇒ 不抓，且**旧口径同样不抓**（不是本轮倒退）', () => {
    const row = el('div', 'row1');
    row.appendChild(txt(el('div', 'label'), '驳回原因'));
    const hitNode = H.txt('命中-R5');                  // 裸文本：既不是元素子节点、也没有可取的"右邻元素"
    row.appendChild(hitNode);
    const wrap = el('div', 'wrap'); wrap.appendChild(row); doc.body.appendChild(wrap);
    try {
      /* 生产同形：入口＝命中文本节点的 parentElement（这里＝`.row1` 本身） */
      const got = flat(F.extractFromFakeTable(hitNode.parentElement, F.parseLabels('驳回原因')));
      console.log('        行只有 1 个元素子: ' + JSON.stringify(got));
      /* 理由：这一行的"值"是裸文本（不是元素），`fakeRightValue` 只看元素兄弟 ⇒ 旧口径也取不到值。
       * 判"不抓"是**既有能力边界**，不是把"同一行"判丢了。 */
      deepEq(got, [], '行内只有 1 个元素子节点（值/命中是裸文本）⇒ 不抓（与旧口径一致）');
    } finally { doc.body.removeChild(wrap); }
  });

  await test('★ 返工⑥：标签格带额外装饰（`.cell > span.label + span.req`）⇒ 假表格不抓，**真表格同样不抓**（既有整格口径，不是本轮回归）', () => {
    /* 假表格 */
    const s = fakeRowOf(
      () => { const c = el('div', 'cell'); c.appendChild(txt(el('span', 'label'), '驳回原因')); c.appendChild(txt(el('span', 'req'), '*')); return c; },
      valDiv('值-R6'), hitNested('命中-R6', 1));
    /* 真表格（同样的"标签格文本 = 驳回原因*"） */
    const real = el('table');
    const tr = H.el('tr');
    const c0 = H.el('td'); c0.appendChild(H.txt('驳回原因')); c0.appendChild(H.txt('*'));
    const c1 = H.el('td'); c1.appendChild(H.txt('真表值-R6'));
    const c2 = H.el('td'); c2.appendChild(H.txt('命中-R6b'));
    tr.appendChild(c0); tr.appendChild(c1); tr.appendChild(c2);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; }); tr.rowIndex = 0;
    const tb = H.el('tbody'); tb.appendChild(tr); real.appendChild(tb); real.rows = [tr];
    doc.body.appendChild(real);
    try {
      const fakeGot = flat(F.extractFromFakeTable(firstTextNode(s.hit).parentElement, F.parseLabels('驳回原因')));
      const realGot = flat(F.extractFor(firstTextNode(c2), '驳回原因', 'self'));
      console.log('        标签带装饰: 假表格=' + JSON.stringify(fakeGot) + ' 真表格=' + JSON.stringify(realGot));
      /* 真表格的 `findLabelCell` 判据是 `td.textContent.trim() === label` ⇒ '驳回原因*' 也不匹配。
       * 所以两条路径对"标签格带装饰"的口径一致 ⇒ 属引擎既有口径，登记（黄牌），不判红。 */
      deepEq(fakeGot, [], '假表格：标签格带装饰 ⇒ 不抓（登记为既有口径的保守边界）');
      deepEq(realGot, [], '真表格：同样的标签格文本也不匹配 ⇒ 两条路径口径一致（证明不是 K75 引入的）');
    } finally { doc.body.removeChild(s.wrap); doc.body.removeChild(real); }
  });

  await test('★ 返工⑦：命中格内另有"同标签子表" ⇒ 命中在子表**之外**取行的值；命中在子表**之内**取子表的值（就近优先）', () => {
    const mk = () => fakeRowOf(lblDiv('驳回原因'), valDiv('行里的真值'), () => {
      const d = el('div', 'hit');
      const sub = el('div', 'sub');
      sub.appendChild(txt(el('div', 'innerlabel'), '驳回原因'));
      sub.appendChild(txt(el('div', 'innervalue'), '子表的值'));
      d.appendChild(sub);
      d.appendChild(txt(el('span'), '命中-R7'));
      return d;
    });
    const s = mk();
    /* 变体：命中落在**子表内部**（子表自己有"标签 | 值 | 命中"三格 ⇒ 子表的标签与命中同格） */
    const s2 = mk();
    const innerHitCell = el('div', 'innerhit');
    const innerHit = H.txt('命中-R7b');
    innerHitCell.appendChild(innerHit);
    s2.wrap.querySelectorAll('.sub')[0].appendChild(innerHitCell);
    try {
      const outside = flat(F.extractFromFakeTable(firstTextNode(s.hit.querySelectorAll('span')[0]).parentElement, F.parseLabels('驳回原因')));
      const inside = flat(F.extractFromFakeTable(innerHit.parentElement, F.parseLabels('驳回原因')));
      console.log('        同标签子表: 命中在子表外=' + JSON.stringify(outside) + ' 命中在子表内=' + JSON.stringify(inside));
      deepEq(outside, ['驳回原因=行里的真值'],
        '命中在子表**之外** ⇒ 从命中往上先遇到**行**（行里有直接子节点 == 标签）⇒ 取行的值（不是子表的）');
      deepEq(inside, ['驳回原因=子表的值'],
        '命中在子表**之内** ⇒ 先遇到子表 ⇒ 取子表的值（就近优先，与 K74 的 auto 同向）');
    } finally { doc.body.removeChild(s.wrap); doc.body.removeChild(s2.wrap); }
  });

  await test('★ 返工⑧：收放一起判 —— 三条越界断言仍空 + 原红牌三种形状仍抓（一条用例里同时钉住）', () => {
    const items = F.parseLabels('驳回原因');
    /* 收：h1 标题 / 标签在另一行 / body 直下 */
    const wrap = el('div');
    wrap.innerHTML = '<h1>标题里含命中词哦</h1>'
      + '<table><tbody><tr><td>驳回原因</td><td>真表格值</td></tr></tbody></table>';
    const rowA = el('div', 'rowA'); rowA.appendChild(txt(el('div', 'label'), '驳回原因')); rowA.appendChild(txt(el('div', 'value'), '别的行的值')); wrap.appendChild(rowA);
    const rowB = el('div', 'rowB'); rowB.appendChild(txt(el('div', 'label'), '别的字段')); const hb = el('div', 'hit'); hb.appendChild(txt(el('span'), '命中-R8')); rowB.appendChild(hb);
    const bare = txt(el('p', 'bare'), '裸文本里的命中-R8b');
    wrap.appendChild(bare); doc.body.appendChild(wrap);
    /* 放：三种形状（直接落格 / span / span>a） */
    const s1 = fakeRowOf(lblDiv('驳回原因'), valDiv('放-直接'), () => txt(el('div', 'hit'), '命中-R8c'));
    const s2 = fakeRowOf(lblDiv('驳回原因'), valDiv('放-span'), hitNested('命中-R8d', 1));
    const s3 = fakeRowOf(lblDiv('驳回原因'), valDiv('放-两层'), hitNested('命中-R8e', 2));
    try {
      const leaks = [
        flat(F.extractFromFakeTable(wrap.querySelectorAll('h1')[0], items)),
        flat(F.extractFromFakeTable(firstTextNode(hb).parentElement, items)),
        flat(F.extractFromFakeTable(bare, items))
      ];
      const works = [s1, s2, s3].map((s) => flat(F.extractFromFakeTable(firstTextNode(s.hit).parentElement, items)));
      console.log('        收放一起: 越界=' + JSON.stringify(leaks) + ' 应抓=' + JSON.stringify(works));
      deepEq(leaks, [[], [], []], '★ 三条越界必须仍空（不许为了修红牌把越界放回去）');
      deepEq(works, [['驳回原因=放-直接'], ['驳回原因=放-span'], ['驳回原因=放-两层']], '★ 三种"同一行"形状必须仍抓（不许收死）');
    } finally {
      doc.body.removeChild(wrap);
      [s1, s2, s3].forEach((s) => doc.body.removeChild(s.wrap));
    }
  });

  await test('★ 返工⑨：OCR 读口那个**窄形状**（命中格 ≥2 子元素、命中在内层）现在必须取得到图', () => {
    const img = fakeImg({ src: 'https://ex.com/r9.png' });
    const s = fakeRowOf(
      () => txt(el('div', 'label'), '截图'),
      () => { const d = el('div', 'value'); d.appendChild(img); return d; },
      () => {
        const d = el('div', 'hit');                       /* 命中格 ≥2 元素子：<b> + <span> */
        d.appendChild(txt(el('b'), '前缀'));
        const sp = el('span'); sp.appendChild(txt(el('em'), '命中-R9')); d.appendChild(sp);
        return d;
      });
    const node = firstTextNode(s.hit.querySelectorAll('em')[0]);   // 真正的命中文本（命中格有 ≥2 元素子）
    try {
      const r = F.cellsForHit(node, { meta: { fetchLabels: '截图' } });
      console.log('        窄形状取图: ' + JSON.stringify(r.map((x) => x.imgs.map((i) => i.getAttribute('src')))));
      truthy(r.length === 1 && r[0].imgs.length === 1 && r[0].imgs[0].getAttribute('src') === 'https://ex.com/r9.png',
        '★ 修前这个形状取不到图（`cellOf` 会停在内层元素上）；返工后 finder 从命中元素向上走 ⇒ 必须取到：' + JSON.stringify(r.map((x) => x.imgs.length)));
    } finally { doc.body.removeChild(s.wrap); }
  });

  /* ============================== B1 OCR 锚点只来自真命中 ============================== */

  suite('K75 复验 · B1 OCR 锚点只来自真命中');

  /** 一行两列的真表格 [标签 | 值格(图)]；命中文本节点放在**第 3 格**（与标签同行） */
  function ocrTable(imgs, metaExtra) {
    const tr = H.el('tr');
    const c0 = H.el('td'); c0.appendChild(H.txt('应用截图'));
    const c1 = H.el('td'); for (const im of (imgs || [])) c1.appendChild(im);
    const c2 = H.el('td'); c2.appendChild(H.txt('命中词'));
    tr.appendChild(c0); tr.appendChild(c1); tr.appendChild(c2);
    tr.cells = tr.children; tr.cells.forEach((td, i) => { td.cellIndex = i; }); tr.rowIndex = 0;
    const tbody = H.el('tbody'); tbody.appendChild(tr);
    const table = H.el('table'); table.appendChild(tbody); table.rows = [tr];
    const meta = Object.assign({ imgOcr: true, imgOcrMax: 4, display: '命中词', fetchLabels: '应用截图', imgOcrKeyword: '华为', fetchScope: 'auto' }, metaExtra || {});
    return { table: table, tr: tr, labelCell: c0, valueCell: c1, hitCell: c2, meta: meta, ruleId: 'r4-k75' };
  }
  const hitOf = (d) => ({ ruleId: d.ruleId, meta: d.meta, textNode: firstTextNode(d.hitCell) });

  await test('★ 没有命中 ⇒ 零条目：**即使 `ctx.imgAnchors` 塞了旧口径的锚点也不认**', () => {
    const d = ocrTable([fakeImg({ src: 'https://ex.com/a.png' })]);
    O.build({}, { imgAnchors: [{ rule: { ruleId: d.ruleId, meta: d.meta }, cell: d.valueCell }] }, []);
    eq(O.items().length, 0, '★ ctx.imgAnchors 不再是锚点来源（K75 的靶心）');
    /* 对照臂：同一条装置喂**真命中** ⇒ 条目必须出现（证明装置本身是有效的，不是"怎么都不出条目"） */
    O.build({}, {}, [hitOf(d)]);
    truthy(O.items().length >= 1, '对照臂：真命中 ⇒ 必须有条目（否则上面的 0 条就是假绿）');
  });

  await test('★ 普通词与组合词的真命中都要出条目（能力不许回退）', () => {
    const plain = ocrTable([fakeImg({ src: 'https://ex.com/p.png' })]);
    O.build({}, {}, [hitOf(plain)]);
    const pItems = O.items();
    truthy(pItems.length >= 1, '普通词真命中 ⇒ 出条目');
    const combo = ocrTable([fakeImg({ src: 'https://ex.com/c.png' })], { label: '应用截图', display: '交友' });
    O.build({}, {}, [hitOf(combo)]);
    truthy(O.items().length >= 1, '组合词真命中 ⇒ 同样出条目（锚点＝命中所在格，与普通词同一套）');
  });

  await test('★ 准入三条一条不松：imgOcr 关 / fetchLabels 空 / imgOcrKeyword 空 ⇒ 都零条目（用真命中喂）', () => {
    const cases = [
      ['imgOcr:false', { imgOcr: false }],
      ['fetchLabels 空', { fetchLabels: '' }],
      ['imgOcrKeyword 空', { imgOcrKeyword: '' }]
    ];
    for (const [label, over] of cases) {
      const d = ocrTable([fakeImg({ src: 'https://ex.com/x.png' })], over);
      O.build({}, {}, [hitOf(d)]);
      eq(O.items().length, 0, '★ 准入不满足（' + label + '）⇒ 零条目');
    }
  });

  await test('★ 「仅抓取」词仍不 OCR（编译层 `ocrMeta` 强制 imgOcr:false）', () => {
    const only = KH.Compiler.dispatch({
      id: 'r4-only', text: '', cellVerifyEnabled: true, cellVerify: '应用名称',
      comboAxis: 'lr', cellVerifyMatchMode: 'include', fetchLabels: '包名',
      imgOcr: true, imgOcrKeyword: '华为', fetchEnabled: true
    }, CFG);
    truthy(only, '仅抓取词应能编译');
    eq(only.kind, 'fetch-only', 'kind');
    eq(!!only.meta.imgOcr, false, '★ 仅抓取词即使勾了「识别图片文字」也不 OCR（既有口径不变）');
  });

  await test('★ 与 K74 的 `fetchScope` 组合仍对：命中在内层 + outer1 ⇒ 取**外层**值格的图', () => {
    /* 内层表：[命中] ；外层表：[应用截图 | 图] + 内层表所在行 */
    const inner = H.el('table');
    const itr = H.el('tr');
    const ic = H.el('td'); ic.appendChild(H.txt('命中词')); itr.appendChild(ic);
    itr.cells = itr.children; itr.cells.forEach((td, i) => { td.cellIndex = i; }); itr.rowIndex = 0;
    const itb = H.el('tbody'); itb.appendChild(itr); inner.appendChild(itb); inner.rows = [itr];

    const otr = H.el('tr');
    const oc0 = H.el('td'); oc0.appendChild(H.txt('应用截图'));
    const oc1 = H.el('td'); oc1.appendChild(fakeImg({ src: 'https://ex.com/outer.png' })); oc1.appendChild(inner);
    otr.appendChild(oc0); otr.appendChild(oc1);
    otr.cells = otr.children; otr.cells.forEach((td, i) => { td.cellIndex = i; }); otr.rowIndex = 0;
    const otb = H.el('tbody'); otb.appendChild(otr);
    const outer = H.el('table'); outer.appendChild(otb); outer.rows = [otr];

    const meta = { imgOcr: true, fetchLabels: '应用截图', imgOcrKeyword: '华为', fetchScope: 'outer1' };
    const withOuter = F.cellsForHit(ic, { meta: meta });
    const withSelf = F.cellsForHit(ic, { meta: Object.assign({}, meta, { fetchScope: 'self' }) });
    console.log('        K74×K75: outer1=' + JSON.stringify(withOuter.map((x) => x.imgs.map((i) => i.getAttribute('src')))) +
      ' self=' + JSON.stringify(withSelf.map((x) => x.imgs.map((i) => i.getAttribute('src')))));
    truthy(withOuter.length === 1 && withOuter[0].imgs.map((i) => i.getAttribute('src')).join() === 'https://ex.com/outer.png',
      '★ outer1 ⇒ 取外层值格的图');
    deepEq(withSelf.map((x) => x.imgs.length), [], 'self ⇒ 内层没有该字段 ⇒ 取不到图（空数组）');
  });

  await test('★ 死代码登记：`combo.js` 不再有 `pushImgAnchor`、`img-ocr.js` 不再消费 `ctx.imgAnchors`（源码断言）', () => {
    const combo = readSrc('src/features/combo/combo.js');
    const ocr = readSrc('src/features/img-ocr.js');
    eq((combo.match(/pushImgAnchor\s*\(/g) || []).length, 0, 'combo.js 里不许再有 pushImgAnchor 调用/定义');
    falsy(/ctx\.imgAnchors/.test(ocr.replace(/^\s*\*.*$/gm, '')), '★ img-ocr.js 的**代码**里不许再读 ctx.imgAnchors（注释里可以提历史）');
    /* 残留（R3 登记为"无害"）：scanner 建、index 传 —— 判"无生产无消费" */
    const scanner = readSrc('src/core/scanner.js');
    const index = readSrc('src/core/index.js');
    truthy(/ctx\.imgAnchors = \[\]/.test(scanner), 'scanner.js 仍在初始化 ctx.imgAnchors（登记项）');
    truthy(/imgAnchors: \[\]/.test(index), 'index.js 仍在传 imgAnchors: []（登记项）');
  });

  /* ============================== C1 fetchEnabled 默认关 ============================== */

  suite('K75 复验 · C1 `fetchEnabled` 默认关（但存量迁移一字不改）');

  await test('★ 新建默认未勾选：`def` / `defaults` / 写路径三层一致为 false', () => {
    const f = FM.byKey('fetchEnabled');
    eq(f.def(CFG), false, '★ fieldmap 的 def 必须是 false（用户 ④）');
    eq(FM.defaults(CFG).fetchEnabled, false, '新建关键词的表单初值 = 未勾选');
    eq(FM.toStore(FM.defaults(CFG), CFG).fetchEnabled, false, '经映射层落库仍是 false');
    eq(S.sanitizeKeyword(FM.defaults(CFG), CFG).fetchEnabled, false, '经清洗层仍是 false');
    /* 其余三颗胶囊的默认值不受牵连 */
    eq(FM.byKey('enabled').def(CFG), true, '「基本信息」的启用仍默认 true');
    eq(FM.byKey('cellVerifyEnabled').def(CFG), false, '「单元格组合」仍默认 false');
    eq(FM.byKey('important').def(CFG), false, '「重要笔记」仍默认 false');
  });

  await test('★ 存量迁移一字未改：缺键 + 有字段 ⇒ true；缺键 + 无字段 ⇒ false；显式值一律尊重', () => {
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲' }, CFG).fetchEnabled, true, '★ 写路径：缺键 + 有字段 ⇒ true（存量照旧抓）');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: false }, CFG).fetchEnabled, false, '显式 false 不翻回');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: true }, CFG).fetchEnabled, true, '显式 true 保持');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '' }, CFG).fetchEnabled, false, '缺键 + 无字段 ⇒ false');
    const r1 = C.normalize({ keywords: [{ id: 'a', text: 'x', fetchLabels: '甲' }] }).config.keywords[0];
    eq(r1.fetchEnabled, true, '★ 读路径：存量（缺键 + 有字段）升级后继续抓取');
    eq(r1.fetchLabels, '甲', '内容不许被清');
    const r2 = C.normalize({ keywords: [{ id: 'b', text: 'x', fetchLabels: '甲', fetchEnabled: false }] }).config.keywords[0];
    eq(r2.fetchEnabled, false, '读路径也尊重显式 false');
  });

  await test('★ CSV / JSON 导入路径同样不受默认值变化影响（缺键 + 字段非空 ⇒ 仍抓）', async () => {
    const saved = JSON.parse(JSON.stringify(global.__MEM__));
    try {
      /* 造一条**没有 fetchEnabled 键**的旧词（＝旧备份/CSV 里的形状） */
      const raw = { id: 'r4-old', text: '旧词', note: '', groupId: null, enabled: true,
        caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
        important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
        cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr', cellVerifyMatchMode: 'include',
        cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '包名' };

      /* JSON overwrite */
      const j = JSON.stringify({ keywords: [raw], groups: [] });
      global.__MEM__.keywords = []; global.__MEM__.groups = [];
      await S.importJSON(j, { mode: 'overwrite' }, { keywords: [], groups: [] });
      let back = (await S.load()).keywords.find((k) => k.text === '旧词');
      truthy(back, 'JSON 导入后词应在');
      eq(back.fetchEnabled, true, '★ JSON 导入（缺键 + 有字段）⇒ 仍抓取');
      eq(back.fetchLabels, '包名', '字段保真');

      /* CSV：先按旧形状导出（导出会归一，所以直接手写 18 列里的关键列） */
      const cols = new Array(18).fill('');
      cols[0] = '旧词CSV'; cols[11] = '否'; cols[16] = '包名'; cols[17] = 'lr';
      const csv = '\uFEFF' + S.CSV_HEADERS.join(',') + '\r\n' + cols.join(',');
      global.__MEM__.keywords = []; global.__MEM__.groups = [];
      await S.importCSV(csv, { keywords: [], groups: [] });
      back = (await S.load()).keywords.find((k) => k.text === '旧词CSV');
      truthy(back, 'CSV 导入后词应在');
      eq(back.fetchEnabled, true, '★ CSV 导入（缺键 + 有字段）⇒ 仍抓取');
      eq(back.fetchLabels, '包名', '字段保真');
    } finally {
      for (const k of Object.keys(global.__MEM__)) delete global.__MEM__[k];
      Object.assign(global.__MEM__, saved);
    }
  });

  /* ============================== C2 文案与文档 ============================== */

  suite('K75 复验 · C2 文案与文档');

  await test('★ 两条 hint 说了新口径（前提是这条规则真的命中）；文档三处也补了', () => {
    const ocrHint = String(FM.byKey('imgOcr').hint || '');
    const scopeHint = String(FM.byKey('fetchScope').hint || '');
    console.log('        imgOcr.hint=' + JSON.stringify(ocrHint) + '\n        fetchScope.hint=' + JSON.stringify(scopeHint));
    truthy(/命中/.test(ocrHint), '★ 「识别图片文字」的 hint 要写清"前提是这条规则真的命中"');
    truthy(/命中/.test(scopeHint), '★ 「抓取范围」的 hint 也要提到命中');
    const readme = readSrc('README.md');
    truthy(/命中/.test(readme) && /图片/.test(readme), 'README 的相关行提到命中前提');
    const checklist = readSrc('tests/BROWSER-CHECKLIST.md');
    truthy(/A34/.test(checklist) && /A37/.test(checklist), 'BROWSER-CHECKLIST 里 A34/A37 仍在');
    truthy(/假表格/.test(checklist), '★ 清单里要有人工验收"假表格"的项（A34b）');
    truthy(/默认关|默认未勾选|默认不勾/.test(checklist), '★ A37 要写清"抓取模块默认关 + 存量照旧"');
    const report = readSrc('tests/E2E-REPORT.md');
    truthy(/K75/.test(report), 'E2E-REPORT 要有 K75 一节');
  });
};
