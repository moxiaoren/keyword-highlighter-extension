/* tests/specs/k72-r4-recheck.test.js — K72「升级兼容与文案收口」的 **R4 独立复验**（红队口径）
 * ----------------------------------------------------------------------------
 * 与 R3 的 `k72-upgrade-compat.test.js` **互不替代**：这里全部用 R4 自己造的夹具与自己的写法，
 * 按契约 §五 每条的"判定锚"独立判一遍，另外加了几处 R3 没钉的边界：
 *   A1：JSON **overwrite 与 merge 两种模式**、CSV **带分组名**、**旧 17 列 CSV**、
 *       `fetchEnabled:false` 的仅抓取词（数据安全：只许保留不许丢）、普通词/组合词对照臂逐字段比对。
 *   A2：把"用户可见文案"的判定写成**字段串遍历** + **options.html 全文（含注释）**，不是裸 grep。
 *   A3：从源码里**切出那句判定句**再判，避免"同文件别处出现关键词"造成的假绿。
 *   B5：R4 自己的旧形态夹具（含 `cellVerifyEnabled:true` 但 `cellVerify:''` 的边界词）+ 7 条锚全判。
 *   B6：直接断言**落盘对象**（`chrome.storage` 垫片 `mem`），并用 `patch({})` / 非对象值做边界。
 *   B9：除 keyOf/CSV 外，**直测 `rowValues` 原语**、并用"运行期哨兵"证明 `combo.js` 只转发 `Store.axisOf`。
 *
 * 反向验证（R4 自跑）用到的目标用例就在本文件里：
 *   ① A1 两处判据回退 → 《A1 JSON 两种模式》《A1 CSV》红；
 *   ② `exportJSON` 回退成 `cfg.keywords || []` → 《B5 键集…》红；
 *   ③ `stripDeprecated` 回退成 `continue` → 《B6 …落盘对象》红；
 *   ④ `keyOf`/`rowValues` 回退只读 `comboAxis` → 《B9 …》红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq, skipIf } = H;

const ROOT = path.join(__dirname, '..', '..');
const OUTSIDE = path.join(ROOT, '..', '..');          // 浏览器插件/
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readOut = (rel) => fs.readFileSync(path.join(OUTSIDE, rel), 'utf8');

/** options.html 的「用户可见文本」= 去掉注释 / script / style（用于 A2/A3 的精确判定） */
const visibleHtml = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '');
/** 取包含某个标记的 `<li>…</li>` 片段（帮助区文案都是 li） */
const liWith = (html, needle) => {
  const re = /<li[^>]*>[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) if (m[0].indexOf(needle) >= 0) return m[0];
  return '';
};

