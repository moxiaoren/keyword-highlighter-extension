/* ============================================================================
 * src/platform/storage.js · 管理端（options / popup）唯一读写信封
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件：旧版 options.js（2396 行）里到处直接 `chrome.storage.local
 * .get/set`，并且**又写了一份默认值**（lib/storage.js:17-59）—— 于是出现
 * "默认值有两份、改一处漏一处""导入导出走的字段和 UI 走的字段不是同一套"。
 * v2 收敛为唯一信封：
 *
 *   读：  `KH.Config.load()`         —— 默认值/兼容/校验全部复用内核唯一真源
 *   写：  `Store.patch(obj)`         —— 归一化 + 剔除废弃键，再落盘
 *   判重：`Store.keyOf(kw)`          —— text + 标题词 + 组合方向（旧版 _sameKeyword）
 *   导入导出：JSON 4 块 / CSV 17 列   —— 字段映射只经过 `KH.FieldMap` 一份
 *
 * 导入导出契约（方案 §5 第 11 项，**列数/块数不得改动**）：
 *   · JSON：`keywords(+groups)` / `siteRules` / `siteDisabledMap` / `styles` 四块 +
 *     `meta`；四块全选（完整备份）时附带 `globalEnabled` / `shadowDOMEnabled`，
 *     部分导出不带 —— 避免把对方本机的开关一起带偏（旧版行为，不得回退）。
 *   · CSV：固定 17 列，UTF-8 BOM 开头（Excel 友好）；分组列写「组名」，
 *     导入时按组名回建分组 —— 否则关键词会脱离分组、分组配色丢失（旧版踩过）。
 *
 * 铁律：本文件**不定义任何默认值**（含字段默认值），一律取自 `KH.Config.defaults`
 *       或 `KH.FieldMap`（后者本身也从 Config 派生）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /**
   * CSV 列定义 —— **唯一一份**（导出/导入共用，禁止各写一份）。
   *
   * 前 17 列与旧版 v1.52.0 逐字**同序同义**（存量 CSV 必须能直接导入，不得错位）；
   * 第 18 列 `组合方向` 是 v2 新增：
   *   · 旧版 17 列里**没有** comboAxis，于是「上下格(tb)」组合词导出再导入会**静默变成左右格(lr)**，
   *     并且"同核心词 + 同标题词、仅方向不同"的两条合法配置会在导入时被判重合并成一条
   *     （keyOf 把方向算进判重键，导入却没有列可还原）→ 属于**无损性缺陷**，必须补列。
   *   · 导入时列数允许 17（旧文件，方向按默认 lr）或 18（新文件）。
   *
   * 另外校正了 3 个**名实不符**的列名（值一直是标题词规则，旧名字写的是"核心"）：
   *   · 第 14 列：`核心匹配方式`   → `标题词匹配方式`（值 = cellVerifyMatchMode）
   *   · 第 15 列：`核心区分大小写` → `标题词区分大小写`（值 = cellVerifyCaseSensitive）
   *   · 第 16 列：`核心使用正则`   → `标题词使用正则`（值 = cellVerifyUseRegex）
   * 第 3 列 `核心词匹配`（caseSensitive/wholeWord/useRegex 三项）本就在第 5~7 列，
   * 旧表头里的"核心…"重复命名正是用户反馈"看不出哪列管哪个词"的直接原因。
   * 导入按**列序**取值（不按表头文本），因此改表头对存量文件无影响。
   */
  const CSV_HEADERS = [
    '关键词', '备注', '分组', '启用', '核心词区分大小写', '核心词全词匹配', '核心词正则',
    '背景色', '文字颜色', '重要', '重要笔记', '单元格组合', '标题关键词(左格)',
    '标题词匹配方式', '标题词区分大小写', '标题词使用正则', '抓取后续字段', '组合方向'
  ];

  /** 旧版 17 列（无「组合方向」）—— 导入时据此兼容 */
  const CSV_HEADERS_V1 = 17;

  const RARE_KEYWORD = 'hjz#';

  /* ------------------------------------------------------------------ 基础 */

  function storage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    return chrome.storage.local;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 归一化文本字段：去首尾空白，非字符串一律转字符串（导入时最常见的数据脏点） */
  function str(v) { return v == null ? '' : String(v); }

  /**
   * 归一化「抓取后续字段」标签串（附录A §7 的清洗要求）。
   * 分隔符允许 `|` `｜` `,` `，`（旧版抓取侧就是这么切的），
   * 统一落库为 `|` 分隔、去空白、去空项 —— 否则用户填 `a，b` 时：
   *   · 导出/展示看起来正常，但 `a，b` 与 `a|b` 会判成两个不同配置
   *   · 抓取侧要额外容错，等于同一件事两处实现（违反"单一实现"）
   *
   * 【`@表达式` 里的逗号不是分隔符】值格指向支持 `1,3` / `1-3,5`（与 cellOffset 同语法），
   * 所以按逗号切之后要把"属于 `@` 表达式的那一段"合回去：
   *   `应用截图@1,3|名称` → `应用截图@1,3|名称`（不是 `应用截图@1|3|名称`）
   *   `甲,乙`             → `甲|乙`（标签里没写 `@`，逗号照旧是分隔符）
   * 判据只看"`@` 之后的尾巴是否只由数字/连字符/空白组成、且下一段也是"——
   * 够保守：`应用截图@2,乙` 不会被误合（`乙` 不是表达式片段）。
   */
  function normalizeLabels(v) {
    const out = [];
    for (const chunk of str(v).split(/[|｜]/)) {
      let cur = '';
      for (const raw of chunk.split(/[,，]/)) {
        const p = raw.trim();
        if (!p) continue;
        if (cur && offsetTailOf(cur) && /^[0-9\s-]+$/.test(p)) { cur += ',' + p; continue; }
        if (cur) out.push(cur);
        cur = p;
      }
      if (cur) out.push(cur);
    }
    return out.join('|');
  }

  /** `@表达式` 的尾巴（`@` 之后、且只含数字/连字符/空白）；没有 `@` 或尾巴不像表达式 → 空串 */
  function offsetTailOf(s) {
    const i = String(s).lastIndexOf('@');
    if (i < 0) return '';
    const tail = String(s).slice(i + 1);
    return /^[0-9\s-]+$/.test(tail) ? tail : '';
  }

  /* ------------------------------------------------------------------ 判重 */

  /**
   * 组合轴（B9 · **单一真源**）：`cellVerifyAxis`（v1.52 起的老键）与 `comboAxis`（v2 起）**都认**，
   * 任一为 `tb` 就是上下格，否则左右格。**`tb` 进去必须 `tb` 出来**（行为数值不许回退）。
   *
   * 为什么必须单源：判重键 / CSV 第 18 列 / 保存归一 / 组合词编译**四处**各按各的读，
   * 更老或手写数据里的 `cellVerifyAxis:'tb'` 就会被其中几处静默当成 `lr`（数据漂移：
   * 判重把它与 `lr` 那条算成同一个词、CSV 导成 `lr`、编译也不亮）。现在只留这一份，
   * `combo.js` 与展示层一律调它。
   */
  function axisOf(kw) {
    return (kw && (kw.cellVerifyAxis === 'tb' || kw.comboAxis === 'tb')) ? 'tb' : 'lr';
  }

  /**
   * 判重键 —— 与旧版 `_sameKeyword` 完全一致：
   *   `text + 标题词(cellVerify) + 组合方向(comboAxis)` 三者相同才算重复。
   * 方向必须参与：v1.50.0 起"同名核心词 + 不同组合方向"是**两条**合法配置。
   * 方向一律经 `axisOf`（B9）—— 否则 `cellVerifyAxis:'tb'` 的老数据会被当成 `lr` 判重。
   */
  function keyOf(kw) {
    if (!kw) return '';
    return str(kw.text).trim() + '\u0000' + str(kw.cellVerify).trim() + '\u0000' + axisOf(kw);
  }

  function dupIndex(list) {
    const map = new Map();
    for (const k of list || []) {
      const key = keyOf(k);
      if (key && !map.has(key)) map.set(key, k);
    }
    return map;
  }

  function findDup(list, kw) {
    const key = keyOf(kw);
    if (!key) return null;
    for (const k of list || []) if (keyOf(k) === key) return k;
    return null;
  }

  /** 提示文案统一在这里生成，避免三处（弹窗/批量/CSV）各写一套措辞 */
  function dupMessage(kw) {
    const text = str(kw.text).trim() || '(空)';
    const cell = str(kw.cellVerify).trim();
    if (!cell) return '关键词「' + text + '」已存在';
    const leftRight = (axisOf(kw) === 'tb') ? '上格 | 下格' : '左格 | 右格';
    return '关键词 (' + (axisOf(kw) === 'tb' ? (cell + ' | ' + text) : (cell + ' | ' + text)) + ') 已存在（' + leftRight + '）';
  }

  /* ------------------------------------------------------------------ 构造 */

  /**
   * 生成一条**结构完整**的关键词。
   * 默认值来源全部是「配置」而非本文件字面量：
   *   · 匹配三开关 ← `matchSettings.defaultCaseSensitive/WholeWord/UseRegex`
   *     （这正是 options「批量新增默认值」三个配置项的读取点）
   *   · 颜色留空 = 继承（旧版语义：空串才会回退到 分组色 > 全局默认色）
   */
  function newKeyword(form, cfg) {
    const c = cfg || {};
    const ms = c.matchSettings || {};
    const f = form || {};
    return {
      id: f.id || uid(),
      text: str(f.text).trim(),
      note: str(f.note),
      groupId: f.groupId || null,
      enabled: f.enabled !== false,

      caseSensitive: (f.caseSensitive === undefined) ? !!ms.defaultCaseSensitive : !!f.caseSensitive,
      wholeWord: (f.wholeWord === undefined) ? !!ms.defaultWholeWord : !!f.wholeWord,
      useRegex: (f.useRegex === undefined) ? !!ms.defaultUseRegex : !!f.useRegex,

      bgColor: str(f.bgColor),
      textColor: str(f.textColor),

      important: !!f.important,
      importantNote: str(f.importantNote),
      impNoteUseHlColor: !!f.impNoteUseHlColor,
      imgSize: f.imgSize || '',

      cellVerifyEnabled: !!f.cellVerifyEnabled,
      cellVerify: str(f.cellVerify).trim(),
      /* B9：保存时把老键 `cellVerifyAxis` **归一成 `comboAxis`**（等价迁移）——
       * 判据只有一个 `axisOf`，`tb` 进来必须 `tb` 出去。 */
      comboAxis: axisOf(f),
      cellVerifyMatchMode: (f.cellVerifyMatchMode === 'exact') ? 'exact' : 'include',
      cellVerifyCaseSensitive: !!f.cellVerifyCaseSensitive,
      cellVerifyUseRegex: !!f.cellVerifyUseRegex,
      /* 取值格表达式（左右格专用，右起视觉列：`2` / `1-3` / `1,3,5`）。
       * 同样**必须列在这份手写白名单里**，否则保存时被清洗掉（见上面 imgOcr 的实测缺陷）。 */
      cellOffset: str(f.cellOffset).trim(),

      /* 图片文字识别（**「抓取后续字段」的一个分支**，不再只服务组合词）——
       * 两个字段**必须列在这份白名单里**，否则保存时会被清洗掉。
       * 实测缺陷（1.99.99.23 用户反馈）：勾选「识别图片文字」保存后再打开又变回未勾选 ——
       * 字段表（ui/fieldmap.js）加了、这里的手写白名单漏了。新增关键词字段时**两处都要加**，
       * 回归网里有一条"字段表里每个键都必须能过 sanitizeKeyword"的用例自动抓这种漏。
       * 注意：**取消勾选不清空 `imgOcrKeyword`**（用户口径：保留已填的关键词文本，不静默丢数据）；
       * "没配抓取字段/关键词为空 → imgOcr 置 false"由 `Config.normalize` 兜底，不在这里做。 */
      imgOcr: !!f.imgOcr,
      imgOcrKeyword: str(f.imgOcrKeyword).trim(),
      imgOcrMax: f.imgOcrMax || '',

      fetchLabels: normalizeLabels(f.fetchLabels),
      /* 「抓取后续字段」模块总开关（K71）——**写路径**（弹窗 / 批量 / CSV / JSON 导入）的归一。
       * 【同一个函数】读路径 `Config.normalize` 调的也是**它本身**
       * （`KH.Config.normalizeFetchEnabled`），不是第二份拷贝 —— R4 实测过"两处各写一条"
       * 会让 `null` / `0` / `''` 这类脏值在两路分叉（读路径当开、保存一次就当关）。
       * 【加载顺序】这里是**运行期查表**（函数体内求值，不是模块加载时取引用）；且四个上下文
       * （content_scripts / options.html / popup.html / popup/editor.html）里 config.js 都排在
       * storage.js 之前 —— 详见 config.js 顶部该函数的注释。
       * 【内容保留】缺键只**反推**开关，绝不清空 `fetchLabels`（用户口径：关闭后内容保留）。 */
      fetchEnabled: KH.Config.normalizeFetchEnabled(f.fetchEnabled, f.fetchLabels),
      /* 「抓取范围」（K74 · 嵌套表格抓哪一层）——**写路径**的归一，与读路径
       * （`Config.normalize`）和消费侧（`fetch.js`）共用 `KH.Config.normalizeFetchScope`。
       * 缺键 / 非法值 → `'auto'`；显式 `self` 绝不翻回 `auto`（与 fetchEnabled 同一套写法）。
       * `csv: 0`：不进 CSV（仍是 18 列契约）。 */
      fetchScope: KH.Config.normalizeFetchScope(f.fetchScope),

      createdAt: f.createdAt || Date.now(),
      updatedAt: f.updatedAt || Date.now()
    };
  }

  /** 让任意来源（导入 JSON / CSV / 旧版存量）的关键词变成规范形状，且**不改语义** */
  function sanitizeKeyword(raw, cfg) {
    const k = newKeyword(raw, cfg);
    // 罕见字标记：只有 text 恰为占位符时才是罕见字（旧版 _normalizeKind 语义）
    if (k.text === RARE_KEYWORD) k.kind = 'rare';
    // 组合词必须同时有 cellVerifyEnabled 与标题词，否则视为普通词（旧版 isCombo 判定）
    if (!(k.cellVerifyEnabled && k.cellVerify)) {
      k.cellVerifyEnabled = false;
    }
    // 仅抓取 = 有标题词 + 无核心词 + 配了抓取字段（旧版 specialFetch）
    if (k.cellVerifyEnabled && !k.text.trim() && k.fetchLabels.trim()) k.fetchOnly = true;
    else delete k.fetchOnly;
    return k;
  }

  function newGroup(form) {
    const f = form || {};
    return {
      id: f.id || uid(),
      name: str(f.name).trim(),
      bgColor: str(f.bgColor),
      textColor: str(f.textColor),
      important: !!f.important,
      importantNote: str(f.importantNote),
      impNoteUseHlColor: !!f.impNoteUseHlColor,
      imgSize: f.imgSize || ''
    };
  }

  /* ------------------------------------------------------------------ 读写 */

  const Store = {
    CSV_HEADERS,
    RARE_KEYWORD,

    uid, keyOf, axisOf, dupIndex, findDup, dupMessage,
    newKeyword, sanitizeKeyword, newGroup,

    /** 读：一律走内核唯一真源（默认值/兼容/校验都在 config.js） */
    async load() {
      const r = await KH.Config.load();
      return r.config;
    },

    /** 写：统一剔除废弃键后落盘（订阅方由内容脚本的 storage.onChanged 自动热更新） */
    async patch(obj) {
      const s = storage();
      const safe = KH.Config.stripDeprecated(obj);
      if (!s) return safe;
      await new Promise((resolve) => s.set(safe, resolve));
      return safe;
    },

    /* ---------------- 关键词增删改（唯一入口，options / popup 共用） ---------------- */

    async upsertKeyword(kw, cfg) {
      const config = cfg || await this.load();
      const list = (config.keywords || []).slice();
      const item = sanitizeKeyword(kw, config);
      item.updatedAt = Date.now();
      const idx = list.findIndex(k => k && item.id && k.id === item.id);
      if (idx >= 0) list[idx] = item; else list.push(item);
      await this.patch({ keywords: list });
      return item;
    },

    async removeKeywords(ids) {
      const config = await this.load();
      const set = new Set(ids || []);
      const list = (config.keywords || []).filter(k => !(k && set.has(k.id)));
      await this.patch({ keywords: list });
      return list;
    },

    /** 批量改字段（批量栏用）：patchFn 返回要合并的对象 */
    async patchKeywords(ids, patchFn) {
      const config = await this.load();
      const set = new Set(ids || []);
      const list = (config.keywords || []).map(k => {
        if (!k || !set.has(k.id)) return k;
        return Object.assign({}, k, patchFn(k), { updatedAt: Date.now() });
      });
      await this.patch({ keywords: list });
      return list;
    },

    async upsertGroup(group) {
      const config = await this.load();
      const list = (config.groups || []).slice();
      const item = newGroup(group);
      const idx = list.findIndex(g => g && item.id && g.id === item.id);
      if (idx >= 0) list[idx] = item; else list.push(item);
      await this.patch({ groups: list });
      return item;
    },

    async removeGroup(id) {
      const config = await this.load();
      const list = (config.groups || []).filter(g => !(g && g.id === id));
      // 组被删 → 组内关键词的 groupId 置空（否则成为悬空引用，配色静默失效）
      const keywords = (config.keywords || []).map(k => (k && k.groupId === id) ? Object.assign({}, k, { groupId: null }) : k);
      await this.patch({ groups: list, keywords });
    },

    /* ---------------- 分组名 ⇄ id ---------------- */

    groupNameMap(config) {
      const map = new Map();
      for (const g of (config && config.groups) || []) if (g && g.id) map.set(g.id, g.name || '');
      return map;
    },

    groupIdMap(config) {
      const map = new Map();
      for (const g of (config && config.groups) || []) if (g && g.name) map.set(g.name, g.id);
      return map;
    },

    /* ---------------- CSV ---------------- */

    csvEscape(v) {
      const s = str(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },

    /** 逐字符解析一行 CSV（支持引号内的逗号与换行转义）—— 唯一实现 */
    parseCSVLine(line) {
      const out = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
          } else cur += ch;
        } else if (ch === '"') {
          quoted = true;
        } else if (ch === ',') {
          out.push(cur); cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    },

    /** 一行关键词的**原始**列值（唯一来源：CSV 导出与 Excel 导出共用同一份列语义，避免两套漂移） */
    rowValues(k, names) {
      return [
        str(k.text),
        str(k.note || ''),
        names.get(k.groupId) || '',
        k.enabled ? '是' : '否',
        k.caseSensitive ? '是' : '否',
        k.wholeWord ? '是' : '否',
        k.useRegex ? '是' : '否',
        k.bgColor || '',
        k.textColor || '',
        k.important ? '是' : '否',
        str(k.importantNote || ''),
        k.cellVerifyEnabled ? '是' : '否',
        str(k.cellVerify || ''),
        k.cellVerifyMatchMode || 'include',
        k.cellVerifyCaseSensitive ? '是' : '否',
        k.cellVerifyUseRegex ? '是' : '否',
        str(k.fetchLabels || ''),
        axisOf(k)   // B9：CSV 第 18 列与判重/保存/编译同一个判据（老键 cellVerifyAxis 也认）
      ];
    },

    /**
     * 导出用的规范形状（B5）：走**唯一**的规范构造器 `sanitizeKeyword` / `newGroup`，
     * 于是"导出即全量新格式" —— 不再把 `impNoteBg` / `_flipped` / `cellVerifyAxis` 这类
     * 旧键 / 派生键写进文件（它们只会在导入侧被 `newKeyword` 丢掉，写出去只会让人以为有效）。
     *
     * ⚠️ **不得凭空生成时间戳**：`newKeyword` 会给缺失的 `createdAt`/`updatedAt` 补 `Date.now()`，
     * 导出时若照单全收，一条旧词会看起来"刚刚创建"。原对象没有这两个键 ⇒ 导出的那条也不写。
     * ⚠️ 只丢**未知键**：模块关着时已填的值（`cellVerify` / `cellOffset` / `fetchLabels` /
     * `imgOcr*` / `importantNote` / `imgSize` / `impNoteUseHlColor`）一律逐字保留 ——
     * `newKeyword` 的白名单本来就是全字段照抄，`sanitizeKeyword` 只额外把
     * `cellVerifyEnabled` 归零（`cellVerify` 为空时本来就无效，契约 §四.1 允许）。
     */
    normalizeForExport(kw, cfg) {
      const src = kw || {};
      const out = sanitizeKeyword(src, cfg);
      if (src.createdAt === undefined) delete out.createdAt;
      if (src.updatedAt === undefined) delete out.updatedAt;
      return out;
    },

    /**
     * CSV 导出。**"Excel 友好"是硬要求**（用户实测要求"表格形式"）：
     *   · UTF-8 BOM 开头 —— 否则 Excel 打开中文全是乱码；
     *   · **CRLF 行尾** —— 老版本 Excel 对纯 LF 的兼容不稳；
     *   · 多行备注由 csvEscape 用引号包住（既有行为），Excel 显示为单元格内换行。
     * B5：列值取自**同一份规范化列表**（与 `exportJSON` 同源），确保第 18 列等列值口径一致。
     */
    exportCSV(config) {
      const cfg = config || {};
      const names = this.groupNameMap(cfg);
      const rows = (cfg.keywords || []).map(k => this.normalizeForExport(k, cfg))
        .map(k => this.rowValues(k, names).map(v => this.csvEscape(v)).join(','));
      return '\uFEFF' + CSV_HEADERS.join(',') + '\r\n' + rows.join('\r\n');
    },

    /**
     * Excel 表格导出（`.xls` = 一份 HTML 单表，Excel 原生识别、**不需要任何依赖**）。
     * 为什么要单独做一个格式：CSV 在 Excel 里只是纯文本 —— 颜色列是 `#ff0000` 这种裸串、
     * 长备注挤成一团。HTML 表能让 Excel 直接渲染成**带边框的表格**，
     * 并把「底色 / 文字色」两列**按真实颜色上色**、冻结首行、
     * 单元格按文本格式（`mso-number-format:"\@"`，避免 `3-4` 被当成日期）。
     */
    exportExcelTable(config) {
      const cfg = config || {};
      const names = this.groupNameMap(cfg);
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const I_BG = 7, I_FG = 8;   // 与 rowValues 的列序对应（底色 / 文字色）
      const body = (cfg.keywords || []).map(k => {
        const vals = this.rowValues(k, names);
        const cells = vals.map((v, i) => {
          let style = '';
          if (i === I_BG && /^#[0-9a-f]{6}$/i.test(String(v))) style = ' style="background:' + v + '"';
          if (i === I_FG && /^#[0-9a-f]{6}$/i.test(String(v))) style = ' style="color:' + v + ';font-weight:600"';
          return '<td' + style + '>' + esc(v).replace(/\r?\n/g, '<br>') + '</td>';
        }).join('');
        return '<tr>' + cells + '</tr>';
      }).join('');
      return '\uFEFF' +
        '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">' +
        '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>' +
        '<x:Name>关键词</x:Name><x:WorksheetOptions><x:FreezePanes/><x:FrozenNoSplit/>' +
        '<x:SplitHorizontal>1</x:SplitHorizontal><x:TopRowBottomPane>1</x:TopRowBottomPane>' +
        '</x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->' +
        '<style>table{border-collapse:collapse}td,th{border:1px solid #c8ced8;padding:3px 8px;' +
        'font-family:"Microsoft YaHei",sans-serif;font-size:11pt;vertical-align:top;' +
        'white-space:normal}th{background:#eaf1fb;font-weight:600}</style>' +
        '</head><body><table><thead><tr>' +
        CSV_HEADERS.map(h => '<th>' + esc(h) + '</th>').join('') +
        '</tr></thead><tbody>' + body + '</tbody></table></body></html>';
    },

    /**
     * 把整段 CSV 切成「记录」。
     * **必须尊重引号**：导出侧会把含换行的备注用引号包成一个字段
     * （`"多行备注\n第二行"`），若像旧版那样直接 `split('\n')`，
     * 一个字段会被切成两行 → **凭空多出一条关键词**（实测：2 条导出、3 条导入）。
     */
    parseCSV(text) {
      let s = str(text).replace(/^\uFEFF/, '');
      /* Excel / Google Sheets 另存 CSV 时常在首行插一行 `sep=,`（声明分隔符）——
       * 不剥掉就会被当成表头 → 列数校验直接失败（用户拿 Excel 存回来的文件导不进来）。 */
      s = s.replace(/^sep=,\r?\n/i, '');
      const records = [];
      let fields = [], cur = '', quoted = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quoted) {
          if (ch === '"') {
            if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
          } else cur += ch;
        } else if (ch === '"') {
          quoted = true;
        } else if (ch === ',') {
          fields.push(cur); cur = '';
        } else if (ch === '\n') {
          fields.push(cur); records.push(fields); fields = []; cur = '';
        } else if (ch === '\r') {
          /* 与 \n 一起处理，单独出现时忽略 */
        } else cur += ch;
      }
      fields.push(cur);
      records.push(fields);
      // 丢掉首尾/中间的空行（尾随换行、纯空白行都不算数据行）
      return records.filter(r => !(r.length === 1 && r[0].trim() === ''));
    },

    /** CSV 导入：按组名回建分组（否则关键词脱离分组、分组配色丢失） */
    async importCSV(text, config) {
      const cfg = config || await this.load();
      const records = this.parseCSV(text);
      if (records.length < 2) throw new Error('CSV 格式无效：至少需要表头 + 1 行数据');

      const header = records[0].map(x => String(x).trim());
      // 兼容两代列宽：17 列（旧版文件，无「组合方向」）/ 18 列（v2 起）。
      // 多出来的尾列会被忽略、缺失的尾列按默认值处理，因此两代都能导。
      if (header.length !== CSV_HEADERS.length && header.length !== CSV_HEADERS_V1) {
        throw new Error('CSV 列数不符：期望 ' + CSV_HEADERS_V1 + '（旧版）或 ' +
          CSV_HEADERS.length + '（v2）列，实际 ' + header.length + ' 列');
      }

      const keywords = (cfg.keywords || []).slice();
      const groups = (cfg.groups || []).slice();
      const byName = new Map();
      for (const g of groups) if (g && g.name) byName.set(g.name, g);

      const keySet = new Set(keywords.map(keyOf));
      const stats = { added: 0, skipped: 0, groupsCreated: 0 };

      for (let i = 1; i < records.length; i++) {
        const v = records[i];
        if (!v.length) continue;
        /* A1：首列为空**不等于空行** —— 「仅抓取」词（无核心词、只有标题词 + 抓取字段）
         * 导出时第 1 列本来就是空的。判据照契约 §四.2：「单元格组合」列（第 12 列，
         * 下标 11）＝`是` 且「标题关键词(左格)」（第 13 列，下标 12）非空，就不许跳过。 */
        const comboOnlyRow = (str(v[11]).trim() === '是') && !!str(v[12]).trim();
        if (!str(v[0]).trim() && !comboOnlyRow) continue;

        const groupName = str(v[2]).trim();
        let groupId = null;
        if (groupName) {
          let g = byName.get(groupName);
          if (!g) {
            g = newGroup({ name: groupName });
            groups.push(g);
            byName.set(groupName, g);
            stats.groupsCreated++;
          }
          groupId = g.id;
        }

        const kw = sanitizeKeyword({
          text: v[0],
          note: v[1],
          groupId,
          enabled: v[3] !== '否',
          caseSensitive: v[4] === '是',
          wholeWord: v[5] === '是',
          useRegex: v[6] === '是',
          bgColor: v[7],
          textColor: v[8],
          important: v[9] === '是',
          importantNote: v[10],
          cellVerifyEnabled: v[11] === '是',
          cellVerify: v[12],
          cellVerifyMatchMode: (v[13] === 'exact') ? 'exact' : 'include',
          cellVerifyCaseSensitive: v[14] === '是',
          cellVerifyUseRegex: v[15] === '是',
          fetchLabels: v[16],
          comboAxis: (v[17] === 'tb') ? 'tb' : 'lr'
        }, cfg);

        const key = keyOf(kw);
        if (keySet.has(key)) { stats.skipped++; continue; }   // 前格+后格组合去重（旧版行为）
        keySet.add(key);
        keywords.push(kw);
        stats.added++;
      }

      await this.patch({ keywords, groups });
      return stats;
    },

    /* ---------------- JSON ---------------- */

    /**
     * 可导出的「样式/配置」键 —— 新增配置项时只改这一处。
     * **不含** `globalEnabled` / `shadowDOMEnabled` / `suspendInactiveTab`：
     * 这三个是"本机开关"，只有**完整备份**（4 块全选）才随文件走，
     * 部分导出带上会把接收方的本机开关一起带偏（旧版 v1.52.0 就是这么做的，不得回退）。
     */
    STYLE_KEYS: [
      'highlightStyle', 'noteCardStyle', 'matchSettings', 'importantNote',
      'pageResidualClean', 'pageCleanClick', 'pageRebuildOnChange',
      /* K78·① 折叠内容的扫描开关：也是"行为档位"（换机器/恢复备份后应当跟着走） */
      'scanCollapsedCustom',
      'pageRebuildSilentMs', 'pageRebuildGapMs',
      /* K58 变更处理方式：这是用户选的"行为档位"，换台机器/恢复备份后应该跟着走
       * （与 globalEnabled / shadowDOMEnabled 这类"本机开关"不同）。 */
      'changeHandling'
    ],

    /** 只有完整备份才携带的全局开关 */
    GLOBAL_KEYS: ['globalEnabled', 'shadowDOMEnabled', 'suspendInactiveTab'],

    pick(obj, keys) {
      const out = {};
      for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
      return out;
    },

    /** 导出 JSON（4 块 + meta）。scope 省略＝完整备份 */
    exportJSON(scope, config) {
      const cfg = config || {};
      const sc = scope || { keywords: true, siteRules: true, siteDisabled: true, styles: true };
      const out = {};
      /* B5：关键词与分组**都走规范构造器**（`normalizeForExport` → `sanitizeKeyword` / `newGroup`），
       * 于是导出文件里不再出现 `impNoteBg` / `_flipped` / `cellVerifyAxis` 这类旧键或派生键；
       * 时间戳与"模块关着时已填的值"按 §四.1 的两条 ⚠️ 处理（见 `normalizeForExport` 注释）。 */
      if (sc.keywords) {
        out.keywords = (cfg.keywords || []).map(k => this.normalizeForExport(k, cfg));
        out.groups = (cfg.groups || []).map(g => newGroup(g));
      }
      if (sc.siteRules) out.siteRules = cfg.siteRules || [];
      if (sc.siteDisabled) out.siteDisabledMap = cfg.siteDisabledMap || {};
      if (sc.styles) out.styles = this.pick(cfg, this.STYLE_KEYS);

      // 完整备份才带全局开关：部分导出带上会把对方本机开关带偏（旧版行为，不得回退）
      const full = sc.keywords && sc.siteRules && sc.siteDisabled && sc.styles;
      if (full) {
        for (const k of this.GLOBAL_KEYS) {
          if (cfg[k] !== undefined) out[k] = cfg[k];
        }
      }
      out.meta = {
        app: 'keyword-highlighter',
        version: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
          ? chrome.runtime.getManifest().version : '',
        scope: { keywords: !!sc.keywords, siteRules: !!sc.siteRules, siteDisabled: !!sc.siteDisabled, styles: !!sc.styles },
        exportedAt: new Date().toISOString()
      };
      return JSON.stringify(out, null, 2);
    },

    /** 导入前预检：告诉 UI 文件里到底有什么（旧版 getImportPreview） */
    previewJSON(text) {
      const data = JSON.parse(str(text));
      return {
        data,
        has: {
          keywords: Array.isArray(data.keywords),
          siteRules: Array.isArray(data.siteRules),
          siteDisabled: !!(data.siteDisabledMap && typeof data.siteDisabledMap === 'object'),
          styles: !!(data.styles || data.highlightStyle || data.noteCardStyle || data.matchSettings)
        }
      };
    },

    /**
     * 兼容读取：v2 的 `styles` 块，以及**旧版**平铺的
     * `highlightStyle` / `noteCardStyle` / `matchSettings`（存量文件必须能直接导入）。
     * 注意：旧版的 `noteFormat` 在 v2 已废弃，读到即忽略（不再落盘），
     * 且**绝不执行任何"组合词左右翻转"迁移**（方案 §7.2 铁律）。
     */
    stylesFrom(data) {
      const out = {};
      const src = Object.assign({}, (data && data.styles) || {});
      // 样式/行为配置块
      for (const k of this.STYLE_KEYS) {
        if (src[k] !== undefined) out[k] = src[k];
        else if (data && data[k] !== undefined) out[k] = data[k];
      }
      // 全局开关：旧版文件把它们平铺在根上，v2 起只在**完整备份**里带；
      // 这里一并读出来，由调用方按"覆盖模式"决定是否落盘（保持旧文件可整机迁移）。
      for (const k of this.GLOBAL_KEYS) {
        if (data && data[k] !== undefined) out[k] = data[k];
        else if (src[k] !== undefined) out[k] = src[k];
      }
      return out;
    },

    /** 导入 JSON。opts = { include:{...}, mode:'merge'|'overwrite' } */
    async importJSON(text, opts, config) {
      const cfg = config || await this.load();
      const o = opts || {};
      const include = o.include || { keywords: true, siteRules: true, siteDisabled: true, styles: true };
      const mode = o.mode === 'overwrite' ? 'overwrite' : 'merge';

      const { data, has } = this.previewJSON(text);
      if (!(has.keywords || has.siteRules || has.siteDisabled || has.styles)) {
        throw new Error('无效的数据格式：既无关键词，也无站点规则 / 样式配置');
      }

      const setObj = {};
      const stats = { keywords: 0, groups: 0, siteRules: 0 };

      /* 关键词 + 分组 */
      if (include.keywords && has.keywords) {
        /* A1（唯一会丢数据的路径）：`text` 为空的**「仅抓取」词**是合法数据 —— 旧版
         * （1.52.0 `lib/storage.js:475-500`）的导入路径就保留它，v2 重构时被
         * `.filter(k => k.text)` 丢掉了。判据照契约 §四.2：核心词为空时，看
         * 「单元格组合」+「标题关键词(左格)」是否都成立（`sanitizeKeyword` 会顺带补 `fetchOnly`）。 */
        const srcKw = (data.keywords || []).map(k => sanitizeKeyword(k, cfg))
          .filter(k => k.text || (k.cellVerifyEnabled && k.cellVerify));
        const srcG = (data.groups || []).map(g => newGroup(g)).filter(g => g.name);
        if (mode === 'overwrite') {
          setObj.keywords = srcKw;
          setObj.groups = srcG;
          stats.keywords = srcKw.length;
          stats.groups = srcG.length;
        } else {
          const cur = cfg.keywords || [];
          const ids = new Set(cur.map(k => k && k.id));
          const keys = new Set(cur.map(keyOf));
          const merged = cur.slice();
          for (const k of srcKw) {
            if (ids.has(k.id) || keys.has(keyOf(k))) continue;
            merged.push(k); ids.add(k.id); keys.add(keyOf(k)); stats.keywords++;
          }
          setObj.keywords = merged;

          const curG = cfg.groups || [];
          const gids = new Set(curG.map(g => g && g.id));
          const gnames = new Set(curG.map(g => g && g.name));
          const g = curG.slice();
          for (const gr of srcG) {
            if (gids.has(gr.id) || gnames.has(gr.name)) continue;
            g.push(gr); gids.add(gr.id); gnames.add(gr.name); stats.groups++;
          }
          setObj.groups = g;
        }
      }

      /* 站点规则 */
      if (include.siteRules && has.siteRules) {
        const src = (data.siteRules || []).filter(r => r && typeof r.pattern === 'string' && r.pattern);
        if (mode === 'overwrite') {
          setObj.siteRules = src;
          stats.siteRules = src.length;
        } else {
          const cur = cfg.siteRules || [];
          const key = r => (r ? (r.type || '') + '|' + (r.pattern || '') + '|' + (r.matchType || '') : '');
          const seen = new Set(cur.map(key));
          const merged = cur.slice();
          for (const r of src) { const k = key(r); if (k && !seen.has(k)) { merged.push(r); seen.add(k); stats.siteRules++; } }
          setObj.siteRules = merged;
        }
      }

      /* 站点禁用状态 */
      if (include.siteDisabled && has.siteDisabled) {
        const src = data.siteDisabledMap || {};
        setObj.siteDisabledMap = (mode === 'merge')
          ? Object.assign({}, cfg.siteDisabledMap || {}, src)
          : src;
      }

      /* 样式 / 配置 */
      if (include.styles) {
        const styles = this.stylesFrom(data);
        for (const k of Object.keys(styles)) {
          const v = styles[k];
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            setObj[k] = Object.assign({}, cfg[k] || {}, v);   // 嵌套配置按块合并，避免半截配置覆盖掉兄弟键
          } else if (v !== undefined) {
            setObj[k] = v;
          }
        }
        // 全局开关：仅"覆盖"模式且文件确实带它时才恢复（旧版行为）
        if (mode === 'overwrite' && data.globalEnabled !== undefined) setObj.globalEnabled = data.globalEnabled !== false;
      }

      await this.patch(setObj);
      return stats;
    },

    /** 重置数据（按块）。scope 同 exportJSON */
    async reset(scope, config) {
      const cfg = config || await this.load();
      const sc = scope || { keywords: true, siteRules: true, siteDisabled: true, styles: true };
      const setObj = {};
      if (sc.keywords) { setObj.keywords = []; setObj.groups = []; }
      if (sc.siteRules) setObj.siteRules = [];
      if (sc.siteDisabled) setObj.siteDisabledMap = {};
      if (sc.styles) {
        for (const k of this.STYLE_KEYS) setObj[k] = KH.Config.defaults[k];
        setObj.globalEnabled = KH.Config.defaults.globalEnabled;
      }
      await this.patch(setObj);
      return setObj;
    },

    /** 导出下载（Blob + a[download]）—— 唯一实现 */
    download(filename, content, mime) {
      const blob = new Blob([content], { type: (mime || 'application/json') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  };

  KH.Store = Store;
})();
