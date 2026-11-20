/* tests/specs/policy.test.js — 【2.0.8.15】隐私政策链接正文抓取 + 判定口径
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-09 原话）：
 *   「隐私政策还是没实现啊。看需要命中的词是对的。我打开链接看隐私政策正文
 *     也确实有这两个内容，为什么还是判断为隐私政策内没有。」
 * 结论：卡片那一格抓到的不是正文（常常只是链接本身），必须去链接里取正文再比。
 * 这里锁三件事：
 *   ① background/policy.js 的 HTML→正文与抓取失败口径（不联网，stub fetch）；
 *   ② note-check 能认出「哪一格是链接」（policySource）；
 *   ③ 全角 / 零宽字符不会让「明明有」被比成「没有」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 后台模块用独立沙盒加载；fetch 由每条用例替换。 */
function loadPolicy(fetchImpl, extraChrome) {
  const mem = {};
  const chrome = Object.assign({
    storage: {
      local: {
        /* background/policy.js 走回调式 chrome.storage（单测沙箱两种都要给，只给 Promise 会永远 await 住） */
        get: (k, cb) => {
          const r = (typeof k === 'string') ? { [k]: mem[k] } : Object.assign({}, mem);
          if (typeof cb === 'function') { cb(r); return; }
          return Promise.resolve(r);
        },
        set: (o, cb) => {
          Object.assign(mem, o);
          if (typeof cb === 'function') { cb(); return; }
          return Promise.resolve();
        }
      }
    }
  }, extraChrome || {});
  const sandbox = {
    console: console,
    chrome: chrome,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    URL: URL,   /* policy.js 用 new URL(src, pageUrl) 绝对化 iframe 地址：浏览器里恒有，桩环境要补 */
    TextDecoder: TextDecoder,
    fetch: fetchImpl
  };
  sandbox.self = sandbox;
  sandbox.KH = {};
  vm.createContext(sandbox);
  vm.runInContext(read('background/policy.js'), sandbox, { filename: 'background/policy.js' });
  return { Policy: sandbox.KH.Policy, mem: mem };
}

const page = (html, type) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => type || 'text/html; charset=utf-8' },
  text: async () => html
});

