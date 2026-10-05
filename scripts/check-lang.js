/* scripts/check-lang.js — OCR 语言包「清单 ↔ 实际文件」对账
 * ----------------------------------------------------------------------------
 * `vendor/tesseract/lang-manifest.json` 自称"体积与 sha256 的唯一真源"，可这两栏此前
 * **没有任何代码去核对**：2026-10-05 就抓到一次 —— 站点上两份高精度包的 sha256 与清单
 * 逐字节一致，而 `bytes` 一栏记错了（chi_sim_std 少 1801 B、eng_std 多 3081 B）。
 * bytes 只用于设置页显示，所以谁都没发现；等到某天有人拿 bytes 去算下载进度或做校验，
 * 就会变成"设置页说 19.4MB、实际 20.3MB"这种无解的支持问题。
 *
 * 本脚本把那件事变成一次可执行的对账：
 *   · 清单是"声明"，站点/本地文件是"事实"，任何一边错都得先弄清楚再发版。
 *
 * 用法：node scripts/check-lang.js [--live | --fetch] [--dir <目录>] [--quiet]
 *   · 默认      ：核对 `release/lang/` 里**已存在**的包（缺失只提示，不算失败）
 *   · --live    ：按清单 `_base` 从站点下载每个包，核对 bytes + sha256 + gzip 头
 *   · --fetch   ：--live 通过后把包写进 `release/lang/`（补齐发版要用的本地副本；
 *                 高精度包不在任何脚本可下载的官方源里，只能这样从站点取回）
 *   · --dir <d> ：换一个本地目录（默认 release/lang）
 *   · --quiet   ：只打印最后一行摘要
 * 退出码非 0 = 有包与清单对不上（哪边错都得先查清，别带着不一致发版）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const FETCH = argv.indexOf('--fetch') >= 0;
const LIVE = FETCH || argv.indexOf('--live') >= 0;
const QUIET = argv.indexOf('--quiet') >= 0;
const dirAt = argv.indexOf('--dir');
const LOCAL_DIR = dirAt >= 0 && argv[dirAt + 1]
  ? path.resolve(argv[dirAt + 1])
  : path.join(ROOT, 'release', 'lang');
const MANIFEST = path.join(ROOT, 'vendor', 'tesseract', 'lang-manifest.json');

const SHA_RE = /^[0-9A-F]{64}$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
const say = (s) => { if (!QUIET) console.log(s); };
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** 清单里所有档位的包（fast 走 `packs`，其余档位走 `variants.<档>.packs`） */
function collect(m) {
  const out = [];
  for (const lang of Object.keys(m.packs || {})) out.push({ tier: 'fast', lang: lang, pack: m.packs[lang] });
  for (const v of Object.keys(m.variants || {})) {
    const packs = (m.variants[v] && m.variants[v].packs) || {};
    for (const lang of Object.keys(packs)) out.push({ tier: v, lang: lang, pack: packs[lang] });
  }
  return out;
}

(async () => {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    console.error('✗ 读不了清单 ' + rel(MANIFEST) + '：' + (err && err.message));
    process.exit(1);
  }
  const packs = collect(m);
  if (!packs.length) { console.error('✗ 清单里一个语言包都没有'); process.exit(1); }
  const base = String(m._base || '').replace(/\/$/, '');
  if (LIVE && !base) { console.error('✗ 清单缺 _base，没法确定站点地址'); process.exit(1); }

  let bad = 0, checked = 0, absent = 0;
  for (const p of packs) {
    const tag = p.tier + '/' + p.lang + ' ' + p.pack.file;
    const wantSha = String(p.pack.sha256 || '').toUpperCase();
    const wantBytes = Number(p.pack.bytes);
    if (!SHA_RE.test(wantSha)) { console.error('✗ ' + tag + '：清单里的 sha256 不合法（' + p.pack.sha256 + '）'); bad++; continue; }
    if (!(wantBytes > 0)) { console.error('✗ ' + tag + '：清单里的 bytes 不合法（' + p.pack.bytes + '）'); bad++; continue; }

    let buf = null, from = '';
    if (LIVE) {
      const url = base + '/' + p.pack.file;
      process.stdout.write(QUIET ? '' : '↓ ' + url + ' … ');
      try {
        const res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (!QUIET) console.log('失败');
        console.error('✗ ' + tag + '：下载失败（' + (err && err.message) + '）');
        bad++; continue;
      }
      if (!QUIET) console.log('ok');
      from = '站点';
    } else {
      const abs = path.join(LOCAL_DIR, p.pack.file);
      if (!fs.existsSync(abs)) { say('… ' + tag + '：本地没有（跳过；要查站点加 --live）'); absent++; continue; }
      buf = fs.readFileSync(abs);
      from = '本地';
    }

    checked++;
    const gotSha = sha256(buf);
    const okBytes = buf.length === wantBytes;
    const okSha = gotSha === wantSha;
    if (!okBytes || !okSha) {
      bad++;
      console.error('✗ ' + tag + '（' + from + '）：'
        + (!okBytes ? 'bytes 清单 ' + wantBytes + ' / 实际 ' + buf.length + '；' : '')
        + (!okSha ? 'sha256 清单 ' + wantSha + ' / 实际 ' + gotSha : ''));
      continue;
    }
    if (!isGzip(buf)) { bad++; console.error('✗ ' + tag + '（' + from + '）：不是 gzip（头两字节不是 1f 8b）—— 引擎解不开'); continue; }
    say('✓ ' + tag + '（' + from + '）：' + buf.length + ' B · sha256 ' + gotSha.slice(0, 16) + '…');

    if (FETCH) {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
      const dst = path.join(LOCAL_DIR, p.pack.file);
      fs.writeFileSync(dst, buf);
      say('  ↳ 已写入 ' + rel(dst));
    }
  }

  const where = LIVE ? '站点 ' + base : '本地 ' + rel(LOCAL_DIR);
  console.log('语言包对账（' + where + '）：核对 ' + checked + ' 个'
    + (absent ? '（本地缺 ' + absent + ' 个未核对）' : '') + ' · 不一致 ' + bad + ' 个');
  if (bad) console.error('✗ 清单与实际对不上：先查清哪边错，再发版。');
  process.exit(bad ? 1 : 0);
})();
