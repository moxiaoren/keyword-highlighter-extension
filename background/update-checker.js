/**
 * 更新检测模块（**双通道**：gupdate XML ＋ 发布清单 JSON）
 * ============================================================================
 * 为什么是两条通道（这是本次升级的核心）：
 *   · **crx 通道**：`manifest.update_url` 指向 gh-pages 的 `update.xml`（gupdate 协议），
 *     Chrome 自己读它做静默自动更新。它只能在**新版本真的上线之后**才起作用，
 *     而且用户想知道"更新了什么"时它一个字都没有。
 *   · **zip 通道**：自托管的 `latest.json`（版本 / 下载地址 / **SHA256** / 更新说明）。
 *     v2 早期把它砍掉了（当时走 GitHub Releases API，`api.github.com` 在国内不稳），
 *     但"砍掉"的代价是：更新说明、校验、手动下载全都一起没了。
 *   现在两条**并行探测、取版本更高的一条**：任意一条可用就能发现新版本，
 *   一条挂了不影响另一条 —— 这才是"更新能力"该有的样子（而不是单点依赖）。
 *
 * 其余强化：
 *   · **镜像回退**：每个通道都给 3 个源（gh-pages → jsDelivr → raw.githubusercontent），
 *     依次尝试，谁先给出**合法响应**就用谁，并记下用的是哪个源（`source`）。
 *   · **超时**：单次请求 12s 超时（AbortController），不会把 popup / worker 挂住。
 *   · **缓存**：`chrome.storage.local.khUpdateInfo` 带 TTL（默认 6 小时），
 *     popup 每次打开都打网络是没必要的；`force: true` 可跳过缓存（用户手动点"检查更新"）。
 *   · **SHA256 校验**：`latest.json` 里带 `sha256` 时，下载后**必须校验通过**才算拿到包，
 *     不通过直接拒绝（并说明原因）—— 下载链路被劫持/文件损坏都能挡住。
 *   · **预发布版本**：版本比较支持 `x.y.z-beta.1` 这类后缀，且**预发布 < 同号正式版**。
 *
 * 返回对象（向后兼容旧字段，新增字段都带默认值）：
 *   { hasUpdate, latestVersion, currentVersion, zipUrl, crxUrl, notes, htmlUrl,
 *     source, sha256, publishedAt, checkedAt, fromCache, channels }
 * ========================================================================= */

