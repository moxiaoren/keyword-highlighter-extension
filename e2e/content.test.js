'use strict';
/* 内容层真浏览器测试：高亮纯视觉 / 组合词 / 多行抓取 / 重要笔记 / 备注卡片 / 翻页与改值 */
const path = require('path');
const { group, test, eq, truthy, falsy, includes, shot, report } = require('./t');
const { CONFIG } = require('./test-config');

/* 面板宽度的**真源**要在 Node 侧取，不能抄数字：内容脚本在隔离世界（见下面 PROBE 的注释），
 * 页面主世界读不到 `window.KH`，所以「面板默认宽度」这条只能从产品模块本身拿。
 * `src/core/config.js` 是 IIFE，副作用挂在 `globalThis.KH.Config`（Node 里没有 window）。
 * 依据（2026-10-13 更新）：SPEC.md:228 显式作废 200px 口径（与本轮需求 2「默认 250px、可调 160–600」冲突）；
 * `config.js` 的 `PANEL_WIDTH_MIN=160 / PANEL_WIDTH_MAX=600 / PANEL_WIDTH_DEFAULT=250`；
 * `config.js` 里的 `notePanelWidth: PANEL_WIDTH_DEFAULT`。 */
/* 装置两边都能跑：扩展仓内（\`<仓>/e2e/\`，扩展目录就是上一级）与老工作区的 \`_e2e/\`
 * （扩展在 \`../work/keyword-highlighter\`）。所以按「KH_EXT_DIR → 上一级有 manifest.json → 老工作区」取，
 * 别写死一条相对路径——写死的那次在 CI 里直接 Cannot find module。 */
const EXT_DIR = process.env.KH_EXT_DIR
  ? path.resolve(process.env.KH_EXT_DIR)
  : (require('fs').existsSync(path.join(__dirname, '..', 'manifest.json'))
    ? path.resolve(__dirname, '..')
    : path.resolve(__dirname, '..', 'work', 'keyword-highlighter'));
require(path.join(EXT_DIR, 'src', 'core', 'config.js'));
const KHConfig = globalThis.KH.Config;

const FIX = (origin, f) => origin + '/' + f;

/** 取页面主世界可见的信息（内容脚本在隔离世界，只能看 DOM 与 CSS.highlights） */
const PROBE = () => {
  const hasHL = typeof CSS !== 'undefined' && !!CSS.highlights;
  const groups = [];
  let ranges = 0;
  if (hasHL) {
    CSS.highlights.forEach((hl, name) => {
      const n = (hl.size !== undefined) ? hl.size : (hl.ranges ? hl.ranges.length : 0);
      ranges += n;
      groups.push(name + '=' + n);
    });
  }
  return {
    state: document.documentElement.getAttribute('data-kh-state'),
    hasHL, groups, ranges,
    // 插件在页面里留下的"高亮 DOM 节点"必须为 0
    pluginNodes: document.querySelectorAll('.kh-highlight,[data-kh-highlighted],[data-kh-important],[data-kh-keyword-id]').length,
    // 允许存在的三条插件属性：data-kh-ext-ui（自身 UI 宿主）/ data-kh-state（就绪标记）/
    // data-kh-hl-style（::highlight 规则样式表）。除此之外的任何 data-kh-* 都算"用 DOM 承载命中数据"。
    khDataAttrs: (document.documentElement.outerHTML.match(/data-kh-(?!ext-ui|state|hl-style)[a-z-]+/g) || []),
    extUiHosts: document.querySelectorAll('[data-kh-ext-ui]').length,
    hlStyleTags: document.querySelectorAll('style[data-kh-hl-style]').length,
    panelHost: !!document.getElementById('kh-important-note-host'),
    cardHost: !!document.getElementById('kh-note-card'),
    tooltipHost: !!document.getElementById('kh-note-tooltip')
  };
};

/** 命中该元素的所有高亮 Range（用 textNode + 偏移比对，比 intersectsNode 稳） */
const HITS_OF = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const nodes = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = w.nextNode())) nodes.push(n);
  const marks = [];
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.forEach((hl, name) => {
      try {
        for (const r of hl) {
          if (nodes.indexOf(r.startContainer) >= 0) {
            marks.push({ name, s: r.startOffset, e: r.endOffset, t: r.startContainer.nodeValue.slice(r.startOffset, r.endOffset) });
          }
        }
      } catch (e) { /* ignore */ }
    });
  }
  return { found: true, marks, text: el.textContent };
};

/** 某个 selector 文本命中的视觉背景色（真实 CUSTOM HIGHLIGHT 只能通过 ::highlight 取，
 *  这里用"该点是否在 CSS.highlights 的任一 Range 内"来判断命中，用 styleSheets 读规则颜色） */
const VISUAL = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const range = document.createRange();
  range.selectNodeContents(el);
  const hitNames = [];
  let color = null;
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.forEach((hl, name) => {
      let overlaps = false;
      try {
        for (const r of hl) { if (r.intersectsNode && r.intersectsNode(el)) { overlaps = true; break; } }
      } catch (e) { /* ignore */ }
      if (overlaps) hitNames.push(name);
    });
  }
  // 从注入的 ::highlight 规则里读颜色
  const rules = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list = [];
    try { list = Array.from(sheet.cssRules || []); } catch (e) { continue; }
    for (const r of list) {
      if (r.selectorText && /::highlight\(/.test(r.selectorText)) {
        rules.push({ sel: r.selectorText, bg: r.style.backgroundColor, color: r.style.color });
      }
    }
  }
  if (hitNames.length && rules.length) {
    const m = rules.find(x => x.sel.indexOf(hitNames[0]) >= 0);
    if (m) color = m.bg;
  }
  return { found: true, text: el.textContent, hitNames, color, ruleCount: rules.length, rules };
};

/** 取「命中词在视口里的中心点」——用 Range 的真实矩形，等价于用户鼠标位置。
 *  注意：page.evaluate 只把**一个**参数传给回调，所以这里收数组解构。 */
const POINT_OF = (arg) => {
  const sel = arg[0], needle = arg[1];
  const el = document.querySelector(sel);
  if (!el) return null;
  let tn = null;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = w.nextNode())) { if ((n.nodeValue || '').indexOf(needle) >= 0) { tn = n; break; } }
  if (!tn) return null;
  const idx = tn.nodeValue.indexOf(needle);
  const r = document.createRange();
  r.setStart(tn, idx); r.setEnd(tn, idx + needle.length);
  const rect = r.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: tn.nodeValue.slice(idx, idx + needle.length) };
};

