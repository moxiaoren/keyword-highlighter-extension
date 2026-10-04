/* scripts/check-channels.js — 两条更新通道的「身份证」自检（发布前硬门禁）
 *
 * 为什么需要（2026-10-04 实测）：
 *   线上 `update-beta.xml` 的 appid 是**旧密钥**推出的 ID（ehjcahea…），
 *   而线上那份测试版 crx（keyword-highlighter-beta-v2.0.0.9.crx）**从它自己的字节**推导
 *   （crx3 头部的 crx_id 字段 + 内嵌 RSA 公钥求 sha256，两处独立）都是 ohjcahea…
 *   ⇒ 浏览器升级时是拿「我自己这个扩展的 ID」去 update xml 里找 <app appid=…>，
 *     对不上就**安静地不升级**：测试通道的自动更新一直是坏的，而没有任何地方会报错。
 *   当时的发布后自检只比 `latest*.json` 的 sha256 与 `update.xml` 里的 version，**从不比 appid**。
 *   本脚本把 appid、版本、codebase 指向的产物、以及（本机有 crx 时）crx 自身的 ID 全部纳入校验。
 *
 * 期望值来自哪里：
 *   `scripts/kh-autoupdate.bat` —— 用户真正双击运行的一键安装脚本（已入库），里面有
 *   `set BETA_ID=` / `set STABLE_ID=`。它写进注册表的 ID 必须与 update xml 里公告的 ID 完全一致，
 *   否则「装了扩展的人」和「更新源公告的扩展」根本不是同一个东西。
 *   （为什么不从密钥算：`key*.pub.txt` 与 `*.pem` 都被 .gitignore 排除，CI 的检出里没有它们；
 *     而 kh-autoupdate.bat 是入库文件，任何环境都能读到 —— 于是在 CI 里也能做这道硬校验。）
 *
 * 用法：
 *   node scripts/check-channels.js                # 本地 release/ 自检（发布前，不一致即 exit 1）
 *   node scripts/check-channels.js --live         # 额外拉线上 xml / 清单核对 appid 与版本，并探一次 codebase 是否可达
 *   node scripts/check-channels.js --live --deep  # 再**真的下载**线上产物：zip 核 sha256、crx 用自身字节核 ID
 * --live/--deep 一律以**线上清单**为基准判"线上链是否自洽"；仓库 release/ 里的镜像落后只提示不判失败
 * （CI 发布不回写 main，镜像落后是常态 —— 2026-10-04 实测：拿镜像当基准把自洽的线上链误判成失败）。
 *   node scripts/check-channels.js --quiet        # 只打印机器可读摘要行
 *
 * 机器可读摘要：`CHANNELS ok stable=<id> beta=<id>` 或 `CHANNELS fail <原因…>`
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const SITE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
const ARGV = process.argv.slice(2);
const LIVE = ARGV.indexOf('--live') >= 0;
const QUIET = ARGV.indexOf('--quiet') >= 0;
const DEEP = ARGV.indexOf('--deep') >= 0;   // 需与 --live 同用：真的下载线上产物，核 sha256 / crx 自身 ID

const problems = [];
function bad(msg) { problems.push(msg); if (!QUIET) console.error('  ✗ ' + msg); }
function ok(msg) { if (!QUIET) console.log('  ✓ ' + msg); }
function info(msg) { if (!QUIET) console.log('    ' + msg); }

/* ── 期望的扩展 ID：从入库的一键安装脚本里读 ───────────────────────────── */
function readBatIds() {
  const p = path.join(ROOT, 'scripts', 'kh-autoupdate.bat');
  if (!fs.existsSync(p)) return { error: '缺 scripts/kh-autoupdate.bat（入库的权威副本）' };
  const buf = fs.readFileSync(p);                       // GBK，按字节找 ASCII 模式即可
  const txt = buf.toString('latin1');
  const grab = (name) => {
    const m = txt.match(new RegExp('set\\s+' + name + '\\s*=\\s*([a-p]{32})', 'i'));
    return m ? m[1].toLowerCase() : null;
  };
  const stable = grab('STABLE_ID'), beta = grab('BETA_ID');
  if (!stable || !beta) return { error: '在 kh-autoupdate.bat 里读不到 STABLE_ID / BETA_ID' };
  return { stable, beta };
}

