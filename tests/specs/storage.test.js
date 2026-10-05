/* tests/specs/storage.test.js — 字段单源 / CSV 18 列 / 判重 / 导入导出块 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

module.exports = async function run() {
  // chrome.storage 垫片与内核实例由 bootstrap 统一在**首次**加载时安装；
  // 这里只能拿同一个实例（再装一遍 chrome 是无效的：内核早已捕获了旧引用）。
  const { KH, mem } = require('../bootstrap');
  const S = KH.Store;

  suite('storage · 字段单源与抓取字段归一化');

  await test('★ CSV 列定义唯一，且末列为「组合方向」', () => {
    eq(S.CSV_HEADERS.length, 18, '应为 18 列');
    eq(S.CSV_HEADERS[17], '组合方向');
    eq(S.CSV_HEADERS[0], '关键词');
  });

  await test('★ 表头不得再出现名实不符的"核心…"列（值一直是标题词规则）', () => {
    const joined = S.CSV_HEADERS.join(',');
    falsy(/核心匹配方式/.test(joined), '旧表头名已校正');
    truthy(/标题词匹配方式/.test(joined));
    truthy(/标题词区分大小写/.test(joined));
    truthy(/标题词使用正则/.test(joined));
    truthy(/核心词区分大小写/.test(joined), '核心词三项的列名应说明是"核心词"');
  });

  await test('★ fetchLabels 多分隔符归一化为 | （附录A §7 清洗要求）', () => {
    const k = S.sanitizeKeyword({ text: 'x', fetchLabels: ' 甲 ，乙｜丙, 丁 |  ' }, {});
    eq(k.fetchLabels, '甲|乙|丙|丁');
  });

  await test('★ `@表达式` 里的逗号**不是**字段分隔符（`应用截图@1,3` 不得被拆成两个字段）', () => {
    /* 值格指向与 cellOffset 同语法（`1,3` / `1-3,5`）。若这里按逗号切，
     * 保存后配置就变成 `应用截图@1|3` —— 用户看到的字段凭空多一个、表达式也废了。 */
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '应用截图@1,3' }, {}).fetchLabels, '应用截图@1,3');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '截图@1-3,5|名称' }, {}).fetchLabels, '截图@1-3,5|名称');
    /* 没写 `@` 时逗号照旧是分隔符（旧行为不变） */
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '甲,乙' }, {}).fetchLabels, '甲|乙');
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '应用截图@2,乙' }, {}).fetchLabels, '应用截图@2|乙',
      '`乙` 不是表达式片段，逗号仍是分隔符');
  });

  await test('★ imgOcrKeyword 进白名单：保存链路不得清洗掉它；取消勾选也不清空文本', () => {
    const on = S.sanitizeKeyword({ text: 'x', fetchLabels: '应用截图', imgOcr: true, imgOcrKeyword: ' 一对一 ' }, {});
    eq(on.imgOcrKeyword, '一对一', '去首尾空白后原样保留');
    truthy(on.imgOcr);
    /* 用户口径：取消勾选「识别图片文字」时**保留**已填的关键词（不静默丢数据） */
    const off = S.sanitizeKeyword({ text: 'x', fetchLabels: '应用截图', imgOcr: false, imgOcrKeyword: '一对一' }, {});
    eq(off.imgOcr, false);
    eq(off.imgOcrKeyword, '一对一', '取消勾选不得清空关键词文本');
  });

  suite('config · 图片识别前置条件（normalize 兜底 + 保存拦截）');

  await test('★ fetchLabels 为空 → normalize 把 imgOcr 强制置 false，且**保留** imgOcrKeyword', () => {
    const { config } = KH.Config.normalize({
      keywords: [{ id: 'a', text: '交友', imgOcr: true, imgOcrKeyword: '一对一', fetchLabels: '' }]
    });
    eq(config.keywords[0].imgOcr, false, '没配抓取字段 → 图片识别开关必须被关掉');
    eq(config.keywords[0].imgOcrKeyword, '一对一', '文本保留（用户重新勾选时不必重填）');
  });

  await test('★ 勾选但「图片命中关键词」为空 → normalize 把 imgOcr 置 false（保留空文本）', () => {
    const { config } = KH.Config.normalize({
      keywords: [{ id: 'b', text: '交友', imgOcr: true, imgOcrKeyword: '   ', fetchLabels: '应用截图' }]
    });
    eq(config.keywords[0].imgOcr, false, '没有匹配口径就不该处于勾选状态');
    eq(config.keywords[0].imgOcrKeyword, '   ');
  });

  await test('前置条件都满足 → imgOcr 保持勾选（normalize 不误伤）', () => {
    const { config } = KH.Config.normalize({
      keywords: [{ id: 'c', text: '交友', imgOcr: true, imgOcrKeyword: '一对一', fetchLabels: '应用截图' }]
    });
    truthy(config.keywords[0].imgOcr);
  });

  await test('★ 保存拦截（keyword-editor 的 ocrGate）：勾了识别却缺抓取字段 / 缺关键词都要拦住并说清', () => {
    const gate = KH.ui && KH.ui.KeywordEditor && KH.ui.KeywordEditor.ocrGate;
    truthy(typeof gate === 'function', '保存校验必须是可单测的纯判据（ui.KeywordEditor.ocrGate）');
    truthy(gate({ imgOcr: true, fetchLabels: '', imgOcrKeyword: '一对一' }).indexOf('抓取后续字段') >= 0,
      '缺抓取字段必须被拦住并指出原因');
    truthy(gate({ imgOcr: true, fetchLabels: '应用截图', imgOcrKeyword: '' }).indexOf('图片命中关键词') >= 0,
      '缺图片命中关键词必须被拦住并指出原因');
    eq(gate({ imgOcr: true, fetchLabels: '应用截图', imgOcrKeyword: '一对一' }), '', '都填了就该放行');
    eq(gate({ imgOcr: false, fetchLabels: '', imgOcrKeyword: '' }), '', '没勾选识别就不校验（取消勾选不能报错）');
  });

  await test('★ 字段表里的 imgOcrKeyword 必须在 fieldmap 里有声明（单源）', () => {
    const f = KH.FieldMap.byKey('imgOcrKeyword');
    truthy(f, 'fieldmap 必须声明 imgOcrKeyword');
    /* K70：图片识别三控件整体搬到「抓取后续字段」模块（用户实测要求），
     * 所以断言的分区从 combo 改为 fetch —— 字段名/存储键/联动口径一律未动。 */
    eq(f.sec, 'fetch', '与「抓取后续字段」同一个分区（K70 起搬家到这里）');
    const rt = KH.FieldMap.roundTrip({ text: 'x', imgOcrKeyword: '一对一' }, KH.Config.defaults);
    truthy(rt.ok, '表单 ⇄ 存储 往返必须一致：' + rt.diffs.join('、'));
  });

  /* ==========================================================================
   * K70 · 编辑弹窗布局（用户实测：①「启用组合」「重要」两颗胶囊与「基本信息」那颗一样
   *        放到**各自模块右上角**、文案统一成「启用」；② 图片识别三控件归入「抓取后续字段」模块）
   *
   * 为什么在这里、以这种方式判：弹窗**不自己声明字段**，它遍历 `KEYWORD_FIELDS` 渲染
   *   · `sec`  → 落到哪个模块（是"最近模块标题"）
   *   · `head` → 挂到分区**标题行右侧插槽**（是"模块右上角"的唯一实现）
   * 所以"挂载模块 / 是否在右上角 / 显示文案"这三件事的真源就是这份清单：
   * 在这里做结构化判定，任何"改回原样"都会当场变红；真浏览器 DOM 断言另见 `_e2e/ui.test.js`
   * 组「10. options · 编辑弹窗与保存往返」。
   * ======================================================================= */
  suite('fieldmap · K70 胶囊统一「启用」挂模块右上角 + 图片识别控件归「抓取后续字段」');

  await test('★ 四颗开关胶囊都在**各自分区**且声明为 head（＝渲染到模块标题行右侧）', () => {
    const FM = KH.FieldMap;
    const want = [
      { key: 'enabled', sec: 'basic', who: '基本信息（参照物：位置与文案本来就是这样）' },
      { key: 'cellVerifyEnabled', sec: 'combo', who: '单元格组合' },
      { key: 'fetchEnabled', sec: 'fetch', who: '抓取后续字段（K71 新增的第 4 颗）' },
      { key: 'important', sec: 'imp', who: '重要笔记' }
    ];
    for (const w of want) {
      const f = FM.byKey(w.key);
      truthy(f, '字段表必须有 ' + w.key);
      eq(f.sec, w.sec, w.key + ' 应归属「' + w.who + '」分区');
      eq(f.label, '启用', w.key + ' 的显示文案必须统一为「启用」（K70/K71 用户口径），实际 ' + JSON.stringify(f.label));
      truthy(f.chip === true, w.key + ' 必须是胶囊形态（四颗同形态）');
      eq(f.head, true, w.key + ' 必须 `head: true` —— 这是"渲染到模块标题行右侧插槽"的唯一实现');
      // 反向：同一分区里不得再有"不挂标题行"的同名字段（否则会出现左侧胶囊 + 右上角胶囊两颗）
      falsy(FM.fieldsOf(w.sec).some(x => x.key === w.key && !x.head),
        w.key + ' 不该同时留在分区正文里（那会变成两颗胶囊）');
    }
  });

  await test('★ 图片识别三控件归「抓取后续字段」，且声明顺序在「抓取后续字段」输入框之后', () => {
    const FM = KH.FieldMap;
    const list = FM.fieldsOf('fetch').map(f => f.key);      // 声明顺序 = 弹窗渲染顺序
    truthy(list.indexOf('fetchLabels') >= 0, 'fetch 分区应有抓取字段输入框，实际 ' + JSON.stringify(list));
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      const f = FM.byKey(k);
      truthy(f, '字段表必须有 ' + k);
      eq(f.sec, 'fetch', k + ' 必须挂「抓取后续字段」分区（K70 起从 combo 搬来）');
      truthy(list.indexOf(k) > list.indexOf('fetchLabels'),
        k + ' 的声明顺序必须在 fetchLabels **之后**（弹窗里就是"在它下方"），实际 ' + JSON.stringify(list));
    }
  });

  await test('★ 反向护栏：combo 里不再有图片识别控件；字段名/存储键/CSV 列序/分组弹窗文案一律未动', () => {
    const FM = KH.FieldMap;
    const comboKeys = FM.fieldsOf('combo').map(f => f.key);
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      falsy(comboKeys.indexOf(k) >= 0, '「单元格组合」里不该再有 ' + k + '，实际 ' + JSON.stringify(comboKeys));
    }
    // 分区本身没变（只改了挂载归属，没新增/删除模块）
    eq(FM.FORM_SECTIONS.map(s => s.id).join('/'), 'basic/combo/fetch/imp', '分区清单不该变');
    // 只改"显示文案 + 挂载位置"：这些标识与契约必须逐字不动
    eq(FM.byKey('cellVerifyEnabled').csv, 12, '存储键与 CSV 列序都不许动');
    eq(FM.byKey('important').csv, 10, '存储键与 CSV 列序都不许动');
    const hdr = S.CSV_HEADERS;
    eq(hdr[3], '启用', 'CSV 第 4 列（关键词自身的启用开关）表头未动');
    eq(hdr[9], '重要', '★ CSV 第 10 列表头仍是「重要」—— 改的只是**弹窗胶囊显示文案**，不是 CSV 契约');
    eq(hdr[11], '单元格组合', 'CSV 第 12 列表头未动');
    // 分组编辑弹窗的「重要」胶囊是**另一张字段表**，不在本次口径内（不许被一起改掉）
    eq(KH.FieldMap.GROUP_FIELDS.find(f => f.key === 'important').label, '重要',
      '分组弹窗的「重要」不属于"三个模块"，口径未变');
  });

  await test('★ 字段表里的每个键都必须能原样过 sanitizeKeyword（新增字段别只改一处）', () => {
    /* 实测缺陷（1.99.99.23 用户反馈）：`ui/fieldmap.js` 加了 `imgOcr`，但 `storage.newKeyword()`
     * 是**手写字段白名单**、漏了它 → 保存时被清洗掉 → 重新打开编辑弹窗显示"没勾选"。
     * 这条用例遍历**字段表**（而不是手写清单）来自动覆盖"以后新加的字段"，从根上堵住这类漏。 */
    const FM = KH.FieldMap;
    const full = FM.defaults(KH.Config.defaults);
    for (const f of FM.KEYWORD_FIELDS) {                 // 每个字段都塞一个"非默认、且能过 coerce"的值
      if (f.type === 'bool') full[f.key] = true;
      else if (f.type === 'int') full[f.key] = 3;
      else if (f.type === 'select') full[f.key] = (f.options && f.options.length) ? f.options[f.options.length - 1].v : full[f.key];
      else full[f.key] = '覆盖值';
    }
    full.text = '华为';
    full.cellVerifyEnabled = true;
    full.cellVerify = '供应商';                          // 组合词前提（否则 cellVerify* 会被按语义清掉）

    const k = KH.Store.sanitizeKeyword(full, KH.Config.defaults);
    const bad = [];
    for (const f of FM.KEYWORD_FIELDS) {
      if (!(f.key in k)) { bad.push(f.key + '（整个键被清洗掉了）'); continue; }
      const want = FM.coerce(f, full[f.key]);
      if (k[f.key] !== want) bad.push(f.key + ' 值被改：' + JSON.stringify(k[f.key]) + ' ≠ ' + JSON.stringify(want));
    }
    eq(bad.length, 0, '保存链路会丢/改这些字段：' + bad.join('、'));
  });

  await test('fetchLabels 为空/空白 → 空串', () => {
    eq(S.sanitizeKeyword({ text: 'x', fetchLabels: '   ' }, {}).fetchLabels, '');
    eq(S.sanitizeKeyword({ text: 'x' }, {}).fetchLabels, '');
  });

  await test('sanitizeKeyword 不改语义：颜色留空＝继承，不填默认色', () => {
    const k = S.sanitizeKeyword({ text: 'x' }, { highlightStyle: { defaultBgColor: '#ff9500' } });
    eq(k.bgColor, '', '必须留空才会回退到 分组色 > 全局默认色');
    eq(k.textColor, '');
  });

  await test('匹配三开关的初值来自 matchSettings（不是字面量）', () => {
    const cfg = { matchSettings: { defaultCaseSensitive: true, defaultWholeWord: true, defaultUseRegex: true } };
    const k = S.sanitizeKeyword({ text: 'x' }, cfg);
    truthy(k.caseSensitive); truthy(k.wholeWord); truthy(k.useRegex);
  });

  await test('hjz# → kind=rare；改回普通文本则不带 kind', () => {
    eq(S.sanitizeKeyword({ text: 'hjz#' }, {}).kind, 'rare');
    eq(S.sanitizeKeyword({ text: '普通' }, {}).kind, undefined);
  });

  await test('仅抓取判定：有标题 + 无核心 + 有抓取字段', () => {
    const k = S.sanitizeKeyword({ text: '', cellVerifyEnabled: true, cellVerify: '应用名称', fetchLabels: '包名' }, {});
    truthy(k.fetchOnly);
    const k2 = S.sanitizeKeyword({ text: '有核心', cellVerifyEnabled: true, cellVerify: '标题', fetchLabels: '包名' }, {});
    eq(k2.fetchOnly, undefined, '有核心词就不是仅抓取');
  });

  await test('未勾选组合 → 标题相关字段被清干净（不留半截状态）', () => {
    const k = S.sanitizeKeyword({ text: 'x', cellVerifyEnabled: false, cellVerify: '残留' }, {});
    eq(k.cellVerifyEnabled, false);
  });

  suite('storage · 判重键（text + 标题词 + 方向）');

  await test('★ 组合方向参与判重：同名同标题、仅方向不同 → 算是两条', () => {
    const a = { text: '否', cellVerify: '是否刚需', comboAxis: 'lr' };
    const b = { text: '否', cellVerify: '是否刚需', comboAxis: 'tb' };
    truthy(S.keyOf(a) !== S.keyOf(b), '方向必须进判重键');
    falsy(S.findDup([a], b), '不同方向不应判重');
  });

  await test('同 text + 同标题 + 同方向 → 判重命中', () => {
    const a = { text: '否', cellVerify: '是否刚需', comboAxis: 'lr' };
    truthy(S.findDup([a], Object.assign({}, a)));
  });

  await test('普通词：只有 text，标题为空', () => {
    const a = { text: '补丁' };
    truthy(S.findDup([a], { text: '补丁' }));
    falsy(S.findDup([a], { text: '补丁2' }));
  });

  suite('storage · CSV 往返（含 18 列与旧 17 列兼容）');

  let csvSeq = 0;
  /** 换行用 fromCharCode(10) 构造：避免测试源码里出现字面量 \n 转义序列被误读 */
  const LF = String.fromCharCode(10);
  /** 每个 CSV 用例独立的临时配置（不共享对象，避免用例间顺序耦合） */
  function csvCfg() {
    csvSeq++;
    return {
      keywords: [{
        id: 'k' + csvSeq, text: '审核不通过' + csvSeq, note: '多行' + LF + '备注', groupId: null, enabled: true,
        caseSensitive: true, wholeWord: false, useRegex: false, bgColor: '#ff0000', textColor: '',
        important: true, importantNote: '**重要**', cellVerifyEnabled: true, cellVerify: '状态',
        cellVerifyMatchMode: 'exact', cellVerifyCaseSensitive: true, cellVerifyUseRegex: false,
        fetchLabels: '驳回原因|运营备注', comboAxis: 'tb'
      }],
      groups: []
    };
  }
  /** 用真正的 CSV 解析器读列数（备注里有换行，裸 split(',') 会切错） */
  function colCount(line) { return S.parseCSVLine(line).length; }

  await test('★ 导出→导入往返：comboAxis=tb 不得静默变成 lr（v2 早前的无损性缺陷）', async () => {
    const cfg = csvCfg();
    const csv = S.exportCSV(cfg);
    // 必须用 CSV 解析器读记录：备注里有换行（被引号包住），裸 split(LF) 会切错
    const recs = S.parseCSV(csv);
    eq(recs.length, 2, '1 行表头 + 1 行数据');
    eq(recs[0].length, 18, '表头 18 列');
    eq(recs[1].length, 18, '数据 18 列');
    eq(recs[1][17], 'tb', '第 18 列是组合方向');

    mem.keywords = []; mem.groups = [];
    const st = await S.importCSV(csv, { keywords: [], groups: [] });
    eq(st.added, 1);
    eq(mem.keywords[0].comboAxis, 'tb', '导入后方向必须还是 tb');
    eq(mem.keywords[0].note, '多行' + LF + '备注', '引号内的换行必须还原');
    eq(mem.keywords[0].fetchLabels, '驳回原因|运营备注');
  });

  await test('★ 旧版 17 列 CSV 仍可导入（缺「组合方向」列 → 默认 lr）', async () => {
    const legacy = [
      '关键词,备注,分组,启用,区分大小写,全词匹配,正则表达式,背景色,文字颜色,重要,重要笔记,单元格组合,标题关键词(左格),核心匹配方式,核心区分大小写,核心使用正则,抓取后续字段',
      '旧词,备注,,是,否,否,否,,,,否,,否,,否,否,'
    ].join('\n');
    mem.keywords = [];
    mem.groups = [];
    const st = await S.importCSV(legacy, { keywords: [], groups: [] });
    eq(st.added, 1);
    eq(mem.keywords[0].comboAxis, 'lr');
    eq(mem.keywords[0].text, '旧词');
  });

  await test('列数既不是 17 也不是 18 → 明确报错（不静默错位）', async () => {
    mem.keywords = []; mem.groups = [];
    let threw = false;
    try { await S.importCSV('a,b,c\n1,2,3', { keywords: [], groups: [] }); } catch (e) { threw = true; }
    truthy(threw, '列数不符必须抛错，否则字段会整体错位');
  });

  await test('CSV 含引号内的逗号与换行 → 引号感知解析（不得凭空多出一条）', async () => {
    const csv = S.exportCSV(csvCfg());
    mem.keywords = []; mem.groups = [];
    await S.importCSV(csv, { keywords: [], groups: [] });
    eq(mem.keywords.length, 1, '一条关键词导出再导入必须还是一条');
    truthy(mem.keywords[0].note.indexOf(LF) >= 0, '引号内换行必须保留：' + JSON.stringify(mem.keywords[0].note));
  });

  await test('CSV 按分组名回建 groupId', async () => {
    const csv = '关键词,备注,分组,启用,核心词区分大小写,核心词全词匹配,核心词正则,背景色,文字颜色,重要,重要笔记,单元格组合,标题关键词(左格),标题词匹配方式,标题词区分大小写,标题词使用正则,抓取后续字段,组合方向\n' +
      '甲,,,,,,,,,,,,,,,,lr\n';
    mem.keywords = []; mem.groups = [];
    const st = await S.importCSV(csv, { keywords: [], groups: [] });
    eq(st.added, 1);
  });

  suite('storage · JSON 导出块');

  await test('★ 完整导出才带全局开关；部分导出不带（避免带偏对方本机开关）', () => {
    const cfg = { keywords: [], groups: [], siteRules: [], siteDisabledMap: {}, globalEnabled: false,
      shadowDOMEnabled: false, suspendInactiveTab: false, highlightStyle: {}, noteCardStyle: {}, matchSettings: {} };
    const full = JSON.parse(S.exportJSON(null, cfg));
    eq(full.globalEnabled, false);
    eq(full.shadowDOMEnabled, false, '完整备份应带全局开关');
    const partial = JSON.parse(S.exportJSON({ keywords: true, siteRules: false, siteDisabled: false, styles: false }, cfg));
    eq(partial.globalEnabled, undefined, '部分导出绝不能带 globalEnabled');
    eq(partial.shadowDOMEnabled, undefined, '部分导出绝不能带 shadowDOMEnabled');
  });

  await test('★ shadowDOMEnabled 不再被塞进 styles 块（否则部分导出会泄漏本机开关）', () => {
    falsy(S.STYLE_KEYS.indexOf('shadowDOMEnabled') >= 0);
    falsy(S.STYLE_KEYS.indexOf('suspendInactiveTab') >= 0);
    truthy(S.GLOBAL_KEYS.indexOf('shadowDOMEnabled') >= 0);
    const partial = JSON.parse(S.exportJSON({ keywords: false, siteRules: false, siteDisabled: false, styles: true },
      { highlightStyle: {}, shadowDOMEnabled: false }));
    eq((partial.styles || {}).shadowDOMEnabled, undefined);
  });

  /* 命中统计功能已于 1.99.99.19 整体移除，但**存量存储里可能残留旧的 `stats` 键**
   * （config.merge 对未知键宽容保留）——导出必须仍然不含它，否则用户备份会带上一个
   * 已废弃的统计桶。这条从"统计不外泄"改成"残留键不外泄"。 */
  await test('★ 导出不含已移除的 stats 残留键', () => {
    const out = JSON.parse(S.exportJSON(null, { keywords: [], groups: [], siteRules: [], siteDisabledMap: {}, stats: { keywordHits: { a: 1 } } }));
    eq(out.stats, undefined);
  });

  /* K58：新增配置项时最容易漏的就是这两张**手写清单**（STYLE_KEYS / GLOBAL_KEYS）——
   * 1.99.99.24 的关键词字段就是被同类手写清单吞掉的。这条把"漏加"变成红灯。 */
  await test('★ 每个配置项都必须被导出清单覆盖到，或明确属于"不随导出走"', () => {
    /* 这四块走各自的区块（keywords / siteRules / siteDisabledMap），不重复列在 styles 里；
     * imgOcr 含跨域站点授权（本机性质）；pageFingerprintIntervalMs 是内部兜底参数。 */
    const EXPLICIT_SKIP = ['keywords', 'groups', 'siteRules', 'siteDisabledMap', 'imgOcr', 'pageFingerprintIntervalMs'];
    const listed = S.STYLE_KEYS.concat(S.GLOBAL_KEYS).concat(EXPLICIT_SKIP);
    const missing = Object.keys(KH.Config.defaults).filter((k) => listed.indexOf(k) < 0);
    deepEq(missing, [], '这些配置项既不在 STYLE_KEYS / GLOBAL_KEYS，也不在"明确不导出"清单里 —— 新加的配置项别只改一处（决定它跟不跟导出走，然后登记到相应的清单）');
  });

  await test('★ 「变更处理方式」跟导出走（换台机器/恢复备份后仍是用户选的那一档）', () => {
    truthy(S.STYLE_KEYS.indexOf('changeHandling') >= 0, '应该登记在 STYLE_KEYS 里');
    const out = JSON.parse(S.exportJSON({ keywords: false, siteRules: false, siteDisabled: false, styles: true },
      { changeHandling: 'always' }));
    eq((out.styles || {}).changeHandling, 'always', '部分导出（含样式/配置）也必须带上它');
  });

  await test('meta.scope 反映实际导出块', () => {
    const out = JSON.parse(S.exportJSON({ keywords: true, siteRules: false, siteDisabled: false, styles: false }, {}));
    eq(out.meta.scope.keywords, true);
    eq(out.meta.scope.siteRules, false);
  });

  suite('storage · 兼容读取（存量旧格式）');

  await test('旧版平铺的 highlightStyle 能被 stylesFrom 读到', () => {
    const s = S.stylesFrom({ highlightStyle: { defaultBgColor: '#123456' } });
    eq(s.highlightStyle.defaultBgColor, '#123456');
  });

  await test('新格式 styles 块优先', () => {
    const s = S.stylesFrom({ styles: { matchSettings: { defaultWholeWord: true } }, matchSettings: { defaultWholeWord: false } });
    truthy(s.matchSettings.defaultWholeWord, 'styles 块应优先于根上的同名键');
  });
