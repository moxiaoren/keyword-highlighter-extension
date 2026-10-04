# 上传步骤（**测试通道**：只发 zip，不影响稳定用户）

需要上传的文件（2 个）：
  - latest-beta.json  → https://moxiaoren.github.io/keyword-highlighter-extension/latest-beta.json
  - keyword-highlighter-v2.0.0.10.zip

**不要**动线上已有的 update.xml：本次没有产出与线上 appid 匹配的 crx，
改动它会把 crx 通道指向不存在的包，Chrome 会反复拉取失败。

## 上传方式
A. 有 git：clone gh-pages 分支 → 覆盖这 2 个文件 → commit & push
B. 无 git：在 GitHub 网页上把这两个文件传到 gh-pages 分支根目录
C. 用本仓库的发布器（**不需要 git**）：node scripts/publish-gh.js --branch gh-pages

## 上传后自检
1. 打开 https://moxiaoren.github.io/keyword-highlighter-extension/latest.json → sha256 应与本地 release/latest.json 一致
2. 打开扩展 popup → 「检查更新」应提示有新版本（zip 通道生效）
3. 点更新 → 会先校验 SHA256 再打开下载地址