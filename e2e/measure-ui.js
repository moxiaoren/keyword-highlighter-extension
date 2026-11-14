'use strict';
/* 2.0.8.11 前端全量测量（只测不改：不碰生产代码，产物落在工作区 docs/ui-v3/audit/2026-11-08/）
 *
 * 用法：
 *   node e2e/measure-ui.js            # 全量
 *   node e2e/measure-ui.js --only=options,popup
 *
 * 产物：
 *   docs/ui-v3/audit/2026-11-08/metrics.json     每场景的量化指标
 *   docs/ui-v3/audit/2026-11-08/shots/*.png      截图
 *
 * 指标口径：
 *   · 字体：font-size / line-height / font-weight / font-family 组合去重计数
 *   · 颜色：color + background-color 组合去重计数，并算 WCAG 对比度
 *   · 间距：padding 与 gap 的取值分布（众数与离散度）
 *   · 点击目标：宽或高 < 24px 的可点元素（WCAG 2.2 AA 目标尺寸）
 *   · 溢出：scrollWidth > clientWidth + 1
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./harness');
const { start } = require('./server');
const { CONFIG } = require('./test-config');

const OUT = path.resolve(__dirname, '../../../docs/ui-v3/audit/2026-11-08');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const ONLY = ((argv.find((a) => a.indexOf('--only=') === 0) || '').split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const want = (name) => !ONLY.length || ONLY.indexOf(name) >= 0;

const data = { generatedAt: new Date().toISOString(), scenarios: [] };
const slug = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').slice(0, 60);

/* 注入页面的通用测量器（主文档与 ShadowRoot 都能用：传 root 选择器） */
function measureInPage(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return null;
  const scope = rootSel && root.shadowRoot ? root.shadowRoot : root;
  const all = Array.from(scope.querySelectorAll('*'));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
  };
  const shown = all.filter(vis);

  const fonts = {};
  const colors = {};
  const pads = {};
  const gaps = {};
  const small = [];
  const contrast = [];

  const parseColor = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  /* 有效底色：向上找第一个不透明背景。遇到渐变/图片底就返回 null —— 静态算不出对比度，
     与其拿白色底硬算制造假阳性（欢迎页 hero 就是渐变），不如标记未知并跳过。 */
  const bgOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const st = getComputedStyle(n);
      const c = parseColor(st.backgroundColor);
      if (c && c.a > 0.6) return c;
      if (st.backgroundImage && st.backgroundImage !== 'none') return null;
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  for (const el of shown) {
    const cs = getComputedStyle(el);
    const key = cs.fontSize + ' / ' + cs.lineHeight + ' / ' + cs.fontWeight + ' / ' + cs.fontFamily.split(',')[0];
    fonts[key] = (fonts[key] || 0) + 1;
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const eff = bgOf(el);
      if (!eff) continue;
      const cc = cs.color + ' on ' + 'rgb(' + eff.r + ', ' + eff.g + ', ' + eff.b + ')';
      colors[cc] = (colors[cc] || 0) + 1;
      const fg = parseColor(cs.color);
      if (fg) {
        const bg = eff;
        const L1 = Math.max(lum(fg), lum(bg));
        const L2 = Math.min(lum(fg), lum(bg));
        const ratio = (L1 + 0.05) / (L2 + 0.05);
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const big = size >= 24 || (size >= 18.66 && bold);
        if (ratio < (big ? 3 : 4.5) && contrast.length < 25) {
          contrast.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && String(el.className).slice(0, 40)) || '',
            text: (el.textContent || '').trim().slice(0, 30),
            ratio: Math.round(ratio * 100) / 100,
            size, bold,
            fg: cs.color, bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')'
          });
        }
      }
    }
    const p = cs.padding;
    pads[p] = (pads[p] || 0) + 1;
    if (cs.display.indexOf('flex') >= 0 || cs.display.indexOf('grid') >= 0) {
      const g = cs.gap;
      if (g && g !== 'normal') gaps[g] = (gaps[g] || 0) + 1;
    }
  }

  const clickable = shown.filter((el) => {
    const t = el.tagName.toLowerCase();
    return t === 'button' || t === 'a' || t === 'input' || t === 'select' || el.hasAttribute('role') && el.getAttribute('role') === 'button' || el.tabIndex >= 0;
  });
  for (const el of clickable) {
    const r = el.getBoundingClientRect();
    if ((r.width < 24 || r.height < 24) && small.length < 25) {
      small.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        text: (el.textContent || '').trim().slice(0, 24),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
  }

  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    root: rootSel || 'document',
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, scrollH: document.documentElement.scrollHeight },
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    counts: { all: all.length, visible: shown.length, clickable: clickable.length },
    fonts: top(fonts, 12),
    colors: top(colors, 12),
    pads: top(pads, 10),
    gaps: top(gaps, 8),
    contrastViolations: contrast,
    smallTargets: small,
    headings: Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(vis).map((h) => ({
      tag: h.tagName.toLowerCase(), text: (h.textContent || '').trim().slice(0, 40),
      size: getComputedStyle(h).fontSize, weight: getComputedStyle(h).fontWeight
    }))
  };
}

