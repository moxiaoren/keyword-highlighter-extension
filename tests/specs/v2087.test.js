/* tests/specs/v2087.test.js — 2.0.8.7 的三条新口径
 * ----------------------------------------------------------------------------
 * ① 图文合并的**命中闸门**：只有「这个字段的图这次真的 OCR 命中」才出合并行
 *    （2.0.8.6 的旧口径只看配置里写没写这个字段名 ⇒ 图没认出来也照样出行，用户实测不符）；
 * ② AI 审核的本地词库初筛（免登录/免额度那一步）：品牌、敏感六大类、变体写法归一；
 * ③ 审核通道的配置归一（`aiAudit`）：凭据去空白、模型兜底、`localOnly` 只认真 true。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy, falsy, loadKernel } = H;

module.exports = async function run() {
  const KH = loadKernel(['src/features/ai-audit.js']);
  const C = KH.Config;
  const N = KH.ImportantNote;
  const A = KH.AiAudit;

  /* ================= ① 合并闸门 ================= */

  suite('2.0.8.7 需求①：图文合并只在「图这次真命中」时出行');

  await test('★ 配置里写了字段、但这次没有 OCR 条目 ⇒ hit=false', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => [];
    const rows = N.mergeRowsFor(
      { pinId: 'kw1', imgOcrNeed: '登记号' },
      { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著', hidden: true }] } }
    );
    eq(rows.length, 1, '配置命中（字段在 imgOcrNeed 里）仍然产出一行');
    eq(rows[0].hit, false, '但图没认出来 ⇒ hit 必须是 false，decorateMerge 会把它滤掉');
    eq(rows[0].title, '软著');
    eq(rows[0].hidden, true);
    KH.ImgOcr.items = items;
  });

  await test('★ 有该字段的 OCR 条目且动态值全在 ⇒ hit=true', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 2024SR001', need: ['登记号'], needMissingValues: [], matched: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1', imgOcrNeed: '登记号' }, '登记号'), true);
    KH.ImgOcr.items = items;
  });

  await test('★ 条目是别的规则 / 别的字段 / 没读完 ⇒ 一律不算命中', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'other', label: '登记号', state: 'done', text: 'x', need: ['登记号'], needMissingValues: [] },
      { ruleId: 'kw1', label: '开发者', state: 'done', text: 'x', need: ['登记号'], needMissingValues: [] },
      { ruleId: 'kw1', label: '登记号', state: 'pending', text: 'x', need: ['登记号'], needMissingValues: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '登记号'), false, '三条都不该算命中');
    KH.ImgOcr.items = items;
  });

  await test('★ 动态值缺一个 ⇒ 不算命中（与 judgeInfo 的且关系一致）', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '登记号', state: 'done', text: 'x', need: ['登记号'], needMissingValues: ['2024SR001'], matched: [] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '登记号'), false);
    KH.ImgOcr.items = items;
  });

  await test('★ 没配动态判据时看静态命中词（matched 非空才算）', () => {
    const items = KH.ImgOcr.items;
    KH.ImgOcr.items = () => ([
      { ruleId: 'kw1', label: '截图', state: 'done', text: 'x', need: [], matched: [] },
      { ruleId: 'kw1', label: '截图', state: 'done', text: 'x', need: [], matched: [{ text: '登记号' }] }
    ]);
    eq(N.ocrFieldHit({ pinId: 'kw1' }, '截图'), true, '第二条 static 命中了', false);
    KH.ImgOcr.items = items;
  });

  await test('没配图文合并 / 字段不在 imgOcrNeed 里 ⇒ 一行都不出', () => {
    eq(N.mergeRowsFor({ imgOcrNeed: '登记号' }, {}).length, 0);
    eq(N.mergeRowsFor({ imgOcrNeed: '' }, { imgMerge: { on: true, rows: [{ field: '登记号' }] } }).length, 0);
    eq(N.mergeRowsFor({ imgOcrNeed: '别的' }, { imgMerge: { on: true, rows: [{ field: '登记号' }] } }).length, 0);
  });

  /* ================= ② 本地初筛 ================= */

  suite('2.0.8.7 需求②：AI 审核的本地词库初筛（不联网、不花额度）');

  await test('★ 名称直接写敏感词 ⇒ risky（level 2）', () => {
    const r = A.screen('天天博彩');
    eq(r.level, 2);
    eq(r.verdict, 'risky');
    truthy(r.hits.some((h) => h.kind === 'sensitive' && h.tag === '赌博'), '应命中「赌博」类');
  });

  await test('★ 与知名品牌完全同名 ⇒ risky；只含品牌词 ⇒ suspect', () => {
    eq(A.screen('微信').level, 2);
    eq(A.screen('微信清理大师').level, 1);
    eq(A.screen('微信清理大师').verdict, 'suspect');
  });

  await test('★ 变体写法（空格/大小写/间隔号）也能认出来', () => {
    eq(A.screen('微 信').level, 2, '空格插字是常见规避手法');
    eq(A.screen('WeChat').level, 2);
    eq(A.screen('抖音·极速版').level, 1);
  });

  await test('★ 干净的名字 ⇒ safe（本地看不到问题，图标仍建议云端）', () => {
    const r = A.screen('省钱快报');
    eq(r.level, 0);
    eq(r.verdict, 'safe');
    eq(r.hits.length, 0);
  });

  await test('空名字不报错', () => {
    eq(A.screen('').level, 0);
    eq(A.screen(null).level, 0);
  });

  await test('★ 结论措辞：云端 risky 压过本地 safe；云端 suspect 说「需要人工复核」', () => {
    truthy(A.describe(A.screen('省钱快报'), { risk: 'risky', summary: '图标仿微信' }).indexOf('建议拒绝') === 0);
    truthy(A.describe(A.screen('省钱快报'), { risk: 'suspect', summary: '像某品牌' }).indexOf('需要人工复核') === 0);
    truthy(A.describe(A.screen('省钱快报'), { risk: 'safe', summary: '没发现' }).indexOf('通过') === 0);
    truthy(A.describe(A.screen('省钱快报'), null).indexOf('本地没发现问题') === 0);
  });

  /* ================= ③ 配置归一 ================= */

  suite('2.0.8.7 需求②：审核通道的配置归一（aiAudit）');

  await test('★ 默认：开、空凭据、模型兜底、不是只跑本地', () => {
    const a = C.normalizeAiAudit({});
    eq(a.enabled, true);
    eq(a.accountId, '');
    eq(a.token, '');
    eq(a.model, C.AI_AUDIT_MODEL_DEFAULT);
    eq(a.localOnly, false);
  });

  await test('★ 凭据去空白；localOnly 只认 true（"true" 字符串不算）', () => {
    const a = C.normalizeAiAudit({ accountId: '  abc123  ', token: ' t0k ', localOnly: 'true' });
    eq(a.accountId, 'abc123');
    eq(a.token, 't0k');
    eq(a.localOnly, false);
  });

  await test('★ 默认值表里带着它（否则读路径归一 / 导出清单检查都看不到这个键）', () => {
    truthy(Object.prototype.hasOwnProperty.call(C.defaults, 'aiAudit'));
    eq(C.defaults.aiAudit.model, C.AI_AUDIT_MODEL_DEFAULT);
  });

  await test('★ 预设模型清单里有默认模型（下拉框才不会选空）', () => {
    truthy(C.AI_AUDIT_MODEL_LIST.indexOf(C.AI_AUDIT_MODEL_DEFAULT) >= 0);
  });

  await test('归一幂等（再归一一次不产生变化）', () => {
    const a = C.normalizeAiAudit({ accountId: 'x', model: '@cf/meta/llama-4-scout-17b-16e-instruct' });
    eq(JSON.stringify(C.normalizeAiAudit(a)), JSON.stringify(a));
  });

  /* ================= ④ 审核入口搬进面板（2.0.8.7 追加项） ================= */

  suite('2.0.8.7：审核入口在面板 AI 页签（不再只藏在设置页）');

  await test('★ 协议里定义了 AI_AUDIT 消息名（面板与后台才是同一个入口）', () => {
    eq(KH.MSG.AI_AUDIT, 'kh:ai:audit');
  });

  await test('★ 面板上真的挂着审核那套方法（少一个就是死按钮）', () => {
    const P = N.panel;
    const need = ['toggleAudit', 'syncAuditBar', 'readAuditIcon', 'runAudit', 'formatAudit', 'pushAuditMsg'];
    for (let i = 0; i < need.length; i++) eq(typeof P[need[i]], 'function', 'panel.' + need[i]);
  });

  await test('★ 状态位有初始化（否则第一次展开读到 undefined）', () => {
    eq(N.panel.auditImage, '');
    eq(N.panel.auditBusy, false);
  });

  await test('★ formatAudit：云端品牌 / 敏感项拼进同一段，云端的风险等级压过本地', () => {
    const out = N.panel.formatAudit(A.screen('省钱快报'), {
      risk: 'risky',
      brands: [{ name: '微信', why: '图标高度相似' }],
      sensitive: [{ tag: '赌博', why: '文案出现下注' }],
      summary: '综合判断：建议拒绝',
    });
    truthy(out.indexOf('建议拒绝') === 0, '结论在最前：' + out);
    truthy(out.indexOf('· 品牌：微信') > 0, '品牌要带理由：' + out);
    truthy(out.indexOf('· 敏感：赌博') > 0, '敏感项要带理由：' + out);
    truthy(out.indexOf('综合判断：建议拒绝') > 0);
  });

  await test('★ formatAudit：云端为空不编造（不出现 undefined / 空的品牌行）', () => {
    const out = N.panel.formatAudit(A.screen('清爽计算器'), null);
    truthy(out.indexOf('undefined') < 0, '不能拼出 undefined：' + out);
    truthy(out.indexOf('· 品牌') < 0, '没品牌就不许出品牌行：' + out);
  });

  await test('★ manifest：内容脚本加载了 ai-audit.js，且排在 important-note.js 之前', () => {
    const m = require('../../manifest.json');
    const js = m.content_scripts[0].js;
    const iA = js.indexOf('src/features/ai-audit.js');
    const iN = js.indexOf('src/features/important-note.js');
    truthy(iA >= 0, '内容脚本缺 ai-audit.js ⇒ 面板里 KH.AiAudit 是 undefined');
    truthy(iA < iN, 'ai-audit.js 必须排在 important-note.js 之前');
  });

  await test('★ 面板文案全部来自 ocr-copy（不在这里手写中文）', () => {
    const V = KH.OcrCopy.VIEW;
    const keys = ['aiAudit', 'aiAuditTip', 'aiAuditName', 'aiAuditPick', 'aiAuditPickDone',
      'aiAuditRun', 'aiAuditRunning', 'aiAuditNeed', 'aiAuditLocalOnly', 'aiAuditNoKey', 'aiAuditFail'];
    for (let i = 0; i < keys.length; i++) truthy(!!V[keys[i]], 'VIEW 缺 ' + keys[i]);
  });

  /* ================= ⑤ 合并展示口径（A1 并表 + B2 有值进表才算） ================= */

  suite('2.0.8.7 口径：合并行并进「进表」那张表 + 静态命中要「有值进表」才触发');

  /** 临时替换 `ImgOcr` 的四个读点（`ocrExtraRows` 只走这几个口），跑完必还原。 */
  function withImgOcr(stub, fn) {
    const I = KH.ImgOcr;
    const old = { items: I.items, kvWords: I.kvWords, scopedRaw: I.scopedRaw, scopeKnown: I.scopeKnown };
    I.items = stub.items;
    I.kvWords = stub.kvWords;
    if (stub.scopedRaw) I.scopedRaw = stub.scopedRaw;
    if (stub.scopeKnown) I.scopeKnown = stub.scopeKnown;
    try { return fn(); } finally {
      I.items = old.items;
      I.kvWords = old.kvWords;
      if (old.scopedRaw) I.scopedRaw = old.scopedRaw;
      if (old.scopeKnown) I.scopeKnown = old.scopeKnown;
    }
  }

  const OCR_ONE = () => [{
    ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 abc1234', matched: ['登记号'],
    lineList: [{ cells: [{ t: '登记号' }, { t: 'abc1234' }] }],
  }];

  await test('★ B2：字段没写进动态词，只要「静态命中 + 真的进表出了值」就出合并行', () => {
    const rows = withImgOcr(
      { items: OCR_ONE, kvWords: () => ['登记号'], scopedRaw: (raw) => raw, scopeKnown: () => [] },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号 #表' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 1, '静态命中且有值时必须出这一行');
    eq(rows[0].hit, true);
    eq(rows[0].value, 'abc1234', '值直接取「进表」那一行，不回头再猜');
  });

  await test('★ B2 反例：图里命中、但没进表（没有 #表 标记的词）⇒ 不出行', () => {
    const rows = withImgOcr(
      { items: OCR_ONE, kvWords: () => [], scopedRaw: (raw) => raw, scopeKnown: () => [] },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 0, '没有值就不许留空壳');
  });

  await test('★ B2 反例：进表有词但这次没命中（matched 为空）⇒ 不出行', () => {
    const rows = withImgOcr(
      {
        items: () => [{
          ruleId: 'kw1', label: '登记号', state: 'done', text: '登记号 abc1234', matched: [],
          lineList: [{ cells: [{ t: '登记号' }, { t: 'abc1234' }] }],
        }],
        kvWords: () => ['登记号'], scopedRaw: (raw) => raw, scopeKnown: () => [],
      },
      () => N.mergeRowsFor(
        { pinId: 'kw1', imgOcr: true, imgOcrKeyword: '登记号 #表' },
        { imgMerge: { on: true, rows: [{ field: '登记号', title: '软著' }] } }
      )
    );
    eq(rows.length, 0);
  });

  /** 造一张带 tbody 的抓取表（DOM 垫片足够：只需要 querySelector / appendChild / textContent）。 */
  function fetchCardEl() {
    const el = global.document.createElement('div');
    el.innerHTML = '<table class="kh-table kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">登记号</td><td>abc1234</td></tr>' +
      '</tbody></table>';
    return el;
  }

  await test('★ A1：合并行进「进表」那张表的 tbody，全卡只有一张表', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: true }] });
    const rows = el.querySelectorAll('tr.kh-merge-row');
    eq(rows.length, 1, '要有一行合并行');
    eq(el.querySelectorAll('table').length, 1, '不许再出现第二张表（旧口径就是表下面再一张）');
    const tds = rows[0].querySelectorAll('td');
    eq(tds[0].textContent, '软著');
    eq(tds[1].textContent, 'abc1234');
  });

  await test('★ A1 幂等：同样的内容再画一遍，行数不变、不重建', () => {
    const el = fetchCardEl();
    const item = { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: true }] };
    N.panel.decorateMerge(el, item);
    const first = el.querySelectorAll('tr.kh-merge-row')[0];
    N.panel.decorateMerge(el, item);
    const again = el.querySelectorAll('tr.kh-merge-row');
    eq(again.length, 1);
    truthy(again[0] === first, '同一行必须还是同一个节点（内容没变不重排）');
  });

  await test('★ A1：没命中就一条都不留（也不留孤儿按钮）', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: false, hit: false }] });
    eq(el.querySelectorAll('tr.kh-merge-row').length, 0);
    eq(el.querySelectorAll('.kh-merge-more').length, 0);
  });

  await test('★ A1：隐藏行默认不显示，点「显示 N 条」才摊开（按钮挂在表后）', () => {
    const el = fetchCardEl();
    N.panel.decorateMerge(el, { mergeRows: [{ field: '登记号', title: '软著', hidden: true, hit: true }] });
    const row = el.querySelectorAll('tr.kh-merge-row')[0];
    truthy(row.className.indexOf('kh-merge-hidden') >= 0, '隐藏行要带 kh-merge-hidden');
    eq(el.querySelectorAll('.kh-merge-more').length, 1, '要有「显示 N 条」开关');
    eq(el.querySelectorAll('tr.kh-merge-row').length, 1);
  });
};
