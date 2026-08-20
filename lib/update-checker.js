/**
 * 更新检测模块
 * 通过 GitHub Releases API 检测是否发布了新版本。
 *
 * 采用方案 B（unpacked 软更新）：
 * - 插件定期查询 https://api.github.com/repos/<owner>/<repo>/releases/latest
 * - 对比本地版本与远端最新 release 的 tag
 * - 有新版时返回 zip 下载地址与更新说明，由 popup 展示并引导更新
 */
const UpdateChecker = {
  OWNER: 'moxiaoren',
  REPO: 'keyword-highlighter-extension',
  API: 'https://api.github.com/repos/moxiaoren/keyword-highlighter-extension/releases/latest',

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
   * 拉取 GitHub 最新 release
   * @returns {Promise<Object|null>} release 对象；失败返回 null
   */
  async fetchLatestRelease() {
    // 超时控制：api.github.com 国内访问不稳定，避免请求无限挂起导致 popup/worker 无响应
    const TIMEOUT_MS = 12000;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(this.API, {
        headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store',
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 404) return null; // 尚无 release
        console.warn('[KeywordHighlighter] 更新检测失败:', res.status);
        return null;
      }
      return await res.json();
    } catch (err) {
      // 超时(AbortError) 或网络异常
      console.warn('[KeywordHighlighter] 更新检测异常:', err && err.name, err && err.message);
      return null;
    }
  },

  /**
   * 从 release 中解析 zip 资产的下载地址
   */
  resolveZipUrl(release) {
    if (!release) return null;
    if (Array.isArray(release.assets)) {
      const zip = release.assets.find(a => a && /\.zip$/i.test(a.name));
      if (zip && zip.browser_download_url) return zip.browser_download_url;
    }
    if (release.zipball_url) return release.zipball_url; // 兜底：GitHub 自动生成源码包
    return null;
  },

  /**
   * 检查更新
   * @returns {Promise<Object>} { hasUpdate, latestVersion, currentVersion, zipUrl, notes, htmlUrl }；远端无 release 时 hasUpdate=false，latestVersion 等为 null
   */
  async check(currentVersion) {
    const release = await this.fetchLatestRelease();
    if (!release) {
      return { hasUpdate: false, latestVersion: null, currentVersion, zipUrl: null, notes: null, htmlUrl: null, checkedAt: Date.now() };
    }

    const latestVersion = (release.tag_name || '').replace(/^v/i, '');
    const hasUpdate = this.compareVersions(latestVersion, String(currentVersion || '')) > 0;

    return {
      hasUpdate,
      latestVersion,
      currentVersion,
      zipUrl: this.resolveZipUrl(release),
      notes: release.body || '',
      htmlUrl: release.html_url || null,
      publishedAt: release.published_at || null,
      checkedAt: Date.now()
    };
  }
};

if (typeof window !== 'undefined') {
  window.UpdateChecker = UpdateChecker;
}
