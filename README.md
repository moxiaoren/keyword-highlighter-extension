# 关键词高亮 · 浏览器扩展

在任意网页上高亮你关心的关键词；命中后可以把同一张表里的字段自动抓成结构化的「重要笔记」面板。
适用于 **Edge / Chrome**，免安装免登录，**所有配置与抓取内容只存在浏览器本地**。

- 🌐 项目主页（安装包 + 自动更新源）：<https://moxiaoren.github.io/keyword-highlighter-extension/>
- 📦 历史版本 / 每个版本的改动：<https://github.com/moxiaoren/keyword-highlighter-extension/releases>
- 🧩 当前测试版：见主页或 `latest-beta.json`；稳定通道目前为 `1.51.0`

---

## 两个通道，都能下载

| 通道 | 当前版本 | 直接下载 | 更新清单 |
|---|---|---|---|
| **稳定版**（日常用） | 见 `update.xml`（当前 `1.51.0`） | [.crx](https://moxiaoren.github.io/keyword-highlighter-extension/release/keyword-highlighter-extension-1.51.0.crx) | [`update.xml`](https://moxiaoren.github.io/keyword-highlighter-extension/update.xml) |
| **测试版**（先试新功能） | 见 `latest-beta.json` | [.crx](https://moxiaoren.github.io/keyword-highlighter-extension/keyword-highlighter-beta-v1.99.99.20.crx) · [.zip](https://moxiaoren.github.io/keyword-highlighter-extension/keyword-highlighter-beta-v1.99.99.20.zip) | [`update-beta.xml`](https://moxiaoren.github.io/keyword-highlighter-extension/update-beta.xml) |

- 项目主页每次打开都会用清单里的**实际版本号**把上面的链接刷新一遍：<https://moxiaoren.github.io/keyword-highlighter-extension/>
- **一键安装脚本（两个通道通用）**：**[`kh-autoupdate.bat`](https://moxiaoren.github.io/keyword-highlighter-extension/kh-autoupdate.bat)** —— 运行后菜单里选 `Edge / Chrome` × `稳定版 / 测试版`，装完自动静默更新。
- 两个通道是**两个扩展**（ID 不同），可以同时安装；测试版晋级稳定版后需要换装一次。
- 稳定版历史安装包：<https://github.com/moxiaoren/keyword-highlighter-extension/releases>（测试版不进 Releases，只在上面两个通道分发）。

## 一键安装（推荐）

1. 下载 **[`kh-autoupdate.bat`](https://moxiaoren.github.io/keyword-highlighter-extension/kh-autoupdate.bat)**
2. **右键 → 以管理员身份运行**（要写机器级注册表，让浏览器认这个扩展）
3. 菜单里选：Edge / Chrome × **稳定版 / 测试版**
4. **完全退出浏览器再启动**（有时要启动两次）—— 之后线上发新版会**自动静默更新**

> 手动安装：下载上表里的 `.crx` 拖进 `edge://extensions`（或 `chrome://extensions`）的开发者模式页面
> （测试版也可以下 `.zip` 解压后用「加载解压缩的扩展程序」）；
> 手动装不会自动更新，每次都要重新装。

## 它做什么

| 能力 | 说明 |
|---|---|
| 关键词高亮 | 只做**视觉高亮**（Range + `CSS.highlights`），**不改动网页 DOM**，页面自己的样式与脚本不受影响 |
| 组合词 | 给核心词加一个「定位限制」：左格标题命中后，右格（或该列）里的核心词才算命中；上下格（表头 × 数据行）同理 |
| 跨文本节点命中 | 页面把词拆成 `审<span>核</span>不通过` 也照样命中，整词上色、两段各自颜色都保留 |
| 后续字段抓取 | 命中后顺带抓同表里的字段，渲染成结构化表格；支持多行 / 合并单元格 / 图片（`字段#图` 仅图片、`字段#3` 只取前 3 张） |
| 重要笔记面板 | 勾「重要」的关键词把抓到的内容汇总成面板，可拖动 / 收起；图片可点开看大图（缩放 / 旋转 / 同格翻页） |
| 图片文字识别 | 组合词可开「识别图片文字」：值是一张截图（文字不在网页里）时，识别标题词定位到的右格 / 整列数据格里的图片，**图里出现关键词也算命中**；结果进面板的「🖼 图片命中」独立分区（不产生文字高亮）。识别**全在本机**，语言包按需下载或手动导入，见下 |
| 备注卡片 / 悬停 | 给词写 Markdown 备注，点一下或悬停即看 |
| 分组与配色 | 底色 / 文字颜色（20 色板 + 可拖动取色器 + 色值输入）；分组可统一配色与图片尺寸 |
| 罕见字规则 | 关键词填 `hjz#` 即对「罕见汉字」着色，也可作为组合词的核心词 |
| 站点规则 | 黑白名单（含网址级）、临时禁用本站、全局开关 |

## 图片文字识别（可选能力，默认不启用）

表格里的「值」经常是一张截图（供应商名称、金额、结论），文字不在网页里，纯文本匹配永远命中不了。
给**组合词**勾上「识别图片文字」后：

1. 插件会识别「标题词定位到的那一格」（左右格＝右格；上下格＝整列数据格）里的图片（每个锚点默认 4 张，可改 1～20）；
2. 识别出的文字里出现该关键词 → 算一次**图片命中**，显示在页面的「重要笔记」面板里（**🖼 图片命中**独立分区，默认折叠）；
3. 图片里的字**不会**在网页上画高亮，也不影响原有文本命中的口径。

设置页 →「图片识别」里准备语言包（**这是唯一会联网的动作，也可完全离线**）：

- **下载**：简体中文 ≈1.7MB / 英文 ≈1.9MB，从本项目主页 `lang/` 取，下完做 **sha256 校验**，不一致直接丢弃；下载一次长期复用（缓存命中约 0.4 秒起引擎）。
- **手动导入**：把 `chi_sim.traineddata.gz` / `eng.traineddata.gz` 选进来，**全程零联网**（内网/离线机用这条）；来源：`https://tessdata.projectnaptha.com/4.0.0_fast/`。
- 纯英文关键词只加载英文包；引擎空闲约 90 秒自动释放内存。

隐私与权限：图片**不上传**，识别在本机完成；默认只识别同源 / `data:` / 页面自己声明过 CORS 的图片，
其它网站的图片要在设置页**按站点**授权（不新增浏览器权限）。因为引擎要跑在扩展自己的 offscreen 文档里，
**最低版本要求从 Chrome/Edge 105 提到 109**。

## 自检与开发

```bash
node tests/run.js                 # 单元测试（260 项，始终全跑）
node scripts/meta-check.js        # 机械红线（46 项：纯视觉不改 DOM / 单源字段 / 私钥不入包 …）
node tests/integrity.js           # 资源引用 / id 双向 / CSS 变量 / manifest
cd _e2e && node run.js            # 真浏览器回归（playwright-core + 系统 Edge；100 项）
cd _e2e && node run.js --aspects=hit,interact   # 按「方面」裁剪；--only=<组名> 定点验证
cd _e2e && node probe-perf-mem.js 2000          # 性能体检（阶段耗时 / 空闲重建 / 堆增长）
cd _e2e && node probe-ocr12.js                  # 图片识别：从线上真实地址下载语言包 → 校验 → 识别的生产路径验收
node scripts/fetch-lang.js                      # 取 OCR 语言包到 release/lang（真浏览器回归的图片识别组要用）
```

`node scripts/package.js` 是出包闸门：meta-check → 单测 → integrity → 真浏览器回归（按改动涉及的
**方面**自动选范围）→ 打包；任一红灯直接不出包。

> 受影响的项目要跑回归：改动涉及命中的跑 `hit`、渲染的跑 `visual`、交互的跑 `interact`、
> 抓取的跑 `fetch`、站点门禁的跑 `site`、管理端的跑 `ui`；不好判断就全量。

## 发版流程

```bash
node scripts/bump-version.js beta        # 测试版：第 4 位 +1（1.99.99.15 → 1.99.99.16）
# 改 src/ui/changelog.js 写本版说明（改完先跑 node scripts/check-changelog-quotes.js）
node scripts/release-beta.js             # 门禁 + 打包 + 签名 crx + 生成 update-beta.xml
node scripts/publish-gh.js               # 推到 gh-pages（主页 / 安装包 / 更新清单）
node scripts/gh-release.js               # 建/更新这个版本的 GitHub Release
node scripts/gh-release.js --all         # 补齐历史版本（幂等）
```

- 测试版跑在 `1.99.99.x` 这条线上，最终稳定版**正好落在 `2.0.0`**；稳定版：`bump-version.js release`。
- 两通道是**两个扩展**（ID 不同），可同时安装；测试版晋级稳定版后需换装一次。

## 目录结构

```
manifest.json         扩展清单（MV3）
src/core/             内核：scanner（扫描/跨节点）· compiler · arbiter（重叠裁决）· registry · renderer · scheduler
src/features/         combo（单元格组合词）· fetch（抓取）· important-note（重要笔记面板 / 灯箱）· note-card · rare-char
src/ui/               管理端组件（三端共用）：fieldmap（字段单源）· components（控件工厂）
content/ background/ options/ popup/ welcome/   各端入口
tests/                单元测试 + 机械红线 + 完整性检查
_e2e/                 真浏览器回归、夹具与探针（不在交付包内）
scripts/              门禁 / 打包 / 发布 / 体检工具
```

## 隐私

不联网收集任何数据：关键词、备注、抓取到的内容都存在浏览器的 `chrome.storage.local` 里，
只有「自动更新」会去项目主页读一次版本清单。

## 许可

个人项目，未上架扩展商店；如需在团队内分发，请使用上面的 Release 产物自行部署。
