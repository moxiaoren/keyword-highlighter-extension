/* ============================================================================
 * src/platform/markdown.js · 重要笔记 Markdown 单源（渲染 + 编辑器序列化）
 * ----------------------------------------------------------------------------
 * 为什么必须有这个文件（功能不缩水）：
 *   旧版「重要笔记」是**所见即所得富文本**：编辑器里图片/链接/加粗/斜体/表格直接显示效果
 *   （v1.8.16~v1.8.20），存储的是干净 Markdown，网页端按效果呈现。v2 重构时一度把它
 *   退化成纯文本多行框 → 用户指出的功能缺失，本文件即补齐入口。
 *
 * 单源范围（语法与安全规则**只有这一份**）：
 *   · 编辑器（options/popup 的所见即所得编辑）  → toFragment() 装载 + fromEditor() 序列化
 *   · 重要笔记面板（important-note.js）          → toFragment()
 *   · 备注卡片（note-card.js）                   → toFragment()
 *   · 设置页预览（rich-editor.js 的预览分支）    → toFragment()
 *
 * 支持的语法（与旧版逐条对齐）：
 *   **加粗**  *斜体*  [文字](网址)  ![说明](图片网址)  纯网址自动转链接  | a | b | 表格
 *
 * 安全模型（比旧版更严，不是更松）：
 *   旧版走「textContent→innerHTML 转义 + 正则替换 + 白名单清洗」；本实现**自始至终
 *   不经过 innerHTML**——全部用 createElement/createTextNode 构建，用户内容只会成为
 *   文本节点，XSS 没有落脚点。URL 仍保留旧版协议白名单（防 javascript: 注入）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 图片协议白名单（旧版 v1.8.0 起的约束，原样保留） */
  const IMG_OK = /^(https?:\/\/|data:image\/)/i;
  /** 链接协议白名单（旧版 v1.8.20；相对地址也放行） */
  function linkUrlOk(u) {
    u = (u || '').trim();
    if (!u) return null;
    if (u === '#') return '#';
    if (/^(https?:|mailto:|tel:|ftp:)/i.test(u)) return u;
    if (/^(\/|\.\.?\/|#)/.test(u)) return u;
    return null;
  }

  /** 找配对的右括号（支持 URL 内嵌配对括号，如 wiki 链接），返回 {url, end} 或 null */
  function readParen(s, start) {
    if (s[start] !== '(') return null;
    let depth = 0;
    for (let k = start; k < s.length; k++) {
      const ch = s[k];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          return { url: s.slice(start + 1, k).replace(/\s+["'][\s\S]*?["']\s*$/, '').trim(), end: k + 1 };
        }
      }
    }
    return null;
  }

  const BARE_URL = /^https?:\/\/[^\s<>"]+/;

  /**
   * 行内解析：把一段纯文本按行内语法转成 DOM 节点，追加进 out。
   * 递归下降扫描器——不经过 innerHTML，用户内容只会成为文本节点。
   */
  function inline(text, doc, out) {
    let buf = '';
    const flush = () => { if (buf) { out.push(doc.createTextNode(buf)); buf = ''; } };
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      let m;

      /* 图片 ![alt](url) —— 必须先于链接，否则会被 [](url) 吃掉（旧版注释原话） */
      if ((m = /^!\[([^\]]*)\]\(/.exec(rest))) {
        const p = readParen(rest, m[0].length - 1);
        const url = p && p.url;
        if (p && IMG_OK.test(url)) {
          flush();
          const img = doc.createElement('img');
          img.src = url;
          img.alt = m[1] || '';
          img.setAttribute('loading', 'lazy');
          out.push(img);
          i += p.end;
          continue;
        }
      }

      /* 链接 [text](url)；纯网址做文字的链接还原为纯网址，不弄脏笔记（旧版 v1.8.20） */
      if ((m = /^\[([^\]]*)\]\(/.exec(rest))) {
        const p = readParen(rest, m[0].length - 1);
        const url = p && linkUrlOk(p.url);
        if (p && url) {
          flush();
          const label = m[1] || '';
          if (label === p.url.trim()) {
            out.push(doc.createTextNode(label));   // [url](url) → 纯文本 url
          } else {
            const a = doc.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            const kids = [];                          // inline() 的出口是数组，装完再挂到元素上
            inline(label, doc, kids);                 // 链接文字里允许再加粗/斜体
            for (const k of kids) a.appendChild(k);
            out.push(a);
          }
          i += p.end;
          continue;
        }
      }

      /* 加粗 **xx** */
      if (rest.startsWith('**')) {
        const j = text.indexOf('**', i + 2);
        if (j > i + 1) {
          flush();
          const b = doc.createElement('b');
          const kids = [];
          inline(text.slice(i + 2, j), doc, kids);
          for (const k of kids) b.appendChild(k);
          out.push(b);
          i = j + 2;
          continue;
        }
      }

      /* 斜体 *xx*（不与 ** 冲突：** 已在上面先行消费） */
      if (text[i] === '*') {
        let j = text.indexOf('*', i + 1);
        // 跳过被当成加粗结尾的场合：内容至少 1 个字符
        if (j > i + 1) {
          // 若这段里还嵌着 **，交给内层递归处理（外层按斜体包一层）
          flush();
          const em = doc.createElement('i');
          const kids = [];
          inline(text.slice(i + 1, j), doc, kids);
          for (const k of kids) em.appendChild(k);
          out.push(em);
          i = j + 1;
          continue;
        }
      }

      /* 裸 URL 自动转链接（口径与旧版一致：遇到空白/<>"/ 止） */
      if ((m = BARE_URL.exec(rest)) && (i === 0 || /[\s(]/.test(text[i - 1]))) {
        flush();
        const a = doc.createElement('a');
        a.href = m[0];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[0];
        out.push(a);
        i += m[0].length;
        continue;
      }

      buf += text[i];
      i++;
    }
    flush();
  }

  /** 是否 markdown 表格行：行首（可缩进）| … | 行尾 */
  function isTableRowLine(line) {
    return /^[ \t]*\|.*\|[ \t]*$/.test(line);
  }
  /** 分隔行（| --- | :---: | 等）：剔除，不渲染成单元格（旧版 v1.8.0/v1.11.1 口径） */
  function isSepLine(line) {
    const core = line.trim().replace(/^\|/, '').replace(/\|$/, '').trim();
    const strip = core.replace(/[\s|:]/g, '');
    return !!strip && /^-+$/.test(strip);
  }

  /** 表格块 → <table class="kh-table">（单元格内支持图片/链接/加粗/斜体，v1.11.1 口径） */
  function buildTable(lines, doc) {
    const rows = lines.filter(l => !isSepLine(l)).map(line => {
      const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '').trim();
      const cells = inner.split('|');
      const tr = doc.createElement('tr');
      for (const c of cells) {
        const td = doc.createElement('td');
        const kids = [];
        inline(c.trim(), doc, kids);
        for (const k of kids) td.appendChild(k);
        tr.appendChild(td);
      }
      return tr;
    });
    const tbl = doc.createElement('table');
    tbl.className = 'kh-table';
    for (const tr of rows) tbl.appendChild(tr);
    return tbl;
  }

  /**
   * Markdown → DocumentFragment（唯一渲染入口）。
   * @param {string} md 用户存储的 markdown 文本
   * @param {Document} doc 在哪个 document 里建节点（内容脚本 = 页面 document）
   */
  function toFragment(md, doc) {
    const frag = (doc || document).createDocumentFragment();
    const src = md == null ? '' : String(md);
    if (!src.trim()) return frag;

    const lines = src.split('\n');
    let i = 0;
    let first = true;
    const gap = () => { if (!first) frag.appendChild((doc || document).createTextNode('\n')); };

    while (i < lines.length) {
      if (isTableRowLine(lines[i])) {
        let j = i;
        while (j < lines.length && isTableRowLine(lines[j])) j++;
        gap();
        frag.appendChild(buildTable(lines.slice(i, j), doc || document));
        first = false;
        i = j;
        continue;
      }
      gap();
      const kids = [];                       // inline() 的出口是数组，统一在此挂载
      inline(lines[i], doc || document, kids);
      for (const k of kids) frag.appendChild(k);
      first = false;
      i++;
    }
    return frag;
  }

  /* ======================= 编辑器序列化：contenteditable → markdown ======================= */

  function nodeToMD(node, out) {
    if (node.nodeType === 3) { out.push(node.textContent); return; }
    if (node.nodeType !== 1) return;
    const t = node.tagName.toLowerCase();
    const kids = Array.prototype.slice.call(node.childNodes);
    switch (t) {
      case 'br': out.push('\n'); return;
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        out.push('![' + alt + '](' + src + ')');
        return;
      }
      case 'b': case 'strong': out.push('**'); kids.forEach(c => nodeToMD(c, out)); out.push('**'); return;
      case 'i': case 'em': out.push('*'); kids.forEach(c => nodeToMD(c, out)); out.push('*'); return;
      case 'a': {
        const href = node.getAttribute('href') || '';
        // 链接文字就是网址本身（纯 URL 自动转的链接）→ 保留纯网址（旧版 v1.8.20 口径）
        if (href && kids.length === 1 && kids[0].nodeType === 3 && kids[0].textContent === href) {
          out.push(href);
          return;
        }
        out.push('['); kids.forEach(c => nodeToMD(c, out)); out.push('](' + href + ')');
        return;
      }
      case 'table': out.push('\n' + tableToMD(node) + '\n'); return;
      case 'p': case 'div': out.push('\n'); kids.forEach(c => nodeToMD(c, out)); out.push('\n'); return;
      default: kids.forEach(c => nodeToMD(c, out));
    }
  }

  /** 表格 → markdown（自动补分隔行；单元格内递归粗/斜/链接/图片，v1.11.1 口径） */
  function tableToMD(tbl) {
    const cellNode = (node) => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      const ct = node.tagName.toLowerCase();
      switch (ct) {
        case 'br': return ' ';
        case 'img': return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
        case 'b': case 'strong': return '**' + Array.prototype.map.call(node.childNodes, cellNode).join('') + '**';
        case 'i': case 'em': return '*' + Array.prototype.map.call(node.childNodes, cellNode).join('') + '*';
        case 'a': {
          const href = node.getAttribute('href') || '';
          const txt = node.textContent || '';
          if (href && txt === href) return href;
          return '[' + txt + '](' + href + ')';
        }
        default: return Array.prototype.map.call(node.childNodes, cellNode).join('');
      }
    };
    const cell = (td) => {
      let s = '';
      td.childNodes.forEach(c => { s += cellNode(c); });
      return s.trim();
    };
    const rows = [];
    tbl.querySelectorAll('tr').forEach(tr => {
      rows.push(Array.prototype.map.call(tr.children, cell).join(' | '));
    });
    if (rows.length) {
      const hasSep = rows.length > 1 && /^:?-+\s*\|/.test(rows[1]);
      if (!hasSep) rows.splice(1, 0, rows[0].split('|').map(() => '---').join(' | '));
    }
    return rows.map(r => '| ' + r + ' |').join('\n');
  }

  /** contenteditable 根 → markdown 字符串（编辑器保存时唯一出口） */
  function fromEditor(root) {
    if (!root) return '';
    const parts = [];
    Array.prototype.slice.call(root.childNodes).forEach(c => nodeToMD(c, parts));
    return parts.join('')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n +/g, '\n')
      .trim();
  }

  KH.Markdown = { toFragment, fromEditor, inline, linkUrlOk, IMG_OK };
})();
