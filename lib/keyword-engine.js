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
   * 编译关键词（构建分组颜色映射 + 预编译正则 + 生效颜色/重要笔记）
   * 供全量高亮与动态局部重跑复用。
   */
  _compileKeywords(keywords, config) {
    const groups = config.groups || [];
    const groupMap = {};
    groups.forEach(g => { if (g) groupMap[g.id] = g; });

    return keywords.map(kw => {
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
  },

  /**
   * 高亮关键词
   */
  async highlightKeywords(keywords, config) {
    const startTime = performance.now();
    let totalHits = 0;

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

    // 防御：文本节点已处于某个高亮 span 内则跳过，避免嵌套高亮
    const parentEl = textNode.parentElement;
    if (parentEl && parentEl.classList && parentEl.classList.contains('kh-highlight')) return 0;

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

    // 全词(exact)：右侧格整体与期望值相等；默认 include：右侧格包含期望值即可
    const exact = kw.cellVerifyMatchMode === 'exact';

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
        return exact ? (v.trim() === need) : (v.indexOf(need) !== -1);
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
        return rest.split(/[|\t]/)[0].trim() === need;
      }
      return rest.indexOf(need) !== -1;
    }

    return false; // 未找到相邻格/分隔符 → 验证不通过
  },

  /**
   * 移除所有高亮
   */
  removeAllHighlights() {
    this.highlightedNodes.forEach(span => {
      // 跳过已脱离 DOM 的 span（如翻页/内容替换时旧节点已被清理），避免对孤儿节点操作
      if (span.parentNode) {
        const textNode = document.createTextNode(span.textContent);
        span.parentNode.replaceChild(textNode, span);
      }
    });
    this.highlightedNodes.clear();
  },

  /**
   * 在指定容器内移除高亮（还原为纯文本），供动态局部重跑前清理旧高亮
   */
  _clearHighlightsIn(container) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return;
    const spans = container.querySelectorAll ? container.querySelectorAll('.kh-highlight[data-kh-highlighted]') : [];
    spans.forEach(span => {
      // 只处理仍挂载在容器内的 span
      if (span.parentNode) {
        const textNode = document.createTextNode(span.textContent);
        span.parentNode.replaceChild(textNode, span);
      }
      this.highlightedNodes.delete(span);
    });
  },

  /**
   * 局部重跑：还原指定容器内旧高亮后重新高亮该容器（用于容器内容替换/翻页）
   */
  _rehighlightIn(container, compiledKeywords, config) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return 0;
    // 1) 先清除容器内旧高亮，避免与新内容叠加残留
    this._clearHighlightsIn(container);
    // 2) 在容器内重新高亮
    const hits = this._highlightInRoot(container, compiledKeywords, config);
    return hits;
  },

  /**
   * 清理某个已脱离 DOM 的子树中的高亮 span 跟踪引用
   */
  _purgeDetachedHighlights(root) {
    if (!root || !root.querySelectorAll) return;
    const spans = root.querySelectorAll('.kh-highlight[data-kh-highlighted]');
    spans.forEach(span => this.highlightedNodes.delete(span));
  },

  /**
   * 动态重新高亮：对变化的容器逐个“还原+重跑”。
   * 若容器集合为空或含 document.body，则走全量重跑（先整体还原再重建）。
   */
  _dynamicRehighlight(kws, cfg, containers) {
    const compiled = this._compileKeywords(kws, cfg);
    if (compiled.length === 0) return;

    // 归并容器：若任一容器是 body，直接全量
    let full = false;
    const targets = [];
    for (const c of containers) {
      if (!c || c.nodeType !== Node.ELEMENT_NODE) continue;
      if (c === document.body || c === document.documentElement) { full = true; break; }
      if (!targets.includes(c)) targets.push(c);
    }

    let totalHits = 0;
    if (full) {
      this.removeAllHighlights();
      totalHits = this._highlightInRoot(document.body, compiled, cfg);
    } else {
      for (const c of targets) {
        totalHits += this._rehighlightIn(c, compiled, cfg);
      }
    }

    if (typeof this.onHighlight === 'function') {
      try { this.onHighlight(); } catch (e) {}
    }
    if (typeof this.onDynamicRehighlight === 'function') {
      try { this.onDynamicRehighlight(targets, totalHits); } catch (e) {}
    }
  },

  /**
   * 设置 MutationObserver 监听动态内容
   */
  setupMutationObserver(keywords, config) {
    if (this.observer) {
      this.observer.disconnect();
    }

    // 延迟高亮：使用引擎自管定时器，destroy 时可取消，避免切换站点后旧定时器复活执行
    const scheduleHighlight = (kws, cfg, containers) => {
      if (this._highlightTimer) clearTimeout(this._highlightTimer);
      this._highlightTimer = setTimeout(() => {
        this._highlightTimer = null;
        this._dynamicRehighlight(kws, cfg, containers);
      }, 300);
    };

    this.observer = new MutationObserver((mutations) => {
      const containers = new Set();
      let shouldHighlight = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // 新增节点：若新增元素尚未高亮过，则需要重跑（以其父容器为单位）
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            // 引擎自己插入的高亮 span 自身带 data-kh-highlighted：跳过，
            // 否则每次高亮都会触发 add 分支再次重跑，陷入 clear+重跑死循环
            if (node.getAttribute && node.getAttribute('data-kh-highlighted')) continue;
            if (!Utils.isSkippableElement(node)) {
              if (!node.querySelector('[data-kh-highlighted]')) {
                const parent = node.parentElement;
                containers.add(parent || node);
                shouldHighlight = true;
              }
            }
          }
          // 移除节点：若移除的是含高亮的内容，其父容器需重新高亮（清残留）
          for (const node of mutation.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.querySelector) {
              const had = node.querySelector('[data-kh-highlighted]');
              if (had) {
                this._purgeDetachedHighlights(node);
                const parent = mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : null;
                if (parent) {
                  containers.add(parent);
                  shouldHighlight = true;
                }
              }
            }
          }
        } else if (mutation.type === 'characterData') {
          // 文本内容变化（框架复用节点、原地改文本）：以其父元素为容器，还原+重跑
          const target = mutation.target;
          if (target && target.parentElement && !Utils.isSkippableElement(target.parentElement)) {
            containers.add(target.parentElement);
            shouldHighlight = true;
          }
        }
      }

      if (shouldHighlight && containers.size) {
        scheduleHighlight(keywords, config, containers);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
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