test('CSV 导出：BOM + CRLF（Excel 友好）', () => {
  const csv = KH.Store.exportCSV({ groups: [], keywords: [{ id: 'k', text: 'A', note: '' }] });
  eq(csv.charCodeAt(0), 0xFEFF, '应以 UTF-8 BOM 开头（否则 Excel 中文乱码）');
  truthy(csv.indexOf('\r\n') > 0, '应用 CRLF 行尾');
});

test('Excel 表格导出：含表头与表格，颜色列按真实颜色上色', () => {
  const xls = KH.Store.exportExcelTable({ groups: [], keywords: [{ id: 'k', text: 'A', bgColor: '#ff9500', textColor: '#ffffff' }] });
  truthy(xls.indexOf('<table>') > 0, '应是一份可被 Excel 识别的 HTML 表格');
  truthy(xls.indexOf('<th>') > 0, '应有表头行');
  truthy(xls.indexOf('background:#ff9500') > 0, '底色列应按真实颜色上色');
  truthy(xls.indexOf('color:#ffffff') > 0, '文字色列应按真实颜色上色');
});

test('CSV 导入：容忍 Excel 另存时插入的 sep=, 首行', async () => {
  const csv = KH.Store.exportCSV({ groups: [], keywords: [{ id: 'k', text: 'A' }] });
  const withSep = 'sep=,\r\n' + csv.replace(/^\uFEFF/, '');
  const r = await KH.Store.importCSV(withSep, { keywords: [], groups: [] });
  eq(r.added, 1, '带 sep= 行的文件也应能正常导入');
});

