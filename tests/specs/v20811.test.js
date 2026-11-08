/* tests/specs/v20811.test.js — 2.0.8.11 两个真 bug（体检 E1 / C4）
 * ----------------------------------------------------------------------------
 * E1「失败谎报成功」（`docs/ui-v3/audit/2026-11-08/health/experience.md`）：
 *   `mutate()` 吞掉写失败并 toast 错误，但**调用方接着无条件 toast「已删除 / 已启用 / 已更新」**，
 *   用户同时看到「保存失败」和「已删除」，会以为真删了、刷新后数据又回来。
 *   锁法：mutate 必须返回布尔；所有「写之后报成功」的调用点必须先看返回值。
 *
 * C4「本站开关把扩展 id 写进 siteDisabledMap」（同文件 convenience.md）：
 *   设置页页头的「本站开关（当前页不适用）」只改文案、按钮仍可点；点下去后台 `SITE_TOGGLE`
 *   用 `sender.tab.url` 兜底 = options.html（`chrome-extension://<id>`），于是把扩展 id
 *   当成站点写进 `siteDisabledMap`。锁法：前端 `siteOn === null` 时**真禁用**，
 *   后端只接受 http(s) 且非普通网页时不落盘。
 *
 * 注意：suite() 只接名字、不接回调 —— 用例必须写在同一层，否则一条都不会注册。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = function run() {
  suite('2.0.8.11 两个真 bug（失败谎报成功 / 本站开关写脏数据）');

  /* ---------------- E1：mutate 必须能表达"没写成" ---------------- */
  test('mutate() 成功返回 true、失败返回 false（不再只是吞异常）', () => {
    const src = read('options/options.js');
    const body = src.slice(src.indexOf('async function mutate(fn)'), src.indexOf('async function reload()'));
    truthy(/return true;/.test(body), 'mutate 成功路径必须 return true');
    truthy(/return false;/.test(body), 'mutate 失败路径必须 return false');
    truthy(/catch \(err\)/.test(body) && /保存失败/.test(body), '失败仍然要 toast 原因（不能静默）');
  });

  test('写失败后不再无条件报成功：每个成功 toast 前都有返回值检查', () => {
    const src = read('options/options.js');
    /* 这四处是用户最容易当真的：删除、批量启停、重置、导入 */
    const guards = [
      'if (!await mutate(() => KH.Store.removeKeywords(ids))) return;',
      /* 批量启停从 2.0.8.12 起改走 patchBatchEnabled（大数量分批），护栏跟着搬进函数体：
       * 小批量那一路必须有返回值检查，分批那一路必须把失败的批抛出去。 */
      'if (!await mutate(() => KH.Store.patchKeywords(ids, () => ({ enabled: enabled })))) return;',
      'if (!await mutate(() => KH.Store.reset(sc, cfg))) return;',
    ];
    for (const g of guards) truthy(src.includes(g), '缺少失败护栏：' + g);
    truthy(src.includes("if (!ok2) throw new Error('第 ' + (i + 1) + ' 批写入失败');"),
      '分批启停在某一批写失败时必须抛错（否则会报"已停用 N 条"）');
    /* 不能出现「mutate 之后紧跟成功 toast」的老写法 */
    falsy(/await mutate\([^;]*\);\n\s*D\.toast\('已删除'/.test(src),
      'removeKeywords 仍可能在写失败后报「已删除」');
  });

  test('导入失败不再把 Cannot read properties of null 原文抛给用户', () => {
    const src = read('options/options.js');
    const at = src.indexOf('async function importJSONText');
    const body = src.slice(at, at + 2200);
    truthy(/if \(!wrote\) return;/.test(body), 'JSON 导入失败后必须停下，不能再拿 stats.keywords 拼成功文案');
    truthy(/if \(!wrote\) return;/.test(src.slice(src.indexOf('async function importCSVText'), src.indexOf('async function importCSVText') + 1600)),
      'CSV 导入同理');
  });

  /* ---------------- C4：本站开关 ---------------- */
  test('站点按钮：这一页没有内容脚本时真的 disabled，而不是只改文案', () => {
    const src = read('options/options.js');
    truthy(/btn\.disabled = \(siteOn === null\);/.test(src),
      'updateSiteButton 必须按 siteOn === null 设置 disabled');
    truthy(src.includes("if ($('btn-site-toggle').disabled) return;"),
      '点击处理里要有兜底早退（防止别处手动 enable 后又点）');
  });

  test('后台 SITE_TOGGLE 只接受 http(s)，扩展页/内部页一律不落盘', () => {
    const src = read('background/service-worker.js');
    const at = src.indexOf('[MSG.SITE_TOGGLE]');
    const body = src.slice(at, at + 1400);
    truthy(/proto !== 'http:' && proto !== 'https:'/.test(body), '必须显式挡掉非 http(s) 协议');
    truthy(body.indexOf('siteDisabledMap[host] = true') > body.indexOf("proto !== 'http:'"),
      '协议校验必须发生在写 siteDisabledMap 之前');
  });
};