module.exports = async function runContent(ctx) {
  const { api, origin } = ctx;
  const page = await api.context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  /** 【台账 #2】只剩悬窗一种形态（贴边条/摘要列已删）。旧用例围绕 .khin-panel/.khin-item 写，
   * 需要面板时等宿主出现即可；若它处于收起态（.khin-fab），点开再看；没有宿主时静默跳过。 */
  const openFloatPage = async (pg) => {
    /* 笔记是扫描后异步算出来的：宿主可能晚一拍出现，先等它（没有命中时静默放行）。 */
    try {
      await pg.waitForFunction(() => !!document.getElementById('kh-important-note-host'), null, { timeout: 3000 });
    } catch (e) { /* 这一页没有重要笔记 */ }
    const ok = await pg.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      if (!sr) return false;
      const wrap = sr.querySelector('.khin-wrap');
      if (wrap && wrap.hidden) return false;
      if (sr.querySelector('.khin-panel')) return true;
      const fab = sr.querySelector('.khin-fab');
      if (fab) fab.click();
      return !!sr.querySelector('.khin-panel');
    });
    if (ok) await pg.waitForTimeout(250);
    return ok;
  };
  const openFloat = () => openFloatPage(page);

  const fresh = async (file, opts) => {
    await page.goto(FIX(origin, file), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
    await page.waitForTimeout(400);   // silent/gap 已注入 0，稍等一轮重建
    /* 默认就是悬窗；openFloat 只在收起态（FAB）时点开，保持旧用例的读法。 */
    if (!opts || opts.float !== false) await openFloat();
  };

  /* ---------------------------------------------------------- 1. 纯视觉 */
  group('1. 高亮纯视觉（绝不改 DOM）', { aspects: ['visual'] });

  await test('扩展进入高亮态且 CSS.highlights 生效', async () => {
    await fresh('list.html');
    const p = await page.evaluate(PROBE);
    eq(p.state, 'on', 'data-kh-state 应为 on');
    truthy(p.hasHL, '浏览器应支持 CSS.highlights');
    truthy(p.ranges > 0, '应有高亮 Range，实际 ' + p.ranges);
    console.log('        highlight 组: ' + p.groups.join(', '));
  });

  await test('★ 页面 DOM 里插件生成的高亮节点数 = 0', async () => {
    const p = await page.evaluate(PROBE);
    eq(p.pluginNodes, 0, '不得出现 .kh-highlight / data-kh-* 高亮节点');
    eq(p.khDataAttrs.length, 0, '不得出现"命中数据载体"型 data-kh-* 属性，实际 ' +
      JSON.stringify(p.khDataAttrs.slice(0, 5)) + '（允许的只有 data-kh-ext-ui / data-kh-state / data-kh-hl-style）');
    console.log('        允许的自身 UI 宿主: ' + p.extUiHosts + ' 个；::highlight 样式表: ' + p.hlStyleTags + ' 个');
  });

  await test('★ 普通词命中（正文 + 表格内）', async () => {
    const v = await page.evaluate(VISUAL, '#tbody tr:nth-child(1) td:nth-child(2)');
    truthy(v.found, '页面应有命中格');
    eq(v.text.trim(), '审核不通过');
    truthy(v.hitNames.length > 0, '表格里的「审核不通过」应命中，实际 hitNames=' + JSON.stringify(v.hitNames));
    console.log('        命中格: ' + JSON.stringify(v.text.trim()) + ' 组: ' + JSON.stringify(v.hitNames) + ' 颜色: ' + v.color);
  });

  await test('★ 颜色优先级：分组色 > 关键词自身色 > 全局默认', async () => {
    const all = await page.evaluate(() => {
      const out = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let list = [];
        try { list = Array.from(sheet.cssRules || []); } catch (e) { continue; }
        for (const r of list) if (r.selectorText && /::highlight\(/.test(r.selectorText)) out.push(r.style.backgroundColor);
      }
      return out;
    });
    console.log('        注入的 ::highlight 背景色集合: ' + JSON.stringify([...new Set(all)]));
    truthy(all.some(c => /51,\s*136,\s*255|#3388ff/i.test(c)), '应存在分组色 #3388ff（rgb(51,136,255)），实际 ' + JSON.stringify(all));
    truthy(all.some(c => /255,\s*149,\s*0|#ff9500/i.test(c)), '应存在全局默认色 #ff9500');
    falsy(all.some(c => /255,\s*0,\s*0|#ff0000/i.test(c)), '关键词自身红色应被分组色压过，不应出现 #ff0000');
  });

  await test('页面无 JS 报错', async () => {
    falsy(errors.length, '控制台报错：' + errors.join(' | '));
  });

  /* ---------------------------------------------------------- 2. 翻页 / 改值 */
  group('2. 翻页残留 / 值后到 / 原地改值（characterData）', { aspects: ['hit'] });

  await test('★ 整表替换（翻页）后：新内容正常写入、无残留、新高亮正确', async () => {
    /* 【必须自己起页】按方面裁剪时，上一组可能被跳过 —— 组不能依赖"前一组留下的页面"，
     * 否则单独跑本方面会整组假红（实测：裁掉第 1 组后本组 3 条全红，因为页面还是 about:blank）。 */
    await fresh('list.html');
    await page.evaluate(() => {
      document.getElementById('tbody').innerHTML =
        '<tr><td>新应用</td><td>com.new.app</td><td>审核通过</td><td>无</td><td>普通</td><td>无</td></tr>';
    });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const firstCell = document.querySelector('#tbody tr td');
      const range = document.createRange();
      range.selectNodeContents(firstCell);
      let hit = 0;
      CSS.highlights.forEach((hl) => { try { for (const r of hl) if (r.intersectsNode(firstCell)) { hit++; break; } } catch (e) {} });
      return { text: firstCell.textContent, hit, rows: document.querySelectorAll('#tbody tr').length };
    });
    eq(after.rows, 1, '翻页后应只剩 1 行');
    eq(after.text, '新应用', '新内容必须能写进页面（孤儿节点问题不复现）');
    eq(after.hit, 0, '新行不含关键词 → 不应有高亮残留');
  });

  await test('★ 原地改 nodeValue（characterData）→ 高亮刷新', async () => {
    await page.evaluate(() => {
      const c = document.querySelector('#tbody tr td:nth-child(3)');
      c.childNodes[0].nodeValue = '审核不通过';       // 原地改值，不发 childList
    });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const c = document.querySelector('#tbody tr td:nth-child(3)');
      let hit = 0;
      CSS.highlights.forEach((hl) => { try { for (const r2 of hl) if (r2.intersectsNode(c)) { hit++; break; } } catch (e) {} });
      return { text: c.textContent, hit };
    });
    eq(r.text, '审核不通过');
    truthy(r.hit > 0, 'nodeValue 原地改值后必须重新高亮（characterData 生效）');
  });

  await test('★ td.textContent = 新值 → 高亮刷新（不是只改 nodeValue）', async () => {
    await page.evaluate(() => {
      document.querySelector('#tbody tr td:nth-child(3)').textContent = '审核通过';
    });
    await page.waitForTimeout(400);
    const cleared = await page.evaluate(() => {
      const c = document.querySelector('#tbody tr td:nth-child(3)');
      let hit = 0;
      CSS.highlights.forEach((hl) => { try { for (const r of hl) if (r.intersectsNode(c)) { hit++; break; } } catch (e) {} });
      return hit;
    });
    eq(cleared, 0, '改成不含关键词的值后不应残留高亮（形态过滤误杀会在这里暴露）');
  });

  /* ---------------------------------------------------------- 3. 组合词 */
  group('3. 单元格组合词', { aspects: ['hit'] });

  await test('★ 左右格组合词：标题「资质类型」→ 右格核心「资质A1」命中（跨节点）', async () => {
    await fresh('list.html');
    const r = await page.evaluate(HITS_OF, '#tbl-lr');
    truthy(r.found, '应有 #tbl-lr');
    const texts = r.marks.map(m => m.t);
    console.log('        该行命中片段: ' + JSON.stringify(texts) + '  行文本: ' + JSON.stringify(r.text.trim()));
    truthy(texts.indexOf('资质A1') >= 0, '标题格右侧的「资质A1」应被左右格组合词命中，实际 ' + JSON.stringify(texts));
    console.log('        （资质A2 与资质A1 分属不同文本节点：单个文本节点内匹配是既有口径，不跨节点拼接）');
  });

  await test('★ 组合词：标题格本身不高亮', async () => {
    const r = await page.evaluate(() => {
      const cell = document.querySelector('#tbl-lr tr td');   // 标题「资质类型」
      const nodes = [];
      const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
      let n; while ((n = w.nextNode())) nodes.push(n);
      let hit = 0;
      CSS.highlights.forEach((hl) => { try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { hit++; break; } } catch (e) {} });
      return { hit, text: cell.textContent };
    });
    eq(r.text.trim(), '资质类型');
    eq(r.hit, 0, '标题格本身不应高亮（只做定位）');
  });

  await test('★ 上下格组合词：仅表头生效（数据区碰巧含「是否刚需」的行不误触发）', async () => {
    const r = await page.evaluate(() => {
      const hitOf = (el) => {
        const nodes = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let c = 0;
        CSS.highlights.forEach((hl) => { try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) {} });
        return c;
      };
      const rows = document.querySelectorAll('#tbl-tb tbody tr');
      return {
        good: hitOf(rows[0].children[1]),
        decoyRow: hitOf(rows[1].children[0])
      };
    });
    truthy(r.good > 0, '表头「是否刚需」列下的「否」应命中（tb 组合词）');
    eq(r.decoyRow, 0, '数据区碰巧含列标题文本的单元格不应被当成表头');
  });

  await test('★ el-table 分表（表头表 + 数据表）tb 组合词能正确定列', async () => {
    await fresh('eltable.html');
    const r = await page.evaluate(() => {
      const hitOf = (el) => {
        const nodes = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let c = 0;
        CSS.highlights.forEach((hl) => { try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) {} });
        return c;
      };
      const rows = document.querySelectorAll('.el-table__body-wrapper tbody tr');
      return { r0: hitOf(rows[0].children[1]), text: rows[0].children[1].textContent };
    });
    eq(r.text, '审核不通过');
    truthy(r.r0 > 0, 'el-table：表头「审核状态」列下的「审核不通过」应命中（跨表按列对齐）');
  });

  /* 回归夹具 eltable-group.html：el-table 的**多级表头**（thead.is-group 两行）。
   * 旧 dataRows 把"非命中表头行"当成数据行返回，导致 columnDataCells 提前 return、
   * 永远走不到跨表定位 → 上下格组合词整列失效（用户实测缺陷）。 */
  await test('★ el-table 多级表头（thead 两行）tb 组合词仍能正确定列', async () => {
    await fresh('eltable-group.html');
    const r = await page.evaluate(() => {
      const hitOf = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return -1;
        const nodes = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let c = 0;
        CSS.highlights.forEach((hl) => {
          try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) { /* ignore */ }
        });
        return c;
      };
      return { target: hitOf('#tb-target'), decoy: hitOf('#tb-decoy') };
    });
    truthy(r.target > 0,
      '多级表头 el-table：表头「是否刚需」列下的「否」应命中（thead 有第二行不得短路跨表定位）');
    eq(r.decoy, 0,
      '同一个「否」出现在非命中列（备注列）不应被命中 —— 列必须定位准，不是整行乱命中');
  });

  /* ---------------------------------------------------------- 4. 多行抓取 */
  group('4. 抓取后续字段（多行内容格式）', { aspects: ['fetch'] });

  await test('★ 重要笔记面板出现，且多行「驳回原因」保留换行、不折叠', async () => {
    await fresh('list.html');
    const host = page.locator('#kh-important-note-host');
    await host.waitFor({ state: 'attached', timeout: 8000 });
    await page.waitForTimeout(500);
    const entries = await host.evaluate((h) => {
      const sr = h.shadowRoot;
      return Array.from(sr.querySelectorAll('.khin-item')).map(it => {
        const note = it.querySelector('.khin-item-note');
        const tbl = it.querySelector('table.kh-table');
        const td = tbl ? tbl.querySelector('td') : null;
        return {
          tags: it.querySelector('.khin-item-tags') ? it.querySelector('.khin-item-tags').textContent : '',
          noteText: note ? note.innerText : '',
          noteWS: note ? getComputedStyle(note).whiteSpace : null,
          tableText: tbl ? tbl.innerText : '',
          tdWS: td ? getComputedStyle(td).whiteSpace : null,
          tableCount: it.querySelectorAll('table.kh-table').length
        };
      });
    });
    truthy(entries.length > 0, '面板应有条目');
    console.log('        面板条目数: ' + entries.length + '，标签: ' + JSON.stringify(entries.map(e => e.tags)).slice(0, 220));
    const target = entries.find(e => /驳回原因/.test(e.tableText));
    truthy(target, '应有一张卡抓到了「驳回原因」字段，实际各卡表格: ' +
      JSON.stringify(entries.map(e => e.tableText.slice(0, 80))));
    includes(target.tableText, '资质材料不清晰', '多行内容第一行应存在');
    includes(target.tableText, '请重新上传营业执照', '多行内容第二行应存在');
    truthy(/pre-line|pre-wrap/.test(target.noteWS), '笔记容器必须 white-space: pre-line/pre-wrap，实际 ' + target.noteWS);
    truthy(/pre-line|pre-wrap/.test(target.tdWS), '抓取表格单元格必须保留换行，实际 ' + target.tdWS);
    await shot(page, '01-panel-multiline');
  });

  await test('★ 重要笔记字号：默认 11px，「字号」配置改成 14 后面板正文跟着变（配置 → 面板 CSS 变量链）', async () => {
    const noteFS = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const note = host && host.shadowRoot && host.shadowRoot.querySelector('.khin-item-note');
      return note
        ? { fs: getComputedStyle(note).fontSize, v: (host.style.getPropertyValue('--kh-note-fs') || '').trim() }
        : null;
    });
    const waitNote = async () => {
      await page.locator('#kh-important-note-host').waitFor({ state: 'attached', timeout: 8000 });
      await page.waitForTimeout(400);
    };

    await fresh('list.html');
    await waitNote();
    const d = await noteFS();
    truthy(d, '面板应有重要笔记条目（否则字号无从验起）');
    eq(d.fs, '11px', '★ 默认字号 11px（用户 2026-10-09：比上一版的 12px 再小一号）；实际 ' + d.fs);
    eq(d.v, '11px', '字号走 CSS 变量而不是写死，实际 --kh-note-fs=' + JSON.stringify(d.v));

    /* 配置里改「字号」→ 重开页面 → 正文必须跟着变，否则「字号可配」只是设置页里的摆设 */
    await api.setConfig(Object.assign({}, CONFIG, { importantNote: { imgSize: 70, fontSize: 14 } }));
    await fresh('list.html');
    await waitNote();
    const c = await noteFS();
    truthy(c, '改了配置后面板仍应有条目');
    eq(c.fs, '14px', '★ 配置 fontSize=14 后面板正文应是 14px；实际 ' + c.fs);
    eq(c.v, '14px', '变量值要跟着配置走，实际 --kh-note-fs=' + JSON.stringify(c.v));

    /* 收尾：配置回到启动基线并重开一页 —— 别把 14px（和半截重建）留给后面的用例 */
    await api.setConfig(CONFIG);
    await fresh('list.html');
  });

  await test('★ 抓取表格只有「字段 label」格上色：首行不是表头，不许整行刷底色', async () => {
    const host = page.locator('#kh-important-note-host');
    const r = await host.evaluate((h) => {
      const tables = Array.from(h.shadowRoot.querySelectorAll('table.kh-table'));
      const t = tables.find(x => /驳回原因/.test(x.innerText));
      if (!t) return { found: false, all: tables.map(x => x.innerText.slice(0, 40)) };
      const cells = [];
      Array.from(t.querySelectorAll('tr')).forEach((tr, ri) => {
        Array.from(tr.querySelectorAll('td')).forEach(td => cells.push({
          row: ri,
          t: (td.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 12),
          label: td.classList.contains('kh-table-label'),
          bg: getComputedStyle(td).backgroundColor
        }));
      });
      return { found: true, isFetch: t.classList.contains('kh-table-fetch'), cells };
    });
    truthy(r.found, '应找到「驳回原因」抓取表格，实际：' + JSON.stringify(r.all));
    truthy(r.isFetch, '抓取表格必须带 kh-table-fetch 标记类（否则会被"首行当表头"的规则整行刷底色）');

    const isTinted = (c) => c.bg !== 'rgb(255, 255, 255)' && c.bg !== 'rgba(0, 0, 0, 0)';
    const wrong = r.cells.filter(c => !c.label && isTinted(c));
    eq(wrong.length, 0, '除「字段 label」格外任何格子都不许上色（首行是数据、不是表头），实际上色 = ' + JSON.stringify(wrong));
    const labels = r.cells.filter(c => c.label);
    truthy(labels.length >= 1, '应有「字段 label」格');
    truthy(labels.every(isTinted), '「字段 label」格应作为列标题上色，实际 = ' + JSON.stringify(labels));
    // 用户反馈的原话："每列第一个单元格都标了底色" —— 首行里非 label 的格子必须无色
    const firstRowOthers = r.cells.filter(c => c.row === 0 && !c.label);
    truthy(firstRowOthers.length > 0, '首行应有非 label 的格子（二级标题 / 分组标题）');
    truthy(firstRowOthers.every(c => !isTinted(c)), '首行非 label 的格子必须无色，实际 = ' + JSON.stringify(firstRowOthers));
    console.log('        上色格 ' + labels.length + ' 个: ' + JSON.stringify(labels.map(c => c.t)) +
      ' / 全表 ' + r.cells.length + ' 格');
    await shot(page, '01b-fetch-label-only');
  });

  await test('★ 抓取字段标题可截断（省宽度）、抓取到的内容必须完整（用户 2026-10-11）', async () => {
    const host = page.locator('#kh-important-note-host');
    const r = await host.evaluate((h) => {
      const tables = Array.from(h.shadowRoot.querySelectorAll('table.kh-table'));
      const t = tables.find(x => /驳回原因/.test(x.innerText));
      if (!t) return { found: false, all: tables.map(x => x.innerText.slice(0, 40)) };
      /* 真浏览器量几何：CSS 到底有没有把长标题裁掉、有没有误伤短标题与内容格 */
      const probe = (span) => {
        const cs = getComputedStyle(span);
        const before = span.textContent;
        span.textContent = '抓取字段标题截断容量测试'.repeat(3);
        const long = { c: span.clientWidth, s: span.scrollWidth, ch: span.clientHeight, sh: span.scrollHeight };
        span.textContent = before;
        const short = { c: span.clientWidth, s: span.scrollWidth, ch: span.clientHeight, sh: span.scrollHeight };
        return {
          text: before, title: span.getAttribute('title'), disp: cs.display, mh: cs.maxHeight,
          ovf: cs.overflow, mw: cs.maxWidth, long, short
        };
      };
      const labels = Array.from(t.querySelectorAll('td.kh-table-label'));
      const spans = labels.map(td => (td.firstElementChild && td.firstElementChild.className === 'kh-lbt')
        ? probe(td.firstElementChild)
        : { missing: true, html: td.innerHTML.slice(0, 80), text: td.textContent });
      /* 内容格（值）不许截断：取全表里文字最长的那一格当代表 */
      const valTds = Array.from(t.querySelectorAll('td')).filter(td => !td.classList.contains('kh-table-label'));
      const v = valTds.map(td => ({
        text: (td.textContent || '').trim(),
        to: getComputedStyle(td).textOverflow,
        over: td.scrollWidth - td.clientWidth
      })).sort((a, b) => b.text.length - a.text.length)[0] || null;
      /* 标题封顶绝不能把**表格**顶出容器（nowrap 就会：真机 185 > 178） */
      const holder = t.closest('.khin-item-body') || t.parentElement;
      const geom = { t: Math.round(t.getBoundingClientRect().width), holder: Math.round(holder.getBoundingClientRect().width) };
      return { found: true, spans, valCount: valTds.length, v, geom };
    });
    truthy(r.found, '应找到「驳回原因」抓取表格，实际：' + JSON.stringify(r.all));
    const missing = r.spans.filter(s => s.missing);
    eq(missing.length, 0, '每个字段标题格都要有一层 .kh-lbt（老笔记由渲染时就地补，见 important-note.noteFragment），缺的 = ' + JSON.stringify(missing));
    /* 读数先打再断言：断言失败时这一行就是证据 */
    if (r.spans.length) {
      console.log('        标题格 ' + r.spans.length + ' 个 上限 ' + r.spans[0].mw + ' 长文本 盒' + r.spans[0].long.c + ' 高' +
        r.spans[0].long.ch + '/' + r.spans[0].long.sh + ' 短文本 盒' + r.spans[0].short.c + ' 高' + r.spans[0].short.ch +
        ' / 表 ' + r.geom.t + ' ≤ 容器 ' + r.geom.holder +
        ' / 值格 ' + r.valCount + ' 个，最长 ' + JSON.stringify(r.v ? r.v.text.slice(0, 20) : '') + ' overflow=' + (r.v ? r.v.over : '-'));
    }
    for (const s of r.spans) {
      truthy(/^inline/.test(s.disp),
        '标题盒必须是 inline 档（inline-block）：块级会让 innerText 多一个换行，实际 ' + s.disp);
      eq(s.ovf, 'hidden', '溢出的部分要藏起来（裁到一行，不是把字吞掉），实际 ' + s.ovf);
      truthy(/em|px/.test(s.mw) && parseFloat(s.mw) > 0, '标题要有封顶宽度，实际 ' + s.mw);
      truthy(/em|px/.test(s.mh) && parseFloat(s.mh) > 0, '标题要限高到一行（max-height），实际 ' + s.mh);
      eq(s.title, s.text, '全文必须挂在 title 上（视觉截断、悬停可读回，信息不许真丢）');
      /* 三倍长文本下：盒子不长高（确实被裁在一行），也不横向溢出（裁的是文字不是撑宽）。
         ⚠️ 别拿 scrollHeight 判一行：溢出内容照样算进 scrollHeight（真机实测 长文本 ch=17 / sh=594），
         判据是「长文本的盒子高 == 短文本的盒子高」。 */
      truthy(s.long.ch <= s.short.ch + 1,
        '长标题必须被裁在一行内（盒子不许因长文本长高），实际 长' + JSON.stringify(s.long) + ' 短' + JSON.stringify(s.short));
      truthy(s.long.c <= parseFloat(s.mw) + 1, '长标题的盒子不得超出封顶宽度，实际 ' + s.long.c + ' > ' + s.mw);
      /* 短标题也**允许**被裁：这张表值格要占满容器（真机 值列 143 / 表 178），留给标题的只有 ~32px。
         所以不判「短标题不许被裁」，只判它仍然是一行 + 全文在 title 里（信息可读回，见上一条）。
         真正不许发生的是「把表格顶出容器」（下一条）与「值格被裁」（全表那两条）。 */
    }
    truthy(r.v, '表里应有内容格（值）');
    truthy(r.v.to !== 'ellipsis', '★ 抓取到的内容不许截断（值格的 text-overflow 不是 ellipsis），实际 ' + r.v.to);
    truthy(r.v.over <= 1, '★ 值格内容必须完整可见（横向不许被裁），实际溢出 ' + r.v.over + 'px：' + r.v.text.slice(0, 30));
    truthy(r.geom.t <= r.geom.holder + 1,
      '★ 标题封顶不许把表格顶宽（表格 ≤ 容器；nowrap 版真机实测 185 > 178）：' + JSON.stringify(r.geom));
    await shot(page, '01c-fetch-label-truncate');
  });

  await test('★ flex 并排多段内容合并成一行（不被拆成多行）', async () => {
    const host = page.locator('#kh-important-note-host');
    const t = await host.evaluate((h) => {
      const tables = Array.from(h.shadowRoot.querySelectorAll('table.kh-table'));
      const tgt = tables.find(x => /运营备注/.test(x.innerText));
      return tgt ? tgt.innerText : '(未找到含「运营备注」的表格)';
    });
    // 运营备注是 <div class="flexcell"><div>高价值</div><div>需跟进</div></div>
    // 视觉行应合并为「高价值 需跟进」；若被按块级切行会变成两行
    const lines = t.split('\n');
    const joined = lines.some(l => /高价值/.test(l) && /需跟进/.test(l));
    truthy(joined, 'flex 同行的「高价值」「需跟进」应合并到同一行，实际表格文本：\n' + t);
  });

  await test('★ 仅抓取触发判据：右格为「-」不显示，右格有内容才显示', async () => {
    const host = page.locator('#kh-important-note-host');
    const r = await host.evaluate((h) => {
      const tables = Array.from(h.shadowRoot.querySelectorAll('table.kh-table'));
      const tgt = tables.find(x => /包名/.test(x.innerText));
      return { found: !!tgt, text: tgt ? tgt.innerText : '', all: tables.map(x => x.innerText.slice(0, 60)) };
    });
    console.log('        仅抓取卡片: ' + JSON.stringify(r.text));
    truthy(r.found, '应有抓到「包名」的卡片，实际各卡：' + JSON.stringify(r.all));
    includes(r.text, 'com.foo.real', '右格有内容的「有值应用」应被抓取显示');
    falsy(/空值应用/.test(r.text), '右格为「-」的「空值应用」不应显示（不回退抓标题右格）');
  });

  /**
   * 装置表 ③ 抓的是「包名」这一列，所以面板表格里的**值行**就等价于"哪些右格被当成了内容"：
   *   · 右格只有控件的 3 行（按钮应用 / 操作列应用 / 伪链接应用）→ 剔除控件后为空 → **不该产生值行**
   *   · 右格 `- + 按钮` → 剔除按钮后是 `-` → 值就是 `-`（控件文字不许混进去）
   *   · 右格 `- 备注：需补材料` → 含真内容 → 值原样保留
   * 这比"某行标签名有没有出现"实在得多（标签名本来也不会进抓取值）。
   */
  const panelValueLines = () => page.locator('#kh-important-note-host').evaluate((h) => {
    const tables = Array.from(h.shadowRoot.querySelectorAll('table.kh-table'));
    const tgt = tables.find(x => /包名/.test(x.innerText));
    const text = tgt ? tgt.innerText : '';
    // 首行是 [label 包名][第一个值]，其余行各一个值
    const lines = text.split('\n').filter(s => s.trim() !== '');
    return { text, lines };
  });

  await test('★ 右格只有控件 → 剔除后为空，不产生值行；控件文字不进抓取值', async () => {
    const r = await panelValueLines();
    console.log('        卡片文本: ' + JSON.stringify(r.text));
    for (const junk of ['编辑', '删除']) {
      falsy(new RegExp(junk).test(r.text), '抓取值里不许混进控件文字「' + junk + '」，实际 ' + JSON.stringify(r.text));
    }
    includes(r.text, 'com.foo.real', '真内容那一行仍要正常显示（不能连坐）');
    // 5 行 = label 行(包名 + 空值应用的 `-`) + com.foo.real + `-`(占位加按钮) + `无` + `- 备注：需补材料`
    // 若 3 个"只有控件"的行被算成有内容，这里会多出 3 行
    eq(r.lines.length, 5, '值行数应为 5（3 个只有控件的行不该产生值），实际 = ' + JSON.stringify(r.lines));
    await shot(page, '01c-trigger-controls');
  });

  await test('★ 右格「占位串 + 控件」：按钮被剔除，占位串照旧保留为值', async () => {
    const r = await panelValueLines();
    console.log('        卡片文本: ' + JSON.stringify(r.text));
    // `- <button>编辑</button>` 的取值必须是 `-`，不能是 `- 编辑`
    falsy(/- *编辑/.test(r.text), '「- + 按钮」的取值只该是 `-`，实际 ' + JSON.stringify(r.text));
    includes(r.text, '- 备注：需补材料', '占位串后面的真内容必须完整保留');
    // 单一 `-` 值行确实存在（占位串作为**字段值**保留，与"不触发"是两回事）
    truthy(r.lines.some(l => l.trim() === '-'), '应有一个值为 `-` 的行，实际 ' + JSON.stringify(r.lines));
  });

  await test('★ 内容分卡：内容不同 → 分成多张卡', async () => {
    const host = page.locator('#kh-important-note-host');
    const n = await host.evaluate((h) => h.shadowRoot.querySelectorAll('.khin-item').length);
    truthy(n >= 2, '应有至少 2 张卡（内容不一致绝不进同一卡），实际 ' + n);
  });

  await test('组合词标签形态：🔖 标题 → 关键词', async () => {
    const host = page.locator('#kh-important-note-host');
    const tags = await host.evaluate((h) => Array.from(h.shadowRoot.querySelectorAll('.khin-item-tags')).map(x => x.textContent));
    console.log('        标签: ' + JSON.stringify(tags));
    truthy(tags.some(t => /🔖/.test(t)), '应使用 🔖 前缀');
    truthy(tags.some(t => /资质类型/.test(t) && /→/.test(t) && /资质A1/.test(t)),
      '组合词标签应为「🔖 资质类型 → 资质A1」形态，实际 ' + JSON.stringify(tags));
  });

  await test('★ 一格多图：一行缩略图必须留在**同一行**（不得变成一列多行）；图文混排保序', async () => {
    /* 用户实测（真实站点结构）：`<td>应用截图</td><td colspan=8><div class=inline-block><ul><li
     * class=img-list-item>…`×4 —— 4 张缩略图是 display:inline-block + vertical-align:middle，
     * 高矮不一（实测 top＝139/130/142/134，最大差 12px）→ 旧实现按"top 差 ≤8px"判同一行，
     * 于是渲染成 `rowspan=4` 的**一列 4 行单图**。这里锁死"同一行 + 原顺序"。
     * 装置：`_e2e/fixtures/fetch-imgs.html`。 */
    const KW = {
      id: 'kImgProbe', text: '', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: true, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '应用名称', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '应用截图|备注说明'
    };
    try {
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW] }));
      await fresh('fetch-imgs.html');
      const rows = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table-fetch');
        if (!t) return null;
        return Array.from(t.querySelectorAll('tr')).map((tr) => ({
          text: Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()).filter(Boolean).join(' | '),
          imgs: Array.from(tr.querySelectorAll('img')).map((i) => i.getAttribute('alt'))
        }));
      });
      console.log('        抓取表逐行: ' + JSON.stringify(rows));
      truthy(rows, '应抓到「应用截图 / 备注说明」并渲染出抓取表');
      const imgRows = rows.filter((r) => r.imgs.length);
      eq(imgRows.length, 2, '只有两行带图＝「4 张截图那一行」+「混排里那张图」（旧实现会是 5 行），实际 ' + JSON.stringify(imgRows.map((r) => r.imgs)));
      eq(JSON.stringify(imgRows[0].imgs), JSON.stringify(['截图1', '截图2', '截图3', '截图4']),
        '同一格的多张图必须在**同一行**且保持网页里的原顺序');
      const iText1 = rows.findIndex((r) => r.text.indexOf('先看文字') >= 0);
      const iImg = rows.findIndex((r) => r.imgs.indexOf('混合图') >= 0);
      const iText2 = rows.findIndex((r) => r.text.indexOf('再看结尾文字') >= 0);
      truthy(iText1 >= 0 && iImg >= 0 && iText2 >= 0, '三段内容都应抓到，实际 ' + JSON.stringify([iText1, iImg, iText2]));
      truthy(iText1 < iImg && iImg < iText2,
        '图文混排必须保持网页顺序（文字 → 图 → 文字），实际行序 ' + JSON.stringify([iText1, iImg, iText2]));
      await shot(page, '20-fetch-multi-img');
    } finally {
      await api.setConfig(CONFIG);          // 还原共享配置
    }
  });

  await test('★ 图片字段：`#图` 仅图片 / `#N` 前 N 张 / 多列图都抓到、纯数字计数格不显示', async () => {
    /* 用户实测两条：
     *   ① "抓取需要支持仅图片、前几张图片的方式" → 字段后缀 `#图`（仅图片）/ `#N`（前 N 张）/ `#图N`；
     *   ② 占位/最新版本/历史版本 那种结构里，历史版本为空时页面写的是计数 `0`，
     *      旧的展示会"后面多出现一个单独 0 的单元格"。
     * 装置 `fixtures/fetch-imgs-cols.html`（两张截图行：第一行历史版本是 0，第二行有 3 张图）。 */
    const KW = {
      id: 'kImgOpt', text: '', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: true, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '占位', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '截图#图2'
    };
    try {
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW] }));
      await fresh('fetch-imgs-cols.html');
      const r = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table-fetch');
        if (!t) return null;
        const lab = t.querySelector('.kh-table-label');
        return {
          imgs: Array.from(t.querySelectorAll('img')).map((i) => i.getAttribute('alt')),
          cells: Array.from(t.querySelectorAll('td')).map((td) => (td.textContent || '').trim()),
          /* 2.0.2.17 需求① 起字段名格里**不再**有后缀徽标（后缀只留在设置页），这里直接读名字 */
          label: ((lab ? lab.textContent || '' : '')).trim(),
          suffix: (lab ? (lab.querySelector('.kh-table-suffix') ? 'HAS-SUFFIX' : '') : '')
        };
      });
      console.log('        截图字段: ' + JSON.stringify(r));
      truthy(r, '应抓到「截图」字段');
      eq(r.label, '截图', '字段名就是「截图」（2.0.2.17 需求①：后缀不许进笔记）');
      eq(r.suffix, '', '★ 字段名格里不许再出现后缀徽标（用户原话：无需展示抓取字段的后缀）');
      eq(r.imgs.length, 2, '`#图2` = 仅图片且最多 2 张（整字段累计），实际 ' + JSON.stringify(r.imgs));
      truthy(r.cells.indexOf('0') < 0, '历史版本那个计数 0 **不该**作为单元格出现（用户实测缺陷），实际 ' + JSON.stringify(r.cells));
      truthy(r.cells.every((c) => !/^\d+$/.test(c)), '图片字段里不该有"纯数字"的计数格：' + JSON.stringify(r.cells));
      await shot(page, '23-fetch-img-opts');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  await test('★ 网页自带看图器：抓取以原展示为准（浮层图片+计数文字都不抓），但浮层文字仍能命中', async () => {
    /* 用户口径（1.99.99.13/14）：
     *   · 抓取：网页自己看图器新加的容器 = 临时展示，**不算字段内容**（图片与 `1/5` 这类文字都不抓）；
     *   · 命中：与抓取无关 —— 浮层里新加的文字**该命中就命中**。
     * 装置：`list.html` 的「驳回原因」值格里有 `#fetch-img`；这里**在值格里插一个绝对定位浮层**模拟看图器。 */
    await fresh('list.html');
    const readFetch = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table-fetch');
      if (!t) return null;
      return {
        imgs: t.querySelectorAll('img').length,
        text: (t.innerText || '').replace(/\s+/g, ' ')
      };
    });
    let before = null;
    for (let i = 0; i < 15 && !before; i++) { await page.waitForTimeout(200); before = await readFetch(); }
    truthy(before && before.imgs > 0, '应先抓到「驳回原因」里的原图，实际 ' + JSON.stringify(before));
    console.log('        插浮层前: imgs=' + before.imgs + ' text=' + JSON.stringify(before.text.slice(0, 40)));

    // 模拟网页自己的看图器：在**同一个值格里**插一个覆盖视口的绝对定位容器（大图 + 计数文字 + 命中词）
    await page.evaluate(() => {
      const cell = document.querySelector('#fetch-img').closest('td');
      const ov = document.createElement('div');
      ov.id = 'kh-fake-viewer';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8)';
      ov.innerHTML = '<img src="pixel.png" alt="网页大图"><span>1/5</span><span>审核不通过</span>';
      cell.appendChild(ov);
    });
    await page.waitForTimeout(1500);            // 等一轮重建

    const after = await readFetch();
    console.log('        插浮层后: imgs=' + after.imgs + ' text=' + JSON.stringify(after.text.slice(0, 40)));
    eq(after.imgs, before.imgs, '网页看图器里的大图**不该**被多抓一张（用户：没必要）');
    falsy(/1\s*\/\s*5/.test(after.text), '浮层里的计数文字 `1/5` 不该进抓取结果，实际 ' + JSON.stringify(after.text));
    includes(after.text, '资质材料不清晰', '网页原本的内容照旧抓（抓取以原展示为准）');

    // 命中与抓取无关：浮层里新加的文字**仍然要被扫描命中**
    const inOverlay = await page.evaluate(() => {
      const ov = document.getElementById('kh-fake-viewer');
      if (!ov) return { found: false };
      const nodes = [];
      const w = document.createTreeWalker(ov, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = w.nextNode())) nodes.push(n);
      let hits = 0;
      CSS.highlights.forEach((hl) => {
        try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) { hits++; break; } } catch (e) { /* ignore */ }
      });
      return { found: true, hits: hits };
    });
    console.log('        浮层内命中: ' + JSON.stringify(inOverlay));
    truthy(inOverlay.found && inOverlay.hits > 0, '浮层里新加的文字该命中的仍要命中（命中与抓取无关），实际 ' + JSON.stringify(inOverlay));

    await page.evaluate(() => { const ov = document.getElementById('kh-fake-viewer'); if (ov) ov.remove(); });
    await page.waitForTimeout(800);
  });

  await test('★ K71 验收 2：抓取模块未启用 → 面板**不出现**抓取到的字段值；启用/缺键（存量）→ 出现', async () => {
    /* 【契约 §五.2 与 §六① 的靶心】R3 自述"内容层这条不在我的写范围，没有加"，由 R4 独立补。
     * 造数据走**正常配置写入路径**（`api.setConfig` 写 chrome.storage → 内容脚本经
     * `Config.load → normalize` 读进来），**不是**手写裸对象直接开弹窗 —— 绕开 normalize 的
     * 关键词缺 `fetchEnabled` 时会被 toForm 的 bool coerce 成 false，那样测的就不是迁移口径了。
     * 装置 `list.html`：k1「审核不通过」配 `fetchLabels='驳回原因|运营备注'`，值格里有
     * 「资质材料不清晰<br>请重新上传营业执照」。面板里那张「驳回原因」抓取表就是判据。 */
    const base = CONFIG.keywords.find(k => k.id === 'k1');
    const kws = (over) => CONFIG.keywords.map(k => (k.id === 'k1' ? Object.assign({}, base, over) : k));
    const readPanel = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const wrap = host && host.shadowRoot
        ? (host.shadowRoot.querySelector('.khin-wrap') || host.shadowRoot.querySelector('.khin-panel'))
        : null;
      if (!wrap) return { panel: false, text: '', tables: [] };
      return {
        panel: true,
        text: (wrap.textContent || '').replace(/\s+/g, ' '),
        tables: Array.from(wrap.querySelectorAll('table.kh-table')).map(t => (t.textContent || '').replace(/\s+/g, ' '))
      };
    });
    /** 等到"驳回原因表出现/不出现"稳定为止（重建是异步的，不许读一帧就断言） */
    const waitFetch = async (want) => {
      let r = await readPanel();
      for (let i = 0; i < 25; i++) {
        if (r.tables.some(t => /驳回原因/.test(t)) === want) return r;
        await page.waitForTimeout(200);
        r = await readPanel();
      }
      return r;
    };
    try {
      /* A. 关闭：面板本身照旧在（k1 的「重要」没动 → 各管各的），但抓取值一个都不许出现 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: kws({ fetchEnabled: false }) }));
      await fresh('list.html');
      const off = await waitFetch(false);
      truthy(off.panel, '面板应存在（k1 仍标着「重要」→ 面板要出来；否则"没出现"只是"面板没渲染"，说服力为 0）');
      truthy(off.tables.some(t => /包名/.test(t)), '对照：别的词的抓取照旧（k5 的「包名」）—— 证明抓取机制本身没坏');
      console.log('        关闭态：面板表 = ' + JSON.stringify(off.tables.map(t => t.slice(0, 24))));
      eq(off.tables.filter(t => /驳回原因/.test(t)).length, 0,
        '★ fetchEnabled=false 时不许出现「驳回原因」抓取表，实际表: ' + JSON.stringify(off.tables.map(t => t.slice(0, 30))));
      falsy(/资质材料不清晰/.test(off.text), '★ fetchEnabled=false 时面板里不许出现抓取到的字段值，实际面板文本: ' + JSON.stringify(off.text.slice(0, 220)));
      falsy(/高价值/.test(off.text), '★ 同一字段第二行（运营备注的值）也不许出现');

      /* B. 缺键＝存量：迁移（读路径 normalize）必须让它**照旧抓取**，绝不能静默停抓 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: kws({}) }));
      await fresh('list.html');
      const miss = await waitFetch(true);
      truthy(miss.tables.some(t => /驳回原因/.test(t)),
        '★ 缺 fetchEnabled 的存量配置升级后必须照旧抓取（缺键≠停抓），实际表: ' + JSON.stringify(miss.tables.map(t => t.slice(0, 30))));
      includes(miss.text, '资质材料不清晰', '存量配置抓到的字段值要出现在面板里');

      /* C. 明确打开：出现（否则本用例是"永远不出现"的假绿） */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: kws({ fetchEnabled: true }) }));
      await fresh('list.html');
      const on = await waitFetch(true);
      includes(on.text, '资质材料不清晰', '★ fetchEnabled=true 时抓取值必须出现（本条是上面"不出现"的对照臂）');
      await shot(page, '24-fetch-enabled-gate');
    } finally {
      await api.setConfig(CONFIG);          // 还原共享配置
    }
  });

  await test('★ K71 复验（裁定 2 · 红牌 B）：imp 关 + 抓取开 → 面板**出抓取值、不出本词笔记正文**；imp 开 → 正文在；两者都关 → 面板不存在', async () => {
    /* R4 上一轮在这条上判过红（旧实现在 `important=false + wantFetch` 时把 `importantNote`
     * 一起带进面板）。本轮返工把"卡片存在性"与"卡片正文归属"拆开，这里从**面板层**独立复核。
     * 造数据仍走正常配置写入路径（`api.setConfig` → 内容层 `Config.normalize`）。 */
    const KW = (over) => Object.assign({
      id: 'kR4ImpB', text: '审核不通过', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: false, importantNote: 'R4正文标记甲', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '驳回原因'
    }, over);
    const readPanel = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const wrap = host && host.shadowRoot
        ? (host.shadowRoot.querySelector('.khin-wrap') || host.shadowRoot.querySelector('.khin-panel'))
        : null;
      return {
        host: !!host, panel: !!wrap,
        text: wrap ? (wrap.textContent || '').replace(/\s+/g, ' ') : '',
        cards: wrap ? wrap.querySelectorAll('.khin-item').length : 0
      };
    });
    try {
      /* 臂①（靶心）：面板必须**真的渲染了**（抓取值在），但本词笔记正文一个字都不许有 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ important: false, fetchEnabled: true })] }));
      await fresh('list.html');
      await page.waitForTimeout(1200);
      const a1 = await readPanel();
      console.log('        臂① imp关+抓取开: ' + JSON.stringify(a1));
      truthy(a1.panel, '臂① 面板必须存在（抓取开着 → 卡片在，这是验收 2 的口径）');
      truthy(a1.cards > 0, '臂① 面板应有卡片，实际 ' + a1.cards);
      includes(a1.text, '资质材料不清晰', '★ 臂① 抓取值必须出现 —— 它同时是"面板真的渲染了"的对照臂');
      falsy(/R4正文标记甲/.test(a1.text), '★ 臂① 没勾「重要笔记」→ 本词笔记正文**不许**出现在面板里，实际 ' + JSON.stringify(a1.text.slice(0, 160)));

      /* 臂②：勾上「重要笔记」→ 与现状一致（正文在、抓取值也在） */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ important: true, fetchEnabled: true })] }));
      await fresh('list.html');
      await page.waitForTimeout(1200);
      const a2 = await readPanel();
      console.log('        臂② imp开+抓取开: ' + JSON.stringify(a2));
      includes(a2.text, 'R4正文标记甲', '★ 臂② 勾了「重要笔记」→ 正文照旧出现（对照臂）');
      includes(a2.text, '资质材料不清晰', '臂② 抓取值照旧');

      /* 臂③：两个模块都关 → 连卡片都不存在 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ important: false, fetchEnabled: false })] }));
      await fresh('list.html');
      await page.waitForTimeout(1200);
      const a3 = await readPanel();
      console.log('        臂③ 两者都关: ' + JSON.stringify(a3));
      falsy(a3.host, '★ 臂③ 两个模块都关 → 不该出现面板宿主（旧行为已合格，防返工把它弄坏）');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ---------------------------------------------------------- 5. 面板交互 */
  group('5. 重要笔记面板交互', { aspects: ['interact'] });

  await test('★ K71 复验（裁定 2 · 分组级不误伤）：分组「重要」+ 组笔记 → 词没勾「重要笔记」也照出**组笔记**；词自己勾了则出本词笔记', async () => {
    /* 返工把"本词那一半"乘了 `kw.important`，最容易顺手把 `groupImportant` 那半也改掉。
     * 这里用**面板层**判：分组标记「重要」时，组内关键词自己没勾「重要笔记」，卡片仍要在、
     * 组笔记仍要显示；对照组＝词自己勾了 → 显示本词笔记（`ownNote || groupNote` 的优先级）。 */
    const GROUP = {
      id: 'gR4Imp', name: 'R4分组', bgColor: '#3388ff', textColor: '#ffffff',
      important: true, importantNote: 'R4分组笔记标记', impNoteUseHlColor: false, imgSize: ''
    };
    const KW = (over) => Object.assign({
      id: 'kR4Grp', text: '审核不通过', note: '', groupId: 'gR4Imp', enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: ''
    }, over);
    const readPanel = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const wrap = host && host.shadowRoot
        ? (host.shadowRoot.querySelector('.khin-wrap') || host.shadowRoot.querySelector('.khin-panel'))
        : null;
      return {
        host: !!host, panel: !!wrap,
        text: wrap ? (wrap.textContent || '').replace(/\s+/g, ' ') : '',
        cards: wrap ? wrap.querySelectorAll('.khin-item').length : 0
      };
    });
    try {
      /* 臂①（易过修的那条）：分组重要 + 词没勾、无抓取 → 卡片在、显示**组笔记** */
      await api.setConfig(Object.assign({}, CONFIG, { groups: [GROUP], keywords: [KW({ important: false })] }));
      await fresh('list.html');
      await page.waitForTimeout(1200);
      const g1 = await readPanel();
      console.log('        分组臂① 词没勾: ' + JSON.stringify(g1));
      truthy(g1.panel && g1.cards > 0, '★ 分组「重要」必须仍让组内关键词进面板（分组级口径一字未动），实际 ' + JSON.stringify(g1));
      includes(g1.text, 'R4分组笔记标记', '★ 词自己没勾「重要笔记」→ 正文落回**分组笔记**，不许被误伤成空');

      /* 臂②（对照）：词自己勾了「重要笔记」+ 自己的正文 → 显示本词笔记（ownNote 优先） */
      await api.setConfig(Object.assign({}, CONFIG, { groups: [GROUP], keywords: [KW({ important: true, importantNote: 'R4本词笔记标记' })] }));
      await fresh('list.html');
      await page.waitForTimeout(1200);
      const g2 = await readPanel();
      console.log('        分组臂② 词自己勾了: ' + JSON.stringify(g2));
      includes(g2.text, 'R4本词笔记标记', '★ 词自己勾了 → 显示本词笔记');
      falsy(/R4分组笔记标记/.test(g2.text), '本词笔记非空时不应再叠加组笔记（ownNote || groupNote 的既有优先级）');
      await shot(page, '25-imp-rework-group');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  await test('★ 2.0.2.5 置顶排序：pinOrder 里的词按填写顺序置顶，未命中的卡片保持原相对顺序', async () => {
    /* 需求④ 的「落盘 → 面板」半边（在真机上判，不靠单测的自己人视角）。
     * 断言刻意**不写死关键词**：先量默认顺序，再把**最后两张卡**反着填进 pinOrder ——
     * 这样它只依赖「置顶按填写顺序生效 + 其余稳定」这条口径，词库怎么改都不过期。
     * 【关键】pinOrder 填的是**卡片的关键词本体**（`entries[].kw`）；卡头那两个 span 的名字是反的：
     * `.khin-item-kw` 装的是**标签名**（`🔖 {adj}`），`.khin-item-adj` 才装关键词（`→ {kw}`），
     * 没有标签时才退回 `.khin-item-kw` 里的 `🔖 {kw}` —— 见 `important-note.js` 的 `head.tagHtml`。
     * 第一版拿整串展示文本去填、第二版拿反了的 span 去填，各红过一次。 */
    const readCards = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      if (!sr) return null;
      return Array.from(sr.querySelectorAll('.khin-item')).map((it) => {
        const t = it.querySelector('.khin-item-tags');
        const full = t ? (t.textContent || '').trim().replace(/\s+/g, ' ') : '';
        const kwEl = t && t.querySelector('.khin-item-kw');
        const adjEl = t && t.querySelector('.khin-item-adj');
        const src = adjEl || kwEl;
        const kw = src ? (src.textContent || '').trim().replace(/^(🔖|→)\s*/, '') : '';
        return { full: full, kw: kw };
      });
    });
    const waitOrder = async (n) => {
      await page.locator('#kh-important-note-host').waitFor({ state: 'attached', timeout: 8000 });
      for (let i = 0; i < 25; i++) {
        const o = await readCards();
        if (o && o.length >= n) return o;
        await page.waitForTimeout(200);
      }
      return await readCards();
    };

    try {
      await api.setConfig(CONFIG);
      await fresh('list.html');
      const base = await waitOrder(3);
      truthy(base && base.length >= 3, '默认配置下 list.html 应至少 3 张卡片（否则置顶无从验起），实际 ' + JSON.stringify(base));
      console.log('        默认顺序: ' + JSON.stringify(base.map((c) => c.full)));

      /* 从后往前挑两张**关键词合法**的卡（非空、不含分隔符、互不相同）—— 置顶表就是关键词表。 */
      const pick = [];
      for (let i = base.length - 1; i >= 0 && pick.length < 2; i--) {
        const kw = base[i].kw;
        if (!kw || /[,，、\r\n]/.test(kw)) continue;
        if (pick.some((p) => p.kw === kw)) continue;
        pick.push({ i: i, kw: kw, full: base[i].full });
      }
      truthy(pick.length === 2, 'list.html 的最后两张卡应有关键词本体可用于置顶，实际 ' + JSON.stringify(pick));
      const b = pick[0], a = pick[1];
      const rest = base.filter((c, i) => i !== a.i && i !== b.i);
      const withPin = Object.assign({}, CONFIG, {
        importantNote: Object.assign({}, CONFIG.importantNote, { pinOrder: b.kw + ',' + a.kw })
      });
      await api.setConfig(withPin);
      await fresh('list.html');
      const after = await waitOrder(base.length);
      console.log('        置顶后顺序: ' + JSON.stringify(after.map((c) => c.full)));

      eq(after[0].full, b.full, '★ pinOrder 的第一个词必须成为第一张卡片（填 ' + b.kw + '）');
      eq(after[1].full, a.full, 'pinOrder 的第二个词排第二（按填写顺序，不是按原出现顺序）');
      eq(after.slice(2).map((c) => c.full).join(' | '), rest.map((c) => c.full).join(' | '),
        '未命中的卡片必须保持原相对顺序（稳定排序），实际 ' + JSON.stringify(after.map((c) => c.full)));
      await shot(page, '26-imp-pin-order');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  await test('★ 默认只有一种形态：悬窗常驻左上（台账 #2）；贴边条/摘要列已删净', async () => {
    /* 【必须自己起页】同第 2 组：本组依赖"页面上有重要笔记内容"，
     * 不能依赖前一组（第 4 组）留下的页面 —— 否则单独跑 interact 方面会假红。 */
    await fresh('list.html');
    /* 【台账 #2】用户拍板 A 方案：删掉 rail（贴边条）与 list（摘要列），只留悬窗；
     * 收起改由悬窗头部「收起」→ 48px FAB（下一组专门测这条回环）。 */
    const box = await page.locator('#kh-important-note-host').evaluate((h) => {
      const sr = h.shadowRoot;
      const p = sr.querySelector('.khin-panel');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return {
        left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width),
        rail: !!sr.querySelector('.khin-rail'),
        drawer: !!sr.querySelector('.khin-drawer'),
        rows: sr.querySelectorAll('.khin-row').length,
        items: sr.querySelectorAll('.khin-item').length
      };
    });
    truthy(box, '默认形态应是悬窗（.khin-panel）');
    falsy(box.rail, '贴边条已删，不该再出现，实际 ' + JSON.stringify(box));
    falsy(box.drawer, '摘要列已删，不该再出现，实际 ' + JSON.stringify(box));
    truthy(box.left < 100 && box.top < 100, '悬窗默认停在左上角（v1.52.0 口径不变），实际 ' + JSON.stringify(box));
    truthy(box.width >= KHConfig.PANEL_WIDTH_MIN,
      '悬窗宽度应达到最小可读宽度 ' + KHConfig.PANEL_WIDTH_MIN + 'px，实际 ' + box.width);
    truthy(box.items > 0, '默认悬窗展开态应直接给出全部条目');
  });

  await test('★ 收起只有一条路径：头部「收起」→ 面板换成一颗 FAB；点 FAB 回到悬窗', async () => {
    await fresh('list.html');
    const collapsed = await page.locator('#kh-important-note-host').evaluate((host) => {
      const sr = host.shadowRoot;
      const b = sr.querySelector('[data-act="collapse"]');
      if (!b) return { err: '没有「收起」按钮' };
      b.click();
      const fab = sr.querySelector('.khin-fab');
      return {
        err: null,
        fab: !!fab,
        badge: fab && fab.querySelector('.khin-fab-badge') ? fab.querySelector('.khin-fab-badge').textContent : '',
        aria: fab ? fab.getAttribute('aria-label') : '',
        panel: !!sr.querySelector('.khin-panel'),
        rail: !!sr.querySelector('.khin-rail'),
        drawer: !!sr.querySelector('.khin-drawer')
      };
    });
    truthy(!collapsed.err && collapsed.fab, '点头部「收起」后应换成 FAB，实际 ' + JSON.stringify(collapsed));
    falsy(collapsed.panel, '收起后面板本体不该还在');
    falsy(collapsed.rail, '贴边条已删，不该再出现');
    falsy(collapsed.drawer, '摘要列已删，不该再出现');
    truthy(Number(collapsed.badge) > 0, 'FAB 徽标应带条数，实际 ' + JSON.stringify(collapsed.badge));
    truthy(/条/.test(collapsed.aria), 'FAB 的 aria 文案要说清条数，实际 ' + collapsed.aria);
    await shot(page, '02-panel-collapsed');
    await page.locator('#kh-important-note-host').evaluate((host) => host.shadowRoot.querySelector('.khin-fab').click());
    await page.waitForTimeout(350);
    const back = await page.locator('#kh-important-note-host').evaluate((host) => ({
      panel: !!host.shadowRoot.querySelector('.khin-panel'),
      fab: !!host.shadowRoot.querySelector('.khin-fab')
    }));
    truthy(back.panel, '点 FAB 应回到悬窗');
    falsy(back.fab, '展开后不该还留着 FAB');
  });

  await test('★ 单条关闭：✕ 后该条不再出现（本次会话）', async () => {
    const before = await page.locator('#kh-important-note-host').evaluate((h) => h.shadowRoot.querySelectorAll('.khin-item').length);
    truthy(before > 0, '关闭前应有条目');
    const btnBox = await page.locator('#kh-important-note-host').evaluate((h) => {
      const b = h.shadowRoot.querySelector('.khin-item-close');
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(btnBox.x, btnBox.y);
    await page.waitForTimeout(400);
    const after = await page.locator('#kh-important-note-host').evaluate((h) => {
      const w = h.shadowRoot.querySelector('.khin-wrap');
      const hidden = w.hasAttribute('hidden');
      return { count: h.shadowRoot.querySelectorAll('.khin-item').length, hidden };
    });
    truthy(after.hidden || after.count < before, '关闭一条后条目数应减少或面板隐藏，前 ' + before + ' 后 ' + JSON.stringify(after));
  });

  /* ---------------------------------------------------------- 6. 备注卡片 / 悬停 */
  /* ---------------------------------------------------------- 5b. 面板不闪 */
  group('5b. 重要笔记面板：重建时不许闪', { aspects: ['interact'] });

  /* 用户报的「重要笔记闪烁」。根因：⑧Clear 的 feature clear 钩子调 emptyKeepShell() → hide()
   * （`.khin-wrap[hidden]` = display:none 会取消入场动画 `khin-in`），
   * ⑦Consume 的 render() 又无条件 show() → 动画每次重建都从 opacity 0 重播。
   * 同一次同步管线里 clear 与 consume 之间必然发生强制样式刷新（scanner/renderer/fetch 里都有
   * getComputedStyle / getBoundingClientRect），浏览器因此真的"看见"了 display:none。
   * 这里用真浏览器把「不该隐藏 / 不该清空重建 / 不该重播动画」三条都锁住。 */
  await test('★ 与笔记内容无关的页面变更 → 面板不隐藏、内容不清空、不重播入场动画', async () => {
    await fresh('list.html');
    await page.locator('#kh-important-note-host').waitFor({ state: 'attached', timeout: 8000 });
    await page.waitForTimeout(800);          // 等首次入场动画（160ms）跑完再开始观测

    const r = await page.evaluate(async () => {
      const sr = document.getElementById('kh-important-note-host').shadowRoot;
      const wrap = sr.querySelector('.khin-wrap');
      const panel = sr.querySelector('.khin-panel');
      const body = sr.querySelector('.khin-body');
      const firstItem = sr.querySelector('.khin-item');
      if (!wrap || !panel || !body || !firstItem) return { missingHost: true };

      // ① 非空前提：这次变更要真的触发过重建（Renderer 会删/重注 ::highlight 样式节点）
      let hlStyleTouched = 0;
      const headObs = new MutationObserver((recs) => {
        for (const rec of recs) {
          for (const n of rec.removedNodes) if (n.nodeType === 1 && n.matches && n.matches('style[data-kh-hl-style]')) hlStyleTouched++;
          for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches && n.matches('style[data-kh-hl-style]')) hlStyleTouched++;
        }
      });
      headObs.observe(document.head, { childList: true });

      // ② 面板被隐藏 / 内容被清空重建
      let hiddenFlips = 0, bodyChildMutations = 0;
      const shadowObs = new MutationObserver((recs) => {
        for (const rec of recs) {
          if (rec.type === 'attributes' && rec.attributeName === 'hidden' && rec.target === wrap) hiddenFlips++;
          if (rec.type === 'childList' && rec.target === body) bodyChildMutations++;
        }
      });
      shadowObs.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

      // ③ 入场动画重播（人眼看到的那一下"闪"）
      const t0 = performance.now();
      let minOpacity = 1, inDip = false, dipEvents = 0;
      const loop = () => {
        const o = Number(getComputedStyle(panel).opacity);
        if (o < minOpacity) minOpacity = o;
        if (o < 0.999) { if (!inDip) { dipEvents++; inDip = true; } } else inDip = false;
        if (performance.now() - t0 < 900) requestAnimationFrame(loop);
      };
      const countRanges = () => {
        let n = 0;
        try { if (CSS && CSS.highlights) CSS.highlights.forEach((hl) => { for (const _ of hl) n++; }); } catch (e) { n = -1; }
        return n;
      };
      const hlBefore = countRanges();
      document.getElementById('tail').appendChild(document.createTextNode(' x'));   // 与笔记内容无关的页面变更
      requestAnimationFrame(loop);
      await new Promise((res) => setTimeout(res, 950));
      headObs.disconnect(); shadowObs.disconnect();
      return {
        hlStyleTouched, hiddenFlips, bodyChildMutations, dipEvents, minOpacity,
        itemNodeReused: firstItem === sr.querySelector('.khin-item'),
        hlBefore, hlAfter: countRanges(), pageTextChanged: document.getElementById('tail').textContent.slice(-2) === ' x'
      };
    });
    console.log('        面板重建观测: ' + JSON.stringify(r));
    truthy(!r.missingHost, '面板结构应齐全（.khin-wrap / .khin-panel / .khin-body / .khin-item）');
    /* 【前置口径已改】旧版要求"style 节点被删/重注过"来证明真的重建过 —— 那正是本版要消灭的
     * 抖动：2.0.8.9 起重建按内容签名幂等，样式节点一动不动。所以前置改成两条更强的：
     * 页面确实变了（变更真实发生）＋ 高亮仍然在（重建/幂等路径没把视觉丢掉）。 */
    truthy(r.pageTextChanged, '前置：这次变更是真的发生了（#tail 末尾多了 " x"）');
    truthy(r.hlBefore > 0 && r.hlAfter > 0, '前置：变更前后高亮都应在（不许为了"不闪"把视觉丢掉），实际 ' + r.hlBefore + ' → ' + r.hlAfter);
    eq(r.hlStyleTouched, 0, '重建不许重注 ::highlight 样式节点（那是刷新的底层来源，2.0.8.9 起应当为 0）');
    eq(r.hiddenFlips, 0, '重建期间面板不许被隐藏（.khin-wrap[hidden] → display:none）');
    eq(r.bodyChildMutations, 0, '内容没变就不许清空重建 .khin-body');
    truthy(r.itemNodeReused, '内容没变时条目 DOM 节点必须复用');
    eq(r.dipEvents, 0, '面板不许重播入场动画（修复前实测 opacity 掉到 0）');
    eq(r.minOpacity, 1, '面板不透明度全程应为 1，实际最小 ' + r.minOpacity);
  });

  await test('★ 表格宽度按内容收缩（不再无条件撑满面板宽度）', async () => {
    /* 用户实测："重要笔记展示时，表格总宽度总是等于重要笔记宽度。这不符合观看习惯，
     * 改成最适合的宽度，避免明明就一列，结果宽度上还是填满了重要笔记。"
     * 实现：`.kh-table { width: auto; max-width: 100% }`（内容短就窄；内容长仍撑满后换行、不溢出）。
     * 这里用「包名」那张**内容很短**的仅抓取表来量；所有表都只要求"不溢出容器"。 */
    await fresh('list.html');
    const r = await page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      if (!host || !host.shadowRoot) return null;
      const box = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width) }; };
      const out = [];
      for (const t of host.shadowRoot.querySelectorAll('table.kh-table')) {
        const holder = t.closest('.khin-item-body') || t.parentElement;
        out.push({
          text: (t.innerText || '').replace(/\s+/g, ' ').slice(0, 30),
          src: t.classList.contains('kh-table-fetch') ? 'fetch' : 'md',
          t: box(t), holder: box(holder)
        });
      }
      return { panelW: Math.round(host.shadowRoot.querySelector('.khin-panel').getBoundingClientRect().width), tables: out };
    });
    truthy(r && r.tables.length, '页面应有抓取表格');
    console.log('        面板宽 ' + r.panelW + ' · ' + JSON.stringify(r.tables.map((x) => x.src + ':' + x.t.w + '/容器' + x.holder.w)));
    for (const x of r.tables) {
      truthy(x.t.w <= x.holder.w + 1, '表格不得超过内容容器宽度（不许溢出）：' + JSON.stringify(x));
    }
    const short = r.tables.filter((x) => /包名/.test(x.text))[0];
    truthy(short, '应能找到内容很短的「包名」抓取表，实际 ' + JSON.stringify(r.tables.map((x) => x.text)));
    truthy(short.t.w < short.holder.w - 8,
      '内容短的表必须**按内容收缩**，不该总等于面板宽度（用户实测要求）：表=' + short.t.w + ' 容器=' + short.holder.w);
    await shot(page, '22-table-shrink');
  });

  await test('★ 默认宽度不遮挡标题列（360px → 200px → 2.0.1.15 起 250px；期望值取自真源，不写死）', async () => {
    /* 用户实测需求："重要笔记悬浮窗的默认宽度减少（现在会遮挡太多标题列内容）"，
     * 二次收窄："重要笔记默认宽度再缩小一点（200px）"——**这条 200px 口径已作废**
     * （SPEC.md:228 显式作废 200px 回归口径，与本轮需求 2「默认 250px、可调 160–600」冲突）。
     * 现行真源：`config.js` 的面板宽度常量 + `important-note.js` 里的 `--khin-panel-w: 250px`。
     * 期望值由文件顶部 require 进来的 `KHConfig.PANEL_WIDTH_DEFAULT` **现取**（不写死数字，
     * 真源改了这里自动跟上）；这条断言在**真实浏览器 + 默认 1280 视口**下量，
     * 顺便量出正文一行能排多少汉字（这个数字才是"少遮挡"对阅读的实际收益）。 */
    const PANEL_W_DEFAULT = KHConfig.PANEL_WIDTH_DEFAULT;
    await fresh('list.html');
    const r = await page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      if (!host || !host.shadowRoot) return null;
      const p = host.shadowRoot.querySelector('.khin-panel');
      if (!p) return null;
      const pr = p.getBoundingClientRect();
      const note = host.shadowRoot.querySelector('.khin-item-note');
      let chars = null;
      if (note && note.clientWidth) {
        const cs = getComputedStyle(note);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const cv = document.createElement('canvas').getContext('2d');
        cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const cw = cv.measureText('中').width;
        if (cw > 0) chars = Math.floor((note.clientWidth - pad) / cw);
      }
      return { panelW: Math.round(pr.width), panelH: Math.round(pr.height), vw: window.innerWidth, chars };
    });
    truthy(r, '面板结构应存在（.khin-panel）');
    console.log('        面板默认宽 ' + r.panelW + 'px @视口' + r.vw +
      '（相对最初 360px：少遮 ' + (360 - r.panelW) + 'px；相对 2.0.1.15 的 200px：反而宽 ' + (r.panelW - 200) + 'px'
      + ' —— 250px 不是在这条曲线上继续收窄，是 SPEC.md:228 作废 200px 后的定向回宽）' +
      ' · 正文一行约 ' + r.chars + ' 个汉字' +
      ' · 真源 PANEL_WIDTH_DEFAULT=' + PANEL_W_DEFAULT + 'px');
    /* box-sizing: border-box ⇒ rect.width 应恰为真源那个值；留 ±10px 容差 —— 理由与原来一致：
     * deviceScaleFactor / 取整 / 视口缩放会把门禁变脆（不是为了放过偏差）。 */
    truthy(Math.abs(r.panelW - PANEL_W_DEFAULT) <= 10,
      '面板默认宽度必须等于真源 PANEL_WIDTH_DEFAULT=' + PANEL_W_DEFAULT + 'px（config.js 的 PANEL_WIDTH_DEFAULT；旧版 360px 遮挡标题列，'
      + '200px 口径已由 SPEC.md:228 作废 ⇒ 现 250px），实际 ' + r.panelW + 'px @视口' + r.vw);
    truthy(r.panelW >= KHConfig.PANEL_WIDTH_MIN && r.panelW <= KHConfig.PANEL_WIDTH_MAX,
      '面板默认宽度必须落在真源区间 [' + KHConfig.PANEL_WIDTH_MIN + ', ' + KHConfig.PANEL_WIDTH_MAX + ']'
      + '（config.js 的 PANEL_WIDTH_MIN/MAX，可调 160–600），实际 ' + r.panelW);
    await shot(page, '23-panel-width');
  });

  await test('★ 笔记区可收起（用户 2026-10-11：图片分区与笔记都很长时互相抢占 → 两边都能收）', async () => {
    /* 用户原话："重要笔记也需要支持收起，避免图片命中和重要笔记内容都很长，导致互相挤压抢占
     * （改了之后可以收起一方，展开另一方）"。这条在真机上点一次、量一次几何 ——
     * 只看源码串会漏掉"类名挂上了但 CSS 没生效"这一类假绿。 */
    await fresh('list.html');
    const readBar = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      if (!sr) return null;
      const bar = sr.querySelector('.khin-notebar');
      const body = sr.querySelector('.khin-body');
      return {
        barShown: !!bar && !bar.hidden && bar.getBoundingClientRect().height > 0,
        arrow: bar ? ((bar.querySelector('.khin-notearrow') || {}).textContent || '') : '',
        bodyVisible: !!body && body.getBoundingClientRect().height > 0
      };
    });
    const clickBar = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.khin-notebar');
      if (!bar) return false;
      bar.click();
      return true;
    });

    const before = await readBar();
    truthy(before && before.barShown, '有笔记卡时笔记区题头必须出现（收起入口就在这），实际 ' + JSON.stringify(before));
    truthy(before.bodyVisible, '初始状态正文可见，实际 ' + JSON.stringify(before));
    truthy(await clickBar(), '笔记区题头要能点到');
    const collapsed = await readBar();
    truthy(collapsed.bodyVisible === false, '★ 点一下 ⇒ 正文整块收起（空间让给图片分区），实际 ' + JSON.stringify(collapsed));
    includes(collapsed.arrow, '展开', '收起后箭头要写「展开」（不然用户不知道再点一下能回来）');
    truthy(await clickBar(), '再点一下要能展开');
    const back = await readBar();
    truthy(back.bodyVisible === true, '★ 再点一下 ⇒ 正文回来，实际 ' + JSON.stringify(back));
    includes(back.arrow, '收起', '展开后箭头要写「收起」');
  });

  group('6. 备注卡片与悬停 tooltip', { aspects: ['interact'] });

  /* 面板默认贴左上角（v1.52.0 口径），会盖住装置页第一行命中词 —— 那些位置点到的是
   * 插件自己的面板（`isOwnUI` → 不弹卡片），与"卡片/悬停能力"无关。
   * 【台账 #2】收起只剩一条路径：点头部「收起」→ 面板换成一颗 FAB，腾出命中点。 */
  const minimizePanel = async () => {
    await page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const b = host && host.shadowRoot && host.shadowRoot.querySelector('[data-act="collapse"]');
      if (b) b.click();
    });
    await page.waitForFunction(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      return !!(sr && sr.querySelector('.khin-fab') && !sr.querySelector('.khin-panel'));
    }, null, { timeout: 3000 });
  };

  await test('★ 点击高亮词弹出备注卡片（坐标为命中定位）', async () => {
    await fresh('list.html');
    await minimizePanel();
    const pt = await page.evaluate(POINT_OF, ['#tbody tr:nth-child(1) td:nth-child(2)', '审核不通过']);
    truthy(pt, '应能在表格里定位到「审核不通过」（k1 有备注，卡片会显示备注）');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    const card = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      if (!c) return { exists: false };
      const vis = !c.hasAttribute('hidden') && getComputedStyle(c).display !== 'none';
      const sr = c.shadowRoot;
      const bodyEl = sr && sr.querySelector('.kh-note-body');
      return { exists: true, vis, body: bodyEl ? bodyEl.textContent : '', shadow: !!sr };
    });
    truthy(card.exists, '应存在 #kh-note-card（点击后按需创建）');
    truthy(card.vis, '点击命中后卡片应显示');
    includes(card.body, '备注', '卡片正文应是该词的备注内容，实际：' + card.body);
    await shot(page, '03-note-card');
  });

  await test('卡片关闭按钮可关闭', async () => {
    // 卡片是 Shadow DOM：必须进 shadowRoot 找按钮；用 evaluate 触发（等价于用户点击该按钮）
    const r = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      if (!c || !c.shadowRoot) return { err: 'no shadowRoot' };
      const sr = c.shadowRoot;
      const btn = sr.querySelector('.kh-note-close-btn') ||
        Array.from(sr.querySelectorAll('button')).find(b => /关闭|✕|×/.test(b.getAttribute('title') || b.textContent || ''));
      if (!btn) return { err: 'no close button', html: sr.innerHTML.slice(0, 400) };
      btn.click();
      return { clicked: true };
    });
    truthy(!r.err, '卡片应有关闭按钮：' + JSON.stringify(r));
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      if (!c) return true;
      const box = c.shadowRoot && c.shadowRoot.querySelector('.kh-note-card');
      const style = box ? getComputedStyle(box) : getComputedStyle(c);
      return c.hasAttribute('hidden') || style.display === 'none' || getComputedStyle(c).display === 'none';
    });
    truthy(hidden, '点关闭后卡片应隐藏');
  });

  await test('★ 悬停命中 → 浮动 tooltip 出现（非原生 title）', async () => {
    await minimizePanel();     // 同上：腾出被面板盖住的命中点
    const pt = await page.evaluate(POINT_OF, ['#tbody tr:nth-child(1) td:nth-child(2)', '审核不通过']);
    truthy(pt, '应能定位到命中词');
    /* 悬停有 debounce + 淡入过渡：原先固定等 500ms，机器忙时会假红（实测抖动过一次）。
     * 改成**轮询到位**（最多 ~2.4s）：断言仍然严格（必须真的可见），只是不再对时序敏感。 */
    const read = () => page.evaluate(() => {
      const t = document.getElementById('kh-note-tooltip');
      if (!t) return { exists: false };
      const box = t.shadowRoot ? (t.shadowRoot.querySelector('.kh-tip') || t) : t;
      const cs = getComputedStyle(box);
      return {
        exists: true,
        vis: !t.hasAttribute('hidden') && cs.display !== 'none' && Number(cs.opacity) > 0.3,
        opacity: cs.opacity, display: cs.display,
        text: (box.innerText || box.textContent || '')
      };
    });
    let tip = { exists: false };
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(pt.x - 40, pt.y - 40);
      await page.mouse.move(pt.x, pt.y, { steps: 5 });
      await page.waitForTimeout(120);
      tip = await read();
      if (tip.exists && tip.vis) break;
    }
    truthy(tip.exists, '应存在 #kh-note-tooltip（内容脚本自制浮动 tooltip，而非原生 title）');
    truthy(tip.vis, '悬停后 tooltip 应可见，实际 ' + JSON.stringify(tip));
    includes(tip.text, '备注', 'tooltip 应显示备注摘要');
    await shot(page, '04-tooltip');
  });

  /* 回归夹具 blank-hover.html：命中词下方有数百像素的**无文本区域**。
   * 空白处 caret 两条 API 都返回 null → 落到几何回退；旧实现把"最近命中"无条件返回，
   * 于是几百像素外的高亮被当成本地命中 → 备注 tooltip 在空白处弹出（用户实测缺陷）。 */
  await test('★ 空白区域悬停不得弹出别处命中的备注（几何回退必须有距离上限）', async () => {
    await fresh('blank-hover.html');
    const box = await page.evaluate(() => {
      const r = document.getElementById('blank-area').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.75), y: Math.round(r.top + 180) };
    });
    const readTip = () => page.evaluate(() => {
      const t = document.getElementById('kh-note-tooltip');
      if (!t) return { exists: false, vis: false };
      const b = t.shadowRoot ? (t.shadowRoot.querySelector('.kh-tip') || t) : t;
      const cs = getComputedStyle(b);
      return {
        exists: true,
        vis: !t.hasAttribute('hidden') && cs.display !== 'none' && Number(cs.opacity) > 0.3,
        text: (b.innerText || b.textContent || '')
      };
    });
    /* 多停几轮：tooltip 有 60ms 节流 + 淡入过渡，要留够"若误判则已经弹出来"的时间 */
    let tip = { exists: false, vis: false };
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x - 30, box.y - 30);
      await page.mouse.move(box.x, box.y, { steps: 4 });
      await page.waitForTimeout(220);
      tip = await readTip();
      if (tip.vis) break;
    }
    falsy(tip.vis, '空白处悬停不该显示备注 tooltip（说明把远处命中当成了本地命中），实际 ' + JSON.stringify(tip));
    await shot(page, '14-blank-hover-no-tooltip');
  });

  await test('★ 重要笔记默认是悬窗（2.0.8.9 需求②；旧的「默认贴边条」口径已作废）', async () => {
    await fresh('list.html');
    const r = await page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      const p = sr && sr.querySelector('.khin-panel');
      if (!p) return null;
      const b = p.getBoundingClientRect();
      return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width),
        rail: !!(sr && sr.querySelector('.khin-rail')), items: sr.querySelectorAll('.khin-item').length };
    });
    truthy(r, '应有重要笔记悬窗（配置里 k1/k3 带重要笔记）');
    falsy(r.rail, '贴边条已删，默认与备选都不该出现，实际 ' + JSON.stringify(r));
    truthy(r.left < 100 && r.top < 100, '悬窗停左上角，实际 ' + JSON.stringify(r));
    truthy(r.items > 0, '默认悬窗应直接给全条目，实际 ' + JSON.stringify(r));
  });

  await test('★ 拖动面板到浏览器边界后松开，不得冒出备注卡片（坐标判据的补发 click）', async () => {
    await fresh('list.html');
    const pt = await page.evaluate(POINT_OF, ['#tbody tr:nth-child(1) td:nth-child(2)', '审核不通过']);
    truthy(pt, '应能定位到命中词');

    // 从面板标题栏按下 → 拖到视口右边界 → 松开
    const handle = await page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host.shadowRoot;
      const h = sr.querySelector('.khin-header') || sr.querySelector('.khin-fab');
      const b = h.getBoundingClientRect();
      return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    for (let x = handle.x; x <= 995; x += 60) await page.mouse.move(x, pt.y);
    await page.mouse.move(995, pt.y);
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(600);

    // 浏览器在此会把 click 派发到 pointerdown(面板) 与 pointerup(页面) 的**共同祖先**上，
    // 坐标却是松手处 —— 坐标判据若不校验"按下点是否在页面内容上"，就会误判成命中点击。
    const card = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      const box = c && c.shadowRoot && c.shadowRoot.querySelector('.kh-note-card');
      return { exists: !!c, hidden: box ? box.hidden : true, text: box ? (box.textContent || '').trim().slice(0, 20) : '' };
    });
    truthy(card.hidden !== false, '拖到边界松开后不该冒出备注卡片，实际显示了：' + JSON.stringify(card));
    await shot(page, '05-drag-no-card');

    // 回归：正常点击命中**仍应**弹卡片（守卫不能把合法路径也堵掉）
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      const box = c && c.shadowRoot && c.shadowRoot.querySelector('.kh-note-card');
      return { hidden: box ? box.hidden : true, text: box ? (box.textContent || '').trim().slice(0, 20) : '' };
    });
    truthy(after.hidden === false, '正常点击命中仍应弹出卡片（守卫误伤），实际 ' + JSON.stringify(after));
  });

  /* ---------------------------------------------------------- 7. 保留原网页文字色 */
  group('7. 默认文字色不得覆盖网页自身的文字色', { aspects: ['visual'] });

  /** 命中落在哪个高亮组（按 Range 的父元素归属判断）—— 直接验端到端行为，而不是只看 CSS 文本 */
  const GROUPS_OF = (sel) => {
    const host = document.querySelector(sel);
    if (!host) return { found: false };
    const names = [];
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.forEach((hl, name) => {
        for (const r of hl) {
          const n = r.startContainer;
          const el = n && (n.nodeType === 1 ? n : n.parentElement);
          if (el && host.contains(el)) { names.push(name); break; }
        }
      });
    }
    return { found: true, names };
  };

  await test('★ 网页原本标红的字，命中后仍是红的（默认文字色不强制覆盖）', async () => {
    await fresh('list.html');
    const red = await page.evaluate(GROUPS_OF, ['#redline']);
    const white = await page.evaluate(GROUPS_OF, ['#whiteline']);
    console.log('        #redline 落在: ' + JSON.stringify(red.names) + '；#whiteline 落在: ' + JSON.stringify(white.names));
    truthy(red.found && red.names.length, '红字那一行应被命中');
    truthy(red.names.every((n) => /-auto$/.test(n)),
      '红字应落在"保留原网页文字色"的档（-auto），实际 ' + JSON.stringify(red.names));
    /* 白字叠橙底：亮度对比度只有 2.2（按 WCAG 会被判"不达标"），但 ΔE≈88 —— 颜色分得开、看得清，
     * 所以按设计**保留**。这条断言就是用来钉住"判据是色差而不是亮度对比度"这个决定的。 */
    truthy(white.names.length && white.names.every((n) => /-auto$/.test(n)),
      '白字叠橙底（ΔE 大、分得开）也应保留原色，实际 ' + JSON.stringify(white.names));
    // 该档的规则里不许出现 color，否则又会把红字刷成黑字
    const css = await page.evaluate(() => Array.from(document.querySelectorAll('style[data-kh-hl-style]'))
      .map((s) => s.textContent || '').filter((t) => /-auto\)/.test(t)).join('\n'));
    console.log('        -auto 规则: ' + JSON.stringify(css));
    truthy(css.length > 0, '应存在 -auto 档的 ::highlight 规则');
    // 注意：断言"没有 color"必须写成 [;{]color，否则会被 background-color: 命中（自己踩过）
    falsy(/[;{]\s*color\s*:/i.test(css), '"保留原色"的规则里不许出现 color（background-color 不算）：' + css);
    // 用户明确要求：**底色维持现状**，即便原网页有底色也照样覆盖 —— 所以 -auto 档必须仍有 background-color
    truthy(/background-color\s*:\s*#ff9500/i.test(css), '-auto 档仍必须设置 background-color（底色照旧覆盖）：' + css);
    await shot(page, '06-keep-page-color');
  });

  await test('★ 原色与底色分不开时必须兜底（否则文字看不见）', async () => {
    await fresh('list.html');
    const same = await page.evaluate(GROUPS_OF, ['#invisline']);
    const near = await page.evaluate(GROUPS_OF, ['#nearline']);
    console.log('        同色橙字 落在: ' + JSON.stringify(same.names) + '；近似橙字 落在: ' + JSON.stringify(near.names));
    truthy(same.found && same.names.length, '橙字那一行应被命中');
    truthy(same.names.every((n) => /-fix$/.test(n)),
      '同色叠色（橙字叠橙底，ΔE≈0）必须走兜底档（-fix），实际 ' + JSON.stringify(same.names));
    truthy(near.found && near.names.length, '近似橙那一行应被命中');
    truthy(near.names.every((n) => /-fix$/.test(n)),
      '近似橙（ΔE≈12）也必须走兜底档（-fix），实际 ' + JSON.stringify(near.names));
    // 兜底规则必须写明一个看得清的颜色
    const css = await page.evaluate(() => Array.from(document.querySelectorAll('style[data-kh-hl-style]'))
      .map((s) => s.textContent || '').filter((t) => /-fix\)/.test(t)).join('\n'));
    console.log('        -fix 规则: ' + JSON.stringify(css));
    truthy(/[;{]\s*color\s*:/i.test(css), '兜底档必须写明 color：' + css);
    falsy(/[;{]\s*color\s*:\s*#ff9500/i.test(css), '兜底色不能还是那个看不见的原色：' + css);
    falsy(/[;{]\s*color\s*:\s*#ffa733/i.test(css), '兜底色不能还是那个分不开的近似色：' + css);
  });

  /* ---------------------------------------------------------- 8. 被拆开的词 / 全词边界 */
  group('8. 跨文本节点：命中范围与全词边界', { aspects: ['hit'] });

  /** 往装置页注入纯文本结构，等一轮重建后数命中数 */
  const HITS_IN = async (html, n) => {
    await page.evaluate((h) => {
      const box = document.createElement('div');
      box.id = 'split-probe';
      box.innerHTML = h;
      document.body.appendChild(box);
    }, html);
    await page.waitForTimeout(1200);
    return page.evaluate((count) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const host = document.getElementById('c' + i);
        let hit = 0;
        if (host && typeof CSS !== 'undefined' && CSS.highlights) {
          CSS.highlights.forEach((hl) => {
            for (const rg of hl) {
              const x = rg.startContainer;
              const el = x && (x.nodeType === 1 ? x : x.parentElement);
              if (el && host.contains(el)) { hit++; break; }
            }
          });
        }
        out.push(hit);
      }
      return out;
    }, n);
  };

  await test('★ 跨节点命中：被元素拆开的词也能命中（各段保留自己的颜色 + 第二段可点开备注）', async () => {
    await fresh('list.html');
    // 装置页的 k1 = 审核不通过（普通词，带备注）
    const hits = await HITS_IN([
      '<p id="c0">审核<span style="color:#e53935">不通过</span></p>',
      '<p id="c1">审<span>核</span>不通过</p>',
      '<p id="c2"><span style="color:#e53935">审核不通过</span></p>',
      '<p id="c3">审核不通过</p>'
    ].join(''), 4);
    console.log('        跨节点命中: 拆成两段=' + hits[0] + ' 拆成三段=' + hits[1] +
      ' 整段同色(单节点)=' + hits[2] + ' 普通=' + hits[3]);
    eq(hits[0], 1, '审核<span>不通过</span>（被元素拆开）**应命中**');
    eq(hits[1], 1, '审<span>核</span>不通过（拆成三段）**应命中**');
    eq(hits[2], 1, '整段同色（单节点）应命中');
    eq(hits[3], 1, '普通（单节点）应命中');

    // ① 只登记**一条**命中（跨节点探针只产出真正跨节点的，单节点交给 node-regex，不得重复）
    const range = await page.evaluate(() => {
      const host = document.getElementById('c0');
      const found = [];
      CSS.highlights.forEach((hl, name) => {
        for (const rg of hl) {
          const x = rg.startContainer;
          const el = x && (x.nodeType === 1 ? x : x.parentElement);
          if (el && host.contains(el)) found.push({ name: name, cross: rg.startContainer !== rg.endContainer, text: rg.toString() });
        }
      });
      return found;
    });
    console.log('        c0 的 Range: ' + JSON.stringify(range));
    eq(range.length, 1, '同一条命中只能有一个 Range（跨节点探针不得与 node-regex 重复产出），实际 ' + JSON.stringify(range));
    eq(range[0].cross, true, '该 Range 应**跨节点**（整词上色），实际 ' + JSON.stringify(range[0]));
    eq(range[0].text, '审核不通过', 'Range 覆盖的文本应是整个关键词，实际 ' + JSON.stringify(range[0].text));

    // ② 点在**第二段**（红色那半）上也要能弹备注：注册表必须按每一段建索引
    const pt = await page.evaluate(() => {
      const sp = document.querySelector('#c0 span');
      if (!sp) return null;
      const r = sp.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    truthy(pt, '应能取到第二段的坐标');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(500);
    const card = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      const box = c && c.shadowRoot && c.shadowRoot.querySelector('.kh-note-card');
      return { hidden: box ? box.hidden : true, text: box ? (box.textContent || '').trim().slice(0, 24) : '' };
    });
    console.log('        点第二段（红色部分）: ' + JSON.stringify(card));
    falsy(card.hidden, '点在跨节点命中的**第二段**上应能弹出备注卡片（按段建索引），实际 ' + JSON.stringify(card));
    includes(card.text, '审核不通过', '卡片应对应这个词');
    await shot(page, '07-cross-node');
  });

  /* ------------------- 8b. 组合词跨文本节点（必须与普通词同一套"视觉连续"口径） */
  group('8b. 组合词的核心/标题被拆成多个文本节点', { aspects: ['hit'] });

  await test('★ 组合词核心被 <span> 拆开也要命中（左右格 + 上下格），块级隔开则不命中', async () => {
    await fresh('combo-xnode.html');
    /* 某个格子里涉及的高亮 Range（含跨节点整词的起止两段） */
    const RANGES_IN = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      let n;
      while ((n = w.nextNode())) nodes.push(n);
      const out = [];
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.forEach((hl, name) => {
          for (const r of hl) {
            if (nodes.indexOf(r.startContainer) < 0) continue;
            out.push({
              name: name,
              text: r.toString(),
              cross: r.startContainer !== r.endContainer,
              head: (r.startContainer.nodeValue || '').slice(r.startOffset, r.endOffset),
              tail: (r.endContainer.nodeValue || '').slice(0, r.endOffset)
            });
          }
        });
      }
      return { text: el.textContent, ranges: out };
    }, sel);

    /* ① 核心词跨节点（用户实测缺陷：修前这里 0 条） */
    const core = await RANGES_IN('#lr-core');
    truthy(core, '装置页应有 #lr-core');
    console.log('        ① 核心跨节点: ' + JSON.stringify(core));
    eq(core.ranges.length, 1, '① 核心词被拆开**应命中**且**只有一条**（不得与逐节点路径重复计数）');
    eq(core.ranges[0].cross, true, '① Range 应真的跨两个文本节点（用户看到的是整词上色）');
    eq(core.ranges[0].text, '来遇见你', '① Range 应覆盖整个核心词（不是半截）');
    eq(core.ranges[0].head, '来遇', '① 第一段应是「来遇」');
    eq(core.ranges[0].tail, '见你', '① 第二段应是「见你」');

    /* ② 标题词自己被拆开：核心是单节点，同样要命中 */
    const lbl = await RANGES_IN('#lbl-core');
    console.log('        ② 标题被拆开: ' + JSON.stringify(lbl));
    eq(lbl.ranges.length, 1, '② 标题词被拆开时核心**仍应命中**（标题侧也要按格内连续文本判定）');
    eq(lbl.ranges[0].text, '来遇见你', '② Range 应是核心词本身');

    /* ③ 上下格（tb 轴）同样覆盖 */
    const tb = await RANGES_IN('#tb-core');
    console.log('        ③ 上下格核心跨节点: ' + JSON.stringify(tb));
    eq(tb.ranges.length, 1, '③ 上下格：核心词被拆开也应命中（两个轴同一口径）');
    eq(tb.ranges[0].cross, true, '③ Range 应跨两个文本节点');
    eq(tb.ranges[0].text, '是的哦', '③ Range 应覆盖整个核心词');

    /* ④ 反例：被块级元素隔开的两段不得拼成一个词（否则是过度命中） */
    const blk = await RANGES_IN('#blk-core');
    console.log('        ④ 块级隔开（应 0 条）: ' + JSON.stringify(blk));
    eq(blk.ranges.length, 0, '④ 「<div>来遇</div><div>见你</div>」块级隔开 → **不该**拼成一个词');

    /* ⑤ 点在**第二段**上也要能弹卡片：registry 必须按每一段建索引 */
    await minimizePanel();          // 面板贴左上角会挡住装置页，先收起（用户的常规操作）
    const pt = await page.evaluate(() => {
      const sp = document.getElementById('lr-span');
      if (!sp) return null;
      const r = sp.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    truthy(pt, '应能取到核心词第一段的坐标');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(500);
    const card = await page.evaluate(() => {
      const c = document.getElementById('kh-note-card');
      const box = c && c.shadowRoot && c.shadowRoot.querySelector('.kh-note-card');
      return { hidden: box ? box.hidden : true, text: box ? (box.textContent || '').trim().slice(0, 40) : '' };
    });
    console.log('        ⑤ 点拆开的核心词: ' + JSON.stringify(card));
    falsy(card.hidden, '点跨节点组合词命中的那一段也应弹出备注卡片（按段建索引）');
    includes(card.text, '跨节点组合词备注', '卡片文案应对应 k8');
    await shot(page, '19-combo-xnode');
  });

  await test('★ 真浏览器对照：**同一个词**，普通规则与组合规则命中同一处（只差"定位"）', async () => {
    /* 用户口径："组合词只是在核心词上加一个定位的限制…不要反复出现普通词能实现、组合词不行的问题"。
     *
     * 为什么不能"两条规则同时开着一比"：同一个词的两条规则会命中**同一段文本**，
     * 裁决层（arbiter）本来就只渲染优先级更高的那一个（否则就是重复高亮，是另一个 bug）。
     * 所以这里改成**同一个装置跑两次、只换规则类型**，再逐字比对两次的命中集合：
     *   第一次只开组合词 k8 → 记下每个格子的命中（文本 / 是否跨节点）；
     *   第二次只开一条**普通**关键词（文本与 k8 核心词相同）→ 再记一次；
     *   两次必须完全相同；且第一次的命中必须**非空**（否则"一致"只是两边都空）。 */
    const SELS = ['#lr-core', '#lbl-core', '#blk-core'];
    const PARITY_KW = {
      id: 'kPlainParity', text: '来遇见你', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: ''
    };
    const readAll = (sels) => page.evaluate((list) => {
      const out = {};
      for (const sel of list) {
        const el = document.querySelector(sel);
        const nodes = [];
        if (el) {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
          let n;
          while ((n = w.nextNode())) nodes.push(n);
        }
        const got = [];
        CSS.highlights.forEach((hl) => {
          try {
            for (const r of hl) {
              if (nodes.indexOf(r.startContainer) < 0) continue;
              got.push({ text: r.toString(), cross: r.startContainer !== r.endContainer });
            }
          } catch (e) { /* ignore */ }
        });
        got.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
        out[sel] = got;
      }
      return out;
    }, sels);
    const onlyCombo = CONFIG.keywords.map((k) => (k.id === 'k8' ? k : Object.assign({}, k, { enabled: false })));
    const onlyPlain = CONFIG.keywords.map((k) => Object.assign({}, k, { enabled: false })).concat([PARITY_KW]);

    try {
      await api.setConfig(Object.assign({}, CONFIG, { keywords: onlyCombo }));
      await fresh('combo-xnode.html');
      const combo = await readAll(SELS);
      await api.setConfig(Object.assign({}, CONFIG, { keywords: onlyPlain }));
      await fresh('combo-xnode.html');
      const plain = await readAll(SELS);
      console.log('        组合规则: ' + JSON.stringify(combo));
      console.log('        普通规则: ' + JSON.stringify(plain));
      truthy(combo['#lr-core'].length > 0, '组合规则在 ① 应命中（否则"一致"没意义）');
      eq(JSON.stringify(combo), JSON.stringify(plain),
        '同一个词在同样的结构上，普通规则与组合规则必须命中**完全相同**的位置（只差定位范围）');
      eq(combo['#lr-core'].length, 1, '① 只应有一条命中（不得重复计数）');
      eq(combo['#lr-core'][0].text, '来遇见你', '① 命中应是整词');
      eq(combo['#lr-core'][0].cross, true, '① 命中应跨两个文本节点');
      eq(combo['#blk-core'].length, 0, '④ 块级隔开两边都不该命中（过度命中也不能有）');
    } finally {
      await api.setConfig(CONFIG);              // 还原共享配置，别影响后面的用例
      await fresh('combo-xnode.html');
    }
  });

  /* ------------------- 8c. 跨节点命中的重叠裁决（起点在不同节点也要判冲突） */
  group('8c. 跨节点命中的重叠裁决', { aspects: ['hit'] });

  await test('★ 两条跨节点命中视觉重叠（起点不同节点）→ 只渲染一条，长匹配优先', async () => {
    /* 用户拍板要修的那条：`arbiter.overlaps()` 原先只比"起始节点 + 区间"，
     * 而跨节点命中的 node 只是第一段 → 起点不同就判不出重叠 → 同一段文字被两个高亮组叠着涂。
     * 装置 `fixtures/xnode-overlap.html`：`审<span>核</span>不通过`
     *   「审核不」起点在 span 前的文本节点；「核不」起点在 span 内 → 两者在「核」「不」上重叠。 */
    const KWS = [
      { id: 'kOvLong', text: '审核不' },
      { id: 'kOvShort', text: '核不' }
    ].map((k) => Object.assign({
      note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: ''
    }, k));
    try {
      await api.setConfig(Object.assign({}, CONFIG, { keywords: KWS }));
      await fresh('xnode-overlap.html');
      const ranges = await page.evaluate(() => {
        const el = document.querySelector('#ov');
        const nodes = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = w.nextNode())) nodes.push(n);
        const out = [];
        CSS.highlights.forEach((hl, name) => {
          for (const r of hl) {
            if (nodes.indexOf(r.startContainer) < 0) continue;
            out.push({ name: name, text: r.toString(), cross: r.startContainer !== r.endContainer });
          }
        });
        return out;
      });
      console.log('        #ov 上的命中: ' + JSON.stringify(ranges));
      eq(ranges.length, 1, '视觉重叠的两条跨节点命中只应渲染**一条**（旧实现渲染两条 → 叠加涂色），实际 ' + JSON.stringify(ranges));
      eq(ranges[0].text, '审核不', '按"长匹配优先"胜出的应是更长的「审核不」');
      eq(ranges[0].cross, true, '这条命中本身仍是跨文本节点的');
      await shot(page, '21-xnode-overlap');
    } finally {
      await api.setConfig(CONFIG);          // 还原共享配置
    }
  });

  /* --------------------- 8d. 隐藏内容不参与命中（用户实测） */
  group('8d. 隐藏容器里的词不该命中', { aspects: ['hit'] });

  await test('★ display:none（含祖先）/ visibility:hidden / hidden 里的词都不命中；visible 后代照旧命中', async () => {
    /* 用户实测："命中了一个词，但当前页面没有，怀疑是把原网页隐藏的容器里内容命中了。
     * 这不对。至少要这个容器外显了才命中啊。" */
    await fresh('hidden-hit.html');
    const count = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return -1;
      const nodes = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = w.nextNode())) nodes.push(n);
      let hits = 0;
      CSS.highlights.forEach((hl) => {
        try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) { hits++; break; } } catch (e) { /* ignore */ }
      });
      return hits;
    }, sel);
    const r = {
      vis: await count('#vis'),
      hid: await count('#hid'),
      nested: await count('#hid-nested'),
      hidVis: await count('#hid-vis'),
      hidAttr: await count('#hid-attr'),
      reVisible: await count('#re-visible')
    };
    console.log('        逐块命中数: ' + JSON.stringify(r));
    eq(r.vis, 1, '可见的那处应命中');
    eq(r.hid, 0, '自己 display:none 的容器里不该命中');
    eq(r.nested, 0, '**祖先** display:none（隔两层）里也不该命中 —— 用户实测遇到的就是这种');
    eq(r.hidVis, 0, 'visibility:hidden 里不该命中');
    eq(r.hidAttr, 0, 'hidden 属性里不该命中');
    /* 保守口径：visibility 隐藏的容器**整块不扫**（与 display:none 一视同仁）——
     * visibility:hidden 祖先里再自己 visible 的写法极罕见，不值得为它放宽成「只跳自己、继续下钻」。 */
    eq(r.reVisible, 0, 'visibility 隐藏的容器整块不扫（保守口径，与 display:none 一致）');
    await shot(page, '24-hidden-hit');
  });

  /* ---------------------------------------------------------- 7b. 上下格：表格结构适应性 */
  group('7b. 上下格匹配：真实表格结构适应性', { aspects: ['hit'] });

  await test('★ 10 种真实表格结构都要能命中（含"标题行 + td 表头"）', async () => {
    /* 来自用户实测："1.52.0 里上下格匹配，无法实现表头和表格内容没有拆分的情况"。
     * 装置页把常见结构全铺一遍（fixtures/tb-structures.html）。
     * 用**临时配置**（标题词=名称、核心词=甲），测完还原，避免污染其它用例。 */
    const opt = await api.extensionPage('options/options.html');
    const saved = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res(r.keywords || []))));
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({
      keywords: [{ id: 'tbx', text: '甲', cellVerify: '名称', cellVerifyEnabled: true, comboAxis: 'tb', enabled: true, groupId: null }]
    }, res)));
    await opt.close();

    const tb = await api.context.newPage();
    try {
      await tb.goto(FIX(origin, 'tb-structures.html'), { waitUntil: 'load' });
      await tb.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
      await tb.waitForTimeout(1500);
      const IDS = ['t1', 't2', 't3', 't4', 't5', 't6body', 't7', 't8', 't9', 't10'];
      const hits = await tb.evaluate((ids) => {
        const out = {};
        for (const id of ids) {
          const host = document.getElementById(id);
          let n = 0;
          if (host && typeof CSS !== 'undefined' && CSS.highlights) {
            CSS.highlights.forEach((hl) => {
              for (const rg of hl) {
                const x = rg.startContainer;
                const el = x && (x.nodeType === 1 ? x : x.parentElement);
                if (el && host.contains(el)) { n++; break; }
              }
            });
          }
          out[id] = n;
        }
        return out;
      }, IDS);
      const NAMES = {
        t1: '标准 thead/th', t2: 'thead 里放 td', t3: '无 thead 首行 th', t4: '无 thead/tbody 首行 td',
        t5: '首行合并标题 + 第二行表头(th)', t6body: '表头表/数据表分开', t7: '假表格 div',
        t8: '首行标题 + td 表头', t9: '多行表头', t10: '表头文字在嵌套 span 里'
      };
      console.log('        上下格命中: ' + IDS.map((id) => id + '=' + hits[id]).join(' '));
      for (const id of IDS) truthy(hits[id] > 0, '结构「' + NAMES[id] + '」应命中，实际 ' + hits[id]);
      await shot(tb, '09-tb-structures');
    } finally {
      await tb.close();
      const opt2 = await api.extensionPage('options/options.html');
      await opt2.evaluate((kw) => new Promise((res) => chrome.storage.local.set({ keywords: kw }, res)), saved);
      await opt2.close();
    }
  });

  /* ---------------------------------------------------------- 7c. 看大图（灯箱） */
  group('7c. 重要笔记图片：当前页看大图', { aspects: ['interact'] });

  await test('★ 点面板里的图片 → 当前页灯箱（不跳新标签页）；点图片不退出、点遮罩/Esc 退出', async () => {
    await fresh('list.html');
    /* 注意：**不要**收起面板 —— 收起后内容被换成小 FAB，图片就不在了（这条要看图）。
     * 面板默认在左上角，会盖住一部分装置页文字，但不影响点它自己的图片。 */
    const before = api.context.pages().length;
    /* 抓取字段里的图片要等一轮"命中 → 抓取 → 渲染面板"，固定等待会假红（实测 400ms 不够）。
     * 与悬停 tooltip 那条一样：**轮询到位**，最多 ~3s。 */
    const readImg = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const el = host && host.shadowRoot && host.shadowRoot.querySelector('img');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), src: el.getAttribute('src') || '' };
    });
    let img = null;
    for (let i = 0; i < 15 && !img; i++) {
      await page.waitForTimeout(200);
      img = await readImg();
    }
    truthy(img, '面板里应有抓取到的图片（装置页 #fetch-img）');
    await page.mouse.click(img.x, img.y);
    await page.waitForTimeout(400);
    const lb = await page.evaluate(() => {
      const h = document.getElementById('kh-note-lightbox');
      const box = h && h.shadowRoot && h.shadowRoot.querySelector('.kh-lb');
      const im = h && h.shadowRoot && h.shadowRoot.querySelector('img');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return {
        hidden: box.hidden, w: Math.round(r.width), h: Math.round(r.height),
        src: im.getAttribute('src') || '', hasOpenBtn: !!h.shadowRoot.querySelector('.kh-lb-open')
      };
    });
    console.log('        灯箱: ' + JSON.stringify(lb));
    truthy(lb, '应创建 #kh-note-lightbox');
    falsy(lb.hidden, '点图片后灯箱应显示');
    truthy(lb.w > 500 && lb.h > 400, '灯箱应铺满视口，实际 ' + lb.w + 'x' + lb.h);
    includes(lb.src, 'pixel.png', '灯箱里应是同一张图');
    truthy(lb.hasOpenBtn, '应保留「在新标签页打开」兜底入口');
    eq(api.context.pages().length, before, '点图片**不该**新开标签页');

    /* v1.99.99.11 用户口径："放大图点击图片就退出大图模式，这不符合预期，点击图片要支持拖动，
     * 点击范围外区域才退出。" → 点图片=拖动/查看（不退出），点遮罩才算关闭。 */
    const lbImg = await page.evaluate(() => {
      const im = document.getElementById('kh-note-lightbox').shadowRoot.querySelector('.kh-lb-img');
      const r = im.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    const lbState = () => page.evaluate(() => {
      const h = document.getElementById('kh-note-lightbox');
      const sr = h.shadowRoot;
      return {
        hidden: sr.querySelector('.kh-lb').hidden,
        tf: sr.querySelector('.kh-lb-img').style.transform,
        navHidden: sr.querySelector('.kh-lb-prev').hidden
      };
    });
    await page.mouse.click(lbImg.x, lbImg.y);
    await page.waitForTimeout(250);
    truthy(!(await lbState()).hidden, '点**图片本身**不该退出大图模式（点图片=拖动/查看）');

    // 拖动图片 → 平移（transform 出现非零 translate），且全程不退出
    await page.mouse.move(lbImg.x, lbImg.y);
    await page.mouse.down();
    await page.mouse.move(lbImg.x + 50, lbImg.y + 30, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const dragged = await lbState();
    console.log('        拖动后: ' + JSON.stringify(dragged));
    truthy(/translate\((-?\d+(\.\d+)?)px, *(-?\d+(\.\d+)?)px\)/.test(dragged.tf),
      '拖动图片后 transform 应带 translate（平移），实际 ' + dragged.tf);
    truthy(!/translate\(0px, *0px\)/.test(dragged.tf), '拖动后位移不该还是 0：' + dragged.tf);
    falsy(dragged.hidden, '拖动过程/之后都不该退出大图模式');

    // 点**容器内**（图片与按钮之间的留白）也不该退出（v1.99.99.12 用户口径："点击容器内都不会退出"）
    const pad = await page.evaluate(() => {
      const st = document.getElementById('kh-note-lightbox').shadowRoot.querySelector('.kh-lb-stage').getBoundingClientRect();
      return { x: Math.round(st.left + 4), y: Math.round(st.top + 4) };
    });
    await page.mouse.click(pad.x, pad.y);
    await page.waitForTimeout(200);
    falsy((await lbState()).hidden, '点容器内的留白也不该退出大图模式（实际 ' + JSON.stringify(pad) + '）');

    // 点图片**以外**的遮罩区域 → 退出
    await page.mouse.click(12, 12);
    await page.waitForTimeout(250);
    truthy((await lbState()).hidden, '点图片以外的遮罩区域才应退出大图模式');

    await page.mouse.click(img.x, img.y);
    await page.waitForTimeout(300);
    eq((await lbState()).navHidden, true, '单张图时左右翻页按钮应**隐藏**（不是可点的假按钮）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    truthy((await lbState()).hidden, 'Esc 应关闭灯箱');
    await shot(page, '08-lightbox');
  });

  /* ------------------------------------------- 7e. 灯箱相册：同单元格才算"一组" */
  group('7c2. 看大图：同单元格才算相册（缩放 / 旋转 / 上一张下一张）', { aspects: ['interact'] });

  await test('★ 同格两张图 → 可翻页（按钮在图片两侧）；异格单张 → 隐藏上下张；缩放/旋转/复位可用', async () => {
    await fresh('lightbox-gallery.html');
    /* 抓取重建后的 DOM 里图片是否还在 <td> 里，是"按单元格归组"的前提，先测出来 */
    const readImgs = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      if (!host || !host.shadowRoot) return [];
      const cells = Array.prototype.slice.call(host.shadowRoot.querySelectorAll('td, th'));
      return Array.prototype.slice.call(host.shadowRoot.querySelectorAll('img')).map((im) => {
        const td = im.closest('td, th');
        return { alt: im.getAttribute('alt') || '', cell: td ? cells.indexOf(td) : -1 };
      });
    });
    let imgs = [];
    for (let i = 0; i < 15 && imgs.length < 3; i++) { await page.waitForTimeout(200); imgs = await readImgs(); }
    console.log('        面板图片: ' + JSON.stringify(imgs));
    truthy(imgs.length >= 3, '面板里应有抓取到的图片（甲/乙/丙），实际 ' + imgs.length);
    const cellOf = (a) => (imgs.filter((x) => x.alt === a)[0] || {}).cell;
    eq(cellOf('甲图'), cellOf('乙图'), '甲图/乙图应在**同一个**单元格里（装置就是这么摆的）');
    truthy(cellOf('甲图') !== cellOf('丙图'), '丙图应在**另一个**单元格里（装置就是这么摆的）');
    truthy(cellOf('甲图') >= 0, '图片应仍在 <td> 内（相册按单元格归组的前提），实际 cell=' + cellOf('甲图'));

    const clickPanelImg = (alt) => page.evaluate((a) => {
      const host = document.getElementById('kh-important-note-host');
      const im = Array.prototype.slice.call(host.shadowRoot.querySelectorAll('img'))
        .filter((x) => (x.getAttribute('alt') || '') === a)[0];
      if (!im) return false;
      im.click();
      return true;
    }, alt);
    const lb = () => page.evaluate(() => {
      const h = document.getElementById('kh-note-lightbox');
      if (!h || !h.shadowRoot) return null;
      const sr = h.shadowRoot;
      const im = sr.querySelector('.kh-lb-img');
      return {
        hidden: sr.querySelector('.kh-lb').hidden,
        alt: im.getAttribute('alt') || '',
        idx: sr.querySelector('.kh-lb-idx').textContent,
        prevHidden: sr.querySelector('.kh-lb-prev').hidden,
        nextHidden: sr.querySelector('.kh-lb-next').hidden,
        /* 左右翻页按钮的位置（v1.99.99.12 用户要求"适当靠近图片本身"）：应紧贴图片两侧、竖直对齐图片中心 */
        nav: (function () {
          const im = sr.querySelector('.kh-lb-img').getBoundingClientRect();
          const pr = sr.querySelector('.kh-lb-prev').getBoundingClientRect();
          const nx = sr.querySelector('.kh-lb-next').getBoundingClientRect();
          return {
            prevW: Math.round(pr.width), nextW: Math.round(nx.width),
            gapLeft: Math.round(im.left - pr.right), gapRight: Math.round(nx.left - im.right),
            cxPrev: Math.round(pr.top + pr.height / 2), cxNext: Math.round(nx.top + nx.height / 2),
            imgMid: Math.round(im.top + im.height / 2),
            stage: (function () { const s = sr.querySelector('.kh-lb-stage').getBoundingClientRect(); return { w: Math.round(s.width), h: Math.round(s.height) }; })(),
            vw: window.innerWidth
          };
        })(),
        tf: im.style.transform,
      };
    });
    const clickBar = async (sel) => {
      await page.evaluate((q) => {
        document.getElementById('kh-note-lightbox').shadowRoot.querySelector(q).click();
      }, sel);
      await page.waitForTimeout(150);
      return await lb();
    };

    /* ---- 同格两张：1/2 ⇄ 2/2，首尾循环 ---- */
    truthy(await clickPanelImg('甲图'), '应能点到面板里的甲图');
    await page.waitForTimeout(250);
    let s = await lb();
    console.log('        甲图 → ' + JSON.stringify(s));
    falsy(s.hidden, '点图片应打开灯箱');
    eq(s.alt, '甲图', '灯箱应显示被点的那张');
    eq(s.idx, '1 / 2', '同格两张 → 相册索引 1 / 2');
    eq(s.prevHidden, false, '同格两张 → 「上一张」应可见');
    eq(s.nextHidden, false, '同格两张 → 「下一张」应可见');
    /* v1.99.99.12 用户口径：翻页按钮要**靠近图片本身**（原来钉在视口两端太分离）、点击区够大 */
    console.log('        翻页按钮位置: ' + JSON.stringify(s.nav));
    truthy(s.nav.prevW >= 40 && s.nav.nextW >= 40, '翻页按钮点击区应够大（≥40px），实际 ' + JSON.stringify(s.nav));
    truthy(s.nav.gapLeft >= 0 && s.nav.gapLeft <= 30, '「上一张」应紧贴图片左侧（间隔 ≤30px），实际 ' + s.nav.gapLeft);
    truthy(s.nav.gapRight >= 0 && s.nav.gapRight <= 30, '「下一张」应紧贴图片右侧（间隔 ≤30px），实际 ' + s.nav.gapRight);
    truthy(Math.abs(s.nav.cxPrev - s.nav.imgMid) <= 6 && Math.abs(s.nav.cxNext - s.nav.imgMid) <= 6,
      '左右按钮应与图片竖直居中对齐，实际 ' + JSON.stringify(s.nav));
    truthy(s.nav.stage.w < s.nav.vw - 40, '容器应是有界的一块（不是整屏），实际 ' + JSON.stringify(s.nav.stage));
    /* v1.99.99.18：容器要有可辨识的底色/边框；按钮底色**不透明**且白字（图片再花也看得清） */
    const look = await page.evaluate(() => {
      const sr = document.getElementById('kh-note-lightbox').shadowRoot;
      const cs = (sel) => getComputedStyle(sr.querySelector(sel));
      const st = cs('.kh-lb-stage'), nav = cs('.kh-lb-nav'), btn = cs('.kh-lb-btn');
      const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const p = m ? m[1].split(',').map((x) => parseFloat(x)) : []; return p.length === 4 ? p[3] : 1; };
      return {
        stageBg: st.backgroundColor, stageBorder: st.borderTopWidth + ' ' + st.borderTopStyle,
        navBg: nav.backgroundColor, navA: alpha(nav.backgroundColor), navColor: nav.color,
        btnBg: btn.backgroundColor, btnA: alpha(btn.backgroundColor)
      };
    });
    console.log('        容器/按钮观感: ' + JSON.stringify(look));
    truthy(look.stageBg !== 'rgba(0, 0, 0, 0)', '大图容器要有可辨识的底色（用户要求"明确容器范围"），实际 ' + look.stageBg);
    truthy(look.stageBorder.indexOf('0px') !== 0, '大图容器要有边框，实际 ' + look.stageBorder);
    eq(look.navA, 1, '左右翻页按钮底色必须**不透明**（否则和图片颜色混在一起看不清），实际 ' + look.navBg);
    eq(look.navColor.replace(/\s/g, ''), 'rgb(255,255,255)', '翻页按钮应是白字，实际 ' + look.navColor);
    eq(look.btnA, 1, '工具条按钮底色也必须不透明，实际 ' + look.btnBg);
    s = await clickBar('.kh-lb-next');
    eq(s.alt, '乙图', '「下一张」应切到同格里的乙图');
    eq(s.idx, '2 / 2', '「下一张」后索引应为 2 / 2');
    s = await clickBar('.kh-lb-next');
    eq(s.alt, '甲图', '末张再「下一张」应循环回第一张');
    eq(s.idx, '1 / 2', '循环后索引应回到 1 / 2');

    /* ---- 缩放 / 旋转 / 复位 ---- */
    s = await clickBar('.kh-lb-in');
    console.log('        放大后: ' + s.tf);
    truthy(/scale\(1\.25\d*\)/.test(s.tf), '「放大」应把 scale 提到 1.25，实际 ' + s.tf);
    falsy(s.hidden, '点工具栏按钮**不该**把灯箱关掉');
    /* v1.99.99.12：放大后的图片**不许压住按钮**（transform 会视觉溢出到按钮上）——
     * 用"按钮中心点上最顶层是谁"来判断可点性，比只看 z-index 更贴近用户实际点得到点不到。 */
    const hitTop = await page.evaluate(() => {
      const sr = document.getElementById('kh-note-lightbox').shadowRoot;
      const probe = (sel) => {
        const el = sr.querySelector(sel);
        const r = el.getBoundingClientRect();
        const top = sr.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top ? (top.className || top.tagName) : null;
      };
      return { zoomIn: probe('.kh-lb-in'), next: probe('.kh-lb-next'), reset: probe('.kh-lb-reset') };
    });
    console.log('        放大后按钮处最顶层元素: ' + JSON.stringify(hitTop));
    truthy(String(hitTop.zoomIn).indexOf('kh-lb-in') >= 0, '放大后「放大」按钮仍须可点（不能被图片盖住），实际 ' + hitTop.zoomIn);
    truthy(String(hitTop.next).indexOf('kh-lb-next') >= 0, '放大后「下一张」按钮仍须可点，实际 ' + hitTop.next);
    truthy(String(hitTop.reset).indexOf('kh-lb-reset') >= 0, '放大后「复位」按钮仍须可点，实际 ' + hitTop.reset);
    s = await clickBar('.kh-lb-rot');
    truthy(/rotate\(90deg\)/.test(s.tf), '「旋转」应转 90°，实际 ' + s.tf);
    s = await clickBar('.kh-lb-reset');
    truthy(/scale\(1\) rotate\(0deg\)/.test(s.tf), '「复位」应回到 scale(1) rotate(0deg)，实际 ' + s.tf);
    s = await clickBar('.kh-lb-out');
    truthy(/scale\(0\.8\)/.test(s.tf), '「缩小」应把 scale 降到 0.8，实际 ' + s.tf);
    s = await clickBar('.kh-lb-reset');

    /* ---- 异格单张：不该出现上下张 ---- */
    truthy(await clickPanelImg('丙图'), '应能点到面板里的丙图');
    await page.waitForTimeout(250);
    s = await lb();
    console.log('        丙图 → ' + JSON.stringify(s));
    eq(s.alt, '丙图', '灯箱应换成丙图');
    eq(s.idx, '', '**异格单张不该有相册索引**（用户口径：两个单元格各一张不需要识别上一张下一张）');
    eq(s.prevHidden, true, '异格单张 → 「上一张」应**隐藏**（v1.99.99.11：挪到图片两侧后不再置灰）');
    eq(s.nextHidden, true, '异格单张 → 「下一张」应**隐藏**');
    s = await clickBar('.kh-lb-next');
    eq(s.alt, '丙图', '隐藏状态下点「下一张」不该换图（也不该跳到别的单元格的图）');

    /* ---- 关闭：Esc 关闭 / 点**图片本身**不关闭（v1.99.99.11 用户口径） ---- */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    truthy((await lb()).hidden, 'Esc 应关闭灯箱');
    await clickPanelImg('甲图');
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      document.getElementById('kh-note-lightbox').shadowRoot.querySelector('.kh-lb-img').click();
    });
    await page.waitForTimeout(250);
    falsy((await lb()).hidden, '点**图片本身**不该关闭灯箱（点图片=拖动/查看）');
    await shot(page, '18-lightbox-gallery');
  });

  /* ---------------------------------------------------------- 7d. 当前页 1:1 编辑器 */
  group('7d. popup「＋ 快速添加」→ 当前网页 1:1 编辑器', { aspects: ['interact'] });

  await test('★ popup 的真实委托函数 → 当前页 Shadow DOM 里的 lg 三列编辑器', async () => {
    await fresh('list.html');
    /* 直接驱动 popup 里那个函数（不是手工发消息），这样"委托逻辑本身"也在被测范围内 */
    /* ⚠️ 2026-11-04：popup 侧的委托有 `EDITOR_TIMEOUT_MS = 2000` 上限，机器一忙（同时跑别的浏览器、
     * 内容脚本还在读存储/取样式）就会超时退回独立窗口。实测同一份代码：单跑 7.8s 绿、全量里偶发红。
     * 处理方式：**委托失败就再来一次**（最多 2 次），两次之间清掉上一次可能已经开的独立窗口；
     * 两次都退窗口才判红。「内容脚本不可达 → 独立窗口」那条对照组不受影响，回退行为仍然被盯着。 */
    let res = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pop = await api.extensionPage('popup/popup.html');
      await pop.waitForTimeout(attempt === 1 ? 500 : 900);
      res = await pop.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url || '').indexOf('list.html') >= 0);
        return { tabId: t ? t.id : null, mode: await window.KH.popupOpenQuickAdd(t ? t.id : null) };
      });
      await pop.close();
      console.log('        委托结果（第 ' + attempt + '/2 次）: ' + JSON.stringify(res));
      if (res.mode === 'page') break;
      /* 上一次超时时可能已经弹了独立编辑窗口：关掉它，别把下一次的判定带歪 */
      for (const p of api.context.pages()) {
        const u = p.url() || '';
        if (u.indexOf('editor.html') >= 0 && u.indexOf('options') < 0) await p.close().catch(() => {});
      }
      await page.evaluate(() => {
        const h = document.getElementById('kh-page-editor-host');
        if (h && h.parentNode) h.parentNode.removeChild(h);
      }).catch(() => {});
      await page.waitForTimeout(600);
    }
    eq(res.mode, 'page', '应委托成功（在页面上弹，重试一次仍失败），实际 ' + JSON.stringify(res));
    await page.waitForTimeout(700);

    const r = await page.evaluate(() => {
      const host = document.getElementById('kh-page-editor-host');
      const sr = host && host.shadowRoot;
      const m = sr && sr.querySelector('.kh-modal');
      const mask = sr && sr.querySelector('.kh-modal-mask');
      return {
        host: !!host, shadow: !!sr,
        cls: m ? m.className : '',
        w: m ? Math.round(m.getBoundingClientRect().width) : 0,
        cols: sr ? sr.querySelectorAll('.kh-editor-col').length : 0,
        colW: sr ? Array.from(sr.querySelectorAll('.kh-editor-col')).map((c) => Math.round(c.getBoundingClientRect().width)) : [],
        secs: sr ? Array.from(sr.querySelectorAll('.kh-editor-sec')).map((x) => x.getAttribute('data-sec')) : [],
        radius: m ? getComputedStyle(m).borderRadius : null,
        maskBg: mask ? getComputedStyle(mask).backgroundColor : null,
        hostZ: host ? getComputedStyle(host).zIndex : null
      };
    });
    console.log('        页内编辑器: ' + JSON.stringify(r));
    truthy(r.host && r.shadow, '应在页面里建 #kh-page-editor-host（含 ShadowRoot）');
    truthy(/kh-modal-lg/.test(r.cls), '页面模式下编辑器应是 lg 尺寸（与选项页一致），实际 ' + JSON.stringify(r.cls));
    eq(r.w, 1040, '编辑器宽度应与选项页一致（2.0.2.7 起 1040px；860 时三列各 267px，4 列表格必横向滚），实际 ' + r.w);
    eq(r.cols, 3, '应是三列布局，实际 ' + r.cols + ' 列 ' + JSON.stringify(r.colW));
    eq(r.secs.join('/'), 'basic/combo/fetch/imp', '四个分区应与选项页一致，实际 ' + JSON.stringify(r.secs));
    truthy(r.radius && r.radius !== '0px', 'ShadowRoot 里 token 应生效（圆角来自 tokens），实际 ' + r.radius);
    truthy(/rgba?\(/.test(r.maskBg || '') && !/rgba\(0, 0, 0, 0\)/.test(r.maskBg || ''), '遮罩应有变暗底色，实际 ' + r.maskBg);
    // 宿主层级必须高于重要笔记面板（面板硬编码 2147483646），否则面板会压住左列
    truthy(parseInt(r.hostZ, 10) > 2147483646, '页内编辑器宿主层级应高于面板，实际 ' + r.hostZ);

    /* 保存往返：在 Shadow DOM 里填核心词并保存（Playwright 的 CSS 定位会穿透 open shadow root） */
    /* 【2.0.2.7】核心词换成「候选胶囊」控件后输入框**常态隐藏**（点 ＋ 才搬进浮层），
     * `page.fill` 要等元素可见 ⇒ 永久超时。改为直接设值 + 派发 input（控件自己会重画胶囊行）。 */
    await page.evaluate(() => {
      const host = document.getElementById('kh-page-editor-host');
      const inp = host && host.shadowRoot && host.shadowRoot.getElementById('fld-text');
      if (!inp) throw new Error('ShadowRoot 里找不到 #fld-text（编辑器没渲染出来？）');
      inp.value = '页面编辑器测试词';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
      const host = document.getElementById('kh-page-editor-host');
      const b = Array.from(host.shadowRoot.querySelectorAll('.kh-modal .kh-btn')).find((x) => /添加|保存/.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForTimeout(900);
    /* 读存储必须用**扩展页**：主世界没有 chrome.storage（内容脚本才有） */
    const opt2 = await api.extensionPage('options/options.html');
    const saved = await opt2.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (x) => res((x.keywords || []).some((k) => k.text === '页面编辑器测试词')))));
    truthy(saved, '页面编辑器保存的词应落库');
    await opt2.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (x) => {
      chrome.storage.local.set({ keywords: (x.keywords || []).filter((k) => k.text !== '页面编辑器测试词') }, res);
    })));
    await opt2.close();
    await page.waitForTimeout(300);
  });

  await test('★ 内容脚本不可达时 → 独立编辑窗口（lg 三列，绝不塞进插件弹窗）', async () => {
    /* 兜底路径：popup/editor.html 就是 chrome.windows.create 打开的那个页面。
     * 断言它弹的是**同一份**编辑器（与选项页同档），而不是 348px 弹窗里的内联版。 */
    const ed = await api.extensionPage('popup/editor.html');
    const errs = [];
    ed.on('pageerror', (e) => errs.push(String(e.message)));
    await ed.reload({ waitUntil: 'load' });
    await ed.waitForTimeout(900);
    const r = await ed.evaluate(() => {
      const m = document.querySelector('.kh-modal');
      return {
        cls: m ? m.className : null,
        w: m ? Math.round(m.getBoundingClientRect().width) : 0,
        h: m ? Math.round(m.getBoundingClientRect().height) : 0,
        cols: document.querySelectorAll('.kh-editor-col').length,
        secs: Array.from(document.querySelectorAll('.kh-editor-sec')).map((x) => x.getAttribute('data-sec')),
        title: (document.querySelector('.kh-modal-title') || {}).textContent || '',
        hasHead: !!document.querySelector('.kh-modal-head'),
        docTitle: document.title,
        maskBg: (() => { const mk = document.querySelector('.kh-modal-mask'); return mk ? getComputedStyle(mk).backgroundColor : null; })()
      };
    });
    console.log('        独立编辑窗口: ' + JSON.stringify(r) + '；报错=' + JSON.stringify(errs.slice(0, 2)));
    eq(errs.length, 0, '独立编辑窗口不应有脚本报错（MV3 的 CSP 会拦内联脚本 —— 引导必须放外部文件）');
    truthy(/kh-modal-lg/.test(r.cls || ''), '独立窗口里应是 lg 尺寸编辑器，实际 ' + JSON.stringify(r.cls));
    truthy(/is-bare/.test(r.cls || ''), '独立窗口应走**裸模式**（只留内容），实际 ' + JSON.stringify(r.cls));
    falsy(r.hasHead, '裸模式下不应再有弹窗自己的标题行（窗口已有系统标题栏）');
    eq(r.maskBg, 'rgba(0, 0, 0, 0)', '裸模式下遮罩应透明（不再叠一层深色框），实际 ' + r.maskBg);
    truthy(r.w >= 820, '宽度要够放三列（≥820），实际 ' + r.w);
    eq(r.cols, 3, '应是三列布局，实际 ' + r.cols);
    eq(r.secs.join('/'), 'basic/combo/fetch/imp', '四个分区应与选项页一致，实际 ' + JSON.stringify(r.secs));
    // 裸模式下弹窗自己的标题行已去掉：标题改为落在**窗口标题**（document.title）上
    truthy(/关键词/.test(r.docTitle || ''), '窗口标题应是「添加关键词」这类（裸模式下标题只在这里），实际 ' + JSON.stringify(r.docTitle));
    await shot(ed, '10-editor-window');
    await ed.close();
  });

  /* ---------------------------------------------------------- 7e. 极端场景体检 */
  group('7e. 极端场景体检（拆词 / 断行 / 影子 DOM / 列错位 / 规模）', { aspects: ['hit'] });

  await test('★ 极端场景矩阵：该命中的都命中，不该命中的都不命中', async () => {
    /* 装置页 fixtures/extreme.html 铺了 18 种极端形态（`node _e2e/probe-extreme.js` 会打印整张表）。
     * 用**临时配置**（普通词「审核不通过」+ 上下格 名称/甲），测完还原。 */
    const opt = await api.extensionPage('options/options.html');
    const saved = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res(r.keywords || []))));
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({
      keywords: [
        { id: 'k-split', text: '审核不通过', note: '备注X', enabled: true, groupId: null },
        { id: 'k-tb', text: '甲', cellVerify: '名称', cellVerifyEnabled: true, comboAxis: 'tb', enabled: true, groupId: null },
        { id: 'k-lr', text: '乙', cellVerify: '左标题', cellVerifyEnabled: true, comboAxis: 'lr', enabled: true, groupId: null }
      ]
    }, res)));
    await opt.close();

    const ex = await api.context.newPage();
    try {
      await ex.goto(FIX(origin, 'extreme.html'), { waitUntil: 'load' });
      await ex.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await ex.waitForTimeout(2500);
      const r = await ex.evaluate(() => {
        const count = (id) => {
          const host = document.getElementById(id);
          if (!host) return null;
          let n = 0, cross = 0;
          CSS.highlights.forEach((hl) => {
            for (const rg of hl) {
              const x = rg.startContainer;
              const el = x && (x.nodeType === 1 ? x : x.parentElement);
              if (el && host.contains(el)) { n++; if (rg.startContainer !== rg.endContainer) cross++; }
            }
          });
          return { n, cross };
        };
        const out = {};
        for (const id of ['cA', 'cB', 'cC', 'cD', 'cE', 'cF', 'cG', 'cH', 'cI1', 'cI2', 'cJ', 'cK', 'cQ']) out[id] = count(id);
        out.tM2 = count('tM2');
        const host = document.getElementById('cL');
        let shadow = 0;
        if (host && host.shadowRoot) {
          CSS.highlights.forEach((hl) => {
            for (const rg of hl) {
              const x = rg.startContainer;
              const e = x && (x.nodeType === 1 ? x : x.parentElement);
              if (e && host.shadowRoot.contains(e)) shadow++;
            }
          });
        }
        out.shadow = shadow;
        return out;
      });
      console.log('        极端场景: 嵌套拆词=' + r.cA.n + ' 中间空span=' + r.cC.n + ' 断行=' + r.cD.n +
        ' 跨块=' + r.cE.n + ' 三次=' + r.cH.n + ' emoji中=' + r.cI1.n + ' shadow=' + r.shadow +
        ' 500次=' + r.cQ.n + ' colspan列错位=' + r.tM2.n);

      // ---- 该命中的 ----
      truthy(r.cA.n >= 1, '深层嵌套拆词（审<b><i>核</i></b>不通过）应命中');
      truthy(r.cA.cross >= 1, '该命中应是跨节点 Range');
      truthy(r.cB.n >= 1, '前置空 span 应命中');
      truthy(r.cC.n >= 1, '中间空 span（审核<span></span>不通过）应命中');       // 本轮修的缺口
      truthy(r.cF.n >= 1, '首字独立 span 应命中');
      truthy(r.cG.n >= 1, '尾随空 span 应命中');
      eq(r.cH.n, 3, '同一段出现三次应命中 3 次，实际 ' + r.cH.n);
      eq(r.cQ.n, 500, '500 次同词应全部命中，实际 ' + r.cQ.n);
      truthy(r.shadow >= 1, 'Shadow DOM 内的词应命中');
      truthy(r.tM2.n >= 1, '表头 colspan 之后标题词（列序号会错位）应命中');      // 本轮修的缺口
      // ---- 不该命中的 ----
      eq(r.cD.n, 0, '中间夹 <br>（视觉断行）**不该**命中，实际 ' + r.cD.n);
      eq(r.cE.n, 0, '跨块级元素（div/div）**不该**命中，实际 ' + r.cE.n);
      eq(r.cI1.n, 0, 'emoji 夹在词中间**不该**命中，实际 ' + r.cI1.n);
      eq(r.cJ.n, 0, 'script/style 里**不该**命中，实际 ' + r.cJ.n);
      eq(r.cK.n, 0, 'input/textarea 里**不该**命中，实际 ' + r.cK.n);
      /* ---- 嵌套表格：外层表头不得把内层数据算进自己的列（也不得重复计数） ---- */
      await ex.goto(FIX(origin, 'nested.html'), { waitUntil: 'load' });
      await ex.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
      await ex.waitForTimeout(1500);
      const nst = await ex.evaluate(() => {
        const out = {};
        for (const id of ['caseR', 'caseS', 'caseT', 'caseU', 'caseV']) {
          const box = document.getElementById(id);
          let n = 0;
          if (box) {
            CSS.highlights.forEach((hl) => {
              for (const rg of hl) {
                const x = rg.startContainer;
                const el = x && (x.nodeType === 1 ? x : x.parentElement);
                if (el && box.contains(el)) n++;
              }
            });
          }
          out[id] = n;
        }
        return out;
      });
      console.log('        嵌套表格: R=' + nst.caseR + ' S=' + nst.caseS + ' T=' + nst.caseT + ' U=' + nst.caseU + ' V=' + nst.caseV);
      eq(nst.caseR, 2, 'R 外层一对+内层自带一对 → 应 2 次（各算各的），实际 ' + nst.caseR);
      eq(nst.caseS, 1, 'S 内层无表头 → 只算外层列那 1 次，实际 ' + nst.caseS);
      eq(nst.caseT, 1, 'T 内层是别的表头 → 仍只 1 次（不得串用外层表头），实际 ' + nst.caseT);
      eq(nst.caseU, 2, 'U 三级嵌套 → 外层 1 + 最内层 1，实际 ' + nst.caseU);
      eq(nst.caseV, 1, 'V 左右格右格内套表格 → 1 次，实际 ' + nst.caseV);
    } finally {
      await ex.close();
      const opt2 = await api.extensionPage('options/options.html');
      await opt2.evaluate((kw) => new Promise((res) => chrome.storage.local.set({ keywords: kw }, res)), saved);
      await opt2.close();
    }
  });

  /* ---------------------------------------------------------- 7f. 深层嵌套 + 抓取 */
  group('7f. 内层表格复杂 / 内层命中组合词 / 抓取外层', { aspects: ['hit', 'fetch'] });

  await test('★ 内层表格复杂也各按自己表头算列；内层组合词生效；抓取外层不被内层搅乱', async () => {
    /* 装置页 fixtures/deep.html。三个问题一起验（用户追问）：
     *   ① 单元格里的内层表格本身很复杂（标题行 + thead/th + colspan + 多行多列）
     *   ② 内层表格命中**左右格 / 上下格**组合词
     *   ③ 抓取外层表格时，值格里的内层表格会不会搅乱字段边界 */
    const opt = await api.extensionPage('options/options.html');
    const saved = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res(r.keywords || []))));
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({
      keywords: [
        { id: 'tb', text: '甲', cellVerify: '名称', cellVerifyEnabled: true, comboAxis: 'tb', enabled: true, groupId: null },
        { id: 'lr', text: '乙', cellVerify: '左标题', cellVerifyEnabled: true, comboAxis: 'lr', enabled: true, groupId: null },
        { id: 'hit', text: '审核不通过', fetchLabels: '驳回原因|运营备注', enabled: true, groupId: null, important: true, importantNote: '抓取笔记' }
      ]
    }, res)));
    await opt.close();

    const dp = await api.context.newPage();
    try {
      await dp.goto(FIX(origin, 'deep.html'), { waitUntil: 'load' });
      await dp.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await dp.waitForTimeout(2200);
      await openFloatPage(dp);
      const r = await dp.evaluate(() => {
        const box = {};
        for (const id of ['caseW', 'caseX', 'caseY']) {
          const el = document.getElementById(id);
          let n = 0;
          if (el) {
            CSS.highlights.forEach((hl) => {
              for (const rg of hl) {
                const x = rg.startContainer;
                const e = x && (x.nodeType === 1 ? x : x.parentElement);
                if (e && el.contains(e)) n++;
              }
            });
          }
          box[id] = n;
        }
        // 抓取结果：面板里每张表的每一行
        const tables = [];
        const host = document.getElementById('kh-important-note-host');
        const sr = host && host.shadowRoot;
        if (sr) {
          for (const tb of sr.querySelectorAll('.kh-table')) {
            const rows = [];
            for (const tr of tb.querySelectorAll('tr')) rows.push(Array.from(tr.children).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()));
            tables.push(rows);
          }
        }
        return { box, tables };
      });
      console.log('        复杂内层表=' + r.box.caseW + ' 内层左右格=' + r.box.caseX + ' 内层上下格=' + r.box.caseY);
      console.log('        抓取表: ' + JSON.stringify(r.tables));
      eq(r.box.caseW, 2, '内层表格很复杂（标题行+colspan+多行多列）时，外层 1 + 内层 1，实际 ' + r.box.caseW);
      eq(r.box.caseX, 1, '内层命中**左右格**组合词应生效，实际 ' + r.box.caseX);
      eq(r.box.caseY, 1, '内层命中**上下格**组合词应生效，实际 ' + r.box.caseY);
      // 抓取：字段边界要正确，且**外层的值里不许混进内表文字**（K79 口径：内表归「内层」方向）
      const flat = JSON.stringify(r.tables);
      includes(flat, '外层文字第一行', '外层自己的文字照旧是这一层的值，实际 ' + flat);
      falsy(flat.indexOf('内层A') >= 0,
        '★ K79：外层的值里**不许**混进内表文字（旧实现把「内层A 内层B」一起抓走 —— 用户症状②），实际 ' + flat);
      includes(flat, '运营备注', '应抓到「运营备注」这个字段');
      truthy(flat.indexOf('"运营备注","高价值需跟进"') >= 0,
        '字段边界要正确：运营备注 的值应只有「高价值需跟进」，实际 ' + flat);
      // 越界检查：驳回原因那一行里不得再出现后面字段的值
      const firstRow = (r.tables[0] || []).map((x) => x.join('|')).join(' || ');
      falsy(/命中行，用来触发抓取/.test(firstRow), '驳回原因的块**不该**吞掉后面字段的内容，实际 ' + firstRow);
    } finally {
      await dp.close();
      const o2 = await api.extensionPage('options/options.html');
      await o2.evaluate((kw) => new Promise((res) => chrome.storage.local.set({ keywords: kw }, res)), saved);
      await o2.close();
    }
  });

  /* ---------------------------------------------------------- 7g. 冷门场景二 */
  group('7g. 布局改写 / 虚拟滚动 / 跨 frame / 高亮被页面清掉', { aspects: ['hit'] });

  await test('★ flex 改写 / 虚拟滚动重渲染 / 跨 frame 组合词 / clear() 后自愈', async () => {
    const opt = await api.extensionPage('options/options.html');
    const saved = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res(r.keywords || []))));
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({
      keywords: [
        { id: 'tb', text: '甲', cellVerify: '名称', cellVerifyEnabled: true, comboAxis: 'tb', enabled: true, groupId: null },
        { id: 'kw', text: '审核不通过', enabled: true, groupId: null }
      ]
    }, res)));
    await opt.close();

    const p2 = await api.context.newPage();
    await p2.setViewportSize({ width: 1200, height: 900 });
    try {
      await p2.goto(FIX(origin, 'weird2.html'), { waitUntil: 'load' });
      await p2.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await p2.waitForTimeout(1500);
      const C = (ids) => {
        const out = {};
        for (const id of ids) {
          const host = document.getElementById(id);
          let n = 0;
          if (host && typeof CSS !== 'undefined' && CSS.highlights) {
            CSS.highlights.forEach((hl) => {
              for (const rg of hl) {
                const x = rg.startContainer;
                const e = x && (x.nodeType === 1 ? x : x.parentElement);
                if (e && host.contains(e)) n++;
              }
            });
          }
          out[id] = n;
        }
        return out;
      };
      const a = await p2.evaluate(C, ['flexTbl', 'vlist', 'crossTbl']);
      eq(a.flexTbl, 1, '真 <table> 被 CSS 改成 flex 布局后，上下格仍应按 DOM 列语义命中，实际 ' + a.flexTbl);
      eq(a.vlist, 10, '虚拟滚动列表初始应命中可视的 10 个「甲」行，实际 ' + a.vlist);
      eq(a.crossTbl, 0, '跨 frame 的组合词（表头在父页、数据在 iframe）**不该**命中，实际 ' + a.crossTbl);

      // 滚动 → 换一批行 → 命中数应仍等于可视的含词行数（无残留、无漏）
      await p2.evaluate(() => { const b = document.getElementById('vlist'); b.scrollTop = 2000; b.dispatchEvent(new Event('scroll')); });
      await p2.waitForTimeout(1300);
      const b2 = await p2.evaluate(C, ['vlist']);
      const jiaRows = await p2.evaluate(() => Array.from(document.querySelectorAll('#vlist .row')).filter((r) => r.textContent.indexOf('甲') >= 0).length);
      console.log('        虚拟滚动: 初始=' + a.vlist + ' 滚动后=' + b2.vlist + '（可视含词行=' + jiaRows + '）');
      eq(b2.vlist, jiaRows, '滚动重渲染后，命中数应等于可视的含词行数（无残留），实际 ' + b2.vlist + ' vs ' + jiaRows);

      // iframe 内：数据单独不命中；完整表格命中
      let inFrame = null;
      for (const fr of p2.frames()) {
        if (fr === p2.mainFrame()) continue;
        if (/frame-table\.html/.test(fr.url())) {
          inFrame = await fr.evaluate(() => { let n = 0; CSS.highlights.forEach((hl) => { for (const rg of hl) n++; }); return n; });
        }
      }
      eq(inFrame, 1, 'iframe 内**自成一体**的表格应命中（表头与数据同文档），实际 ' + inFrame);

      // 页面 clear() → 被清 → 一次 DOM 变动即自愈
      await p2.click('#btn-clear');
      await p2.waitForTimeout(400);
      const cleared = await p2.evaluate(C, ['w4']);
      eq(cleared.w4, 0, '页面调用 CSS.highlights.clear() 会把我们的高亮一起清掉（共享同一注册表），实际 ' + cleared.w4);
      await p2.click('#btn-mutate');
      await p2.waitForTimeout(1500);
      const back = await p2.evaluate(C, ['w4']);
      truthy(back.w4 >= 1, '下一次重扫应能**自愈**（重新注册高亮组），实际 ' + back.w4);
    } finally {
      await p2.close();
      const o2 = await api.extensionPage('options/options.html');
      await o2.evaluate((kw) => new Promise((res) => chrome.storage.local.set({ keywords: kw }, res)), saved);
      await o2.close();
    }
  });

  /* ---------------------------------------------------------- 9. 全词+正则 */  group('7. 全词 + 正则词边界（策划案 §7.1 坑 1）', { aspects: ['hit'] });

  await test('★ 正则 A|B 中间分支也有词边界（xFEATUREy 不命中、独立 FEATURE 命中）', async () => {
    await fresh('list.html');
    // 先注入文本，**等一轮重建**，再读命中（不能在同一次 evaluate 里完成，重建是异步的）
    const TEXT = 'xBUGy aaa xFEATUREy bbb BUG ccc FEATURE ddd';
    await page.evaluate((t) => { document.getElementById('boundary-host').textContent = t; }, TEXT);
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => {
      const host = document.getElementById('boundary-host');
      const tn = host.childNodes[0];
      const marks = [];
      CSS.highlights.forEach((hl) => {
        try {
          for (const rr of hl) {
            if (rr.startContainer === tn) marks.push({ s: rr.startOffset, e: rr.endOffset, t: tn.nodeValue.slice(rr.startOffset, rr.endOffset) });
          }
        } catch (e) { /* ignore */ }
      });
      const t = tn.nodeValue;
      const covered = (pos, len) => marks.some(m => m.s <= pos && m.e >= pos + len);
      return {
        marks, text: t,
        inBug: covered(t.indexOf('xBUGy') + 1, 3),
        inFeature: covered(t.indexOf('xFEATUREy') + 1, 7),
        aloneBug: covered(t.lastIndexOf(' BUG ') + 1, 3),
        aloneFeature: covered(t.lastIndexOf(' FEATURE ') + 1, 7)
      };
    });
    console.log('        文本: ' + JSON.stringify(r.text));
    console.log('        命中片段: ' + JSON.stringify(r.marks.map(m => m.t + '@' + m.s + '-' + m.e)));
    truthy(r.marks.length > 0, '注入后应有命中（说明重建生效）');
    truthy(r.aloneBug, '独立 BUG 应命中（下标 ' + (r.text.lastIndexOf(' BUG ') + 1) + '）');
    truthy(r.aloneFeature, '独立 FEATURE 应命中（K7：多分支正则的后续分支必须也能命中）');
    falsy(r.inBug, 'xBUGy 里的 BUG 不应命中（词中）');
    falsy(r.inFeature, 'xFEATUREy 里的 FEATURE 不应命中（策划案 §7.1 坑 1：中间分支必须有边界）');
  });

  await test('★ 多命中：同一处文本里同一条规则的全部匹配都要登记（K7）', async () => {
    // 上一条已注入边界文本；这里校验"两个独立词都在 CSS.highlights 里"
    const r = await page.evaluate(() => {
      const tn = document.getElementById('boundary-host').childNodes[0];
      const got = [];
      CSS.highlights.forEach((hl) => {
        try {
          for (const rr of hl) {
            if (rr.startContainer === tn) got.push(tn.nodeValue.slice(rr.startOffset, rr.endOffset) + '@' + rr.startOffset);
          }
        } catch (e) { /* ignore */ }
      });
      return got.sort();
    });
    console.log('        全部命中: ' + JSON.stringify(r));
    eq(r.length, 2, '两个独立词都应登记（缺 g 时只会命中第一个）');
    includes(r.join(','), 'BUG@24', '独立 BUG@24');
    includes(r.join(','), 'FEATURE@32', '独立 FEATURE@32');
  });

  /* ---------------------------------------------------------- 13. 站点门禁热更新 */
  group('13. 站点白名单 / 禁用本站即时生效（配置热更新必须复核门禁）', { aspects: ['site'] });

  /* 旧 applyConfig 只重编译 + 无条件 rebuild，**不重评站点门禁**，于是：
   *   · options 新增白名单 → storage 变更 → 本该失效的站点仍然高亮；
   *   · 旧版 popup「禁用本站」写 siteDisabledMap → storage 变更把它重新点亮，
   *     与随后 nudge 的 SITE_CHANGED（走 boot）竞态 → 表现为"时灵时不灵 / 无效"。
   * 这两条都走 storage.onChanged → applyConfig，所以在这里按真实路径断言。
   * 【2.0.7.2 需求⑤】起弹窗那个按钮改成**标签页级**（不再写 siteDisabledMap），但 `siteDisabledMap`
   * 作为**历史存量**仍参与门禁 ⇒ 这一组继续用"写 siteDisabledMap"验热更新，语义没变。
   * 标签页级那条链路的真机回归由 `_e2e/ui.test.js`（按钮文案/图标）+ 人工清单
   * `tests/BROWSER-CHECKLIST.md` §8「需求⑤」两条覆盖。 */
  await test('★ 白名单 / 禁用本站写入 storage 后立即生效，恢复后重新上线', async () => {
    await fresh('eltable.html');
    let p = await page.evaluate(PROBE);
    eq(p.state, 'on', '前置：默认应为高亮态');
    truthy(p.ranges > 0, '前置：应有高亮 Range，实际 ' + p.ranges);

    try {
      /* ① 存在白名单、本站不在其中 → 立刻失效并清空高亮 */
      await api.setConfig(Object.assign({}, CONFIG, {
        siteRules: [{ type: 'whitelist', matchType: 'exact', scope: 'domain', pattern: 'example.com' }]
      }));
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') === 'off', null, { timeout: 8000 }).catch(() => { });
      p = await page.evaluate(PROBE);
      eq(p.state, 'off', '存在白名单且本站不在其中 → 应变失效态（旧实现会漏判并继续高亮）');
      eq(p.ranges, 0, '失效后页面不得残留高亮 Range，实际 ' + p.ranges);

      /* ② 白名单撤掉、改为「临时禁用」→ 仍应失效（旧版 popup 走的就是写 siteDisabledMap 这条路径；
       *    现在它是**历史存量**口径：老用户升级前禁掉的站点必须继续不高亮） */
      await api.setConfig(Object.assign({}, CONFIG, { siteDisabledMap: { '127.0.0.1': true } }));
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') === 'off', null, { timeout: 8000 }).catch(() => { });
      p = await page.evaluate(PROBE);
      eq(p.state, 'off', '「禁用本站」写入 storage 后应立即失效');
      eq(p.ranges, 0, '禁用后不得残留高亮 Range，实际 ' + p.ranges);
    } finally {
      await api.setConfig(CONFIG);   // 必须恢复默认配置，否则后续用例整片失效
    }

    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') === 'on', null, { timeout: 8000 }).catch(() => { });
    p = await page.evaluate(PROBE);
    eq(p.state, 'on', '恢复默认配置后应重新上线');
    truthy(p.ranges > 0, '恢复后高亮应回来，实际 ' + p.ranges);
  });

  /* ---------------------------------------------------------- 14. 罕见字组合 */
  group('14. 罕见字作为组合核心（规格：只在组合上下文里命中）', { aspects: ['hit'] });

  /* 规格出处：`src/ui/changelog.js` ——「罕见字规则…也可作为「单元格组合」的右格核心」。
   * 旧实现把"罕见字 + 组合"退化成整页逐字扫罕见字（rare Adapter 无条件接管、
   * combo Adapter 又排除 rareChar，两边互补失败）→ 页面上所有罕见字一起亮。 */
  await test('★ 罕见字 + 左右格组合：只命中标题格右侧的罕见字', async () => {
    await fresh('rare-combo.html');
    const hitCount = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return -1;
      const nodes = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n; while ((n = w.nextNode())) nodes.push(n);
      let c = 0;
      CSS.highlights.forEach((hl) => {
        try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) { /* ignore */ }
      });
      return c;
    }, sel);

    try {
      /* 只加一条「罕见字 + 左格组合」的关键词；**不动共享 CONFIG 的其它字段**，
       * 也用 try/finally 还原 —— 避免影响其它用例里"关键词数 / 批量落库条数"这类计数断言。 */
      await api.setConfig(Object.assign({}, CONFIG, {
        keywords: CONFIG.keywords.concat([{
          id: 'kRare', text: 'hjz#', kind: 'rare', note: '', groupId: null, enabled: true,
          caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
          important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
          cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr',
          cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
          fetchLabels: ''
        }])
      }));
      // 等"应命中的那一处"真的亮起来（配置热更新是异步的），再断言另外三处为 0
      await page.waitForFunction(() => {
        const el = document.querySelector('#rare-in');
        if (!el) return false;
        const nodes = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let c = 0;
        CSS.highlights.forEach((hl) => {
          try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) { /* ignore */ }
        });
        return c > 0;
      }, null, { timeout: 8000 }).catch(() => { });

      const r = {
        inCell: await hitCount('#rare-in'),
        otherLabel: await hitCount('#rare-out'),
        commonOnly: await hitCount('#rare-common'),
        plain: await hitCount('#rare-plain')
      };
      console.log('        命中情况: ' + JSON.stringify(r));
      truthy(r.inCell > 0, '标题格「资质类型」右侧的罕见字应命中');
      eq(r.otherLabel, 0, '左格标题不是「资质类型」时，其右格的罕见字不得命中（旧实现会命中＝整页逐字扫）');
      eq(r.commonOnly, 0, '右格全常用字不得命中');
      eq(r.plain, 0, '不在任何组合上下文里的罕见字不得命中（旧实现会命中）');
      await shot(page, '15-rare-combo');
    } finally {
      await api.setConfig(CONFIG);   // 必须还原，否则后续用例会多一条罕见字规则
      await page.waitForTimeout(300);
    }
  });

  /* ---------------------------------------------------------- 15. SPA 路由 */
  group('15. SPA 路由（列表 → 详情）', { aspects: ['hit', 'site'] });

  /* 用户实测缺陷：「在网页列表点击跳转到详情页时，高亮词没有进行命中（刷新后确认页面是有高亮的）」。
   * 真浏览器实测到的两个根因：
   *   ① `boot()` 入口的 `destroy()` → `teardownAll()` 会把 600ms 的 URL 轮询清掉，
   *      而 `setupUrlWatcher` 被 `if (this._urlBound) return` **整段**挡住 → 轮询永不重建
   *      （实测：主世界 pushState 后 2.5s 零重建、`_lastHref` 冻结）；
   *   ② 更关键：`boot()` 在站点门禁不通过时**提前 return**，而 `setupUrlWatcher` 在它之后
   *      → 「当前页不生效、点进详情页才生效」这类配置下，当前页**根本没挂路由监听** →
   *      点进详情页也永远不重评、不高亮，只能刷新（刷新是全新文档，走正常启动路径）。
   * 这条用例用**生产默认节流**（1s 静默 / 2s 限频 / 1s 指纹）+ 只放行详情 URL 的网址级白名单，
   * 走的正是 ② 那条确定性复现路径 —— 测试配置里的 0 节流会掩盖这类问题，所以这里显式覆盖。 */
  await test('★ 列表 → 详情（SPA 路由）：详情页内容必须被重新扫描并命中，不依赖刷新', async () => {
    const hitOf = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return -1;
      const nodes = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n; while ((n = w.nextNode())) nodes.push(n);
      let c = 0;
      CSS.highlights.forEach((hl) => {
        try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) { /* ignore */ }
      });
      return c;
    }, sel);

    try {
      await api.setConfig(Object.assign({}, CONFIG, {
        siteRules: [{ type: 'whitelist', matchType: 'prefix', scope: 'url', pattern: origin + '/spa-detail.html' }],
        pageRebuildSilentMs: 1000,
        pageRebuildGapMs: 2000,
        pageFingerprintIntervalMs: 1000
      }));
      await fresh('spa-list.html');
      const pre = await page.evaluate(PROBE);
      eq(pre.state, 'off', '前置：列表页不在白名单 → 应为失效态');
      eq(pre.ranges, 0, '前置：失效态不应有任何高亮');

      await page.click('#go-detail');     // 站点自己的 pushState（主世界）+ 400ms 后异步渲染详情
      let got = 0;
      for (let i = 0; i < 16; i++) {      // 最多等 8s（生产节流下正常 0.6~2s 就该命中）
        await page.waitForTimeout(500);
        got = await hitOf('#detail-line');
        if (got > 0) break;
      }
      truthy(got > 0, '★ 点进详情页后必须重新扫描并命中（旧实现：失效态没挂路由监听 → 永久不命中，只能刷新）');
      eq((await page.evaluate(PROBE)).state, 'on',
        '★ 路由切换后状态标记也必须变成 on（旧实现只有内容脚本那三条路径写标记 → URL 触发的那次会停在 off，诊断会看错）');
      await shot(page, '16-spa-route');

      // 反向：直接加载该 URL（= 用户刷新的等价路径）也必须命中，锁住"刷新就好"那一半不被改坏
      await page.goto(origin + '/spa-detail.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 8000 });
      await page.waitForTimeout(600);
      truthy(await hitOf('#detail-line') > 0, '直接加载详情页（刷新路径）必须命中');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ---------------------------------------------------------- 16. 晚挂 ShadowRoot */
  group('16. 晚挂的 ShadowRoot（自定义元素晚升级）', { aspects: ['hit'] });

  /* 真浏览器实测过的缺口：`attachShadow` **不产生任何 MutationRecord** ——
   * 宿主先存在于初始 HTML、之后再 attachShadow + 填内容时，文档树观察器收不到记录、
   * `_shadowRoots` 也不增加 → 那部分内容永远不被扫描（实测 9s 零高亮、零重建），
   * 但手动触发一次重建立刻命中（说明扫描器进得去 Shadow，缺的只是"触发"）。
   * 修法：定期补挂 ShadowRoot（`Scheduler.sweepShadowRoots`，2s 一次），
   * 发现新增就补挂观察器并请求一次重建。 */
  await test('★ 宿主之后才 attachShadow 的内容也必须被扫到（页面不产生任何 DOM 变更）', async () => {
    await fresh('spa-shadow.html');

    const countIn = (where) => page.evaluate((w) => {
      let el = null;
      if (w === 'shadow') {
        const host = document.getElementById('late-host');
        el = host && host.shadowRoot && host.shadowRoot.querySelector('#shadow-line');
      } else {
        el = document.querySelector('#page-line');
      }
      if (!el) return -1;
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n; while ((n = walker.nextNode())) nodes.push(n);
      let c = 0;
      CSS.highlights.forEach((hl) => {
        try { for (const rr of hl) if (nodes.indexOf(rr.startContainer) >= 0) { c++; break; } } catch (e) { /* ignore */ }
      });
      return c;
    }, where);

    // 前置：普通（light DOM）命中正常，说明管线本身是好的
    truthy(await countIn('light') > 0, '前置：页面正文里的关键词应正常命中');

    let got = 0;
    for (let i = 0; i < 18; i++) {         // 补挂周期 2s + 重建，最多等 9s
      await page.waitForTimeout(500);
      got = await countIn('shadow');
      if (got > 0) break;
    }
    console.log('        影子内命中 = ' + got);
    truthy(got > 0, '★ 晚挂的 ShadowRoot 里的关键词必须被扫到（旧实现：attachShadow 无 MutationRecord → 永不触发重建）');
    await shot(page, '17-late-shadow');
  });

  /* ---------------------------------------------------------- 17. bfcache */
  group('17. 前后退缓存（bfcache）', { aspects: ['site'] });

  /* "刷新就好"的另一条路径：旧实现在 `pagehide` 里**无条件** `destroy()`，
   * 而页面进入"后退/前进缓存"时同样会发 `pagehide`（`event.persisted === true`，
   * 页面只是被冻结、随时原样恢复）→ 冻结前就把高亮与状态清掉，恢复时没有任何事件救回来
   * → 从缓存回来的页面永久不高亮。
   * 说明：本装置里 `page.goBack()` 走的是**重新加载**（探针实测：旧文档痕迹消失），
   * 拿不到真实 bfcache，所以这里用**合成 PageTransitionEvent** 锁住代码路径 ——
   * 旧实现在合成 `pageshow` 后同样不会复活，断言依然有区分力。 */
  await test('★ 进缓存不下线、真卸载才下线、从缓存恢复必须重新上线', async () => {
    await fresh('list.html');
    await page.waitForTimeout(500);
    const hits = () => page.evaluate(() => {
      let c = 0;
      CSS.highlights.forEach((hl) => { c += (hl.size !== undefined ? hl.size : (hl.ranges ? hl.ranges.length : 0)); });
      return c;
    });
    const state = () => page.evaluate(() => document.documentElement.getAttribute('data-kh-state'));

    truthy(await hits() > 0, '前置：正常应为高亮态');

    // ① 进 bfcache：**不得**下线
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForTimeout(300);
    truthy(await hits() > 0, '★ 进入后退/前进缓存时不得清掉高亮（旧实现无条件 destroy → 这里就清了）');
    eq(await state(), 'on', '进缓存后状态标记应仍为 on');

    // ② 真卸载：照旧下线（既有语义不能被改坏）
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(300);
    eq(await hits(), 0, '真卸载（persisted=false）应照旧下线');
    eq(await state(), 'off', '真卸载后状态标记应为 off');

    // ③ 从缓存恢复：必须自己重新上线（旧实现没有任何 pageshow 处理）
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    let back = 0;
    for (let i = 0; i < 12; i++) { await page.waitForTimeout(300); back = await hits(); if (back > 0) break; }
    truthy(back > 0, '★ 从后退/前进缓存恢复后必须重新扫描上线（旧实现：恢复后永久失效，只能刷新）');
    eq(await state(), 'on', '恢复后状态标记应为 on');
  });

  /* ---------------------------------------------------------- 18. 重页面性能预算 */
  group('18. 重页面性能预算（防「页面卡死」回归）', { aspects: ['fetch', 'interact'] });

  /* 同组 800 行用例的实测基线，供 3000 行那条算"同一台机器、同一时段"的相对比值。 */
  let heavy800Ms = 0;

  /* 用户实测缺陷：大表格页面上插件把主线程占住几十秒 → 浏览器报"加载失败/长时间无响应"。
   * 根因：`important-note` 对**每一个重要命中**都调一次 `Fetch.blockFor`，
   * 而它每次都要 `table.querySelectorAll('td, th')` 枚举整张表找标签格
   * → O(命中数 × 表格单元格数)。实测 800 行（1734 命中）光这一项 31 秒、整条重建 30s+。
   * 这条断言是**宽松但有效**的预算：机器忙时不假红，但只要再退化成二次方就必然超。 */
  await test('★ 800 行重页面（命中 1700+）必须快速就绪，不得把主线程占住', async () => {
    const t0 = Date.now();
    await page.goto(origin + '/perf-heavy.html?rows=800', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const ready = await page.waitForFunction(() => {
      if (document.documentElement.getAttribute('data-kh-state') !== 'on') return false;
      let n = 0;
      CSS.highlights.forEach((hl) => { n += (hl.size !== undefined ? hl.size : 0); });
      return n > 1000;                       // 真的扫到了（不是空转）
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    const ms = Date.now() - t0;
    console.log('        800 行重页面就绪耗时 = ' + ms + 'ms');
    heavy800Ms = ms;                        // 给 3000 行那条当「同一台机器、同一时段」的基线
    truthy(ready, '★ 重页面必须在 20s 内进入高亮态（旧实现：二次方 → 30s 都回不来）');
    truthy(ms < 10000, '★ 就绪预算 10s（修复后实测约 1s；一旦退化成二次方会立刻超），实际 ' + ms + 'ms');
  });

  await test('★ 3000 行页面也要能就绪（扫描按格复用缓存后的预算）', async () => {
    /* V1.99.99.15 性能体检：组合词探针此前对**每条规则**都重算一遍"格内文本/文本属于哪个格子/表头列"，
     * 实测 2000 行页面 combo-lr 507ms + combo-tb 444ms（占整个 scan 的 80%）。
     * 改成"按 scan 缓存"后 scan 1186ms → 707ms、整条 rebuild 1927ms → 1471ms。
     * 这里用更大的页面钉住"不许退化回二次方/重复计算"。 */
    /* ⚠️ 2026-09-23（K77 之后）：**同一份代码在两次会话里的读数能差约 38%**（R4 实测 10.8s vs 14.9s），
     * 而 12s 预算正好落在这台机器的噪声带里 ⇒ 单次读数会偶发假红（门禁因此拒包过一次）。
     * 按 R4 的建议：**多次取最小值**（降噪；**不放宽判据** —— 预算仍是 12s）。
     * ⚠️ 2026-11-04：两次仍会假红（全量里量到 17.2s，单跑 10.2s）⇒ 改成 **3 次取最小**。
     * ⚠️ 2026-11-04 晚：3 次取最小后仍连续红（13.7/12.9/14.7 → 17.0/16.0/15.7），而**同一时段的旧版本更慢**
     * （14.5/16.1）⇒ 不是代码退化，是整机变慢（这批读数里 800 行基线同时也从 3.1s 涨到 4.4s）。
     * 绝对挂钟分不清"机器慢"和"我们慢"，所以改成**双判据**：绝对 12s 过，**或** 3000/800 比值 ≤5（同机同时段基线；
     * 旧的二次方实现比值约 14 倍，照样抓得住）。判据没有被放宽 —— 退化依然必然超。 */
    const RUNS = 3;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      await page.goto(origin + '/perf-heavy.html?rows=3000', { waitUntil: 'domcontentloaded', timeout: 25000 });
      const ready = await page.waitForFunction(() => {
        if (document.documentElement.getAttribute('data-kh-state') !== 'on') return false;
        let n = 0;
        CSS.highlights.forEach((hl) => { n += (hl.size !== undefined ? hl.size : 0); });
        return n > 3000;
      }, null, { timeout: 25000 }).then(() => true).catch(() => false);
      runs.push({ ms: Date.now() - t0, ready: ready });
      console.log('        3000 行页面就绪耗时 = ' + runs[runs.length - 1].ms + 'ms（第 ' + (i + 1) + '/' + RUNS + ' 次）');
    }
    const ms = Math.min.apply(null, runs.map((r) => r.ms));
    const ratio = heavy800Ms > 0 ? ms / heavy800Ms : 0;
    const okAbs = ms < 12000;
    const okRel = ratio > 0 && ratio <= 5 && ms < 60000;
    console.log('        判定：min=' + ms + 'ms，800 行基线=' + heavy800Ms + 'ms，比值=' + (ratio ? ratio.toFixed(2) : '-') + ' ⇒ ' + (okAbs ? '绝对预算通过' : (okRel ? '绝对超了、比值正常（机器慢）' : '两条都不过')));
    truthy(runs.every((r) => r.ready), '3000 行页面必须在 25s 内进入高亮态（含 6000+ 命中）');
    truthy(okAbs || okRel, '就绪预算：绝对 12000ms，或 3000/800 比值 ≤5（旧二次方实现约 14 倍）。实际 min=' + ms + 'ms、比值 ' + (ratio ? ratio.toFixed(2) : '-') + '（800 行基线 ' + heavy800Ms + 'ms）' + JSON.stringify(runs));
  });

  /* ★ 2.0.10 体检转常驻预算：空闲时主线程占用。
   * 事故背景：内容兜底检查原来固定每 1000ms 跑一次 `document.body.textContent.length`，
   * 3000 行页面单次约 100ms ⇒ 空闲期每秒一条长任务（5s 内 500–830ms，占 10–16%）。
   * 2.0.10 改成按实测耗时退避（`min(15s, cost × 50)`）后约 140ms/5s。
   * 判据用**绝对预算**而不是比值：这台机器同一份代码的读数噪声约 ±38%（见上面 3000 行那条的历史），
   * 但 140ms 与 500ms 之间余量足够，钉 400ms 既不假红、退化回固定 1s 又必然超。
   * 另一条软判据：空闲期高亮区间数不许自己变 —— 变了说明还有周期性重建，那是同一类退化的另一种形态。 */
  await test('★ 空闲主线程占用（防止「每秒全文拼接」退化）', async () => {
    await page.goto(origin + '/perf-heavy.html?rows=3000', { waitUntil: 'domcontentloaded', timeout: 25000 });
    const on = await page.waitForFunction(() => {
      if (document.documentElement.getAttribute('data-kh-state') !== 'on') return false;
      let n = 0;
      CSS.highlights.forEach((hl) => { n += (hl.size !== undefined ? hl.size : 0); });
      return n > 3000;
    }, null, { timeout: 25000 }).then(() => true).catch(() => false);
    truthy(on, '3000 行页面要先进入高亮态，才谈得上「空闲」占用');

    /* 等首轮收尾：区间数连续 2.5s 不变再开始量，否则量到的是还在渲染的尾巴（会把预算撑爆、
       而且和插件的空闲行为无关）。顺手记这段里区间数变了几次。 */
    let last = -1, stableSince = Date.now(), changes = 0;
    const ranges = () => page.evaluate(() => {
      let c = 0;
      CSS.highlights.forEach((hl) => { c += (hl.size !== undefined ? hl.size : 0); });
      return c;
    });
    while (Date.now() - stableSince < 2500) {
      const n = await ranges();
      if (n !== last) { if (last !== -1) changes++; last = n; stableSince = Date.now(); }
      await page.waitForTimeout(250);
    }

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const read = async () => {
      const m = await cdp.send('Performance.getMetrics');
      const map = {};
      m.metrics.forEach((x) => { map[x.name] = x.value; });
      return map;
    };
    /* 采 4 秒窗口、最多 3 段：这一段容易被「非空闲」的事带偏（这页上还有别的周期活，
       实测同一份代码两段能读到 170ms / 620ms）。判别办法不是"取最小"，而是**只认干净样本**：
       窗口内高亮区间数变过，就说明这段里发生了重建，那段读数测的不是空闲，整段丢掉重采
       （2.0.10 的退避退化是"只读全文长度"，区间数不会变 —— 反证实测关掉退避后 2811ms，照样抓得住）。 */
    const samples = [];
    let min = null;
    for (let i = 0; i < 3 && !min; i++) {
      const r0 = await ranges();
      const a = await read();
      await page.waitForTimeout(4000);
      const b = await read();
      const r1 = await ranges();
      const rec = {
        task: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
        script: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
        dirty: r0 !== r1
      };
      samples.push(rec);
      if (!rec.dirty && (min === null || rec.task < min.task)) min = rec;
    }
    try { await cdp.detach(); } catch (e) { /* 浏览器已在关的时候可能失败，不影响判据 */ }

    console.log('        空闲 4s 样本 = ' + JSON.stringify(samples) +
      '（干净样本取最小 ' + (min ? min.task + 'ms，脚本 ' + min.script + 'ms' : '无') + '）');
    truthy(changes === 0, '空闲期高亮区间数不许自己变（变了说明还在周期性重建），实际变了 ' + changes + ' 次');
    truthy(!!min, '必须至少采到一段干净的空闲样本（3 段里都有重建 ⇒ 插件在周期性重扫，本身就超标）');
    truthy(min && min.task < 400, '★ 空闲 4s 主线程占用预算 400ms（修复前固定每秒全文拼接约 400–560ms，修复后约 150ms），实际 ' +
      (min ? min.task + 'ms ' : '无干净样本 ') + JSON.stringify(samples));
  });

  /* ==================== 图片文字识别（OCR）：图里的字也算命中 ====================
   * 用户诉求：表格里"值是一张截图"时，图里的字也要能命中（老逻辑只看文本节点）。
   * 这里盯四件事：
   *   ① 面板出现「🖼 图片命中」独立分区（**即使这个词没开重要笔记**）；
   *   ② 图里出现关键词 → 命中；图里没有 → 未命中（反向对照，防止"一律标命中"）；
   *   ③ 图片命中**不产生任何文字高亮**（命中注册表 0 条、CSS.highlights 0 个区间）；
   *   ④ 语言包未就绪时是明确报错（lang-missing），不是静默胡识别。
   */
  /* ⓪ 模型准备：把 PP-OCR 三件（det / rec / dict）**在 E2E 里从扩展包内播种**，不走站点下载。
   * 为什么必须播：模型只有「站点 + IDB 缓存」两条路（`offscreen/ocr.js` 的 `ensureModels()` —— 与语言包
   * 不同，它**不接 base 覆盖**），而 harness 每次都是全新 profile（`mkdtemp` + 结束 `rmSync`）
   * ⇒ 每组都要从 moxiaoren.github.io 重下 6.27 MB。出网慢的机器（实测 105 KB/s ⇒ 55–90s）正好撞上
   * 本组的 90s 等待窗，OCR 组**假红**（"识别超时"），看起来像回归其实只是网速。
   * 播种走产品自己的离线正路 `kh:ocr:modelImport`（sha256 + 字节数由产品核、`official` 标记如实回填），
   * 字节取自扩展包内 `release/models/`（与清单 `vendor/ppocr/models-manifest.json` 逐字节一致，
   * `engine-assets.test.js` 单测保证）。一个 profile 只播一次，第二个 OCR 组拿到的是缓存命中。 */
  let OCR_MODELS_SEEDED = false;
  const primeOcrModels = async (startPage) => {
    if (OCR_MODELS_SEEDED) return { skipped: true, files: [] };
    /* 起哪一页由调用方给（组内 `⓪ 模型准备` 那条用例里直接写着 `api.extensionPage(...)`）——
       `tests/specs/e2e-selfcontained.test.js` 的契约是"组内首条用例自己起页"，藏在 helper 里的
       起页它扫不到、整组被判成"借前面组的页面"。所以起页动作必须留在用例文本里。 */
    const page = await startPage();
    const files = await page.evaluate(async () => {
      const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x); }));
      const slots = [
        ['detection', 'PP-OCRv6_tiny_det.onnx'],
        ['recognition', 'PP-OCRv6_tiny_rec.onnx'],
        ['dictionary', 'ppocrv6_tiny_dict.txt']
      ];
      const out = [];
      for (const pair of slots) {
        const buf = await (await fetch(chrome.runtime.getURL('release/models/' + pair[1]))).arrayBuffer();
        const u8 = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        const r = await send({ type: 'kh:ocr:modelImport', slot: pair[0], base64: btoa(bin), name: pair[1] });
        out.push({ slot: pair[0], file: pair[1], bytes: r && r.bytes, official: r && r.official, err: r && r.error });
      }
      return out;
    });
    await page.close();
    OCR_MODELS_SEEDED = true;
    return { skipped: false, files: files };
  };
  const primeOcrModelsTest = async (startPage) => {
    const r = await primeOcrModels(startPage);
    if (r.skipped) return;
    r.files.forEach((f) => truthy(f.bytes && f.official !== false,
      '模型播种失败（' + f.slot + ' / ' + f.file + '）：' + (f.err || 'sha256 与清单不一致（official=false）')
      + ' —— 查 release/models/ 与 vendor/ppocr/models-manifest.json 是否一致'));
  };

  await group('图片文字识别：图里的字也算命中（卡片红框 / 不出高亮 / 区分未命中）', { aspects: ['hit', 'interact', 'ui'] });

  /* 【K75 · 口径作废登记】这一组原来用"核心词**只**在图里"的组合词（`text:'华为'`，图里写着
   * "华为技术有限公司"）来验"图里的字也算命中"。那是 .41 之前的旧口径（OCR 是组合词专属、
   * 标题词定位到那一格就登记锚点，**不看核心词有没有命中**），用户已明确否定：
   * 「判断命中了普通词/组合词没有。如果是，就看抓取字段的内容是否有图片…如果没有命中，
   *   那就不需要考虑图片 ocr 和图片关键词。」
   * 现在改成：**核心词在页面文本里真的命中** → 命中后 OCR 读「字段」值格里的图 →
   * 再用「图片命中关键词」判图里的字。并**保留一条负例**：核心词**只在图里**（页面文本没有）
   * ⇒ **零条目**，哪怕图里就有那个词 —— 这条正是新口径的守门用例。 */
  const OCR_KW = {
    id: 'kE2eOcrHit', text: '交友', note: '', groupId: null, enabled: true,
    caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
    /* 【2.0.2.15】必须开「重要笔记」：抓取字段的内容只长在笔记卡里，红框就挂在卡片那张 <img> 上；
     * `important:false` 的规则根本不建卡 ⇒ 图一个都不在面板里 ⇒ 红框无处可挂（超时真因之一）。 */
    important: true, importantNote: 'OCR 命中验证', impNoteUseHlColor: false, imgSize: '',
    /* 组合词：标题词「应用类型」+ 核心词「交友」在同一行 → **真命中** */
    cellVerifyEnabled: true, cellVerify: '应用类型', comboAxis: 'lr',
    cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
    /* 取图：命中所在表里「应用截图」的值格（`@2` = 标签右起第 2 格，那一格就是图） */
    fetchLabels: '应用截图@2', imgOcr: true, imgOcrMax: '', imgOcrKeyword: '华为'
  };
  const OCR_MISS_KW = Object.assign({}, OCR_KW, {
    id: 'kE2eOcrMiss', text: '验收结论', cellVerify: '客户名称',
    fetchLabels: '客户名称@2', imgOcrKeyword: '验收结论'
  });
  /* 负例（K75 的靶心）：标题词在页面上、**核心词只在图里** ⇒ 这条规则没有命中 ⇒ 零条目 */
  const OCR_NOHIT_KW = Object.assign({}, OCR_KW, {
    id: 'kE2eOcrNoHit', text: '环宇', cellVerify: '不存在词标签',
    fetchLabels: '不存在词标签@2', imgOcrKeyword: '环宇'
  });

  /* ↓↓↓ 三个探针辅助器：必须定义在**这一组所有用例之前**（`const` 有 TDZ，
   * 定义在后面的话前面的用例会 "Cannot access before initialization"）↓↓↓ */

  /* ↓↓↓ 三个探针辅助器：必须定义在**这一组所有用例之前**（`const` 有 TDZ，
   * 定义在后面的话前面的用例会 "Cannot access before initialization"）↓↓↓
   *
   * 【2.0.2.15 用户 m00168】「🖼 图片命中」独立分区整块删除，面板只剩两个显示面：
   *   · 笔记卡片（抓取字段取到的内容，命中的图带红框）
   *   · 最上面那张「截图」表（右键识别进来的图，受理即出现）
   * 所以「图片命中」在界面上的唯一痕迹是**卡片里那张图被套了红框**（`img.khin-imghit`），
   * 而"识别跑完没有"也没法再看面板计数 —— 只能问 background 真实的在飞表。 */

  /** 面板里带红框的图（= 图片命中在界面上的唯一痕迹） */
  const OCR_MARKED = () => {
    const host = document.getElementById('kh-important-note-host');
    const sr = host && host.shadowRoot;
    if (!sr) return [];
    return Array.from(sr.querySelectorAll('img.khin-imghit')).map((el) => ({
      src: el.getAttribute('src') || '',
      title: el.getAttribute('title') || ''
    }));
  };

  /** 已删除的「🖼 图片命中」分区留下的结构 —— 2.0.2.15 起必须一个都没有 */
  const OCR_OLD_SECTION = () => {
    const host = document.getElementById('kh-important-note-host');
    const sr = host && host.shadowRoot;
    if (!sr) return 0;
    return sr.querySelectorAll('.khin-imgsec,.khin-imgitem,.khin-imgtag,.khin-imgall,'
      + '.khin-imgnone,.khin-imgcost,.khin-imgchip').length;
  };

  /** 等识别**落地**（终态：成功/失败/被拒都算）。
   *
   *  判据取 background 的真实在飞表 `self.OcrHost._debug().imageJobs`（`submitImage` 建、`settleJob` 删），
   *  并要求**连续两次**读到 0（避开批量提交之间那一瞬的空当），外加"该出现的红框已经出现"
   *  （`minMarked`，负例传 0）。全绿之前任何一条都不成立就不算完 —— 假绿比假红更贵。
   *
   *  【2.0.2.15】预算从 90s 抬到 150s：真机一次识别（含引擎首启）实测约 25s/张，
   *  两个字段的图合起来 ~50s，再叠上播种/语言包校验的余量，90s 太贴线（假红的另一种来源）。 */
  const OCR_SETTLED = async (timeout, minMarked) => {
    const t0 = Date.now();
    const min = (typeof minMarked === 'number') ? minMarked : 0;
    let zeroStreak = 0;
    for (;;) {
      const inflight = await api.sw.evaluate(() => {
        const d = (self.OcrHost && self.OcrHost._debug) ? self.OcrHost._debug() : null;
        return d ? (d.imageJobs || 0) : 0;
      }).catch(() => -1);
      /* 读不到在飞表（-1）就是探针坏了：宁可立刻红，也不要在循环里空转到超时后报"没识别完" */
      if (inflight < 0) throw new Error('读不到 background 的在飞表（self.OcrHost._debug）—— 真机探针失效');
      const marked = await page.evaluate(OCR_MARKED).then((m) => m.length).catch(() => 0);
      if (inflight === 0 && marked >= min) {
        zeroStreak += 1;
        if (zeroStreak >= 2) {
          /* 结果消息 → 内容脚本 → 面板重画还有一小段异步，给它一拍再交给断言 */
          await new Promise((r) => setTimeout(r, 300));
          return true;
        }
      } else {
        zeroStreak = 0;
      }
      if (Date.now() - t0 > (timeout || 150000)) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await test('⓪ 模型准备：三件本地播种（否则每次都要从站点重下 6.27MB，出网慢＝假红）', () => primeOcrModelsTest(() => api.extensionPage('options/options.html')));

  await test('① 语言包准备（走真实下载+sha256 校验路径；缺资产时明确报错）', async () => {
    const optPage = await api.extensionPage('options/options.html');
    const primed = await optPage.evaluate(async () => {
      const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));
      const base = chrome.runtime.getURL('release/lang');
      const a = await send({ type: 'kh:ocr:langDownload', lang: 'chi_sim', base: base });
      const b = await send({ type: 'kh:ocr:langDownload', lang: 'eng', base: base });
      return { ok: !!(a && a.verified && b && b.verified), err: [(a && a.error), (b && b.error)].filter(Boolean).join(' / ') };
    });
    await optPage.close();
    truthy(primed.ok, '语言包测试资产不可用（release/lang/*.traineddata.gz）—— 先跑 node scripts/fetch-lang.js。引擎返回：' + primed.err);
  });

  /* 【2.0.2.19 需求④】固定样例：软著证书图（用户 m00002 给的那张百度图，`fixtures/ocr-cert-soft-500.jpg`）。
   * 为什么钉这一张：这轮的丢字根因（det 输出一个覆盖整幅的边框框 → 引擎按"平均行高"把它和下面十行并成
   * 一行 → 整图当一行识别得 conf 0.244 乱码 → 被 0.5 置信度闸全丢）**只有它稳定复现**，小图 fixture 都绿。
   * 往后 OCR 问题反馈也优先往这条里加（可淘汰旧的），别再各写一个探针。 */
  await test('②b 固定样例：软著证书图顶部四行不再丢（识别全文 15 行 / 每行带坐标）', async () => {
    const src = origin + '/ocr-cert-soft-500.jpg';
    const optPage = await api.extensionPage('options/options.html');
    let r;
    try {
      r = await optPage.evaluate(async (imgSrc) => {
        const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; res(x); }));
        /* 结果由 background 按 tabId 路由回来 ⇒ **先挂监听再发请求**（反了会漏掉快回来的那一拍）。
         * ⚠️ `kh:ocr:result` 不止一条：流式进度也走这个消息（没有 `text` 字段）。
         * 只认**带字符串 text 的那条**（= 最终回执，与 `_e2e/probe-ocr-cert-2020219.js` 同口径），
         * 早先按"第一条"写，拿到的是进度帧 ⇒ 文本恒为空、断言全红。 */
        const got = new Promise((res) => {
          const onMsg = (m) => {
            if (!m || m.type !== 'kh:ocr:result') return;
            if (typeof m.text !== 'string' && !m.engine) return;
            chrome.runtime.onMessage.removeListener(onMsg);
            res(m);
          };
          chrome.runtime.onMessage.addListener(onMsg);
          setTimeout(() => res({ timeout: true }), 150000);
        });
        const ack = await send({ type: 'kh:ocr:image', src: imgSrc, keyword: '登记号' });
        const out = await got;
        return {
          ack: ack, timeout: !!out.timeout, ok: out.ok, err: out.error,
          text: out.text || '',
          lineList: (out.lineList || []).map((l) => ({ t: l.t, n: (l.cells || []).length }))
        };
      }, src);
    } finally {
      await optPage.close();
    }
    truthy(!r.timeout, '★ 固定样例识别超时（150s）—— 模型/语言包没就绪，或 OCR 链路断了');
    truthy(r.ok, '★ 固定样例识别失败：' + JSON.stringify(r.err || r.ack));
    /* 顶部四行就是这轮丢的那四行：认不出它们 = 归行又被整幅边框框带崩了 */
    ['中华人民共和国国家版权局', '计算机软件著作权登记证书', '证书号', '15947675',
      '软件名称', '众创指购AI智能解梦分析系统', '著作权人', '厦门众创指购科技股份有限公司',
      '2025SR1291477'].forEach((s) => includes(r.text, s, '★ 固定样例识别全文里缺「' + s + '」——顶部四行又丢了'));
    truthy(r.lineList.length >= 12, '识别行数应 ≥12（实测 15），实际 ' + r.lineList.length
      + '；行数骤降通常是归行把整图并成一行了');
    truthy(r.lineList.some((l) => l.n >= 2), '★ 每条 OCR 行要带单元格坐标（需求②⑤ 的表格/双栏靠它）；'
      + '实际 ' + JSON.stringify(r.lineList.slice(0, 3)));
  });

  /* 版面模型在 **Node 侧**算：`img-ocr.js` 只在内容脚本/扩展页里挂 `window.KH`，
   * options 页并没有 `KH.ImgOcr`（实测 `Cannot read properties of undefined (reading 'layout')`）。
   * 它是纯函数、顶层只定义不依赖别的模块，照 `src/core/config.js` 的先例直接 eval。 */
  let _ocrLayoutMod = null;
  const ocrLayoutOf = (lineList) => {
    if (!_ocrLayoutMod) {
      const fs = require('fs');
      const sandbox = {
        window: {},
        document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
      };
      const code = fs.readFileSync(path.join(EXT_DIR, 'src', 'features', 'img-ocr.js'), 'utf8');
      new Function('window', 'document', 'globalThis', code)(sandbox.window, sandbox.document, sandbox);
      _ocrLayoutMod = sandbox.window.KH.ImgOcr;
    }
    const lay = _ocrLayoutMod.layout(lineList);
    return { lay: lay, html: _ocrLayoutMod.layoutHtml(lay) };
  };

  /* 【2.0.2.19 需求⑤】横排两张证书 ⇒ OCR 全文按左右两个单元格展示。
   * 固定样例图（720×500：左 = 计算机软件著作权登记证书，右 = 电子版权链 软件著作权认证证书）。
   * 这条钉的是**版面数据**（每行的 `cells` 坐标 → 列带模型 → 两列），不是识别准确率：
   * 右页小字认不准是识别天花板（属另一件事），但只要左右两页的字落在**同一 y 行**的两格里，
   * 面板/灯箱就该排成左右两格 —— 认成了什么不影响"有没有分对列"。 */
  await test('②b-2 需求⑤：横排两张证书 ⇒ 识别全文排成左右两列（同一行两组字 = 两个单元格）', async () => {
    const src = origin + '/ocr-cert-soft-two-720.jpg';
    const optPage = await api.extensionPage('options/options.html');
    let r;
    try {
      r = await optPage.evaluate(async (imgSrc) => {
        const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; res(x); }));
        /* 与 ②b 同口径：先挂监听再发请求，且只认**带字符串 text 的那条**（流式进度帧没有 text）。 */
        const got = new Promise((res) => {
          const onMsg = (m) => {
            if (!m || m.type !== 'kh:ocr:result') return;
            if (typeof m.text !== 'string' && !m.engine) return;
            chrome.runtime.onMessage.removeListener(onMsg);
            res(m);
          };
          chrome.runtime.onMessage.addListener(onMsg);
          setTimeout(() => res({ timeout: true }), 150000);
        });
        const ack = await send({ type: 'kh:ocr:image', src: imgSrc, keyword: '登记号' });
        const out = await got;
        return {
          timeout: !!out.timeout, ok: out.ok, err: out.error, ack: ack,
          text: out.text || '',
          lineList: (out.lineList || []).map((l) => ({
            t: l.t, y: l.y, x: l.x,
            /* 2.0.6.5 起并排的多份文档会在同一行里被拆成几段（各读各的），整行的原始单元格
             * 由首段的 `cellsAll` 带着 —— 表格排版靠它，所以这里必须原样透传，否则测到的
             * 是"少了一半字段的回执"，与面板拿到的数据不是同一份。 */
            run: l.run, cellsAll: l.cellsAll ? l.cellsAll.map((c) => ({ t: c.t, x: c.x, x2: c.x2 })) : undefined,
            cells: (l.cells || []).map((c) => ({ t: c.t, x: c.x, x2: c.x2 }))
          }))
        };
      }, src);
    } finally {
      await optPage.close();
    }
    truthy(!r.timeout, '★ 横排两张证书识别超时（150s）');
    truthy(r.ok, '★ 横排两张证书识别失败：' + JSON.stringify(r.err || r.ack));
    includes(r.text, '计算机软件著作权登记证书', '左页标题应在识别全文里');
    includes(r.text, '电子版权链', '右页标题应在识别全文里（两页都要认，不能只读左页）');
    const L = ocrLayoutOf(r.lineList);
    const twoSlot = L.lay.rows.filter((x) => (x.cols || []).filter((s) => s && s.trim()).length >= 2).length;
    truthy(L.lay.cols >= 2, '★ 版面必须分出 ≥2 列（左右两张证书），实际 ' + L.lay.cols
      + '；cols=1 说明两页的行被当成一列竖着堆起来了。行数 ' + r.lineList.length);
    truthy(twoSlot >= 2, '★ 至少两行要「同一行两组字」（左右格各一），实际 ' + twoSlot
      + ' 行；rows=' + L.lay.rows.length);
    includes(L.html, 'kh-ocr-table', '★ 全文要渲染成表格（layoutHtml 的产物）');
    includes(L.html, '计算机软件著作权登记证书', '★ 左格文字要进表格');
    includes(L.html, '电子版权链', '★ 右格文字要进表格（同一张表里左右并排）');
  });

  await test('② 抓取字段取图 → 图里命中才套红框；没命中的一张都不许有；全文在大图右栏', async () => {
    await api.setConfig(Object.assign({}, CONFIG, { keywords: [OCR_KW, OCR_MISS_KW, OCR_NOHIT_KW] }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      /* 造表（K75 口径：**核心词在页面文本里真命中**，命中后 OCR 读「字段」值格里的图）：
       *   行1「应用类型 | 交友」                            → OCR_KW 命中（标题词 + 核心同格）
       *   行2「应用截图 | (空) | 图里"华为技术有限公司"」    → OCR_KW 的取图值格（`@2`）⇒ 这张要套红框
       *   行3「客户名称 | 验收结论 | 图里"北京某某贸易公司"」 → OCR_MISS_KW 命中、图里没有该词（不许套红框）
       *   行4「不存在词标签 | (空) | 图里"环宇科技"」        → OCR_NOHIT_KW：**核心词只在图里** ⇒ 零条目 */
      const srcs = await page.evaluate(() => {
        /* 【2.0.2.15】图必须是 **http 图**（`fixtures/ocr-*.png`），不能用画布 dataURL：
         * 抓取表格进笔记前要过 `IMG_PROTOCOL_OK`（只放 http/https），data: 图会被剥掉 ⇒
         * 卡片里根本没有 <img>，红框无处可挂（这就是上一版真机假红的原因）。 */
        const mk = (name) => location.origin + '/' + name;
        const holder = document.createElement('div');
        holder.id = 'e2e-ocr-holder';
        holder.innerHTML =
          '<table><tbody>' +
          '<tr><td>应用类型</td><td>交友</td></tr>' +
          '<tr><td>应用截图</td><td></td><td><img id="e2e-ocr-hit" width="310" height="45" src="' + mk('ocr-hit.png') + '"></td></tr>' +
          '<tr><td>客户名称</td><td>验收结论</td><td><img id="e2e-ocr-miss" width="310" height="45" src="' + mk('ocr-miss.png') + '"></td></tr>' +
          '<tr><td>不存在词标签</td><td></td><td><img id="e2e-ocr-nohit" width="310" height="45" src="' + mk('ocr-nohit.png') + '"></td></tr>' +
          '</tbody></table>';
        document.body.appendChild(holder);
        const pick = (id) => {
          const el = document.getElementById(id);
          return el ? (el.getAttribute('src') || '') : '';
        };
        return { hit: pick('e2e-ocr-hit'), miss: pick('e2e-ocr-miss'), nohit: pick('e2e-ocr-nohit') };
      });

      await openFloat();   // 唯一形态：悬窗，红框只在浮窗卡片里
      /* 等识别**落地**（成功/失败都算）+ 红框出现：不能再按面板行等（分区已删），
       * 判据见 `OCR_SETTLED`（background 在飞表归零 + 红框已出现）。 */
      const settled = await OCR_SETTLED(150000, 1);
      if (!settled) {
        const live = {
          marked: await page.evaluate(OCR_MARKED).catch((e) => String(e && e.message)),
          oldSection: await page.evaluate(OCR_OLD_SECTION).catch(() => -1)
        };
        throw new Error('90s 内没等到「识别落地 + 红框出现」。现场取证：' + JSON.stringify(live));
      }

      const marked = await page.evaluate(OCR_MARKED);
      eq(marked.length, 1, '★ 只有「华为」那一张该套红框（未命中 / 没命中的图一张都不许套）；实际：'
        + JSON.stringify(marked.map((m) => m.title)));
      eq(marked[0].src, srcs.hit, '★ 红框要挂在抓取字段取到的那张图上（不是随便一张）');
      includes(marked[0].title, '华为', '红框的悬停说明要带出命中的词（文案走 KH.OcrCopy 真源）');
      eq(await page.evaluate(OCR_OLD_SECTION), 0,
        '★ 2.0.2.15 起「🖼 图片命中」独立分区整块删除（用户 m00168）：面板里不许再有这些结构');
      await shot(page, 'e2e-ocr-marked');

      /* ★ 全文的落脚点（用户 m00631 口径）：点带红框的图开大图 → **右侧**显示整段识别文本。
       * 面板已经不铺这段文字，所以这是"识别结果还能看到"的唯一去处 —— 必须端到端验。
       * 顺带把 2.0.2.1 需求 4 的口径钉住：默认可见、眼睛按钮双向开关、栏内可一键复制。 */
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin });
      const lb = await page.evaluate(async () => {
        const host = document.getElementById('kh-important-note-host');
        const img = host && host.shadowRoot && host.shadowRoot.querySelector('img.khin-imghit');
        if (!img) return { err: '面板里没有套红框的图（红框没落到卡片里）' };
        img.click();
        await new Promise((r) => setTimeout(r, 120));
        const box = document.getElementById('kh-note-lightbox');
        const sr = box && box.shadowRoot;
        if (!sr) return { err: '灯箱没建出来（点红框图没打开大图）' };
        const pane = sr.querySelector('.kh-lb-side');
        const eye = sr.querySelector('.kh-lb-sidebtn');
        const copy = sr.querySelector('.kh-lb-copy');
        if (!pane || !eye) return { err: '灯箱结构缺件（.kh-lb-side / .kh-lb-sidebtn）' };
        const read = () => ({
          hidden: !!pane.hidden,
          text: (sr.querySelector('.kh-lb-side-t') || {}).textContent || '',
          head: (sr.querySelector('.kh-lb-side-h') || {}).textContent || '',
          eyeHidden: !!eye.hidden,
          eyeText: eye.textContent || ''
        });
        const before = read();
        eye.click();
        await new Promise((r) => setTimeout(r, 80));
        const after = read();
        eye.click();
        await new Promise((r) => setTimeout(r, 80));
        const again = read();
        const copyOk = !!(copy && !copy.hidden);
        let clip = '';
        if (copyOk) {
          copy.click();
          await new Promise((r) => setTimeout(r, 300));
          clip = await navigator.clipboard.readText().catch((e) => 'err:' + (e && e.message));
        }
        sr.querySelector('.kh-lb').click();       // 点容器外 = 关灯箱，别留给后面的用例
        return { err: null, before: before, after: after, again: again, copyOk: copyOk, clip: clip };
      });
      truthy(!lb.err, '开大图取证失败：' + JSON.stringify(lb));
      truthy(lb.before.hidden === false,
        '★ 全文栏**默认可见**（需求 4："默认在大图容器右侧并排展示"；面板已把整段文本搬走，这里是唯一去处）：'
        + JSON.stringify(lb.before));
      includes(lb.before.text, '华为', '★ 默认可见时内容已就位（全文栏文本 = 该图识别出的整段文字）');
      eq(lb.before.head, '识别出的文字', '全文栏标题走唯一真源 KH.OcrCopy（面板/灯箱都不许自己写中文）');
      truthy(lb.before.eyeHidden === false, '★ 有识别文本 ⇒ 工具条上那枚按钮必须可见');
      eq(lb.before.eyeText, '隐藏全文', '有文本时按钮是「隐藏全文」（即用户说的"展示/隐藏全文那个位置"）');
      truthy(lb.after.hidden === true, '★ 点一下 ⇒ 全文栏收起');
      eq(lb.after.eyeText, '显示全文', '收起后按钮换成「显示全文」');
      truthy(lb.again.hidden === false, '★ 再点 ⇒ 弹回来（开关双向，否则收起就取不回来）');
      truthy(lb.copyOk, '全文栏里要有一键复制（识别结果取走的正路）');
      includes(String(lb.clip), '华为', '★ 一键复制要真的把全文写进剪贴板；实际 ' + JSON.stringify(String(lb.clip).slice(0, 80)));

      /* 文字高亮：命中驱动之后，**真命中**的核心词照旧有高亮（2 处），
       * 但「图片命中」本身绝不产生额外区间（识别出来的字不在 DOM 里）。 */
      const info = await page.evaluate(PROBE);
      eq(info.ranges, 2, '高亮区间 = 页面文本里真命中的两处（图片命中不产生额外高亮），实际 ' + info.ranges);
      eq(info.pluginNodes, 0, '不得往页面 DOM 里塞高亮节点');
    } finally {
      /* 【必须放 finally】这一组改了共享配置；断言失败若直接抛出，后面所有组都会拿着
       * 这一组的配置跑（实测踩过：options 的两条 tb 用例因此整片变红）。 */
      await api.setConfig(CONFIG);
    }
  });

  /* 【2.0.2.19 需求③】动态判据的真机验收：「还需图上有」点名的抓取字段，它的值也得出现在图上。
   * 为什么这条非上真机不可：判据横跨五层（字段表 → 清洗白名单 → Config.normalize → compiler meta → img-ocr
   * 的 judge），单测只能钉住最后那段纯函数；中间配错一层，表现就是"设置页有这一格、实际上毫不生效"。
   * 代价说明：一张图、两次判定，OCR 只跑一次（同 src 走内容侧缓存），第二次判定靠缓存文本重算。 */
  await test('②c 需求③：点名的抓取字段值在图上 ⇒ 命中；改成图上没有的值 ⇒ 立刻不命中', async () => {
    /* 刻意**不填**「图片命中关键词」：用户给的原例就只点名抓取字段（姓名、截图）——
     * 这条也顺带钉住 Config.normalize 的判据放宽（只认关键词的老代码会把这条规则静默关掉）。 */
    const DYN_KW = Object.assign({}, OCR_KW, {
      id: 'kE2eOcrDyn', text: '客户名称', cellVerifyEnabled: false, cellVerify: '',
      fetchLabels: '客户名称', imgOcrKeyword: '', imgOcrNeed: '客户名称',
      importantNote: '动态判据验证'
    });
    const settle = async (wantMarked, timeout) => {
      const t0 = Date.now();
      let streak = 0;
      for (;;) {
        const inflight = await api.sw.evaluate(() => {
          const d = (self.OcrHost && self.OcrHost._debug) ? self.OcrHost._debug() : null;
          return d ? (d.imageJobs || 0) : -1;
        }).catch(() => -1);
        if (inflight < 0) throw new Error('读不到 background 的在飞表（self.OcrHost._debug）');
        const n = await page.evaluate(OCR_MARKED).then((m) => m.length).catch(() => -1);
        if (inflight === 0 && n === wantMarked) {
          if (++streak >= 2) { await page.waitForTimeout(300); return true; }
        } else streak = 0;
        if (Date.now() - t0 > timeout) return false;
        await page.waitForTimeout(250);
      }
    };
    await api.setConfig(Object.assign({}, CONFIG, { keywords: [DYN_KW] }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      const dyn = await page.evaluate(() => {
        const img = location.origin + '/ocr-hit.png';
        const holder = document.createElement('div');
        holder.id = 'e2e-ocr-dyn-holder';
        /* 文字与图必须落在**同一个值格**里：
         * `Fetch.cellsForHit` 对一个不带 `@表达式` 的标签只取右邻那一格（值格），
         * 图放在再往右一格就取不到（实测：`cells=1 / imgs=0` ⇒ 条目一个都不建、识别不发起）。
         * 这也正是真实场景的形状：一个单元格里既有文字、又贴着一张截图。 */
        holder.innerHTML = '<table><tbody><tr><td>客户名称</td>'
          + '<td><span id="e2e-ocr-dyn-val">华为技术有限公司</span>'
          + '<img id="e2e-ocr-dyn" width="310" height="45" src="' + img + '"></td></tr></tbody></table>';
        document.body.appendChild(holder);
        return img;
      });
      await openFloat();   // 四态：红框挂在浮窗卡片里
      truthy(await settle(1, 120000), '★ 抓取到的值「华为技术有限公司」就在图上 ⇒ 必须命中（面板该有一张红框）');
      const marked = await page.evaluate(OCR_MARKED);
      eq(marked.length, 1, '★ 只该有一张红框；实际 ' + JSON.stringify(marked.map((m) => m.title)));
      eq(marked[0].src, dyn, '★ 红框要挂在那一行的图上');
      includes(marked[0].title, '华为技术有限公司',
        '★ 命中词就是**抓取字段的值本身**（这条规则没填「图片命中关键词」）；实际 ' + JSON.stringify(marked[0].title));
      /* 把值改成图上没有的 ⇒ 同一条规则、同一张图（走缓存文本重算）立刻不命中。
       * 只改那一段文字、**别清掉值格**（`td.textContent = ...` 会把图一起冲掉，
       * 那就变成"没图可认"而不是"图上没有这个值"，验的东西就串了）。 */
      await page.evaluate(() => {
        const span = document.getElementById('e2e-ocr-dyn-val');
        if (span) span.textContent = '北京某某贸易公司';
      });
      truthy(await settle(0, 30000), '★ 值改成图上没有的 ⇒ 必须立刻不命中（红框消失）');
      eq((await page.evaluate(OCR_MARKED)).length, 0, '★ 动态判据否定了这次命中');
    } finally {
      await api.setConfig(CONFIG);
    }
  });
  /* ==================== 图片命中 = 「抓取后续字段」的一个分支（用户确认的新口径） ====================
   * 三条必须同时成立，缺一条这个功能就是错的：
   *   ① 触发用"谁命中就用谁所在行" —— **普通词也能用**（不再限组合词）；
   *   ② 取图范围 = 该行里**所有已配置抓取字段的值格**（值格指向走 `fetchLabels` 的 `@表达式`），
   *      不管字段有没有 `#图` 修饰；
   *   ③ 匹配口径 = 「图片命中关键词」当**正则**（不全词、不区分大小写），且**不回落**规则核心词；
   *      识别结果只进「🖼 图片命中」分区 —— **绝不写进抓取内容**。
   * 负例（把关键词换成图里根本没有的词）同样要盯：不许"一律标命中"。
   */
  await group('图片命中：普通词 + 抓取字段取图（@值格 / 命中 / 不污染抓取内容 / 负例）', { aspects: ['hit', 'fetch', 'interact'] });

  /** 普通词「交友」+ 抓取字段「应用截图@2|备注」+ 图片命中关键词（正则）—— 用户给的装置就是这一套 */
  const OCR_PLAIN_KW = (ocrWord) => ({
    id: 'kE2eOcrPlain', text: '交友', note: '', groupId: null, enabled: true,
    caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
    important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
    cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
    cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
    /* `@2` = 标签格右边第 2 格才是值格（与 cellOffset 同语法）——真浏览器里也走这条路；
     * `备注` 是"有文字的抓取字段"，用来验证识别文本**不会**混进抓取内容。 */
    fetchLabels: '应用截图@2|备注', imgOcr: true, imgOcrMax: '', imgOcrKeyword: ocrWord
  });

  /** 装置：一行「应用类型 | 交友」+ 一行「应用类型 | 其它」+ 一行「应用截图 | (空格) | 图上写着"一对一安心对话"」
   *  【2.0.2.15】图用 **http 图**（`fixtures/ocr-pair.png`）：抓取表格进笔记前要过 `IMG_PROTOCOL_OK`
   *  （只放 http/https），画布 dataURL 会被剥掉 ⇒ 卡片里没有 <img> ⇒ 红框无处可挂。 */
  const OCR_DEVICE = () => {
    const mk = (name) => location.origin + '/' + name;
    const holder = document.createElement('div');
    holder.id = 'e2e-ocr-fetch-holder';
    holder.innerHTML = '<table><tbody>' +
      '<tr><td>应用类型</td><td id="e2e-ocr-plain-hit">交友</td></tr>' +
      '<tr><td>应用类型</td><td>其它</td></tr>' +
      '<tr><td>应用截图</td><td></td><td><img id="e2e-ocr-fetch-img" width="310" height="45" src="' + mk('ocr-pair.png') + '"></td></tr>' +
      '<tr><td>备注</td><td>甲备注内容</td></tr>' +
      '</tbody></table>';
    document.body.appendChild(holder);
  };

  await test('⓪ 模型准备：三件本地播种（组 1 已播则直接复用；本组可被 --aspects=fetch 单独选中）', () => primeOcrModelsTest(() => api.extensionPage('options/options.html')));

  /* 【2.0.2.15 用户 m00168】独立的「🖼 图片命中」分区删除 ⇒ 这两条按新形态重写：
   *   · "命中" 不再有行/标签/词块可查，界面上的唯一痕迹是**卡片里那张图套了红框**（`img.khin-imghit`），
   *     红框的悬停说明带出命中的词（`KH.OcrCopy.VIEW.imgHitTip`）；
   *   · "未命中" 就是**没有红框**，但那张图的识别全文仍然取得回来（点开大图，右栏显示）。
   * 原来这里还有两条只服务旧分区的用例，已随分区删除：
   *   · 「同页 9 张图：并发上限之外的第 5 张起必须被补发」⇒ 补发逻辑（`pump()` / `MAX_INFLIGHT`）
   *     由 `tests/specs/img-ocr.test.js` 的纯逻辑用例钉住（浏览器里 9 张图跑满一轮要几分钟，
   *     真机只需要证明"这一页确实全部落地"，已由本组的 `OCR_SETTLED` 覆盖）；
   *   · 「K80：收起只在同一批条目内被记住」⇒ 收起/展开这个概念本身随分区消失了，没有可测的行为。 */

  await test('★ 普通词命中 → 按抓取字段取图 → 图里命中「一对一」就套红框；识别文本**不进抓取内容**', async () => {
    await api.setConfig(Object.assign({}, CONFIG, { keywords: [OCR_PLAIN_KW('一对一')] }));
    try {
      /* 新开一页：`hidden-hit.html` 本身没有关键词，命中完全由下面的装置决定 */
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await page.evaluate(OCR_DEVICE);
      await openFloat();   // 唯一形态：悬窗，卡片与红框只在浮窗里

      const settled = await OCR_SETTLED(150000, 1);
      if (!settled) {
        const dump = {
          marked: await page.evaluate(OCR_MARKED).catch((e) => String(e && e.message)),
          oldSection: await page.evaluate(OCR_OLD_SECTION).catch(() => -1)
        };
        throw new Error('90s 内没等到「识别落地 + 红框出现」（普通词 + 抓取字段取图）。现场：' + JSON.stringify(dump));
      }
      const marked = await page.evaluate(OCR_MARKED);
      eq(marked.length, 1, '★ 图里写着"一对一安心对话" ⇒ 恰好一张图套红框；实际：' + JSON.stringify(marked.map((m) => m.title)));
      includes(marked[0].title, '一对一', '红框的悬停说明要带出「图片命中关键词」（真源 KH.OcrCopy.VIEW.imgHitTip）');
      eq(await page.evaluate(OCR_OLD_SECTION), 0, '★ 旧分区结构一个都不许回来');

      /* 【不污染抓取内容】面板的抓取表格里绝不能出现识别出来的文字 */
      const fetched = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table-fetch');
        return t ? t.textContent : '';
      });
      truthy(fetched.length > 0, '装置不成立：普通词 + fetchLabels 的抓取表格没出现（后面两条断言就没意义了）');
      includes(fetched, '甲备注内容', '抓取内容应含「备注」字段的值（装置成立的前提）');
      falsy(fetched.indexOf('一对一') >= 0, '识别结果绝不能写进抓取内容，实际抓取内容：' + JSON.stringify(fetched.slice(0, 200)));
      falsy(fetched.indexOf('安心对话') >= 0, '识别结果绝不能写进抓取内容');

      /* 【大图里能看到全文】点红框图 → 右栏整段文字（面板不再铺这段文字，这是唯一去处） */
      const paneText = await page.evaluate(async () => {
        const host = document.getElementById('kh-important-note-host');
        const img = host && host.shadowRoot && host.shadowRoot.querySelector('img.khin-imghit');
        if (!img) return '';
        img.click();
        await new Promise((r) => setTimeout(r, 120));
        const box = document.getElementById('kh-note-lightbox');
        const sr = box && box.shadowRoot;
        const pane = sr && sr.querySelector('.kh-lb-side');
        const text = (sr && sr.querySelector('.kh-lb-side-t') || {}).textContent || '';
        if (sr) sr.querySelector('.kh-lb').click();
        return (pane && !pane.hidden) ? text : '';
      });
      includes(paneText, '一对一', '★ 点开大图后右栏应显示这张图的识别全文（默认可见）');
      await shot(page, 'e2e-ocr-fetch-hit');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  await test('★ 负例：图片命中关键词换成图里没有的词 → 一张图都不许套红框（但全文仍取得到）', async () => {
    await api.setConfig(Object.assign({}, CONFIG, { keywords: [OCR_PLAIN_KW('不存在的词')] }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await page.evaluate(OCR_DEVICE);
      await openFloat();   // 四态：卡片与红框只在浮窗里
      /* 先等到"识别落地"（图确实被识别过了）—— 否则等于"还没跑就说没命中" */
      const settled = await OCR_SETTLED(150000, 0);
      truthy(settled, '负例装置也要先跑完识别（在飞表归零），否则断言不成立');
      const marked = await page.evaluate(OCR_MARKED);
      eq(marked.length, 0, '★ 图里没有"不存在的词" ⇒ 一张图都不许套红框；实际：' + JSON.stringify(marked.map((m) => m.title)));
      /* 【全文仍取得到】没命中 ≠ 没识别：点开大图右栏照样是这张图的全文 */
      const paneText = await page.evaluate(async () => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table-fetch img');
        if (!t) return '';
        t.click();
        await new Promise((r) => setTimeout(r, 120));
        const box = document.getElementById('kh-note-lightbox');
        const sr = box && box.shadowRoot;
        const pane = sr && sr.querySelector('.kh-lb-side');
        const text = (sr && sr.querySelector('.kh-lb-side-t') || {}).textContent || '';
        if (sr) sr.querySelector('.kh-lb').click();
        return (pane && !pane.hidden) ? text : '';
      });
      includes(paneText, '一对一', '未命中只是"不标命中"，识别全文照样在大图右栏里（那是可取走的识别结果）');
      await shot(page, 'e2e-ocr-fetch-miss');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ==================== 2.0.2.15 需求①②：右键受理即展示 + 大图里一键 OCR ====================
   * 这两条的核心都是"**受理那一刻**就要有反应"，所以装置不能等真实 OCR（要 30–90s）：
   * background 受理右键时发的就是 `MSG.OCR_QUEUED`，识别完发的是 `MSG.OCR_RESULT`，
   * 这里**从 SW 侧用 chrome.tabs.sendMessage 把同一对消息送给内容脚本** —— 走的是产品自己的
   * 消息契约与路由（浏览器自动化点不了原生右键菜单，这是唯一可靠的人工装置）。
   * 断言盯三件事：①「截图」卡在受理那一刻就出现（带"识别中"）；② 点开大图是「OCR 识别」按钮；
   * ③ 结果回来后就地换成「隐藏全文」并且右栏有全文。 */
  await test('★ 右键受理即出「截图」卡、大图里一键 OCR：没文本是「OCR 识别」，识别完换成隐藏/显示全文', async () => {
    await api.setConfig(Object.assign({}, CONFIG, { keywords: [] }));
    let lightboxOpen = false;
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      const src = origin + '/ocr-ctx.png';
      const tabId = await api.sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.filter((x) => String(x.url || '').indexOf('hidden-hit.html') >= 0)[0];
        return t ? t.id : null;
      });
      truthy(tabId != null, '找不到承载页的 tabId（真机装置不成立）');
      const toTab = (msg) => api.sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m)
        .then(() => 'ok', (e) => 'err:' + (e && e.message)), [tabId, msg]);

      /* ①：受理回执 ⇒ 「截图」卡**当场**出现（这时一个字都还没识别出来） */
      eq(await toTab({ type: 'kh:ocr:queued', requestId: 'e2e-ctx-1', src: src, via: 'contextMenu' }),
        'ok', '★ background 的受理回执要能送到发起页（送不到 = 右键完屏幕上什么都不发生）');
      await openFloat();   // 四态：截图卡挂在浮窗里
      const card = await page.waitForFunction(() => {
        const host = document.getElementById('kh-important-note-host');
        const sr = host && host.shadowRoot;
        const cell = sr && sr.querySelector('.khin-ctx-cell');
        const im = cell && cell.querySelector('img');
        if (!im) return false;
        const badge = sr.querySelector('.khin-ctxstate');
        const label = sr.querySelector('.khin-item-ctx .kh-lbt');
        return {
          src: im.getAttribute('src'),
          badge: badge ? (badge.textContent || '') : '',
          label: label ? (label.textContent || '') : ''
        };
      }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
      truthy(card, '★ 受理那一刻面板里就该出现那张「截图」卡（用户 m00168：右键完立刻就要看得见图）');
      eq(card.src, src, '卡里的图就是刚右键的那张');
      eq(card.label, '截图', '左格标题是「截图」（文案真源 KH.OcrCopy.VIEW.ctxShotLabel）');
      includes(card.badge, '识别中', '还没识别完 ⇒ 标题格里要写"识别中"，别让用户以为识别没跑');

      /* ②：点开大图 ⇒ 没有文本 ⇒ 按钮是「OCR 识别」（就在原来"隐藏/显示全文"那个位置） */
      const before = await page.evaluate(async () => {
        const host = document.getElementById('kh-important-note-host');
        const im = host.shadowRoot.querySelector('.khin-ctx-cell img');
        im.click();
        await new Promise((r) => setTimeout(r, 150));
        const box = document.getElementById('kh-note-lightbox');
        const sr = box && box.shadowRoot;
        if (!sr) return { err: '点「截图」卡里的图没打开大图' };
        const btn = sr.querySelector('.kh-lb-sidebtn');
        const pane = sr.querySelector('.kh-lb-side');
        return {
          err: null,
          btnHidden: !btn || !!btn.hidden,
          btnText: btn ? (btn.textContent || '') : '',
          paneHidden: !pane || !!pane.hidden
        };
      });
      truthy(!before.err, '开大图失败：' + JSON.stringify(before));
      lightboxOpen = true;
      truthy(before.btnHidden === false, '★ 没识别过的图也有按钮（大图里一键 OCR 的入口必须常驻）');
      eq(before.btnText, 'OCR 识别', '没文本时按钮就是「OCR 识别」；实际 ' + JSON.stringify(before.btnText));
      truthy(before.paneHidden === true, '没文本时右侧全文栏不摆空栏');

      /* ③：识别结果回来 ⇒ 同一枚按钮就地换成「隐藏全文」，右栏出现全文（不用关掉重开） */
      eq(await toTab({
        type: 'kh:ocr:result', requestId: 'e2e-ctx-1', ok: true, src: src,
        text: '右键识别装置 X9001\n第二行识别内容', confidence: 0.93, ocrMs: 800, via: 'contextMenu'
      }), 'ok', '识别结果要能送到发起页');
      const after = await page.waitForFunction(() => {
        const box = document.getElementById('kh-note-lightbox');
        const sr = box && box.shadowRoot;
        const btn = sr && sr.querySelector('.kh-lb-sidebtn');
        const pane = sr && sr.querySelector('.kh-lb-side');
        if (!btn || !pane || pane.hidden) return false;
        return {
          btnText: btn.textContent || '',
          paneText: (sr.querySelector('.kh-lb-side-t') || {}).textContent || '',
          badge: (document.getElementById('kh-important-note-host').shadowRoot
            .querySelector('.khin-ctxstate') || {}).textContent || ''
        };
      }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
      truthy(after, '★ 识别结果回来后：按钮要换成「隐藏全文」且右栏显示全文（灯箱开着也要跟着刷）');
      eq(after.btnText, '隐藏全文', '识别成功后按钮就是原来的「隐藏全文」；实际 ' + JSON.stringify(after.btnText));
      includes(after.paneText, 'X9001', '右栏是这张图的识别全文');
      eq(after.badge, '', '识别完成后「识别中」标记要消失（截图卡原地更新）');

      /* 收起/展开仍然是原来那枚按钮的活（双职不能把老功能弄丢） */
      const toggled = await page.evaluate(async () => {
        const sr = document.getElementById('kh-note-lightbox').shadowRoot;
        const btn = sr.querySelector('.kh-lb-sidebtn');
        const pane = sr.querySelector('.kh-lb-side');
        btn.click();
        await new Promise((r) => setTimeout(r, 80));
        const hidden = !!pane.hidden;
        const text = btn.textContent || '';
        btn.click();
        await new Promise((r) => setTimeout(r, 80));
        const back = !pane.hidden;
        sr.querySelector('.kh-lb').click();       // 关灯箱，别留给后面的用例
        return { hidden: hidden, text: text, back: back };
      });
      lightboxOpen = false;
      truthy(toggled.hidden === true, '★ 有文本后这枚按钮照旧能收起全文栏');
      eq(toggled.text, '显示全文', '收起后换「显示全文」');
      truthy(toggled.back === true, '再点能弹回来（开关双向）');

      /* 同一张图再右键一次：卡片里仍只有一张图（按 src 去重）、没有重复条目 */
      eq(await toTab({ type: 'kh:ocr:queued', requestId: 'e2e-ctx-2', src: src, via: 'contextMenu' }),
        'ok', '第二次右键也要能受理');
      const dup = await page.waitForFunction(() => {
        const sr = document.getElementById('kh-important-note-host').shadowRoot;
        const imgs = sr.querySelectorAll('.khin-ctx-cell img');
        return imgs.length === 1 ? { n: imgs.length } : { n: imgs.length, wait: true };
      }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => ({ n: -1 }));
      eq(dup.n, 1, '同一张图右键两次，卡片里仍只有一张图（按 src 去重）；实际 ' + JSON.stringify(dup));
      await shot(page, 'e2e-ctx-lightbox-ocr');
    } finally {
      if (lightboxOpen) {
        await page.evaluate(() => {
          const box = document.getElementById('kh-note-lightbox');
          const sr = box && box.shadowRoot;
          if (sr) sr.querySelector('.kh-lb').click();
        }).catch(() => {});
      }
      await api.setConfig(CONFIG);
    }
  });

  await group('变更相关性：无关变动不重建 / 抓取字段变化只刷面板 / 拆词慢填必须重建', { aspects: ['hit', 'interact'] });

  const REL_PLAIN = {
    id: 'kE2eRelPlain', text: '华为', note: '', groupId: null, enabled: true,
    caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
    important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
    cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
    cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: ''
  };
  const REL_FETCH = Object.assign({}, REL_PLAIN, {
    id: 'kE2eRelFetch', cellVerifyEnabled: true, cellVerify: '供应商', important: true, fetchLabels: '备注'
  });

  await test('★ 无关变动不重渲染 / 抓取字段变只刷面板 / 加词与拆词慢填照旧重建', async () => {
    await api.setConfig(Object.assign({}, CONFIG, {
      keywords: [REL_PLAIN, REL_FETCH],
      pageRebuildSilentMs: 120, pageRebuildGapMs: 0
    }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      /* 装置：真实表格（标签格 / 命中格 / 字段名格 / 字段值格） */
      await page.evaluate(() => {
        const holder = document.createElement('div');
        holder.id = 'e2e-rel';
        holder.innerHTML = '<table><tbody><tr>' +
          '<td>供应商</td><td id="e2e-rel-kw">华为技术有限公司</td>' +
          '<td>备注</td><td id="e2e-rel-field">初值</td></tr></tbody></table>';
        document.body.appendChild(holder);
      });
      await openFloat();   // 四态：面板内容要切到浮窗才有 .kh-table
      /* 面板要真的抓到"初值"才算装置成立 */
      const okPanel = await page.waitForFunction(() => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table');
        return !!(t && /初值/.test(t.textContent || ''));
      }, null, { timeout: 30000 }).then(() => true).catch(() => false);
      truthy(okPanel, '面板没抓到字段值，装置不成立（后面的判据都没意义）');

      /* 高亮组对象身份快照：不变 = 没重渲染 */
      const snap = () => page.evaluate(() => {
        window.__relHl = window.__relHl || {};
        const out = [];
        CSS.highlights.forEach((hl, name) => { window.__relHl[name] = hl; out.push(name); });
        return out.map((n) => window.__relHl[n] === CSS.highlights.get(n));
      });
      const before = await snap();
      truthy(before.length > 0, '至少应有一个高亮组（装置里"华为"应命中）');

      /* ① 无关变动（不含任何关键词前缀）→ 不得重渲染 */
      await page.evaluate(() => { const p = document.createElement('p'); p.textContent = '今日天气晴朗'; document.body.appendChild(p); });
      await page.waitForTimeout(1000);
      const afterNoise = await snap();
      eq(JSON.stringify(afterNoise), JSON.stringify(before), '无关变动不得重渲染高亮（P1：skip）');

      /* ② 命中所在表格里、不含关键词的字段值变了 → 只刷面板，高亮对象不变 */
      await page.evaluate(() => { document.getElementById('e2e-rel-field').textContent = '改过的值'; });
      await page.waitForTimeout(1000);
      const afterField = await snap();
      eq(JSON.stringify(afterField), JSON.stringify(before), '只有抓取字段变时不得重渲染高亮（P2：仅消费）');
      const panelText = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('table.kh-table');
        return t ? (t.textContent || '').replace(/\s+/g, ' ').trim() : '';
      });
      includes(panelText, '改过的值', '面板必须跟着刷新（这正是"仅消费"存在的理由）');

      /* ③ 新增文本里出现关键词 → 必须重建，并且**新加的那个词真的被高亮**。
       * 【为什么不用"高亮对象身份变了"当判据】Renderer 对"范围完全相同的组"可能跳过重建
       * （避免无谓抖动），对象身份因此不是"是否重建"的可靠信号；真正要保证的是**结果**：
       * 新出现的词必须在页面上有高亮。 */
      await page.evaluate(() => { const d = document.createElement('div'); d.id = 'e2e-rel-add'; d.textContent = '又一家华为分公司'; document.body.appendChild(d); });
      await page.waitForFunction(() => {
        const el = document.getElementById('e2e-rel-add');
        if (!el) return false;
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits > 0;
      }, null, { timeout: 15000 }).then(() => true).catch(() => false);
      const added = await page.evaluate(() => {
        const el = document.getElementById('e2e-rel-add');
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits;
      });
      truthy(added > 0, '新增文本里的关键词必须被高亮（P1 判 full，不能因为"变化的那段文本"判据写窄了而漏掉）');

      /* ④ 值慢慢填 / 词被拆开：后一半后到 → 必须重建并且真的高亮出来 */
      await page.evaluate(() => {
        const h = document.createElement('div');
        h.id = 'e2e-rel-split';
        h.innerHTML = '<table><tbody><tr><td>供应商</td>' +
          '<td><span id="e2e-sp-a">华</span><span id="e2e-sp-b"></span></td></tr></tbody></table>';
        document.body.appendChild(h);
      });
      await page.waitForTimeout(900);
      const beforeSplit = await page.evaluate(() => {
        const cell = document.querySelector('#e2e-rel-split td:nth-child(2)');
        const nodes = []; const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits;
      });
      eq(beforeSplit, 0, '只填了"华"时不该有命中（装置前提）');
      await page.evaluate(() => { document.getElementById('e2e-sp-b').textContent = '为'; });
      await page.waitForTimeout(1200);
      const afterSplit = await page.evaluate(() => {
        const cell = document.querySelector('#e2e-rel-split td:nth-child(2)');
        const nodes = []; const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits;
      });
      truthy(afterSplit > 0, '值后到 / 词被拆开时必须重建并高亮出来（P1 的判据要靠"格子整段文本"兜住）');
      await shot(page, 'e2e-relevance');
    } finally {
      await api.setConfig(CONFIG);      // 共享配置必须还原（否则后面的组会拿着这组关键词跑）
    }
  });

  /* ==================== 属性观察：显隐变化必须触发重建（K55） ====================
   * 病根：折叠展开 / 抽屉拉开 / Tab 切换 / `hidden` 去掉，都是**属性变化**，不产生 childList/characterData。
   * 这条用例是属性观察存在的唯一理由，序列与 `_e2e/probe-reveal.js` 一致：
   *   藏着不高亮 → 只改 style 显出来必须高亮 → 再藏起来必须把命中收掉 → style 被删除也必须能重建。
   */
  await group('属性观察：隐藏的内容显出来后必须补上高亮（K55）', { aspects: ['hit'] });

  await test('★ 藏 → 显（改 style）→ 藏 → 删 style：四个阶段的高亮数必须跟着变', async () => {
    await api.setConfig(Object.assign({}, CONFIG, {
      keywords: [REL_PLAIN],
      pageRebuildSilentMs: 120, pageRebuildGapMs: 0
    }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'e2e-reveal';
        d.style.display = 'none';                       // 先藏着（扫描按可见性剪枝，不该命中）
        d.textContent = '华为技术有限公司';
        document.body.appendChild(d);
      });
      /* 等它稳下来（注入那一轮重建完成） */
      const hitsIn = () => page.evaluate(() => {
        const el = document.getElementById('e2e-reveal');
        if (!el) return -1;
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        if (typeof CSS !== 'undefined' && CSS.highlights) {
          CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        }
        return hits;
      });
      const waitHits = (want, tag) => page.waitForFunction((n) => {
        const el = document.getElementById('e2e-reveal');
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let x; while ((x = w.nextNode())) nodes.push(x);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return n === 0 ? hits === 0 : hits > 0;
      }, want, { timeout: 15000 }).then(() => true).catch(() => false);

      await page.waitForTimeout(900);
      eq(await hitsIn(), 0, '① 藏着的时候不该有命中（可见性剪枝的前提）');

      await page.evaluate(() => { document.getElementById('e2e-reveal').style.display = 'block'; });
      truthy(await waitHits(1, 'reveal'), '② 只改 style 显出来 → 必须补上高亮（这条就是属性观察的理由；关掉 attributes 它会红）');

      await page.evaluate(() => { document.getElementById('e2e-reveal').style.display = 'none'; });
      truthy(await waitHits(0, 'hide'), '③ 再藏起来 → 命中必须被收掉（否则会留一份看不见的陈旧命中）');

      await page.evaluate(() => { document.getElementById('e2e-reveal').style.display = ''; });   // 属性**删除**
      truthy(await waitHits(1, 'remove'), '④ 删掉 style 属性（DOM 上就是属性被删）→ 同样必须能重建并高亮');
      await shot(page, 'e2e-attribute-reveal');
    } finally {
      await api.setConfig(CONFIG);      // 共享配置必须还原
    }
  });

  await group('内容由 CSS 动画显出来（K60）：动画结束必须补一次重建', { aspects: ['hit'] });

  await test('★ 藏在 CSS 动画里 → 动画结束（没有任何 DOM 变动）也必须补上高亮', async () => {
    await api.setConfig(Object.assign({}, CONFIG, {
      keywords: [REL_PLAIN], pageRebuildSilentMs: 100, pageRebuildGapMs: 0,
      /* 把"文本量暴涨"兜底调远，本组**单独验动画/过渡通道**（否则两条通道都能救，验不出是哪条） */
      pageFingerprintIntervalMs: 60000
    }));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      /* 【先让配置热更新彻底落定】否则后面会冒出一次"迟到的 config 重建"，它恰好发生在动画之后，
       * 会把本组要验的东西（动画通道）救过去 —— 反向验证时表现为"停用了动画兜底却仍然通过"。 */
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '@keyframes khReveal{from{visibility:hidden}to{visibility:visible}}'
          + '#anim-box{visibility:hidden;animation:khReveal 0.01s linear 2.5s forwards}';
        document.head.appendChild(st);
        const d = document.createElement('div');
        d.id = 'anim-box';
        d.textContent = '华为技术有限公司';
        document.body.appendChild(d);
      });
      const hitsIn = () => page.evaluate(() => {
        const el = document.getElementById('anim-box');
        if (!el) return -1;
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n; while ((n = w.nextNode())) nodes.push(n);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits;
      });
      /* 动画跑之前连查两次：证明"藏着的这段里没有任何别的通道在救"（否则本组等于没验） */
      await page.waitForTimeout(800);
      eq(await hitsIn(), 0, '动画还没跑（visibility:hidden）→ 扫描按可见性剪枝，不该有命中');
      await page.waitForTimeout(900);
      eq(await hitsIn(), 0, '动画前再确认一次：这一段里页面上没有任何 DOM 变动，不该有高亮');

      const appeared = await page.waitForFunction(() => {
        const el = document.getElementById('anim-box');
        if (!el) return false;
        const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let x; while ((x = w.nextNode())) nodes.push(x);
        let hits = 0;
        CSS.highlights.forEach((hl) => { try { for (const r of hl) if (nodes.indexOf(r.startContainer) >= 0) hits++; } catch (e) { /* ignore */ } });
        return hits > 0;
      }, null, { timeout: 9000 }).then(() => true).catch(() => false);
      truthy(appeared, '动画把内容显出来后必须补上高亮（这条就是"提交后不高亮、刷新页面才好"的回归：'
        + 'CSS 动画不产生任何 MutationRecord，只能靠 animationend/transitionend 兜底）');
      await shot(page, 'e2e-anim-reveal');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  await group('变更处理方式可切换（K58）：保守档任何变动都整页重建', { aspects: ['hit'] });

  await test('★ 变更处理方式可切换：保守档（always）任何变动都整页重建，切回智能档立刻恢复"无关不重建"（K58）', async () => {
    /* 判据用**内容脚本自己的重建计数**（经扩展页面 `kh:debug:diag` 取），不靠主世界猜：
     * 保守档下"无关变动"必须让 rebuildCount 上涨；切回智能档后同类变动必须不再上涨。 */
    const diag = async () => {
      const ext = await api.extensionPage('options/options.html');
      try {
        return await ext.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => (x.url || '').indexOf('hidden-hit.html') >= 0);
          if (!t) return null;
          return await chrome.tabs.sendMessage(t.id, { type: 'kh:debug:diag' });
        });
      } finally { await ext.close(); }
    };
    const cfgWith = (mode) => Object.assign({}, CONFIG, {
      keywords: [REL_PLAIN], pageRebuildSilentMs: 120, pageRebuildGapMs: 0, changeHandling: mode
    });

    await api.setConfig(cfgWith('always'));
    try {
      await page.goto(origin + '/hidden-hit.html', { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 20000 });
      await page.evaluate(() => {
        const holder = document.createElement('div');
        holder.id = 'e2e-mode';
        holder.innerHTML = '<table><tbody><tr><td>供应商</td><td>华为技术有限公司</td></tr></tbody></table>';
        document.body.appendChild(holder);
      });
      await page.waitForTimeout(900);

      const d0 = await diag();
      truthy(d0 && d0.ok, '必须先能取到诊断（拿不到就说明装置不成立）');
      eq(d0.changeHandling, 'always', '诊断必须如实报告当前档位（保守）');

      /* ① 保守档：一批**完全无关**的变动也必须整页重建 */
      await page.evaluate(() => { const p = document.createElement('p'); p.textContent = '今日天气晴朗'; document.body.appendChild(p); });
      await page.waitForTimeout(1200);
      const d1 = await diag();
      truthy(d1.rebuildCount > d0.rebuildCount,
        '保守档：无关变动必须触发整页重建（实测 ' + d0.rebuildCount + ' → ' + d1.rebuildCount + '）');

      /* ② 切回智能档：同类无关变动不得再重建（这就是"可切换"的全部意义） */
      await api.setConfig(cfgWith('smart'));
      await page.waitForTimeout(900);
      const d2 = await diag();
      eq(d2.changeHandling, 'smart', '诊断应报告已切回智能档');
      await page.evaluate(() => { const p = document.createElement('p'); p.textContent = '明天多云转晴'; document.body.appendChild(p); });
      await page.waitForTimeout(1200);
      const d3 = await diag();
      eq(d3.rebuildCount, d2.rebuildCount, '智能档：无关变动不得重建（P1 预筛仍然生效）');

      /* ③ **走用户真实路径**再验一次：设置页那个下拉 → 保存 → 内容脚本真的切成保守档。
       * 【为什么必须单独测这一步】"开关是空操作"是一种极隐蔽的失败：档位没落库/没热更新，
       * 用户会以为"切了没用"，而我们的其它断言（直接写 storage）全都还是绿的。 */
      const opt = await api.extensionPage('options/options.html');
      await opt.evaluate(async () => {
        const sel = document.getElementById('pf-changeHandling');
        sel.value = 'always';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
      });
      await opt.close();
      /* 切档本身会触发一次配置热更新（可能连带一次重新上线）：先等它稳下来，再取基线 */
      await page.waitForTimeout(1600);
      const d4 = await diag();
      eq(d4.changeHandling, 'always', '从设置页下拉切档必须真的落库并热更新到内容脚本（否则"切了没用"）');
      const before = d4.rebuildCount;
      await page.evaluate(() => { const p = document.createElement('p'); p.textContent = '后天小雨'; document.body.appendChild(p); });
      await page.waitForTimeout(1400);
      const d5 = await diag();
      truthy(d5.rebuildCount > before,
        '切档后无关变动必须真的触发整页重建（用户路径闭环）：实测 ' + before + ' → ' + d5.rebuildCount
        + '（mutation ' + d4.mutationRebuildCount + ' → ' + d5.mutationRebuildCount + '）');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ================================================ K74 嵌套表格的抓取范围 */
  /* 用户症状（2026-09-22）：命中在**嵌套表格的内层**时什么都抓不到（旧实现只取最内层），
   * 面板因此分成两张卡（内层那张没有抓取值）。
   * 装置 `fixtures/nested-hit.html`：A 表内外都命中（外层是「标签|值」两列）；
   * B 表只有内层命中（外层「名称」列是别的词，但外层**仍有**抓取字段）。
   * 这里从**面板层**独立判 A1/A2（单测另见 tests/specs/k74-nested-fetch-scope.test.js）。 */
  group('K74 嵌套表格抓取范围（内层命中 → 抓到外层 / 面板聚合）', { aspects: ['fetch'] });

  await test('★ 内层命中也能抓到外层标签；auto 下没有"没有抓取值"的卡（self 为对照臂＝老行为）', async () => {
    const KW = (over) => Object.assign({
      id: 'kNested', text: '你好', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: true, importantNote: '嵌套笔记', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '驳回原因|运营备注', fetchEnabled: true, fetchScope: 'auto', cellOffset: '',
      imgOcr: false, imgOcrKeyword: '', imgOcrMax: '',
      createdAt: 1700000000000, updatedAt: 1700000000000
    }, over);
    const readPanel = () => page.evaluate(() => {
      const host = document.getElementById('kh-important-note-host');
      const sr = host && host.shadowRoot;
      if (!sr) return { panel: false, cards: [] };
      return {
        panel: true,
        cards: Array.from(sr.querySelectorAll('.khin-item')).map((it) => ({
          text: (it.textContent || '').replace(/\s+/g, ' ').trim(),
          tags: it.querySelectorAll('.khin-item-tags .khin-tag').length,
          fetchTables: it.querySelectorAll('table.kh-table-fetch').length
        }))
      };
    });
    /** 等面板稳定（重建/异步抓取都不许读一帧就断言） */
    const waitCards = async (want) => {
      let r = await readPanel();
      for (let i = 0; i < 25; i++) {
        if (r.panel && r.cards.length === want) return r;
        await page.waitForTimeout(200);
        r = await readPanel();
      }
      return r;
    };
    const has = (r, txt) => r.cards.some((c) => c.text.indexOf(txt) >= 0);
    try {
      /* A. auto（缺省口径）：A 表内外两处命中应**合成一张卡**且都带外层抓取值；
       *    B 表只有内层命中 → 也要抓到外层值。⇒ 面板里**不该存在"没有抓取值"的卡**。 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ fetchScope: 'auto' })] }));
      await fresh('nested-hit.html');
      const auto = await waitCards(2);
      console.log('        auto 卡片: ' + JSON.stringify(auto.cards.map((c) => c.text.slice(0, 90))));
      truthy(auto.panel, '面板应存在（这条词标着「重要」）');
      eq(auto.cards.length, 2, 'A 表（内容一致→合一）与 B 表各一张卡，实际 ' + JSON.stringify(auto.cards.map((c) => c.text.slice(0, 60))));
      truthy(auto.cards.every((c) => c.fetchTables >= 1),
        '★ auto 下每张卡都必须有抓取值（旧实现里"内层命中"那张卡完全没有抓取表）：' +
        JSON.stringify(auto.cards.map((c) => ({ t: c.text.slice(0, 40), n: c.fetchTables }))));
      truthy(has(auto, '资质材料不清晰'), '★ A 表内层命中必须抓到**外层**的「驳回原因」值');
      truthy(has(auto, '高价值'), '★ A 表内层命中还要抓到外层的「运营备注」值');
      truthy(has(auto, '营业执照过期'), '★ B 表只有内层命中 → 也必须抓到外层的「驳回原因」值');
      truthy(has(auto, '需跟进'), '★ 同上，B 表的「运营备注」也要抓到');
      eq(auto.cards.filter((c) => c.text.indexOf('资质材料不清晰') >= 0).length, 1,
        '★ A 表内外两处命中必须合成**恰一张**卡（旧实现是两张）');
      await shot(page, '26-k74-nested-auto');

      /* B. 对照臂 self＝老行为：内层命中抓不到 → 出现"没有抓取值"的卡；B 表的外层值不出现 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ fetchScope: 'self' })] }));
      await fresh('nested-hit.html');
      await page.waitForTimeout(600);
      const self = await readPanel();
      console.log('        self 卡片: ' + JSON.stringify(self.cards.map((c) => c.text.slice(0, 90))));
      truthy(self.cards.some((c) => c.fetchTables === 0),
        '★ 对照臂：self（只抓本层）下必须有"没有抓取值"的卡 —— 这正是老行为，证明上面 auto 的差异是抓取层级带来的：' +
        JSON.stringify(self.cards.map((c) => ({ t: c.text.slice(0, 40), n: c.fetchTables }))));
      falsy(has(self, '营业执照过期'), '★ self 下 B 表内层命中抓不到外层值（「营业执照过期」不该出现）');
      truthy(has(self, '资质材料不清晰'),
        '对照臂的另一半：self 下 **A 表外层那处命中**照旧能抓到（self 只让"内层命中"抓不到）');

      /* C. outer（K79 起旧值 outermost/outer1 都归一成它）＝所有祖先层：内层命中 → 抓到外层 */
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW({ fetchScope: 'outer' })] }));
      await fresh('nested-hit.html');
      const outer = await waitCards(2);
      truthy(has(outer, '营业执照过期'), 'outer 下 B 表内层命中也要抓到外层值');
      truthy(outer.cards.every((c) => c.fetchTables >= 1), 'outer 下同样不该有"没有抓取值"的卡');
      await shot(page, '26b-k74-nested-outermost');
    } finally {
      await api.setConfig(CONFIG);          // 还原共享配置
    }
  });

  /* ==================== K79 · 抓取方向（当前层 / 内层 / 外层） ====================
   * 用户症状（2026-09-23）：① 组合词「仅抓取」（标题词 + 核心词留空）勾了「内外都抓」仍然
   * **抓不到内部需要的字段**；② 普通词只勾「仅抓外层」却**抓到了内部相同但不需要的字段**。
   * 用户口径：**当前层**＝命中格直接所在的那张表；**内层**＝当前层里**任意单元格**嵌着的表
   * （不限于值格）；**外层**＝包着当前层的表；三方向可多选（新建默认当前层）；**外层取值排掉内表文字与图片**。
   * 装置 `fixtures/k79-nested-cells.html`：形状 A 内表在**另一个单元格**（附件格）／形状 B 内表就在**值格**里；
   * 每层都有「驳回原因」且值不同 ⇒ 看值就知道取了哪一层。
   * 这里是与断言版探针 `_e2e/probe-nested-scope.js`（13 条）**同源**的门禁内那一份（面板层判定）。 */
  group('K79 抓取方向：内层＝当前层里任意单元格的嵌表 / 外层值排掉内表', { aspects: ['fetch'] });

  await test('★ 方向矩阵：inner/self/outer/auto/旧值归一 + 症状①② 都不再出现', async () => {
    const K79KW = (id, o) => Object.assign({
      id: id, note: '', groupId: null, enabled: true, text: '', note: '',
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: true, importantNote: 'MARK:' + id, impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr', cellVerifyMatchMode: 'include',
      cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchEnabled: true, fetchLabels: '驳回原因', fetchScope: 'self', cellOffset: '', imgOcrMax: '',
      createdAt: 1700000000000, updatedAt: 1700000000000
    }, o);
    try {
      await api.setConfig(Object.assign({}, CONFIG, {
        keywords: [
          K79KW('A1-plain-self', { text: '甲词' }),
          K79KW('A2-plain-outer1', { text: '甲词', fetchScope: 'outer1' }),
          K79KW('A8-plain-outer', { text: '甲词', fetchScope: 'outer' }),
          K79KW('A4-combo-all', { text: '', cellVerifyEnabled: true, cellVerify: '详情', fetchScope: 'self+inner+outer' }),
          K79KW('A5-combo-auto', { text: '', cellVerifyEnabled: true, cellVerify: '详情', fetchScope: 'auto' }),
          K79KW('A6-combo-inner', { text: '', cellVerifyEnabled: true, cellVerify: '详情', fetchScope: 'inner' }),
          K79KW('B2-plain-outer1', { text: '乙词', fetchScope: 'outer1' })
        ]
      }));
      await fresh('k79-nested-cells.html');
      await page.waitForTimeout(1500);
      const panel = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const sr = host && host.shadowRoot;
        if (!sr) return { found: false, cards: [] };
        return {
          found: true,
          cards: Array.from(sr.querySelectorAll('.khin-item')).map((el) => {
            const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const mark = (txt.match(/MARK:[A-Za-z0-9-]+/) || [''])[0].replace('MARK:', '');
            const rows = Array.from(el.querySelectorAll('table tr')).map((tr) =>
              Array.from(tr.querySelectorAll('td,th')).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim()).join(' | '));
            return { mark: mark, rows: rows.filter((r) => r.replace(/[|\s]/g, '').length), hasFetch: !!el.querySelector('table.kh-table-fetch') };
          })
        };
      });
      const byMark = {};
      for (const c of panel.cards) {
        const k = c.mark || '(无标记)';
        if (!byMark[k]) byMark[k] = { rows: [], hasFetch: false };
        byMark[k].rows = byMark[k].rows.concat(c.rows);
        byMark[k].hasFetch = byMark[k].hasFetch || c.hasFetch;
      }
      const T = (id) => (byMark[id] ? byMark[id].rows.join(' || ') : '<缺卡>');
      console.log('        K79 矩阵: ' + JSON.stringify(Object.keys(byMark).sort().reduce((acc, k) => { acc[k] = byMark[k].rows; return acc; }, {})));
      truthy(panel.found, '面板应存在（这些词都标着「重要」）');
      /* 症状① 的靶心：组合词「仅抓取」+ 只勾内层 ⇒ 必须拿到**别的格子里**那张内表的字段 */
      truthy(T('A6-combo-inner').indexOf('内层驳回A') >= 0,
        '★ K79-①：组合词只勾「内层」⇒ 拿到别的格子里那张内表的字段，实际 ' + T('A6-combo-inner'));
      falsy(T('A6-combo-inner').indexOf('外层驳回A') >= 0,
        '★ 选了内层就只抓比命中层小的表（本层的值不许混进来），实际 ' + T('A6-combo-inner'));
      /* 内外都抓 ⇒ 两份都在、带层级后缀 */
      truthy(T('A4-combo-all').indexOf('内层驳回A') >= 0 && T('A4-combo-all').indexOf('外层驳回A') >= 0,
        '★ K79-①：内外都抓 ⇒ 内层与本层两份都在，实际 ' + T('A4-combo-all'));
      truthy(T('A4-combo-all').indexOf('（内层）') >= 0 && T('A4-combo-all').indexOf('（本层）') >= 0,
        '★ 同名不同值必须带「（内层）/（本层）」后缀区分来源，实际 ' + T('A4-combo-all'));
      /* 对照：旧值 auto 仍是"就近一层"，不含内层方向 */
      truthy(T('A5-combo-auto').indexOf('外层驳回A') >= 0 && T('A5-combo-auto').indexOf('内层驳回A') < 0,
        '★ 对照臂：旧值 auto 只有本层那份（存量行为不变），实际 ' + T('A5-combo-auto'));
      /* 缺省（＝新建默认 self）：当前层＝命中格所在的那张表 */
      truthy(T('A1-plain-self').indexOf('内层驳回A') >= 0 && T('A1-plain-self').indexOf('外层驳回A') < 0,
        '★ 缺省/self ＝当前层（形状 A 里是内表），实际 ' + T('A1-plain-self'));
      /* 旧值 outer1 ≡ 新值 outer（口径合并，逐格同值） */
      eq(T('A2-plain-outer1'), T('A8-plain-outer'), '★ 旧值 outer1 归一成 outer：逐格同值');
      truthy(T('A2-plain-outer1').indexOf('外层驳回A') >= 0, 'outer 取到外层的值，实际 ' + T('A2-plain-outer1'));
      /* 症状② 的靶心：形状 B（内表就在值格里）+ 只勾外层 ⇒ 外层的值排掉内表文字 */
      falsy(T('B2-plain-outer1').indexOf('内层驳回B') >= 0,
        '★ K79-②：外层的值里**不许**混进内表文字（用户症状②），实际 ' + T('B2-plain-outer1'));
      falsy(T('B2-plain-outer1').indexOf('乙词') >= 0, '★ 命中文字也不许被当成外层的值，实际 ' + T('B2-plain-outer1'));
      await shot(page, '28-k79-fetch-directions');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ==================== K75 · 假表格不再越界（用户 ①） ====================
   * 用户原话：命中词若出现在**正文标题**里，会走假表格路径、在祖先容器里找标签，
   * 可能多出一张无关的卡。装置 `fixtures/fake-scope.html`：
   *   ① `<h1>` 里含命中词 + 一张真表格带「驳回原因|资质材料不清晰」「运营备注|高价值」
   *   ② 一个 div 假表格（`.row > .label + .value`），命中词与「驳回原因」在同一行
   * 断言：① 标题那处命中**不许**抓到真表格的值（旧实现会把「高价值」也抓进来 = 那张无关的卡）；
   *      ② div 假表格那行照旧抓到「资质材料不清晰」（能力不许回退）。
   */
  await group('K75 假表格不再越界（命中在标题里 / div 假表格仍抓到）', { aspects: ['fetch'] });

  await test('★ 标题里的命中不许抓到别处的表；div 假表格那一行照旧抓到', async () => {
    const KW = {
      id: 'kE2eFakeScope', text: '范围检查', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      important: true, importantNote: '越界检查笔记', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '驳回原因|运营备注', fetchEnabled: true, fetchScope: 'auto', cellOffset: '',
      imgOcr: false, imgOcrKeyword: '', imgOcrMax: '',
      createdAt: 1700000000000, updatedAt: 1700000000000
    };
    try {
      await api.setConfig(Object.assign({}, CONFIG, { keywords: [KW] }));
      await fresh('fake-scope.html');
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const host = document.getElementById('kh-important-note-host');
        const sr = host && host.shadowRoot;
        if (!sr) return { panel: false, cards: [], text: '' };
        const cards = Array.from(sr.querySelectorAll('.khin-item')).map((it) => ({
          text: (it.textContent || '').replace(/\s+/g, ' ').trim(),
          fetchTables: it.querySelectorAll('table.kh-table-fetch').length
        }));
        const wrap = sr.querySelector('.khin-wrap') || sr.querySelector('.khin-panel');
        return { panel: true, cards: cards, text: wrap ? (wrap.textContent || '').replace(/\s+/g, ' ') : '' };
      });
      console.log('        K75 面板卡片: ' + JSON.stringify(r.cards.map((c) => ({ t: c.text.slice(0, 70), n: c.fetchTables }))));
      truthy(r.panel, '面板应存在（这条词标着「重要」）');
      /* ① 关键判据：真表格里「运营备注→高价值」只有**越界到 body/包裹层**才会被抓到 */
      falsy(r.text.indexOf('高价值') >= 0,
        '★ 标题里的命中不许越界抓到真表格的「运营备注→高价值」（旧实现就是这里多出一张无关的卡）：' + JSON.stringify(r.text.slice(0, 240)));
      truthy(r.cards.some((c) => c.fetchTables === 0),
        '标题那处命中不该有任何抓取值（它不在行容器里 ⇒ 假表格路径直接返回空）：' + JSON.stringify(r.cards));
      /* ② 能力不许回退：div 假表格那一行仍要抓到 */
      truthy(r.text.indexOf('资质材料不清晰') >= 0,
        '★ div 假表格（命中与「驳回原因」同一行）必须照旧抓到「资质材料不清晰」：' + JSON.stringify(r.text.slice(0, 240)));
      await shot(page, '27-k75-fake-scope');
    } finally {
      await api.setConfig(CONFIG);
    }
  });

  /* ---------------------------------------------------------- 判定三态的非颜色标记 */
  group('判定三态的非颜色标记（台账 #3/#4/#5：灰度下也必须分得清）', { aspects: ['visual'] });

  await test('★ 一致 / 待确认 / 未查明三态各有非颜色标记（不靠比色也分得开）', async () => {
    await fresh('list.html');
    /* 内容脚本跑在隔离世界，主世界拿不到 window.KH —— 用 CDP 取扩展上下文的 id（同 e2e/verify-20819.js）。
     * 断言只看 DOM 里的标记元素与文案，不比较颜色：这正是这条需求的意义。 */
    const cdp = await api.context.newCDPSession(page);
    let extCtx = 0;
    cdp.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.origin && String(c.origin).indexOf('chrome-extension://') === 0) extCtx = c.id;
    });
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 80 && !extCtx; i++) await page.waitForTimeout(100);
    truthy(extCtx > 0, '必须找到内容脚本所在的扩展隔离世界');
    const inExt = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expression, contextId: extCtx, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error('扩展世界抛错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    try {
      /* 两张真表格：① 企业名称与开发者同值（一致）+ 承诺对象华为（待确认）
       *              ② 只有企业名称、没有开发者（未查明：不涂色但要留标记） */
      await page.evaluate(() => {
        const mk = (id, rows) => {
          const box = document.createElement('div');
          box.id = id;
          box.style.cssText = 'position:fixed;left:0;top:0;width:520px;background:#fff;z-index:2147483647';
          box.innerHTML = '<table class="kh-table kh-table-fetch"><tbody>' + rows.map((r) =>
            '<tr><td class="kh-table-label">' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</tbody></table>';
          document.body.appendChild(box);
        };
        mk('e2e-verdict-two', [
          ['开发者', '北京知行灵动科技有限公司'],
          ['企业名称', '北京知行灵动科技有限公司'],
          ['承诺对象', '华为技术有限公司']
        ]);
        mk('e2e-verdict-unknown', [['企业名称', '北京知行灵动科技有限公司']]);
        /* 【台账 #8】超时是第四态：开发者与核准主体两边都查不到法人，但原因是「20 秒没回执」。 */
        mk('e2e-verdict-timeout', [
          ['开发者', '北京知行灵动科技有限公司'],
          ['核准主体', '华为技术有限公司']
        ]);
      });

      const rowsOut = await inExt('(function () {'
        + 'var out = []; var boxes = ["e2e-verdict-two", "e2e-verdict-unknown", "e2e-verdict-timeout"];'
        + 'return (async function () {'
        + 'for (var b = 0; b < boxes.length; b++) {'
        + '  var el = document.getElementById(boxes[b]);'
        + '  if (boxes[b] === "e2e-verdict-timeout") {'
        + '    window.KH.ImportantNote.panel.lookupEntity = function () { return Promise.resolve({ rep: "", timedOut: true }); };'
        + '  }'
        + '  window.KH.ImportantNote.panel.decorateChecks(el, {});'
        + '  if (boxes[b] === "e2e-verdict-timeout") await new Promise(function (r) { setTimeout(r, 80); });'
        + '  var tds = el.querySelectorAll("td.kh-table-label");'
        + '  for (var i = 0; i < tds.length; i++) {'
        + '    var m = tds[i].querySelector(".kh-verdict");'
        + '    out.push({ box: boxes[b], label: window.KH.NoteCheck.labelText(tds[i]),'
        + '      mark: m ? String(m.textContent) : "", state: m ? String(m.getAttribute("data-state") || "") : "",'
        + '      bg: String(tds[i].style.background || ""), tip: String(tds[i].title || "") });'
        + '  }'
        + '}'
        + 'return out; })(); })()');
      console.log('        三态标记: ' + JSON.stringify(rowsOut.map((x) => ({ b: x.box, l: x.label, m: x.mark, s: x.state, bg: x.bg }))));

      const pick = (box, label) => rowsOut.filter((x) => x.box === box && x.label === label)[0];
      const same = pick('e2e-verdict-two', '企业名称');
      const warn = pick('e2e-verdict-two', '承诺对象');
      const unknown = pick('e2e-verdict-unknown', '企业名称');
      truthy(same && warn && unknown, '三行都要画出来，实际 ' + JSON.stringify(rowsOut.map((x) => x.label)));
      eq(same.mark, '✔ 一致', '一致态要挂「✔ 一致」');
      eq(same.state, 'same');
      eq(warn.mark, '⚠ 待确认', '待确认态要挂「⚠ 待确认」');
      truthy(same.mark !== warn.mark, '两态文案必须不同（只靠底色不够）');
      eq(unknown.mark, '？ 未查明', '未查明要挂独立的第三态标记');
      eq(unknown.bg, '', '未查明不涂色');
      truthy(String(unknown.tip).indexOf('未查明') >= 0, '未查明的悬停说明必须非空且写明原因，实际 = ' + JSON.stringify(unknown.tip));
      eq(unknown.label, '企业名称', '标记是后缀，字段名照旧认得出来');
      /* 【台账 #8】超时是第四态：同样是「不改底色」，但徽标与悬停都要写「超时」，
       * 和「？未查明」分得开（一个该等会儿再看，一个就是查不到）。 */
      const timeout = pick('e2e-verdict-timeout', '核准主体');
      truthy(timeout, '超时那张表要画出来，实际 ' + JSON.stringify(rowsOut.map((x) => x.label)));
      eq(timeout.mark, '⏱ 超时', '查询超时要挂「⏱ 超时」而不是「？ 未查明」');
      eq(timeout.state, 'timeout');
      truthy(timeout.mark !== unknown.mark, '超时与未查明的文案必须不同');
      eq(timeout.bg, '', '超时同样不改底色');
      truthy(String(timeout.tip).indexOf('超时') >= 0, '悬停要写明超时，实际 = ' + JSON.stringify(timeout.tip));
      await shot(page, '28-verdict-marks');
    } finally {
      await page.evaluate(() => {
        try { delete window.KH.ImportantNote.panel.lookupEntity; } catch (e) {}
        ['e2e-verdict-two', 'e2e-verdict-unknown', 'e2e-verdict-timeout'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  });

  await page.close();
  return report('内容层真浏览器测试');
};
