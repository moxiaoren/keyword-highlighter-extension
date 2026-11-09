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

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const NC = KH.NoteCheck;

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
        return Promise.resolve([{ result: text }]);
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
};
