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
 *   type: text | textarea | richtext | bool | int | select | color
 *   bool+chip  → 开关胶囊；color+chip → 颜色胶囊（文案用 short，完整名进 tooltip）
 *   select+chip+onValue/offValue → 两态开关胶囊
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
        const inp = h('input', {
          class: 'kh-input', type: 'number', id: id, min: '40', max: '600',
          /* C5：原来硬编码「留空＝用全局默认尺寸」—— 但 `#fld-imgOcrMax`（每处最多＝**张数**）
           * 走的是同一条分支，提示写错了对象。改为优先用字段自己的 hint。 */
          title: spec.hint || '留空＝用全局默认', value: value === '' || value == null ? '' : String(value),
          placeholder: spec.inline ? '默认' : '留空＝默认'
        });
        return { el: fieldBox(spec.label, inp), read: () => KH.FieldMap.coerce(spec, inp.value), key: spec.key };
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

  ui.Fields = { create, layout };
})();
