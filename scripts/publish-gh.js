/* ============================================================================
 * scripts/publish-gh.js — 把 release/ 发到 gh-pages（**不需要 git**，走 GitHub REST API）
 * ----------------------------------------------------------------------------
 * 为什么不用 git：这台构建机不一定装 git（实测：没有）。GitHub 的 Git Data API
 * 允许"建 blob → 建 tree → 建 commit → 移动分支指针"，效果与 `git push` 等价，
 * 而且**多个文件一次提交**（不会出现"zip 传上去了 update.xml 还没传"的中间态 ✗）。
 *
 * 用法：
 *   node scripts/publish-gh.js                 # 发布 release/ 里的文件到 gh-pages
 *   node scripts/publish-gh.js --dry            # 只检查，不提交
 *   node scripts/publish-gh.js --branch gh-pages
 *
 * 凭据（二选一，**不要写进任何文件**）：
 *   · 环境变量 GH_TOKEN      —— 推荐：细粒度 token，只给这一个仓库的 Contents: Read and write
 *   · 环境变量 GITHUB_TOKEN  —— 兼容 CI
 *
 * 安全约定：
 *   · 发布器**只读 release/**，且**拒绝上传** key.pem / *.key / *.pem（私钥永不外发）；
 *   · 只写 gh-pages 分支，不碰其它分支；
 *   · 发布前/后都跑 `scripts/check-channels.js`：两条更新通道的 **appid**、版本、产物必须一致
 *     （2026-10-04 实测事故：线上 update-beta.xml 的 appid 是旧密钥的 ID，测试通道的自动更新
 *      因此一直是坏的，而当时的自检只比 latest.json 的 sha256 与 update.xml 的版本，从不比 appid）。
 * ========================================================================= */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const OWNER = 'moxiaoren';
const REPO = 'keyword-highlighter-extension';
const SITE = 'https://moxiaoren.github.io/keyword-highlighter-extension';

const argv = process.argv.slice(2);
const DRY = argv.indexOf('--dry') >= 0;
const BETA_ONLY = argv.indexOf('--beta-only') >= 0;   // 只发测试版：跳过稳定版清单的版本收集与预检（稳定版已在线上，不重发）
const BI = argv.indexOf('--branch');
const BRANCH = BI >= 0 ? argv[BI + 1] : 'gh-pages';

/**
 * 凭据来源优先级：
 *   1) 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2) **工作区根目录的 _gh_token.txt**（推荐：token 不经过命令行，也就不会进对话记录/终端历史）
 * 文件路径：<仓库>/../../_gh_token.txt
 */
function readTokenFile() {
  const cands = [
    path.join(ROOT, '..', '..', '_gh_token.txt'),
    path.join(ROOT, '..', '_gh_token.txt'),
    path.join(ROOT, 'release', '.gh_token')
  ];
  for (const f of cands) {
    try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* 忽略 */ }
  }
  return '';
}
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || readTokenFile();

/** 绝不能上传的文件（私钥/证书/签名包） */
const FORBIDDEN_RE = /\.(pem|key|p12|pfx|jks)$/i;

function log(m) { console.log(m); }
function die(m) { console.error('\n✗ ' + m); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
    method: method,
    headers: Object.assign({
      'Accept': 'application/vnd.github+json',
      /* 【必须显式声明 JSON（K63 踩坑）】不带 `Content-Type` 时 GitHub 会返回 **HTTP 500**（空 body），
       * 而不是 4xx —— 表现为"整次发布随机卡在某个文件上、报错还看不出原因"。
       * 实测：同一个 blob 请求，加上这一行就是 201。 */
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'keyword-highlighter-release'
    }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json: json, text: text };
}

