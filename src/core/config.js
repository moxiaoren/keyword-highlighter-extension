/* ============================================================================
 * src/core/config.js · 默认值唯一真源 + 兼容读取 + 校验 + 迁移
 * ----------------------------------------------------------------------------
 * 铁律（方案 §2 第 5 条）：默认值只在本文件出现一次。
 *   · 其它任何文件不得再写第二份 defaults（旧版 lib/storage.js:17-59 即第二份，已废弃）。
 *   · 版本号**不在这里**定义 —— 版本唯一真源是 manifest.json（meta-check #1 校验）。
 *
 * 兼容策略（方案 §7.2「存量数据零改写」）：
 *   · 未知键：宽容保留（不删用户数据）。
 *   · 已废弃键：读取时忽略，写入时不再落盘（delete on write），避免每次 set 写回脏字段。
 *   · 绝不执行「组合词左右翻转」迁移（v1.8.4 已闭环），只做宽容读取。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 已废弃的存储键（读到即忽略、写回即清除）。来源：方案 §7.1 + R7。 */
  const DEPRECATED_KEYS = [
    'noteFormat',            // 全文无使用场景
    'comboFlipped',          // 翻转迁移已闭环，仅存量兼容读取
    'pageCleanMinGap',       // 由 pageRebuildGapMs 统一取代
    /* 【S2】识别档位整个删掉（#12 裁决）：换成 `imgOcr.engine`。存量值由 `normalize`
     * 回落成 `auto` 并置 `migrated.ocrEngine` 标记（设置页据此给**一次性**提示）。
     * 放进 `DEPRECATED_KEYS` 的作用是**写回时物理删掉**它 —— 否则那个键会一直躺在存储里，
     * 每次读都重新触发一次"迁移"（提示没完没了）。 */
    'imgOcr.quality',
    'highlightStyle.defaultBorderColor',  // CSS.highlights 不支持边框
    'highlightStyle.defaultBorderWidth',
    'highlightStyle.defaultBorderRadius'  // 旧默认值含 typo 'iat::3px'
  ];

  /** 合法枚举（校验用）。非法值回退到默认，但不静默丢数据。 */
  const ENUMS = {
    'siteRules[].type': ['blacklist', 'whitelist'],
    'siteRules[].matchType': ['exact', 'subdomain', 'prefix', 'regex'],
    'siteRules[].scope': ['domain', 'url'],
    /* 变更处理方式（K58）：smart = 相关性预筛（省资源，默认）；always = 任何变动都整页重建（旧行为，最保守） */
    'changeHandling': ['smart', 'always'],
    /* 图片识别引擎（S2 / #12 裁决）：`auto` = 主引擎 PP-OCR 失败时按会话回落兼容引擎（默认）；
     *  `ppocr` = 只用主引擎（失败如实报错，不偷偷退回）；`tesseract` = 只用兼容引擎。 */
    'imgOcr.engine': ['auto', 'ppocr', 'tesseract']
  };

  /**
   * 「抓取后续字段」模块开关（`fetchEnabled`）的**唯一归一函数**（K71 裁定 4）。
   *
   * 真值表（`v = value`）：
   *   · `true` / `false`            → 原样；
   *   · `undefined`（**缺键**）      → 按非空 `fetchLabels` 反推（有字段 ⇒ 启用，与新建默认一致）；
   *   · 其余"键存在"的脏值（`null` / `0` / `''` / `'false'` …）→ `!!v`
   *     （键存在就尊重：falsy 一律当**关**，绝不因脏值翻回 `true`）。
   *
   * 【为什么必须只有一个函数】读路径（本文件的 `normalize`）与写路径
   * （`src/platform/storage.js` 的 `newKeyword` / `sanitizeKeyword`）**调用的是同一个它** ——
   * 两份拷贝正是 R1-3③「两处逐字同一条」要防的东西（R4 实测过 `null` 在两路判据不一致）。
   *
   * 【为什么不依赖脚本加载顺序】storage.js 是在 `newKeyword()` 的**函数体内**做运行期查表
   * （`KH.Config.normalizeFetchEnabled(...)`），**不是**在模块求值时取引用；而且四个加载上下文
   * （manifest 的 `content_scripts`、`options/options.html`、`popup/popup.html`、`popup/editor.html`）
   * 里 `src/core/config.js` 都排在 `src/platform/storage.js` **之前**。依赖方向也对：platform → core。
   * 编译层的 `kw.fetchEnabled !== false` **不参与**本归一（缺键的手写对象仍须照旧抓取）。
   */
  function normalizeFetchEnabled(value, fetchLabels) {
    if (value === undefined) return !!(fetchLabels && String(fetchLabels).trim());
    return !!value;
  }

  /**
   * 「抓取范围」（`fetchScope`）的**方向枚举**与**唯一归一函数**（K79 重梳；旧口径见 K74 §四）。
   * 口径 = 用户 2026-09-23 的三句话：
   *   · **当前层**（`self`）  —— 命中格（「仅抓取」时为标题格）**直接所在**的那张表
   *   · **内层**（`inner`）   —— 当前层里**嵌着的表**（比它小；任意单元格里的都算）
   *   · **外层**（`outer`）   —— 当前层的**祖先表**（命中格是更大表格的内层）
   * 三个方向**可多选**；**默认「当前层」**；旧值平移见 `LEGACY_FETCH_SCOPES` 的注释。
   * 与 `normalizeFetchEnabled` 同一套写法：读路径（本文件 `normalize`）与写路径
   * （`storage.newKeyword`）调用的是**同一个它**；消费侧（`fetch.js` / `img-ocr.js` / `compiler.js`）也调它，
   * 于是"值表"只有这一份。大小写不敏感（`TB` 这类历史脏值不该炸）。
   */
  /** 抓取层级**方向**（K79 重梳后的口径，用户 2026-09-23 定义）：
   *   `self`  = **当前层**：命中格（「仅抓取」时为标题格）**直接所在**的那张表；
   *   `inner` = **内层**：当前层里嵌着的表（比它**小**的表，任意单元格里的都算）；
   *   `outer` = **外层**：当前层的**祖先表**（命中格是更大表格的内层）。
   * 三个方向**可多选**，存成**规范化字符串**（方向按 `self+inner+outer` 的固定顺序用 `+` 连接，
   * 于是"同一份选择"只有一种写法 ⇒ 导出 / CSV 往返稳定）。**默认「当前层」**。
   *
   * 旧值平移（K74 的 5 个枚举值 → 新口径）：
   *   `self → self`；`auto → self+outer`（保持"本层没有就往外找"的旧行为）；`outer1 / outermost → outer`；
   *   `all → self+inner+outer`。⚠️ `outer1`/`outermost` 原本是"只取**一层**"，新口径里 `outer` 是一个**方向**
   *   （可含多层、合并展示）—— 这是有意的语义合并，changelog 里要对用户说明。
   *
   * 归一规则：**缺键 / 空 / 全非法 → `auto`（旧口径：就近优先、只取一层）**；合法方向一律尊重、
   * 去重、按固定顺序输出。
   *   ⚠️ 为什么缺键不是新默认 `self`：这个键是 2.0.0.1 才加的，**缺键只可能来自"那个版本之前
   *   存的配置"**，当时的实际口径就是 `auto`。若在归一处改成 `self`，这些配置会**悄悄少抓外层
   *   字段**（用户看得见的行为变化）。「默认＝当前层」由**编辑器字段默认值**承担
   *   （`FieldMap` 的 `def: () => 'self'`）：新建关键词写进存储的就是 `self`，读出来也是 `self`。
   * 读路径（本文件 `normalize`）、写路径（`storage.newKeyword`）、消费侧（`fetch.js` / `img-ocr.js` /
   * `compiler.js`）**全部调这一个函数** ⇒ 值表只有这一份。
   */
  const FETCH_DIRECTIONS = ['self', 'inner', 'outer'];
  const FETCH_SCOPE_DEFAULT = 'self';
  const LEGACY_FETCH_SCOPES = { self: 'self', outer1: 'outer', outermost: 'outer', all: 'self+inner+outer' };
  /** 全部**合法规范值**（`auto` 是旧口径的兼容值，见下；其余是三个方向的非空子集，顺序固定） */
  const FETCH_SCOPES = ['auto', 'self', 'inner', 'outer', 'self+inner', 'self+outer', 'inner+outer', 'self+inner+outer'];

  function normalizeFetchScope(value) {
    const parts = Array.isArray(value) ? value : String(value == null ? '' : value).split('+');
    const picked = [];
    for (const piece of parts) {
      const s = String(piece == null ? '' : piece).trim().toLowerCase();
      if (!s) continue;
      /* ⚠️ 旧口径的 `auto`（**就近优先、只取一层**）**原样保留**：不能映射成 `self+outer`
       * —— 那会让存量用户突然多出"外层字段"（可见的行为变化）。它的"只取一层"由
       * `fetchScopeSpec().nearestOnly` 表达，消费侧照旧处理。 */
      if (s === 'auto') return 'auto';
      const mapped = LEGACY_FETCH_SCOPES[s] !== undefined ? LEGACY_FETCH_SCOPES[s] : s;
      for (const d of String(mapped).split('+')) if (FETCH_DIRECTIONS.indexOf(d) >= 0 && picked.indexOf(d) < 0) picked.push(d);
    }
    if (!picked.length) return 'auto';      // 缺键 / 空 / 全非法 ⇒ **旧口径 auto**（见下）
    return FETCH_DIRECTIONS.filter((d) => picked.indexOf(d) >= 0).join('+');
  }

  /**
   * 归一后的**范围描述**（消费侧唯一入口）：`{ scope, dirs, nearestOnly }`。
   *   · `nearestOnly === true` ⇒ 旧 `auto`：按 `dirs` 的顺序**就近优先、只取第一层命中的**；
   *   · 否则 ⇒ 把 `dirs` 里**每一层**都取出来再合并。
   */
  function fetchScopeSpec(value) {
    const sc = normalizeFetchScope(value);
    if (sc === 'auto') return { scope: sc, dirs: ['self', 'outer'], nearestOnly: true };
    return { scope: sc, dirs: sc.split('+'), nearestOnly: false };
  }

  /** 规范值 → 方向数组（顺序固定为 self / inner / outer） */
  function fetchDirections(value) { return normalizeFetchScope(value).split('+'); }

  const Config = {
    /** 默认值 —— 唯一真源（方案 §7.1 定稿形态） */
    defaults: {
      globalEnabled: true,

      keywords: [],
      groups: [],

      /** { type, pattern, matchType:'exact'|'subdomain'|'prefix'|'regex', scope:'domain'|'url' } */
      siteRules: [],
      /** {'example.com': true} 本地即时状态，默认不随导出分享 */
      siteDisabledMap: {},

      /** 仅背景色/文字色 —— 边框圆角已移除（CSS.highlights 不支持） */
      highlightStyle: {
        defaultBgColor: '#ff9500',
        defaultTextColor: '#000000'
      },

      noteCardStyle: {
        bgColor: '#ffffff',
        textColor: '#333333',
        borderColor: '#cccccc',
        borderWidth: '1px',
        borderRadius: '8px',
        shadow: '0 4px 12px rgba(0,0,0,0.15)',
        maxWidth: '320px',
        opacity: '0.96',
        fontSize: '14px'
      },

      importantNote: {
        imgSize: 70
      },

      /* ---- 图片文字识别（OCR）----
       * `defaultMax`：每个锚点最多识别几张图（关键词上可单独覆盖，留空即用这个默认）
       * `crossOriginSites`：{'example.com': true} 允许扩展代为读取该站点的跨域图片。
       *   默认**不开**：跨域读图等于替页面再发一次请求，必须按站点显式授权（决策留档见 changelog）。 */
      imgOcr: {
        defaultMax: 4,
        crossOriginSites: {},
        /** 识别引擎（S2 取代旧的 `quality` 档位）：
         *  `auto`（默认）= 主引擎 PP-OCR，失败按**会话**回落兼容引擎 Tesseract（首次主动告知）；
         *  `ppocr` = 只用主引擎（失败如实报错，不回落 —— 给排障用）；
         *  `tesseract` = 只用兼容引擎。
         * 三档都不含"参数可调"：块高/PSM/边数上限等 10 个引擎参数一律不给用户改（票 #17 D-17.7）。 */
        engine: 'auto'
      },

      /** 一次性迁移标记（S2）：`ocrEngine` = "存量档位已回落成 `engine`，还没告知过用户"。
       *  由 `normalize` 在**发现存量 `imgOcr.quality` 时**置真；设置页提示过一次后写回假。
       *  置真的条件只看"存储里还有没有那个废弃键"，所以**写回时必须把它一起删掉**
       *  （`DEPRECATED_KEYS` 已包含 `imgOcr.quality`，任何 patch 都会顺手清掉它）。 */
      migrated: {
        ocrEngine: false
      },

      matchSettings: {
        defaultCaseSensitive: false,
        defaultWholeWord: false,
        defaultUseRegex: false
      },

      shadowDOMEnabled: true,
      suspendInactiveTab: true,
      /** K78·①「**扫描被折叠起来的长内容**（网站自己做的『展开 / 收起』）」：
       *  作者用 `display:none` 收起、旁边有「展开 / 更多」控件的内容，按用户口径**算页面内容**（与闭合 `<details>` 同类）。
       *  默认**开**；关掉即完全回到旧行为（这类隐藏内容一律不扫）。
       *  放行是**六条同时成立**的启发式（宁可漏判，不许把隐藏菜单又放回来）——见 `scanner.js:customCollapseExpandable`。 */
      scanCollapsedCustom: true,

      /* ---- 翻页清扫（方案 §4.3 / §14 决策留档 D4）---- */
      pageResidualClean: true,
      /** 分页点击捕获：默认关（启发式猜分页误触发率高，病根已由 CSS.highlights 根治） */
      pageCleanClick: false,

      /* ---- 整页重建兜底（方案 §4.2）---- */
      pageRebuildOnChange: true,
      /** 变更处理方式（K58）：
       *  `smart`  —— 先判相关性：与命中/抓取/图片都无关的变动不重建（省资源，默认）；
       *  `always` —— 任何页面变动都整页重建（P1/P2 之前的旧行为，最保守；静默窗口与最小间隔照旧）。
       *  留这个开关的理由：预筛的取舍是"判多只是多算一次、判漏才是事故"，
       *  但用户遇到"页面明明变了却不亮"时，需要一条能**立刻排除预筛嫌疑**的路。 */
      changeHandling: 'smart',
      /** 静默窗口：距最后一次页面变动 ≥ 此值才重建，避开高频动态页竞态 */
      pageRebuildSilentMs: 1000,
      /** 全局重建最小间隔：三条翻页通道（click / URL / 指纹轮询）共用此唯一口径（R14） */
      pageRebuildGapMs: 2000,

      /** 内容指纹采样间隔（R13）—— 仅在无 CSS.highlights 环境或极端翻页兜底时消耗 */
      pageFingerprintIntervalMs: 1000
    },

    /** 「抓取后续字段」开关的唯一归一（读路径与写路径共用；见文件顶部该函数的注释） */
    normalizeFetchEnabled,
    /** 「抓取范围」的枚举与唯一归一（读 / 写 / 消费三处共用；见文件顶部该函数的注释） */
    normalizeFetchScope,
    fetchScopeSpec,
    fetchDirections,
    FETCH_DIRECTIONS,
    FETCH_SCOPE_DEFAULT,
    FETCH_SCOPES,

    /**
     * 深度合并：以 defaults 为骨架，用存储值覆盖。
     * 注意区别于"深拷贝 defaults"——数组/对象型存储值**整体替换**而非合并，
     * 否则用户清空 keywords 后会被默认空数组"看似正常"但 groups 残留等隐性错误掩盖。
     */
    merge(stored) {
      const out = {};
      const src = stored || {};
      for (const k of Object.keys(this.defaults)) {
        const dv = this.defaults[k];
        const sv = src[k];
        if (dv !== null && typeof dv === 'object' && !Array.isArray(dv)) {
          out[k] = Object.assign({}, dv, (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) ? sv : {});
        } else {
          out[k] = (sv === undefined) ? dv : sv;
        }
      }
      // 未知键：宽容保留，不丢用户数据
      for (const k of Object.keys(src)) {
        if (!(k in out)) out[k] = src[k];
      }
      return out;
    },

    /** 一次性清洗：丢弃废弃键、修正非法枚举、补齐关键词字段。返回 {config, changed} */
    normalize(raw) {
      const cfg = this.merge(raw);
      const changed = { deprecated: [], invalid: [] };

      // ① 废弃键
      for (const key of DEPRECATED_KEYS) {
        if (key.indexOf('.') >= 0) {
          const [head, tail] = key.split('.');
          if (cfg[head] && typeof cfg[head] === 'object' && tail in cfg[head]) {
            delete cfg[head][tail];
            changed.deprecated.push(key);
          }
        } else if (key in cfg) {
          delete cfg[key];
          changed.deprecated.push(key);
        }
      }

      // ② 站点规则枚举
      if (Array.isArray(cfg.siteRules)) {
        cfg.siteRules = cfg.siteRules.filter(r => r && typeof r.pattern === 'string' && r.pattern.length > 0);
        for (const r of cfg.siteRules) {
          if (!ENUMS['siteRules[].type'].includes(r.type)) { r.type = 'blacklist'; changed.invalid.push('type'); }
          if (!ENUMS['siteRules[].matchType'].includes(r.matchType)) { r.matchType = 'exact'; changed.invalid.push('matchType'); }
          if (r.scope !== undefined && !ENUMS['siteRules[].scope'].includes(r.scope)) { r.scope = 'domain'; changed.invalid.push('scope'); }
        }
      }

      // ②b 变更处理方式（K58）：非法值回退 smart（绝不因为一个坏值让"省资源"或"保守"两头都失效）
      if (!ENUMS['changeHandling'].includes(cfg.changeHandling)) {
        cfg.changeHandling = this.defaults.changeHandling;
        changed.invalid.push('changeHandling');
      }
      // ②c 图片识别引擎（S2）：非法值回退 auto（＝主引擎 + 会话内回落，行为最接近"档位取消前"）
      if (cfg.imgOcr && !ENUMS['imgOcr.engine'].includes(cfg.imgOcr.engine)) {
        cfg.imgOcr.engine = this.defaults.imgOcr.engine;
        changed.invalid.push('imgOcr.engine');
      }
      /* ②d 档位 → 引擎的一次性迁移（S2 / #12 裁决）。**判据是"存储里还有没有 `imgOcr.quality`"**，
       * 不是它的值：`best` 与 `fast` 都落 `auto` —— 换引擎后"更准"由主引擎承担，
       * 不再需要用户去下一个 19MB 的大模型包。
       * 标记**只置真、不自动清**（清是设置页告知过用户之后的写回动作）；否则用户刚点掉提示，
       * 下一次读又把它置真 —— 因为那个废弃键还在存储里躺着（`DEPRECATED_KEYS` 负责在写回时删掉它）。 */
      if (raw && raw.imgOcr && typeof raw.imgOcr === 'object' && 'quality' in raw.imgOcr) {
        if (cfg.migrated.ocrEngine !== true) changed.invalid.push('migrated.ocrEngine');
        cfg.migrated.ocrEngine = true;
      }

      // ③ 关键词字段补齐（不改语义、不翻转）
      if (Array.isArray(cfg.keywords)) {
        cfg.keywords = cfg.keywords.map(k => {
          if (!k || typeof k !== 'object') return null;
          const o = Object.assign({}, k);
          if (o.enabled === undefined) o.enabled = true;
          if (o.caseSensitive === undefined) o.caseSensitive = cfg.matchSettings.defaultCaseSensitive;
          if (o.wholeWord === undefined) o.wholeWord = cfg.matchSettings.defaultWholeWord;
          if (o.useRegex === undefined) o.useRegex = cfg.matchSettings.defaultUseRegex;
          if (o.groupId === undefined) o.groupId = null;
          /* ③b 「抓取后续字段」模块总开关（K71）——**读路径**的脏值归一。
           * 规则与写路径 `storage.newKeyword` **共用同一个函数**（`normalizeFetchEnabled`，
           * 见本文件顶部；两处各写一份就是 R4 实测到的"null 两路判据不一致"）。
           * 这里只管"读"（直接躺在 chrome.storage 里的存量关键词），不改写也不清空 `fetchLabels`
           * —— "内容保留"是用户口径。`changed.invalid` 是既有的变更登记通道（无消费方，零风险）。 */
          {
            const fe = normalizeFetchEnabled(o.fetchEnabled, o.fetchLabels);
            if (fe !== o.fetchEnabled) changed.invalid.push('fetchEnabled');
            o.fetchEnabled = fe;
          }
          /* ③c 「抓取范围」（K74）——**读路径**：缺键/非法值 → `auto`；合法值一律尊重。
           * 与写路径 `storage.newKeyword`、消费侧 `fetch.js` 共用同一个 `normalizeFetchScope`。 */
          {
            const sc = normalizeFetchScope(o.fetchScope);
            if (sc !== o.fetchScope) changed.invalid.push('fetchScope');
            o.fetchScope = sc;
          }

          /* ③a 图片识别（OCR）**前置条件**兜底（用户确认口径）：
           *   图片命中是「抓取后续字段」的一个分支 —— 图片正是从**这些字段的值格**里取的，
           *   所以没配抓取字段就无从取图；而「图片命中关键词」是唯一的匹配口径
           *   （不再回落成规则核心词），留空则没有任何东西可匹配。
           * 两种存量脏配置都**只关开关、不动文本**（`imgOcrKeyword` 原样保留，
           * 用户重新勾选时不必重填）。 */
          if (o.imgOcr) {
            const hasFetch = !!(o.fetchLabels && String(o.fetchLabels).trim());
            const hasWord = !!(o.imgOcrKeyword && String(o.imgOcrKeyword).trim());
            if (!hasFetch || !hasWord) {
              o.imgOcr = false;
              changed.invalid.push('imgOcr');
            }
          }
          return o;
        }).filter(Boolean);
      }

      return { config: cfg, changed };
    },

    /** 从 chrome.storage 读取（宽容）。返回 {config, changed} */
    async load(area) {
      const store = (area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local));
      if (!store) return this.normalize({});
      const raw = await store.get(null);
      return this.normalize(raw);
    },

    /**
     * 写回时剔除废弃键，避免脏字段循环落盘。
     * B6：`head.tail` 形式**也要真的删掉** —— 原来这里 `continue`（注释写"嵌套键由 normalize 处理"），
     * 可 `normalize` 只作用于**读**：导入一份带 `highlightStyle.defaultBorderColor` 的旧备份时，
     * `patch()` 会把它原样写回存储，"写入时不再落盘"那句只活在注释里（文件顶部第 10 行）。
     * 实现保持两条：**只删存在的键**、**不新建对象**（`out[head]` 不是普通对象就什么都不做）；
     * 命中的嵌套块做一次浅拷贝再删，避免改到调用方传进来的那个对象。
     */
    stripDeprecated(patch) {
      const out = Object.assign({}, patch);
      for (const key of DEPRECATED_KEYS) {
        const dot = key.indexOf('.');
        if (dot < 0) {
          if (key in out) delete out[key];
          continue;
        }
        const head = key.slice(0, dot);
        const tail = key.slice(dot + 1);
        const box = out[head];
        if (!box || typeof box !== 'object' || Array.isArray(box) || !(tail in box)) continue;
        const copy = Object.assign({}, box);
        delete copy[tail];
        out[head] = copy;
      }
      return out;
    },

    /** 供 meta-check #3「死配置扫描」使用：defaults 的扁平键路径清单 */
    keyPaths() {
      const paths = [];
      const walk = (obj, prefix) => {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          const p = prefix ? prefix + '.' + k : k;
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
          else paths.push(p);
        }
      };
      walk(this.defaults, '');
      return paths;
    },

    DEPRECATED_KEYS,
    ENUMS
  };

  KH.Config = Config;
})();
