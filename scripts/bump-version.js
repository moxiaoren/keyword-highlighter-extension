/* ============================================================================
 * scripts/bump-version.js — 版本号推进（按既定发版规程）
 * ----------------------------------------------------------------------------
 * 【发版规程】（用户拍板，工具强制约束，不靠人记）
 *
 *   · 测试版**只 +1 第四位**：      1.1.0 → 1.1.0.1 → 1.1.0.2 → 1.1.0.3 …
 *   · 晋级稳定版**第三位 +1 并丢掉第四位**：  1.1.0.3 → 1.1.1
 *   · 晋级后**稳定通道与测试通道同版本发布**（测什么就发什么）；
 *     下一轮测试版从新的稳定版再起：1.1.1 → 1.1.1.1 → …
 *
 *   为什么必须这样（两条硬约束，都是浏览器行为，不是我们的偏好）：
 *     ① **浏览器永不降级**：update 清单里的版本 ≤ 本机已装版本 → 直接忽略。
 *        所以"测试版 1.1.0.3 → 稳定版写 1.1.0"会让所有装过测试版的人**永远收不到** ✗；
 *     ② 测试版必须**同时**满足：> 当前稳定版（否则测试者收不到）✓
 *        且 < 下一个稳定版（否则晋级时版本反而变小）✓
 *        —— 四段号正好给出这个空间：1.1.0 < 1.1.0.1 < … < 1.1.1 ✓
 *
 * 用法：
 *   node scripts/bump-version.js beta      # 测试版：1.1.0 → 1.1.0.1（再跑 → 1.1.0.2）
 *   node scripts/bump-version.js release   # 晋级：1.1.0.3 → 1.1.1
 *   node scripts/bump-version.js minor     # 1.1.1 → 1.2.0（大周期切换）
 *   node scripts/bump-version.js major     # 1.2.0 → 2.0.0
 *   node scripts/bump-version.js patch     # 第三位 +1（等价于 release 的效果，但保留第四位）
 *   node scripts/bump-version.js 1.1.2     # 指定版本（仍会校验不许回退）
 *   node scripts/bump-version.js --show    # 只看当前版本与所处阶段
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);

const ROOT = path.join(__dirname, '..');
const MF = path.join(ROOT, 'manifest.json');
const raw = fs.readFileSync(MF, 'utf8');
const mf = JSON.parse(raw);
const cur = String(mf.version || '0.0.0');
const arg = process.argv[2];
const FORCE_RESET = argv.indexOf('--force-reset') >= 0;   // 显式换线：允许版本号比当前小（会切断已装设备）

/** 解析成数字段（补齐到 3 段；有第 4 段就保留） */
function parse(v) {
  const p = String(v).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  return p.slice(0, 4);
}
const fmt = (p) => p.join('.');

/** 当前处于哪个阶段：稳定版（3 段）还是测试版（4 段） */
function stageOf(v) {
  const seg = String(v).replace(/^v/i, '').split('.');
  return seg.length >= 4 ? '测试版（第 ' + seg[3] + ' 轮）' : '稳定版';
}

if (!arg || arg === '--show') {
  const p = parse(cur);
  console.log('当前 manifest.version = ' + cur + '   [' + stageOf(cur) + ']');
  /* ---- 临时换线期（用户拍板的临时措施，不是违规）----
   * 起因：此前测试版号一度发到 2.2.4，超过了 2.0.0 —— 按"版本只能往上加"的规则，
   *       稳定版就再也没法落在 2.0.0 了。
   * 临时措施：测试版换到 1.99.99.x（用 --force-reset 切过来），
   *       测试期间所有号都 < 2.0.0，测试完成后用 major 把稳定版落在 2.0.0
   *       —— 2.0.0 > 1.99.99.x 且 > 线上旧稳定版 1.51.0，两边都能升上来。
   * 结束条件：稳定版发布 2.0.0 之后本临时线结束，回到常规规程（守卫照旧）。
   * 注意：装过 2.2.x 测试版的设备升不到 2.0.0（2.0.0 < 2.2.4），需卸载重装。
   */
  const TEMP_LINE = /^1\.99\.99\./.test(cur);
  if (TEMP_LINE) {
    console.log('');
    console.log('  [临时换线期] 测试版在 1.99.99.x；测试完成后稳定版目标 = 2.0.0');
    console.log('    结束方式：node scripts/bump-version.js major   -> 2.0.0');
    console.log('              node scripts/release.js --promote --key release/key.pem');
  }
  console.log('');
  console.log('按规程，下一步应该是：');
  if (TEMP_LINE) {
    console.log('  再发一轮测试版 : node scripts/bump-version.js beta      -> ' + fmt([1, 99, 99, p[3] + 1]) + '  (仍 < 2.0.0)');
    console.log('  测试完成 -> 定稿: node scripts/bump-version.js major     -> 2.0.0   <- 临时线的终点');
  } else if (p.length >= 4) {
    console.log('  再发一轮测试版 : node scripts/bump-version.js beta      → ' + fmt([p[0], p[1], p[2], p[3] + 1]));
    console.log('  或直接晋级稳定 : node scripts/bump-version.js release   → ' + fmt([p[0], p[1], p[2] + 1]));
  } else {
    console.log('  开一轮测试版   : node scripts/bump-version.js beta      → ' + fmt([p[0], p[1], p[2], 1]));
    console.log('  或直接发下一稳定: node scripts/bump-version.js release  → ' + fmt([p[0], p[1], p[2] + 1]));
  }
  console.log('');
  console.log('参数：beta | release | minor | major | patch | <指定版本>');
  console.log('（--force-reset 只用于已记录的换线，例如本次 2.2.4 -> 1.99.99.1；常规发版一律不用）');
  process.exit(0);
}

