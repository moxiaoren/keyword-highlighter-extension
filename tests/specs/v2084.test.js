/* tests/specs/v2084.test.js — 2.0.8.4 的四组需求（用户 2026-11-03）
 * ----------------------------------------------------------------------------
 * ① 重要笔记 · 贴边模式在页面内容变化后没有自动重建
 * ② 重要笔记 · 贴边模式钉住之后悬窗上下跳动（没有滚动页面）
 * ③ 重要笔记 · 非贴边模式支持单独收起部分卡片
 * ④ 重要笔记 · 新增 AI 对话助手（兼容悬浮 + 贴边，API 在设置页配置）
 * ⑤ 高亮词管理 · 推荐词模式（配置在线表格，格式与导出的 Excel 一致）
 *
 * 这里钉的是**判据本身**，不是"看起来对了"：
 *   · ①的病根在调度层：相关性判 'skip' 时连 Consume 都不跑 ⇒ 面板一直是旧值。
 *     所以断言"面板开着才有兜底、兜底走的是仅消费、面板自己能回答开没开"。
 *   · ②的病根是两处：贴边形态没有 `panelEl` ⇒ 脏判据恒真（每轮整块重建），
 *     而摘要列又是垂直居中 ⇒ 高度一变整列上下挪。两条都各有一个反向断言
 *     （旧写法必须消失 / 摘要列不许再 translateY）。
 *   · ③/④/⑤ 是新功能：断言"入口在、状态按 note 记、文案来自 VIEW、请求只走后台、
 *     导入复用批量导入那条实现"—— 防的是以后有人另写一套平行实现。
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

  /* ==================== ①②③ 重要笔记 ==================== */
  suite('v2.0.8.4 · 重要笔记：贴边重建 / 不跳动 / 单卡收起');





  await test('★ 浮窗单卡收起（需求③）：按钮在卡头、状态按 note 记、正文整块藏起来', () => {
    const src = read('src/features/important-note.js');
    truthy(/this\.addFoldBtn\(headEl, item\);/.test(src), '新建卡要挂收起按钮');
    truthy(/this\.applyCardCollapsed\(el, item\);/.test(src), '复用与新建都要落收起态（复用旧卡也得跟上）');
    truthy(/\.khin-item\.khin-folded \.khin-item-note \{ display: none; \}/.test(src), '收起 = 正文不占位');
    truthy(/this\.collapsedNotes\.has\(/.test(src), '状态按 note 文本挂面板侧（不是挂在会被重建的 head 上）');
    truthy(typeof KH.OcrCopy.VIEW.cardCollapse === 'string' && typeof KH.OcrCopy.VIEW.cardExpand === 'string',
      '两句悬停说明必须在文案真源 VIEW 里');
    falsy(/收起这张卡片/.test(src), '面板不许自己写这句中文（文案单源）');
  });

  /* ==================== ④ AI 对话助手 ==================== */
  suite('v2.0.8.4 · AI 对话助手（贴边 + 浮窗共用，默认 DeepSeek）');

  await test('★ 配置归一：默认 DeepSeek 官方；空地址回预设；自定义可留空；maxTokens 夹紧', () => {
    const d = C.normalizeAi({});
    eq(d.provider, 'deepseek');
    eq(d.baseUrl, 'https://api.deepseek.com/v1');
    eq(d.model, 'deepseek-chat');
    eq(C.normalizeAi({ baseUrl: 'https://x.test/v1///' }).baseUrl, 'https://x.test/v1', '尾部斜杠要去掉');
    eq(C.normalizeAi({ provider: 'custom', baseUrl: '', model: '' }).baseUrl, '', '自定义允许留空（本地服务 / 中转）');
    eq(C.normalizeAi({ maxTokens: 99999 }).maxTokens, C.AI_MAX_MAX, '越界夹到上界');
    eq(C.normalizeAi({ maxTokens: 'abc' }).maxTokens, C.AI_MAX_DEFAULT, '坏值回默认，绝不让面板发出必然失败的请求');
    eq(C.defaults.ai.provider, 'deepseek', '默认值集合里也必须是 DeepSeek（用户口径：默认接 DeepSeek 官方）');
  });



  await test('★ 后台是唯一请求出口：OpenAI 兼容 /chat/completions + Bearer + 挂 self', () => {
    const src = read('background/ai.js');
    truthy(/\/chat\/completions/.test(src), '要拼 OpenAI 兼容端点');
    truthy(/Authorization = 'Bearer ' \+ ai\.apiKey/.test(src), '有 Key 才带 Bearer');
    truthy(/self\.KhAi = AI;/.test(src), '后台模块必须挂到 self（service worker 可用）');
    falsy(/console\.(log|warn|error)[^\n]*apiKey/.test(src), '不许把 Key 打进日志');
    const sw = read('background/service-worker.js');
    truthy(/importScripts\([^)]*'ai\.js'\)/.test(sw), 'service worker 要加载 ai.js');
    truthy(/\[MSG\.AI_CHAT\]: \(msg\) => self\.KhAi\.chat/.test(sw), '消息要路由到 KhAi.chat');
    eq(KH.MSG.AI_CHAT, 'kh:ai:chat', '协议常量单源（业务代码不许硬编码消息名）');
  });


  /* ==================== ⑤ 推荐词 ==================== */
  suite('v2.0.8.4 · 推荐词（在线表格）');



};