/* ── crx 自身推导 ID（crx3 头部 crx_id + 内嵌 RSA 公钥，两处独立）──────── */
function idFromDer(der) {
  const d = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
  let s = '';
  for (const b of d) s += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  return s;
}
function hexToId(hex) { let s = ''; for (const c of hex) s += String.fromCharCode(97 + parseInt(c, 16)); return s; }
function pbWalk(buf) {
  let off = 0; const out = {};
  const vi = () => { let r = 0n, s = 0n; for (;;) { const b = buf[off++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return Number(r); };
  while (off < buf.length) {
    const k = vi(), f = Math.floor(k / 8), w = k % 8;
    if (w === 2) { const l = vi(); (out[f] = out[f] || []).push(buf.subarray(off, off + l)); off += l; }
    else if (w === 0) { (out[f] = out[f] || []).push(vi()); }
    else throw new Error('protobuf wiretype ' + w);
  }
  return out;
}
/** 返回 {crxId, pubId, pub} —— 解析失败返回 null（不抛，调用方决定怎么报） */
function parseCrx(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32LE(0) !== 0x34327243) return null;          // 'Cr24'
    const ver = buf.readUInt32LE(4);
    if (ver === 2) {
      const pkLen = buf.readUInt32LE(8);
      const pub = buf.subarray(16, 16 + pkLen);
      return { ver, crxId: null, pubId: idFromDer(pub), pub };
    }
    if (ver !== 3) return null;
    const hlen = buf.readUInt32LE(8);
    const F = pbWalk(buf.subarray(12, 12 + hlen));
    let crxId = null, pub = null;
    if (F[10000]) { const sd = pbWalk(F[10000][0]); if (sd[1]) crxId = hexToId(Buffer.from(sd[1][0]).toString('hex')); }
    if (F[2]) { const p = pbWalk(F[2][0]); if (p[1]) pub = p[1][0]; }
    return { ver, crxId, pubId: pub ? idFromDer(pub) : null, pub };
  } catch { return null; }
}

/* ── xml / 清单解析 ──────────────────────────────────────────────────── */
function readXml(file) {
  if (!fs.existsSync(file)) return null;
  const t = fs.readFileSync(file, 'utf8');
  const appid = (t.match(/<app\s[^>]*appid="([^"]+)"/i) || [])[1] || null;
  const codebase = (t.match(/<updatecheck\s[^>]*codebase="([^"]+)"/i) || [])[1] || null;
  const version = (t.match(/<updatecheck\s[^>]*version="([^"]+)"/i) || [])[1] || null;
  return { appid, codebase, version, file };
}
function readManifest(name) {
  const p = path.join(REL, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { __parseError: e.message }; }
}
const base = (u) => (u ? u.split('/').pop() : null);

/* ── 一条通道的校验 ─────────────────────────────────────────────────── */
function checkChannel(label, expectId, xmlName, manifestName, xmlMayLag) {
  if (!QUIET) console.log('\n' + label + '：');
  const xml = readXml(path.join(REL, xmlName));
  if (!xml) { bad(label + ' 缺少 release/' + xmlName); return; }
  if (xml.appid !== expectId) bad(label + ' ' + xmlName + ' 的 appid=' + xml.appid + ' 与 kh-autoupdate.bat 的 ' + expectId + ' 不一致（这就是"装了的人和更新源说的不是同一个扩展"）');
  else ok(xmlName + ' appid=' + xml.appid + '（与 kh-autoupdate.bat 一致）');

  const mf = readManifest(manifestName);
  if (!mf) bad(label + ' 缺少 release/' + manifestName);
  else if (mf.__parseError) bad(label + ' ' + manifestName + ' 不是合法 JSON：' + mf.__parseError);
  else {
    if (mf.version === xml.version) ok(manifestName + ' version=' + mf.version + '（与 ' + xmlName + ' 一致）');
    else if (xmlMayLag) {
      /* 测试通道的 zip 清单（latest-beta.json，release.js 每次发测试版都会重写）与 crx 更新源
       * （update-beta.xml，**手工维护**——release.js 的测试通道分支按规程明确"不要动 update.xml"）
       * 是两套独立机制，版本不一致是常态：zip 清单先走一步，crx 更新源等有签名 crx 时再手工跟进。
       * 所以这里只提示不判失败；这一条通道真正要硬的是 appid（上一行）与产物可达性（--live）。 */
      info('⚠️ ' + xmlName + ' version=' + xml.version + ' 落后于 ' + manifestName + ' 的 ' + mf.version + '（测试通道 crx 更新源手工维护，允许落后；zip 清单先走一步）');
    } else bad(label + ' ' + xmlName + ' 的 version=' + xml.version + ' 与 ' + manifestName + ' 的 ' + mf.version + ' 不一致');

    const zb = base(xml.codebase);
    if (zb && /\.zip$/i.test(zb)) {
      const zp = path.join(REL, zb);
      if (!fs.existsSync(zp)) info('（本机没有 ' + zb + '，跳过包哈希核对）');
      else {
        const h = crypto.createHash('sha256').update(fs.readFileSync(zp)).digest('hex').toUpperCase();
        const want = String(mf.sha256 || '').toUpperCase();
        if (want && h !== want) bad(label + ' ' + zb + ' 的实际 sha256=' + h.slice(0, 16) + ' 与 ' + manifestName + ' 声明的 ' + want.slice(0, 16) + ' 不一致');
        else if (want) ok(zb + ' sha256=' + h.slice(0, 16) + '…（与清单一致）');
      }
    }
  }

  /* 本机若有对应 crx：用它自己的字节再核一遍 appid（最强证据，CI 里通常没有这个文件） */
  const cb = base(xml.codebase);
  if (cb && /\.crx$/i.test(cb)) {
    const cp = path.join(REL, cb);
    if (!fs.existsSync(cp)) info('（本机没有 ' + cb + '，跳过 crx 自身 ID 核对）');
    else {
      const r = parseCrx(cp);
      if (!r) bad(label + ' ' + cb + ' 无法解析（不是 crx3/crx2？）');
      else {
        if (r.crxId && r.crxId !== xml.appid) bad(label + ' ' + cb + ' 头部 crx_id 推导=' + r.crxId + ' ≠ xml appid=' + xml.appid);
        if (r.pubId && r.pubId !== xml.appid) bad(label + ' ' + cb + ' 内嵌公钥推导=' + r.pubId + ' ≠ xml appid=' + xml.appid);
        if ((!r.crxId || r.crxId === xml.appid) && (!r.pubId || r.pubId === xml.appid)) ok(cb + ' 自身推导 ID=' + (r.crxId || r.pubId) + '（与 xml 一致）');
      }
    }
  }
}

