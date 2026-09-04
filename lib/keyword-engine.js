/**
 * 关键词高亮引擎
 * 负责在 DOM 中查找和高亮关键词
 */
const KeywordEngine = {
  // 抓取后续字段：多行文本按这些固定标题分组（v1.6.42，后续可改）
  FETCH_GROUP_TITLES: ['基本信息', '测试信息', '资质信息', '运营备注'],
  highlightedNodes: new Set(),
  _cellVerifyHighlights: new Set(),  // 原网页期望值高亮（右侧单元格），removeAll 时恢复（v1.7.9）
  observer: null,
  shadowObserver: null,
  processingQueue: [],
  processingTimer: null,
  // 跟踪延迟高亮定时器，destroy 时可取消，避免切换站点后旧定时器复活
  _highlightTimer: null,

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
  async highlightKeywords(keywords, config) {
    const startTime = performance.now();
    let totalHits = 0;

    // 构建分组颜色映射（分组颜色优先于关键词自身颜色）
    const groups = config.groups || [];
    const groupMap = {};
    groups.forEach(g => { if (g) groupMap[g.id] = g; });

    // 预编译正则表达式，并计算每个关键词的生效颜色
    const compiledKeywords = keywords.map(kw => {
      const rawText = String(kw.text || '').trim();
      // 组合关键词：cellVerify=左格标题、text=右格核心
      const isCombo = !!(kw.cellVerifyEnabled && kw.cellVerify && String(kw.cellVerify).trim());
      // 特殊「仅抓取」模式(v1.8.6)：关键词留空 + 标题关键词 + 抓取字段 →
      // 当标题格右侧单元格含中英数字(非'-'/非空)时，抓 fetchLabels 右侧内容进重要笔记；页面仅透明标记收集、不高亮。
      const specialFetch = isCombo && !rawText && !!(kw.fetchLabels && String(kw.fetchLabels).trim());
      const re = isCombo ? null : Utils.buildMatchRegex(kw); // 组合词主正则不用（核心匹配走 cellVerify 逻辑）
      if (!isCombo && !re) return null;
      const titleRegex = isCombo ? Utils.buildMatchRegex({
        text: kw.cellVerify,
        useRegex: kw.cellVerifyUseRegex,
        caseSensitive: kw.cellVerifyCaseSensitive,
        wholeWord: false
      }) : null;
      if (isCombo && !titleRegex) return null;
      const group = kw.groupId ? groupMap[kw.groupId] : null;
      return {
        ...kw,
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
                                (group && group.important && group.importantNote && String(group.importantNote).trim()) || ''
      };
    }).filter(k => k !== null);

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
      if (job.cell) this._highlightCellVerify(job.cell, job.kw, job.style);
      else if (job.tn && !job.fetchOnly) this._highlightFakeCellVerify(job.tn, job.kw, job.style);
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
            if (cell) verifyJobs.push({ cell: cell, kw: kw, style: config.highlightStyle });
            else verifyJobs.push({ tn: textNode, kw: kw, style: config.highlightStyle }); // 文字假表格：|后核心在同行，单独高亮
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
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    for (const m of filtered) {
      // 添加前面的文本
      if (m.start > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.start)));
      }

      // 创建高亮 span
      const span = document.createElement('span');
      span.className = 'kh-highlight';
      span.setAttribute('data-kh-keyword-id', m.keyword.id);
      span.setAttribute('data-kh-highlighted', 'true');
      
      // 自定义样式（使用分组优先的生效颜色）
      const bgColor = m.keyword.effectiveBgColor || config.highlightStyle.defaultBgColor;
      const textColor = m.keyword.effectiveTextColor || config.highlightStyle.defaultTextColor;
      const borderColor = config.highlightStyle.defaultBorderColor;
      const borderWidth = config.highlightStyle.defaultBorderWidth;
      const borderRadius = config.highlightStyle.defaultBorderRadius;
      
      span.style.backgroundColor = bgColor;
      span.style.color = textColor;
      span.style.borderBottom = `${borderWidth} solid ${borderColor}`;
      span.style.borderRadius = borderRadius;
      span.style.cursor = 'pointer';
      span.textContent = m.text;

      // 存储备注信息（组合关键词：左右单元格组合，悬浮/卡片交互移到右侧【期望值】单元格，左词不再挂备注）
      const isCellCombo = !!(m.keyword.cellVerifyEnabled && m.keyword.cellVerify);
      if (m.keyword.note && !isCellCombo) {
        span.setAttribute('data-kh-note', m.keyword.note);
        span.title = m.keyword.note;
      }

      // 标记重要标识（用于置顶悬浮笔记聚合）
      if (m.keyword.effectiveImportant) {
        span.setAttribute('data-kh-important', '1');
        // 重要展示文本：预设笔记 + 抓取后续字段（读取指定标签右侧单元格内容）
        let note = m.keyword.effectiveImportantNote || '';
        const fetched = this._extractFetched(textNode, m.keyword);
        if (fetched.length) {
          // 抓取后续字段统一以表格形式展示；多个字段合并为同一表格多块展示（v1.7.6）
          const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
          note = note ? note + '\n' + part : part;
        }
        if (note) span.setAttribute('data-kh-important-note', note);
        if (m.keyword.imgSize) span.setAttribute('data-kh-important-img-size', m.keyword.imgSize);
      }

      // 单元格特别标注：验证通过后记录期望值，供重要笔记展示相邻标注
      if (m.keyword.cellVerifyEnabled && m.keyword.cellVerify) {
        span.setAttribute('data-kh-cell-verify', m.keyword.cellVerify);
        // v1.8.1：期望值高亮不再在此处直接修改右格 DOM（会 replaceChild 拆分右格、丢掉 _highlightInRoot 已缓存的原始文本节点，
        // 导致普通关键词命中右格时 parentNode 为 null 抛错中断整体高亮）。改为收集右格 cell，全部文本节点处理完后统一高亮。
        if (verifyJobs && Array.isArray(verifyJobs)) {
          const cell = this._findRightCell(textNode);
          verifyJobs.push({ cell: cell, kw: m.keyword, style: config.highlightStyle });
        }
      }
      
      fragment.appendChild(span);
      this.highlightedNodes.add(span);
      lastIndex = m.end;
    }

    // 添加剩余文本
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode.replaceChild(fragment, textNode);
    return filtered.length;
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
    // 支持「简单模式」标记：字段末尾加 #1 → 只取右侧相邻一个单元格的值（如 资质类型#1），
    // 而非像审测一体审核结果描述那样抓整块做完整表格（v1.7.8）。
    const items = raw.split(/[|｜,，]/).map(function (x) { return x.trim(); }).filter(Boolean)
      .map(function (t) {
        const m = /^(.*?)#\s*1\s*$/.exec(t);
        if (m) return { label: m[1].replace(/^[ \u3000]+|[ \u3000]+$/g, ''), simple: true };
        return { label: t, simple: false };
      });
    if (items.length === 0) return [];

    let el = textNode.parentNode;
    while (el && el.nodeType === 1 && el.tagName !== 'TABLE') el = el.parentNode;
    if (!el || el.tagName !== 'TABLE') return []; // 暂支持 HTML 表格；假表格后续迭代

    const table = el;
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
   * 判断节点是否属于可交互/控件元素（v1.7.9）：按钮/链接/表单控件/带 onclick 或交互 role/常见控件 class。
   * 命中则不应作为正文被抓取（如「编辑」「查看更多」「收起」等动态控件）。
   */
  _isInteractive(node) {
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'BR') return false;
    const SKIP_TAGS = { BUTTON:1, A:1, INPUT:1, SELECT:1, TEXTAREA:1, OPTION:1, FORM:1, IFRAME:1, VIDEO:1, AUDIO:1, CANVAS:1, IMG:1, OBJECT:1, EMBED:1, HR:1 };
    if (SKIP_TAGS[tag]) return true;
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
          const leftTxt = this._cellText(c.td, false);
          if (leftTxt) nextField = true;
        }
        if (c.col > col) {
          const txt = this._cellText(c.td, false);
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
  _highlightCellVerify(cell, kw, style) {
    if (!cell) return;
    if (cell.getAttribute('data-kh-cell-verify-hi')) return; // 本格已处理
    cell.setAttribute('data-kh-cell-verify-hi', '1');
    const color = (kw && kw.effectiveBgColor) || '';
    // 翻转(v1.8.3)：在右格高亮【核心】(kw.text)，即用户填在「关键词」位置的内容（右格核心）
    const need = (kw && kw.text) ? String(kw.text).trim() : '';
    if (!color || !need) return;
    const opt = {
      rx: !!(kw.cellVerifyUseRegex),
      cs: !!(kw.cellVerifyCaseSensitive),
      exact: (kw.cellVerifyMatchMode === 'exact')
    };
    // 全等(exact)：整个右侧格文本等于期望值 → 高亮整格全部文本
    if (opt.exact) {
      const tns = this._cellTextNodes(cell);
      for (let k = 0; k < tns.length; k++) {
        const L = tns[k].nodeValue.length;
        if (L) this._wrapVerifyText(tns[k], [{ start: 0, end: L }], color, kw, style);
      }
      return;
    }
    // 正则 / 包含：在文本节点中收集匹配片段并高亮（先收集再处理，避免 replaceChild 破坏遍历）
    const tns = this._cellTextNodes(cell);
    for (let k = 0; k < tns.length; k++) {
      const matches = this._collectVerifyMatches(tns[k], need, opt);
      if (matches.length) this._wrapVerifyText(tns[k], matches, color, kw, style);
    }
  },

  /**
   * 文字假表格（| 或 Tab 分隔）右侧核心高亮（v1.8.3 翻转）
   * 组合关键词命中「标题」后，若右侧无独立单元格（_findRightCell 为 null，即标题|核心 在同一格），
   * 则在本文本节点 | 分隔符之后，高亮【核心】(kw.text) 片段。
   */
  _highlightFakeCellVerify(tn, kw, style) {
    if (!tn) return;
    const text = tn.nodeValue || '';
    const need = (kw && kw.text) ? String(kw.text).trim() : '';
    const color = (kw && kw.effectiveBgColor) || '';
    if (!need || !color) return;
    // 定位 | 或 Tab 分隔（标题在前、分隔符之后为核心；分隔符可能在文本中部而非开头）
    const sepM = /[|\t]{1}/.exec(text);
    if (!sepM) return;
    const base = sepM.index + 1;
    const rest = text.slice(base);
    const opt = { rx: !!kw.cellVerifyUseRegex, cs: !!kw.cellVerifyCaseSensitive };
    if (kw.cellVerifyMatchMode === 'exact') {
      const segRaw = rest.split(/[|\t]/)[0];
      const segTrim = segRaw.replace(/^[ \t]+/, '');
      if (segTrim.trim() === need) {
        const start = base + (segRaw.length - segTrim.length);
        this._wrapVerifyText(tn, [{ start: start, end: start + segTrim.trim().length }], color, kw, style);
      }
      return;
    }
    const matches = this._collectVerifyMatches(tn, need, opt).filter(function (x) { return x.start >= base; });
    if (matches.length) this._wrapVerifyText(tn, matches, color, kw, style);
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

  // 把文本节点中指定片段用关键词色 span 高亮（可被 removeAllHighlights 恢复）
  // v1.7.10：组合关键词时，期望值 span 同时作为悬浮/点击热区，挂上备注数据（data-kh-note/title），
  // 使鼠标放期望值出悬浮备注、点期望值出备注卡片；无普通备注(kw.note)的组合词不设热区（保持纯高亮）。
  _wrapVerifyText(tn, matches, color, kw, style) {
    const text = tn.nodeValue;
    const frag = document.createDocumentFragment();
    let idx = 0;
    // 统一视觉：期望值片段采用与左侧关键词相同的高亮样式（生效背景/文字色/下边框/圆角/手型，v1.7.10）
    const st = style || {};
    const sColor = (kw && kw.effectiveTextColor) || st.defaultTextColor || '#000';
    const sBorder = st.defaultBorderColor || 'transparent';
    const sBorderWid = st.defaultBorderWidth != null ? st.defaultBorderWidth : '1px';
    const sRadius = st.defaultBorderRadius != null ? st.defaultBorderRadius : '2px';
    for (let k = 0; k < matches.length; k++) {
      const m = matches[k];
      if (m.start > idx) frag.appendChild(document.createTextNode(text.slice(idx, m.start)));
      const span = document.createElement('span');
      span.style.backgroundColor = color;
      span.style.color = sColor;
      span.style.borderBottom = String(sBorderWid) + ' solid ' + sBorder;
      span.style.borderRadius = sRadius;
      span.setAttribute('data-kh-cell-verify-hi-span', '1');
      if (kw) {
        // 与左词共用同一套高亮样式（kh-highlight：hover 动效/过渡/内边距/手型），v1.7.11
        span.className = 'kh-highlight';
      }
      if (kw) {
        // 翻转(v1.8.3)：右侧核心 span 即「关键词」，统一承载交互/备注/重要笔记/相邻标注（左格标题），与普通关键词一致
        if (kw.cellVerifyEnabled && kw.cellVerify) {
          span.setAttribute('data-kh-cell-verify', kw.cellVerify); // 相邻标注 = 左格标题
        }
        if (kw.effectiveImportant && !span.hasAttribute('data-kh-important')) {
          span.setAttribute('data-kh-important', '1');
          let note = kw.effectiveImportantNote || '';
          const fetched = this._extractFetched(tn, kw);
          if (fetched.length) {
            const part = this._rowsToTableMulti(fetched.map(function (f) { return { label: f.label, rows: f.rows }; }));
            note = note ? note + '\n' + part : part;
          }
          if (note) span.setAttribute('data-kh-important-note', note);
          if (kw.imgSize) span.setAttribute('data-kh-important-img-size', kw.imgSize);
        }
      }
      if (kw && kw.note) {
        span.setAttribute('data-kh-highlighted', 'true');
        if (kw.id) span.setAttribute('data-kh-keyword-id', kw.id);
        span.setAttribute('data-kh-note', kw.note);
        span.title = kw.note;
      }
      span.textContent = text.slice(m.start, m.end);
      frag.appendChild(span);
      this._cellVerifyHighlights.add({ el: span, isSpan: true });
      idx = m.end;
    }
    if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
    tn.parentNode.replaceChild(frag, tn);
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
  _highlightFetchOnly(tn, kw, style) {
    const text = tn.nodeValue || '';
    if (!text.trim()) return;
    // 特殊「仅抓取」的内容 = 该标题行的右侧相邻单元格内容（真表格右邻 td / 假表格 | 后段）。
    // 直接取右格，避免按 fetchLabels 全局找标签而抓错行（如抓成首行空值"-"）。
    let note = '';
    const cell = this._findRightCell(tn);
    if (cell) {
      const rightText = this._cellText(cell, false) || ''; // 取右侧正文（跳过「编辑」等按钮/交互控件文本），保留换行
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
    const span = document.createElement('span');
    span.className = 'kh-highlight';
    span.setAttribute('data-kh-keyword-id', String(kw.id || ''));
    span.setAttribute('data-kh-highlighted', 'true');
    span.setAttribute('data-kh-important', '1');
    if (note) span.setAttribute('data-kh-important-note', note);
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
    const exact = kw.cellVerifyMatchMode === 'exact';

    // 独立开关：后格区分大小写 / 后格用正则（与普通关键词的开关彼此独立）
    const cs = !!kw.cellVerifyCaseSensitive;   // true=区分大小写；false(默认)=不区分
    const rx = !!kw.cellVerifyUseRegex;        // true=期望值按正则匹配
    const matchVal = (value) => {
      const v = value || '';
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
    // 清除整格处理标记，允许下次重新高亮
    if (typeof document !== 'undefined') {
      document.querySelectorAll('[data-kh-cell-verify-hi]').forEach(el => el.removeAttribute('data-kh-cell-verify-hi'));
    }

    this.highlightedNodes.forEach(span => {
      if (span.parentNode) {
        const textNode = document.createTextNode(span.textContent);
        span.parentNode.replaceChild(textNode, span);
      }
    });
    this.highlightedNodes.clear();
  },

  /**
   * 设置 MutationObserver 监听动态内容
   */
  setupMutationObserver(keywords, config) {
    if (this.observer) {
      this.observer.disconnect();
    }

    // 延迟高亮：使用引擎自管定时器，destroy 时可取消，避免切换站点后旧定时器复活执行
    const scheduleHighlight = (kws, cfg) => {
      if (this._highlightTimer) clearTimeout(this._highlightTimer);
      this._highlightTimer = setTimeout(() => {
        this._highlightTimer = null;
        this.highlightKeywords(kws, cfg);
      }, 300);
    };

    this.observer = new MutationObserver((mutations) => {
      let shouldHighlight = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && !Utils.isSkippableElement(node)) {
              // 检查是否在新节点内部已经高亮过
              if (!node.querySelector('[data-kh-highlighted]')) {
                shouldHighlight = true;
                break;
              }
            }
          }
        }
        if (shouldHighlight) break;
      }

      if (shouldHighlight) {
        scheduleHighlight(keywords, config);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
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
   * 销毁引擎
   */
  destroy() {
    // 取消正在排队的延迟高亮，防止切换后旧定时器复活把禁用页重新高亮
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = null;
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
