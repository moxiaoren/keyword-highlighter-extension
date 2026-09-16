/**
 * 关键词高亮引擎
 * 负责在 DOM 中查找和高亮关键词
 */
const KeywordEngine = {
  // 抓取后续字段：多行文本按这些固定标题分组（v1.6.42，后续可改）
  FETCH_GROUP_TITLES: ['基本信息', '测试信息', '资质信息', '运营备注'],
  highlightedNodes: new Set(),
  _cellVerifyHighlights: new Set(),  // 原网页期望值高亮（右侧单元格），removeAll 时恢复（v1.7.9）
  // v1.10.15【CSS Custom Highlight 重构】普通关键词高亮改用 CSS Highlight API，
  // 不再 replaceChild 摘离文本节点 → 框架翻页对原文本节点引用赋新值不会被孤儿化，
  // 新值能正常进入页面，从根上解决「值后到/翻页残留且内容不变」问题。
  // 数据承载：内存命中注册表（替代原先挂在 span 上的 data-* 属性），交互层读它 + 坐标命中。
  _plainHits: [],           // [{range,textNode,start,end,kwId,note,important,importantNote,importantBase,imgSize,bg,adj}]
  _hlGroups: new Map(),     // styleKey -> { name, ranges:[] }
  _hlStyleEl: null,         // 注入 ::highlight 规则的 <style>
  _hlIdx: 0,
  observer: null,
  shadowObserver: null,
  processingQueue: [],
  processingTimer: null,
  // 跟踪延迟高亮定时器，destroy 时可取消，避免切换站点后旧定时器复活
  _highlightTimer: null,
  _flushTimer: null,
  _postRebuildTimer: null,
  _postRebuildRoots: null,

  /**
   * 初始化引擎
   */
  async init() {
    const data = await Storage.getAll();
    if (!data.globalEnabled) return;

    const hostname = Utils.getHostname();
    const shouldHighlight = await Utils.shouldHighlightForSite(
      hostname,
      data.siteRules || [],
      data.siteDisabledMap || {},
      window.location.href
    );
    if (!shouldHighlight) return;

    const enabledKeywords = (data.keywords || []).filter(k => k.enabled);
    if (enabledKeywords.length === 0) return;

    await this.highlightKeywords(enabledKeywords, data);
    this.setupMutationObserver(enabledKeywords, data);
    if (data.shadowDOMEnabled) {
      this.setupShadowDOMObserver(enabledKeywords, data);
    }
  },

  /**
   * 高亮关键词
   */
  _compileKeywords(keywords, config) {
    const groups = config.groups || [];
    const groupMap = {};
    groups.forEach(g => { if (g) groupMap[g.id] = g; });
    const compiledKeywords = keywords.map(kw => {
      const rawText = String(kw.text || '').trim();
      // 罕见字规则（kind==='rare'，text 为占位符 hjz#）：不匹配文本，运行时逐字判定罕见字符。
      // - 独立罕见字词（未配标题）：页面任意位置命中罕见字都高亮。
      // - 罕见字作为组合词【核心/右侧】（配了标题词）：标题词右侧出现罕见字才命中高亮。
      const isRare = kw.kind === 'rare';
      // 组合关键词：cellVerify=左格标题、text=右格核心
      const isCombo = !!(kw.cellVerifyEnabled && kw.cellVerify && String(kw.cellVerify).trim());
      const isRareCombo = !!(isRare && isCombo); // 罕见字作为组合核心（右侧）
      // 特殊「仅抓取」模式(v1.8.6)：关键词留空 + 标题关键词 + 抓取字段 →
      // 当标题格右侧单元格含中英数字(非'-'/非空)时，抓 fetchLabels 右侧内容进重要笔记；页面仅透明标记收集、不高亮。
      const specialFetch = isCombo && !rawText && !!(kw.fetchLabels && String(kw.fetchLabels).trim());
      // 罕见字独立词不生成 text 正则（逐字扫描）；普通词走 buildMatchRegex
      const re = isCombo ? null : (isRare ? null : Utils.buildMatchRegex(kw));
      if (!isCombo && !re && !isRare) return null;
      const titleRegex = isCombo ? Utils.buildMatchRegex({
        text: kw.cellVerify,
        useRegex: kw.cellVerifyUseRegex,
        caseSensitive: kw.cellVerifyCaseSensitive,
        // v1.11.0【改指向】：标题词的「全词」由组合词面板该区按钮(cellVerifyMatchMode=exact)控制，
        // 不再硬编码关闭（此前标题词永远无法整词精确匹配）。
        wholeWord: (kw.cellVerifyMatchMode === 'exact')
      }) : null;
      if (isCombo && !titleRegex) return null;
      const group = kw.groupId ? groupMap[kw.groupId] : null;
      return {
        ...kw,
        isRare: isRare,
        isRareCombo: isRareCombo,
        regex: re,
        titleRegex: titleRegex,
        specialFetch: !!specialFetch,
        // 优先级：分组颜色 > 关键词自身颜色 > 全局默认
        effectiveBgColor: (group && group.bgColor) || kw.bgColor || config.highlightStyle.defaultBgColor,
        effectiveTextColor: (group && group.textColor) || kw.textColor || config.highlightStyle.defaultTextColor,
        // 重要标识：自身重要 或 所属分组重要（运行时继承，分组取消则自动取消）
        effectiveImportant: !!(kw.important || (group && group.important)),
        // 重要展示文本：关键词自身笔记优先，否则用分组的统一重要笔记（分组重要且已配置）
        effectiveImportantNote: (kw.importantNote && String(kw.importantNote).trim()) ||
                                (group && group.important && group.importantNote && String(group.importantNote).trim()) || '',
        // 重要笔记底色优先级：(v1.9.4) 关键词自身底色优先，否则用分组统一底色（分组重要且已配置）
        effectiveImpNoteBg: (kw.impNoteBg && String(kw.impNoteBg).trim()) ||
                            (group && group.important && group.impNoteBg && String(group.impNoteBg).trim()) || '',
        // 重要笔记图片尺寸优先级：（v1.9.4）关键词自身尺寸优先，否则用分组统一尺寸（分组重要且已配置）
        effectiveImgSize: (kw.imgSize) ||
                         (group && group.important && group.imgSize) || ''
      };
    }).filter(k => k !== null);
    return compiledKeywords;
  },

  async highlightKeywords(keywords, config) {
    const startTime = performance.now();
    let totalHits = 0;
    // v1.10.15【CSS Custom Highlight】全量重建语义：先重置全部普通词命中（含断开节点的旧Range），
    // 再按当前 DOM 全量重建，避免全局 CSS.highlights 上的旧 Range 残留累积导致重复计数。
    this._clearAllPlainHits();
    const compiledKeywords = this._compileKeywords(keywords, config);
    if (compiledKeywords.length === 0) return;

    // 处理主文档
    totalHits += this._highlightInRoot(document.body, compiledKeywords, config);

    const elapsed = performance.now() - startTime;
    if (elapsed > 50) {
      console.debug(`[KeywordHighlighter] 高亮完成: ${totalHits} 处命中, 耗时 ${elapsed.toFixed(2)}ms`);
    }

    // 通知外部（用于刷新置顶悬浮笔记面板）
    if (typeof this.onHighlight === 'function') {
      try { this.onHighlight(); } catch (e) {}
    }
  },

  /**
   * 在根节点中高亮
   */
  _highlightInRoot(root, compiledKeywords, config) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!Utils.isHighlightableNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    let totalHits = 0;
    const verifyJobs = []; // v1.8.1：期望值高亮延迟到所有文本节点处理完后再执行，避免先拆分右格 DOM 破坏 _highlightInRoot 已缓存的原始文本节点
    for (const textNode of textNodes) {
      totalHits += this._highlightTextNode(textNode, compiledKeywords, config, verifyJobs);
    }
    // 第二遍：对每个命中的组合关键词统一高亮右侧【核心】片段（此时右格当前 DOM 已就绪，含普通关键词拆分后的结构）
    for (let i = 0; i < verifyJobs.length; i++) {
      const job = verifyJobs[i];
      if (!job) continue;
      if (job.fetchOnly) this._highlightFetchOnly(job.fetchOnly, job.kw, job.style);
      if (job.cell) this._highlightCellVerify(job.cell, job.kw, job.style, job);
      else if (job.tn && !job.fetchOnly) this._highlightFakeCellVerify(job.tn, job.kw, job.style, job);
    }

    return totalHits;
  },

  /**
   * 在单个文本节点中高亮关键词
   */
  _highlightTextNode(textNode, compiledKeywords, config, verifyJobs) {
    const text = textNode.textContent;
    if (!text.trim()) return 0;

    // 收集所有匹配
    const allMatches = [];
    for (const kw of compiledKeywords) {
      // 组合关键词翻转(v1.8.3)：用标题正则匹配【左格标题】(cellVerify)，右格验证含核心后收集右格供第二遍高亮；标题本格不高亮。
      const isCombo = !!(kw.cellVerifyEnabled && kw.cellVerify);
      // 罕见字独立词（未配标题/组合，v1.12.0）：不匹配 text，直接对本文本节点逐字检测罕见字
      if (kw.isRare && !isCombo) {
        const hits = (typeof RareChar !== 'undefined') ? RareChar.scanRare(text) : [];
        for (let hi = 0; hi < hits.length; hi++) {
          const h = hits[hi];
          allMatches.push({ start: h.index, end: h.index + h.length, keyword: kw, text: h.char });
        }
        continue;
      }
      const regex = isCombo ? (kw.titleRegex || kw.regex) : kw.regex;
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        if (isCombo) {
          // 特殊「仅抓取」(v1.8.6)：标题格右侧含中英数字(非'-'/非空) → 收集透明标记供重要笔记抓取展示，页面不高亮。
          if (kw.specialFetch) {
            if (this._fetchNonEmptyPass(textNode, match, kw) && verifyJobs && Array.isArray(verifyJobs)) {
              verifyJobs.push({ fetchOnly: textNode, kw: kw, style: config.highlightStyle });
            }
            if (match[0].length === 0) regex.lastIndex++; // 防止死循环
            continue;
          }
          // 标题命中（左格）：验证右格/|后 含【核心】(kw.text)。通过则收集右格单元格，标题本格不生成高亮。
          if (!this.cellVerifyPass(textNode, match, kw)) {
            if (match[0].length === 0) regex.lastIndex++; // 防止死循环
            continue;
          }
          if (verifyJobs && Array.isArray(verifyJobs)) {
            const cell = this._findRightCell(textNode);
            const hitText = match[0] ? String(match[0]) : '';
            if (cell) verifyJobs.push({ cell: cell, kw: kw, style: config.highlightStyle, hitText: hitText });
            else verifyJobs.push({ tn: textNode, kw: kw, style: config.highlightStyle, hitText: hitText }); // 文字假表格：|后核心在同行，单独高亮
          }
          if (match[0].length === 0) regex.lastIndex++; // 防止死循环
          continue;
        }
        // 普通关键词 / 未启用单元格验证：匹配文本本身即命中
        if (!this.cellVerifyPass(textNode, match, kw)) {
          if (match[0].length === 0) kw.regex.lastIndex++; // 防止死循环
          continue;
        }
        allMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          keyword: kw,
          text: match[0]
        });
        if (match[0].length === 0) kw.regex.lastIndex++; // 防止死循环
      }
    }

    if (allMatches.length === 0) return 0;

    // 排序并去重（优先保留长匹配、高优先级）
    allMatches.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return b.end - a.end; // 长匹配优先
    });

    // 移除重叠匹配
    const filtered = [];
    for (const m of allMatches) {
      if (filtered.length === 0 || m.start >= filtered[filtered.length - 1].end) {
        filtered.push(m);
      }
    }

    if (filtered.length === 0) return 0;

    // 创建高亮片段
    // v1.10.15【CSS Custom Highlight 重构】普通关键词高亮不再 replaceChild 摘离文本节点，
    // 改为在原文上创建 Range 记入 CSS.highlights（文本节点始终留在 DOM），
    // 使框架翻页对该文本节点引用赋新值能正常写入 → 彻底解决「翻页后内容不变/残留」。
    // 先清理该节点旧的普通词命中（幂等），再按当前文本重建。
    this._clearPlainHitsForTextNode(textNode);

    for (const m of filtered) {
      const bgColor = m.keyword.effectiveBgColor || config.highlightStyle.defaultBgColor;
      const textColor = m.keyword.effectiveTextColor || config.highlightStyle.defaultTextColor;
      let range = null;
      try {
        range = document.createRange();
        range.setStart(textNode, m.start);
        range.setEnd(textNode, m.end);
      } catch (e) {
        range = null;
      }
      const meta = {
        range: range,
        textNode: textNode,
        start: m.start,
        end: m.end,
        kwId: m.keyword.id || '',
        bg: bgColor,
        textColor: textColor,
        note: '',
        important: false,
        importantNote: '',
        importantBase: '',
        imgSize: '',
        impNoteBg: '',
        adj: ''
      };
      // 存储备注信息（组合关键词：左右单元格组合，交互移到右侧期望值单元格，本处仅普通词）
      const isCellCombo = !!(m.keyword.cellVerifyEnabled && m.keyword.cellVerify);
      if (m.keyword.note && !isCellCombo) meta.note = m.keyword.note;
      // 重要标识数据（置顶悬浮笔记聚合用）
      // v1.13.0【3a】普通关键词（无标题）配置了抓取字段(fetchLabels)时：即使未标「重要」也抓取右侧字段并进重要笔记，
      // 使「只加关键词+抓取字段」的普通词按 fetchLabels 生效（此前仅重要词才抓取）。
      const wantFetch = m.keyword.fetchLabels && String(m.keyword.fetchLabels).trim();
      if (m.keyword.effectiveImportant || wantFetch) {
        meta.important = true;
        let note = m.keyword.effectiveImportantNote || '';
        const fetched = this._extractFetched(textNode, m.keyword);
        if (fetched.length) {
          const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
          note = note ? note + '\n' + part : part;
        }
        meta.importantNote = note;
        meta.importantBase = m.keyword.effectiveImportantNote || '';
        if (m.keyword.effectiveImgSize) meta.imgSize = m.keyword.effectiveImgSize;
        if (m.keyword.effectiveImpNoteBg) meta.impNoteBg = m.keyword.effectiveImpNoteBg; // v1.9.3 笔记底色(含分组兜底)
      }
      // 单元格特别标注：验证通过后记录期望值，供重要笔记展示相邻标注
      if (m.keyword.cellVerifyEnabled && m.keyword.cellVerify) {
        meta.adj = m.keyword.cellVerify;
        // v1.8.1：期望值高亮仍由 verifyJobs 延迟到所有文本节点处理完后，右格高亮保留 span 方式不动
        if (verifyJobs && Array.isArray(verifyJobs)) {
          const cell = this._findRightCell(textNode);
          verifyJobs.push({ cell: cell, kw: m.keyword, style: config.highlightStyle });
        }
      }
      if (range) this._registerPlainHit(meta);
    }

    return filtered.length;
  },

  /**
   * 普通关键词命中注册表（v1.10.15 CSS Highlight 引入）。
   * 返回当前所有普通关键词命中的元数据（供重要笔记聚合 / 备注卡片交互）。
   */
  getPlainHits() {
    const out = [];
    for (const h of this._plainHits) {
      const textNode = h.textNode;
      if (!textNode || !textNode.parentNode || !document.contains(textNode)) continue;
      out.push({
        text: h.aggText || (textNode.nodeValue || '').slice(h.start, h.end), // v1.11.1 跨节点用整格完整文本
        range: h.range,
        textNode: textNode,
        start: h.start, end: h.end,
        kwId: h.kwId,
        note: h.note,
        important: !!h.important,
        importantNote: h.importantNote || '',
        importantBase: h.importantBase || '',
        imgSize: h.imgSize || '',
        bg: h.bg || ''
      });
    }
    return out;
  },

  /**
   * 仅返回重要命中（供置顶重要笔记面板聚合）
   */
  getImportantPlainHits() {
    const hits = this._plainHits;
    const out = [];
    for (const h of hits) {
      if (!h.important) continue;
      const textNode = h.textNode;
      if (!textNode || !textNode.parentNode || !document.contains(textNode)) continue;
      // 隐藏元素不展示
      if (Utils.isElementHidden(textNode.parentNode)) continue;
      out.push({
        textNode: textNode,
        text: h.aggText || (textNode.nodeValue || '').slice(h.start, h.end),
        kwId: h.kwId,
        note: h.importantNote || '',
        adj: h.adj || '',
        imgSize: h.imgSize || '',
        bg: h.impNoteBg || ''
      });
    }
    return out;
  },

  /**
   * 抓取后续字段（v1.6.36）
   * 命中后读取配置标签右侧单元格的内容，供重要笔记拼接展示。
   * 配置格式：kw.fetchLabels 为字符串，多个标签用 | / ｜ / , / ， 分隔（如 "地址|籍贯"）。
   * 在命中位置所属的最近 HTML 表格中查找「文本=标签」的单元格，取其右邻单元格内容作为值。
   */
  _extractFetched(textNode, kw) {
    const raw = (kw.fetchLabels || '').trim();
    if (!raw) return [];
    let el = textNode ? textNode.parentNode : null;
    while (el && el.nodeType === 1 && el.tagName !== 'TABLE') el = el.parentNode;
    if (el && el.tagName === 'TABLE') {
      return this._extractFetchedFromTable(el, kw);
    }
    // v1.13.4【假表格】页面用 div/flex 布局（无 <table>）时，按 fetchLabels 在命中区域最近的容器里
    // 找「文本==标签」的元素右邻内容，不再因找不到表格而抓取失效 / 回退抓标题右侧。
    return this._extractFetchedFromFakeTable(textNode, kw);
  },

  /**
   * 给定表格按 fetchLabels 抓取右邻单元格（v1.10.6 抽出，供初始抓取与异步重抓共用）
   */
  _extractFetchedFromTable(table, kw) {
    const raw = (kw.fetchLabels || '').trim();
    if (!raw) return [];
    // 支持「简单模式」标记：字段末尾加 #1 → 只取右侧相邻一个单元格的值（如 资质类型#1），
    // 而非像审测一体审核结果描述那样抓整块做完整表格（v1.7.8）。
    const items = raw.split(/[|｜,，]/).map(function (x) { return x.trim(); }).filter(Boolean)
      .map(function (t) {
        const m = /^(.*?)#\s*1\s*$/.exec(t);
        if (m) return { label: m[1].replace(/^[ \u3000]+|[ \u3000]+$/g, ''), simple: true };
        return { label: t, simple: false };
      });
    if (items.length === 0) return [];

    const cells = table.querySelectorAll('td, th');
    const out = [];
    for (const item of items) {
      const label = item.label;
      let target = null;
      for (const cell of cells) {
        if ((cell.textContent || '').trim() === label) { target = cell; break; }
      }
      if (!target) continue;
      let rows;
      if (item.simple) {
        // 简单模式：取标签行右侧相邻第一个单元格的值（跳过按钮、合并同单元格多子元素文本）
        const tr = target.parentElement;
        const right = tr.cells[target.cellIndex + 1];
        if (right) {
          const val = this._cellText(right, true);
          if (val) rows = [[{ t: val, rs: 1, cs: 1 }]];
        }
      } else {
        rows = this._collectRightBlock(target, table);
      }
      if (rows && rows.length) out.push({ label: label, rows: rows });
    }
    return out;
  },

  /**
   * v1.13.4【假表格抓取】页面用 div/flex 布局（无 <table>，如列表/卡片式表单）时，
   * 按 fetchLabels 在命中位置最近的「包含全部待抓标签文本」的容器内，找「文本==标签」的元素，
   * 取其右侧（右邻兄弟）内容作为值。与 HTML 表格抓取语义一致，修复普通词/仅抓取在假表格不生效。
   */
  _extractFetchedFromFakeTable(textNode, kw) {
    const raw = (kw.fetchLabels || '').trim();
    if (!raw) return [];
    const items = raw.split(/[|｜,，]/).map(function (x) { return x.trim(); }).filter(Boolean)
      .map(function (t) { const m = /^(.*?)#\s*1\s*$/.exec(t); if (m) return { label: m[1].replace(/^[ \u3000]+|[ \u3000]+$/g, ''), simple: true }; return { label: t, simple: false }; });
    if (!items.length) return [];
    const startEl = textNode && textNode.parentElement ? textNode.parentElement : null;
    if (!startEl) return [];
    const labels = items.map(function (i) { return i.label; });
    // 确定搜索范围：向上到最近的「包含全部待抓标签文本」的祖先容器（避免整页全局扫描/抓错行）。
    // 注意：若假表格没有包裹所有行的公共容器（body 直接子元素），须允许把 body 作为回退范围。
    let scope = null, el = startEl;
    while (el) {
      const txt = (el.textContent || '');
      if (labels.every(function (l) { return txt.indexOf(l) !== -1; })) { scope = el; break; }
      if (el === document.body) break;
      el = el.parentElement;
    }
    if (!scope) return [];
    const list = Array.prototype.slice.call(scope.querySelectorAll('*'));
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let labelEl = null;
      for (let j = 0; j < list.length; j++) {
        const e = list[j];
        if ((e.textContent || '').trim() === item.label) { labelEl = e; break; }
      }
      if (!labelEl) continue;
      const val = this._fakeRightValue(labelEl);
      if (val) {
        out.push({ label: item.label, rows: [[{ t: val, rs: 1, cs: 1 }]] });
      }
    }
    return out;
  },

  /**
   * 取「标签元素」右侧内容（假表格）：优先同父右邻兄弟，再逐层向上找父级的右邻兄弟
   * （覆盖 标签与值 被包裹/分行但相邻的结构）。跳过按钮/链接等交互控件文本。
   */
  _fakeRightValue(labelEl) {
    let sib = labelEl.nextElementSibling;
    while (sib) {
      const v = this._cellText(sib, true);
      if (v) return v;
      sib = sib.nextElementSibling;
    }
    let p = labelEl.parentElement;
    for (let d = 0; p && d < 6; d++, p = p.parentElement) {
      const ps = p.nextElementSibling;
      if (ps) {
        const v = this._cellText(ps, true);
        if (v) return v;
      }
    }
    return '';
  },

  /**
   * 异步重抓（v1.10.6）：表格数据在初始高亮之后才填充（异步加载）时，初始抓到默认值/空值。
   * 遍历所有重要命中，对其配置了 fetchLabels 的 span 基于当前 DOM 重抓一次，
   * 仅当抓到内容且与现有不同时更新 data-kh-important-note，并触发面板刷新。
   * 未抓到内容时保留现有（不降级）。
   */
  refreshImportantFetches(keywords) {
    if (!keywords || !keywords.length) return 0;
    const kwById = {};
    keywords.forEach(function (k) { if (k && k.id) kwById[k.id] = k; });
    const spans = document.querySelectorAll('[data-kh-important="1"]');
    let changed = 0;
    for (const span of spans) {
      if (Utils.isElementHidden(span)) continue;
      const kid = span.getAttribute('data-kh-keyword-id');
      const kw = kid && kwById[kid];
      if (!kw || !(kw.fetchLabels && String(kw.fetchLabels).trim())) continue;
      const table = span.closest ? span.closest('table') : null;
      let fetched;
      if (table) {
        try { fetched = this._extractFetchedFromTable(table, kw); } catch (e) { continue; }
      } else {
        // v1.10.7 兜底：命中 span 不在真实 <table> 内（假表格/flex 伪表格）→ 直接抓命中单元格右邻当前值，保证假表格也能刷新
        const rightCell = this._findRightCell(span);
        const rightTxt = rightCell ? this._cellText(rightCell, true).trim() : '';
        if (rightTxt && /[\p{L}\p{N}]/u.test(rightTxt)) {
          fetched = [{ label: (span.textContent || '').trim(), rows: [[{ t: rightTxt, rs: 1, cs: 1 }]] }];
        }
      }
      if (!fetched || !fetched.length) continue; // 尚未填充 → 保留现有值，不降级
      const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
      const base = span.getAttribute('data-kh-important-base') || '';
      const note = base ? (base + '\n' + part) : part;
      const cur = span.getAttribute('data-kh-important-note') || '';
      if (note && note !== cur) {
        span.setAttribute('data-kh-important-note', note);
        changed++;
      }
    }
    // ② 普通词 CSS Highlight 命中：更新内存注册表里的重要笔记（含抓取值），供面板聚合
    for (const meta of this._plainHits) {
      const textNode = meta.textNode;
      if (!textNode || !meta.important) continue;
      const kw = meta.kwId && kwById[meta.kwId];
      if (!kw || !(kw.fetchLabels && String(kw.fetchLabels).trim())) continue;
      if (!textNode.parentNode || Utils.isElementHidden(textNode.parentNode)) continue;
      const table = textNode.parentNode && textNode.parentNode.closest ? textNode.parentNode.closest('table') : null;
      let fetched;
      if (table) {
        try { fetched = this._extractFetchedFromTable(table, kw); } catch (e) { continue; }
      } else {
        const rightCell = this._findRightCell(textNode.parentNode);
        const rightTxt = rightCell ? this._cellText(rightCell, true).trim() : '';
        if (rightTxt && /[\p{L}\p{N}]/u.test(rightTxt)) {
          fetched = [{ label: (textNode.nodeValue || '').slice(meta.start, meta.end), rows: [[{ t: rightTxt, rs: 1, cs: 1 }]] }];
        }
      }
      if (!fetched || !fetched.length) continue;
      const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
      const base = meta.importantBase || '';
      const note = base ? (base + '\n' + part) : part;
      if (note && note !== meta.importantNote) {
        meta.importantNote = note;
        changed++;
      }
    }
    if (changed && typeof this.onHighlight === 'function') {
      try { this.onHighlight(); } catch (e) { /* 忽略面板刷新异常 */ }
    }
    return changed;
  },

  /**
   * 判断节点是否属于可交互/控件元素（v1.7.9）：按钮/链接/表单控件/带 onclick 或交互 role/常见控件 class。
   * 命中则不应作为正文被抓取（如「编辑」「查看更多」「收起」等动态控件）。
   */
  _isInteractive(node) {
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'BR') return false;
    // v1.13.0: A(超链接) 不再无条件跳过——组合词核心命中内容若为纯文字链接(如 <td><a>南京公司</a></td>)，
    // 此前被当作交互控件跳过导致验证/高亮/重要笔记全部不生效。现改为：普通 <a> 文本参与匹配抓取，
    // 只有带显式交互特征的链接(onclick/role=button|link/控件 class/含"查看更多|收起|更多"等)仍视为控件跳过。
    const SKIP_TAGS = { BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1, OPTION:1, FORM:1, IFRAME:1, VIDEO:1, AUDIO:1, CANVAS:1, IMG:1, OBJECT:1, EMBED:1, HR:1 };
    if (SKIP_TAGS[tag]) return true;
    if (tag === 'A') {
      // 纯文字超链接放行；带交互特征(事件/显式交互 role/控件 class/点击展开类中文)仍跳过
      if (node.getAttribute('onclick') || node.getAttribute('onmousedown') || node.getAttribute('onpointerdown')) return true;
      const aRole = (node.getAttribute('role') || '').toLowerCase();
      if (aRole === 'button' || aRole === 'menuitem' || aRole === 'checkbox' || aRole === 'switch' || aRole === 'tab') return true;
      const aCls = node.className ? String(node.className) : '';
      if (/\b(btn|button|more|toggle|expand|collapse|operation|action)\b/i.test(aCls)) return true;
      if (/查看更多|收起|展开|更多|操作/.test(aCls)) return true;
      return false;
    }
    if (!node.getAttribute) return false;
    const role = (node.getAttribute('role') || '').toLowerCase();
    const INTERACTIVE_ROLES = ['button','link','menuitem','menu','checkbox','radio','switch','tab','combobox','slider','dialog','toolbar','navigation'];
    if (role && INTERACTIVE_ROLES.indexOf(role) >= 0) return true;
    if (node.getAttribute('onclick') || node.getAttribute('onmousedown') || node.getAttribute('onpointerdown') || node.getAttribute('onclick')) return true;
    if (node.getAttribute('contenteditable') != null) return true;
    const cls = node.className ? String(node.className) : '';
    // 常见控件/交互类（btn/button/link/more/toggle/expand/collapse/操作 等）
    if (/\b(btn|button|link|more|toggle|expand|collapse|operation|action)\b/i.test(cls)) return true;
    if (/查看更多|收起|展开|更多|操作/.test(cls)) return true;
    return false;
  },

  /**
   * 提取单元格文本（v1.7.9）
   * - 跳过按钮/链接/输入框等交互元素（如「编辑」「查看更多」「收起」控件，不应被抓取）；
   * - mergeLines=true（simple/简单模式）：把换行/连续空白压缩为单个空格，同一单元格内多子元素合并为一行
   *   （如「工具/张三/日期」→「工具 张三 日期」）；
   * - mergeLines=false（整块）：保留换行作多行分隔（审测一体等多行字段不受影响），仅剔除控件、压缩行内空白。
   */
  _cellText(el, mergeLines) {
    if (!el) return '';
    const BLOCK = { DIV: 1, P: 1, LI: 1, TR: 1, UL: 1, OL: 1, SECTION: 1, HEADER: 1, FOOTER: 1, BR: 1, TABLE: 1 };
    const segs = [];
    const walk = (node) => {
      if (node.nodeType === 3) { segs.push(node.textContent); return; }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'BR') { segs.push('\n'); return; }
      if (this._isInteractive(node)) return;
      const isBlock = !!BLOCK[tag] || /^H[1-6]$/.test(tag);
      if (isBlock && segs.length) segs.push('\n');
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    };
    walk(el);
    let s = segs.join('').replace(/\u00a0/g, ' ');
    if (mergeLines) {
      // 简单模式：合并为一行
      return s.replace(/[ \t\u3000\r\n]+/g, ' ').trim();
    }
    // 整块模式：保留换行作多行分隔，仅压缩行内连续空白、清掉空行与首尾空白
    return s
      .replace(/\u3000/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r?\n+/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/^[\n ]+/, '')
      .replace(/[\n ]+$/, '')
      .trim();
  },

  /**
   * 收集标签格右侧的合并块（v1.6.37）
   * 标签格可能是合并多行的单元格（rowspan），右侧为未合并的每行单元格。
   * 返回二维数组：每行一个数组（行内各格值，去空）。
   */
  _collectRightBlock(cell, table) {
    const rowIdx = cell.parentElement.rowIndex;
    const rowspan = cell.rowSpan || 1;
    const col = cell.cellIndex;
    const nRows = table.rows.length;
    // 抓取范围不限于 label 的 rowspan：右侧内容可能纵向延伸超过 rowspan（网页 label 常只合并部分行，超出即被截断）
    // 向下持续抓取，直到「超过 label 合并范围后 label 所在列出现新的单元格内容」（视为下一字段开始）或表格结束（v1.7.3）
    // 逻辑列占位：记录每列被上方 rowspan 合并占用的剩余行数（自计算，不依赖 columnIndex）
    const colUsage = {};
    const occupy = (c, span, rs) => { for (let k = 0; k < span; k++) { const key = c + k; colUsage[key] = Math.max(colUsage[key] || 0, rs); } };
    const step = (tds) => {
      let c = 0;
      const out = [];
      for (const t of tds) {
        while (colUsage[c]) c++;                       // 跳过被上方合并占用的列
        const cs = t.colSpan || 1, rs = t.rowSpan || 1;
        out.push({ td: t, col: c });
        occupy(c, cs, rs);
        c += cs;
      }
      Object.keys(colUsage).forEach(k => { colUsage[k]--; if (colUsage[k] <= 0) delete colUsage[k]; });
      return out;
    };
    // 前置：处理标签上方各行，建立列占用（兼容标签前有合并的表格）
    for (let r = 0; r < rowIdx && r < nRows; r++) step(table.rows[r].cells);
    const labelBottom = rowIdx + rowspan;
    const rows = [];
    for (let r = rowIdx; r < nRows; r++) {
      const cells = step(table.rows[r].cells);
      const line = [];
      let nextField = false;
      for (const c of cells) {
        if (r >= labelBottom && c.col === col) {
          const leftTxt = this._cellVisualText(c.td);
          if (leftTxt) nextField = true;
        }
        if (c.col > col) {
          const txt = this._cellVisualText(c.td);
          if (txt || (c.td.rowSpan || 1) > 1 || (c.td.colSpan || 1) > 1) {
            line.push({ t: txt, rs: c.td.rowSpan || 1, cs: c.td.colSpan || 1 });
          }
        }
      }
      if (nextField) break;
      if (line.length) rows.push(line);
    }
    return rows;
  },

  /**
   * 把带合并的结构化 rows 渲染成 Excel 表格（v1.6.39）
   * rows: [[{t,rs,cs},...], ...]，rs/colspan 由原表格单元格合并而来。
   */
  _rowsToTableHtml(rows, label) {
    return this._rowsToTableMulti([{ label, rows }]);
  },

  /**
   * 把多个「抓取后续字段」合并渲染成一个表格（v1.7.6）
   * multi: [{label, rows}]，label 为字段名（如 资质类型/应用功能类型），rows 为该字段抓到的内容格。
   * 多个字段合并为同一 <table> 的多行（多字段）展示，不再拆成多个独立小表。
   * 每个 label 作为左侧「字段列」中独立的一块（rowspan=该块行数），块内沿用 二级标题列+内容列 或 分组标题行。
   * 单 block 时行为与旧版完全一致。
   */
  _rowsToTableMulti(multi) {
    const esc = (s) => { const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; };
    // 只去掉行首尾的空格/全角空格，保留 tab（真实网页常见：标题后跟 tab 再接内容）
    const trimSp = (s) => String(s).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
    // 解析每块：展开为文本行；真实多列格记为 grid（保留 rowspan/colspan）
    const items = multi.map(m => {
      const textLines = [];
      let grid = false;
      for (const line of m.rows) {
        if (line.length === 1 && /[\r\n]/.test(line[0].t)) {
          const parts = String(line[0].t).split(/\r?\n/).map(trimSp).filter(Boolean);
          textLines.push.apply(textLines, parts);
        } else if (line.length === 1) {
          textLines.push(trimSp(line[0].t));
        } else {
          grid = true;
        }
      }
      return { label: m.label, textLines, grid, rows: m.rows };
    });
    // 解析（v1.6.44 + v1.7.4 两级分组）：标题行识别双通道——① 含 tab 的行=「标题+下方/同行内容」；
    // ② 无 tab 但匹配已知固定标题词（基本信息/测试信息/资质信息/运营备注）的行=标题行。
    const knownTitle = (s) => {
      const t = String(s).trim();
      for (const k of this.FETCH_GROUP_TITLES) {
        if (t === k) return k;
        if (t.indexOf(k) === 0 && /[ \u3000]/.test(t.charAt(k.length) || ' ')) return k;
      }
      return null;
    };
    const numRe = /^\s*\d+[、.．:：]\s*/;        // 编号内容行（如 "1、 xxx"）：不识别为分组标题
    const parseBlock = (textLines, label) => {
      // 解析为「一级分组(位包) + 二级标题」两级结构（v1.7.4）
      const blocks = [];   // [{ gtitle: string|null, subs: [{title, lines:[]}] }]
      let curBlock = null;
      let curSub = null;
      const ensureBlock = (g) => { const b = { gtitle: g, subs: [] }; blocks.push(b); return b; };
      for (let i = 0; i < textLines.length; i++) {
        const ln = textLines[i];
        const ti = ln.indexOf('\t');
        if (ti >= 0) {
          const title = ln.slice(0, ti).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
          const rest = ln.slice(ti + 1).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
          // 标题与左列标签同名：视为网页重复标题，仅保留其后内容
          if (label != null && title === String(label)) {
            if (!curBlock) curBlock = ensureBlock(null);
            if (rest) {
              if (!curSub) { curSub = { title: null, lines: [] }; curBlock.subs.push(curSub); }
              curSub.lines.push(rest);
            }
            continue;
          }
          curSub = { title: title, lines: rest ? [rest] : [] };
          if (!curBlock) curBlock = ensureBlock(null);
          curBlock.subs.push(curSub);
        } else {
          const isLabelLine = (label != null && ln === String(label));
          const kt = knownTitle(ln);
          if (isLabelLine) {
            continue;
          } else if (kt) {
            const rest = ln.slice(kt.length).replace(/^[ \u3000]+|[ \u3000]+$/g, '');
            curSub = { title: kt, lines: rest ? [rest] : [] };
            if (!curBlock) curBlock = ensureBlock(null);
            curBlock.subs.push(curSub);
          } else if (!numRe.test(ln) && i + 1 < textLines.length &&
                     (textLines[i + 1].indexOf('\t') >= 0 || knownTitle(textLines[i + 1]) !== null)) {
            // 一级分组标题行（如 "32位包:" / "64位包:"，其后紧跟 tab 标题或固定标题词）
            curBlock = ensureBlock(ln);
            curSub = null;
          } else {
            // 普通内容行：归入当前二级标题（无则建默认块）
            if (!curBlock) curBlock = ensureBlock(null);
            if (!curSub) { curSub = { title: null, lines: [] }; curBlock.subs.push(curSub); }
            curSub.lines.push(ln);
          }
        }
      }
      // 过滤有效块：仅保留子块内有内容的块
      return blocks.map(b => ({ gtitle: b.gtitle, subs: b.subs.filter(s => s.lines.length > 0) }))
                   .filter(b => b.subs.length > 0);
    };
    // 逐块渲染到同一个 <table>；各块列数不同时，由浏览器在行尾自动补空列对齐（v1.7.7）
    let html = '<table class="kh-table">';
    for (const it of items) {
      if (it.grid) {
        // 真实多列格：保留原 rowspan/colspan，与其它块合并到同一表格
        const total = it.rows.length;
        let firstInBlock = true;
        for (const line of it.rows) {
          let cells = '';
          for (const c of line) {
            let attrs = '';
            if (c.rs > 1) attrs += ' rowspan="' + c.rs + '"';
            if (c.cs > 1) attrs += ' colspan="' + c.cs + '"';
            cells += '<td' + attrs + '>' + esc(c.t) + '</td>';
          }
          html += '<tr>' + (firstInBlock && it.label != null ? '<td rowspan="' + total + '">' + esc(it.label) + '</td>' : '') + cells + '</tr>';
          firstInBlock = false;
        }
        continue;
      }
      if (!it.textLines.length) continue;
      const filled = parseBlock(it.textLines, it.label);
      if (!filled.length) continue;
      const blockTotal = filled.reduce((n, b) => n + (b.gtitle != null ? 1 : 0) + b.subs.reduce((m2, s) => m2 + s.lines.length, 0), 0);
      // 该块是否有二级标题列（每块独立，避免无标题的单值块多出空白列）
      const hasTitle = filled.some(b => b.subs.some(s => s.title != null && s.title !== ''));
      const titleColW = hasTitle ? 2 : 1;   // 一级分组标题行合并 标题列+内容列 的宽度
      let firstInBlock = true;
      for (const b of filled) {
        if (b.gtitle != null) {
          // 一级分组标题行：合并标题列+内容列为整行
          if (firstInBlock) {
            html += '<tr>' + (it.label != null ? '<td rowspan="' + blockTotal + '">' + esc(it.label) + '</td>' : '') +
                    '<td colspan="' + titleColW + '">' + esc(b.gtitle) + '</td></tr>';
            firstInBlock = false;
          } else {
            html += '<tr><td colspan="' + titleColW + '">' + esc(b.gtitle) + '</td></tr>';
          }
        }
        for (const s of b.subs) {
          const cap = s.title == null ? '' : s.title;
          const n = s.lines.length;
          for (let i = 0; i < n; i++) {
            if (firstInBlock) {
              html += '<tr>' + (it.label != null ? '<td rowspan="' + blockTotal + '">' + esc(it.label) + '</td>' : '') +
                      (hasTitle ? '<td rowspan="' + n + '">' + esc(cap) + '</td>' : '') +
                      '<td>' + esc(s.lines[i]) + '</td></tr>';
              firstInBlock = false;
            } else {
              html += '<tr>' + (i === 0 && hasTitle ? '<td rowspan="' + n + '">' + esc(cap) + '</td>' : '') + '<td>' + esc(s.lines[i]) + '</td></tr>';
            }
          }
        }
      }
    }
    html += '</table>';
    return '\u0002KH_TABLE_HTML\u0002' + html + '\u0002END\u0002';
  },

  _renderGrid(rows, label, esc) {
    const total = rows.length;
    let html = '<table class="kh-table">';
    for (let i = 0; i < total; i++) {
      const line = rows[i];
      html += '<tr>';
      if (label != null && i === 0) html += '<td rowspan="' + total + '">' + esc(label) + '</td>';
      for (const c of line) {
        let attrs = '';
        if (c.rs > 1) attrs += ' rowspan="' + c.rs + '"';
        if (c.cs > 1) attrs += ' colspan="' + c.cs + '"';
        html += '<td' + attrs + '>' + esc(c.t) + '</td>';
      }
      html += '</tr>';
    }
    html += '</table>';
    return '\u0002KH_TABLE_HTML\u0002' + html + '\u0002END\u0002';
  },

  /**
   * 查找命中文本所在 td/th 的右侧相邻有效单元格（跳过空兄弟）
   */
  _findRightCell(textNode) {
    const parentEl = textNode.parentElement;
    const cell = parentEl && parentEl.closest ? parentEl.closest('td,th') : null;
    if (cell && cell.parentElement) {
      let nx = cell.nextElementSibling;
      while (nx && /^TD|TH$/i.test(nx.tagName) && !(nx.textContent || '').trim()) {
        nx = nx.nextElementSibling;
      }
      if (nx && /^TD|TH$/i.test(nx.tagName)) return nx;
    }
    return null;
  },

  /**
   * 原网页期望值高亮（v1.7.9）：命中关键词且启用「单元格特别标注验证」时，
   * 只把其所在 td/th 右侧相邻单元格中【命中的期望值文本片段】用关键词生效背景色高亮（非整格）。
   * 匹配模式与 cellVerifyPass 一致：支持 正则(cellVerifyUseRegex) / 全等(exact) / 包含(include)，大小写遵循 cellVerifyCaseSensitive。
   * 幂等（同一格只处理一次），removeAllHighlights 时恢复。
   */
  _highlightCellVerify(cell, kw, style, job) {
    if (!cell) return;
    // v1.9.0：同一右格可能被多个组合关键词命中（如「应用名称|夸夸」「应用名称|网盘」命中同一格，
    // 或「刚需|是」所在右格又被其它词命中）。由原先「整格只处理一次(data-kh-cell-verify-hi)」
    // 改为「每个关键词每个格只处理一次」，否则只有第一个词生效、后续词的高亮/重要笔记丢失。
    if (!this._cellVerified) this._cellVerified = new WeakMap();
    let doneMap = this._cellVerified.get(cell);
    if (!doneMap) { doneMap = new Map(); this._cellVerified.set(cell, doneMap); }
    const kid = (kw && kw.id != null) ? String(kw.id) : '';
    // v1.13.3【缓存失效检测】命中文本节点已全部脱离文档（该格内容被整体改写/替换，如提交/翻页复用
    // cell 仅改 textContent）→ 视为缓存过期，删除缓存允许重新验证，避免「命中已失效却永久跳过」。
    if (kid && doneMap.has(kid)) {
      const rec = doneMap.get(kid);
      let alive = false;
      if (rec && rec.length) {
        for (let i = 0; i < rec.length; i++) { const t = rec[i]; if (t && t.parentNode) { alive = true; break; } }
      }
      if (alive) return;
      doneMap.delete(kid);
    }
    // v1.13.1【值后到根治】不立即 add(kid)：原来无论是否命中都先标「已处理」，导致右侧格初值空
    // （值后到/异步填充/刷新未就绪）时该格该词被永久跳过 → 组合词不命中。改为仅命中后才缓存。
    // v1.13.3：缓存值由 Set<kid> 改为 Map<kid, textNode[]>，记录该格该词命中到的文本节点，供失效检测。
    const markDone = (tnsArr) => {
      if (!kid) return;
      let rec = doneMap.get(kid);
      if (!rec) { rec = []; doneMap.set(kid, rec); }
      const arr = Array.isArray(tnsArr) ? tnsArr : [];
      for (let i = 0; i < arr.length; i++) { const t = arr[i]; if (t && rec.indexOf(t) === -1) rec.push(t); }
    };

    const color = (kw && kw.effectiveBgColor) || '';
    // 翻转(v1.8.3)：在右格高亮【核心】(kw.text)，即用户填在「关键词」位置的内容（右格核心）
    const need = (kw && kw.text) ? String(kw.text).trim() : '';
    if (!color || !need) return;
    // v1.13.0【4a】组合词面板标签展示实际命中的标题段（由 verifyJob.hitText 传入），不再用整格 cellVerify 配置串
    const hitText = (job && job.hitText) ? String(job.hitText).trim() : '';
    // 罕见字组合核心(v1.12.0)：不对 need 文本匹配，直接扫右格文本节点中的罕见字并高亮
    if (kw && kw.isRareCombo) {
      const tns = this._cellTextNodes(cell);
      for (let kk = 0; kk < tns.length; kk++) {
        const hits = (typeof RareChar !== 'undefined') ? RareChar.scanRare(tns[kk].nodeValue || '') : [];
        if (hits.length) {
          this._wrapVerifyText(tns[kk], hits.map(function (h) { return { start: h.index, end: h.index + h.length }; }), color, kw, style, { hitText: hitText });
          markDone([tns[kk]]);
        }
      }
      return;
    }
    const opt = {
      // v1.11.0【改指向】：核心词（右格）高亮匹配用基本区按钮字段(kw.*)，与 cellVerifyPass 保持一致
      rx: !!(kw.useRegex),
      cs: !!(kw.caseSensitive),
      exact: !!kw.wholeWord
    };
    // v1.10.16【CSS Highlight】：组合词不再 replaceChild 包裹 DOM 文本节点，
    // 同一文本节点可被多个组合词 Range 独立命中（互不嵌套），因此不再需要“跳过已嵌入 span 的文本节点”过滤。
    // 直接用单元格全部文本节点收集匹配并注册高亮。
    const tns = this._cellTextNodes(cell);
    // 全等(exact)：整个右侧格文本等于期望值 → 高亮整格全部文本
    if (opt.exact) {
      for (let k = 0; k < tns.length; k++) {
        const L = tns[k].nodeValue.length;
        if (L) {
          this._wrapVerifyText(tns[k], [{ start: 0, end: L }], color, kw, style, { hitText: hitText });
          markDone([tns[k]]);
        }
      }
      return;
    }
    // 正则 / 包含：在文本节点中收集匹配片段并高亮（先收集再处理，避免 replaceChild 破坏遍历）
    let anyLocal = false;
    for (let k = 0; k < tns.length; k++) {
      const matches = this._collectVerifyMatches(tns[k], need, opt);
      if (matches.length) { anyLocal = true; this._wrapVerifyText(tns[k], matches, color, kw, style, { hitText: hitText }); markDone([tns[k]]); }
    }
    // v1.11.0【跨节点修复】：右格被页面自带标红/包裹元素拆成多个文本节点时（如 "全民<span>免费</span>K唱歌" 被拆成三段），
    // 正则（如 全民.*K.*歌）在任一单个文本节点内都无法命中，但验证已是整格拼接、会通过，造成「验证过却没高亮」。
    // 单节点全部未命中时，跨节点拼接整格文本再匹配，并把命中区间映射回各文本节点高亮。
    // v1.11.1【聚合修复】跨节点会把同一组合词命中拆到多个文本节点：若各自都标重要并抓取，会拆成多条重要笔记/重复表格。
    // 改为只让「整格代表」承载重要笔记与抓取（aggText=右格完整文本），其余片段仅视觉高亮。
    if (!anyLocal) {
      const cross = this._collectVerifyAcrossCell(cell, need, opt);
      if (cross.length) {
        // 按文本节点聚合（同一节点可能含多个命中片段），一次 _wrapVerifyText 注入整格高亮
        const byNode = new Map();
        for (const c of cross) {
          if (!byNode.has(c.tn)) byNode.set(c.tn, []);
          byNode.get(c.tn).push({ start: c.start, end: c.end });
        }
        // v1.11.1 fix：优先用跨节点命中区间的完整文本（如正则只命中「全民免费K歌」，不把括号说明「 （32/64位应用）」带进来）
        const aggText = (cross.aggText && cross.aggText.trim()) || this._cellText(cell, false) || '';
        let first = true;
        byNode.forEach((mArr, tn) => {
          this._wrapVerifyText(tn, mArr, color, kw, style, first ? { aggText: aggText, hitText: hitText } : { noImportant: true, hitText: hitText });
          first = false;
          markDone([tn]);
        });
      }
    }
  },

  // v1.11.0【跨节点组合词匹配】：把整格全部文本节点（跳过交互控件）按 DOM 序拼接成完整串，
  // 在拼接串上做正则/包含匹配，再把全局区间映射回各文本节点的局部区间。
  // 返回 [{ tn, start, end }]。用于修复「页面自带标红/包裹元素把右格拆成多文本节点
  // → 单节点匹配不到、但验证（整格拼接文本）通过」导致的组合词正则/包含高亮丢失。
  _collectVerifyAcrossCell(cell, need, opt) {
    const out = [];
    const parts = []; // { tn, start } → start=该节点文本在拼接串中的起始偏移
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    let offset = 0, n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue || '';
      if (!t) continue;
      let skip = false, pp = n.parentElement;
      while (pp && pp !== cell) { if (this._isInteractive(pp)) { skip = true; break; } pp = pp.parentElement; }
      if (skip) continue;
      parts.push({ tn: n, start: offset });
      offset += t.length;
    }
    if (!parts.length) return out;
    const full = parts.map(p => p.tn.nodeValue).join('');
    // 在拼接串上匹配 → 全局 [globalStart, globalEnd) 区间
    const gl = [];
    if (opt.rx) {
      try {
        const re = new RegExp(need, (opt.cs ? 'g' : 'gi') + (/\\[pP]\{/.test(need) ? 'u' : ''));
        let m;
        while ((m = re.exec(full)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          gl.push([m.index, m.index + m[0].length]);
        }
      } catch (e) { /* 非法正则：不高亮 */ }
    } else {
      const a = opt.cs ? full : full.toLowerCase();
      const b = opt.cs ? need : need.toLowerCase();
      let i = a.indexOf(b);
      while (i !== -1) { gl.push([i, i + b.length]); i = a.indexOf(b, i + b.length); }
    }
    // 映射全局区间 → 各节点局部区间
    let aggText = '';
    for (const [gs, ge] of gl) {
      aggText += full.slice(gs, ge); // 命中区间的完整文本（用于重要笔记聚合展示，不含命中范围外内容）
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const pend = p.start + (p.tn.nodeValue || '').length;
        const a0 = Math.max(gs, p.start);
        const b0 = Math.min(ge, pend);
        if (a0 < b0) out.push({ tn: p.tn, start: a0 - p.start, end: b0 - p.start });
        if (pend >= ge) break;
      }
    }
    out.aggText = aggText || '';
    return out;
  },

  /**
   * 文字假表格（| 或 Tab 分隔）右侧核心高亮（v1.8.3 翻转）
   * 组合关键词命中「标题」后，若右侧无独立单元格（_findRightCell 为 null，即标题|核心 在同一格），
   * 则在本文本节点 | 分隔符之后，高亮【核心】(kw.text) 片段。
   */
  _highlightFakeCellVerify(tn, kw, style, job) {
    if (!tn) return;
    // v1.9.0：文字假表格(|/Tab 分隔)、同一节点被多个组合关键词命中时，前一个组合词的高亮
    // 会把该文本节点 replaceChild 摘除（tn.parentNode 变为 null）。再做会抛错中断整批高亮，
    // 连带后续 ImportantNote.refresh 不执行——防御性跳过，避免“偶发重要笔记不显示”。
    if (!tn.parentNode) return;
    const text = tn.nodeValue || '';
    const need = (kw && kw.text) ? String(kw.text).trim() : '';
    const color = (kw && kw.effectiveBgColor) || '';
    if (!need || !color) return;
    // v1.13.0【4a】面板标签展示实际命中的标题段
    const hitText = (job && job.hitText) ? String(job.hitText).trim() : '';
    // 定位 | 或 Tab 分隔（标题在前、分隔符之后为核心；分隔符可能在文本中部而非开头）
    const sepM = /[|\t]{1}/.exec(text);
    if (!sepM) return;
    const base = sepM.index + 1;
    const rest = text.slice(base);
    // 罕见字假表格核心(v1.12.0)：| 后内容含罕见字则高亮
    if (kw.isRareCombo) {
      const hits = (typeof RareChar !== 'undefined') ? RareChar.scanRare(rest) : [];
      if (hits.length) {
        this._wrapVerifyText(tn, hits.map(function (h) { return { start: base + h.index, end: base + h.index + h.length }; }), color, kw, style, { hitText: hitText });
      }
      return;
    }
    const opt = { rx: !!kw.useRegex, cs: !!kw.caseSensitive };
    if (kw.wholeWord) {
      const segRaw = rest.split(/[|\t]/)[0];
      const segTrim = segRaw.replace(/^[ \t]+/, '');
      if (segTrim.trim() === need) {
        const start = base + (segRaw.length - segTrim.length);
        this._wrapVerifyText(tn, [{ start: start, end: start + segTrim.trim().length }], color, kw, style, { hitText: hitText });
      }
      return;
    }
    const matches = this._collectVerifyMatches(tn, need, opt).filter(function (x) { return x.start >= base; });
    if (matches.length) this._wrapVerifyText(tn, matches, color, kw, style, { hitText: hitText });
  },

  // 收集单元格内的所有文本节点
  _cellTextNodes(cell) {
    const out = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  },

  // 在单个文本节点中收集「命中期望值」的片段 [{start,end}]（支持正则或包含）
  _collectVerifyMatches(tn, need, opt) {
    const text = tn.nodeValue || '';
    const matches = [];
    if (opt.rx) {
      try {
        const re = new RegExp(need, (opt.cs ? 'g' : 'gi') + (/\\[pP]\{/.test(need) ? 'u' : ''));
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          matches.push({ start: m.index, end: m.index + m[0].length });
        }
      } catch (e) { /* 非法正则：不高亮 */ }
      return matches;
    }
    const a = opt.cs ? text : text.toLowerCase();
    const b = opt.cs ? need : need.toLowerCase();
    let i = a.indexOf(b);
    while (i !== -1) {
      matches.push({ start: i, end: i + need.length });
      i = a.indexOf(b, i + need.length);
    }
    return matches;
  },

  // 把文本节点中指定片段用关键词色高亮（可被 removeAllHighlights 恢复）
  // v1.10.16【统一 CSS Highlight】：组合词右格核心从高亮 span 改为 CSS Highlight + 内存注册表，
  // 与普通词完全统一（纯底色+文字色，不产生 DOM span，文本节点不摘离）。
  // 数据（备注/重要笔记/相邻标注）均迁入 _plainHits 注册表，供坐标命中/重要笔记聚合/备注卡片用。
  _wrapVerifyText(tn, matches, color, kw, style, opts) {
    if (!tn || !tn.parentNode) return; // 防御：节点已脱离文档则不处理
    // 幂等：先清该文本节点上旧的组合词命中（值后到/改值重建时避免重复累积）
    this._clearComboHitsForTextNode(tn, (kw && kw.id != null) ? String(kw.id) : '');
    const o = opts || {};
    const st = style || {};
    const sColor = (kw && kw.effectiveTextColor) || st.defaultTextColor || '#000';
    // v1.13.3【组合词所属行】记录命中所属处理单元(行/表格)，供 hasResidualMarks 识别：即使内容被
    // 改写/文本节点脱离文档，只要该行曾命中组合词，内容变化时仍能触发整行先清后建、重验组合词。
    let rowRef = null;
    {
      let e0 = tn.parentElement;
      while (e0 && e0 !== document.body && !rowRef) {
        const g = (e0.tagName || '').toLowerCase();
        if (g === 'tr' || g === 'table') { rowRef = e0; break; }
        e0 = e0.parentElement;
      }
      if (!rowRef) rowRef = tn.parentElement;
    }
    for (let k = 0; k < matches.length; k++) {
      const m = matches[k];
      let range = null;
      try {
        range = document.createRange();
        range.setStart(tn, m.start);
        range.setEnd(tn, m.end);
      } catch (e) { range = null; }
      if (!range) continue;
      const meta = {
        range: range,
        textNode: tn,
        rowRef: rowRef,
        start: m.start,
        end: m.end,
        kwId: (kw && kw.id != null) ? String(kw.id) : '',
        bg: color,
        textColor: sColor,
        combo: true, // 标记组合词命中（区别于普通词）
        note: (kw && kw.note) || '', // 只有配置了备注的组合词才设热区
        important: false,
        importantNote: '',
        importantBase: '',
        imgSize: '',
        impNoteBg: '',
        adj: (o.hitText || (kw && kw.cellVerifyEnabled && kw.cellVerify)) ? (o.hitText || String(kw.cellVerify)) : '', // 相邻标注 = 实际命中标题段(v1.13.0 4a)
        aggText: o.aggText || (tn.nodeValue || '').slice(m.start, m.end) // v1.11.1 跨节点整格命中文本（聚合展示用）
      };
      // 重要标识数据（置顶悬浮笔记聚合用），与普通词一致（跨节点除整格代表外的片段 noImportant，仅视觉高亮）
      if (kw && kw.effectiveImportant && !o.noImportant) {
        meta.important = true;
        let note = kw.effectiveImportantNote || '';
        const fetched = this._extractFetched(tn, kw);
        if (fetched.length) {
          const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
          note = note ? note + '\n' + part : part;
        }
        meta.importantNote = note;
        meta.importantBase = kw.effectiveImportantNote || '';
        if (kw.effectiveImgSize) meta.imgSize = kw.effectiveImgSize;
        if (kw.effectiveImpNoteBg) meta.impNoteBg = kw.effectiveImpNoteBg; // v1.9.3 笔记底色(含分组兜底)
      }
      this._registerPlainHit(meta);
    }
    // v1.11.0【方案A·组合词优先】：组合词命中（尤其跨节点拼段）覆盖整段语义，若与同级文本节点上
    // 已注册的普通词命中区间重叠，则移除普通词的【视觉高亮】（叠色会花），但保留其 meta(_plainHits)，
    // 使其备注/重要笔记/坐标悬浮不丢失——视觉让位给组合词，交互仍可用。
    this._suppressOverlappedPlainVisual(tn);
  },

  // v1.11.0：让与组合词命中重叠的普通词命中“视觉让位”（从 CSS.highlights 移除），但保留 _plainHits 数据。
  _suppressOverlappedPlainVisual(tn) {
    if (!tn) return;
    // 收集该文本节点上组合词命中的区间 [start,end]
    const comboRange = [];
    for (const m of this._plainHits) {
      if (m.combo && m.textNode === tn && m.start < m.end) comboRange.push([m.start, m.end]);
    }
    if (!comboRange.length) return;
    for (const m of this._plainHits) {
      if (m.combo || m.textNode !== tn || !m._hlName) continue;
      const overlap = comboRange.some(([s, e]) => m.start < e && m.end > s);
      if (overlap) this._removePlainHitFromGroup(m);
    }
  },

  /**
   * 单元格特别标注验证（v1.6.18）
   * 关键词启用「单元格特别标注」且有期望值时：命中该关键词后，必须横向右侧相邻单元格内容
   * 【包含】期望值才保留此命中（不满足则该匹配不生成高亮，整条不生效）。
   * 支持：1) 真 HTML 表格：文本节点所属 td/th 的右侧相邻单元格；2) 文字假表格：命中后紧跟 | 或 Tab 分隔的内容。
   * 未启用验证的关键词恒返回 true（不改变原有行为）。
   */
  /**
   * 特殊「仅抓取」模式判定(v1.8.6)：标题格右侧单元格（或 |/Tab 后段）只要含至少一个中英数字，
   * 即视为「非空、非纯标点(`-`)」，才命中并抓取备注展示。返回 boolean。
   */
  _fetchNonEmptyPass(textNode, match, kw) {
    const cell = this._findRightCell(textNode);
    let right;
    if (cell) {
      right = this._cellText(cell, false) || ''; // 取正文（跳过「编辑」等按钮/交互控件文本）
    } else if (kw.fetchLabels && String(kw.fetchLabels).trim()) {
      // v1.13.4【假表格】无独立右格时，只要按 fetchLabels 能抓到右邻内容即视为通过（不再依赖 | 后段）
      try { return this._extractFetched(textNode, kw).length > 0; } catch (e) { return false; }
    } else {
      const t = textNode.textContent || '';
      const after = t.slice(match.index + match[0].length);
      const sep = after.match(/[|\t]/);
      right = sep ? after.slice(sep.index + 1) : '';
    }
    return /[\p{L}\p{N}]/u.test(right);
  },

  /**
   * 特殊「仅抓取」渲染(v1.8.6)：把标题文本包进一个【透明】标记 span（无背景/无色变，页面零高亮），
   * 仅用于 ImportantNote 收集；data-kh-important-note 存抓取 fetchLabels 右侧内容。
   */
  /**
   * 布局感知提取单元格正文（v1.8.9，仅「仅抓取」模式）：按【视觉行】合并，而非按块级元素切分行。
   * 网页常用 flex 把多个 div/span 排在同一行——此时各元素 getBoundingClientRect().top 接近(≤6px)，
   * 应合并为一行；只有真正换行(不同 top)才分行。跳过按钮/链接等交互控件文本。
   */
  _cellVisualText(cell) {
    if (!cell || typeof document === 'undefined' || !document.createRange) return this._cellText(cell, false);
    const rows = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      { // 跳过按钮/链接/输入框内文本：按钮可能被 <span> 等包裹，须沿父链向上查交互祖先(直到 cell)
        let skip = false, pp = n.parentElement;
        while (pp && pp !== cell) {
          if (this._isInteractive(pp)) { skip = true; break; }
          pp = pp.parentElement;
        }
        if (skip) continue;
      }
      const t = (n.nodeValue || '').replace(/[\u00a0\u3000]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!t) continue;
      let top = null;
      try {
        const r = document.createRange();
        r.selectNodeContents(n);
        top = Math.round(r.getBoundingClientRect().top);
      } catch (e) { top = rows.length * 100; }
      const last = rows[rows.length - 1];
      // 同行容差：中英文基线差异通常<=5px、真换行行距通常>=12px，取 8px 区分（避免把同行拆开、也不误并上下行）
      if (last && Math.abs(last.top - top) <= 8) {
        last.text = last.text ? last.text + ' ' + t : t;
      } else {
        rows.push({ top, text: t });
      }
    }
    return rows.map(r => r.text).filter(Boolean).join('\n');
  },

  _highlightFetchOnly(tn, kw, style) {
    const text = tn.nodeValue || '';
    if (!text.trim()) return;
    // 特殊「仅抓取」的内容 = 该标题行的右侧相邻单元格内容（真表格右邻 td / 假表格 | 后段）。
    // 直接取右格，避免按 fetchLabels 全局找标签而抓错行（如抓成首行空值"-"）。
    let note = '';
    // v1.13.0【3b】核心留空+标题+抓取字段时，按 fetchLabels 在表格中找对应标签的右邻值，
    // 而非直接取标题格右侧单元格（标题词与抓取字段不一致时按用户配置抓取，不再抓标题右侧）。
    try {
      const fetched = this._extractFetched(tn, kw);
      if (fetched && fetched.length) {
        note = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
      }
    } catch (e) { note = ''; }
    // 回退：假表格/非 HTML 表格（_extractFetched 找不到 table）→ 取标题同行 | 后段 / 右邻单元格
    if (!note) {
      const cell = this._findRightCell(tn);
      if (cell) {
        const rightText = this._cellVisualText(cell) || ''; // 按视觉行提取右侧正文（合并 flex 同行元素、跳过按钮），保留真实换行
        if (rightText.trim() && /[\p{L}\p{N}]/u.test(rightText)) {
          try {
            // 多行表格展示（复用抓取字段渲染器）：label=标题格文本，右格整块多行文本交由 _rowsToTableMulti
            // 解析（识别 tab 标题/重复标题剔除/多级分组），保留换行与全部内容（如"备注2 ... 的内容"不会被忽略）。
            note = this._rowsToTableMulti([{ label: text.trim(), rows: [[{ t: rightText }]] }]);
          } catch (e) { note = rightText; }
        }
      } else {
        const sep = text.match(/[|\t]/);
        note = sep ? text.slice(sep.index + 1) : '';
      }
    }
    if (!note) return;
    const span = document.createElement('span');
    span.className = 'kh-highlight';
    span.setAttribute('data-kh-keyword-id', String(kw.id || ''));
    span.setAttribute('data-kh-highlighted', 'true');
    span.setAttribute('data-kh-important', '1');
    if (note) span.setAttribute('data-kh-important-note', note);
    if (kw.effectiveImpNoteBg) span.setAttribute('data-kh-important-bg', kw.effectiveImpNoteBg); // v1.9.3 笔记底色(含分组兜底)
    span.setAttribute('data-kh-fetch-only', '1');
    span.textContent = text; // 原文进透明 span（视觉不变）
    if (tn.parentNode) tn.parentNode.replaceChild(span, tn);
    if (this.highlightedNodes) this.highlightedNodes.add(span);
  },

  cellVerifyPass(textNode, match, kw) {
    // 翻转(v1.8.3)：匹配的是【左格标题】(match 来自 titleRegex)，需验证右格/|后 含【核心】(kw.text=关键词)。
    const expect = kw.text;
    if (!kw.cellVerifyEnabled || !expect) return true; // 未启用验证

    const need = String(expect).trim();
    if (!need) return true;

    // 全词(exact)：右侧格整体与期望值相等；默认 include：右侧格包含期望值即可
    // v1.11.0【改指向】：核心词（右格）的匹配规则改用基本区按钮(kw.caseSensitive/wholeWord/useRegex)，
    // 与该关键词的普通匹配规则一致；组合词面板的 cellVerify* 仅用于标题词（左格）匹配。
    const exact = !!kw.wholeWord;   // 基本区「全词」= 右格整格与核心词相等

    // 核心词匹配开关（与普通关键词的开关同一套，彼此独立）
    const cs = !!kw.caseSensitive;   // true=区分大小写；false(默认)=不区分
    const rx = !!kw.useRegex;        // true=核心词按正则匹配
    // 罕见字核心(v1.12.0)：右格包含任意罕见字即通过验证（不比较具体文本）
    const matchRare = (value) => {
      const v = value || '';
      if (v === '' && !value) return false;
      return (typeof RareChar !== 'undefined') ? RareChar.scanRare(String(value || '')).length > 0 : false;
    };
    const matchVal = (value) => {
      const v = value || '';
      // 罕见字核心：右格含任意罕见字即通过
      if (kw.isRare) return matchRare(value);
      if (rx) {
        try {
          // 支持 Unicode 属性类(\p{L}/\P{P} 等，需 'u' flag，v1.8.5)：检测到 \p{ 或 \P{ 时加 'u'
          const flags = (cs ? '' : 'i') + (/\\[pP]\{/.test(need) ? 'u' : '');
          const re = exact ? new RegExp('^(?:' + need + ')$', flags) : new RegExp(need, flags);
          return re.test(v);
        } catch (e) { return false; }
      }
      const a = cs ? v : v.toLowerCase();
      const b = cs ? need : need.toLowerCase();
      return exact ? (a.trim() === b) : (a.indexOf(b) !== -1);
    };

    // 1) 真 HTML 表格：向上找 td/th，取同一行右侧相邻单元格（跳过空兄弟）
    const parentEl = textNode.parentElement;
    const cell = parentEl && parentEl.closest ? parentEl.closest('td,th') : null;
    if (cell && cell.parentElement) {
      let nx = cell.nextElementSibling;
      while (nx && /^TD|TH$/i.test(nx.tagName) && !(nx.textContent || '').trim()) {
        nx = nx.nextElementSibling;
      }
      if (nx && /^TD|TH$/i.test(nx.tagName)) {
        const v = this._cellText(nx, false) || ''; // 取右格正文（跳过"编辑"等按钮/交互控件文本，避免把纯按钮误判为有内容）
        return matchVal(v);
      }
      return false; // 属表格单元格但右侧无有效相邻格 → 验证不通过
    }

    // 2) 文字假表格：命中后紧跟 | 或 Tab 分隔
    // 注意：match 是 RegExpMatchArray（exec 结果），没有 .end，用 index + [0].length 计算命中结束位置
    let after = textNode.textContent.slice(match.index + match[0].length);
    // ⚠️ 若命中后自身无分隔符，右侧「|值」可能被拆到相邻兄弟文本节点
    //   （首次高亮把 A|B 拆成 span(A)+文本(|B)，removeAll 还原后 A 与 |B 分属两个文本节点；
    //    站点切换/刷新重新高亮时验证找不到右侧 → 需拼接相邻兄弟文本内容再判断）
    if (!/^[ \t]*[|\t]/.test(after)) {
      const nx = textNode.nextSibling;
      let nxText = '';
      if (nx) {
        if (nx.nodeType === 3) nxText = nx.textContent || '';
        else if (nx.textContent && /^[ \t]*[|\t]/.test(nx.textContent)) nxText = nx.textContent;
      }
      after += nxText;
    }
    const sep = after.match(/^[ \t]*[|\t][ \t]*/);
    if (sep) {
      const rest = after.slice(sep[0].length);
      if (exact) {
        // 全词：取分隔后第一段（到下一个 | 或 Tab 前）整体与期望值相等
        return matchVal(rest.split(/[|\t]/)[0]);
      }
      return matchVal(rest);
    }

    return false; // 未找到相邻格/分隔符 → 验证不通过
  },

  /**
   * 移除所有高亮
   */
  removeAllHighlights() {
    // 恢复原网页期望值文本高亮（v1.7.9）：把高亮 span 还原为纯文本
    this._cellVerifyHighlights.forEach(h => {
      if (h && h.isSpan && h.el && h.el.parentNode) {
        const tn = document.createTextNode(h.el.textContent);
        h.el.parentNode.replaceChild(tn, h.el);
      }
    });
    this._cellVerifyHighlights.clear();
    // 清除每格处理记录，允许下次重新高亮（v1.9.0 起为 per-(cell, keyword) 记录）
    if (this._cellVerified) this._cellVerified = new WeakMap();

    this.highlightedNodes.forEach(span => {
      if (span.parentNode) {
        const textNode = document.createTextNode(span.textContent);
        span.parentNode.replaceChild(textNode, span);
      }
    });
    this.highlightedNodes.clear();
    // v1.10.15【CSS Custom Highlight】一并清除普通词内存注册表与全部 CSS.highlights（组合词 span 已在上方还原）
    this._clearAllPlainHits();
  },

  /**
   * 局部清理（v1.10.7）：把 root 内本插件生成的高亮/期望值/仅抓取 span 还原为纯文本，
   * 并清除对应缓存记录。供「区域先清后建」使用——换页/复用改写时先清旧标记再全量重扫，
   * 避免上一页的高亮/抓取值残留到下一页同位置。
   */
  _removeHighlightsInRoot(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    // 还原本插件生成的高亮 span（普通高亮 / 组合词期望值 / 仅抓取透明 span）
    let spans;
    try { spans = root.querySelectorAll('[data-kh-highlighted],[data-kh-cell-verify-hi-span],[data-kh-fetch-only]'); }
    catch (e) { return; }
    const list = Array.prototype.slice.call(spans);
    for (const s of list) {
      if (s.parentNode) {
        const tn = document.createTextNode(s.textContent);
        s.parentNode.replaceChild(tn, s);
      }
      this.highlightedNodes.delete(s);
    }
    // 清组合词「每格处理记录」，允许该容器内单元格下次重新高亮
    // 【v1.10.12 根因修复】当重扫单元本身就是单元格(如 mutation.target=td/th，行内文本被改写时
    // 脏重建的 root 就是这个 td)时，querySelectorAll('td,th') 查不到 root 自身，导致该格
    // _cellVerified 缓存残留 → 之后组合词增量重扫被「该格该词已处理」跳过 → 高亮/重要笔记
    // 在值改写后永久消失。修复：补充清理 root 本身是 td/th 的情况。
    if (this._cellVerified) {
      let cells;
      try { cells = root.querySelectorAll('td, th'); } catch (e) { cells = []; }
      for (let i = 0; i < cells.length; i++) this._cellVerified.delete(cells[i]);
      const tag = (root.tagName || '').toLowerCase();
      if (tag === 'td' || tag === 'th') this._cellVerified.delete(root);
    }
    // 清组合词期望值还原记录中落在本容器内的项
    const toDrop = [];
    this._cellVerifyHighlights.forEach(function (h) {
      if (h && h.el && root.contains(h.el)) toDrop.push(h);
    });
    for (const h of toDrop) this._cellVerifyHighlights.delete(h);
    // v1.10.15【CSS Custom Highlight】清理本容器内的普通词内存命中（不摘离 DOM，只需注销注册表）
    this._removePlainHitsInRoot(root);
  },

  /**
   * 设置 MutationObserver 监听动态内容
   */
  // 增量高亮（v1.10.4）：只处理本次新增的 DOM 子树，不再全量重刷整篇 body。
  // 与原全量行为等价（均依赖 data-kh-highlighted 幂等跳过），仅把遍历范围缩小到新增节点，
  // 从而避免高频动态页面反复全量遍历导致的整页卡顿。组合词上下文由 _findRightCell 基于全局 DOM 结构解析，不受影响。
  incrementalHighlight(addedNodes, keywords, config) {
    const compiled = this._compileKeywords(keywords, config);
    if (!compiled.length) return 0;
    let totalHits = 0;
    for (const node of addedNodes) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (Utils.isSkippableElement(node)) continue;
      // 新增节点若内含旧高亮标记（页面复用/重排高亮区），_highlightInRoot 按幂等跳过，与原全量行为一致，不做破坏性重建
      totalHits += this._highlightInRoot(node, compiled, config);
    }
    if ((totalHits > 0 || addedNodes.length > 0) && typeof this.onHighlight === 'function') {
      try { this.onHighlight(); } catch (e) { /* 忽略面板刷新异常 */ }
    }
    return totalHits;
  },

  setupMutationObserver(keywords, config) {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }

    // v1.13.5【变动→整页重建】取代此前的「增量局部重建+容器级先清后建」复杂架构。
    // 历史问题：增量/容器重建会漏掉「组合词命中后内容局部更新、但核心格节点被复用不触发重建」
    //   这类边界（典型：多个界面命中内容相同，但抓取字段抓到的实际值不同——右格核心文本节点
    //   没变则引擎按「已处理」跳过，抓取字段不刷新甚至整块失效），导致某词一直不高亮/不进重要笔记。
    // 现改为：识别到页面任意内容变动 → 短暂静默(等页面稳定) → 对整篇文档做一次「先清后建」全量重建，
    //   与「切换标签页回来」同一构建路径，保证任何变动最终都被纠正为一致状态。
    // 三道防护：①静默窗口(pageRebuildSilentMs)避开高频动态页竞态；②节流(pageRebuildGapMs)限制重建
    //   频率防卡顿/闪烁；③插件自身 UI 容器(data-kh-ext-ui)变化不触发。总开关 pageRebuildOnChange。
    const silentMs = (config && config.pageRebuildSilentMs != null) ? config.pageRebuildSilentMs : 1000;
    const gapMs = (config && config.pageRebuildGapMs != null) ? config.pageRebuildGapMs : 2000;
    const enabled = !config || config.pageRebuildOnChange !== false;

    this._rebuilding = false;
    this._lastMutationAt = Date.now();
    this._lastRebuildAt = 0;

    const armRebuild = () => {
      if (!enabled || this._rebuilding) return;
      if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }
      const now = Date.now();
      const wait = Math.max(
        silentMs - (now - this._lastMutationAt),  // 静默窗口：距最后一次变动需 >= silentMs
        gapMs - (now - this._lastRebuildAt),      // 节流：距上次重建需 >= gapMs
        silentMs
      );
      this._rebuildTimer = setTimeout(rebuildAll, Math.max(wait, 0));
    };

    const rebuildAll = () => {
      this._rebuildTimer = null;
      if (!enabled || this._rebuilding) return;
      if (Date.now() - this._lastMutationAt < silentMs) { armRebuild(); return; } // 页面仍在变化，等稳定
      this._rebuilding = true;
      try {
        this._removeHighlightsInRoot(document.body);
        const compiled = this._compileKeywords(keywords, config);
        if (compiled.length) this._highlightInRoot(document.body, compiled, config);
        this._lastRebuildAt = Date.now();
        try { this.refreshImportantFetches(keywords); } catch (e) { /* 忽略重抓异常 */ }
        if (typeof this.onHighlight === 'function') { try { this.onHighlight(); } catch (e) { /* 忽略 */ } }
      } catch (e) {
        console.error('[KeywordHighlighter] 整页重建失败:', e);
      } finally {
        // 重建自身产生的 DOM 变化（标记/span）在 _rebuilding 期间被 observer 忽略；
        // 稍后解除锁定，避免立即又触发一轮自激重建。
        setTimeout(() => { this._rebuilding = false; }, 200);
      }
    };

    const isSelfUI = (m) => {
      if (!m || !m.target || m.target.nodeType !== Node.ELEMENT_NODE) return false;
      const el = m.target;
      return !!(el.getAttribute && el.getAttribute('data-kh-ext-ui') === '1');
    };

    this.observer = new MutationObserver((mutations) => {
      if (!enabled || this._rebuilding) return;
      let relevant = false;
      for (const m of mutations) {
        if (isSelfUI(m)) continue; // 插件自身 UI 容器变化不触发重建
        relevant = true;
        break;
      }
      if (!relevant) return;
      this._lastMutationAt = Date.now();
      armRebuild();
    });

    // 首扫由调用方 highlightKeywords 完成；本观察器只负责后续页面变动的兜底重建。
    this.observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  },


  /**
   * 设置 Shadow DOM 观察器
   */
  setupShadowDOMObserver(keywords, config) {
    if (this.shadowObserver) {
      this.shadowObserver.disconnect();
    }

    const processShadowRoots = (root) => {
      // 查找所有元素
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot) {
          try {
            this._highlightInRoot(el.shadowRoot, keywords, config);
            // 递归处理嵌套 Shadow DOM
            processShadowRoots(el.shadowRoot);
          } catch (e) {
            // 某些 Shadow DOM 可能无法访问
          }
        }
      }
    };

    // 处理当前 DOM
    processShadowRoots(document.body);

    // 监听新的 Shadow DOM
    this.shadowObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            processShadowRoots(node);
          }
        }
      }
    });

    this.shadowObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  },

  /**
   * (v1.10.15) CSS Highlight 样式分组管理：确保 styleKey(bg|tx) 对应的 ::highlight 规则已注入，返回 highlight 名。
   */
  _ensureHlStyle(bg, tx) {
    const key = (bg || '#ffff00') + '\u0001' + (tx || '#000');
    let g = this._hlGroups.get(key);
    if (g) return g;
    const name = 'kh-hl-' + (this._hlIdx++);
    if (!this._hlStyleEl) {
      this._hlStyleEl = document.createElement('style');
      this._hlStyleEl.setAttribute('data-kh-hl-style', '1');
      (document.head || document.documentElement).appendChild(this._hlStyleEl);
    }
    try {
      this._hlStyleEl.textContent += '::highlight(' + name + '){ background-color:' + bg + '; color:' + tx + '; }\n';
    } catch (e) { /* 规则注入失败不影响功能，高亮样式退化为默认 */ }
    g = { name: name, ranges: [] };
    this._hlGroups.set(key, g);
    return g;
  },

  /**
   * (v1.10.15) CSS Highlight：将普通关键词命中登记进内存注册表 + 分组高亮。
   * meta = { range, textNode, start, end, kwId, note, important, importantNote, importantBase, imgSize, bg, adj }
   */
  _registerPlainHit(meta) {
    if (!meta || !meta.range) return;
    this._plainHits.push(meta);
    // 按样式分组加入 CSS.highlights（多次命中同词同色共用一组）
    try {
      const bg = meta.bg || '#ffff00';
      const tx = meta.textColor || '#000';
      const g = this._ensureHlStyle(bg, tx);
      g.ranges.push(meta.range);
      let hl = null;
      if (typeof CSS.highlights !== 'undefined') hl = CSS.highlights.get(g.name);
      if (!hl && typeof Highlight !== 'undefined') {
        hl = new Highlight(meta.range);
        CSS.highlights.set(g.name, hl);
      } else if (hl) {
        try { hl.add(meta.range); } catch (e) {/* 已存在则忽略 */}
      }
      meta._hlName = g.name;
    } catch (e) { /* CSS Highlight 不可用时静默降级（不抛错中断高亮主流程） */ }
  },

  /**
   * (v1.10.15) 移除某文本节点上登记的普通词命中（CSS Highlight 增量重扫时先清后建）。
   * 返回被移除条数。
   */
  _clearPlainHitsForTextNode(tn) {
    const idxs = [];
    for (let i = 0; i < this._plainHits.length; i++) {
      if (this._plainHits[i].textNode === tn && !this._plainHits[i].combo) idxs.push(i);
    }
    for (let i = idxs.length - 1; i >= 0; i--) {
      const meta = this._plainHits.splice(idxs[i], 1)[0];
      this._removePlainHitFromGroup(meta);
    }
    return idxs.length;
  },

  /**
   * (v1.10.16) 移除某文本节点上登记的【组合词】命中（组合词右格核心高亮，与普通词互不影响）。
   * 组合词 `_wrapVerifyText` 重建时先清旧命中再重注册，避免同一文本节点命中累积重复。
   */
  // v1.13.1【多组合词同格】清该文本节点上【当前关键词(kwId)】的组合词命中（幂等，值后到/改值重建去重）。
  // 注意：不能清该节点上【其它关键词】的命中——多个组合词命中同一文本节点（如右格「a b」同时命中
  // 组合词a 与 组合词b）时，若全清会导致后处理的词清掉先处理的词的注册，只保留最后一个命中。
  _clearComboHitsForTextNode(tn, kwId) {
    const idxs = [];
    for (let i = 0; i < this._plainHits.length; i++) {
      const meta = this._plainHits[i];
      if (meta.textNode !== tn || !meta.combo) continue;
      if (kwId && meta.kwId !== kwId) continue; // 只清当前关键词，保留其它词的同格命中
      idxs.push(i);
    }
    for (let i = idxs.length - 1; i >= 0; i--) {
      const meta = this._plainHits.splice(idxs[i], 1)[0];
      this._removePlainHitFromGroup(meta);
    }
    return idxs.length;
  },

  /**
   * (v1.10.15) 把指定的普通词命中从它所属的分组/Highlight 中移除。
   */
  _removePlainHitFromGroup(meta) {
    if (!meta || !meta._hlName) return;
    try {
      if (typeof CSS.highlights !== 'undefined') {
        const hl = CSS.highlights.get(meta._hlName);
        if (hl) { try { hl.delete(meta.range); } catch (e) {} }
      }
    } catch (e) {}
    // 从分组 ranges 移除（供重建时统计；group 对象惰性重建，不强制清理）
  },

  /**
   * (v1.10.15) 清空普通词注册表与全部 CSS Highlight（对应 removeAllHighlights 中普通词部分）。
   */
  _clearAllPlainHits() {
    if (typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined') {
      try {
        CSS.highlights.forEach((hl, name) => {
          if (String(name).indexOf('kh-hl-') === 0) CSS.highlights.delete(name);
        });
      } catch (e) {}
    }
    this._plainHits = [];
    this._hlGroups = new Map();
    if (this._hlStyleEl && this._hlStyleEl.parentNode) {
      try { this._hlStyleEl.parentNode.removeChild(this._hlStyleEl); } catch (e) {}
    }
    this._hlStyleEl = null;
    this._hlIdx = 0;
  },

  /**
   * (v1.10.15) 清理落在某容器/文本节点内的普通词命中（供 _removeHighlightsInRoot 局部清理）。
   * (v1.10.16) 同时清除已脱离文档的命中（整表替换时旧行 textNode 被移除，其 parentNode 链断裂
   * 无法被 inside 判断命中，但旧命中已无意义，须强制清除避免残留累积）。
   */
  _removePlainHitsInRoot(root) {
    if (!root) return;
    const keep = [];
    for (let i = 0; i < this._plainHits.length; i++) {
      const meta = this._plainHits[i];
      const tn = meta.textNode;
      const inDoc = document.contains(tn) || (tn && tn.parentNode && root.contains(tn));
      // 已脱离文档的命中（整行/整表被替换后 textNode 不在 DOM）→ 强制清除
      if (!inDoc) {
        this._removePlainHitFromGroup(meta);
        continue;
      }
      const inside = (function () {
        let e = tn;
        while (e && e !== root && e !== document.body) e = e.parentNode;
        return e === root;
      })();
      if (inside) {
        this._removePlainHitFromGroup(meta);
      } else {
        keep.push(meta);
      }
    }
    this._plainHits = keep;
  },

  /**
   * (v1.10.15) 坐标命中检测：返回点击/移入坐标落在哪个普通词命中上（供备注卡片点击/tooltip）。
   */
  queryPlainHitAt(x, y) {
    let caret = null;
    try { caret = document.caretRangeFromPoint(x, y); } catch (e) {}
    if (!caret) {
      // fallback：某些环境无 caretRangeFromPoint
      return null;
    }
    const cNode = caret.startContainer;
    const cOff = caret.startOffset;
    let best = null;
    for (const m of this._plainHits) {
      if (m.textNode !== cNode) continue;
      if (!document.contains(m.textNode)) continue;
      if (!m.note) continue; // 无备注的命中不参与点击/悬浮
      if (cOff >= m.start && cOff <= m.end) {
        if (!best) best = m;
      }
    }
    return best || null;
  },

  /**
   * 销毁引擎
   */
  destroy() {
    // 取消正在排队的延迟高亮，防止切换后旧定时器复活把禁用页重新高亮
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = null;
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._postRebuildTimer) {
      clearTimeout(this._postRebuildTimer);
      this._postRebuildTimer = null;
    }
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    if (this._refetchTimer) {
      clearTimeout(this._refetchTimer);
      this._refetchTimer = null;
    }
    this.removeAllHighlights();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.shadowObserver) {
      this.shadowObserver.disconnect();
      this.shadowObserver = null;
    }
  }
};

if (typeof window !== 'undefined') {
  window.KeywordEngine = KeywordEngine;
}
