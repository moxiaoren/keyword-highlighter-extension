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

/** 假响应：JSON。第三参是 Set-Cookie 行（2.0.16.4：登录只靠 Set-Cookie 下发会话）。 */
function jsonRes(obj, status, cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => 'application/json', getSetCookie: () => list },
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

const TM_OK = { code: 0, data: { models: [{ model: 'openai::gpt-6.1-sol', name: 'GPT-6.1' }, 'google::gemini-3.1-pro-preview', { model: 'v::see', name: '看图模型', attr: { capabilities: { imageInput: true } } }] } };

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
    /* 【2.0.16.4】登录成功只回 Set-Cookie（站点 body 是 {code:0,data:null}）；默认给一行合法的会话 cookie。 */
    if (u.indexOf('/api/user/login') >= 0) {
      return jsonRes(o.login === undefined ? { code: 0, data: null } : o.login, 200,
        o.loginCookie === undefined ? ['ai-session=tok-1; Path=/; Max-Age=2592000'] : o.loginCookie);
    }
    if (u.indexOf('/api/chat/tmpl') >= 0) return jsonRes(o.tmpl === undefined ? TM_OK : o.tmpl);
    if (u.indexOf('/api/chat/session') >= 0) return jsonRes(o.session === undefined ? { code: 0, data: { id: 1001 } } : o.session);
    if (u.indexOf('/api/chat/completions') >= 0) {
      return o.chat || sseRes([
        'data: {"type":"string","data":"\u003cthink\u003e我先想一想"}\n\n',
        'data: {"type":"string","data":"\u003c/think\u003e你好呀"}\n\n',
        'data: {"type":"object","data":{"aiText":"","promptTokens":3,"completionTokens":5,"useTokens":8}}\n\n'
      ]);
    }
    return jsonRes({ code: 404, msg: 'not found' }, 404);
  };
  /* 【2.0.16.4】假 cookie 罐：SW 里 fetch 的 Set-Cookie 不会自己落盘，登录要靠 chrome.cookies.set 显式写入。 */
  const jar = {};
  const chrome = {
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : Object.assign({}, mem)),
        set: async (x) => { Object.assign(mem, x); }
      }
    },
    cookies: o.noCookies ? undefined : {
      set: (opt, cb) => { jar[opt.name] = Object.assign({}, opt); if (cb) cb(opt); },
      get: (q, cb) => { if (cb) cb(jar[q.name] || null); },
      getAll: (q, cb) => { if (cb) cb(Object.keys(jar).map((k) => jar[k])); },
      remove: (q, cb) => { delete jar[q.name]; if (cb) cb(); }
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
  return { T: sandbox.KhTaiji, calls: calls, mem: mem, sandbox: sandbox, jar: jar };
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

  await test('★ 2.0.16.2：站点真实形状 {label,value,attr} —— value 才是模型 id，非 chat 项剔掉', () => {
    const { T } = loadTaiji();
    /* 取自 2026-11-23 真实 /api/chat/tmpl 的前三条 + 一条生图模型（用户现场 167 条全部被丢空） */
    const real = [
      { label: 'GPT-6.2-sol', value: 'openai::gpt-6.2-sol', attr: { modelType: 'chat' } },
      { label: 'GPT-6.2-Astra', value: 'openai::gpt-6.2-astra', attr: { modelType: 'chat' } },
      { label: '雀绘', value: 'ts::image-1', attr: { modelType: 'image' } },
      { label: '无 attr 的', value: 'x::no-attr' }
    ];
    const got = T.normModels(real);
    eq(got.length, 3, '生图项被剔掉，没有 attr 的保留');
    eq(got[0].id, 'openai::gpt-6.2-sol', 'id 取 value（不是空）');
    eq(got[0].name, 'GPT-6.2-sol', '名字取 label');
    eq(got[2].id, 'x::no-attr', '缺 attr.modelType 时不剔');
    eq(T.normModels([{ label: '只有名字' }]).length, 0, '没有 value/model/id 就拿不到 id，不能塞空串进下拉');
  });

  await test('★ 2.0.17.2 · 模型清单带「可看图」能力位，站点错误原因带原文（用户 m24684）', () => {
    const { T } = loadTaiji();
    const got = T.normModels([
      { label: '看图模型', value: 'v::see', attr: { modelType: 'chat', capabilities: { imageInput: true } } },
      { label: '文件模型', value: 'v::file', attr: { capabilities: { anyFile: true } } },
      { label: '纯文本', value: 'v::text', attr: { modelType: 'chat' } }
    ]);
    eq(got[0].img, true, 'imageInput 要标成可看图');
    eq(got[1].img, true, 'anyFile 也要标成可看图');
    eq(got[2].img, false, '没有能力位就是纯文本');
    const t = read('background/taiji.js');
    truthy(t.indexOf("const why = String(j.err || j.msg || '').trim()") >= 0, '站点错误原因在 err/msg 里，不能只报 code');
    truthy(t.indexOf("'站点流错误 code=' + j.code + (why ? '：' + why : '')") >= 0, '错误串要把站点原话接上');
    truthy(t.indexOf('.slice(0, 3)') >= 0, '图片最多 3 张（站点 mFileCount 默认 3）');
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
    eq(res.models.length, 3, '登录成功后顺手把模型清单带回来（少一次往返）');
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
    /* 【2.0.18 · m24077】建会话也要带能力开关：只发 model 的话站点按默认（联网关）记这个会话。 */
    deepEq(sess.body, {
      model: 'openai::gpt-6.1-sol', plugins: [], mcp: [],
      webSearch: false, nativeTools: [], nativeToolOptions: {}, reasoningEffort: ''
    }, '没选模型时用清单第一个建会话，并带上站点要求的其它字段');
    const chat = calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0)[0];
    deepEq(chat.body, {
      text: '你好', sessionId: 1001, model: 'openai::gpt-6.1-sol',
      thinking: false, webSearch: false, nativeTools: [], nativeToolOptions: {}, reasoningEffort: ''
    }, '站点请求体：text + sessionId + model + 能力开关');
    /* 【2.0.16.7 · m20800】站点 sessionId 是 int64：必须是 JSON 数字，不能是字符串。 */
    eq(typeof chat.body.sessionId, 'number', 'sessionId 必须是数字（发字符串会让站点报 int64 解析失败）');
  });

  await test('★ 2.0.18 · 联网搜索与发图按站点真实字段发（webSearch 布尔 / files 收 dataURL）', async () => {
    const { T, calls } = loadTaiji();
    const r = await T.chat({
      messages: [{ role: 'user', content: '这个图标是不是蹭星巴克' }],
      webSearch: true,
      files: [{ name: 'a.png', data: 'data:image/png;base64,AAA' }, { name: 'b.png', data: 'raw-base64-no-prefix' }]
    });
    truthy(r.ok, '应成功：' + (r.error || ''));
    const chat = calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0)[0];
    eq(chat.body.webSearch, true, '勾了联网搜索就要把 webSearch 发成 true');
    truthy(Array.isArray(chat.body.files) && chat.body.files.length === 1, '只收 dataURL 的图，裸 base64 丢掉');
    eq(chat.body.files[0].name, 'a.png', '带原始文件名');
    eq(chat.body.thinking, false, 'thinking 显式关掉');
    const sess = calls.filter((c) => c.url.indexOf('/api/chat/session') >= 0)[0];
    eq(sess.body.webSearch, true, '建会话也要带同一个联网开关');
  });

  await test('★ 2.0.18 · 只有图没有字也能发（查图标场景），但两者都缺才拒绝', async () => {
    const a = loadTaiji();
    const ra = await a.T.chat({ messages: [], files: [{ name: 'x.png', data: 'data:image/png;base64,QQ' }] });
    truthy(ra.ok, '只有图应能发：' + (ra.error || ''));
    const chat = a.calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0)[0];
    truthy(!!chat && chat.body.files.length === 1, '图要带上');
    const b = loadTaiji();
    const rb = await b.T.chat({ messages: [], files: [] });
    falsy(rb.ok, '没字也没图不能发');
    truthy(rb.error.indexOf('没有要发送的内容') >= 0, '要有明确原因：' + rb.error);
    /* 站点只对带 imageInput/anyFile 的模型开放发图：清单里没有这种模型时必须当场说清，不能把图发出去换回 code=1。 */
    const c = loadTaiji({ tmpl: { code: 0, data: { models: ['m::text-only'] } } });
    const rc = await c.T.chat({ messages: [{ role: 'user', content: '看看这个图标' }], files: [{ name: 'y.png', data: 'data:image/png;base64,QQ' }] });
    falsy(rc.ok, '没有可看图模型时不能硬发');
    truthy(rc.error.indexOf('没有支持看图') >= 0, '要直接说清换模型：' + rc.error);
    eq(c.calls.filter((x) => x.url.indexOf('/api/chat/completions') >= 0).length, 0, '这种情况一个 completions 请求都不该发');
  });

  await test('★ 2.0.16.7 · 站点回字符串数字 id 也要转成整数发；非数字直接报错不发请求', async () => {
    const a = loadTaiji({ session: { code: 0, data: { id: '2002' } } });
    const r = await a.T.chat({ messages: [{ role: 'user', content: '你好' }] });
    truthy(r.ok, '字符串数字 id 应能转成整数：' + (r.error || ''));
    const c1 = a.calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0)[0];
    eq(c1.body.sessionId, 2002, '发出去的是整数 2002');
    eq(typeof c1.body.sessionId, 'number', '类型也必须是数字');
    const b = loadTaiji({ session: { code: 0, data: { id: 'sess-x' } } });
    const r2 = await b.T.chat({ messages: [{ role: 'user', content: '你好' }] });
    falsy(r2.ok, '非数字 id 不能硬发');
    truthy(r2.error.indexOf('不是数字') >= 0, '要直接说清会话 id 不对：' + r2.error);
    eq(b.calls.filter((c) => c.url.indexOf('/api/chat/completions') >= 0).length, 0, '这种情况一个 completions 请求都不该发');
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
    /* 【2.0.16.7】改成按「已启用的通道数」收口：关掉的通道不发也不等。 */
    truthy(src.indexOf('opened >= total') >= 0, '已启用的通道都放出去才收口（少一家就会过早判失败）');
    truthy(src.indexOf("finish(aiOut)") >= 0, '只有本地全空手才退到 AI');
    truthy(src.indexOf("source: 'ai'") >= 0, 'AI 结果带来源标记');
    truthy(src.indexOf('AI_TTL_MS') >= 0 && src.indexOf('6 * 3600 * 1000') >= 0, '模型推断只信 6 小时，不该和站点值一样存一天');
  });

  /* ==================== ③ 接线 ==================== */
  suite('2.0.16 · 接线：默认通路 / 密码不落盘 / 设置页与消息常量');

  await test('★ 配置层：只剩太极AI 一条通路；taiji 段没有 password 键', () => {
    eq(C.AI_MODE_DEFAULT, 'taiji', '默认 = 太极AI 网页通路（用户 2026-11-23 口径）');
    /* 【2.0.16.4】用户原话「只保留太极 AI，其余 AI 接口和调用路径全部移除」。 */
    eq(C.AI_MODES.map((m) => m.id).join(','), 'taiji', '设置页只该有太极AI 一项');
    eq(C.normalizeAi({}).mode, 'taiji', '老配置没写 mode ⇒ taiji');
    /* 【2.0.16.4】只剩一条通路：老配置里的 api / web 也要归到 taiji，否则会去走已删除的路由。 */
    eq(C.normalizeAi({ mode: 'web' }).mode, 'taiji', '老配置的 web 也要归到 taiji');
    eq(C.normalizeAi({ mode: 'api' }).mode, 'taiji', '老配置的 api 也要归到 taiji');
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
    /* 【2.0.16.4】AI.chat 不再分流：只剩一条路，直接交给 KhTaiji。 */
    truthy(ai.indexOf('self.KhTaiji.chat(payload)') >= 0, 'AI.chat 直接交给 KhTaiji（不再走 OpenAI 兼容请求）');
    falsy(/endpointOf\s*\(/.test(ai), 'OpenAI 兼容端点必须随 API 通路一起删掉');
    truthy(ai.indexOf('chrome.tabs.create(') < 0, 'ai.js 里不许再有任何开标签页的代码');
    truthy(ai.indexOf('AI.taijiLogin') >= 0 && ai.indexOf('AI.taijiModels') >= 0 && ai.indexOf('AI.taijiLogout') >= 0, '后台门面方法要在');
    const manifest = JSON.parse(read('manifest.json'));
    /* 【2.0.16.4】必须申请 cookies：MV3 SW 的 fetch 不落 Set-Cookie，会话只能靠 chrome.cookies 显式写。 */
    truthy((manifest.permissions || []).indexOf('cookies') >= 0, 'cookies 权限要在（写登录会话 / 退出时删）');
  });

  /* ==================== ④ 面板三态 + 后台长连接 ==================== */
  suite('2.0.16.4 · 面板只剩太极AI：不开标签页、没登录指去设置页');

  await test('★ 面板只剩一条路：状态写太极AI、没登录指去设置页、网页对话入口已消失', () => {
    const note = read('src/features/important-note.js');
    truthy(note.indexOf('return \'taiji\';') >= 0, 'aiMode 恒回 taiji（其余通路已删）');
    truthy(note.indexOf('return ai.enabled !== false;') >= 0, '只要没在设置里关掉就算可发');
    truthy(note.indexOf('V.aiModeTaiji') >= 0, '状态带要用太极AI 的名字');
    truthy(note.indexOf('V.aiOpenOptions') >= 0, '没登录时的按钮是「去设置」');
    truthy(note.indexOf('openAiWeb') < 0, 'openAiWeb（开对话页）必须随通路一起删掉');
    truthy(note.indexOf("action: 'new'") < 0, '清空对话不再发 new（太极AI 每问都新建会话）');
    /* 【2.0.18 · m24086/m24077/m24105】发消息要带上模型、联网开关与图片（不再只有 messages） */
    truthy(note.indexOf("action: 'ask', messages: messages,") >= 0, '发消息走 ask，并带上模型/联网/图片');
    truthy(note.indexOf('webSearch: !!this.aiWeb') >= 0, '联网搜索开关要跟着消息发出去');
    truthy(note.indexOf('files: ready.map(f => ({ name: f.name, data: f.data }))') >= 0, '图片要按站点收的 {name,data} 形状发');
    truthy(note.indexOf("action: 'setModel'") >= 0, '面板内换模型走 setModel');
    /* 【2.0.17.2 · m24684】图片上限对齐站点、不支持看图的模型先拦、粘贴/拖放收图、联网默认开 */
    truthy(note.indexOf('aiModelNoImg') >= 0, '选到不支持看图的模型要给出人话提示');
    truthy(note.indexOf("input.addEventListener('paste', onPaste)") >= 0, '支持直接粘贴图片');
    truthy(note.indexOf('const limit = 3;') >= 0, '图片上限 3 张（站点 mFileCount 默认 3）');
    truthy(note.indexOf('f.size > 5 * 1024 * 1024') >= 0, '单张上限 5MB（站点 mFileSize 默认 5）');
    truthy(note.indexOf('aiWeb: true') >= 0, '联网搜索默认开');
  });

  await test('★ 后台长连接：一律 AI.chat（内部转太极AI），不再看 mode、不再有网页对话驱动', () => {
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf('self.KhAi.chat({') >= 0, 'ask 只能走 AI.chat');
    truthy(sw.indexOf('messages: m.messages') >= 0, '对话内容要透传');
    /* 【2.0.18】模型 / 联网 / 图片也要透传到后台通路，否则面板上的开关等于没接 */
    truthy(sw.indexOf('webSearch: !!m.webSearch') >= 0, '联网开关要透传');
    truthy(sw.indexOf('files: Array.isArray(m.files) ? m.files : []') >= 0, '图片要透传');
    truthy(sw.indexOf("m.action === 'setModel'") >= 0, '换模型要写配置');
    truthy(sw.indexOf('askWeb') < 0, '网页对话驱动（askWeb）必须删干净');
    truthy(sw.indexOf("m.mode === 'taiji'") < 0, '不再按 mode 分支');
  });

  await test('★ 文案与隐私：默认通路的说明、needLogin 提示、隐私声明都要跟代码一致', () => {
    const V = read('src/ui/ocr-copy.js');
    truthy(V.indexOf("aiModeTaiji: '太极AI 网页通路'") >= 0, '缺少 aiModeTaiji 文案');
    truthy(V.indexOf('后台直接请求，不开标签页') >= 0, '太极AI 的提示要说清不开标签页');
    truthy(V.indexOf('aiNeedKey') >= 0 && V.indexOf('太极AI') >= 0, 'AI 不可用的提示要指向太极AI');
    truthy(V.indexOf('aiModeWeb') < 0 && V.indexOf('aiModeApi') < 0, '网页对话 / API 的文案要随通路一起删');
    const t = read('background/taiji.js');
    truthy(t.indexOf('needLogin: needLogin') >= 0, '会话失效要带 needLogin 回面板');
    const p = read('PRIVACY.md');
    truthy(p.indexOf('太极AI') >= 0, '隐私声明要写唯一的通路');
    truthy(p.indexOf('cookies') >= 0, '会话 cookie 要在本机、权限用途要披露');
    truthy(p.indexOf('**不落盘**') >= 0, '密码不落盘要写明');
    truthy(p.indexOf('同法人校验') >= 0 && p.indexOf('核准主体名称那一串公司名') >= 0, '法人兜底会把公司名发出去，必须披露');
  });

  /* ==================== ⑤ 2.0.16.1：绝不开标签页 + 品牌域名 ==================== */
  suite('2.0.16.1 · 太极AI 模式绝不开标签页；品牌域名自动跟随到真实宿主');

  await test('★ 开标签页的代码在后台已经彻底不存在（用户要求永不出现新标签页）', () => {
    const ai = read('background/ai.js');
    truthy(ai.indexOf('chrome.tabs.create(') < 0, 'ai.js 里不许再有开标签页');
    truthy(ai.indexOf('ensureWebTab') < 0 && ai.indexOf('askWeb') < 0 && ai.indexOf('newWebChat') < 0, '网页对话那套函数要删干净');
    const sw = read('background/service-worker.js');
    const at = sw.indexOf("if (m.action === 'new')");
    truthy(at >= 0, '长连接仍要认 new（面板清空对话会发）');
    truthy(sw.indexOf('newWebChat') < 0, 'SW 里不许再调用 newWebChat');
    truthy(sw.indexOf("try { port.postMessage({ type: 'newChat', ok: true }); } catch (e)") >= 0, 'new 只回 ok，不做任何事');
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
    eq((t.match(/base: (await baseNow\(\)|base)/g) || []).length, 2, '登录与模型清单两条回执都要带 base');
    truthy(t.indexOf("const CANON_HOST = 'ai.zhuangxiuyunying.xyz';") >= 0, '真实宿主常量要在');
    truthy(t.indexOf('站点跳转到了白名单之外') >= 0, '跟到白名单之外必须拒绝');
    const js = read('options/options.js');
    truthy(js.indexOf('；站点：') >= 0, '设置页要把实际站点写出来');
    const html = read('options/options.html');
    truthy(html.indexOf('品牌域名会自动跟随跳转') >= 0, '站点地址的 label 要说明品牌域名可用');
    truthy(html.indexOf('placeholder="https://www.taijiai666.com"') >= 0, 'placeholder 用用户认得的品牌域名');
  });

  /* ==================== ⑥ 2.0.16.4：会话 cookie 是本机唯一凭据 ==================== */
  suite('2.0.16.4 · 登录会话：Set-Cookie 要落到本机 cookie 罐，退出要清干净');

  await test('★ 登录成功把 ai-session 写进 cookie 罐，模型清单看得出已登录', async () => {
    const h = loadTaiji();
    const res = await h.T.login({ account: 'u1', password: 'p1' });
    truthy(res.ok, '登录要成功：' + (res.error || ''));
    truthy(h.jar['ai-session'], 'Set-Cookie 必须显式写进 cookie 罐（SW 的 fetch 不会自动落盘）');
    eq(h.jar['ai-session'].value, 'tok-1', '值要照抄站点给的');
    const m = await h.T.models();
    truthy(m.ok && m.logged === true, '登录后模型清单要显示已登录');
  });

  await test('★ 浏览器不给 cookies API ⇒ 登录必须失败并说清原因（不许假装成功）', async () => {
    const h = loadTaiji({ noCookies: true });
    const res = await h.T.login({ account: 'u1', password: 'p1' });
    falsy(res.ok, '存不住会话就不算登录成功');
    truthy(String(res.error).indexOf('没存住会话 cookie') >= 0, '要如实说「浏览器没存住会话 cookie」：' + res.error);
  });

  await test('★ 会话过期（站点 code=2）⇒ needLogin，面板据此指去设置页', async () => {
    const h = loadTaiji({ tmpl: { code: 2, msg: '您的登录已过期，请重新登录' } });
    const m = await h.T.models();
    falsy(m.ok, '过期就不算拿到清单');
    truthy(m.needLogin === true, 'code=2 必须判成 needLogin');
    truthy(String(m.error).indexOf('过期') >= 0, '站点的原话要透出来：' + m.error);
  });

  await test('★ 退出登录把会话 cookie 删掉，模型清单回到未登录', async () => {
    const h = loadTaiji();
    await h.T.login({ account: 'u1', password: 'p1' });
    truthy(h.jar['ai-session'], '先确认登录写进去了');
    const out = await h.T.logout();
    truthy(out.ok && out.cleared >= 1, '退出要删掉会话 cookie');
    falsy(h.jar['ai-session'], 'cookie 罐里不许再留着会话');
    const m = await h.T.models();
    truthy(m.logged === false, '退出后模型清单要显示未登录');
  });

  await test('★ 站点报错要带原话：只回 code=3 时看不出是「内容为空」', async () => {
    const h = loadTaiji({ chat: jsonRes({ code: 3, data: null, msg: '用户内容 是必填项' }, 400) });
    const res = await h.T.chat({ messages: [{ role: 'user', content: '你好' }] });
    falsy(res.ok, '400 不算成功');
    truthy(String(res.error).indexOf('用户内容 是必填项') >= 0, '必须透出站点原话，否则用户只看到 code=3：' + res.error);
  });
};

