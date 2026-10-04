/* tests/specs/k72-upgrade-compat.test.js — K72「升级兼容与文案收口」的回归网
 * ----------------------------------------------------------------------------
 * 盯四类**会静默出错**的地方（都能被机械判定）：
 *   A1 导入丢「仅抓取」词（**唯一会丢数据**的路径，新旧两条导入路径都要放行）
 *   B5 导出即规范形状（旧键/派生键不再写进文件；时间戳不凭空生成；模块关着时已填的值不许清空）
 *   B6 `stripDeprecated` 必须真的删掉 `head.tail`（否则导入旧备份会把废弃键写回存储）
 *   B9 `cellVerifyAxis` 单一化（判重 / CSV 第 18 列 / 保存归一 / 编译四处同一个判据）
 * 另加 A2/A3/B8 的**文案断言**（面向用户的旧串消失、新串存在）—— 文案本身就是本轮交付物。
 *
 * 反向验证（契约 §六）的目标用例就在这个文件里：
 *   ① 改回 A1 判据 → 《仅抓取词往返（JSON）》《仅抓取词往返（CSV）》红
 *   ② `exportJSON` 改回 `cfg.keywords || []` → 《导出即规范形状》红
 *   ③ `stripDeprecated` 改回 `continue` → 《导入旧备份不得把废弃键写回》红
 *   ④ `keyOf`/`rowValues` 改回只读 `comboAxis` → 《cellVerifyAxis 单一化》红
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH, mem } = require('../bootstrap');
  const S = KH.Store;
  const FM = KH.FieldMap;
  const CFG = KH.Config.defaults;

  /** 「仅抓取」词的标准形状（无核心词、有标题词 + 抓取字段 + 重要） */
  const fetchOnlyKw = () => ({
    text: '', cellVerifyEnabled: true, cellVerify: '应用名称',
    fetchLabels: '包名', important: true
  });

  /* ================================================================ A1 */

  suite('K72 · A1 导入不再丢「仅抓取」词（唯一会丢数据的路径）');

  await test('★ 仅抓取词往返（JSON）：exportJSON → importJSON(overwrite) 后仍在且字段一致', async () => {
    const savedKw = mem.keywords; const savedG = mem.groups;
    savedKw; savedG;
    mem.keywords = []; mem.groups = [];
    try {
      const kw = S.sanitizeKeyword(fetchOnlyKw(), CFG);
      eq(kw.fetchOnly, true, '前置：这条词应被识别成"仅抓取"');
      const json = S.exportJSON(null, { keywords: [kw], groups: [] });
      truthy(json.indexOf('应用名称') > 0, '导出文件里应有它的标题词');

      await S.importJSON(json, { mode: 'overwrite' }, { keywords: [], groups: [] });
      const back = await S.load();
      const k = (back.keywords || []).find(x => x.cellVerify === '应用名称');
      truthy(k, '★ 仅抓取词导入后必须**还在**（旧实现被 .filter(k => k.text) 丢掉）');
      eq(k.text, '', '核心词仍是空');
      eq(k.cellVerifyEnabled, true, '「单元格组合」仍在');
      eq(k.cellVerify, '应用名称', '标题词逐步保真');
      eq(k.fetchLabels, '包名', '抓取字段保真');
      eq(k.fetchOnly, true, '仍是仅抓取');
      eq(k.important, true, '「重要」保真');
    } finally { mem.keywords = savedKw; mem.groups = savedG; }
  });

  await test('★ 仅抓取词往返（CSV）：首列为空的合法行必须被导入', async () => {
    const savedKw = mem.keywords; const savedG = mem.groups;
    mem.keywords = []; mem.groups = [];
    try {
      const kw = S.sanitizeKeyword(fetchOnlyKw(), CFG);
      const csv = S.exportCSV({ keywords: [kw], groups: [] });
      const recs = S.parseCSV(csv);
      eq(recs.length, 2, '1 行表头 + 1 行数据');
      eq(recs[1][0], '', '前置：仅抓取词的第 1 列（核心词）本来就是空的');
      eq(recs[1][11], '是', '第 12 列＝单元格组合');
      eq(recs[1][12], '应用名称', '第 13 列＝标题关键词(左格)');

      await S.importCSV(csv, { keywords: [], groups: [] });
      const back = await S.load();
      const k = (back.keywords || []).find(x => x.cellVerify === '应用名称');
      truthy(k, '★ 首列为空的仅抓取行必须被导入（旧实现"首列为空即跳过"会丢词）');
      eq(k.fetchLabels, '包名', '抓取字段保真');
      eq(k.fetchOnly, true, '仍是仅抓取');
    } finally { mem.keywords = savedKw; mem.groups = savedG; }
  });

  await test('★ A1 对照臂：普通词 / 组合词的 JSON 与 CSV 往返结果不变', async () => {
    const savedKw = mem.keywords; const savedG = mem.groups;
    mem.keywords = []; mem.groups = [];
    try {
      const plain = S.sanitizeKeyword({ text: '普通词', fetchLabels: '备注' }, CFG);
      const combo = S.sanitizeKeyword({ text: '核心', cellVerifyEnabled: true, cellVerify: '标题', fetchLabels: '' }, CFG);
      const json = S.exportJSON(null, { keywords: [plain, combo], groups: [] });
      await S.importJSON(json, { mode: 'overwrite' }, { keywords: [], groups: [] });
      let back = await S.load();
      eq((back.keywords || []).length, 2, '两条都应还在');
      eq((back.keywords || []).find(k => k.text === '普通词').fetchLabels, '备注');
      eq((back.keywords || []).find(k => k.text === '核心').cellVerifyEnabled, true);

      mem.keywords = []; mem.groups = [];
      const csv = S.exportCSV({ keywords: [plain, combo], groups: [] });
      await S.importCSV(csv, { keywords: [], groups: [] });
      back = await S.load();
      eq((back.keywords || []).length, 2, 'CSV 往返两条都应还在');
    } finally { mem.keywords = savedKw; mem.groups = savedG; }
  });

  /* ================================================================ B5 */

  suite('K72 · B5 导出即规范形状（JSON + CSV 同一份归一）');

  /** 一份**旧形态**词：缺 enabled/匹配三开关/groupId/fetchEnabled；带旧键与派生键 */
  const oldShapeKw = () => ({
    id: 'old1', createdAt: 111, updatedAt: 222,
    text: '旧形态',
    impNoteBg: '', _flipped: true, cellVerifyAxis: 'tb',
    fetchLabels: '甲,乙',
    cellVerifyEnabled: false, cellVerify: '标题', cellVerifyMatchMode: 'exact',
    cellOffset: '2', importantNote: '笔记', imgSize: 66, impNoteUseHlColor: true,
    imgOcr: true, imgOcrKeyword: '一对一', imgOcrMax: 3
  });

  await test('★ 导出即规范形状：键集＝newKeyword 的键集；旧键/派生键消失；值逐字保留；时间戳原样', () => {
    const cfg = { keywords: [], groups: [], matchSettings: {} };
    const out = JSON.parse(S.exportJSON(null, { keywords: [oldShapeKw()], groups: [] }));
    const k = out.keywords[0];
    truthy(k, '导出文件里应有这条词');

    // ① 键集逐字等于规范构造器的键集（有 kind/fetchOnly 时并上这两个）
    const base = Object.keys(S.newKeyword({}, cfg)).slice();
    if (k.kind !== undefined) base.push('kind');
    if (k.fetchOnly !== undefined) base.push('fetchOnly');
    deepEq(Object.keys(k).slice().sort(), base.slice().sort(),
      '★ 导出键集必须与 newKeyword 规范形状一致，实际 ' + JSON.stringify(Object.keys(k)));

    // ② 旧键 / 派生键不许出现
    ['impNoteBg', '_flipped', 'cellVerifyAxis'].forEach((bad) => {
      falsy(bad in k, '★ 导出里不该再有旧键/派生键 ' + bad + '，实际 ' + JSON.stringify(Object.keys(k)));
    });

    // ③ 分隔符归一
    eq(k.fetchLabels, '甲|乙', 'fetchLabels 的多分隔符应归一成 |');

    // ④ 模块关着时**已填的值**逐字保留（⚠️ 契约 §四.1）
    eq(k.cellVerify, '标题', 'cellVerify 文本必须保留（cellVerifyEnabled 归零是允许的）');
    eq(k.cellVerifyEnabled, false, 'cellVerify 依赖的开关可以归零（本来就无效）');
    eq(k.cellOffset, '2', 'cellOffset 必须保留');
    eq(k.importantNote, '笔记', 'importantNote 必须保留');
    eq(k.imgSize, 66, 'imgSize 必须保留');
    eq(k.impNoteUseHlColor, true, 'impNoteUseHlColor 必须保留');
    eq(k.imgOcr, true, 'imgOcr 必须保留');
    eq(k.imgOcrKeyword, '一对一', 'imgOcrKeyword 必须保留');
    eq(k.imgOcrMax, 3, 'imgOcrMax 必须保留');
    eq(k.fetchEnabled, true, '缺键的 fetchEnabled 应按非空 fetchLabels 反推（＝true）');

    // ⑤ id / 时间戳原样（原对象有就必须原样带出）
    eq(k.id, 'old1', 'id 原样');
    eq(k.createdAt, 111, 'createdAt 原样（不许被覆盖成 now）');
    eq(k.updatedAt, 222, 'updatedAt 原样（不许被覆盖成 now）');

    // ⚠️ 原对象**没有**时间戳时不得凭空生成
    const bare = S.normalizeForExport({ text: '无时间戳' }, cfg);
    falsy('createdAt' in bare, '★ 源对象没有 createdAt ⇒ 导出不得凭空生成');
    falsy('updatedAt' in bare, '★ 源对象没有 updatedAt ⇒ 导出不得凭空生成');
  });

  await test('★ exportCSV 用同一份规范化数据：第 12/13/17 列与规范化一致、第 18 列＝tb（B9 一起）', () => {
    const cfg = { keywords: [], groups: [], matchSettings: {} };
    const csv = S.exportCSV({ keywords: [oldShapeKw()], groups: [] });
    const recs = S.parseCSV(csv);
    eq(recs.length, 2, '1 行表头 + 1 行数据');
    eq(recs[1][11], '否', '第 12 列（单元格组合）＝规范性 false');
    eq(recs[1][12], '标题', '第 13 列（标题关键词）＝原值');
    eq(recs[1][16], '甲|乙', '第 17 列（抓取后续字段）＝归一后的值');
    eq(recs[1][17], 'tb', '★ 第 18 列＝tb（老键 cellVerifyAxis 不得被当成 lr）');
  });

  await test('★ groups 也走 newGroup：导出不再带 impNoteBg 这类非规范键', () => {
    const out = JSON.parse(S.exportJSON(null, {
      keywords: [], groups: [{ id: 'g1', name: '组一', important: true, impNoteBg: '#fff', _flipped: true }]
    }));
    const g = out.groups[0];
    truthy(g, '导出文件里应有这个分组');
    eq(g.name, '组一');
    falsy('impNoteBg' in g, '★ 分组导出也要过规范构造器（不得再带 impNoteBg）');
    falsy('_flipped' in g, '分组导出不得再带 _flipped');
    deepEq(Object.keys(g).slice().sort(), Object.keys(S.newGroup({})).slice().sort(),
      '分组键集＝newGroup 的键集，实际 ' + JSON.stringify(Object.keys(g)));
  });

  /* ================================================================ B6 */

  suite('K72 · B6 stripDeprecated 必须真的删掉 head.tail');

  await test('★ 导入旧备份不得把废弃键写回（嵌套 border 三键 + 三个顶层废弃键）', async () => {
    const savedHs = mem.highlightStyle;
    const saved = { noteFormat: mem.noteFormat, comboFlipped: mem.comboFlipped, pageCleanMinGap: mem.pageCleanMinGap };
    try {
      await S.patch({
        highlightStyle: {
          defaultBgColor: '#ff9500', defaultTextColor: '#000000',
          defaultBorderColor: '#e6c300', defaultBorderWidth: '1px', defaultBorderRadius: 'iat::3px'
        },
        noteFormat: 'plain', comboFlipped: true, pageCleanMinGap: 5
      });
      /* 看**落盘对象**（`S.load()` 会经 normalize 顺手删掉，反而掩盖"写回过"这个事实） */
      const hs = mem.highlightStyle || {};
      falsy('defaultBorderColor' in hs, '★ defaultBorderColor 不许写回存储');
      falsy('defaultBorderWidth' in hs, '★ defaultBorderWidth 不许写回存储');
      falsy('defaultBorderRadius' in hs, '★ defaultBorderRadius 不许写回存储');
      eq(hs.defaultBgColor, '#ff9500', '兄弟键必须保留（只删废弃的）');
      eq(hs.defaultTextColor, '#000000', '兄弟键必须保留');
      falsy('noteFormat' in mem, '顶层废弃键 noteFormat 不许写回');
      falsy('comboFlipped' in mem, '顶层废弃键 comboFlipped 不许写回');
      falsy('pageCleanMinGap' in mem, '顶层废弃键 pageCleanMinGap 不许写回');
    } finally {
      mem.highlightStyle = savedHs;
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete mem[k]; else mem[k] = saved[k]; }
    }
  });

  await test('★ stripDeprecated 只删存在的键、不新建对象（head 不存在时原样返回）', () => {
    const r1 = KH.Config.stripDeprecated({ keywords: [] });
    deepEq(r1, { keywords: [] }, '不相关的 patch 必须原样');
    const r2 = KH.Config.stripDeprecated({ highlightStyle: null });
    deepEq(r2, { highlightStyle: null }, 'head 不是普通对象时不许新建/报错');
    const r3 = KH.Config.stripDeprecated({ highlightStyle: { defaultBgColor: '#fff' } });
    deepEq(r3, { highlightStyle: { defaultBgColor: '#fff' } }, '没命中废弃键时不许改动那个对象');
    /* 浅拷贝隔离：删嵌套键不能改到调用方传进来的对象 */
    const src = { highlightStyle: { defaultBgColor: '#fff', defaultBorderWidth: '1px' } };
    KH.Config.stripDeprecated(src);
    eq(src.highlightStyle.defaultBorderWidth, '1px', '不许就地改动调用方的对象');
  });

  /* ================================================================ B9 */

  suite('K72 · B9 cellVerifyAxis 单一化（判重 / CSV 第 18 列 / 保存归一 / 编译四处同源）');

  await test('★ 判重键：{cellVerifyAxis:"tb"} 与 {comboAxis:"tb"} 同键，与 {comboAxis:"lr"} 不同键', () => {
    const legacy = { text: '甲', cellVerify: '标题', cellVerifyAxis: 'tb' };
    const modern = { text: '甲', cellVerify: '标题', comboAxis: 'tb' };
    const lr = { text: '甲', cellVerify: '标题', comboAxis: 'lr' };
    eq(S.keyOf(legacy), S.keyOf(modern), '★ 老键 cellVerifyAxis:tb 必须与新键 comboAxis:tb 同键');
    truthy(S.keyOf(legacy) !== S.keyOf(lr), '★ 与 lr 必须不同键（否则 tb 那条会被当成重复丢掉）');
    falsy(S.findDup([lr], legacy), '不同方向**不该**被判重（lr 已存在时 tb 的老键词要能加进去）');
    truthy(S.findDup([modern], legacy), '同方向才算重复');
    /* `comboAxis:'lr'` + `cellVerifyAxis:'tb'`：老 combo.js 判据（`comboAxis || cellVerifyAxis`）
     * 会读成 lr；单一化后 tb 优先 */
    eq(S.axisOf({ comboAxis: 'lr', cellVerifyAxis: 'tb' }), 'tb', '★ 任一为 tb 即 tb（tb 优先）');
    eq(S.axisOf({ comboAxis: 'tb', cellVerifyAxis: 'lr' }), 'tb');
    eq(S.axisOf({}), 'lr', '都没有 → lr');
  });

  await test('★ CSV 第 18 列：老键 tb 进必须 tb 出', () => {
    const legacy = { id: 'k', text: '甲', cellVerifyEnabled: true, cellVerify: '标题', cellVerifyAxis: 'tb' };
    /* ① 直接量列原语：B5 的导出归一会把 comboAxis 补齐，所以只测 exportCSV 会**掩盖**
     *    `rowValues` 自己是否认老键（Excel 导出等其它调用方仍走它）—— 这里直接判列值。 */
    eq(S.rowValues(legacy, new Map())[17], 'tb', '★ rowValues 必须自己也认 cellVerifyAxis:tb');
    /* ② 端到端：CSV 第 18 列 */
    const csv = S.exportCSV({ groups: [], keywords: [legacy] });
    const recs = S.parseCSV(csv);
    eq(recs[1][17], 'tb', '★ 只带 cellVerifyAxis:tb 的词，CSV 第 18 列也必须是 tb');
  });

  await test('★ 保存归一：upsertKeyword 后仍是 tb（落在 comboAxis 上），且 CSV 往返仍 tb', async () => {
    const savedKw = mem.keywords; const savedG = mem.groups;
    mem.keywords = []; mem.groups = [];
    try {
      const item = await S.upsertKeyword({ text: '甲', cellVerifyEnabled: true, cellVerify: '标题', cellVerifyAxis: 'tb' }, CFG);
      eq(item.comboAxis, 'tb', '★ 保存时把老键归一成 comboAxis，且 tb 不许变 lr');
      const back = await S.load();
      const k = (back.keywords || []).find(x => x.cellVerify === '标题');
      truthy(k, '应能读回该词');
      eq(S.axisOf(k), 'tb', '★ 往返后方向仍是 tb');

      const csv = S.exportCSV({ keywords: [k], groups: [] });
      mem.keywords = []; mem.groups = [];
      await S.importCSV(csv, { keywords: [], groups: [] });
      const again = (await S.load()).keywords[0];
      eq(again.comboAxis, 'tb', '★ CSV 往返 tb 不得变 lr');
    } finally { mem.keywords = savedKw; mem.groups = savedG; }
  });

  /* ================================================= A2 / A3 / B8 文案 */

  suite('K72 · A2/A3/B8 面向用户的文案（旧串消失 / 新串存在）');

  await test('A2：面板位置＝左上角（fieldmap 两条 hint + options.html 全文）', () => {
    const imp = FM.FORM_SECTIONS.find(s => s.id === 'imp');
    truthy((imp.hint || '').indexOf('左上角') >= 0, 'imp 分区说明应含「左上角」，实际 ' + JSON.stringify(imp.hint));
    falsy((imp.hint || '').indexOf('右上角') >= 0, 'imp 分区说明不该再有「右上角」');
    truthy((imp.hintTitle || '').indexOf('左上角') >= 0, 'imp 的 tooltip 同判（含左上角）');
    falsy((imp.hintTitle || '').indexOf('右上角') >= 0, 'imp 的 tooltip 不该再有「右上角」');

    const html = readSrc('options/options.html');
    falsy(html.indexOf('右上角') >= 0, '★ options.html 里**用户可见**文案不该再出现「右上角」');
    truthy(html.split('左上角').length >= 3, 'options.html 应有两处以上「左上角」（快速上手 + 重要笔记）');
  });

  await test('A3：诊断结论句改成新口径（图片识别＝抓取模块的分支，普通词也能用）', () => {
    const src = readSrc('src/core/index.js');
    falsy(src.indexOf('图片识别只对') >= 0, '★ 不该再写「图片识别只对…」');
    falsy(src.indexOf('只对「组合词」') >= 0, '★ 不该再写「只对「组合词」」');
    truthy(src.indexOf('图里的字要靠「抓取后续字段」') >= 0, '新口径句应点名「抓取后续字段」');
    truthy(src.indexOf('普通词与组合词都能用') >= 0, '新口径句应说明普通词也能用');
  });

  await test('A3：设置页补 CSV 差异说明 + 尺寸前提（本词勾「重要」）', () => {
    const html = readSrc('options/options.html');
    truthy(html.indexOf('要连这些一起搬走请用 <strong>JSON 导出</strong>') >= 0, '★ CSV 列说明必须补"用 JSON 导出"');
    truthy(html.indexOf('CSV <strong>不含</strong>「抓取后续字段」的模块开关') >= 0, 'CSV 说明要点名不含模块开关');
    truthy(html.indexOf('取值格') >= 0, 'CSV 说明要列出"取值格"这一类不含的字段');
    truthy(html.indexOf('图片尺寸按「关键词 &gt; 分组 &gt; 全局默认」取值（关键词那一档需<strong>本词</strong>勾「重要」才生效）') >= 0,
      '★ 尺寸优先级说明要补「本词勾「重要」」前提');
  });

  await test('B8-1..5：五条过时文案（旧串消失 / 新串存在）', () => {
    const html = readSrc('options/options.html');
    const js = readSrc('options/options.js');
    const readme = readSrc('README.md');

    falsy(html.indexOf('统计数据仅记录命中数量') >= 0, '★ B8-1 旧句必须删掉');
    truthy(html.indexOf('不记录、不上传任何浏览数据') >= 0, 'B8-1 新句应在');

    falsy(js.indexOf('标题词 · 仅组合词') >= 0, '★ B8-2 旧串必须消失');
    truthy(js.indexOf('标题词（需勾选「单元格组合」）') >= 0, 'B8-2 新串应在');

    falsy(js.indexOf('仅组合词，在弹窗中勾选') >= 0, '★ B8-3 旧串必须消失');
    truthy(js.indexOf('需勾选「单元格组合」，在弹窗中勾选') >= 0, 'B8-3 新串应在');

    falsy(html.indexOf('复用高亮底色') >= 0, '★ B8-4 旧串必须消失（现行标签是「底色」）');
    truthy(html.indexOf('也可勾选「底色」') >= 0, 'B8-4 新串应在');

    falsy(html.indexOf('重要笔记图片尺寸 (px)') >= 0, '★ B8-5 options.html 旧串必须消失');
    truthy(html.indexOf('重要笔记图片「尺寸」默认值') >= 0, 'B8-5 新串应在（用现行标签「尺寸」）');
    falsy(readme.indexOf('配色与图片尺寸') >= 0, '★ B8-5 README 旧串必须消失（与 options.html 同判）');
    truthy(readme.indexOf('分组可统一配色与尺寸') >= 0, 'B8-5 README 新串应在');
  });

  await test('B8-6..10：语言包/快捷键/窗口尺寸五条（旧串消失 / 新串存在）', () => {
    const js = readSrc('options/options.js');
    const cl = readSrc('src/ui/changelog.js');
    const welcome = readSrc('welcome/welcome.html');
    const popup = readSrc('popup/popup.js');
    const editor = readSrc('popup/editor.html');

    falsy(js.indexOf('下一版会提供下载') >= 0, '★ B8-6 死文案必须消失');
    falsy(js.indexOf('还没随站点提供') >= 0, '★ B8-6 旧串必须消失');
    truthy(js.indexOf('请在下面的「语言包」里下载') >= 0, 'B8-6 新串应在');

    truthy(cl.indexOf('英文高精度包还在下载（该包随后已一并托管）') >= 0, 'B8-7 历史条目应已加注（唯一允许动的那条）');

    falsy(js.indexOf('语言包按这一档单独下载') >= 0, '★ B8-8 旧串必须消失');
    truthy(js.indexOf('按这一档单独保存，切换档位后才需要下载') >= 0, 'B8-8 新串应在');

    falsy(welcome.indexOf('恢复本页高亮') >= 0, '★ B8-9 Ctrl+Shift+H 是全局开关，不能写"本页"');
    truthy(welcome.indexOf('恢复<strong>全局</strong>高亮') >= 0, 'B8-9 新串应在');
    truthy(welcome.indexOf('临时禁用本站') >= 0, '本页级仍是 Ctrl+Shift+S（原句保留）');

    falsy(popup.indexOf('920×660') >= 0, '★ B8-10 popup.js 旧尺寸必须消失');
    falsy(editor.indexOf('920×660') >= 0, '★ B8-10 editor.html 旧尺寸必须消失');
    truthy(popup.indexOf('920×500') >= 0, 'B8-10 popup.js 新尺寸应在');
    truthy(editor.indexOf('920×500') >= 0, 'B8-10 editor.html 新尺寸应在');
    truthy(popup.indexOf('height: 500') >= 0, '新尺寸与真实 open 参数一致（height: 500）');
  });

  await test('B7/B8-11：人工检查清单的期望已改（A9 折叠口径 + 图片命中展开 + 侧边栏 7 项 + CSV 说明）', () => {
    const doc = readSrc('tests/BROWSER-CHECKLIST.md');
    /* A9：旧期望那句被**明确标注作废**（而不是删得无影无踪 —— 下一个人可能正带着旧印象来）
     * ⇒ 判"新期望在 + 旧期望被标作废 + 实测数字在"，而不是判"旧串不存在"。 */
    truthy(doc.indexOf('折叠只改变弹窗总高（内容自适应）与各卡片的绝对位置') >= 0, 'A9 新期望应在');
    truthy(doc.indexOf('是**旧期望**，已作废') >= 0, 'A9 要明确把旧期望标成作废');
    truthy(doc.indexOf('别再照它判错') >= 0, 'A9 要提醒下一个人别照旧期望判错');
    truthy(doc.indexOf('547 → 441') >= 0, 'A9 要附实测数字');

    falsy(doc.indexOf('默认折叠、点标题展开') >= 0, '★ B8-11 图片命中分区是"有命中自动展开"');
    truthy(doc.indexOf('有命中自动展开') >= 0, 'B8-11 新串应在');

    falsy(doc.indexOf('侧边栏是 **6 项**') >= 0, '★ 侧边栏现在是 7 项');
    const sevenAt = doc.indexOf('侧边栏是 **7 项**');
    truthy(sevenAt >= 0, 'B8-11 新串应在');
    truthy(doc.slice(sevenAt, sevenAt + 200).indexOf('图片识别') >= 0, '7 项清单里要含「图片识别」');

    truthy(doc.indexOf('**CSV 不含「抓取后续字段」的模块开关**') >= 0, 'B8-11 CSV 节要补开关说明');
    truthy(doc.indexOf('要连开关一起搬走请用 **JSON 导出**') >= 0, '并指出用 JSON 导出');
  });
};
