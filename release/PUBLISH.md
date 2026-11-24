# 上传步骤（把 release/ 里的文件放到 gh-pages 的**对应位置**）

**首选**：`node scripts/publish-gh.js`（自动递归枚举 release/、保持目录层级、还带清单预检）。下面是手工兜底。

需要上传的文件（4 个，含 zip）：
  - latest.json                      → https://moxiaoren.github.io/keyword-highlighter-extension/latest.json
  - update.xml                       → https://moxiaoren.github.io/keyword-highlighter-extension/update.xml（manifest.update_url 指向它）
  - keyword-highlighter.crx
  - keyword-highlighter-v2.0.17.zip   ← `--with-zip` 额外产出（"解压加载"用）

不要上传：key.pem（签名私钥，只留在本机 / 放进 CI 的 Secret）

## 两种上传方式

### A. 有 git（推荐）
```
git clone -b gh-pages https://github.com/moxiaoren/keyword-highlighter-extension.git gh-pages
cp release/latest.json release/update.xml release/keyword-highlighter-v2.0.17.zip gh-pages/
cp release/keyword-highlighter.crx gh-pages/
cd gh-pages && git add -A && git commit -m "release v2.0.17" && git push
```

### B. 无 git：在 GitHub 网页上把这 4 个文件替换掉即可

## 上传后自检（30 秒）
1. 浏览器打开 https://moxiaoren.github.io/keyword-highlighter-extension/update.xml → 应看到 version="2.0.17" 与 codebase 指向 keyword-highlighter.crx
2. 打开 https://moxiaoren.github.io/keyword-highlighter-extension/latest.json → 它的 crx 字段应与上一步的 codebase 一致，sha256 应与本地 release/latest.json 一致
3. 装了扩展的机器：等浏览器自动更新（或完全退出浏览器再启动）后，扩展详情页的版本号应变成 2.0.17
