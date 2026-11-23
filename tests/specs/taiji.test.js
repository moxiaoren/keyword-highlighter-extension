/* tests/specs/taiji.test.js — 【2.0.16】AI 助手改用「太极AI 网页通路」
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-23 原话）：
 *   ·「ai助手改成太极ai网页通路。支持设置页登录，可以自选模型，不需要开新标签页。
 *     这个也能辅助法人检索。参考之前做的那个纯聊天通路。」
 * 这里锁三块：
 *   ① 站点协议（地址发现 / 登录 / 模型清单 / 建会话 / SSE 增量 / 去 think）—— 纯函数 + 假 fetch；
 *   ② 法人兜底（entity.fromAi 只信格式合法的名字，source 标 ai）；
 *   ③ 接线（配置默认 taiji、密码不落盘、设置页控件与消息常量都在）。
 * 真机走站点由人工验收覆盖（单测绝不联网）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy } = H;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 假响应：JSON。 */
function jsonRes(obj, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(obj)
  };
}

/** 假响应：纯文本。 */
function textRes(txt) {
  return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => txt };
}

/** 假响应：SSE（按块给 reader，模拟站点的分块到达）。 */
function sseRes(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader: () => ({
        read: () => {
          if (i >= chunks.length) return Promise.resolve({ done: true });
          const v = enc.encode(chunks[i]);
          i += 1;
          return Promise.resolve({ done: false, value: v });
        }
      })
    }
  };
}

const TM_OK = { code: 0, data: { models: [{ model: 'openai::gpt-6.1-sol', name: 'GPT-6.1' }, 'google::gemini-3.1-pro-preview'] } };

/* 【易错】vm 沙盒里跑出来的对象是**另一个 realm** 的实例：assert.deepStrictEqual 会因原型不同判不等。
 * 所以跨沙盒的结果一律逐字段比对，别用 deepEq。 */
let KH_CONFIG = null;

/** 在独立沙盒里加载 background/taiji.js（后台脚本不是 content_scripts）。 */
function loadTaiji(opts) {
  const o = opts || {};
  const mem = Object.assign({ ai: { enabled: true, mode: 'taiji', taiji: { account: 'u1', model: '' } } }, o.mem || {});
  const calls = [];
  const fetchStub = async (url, init) => {
    const u = String(url);
    calls.push({
      url: u,
      method: (init && init.method) || 'GET',
      credentials: init && init.credentials,
      body: init && init.body ? JSON.parse(init.body) : null
    });
    if (u === 'http://api.taijiai666.com/app-url.txt') return textRes(o.appUrl == null ? 'https://ai.zhuangxiuyunying.xyz\n' : o.appUrl);
    /* 【2.0.16.1】品牌域名 301 → 真实宿主：假 fetch 只回得到跳转后的 `url`（真浏览器由 redirect:follow 完成）。 */
    if (/^https:\/\/www\.taijiai666\.com\/?$/.test(u)) {
      return { ok: true, status: 200, url: 'https://ai.zhuangxiuyunying.xyz/', headers: { get: () => 'text/html' }, text: async () => '' };
    }
    if (u.indexOf('/api/user/login') >= 0) return jsonRes(o.login === undefined ? { code: 0, data: {} } : o.login);
    if (u.indexOf('/api/chat/tmpl') >= 0) return jsonRes(o.tmpl === undefined ? TM_OK : o.tmpl);
    if (u.indexOf('/api/chat/session') >= 0) return jsonRes(o.session === undefined ? { code: 0, data: { id: 'sess-1' } } : o.session);
    if (u.indexOf('/api/chat/completions') >= 0) {
      return o.chat || sseRes([
        'data: {"type":"string","data":"\u003cthink\u003e我先想一想"}\n\n',
        'data: {"type":"string","data":"\u003c/think\u003e你好呀"}\n\n',
        'data: {"type":"object","data":{"aiText":"","promptTokens":3,"completionTokens":5,"useTokens":8}}\n\n'
      ]);
    }
    return jsonRes({ code: 404, msg: 'not found' }, 404);
  };
  const chrome = {
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : Object.assign({}, mem)),
        set: async (x) => { Object.assign(mem, x); }
      }
    }
  };
  const sandbox = {
    console: console,
    chrome: chrome,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    TextDecoder: TextDecoder,
    URL: URL,
    fetch: fetchStub
  };
  sandbox.self = sandbox;
  sandbox.KH = { Config: KH_CONFIG };
  vm.createContext(sandbox);
  vm.runInContext(read('background/taiji.js'), sandbox, { filename: 'background/taiji.js' });
  return { T: sandbox.KhTaiji, calls: calls, mem: mem, sandbox: sandbox };
}

