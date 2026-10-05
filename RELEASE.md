# 发版手册（测试版 → 稳定版）

## 通道模型

```
稳定通道（所有用户）  update.xml（浏览器读它升级）+ latest.json（人看 / 首页与脚本用）
测试通道（测试者）    update-beta.xml（测试版那个包的浏览器读它）+ latest-beta.json（人看 / edge-load-beta.js 用）
```

> 2026-10-05 起**扩展内部不再自己检查更新**：插件弹窗只剩「稳定版 ⇄ 测试版」通道开关
> （只写本机 `chrome.storage.local.khUpdateChannel`，不下载任何东西）。升级一律交给浏览器自己的
> crx 自动更新通道 —— 稳定版读 `update.xml`，测试版那个包读 `update-beta.xml`。

- **测试版 = 提前发出的"下一个版本号"**。Chrome 的 `manifest.version` 只允许 `x.y.z` / `x.y.z.w`，
  **不允许 `-beta` 后缀**，所以不要用后缀表达"预发布"：稳定发 2.1.0，测试就发 2.1.1，
  测好了用**同一个版本号**再走一遍稳定通道即可。
- **测试版是"另一个扩展"，两条通道彻底分开**（`scripts/release-beta.js` 的整套设计）：
  正式版用 `release/key.pem` 签名，ID `kpakjonpfookjchkfinfhkojiamjcedj`；
  测试版用 `release/key-beta.pem` 签名，ID `ohjcaheamdifcldcofpblbejlpmgnhjc`。
  打包测试版时脚本会**改三处 manifest**：`key`（固定测试版 ID）、`update_url`（指向 `…/update-beta.xml`）、
  `version_name`（`x.y.z beta`，扩展据此知道自己该读测试清单）。
  ⇒ 测试版**有自己的一条 crx 自动更新通道**（`update-beta.xml`），可以和正式版同时装、各自更新。
- ⚠️ 代价（必须告诉测试者）：测试版是另一个扩展 ⇒ **晋级正式版后不会被自动升级**，要卸载测试版再装正式版；
  它也有**自己的 storage** ⇒ 关键词/分组是空的，需要先从正式版导出再导入。
- **两条通道的清单与更新文件互不触碰**：测试版发布只写 `latest-beta.json` + `update-beta.xml`，
  **绝不碰** `latest.json` / `update.xml` —— 那两个是稳定版专用文件，改了会把测试版推给所有用户 ✗。

## 自动化脚本一览

| 脚本 | 作用 | 典型用法 |
|---|---|---|
| `scripts/release.js` | **稳定版完整流水线**：门禁 → 打包 → 签名 crx → 生成 `latest.json` / `update.xml` → 汇总 | `node scripts/release.js --channel stable`（或 `--promote`） |
| `scripts/release-beta.js` | **测试版流水线**（与正式版完全分离）：复用 `package.js` 的门禁与打包 → 改 manifest 三处 → 重打成测试版 zip → 用测试版密钥签 crx → 写 `latest-beta.json` / `update-beta.xml` | `node scripts/release-beta.js` |
| `scripts/update-config.js` | **只重生成更新配置**（latest.json / latest-beta.json / update.xml / update-beta.xml），不重新打包 | `node scripts/update-config.js --channel stable --zip <zip> --crx <crx>` |
| `scripts/publish-gh.js` | 推到 gh-pages（**不需要 git**，走 GitHub API）。**测试版必须加 `--beta-only`**：否则它还要去收集稳定版清单、而稳定版产物不在本机 ⇒ 直接中止；语言包没变时加 `--skip-lang`（gh-pages 建 tree 用 `base_tree`，不发＝原地保留） | 测试版：`GH_TOKEN=… node scripts/publish-gh.js --beta-only`<br>稳定版：`GH_TOKEN=… node scripts/publish-gh.js` |
| `scripts/gh-release.js` | **线上 Release（只放稳定版）**：测试版**不建** Release；稳定版的说明 = **这一段测试版要点的汇总** + 本版正式说明；附件挂 crx（`--with-zip` 发版时多挂 zip）、幂等。`--prune-test` 删掉所有测试版 Release（含 tag），`--prune-above=<ver>` 删版本号大于该值的 | `node scripts/gh-release.js`（稳定版发完跑） |
| `scripts/check-changelog-quotes.js` | 改完 changelog **先跑它**：文案行必须恰好 2 个半角双引号（正文用「」），否则整个文件语法错 | `node scripts/check-changelog-quotes.js` |
| `scripts/package.js` | 只打包 zip + `latest.json`（门禁 + 真机回归也在这一步） | `node scripts/package.js` |
| `.github/workflows/release.yml` | CI：打 tag 自动发布 —— **tag 名带 `-beta` ⇒ 测试通道**（走 `release-beta.js`），否则稳定通道；tag 里的版本必须与 `manifest.json` 一致 | 测试版 `git tag v2.0.1.3-beta && git push --tags`<br>稳定版 `git tag v2.0.2 && git push --tags` |

