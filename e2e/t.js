'use strict';
/* 极简 E2E 断言框架（带截图证据） */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '_out');
fs.mkdirSync(OUT, { recursive: true });

const results = { pass: 0, fail: 0, failures: [], group: '' };

/* ---------------- 方面（aspect）过滤 ----------------
 * 用户定的口径：**改到哪个方面就回归哪个方面；不好判断就全量回归**。
 * 组的方面在 `group(name, { aspects: [...] })` 里声明；**没声明 = 保守全跑**（拿不准就不裁）。
 * 入口传 `--aspects=hit,interact`，`--aspects=all` 或干脆不传 = 不裁剪。
 * 方面清单见 scripts/impact.js 顶部（唯一真源），两边必须一致。 */
let selectedAspects = null;          // null = 不裁剪
let groupActive = true;
const skippedGroups = [];

function setAspects(list) {
  const arr = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  selectedAspects = (!arr.length || arr.indexOf('all') >= 0) ? null : new Set(arr);
}
(function parseAspectsFromArgv() {
  const a = process.argv.slice(2).find((x) => x.indexOf('--aspects=') === 0);
  if (a) setAspects(a.split('=')[1]);
})();

/* ---------------- 组名过滤（定点排查 / 反向验证用） ----------------
 * `--only=<子串>` 只跑组名含该子串的组。**出包门禁永远不带这个参数**，
 * 它只服务于"改一处 → 先单独把那一组跑红/跑绿"这种定点验证。
 * 因为有"只跑一组也是绿"的误读风险，report() 会额外打一条醒目提示。 */
let onlyGroup = null;
(function parseOnlyFromArgv() {
  const a = process.argv.slice(2).find((x) => x.indexOf('--only=') === 0);
  if (a) onlyGroup = a.split('=')[1];
})();

/* ---------------- 区域（area）过滤：比"方面"更细一层 ----------------
 * 用户口径：只改了关键词添加弹窗，就别把整个 UI 层跑一遍。
 * 区域表是**单一真源**（`scripts/regression-areas.js`），组名 → 区域（`nameRe` 匹配），
 * **不用给每个 group() 加标签**；名字匹配不上任何区域 → **一律照跑**（保守，绝不因分类没覆盖而漏跑）。
 * 入口传 `--areas=editor,color`。三级顺序：区域 → 方面 → 全量（由调用方 scripts/impact.js 决定用哪级）。 */
let selectedAreas = null;
const AREA_TABLE = (() => {
  /* 两个位置都要能跑：仓内 `work/keyword-highlighter/e2e/`（2026-11-01 起）与
   * 工作区根的 `_e2e/`（老位置）。表本身仍在扩展仓 `scripts/regression-areas.js`。 */
  for (const rel of ['../scripts/regression-areas.js', '../work/keyword-highlighter/scripts/regression-areas.js']) {
    try { return require(rel); } catch (e) { /* 换下一个位置 */ }
  }
  return null;
})();
function setAreas(list) {
  const arr = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  selectedAreas = (!arr.length || arr.indexOf('all') >= 0) ? null : new Set(arr);
}
(function parseAreasFromArgv() {
  const a = process.argv.slice(2).find((x) => x.indexOf('--areas=') === 0);
  if (a) setAreas(a.split('=')[1]);
})();

function group(name, opts) {
  results.group = name;
  const aspects = (opts && opts.aspects) || null;
  if (onlyGroup && name.indexOf(onlyGroup) < 0) {
    groupActive = false;
    skippedGroups.push(name + '（--only=' + onlyGroup + ' 过滤）');
    console.log('\n── ' + name + '   [跳过：--only=' + onlyGroup + ']');
    return;
  }
  /* 区域过滤：选中的区域里只要命中一个就跑；**没有区域归属的组一律跑** */
  let areaOk = true;
  let areaNames = [];
  if (selectedAreas) {
    areaNames = (AREA_TABLE && AREA_TABLE.areasOfGroupName) ? AREA_TABLE.areasOfGroupName(name) : [];
    areaOk = areaNames.length === 0 || areaNames.some((k) => selectedAreas.has(k));
  }
  groupActive = areaOk && ((!selectedAspects || !aspects || !aspects.length)
    ? true                                     // 未裁剪 / 未声明方面 → 跑
    : aspects.some((x) => selectedAspects.has(x)));
  if (!groupActive) {
    const why = areaOk ? '不属于本次范围' : ('区域 ' + areaNames.join('/') + ' 不在本次范围');
    skippedGroups.push(name + '（' + why + '）');
    console.log('\n── ' + name + '   [跳过：' + why + ']');
    return;
  }
  if (selectedAreas && areaNames.length) console.log('\n── ' + name + '   [区域：' + areaNames.join('/') + ']');
  else console.log('\n── ' + name);
}

async function test(name, fn) {
  if (!groupActive) { results.skipped = (results.skipped || 0) + 1; return; }
  const t0 = Date.now();
  try {
    await fn();
    results.pass++;
    console.log('  ✓ ' + name + '  (' + (Date.now() - t0) + 'ms)');
  } catch (err) {
    results.fail++;
    results.failures.push({ group: results.group, name, message: err && err.message, stack: err && err.stack });
    console.log('  ✗ ' + name + '  (' + (Date.now() - t0) + 'ms)');
    console.log('      ' + (err && err.message));
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ' — ' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function truthy(v, msg) { if (!v) throw new Error(msg || ('期望为真，实际 ' + JSON.stringify(v))); }
function falsy(v, msg) { if (v) throw new Error(msg || ('期望为假，实际 ' + JSON.stringify(v))); }
function includes(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) {
    throw new Error((msg ? msg + ' — ' : '') + '未包含 ' + JSON.stringify(needle) + '；实际前 300 字：' + JSON.stringify(String(hay).slice(0, 300)));
  }
}

async function shot(page, name) {
  const p = path.join(OUT, name + '.png');
  try { await page.screenshot({ path: p, fullPage: false }); } catch (e) { /* ignore */ }
  return p;
}

function report(title) {
  console.log('\n' + '═'.repeat(64));
  console.log(title);
  console.log('通过 ' + results.pass + ' · 失败 ' + results.fail);
  if (onlyGroup) {
    console.log('\n⚠ 本次只跑了组名包含 ' + JSON.stringify(onlyGroup) + ' 的组（--only 定点验证）——**不是**完整回归，');
    console.log('  上面的"通过 N"不能当回归结论；正式回归不带 --only。');
  }
  if (skippedGroups.length) {
    console.log('\n按方面裁剪掉的组（' + skippedGroups.length + ' 个，本次改动不涉及）：');
    for (const g of skippedGroups) console.log('  ○ ' + g);
  }
  if (results.fail) {
    console.log('\n失败明细：');
    for (const f of results.failures) console.log('  ✗ [' + f.group + '] ' + f.name + '\n      ' + f.message);
    process.exitCode = 1;
  }
  console.log('截图目录：' + path.relative(process.cwd(), OUT));
  return results.fail === 0;
}

module.exports = { group, test, assert, eq, truthy, falsy, includes, shot, report, setAspects, OUT, results };
