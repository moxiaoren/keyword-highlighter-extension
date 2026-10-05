/* ============================================================================
 * src/features/note-card.js · 备注卡片（点击命中处弹卡）+ 悬停备注 tooltip
 * ----------------------------------------------------------------------------
 * 定位方式严格走唯一入口（铁律 3）：
 *   `KH.pointToRange(x, y)`  →  `KH.registry.query(node, offset)`
 *   —— 全库**不出现** `closest('.kh-highlight')` / `[data-kh-*]` 之类 DOM 反查。
 *   旧版 v1.52.0 是给命中处插 `<span class="kh-highlight">` 再反查它 —— 命中位置
 *   被绑死在 DOM 上，任何框架重渲染都会让定位失效。
 *
 * 卡片宿主 id 沿用旧版 `kh-note-card`（D3 命名沿用）；样式取自配置 `noteCardStyle`。
 *
 * ★ 与重建管线的关系（v2.0.0 实测事故的根治口径）
 *   v1.52.0 里 `keyword-engine.js` **从不引用 NoteCard** —— 重建管线与交互 UI 零耦合，
 *   tooltip/卡片只由鼠标事件决定存亡。v2 把 note-card 注册成了 feature，于是每次重建
 *   都会调用它的 `clear` / `consume`，一度把刚弹出的交互 UI 直接隐藏（动态页表现为
 *   "悬停/点击完全不显示"）。
 *   定稿口径（对齐 v1）：
 *     · `clear(reason='rebuild')` 什么都不做 —— 重建不碰交互 UI；
 *     · `consume` 只在**配置对象真的换了**（`cfg !== 上一次的 cfg`，即 applyConfig/boot
 *       产生的新对象）时才复核锚点 —— 这样"删词后收起重置"仍然生效（F13e③），
 *       而页面自身变动触发的限频重建不会干扰正在显示的提示。
 *     · 滚动/缩放不再隐藏，改为按命中实时矩形重定位（旧版 `repositionOnScroll` 口径）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const HOST_ID = 'kh-note-card';
  const TIP_ID = 'kh-note-tooltip';

  const STYLE = `
    :host { all: initial; }
    .kh-note-card {
      /* ★ 必须用 fixed（与旧版 v1.52.0 一致）：
         卡片在 ShadowRoot 内，宿主是 light DOM 的 div#kh-note-card。文档里的 #id 规则
         优先级高于 shadow 的 :host，一旦宿主被页面/遗留 CSS 设成定位元素，absolute 卡片
         就会改以宿主为包含块而被推到视口外（v2.0.0 实测 top≈975 / 视口 900，卡片可见性
         完全失效）。fixed 的包含块是视口，与宿主定位无关。
         注意：这段注释在 JS 模板字符串里，**不能出现反引号**（会提前闭合模板）。 */
      position: fixed; z-index: 2147483200; box-sizing: border-box;
      background: var(--kh-nc-bg, #ffffff); color: var(--kh-nc-fg, #333333);
      border: var(--kh-nc-bw, 1px) solid var(--kh-nc-bd, #cccccc);
      border-radius: var(--kh-nc-br, 8px);
      box-shadow: var(--kh-nc-shadow, 0 4px 12px rgba(0,0,0,0.15));
      max-width: var(--kh-nc-maxw, 320px); opacity: var(--kh-nc-op, .96);
      font-size: var(--kh-nc-fs, 14px); line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      padding: 10px 12px; word-break: break-word;
    }
    .kh-note-card[hidden] { display: none !important; }
    .kh-note-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .kh-note-kw {
      font-weight: 600; flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .kh-note-actions { display: flex; align-items: center; gap: 2px; flex: none; }
    .kh-note-copy, .kh-note-close {
      border: 0; background: transparent; cursor: pointer; color: inherit;
      opacity: .55; font-size: 14px; line-height: 1; padding: 0 2px;
    }
    .kh-note-copy { font-size: 13px; }
    .kh-note-copy:hover, .kh-note-close:hover { opacity: 1; }
    .kh-note-body { white-space: pre-line; }
    /* 卡片内容是 Markdown 渲染结果：与编辑器所见一致（旧版 v1.8.16+ 能力的页面侧） */
    .kh-note-body b, .kh-note-body strong { font-weight: 700; }
    .kh-note-body i, .kh-note-body em { font-style: italic; }
    .kh-note-body a { color: inherit; text-decoration: underline; cursor: pointer; }
    .kh-note-body img {
      max-width: var(--kh-img-size, 70px); max-height: var(--kh-img-size, 70px);
      border-radius: 4px; vertical-align: middle;
    }
    .kh-note-body .kh-table { border-collapse: collapse; margin: 4px 0; }
    .kh-note-body .kh-table td {
      border: 1px solid var(--kh-nc-bd, #cccccc); padding: 2px 7px;
      white-space: pre-line; text-align: left; vertical-align: middle;
    }
    /* 抓取表格没有表头行：只给字段 label 格上色（首行是数据，不是表头） */
    .kh-note-body .kh-table .kh-table-label { background: var(--kh-brand-soft, #eaf1fb); font-weight: 600; }
  `;

  /* ---------------- 命中身份与几何（重建后仍能找回同一条命中） ----------------
   * 重建会清表重建，`hit` 对象会换成新的，所以卡片不能长期抓住旧对象：
   * 记下 `{ruleId, textNode, start, end}` 这个稳定身份，需要时回注册表取当前那条。
   * 取几何只用 `registry` + `document.createRange()`（纯区间几何），
   * 不做任何 class/属性反查 —— 不违反铁律 3。 */
  function hitKeyOf(hit) {
    if (!hit) return null;
    return { ruleId: hit.ruleId, textNode: hit.textNode, start: hit.start, end: hit.end };
  }

  function sameHitKey(a, b) {
    return !!a && !!b &&
      a.ruleId === b.ruleId && a.textNode === b.textNode &&
      a.start === b.start && a.end === b.end;
  }

  /* 批次九死代码扫描删除了 `findHit(key)`（按 ruleId+区间在注册表里回找命中的包装）——
   * 全库零调用；卡片只走 `hitKeyOf` / `sameHitKey` 做比对，不再回查注册表。 */

  /** 命中当前的**视口**矩形；节点已脱离文档或区间失效时返回 null */
  function currentRect(key) {
    if (!key || !key.textNode || !key.textNode.isConnected) return null;
    const len = key.textNode.nodeValue ? key.textNode.nodeValue.length : 0;
    if (key.start >= len) return null;
    try {
      const range = document.createRange();
      range.setStart(key.textNode, key.start);
      range.setEnd(key.textNode, Math.min(key.end, len));
      const rc = range.getBoundingClientRect();
      return (rc.width || rc.height) ? rc : null;
    } catch (err) {
      return null;   // 区间越界等异常：当作"找不到"
    }
  }

  /* ---------------- 悬停备注 tooltip（旧版 v1.10.17 完整对等移植） ----------------
   * CSS Highlight 无 DOM 节点可挂原生 title，旧版自制轻量悬浮：mousemove 节流 60ms →
   * 坐标命中 → 有备注才显示（只显示备注内容，不显示关键词）；移出/滚动即隐。
   * pointer-events:none —— tooltip 不拦截鼠标，避免影响后续命中判断。 */
  const tip = {
    host: null,
    box: null,
    _timer: null,
    _pos: null,

    ensure() {
      if (this.host && this.host.isConnected) return this.host;
      const host = document.createElement('div');
      host.id = TIP_ID;
      host.setAttribute('data-kh-ext-ui', '1');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>' +
        ':host { all: initial; pointer-events: none; }\n' +
        '.kh-tip {\n' +
        '  position: fixed; z-index: 2147483647; pointer-events: none;\n' +
        '  background: #ffffff; color: #333; padding: 8px 12px; border-radius: 8px;\n' +
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;\n' +
        '  font-size: 13px; line-height: 1.5; max-width: 320px; word-break: break-word;\n' +
        '  box-shadow: 0 4px 14px rgba(0,0,0,.14); border: 1px solid rgba(0,0,0,.08);\n' +
        '  opacity: 0; transition: opacity .12s ease; white-space: pre-line;\n' +
        '}\n' +
        '.kh-tip.kh-tip-show { opacity: 1; }\n' +
        '.kh-tip b, .kh-tip strong { font-weight: 700; }\n' +
        '.kh-tip i, .kh-tip em { font-style: italic; }\n' +
        '.kh-tip a { color: #4a6fa5; text-decoration: underline; cursor: pointer; }\n' +
        '.kh-tip img { max-width: 70px; max-height: 70px; border-radius: 4px; vertical-align: middle; }\n' +
        '.kh-tip .kh-table { border-collapse: collapse; margin-top: 2px; background: transparent; }\n' +
        '.kh-tip .kh-table td { background: rgba(0,0,0,.04); color: #333; border-color: rgba(0,0,0,.1); padding: 2px 7px; white-space: pre-line; }\n' +
        '.kh-tip .kh-table .kh-table-label { background: var(--kh-brand-soft, #eaf1fb); font-weight: 600; }\n' +
        '</style>' +
        '<div class="kh-tip" hidden></div>';
      document.body.appendChild(host);
      this.host = host;
      this.box = shadow.querySelector('.kh-tip');
      return host;
    },

    show(note, x, y) {
      this.ensure();
      this._anchor = { x, y };   // 锚点：重建后 consume 复核用（见 features 注册处）
      this.box.textContent = '';
      this.box.appendChild(KH.Markdown.toFragment(note || '', document));
      this.box.hidden = false;
      const tw = this.box.offsetWidth || 200, th = this.box.offsetHeight || 40;
      let left = x + 14, top = y + 14;
      if (left + tw > window.innerWidth - 8) left = x - tw - 14;
      if (top + th > window.innerHeight - 8) top = y - th - 14;
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      this.box.style.left = left + 'px';
      this.box.style.top = top + 'px';
      requestAnimationFrame(() => { if (this.box) this.box.classList.add('kh-tip-show'); });
    },

    hide() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; this._pos = null; }
      if (this.box) {
        this.box.classList.remove('kh-tip-show');
        this.box.hidden = true;
      }
    },

    get visible() { return !!(this.box && !this.box.hidden); },

    destroy() {
      this.hide();
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null; this.box = null;
    }
  };

  const card = {
    host: null,
    root: null,
    _bound: false,
    /** 点击时的视口坐标（consume 复核用） */
    _anchor: null,
    /** 命中身份（滚动跟随 + 重复点击取消固定用） */
    _hitKey: null,
    /** 备注纯文本（复制按钮用） */
    _noteText: '',
    /** 最近一次鼠标位置（Enter 打开备注用） */
    _lastHover: null,

    ensure() {
      if (this.host && this.host.isConnected) return this.host;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-kh-ext-ui', '1');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>' + STYLE + '</style>' +
        '<div class="kh-note-card" hidden>' +
          '<div class="kh-note-head">' +
            '<span class="kh-note-kw"></span>' +
            '<div class="kh-note-actions">' +
              '<button class="kh-note-copy" title="复制备注">📋</button>' +
              '<button class="kh-note-close" title="关闭">×</button>' +
            '</div>' +
          '</div>' +
          '<div class="kh-note-body"></div>' +
        '</div>';
      document.body.appendChild(host);

      this.host = host;
      this.box = shadow.querySelector('.kh-note-card');
      this.kwEl = shadow.querySelector('.kh-note-kw');
      this.bodyEl = shadow.querySelector('.kh-note-body');
      this.copyEl = shadow.querySelector('.kh-note-copy');
      shadow.querySelector('.kh-note-close').addEventListener('click', () => this.hide());
      this.copyEl.addEventListener('click', () => this.copyNote());
      return host;
    },

    applyStyle(cfg) {
      const s = (cfg && cfg.noteCardStyle) || {};
      const set = (k, v) => { if (v !== undefined && v !== null && v !== '') this.host.style.setProperty(k, String(v)); };
      set('--kh-nc-bg', s.bgColor);
      set('--kh-nc-fg', s.textColor);
      set('--kh-nc-bd', s.borderColor);
      set('--kh-nc-bw', s.borderWidth);
      set('--kh-nc-br', s.borderRadius);
      set('--kh-nc-shadow', s.shadow);
      set('--kh-nc-maxw', s.maxWidth);
      set('--kh-nc-op', s.opacity);
      set('--kh-nc-fs', s.fontSize);
    },

    /** 按一个**视口**矩形摆放卡片（卡片是 position:fixed，坐标就是视口坐标） */
    placeAt(rect) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = this.box.getBoundingClientRect();
      const w = r.width || 220, h = r.height || 60;
      let left = rect.left + 12;
      let top = rect.bottom + 8;
      if (left + w > vw - 8) left = Math.max(8, rect.right - w);
      if (top + h > vh - 8) top = Math.max(8, rect.top - h - 8);
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      this.box.style.left = left + 'px';
      this.box.style.top = top + 'px';
    },

    show(hit, x, y, cfg) {
      this.ensure();
      this._anchor = { x, y };
      this._hitKey = hitKeyOf(hit);
      if (cfg) this.applyStyle(cfg);
      this.kwEl.textContent = (hit && (hit.meta.display || hit.meta.text)) || '备注';
      // 备注同样支持 Markdown（与重要笔记同一套语法/安全单源 KH.Markdown）
      this.bodyEl.textContent = '';
      this.bodyEl.appendChild(KH.Markdown.toFragment((hit && hit.meta && hit.meta.note) || '', document));
      this._noteText = (this.bodyEl.textContent || '').trim();
      if (this.copyEl) this.copyEl.textContent = '📋';
      this.box.hidden = false;

      // 优先锚在命中词上；拿不到矩形才退回点击点（旧版是按命中矩形摆的）
      const rc = currentRect(this._hitKey);
      this.placeAt(rc || { left: x, right: x, top: y, bottom: y });
    },

    /** 复制备注（旧版 v1.10.17 的 📋 按钮行为） */
    async copyNote() {
      const text = this._noteText || '';
      if (!text) return;
      let ok = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        ok = false;
        // 回退：内容脚本里 clipboard API 可能被拒（无焦点/无权限）→ 临时 textarea + execCommand
        try {
          const ta = document.createElement('textarea');
          ta.setAttribute('data-kh-ext-ui', '1');   // 自身 UI 标记：不被扫描、不被观察器当页面变化
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch (err2) {
          console.warn('[KH] 复制备注失败:', err2);
        }
      }
      if (!this.copyEl) return;
      this.copyEl.textContent = ok ? '✅' : '📋';
      if (ok) setTimeout(() => { if (this.copyEl) this.copyEl.textContent = '📋'; }, 1500);
    },

    hide() {
      if (this.box) this.box.hidden = true;
    },

    get visible() { return !!(this.box && !this.box.hidden); },

    destroy() {
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null; this.box = null; this.kwEl = null; this.bodyEl = null; this.copyEl = null;
      this._hitKey = null; this._anchor = null; this._noteText = '';
      tip.destroy();
    },

    /** 安装交互监听（唯一实现；重复调用无副作用）
     *  ★ 监听一律挂**捕获阶段**（capture:true）：捕获从 document 顶向下先于页面自身的
     *  冒泡处理器执行，页面在行/卡片上 stopPropagation() 也挡不住我们拿坐标 ——
     *  冒泡阶段监听在真实站点上会被大量拦截（v2.0.0 实测：备注悬停/点击在真实页面失效）。 */
    bind(configRef) {
      if (this._bound) return;
      this._bound = true;

      /* ---- 指针来源追踪：click 必须"起于页面内容"才算数 ----
       * 为什么需要（真浏览器复现出来的 bug）：
       *   拖动「重要笔记」面板到浏览器边界后松开，浏览器会把 click 派发到
       *   **pointerdown 与 pointerup 两个目标的共同祖先**上 —— pointerdown 在面板（插件自身 UI）里、
       *   pointerup 在页面内容上，于是 click 落在 `<html>`/`<body>` 上，坐标却是松手处。
       *   而 v2 的高亮是纯 CSS Highlight（无 DOM 节点），命中判定只能**按坐标**（`hitAtPoint`），
       *   于是这次"补发的 click"被当成了命中点击 → 边界处冒出固定备注卡片。
       *   （v1.52.0 用 `e.target.closest('[data-kh-highlighted]')` 判定，target 是 <html> 自然不命中，
       *    所以这是 v2 换成坐标判据后引入的回归。）
       * 修法：记下最近一次 pointerdown 的来源，click 时若不是"从页面内容按下"，一律不当作命中点击。
       * 顺带：拖动自身 UI 期间不弹悬停提示（`pressed && downOwn`）。 */
      let downOwn = false;    // 最近一次 pointerdown 是否落在插件自身 UI 上
      let pressed = false;    // 指针当前是否按下
      document.addEventListener('pointerdown', (e) => {
        pressed = true;
        const t = e.target;
        downOwn = !!(t && KH.Scanner && KH.Scanner.isOwnUI(t));
      }, true);
      document.addEventListener('pointerup', () => { pressed = false; }, true);
      document.addEventListener('pointercancel', () => { pressed = false; }, true);

      document.addEventListener('click', (e) => {
        const t = e.target;
        // 插件自身 UI 内的点击不参与（避免点面板/卡片自己触发定位）。
        // 统一走 `Scanner.isOwnUI` —— 全工程"这是不是我们自己的 UI"只有这一个实现，
        // **不要**在这里写 `closest('[data-kh-ext-ui]')`：那是 DOM 属性反查，
        // 会踩到"定位唯一入口"红线（UN-12 静态检查专门抓这个模式）。
        if (t && KH.Scanner && KH.Scanner.isOwnUI(t)) { tip.hide(); return; }
        // 拖动过自身 UI 之后浏览器补发的那次 click：target 不是我们的 UI，但按下点在我们的 UI 里 → 不算命中点击
        if (downOwn) { tip.hide(); return; }

        // 唯一入口 KH.hitAtPoint：caret 回退链 + 几何命中都在内核里（含浮层遮住文字的场景）
        const hit = KH.hitAtPoint(e.clientX, e.clientY);
        const note = hit && hit.meta && hit.meta.note;
        if (!note) { this.hide(); tip.hide(); return; }

        // 再次点击同一处命中 → 取消固定（旧版 v1.52.0 口径）
        if (this.visible && sameHitKey(this._hitKey, hitKeyOf(hit))) {
          this.hide(); tip.hide(); return;
        }

        tip.hide();                                 // 弹固定卡片时收起悬停提示（旧版同口径）
        this.show(hit, e.clientX, e.clientY, configRef && configRef());
      }, true);

      /* ---- 悬停备注 tooltip（v1.10.17）：移入命中点显示，移出隐藏；setTimeout 节流 ---- */
      document.addEventListener('mousemove', (e) => {
        const t = e.target;
        if (t && KH.Scanner && KH.Scanner.isOwnUI(t)) { tip.hide(); return; }
        // 正在拖动插件自身 UI（如重要笔记面板）：不弹悬停提示，否则会跟着指针一路闪
        if (pressed && downOwn) { tip.hide(); return; }
        // Enter 打开备注要用"最近一次悬停点"，所以这里**无条件**记录（不受节流影响）
        this._lastHover = { x: e.clientX, y: e.clientY };
        tip._pos = { x: e.clientX, y: e.clientY };
        if (tip._timer) return;
        tip._timer = setTimeout(() => {
          tip._timer = null;
          const p = tip._pos;
          tip._pos = null;
          if (!p) return;
          const hit = KH.hitAtPoint(p.x, p.y);
          const note = hit && hit.meta && hit.meta.note;
          if (note && !this.visible) tip.show(note, p.x, p.y);
          else tip.hide();
        }, 60);
      }, true);
      document.addEventListener('mouseleave', () => tip.hide(), false);

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.hide(); return; }
        // 旧版 v1.52.0：Enter 打开当前命中的备注。v2 的高亮是纯 CSS Highlight（无 DOM 节点），
        // 无法像旧版那样用 `document.activeElement.closest('[data-kh-highlighted]')` 定位，
        // 改用"最近一次悬停点"作为锚 —— 对键盘用户等价可用。
        if (e.key === 'Enter' && !this.visible && this._lastHover) {
          // 不劫持页面输入：在输入框/可编辑区里按 Enter 属于用户正常输入
          const t = e.target;
          if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
          const hit = KH.hitAtPoint(this._lastHover.x, this._lastHover.y);
          const note = hit && hit.meta && hit.meta.note;
          if (note) { tip.hide(); this.show(hit, this._lastHover.x, this._lastHover.y, configRef && configRef()); }
        }
      }, true);

      /* ---- 滚动/缩放：**不隐藏**，按命中实时矩形重新摆放（旧版 repositionOnScroll 口径） ----
       * 旧版 v1.52.0 只在 mouseleave（tooltip）与命中消失时收起；重构时加严成"滚动即隐"，
       * 在动态页面上会因为任意内层元素滚动而误杀刚弹出的提示 —— 这里退回旧版口径。 */
      let rafPending = false;
      const onViewportChange = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (this.visible) {
            const rc = currentRect(this._hitKey);
            if (rc) this.placeAt(rc);
            else this.hide();                 // 命中真的没了（词被删/节点被换）→ 收起，不残留
          }
          if (tip.visible && tip._anchor) {
            const hit = KH.hitAtPoint(tip._anchor.x, tip._anchor.y);
            if (!(hit && hit.meta && hit.meta.note)) tip.hide();
          }
        });
      };
      window.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange);
    }
  };

  if (KH.features) {
    KH.features.register('note-card', {
      /** 消费 + 重建后存活复核。
       *  ★ 历史教训（v2.0.0 百度页实测）：clear(rebuild) 曾无条件 hide tooltip/卡片 ——
       *  百度这类持续变动 DOM 的真实页面（懒加载/悬停预取/推荐流）每次变动都触发限频重建，
       *  刚弹出的悬停提示/卡片在几十毫秒内就被隐藏，用户看到的就是"完全不显示"。
       *  旧版 v1.52.0 的 tooltip 只在 mouseleave 隐藏，从不因重建隐藏 —— 这里对齐旧版：
       *  重建清底**不**隐藏交互 UI，且**只有配置真的变了**才做存活复核
       *  （`cfg` 每次 applyConfig/boot 都是新对象，页面自身变动重建时引用不变）。 */
      consume(hits, cfg) {
        card.bind(() => cfg);
        // 配置未变 → 这是页面自身变动触发的重建，不要碰正在显示的交互 UI
        if (card._lastCfg === cfg) return;
        card._lastCfg = cfg;
        if (tip.visible && tip._anchor) {
          const hit = KH.hitAtPoint(tip._anchor.x, tip._anchor.y);
          if (!(hit && hit.meta && hit.meta.note)) tip.hide();
        }
        if (card.visible && card._anchor) {
          const hit = KH.hitAtPoint(card._anchor.x, card._anchor.y);
          if (!(hit && hit.meta && hit.meta.note)) card.hide();
        }
      },
      clear(root, opts) {
        const reason = (opts && opts.reason) || 'rebuild';
        // 只有"彻底下线"才拆除交互 UI；重建（含局部清理）一律不动它 —— 与旧版零耦合口径一致
        if (reason === 'destroy') card.destroy();
      }
    });
  }

  KH.NoteCard = card;
})();
