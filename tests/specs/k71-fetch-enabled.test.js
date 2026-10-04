/* tests/specs/k71-fetch-enabled.test.js — K71「抓取后续字段」模块启用（fetchEnabled）
 * ----------------------------------------------------------------------------
 * 本轮唯一新增的存储键，所以它的三条生命线都必须有回归：
 *   ① **编译层的门**：未启用 ⇒ `meta.fetchLabels` 归一成空串（下游全部消费它，零改动）；
 *      缺键 ⇒ 照旧抓取（单测手写对象 / 第三方导入未迁移时**绝不静默停抓**）。
 *   ② **迁移规则**（两处必须逐字同一条）：缺键按 `fetchLabels` 反推并落键；键存在（含 false）
 *      一律尊重，绝不翻回 true。→ 存量升级后行为不变，用户关掉的不会被"迁移"打开。
 *   ③ **文案/布局清理清单**（R1 的 C1/C2/C4/C5/C7/C8/C11）在**声明层**的机械判定：
 *      这一层是字段真源，声明不对，弹窗怎么渲染都不对。
 *
 * 反向验证（契约 §六）用到的"目标用例"就在这里：去掉编译层的门 → 第一组变红；
 * 去掉 `newKeyword` 的落库/迁移 → 第二组变红。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;
  const S = KH.Store;
  const FM = KH.FieldMap;
  const Config = KH.Config;

  /** dispatch 只需要一个"够用"的配置（与 combo-cell-offset.test.js 同口径） */
  const CFG = {
    keywords: [], groups: [],
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    matchSettings: {}
  };

  /* ============================================================ ① 编译层的门 */

  suite('K71 · 编译层的门：fetchEnabled=false ⇒ 这条规则没有抓取字段');

  await test('★ 普通词：false → fetchLabels 空串 + important 不成立；true/缺键 → 原样抓取', () => {
    const off = C.dispatch({ id: 'k', text: '甲', fetchLabels: '备注', fetchEnabled: false }, CFG);
    truthy(off, '普通词应能编译');
    eq(off.kind, 'normal');
    eq(off.meta.fetchLabels, '', '★ 未启用 ⇒ meta.fetchLabels 必须归一成空串（下游据此不抓）');
    eq(!!off.meta.important, false, '未启用 ⇒ 不该因为"抓取字段非空"而进重要笔记面板');

    const on = C.dispatch({ id: 'k', text: '甲', fetchLabels: '备注', fetchEnabled: true }, CFG);
    eq(on.meta.fetchLabels, '备注', '启用时原样带进 meta');
    eq(!!on.meta.important, true, '启用时照旧自动进重要笔记（旧版 wantFetch 口径）');

    /* ★ 缺键＝照旧抓取：手写对象 / 未迁移的存量 / 第三方导入都走这条。
     * 若把门写成 `=== true`，这一条会当场变红 —— 它守的正是"绝不静默停抓"。 */
    const missing = C.dispatch({ id: 'k', text: '甲', fetchLabels: '备注' }, CFG);
    eq(missing.meta.fetchLabels, '备注', '★ 缺键必须照旧抓取（不是"缺键就停抓"）');
    eq(!!missing.meta.important, true, '缺键时同样照旧进面板');
  });

  await test('★ 组合词：false → meta.fetchLabels 空串（combo.js 那条编译路径同口径）', () => {
    const base = {
      id: 'K', text: '甲', cellVerifyEnabled: true, cellVerify: '表头', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', fetchLabels: '备注'
    };
    const off = C.dispatch(Object.assign({}, base, { fetchEnabled: false }), CFG);
    truthy(off, '组合词应能编译');
    eq(off.meta.fetchLabels, '', '组合词未启用 ⇒ 同样归一成空串');
    const on = C.dispatch(Object.assign({}, base, { fetchEnabled: true }), CFG);
    eq(on.meta.fetchLabels, '备注');
    const missing = C.dispatch(Object.assign({}, base, {}), CFG);
    eq(missing.meta.fetchLabels, '备注', '缺键的组合词照旧抓取');
  });

  await test('★ 仅抓取词：未启用 → 不产生任何面板条目（important 不再凭空为真）', () => {
    const base = {
      id: 'K', text: '', cellVerifyEnabled: true, cellVerify: '应用名称',
      comboAxis: 'lr', cellVerifyMatchMode: 'include', fetchLabels: '包名'
    };
    const off = C.dispatch(Object.assign({}, base, { fetchEnabled: false }), CFG);
    truthy(off, '仅抓取词应能编译');
    eq(off.kind, 'fetch-only');
    eq(off.meta.fetchLabels, '');
    eq(!!off.meta.important, false, '★ 连抓取字段都没有了，就不该再凭空算"要进面板"');
    /* 反向：缺键的仅抓取词照旧（旧版 specialFetch 语义不变） */
    const missing = C.dispatch(Object.assign({}, base, {}), CFG);
    eq(!!missing.meta.important, true, '缺键时仍照旧进面板');
  });

  /* ========================================================== ② 迁移规则 */

  suite('K71 · fetchEnabled 的迁移：缺键按 fetchLabels 反推，键存在一律尊重');

  await test('★ 写路径（sanitizeKeyword/newKeyword）：有字段 → true；没有 → false；显式 false 不翻回', () => {
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲' }, {}).fetchEnabled, true,
      '★ 有非空 fetchLabels 的旧数据 → true（导入/清洗后照样抓取）');
    eq(S.sanitizeKeyword({ text: 'x' }, {}).fetchEnabled, false, '没有字段 → false');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '   ' }, {}).fetchEnabled, false, '纯空白也算没有');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: false }, {}).fetchEnabled, false,
      '★ 键存在（false）→ 一律尊重，绝不翻回 true');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: true }, {}).fetchEnabled, true);
    /* 迁移**不许**动内容：fetchLabels 逐字保留（用户口径：关闭后内容保留） */
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: false }, {}).fetchLabels, '甲',
      '★ 关闭开关不得清空 fetchLabels');
  });

  await test('★ 读路径（Config.normalize）：同一条规则 —— 存量升级后继续抓取，关掉的不会被打开', () => {
    const r1 = Config.normalize({ keywords: [{ id: 'a', text: 'x', fetchLabels: '甲' }] });
    eq(r1.config.keywords[0].fetchEnabled, true, '★ 存量关键词（缺键 + 有字段）升级后必须继续抓取');
    eq(r1.config.keywords[0].fetchLabels, '甲', 'fetchLabels 逐字不动');

    const r2 = Config.normalize({ keywords: [{ id: 'b', text: 'x', fetchLabels: '甲', fetchEnabled: false }] });
    eq(r2.config.keywords[0].fetchEnabled, false, '★ 用户关掉的不能被迁移翻回来');
    eq(r2.config.keywords[0].fetchLabels, '甲', 'fetchLabels 逐字不动');

    const r3 = Config.normalize({ keywords: [{ id: 'c', text: 'x' }] });
    eq(r3.config.keywords[0].fetchEnabled, false, '没字段的存量词 → false');
  });

  /* ============================== ②b 返工（K71 裁定 4）：脏值一个函数、两路同判 ====== */

  suite('K71 返工 · 黄 2：脏值真值表（读路径与写路径共用同一个函数）');

  const DIRTY_TABLE = [true, false, undefined, null, 0, '', '0', 'false', 1, 'true'];

  await test('★ 真值表 10 个值：两路逐项相同 + 两路都幂等', () => {
    for (const v of DIRTY_TABLE) {
      const kw = { id: 'd', text: 'x', fetchLabels: '甲' };
      if (v !== undefined) kw.fetchEnabled = v;
      const label = 'fetchEnabled=' + JSON.stringify(v);

      /* 写路径：sanitizeKeyword（弹窗/批量/CSV/JSON 导入的落库口） */
      const w = S.sanitizeKeyword(Object.assign({}, kw), {});
      /* 读路径：Config.normalize（直接躺在 chrome.storage 里的存量词） */
      const r = Config.normalize({ keywords: [Object.assign({}, kw)] }).config.keywords[0];

      eq(w.fetchEnabled, r.fetchEnabled, '★ 两路判据必须逐项相同（' + label + '）：写=' + w.fetchEnabled + ' 读=' + r.fetchEnabled);

      /* 期望值按裁定 4 的真值表：缺键反推；键存在（含脏值）一律 !!v */
      const want = (v === undefined) ? true : !!v;
      eq(w.fetchEnabled, want, '真值表（' + label + '）应为 ' + want);

      /* 幂等：normalize(sanitize(x)) ≡ sanitize(x)；sanitize(normalize(x)) ≡ normalize(x) */
      const w2 = Config.normalize({ keywords: [Object.assign({}, kw, { fetchEnabled: w.fetchEnabled })] }).config.keywords[0];
      eq(w2.fetchEnabled, w.fetchEnabled, 'normalize(sanitize(x)) 必须幂等（' + label + '）');
      const r2 = S.sanitizeKeyword(Object.assign({}, kw, { fetchEnabled: r.fetchEnabled }), {});
      eq(r2.fetchEnabled, r.fetchEnabled, 'sanitize(normalize(x)) 必须幂等（' + label + '）');
    }
    /* 同一个函数（不是两份拷贝）：两处都必须能取到它 */
    truthy(typeof Config.normalizeFetchEnabled === 'function', '归一函数必须挂在 Config 上（写路径要调它）');
    eq(Config.normalizeFetchEnabled(null, '甲'), false, '键存在 + null → false（falsy 当关）');
    eq(Config.normalizeFetchEnabled(undefined, '甲'), true, '缺键 + 有字段 → true（反推）');
    eq(Config.normalizeFetchEnabled(undefined, '  '), false, '缺键 + 纯空白字段 → false');
    eq(Config.normalizeFetchEnabled('false', '甲'), true, "★ 'false' 是非空字符串 ⇒ !!v = true（与 R4 实测的两路口径一致）");
  });

  await test('★ 黄 1 已登记口径：CSV 往返后 fetchEnabled = 按非空 fetchLabels 反推（＝true）—— 已知且有意', async () => {
    /* R0 裁定 3：本轮**不扩列**（CSV 仍 18 列）。代价是"关闭态"不进 CSV：
     * 导出（无该键）→ 导入（缺键）→ 按非空 fetchLabels 反推 = **true**。
     * 这条用例把该行为钉成"已知且有意"，防后人当 bug 顺手改掉（JSON 往返保真见后半段）。 */
    const cfg = { keywords: [], groups: [] };
    const kw = S.sanitizeKeyword({ text: 'CSV开关词', fetchLabels: '甲字段', fetchEnabled: false }, {});
    eq(kw.fetchEnabled, false, '前置：这条词的开关确实是关的');

    const csv = S.exportCSV({ keywords: [kw], groups: [] });
    truthy(csv.indexOf('CSV开关词') > 0, '导出的 CSV 里应有这条词');
    truthy(csv.indexOf('fetchEnabled') < 0, 'CSV 里不该出现 fetchEnabled 键（18 列契约）');

    const stats = await S.importCSV(csv, cfg);
    eq(stats.added, 1, '应导入 1 条');
    const back = await S.load();
    const k = (back.keywords || []).find((x) => x.text === 'CSV开关词');
    truthy(k, '导入后应能读回该词');
    eq(k.fetchLabels, '甲字段', '字段本身照旧保真');
    eq(k.fetchEnabled, true,
      '★ CSV 往返后该键＝按非空 fetchLabels 反推（＝启用）—— 本轮**有意**如此（R0 裁定 3），不是 bug');

    /* 对照：JSON 往返（含该键）必须保真 —— "要连开关一起带走请用 JSON 导出" */
    const json = S.exportJSON(null, { keywords: [kw], groups: [] });
    const jk = (JSON.parse(json).keywords || []).find((x) => x.text === 'CSV开关词');
    truthy(jk, 'JSON 导出里应有该词');
    eq(jk.fetchEnabled, false, 'JSON 导出必须带上 false（保真通道）');

    /* 零污染：本用例往共享的 chrome.storage 垫片里写过一条，收尾删掉 */
    await S.removeKeywords((back.keywords || []).filter((x) => x.text === 'CSV开关词').map((x) => x.id));
    const after = await S.load();
    falsy((after.keywords || []).some((x) => x.text === 'CSV开关词'), '★ 用例必须零污染（导入的那条要删干净）');
  });

  /* ============================== ②c 返工（K71 裁定 2 · 红牌 B）：正文按模块归属 ====== */

  suite('K71 返工 · 红牌 B：卡片正文按模块归属（抓取决定抓取值、重要笔记决定本词正文）');

  await test('★ 三条语义：imp 关 + 抓取开 → 卡片在、出抓取值、**不带**笔记正文；imp 开 → 与现状一致；两者都关 → 卡片不存在', () => {
    const base = {
      id: 'kB', text: '甲', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      importantNote: '本词笔记正文', impNoteUseHlColor: true, imgSize: 40,
      cellVerifyEnabled: false, fetchLabels: '备注'
    };
    /* ① imp 关 + 抓取开：这就是 R4 探针实测的"正文泄露"场景（`host=true panel=true 正文出现=true`） */
    const leak = C.dispatch(Object.assign({}, base, { important: false, fetchEnabled: true }), CFG);
    truthy(leak, '普通词应能编译');
    eq(!!leak.meta.important, true, '① 抓取开着 → 卡片**仍要存在**（验收 2「抓取词必须进面板」不变）');
    eq(leak.meta.fetchLabels, '备注', '① 抓取值照旧出（抓取模块决定）');
    eq(leak.meta.importantNote, '', '★ ① 没勾「重要笔记」→ 本词的笔记正文**不许**进 meta（红牌 B 的靶心）');
    eq(leak.meta.impNoteBg, '', '★ ① 本词的复用底色同样不参与');
    eq(leak.meta.imgSize, '', '★ ① 本词自己的图片尺寸同样不参与');

    /* ② imp 开 → 与现状完全一样 */
    const on = C.dispatch(Object.assign({}, base, { important: true, fetchEnabled: true }), CFG);
    eq(!!on.meta.important, true, '② 卡片在');
    eq(on.meta.fetchLabels, '备注', '② 抓取值在');
    eq(on.meta.importantNote, '本词笔记正文', '② 勾了「重要笔记」→ 正文照旧');
    eq(on.meta.imgSize, 40, '② 图片尺寸照旧');
    eq(on.meta.impNoteBg, '#ff9500', '② 复用底色＝该词实际生效底色（全局默认）');

    /* ③ 两者都关 → 卡片不存在（无 important、无抓取字段） */
    const none = C.dispatch(Object.assign({}, base, { important: false, fetchEnabled: false }), CFG);
    eq(!!none.meta.important, false, '③ 两个模块都关 → 不该进面板');
    eq(none.meta.fetchLabels, '', '③ 抓取字段也归一成空');
    eq(none.meta.importantNote, '', '③ 正文同样不参与');
  });

  await test('★ 分组级三处**一字不动**：分组 important 的笔记/底色/尺寸照旧生效（另一条既有口径）', () => {
    const cfg2 = {
      groups: [{ id: 'g1', name: '组一', bgColor: '#111111', textColor: '#eeeeee', important: true, importantNote: '组笔记', impNoteUseHlColor: true, imgSize: 88 }],
      highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' }
    };
    const v = C.resolveVisual({ groupId: 'g1', important: false, importantNote: '自己的', impNoteUseHlColor: true, imgSize: 40 }, cfg2);
    eq(v.meta.importantNote, '组笔记', '分组重要的笔记照旧（kw 那半被门挡住 → 落回分组）');
    eq(v.meta.impNoteBg, '#111111', '分组重要的复用底色照旧');
    eq(v.meta.imgSize, 88, '分组重要的尺寸照旧');
    eq(!!v.meta.important, true, '分组重要 → 词也重要（分组级口径未动）');
  });

  /* ================================================ ③ 字段声明与文案清理 */

  suite('K71 · 字段声明（fetchEnabled 形态/位置/默认）');

  await test('★ 新胶囊与另三颗**逐项同形**：head + chip + bool + label「启用」+ 无 width/newRow/sepBefore', () => {
    const f = FM.byKey('fetchEnabled');
    truthy(f, '字段表必须有 fetchEnabled');
    eq(f.sec, 'fetch', '归属「抓取后续字段」分区');
    eq(f.label, '启用', '文案与另三颗一致');
    eq(f.type, 'bool', '仍是 bool（存储/判定口径不动）');
    eq(f.chip, true, '胶囊形态');
    eq(f.head, true, 'head:true ＝ 渲染到模块标题行右侧（"右上角"的唯一实现）');
    eq(f.width, undefined, '不许带 width:2');
    eq(f.newRow, undefined, '不许带 newRow');
    eq(f.sepBefore, undefined, '不许带 sepBefore');
    eq(f.csv, 0, '不进 CSV（存储契约仍是 18 列）');
    /* 【K75 口径变更】新建默认由 **勾选** 改成 **未勾选**（用户："抓取后续字段的启用改为默认关闭"）。
     * 迁移规则一个字没改 —— 缺键仍按非空 fetchLabels 反推（见本文件上面的两条用例，仍绿）。 */
    eq(f.def(KH.Config.defaults), false, '★ 新建关键词默认＝**未勾选**（K75 用户口径）');
    eq(FM.defaults(KH.Config.defaults).fetchEnabled, false, '经 coerce 后默认值仍是 false');
  });

  await test('★ 声明位置：紧跟 fetchLabels 之后（fetch 分区第一项仍是那个输入框）', () => {
    const keys = FM.fieldsOf('fetch').map((x) => x.key);
    eq(keys[0], 'fetchLabels', '★ fetch 分区第一项必须仍是「字段」输入框，实际 ' + JSON.stringify(keys));
    eq(keys.indexOf('fetchEnabled'), keys.indexOf('fetchLabels') + 1, '紧跟在它后面（清单可读性），实际 ' + JSON.stringify(keys));
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      truthy(keys.indexOf(k) > keys.indexOf('fetchEnabled'), k + ' 仍应排在它之后');
    }
  });

  await test('★ 方向自适应（映射层护栏）：切到上下格**不禁用存储** —— cellOffset 值必须原样保留', () => {
    /* 禁用只是"别让人配出无效状态"，不是"把值清掉"：`toStore` 只在未启用组合时清
     * `cellVerify*`，**从不清 `cellOffset`** —— 防 R3/R4 顺手把它当 cellVerify* 一起清。 */
    const cfg = Config.defaults;
    const kw = Object.assign(FM.defaults(cfg), {
      text: '核心', cellVerifyEnabled: true, cellVerify: '资质类型', cellOffset: '2'
    });
    eq(FM.toStore(Object.assign({}, kw, { comboAxis: 'tb' }), cfg).cellOffset, '2',
      '★ 上下格时 cellOffset 仍应落库（值保留但不生效）');
    eq(FM.toStore(Object.assign({}, kw, { comboAxis: 'lr' }), cfg).cellOffset, '2', '左右格照旧');
    eq(S.sanitizeKeyword(Object.assign({}, kw, { comboAxis: 'tb' }), cfg).cellOffset, '2',
      '清洗层也不许把它当 cellVerify* 清掉');
  });

  suite('K71 · 文案/布局清理清单（R1 的 C1/C2/C4/C5/C7/C8/C11）在声明层的判定');

  await test('C1/C2：模块内 label 不再复述模块名（「字段」「笔记内容」）', () => {
    eq(FM.byKey('fetchLabels').label, '字段', 'C1：模块标题已写「抓取后续字段」→ 正文 label 缩成「字段」');
    truthy(FM.byKey('fetchLabels').placeholder.indexOf('（留空') < 0,
      'C1：placeholder 里的长括注去掉，实际 ' + JSON.stringify(FM.byKey('fetchLabels').placeholder));
    eq(FM.byKey('importantNote').label, '笔记内容', 'C2：模块标题已写「重要笔记」→ label 改「笔记内容」');
  });

  await test('C4：cellOffset 的「默认」占位删掉（不是换个字），含义收进 hint', () => {
    const f = FM.byKey('cellOffset');
    falsy('placeholder' in f, '★ 必须**删掉** placeholder 属性，实际 ' + JSON.stringify(f.placeholder));
    truthy(f.hint.indexOf('留空') >= 0, 'hint 必须交代留空＝什么');
    truthy(f.hint.indexOf('右') >= 0, 'hint 必须交代是"右边第几格"');
  });

  await test('C5：「每处最多」的提示说的是张数不是尺寸；「尺寸」才说尺寸', () => {
    const max = FM.byKey('imgOcrMax').hint || '';
    truthy(max.indexOf('张') >= 0, 'imgOcrMax 的 hint 应交代"几张"，实际 ' + JSON.stringify(max));
    falsy(max.indexOf('尺寸') >= 0, '★ imgOcrMax 不该再出现"尺寸"（原来 int 分支硬编码写错了对象）');
    truthy((FM.byKey('imgSize').hint || '').indexOf('尺寸') >= 0, 'imgSize 的 hint 应交代尺寸');
  });

  await test('C7：四条模块说明都是短句（≤18 字）且长解释进了 tooltip；combo 静态值与 AXIS.lr 同一句', () => {
    for (const s of FM.FORM_SECTIONS) {
      const len = String(s.hint || '').trim().length;
      truthy(len >= 1 && len <= 18, '「' + s.title + '」说明应是 1..18 字的短句，实际 ' + len + ' 字：' + JSON.stringify(s.hint));
      truthy(String(s.hintTitle || '').trim().length > 0, '「' + s.title + '」的长解释必须进 hintTitle（tooltip）');
    }
    for (const axis of ['lr', 'tb']) {
      const lb = FM.axisLabels(axis);
      const len = String(lb.hint || '').trim().length;
      truthy(len >= 1 && len <= 18, axis + ' 档说明应 ≤18 字，实际 ' + len + '：' + JSON.stringify(lb.hint));
      truthy(String(lb.hintTitle || '').trim().length > 0, axis + ' 档必须带 hintTitle（长解释）');
    }
    /* C7-③：静态那份与运行时那份必须是**同一句话**（它被覆盖是事实，但不该是另一句不同的话） */
    eq(FM.FORM_SECTIONS.find((s) => s.id === 'combo').hint, FM.axisLabels('lr').hint,
      'C7：FORM_SECTIONS.combo.hint 必须与 AXIS.lr.hint 逐字相同（消除第二来源）');
    /* 方向切换时可见文案要跟着变（否则"方向自适应"在文案层就是假的） */
    truthy(FM.axisLabels('lr').hint !== FM.axisLabels('tb').hint, '两档说明必须不同');
  });

  await test('C8：四个字段的 tooltip 非空、含约定关键词、且不出现本模块标题（与"正文不复述"口径一致）', () => {
    const need = [
      ['fetchLabels', '留空'],
      ['cellOffset', '右'],
      ['imgOcr', '图'],
      ['imgOcrKeyword', '正则']
    ];
    for (const [key, kw] of need) {
      const f = FM.byKey(key);
      truthy(String(f.hint || '').trim().length > 0, key + ' 必须有 hint（否则容器 tooltip 是空的）');
      truthy(f.hint.indexOf(kw) >= 0, key + ' 的 hint 应含「' + kw + '」，实际 ' + JSON.stringify(f.hint));
      const secTitle = (FM.FORM_SECTIONS.find((s) => s.id === f.sec) || {}).title || '';
      falsy(f.hint.indexOf(secTitle) >= 0,
        '★ ' + key + ' 的 tooltip 不该复述模块标题「' + secTitle + '」，实际 ' + JSON.stringify(f.hint));
    }
    /* C1 追加口径：@表达式 是"按本行"，且不再拿另一个字段当参照 */
    truthy(FM.byKey('fetchLabels').hint.indexOf('本行') >= 0, 'fetchLabels 的 @表达式 说明必须写准"按本行"');
    falsy(FM.byKey('fetchLabels').hint.indexOf('取值格') >= 0,
      '★ 不再用「取值格（右起）」当参照（那个字段在上下档正好是禁用态）');
  });

  await test('C11：明确不做的那些（CSV 18 列 / 模块标题 / 分组弹窗文案 / 分区清单）一律未动', () => {
    eq(S.CSV_HEADERS.length, 18, 'CSV 仍是 18 列');
    eq(S.CSV_HEADERS[16], '抓取后续字段', 'CSV 第 17 列表头未动');
    eq(S.CSV_HEADERS[9], '重要', 'CSV 第 10 列表头未动');
    eq(FM.FORM_SECTIONS.map((s) => s.id).join('/'), 'basic/combo/fetch/imp', '分区清单未动');
    eq(FM.FORM_SECTIONS.map((s) => s.title).join('/'), '基本信息/单元格组合/抓取后续字段/重要笔记', '四个模块标题逐字未动');
    eq(FM.GROUP_FIELDS.find((f) => f.key === 'important').label, '重要', '分组弹窗的「重要」是另一张表，不许被连带改');
    /* 新键不进 CSV 导出，也不出现在 csvColumns() 里 */
    const used = FM.csvColumns().filter(Boolean).map((f) => f.key);
    falsy(used.indexOf('fetchEnabled') >= 0, 'fetchEnabled 不该占任何 CSV 列');
  });
};
