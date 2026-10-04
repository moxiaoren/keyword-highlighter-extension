/* ============================================================================
 * scripts/edge-policy.js — 用 Edge 的强制安装策略装上**测试版**（需要管理员）
 * ----------------------------------------------------------------------------
 * 为什么用它：非商店扩展只能靠策略强制安装才能变成"真安装"——
 *   ✓ 出现在 edge://extensions 里像正常扩展一样
 *   ✓ **会按 update-beta.xml 自动更新**（解压加载那条路不会 ✗）
 *   ✓ ID 固定为测试版 ID，与正式版并存互不影响
 *
 * ⚠️ 代价（强制安装的固有行为，必须知道）：
 *   · 装了策略后，Edge 会显示「你的浏览器由你的组织管理」；
 *   · 该扩展**无法在 edge://extensions 里关闭或删除**（策略锁住）；
 *   · 策略写在 HKLM（对本机所有 Windows 用户生效），**需要管理员权限**。
 *   想恢复：`node scripts/edge-policy.js remove`（或在「注册表编辑器」里删掉那个值）+ 重启 Edge。
 *
 * 用法（在**管理员** PowerShell 里跑）：
 *   node scripts/edge-policy.js status     # 看当前策略
 *   node scripts/edge-policy.js install    # 装上测试版（写入策略）
 *   node scripts/edge-policy.js remove     # 撤掉策略（扩展会变成可删除的普通扩展）
 *
 * 参数：
 *   --channel beta|stable   装哪条通道（默认 beta）
 * ========================================================================= */

'use strict';
const { execFileSync } = require('child_process');

const ap = process.argv.slice(2);
const ACTION = (ap[0] || 'status').toLowerCase();
const CH_I = ap.indexOf('--channel');
const CHANNEL = CH_I >= 0 ? ap[CH_I + 1] : 'beta';

const KEYS = [
  'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist',
  'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'
];
const BETA_ID = 'ohjcaheamdifcldcofpblbejlpmgnhjc';
const STABLE_ID = 'kpakjonpfookjchkfinfhkojiamjcedj';
const BASE = 'https://moxiaoren.github.io/keyword-highlighter-extension';
const ENTRY = (CHANNEL === 'stable' ? STABLE_ID : BETA_ID) + ';' +
  BASE + (CHANNEL === 'stable' ? '/update.xml' : '/update-beta.xml');

function log(m) { console.log(m); }
function die(m) { console.error('\n✗ ' + m); process.exit(1); }

/** 是否管理员（写 HKLM 的前提） */
function isAdmin() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { encoding: 'utf8' }).trim();
    return /true/i.test(out);
  } catch (e) { return false; }
}

/** 读策略列表（键名 → 值） */
function readList() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'if (Test-Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist") {' +
      ' (Get-Item "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist").Property | ' +
      ' ForEach-Object { "$_=" + (Get-ItemProperty "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist").$_ } }'
    ], { encoding: 'utf8' });
    const map = {};
    out.split(/\r?\n/).forEach((l) => { const i = l.indexOf('='); if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return map;
  } catch (e) { return {}; }
}

function run(ps) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', stdio: 'pipe' });
}

if (ACTION === 'status') {
  log('管理员权限：' + (isAdmin() ? '有 ✓' : '无 ✗（安装需要管理员）'));
  const list = readList();
  const keys = Object.keys(list);
  if (!keys.length) log('ExtensionInstallForcelist：未设置');
  else { log('ExtensionInstallForcelist：'); keys.forEach((k) => log('  ' + k + ' = ' + list[k])); }
  const installed = keys.some((k) => String(list[k]).indexOf(BETA_ID) >= 0);
  const stable = keys.some((k) => String(list[k]).indexOf(STABLE_ID) >= 0);
  log('  测试版已强装：' + (installed ? '是 ✓' : '否'));
  log('  正式版已强装：' + (stable ? '是' : '否'));
  process.exit(0);
}

if (ACTION === 'install') {
  if (!isAdmin()) die('需要**管理员**权限才能写 HKLM。请用「以管理员身份运行」的 PowerShell 再跑一次这条命令：\n  node scripts/edge-policy.js install --channel ' + CHANNEL);
  const list = readList();
  const keys = Object.keys(list);
  /* 找一个没占用的编号（策略值名必须是 1、2、3…） */
  let n = 1;
  while (keys.indexOf(String(n)) >= 0) n++;
  /* ！！绝不能用 New-Item -Force 来"确保键存在"！！
   * 注册表 provider 在键**已存在时会清空它的所有值** —— 实测踩到：本机原有的
   * ExtensionInstallForcelist\1（正式版强装条目）被我一次 New-Item -Force 直接抹掉 ✗。
   * 正确做法：先 Test-Path 判断，只在**不存在**时创建 ✓ */
  const ps = 'if (-not (Test-Path "' + KEYS[0] + '")) { New-Item -Path "' + KEYS[0] + '" | Out-Null }; ' +
    'Set-ItemProperty -Path "' + KEYS[0] + '" -Name "' + n + '" -Value "' + ENTRY + '" -Type String; ' +
    'Write-Output "ok"';
  try { run(ps); } catch (e) { die('写注册表失败：' + (e && e.message)); }
  log('已写入强制安装策略：');
  log('  HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\\' + n + ' = ' + ENTRY);
  log('');
  log('接下来：');
  log('  1) **完全退出 Edge**（所有窗口都关掉；任务管理器里确认没有 msedge.exe）');
  log('  2) 重新打开 Edge → Edge 会自己从上面的 update-url 下载并安装测试版');
  log('  3) 打开 edge://extensions 应能看到它；edge://policy 里能看到这条策略');
  log('');
  log('⚠️ 装了策略后：Edge 会显示「由你的组织管理」，且该扩展**无法被关闭/删除**（策略锁）。');
  log('   想撤掉：node scripts/edge-policy.js remove（管理员）→ 重启 Edge。');
  process.exit(0);
}

if (ACTION === 'remove') {
  if (!isAdmin()) die('需要**管理员**权限。请用管理员 PowerShell 再跑一次：node scripts/edge-policy.js remove');
  const list = readList();
  const keys = Object.keys(list);
  /* 按**通道**精确移除：--channel beta 只删测试版那条，别把正式版一起删掉 ✗ */
  const wantId = CHANNEL === 'stable' ? STABLE_ID : BETA_ID;
  const hit = keys.filter((k) => String(list[k]).indexOf(wantId) >= 0);
  if (!hit.length) { log('策略里没有' + (CHANNEL === 'stable' ? '正式版' : '测试版') + '条目，无需清理。'); process.exit(0); }
  const ps = hit.map((k) => 'Remove-ItemProperty -Path "' + KEYS[0] + '" -Name "' + k + '" -ErrorAction SilentlyContinue;').join(' ') + ' Write-Output "ok"';
  try { run(ps); } catch (e) { die('删除失败：' + (e && e.message)); }
  log('已移除策略：' + hit.join('、'));
  log('重启 Edge 后：扩展会变成**可手动关闭/删除**的普通扩展（不会自动卸载）。');
  process.exit(0);
}

die('未知动作：' + ACTION + '（可用：status / install / remove）');
