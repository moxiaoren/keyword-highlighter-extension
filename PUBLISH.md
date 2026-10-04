# 上传步骤（把 release/ 里的文件放到 gh-pages 根目录）

需要上传的文件（4 个）：
  - latest.json                      → https://moxiaoren.github.io/keyword-highlighter-extension/latest.json
  - update.xml                       → https://moxiaoren.github.io/keyword-highlighter-extension/update.xml（manifest.update_url 指向它）
  - keyword-highlighter-v2.0.1.zip
  - keyword-highlighter-extension-2.0.1.crx

不要上传：key.pem（签名私钥，只留在本机 / 放进 CI 的 Secret）

## 两种上传方式

### A. 有 git（推荐）
```
git clone -b gh-pages https://github.com/moxiaoren/keyword-highlighter-extension.git gh-pages
cp release/latest.json release/update.xml release/keyword-highlighter-v2.0.1.zip release/keyword-highlighter-extension-2.0.1.crx gh-pages/
cd gh-pages && git add -A && git commit -m "release v2.0.1" && git push
```

### B. 无 git：在 GitHub 网页上把 gh-pages 分支的这 4 个文件替换掉即可

## 上传后自检（30 秒）
1. 浏览器打开 https://moxiaoren.github.io/keyword-highlighter-extension/update.xml → 应看到 version="2.0.1" 与 codebase 指向 keyword-highlighter-extension-2.0.1.crx
2. 打开 https://moxiaoren.github.io/keyword-highlighter-extension/latest.json → sha256 应与本地 release/latest.json 一致
3. 打开扩展 popup → 点「检查更新」：若线上版本号已更高，应出现更新条，
   tooltip 显示更新源/发布时间/说明；点更新会先校验 SHA256 再打开下载地址
