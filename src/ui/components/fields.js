/* ============================================================================
 * src/ui/components/fields.js · 表单字段控件工厂（**所有表单界面的唯一实现**）
 * ----------------------------------------------------------------------------
 * 为什么必须抽出来（用户 2026-09 明确要求）：
 *   本工程有多个"新增/编辑"表单 —— 关键词编辑弹窗、分组编辑弹窗、（后续还会有别的）。
 *   原先字段控件只在 keyword-editor.js 里实现，分组弹窗是手写的另一套 —— 于是关键词那边
 *   升级成"开关胶囊 / 颜色胶囊 / 行内字段"之后，分组那边还停在"勾选框 / 旧色块 / 标签一行+控件一行"。
 *   **靠人工同步必然漏**，所以把字段控件收敛成这一个工厂：改这里 = 所有表单一起变。
 *
 * 契约（关键词弹窗的自动化断言就是靠它）：
 *   · **每个可读控件都挂 `id="<idPrefix><key>"`，label 用 `for` 绑上去** ——
 *     否则保存往返没法逐字段断言、无障碍也绑不上、排查时不能在控制台直接取控件。
 *   · `read()` 只吐**一个** key 的值；两态开关（select + chip）也必须满足这条，
 *     否则调用方的 `out[c.key] = c.read()` 与 byKey 联动全要改。
 *
 * spec（字段声明）支持的键：
 *   key/label/type/width(2=整行)/inline/chip/short/hint/placeholder/required
 *   type: text | textarea | richtext | bool | int | select | color | labels | cands
 *   bool+chip  → 开关胶囊；color+chip → 颜色胶囊（文案用 short，完整名进 tooltip）
 *   select+chip+onValue/offValue → 两态开关胶囊
 *   int  → 常态**值胶囊**（点开才出数字框，见 `attachPop`）；cands → 常态**候选胶囊**
 *   cands+regexKey（兄弟开关的 key，如 `useRegex`）/ cands+regexAlways（恒为正则，如图片命中词）
 *     → 决定 `|` 是"或"（切胶囊）还是普通字符（整串一个胶囊）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;

  /**
   * @param {object} spec  字段声明
   * @param {*} value      初值
   * @param {object} ctx   { idPrefix='fld-', groups, imgSize, onChange(key, v) }
   * @returns {{el: HTMLElement, read: Function, key: string}}
   */
  function create(spec, value, ctx) {
    const c = ctx || {};
    const h = D().h;
    const id = (c.idPrefix || 'fld-') + spec.key;
    /** 半行/整行容器类（所有类型统一走这个，避免只有文本框认 `width`） */
    const fldCls = 'kh-fld' + (spec.width === 2 ? ' kh-fld-wide' : '');
    /* 【K71 口径 B】容器带 `title: spec.hint` —— 长解释从此**有地方住**：
     * 弹窗正文只留短句/短标签，完整语义进 tooltip。`h()` 对 null/false 直接跳过（dom.js:25），
     * 所以没有 hint 的字段不会写出一个空 title。 */
    const hintTitle = spec.hint || null;
    /** 标签 + 控件。`inline: true` 时两者**同一行**（如 `尺寸：[ ]`） */
    const fieldBox = (labelText, ctrl) => h('div', { class: fldCls + (spec.inline ? ' kh-fld-inline' : ''), title: hintTitle }, [
      h('label', { class: 'kh-fld-label', text: labelText, for: id }), ctrl
    ]);

    /**
     * 开关**胶囊**：与关键词表格「核心词 / 标题词匹配」列、悬停 tooltip、批量设置
     * 用的是同一套说法与同一套交互语言（见 chip.js PARTS）。状态只用颜色区分（无勾选框）。
     * 用 JS 切 `is-on` 而不是 CSS `:has(input:checked)` —— 旧内核不支持 `:has()`，会"点了没反馈"。
     */
    function chipEl(inputEl, label, hint, onCls) {
      const wrap = h('label', { class: 'kh-fld-chip', for: id, title: hint || label }, [
        inputEl, h('span', { class: 'kh-fld-chip-t', text: label })
      ]);
      const paint = () => wrap.classList.toggle('is-on', !!onCls());
      paint();
      inputEl.addEventListener('change', paint);
      wrap._paint = paint;
      return wrap;
    }

    /**
     * 【2.0.2.7 需求①②】「常态只显胶囊，点一下才出输入框」——把真输入框按需摆进浮层。
     *
     *   · 点锚点（值胶囊 / `+` 按钮）打开；**再点一下＝收起**（值随 `input` 事件实时生效，
     *     不存在"确定/取消"的语义歧义）；
     *   · 关闭时把框**移回 `host`**（字段自己的容器，CSS 常态 `display:none`）——
     *     这样 `getElementById('<id>')` 在浮层关着时也取得到，`read()` / 保存往返 / 自动化装置
     *     全都不受"节点只活在浮层里"的影响；
     *   · 每次输入都调 `paint()` 把值刷到胶囊上（浮层也可能被 Escape / 滚动 / 点别处关掉，
     *     不能只在关闭时才刷）；
     *   · 没有浮层实现时（理论上不会：`ui.Popover` 就在同一个 components 目录）就地摆出来 ——
     *     功能优先，样式其次。
     *
     * @param {HTMLElement} anchor  稳定锚点（**不要**传会被重画的节点：浮层要按它的 rect 定位）
     * @param {HTMLElement} inputEl 真输入框（id / read / 保存路径都挂在它身上）
     * @param {HTMLElement} host    关闭时框回落到哪
     * @param {Function} paint      值 → 胶囊文案
     * @param {Function} [before]   打开之前把状态就位（如"把这一段载回框里"）
     * @returns {Function} open(force) —— 供别的锚点复用（换一段编辑时强制重开）
     */
    function attachPop(anchor, inputEl, host, paint, before) {
      let openFor = null;   // 当前浮层是不是我这个锚点开的（关闭回调里清掉）
      const open = (force) => {
        if (!(ui.Popover && typeof ui.Popover.open === 'function')) {
          host.appendChild(inputEl);
          if (typeof inputEl.focus === 'function') inputEl.focus();
          return;
        }
        if (openFor === anchor) {
          if (!force) { ui.Popover.close(); return; }
          if (typeof inputEl.focus === 'function') inputEl.focus();
          return;
        }
        ui.Popover.open(anchor, inputEl, () => { openFor = null; host.appendChild(inputEl); }, { className: 'kh-pop-edit' });
        openFor = anchor;
        if (typeof inputEl.focus === 'function') inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();   // 打开即全选：直接打字就是替换
      };
      anchor.addEventListener('click', () => {
        if (typeof before === 'function') before();
        open();
      });
      inputEl.addEventListener('input', () => { if (typeof paint === 'function') paint(); });
      inputEl.addEventListener('keydown', (ev) => {
        if (!ev || ev.key !== 'Enter') return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof paint === 'function') paint();
        if (ui.Popover && typeof ui.Popover.close === 'function') ui.Popover.close();
      });
      return open;
    }

    switch (spec.type) {
      case 'bool': {
        const cb = h('input', { type: 'checkbox', checked: value ? true : null, id: id });
        cb.addEventListener('change', () => { if (c.onChange) c.onChange(spec.key, cb.checked); });
        if (spec.chip) return { el: chipEl(cb, spec.label, spec.hint, () => cb.checked), read: () => cb.checked, key: spec.key };
        return { el: h('div', { class: 'kh-fld-bool', title: hintTitle }, [cb, h('span', { class: 'kh-fld-bool-label', text: spec.label })]), read: () => cb.checked, key: spec.key };
      }
      case 'textarea': {
        const ed = ui.RichEditor.create({
          value: value,
          rows: spec.rows || 2,
          placeholder: spec.placeholder,
          id: id
        });
        /* 「预览」工具行**跟字段标题同一行**（右对齐），不自己占一行；
         * 工具行由 RichEditor 暴露（`ed.toolsRow`），这里只负责拼进标题行。 */
        const labelRow = h('div', { class: 'kh-fld-labelrow' }, [
          h('label', { class: 'kh-fld-label', text: spec.label, for: id }),
          ed.toolsRow || null
        ]);
        return { el: h('div', { class: fldCls }, [labelRow, ed]), read: () => ed.getValue(), key: spec.key };
      }
      case 'richtext': {
        // 所见即所得（图片/链接/加粗/斜体/表格）；编辑框里的图片大小跟随"图片缩略尺寸"（旧版 v1.8.17 口径）
        const ed = ui.RichEditor.create({
          value: value,
          wysiwyg: true,
          imgSize: c.imgSize || '',
          placeholder: spec.placeholder || '与页面显示一致：图片、加粗、表格、链接直接在框内显示',
          id: id
        });
        return { el: h('div', { class: fldCls }, [
          h('label', { class: 'kh-fld-label', text: spec.label, for: id }), ed
        ]), read: () => ed.getValue(), key: spec.key };
      }
      case 'color': {
        /* `chip: true` → 颜色控件自己就是胶囊（`● 底`），由外层按"胶囊行"排布；
         * 否则退回"标签 + 色块"的半行字段。
         * 胶囊文案用 `short`（单字）以塞进一行，`label`（完整名）进 tooltip。
         * `spec.onChange(v)` 会透传给 ColorField —— 批量弹窗靠它区分"没点过（不修改）"与"选了色"。 */
        const cf = ui.ColorField.create({
          value: value, title: spec.label, id: id,
          chip: !!spec.chip, label: spec.short || spec.label,
          onChange: typeof spec.onChange === 'function' ? spec.onChange : undefined
        });
        if (spec.chip) return { el: cf, read: () => cf.getValue(), key: spec.key };
        return { el: fieldBox(spec.label, cf), read: () => cf.getValue(), key: spec.key };
      }
      case 'select': {
        /** `chip` 的 select = **两态开关**（如 cellVerifyMatchMode：include ↔ exact）。 */
        if (spec.chip) {
          const onV = spec.onValue, offV = spec.offValue;
          const cb = h('input', { type: 'checkbox', id: id, checked: value === onV ? true : null });
          const el = chipEl(cb, spec.label, spec.hint, () => cb.checked);
          return { el: el, read: () => (cb.checked ? onV : offV), key: spec.key };
        }
        const sel = h('select', { class: 'kh-input', id: id });
        const options = spec.groupSource
          ? [h('option', { value: '', text: '（未分组）' })].concat((c.groups || []).map(g => h('option', { value: g.id, text: g.name || '(未命名)' })))
          : (spec.options || []).map(o2 => h('option', { value: o2.v, text: o2.t }));
        for (const op of options) sel.appendChild(op);
        sel.value = value == null ? '' : String(value);
        return { el: fieldBox(spec.label, sel), read: () => (spec.groupSource ? (sel.value || null) : sel.value), key: spec.key };
      }
      case 'int': {
        /* min/max/step 改为**字段可覆盖**（原来写死 40–600，那是 imgSize 的量纲）——
         * `noteFontSize`（正文字号）与 `imgOcrMax`（张数）共用这一条分支，写死的范围只会误导。
         * 不声明就沿用老值，既有字段渲染出的 DOM 一字不变。
         * 【2.0.2.7】值可以是**函数**（`fieldmap.js` 里的尺寸/字号就是这么写的）：范围只有一处真源
         * （`KH.Config` 的常量），而那张字段表在脚本加载期就构造、那时 Config 未必就位 ⇒ 惰性取。 */
        const bound = (v, fallback) => { const n = typeof v === 'function' ? v() : v; return n == null ? fallback : String(n); };
        const inp = h('input', {
          class: 'kh-input', type: 'number', id: id,
          min: bound(spec.min, '40'),
          max: bound(spec.max, '600'),
          step: bound(spec.step, '1'),
          /* C5：原来硬编码「留空＝用全局默认尺寸」—— 但 `#fld-imgOcrMax`（每处最多＝**张数**）
           * 走的是同一条分支，提示写错了对象。改为优先用字段自己的 hint。 */
          title: spec.hint || '留空＝用全局默认', value: value === '' || value == null ? '' : String(value),
          placeholder: spec.inline ? '默认' : '留空＝默认'
        });
        /* 【2.0.2.7 需求②】常态只显**值胶囊**（当前设成几＝一眼可见），点它才在浮层里出数字框：
         * "标签一行 + 输入框一行"是弹窗里最占地方的一类字段，而它多数时候只是被看一眼。
         * 输入框本体（`#fld-imgSize` 这类 id / `type=number` / `coerce` 口径）一个字不改 ——
         * 装置与保存路径都直接取它，它只是**搬了家**：空闲时回到 `host` 里藏着。 */
        const shown = () => (String(inp.value) === '' ? '默认' : String(inp.value));
        const chip = labelChip({ name: shown(), chipTitle: '点一下改「' + spec.label + '」' });
        const nameEl = chip.querySelector('.kh-lbl-name');   // 复用唯一那份胶囊实现，只换它的文案
        const host = h('div', { class: 'kh-num-box' }, [chip]);
        const box = fieldBox(spec.label, host);
        host.appendChild(inp);
        attachPop(chip, inp, host, () => { if (nameEl) nameEl.textContent = shown(); });
        return { el: box, read: () => KH.FieldMap.coerce(spec, inp.value), key: spec.key };
      }
      /* 【2.0.2.4 需求④ + 2.0.2.6 升级】「字段」专用控件：**可编辑的胶囊列表** + 一行后缀图例。
       * 为什么要预览：`!`/`%`/`^` 早就实现了却零提示（只出现在更新日志里），用户看不出自己写的那串
       * 被认成了什么。这里把「原文 → 逐段解析结果」当场摊开：每段一个胶囊（名字 + 后缀徽标），
       * `✕` 删掉那一段。
       * 【2.0.2.6 升级】输入框只承载**正在录/正在改的那一段**：回车把它收成胶囊（框随之为空，
       * 接着录下一段；用户口径："字段配置输入显示胶囊之后，输入框可以不保留内容"），点胶囊把那一
       * 段的原文载回框里改。已确定的段存在 `raw` 里 —— 没有待定内容时 `read()` **逐字返回 `raw`**
       * （与旧实现同值），有待定内容时也会把它带上（没回车就直接保存不会丢数据）。
       * 解析走 `KH.Fetch` 的同一份语法（见 `labelSegs`），不养第二套。
       * 存储契约一个字没变：`read()` 仍是**整串原文**（CSV 仍第 17 列、分隔符由 storage 归一）。 */
      case 'labels': {
        const inp = h('input', { class: 'kh-input', type: 'text', id: id, value: '', placeholder: spec.placeholder });
        const prev = h('div', { class: 'kh-lbl-preview' });
        const legend = h('div', {
          class: 'kh-lbl-legend',
          text: '后缀：#1 右邻一格 / #图 仅图片 / #3 最多 3 张 / #图3 仅图片且最多 3 张 / #0 该字段不要图 / @2 值格 / ! 去空白 / ^锚文本 只取锚点之前 / %4 前 4 字；'
            + '一次写多个字段用 | 或 ｜（例：名称^[复制]|备注#图）；回车把这一段收成胶囊，点胶囊改那一段'
        });
        const box = h('div', { class: fldCls, title: hintTitle }, [
          h('label', { class: 'kh-fld-label', text: spec.label + (spec.required ? ' *' : ''), for: id }),
          inp, prev, legend
        ]);
        let raw = value == null ? '' : String(value);   // 已确定的整串（初值即存量值）
        let editIdx = -1;                               // ≥0 = 正在改第几段（下标按 `parts()`）
        const split = (s) => ((KH.Fetch && typeof KH.Fetch.splitLabelTokens === 'function') ? KH.Fetch.splitLabelTokens(s) : [String(s)]);
        const parts = () => (String(raw).length ? split(raw) : []);
        const pending = () => (String(inp.value).length ? split(inp.value) : []);
        /** 当前"会存下去"的整串：没有待定/编辑 ⇒ 原样返回 `raw`（一个字都不动）。 */
        const displayRaw = () => {
          const t = pending();
          if (editIdx < 0 && !t.length) return raw;
          const list = parts();
          if (editIdx >= 0) list.splice(editIdx, 1, ...t);
          else for (const one of t) list.push(one);
          return list.join('|');
        };
        /** 把待定内容收进 `raw` 并清空输入框（回车、点胶囊、✕ 之前都先落一下，段序号才稳定）。 */
        const commit = () => { raw = displayRaw(); editIdx = -1; inp.value = ''; };
        const notify = () => {
          /* 让外层（弹窗的"改动过"标记等）也收到一次改动通知；调度器不支持就算了 */
          try { if (typeof inp.dispatchEvent === 'function') inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* 无 Event 构造器：上面的 draw() 已经画好了 */ }
        };
        /** 重画预览（唯一入口：输入时、编辑/删除后都走它）。 */
        const draw = () => {
          prev.textContent = '';
          for (const seg of labelSegs(displayRaw())) {
            prev.appendChild(labelChip({
              name: seg.name, suffix: seg.suffix,
              chipTitle: '点一下改这一段',
              delTitle: '删掉这一段：' + seg.raw,
              onDelete: () => {
                /* 按**原始段序号**删（不按文本删：`备注|备注` 这种重复段删一个才不会两个一起没） */
                commit();
                const list = parts();
                list.splice(seg.i, 1);
                raw = list.join('|');
                draw();
                notify();
              },
              onClick: () => {
                commit();
                const list = parts();
                if (seg.i >= list.length) return;   // 上面那次 commit 把段并掉了：没得改
                editIdx = seg.i;                    // 载回框里改；此时 read() 与改之前同值
                inp.value = list[seg.i];
                draw();
              }
            }));
          }
          inp.classList.toggle('is-editing', editIdx >= 0);
        };
        inp.addEventListener('input', draw);
        inp.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          commit(); draw(); notify();
        });
        draw();
        return { el: box, read: () => displayRaw(), key: spec.key };
      }
      /* 【2.0.2.7 需求①】候选词控件（核心词 / 标题词 / 图片命中词共用）：常态只显**胶囊**，
       * 输入框藏在浮层里（点末尾的 `+` 打开），回车把这一段收成胶囊，点胶囊载回框里改。
       *
       * **怎么切**：只有**正则模式**下 `|` 才是"或"（`compiler.js:82` 普通模式会把整串转义 ⇒
       * 写 `A|B` 匹配的是字面量 `A|B`，一个词都不会亮）。所以
       *   · 正则模式（`spec.regexAlways` 恒真；否则看兄弟开关 `spec.regexKey` 勾没勾）→ 按 `|` 切；
       *   · 普通模式 → **整串一个胶囊**（切了就是骗人）；值里真出现 `|` 时补一行提示教去勾「正则」。
       * 也正因此这里**不解析后缀**（`#`/`%`/`^`）——在图片命中词与正则候选里那些是正文字符，
       * 照 `labels` 那套解析会把用户的正则吃掉。
       *
       * 不变式与 `labels` 完全一致：没动过 ⇒ `read()` 逐字返回原串；有待定文本 ⇒ 也带上
       * （没回车直接保存不丢数据）。存储契约不变（仍是整串原文，分隔符由 storage 归一）。 */
      case 'cands': {
        const inp = h('input', { class: 'kh-input', type: 'text', id: id, value: '', placeholder: spec.placeholder });
        const prev = h('div', { class: 'kh-lbl-preview' });
        const addBtn = h('button', {
          class: 'kh-cand-add', type: 'button',
          title: '加一个候选' + ((spec.regexAlways || spec.regexKey) ? '（正则模式下也可以用 | 写"或"）' : ''),
          text: '+'
        });
        const tip = h('div', { class: 'kh-cand-tip' });
        /* `data-for` 给自动化当稳定钩子：输入框藏在浮层里，e2e 要先点 `+` 才能往真框里打字 */
        /* 胶囊与 `+` 同一个「控件行」：行高对齐普通输入框（30px），字段盒高度才与相邻字段一致。
         * `.kh-editor-sec-body` 是 `align-items: flex-end`（components.css）——靠**底边**对齐，
         * 盒高不等就会让「标题词」比旁边的「组合方向」低一截（真机回归量盒顶就是这个）。 */
        const row = h('div', { class: 'kh-cand-row' }, [prev, addBtn]);
        const box = h('div', { class: fldCls + ' kh-cand-box', 'data-for': id, title: hintTitle }, [
          h('label', { class: 'kh-fld-label', text: spec.label + (spec.required ? ' *' : ''), for: id }),
          inp, row, tip
        ]);
        let raw = value == null ? '' : String(value);   // 已确定的整串（初值即存量值）
        let editIdx = -1;                               // ≥0 = 正在改第几个候选（下标按 `parts()`）
        /* `modeOn`：外层（关键词弹窗）**明确告知**的正则状态。控件构造时兄弟开关还没进 DOM
         * （`create()` 只造节点，挂载由调用方做），这时 `getElementById` 只能猜错；所以弹窗建完
         * 字段后会用 `_repaint(!!正则控件的值)` 把真值送进来 —— 没人送才自己查 DOM。 */
        let modeOn = null;
        /** 现在是不是「正则模式」：决定 `|` 是"或"还是普通字符 */
        const regexOn = () => {
          if (modeOn !== null) return modeOn;
          if (spec.regexAlways) return true;
          if (!spec.regexKey) return false;
          try {
            const el = document.getElementById((c.idPrefix || 'fld-') + spec.regexKey);
            return !!(el && el.checked);
          } catch (e) { return false; }   // 取不到兄弟开关（如单测垫片）⇒ 按普通模式算，最保守
        };
        const split = (s) => {
          const str = String(s == null ? '' : s);
          if (!str.length) return [];
          if (!regexOn()) return [str];                 // 普通模式：整串就是一个词
          const out = [];
          for (const one of str.split('|')) { const t = one.trim(); if (t.length) out.push(t); }
          return out.length ? out : [str];
        };
        const parts = () => split(raw);
        const pending = () => split(inp.value);
        /** 当前"会存下去"的整串：没有待定/编辑 ⇒ 原样返回 `raw`（一个字都不动）。 */
        const displayRaw = () => {
          const t = pending();
          if (editIdx < 0 && !t.length) return raw;
          const list = parts();
          if (editIdx >= 0) list.splice(editIdx, 1, ...t);
          else for (const one of t) list.push(one);
          return list.join('|');
        };
        /** 把待定内容收进 `raw` 并清空输入框（回车、点胶囊、✕ 之前都先落一下，段序号才稳定）。 */
        const commit = () => { raw = displayRaw(); editIdx = -1; inp.value = ''; };
        const notify = () => {
          /* 让外层（弹窗的"改动过"标记等）也收到一次改动通知；调度器不支持就算了 */
          try { if (typeof inp.dispatchEvent === 'function') inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* 无 Event 构造器：draw() 已经画好了 */ }
        };
        /** 重画胶囊（唯一入口：输入时、增删改后、正则开关翻动后都走它）。 */
        const draw = () => {
          prev.textContent = '';
          const list = split(displayRaw());
          for (let i = 0; i < list.length; i++) {
            prev.appendChild(labelChip({
              name: list[i],
              chipTitle: '点一下改这一个候选',
              delTitle: '删掉这个候选：' + list[i],
              onDelete: () => {
                /* 先 commit（把待定文本并进 `raw`）再按序号删：段序号才是稳的 */
                commit();
                const arr = parts();
                arr.splice(i, 1);
                raw = arr.join('|');
                draw(); notify();
              },
              onClick: () => {
                commit();
                const arr = parts();
                if (i >= arr.length) return;   // 上面那次 commit 把候选并掉了：没得改
                editIdx = i;
                inp.value = arr[i];
                draw();
                openPop(true);                 // 浮层锚在稳定的 `+` 上（胶囊刚被这次 draw 重建过）
              }
            }));
          }
          /* 普通模式下 `|` 不是"或"：值里真出现 `|` 时当场说清楚（否则用户以为配了好几个词） */
          const warn = !regexOn() && String(raw).indexOf('|') >= 0;
          tip.hidden = !warn;
          tip.textContent = warn ? '普通匹配下 | 不表示"或"（整串按字面匹配）；要写多个候选请勾上「正则」' : '';
        };
        const openPop = attachPop(addBtn, inp, box, () => draw(), () => {
          commit();                 // 点 `+` = 新录一个：先把上一段的待定文本收起来
          editIdx = -1; inp.value = '';
          draw();
        });
        /* 回车 = "这一段录完了"：收进 `raw` 并清空输入框（与「字段」控件同一手感）。
         * 浮层由 `attachPop` 那颗 keydown 监听顺手关掉，这里只管把值收好。 */
        inp.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          commit(); draw(); notify();
        });
        draw();
        return {
          el: box, read: () => displayRaw(), key: spec.key,
          /* 供外层（关键词弹窗）把「正则」开关的真值告诉它，并在开关翻动时重画 */
          _repaint: (on) => { if (typeof on === 'boolean') modeOn = on; draw(); }
        };
      }
      default: {
        /* `placeholder: spec.placeholder`（**不兜 `|| ''`**）：没声明占位的字段就**真的没有**
         * 这个属性 —— `h()` 对 null/undefined 直接跳过（dom.js:25）。写成 `''` 会在 DOM 里
         * 留下一个空 placeholder，C4 的判定（"空值时不再恒显占位"）就没法用属性判死了；
         * 渲染效果一样（空串也什么都不显示），但语义干净。 */
        const inp = h('input', { class: 'kh-input', type: 'text', id: id, value: value == null ? '' : String(value), placeholder: spec.placeholder });
        return { el: fieldBox(spec.label + (spec.required ? ' *' : ''), inp), read: () => inp.value, key: spec.key };
      }
    }
  }

  /**
   * 【2.0.2.4 需求④】「抓取字段」原文 → 逐段解析结果（供胶囊预览用）。
   *
   * **语法只有一份**：解析一律走 `KH.Fetch.splitLabelTokens` / `parseLabelSpec`（抓取实现本体），
   * 这里只负责把结果排成界面要看的样子（名字 + 后缀串）。`KH.Fetch` 缺席时（理论上不会——
   * options.html 已加载它）退回"整串当一个名字"，宁可少画徽标，也不在这里养第二套后缀语法。
   *
   * @returns {Array<{i:number, raw:string, name:string, suffix:string}>} `i` = 原始段序号（删段用）
   */
  function labelSegs(raw) {
    const F = KH.Fetch;
    const s = raw == null ? '' : String(raw);
    const toks = (F && typeof F.splitLabelTokens === 'function') ? F.splitLabelTokens(s) : [s];
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      const spec = (F && typeof F.parseLabelSpec === 'function') ? F.parseLabelSpec(tok) : null;
      if (spec) {
        if (!spec.label) continue;                     // 空段（结尾多个 `|`、或只写了后缀）不画胶囊
        out.push({ i: i, raw: tok, name: spec.label, suffix: (typeof F.suffixTextOf === 'function' ? F.suffixTextOf(spec) : '') });
      } else if (String(tok).trim()) {
        out.push({ i: i, raw: tok, name: String(tok), suffix: '' });
      }
    }
    return out;
  }

  /**
   * 【2.0.2.7】后缀胶囊的**唯一渲染实现**：`名字 [+ 后缀徽标] [+ ✕]`。
   *
   * 两处都用它：字段控件的「可编辑胶囊列表」（`case 'labels'`）与设置页「重要笔记置顶」
   * （`options.js renderPinOrder`）。原先各写一份 —— 骨架（类名嵌套）是视觉契约，
   * 抄两份迟早漏一处（`components.css:598-613` 是样式那半边的单一来源，这里是结构那半边）。
   *
   * **只共用骨架**：文案、"✕ 干什么"、"点胶囊干什么"都由调用方给（两处行为本来就不同）。
   *
   * @param {object} o
   *   name      名字（必填，直接当文本；要序号/分组前缀请调用方自己拼进 name）
   *   suffix    后缀徽标文本（可选，空则不画）
   *   chipTitle 胶囊 title（可选）
   *   delTitle  `✕` 的 title（可选）
   *   onDelete  点 `✕`（可选；不传就**不画** ✕）
   *   onClick   点胶囊本体（可选；不传就不可点）
   * @returns {HTMLElement}
   */
  function labelChip(o) {
    const h = D().h;
    const c = o || {};
    /* `h()` 只跳过 null/undefined（dom.js:25），写 `''` 会在 DOM 里留一个空 title ⇒ 没值就别写这个键 */
    const chipAttrs = { class: 'kh-lbl-chip' };
    if (c.chipTitle) chipAttrs.title = c.chipTitle;
    const kids = [h('span', { class: 'kh-lbl-name', text: c.name })];
    if (c.suffix) kids.push(h('span', { class: 'kh-lbl-suffix', text: c.suffix }));
    if (typeof c.onDelete === 'function') {
      const delAttrs = { class: 'kh-lbl-del', type: 'button', text: '✕' };
      if (c.delTitle) delAttrs.title = c.delTitle;
      const del = h('button', delAttrs);
      del.addEventListener('click', (ev) => {
        /* ✕ 长在胶囊里：不拦的话调用方挂在胶囊上的"点一下改这一段"会跟着触发 */
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        c.onDelete(ev);
      });
      kids.push(del);
    }
    const chip = h('span', chipAttrs, kids);
    if (typeof c.onClick === 'function') chip.addEventListener('click', (ev) => c.onClick(ev));
    return chip;
  }

  /**
   * 把一组**已生成**的控件排进正文容器（唯一的排布实现，关键词弹窗与分组弹窗共用）。
   *
   * 规则（都是实测踩出来的，见 设计偏好.md）：
   *   · `chip` 开关**连续几个自成一行**（`.kh-fld-chips`）—— 否则 flex 会让"半行字段"
   *     继续收缩去给胶囊腾地方（实测「组合方向」被压到 60px 宽）；
   *   · `sepBefore: true` 的胶囊与前面那颗**同一行但插一条竖线** —— 留白只能说"离得远"，
   *     竖线才说明"这是另一组"；
   *   · 其余字段交给 `.kh-fld / .kh-fld-wide` 的"半行 / 整行"流式规则（两个半行自动并排）。
   *
   * @param {Array<{spec:object, ctrl:object}>} items
   * @param {HTMLElement} bodyEl
   */
  function layout(items, bodyEl) {
    const h = D().h;
    let chipRow = null;
    for (const it of items) {
      const f = it.spec, c = it.ctrl;
      if (f.chip) {
        if (!chipRow) {
          /* 若该行**第一个**字段带 `width:2`，说明它要独占整行
           * （历史上「启用组合」用过它来保证后面「标题关键词 | 组合方向」能并排；
           *  K70 起该开关改挂分区标题行，这条分支留作通用能力） */
          chipRow = h('div', { class: 'kh-fld-chips' + (f.width === 2 ? ' kh-fld-chips-wide' : '') });
          bodyEl.appendChild(chipRow);
        }
        if (f.sepBefore && chipRow.childNodes.length) {
          chipRow.appendChild(h('span', { class: 'kh-chip-sep' }));
        }
        chipRow.appendChild(c.el);
      } else {
        chipRow = null;
        bodyEl.appendChild(c.el);
      }
    }
    return bodyEl;
  }

  ui.Fields = { create, layout, labelChip };
})();