> **Release 的"最新版"口径**：`gh-release.js` 把**当前 manifest 版本**建成正式 Release（不带 pre-release 标记），
> 否则 Releases 页的「Latest」会停在很久以前那个版本上（实测踩到：Latest 一直显示 v1.6.12）。
> 历史版本仍是 pre-release。测试线换到 1.99.x 之后，**2.x 的旧测试版 Release 属于无效内容**
> （版本号比最终要落的稳定版 2.0.0 还大，留着只会让人以为"还有更高的版本"），已用
> `node scripts/gh-release.js --prune-above=1.99.99.15` 清掉（先 `--dry` 看一眼要删什么）。

### release.js 参数

| 参数 | 含义 |
|---|---|
| `--channel beta` | **已移除（2026-10-05）**：本脚本只发稳定版，传它**直接报错**并指路（绝不静默当成"发稳定版"）。测试版唯一实现是 `scripts/release-beta.js`（CI 也走它，见 `release.yml:126`） |
| `--channel stable` / `--promote` | 发稳定通道（写 `latest.json` + `update.xml`） |
| `--with-crx` | 已无意义（旧参数，静默忽略）：稳定通道总是打 crx；测试版 crx 由 `release-beta.js` 出 |
| `--key <pem>` | 指定签名密钥（默认 `release/key.pem`；**必须与线上同一把**） |
| `--no-crx` | **已移除（2026-10-05）**：发版一律出 crx（它是唯一交付物），传它**直接报错**并指路 |
| `--with-zip` | 额外把 zip 放进 `release/`。**默认不产出**：zip 只在明确要的时候才给；不带它时 `latest.json` 的 `zip`/`sha256` 留空（站点不会多一个 404 地址，`publish-gh.js` 的预检也不会因缺文件中止） |
| `--skip-gates` | 跳过门禁（仅重打产物时用） |

### 一条命令从零到上线

```bash
# 测试版（release-beta.js 出测试版 zip + crx + latest-beta.json + update-beta.xml）
node scripts/release-beta.js
node scripts/publish-gh.js --beta-only --skip-lang   # 语言包有变时去掉 --skip-lang

# 测好后晋级稳定版（同一个版本号，走另一条通道）
node scripts/release.js --promote --key release/key.pem
node scripts/publish-gh.js
```

> 测试版与稳定版是**两个扩展**（各自 ID、各自 storage、各自更新源）——晋级不会自动搬过去，
> 测试者需要卸载测试版再装正式版（装之前先从正式版把关键词导出 JSON、装好再导入）。

### ⚠️ 一个必须知道的坑：重新打包 = 不同字节

zip 里带时间戳，**同一次构建重新打包，哈希也会变**。所以：

- `latest.json` 里的 `sha256` 只对**那一次打出来的那个文件**有效；
- **不要**在打包之后单独跑 `update-config.js` 指向另一个包 —— 哈希会对不上，用户端校验会直接拒绝 ✗；
- 正确顺序永远是：**打包 → 立刻生成配置（release.js 已经这么做了）→ 上传同一批文件**；
- 反过来也成立：已经上传的包不要重新打，否则线上清单与线上文件会不一致。
## 怎么发测试版

