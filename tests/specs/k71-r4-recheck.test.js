/* tests/specs/k71-r4-recheck.test.js — K71 返工后的 **R4 独立复验**（红队口径：只看自己跑出来的结果）
 * ----------------------------------------------------------------------------
 * R0 裁定 3/4 的复验 + 我自己的等价但独立写法（与 R3 的 k71-fetch-enabled.test.js 互不替代）：
 *   ① 裁定 4：`fetchEnabled` 的脏值归一必须**只有一个函数**、两路逐项相同、双向幂等；
 *      `undefined`（缺键）按非空 `fetchLabels` 反推；显式 `false` 任何路径都不许翻回 true。
 *   ② 裁定 3：CSV 仍 18 列、导出无该键、导入后＝反推值（已知且有意）；JSON 导出带 `false` 且往返保住。
 *   ③ 裁定 2：卡片正文按模块归属（本词半边乘 `important`），**分组级三处一字不动**。
 *   ④ 编译层的门 `kw.fetchEnabled !== false` **没被动过**（缺键的手写对象照旧抓取）。
 *
 * 反向验证（R4 自跑）：把 `resolveVisual()` 里三处 `kw.important` 摘掉 →
 *   本文件的《③ 卡片正文按模块归属》必须变红；把共用函数换成第二份拷贝 →
 *   《① 脏值真值表》必须变红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compiler;
  const S = KH.Store;
  const Config = KH.Config;
  const FM = KH.FieldMap;

  const CFG = {
    keywords: [], groups: [],
    highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
    matchSettings: {}
  };

  /* ==================================================== ① 裁定 4：脏值归一 */

  suite('K71 返工复验 · 裁定 4：fetchEnabled 脏值 —— 一个函数、两路同判、双向幂等');

  const TABLE = [true, false, undefined, null, 0, '', '0', 'false', 1, 'true'];

  await test('★ 真值表 10 个值：读路径与写路径逐项相同，且都等于裁定口径（缺键反推 / 键存在 !!v）', async () => {
    const rows = [];
    for (const v of TABLE) {
      const kw = { id: 'r4', text: 'x', fetchLabels: '甲' };
      if (v !== undefined) kw.fetchEnabled = v;
      const w = S.sanitizeKeyword(Object.assign({}, kw), {});
      const r = Config.normalize({ keywords: [Object.assign({}, kw)] }).config.keywords[0];
      const want = (v === undefined) ? true : !!v;
      rows.push({ v: v, write: w.fetchEnabled, read: r.fetchEnabled, want: want });
      eq(w.fetchEnabled, r.fetchEnabled, '两路必须同判（v=' + JSON.stringify(v) + '）：写=' + w.fetchEnabled + ' 读=' + r.fetchEnabled);
      eq(w.fetchEnabled, want, '真值表（v=' + JSON.stringify(v) + '）应为 ' + want);
      /* 反向的靶心：显式 false（以及其它 falsy）绝不许被"反推"打开 */
      if (v !== undefined && !v) {
        eq(w.fetchEnabled, false, '★ 键存在且 falsy（' + JSON.stringify(v) + '）→ 必须当"关"，不许翻回 true');
        eq(r.fetchEnabled, false, '★ 读路径同样不许翻回 true（' + JSON.stringify(v) + '）');
      }
      /* 内容保留：两路都不许动 fetchLabels */
      eq(w.fetchLabels, '甲', '写路径不许清空 fetchLabels（v=' + JSON.stringify(v) + '）');
      eq(r.fetchLabels, '甲', '读路径不许清空 fetchLabels（v=' + JSON.stringify(v) + '）');
    }
    console.log('        真值表: ' + JSON.stringify(rows));
  });

  await test('★ 双向幂等：normalize(sanitize(x)) ≡ sanitize(x)，sanitize(normalize(x)) ≡ normalize(x)', () => {
    for (const v of TABLE) {
      const kw = { id: 'r4', text: 'x', fetchLabels: '甲' };
      if (v !== undefined) kw.fetchEnabled = v;
      const w = S.sanitizeKeyword(Object.assign({}, kw), {});
      const r = Config.normalize({ keywords: [Object.assign({}, kw)] }).config.keywords[0];
      /* 再走一遍对方那一路 */
      const w2 = S.sanitizeKeyword(Object.assign({}, kw, { fetchEnabled: r.fetchEnabled }), {});
      const r2 = Config.normalize({ keywords: [Object.assign({}, kw, { fetchEnabled: w.fetchEnabled })] }).config.keywords[0];
      eq(w2.fetchEnabled, r.fetchEnabled, 'sanitize(normalize(x)) 幂等（v=' + JSON.stringify(v) + '）');
      eq(r2.fetchEnabled, w.fetchEnabled, 'normalize(sanitize(x)) 幂等（v=' + JSON.stringify(v) + '）');
      /* 第三遍：连续归一不许再变 */
      const r3 = Config.normalize({ keywords: [Object.assign({}, kw, { fetchEnabled: r2.fetchEnabled })] }).config.keywords[0];
      eq(r3.fetchEnabled, r2.fetchEnabled, '连续两次 normalize 必须稳定（v=' + JSON.stringify(v) + '）');
    }
  });

  await test('★ “同一个函数”证据链：写路径运行期查表到 Config.normalizeFetchEnabled；读路径没有第二份拷贝', () => {
    const root = path.join(__dirname, '..', '..');
    const cfgSrc = fs.readFileSync(path.join(root, 'src/core/config.js'), 'utf8');
    const storeSrc = fs.readFileSync(path.join(root, 'src/platform/storage.js'), 'utf8');

    /* (a) 定义只有一处 */
    const defs = (cfgSrc.match(/function\s+normalizeFetchEnabled\s*\(/g) || []).length;
    eq(defs, 1, '★ config.js 里 `normalizeFetchEnabled` 只许有一处定义，实际 ' + defs);
    truthy(/normalizeFetchEnabled\s*,/.test(cfgSrc), '它必须被挂到 Config 上（导出的就是那一个标识符）');
    /* (b) storage.js 里没有第二份实现（既没有内联三元，也没有自己的函数定义） */
    falsy(/function\s+normalizeFetchEnabled/.test(storeSrc), '★ storage.js 不许再定义一份');
    falsy(/fetchEnabled\s*:\s*\(?\s*f\.fetchEnabled\s*===/.test(storeSrc),
      '★ storage.js 不许再写"自己那份"缺键三元（那正是两路分叉的来源）');
    truthy(/fetchEnabled:\s*KH\.Config\.normalizeFetchEnabled\(/.test(storeSrc),
      '★ storage.js 的写路径必须运行期调用 KH.Config.normalizeFetchEnabled');

    /* (c) 行为级：把导出换成一个哨兵 → 写路径必须立刻改用它（＝运行期查表，不是拷贝） */
    const saved = Config.normalizeFetchEnabled;
    try {
      Config.normalizeFetchEnabled = () => 'R4-SPY';
      const w = S.sanitizeKeyword({ text: 'x', fetchLabels: '甲', fetchEnabled: null }, {});
      eq(w.fetchEnabled, 'R4-SPY', '★ 写路径必须走 Config.normalizeFetchEnabled（替换后立刻生效）');
      /* 读路径用的是文件内那一个函数（同一个标识符导出的），替换导出不该影响它 —— 这正是"一个函数"的形态 */
      const r = Config.normalize({ keywords: [{ id: 'r4', text: 'x', fetchLabels: '甲', fetchEnabled: null }] }).config.keywords[0];
      eq(r.fetchEnabled, false, '读路径仍按真值表归一（null → false），不受"替换导出"影响');
    } finally {
      Config.normalizeFetchEnabled = saved;      // 共享内核，必须还原
    }
    eq(Config.normalizeFetchEnabled(null, '甲'), false, '还原检查：函数已复位');
  });

  /* ==================================================== ② 裁定 3：CSV / JSON */

  suite('K71 返工复验 · 裁定 3：CSV 不带开关（已知且有意）、JSON 保真');

  await test('★ CSV 仍 18 列且导出无该键；导入后 fetchEnabled ＝按非空 fetchLabels 反推；JSON 带 false 且往返保住', async () => {
    eq(S.CSV_HEADERS.length, 18, 'CSV 契约仍是 18 列');
    const kw = S.sanitizeKeyword({ text: 'R4复验CSV词', fetchLabels: '甲字段', fetchEnabled: false }, {});
    eq(kw.fetchEnabled, false, '前置：这条词的开关是关的');

    const csv = S.exportCSV({ keywords: [kw], groups: [] });
    const header = csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
    eq(header.split(',').length, 18, 'CSV 表头必须仍是 18 列');
    falsy(/fetchEnabled/.test(csv), '★ CSV 里不许出现 fetchEnabled 这个键（新键 csv:0）');

    const stats = await S.importCSV(csv, { keywords: [], groups: [] });
    eq(stats.added, 1, '应导入 1 条');
    const back = await S.load();
    const k = (back.keywords || []).find((x) => x.text === 'R4复验CSV词');
    truthy(k, '导入后应能读回');
    eq(k.fetchLabels, '甲字段', '字段本身保真');
    eq(k.fetchEnabled, true, '★ CSV 往返后＝按非空 fetchLabels 反推（true）—— 这是裁定 3 明确"已知且有意"的口径');

    /* JSON：保真通道 */
    const json = S.exportJSON(null, { keywords: [kw], groups: [] });
    truthy(/"fetchEnabled": false/.test(json), '★ JSON 导出必须带 false');
    const parsed = JSON.parse(json).keywords[0];
    eq(S.sanitizeKeyword(parsed, {}).fetchEnabled, false, '★ JSON 往返必须保住 false（不被反推覆盖）');

    /* 零污染 */
    await S.removeKeywords((back.keywords || []).filter((x) => x.text === 'R4复验CSV词').map((x) => x.id));
    const after = await S.load();
    falsy((after.keywords || []).some((x) => x.text === 'R4复验CSV词'), '★ 用例零污染');
  });

  /* ============================================ ③ 裁定 2：卡片正文按模块归属 */

  suite('K71 返工复验 · 裁定 2：正文按模块归属，分组级三处一字不动');

  await test('★ imp 关 + 抓取开：卡片在、抓取值在，但 importantNote / impNoteBg / imgSize 三项都不出（本词半边受门约束）', () => {
    const base = {
      id: 'r4b', text: '甲', note: '', groupId: null, enabled: true,
      caseSensitive: false, wholeWord: false, useRegex: false, bgColor: '', textColor: '',
      importantNote: 'R4本词正文', impNoteUseHlColor: true, imgSize: 40,
      cellVerifyEnabled: false, fetchLabels: '备注'
    };
    const off = C.dispatch(Object.assign({}, base, { important: false, fetchEnabled: true }), CFG);
    truthy(off, '普通词应能编译');
    eq(!!off.meta.important, true, '卡片存在性＝important || wantFetch（抓取开着 → 仍在面板里）');
    eq(off.meta.fetchLabels, '备注', '抓取值照旧出（抓取模块管）');
    eq(off.meta.importantNote, '', '★ 本词正文不许进 meta');
    eq(off.meta.impNoteBg, '', '★ 本词复用底色不许进 meta');
    eq(off.meta.imgSize, '', '★ 本词图片尺寸不许进 meta');

    const on = C.dispatch(Object.assign({}, base, { important: true, fetchEnabled: true }), CFG);
    eq(on.meta.importantNote, 'R4本词正文', '勾了 → 与现状一致');
    eq(on.meta.impNoteBg, '#ff9500', '勾了 → 复用底色照旧');
    eq(on.meta.imgSize, 40, '勾了 → 尺寸照旧');

    const none = C.dispatch(Object.assign({}, base, { important: false, fetchEnabled: false }), CFG);
    eq(!!none.meta.important, false, '两个模块都关 → 卡片不存在');
    eq(none.meta.fetchLabels, '', '抓取字段归一成空串');
  });

  await test('★ 分组级三处一字不动：分组 important 的笔记 / 复用底色 / 尺寸照旧生效（kw 半边被门挡住时落回分组）', () => {
    /* 分组的三个值都非空：本词半边被 `kw.important` 挡住后，**三项都必须落回分组** */
    const cfg2 = {
      groups: [{ id: 'g9', name: '组九', bgColor: '#112233', textColor: '#eeeeee', important: true, importantNote: 'R4组笔记', impNoteUseHlColor: true, imgSize: 88 }],
      highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' }
    };
    const v = C.resolveVisual({ groupId: 'g9', important: false, importantNote: '本词的', impNoteUseHlColor: true, imgSize: 40 }, cfg2);
    eq(v.meta.importantNote, 'R4组笔记', '★ 分组笔记照旧（本词半边不参与 → 落回分组）');
    eq(v.meta.impNoteBg, '#112233', '★ 分组复用底色照旧');
    eq(v.meta.imgSize, 88, '★ 分组尺寸照旧');
    eq(!!v.meta.important, true, '分组重要 ⇒ 词也重要（分组级口径未动）');

    /* 对照：词自己勾了 → 本词的值优先（ownNote || groupNote / kw 半边 || 分组半边 的既有优先级） */
    const v2 = C.resolveVisual({ groupId: 'g9', important: true, importantNote: '本词的', impNoteUseHlColor: false, imgSize: 40 }, cfg2);
    eq(v2.meta.importantNote, '本词的', '词自己勾了 → 本词笔记优先');
    eq(v2.meta.imgSize, 40, '词自己有尺寸 → 不取分组的');
    eq(v2.meta.impNoteBg, '#112233', '复用底色的分组半边照旧（分组自己勾了复用）');
    /* 另一条：词自己勾 & 自己勾复用 → 复用照旧生效（不被返工误伤） */
    const v3 = C.resolveVisual({ groupId: 'g9', important: true, importantNote: '', impNoteUseHlColor: true, imgSize: '' }, cfg2);
    eq(v3.meta.impNoteBg, '#112233', '词自己勾复用 → 照旧铺底色');
    eq(v3.meta.importantNote, 'R4组笔记', '本词笔记为空 → 仍落回分组笔记');
  });

  /* ==================================================== ④ 编译层的门没被动过 */

  suite('K71 返工复验 · 编译层的门未被动过（缺键＝照旧抓取）');

  await test('★ 缺键手写对象仍必须抓取；显式 false 才停抓；顺序/假值语义逐条一致', () => {
    const miss = C.dispatch({ id: 'r4g', text: '甲', fetchLabels: '备注' }, CFG);
    eq(miss.meta.fetchLabels, '备注', '★ 缺键（手写对象 / 未迁移导入）必须照旧抓取');
    eq(!!miss.meta.important, true, '缺键时照旧进面板');
    const off = C.dispatch({ id: 'r4g', text: '甲', fetchLabels: '备注', fetchEnabled: false }, CFG);
    eq(off.meta.fetchLabels, '', '显式 false → 归一成空串');
    eq(!!off.meta.important, false, '显式 false → 不因抓取进面板');
    const on = C.dispatch({ id: 'r4g', text: '甲', fetchLabels: '备注', fetchEnabled: true }, CFG);
    eq(on.meta.fetchLabels, '备注', '显式 true → 照旧');
    /* 组合词路径同口径 */
    const cb = { id: 'r4c', text: '甲', cellVerifyEnabled: true, cellVerify: '表头', comboAxis: 'lr', cellVerifyMatchMode: 'include', fetchLabels: '备注' };
    eq(C.dispatch(Object.assign({}, cb), CFG).meta.fetchLabels, '备注', '组合词缺键照旧');
    eq(C.dispatch(Object.assign({}, cb, { fetchEnabled: false }), CFG).meta.fetchLabels, '', '组合词显式 false 停抓');
  });

  await test('★ C11 护栏：CSV 18 列表头 / 四个模块标题 / 分组弹窗「重要」/ 分区清单一律未动', () => {
    eq(S.CSV_HEADERS.length, 18, 'CSV 仍 18 列');
    eq(S.CSV_HEADERS[16], '抓取后续字段', '第 17 列表头未动');
    eq(FM.FORM_SECTIONS.map((s) => s.title).join('/'), '基本信息/单元格组合/抓取后续字段/重要笔记', '四个模块标题逐字未动');
    eq(FM.GROUP_FIELDS.find((f) => f.key === 'important').label, '重要', '分组弹窗的「重要」是另一张表');
    eq(FM.fieldsOf('fetch')[0].key, 'fetchLabels', 'fetch 分区第一项仍是输入框');
    eq(FM.byKey('fetchEnabled').csv, 0, '新键不进 CSV');
    falsy(FM.csvColumns().filter(Boolean).some((f) => f.key === 'fetchEnabled'), 'fetchEnabled 不占 CSV 列');
  });
};
