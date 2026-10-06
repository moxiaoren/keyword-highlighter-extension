/* tests/specs/engine-assets.test.js — OCR 引擎资产（随包的 ORT + 闭包 + 运行时下载的模型）
 * ----------------------------------------------------------------------------
 * 为什么值得单测：S2 把主引擎换成 PP-OCR（`ppu-paddle-ocr` + `onnxruntime-web`）后，
 * 扩展能不能跑起来**取决于包里的静态资产**，而这件事在本机测试里"看不见"——
 * 本机开发时 node_modules 里什么都有，坏掉的表现是**用户装上后在 offscreen 里静默失败**：
 *   · MV3 的 CSP 是 `script-src 'self'`，**没有 import map**（也不许内联）⇒
 *     vendor 里只要残留一个裸 specifier（`from "onnxruntime-web"`），运行时就抛
 *     "Failed to resolve module specifier" —— 静态看代码完全正常，只有真机才炸。
 *   · 闭包少一个文件（32 个只拷了 30 个）同理：语法合法、import 时才 404。
 *   · 模型三件（det/rec/dict）是**运行时从站点下载**的，清单写错 = 用户点下载才 404；
 *     而 `release/models/` 里的文件与清单对不上，则是"发版时把坏文件推上站点"。
 * 所以这里守三件事：**随包资产字节账 + 导入闭包自洽 + 模型清单↔本地文件一致**。
 * 真机那一半（109 上自检 ok、阈值）在 `_e2e/probe-s1c-accept.js` 与 S2-d 的门禁里。
 *
 * 【与本文件相邻的分工】
 *   · `lang-manifest.test.js` 管 Tesseract 语言包清单（兼容兜底引擎）；
 *   · 本文件管 PP-OCR 主引擎的资产：ORT 三件、ppu 闭包、models-manifest、零引用的 lstm core。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, skip } = H;

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor');
const ORT_DIR = path.join(VENDOR, 'ort');
const PPU_DIRS = ['ppu-paddle-ocr', 'ppu-ocv'];
/* 闭包入口：主引擎只会从这里进（`ppu-paddle-ocr/web` 是浏览器子集，`ppu-ocv` 是它的画布依赖）。
 * 换入口必须同时改这一行 —— 否则下面的"全可达"断言会立刻变红，这正是想要的。 */
const ENTRIES = ['ppu-paddle-ocr/web/index.js', 'ppu-ocv/index.canvas-web.js'];

const MODEL_MANIFEST = path.join(VENDOR, 'ppocr', 'models-manifest.json');
const MODEL_DIR = path.join(ROOT, 'release', 'models');
const SHA_RE = /^[0-9A-F]{64}$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
/** 闭包遍历一律用 **vendor 相对**路径做键（写入口名、上磁盘、push 队列都是它） */
const vrel = (p) => path.relative(VENDOR, p).replace(/\\/g, '/');

/** 随包 ORT 三件的字节账：计划 §5 的"交付包 ≈5.42MiB"就是按这三件算的。
 *  升级 onnxruntime-web 时必须同步改这里**与计划 §5**（体积预算是发版契约，不是注释）。 */
