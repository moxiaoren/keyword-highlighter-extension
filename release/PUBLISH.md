# 上传步骤（**测试通道**）

上传（2 个）：latest-beta.json、keyword-highlighter-v2.0.0.7.zip
不要上传：keyword-highlighter-v2.0.0.7-beta.crx（那是给人手动装的）、key.pem
**不要动 update.xml** —— 它是稳定版专用，改了会把测试版推给所有用户。

发布后自检：打开 https://moxiaoren.github.io/keyword-highlighter-extension/latest-beta.json，sha256 应与本地一致；
然后把扩展的更新通道切到「测试版」，点检查更新应看到 v2.0.0.7。