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
     * 弹窗正文只留短句/短标签，完整语义进 tooltip。`h()` 对 null/false 直接跳过（dom.js），
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
        /* 【2.0.2.11 票 #64】`tool: true` = 这颗开关要住进富文本工具栏（和 B / I / 链接同一排）。
         * 长相照抄工具栏按钮（`.kh-mini-btn` + `.is-on` 表示亮着），真值仍是这个勾选框：
         * `id` / `.checked` / `change` 一字不变，装置与保存路径都直接取它，它只是**搬了家**。
         * ⚠️ 必须排在 `chip` **之前**判断：这两颗字段本来也是胶囊（`chip: true`），
         * 不给它优先权就永远走不到工具栏那条分支。 */
        if (spec.tool) {
          const b = h('button', {
            class: 'kh-mini-btn kh-tool-toggle', type: 'button',
            text: spec.short || spec.label, title: spec.hint || spec.label,
            /* 工具栏的按钮都是纯文字，读屏与真机回归都靠 aria-label 认它 */
            'aria-label': spec.label
          });
          const paint = () => b.classList.toggle('is-on', !!cb.checked);
          b.addEventListener('click', () => {
            cb.checked = !cb.checked;
            paint();
            if (c.onChange) c.onChange(spec.key, cb.checked);
          });
          paint();
          return { el: h('span', { class: 'kh-tool-field', title: spec.hint || spec.label }, [b, cb]), read: () => cb.checked, key: spec.key };
        }
        if (spec.chip) return { el: chipEl(cb, spec.label, spec.hint, () => cb.checked), read: () => cb.checked, key: spec.key };
        /* 【2.0.2.10 票 #57】`width: 2` 的勾选行独占一行（图片 OCR 子块的开关行用它，
         * 否则它会以 17px 的高度底对齐浮在上一行右端，看着像挂错了地方）。 */
        const boolCls = 'kh-fld-bool' + (spec.width === 2 ? ' kh-fld-bool-wide' : '');
        return { el: h('div', { class: boolCls, title: hintTitle }, [cb, h('span', { class: 'kh-fld-bool-label', text: spec.label })]), read: () => cb.checked, key: spec.key };
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
        /* 【票 #56】`spec.grow`：这一块吃掉卡片多出来的高度（CSS 见 `.kh-fld-grow`）。 */
        return { el: h('div', { class: fldCls + (spec.grow ? ' kh-fld-grow' : '') }, [labelRow, ed]), read: () => ed.getValue(), key: spec.key };
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
        /* 【2.0.2.11 票 #64】`noLabel` = 不画可见标题（用户口径：删掉「笔记内容」这行文案，
         * 它和工具栏重复、白占一行）。字段名不能只剩一个视觉标签 —— 给编辑器上 `aria-label`，
         * 读屏与自动化仍认得出这块是什么。 */
        if (spec.noLabel) {
          try { if (ed.setAttribute) ed.setAttribute('aria-label', spec.label || '重要笔记内容'); } catch (e) { /* 垫片可能没有 setAttribute：纯视觉退化，不影响存取 */ }
          return {
            el: h('div', { class: fldCls + (spec.grow ? ' kh-fld-grow' : '') }, [ed]),
            read: () => ed.getValue(), key: spec.key
          };
        }
        return { el: h('div', { class: fldCls + (spec.grow ? ' kh-fld-grow' : '') }, [
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
        /* 名字按**它做的事**起（票 #52）：取值 + 空兜底 + 转字符串，不是夹边界（夹边界是 `input` 的 min/max）。 */
        const numOf = (v, fallback) => { const n = typeof v === 'function' ? v() : v; return n == null ? fallback : String(n); };
        const inp = h('input', {
          class: 'kh-input', type: 'number', id: id,
          min: numOf(spec.min, '40'),
          max: numOf(spec.max, '600'),
          step: numOf(spec.step, '1'),
          /* C5：原来硬编码「留空＝用全局默认尺寸」—— 但 `#fld-imgOcrMax`（每处最多＝**张数**）
           * 走的是同一条分支，提示写错了对象。改为优先用字段自己的 hint。 */
          title: spec.hint || '留空＝用全局默认', value: value === '' || value == null ? '' : String(value),
          placeholder: spec.inline ? '默认' : '留空＝默认'
        });
        /* 【2.0.2.7 需求②·二改】常态＝**一颗小按钮**（内容＝当前值，留空写「默认」），点它才在
         * 浮层里出数字框。样式直接复用「重要笔记」工具栏那一排（`.kh-mini-btn`：24px 高、细边框、
         * 悬停变品牌色、`title` 提示）—— 用户口径（m02566）"参考重要笔记的表格、图片、加粗之类的
         * 按钮，点击之后才能修改"。原来那枚胶囊是"标签"长相，跟工具栏按钮不像，也占地方。
         * 输入框本体（`#fld-imgSize` 这类 id / `type=number` / `coerce` 口径）一个字不改 ——
         * 装置与保存路径都直接取它，它只是**搬了家**：空闲时回到 `host` 里藏着。 */
        /* 【2.0.2.11 票 #64】`tool: true` 时这颗按钮要进富文本工具栏：文案带一个前缀字
         * （`A` 字号 / `▭` 图片尺寸），否则两颗都写「默认」时分不清谁是谁；完整字段名在 title 里。
         * 不带前缀的老字段文案不变（「默认 / 数值」）。 */
        const prefix = (spec.tool && spec.toolPrefix) ? String(spec.toolPrefix) : '';
        const shown = () => {
          const v = String(inp.value);
          if (!v) return prefix || '默认';
          return prefix + v;
        };
        const btn = h('button', {
          class: 'kh-mini-btn kh-num-btn', type: 'button',
          title: '点一下改「' + spec.label + '」', text: shown(),
          'aria-label': spec.label
        });
        const host = h('div', { class: 'kh-num-box' + (spec.tool ? ' kh-tool-field' : '') }, [btn]);
        /* 住进工具栏时容器不再有「标签」，字段名的解释只能靠 title 带（真机回归按容器读 tooltip） */
        if (spec.tool) host.title = spec.hint || spec.label;
        host.appendChild(inp);
        attachPop(btn, inp, host, () => { btn.textContent = shown(); });
        /* 工具栏里只要这颗按钮，不要再套一层「标签 + 控件」（那块标签没人看，宽度还翻倍） */
        if (spec.tool) return { el: host, read: () => KH.FieldMap.coerce(spec, inp.value), key: spec.key };
        const box = fieldBox(spec.label, host);
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
        /* 【2.0.2.10 票 #58】图例改**默认收起**：这段 151 字的语法说明常驻时实测 83px / 5 行，
         * 把「字段」控件撑到 135px，是这张卡里最显眼的一块灰字。信息一个字不删，只是搬到
         * `<details>` 里 —— 想知道后缀怎么写的人点一下，不想知道的人不必每眼都读一遍。 */
        const legend = legendEl();
        const box = h('div', { class: fldCls, title: hintTitle }, [
          h('label', { class: 'kh-fld-label', text: spec.label + (spec.required ? ' *' : ''), for: id }),
          inp, prev, legend
        ]);
        /* 状态机（待定段 / 段号 / 提交 / 改动通知）与候选词共用一份，见 `segEditor`；切段口径是标签自己的。 */
        const st = segEditor(inp, (s) => ((KH.Fetch && typeof KH.Fetch.splitLabelTokens === 'function') ? KH.Fetch.splitLabelTokens(s) : [String(s)]), value);
        /** 重画预览（唯一入口：输入时、编辑/删除后都走它）。 */
        const draw = () => {
          prev.textContent = '';
          for (const seg of labelSegs(st.displayRaw())) {
            prev.appendChild(labelChip({
              name: seg.name, suffix: seg.suffix,
              chipTitle: '点一下改这一段',
              delTitle: '删掉这一段：' + seg.raw,
              onDelete: () => {
                /* 按**原始段序号**删（不按文本删：`备注|备注` 这种重复段删一个才不会两个一起没） */
                st.commit();
                const list = st.parts();
                list.splice(seg.i, 1);
                st.raw = list.join('|');
                draw();
                st.notify();
              },
              onClick: () => {
                st.commit();
                const list = st.parts();
                if (seg.i >= list.length) return;   // 上面那次 commit 把段并掉了：没得改
                st.editIdx = seg.i;                 // 载回框里改；此时 read() 与改之前同值
                inp.value = list[seg.i];
                draw();
              }
            }));
          }
          inp.classList.toggle('is-editing', st.editIdx >= 0);
        };
        inp.addEventListener('input', draw);
        inp.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          st.commit(); draw(); st.notify();
        });
        draw();
        return { el: box, read: () => st.displayRaw(), key: spec.key };
      }
      /* 【2.0.2.7 需求①】候选词控件（核心词 / 标题词 / 图片命中词共用）：常态只显**胶囊**，
       * 输入框藏在浮层里（点末尾的 `+` 打开），回车把这一段收成胶囊，点胶囊载回框里改。
       *
       * **怎么切**（2.0.2.11 票 #65 起：`|` 在**两种模式**下都是「多个词」的分隔符）：
       *   · 普通模式：每段按**字面量**编译（`compiler.js` 对每段 `escapeRegex`）——段里就算写了正则
       *     元字符，也只是普通字符；
       *   · 正则模式：每段**各自**当表达式编译（`compiler.js` 把多段拼成 `(?:a|b)`），胶囊之间互不影响。
       * 差别只在"每段怎么编译"，不再体现在"要不要切开"。
       * 这里默认**不解析后缀**（`#`/`%`/`^`）——在图片命中词与正则候选里那些是正文字符，照 `labels`
       * 那套解析会把用户的正则吃掉；只有 `spec.token`（抓取后续字段）才解析后缀并画徽标。
       *
       * 不变式与 `labels` 完全一致：没动过 ⇒ `read()` 逐字返回原串；有待定文本 ⇒ 也带上
       * （没回车直接保存不丢数据）。存储契约不变（仍是整串原文，分隔符由 storage 归一）。 */
      case 'cands': {
        /* `size: 1`：文本态把这个框整行显示时，输入框**默认 `size=20` 的内在宽度**会顺着卡片
         * 把整列撑宽（实测卡片正文 305 → 468、退出文本态后列已被 `min-width` 钉住不回缩）。
         * 视觉宽度由 CSS 的 `width: 100%` 决定，`size` 只用于内在宽度 ⇒ 设成 1 不影响任何观感。 */
        const inp = h('input', { class: 'kh-input', type: 'text', id: id, size: 1, value: '', placeholder: spec.placeholder });
        /* 【2.0.2.17 需求③】文本态改用 **textarea**：一整串候选在单行 `input` 里只能横向滚动，
         * 想改中段就得左右拖着看（用户原话：内容过长时输入框并不能完全展示，改成过长时默认展开输入框）。
         * `ta` 只在文本态露面，常态仍由 `inp`（浮层里编辑单段）与胶囊负责。 */
        const ta = h('textarea', { class: 'kh-input kh-cand-ta', rows: 1, spellcheck: 'false', autocomplete: 'off', hidden: true });
        const prev = h('div', { class: 'kh-lbl-preview' });
        const addBtn = h('button', {
          class: 'kh-cand-add', type: 'button',
          title: '加一个候选（也可以用 | 一次写多个）',
          text: '+'
        });
        const tip = h('div', { class: 'kh-cand-tip' });
        /* `data-for` 给自动化当稳定钩子：输入框藏在浮层里，e2e 要先点 `+` 才能往真框里打字 */
        /* 【2.0.2.7 需求①·二改】胶囊装在**一个输入框样子的框**里（用户口径 m02566：一个输入框，
         * 里面展示胶囊内容；点 `+` 才弹出小输入框编辑，回车回到展示模式）。空态把 placeholder
         * 画在框里 —— 否则"没内容"看起来不像一个空输入框。
         * `min-height: 30px` ＝普通输入框高 ⇒ 字段盒总高与相邻字段一致，`.kh-editor-sec-body`
         * 是 `align-items: flex-end`（components.css，靠**底边**对齐），盒高不等就会让「标题词」
         * 比旁边的「组合方向」低一截（真机回归量盒顶就是这个）。 */
        const ph = h('span', { class: 'kh-cand-ph', text: spec.placeholder || '' });
        /* 列表模式的框面**没有 `+`**：录入改走「修改」弹窗（用户 2026-11-02 口径） */
        const frame = h('div', { class: 'kh-cand-field' }, spec.listEdit ? [prev, ph] : [prev, ph, addBtn]);
        /* 【2.0.2.16 需求②】文本态：点框面**空白处** ⇒ 胶囊还原成**一整串文本**（`|` 分隔），
         * 回车 / 点框外再收成胶囊。为什么要有这条路：常态是胶囊，想整体改（粘贴一串、大改顺序、
         * 把已有的串原样看一遍）就只能一段一段在浮层里敲。顺带把"原文本里的 `|` 到底算不算分词"
         * 当面讲清楚（2.0.2.11 起两种模式都按 `|` 切，用户容易按字面理解成"或"）。 */
        let textMode = false;
        const textTip = h('div', {
          class: 'kh-cand-tip kh-cand-texttip', hidden: true,
          title: '| 是分隔符：这里的每个 | 都会拆成多个候选（不是正则的「或」）。回车或点框外收起为胶囊。',
          text: '| 是分隔符：这里的每个 | 都会拆成多个候选（不是正则的「或」）。回车或点框外收起为胶囊。'
        });
        const labelEl = h('label', { class: 'kh-fld-label', text: spec.label + (spec.required ? ' *' : ''), for: id });
        /* 【2026-11-02 需求】五个候选框的录入改成**弹窗列表**：标题行挂「修改」，框面只做只读展示，
         * 不再挂 `+`、也不画后缀徽标 —— 后缀只在这个列表里按原文回显与编辑。
         * 为什么不做成"每个词一个浮层"：这五个字段要管的是"这一格有哪些条目"，
         * 逐条点开浮层在几十条时没法总览，也没法一眼看出漏了哪个。 */
        const listBtn = spec.listEdit ? h('button', {
          class: 'kh-mini-btn kh-list-btn', type: 'button', text: '修改',
          title: '在弹窗里按行管理这一格的所有条目（可增、删、改）'
        }) : null;
        const kids = [inp, ta, frame, tip, textTip];
        /* 【2.0.2.11 票 #63】「抓取后续字段」沿用候选词的手感，但**默认不长大**：单行裁切，
         * 词多到看不全时点「展开」占整行（用户口径 m01713：「宽度高度都默认不变，超出隐藏超出部分，
         * 但支持手动展开/收起」）。展开态只是给盒子加 `.kh-fld-wide`，不另造一套渲染。
         * 后缀徽标同样只在 `spec.token` 时画（解析走 `labelSegs`，与「字段」控件同一份语法）。 */
        let headEl = labelEl;
        let clampBtn = null;
        if (spec.clamp) {
          clampBtn = h('button', {
            class: 'kh-mini-btn kh-clamp-btn', type: 'button', text: '展开',
            title: '词多了看不全：展开占整行 / 再点收起'
          });
          /* 默认先藏：只有**真的**看不全才需要这颗按钮（每个候选框都挂一颗「展开」很吵） */
          clampBtn.hidden = true;
          clampBtn.addEventListener('click', (ev) => {
            if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
            /* 展开态用 `is-open`：`.kh-fld-wide` 是"字段占整行"的既有语义（这个字段本来就是 width:2），
             * 借用它会让"展开"在这个字段上完全没有视觉变化。 */
            const on = box.classList.toggle('is-open');
            clampBtn.textContent = on ? '收起' : '展开';
            clampBtn.hidden = false;
          });
          headEl = h('div', { class: 'kh-fld-labelrow' }, [labelEl, listBtn, clampBtn].filter(Boolean));
        }
        /* 没有「展开」「批量」的候选框（核心词 / 标题词）：只有「修改」时也要单独起标题行 */
        if (headEl === labelEl && listBtn) headEl = h('div', { class: 'kh-fld-labelrow' }, [labelEl, listBtn]);
        /* 后缀图例跟着「修改」弹窗走：添加关键词的弹窗里不重复展示后缀相关内容 */
        if (spec.token && !spec.listEdit) kids.push(legendEl());
        const boxCls = fldCls + ' kh-cand-box'
          + (spec.clamp ? ' kh-cand-clamp' : '')
          + (spec.token ? ' kh-cand-token' : '');
        const box = h('div', { class: boxCls, 'data-for': id, title: hintTitle }, [headEl].concat(kids));
        /* 已确定整串 / 待定段 / 段号这一族交给 `segEditor`（与标签控件同一份实现，票 #52）；`modeOn` 是本字段自己的。 */
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
        /* 2.0.2.11 票 #65：两种模式**都按 `|` 切**，差别只在 `compiler.js` 对每段怎么编译
         * （普通模式 escape 成字面量、正则模式原样当表达式）⇒ 这里不再看 `regexOn()`。
         * `spec.token`（抓取字段）另有更严的切法：`KH.Fetch.splitLabelTokens` 认 `|` `｜`
         * 以及「不属于 `@表达式` 的逗号」—— 那是落盘口径，控件不许比它切得粗，否则
         * `应用截图@1,3` 会被显示成一个胶囊、保存后又变成两个字段（看着一个、存成两个）。 */
        const plainSplit = (s) => {
          const str = String(s == null ? '' : s);
          if (!str.length) return [];
          const out = [];
          for (const one of str.split('|')) { const t = one.trim(); if (t.length) out.push(t); }
          return out.length ? out : [str];
        };
        const tokenSplitter = spec.token && KH.Fetch && KH.Fetch.splitLabelTokens;
        /* 【2.0.3 需求②】`csvSplit`：这一格填的是**抓取字段名**（人习惯用逗号写多个），逗号也当分隔符。
         * 只有显式声明这个开关的字段才这么切 —— 另外四个候选框里的逗号是**正文字符**（关键词 `a,b`），
         * 跟着宽切就等于改口径。所以「一处改、全体一致」管的是控件与外壳，不是切分规则。 */
        const csvSplit = !!spec.csvSplit && !tokenSplitter;
        const split = tokenSplitter ? (s) => {
          const arr = KH.Fetch.splitLabelTokens(String(s == null ? '' : s));
          return (arr && arr.length) ? arr : plainSplit(s);
        } : !csvSplit ? plainSplit : (s) => plainSplit(String(s == null ? '' : s).replace(/[,，、;；]/g, '|'));
        const st = segEditor(inp, split, value);
        /** 文本态高度跟着内容走（上限 9 行，再多就滚动）：进文本态是为了**改**，看不全就没意义。 */
        const autoGrow = () => {
          if (!textMode) return;
          try {
            ta.rows = 1;               // 先复位，scrollHeight 才反映真实内容高度
            /* 行高/内边距**实测**，不写死 20：CSS 里的 `font: inherit` 会把 `line-height` 重置，
             * 真机算出来是 23.1px（2.0.2.18 验收页实测）—— 硬编码 20 会让行数永远偏少。 */
            const cs = (window.getComputedStyle ? window.getComputedStyle(ta) : null);
            const lineH = (cs && parseFloat(cs.lineHeight)) || 20;
            const padY = cs ? ((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)) : 0;
            const need = Math.max(0, (ta.scrollHeight || 0) - padY);
            ta.rows = Math.max(1, Math.min(9, need > 0 ? Math.ceil(need / lineH) : 1));
          } catch (e) { /* 垫片没有 layout：保持 rows=1 */ }
        };
        /** 重画胶囊（唯一入口：输入时、增删改后、正则开关翻动后都走它）。 */
        const draw = () => {
          prev.textContent = '';
          box.classList.toggle('is-texed', textMode);
          ta.hidden = !textMode;
          if (textMode) {
            /* 文本态：胶囊 / 占位让位给那块 textarea（宽度不变，见 CSS 的 `.is-texed:not(.is-open)`） */
            ph.hidden = true;
            textTip.hidden = false;
            tip.hidden = true; tip.textContent = '';
            inp.classList.remove('is-editing');
            if (clampBtn) clampBtn.hidden = true;   // 文本态自己会长高，不需要「展开」
            autoGrow();
            return;
          }
          textTip.hidden = true;
          const list = split(st.displayRaw());
          for (let i = 0; i < list.length; i++) {
            /* `spec.token`（抓取后续字段）：每段本来就带 `#`/`%`/`^` 后缀 ⇒ 胶囊名取解析后的 label、
             * 后缀画成徽标（用户口径 m01713：词的数量多也能看清各自的后缀）。解析走 `labelSegs`，
             * 与「字段」控件同一份语法；没写后缀时它就是原串。
             * 【2.0.6.1 需求②】`suffixChip`（图上须有的字段值）：这框填的也是**抓取字段名**（可带
             * `!`/`^` 等修饰），后缀同样不参与命中 —— 画成徽标才看得见"名字是名字、修饰是修饰"，
             * 否则用户会以为 `开发者 ! ^高价` 整串都要在图里出现。 */
            const tok0 = (spec.token || spec.suffixChip || spec.kvSuffix)
              ? (labelSegs(list[i], { kv: spec.kvSuffix })[0] || { name: list[i], suffix: '' })
              : { name: list[i], suffix: '' };
            /* 【2.0.7.2 需求④】原先这里还有一条 `suffixHide`（图片动态关键词只显示名字、不画后缀徽标，
             * 因为 2.0.7.1 认定"后缀只用来认出字段名、不改取值"）。那个认定本轮被推翻：
             * 后缀在这一格**真生效**（`开发者^高价` 先裁出 `a公司` 再比），所以徽标必须画出来 ——
             * 一个"能改取值"的后缀却画成名字的一部分，用户没法判断自己到底配了什么。
             * 分支已删：现在只有"画徽标"一种口径，不再有第二个开关。 */
            const tok = tok0;
            /* 【2026-11-03 需求 m00625】图片命中词 / 图片动态词在「添加关键词」里**只显示词条名**：
             * `@指向字段` 与后缀都只在「修改」弹窗里看。`labelSegs` 的 kv 分支只剥 `#表`，
             * `一对一@应用名称` 这种会整串当名字 ⇒ 这里再把 `@字段` 与后缀剥掉，只留 label。 */
            const chipName = (spec.listEdit && spec.kvBatch) ? kvDisplayName(list[i]) : tok.name;
            prev.appendChild(labelChip({
              name: chipName,
              /* 【2026-11-02 需求】列表模式：框面只显示条目名，**不画后缀徽标** ——
               * 后缀内容一律进「修改」弹窗看（否则这一格看起来还是一堆 "#图3 / @截图"）。 */
              suffix: spec.listEdit ? '' : tok.suffix,
              chipTitle: spec.listEdit ? '点一下打开列表管理' : '点一下改这一个候选',
              delTitle: '删掉这个候选：' + list[i],
              onDelete: () => {
                /* 先 commit（把待定文本并进 `raw`）再按序号删：段序号才是稳的 */
                st.commit();
                const arr = st.parts();
                arr.splice(i, 1);
                st.raw = arr.join('|');
                draw(); st.notify();
              },
              onClick: () => {
                /* 列表模式：点胶囊＝打开列表（不再逐段弹小浮层） */
                if (spec.listEdit) { openList(); return; }
                st.commit();
                const arr = st.parts();
                if (i >= arr.length) return;   // 上面那次 commit 把候选并掉了：没得改
                st.editIdx = i;
                inp.value = arr[i];
                draw();
                openPop(true);                 // 浮层锚在稳定的 `+` 上（胶囊刚被这次 draw 重建过）
              }
            }));
          }
          /* 普通模式下 `|` 不是"或"：值里真出现 `|` 时当场说清楚（否则用户以为配了好几个词） */
          ph.hidden = list.length > 0;      // 框里有胶囊就不必再摆占位文字
          /* 与 `labels` 同一约定：正在改某一段时输入框带 `is-editing`（浮层里也认得出"在改哪一段"） */
          inp.classList.toggle('is-editing', st.editIdx >= 0);
          /* 普通模式下每段都是**字面量**：段里写了正则式子（`\d+`、`.*`、`(a|b)`）时提醒一句，
           * 否则用户会以为已经生效。2.0.2.11 票 #65 起 `|` 已经是分隔符，不再需要提醒"| 不是或"。
           * 【2.0.6.1 需求②】图片动态关键词（`suffixChip`）**不出这句**：它填的是抓取字段名，
           * 后缀本来就不是匹配内容（`!`/`^` 是取值修饰），拿"正则不生效"去吓它纯属错位；
           * 而且它的匹配本来就不是字面匹配（大小写不敏感、非全词、剔空白，见 `img-ocr.js` 的 judge）。 */
          const warn = !spec.token && !spec.suffixChip && !regexOn() && /[\\^$.*+?()[\]{}]/.test(String(st.raw));
          tip.hidden = !warn;
          tip.textContent = warn ? '普通匹配按字面找词：这里写的 . * + ? ( ) [ ] { } \\ ^ $ 都只是普通字符；要当正则用请勾上「正则」' : '';
          refreshClamp();
          /* 【2.0.7.2 需求①·根因】把**当前整串**挂到框上：别的控件（尤其同一张表单里的
           * 「抓取后续字段」）要靠它知道"到底配了哪些字段"。为什么不能读 `input.value`：
           * 候选框常态是**胶囊**，那个 `input` 只活在点 `+` 弹出的小浮层里、平时是空的 ——
           * 读它永远得到空串 ⇒ 批量弹窗的「设为该字段」下拉框恒为灰、`@截图` 被当普通词
           * （用户报的正是这两条）。`draw()` 是唯一重画入口，所以这里永远不会读到旧值。 */
          try { box.setAttribute('data-raw', st.displayRaw()); } catch (e) { /* 垫片没有 setAttribute 就算了 */ }
        };
        /* 展开按钮只在**真的看不全**时出现（用户口径 m02382：胶囊多了、长了也要维持一个输入框的样子，
         * 冗余的不展示；展开后才全显）。判据是胶囊行有没有溢出。
         * ⚠️ 必须等一次布局：刚 append 的胶囊这一刻还没排版，直接量 `scrollWidth` 会永远得 0 ⇒ 判成
         * "没溢出"、按钮永不出现。所以量测放在 rAF 里（垫片没有 rAF 就同步量）。 */
        const refreshClamp = () => {
          if (!clampBtn) return;
          const measure = () => {
            if (box.classList.contains('is-open')) { clampBtn.hidden = false; return; }
            /* 两种态各看各的溢出源：胶囊态看胶囊行/外壳（文本态自己长高，不参与） */
            const over = textMode
              ? false
              : ((prev.scrollWidth > prev.clientWidth + 1) || (frame.scrollWidth > frame.clientWidth + 1));
            clampBtn.hidden = !over;
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure);
          else measure();
        };
        /** 进文本态：把已确定的整串摊进 textarea（`|` 原样保留，`read()` 仍返回原文） */
        const enterText = () => {
          st.commit();                 // 先把浮层里的待定段收进 raw
          textMode = true;
          ta.value = st.raw == null ? '' : String(st.raw);
          draw();
          try { if (typeof ta.focus === 'function') ta.focus(); if (typeof ta.select === 'function') ta.select(); } catch (e) { /* 垫片没有 focus/select：不影响值 */ }
        };
        /** 出文本态：把那段文本收成 raw（切段交给 `split`，与胶囊同一份口径） */
        const exitText = () => {
          if (!textMode) return false;
          st.raw = String(ta.value == null ? '' : ta.value);
          st.editIdx = -1;
          ta.value = '';
          textMode = false;
          draw();
          return true;
        };
        /** 点 `+` / 点框面空白处 ＝ **新录一个候选**：先把上一段的待定文本（或文本态）收起来 */
        const startNew = () => {
          exitText();                  // 文本态先落盘，否则下面那次 commit 会把它丢掉
          st.commit();                 // 先把上一段的待定文本收起来
          st.editIdx = -1; inp.value = '';
          draw();
        };
        const openPop = attachPop(addBtn, inp, box, () => draw(), startNew);
        /**
         * 【2026-11-02 需求】「修改」弹窗：把这一格的条目摊成**按行的列表**，整批查看 / 增 / 删 / 改。
         * · 写回只改这一格自己的整串（仍是 `|` 连接的原文），存储格式与字段语义都不变；
         * · 后缀不拆控件，直接按原文显示在行里 —— 这五个字段的后缀语法本来就各不相同，
         *   在这里重造一套表单只会和 `fetch.js` 的解析口径二次漂移；
         * · `dirty` 为假时**不写回**：打开看一眼再点保存，绝不能把原串的空格/分隔符归一掉。
         */
        let listModal = null;
        /**
         * 【2026-11-03 需求】「修改」弹窗 = 这一格**唯一的管理入口**（原「批量」并进来，用户口径
         * 「这是一个东西」）。三种行型各管各的：
         *   · 普通词（核心词 / 标题词）：每行一个词，只增删改；
         *   · 图片命中词 / 图片动态词（`kvBatch`）：每行还要管 `@指向` 与 `#表`。指向不再把
         *     `@截图@名称` 摊在行里（字段一多就读不动），改成「可搜索 + 多选」的面板，行里只显示摘要；
         *   · 抓取后续字段（`token`）：后缀不再手敲，行里点「后缀：…」展开结构化编辑器
         *     （取哪一格 / 值格位置 / 取什么内容 / 怎么清理），并能拿一段原文试「取到」什么。
         * 写回：没动过的行一个字节都不碰（原串的空格与分隔符原样保留）；只有新增行时才整串重排。
         */
        const openList = () => {
          exitText();
          st.commit();
          const F = KH.Fetch || {};
          const known = knownFields();
          const isKv = !!spec.kvBatch;
          const isTok = !!spec.token;
          /* 图片动态关键词（`suffixChip`）的条目 = 字段名 + 取值后缀 + @指向 + #表：
           * 后缀也要结构化编辑，所以这里的行同时带「指向」与「后缀」两件。 */
          const hasSuffix = isTok || (isKv && !!spec.suffixChip);
          const specOf = (raw) => {
            if (typeof F.parseLabelSpec === 'function') {
              try { return F.parseLabelSpec(raw); } catch (e) { /* 退回裸名 */ }
            }
            return {
              label: String(raw == null ? '' : raw), simple: false, imgOnly: false, imgLimit: 0,
              noImg: false, offset: '', offsetInvalid: false, stripSpace: false, anchor: '', sliceSpec: '', clip: false
            };
          };
          const origRaw = String(st.raw == null ? '' : st.raw);
          const origRows = isKv ? kvRows(origRaw, known) : split(origRaw).map((raw) => ({ raw: raw }));
          const rows = [];
          for (let i = 0; i < origRows.length; i++) {
            const o = origRows[i];
            const row = { orig: i, gone: false, dirty: false, isNew: false, picked: false, el: null };
            if (isKv) {
              row.name = o.name;
              row.scopes = (o.scopes || []).slice();
              row.mark = !!o.mark;
              if (spec.suffixChip) { row.spec = specOf(row.name); row.name = row.spec.label; }
            } else if (isTok) { row.name = specOf(o.raw).label; row.spec = specOf(o.raw); }
            else row.name = String(o.raw == null ? '' : o.raw);
            rows.push(row);
          }
          let dirty = false;

          const listEl = h('div', { class: 'kh-list-rows' });
          const countEl = h('span', { class: 'kh-list-count' });
          const filter = h('input', {
            class: 'kh-input kh-list-filter', type: 'search',
            placeholder: isKv ? '按词、字段名或 #表 过滤' : '按词过滤'
          });
          const addInp = h('input', {
            class: 'kh-input kh-list-add', type: 'text',
            placeholder: isKv ? '输入新词，回车添加（可写 @字段 #表）'
              : isTok ? '输入新字段名，回车添加（后缀在行里设置）' : '输入后回车添加'
          });

          const alive = () => rows.filter((r) => !r.gone);
          const pickedRows = () => alive().filter((r) => r.picked);
          const scopeLabel = (row) => {
            const n = (row.scopes || []).length;
            if (!n) return '全部字段';
            if (n <= 2) return row.scopes.join('、');
            return row.scopes[0] + ' 等 ' + n + ' 个';
          };
          const syncCount = () => {
            countEl.textContent = '共 ' + alive().length + ' 条，已选 ' + pickedRows().length + ' 条';
          };
          const rowText = (row) => isKv
            ? (row.name + ' ' + (row.scopes || []).join(' ') + ' ' + (row.scopes && row.scopes.length ? '' : '全部字段') + (row.mark ? ' #表' : ''))
            : hasSuffix ? (row.name + ' ' + (row.spec ? (typeof F.suffixTextOf === 'function' ? F.suffixTextOf(row.spec) : '') : '')) : row.name;

          /* ---------- 指向面板：可搜索 + 多选；行里与「批量」共用这一份 ---------- */
          const scopePanel = h('div', { class: 'kh-scope-panel', hidden: true });
          const scopeTitle = h('span', { class: 'kh-scope-title' });
          const scopeClose = h('button', { class: 'kh-mini-btn kh-scope-close', type: 'button', text: '×', title: '收起' });
          const scopeSearch = h('input', {
            class: 'kh-input kh-scope-search', type: 'search',
            placeholder: '搜索抓取字段（没配置就去「抓取后续字段」里加）'
          });
          const scopeAll = h('input', { type: 'checkbox' });
          const scopeListEl = h('div', { class: 'kh-scope-list' });
          const scopeHint = h('span', { class: 'kh-scope-hint', text: '勾选即时生效' });
          const bulkReplace = h('button', { class: 'kh-btn kh-btn-primary kh-scope-op', type: 'button', text: '替换选中' });
          const bulkAppend = h('button', { class: 'kh-btn kh-scope-op', type: 'button', text: '追加到选中' });
          let scopeMode = 'single';        // single = 改某一行；bulk = 改勾选的所有行
          let scopeTarget = null;
          const scopeBoxes = [];
          const scopeChecked = () => scopeBoxes.filter((b) => b.cb.checked).map((b) => b.name);
          const scopeApply = (targets, mode2) => {
            let n = 0;
            for (const row of targets) {
              const next = scopeAll.checked ? [] : scopeChecked();
              if (mode2 === 'append') {
                const uniq = (row.scopes || []).slice();
                for (const v of next) if (uniq.indexOf(v) < 0) uniq.push(v);
                row.scopes = uniq;
              } else {
                row.scopes = next.slice();
              }
              row.dirty = true;
              if (row._scopeBtn) row._scopeBtn.textContent = scopeLabel(row);
              n += 1;
            }
            if (n) dirty = true;
            syncCount();
            return n;
          };
          const refreshScopeBoxes = (cur) => {
            scopeAll.checked = !(cur && cur.length);
            for (const b of scopeBoxes) b.cb.checked = !!(cur && cur.indexOf(b.name) >= 0);
          };
          const openScope = (target) => {
            scopeMode = target === 'bulk' ? 'bulk' : 'single';
            scopeTarget = target;
            scopeTitle.textContent = scopeMode === 'bulk'
              ? ('指向 · 已选 ' + pickedRows().length + ' 条')
              : ('指向 · ' + (target.name || '（未命名）'));
            refreshScopeBoxes(scopeMode === 'bulk' ? [] : (target.scopes || []));
            scopeSearch.value = '';
            for (const b of scopeBoxes) b.el.hidden = false;
            scopeHint.hidden = scopeMode === 'bulk';
            bulkReplace.hidden = scopeMode !== 'bulk';
            bulkAppend.hidden = scopeMode !== 'bulk';
            scopePanel.hidden = false;
          };
          scopePanel.appendChild(h('div', { class: 'kh-scope-head' }, [scopeTitle, scopeClose]));
          scopePanel.appendChild(h('div', { class: 'kh-scope-tools' }, [scopeSearch,
            h('label', { class: 'kh-scope-opt kh-scope-all' }, [scopeAll, h('span', { text: '全部字段（不限定）' })])]));
          scopePanel.appendChild(scopeListEl);
          scopePanel.appendChild(h('div', { class: 'kh-scope-foot' }, [scopeHint, bulkReplace, bulkAppend]));
          for (const k of known) {
            const cb = h('input', { type: 'checkbox' });
            const lab = h('label', { class: 'kh-scope-opt' }, [cb, h('span', { text: k })]);
            cb.addEventListener('change', () => {
              if (cb.checked) scopeAll.checked = false;
              if (scopeMode === 'single' && scopeTarget) scopeApply([scopeTarget], 'replace');
              /* 最后一个字段也取消勾选 ⇒ 语义回到「全部字段」：把复选框同步成勾上，
               * 否则行摘要写「全部字段」、面板却一个勾都没有，看着像坏了。 */
              if (!scopeChecked().length) scopeAll.checked = true;
            });
            scopeBoxes.push({ cb: cb, name: k, el: lab });
            scopeListEl.appendChild(lab);
          }
          if (!known.length) {
            scopeListEl.appendChild(h('div', { class: 'kh-list-empty', text: '还没配置「抓取后续字段」，现在只能设为全部字段。' }));
          }
          scopeAll.addEventListener('change', () => {
            if (!scopeAll.checked) {
              /* 取消「全部字段」但一个字段都没选 ⇒ 视为仍不限定，避免落到"永远不命中"的怪状态 */
              scopeAll.checked = true;
              return;
            }
            for (const b of scopeBoxes) b.cb.checked = false;
            if (scopeMode === 'single' && scopeTarget) scopeApply([scopeTarget], 'replace');
          });
          scopeSearch.addEventListener('input', () => {
            const q = String(scopeSearch.value == null ? '' : scopeSearch.value).trim().toLowerCase();
            for (const b of scopeBoxes) b.el.hidden = !!q && b.name.toLowerCase().indexOf(q) < 0;
          });
          scopeClose.addEventListener('click', () => { scopePanel.hidden = true; });
          bulkReplace.addEventListener('click', () => {
            const list = pickedRows();
            if (!list.length) { D().toast('先勾选要改的条目'); return; }
            scopeApply(list, 'replace');
            scopePanel.hidden = true;
          });
          bulkAppend.addEventListener('click', () => {
            const list = pickedRows();
            if (!list.length) { D().toast('先勾选要改的条目'); return; }
            scopeApply(list, 'append');
            scopePanel.hidden = true;
          });

          /* ---------- 抓取字段后缀：结构化编辑（不再手敲 #图3 / ^[复制] / %1-3） ---------- */
          const buildSuffix = (row) => {
            const sp = row.spec;
            const detail = h('div', { class: 'kh-lrow-detail', hidden: true });
            const modeSel = h('select', { class: 'kh-input kh-sfx-mode' }, [
              h('option', { value: 'default', text: '右邻这一格' }),
              h('option', { value: '#1', text: '右邻一格（#1）' }),
              h('option', { value: '#图', text: '只要图片（#图）' }),
              h('option', { value: '#图N', text: '图片，最多 N 张（#图N）' }),
              h('option', { value: '#N', text: '图上文字与图，最多 N 张（#N）' }),
              h('option', { value: '#0', text: '不要图片（#0）' })
            ]);
            const imgN = h('input', { class: 'kh-input kh-sfx-num', type: 'number', min: '1', step: '1', value: String(sp.imgLimit || 2) });
            const offsetInp = h('input', { class: 'kh-input kh-sfx-offset', type: 'text', value: String(sp.offset || ''), placeholder: '留空＝右邻；如 2 或 1-3' });
            const anchorInp = h('input', { class: 'kh-input kh-sfx-anchor', type: 'text', value: String(sp.anchor || ''), placeholder: '如 [复制]：只取它之前的文字' });
            const sliceMode = h('select', { class: 'kh-input kh-sfx-slice' }, [
              h('option', { value: 'none', text: '不截取' }),
              h('option', { value: 'first', text: '取前 N 字' }),
              h('option', { value: 'range', text: '取第 a–b 字' })
            ]);
            const sliceA = h('input', { class: 'kh-input kh-sfx-num', type: 'number', min: '1', step: '1', value: '1' });
            const sliceB = h('input', { class: 'kh-input kh-sfx-num', type: 'number', min: '1', step: '1', value: '3' });
            const stripCb = h('input', { type: 'checkbox' });
            stripCb.checked = !!sp.stripSpace;
            /* 【2.0.8.8 需求④】内容格「不完整展示」：只影响卡片里的显示（折 3 行、悬停看全文），
             * 抓到的值一个字不改。存进字段串的 `~` 后缀里，老配置没有它 ⇒ 默认完整展示。 */
            const clipCb = h('input', { type: 'checkbox' });
            clipCb.checked = !!sp.clip;
            /* 【2.0.8.12 需求①】内容格做成超链接：`*` 后缀。值本身是网址就直链；
             * 想拼成别的地址（例如包名 → 应用市场页）就在模板里写 `{v}`，值会被 URL 编码后填进去。 */
            const linkCb = h('input', { type: 'checkbox' });
            linkCb.checked = !!sp.link;
            const linkTplInp = h('input', {
              class: 'kh-input kh-sfx-link', type: 'text',
              value: String(sp.linkTpl || ''),
              placeholder: '可选：https://example.com/?q={v}'
            });
            linkTplInp.hidden = !sp.link;
            const sampleInp = h('input', { class: 'kh-input kh-sfx-sample', type: 'text', placeholder: '粘贴一格真实文字，试一下取到的是什么' });
            const previewOut = h('span', { class: 'kh-sfx-out is-empty', text: '取到的值会显示在这里' });
            /* 初始态：storage 里的后缀 → 表单控件 */
            let mode = 'default';
            if (sp.noImg) mode = '#0';
            else if (sp.imgOnly) mode = sp.imgLimit ? '#图N' : '#图';
            else if (sp.imgLimit) mode = '#N';
            else if (sp.simple) mode = '#1';
            modeSel.value = mode;
            const sm = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(sp.sliceSpec || ''));
            const sf = /^\s*(\d+)\s*$/.exec(String(sp.sliceSpec || ''));
            if (sm) { sliceMode.value = 'range'; sliceA.value = sm[1]; sliceB.value = sm[2]; }
            else if (sf) { sliceMode.value = 'first'; sliceA.value = sf[1]; }
            const group = (label, kids) => h('div', { class: 'kh-sfx-group' }, [
              h('div', { class: 'kh-sfx-label', text: label })
            ].concat(kids));
            const paintPreview = () => {
              const sample = String(sampleInp.value == null ? '' : sampleInp.value);
              if (!sample) {
                previewOut.textContent = '取到的值会显示在这里';
                previewOut.className = 'kh-sfx-out is-empty';
                return;
              }
              const it = Object.assign({}, sp, { label: row.name });
              const val = (typeof F.previewValue === 'function') ? F.previewValue(sample, it) : sample;
              previewOut.textContent = '原文 → ' + (String(val) === '' ? '（空）' : String(val));
              previewOut.className = 'kh-sfx-out';
            };
            const syncNums = () => {
              const m = modeSel.value;
              imgN.hidden = !(m === '#图N' || m === '#N');
              const sm2 = sliceMode.value;
              sliceA.hidden = sm2 === 'none';
              sliceB.hidden = sm2 !== 'range';
            };
            const compose = () => {
              const m = String(modeSel.value || 'default');
              sp.noImg = m === '#0';
              sp.imgOnly = (m === '#图' || m === '#图N');
              sp.simple = m === '#1';
              const n = Math.max(0, parseInt(imgN.value, 10) || 0);
              sp.imgLimit = (m === '#图N' || m === '#N') ? n : 0;
              sp.offset = String(offsetInp.value == null ? '' : offsetInp.value).replace(/\s+/g, '');
              sp.offsetInvalid = false;
              sp.stripSpace = !!stripCb.checked;
              sp.clip = !!clipCb.checked;
              sp.link = !!linkCb.checked;
              sp.linkTpl = String(linkTplInp.value == null ? '' : linkTplInp.value).trim();
              linkTplInp.hidden = !sp.link;
              sp.anchor = String(anchorInp.value == null ? '' : anchorInp.value).trim();
              const sm3 = sliceMode.value;
              sp.sliceSpec = sm3 === 'none' ? '' : sm3 === 'first'
                ? String(sliceA.value == null ? '' : sliceA.value).trim()
                : (String(sliceA.value == null ? '' : sliceA.value).trim() + '-' + String(sliceB.value == null ? '' : sliceB.value).trim());
              row.dirty = true;
              dirty = true;
              syncNums();
              paintPreview();
              if (row._suffixBtn) {
                row._suffixBtn.textContent = (typeof F.describeSuffix === 'function')
                  ? ('取值：' + (F.describeSuffix(sp) || '默认（右邻这一格）'))
                  : ('后缀：' + ((typeof F.suffixTextOf === 'function' ? F.suffixTextOf(sp) : '') || '无'));
                row._suffixBtn.title = '当前写法：' + ((typeof F.suffixTextOf === 'function' ? F.suffixTextOf(sp) : '') || '无');
              }
            };
            modeSel.addEventListener('change', compose);
            imgN.addEventListener('input', compose);
            offsetInp.addEventListener('input', compose);
            anchorInp.addEventListener('input', compose);
            sliceMode.addEventListener('change', compose);
            sliceA.addEventListener('input', compose);
            sliceB.addEventListener('input', compose);
            stripCb.addEventListener('change', compose);
            clipCb.addEventListener('change', compose);
            linkCb.addEventListener('change', compose);
            linkTplInp.addEventListener('input', compose);
            sampleInp.addEventListener('input', paintPreview);
            syncNums();
            paintPreview();
            detail.appendChild(h('div', { class: 'kh-sfx-grid' }, [
              group('取哪一格', [modeSel, imgN]),
              group('值格位置 @', [offsetInp]),
              group('取什么内容', [anchorInp, sliceMode, sliceA, sliceB,
                h('label', { class: 'kh-sfx-check' }, [clipCb, h('span', { text: '内容格只显示一行（悬停看全文）' })]),
                h('label', { class: 'kh-sfx-check' }, [linkCb, h('span', { text: '内容格做成超链接（值是网址就直链；也可在下面写模板）' })]),
                linkTplInp
              ]),
              group('怎么清理', [h('label', { class: 'kh-sfx-check' }, [stripCb, h('span', { text: '去掉内部空白（包名这类用）' })])])
            ]));
            detail.appendChild(h('div', { class: 'kh-sfx-preview' }, [sampleInp, previewOut]));
            return detail;
          };

          /* ---------- 行 ---------- */
          function buildRow(row) {
            const cb = h('input', { class: 'kh-list-cb', type: 'checkbox' });
            cb.checked = !!row.picked;
            cb.addEventListener('change', () => { row.picked = !!cb.checked; syncCount(); });
            row._cb = cb;
            const nameInp = h('input', {
              class: 'kh-input kh-list-val', type: 'text', value: row.name,
              placeholder: isTok ? '字段名' : '词条'
            });
            nameInp.addEventListener('input', () => {
              row.name = String(nameInp.value == null ? '' : nameInp.value);
              if (row.spec) row.spec.label = row.name;
              row.dirty = true;
              dirty = true;
            });
            nameInp.addEventListener('keydown', (ev) => {
              if (!ev) return;
              if (ev.key === 'Enter') {
                if (typeof ev.preventDefault === 'function') ev.preventDefault();
                addRow(null, row);
              } else if (ev.key === 'Backspace' && !nameInp.value) {
                /* 空行退格＝删掉这一行（表格控件的老手感，省得去够右边的 ✕） */
                if (typeof ev.preventDefault === 'function') ev.preventDefault();
                dropRow(row);
              }
            });
            const main = h('div', { class: 'kh-lrow-main' }, [cb, nameInp]);
            if (isKv) {
              const scopeBtn = h('button', { class: 'kh-mini-btn kh-lrow-scope', type: 'button', text: scopeLabel(row) });
              scopeBtn.title = '这个词对哪些抓取字段的图生效（可多选）';
              scopeBtn.addEventListener('click', () => openScope(row));
              row._scopeBtn = scopeBtn;
              /* 【2.0.8.7 需求②】「进表」不再是一颗只在弹窗里的小 `#表` 按钮，改成明面上的勾选列：
               * 每行一个 `进表` 勾选框，勾没勾一眼可见、批量也走同一份状态（用户原话：
               * 「图片命中词、图片动态命中词，进表与否似乎不能修改（全部默认填的进表，而且不能修改）」）。
               * 存储口径不变：勾上 = 词尾写 `#表`，见 `kvPatch`。 */
              const markCb = h('input', { class: 'kh-lrow-mark-cb', type: 'checkbox' });
              markCb.checked = !!row.mark;
              const markLab = h('label', { class: 'kh-lrow-mark' + (row.mark ? ' is-on' : '') }, [
                markCb, h('span', { class: 'kh-lrow-mark-t', text: '进表' })
              ]);
              markLab.title = '勾上：图里「这个词：值」会并进重要笔记的抓取表；不勾：只做命中判定';
              const paintMark = () => {
                if (markCb.checked !== !!row.mark) markCb.checked = !!row.mark;
                markLab.classList.toggle('is-on', !!row.mark);
              };
              markCb.addEventListener('change', () => {
                row.mark = !!markCb.checked;
                row.dirty = true;
                dirty = true;
                paintMark();
              });
              row._markCb = markCb;
              row._markLab = markLab;
              row._paintMark = paintMark;
              main.appendChild(scopeBtn);
              main.appendChild(markLab);
            }
            let detail = null;
            if (hasSuffix) {
              const sfxBtn = h('button', {
                class: 'kh-mini-btn kh-lrow-suffix', type: 'button',
                text: (typeof F.describeSuffix === 'function' ? ('取值：' + (F.describeSuffix(row.spec) || '默认（右邻这一格）')) : ('后缀：' + ((typeof F.suffixTextOf === 'function' ? F.suffixTextOf(row.spec) : '') || '无'))),
                title: '展开设置取值方式（当前写法：' + ((typeof F.suffixTextOf === 'function' ? F.suffixTextOf(row.spec) : '') || '无') + '）'
              });
              sfxBtn.title = '点开展开后缀设置（不用手敲 # 与 %）';
              detail = buildSuffix(row);
              row._suffixBtn = sfxBtn;
              sfxBtn.addEventListener('click', () => {
                detail.hidden = !detail.hidden;
                sfxBtn.classList.toggle('is-open', !detail.hidden);
              });
              main.appendChild(sfxBtn);
            }
            const del = h('button', { class: 'kh-mini-btn kh-list-del', type: 'button', text: '×', title: '删掉这一条' });
            del.addEventListener('click', () => dropRow(row));
            main.appendChild(del);
            return h('div', { class: 'kh-lrow' + (isTok ? ' kh-lrow-tok' : '') }, detail ? [main, detail] : [main]);
          }

          function renderAll() {
            listEl.textContent = '';
            for (const row of rows) {
              if (row.gone) continue;
              row.el = buildRow(row);
              listEl.appendChild(row.el);
            }
            if (!alive().length) {
              listEl.appendChild(h('div', { class: 'kh-list-empty', text: '还没有条目，在下面输入后回车添加' }));
            }
            applyFilter();
            syncCount();
          }

          function addRow(data, afterRow) {
            const row = Object.assign({
              orig: -1, gone: false, dirty: true, isNew: true, picked: false, el: null, name: ''
            }, data || {});
            if (isKv) {
              row.scopes = (row.scopes || []).slice();
              row.mark = !!row.mark;
              if (spec.suffixChip && !row.spec) row.spec = specOf(row.name || '');
            }
            if (isTok && !row.spec) row.spec = specOf(row.name || '');
            const at = afterRow ? rows.indexOf(afterRow) : rows.length - 1;
            rows.splice(at + 1, 0, row);
            row.el = buildRow(row);
            if (afterRow && afterRow.el && afterRow.el.parentNode) {
              afterRow.el.parentNode.insertBefore(row.el, afterRow.el.nextSibling);
            } else {
              listEl.appendChild(row.el);
            }
            const empty = listEl.querySelector ? listEl.querySelector('.kh-list-empty') : null;
            if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
            dirty = true;
            applyFilter();
            syncCount();
            const focusInp = row.el.querySelector ? row.el.querySelector('.kh-list-val') : null;
            if (focusInp && typeof focusInp.focus === 'function') { try { focusInp.focus(); } catch (e) { /* 隐藏时忽略 */ } }
            return row;
          }

          function dropRow(row) {
            if (!row || row.gone) return;
            row.gone = true;
            row.dirty = true;
            dirty = true;
            if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
            if (!alive().length) renderAll();
            syncCount();
          }

          function applyFilter() {
            const q = String(filter.value == null ? '' : filter.value).trim().toLowerCase();
            for (const row of rows) {
              if (!row.el) continue;
              row.el.hidden = !!row.gone || (!!q && rowText(row).toLowerCase().indexOf(q) < 0);
            }
          }

          const pick = (mode2) => {
            for (const row of rows) {
              if (row.gone || (row.el && row.el.hidden)) continue;
              row.picked = mode2 === 'inv' ? !row.picked : true;
              if (row._cb) row._cb.checked = row.picked;
            }
            syncCount();
          };
          const mkBtn = (label, onClick, title) => {
            const b = h('button', { class: 'kh-mini-btn kh-list-op', type: 'button', text: label });
            if (title) b.title = title;
            b.addEventListener('click', onClick);
            return b;
          };
          const dropPicked = () => {
            const list = pickedRows();
            if (!list.length) { D().toast('先勾选要删的条目'); return; }
            for (const row of list) { row.gone = true; row.dirty = true; }
            dirty = true;
            renderAll();
            if (!scopePanel.hidden) scopePanel.hidden = true;
          };
          const forPicked = (fn) => {
            const list = pickedRows();
            if (!list.length) { D().toast('先勾选要改的条目'); return; }
            for (const row of list) fn(row);
            dirty = true;
            syncCount();
          };
          const ops = [mkBtn('删除选中', dropPicked, '只删勾选的条目，其他条目不受影响')];
          if (isKv) {
            ops.unshift(mkBtn('指向…', () => {
              if (!pickedRows().length) { D().toast('先勾选要改的条目'); return; }
              openScope('bulk');
            }, '给勾选的词设置 @指向：可搜索、可多选，也可以设为全部字段'));
            ops.unshift(mkBtn('设为全部字段', () => {
              forPicked((row) => {
                row.scopes = [];
                if (row._scopeBtn) row._scopeBtn.textContent = scopeLabel(row);
              });
            }, '去掉 @指向：这些词对抓到的所有图都算命中'));
            ops.unshift(mkBtn('取消进表', () => {
              forPicked((row) => { row.mark = false; if (row._paintMark) row._paintMark(); });
            }));
            ops.unshift(mkBtn('设为进表', () => {
              forPicked((row) => { row.mark = true; if (row._paintMark) row._paintMark(); });
            }, '勾上后：图里「这个词：值」会并进重要笔记的抓取表'));
          }
          const opsBar = h('div', { class: 'kh-list-ops' }, ops);

          const addFromInput = () => {
            const v = String(addInp.value == null ? '' : addInp.value).trim();
            if (!v) { D().toast('先输入要添加的条目'); return; }
            if (isKv) {
              const add = kvRows(v, known);
              if (!add.length) { D().toast('这个词读不出名字'); return; }
              for (const o of add) {
                if (spec.suffixChip) {
                  const sp = specOf(o.name);
                  addRow({ name: sp.label, spec: sp, scopes: o.scopes, mark: o.mark });
                } else addRow({ name: o.name, scopes: o.scopes, mark: o.mark });
              }
            } else if (isTok) {
              for (const one of split(v)) { const sp = specOf(one); addRow({ name: sp.label, spec: sp }); }
            } else {
              for (const one of split(v)) addRow({ name: one });
            }
            addInp.value = '';
            try { addInp.focus(); } catch (e) { /* 垫片没有 focus */ }
          };
          addInp.addEventListener('keydown', (ev) => {
            if (!ev || ev.key !== 'Enter') return;
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            addFromInput();
          });
          filter.addEventListener('input', applyFilter);

          const addBtn2 = h('button', { class: 'kh-btn kh-list-addbtn', type: 'button', text: '添加' });
          addBtn2.addEventListener('click', addFromInput);

          const serialize = (row) => {
            const name = String(row.name == null ? '' : row.name).trim();
            if (!name) return '';
            if (isKv) {
              /* 存储顺序：字段名 + 取值后缀 + @指向 + #表（`splitScope` 先剥 #表、再从末尾剥 @，
               * 剩下的整段才交给 `parseLabelSpec` —— 写成别的顺序就读不回来）。 */
              const full = name + (row.spec ? suffixOf(row.spec) : '');
              const t = kvPatch({ name: full, scopes: row.scopes, mark: row.mark }, { scopes: row.scopes, mark: row.mark });
              return t == null ? '' : t;
            }
            if (isTok) return name + suffixOf(row.spec);
            return name;
          };

          const tip = isKv
            ? '每行一条；「指向」用可搜索多选设置，#表 表示命中后并入抓取表。没改过的条目保存时原样保留。'
            : isTok
              ? '每行一个抓取字段；后缀点「后缀」展开设置，不用手敲 #图3 / ^[复制] / %1-3；勾「不完整展示」= 内容格折 3 行。'
              : '每行一条，保存时用 | 连接。';
          const body = h('div', { class: 'kh-list-box' }, [
            h('div', { class: 'kh-list-toolbar' }, [
              filter,
              mkBtn('全选', () => pick('all')),
              mkBtn('反选', () => pick('inv')),
              countEl
            ]),
            h('div', { class: 'kh-list-addbar' }, [addInp, addBtn2]),
            scopePanel,
            opsBar,
            listEl,
            h('div', { class: 'kh-list-foot' }, [h('span', { class: 'kh-list-tip', text: tip })]),
            isTok ? legendEl() : null
          ]);
          renderAll();
          listModal = ui.Modal.open({
            title: spec.label + ' · 修改',
            body,
            size: 'md',
            /* 页面里的「快速添加」把编辑器挂在 ShadowRoot 上：列表弹窗必须跟着挂进去，
             * 否则会落到 document.body 上、拿不到组件样式（被页面样式冲掉）。 */
            mount: (() => {
              try {
                const r = (typeof box.getRootNode === 'function') ? box.getRootNode() : null;
                return (r && r !== document && r.host) ? r : null;
              } catch (e) { return null; }
            })(),
            saveLabel: '保存',
            onSave: () => {
              if (!dirty) return true;                 // 没动过 ⇒ 不写回，原串一个字节都不碰
              const live = alive();
              const hasNew = live.some((r) => r.isNew);
              let out;
              if (hasNew) {
                /* 有新增行 ⇒ 顺序只能整串重排（新增行按当前显示顺序插进末尾段） */
                out = live.map(serialize).filter(Boolean).join('|');
              } else {
                const next = rows.map((r) => {
                  if (r.orig < 0) return null;
                  if (r.gone) return '';
                  return r.dirty ? serialize(r) : null;
                });
                out = kvApply(origRaw, origRows, next);
                /* `kvApply` 找不到原片段时退回 `join('|')`：这里再兜一道，别把空段写进存储 */
                if (/(^|[|｜])\s*([|｜]|$)/.test(out) && live.length) out = live.map(serialize).filter(Boolean).join('|');
              }
              st.raw = out;
              st.editIdx = -1;
              inp.value = '';
              draw();
              st.notify();
              return true;
            }
          });
          return listModal;
        };
        /** 已配置的抓取字段裸名 —— 作用域的**唯一合法取值**（取同表单「抓取后续字段」控件现算）。
         *  查找必须落在**控件自己的根**上：页面编辑器的弹窗挂在 Shadow DOM 里，
         *  `document.getElementById` 在那边永远找不到（那会让 `@字段` 全被当成普通词）。
         *  取不到（单测垫片没有真的 `getElementById` / 控件还没挂进表单）⇒ 空表 ⇒ 所有 `@…`
         *  都按普通词处理，正是"老配置零影响"要的行为，也保证这条路永不抛。 */
        const knownFields = () => {
          try {
            let root = document;
            try {
              const r = (typeof box.getRootNode === 'function') ? box.getRootNode() : null;
              if (r && r !== document && typeof r.getElementById === 'function') root = r;
            } catch (e) { root = document; }
            const wantId = (c.idPrefix || 'fld-') + 'fetchLabels';
            /* 【2.0.7.2 需求①·根因】候选框的真实值在**框的 `data-raw`** 上（胶囊态时那个
             * `input` 是空的）。原来只读 `el.value` ⇒ 恒空 ⇒ 下拉框灰、`@字段` 不算作用域。
             * 先找 `[data-for=id]` 的框面（`cands`/`labels` 都挂这个钩子），取不到再退回 `input.value`。 */
            let raw = '';
            try {
              const face = (root && typeof root.querySelector === 'function')
                ? root.querySelector('[data-for="' + wantId + '"]') : null;
              if (face && typeof face.getAttribute === 'function') raw = String(face.getAttribute('data-raw') || '');
            } catch (e) { raw = ''; }
            if (!raw) {
              const el = (root && typeof root.getElementById === 'function') ? root.getElementById(wantId) : null;
              if (el) raw = String(el.value == null ? '' : el.value);
            }
            const F = KH.Fetch;
            if (!raw || !F || typeof F.parseLabels !== 'function') return [];
            const out = [];
            for (const it of (F.parseLabels(raw) || [])) {
              const n = String((it && it.label) || '').trim();
              if (n && out.indexOf(n) < 0) out.push(n);
            }
            return out;
          } catch (e) { return []; }
        };
        if (listBtn) {
          listBtn.addEventListener('click', (ev) => {
            if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
            openList();
          });
        }
        /* 框面本身也可点（像真输入框那样"点哪儿都能开始录入"）；胶囊与 `+` 各自有主，别抢它们的活。
         * `closest('...[kh-]...')` 在本仓库是机械红线（meta-check），祖先查找统一走 `dom.js` 的 `upClass`
         * （票 #52：这一圈原先与 `rich-editor.js` 各手写了一份）。`frame` 是边界 —— 框里的胶囊算"点了框"，
         * 框外的同 class 一律不算。 */
        const inNode = (t, cls) => !!D().upClass(t, cls, frame);
        frame.addEventListener('click', (ev) => {
          if (inNode(ev.target, 'kh-lbl-chip') || inNode(ev.target, 'kh-cand-add')) return;
          /* 禁用态（`setDisabled` 只把 input 设成 disabled，不像富文本那样有点击拦截）：进去也打不了字 ⇒ 不进 */
          if (box.classList.contains('is-disabled')) return;
          /* 列表模式：点框面任意位置（含胶囊）＝打开「修改」弹窗；不再有行内文本态 */
          if (spec.listEdit) { openList(); return; }
          /* 【2.0.2.16 需求②】点框面空白处 = **还原成文本**（不再是"新录一个候选"）：
           * 常态胶囊适合逐个改，整串改（粘贴、看全、调顺序）需要一行能直接编辑的文本。
           * 新录一个候选仍然有入口 —— 右边那颗 `+`。 */
          enterText();
        });
        /* 回车 = "这一段录完了"：收进 `raw` 并清空输入框（与「字段」控件同一手感）。
         * 浮层由 `attachPop` 那颗 keydown 监听顺手关掉，这里只管把值收好。 */
        inp.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          /* 文本态：回车就是把这一整串收成胶囊（`|` 切段），与浮层里"回车收这一段"同一手感 */
          if (textMode) { if (typeof ev.preventDefault === 'function') ev.preventDefault(); exitText(); st.notify(); return; }
          st.commit(); draw(); st.notify();
        });
        /* 文本态那块 textarea：回车收（**不换行** —— `|` 才是分隔符，换行没有语义）、Esc 放弃这次改动、边打边长高 */
        ta.addEventListener('keydown', (ev) => {
          if (!ev) return;
          if (ev.key === 'Enter') {
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            exitText(); st.notify();
          } else if (ev.key === 'Escape') {
            ta.value = st.raw == null ? '' : String(st.raw);
            exitText(); st.notify();
          }
        });
        ta.addEventListener('input', () => { autoGrow(); });
        /* 文本态下点框外 / 滚走 / 关弹窗都会先 blur：值先落盘，别让用户的输入停在"没提交"的状态 */
        inp.addEventListener('blur', () => { if (textMode) { exitText(); st.notify(); } });
        ta.addEventListener('blur', () => { if (textMode) { exitText(); st.notify(); } });
        draw();
        return {
          el: box,
          /* 文本态下 `ta.value` **就是**整串（再走 `st.displayRaw()` 会把待定段多拼一遍 ⇒ 值重复），
           * 所以这一支单独读；两种态的返回值都是"整串原文"（存储契约不变）。 */
          read: () => (textMode ? String(ta.value == null ? '' : ta.value) : st.displayRaw()),
          key: spec.key,
          /* 供外层（关键词弹窗）把「正则」开关的真值告诉它，并在开关翻动时重画 */
          _repaint: (on) => { if (typeof on === 'boolean') modeOn = on; draw(); },
          /* 列表修改入口（`listEdit` 的五个候选框才有；原来是「修改」+「批量」两个弹窗） */
          _list: spec.listEdit ? openList : null
        };
      }
      default: {
        /* `placeholder: spec.placeholder`（**不兜 `|| ''`**）：没声明占位的字段就**真的没有**
         * 这个属性 —— `h()` 对 null/undefined 直接跳过（dom.js）。写成 `''` 会在 DOM 里
         * 留下一个空 placeholder，C4 的判定（"空值时不再恒显占位"）就没法用属性判死了；
         * 渲染效果一样（空串也什么都不显示），但语义干净。 */
        const inp = h('input', { class: 'kh-input', type: 'text', id: id, value: value == null ? '' : String(value), placeholder: spec.placeholder });
        return { el: fieldBox(spec.label + (spec.required ? ' *' : ''), inp), read: () => inp.value, key: spec.key };
      }
    }
  }

  /**
   * 「已确定整串 + 一段待定文本」的状态机（票 #52：`labels` 与 `cands` 曾各写一份逐字相同的实现，
   * 改一处必忘另一处）。两分支**唯一**的差别是**怎么切段** —— `split` 由调用方注入：
   * 标签按分隔符 + 后缀解析、候选按正则模式的 `|`；其余（编辑中段号、预览整串、提交、改动通知）
   * 必须一模一样，否则两个控件手感各走一路。
   * 为什么返回对象而不是闭包变量：`draw()` 里要改段号、要换整串（`st.editIdx = i` / `st.raw = …`）。
   */
  function segEditor(inp, split, initial) {
    const st = { raw: initial == null ? '' : String(initial), editIdx: -1 };   // ≥0 = 正在改第几段
    const parts = () => (String(st.raw).length ? split(st.raw) : []);
    const pending = () => (String(inp.value).length ? split(inp.value) : []);
    st.parts = parts;
    /** 当前"会存下去"的整串：没有待定/编辑 ⇒ 原样返回 `raw`（一个字都不动）。 */
    st.displayRaw = () => {
      const t = pending();
      if (st.editIdx < 0 && !t.length) return st.raw;
      const list = parts();
      if (st.editIdx >= 0) list.splice(st.editIdx, 1, ...t);
      else for (const one of t) list.push(one);
      return list.join('|');
    };
    /** 把待定内容收进 `raw` 并清空输入框（回车、点胶囊、✕ 之前都先落一下，段序号才稳定）。 */
    st.commit = () => { st.raw = st.displayRaw(); st.editIdx = -1; inp.value = ''; };
    /** 让外层（弹窗的"改动过"标记等）也收到一次改动通知；调度器不支持就算了。 */
    st.notify = () => {
      try { if (typeof inp.dispatchEvent === 'function') inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* 无 Event 构造器：上面的 draw() 已经画好了 */ }
    };
    return st;
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
  /** 「添加关键词」里 kv 词条的**显示名**：去掉 `@指向字段`、`#表` 与后缀，只留词条本身。
   *  存储串一个字节不动 —— 这是纯展示口径（用户 m00625：指向只在「修改」弹窗里看）。 */
  function kvDisplayName(raw) {
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(/(?:#|＃)\s*(?:表|kv)\s*$/i, '').trim();
    for (;;) {
      const m = /@\s*([^@\s]+)$/.exec(s);
      if (!m) break;
      s = s.slice(0, m.index).trim();
    }
    const F = KH.Fetch;
    if (F && typeof F.parseLabelSpec === 'function') {
      try {
        const sp = F.parseLabelSpec(s);
        if (sp && sp.label) return String(sp.label).trim();
      } catch (e) { /* 退回裸串 */ }
    }
    return s;
  }

  function labelSegs(raw, opts) {
    const F = KH.Fetch;
    const s = raw == null ? '' : String(raw);
    const kv = !!(opts && opts.kv);
    const toks = (F && typeof F.splitLabelTokens === 'function') ? F.splitLabelTokens(s) : [s];
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      /* 【2.0.7.1 需求③】`#表` 是「这个命中词要往重要笔记的抓取表补行」的标记，不是名字的一部分；
       * 剥成徽标才看得见"词是词、标记是标记"（此前它跟着词一起当名字，和隔壁框的后缀画法两副面孔）。 */
      if (kv) {
        const m = /(?:#|＃)\s*(?:表|kv)\s*$/i.exec(String(tok));
        if (m) {
          const name = String(tok).slice(0, m.index).trim();
          if (name) { out.push({ i: i, raw: tok, name: name, suffix: '#表' }); continue; }
        }
      }
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

  /* ==========================================================================
   * 【需求】「图片命中关键词 / 图片动态关键词」词条的**批量解析与写回**
   * --------------------------------------------------------------------------
   * 用户原话：「这个词多时候不会管理。最好能够批量处理（批量改通用，还是针对某个字段抓取到的
   * 图片。#表，也是最好能批量修改。）」
   *
   * **口径只有一份**：`#表` 必须挂在词条**最末**，`@字段名` 只有命中**已配置的抓取字段裸名**
   * 才算作用域（否则整段当普通词 ⇒ 老配置零影响）—— 这就是 `src/features/img-ocr.js` 的
   * `kvChips` / `splitScope` 那两条语义。这里镜像成同一套纯函数，原因是**管理端拿不到那份实现**：
   * `options.html` 的 script 清单里没有 img-ocr.js。这与 `fetch.js` 里 `normalizeLabels` 的处境
   * 一样（"同一语义的第二个必需实现"，不是漏改）。
   * 锁口径的是 `tests/specs/imgkw-batch.test.js`：把这里的解析结果与 `KH.ImgOcr` 的
   * `scopedRaw / stripKvMarks / kvWords` 链逐条对账 —— 那边改口径，这里当场红。
   * ponytail: 同一语义的第二份实现（约 120 行），天花板是"改 img-ocr 必须同时看这里"；
   *   升级路径：把 img-ocr.js 的纯函数段拆成独立文件（去掉 L1549 的 `KH.features.register`
   *   载入副作用），管理端与内容端共用一份即可删掉这段镜像。
   */
  const KV_MARK_RE = /(?:#|＃)\s*(?:表|kv)\s*$/i;
  const KV_TAIL_SEP_RE = /(?:#|＃)\s*(?:表|kv)([\s,，、;；]+)/gi;
  const KV_AT_RE = /@([^@\s]+)$/;

  /** 切词：与 `img-ocr.js` 的 `kvChips` 同口径（`|`/`｜` 永远切一刀，`#表` 后面跟分隔符也切） */
  function kvChips(raw) {
    const out = [];
    for (const seg of String(raw == null ? '' : raw).split(/[|｜]/)) {
      let rest = seg;
      for (;;) {
        KV_TAIL_SEP_RE.lastIndex = 0;
        const m = KV_TAIL_SEP_RE.exec(rest);
        if (!m) break;
        const at = m.index + m[0].length - m[1].length;
        if (m.index + m[0].length >= rest.length) break;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^[\s,，、;；]+/, '');
        if (!rest) break;
      }
      if (rest) out.push(rest);
    }
    return out.map((c) => c.trim()).filter(Boolean);
  }

  /** 字段名比较：与 `img-ocr.js` 的 `sameField` 同口径（去空白、去首尾、小写） */
  function kvSameField(a, b) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').trim().toLowerCase();
    const x = norm(a);
    return !!x && x === norm(b);
  }

  /**
   * 整串 → 词条行（弹窗列表的数据源）。
   * @param {string} raw 字段原文
   * @param {Array<string>} known 已配置的抓取字段裸名；空表 ⇒ 所有 `@…` 都按普通词
   * @returns {Array<{raw:string, name:string, scope:string, mark:boolean}>}
   *   `raw` 是**原文那一段**（写回时靠它定位，`|` 两侧的空格也因此不会被归一）；
   *   `scope` 取的是 `known` 里的规范值（与 `splitScope` 一致）
   */
  function kvRows(raw, known) {
    const ks = (known || []).filter(Boolean);
    return kvChips(raw).map((chip) => {
      const km = KV_MARK_RE.exec(chip);
      const body = km ? chip.slice(0, km.index) : chip;
      let name = body.trim();
      /* 【2.0.7.2 需求①】一个词**可以连写多个** `@字段名`（`一对一@截图@名称`）：从后往前剥，
       * 只要有一个不是真配过的字段名就停手（剩下那段含 `@` 按普通词，老配置零影响）。
       * 与 img-ocr.js 的 `splitScope` 同口径，门禁在 tests/specs/imgkw-batch.test.js。 */
      const scopes = [];
      for (;;) {
        const at = KV_AT_RE.exec(name);
        if (!at) break;
        let hit = '';
        for (const k of ks) { if (kvSameField(k, at[1])) { hit = k; break; } }
        if (!hit) break;
        if (scopes.indexOf(hit) < 0) scopes.unshift(hit);
        name = name.slice(0, at.index).trim();
      }
      return { raw: chip, name: name, scopes: scopes, scope: scopes.join(','), mark: !!km };
    });
  }

  /**
   * 改一条词条：`@字段` 在前、`#表` 在后（标记必须收尾，否则读的时候不算）。
   * @param {object} row `kvRows` 的一行
   * @param {{scope:*, mark:*}} o 省略的键＝保留原样；`scope` 给 `null`/`''` ＝ 设为通用
   * @returns {string|null} 解析不出名字的怪词条返回 null（不参与改写，也不能被抹成空串）
   */
  function kvPatch(row, o) {
    const p = o || {};
    if (!row || !row.name) return null;
    const scopes = (p.scopes === undefined) ? (row.scopes || []) : (p.scopes || []);
    const mark = (p.mark === undefined) ? row.mark : !!p.mark;
    return row.name + scopes.map((s) => '@' + s).join('') + (mark ? '#表' : '');
  }

  /**
   * 写回整串：**只换被点名的那几行，其余一个字不动**（`|` 写法、两侧空格、`｜` 都原位保留）。
   * @param {string} raw 字段原文
   * @param {Array} rowsIn `kvRows(raw, known)` 的结果（顺序即原文顺序）
   * @param {Array<string|null>} next 与 `rowsIn` 等长；`null`/省略＝这一行不动，`''`＝删掉这一行
   *   （连它紧邻的一个分隔符一起收走，否则会留下 `a||c` 这种看着像"空词"的脏数据）
   */
  function kvApply(raw, rowsIn, next) {
    const str = String(raw == null ? '' : raw);
    const list = rowsIn || [];
    const nx = next || [];
    const spans = [];
    let from = 0;
    for (let i = 0; i < list.length; i++) {
      const chip = list[i].raw;
      /* `kvChips` 是按原文顺序切出的独立片段 ⇒ 从上一个片段末尾往后找，命中的必定是本段
       * （同一个词重复出现也对得上：游标已经推过去了）。找不到就退回"按 `|` 重排"。 */
      const at = str.indexOf(chip, from);
      if (at < 0) {
        return list.map((r, k) => (nx[k] == null ? r.raw : nx[k])).join('|');
      }
      const v = nx[i];
      let s0 = at;
      let s1 = at + chip.length;
      if (v === '') {
        const after = /^[ \t]*[|｜][ \t]*/.exec(str.slice(s1));
        if (after) s1 += after[0].length;
        else {
          const before = /[|｜][ \t]*$/.exec(str.slice(0, s0));
          if (before) s0 -= before[0].length;
        }
      }
      if (v != null) spans.push({ s: s0, e: s1, text: v });
      from = at + chip.length;
    }
    if (!spans.length) return str;              // 一个都没改 ⇒ 逐字原样（往返一致靠这一行）
    let out = '';
    let pos = 0;
    for (const sp of spans) { out += str.slice(pos, sp.s) + sp.text; pos = sp.e; }
    return out + str.slice(pos);
  }

  /**
   * 抓取字段后缀 → **落盘语法**（`suffixTextOf` 拼的是给人看的展示串，两者一一对应）。
   * 按 `parseLabelSpec` 剥离顺序倒着写（`#` → `@` → `!` → `^` → `%`）：解析端从末尾逐个剥，
   * 所以这个顺序写出来能被原样读回。空串＝这个字段不写任何后缀。
   */
  function suffixOf(it) {
    if (!it) return '';
    let s = '';
    if (it.noImg) s = '#0';
    else if (it.imgOnly) s = it.imgLimit ? '#图' + it.imgLimit : '#图';
    else if (it.imgLimit) s = '#' + it.imgLimit;
    else if (it.simple) s = '#1';
    if (it.offset) s += '@' + it.offset;
    if (it.stripSpace) s += '!';
    if (it.anchor) s += '^' + it.anchor;
    if (it.sliceSpec) s += '%' + it.sliceSpec;
    return s;
  }

  /**
   * 【2.0.2.7】后缀胶囊的**唯一渲染实现**：`名字 [+ 后缀徽标] [+ ✕]`。
   *
   * 两处都用它：字段控件的「可编辑胶囊列表」（`case 'labels'`）与设置页「重要笔记置顶」
   * （`options.js renderPinOrder`）。原先各写一份 —— 骨架（类名嵌套）是视觉契约，
   * 抄两份迟早漏一处（`components.css` 是样式那半边的单一来源，这里是结构那半边）。
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
    /* `h()` 只跳过 null/undefined（dom.js），写 `''` 会在 DOM 里留一个空 title ⇒ 没值就别写这个键 */
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
   * 【2.0.2.10 票 #58 / 2.0.2.11 票 #63】「后缀怎么写」图例的**唯一实现**：默认收起、点开看全部。
   *
   * 这段 151 字的语法说明常驻时实测 83px / 5 行，会把控件撑高一倍且每眼都要重读一遍；
   * 搬进 `<details>` 后信息一个字不少，默认只占一行。2.0.2.11 起「抓取后续字段」也用它
   * （抓取字段改成了候选词控件，同一套 `#`/`%`/`^` 语法，图例必须同源）。
   *
   * @returns {HTMLElement}
   */
  function legendEl() {
    const h = D().h;
    return h('details', { class: 'kh-lbl-legend' }, [
      h('summary', { text: '后缀怎么写（点开看全部）' }),
      h('div', {
        text: '后缀：#1 右邻一格 / #图 仅图片 / #3 最多 3 张 / #图3 仅图片且最多 3 张 / #0 该字段不要图 / @2 值格 / ! 去空白 / ^锚文本 只取锚点之前 / %4 前 4 字；'
          + '一次写多个字段用 | 或 ｜（例：名称^[复制]|备注#图）；在「修改」弹窗里每行一条，回车添加下一条'
      })
    ]);
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
    let subBox = null;
    let subKey = null;
    /* 【2.0.2.11 票 #64】`toolOf` 的字段**不进正文**：它们要搬进某个富文本的工具栏（B / I / 链接那一排）。
     * 目标找不到（没有富文本，或那棵树里没渲染工具栏）就退回正文 —— 绝不能"消失"。 */
    const toolsOf = new Map();
    for (const it of items) {
      if (!it || !it.spec || !it.spec.toolOf) continue;
      if (!toolsOf.has(it.spec.toolOf)) toolsOf.set(it.spec.toolOf, []);
      toolsOf.get(it.spec.toolOf).push(it);
    }
    /* 【2.0.2.10 票 #56】本卡若有 `grow` 字段（备注 / 笔记内容——列高撑满后要多出来的高度）：
     * 其余字段先排进一个「上半排」容器（照老规则 wrap），body 本身转成**纵向** flex，
     * `grow` 字段独占余下高度。为什么不能纯靠 CSS：body 是 wrap 容器，`align-content: stretch`
     * 会把多出来的高度**平均分给每一行** —— 实测「基本信息」里胶囊行被推离 77px，比原来的死白更难看。 */
    const useGrow = items.some((it) => it.spec.grow);
    let host = null;
    if (useGrow) bodyEl.classList.add('kh-editor-sec-body-grow');
    /* 上半排**按需创建**：整卡只有 grow 字段时（如「重要笔记」只剩笔记正文 + 工具栏三件）
     * 再建一个空容器就成了 0×0 的死节点。 */
    const hostOf = () => {
      if (!host) host = useGrow ? h('div', { class: 'kh-fld-rows' }) : bodyEl;
      return host;
    };
    for (const it of items) {
      const f = it.spec, c = it.ctrl;
      if (f.toolOf) continue;                 // 票 #64：住工具栏的字段，正文里不占位置
      if (f.grow) { chipRow = null; bodyEl.appendChild(c.el); continue; }
      /* 【2.0.2.10 票 #57】`sub` = **子块**：连续的、`sub` 相同的字段收进一个 `.kh-fld-sub`（整行占位）。
       * 图片 OCR 那三件原本是「勾选框 17px / 候选框 49px / 内联数字 24px」三种高度，在
       * `.kh-editor-sec-body{align-items:flex-end}` 下各自换行、底对齐成阶梯，看着像三件不相干的东西。 */
      const sk = f.sub || null;
      if (sk !== subKey) { subKey = sk; subBox = null; }
      if (sk) {
        if (!subBox) {
          subBox = h('div', { class: 'kh-fld-sub', 'data-sub': sk });
          hostOf().appendChild(subBox);
        }
        subBox.appendChild(c.el);
        chipRow = null;
        continue;
      }
      if (f.chip) {
        if (!chipRow) {
          /* 若该行**第一个**字段带 `width:2`，说明它要独占整行
           * （历史上「启用组合」用过它来保证后面「标题关键词 | 组合方向」能并排；
           *  K70 起该开关改挂分区标题行，这条分支留作通用能力） */
          chipRow = h('div', { class: 'kh-fld-chips' + (f.width === 2 ? ' kh-fld-chips-wide' : '') });
          hostOf().appendChild(chipRow);
        }
        if (f.sepBefore && chipRow.childNodes.length) {
          chipRow.appendChild(h('span', { class: 'kh-chip-sep' }));
        }
        chipRow.appendChild(c.el);
      } else {
        chipRow = null;
        hostOf().appendChild(c.el);
      }
    }
    /* 【2.0.2.11 票 #64】把工具栏字段搬进目标富文本的 `.kh-rt-toolbar`：插在「清空」之前，
     * 清空永远压最右（`.kh-rt-clear{margin-left:auto}`）。前面加一条竖线，与编辑器自带的那排分开。 */
    for (const [targetKey, list] of toolsOf) {
      const target = items.find((x) => x && x.spec && x.spec.key === targetKey);
      const holder = target && target.ctrl && target.ctrl.el;
      const toolbar = (holder && typeof holder.querySelector === 'function') ? holder.querySelector('.kh-rt-toolbar') : null;
      if (!toolbar) { for (const it of list) bodyEl.appendChild(it.ctrl.el); continue; }
      const tail = toolbar.querySelector('.kh-rt-clear');
      toolbar.insertBefore(h('span', { class: 'kh-rt-sep' }), tail || null);
      for (const it of list) toolbar.insertBefore(it.ctrl.el, tail || null);
    }
    /* 上半排插到最前：`grow` 字段按字段表顺序总在最后（备注 / 笔记内容都是本卡末位） */
    if (host && host !== bodyEl) bodyEl.insertBefore(host, bodyEl.firstChild);
    return bodyEl;
  }

  /* `kv*` 三件套外露给单测：批量管理的解析/写回是纯函数，钉口径用，
   * 与 `KH.ImgOcr` 的 `scopedRaw / stripKvMarks / kvWords` 对账（见 tests/specs/imgkw-batch.test.js）。 */
  ui.Fields = { create, layout, labelChip, kvChips, kvRows, kvPatch, kvApply, suffixOf };
})();
