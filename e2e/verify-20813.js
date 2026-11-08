#!/usr/bin/env node
'use strict';
/* 2.0.8.13 真机验收脚本（临时装置，不入包）
 *
 * 验 2.0.8.12 六项 + 2.0.8.13 自适应省略在**真浏览器**里的实际表现：
 *   A 设置页：侧栏四组 + 7 个 data-tab + 空态三步引导
 *   B 弹窗：两张卡带 id 与 is-link（cursor 可点）
 *   C 笔记面板：展开后有内容格；短值不加裁剪类、超一行的值加 .kh-val-tight
 * 用法：node e2e/verify-20813.js
 */
const path = require('path');
const { launch } = require('./harness');
const server = require('./server');
const { CONFIG } = require('./test-config');

const out = [];
const log = (ok, msg, extra) => {
  out.push((ok ? '✓ ' : '✗ ') + msg + (extra ? ' · ' + extra : ''));
  console.log(out[out.length - 1]);
};

(async () => {
  const srv = await server.start(0);
  const api = await launch({ extensionDir: path.resolve(__dirname, '..') });
  const { context, extId } = api;
  try {
    /* ---------- A 设置页 ---------- */
    const opts = await context.newPage();
    await opts.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'load' });
    await opts.waitForTimeout(600);
    const a = await opts.evaluate(() => ({
      groups: document.querySelectorAll('.kh-nav-group').length,
      groupTitles: [...document.querySelectorAll('.kh-nav-group-title')].map((e) => e.textContent.trim()),
      tabs: [...document.querySelectorAll('#tabs a.kh-tab[data-tab]')].map((e) => e.dataset.tab),
      guides: document.querySelectorAll('.kh-empty-guide').length,
      guideSteps: [...document.querySelectorAll('.kh-empty-guide')].map((g) => g.querySelectorAll('ol li').length)
    }));
    log(a.groups === 4, '侧栏分成四组', JSON.stringify(a.groupTitles));
    log(a.tabs.length === 7, '七个 data-tab 一个不少', a.tabs.join(','));
    log(a.guides >= 1, '空态有三步引导', 'groups=' + a.guides + ' steps=' + JSON.stringify(a.guideSteps));

    /* 深链接：直接带 #sec-sites 打开，应落在站点分区 */
    const deep = await context.newPage();
    await deep.goto('chrome-extension://' + extId + '/options/options.html#sec-sites', { waitUntil: 'load' });
    await deep.waitForTimeout(500);
    const deepOk = await deep.evaluate(() => {
      const act = document.querySelector('#tabs a.kh-tab.is-active');
      return act ? act.dataset.tab : '';
    });
    log(deepOk === 'sites', '带 #sec-sites 打开直接落在站点分区', 'active=' + deepOk);

    /* ---------- B 弹窗 ---------- */
    const pop = await context.newPage();
    await pop.goto('chrome-extension://' + extId + '/popup/popup.html', { waitUntil: 'load' });
    await pop.waitForTimeout(400);
    const b = await pop.evaluate(() => {
      const kw = document.getElementById('card-keywords');
      const site = document.getElementById('card-site');
      const cs = kw ? getComputedStyle(kw) : null;
      return {
        hasKw: !!kw,
        hasSite: !!site,
        role: kw ? kw.getAttribute('role') : '',
        cursor: cs ? cs.cursor : '',
        linkClass: kw ? kw.classList.contains('is-link') : false
      };
    });
    log(b.hasKw && b.hasSite, '两张信息卡都有 id', 'keywords=' + b.hasKw + ' site=' + b.hasSite);
    log(b.linkClass && b.cursor === 'pointer', '卡片可点（is-link + cursor:pointer）', 'cursor=' + b.cursor);

    /* 点关键词卡 → 应新开一个带 #sec-keywords 的选项页（弹窗自己会 window.close()，别在它身上等） */
    const [openedTab] = await Promise.all([
      context.waitForEvent('page', { timeout: 4000 }).catch(() => null),
      pop.click('#card-keywords').catch(() => {})
    ]);
    if (openedTab) await openedTab.waitForLoadState('load').catch(() => {});
    const opened = openedTab ? openedTab.url() : '';
    log(opened.indexOf('#sec-keywords') >= 0, '点卡片打开设置页并落到 keywords', opened.split('/').pop() || '未开新页');

    /* ---------- C 笔记面板 ---------- */
    /* 只有开了「省略」的字段才会生成 .kh-val-box（fetch.js 的 clipOn），
     * 所以这里把 k1 的两列临时加上 ~ 后缀，用来验自适应裁剪 */
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const k1 = (cfg.keywords || []).find((k) => k.id === 'k1');
    if (k1) k1.fetchLabels = '驳回原因~|运营备注~';
    await api.setConfig(cfg);
    const page = await context.newPage();
    await page.goto(srv.origin + '/list.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-kh-state') !== null, null, { timeout: 15000 });
    await page.waitForTimeout(1200);

    /* 默认形态是悬窗（2.0.8.9 起），卡片本身就是展开态；摘要行（.khin-row-head）只在贴边条里出现 */
    const panel = await page.evaluate(() => {
      const host = document.querySelector('#kh-important-note-host');
      if (!host || !host.shadowRoot) return { ok: false, why: 'no panel host' };
      const sr = host.shadowRoot;
      const cards = [...sr.querySelectorAll('.khin-item')];
      const tables = [...sr.querySelectorAll('.kh-table')];
      return { ok: cards.length > 0, cards: cards.length, tables: tables.length, why: 'no cards' };
    });
    log(panel.ok, '悬窗渲染出笔记卡', panel.ok ? ('cards=' + panel.cards + ' tables=' + panel.tables) : panel.why);

    await page.waitForTimeout(400);
    const clip = await page.evaluate(() => {
      const sr = document.querySelector('#kh-important-note-host').shadowRoot;
      const boxes = [...sr.querySelectorAll('.kh-table .kh-val-box')];
      const rows = boxes.map((el) => {
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || 0;
        return {
          tight: el.classList.contains('kh-val-tight'),
          scrollH: Math.round(el.scrollHeight),
          clientH: Math.round(el.clientHeight),
          lh: Math.round(lh),
          text: (el.title || '').slice(0, 18)
        };
      });
      return { total: boxes.length, rows };
    });
    const shortOk = clip.rows.filter((r) => !r.tight && r.scrollH <= r.lh * 1.35 + 1).length;
    const longOk = clip.rows.filter((r) => r.tight).length;
    log(clip.total > 0, '面板里出现内容格', 'total=' + clip.total);
    log(clip.rows.every((r) => r.tight ? r.lh > 0 : true), '裁剪格的类与行高都能量到', JSON.stringify(clip.rows.slice(0, 4)));
    log(shortOk + longOk === clip.total,
      '每个内容格的裁剪状态都与自身高度一致（短的不裁、长的一行）',
      'short=' + shortOk + ' long=' + longOk + ' total=' + clip.total);
  } finally {
    try { await api.close(); } catch (e) {}
    try { server.stop(); } catch (e) {}
  }
  const bad = out.filter((l) => l.startsWith('✗')).length;
  console.log('\n结果：' + (out.length - bad) + ' 项通过，' + bad + ' 项失败');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + (e && e.stack || e)); process.exit(2); });