/* GBK 编码样本：Node 没有 gbk 编码器，用解码表反推（每轮只建一次表）。 */
function gbkBytes(str) {
  const dec = new TextDecoder('gb18030');
  const map = new Map();
  const pair = new Uint8Array(2);
  for (let a = 0x81; a <= 0xfe; a++) {
    for (let b = 0x40; b <= 0xfe; b++) {
      pair[0] = a; pair[1] = b;
      const ch = dec.decode(pair);
      if (ch.length === 1 && ch !== '\ufffd' && !map.has(ch)) map.set(ch, [a, b]);
    }
  }
  const out = [];
  for (const ch of str) {
    if (ch.charCodeAt(0) < 0x80) { out.push(ch.charCodeAt(0)); continue; }
    const p = map.get(ch);
    if (!p) throw new Error('GBK 表里没有这个字：' + ch);
    out.push(p[0], p[1]);
  }
  return new Uint8Array(out);
}
/** 按字节回的桩：只有 arrayBuffer、没有 text（模拟真浏览器的 fetch 响应）。 */
const binPage = (bytes, type) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => type || 'text/plain' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
});

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const NC = Object.assign({}, KH.Compare, KH.Compare.Sources);

  suite('policy · HTML → 正文（链接里真正要匹配的那段字）');

  await test('脚本/样式/注释不算正文，块级换行保留，实体能还原', () => {
    const { Policy } = loadPolicy(async () => { throw new Error('不该联网'); });
    const html = '<html><head><style>.a{color:red}</style><script>var x=1;</script></head>'
      + '<body><!-- 广告 --><h1>某某清理大师&amp;隐私政策</h1>'
      + '<p>开发者：北京某某科技有限公司</p><p>核准主体：&#21271;&#20140;某某科技有限公司</p>'
      + '<noscript>请开启脚本</noscript></body></html>';
    const text = Policy.stripHtml(html);
    truthy(text.indexOf('某某清理大师&隐私政策') >= 0, '实体 &amp; 要还原');
    truthy(text.indexOf('北京某某科技有限公司') >= 0, '十进制实体要还原');
    truthy(text.indexOf('var x=1') < 0, 'script 内容不许进正文');
    truthy(text.indexOf('color:red') < 0, 'style 内容不许进正文');
    truthy(text.indexOf('广告') < 0, '注释不许进正文');
    truthy(text.indexOf('请开启脚本') < 0, 'noscript 不算正文');
  });

  suite('policy · fetchText（后台代抓，CORS 只有后台发得出去）');

  await test('抓回网页正文：返回 ok / 正文含关键词 / 第二次走缓存不再联网', async () => {
    let calls = 0;
    const impl = async () => { calls++; return page('<html><body><h1>某某清理大师隐私政策</h1>'
      + '<p>我们由北京某某科技有限公司运营，本政策说明个人信息处理规则与用户权利，含收集范围、使用目的、'
      + '保存期限、共享情形、注销渠道与投诉方式，请在使用前完整阅读并理解。</p></body></html>')(); };
    const { Policy } = loadPolicy(impl);
    const r1 = await Policy.fetchText('https://example.test/privacy');
    truthy(r1.ok, '应该抓成功：' + JSON.stringify(r1));
    truthy(r1.text.indexOf('北京某某科技有限公司') >= 0, '正文要能被判定层找到');
    eq(calls, 1);
    const r2 = await Policy.fetchText('https://example.test/privacy');
    truthy(r2.ok && r2.cached, '第二次应命缓存');
    eq(calls, 1, '缓存命中不许再联网');
  });

  await test('https 撞证书错误时换 http 再抓（sknow 案例）', async () => {
    const seen = [];
    const impl = async (u) => {
      seen.push(u);
      if (/^https:/i.test(u)) throw new TypeError('Failed to fetch');
      return page('<html><body><h1>飞翔的红蜻蜓</h1><p>北京知行灵动科技有限公司 隐私政策正文，'
        + '说明个人信息处理规则与用户权利，含收集范围、使用目的、保存期限、共享情形、注销渠道与投诉方式。</p></body></html>')();
    };
    const { Policy } = loadPolicy(impl);
    const r = await Policy.fetchText('https://sknow.test/app/yszc.html', { hints: ['北京知行灵动科技有限公司'] });
    truthy(r.ok, '换成 http 后应该抓到：' + JSON.stringify(r));
    truthy(r.text.indexOf('北京知行灵动科技有限公司') >= 0, '正文要回来');
    eq(seen.length, 2, '两个协议各试一次');
    truthy(/^https:/.test(seen[0]) && /^http:/.test(seen[1]), '先原协议再回退，顺序固定：' + seen.join(','));
  });

  await test('正文已经够长、只是提示词对不上时，不再开后台标签页', async () => {
    const tabCalls = [];
    const tabs = { create: (a) => { tabCalls.push(a); return Promise.resolve({ id: 9 }); }, remove: () => Promise.resolve() };
    const scripting = { executeScript: () => Promise.resolve([{ result: '不该来' }]) };
    const long = '<html><body><h1>隐私政策</h1><p>' + '本政策说明个人信息处理规则与用户权利。'.repeat(120) + '</p></body></html>';
    const { Policy } = loadPolicy(page(long), { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('https://sknow.test/long', { hints: ['飞翔的红蜻挺'] }); // 卡片里的错别字
    truthy(r.ok, '静态正文够长就应该直接成功');
    eq(tabCalls.length, 0, '不许为了一个错别字去开标签页');
  });

  await test('★ 标签页撞上「继续访问」拦截页：直接读用户已经打开的那张页（2026-11-17 zs.cszesu 案例）', async () => {
    const long = '<p>平台隐私政策：本政策说明个人信息处理规则与用户权利，含收集范围、使用目的、保存期限、'
      + '共享情形、注销渠道与投诉方式。' + '请在使用前完整阅读并理解。'.repeat(30) + '</p>';
    const tabs = {
      query: () => Promise.resolve([{ id: 30, url: 'https://zs.cszesu.test/scenead-frontend/agreement?type=1' }]),
      create: () => Promise.resolve({ id: 9, url: 'chrome-error://chromewebdata/' }),
      remove: () => Promise.resolve(),
      onUpdated: { addListener: () => {}, removeListener: () => {} }
    };
    const scripting = {
      executeScript: (o) => {
        if (o && o.target && o.target.tabId === 30) return Promise.resolve([{ result: long.replace(/<[^>]+>/g, '') }]);
        return Promise.reject(new Error('Frame with ID 0 is showing error page'));
      }
    };
    const { Policy } = loadPolicy(async () => { throw new TypeError('Failed to fetch'); }, { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('http://zs.cszesu.test/scenead-frontend/agreement?type=1', { hints: ['隐私政策'] });
    truthy(r.ok, '用户开着的那张页有正文，就该读它：' + JSON.stringify(r));
    eq(r.via, 'tab', '走的还是标签页读取这条路');
    truthy(r.text.indexOf('个人信息处理规则') >= 0, '正文要回来');
  });

  await test('★ 拦住了又抓不到 http 版：原因里要告诉用户关掉「始终使用安全连接」', async () => {
    const tabs = {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 9, url: 'chrome-error://chromewebdata/' }),
      remove: () => Promise.resolve(),
      onUpdated: { addListener: () => {}, removeListener: () => {} }
    };
    const scripting = { executeScript: () => Promise.reject(new Error('Frame with ID 0 is showing error page')) };
    const { Policy } = loadPolicy(async () => { throw new TypeError('Failed to fetch'); }, { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('http://zs.cszesu.test/scenead-frontend/agreement?type=1');
    falsy(r.ok, '读不到就不许装成功');
    truthy(/安全连接/.test(r.reason), '要说清怎么自救：' + r.reason);
  });

  await test('★ 方案 C：浏览器停在安全提示页时，直接抓 http 版正文，不用用户点「继续访问网站」', async () => {
    const long = '<p>' + '平台隐私政策：本政策说明个人信息处理规则、收集范围、使用目的、共享情形与保存期限。'.repeat(12) + '</p>';
    const shell = '<div id="app"></div>';
    let httpCalls = 0;
    const fetchImpl = async (url) => {
      if (/^https:/i.test(String(url))) throw new TypeError('Failed to fetch');
      httpCalls++;
      const body = httpCalls === 1 ? shell : long;   /* 首次静态抓只拿到空壳，方案 C 再抓时才是正文 */
      return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body };
    };
    const tabs = {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 9, url: 'chrome-error://chromewebdata/' }),
      remove: () => Promise.resolve(),
      onUpdated: { addListener: () => {}, removeListener: () => {} }
    };
    const scripting = { executeScript: () => Promise.reject(new Error('Frame with ID 0 is showing error page')) };
    const { Policy } = loadPolicy(fetchImpl, { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('https://zs.cszesu.test/agreement?type=1', { hints: ['隐私政策'] });
    truthy(r.ok, '方案 C 要能直接拿到正文：' + JSON.stringify(r));
    eq(r.via, 'fetch+http', '走的是 http 兜底这条路');
    truthy(r.text.indexOf('个人信息处理规则') >= 0, '正文要回来');
  });

  await test('非 http(s) / PDF / 空页面 / 网络失败都要给出人话原因，不许装成功', async () => {
    const { Policy } = loadPolicy(async () => { throw new Error('net down'); });
    const bad = await Policy.fetchText('javascript:void(0)');
    falsy(bad.ok); truthy(/http/.test(bad.reason), '非链接要说清');

    const pdf = loadPolicy(page('%PDF-1.4', 'application/pdf')).Policy;
    const rPdf = await pdf.fetchText('https://example.test/p.pdf');
    falsy(rPdf.ok); truthy(/PDF/.test(rPdf.reason), 'PDF 要明说读不出');

    const thin = loadPolicy(page('<html><body>加载中…</body></html>')).Policy;
    const rThin = await thin.fetchText('https://example.test/spa');
    falsy(rThin.ok); truthy(/正文/.test(rThin.reason), '空壳页要说「没读到正文」');

    const rErr = await Policy.fetchText('https://example.test/privacy');
    falsy(rErr.ok); truthy(/net down/.test(rErr.reason), '网络错误原因要带回来');
  });

  suite('policy · 抓取四例：GBK / JSON 包 HTML / 脚本正文 / iframe');

  await test('没有 charset 的 GBK 文本：按 UTF-8 解出乱码时自动改用 GBK', async () => {
    const body = '隐私政策\n欢迎使用“画质猫”。河南悦森信息技术有限公司（以下简称“我们”或“运营者”）'
      + '非常重视您的个人信息保护，本政策说明我们如何收集、使用、保存与共享您的个人信息，'
      + '以及您享有的查询、更正、删除与注销权利。';
    const { Policy } = loadPolicy(binPage(gbkBytes(body), 'text/plain'));
    const r = await Policy.fetchText('https://oss.test/kh.txt');
    truthy(r.ok, 'GBK 文本要能抓到：' + JSON.stringify(r).slice(0, 200));
    truthy(r.text.indexOf('河南悦森信息技术有限公司') >= 0, '正文不能是乱码');
    truthy(r.text.indexOf('\ufffd') < 0, '不许留替换字符');
  });

  await test('application/json 里装的是整页 HTML（163yu）：按网页取正文，不判「不是网页」', async () => {
    const html = '<!DOCTYPE html><html><body><h1>御府和田玉隐私政策</h1>'
      + '<p>本政策由上海御福工艺品有限公司发布，说明个人信息处理规则与用户权利，含收集范围、'
      + '使用目的、保存期限、共享情形、注销渠道与投诉方式，请在使用前完整阅读并理解。</p></body></html>';
    const { Policy } = loadPolicy(page(JSON.stringify(html), 'application/json; charset=utf-8'));
    const r = await Policy.fetchText('https://www.163yu.test/about/yinsi.html');
    truthy(r.ok, 'JSON 包 HTML 要能抓到：' + JSON.stringify(r).slice(0, 200));
    truthy(r.text.indexOf('上海御福工艺品有限公司') >= 0, '正文要回来');
    truthy(r.text.indexOf('御府和田玉') >= 0, '标题要回来');
  });

  await test('正文写在 <script> 里的站（dengban）：脚本中的中文串并入正文', async () => {
    const html = '<html><body><h1>用户隐私政策</h1><p>' + '本政策说明个人信息处理规则与用户权利。'.repeat(6) + '</p>'
      + '<script>var cfg={productName:"灯伴",companyFullName:"天津飞遇科技有限公司"};</script></body></html>';
    const { Policy } = loadPolicy(page(html));
    const r = await Policy.fetchText('https://h5.dengban.test/privacy');
    truthy(r.ok);
    truthy(r.text.indexOf('灯伴') >= 0, '脚本里的产品名要进正文');
    truthy(r.text.indexOf('天津飞遇科技有限公司') >= 0, '脚本里的公司名要进正文');
  });

  await test('正文在跨域 iframe 里（suanya）：去拉 iframe 的正文', async () => {
    const impl = async (u) => {
      if (String(u).indexOf('rulecenter.test') >= 0) {
        return page('<html><body><h1>智行旅行隐私政策</h1><p>上海蒜芽信息科技有限公司 说明个人信息处理规则与用户权利，'
          + '含收集范围、使用目的、保存期限、共享情形、注销渠道与投诉方式。</p></body></html>')();
      }
      return page('<html><body><img src="a.png"><iframe src="https://rulecenter.test/rule/164.html"></iframe></body></html>')();
    };
    const { Policy } = loadPolicy(impl);
    const r = await Policy.fetchText('https://m.suanya.test/yun/common/privacyPolicy?appid=5208', { hints: ['智行旅行'] });
    truthy(r.ok, 'iframe 里的正文要抓回来：' + JSON.stringify(r).slice(0, 240));
    truthy(r.text.indexOf('智行旅行') >= 0);
    truthy(/frame/.test(r.via), 'via 要标出走了 iframe：' + r.via);
  });

  suite('note-check · 从哪儿取链接 + 全角零宽不影响匹配');

  await test('policySource：抓取值本身是 URL 用它；否则用「隐私政策链接」字段；都没有返回 null', () => {
    eq(NC.policySource({ policy: 'https://a.test/p' }).from, 'policy');
    eq(NC.policySource({ policy: 'https://a.test/p' }).url, 'https://a.test/p');
    const byLink = NC.policySource({ policy: '隐私政策', link: 'https://b.test/p' });
    eq(byLink.from, 'link');
    eq(byLink.url, 'https://b.test/p');
    eq(NC.policySource({ policy: '我们重视隐私', link: '隐私政策' }), null);
    truthy(NC.looksLikeUrl('  https://c.test/x?y=1  '), '前后空格也算链接');
    falsy(NC.looksLikeUrl('www.c.test/x'), '没有协议头不算');
  });

  await test('全角字母 / 数字 / 零宽字符：正文里明明有，判定必须算命中', () => {
    const policy = '某某清理大师隐私政策：本应用由　北京某某科技有限公司（统一社会信用代码 91110108ＭＡ01ＸＹＺ8Ｑ）运营，'
      + '完整条款见 https://a.test/p 。';
    eq(NC.contains(policy, '北京某某科技有限公司'), true, '全角空格不能挡住命中');
    eq(NC.contains(policy, '91110108MA01XYZ8Q'), true, '全角字母数字要折成半角');
    eq(NC.contains('某某\u200b清理\u200d大师', '某某清理大师'), true, '零宽字符要忽略');
    const v = NC.policyVerdict({
      title: '某某清理大师',
      dev: '北京某某科技有限公司',
      link: 'https://a.test/p',
      policy: policy
    });
    truthy(v && v.ok, '三项都在正文里 ⇒ 绿');
    eq(v.items.length, 3, 'title / dev / 链接 三项都参与（链接只比域名，正文里有它就更稳）');
  });

  suite('policy · 直接抓取失败时退回后台标签页（2.0.8.16 · failed to fetch 兜底）');

  /** 造一套最小的 tabs/scripting 桩：建页 → complete → 注入读文本 → 关页。 */
  function tabStub(text, opts) {
    const o = opts || {};
    const calls = { created: [], removed: [], injected: [] };
    const listeners = [];
    const tabs = {
      create: (arg) => { calls.created.push(arg); return Promise.resolve({ id: 7 }); },
      remove: (id) => { calls.removed.push(id); return Promise.resolve(); },
      onUpdated: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
      }
    };
    const scripting = {
      executeScript: (arg) => {
        calls.injected.push(arg);
        if (o.injectError) return Promise.reject(new Error(o.injectError));
        /* 允许给一串文本：模拟「complete 首抓是空壳、过几拍才渲染出正文」（toutiao 案例）。 */
        const seq = Array.isArray(text) ? text : [text];
        const t = seq[Math.min(calls.injected.length - 1, seq.length - 1)];
        return Promise.resolve([{ result: t }]);
      }
    };
    /* 建页后的下一拍触发 complete（真实浏览器里是导航完成事件） */
    const kick = () => setTimeout(() => { listeners.slice().forEach((fn) => { try { fn(7, { status: 'complete' }); } catch (e) { /* ignore */ } }); }, 0);
    const orig = tabs.create;
    tabs.create = (arg) => { const p = orig(arg); kick(); return p; };
    return { tabs, scripting, calls };
  }

  await test('failed to fetch 时：真导航一次、读 innerText、读完立刻关页，返回 via=tab', async () => {
    const stub = tabStub('某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。');
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://blocked.test/privacy');
    truthy(r.ok, '标签页兜底要能成功：' + JSON.stringify(r));
    eq(r.via, 'tab');
    truthy(String(r.text).indexOf('北京某某科技有限公司') >= 0, '读到的要是渲染后的正文');
    eq(stub.calls.created.length, 1, '只开一次后台标签页');
    eq(stub.calls.created[0].active, false, '不许抢前台');
    eq(stub.calls.removed.join(','), '7', '读完必须关掉');
  });

  await test('标签页也读不到时：两边原因都写出来，不许假装成功', async () => {
    const stub = tabStub('登录后可见');
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://blocked.test/short');
    falsy(r.ok, '空壳页不许判成功');
    truthy(String(r.reason).indexOf('failed to fetch') >= 0, '直接抓取的原因要保留：' + r.reason);
    truthy(String(r.reason).indexOf('没读到正文') >= 0, '标签页的原因也要写：' + r.reason);
    eq(stub.calls.removed.join(','), '7', '失败也要关页');
  });

  /** 【2.0.14.4 · m12586 A 档】串行队列桩：每次建页发一个自增 id，记录「同一时刻有几张页活着」。 */
  function serialStub(text) {
    const calls = { created: [], removed: [] };
    const listeners = [];
    let nextId = 100;
    let live = 0;
    let maxLive = 0;
    const tabs = {
      create: (arg) => {
        calls.created.push(arg);
        const id = nextId++;
        live++;
        if (live > maxLive) maxLive = live;
        setTimeout(() => { listeners.slice().forEach((fn) => { try { fn(id, { status: 'complete' }); } catch (e) { /* ignore */ } }); }, 0);
        return Promise.resolve({ id: id });
      },
      remove: (id) => { calls.removed.push(id); live--; return Promise.resolve(); },
      onUpdated: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
      }
    };
    const scripting = { executeScript: () => Promise.resolve([{ result: text }]) };
    return { tabs: tabs, scripting: scripting, calls: calls, max: () => maxLive };
  }

  await test('★ 同一时刻只开一张后台标签页：连点两次「读取」也不许并排开两张', async () => {
    const body = '某某清理大师隐私政策\n开发者：北京某某科技有限公司\n' + '完整正文'.repeat(60);
    const stub = serialStub(body);
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting });
    const rs = await Promise.all([
      Policy.fetchText('https://a.test/p1'),
      Policy.fetchText('https://a.test/p2')
    ]);
    eq(rs.length, 2, '两次请求都要有结果');
    rs.forEach((r, i) => truthy(r && r.ok, '第 ' + (i + 1) + ' 次也要读到正文：' + JSON.stringify(r)));
    eq(stub.calls.created.length, 2, '两次都要真的开过后台标签页');
    eq(stub.max(), 1, '同一时刻最多一张后台标签页（否则页签栏会闪成一片）');
    eq(stub.calls.removed.length, 2, '两次读完都要立刻关掉');
    eq(stub.calls.created.map((c) => c.active).join(','), 'false,false', '一律后台打开、不许抢前台');
  });

  /* ------------------------------------------------------------------
   * 【2.0.8.22】用户 2026-11-11 报的 5 个案例，病根分三类，各锁一条：
   *   · 编码：GBK/UTF-16 站点按 UTF-8 解会整片乱码；
   *   · 模板页：静态正文够长但没有目标词（JS 后填）；
   *   · 接口页：正文根本不在 DOM 里，要按页面 URL 参数调同源接口；
   *   · 渲染慢：标签页 complete 首抓是空串，必须继续轮询。
   * ------------------------------------------------------------------ */
  suite('policy · 2.0.8.22 五类误报的回归（编码 / 渲染 / 同源接口 / 轮询）');

  await test('charset 不是 UTF-8 时按声明编码解（否则正文整片乱码、怎么比都没有）', async () => {
    const html = '<html><body><p>某某清理大师隐私政策：开发者北京某某科技有限公司，'
      + '本政策说明我们如何收集、使用、保存与共享您的个人信息，以及您行使查询更正删除注销投诉等权利的方式。</p></body></html>';
    const buf = Buffer.from(html, 'utf16le');
    const impl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-16le' },
      arrayBuffer: async () => buf
    });
    const { Policy } = loadPolicy(impl);
    const r = await Policy.fetchText('https://wide.test/privacy');
    truthy(r.ok, '要能解出来：' + JSON.stringify(r).slice(0, 200));
    truthy(r.text.indexOf('北京某某科技有限公司') >= 0, '解码后中文要原样（不能是乱码）');
  });

  await test('静态正文够长但缺目标词（模板页）：升级后台标签页读渲染后的正文，via=tab', async () => {
    const stub = tabStub('某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。');
    const html = '<html><body><p>'
      + '某某清理大师隐私政策模板占位，正文由脚本按应用名填充。'.repeat(3)
      + '</p></body></html>';
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://spa.test/privacy', { hints: ['北京某某科技有限公司'] });
    truthy(r.ok, JSON.stringify(r).slice(0, 200));
    eq(r.via, 'tab');
    truthy(r.text.indexOf('北京某某科技有限公司') >= 0, '命中的必须是渲染后的正文');
  });

  await test('★ 正文够长但主体名由链接参数在 JS 里渲染（ysxy.html 案例）：照样升级后台标签页', async () => {
    /* 用户 2026-11-17 报的真实站：agreement-*.cos.../util/ysxy.html?appName=…&appTheme=…
     * 静态 HTML 里那两个名字出现 0 次，7845 字全是通用模板；页内脚本 params.get('appName')
     * 才把它们写进正文。以前「正文够长就不再开标签页」，于是永远比不到。 */
    const stub = tabStub('企业信息信用查询帮 隐私政策\n上海昂思通科技有限责任公司杭州第五分公司 提供'
      + '\n本政策说明我们如何收集、使用、保存与共享您的个人信息，以及您行使各项权利的方式。');
    const tpl = '<p>' + '本政策适用于（以下简称“我们”）在中国大陆提供的APP及相关产品和服务。'.repeat(120)
      + '</p><p>联系方式为 users_feedback@126.com</p>'
      + "<script>var s = location.search; var params = new URLSearchParams(s);"
      + "var appName = params.get('appName'); appName = decodeURIComponent(appName);</script>";
    const html = '<html><body>' + tpl + '</body></html>';
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://agreement.test/util/ysxy.html?appName=' + encodeURIComponent('企业信息信用查询帮'), {
      hints: ['企业信息信用查询帮', '上海昂思通科技有限责任公司杭州第五分公司']
    });
    eq(r.via, 'tab', '够长的模板页缺目标词时，也要读渲染结果：' + JSON.stringify(r).slice(0, 160));
    truthy(String(r.text).indexOf('上海昂思通') >= 0, '拿到的必须是渲染后的正文');
    eq(stub.calls.created.length, 1, '只开一次后台标签页');
    eq(stub.calls.created[0].active, false, '不抢前台');
  });

  await test('★ 目标词正文里已经有了：即使 HTML 带取参脚本也不开标签页（省掉一次导航）', async () => {
    const stub = tabStub('不该来');
    const html = '<html><body><p>' + '某某清理大师隐私政策正文，说明收集范围与用户权利。'.repeat(200)
      + '开发者：北京某某科技有限公司</p>'
      + "<script>var appName = params.get('appName');</script></body></html>";
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://spa.test/privacy?appName=x', { hints: ['北京某某科技有限公司'] });
    eq(r.via, 'fetch', '正文已覆盖目标词 ⇒ 不该再导航');
    eq(stub.calls.created.length, 0, '不许白开标签页');
  });

  await test('正文只在同源接口 JSON 里：用页面 URL 的同名参数填 `${appId}` 模板，via=fetch+api', async () => {
    const pageHtml = '<html><body><h1>悬浮时钟闹钟 隐私政策</h1>'
      + '<p>本页正文由接口按应用 ID 填充，脚本如下：</p>'
      + '<script>const apiUrl = `${apiBaseUrl}/api/privacy-config/by-app-id?app_id=${appId}`;</script>'
      + '<p>' + '如果长时间停留在加载中，请刷新页面或稍后再试。'.repeat(3) + '</p></body></html>';
    const apiJson = JSON.stringify({ code: 0, data: { app_name: '悬浮时钟闹钟', company_name: '合肥元气满点网络科技有限公司' } });
    const impl = async (u) => {
      if (String(u).indexOf('/api/') >= 0) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json; charset=utf-8' },
          arrayBuffer: async () => Buffer.from(apiJson, 'utf8')
        };
      }
      return page(pageHtml)();
    };
    const { Policy } = loadPolicy(impl);
    const r = await Policy.fetchText('http://49.23.test/privacy-policy-dynamic.html?appId=255&channelId=2',
      { hints: ['悬浮时钟闹钟', '合肥元气满点网络科技有限公司'] });
    truthy(r.ok, JSON.stringify(r).slice(0, 300));
    eq(r.via, 'fetch+api');
    truthy(r.text.indexOf('合肥元气满点网络科技有限公司') >= 0, '接口 JSON 里的公司名要并进正文');
  });

  await test('标签页 complete 首抓是空串：继续轮询直到渲染出正文（toutiao 案例）', async () => {
    const stub = tabStub([
      '',
      '今日头条隐私政策\n开发者：北京抖音信息服务有限公司\n我们重视您的隐私，本政策说明个人信息的收集、使用、保存、共享与您的权利，请完整阅读。'
    ]);
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); },
      { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://toutiao.test/privacy', { hints: ['今日头条'] });
    truthy(r.ok, JSON.stringify(r).slice(0, 200));
    eq(r.via, 'tab');
    truthy(r.text.indexOf('北京抖音信息服务有限公司') >= 0);
    truthy(stub.calls.injected.length >= 2, '首抓空串必须再抓一次，不能就此判失败');
  });
};
