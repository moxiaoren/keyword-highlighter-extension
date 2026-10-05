/* ============================================================================
 * popup/popup.js · 工具栏弹窗逻辑（策划案 §5.1 / §3.11）
 * ----------------------------------------------------------------------------
 * 统一化要点（与 v2 架构一致，勿回退）：
 *   · 全局开关 → `MSG.GLOBAL_TOGGLE`，由 background 统一落盘 + 广播 + 换图标
 *   · 站点禁用 → **storage.siteDisabledMap 为主**（内容脚本经 storage.onChanged
 *     必然生效），`MSG.SITE_TOGGLE` 只作 best-effort 通知
 *   · 版本显示 → `chrome.runtime.getManifest().version`（manifest 是唯一真源）
 *   · 快速添加 → 两条路：① **委托当前网页**（`MSG.EDITOR_OPEN` 让内容脚本在页面上弹
 *     860px 三列编辑器）；② 委托不了就**另开独立编辑窗口**（`popup/editor.html`，920×500，同一套 UI）。
 *     **两条路都会关掉本弹窗**（「在本弹窗内联」是 v1 旧行为，早已不是 —— 见 C7 F-7）
 *   · 关键词数 → **直接读配置**（`cfg.keywords` 条数，按条目计、含已停用条目），
 *     与命中统计无关（命中统计功能已于 1.99.99.19 整体移除，弹窗不再读 `stats`）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = window.KH;
  const D = KH.ui.dom;
  const MSG = KH.MSG;
  /** getElementById 语义（写 id 不带 #） */
  const $ = (id) => document.getElementById(id);
  /** 更新检测超时兜底：不让提示条永远停在「检查更新中…」 */
  const UPDATE_TIMEOUT_MS = 15000;
  /** 「＋ 快速添加」等**用户点击**路径的超时：短得多是刻意的 —— 这条路的兜底（独立编辑窗口）
   *  功能上与页面委派等价，所以卡住时**立刻换路**比让用户对着没反应的按钮等 15s 强（C7 F-4）。 */
  const EDITOR_TIMEOUT_MS = 2000;

  let cfg = null;
  let hostname = '';

  /* ---------------- 通用小工具 ---------------- */

  function read(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (r) => {
          const err = chrome.runtime.lastError;
          /* 读失败只影响本次视图（会用默认值渲染），如实记一笔即可，不打断主流程 */
          if (err) console.warn('[KH] popup：读取本地配置失败：', err.message || err);
          resolve(r || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  /** 直接落盘（background 不可用时的兜底路径）。**必须如实回报成败**：
   *  配额顶满时 chrome 只把错误放进 `chrome.runtime.lastError`，旧写法无条件 `resolve(true)`
   *  ⇒ 界面报「已保存」而磁盘零写入，动作永久丢失且零提示（C7 F-1）。 */
  function write(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => {
          const err = chrome.runtime.lastError;
          if (err) console.warn('[KH] popup：写入本地存储失败：', err.message || err);
          resolve(!err);
        });
      } catch (e) { resolve(false); }
    });
  }

  async function activeTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return (tabs && tabs[0]) || null;
    } catch (e) { return null; }
  }

  /** 给任意 Promise 加超时：**到点必定落地**（返回 `onTimeout()` 的结果；传入的值也接受）。
   *  Promise 自己 reject 时照旧 reject（不吞异常，调用方的 try/catch 语义不变）。
   *  【为什么必须有】内容脚本/后台"在，但卡住"时消息回执永不返回 —— 没有它，`render()` 会串行卡死、
   *  弹窗**永久半渲染**（点开关连 toast 都没有），用户看到的就是"这个弹窗坏了"（C7 F-4）。 */
  function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(typeof onTimeout === 'function' ? onTimeout() : onTimeout);
      }, ms);
      Promise.resolve(promise).then(
        (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
        (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
      );
    });
  }

  /** 向当前标签页内容脚本发消息；content script 不在（chrome:// 等）**或超时未答复**则返回 null 由调用方降级 */
  async function nudgeContent(type, payload) {
    const tab = await activeTab();
    if (!tab || tab.id == null) return null;
    try {
      return await withTimeout(
        chrome.tabs.sendMessage(tab.id, Object.assign({ type }, payload || {})),
        UPDATE_TIMEOUT_MS,
        () => {
          console.warn('[KH] popup：内容脚本 ' + (UPDATE_TIMEOUT_MS / 1000) + 's 未答复（' + type + '），按不可达降级');
          return null;
        }
      );
    } catch (e) { return null; }
  }

  /** 指定标签页在内容脚本里的**真值**：`siteEnabled`（受全局开关 × 本站禁用 × 网址规则共同决定）。
   *  站点卡原来只读 `siteDisabledMap`，于是被网址规则禁掉的页面显示「生效中」，按钮点两次页面零变化（C7 F-2）。
   *  返回 null = 内容脚本不可达（chrome:// / 扩展页 / 未注入），由调用方降级成「不可用」。 */
  async function contentSiteEnabled(tab) {
    if (!tab || tab.id == null) return null;
    try {
      const r = await withTimeout(
        chrome.tabs.sendMessage(tab.id, { type: MSG.STATE_QUERY }),
        UPDATE_TIMEOUT_MS,
        () => {
          console.warn('[KH] popup：内容脚本 ' + (UPDATE_TIMEOUT_MS / 1000) + 's 未答复（STATE_QUERY），站点卡按不可用降级');
          return null;
        }
      );
      if (r && typeof r.siteEnabled === 'boolean') return r.siteEnabled;
    } catch (e) { /* 内容脚本不可达：不算错误，走降级分支 */ }
    return null;
  }

  /** 向 background 发消息。**background 不可用时返回 null**；**超时未答复返回 `{timedOut:true}`**
   *  ——两者必须区分：不可用要降级，超时要说"超时"（诊断/状态这类交互的 toast 就靠这个区分）。
   *  超时不许再等：`render()` 里连着三次 IPC，只要一次永不返回，整个弹窗就永久半渲染（C7 F-4）。 */
  async function askBackground(message) {
    try {
      return await withTimeout(
        chrome.runtime.sendMessage(message),
        UPDATE_TIMEOUT_MS,
        () => {
          console.warn('[KH] popup：background ' + (UPDATE_TIMEOUT_MS / 1000) + 's 未答复（'
            + ((message && message.type) || '?') + '），按不可用降级');
          return { timedOut: true };
        }
      );
    } catch (e) { return null; }
  }

  function toast(msg, type) {
    try { D.toast(msg, type || 'ok'); } catch (e) { /* 组件层不可用不影响主流程 */ }
  }

  /* 🩺 诊断（只读，两档）：把"整页重建次数 / 其中变更通道多少次 / 最近触发来源 / 仅消费次数 / 最近一次相关性判定 /
   * 高亮组与命中规模 / 图片识别排队"整理成一段文本 → 复制到剪贴板 + 打到控制台。
   * 【为什么放 popup】用户反馈"某页卡"时，第一件要知道的就是"到底重不重建、因为什么重建"；
   * 有这行数据就不必靠猜（解读可对照 tests/E2E-REPORT.md K54 的判据表）。
   * 【两档分工（C7 O-2）】按钮只有一个名字、title 却只承诺三个计数，实际复制出去的却是完整网址 +
   * iframe 地址 + 用户关键词 + 表格原文 —— 名实不符。现在拆成两档：
   *   `#btn-diag`        完整档：现场原样（含用户数据），title 如实写清；
   *   `#btn-diag-counts` 仅计数档：**不给任何用户数据机会出门** —— 网址只留主机名、iframe 地址换占位、
   *                      词只留条数、结论走内容侧的 `verdictKind` 枚举（无词判据）。
   * 两档读同一份数据，计数档只是"少打印"，判据不分叉。 */
  /** 无词结论表：键 = 内容侧 `selfCheck().verdictKind`（枚举，见 src/core/index.js） */
  const KIND_TEXT = {
    'hit': '有命中 —— 匹配与定位本身正常。',
    'editable-visible': '可见文本里的词全都在可编辑区（扫描默认跳过可编辑内容），不是匹配问题。',
    'visible-miss': '词就在**可见文本**里却零命中 → 属匹配/定位问题（这条值得发给开发者）。',
    'hidden-only': '词只在不可见内容里（折叠/未激活），可见性剪枝所致，等内容显出来会自动补。',
    'shadow': '词在开放影子根里 → 先看「影子 DOM」开关是否打开。',
    'form': '词在表单控件的值里（input/textarea/select 的 value 不是文本节点）→ 文本高亮天生看不到。',
    'attr': '词只出现在属性里（title / placeholder / aria-label / alt）→ 页面上没有可见目标。',
    'editable': '词在可编辑区（contenteditable）里 → 扫描默认跳过可编辑内容。',
    'same-origin-frame': '本层文档里没有规则词，正文在同源子框架里（见子框架计数）。',
    'img-canvas': '本层文档里没有规则词，页面里有图片/画布 → 可能是画出来的字（走图片识别那条路）。',
    'none': '本层文档里没有任何规则词，也没看到 iframe / 图片 / 画布（见上面的计数）。',
    'error': '内容侧自查本身失败了（见上面的状态行）。'
  };

  /** 仅计数档用：把地址缩成主机名，避免路径/查询串里夹带用户数据 */
  function diagHost(u) {
    try { return new URL(String(u)).host || '（未知主机）'; } catch (e) { return '（无法解析的地址）'; }
  }

  /** 组装诊断文本。mode='full' 完整档 / 'counts' 仅计数档。 */
  function buildDiag(d, mode) {
    const counts = mode === 'counts';
    const sc = d.selfCheck;
    /* 本站没生效时"零命中"是预期结果：若照打印内容侧的匹配结论，就会出现
     * 「本站生效=false」紧跟「是匹配/定位的问题」的自相矛盾（C7 O-2 附带项）。 */
    const siteOff = d.siteEnabled === false;
    const lines = [
      '关键词高亮 · ' + (counts ? '仅计数诊断（无网址路径 / 无关键词 / 无页面文本，可直接外发）'
        : '完整诊断（含完整网址、iframe 地址、关键词与页面文本，注意别外发）'),
      '页面: ' + (counts ? (diagHost(d.url) + '（仅计数档只留主机名）') : d.url),
      '状态: booted=' + d.booted + ' 本站生效=' + d.siteEnabled + ' 规则=' + d.rules + ' 命中=' + d.hits + ' 高亮组=' + d.groups,
      '整页重建: ' + d.rebuildCount + ' 次（其中变更通道 ' + d.mutationRebuildCount + ' 次）'
        + (d.lastRebuildSource ? '，最近来源=' + d.lastRebuildSource : ''),
      '仅消费(抓取字段变化): ' + d.consumeOnlyCount + ' 次'
        + (d.lastVerdict ? '，最近一次变更判定=' + d.lastVerdict + '（' + d.lastVerdictRecords + ' 条记录）' : ''),
      /* 调度侧现场：判断"页面变了却一直不重建"到底卡在哪一步（K55） */
      '调度: 观察器回调=' + d.observerFire + ' 次，裁决=' + d.drainCount + ' 次'
        + '，其中"拖过上限直接判"=' + d.deferCapped + ' 次'
        + '，动画/过渡兜底=' + (d.animFallback || 0) + ' 次，文本量暴涨兜底=' + (d.growthFallback || 0) + ' 次'
        + '，变更处理=' + (d.changeHandling === 'always' ? '保守（任何变动都整页重建 + 每秒指纹兜底）' : '智能（相关性预筛）'),
      d.imgOcr ? ('图片识别: 条目=' + d.imgOcr.items + ' 缓存=' + d.imgOcr.cache + ' 排队=' + d.imgOcr.pending + ' 在途=' + d.imgOcr.inflight
        + (d.imgOcr.blocked && Object.keys(d.imgOcr.blocked).length
          ? ('｜未识别原因: ' + Object.keys(d.imgOcr.blocked).map((k) => k + '×' + d.imgOcr.blocked[k]).join(' '))
          : '')) : '图片识别: 未启用'
    ];
    /* 「为什么一个都没命中」自查（K57）：命中=0 时才是重点，所以逐词/子框架/结论只在命中=0 时附上 */
    if (sc && sc.doc) {
      const f = sc.frame || {};
      lines.push('文档: 本层框架=' + (f.top ? '是' : '⚠ 否（这份诊断来自 iframe）')
        + ' 文本=' + sc.doc.textContentLen + '字（可见 ' + sc.doc.innerTextLen + '字）'
        + ' 文本节点=' + sc.doc.textNodes + ' 元素=' + sc.doc.elements
        + ' 图=' + sc.doc.imgs + ' 画布=' + sc.doc.canvases
        + ' 影子根=' + sc.doc.shadowRoots + ' iframe=' + (sc.iframes || []).length);
      if (sc.scan) {
        const rj = sc.scan.rejects || {};
        const aged = sc.scan.at ? Math.round((Date.now() - sc.scan.at) / 1000) : null;
        lines.push('上一轮扫描: 文本节点=' + sc.scan.textNodes + ' 规则=' + sc.scan.rules
          + ' 命中=' + sc.scan.hits + '（' + sc.scan.ms + 'ms）'
          + (aged == null ? '' : '，发生在 ' + aged + ' 秒前')
          + '｜没收进来的文本节点: 不可见子树=' + (rj.invisible == null ? sc.scan.prunedInvisible : rj.invisible)
          + ' script/style=' + (rj.skipTag || 0) + ' 可编辑区=' + (rj.editable || 0)
          + ' 插件自身UI=' + (rj.ownUI || 0) + ' 空文本=' + (rj.empty || 0) + ' 无父节点=' + (rj.orphan || 0));
      }
      if (!d.hits) {
        for (const fr of (sc.iframes || [])) {
          lines.push('子框架: ' + (fr.sameOrigin ? '' : '跨域 ') + (counts ? '（地址已省略）' : fr.src)
            + ' 文本=' + fr.textLen + '字 该框架规则=' + fr.khRules + ' 命中=' + fr.khHits + ' 已上线=' + fr.khBooted);
        }
        /* 词"待在别的通道里"的计数（表单值 / 属性 / 可编辑区 / 影子根）—— 只列有值的，避免刷屏 */
        const other = (sc.words || []).filter((w) => w.inForm || w.inAttr || w.inEditable || w.inShadow);
        if (other.length) {
          lines.push(counts
            ? ('其它通道(表单值/属性/可编辑/影子根): 有记录的规则 ' + other.length + ' 条（明细仅完整档打印）')
            : ('其它通道(表单值/属性/可编辑/影子根): ' + other.slice(0, 5)
              .map((w) => w.word + '=' + w.inForm + '/' + w.inAttr + '/' + w.inEditable + '/' + w.inShadow).join(' | ')));
        }
        /* 组合词定位体检：标题词找到了没有、旁边那格有没有核心词（数字本身不含用户词） */
        if (sc.combo) {
          lines.push('组合词定位: 左右轴 检查格=' + sc.combo.cells + ' 标题命中=' + sc.combo.labeled
            + ' 右格含核心词=' + sc.combo.withCore + ' 无右格=' + sc.combo.noRight
            + '；上下轴 表头格=' + sc.combo.tbHeaders + ' 标题命中=' + sc.combo.tbLabeled
            + ' 数据格=' + sc.combo.tbCells + ' 含核心词=' + sc.combo.tbWithCore);
        }
      }
      if (siteOff) {
        lines.push('自查结论: 本站当前**未生效**（站点被禁用 / 网址规则禁用 / 全局暂停）—— 本页零命中是预期结果，'
          + '不能据此判断匹配有问题；要排查匹配，请先在**启用**的页面上点诊断。');
      } else if (counts) {
        lines.push('自查结论(无词档): ' + (KIND_TEXT[sc.verdictKind] || '内容侧没有给出判据类型（可能是旧版本内容脚本）。'));
      } else if (sc.verdict) {
        lines.push('自查结论: ' + sc.verdict);
      }
      /* 逐规则命中明细 + 逐词：用户说"某个格子不亮"时，这一行能立刻区分
       * "那条规则根本没命中"和"命中了但画在别处"（K59）。仅计数档只留条数。 */
      if (sc.words && sc.words.length) {
        lines.push(counts
          ? ('逐词概览: 有字面词的规则 ' + sc.words.length + ' 条（可见文本里有 '
            + sc.words.filter((w) => w.inInner > 0).length + ' 条，只在隐藏文本里 '
            + sc.words.filter((w) => w.inText > 0 && w.inInner === 0).length + ' 条）'
            + (sc.noLiteral ? ('；另有 ' + sc.noLiteral + ' 条正则/逐字规则无法用字面词自查') : ''))
          : ('逐词(规则词在"含隐藏文本/可见文本"里各出现几次): '
            + sc.words.map((w) => w.word + '=' + w.inText + '/' + w.inInner).join(' | ')
            + (sc.noLiteral ? ('（另有 ' + sc.noLiteral + ' 条正则/逐字规则无法用字面词自查）') : '')));
      }
      if (sc.ruleHits) {
        lines.push(counts
          ? ('命中概览: 有命中的规则 ' + sc.rulesWithHits + ' 条 / 没命中的规则 ' + sc.rulesWithoutHits + ' 条')
          : ('命中明细: ' + (sc.ruleHits.length
            ? sc.ruleHits.map((r) => r.word + (r.label ? ('(组合·' + r.label + ')') : '') + '×' + r.hits).join(' | ')
            : '（没有任何规则命中）')
            + ' —— 有命中的规则 ' + sc.rulesWithHits + ' 条 / 没命中的规则 ' + sc.rulesWithoutHits + ' 条'));
      }
      /* 组合词"定位现场"：核心词在可见文本里却没命中的组合词，把它所在格子的结构打出来 */
      if (counts) {
        if ((sc.comboTrace || []).length) {
          lines.push('组合词未命中现场: ' + sc.comboTrace.length + ' 处（含格内文本与同行格，仅完整档打印）');
        }
      } else {
        for (const tr of (sc.comboTrace || [])) {
          lines.push('组合词未命中现场: 「' + tr.word + '」' + (tr.label ? ('（标签「' + tr.label + '」）') : '')
            + (tr.found ? '' : ' —— 可见文本里找不到这个词')
            + (tr.tag ? (' → 所在格 <' + tr.tag + (tr.colSpan ? (' colspan=' + tr.colSpan) : '') + (tr.rowSpan ? (' rowspan=' + tr.rowSpan) : '') + '>')
              + ' 格内="' + tr.text + '"'
              + (tr.prev ? ' 左邻="' + tr.prev + '"' : '')
              + (tr.next ? ' 右邻="' + tr.next + '"' : '')
              + (tr.rowCells ? ' 同行格=' + JSON.stringify(tr.rowCells) : '（不在 <tr> 里）')
              + ' 标签在同格=' + (tr.labelInCell ? '是' : '否') + '/在同行=' + (tr.labelInScope ? '是' : '否') : ''));
        }
      }
    }
    lines.push('解读: 整页重建长期偏高且来源多为 mutation/fingerprint → 该页有大量"看起来相关"的变动；仅消费次数多为正常（抓取字段在刷新）。');
    return lines.join('\n');
  }

  /** 绑定一档诊断：mode 决定复制出去的文本（'full' / 'counts'） */
  function wireDiag(btn, mode) {
    if (!btn) return;
    const counts = mode === 'counts';
    btn.addEventListener('click', async () => {
      const tab = await activeTab();
      const d = tab ? await nudgeContent(MSG.DEBUG_DIAG) : null;
      if (!d || !d.ok) {
        toast('拿不到诊断信息（当前标签页不是普通网页，或内容脚本未注入）', 'error');
        return;
      }
      const text = buildDiag(d, mode);
      console.log('[KH 诊断' + (counts ? '·仅计数' : '') + ']\n' + text);
      try {
        await navigator.clipboard.writeText(text);
        toast(counts ? '仅计数诊断已复制（不含网址路径与关键词）' : '诊断信息已复制到剪贴板', 'ok');
      } catch (e) { toast('已输出到控制台（剪贴板不可用）', 'ok'); }
    });
  }
  wireDiag(document.getElementById('btn-diag'), 'full');
  wireDiag(document.getElementById('btn-diag-counts'), 'counts');

  /* ---------------- 渲染：头部 / 站点卡 ---------------- */

  /* 全局开关：**首屏（HTML 里 aria-busy + disabled）到这一帧之间不声称任何状态**（C7 O-4）。
   * 旧版 popup.html:26 硬编码「全局已开启」而开关画着未勾选，前 39–43ms 自相矛盾；
   * 现在三件事在同一帧落地：摘 aria-busy、解 disabled、写值 + 文案。 */
  function renderGlobalState(enabled) {
    const lbl = $('lbl-global');
    if (lbl) lbl.removeAttribute('aria-busy');
    $('chk-global').disabled = false;
    $('chk-global').checked = !!enabled;
    $('global-state').textContent = enabled ? '全局已开启' : '全局已暂停';
  }

  /* 状态**读不出来时不许猜**（C7 O-4）：开关留在"未就绪"外观且不可点，副标题说实话。
   * 与 renderGlobalState 互斥：谁最后跑谁定态，不存在"文案说开、开关画关"。 */
  function renderGlobalUnknown() {
    const lbl = $('lbl-global');
    if (lbl) lbl.setAttribute('aria-busy', 'true');
    $('chk-global').disabled = true;
    $('chk-global').checked = false;
    $('global-state').textContent = '状态读取失败';
  }

  function setSiteDisabledView(disabled, known) {
    if (!known) {
      const badge = $('site-badge');
      badge.textContent = '不可用';
      badge.classList.remove('is-disabled');
      badge.classList.add('is-unknown');
      $('btn-site').disabled = true;
      $('btn-site-icon').textContent = '🚫';
      $('btn-site-text').textContent = '禁用本站';
      return;
    }
    const badge = $('site-badge');
    badge.classList.remove('is-unknown');
    badge.textContent = disabled ? '已禁用' : '生效中';
    badge.classList.toggle('is-disabled', !!disabled);

    $('btn-site').disabled = false;
    $('btn-site-icon').textContent = disabled ? '✅' : '🚫';
    $('btn-site-text').textContent = disabled ? '启用本站' : '禁用本站';
    $('btn-site').classList.toggle('is-site-disabled', !!disabled);
    $('btn-site').title = disabled ? '重新启用本站高亮' : '临时禁用本站高亮';
  }

  /** 页面确实没高亮、但不是"本站禁用名单"造成的（全局暂停 / 网址规则）：badge 说实话，按钮按"点了有没有用"决定 */
  function setSiteBlockedView(blocked, label, btnTitle) {
    const badge = $('site-badge');
    badge.classList.remove('is-unknown');
    badge.textContent = label;
    badge.classList.add('is-disabled');

    $('btn-site').disabled = !!blocked;
    $('btn-site-icon').textContent = '🚫';
    $('btn-site-text').textContent = '禁用本站';
    $('btn-site').classList.remove('is-site-disabled');
    $('btn-site').title = btnTitle;
  }

  /* ---------------- 渲染：关键词数（配置项计数，与命中统计无关） ---------------- */

  /**
   * 「关键词数」= 已配置条目数（按条目计，含已停用条目，与「关键词数」字面一致）。
   * @param {Array=} list 显式传入的关键词数组（storage 变更时用）；缺省则取当前配置
   */
  function renderKeywordCount(list) {
    const arr = list || (cfg && cfg.keywords) || [];
    $('keyword-count').textContent = String(arr.length);
  }

  /* ---------------- 渲染：站点状态（判据 = 内容脚本真值，storage 只决定按钮文案） ---------------- */

  /**
   * @param {boolean|null} eff 内容脚本回报的 `siteEnabled`（null = 不可达）
   * @param {boolean} globalEnabled 全局开关（用于区分"本站禁用"与"全局暂停"两种归因）
   */
  async function renderSite(eff, globalEnabled) {
    if (!hostname) {
      $('site-name').textContent = '（无法获取）';
      setSiteDisabledView(false, false);
      $('btn-site').title = '当前页面不支持站点设置';
      return;
    }
    $('site-name').textContent = hostname;
    $('site-name').title = hostname;

    const { siteDisabledMap } = await read(['siteDisabledMap']);
    const mapDisabled = !!((siteDisabledMap || {})[hostname]);

    /* 内容脚本不可达（chrome:// / 扩展页 / 未注入）：维持原有「不可用」降级，不猜 */
    if (eff === null) {
      setSiteDisabledView(false, false);
      $('btn-site').title = '当前页面不支持站点设置';
      return;
    }
    /* 真值 = 生效中：按钮按"本站禁用名单"的现状显示（点一下把它加进去） */
    if (eff === true) { setSiteDisabledView(mapDisabled, true); return; }
    /* 页面确实没高亮，归因决定 badge 说实话、按钮有没有用 */
    if (mapDisabled) { setSiteDisabledView(true, true); return; }
    if (globalEnabled === false) {
      setSiteBlockedView(false, '已暂停', '临时禁用本站高亮（当前全局高亮已暂停）');
      return;
    }
    /* 既没被本站禁用、也没暂停 ⇒ 只能是被网址规则挡掉了：此时点按钮没用，如实禁用并说明去哪改 */
    setSiteBlockedView(true, '已禁用', '该页面被网址规则禁用，请到设置页调整规则');
  }

  /* ---------------- 更新通道切换 ----------------
   * 2026-10-05 用户口径：插件入口取消"线上更新" —— 检查更新 / 更新提示条 / 下载更新包 / 「稍后」，
   * 连同 `background/update-checker.js`、6h 轮询与 ↑ 徽标**全部删除**，只留「稳定版 ←→ 测试版」这一个开关。
   * 通道读写落在 `src/core/channel.js`（只碰 chrome.storage.local 一个键，不发任何网络请求）；
   * 所以这里不再有 currentUpdateInfo / DISMISS_KEY / checkUpdate，也不再加载任何 update-checker。 */

  /* ---------------- 总刷新 ---------------- */

  async function render() {
    let version = '';
    try { version = chrome.runtime.getManifest().version || ''; } catch (e) { version = ''; }
    $('version').textContent = 'v' + (version || '—');
    $('version').title = '当前版本 ' + (version || '未知');

    cfg = await KH.Store.load();

    // 当前站点 hostname：只有 http(s) 页面才有"站点"语义
    // （chrome:// / edge:// / about: 等 new URL() 也能解析出 hostname，但不是可管理站点）
    const tab = await activeTab();
    hostname = '';
    if (tab && tab.url) {
      try {
        const u = new URL(tab.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') hostname = u.hostname || '';
      } catch (e) { hostname = ''; }
    }

    // 全局开关：storage 为准（background 落盘），background 不在也能显示正确
    const { globalEnabled } = await read(['globalEnabled']);
    const bg = await askBackground({ type: MSG.STATE_QUERY });
    const globalOn = bg && bg.globalEnabled !== undefined ? bg.globalEnabled : (globalEnabled !== false);
    renderGlobalState(globalOn);

    // 站点卡判据：向内容脚本要**真值**（storage 里的 siteDisabledMap 只决定按钮文案）
    const eff = await contentSiteEnabled(tab);
    await renderSite(eff, globalOn);
    renderKeywordCount();
  }

  /* ---------------- 事件绑定 ---------------- */

  // 全局开关：交给 background 统一落盘 + 广播（协议 GLOBAL_TOGGLE）
  $('chk-global').addEventListener('change', async (e) => {
    const value = !!e.target.checked;
    renderGlobalState(value);   // 乐观渲染（失败或 background 回执会修正）
    const res = await askBackground({ type: MSG.GLOBAL_TOGGLE, value });
    /* background 明确回报失败（例如配额顶满：它的处理器 reject 后被 `:168` 折成 ok:false）
     * —— 旧写法只判 `!res`，把 `{ok:false}` 当成成功继续报「已暂停全局高亮」。 */
    if (res && res.ok === false) {
      renderGlobalState(!value);
      toast('保存失败：' + (res.error || '本地存储不可用'), 'error');
      return;
    }
    /* `{timedOut:true}`（background 没在 15s 内答复）必须走**直接落盘兜底**并如实回报成败：
     * 旧写法只判 `!res`，超时对象是真值 ⇒ 掉进 else 分支当成功，用户以为开关保存了（C7 F-4 + F-1 同族）。 */
    if (!res || res.timedOut) {
      const ok = await write({ globalEnabled: value });   // background 不可用：直接落盘兜底
      if (!ok) {
        renderGlobalState(!value);
        toast('保存失败：本地存储已满或被禁用，本次改动未生效', 'error');
        return;
      }
    } else {
      renderGlobalState(res.globalEnabled !== undefined ? res.globalEnabled : value);
    }
    toast(value ? '已开启全局高亮' : '已暂停全局高亮', 'ok');
  });

  // 站点禁用：storage 为主（内容脚本 storage.onChanged 必然生效），消息仅作提醒
  $('btn-site').addEventListener('click', async () => {
    if (!hostname) { toast('当前页面不支持站点设置', 'error'); return; }
    const { siteDisabledMap = {} } = await read(['siteDisabledMap']);
    const next = !siteDisabledMap[hostname];
    const map = Object.assign({}, siteDisabledMap);
    if (next) map[hostname] = true; else delete map[hostname];
    /* 先落盘、成了再翻卡片：旧写法先翻卡片再写、且不看返回值 ⇒ 写失败时卡片显示
     * 「已禁用」而磁盘没变、页面照常高亮，用户以为生效了（C7 F-1）。 */
    const okWrite = await write({ siteDisabledMap: map });
    if (!okWrite) {
      toast('保存失败：本地存储已满或被禁用，本次改动未生效', 'error');
      return;
    }

    setSiteDisabledView(next, true);
    const reply = await nudgeContent(MSG.SITE_CHANGED, { host: hostname, disabled: next });
    toast(next ? '已禁用本站高亮' : '已启用本站高亮', 'ok');
    if (!reply) console.info('[KH] popup：内容脚本未响应，站点状态已写入 storage，页面刷新后同样生效');
  });

  /* 快速添加：与关键词管理界面**一模一样**的独立编辑器（用户实测要求："单独弹出一个一模一样的弹出"）。
   *  ① 首选**委托当前网页**：860px 三列原地覆盖在页面上，观感就是选项页那个弹窗；
   *  ② 委托不了时（chrome:// / 扩展页 / 内容脚本还没注入，例如刚重载扩展未刷新页面）
   *     **另开一个独立编辑窗口**（popup/editor.html，920×500，同一套 UI）——
   *     绝不回退成"塞进 348px 的插件弹窗里"（那正是用户否掉的观感）。
   * 说明：v2 早期把"另开窗口"列为要避免的做法（R8），但那是针对"跳设置页、还得自己再点添加"；
   *   这里开的是**只装编辑器的独立窗口**，用户看到的就是那个弹窗本身，语义与观感都成立。
   */
  async function openQuickAdd(tabId) {
    try {
      let id = tabId;
      if (id == null) {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        id = t && t.id;
      }
      if (id != null) {
        /* 内容脚本"在但卡住"时回执永不返回 ⇒ 旧写法永远 await，用户点 ＋ 毫无反应（C7 F-4）。
         * 超时（或 reject）一律落到下面的独立窗口兜底，**不假装成功**。 */
        const r = await withTimeout(
          chrome.tabs.sendMessage(id, { type: KH.MSG.EDITOR_OPEN }),
          EDITOR_TIMEOUT_MS,
          () => {
            console.warn('[KH] popup：内容脚本 ' + (EDITOR_TIMEOUT_MS / 1000) + 's 未应答 EDITOR_OPEN，改开独立窗口');
            return null;
          }
        );
        if (r && r.ok) { window.close(); return 'page'; }   // 已在页面上弹出 → 弹窗功成身退
      }
    } catch (err) { /* 内容脚本不可达 → 走独立窗口 */ }
    /* 独立窗口也可能开不出来（窗口数顶到上限 / 内存不足 / 被企业策略禁用）——
     * 旧写法把 `windows.create` 放在 try 之外、调用处也不 catch ⇒ **零 toast、零日志、
     * 弹窗停在原地**，用户看到的就是"点了没反应"（C-5 注入实测）。这里必须明说。 */
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup/editor.html'),
        type: 'popup', width: 920, height: 500
      });
    } catch (err) {
      toast('无法打开编辑窗口，请重试或到设置页添加', 'error');
      return 'failed';
    }
    window.close();
    return 'window';
  }

  /* 调用处兜底：openQuickAdd 之外的意外异常也不许变成 unhandled rejection（一样是"点了没反应"） */
  $('btn-add').addEventListener('click', () => {
    openQuickAdd(null).catch(() => toast('无法打开编辑窗口，请重试或到设置页添加', 'error'));
  });
  /* 供真浏览器回归直接驱动（等价于点按钮，但可以指定目标标签页） */
  KH.popupOpenQuickAdd = openQuickAdd;

  /* 更新通道切换：稳定版 ←→ 测试版（只写本机设置；读写实现都在 src/core/channel.js）。
   * 旧注释写的是"测试版读 latest-beta.json、稳定版读 latest.json"—— 那是**检查更新**时代的模型；
   * 现在插件入口不再检查线上更新，这个开关只决定本机档位（并在独立测试版包上锁成只读）。
   * 另一句"crx 通道无法分通道、测试版只能走 zip 通道更新"也一并作废：两条通道各有自己的 crx 更新源。 */
  /* 通道确认窗口：单击只"准备"、再点一下才落盘（C7 O-1：原先是单击即持久化，无确认也无撤销） */
  const CHANNEL_CONFIRM_MS = 6000;
  let channelPending = '';    // '' | 'stable' | 'beta'：待确认的目标通道
  let channelTimer = 0;

  async function renderChannel() {
    const btn = $('btn-channel');
    if (!btn) return;
    /* 显示口径必须等于**决策口径**：`UpdateChannel.effective()` 认 manifest 里的 beta
     * （独立测试版包永远是测试通道），而 `get()` 只读用户设置 —— 两者分叉会把
     * "被强制成测试版"的包显示成「稳定版」（C7 O-1 附带项 / P-03）。 */
    const stored = await KH.UpdateChannel.get();
    const effective = await KH.UpdateChannel.effective();
    const forcedBeta = effective === 'beta' && stored !== 'beta';
    channelPending = '';
    clearTimeout(channelTimer);
    if (forcedBeta) {
      btn.disabled = true;
      btn.textContent = '🔒 测试版';
      btn.title = '这个包本身就是测试版（manifest 里写着 beta），更新通道固定为测试版，不能切换。';
      return;
    }
    btn.disabled = false;
    const label = effective === 'beta' ? '测试版' : '稳定版';
    const target = effective === 'beta' ? '稳定版' : '测试版';
    btn.textContent = '🔀 ' + label;
    btn.title = '更新通道：' + label + '（只影响你本机）；点一下准备切到' + target + '，再点一下确认；切完再点可切回。';
  }
  if ($('btn-channel')) {
    $('btn-channel').addEventListener('click', async () => {
      const btn = $('btn-channel');
      if (btn.disabled) return;                       // 被强制的测试版包：只读，点了也不动
      const cur = await KH.UpdateChannel.get();
      const next = cur === 'beta' ? 'stable' : 'beta';
      const nextLabel = next === 'beta' ? '测试版' : '稳定版';
      if (channelPending !== next) {                  // 第一次点：只准备，不落盘
        channelPending = next;
        btn.textContent = '❓ 切到' + nextLabel + '？';
        btn.title = '再点一下确认切到' + nextLabel + '（' + (CHANNEL_CONFIRM_MS / 1000) + ' 秒内有效，不点自动取消）';
        clearTimeout(channelTimer);
        channelTimer = setTimeout(() => { renderChannel(); }, CHANNEL_CONFIRM_MS);
        return;
      }
      clearTimeout(channelTimer);
      channelPending = '';
      try {
        await KH.UpdateChannel.set(next);
      } catch (err) {
        /* 写不进就别说"已切到"：否则用户以为通道换了，实际还是老通道（C7 F-1 同族） */
        toast('切换失败：' + ((err && err.message) || '本地存储不可用'), 'error');
        await renderChannel();
        return;
      }
      await renderChannel();
      /* 不再"切完顺带检查更新"：插件入口已经没有线上更新这条路了（2026-10-05 用户口径）。 */
      toast('已切到' + nextLabel + '（再点一下可切回）', 'ok');
    });
  }

  // 帮助：跳到设置页「帮助与隐私」分区（v1 曾出现点击无效，这里保证绑定 + 可测）
  $('btn-help').addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sec-help') });
      window.close();
    } catch (e) { toast('打开帮助失败', 'error'); }
  });

  // 完整设置
  $('btn-options').addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
      window.close();
    } catch (e) { toast('打开设置页失败', 'error'); }
  });

  // 外部变更（background 广播 / 其它弹窗页 / 内容脚本）→ 实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.globalEnabled) renderGlobalState(changes.globalEnabled.newValue !== false);
    if (changes.siteDisabledMap && hostname) {
      setSiteDisabledView(!!((changes.siteDisabledMap.newValue || {})[hostname]), true);
    }
    if (changes.keywords) renderKeywordCount(changes.keywords.newValue);
  });

  renderChannel();          // 更新通道徽标（稳定版 / 测试版）
  render().catch((err) => {
    console.error('[KH] popup 初始化失败', err);
    renderGlobalUnknown();      // 首屏那句「读取中…」必须收口，否则永远停在那儿（C7 O-4）
    setSiteDisabledView(false, false);
  });
})();
