# 上传步骤（把 release/ 里的文件放到 gh-pages 的**对应位置**）

**首选**：`node scripts/publish-gh.js`（自动递归枚举 release/、保持目录层级、还带清单预检）。下面是手工兜底。

需要上传的文件（3 个，**不含 zip**（本次只发 crx））：
  - latest.json                      → https://moxiaoren.github.io/keyword-highlighter-extension/latest.json
  - update.xml                       → https://moxiaoren.github.io/keyword-highlighter-extension/update.xml（manifest.update_url 指向它）
  - release/keyword-highlighter-extension-2.0.6.crx   （本地文件：release/release/keyword-highlighter-extension-2.0.6.crx）
  （zip 默认不发；确实要 zip：node scripts/release.js --with-zip）

不要上传：key.pem（签名私钥，只留在本机 / 放进 CI 的 Secret）

## 两种上传方式

### A. 有 git（推荐）
```
git clone -b gh-pages https://github.com/moxiaoren/keyword-highlighter-extension.git gh-pages
mkdir -p gh-pages/release        # crx 在子目录里，先建目录
cp release/latest.json release/update.xml gh-pages/
cp release/release/keyword-highlighter-extension-2.0.6.crx gh-pages/release/
cd gh-pages && git add -A && git commit -m "release v2.0.6" && git push
```

### B. 无 git：在 GitHub 网页上把这 3 个文件替换掉即可（crx 在 release/ 目录下，别放到根目录）

## 上传后自检（30 秒）
1. 浏览器打开 https://moxiaoren.github.io/keyword-highlighter-extension/update.xml → 应看到 version="2.0.6" 与 codebase 指向 release/keyword-highlighter-extension-2.0.6.crx
2. 打开 https://moxiaoren.github.io/keyword-highlighter-extension/latest.json → 它的 crx 字段应与上一步的 codebase 一致（本次没发 zip，zip / sha256 字段为空是预期的）
3. 装了扩展的机器：等浏览器自动更新（或完全退出浏览器再启动）后，扩展详情页的版本号应变成 2.0.6
