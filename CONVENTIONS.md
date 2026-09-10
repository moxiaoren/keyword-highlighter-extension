# 开发与发版规范（CONVENTIONS）

> 本文件用于防止「改了一处、其他处陈旧」的问题。
> 核心原则：**单一事实源（Single Source of Truth）**。每个会被多处引用的值，只定义一次，其余地方引用它。

## 一、版本号（唯一真源 = manifest.json）

- `manifest.json` 的 `version` 是**唯一**版本声明处。
- 其余所有展示版本的地方**必须动态读取**，禁止硬编码：
  - `lib/storage.js`：`Storage.defaults.version`（若保留）应在发版时与 manifest 同步。
  - `options/options.html` 侧栏版本徽标 → 由 `options.js` 从 `chrome.runtime.getManifest().version` 写入（已有 `syncSidebarVersion`）。
  - `welcome/welcome.js` → 已从 `chrome.runtime.getManifest().version` 读取。
  - `popup/popup.js` → 已从 `chrome.runtime.getManifest().version` 读取。
- **切勿**在 html/js/css 里手写 `v1.9.4` 这类字面量版本号（会随迭代漂移）。

## 二、默认值 / 常量（唯一真源 = lib/storage.js）

- 所有功能默认值（颜色、尺寸、开关）只定义在 `Storage.defaults`。
- UI 提示文案不得出现与默认值相悖的「手写数字」。例如默认图片尺寸是 `70`，提示就写 `默认 70`，不要写 `默认 180`。
- 新增默认值时，同步更新所有引用处；用 `node scripts/meta-check.js` 兜底扫描「陈旧数字」。

## 三、更新日志 / CHANGELOG（唯一真源 = lib/changelog.js）

- 所有更新日志条目**只写入 `lib/changelog.js`**（`CHANGELOG` 数组，倒序，最新在上）。
- `welcome/welcome.js` 与 `options` 帮助页 `changelog-preview` 都从同一份 `CHANGELOG` 渲染。
- **禁止**再往 `options/options.html` 帮助页里硬编码版本历史。

## 四、发版前自检（必做）

发版 / 交付前，在项目根目录运行：

```bash
node scripts/meta-check.js
```

脚本会校验：
1. manifest 与 storage/welcome/popup 版本一致；
2. 帮助文案是否残留陈旧数字（如默认尺寸 180/70 漂移）；
3. 是否残留重复区块 / 未用权限 / 未用配置项。

出现红字=禁止发版，先修复再发。

## 五、UI / 布局规范

- 所有配色 / 圆角 / 间距使用 `:root` CSS 变量（`--primary`、`--radius`、`--shadow` …），**禁止**散落 inline style 与硬编码色值。
- 改布局时，同时检查：`options/options.html`、`popup/popup.html`、`welcome/welcome.html` 三处是否被影响，保持一致。
- 新增交互尽量在现有组件模式上扩展，不引入第三套风格。

## 六、删除功能时的检查清单（防止残留）

删一个功能时，依次确认并清理：
1. 入口 UI（html 按钮 / 菜单项）；
2. 绑定逻辑（js addEventListener / 函数调用）；
3. 配置项（storage defaults 里的字段）；
4. 权限（manifest permissions，若该功能是唯一使用者）；
5. 资源文件（assets 等 + manifest web_accessible_resources）；
6. 帮助 / 更新日志里的对应描述。

## 七、交付方式（用户确立）

- 涉及可能影响既有功能的大型改动：默认先发 **zip 解压包**本地测试，测稳后再推 crx 线上自动更新。
- crx 一旦推线上，`chrome-extension-crx-autoupdate` 工作流会覆盖 index，注意版本号三处对齐。