/** 在独立沙盒里加载 background/entity.js，并塞一个假的太极AI。 */
function loadEntity(taiji) {
  const mem = {};
  const sandbox = {
    console: console,
    chrome: {
      storage: {
        local: {
          get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : Object.assign({}, mem)),
          set: async (o) => { Object.assign(mem, o); }
        }
      }
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    fetch: async () => { throw new Error('单测不联网'); }
  };
  sandbox.self = sandbox;
  sandbox.KH = {};
  sandbox.KhTaiji = taiji || null;
  vm.createContext(sandbox);
  vm.runInContext(read('background/entity.js'), sandbox, { filename: 'background/entity.js' });
  return { E: sandbox.KH.Entity, mem: mem };
}

async function thrownMessage(fn) {
  try { await fn(); } catch (e) { return String((e && e.message) || e); }
  return '';
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Config;
  KH_CONFIG = C;

  /* ==================== ① 站点协议 ==================== */
  suite('2.0.16 · 太极AI 网页通路：站点协议（假 fetch，不联网）');

  await test('★ 去 think：成对删掉；只给结束符时前面整段都算推理（站点两种都给）', () => {
    const { T } = loadTaiji();
    eq(T.stripThink('<think>想</think>答案'), '答案', '成对标记之间的推理不能进面板');
    eq(T.stripThink('推理一大段</think>答案'), '答案', '只给结束符时，结束符之前的内容一律丢弃');
    eq(T.stripThink('前言<｜end▁of▁thinking｜>答案'), '答案', '特殊竖线版的结束符也要认');
    eq(T.stripThink('没有标记的正常回答'), '没有标记的正常回答', '没有标记就原样返回');
    eq(T.stripThink('<think>只有推理</think>'), '', '全是推理就回空串（面板会判「没返回内容」）');
  });

  await test('★ 站点地址白名单：https + 指定域名（或其子域），别的都拒', () => {
    const { T } = loadTaiji();
    truthy(T.allowedBase('https://ai.zhuangxiuyunying.xyz'), '主域要放行');
    truthy(T.allowedBase('https://x.ai.zhuangxiuyunying.xyz'), '子域也放行（站点换子域不用改代码）');
    falsy(T.allowedBase('http://ai.zhuangxiuyunying.xyz'), '明文 http 不放行');
    falsy(T.allowedBase('https://evil.example.com'), '别的域名不放行');
    falsy(T.allowedBase('https://ai.zhuangxiuyunying.xyz.evil.com'), '后缀冒充不放行');
    falsy(T.allowedBase(''), '空串不放行');
  });

  await test('模型清单归一：字符串与 {model,id,name} 都认，空 id 丢掉', () => {
    const { T } = loadTaiji();
    const flat = (list) => T.normModels(list).map((m) => m.id + '=' + m.name).join('|');
    eq(flat(['a', { model: 'b', name: 'B 名' }, { id: 'c' }, { name: '' }, {}]),
      'a=a|b=B 名|c=c', '归一成 {id,name}，空 id 丢掉');
    eq(T.normModels(null).length, 0, '不是数组就回空');
  });

  await test('对话压平：system 提到最前、assistant 加「（上文回答）」前缀、空内容跳过', () => {
    const { T } = loadTaiji();
    eq(T.flatten([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '   ' }
    ]), '你是助手\n\n第一问\n\n（上文回答）第一答', '顺序与前缀都要对（站点只收一整段 text）');
    eq(T.flatten(null), '', '不是数组就回空串');
  });

  await test('★ 登录：账号密码只发一次，带 credentials，成功后直接回模型清单', async () => {
    const { T, calls, mem } = loadTaiji();
    const res = await T.login({ account: 'u1', password: 'pwd-secret' });
    truthy(res.ok, '登录应当成功');
    eq(res.models.length, 2, '登录成功后顺手把模型清单带回来（少一次往返）');
    const loginCall = calls.filter((c) => c.url.indexOf('/api/user/login') >= 0)[0];
    truthy(loginCall, '必须真的发了登录请求');
    eq(loginCall.method, 'POST', '登录是 POST');
    deepEq(loginCall.body, { account: 'u1', password: 'pwd-secret' }, '账号密码按站点协议放在 body');
    eq(loginCall.credentials, 'include', '要带 cookie（会话靠浏览器记住）');
    falsy(JSON.stringify(mem).indexOf('pwd-secret') >= 0, '密码绝不写进 storage');
  });

  await test('登录失败分得清：缺账号 / 缺密码 / 站点回非 0', async () => {
    const a = loadTaiji();
    eq((await a.T.login({ password: 'x' })).error, '请填账号', '缺账号直接说，不发请求');
    eq((await a.T.login({ account: 'u' })).error, '请填密码', '缺密码直接说');
    eq(a.calls.length, 0, '这两种情况一个请求都不该发');
    const b = loadTaiji({ login: { code: 3, msg: '账号或密码不对' } });
    const r = await b.T.login({ account: 'u', password: 'p' });
    falsy(r.ok, '站点拒绝就不能当成功');
    truthy(r.error.indexOf('账号或密码不对') >= 0, '把站点的原话带出来：' + r.error);
  });

  await test('★ 模型清单：站点回 401 ⇒ needLogin，设置页据此提示「还没登录」', async () => {
    const { T } = loadTaiji({ tmpl: { code: 401, msg: '未登录' } });
    const r = await T.models();
    falsy(r.ok, '401 不能当成功');
    truthy(r.needLogin, '要标出「没登录」这一态，否则设置页只能说「失败」');
    const ok = await loadTaiji().T.models();
    truthy(ok.ok, '正常会话要能拿到清单');
    eq(ok.models[0].id, 'openai::gpt-6.1-sol', '清单原样交出去（站点 id 就是模型名）');
  });

  await test('★ 对话：SSE 增量拼起来、去 think、用量映射成 OpenAI 字段', async () => {
    const { T, calls } = loadTaiji();
    const r = await T.chat({ messages: [{ role: 'user', content: '你好' }] });
    truthy(calls.length >= 4, '登录态下要依次打 app-url / tmpl / session / completions');
    truthy(r.ok, '应成功：' + (r.error || ''));
    eq(r.text, '你好呀', '增量拼接后必须去掉推理段');
    /* 逐字段比（跨 realm 的对象 deepStrictEqual 会因原型不同失败）。 */
    eq(r.usage && r.usage.prompt_tokens, 3, '用量：提示');
    eq(r.usage && r.usage.completion_tokens, 5, '用量：回复');
    eq(r.usage && r.usage.total_tokens, 8, '用量：合计（面板按 OpenAI 字段名读）');
    const sess = calls.filter((c) => c.url.indexOf('/api/chat/session') >= 0)[0];
    deepEq(sess.body, { model: 'openai::gpt-6.1-sol' }, '没选模型时用清单第一个建会话');
    const chat = calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0)[0];
    deepEq(chat.body, { text: '你好', sessionId: 'sess-1', model: 'openai::gpt-6.1-sol' }, '站点只收 text + sessionId + model');
  });

  await test('对话：显式选的模型优先；非流式回包也能读（data.aiText）', async () => {
    const { T, calls } = loadTaiji({
      chat: jsonRes({ code: 0, data: { aiText: '想一想</think>非流式答案' } })
    });
    const r = await T.chat({ messages: [{ role: 'user', content: '问' }], override: { model: 'anthropic::claude-sonnet-5' } });
    truthy(r.ok, '非 event-stream 也要能读');
    eq(r.text, '非流式答案', '非流式同样要去 think');
    const sess = calls.filter((c) => c.url.indexOf('/api/chat/session') >= 0)[0];
    eq(sess.body.model, 'anthropic::claude-sonnet-5', '设置页选的模型要生效');
  });

  await test('对话框门：AI 关闭 / 没内容 / 站点空回 / 会话失效都给出人话', async () => {
    const off = await loadTaiji({ mem: { ai: { enabled: false, mode: 'taiji' } } }).T.chat({ messages: [{ role: 'user', content: 'x' }] });
    falsy(off.ok, '关掉了就不能偷偷发');
    truthy(off.error.indexOf('关闭') >= 0, '要说清是设置里关的：' + off.error);
    const empty = await loadTaiji().T.chat({ messages: [] });
    eq(empty.error, '没有要发送的内容', '空对话不该去建会话');
    const blank = await loadTaiji({ chat: sseRes(['data: {"type":"object","data":{"aiText":""}}\n\n']) }).T.chat({ messages: [{ role: 'user', content: 'x' }] });
    eq(blank.error, '站点没有返回内容', '站点空回要说「没有返回内容」');
    const bad = await loadTaiji({ chat: sseRes(['data: {"code":401,"msg":"未登录"}\n\n']) }).T.chat({ messages: [{ role: 'user', content: 'x' }] });
    falsy(bad.ok, '流里带错误码要当失败');
    truthy(bad.error.indexOf('重新登录') >= 0, '会话失效要指向设置页重新登录：' + bad.error);
  });

  await test('法人兜底 repOf：只输出名字或「不确定」，格式不对就是没查到', async () => {
    const good = await loadTaiji({ chat: sseRes(['data: {"type":"string","data":"梁娟。"}\n\n']) }).T.repOf('南京石诚星桥科技有限公司');
    truthy(good.ok, '正常回复要能抠出人名');
    eq(good.rep, '梁娟', '只留名字本身（去掉句号之类）');
    const unsure = await loadTaiji({ chat: sseRes(['data: {"type":"string","data":"不确定"}\n\n']) }).T.repOf('某公司');
    falsy(unsure.ok, '「不确定」不能当成人名');
    const pack = await loadTaiji({ chat: sseRes(['data: {"type":"string","data":"答案是：梁娟。"}\n\n']) }).T.repOf('某公司');
    eq(pack.rep, '梁娟', '被「答案是：」包装也能抠出来');
    eq((await loadTaiji().T.repOf('')).error, '公司名为空', '空公司名不去打扰站点');
  });

  /* ==================== ② 法人兜底 ==================== */
  suite('2.0.16 · 法人兜底：太极AI 的结果要过格式关，且标明来源');

  await test('★ fromAi：合法人名放行、source=ai；不像人名 / 通道没加载 / 站点报错都当没查到', async () => {
    const ok = loadEntity({ repOf: async () => ({ ok: true, rep: '梁娟' }) });
    const got = await ok.E.fromAi('南京石诚星桥科技有限公司');
    eq(got && got.rep, '梁娟', '合法的名字要放行');
    eq(got && got.source, 'ai', '来源必须标 ai（面板要能看出这是推断值）');
    const tooLong = loadEntity({ repOf: async () => ({ ok: true, rep: '南京石诚星桥科技' }) });
    truthy((await thrownMessage(() => tooLong.E.fromAi('南京石诚星桥科技有限公司'))).indexOf('不是人名') >= 0, '6 个字 / 带机构词的不算人名');
    const noChan = loadEntity(null);
    truthy((await thrownMessage(() => noChan.E.fromAi('某公司'))).indexOf('没加载') >= 0, '通道缺失要报清楚');
    const err = loadEntity({ repOf: async () => ({ ok: false, error: 'AI 没给出确定的人名' }) });
    truthy((await thrownMessage(() => err.E.fromAi('某公司'))).indexOf('没给出') >= 0, 'AI 失败原因原样传出');
    const blank = loadEntity({ repOf: async () => ({ ok: true, rep: '  ' }) });
    truthy((await thrownMessage(() => blank.E.fromAi('某公司'))).length > 0, '空名字也算没查到');
  });

  await test('★ 通道竞速：AI 不能抢本地通道的结论（本地先回就用本地）', () => {
    const src = read('background/entity.js');
    truthy(src.indexOf('let aiOut = null;') >= 0, 'AI 结果要先存着');
    truthy(src.indexOf('opened >= 4') >= 0, '四家都放出去才收口（少一家就会过早判失败）');
    truthy(src.indexOf("finish(aiOut)") >= 0, '只有本地全空手才退到 AI');
    truthy(src.indexOf("source: 'ai'") >= 0, 'AI 结果带来源标记');
    truthy(src.indexOf('AI_TTL_MS') >= 0 && src.indexOf('6 * 3600 * 1000') >= 0, '模型推断只信 6 小时，不该和站点值一样存一天');
  });

  /* ==================== ③ 接线 ==================== */
  suite('2.0.16 · 接线：默认通路 / 密码不落盘 / 设置页与消息常量');

  await test('★ 配置层：默认 taiji；三条通路（taiji/web/api）都保留；taiji 段没有 password 键', () => {
    eq(C.AI_MODE_DEFAULT, 'taiji', '默认 = 太极AI 网页通路（用户 2026-11-23 口径）');
    eq(C.AI_MODES.map((m) => m.id).join(','), 'taiji,web,api', '三条通路各一条，taiji 在第一位');
    eq(C.normalizeAi({}).mode, 'taiji', '老配置没写 mode ⇒ taiji');
    eq(C.normalizeAi({ mode: 'web' }).mode, 'web', '显式选网页对话要保留（不许改写老用户配置）');
    const t = C.normalizeAiTaiji({ account: 'u1', base: 'https://ai.zhuangxiuyunying.xyz/', model: 'openai::x', password: 'pwd' });
    deepEq(Object.keys(t).sort(), ['account', 'base', 'model'], '只留账号/站点/模型（密码不在这套结构里）');
    eq(t.base, 'https://ai.zhuangxiuyunying.xyz', '站点地址去尾斜杠');
    const ai = C.normalizeAi({ taiji: { account: 'u1', password: 'pwd' } });
    eq(ai.taiji.account, 'u1', '账号要能存下来（下次不用重填）');
    falsy('password' in ai.taiji, '归一后的配置里不许出现 password');
  });

  await test('★ 设置页：账号/密码/登录/模型/刷新/站点 都有控件，且都挂上了处理器', () => {
    const html = read('options/options.html');
    ['ai-taiji-account', 'ai-taiji-password', 'ai-taiji-login', 'ai-taiji-model', 'ai-taiji-refresh', 'ai-taiji-base', 'ai-taiji-test', 'ai-taiji-state']
      .forEach((id) => truthy(html.indexOf('id="' + id + '"') >= 0, '缺少控件 #' + id));
    truthy(html.indexOf('id="ai-taiji-fields"') >= 0, '整个太极AI 字段区要能整体显隐');
    const js = read('options/options.js');
    ['renderTaijiForm', 'fillTaijiModels', 'refreshTaijiModels'].forEach((fn) => truthy(js.indexOf('function ' + fn) >= 0, '缺少 ' + fn));
    truthy(js.indexOf('KH.MSG.AI_TAIJI_LOGIN') >= 0, '登录按钮要发 AI_TAIJI_LOGIN');
    truthy(js.indexOf('KH.MSG.AI_TAIJI_MODELS') >= 0, '刷新按钮要发 AI_TAIJI_MODELS');
    truthy(js.indexOf("taiji: { account: account }") >= 0, '账号要存到 ai.taiji.account');
    falsy(/taiji:\s*\{[^}]*password/.test(js), '保存动作里不许出现 password');
    truthy(js.indexOf("pwd.value = ''") >= 0, '登录后要清空密码框');
  });

  await test('★ 接线：协议常量 / 后台路由 / 导入顺序 / ai.js 分流都在', () => {
    const proto = read('src/core/protocol.js');
    truthy(proto.indexOf("AI_TAIJI_LOGIN: 'kh:ai:taijiLogin'") >= 0, '协议常量 AI_TAIJI_LOGIN');
    truthy(proto.indexOf("AI_TAIJI_MODELS: 'kh:ai:taijiModels'") >= 0, '协议常量 AI_TAIJI_MODELS');
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("'taiji.js'") >= 0, 'service worker 要 importScripts taiji.js');
    truthy(sw.indexOf('[MSG.AI_TAIJI_LOGIN]') >= 0, '要挂登录路由');
    truthy(sw.indexOf('[MSG.AI_TAIJI_MODELS]') >= 0, '要挂模型清单路由');
    const ai = read('background/ai.js');
    truthy(ai.indexOf("ai.mode === 'taiji'") >= 0, 'AI.chat 要按 mode 分流到太极通道');
    truthy(ai.indexOf('self.KhTaiji.chat(payload)') >= 0, '分流后直接交给 KhTaiji（不再走 OpenAI 兼容请求）');
    truthy(ai.indexOf('AI.taijiLogin') >= 0 && ai.indexOf('AI.taijiModels') >= 0, '后台两个门面方法要在');
    const manifest = JSON.parse(read('manifest.json'));
    falsy((manifest.permissions || []).indexOf('cookies') >= 0, '不申请 cookies 权限（会话靠 credentials:include 复用浏览器 jar）');
  });

  /* ==================== ④ 面板三态 + 后台长连接 ==================== */
  suite('2.0.16 · 面板三态：taiji 不开标签页、没登录指去设置页');

  await test('★ 面板认三条通路：taiji 免 Key 可发、状态带写太极AI、needLogin 打开设置页而不是对话页', () => {
    const note = read('src/features/important-note.js');
    truthy(note.indexOf("if (ai.mode === 'api') return 'api';") >= 0, 'aiMode 先认 api');
    truthy(note.indexOf("if (ai.mode === 'taiji' || !ai.mode) return 'taiji';") >= 0, '老配置 / 认不出的值回 taiji，别掉回网页对话');
    truthy(note.indexOf("if (this.aiMode() !== 'api') return true;") >= 0, 'taiji / web 只要没关闭就算可发');
    truthy(note.indexOf('V.aiModeTaiji') >= 0, '状态带要用太极AI 的名字');
    truthy(note.indexOf('taiji ? V.aiOpenOptions : V.aiGoLogin') >= 0, 'taiji 的兜底按钮是「去设置」');
    truthy(note.indexOf('if (taiji) this.openAiOptions(); else this.openAiWeb();') >= 0, 'taiji 不许去开对话页');
    truthy(note.indexOf("p.postMessage({ action: 'new' });") >= 0, '清空对话仍只在网页模式发 new（taiji 没有会话可清）');
  });

  await test('★ 后台长连接：taiji 走 AI.chat（后台直连），只有 web 才走网页对话驱动', () => {
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("const mode = (m.mode === 'taiji') ? 'taiji' : ((m.mode === 'api') ? 'api' : 'web');") >= 0, '三态归一');
    truthy(sw.indexOf("const run = (mode !== 'web')") >= 0, 'taiji 与 api 同一支（都由 AI.chat 出站）');
    truthy(sw.indexOf('self.KhAi.askWeb({ messages: m.messages, onChunk:') >= 0, '网页对话仍是流式');
  });

  await test('★ 文案与隐私：默认通路的说明、needLogin 提示、隐私声明都要跟代码一致', () => {
    const V = read('src/ui/ocr-copy.js');
    truthy(V.indexOf("aiModeTaiji: '太极AI 网页通路'") >= 0, '缺少 aiModeTaiji 文案');
    truthy(V.indexOf('后台直接请求，不开标签页') >= 0, '太极AI 的提示要说清不开标签页');
    truthy(V.indexOf('切到「太极AI 网页通路」或「DeepSeek 网页对话」') >= 0, 'API 没配好时要指出两条免 Key 通路');
    const t = read('background/taiji.js');
    truthy(t.indexOf('needLogin: needLogin') >= 0, '会话失效要带 needLogin 回面板');
    const p = read('PRIVACY.md');
    truthy(p.indexOf('太极AI 网页通路（默认）') >= 0, '隐私声明要写默认通路');
    truthy(p.indexOf('**不落盘**') >= 0, '密码不落盘要写明');
    truthy(p.indexOf('同法人校验') >= 0 && p.indexOf('核准主体名称那一串公司名') >= 0, '法人兜底会把公司名发出去，必须披露');
  });

  /* ==================== ⑤ 2.0.16.1：绝不开标签页 + 品牌域名 ==================== */
  suite('2.0.16.1 · 太极AI 模式绝不开标签页；品牌域名自动跟随到真实宿主');

  await test('★ 后台闸门：只有 web 模式才允许碰对话页（看代码里没有第二条开标签页的路）', () => {
    const ai = read('background/ai.js');
    truthy(ai.indexOf('function webBlockReason(ai)') >= 0, '缺少 webBlockReason：非网页模式必须能被一句话拒绝');
    truthy(ai.indexOf("if (mode === 'web') return '';") >= 0, '只有 web 放行');
    /* 四个入口各判一次：设置页/面板可能拿着切模式前的旧配置来发 */
    eq((ai.match(/const no = await webBlockNow\(\);/g) || []).length, 3, 'openWeb / probeWeb / newWebChat 三个入口都要先判');
    truthy(ai.indexOf('const noWeb = webBlockReason(ai);') >= 0, 'askWeb 用已归一的配置再判一次');
    truthy(ai.indexOf('if (noWeb) return { ok: false, error: noWeb };') >= 0, 'askWeb 拒绝时要说原因');
    /* 开标签页只许有一个地方（ensureWebTab），且它在三道闸门之后 */
    eq((ai.match(/chrome\.tabs\.create\(/g) || []).length, 1, '开标签页只许 ensureWebTab 一处');
    truthy(ai.indexOf('不会打开对话页') >= 0, '拒绝的话要给用户看得懂的中文原因');
  });

  await test('★ 后台长连接：旧面板发 new 也不再开对话页', () => {
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("if (m.mode !== 'web')") >= 0, '清空对话要先看模式');
    truthy(sw.indexOf("try { port.postMessage({ type: 'newChat', ok: true }); } catch (e)") >= 0, '非 web 直接回 ok，不做任何事');
    const at = sw.indexOf("if (m.action === 'new')");
    const gate = sw.indexOf("if (m.mode !== 'web')");
    /* newWebChat 在别处还有一处路由（AI_WEB_NEW），所以只能从闸门之后找，不能整文件找第一个 */
    const call = sw.indexOf('self.KhAi.newWebChat()', gate);
    truthy(at >= 0 && gate > at && call > gate, '闸门必须在调用 newWebChat 之前');
  });

  await test('★ 站点白名单含品牌域名；已经是真实宿主就不再跟一次重定向', async () => {
    const { T, calls } = loadTaiji();
    truthy(T.allowedBase('https://www.taijiai666.com'), '品牌域名要能进白名单（用户看到的就是它）');
    truthy(T.allowedBase('https://ai.zhuangxiuyunying.xyz'), '真实宿主当然也在');
    falsy(T.allowedBase('https://taijiai666.com.evil.com'), '后缀冒充仍要拒');
    eq(typeof T.resolveRedirect, 'function', '缺 resolveRedirect');
    const same = await T.resolveRedirect('https://ai.zhuangxiuyunying.xyz');
    eq(same, 'https://ai.zhuangxiuyunying.xyz', '已经是真实宿主就原样返回');
    eq(calls.length, 0, '这种情况下不该发任何请求（省一次往返）');
    const real = await T.resolveRedirect('https://www.taijiai666.com');
    eq(real, 'https://ai.zhuangxiuyunying.xyz', '品牌域名要跟到 301 之后的真实 origin');
    truthy(calls.length === 1 && calls[0].method === 'GET', '必须用 GET 去跟（POST 跟 301 会退化成 GET）');
  });

  await test('★ 登录/模型清单回执带上「实际连上的站点」', () => {
    const t = read('background/taiji.js');
    truthy(t.indexOf('async function baseNow()') >= 0, '缺 baseNow（拿不到站点不该让登录失败）');
    eq((t.match(/base: await baseNow\(\)/g) || []).length, 2, '登录与模型清单两条回执都要带 base');
    truthy(t.indexOf("const CANON_HOST = 'ai.zhuangxiuyunying.xyz';") >= 0, '真实宿主常量要在');
    truthy(t.indexOf('站点跳转到了白名单之外') >= 0, '跟到白名单之外必须拒绝');
    const js = read('options/options.js');
    truthy(js.indexOf('；站点：') >= 0, '设置页要把实际站点写出来');
    const html = read('options/options.html');
    truthy(html.indexOf('品牌域名会自动跟随跳转') >= 0, '站点地址的 label 要说明品牌域名可用');
    truthy(html.indexOf('placeholder="https://www.taijiai666.com"') >= 0, 'placeholder 用用户认得的品牌域名');
  });
};

