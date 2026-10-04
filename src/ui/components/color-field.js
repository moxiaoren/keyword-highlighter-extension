/* ============================================================================
 * src/ui/components/color-field.js · 颜色选择控件（三端共用）
 * ----------------------------------------------------------------------------
 * 语义要点（旧版即有，不得回退）：
 *   · **空值 = 继承**，不是黑色。关键词底色留空时会回退到"分组色 > 全局默认色"
 *     （解析在 core/compiler.js 的 resolveVisual，是唯一一处）。所以这里必须提供
 *     「清除」而不是"必须选一个颜色"，否则用户永远无法表达"继承"。
 *
 * 色板（用户 2026-09 实测要求：**可选颜色太少、字体颜色连黑色都没有**）：
 *   · 20 色 = **5 列 × 4 行**，每行一个用途，顺序即用途：
 *       ① 中性：黑 / 深灰 / 灰 / 浅灰 / 白  —— 文字色最基础的一档（黑色是必备）
 *       ② ③ 主色（深/艳）：红橙黄绿青 / 蓝靛紫玫红棕 —— 文字色与深底色都能用
 *       ④ 浅色底：浅红橙黄绿蓝底 —— 高亮底色的主用途，配黑字可读
 *     旧色板 15 色全是中/浅色：**没有黑也没有白**（深底色配不出可读文字），
 *     且 `#ffcc00 / #34c759 / #00c7be / #4a90d9` 这类亮色**当文字色根本看不清** —— 已按
 *     "同色相加深"替换（见 tests/E2E-REPORT.md 的对照表）。
 *   · 色板数据放在 JS 里是刻意的：meta-check 管的是"样式文件不得写裸色值"，
 *     而色板是**数据**不是样式；真正的样式一律写 var(--token)。
 *
 * 取色器（用户要求"在下方增加一个颜色条，可以拖动选颜色"）：
 *   · **只做一条"色相条"是不够的** —— 色相条上没有黑 / 白 / 灰，而"选不到黑色"正是用户提的问题。
 *     所以做成完整取色器：**浓淡明暗区（拖 = 同色相的饱和/明度）+ 色相条（拖 = 换色相）**，
 *     两者都能拖；另配十六进制输入框（粘贴设计稿色值）与系统取色器（吸管）。
 *   · 拖动用 pointer 事件 + `setPointerCapture`：拖出浮层也不会丢指针。
 *
 * 回调契约（**拖动必须区分预览与确定**，否则表格里一拖就关浮层、还会一次拖动写几十次 storage）：
 *   · `onInput(v)`  —— 拖动/输入过程中的**实时预览**（可选，可能高频）
 *   · `onChange(v)` —— **确定的**改色：点色板 / 拖完松手 / 清除 / 色值输入回车 / 系统取色器关闭
 *
 * 【三块拼装】弹窗要"色块 + 点开选色"，表格要"胶囊 + 点开选色"：
 *   `panel()`  —— 浮层内容（色板 + 取色器 + 色值 + 清除），唯一一份；
 *   `chip()`   —— 只有色点与文案的胶囊按钮（表格用，**不自带浮层**）；
 *   `create()` —— 弹窗里的完整控件（色块/胶囊 + 浮层）。
 *
 * 【为什么浮层走 `KH.ui.Popover`】它是**单例**：打开新的会自动关掉旧的，
 * 关闭时把 mousedown / keydown / scroll / resize 四个监听一起摘掉。
 * 旧实现每个 ColorField 实例自己 `document.addEventListener('mousedown', …)` 且从不解绑 ——
 * 弹窗每开一次就多两个永久监听；表格一页 50 行 × 2 个颜色 = 100 个，且每次重绘还在累加。
 * 浮层挂在 body 上（不是控件内部），也顺带解决了"弹窗内容区 overflow:auto 会把浮层裁掉"。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;
  const Pop = () => ui.Popover;

  /** 色板（唯一真源）：4 行 × 5 列。`name` 只进 tooltip，不参与逻辑 */
  const PALETTE = [
    /* ① 中性 —— 文字色必备（旧色板缺黑/白）。
     * 这 5 个是**真灰**（r=g=b），单测直接锁"第 1 行必须是中性色"。 */
    { color: '#000000', name: '黑色' },
    { color: '#4d4d4d', name: '深灰' },
    { color: '#999999', name: '灰色' },
    { color: '#d9d9d9', name: '浅灰' },
    { color: '#ffffff', name: '白色' },
    /* ② 主色 · 深/艳（文字色、深底色都能用） */
    { color: '#e53935', name: '红色' },
    { color: '#ff9500', name: '橙色（插件默认底色）' },
    { color: '#f9a825', name: '黄色' },
    { color: '#43a047', name: '绿色' },
    { color: '#00acc1', name: '青色' },
    /* ③ 主色 · 深/艳（续） */
    { color: '#1e88e5', name: '蓝色' },
    { color: '#3949ab', name: '靛蓝' },
    { color: '#8e24aa', name: '紫色' },
    { color: '#d81b60', name: '玫红' },
    { color: '#6d4c41', name: '棕色' },
    /* ④ 浅色底（高亮底色主用途，配黑字可读） */
    { color: '#ffcdd2', name: '浅红底' },
    { color: '#ffe0b2', name: '浅橙底' },
    { color: '#fff9c4', name: '浅黄底' },
    { color: '#c8e6c9', name: '浅绿底' },
    { color: '#bbdefb', name: '浅蓝底' }
  ];

  /** 色板列数（5 列 × 4 行 = 20）——UI 与测试都从这里取，别各写一份数字 */
  const PALETTE_COLUMNS = 5;

  /** 十六进制色值（3 位或 6 位） */
  const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  /** 未设色时取色器的起始色 = 插件默认底色 */
  const DEFAULT_COLOR = '#ff9500';

  const norm = (v) => {
    const s = String(v == null ? '' : v).trim();
    return HEX.test(s) ? s.toLowerCase() : '';
  };

  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const to2 = (n) => { const v = Math.round(Math.min(255, Math.max(0, n))); return (v < 16 ? '0' : '') + v.toString(16); };

  function hexToRgb(hex) {
    const v = norm(hex) || '#000000';
    let s = v.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) { return '#' + to2(r) + to2(g) + to2(b); }
  function rgbToHsv(r, g, b) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    let h = 0;
    if (d) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb(h, s, v) {
    const H = ((h % 360) + 360) % 360, S = clamp01(s), V = clamp01(v);
    const c = V * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = V - c;
    let r = 0, g = 0, b = 0;
    if (H < 60) { r = c; g = x; } else if (H < 120) { r = x; g = c; }
    else if (H < 180) { g = c; b = x; } else if (H < 240) { g = x; b = c; }
    else if (H < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  const hex2hsv = (hex) => { const c = hexToRgb(hex); return rgbToHsv(c.r, c.g, c.b); };
  const hsv2hex = (h, s, v) => { const c = hsvToRgb(h, s, v); return rgbToHex(c.r, c.g, c.b); };

  /**
   * 浮层内容（唯一一份）。
   *
   * 交互口径（v1.99.99.11 按用户实测改）：
   *   · **选中 ≠ 生效**：色板 / 取色器 / 色值输入 / 系统取色器这**四条入口统一**只改「草稿」，
   *     必须点「确定」（或在色值框里回车）才落库；点「取消」/按 Esc / 点浮层外 → 草稿丢弃、还原原值。
   *     用户原话："拖动后松开立刻生效，这不符合操作习惯，加一个确认修改的步骤或按钮"；
   *     并且明确让我们判断"直接点击颜色"要不要一起统一 —— 统一（四条入口行为一致才好预期，
   *     否则"点色板立即生效、拖动要确认"会让人不确定当前到底生效没有）。
   *   · `onInput(v)`  = 草稿变化的实时预览（可选；调用方只应做轻量视觉更新，**不要落库**）
   *   · `onChange(v)` = 点「确定」后的落库（合法 hex，或 `''` 表示清除＝继承）
   *   · `onDone()`    = 结束（确定 / 取消都要关掉浮层），由调用方关；关闭时调用方还需把预览还原成已生效值
   */
  function panel(opts) {
    const o = opts || {};
    const h = D().h;
    const allowEmpty = o.allowEmpty !== false;
    const original = norm(o.value);          // 已生效的值（'' = 继承）
    let pending = null;                      // null = 未改动；'' = 要清除；否则是 hex
    /* 取色器从"已生效值 / 继承来的有效色 / 插件默认色"起步 */
    let cur = hex2hsv(original || norm(o.fallback) || DEFAULT_COLOR);

    const peek = (v) => { if (typeof o.onInput === 'function') o.onInput(v); };
    const nowHex = () => hsv2hex(cur.h, cur.s, cur.v);
    /** 改草稿：只预览，不落库 */
    const draft = (v) => {
      pending = norm(v);
      render();
      peek(pending);
    };
    /** 取消：丢弃草稿，并把预览还原成已生效值 */
    const cancel = () => {
      pending = null;
      cur = hex2hsv(original || norm(o.fallback) || DEFAULT_COLOR);
      render();
      peek(original);
      if (typeof o.onDone === 'function') o.onDone();
    };
    /** 确定：草稿落库 */
    const commit = () => {
      if (pending === null) { if (typeof o.onDone === 'function') o.onDone(); return; }
      const v = pending;
      pending = null;
      if (typeof o.onChange === 'function') o.onChange(v);
      if (typeof o.onDone === 'function') o.onDone();
    };

    /* ---------------- ① 色板（5 列 × 4 行） ---------------- */
    const cells = PALETTE.map((x) => h('button', {
      class: 'kh-color-cell', type: 'button', title: x.name + ' · ' + x.color,
      'data-color': x.color, 'data-name': x.name,
      style: 'background:' + x.color,
      'aria-label': x.name,
      on: { click: () => { cur = hex2hsv(x.color); draft(x.color); } }
    }));
    const grid = h('div', { class: 'kh-color-grid' }, cells);

    /* ---------------- ② 取色器（浓淡明暗区 + 色相条，都可拖） ---------------- */
    const sv = h('div', {
      class: 'kh-color-sv', tabindex: '0', role: 'slider',
      'aria-label': '颜色浓淡与明暗（左右＝浓淡，上下＝明暗）', title: '拖动选色：左右＝浓淡，上下＝明暗'
    });
    const svDot = h('span', { class: 'kh-color-sv-dot' });
    sv.appendChild(svDot);
    const hue = h('div', {
      class: 'kh-color-hue', tabindex: '0', role: 'slider',
      'aria-label': '色相', title: '拖动选色相，也可用 ← →'
    });
    const hueDot = h('span', { class: 'kh-color-hue-dot' });
    hue.appendChild(hueDot);
    const picker = h('div', { class: 'kh-color-picker' }, [sv, hue]);

    /* ---------------- ③ 色值 / 系统取色器 / 清除 ---------------- */
    const hexInput = h('input', {
      class: 'kh-color-hex', type: 'text', value: original || DEFAULT_COLOR,
      maxlength: '7', spellcheck: 'false', autocomplete: 'off',
      title: '直接输入色值（如 #000000），回车＝确定', 'aria-label': '色值'
    });
    const native = h('input', {
      class: 'kh-color-input', type: 'color',
      value: original || DEFAULT_COLOR, title: '系统取色器（可用吸管）'
    });
    const clearBtn = allowEmpty
      ? h('button', { class: 'kh-color-clear', type: 'button', title: '清除（＝继承分组/全局默认色），点「确定」生效', text: '清除' })
      : null;
    if (clearBtn) clearBtn.addEventListener('click', () => draft(''));

    /* ---------------- ④ 草稿提示 + 取消 / 确定 ---------------- */
    const pendingDot = h('span', { class: 'kh-color-dot' });
    const pendingText = h('span', { class: 'kh-color-pending-t' });
    const pendingBox = h('span', { class: 'kh-color-pending' }, [pendingDot, pendingText]);
    const cancelBtn = h('button', { class: 'kh-color-btn', type: 'button', title: '放弃本次改动', text: '取消' });
    const okBtn = h('button', { class: 'kh-color-btn kh-color-ok', type: 'button', title: '确认修改', text: '确定' });
    cancelBtn.addEventListener('click', cancel);
    okBtn.addEventListener('click', commit);

    /** 把当前颜色同步到所有可见部件（改草稿/取消/确定都会调） */
    function render() {
      const hex = nowHex();
      const pure = hsv2hex(cur.h, 1, 1);
      sv.style.background = pure;                       // 底色＝当前色相的纯色，上面叠白/黑渐变（见 CSS）
      svDot.style.left = (cur.s * 100) + '%';
      svDot.style.top = ((1 - cur.v) * 100) + '%';
      svDot.style.background = hex;
      hueDot.style.left = (cur.h / 360 * 100) + '%';
      hueDot.style.background = pure;
      /* 正在输入色值时不要回写（会把光标顶到末尾） */
      if (document.activeElement !== hexInput) hexInput.value = hex;
      native.value = hex;
      /* 草稿提示：显示"当前选中的颜色"；`is-pending` 表示还没确定（此时「确定」可用） */
      const isPend = pending !== null;
      const shown = isPend ? pending : original;
      pendingDot.style.background = shown || '';
      pendingDot.classList.toggle('is-empty', !shown);
      pendingText.textContent = shown || '继承';
      pendingBox.classList.toggle('is-pending', isPend);
      pendingBox.title = isPend ? '已选（尚未生效）：点「确定」应用' : '当前生效的颜色';
      okBtn.disabled = !isPend;
      for (const c of cells) c.classList.toggle('is-on', !!shown && c.getAttribute('data-color') === shown);
    }

    /** 拖动：pointer 事件 + 指针捕获；拖动即改**草稿**（松手也不落库，等「确定」） */
    function drag(el, apply) {
      let on = false;
      /* 边缘吸附：贴着最边上的一点点距离就取到**极值**。
       * 没有这个的话，"拖到最底下"永远差半个像素 → 得到 #030103 而不是纯黑，
       * 用户想要的"纯黑/纯白"就仍然选不到（正是这次要修的问题）。 */
      const snap = (t) => (t < 0.015 ? 0 : (t > 0.985 ? 1 : t));
      const move = (e) => {
        const r = el.getBoundingClientRect();
        const x = snap(r.width ? clamp01((e.clientX - r.left) / r.width) : 0);
        const y = snap(r.height ? clamp01((e.clientY - r.top) / r.height) : 0);
        apply(x, y);
        draft(nowHex());
      };
      el.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;      // 只响应左键/触摸
        e.preventDefault();                                 // 别选中文字/拖出图片
        on = true;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获就靠 move 兜底 */ }
        el.focus();
        move(e);
      });
      el.addEventListener('pointermove', (e) => { if (on) { e.preventDefault(); move(e); } });
      const end = () => { on = false; };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
      /* 键盘可达：方向键微调（Shift 加速），同样是改草稿。阻止冒泡，免得被外层当成表格/弹窗导航 */
      el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        let used = true;
        if (e.key === 'ArrowLeft') apply(-step, 0);
        else if (e.key === 'ArrowRight') apply(step, 0);
        else if (e.key === 'ArrowUp') apply(0, -step);
        else if (e.key === 'ArrowDown') apply(0, step);
        else used = false;
        if (!used) return;
        e.preventDefault();
        e.stopPropagation();
        draft(nowHex());
      });
    }
    drag(sv, (x, y) => { cur.s = x; cur.v = 1 - y; });
    drag(hue, (x) => { cur.h = Math.round(x * 360) % 360; });

    /* 色值输入：合法即改草稿；回车＝确定 */
    hexInput.addEventListener('input', () => {
      const v = norm(hexInput.value);
      if (!v) return;
      cur = hex2hsv(v);
      draft(nowHex());
    });
    hexInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      commit();
    });
    hexInput.addEventListener('change', () => {
      const v = norm(hexInput.value);
      if (!v) { render(); return; }                        // 非法 → 还原显示
      cur = hex2hsv(v);
      draft(nowHex());
    });
    native.addEventListener('input', () => { cur = hex2hsv(native.value); draft(nowHex()); });
    native.addEventListener('change', () => { cur = hex2hsv(native.value); draft(nowHex()); });

    const out = h('div', { class: 'kh-color-panel' }, [
      grid,
      picker,
      h('div', { class: 'kh-color-ops' }, [hexInput, native, clearBtn]),
      h('div', { class: 'kh-color-actions' }, [pendingBox, cancelBtn, okBtn])
    ]);
    render();
    return out;
  }

  /**
   * 颜色**胶囊**（`● 底`）—— 只有视觉，不含浮层（表格里点开浮层由调用方接）。
   * @param {object} o { label, dot, on, title, id }
   *   label 胶囊文案；dot 色点显示的颜色（可以是"继承来的有效色"）；
   *   on 是否高亮（＝这个词自己设了颜色，而不是继承来的）
   * @returns {{el: HTMLElement, setValue: (v:string)=>void, setDot: (v:string)=>void}}
   */
  function chip(o) {
    const opt = o || {};
    const h = D().h;
    const el = h('button', {
      class: 'kh-color-swatch kh-fld-chip kh-color-chip',
      type: 'button', id: opt.id || null,
      title: opt.title || opt.label || '选择颜色'
    });
    const dot = h('span', { class: 'kh-color-dot' });
    el.appendChild(dot);
    el.appendChild(h('span', { class: 'kh-fld-chip-t', text: opt.label || '颜色' }));

    function paint(color, on) {
      const c = norm(color);
      dot.style.background = c || '';
      dot.classList.toggle('is-empty', !c);
      el.classList.toggle('is-on', !!on);
    }
    paint(opt.dot, opt.on);

    return {
      el,
      /** 设"自己设的颜色"（同时决定色点与 is-on） */
      setValue: (v) => { const c = norm(v); paint(c, !!c); },
      /** 只改色点（"继承来的有效色"），不动 is-on */
      setDot: (v) => { const c = norm(v); dot.style.background = c || ''; dot.classList.toggle('is-empty', !c); }
    };
  }

  /**
   * 弹窗里的完整控件：色块（或胶囊）+ 点开选色。
   * `id` 挂在**色块按钮**上（labelable）→ 弹窗里的 `<label for="fld-bgColor">` 点一下就能开浮层；
   * 也让"每个可读控件都有 `id=fld-<key>`"这条契约成立（外部按 id 逐字段定位/断言）。
   */
  function create(opts) {
    const o = opts || {};
    const h = D().h;
    const asChip = !!o.chip;
    let value = norm(o.value);

    let swatch;
    let setVisual;
    if (asChip) {
      const c = chip({ label: o.label || o.title || '颜色', id: o.id, dot: value, on: !!value, title: o.title });
      swatch = c.el;
      setVisual = c.setValue;
    } else {
      swatch = h('button', { class: 'kh-color-swatch', type: 'button', id: o.id || null, title: o.title || '选择颜色' });
      setVisual = (v) => {
        swatch.textContent = v || '继承';
        swatch.classList.toggle('is-empty', !v);
        swatch.style.background = v || '';
      };
    }
    const wrap = h('div', { class: 'kh-color-field' + (asChip ? ' kh-color-field-chip' : '') }, [swatch]);

    function set(v) {
      value = norm(v);
      setVisual(value);
      if (typeof o.onChange === 'function') o.onChange(value, wrap);
    }

    let popOpen = false;
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popOpen) { Pop().close(); return; }               // 再点一次收起
      popOpen = true;
      Pop().open(swatch, panel({
        value,
        fallback: o.fallback,
        allowEmpty: o.allowEmpty !== false,
        /* 草稿预览：只更新本控件自己的视觉（+ 调用方的 onInput），**不**触发 onChange。
         * 真正落库只发生在「确定」（onChange）。 */
        onInput: (v) => {
          setVisual(v);
          if (typeof o.onInput === 'function') o.onInput(v, wrap);
        },
        onChange: (v) => set(v),                              // 「确定」= 落库
        onDone: () => Pop().close()                           // 确定 / 取消都收浮层
      }), () => {
        popOpen = false;
        setVisual(value);                                     // 关掉浮层（含 Esc / 点外面）→ 预览还原成已生效值
      });
    });

    setVisual(value);
    wrap.getValue = () => value;
    wrap.setValue = (v) => { value = norm(v); setVisual(value); };   // silent：不触发 onChange
    return wrap;
  }

  ui.ColorField = {
    create, chip, panel, PALETTE, PALETTE_COLUMNS, HEX, DEFAULT_COLOR,
    /* 颜色换算（纯函数，单测直接锁）：hex ⇄ hsv / rgb */
    hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, hex2hsv, hsv2hex
  };
})();
