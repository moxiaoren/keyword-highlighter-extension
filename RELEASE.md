# 发版手册（测试版 → 稳定版）

## 通道模型

```
稳定通道（所有用户）  latest.json        所有人都读它；现在线上 = 1.51.0
测试通道（测试者）    latest-beta.json   只有把更新通道切到「测试版」的人读它
```

- **测试版 = 提前发出的"下一个版本号"**。Chrome 的 `manifest.version` 只允许 `x.y.z` / `x.y.z.w`，
  **不允许 `-beta` 后缀**，所以不要用后缀表达"预发布"：稳定发 2.1.0，测试就发 2.1.1，
  测好了把**同一份构建**再发到稳定通道即可（版本号不用改）。
- **crx 通道（Chrome 自动更新）无法分通道**：`update_url` 是写死在 manifest 里的一个地址。
  所以测试版**只走 zip 通道更新**（点更新 → 校验 SHA256 → 下载 → 拖入 chrome://extensions）。
- 发布脚本对测试通道**不会生成 update.xml**：那是稳定版专用文件，改了会把测试版推给所有用户。

## 自动化脚本一览

| 脚本 | 作用 | 典型用法 |
|---|---|---|
| `scripts/release.js` | **完整流水线**：门禁 → 打包 → 签名 crx → 生成配置 → 汇总 | `node scripts/release.js --channel beta --with-crx` |
| `scripts/update-config.js` | **只重生成更新配置**（latest.json / latest-beta.json / update.xml），不重新打包 | `node scripts/update-config.js --channel stable --zip <zip> --crx <crx>` |
| `scripts/publish-gh.js` | 推到 gh-pages（**不需要 git**，走 GitHub API） | `GH_TOKEN=… node scripts/publish-gh.js` |
| `scripts/gh-release.js` | **线上 Release（只放稳定版）**：测试版**不建** Release；稳定版的说明 = **这一段测试版要点的汇总** + 本版正式说明；附件挂 zip+crx、幂等。`--prune-test` 删掉所有测试版 Release（含 tag），`--prune-above=<ver>` 删版本号大于该值的 | `node scripts/gh-release.js`（稳定版发完跑） |
| `scripts/check-changelog-quotes.js` | 改完 changelog **先跑它**：文案行必须恰好 2 个半角双引号（正文用「」），否则整个文件语法错 | `node scripts/check-changelog-quotes.js` |

> **Release 的"最新版"口径**：`gh-release.js` 把**当前 manifest 版本**建成正式 Release（不带 pre-release 标记），
> 否则 Releases 页的「Latest」会停在很久以前那个版本上（实测踩到：Latest 一直显示 v1.6.12）。
> 历史版本仍是 pre-release。测试线换到 1.99.x 之后，**2.x 的旧测试版 Release 属于无效内容**
> （版本号比最终要落的稳定版 2.0.0 还大，留着只会让人以为"还有更高的版本"），已用
> `node scripts/gh-release.js --prune-above=1.99.99.15` 清掉（先 `--dry` 看一眼要删什么）。
| `scripts/package.js` | 只打包 zip + latest.json | `node scripts/package.js` |
| `.github/workflows/release.yml` | CI：打 tag 自动发布 | `git tag v2.1.0 && git push --tags` |

### release.js 参数

| 参数 | 含义 |
|---|---|
| `--channel beta` | 发测试通道（只写 `latest-beta.json`，**不生成 update.xml**） |
| `--channel stable` / `--promote` | 发稳定通道（写 `latest.json` + `update.xml`） |
| `--with-crx` | 测试通道也打 crx（**仅供手动安装**，不作为更新通道） |
| `--key <pem>` | 指定签名密钥（默认 `release/key.pem`；**必须与线上同一把**） |
| `--no-crx` | 完全跳过 crx（只发 zip 通道） |
| `--skip-gates` | 跳过门禁（仅重打产物时用） |

### 一条命令从零到上线

```bash
# 测试版（含一个给人手动装的 crx）
node scripts/release.js --channel beta --with-crx
node scripts/publish-gh.js

# 测好后晋级稳定版（同一份构建）
node scripts/release.js --promote --key release/key.pem
node scripts/publish-gh.js
```

### ⚠️ 一个必须知道的坑：重新打包 = 不同字节

zip 里带时间戳，**同一次构建重新打包，哈希也会变**。所以：

- `latest.json` 里的 `sha256` 只对**那一次打出来的那个文件**有效；
- **不要**在打包之后单独跑 `update-config.js` 指向另一个包 —— 哈希会对不上，用户端校验会直接拒绝 ✗；
- 正确顺序永远是：**打包 → 立刻生成配置（release.js 已经这么做了）→ 上传同一批文件**；
- 反过来也成立：已经上传的包不要重新打，否则线上清单与线上文件会不一致。
## 怎么发测试版