/** 拆出版本核心与预发布后缀：`x.y.z-beta.1` → `['x.y.z', 'beta.1']` */
function splitVer(v) {
  const s = String(v == null ? '' : v).replace(/^v/i, '').trim();
  const i = s.indexOf('-');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

const UpdateChecker = {
  OWNER: 'moxiaoren',
  REPO: 'keyword-highlighter-extension',

  /** 通道 1：gupdate XML（Chrome 自动更新读的同一份） */
  UPDATE_XML_MIRRORS: [
    'https://moxiaoren.github.io/keyword-highlighter-extension/update.xml',
    'https://cdn.jsdelivr.net/gh/moxiaoren/keyword-highlighter-extension@gh-pages/update.xml',
    'https://raw.githubusercontent.com/moxiaoren/keyword-highlighter-extension/gh-pages/update.xml'
  ],

  /** 更新通道：稳定版 / 测试版。
   *  · 稳定版读 latest.json，测试版读 latest-beta.json —— **两份文件**，所以稳定用户永远不会被推测试版；
   *  · "测试版"不是版本号后缀（Chrome 不允许 manifest.version 带 -beta），
   *    而是"提前发出的下一个版本号"：例如稳定 2.1.0，测试发 2.1.1，测好了把同一份构建再发到稳定通道。
   *  · crx 通道（update.xml）**不参与分通道** —— Chrome 的 update_url 是固定的，
   *    测试版只能走 zip 通道更新（这是 Chrome 的限制，不是偷懒）。 */
  CHANNELS: {
    stable: { file: 'latest.json', label: '稳定版' },
    beta: { file: 'latest-beta.json', label: '测试版' }
  },

  /** 通道 2：发布清单 JSON（自托管，不用 GitHub API） */
  LATEST_JSON_MIRRORS: [
    'https://moxiaoren.github.io/keyword-highlighter-extension/latest.json',
    'https://cdn.jsdelivr.net/gh/moxiaoren/keyword-highlighter-extension@gh-pages/latest.json',
    'https://raw.githubusercontent.com/moxiaoren/keyword-highlighter-extension/gh-pages/latest.json'
  ],

  /** 按通道拼出清单地址（三个镜像同一文件） */
  latestMirrors(channel) {
    const file = (this.CHANNELS[channel] || this.CHANNELS.stable).file;
    return [
      'https://moxiaoren.github.io/keyword-highlighter-extension/' + file,
      'https://cdn.jsdelivr.net/gh/moxiaoren/keyword-highlighter-extension@gh-pages/' + file,
      'https://raw.githubusercontent.com/moxiaoren/keyword-highlighter-extension/gh-pages/' + file
    ];
  },

  /** 当前通道（默认稳定版；由 khUpdateChannel 决定） */
  async getChannel() {
    try {
      /* 独立测试版包在 manifest 里写了 version_name = "x.y.z beta"（见 scripts/release-beta.js）——
       * 这种包**永远是测试通道**，不看用户设置：它就是测试版本身。 */
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        const vn = String((chrome.runtime.getManifest() || {}).version_name || '');
        if (/\bbeta\b/i.test(vn)) return 'beta';
      }
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return 'stable';
      const { khUpdateChannel } = await chrome.storage.local.get('khUpdateChannel');
      return khUpdateChannel === 'beta' ? 'beta' : 'stable';
    } catch (e) { return 'stable'; }
  },

  TIMEOUT_MS: 12000,
  CACHE_TTL_MS: 6 * 60 * 60 * 1000,     // 6 小时（与后台 alarm 周期一致）

  /* ------------------------------------------------------------------ 版本 */

  /* 拆版本号的核心与预发布后缀。**必须是模块级纯函数** ✗ ——
   * 早先写成对象方法、内部用 this._splitVer，结果任何调用方把 compareVersions 拆出来单独用
   * （const cmp = X.compareVersions）就会崩：this 丢了（实测踩到 ✗）。 */
  _splitVer(v) { return splitVer(v); },

  /**
   * 语义化版本比较（兼容 `1.2` / `1.2.3` / `1.2.3.4` / 预发布后缀）
   * @returns {number} 1 = a 新于 b；-1 = a 旧于 b；0 = 相同
   *   预发布规则：带 `-beta` 后缀的**旧于**同号正式版，两条预发布之间按字符串比。
   */
  compareVersions(a, b) {
    const [ca, pa] = splitVer(a);
    const [cb, pb] = splitVer(b);
    const na = ca.split('.');
    const nb = cb.split('.');
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
      const x = parseInt(na[i] || '0', 10) || 0;
      const y = parseInt(nb[i] || '0', 10) || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    if (pa === pb) return 0;
    if (!pa) return 1;            // 无预发布后缀 = 正式版，更大
    if (!pb) return -1;
    return pa > pb ? 1 : -1;
  },

  /* ------------------------------------------------------------ 网络与镜像 */

  /** 带超时的取文本 */
  async _getText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * 依次尝试镜像，返回**第一个解析成功**的结果
   * @returns {Promise<{data:any, source:string}|null>}
   */
  async _firstOf(mirrors, parse) {
    for (const url of mirrors) {
      const text = await this._getText(url);
      if (!text) continue;
      let data = null;
      try { data = parse(text, url); } catch (e) { data = null; }
      if (data) return { data, source: url };
    }
    return null;
  },

  /* ------------------------------------------------------------------ 通道 */

  /** gupdate XML → { version, codebase }（必须限定在 <updatecheck> 内匹配，
   *  否则会先命中 XML 声明里的 version='1.0'） */
  _parseUpdateXml(text) {
    const v = text.match(/<updatecheck[^>]*\bversion=['"]([^'"]+)['"]/i);
    if (!v) return null;
    const c = text.match(/<updatecheck[^>]*\bcodebase=['"]([^'"]+)['"]/i);
    return { version: v[1], codebase: c ? c[1] : null };
  },

  /** latest.json → 规范化对象（字段缺失都当没有，绝不抛） */
  _parseLatestJson(text) {
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return null; }   // 非法 JSON 一律当"无效清单"，绝不抛
    if (!j || !j.version) return null;
    return {
      version: String(j.version),
      zipUrl: j.zip || j.zipUrl || null,
      crxUrl: j.crx || j.crxUrl || null,
      sha256: j.sha256 ? String(j.sha256).toUpperCase() : null,
      notes: j.notes || null,
      htmlUrl: j.htmlUrl || null,
      publishedAt: j.publishedAt || null
    };
  },

  async fetchCrxChannel() {
    const r = await this._firstOf(this.UPDATE_XML_MIRRORS, (t) => this._parseUpdateXml(t));
    if (!r) return null;
    return {
      channel: 'crx',
      version: String(r.data.version || '').replace(/^v/i, ''),
      crxUrl: r.data.codebase || null,
      source: r.source
    };
  },

  async fetchZipChannel(channel) {
    const ch = this.CHANNELS[channel] ? channel : 'stable';
    const r = await this._firstOf(this.latestMirrors(ch), (t) => this._parseLatestJson(t));
    if (!r) return null;
    return Object.assign({ channel: 'zip', updateChannel: ch, source: r.source }, r.data);
  },

  /** 兼容旧调用：只探测 crx 通道 */
  async fetchLatestRelease() {
    const c = await this.fetchCrxChannel();
    return c ? { version: c.version, codebase: c.crxUrl } : null;
  },

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * 检查更新
   * @param {string} currentVersion 当前版本（唯一来源：manifest）
   * @param {{force?:boolean}} opts force=true 跳过缓存（用户手动点击）
   * @returns {Promise<Object>} 见文件头说明
   */
  async check(currentVersion, opts) {
    const force = !!(opts && opts.force);
    const cur = String(currentVersion || '').replace(/^v/i, '');
    const updateChannel = (opts && opts.channel) || await this.getChannel();

    /* 缓存：未过期直接用（popup 每次打开都请求是浪费，也会给更新源压力） */
    if (!force) {
      const cached = await this._readCache();
      /* 缓存也要分通道：切了通道必须立刻重新查，不能拿另一条通道的结果糊弄 */
      if (cached && cached.updateChannel === updateChannel &&
          Date.now() - (cached.checkedAt || 0) < this.CACHE_TTL_MS) {
        /* ★ 缓存里的结论**必须按"当前版本"重算**，不能原样返回：
         * 用户更新到缓存里那个版本之后，旧的 `hasUpdate:true` 会一直挂着，
         * 弹窗就会显示「发现新版本 v<正好是当前版本>」（实测就是这个 bug，1.99.99.22 装完仍提示有新版本）。 */
        const cachedCur = String(cached.currentVersion || '').replace(/^v/i, '');
        if (cachedCur && cachedCur !== cur) {
          /* 本地版本和缓存里记的不是同一个 ⇒ 扩展刚更新过 ⇒ 缓存结论作废，往下走真实检查 */
        } else {
          const latest = String(cached.latestVersion || '').replace(/^v/i, '');
          const hasUpdate = !!latest && this.compareVersions(latest, cur) > 0;
          return Object.assign({}, cached, { currentVersion: cur, hasUpdate: hasUpdate, fromCache: true });
        }
      }
    }

    /* 两条通道**并行**：谁先给出合法数据算谁的；一条挂不影响另一条 */
    const [crx, zip] = await Promise.all([
      this.fetchCrxChannel().catch(() => null),
      this.fetchZipChannel(updateChannel).catch(() => null)
    ]);

    const channels = {
      crx: crx ? { ok: true, version: crx.version, source: crx.source } : { ok: false },
      zip: zip ? { ok: true, version: zip.version, source: zip.source } : { ok: false }
    };
    /* 测试通道下 **crx 通道不参与**：update.xml 只能有一份（Chrome 的 update_url 固定），
     * 它永远代表稳定版。混进来会让测试版用户看到"版本更低"的稳定版信息 ✗ */
    const crxForCompare = updateChannel === 'beta' ? null : crx;

    /* 取版本更高的一条作为"最新版本"，另一条的数据作为补充（zip 提供 notes/sha256，crx 提供 codebase） */
    let primary = null;
    if (crxForCompare && zip) primary = this.compareVersions(zip.version, crxForCompare.version) >= 0 ? zip : crxForCompare;
    else primary = zip || crxForCompare;

    if (!primary) {
      return {
        hasUpdate: false, latestVersion: null, currentVersion: cur,
        zipUrl: null, crxUrl: null, notes: null, htmlUrl: null,
        source: null, sha256: null, publishedAt: null, updateChannel,
        checkedAt: Date.now(), fromCache: false, channels
      };
    }

    const latestVersion = String(primary.version || '').replace(/^v/i, '');
    const info = {
      hasUpdate: this.compareVersions(latestVersion, cur) > 0,
      latestVersion,
      currentVersion: cur,
      /* 下载地址：两条通道各自能给什么就给什么（zip 优先，因为只有它能校验） */
      updateChannel,
      zipUrl: (zip && zip.zipUrl) || null,
      crxUrl: (zip && zip.crxUrl) || (crxForCompare && crxForCompare.crxUrl) || null,
      notes: (zip && zip.notes) || null,
      htmlUrl: (zip && zip.htmlUrl) || null,
      sha256: (zip && zip.sha256) || null,
      publishedAt: (zip && zip.publishedAt) || null,
      source: primary.source || null,
      channel: primary.channel || null,
      checkedAt: Date.now(),
      fromCache: false,
      channels
    };
    await this._writeCache(info);
    return info;
  },

  /* ---------------------------------------------------------------- 缓存 */

  async _readCache() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
      const { khUpdateInfo } = await chrome.storage.local.get('khUpdateInfo');
      return khUpdateInfo || null;
    } catch (e) { return null; }
  },

  async _writeCache(info) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      await chrome.storage.local.set({ khUpdateInfo: info });
    } catch (e) { /* 缓存失败不影响结果 */ }
  },

  /* ------------------------------------------------------------ 下载与校验 */

  /** 下载一个地址并算 SHA256（十六进制大写）；失败返回 null */
  async fetchSha256(url) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS * 3);   // 包体较大，给更长时间
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    } catch (e) {
      return null;
    }
  },

  /**
   * 下载更新包并校验 SHA256
   * @returns {Promise<{ok:boolean, reason?:string, bytes?:number}>}
   *   `expect` 为空时**跳过校验**（但仍下载成功才算 ok）—— 老清单没有 sha256 时不至于不可用。
   */
  async downloadAndVerify(url, expect) {
    if (!url) return { ok: false, reason: '没有下载地址' };
    const got = await this.fetchSha256(url);
    if (!got) return { ok: false, reason: '下载失败（网络不可达或超时）' };
    if (expect && String(expect).toUpperCase() !== got) {
      return { ok: false, reason: '校验失败：SHA256 不一致（期望 ' + String(expect).slice(0, 12) + '…，实际 ' + got.slice(0, 12) + '…）' };
    }
    return { ok: true, hash: got, verified: !!expect };
  }
};

