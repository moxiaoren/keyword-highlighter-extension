# e2e/ —— 真机回归装置（2026-11-01 入仓）

**为什么在仓里**：以前这套装置住在外面的 `F:\harness\高亮词插件\_e2e\`，交付仓里没有。后果是
`scripts/package.js` 要跨仓去 `../../_e2e` 找它，找不到就只打一行「⚠️ 找不到…跳过真机回归」然后
照常出包 —— CI 上也一样。于是**质量证据只在本机存在**，任何人 clone 下来都无法复现「84 + 153 项全绿」。
搬进来之后，打包与 CI 都能在仓内找到同一份装置。

## 跑法

```bash
cd e2e
npm i                      # 只装 playwright-core（约 14 MB，不下载浏览器）
node run.js --aspects=all  # 全量：内容层 + UI 层
node run.js --aspects=hit  # 只跑命中相关（方面清单见 scripts/regression-areas.js）
node run.js --aspects=none # 不启动浏览器，只做装置自检
```

- 浏览器用的是**本机已装的 Edge/Chrome**（`playwright-core` 不打包浏览器）：
  Windows 默认找 `Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，其余平台依次找
  `google-chrome` / `Chromium`。也可用 `KH_CHROME` 指定可执行文件。
- 扩展根目录：`run.js` 先看 `KH_EXT_DIR`，再判断上一级有没有 `manifest.json`（仓内位置），
  最后回退到老位置 `../work/keyword-highlighter`。所以同一份脚本在仓内和旧工作区都能跑。
- 运行时目录 `_profiles/`（一次性浏览器 profile）与 `_out/`（截图/报告）**不进仓**，已在 `.gitignore`。

## 这里有什么 / 没有什么

| 在仓里 | 说明 |
|---|---|
| `run.js` `t.js` `harness.js` `server.js` `test-config.js` | 装置本体：起 fixtures 服务、启动浏览器、装载扩展、按方面裁组 |
| `content.test.js`（约 258 KB） | 内容层断言：命中/渲染/抓取/OCR/站点门禁 |
| `ui.test.js` | UI 层断言：设置页、内嵌面板、编辑器 |
| `fixtures/*.html`（44 个） | 断言用的静态页面 |

**不在仓里**（留在工作区 `_e2e/`）：`probe-*.js` 约 100 个一次性探针、`_out/`、`_profiles/`、
`_probe-prof*/`。探针是排障时现写现用的，不属于质量门禁。

## 与出包的关系

`scripts/package.js` 的真机回归这一步现在是**双路径**：`e2e/run.js` 优先，老位置 `_e2e/run.js` 回退。
两条都没有时会打印「找不到真机装置…跳过」——那意味着这一版的质量证据是空的，`--skip-e2e` 之外
不该出现这种情况。打包本身**不包含** `e2e/`（`EXCLUDE_DIRS` 里有它）。

## 在 CI 里跑

`.github/workflows/e2e.yml`：手动触发（可传 `aspects` / `full`）、main 上改了 `src/**` `content/**` `background/**` `options/**` `popup/**` `e2e/**` 时自动跑，每周一再跑一次防环境漂移。默认 `--aspects=hit,ui --full`。

- 它**不是发版门禁**（`release.yml` 才是）。红了不挡发版，只在 summary 里留一条 warning。
- 每轮必须产 artifact `e2e-<sha>`（`_out/console.log` + `_out/report.txt` + 截图）。**没有 artifact = 这一轮等于没跑**，不能记成「通过」。
- 判读顺序：先看 `report.txt` 的退出码与末尾摘要；**环境类失败**（装不上 Chromium、卡在 `launchPersistentContext`）与**断言失败**要分开定级——前者修 workflow，后者修代码。
- Linux 上要 `--no-sandbox --disable-dev-shm-usage`（已写进 workflow 的 `KHE_EXTRA_ARGS`）。
- 受沙箱限制的本地环境会在 `spawn EPERM` 处失败（起不了浏览器进程）：那是权限不是装置，交给 CI。