/* ── 线上产物：可达性（--live）与内容（--deep）───────────────────────
 * 为什么单独一段：本仓历史上出过「crx 压根没进上传列表，而 update.xml 已经指向它 ⇒ 用户端自动更新 404」。
 * 只比 xml 里的 appid/版本抓不到这一类，必须真的去取那个地址。 */
async function checkArtifact(label, url, expectId, manifestName, t, online) {
  if (!url) { info(label + '：xml / 清单里没有产物地址，跳过'); return; }
  const name = url.split('/').pop();
  try {
    const head = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + t, { method: 'HEAD', cache: 'no-store' });
    if (!head.ok) bad('线上 ' + label + ' 产物不可达：HTTP ' + head.status + ' ' + name + '（用户端自动更新会 404）');
    else ok('线上 ' + name + ' 可达（HTTP ' + head.status + '）');
  } catch (e) { info(label + ' 产物探测失败：' + e.message); return; }
  if (!DEEP) { info('（加 --deep 会真的下载产物、核 sha256 与 crx 自身 ID）'); return; }
  let buf;
  try { buf = Buffer.from(await (await fetch(url + '?t=' + t, { cache: 'no-store' })).arrayBuffer()); }
  catch (e) { info(label + ' ' + name + ' 下载失败：' + e.message); return; }
  if (/\.crx$/i.test(name)) {
    const tmp = path.join(os.tmpdir(), 'kh-chk-' + name);
    try {
      fs.writeFileSync(tmp, buf);
      const r = parseCrx(tmp);
      if (!r) bad(label + ' 线上 ' + name + ' 不是可解析的 crx/crx3');
      else {
        const ids = [['头部 crx_id', r.crxId], ['内嵌公钥', r.pubId]].filter(([, v]) => v);
        for (const [how, id] of ids) if (id !== expectId) bad(label + ' 线上 ' + name + ' 的' + how + '推导 ID=' + id + ' ≠ xml 公告的 ' + expectId);
        if (ids.length && ids.every(([, v]) => v === expectId)) ok('线上 ' + name + ' 自身推导 ID=' + expectId + '（与 xml 一致）');
      }
    } finally { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } }
  } else {
    const h = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    /* 比对基准必须是**线上清单**：仓库里的 release/<manifest> 只是镜像，随时可能落后于线上
     * （CI 发布不回写 main）。2026-10-04 实测踩到：拿本地镜像当基准 ⇒ 线上明明自洽，
     * --deep 却报"线上 zip sha256 ≠ 清单声明"的假失败。 */
    const om = online || {};
    const lm = readManifest(manifestName) || {};
    const wantOnline = String(om.sha256 || '').toUpperCase();
    const wantLocal = String(lm.sha256 || '').toUpperCase();
    const want = wantOnline || wantLocal;
    if (!want) info(label + ' 线上 ' + name + ' sha256=' + h.slice(0, 16) + '…（清单未声明，无从比对）');
    else if (h !== want) bad(label + ' 线上 ' + name + ' sha256=' + h.slice(0, 16) + '… ≠ 线上清单声明的 ' + want.slice(0, 16) + '…');
    else ok('线上 ' + name + ' sha256=' + h.slice(0, 16) + '…（与线上清单一致）');
    if (wantOnline && wantLocal && wantOnline !== wantLocal) {
      info('⚠️ 仓库镜像 release/' + manifestName + ' 声明的 sha256=' + wantLocal.slice(0, 16)
        + '… 与线上清单 ' + wantOnline.slice(0, 16) + '… 不同（镜像待同步；本检查只判线上自洽，镜像落后不算失败）');
    }
  }
}

