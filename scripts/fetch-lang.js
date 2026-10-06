/* scripts/fetch-lang.js — 取 OCR 语言包（开发和真浏览器回归用的测试资产）
 * ----------------------------------------------------------------------------
 * 语言包**不进交付包**（交付包只有引擎与 wasm，见 vendor/README.md）；它们按需下载到
 * `release/lang/`。真浏览器回归（_e2e/content.test.js 的「图片文字识别」组）需要这两个文件在场，
 * 缺了会明确提示先跑本脚本（而不是给出一个看不懂的超时）。
 *
 * 用法：node scripts/fetch-lang.js [--force]
 *   · 默认已存在且 sha256 对得上就跳过；
 *   · 校验用 vendor/tesseract/lang-manifest.json（体积/sha256 的唯一真源，与扩展运行时同一份）。
 *
 * 只管清单 `packs` 里列出的包（S2 起档位取消，就是 chi_sim / eng 两个快档包）：
 * 它们的 `_source` 是 tessdata 官方 4.0.0_fast，能直连下载并逐个核对 sha256。
 * 万一将来清单里回了档位（`variants.*`），那些包不在任何官方可下载源里，
 * 要本地副本只能 `node scripts/check-lang.js --fetch` 从站点按 sha256 校验着取回来。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'lang');
const MANIFEST = path.join(ROOT, 'vendor', 'tesseract', 'lang-manifest.json');
const FORCE = process.argv.indexOf('--force') >= 0;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }

(async () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const base = String(m._source || '').replace(/\/$/, '');
  if (!base) { console.error('✗ 清单里没有 _source，无法确定下载地址'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  let bad = 0;
  for (const lang of Object.keys(m.packs)) {
    const pack = m.packs[lang];
    const dst = path.join(OUT, pack.file);
    if (!FORCE && fs.existsSync(dst)) {
      const buf = fs.readFileSync(dst);
      if (sha256(buf) === String(pack.sha256).toUpperCase()) {
        console.log('✓ ' + pack.file + ' 已存在且校验一致（' + Math.round(buf.length / 1024) + ' KB）');
        continue;
      }
      console.log('… ' + pack.file + ' 已存在但校验不一致，重新下载');
    }
    const url = base + '/' + pack.file;
    process.stdout.write('↓ ' + url + ' … ');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== String(pack.sha256).toUpperCase()) {
        throw new Error('sha256 不一致：期望 ' + pack.sha256 + '，实际 ' + got);
      }
      fs.writeFileSync(dst, buf);
      console.log('ok（' + Math.round(buf.length / 1024) + ' KB）');
    } catch (err) {
      bad++;
      console.log('失败：' + (err && err.message));
    }
  }
  if (bad) { console.error('\n✗ 有 ' + bad + ' 个语言包没取到（真浏览器回归的「图片文字识别」组会红）'); process.exit(1); }
  console.log('\n语言包就绪：' + OUT);
})();