const ORT_FILES = {
  'ort.wasm.min.mjs': 50126,
  'ort-wasm-simd-threaded.mjs': 24381,
  'ort-wasm-simd-threaded.wasm': 14239897
};
const ORT_TOTAL = 14314404;
/** 模型三件合计（6.27MB）：运行时下载量，也是"首次识别 ≤10s"的前提（计划 §5 判据）。 */
const MODEL_TOTAL = 6270386;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 从源码里抠出所有静态 import/export-from 与动态 import() 的 specifier */
function specifiersOf(src) {
  const out = [];
  for (const m of src.matchAll(/(?:^|[^\w$.])(?:import|export)\s*(?:\*\s*as\s*\w+\s*)?(?:[\w$,\s{}*]*?)\s*from\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

module.exports = async function run() {
  suite('OCR 引擎资产 · ORT + ppu 闭包 + 模型清单（S2）');

  await test('★ 随包 ORT 三件在场、字节数对得上、.wasm 是真 wasm', () => {
    let sum = 0;
    const bad = [];
    for (const name of Object.keys(ORT_FILES)) {
      const p = path.join(ORT_DIR, name);
      if (!fs.existsSync(p)) { bad.push(name + ' 不在（vendor/ort/ 缺文件 ⇒ ppu 的 import 直接失败）'); continue; }
      const n = fs.statSync(p).size;
      sum += n;
      if (n !== ORT_FILES[name]) bad.push(name + ' 字节数变了（期望 ' + ORT_FILES[name] + '，实际 ' + n + '）'
        + '—— 换版本请同步本文件的 ORT_FILES 与计划 §5 的体积账');
    }
    eq(bad.length, 0, bad.join('\n      '));
    eq(sum, ORT_TOTAL, 'ORT 三件合计体积变了（计划 §5 按这个数算交付包 ≈5.42MiB）');
    /* 只查字节数不够：截断/文本占位也能凑数。真 wasm 的前 4 字节是魔数 \0asm */
    const magic = fs.readFileSync(path.join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')).slice(0, 4);
    eq(magic.toString('hex'), '0061736d', 'ort-wasm-simd-threaded.wasm 不是 wasm 模块（魔数不对）');
  });

  await test('★ ppu 导入闭包自洽：无裸 specifier、无落点缺失、无孤儿文件', () => {
    const onDisk = [];
    for (const d of PPU_DIRS) for (const f of walk(path.join(VENDOR, d))) onDisk.push(vrel(f));

    const seen = new Set();
    const missing = [];
    const bare = [];
    const queue = ENTRIES.slice();
    while (queue.length) {
      const r = queue.pop();
      if (seen.has(r)) continue;
      seen.add(r);
      const abs = path.join(VENDOR, r);
      if (!fs.existsSync(abs)) { missing.push(r + ' ← 被 import，但磁盘上没有'); continue; }
      for (const s of specifiersOf(fs.readFileSync(abs, 'utf8'))) {
        if (s.charAt(0) !== '.') {
          /* 裸 specifier 在 MV3 里**没有解**：CSP 不许内联 import map，也不许远程脚本 */
          bare.push(r + ' → "' + s + '"');
          continue;
        }
        const abs2 = path.resolve(path.dirname(abs), s);
        if (!fs.existsSync(abs2)) missing.push(r + ' → "' + s + '"（落点 ' + vrel(abs2) + ' 不存在）');
        else queue.push(vrel(abs2));
      }
    }

    eq(bare.length, 0, 'vendor/ppu-* 里有裸 specifier（MV3 无 import map，运行时必抛 Failed to resolve module specifier）：\n      ' + bare.join('\n      '));
    eq(missing.length, 0, 'ppu 闭包有断链（拷漏了文件）：\n      ' + missing.join('\n      '));
    /* 孤儿 = 拷进来了但谁也 import 不到：不是"多余"就是"入口写错了"，两种都该有人看一眼 */
    const orphans = onDisk.filter((f) => !seen.has(f));
    eq(orphans.length, 0, '这些文件在 vendor 里但从任何入口都到不了（入口错了或拷多了）：\n      ' + orphans.join('\n      '));
    /* 入口是刻意写死的两处，钉一下它们确实被跟到了 */
    for (const e of ENTRIES) truthy(seen.has(e), '入口 ' + e + ' 没被走到（ENTRIES 写错？）');
    /* 闭包的终点必须是随包 ORT 胶水：写成别的（比如 `onnxruntime-web`）上面那条裸 specifier 会拦，
       写成别的相对路径则说明补丁没打上 —— 这里把落点正面钉死 */
    truthy(seen.has('ort/ort.wasm.min.mjs'), '闭包没落到 vendor/ort/ort.wasm.min.mjs（platform.web.js 的 ORT 补丁丢了吗？）');
  });

  await test('★ models-manifest：站点地址 / 三件套 / 每件三栏（file·bytes·sha256）都合法', () => {
    const m = JSON.parse(fs.readFileSync(MODEL_MANIFEST, 'utf8'));
    truthy(/^https:\/\//.test(String(m._base || '')), '清单缺 https 的 _base（运行时按它下载）');
    truthy(typeof m.cacheKey === 'string' && m.cacheKey, '清单缺 cacheKey（离线导入与缓存命名都读它）');
    const files = Object.keys(m.files || {});
    /* 三件套是契约：det 找框、rec 认字、dict 是字符集 —— 少一件都识别不出东西 */
    eq(files.sort().join(','), 'detection,dictionary,recognition',
      '模型清单的条目变了（主引擎就吃这三件：文字检测 + 文字识别 + 字符集）');
    let sum = 0;
    for (const k of files) {
      const f = m.files[k];
      truthy(f && typeof f.file === 'string' && f.file, k + ' 缺 file');
      truthy(/\.(onnx|txt)$/.test(f.file), k + ' 的 file 后缀不对（现在 ' + f.file + '：ORT 只加载 .onnx，字符集是 .txt）');
      truthy(Number.isInteger(f.bytes) && f.bytes > 0, k + ' 的 bytes 必须是正整数（现在 ' + f.bytes + '）');
      truthy(SHA_RE.test(String(f.sha256 || '').toUpperCase()), k + ' 的 sha256 不是 64 位大写十六进制');
      sum += f.bytes;
    }
    eq(sum, MODEL_TOTAL, '模型三件合计体积变了（运行时下载量，与计划 §5 的「首次 ≤10s」前提绑定）');
  });

  await test('本地 release/models/ 里已有的模型必须与清单 bytes + sha256 逐字节一致', () => {
    if (!fs.existsSync(MODEL_DIR)) { skip('本地模型对账', '没有 release/models（未跑 node _stage/wayfinder-ocr/_vendor-s2.js）'); return; }
    const m = JSON.parse(fs.readFileSync(MODEL_MANIFEST, 'utf8'));
    const present = Object.keys(m.files).filter((k) => fs.existsSync(path.join(MODEL_DIR, m.files[k].file)));
    if (!present.length) { skip('本地模型对账', 'release/models 里一个清单上的模型都没有'); return; }
    for (const k of present) {
      const f = m.files[k];
      const buf = fs.readFileSync(path.join(MODEL_DIR, f.file));
      eq(buf.length, f.bytes, k + ' 的字节数与清单不一致（清单 ' + f.bytes + '，实际 ' + buf.length
        + '）—— 清单是体积/sha256 唯一真源，重跑 _vendor-s2.js 或按清单从站点取回');
      eq(sha256(buf), String(f.sha256).toUpperCase(), k + ' 的 sha256 与清单不一致');
      if (/\.onnx$/.test(f.file)) {
        /* ONNX 是 protobuf：开头必须是 field 1 (ir_version) varint ⇒ 首字节 0x08。
           下到一份 HTML 错误页也"有个头"，所以这条能挡住"站点把 404 页面当文件存了"。 */
        eq(buf[0], 8, k + ' 不像 ONNX 文件（首字节应为 0x08，实际 0x' + buf[0].toString(16) + '）');
      }
    }
  });

  await test('★ 零引用的非 SIMD tesseract core 不得回潮（旧包省 3.9MB）', () => {
    const dead = path.join(VENDOR, 'tesseract', 'core', 'tesseract-core-lstm.wasm.js');
    falsy(fs.existsSync(dead), '非 SIMD 的 tesseract-core-lstm.wasm.js 又进包了（3.9MB，且 Chrome 109+ 一律走 SIMD 版）');
    truthy(fs.existsSync(path.join(VENDOR, 'tesseract', 'core', 'tesseract-core-simd-lstm.wasm.js')),
      'SIMD 版 core 不在 —— 兼容兜底引擎（engine=tesseract）会起不来');
  });
};