/** 更新通道读写（popup 切换 / 各处读取都走这里，键名唯一） */
const KH_UPDATE_CHANNEL_KEY = 'khUpdateChannel';
const UpdateChannel = {
  KEY: KH_UPDATE_CHANNEL_KEY,
  async get() {
    try {
      const { [KH_UPDATE_CHANNEL_KEY]: v } = await chrome.storage.local.get(KH_UPDATE_CHANNEL_KEY);
      return v === 'beta' ? 'beta' : 'stable';
    } catch (e) { return 'stable'; }
  },
  async set(ch) {
    const v = ch === 'beta' ? 'beta' : 'stable';
    try { await chrome.storage.local.set({ [KH_UPDATE_CHANNEL_KEY]: v }); } catch (e) { /* 忽略 */ }
    return v;
  }
};
UpdateChecker.UpdateChannel = UpdateChannel;

/* 挂载点必须同时覆盖 **页面** 与 **service worker**：
 *   页面里有 window；service worker 里**没有 window，只有 self** ✗
 *   —— 我重写本文件时只写了 window，导致后台 `self.UpdateChecker` 为 undefined，
 *      popup 点「检查更新」永远只显示"失败"（实测复现，用户报的正是这个）。
 *   `self` 在两种环境下都存在（页面里 self === window），所以统一挂 self 最稳。 */
const G = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : this);
G.UpdateChecker = UpdateChecker;
G.KH = G.KH || {};
G.KH.UpdateChannel = UpdateChannel;
if (typeof window !== 'undefined') {
  window.UpdateChecker = UpdateChecker;
  window.KH = window.KH || {};
  window.KH.UpdateChannel = UpdateChannel;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UpdateChecker;
}
