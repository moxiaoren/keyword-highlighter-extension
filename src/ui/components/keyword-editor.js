/* ============================================================================
 * src/ui/components/keyword-editor.js · 关键词编辑弹窗（唯一实现）
 * ----------------------------------------------------------------------------
 * R8 的核心：**同一份编辑器，options 里弹、popup 里也弹**。
 * 旧版 popup 的「＋ 快速添加」是"另开一个窗口跳设置页"（popup/popup.js:122），
 * 于是同一次操作在两端是两套交互、两套字段、两套校验 —— 这正是"功能这里有一处、
 * 那里没有"的典型来源。v2 收敛成一个 `KH.ui.openEditor()`。
 *
 * 字段不在这里声明（那会变成第二份字段表）：一律遍历 `KH.FieldMap.FORM_SECTIONS`
 * 与 `KEYWORD_FIELDS` 生成控件，因此：
 *   · 新增字段 → 只加 FieldMap 一行 → 弹窗 / popup / 批量栏 / CSV 同时生效；
 *   · 保存路径固定为 `FieldMap.toStore()` → `Store.sanitizeKeyword()` → 落盘。
 *
 * 保存前的三道闸（缺一不可，UN-08）：
 *   ① 必填校验（核心词为空时必须是"仅抓取"：有标题词 + 抓取字段）
 *   ② 判重（text + 标题词 + 组合方向，旧版 `_sameKeyword` 的键）
 *   ③ 往返校验（表单→存储→再读回，逐字段比对；不对称立刻报错而不是静默丢字段）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));
  const ui = (KH.ui = KH.ui || {});
  const D = () => ui.dom;

  /**
   * 字段控件**已抽到共享工厂** `ui.Fields.create`（src/ui/components/fields.js）。
   *
   * 为什么要抽：分组编辑弹窗原先是手写的另一套控件，于是这边升级成
   * “开关胶囊 / 颜色胶囊 / 行内字段”之后，那边还停在“勾选框 / 旧色块”。
   * 收敛成一个工厂后，改一处 = 所有表单一起变（结构保证，不靠自觉）。
   * 字段声明的语义与 id 契约见该文件头部注释。
   */
  const control = (field, value, ctx) => ui.Fields.create(field, value, ctx);

  /**
   * @param {object} opts
   *   keyword  编辑对象（省略＝新建）
   *   cfg      当前配置
   *   mode     'options' | 'popup'
   *   onSaved  (kw) => void
   */
  /**
   * 图片识别（OCR）前置条件校验 —— 保存前"拦住并说清"的**唯一判据**。
   *
   * 抽成纯函数导出（`ui.KeywordEditor.ocrGate`）的理由：它是一条可单测的业务判据，
   * 而弹窗的 save 只是把它接到 `fail()` 上；埋在 250 行闭包里就只能靠真浏览器点了。
   *
   * 口径（用户确认第 1/2 条）：
   *   · 勾了「识别图片文字」但没配「抓取后续字段」→ 不通过（图片就是从这些字段的值格里取的）；
   *   · 勾了但「图片命中关键词」为空 → 不通过（它是唯一的匹配口径，留空等于没配）。
   * **取消勾选时不动已填文本**（本函数只在 `imgOcr` 为真时说话；清洗层也不清空该字段）。
   * @returns {string} '' = 通过；否则是给用户看的原因
   */
  function ocrGate(kw) {
    if (!kw || !kw.imgOcr) return '';
    if (!String(kw.fetchLabels || '').trim()) {
      return '已勾选「识别图片文字」：请先填写「抓取后续字段」—— 图片是从这些字段的值格里取的。';
    }
    if (!String(kw.imgOcrKeyword || '').trim()) {
      return '已勾选「识别图片文字」：请填写「图片命中关键词」（按正则匹配图里的文字）。';
    }
    return '';
  }

  function openEditor(opts) {
    const o = opts || {};
    const h = D().h;
    const fm = KH.FieldMap;
    const cfg = o.cfg || {};
    const groups = cfg.groups || [];
    const src = o.keyword || null;
    // 带 id = 编辑既有；不带 id = 新建（「复制」就是"预填但不带 id"，于是自然成为新建）
    const editing = (src && src.id) ? src : null;

    // 初值：编辑/预填＝按字段表回填；纯新建＝按字段表取默认（默认值来自 Config，不在这里写死）
    const form = src ? fm.toForm(src) : fm.defaults(cfg);

    const controls = [];
    /* 分区按 `FORM_SECTIONS[].col` 落到**独立竖列**里（见 fieldmap.js 里 col 的说明）：
     * 每列一个 flex 竖列，卡片在列内首尾相接，不再出现"同一行里矮卡片下面一大块空洞"。 */
    const cols = new Map();
    const colsBox = h('div', { class: 'kh-editor-cols' });
    const colOf = (n) => {
      if (!cols.has(n)) {
        const c = h('div', { class: 'kh-editor-col' });
        cols.set(n, c);
        colsBox.appendChild(c);
      }
      return cols.get(n);
    };

    for (const sec of fm.FORM_SECTIONS) {
      const bodyId = 'kh-sec-body-' + sec.id;
      // 分区标题做成可点击的折叠头（默认全展开）：长表单能按需收起，省得一路滚
      const headBtn = h('button', {
        class: 'kh-editor-sec-head', type: 'button',
        'aria-expanded': 'true', 'aria-controls': bodyId
      }, [
        h('span', { class: 'kh-editor-sec-chevron', text: '▾' }),
        h('span', { class: 'kh-editor-sec-title', text: sec.title }),
        /* 可见的只有这一句**短句**；长解释进 tooltip（`hintTitle`，见 fieldmap 的说明） */
        h('span', { class: 'kh-editor-sec-hint', text: sec.hint, title: sec.hintTitle || null })
      ]);
      const card = h('div', { class: 'kh-editor-sec', 'data-sec': sec.id }, [headBtn]);
      const bodyEl = h('div', { class: 'kh-editor-sec-body', id: bodyId });
      const headExtra = h('div', { class: 'kh-editor-sec-extra' });   // 标题行右侧插槽
      headBtn.addEventListener('click', () => {
        const closed = card.classList.toggle('is-collapsed');
        headBtn.setAttribute('aria-expanded', closed ? 'false' : 'true');
        headBtn.querySelector('.kh-editor-sec-chevron').textContent = closed ? '▸' : '▾';
      });
      /* `head: true` 的字段渲染到**标题行右侧**（如「启用」）：
       *   · 正文里不用为它单独占一行（用户实测："放右上角避免占空间"）；
       *   · 它不能塞进 `headBtn` 内部 —— 按钮里嵌交互控件既不合法、点一下还会顺带折叠分区，
       *     所以插槽是 headBtn 的**兄弟**，折叠热区只覆盖标题本身。
       * 正文排布（胶囊成行 / 竖线分隔 / 半行整行流式）统一交给 `ui.Fields.layout`，
       * 与分组弹窗共用同一份实现 —— 免得两边各写一套悄悄漂移。 */
      const headFields = [], bodyItems = [];
      for (const f of fm.fieldsOf(sec.id)) {
        const c = control(f, form[f.key], { groups, imgSize: form.imgSize, onChange: () => { /* 联动在下面按需处理 */ } });
        controls.push(c);
        if (f.head) headFields.push({ spec: f, ctrl: c });
        else bodyItems.push({ spec: f, ctrl: c });
      }
      for (const it of headFields) headExtra.appendChild(it.ctrl.el);
      ui.Fields.layout(bodyItems, bodyEl);
      card.appendChild(bodyEl);
      // 标题行 = 折叠按钮 + 右侧插槽（无插槽时不渲染，保持原样）
      if (headExtra.childNodes.length) {
        card.insertBefore(h('div', { class: 'kh-editor-sec-headrow' }, [headBtn, headExtra]), bodyEl);
        headBtn.classList.add('is-in-row');
      }
      colOf(Number(sec.col) || 1).appendChild(card);
    }
    const grid = colsBox;   // 后面的联动/查询都按 `grid.querySelector` 走，语义不变

    const byKey = (k) => controls.find(c => c.key === k) || null;

    // ---- 组合方向联动：只改「显示文案」，字段值一律不动（保存路径完全不受影响）----
    // 文案来自 FieldMap.axisLabels（单一来源），因此这里只是"贴文案"，不是第二张字段表。
    const comboCard = grid.querySelector('.kh-editor-sec[data-sec="combo"]');
    const comboHint = comboCard ? comboCard.querySelector('.kh-editor-sec-hint') : null;
    const axisCtl = byKey('comboAxis');
    let axisNote = null;
    let offsetNote = null;
    if (comboCard) {
      // 「勾了组合却没填标题词」是最常见的"看起来没生效"来源，用一行提示说清楚（文案随方向变）
      axisNote = h('div', { class: 'kh-editor-axis-note' });
      comboCard.querySelector('.kh-editor-sec-body').appendChild(axisNote);
      /* K71 方向自适应：「取值格（右起）」只对**左右格**成立。切到上下格时该字段
       * **禁用**（而不是藏起来，沿用 K70"真禁用"的先例）并给一行说明。
       * 为什么另开一个节点而不是复用 `axisNote`：两者的显隐条件互不相干
       * （axisNote = 填了标题词但没启用；offsetNote = 已启用 + 上下格 + 填过取值格），
       * 挤进同一个节点会互相覆盖。两条的显隐写成**互斥**，保证 combo 区最多 1 条可见说明。 */
      offsetNote = h('div', { class: 'kh-editor-axis-note' });
      offsetNote.hidden = true;
      comboCard.querySelector('.kh-editor-sec-body').appendChild(offsetNote);
    }
    function applyAxisLabels() {
      const com = byKey('cellVerify');
      const raw = com && com.el.querySelector('.kh-fld-label');
      if (raw) raw.dataset.baseLabel = raw.dataset.baseLabel || raw.textContent;   // 首次进入时留底，避免二次叠加
      const lb = fm.axisLabels(axisCtl ? axisCtl.read() : 'lr');
      if (raw) raw.textContent = lb.cellVerify + (raw.dataset.baseLabel.indexOf('*') >= 0 ? ' *' : '');
      const mode = byKey('cellVerifyMatchMode');
      if (mode) {
        /**
         * 「全词」这一项的精确含义随方向走：左右格 = 整词精确；上下格 = 整格相等。
         * 它现在渲染成**胶囊**（与表格列同一套说法，标签固定「全词」），
         * 所以这层方向差异落到胶囊的 tooltip 上，而不是可见文案 —— 可见文案必须与表格列一致。
         */
        const exactText = (lb.cellVerifyMatchMode === '列词匹配') ? '整词精确（整格相等）' : '整词精确';
        const chip = mode.el.classList && mode.el.classList.contains('kh-fld-chip') ? mode.el : null;
        if (chip) {
          chip.title = exactText;
        } else {
          const sel = mode.el.querySelector('select');
          const opts = sel ? sel.options : [];
          for (const op of opts) if (op.value === 'exact') op.textContent = exactText;
        }
      }
      if (comboHint) {
        comboHint.textContent = lb.hint;
        comboHint.title = lb.hintTitle || '';
      }
      if (axisNote || offsetNote) {
        // 只在"填了标题词但没启用组合"时提醒：这正是用户觉得"配了没反应"的场景
        const on = !!(byKey('cellVerifyEnabled') && byKey('cellVerifyEnabled').read());
        const axisTb = (axisCtl ? axisCtl.read() : 'lr') === 'tb';
        const hasTitle = !!(com && String(com.read() || '').trim());
        const offCtl = byKey('cellOffset');
        const hasOffset = !!(offCtl && String(offCtl.read() || '').trim());
        if (axisNote) {
          axisNote.hidden = !(!on && hasTitle);
          axisNote.textContent = axisNote.hidden ? '' : ('这份「' + lb.cellVerify + '」当前不会生效：请勾上本节右上角的「启用」。');
        }
        /* 两条说明**互斥**（上面那条要求 !on，这条要求 on）→ combo 区最多 1 条可见说明 */
        if (offsetNote) {
          offsetNote.hidden = !(on && axisTb && hasOffset);
          offsetNote.textContent = offsetNote.hidden ? ''
            : '「取值格（右起）」只对「左右格」成立：当前是「上下格」，这个值会保留但不生效。';
        }
      }
    }
    if (axisCtl) {
      const sel = axisCtl.el.querySelector('select');
      /* 方向一变要刷**两件事**：字段文案（applyAxisLabels）与"上下档禁用取值格"的禁用态。
       * 接 `syncCombo`（末尾会调 applyAxisLabels），顺序正好是"先算禁用、再写文案"。 */
      if (sel) sel.addEventListener('change', syncCombo);
    }
    applyAxisLabels();

    // 组合词联动：未勾选"启用组合"时，标题词相关字段不可用（避免留下半截状态）
    const enableCtl = byKey('cellVerifyEnabled');

    /** 字段禁用态的唯一实现（联动三处共用：组合词 / 抓取 / 重要笔记） */
    function setDisabled(c, disabled) {
      if (!c) return;
      c.el.classList.toggle('is-disabled', !!disabled);
      for (const inp of c.el.querySelectorAll('input, select, textarea, button')) inp.disabled = !!disabled;
    }

    /**
     * **富文本（contenteditable）字段**的禁用态（K71 裁定 1）：`disabled` 属性对
     * `[contenteditable]` 完全无效 —— 只加 `is-disabled` 会得到"看着灰、照样能打字"的假禁用
     * （R4 探针实测：未勾选状态下键入 `X`，正文由 `"R4原有笔记"` 变成 `"R4原有笔记X"`）。
     * 三条一起做才算真禁用：
     *   · 工具行 / 表格浮条按钮 → 通用 `setDisabled` 已覆盖（它们都是 `<button>`）；
     *   · 编辑区 → `contenteditable="false"`（不能落光标、不能键入；原值记在 `dataset` 里，勾回时还原）；
     *   · "不可点" → 容器上挂**捕获阶段**的 `mousedown`/`click` 拦截（否则点笔记里的图片/链接
     *     仍会弹出"修改地址"的对话框 —— 那也是可操作）。
     * ⚠️ **不碰 `pointer-events` / `overflow`**：笔记正文长了仍要能滚（锁滚动是另一类 bug，
     * 而且 R0 明确点名不许把滚动一起锁死）。内容一律保留（不清值、不写空）。
     */
    function setDisabledRich(c, disabled) {
      setDisabled(c, disabled);
      if (!c || !c.el) return;
      for (const ed of c.el.querySelectorAll('[contenteditable]')) {
        if (disabled) {
          if (ed.dataset.khCePrev === undefined) ed.dataset.khCePrev = ed.getAttribute('contenteditable') || 'true';
          ed.setAttribute('contenteditable', 'false');
        } else if (ed.dataset.khCePrev !== undefined) {
          ed.setAttribute('contenteditable', ed.dataset.khCePrev);
          delete ed.dataset.khCePrev;
        }
      }
      if (!c._khGuard) {
        c._khGuard = (e) => {
          if (c.el.classList.contains('is-disabled')) { e.preventDefault(); e.stopPropagation(); }
        };
        c.el.addEventListener('mousedown', c._khGuard, true);
        c.el.addEventListener('click', c._khGuard, true);
      }
    }

    function syncCombo() {
      const on = !!(enableCtl && enableCtl.read());
      for (const key of ['cellVerify', 'comboAxis', 'cellVerifyMatchMode', 'cellVerifyCaseSensitive', 'cellVerifyUseRegex']) {
        setDisabled(byKey(key), !on);
      }
      /* K71 方向自适应：「取值格（右起）」只对**左右格**成立 —— 上下档一并禁用
       * （值保留在表单/存储里，只是不生效；`toStore` 从不清 `cellOffset`，见 fieldmap）。 */
      const axisTb = (axisCtl ? axisCtl.read() : 'lr') === 'tb';
      setDisabled(byKey('cellOffset'), !on || axisTb);
      applyAxisLabels();
    }
    if (enableCtl) {
      const cb = enableCtl.el.querySelector('input');
      if (cb) cb.addEventListener('change', syncCombo);
      syncCombo();
    }
    /* K71 裁定 5：清空/改写标题词要**立即**刷新 combo 的说明（只加事件、不改判定）。
     * 原先只有 `cellVerifyEnabled` / 方向两个 change 会触发联动，于是标题词清空后
     * 那句"这份「列关键词(表头)」当前不会生效…"要等下一次联动事件才收起（用户能看见的文案错）。
     * 互斥不变量不受影响：`syncCombo` → `applyAxisLabels` 仍是同一套判据。 */
    {
      const cvCtl = byKey('cellVerify');
      const inp = cvCtl && cvCtl.el.querySelector('input, textarea');
      if (inp) { inp.addEventListener('input', syncCombo); inp.addEventListener('change', syncCombo); }
    }

    /**
     * 「抓取后续字段」联动（K71 起含模块总开关 `fetchEnabled`；用户口径：**各管各的**）：
     *   · 模块没启用（`!on`）→ 本模块字段全部禁用（字段输入框 / 识别图片文字 / 关键词 / 每处最多），
     *     但**已填内容一律保留**（`read()` 照样读得到 disabled 控件的值 —— 不是靠缓存）；
     *   · 启用了但没填字段（`!hasLabels`）→ 「识别图片文字」仍禁用（K70 既有前置条件）；
     *   · 勾了识别但没填命中关键词 → 后两个禁用。
     * 禁用只是"别让人配出无效状态"，真正的兜底在 `Config.normalize`（存量脏配置）与保存校验。
     * `cellVerifyEnabled` / `important` **一律不参与**本联动（不做跨模块联动）。
     */
    const fetchOnCtl = byKey('fetchEnabled');
    const fetchCtl = byKey('fetchLabels');
    const ocrCtl = byKey('imgOcr');
    /* K70：OCR 三个控件已归入「抓取后续字段」分区，所以那句"当前不可用"的提示也**跟着搬**
     * （它解释的控件与它引用的 `抓取字段` 现在都在这一节里；留在「单元格组合」会变成
     *  一段指着不存在控件的提示）。K71 起这一个节点按三态换文案（**不新增第二个节点** ——
     *  既有 e2e 用单数 `querySelector` 取它）。 */
    const fetchCard = grid.querySelector('.kh-editor-sec[data-sec="fetch"]');
    let ocrNote = null;
    if (fetchCard) {
      ocrNote = h('div', { class: 'kh-editor-axis-note' });
      ocrNote.hidden = true;
      fetchCard.querySelector('.kh-editor-sec-body').appendChild(ocrNote);
    }
    function syncFetch() {
      // 缺控件时按"开"处理：宁可照旧可用，也不因为一次渲染异常把整块功能禁用掉
      const on = fetchOnCtl ? !!fetchOnCtl.read() : true;
      const hasLabels = !!(fetchCtl && String(fetchCtl.read() || '').trim());
      const ocrOn = !!(on && hasLabels && ocrCtl && ocrCtl.read());
      setDisabled(fetchCtl, !on);
      /* K74：「抓取范围」也跟着模块开关走（抓取模块没启用时它没有意义） */
      setDisabled(byKey('fetchScope'), !on);
      setDisabled(ocrCtl, !on || !hasLabels);
      for (const key of ['imgOcrKeyword', 'imgOcrMax']) setDisabled(byKey(key), !on || !hasLabels || !ocrOn);
      if (ocrNote) {
        if (!on) {
          ocrNote.hidden = false;
          ocrNote.textContent = '本模块已关闭：字段置灰、已填内容保留，但抓取不生效。';
        } else if (!hasLabels) {
          ocrNote.hidden = false;
          /* C6：不复述控件名、也不复述模块名（用户点名的原则：标题写了就别在正文再说一遍） */
          ocrNote.textContent = '先在上面填要抓的字段，才能识别这些字段值格里的图片。';
        } else {
          ocrNote.hidden = true;
          ocrNote.textContent = '';
        }
      }
    }
    if (ocrCtl) {
      const cb = ocrCtl.el.querySelector('input');
      if (cb) cb.addEventListener('change', syncFetch);
    }
    if (fetchOnCtl) {
      const cb = fetchOnCtl.el.querySelector('input');
      if (cb) cb.addEventListener('change', syncFetch);
    }
    if (fetchCtl) {
      const inp = fetchCtl.el.querySelector('input, textarea');
      if (inp) { inp.addEventListener('input', syncFetch); inp.addEventListener('change', syncFetch); }
    }
    syncFetch();

    /**
     * 「重要笔记」联动（K71 裁定 1 · 红牌 A）——**各管各的**，覆盖 `fieldsOf('imp')` 里
     * **除胶囊自身（`important`）以外**的三个字段：
     *   `importantNote`（富文本编辑器）、`impNoteUseHlColor`（底色胶囊）、`imgSize`（尺寸）。
     * 未勾选 → 三个字段置灰不可操作、**内容一律保留**；勾回 → 立即可编辑、可保存。
     * **不新增说明节点**：胶囊就在同一标题行，置灰已自解释（imp 区不做"当前不会生效"那类说明；
     * 这同时保住了另两条已验的不变量：combo 区「最多 1 条可见说明」、fetch 区节点恒 1 个）。
     * 用户原话：「重要笔记相关部分都置灰无法操作，开启后才能填内容（当然，填了内容可以关闭，内容保留）」。
     */
    const impCtl = byKey('important');
    function syncImp() {
      const on = !!(impCtl && impCtl.read());
      setDisabledRich(byKey('importantNote'), !on);   // 富文本要额外处理 contenteditable
      setDisabled(byKey('impNoteUseHlColor'), !on);
      setDisabled(byKey('imgSize'), !on);
    }
    if (impCtl) {
      const cb = impCtl.el.querySelector('input');
      if (cb) cb.addEventListener('change', syncImp);
      syncImp();
    }

    /** 汇总当前表单值 */
    function readForm() {
      const out = {};
      for (const c of controls) out[c.key] = c.read();
      return out;
    }

    const errBox = h('div', { class: 'kh-editor-err' });
    errBox.hidden = true;
    const wrap = h('div', { class: 'kh-editor' }, [grid, errBox]);

    function fail(msg) {
      errBox.textContent = msg;
      errBox.hidden = false;
      return false;
    }

    const modal = ui.Modal.open({
      title: editing ? '编辑关键词' : '添加关键词',
      body: wrap,
      /* 尺寸固定 lg（860px 三列）：三个调用点——options、独立编辑窗口 popup/editor.html、
       * 页面委派（src/features/page-editor.js 挂 ShadowRoot）——都要"选项页那个观感"。
       * C7 O-6：旧的 `mode === 'popup' ? 'sm' : 'lg'` 已删 —— popup 里内联编辑器那条路
       * 早退役了（用户否掉了 348px 塞 860px 弹窗的观感），没有调用者再传 'popup'。 */
      size: 'lg',
      /* 挂载点：页面模式传 ShadowRoot，样式与 DOM 都活在 shadow 里，不污染页面 */
      mount: o.mount || null,
      bare: !!o.bare,          // 独立窗口里只留内容（去掉遮罩与标题行）
      /* 关闭回调：独立编辑窗口（popup/editor.html）靠它在自己关掉后收起窗口 */
      onClose: o.onClose || null,
      saveLabel: editing ? '保存' : '添加',
      onSave: async () => {
        errBox.hidden = true;
        const raw = readForm();

        // ③ 先跑往返校验：字段表若不对称，这里就会炸出来（而不是等用户发现"某个字段没存上"）
        const rt = fm.roundTrip(Object.assign({}, form, raw), cfg);
        if (!rt.ok) return fail('字段映射异常（请把下面这行反馈给开发者）：' + rt.diffs.join('；'));

        const kw = KH.Store.sanitizeKeyword(Object.assign({}, form, raw, { id: form.id }), cfg);

        // ① 必填：核心词为空时，必须构成"仅抓取"（有标题词 + 抓取字段），否则等于没配
        const text = String(kw.text || '').trim();
        const fetchOnly = !!(kw.cellVerifyEnabled && kw.cellVerify && !text && String(kw.fetchLabels || '').trim());
        if (!text && !fetchOnly) {
          return fail(kw.cellVerifyEnabled && kw.cellVerify
            ? '核心词为空：若要「仅抓取」，请同时填写「抓取后续字段」'
            : '请填写关键词（核心词）');
        }
        kw.fetchOnly = fetchOnly;
        if (text === KH.Store.RARE_KEYWORD) kw.kind = 'rare';

        /* ①b 图片识别的前置条件（用户确认第 1/2 条）：**必须拦住并说清**，不许静默丢数据。
         * 校验放在这里而不是 `sanitizeKeyword`：保存路径是唯一能"把问题告诉用户"的地方
         * （清洗层只负责兜底存量脏配置，它没地方提示）。判据见 `ocrGate`（可单测）。 */
        const gate = ocrGate(kw);
        if (gate) return fail(gate);

        // ② 判重：编辑自身不算重复
        const list = (cfg.keywords || []).filter(k => k && (!editing || k.id !== editing.id));
        const dup = KH.Store.findDup(list, kw);
        if (dup) return fail(KH.Store.dupMessage(kw));

        const saved = await KH.Store.upsertKeyword(Object.assign(kw, { id: editing ? editing.id : kw.id }), cfg);
        D().toast(editing ? '已保存' : '已添加「' + (text || kw.cellVerify) + '」', 'ok');
        if (typeof o.onSaved === 'function') o.onSaved(saved);
        return true;
      }
    });

    return modal;
  }

  ui.openEditor = openEditor;
  ui.KeywordEditor = { openEditor, control, ocrGate };
})();