```bash
node scripts/bump-version.js beta     # 先把版本号推一格（多轮测试版每轮都做）
node scripts/release-beta.js          # 产出 release/keyword-highlighter-beta-v<ver>.{zip,crx}
                                      #   + release/latest-beta.json + release/update-beta.xml
node scripts/publish-gh.js --beta-only --skip-lang   # 推 gh-pages（需要 GH_TOKEN）
```

测试者这边：打开扩展弹窗 → 点「🔀 稳定版」→ **再点一下确认** → 切到「测试版」。
（2026-10-05 起插件入口**不再有线上更新**：没有「检查更新」按钮、没有提示条、没有下载；
这个开关只把选择写进本机 `chrome.storage.local.khUpdateChannel`，升级始终由浏览器自己的 crx 自动更新通道完成。）

## 测好之后晋级稳定版

```bash
node scripts/release.js --promote             # 同一份构建，改发到 latest.json + update.xml
node scripts/publish-gh.js
```

`--promote` 等价于 `--channel stable`：会更新 `latest.json`（**默认只有 crx 字段**）与 `update.xml`（crx 自动更新源），
并顺带跑一次 `scripts/release-beta.js --skip-gates`，把**同版本号的测试包**也留在 `release/` 里（历史沿用）。
**注意**：更新 `update.xml` 需要**当初发布时那把 `key.pem`**（扩展 ID 由它决定，换密钥 Chrome 会拒绝更新）：

```bash
node scripts/release.js --promote --key D:\path\key.pem
```

没有密钥时脚本会**主动中止**并说明原因，不会用错密钥打出无效 crx。

## 多轮测试版（测好几轮再晋级）——注意事项

**更新是按"版本号变大"判断的**：所以每发一轮测试版，都必须先把 `manifest.version` 往上推一格 ✗，
否则已经装了上一轮测试版的人会看到「已是最新」，永远收不到新一轮。

```bash
node scripts/bump-version.js beta       # 2.1.0 → 2.1.0.1（只动第四位；每轮测试版都做一次）
node scripts/release-beta.js            # 可选：先 --skip-e2e 应急跳过真机回归
node scripts/publish-gh.js --beta-only --skip-lang
```

| 轮次 | manifest.version | 发到 | 谁收到 |
|---|---|---|---|
| 测试 #1 | 2.1.0.1 | `latest-beta.json` + `update-beta.xml` | 装了**测试版那个扩展**的人（自动更新走测试版自己的 crx 源） |
| 测试 #2 | 2.1.0.2 | 同上 | 同上 |
| 测试 #3 | 2.1.0.3 | 同上 | 同上 |
| **晋级** | **2.1.1**（`bump-version.js release`） | `latest.json` + `update.xml` | 全体正式版用户（**测试版用户要手动换装**，见上文"另一个扩展"） |

### 两条铁律

1. **发测试版永远只写 `latest-beta.json` + `update-beta.xml`** —— `scripts/release-beta.js` 已经保证这点：
   它不碰 `latest.json` / `update.xml`。所以稳定用户与正式版的 Chrome 自动更新完全不受影响 ✓
2. **晋级时用"最后一个测试版的版本号"** —— 若改用更小的号（例如拿 2.1.1 去晋级、而测试版已经到 2.1.3），
   装了 2.1.3 的测试者会被判成「已是最新」，永远收不到稳定版 ✗

### 版本号不变量（三道代码门，已 fail-closed）

唯一硬约束：**稳定版号必须 > 线上测试版号**（否则装过测试版的人永远收不到稳定版 —— 浏览器不降级）。
它不靠人记，靠三道代码门兜住：

1. **`release.js` 发稳定通道前对比线上 `latest-beta.json`**：比它低 ⇒ `die` 中止。
   **取不到线上测试版版本（镜像挂了 / 网络不通）也中止** —— 2026-10-04 起 fail-closed，
   以前这里只打一行「跳过回退检查」就继续发，等于把铁律交给运气 ✗。
   确实要强行发（只面向全新安装渠道）⇒ 显式加 `--force-version`。
