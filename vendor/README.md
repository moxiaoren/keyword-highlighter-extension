# vendor/ · 第三方原样引入的代码

这里的东西**不是我们写的**，一律**原样保留**（不改一行），因此：
* `scripts/meta-check.js` 的目录遍历会**整体跳过 `vendor/`** —— 我们的红线（版本号单一真源、
  不得 `createElement('span')`、不得 `splitText` 等）约束的是我们自己的代码，
  拿它们去卡第三方 bundle 只会产生假红灯。
* 交付包**照常包含** `vendor/`（引擎要在用户机器上跑），所以体积要记在这里。

## vendor/tesseract/ · 图片文字识别引擎

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
`node scripts/check-lang.js`（本地）或 `--live`（站点）逐个核对；高精度档的两个包没有官方可下载源，
要本地副本用 `node scripts/check-lang.js --fetch`。

## 许可

tesseract.js 与 tesseract.js-core 均为 **Apache-2.0**；其内嵌的 Tesseract 引擎为 **Apache-2.0**。
许可证原文见各自仓库（`naptha/tesseract.js`、`naptha/tesseract.js-core`）。
