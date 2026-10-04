/* tests/specs/update.test.js — 发版更新：双通道探测 / 版本比较 / 镜像回退 / SHA256 校验
 * ----------------------------------------------------------------------------
 * 为什么值得单测：更新逻辑平时跑不到（只有真发新版才触发），一旦写错，
 * 用户端表现是"永远说已是最新"或"误报有更新"——两种都很难被发现。
 * 这里把两条通道的合并规则、镜像回退、以及校验逻辑都钉住，不发版也能验。
 */
'use strict';
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const UC_PATH = path.join(__dirname, '..', '..', 'background', 'update-checker.js');

/** 每个用例都拿一份干净副本（避免互相污染被替换的 fetchCrxChannel 等） */
function fresh() {
  delete require.cache[require.resolve(UC_PATH)];
  const U = require(UC_PATH);
  U._readCache = async () => null;
  U._writeCache = async () => {};
  return U;
}

module.exports = async function run() {
suite('发版更新 · 双通道（crx / zip）');

await test('版本比较：常规 / 四段 / 前导 v / 空值', () => {
  const U = fresh();
  eq(U.compareVersions('2.1.0', '2.0.9'), 1, '2.1.0 > 2.0.9');
  eq(U.compareVersions('2.1.0', '2.1.0'), 0, '相同版本');
  eq(U.compareVersions('v2.1.0', '2.1.0'), 0, '忽略前导 v');
  eq(U.compareVersions('2.1.0.1', '2.1.0'), 1, '四段版本按段比较');
  eq(U.compareVersions('', '2.1.0'), -1, '空版本视为 0');
});

await test('版本比较：预发布后缀（预发布 < 同号正式版）', () => {
  const U = fresh();
  eq(U.compareVersions('2.2.0-beta.1', '2.2.0'), -1, '2.2.0-beta.1 旧于 2.2.0');
  eq(U.compareVersions('2.2.0', '2.2.0-beta.1'), 1, '2.2.0 新于 2.2.0-beta.1');
  eq(U.compareVersions('2.2.0', '2.1.9'), 1, '核心段仍然参与比较');
  eq(U.compareVersions('2.2.0-beta.1', '2.2.0-beta.1'), 0, '同预发布相等');
});

await test('★ 缓存命中也要按「当前版本」重算：已经装上缓存里那个版本时不得再报有更新', async () => {
  /* 实测缺陷（1.99.99.22 用户反馈）：check() 命中缓存时只换了 currentVersion，
   * hasUpdate/latestVersion 原样带出 → 用户升级到缓存里那个版本之后，
   * 弹窗一直显示「发现新版本 v<正好是当前版本>」，直到缓存过期。 */
  const U = fresh();
  /* 情形 A：缓存里记的就是当前版本，但结论是旧的 true（同号不该报更新）→ 必须重算成 false */
  U._readCache = async () => ({
    updateChannel: 'beta', checkedAt: Date.now(), channel: 'beta',
    latestVersion: '1.99.99.22', currentVersion: '1.99.99.22', hasUpdate: true
  });
  const a = await U.check('1.99.99.22', { channel: 'beta' });
  falsy(a.hasUpdate, '同号 → 不得再报有更新（旧写法会原样带出缓存的 true）');
  eq(a.currentVersion, '1.99.99.22', 'currentVersion 必须是当前运行的版本');
  truthy(a.fromCache, '同一个版本时仍可复用缓存（不必每次都打更新源）');

  /* 情形 B：缓存是升级前写的（currentVersion 比现在低）→ 缓存结论作废，必须真查一次 */
  const U2 = fresh();
  let probed = false;
  U2._readCache = async () => ({
    updateChannel: 'beta', checkedAt: Date.now(), channel: 'beta',
    latestVersion: '1.99.99.22', currentVersion: '1.99.99.21', hasUpdate: true
  });
  U2.fetchCrxChannel = async () => { probed = true; return null; };
  U2.fetchZipChannel = async () => null;
  const b = await U2.check('1.99.99.22', { channel: 'beta' });
  truthy(probed, '升级过（本地版本 ≠ 缓存里记的）→ 不能再吃旧缓存，必须真查一次');
  falsy(b.fromCache, '这条结果不该被标成 fromCache');
});

await test('★ 本地版本与缓存里记的不一致（刚升级）→ 缓存作废、必须真的重新检查', async () => {
  const U = fresh();
  let probed = false;
  U._readCache = async () => ({
    updateChannel: 'beta', checkedAt: Date.now(), channel: 'beta',
    latestVersion: '1.99.99.22', currentVersion: '1.99.99.21', hasUpdate: true
  });
  U.fetchCrxChannel = async () => { probed = true; return null; };
  U.fetchZipChannel = async () => null;
  const r = await U.check('1.99.99.23', { channel: 'beta' });
  truthy(probed, '升级过（本地版本 ≠ 缓存里记的）→ 不能再吃旧缓存，必须真查一次');
  falsy(r.fromCache, '这条结果不该被标成 fromCache');
});

await test('gupdate XML 解析：不误取 XML 声明里的 version="1.0"', () => {
  const U = fresh();
  const xml = '<?xml version="1.0" encoding="UTF-8"?><gupdate><app appid="x">' +
    '<updatecheck codebase="https://a/b.crx" version="2.2.0"/></app></gupdate>';
  const r = U._parseUpdateXml(xml);
  eq(r.version, '2.2.0', '版本取 updatecheck 的');
  eq(r.codebase, 'https://a/b.crx', '取到 crx 地址');
  eq(U._parseUpdateXml('<gupdate></gupdate>'), null, '没有 updatecheck → null');
});

await test('latest.json 解析：sha256 归一为大写；缺 version 视为无效', () => {
  const U = fresh();
  const p = U._parseLatestJson('{"version":"2.2.0","zip":"https://a/b.zip","sha256":"abc123","notes":"修了X"}');
  eq(p.version, '2.2.0', '版本');
  eq(p.zipUrl, 'https://a/b.zip', 'zip 地址');
  eq(p.sha256, 'ABC123', 'sha256 统一大写（与算出来的十六进制对齐）');
  eq(p.notes, '修了X', '更新说明');
  eq(U._parseLatestJson('{}'), null, '无 version → 无效');
  eq(U._parseLatestJson('not json'), null, '非法 JSON → 无效（不抛）');
});

await test('两条通道并行：取版本更高的一条，字段互相补充', async () => {
  const U = fresh();
  U.fetchCrxChannel = async () => ({ channel: 'crx', version: '2.1.5', crxUrl: 'https://a/1.crx', source: 'm-crx' });
  U.fetchZipChannel = async () => ({ channel: 'zip', version: '2.2.0', zipUrl: 'https://a/2.zip', crxUrl: 'https://a/2.crx', sha256: 'DEAD', notes: 'n', source: 'm-zip' });
  const info = await U.check('2.1.0');
  truthy(info.hasUpdate, '应判定有更新');
  eq(info.latestVersion, '2.2.0', '取更高的 zip 版本');
  eq(info.sha256, 'DEAD', 'sha256 来自 zip 通道');
  eq(info.crxUrl, 'https://a/2.crx', 'crx 地址优先用 zip 清单里的');
  truthy(info.channels.crx.ok && info.channels.zip.ok, '两条通道都标记可用');
});

await test('单通道可用也能发现更新（另一条挂了不影响）', async () => {
  const U = fresh();
  U.fetchCrxChannel = async () => ({ channel: 'crx', version: '2.1.5', crxUrl: 'https://a/1.crx', source: 'm-crx' });
  U.fetchZipChannel = async () => null;
  const info = await U.check('2.1.0');
  truthy(info.hasUpdate, '仅 crx 通道也要能发现更新');
  eq(info.latestVersion, '2.1.5', '版本来自 crx 通道');
  eq(info.channels.zip.ok, false, 'zip 通道标记为不可用');
});

await test('两条通道都不可达：报"不可达"而不是"已是最新"', async () => {
  const U = fresh();
  U.fetchCrxChannel = async () => null;
  U.fetchZipChannel = async () => null;
  const info = await U.check('2.1.0');
  falsy(info.hasUpdate, '不得误报有更新');
  eq(info.latestVersion, null, 'latestVersion 为 null 表示远端不可达（popup 据此提示失败）');
  truthy(info.checkedAt > 0, '仍要记录检查时间');
});

await test('镜像回退：第一个源失败自动试下一个，并记下来源', async () => {
  const U = fresh();
  const tried = [];
  U._getText = async (url) => {
    tried.push(url);
    if (url.indexOf('jsdelivr') >= 0) return '{"version":"3.0.0","zip":"https://a/b.zip"}';
    return null;                       // 前两个源都挂
  };
  const r = await U.fetchZipChannel();
  eq(r.version, '3.0.0', '回退到第二个镜像后拿到版本');
  truthy(r.source.indexOf('jsdelivr') >= 0, '记录实际使用的源，便于排查');
  truthy(tried.length >= 2, '确实按顺序试了多个源，实际试了 ' + tried.length + ' 个');
});

await test('缓存：TTL 内直接用缓存，force 跳过', async () => {
  const U = fresh();
  let calls = 0;
  U.fetchCrxChannel = async () => { calls++; return { channel: 'crx', version: '9.9.9', crxUrl: null, source: 's' }; };
  U.fetchZipChannel = async () => null;
  let cache = null;
  U._readCache = async () => cache;
  U._writeCache = async (i) => { cache = i; };
  const a = await U.check('2.1.0');
  eq(calls, 1, '首次查询打了一次网络');
  const b = await U.check('2.1.0');
  eq(calls, 1, 'TTL 内不再打网络');
  truthy(b.fromCache, '标记来自缓存');
  eq(b.latestVersion, '9.9.9', '缓存内容仍然可用');
  await U.check('2.1.0', { force: true });
  eq(calls, 2, 'force=true 时跳过缓存重新查询');
});

await test('SHA256：一致才算通过；不一致/网络失败都拒绝', async () => {
  const U = fresh();
  U.fetchSha256 = async () => 'ABC123';
  let r = await U.downloadAndVerify('https://a/b.zip', 'ABC123');
  truthy(r.ok, '哈希一致 → 通过');
  truthy(r.verified, '标记为已校验');
  r = await U.downloadAndVerify('https://a/b.zip', 'abc123');
  truthy(r.ok, '期望值大小写不同也应通过');
  r = await U.downloadAndVerify('https://a/b.zip', 'FFFF');
  falsy(r.ok, '不一致 → 拒绝');
  truthy(/校验失败/.test(r.reason || ''), '给出可读的失败原因，实际 ' + r.reason);
  U.fetchSha256 = async () => null;
  r = await U.downloadAndVerify('https://a/b.zip', 'ABC123');
  falsy(r.ok, '下载失败 → 拒绝');
  r = await U.downloadAndVerify(null, 'ABC123');
  falsy(r.ok, '没有地址 → 拒绝');
  U.fetchSha256 = async () => 'ABC123';
  r = await U.downloadAndVerify('https://a/b.zip', null);
  truthy(r.ok, '清单没给 sha256 时跳过校验但下载仍算成功（老清单不至于不可用）');
  falsy(r.verified, '未校验就不标记 verified');
});
test('更新通道：稳定版读 latest.json、测试版读 latest-beta.json（两份清单分开）', () => {
  const U = fresh();
  const s = U.latestMirrors('stable')[0];
  const b = U.latestMirrors('beta')[0];
  truthy(/latest\.json$/.test(s), '稳定通道读 latest.json，实际 ' + s);
  truthy(/latest-beta\.json$/.test(b), '测试通道读 latest-beta.json，实际 ' + b);
  eq(U.latestMirrors('stable').length, 3, '两个通道各配 3 个镜像');
  eq(U.latestMirrors('不存在的通道')[0].indexOf('latest.json') > 0, true, '未知通道回退到稳定版');
});

test('更新通道：测试版下 crx 通道不参与比较（update.xml 只有稳定版一份）', async () => {
  const U = fresh();
  U.fetchCrxChannel = async () => ({ channel: 'crx', version: '9.9.9', crxUrl: 'https://a/x.crx', source: 's' });
  U.fetchZipChannel = async () => ({ channel: 'zip', updateChannel: 'beta', version: '2.1.0', zipUrl: 'https://a/b.zip', source: 's' });
  const info = await U.check('1.51.0', { channel: 'beta' });
  eq(info.updateChannel, 'beta', '结果里标明当前通道');
  eq(info.latestVersion, '2.1.0', '测试通道下不应取 crx 的 9.9.9（那是稳定版的东西）');
  truthy(info.hasUpdate, '测试版用户应能看到测试版更新');
});

test('更新通道：缓存按通道隔离（切了通道必须重新查）', async () => {
  const U = fresh();
  let calls = 0;
  U.fetchCrxChannel = async () => null;
  U.fetchZipChannel = async () => { calls++; return { channel: 'zip', updateChannel: 'x', version: '2.1.0', zipUrl: 'https://a/b.zip', source: 's' }; };
  let cache = null;
  U._readCache = async () => cache;
  U._writeCache = async (i) => { cache = i; };
  await U.check('1.51.0', { channel: 'stable' });
  eq(calls, 1, '稳定通道查一次');
  await U.check('1.51.0', { channel: 'stable' });
  eq(calls, 1, '稳定通道命中缓存');
  await U.check('1.51.0', { channel: 'beta' });
  eq(calls, 2, '切到测试通道必须重新查，不能复用稳定通道的缓存');
});
};