2. **CI 的「版本段数闸」**（`release.yml`）：稳定通道要求三段号 `x.y.z`，测试通道要求四段号 `x.y.z.w`
   —— 挡住「把四段测试号当稳定版推给全体」这类事故。
3. **`scripts/check-channels.js` 的版本不变量**（CI 发布前必跑）：**测试版前三段不得高于**当前稳定版前三段
   （相等＝正线 `2.0.1 → 2.0.1.1 → …`；更低＝旧线，无害）。这道门守的是**反方向**：
   测试版一旦跨到下一个稳定版的前缀（稳定版才 2.0.1 却发了 2.0.2.1），装过它的机器就永远收不到 2.0.2。
   落点：CI 的「校验两条更新通道」步在 `peaceiris` 部署**之前** ⇒ 判失败即拒绝发布。
   （发布前先跑 `node scripts/sync-mirrors.js`，避免仓库镜像落后于线上导致误判。）

配套记法：`node scripts/bump-version.js release` 从测试版号**跳三段号的第三位**
（`2.0.1.1 → 2.0.2`），所以「测试版永远在下一个稳定版之下」这个不变量**由造号规则自己保证**；
下一轮测试版再从 `2.0.2.1` 起 ✓。反过来，`bump-version.js beta` 只动第四位（`2.0.2 → 2.0.2.1`），
也永远追不上下一格稳定版 ✓。

### 测试者怎么切通道 / 切回

- **装了「测试版」那个扩展的人不用切**：那个包被 `version_name = "x.y.z beta"` 钉死在测试通道，
  弹窗里的通道徽标是**只读**的（显示「🔒 测试版」），它的自动更新走 `update-beta.xml`。
- **只有正式版扩展**才需要切：扩展弹窗 → 点「🔀 稳定版」这个按钮（**两次点击制**：第一次只问
  「❓ 切到测试版？」，第二次才真的写盘；6 秒不点自动取消）。它只影响本机，存在
  `chrome.storage.local.khUpdateChannel`。**切换本身不下载任何东西** —— 它只改变本机记录；
  装/升级始终由浏览器按各自的 crx 更新源完成（稳定版读 `update.xml`，测试版那个包读 `update-beta.xml`）。
- 想换成测试版**那个扩展**（另一个 ID、另一条自动更新源），得去首页手动装它，不是切一下开关就行。
- 切回稳定版后，若本机版本号比线上稳定版高（装过四段测试号），会显示「已是最新」——这属于正常，
  等正式版版本号追上来即可。
## 每次发版后自检（30 秒）

1. 打开对应清单：`…/latest.json` 或 `…/latest-beta.json`，`sha256` 应与本地 `release/` 里的一致
   （稳定版默认只发 crx ⇒ `zip`/`sha256` 是空的，属正常；加了 `--with-zip` 才两者都有）；
2. 稳定版另看 `…/update.xml`、测试版看 `…/update-beta.xml`：`version` 应是新版本、
   `codebase` 指向线上那个带版本号的 crx（测试版的是 `keyword-highlighter-beta-v<ver>.crx`）；
3. 稳定版 crx 真的能装：下载 `codebase` 那个文件，拖进浏览器，扩展详情页版本号应变成新版本；
4. GitHub Pages 有 CDN 缓存，最长可能几十分钟才生效，属正常；
5. OCR 语言包在站点上与清单对得上：`node scripts/check-lang.js --live`
   （逐包核对 `bytes` + `sha256`；清单是"体积/sha256 唯一真源"，2026-10-05 就是靠这道对账
   发现两份高精度包的 `bytes` 记错了 —— 用户会在设置页看到错的下载体积）。

## 安全约定（已由代码兜底）

