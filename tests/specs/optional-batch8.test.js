/* tests/specs/optional-batch8.test.js — C7「可选」清单第二批：O-4 / O-5 / O-6
 * ----------------------------------------------------------------------------
 * 三条都是 P3（不阻塞），但都是"用户能看见的说谎"：
 *   · **O-4**：popup 首屏 HTML 自相矛盾 —— `popup.html` 副标题写死「全局已开启」，
 *     而同一行那个开关画着未勾选。真机实测错态窗口 39–43ms（7 个采样点，
 *     见 `_stage/wayfinder-kh-ui/c7a-popup-timing.js` 的 "chk=false && sub=全局已开启" 计数）。
 *   · **O-5**：页内编辑器样式 fetch 失败时**裸奔**（无样式白板弹窗），而 `open()` 照样
 *     `return true` ⇒ 内容脚本回 `{ok:true}` ⇒ popup 关掉自己，谁都来不及说一句"坏了"。
 *   · **O-6**：死代码/死参数三处 —— `keyword-editor.js` 的 `mode === 'popup' → 'sm'` 分支
 *     没有调用者了；`page-editor.js` 传的 `mode:'page'` 与 `'options'` 完全同支；
 *     `popup/popup.css` 里那份"内联 sm 弹窗"的尺寸注释与 `.kh-modal-mask` 覆盖层早已失效，
 *     留着会让下一个人照它把被用户否掉的 380px 观感复现一遍。
 *
 * 这里锁的是**可机械验证**的那部分（源码契约 + 行为）：真机证据（首屏错态样本归零、
 * 页面里样式失败真的退回独立窗口）在 `_e2e/ui.test.js` 的 popup 组与
 * `_stage/wayfinder-kh-ui/probe-o4-postfix.js`。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥掉注释：反面教材常留在注释里，直接 indexOf 会假阳性（与 write-honesty 同一口径）。
 *  HTML 也要一起剥 —— popup.html 的注释里正解释着旧 bug 的那句「全局已开启」。 */
const code = (s) => String(s)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const between = (src, a, b, what) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  truthy(i >= 0 && j > i, '找不到锚点：' + (what || a));
  return src.slice(i, j);
};