/* ── 线上核对（发布后）──────────────────────────────────────────────── */
async function checkLive(label, expectId, xmlName, manifestName, softVersion) {
  if (typeof fetch !== 'function') { info('本机 Node 无 fetch，跳过 --live 核对'); return; }
  const t = Date.now();
  /* **先拿线上清单**：--deep 的 sha256 比对必须以线上清单为基准（仓库镜像可能落后，见 checkArtifact 注释）。 */
  let online = null;
  try { online = await (await fetch(SITE + '/' + manifestName + '?t=' + t, { cache: 'no-store' })).json(); }
  catch (e) { info('线上 ' + manifestName + ' 拉取失败：' + e.message); }
  try {
    const x = await (await fetch(SITE + '/' + xmlName + '?t=' + t, { cache: 'no-store' })).text();
    const appid = (x.match(/<app\s[^>]*appid="([^"]+)"/i) || [])[1];
    const version = (x.match(/<updatecheck\s[^>]*version="([^"]+)"/i) || [])[1];
    if (appid !== expectId) bad('线上 ' + label + ' ' + xmlName + ' 的 appid=' + appid + ' ≠ ' + expectId + '（线上更新源指向的是另一个扩展，该通道实际不会升级；注意 CDN 缓存，稍后可重跑）');
    else ok('线上 ' + xmlName + ' appid=' + appid + ' version=' + version);
    const cb = (x.match(/<updatecheck\s[^>]*codebase="([^"]+)"/i) || [])[1];
    await checkArtifact(label, cb, expectId, manifestName, t, online);
    const src = online || readManifest(manifestName) || {};
    for (const u of [src.zip, src.crx]) if (u && u !== cb) await checkArtifact(label + '·清单', u, expectId, manifestName, t, online);
  } catch (e) { info('线上 ' + xmlName + ' 拉取失败：' + e.message); }
  if (online) {
    const mf = readManifest(manifestName);
    if (mf && !mf.__parseError && String(online.version) !== String(mf.version)) {
      /* 仓库里的镜像不是发布源：CI 发布不回写 main，本地也可能先 bump 再发 —— 两种都属常态。
       * 线上链是否自洽由 appid / 产物可达性 / 线上清单哈希三条硬判，镜像落后只提示。 */
      info('⚠️ 线上 ' + manifestName + ' version=' + online.version + ' ≠ 仓库镜像 release/' + manifestName + ' 的 ' + mf.version
        + '（镜像待同步，以线上为准' + (softVersion ? '；测试通道尤其常见' : '') + '）');
    } else ok('线上 ' + manifestName + ' version=' + online.version);
  }
}

(async () => {
  if (!QUIET) console.log('=== 更新通道自检（appid / 版本 / 产物） ===');
  const ids = readBatIds();
  if (ids.error) { console.error('  ✗ ' + ids.error); console.log('CHANNELS fail ' + ids.error); process.exit(1); }
  if (!QUIET) console.log('  kh-autoupdate.bat: STABLE_ID=' + ids.stable + '  BETA_ID=' + ids.beta);

  checkChannel('稳定通道', ids.stable, 'update.xml', 'latest.json', false);
  checkChannel('测试通道', ids.beta, 'update-beta.xml', 'latest-beta.json', true);

  if (LIVE) {
    if (!QUIET) console.log('\n线上核对（--live）：');
    await checkLive('稳定通道', ids.stable, 'update.xml', 'latest.json', false);
    await checkLive('测试通道', ids.beta, 'update-beta.xml', 'latest-beta.json', true);
  }

  if (problems.length) {
    console.error('\n共 ' + problems.length + ' 项不一致：');
    problems.forEach((p, i) => console.error('  ' + (i + 1) + '. ' + p));
    console.log('CHANNELS fail ' + problems.length + ' 项');
    process.exit(1);
  }
  if (!QUIET) console.log('\n两条通道的 appid / 产物一致 ✓（版本口径：稳定通道本地/线上/两份清单都必须相等；测试通道 crx 更新源允许落后、线上版本只提示）');
  console.log('CHANNELS ok stable=' + ids.stable + ' beta=' + ids.beta);
})();
