#!/usr/bin/env node
/**
 * 关键词高亮插件 - 高亮引擎回归测试（真实浏览器注入）
 * ============================================================
 * 覆盖 v1.10.7~v1.10.8 沉淀的「翻页残留 / 组合词值后到」关键行为，
 * 防止后续改动回归。所有场景均在「不改变 URL」条件下验证（靠 DOM 观察器监控）。
 *
 * 运行依赖：
 *   - Node.js
 *   - playwright（含 chromium）：
 *       项目首次：cd 项目根 && npm init -y && npm i playwright && npx playwright install chromium
 *   - chrome 可执行文件：自动探测 ~/.cache/ms-playwright 或 /opt/chrome-linux，可被 PW_CHROME 覆盖
 *   - playwright 模块路径：自动探测，可被 PW_PLAYWRIGHT_PATH 覆盖
 *
 * 运行：
 *   node tests/keyword-engine-regression.js            # 默认测仓库 lib/keyword-engine.js
 *   node tests/keyword-engine-regression.js <engine.js> # 指定被测引擎文件
 *
 * 退出码：0=全部通过，1=有失败，2=环境不可用
 */
'use strict';

const FS = require('fs');
const PATH = require('path');

// ---------- 探测依赖 ----------
function resolvePlaywright() {
  if (process.env.PW_PLAYWRIGHT_PATH) return process.env.PW_PLAYWRIGHT_PATH;
  for (const p of ['/tmp/pw/node_modules/playwright', '/tmp/ocr-spike/node_modules/playwright']) {
    if (FS.existsSync(p)) return p;
  }
  // 当前/父级 node_modules
  let d = process.cwd();
  while (d) {
    const cand = PATH.join(d, 'node_modules', 'playwright');
    if (FS.existsSync(cand)) return cand;
    const next = PATH.dirname(d);
    if (next === d) break;
    d = next;
  }
  return null;
}
function resolveChrome() {
  if (process.env.PW_CHROME && FS.existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  const home = process.env.HOME || '';
  const cands = [
    PATH.join(home, '.cache/ms-playwright', '', ''),
  ];
  const base = PATH.join(home, '.cache/ms-playwright');
  if (FS.existsSync(base)) {
    const hits = FS.readdirSync(base)
      .filter(n => /^chromium/i.test(n))
      .map(n => PATH.join(base, n, 'chrome-linux', 'chrome'))
      .filter(FS.existsSync);
    if (hits.length) return hits[0];
  }
  for (const c of ['/opt/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (FS.existsSync(c)) return c;
  }
  return null;
}

const enginePathArg = process.argv[2];
const repoRoot = PATH.resolve(__dirname, '..');
const ENGINE = enginePathArg
  ? PATH.resolve(enginePathArg)
  : PATH.join(repoRoot, 'lib', 'keyword-engine.js');
const UTILS = PATH.join(repoRoot, 'lib', 'utils.js');

const PW = resolvePlaywright();
const CHROME = resolveChrome();
if (!PW) { console.error('[环境] 未找到 playwright，请先安装（见文件头注释）。可用 PW_PLAYWRIGHT_PATH 指定。'); process.exit(2); }
if (!CHROME) { console.error('[环境] 未找到 chrome，可用 PW_CHROME 指定。'); process.exit(2); }
if (!FS.existsSync(ENGINE)) { console.error('[环境] 引擎文件不存在：' + ENGINE); process.exit(2); }

const { chromium } = require(PW);

// ---------- 断言框架 ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  → ' + JSON.stringify(detail) : ''));
}

(async () => {
  console.log('引擎: ' + ENGINE);
  console.log('Chrome: ' + CHROME);
  console.log('');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: UTILS });
  await page.addScriptTag({ path: ENGINE });

  // 注入通用构造与断言工具
  await page.evaluate(() => {
    window.__cfg = { groups: [], pageRebuildSilentMs: 0, pageRebuildGapMs: 0, highlightStyle: { defaultBgColor: '#ffff00', defaultTextColor: '#000' } };
    window.__mkKw = (id, title, val, bg) => ({ id, text: val, enabled: true,
      cellVerifyEnabled: true, cellVerify: title, cellVerifyMatchMode: 'contain', bgColor: bg });
    window.__buildRow = (title, val) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = title;
      const b = document.createElement('td'); b.textContent = val;
      tr.appendChild(a); tr.appendChild(b); return tr;
    };
    window.__countHi = () => { const h=KeywordEngine._plainHits||[]; return h.filter(m=>m.combo).length; };
    // v1.10.15：普通词高亮改用 CSS Highlight，命中数=CSS.highlights 各 Highlight 的 Range 总数
    window.__countPlain = () => { let n=0; (CSS.highlights||[]).forEach && Array.from(CSS.highlights.values()).forEach(hl=>{ if(hl&&hl.size) n+=hl.size; }); return n; };
    // v1.10.16：组合词命中在内存注册表（combo:true），左格标题=meta.adj，右格核心=textNode.slice(start,end)
    window.__hitTitles = () => {
      const out = [];
      const h = KeywordEngine._plainHits || [];
      const seenTriSet = new Set();
      for (const m of h) {
        if (!m.combo) continue;
        const tn = m.textNode, adj = m.adj || '';
        const tr = tn && tn.parentNode ? tn.parentNode.closest('tr') : null;
        if (tr && !seenTriSet.has(tr)) seenTriSet.add(tr);
        out.push(adj || '');
      }
      return out;
    };
  });

  // ===== 用例1：普通词初始高亮 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    document.body.appendChild(Object.assign(document.createElement('p'), { textContent: '我喜欢苹果和香蕉' }));
    await KeywordEngine.highlightKeywords([{ id: 'n1', text: '苹果', enabled: true }], window.__cfg);
  });
  check('普通词初始高亮', await page.evaluate(() => window.__countPlain()) === 1);

  // ===== 用例2：动态新增普通词节点 → 增量高亮 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const div = document.createElement('div'); document.body.appendChild(div);
    await KeywordEngine.highlightKeywords([{ id: 'n1', text: '苹果', enabled: true }], window.__cfg);
    KeywordEngine.setupMutationObserver([{ id: 'n1', text: '苹果', enabled: true }], window.__cfg);
  });
  await new Promise(r => setTimeout(r, 60));
  await page.evaluate(() => document.body.querySelector('div').appendChild(Object.assign(document.createElement('p'), { textContent: '这里有苹果' })));
  await new Promise(r => setTimeout(r, 600));
  check('动态新增节点增量高亮', await page.evaluate(() => window.__countPlain()) === 1);

  // ===== 用例3：组合词右格「值后到」（异步填充）→ 全量重刷补救 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const tr = window.__buildRow('刚需应用', '否'); // 默认值
    const tbl = document.createElement('table'); tbl.appendChild(tr);
    document.body.appendChild(tbl);
    const kw = window.__mkKw('c1', '刚需应用', '是', '#ff0');
    await KeywordEngine.highlightKeywords([kw], window.__cfg);
    KeywordEngine.setupMutationObserver([kw], window.__cfg);
    tr.cells[1].textContent = '是'; // textContent 赋值=移除旧TEXT+新增TEXT → 触发全量重刷（新增节点）
  });
  await new Promise(r => setTimeout(r, 700));
  const t3 = await page.evaluate(() => ({ hits: window.__countHi(), titles: window.__hitTitles() }));
  check('组合词「值后到」全量重刷补救', t3.hits === 1 && JSON.stringify(t3.titles) === JSON.stringify(['刚需应用']), t3);

  // ===== 用例4：无 URL 变化 + 整表行替换翻页（removedNodes → 先清后建，清残留 + 高亮新内容）=====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const tbl = document.createElement('table');
    tbl.appendChild(window.__buildRow('刚需应用', '是'));
    document.body.appendChild(tbl);
    const kws = [window.__mkKw('k1','刚需应用','是','#ff0'), window.__mkKw('k2','网盘应用','是','#0f0')];
    await KeywordEngine.highlightKeywords(kws, window.__cfg);
    KeywordEngine.setupMutationObserver(kws, window.__cfg);
  });
  await new Promise(r => setTimeout(r, 400));
  const t4_old = await page.evaluate(() => ({ hits: window.__countHi(), titles: window.__hitTitles() }));
  // 翻页：不改 URL，整表替换成新数据行
  await page.evaluate(() => {
    const tbl = document.querySelector('table');
    tbl.replaceChildren(window.__buildRow('网盘应用','是'), window.__buildRow('夸夸','是'));
  });
  await new Promise(r => setTimeout(r, 800));
  const t4_new = await page.evaluate(() => ({ hits: window.__countHi(), titles: window.__hitTitles(), oldGone: !document.body.textContent.includes('刚需应用') }));
  check('无URL-整行替换翻页:旧残留清除', t4_new.oldGone, t4_new);
  // 新建页含「网盘应用|是」与「夸夸|是」，但关键词仅配了 网盘应用 → 期望命中1(网盘应用)，夸夸行无关键词不命中
  check('无URL-整行替换翻页:新词正确高亮', t4_new.hits === 1 && JSON.stringify(t4_new.titles) === JSON.stringify(['网盘应用']), t4_new);

  // ===== 用例5：无 URL 变化 + 复用行仅改单元格文本（异步填充 textContent → 全量重刷）=====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const row = window.__buildRow('刚需应用', '否');
    const tbl2 = document.createElement('table'); tbl2.appendChild(row); tbl2.appendChild(window.__buildRow('网盘应用','是'));
    document.body.appendChild(tbl2);
    const kws = [window.__mkKw('k1','刚需应用','是','#ff0'), window.__mkKw('k2','网盘应用','是','#0f0')];
    await KeywordEngine.highlightKeywords(kws, window.__cfg);
    KeywordEngine.setupMutationObserver(kws, window.__cfg);
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { document.querySelectorAll('tr')[0].cells[1].textContent = '是'; });
  await new Promise(r => setTimeout(r, 800));
  const t5 = await page.evaluate(() => ({ hits: window.__countHi(), titles: window.__hitTitles() }));
  check('无URL-复用行改单元格文本:全量重刷命中', t5.hits === 2 && JSON.stringify(t5.titles.sort()) === JSON.stringify(['刚需应用','网盘应用'].sort()), t5);

  // ===== 用例6：无关文本改动 → 无误伤 =====
  await page.evaluate(async () => {
    document.body.innerHTML = '';
    const tr = window.__buildRow('刚需应用', '是');
    const tbl = document.createElement('table'); tbl.appendChild(tr); tbl.appendChild(window.__buildRow('网盘应用','是'));
    document.body.appendChild(tbl);
    const kws = [window.__mkKw('k1','刚需应用','是','#ff0'), window.__mkKw('k2','网盘应用','是','#0f0')];
    await KeywordEngine.highlightKeywords(kws, window.__cfg);
    KeywordEngine.setupMutationObserver(kws, window.__cfg);
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { document.body.appendChild(Object.assign(document.createElement('p'), { textContent: '与关键词无关的文本' })); });
  await new Promise(r => setTimeout(r, 700));
  const t6 = await page.evaluate(() => ({ hits: window.__countHi(), err: window.__err || null }));
  check('无关文本改动无误伤+无异常', t6.hits === 2, t6);

  await browser.close();
  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(failed.length === 0 ? '✅ 全部 ' + results.length + ' 项通过' : '❌ ' + failed.length + '/' + results.length + ' 项失败');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
