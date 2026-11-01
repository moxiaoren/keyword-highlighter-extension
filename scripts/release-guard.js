/* scripts/release-guard.js — 发版的事务性护栏（三条前置 + 一条收尾）
 *
 * 为什么需要它（2026-10-29 / round 70 的 2.0.7.2 事故）：
 *   那一版在**工作树有未提交改动**的情况下被打包发出去了，随后同一版本号又被重打一次顶掉。
 *   结果是"线上下载到的 2.0.7.2"没有任何提交能复现 —— 真源码从未进过远端 main，
 *   最后只能拿 gh-pages 上的 zip 逆向还原 15 个文件。
 *   三件事同时缺失才会出这种事：
 *     ① 没有检查工作树 —— 发出去的东西不属于任何提交；
 *     ② 没有检查版本号是否已被占用 —— 同名版本可以重发，线的两端指向不同字节；
 *     ③ 发完不打 tag —— 事后无从知道"这个版本号对应哪个提交"。
 *   所以把 ①② 做成**前置拒绝**，③ 做成**成功后自动落**，三条都放在这一处，
 *   稳定版与测试版共用（两条通道各有自己的清单与 tag 后缀）。
 *
 * 用法（脚本内）：
 *   const guard = require('./release-guard');
 *   guard.assertCleanTree(ROOT, { allowDirty });
 *   await guard.assertVersionUnused({ version, manifestUrl, allowReuse });
 *   guard.tagRelease(ROOT, version, { channel: 'stable' });
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 跑一条 git 命令；失败时抛错（调用方决定是拒绝还是降级警告） */
function git(root, args) {
  return execFileSync('git', ['-C', root].concat(args), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

function tryGit(root, args) {
  try {
    return { ok: true, out: git(root, args) };
  } catch (err) {
    return { ok: false, err: err, code: err && err.code };
  }
}

/** ① 工作树必须干净：只要有**已跟踪文件**的改动就拒绝（未跟踪的新文件不算，产物本来就新写） */
function assertCleanTree(root, opts) {
  const allowDirty = !!(opts && opts.allowDirty);
  const r = tryGit(root, ['status', '--porcelain', '--untracked-files=no']);
  if (!r.ok) {
    return { checked: false, reason: '无法运行 git（' + ((r.err && r.err.code) || '未知错误') + '），跳过工作树检查' };
  }
  const lines = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { checked: true, dirty: 0 };
  if (allowDirty) return { checked: true, dirty: lines.length, allowed: true };
  const err = new Error('工作树有 ' + lines.length + ' 个未提交的改动');
  err.detail = lines.slice(0, 12).join('\n      ');
  if (lines.length > 12) err.detail += '\n      …（还有 ' + (lines.length - 12) + ' 个）';
  throw err;
}

/** 版本号逐段比较（2.0.8 vs 2.0.8.1 → 前者小；2.0.7.2 vs 2.0.8 → 前者小） */
function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** ② 线上同名版本必须不存在：同版本重发 = 线上两端字节不一致（2.0.7.2 事故的形态） */
async function assertVersionUnused(opts) {
  const version = opts.version;
  const allowReuse = !!opts.allowReuse;
  const manifestUrl = opts.manifestUrl;
  let online = null;
  let note = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(manifestUrl, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) online = await res.json();
    else note = '线上清单返回 ' + res.status;
  } catch (err) {
    note = '读不到线上清单（' + ((err && err.message) || '网络错误') + '）';
  }
  if (!online || !online.version) {
    return { checked: false, reason: note || '线上清单里没有 version 字段，跳过版本占用检查' };
  }
  const rel = cmpVersion(online.version, version);
  if (rel > 0) {
    const err = new Error('线上已经是 ' + online.version + '，比本地的 ' + version + ' 更新' +
      '（本地工作树落后了？先同步再发）');
    throw err;
  }
  if (rel === 0 && !allowReuse) {
    const err = new Error('版本 ' + version + ' 已经在线上发布过 —— 重发会让同名版本指向另一份字节。' +
      '请先 bump 版本号（`node scripts/bump-version.js`）；确认要覆盖就加 --allow-reuse');
    throw err;
  }
  return { checked: true, online: online.version, reuse: rel === 0 };
}

/** ③ 成功出包后自动打 tag：让"版本号 → 提交"这条链断不了（只打本地，推送与否由人决定） */
function tagRelease(root, version, opts) {
  const channel = (opts && opts.channel) || 'stable';
  const name = 'v' + version + (channel === 'beta' ? '-beta' : '');
  const exists = tryGit(root, ['rev-parse', '-q', '--verify', 'refs/tags/' + name]);
  if (exists.ok) {
    return { tagged: false, name: name, reason: 'tag ' + name + ' 已存在（不移动已发布的 tag）' };
  }
  const head = tryGit(root, ['rev-parse', '--short', 'HEAD']);
  if (!head.ok) {
    return { tagged: false, name: name, reason: '无法运行 git，未打 tag（请在提交后手工 git tag ' + name + '）' };
  }
  try {
    git(root, ['tag', '-a', name, '-m', 'release ' + version + '（' + channel + ' 通道）']);
    return { tagged: true, name: name, commit: head.out };
  } catch (err) {
    return { tagged: false, name: name, reason: 'git tag 失败：' + ((err && err.message) || '') };
  }
}

module.exports = { assertCleanTree, assertVersionUnused, tagRelease, cmpVersion };