/* ============================================================================
 * 写路径权威 = 磁盘（C7 P0 回归）
 * ----------------------------------------------------------------------------
 * 缺陷原状：`upsertKeyword(kw, cfg)` 写的是 `cfg || await this.load()`。
 *   ① 页面内编辑器在「全局暂停 / 本站禁用 / 无规则」的文档里拿不到配置时传 `{}`，
 *      而 `{}` 是真值 ⇒ 短路不触发 ⇒ 空表整表写回 ⇒ 词库只剩刚加的那一个词；
 *   ② 独立窗口开窗时读的快照之后过期 ⇒ 别处刚加的词被吃掉（last-write-wins）。
 * 现在：磁盘是唯一权威，`cfg` 退为「读盘失败时的兜底」，两者都拿不到就拒写。
 * ========================================================================= */

suite('storage · 写路径以磁盘为准（P0 回归：空/陈旧快照不得覆盖词库）');

/** 用一份干净的内存存储跑一段，跑完原样还原（免得污染同进程的其他 spec） */
async function withMem(seed, fn) {
  const saved = JSON.parse(JSON.stringify(mem));
  try {
    for (const k of Object.keys(mem)) delete mem[k];
    Object.assign(mem, JSON.parse(JSON.stringify(seed)));
    await fn();
  } finally {
    for (const k of Object.keys(mem)) delete mem[k];
    Object.assign(mem, saved);
  }
}