```bash
node scripts/release.js --channel beta        # 产出 release/latest-beta.json + zip
node scripts/publish-gh.js                    # 推到 gh-pages（需要 GH_TOKEN）
```

测试者这边：打开扩展弹窗 → 点「稳定版」这个链接 → 切到「测试版」→ 自动重新检查更新。
（该开关只影响本机，存在 `chrome.storage.local.khUpdateChannel`。）

## 测好之后晋级稳定版

```bash
node scripts/release.js --promote             # 同一份构建，改发到 latest.json + update.xml
node scripts/publish-gh.js
```

`--promote` 等价于 `--channel stable`：会同时更新 `latest.json`（zip 通道）与 `update.xml`（crx 通道）。
**注意**：更新 `update.xml` 需要**当初发布时那把 `key.pem`**（扩展 ID 由它决定，换密钥 Chrome 会拒绝更新）：

```bash
node scripts/release.js --promote --key D:\path\key.pem
```

没有密钥时脚本会**主动中止**并说明原因，不会用错密钥打出无效 crx。

## 多轮测试版（测好几轮再晋级）——注意事项

**更新是按"版本号变大"判断的**：所以每发一轮测试版，都必须先把 `manifest.version` 往上推一格 ✗，
否则已经装了上一轮测试版的人会看到「已是最新」，永远收不到新一轮。

```bash
node scripts/bump-version.js patch     # 2.1.0 → 2.1.1（每轮测试版都做一次）
node scripts/release.js --channel beta # 可选加 --with-crx 给人手动装
node scripts/publish-gh.js
```

| 轮次 | manifest.version | 发到 | 谁收到 |
|---|---|---|---|
| 测试 #1 | 2.1.1 | `latest-beta.json` | 只切到测试通道的人 |
| 测试 #2 | 2.1.2 | `latest-beta.json` | 同上 |
| 测试 #3 | 2.1.3 | `latest-beta.json` | 同上 |
| **晋级** | **2.1.3（最后一个）** | `latest.json` + `update.xml` | 所有人 |

### 两条铁律

1. **发测试版永远只写 `latest-beta.json`** —— `release.js --channel beta` 已经保证这点：
   它**不生成 update.xml**，也不碰 `latest.json`。所以稳定用户与 Chrome 自动更新完全不受影响 ✓
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

扩展弹窗 → 「检查更新」旁边那个通道徽标 → 点一下在 **稳定版 ⇄ 测试版** 之间切换（只影响本机）。
切回稳定版后，若他装的测试版版本号比线上稳定版高，会显示「已是最新」——这属于正常，
等他下次装稳定版（或等稳定版号追上来）即可。
## 每次发版后自检（30 秒）

1. 打开对应清单：`…/latest.json` 或 `…/latest-beta.json`，`sha256` 应与本地 `release/` 里的一致；
2. 稳定版另看 `…/update.xml`：`version` 应是新版本、`codebase` 指向 `release/` 下那个带版本号的 crx；
3. 扩展 popup 点「检查更新」：对应通道应提示有新版本，tooltip 显示更新源 / 发布时间 / 说明；
4. GitHub Pages 有 CDN 缓存，最长可能几十分钟才生效，属正常。

## 安全约定（已由代码兜底）

- 交付包**永远不含** `key.pem` / `*.key` / `*.crx`（`scripts/package.js` 的排除规则 + meta-check 红线）；
- 发布器只写 `gh-pages` 分支、只读 `release/`、拒绝上传任何密钥文件、用 `base_tree` 保留站点现有文件；
- 私钥只应存在于本机 `release/key.pem` 或 CI 的 Secret（`KH_KEY_PEM`）里。

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

这个 `.bat` 的**唯一权威副本是 `scripts/kh-autoupdate.bat`**：站点上那份由 `scripts/release.js`
在发布前同步进 `release/`（本地 `scripts/publish-gh.js` 走同一条规则），CI（`.github/workflows/release.yml`）
在发布到 gh-pages 前断言两者 sha256 相同、不同即失败 —— 所以 gh-pages 上的副本不会在 CI 路径下悄悄冻结在旧版本。

### 三个坑（都踩过）

1. **`.bat` 必须 ASCII 内容 + CRLF 行尾** ✗ —— 中文内容会随控制台代码页解析错乱，
   纯 LF 行尾会被 cmd 拆行（实测报出"半个单词"的怪错）。所以脚本里所有提示都是英文，
   要中文名**直接重命名文件**即可（内容不引用自身文件名）。
2. **卸载会删除扩展自己的 storage** ✗（关键词/分组会丢）—— 卸载前先到设置页导出 JSON 备份。
3. **同一 ID 的"解压加载"版本会盖过 crx 版本** ✗ —— 若 `edge://extensions` 里还留着
   「已解压的扩展程序」那条，运行中的代码是它，自动更新装了也看不出效果；
   要纯自动更新链路，先移除那条解压加载的。

