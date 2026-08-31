/**
 * 关键词高亮引擎
 * 负责在 DOM 中查找和高亮关键词
 */
const KeywordEngine = {
  // 抓取后续字段：多行文本按这些固定标题分组（v1.6.42，后续可改）
  FETCH_GROUP_TITLES: ['基本信息', '测试信息', '资质信息', '运营备注'],
  highlightedNodes: new Set(),
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
      const re = Utils.buildMatchRegex(kw);
      if (!re) return null;
      const group = kw.groupId ? groupMap[kw.groupId] : null;
      return {
        ...kw,
        regex: re,
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
    for (const textNode of textNodes) {
      totalHits += this._highlightTextNode(textNode, compiledKeywords, config);
    }

    return totalHits;
  },

  /**
   * 在单个文本节点中高亮关键词
   */
  _highlightTextNode(textNode, compiledKeywords, config) {
    const text = textNode.textContent;
    if (!text.trim()) return 0;

    // 收集所有匹配
    const allMatches = [];
    for (const kw of compiledKeywords) {
      let match;
      kw.regex.lastIndex = 0;
      while ((match = kw.regex.exec(text)) !== null) {
        // 单元格特别标注验证：启用验证且右侧相邻单元格不含期望值时，该命中不生效（整条不匹配，不生成高亮）
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

      // 存储备注信息
      if (m.keyword.note) {
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
      }

      // 单元格特别标注：验证通过后记录期望值，供重要笔记展示相邻标注
      if (m.keyword.cellVerifyEnabled && m.keyword.cellVerify) {
        span.setAttribute('data-kh-cell-verify', m.keyword.cellVerify);
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
    const labels = raw.split(/[|｜,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (labels.length === 0) return [];

    let el = textNode.parentNode;
    while (el && el.nodeType === 1 && el.tagName !== 'TABLE') el = el.parentNode;
    if (!el || el.tagName !== 'TABLE') return []; // 暂支持 HTML 表格；假表格后续迭代

    const table = el;
    const cells = table.querySelectorAll('td, th');
    const out = [];
    for (const label of labels) {
      let target = null;
      for (const cell of cells) {
        if ((cell.textContent || '').trim() === label) { target = cell; break; }
      }
      if (!target) continue;
      const rows = this._collectRightBlock(target, table);
      if (rows.length) out.push({ label: label, rows: rows });
    }
    return out;
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
          const leftTxt = (c.td.textContent || '').trim();
          if (leftTxt) nextField = true;
        }
        if (c.col > col) {
          const txt = (c.td.textContent || '').trim();
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
    // 展开为文本行；规整多列真实格走 _renderGrid（保留 rowspan/colspan）
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
    // 存在真实多列格：多块合并会破坏列结构，退回逐块独立表（grid 块用 _renderGrid，文本块递归多字段合并）
    if (items.some(it => it.grid)) {
      return items.map(it => it.grid
        ? this._renderGrid(it.rows, it.label, esc)
        : this._rowsToTableMulti([{ label: it.label, rows: it.rows }])
      ).join('\n');
    }
    const all = items.filter(it => it.textLines.length > 0);
    if (!all.length) return '';
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
    const parsed = all.map(it => ({ label: it.label, filled: parseBlock(it.textLines, it.label) }));
    const totalRows = (filled) => filled.reduce((n, b) => n + (b.gtitle != null ? 1 : 0) + b.subs.reduce((m, s) => m + s.lines.length, 0), 0);
    const grandTotal = parsed.reduce((n, p) => n + totalRows(p.filled), 0);
    if (!grandTotal) return '';
    // 存在非空二级标题才渲染标题列；无标题（如单值）省略标题列，只留「字段列+内容列」（v1.7.2）
    const hasTitle = parsed.some(p => p.filled.some(b => b.subs.some(s => s.title != null && s.title !== '')));
    const titleColW = hasTitle ? 2 : 1;   // 一级分组标题行合并 标题列+内容列 的宽度
    let html = '<table class="kh-table">';
    for (const p of parsed) {
      if (!p.filled.length) continue;
      const blockTotal = totalRows(p.filled);     // 本字段块总行数（字段列 rowspan）
      let firstInBlock = true;
      for (const b of p.filled) {
        if (b.gtitle != null) {
          // 一级分组标题行：合并标题列+内容列为整行
          if (firstInBlock) {
            html += '<tr>' + (p.label != null ? '<td rowspan="' + blockTotal + '">' + esc(p.label) + '</td>' : '') +
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
              html += '<tr>' + (p.label != null ? '<td rowspan="' + blockTotal + '">' + esc(p.label) + '</td>' : '') +
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
   * 单元格特别标注验证（v1.6.18）
   * 关键词启用「单元格特别标注」且有期望值时：命中该关键词后，必须横向右侧相邻单元格内容
   * 【包含】期望值才保留此命中（不满足则该匹配不生成高亮，整条不生效）。
   * 支持：1) 真 HTML 表格：文本节点所属 td/th 的右侧相邻单元格；2) 文字假表格：命中后紧跟 | 或 Tab 分隔的内容。
   * 未启用验证的关键词恒返回 true（不改变原有行为）。
   */
  cellVerifyPass(textNode, match, kw) {
    const expect = kw.cellVerify;
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
          const flags = cs ? '' : 'i';
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
        const v = nx.textContent || '';
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