await test('★ 空快照 `{}` 保存：既有词与分组一个都不许丢', async () => {
  await withMem({
    globalEnabled: true,
    keywords: [{ id: 'a', text: '阿尔法词' }, { id: 'b', text: '贝塔词' }, { id: 'c', text: '伽马词' }],
    groups: [{ id: 'g1', name: '分组一' }]
  }, async () => {
    await S.upsertKeyword({ text: '暂停期新增词' }, {});
    const back = await S.load();
    eq(back.keywords.length, 4, '3 个旧词 + 1 个新词');
    deepEq(back.keywords.map(k => k.text).sort(), ['阿尔法词', '贝塔词', '伽马词', '暂停期新增词'].sort(),
      '旧词必须原样还在');
    eq(back.groups.length, 1, '分组不得被牵连（upsertKeyword 只写 keywords 键，分组在别的键上）');
  });
});

await test('★ 陈旧快照保存：别处刚加的词不得被吃掉（last-write-wins）', async () => {
  await withMem({
    globalEnabled: true,
    keywords: [{ id: 'a', text: '甲词' }, { id: 'b', text: '乙词' }]
  }, async () => {
    const stale = await S.load();                       // 开窗那一刻的快照
    await S.patch({ keywords: stale.keywords.concat([{ id: 'x', text: '别处加的' }]) });
    await S.upsertKeyword({ text: '窗口里加的' }, stale); // 拿陈旧快照写
    const back = await S.load();
    deepEq(back.keywords.map(k => k.text).sort(), ['别处加的', '窗口里加的', '甲词', '乙词'].sort());
  });
});

