/* ============================================================================
 * src/ui/components/chip.js · 匹配规则「胶囊 + 点开小弹窗」（options / popup 共用）
 * ----------------------------------------------------------------------------
 * 为什么这样设计（方案 §8.2 + 覆盖矩阵第 17 项）：
 *   匹配方式有三个开关（正则/大小写/全词），如果每个都在表格里放三个 checkbox，
 *   11 列的表格会变成"复选框森林"，且窄屏完全没法看。旧版的解法是**胶囊展示 +
 *   点击弹小弹窗勾选**（`.kw-match-pill` / `.mr-chip`，v1.48 起），这个交互是对的，
 *   v2 保留并抽出为组件：
 *     · 表格里只显示"生效了哪几项"（正则 / 大小写 / 全词），全关时显示「默认」；
 *     · 点击胶囊弹小面板勾选，**勾选即生效**（不经过主弹窗的"保存"）；
 *     · 同一组件用于：核心词匹配列、标题词匹配列、悬停 tooltip、批量设置、编辑弹窗。
 *
 * 注意胶囊文案与旧版**逐字一致**（正则/全词/默认/罕见）——
 * 它是用户已经形成肌肉记忆的东西，改了就是体验缩水。
 * **唯一例外**：区分大小写已按用户要求从「大小写」改成「Aa」（更短、也更像通用编辑器的写法），
 * tooltip 仍是「区分大小写」，语义没丢。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;

  /** 每个"部分"对应哪几个存储字段（唯一声明，避免各处手抄字段名） */
  const PARTS = {
    core: {
      title: '点击修改核心词匹配方式',
      fields: [
        { key: 'useRegex', label: '正则', hint: '正则表达式匹配（管道 | 可写多个候选）' },
        { key: 'caseSensitive', label: 'Aa', hint: '区分大小写' },
        { key: 'wholeWord', label: '全词', hint: '整词匹配（两侧不得是字母/数字/下划线）' }
      ]
    },
    title: {
      title: '点击修改标题词匹配方式',
      fields: [
        { key: 'cellVerifyUseRegex', label: '正则', hint: '标题词按正则匹配' },
        { key: 'cellVerifyCaseSensitive', label: 'Aa', hint: '标题词区分大小写' },
        { key: 'cellVerifyMatchMode', label: '全词', hint: '标题词整词精确匹配', type: 'exact' }
      ]
    }
  };

  /** 当前值下，哪些项是"开"的 */
  function activeLabels(part, value) {
    const p = PARTS[part];
    if (!p) return [];
    const out = [];
    for (const f of p.fields) {
      const on = (f.type === 'exact') ? (value && value[f.key] === 'exact') : !!(value && value[f.key]);
      if (on) out.push(f.label);
    }
    return out;
  }

  /** 浮动小面板（点开即用，点外/滚走/Esc 自动关）
   *  对外也导出：批量栏的「⚙️ 匹配」要弹的是"小勾选面板"而不是长表单（方案 §5.2.1），
   *  复用同一个定位/关闭实现，避免再写第二套浮层（两套浮层必然有一套漏关）。 */
  let openPop = null;
  function openPopover(anchor, content, onClose, opts) {
    closePopover();
    const o = opts || {};
    const h = D().h;
    const rect = anchor.getBoundingClientRect();
    const pop = h('div', { class: 'kh-popover' + (o.className ? ' ' + o.className : ''), 'data-kh-ext-ui': '1' }, [content]);
    document.body.appendChild(pop);

    // 先用左侧对齐，再按视口右边界收回，避免窄屏（popup）溢出
    const pw = pop.offsetWidth || 220;
    let left = Math.min(rect.left, window.innerWidth - pw - 8);
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    const ph = pop.offsetHeight || 120;
    const below = rect.bottom + 6;
    pop.style.top = (below + ph <= window.innerHeight - 8) ? (below + 'px') : Math.max(8, rect.top - ph - 6) + 'px';

    const onDocDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePopover(); } };
    const onScroll = () => closePopover();

    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    openPop = {
      el: pop,
      close() {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll, true);
        if (pop.parentNode) pop.parentNode.removeChild(pop);
        openPop = null;
        if (typeof onClose === 'function') onClose();
      }
    };
    return openPop;
  }

  function closePopover() { if (openPop) openPop.close(); }

  /**
   * 创建一个胶囊。
   * @param {object} opts
   *   part      'core' | 'title'
   *   rare      true = 罕见字核心（固定显示「罕见」，不可编辑）
   *   value     当前匹配值（存储字段片段）
   *   disabled  组合词未启用时标题列禁用
   *   onChange  (patch) => void   勾选即回调（调用方落盘）
   * @returns {HTMLElement}
   */
  function create(opts) {
    const o = opts || {};
    const h = D().h;

    let value = Object.assign({}, o.value || {});

    const pill = h('span', {
      class: 'kw-match-pill',
      role: 'button',
      tabindex: o.disabled ? null : '0',
      title: o.disabled ? '需勾选「单元格组合」才有标题词匹配' : (PARTS[o.part] ? PARTS[o.part].title : '')
    });

    function paint() {
      D().clear(pill);
      if (o.rare) {
        pill.appendChild(h('span', { class: 'mr-chip mr-chip-rare', text: '罕见' }));
        pill.classList.add('is-rare');
        return;
      }
      const labels = activeLabels(o.part, value);
      if (!labels.length) {
        pill.appendChild(h('span', { class: 'mr-default', text: '默认' }));
        return;
      }
      for (const t of labels) pill.appendChild(h('span', { class: 'mr-chip' + (o.part === 'title' ? ' mr-chip-title' : ''), text: t }));
    }

    function toggle() {
      if (o.disabled || o.rare) return;
      if (openPop && openPop.el && openPop.el.__owner === pill) return closePopover();
      const p = PARTS[o.part];
      const hh = D().h;
      const rows = p.fields.map(f => {
        const on = (f.type === 'exact') ? (value[f.key] === 'exact') : !!value[f.key];
        const cb = hh('input', { type: 'checkbox', checked: on ? true : null });
        cb.addEventListener('change', () => {
          const patch = {};
          patch[f.key] = (f.type === 'exact') ? (cb.checked ? 'exact' : 'include') : cb.checked;
          value = Object.assign({}, value, patch);
          paint();
          if (typeof o.onChange === 'function') o.onChange(patch, value);
        });
        return hh('label', { class: 'kh-pop-row' }, [
          cb,
          hh('span', { class: 'kh-pop-label', text: f.label }),
          hh('span', { class: 'kh-pop-hint', text: f.hint })
        ]);
      });
      const panel = D().h('div', { class: 'kh-pop-inner' }, [
        D().h('div', { class: 'kh-pop-title', text: o.part === 'title' ? '标题词匹配方式' : '核心词匹配方式' }),
        D().h('div', { class: 'kh-pop-rows' }, rows),
        D().h('div', { class: 'kh-pop-foot', text: '勾选即生效' })
      ]);
      const pop = openPopover(pill, panel);
      if (pop) pop.el.__owner = pill;
    }

    pill.addEventListener('click', toggle);
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    paint();
    pill.setValue = (v) => { value = Object.assign({}, v || {}); paint(); };
    return pill;
  }

  /**
   * 【导出两块，别混在一起】
   *   `ui.Popover`   —— 通用浮层（单例：开新的自动关旧的，关闭时摘干净四个监听）。
   *                     **匹配胶囊、颜色胶囊、批量「⚙️ 匹配」三处共用这一份**，
   *                     所以它不该只挂在"匹配"名下 —— 本次就因此踩过：
   *                     ColorField 按 `ui.Chip.openPopover` 取，而实际导出名是 MatchChip → 拿到 undefined。
   *   `ui.MatchChip` —— 匹配方式的"胶囊 + 点开勾选"，只有它自己那点事。
   */
  ui.Popover = { open: openPopover, close: closePopover };
  ui.MatchChip = { create, PARTS, activeLabels };
})();
