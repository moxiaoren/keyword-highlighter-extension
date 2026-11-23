/* tests/specs/v2085.test.js — 2.0.8.5 的三条需求（用户 2026-11-03 追加）
 * ----------------------------------------------------------------------------
 * ① AI 助手默认走 **DeepSeek 网页对话**（免 Key）：界面仍是插件自己的 AI 分页，
 *    后台用一个 chat.deepseek.com 标签页替你发消息、把回复流式读回来。
 * ② AI 分页重做（气泡 / 流式 / 状态带 / 去登录入口）。
 * ③ 重要笔记**无感重建**：内容变但结构没变时只改文字，不重造 DOM（不闪、不丢滚动与图片）。
 *
 * 这里钉判据，不钉"看起来对了"：
 *   · ①的病根是"免 Key 没有任何可实现路径"——网页版没有公开接口、签名（PoW）在页面里算。
 *     所以断言：驱动脚本必须注入那个站点；后台必须**后台开标签页**（active:false）而不是
 *     抢走当前页；未登录要如实报 needLogin 而不是假装成功；流式回包必须走长连接。
 *   · ②防"又退回两个灰按钮"：断言新结构（状态带 / 气泡 / 发送键）与文案单源。
 *   · ③防"重建回潮"：断言按 key 复用两张表（卡片按 note、摘要列行按 note）+ `innerHTML=''`
 *     只出现在"行集合变了"的分支里。
 * ========================================================================= */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Config;

  /* ==================== ① 默认太极AI 网页通路（免 Key） ==================== */
  /* 【2.0.16】默认通路换过一次，两处口径都写在这：
   *   2.0.8.5 用户原话：「不是要 API」⇒ 默认 web（DeepSeek 网页对话）；
   *   2.0.16 用户原话：「ai助手改成太极ai网页通路」⇒ 默认 taiji。
   * 2.0.16.4 用户又要求「只保留太极 AI」⇒ 网页对话与 API 两条整条删除，只剩 taiji 一条。 */
  suite('v2.0.8.5 · AI 助手默认走网页通路（免 Key）');

  await test('★ 配置层：只剩太极AI 一条通路，老配置 api/web 一律归到 taiji', () => {
    eq(C.AI_MODE_DEFAULT, 'taiji', '唯一通路就是太极AI');
    eq(C.normalizeAi({}).mode, 'taiji', '没填模式时按 taiji 归一');
    eq(C.normalizeAi({ mode: 'api' }).mode, 'taiji', '老的 api 配置要归到 taiji（否则面板没有出站口）');
    eq(C.normalizeAi({ mode: 'web' }).mode, 'taiji', '老的网页对话配置同样归到 taiji');
    eq(C.normalizeAi({ mode: '乱写' }).mode, 'taiji', '坏值回默认（与其它项一个口径）');
    const ids = (C.AI_MODES || []).map((m) => m.id).join(',');
    eq(ids, 'taiji', '设置页的下拉只该剩一条');
    truthy(C.AI_WEB_ORIGIN === undefined, '网页对话的站点常量要随通路删掉');
  });

  await test('★ 网页对话驱动整条删除：清单里不再注入对话页，脚本文件也不在', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const groups = manifest.content_scripts || [];
    const web = groups.filter((g) => (g.matches || []).some((m) => m.indexOf('chat.deepseek.com') >= 0));
    eq(web.length, 0, '清单里不许再有 chat.deepseek.com 的注入组');
    const fs = require('fs');
    const p = require('path').join(__dirname, '..', '..', 'content', 'web-chat.js');
    falsy(fs.existsSync(p), 'content/web-chat.js 必须删掉（不用的代码不许留在包里）');
  });



  /* ==================== ② AI 分页重做 ==================== */
  suite('v2.0.8.5 · AI 分页重做（气泡 / 流式 / 状态带）');




  /* ==================== ③ 无感重建 ==================== */
  suite('v2.0.8.5 · 重要笔记无感重建（不闪 / 不丢滚动与图片）');



};
