/* ============================================================================
 * src/core/renderer.js · ⑤Render —— 全工程唯一渲染实现 + 扩展点③ RendererPlugin
 * ----------------------------------------------------------------------------
 * 铁律（方案 §2 第 1 条）：高亮 = 纯视觉，**永不改 DOM**。
 *   · 命中一律 `Range + CSS.highlights`；**全库只有本文件允许出现 `CSS.highlights.set(`**
 *     （UN-03 / meta-check #5 校验唯一性）。
 *   · 绝不 `replaceChild` / `splitText` / `unwrap` —— 这正是旧版孤儿节点的病根
 *     （旧版 lib/keyword-engine.js:1661 的「仅抓取」路径仍在拆节点，R1 已整改）。
 *   · `::highlight` 表达不了的能力（边框、圆角、图片底纹）走 RendererPlugin，
 *     由插件自己在 Shadow DOM / 覆盖层里画，**不允许退回拆节点**。
 *
 * 降级分层（方案 §9，UN-07）：
 *   L0 原生 CSS.highlights（首选）
 *   L1 不支持时：视觉高亮整体消失，但重要笔记 / 抓取值 / 统计 / 点击定位**全部照常**
 *      —— 因为这一切都读 Registry 的 Range，与视觉无关。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** highlight 名称前缀；同一色值归一个组，重建时按组批量 add（方案 §9 性能要求） */
  const HL_PREFIX = 'kh-hl-';
  const STYLE_NODE_ATTR = 'data-kh-hl-style';   // DOM 上允许的第二类插件属性

  const supportsHighlights = (typeof CSS !== 'undefined' && CSS && CSS.highlights &&
    typeof Highlight !== 'undefined');

  const plugins = KH.createRegistry ? KH.createRegistry('RendererPlugin') : null;

  /* ==========================================================================
   * 感知判据：原网页的文字色 vs 我们的高亮底色，够不够"分得开"
   * --------------------------------------------------------------------------
   * 背景（用户实测场景）：网页里本来标红的字，被命中后变成黑色 —— 因为 `::highlight`
   * 规则里无条件写了 `color`。用户要求：**默认文字色不覆盖原色**，除非"原文字色 + 高亮底色
   * 会导致文字不显"。（关键词/分组显式设过的文字色仍然照旧强制生效。）
   *
   * 【只用 ΔE(Lab) 一个信号，实测数据说话】最初我用了"亮度对比度 + 色差"双信号，实测判反了：
   * 以默认底色橙 #ff9500 为例（数字由同公式离线算出）：
   *   文字色            亮度对比度   ΔE
   *   红 #e53935          1.92      51   ← 用户要保留的场景，却低于任何 WCAG 阈值
   *   橙 #ff9500（同色）   1.00       0   ← 必须兜底
   *   近似橙 #ffa733       1.13      12   ← 必须兜底
   *   深橙褐 #c76b00       1.73      22   ← 必须兜底
   *   白 #ffffff          2.20      88   ← 亮暗接近但颜色分得开，能看清 → 保留
   *   黑 #000000          9.55     110   ← 最常见，必须保留
   * 结论：**"不显"的本质是两个颜色分不开，而不是亮度不够**。亮度对比度会把红叠橙这种
   * "色相差得开、看得清"的误判成不显。所以只按 CIE76 色差判：
   *   ΔE ≥ 30 → 分得开，保留原网页文字色
   *   ΔE < 30 → 分不开，用兜底色（否则文字会糊在底色里）
   * 30 是"明显不同色"的下限（JND≈2.3，30 远高于它），落在实测的 22（兜底）与 42（保留）之间。
   * ========================================================================== */
  const MIN_DELTA_E = 30;

  /** '#rgb' / '#rrggbb' / 'rgb(a)(...)' → [r,g,b,a]；解析不出返回 null */
  function parseColor(str) {
    const s = String(str || '').trim();
    let m = /^#([0-9a-fA-F]{3})$/.exec(s);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
    m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(s);
    if (m) {
      const a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), a];
    }
    return null;
  }

  function relLuminance(c) {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }

  /** WCAG 对比度（1..21） */
  function lumContrast(a, b) {
    const la = relLuminance(a), lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** sRGB → CIE L*a*b*（D65） */
  function toLab(c) {
    const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const r = f(c[0]), g = f(c[1]), b = f(c[2]);
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.00000;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const k = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116));
    x = k(x); y = k(y); z = k(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  /** CIE76 色差（够用且便宜：这里只用来判断"是不是同一种颜色") */
  function deltaE(a, b) {
    const A = toLab(a), B = toLab(b);
    return Math.sqrt(Math.pow(A[0] - B[0], 2) + Math.pow(A[1] - B[1], 2) + Math.pow(A[2] - B[2], 2));
  }

  /** 原文字色叠在我们的底色上，还分得开吗？（分得开＝不需要兜底改色） */
  function readableOn(pageColor, bgColor) {
    const p = parseColor(pageColor), b = parseColor(bgColor);
    if (!p || !b) return true;                 // 解析不了就别乱改（宁可保留原色）
    if (p[3] === 0) return false;              // 完全透明＝等于没颜色 → 必须兜底
    return deltaE(p, b) >= MIN_DELTA_E;
  }

  /** 兜底色选择：优先用配置里的默认文字色；它自己也分不开时，按底色明度取黑或白 */
  function fallbackColor(preferred, bgColor) {
    const b = parseColor(bgColor);
    const p = parseColor(preferred);
    if (p && readableOn(preferred, bgColor)) return preferred;
    if (!b) return preferred || '#000000';
    return relLuminance(b) > 0.45 ? '#000000' : '#ffffff';
  }

  const Renderer = {
    HL_PREFIX,
    STYLE_NODE_ATTR,
    supportsHighlights,
    plugins,
    /* 颜色判据对外暴露，便于测试与后续调阈值（真浏览器用例会直接验这两条边界） */
    _percept: { parseColor, lumContrast, deltaE, readableOn, fallbackColor, MIN_DELTA_E },

    /** 已注入的 ::highlight 样式节点（按 名称->节点 记账，便于精确撤销） */
    _styleNodes: new Map(),
    /** 已建立的 highlight 对象（名称 -> Highlight），用于 after 阶段精确 delete */
    _groups: new Map(),

    /**
     * 颜色标准化 → 组名。同色必须同组，否则 ::highlight 规则会互相打架。
     * **不在此处写任何颜色默认值** —— 默认值唯一真源是 `Config.defaults.highlightStyle`，
     * 由门面在 ⑥Index 阶段统一解析后传入（避免"两个默认值源"）。
     * @param {object} style
     * @param {string} [variant] '' 强制字色 / 'auto' 不写 color（保留原网页色）/ 'fix' 兜底字色
     */
    groupNameFor(style, variant) {
      const bg = (style && style.bgColor) || '';
      const fg = (style && style.textColor) || '';
      const slug = (bg + '-' + fg).replace(/[^0-9a-zA-Z]/g, '');
      return HL_PREFIX + (slug || 'default') + (variant ? '-' + variant : '');
    },

    /**
     * 确保某个视觉组对应的 ::highlight 规则已注入页面（幂等）。
     * @param {string} name
     * @param {object} style
     * @param {string} [variant] 见 groupNameFor；'auto' 时**不写 color**，
     *        于是 ::highlight 不覆盖文字色，网页自身的颜色（如标红）得以保留
     * @param {string} [forcedColor] variant='fix' 时使用的兜底字色
     */
    _ensureGroupStyle(name, style, variant, forcedColor) {
      if (!supportsHighlights) return;
      if (this._styleNodes.has(name)) return;
      if (!style || !style.bgColor) return;   // 无颜色不渲染（不猜默认值）
      let color = '';
      if (variant === 'auto') color = '';                       // 保留原网页文字色
      else if (variant === 'fix') color = forcedColor || '';
      else color = style.textColor || style.bgColor;            // 显式字色：照旧强制生效
      const css = '::highlight(' + name + '){background-color:' + style.bgColor +
        (color ? ';color:' + color : '') + ';}';
      const el = document.createElement('style');
      el.setAttribute(STYLE_NODE_ATTR, '1');
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
      this._styleNodes.set(name, el);
    },

    /**
     * 写入 / 覆盖一个视觉组。
     * **全库唯一允许调用 `CSS.highlights.set(` 的地方**（UN-03 / meta-check #5）；
     * Rebuilder 的局部清理也必须经由此方法，不允许自己直接调 API。
     */
    setGroup(name, ranges) {
      if (!supportsHighlights) return;
      if (!ranges || !ranges.length) {
        CSS.highlights.delete(name);
        this._groups.delete(name);
        return;
      }
      const hl = new Highlight(...ranges);
      this._groups.set(name, hl);
      CSS.highlights.set(name, hl);
    },

    /** 移除一个视觉组 */
    removeGroup(name) {
      if (!supportsHighlights) return;
      try { CSS.highlights.delete(name); } catch (err) { /* 已被外部清掉，忽略 */ }
      this._groups.delete(name);
    },

    /** 建立 Range。`node` 缺失或已脱离文档时返回 null（不抛错，不阻塞其它命中）
     *  【跨节点命中】带 `endNode/endOffset` 时用它们收尾 —— CSS.highlights 的原生 Range
     *  本来就能跨节点，于是"被元素拆开的词"也能整段上色（用户实测要求：
     *  `审核(黑)<span red>不通过</span>` 应当命中「审核不通过」，且两段颜色各自保留）。 */
    rangeOf(hit) {
      const node = hit && hit.textNode;
      if (!node || !node.isConnected) return null;
      const len = node.nodeValue ? node.nodeValue.length : 0;
      if (hit.start < 0 || hit.start >= len) return null;
      try {
        const r = document.createRange();
        r.setStart(node, hit.start);
        if (hit.endNode && hit.endNode !== node) {
          if (!hit.endNode.isConnected) return null;
          const elen = hit.endNode.nodeValue ? hit.endNode.nodeValue.length : 0;
          if (hit.endOffset == null || hit.endOffset < 0 || hit.endOffset > elen) return null;
          r.setEnd(hit.endNode, hit.endOffset);
        } else {
          if (hit.end > len || hit.start >= hit.end) return null;
          r.setEnd(node, hit.end);
        }
        return r;
      } catch (err) {
        return null;
      }
    },

    /**
     * 渲染（全量）。调用方保证已先 Clear（renderer 不做清理）。
     * @param {object[]} hits 来自 Registry 的命中（调用方应已过滤 visual）
     * @returns {{rendered:number, skipped:number}}
     */
    render(hits) {
      let rendered = 0;
      let skipped = 0;

      /* 每个 Range 都要判断"是否保留原网页文字色"，判据依赖该元素的计算色；
       * 同一批里大量命中往往共享父元素，所以按元素缓存（一次 render 一份），避免重复取计算样式。 */
      const colorCache = new Map();
      const pageColorOf = (range) => {
        const node = range.startContainer;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el) return '';
        if (colorCache.has(el)) return colorCache.get(el);
        let c = '';
        try { c = getComputedStyle(el).color || ''; } catch (err) { c = ''; }
        colorCache.set(el, c);
        return c;
      };

      // 分组
      const groups = new Map(); // name -> { style, variant, forced, ranges: Range[] }
      for (const h of hits || []) {
        let range = h._range || null;
        if (!range) { range = this.rangeOf(h); if (range) h._range = range; }
        if (!range) { skipped++; continue; }

        const style = h.style || null;
        /* 只在"文字色只是全局默认"时保留原色；显式设过的字色仍照旧强制。
         * 原色与底色分不开时退化为'fix'（用兜底色），保证任何情况下文字都看得见。 */
        let variant = '';
        let forced = '';
        if (style && style.textIsDefault && style.bgColor) {
          const page = pageColorOf(range);
          if (readableOn(page, style.bgColor)) variant = 'auto';
          else { variant = 'fix'; forced = fallbackColor(style.textColor, style.bgColor); }
        }
        const name = this.groupNameFor(style, variant);
        if (!groups.has(name)) groups.set(name, { style, variant, forced, ranges: [] });
        groups.get(name).ranges.push(range);

        rendered++;
      }

      if (supportsHighlights) {
        for (const [name, g] of groups) {
          this._ensureGroupStyle(name, g.style, g.variant, g.forced);
          // 单点写入：批量、按色分组（经 setGroup 统一收口，UN-03 唯一实现）
          this.setGroup(name, g.ranges);
        }
      }

      // 扩展点③：交给 RendererPlugin 做 ::highlight 之外的视觉
      if (plugins) {
        for (const [label, plugin] of plugins.entries()) {
          try {
            if (plugin.render) plugin.render(hits || [], { supportsHighlights, groupNameFor: (s) => this.groupNameFor(s) });
          } catch (err) {
            console.error('[KH] RendererPlugin 异常:', label, err);
          }
        }
      }

      return { rendered, skipped };
    },

    /** 清空视觉（不碰 Registry，也不碰文档结构） */
    clear() {
      if (supportsHighlights) {
        for (const name of Array.from(this._groups.keys())) this.removeGroup(name);
      }
      for (const [, el] of this._styleNodes) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      this._styleNodes.clear();

      if (plugins) {
        for (const [label, plugin] of plugins.entries()) {
          try { if (plugin.clear) plugin.clear(); } catch (err) { console.error('[KH] RendererPlugin clear 异常:', label, err); }
        }
      }
    }
  };

  KH.Renderer = Renderer;
})();
