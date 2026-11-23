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
function loadPolicy(fetchImpl, extraChrome, kh) {
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
        },
        /* 【2.0.15】清空读正文缓存走的是 remove —— 桩里也得有，否则那条用例测的是空气 */
        remove: (k, cb) => {
          delete mem[k];
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
  /* 【2.0.16.4】policy 的「读不到时自动开后台标签页」开关要通过 KH.Config.load() 读，
   * 这里允许调用方注入自己的 KH 桩（例如关掉开关的那个用例）。 */
  sandbox.KH = kh || {};
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

  await test('★ 拦在安全提示页、又没有已打开的同页：说清「请手动打开一次」，不再自作主张开页签', async () => {
    const created = [];
    const tabs = {
      query: () => Promise.resolve([]),
      create: (a) => { created.push(a); return Promise.resolve({ id: 9, url: 'chrome-error://chromewebdata/' }); }
    };
    const scripting = { executeScript: () => Promise.reject(new Error('Frame with ID 0 is showing error page')) };
    const { Policy } = loadPolicy(async () => { throw new TypeError('Failed to fetch'); }, { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('http://zs.cszesu.test/scenead-frontend/agreement?type=1');
    falsy(r.ok, '读不到就不许装成功');
    truthy(/手动打开/.test(r.reason), '要说清怎么自救：' + r.reason);
    eq(created.length, 0, 'C 档绝不许新建标签页');
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

  suite('policy · 直接抓取失败时只读用户已经打开的页（2.0.14.6 C 档 · 不再开新标签）');

  /** 造一套最小的 tabs/scripting 桩：建页 → complete → 注入读文本 → 关页。 */
  /** 【2.0.14.6 · m13678 C 档】桩：模拟「用户已经把这个页面开着」——query 查得到同一张页，注入读得到文本。
   * create 只为断言「一次都没调」而存在。 */
  function openTabStub(text, pageUrl) {
    const calls = { created: [], injected: [] };
    const tabs = {
      query: () => Promise.resolve([{ id: 7, url: pageUrl }]),
      create: (arg) => { calls.created.push(arg); return Promise.resolve({ id: 8 }); }
    };
    const scripting = {
      executeScript: (arg) => {
        calls.injected.push(arg);
        return Promise.resolve([{ result: text }]);
      }
    };
    return { tabs, scripting, calls };
  }

  /** 【2.0.16.4 · m19385 A 档】桩：模拟「扩展自己开一张后台标签页」——create 回 id，
   * 下一拍通过 onUpdated 报 complete，注入能读到 text，finish 时 remove 掉。 */
  function renderTabStub(text, pageUrl) {
    const calls = { created: [], injected: [], removed: [] };
    const listeners = [];
    const tabs = {
      query: () => Promise.resolve([]),
      create: (arg) => {
        calls.created.push(arg);
        setTimeout(() => {
          listeners.slice().forEach((fn) => {
            try { fn(8, { status: 'complete', url: arg && arg.url }); } catch (e) { /* ignore */ }
          });
        }, 0);
        return Promise.resolve({ id: 8, url: pageUrl });
      },
      remove: (id) => { calls.removed.push(id); return Promise.resolve(); },
      onUpdated: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }
      }
    };
    const scripting = {
      executeScript: (arg) => {
        calls.injected.push(arg);
        return Promise.resolve([{ result: text }]);
      }
    };
    return { tabs, scripting, calls };
  }

  await test('直接抓失败、但用户已经开着这个页面：读那张页，via=tab，且一张新标签都不开', async () => {
    const stub = openTabStub('某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。', 'https://blocked.test/privacy');
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://blocked.test/privacy');
    truthy(r.ok, '读已开页要能成功：' + JSON.stringify(r));
    eq(r.via, 'tab');
    truthy(String(r.text).indexOf('北京某某科技有限公司') >= 0, '读到的要是渲染后的正文');
    eq(stub.calls.created.length, 0, 'C 档绝不许新建标签页');
  });

  await test('★ 直接抓不到、用户也没打开：自动开一张后台标签页读完关掉（A 档）', async () => {
    /* 【2.0.16.4 · m19385】用户口径「P4 选 A」：允许自动开后台标签页渲染后读正文。
     * 与 2.0.14.6 的 C 档相反，这条用例就是新口径的锁定。 */
    const body = '某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。';
    const stub = renderTabStub(body, 'https://blocked.test/short');
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://blocked.test/short');
    truthy(r.ok, '后台标签页读到正文就该成功：' + JSON.stringify(r));
    eq(r.via, 'tab-new', '要标出这是新建的后台标签页读到的');
    truthy(String(r.text).indexOf('北京某某科技有限公司') >= 0, '正文要回来');
    eq(stub.calls.created.length, 1, '同一轮只许开一张');
    eq(stub.calls.created[0].active, false, '必须是后台（不抢前台）');
    truthy(stub.calls.removed.indexOf(8) >= 0, '读完要关掉');
  });

  await test('★ 设置里关掉「读不到时自动开后台标签页」：一张都不开，并说清去哪里打开', async () => {
    const stub = renderTabStub('不该来这里', 'https://off.test/p1');
    const kh = { Config: { load: async () => ({ config: { policy: { renderTab: false } } }) } };
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: stub.tabs, scripting: stub.scripting }, kh);
    const r = await Policy.fetchText('https://off.test/p1', { hints: ['开发者'] });
    falsy(r.ok, '关掉开关之后读不到就是读不到');
    eq(stub.calls.created.length, 0, '关掉了就一张都不许开');
    truthy(String(r.reason).indexOf('关掉了') >= 0, '要说清是设置里关的：' + r.reason);
  });

  /* 2026-11-22 真机验收发现：第一遍失败被缓存 10 分钟，用户按卡片提示把页面打开、回来点重试，
   * 仍然吃同一份失败缓存 —— 提示就成了死循环。已开页必须优先于失败缓存。 */
  await test('★ 失败被缓存过：用户按提示打开该页再重试，不许再回旧失败', async () => {
    const body = '某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。';
    let opened = false;
    const tabs = {
      query: () => Promise.resolve(opened ? [{ id: 7, url: 'https://late.test/privacy' }] : []),
      create: () => Promise.resolve({ id: 9 })
    };
    const scripting = { executeScript: () => Promise.resolve([{ result: body }]) };
    const { Policy } = loadPolicy(async () => { throw new TypeError('failed to fetch'); }, { tabs: tabs, scripting: scripting });
    const first = await Policy.fetchText('https://late.test/privacy');
    falsy(first.ok, '第一遍：用户还没打开页面，应当失败');
    const second = await Policy.fetchText('https://late.test/privacy');
    truthy(second.cached, '前提：第二遍确实命中失败缓存（否则这条用例测不到点子上）');
    opened = true;   /* 用户照着提示把页面打开 */
    const third = await Policy.fetchText('https://late.test/privacy');
    truthy(third.ok, '已开页之后重试要能读到正文：' + JSON.stringify(third));
    eq(third.via, 'tab', '应走「读已开页」这条路');
  });

  /** 【2.0.16.4 · m19385 A 档】开页签这条路回来了，但仍要受三条约束：
   * ①只在读不到的时候用；②同一轮最多一张（readViaTab 的 allowNew）；③设置能关。 */
  await test('★ A 档的三条约束都还在源码里（allowNew / 只开一次 / 开关）', async () => {
    const src = read('background/policy.js');
    truthy(/function readNewTabOnce/.test(src), '后台标签页轮询实现要在');
    truthy(/function readNewTab\(/.test(src), '同一个时刻只跑一张（tabQueue 串行）');
    truthy(/allowNew === false/.test(src), '调用方要能把这条路关掉');
    truthy(/function tabRenderAllowed/.test(src), '设置开关要能读到');
    truthy(/renderTab !== false/.test(src), '默认开、只有显式 false 才关');
    truthy(/openedNew/.test(src), '同一轮已经开过就不再开第二张');
    truthy(/tabs\.create\(\{ url: url, active: false \}\)/.test(src), '必须是后台标签页（active:false）');
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

  await test('静态正文够长但缺目标词（模板页）：用户开着这页就读它，via=tab', async () => {
    const stub = openTabStub('某某清理大师隐私政策\n开发者：北京某某科技有限公司\n我们重视您的隐私，完整正文就在这里，请仔细阅读以下全部条款内容。', 'https://spa.test/privacy');
    const html = '<html><body><p>'
      + '某某清理大师隐私政策模板占位，正文由脚本按应用名填充。'.repeat(3)
      + '</p></body></html>';
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://spa.test/privacy', { hints: ['北京某某科技有限公司'] });
    truthy(r.ok, JSON.stringify(r).slice(0, 200));
    eq(r.via, 'tab');
    truthy(r.text.indexOf('北京某某科技有限公司') >= 0, '命中的必须是渲染后的正文');
    eq(stub.calls.created.length, 0, '读已开页，不许再建标签页');
  });

  await test('★ 正文够长但主体名由链接参数在 JS 里渲染（ysxy.html 案例）：用户开着就读渲染结果', async () => {
    /* 用户 2026-11-17 报的真实站：agreement-*.cos.../util/ysxy.html?appName=…&appTheme=…
     * 静态 HTML 里那两个名字出现 0 次，7845 字全是通用模板；页内脚本 params.get('appName')
     * 才把它们写进正文。C 档读用户已经打开的那张页，绝不新开标签。 */
    const pageUrl = 'https://agreement.test/util/ysxy.html?appName=' + encodeURIComponent('企业信息信用查询帮');
    const stub = openTabStub('企业信息信用查询帮 隐私政策\n上海昂思通科技有限责任公司杭州第五分公司 提供'
      + '\n本政策说明我们如何收集、使用、保存与共享您的个人信息，以及您行使各项权利的方式。', pageUrl);
    const tpl = '<p>' + '本政策适用于（以下简称“我们”）在中国大陆提供的APP及相关产品和服务。'.repeat(120)
      + '</p><p>联系方式为 users_feedback@126.com</p>'
      + "<script>var s = location.search; var params = new URLSearchParams(s);"
      + "var appName = params.get('appName'); appName = decodeURIComponent(appName);</script>";
    const html = '<html><body>' + tpl + '</body></html>';
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText(pageUrl, {
      hints: ['企业信息信用查询帮', '上海昂思通科技有限责任公司杭州第五分公司']
    });
    eq(r.via, 'tab', '够长的模板页缺目标词时，也要读渲染结果：' + JSON.stringify(r).slice(0, 160));
    truthy(String(r.text).indexOf('上海昂思通') >= 0, '拿到的必须是渲染后的正文');
    eq(stub.calls.created.length, 0, '只读已开页，不许建标签页');
  });

  await test('★ 目标词正文里已经有了：即使 HTML 带取参脚本也不去读页、不建标签页', async () => {
    const stub = openTabStub('不该来', 'https://spa.test/privacy?appName=x');
    const html = '<html><body><p>' + '某某清理大师隐私政策正文，说明收集范围与用户权利。'.repeat(200)
      + '开发者：北京某某科技有限公司</p>'
      + "<script>var appName = params.get('appName');</script></body></html>";
    const { Policy } = loadPolicy(page(html), { tabs: stub.tabs, scripting: stub.scripting });
    const r = await Policy.fetchText('https://spa.test/privacy?appName=x', { hints: ['北京某某科技有限公司'] });
    eq(r.via, 'fetch', '正文已覆盖目标词 ⇒ 不该再去读页');
    eq(stub.calls.created.length, 0, '不许白开标签页');
    eq(stub.calls.injected.length, 0, '连注入都不该发生');
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

  await test('模板页 + 用户没打开：不猜、不偷偷开页签，给出打开提示', async () => {
    const created = [];
    const tabs = { query: () => Promise.resolve([]), create: (a) => { created.push(a); return Promise.resolve({ id: 9 }); } };
    const scripting = { executeScript: () => Promise.resolve([{ result: '' }]) };
    const html = '<html><body><p>加载中…正文由脚本填充</p></body></html>';
    const { Policy } = loadPolicy(page(html), { tabs: tabs, scripting: scripting });
    const r = await Policy.fetchText('https://toutiao.test/privacy', { hints: ['今日头条'] });
    falsy(r.ok, '模板页不许判成功');
    eq(created.length, 0, '不许开页签');
    truthy(/手动打开/.test(String(r.reason)), '要提示手动打开：' + r.reason);
  });

  /* ---------------- 【2.0.14.6 · A/B 档】不再开新页签之后的两条补强 ---------------- */

  await test('★ A 档：用户自己打开过的政策页正文进缓存，面板再读命中缓存、不发请求', async () => {
    let calls = 0;
    const { Policy } = loadPolicy(async () => { calls++; throw new Error('不该发请求'); });
    const url = 'https://a.test/privacy-policy';
    const body = '本政策说明我们如何收集与使用个人信息：收集设备信息、日志信息与账号信息，并说明你享有的查询、更正与删除权利。';
    const w = await Policy.rememberText(url, body);
    truthy(w.ok, '写入缓存：' + JSON.stringify(w));
    const r = await Policy.fetchText(url, { hints: [] });
    truthy(r.ok, '应命中缓存：' + JSON.stringify(r).slice(0, 200));
    eq(r.cached, true, '要标成缓存命中');
    eq(r.via, 'open', '来源写「用户浏览过的正文」');
    eq(calls, 0, '命中缓存不许再发网络请求');
    const w2 = await Policy.rememberText('https://a.test/privacy2', '登录后可见');
    falsy(w2.ok, '太短的正文（壳页/登录墙）不许占坑');
  });

  await test('★ B 档：HTML 里没有 /api/ 时，从同源打包脚本里捞接口候选再请求', async () => {
    const seen = [];
    const shell = '<html><body><div id="app">加载中…</div><script src="/js/app.8f3a.js"></script></body></html>';
    const bundle = 'var cfg={url:"/api/privacy/detail?appId=${appId}"};';
    const apiJson = JSON.stringify({ data: { content: '本政策说明我们收集的信息范围与使用目的，包括设备信息、日志信息和账号信息。' } });
    const impl = async (u) => {
      const s = String(u);
      seen.push(s);
      if (/\/js\/app\.8f3a\.js/.test(s)) return { ok: true, status: 200, headers: { get: () => 'application/javascript; charset=utf-8' }, text: async () => bundle };
      if (/\/api\/privacy\/detail/.test(s)) return { ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, text: async () => apiJson };
      return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => shell };
    };
    const { Policy } = loadPolicy(impl);
    const r = await Policy.fetchText('https://b.test/privacy?appId=42', { hints: ['设备信息'] });
    truthy(r.ok, JSON.stringify(r).slice(0, 300));
    truthy(String(r.via).indexOf('api') >= 0, 'via 要带 api：' + r.via);
    truthy(seen.some((x) => /\/api\/privacy\/detail\?appId=42/.test(x)), '候选要填参并请求：' + seen.join(' | '));
  });
  /* ---------------- 【2.0.15】设置页能把读正文缓存清干净 ---------------- */

  await test('★ 设置页「读正文缓存」勾选：真的清空，且缓存表不留残余', async () => {
    const { Policy, mem } = loadPolicy(async () => { throw new Error('不该联网'); });
    const body = '本政策说明我们如何收集与使用个人信息：收集设备信息、日志信息与账号信息，并说明你享有的查询、更正与删除权利。';
    truthy((await Policy.rememberText('https://c.test/privacy', body)).ok, '先写一条缓存');
    truthy(Object.keys(mem.khPolicyCacheV3 || {}).length >= 1, '前提：缓存里确实有东西');
    const r = await Policy.clearCache();
    truthy(r.ok, '清空要回报成功');
    eq(r.removed, 1, '要记下清掉几条：' + JSON.stringify(r));
    eq(Object.keys(mem.khPolicyCacheV3 || {}).length, 0, '缓存表要真空，不是只清内存副本');
    const html = read('options/options.html');
    const js = read('options/options.js');
    truthy(/id="rst-cache"/.test(html), '设置页要有「读正文缓存」勾选（隐私说明里写了可清空）');
    truthy(/POLICY_CACHE_CLEAR/.test(js), '勾了要真发消息请后台清，不能只改文案');
  });
};
