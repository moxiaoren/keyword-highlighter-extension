#!/usr/bin/env node
/**
 * crx 打包自检：解析 crx3 头验证「扩展 ID 与私钥一致」+「内嵌 manifest 版本」。
 * 用法：
 *   node scripts/verify-crx.js <xxx.crx> [key.pem]
 *     - 不传 key.pem 时，只校验内嵌 manifest 版本与 update_url，并打印扩展 ID。
 *     - 传 key.pem 时，额外校验 crx 内 public_key 计算的 ID === 私钥计算的 ID。
 * 退出码：0=通过，1=校验失败。
 *
 * ⚠️ 必须用严格 protobuf 遍历(crx3 signed header)，不能用「findIndex 找 ASN.1 DER 偏移」
 *    —— 那种启发式会找错偏移导致 ID 算错（历史踩坑）。
 */
'use strict';
const FS = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const crxPath = process.argv[2];
const keyPath = process.argv[3];
if (!crxPath) { console.error('用法: node scripts/verify-crx.js <xxx.crx> [key.pem]'); process.exit(2); }

const buf = FS.readFileSync(crxPath);
const map = 'abcdefghijklmnop';
const idFromDer = (der) => {
  const hexs = crypto.createHash('sha256').update(der).digest('hex');
  return hexs.slice(0, 32).split('').map(c => map[parseInt(c, 16)]).join('');
};

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) fail = 1; };

// ---- 解 crx3 头 ----
if (buf.slice(0, 4).toString() !== 'Cr24') { console.error('不是有效的 crx（缺 Cr24 magic）'); process.exit(1); }
const ver = buf.readUInt32LE(4);
const hsize = buf.readUInt32LE(8);
const hdr = buf.slice(12, 12 + hsize);
ok(ver === 3, `crx 头 version=${ver}（期望 3）`);

// ---- protobuf 遍历工具 ----
function* walkFields(b) {
  let i = 0;
  while (i < b.length) {
    let tag = b[i++];
    const field = tag >> 3, wire = tag & 7;
    if (wire === 0) { // varint
      let v = 0, s = 0;
      for (;;) { const byte = b[i++]; v |= (byte & 0x7f) << s; if (!(byte & 0x80)) break; s += 7; }
      yield { field, wire, value: v, offset: i };
    } else if (wire === 1) { yield { field, wire, bytes: b.slice(i, i + 8) }; i += 8; }
    else if (wire === 5) { yield { field, wire, bytes: b.slice(i, i + 4) }; i += 4; }
    else if (wire === 2) {
      let len = 0, s = 0;
      for (;;) { const byte = b[i++]; len |= (byte & 0x7f) << s; if (!(byte & 0x80)) break; s += 7; }
      const val = b.slice(i, i + len); i += len;
      yield { field, wire, bytes: val, offset: i };
    } else { console.error('无法解析 protobuf wire type ' + wire); process.exit(1); }
  }
}

// 找 sha256_with_rsa (field=2) => AsymmetricKeyProof { public_key=field1 }
let pubKey = null;
for (const f of walkFields(hdr)) {
  if (f.field === 2 && f.wire === 2) {
    for (const f2 of walkFields(f.bytes)) {
      if (f2.field === 1 && f2.wire === 2) { pubKey = f2.bytes; break; }
    }
    if (pubKey) break;
  }
}
ok(!!pubKey, '提取到 crx 内 public_key');
if (pubKey) {
  const idCrx = idFromDer(pubKey);
  console.log('  crx public_key 计算 ID:', idCrx);
  if (keyPath) {
    const pem = FS.readFileSync(keyPath, 'utf8');
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    const idKey = idFromDer(der);
    console.log('  私钥计算 ID      :', idKey);
    ok(idKey === idCrx, '扩展 ID 与私钥一致');
  }
}

// ---- 解内嵌 zip 里的 manifest.json ----
const zipStart = buf.indexOf(Buffer.from('PK\x03\x04'));
ok(zipStart > 0, '定位到内嵌 zip 数据');
if (zipStart > 0) {
  const zipBuf = buf.slice(zipStart);
  const manifestRaw = readEntry(zipBuf, 'manifest.json');
  if (manifestRaw) {
    const m = JSON.parse(manifestRaw.toString('utf8'));
    console.log('  manifest version :', m.version);
    console.log('  update_url       :', m.update_url);
    ok(!!m.version && !!m.update_url, '内嵌 manifest 含 version 与 update_url');
  } else {
    console.log('  ⚠️ 未在内嵌 zip 读到 manifest.json');
  }
}

console.log(fail ? '\n❌ crx 校验失败' : '\n✅ crx 校验通过');
process.exit(fail);

// ---- 从 zip 读取单文件（无依赖解析）----
function readEntry(zipBuf, targetName) {
  // 只解析 zip 中央目录/本地文件头的文件名与压缩方法；对方法0(store)直接取，方法8(deflate)解压
  let i = 0;
  // 扫描本地文件头
  while (i + 30 <= zipBuf.length) {
    if (zipBuf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const flags = zipBuf.readUInt16LE(i + 6);
    const method = zipBuf.readUInt16LE(i + 8);
    const compSize = zipBuf.readUInt32LE(i + 18);
    const nameLen = zipBuf.readUInt16LE(i + 26);
    const extraLen = zipBuf.readUInt16LE(i + 28);
    const name = zipBuf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === targetName) {
      const data = zipBuf.slice(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) {
        try { return zlib.inflateRawSync(data); } catch (e) { return null; }
      }
      return null;
    }
    i = dataStart + compSize;
  }
  return null;
}
