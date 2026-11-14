'use strict';
/* UI 层真浏览器测试：options（侧边栏/表格列/批量栏/编辑弹窗/保存往返） + popup（头部/站点卡+关键词数/快速添加） */
const { group, test, eq, truthy, falsy, includes, shot, report } = require('./t');

module.exports = async function runUi(ctx) {
  const { api, origin: ORIGIN } = ctx;      // origin = fixtures 站点（C7 O-5 要在真网页上验「页内编辑器」）

  /* ============================================================ options */
  const opt = await api.extensionPage('options/options.html');
  const optErrors = [];
  opt.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) optErrors.push(m.text()); });
  opt.on('pageerror', (e) => optErrors.push('pageerror: ' + e.message));
  await opt.waitForTimeout(600);

  group('8. options · 侧边栏与分区', { aspects: ['ui'] });

  await test('★ 左侧固定侧边栏，7 个分区（高亮+备注卡片已合并为「样式」，另有「图片识别」）', async () => {
    const nav = await opt.evaluate(() => {
      const side = document.querySelector('.kh-sidebar');
      if (!side) return null;
      const cs = getComputedStyle(side);
      const links = Array.from(side.querySelectorAll('a,button')).map(a => (a.textContent || '').trim()).filter(Boolean);
      /* 侧边栏底部还有一个「项目主页 ↗」链接（不算分区）→ 分区数按 `.kh-tab` 数 */
      const tabs = Array.from(side.querySelectorAll('.kh-tab')).map(a => (a.textContent || '').trim());
      const r = side.getBoundingClientRect();
      return { exists: true, position: cs.position, width: r.width, height: r.height, links, tabs, top: r.top };
    });
    truthy(nav, '应存在 .kh-sidebar');
    eq(nav.position, 'sticky', '侧边栏应为 sticky');
    truthy(nav.height > 400, '侧边栏应满高，实际 ' + nav.height);
    console.log('        侧边栏项: ' + JSON.stringify(nav.links));
    // 用户 2026-09 拍板：原「高亮样式」+「备注卡片样式」合并为一个「样式」分区（策划案的 7 分区已作废）
    const expect = ['关键词管理', '分组管理', '样式', '图片识别', '站点规则', '导入导出', '帮助与隐私'];
    for (const e of expect) {
      truthy(nav.links.some(l => l.indexOf(e) >= 0), '侧边栏应含「' + e + '」，实际 ' + JSON.stringify(nav.links));
    }
    // K72 B8-11：分区是 **7** 项（旧的人工检查清单写"6 项"，与 UI 不符）
    eq(nav.tabs.length, 7, '侧边栏应有恰好 7 个分区（`.kh-tab`），实际 ' + JSON.stringify(nav.tabs));
    falsy(nav.links.some(l => /高亮样式|备注卡片样式/.test(l)), '合并后不该再有「高亮样式」「备注卡片样式」两条，实际 ' + JSON.stringify(nav.links));
    // 合并后两个板块都要在同一个分区里
    const merged = await opt.evaluate(() => {
      const sec = document.getElementById('sec-style');
      return sec ? { hl: !!sec.querySelector('#hl-bg'), nc: !!sec.querySelector('#nc-fields') } : null;
    });
    truthy(merged && merged.hl && merged.nc, '「样式」分区里必须同时含高亮颜色与备注卡片两块，实际 ' + JSON.stringify(merged));
  });

  await test('★ 重要笔记「图片尺寸 / 正文字号」在「样式」分区，不在折叠的高级设置里（用户 2026-10-11 现场）', async () => {
    /* 动因：两个输入框原本埋在「帮助与隐私 → ⚙️ 性能 → 折叠的 <details>高级设置」里，
     * 同排还有 4 个性能调参；而「样式」分区（都是"全局默认外观"）空着 569px。 */
    const r = await opt.evaluate(() => {
      const sec = document.getElementById('sec-style');
      const out = {};
      for (const id of ['pf-imgSize', 'pf-noteFontSize']) {
        const el = document.getElementById(id);
        out[id] = el ? {
          inStyle: !!(sec && sec.contains(el)),
          inDetails: !!(el.closest('details')),
          label: ((el.closest('.kh-form-fld') || {}).textContent || '').trim()
        } : null;
      }
      return out;
    });
    for (const id of ['pf-imgSize', 'pf-noteFontSize']) {
      truthy(r[id], '设置页要有 #' + id + '（没有它用户没法配）');
      truthy(r[id].inStyle, '★ #' + id + ' 必须落在「样式」分区 —— 埋在「帮助与隐私 → 性能 → 高级设置」折叠块里就没人找得到');
      falsy(r[id].inDetails, '★ #' + id + ' 不许再包在折叠的 <details> 里，实际 ' + JSON.stringify(r[id]));
    }
    includes(r['pf-imgSize'].label, '尺寸', '#pf-imgSize 的字段标签要带「尺寸」');
    includes(r['pf-noteFontSize'].label, '字号', '#pf-noteFontSize 的字段标签要带「字号」');
  });

  await test('侧边栏底部版本徽标 = manifest 版本', async () => {
    const v = await opt.evaluate(() => {
      const el = document.getElementById('sidebar-version') || document.querySelector('.kh-sidebar .kh-version');
      return el ? el.textContent.trim() : null;
    });
    const ver = await opt.evaluate(() => chrome.runtime.getManifest().version);
    truthy(v, '应有版本徽标，实际 ' + v);
    includes(v, ver, '版本徽标应含 manifest 版本 ' + ver);
  });

  await test('★ 帮助页更新日志首条 = manifest 版本（发了版忘写 changelog 就红）', async () => {
    /* 用户 2026-10-11 要求补的断言：「帮助页出现当前版本条目」。
     * 渲染真源 `options/options.js` 的 `renderChangelog()`：数据取 `window.CHANGELOG`
     * （`src/ui/changelog.js`，**新版本写在数组第一条**），每条渲染成 `.kh-log-item > .kh-log-ver`，
     * 并给 `#ver-toc` 生成 `a.kh-ver-toc-item` 锚点。 */
    const r = await opt.evaluate(() => {
      const list = document.getElementById('changelog-list');
      const vers = list ? Array.from(list.querySelectorAll('.kh-log-ver')).map((e) => e.textContent.trim()) : [];
      const toc = Array.from(document.querySelectorAll('#ver-toc .kh-ver-toc-item')).map((a) => a.textContent.trim());
      return { n: vers.length, first: vers[0] || null, toc };
    });
    const ver = await opt.evaluate(() => chrome.runtime.getManifest().version);
    truthy(r.n > 0, '帮助页更新日志应至少渲染一条，实际 ' + JSON.stringify(r));
    includes(r.first, ver, '更新日志首条应是当前版本 ' + ver + '（新条目写在 src/ui/changelog.js 数组第一位），实际 ' + r.first);
    truthy(r.toc.some((t) => t.indexOf(ver) >= 0),
      '版本目录 #ver-toc 也应含当前版本 ' + ver + '，实际 ' + JSON.stringify(r.toc.slice(0, 4)));
  });

  await test('★ 关于页默认只渲染最近 8 条更新日志，可就地展开全部（用户 2026-10-11）', async () => {
    /* 动因：183 条全量渲染把「关于」页撑到 49,567px（一屏只见 1.6%），左栏目录 525px 全是版本号。
     * 这里只钉「默认渲染条数 = 8」与「目录条数 = 正文条数」—— 高度是结果不是契约。
     * L2-c：默认短视图之外必须能就地展开（不必跳欢迎页），展开后目录仍受 20 条上限约束。 */
    const r = await opt.evaluate(() => {
      const list = document.getElementById('changelog-list');
      const items = list ? Array.from(list.querySelectorAll('.kh-log-item')).length : -1;
      const toc = Array.from(document.querySelectorAll('#ver-toc .kh-ver-toc-item')).length;
      const total = (typeof window.CHANGELOG !== 'undefined' && Array.isArray(window.CHANGELOG)) ? window.CHANGELOG.length : 0;
      const foot = list ? (list.textContent || '') : '';
      return { items, toc, total, foot: foot.slice(-80) };
    });
    truthy(r.total > 8, '数据源应多于 8 个版本（否则这条断言是空跑），实际 ' + r.total);
    eq(r.items, 8, '关于页应只渲染最近 8 条，实际 ' + r.items + '（全量渲染会撑成 49,567px）');
    eq(r.toc, r.items, '版本目录条数必须跟着截断（目录比正文还长就没意义），实际 目录 ' + r.toc + ' / 正文 ' + r.items);
    truthy(r.foot.indexOf('共 ') >= 0 && r.foot.indexOf('最近') >= 0,
      '截断后要写清「共 N 个版本，只列最近 8 个」，实际尾部 ' + JSON.stringify(r.foot));

    const r2 = await opt.evaluate(async () => {
      const list = document.getElementById('changelog-list');
      const byText = (re) => Array.from(list.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));
      const open = byText(/展开全部/);
      const out = { hasToggle: !!open, items: -1, toc: -1, label: '', backItems: -1 };
      if (!open) return out;
      open.click();
      await new Promise((res) => setTimeout(res, 60));
      const back = byText(/只看最近/);
      out.items = list.querySelectorAll('.kh-log-item').length;
      out.toc = document.querySelectorAll('#ver-toc .kh-ver-toc-item').length;
      out.label = back ? back.textContent.trim() : '';
      if (back) { back.click(); await new Promise((res) => setTimeout(res, 60)); }
      out.backItems = list.querySelectorAll('.kh-log-item').length;
      return out;
    });
    truthy(r2.hasToggle, '★ 尾部要有「展开全部」按钮（L2-c：想看全不该只能跳欢迎页）');
    eq(r2.items, r.total, '★ 点「展开全部」后必须渲染全部 ' + r.total + ' 条，实际 ' + r2.items);
    truthy(r2.toc > 0 && r2.toc <= 20,
      '★ 展开后目录仍要受 20 条上限约束（否则左栏又变成 183 个版本号），实际 ' + r2.toc);
    includes(r2.label, '只看最近', '★ 展开后按钮要能切回「只看最近 8 个」，实际 ' + JSON.stringify(r2.label));
    eq(r2.backItems, 8, '★ 切回后必须回到默认短视图（否则"只看最近"是死按钮），实际 ' + r2.backItems);
  });

  await test('★ 图片识别页：三张折叠子卡 + 引擎控件在首屏内（用户 2026-10-11 现场 P4）', async () => {
    /* 动因：`#sec-ocr` 原本 1071px —— 首屏只看到一段说明，用户根本看不见「引擎」这个主控件；
     * 按归属拆成三张折叠卡（引擎 / 主引擎模型 / 兼容语言包），默认只展开「引擎」。
     * 折叠只是搬家：字段 id 一个都不许动（options.js 与探针全按 id 取）。 */
    const r = await opt.evaluate(() => {
      const sec = document.getElementById('sec-ocr');
      if (!sec) return null;
      const wasHidden = sec.hidden;
      sec.hidden = false;
      const cards = ['ocr-adv-engine', 'ocr-adv-model', 'ocr-adv-lang'].map((id) => {
        const d = document.getElementById(id);
        return { id: id, isDetails: !!d && d.tagName === 'DETAILS', open: !!d && d.open };
      });
      const eng = document.getElementById('ocr-engine');
      /* 页面主列里 #sec-ocr 前面还有别的分区占位 ⇒ 绝对 top 量的是「整页第几屏」，
       * 与「用户切到该分区后一眼能否看见引擎」无关。这里量**分区内相对偏移**。 */
      const secTop = Math.round(sec.getBoundingClientRect().top);
      const out = {
        height: Math.round(sec.getBoundingClientRect().height),
        engTop: (eng ? Math.round(eng.getBoundingClientRect().top) : secTop) - secTop,
        vh: window.innerHeight,
        cards: cards,
        idsKept: ['ocr-engine', 'ocr-model-list', 'ocr-lang-list', 'btn-ocr-selftest', 'ocr-site-input',
          'ocr-migrate-note', 'ocr-adv-body'].every((id) => !!document.getElementById(id)),
        secHeadText: (document.getElementById('ocr-style-hint') || {}).textContent || ''
      };
      sec.hidden = wasHidden;
      return out;
    });
    truthy(r, '设置页要有 #sec-ocr');
    console.log('        图片识别页高度 = ' + r.height + 'px，引擎控件在分区内 top = ' + r.engTop + '（视口 ' + r.vh + '）');
    eq(r.cards.filter((c) => c.isDetails).length, 3,
      '★ 三张折叠卡必须都是 <details>（引擎 / 主引擎模型 / 兼容语言包），实际 ' + JSON.stringify(r.cards));
    truthy(r.cards[0].open, '★ 默认要展开「引擎」那张 —— 折起来等于把主控件藏了，实际 ' + JSON.stringify(r.cards[0]));
    truthy(r.idsKept, '★ 折叠是搬家不是改名：字段 id 必须一个不少（options.js 与探针全按 id 取）');
    truthy(r.engTop >= 0 && r.engTop < r.vh,
      '★ 引擎控件必须落在分区首屏内，实际分区内 top=' + r.engTop + ' / 视口 ' + r.vh + '（本页原本 1071px，引擎在首屏之外）');
    /* 【2.0.7.3】预算 1000 → 1200：真版 2.0.7.2 在这个分区里加了一张**软著一致性核对**折叠卡
     * （六条字段名 + 比对基准），它是真功能、不是文案膨胀 —— 这条断言的本意（"别把引擎控件埋在
     * 一屏文字下面"）由上面那条 `engTop < 视口` 独立守着，所以这里只放宽总高预算，不放宽本意。 */
    truthy(r.height < 1200, '★ 本页高度要有上限（原 1071px；2.0.7.2 起多了软著核对卡），实际 ' + r.height + 'px');
    includes(r.secHeadText, '样式', '顶部要有一行指路「相关设置在 样式 → 重要笔记」（两个外观默认值已搬到那里）');
  });

  await test('★ 顶部全局开关 / 站点开关控件仍在且已绑定', async () => {
    const r = await opt.evaluate(() => ({
      hs: !!document.getElementById('head-state'),
      site: !!document.getElementById('btn-site-toggle'),
      glob: !!document.getElementById('btn-toggle-global'),
      siteText: document.getElementById('btn-site-toggle') ? document.getElementById('btn-site-toggle').textContent.trim() : ''
    }));
    truthy(r.hs && r.site && r.glob, '三个控件都应存在：' + JSON.stringify(r));
  });

  await test('★ K72-②：设置页帮助文案 —— 面板在左上角（不再写右上角）/ CSV 差异说明 / 尺寸前提', async () => {
    /* ⚠️ 只取 `#sec-help .kh-help` 里的静态文案：帮助区里还挂着 `#changelog-list`，
     * 那里面是**历史**更新日志（允许提右上角，不改写历史）。 */
    const r = await opt.evaluate(() => {
      /* 帮助区文案现在分两类容器：`.kh-help`（数据/常见/安全/性能/关于 面板，沿用旧结构）
       * 与 `.kh-hcard`（📖 功能 面板的卡片，K72-② 的「左上角」文案就在这里）。
       * 旧选择器只抓 `.kh-help`，漏掉了功能面板，导致断言恒为 []。两种都抓。 */
      const boxes = Array.from(document.querySelectorAll('#sec-help .kh-help, #sec-help .kh-hcard'));
      const items = [];
      boxes.forEach((b) => {
        Array.from(b.querySelectorAll('li, p')).forEach((el) => {
          /* 版本信息那个 `.kh-help` 里挂着 `#changelog-list`（历史更新日志）——
           * 历史条目允许提「右上角」（本轮不改写历史），所以整棵子树都要跳过。 */
          if (el.closest('#changelog-list')) return;
          items.push((el.textContent || '').trim());
        });
      });
      const csvItem = items.find((t) => t.indexOf('CSV 列') >= 0) || '';
      return {
        count: items.length,
        items: items,
        hasPanelTopLeft: items.some((t) => t.indexOf('左上角') >= 0 && /笔记|面板/.test(t)),
        anyTopRight: items.some((t) => t.indexOf('右上角') >= 0),
        csvItem: csvItem,
        sizeItem: items.find((t) => t.indexOf('图片尺寸按') >= 0) || ''
      };
    });
    truthy(r.count > 5, '应能读到帮助区的静态文案条目，实际 ' + r.count);
    truthy(r.hasPanelTopLeft, '帮助文案要说清面板在**左上角**（快速上手 / 重要笔记两处），实际 ' + JSON.stringify(r.items.filter((t) => t.indexOf('角') >= 0)));
    falsy(r.anyTopRight, '★ 帮助区静态文案里不该再出现「右上角」（历史 changelog 不算），实际 ' + JSON.stringify(r.items.filter((t) => t.indexOf('右上角') >= 0)));
    truthy(r.csvItem.indexOf('JSON 导出') >= 0, '★ CSV 列说明必须补"要连这些一起搬走请用 JSON 导出"，实际 ' + JSON.stringify(r.csvItem.slice(0, 200)));
    truthy(r.csvItem.indexOf('不含') >= 0, 'CSV 说明要说清不含哪些字段，实际 ' + JSON.stringify(r.csvItem.slice(0, 200)));
    truthy(r.sizeItem.indexOf('本词') >= 0, '★ 尺寸优先级要补「关键词那一档需本词勾「重要」」，实际 ' + JSON.stringify(r.sizeItem));
  });

  group('8b. options · 帮助与隐私 · 默认值输入', { aspects: ['ui'] });

  await test('★ 重要笔记「字号」默认值：填了就写进 importantNote.fontSize，越界/留空回落默认 11', async () => {
    const ctl = await opt.evaluate(() => {
      const el = document.getElementById('pf-noteFontSize');
      if (!el) return null;
      const fld = el.closest('.kh-form-fld');
      return { type: el.type, min: el.min, max: el.max, step: el.step, label: (fld ? fld.textContent : '').trim() };
    });
    truthy(ctl, '★ 设置页要有「重要笔记」字号输入框 #pf-noteFontSize（没有它用户没法配字号）');
    eq(ctl.type, 'number', '字号输入框应是数字框');
    eq(ctl.min, '6', '字号下限 6（2.0.2.7 用户 2026-10-15：10 → 6，8 号字是他在用的设置）');
    eq(ctl.max, '72', '字号上限 72（2.0.2.7：20 → 72）');
    eq(ctl.step, '1', '字号步长 1');
    includes(ctl.label, '字号', '输入框要挂在自己的字段里（label 带「字号」），实际 ' + JSON.stringify(ctl.label));

    /* 回落的依据必须是设置页里读到的真源（面板侧也照它夹一次） */
    const def = await opt.evaluate(() => {
      const d = window.KH && window.KH.Config && window.KH.Config.defaults && window.KH.Config.defaults.importantNote;
      return d ? d.fontSize : null;
    });
    eq(def, 11, '★ KH.Config.defaults.importantNote.fontSize 应为 11（越界/留空的回落值）');

    const readFS = () => opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['importantNote'], (r) => res((r.importantNote || {}).fontSize))));
    const shownFS = () => opt.evaluate(() => document.getElementById('pf-noteFontSize').value);
    const setFS = (v) => opt.evaluate((val) => {
      const el = document.getElementById('pf-noteFontSize');
      el.value = String(val);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    /* 写入是异步的（Store.patch → chrome.storage.local.set），轮询等它落地 */
    const waitFS = async (want) => {
      for (let i = 0; i < 15; i++) {
        const v = await readFS();
        if (v === want) return v;
        await opt.waitForTimeout(100);
      }
      return await readFS();
    };

    await setFS(14);
    eq(await waitFS(14), 14, '★ 填 14 必须真的写进 importantNote.fontSize（面板只认这个键）');

    await setFS(999);
    eq(await waitFS(11), 11, '越界值（999 > max 72）要回落到默认 11，不许把 999 写进去');
    eq(await shownFS(), '11', '越界后输入框自己也要被改写回 11，否则界面与存储不一致');

    await setFS('');
    eq(await waitFS(11), 11, '留空同样回落到默认 11（不许给面板塞 NaN）');

    /* 用户 2026-10-15 的原话是「我有的字号设置为 8，而范围最小是 10」⇒ 8 必须真的能存下来 */
    await setFS(8);
    eq(await waitFS(8), 8, '★ 8 号字必须能存（下限放到 6 就是为了它）');

    await setFS(6);
    eq(await waitFS(6), 6, '下限 6 是合法值，必须照写');

    await setFS(11);                              // 收尾：写回默认值，别把 10/14 留给后面的用例
    eq(await waitFS(11), 11, '收尾写回 11');
  });

  await test('★ 2.0.2.6 置顶排序：下拉框选词 → 胶囊展示 → 落盘是关键词 id', async () => {
    /* 需求② 的落地形态：**下拉框选择 + 胶囊展示**（2.0.2.5 是手填文本框，用户得自己敲分隔符）。
     * 落盘值也从"卡片文本"换成**关键词 id**：正则词的卡片文本是运行时命中的页面文本、罕见字的
     * 卡片文本就是那个生僻字，配置侧枚举不出来；「普通词 价格」与「组合词 价格×单价」的卡片文本
     * 都是「价格」，也只有 id 分得开。面板按 `meta.pinId`（= 规则 ruleId）匹配。 */
    const noteObj = () => opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['importantNote'], (r) => res(r.importantNote || {}))));
    const readPO = async () => (await noteObj()).pinOrder;
    const waitPO = async (want) => {
      for (let i = 0; i < 15; i++) {
        const v = await readPO();
        if (v === want) return v;
        await opt.waitForTimeout(100);
      }
      return await readPO();
    };
    const shape = await opt.evaluate(() => {
      const el = document.getElementById('pf-notePinOrder');
      if (!el) return null;
      const fld = el.closest('.kh-form-fld');
      const box = document.getElementById('pin-caps');
      const opts = Array.from(el.querySelectorAll('optgroup > option')).filter((o) => o.value && !o.disabled);
      return {
        tag: el.tagName, nCand: opts.length, label: (fld ? fld.textContent : '').trim(),
        caps: !!box, capCls: box ? box.className : ''
      };
    });
    truthy(shape, '★ 设置页「样式 → 重要笔记」要有 #pf-notePinOrder（没有它用户没法配置顶）');
    eq(shape.tag, 'SELECT', '★ 需求②：置顶排序必须是下拉框选择，实际 ' + shape.tag);
    includes(shape.label, '置顶', '字段标签要带「置顶」');
    truthy(shape.caps && shape.capCls.indexOf('kh-lbl-preview') >= 0,
      '胶囊容器 #pin-caps 复用既有的 .kh-lbl-preview 控件语言（不新造一套），实际 ' + JSON.stringify(shape.capCls));
    truthy(shape.nCand >= 2, '下拉里应至少 2 个可选关键词，实际 ' + shape.nCand);

    const pick = (i) => opt.evaluate((idx) => {
      const el = document.getElementById('pf-notePinOrder');
      const opts = Array.from(el.querySelectorAll('optgroup > option')).filter((o) => o.value && !o.disabled);
      const o = opts[idx];
      el.value = o.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { id: o.value, label: o.textContent.trim() };
    }, i);
    const caps = () => opt.evaluate(() => Array.from(document.querySelectorAll('#pin-caps .kh-lbl-chip')).map((c) => ({
      text: (c.querySelector('.kh-lbl-name') || c).textContent.trim(),
      hasDel: !!c.querySelector('.kh-lbl-del')
    })));
    const nCand = () => opt.evaluate(() => Array.from(document.querySelectorAll('#pf-notePinOrder optgroup > option')).filter((o) => o.value && !o.disabled).length);

    try {
      const a = await pick(0);
      eq(await waitPO(a.id), a.id, '★ 选中的关键词 id 必须进 importantNote.pinOrder（面板按 id 匹配），实际 ' + JSON.stringify(await readPO()));
      eq((await noteObj()).imgSize, 70, '★ 走嵌套子键保存，不许把同一层的 imgSize 冲掉（storage 只做一层合并）');
      const c1 = await caps();
      eq(c1.length, 1, '选一个词必须出现一个胶囊，实际 ' + JSON.stringify(c1));
      truthy(c1[0].hasDel, '胶囊上要有 ✕ 取消入口');
      truthy(c1[0].text.indexOf(a.label) >= 0, '胶囊上要显示那个关键词，实际 ' + JSON.stringify(c1[0].text));

      const b = await pick(0);
      eq(await waitPO(a.id + ', ' + b.id), a.id + ', ' + b.id, '★ 第二个词要落在末位（顺序 = 选择先后）');
      eq((await caps()).length, 2, '两个词两个胶囊');
      eq(await nCand(), shape.nCand - 2, '★ 已置顶的不再出现在候选里（同一个词只能占一个位次），实际 ' + (await nCand()) + ' / 原 ' + shape.nCand);

      await opt.evaluate(() => { const d = document.querySelector('#pin-caps .kh-lbl-chip .kh-lbl-del'); if (d) d.click(); });
      eq(await waitPO(b.id), b.id, '✕ 取消第一个后只剩另一个，实际 ' + JSON.stringify(await readPO()));
      eq((await caps()).length, 1, '取消一个只剩一个胶囊');
    } finally {
      /* 收尾走**界面**清空（直接改 storage 页面的 cfg 缓存是旧的，胶囊不会跟着消失） */
      for (let i = 0; i < 4; i++) {
        const done = await opt.evaluate(() => {
          const d = document.querySelector('#pin-caps .kh-lbl-del');
          if (!d) return true;
          d.click();
          return false;
        });
        if (done) break;
        await opt.waitForTimeout(150);
      }
      eq(await waitPO(''), '', '收尾：置顶排序清空');
    }
  });

  group('9. options · 关键词表格与筛选/批量', { aspects: ['ui'] });

  await test('★ 关键词表格 11 列顺序符合规格', async () => {
    const heads = await opt.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('#kw-table thead th, #kw-table th'));
      return ths.map(t => (t.textContent || '').trim());
    });
    console.log('        表头: ' + JSON.stringify(heads));
    truthy(heads.length >= 8, '表头应不少于 8 列，实际 ' + heads.length);
    const joined = heads.join('|');
    // 规格要求：关键词 → 核心词匹配 → 标题关键词 → 标题词匹配
    const iKw = heads.findIndex(h => /关键词$/.test(h));
    const iCore = heads.findIndex(h => /核心词匹配|核心匹配/.test(h));
    const iTitle = heads.findIndex(h => /标题关键词|标题词\(左格\)|左格/.test(h));
    const iTitleMatch = heads.findIndex(h => /标题词匹配/.test(h));
    truthy(iCore > iKw, '「核心词匹配」应在「关键词」右侧（列顺序）');
    truthy(iTitle > iCore, '「标题关键词」应在核心词匹配右侧');
    // 列名不该写死方向：这一列在上下格模式下也承载表头词（用户实测指出的表述问题）
    const titleHead = heads[iTitle] || '';
    truthy(!/左格|右格/.test(titleHead),
      '「标题关键词」列名不该写死（左格/右格），该列在上下格模式下也承载表头词，实际 ' + JSON.stringify(titleHead));
  });

  await test('★ 核心词匹配 / 标题词匹配是独立两列（不是区分胶囊）', async () => {
    const r = await opt.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('#kw-table th')).map(t => (t.textContent || '').trim());
      return { core: ths.filter(h => /核心词匹配|核心匹配/.test(h)).length, title: ths.filter(h => /标题词匹配/.test(h)).length };
    });
    eq(r.core, 1, '核心词匹配应恰好一列');
    eq(r.title, 1, '标题词匹配应恰好一列');
  });

  await test('★ 操作列只有 编辑/删除（复制已去掉），且按钮是胶囊', async () => {
    const r = await opt.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('#kw-table tbody .col-actions'));
      if (!cells.length) return null;
      const btns = Array.from(cells[0].querySelectorAll('button')).map((b) => {
        const cs = getComputedStyle(b);
        const rc = b.getBoundingClientRect();
        // 文字宽 vs 内容盒宽：判断有没有被压成"竖排"（曾经发生：按钮被 flex 压到 40px，两个字竖着排）
        const range = document.createRange();
        range.selectNodeContents(b);
        return {
          text: (b.textContent || '').trim(),
          radius: cs.borderTopLeftRadius,
          borderW: cs.borderTopWidth,
          bg: cs.backgroundColor,
          ws: cs.whiteSpace,
          h: Math.round(rc.height),
          top: Math.round(rc.top), w: Math.round(rc.width),
          textW: Math.round(range.getBoundingClientRect().width),
          inner: Math.round(b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
        };
      });
      const all = Array.from(document.querySelectorAll('#kw-table tbody .col-actions button'))
        .map((b) => (b.textContent || '').trim());
      return { first: btns, all: Array.from(new Set(all)), cellW: Math.round(cells[0].getBoundingClientRect().width) };
    });
    truthy(r, '应有 .col-actions 单元格');
    console.log('        操作列按钮: ' + JSON.stringify(r.first) + '  单元格宽 ' + r.cellW);
    eq(r.first.map((b) => b.text).join('/'), '编辑/删除',
      '操作列应只有 编辑/删除（v1.52.0 就是这两个，复制是 v2 多加的），实际 ' + JSON.stringify(r.first.map((b) => b.text)));
    falsy(r.all.some((t) => /复制/.test(t)), '整个操作列都不该再有「复制」，实际 ' + JSON.stringify(r.all));
    // 胶囊：圆角接近全圆 + 有边框（旧实现是无边框链接样式）
    r.first.forEach((b) => {
      truthy(parseFloat(b.radius) >= 999 || parseFloat(b.radius) >= b.h / 2,
        '操作按钮应是胶囊（圆角 ≥ 高度一半），实际 radius=' + b.radius + ' h=' + b.h);
      truthy(parseFloat(b.borderW) >= 1, '操作按钮应有边框（旧实现是无边框链接），实际 ' + b.borderW);
    });
    // ★ 两个按钮必须在**同一行**，且文字没被压成竖排
    truthy(Math.abs(r.first[0].top - r.first[1].top) <= 2,
      '「编辑」「删除」应在同一行，实际 top=' + r.first[0].top + '/' + r.first[1].top + '（操作列宽 ' + r.cellW + '）');
    r.first.forEach((b) => {
      eq(b.ws, 'nowrap', '操作按钮文字必须 nowrap（否则会被 flex 压成竖排），实际 ' + b.ws);
      truthy(b.textW <= b.inner + 1,
        '「' + b.text + '」文字被挤成竖排了：文字宽 ' + b.textW + ' > 可用 ' + b.inner + '（按钮作为 flex 子项被压缩）');
    });
  });

  await test('★ 状态胶囊文案为「启用 / 停用」（与 v1.52.0 口径一致）', async () => {
    const r = await opt.evaluate(() => {
      const pills = Array.from(document.querySelectorAll('#kw-table tbody .col-status .kh-switch-btn'))
        .map((b) => (b.textContent || '').trim());
      const opts = Array.from(document.querySelectorAll('#kw-filter-status option'))
        .map((o) => (o.textContent || '').trim());
      return { pills: Array.from(new Set(pills)), opts };
    });
    console.log('        状态胶囊: ' + JSON.stringify(r.pills) + ' / 筛选下拉: ' + JSON.stringify(r.opts));
    truthy(r.pills.length > 0, '应有状态胶囊');
    r.pills.forEach((t) => truthy(/^(启用|停用)$/.test(t), '状态胶囊文案应是「启用」或「停用」，实际 ' + JSON.stringify(t)));
    falsy(r.opts.some((t) => /已/.test(t)), '筛选下拉也应是同一套说法（不该出现「已启用/已停用」），实际 ' + JSON.stringify(r.opts));
  });

  await test('★ 高亮颜色列：两个颜色胶囊，点一个即可就地改色并落库', async () => {
    // ① 结构：与编辑弹窗同形 —— 两个胶囊（●底 / ●文），色点显示有效色
    const r = await opt.evaluate(() => {
      const cell = document.querySelector('#kw-table tbody .col-color');
      if (!cell) return null;
      const chips = Array.from(cell.querySelectorAll('.kh-color-chip')).map((c) => {
        const dot = c.querySelector('.kh-color-dot');
        const rc = c.getBoundingClientRect();
        return {
          text: (c.querySelector('.kh-fld-chip-t') || {}).textContent,
          hasDot: !!dot,
          dotBg: dot ? getComputedStyle(dot).backgroundColor : null,
          top: Math.round(rc.top), w: Math.round(rc.width), title: c.getAttribute('title') || ''
        };
      });
      const rowText = (document.querySelector('#kw-table tbody .col-kw .kh-kw-text') || {}).textContent || '';
      return { chips, rowText: rowText.trim() };
    });
    truthy(r, '应有 .col-color 单元格');
    console.log('        颜色胶囊: ' + JSON.stringify(r.chips));
    eq(r.chips.map((c) => c.text).join('/'), '底/文',
      '高亮颜色列应是两个胶囊（底/文，与编辑弹窗同形），实际 ' + JSON.stringify(r.chips.map((c) => c.text)));
    truthy(r.chips.every((c) => c.hasDot), '两个胶囊都要有色点（显示当前颜色 / 虚线圈＝未设色）');
    eq(r.chips[0].top, r.chips[1].top, '两个颜色胶囊应在同一行');
    truthy(r.chips.every((c) => c.title && /底|文/.test(c.title)), '胶囊要有 tooltip 说明（含继承关系）');

    // ② 点一下 → 弹出选色浮层（色板）
    await opt.click('#kw-table tbody .col-color .kh-color-chip');
    await opt.waitForTimeout(250);
    const pop = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      return p ? { grid: p.querySelectorAll('.kh-color-cell').length, hasPicker: !!p.querySelector('.kh-color-input'), hasClear: !!p.querySelector('.kh-color-clear') } : null;
    });
    truthy(pop && pop.grid > 0, '点颜色胶囊应弹出选色浮层（色板），实际 ' + JSON.stringify(pop));
    truthy(pop.hasPicker && pop.hasClear, '浮层要有原生取色器与「清除（＝继承）」，实际 ' + JSON.stringify(pop));

    // ③ 选一个色 → **只改草稿**（v1.99.99.11：用户要求加确认步骤，选中不等于生效）
    //   色值**不写死**：色板会按"合理/必备"持续调整，写死色值等于把这条测试变成色板快照测试
    const picked = await opt.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.kh-popover .kh-color-cell'));
      const c = cells[8] || cells[0];
      return c ? c.getAttribute('data-color') : null;
    });
    const bgOfRow = () => opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => String(x.text || '').trim() === t);
      return { found: !!k, bg: k ? k.bgColor : null, popGone: !document.querySelector('.kh-popover') };
    }, r.rowText);
    const before = await bgOfRow();
    truthy(picked, '浮层里应有色板格子');
    await opt.click('.kh-popover .kh-color-cell[data-color="' + picked + '"]');
    await opt.waitForTimeout(400);
    const drafted = await bgOfRow();
    const draftUi = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      if (!p) return null;
      const done = p.querySelector('.kh-color-ok');
      return {
        stillOpen: true,
        pending: (p.querySelector('.kh-color-pending') || {}).textContent || '',
        isPending: !!p.querySelector('.kh-color-pending.is-pending'),
        okEnabled: !!(done && !done.disabled)
      };
    });
    console.log('        选色草稿: ' + JSON.stringify(drafted) + ' / ' + JSON.stringify(draftUi) + '（选中 ' + picked + '）');
    eq(JSON.stringify(drafted.bg), JSON.stringify(before.bg), '**点色板只改草稿，不该立刻落库**（用户要求加确认步骤）');
    truthy(draftUi && draftUi.stillOpen, '点色板后浮层应仍开着（等用户确定）');
    truthy(draftUi.isPending && draftUi.okEnabled, '浮层应提示"已选但未生效"，且「确定」可用，实际 ' + JSON.stringify(draftUi));

    // ④ 点「确定」 → 落库 + 浮层收起
    await opt.click('.kh-popover .kh-color-ok');
    await opt.waitForTimeout(700);
    const saved = await bgOfRow();
    console.log('        确定后落库: ' + JSON.stringify(saved));
    truthy(saved.found, '应能在存储里找到第一行那个关键词：' + JSON.stringify(r.rowText));
    eq(saved.bg, picked, '点「确定」后才写入该关键词的 bgColor（就地改色）');
    truthy(saved.popGone, '确定后浮层应自动收起（否则会挡住下一行）');
  });

  await test('★ 组合方向用「标题关键词」列的前缀箭头区分（← 左格 / ↑ 表头）', async () => {
    const r = await opt.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#kw-table tbody tr'));
      const cells = rows.map((tr) => {
        const kwCell = tr.querySelector('.col-kw');
        const titleCell = tr.querySelector('.col-cell');
        const arrow = titleCell ? titleCell.querySelector('.kh-axis-arrow') : null;
        return {
          kw: kwCell ? (kwCell.textContent || '').trim() : '',
          title: titleCell ? (titleCell.textContent || '').trim() : '',
          arrow: arrow ? arrow.textContent : null,
          arrowTitle: arrow ? (arrow.getAttribute('title') || '') : '',
          tbTag: !!(kwCell && /上下格/.test(kwCell.textContent || ''))
        };
      });
      return { cells };
    });
    const arrows = Array.from(new Set(r.cells.map((c) => c.arrow).filter(Boolean)));
    console.log('        方向箭头: ' + JSON.stringify(arrows) + '  样例 ' +
      JSON.stringify(r.cells.filter((c) => c.arrow).slice(0, 3).map((c) => c.arrow + ' ' + c.title)));
    truthy(arrows.indexOf('←') >= 0, '左右格组合应显示 ← 前缀，实际 ' + JSON.stringify(arrows));
    truthy(arrows.indexOf('↑') >= 0, '上下格组合应显示 ↑ 前缀，实际 ' + JSON.stringify(arrows));
    truthy(r.cells.every((c) => !c.tbTag), '核心词列不该再有「上下格」标签（区分方式已挪到标题词列）');
    truthy(r.cells.filter((c) => c.arrow).every((c) => c.arrowTitle && c.arrowTitle.length > 6), '箭头要有 tooltip 说明方向含义');
    // 方向不同 → tooltip 不同（左右格 / 上下格各自说明）
    const tips = Array.from(new Set(r.cells.filter((c) => c.arrow).map((c) => c.arrowTitle)));
    truthy(tips.length >= 2, '两种方向的 tooltip 应不同，实际 ' + JSON.stringify(tips));
  });

  await test('筛选栏含排序下拉与批量导入按钮', async () => {
    const r = await opt.evaluate(() => ({
      sort: !!document.getElementById('kw-filter-sort'),
      batchImport: !!document.getElementById('btn-batch-import'),
      search: !!document.getElementById('kw-search')
    }));
    truthy(r.sort, '应有 #kw-filter-sort');
    truthy(r.batchImport, '应有 #btn-batch-import');
    truthy(r.search, '应有搜索框');
  });

  await test('批量栏是独立常驻一行，未勾选时按钮禁用', async () => {
    const r = await opt.evaluate(() => {
      const bar = document.getElementById('batch-bar');
      if (!bar) return null;
      const cs = getComputedStyle(bar);
      const btns = Array.from(bar.querySelectorAll('button')).map(b => ({ id: b.id, disabled: b.disabled, text: b.textContent.trim() }));
      return { display: cs.display, h: bar.getBoundingClientRect().height, btns, hasSelectPage: !!document.getElementById('batch-select-page') };
    });
    truthy(r, '应有 #batch-bar');
    truthy(r.h > 0, '批量栏应有高度（常驻一行）');
    truthy(r.hasSelectPage, '应有「本页全选」控件');
    const actionBtns = r.btns.filter(b => !/select-page|clear/.test(b.id));
    truthy(actionBtns.length > 0, '批量栏应有操作按钮');
    truthy(actionBtns.every(b => b.disabled), '未勾选时批量按钮应全部禁用，实际 ' + JSON.stringify(actionBtns));
  });

  await test('★ 批量弹窗与编辑弹窗同一套控件语言 + 四种批量操作真落库', async () => {
    // 先备份关键词，测完还原（批量会真的改数据）
    const backup = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res(r.keywords || []))));

    // 勾选本页全部 → 批量栏可用
    const sel = await opt.$('#batch-select-page');
    await sel.check();
    await opt.waitForTimeout(400);

    const openBatch = async (id) => {
      await opt.click('#' + id);
      await opt.waitForTimeout(450);
    };
    const closeDialog = async () => {
      await opt.keyboard.press('Escape');
      await opt.waitForTimeout(200);
      await opt.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.kh-modal .kh-btn')).find((x) => /取消/.test(x.textContent));
        if (b) b.click();
      });
      await opt.waitForTimeout(250);
    };
    /* 读当前弹窗/浮层里的控件形态（与 form-compare.js 同一口径） */
    const readControls = () => opt.evaluate(() => {
      const root = document.querySelector('.kh-modal') || document.querySelector('.kh-popover');
      if (!root) return null;
      const out = [];
      const seen = new Set();
      const push = (f) => {
        if (seen.has(f)) return; seen.add(f);
        if (f.matches('.kh-fld-chips')) { for (const ch of f.children) if (!ch.classList.contains('kh-chip-sep')) push(ch); return; }
        const ctrl = (f.classList.contains('kh-fld-chip')) ? (f.querySelector('input') || f)
          : f.querySelector('.kh-fld-chip, .kh-color-swatch, input, select, textarea, [contenteditable]');
        const chip = !!((f.classList.contains('kh-fld-chip')) || (ctrl && ctrl.classList.contains('kh-fld-chip')));
        const lab = f.querySelector('.kh-fld-chip-t, .kh-fld-label') || {};
        out.push({
          label: (lab.textContent || '').trim(),
          kind: chip ? (ctrl && ctrl.classList.contains('kh-color-chip') ? '颜色胶囊' : '开关胶囊')
            : ctrl ? (ctrl.tagName === 'SELECT' ? 'select' : ctrl.classList.contains('kh-color-swatch') ? '色块(旧)'
              : ctrl.tagName === 'INPUT' && ctrl.type === 'checkbox' ? '勾选框' : 'other') : '?',
          id: ctrl ? (ctrl.id || '') : '',
          forAttr: (f.querySelector('label[for]') || {}).htmlFor || ''
        });
      };
      for (const f of root.querySelectorAll('.kh-fld, .kh-fld-chips')) push(f);
      if (!out.length) for (const f of root.querySelectorAll('.kh-check, .kh-pop-row')) push(f);
      return out;
    });

    // ① 分组：select + id/for（旧实现是裸 select、没有 id）
    await openBatch('batch-group');
    const grp = await readControls();
    console.log('        批量分组: ' + JSON.stringify(grp));
    eq(grp.length, 1, '批量分组应只有一个字段，实际 ' + JSON.stringify(grp));
    eq(grp[0].kind, 'select', '批量分组应是 select');
    eq(grp[0].id, 'fld-b-groupId', '批量分组的控件应带 id（旧实现没有）');
    eq(grp[0].forAttr, 'fld-b-groupId', 'label 必须 for 到控件');
    await closeDialog();

    // ② 颜色：两个**颜色胶囊**（旧实现是旧色块），点开选色 → 保存 → 真落库
    await openBatch('batch-color');
    const col = await readControls();
    console.log('        批量颜色: ' + JSON.stringify(col));
    eq(col.map((c) => c.kind).join('/'), '颜色胶囊/颜色胶囊', '批量颜色应是两个颜色胶囊，实际 ' + JSON.stringify(col));
    eq(col.map((c) => c.label).join('/'), '底/文', '颜色胶囊文案应为 底/文');
    await opt.click('#fld-b-bgColor');
    await opt.waitForTimeout(300);
    const hasPalette = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      return !!(p && p.querySelector('.kh-color-cell'));
    });
    truthy(hasPalette, '点批量颜色胶囊应弹出选色浮层');
    // 同样不写死色值（色板可调）：取第 11 个格子（靛蓝档）的颜色
    const batchPick = await opt.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.kh-popover .kh-color-cell'));
      const c = cells[11] || cells[0];
      return c ? c.getAttribute('data-color') : null;
    });
    truthy(batchPick, '浮层里应有色板格子');
    await opt.click('.kh-popover .kh-color-cell[data-color="' + batchPick + '"]');
    await opt.waitForTimeout(250);
    /* v1.99.99.11：点色板只改草稿，必须点「确定」才落到控件上（再保存才落库） */
    await opt.click('.kh-popover .kh-color-ok');
    await opt.waitForTimeout(300);
    const popGone = await opt.evaluate(() => !document.querySelector('.kh-popover'));
    truthy(popGone, '点「确定」后选色浮层应收起');
    await opt.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.kh-modal .kh-btn')).find((x) => /保存/.test(x.textContent));
      if (b) b.click();
    });
    await opt.waitForTimeout(800);
    const savedColor = await opt.evaluate((c) => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res((r.keywords || []).filter((k) => k.bgColor === c).length))), batchPick);
    console.log('        批量颜色落库条数: ' + savedColor + '（选中 ' + batchPick + '）');
    truthy(savedColor >= 2, '批量设色应写入多条关键词的 bgColor，实际 ' + savedColor);

    // ③ 匹配：6 个**开关胶囊**，文案必须与 chip.js 单一来源一致（旧实现是"区分大小写/整词"）
    await openBatch('batch-match');
    const mat = await readControls();
    console.log('        批量匹配: ' + JSON.stringify(mat.map((m) => m.label)));
    eq(mat.length, 6, '批量匹配应是 6 个开关，实际 ' + mat.length);
    truthy(mat.every((m) => m.kind === '开关胶囊'), '批量匹配应是开关胶囊（旧实现是真勾选框），实际 ' + JSON.stringify(mat));
    eq(mat.slice(0, 3).map((m) => m.label).join('/'), '正则/Aa/全词', '核心词三项文案必须与匹配胶囊同源，实际 ' + JSON.stringify(mat.slice(0, 3).map((m) => m.label)));
    eq(mat.slice(3).map((m) => m.label).join('/'), '正则/Aa/全词', '标题词三项文案同样必须同源，实际 ' + JSON.stringify(mat.slice(3).map((m) => m.label)));
    truthy(mat.every((m) => /^fld-b-/.test(m.id)), '每个开关都要有 id，实际 ' + JSON.stringify(mat.map((m) => m.id)));
    // 点一下核心词「Aa」→ 应用 → 该开关应真的写进已选关键词
    await opt.click('label.kh-fld-chip[for="fld-b-caseSensitive"]');
    await opt.waitForTimeout(200);
    await opt.click('.kh-popover .kh-pop-apply');
    await opt.waitForTimeout(800);
    const savedCase = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => res((r.keywords || []).filter((k) => k.caseSensitive === true).length))));
    console.log('        批量匹配落库条数: ' + savedCase);
    truthy(savedCase >= 2, '批量开启「Aa」应写入多条关键词，实际 ' + savedCase);

    // ④ 备注 / 重要笔记：开关胶囊 + 富文本（旧实现是 .kh-check 勾选框）
    await openBatch('batch-note');
    const note = await readControls();
    console.log('        批量备注: ' + JSON.stringify(note));
    eq(note.filter((n) => n.kind === '开关胶囊').map((n) => n.label).join('/'), '备注/重要笔记',
      '批量备注的开关应是胶囊，实际 ' + JSON.stringify(note.map((n) => n.label + ':' + n.kind)));
    truthy(note.every((n) => n.kind !== '勾选框'), '批量备注不该再出现真勾选框');
    truthy(note.every((n) => !n.forAttr || /^fld-b-/.test(n.forAttr)), 'label 的 for 必须指向本弹窗的控件');
    await closeDialog();

    // 还原数据
    await opt.evaluate((kw) => new Promise((res) => chrome.storage.local.set({ keywords: kw }, res)), backup);
    await opt.waitForTimeout(400);
  });

  await test('★ 其余表单也统一：高亮样式 / 备注卡片样式 / 站点规则弹窗', async () => {
    // ① 高亮样式：全局默认色应是**颜色胶囊**（旧实现是色块）
    await opt.click('.kh-tab[data-tab="style"]');
    await opt.waitForTimeout(350);
    const hl = await opt.evaluate(() => Array.from(document.querySelectorAll('#hl-bg .kh-color-chip, #hl-fg .kh-color-chip')).map((c) => (c.querySelector('.kh-fld-chip-t') || {}).textContent));
    console.log('        高亮样式颜色控件: ' + JSON.stringify(hl));
    eq(hl.join('/'), '底/文', '高亮样式的两个颜色应是胶囊（底/文），实际 ' + JSON.stringify(hl));

    // ② 备注卡片样式：三个颜色是胶囊，九个字段都要有 id（旧实现手写、全无 id）
    //    （高亮与备注卡片现在同属「样式」分区，不用再切标签）
    const nc = await opt.evaluate(() => {
      const box = document.getElementById('nc-fields');
      const chips = Array.from(box.querySelectorAll('.kh-color-chip')).map((c) => (c.querySelector('.kh-fld-chip-t') || {}).textContent);
      const fields = Array.from(box.querySelectorAll('.kh-fld')).map((f) => {
        const ctrl = f.querySelector('input, select, textarea, [id]');
        const lab = f.querySelector('label.kh-fld-label');
        return { label: lab ? lab.textContent : '', id: ctrl ? ctrl.id : '', forAttr: lab ? lab.htmlFor : '' };
      });
      return { chips, fields };
    });
    console.log('        备注卡片样式: 胶囊 ' + JSON.stringify(nc.chips) + ' 字段 ' + nc.fields.length + ' 个');
    eq(nc.chips.join('/'), '底/文/框', '备注卡片样式的三个颜色应是胶囊，实际 ' + JSON.stringify(nc.chips));
    // 3 个颜色胶囊（在 .kh-fld-chips 里）+ 6 个文本字段 = 9 项
    eq(nc.fields.length + nc.chips.length, 9, '备注卡片样式应有 9 个字段（3 色 + 6 文本），实际 ' +
      (nc.fields.length + nc.chips.length));
    nc.fields.forEach((f) => {
      truthy(/^fld-nc-/.test(f.id), '字段「' + f.label + '」应有 id=fld-nc-<key>，实际 ' + JSON.stringify(f.id));
      eq(f.forAttr, f.id, '字段「' + f.label + '」的 label 必须 for 到控件');
    });

    // ③ 站点规则弹窗：走共享工厂（id=fld-sr-*），且下拉文案与列表展示同源
    await opt.click('.kh-tab[data-tab="sites"]');
    await opt.waitForTimeout(350);
    await opt.click('#btn-site-add');
    await opt.waitForTimeout(450);
    const sr = await opt.evaluate(() => {
      const modal = document.querySelector('.kh-modal');
      if (!modal) return null;
      const fields = Array.from(modal.querySelectorAll('.kh-fld')).map((f) => {
        const ctrl = f.querySelector('input, select, textarea');
        const lab = f.querySelector('label.kh-fld-label');
        return { label: lab ? lab.textContent : '', id: ctrl ? ctrl.id : '', forAttr: lab ? lab.htmlFor : '', tag: ctrl ? ctrl.tagName : '' };
      });
      const mt = Array.from(modal.querySelectorAll('#fld-sr-matchType option')).map((o) => o.textContent);
      return { fields, mt };
    });
    truthy(sr, '站点规则弹窗应能打开');
    console.log('        站点规则弹窗: ' + JSON.stringify(sr.fields.map((f) => f.label)) + ' 匹配方式选项 ' + JSON.stringify(sr.mt));
    eq(sr.fields.map((f) => f.label).join('/'), '规则类型/匹配对象/匹配方式/站点 / 网址 *',
      '站点规则弹窗字段与顺序应符合规格，实际 ' + JSON.stringify(sr.fields.map((f) => f.label)));
    sr.fields.forEach((f) => {
      truthy(/^fld-sr-/.test(f.id), '字段「' + f.label + '」应有 id=fld-sr-<key>（旧实现全无 id），实际 ' + JSON.stringify(f.id));
      eq(f.forAttr, f.id, '字段「' + f.label + '」的 label 必须 for 到控件');
    });
    includes(sr.mt.join('/'), '含子域名', '匹配方式选项应与列表展示同源（含子域名，而不是旧弹窗里的"含子域"）');
    // 保存往返
    await opt.fill('#fld-sr-pattern', 'e2e.example.com');
    await opt.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.kh-modal .kh-btn')).find((x) => /保存/.test(x.textContent));
      if (b) b.click();
    });
    await opt.waitForTimeout(700);
    const savedRule = await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['siteRules'], (r) => res((r.siteRules || []).some((x) => x.pattern === 'e2e.example.com')))));
    truthy(savedRule, '站点规则应能保存落库');
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['siteRules'], (r) => {
      chrome.storage.local.set({ siteRules: (r.siteRules || []).filter((x) => x.pattern !== 'e2e.example.com') }, res);
    })));
    await opt.waitForTimeout(300);
    // 回到「关键词管理」分区：用例之间要还原视图状态，否则后面的用例点不到这一区的按钮
    await opt.click('.kh-tab[data-tab="keywords"]');
    await opt.waitForTimeout(300);
  });

  /* ------------------------------------------- 9b. 色板与取色器（用户实测两条） */
  group('9b. options · 色板 5×4 与可拖动取色器', { aspects: ['ui'] });

  /** 从"干净状态"打开取色浮层：先 Esc 关掉可能还开着的浮层 + 松开可能还按着的左键。
   *  （拖动类用例失败时鼠标可能停在按下状态，不清理会让**后续用例**连带超时，
   *   把 1 个真失败放大成 2~3 个假失败。） */
  const openPicker = async () => {
    await opt.keyboard.press('Escape');
    await opt.mouse.up();
    await opt.waitForTimeout(120);
    await opt.click('#kw-table tbody .col-color .kh-color-chip');
    await opt.waitForTimeout(250);
  };

  await test('★ 色板：5 列 × 4 行 = 20 色，含纯黑与纯白（旧色板连黑色都没有）', async () => {
    await openPicker();
    const r = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      if (!p) return null;
      const cells = Array.from(p.querySelectorAll('.kh-color-cell'));
      return {
        n: cells.length,
        xs: Array.from(new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left)))),
        ys: Array.from(new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)))),
        hexes: cells.map((c) => c.getAttribute('data-color')),
        names: cells.map((c) => c.getAttribute('data-name')),
        // 每个格子都必须真的画出了颜色（白格也要有边框，不能看不见）
        painted: cells.filter((c) => {
          const cs = getComputedStyle(c);
          return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none';
        }).length,
        bordered: !!p.querySelector('.kh-color-cell[data-color="#ffffff"]')
          && getComputedStyle(p.querySelector('.kh-color-cell[data-color="#ffffff"]')).borderTopWidth !== '0px'
      };
    });
    truthy(r, '点颜色胶囊应弹出选色浮层');
    console.log('        色板: ' + r.n + ' 色 · ' + r.xs.length + ' 列 × ' + r.ys.length + ' 行');
    eq(r.n, 20, '色板应是 20 色（5 列 × 4 行），实际 ' + r.n);
    eq(r.xs.length, 5, '应排成 5 列，实际 ' + r.xs.length + ' 列');
    eq(r.ys.length, 4, '应排成 4 行，实际 ' + r.ys.length + ' 行');
    eq(r.painted, 20, '每个色块都要真画出颜色，实际 ' + r.painted);
    truthy(r.hexes.indexOf('#000000') >= 0, '色板必须有纯黑');
    truthy(r.hexes.indexOf('#ffffff') >= 0, '色板必须有纯白');
    truthy(r.bordered, '白块必须带边框（否则在白色卡片上看不见）');
    eq(new Set(r.hexes).size, 20, '色板不得有重复色值');
    truthy(r.names.every((n) => n && n.length >= 2), '每个色都要有中文名（tooltip）：' + JSON.stringify(r.names));
    console.log('        色名: ' + JSON.stringify(r.names.slice(0, 5)) + ' …');
    await shot(opt, '19-color-palette');
  });

  await test('★ 取色器：拖色相条换色相、拖浓淡区到底＝纯黑；**松手不落库，点「确定」才生效**', async () => {
    const rowText = await opt.evaluate(() => ((document.querySelector('#kw-table tbody .col-kw .kh-kw-text') || {}).textContent || '').trim());
    const bgOf = () => opt.evaluate((t) => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => {
      const k = (r.keywords || []).find((x) => String(x.text || '').trim() === t);
      res(k ? (k.bgColor || '') : null);
    })), rowText);
    const hexNow = () => opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      return p ? (p.querySelector('.kh-color-hex') || {}).value : null;
    });
    const hueOf = (hex) => opt.evaluate((h) => {
      const c = window.KH.ui.ColorField.hex2hsv(h);
      return Math.round(c.h);
    }, hex);

    await openPicker();
    const box = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      const hue = p.querySelector('.kh-color-hue');
      const sv = p.querySelector('.kh-color-sv');
      const rh = hue.getBoundingClientRect(), rs = sv.getBoundingClientRect();
      return {
        hue: { l: rh.left, t: rh.top, w: rh.width, h: rh.height },
        sv: { l: rs.left, t: rs.top, w: rs.width, h: rs.height },
        hasPicker: !!hue && !!sv && rh.width > 40 && rs.height > 40
      };
    });
    truthy(box.hasPicker, '浮层里应有可拖动的取色器（色相条 + 浓淡明暗区）');

    // ① 拖色相条：色相必须真的变；**拖动中与松手后都不落库**，点「确定」才落库
    const before = await hexNow();
    const beforeH = await hueOf(before);
    const storedBefore = await bgOf();
    await opt.mouse.move(box.hue.l + box.hue.w * 0.10, box.hue.t + box.hue.h / 2);
    await opt.mouse.down();
    await opt.mouse.move(box.hue.l + box.hue.w * 0.85, box.hue.t + box.hue.h / 2, { steps: 8 });
    await opt.waitForTimeout(150);
    const dragHex = await hexNow();
    const dragStored = await bgOf();
    console.log('        拖色相条: ' + before + '(h=' + beforeH + ') → 拖动中 ' + dragHex + ' · 存储 ' + JSON.stringify(dragStored));
    truthy(dragHex && dragHex !== before, '拖色相条应实时改变色值，' + before + ' → ' + dragHex);
    truthy(Math.abs((await hueOf(dragHex)) - beforeH) > 30, '色相应明显改变（不是只动了明暗）');
    falsy(dragStored === dragHex, '拖动过程中不得落库（草稿≠生效）');
    await opt.mouse.up();
    await opt.waitForTimeout(250);
    eq(await bgOf(), storedBefore, '**松手也不该落库**（用户要求加确认步骤，松手立即生效不符合习惯）');
    truthy(await opt.evaluate(() => !!document.querySelector('.kh-popover')), '松手后浮层应仍开着，等用户确定');
    const pend = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      const box2 = p.querySelector('.kh-color-pending');
      return { text: (box2 || {}).textContent || '', isPending: !!(box2 && box2.classList.contains('is-pending')), okEnabled: !!(p.querySelector('.kh-color-ok') && !p.querySelector('.kh-color-ok').disabled) };
    });
    console.log('        草稿提示: ' + JSON.stringify(pend));
    truthy(pend.isPending && pend.okEnabled, '松手后应提示"已选未生效"且「确定」可用，实际 ' + JSON.stringify(pend));
    await opt.click('.kh-popover .kh-color-ok');
    await opt.waitForTimeout(400);
    eq(await bgOf(), dragHex, '点「确定」后才把草稿落库');
    truthy(await opt.evaluate(() => !document.querySelector('.kh-popover')), '确定后浮层应收起');

    // ② 拖浓淡区到底部 → 纯黑（旧色板里根本选不到黑色）
    await openPicker();
    const box2 = await opt.evaluate(() => {
      const rs = document.querySelector('.kh-popover .kh-color-sv').getBoundingClientRect();
      return { l: rs.left, t: rs.top, w: rs.width, h: rs.height };
    });
    await opt.mouse.move(box2.l + box2.w * 0.5, box2.t + box2.h * 0.5);
    await opt.mouse.down();
    await opt.mouse.move(box2.l + box2.w * 0.5, box2.t + box2.h - 1, { steps: 6 });
    await opt.waitForTimeout(150);
    const midDragHex = await hexNow();
    const midDragStored = await bgOf();
    console.log('        拖动中（未松手）: 取色器=' + midDragHex + ' 存储=' + JSON.stringify(midDragStored));
    eq(midDragHex, '#000000', '拖到浓淡区最底部应是纯黑，实际 ' + midDragHex);
    falsy(midDragStored === '#000000', '拖动过程中不得落库（一次拖动会写几十次 storage）');
    await opt.mouse.up();
    await opt.waitForTimeout(250);
    falsy((await bgOf()) === '#000000', '松手不落库（要等「确定」）');
    await opt.click('.kh-popover .kh-color-ok');
    await opt.waitForTimeout(400);
    eq(await bgOf(), '#000000', '点「确定」后应把纯黑落库');
    await shot(opt, '19b-color-picker');
  });

  await test('★ 色值输入回车＝确定；「清除」也要确定；「取消」丢弃草稿', async () => {
    const rowText = await opt.evaluate(() => ((document.querySelector('#kw-table tbody .col-kw .kh-kw-text') || {}).textContent || '').trim());
    const bgOf = () => opt.evaluate((t) => new Promise((res) => chrome.storage.local.get(['keywords'], (r) => {
      const k = (r.keywords || []).find((x) => String(x.text || '').trim() === t);
      res(k ? (k.bgColor || '') : null);
    })), rowText);

    await openPicker();
    await opt.fill('.kh-popover .kh-color-hex', '#123456');
    await opt.press('.kh-popover .kh-color-hex', 'Enter');
    await opt.waitForTimeout(400);
    console.log('        色值输入回车后落库: ' + JSON.stringify(await bgOf()));
    eq(await bgOf(), '#123456', '色值输入框回车＝确定，应落库该色值');
    truthy(await opt.evaluate(() => !document.querySelector('.kh-popover')), '回车确定后浮层应收起');

    /* 「清除」也只改草稿：点完必须再点「确定」才落库（四条入口统一） */
    await openPicker();
    await opt.click('.kh-popover .kh-color-clear');
    await opt.waitForTimeout(250);
    eq(await bgOf(), '#123456', '「清除」只改草稿，未确定前不该落库');
    await opt.click('.kh-popover .kh-color-ok');
    await opt.waitForTimeout(400);
    eq(await bgOf(), '', '「清除」+「确定」应落库空值（＝继承分组/全局默认色）');
    truthy(await opt.evaluate(() => !document.querySelector('.kh-popover')), '确定后浮层应收起');

    /* 「取消」：草稿丢弃、原值不变 */
    await openPicker();
    await opt.click('.kh-popover .kh-color-cell[data-color="#e53935"]');
    await opt.waitForTimeout(200);
    await opt.click('.kh-popover .kh-color-btn');      // 第一个 .kh-color-btn 就是「取消」
    await opt.waitForTimeout(300);
    eq(await bgOf(), '', '「取消」应丢弃草稿，存储保持原值（＝继承）');
    truthy(await opt.evaluate(() => !document.querySelector('.kh-popover')), '取消后浮层应收起');
    const dotBack = await opt.evaluate(() => {
      const chip = document.querySelector('#kw-table tbody .col-color .kh-color-chip');
      const dot = chip && chip.querySelector('.kh-color-dot');
      return dot ? getComputedStyle(dot).backgroundColor : null;
    });
    console.log('        取消后色点: ' + dotBack + '（应回到"继承来的有效色"，不是草稿色）');
    truthy(dotBack && dotBack !== 'rgb(229, 57, 53)', '取消后色点不该留着草稿色（应还原成生效色）');
  });

  group('10. options · 编辑弹窗与保存往返', { aspects: ['ui'] });

  await test('★ 添加按钮在当前页直接弹编辑弹窗（不跳设置页）', async () => {
    const urlBefore = opt.url();
    await opt.click('#btn-kw-add');
    await opt.waitForTimeout(500);
    const modal = await opt.evaluate(() => {
      const m = document.querySelector('.kh-modal, .kh-editor');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      const foot = document.querySelector('.kh-modal__foot, .kh-editor-foot, .kh-modal-foot');
      const body = document.querySelector('.kh-modal__body, .kh-editor-body');
      return {
        exists: true, w: r.width, h: r.height,
        hasFoot: !!foot,
        footTop: foot ? foot.getBoundingClientRect().top : null,
        bodyScrollH: body ? body.scrollHeight : null,
        bodyClientH: body ? body.clientHeight : null,
        sections: Array.from(document.querySelectorAll('.kh-editor-sec')).map(s => s.getAttribute('data-sec') || s.textContent.slice(0, 8))
      };
    });
    truthy(modal, '应弹出编辑弹窗');
    eq(opt.url(), urlBefore, '弹窗必须在当前页弹出，URL 不应变化');
    truthy(modal.hasFoot, '应有底部按钮区');
    console.log('        分区: ' + JSON.stringify(modal.sections));
    await shot(opt, '10-editor-modal');
  });

  await test('★ 编辑弹窗分区可折叠', async () => {
    const before = await opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="imp"]');
      if (!sec) return null;
      const body = sec.querySelector('.kh-editor-sec-body');
      return { h: body ? body.getBoundingClientRect().height : null };
    });
    truthy(before && before.h > 0, '重要笔记分区初始应展开，实际 ' + JSON.stringify(before));
    await opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="imp"]');
      const head = sec.querySelector('.kh-editor-sec-head');
      head.click();
    });
    await opt.waitForTimeout(250);
    const after = await opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="imp"]');
      const body = sec.querySelector('.kh-editor-sec-body');
      return { h: body ? body.getBoundingClientRect().height : null, hidden: body ? getComputedStyle(body).display === 'none' || body.offsetParent === null : null };
    });
    truthy(after.hidden || (after.h !== null && after.h < before.h), '点击分区头应收起，前 ' + JSON.stringify(before) + ' 后 ' + JSON.stringify(after));
    // 再展开，方便后续用例
    await opt.evaluate(() => document.querySelector('.kh-editor-sec[data-sec="imp"] .kh-editor-sec-head').click());
    await opt.waitForTimeout(200);
  });

  await test('★ 富文本工具栏：在编辑框上方、单行不折行、图标都带 title', async () => {
    const r = await opt.evaluate(() => {
      const ed = document.querySelector('.kh-rt-editor.kh-rt-wysiwyg');
      if (!ed) return null;
      const bar = ed.querySelector('.kh-rt-toolbar');
      const rte = ed.querySelector('.kh-rte');
      if (!bar || !rte) return null;
      const btns = Array.from(bar.querySelectorAll('button'));
      return {
        kids: Array.from(ed.children).map(n => n.className),
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        rteTop: Math.round(rte.getBoundingClientRect().top),
        barW: Math.round(bar.getBoundingClientRect().width),
        rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
        labels: btns.map(b => (b.textContent || '').trim()),
        titles: btns.map(b => b.getAttribute('title') || ''),
        aria: btns.map(b => b.getAttribute('aria-label') || '')
      };
    });
    truthy(r, '应存在富文本（所见即所得）编辑器');
    console.log('        工具栏 ' + JSON.stringify(r.labels) + ' 宽 ' + r.barW + ' 占 ' + r.rows + ' 行');
    // ① 位置：工具在上、内容在下（大众习惯）。旧版在下方，实测被挤成两行
    truthy(r.barBottom <= r.rteTop, '工具栏必须在编辑框上方，实际 bar.bottom=' + r.barBottom + ' rte.top=' + r.rteTop);
    // ② 单行：旧版 6 个带字按钮共 324px > 245px 容器 → 折两行
    eq(r.rows, 1, '工具栏必须单行不折行，实际占 ' + r.rows + ' 行');
    // ③ 图标按钮必须带中文提示（否则纯图标不可读）
    r.titles.forEach((t, i) => truthy(t, '第 ' + (i + 1) + ' 个按钮缺少 title：' + JSON.stringify(r.labels[i])));
    r.aria.forEach((t, i) => truthy(t, '第 ' + (i + 1) + ' 个按钮缺少 aria-label：' + JSON.stringify(r.labels[i])));
    // ④ 第一节应是编辑区，最后不是工具栏（顺序契约）
    truthy(/kh-rt-toolbar/.test(r.kids[0]), '工具栏应是编辑器的第一个子元素，实际 ' + JSON.stringify(r.kids));
    await shot(opt, '10b-editor-richtext');
  });

  await test('★ 弹窗分区按列紧凑打包：列内首尾相接（无空洞）', async () => {
    const r = await opt.evaluate(() => {
      const cols = Array.from(document.querySelectorAll('.kh-editor-col'));
      return cols.map((c) => Array.from(c.querySelectorAll('.kh-editor-sec')).map((s) => {
        const b = s.getBoundingClientRect();
        return {
          t: (s.querySelector('.kh-editor-sec-title') || {}).textContent,
          top: Math.round(b.top), bottom: Math.round(b.bottom)
        };
      }));
    });
    eq(r.length, 3, '规格 §5.2.2 只允许 3 个分区（基本信息 / 单元格组合 / 重要笔记），实际 ' + r.length + ' 列');
    console.log('        分列: ' + JSON.stringify(r.map((c) => c.map((x) => x.t))));
    r.forEach((cards, ci) => {
      // 列内必须首尾相接：旧实现是逐行栅格，一行里最高的卡片决定行高，
      // 矮卡片下面会留一大块空洞（实测 184px），这里就是那条的回归护栏。
      for (let i = 1; i < cards.length; i++) {
        const gap = cards[i].top - cards[i - 1].bottom;
        truthy(gap >= 0 && gap <= 16,
          '第 ' + (ci + 1) + ' 列「' + cards[i - 1].t + '」到「' + cards[i].t + '」之间出现 ' + gap + 'px 空洞（列内应首尾相接）');
      }
    });
  });

  await test('★ 匹配规则/组合方向/颜色字段的紧凑布局（用户三项要求）', async () => {
    // 几何断言：等弹窗完成一次布局再量（曾偶发一次量在布局未稳时报假红）
    await opt.waitForTimeout(250);
    const r = await opt.evaluate(() => {
      const sec = (id) => document.querySelector('.kh-editor-sec[data-sec="' + id + '"]');
      /* 按**胶囊行**取，而不是把整节胶囊一锅端 —— 基本信息里「启用」也是胶囊，
       * 要比较的是"匹配规则那三个开关"（它们是该节的第一行胶囊）。 */
      const chipRows = (id) => Array.from(sec(id).querySelectorAll('.kh-fld-chips'))
        .map((row) => Array.from(row.querySelectorAll('.kh-fld-chip'))
          .map((c) => (c.querySelector('.kh-fld-chip-t') || {}).textContent));
      const lastRow = (id) => { const r = chipRows(id); return r[r.length - 1] || []; };
      /* 基本信息里的胶囊**都在同一个胶囊行容器**里**（匹配三个 + 颜色两个，装不下自动折第二行）——
       * 所以按 y 分行来判断"颜色是否在匹配规则下面"。 */
      const basicChips = Array.from(sec('basic').querySelectorAll('.kh-fld-chips .kh-fld-chip')).map((c) => ({
        text: (c.querySelector('.kh-fld-chip-t') || {}).textContent,
        top: Math.round(c.getBoundingClientRect().top)
      }));
      const box = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const fld = (key) => document.getElementById('fld-' + key).closest('.kh-fld, .kh-fld-chip, .kh-fld-chips');
      const rowTops = {};
      basicChips.forEach((c) => { (rowTops[c.top] = rowTops[c.top] || []).push(c.text); });
      // 胶囊左边界（用来量"颜色组前面是否留了更大间距"）
      const chipLefts = Array.from(sec('basic').querySelectorAll('.kh-fld-chips .kh-fld-chip')).map((c) => ({
        text: (c.querySelector('.kh-fld-chip-t') || {}).textContent,
        l: Math.round(c.getBoundingClientRect().left),
        w: Math.round(c.getBoundingClientRect().width)
      }));
      return {
        basicChips,
        chipLefts,
        basicChipLines: Object.keys(rowTops).sort((a, b) => a - b).map((k) => rowTops[k]),
        titleChips: lastRow('combo'),
        secIds: Array.from(document.querySelectorAll('.kh-editor-sec')).map((s) => s.getAttribute('data-sec')),
        // 三个匹配开关都应紧跟在「关键词」输入框之后（同一张卡片内，且在上方）
        chipAboveNote: (() => {
          const t = document.getElementById('fld-text').closest('.kh-fld').getBoundingClientRect().top;
          const c = sec('basic').querySelector('.kh-fld-chips').getBoundingClientRect().top;
          const n = document.getElementById('fld-note').closest('.kh-fld').getBoundingClientRect().top;
          return t < c && c < n;
        })(),
        coreChipTops: Array.from(sec('basic').querySelector('.kh-fld-chips').querySelectorAll('.kh-fld-chip')).map((c) => Math.round(c.getBoundingClientRect().top)),
        titlePair: { verify: box(fld('cellVerify')), axis: box(fld('comboAxis')) },
        colors: [box(fld('bgColor')), box(fld('textColor'))],
        // 颜色现在是**胶囊**（`● 底色`），标签在胶囊内部（不再有 label[for]）
        colorLabels: ['fld-bgColor', 'fld-textColor'].map((k) => {
          const el = document.getElementById(k);
          const t = el && el.querySelector('.kh-fld-chip-t');
          return t ? t.textContent : '';
        }),
        colorDots: ['fld-bgColor', 'fld-textColor'].map((k) => !!document.querySelector('#' + k + ' .kh-color-dot')),
        /* 【2.0.2.11 票 #64】底色 / 尺寸 / 字号 已搬进重要笔记工具栏，与 B/I/链接/图片/表格同一行。
         * 判据因此从"标签与输入框同行"改成"住在 .kh-rt-toolbar 里、与 B 按钮同心、可见且不裁切"。 */
        noteTools: (() => {
          const ed = document.getElementById('fld-importantNote');
          const bar = ed && ed.closest('.kh-rt-editor') ? ed.closest('.kh-rt-editor').querySelector('.kh-rt-toolbar') : null;
          if (!bar) return null;
          const bBtn = bar.querySelector('button');
          const bb = bBtn && bBtn.getBoundingClientRect();
          const bc = bb ? (bb.top + bb.bottom) / 2 : 0;
          const list = ['impNoteUseHlColor', 'imgSize', 'noteFontSize'].map((k) => {
            const inp = document.getElementById('fld-' + k);
            const host = inp && inp.closest('.kh-tool-field');
            const btn = host && host.querySelector('.kh-tool-toggle, .kh-num-btn');
            if (!btn) return { key: k, missing: true };
            const b = btn.getBoundingClientRect();
            return {
              key: k,
              text: (btn.textContent || '').trim(),
              inBar: bar.contains(host),
              center: Math.round((b.top + b.bottom) / 2),
              h: Math.round(host.getBoundingClientRect().height),
              w: Math.round(b.width),
              clipped: btn.scrollWidth > btn.clientWidth + 1
            };
          });
          return { bc: Math.round(bc), list: list };
        })(),
        // 「抓取后续字段」必须在**自己的分区**里（普通词也能抓取 → 不该挂在单元格组合下）
        fetchOwnSec: (() => {
          const secs = Array.from(document.querySelectorAll('.kh-editor-sec'));
          const host = secs.find((s) => s.querySelector('#fld-fetchLabels'));
          return host ? host.getAttribute('data-sec') : null;
        })(),
        // 关键词与分组：同一行、分左右两列（"分组跟在关键词后面"，与 标题词|组合方向 同一手法）
        keywordAndGroup: { text: box(fld('text')), group: box(fld('groupId')) },
        // 两组胶囊之间的竖线分隔
        chipSep: (() => {
          const el = document.querySelector('.kh-editor-sec[data-sec="basic"] .kh-chip-sep');
          return el ? box(el) : null;
        })(),
        // 富文本编辑框：可拖动加高？提示行删了没？
        rte: (() => {
          const el = document.querySelector('.kh-rte');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { resize: cs.resize, maxH: cs.maxHeight, minH: cs.minHeight, overflowY: cs.overflowY };
        })(),
        tipGone: !document.querySelector('.kh-rt-wysiwyg .kh-rule-hint'),
        // 「启用」应渲染在**分区标题行右侧**，不占正文一行
        enableInHead: (() => {
          const chip = document.getElementById('fld-enabled');
          if (!chip) return null;
          const extra = chip.closest('.kh-editor-sec-extra');
          const body = chip.closest('.kh-editor-sec-body');
          const headBtn = document.querySelector('.kh-editor-sec[data-sec="basic"] .kh-editor-sec-head');
          return { inExtra: !!extra, inBody: !!body, inHeadBtn: !!(headBtn && headBtn.contains(chip)) };
        })(),
        // 「预览」按钮应与「备注」标题同一行
        noteToolsSameRow: (() => {
          const lab = document.querySelector('label[for="fld-note"]');
          const row = lab && lab.closest('.kh-fld-labelrow');
          const btn = row && row.querySelector('button');
          if (!row || !btn) return false;
          return Math.abs(row.getBoundingClientRect().top - lab.getBoundingClientRect().top) < 20 &&
            btn.getBoundingClientRect().top < lab.getBoundingClientRect().bottom;
        })(),
        modalH: Math.round(document.querySelector('.kh-modal').getBoundingClientRect().height),
        // 胶囊**不该显示勾选框**，开关状态只用颜色区分（用户实测要求）
        chipVisual: (() => {
          const on = document.getElementById('fld-enabled');            // 新建时默认勾选
          const off = document.getElementById('fld-cellVerifyEnabled'); // 新建时默认不勾选
          if (!on || !off) return null;
          const onChip = on.closest('.kh-fld-chip'), offChip = off.closest('.kh-fld-chip');
          const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
          const bd = (el) => (el ? getComputedStyle(el).borderTopColor : null);
          return {
            onBoxW: Math.round(on.getBoundingClientRect().width),
            offBoxW: Math.round(off.getBoundingClientRect().width),
            onChecked: !!on.checked, offChecked: !!off.checked,
            onIsOn: !!(onChip && onChip.classList.contains('is-on')),
            offIsOn: !!(offChip && offChip.classList.contains('is-on')),
            onBg: bg(onChip), offBg: bg(offChip), onBd: bd(onChip), offBd: bd(offChip)
          };
        })(),
        colBottoms: Array.from(document.querySelectorAll('.kh-editor-col'))
          .map((c) => Math.round(c.getBoundingClientRect().bottom)),
        // 备注框空着时会不会就出现滚动条
        noteBox: (() => {
          const el = document.getElementById('fld-note');
          return el ? { rows: el.rows, clientH: el.clientHeight, scrollH: el.scrollHeight } : null;
        })(),
        noteScroll: (() => {
          const el = document.getElementById('fld-note');
          return !!el && el.scrollHeight > el.clientHeight + 1;
        })()
      };
    });
    console.log('        基本信息胶囊 ' + JSON.stringify(r.chipLefts));
    console.log('        标题词胶囊 ' + JSON.stringify(r.titleChips));
    console.log('        弹窗高 ' + r.modalH + 'px；标题词格 ' + JSON.stringify(r.titlePair.verify) +
      ' 组合方向 ' + JSON.stringify(r.titlePair.axis));
    // ① 核心词与标题词的匹配规则：同一套胶囊、同一套文案、同一套顺序
    eq((r.basicChipLines[0] || []).slice(0, 3).join('/'), '正则/Aa/全词',
      '核心词匹配规则应是 正则/Aa/全词 三个胶囊，实际 ' + JSON.stringify(r.basicChipLines[0]));
    eq(r.titleChips.join('/'), '正则/Aa/全词',
      '标题词的匹配规则必须与核心词同一套说法，实际 ' + JSON.stringify(r.titleChips));
    // ①b 分区：匹配规则/高亮已并入基本信息；**抓取后续字段必须独立成区**（用户口径：普通词也能抓取）
    eq(r.secIds.join('/'), 'basic/combo/fetch/imp', '分区应为 基本信息/单元格组合/抓取后续字段/重要笔记，实际 ' + JSON.stringify(r.secIds));
    truthy(r.chipAboveNote, '核心词匹配胶囊应紧跟在「关键词 / 分组」那一行下面（在「备注」之前）');
    eq(r.fetchOwnSec, 'fetch', '「抓取后续字段」必须是独立分区（普通词也能抓取，不该挂在单元格组合下），实际宿主 ' + r.fetchOwnSec);
    // ② 组合方向与标题词：两列并排、行对齐，且没有被挤成窄条
    eq(r.titlePair.verify.t, r.titlePair.axis.t, '「标题关键词」与「组合方向」应在同一行（行对齐）');
    truthy(r.titlePair.axis.l > r.titlePair.verify.l, '「组合方向」应在「标题关键词」右侧（分两列）');
    truthy(r.titlePair.verify.w >= 100, '「标题关键词」被挤窄了：w=' + r.titlePair.verify.w);
    truthy(r.titlePair.axis.w >= 100, '「组合方向」被挤窄了：w=' + r.titlePair.axis.w);
    // ③ 底色 / 文字颜色：胶囊，与匹配规则三个**同一行**，但前面留更大间距做分组
    eq(r.colorLabels.join('/'), '底/文', '颜色胶囊的文案应为单字 底/文（双字放不下一行），实际 ' + JSON.stringify(r.colorLabels));
    eq(r.colorDots.join('/'), 'true/true', '颜色胶囊必须带色点（显示当前色 / 虚线圈＝继承）');
    eq(r.colors[0].t, r.colors[1].t, '「底」「文」应在同一行');
    truthy(r.colors[1].l > r.colors[0].l, '两个颜色胶囊应分左右');
    eq(r.basicChipLines.length, 1, '5 个胶囊应放成**一行**（去掉勾选框后窄了，空间够），实际 ' + JSON.stringify(r.basicChipLines));
    eq((r.basicChipLines[0] || []).join('/'), '正则/Aa/全词/底/文',
      '一行里的胶囊顺序应为 正则/Aa/全词/底/文，实际 ' + JSON.stringify(r.basicChipLines[0]));
    // 颜色组与匹配组之间要有**竖线分隔**（用户要求"加一个竖线做区分"）
    const sep = r.chipSep;
    truthy(sep, '两组胶囊之间应有竖线分隔元素（.kh-chip-sep）');
    truthy(sep.w <= 2 && sep.h >= 10, '分隔线应是 1px 竖线，实际 ' + JSON.stringify(sep));
    const before = r.chipLefts[2], after = r.chipLefts[3];   // 全词 → 底
    truthy(sep.l > before.l + before.w && sep.l < after.l,
      '竖线必须落在「全词」与「底」之间，实际 sep.x=' + sep.l +
      ' 全词右缘=' + (before.l + before.w) + ' 底左缘=' + after.l);
    // 4) 富文本编辑框可拖动加高；提示行已删
    truthy(/both|horizontal/.test(r.rte && r.rte.resize), '富文本编辑框应可拖动改变大小（2.0.2.7 起 both：纵向加高 + 横向临时拉宽），实际 resize=' + (r.rte && r.rte.resize));
    truthy(r.rte && parseFloat(r.rte.maxH) >= 500, 'max-height 不能太小（否则拖几下就顶住），实际 ' + (r.rte && r.rte.maxH));
    truthy(r.tipGone, '富文本编辑框下的提示行应已删除（.kh-rt-wysiwyg 内不该再有 .kh-rule-hint）');
    /* 2.0.2.7 二改（用户 m02566 第 2 条）：编辑区拖宽时**整个容器要一起长出去**。
     * 以前原生 resize 只写自己的 inline width ⇒ 宽度窜出所在列，弹窗里出横向滚动条。
     * 这里不模拟鼠标拖拽（真机由人拖），只复现拖拽的结果（inline width），验容器联动。 */
    const grow = await opt.evaluate(async () => {
      const rte = document.querySelector('.kh-rte');
      const modal = document.querySelector('.kh-modal');
      const body = document.querySelector('.kh-modal-body');
      const before = Math.round(modal.getBoundingClientRect().width);
      rte.style.width = Math.round(rte.clientWidth + 160) + 'px';   // 原生 resize 写的就是这条
      await new Promise((res) => setTimeout(res, 300));             // ResizeObserver 回调是异步的
      return {
        before,
        after: Math.round(modal.getBoundingClientRect().width),
        overflow: body.scrollWidth - body.clientWidth,
        rteW: Math.round(rte.getBoundingClientRect().width)
      };
    });
    truthy(grow.after > grow.before + 80,
      '拖宽编辑区时弹窗要跟着长出去（否则内容窜出容器、弹窗出现横向滚动条），实际 ' + JSON.stringify(grow));
    truthy(grow.overflow <= 1, '编辑区加宽后弹窗正文不许出现横向滚动，实际 ' + JSON.stringify(grow));
    /* 拖回"自动宽"（清掉 inline width）时容器要自己瘦回自然宽 —— 用户要的是**临时**加宽 */
    const back = await opt.evaluate(async () => {
      const r2 = document.querySelector('.kh-rte');
      const m = document.querySelector('.kh-modal');
      const body = document.querySelector('.kh-modal-body');
      r2.style.width = '';
      await new Promise((res) => setTimeout(res, 300));
      return {
        inline: m.style.width,
        w: Math.round(m.getBoundingClientRect().width),
        overflow: body.scrollWidth - body.clientWidth
      };
    });
    truthy(back.inline === '',
      '编辑区回到自动宽后弹窗要自己瘦回自然宽（别一直撑着），实际 ' + JSON.stringify(back));
    truthy(back.overflow <= 1, '瘦回自然宽后弹窗正文也不许横向滚动，实际 ' + JSON.stringify(back));
    /* 2.0.6.6（用户 m01585 截图：把重要笔记拖宽之后整块崩掉、右边一大片空白）：
     * 上一段只验了「拖宽 160」这种温和情况；真实崩坏是**拖到远超可用空间**——旧实现把那一列
     * 顶成 1200px，别的列被挤到换行、正文横滚。指标同样不模拟鼠标，直接写原生 resize 会写的
     * inline width，再验「正文无横滚 / 编辑区不比弹窗宽 / 列不比弹窗宽」。
     * 另外验「拖宽之后用户再把弹窗拖窄」：弹窗必须停在他拖的位置，不许被撑回自然宽。 */
    const huge = await opt.evaluate(async () => {
      const pick = () => [document.querySelector('.kh-rte'), document.querySelector('.kh-modal textarea.kh-textarea')];
      const out = [];
      for (const ed of pick()) {
        if (!ed) { out.push({ skip: true }); continue; }
        const modal = document.querySelector('.kh-modal-lg') || document.querySelector('.kh-modal');
        const body = modal.querySelector('.kh-modal-body') || modal;
        ed.style.width = (Math.round(modal.getBoundingClientRect().width) + 400) + 'px';
        await new Promise((res) => setTimeout(res, 340));           // ResizeObserver 回调是异步的
        const wide = {
          overflow: body.scrollWidth - body.clientWidth,
          ed: Math.round(ed.getBoundingClientRect().width),
          modal: Math.round(modal.getBoundingClientRect().width),
          cols: Array.from(modal.querySelectorAll('.kh-editor-col')).map((c) => Math.round(c.getBoundingClientRect().width))
        };
        modal.style.width = '700px';                                // 人拖窄弹窗
        await new Promise((res) => setTimeout(res, 340));
        const narrow = {
          modal: Math.round(modal.getBoundingClientRect().width),
          overflow: body.scrollWidth - body.clientWidth
        };
        ed.style.width = '';
        await new Promise((res) => setTimeout(res, 340));
        out.push({ wide: wide, narrow: narrow });
      }
      return out;
    });
    for (const h of huge) {
      if (!h || h.skip) continue;
      truthy(h.wide.overflow <= 1, '拖到超出可用空间后正文不许出现横向滚动（旧实现这里会崩），实际 ' + JSON.stringify(h.wide));
      truthy(h.wide.ed <= h.wide.modal, '拖宽后编辑区不许比弹窗还宽，实际 ' + JSON.stringify(h.wide));
      truthy(h.wide.cols.every((c) => c <= h.wide.modal), '任何一列都不许比弹窗还宽，实际 ' + JSON.stringify(h.wide));
      truthy(h.narrow.modal <= 720, '拖宽之后用户再把弹窗拖窄，弹窗要停在他拖的位置（不许被撑回自然宽），实际 ' + JSON.stringify(h.narrow));
      truthy(h.narrow.overflow <= 1, '弹窗被拖窄后正文仍不许横向滚动，实际 ' + JSON.stringify(h.narrow));
    }
    // ④ 重要笔记：底色 / 尺寸 / 字号搬进工具栏，与 B/I 同一行（2.0.2.11 票 #64）
    truthy(r.noteTools, '重要笔记编辑器应带 .kh-rt-toolbar（底色/尺寸/字号的住处）');
    eq(r.noteTools.list.map((x) => x.key).join('/'), 'impNoteUseHlColor/imgSize/noteFontSize',
      '工具栏里应恰有 底色/尺寸/字号 三件，实际 ' + JSON.stringify(r.noteTools));
    r.noteTools.list.forEach((t) => {
      truthy(!t.missing && t.inBar, '「' + t.key + '」必须住在工具栏里，实际 ' + JSON.stringify(t));
      truthy(Math.abs(t.center - r.noteTools.bc) < 12,
        '「' + t.key + '」要与 B/I 同一行（同心），实际 ' + t.center + ' vs ' + r.noteTools.bc);
      truthy(t.h <= 34, '「' + t.key + '」应塞进一行工具栏（高度 ≤34px），实际 ' + t.h);
      falsy(t.clipped, '「' + t.key + '」的按钮文字被裁了，实际 ' + JSON.stringify(t));
    });
    eq(r.noteTools.list[0].text, '底', '底色的工具栏按钮文案应是「底」（原胶囊缩短名）');
    truthy(/^▭/.test(r.noteTools.list[1].text), '尺寸按钮要带 ▭ 前缀（面板宽度有限，靠前缀认字段），实际 ' + JSON.stringify(r.noteTools.list[1].text));
    truthy(/^A/.test(r.noteTools.list[2].text), '字号按钮要带 A 前缀，实际 ' + JSON.stringify(r.noteTools.list[2].text));
    // ⑤ 关键词 / 分组并排；「启用」在分区标题行右侧；「预览」与「备注」标题同行
    eq(r.keywordAndGroup.text.t, r.keywordAndGroup.group.t, '「关键词」与「分组」应在同一行（分组跟在关键词后面）');
    truthy(r.keywordAndGroup.group.l > r.keywordAndGroup.text.l, '「分组」应在「关键词」右侧');
    truthy(r.enableInHead && r.enableInHead.inExtra, '「启用」应渲染在分区标题行右侧的插槽里，实际 ' + JSON.stringify(r.enableInHead));
    falsy(r.enableInHead && r.enableInHead.inBody, '「启用」不该再占正文一行');
    falsy(r.enableInHead && r.enableInHead.inHeadBtn,
      '「启用」不能塞进折叠按钮内部（交互控件嵌 <button> 不合法，且点一下会顺带折叠分区）');
    truthy(r.noteToolsSameRow, '「预览」按钮应与「备注」标题同一行，而不是自己占一行');
    // ⑨ 弹窗里的颜色胶囊也要能点开选色浮层（与表格共用同一个单例浮层 ui.Popover）
    await opt.click('#fld-bgColor');
    await opt.waitForTimeout(250);
    const mPop = await opt.evaluate(() => {
      const p = document.querySelector('.kh-popover');
      return p ? { cells: p.querySelectorAll('.kh-color-cell').length, picker: !!p.querySelector('.kh-color-input') } : null;
    });
    truthy(mPop && mPop.cells > 0, '弹窗里的颜色胶囊应点开选色浮层，实际 ' + JSON.stringify(mPop));
    await opt.keyboard.press('Escape');
    await opt.waitForTimeout(200);
    falsy(await opt.evaluate(() => !!document.querySelector('.kh-popover')), 'Esc 应能关掉选色浮层');
    // ⑥ 三列底边必须齐平（用户实测："三列高度不齐，不太美观"）
    truthy(r.colBottoms && r.colBottoms.length === 3, '应有 3 列，实际 ' + JSON.stringify(r.colBottoms));
    truthy(Math.max.apply(null, r.colBottoms) - Math.min.apply(null, r.colBottoms) <= 2,
      '三列底边应齐平（相等高度），实际 bottoms=' + JSON.stringify(r.colBottoms));
    // ⑦ 备注框空着的时候**不该有滚动条**（占位文案比框还长就会出现，用户实测截图指出）
    falsy(r.noteScroll, '备注框默认不该出现滚动条：' + JSON.stringify(r.noteBox));
    // ⑧ 胶囊不许有勾选框，选中/未选中只看颜色
    const cv = r.chipVisual;
    truthy(cv, '应能取到胶囊视觉信息');
    truthy(cv.onBoxW <= 2 && cv.offBoxW <= 2,
      '胶囊里不该显示勾选框（应视觉隐藏），实际宽度 on=' + cv.onBoxW + ' off=' + cv.offBoxW);
    truthy(cv.onChecked && !cv.offChecked, '前置条件：新建时「启用」默认勾选、「启用组合」默认不勾选');
    truthy(cv.onIsOn && !cv.offIsOn, '选中态应加 is-on 类，实际 on=' + cv.onIsOn + ' off=' + cv.offIsOn);
    truthy(cv.onBg !== cv.offBg, '选中/未选中的**背景色必须不同**（这是唯一的区分手段），实际 ' + cv.onBg + ' vs ' + cv.offBg);
    truthy(cv.onBd !== cv.offBd, '选中/未选中的**边框色也必须不同**，实际 ' + cv.onBd + ' vs ' + cv.offBd);
    console.log('        胶囊视觉: 选中 bg=' + cv.onBg + ' / 未选中 bg=' + cv.offBg + '；勾选框宽 ' + cv.onBoxW + 'px');
    await shot(opt, '10c-editor-compact');
  });

  /* ==========================================================================
   * K70（用户实测）：①「单元格组合」的「启用组合」与「重要笔记」的「重要」两颗胶囊，
   *   跟「基本信息」那颗一样放到**各自模块右上角**，文案统一成「启用」；
   *   ② 图片识别三控件（识别图片文字 / 图片命中关键词 / 每处最多）从「单元格组合」
   *   归到「抓取后续字段」模块（放在该模块输入框下方）。
   * 判定方式全部**结构化**（不靠像素猜、不看文案全文）：
   *   · "模块右上角" ＝ 该胶囊位于本分区的 `.kh-editor-sec-headrow`（标题行）内、
   *     不在 `.kh-editor-sec-body`（正文）里、不在折叠按钮内部，且几何上贴标题行最右缘、在正文上边界之上；
   *   · "控件归某模块" ＝ `#fld-<key>` 的 `closest('.kh-editor-sec')` 的 data-sec / 标题文本。
   * ======================================================================= */

  /* 下面两个用例都要从**干净的新建弹窗**开始（上一组用例结束时弹窗状态不定） */
  const closeEditor = async () => {
    await opt.evaluate(() => {
      if (!document.querySelector('.kh-editor')) return;
      const cancel = Array.from(document.querySelectorAll('.kh-modal .kh-btn'))
        .find((b) => /取消/.test((b.textContent || '').trim()));
      if (cancel) cancel.click();
    });
    await opt.waitForTimeout(300);
  };
  /**
   * 等编辑弹窗**真的**上屏。
   * 【为什么不能固定等 600ms】弹窗入屏要先读 CSS/主题，是异步的。机器忙的时候 600ms 不够，
   * 后面的 `#fld-*` 就取到 null —— 实测踩过（2026-10-06）：`R4-③` 报
   * `page.evaluate: TypeError: Cannot read properties of null (reading 'value')`，
   * 三次全量里假红一次，逼着人做归因。改成"等到真出现"，超时才报错。
   */
  const waitForEditor = async (timeout = 8000) => {
    await opt.waitForFunction(
      () => !!document.querySelector('.kh-editor') && !!document.getElementById('fld-text'),
      null, { timeout: timeout }
    );
  };
  const openFreshEditor = async () => {
    await closeEditor();
    /* 上一只弹窗必须**真的退场**，否则下面会"等到旧弹窗"就以为开好了 */
    await opt.waitForFunction(() => !document.querySelector('.kh-editor'), null, { timeout: 3000 }).catch(() => {});
    await opt.evaluate(() => document.getElementById('btn-kw-add').click());
    await waitForEditor();
  };

  await test('★ K70-①：四个模块的胶囊都是「启用」且落在**各自模块标题行右侧**（右上角）', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').trim() : null);
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
      };
      const read = (id) => {
        const sec = document.querySelector('.kh-editor-sec[data-sec="' + id + '"]');
        if (!sec) return null;
        const row = sec.querySelector('.kh-editor-sec-headrow');
        const extra = row ? row.querySelector('.kh-editor-sec-extra') : null;
        const chips = extra ? Array.from(extra.querySelectorAll('.kh-fld-chip')) : [];
        const headBtn = sec.querySelector('.kh-editor-sec-head');
        const title = sec.querySelector('.kh-editor-sec-title');
        const body = sec.querySelector('.kh-editor-sec-body');
        const cs = chips.length ? getComputedStyle(chips[0]) : null;
        return {
          chipCount: chips.length,
          texts: chips.map((c) => txt(c.querySelector('.kh-fld-chip-t'))),
          ids: chips.map((c) => { const i = c.querySelector('input'); return i ? i.id : ''; }),
          inHeadRow: chips.length > 0 && chips.every((c) => !!c.closest('.kh-editor-sec-headrow')),
          inBody: chips.some((c) => !!c.closest('.kh-editor-sec-body')),
          inHeadBtn: chips.some((c) => !!(headBtn && headBtn.contains(c))),
          rightOfTitle: chips.length > 0 && chips.every((c) => box(c).l >= box(title).r - 1),
          aboveBody: chips.length > 0 && chips.every((c) => box(c).b <= box(body).t + 1),
          atRowRight: chips.length > 0 && chips.every((c) => box(c).r >= box(row).r - 2),
          style: cs ? { h: cs.height, radius: cs.borderRadius, font: cs.fontSize, pad: cs.paddingLeft + '/' + cs.paddingRight } : null
        };
      };
      return { basic: read('basic'), combo: read('combo'), fetch: read('fetch'), imp: read('imp') };
    });
    console.log('        K70 四颗胶囊: ' + JSON.stringify(r));
    /* K71：抓取模块也长出了自己的「启用」（第 4 颗），口径与另三颗**逐字相同** */
    const SECS = ['basic', 'combo', 'fetch', 'imp'];
    const SEC_NAME = { basic: '基本信息', combo: '单元格组合', fetch: '抓取后续字段', imp: '重要笔记' };
    const styles = [];
    for (const sec of SECS) {
      const p = r[sec];
      truthy(p, '应能读到「' + sec + '」模块（分区 id 未改）');
      eq(p.chipCount, 1, '「' + sec + '」模块标题行右侧应有**且仅有**一颗胶囊，实际 ' + p.chipCount);
      eq(p.texts.join('/'), '启用', '「' + sec + '」那颗胶囊的文案必须是「启用」，实际 ' + JSON.stringify(p.texts));
      truthy(p.inHeadRow, '「' + sec + '」胶囊必须在模块**标题行**里（"模块右上角"的结构判据）');
      falsy(p.inBody, '「' + sec + '」胶囊不该再落在模块**正文**里（旧位置）');
      falsy(p.inHeadBtn, '「' + sec + '」胶囊不能塞进折叠按钮内部（点一下会顺带折叠分区）');
      truthy(p.rightOfTitle, '「' + sec + '」胶囊应在模块标题文字**右侧**');
      truthy(p.aboveBody, '「' + sec + '」胶囊应在正文**上边界之上**（右上角，而不是左下）');
      truthy(p.atRowRight, '「' + sec + '」胶囊应贴到标题行**最右缘**，实际 ' + JSON.stringify(p));
      styles.push(p.style);
    }
    // 四颗同一形态（同一 class / 同一套胶囊样式）——「基本信息」那颗是参照物
    for (let i = 1; i < SECS.length; i++) {
      eq(JSON.stringify(styles[i]), JSON.stringify(styles[0]),
        '「' + SEC_NAME[SECS[i]] + '」胶囊的样式必须与「基本信息」那颗一致');
    }
    // id / 选择器标识一律没改（只改显示文案与挂载位置）
    eq(r.basic.ids.join('/'), 'fld-enabled', '「基本信息」那颗的 id 未动（位置文案本来就不变）');
    eq(r.combo.ids.join('/'), 'fld-cellVerifyEnabled', '★ 组合开关的 id 未动（只改了显示文案与挂载位置）');
    eq(r.fetch.ids.join('/'), 'fld-fetchEnabled', '★ 抓取开关的 id 是 fld-fetchEnabled（新键的唯一 DOM 入口）');
    eq(r.imp.ids.join('/'), 'fld-important', '★ 重要开关的 id 未动（只改了显示文案与挂载位置）');
  });

  await test('★ K70-②：图片识别三控件的"最近模块标题"是「抓取后续字段」，combo 里不再有它们', async () => {
    const r = await opt.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').trim() : null);
      const own = (key) => {
        const el = document.getElementById('fld-' + key);
        if (!el) return { key: key, found: false };
        const sec = el.closest('.kh-editor-sec');
        return {
          key: key, found: true,
          dataSec: sec ? sec.getAttribute('data-sec') : null,
          nearTitle: txt(sec ? sec.querySelector('.kh-editor-sec-title') : null),
          /* 2.0.2.7：cands/int 的真输入框藏在浮层里（常态 display:none，rect 全 0）——
           * "控件在不在输入框下方"要量**整个字段盒**（盒里的胶囊是看得见的那个东西）。 */
          top: Math.round((el.closest('.kh-fld') || el).getBoundingClientRect().top),
          label: txt(el.closest('.kh-fld, .kh-fld-bool') ? el.closest('.kh-fld, .kh-fld-bool').querySelector('.kh-fld-label, .kh-fld-bool-label') : null)
        };
      };
      const fetch = document.getElementById('fld-fetchLabels');
      const comboBody = document.querySelector('.kh-editor-sec[data-sec="combo"] .kh-editor-sec-body');
      return {
        ocr: ['imgOcr', 'imgOcrKeyword', 'imgOcrMax'].map(own),
        fetchTop: fetch ? Math.round(fetch.getBoundingClientRect().top) : -1,
        comboBodyText: txt(comboBody),
        secIds: Array.from(document.querySelectorAll('.kh-editor-sec')).map((s) => s.getAttribute('data-sec'))
      };
    });
    console.log('        K70 图片识别控件归属: ' + JSON.stringify(r.ocr));
    eq(r.secIds.join('/'), 'basic/combo/fetch/imp', '分区清单不该变，实际 ' + JSON.stringify(r.secIds));
    r.ocr.forEach((o) => {
      truthy(o.found, o.key + ' 控件必须还在（id 未改，能用 fld-<key> 定位到）');
      eq(o.dataSec, 'fetch', o.key + ' 的**最近模块**应是 fetch，实际 ' + o.dataSec);
      eq(o.nearTitle, '抓取后续字段', o.key + ' 的最近模块标题应是「抓取后续字段」，实际 ' + JSON.stringify(o.nearTitle));
      truthy(o.top > r.fetchTop, o.key + ' 应在「抓取后续字段」输入框**下方**（top ' + o.top + ' > ' + r.fetchTop + '）');
    });
    // 「单元格组合」正文里不得再残留这三个控件的标签（含它们之间的说明文字）
    ['识别图片文字', '图片命中关键词', '张数'].forEach((label) => {
      falsy(r.comboBodyText.indexOf(label) >= 0,
        '「单元格组合」正文里不该再出现「' + label + '」，实际 ' + JSON.stringify(r.comboBodyText));
    });
  });

  await test('★ K70-③：图片识别联动不回归（禁用 / 提示 / 保存拦截 / 取消勾选不清空 / 保存往返）', async () => {
    await openFreshEditor();

    // ① 模块开着、但没填「字段」→ 三个控件全禁用，且那句提示仍在（提示随控件一起搬进 fetch 模块）
    const off = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      /* K75：抓取模块**默认未勾选**，先勾上再验"字段为空"这条既有前置条件 */
      const en = g('fetchEnabled'); en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      const note = document.querySelector('.kh-editor-sec[data-sec="fetch"] .kh-editor-axis-note');
      return {
        ocr: !!g('imgOcr') && g('imgOcr').disabled,
        kw: !!g('imgOcrKeyword') && g('imgOcrKeyword').disabled,
        max: !!g('imgOcrMax') && g('imgOcrMax').disabled,
        noteShown: !!note && !note.hidden,
        noteText: note ? note.textContent : ''
      };
    });
    truthy(off.ocr && off.kw && off.max,
      '没填抓取字段时 识别图片文字 / 图片命中关键词 / 每处最多 必须全部禁用：' + JSON.stringify(off));
    truthy(off.noteShown, '并必须给出那句"当前不可用"的提示');
    /* C6（K71 改写）：提示**不复述控件名、也不复述模块名** —— 模块标题已经写了模块名，
     * 正文再说一遍是用户点名的冗余；这里同时盯住"新文案确实生效"与"没有回退成复述句"。 */
    truthy(off.noteText.indexOf('先在上面填要抓的字段') >= 0, '提示应改写成"先在上面填要抓的字段…"，实际 ' + JSON.stringify(off.noteText));
    falsy(off.noteText.indexOf('识别图片文字') >= 0, '★ 提示不该再复述控件名「识别图片文字」');
    falsy(off.noteText.indexOf('抓取后续字段') >= 0, '★ 提示不该再复述模块名「抓取后续字段」');

    // ② 填上「抓取后续字段」→ 勾选框解禁（关键词与上限仍要等勾选）
    const on = await opt.evaluate(() => {
      const f = document.getElementById('fld-fetchLabels');
      f.value = '应用截图';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      const g = (k) => document.getElementById('fld-' + k);
      const note = document.querySelector('.kh-editor-sec[data-sec="fetch"] .kh-editor-axis-note');
      return { ocr: g('imgOcr').disabled, kw: g('imgOcrKeyword').disabled, noteShown: !!note && !note.hidden };
    });
    falsy(on.ocr, '填了抓取字段后，勾选框应可用');
    truthy(on.kw, '还没勾选 → 「图片命中关键词」仍应禁用');
    falsy(on.noteShown, '可用后提示应隐藏');

    // ③ 勾选 → 关键词/上限解禁；取消勾选**不清空**已填文本
    const toggle = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const ocr = g('imgOcr'), kwin = g('imgOcrKeyword');
      ocr.checked = true; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      kwin.value = '一对一'; kwin.dispatchEvent(new Event('input', { bubbles: true }));
      const kwUsableWhenOn = !kwin.disabled, maxUsableWhenOn = !g('imgOcrMax').disabled;
      ocr.checked = false; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      return { kwUsableWhenOn: kwUsableWhenOn, maxUsableWhenOn: maxUsableWhenOn,
        disabledAfterUncheck: kwin.disabled, valueAfterUncheck: kwin.value };
    });
    truthy(toggle.kwUsableWhenOn && toggle.maxUsableWhenOn, '勾选后「图片命中关键词 / 每处最多」应可用');
    truthy(toggle.disabledAfterUncheck, '取消勾选后两者应回到禁用');
    eq(toggle.valueAfterUncheck, '一对一', '★ 取消勾选**不得清空**已填关键词（既有口径没变）');

    // ④ 勾选但关键词为空 → 保存被拦住并说清原因（必填项先填好，确保测的是 OCR 这道闸）
    await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const setText = (k, v) => { const el = g(k); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      setText('text', 'K70门禁词');
      setText('fetchLabels', '应用截图');
      setText('imgOcrKeyword', '');
      const ocr = g('imgOcr'); ocr.checked = true; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    });
    await opt.waitForTimeout(700);
    const gate = await opt.evaluate(() => {
      const box = document.querySelector('.kh-editor-err');
      return { shown: !!box && !box.hidden, text: box ? box.textContent : '', stillOpen: !!document.querySelector('.kh-editor') };
    });
    truthy(gate.shown, '勾选却缺「图片命中关键词」→ 保存必须被拦住并给出提示，实际 ' + JSON.stringify(gate));
    truthy(gate.text.indexOf('图片命中关键词') >= 0, '拦住的理由要指出缺「图片命中关键词」，实际 ' + JSON.stringify(gate.text));
    truthy(gate.stillOpen, '被拦住时弹窗不该关闭');

    // ⑤ 验收第 4 条：补上关键词 → 保存 → 重开弹窗仍是"勾选 + 关键词"
    await opt.evaluate(() => {
      const kw = document.getElementById('fld-imgOcrKeyword');
      kw.value = 'K70往返图词';
      kw.dispatchEvent(new Event('input', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    });
    await opt.waitForTimeout(1000);
    const stored = await opt.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === 'K70门禁词');
      return k ? { imgOcr: !!k.imgOcr, imgOcrKeyword: k.imgOcrKeyword, fetchLabels: k.fetchLabels } : null;
    });
    truthy(stored, '补上关键词后应能落库（证明 ④ 拦住的确实是 OCR 这道闸）');
    eq(stored.imgOcr, true, '勾选态应落库');
    eq(stored.imgOcrKeyword, 'K70往返图词', '「图片命中关键词」应落库');
    eq(stored.fetchLabels, '应用截图', '「抓取后续字段」应落库');

    const reopened = await opt.evaluate(async () => {
      const cfg = await KH.Store.load();
      const kw = (cfg.keywords || []).find((x) => x.text === 'K70门禁词');
      if (!kw) return false;
      KH.ui.openEditor({ keyword: kw, cfg, mode: 'options' });
      return true;
    });
    truthy(reopened, '应能用落库后的关键词重开编辑弹窗');
    await opt.waitForTimeout(700);
    const back = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const el = g('imgOcr');
      const sec = el ? el.closest('.kh-editor-sec') : null;
      return {
        checked: !!el && el.checked,
        /* 2.0.2.7：候选字段的值住在**胶囊**里（真输入框藏在浮层里，重开弹窗后 value 是空的）⇒ 读胶囊文案 */
        kw: (() => {
          const el = g('imgOcrKeyword');
          const name = el && el.closest('.kh-cand-box') ? el.closest('.kh-cand-box').querySelector('.kh-lbl-name') : null;
          return name ? (name.textContent || '').trim() : null;
        })(),
        dataSec: sec ? sec.getAttribute('data-sec') : null
      };
    });
    eq(back.checked, true, '重开后「识别图片文字」仍是勾选（字段值不受 UI 重排影响）');
    eq(back.kw, 'K70往返图词', '重开后「图片命中关键词」仍是原值');
    eq(back.dataSec, 'fetch', '重开后控件仍挂在「抓取后续字段」模块');

    // 收尾：关掉弹窗 + 删掉这条测试用关键词（别影响后面的组：导入导出 / popup 关键词数）
    await closeEditor();
    await opt.evaluate(async () => {
      const cfg = await KH.Store.load();
      const kw = (cfg.keywords || []).find((x) => x.text === 'K70门禁词');
      if (kw) await KH.Store.removeKeywords([kw.id]);
    });
  });

  /* ==========================================================================
   * R4 独立验收（红队）—— 只认自己跑出来的数字，不复用 R3 的自述。
   * 这里刻意补 R3 用例**没盖住**的面：
   *   ① 三颗胶囊"逐属性同形"：R3 只比了 height/borderRadius/fontSize/padding 四项，
   *      而且**在不同勾选态下**比（is-on 会加粗 + 换配色，差异被状态掩盖）。
   *      这里先强制三颗进入**同一状态**再比全量计算样式（含字重/配色/边框/盒模型/宽度）。
   *   ② 旧文案「启用组合 / 重要」在真实 DOM 里**零残留**（胶囊文案 + 字段标签 + 全弹窗文本），
   *      并反向确认 OCR 三个标签在全弹窗范围内**只**归属 fetch（R3 只查了 combo 正文）。
   *   ③「禁用」是**真禁用**（disabled 属性 + 点击无效），且三个控件仍然**可见**（不是被藏起来）。
   *   ④ 保存拦截**真的不落库**（直接读 chrome.storage 证伪；R3 只给了"补上后能落库"的间接证据）。
   *   ⑤「取消勾选不清空关键词」在**落库层**也成立（R3 只查了 DOM 输入框的值）。
   *   ⑥ R3 的 K70-③ 临时关键词**真的被清掉**，且本段用例自身**零污染**（前后清单逐字相同）。
   * @see 契约 §四 验收 1~5 / §五 反向验证设计
   * ======================================================================= */

  await test('★ R4-①：同一勾选态下三颗胶囊**逐属性同形** + 贴标题行右缘 + 旧文案零残留 + 模块标题未变', async () => {
    await openFreshEditor();
    const PROPS = ['width', 'height', 'borderRadius', 'fontSize', 'fontWeight', 'fontFamily',
      'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
      'borderTopWidth', 'borderLeftWidth', 'borderTopStyle', 'borderTopColor',
      'color', 'backgroundColor', 'boxSizing', 'display', 'alignItems', 'gap',
      'marginLeft', 'marginTop', 'marginBottom', 'minWidth', 'cursor', 'opacity', 'whiteSpace'];
    const IDS = ['fld-enabled', 'fld-cellVerifyEnabled', 'fld-fetchEnabled', 'fld-important'];
    /* ⚠ 假红陷阱（我自己先踩了一次）：`.kh-fld-chip` 上有
     * `transition: background / border-color / color`（--tr）。若在**同一次 evaluate** 里
     * "改勾选状态 + 立刻 getComputedStyle"，读到的是**过渡中间值**（白底 + 已加粗，看着像"样式不一致"）。
     * 必须拆成「置状态 → 等过渡结束 → 再读」。 */
    const setChipState = (state) => opt.evaluate(({ ids, state }) => {
      ids.forEach((id) => {
        const inp = document.getElementById(id);
        if (inp && inp.checked !== state) { inp.checked = state; inp.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      return true;
    }, { ids: IDS, state });

    const readChips = () => opt.evaluate(({ props, ids }) => {
      const txt = (el) => (el ? (el.textContent || '').trim() : null);
      const snap = () => {
        const out = {};
        for (const id of ids) {
          const inp = document.getElementById(id);
          const chip = inp && inp.closest('.kh-fld-chip');
          if (!chip) { out[id] = null; continue; }
          const cs = getComputedStyle(chip);
          const style = {};
          for (const p of props) style[p] = cs[p];
          const b = chip.getBoundingClientRect();
          out[id] = {
            style: style,
            cls: chip.className,
            kids: Array.from(chip.children).map((e) => e.tagName + '[' + (e.className || '') + ']').join(','),
            rect: Math.round(b.width) + 'x' + Math.round(b.height),
            text: txt(chip.querySelector('.kh-fld-chip-t')),
            inputType: inp.type,
            inputName: inp.getAttribute('name')
          };
        }
        return out;
      };
      const geo = {};
      for (const secId of ['basic', 'combo', 'fetch', 'imp']) {
        const sec = document.querySelector('.kh-editor-sec[data-sec="' + secId + '"]');
        const row = sec.querySelector('.kh-editor-sec-headrow');
        const chip = sec.querySelector('.kh-editor-sec-extra .kh-fld-chip');
        const title = sec.querySelector('.kh-editor-sec-title');
        const body = sec.querySelector('.kh-editor-sec-body');
        const bb = (e) => e.getBoundingClientRect();
        geo[secId] = {
          chipCount: sec.querySelectorAll('.kh-editor-sec-extra .kh-fld-chip').length,
          rowRight: Math.round(bb(row).right), chipRight: Math.round(bb(chip).right),
          chipLeft: Math.round(bb(chip).left), chipBottom: Math.round(bb(chip).bottom),
          titleRight: Math.round(bb(title).right), bodyTop: Math.round(bb(body).top),
          inHeadBtn: sec.querySelector('.kh-editor-sec-head').contains(chip)
        };
      }
      const secs = Array.from(document.querySelectorAll('.kh-editor-sec')).map((s) => ({
        id: s.getAttribute('data-sec'), title: txt(s.querySelector('.kh-editor-sec-title')),
        hint: txt(s.querySelector('.kh-editor-sec-hint'))
      }));
      return {
        chips: snap(), geo: geo, secs: secs,
        chipTexts: Array.from(document.querySelectorAll('.kh-editor .kh-fld-chip-t')).map(txt),
        boolLabels: Array.from(document.querySelectorAll('.kh-editor .kh-fld-bool-label')).map(txt),
        allLabels: Array.from(document.querySelectorAll('.kh-editor .kh-fld-label')).map(txt)
      };
    }, { props: PROPS, ids: IDS });

    /* 读之前先把鼠标挪开：上一组用例可能把指针停在胶囊上，`.kh-fld-chip:hover` 会改
     * border-color ⇒ 四颗里只有一颗拿到 hover 色，逐属性比较就假红（2.0.3 全量跑实测踩到）。
     * 再把「读一次」换成「连续两次逐字相同才采用」：`transition` 在飞时读到的是中间值，
     * 固定等 450ms 只是赌渲染时机，弹窗里多一个字段就会赌输。 */
    const stableChips = async () => {
      await opt.mouse.move(2, 2);
      let prev = await readChips();
      for (let i = 0; i < 25; i++) {
        await opt.waitForTimeout(120);
        const cur = await readChips();
        if (JSON.stringify(cur.chips) === JSON.stringify(prev.chips)) return cur;
        prev = cur;
      }
      return prev;
    };

    await setChipState(true);
    const rOn = await stableChips();
    await setChipState(false);
    const rOff = await stableChips();
    const r = { on: rOn.chips, off: rOff.chips, geo: rOn.geo, secs: rOn.secs,
      chipTexts: rOn.chipTexts, boolLabels: rOn.boolLabels, allLabels: rOn.allLabels };

    console.log('        R4 四胶囊(同态) 尺寸: on=' + IDS.map((id) => r.on[id] && r.on[id].rect).join(' / ') +
      '  off=' + IDS.map((id) => r.off[id] && r.off[id].rect).join(' / '));

    for (const state of ['on', 'off']) {
      const arr = IDS.map((id) => r[state][id]);            // [0] = 参照物「基本信息」
      const a = arr[0];
      arr.forEach((x, i) => truthy(x, state + ' 态下第 ' + (i + 1) + ' 颗胶囊必须存在（id 未变）'));
      arr.forEach((x, i) => eq(x.text, '启用', state + ' 态下第 ' + (i + 1) + ' 颗胶囊文案必须是「启用」'));
      for (let i = 1; i < arr.length; i++) {
        eq(JSON.stringify(arr[i].style), JSON.stringify(a.style),
          '★ ' + state + ' 态：' + IDS[i] + ' 的计算样式必须与参照物**逐属性**一致，差异 ' +
          JSON.stringify(Object.keys(a.style).filter((p) => a.style[p] !== arr[i].style[p]).map((p) => p + ': ' + a.style[p] + ' ≠ ' + arr[i].style[p])));
        eq(arr[i].cls, a.cls, state + ' 态：胶囊 class 必须逐字相同（' + IDS[i] + '）');
        eq(arr[i].kids, a.kids, state + ' 态：胶囊内部结构必须同形（' + IDS[i] + '）');
        eq(arr[i].rect, a.rect, state + ' 态：胶囊盒子尺寸必须一致（同文案同样式，' + IDS[i] + '）');
      }
      arr.forEach((x) => eq(x.inputType, 'checkbox', '四颗都仍是 checkbox（存储/判定逻辑未动）'));
      eq(arr.map((x) => x.inputType).join('/'), IDS.map(() => 'checkbox').join('/'), '四颗都是 checkbox');
    }

    // 右上角几何：贴标题行右缘、在标题文字右侧、在正文上边界之上、不在折叠按钮里
    eq(Object.keys(r.geo).map((k) => k + '=' + r.geo[k].chipCount).join('/'),
      'basic=1/combo=1/fetch=1/imp=1', '各模块标题行右侧插槽里应**恰好** 1 颗胶囊：' + JSON.stringify(r.geo));
    for (const k of ['basic', 'combo', 'fetch', 'imp']) {
      const g = r.geo[k];
      truthy(g.chipLeft >= g.titleRight - 1, '「' + k + '」胶囊应在标题文字右侧，实际 ' + JSON.stringify(g));
      truthy(Math.abs(g.chipRight - g.rowRight) <= 2, '「' + k + '」胶囊应贴标题行右缘，实际 ' + g.chipRight + ' vs ' + g.rowRight);
      truthy(g.chipBottom <= g.bodyTop + 1, '「' + k + '」胶囊应在正文上边界之上（右上角而非左下）');
      falsy(g.inHeadBtn, '「' + k + '」胶囊不能塞进折叠按钮内部');
    }
    // id / 模块标题 / 旧文案
    eq(r.secs.map((s) => s.id + '=' + s.title).join('/'),
      'basic=基本信息/combo=单元格组合/fetch=抓取后续字段/imp=重要笔记', '四个模块标题必须逐字不变');
    r.secs.forEach((s) => truthy(s.hint && s.hint.length > 0, '模块「' + s.title + '」的说明文字不该被清空'));
    eq(r.chipTexts.filter((t) => t === '启用').length, 4,
      '全弹窗应**恰好** 4 颗「启用」胶囊（基本信息 / 单元格组合 / 抓取后续字段 / 重要笔记），实际 ' + JSON.stringify(r.chipTexts));
    ['启用组合', '重要'].forEach((old) => {
      falsy(r.chipTexts.indexOf(old) >= 0, '弹窗里不该再有胶囊文案「' + old + '」，实际 ' + JSON.stringify(r.chipTexts));
      falsy(r.boolLabels.indexOf(old) >= 0, '弹窗里不该再有勾选行文案「' + old + '」，实际 ' + JSON.stringify(r.boolLabels));
      falsy(r.allLabels.indexOf(old) >= 0, '弹窗里不该再有字段标签「' + old + '」，实际 ' + JSON.stringify(r.allLabels));
    });
  });

  await test('★ R4-①b：OCR 三个标签在**整个弹窗**里只归属「抓取后续字段」（含 hint 与联动提示文案）', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').trim() : null);
      const secs = Array.from(document.querySelectorAll('.kh-editor-sec')).map((s) => ({
        id: s.getAttribute('data-sec'), text: s.textContent
      }));
      const combo = secs.find((s) => s.id === 'combo');
      return {
        secs: secs, comboText: combo ? combo.text : '',
        // 三个控件本身也按"最近模块"再判一次（与 R3 同口径，但这里连 hint/提示一起查）
        own: ['imgOcr', 'imgOcrKeyword', 'imgOcrMax'].map((k) => {
          const el = document.getElementById('fld-' + k);
          const sec = el && el.closest('.kh-editor-sec');
          return { key: k, found: !!el, sec: sec ? sec.getAttribute('data-sec') : null, title: sec ? txt(sec.querySelector('.kh-editor-sec-title')) : null };
        })
      };
    });
    r.own.forEach((o) => {
      truthy(o.found, o.key + ' 控件必须还在（id 未改）');
      eq(o.sec, 'fetch', o.key + ' 的最近模块应是 fetch，实际 ' + JSON.stringify(o));
      eq(o.title, '抓取后续字段', o.key + ' 的最近模块标题应是「抓取后续字段」');
    });
    ['识别图片文字', '图片命中关键词', '张数'].forEach((label) => {
      const hosts = r.secs.filter((s) => s.text.indexOf(label) >= 0).map((s) => s.id);
      eq(hosts.join('/'), 'fetch', '「' + label + '」应**只**出现在 fetch 分区（连说明文字算上），实际出现在 ' + JSON.stringify(hosts));
    });
    /* T56：当前值必须真的看得见 —— 量活的几何，不做"规则在源码里"这种间接判据。
     * 判据 = 输入框内宽（clientWidth − 左右内边距）≥ 数字真实像素宽（canvas 实测），
     * 且内宽不低过可读下限（防「又挤回去了」）。 */
    const t56 = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const en = g('fetchEnabled'); en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      g('fetchLabels').value = '驳回原因';
      g('fetchLabels').dispatchEvent(new Event('input', { bubbles: true }));
      g('imgOcr').checked = true; g('imgOcr').dispatchEvent(new Event('change', { bubbles: true }));
      const inp = g('imgOcrMax');
      inp.value = '600';                       // 取值上限（config 的 max），最宽的一种当前值
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      /* 2.0.2.7：控件常态是**值胶囊**（真输入框 display:none ⇒ clientWidth 为 0）——
       * 判据平移到胶囊上：整宽 ≥ 30 且数字**不被裁**（scrollWidth ≤ clientWidth）。
       * 不能拿 canvas 量出来的字宽直接比 clientWidth：胶囊宽度是浏览器按自己的度量算的，
       * 与 canvas 有 1px 级差异（实测 19 vs 20），"必须 ≥ 文字宽"会变成常态假红。 */
      const chip = inp.closest('.kh-fld').querySelector('.kh-num-btn') || inp;
      const cs = getComputedStyle(chip);
      const cv = document.createElement('canvas').getContext('2d');
      cv.font = cs.fontSize + ' ' + cs.fontFamily;
      const box = inp.closest('.kh-fld');
      return {
        w: Math.round(chip.clientWidth), textW: Math.ceil(cv.measureText((chip.textContent || '').trim()).width),
        clipped: chip.scrollWidth > chip.clientWidth + 1,
        boxW: Math.round(box.getBoundingClientRect().width), value: (chip.textContent || '').trim()
      };
    });
    console.log('        T56 张数胶囊: ' + JSON.stringify(t56));
    /* 2.0.2.7：控件是**按内容撑开的**值胶囊 ⇒ 判据是"容得下自己的值且不被裁"，
     * 而不是"固定宽 ≥ N 像素"（胶囊宽 = 文字 + 左右内边距，天生比文字宽一点点）。 */
    truthy(t56.w >= t56.textW, '★ 值胶囊必须容得下当前值（不许被压得比数字还窄）：w=' + t56.w + ' 数字宽=' + t56.textW);
    falsy(t56.clipped, '★ 当前值「' + t56.value + '」必须完整可见（胶囊不许被裁：scrollWidth ≤ clientWidth），实际 ' + JSON.stringify(t56));
    truthy(t56.boxW >= 110, '★ inline 字段容器不得窄于 110px（T56 下限，父容器 flex-wrap 兜底换行），实际 ' + JSON.stringify(t56));
    falsy(r.comboText.indexOf('识别图片') >= 0, 'combo 分区文本里不该出现「识别图片」，实际 ' + JSON.stringify(r.comboText.slice(0, 200)));
  });

  await test('★ R4-②：无 fetchLabels → OCR 三控件是**真禁用**（点击无效、仍然可见），提示只在 fetch 分区', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      /* K75：抓取模块**默认未勾选** —— 先勾上，才验"模块开着但字段为空"这条既有前置条件 */
      const en = g('fetchEnabled'); en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      const bb = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
      const ocr = g('imgOcr');
      const before = ocr.checked;
      ocr.click();                                   // 真点一下：disabled 元素不应改变状态
      const afterInputClick = ocr.checked;
      const lbl = ocr.parentNode.querySelector('.kh-fld-bool-label');
      if (lbl) lbl.click();                          // 点它的文字也不应改变
      const afterLabelClick = ocr.checked;
      const notes = Array.from(document.querySelectorAll('.kh-editor-axis-note')).map((n) => ({
        host: n.closest('.kh-editor-sec').getAttribute('data-sec'),
        hidden: !!n.hidden, text: (n.textContent || '').slice(0, 30)
      }));
      return {
        before: before, afterInputClick: afterInputClick, afterLabelClick: afterLabelClick,
        ocrDisabled: !!ocr.disabled, kwDisabled: !!g('imgOcrKeyword').disabled, maxDisabled: !!g('imgOcrMax').disabled,
        ocrVisible: bb(ocr).w > 0 && bb(ocr).h > 0,
        /* 2.0.2.7：cands/int 的真输入框常态 `display:none` ⇒ 量输入框永远是 0；
         * "仍然可见"要量**字段盒**（禁用时盒与胶囊都还在，只是 opacity/disabled）。 */
        kwVisible: bb(g('imgOcrKeyword').closest('.kh-fld')).w > 0, maxVisible: bb(g('imgOcrMax').closest('.kh-fld')).w > 0,
        boolCls: ocr.parentNode.className, boolOpacity: getComputedStyle(ocr.parentNode).opacity,
        kwBoxCls: g('imgOcrKeyword').closest('.kh-fld').className,
        kwOpacity: getComputedStyle(g('imgOcrKeyword').closest('.kh-fld')).opacity,
        notes: notes, ocrTop: bb(ocr).top, fetchTop: bb(g('fetchLabels')).top
      };
    });
    console.log('        R4 禁用态: ' + JSON.stringify({ d: [r.ocrDisabled, r.kwDisabled, r.maxDisabled], vis: [r.ocrVisible, r.kwVisible, r.maxVisible], cls: r.boolCls, op: r.boolOpacity }));
    falsy(r.before, '前置条件：新建时「识别图片文字」默认未勾选');
    truthy(r.ocrDisabled && r.kwDisabled && r.maxDisabled, '无 fetchLabels 时三个控件必须 disabled：' + JSON.stringify(r));
    falsy(r.afterInputClick || r.afterLabelClick, '★ disabled 必须是真的（点击不得改变开关状态，实际 before=' + r.before +
      ' 点框后=' + r.afterInputClick + ' 点文字后=' + r.afterLabelClick + '）');
    truthy(r.ocrVisible && r.kwVisible && r.maxVisible, '它们是"被禁用"而不是"被藏起来"：三个控件都应仍可见');
    truthy(r.ocrTop > r.fetchTop, '三个控件应在「抓取后续字段」输入框下方');
    truthy(r.boolCls.indexOf('is-disabled') >= 0, '勾选行应带 is-disabled 标记，实际 ' + JSON.stringify(r.boolCls));
    truthy(r.kwBoxCls.indexOf('is-disabled') >= 0, '关键词输入框应带 is-disabled 标记，实际 ' + JSON.stringify(r.kwBoxCls));
    const shown = r.notes.filter((n) => !n.hidden);
    eq(shown.length, 1, '无 fetchLabels 时应恰有 1 条可见提示（OCR 那句），实际 ' + JSON.stringify(r.notes));
    eq(shown[0].host, 'fetch', '★ 那句"当前不可用"提示必须随控件一起在 fetch 分区，实际 ' + JSON.stringify(shown));
    truthy(shown[0].text.indexOf('先在上面填要抓的字段') >= 0, '提示应是 C6 改写后的那句，实际 ' + JSON.stringify(shown[0].text));
    falsy(shown[0].text.indexOf('识别图片文字') >= 0, '★ 提示不复述控件名');
    falsy(shown[0].text.indexOf('抓取后续字段') >= 0, '★ 提示不复述模块名');
  });

  await test('★ R4-③：保存拦截**真的不落库**；取消勾选不清空（落库层）；用例零污染', async () => {
    await openFreshEditor();
    const LIST = () => opt.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return (r2.keywords || []).map((k) => k.text);
    });
    const before = await LIST();
    falsy(before.indexOf('K70门禁词') >= 0, '★ 上游 K70-③ 的临时关键词必须已被清掉（否则污染后续组），实际 ' + JSON.stringify(before));
    const T = 'R4红队拦截词';

    // ① 勾选 + 空关键词 → 保存：提示 + 弹窗不关 + **存储里不许出现这条**
    await opt.evaluate((t) => {
      const g = (k) => document.getElementById('fld-' + k);
      const setText = (k, v) => { const el = g(k); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      setText('text', t);
      setText('fetchLabels', '应用截图');
      setText('imgOcrKeyword', '');
      const ocr = g('imgOcr'); ocr.checked = true; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    }, T);
    await opt.waitForTimeout(800);
    const blocked = await opt.evaluate(async (t) => {
      const box = document.querySelector('.kh-editor-err');
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return {
        errShown: !!box && !box.hidden, errText: box ? box.textContent : '',
        stillOpen: !!document.querySelector('.kh-editor'),
        stored: (r2.keywords || []).filter((k) => k.text === t).length
      };
    }, T);
    console.log('        R4 拦截后：存储命中 ' + blocked.stored + ' 条；提示=' + JSON.stringify(blocked.errText));
    truthy(blocked.errShown && blocked.stillOpen, '勾选却缺关键词：必须弹窗内报错且不关闭，实际 ' + JSON.stringify(blocked));
    truthy(blocked.errText.indexOf('图片命中关键词') >= 0, '拦住理由要点出「图片命中关键词」');
    eq(blocked.stored, 0, '★ 被拦住的保存**不许落库**（不是只弹提示）：存储里出现了 ' + blocked.stored + ' 条');

    // ② 补上关键词 → 落库 → 重开弹窗仍是"勾选 + 关键词 + 挂在 fetch"
    await opt.evaluate(() => {
      const kw = document.getElementById('fld-imgOcrKeyword');
      kw.value = 'R4往返词'; kw.dispatchEvent(new Event('input', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    });
    await opt.waitForTimeout(1000);
    const stored = await opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === t);
      return k ? { imgOcr: !!k.imgOcr, kw: k.imgOcrKeyword, fetch: k.fetchLabels } : null;
    }, T);
    truthy(stored, '补上关键词后应能落库（反证 ① 拦住的确实是 OCR 这道闸）');
    eq(stored.imgOcr, true, '勾选态应落库');
    eq(stored.kw, 'R4往返词', '关键词应落库');
    eq(stored.fetch, '应用截图', '抓取字段应落库');

    truthy(await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const kw = (cfg.keywords || []).find((x) => x.text === t);
      if (!kw) return false;
      KH.ui.openEditor({ keyword: kw, cfg, mode: 'options' });
      return true;
    }, T), '应能用落库后的关键词重开编辑弹窗');
    await opt.waitForTimeout(800);
    const back = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const el = g('imgOcr');
      /* 2.0.2.7：候选字段的值住在**胶囊**里（真输入框常态 display:none，重开弹窗后 value 为空） */
      const kwBox = g('imgOcrKeyword') ? g('imgOcrKeyword').closest('.kh-cand-box') : null;
      const kwName = kwBox ? kwBox.querySelector('.kh-lbl-name') : null;
      return { checked: !!el && el.checked, kw: kwName ? (kwName.textContent || '').trim() : null, sec: el ? el.closest('.kh-editor-sec').getAttribute('data-sec') : null };
    });
    eq(back.checked, true, '重开后「识别图片文字」仍是勾选（字段值不受 UI 重排影响）');
    eq(back.kw, 'R4往返词', '重开后「图片命中关键词」仍是原值');
    eq(back.sec, 'fetch', '重开后控件仍挂在「抓取后续字段」分区');

    // ③ 取消勾选 → 保存：弹窗文本不清空，**存储里也不许被抹掉**（R3 只查了 DOM）
    const un = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const ocr = g('imgOcr');
      ocr.checked = false; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      /* 2.0.2.7：候选字段的值住在**胶囊**里 —— 这里量"弹窗里有没有被清空"要读胶囊文案，
       * 真输入框常态是空的（值只在浮层打开时搬进来）。 */
      const kwBox = g('imgOcrKeyword').closest('.kh-cand-box');
      const kwName = kwBox ? kwBox.querySelector('.kh-lbl-name') : null;
      const inDom = kwName ? (kwName.textContent || '').trim() : '';
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
      return { inDom: inDom, disabledAfterUncheck: g('imgOcrKeyword').disabled };
    });
    await opt.waitForTimeout(1000);
    truthy(un.disabledAfterUncheck, '取消勾选后「图片命中关键词」应回到禁用');
    eq(un.inDom, 'R4往返词', '★ 取消勾选**不得清空**已填关键词（弹窗里）');
    const stored2 = await opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === t);
      return k ? { imgOcr: !!k.imgOcr, kw: k.imgOcrKeyword } : null;
    }, T);
    truthy(stored2, '取消勾选后保存仍应落库');
    eq(stored2.imgOcr, false, '取消勾选后 imgOcr 应落 false');
    eq(stored2.kw, 'R4往返词', '★ 取消勾选**不许**把已填关键词从存储里抹掉（落库层）');

    // ④ 收尾：删掉本用例自己造的关键词，并断言清单逐字复原（零污染）
    await closeEditor();
    const after = await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const hit = (cfg.keywords || []).filter((k) => k.text === t);
      if (hit.length) await KH.Store.removeKeywords(hit.map((k) => k.id));
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return { removed: hit.length, texts: (r2.keywords || []).map((k) => k.text) };
    }, T);
    eq(after.removed, 1, '正好应删掉 1 条本用例自己造的关键词，实际 ' + JSON.stringify(after));
    eq(after.texts.join('/'), before.join('/'), '★ 用例必须**零污染**：关键词清单应与本用例开始时逐字相同');
  });

  await test('★ 四个候选框都不许超出所在卡片（2.0.2.16 需求①③：一处改四处统一）', async () => {
    await openFreshEditor();
    /* 让四个框都可用：勾上「抓取后续字段」与「识别图片文字」（否则标题词/图词是禁用态，量不到真排版） */
    await opt.evaluate(() => {
      const on = (k) => {
        const cb = document.getElementById('fld-' + k);
        if (!cb || cb.checked) return;
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      };
      on('fetchEnabled');
      on('imgOcr');
    });
    await opt.waitForTimeout(500);
    const IDS = ['fld-text', 'fld-cellVerify', 'fld-fetchLabels', 'fld-imgOcrKeyword'];
    const measure = (ids) => {
      const vw = document.documentElement.clientWidth;
      const out = { pageOverflow: document.documentElement.scrollWidth > vw + 1, page: { scrollW: document.documentElement.scrollWidth, clientW: vw }, boxes: {} };
      for (const id of ids) {
        const box = document.querySelector('.kh-cand-box[data-for="' + id + '"]');
        if (!box) { out.boxes[id] = null; continue; }
        let card = box;
        while (card && !/kh-editor-sec\b/.test(card.className || '')) card = card.parentElement;
        const b = box.getBoundingClientRect();
        const cr = card ? card.getBoundingClientRect() : null;
        out.boxes[id] = { boxW: Math.round(b.width), cardW: cr ? Math.round(cr.width) : null, overBox: cr ? Math.round(b.right - cr.right) : null };
      }
      return out;
    };
    const base = await opt.evaluate(measure, IDS);
    for (const id of IDS) {
      const r = base.boxes[id];
      truthy(r, id + ' 应存在（四个候选框都要在）');
      truthy(r.boxW <= r.cardW + 1, id + ' 未展开时不许比卡片宽：box ' + r.boxW + ' / card ' + r.cardW);
      truthy(r.overBox <= 0, id + ' 未展开时右边界不许出卡片：over ' + r.overBox);
    }
    eq(base.pageOverflow, false, '未展开时整页不许横向溢出：' + JSON.stringify(base.page));
    /* 列表模式：点「修改」开浮层弹窗（不进卡片流），候选框宽度与整页宽度都不许变 */
    const beforeOpen = base.boxes['fld-text'];
    await opt.click('.kh-cand-box[data-for="fld-text"] .kh-list-btn');
    await opt.waitForTimeout(300);
    const listBox = await opt.$('.kh-modal .kh-list-box');
    truthy(!!listBox, '点「修改」应打开列表弹窗');
    const opened = await opt.evaluate(measure, ['fld-text']);
    eq(opened.boxes['fld-text'].boxW, beforeOpen.boxW, '弹窗是浮层：候选框宽度不受影响');
    eq(opened.pageOverflow, false, '弹窗打开时整页不许横向溢出：' + JSON.stringify(opened.page));
    await opt.keyboard.press('Escape');
    await opt.waitForTimeout(200);
    await closeEditor();
  });

  group('10b. options · 列表弹窗纯呈现（批1）', { aspects: ['ui'] });

  await test('★ 列表弹窗批1：头两行吸顶、行型自报、连续录入不回跳（真机焦点）', async () => {
    await openFreshEditor();
    await opt.evaluate(() => {
      const cb = document.getElementById('fld-fetchEnabled');
      if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await opt.click('.kh-cand-box[data-for="fld-fetchLabels"] .kh-list-btn');
    await opt.waitForTimeout(250);
    const head = await opt.evaluate(() => {
      const h = document.querySelector('.kh-modal .kh-list-head');
      if (!h) return null;
      const type = document.querySelector('.kh-modal .kh-list-type');
      const box = document.querySelector('.kh-modal .kh-list-box');
      const cs = getComputedStyle(h);
      return {
        kids: [...h.children].map((el) => el.className),
        pos: cs.position,
        type: type ? (type.textContent || '').trim() : null,
        rowtype: box ? box.getAttribute('data-rowtype') : null,
        legendRows: document.querySelectorAll('.kh-modal .kh-legend-row').length
      };
    });
    truthy(head, '列表弹窗要有吸顶头容器');
    eq(head.kids.length, 2, '头容器正好两行：' + JSON.stringify(head.kids));
    truthy(/kh-list-addbar/.test(head.kids[0]), '第一行是快加框（主路径是录词）');
    truthy(/kh-list-toolbar/.test(head.kids[1]), '第二行才是筛选');
    eq(head.pos, 'sticky', '头要吸顶（position: sticky）');
    eq(head.type, '抓取字段', '行型要自报家门');
    eq(String(head.rowtype), 'tok', '抓取字段弹窗的 data-rowtype 是 tok');
    truthy(head.legendRows >= 10, '图例一项一行，实测 ' + head.legendRows + ' 行');

    /* 连录两条：每次回车后焦点必须还在快加框里（抢进新行 = 每录一条都要手点回来） */
    const focusLog = [];
    for (const w of ['测试字段甲', '测试字段乙']) {
      await opt.fill('.kh-modal .kh-list-add', w);
      await opt.keyboard.press('Enter');
      await opt.waitForTimeout(140);
      focusLog.push(await opt.evaluate(() => {
        const add = document.querySelector('.kh-modal .kh-list-add');
        return {
          isAdd: document.activeElement === add,
          val: add ? add.value : null,
          n: document.querySelectorAll('.kh-modal .kh-lrow').length
        };
      }));
    }
    truthy(focusLog[0].isAdd && focusLog[1].isAdd, '★ 连续录入时焦点不许被抢进新行：' + JSON.stringify(focusLog));
    eq(focusLog[0].val, '', '加完要清空输入框');
    eq(focusLog[1].n, 2, '两条都要真的进列表：' + JSON.stringify(focusLog));

    await opt.keyboard.press('Escape');
    await opt.waitForTimeout(200);
    await closeEditor();
  });

  await test('★ 候选框展开不许把三列挤变形（2.0.6.4 需求①：47 个词一次灌满）', async () => {
    await openFreshEditor();
    await opt.evaluate(() => {
      const on = (k) => {
        const cb = document.getElementById('fld-' + k);
        if (!cb || cb.checked) return;
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      };
      on('fetchEnabled');
      on('imgOcr');
    });
    // 图片命中关键词只有在「抓取字段非空」时才可编辑（syncCombo 的 hasLabels 闸），先灌抓取字段
    /* 列表弹窗的「添加」输入框：回车即按 | 拆成多行，保存后收回胶囊 */
    await opt.click('.kh-cand-box[data-for="fld-fetchLabels"] .kh-list-btn');
    await opt.waitForTimeout(250);
    await opt.fill('.kh-modal .kh-list-add', '应用功能类型|资质类型|截图#图|开发者');
    await opt.keyboard.press('Enter');
    await opt.click('.kh-modal:has(.kh-list-box) .kh-modal-foot .kh-btn-primary');
    await opt.waitForTimeout(400);
    const WORDS = '车机互联|一对一|1对1|1v1|学法减分|违章查询|水电查询|保查|费查|用查|金查|私密视频|免费上网|GPT|SUNO|'
      + 'BANANA|Nano|Image|GOOGLE|OpenAI|Midjourney|gemini|Grok|微信|绿泡泡|sora|提额|通过率|违章缴费|查询违章|手指测量|'
      + '扫脸测量|数字世界|数字生态|去中心化|登记号#表|认证号#表|著作权人#表|双十一|国庆|中秋|元旦|新年|2025|新春|'
      + '授权方#表|被授权方#表|违章速查';
    const colsOf = () => [...document.querySelectorAll('.kh-editor-col')].map((c) => {
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), top: Math.round(r.top) };
    });
    const before = await opt.evaluate(colsOf);
    eq(before.length, 3, '编辑弹窗应是三列：' + JSON.stringify(before));

    // 列表弹窗灌整串 → 保存后收回胶囊（与用户「一次粘贴几十个词」同一条路径）
    await opt.click('.kh-cand-box[data-for="fld-imgOcrKeyword"] .kh-list-btn');
    await opt.waitForTimeout(250);
    await opt.fill('.kh-modal .kh-list-add', WORDS);
    await opt.waitForTimeout(200);
    await opt.keyboard.press('Enter');
    await opt.click('.kh-modal:has(.kh-list-box) .kh-modal-foot .kh-btn-primary');
    await opt.waitForTimeout(400);
    const chips = await opt.evaluate(() => document.querySelectorAll('.kh-cand-box[data-for="fld-imgOcrKeyword"] .kh-lbl-chip').length);
    const wantChips = WORDS.split('|').length;
    eq(chips, wantChips, wantChips + ' 个词应全部变成胶囊，实测 ' + chips);

    // 展开（点「展开」），整列不许被内容撑宽，三列也不许换行
    await opt.evaluate(() => {
      const box = document.querySelector('.kh-cand-box[data-for="fld-imgOcrKeyword"]');
      const btn = box.querySelector('.kh-clamp-btn');
      if (btn && btn.textContent === '展开') btn.click();
    });
    await opt.waitForTimeout(400);
    const after = await opt.evaluate(colsOf);
    const openCls = await opt.evaluate(() => document.querySelector('.kh-cand-box[data-for="fld-imgOcrKeyword"]').className);
    truthy(/is-open/.test(openCls), '点展开后应带 is-open：' + openCls);
    const ws = after.map((c) => c.w);
    truthy(Math.max(...ws) - Math.min(...ws) <= 1, '三列应等宽（不许某一列被内容撑宽）：' + JSON.stringify(after));
    truthy(after[0].top === after[1].top && after[1].top === after[2].top,
      '三列应在同一行（第三列 = 重要笔记，不许被挤到下一行）：' + JSON.stringify(after));
    const geo = await opt.evaluate(() => {
      const box = document.querySelector('.kh-cand-box[data-for="fld-imgOcrKeyword"]');
      let card = box;
      while (card && !/kh-editor-sec\b/.test(card.className || '')) card = card.parentElement;
      const b = box.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      return { boxW: Math.round(b.width), cardW: Math.round(cr.width), over: Math.round(b.right - cr.right), pageOver: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    });
    truthy(geo.boxW <= geo.cardW + 1, '展开后候选框不许比所在卡片宽：box ' + geo.boxW + ' / card ' + geo.cardW);
    truthy(geo.over <= 0, '展开后右边界不许出卡片：over ' + geo.over);
    eq(geo.pageOver, false, '展开后整页不许横向溢出');
    await closeEditor();
  });

  await test('★ R4-④：副作用量测 —— 弹窗高度与 combo 标题行折行（只量不判，供 R0 决策）', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      /* 量测用例必须**对布局免疫**（反向验证时标题行/胶囊都可能不存在）：
       * 取不到的元素一律给 -1，绝不抛异常 —— 否则"量测失败"会被误读成"目标用例变红"。 */
      const bb = (e) => {
        if (!e) return { t: -1, b: -1, h: -1, w: -1, r: -1 };
        const x = e.getBoundingClientRect();
        return { t: Math.round(x.top), b: Math.round(x.bottom), h: Math.round(x.height), w: Math.round(x.width), r: Math.round(x.right) };
      };
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      const row = sec.querySelector('.kh-editor-sec-headrow');
      const head = sec.querySelector('.kh-editor-sec-head');
      const title = sec.querySelector('.kh-editor-sec-title');
      const hint = sec.querySelector('.kh-editor-sec-hint');
      const chip = sec.querySelector('.kh-editor-sec-extra .kh-fld-chip');
      const extra = sec.querySelector('.kh-editor-sec-extra');
      const modal = document.querySelector('.kh-modal');
      const before = bb(modal).h;
      const prev = hint.style.display;
      hint.style.display = 'none';                       // 试验①：藏掉 combo 的说明文字能省多少高
      const withoutHint = bb(modal).h;
      hint.style.display = prev;
      const rowWithoutChip = (() => {                    // 试验②：标题行里不放胶囊（＝K70 之前的形态）
        if (!extra) return { rowH: bb(row || head).h, modalH: before };
        const p = extra.style.display;
        extra.style.display = 'none';
        const r = { rowH: bb(row || head).h, modalH: bb(modal).h };
        extra.style.display = p;
        return r;
      })();
      return {
        headChipPresent: !!chip,
        modalH: before, modalWithoutComboHint: withoutHint, hintCost: before - withoutHint,
        modalWithoutHeadChip: rowWithoutChip.modalH, headRowHWithoutChip: rowWithoutChip.rowH,
        headChipCost: before - rowWithoutChip.modalH,
        rowH: bb(row || head).h, headH: bb(head).h, titleH: bb(title).h, chipH: bb(chip).h,
        hintH: bb(hint).h, hintW: bb(hint).w,
        hintWrapped: bb(hint).h > bb(title).h + 2,
        secH: bb(sec).h, viewportH: window.innerHeight
      };
    });
    console.log('        R4 副作用量测: ' + JSON.stringify(r));
    truthy(r.modalH <= r.viewportH, '弹窗高度不该超过视口，实际 ' + r.modalH + ' vs ' + r.viewportH);
    truthy(!r.hintWrapped || r.hintCost >= 0, '量测自洽性检查');
  });

  await test('★ K71-①：抓取模块总开关 —— 未勾选→四字段真禁用且内容保留、勾回可编辑、落库能看到"未启用 + 字段仍在"', async () => {
    const before = await opt.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return (r2.keywords || []).map((k) => k.text);
    });
    const T = 'K71抓取门词';
    await openFreshEditor();

    // ① 新建词：抓取胶囊**默认未勾选**（K75 用户口径："抓取后续字段的启用改为默认关闭"）
    const fresh = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const chip = document.getElementById('fld-fetchEnabled');
      const bb = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const box = (k) => g(k).closest('.kh-fld, .kh-fld-bool');
      const keys = ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'];
      return {
        checked: !!chip && chip.checked,
        text: (chip && chip.closest('.kh-fld-chip') && chip.closest('.kh-fld-chip').querySelector('.kh-fld-chip-t').textContent) || null,
        disabled: keys.map((k) => !!g(k) && g(k).disabled),
        cls: keys.map((k) => box(k).className),
        visible: keys.map((k) => bb(box(k))),
        inFetch: !!chip && chip.closest('.kh-editor-sec').getAttribute('data-sec') === 'fetch'
      };
    });
    falsy(fresh.checked, '★ 新建关键词时抓取胶囊默认＝**未勾选**（K75 用户口径，与「单元格组合」「重要笔记」一致）');
    eq(fresh.text, '启用', '第 4 颗胶囊的文案必须是「启用」');
    truthy(fresh.inFetch, '它必须在「抓取后续字段」分区里');
    /* 模块默认关 ⇒ 五个控件一开始就都不可操作（真禁用：disabled + is-disabled + 几何仍在），
     * 勾上「启用」之后才可编辑（下面 ② 判）。 */
    eq(fresh.disabled.join('/'), 'true/true/true/true/true',
      '★ 新建（模块默认关）时五个控件都应 disabled：' + JSON.stringify(fresh));
    fresh.cls.forEach((c, i) => truthy(c.indexOf('is-disabled') >= 0, '第 ' + (i + 1) + ' 个容器应带 is-disabled 标记，实际 ' + JSON.stringify(c)));
    eq(fresh.visible.join('/'), 'true/true/true/true/true', '是"被禁用"而不是"被藏起来"（几何宽高都要 > 0）');

    // ② 勾上「启用」→ 填一组值（含 OCR 那三个）→ 再取消勾选
    const off = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const setText = (k, v) => { const el = g(k); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      /* 先勾上模块开关（默认是关的）：勾上后字段才可填（用户口径："开启后才能填内容"） */
      const en = g('fetchEnabled'); en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      const editable = ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => !g(k).disabled);
      setText('text', 'K71抓取门词');
      setText('fetchLabels', '应用截图');
      const ocr = g('imgOcr'); ocr.checked = true; ocr.dispatchEvent(new Event('change', { bubbles: true }));
      setText('imgOcrKeyword', '一对一');
      setText('imgOcrMax', '3');
      /* 先记下"模块开着时"的可编辑态（＝勾选后才填得进内容，用户口径） */
      const usable = ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => !g(k).disabled);
      const on = g('fetchEnabled').checked;
      g('fetchEnabled').checked = false; g('fetchEnabled').dispatchEvent(new Event('change', { bubbles: true }));
      const bb = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const box = (k) => g(k).closest('.kh-fld, .kh-fld-bool');
      return {
        onBeforeUncheck: on,
        editable: editable,
        usable: usable,
        disabled: ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => !!g(k).disabled),
        cls: ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => box(k).className),
        visible: ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => bb(box(k))),
        values: { labels: g('fetchLabels').value, kw: g('imgOcrKeyword').value, max: g('imgOcrMax').value, ocr: g('imgOcr').checked }
      };
    });
    /* 勾上「启用」后：字段输入框与「抓取范围」可编辑；**OCR 那三个仍按 K70 前置条件禁用**
     * （还没填「字段」）—— 下面填完字段并勾选识别后，五个都会解禁（`usable`）。 */
    eq(off.editable.join('/'), 'true/false/false/false/true',
      '★ 勾上「启用」后「字段」「抓取范围」可编辑，OCR 三控件仍按"字段为空"的前置条件禁用：' + JSON.stringify(off.editable));
    truthy(off.onBeforeUncheck, '前置条件：取消之前是勾选态');
    eq(off.usable.join('/'), 'true/true/true/true/true', '★ 模块开启时可编辑 → 勾选后才能填内容（' + JSON.stringify(off.usable) + '）');
    eq(off.disabled.join('/'), 'true/true/true/true/true', '★ 取消勾选后五个控件必须全部 disabled：' + JSON.stringify(off.disabled));
    off.cls.forEach((c, i) => truthy(c.indexOf('is-disabled') >= 0, '第 ' + (i + 1) + ' 个容器应带 is-disabled 标记，实际 ' + JSON.stringify(c)));
    eq(off.visible.join('/'), 'true/true/true/true/true', '★ 是"被禁用"而不是"被藏起来"（几何宽高都要 > 0）：' + JSON.stringify(off.visible));
    eq(off.values.labels, '应用截图', '★ 已填的抓取字段不得被清空');
    eq(off.values.kw, '一对一', '★ 已填的图片命中关键词不得被清空');
    eq(off.values.max, '3', '已填的每处最多不得被清空');

    // ③ 点它的文字也不该改变任何东西（真禁用，不是只加了个灰样式）
    const clicked = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const lbl = g('imgOcr').parentNode.querySelector('.kh-fld-bool-label');
      if (lbl) lbl.click();
      if (g('imgOcr')) g('imgOcr').click();
      return { ocr: g('imgOcr').checked, on: g('fetchEnabled').checked, labels: g('fetchLabels').value };
    });
    eq(clicked.ocr, true, 'disabled 的勾选行点文字/点框都不该翻转状态');
    eq(clicked.on, false, '抓取开关仍是未勾选（没有被别处的点击带跑）');
    eq(clicked.labels, '应用截图', '值仍在');

    // ④ 勾回来 → 恢复可编辑、值仍在（"填了内容可以关闭，内容保留"）
    const back = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      g('fetchEnabled').checked = true; g('fetchEnabled').dispatchEvent(new Event('change', { bubbles: true }));
      return {
        disabled: ['fetchLabels', 'imgOcr', 'imgOcrKeyword', 'imgOcrMax', 'fetchScope'].map((k) => !!g(k).disabled),
        labels: g('fetchLabels').value, kw: g('imgOcrKeyword').value
      };
    });
    eq(back.disabled.join('/'), 'false/false/false/false/false', '勾回后五个控件应恢复可编辑（OCR 那三个按 K70 既有条件）');
    eq(back.labels, '应用截图', '勾回后值仍在');
    eq(back.kw, '一对一', '勾回后值仍在');

    // ⑤ 再关一次并保存 → 落库必须能看到"未启用 + fetchLabels / OCR 文本仍在"
    await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      g('fetchEnabled').checked = false; g('fetchEnabled').dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    });
    await opt.waitForTimeout(1000);
    const stored = await opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === t);
      return k ? { fetchEnabled: k.fetchEnabled, labels: k.fetchLabels, kw: k.imgOcrKeyword, max: k.imgOcrMax } : null;
    }, T);
    truthy(stored, '应能保存（关闭开关不影响保存）');
    eq(stored.fetchEnabled, false, '★ 开关必须落库为 false（否则"关闭后内容保留但真的不生效"做不到）');
    eq(stored.labels, '应用截图', '★ 关闭后 fetchLabels 仍要落库（内容保留）');
    eq(stored.kw, '一对一', '关闭后图片命中关键词仍要落库');
    eq(stored.max, 3, '关闭后每处最多仍要落库');

    // ⑥ 收尾：删掉本用例自己造的词，断言清单逐字复原（零污染）
    await closeEditor();
    const after = await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const hit = (cfg.keywords || []).filter((k) => k.text === t);
      if (hit.length) await KH.Store.removeKeywords(hit.map((k) => k.id));
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return { removed: hit.length, texts: (r2.keywords || []).map((k) => k.text) };
    }, T);
    eq(after.removed, 1, '正好应删掉 1 条本用例自己造的关键词，实际 ' + JSON.stringify(after));
    eq(after.texts.join('/'), before.join('/'), '★ 用例必须**零污染**：关键词清单应与本用例开始时逐字相同');
  });

  await test('★ K71-②：方向自适应 —— 上下格时「取值格（右起）」禁用 + 恰 1 条说明，切回左右格复原且值保留', async () => {
    await openFreshEditor();
    const setup = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const setText = (k, v) => { const el = g(k); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const on = g('cellVerifyEnabled'); on.checked = true; on.dispatchEvent(new Event('change', { bubbles: true }));
      setText('cellVerify', '资质类型');
      setText('cellOffset', '2');
      return true;
    });
    truthy(setup, '应能填好组合词（标题词 + 取值格）');

    /** 读「取值格」的状态 + combo 区**可见**说明条数（改状态与读状态必须分两次，避开过渡中间值） */
    const readState = () => opt.evaluate(() => {
      const el = document.getElementById('fld-cellOffset');
      const box = el.closest('.kh-fld');
      const b = box.getBoundingClientRect();
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      const notes = Array.from(sec.querySelectorAll('.kh-editor-axis-note')).filter((n) => !n.hidden);
      return {
        disabled: !!el.disabled, cls: box.className,
        w: Math.round(b.width), h: Math.round(b.height), value: el.value,
        notes: notes.length, noteText: notes.length ? notes[0].textContent : ''
      };
    });

    // ① 左右格：字段可用、无说明
    const lr = await readState();
    falsy(lr.disabled, '左右格时「取值格（右起）」应可用：' + JSON.stringify(lr));
    falsy(lr.cls.indexOf('is-disabled') >= 0, '不该带 is-disabled');
    eq(lr.notes, 0, '左右格时 combo 区不该有可见说明，实际 ' + JSON.stringify(lr));

    // ② 切到上下格：**等一拍再读**（.kh-fld-chip 有 transition，K70 R4 踩过过渡中间值）
    await opt.evaluate(() => {
      const sel = document.querySelector('#fld-comboAxis');
      sel.value = 'tb'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await opt.waitForTimeout(450);
    const tb = await readState();
    truthy(tb.disabled, '★ 上下格时必须**禁用**「取值格（右起）」，实际 ' + JSON.stringify(tb));
    truthy(tb.cls.indexOf('is-disabled') >= 0, '容器应带 is-disabled 标记，实际 ' + JSON.stringify(tb.cls));
    truthy(tb.w > 0 && tb.h > 0, '★ 是"被禁用"而不是"被藏起来"（几何宽高都要 > 0）');
    eq(tb.value, '2', '★ 值必须保留（禁用不是清空）');
    eq(tb.notes, 1, '★ combo 区任何时刻最多 1 条可见说明，实际 ' + JSON.stringify(tb));
    truthy(tb.noteText.indexOf('左右格') >= 0 && tb.noteText.indexOf('上下格') >= 0,
      '说明必须讲清"只对左右格成立 / 当前是上下格"，实际 ' + JSON.stringify(tb.noteText));

    // ③ 切回左右格：恢复可用、值仍在、说明收回
    await opt.evaluate(() => {
      const sel = document.querySelector('#fld-comboAxis');
      sel.value = 'lr'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await opt.waitForTimeout(450);
    const lr2 = await readState();
    falsy(lr2.disabled, '切回左右格后应恢复可用：' + JSON.stringify(lr2));
    eq(lr2.value, '2', '★ 切回来值仍是 2');
    eq(lr2.notes, 0, '切回左右格后可见说明应回到 0 条，实际 ' + JSON.stringify(lr2));
    await closeEditor();
  });

  await test('★ K71-③：文案清理清单 —— 正文不复述模块名 / 四条说明是短句且长解释进 tooltip / 提示不复述控件名', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      const secs = ['basic', 'combo', 'fetch', 'imp'].map((id) => {
        const s = document.querySelector('.kh-editor-sec[data-sec="' + id + '"]');
        const title = txt(s.querySelector('.kh-editor-sec-title'));
        const hintEl = s.querySelector('.kh-editor-sec-hint');
        const body = txt(s.querySelector('.kh-editor-sec-body'));
        return {
          id: id, title: title, body: body,
          bodyHasTitle: body.indexOf(title) >= 0,
          hint: txt(hintEl), hintLen: txt(hintEl).length, hintTitle: hintEl ? (hintEl.getAttribute('title') || '') : '',
          fetchLabelCount: (body.match(/识别图片文字/g) || []).length
        };
      });
      const all = txt(document.querySelector('.kh-editor'));
      const box = (k) => {
        const el = document.getElementById('fld-' + k);
        return el ? el.closest('.kh-fld, .kh-fld-bool, .kh-fld-chip, .kh-tool-field') : null;
      };
      const attr = (k, a) => { const el = document.getElementById('fld-' + k); return el ? el.getAttribute(a) : null; };
      const title = (k) => { const b = box(k); return b ? (b.getAttribute('title') || '') : ''; };
      const labelOf = (k) => {
        const b = box(k);
        const l = b && b.querySelector('.kh-fld-label, .kh-fld-bool-label');
        return l ? txt(l) : null;
      };
      return {
        secs: secs,
        panelCount: (all.match(/面板/g) || []).length,
        cellOffsetPlaceholder: attr('cellOffset', 'placeholder'),
        fetchLabelsTitle: title('fetchLabels'),
        imgOcrTitle: title('imgOcr'),
        imgOcrKeywordTitle: title('imgOcrKeyword'),
        imgOcrMaxTitle: title('imgOcrMax'),
        imgSizeTitle: title('imgSize'),
        labels: { fetchLabels: labelOf('fetchLabels'), importantNote: labelOf('importantNote') },
        /* 【2.0.2.11 票 #64】「笔记内容」这行可见标题已按需求删掉；可读名字改由 aria-label 提供
         * （无障碍不能跟着一起删）。 */
        noteAria: (() => {
          const b = box('importantNote');
          if (!b) return '';
          const own = b.getAttribute('aria-label');
          if (own) return own;
          const inner = b.querySelector('[aria-label]');
          return inner ? (inner.getAttribute('aria-label') || '') : '';
        })(),
        comboHintBefore: txt(document.querySelector('.kh-editor-sec[data-sec="combo"] .kh-editor-sec-hint'))
      };
    });

    // 口径 A：模块标题已经写了模块名，正文不得再重复一遍（4 个分区一起判）
    r.secs.forEach((s) => falsy(s.bodyHasTitle,
      '「' + s.title + '」正文里不该再出现模块名，实际 ' + JSON.stringify(s.body.slice(0, 160))));
    // C7：四条说明都是短句 + 长解释进了 tooltip
    r.secs.forEach((s) => {
      truthy(s.hintLen >= 1 && s.hintLen <= 18, '「' + s.title + '」说明应是 1..18 字的短句，实际 ' + s.hintLen + ' 字：' + JSON.stringify(s.hint));
      truthy(s.hintTitle.length > 0, '「' + s.title + '」的长解释必须进 title（tooltip）');
    });
    // C3：全弹窗里「面板」只出现 1 次（标题旁那两句不能是同一件事说两遍）
    eq(r.panelCount, 1, '「面板」在弹窗里应只出现 1 次，实际 ' + r.panelCount);
    // C1 / C2：正文 label 不再复述模块名
    eq(r.labels.fetchLabels, '字段', 'C1：抓取字段输入框的 label 应是「字段」');
    eq(r.labels.importantNote, null, 'C2（2.0.2.11 改口径）：可见的「笔记内容」标题已按需求删掉');
    truthy(r.noteAria.indexOf('笔记') >= 0, '删了可见标题也得留可读名字（aria-label），实际 ' + JSON.stringify(r.noteAria));
    // C4：空值时不再恒显「默认」
    eq(r.cellOffsetPlaceholder, null, 'C4：#fld-cellOffset 必须没有 placeholder（原来恒显「默认」）');
    // C6：控件的可见文本只出现一次，tooltip 不复述它、也不复述模块名
    eq(r.secs[2].fetchLabelCount, 1, 'C6：fetch 正文里「识别图片文字」应恰出现 1 次，实际 ' + r.secs[2].fetchLabelCount);
    ['fetchLabels', 'imgOcr'].forEach((k) => {
      truthy(r[k + 'Title'].length > 0, k + ' 的容器必须有 tooltip（长解释的住处）');
      falsy(r[k + 'Title'].indexOf('抓取后续字段') >= 0, k + ' 的 tooltip 不该复述模块名，实际 ' + JSON.stringify(r[k + 'Title']));
    });
    truthy(r.fetchLabelsTitle.indexOf('留空') >= 0 && r.fetchLabelsTitle.indexOf('本行') >= 0,
      'C1/C8：抓取字段的 tooltip 要讲清"留空"与"按本行"');
    falsy(r.fetchLabelsTitle.indexOf('取值格') >= 0, 'C1：不再拿「取值格（右起）」当参照');
    truthy(r.imgOcrKeywordTitle.indexOf('正则') >= 0, 'C8：图片命中关键词的 tooltip 要讲清是正则');
    // C5：两个 int 字段的提示各说各的对象
    truthy(r.imgOcrMaxTitle.indexOf('张') >= 0, 'C5：「每处最多」的 tooltip 应说张数');
    falsy(r.imgOcrMaxTitle.indexOf('尺寸') >= 0, 'C5：★「每处最多」不该再被写成"默认尺寸"');
    truthy(r.imgSizeTitle.indexOf('尺寸') >= 0, 'C5：「尺寸」的 tooltip 才说尺寸');

    // C7 后半：切到上下格，说明仍是短句、tooltip 仍非空、且文本确实随方向变
    await opt.evaluate(() => {
      const sel = document.querySelector('#fld-comboAxis');
      if (sel) { sel.value = 'tb'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await opt.waitForTimeout(450);
    const tb = await opt.evaluate(() => {
      const el = document.querySelector('.kh-editor-sec[data-sec="combo"] .kh-editor-sec-hint');
      return { h: (el.textContent || '').trim(), t: el.getAttribute('title') || '' };
    });
    truthy(tb.h.length >= 1 && tb.h.length <= 18, '上下格时 combo 说明仍须 ≤18 字，实际 ' + JSON.stringify(tb.h));
    truthy(tb.t.length > 0, '上下格时 combo 说明的 tooltip 仍须非空');
    truthy(tb.h !== r.comboHintBefore, '★ 说明文案必须随方向变，实际 ' + JSON.stringify(tb.h) + ' vs ' + JSON.stringify(r.comboHintBefore));
    await closeEditor();
  });

  await test('★ K71-④：重要笔记开关 —— 未勾选三字段真禁用（富文本含 contenteditable）、内容保留、滚动不锁死；勾回可编辑可保存', async () => {
    const before = await opt.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return (r2.keywords || []).map((k) => k.text);
    });
    const T = 'K71重要笔记词';
    await openFreshEditor();

    // ① 勾选「重要笔记」→ 三字段可编辑；写一份**长正文**（后面用它证明"滚动没被锁死"）
    const on = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const imp = g('important'); imp.checked = true; imp.dispatchEvent(new Event('change', { bubbles: true }));
      const ed = g('importantNote');
      ed.textContent = Array.from({ length: 400 }, (_, i) => '行' + i).join('\n');
      const size = g('imgSize'); size.value = '66'; size.dispatchEvent(new Event('input', { bubbles: true })); size.dispatchEvent(new Event('change', { bubbles: true }));
      const reuse = g('impNoteUseHlColor'); reuse.checked = true; reuse.dispatchEvent(new Event('change', { bubbles: true }));
      ed.scrollTop = 200;
      return {
        ce: ed.getAttribute('contenteditable'),
        scrollable: ed.scrollHeight > ed.clientHeight + 5,
        scrolled: ed.scrollTop > 0,
        overflowY: getComputedStyle(ed).overflowY,
        size: String(size.value), reuse: !!reuse.checked, len: ed.textContent.length,
        btns: ed.closest('.kh-rt-editor').querySelectorAll('button').length
      };
    });
    truthy(on.ce === 'true' || on.ce === null, '勾选态：编辑区必须可编辑，实际 contenteditable=' + JSON.stringify(on.ce));
    truthy(on.scrollable && on.scrolled, '勾选态：长正文应能滚动（这也是后面"滚动没被锁死"的对照臂）');
    eq(on.size, '66', '勾选态：尺寸可填');
    eq(on.reuse, true, '勾选态：底色胶囊可勾');
    console.log('        K71-④ 富文本工具/浮条按钮总数 = ' + on.btns);

    // ② 取消勾选 → 三字段真禁用（容器 is-disabled + 几何仍在 + 富文本显式处理）
    const off = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const imp = g('important'); imp.checked = false; imp.dispatchEvent(new Event('change', { bubbles: true }));
      const ed = g('importantNote');
      const box = ed.closest('.kh-fld');
      const bb = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const sizeBox = g('imgSize').closest('.kh-tool-field');
      const reuseChip = g('impNoteUseHlColor').closest('.kh-tool-field');
      const btns = Array.from(ed.closest('.kh-rt-editor').querySelectorAll('button'));
      return {
        boxCls: box.className, boxVisible: bb(box),
        ce: ed.getAttribute('contenteditable'),
        btns: btns.length, btnsDisabled: btns.filter((b) => b.disabled).length,
        sizeDisabled: !!g('imgSize').disabled, sizeCls: sizeBox.className, sizeVisible: bb(sizeBox),
        reuseDisabled: !!g('impNoteUseHlColor').disabled, reuseCls: reuseChip.className, reuseVisible: bb(reuseChip),
        len: ed.textContent.length,
        overflowY: getComputedStyle(ed).overflowY, pe: getComputedStyle(ed).pointerEvents
      };
    });
    truthy(off.boxCls.indexOf('is-disabled') >= 0, '未勾选：编辑器容器必须带 is-disabled，实际 ' + JSON.stringify(off.boxCls));
    truthy(off.boxVisible, '是"被禁用"而不是"被藏起来"（几何宽高都 > 0）');
    eq(off.ce, 'false', '★ contenteditable 必须显式置 false（它不吃 disabled 属性）');
    truthy(off.btns > 0, '应能数到工具行/浮条按钮，实际 ' + off.btns);
    eq(off.btnsDisabled, off.btns, '★ 工具行/浮条按钮必须全 disabled（' + off.btnsDisabled + '/' + off.btns + '）');
    truthy(off.sizeDisabled && off.sizeCls.indexOf('is-disabled') >= 0 && off.sizeVisible, '未勾选：「尺寸」应禁用且仍可见，实际 ' + JSON.stringify(off));
    truthy(off.reuseDisabled && off.reuseCls.indexOf('is-disabled') >= 0 && off.reuseVisible, '未勾选：「底色」胶囊应禁用且仍可见，实际 ' + JSON.stringify(off));
    eq(off.len, on.len, '★ 内容必须原样保留（一个字符都不许丢）');
    /* 滚动不许被一起锁死：overflow 没被改成 hidden、pointer-events 没被设成 none，
     * 而且**真的**还能滚（程序置 scrollTop 后仍 > 0）。 */
    truthy(off.overflowY === 'auto' || off.overflowY === 'scroll', '滚动容器不能被改成 hidden，实际 overflow-y=' + off.overflowY);
    truthy(off.pe !== 'none', '不许用 pointer-events:none 锁死编辑区（那会连带锁死滚动）');
    const stillScroll = await opt.evaluate(() => {
      const ed = document.getElementById('fld-importantNote');
      ed.scrollTop = 0; ed.scrollTop = 180;
      return { top: ed.scrollTop, scrollable: ed.scrollHeight > ed.clientHeight + 5 };
    });
    truthy(stillScroll.scrollable && stillScroll.top > 0, '★ 未勾选时正文仍必须能滚，实际 ' + JSON.stringify(stillScroll));

    // ③ "不可点"：容器上的捕获拦截必须吞掉点击（否则点正文里的图片/链接会弹出修改对话框）
    const guarded = await opt.evaluate(() => {
      const ed = document.getElementById('fld-importantNote');
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented };
    });
    truthy(guarded.prevented, '★ 未勾选时点击编辑区必须被拦截（defaultPrevented）');

    // ④ 真键入无效：用**真键盘**打字（不是程序改 textContent），内容逐字不变
    const beforeType = await opt.evaluate(() => document.getElementById('fld-importantNote').textContent);
    await opt.click('#fld-importantNote');
    await opt.keyboard.type('XYZ');
    const afterType = await opt.evaluate(() => ({
      text: document.getElementById('fld-importantNote').textContent,
      ce: document.getElementById('fld-importantNote').getAttribute('contenteditable')
    }));
    eq(afterType.text, beforeType, '★ 未勾选时真键入必须无效（R4 探针实测过旧实现：正文末尾多出键入字符）');
    eq(afterType.ce, 'false', '键入后 contenteditable 仍是 false');

    // ⑤ 勾回 → 恢复可编辑、值全在、能保存
    await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const imp = g('important'); imp.checked = true; imp.dispatchEvent(new Event('change', { bubbles: true }));
      g('importantNote').textContent = 'K71笔记正文';         // 收尾：换成短正文再保存
      const t = g('text'); t.value = 'K71重要笔记词'; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const back = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const ed = g('importantNote');
      return {
        ce: ed.getAttribute('contenteditable'),
        btnsEnabled: Array.from(ed.closest('.kh-rt-editor').querySelectorAll('button')).filter((b) => !b.disabled).length,
        boxCls: ed.closest('.kh-fld').className,
        size: String(g('imgSize').value), reuse: !!g('impNoteUseHlColor').checked
      };
    });
    eq(back.ce, 'true', '勾回：contenteditable 必须还原成 true');
    truthy(back.boxCls.indexOf('is-disabled') < 0, '勾回：容器不该还带 is-disabled');
    truthy(back.btnsEnabled > 0, '勾回：工具行按钮必须恢复可用');
    eq(back.size, '66', '勾回：尺寸原值仍在');
    eq(back.reuse, true, '勾回：底色勾选仍在');

    await opt.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    });
    await opt.waitForTimeout(1000);
    const stored = await opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === t);
      return k ? { important: !!k.important, note: k.importantNote, size: k.imgSize, reuse: !!k.impNoteUseHlColor } : null;
    }, T);
    truthy(stored, '勾回后必须能保存落库');
    eq(stored.important, true, '开关应落库为 true');
    truthy(String(stored.note).indexOf('K71笔记正文') >= 0, '笔记正文应落库，实际 ' + JSON.stringify(stored.note));
    eq(stored.size, 66, '尺寸应落库');
    eq(stored.reuse, true, '底色勾选应落库');

    // ⑥ 收尾：删掉本用例自己造的词，断言清单逐字复原（零污染）
    await closeEditor();
    const after = await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const hit = (cfg.keywords || []).filter((k) => k.text === t);
      if (hit.length) await KH.Store.removeKeywords(hit.map((k) => k.id));
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return { removed: hit.length, texts: (r2.keywords || []).map((k) => k.text) };
    }, T);
    eq(after.removed, 1, '正好应删掉 1 条本用例自己造的关键词，实际 ' + JSON.stringify(after));
    eq(after.texts.join('/'), before.join('/'), '★ 用例必须**零污染**：关键词清单应与本用例开始时逐字相同');
  });

  await test('★ K71-⑤：清空标题词 → combo 那句"当前不会生效"必须**立即**收起（不依赖下一次联动事件）', async () => {
    await openFreshEditor();
    const shownNotes = () => opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      const notes = Array.from(sec.querySelectorAll('.kh-editor-axis-note')).filter((n) => !n.hidden);
      return { n: notes.length, text: notes.length ? notes[0].textContent : '' };
    });

    // ① 填了标题词但没勾「启用」→ 说明可见
    const before = await opt.evaluate(() => {
      const cv = document.getElementById('fld-cellVerify');
      cv.value = '资质类型';
      cv.dispatchEvent(new Event('input', { bubbles: true }));
      return cv.value;
    });
    eq(before, '资质类型', '应能填入标题词');
    const on = await shownNotes();
    eq(on.n, 1, '前置：填了标题词但没启用组合 → 应恰有 1 条可见说明，实际 ' + JSON.stringify(on));

    // ② 清空标题词 → **同一个 evaluate 内立刻读**，说明必须已经收起
    const after = await opt.evaluate(() => {
      const cv = document.getElementById('fld-cellVerify');
      cv.value = '';
      cv.dispatchEvent(new Event('input', { bubbles: true }));
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      const notes = Array.from(sec.querySelectorAll('.kh-editor-axis-note')).filter((n) => !n.hidden);
      return { n: notes.length, text: notes.length ? notes[0].textContent : '' };
    });
    eq(after.n, 0, '★ 清空标题词后说明必须**立即**收起（旧实现要等下一次联动事件），实际 ' + JSON.stringify(after));

    // ③ 互斥不变量不破：再填标题词 + 填取值格 + 启用组合 + 切上下格 → 仍最多 1 条可见
    const multi = await opt.evaluate(() => {
      const g = (k) => document.getElementById('fld-' + k);
      const cv = g('cellVerify'); cv.value = '资质类型'; cv.dispatchEvent(new Event('input', { bubbles: true }));
      /* 先填取值格（此时它是禁用态，程序赋值照样有效）——顺序很重要：
       * 后面那次方向 change 会跑 syncCombo → applyAxisLabels，才会按"已填取值格 + 上下格"算出说明 */
      const off2 = g('cellOffset'); off2.value = '2'; off2.dispatchEvent(new Event('input', { bubbles: true }));
      const on2 = g('cellVerifyEnabled'); on2.checked = true; on2.dispatchEvent(new Event('change', { bubbles: true }));
      const sel = g('comboAxis'); sel.value = 'tb'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      const all = Array.from(sec.querySelectorAll('.kh-editor-axis-note'));
      return { total: all.length, visible: all.filter((n) => !n.hidden).length };
    });
    truthy(multi.visible <= 1, '★ combo 区任何时刻最多 1 条可见说明，实际 ' + JSON.stringify(multi));
    eq(multi.total, 2, '节点总数仍是 2（axisNote + offsetNote），实际 ' + multi.total);
    await closeEditor();
  });

  await test('★ K72-①：编辑弹窗「重要笔记」说明行＝左上角（A2 的第 2 处用户可见文案）', async () => {
    await openFreshEditor();
    const r = await opt.evaluate(() => {
      const s = document.querySelector('.kh-editor-sec[data-sec="imp"] .kh-editor-sec-hint');
      return { text: s ? (s.textContent || '').trim() : null, title: s ? (s.getAttribute('title') || '') : '' };
    });
    truthy(r.text, '应能读到 imp 分区的说明行');
    truthy(r.text.indexOf('左上角') >= 0, '★ 说明行应写「左上角」，实际 ' + JSON.stringify(r.text));
    falsy(r.text.indexOf('右上角') >= 0, '★ 说明行不该再有「右上角」，实际 ' + JSON.stringify(r.text));
    truthy(r.title.indexOf('左上角') >= 0, 'tooltip（长解释）同判，实际 ' + JSON.stringify(r.title));
    falsy(r.title.indexOf('右上角') >= 0, 'tooltip 里也不该再有「右上角」');
    await closeEditor();
  });

  await test('★ K74/K79-①：「抓取范围」字段 —— 八档方向/默认 当前层/未启用时真禁用；保存往返（含旧值归一）', async () => {
    const before = await opt.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return (r2.keywords || []).map((k) => k.text);
    });
    const T = 'K74范围词';
    await openFreshEditor();

    // ① 字段存在、是 select、默认 self（当前层）、八个选项文案与顺序固定；模块默认关 ⇒ 禁用，勾上后可用
    const fresh = await opt.evaluate(() => {
      const el = document.getElementById('fld-fetchScope');
      const en = document.getElementById('fld-fetchEnabled');
      const out = {
        found: !!el,
        tag: el ? el.tagName : null,
        value: el ? el.value : null,
        disabled: el ? !!el.disabled : null,
        enabled: !!en && en.checked,
        opts: el ? Array.from(el.options).map((o) => o.value + ':' + (o.textContent || '').trim()) : [],
        inFetch: el ? (el.closest('.kh-editor-sec') || { getAttribute: () => null }).getAttribute('data-sec') : null
      };
      /* 「抓取范围」只看模块开关（K74/K75）：勾上「启用」后才可编辑 */
      en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      out.afterEnable = !el.disabled;
      out.valueAfterEnable = el.value;
      return out;
    });
    truthy(fresh.found, '字段表必须有 fetchScope 的控件');
    eq(fresh.tag, 'SELECT', '抓取范围是下拉（type: select）');
    eq(fresh.value, 'self', '★ K79 起默认＝当前层（新建关键词从这里起步）');
    falsy(fresh.enabled, '前置：抓取模块默认未勾选（K75 口径）');
    truthy(fresh.disabled, '★ 模块未启用时「抓取范围」必须 disabled');
    truthy(fresh.afterEnable, '★ 勾上「启用」后「抓取范围」应可编辑');
    eq(fresh.valueAfterEnable, 'self', '勾上开关不改值');
    eq(fresh.inFetch, 'fetch', '它归属「抓取后续字段」分区');
    eq(fresh.opts.join('|'),
      'auto:自动（就近一层）|self:当前层|inner:内层|outer:外层|' +
      'self+inner:当前层 + 内层|self+outer:当前层 + 外层|inner+outer:内层 + 外层|self+inner+outer:当前层 + 内层 + 外层',
      '★ 八档＝三个方向的全部非空子集（文案与顺序按 K79 契约）');

    // ② 未勾「启用」→ 真禁用（disabled + is-disabled + 几何仍在）
    const off = await opt.evaluate(() => {
      const el = document.getElementById('fld-fetchScope');
      const en = document.getElementById('fld-fetchEnabled');
      en.checked = false; en.dispatchEvent(new Event('change', { bubbles: true }));
      const box = el.closest('.kh-fld');
      const b = box.getBoundingClientRect();
      return { disabled: !!el.disabled, cls: box.className, w: Math.round(b.width), h: Math.round(b.height), value: el.value };
    });
    truthy(off.disabled, '★ 未勾「启用」时「抓取范围」必须 disabled，实际 ' + JSON.stringify(off));
    truthy(off.cls.indexOf('is-disabled') >= 0, '容器应带 is-disabled 标记，实际 ' + JSON.stringify(off.cls));
    truthy(off.w > 0 && off.h > 0, '是"被禁用"而不是"被藏起来"');
    eq(off.value, 'self', '禁用不改值');

    // ③ 勾回 → 选「当前层 + 内层 + 外层」（旧值 all 的等价档）→ 保存 → 落库规范化值
    await opt.evaluate((t) => {
      const g = (k) => document.getElementById('fld-' + k);
      const en = g('fetchEnabled'); en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      const tx = g('text'); tx.value = t; tx.dispatchEvent(new Event('input', { bubbles: true })); tx.dispatchEvent(new Event('change', { bubbles: true }));
      const lb = g('fetchLabels'); lb.value = '驳回原因'; lb.dispatchEvent(new Event('input', { bubbles: true })); lb.dispatchEvent(new Event('change', { bubbles: true }));
      const sc = g('fetchScope'); sc.value = 'self+inner+outer'; sc.dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.kh-modal .kh-btn'));
      const save = btns.reverse().find((b) => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (save) save.click();
    }, T);
    await opt.waitForTimeout(1000);
    const stored = await opt.evaluate(async (t) => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      const k = (r2.keywords || []).find((x) => x.text === t);
      return k ? { scope: k.fetchScope, labels: k.fetchLabels } : null;
    }, T);
    truthy(stored, '应能保存');
    eq(stored.scope, 'self+inner+outer', '★ 落库层 fetchScope 必须是我们选的那个值');
    eq(stored.labels, '驳回原因', '同一次保存里抓取字段也在');

    // ③b 旧值归一（真机走 store 写路径）：outer1 / outermost / all / 缺键 各有确定映射
    const norm = await opt.evaluate(async () => {
      const cfg = await KH.Store.load();
      const f = (v) => KH.Store.sanitizeKeyword(Object.assign({ text: '归一探针' }, v === undefined ? {} : { fetchScope: v }), cfg).fetchScope;
      return { outer1: f('outer1'), outermost: f('outermost'), all: f('all'), missing: f(undefined), auto: f('auto') };
    });
    eq(norm.outer1, 'outer', '★ 旧值 outer1 → outer');
    eq(norm.outermost, 'outer', '★ 旧值 outermost → outer');
    eq(norm.all, 'self+inner+outer', '★ 旧值 all → 当前层+内层+外层');
    eq(norm.missing, 'auto', '★ 缺键 → auto（存量配置不许因为默认改成当前层而少抓外层字段）');
    eq(norm.auto, 'auto', '旧值 auto 原样保留');

    // ④ 重开弹窗 → 仍是所选值（保存往返）
    const reopened = await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const kw = (cfg.keywords || []).find((x) => x.text === t);
      if (!kw) return null;
      KH.ui.openEditor({ keyword: kw, cfg, mode: 'options' });
      return true;
    }, T);
    truthy(reopened, '应能用落库后的关键词重开编辑弹窗');
    await opt.waitForTimeout(800);
    const back = await opt.evaluate(() => {
      const el = document.getElementById('fld-fetchScope');
      return { value: el ? el.value : null };
    });
    eq(back.value, 'self+inner+outer', '★ 重开后「抓取范围」仍是所选值（保存往返）');

    // ⑤ 收尾：删掉本用例自己造的词，断言清单逐字复原（零污染）
    await closeEditor();
    const after = await opt.evaluate(async (t) => {
      const cfg = await KH.Store.load();
      const hit = (cfg.keywords || []).filter((k) => k.text === t);
      if (hit.length) await KH.Store.removeKeywords(hit.map((k) => k.id));
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return { removed: hit.length, texts: (r2.keywords || []).map((k) => k.text) };
    }, T);
    eq(after.removed, 1, '正好应删掉 1 条本用例自己造的关键词，实际 ' + JSON.stringify(after));
    eq(after.texts.join('/'), before.join('/'), '★ 用例必须**零污染**：关键词清单应与本用例开始时逐字相同');
  });

  await test('★ 保存往返：标题词 / 核心词 / 抓取字段 / 匹配开关 逐字段一致（附录A §7）', async () => {
    // 弹窗可能已被上一个用例关掉；这里确保它是打开的
    const open = await opt.evaluate(() => !!document.querySelector('.kh-editor'));
    if (!open) { await opt.evaluate(() => document.getElementById('btn-kw-add').click()); await waitForEditor(); }

    // 在弹窗里填一组已知值（按 fld-<key> 精确定位，不用猜控件类型）
    const filled = await opt.evaluate(() => {
      const byKey = (k) => document.getElementById('fld-' + k);
      const setText = (k, v) => { const el = byKey(k); if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      const setBool = (k, v) => { const el = byKey(k); if (!el) return false; el.checked = !!v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };

      const okText = setText('text', '往返核心词');
      setBool('cellVerifyEnabled', true);
      const okCv = setText('cellVerify', '往返标题词');
      const okFetch = setText('fetchLabels', '甲字段，乙字段');   // 故意用中文逗号，验证归一化
      setBool('caseSensitive', true);
      setBool('important', true);
      /* 颜色字段（color 控件）也要覆盖：它一度**没有** id，导致 `#fld-bgColor` 根本不存在
       * —— 就是因为原来的往返用例只填文本/开关，才让这个缺口溜了过去。
       * 注意 id 挂在**色块按钮**上（labelable，label 点一下就能开取色浮层），
       * 赋值要走它的组合控件（`.kh-color-field` 上挂着 setValue）。 */
      const setColor = (k, v) => {
        const el = byKey(k); if (!el) return false;
        const cf = el.closest('.kh-color-field');
        if (!cf || typeof cf.setValue !== 'function') return false;
        cf.setValue(v);
        return true;
      };
      const okBg = setColor('bgColor', '#123456');
      const okFg = setColor('textColor', '#abcdef');

      return {
        okText, okCv, okFetch, okBg, okFg,
        present: {
          text: !!byKey('text'), cellVerify: !!byKey('cellVerify'), fetchLabels: !!byKey('fetchLabels'),
          bgColor: !!byKey('bgColor'), textColor: !!byKey('textColor')
        },
        values: { text: (byKey('text') || {}).value, cellVerify: (byKey('cellVerify') || {}).value, fetchLabels: (byKey('fetchLabels') || {}).value }
      };
    });
    console.log('        填写值: ' + JSON.stringify(filled.values));
    truthy(filled.okText && filled.okCv && filled.okFetch,
      '应能用 fld-<key> 定位到三个控件，实际 ' + JSON.stringify(filled.present));
    truthy(filled.present.bgColor && filled.present.textColor,
      '颜色字段也必须带 id=fld-<key>（否则保存往返无法逐字段断言 / label 绑不到控件），实际 ' + JSON.stringify(filled.present));

    // 点保存（弹窗底栏的「添加」按钮；用 evaluate 点击以绕开遮罩的指针拦截）
    await opt.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.kh-btn'));
      const btn = btns.reverse().find(b => /^(保存|添加)$/.test((b.textContent || '').trim()));
      if (btn) btn.click();
    });
    await opt.waitForTimeout(1000);

    const stored = await opt.evaluate(async () => {
      const r = await new Promise(res => chrome.storage.local.get(['keywords'], res));
      return (r.keywords || []).filter(k => k.text === '往返核心词' || k.cellVerify === '往返标题词');
    });
    truthy(stored.length === 1, '存储里应恰好有一条新词，实际 ' + JSON.stringify(stored.map(k => k.text)));
    const k = stored[0];
    eq(k.text, '往返核心词', '核心词必须原样落库');
    eq(k.cellVerify, '往返标题词', '标题词必须原样落库');
    eq(k.fetchLabels, '甲字段|乙字段', '抓取字段应落库且分隔符归一化为 |（且绝不能被标题词污染）');
    eq(k.caseSensitive, true, '区分大小写开关应落库');
    eq(k.important, true, '重要开关应落库');
    eq(k.bgColor, '#123456', '背景色应落库（color 控件曾漏 id，这行就是它的护栏）');
    eq(k.textColor, '#abcdef', '文字颜色应落库');
    falsy(/往返标题词/.test(String(k.fetchLabels)), '★ 抓取字段绝不能被标题词污染');
    falsy(/甲字段|乙字段/.test(String(k.cellVerify)), '★ 标题词绝不能被抓取字段污染');
    console.log('        落库: ' + JSON.stringify({ text: k.text, cellVerify: k.cellVerify, fetchLabels: k.fetchLabels }));
  });

  await test('编辑弹窗底部按钮固定（内容滚动时不动）', async () => {
    await opt.evaluate(() => document.getElementById('btn-kw-add').click());
    await opt.waitForTimeout(500);
    const r = await opt.evaluate(() => {
      const foot = document.querySelector('.kh-modal__foot, .kh-editor-foot, .kh-modal-foot, .kh-modal-footbar');
      const body = document.querySelector('.kh-modal__body, .kh-editor-body, .kh-modal-body');
      if (!foot || !body) return { err: 'no foot/body', foot: !!foot, body: !!body };
      const ft0 = foot.getBoundingClientRect().top;
      body.scrollTop = 300;
      const ft1 = foot.getBoundingClientRect().top;
      return { ft0, ft1, moved: Math.abs(ft1 - ft0) };
    });
    truthy(!r.err, '应有底栏与内容区：' + JSON.stringify(r));
    truthy(r.moved < 4, '底部按钮不应随内容滚动，位移 ' + r.moved);
    await opt.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.kh-btn')).find(b => /取消/.test((b.textContent || '').trim()));
      if (btn) btn.click();
    });
    await opt.waitForTimeout(300);
  });

  await test('组合方向切到「上下格」→ 标题词字段文案联动', async () => {
    await opt.evaluate(() => document.getElementById('btn-kw-add').click());
    await opt.waitForTimeout(500);
    const before = await opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      return sec ? sec.textContent : '';
    });
    await opt.evaluate(() => {
      const sel = document.getElementById('fld-comboAxis');
      if (!sel) return;
      sel.value = 'tb';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await opt.waitForTimeout(350);
    const after = await opt.evaluate(() => {
      const sec = document.querySelector('.kh-editor-sec[data-sec="combo"]');
      return sec ? sec.textContent : '';
    });
    console.log('        lr 文案: ' + JSON.stringify(before.slice(0, 100)));
    console.log('        tb 文案: ' + JSON.stringify(after.slice(0, 100)));
    truthy(before !== after, '切换组合方向后文案应联动变化（左右格 ↔ 上下格/列关键词）');
    await opt.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.kh-btn')).find(b => /取消/.test((b.textContent || '').trim()));
      if (btn) btn.click();
    });
    await opt.waitForTimeout(300);
  });

  group('11. options · 分组 / 站点 / 导入导出', { aspects: ['ui'] });

  await test('分组分区存在且能列出分组', async () => {
    const r = await opt.evaluate(() => {
      const el = document.getElementById('group-list');
      return { exists: !!el, text: el ? el.textContent.trim().slice(0, 80) : '' };
    });
    truthy(r.exists, '应有 #group-list');
    includes(r.text, '分组甲', '应显示注入的分组「分组甲」');
  });

  await test('★ 分组弹窗与关键词弹窗共用字段工厂（控件形态一致 + 保存往返）', async () => {
    await opt.click('.kh-tab[data-tab="groups"]');
    await opt.waitForTimeout(300);
    await opt.click('#btn-group-add');
    await opt.waitForTimeout(500);

    // ① 形态与 id 契约：与关键词弹窗同一套（开关胶囊 / 颜色胶囊 / 行内字段 / id + label for）
    const form = await opt.evaluate(() => {
      const modal = document.querySelector('.kh-modal');
      if (!modal) return null;
      const one = (sel) => modal.querySelector(sel);
      const chips = Array.from(modal.querySelectorAll('.kh-fld-chip')).map((c) => ({
        text: (c.querySelector('.kh-fld-chip-t') || {}).textContent,
        color: c.classList.contains('kh-color-chip'),
        id: (c.querySelector('input') || c).id || ''
      }));
      const fields = Array.from(modal.querySelectorAll('.kh-fld')).map((f) => {
        const lab0 = f.querySelector('label.kh-fld-label');
        /* 【2.0.2.11】重要笔记的工具栏也在 `.kh-fld` 里，第一个 `input` 是底色的勾选框（隐藏的），
         * 按"第一个 input"取控件会取错人。改成先认 label 的 `for` 指向的那个控件。 */
        const byFor = lab0 && lab0.htmlFor ? document.getElementById(lab0.htmlFor) : null;
        const ctrl = (byFor && f.contains(byFor)) ? byFor : f.querySelector('[contenteditable], textarea, select, input, .kh-color-field');
        const lab = lab0;
        return {
          label: lab ? lab.textContent : '',
          id: ctrl ? (ctrl.id || (ctrl.querySelector && ctrl.querySelector('[id]') ? ctrl.querySelector('[id]').id : '')) : '',
          forAttr: lab ? lab.htmlFor : '',
          inline: f.classList.contains('kh-fld-inline')
        };
      });
      return {
        chips, fields,
        toolCount: modal.querySelectorAll('.kh-rt-toolbar .kh-tool-field').length,
        legacyCheck: modal.querySelectorAll('.kh-check').length,
        visibleCheckbox: Array.from(modal.querySelectorAll('input[type=checkbox]'))
          .filter((c) => c.getBoundingClientRect().width > 2).length,
        colorChips: modal.querySelectorAll('.kh-color-chip').length
      };
    });
    truthy(form, '分组弹窗应能打开');
    console.log('        分组弹窗胶囊: ' + JSON.stringify(form.chips.map((c) => c.text)) +
      ' 字段: ' + JSON.stringify(form.fields.map((f) => f.label + (f.inline ? '(inline)' : ''))));
    eq(form.chips.map((c) => c.text).join('/'), '底/文/重要',
      '分组弹窗应是 颜色胶囊(底/文) + 开关胶囊(重要)，实际 ' + JSON.stringify(form.chips.map((c) => c.text)));
    /* 【2.0.2.11 票 #64】底色/尺寸/字号改成「住进笔记工具栏」的控件（与关键词弹窗同一套字段工厂），
     * 所以不再是 `.kh-fld-chip` / `.kh-fld-inline`：判据改看它们真在工具栏那一行里。 */
    eq(form.toolCount, 3, '底色/尺寸/字号三件应住进分组重要笔记的工具栏，实际 ' + form.toolCount);
    eq(form.colorChips, 2, '底/文 应是颜色胶囊（与关键词弹窗同形）');
    eq(form.legacyCheck, 0, '不该再用旧的 .kh-check 勾选框样式');
    eq(form.visibleCheckbox, 0, '胶囊里的勾选框必须是视觉隐藏的（状态只看颜色）');
    form.fields.forEach((f) => {
      truthy(/^fld-g-/.test(f.id), '字段「' + f.label + '」应有 id=fld-g-<key>，实际 ' + JSON.stringify(f.id));
      eq(f.forAttr, f.id, '字段「' + f.label + '」的 label 必须 for 到控件');
    });
    truthy(form.fields.length > 0, '分组弹窗应有常规字段（名称/开关/笔记）');

    // ② 保存往返：名称 / 开关 / 尺寸 都要落库（onSave 已改为走共享工厂的 read()）
    //    注意：开关要点**胶囊标签**（`label[for]`）—— 里面的 checkbox 是视觉隐藏的，
    //    Playwright 会拒绝点击不可见元素；点标签才是用户的真实操作。
    const p = await opt.evaluateHandle(() => document.querySelector('.kh-modal'));
    await opt.fill('#fld-g-name', 'E2E临时分组');
    await opt.click('label.kh-fld-chip[for="fld-g-important"]');
    await opt.waitForTimeout(150);
    const chipOn = await opt.evaluate(() => {
      const c = document.querySelector('label.kh-fld-chip[for="fld-g-important"]');
      return c ? c.classList.contains('is-on') : false;
    });
    truthy(chipOn, '点胶囊后应切到选中态（is-on）');
    /* 2.0.2.7：数值字段常态是**值胶囊**，真输入框 `display:none` ⇒ `page.fill` 要"可见"，
     * 会 30 秒超时（首轮真机回归第 7 条就是这个）。程序化设值 + 派发 `input` 与"点开胶囊输入"
     * 等价：控件 `read()` 会把待定值算进去（`displayRaw()` / `coerce`）。 */
    await opt.evaluate(() => {
      const el = document.getElementById('fld-g-imgSize');
      el.value = '88';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await opt.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.kh-modal .kh-btn')).find((x) => /保存/.test(x.textContent));
      if (b) b.click();
    });
    await opt.waitForTimeout(900);
    const saved = await opt.evaluate(async () => {
      const r = await new Promise((res) => chrome.storage.local.get(['groups'], res));
      const g = (r.groups || []).find((x) => x.name === 'E2E临时分组');
      return g ? { important: !!g.important, imgSize: g.imgSize, bgColor: g.bgColor } : null;
    });
    console.log('        分组保存往返: ' + JSON.stringify(saved));
    truthy(saved, '应能在存储里找到刚创建的分组');
    eq(saved.important, true, '「重要」开关应落库');
    eq(saved.imgSize, 88, '「尺寸」应落库为数字 88（不是字符串）');
    // 清理：删掉测试分组，避免影响后续用例
    await opt.evaluate(() => new Promise((res) => chrome.storage.local.get(['groups'], (r) => {
      const rest = (r.groups || []).filter((x) => x.name !== 'E2E临时分组');
      chrome.storage.local.set({ groups: rest }, res);
    })));
    await opt.waitForTimeout(400);
    void p;
  });

  await test('站点规则分区与禁用列表存在', async () => {
    const r = await opt.evaluate(() => ({
      rules: !!document.getElementById('site-rule-list'),
      disabled: !!document.getElementById('site-disabled-list'),
      add: !!document.getElementById('btn-site-add')
    }));
    truthy(r.rules && r.disabled && r.add, '站点分区控件应齐全：' + JSON.stringify(r));
  });

  await test('★ CSV 导出 18 列且含「组合方向」', async () => {
    const csv = await opt.evaluate(async () => {
      const cfg = await new Promise(res => chrome.storage.local.get(null, res));
      return window.KH.Store.exportCSV(cfg);
    });
    const header = csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0].replace(/\r$/, '');  // CRLF 友好：按 \r?\n 切并去行尾
    const cols = header.split(',');
    eq(cols.length, 18, 'CSV 应 18 列，实际 ' + cols.length + '：' + header);
    truthy(cols.indexOf('组合方向') >= 0, '末列应为「组合方向」，实际 ' + JSON.stringify(cols));
      truthy(csv.indexOf('\r\n') > 0, 'CSV 应用 CRLF 行尾（Excel 友好）');
      truthy(csv.charCodeAt(0) === 0xFEFF, 'CSV 应以 UTF-8 BOM 开头（否则 Excel 中文乱码）');
    truthy(cols.indexOf('标题词匹配方式') >= 0, '列名应校正为「标题词匹配方式」（值一直是标题词规则）');
    truthy(cols.indexOf('核心词区分大小写') >= 0, '核心词三项列名应说明是「核心词」');
  });

  await test('★ CSV 往返：上下格(tb)组合词不得静默变左右格(lr)', async () => {
    const r = await opt.evaluate(async () => {
      const KH = window.KH;
      const cfg = await new Promise(res => chrome.storage.local.get(null, res));
      const csv = KH.Store.exportCSV(cfg);
      const before = (cfg.keywords || []).filter(k => k.comboAxis === 'tb').length;
      // 解析回来（不落库，只看解析结果）
      const recs = KH.Store.parseCSV(csv);
      const idx = recs[0].indexOf('组合方向');
      const after = recs.slice(1).filter(v => v[idx] === 'tb').length;
      return { before, after, idx, header: recs[0].length };
    });
    truthy(r.before > 0, '配置里应有 tb 组合词（测试装置保证）');
    eq(r.after, r.before, 'CSV 里 tb 行数应与配置一致（第 ' + r.idx + ' 列）');
    console.log('        CSV tb 行: 配置 ' + r.before + ' → 文件 ' + r.after);
  });

  await test('★ 部分导出不得携带全局开关（shadowDOMEnabled / globalEnabled）', async () => {
    const r = await opt.evaluate(async () => {
      const KH = window.KH;
      const cfg = await new Promise(res => chrome.storage.local.get(null, res));
      const full = JSON.parse(KH.Store.exportJSON(null, cfg));
      const partial = JSON.parse(KH.Store.exportJSON({ keywords: true, siteRules: false, siteDisabled: false, styles: false }, cfg));
      return {
        fullHasGlobal: 'globalEnabled' in full,
        fullHasShadow: 'shadowDOMEnabled' in full,
        partialHasGlobal: 'globalEnabled' in partial,
        partialHasShadow: 'shadowDOMEnabled' in partial,
        partialStylesHasShadow: !!(partial.styles && 'shadowDOMEnabled' in partial.styles)
      };
    });
    truthy(r.fullHasGlobal && r.fullHasShadow, '完整备份应带全局开关：' + JSON.stringify(r));
    falsy(r.partialHasGlobal, '部分导出不得带 globalEnabled');
    falsy(r.partialHasShadow, '部分导出不得带 shadowDOMEnabled（旧版会泄漏本机开关）');
    falsy(r.partialStylesHasShadow, 'styles 块里也不得有 shadowDOMEnabled');
  });

  await test('options 页面无 JS 报错', async () => {
    falsy(optErrors.length, '报错：' + optErrors.join(' | '));
  });

  await shot(opt, '11-options-full');
  await opt.close();

  /* ============================================================ popup */
  group('12. popup · 工具栏弹窗', { aspects: ['ui'] });

  const pop = await api.context.newPage();
  const popErrors = [];
  pop.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) popErrors.push(m.text()); });
  pop.on('pageerror', (e) => popErrors.push('pageerror: ' + e.message));
  await pop.setViewportSize({ width: 400, height: 700 });
  await pop.goto('chrome-extension://' + api.extId + '/popup/popup.html', { waitUntil: 'load' });
  await pop.waitForTimeout(700);

  /* 【2.0.8.7 测试精简】头部与站点卡都是「弹窗首屏的一次读取」，合并成一条：
   * 少一次页面往返，断言一条不少。 */
  await test('★ 弹窗首屏结构：logo / 标题 / 全局状态 / 全局开关 + 站点卡域名与徽标', async () => {
    const r = await pop.evaluate(() => ({
      logo: !!document.querySelector('.kh-pop-logo'),
      title: (document.body.textContent.match(/关键词高亮/) || [])[0] || null,
      state: (document.getElementById('global-state') || {}).textContent || null,
      toggle: !!document.getElementById('chk-global'),
      name: (document.getElementById('site-name') || {}).textContent || null,
      badge: (document.getElementById('site-badge') || {}).textContent || null
    }));
    console.log('        首屏: ' + JSON.stringify(r));
    truthy(r.logo, '应有 logo（🔍）');
    truthy(r.title, '应有标题「关键词高亮」');
    truthy(r.state && /全局已(开启|暂停)/.test(r.state), '副标题应显示全局状态，实际 ' + r.state);
    truthy(r.toggle, '应有全局开关');
    truthy(r.name, '应显示站点名/域名，实际 ' + r.name);
    truthy(r.badge, '应有生效/失效徽标');
  });

  /* 1.99.99.19：命中统计功能整体移除（含文本关键词统计），「关键词数」保留（它只是配置项计数）。
   * 这条同时锁四件事：① 界面上不再有统计痕迹；② 保留的关键词数卡数字 = 配置里的条数；
   * ③ 不报错；④ 去掉一整块后**没有留下空白占位行**、信息卡与操作区左右边距一致。 */
  await test('★ 统计功能已整体移除：无「今日命中」/「清零」；关键词数 = 配置条数；重排无空白占位', async () => {
    /* 先塞一个"很大的历史统计 + 空的当日桶"——旧版弹窗会把它当「今日命中」显示（9999 或 0）。
     * 残留的 `stats` 键正是存量用户升级后的真实形态：新版连卡片都不存在，顺带锁"不再读取、不报错"。 */
    const seed = await api.extensionPage('options/options.html');
    await seed.evaluate(async () => {
      const r = await new Promise((res) => chrome.storage.local.get(['stats'], res));
      const s = r.stats || {};
      s.keywordHits = { k1: 9999 };
      s.siteHits = { 'x.com': 9999 };
      s.daily = {};
      await new Promise((res) => chrome.storage.local.set({ stats: s }, res));
    });
    await seed.close();
    await pop.reload({ waitUntil: 'load' });
    await pop.waitForTimeout(600);

    const r = await pop.evaluate(() => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) };
      };
      const info = document.querySelector('.kh-pop-info');
      const acts = document.querySelector('.kh-pop-actions');
      /* 竖直方向：按文档顺序取**可见且有高度**的顶层块，量相邻两块之间的空隙 */
      const blocks = Array.from(document.body.children).filter((el) => {
        if (/^(SCRIPT|LINK|STYLE)$/.test(el.tagName)) return false;
        if (el.hidden) return false;
        if (getComputedStyle(el).display === 'none') return false;
        return el.getBoundingClientRect().height > 0;
      });
      const gaps = [];
      for (let i = 0; i + 1 < blocks.length; i++) {
        const cur = box(blocks[i]), next = box(blocks[i + 1]);
        gaps.push({
          from: String(blocks[i].className || blocks[i].tagName),
          to: String(blocks[i + 1].className || blocks[i + 1].tagName),
          gap: next.t - cur.b
        });
      }
      return {
        bodyHasToday: /今日命中/.test(document.body.textContent),
        bodyHasReset: /清零/.test(document.body.textContent),
        hasResetBtn: !!document.getElementById('btn-reset-stats'),
        todayHitsEl: !!document.getElementById('today-hits'),
        hasKwCard: !!document.querySelector('.kh-stat-card'),
        kwLabel: /关键词数/.test(document.body.textContent),
        kw: (document.getElementById('keyword-count') || {}).textContent || null,
        info: info ? box(info) : null,
        acts: acts ? box(acts) : null,
        gaps: gaps
      };
    });
    console.log('        popup 重排: ' + JSON.stringify(r));

    /* ① 统计痕迹必须**彻底**消失（文案 / 元素 / 清零按钮三处都查） */
    falsy(r.bodyHasToday, '弹窗里不该再有「今日命中」');
    falsy(r.bodyHasReset, '弹窗里不该再有「清零」');
    falsy(r.hasResetBtn, '不该再有 #btn-reset-stats 清零按钮');
    falsy(r.todayHitsEl, '不该再有 #today-hits 元素（历史统计桶塞到 9999 也不显示）');

    /* ② 保留的「关键词数」= 配置里的关键词条数 */
    truthy(r.hasKwCard && r.kwLabel, '应保留「关键词数」卡，实际 ' + JSON.stringify(r));
    truthy(r.kw !== null, '应有 #keyword-count');
    const cfgCount = await pop.evaluate(async () => {
      const r2 = await new Promise((res) => chrome.storage.local.get(['keywords'], res));
      return (r2.keywords || []).length;
    });
    eq(String(r.kw).trim(), String(cfgCount), '关键词数应等于配置里的关键词条数（' + cfgCount + '），实际 ' + r.kw);

    /* ④ 重排：信息行与操作区左右边距一致（都与 body 内容区对齐，不缩进也不缺一块） */
    truthy(r.info && r.acts, '信息行与操作区都应存在');
    eq(r.info.l, r.acts.l, '信息行与操作区左边距应一致');
    eq(r.info.r, r.acts.r, '信息行与操作区右边距应一致');
    /* ④ 重排：相邻主区块之间不得出现"空白占位行"（> 24px 的竖向空洞即视为残留占位） */
    const holes = (r.gaps || []).filter((g) => g.gap > 24);
    eq(holes.length, 0, '主区块之间不该有 > 24px 的空白占位：' + JSON.stringify(r.gaps));

    /* ③ 不报错（统计移除后残留 stats 键也不得引发异常） */
    falsy(popErrors.length, 'popup 报错：' + popErrors.join(' | '));
    await shot(pop, '12b-popup-nostats');
  });

  await test('★ ＋ 快速添加：先委托当前网页；委托不了就开**独立编辑窗口**（不再塞进弹窗内联）', async () => {
    const urlBefore = pop.url();
    /* 真实场景里 popup 是独立小窗，`active tab` 就是用户正在看的那一页 → 委托成功、popup 自己关掉。
     * 这里 popup 是以**普通标签页**打开的（自动化环境），active tab 就是它自己（没有内容脚本）
     * → 消息会失败 → 正好用来验"独立窗口"这条兜底路径。先打桩确认它**先尝试过委托**。 */
    await pop.evaluate(() => {
      window.__sent = [];
      window.__win = [];
      window.__closed = false;
      /* 自动化环境里 popup 是**普通标签页**，window.close() 会真把它关掉 → 后续断言全部失效。
       * 打桩拦下（真实 popup 是独立小窗，关掉是正确行为）。 */
      window.close = () => { window.__closed = true; };
      const origMsg = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = function (id, msg) {
        window.__sent.push({ id: id, type: msg && msg.type });
        try { return origMsg.apply(this, arguments); } catch (e) { return undefined; }
      };
      chrome.windows.create = function (opts) {
        window.__win.push(opts && opts.url);
        return Promise.resolve({ id: 1 });        // 别真开窗，免得污染后续用例
      };
    });
    await pop.click('#btn-add');
    await pop.waitForTimeout(800);
    const r = await pop.evaluate(() => ({
      modal: !!document.querySelector('.kh-modal, .kh-editor'),
      secs: document.querySelectorAll('.kh-editor-sec').length,
      url: location.href,
      sent: window.__sent || [],
      win: window.__win || [],
      closed: window.__closed
    }));
    console.log('        委托尝试: ' + JSON.stringify(r.sent) + '；独立窗口: ' + JSON.stringify(r.win) +
      '；弹窗内联 modal=' + r.modal + '；弹窗已关闭=' + r.closed);
    truthy(r.sent.some((x) => x.type === 'kh:editor:open'),
      '点「快速添加」应**先**向当前标签页发 kh:editor:open（委托页面弹 1:1 编辑器），实际 ' + JSON.stringify(r.sent));
    truthy(r.win.some((u) => /popup\/editor\.html$/.test(u || '')),
      '委托不了时应开独立编辑窗口 popup/editor.html，实际 ' + JSON.stringify(r.win));
    truthy(r.closed, '开完独立窗口后 popup 应自己关掉');
    falsy(r.modal, '**不该**再退回"塞进插件弹窗里的内联编辑器"（用户明确否掉的观感）');
    eq(pop.url(), urlBefore, '不应跳转到设置页');
    await shot(pop, '12-popup-quickadd');
  });

  await test('★ 禁用本标签页按钮按状态切换文案/图标', async () => {
    const r = await pop.evaluate(() => ({
      icon: (document.getElementById('btn-site-icon') || {}).textContent || '',
      text: (document.getElementById('btn-site-text') || {}).textContent || '',
      title: (document.getElementById('btn-site') || {}).title || ''
    }));
    console.log('        站点按钮: ' + JSON.stringify(r));
    /* 【2.0.7.2 需求⑤】语义从「禁用本站」改成「禁用本标签页」：
     * 只影响当前这一个标签页（同站点别的标签页不受影响），关掉标签页自动取消。
     * 文案随之换名，这里钉新口径 —— 旧文案「禁用本站」已经退场，不许再回来。 */
    truthy(/禁用本标签页|恢复本标签页/.test(r.text), '按钮文案应是 禁用本标签页/恢复本标签页，实际 ' + r.text);
    falsy(/禁用本站|启用本站/.test(r.text), '旧文案「禁用本站 / 启用本站」应已退场，实际 ' + r.text);
    truthy(/🚫|✅/.test(r.icon), '应有状态图标，实际 ' + r.icon);
    /* 自动化环境里 popup 是普通标签页（没有内容脚本）⇒ 悬停提示落到「不支持站点设置」那条降级文案，
     * 所以两类文案都算过；但提示必须是新的标签页口径，不许退回「禁用本站高亮」。 */
    truthy(/标签页|站点设置/.test(r.title), '悬停说明应讲清这是标签页级（或明说该页不支持），实际 ' + r.title);
    falsy(/本站/.test(r.title), '悬停说明里不该再出现「本站」口径，实际 ' + r.title);
  });

  await test('弹窗不再有线上更新入口（只留通道切换按钮）', async () => {
    const r = await pop.evaluate(() => ({
      banner: !!document.getElementById('update-banner'),
      check: !!document.getElementById('btn-check-update'),
      dismiss: !!document.getElementById('btn-update-dismiss'),
      download: !!document.getElementById('btn-update'),
      channel: !!document.getElementById('btn-channel')
    }));
    eq(r.banner, false, '线上更新提示条应已随「取消线上更新」退场');
    eq(r.check, false, '「检查更新」按钮应已退场');
    eq(r.dismiss, false, '「稍后」应已退场');
    eq(r.download, false, '「下载并更新」应已退场');
    truthy(r.channel, '更新通道切换按钮必须保留');
  });

  /* ============================================================ C7 O-1 / O-2
   * 两条都是「界面说不清自己在干什么」：诊断复制的范围与 title 名实不符（O-2）、
   * 通道单击即落盘且显示口径可能反过来（O-1）。
   * 这两条**只能**在真浏览器里验：量的是「用户实际看到 / 实际复制出去的内容」。
   * （原 O-3「更新说明上屏」随线上更新退场一并删除，见 2026-10-05 口径。） */

  await test('★ O-2 诊断两档：完整档照旧（含网址/关键词），仅计数档零用户数据、结论走无词判据', async () => {
    const SITE = 'https://internal.example.com/secret/path?token=abc123';
    const WORD = '不通过';
    const CELLTEXT = '内部机密文本';
    const canned = (siteEnabled, verdictKind) => ({
      ok: true, url: SITE, booted: true, siteEnabled: siteEnabled,
      rules: 3, hits: 0, groups: 0,
      rebuildCount: 7, mutationRebuildCount: 3, lastRebuildSource: 'mutation',
      consumeOnlyCount: 2, lastVerdict: 'none', lastVerdictRecords: 0,
      observerFire: 11, drainCount: 5, deferCapped: 0, animFallback: 0, growthFallback: 0,
      changeHandling: 'smart', imgOcr: null,
      selfCheck: {
        doc: { textContentLen: 120, innerTextLen: 90, textNodes: 6, elements: 9, imgs: 0, canvases: 0, shadowRoots: 0 },
        scan: { textNodes: 6, rules: 3, hits: 0, ms: 2, prunedInvisible: 1,
          rejects: { invisible: 1, skipTag: 0, editable: 0, ownUI: 0, empty: 0, orphan: 0 } },
        words: [{ word: WORD, inText: 1, inInner: 1, inForm: 0, inAttr: 0, inEditable: 0, inShadow: 0 },
          { word: '机密词', inText: 0, inInner: 0, inForm: 1, inAttr: 0, inEditable: 0, inShadow: 0 }],
        iframes: [{ src: 'https://internal.example.com/frame?secret=1', sameOrigin: false, textLen: 12, khRules: 0, khHits: 0, khBooted: false }],
        ruleHits: [{ word: WORD, label: '', hits: 0 }], rulesWithHits: 0, rulesWithoutHits: 1,
        combo: null,
        comboTrace: [{ word: WORD, label: '审核状态', found: true, tag: 'td', colSpan: 0, rowSpan: 0,
          text: CELLTEXT, prev: '', next: '', rowCells: ['审核状态', CELLTEXT], labelInCell: false, labelInScope: true }],
        verdict: '⚠ 有 1 条规则的词就在**可见文本**里（例如「' + WORD + '」出现 1 次）却一条都没命中 → 是**匹配/定位**的问题。',
        verdictKind: verdictKind
      }
    });

    await pop.evaluate((payload) => {
      window.__clip = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: (t) => { window.__clip = String(t); return Promise.resolve(); } },
          configurable: true
        });
      } catch (e) { /* 拿不到就靠下面的断言失败暴露 */ }
      window.__canned = payload;
      window.__origSend = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = function (id, msg) {
        if (msg && String(msg.type).indexOf('debug:diag') >= 0) return Promise.resolve(window.__canned);
        return Promise.resolve({});
      };
    }, canned(false, 'visible-miss'));

    await pop.click('#btn-diag-counts');
    await pop.waitForTimeout(400);
    const counts = await pop.evaluate(() => window.__clip || '');
    truthy(counts, '仅计数档应把文本交给剪贴板（拿不到＝clipboard 桩没装上）');
    truthy(counts.indexOf('仅计数诊断') >= 0, '首行要写明这是「仅计数诊断」');
    truthy(counts.indexOf('internal.example.com') >= 0, '主机名要留着（否则没法判断是哪台内网）');
    eq(counts.indexOf('secret/path'), -1, '仅计数档不得带网址路径');
    eq(counts.indexOf('token=abc123'), -1, '仅计数档不得带查询串（可能夹带票据）');
    eq(counts.indexOf(WORD), -1, '仅计数档不得带用户关键词');
    eq(counts.indexOf(CELLTEXT), -1, '仅计数档不得带格内原文');
    eq(counts.indexOf('frame?secret=1'), -1, '仅计数档不得带 iframe 地址');
    truthy(counts.indexOf('（地址已省略）') >= 0, 'iframe 那行要明确写「地址已省略」');
    truthy(counts.indexOf('其它通道(表单值/属性/可编辑/影子根): 有记录的规则 1 条') >= 0, '其它通道只报条数');
    truthy(counts.indexOf('本站当前') >= 0 && counts.indexOf('未生效') >= 0, '本站没生效时必须先说这一条');
    eq(counts.indexOf('匹配/定位'), -1, '本站未生效时不得再给「是匹配/定位问题」的结论（自相矛盾）');

    /* 同一份数据走完整档：该有的现场一个不少（证明两档读同一份数据，只是少打印） */
    await pop.click('#btn-diag');
    await pop.waitForTimeout(400);
    const full = await pop.evaluate(() => window.__clip || '');
    truthy(full.indexOf(SITE) >= 0, '完整档必须带完整网址，实际：' + full.slice(0, 140));
    truthy(full.indexOf(WORD) >= 0, '完整档应带关键词');
    truthy(full.indexOf(CELLTEXT) >= 0, '完整档应带格内原文（定位现场）');
    truthy(full.indexOf('机密词=1/0/0/0') >= 0, '完整档应带其它通道明细');
    eq(full.indexOf('匹配/定位'), -1, '本站未生效时完整档也不得给「是匹配问题」的结论（与仅计数档同规则）');
    truthy(full.indexOf('本站当前') >= 0, '本站未生效时两档都要先把这一条说清楚');
    truthy(full.length > counts.length, '完整档应比仅计数档更长（少打印确实生效）');

    /* 本站生效 + 完整档：内容侧原文结论照旧打印（现场排查要看原文） */
    await pop.evaluate((p) => { window.__canned = p; }, canned(true, 'visible-miss'));
    await pop.click('#btn-diag');
    await pop.waitForTimeout(400);
    const full2 = await pop.evaluate(() => window.__clip || '');
    truthy(full2.indexOf('匹配/定位') >= 0, '本站生效时完整档应打印内容侧原文结论，实际：' + full2.slice(-200));

    /* 本站生效时的无词结论：走 verdictKind 映射，且不带用户词 */
    await pop.click('#btn-diag-counts');
    await pop.waitForTimeout(400);
    await pop.click('#btn-diag-counts');
    await pop.waitForTimeout(400);
    const c2 = await pop.evaluate(() => window.__clip || '');
    truthy(c2.indexOf('自查结论(无词档)') >= 0, '应给出无词档结论行');
    truthy(c2.indexOf('属匹配/定位问题') >= 0, 'visible-miss 要说「属匹配/定位问题」，实际：' + c2);
    eq(c2.indexOf(WORD), -1, '无词档结论里同样不许出现用户词');

    /* 版本混装（旧内容脚本 / 未来新增判据）要如实说「没给判据类型」，不能瞎猜 */
    await pop.evaluate((p) => { window.__canned = p; }, canned(true, '未来才有的判据'));
    await pop.click('#btn-diag-counts');
    await pop.waitForTimeout(400);
    const c3 = await pop.evaluate(() => window.__clip || '');
    truthy(c3.indexOf('没有给出判据类型') >= 0, '未知判据要如实说明，实际：' + c3);

    /* title 必须名实相符（O-2 的病根就是 title 只承诺三个内部计数） */
    const titles = await pop.evaluate(() => ({
      full: (document.getElementById('btn-diag') || {}).title || '',
      counts: (document.getElementById('btn-diag-counts') || {}).title || ''
    }));
    truthy(titles.full.indexOf('完整网址') >= 0 && titles.full.indexOf('关键词') >= 0 && titles.full.indexOf('别外发') >= 0,
      '完整档 title 要如实写清包含什么，实际：' + titles.full);
    truthy(titles.counts.indexOf('仅计数') >= 0 && titles.counts.indexOf('可直接外发') >= 0,
      '仅计数档 title 要写明可安全外发，实际：' + titles.counts);

    await pop.evaluate(() => { if (window.__origSend) chrome.tabs.sendMessage = window.__origSend; delete window.__canned; });
  });

  await test('★ O-1 更新通道：有图标、单击只「准备」不落盘、再点才确认；被 manifest 强制成测试版时只读', async () => {
    const before = await pop.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['khUpdateChannel'], (r) => res(r.khUpdateChannel === undefined ? null : r.khUpdateChannel));
    }));

    /* 2026-10-05 口径：切换只写本机 storage，**不再触发任何更新检查**。
     * 这里装上发信 spy：整个用例结束时，凡是类型里带 update 的消息都必须是 0 条
     * （页面一旦又开始发 update:check，这条断言就红）。 */
    await pop.evaluate(() => {
      window.__sentTypes = [];
      window.__origSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg) {
        try { if (msg && msg.type) window.__sentTypes.push(String(msg.type)); } catch (e) { /* 记不下来也不许影响原语义 */ }
        return window.__origSend.apply(this, arguments);
      };
    });

    const t0 = await pop.evaluate(() => ({
      text: (document.getElementById('btn-channel') || {}).textContent || '',
      title: (document.getElementById('btn-channel') || {}).title || '',
      disabled: !!(document.getElementById('btn-channel') || {}).disabled
    }));
    console.log('        通道键初始: ' + JSON.stringify(t0));
    truthy(t0.text.indexOf('🔀') >= 0, '通道键要有图标（原先是没有图标的伪链接），实际：' + t0.text);
    truthy(t0.title.indexOf('点一下') >= 0 && t0.title.indexOf('再点一下') >= 0,
      'title 要写清两次点击的语义，实际：' + t0.title);

    /* 第一次点：只进入确认态，**不写盘**（病根是单击即持久化） */
    await pop.click('#btn-channel');
    await pop.waitForTimeout(200);
    const afterFirst = await pop.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['khUpdateChannel'], (r) => res({
        stored: r.khUpdateChannel === undefined ? null : r.khUpdateChannel,
        text: (document.getElementById('btn-channel') || {}).textContent || ''
      }));
    }));
    eq(afterFirst.stored, before, '第一次点击不得写盘（只进入确认态）');
    truthy(afterFirst.text.indexOf('❓') >= 0 && afterFirst.text.indexOf('切到') >= 0,
      '第一次点击后应显示「切到X？」的确认态，实际：' + afterFirst.text);

    /* 第二次点：确认 → 落盘，通道真的变了 */
    await pop.click('#btn-channel');
    await pop.waitForTimeout(700);
    const afterSecond = await pop.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['khUpdateChannel'], (r) => res({
        stored: r.khUpdateChannel === undefined ? null : r.khUpdateChannel,
        text: (document.getElementById('btn-channel') || {}).textContent || ''
      }));
    }));
    truthy(afterSecond.stored === 'beta' || afterSecond.stored === 'stable', '第二次点击应写入通道，实际 ' + afterSecond.stored);
    truthy(afterSecond.stored !== before, '通道值应真的变化（原先单击就变，现在两次点击才变）');

    /* 只点一次就走开：6 秒后自动取消（文案复位、依旧不落盘）——「不点自动取消」是按钮自己承诺的 */
    await pop.click('#btn-channel');
    await pop.waitForTimeout(200);
    const pending = await pop.evaluate(() => (document.getElementById('btn-channel') || {}).textContent || '');
    truthy(pending.indexOf('❓') >= 0, '先进入确认态，实际：' + pending);
    await pop.waitForTimeout(6500);
    const cancelled = await pop.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['khUpdateChannel'], (r) => res({
        stored: r.khUpdateChannel === undefined ? null : r.khUpdateChannel,
        text: (document.getElementById('btn-channel') || {}).textContent || ''
      }));
    }));
    truthy(cancelled.text.indexOf('🔀') >= 0, '6 秒不点应自动取消并复位文案，实际：' + cancelled.text);
    eq(cancelled.stored, afterSecond.stored, '自动取消不得写盘');

    /* 全程零 update 类消息：插件入口已无线上更新（只有本地通道切换） */
    const sent = await pop.evaluate(() => (window.__sentTypes || []).slice());
    const updateMsgs = sent.filter((t) => t.indexOf('update') >= 0);
    console.log('        切换期间发出的消息: ' + JSON.stringify(sent));
    eq(updateMsgs.length, 0, '通道切换不得再发任何 update 类消息，实际发了：' + JSON.stringify(updateMsgs));

    /* 被 manifest 强制成测试版的包（version_name 含 beta）：显示口径必须跟着**决策口径**，且不许再切 */
    await pop.evaluate(() => {
      window.__origChGet = KH.UpdateChannel.get;
      window.__origBeta = KH.UpdateChannel.isBetaPackage;
      KH.UpdateChannel.get = function () { return Promise.resolve('stable'); };      // 用户设置：稳定版
      KH.UpdateChannel.isBetaPackage = function () { return true; };                 // 实际决策：这个包本身就是测试版
    });
    await pop.click('#btn-channel');   // 第一次：准备（此时按钮还是可点的旧状态）
    await pop.waitForTimeout(200);
    await pop.click('#btn-channel');   // 第二次：确认 → 触发 renderChannel()
    await pop.waitForTimeout(400);
    const forced = await pop.evaluate(() => ({
      text: (document.getElementById('btn-channel') || {}).textContent || '',
      title: (document.getElementById('btn-channel') || {}).title || '',
      disabled: !!(document.getElementById('btn-channel') || {}).disabled
    }));
    console.log('        被强制的测试版包: ' + JSON.stringify(forced));
    eq(forced.disabled, true, '被包强制的测试版通道不能切换（按钮应禁用）');
    truthy(forced.text.indexOf('🔒') >= 0 && forced.text.indexOf('测试版') >= 0,
      '被强制时应显示「🔒 测试版」（旧行为会显示成「稳定版」），实际：' + forced.text);
    truthy(forced.title.indexOf('本身就是测试版') >= 0, 'title 要说清为什么不能切，实际：' + forced.title);

    /* 复原：两个桩 + 通道设置 + 页面（别把状态漏给后面的用例） */
    await pop.evaluate(async (orig) => {
      KH.UpdateChannel.get = window.__origChGet;
      KH.UpdateChannel.isBetaPackage = window.__origBeta;
      if (window.__origSend) chrome.runtime.sendMessage = window.__origSend;
      await new Promise((res) => {
        if (orig === null) chrome.storage.local.remove(['khUpdateChannel'], res);
        else chrome.storage.local.set({ khUpdateChannel: orig }, res);
      });
    }, before);
    await pop.reload({ waitUntil: 'load' });
    await pop.waitForTimeout(600);
  });

  /* ============================================================ C7 O-4 / O-5 / O-6
   * 三条都是「说了假话 / 假装成功 / 留着死代码」：首屏自相矛盾（O-4）、样式读不到
   * 却照样报成功让 popup 关掉自己（O-5）、死参数与失效 CSS（O-6）。
   * 这三条**只能**在真浏览器里验：量的是"用户实际看到的那一帧 / 页面里实际留下什么"。 */

  await test('★ O-4 首屏不自相矛盾：占位「读取中…」+ 开关未就绪，真值一帧落定（采样每一帧都必须自洽）', async () => {
    const SAMPLER = '(' + function () {
      window.__samples = [];
      function grab() {
        const sub = document.getElementById('global-state');
        const chk = document.getElementById('chk-global');
        const lbl = document.getElementById('lbl-global');
        if (!sub || !chk) return null;
        return {
          t: Math.round(performance.now()),
          sub: String(sub.textContent || '').trim(),
          chk: !!chk.checked,
          disabled: !!chk.disabled,
          busy: !!(lbl && lbl.getAttribute('aria-busy') === 'true')
        };
      }
      function tick() { const s = grab(); if (s && window.__samples.length < 800) window.__samples.push(s); }
      function boot() {
        tick();
        try {
          new MutationObserver(tick).observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, characterData: true
          });
        } catch (e) { /* 忽略 */ }
        (function loop(n) { tick(); if (n < 400) requestAnimationFrame(function () { loop(n + 1); }); })(0);
      }
      if (document.documentElement) boot(); else document.addEventListener('DOMContentLoaded', boot);
    }.toString() + ')();';

    /* 全局=关：旧代码正是在这个状态下前 39–43ms 说「全局已开启」 */
    await api.sw.evaluate((v) => chrome.storage.local.set({ globalEnabled: v }), false);
    const p = await api.context.newPage();
    await p.addInitScript(SAMPLER);
    await p.goto('chrome-extension://' + api.extId + '/popup/popup.html', { waitUntil: 'load' });
    await p.waitForTimeout(1200);
    const samples = await p.evaluate(() => window.__samples || []);
    const cons = samples.filter((s) => s.sub === '全局已开启' && !s.chk);
    const inv = samples.filter((s) => !s.disabled && s.sub !== (s.chk ? '全局已开启' : '全局已暂停'));
    const notReady = samples.filter((s) => s.disabled || s.busy);
    console.log('        O-4 采样 ' + samples.length + ' 点 · 首帧=' + JSON.stringify(samples[0]) +
      ' · 末帧=' + JSON.stringify(samples[samples.length - 1]) +
      ' · 矛盾=' + cons.length + ' · 可交互却不一致=' + inv.length + ' · 未就绪样本=' + notReady.length);
    truthy(samples.length > 5, '采样器应采到足够多的帧，实际 ' + samples.length);
    eq(cons.length, 0, '任何一帧都不得出现「文案说已开启、开关却未勾选」· 样本 ' + JSON.stringify(cons.slice(0, 3)));
    eq(inv.length, 0, '开关一旦可交互，文案就必须与勾选态一致 · 样本 ' + JSON.stringify(inv.slice(0, 3)));
    truthy(notReady.length > 0, '首屏必须真的出现过「未就绪」态（否则只是把错帧换成另一种谎）');
    const last = samples[samples.length - 1];
    eq(last.sub, '全局已暂停', '收口后应是「全局已暂停」，实际 ' + last.sub);
    eq(last.chk, false, '收口后开关应未勾选');
    eq(last.disabled, false, '收口后开关应可点');
    await p.close();
    await api.sw.evaluate((v) => chrome.storage.local.set({ globalEnabled: v }), true);   // 复原：别把状态漏给后面用例
  });

  await test('★ O-6 死参数清理后 + 选项页 ＋添加 仍是 1040px 三列（删 mode 不影响几何）', async () => {
    const g = await api.extensionPage('options/options.html');
    await g.waitForFunction(() => !!document.getElementById('btn-kw-add'), null, { timeout: 15000 });
    await g.click('#btn-kw-add');
    await g.waitForTimeout(700);
    const r = await g.evaluate(() => {
      const modal = document.querySelector('.kh-modal-lg');
      const cols = document.querySelector('.kh-editor-cols');
      return { w: modal ? Math.round(modal.getBoundingClientRect().width) : null, cols: cols ? cols.children.length : null };
    });
    console.log('        O-6 选项页 ＋添加: ' + JSON.stringify(r));
    eq(r.cols, 3, '编辑器应仍是三列（sm 死分支删掉后观感不许变）');
    truthy(r.w >= 1020 && r.w <= 1060, '编辑器应是 1040px 级别（2.0.2.7 起加宽），实际 ' + r.w);
    await g.close();
  });

  await test('★ O-5 页内编辑器：样式到手 ⇒ 在网页 ShadowRoot 里开；样式读不到 ⇒ 不留白板、退回独立窗口', async () => {
    const openFromPopup = async (page) => {
      const popup = await api.context.newPage();
      await popup.goto('chrome-extension://' + api.extId + '/popup/popup.html', { waitUntil: 'load' });
      await popup.evaluate(() => { window.close = () => { window.__closed = true; }; });
      await popup.waitForFunction(() => typeof KH !== 'undefined' && typeof KH.popupOpenQuickAdd === 'function', null, { timeout: 15000 });
      const ret = await popup.evaluate((id) => KH.popupOpenQuickAdd(id).catch((e) => 'ERR:' + e.message), page);
      return { popup: popup, ret: ret };
    };
    const hostRead = (page) => page.evaluate(() => {
      const host = document.getElementById('kh-page-editor-host');
      if (!host) return { host: false };
      const sr = host.shadowRoot;
      const style = sr && sr.querySelector('style');
      const modal = sr && sr.querySelector('.kh-modal-lg');
      const cols = sr && sr.querySelector('.kh-editor-cols');
      return {
        host: true, hasShadow: !!sr,
        styleHost: style ? String(style.textContent).indexOf(':host') >= 0 : null,
        styleRoot: style ? String(style.textContent).indexOf(':root') >= 0 : null,
        cols: cols ? cols.children.length : null,
        modalW: modal ? Math.round(modal.getBoundingClientRect().width) : null
      };
    });

    /* ---- 正路：样式能读到 ⇒ 委托当前网页，在 ShadowRoot 里开 860px 三列 ---- */
    const good = await api.context.newPage();
    await good.goto(ORIGIN + '/spa.html', { waitUntil: 'load' });
    await good.waitForTimeout(1200);
    const goodTab = await api.sw.evaluate((u) => chrome.tabs.query({}).then((ts) => {
      const t = ts.filter((x) => String(x.url || '').indexOf(u + '/spa.html') === 0)[0];
      return t ? t.id : null;
    }), ORIGIN);
    const r1 = await openFromPopup(goodTab);
    await good.waitForTimeout(1000);
    const inPage = await hostRead(good);
    console.log('        O-5 正路: 返回=' + JSON.stringify(r1.ret) + ' · 页内=' + JSON.stringify(inPage));
    eq(r1.ret, 'page', '样式正常应委托当前网页（返回 page）');
    truthy(inPage.host && inPage.hasShadow, '网页里应出现宿主 + ShadowRoot');
    truthy(inPage.styleHost === true && inPage.styleRoot === false, 'ShadowRoot 样式应把 :root 改写成 :host');
    eq(inPage.cols, 3, '页内编辑器应是三列');
    truthy(inPage.modalW >= 1020 && inPage.modalW <= 1060, '页内编辑器应是 1040px 级别（与选项页同源），实际 ' + inPage.modalW);
    await r1.popup.close();

    /* ---- 失败路：**真删两份样式**的临时副本再开一次浏览器 ----
     * 为什么不用 route 拦截：Playwright 拦不到 `chrome-extension://` 请求（实测 route.abort() 后
     * 样式照样到手、返回值仍是 page）⇒ 只有"文件真的不在"才能造出这个失败。 */
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const { launch } = require('./harness');
    const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kh-nocss-'));
    const extCopy = pathx.join(tmp, 'ext');
    const EXT_ROOT = process.env.KH_EXT_DIR
      ? pathx.resolve(process.env.KH_EXT_DIR)
      : (fsx.existsSync(pathx.join(__dirname, '..', 'manifest.json'))
        ? pathx.resolve(__dirname, '..')
        : pathx.resolve(__dirname, '..', 'work', 'keyword-highlighter'));
    fsx.cpSync(EXT_ROOT, extCopy, {
      recursive: true,
      /* 只复制会进交付包的东西：`_profiles`（浏览器 profile，里面有锁着的 Cookies）、
       * `e2e/`（装置自身）、`release/`（密钥）、`dist/`、`node_modules/`、`_out/` 都不跟走。
       * 2026-11-01 实测踩到：装置进仓后 `e2e/_profiles` 也在仓内，复制时报
       * `EBUSY: resource busy or locked, copyfile …\\Default\\Network\\Cookies`。 */
      filter: (s) => !/([\\/])(\.git|dist|node_modules|_out|_profiles|release|e2e)([\\/]|$)/.test(s)
    });
    for (const rel of ['src/ui/tokens.css', 'src/ui/components/components.css']) {
      fsx.rmSync(pathx.join(extCopy, rel), { force: true });
    }
    let api2 = null;
    try {
      api2 = await launch({ extensionDir: extCopy });
      const bad = await api2.context.newPage();
      const warns = [];
      bad.on('console', (m) => {
        const t = m.text() || '';
        if (t.indexOf('编辑器样式读取失败') >= 0 || t.indexOf('样式不全') >= 0) warns.push(t);
      });
      await bad.goto(ORIGIN + '/spa.html', { waitUntil: 'load' });
      await bad.waitForTimeout(1200);
      const badTab = await api2.sw.evaluate((u) => chrome.tabs.query({}).then((ts) => {
        const t = ts.filter((x) => String(x.url || '').indexOf(u + '/spa.html') === 0)[0];
        return t ? t.id : null;
      }), ORIGIN);
      const popup2 = await api2.context.newPage();
      await popup2.goto('chrome-extension://' + api2.extId + '/popup/popup.html', { waitUntil: 'load' });
      await popup2.evaluate(() => { window.close = () => { window.__closed = true; }; });
      await popup2.waitForFunction(() => typeof KH !== 'undefined' && typeof KH.popupOpenQuickAdd === 'function', null, { timeout: 15000 });
      const waiter = api2.context.waitForEvent('page', { predicate: (pg) => pg.url().indexOf('/popup/editor.html') >= 0, timeout: 12000 }).catch(() => null);
      const r2 = await popup2.evaluate((id) => KH.popupOpenQuickAdd(id).catch((e) => 'ERR:' + e.message), badTab);
      const editorWin = await waiter;
      /* 【2026-10-11 全量跑时假红一次 → 固定时长换等待】popup 侧有 2s 超时兜底
       * （popup.js 的 `EDITOR_TIMEOUT_MS=2000`，超时即落独立窗口），而内容脚本那侧的
       * `open()` 还在等「样式 fetch 失败」——宿主是**之后**才被撤掉的；整机负载高时 600ms 不够。
       * 断言的对象是"最终不许留下宿主"，所以等它消失（有上限），而不是赌睡够没睡够。
       * 强度不变：等到 8s 还在 ⇒ 下一行 eq(leftover.host,false) 照旧判红。 */
      await bad.waitForFunction(() => !document.getElementById('kh-page-editor-host'), null, { timeout: 8000 }).catch(() => {});
      const leftover = await hostRead(bad);
      console.log('        O-5 失败路（真删两份 CSS 的副本）: 返回=' + JSON.stringify(r2) +
        ' · 独立窗口=' + (editorWin ? editorWin.url() : '(没等到)') +
        ' · 页面残留=' + JSON.stringify(leftover) + ' · 控制台告警=' + JSON.stringify(warns.slice(0, 2)));
      eq(r2, 'window', '样式读不到时不许假装成功（旧代码回 page + {ok:true} 让 popup 关掉自己）');
      eq(leftover.host, false, '样式不全就**不该**在页面里留下宿主（旧代码会留一个没样式的白板弹窗）');
      truthy(!!editorWin, '应真的开出独立编辑窗口 popup/editor.html');
      truthy(warns.length >= 1, '控制台必须留下"样式读取失败/样式不全"的诚实记录');
      if (editorWin) { try { await editorWin.close(); } catch (e) { /* 忽略 */ } }
      await popup2.close();
      await bad.close();
    } finally {
      if (api2) { try { await api2.close(); } catch (e) { /* 忽略 */ } }
      try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    await good.close();
  });

  /* 【2.0.8.7 测试精简】底部三件与「无 JS 报错」合并：同一会话、同一份累积错误列表。 */
  await test('底部：帮助 / 完整设置 / 动态版本徽标 + 全程无 JS 报错', async () => {
    const r = await pop.evaluate(() => ({
      help: !!document.getElementById('btn-help'),
      options: !!document.getElementById('btn-options'),
      ver: (document.getElementById('version') || {}).textContent || ''
    }));
    truthy(r.help, '应有「帮助」');
    truthy(r.options, '应有「完整设置」');
    const ver = await pop.evaluate(() => chrome.runtime.getManifest().version);
    includes(r.ver, ver, '版本徽标应动态读到 ' + ver + '，实际 ' + r.ver);
    falsy(popErrors.length, '报错：' + popErrors.join(' | '));
  });


  /* 【台账 #11】三步上手不是装饰：点一张卡要真的落到设置页对应小节。
   * 深链能成立，靠的是 options.js 启动时读 location.hash（#sec-xxx → showSection）。 */
  group('9. welcome · 三步上手直达设置页', { aspects: ['ui'] });

  await test('★ 三张卡都是链接，点第 2 张落到「样式」分区且地址栏带 #sec-style', async () => {
    const wel = await api.extensionPage('welcome/welcome.html');
    try {
      await wel.waitForTimeout(400);
      const list = await wel.evaluate(() => Array.from(document.querySelectorAll('a.kh-step')).map((a) => {
        const r = a.getBoundingClientRect();
        return {
          href: a.getAttribute('href') || '',
          go: ((a.querySelector('.kh-step-go') || {}).textContent || '').trim(),
          w: Math.round(r.width), h: Math.round(r.height)
        };
      }));
      eq(list.length, 3, '三步上手应有 3 张可点卡片，实际 ' + JSON.stringify(list));
      list.forEach((s, i) => {
        includes(s.href, 'options/options.html#sec-', '第 ' + (i + 1) + ' 张卡应直达设置页小节，实际 ' + JSON.stringify(s.href));
        truthy(s.w > 150 && s.h > 80, '第 ' + (i + 1) + ' 张卡要真的能点（尺寸 ' + s.w + 'x' + s.h + '）');
        includes(s.go, '去', '第 ' + (i + 1) + ' 张卡要有落点说明，实际 ' + JSON.stringify(s.go));
      });
      await Promise.all([
        wel.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        wel.click('a.kh-step >> nth=1')
      ]);
      await wel.waitForFunction(() => !!document.getElementById('sec-style'), null, { timeout: 10000 });
      const landed = await wel.evaluate(() => {
        const sec = document.getElementById('sec-style');
        const other = document.getElementById('sec-keywords');
        return {
          path: location.pathname, hash: location.hash,
          styleHidden: !!sec.hidden,
          styleH: Math.round(sec.getBoundingClientRect().height),
          otherHidden: !!(other && other.hidden)
        };
      });
      includes(landed.path, 'options/options.html', '点卡应跳到设置页，实际 ' + JSON.stringify(landed.path));
      eq(landed.hash, '#sec-style', '地址栏应带目标分区，实际 ' + JSON.stringify(landed.hash));
      falsy(landed.styleHidden, '★ 落到的分区必须是显示状态（#sec-style 不能还藏着）');
      truthy(landed.styleH > 100, '★ 分区要有真实内容高度，实际 ' + landed.styleH);
      truthy(landed.otherHidden, '★ 只切到目标分区，别的分区要收起（否则等于停在默认页）');
      console.log('        深链落点: ' + JSON.stringify(landed));
      await shot(wel, 'welcome-step2');
    } finally {
      try { await wel.close(); } catch (e) { /* 忽略 */ }
    }
  });

  await shot(pop, '13-popup-full');
  await pop.close();

  return report('UI 层真浏览器测试');
};
