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
   * 网页对话没被删，降为第二档；API 仍是最后一档。 */
  suite('v2.0.8.5 · AI 助手默认走网页通路（免 Key）');

  await test('★ 配置层：模式默认 taiji，三条通路都有名字（设置页拿同一份清单）', () => {
    eq(C.AI_MODE_DEFAULT, 'taiji', '默认必须是太极AI 网页通路（用户原话：ai助手改成太极ai网页通路）');
    eq(C.normalizeAi({}).mode, 'taiji', '没填模式时按 taiji 归一，不能退化成 api');
    eq(C.normalizeAi({ mode: 'api' }).mode, 'api', '显式选了 api 就保留');
    eq(C.normalizeAi({ mode: 'web' }).mode, 'web', '显式选网页对话也保留（老用户配置不许被改写）');
    eq(C.normalizeAi({ mode: '乱写' }).mode, 'taiji', '坏值回默认（与其它数值项一个口径）');
    const ids = (C.AI_MODES || []).map((m) => m.id).join(',');
    eq(ids, 'taiji,web,api', '三条通路各一条，顺序固定（taiji 在前 = 默认）');
    truthy(/chat\.deepseek\.com/.test(C.AI_WEB_ORIGIN || ''), '网页对话的站点只认这一处真源');
  });

  await test('★ 驱动脚本注入 chat.deepseek.com，且只注入那一组（不污染别站的性能预算）', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const groups = manifest.content_scripts || [];
    const web = groups.filter((g) => (g.matches || []).some((m) => m.indexOf('chat.deepseek.com') >= 0));
    eq(web.length, 1, '必须恰好一组专门服务对话页');
    truthy((web[0].js || []).indexOf('content/web-chat.js') >= 0, '驱动脚本要在这一组里');
    eq(web[0].all_frames, false, '只注入主框架（对话在顶层）');
    const src = read('content/web-chat.js');
    truthy(/textarea#chat-input/.test(src), '输入框首选官方 id');
    truthy(/contenteditable="true"/.test(src), '改版后要能退到可编辑框');
    truthy(/execCommand\('insertText'/.test(src), '受控组件必须走原生 insertText + input 事件（直接赋 value 会被 React 忽略）');
    truthy(/KeyboardEvent\('keydown'/.test(src), '回车发送要发真实键盘事件');
    truthy(/\.ds-markdown/.test(src), '回复块按网页版的渲染类名取');
    truthy(/SETTLE_MS/.test(src), '文本稳定一段时间才算说完（否则会把半句话当答案）');
    truthy(/probe\(\)/.test(src), '要给设置页一个自检入口（改版时靠它诊断）');
  });



  /* ==================== ② AI 分页重做 ==================== */
  suite('v2.0.8.5 · AI 分页重做（气泡 / 流式 / 状态带）');




  /* ==================== ③ 无感重建 ==================== */
  suite('v2.0.8.5 · 重要笔记无感重建（不闪 / 不丢滚动与图片）');



};