await test('★ 读盘失败：有兜底快照就照它写；连快照都没有 ⇒ 抛错拒写（绝不清库）', async () => {
  await withMem({
    globalEnabled: true,
    keywords: [{ id: 'a', text: '甲词' }, { id: 'b', text: '乙词' }]
  }, async () => {
    const realLoad = KH.Config.load;
    const snapshot = { keywords: [{ id: 'a', text: '甲词' }, { id: 'b', text: '乙词' }] };
    try {
      KH.Config.load = () => Promise.reject(new Error('模拟读盘失败'));
      await S.upsertKeyword({ text: '兜底写的' }, snapshot);
      deepEq((mem.keywords || []).map(k => k.text).sort(), ['乙词', '兜底写的', '甲词'].sort(),
        '读盘失败时按调用方快照写（快照里的词一个不丢）');
      /* 连快照都没有：必须抛错，且磁盘原样不动 */
      let threw = null;
      try { await S.upsertKeyword({ text: '不该写进去的' }, {}); } catch (err) { threw = err; }
      truthy(threw, '读盘失败 + 无兜底快照 ⇒ 必须抛错');
    } finally {
      KH.Config.load = realLoad;
    }
    const back = await S.load();
    truthy(back.keywords.some(k => k.text === '甲词'), '磁盘上的旧词仍在');
    falsy(back.keywords.some(k => k.text === '不该写进去的'), '拒写的那次不得落盘');
  });
});
};