- 交付包**永远不含** `key.pem` / `*.key` / `*.crx`（`scripts/package.js` 的排除规则 + meta-check 红线）；
- 发布器只写 `gh-pages` 分支、只读 `release/`、拒绝上传任何密钥文件、用 `base_tree` 保留站点现有文件；
- 私钥只应存在于本机 `release/key.pem`（正式版）与 `release/key-beta.pem`（测试版），
  或 CI 的 Secret（`KH_KEY_PEM` / `KH_KEY_BETA_PEM`）里 —— 换密钥 = 改扩展 ID = 已装用户永远收不到更新 ✗。

---

## 附：让"非商店扩展"在 Edge / Chrome 上自动安装 + 自动更新（已实测跑通）

**重要更正**：本文件早期版本里写过"Edge 不可能做非商店扩展的强制安装" ✗ —— **这个结论是错的** ✗。
错在只试了 `ExtensionInstallForcelist`（它确实会被 Edge 判 `[BLOCKED]`），而**真正生效的是另一个键**：

| 注册表键 | Edge | Chrome | 说明 |
|---|---|---|---|
| `HKLM\SOFTWARE\<厂商>\<浏览器>\Extensions\<ID>\update_url` | **✓ 生效** | **✓ 生效** | ★ **就是它让浏览器自动安装并持续更新**（"传统外部扩展"机制） |
| `HKLM\SOFTWARE\Policies\<厂商>\<浏览器>\ExtensionInstallAllowlist\<槽位>` | ✓ 需要 | ✓ 需要 | 非商店扩展必须进白名单，否则会被拒装 |
| `HKLM\SOFTWARE\Policies\<厂商>\<浏览器>\ExtensionInstallForcelist\<槽位>` | ✗ 显示 `[BLOCKED]`（无害） | ✓ 有效 | Edge 上留着不影响；Chrome 上它是主力 |

其中 `<厂商>\<浏览器>` 取 `Microsoft\Edge` 或 `Google\Chrome`；`Extensions` 键还要在
`WOW6432Node` 下再写一份（32 位视图）—— 两个都写才不会因浏览器位数不同而漏。

### 一键脚本（仓库/站点里的 `kh-autoupdate.bat`）

```
双击（会自动请求管理员）→ 菜单选择：
  [1] Edge   + 测试版      [2] Edge   + 稳定版
  [3] Chrome + 测试版      [4] Chrome + 稳定版
  [5] 两浏览器 + 测试版     [6] 全部（两浏览器 × 稳定版 + 测试版）
  [7] 卸载（移除我们所有条目）   [8] 状态
命令行：kh-autoupdate.bat install <edge|chrome|both> <stable|beta|all>
        kh-autoupdate.bat status | remove
```

约定：**槽位 8 = 稳定版、9 = 测试版** —— 绝不改动其它扩展的条目 ✓。
写完后**完全退出浏览器再启动** → 扩展会自动装上，之后线上发版即自动更新 ✓。

这个 `.bat` 的**唯一权威副本是 `scripts/kh-autoupdate.bat`**：本地发布时由 `scripts/publish-gh.js`
把权威副本同步进 `release/`；CI 路径两条通道各管一次（稳定通道由 `release.js` 同步，测试通道由工作流
显式补拷，见 `release.yml:127-129`），并在发布到 gh-pages 前断言两者 sha256 相同、不同即失败 ——
所以 gh-pages 上的副本不会在 CI 路径下悄悄冻结在旧版本。

### 三个坑（都踩过）

1. **`.bat` 必须 ASCII 内容 + CRLF 行尾** ✗ —— 中文内容会随控制台代码页解析错乱，
   纯 LF 行尾会被 cmd 拆行（实测报出"半个单词"的怪错）。所以脚本里所有提示都是英文，
   要中文名**直接重命名文件**即可（内容不引用自身文件名）。
2. **卸载会删除扩展自己的 storage** ✗（关键词/分组会丢）—— 卸载前先到设置页导出 JSON 备份。
3. **同一 ID 的"解压加载"版本会盖过 crx 版本** ✗ —— 若 `edge://extensions` 里还留着
   「已解压的扩展程序」那条，运行中的代码是它，自动更新装了也看不出效果；
   要纯自动更新链路，先移除那条解压加载的。

