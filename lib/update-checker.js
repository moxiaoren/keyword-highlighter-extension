/**
 * 更新检测模块（crx 在线自动更新通道）
 *
 * 插件已采用 crx + update_url + GitHub Pages 自动更新方案，
 * 因此本模块不再查询 GitHub Releases API（旧 zip 方案B，国内访问 api.github.com 不稳定），
 * 改为读取 gh-pages 托管的 update.xml（gupdate 协议），解析其中指向的最新版本与 crx 下载地址。
 * - 有新版返回 true，并给出 crx 下载地址（codebase）
 * - 请求失败返回 latestVersion = null，由调用方提示网络异常
 */
const UpdateChecker = {
  OWNER: 'moxiaoren',
  REPO: 'keyword-highlighter-extension',
  UPDATE_XML: 'https://moxiaoren.github.io/keyword-highlighter-extension/update.xml',

  /**
   * 语义化版本比较（支持 x.y.z，忽略前导 v）
   * @returns {number} 1 = a 新于 b；-1 = a 旧于 b；0 = 相同
   */
  compareVersions(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.');
    const pb = String(b || '').replace(/^v/i, '').split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = parseInt(pa[i] || '0', 10);
      const y = parseInt(pb[i] || '0', 10);
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  },

  /**
   * 拉取 update.xml 并解析最新版本与 crx 下载地址
   * @returns {Promise<{version:string, codebase:string|null}|null>} 失败返回 null
   */
  async fetchLatestRelease() {
    // 超时控制：避免请求无限挂起导致 popup/worker 无响应
    const TIMEOUT_MS = 12000;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(this.UPDATE_XML, {
        cache: 'no-store',
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn('[KeywordHighlighter] 更新检测失败:', res.status);
        return null;
      }
      const text = await res.text();
      // 注意：必须限定在 <updatecheck> 标签内匹配，否则会先命中 XML 声明里的 version='1.0'
      const versionM = text.match(/<updatecheck[^>]*\bversion=['"]([^'"]+)['"]/i);
      const codebaseM = text.match(/<updatecheck[^>]*\bcodebase=['"]([^'"]+)['"]/i);
      if (!versionM) return null;
      return { version: versionM[1], codebase: codebaseM ? codebaseM[1] : null };
    } catch (err) {
      // 超时(AbortError) 或网络异常
      console.warn('[KeywordHighlighter] 更新检测异常:', err && err.name, err && err.message);
      return null;
    }
  },

  /**
   * 检查更新
   * @returns {Promise<Object>} { hasUpdate, latestVersion, currentVersion, zipUrl, notes, htmlUrl }；
   *   zipUrl 为 update.xml 中 codebase（新版本 crx 下载地址）；
   *   远端不可达/无版本时 hasUpdate=false，latestVersion 等为 null
   */
  async check(currentVersion) {
    const remote = await this.fetchLatestRelease();
    if (!remote) {
      return { hasUpdate: false, latestVersion: null, currentVersion, zipUrl: null, notes: null, htmlUrl: null, checkedAt: Date.now() };
    }

    const latestVersion = String(remote.version || '').replace(/^v/i, '');
    const hasUpdate = this.compareVersions(latestVersion, String(currentVersion || '')) > 0;

    return {
      hasUpdate,
      latestVersion,
      currentVersion,
      zipUrl: remote.codebase || null,
      notes: null,
      htmlUrl: null,
      checkedAt: Date.now()
    };
  }
};

if (typeof window !== 'undefined') {
  window.UpdateChecker = UpdateChecker;
}
