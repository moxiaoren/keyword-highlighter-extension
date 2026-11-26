/* tests/specs/webai.test.js —— 「自定义网页 AI」通路（2.0.19 · 用户 m28030）
 * ----------------------------------------------------------------------------
 * 用户口径：公司内网有 AI 网页，但网址不方便提供 ⇒ 通道里不写任何站点，
 * 网址与三个页面元素全部由用户在本机设置页填；扩展开不抢前台的标签页驱动它。
 * 这里锁三件事：配置归一的边界、后台驱动脚本的注入契约、设置页的接线。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Config;

  suite('自定义网页 AI（2.0.19 · m28030）');

  await test('★ 配置归一：只认 http(s) 网址、选择器截断、idleMs 夹在 400–10000', () => {
    const a = C.normalizeAiCustom({ url: 'https://ai.example.com/chat', input: '#q', send: 'button.go', answer: '.md', idleMs: 99999 });
    eq(a.url, 'https://ai.example.com/chat');
    eq(a.input, '#q');
    eq(a.send, 'button.go');
    eq(a.answer, '.md');
    eq(a.idleMs, 10000, 'idleMs 上限 10 秒');
    eq(C.normalizeAiCustom({ idleMs: 1 }).idleMs, 400, 'idleMs 下限 0.4 秒');
    eq(C.normalizeAiCustom({ idleMs: 'x' }).idleMs, 1200, '写错回默认 1200');
    eq(C.normalizeAiCustom({ url: 'javascript:alert(1)' }).url, '', '非 http(s) 一律丢弃');
    eq(C.normalizeAiCustom({ url: 'file:///etc/passwd' }).url, '', 'file: 也不行');
    eq(C.normalizeAiCustom({}).keepTab, true, '默认钉住通道页');
    eq(C.normalizeAiCustom({ keepTab: false }).keepTab, false);
  });

  await test('★ 通路口径：默认走太极AI，显式选 custom 才切；老配置不会误切', () => {
    eq(C.normalizeAi({}).channel, 'taiji', '默认不改变现状');
    eq(C.normalizeAi({ channel: 'custom' }).channel, 'custom');
    eq(C.normalizeAi({ channel: 'api' }).channel, 'taiji', '未知值一律回太极AI');
    truthy(C.normalizeAi({ custom: { url: 'https://x.y/z' } }).custom.url === 'https://x.y/z', 'custom 随 ai 一起归一');
  });

  await test('★ 后台驱动：写输入框走原生 setter + input 事件，发送可点按钮也可回车', () => {
    const src = read('background/webai.js');
    truthy(src.indexOf("Object.getOwnPropertyDescriptor(proto, 'value').set") >= 0, 'React 受控输入必须用原生 setter');
    truthy(src.indexOf("new Event('input', { bubbles: true })") >= 0, '改完 value 要派发 input 事件');
    truthy(src.indexOf('btn.click()') >= 0, '配了按钮就点按钮');
    truthy(src.indexOf("key: 'Enter'") >= 0, '没配按钮就按 Enter');
    truthy(src.indexOf('active: false') >= 0, '通道页不抢前台');
    truthy(src.indexOf('samePage(') >= 0, '同一页复用标签页，不每问一次开新页');
    truthy(src.indexOf('ANSWER_TIMEOUT') >= 0, '必须有绝对超时，不能无限等');
    truthy(src.indexOf('self.KhWebAi = W') >= 0, '要挂到 self 供后台与设置页调用');
  });

  await test('★ 接线：后台按 ai.channel 分流、探针与点选各有一条消息，设置页有入口', () => {
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("'webai.js'") >= 0, 'service worker 要加载 webai.js');
    truthy(sw.indexOf("if (ai.channel === 'custom')") >= 0, 'ask 要按 channel 分流');
    truthy(sw.indexOf('self.KhWebAi.promptOf(') >= 0, '网页通道只发最后一问（上下文由页面自己保留）');
    truthy(sw.indexOf('self.KhWebAi.probe(') >= 0, '设置页「测试」走 probe');
    truthy(sw.indexOf('self.KhWebAi.pick(') >= 0, '点选元素走 pick');
    truthy(sw.indexOf('self.KhWebAi.picked(msg)') >= 0, '页面点完要能回执');
    const px = read('src/core/protocol.js');
    truthy(px.indexOf("WEB_AI_PROBE: 'kh:ai:webProbe'") >= 0);
    truthy(px.indexOf("WEB_AI_PICK: 'kh:ai:webPick'") >= 0);
    truthy(px.indexOf("WEB_AI_PICKED: 'kh:ai:webPicked'") >= 0);
    const html = read('options/options.html');
    ['ai-channel', 'ai-web-url', 'ai-web-input', 'ai-web-send', 'ai-web-answer', 'ai-web-idle', 'ai-web-keep', 'ai-web-test', 'ai-web-pick-input', 'ai-web-pick-send', 'ai-web-pick-answer']
      .forEach((id) => truthy(html.indexOf('id="' + id + '"') >= 0, '设置页缺 #' + id));
    const js = read('options/options.js');
    truthy(js.indexOf('KH.Config.normalizeAiCustom') >= 0, '回显与保存走同一份归一');
    truthy(js.indexOf("saveNested({ ai: { channel: want } })") >= 0, '通道选择要落盘');
    truthy(js.indexOf("KH.MSG.WEB_AI_PICK, tabId: tab.id") >= 0, '点选要把当前标签页交给后台');
    truthy(js.indexOf('renderAiCustomForm()') >= 0, '设置页打开时要回显');
  });

  await test('★ 隐私口径：这条通路不外发、不经过太极AI，图片不转发', () => {
    const src = read('background/webai.js');
    falsy(/fetch\(/.test(src), 'webai.js 不许自己发网络请求（数据只在本机与本页之间）');
    truthy(src.indexOf('KhTaiji') < 0, '不许绕回太极AI');
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf('自定义网页通道不转发图片') >= 0, '带图时要明确告诉用户没转发');
  });

  /* 【2.0.19 · 体检】设置页写「钉住（不自动回收）」、PRIVACY 写「用完关掉」：不钉住就必须真关，
   * 而且只关我们新开的那张（复用它原有标签页时关掉 = 把用户的页面弄丢）。 */
  await test('★ 2.0.19 取消钉住时用完关页：只关自己开的，复用的不动（体检）', () => {
    const src = read('background/webai.js');
    truthy(src.indexOf('chrome.tabs.remove(') >= 0, '★ 不钉住时要有真正的关闭动作');
    truthy(src.indexOf('return { id: t.id, created: false };') >= 0, '★ 复用已有标签页要标 created=false');
    truthy(src.indexOf('return { id: tab.id, created: true };') >= 0, '★ 自己新开的标 created=true');
    truthy(src.indexOf('if (c.keepTab === false && state.created) closeTab(state.id);') >= 0,
      '★ 只有 keepTab=false 且自己开的才关');
  });
};