let next;
if (/^\d+(\.\d+){1,3}$/.test(arg)) {
  next = arg;
} else {
  const p = parse(cur);
  if (arg === 'beta') {
    /* 测试版：只 +1 第四位。结构上就保证了 > 当前稳定版、< 下一个稳定版 ✓ */
    if (p.length < 4) p.push(0);
    p[3] += 1;
    next = fmt(p);
  } else if (arg === 'release') {
    /* 晋级：第三位 +1 **并丢掉第四位**（1.1.0.3 → 1.1.1）。
     * 保证 > 最后一个测试版 ✓ —— 装过测试版的人也能升上来 ✓ */
    next = fmt([p[0], p[1], p[2] + 1]);
  } else if (arg === 'major') {
    next = fmt([p[0] + 1, 0, 0]);
  } else if (arg === 'minor') {
    next = fmt([p[0], p[1] + 1, 0]);
  } else if (arg === 'patch') {
    next = fmt([p[0], p[1], p[2] + 1]);
  } else {
    console.error('✗ 参数只能是 beta / release / minor / major / patch / 形如 1.1.0.1 的版本号');
    process.exit(1);
  }
}

/* 不许回退（compareVersions 与浏览器同一口径：逐段数值比较） */
const cmp = require(path.join(ROOT, 'background', 'update-checker.js')).compareVersions;
if (cmp(next, cur) <= 0) {
  if (!FORCE_RESET) {
    console.error('✗ 新版本 ' + next + ' 不大于当前 ' + cur + ' —— 浏览器永不降级，版本必须严格变大');
    console.error('  确实要换一条更小的版本线时，加 --force-reset（会切断已装设备的自动更新，只有全新安装能上去）');
    process.exit(1);
  }
  console.error('⚠️  --force-reset：允许版本回退到 ' + next + '（小于当前 ' + cur + '）');
  console.error('    → 已经装了 ' + cur + ' 这类更大版本的设备**不会**自动升到 ' + next + '，必须卸载重装 ✗');
}

/* 只替换 version 那一行的值，保留文件其余格式 */
const out = raw.replace(/("version"\s*:\s*")([^"]+)(")/, '$1' + next + '$3');
if (out === raw) { console.error('✗ 没能在 manifest.json 里定位 version 字段'); process.exit(1); }
fs.writeFileSync(MF, out, 'utf8');

const p2 = parse(next);
console.log('manifest.version：' + cur + '  →  ' + next + '   [' + stageOf(next) + ']');
console.log('');
if (arg === 'beta') {
  console.log('接下来（测试版一轮）：');
  console.log('  1) 在 src/ui/changelog.js 给 ' + next + ' 加更新说明（不加也能发，说明会退化成 "v' + next + ' 更新"）');
  console.log('  2) node scripts/release-beta.js        # 出包（想给人手动装 crx 加 --with-crx）');
  console.log('  3) node scripts/publish-gh.js          # 推 gh-pages');
  console.log('');
  console.log('多轮测试就重复 1~3，版本依次是 ' + fmt([p2[0], p2[1], p2[2], p2[3] + 1]) + '、' + fmt([p2[0], p2[1], p2[2], p2[3] + 2]) + ' …（都 < ' + fmt([p2[0], p2[1], p2[2] + 1]) + ' ✓）');
  console.log('确认无误后晋级：node scripts/bump-version.js release   → ' + fmt([p2[0], p2[1], p2[2] + 1]));
} else if (arg === 'release') {
  console.log('接下来（晋级稳定版，两通道同版本发布）：');
  console.log('  1) node scripts/release.js --promote --key release/key.pem   # 稳定通道（会自动同时出测试通道的包）');
  console.log('  2) node scripts/publish-gh.js');
  console.log('');
  console.log('发完后：稳定版与测试版都是 ' + next + ' ✓；下一轮测试版从 ' + next + '.1 起 ✓');
} else {
  console.log('接下来：node scripts/release.js --channel beta  或  node scripts/release.js --promote');
}
