# vendor/ · 第三方原样引入的代码

这里的东西**不是我们写的**，一律**原样保留**（不改一行），因此：
* `scripts/meta-check.js` 的目录遍历会**整体跳过 `vendor/`** —— 我们的红线（版本号单一真源、
  不得 `createElement('span')`、不得 `splitText` 等）约束的是我们自己的代码，
  拿它们去卡第三方 bundle 只会产生假红灯。
* 交付包**照常包含** `vendor/`（引擎要在用户机器上跑），所以体积要记在这里。
* **跳过遍历 ≠ 没人管**：第三方资产由 `tests/specs/engine-assets.test.js`（ORT 字节账、
  `vendor/ppu-*` 导入闭包、模型清单）与 `tests/specs/lang-manifest.test.js`（语言包清单）专门守。

> **唯一的两处"不是原样"**：`ppu-paddle-ocr/web/platform.web.js` 与 `web/paddle-ocr.service.web.js`
> 里的 `from "onnxruntime-web"` 被改成 `from "../../ort/ort.wasm.min.mjs"`。
> 原因：MV3 的 CSP 是 `script-src 'self'`，**不许内联 import map**（也不许远程脚本），
> 所以裸 specifier 在浏览器里**无解**，只能补成相对路径。这条补丁由上面的闭包 spec 正面钉住。

## vendor/tesseract/ · 图片文字识别引擎（兼容兜底）

来源：

| 文件 | 来源 | 体积 |
| --- | --- | --- |
| `tesseract.min.js` | `tesseract.js@5` 的 `dist/tesseract.min.js`（UMD 主线程 API） | 66 KB |
| `worker.min.js` | `tesseract.js@5` 的 `dist/worker.min.js`（worker 脚本，用扩展本地 URL 直接 `new Worker`，**不走 blob**） | 121 KB |
| `core/tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@5` 的同名文件（wasm 已**内联**进这个 js，所以只有一个文件要发） | 3.8 MB |
| `lang-manifest.json` | 我们自己写的**清单**（语言包地址 / 体积 / sha256），不是第三方文件 | 1 KB |

为什么只带 `simd+lstm` 一份内核：
* `minimum_chrome_version` 是 109，Chromium 系从 91 起 **SIMD 必然可用** —— 不需要非 SIMD 的兜底内核
  （少带一份 3.8MB）；
* `lstm` 内核只支持 LSTM 模型，而我们用的正是 `tessdata 4.0.0_fast` 系列（LSTM 小模型）。

**语言包不进交付包**（两个包合计约 3.7MB）：运行时按需下载到浏览器本地缓存，或由用户手动导入，
下载地址与 sha256 见 `lang-manifest.json`；开发/回归用 `node scripts/fetch-lang.js` 取到 `release/lang/`。
那份清单里的 `bytes`/`sha256` 是**可对账**的（2026-10-05 抓到过"sha256 对、bytes 错"的一栏）：
`node scripts/check-lang.js`（本地）或 `--live`（站点）逐个核对。
**S2 起档位取消**：清单里只剩快档 `chi_sim` / `eng` 两包（`variants.best` 已删），
"更准"由引擎选择（`imgOcr.engine`）承担，不再靠换大模型。

## vendor/ort/ · ONNX Runtime（主引擎的运行时）

来源：`onnxruntime-web@1.30.0`，**只带 wasm 单线程那一支**，三件缺一不可
（`.mjs` 是 ESM 胶水，它在 import 链上 ⇒ 按 MV3 的 CSP 必须**随包**，不能走远程）：

| 文件 | 来源 | 体积 |
| --- | --- | --- |
| `ort.wasm.min.mjs` | `onnxruntime-web` 的 ESM 入口 | 50,126 B |
| `ort-wasm-simd-threaded.mjs` | 同上的 wasm 装载胶水 | 24,381 B |
| `ort-wasm-simd-threaded.wasm` | 同上的 wasm 本体（SIMD、线程版**按单线程用**） | 14,239,897 B |

合计 **14,314,404 B**（gzip 后约 3.71 MB）。用法上的两条硬约定见
`_stage/wayfinder-ocr/decision-12-engine-selection.md`：先设 `ort.env.wasm.wasmPaths` 与
`numThreads = 1`，**再** `import('ppu-paddle-ocr/web')`（顺序写反会走默认 CDN 路径）；
`executionProviders: ['wasm']`（不用 webgpu）。

## vendor/ppu-paddle-ocr/ + vendor/ppu-ocv/ · PP-OCR 主引擎

来源：`ppu-paddle-ocr@6.6.0` 的**浏览器子集**（`web/` 入口及其 import 闭包）＋ `ppu-ocv@4.0.0` 的画布子集，
共 **30 个文件 81,433 B**。上游包体积很大是因为它带着 node 端与 webgpu 路径 —— 我们只要浏览器 +
WASM 那一条，按 import 闭包逐个拷过来的（少一个文件就是运行时 404，所以闭包完整性由 spec 守）。

**模型不在包里**（`release/models/` 那三件合计约 6.27 MB）：与语言包同理，主引擎首次使用才下载。
清单见 `ppocr/models-manifest.json`（`_base` = 站点 `models/`，带 `bytes` + `sha256` 双闸；
离线也能整套导入）。**注意**：上游 `model-catalogue.js` 里的默认地址指向 Hugging Face、
格式是 `.ort`，与我们发的 `.onnx` 不是一套 —— 引擎侧必须**显式覆盖**模型路径，
否则会在用户机器上出网拉 HF。

## 许可

tesseract.js 与 tesseract.js-core 均为 **Apache-2.0**；其内嵌的 Tesseract 引擎为 **Apache-2.0**。
许可证原文见各自仓库（`naptha/tesseract.js`、`naptha/tesseract.js-core`）。
`onnxruntime-web@1.30.0`（MIT）、`ppu-paddle-ocr@6.6.0` 与 `ppu-ocv@4.0.0`（均 MIT，取自各自 `package.json` 的 `license` 字段）、
PP-OCRv6 模型（Apache-2.0，来自 `PaddlePaddle/PaddleOCR`）—— 许可证原文见各自仓库与 `ppocr/models-manifest.json` 的 `license` 字段。