/* 截图：page.screenshot 的默认 animations:'disabled' 会一直等动画结束（本扩展页有持续动画）
 * ⇒ 60s 超时。必须显式 animations:'allow'（实测 1.1s 出图）。CDP 直调反而 ~75% 概率挂住，不用。 */
async function cdpShot(page, file) {
  /* 失败是间歇性的（同一页面连续截偶尔会挂），重试 3 次即可拿到绝大多数图 */
  for (let i = 0; i < 3; i++) {
    try {
      await page.screenshot({ path: file, animations: 'allow', caret: 'hide', timeout: 5000 });
      return;
    } catch (e) {
      if (i === 2) console.log('  ! 截图失败 ' + require('path').basename(file));
      await page.waitForTimeout(600);
    }
  }
}

async function snap(page, name, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const m = await page.evaluate(measureInPage, o.root || null);
  const file = path.join(SHOTS, slug(name) + '.png');
  /* 不用 page.screenshot：扩展页上它会等「动画稳定/字体」而频繁 60s 超时。
   * 改走 CDP Page.captureScreenshot（实测 0.5s 出图，不受动画影响）。 */
  try {
    await cdpShot(page, file);
  } catch (e) {
    console.log('  ! 截图失败(' + name + '): ' + e.message.split('\n')[0]);
  }
  const rec = Object.assign({ name, shot: path.relative(OUT, file).replace(/\\/g, '/') }, m || {});
  data.scenarios.push(rec);
  console.log('  ✓ ' + (Date.now() - t0) + 'ms ' + name + (m ? ' · 可见 ' + m.counts.visible + ' · 对比度风险 ' + m.contrastViolations.length : ''));
  return rec;
}

