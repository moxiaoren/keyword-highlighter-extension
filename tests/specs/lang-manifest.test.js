/* tests/specs/lang-manifest.test.js — OCR 语言包清单的结构与"清单 ↔ 本地文件"一致性
 * ----------------------------------------------------------------------------
 * 为什么值得单测：这份清单是**设置页显示**与**运行时候选包**的唯一来源，且它随交付包一起发出去——
 * 写错的表现不是报错，而是"设置页显示 19.4MB、实际 20.3MB"这类没人会发现的谎。
 * 【2026-10-05】就是靠对账才发现：两份高精度包的 sha256 与站点逐字节一致，而 bytes 一栏错了。
 * 【S2（2026-10-06）】主引擎换成 PP-OCRv6 tiny 后档位取消，`variants.best` 的两个 _std 大包从清单移除；
 * 这里同时守「不该再有 variants」这一条 —— 清单回退意味着发版闸会 die（那两个包没有官方源）。
 * 真机/线上对账见 `node scripts/check-lang.js --live`；这里守的是**离线也能守**的那一半：
 * 结构合法 + 本地 `release/lang/` 里已有的包必须与清单逐字节一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, skip } = H;

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'vendor', 'tesseract', 'lang-manifest.json');
const LANG_DIR = path.join(ROOT, 'release', 'lang');
const SHA_RE = /^[0-9A-F]{64}$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

/** 清单里的所有包（档位机制已在 S2 取消，`variants` 只剩向后兼容的读法） */
function collect(m) {
  const out = [];
  for (const lang of Object.keys(m.packs || {})) out.push({ tier: 'fast', lang: lang, pack: m.packs[lang] });
  for (const v of Object.keys(m.variants || {})) {
    const packs = (m.variants[v] && m.variants[v].packs) || {};
    for (const lang of Object.keys(packs)) out.push({ tier: v, lang: lang, pack: packs[lang] });
  }
  return out;
}

module.exports = async function run() {
  suite('OCR 语言包清单 · 结构与一致性');

  const raw = fs.readFileSync(MANIFEST, 'utf8');
  const m = JSON.parse(raw);

  await test('清单：站点地址 / 包表（无档位）/ 每包三栏（file·bytes·sha256）都合法', () => {
    truthy(/^https:\/\//.test(String(m._base || '')), '清单缺 https 的 _base（运行时按它下载）');
    truthy(/^https:\/\//.test(String(m._source || '')), '清单缺 https 的 _source（fetch-lang.js 按它取包）');
    /* 【S2 起】档位取消：『更准』由引擎选择（imgOcr.engine）承担，Tesseract 退回兼容兜底只留快档两包。
       variants 若回潮（尤其 best 的两个 _std 大包）说明迁移没做完 —— 那两个包没有任何官方可下载源，
       发版闸会直接 die，而且 31MB 与「一次只识别表格里几张图」的体积账对不上。 */
    falsy(m.variants, '清单不该再有 variants 档位表（S2 起引擎选择取代档位，见 _why_no_variants）');
    const packs = collect(m);
    eq(packs.length, 2, '只剩快档两包：chi_sim + eng（每多一个包就多一个要发的站点文件、多一份缓存命名）');
    for (const p of packs) {
      const t = p.tier + '/' + p.lang;
      truthy(p.pack && typeof p.pack.file === 'string' && p.pack.file, t + ' 缺 file');
      truthy(/\.traineddata\.gz$/.test(p.pack.file), t + ' 的 file 不是 .traineddata.gz（' + p.pack.file + '）');
      truthy(Number.isInteger(p.pack.bytes) && p.pack.bytes > 0, t + ' 的 bytes 必须是正整数（现在 ' + p.pack.bytes + '）');
      truthy(SHA_RE.test(String(p.pack.sha256 || '').toUpperCase()), t + ' 的 sha256 不是 64 位大写十六进制');
    }
    /* 文件名口径：不带 `_std` 后缀 —— 档位没了，名字带后缀只会让缓存键与站点路径对不上 */
    truthy(!/_std/.test(String((m.packs.chi_sim || {}).file)), '中文包的文件名不该带 _std 后缀（档位已取消）');
    truthy(!/_std/.test(String((m.packs.eng || {}).file)), '英文包的文件名不该带 _std 后缀（档位已取消）');
  });

  await test('本地 release/lang/ 里已有的包必须与清单 bytes + sha256 逐字节一致', () => {
    if (!fs.existsSync(LANG_DIR)) { skip('本地语言包对账', '没有 release/lang（未跑 node scripts/fetch-lang.js）'); return; }
    const packs = collect(m);
    const present = packs.filter((p) => fs.existsSync(path.join(LANG_DIR, p.pack.file)));
    if (!present.length) { skip('本地语言包对账', 'release/lang 里一个清单上的包都没有'); return; }
    for (const p of present) {
      const buf = fs.readFileSync(path.join(LANG_DIR, p.pack.file));
      const t = p.tier + '/' + p.lang;
      eq(buf.length, p.pack.bytes, t + ' 的字节数与清单不一致（清单 ' + p.pack.bytes + '，实际 ' + buf.length
        + '）——清单是体积/sha256 唯一真源，对不上先跑 node scripts/check-lang.js --live 看站点实际值');
      eq(sha256(buf), String(p.pack.sha256).toUpperCase(), t + ' 的 sha256 与清单不一致');
      /* 引擎只会 gunzip，头不对等于"下载成功但识别不了" */
      eq(buf[0] === 0x1f && buf[1] === 0x8b, true, t + ' 不是 gzip 文件');
    }
  });
};
