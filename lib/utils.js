/**
 * 通用工具函数
 */
const Utils = {
  /**
   * 获取当前页面的主机名
   */
  getHostname() {
    return window.location.hostname;
  },

  /**
   * 转义正则表达式特殊字符
   */
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  /**
   * 防抖函数
   */
  debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * 节流函数
   */
  throttle(fn, limit) {
    let inThrottle = false;
    return function (...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => { inThrottle = false; }, limit);
      }
    };
  },

  /**
   * XSS 安全清理：只允许安全标签
   */
  sanitizeHTML(str) {
    if (!str) return '';
    // 支持 markdown 表格（v1.6.38）：连续 | a | b | 行 → 表格，用占位符避免被下方 textContent 转义
    const tableMap = [];
    let src = String(str);
    src = src.replace(/((?:^|\n)[ \t]*\|[^\n]*\|[ \t]*(?:\n[ \t]*\|[^\n]*\|[ \t]*)*)/g, (block) => {
      const idx = tableMap.length;
      tableMap.push(this._buildTable(block));
      return '\u0001KH_TABLE_' + idx + '\u0001';
    });
    str = src;
    // 只允许 b, i, a, br 标签，其他转义
    const allowedTags = {
      'b': [],
      'i': [],
      'a': ['href', 'title', 'target'],
      'br': [],
      'strong': [],
      'em': []
    };
    
    const div = document.createElement('div');
    div.textContent = str;
    let text = div.innerHTML;
    
    // 简单的 markdown 转换：**bold** → <b>bold</b>
    text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // *italic* → <i>italic</i>
    text = text.replace(/\*(.+?)\*/g, '<i>$1</i>');
    // [text](url) → <a href="url" target="_blank">text</a>
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    
    // 自动识别纯URL
    text = text.replace(/(^|\s)(https?:\/\/[^\s<>"]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    
    // 再次转义任何残留的 HTML 标签（除了允许的）
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    
    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (allowedTags[tagName]) {
          // 清理属性
          const attrs = node.attributes;
          for (let i = attrs.length - 1; i >= 0; i--) {
            const attrName = attrs[i].name;
            if (!allowedTags[tagName].includes(attrName)) {
              node.removeAttribute(attrName);
            }
          }
          // 对 a 标签添加安全属性
          if (tagName === 'a') {
            node.setAttribute('rel', 'noopener noreferrer');
            node.setAttribute('target', '_blank');
          }
          // 递归清理子节点
          const children = Array.from(node.childNodes);
          children.forEach(cleanNode);
        } else {
          // 不允许的标签，替换为文本
          node.replaceWith(document.createTextNode(node.textContent));
        }
      }
    }
    
    Array.from(tempDiv.childNodes).forEach(cleanNode);
    let out = tempDiv.innerHTML;
    // 还原表格占位为真实表格 HTML
    out = out.replace(/\u0001KH_TABLE_(\d+)\u0001/g, (_, i) => tableMap[+i]);
    return out;
  },

  /**
   * 把 markdown 表格块（| 小节1 | 值 |）构造成安全的 <table> HTML
   */
  _buildTable(block) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const rows = lines.map(line => {
      let inner = line.replace(/^\|/, '').replace(/\|$/, '').trim();
      const cells = inner.split('|').map(c => {
        const d = document.createElement('div');
        d.textContent = c.trim();
        return '<td>' + d.innerHTML + '</td>';
      });
      return '<tr>' + cells.join('') + '</tr>';
    });
    return '<table class="kh-table">' + rows.join('') + '</table>';
  },

  /**
   * 判断元素是否在不可高亮区域
   */
  isSkippableElement(element) {
    if (!element || !element.tagName) return true;
    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'KBD', 'VAR', 'SAMP'];
    return skipTags.includes(element.tagName);
  },

  /**
   * 判断元素是否「视觉不可见」（隐藏元素里的隐藏文本不应高亮/触发重要笔记）
   * 覆盖 display:none / visibility:hidden / collapse / hidden 属性 / 无尺寸
   */
  isElementHidden(el) {
    if (!el) return false;
    // hidden 属性
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    let node = el;
    // 沿祖先链找：任一祖先 display:none 或 visibility:hidden 且没有后代覆盖时判定不可见
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const cs = window.getComputedStyle(node);
      if (cs.display === 'none') return true;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
        // visibility 可能被子元素覆盖（visibility:visible），但高亮文本本身在叶子
        // 为可靠判断，若该祖先没有可见子元素用于覆盖，则判不可见
        if (!this._hasVisibleOverride(node)) return true;
        // 有可见覆盖则继续向上（该节点层可见）
      }
      node = node.parentElement;
    }
    return false;
  },

  /**
   * 检查某祖先元素内是否有 visibility:visible 的子元素（可覆盖 visible:hidden）
   */
  _hasVisibleOverride(el) {
    // 仅浅查直接子元素，避免 deep 扫描开销；多数覆盖场景都发生在直接子元素
    return [...el.children].some(child => {
      if (child.hidden) return false;
      const cs = window.getComputedStyle(child);
      return cs.visibility === 'visible' || (cs.display !== 'none' && cs.visibility !== 'hidden');
    });
  },

  /**
   * 判断节点是否可高亮
   */
  isHighlightableNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      // 检查父元素
      let parent = node.parentElement;
      while (parent) {
        if (Utils.isSkippableElement(parent)) return false;
        if (parent.hasAttribute && parent.hasAttribute('data-kh-highlighted')) return false;
        // 隐藏元素（display:none / visibility:hidden / hidden 等）里的文本不参与高亮
        if (Utils.isElementHidden(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    }
    return false;
  },

  /**
   * 站点规则匹配
   */
  /**
   * 站点规则匹配
   * rule.scope === 'url' 时按完整网址匹配（prefix/regex）；否则按域名匹配
   */
  matchSiteRule(hostname, rule, url) {
    if (rule.scope === 'url') {
      const target = url || '';
      switch (rule.matchType) {
        case 'prefix':
          return target.startsWith(rule.pattern);
        case 'regex':
          try {
            return new RegExp(rule.pattern).test(target);
          } catch (e) {
            return false;
          }
        default:
          return false;
      }
    }
    switch (rule.matchType) {
      case 'exact':
        return hostname === rule.pattern;
      case 'subdomain':
        return hostname.endsWith('.' + rule.pattern) || hostname === rule.pattern;
      case 'prefix':
        return hostname.startsWith(rule.pattern);
      case 'regex':
        try {
          return new RegExp(rule.pattern).test(hostname);
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  },

  /**
   * 检查当前站点/页面是否应该应用高亮
   * url 用于网址级规则（同一站点下针对某个分页单独控制）
   */
  async shouldHighlightForSite(hostname, siteRules, siteDisabledMap, url) {
    // 先检查是否临时禁用
    if (siteDisabledMap[hostname]) return false;
    
    if (!siteRules || siteRules.length === 0) return true; // 默认所有站点生效
    
    // 网址级规则优先判定（用于同一站点下针对特定分页控制）
    for (const rule of siteRules) {
      if (rule.scope === 'url' && Utils.matchSiteRule(hostname, rule, url)) {
        return rule.type === 'whitelist'; // 网址级白名单命中则生效，黑名单命中则不生效
      }
    }
    
    // 域名级规则
    for (const rule of siteRules) {
      if (rule.scope !== 'url' && Utils.matchSiteRule(hostname, rule, url)) {
        return rule.type === 'whitelist'; // 白名单命中则生效，黑名单命中则不生效
      }
    }
    
    // 如果没有匹配任何规则：如果有白名单则不生效，如果有黑名单则生效
    const hasWhitelist = siteRules.some(r => r.type === 'whitelist');
    return !hasWhitelist; // 有白名单时未匹配则不生效
  },

  /**
   * 构建正则表达式
   */
  buildMatchRegex(keyword) {
    let pattern = keyword.text;
    if (!keyword.useRegex) {
      pattern = Utils.escapeRegex(pattern);
    }
    let flags = 'g';
    if (!keyword.caseSensitive) flags += 'i';

    // 全词/整词匹配：使用 Unicode 词字符边界，对中文等 CJK 文本同样生效
    // （\b 只对 ASCII 字母/数字生效，纯中文单词用 \b 会永远匹配不到）
    if (keyword.wholeWord) {
      flags += 'u';
      const boundary = '[\\p{L}\\p{N}_]';
      pattern = `(?<!${boundary})${pattern}(?!${boundary})`;
    }

    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      console.warn('无效的正则表达式:', keyword.text, e);
      return null;
    }
  },

  /**
   * 获取元素相对于视口的位置信息
   */
  getElementViewportPosition(el) {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  },

  /**
   * 计算备注卡片最佳位置
   */
  calculateNotePosition(elRect, cardWidth, cardHeight) {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 8;
    
    let top = elRect.bottom + gap;
    let left = elRect.left;
    
    // 如果下方空间不够，放在上方
    if (top + cardHeight > viewportH - 10) {
      top = elRect.top - cardHeight - gap;
    }
    
    // 确保不超出视口左右边界
    if (left < 10) left = 10;
    if (left + cardWidth > viewportW - 10) {
      left = viewportW - cardWidth - 10;
    }
    
    // 确保不超出视口上下边界
    if (top < 10) top = 10;
    if (top + cardHeight > viewportH - 10) {
      top = viewportH - cardHeight - 10;
    }
    
    return { top, left };
  }
};

if (typeof window !== 'undefined') {
  window.Utils = Utils;
}
