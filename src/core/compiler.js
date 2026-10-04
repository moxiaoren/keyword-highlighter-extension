/* ============================================================================
 * src/core/compiler.js · ②Compile + 扩展点① RuleAdapter
 * ----------------------------------------------------------------------------
 * 职责：把「配置里的关键词/分组/罕见字/组合词」编译成**统一的 CompiledRule**。
 *   · 编译只做一次（配置变更时），扫描阶段直接复用，避免逐节点解析 flags。
 *   · 匹配类型（普通 / 全词 / 正则 / 组合词 lr / 组合词 tb / 罕见字）**不在这里分支**，
 *     而是各自注册一个 RuleAdapter；本文件只负责编排（"后续新功能只注册不改内核"）。
 *
 * 扩展点①使用方式（新增一种"匹配类型"）：
 *   KH.Compiler.adapters.register('my-kind', { compile(kw, cfg) { return rule|null; } });
 *   —— 内核文件 diff = 0（UN-06 验收）。
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** CompiledRule 契约：
   * {
   *   ruleId, kind, source           // kind 由 Adapter 决定
   *   pattern: RegExp | null         // 普通/正则类的匹配器（null 表示交给 Probe 自判）
   *   raw: string,                   // 原始输入（用于 contentKey 与展示）
   *   flags: { caseSensitive, wholeWord, useRegex },
   *   style: { bgColor, textColor } | null,
   *   visual: boolean,               // false = 仅抓取（D2）
   *   meta: object                   // 组合词标题/期望值、罕见字含义、抓取字段配置等
   * }
   */

  /** 通用注册表工厂 —— 四个扩展点共用同一实现（统一逻辑的第一步） */
  function createRegistry(label) {
    const map = new Map();
    return {
      label,
      register(name, impl) {
        if (map.has(name)) console.warn('[KH] ' + label + ' 重复注册，将覆盖:', name);
        map.set(name, impl);
        return () => map.delete(name);
      },
      get(name) { return map.get(name) || null; },
      has(name) { return map.has(name); },
      names() { return Array.from(map.keys()); },
      entries() { return Array.from(map.entries()); }
    };
  }

  /** 转义正则元字符（唯一实现，旧版散落在 utils.escapeRegex 与 keyword-engine 两处） */
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 统一的正则构造 —— 全工程唯一实现（旧版散落在 utils.js:430-453 与 keyword-engine.js 多处）。
   * 关键细节（**逐条对齐旧版 v1.52.0，不得回退**）：
   *   · 全词边界必须用 **Unicode 词字符前瞻/后顾**，不能直接用 `\b`：
   *     `\b` 只对 ASCII 字母数字生效，纯中文词用 `\b` **永远匹配不到**（旧版踩过的坑）。
   *   · 全词 且 正则 同时开启时，先用 `(?:)` 非捕获包裹再加边界，
   *     否则 `A|B|C` 会变成 `A|B|C\b`，中间分支漏边界（旧版 utils.js:443 注释明确记录）。
   *   · 启用 Unicode 边界时必须带 `u` flag。
   *
   * 【必须带 `g` flag —— 这是踩回来的血泪教训】
   *   扫描侧是 `while ((m = re.exec(text)) !== null)` 的**多命中循环**，它依赖 `lastIndex` 推进：
   *     · 没有 `g` 时 `lastIndex` 永远是 0，`exec` 每次都返回同一个首个匹配 → **死循环**；
   *     · 就算循环被 `if (!re.global) break` 保护住，也只会拿到**第一个**匹配
   *       → 直接表现就是"`BUG|FEATURE` 只命中 BUG、后面的分支全漏"
   *       （K7 实测：全词+正则多分支时，首个分支之后的词永不命中）。
   *   曾经为了躲"带 g 的正则对象有 lastIndex 状态、多次 test 会假阴性"而**去掉了 g**，
   *   结果把多命中能力整个打掉了 —— 那次判断是错的。正确做法是：
   *     `buildPattern` 始终带 `g`（这是"逐条产出全部命中"的语义要求），
   *     而**调用方必须复制一份再遍历**（`new RegExp(src, flags)`），不要复用同一个带 g 的对象
   *     去连续 `test()`（那才会因为 lastIndex 残留而假阴性）。
   *   扫描侧与组合词侧都已经在"复制 + 遍历"，所以这里带 g 是安全的。
   */
  function buildPattern(raw, flags, options) {
    const opts = options || {};
    const caseSensitive = !!flags.caseSensitive;
    const wholeWord = !!flags.wholeWord;
    const useRegex = !!flags.useRegex;

    let pattern = String(raw == null ? '' : raw);
    if (!useRegex) pattern = escapeRegex(pattern);

    let jsFlags = 'g';                      // ★ 多命中遍历的前提：不带 g 就只会拿到第一个匹配
    if (!caseSensitive) jsFlags += 'i';

    if (wholeWord) {
      jsFlags += 'u';
      const boundary = '[\\p{L}\\p{N}_]';
      pattern = '(?<!' + boundary + ')(?:' + pattern + ')(?!' + boundary + ')';
    }

    try {
      return new RegExp(pattern, jsFlags);
    } catch (err) {
      console.warn('[KH] 正则编译失败，已跳过该词:', raw, err && err.message);
      return null;
    }
  }

  /**
   * 视觉与重要笔记的**唯一解析入口**（全工程只此一份）。
   *
   * 为什么必须有它：旧版把这段解析写在 `_compileKeywords` 里（keyword-engine.js:86-108），
   * 但 v2 重构时只把它"翻译"成了 `style: kw.style || null` —— 而**没有任何地方给 `kw.style` 赋值**，
   * 于是「关键词自身颜色」「分组配色」「分组重要」「分组统一重要笔记」「底色复用」「分组图片尺寸」
   * 六项能力全部静默失效（实测：无论怎么配，命中的 `::highlight` 永远只用全局默认色）。
   * 这类"配置项还在、UI 还在、就是不生效"的缩水最难发现，所以在这里一次性补齐并加了回归用例。
   *
   * 优先级逐条对齐旧版（**不得回退**）：
   *   底色     = 分组底色  > 关键词底色  > 全局默认底色（Config.defaults.highlightStyle）
   *   文字色   = 分组文字色 > 关键词文字色 > 全局默认文字色
   *   重要     = 关键词重要 或 分组重要（分组取消则自动取消）
   *   重要笔记 = 关键词笔记（非空） > （分组重要且分组笔记非空）
   *   底色复用 = 关键词勾选 或 （分组重要且分组勾选）→ 铺该词实际底色，否则不铺
   *   图片尺寸 = 关键词尺寸 > （分组重要且分组尺寸）
   *
   * 解析**只在编译期发生一次**，结果写进 `rule.style` / `rule.meta`；
   * 下游（Renderer / 重要笔记 / 备注卡片 / 统计）一律不再查分组表 ——
   * 这就是"功能只消费命中，不回查配置"的落点。
   */
  function resolveVisual(kw, cfg) {
    const c = cfg || {};
    const hl = c.highlightStyle || {};
    let group = null;
    if (kw && kw.groupId && Array.isArray(c.groups)) {
      for (const g of c.groups) if (g && g.id === kw.groupId) { group = g; break; }
    }
    const groupImportant = !!(group && group.important);
    const bg = (group && group.bgColor) || kw.bgColor || hl.defaultBgColor || '';
    /* `textIsDefault` 告诉渲染层："这个文字色只是**全局默认**，不是用户针对这个词/这个组选的"。
     * 渲染层据此决定要不要覆盖原网页的文字色（用户实测场景：网页里本来标红的字，被命中后变成黑色）。
     * 规则：默认色**不覆盖**原色，除非"原色 vs 我们的底色"分不开（见 renderer 的感知判据）；
     * 关键词/分组**显式**设过的文字色仍然照旧强制生效（那是用户明确的选择）。 */
    const ownFg = (group && group.textColor) || kw.textColor || '';
    const fg = ownFg || hl.defaultTextColor || '';
    /* 【K71 裁定 2 · 正文按模块归属】卡片**存在性**仍由 `important || wantFetch` 决定（不变），
     * 但卡片**正文**归「重要笔记」模块管：该词自己的笔记正文 / 底色复用 / 图片尺寸三项
     * 都要**乘上 `kw.important`**。不乘的后果 R4 实测到了：一条"抓取开着、重要笔记没勾"的词
     * 靠 `wantFetch` 进了面板，却把 `importantNote` 正文一起带进去（§五.3 后半被绕过）。
     * ⚠️ **分组级三处（`groupImportant`）一字不动** —— 分组弹窗那颗「重要」是另一条既有口径。 */
    const ownNote = (kw.important && kw.importantNote && String(kw.importantNote).trim()) || '';
    const groupNote = (groupImportant && group.importantNote && String(group.importantNote).trim()) || '';
    const reuse = !!((kw.important && kw.impNoteUseHlColor) || (groupImportant && group.impNoteUseHlColor));
    return {
      style: { bgColor: bg, textColor: fg, textIsDefault: !ownFg },
      meta: {
        important: !!(kw.important || groupImportant),
        importantNote: ownNote || groupNote || '',
        impNoteBg: reuse ? bg : '',
        imgSize: (kw.important && kw.imgSize) || (groupImportant && group.imgSize) || ''
      }
    };
  }

  /**
   * 图片文字识别（OCR）三个 meta 字段的**唯一解析点**（普通词与组合词共用）。
   *
   * 为什么必须单源：`imgOcr` 曾是"组合词专属"（只有 combo 的 compile 里算过一遍），
   * 于是普通词 + 抓取字段那条路径根本没有 OCR 标志 —— 而用户确认的新口径恰恰是
   * "图片命中 = 抓取后续字段的一个分支，普通词也能用"。若在 combo.js 与 compiler.js
   * 各写一份 `imgOcrMax` 的默认值逻辑，就又回到"同一件事两处实现"。
   *
   * 语义（用户确认）：
   *   · `imgOcr`       —— 勾了「识别图片文字」且**本条不是仅抓取**（没有核心词就没有要找的字）。
   *     注意这里**不**校验 `fetchLabels`：那是配置层的兜底（`Config.normalize`）与消费层
   *     （`img-ocr.js` 只处理配了抓取字段的规则）的职责；锚点**只来自真实命中**
   *     （K75 起：组合词"标题词定位即锚点"的旧路已删 —— 没命中就不做 OCR、不判图片关键词）。
   *   · `imgOcrMax`    —— 每处最多识别几张（留空用 `Config.defaults.imgOcr.defaultMax`）。
   *   · `imgOcrKeyword`—— 图片命中关键词（**当正则**匹配识别文本；leave 空 = 不参与图片命中）。
   * @param {object} kw 配置关键词
   * @param {object} [opts] `{ fetchOnly: true }` = 仅抓取（无核心词）
   */
  function ocrMeta(kw, opts) {
    const o = opts || {};
    const def = (KH.Config && KH.Config.defaults && KH.Config.defaults.imgOcr) || {};
    const own = parseInt(kw && kw.imgOcrMax, 10);
    const max = Math.max(1, Math.min(20, own > 0 ? own : (def.defaultMax || 1)));
    return {
      imgOcr: !!(kw && kw.imgOcr) && !o.fetchOnly,
      imgOcrMax: max,
      imgOcrKeyword: String((kw && kw.imgOcrKeyword) == null ? '' : kw.imgOcrKeyword).trim(),
      /* 「抓取范围」（K74）：挂在这个**共用出口**上 —— 普通词与组合词两条编译路径都会 spread 它，
       * 于是 `src/features/combo/**` 一行都不用改（那在本轮是禁写目录），
       * 而归一函数仍只有 `KH.Config.normalizeFetchScope` 一份。 */
      fetchScope: KH.Config.normalizeFetchScope(kw && kw.fetchScope)
    };
  }

  const adapters = createRegistry('RuleAdapter');

  /* ---- 内置 Adapter ①：普通关键词（含全词/正则/大小写） ---- */
  adapters.register('normal', {
    order: 1000,   // 兜底适配器：优先级最低，最后才轮到它
    /**
     * 兜底适配器只接管"没有任何特殊标记"的关键词。
     * 判定只按**字段**（不写死功能名）：
     *   · `kind:'rare'` / `rareChar` —— 罕见字
     *   · `cellVerifyEnabled`       —— 组合词（左右格 / 上下格 / 仅抓取都靠它）
     * 注意**不要**把 `fetchLabels` 也算作特殊标记：旧版允许"普通词 + 抓取后续字段"
     * （`_extractFetched` 对普通命中同样生效），把它排除掉会让这类关键词被
     * 所有 Adapter 一致拒收 → 词直接消失（P2 实测踩到：F11 的面板因此全空）。
     */
    test(kw) { return !(kw && (kw.kind === 'rare' || kw.rareChar || kw.cellVerifyEnabled)); },
    compile(kw, cfg) {
      const flags = {
        caseSensitive: !!kw.caseSensitive,
        wholeWord: !!kw.wholeWord,
        useRegex: !!kw.useRegex
      };
      const pattern = buildPattern(String(kw.text == null ? '' : kw.text), flags);
      if (!pattern) return null;
      const v = resolveVisual(kw, cfg);
      // 旧版 v1.13.0【3a】：普通词只要配了抓取字段（fetchLabels 非空），即使未标「重要」
      // 也要进重要笔记面板（它的存在意义就是抓右列数据）。没配 = 不进（其余口径照旧）。
      /* K71「抓取后续字段」模块总开关（fetchEnabled）——**编译层是唯一漏斗**：
       * `fetchLabels` 从配置进入运行期只经过这里（普通词）与 combo.js（组合词），
       * 下游（important-note / img-ocr / relevance）**全部**消费 `meta.fetchLabels`。
       * 于是"未启用 ⇒ 这条规则根本没有抓取字段"这一句就够，下游一行不改。
       * ⚠️ 判据必须是 `!== false`（不是 `=== true`）：手写对象 / 第三方导入 / 未迁移的存量
       * 缺这个键时必须**照旧抓取** —— 缺键时的"保守"是保守地继续工作，不是静默停抓。
       * （"缺键按 labels 反推并落键"是迁移层的活，见 storage.js / config.js：两层不矛盾。） */
      const fetchOn = kw.fetchEnabled !== false;
      const wantFetch = fetchOn && !!(kw.fetchLabels && String(kw.fetchLabels).trim());
      return {
        ruleId: kw.id,
        kind: 'normal',
        source: 'keyword',
        pattern,
        raw: String(kw.text == null ? '' : kw.text),
        flags,
        style: v.style,
        visual: kw.fetchOnly === true ? false : true,   // 「仅抓取」= 不渲染（D2）
        meta: Object.assign({
          note: kw.note || '',
          /** 抓取后续字段：允许"普通词 + 抓取"组合（旧版 _extractFetched 的用法）；
           * 模块未启用（`fetchEnabled === false`）→ 归一成空串＝这条规则没有抓取字段 */
          fetchLabels: fetchOn ? (kw.fetchLabels == null ? '' : String(kw.fetchLabels)) : '',
          display: String(kw.text == null ? '' : kw.text),
          groupId: kw.groupId || null
        }, v.meta, ocrMeta(kw), { important: v.meta.important || wantFetch })
      };
    }
  });

  const Compiler = {
    adapters,
    buildPattern,
    resolveVisual,
    /** 图片识别三字段的唯一解析（普通词/组合词共用；见 ocrMeta 注释） */
    ocrMeta,

    /**
     * 把一条配置关键词交给注册表编译 —— **内核不认识任何具体功能名**。
     * 排序按 `order`（缺省 100），先问优先级高的：谁能接管（`test` 通过）就由谁编译。
     *
     * 与旧版的对照：旧版 `compileKeywords`（keyword-engine.js:56-112）里写死了
     * `isRare` / `isCombo` / `cellVerifyAxis==='tb'` 三套条件分支，新增一种组合方式
     * 必须回来改它 → 这正是"逐步实现导致的不统一"来源之一。这里改为注册表驱动：
     * **新增匹配类型 = 在 src/features 下注册一个 Adapter，本文件 diff = 0**（UN-06）。
     *
     * @param {object} kw 单条关键词配置
     * @param {object} cfg 归一化后的完整配置
     * @returns {object|null} CompiledRule
     */
    dispatch(kw, cfg) {
      const ordered = adapters.entries().sort((a, b) => ((a[1] && a[1].order) || 100) - ((b[1] && b[1].order) || 100));
      for (const [, ad] of ordered) {
        if (!ad || typeof ad.compile !== 'function') continue;
        if (ad.test && !ad.test(kw, cfg)) continue;
        return ad.compile(kw, cfg);   // 已被接管：结果就是结果（null = 该词无效，不再回退）
      }
      return null;
    },

    /**
     * 编译全部规则。
     * @param {object} cfg 已 normalize 的完整配置
     * @returns {CompiledRule[]}
     */
    compileAll(cfg) {
      const rules = [];
      const list = (cfg && cfg.keywords) || [];
      for (const kw of list) {
        if (!kw || kw.enabled === false) continue;
        const r = this.dispatch(kw, cfg);
        if (r) rules.push(r);
      }
      return rules;
    }
  };

  KH.Compiler = Compiler;
  KH.createRegistry = createRegistry;
})();
