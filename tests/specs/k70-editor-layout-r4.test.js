/* tests/specs/k70-editor-layout-r4.test.js — **R4 独立验收（红队）** 的清单层复核
 * ----------------------------------------------------------------------------
 * 为什么单独一份，而不是塞进 storage.test.js 的 K70 套件：
 *   契约 §三 规定 R4 只能写测试。把复核用例独立成文件，是为了让"谁的结论"一目了然 ——
 *   R3 自述里的数字**不算证据**，R4 的数字只能来自 R4 自己跑的用例（含反向验证）。
 *
 * 这一份刻意换角度，不复述 R3 已写过的断言：
 *   · R3 断言 `label === '启用'` / `head === true`（逐字段列举）→ 这里断言**形态声明逐项同形**
 *     （除 key/sec/csv/def/hint 这些"身份"外，label/chip/head/type/width/newRow… 全部 deepEqual），
 *     任何"只改了其中一颗"的偏移都会当场变红；并反向禁止 head 字段带 width:2 / newRow
 *     （那两个会让标题行插槽被挤坏）。
 *   · R3 断言 combo 里没有 imgOcr* → 这里断言三个 key 在**全表里只声明一次**（重复声明＝弹窗里两颗）
 *     且 fetch 分区内顺序 **必须** 在 fetchLabels 之后。
 *   · R3 查的是 DOM 值 → 这里查**映射层/清洗层**：取消勾选不许清空 imgOcrKeyword（弹窗 DOM 之外的那一层）。
 *
 * @see _stage/tasks/2026-09-21-K70-关键词编辑器布局调整.md §四 §五
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy, deepEq } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const FM = KH.FieldMap;
  const S = KH.Store;

  suite('R4 · K70 清单层独立复核（胶囊统一「启用」+ 图片识别控件归「抓取后续字段」）');

  await test('★ R4-1：四颗胶囊**形态声明逐项同形**（除身份字段 key/sec/csv/def/hint），且不许带 width:2 / newRow', () => {
    const IDENTITY = ['key', 'sec', 'csv', 'def', 'hint'];
    const shape = (k) => {
      const f = FM.byKey(k);
      truthy(f, '字段表必须有 ' + k);
      const o = {};
      for (const p of Object.keys(f)) if (IDENTITY.indexOf(p) < 0) o[p] = f[p];
      return o;
    };
    const ref = shape('enabled');            // 参照物：「基本信息」那颗（位置与文案本来就不变）
    /* K71 起是**四颗**：抓取模块那颗（fetchEnabled）与另三颗必须逐项同形 */
    for (const k of ['cellVerifyEnabled', 'fetchEnabled', 'important']) {
      const diff = Object.keys(ref).filter((p) => JSON.stringify(shape(k)[p]) !== JSON.stringify(ref[p]));
      deepEq(shape(k), ref, '★ ' + k + ' 的形态声明必须与参照物 enabled 逐项相同，差异：' + JSON.stringify(diff));
    }
    for (const k of ['enabled', 'cellVerifyEnabled', 'fetchEnabled', 'important']) {
      const f = FM.byKey(k);
      eq(f.label, '启用', k + ' 的显示文案必须是「启用」');
      eq(f.chip, true, k + ' 必须是胶囊形态');
      eq(f.head, true, k + ' 必须 head:true（＝渲染到模块标题行右侧，这是"右上角"的唯一实现）');
      eq(f.type, 'bool', k + ' 必须仍是 bool（存储/判定逻辑不许动）');
      eq(f.width, undefined, k + ' 不许带 width:2（会把标题行插槽撑坏）');
      eq(f.newRow, undefined, k + ' 不许带 newRow（head 字段不参与正文分行）');
      eq(f.sepBefore, undefined, k + ' 不许带 sepBefore（head 字段不参与胶囊行分隔）');
    }
  });

  await test('★ R4-2：旧文案「启用组合 / 重要」在**关键词字段表**里彻底消失；CSV 与分组弹窗不许被连带改', () => {
    const bad = FM.KEYWORD_FIELDS
      .filter((f) => f.label === '启用组合' || f.label === '重要')
      .map((f) => f.key + '=' + f.label);
    eq(bad.join('/'), '', '关键词字段表里不该再有旧文案，实际 ' + JSON.stringify(bad));
    // 反向护栏：这次只改"弹窗胶囊的显示文案"，两份下游契约不许动
    eq(S.CSV_HEADERS.length, 18, 'CSV 仍是 18 列');
    eq(S.CSV_HEADERS[3], '启用', 'CSV 第 4 列（关键词自身的启用开关）表头未动');
    eq(S.CSV_HEADERS[9], '重要', '★ CSV 第 10 列表头仍是「重要」—— 改的只是弹窗胶囊显示文案');
    eq(S.CSV_HEADERS[11], '单元格组合', 'CSV 第 12 列表头未动');
    eq(S.CSV_HEADERS[16], '抓取后续字段', 'CSV 第 17 列表头未动');
    eq(FM.GROUP_FIELDS.find((f) => f.key === 'important').label, '重要',
      '分组编辑弹窗的「重要」是**另一张字段表**，不在本次口径内（不许被一起改掉）');
  });

  await test('★ R4-3：图片识别三控件**全表只声明一次**且只在 fetch，顺序在 fetchLabels 之后，身份未动', () => {
    const seen = {};
    for (const f of FM.KEYWORD_FIELDS) (seen[f.key] = seen[f.key] || []).push(f.sec);
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      deepEq(seen[k], ['fetch'], k + ' 必须**只**声明一次且挂在 fetch（重复声明＝弹窗里出现两颗），实际 ' + JSON.stringify(seen[k]));
    }
    const comboKeys = FM.fieldsOf('combo').map((f) => f.key);
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      falsy(comboKeys.indexOf(k) >= 0, '「单元格组合」里不该再有 ' + k + '，实际 ' + JSON.stringify(comboKeys));
    }
    const fetchKeys = FM.fieldsOf('fetch').map((f) => f.key);
    eq(fetchKeys[0], 'fetchLabels', 'fetch 分区第一个字段必须是「抓取后续字段」输入框，实际 ' + JSON.stringify(fetchKeys));
    for (const k of ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']) {
      truthy(fetchKeys.indexOf(k) > fetchKeys.indexOf('fetchLabels'),
        k + ' 的声明顺序必须在 fetchLabels **之后**（＝渲染在它下方），实际 ' + JSON.stringify(fetchKeys));
    }
    const ident = ['imgOcr', 'imgOcrKeyword', 'imgOcrMax']
      .map((k) => { const f = FM.byKey(k); return k + ':' + f.type + ':' + f.csv; }).join('/');
    eq(ident, 'imgOcr:bool:0/imgOcrKeyword:text:0/imgOcrMax:int:0',
      '三个控件的类型与 CSV 列号（0＝不参与 CSV）必须未动，实际 ' + ident);
  });

  await test('★ R4-4：往返 + **取消勾选不清空**（映射层与清洗层，不是只看弹窗 DOM）', () => {
    const cfg = KH.Config.defaults;
    const kw = Object.assign(FM.defaults(cfg), {
      text: '华为', fetchLabels: '应用截图', imgOcr: true, imgOcrKeyword: '一对一', imgOcrMax: 3
    });
    const rt = FM.roundTrip(kw, cfg);
    truthy(rt.ok, '表单 ⇄ 存储 往返必须一致：' + rt.diffs.join('、'));
    const stored = FM.toStore(kw, cfg);
    eq(stored.imgOcr, true, 'imgOcr 应落 true');
    eq(stored.imgOcrKeyword, '一对一', 'imgOcrKeyword 应落原值');
    eq(stored.imgOcrMax, 3, 'imgOcrMax 应落原值');
    // 取消勾选：只关开关，**不许**动已填文本（映射层）
    const offMap = FM.toStore(Object.assign({}, kw, { imgOcr: false }), cfg);
    eq(offMap.imgOcr, false, '取消勾选应落 false');
    eq(offMap.imgOcrKeyword, '一对一', '★ 取消勾选不许清空 imgOcrKeyword（映射层）');
    // 清洗层同理（存量脏配置兜底时也不许静默丢数据）
    const offClean = S.sanitizeKeyword(Object.assign({}, kw, { imgOcr: false }), cfg);
    eq(offClean.imgOcrKeyword, '一对一', '★ 清洗层不许把已填关键词抹掉（否则用户重勾时要重填）');
    eq(offClean.imgOcrMax, 3, '清洗层不许把「每处最多」抹掉');
  });

  await test('★ R4-5：保存闸 ocrGate 五条口径 + 分区清单/列归属未变', () => {
    const gate = KH.ui && KH.ui.KeywordEditor && KH.ui.KeywordEditor.ocrGate;
    truthy(typeof gate === 'function', '保存校验必须是可单测的纯判据（ui.KeywordEditor.ocrGate）');
    truthy(gate({ imgOcr: true, fetchLabels: '', imgOcrKeyword: 'x' }).indexOf('抓取后续字段') >= 0,
      '勾了却没抓取字段：必须拦住并指出「抓取后续字段」');
    truthy(gate({ imgOcr: true, fetchLabels: '   ', imgOcrKeyword: 'x' }).indexOf('抓取后续字段') >= 0,
      '全是空白也算没填（trim 口径）');
    truthy(gate({ imgOcr: true, fetchLabels: '甲', imgOcrKeyword: '   ' }).indexOf('图片命中关键词') >= 0,
      '关键词全是空白也算没填');
    eq(gate({ imgOcr: true, fetchLabels: '甲', imgOcrKeyword: '一对一' }), '', '都填了必须放行');
    eq(gate({ imgOcr: false, fetchLabels: '', imgOcrKeyword: '' }), '', '没勾选不校验（取消勾选不能报错）');
    eq(FM.FORM_SECTIONS.map((s) => s.id).join('/'), 'basic/combo/fetch/imp', '分区清单不许变');
    eq(FM.FORM_SECTIONS.map((s) => s.title).join('/'), '基本信息/单元格组合/抓取后续字段/重要笔记', '模块标题不许变');
    eq(FM.FORM_SECTIONS.map((s) => s.col).join('/'), '1/2/2/3', '列的归属不许被"搬家"顺手改掉');
    eq(FM.FORM_SECTIONS.length, 4, '不许新增/删除模块');
  });
};