(async () => {
  if (!fs.existsSync(REL)) die('没有 release/ 目录 —— 先跑 node scripts/release.js');
  /* 站点上的 kh-autoupdate.bat 只有**一份权威副本**：`scripts/kh-autoupdate.bat`。
   * 2026-10-04 用户裁决：权威副本从工作区根迁到这里 —— 非生成目录，且 `scripts/` 已在 package.js 的
   * EXCLUDE_DIRS 内 ⇒ 它绝无可能被打进交付包；工作区根那份已删除（原先被误当「2.1.0 时代遗留」）。
   * 缺源一律**硬失败**：旧写法 `if (fs.existsSync(src))` + 吞异常的 catch 会让 gh-pages 上的副本
   * 永久冻结在最后一版、而发版全程显示成功（见 AUDIT.md F-63 / U-4 的根因）。 */
  (function syncBatFromWorkspace() {
    const src = path.join(ROOT, 'scripts', 'kh-autoupdate.bat');
    if (!fs.existsSync(src)) {
      die('缺 kh-autoupdate.bat 权威副本：' + src + '\n' +
          '  站点上的安装脚本只能由这一份供源（唯一权威副本）——发布中止，避免 gh-pages 上的副本永久冻结。');
    }
    try {
      const dst = path.join(REL, 'kh-autoupdate.bat');
      const a = fs.readFileSync(src), b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (!b || !a.equals(b)) { fs.mkdirSync(REL, { recursive: true }); fs.copyFileSync(src, dst); console.log('已同步 kh-autoupdate.bat 到发布目录（唯一权威副本来自 scripts/kh-autoupdate.bat）'); }
    } catch (e) { die('同步 kh-autoupdate.bat 到 release/ 失败：' + (e && e.message)); }
  })();

  /* 递归列出 `release/` 下的文件（**必须递归**）。
   * 为什么：晋级稳定版时 `release.js` 会把 crx 放到
   * `release/keyword-highlighter-extension-<版本>.crx` —— 那个子目录路径**正是 `update.xml` 里的 codebase**。
   * 2026-09-22 实测事故：这里原本是 `fs.readdirSync(REL).filter(isFile)`（**不递归**），
   * 于是发稳定版时 crx 压根没进上传列表，而 `update.xml` 已经指向它 ⇒ 用户端自动更新会 404。
   * 只跑测试版迭代永远发现不了这条（beta 包都平铺在 `release/` 根下）。
   * 语言包（`release/lang/*.gz`）不会被这里上传 —— 它们走下面单独那条路径（含 sha256 校验）。 */
  const all = (function walk(dir, prefix) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel));
      else out.push(rel);
    }
    return out;
  })(REL, '');
  /* 私钥可以**放在** release/（本机签名用），但绝不能**上传** —— 跳过它，而不是因此拒绝发布。
   * （第一版写成"直接中止"，结果自己把自己的密钥挡在门外 ✗） */
  const skip = all.filter((f) => FORBIDDEN_RE.test(f));
  /* 只上传"站点真正需要"的文件（白名单）：清单、update.xml、包。
   * 其余（PUBLISH.md 等）留在本地 —— 免得把说明文档也传上站点。 */
  const SITE_FILE_RE = /^(latest(-beta)?\.json|update(-beta)?\.xml|index\.html|kh-autoupdate\.bat|.+\.(zip|crx))$/i;   // 站点首页 + 一键安装脚本也一起发布   // update-beta.xml 也要能发（独立测试版的自动更新源）
  /* 只上传**当前版本**的安装包。
   * 【为什么要收这一刀】release/ 里会一直堆着历史测试版包（实测已经 19 个版本的 crx+zip ≈ 10MB），
   * 每次发版都重传一遍：又慢又会撞上 API 抽风（实测在传第 26 个 blob 时拿到一次 Bad credentials）。
   * 站上旧的**保持原样**即可 —— 建 tree 用的是 base_tree（合并），不发就等于不动它。
   * 当前版本从清单里读：测试版 = latest-beta.json.version；稳定版 = update.xml 里的 updatecheck version。 */
  const currentVersions = [];
  let betaVersion = '';
  let stableVersion = '';
  try {
    const bj = JSON.parse(fs.readFileSync(path.join(REL, 'latest-beta.json'), 'utf8'));
    if (bj && bj.version) { betaVersion = String(bj.version); currentVersions.push(betaVersion); }
  } catch (e) { /* 没测试版清单就算了 */ }
  try {
    const ux = fs.readFileSync(path.join(REL, 'update.xml'), 'utf8');
    const uv = (ux.match(/<updatecheck[^>]*version=['"]([^'"]+)['"]/) || [])[1];
    if (uv && !BETA_ONLY) { stableVersion = String(uv); currentVersions.push(stableVersion); }
  } catch (e) { /* 没稳定版清单就算了 */ }
  const isPkg = (f) => /\.(zip|crx)$/i.test(f);
  const isCurrentPkg = (f) => !isPkg(f) || currentVersions.some((v) => f.indexOf(v) >= 0);

  /* 历史包白名单：**默认不外发旧包**（省流量，也免得不小心让人装到旧版）。
   * 机制保留（需要时把文件名填回来即可）：排查"某个旧版本能行、现在不行"这类 A/B 时，
   * 需要一个能点开的下载地址；只放 beta 的 crx（与测试版同 ID ⇒ 就地降级不丢配置），
   * 且**不写进任何清单**，所以不会被自动更新挑中。
   * 【为什么现在是空的】`.16/.17/.20` 的 crx 与 `keyword-highlighter-debug-v1.99.99.17.zip`
   * 已经在 92a0b0f4 那次发布里传到站点上了；gh-pages 用 base_tree 合并，不重传就等于原地保留。
   * 留着它们反而每次发版都要多传 4 个几 MB 的 blob（实测会被 GitHub 拒掉，导致整次发布失败）。 */
  const OLD_PKG_ALLOW = [];
  const isAllowedOld = (f) => OLD_PKG_ALLOW.some((re) => re.test(f));

  /* 首页里的**静态兜底链接**随清单自愈。
   * 首页的版本号与下载链接是 JS 按清单改写的，但 JS 被挡/清单读不到时就落到静态值上 ——
   * 实测漂过一次（静态还指着 v1.99.99.17，用户按静态值点就是旧包）。发布前对齐一次，永远不漂。 */
  (function syncHomepageFallbacks() {
    const p = path.join(REL, 'index.html');
    if (!fs.existsSync(p)) return;
    const before = fs.readFileSync(p, 'utf8');
    let html = before;
    const VER = '\\d+(?:\\.\\d+){2,3}';
    if (betaVersion) {
      html = html.replace(new RegExp('(keyword-highlighter-beta-v)' + VER + '(\\.(?:crx|zip))', 'g'), '$1' + betaVersion + '$2');
    }
    if (stableVersion) {
      html = html.replace(new RegExp('(release/keyword-highlighter-extension-)' + VER + '(\\.crx)', 'g'), '$1' + stableVersion + '$2');
    }
    if (html !== before) {
      fs.writeFileSync(p, html, 'utf8');
      log('已把首页静态兜底链接对齐到当前版本（测试版 ' + (betaVersion || '—') + ' / 稳定版 ' + (stableVersion || '—') + '）');
    }
  })();
  const files = all.filter((f) => !FORBIDDEN_RE.test(f) && SITE_FILE_RE.test(f) && (isCurrentPkg(f) || isAllowedOld(f)));
  const localOnly = all.filter((f) => !FORBIDDEN_RE.test(f) && (!SITE_FILE_RE.test(f) || !(isCurrentPkg(f) || isAllowedOld(f))));
  if (localOnly.length) log('仅本地保留：' + localOnly.slice(0, 8).join('、') + (localOnly.length > 8 ? ' …（共 ' + localOnly.length + ' 个）' : ''));
  if (currentVersions.length) log('当前版本（只发这两个版本的包）：' + currentVersions.join(' / '));
  if (skip.length) log('跳过不外发：' + skip.join('、'));
  if (!files.length) die('release/ 里没有可发布的文件');
  log('待发布文件：' + files.join('、'));

  /* ---- 预检：清单里引用的安装包**必须都在本次上传列表里** ----
   * 为什么需要：`update.xml` / `latest.json` / `latest-beta.json` 里写的是**站点路径**，
   * 而这些文件是靠"本地文件名 → 站点同名"上传的。一旦包被改了名或放进了子目录，
   * 就会出现"清单指向一个站点上不存在的文件" ⇒ 用户端自动更新 404，而发布脚本**当时看不出来**。
   * 2026-09-22 实测事故：晋级稳定版时 crx 被放到 `release/keyword-highlighter-extension-2.0.0.crx`
   * （子目录），而枚举不递归 ⇒ 没上传、`update.xml` 却已经指向它。只跑测试版永远发现不了。
   * 这里是**纯本地预检**（不碰网络、不受 CDN 缓存影响），跑在上传之前。 */
  (function preflightManifestRefs() {
    const toSitePath = (u) => String(u).replace(SITE + '/', '').replace(/^\/+/, '');
    const wanted = [];
    try {
      if (!BETA_ONLY) {
        const ux = fs.readFileSync(path.join(REL, 'update.xml'), 'utf8');
        const m = ux.match(/<updatecheck[^>]*codebase=['"]([^'"]+)['"]/);
        if (m) wanted.push(toSitePath(m[1]));
      }
    } catch (e) { /* 没稳定清单就算了 */ }
    try {
      if (!BETA_ONLY) {
        const lj = JSON.parse(fs.readFileSync(path.join(REL, 'latest.json'), 'utf8'));
        if (lj.zip) wanted.push(toSitePath(lj.zip));
        if (lj.crx) wanted.push(toSitePath(lj.crx));
      }
    } catch (e) { /* 同上 */ }
    try {
      const bj = JSON.parse(fs.readFileSync(path.join(REL, 'latest-beta.json'), 'utf8'));
      if (bj.zip) wanted.push(toSitePath(bj.zip));
      if (bj.crx) wanted.push(toSitePath(bj.crx));
    } catch (e) { /* 同上 */ }
    const missing = Array.from(new Set(wanted.filter((p) => p && files.indexOf(p) < 0)));
    if (missing.length) {
      die('清单引用的文件不在本次上传列表里：' + missing.join('、') +
        '\n  → 会出现"清单指向站点上不存在的文件"，用户端更新会失败。' +
        '\n  → 检查：包是不是被放进了 release/ 的子目录（枚举是否递归）？清单里的路径与本地文件名是否一致？');
    }
    if (wanted.length) log('预检通过：清单引用的 ' + wanted.length + ' 个文件都在上传列表里（' + wanted.join('、') + '）');
  })();

  /* ---- 预检：两条更新通道的 appid / 版本 / 产物一致（发布前硬门禁）----
   * 为什么需要：2026-10-04 实测 —— 线上 `update-beta.xml` 的 appid 是**旧密钥**推出的 ID，而线上测试版
   * crx 自身推导出来是当前密钥的 ID ⇒ 浏览器拿自己的扩展 ID 去 update xml 里找条目，对不上就**安静地不升级**：
   * 测试通道的自动更新一直是坏的，但发布日志里全是 ✓（当时只比 latest.json 的 sha256 与 update.xml 的版本）。
   * 期望值取自己入库的 `scripts/kh-autoupdate.bat`（用户真正双击运行的一键安装脚本）里的 BETA_ID/STABLE_ID
   * —— 密钥文件被 .gitignore 排除，CI 的检出里没有它们，而 bat 在库里有，所以这条校验在任何环境都成立。 */
  (function preflightChannels() {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-channels.js')], { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      die('更新通道自检未通过（见上）—— xml 的 appid/版本与 kh-autoupdate.bat 或清单不一致时发出去，' +
        '浏览器会因为找不到自己的扩展 ID 而**安静地不升级**。修好再发。');
    }
  })();

  /* ---- OCR 语言包（release/lang/*.traineddata.gz → 站点 lang/<文件>）----
   * 【为什么不放进交付包】两个包合计约 3.7MB，而多数用户用不到（不用图片识别就永不下载）；
   * 它们由扩展在用户点「下载」时按需取，见 vendor/README.md 与 vendor/tesseract/lang-manifest.json。
   * 上传前按**同一份清单**校验 sha256：否则会出现"本地包和清单哈希对不上、用户下载时才炸"。 */
  const entries = files.map((f) => ({ local: path.join(REL, f), remote: f }));
  const LANG_DIR = path.join(REL, 'lang');
  const LANG_MANIFEST = path.join(ROOT, 'vendor', 'tesseract', 'lang-manifest.json');
  /* `--skip-lang`：语言包**已经在站点上**且内容没变时跳过重传。
   * 为什么需要：GitHub 的 blob 接口对大文件（高精度包 19MB）频繁 5xx/401，
   * 而 gh-pages 建 tree 用的是 `base_tree`（合并）——**不发就等于原地保留**，所以跳过是安全的。
   * 发布日志里会明确打印"本次跳过语言包"，避免误以为它没发布。 */
  const SKIP_LANG = process.argv.indexOf('--skip-lang') >= 0;
  if (SKIP_LANG) log('⚠ --skip-lang：本次**不重传**语言包（站点上的保持原样，适合"包没变、只是重发版本号"）');
  if (!SKIP_LANG && fs.existsSync(LANG_DIR) && fs.existsSync(LANG_MANIFEST)) {
    const lm = JSON.parse(fs.readFileSync(LANG_MANIFEST, 'utf8'));
    /* 两档都要发（K67）：fast 走 `packs`，高精度走 `variants.*.packs` —— 少发一档，
     * 用户在设置页点了「下载高精度语言包」就会 404。 */
    const allPacks = {};
    for (const lang of Object.keys(lm.packs || {})) allPacks[lang] = { tier: 'fast', pack: lm.packs[lang] };
    for (const v of Object.keys(lm.variants || {})) {
      const ps = (lm.variants[v] && lm.variants[v].packs) || {};
      for (const lang of Object.keys(ps)) allPacks[lang] = { tier: v, pack: ps[lang] };
    }
    for (const lang of Object.keys(allPacks)) {
      const pack = allPacks[lang].pack;
      const abs = path.join(LANG_DIR, pack.file);
      if (!fs.existsSync(abs)) {
        /* 取包的路子按档位不同：fast 有官方源，高精度档只能从站点取回（见清单 _variants_note）。 */
        die('语言包不全：缺少 release/lang/' + pack.file + '（'
          + (allPacks[lang].tier === 'fast'
            ? '先跑 node scripts/fetch-lang.js'
            : '高精度档没有官方可下载源，用 node scripts/check-lang.js --fetch 从站点校验着取回')
          + '）');
      }
      const buf = fs.readFileSync(abs);
      const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
      if (sha !== String(pack.sha256).toUpperCase()) {
        die('语言包 ' + pack.file + ' 与清单里的 sha256 不一致（清单 ' + pack.sha256 + '，实际 ' + sha + '）—— 先跑 node scripts/fetch-lang.js --force');
      }
      /* 体积也卡：清单自称"体积与 sha256 的唯一真源"，而 sha256 对得上、bytes 记错这种事
       * 2026-10-05 真发生过（站点两份高精度包差了 1.8KB/3KB，谁都没发现）。 */
      if (Number(pack.bytes) && buf.length !== Number(pack.bytes)) {
        die('语言包 ' + pack.file + ' 的字节数与清单不一致（清单 ' + pack.bytes + '，实际 ' + buf.length
          + '）—— 清单是体积/sha256 唯一真源，先跑 node scripts/check-lang.js --live 看站点实际值');
      }
      entries.push({ local: abs, remote: 'lang/' + pack.file });
    }
    log('语言包：' + entries.filter((e) => e.remote.indexOf('lang/') === 0).map((e) => e.remote).join('、'));
  } else {
    log('⚠ 没有 release/lang —— 本次不发布 OCR 语言包（图片识别的运行时下载会 404）');
  }

  if (!TOKEN) {
    die('缺少凭据。请设置环境变量 GH_TOKEN（细粒度 token，只需该仓库 Contents: Read and write）。\n' +
        '  为了安全：建议用细粒度 token、只勾这一个仓库、设 1 天有效期，发完立即撤销。\n' +
        '  设置方式（当前 PowerShell 会话）：$env:GH_TOKEN = "github_pat_xxx"');
  }

  /* ① 校验凭据与仓库权限 */
  const looksGithub = /^(ghp_|github_pat_|gho_|ghs_)/.test(TOKEN);
  const me = await api('GET', '/user');
  if (!me.ok) {
    if (!looksGithub) {
      die('这个 token 不是 GitHub 的格式（它以 "' + TOKEN.slice(0, 5) + '" 开头）。\n' +
          '  GitHub 的 token 只有两种前缀：ghp_（经典）或 github_pat_（细粒度）。\n' +
          '  取一个：https://github.com/settings/tokens/new?scopes=repo&description=keyword-highlighter-release\n' +
          '  （若你刚才那个是别的服务的 token，建议立即吊销，它已经在对话里出现过了。）');
    }
    die('token 无效或已过期（HTTP ' + me.status + '）');
  }
  log('凭据用户：' + (me.json && me.json.login));
  const repo = await api('GET', '/repos/' + OWNER + '/' + REPO);
  if (!repo.ok) die('读不到仓库 ' + OWNER + '/' + REPO + '（HTTP ' + repo.status + '）—— token 是否包含该仓库？');
  const canPush = !!(repo.json && repo.json.permissions && repo.json.permissions.push);
  log('仓库权限：push=' + canPush + (canPush ? ' ✓' : ' ✗（token 需要 Contents: Read and write）'));
  if (!canPush && !DRY) die('token 没有写权限，无法发布');

  /* ② 找/建目标分支 */
  let ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  let parentSha = null;
  if (ref.ok) {
    parentSha = ref.json.object.sha;
    log('分支 ' + BRANCH + ' 已存在，父提交 ' + parentSha.slice(0, 8));
  } else if (ref.status === 404) {
    const def = (repo.json && repo.json.default_branch) || 'main';
    const dref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + def);
    if (!dref.ok) die('找不到分支 ' + BRANCH + '，也读不到默认分支 ' + def);
    parentSha = dref.json.object.sha;
    log('分支 ' + BRANCH + ' 不存在，将从 ' + def + '（' + parentSha.slice(0, 8) + '）创建');
    if (!DRY) {
      const mk = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: parentSha });
      if (!mk.ok) die('创建分支失败：' + mk.text.slice(0, 200));
      log('已创建分支 ' + BRANCH);
    }
  } else {
    die('读取分支失败：' + ref.text.slice(0, 200));
  }

  /* ③ 逐文件建 blob */
  const tree = [];
  for (const e of entries) {
    const abs = e.local;
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    log('  ' + e.remote.padEnd(38) + (buf.length / 1024).toFixed(1).padStart(7) + ' KB   sha256=' + sha256.slice(0, 12) + '…');
    if (DRY) continue;
    /* 【每个 blob 重试 3 次】实测 GitHub 的 blob 接口会**随机**返回 HTTP 500（空 body）——
     * 同一次发布里可能第 3 个文件失败、换一次又变成第 5 个失败；内容与鉴权都没问题
     * （单独用同样的请求打过去是 201）。这种 5xx 只能重试，重试后整次发布就过了。 */
    let blob = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
        content: buf.toString('base64'), encoding: 'base64'
      });
      if (blob.ok) break;
      if (!blob.ok) {
        /* 4xx 一般不该重试；但实测 GitHub 的 blob 接口会**偶发**返回 401 Bad credentials
         * （同一令牌、同一请求单独打过去是 201，隔一次发布就成功）—— 所以 401 也退避重试。 */
        const retryable = blob.status >= 500 || blob.status === 401;
        if (!retryable || attempt === 3) break;
        log('    ↻ blob 上传失败（HTTP ' + blob.status + '），第 ' + attempt + ' 次重试…');
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    if (!blob.ok) die('上传 blob 失败（' + e.remote + '）HTTP ' + blob.status + '：' + String(blob.text || '').slice(0, 300));
    tree.push({ path: e.remote, mode: '100644', type: 'blob', sha: blob.json.sha });
  }
  if (DRY) { log('\n--dry：以上为将发布的内容，未做任何提交。'); return; }

  /* ④ 一个 commit 提交全部文件（避免"传了一半"的中间态） */
  const parent = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + parentSha);
  if (!parent.ok) die('读父提交失败：' + parent.text.slice(0, 200));
  const treeRes = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
    base_tree: parent.json.tree.sha, tree: tree
  });
  if (!treeRes.ok) die('建 tree 失败：' + treeRes.text.slice(0, 200));
  /* 清单名随通道而变（latest.json / latest-beta.json）—— 别写死，测试通道发布时写死会 ENOENT ✗ */
  const manifestName = files.indexOf('latest-beta.json') >= 0 ? 'latest-beta.json' : 'latest.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(REL, manifestName), 'utf8'));
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: 'release v' + manifest.version + '\n\n' + entries.map((e) => e.remote).join('\n'),
    tree: treeRes.json.sha, parents: [parentSha]
  });
  if (!commit.ok) die('建 commit 失败：' + commit.text.slice(0, 200));
  const moved = await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.json.sha });
  if (!moved.ok) die('移动分支指针失败：' + moved.text.slice(0, 200));
  log('\n已发布到 ' + BRANCH + '，commit ' + commit.json.sha.slice(0, 8));

  /* ⑤ 线上核对（加时间戳绕开 CDN 缓存） */
  log('\n线上核对：');
  const t = Date.now();
  try {
    const r1 = await fetch(SITE + '/' + manifestName + '?t=' + t, { cache: 'no-store' });
    const j1 = await r1.json();
    const same = j1.sha256 === manifest.sha256;
    log('  ' + manifestName + '  version=' + j1.version + '  sha256=' + String(j1.sha256).slice(0, 12) + '…  ' + (same ? '✓ 与本地一致' : '⚠️ 与本地不一致（CDN 缓存，稍等几分钟再刷）'));
  } catch (e) { log('  latest.json 拉取失败：' + e.message); }
  try {
    const r2 = await fetch(SITE + '/update.xml?t=' + t, { cache: 'no-store' });
    const x = await r2.text();
    const v = (x.match(/<updatecheck[^>]*version=['"]([^'"]+)['"]/i) || [])[1];
    if (manifestName === 'latest-beta.json') {
      /* 发测试通道时稳定通道**本来就不动** —— 以前这里会打一句"⚠️ 仍是旧版"，看着像失败（实测误导过）。 */
      log('  update.xml    version=' + v + '（稳定通道，本次不动）');
    } else {
      log('  update.xml    version=' + v + (v === manifest.version ? '  ✓' : '  ⚠️ 仍是旧版（CDN 缓存）'));
    }
  } catch (e) { log('  update.xml 拉取失败：' + e.message); }
  /* 首页也要核对一次：它是"当前测试版"静态兜底链接的宿主，传丢了页面就会指回旧版本号
   * （JS 会按清单改写，但 JS 被挡/清单读不到时就落到静态值上）。 */
  try {
    const r3 = await fetch(SITE + '/index.html?t=' + t, { cache: 'no-store' });
    const html = await r3.text();
    const hit = html.indexOf(manifest.version) >= 0;
    log('  index.html    HTTP ' + r3.status + '  ' + html.length + ' 字节  ' +
      (hit ? '✓ 含当前版本 ' + manifest.version : '⚠️ 还没闪现版本 ' + manifest.version + '（CDN 缓存，稍后再刷）'));
  } catch (e) { log('  index.html 拉取失败：' + e.message); }
  /* 语言包（OCR 引擎按需下载的地址）：只在本次真的发了语言包时核对 */
  const langShipped = entries.filter((e) => e.remote.indexOf('lang/') === 0);
  if (langShipped.length) {
    for (const e of langShipped) {
      try {
        const r = await fetch(SITE + '/' + e.remote + '?t=' + t, { cache: 'no-store' });
        log('  ' + e.remote.padEnd(28) + ' HTTP ' + r.status + (r.ok ? '  ✓' : '  ⚠️ 尚未生效（CDN 缓存）'));
      } catch (err) { log('  ' + e.remote + ' 拉取失败：' + err.message); }
    }
  }
  /* 通道自检（线上）：整轮里最容易被漏掉的一项 —— 线上与本地不一致时，用户侧表现为"永远不升级"，
   * 而本地一切正常、日志全是 ✓。appid 是其中最致命的一项（2026-10-04 实测事故）。 */
  log('\n通道自检（线上）：');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-channels.js'), '--live', '--deep'], { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    log('  ⚠️ 线上通道自检未通过（见上）。注意 CDN 缓存；稍后可重跑：node scripts/check-channels.js --live --deep');
  }
  log('\n提示：GitHub Pages 有 CDN 缓存，Chrome 侧最长可能几十分钟后才看到新版本，属正常。');
})().catch((err) => die('发布异常：' + (err && err.message)));