(async () => {
  const srv = await start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  console.log('浏览器: ' + api.how + ' · 扩展 ' + api.extId);
  try {
    if (want('options')) {
      const page = await api.extensionPage('options/options.html');
      await page.waitForTimeout(1200);
      await snap(page, 'options-default');
      /* 顶部页签：逐个点开量一遍 */
      /* 真正的分区导航是 nav#tabs 里的 .kh-tab[data-tab]（7 个），用 hash 切换：
       *   keywords / groups / style / ocr / sites / data / help */
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('#tabs .kh-tab')).map((t) => ({
        tab: t.getAttribute('data-tab'), text: (t.textContent || '').trim(), href: t.getAttribute('href')
      })));
      for (const t of tabs) {
        try {
          /* 必须「点」锚点：#sec-* 的分区切换是点击处理，改 hash 不会触发（实测无效） */
          await page.evaluate((tab) => {
            const a = document.querySelector('#tabs a.kh-tab[data-tab="' + tab + '"]');
            if (a) a.click();
          }, t.tab);
          await page.waitForTimeout(700);
          await snap(page, 'options-' + t.tab, { full: true });
        } catch (e) { console.log('  ! 分区 ' + t.tab + ' 失败: ' + e.message.split('\n')[0]); }
      }
      /* 帮助区内部还有二级页签（.kh-htab） */
      await page.evaluate(() => { const a = document.querySelector('#tabs a.kh-tab[data-tab="help"]'); if (a) a.click(); });
      await page.waitForTimeout(500);
      const helpTabs = await page.evaluate(() => Array.from(document.querySelectorAll('.kh-htab')).map((t) => ({
        pan: t.getAttribute('data-hpan'), text: (t.textContent || '').trim()
      })));
      for (const t of helpTabs) {
        if (!t.pan) continue;
        try {
          await page.evaluate((pan) => {
            const b = document.querySelector('.kh-htab[data-hpan="' + pan + '"]');
            if (b) b.click();
          }, t.pan);
          await page.waitForTimeout(450);
          await snap(page, 'options-help-' + t.pan);
        } catch (e) { console.log('  ! 帮助页签 ' + t.pan + ' 失败: ' + e.message.split('\n')[0]); }
      }
      data.optionsTabs = { sections: tabs, help: helpTabs };
      await page.close();
    }

    if (want('popup')) {
      const p = await api.extensionPage('popup/popup.html');
      await p.waitForTimeout(900);
      await snap(p, 'popup-default');
      await p.close();
      await api.setConfig(Object.assign({}, CONFIG, { globalEnabled: false }));
      const p2 = await api.extensionPage('popup/popup.html');
      await p2.waitForTimeout(900);
      await snap(p2, 'popup-paused');
      await p2.close();
      await api.setConfig(CONFIG);
    }

    if (want('welcome')) {
      const w = await api.extensionPage('welcome/welcome.html');
      await w.waitForTimeout(900);
      await snap(w, 'welcome');
      await w.close();
    }

    if (want('content')) {
      await api.setConfig(CONFIG);
      const page = await api.context.newPage();
      await page.goto(srv.origin + '/list.html', { waitUntil: 'load' });
      /* 就绪信号＝文档根上的 data-kh-state（content script 写入；window.KH 在隔离世界里取不到） */
      await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
      await page.waitForTimeout(800);
      await snap(page, 'content-note-panel-float');
      /* 面板 Shadow DOM 内部指标 */
      const has = await page.evaluate(() => !!document.querySelector('#kh-important-note-host'));
      if (has) {
        const inner = await page.evaluate(() => {
          const h = document.querySelector('#kh-important-note-host');
          const r = h.shadowRoot.querySelector('.khin-panel');
          if (!r) return null;
          const b = r.getBoundingClientRect();
          const rows = Array.from(h.shadowRoot.querySelectorAll('.khin-row')).slice(0, 8).map((x) => {
            const rb = x.getBoundingClientRect();
            return { h: Math.round(rb.height), w: Math.round(rb.width) };
          });
          const fs_ = (sel) => { const e = h.shadowRoot.querySelector(sel); return e ? getComputedStyle(e).fontSize + '/' + getComputedStyle(e).lineHeight : null; };
          return {
            box: { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
            rows,
            fonts: { title: fs_('.khin-row-t'), sub: fs_('.khin-row-sub'), cat: fs_('.khin-row-cat'), item: fs_('.khin-item-note') },
            inlineOverflow: r.scrollWidth > r.clientWidth + 1
          };
        });
        data.scenarios[data.scenarios.length - 1].panel = inner;
        console.log('    面板 ' + JSON.stringify(inner && inner.box));
      }
      /* 收起态形态（【台账 #2】只剩一条路：头部「收起」→ FAB → 点 FAB 回来） */
      try {
        await page.locator('#kh-important-note-host').evaluate((h) => {
          const b = h.shadowRoot.querySelector('[data-act="collapse"]');
          if (b) b.click();
        });
        await page.waitForTimeout(500);
        await snap(page, 'content-note-collapsed-fab');
        await page.locator('#kh-important-note-host').evaluate((h) => {
          const f = h.shadowRoot.querySelector('.khin-fab');
          if (f) f.click();
        });
        await page.waitForTimeout(500);
        await snap(page, 'content-note-back-to-float');
      } catch (e) { console.log('  ! 形态切换失败: ' + e.message); }
      await page.close();
    }
  } finally {
    try { await api.close(); } catch (e) { /* ignore */ }
    try { srv.server.close(); } catch (e) { /* ignore */ }
    fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(data, null, 2), 'utf8');
    console.log('\n指标已写入 ' + path.join(OUT, 'metrics.json') + '（' + data.scenarios.length + ' 个场景）');
  }
})().catch((e) => { console.error('测量失败: ' + (e && e.stack || e)); process.exit(1); });