module.exports = async function run() {
  const { KH, mem } = require('../bootstrap');
  const S = KH.Store;
  const C = KH.Config;
  const FM = KH.FieldMap;
  const CFG = C.defaults;

  /* chrome.storage 垫片是**跨 spec 共享**的：每条用例自己快照/还原，绝不留痕 */
  const snap = () => JSON.parse(JSON.stringify(mem));
  const restore = (s) => { for (const k of Object.keys(mem)) delete mem[k]; Object.assign(mem, s); };
  const inMem = async (fn) => { const s = snap(); try { return await fn(); } finally { restore(s); } };
  /** 在**空存储**上跑（B6 要断言"不许新建对象"，必须排除别的 spec 留下的键） */
  const inEmptyMem = async (fn) => {
    const s = snap();
    for (const k of Object.keys(mem)) delete mem[k];
    try { return await fn(); } finally { restore(s); }
  };

  /** 「仅抓取」词（无核心词 + 标题词 + 抓取字段） */
  const fetchOnly = (over) => Object.assign({
    id: 'r4-fo', text: '', cellVerifyEnabled: true, cellVerify: '应用名称',
    fetchLabels: '包名', important: true
  }, over);

  /* ==================================================================== A1 */

  suite('K72 复验 · A1 仅抓取词往返（R4 独立夹具；JSON 两种模式 + CSV）');

  await test('★ A1 JSON 往返：overwrite 与 merge 两种模式都必须保留仅抓取词、字段逐字一致', async () => {
    await inMem(async () => {
      const kw = S.sanitizeKeyword(fetchOnly(), CFG);
      eq(kw.fetchOnly, true, '前置：这条词必须被识别成"仅抓取"');
      const json = S.exportJSON(null, { keywords: [kw], groups: [] });

      /* ① overwrite */
      mem.keywords = []; mem.groups = [];
      await S.importJSON(json, { mode: 'overwrite' }, { keywords: [], groups: [] });
      let back = await S.load();
      let k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ overwrite：仅抓取词必须还在（旧实现 `.filter(k => k.text)` 会丢掉它）');
      eq(k.text, '', '核心词仍是空串');
      eq(k.cellVerifyEnabled, true, '「单元格组合」仍在');
      eq(k.cellVerify, '应用名称', '标题词逐字保真');
      eq(k.fetchLabels, '包名', '抓取字段逐字保真');
      eq(k.important, true, '「重要」保真');
      eq(k.fetchOnly, true, '★ 仍是仅抓取（fetchOnly 计算正确）');

      /* ② merge：库里已有别的词，仅抓取词要**被添加**而不是被跳过 */
      const other = S.sanitizeKeyword({ id: 'r4-plain', text: '已有词' }, CFG);
      mem.keywords = [other]; mem.groups = [];
      const stats = await S.importJSON(json, { mode: 'merge' }, { keywords: [other], groups: [] });
      back = await S.load();
      eq(stats.keywords, 1, 'merge 模式应新增 1 条（不是 0）');
      eq((back.keywords || []).length, 2, 'merge 后库里应有 2 条（原有的 + 仅抓取词）');
      k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ merge：仅抓取词同样必须被导入');
      eq(k.fetchLabels, '包名');
      eq(k.fetchOnly, true);
    });
  });

  await test('★ A1 CSV 往返：首列为空的合法行必须被导入（第 12/13 列是判据）', async () => {
    await inMem(async () => {
      const kw = S.sanitizeKeyword(fetchOnly(), CFG);
      const csv = S.exportCSV({ keywords: [kw], groups: [] });
      const recs = S.parseCSV(csv);
      eq(recs.length, 2, '表头 + 1 行数据');
      eq(recs[1][0], '', '前置：仅抓取词第 1 列（核心词）本来就是空的');
      eq(recs[1][11], '是', '第 12 列＝单元格组合');
      eq(recs[1][12], '应用名称', '第 13 列＝标题关键词(左格)');
      mem.keywords = []; mem.groups = [];
      const stats = await S.importCSV(csv, { keywords: [], groups: [] });
      eq(stats.added, 1, '★ 必须导入 1 条（旧实现"首列为空即跳过"会 added=0）');
      const back = await S.load();
      const k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ 首列为空的仅抓取行必须被导入');
      eq(k.text, '', '核心词仍空');
      eq(k.fetchLabels, '包名', '抓取字段保真');
      eq(k.fetchOnly, true, '仍是仅抓取');
    });
  });

  await test('★ A1 证伪：CSV 里那条仅抓取**同时带分组名**（第 3 列非空）也必须能导入，且分组被回建', async () => {
    await inMem(async () => {
      mem.keywords = []; mem.groups = [];
      const g = S.newGroup({ id: 'g-r4', name: 'R4分组甲' });
      const kw = S.sanitizeKeyword(fetchOnly({ groupId: 'g-r4' }), { groups: [g] });
      const csv = S.exportCSV({ keywords: [kw], groups: [g] });
      const recs = S.parseCSV(csv);
      eq(recs[1][2], 'R4分组甲', '前置：第 3 列＝分组名（非空）');
      const stats = await S.importCSV(csv, { keywords: [], groups: [] });
      eq(stats.added, 1, '带分组的仅抓取行必须被导入');
      eq(stats.groupsCreated, 1, '分组名应被回建');
      const back = await S.load();
      const k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ 带分组的仅抓取词也要能导入（只判"第 12/13 列"的实现在这里同样成立）');
      eq(k.fetchLabels, '包名');
      truthy((back.groups || []).some((x) => x.name === 'R4分组甲'), '分组确实被回建');
    });
  });

  await test('★ A1 证伪：旧版 17 列 CSV 仍能导入（含首列为空的仅抓取行）', async () => {
    await inMem(async () => {
      const kw = S.sanitizeKeyword(fetchOnly(), CFG);
      const norm = S.normalizeForExport(kw, CFG);
      const header = S.CSV_HEADERS.slice(0, 17).join(',');
      const row = S.rowValues(norm, new Map()).slice(0, 17).join(',');
      eq(header.split(',').length, 17, '前置：这是 17 列旧文件');
      const csv = '\uFEFF' + header + '\r\n' + row;
      mem.keywords = []; mem.groups = [];
      const stats = await S.importCSV(csv, { keywords: [], groups: [] });
      eq(stats.added, 1, '★ 17 列旧文件里的仅抓取行必须能导入');
      const back = await S.load();
      const k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '仅抓取词应被导入');
      eq(k.comboAxis, 'lr', '缺「组合方向」列时按左右格（既有兼容口径）');
      eq(k.fetchLabels, '包名');
    });
  });

  await test('★ A1 对照臂：普通词 / 组合词的 JSON 与 CSV 往返结果逐字段不变', async () => {
    await inMem(async () => {
      const plain = S.sanitizeKeyword({
        id: 'r4-p', text: '普通词', note: '备注文本', cellVerifyEnabled: false, cellVerify: '',
        fetchLabels: '字段甲|字段乙', important: true, importantNote: '笔记', enabled: true,
        caseSensitive: true, wholeWord: true, useRegex: false, bgColor: '#112233', textColor: '#ffffff'
      }, CFG);
      const combo = S.sanitizeKeyword({
        id: 'r4-c', text: '核心', cellVerifyEnabled: true, cellVerify: '标题', comboAxis: 'tb',
        cellVerifyMatchMode: 'exact', cellVerifyCaseSensitive: true, cellVerifyUseRegex: false,
        fetchLabels: ''
      }, CFG);
      const wanted = ['text', 'note', 'enabled', 'caseSensitive', 'wholeWord', 'useRegex', 'bgColor', 'textColor',
        'important', 'importantNote', 'cellVerifyEnabled', 'cellVerify', 'cellVerifyMatchMode',
        'cellVerifyCaseSensitive', 'cellVerifyUseRegex', 'fetchLabels', 'comboAxis'];
      const of = (k) => { const o = {}; for (const f of wanted) o[f] = k[f]; return o; };

      /* JSON */
      const json = S.exportJSON(null, { keywords: [plain, combo], groups: [] });
      mem.keywords = []; mem.groups = [];
      await S.importJSON(json, { mode: 'overwrite' }, { keywords: [], groups: [] });
      let back = await S.load();
      eq((back.keywords || []).length, 2, 'JSON：两条都应在');
      deepEq(of((back.keywords || []).find((k) => k.text === '普通词')), of(plain), 'JSON：普通词逐字段不变');
      deepEq(of((back.keywords || []).find((k) => k.text === '核心')), of(combo), 'JSON：组合词逐字段不变');

      /* CSV */
      const csv = S.exportCSV({ keywords: [plain, combo], groups: [] });
      mem.keywords = []; mem.groups = [];
      await S.importCSV(csv, { keywords: [], groups: [] });
      back = await S.load();
      eq((back.keywords || []).length, 2, 'CSV：两条都应在');
      deepEq(of((back.keywords || []).find((k) => k.text === '普通词')), of(plain), 'CSV：普通词逐字段不变');
      deepEq(of((back.keywords || []).find((k) => k.text === '核心')), of(combo), 'CSV：组合词逐字段不变（含 tb 方向）');
    });
  });

  await test('★ A1 边界（数据安全）：fetchEnabled:false 的仅抓取词也不许在导入时被丢', async () => {
    await inMem(async () => {
      const kw = S.sanitizeKeyword(fetchOnly({ fetchEnabled: false }), CFG);
      eq(kw.fetchEnabled, false, '前置：这条词的抓取开关是关的');
      const json = S.exportJSON(null, { keywords: [kw], groups: [] });
      mem.keywords = []; mem.groups = [];
      await S.importJSON(json, { mode: 'overwrite' }, { keywords: [], groups: [] });
      let back = await S.load();
      let k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ 开关关着的仅抓取词同样不许被丢（A1 只判核心词/标题词，与开关无关）');
      eq(k.fetchEnabled, false, 'JSON 是保真通道：false 必须原样');
      eq(k.fetchLabels, '包名', '内容保留（关闭态不清空）');

      const csv = S.exportCSV({ keywords: [S.sanitizeKeyword(fetchOnly({ fetchEnabled: false }), CFG)], groups: [] });
      mem.keywords = []; mem.groups = [];
      await S.importCSV(csv, { keywords: [], groups: [] });
      back = await S.load();
      k = (back.keywords || []).find((x) => x.cellVerify === '应用名称');
      truthy(k, '★ CSV 往返也不许丢词');
      eq(k.fetchLabels, '包名', '抓取字段保真');
      eq(k.fetchEnabled, true, 'CSV 不带开关 ⇒ 导入后按非空字段反推＝true（R0 裁定 3 的已知口径）');
    });
  });

  /* ==================================================================== A2 */

  suite('K72 复验 · A2 面板位置文案（用户可见串遍历，不是裸 grep）');

  await test('★ A2 字段声明层：所有**用户可见**字段串无「右上角」；imp 分区说明与 tooltip 含「左上角」', () => {
    const tables = {
      KEYWORD_FIELDS: FM.KEYWORD_FIELDS, GROUP_FIELDS: FM.GROUP_FIELDS,
      NOTE_CARD_FIELDS: FM.NOTE_CARD_FIELDS, SITE_RULE_FIELDS: FM.SITE_RULE_FIELDS,
      FORM_SECTIONS: FM.FORM_SECTIONS
    };
    const hits = [];
    for (const [tname, list] of Object.entries(tables)) {
      for (const f of list || []) {
        for (const k of ['label', 'short', 'hint', 'hintTitle', 'placeholder']) {
          if (typeof f[k] === 'string' && f[k].indexOf('右上角') >= 0) hits.push(tname + '.' + (f.key || f.id) + '.' + k + '=' + f[k]);
        }
      }
    }
    deepEq(hits, [], '★ 用户可见字段串里不许再出现「右上角」，实际 ' + JSON.stringify(hits));

    const imp = FM.FORM_SECTIONS.find((s) => s.id === 'imp');
    truthy(imp.hint.indexOf('左上角') >= 0, 'imp 分区说明必须含「左上角」，实际 ' + JSON.stringify(imp.hint));
    truthy(String(imp.hintTitle || '').indexOf('左上角') >= 0, 'imp 的 tooltip 必须含「左上角」');
    truthy(imp.hint.indexOf('右上角') < 0 && String(imp.hintTitle || '').indexOf('右上角') < 0, '两处都不许再有「右上角」');
    /* 方向文案表（AXIS_LABELS）也是用户可见的，一起判 */
    for (const axis of ['lr', 'tb']) {
      const lb = FM.axisLabels(axis);
      falsy(String(lb.hint || '').indexOf('右上角') >= 0, axis + ' 档说明不该有「右上角」');
    }
  });

  await test('★ A2 options.html：全文（含注释）无「右上角」；两处"面板在哪"的帮助条目都写左上角', () => {
    const html = readSrc('options/options.html');
    falsy(html.indexOf('右上角') >= 0, '★ options.html 里不该再出现「右上角」（含注释）');
    const noteLi = liWith(html, '弹出笔记');
    truthy(noteLi.indexOf('左上角') >= 0, '「弹出笔记」那条必须写左上角，实际 ' + JSON.stringify(noteLi.slice(0, 120)));
    const panelLi = liWith(html, '置顶悬浮面板');
    truthy(panelLi.indexOf('左上角') >= 0, '「置顶悬浮面板」那条必须写左上角');
  });

  /* ==================================================================== A3 */

  suite('K72 复验 · A3 诊断结论句 / CSV 差异说明 / 尺寸前提');

  await test('★ A3 core/index.js：判定句切出来判 —— 不含旧口径（只对组合词）、含新口径（抓取后续字段 + 普通词也能用）', () => {
    const src = readSrc('src/core/index.js');
    falsy(src.indexOf('图片识别只对') >= 0, '★ 源码里不许再有「图片识别只对…」这个旧口径');
    const anchor = src.indexOf('个画布');
    truthy(anchor > 0, '应能找到画布那条判定分支');
    const slice = src.slice(anchor, anchor + 500);
    falsy(/只对/.test(slice), '★ 该判定句不许含「只对」，实际 ' + JSON.stringify(slice.slice(0, 200)));
    falsy(/「组合词」/.test(slice), '★ 该判定句不许把「组合词」当生效前提');
    truthy(slice.indexOf('抓取后续字段') >= 0, '新口径要点名「抓取后续字段」');
    truthy(slice.indexOf('普通词与组合词都能用') >= 0, '新口径要说清"普通词也能用"');
    /* 旧口径不许在**任何用户可见处**复活 */
    const popup = readSrc('popup/popup.js');
    falsy(/只对「组合词」生效/.test(popup), 'popup 里也不许有旧口径（它直接打印 verdict）');
  });

  await test('★ A3 options.html：CSV 段含「JSON 导出」且列举行里不含那 7 个进不了 CSV 的字段；尺寸段含「本词」', () => {
    const html = readSrc('options/options.html');
    const csvLi = liWith(html, 'CSV 列');
    truthy(csvLi, '应能找到 CSV 列说明那条');
    truthy(csvLi.indexOf('JSON 导出') >= 0, '★ CSV 段必须指路「JSON 导出」');
    const enumeration = csvLi.split('<strong>注意</strong>')[0];   // 「注意」之前是列列举
    for (const bad of ['取值格', '识别图片文字', '图片命中关键词', '每处最多', '模块开关', '尺寸', '底色']) {
      falsy(enumeration.indexOf(bad) >= 0, '★ 列举行里不该把这些当 CSV 列：' + bad + ' → ' + JSON.stringify(enumeration.slice(-160)));
    }
    truthy(/不含/.test(csvLi), 'CSV 段要明说"不含"哪些');

    const sizeLi = liWith(html, '图片尺寸按');
    truthy(sizeLi, '应能找到图片尺寸优先级那条');
    truthy(sizeLi.indexOf('本词') >= 0, '★ 尺寸段必须写"关键词那一档需**本词**勾「重要」"，实际 ' + JSON.stringify(sizeLi.slice(0, 160)));
    truthy(sizeLi.indexOf('重要') >= 0, '尺寸段要点名「重要」');
  });

  /* ==================================================================== B5 */

  suite('K72 复验 · B5 导出即规范形状（R4 自带旧形态夹具）');

  /** 旧形态：缺 6 个新键 + 带三个旧/派生键 + 逗号分隔的抓取字段 + **模块关着但值在** */
  const legacyKw = (over) => Object.assign({
    id: 'r4-old', text: '旧形态', note: '旧备注',
    impNoteBg: '', _flipped: true, cellVerifyAxis: 'tb',
    fetchLabels: '甲,乙', fetchEnabled: false,
    cellVerifyEnabled: false, cellVerify: '标题', cellOffset: '2',
    importantNote: '笔记', imgSize: 66, impNoteUseHlColor: true,
    imgOcr: true, imgOcrKeyword: '一对一', imgOcrMax: 3
  }, over);

  await test('★ B5 键集逐字等于规范键集；三个旧/派生键消失；fetchLabels 分隔符归一为 |（走 exportJSON 真路径）', () => {
    /* ⚠️ 走**导出真路径**（exportJSON）而不是只调 helper —— 否则 exportJSON 被改回
     * `cfg.keywords || []` 时这条会是假绿（R4 反向验证时实测到过这一点）。 */
    const viaJson = JSON.parse(S.exportJSON(null, { keywords: [legacyKw()], groups: [] })).keywords[0];
    const out = viaJson;
    const normAll = Object.keys(S.newKeyword({}, CFG));                    // 含 createdAt/updatedAt（可选键）
    const normReq = normAll.filter((k) => k !== 'createdAt' && k !== 'updatedAt');
    const allowed = new Set(normAll.concat(['kind', 'fetchOnly']));
    const unexpected = Object.keys(out).filter((k) => !allowed.has(k));
    deepEq(unexpected, [], '★ 导出键集不许有规范键集之外的键，实际多出：' + JSON.stringify(unexpected));
    const missing = normReq.filter((k) => !(k in out));
    deepEq(missing, [], '★ 规范键不许缺（时间戳是可选键，单判），缺：' + JSON.stringify(missing));
    for (const k of ['impNoteBg', '_flipped', 'cellVerifyAxis']) {
      falsy(k in out, '★ 旧键/派生键 ' + k + ' 不许出现在导出结果里');
    }
    eq(out.fetchLabels, '甲|乙', '★ 抓取字段分隔符归一：甲,乙 → 甲|乙');
    /* 第二层：helper 的直接产物必须与导出真路径逐键相同（键集 + 值） */
    const helper = S.normalizeForExport(legacyKw(), CFG);
    deepEq(Object.keys(viaJson).sort(), Object.keys(helper).sort(), 'exportJSON 的键集必须等于 normalizeForExport 的键集');
    deepEq(viaJson, helper, 'exportJSON 的产物必须逐值等于 normalizeForExport（同一份归一）');
    /* CSV 也走同一份归一 */
    const recs = S.parseCSV(S.exportCSV({ keywords: [legacyKw()], groups: [] }));
    eq(recs[1][16], '甲|乙', 'exportCSV 第 17 列＝归一后的抓取字段');
    eq(recs[1][17], 'tb', 'exportCSV 第 18 列＝归一后的方向（老键 tb 也认）');
  });

  await test('★ B5 模块关着时已填的值逐字保留；id/时间戳原样（缺则不得凭空生成）—— 走导出真路径', () => {
    const src = legacyKw();
    const out = JSON.parse(S.exportJSON(null, { keywords: [src], groups: [] })).keywords[0];
    eq(out.id, 'r4-old', '★ id 不许被重新生成');
    falsy('createdAt' in out, '★ 源对象没有 createdAt ⇒ 导出不许写 Date.now()');
    falsy('updatedAt' in out, '★ 源对象没有 updatedAt ⇒ 导出不许写 Date.now()');

    /* 逐字保留（模块未启用不是清空的理由） */
    eq(out.cellVerify, '标题', 'cellVerify 逐字保留');
    eq(out.cellOffset, '2', 'cellOffset 逐字保留');
    eq(out.fetchLabels, '甲|乙', 'fetchLabels 内容保留（只归一分隔符）');
    eq(out.fetchEnabled, false, '★ fetchEnabled:false 但 fetchLabels 有内容 —— 关闭态与内容都要保留');
    eq(out.imgOcr, true, 'imgOcr 保留');
    eq(out.imgOcrKeyword, '一对一', 'imgOcrKeyword 保留');
    eq(out.imgOcrMax, 3, 'imgOcrMax 保留');
    eq(out.importantNote, '笔记', 'importantNote 保留');
    eq(out.imgSize, 66, 'imgSize 保留');
    eq(out.impNoteUseHlColor, true, 'impNoteUseHlColor 保留');
    eq(out.note, '旧备注', 'note 保留');

    /* 有则原样 */
    const withTs = JSON.parse(S.exportJSON(null, { keywords: [legacyKw({ id: 'r4-ts', createdAt: 111, updatedAt: 222 })], groups: [] })).keywords[0];
    eq(withTs.createdAt, 111, '源对象有 createdAt ⇒ 原样');
    eq(withTs.updatedAt, 222, '源对象有 updatedAt ⇒ 原样');
    /* 第二层：helper 直调结果与导出真路径一致（id/时间戳同样规则） */
    const helperTs = S.normalizeForExport(legacyKw({ id: 'r4-ts', createdAt: 111, updatedAt: 222 }), CFG);
    deepEq(helperTs, withTs, 'helper 与 exportJSON 必须逐值一致');
  });

  await test('★ B5 边界词：cellVerifyEnabled:true 但 cellVerify:"" ⇒ 归零允许，但已填的其它值不许被清；kind/fetchOnly 计算正确', () => {
    /* ① 边界：勾着组合却没有标题词 —— sanitizeKeyword 会把 cellVerifyEnabled 归零（§四.1 允许） */
    const edge = S.normalizeForExport({ id: 'r4-edge', text: '边界词', cellVerifyEnabled: true, cellVerify: '', fetchLabels: '字段甲', cellOffset: '3' }, CFG);
    eq(edge.cellVerifyEnabled, false, '允许归零（cellVerify 为空时本来就无效）');
    eq(edge.fetchLabels, '字段甲', '★ 归零不许连累 fetchLabels');
    eq(edge.cellOffset, '3', '★ 归零不许连累 cellOffset');

    /* ② fetchOnly：无核心词 + 有标题词 + 有抓取字段 ⇒ true */
    const fo = S.normalizeForExport(fetchOnly({ id: 'r4-fo2' }), CFG);
    eq(fo.fetchOnly, true, '仅抓取词的 fetchOnly 必须为 true');
    /* ③ 无标题词的空词 ⇒ 不是 fetchOnly；且 text 为空时**导出仍保留这一条**（数据安全由导入侧判据兜） */
    const empty = S.normalizeForExport({ id: 'r4-e', text: '', cellVerifyEnabled: false, fetchLabels: '甲' }, CFG);
    falsy(empty.fetchOnly, '没有标题词 ⇒ 不是仅抓取');
    eq(empty.fetchLabels, '甲', 'text 为空也不清字段');
    /* ④ kind：罕见字占位符 ⇒ rare；普通词 ⇒ 不带 kind */
    const rare = S.normalizeForExport({ id: 'r4-rare', text: S.RARE_KEYWORD, cellVerifyEnabled: true, cellVerify: '表头' }, CFG);
    eq(rare.kind, 'rare', '罕见字占位符 ⇒ kind=rare');
    const plain = S.normalizeForExport({ id: 'r4-plain', text: '普通' }, CFG);
    falsy('kind' in plain, '普通词不该带 kind');
  });

  await test('★ B5 CSV 与 JSON 同一份归一（第 12/13/17/18 列）+ groups 也走 newGroup（不带 impNoteBg）', () => {
    const kw = legacyKw({ cellVerifyEnabled: true, cellVerify: '标题' });
    const norm = S.normalizeForExport(kw, CFG);
    const csv = S.exportCSV({ keywords: [kw], groups: [] });
    const recs = S.parseCSV(csv);
    eq(recs[1][11], (norm.cellVerifyEnabled ? '是' : '否'), '第 12 列＝规范化后的 cellVerifyEnabled');
    eq(recs[1][12], norm.cellVerify, '第 13 列＝规范化后的标题词');
    eq(recs[1][16], norm.fetchLabels, '第 17 列＝规范化后的抓取字段（甲|乙）');
    eq(recs[1][17], S.axisOf(norm), '第 18 列＝规范化后的方向（老键 cellVerifyAxis:tb ⇒ tb）');
    eq(recs[1][17], 'tb', '★ 老键 tb 必须在 CSV 第 18 列体现');

    const json = JSON.parse(S.exportJSON(null, {
      keywords: [kw],
      groups: [{ id: 'g1', name: '组一', bgColor: '#111111', textColor: '#222222', important: true, importantNote: 'n', impNoteUseHlColor: true, imgSize: 88, impNoteBg: 'x', comboAxis: 'tb' }]
    }));
    const g = json.groups[0];
    falsy('impNoteBg' in g, '★ groups 必须走 newGroup：不许再带 impNoteBg');
    falsy('comboAxis' in g, 'groups 也不许带关键词的 comboAxis（未知键一律丢）');
    const gnorm = Object.keys(S.newGroup({}));
    deepEq(Object.keys(g).filter((k) => gnorm.indexOf(k) < 0), [], '分组键集必须逐字等于 newGroup 的键集');
    eq(g.name, '组一', '分组字段值保留');
  });

  /* ==================================================================== B6 */

  suite('K72 复验 · B6 stripDeprecated 支持 head.tail（直接断言落盘对象）');

  await test('★ B6 patch 后**落盘对象**里：嵌套 border 三键 + 三个顶层废弃键都被剔除，其余原样；不改调用方对象', async () => {
    await inEmptyMem(async () => {
      const input = {
        highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000', defaultBorderColor: '#e6c300', defaultBorderWidth: '1px', defaultBorderRadius: 'iat::3px' },
        noteFormat: 'md', comboFlipped: true, pageCleanMinGap: 1500, keepMe: 'yes'
      };
      const safe = await S.patch(input);
      /* ① 落盘对象（不是 S.load() —— normalize 会顺手删掉，掩盖"写回过"） */
      deepEq(Object.keys(mem.highlightStyle).sort(), ['defaultBgColor', 'defaultTextColor'], '★ 落盘的 highlightStyle 只许剩两个键');
      falsy('noteFormat' in mem, '★ noteFormat 不许被写回');
      falsy('comboFlipped' in mem, '★ comboFlipped 不许被写回');
      falsy('pageCleanMinGap' in mem, '★ pageCleanMinGap 不许被写回');
      eq(mem.highlightStyle.defaultBgColor, '#ff9500', '保留的键值不许变形');
      eq(mem.keepMe, 'yes', '无关键照旧写盘');
      eq(safe.noteFormat, undefined, 'patch 的返回值同样不含废弃键');
      /* ② 调用方传进来的对象不许被就地改（实现做了浅拷贝） */
      truthy(input.highlightStyle.defaultBorderColor === '#e6c300', '★ 不许就地改调用方对象');
      truthy('noteFormat' in input, '调用方对象本身保持原样');
    });
  });

  await test('★ B6 边界：patch({}) 不新建对象；嵌套值不是普通对象时不崩、不新建、不丢原值', async () => {
    await inEmptyMem(async () => {
      const r = await S.patch({});
      deepEq(r, {}, 'patch({}) 应返回空对象');
      falsy('highlightStyle' in mem, '★ patch({}) 不许凭空新建 highlightStyle');
      eq(Object.keys(mem).length, 0, 'patch({}) 不该往存储里塞任何键');

      mem.highlightStyle = 'not-an-object';
      const r2 = await S.patch({ highlightStyle: 'not-an-object', noteFormat: 'md' });
      eq(mem.highlightStyle, 'not-an-object', '嵌套值不是对象时原样保留（不许新建、不许丢）');
      falsy('noteFormat' in mem, '顶层废弃键仍要被剔除');
      eq(r2.highlightStyle, 'not-an-object', '返回值一致');

      mem.highlightStyle = null;
      await S.patch({ highlightStyle: null });
      eq(mem.highlightStyle, null, 'null 也原样保留（不许变成 {}）');

      /* 数组同样不是"普通对象"：不许被改成对象 */
      mem.highlightStyle = ['a'];
      await S.patch({ highlightStyle: ['a'] });
      deepEq(mem.highlightStyle, ['a'], '数组原样保留');
    });
  });

  /* ==================================================================== B9 */

  suite('K72 复验 · B9 cellVerifyAxis 单一化（判重键 / CSV 第 18 列 / 保存 / 编译同一判据）');

  await test('★ B9 keyOf：老键 tb 与 comboAxis:tb 同键、与 lr 不同键；axisOf 优先级 tb', () => {
    const a = S.keyOf({ text: 'x', cellVerify: 't', cellVerifyAxis: 'tb' });
    const b = S.keyOf({ text: 'x', cellVerify: 't', comboAxis: 'tb' });
    const c = S.keyOf({ text: 'x', cellVerify: 't', comboAxis: 'lr' });
    const d = S.keyOf({ text: 'x', cellVerify: 't', cellVerifyAxis: 'lr', comboAxis: 'tb' });
    eq(a, b, '★ 老键 tb 与 comboAxis:tb 必须同键（旧实现会不同键）');
    truthy(a !== c, '★ tb 与 lr 必须不同键');
    eq(d, b, '两个键都在时 tb 优先（同一判据）');
    eq(S.axisOf({}), 'lr', '缺键 ⇒ lr');
    eq(S.axisOf(null), 'lr', 'null 也 ⇒ lr（不崩）');
    eq(S.axisOf({ cellVerifyAxis: 'tb', comboAxis: 'lr' }), 'tb', '老键 tb 优先于新键 lr');
    /* 判重函数也走同一判据：不同方向的同名词不算重复 */
    const list = [{ text: 'x', cellVerify: 't', comboAxis: 'tb' }];
    truthy(S.findDup(list, { text: 'x', cellVerify: 't', comboAxis: 'tb' }), '同方向 ⇒ 判重命中');
    falsy(S.findDup(list, { text: 'x', cellVerify: 't', comboAxis: 'lr' }), '不同方向 ⇒ 不算重复');
    truthy(S.findDup(list, { text: 'x', cellVerify: 't', cellVerifyAxis: 'tb' }), '老键 tb 也要判成重复');
  });

  await test('★ B9 CSV 第 18 列：**直测 rowValues 原语**（老键 tb 进必须 tb 出）+ exportCSV 同判', () => {
    /* 直测原语：B5 的导出归一会补齐 comboAxis，只测 exportCSV 会掩盖 rowValues 自己认不认老键 */
    const oldOnly = { text: 'x', cellVerify: 't', cellVerifyEnabled: true, cellVerifyAxis: 'tb' };
    eq(S.rowValues(oldOnly, new Map())[17], 'tb', '★ rowValues 必须认老键 cellVerifyAxis');
    eq(S.rowValues({ text: 'x', comboAxis: 'lr' }, new Map())[17], 'lr', '新键 lr 照旧');
    eq(S.rowValues({ text: 'x', cellVerifyAxis: 'lr', comboAxis: 'tb' }, new Map())[17], 'tb', '两键都在 ⇒ tb 优先');
    eq(S.rowValues({}, new Map())[17], 'lr', '缺键 ⇒ lr');

    const csv = S.exportCSV({ keywords: [oldOnly], groups: [] });
    const recs = S.parseCSV(csv);
    eq(recs[1][17], 'tb', '★ exportCSV 第 18 列也必须是 tb');
    /* 老 CSV（17 列）导入后方向按 lr（缺列），既有口径不变 */
    const back17 = S.parseCSV('\uFEFF' + S.CSV_HEADERS.slice(0, 17).join(',') + '\r\n' + S.rowValues({ text: 'y' }, new Map()).slice(0, 17).join(','));
    eq(back17[1].length, 17, '旧文件解析正常');
  });

  await test('★ B9 保存归一：upsertKeyword 之后仍是 tb（落在了哪个键上都要能读出来）', async () => {
    await inMem(async () => {
      mem.keywords = []; mem.groups = [];
      const saved = await S.upsertKeyword({ id: 'r4-axis', text: '轴词', cellVerifyEnabled: true, cellVerify: '表头', cellVerifyAxis: 'tb', fetchLabels: '' }, CFG);
      eq(S.axisOf(saved), 'tb', '★ 保存后方向仍是 tb');
      eq(saved.comboAxis, 'tb', '归一写成 comboAxis（§四.3 允许的等价迁移）');
      const loaded = (await S.load()).keywords.find((k) => k.id === 'r4-axis');
      eq(S.axisOf(loaded), 'tb', '★ 重新读出来仍是 tb');
      eq(S.keyOf(loaded), S.keyOf({ text: '轴词', cellVerify: '表头', comboAxis: 'tb' }), '与 tb 同键');
      const csv = S.exportCSV({ keywords: [loaded], groups: [] });
      eq(S.parseCSV(csv)[1][17], 'tb', 'CSV 第 18 列仍是 tb');
    });
  });

  await test('★ B9 单一真源：combo.js 只转发 Store.axisOf（运行期哨兵证明，不是看注释）', () => {
    const saved = S.axisOf;
    try {
      S.axisOf = () => 'tb';
      const rule = KH.Compiler.dispatch({
        id: 'r4-sentinel', text: '核心', cellVerifyEnabled: true, cellVerify: '标题',
        comboAxis: 'lr', cellVerifyMatchMode: 'include'
      }, CFG);
      truthy(rule, '组合词应能编译');
      eq(rule.meta.axis, 'tb', '★ 把 Store.axisOf 换成哨兵后编译结果跟着变 ⇒ combo.js 没有自己的第二份判据');
      eq(rule.kind, 'combo-tb', 'kind 也按同一判据推导');
    } finally {
      S.axisOf = saved;
    }
    /* 复位检查 */
    const back = KH.Compiler.dispatch({ id: 'r4-s', text: '核心', cellVerifyEnabled: true, cellVerify: '标题', comboAxis: 'lr', cellVerifyMatchMode: 'include' }, CFG);
    eq(back.meta.axis, 'lr', '哨兵已复位（否则后续用例会被污染）');
    /* 源码佐证：combo.js 里不再有第二份判据 */
    const combo = readSrc('src/features/combo/combo.js');
    truthy(combo.indexOf('KH.Store.axisOf') >= 0, 'combo.js 必须转发 Store.axisOf');
    const localCrit = combo.match(/cellVerifyAxis\s*===\s*'tb'/g) || [];
    deepEq(localCrit, [], '★ combo.js 里不许再有自己那份 cellVerifyAxis 判据');
  });

  /* ===================================================== A4 / B7 / B8 */

  suite('K72 复验 · A4 / B7 / B8 文档与文案');

  await test('★ A4：契约 §八 与 _memory/STATUS.md 都登记了"2.0.0 汇总说明必须含两处默认值变化"', () => {
    const contract = path.join(OUTSIDE, '_stage', 'tasks', '2026-09-22-K72-升级兼容与文案收口.md');
    const status = path.join(OUTSIDE, '_memory', 'STATUS.md');
    if (skipIf(!fs.existsSync(contract) || !fs.existsSync(status), 'A4 文档登记', '_stage/_memory 不在当前工作区（打包副本）')) return;
    const c = fs.readFileSync(contract, 'utf8');
    truthy(c.indexOf('2.0.0 发版前必办') >= 0, '契约必须有「2.0.0 发版前必办」小节');
    truthy(/「变更处理方式」默认「智能」/.test(c), '契约必须登记"变更处理方式默认智能"');
    truthy(/「分页点击捕获」默认关/.test(c), '契约必须登记"分页点击捕获默认关"');
    const s = fs.readFileSync(status, 'utf8');
    truthy(/2\.0\.0/.test(s) && /汇总/.test(s), 'STATUS 必须有 2.0.0 汇总说明的登记');
    truthy(/「变更处理方式」默认「智能」/.test(s), 'STATUS 必须写明变更处理方式默认值变化');
    truthy(/「分页点击捕获」默认关/.test(s), 'STATUS 必须写明分页点击捕获默认值变化');
  });

  await test('★ B7：BROWSER-CHECKLIST A9 的新期望写清了"实测 547 → 441 + 整框居中整体平移 + 相对关系不变"', () => {
    const md = readSrc('tests/BROWSER-CHECKLIST.md');
    const i = md.indexOf('A9（K13 回归项');
    truthy(i >= 0, '应能找到 A9 那条');
    const block = md.slice(i, i + 900);
    truthy(block.indexOf('547') >= 0 && block.indexOf('441') >= 0, '★ 必须附实测 547 → 441');
    truthy(/居中/.test(block), '★ 必须写清"整框垂直居中导致整体平移"');
    truthy(/折叠只改变弹窗总高（内容自适应）与各卡片的绝对位置/.test(block), '★ 新期望句必须在（活口径）');
    truthy(/列内相对顺序/.test(block) && /相邻关系不得变化/.test(block), '★ 必须写清"列内相对顺序/相邻关系不变"');
    truthy(/三列底边必须齐平/.test(block), '既有"三列底边齐平"口径不许被改掉');
    /* 旧期望允许被**引用**，但必须明确标注作废（否则下一个人照它判错）—— 这比"字符串不许出现"更准 */
    truthy(block.indexOf('旧期望') >= 0 && block.indexOf('已作废') >= 0,
      '★ 被引用的旧期望必须明确标注"旧期望…已作废"');
    /* 侧边栏 7 项那条也要与实测一致（B8-11） */
    truthy(/侧边栏是 \*\*7 项\*\*/.test(md), 'A22 应写成 7 项');
  });

  await test('★ B8 11 条：逐条旧串消失 / 新串存在（含 popup 920×500、welcome 全局、checklist 三项）', () => {
    const optHtml = readSrc('options/options.html');
    const optJs = readSrc('options/options.js');
    const popupJs = readSrc('popup/popup.js');
    const editorHtml = readSrc('popup/editor.html');
    const welcome = readSrc('welcome/welcome.html');
    const changelog = readSrc('src/ui/changelog.js');
    const readme = readSrc('README.md');
    const checklist = readSrc('tests/BROWSER-CHECKLIST.md');

    /* 1 统计那条 */
    falsy(optHtml.indexOf('统计数据仅记录命中数量和网站域名') >= 0, 'B8-1 旧句必须消失');
    truthy(optHtml.indexOf('不记录、不上传任何浏览数据') >= 0, 'B8-1 新句应在（隐私承诺）');
    /* 2/3 仅组合词口径 */
    falsy(optJs.indexOf('仅组合词') >= 0, 'B8-2/3 options.js 里不该再有「仅组合词」');
    truthy(optJs.indexOf('标题词（需勾选「单元格组合」）') >= 0, 'B8-2 表格分组标题应改口径');
    truthy(optJs.indexOf('需勾选「单元格组合」，在弹窗中勾选') >= 0, 'B8-3 tooltip 应改口径');
    /* 4 复用高亮底色（options.html 那处） */
    falsy(optHtml.indexOf('复用高亮底色') >= 0, 'B8-4 options.html 里不该再有「复用高亮底色」');
    /* 5 尺寸标签 */
    falsy(optHtml.indexOf('重要笔记图片尺寸') >= 0, 'B8-5 options.html 旧标签必须消失');
    truthy(optHtml.indexOf('重要笔记图片「尺寸」默认值') >= 0, 'B8-5 options.html 新标签应在');
    falsy(readme.indexOf('配色与图片尺寸') >= 0, 'B8-5 README 旧串必须消失');
    truthy(readme.indexOf('分组可统一配色与尺寸') >= 0, 'B8-5 README 新串应在');
    /* 6 死文案 */
    falsy(optJs.indexOf('高精度语言包还没随站点提供') >= 0, 'B8-6 死文案必须消失');
    truthy(optJs.indexOf('本机还没有高精度语言包') >= 0, 'B8-6 新文案应在');
    /* 7 changelog 加注（唯一允许动的历史条目） */
    truthy(changelog.indexOf('该包随后已一并托管') >= 0, 'B8-7 必须加注「该包随后已一并托管」');
    truthy(changelog.indexOf('英文高精度包还在下载') >= 0, 'B8-7 选的是"加注"，原文按历史保留');
    /* 8 档位 toast */
    falsy(optJs.indexOf('语言包按这一档单独下载') >= 0, 'B8-8 旧句必须消失');
    truthy(optJs.indexOf('语言包按这一档单独保存') >= 0, 'B8-8 新句应在');
    /* 9 快捷键 */
    falsy(welcome.indexOf('恢复本页高亮') >= 0, 'B8-9 旧说法「恢复本页高亮」必须消失');
    falsy(welcome.indexOf('恢复**本页**高亮') >= 0, 'B8-9 旧说法（加粗版）必须消失');
    truthy(/恢复<strong>全局<\/strong>高亮/.test(welcome), 'B8-9 应写"全局"高亮');
    /* 10 窗口尺寸 */
    falsy(popupJs.indexOf('920×660') >= 0, 'B8-10 popup.js 旧尺寸必须消失');
    falsy(editorHtml.indexOf('920×660') >= 0, 'B8-10 editor.html 旧尺寸必须消失');
    truthy(popupJs.indexOf('920×500') >= 0 && editorHtml.indexOf('920×500') >= 0, 'B8-10 两处都应是 920×500');
    /* 11 检查清单三项 */
    truthy(checklist.indexOf('**有命中自动展开**') >= 0, 'B8-11 图片命中分区＝有命中自动展开');
    truthy(/侧边栏是 \*\*7 项\*\*/.test(checklist), 'B8-11 侧边栏＝7 项');
    truthy(checklist.indexOf('CSV 不含「抓取后续字段」的模块开关') >= 0, 'B8-11 CSV 节要补开关说明');
    /* R0 冻结后自己动的两处，也一并钉住 */
    truthy(checklist.indexOf('920×500') >= 0, 'R0 修的那处独立窗口尺寸＝920×500');
    truthy(checklist.indexOf('共 **11** 个按钮') >= 0, 'R0 修的那处＝11 个按钮（分区折叠头那颗要保持可用）');
  });
};
