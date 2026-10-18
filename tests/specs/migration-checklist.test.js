/* tests/specs/migration-checklist.test.js — 交接清单必须只有一个作者（2026-10-11 任务 P 根治）
 * ----------------------------------------------------------------------------
 * 为什么需要这条：
 *   `_MIGRATION_CHECKLIST.md` 原先有两个来源 —— Node 入口在**打包期现渲染**，PS1 入口**原样打工作区
 *   根那份手工快照**。结果是同一个迁移包里两种内容（3492 B / 锚点 2.0.1.12 vs 3962 B / 锚点 2.0.0.9），
 *   而清单正是「下家接手第一眼看的版本锚点」。根治办法：正文唯一作者 = migration-make.js 的
 *   renderChecklist()，库内那份由 `--write-checklist` 落盘，**两条打包入口都原样打它**。
 *   这里把这条契约钉死，并盯住两个真实踩过的坑：
 *     · 「打包期现渲染」一旦被改回来，两入口又会分叉（源码里不许再出现 Buffer.from(renderChecklist())）；
 *     · PS1 文件必须**UTF-8 带 BOM**，否则 Windows PowerShell 5.1 把中文注释读成乱码
 *       （实测：编辑工具重写该文件会把 BOM 吃掉，脚本自己只在开头软告警，不改回来没人知道）。
 *
 * 位置：_tools/ 在工作区里、不在扩展仓库内（同 baseline-matcher.test.js 的做法），**找不到就明红**（票 #47）——
 * 单克隆扩展仓库时这套断言不适用，但也不能假红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

/** __dirname = <工作区>/work/keyword-highlighter/tests/specs → 向上 4 级 = 工作区 */
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NODE_TOOL = path.join(ROOT, '_tools', 'migration-make.js');
const PS1_TOOL = path.join(ROOT, '_tools', 'make-migration-zip.ps1');
const CHECKLIST = path.join(ROOT, '_MIGRATION_CHECKLIST.md');
const ASSETS = path.join(ROOT, '_tools', 'required-assets.json');

const readText = (p) => fs.readFileSync(p, 'utf8');

module.exports = async function run() {
  suite('migration-checklist · 交接清单单源（两条打包入口打同一份）');

  /* 【票 #47】`_tools/` 与 `_MIGRATION_CHECKLIST.md` 在**工作区私有仓**里，不在公开扩展仓。
   * 单仓检出时这里是**明红**（原因 + 修法），不再 skip —— 绿+跳过会被读成"已经通过了"。 */
  const WS_HINT = '先在工作区根（F:\\harness\\高亮词插件）检出整个工作区；清单本身由 '
    + '`node _tools/migration-make.js --write-checklist` 生成。';
  if (!H.needWorkspaceFile('★ 交接清单单源（工具）', NODE_TOOL, WS_HINT)) return;
  if (!H.needWorkspaceFile('★ 交接清单单源（清单）', CHECKLIST, WS_HINT)) return;

  const md = readText(CHECKLIST);

  test('§1 版本锚点必须与 manifest.json / release/latest.json 一致（这就是 PS1 侧那道漂移闸的判据）', () => {
    const mf = JSON.parse(readText(path.join(ROOT, 'work', 'keyword-highlighter', 'manifest.json'))).version;
    const lj = JSON.parse(readText(path.join(ROOT, 'work', 'keyword-highlighter', 'release', 'latest.json'))).version;
    truthy(new RegExp('源码 manifest：\\*\\*' + mf.replace(/\./g, '\\.') + '\\*\\*').test(md), '清单 §1 应写着 manifest ' + mf + '（现渲染/现盘不一致就是漂移）');
    truthy(md.indexOf('release/latest.json：' + lj) >= 0, '清单 §1 应写着 latest.json ' + lj);
  });

  test('清单必须自称生成物、并写明不要手改（手改=下一个包内容与渲染结果分叉）', () => {
    truthy(/本包自动生成/.test(md), '标题里应写明「本包自动生成」');
    truthy(/不要手改本文件/.test(md), '头部应写明「不要手改本文件」');
    truthy(/--write-checklist/.test(md), '头部应给出落盘入口 --write-checklist');
  });

  test('Node 入口：不许再在打包期现渲染清单（否则与 PS1 又分叉），且必须有单源落盘/预览入口', () => {
    const src = readText(NODE_TOOL);
    falsy(/Buffer\.from\(renderChecklist\(\)/.test(src), '打包期现渲染清单的代码必须不存在（那正是两入口分叉的根因）');
    truthy(/function checklistDrift\(\)/.test(src), '必须有漂移闸 checklistDrift()');
    truthy(/--write-checklist/.test(src) && /--render-checklist/.test(src), '必须提供 --write-checklist / --render-checklist 两个入口');
    truthy(/CL_FILE/.test(src) && /_MIGRATION_CHECKLIST\.md/.test(src), '库内清单路径必须显式可见（CL_FILE）');
  });

  test('Node 入口：清单按普通入选文件记账（不再为「后注入」单开 expected 口径）', () => {
    const src = readText(NODE_TOOL);
    truthy(/const expected = sel\.selected\.length;/.test(src), 'expected 就该是入选文件数');
    falsy(/sel\.selected\.includes\('_MIGRATION_CHECKLIST\.md'\)/.test(src), '不该再有「后注入清单」的加减法');
  });

  test('PS1 入口：必须有锚点漂移闸，且文件保持 UTF-8 带 BOM（BOM 掉了 PS 5.1 就是乱码）', () => {
    const raw = fs.readFileSync(PS1_TOOL);
    truthy(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, 'make-migration-zip.ps1 必须以 UTF-8 BOM 开头（实测被编辑工具吃掉过一次）');
    const src = raw.toString('utf8');
    truthy(/交接清单漂移/.test(src), 'PS1 侧要有漂移闸（硬失败，不是告警）');
    truthy(/--write-checklist/.test(src), 'PS1 侧失败提示要指向 --write-checklist');
    truthy(/源码 manifest：/.test(src), 'PS1 侧闸门比对的正是 §1 锚点');
  });

  test('打包清单本身仍走 required-assets.json 单源：清单在白名单里、但不在必备资产里', () => {
    const a = JSON.parse(readText(ASSETS));
    truthy(a.allowedTopLevel.indexOf('_MIGRATION_CHECKLIST.md') >= 0, '清单必须在 allowedTopLevel（否则顶层白名单断言会拦下它）');
    falsy(a.required.indexOf('_MIGRATION_CHECKLIST.md') >= 0, '清单不在 required（它是生成物，缺了由漂移闸管）');
    eq(a.required.length, 25, '必备资产仍是 25 项');
  });
};
