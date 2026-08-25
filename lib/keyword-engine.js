/**
 * 关键词高亮引擎
 * 负责在 DOM 中查找和高亮关键词
 */
const KeywordEngine = {
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
        if (m.keyword.effectiveImportantNote) {
          span.setAttribute('data-kh-important-note', m.keyword.effectiveImportantNote);
        }
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

    // 1) 真 HTML 表格：向上找 td/th，取同一行右侧相邻单元格（跳过空兄弟）
    const parentEl = textNode.parentElement;
    const cell = parentEl && parentEl.closest ? parentEl.closest('td,th') : null;
    if (cell && cell.parentElement) {
      let nx = cell.nextElementSibling;
      while (nx && /^TD|TH$/i.test(nx.tagName) && !(nx.textContent || '').trim()) {
        nx = nx.nextElementSibling;
      }
      if (nx && /^TD|TH$/i.test(nx.tagName)) {
        return (nx.textContent || '').indexOf(need) !== -1; // 包含即匹配
      }
      return false; // 属表格单元格但右侧无有效相邻格 → 验证不通过
    }

    // 2) 文字假表格：命中后紧跟 | 或 Tab 分隔，取其第一段非空内容判断是否包含期望值
    // 注意：match 是 RegExpMatchArray（exec 结果），没有 .end，用 index + [0].length 计算命中结束位置
    const after = textNode.textContent.slice(match.index + match[0].length);
    const sep = after.match(/^[ \t]*[|\t][ \t]*/);
    if (sep) {
      const rest = after.slice(sep[0].length);
      return rest.indexOf(need) !== -1;
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