module.exports = async function run() {
  /* ============================ O-4 · 首屏不许自相矛盾 ============================ */
  suite('C7 O-4 · popup 首屏不声称任何全局状态');

  const html = read('popup/popup.html');
  const popupJs = read('popup/popup.js');
  const popupCss = read('popup/popup.css');

  await test('★ 首屏副标题是中性占位，不写死「全局已开启 / 已暂停」', () => {
    const m = /<span class="kh-pop-subtitle" id="global-state">([^<]*)<\/span>/.exec(html);
    truthy(m, 'popup.html 里找不到 #global-state 的首屏文本');
    truthy(m[1].indexOf('全局已开启') < 0 && m[1].indexOf('全局已暂停') < 0,
      '首屏不许写死全局状态（旧 bug 就是这句「全局已开启」），实际「' + m[1] + '」');
    truthy(/读取|加载|…/.test(m[1]), '首屏应与 #site-name 的「加载中…」同档：一个中性占位，实际「' + m[1] + '」');
    eq(code(html).indexOf('全局已开启'), -1, 'popup.html 里不应再出现「全局已开启」');
  });

  await test('★ 首屏开关是「未就绪」态：disabled + aria-busy，且不带 checked', () => {
    const input = /<input[^>]*id="chk-global"[^>]*>/.exec(html);
    truthy(input, '找不到 #chk-global 的标签');
    truthy(/\bdisabled\b/.test(input[0]), '状态还没读到，开关必须先 disabled');
    falsy(/\bchecked\b/.test(input[0]), '首屏不许带 checked —— 那是"猜"出来的状态');
    const label = /<label[^>]*class="kh-switch"[^>]*>/.exec(html);
    truthy(label, '找不到 .kh-switch 标签');
    truthy(/aria-busy="true"/.test(label[0]), '.kh-switch 首屏要标 aria-busy（CSS 靠它做"未就绪"外观）');
    truthy(/\.kh-switch\[aria-busy="true"\]/.test(code(popupCss)), 'CSS 要有 aria-busy 的"未就绪"外观规则');
  });

  await test('★ renderGlobalState 一帧落实三件事：摘 aria-busy / 解 disabled / 写值+文案', () => {
    const body = code(between(popupJs, 'function renderGlobalState(', '\n  }', 'renderGlobalState'));
    truthy(body.indexOf("removeAttribute('aria-busy')") >= 0, '要摘掉 aria-busy（否则开关永远是"未就绪"）');
    truthy(/chk-global'\)\.disabled = false/.test(body), '要解除 disabled');
    truthy(/checked = !!enabled/.test(body), '要写勾选态');
    truthy(body.indexOf("textContent = enabled ? '全局已开启' : '全局已暂停'") >= 0, '要写副标题文案');
    /* 顺序也要对：先摘 aria-busy / 解 disabled，再写值 —— 顺序反了会有一帧"能点但显示旧值" */
    truthy(body.indexOf('disabled = false') < body.indexOf('checked = !!enabled'), '解 disabled 必须早于写 checked');
  });

  await test('★ 状态读不出来不许猜：renderGlobalUnknown 收口，初始化失败也调用它', () => {
    const unk = code(between(popupJs, 'function renderGlobalUnknown(', '\n  }', 'renderGlobalUnknown'));
    truthy(/setAttribute\('aria-busy', 'true'\)/.test(unk), '读失败要保留"未就绪"外观（与"关"区分开）');
    truthy(/disabled = true/.test(unk), '读失败时开关不可点');
    truthy(unk.indexOf('状态读取失败') >= 0, '副标题要直说失败，而不是猜一个状态');
    const boot = code(between(popupJs, 'render().catch(', '});', 'render().catch'));
    truthy(boot.indexOf('renderGlobalUnknown()') >= 0, '初始化失败也要收口首屏那句「读取中…」，否则它永远停在那儿');
  });

  await test('★ 全局文案只有一处真源（popup.js 里「全局已开启」只许出现一次）', () => {
    const hits = code(popupJs).split('全局已开启').length - 1;
    eq(hits, 1, '「全局已开启」只许由 renderGlobalState 写一次，实际 ' + hits + ' 处');
  });

  /* ==================== O-5 · 样式读不到要认账（不许白板弹窗假装成功） ==================== */
  suite('C7 O-5 · 页内编辑器样式读不到就退回独立窗口');

  require('../bootstrap');
  const KH = global.window.KH;
  KH.ui = KH.ui || {};
  const realOpenEditor = KH.ui.openEditor;
  const realLoad = KH.Store.load;
  const realFetch = global.fetch;

  let opened = 0;
  let lastOpts = null;
  let fetches = 0;
  KH.ui.openEditor = (opts) => { opened++; lastOpts = opts; return { close() { /* 桩 */ } }; };
  KH.Store.load = async () => ({ keywords: [], groups: [] });
  // eslint-disable-next-line no-new-func
  new Function('window', read('src/features/page-editor.js'))(global.window);

  const hostInBody = () => (global.window.document.body.childNodes || [])
    .filter((n) => n && n.nodeType === 1 && n.id === 'kh-page-editor-host')[0] || null;

  try {
    await test('★ 两份样式都读不到 → open() 返回 false、不开编辑器、不留空宿主', async () => {
      global.fetch = () => { fetches++; return Promise.reject(new Error('resource blocked')); };
      const ok = await KH.PageEditor.open(null);
      eq(ok, false, '样式不全必须返回 false（popup 才会退回独立窗口）');
      eq(opened, 0, '样式不全时**不许**开编辑器 —— 那正是"白板弹窗"的来源');
      eq(fetches, 2, '两份样式都要试过（tokens.css + components.css）');
      falsy(hostInBody(), '失败了要把刚建的宿主撤掉，别在页面里留一层 z-index 最大空壳');
    });

    await test('★ 半份样式（只丢一份）也算失败，且不缓存残缺结果', async () => {
      let i = 0;
      global.fetch = () => {
        fetches++; i++;
        if (i === 2) return Promise.reject(new Error('components.css blocked'));
        return Promise.resolve({ ok: true, status: 200, text: async () => '/* tokens */ :root { --x: 1; }' });
      };
      const ok = await KH.PageEditor.open(null);
      eq(ok, false, '缺一份 CSS 也是"样式不全"（编辑器会没样式），必须 false');
      eq(opened, 0, '半份样式同样不许开');
      /* 关键：刚才那次 fetch 有成功的一份，绝不能把它缓存下来 —— 否则后续每次都"成功"地画白板 */
      let after = 0;
      global.fetch = () => { after++; return Promise.resolve({ ok: true, status: 200, text: async () => '/* css */ :root { --x: 1; }' }); };
      const ok2 = await KH.PageEditor.open(null);
      eq(ok2, true, '样式恢复正常后必须能开（证明上一轮的残缺没有被缓存）');
      eq(after, 2, '残缺没被缓存 ⇒ 这一轮要重新取两份，实际取了 ' + after + ' 份');
      eq(opened, 1, '这一轮才应该真的开编辑器');
    });

    await test('★ 样式齐全 → 真的开，且 :root 改写成 :host 后再进 ShadowRoot；缓存生效', async () => {
      const host = hostInBody();
      truthy(host, '成功路径要留下宿主');
      truthy(lastOpts && lastOpts.mount, 'Modal 必须挂到 ShadowRoot 上（mount）');
      const styleEl = host.shadowRoot && host.shadowRoot.querySelector('style');
      truthy(styleEl, 'ShadowRoot 里要有 <style>');
      truthy(String(styleEl.textContent).indexOf(':host') >= 0, ':root 必须改写成 :host，否则 shadow 里所有 token 都是空的');
      eq(String(styleEl.textContent).indexOf(':root'), -1, 'shadow 里不该残留 :root');
      /* 缓存：第三轮把 fetch 换成"一调就炸"，仍然要能开 */
      let third = 0;
      global.fetch = () => { third++; return Promise.reject(new Error('should not be called')); };
      const ok = await KH.PageEditor.open(null);
      eq(ok, true, '已缓存的样式不该再依赖网络/fetch');
      eq(third, 0, '命中缓存时不许再 fetch，实际 ' + third + ' 次');
      eq(opened, 2, '缓存命中也要真的把编辑器开出来');
    });
  } finally {
    global.fetch = realFetch;
    KH.ui.openEditor = realOpenEditor;
    KH.Store.load = realLoad;
  }

  /* ============================ O-6 · 死参数与死 CSS ============================ */
  suite('C7 O-6 · 死参数 mode 与失效的内联弹窗 CSS');

  await test('★ keyword-editor.js 不再有 mode 分叉（size 固定 lg）', () => {
    const src = code(read('src/ui/components/keyword-editor.js'));
    eq(src.indexOf('o.mode'), -1, 'o.mode 已无调用者，必须删干净');
    truthy(/size: 'lg',/.test(src), 'size 要写成固定 lg（三列 860px，与选项页/独立窗口/页面委派同源）');
  });

  await test('★ 四个调用点都不再传 mode', () => {
    const files = ['options/options.js', 'popup/editor.js', 'src/features/page-editor.js'];
    for (const f of files) {
      /* 只针对编辑器那三个业务值：`attachShadow({ mode: 'open' })` 是无辜的 API 参数 */
      falsy(/mode:\s*'(page|options|popup)'/.test(code(read(f))), f + ' 里不该再传编辑器 mode');
    }
  });

  await test('★ popup.css 删掉失效的内联 sm 覆盖层，注释也不再误导', () => {
    const raw = read('popup/popup.css');
    eq(code(raw).indexOf('kh-modal-mask'), -1, 'popup 里已无 Modal 挂载，.kh-modal-mask 是死覆盖层');
    falsy(/sm 弹窗|内联在本弹窗里/.test(raw), '旧的"要放得下内联 sm 弹窗"注释必须删掉（否则下一个人会照它复现被否掉的 380px 观感）');
    truthy(raw.indexOf('popup/editor.html') >= 0, '新注释要说清编辑器现在怎么开（页面委派 / 独立窗口）');
    truthy(raw.indexOf('不得出现任何硬编码色值') >= 0, '文件头那条硬编码色值禁令要保留');
  });

  await test('★ page-editor.js：样式判据必须被检查（ensureCss 的返回值不能再被丢弃）', () => {
    const src = code(read('src/features/page-editor.js'));
    truthy(/if \(!\(await ensureCss\(/.test(src), 'open() 必须检查 ensureCss 的结果');
    truthy(/return false;/.test(src), '样式不全要 return false');
    truthy(src.indexOf('missing.push(rel)') >= 0, '要记下缺了哪一份，日志才说得清');
    truthy(/cssText = parts\.join/.test(src) && src.indexOf('missing.length || !parts.length') >= 0,
      '只有在"一份不缺"时才允许写 cssText 缓存');
  });
};
