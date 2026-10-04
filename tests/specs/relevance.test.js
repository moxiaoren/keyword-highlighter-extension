/* tests/specs/relevance.test.js — 变更相关性预筛（P1）与仅消费判定（P2）
 * ----------------------------------------------------------------------------
 * 回归背景（K54 / v1.99.99.21）：为了不再"一有变动就整页重建"，新增
 * `src/core/relevance.js` 的 `classify(records)`，给三种结论：full / consume / skip。
 *
 * 这里锁死**判据本身**的安全边界（判漏是事故，判多只是多算一次）：
 *   · 拿不到字面前缀的规则（罕见字逐字判定、顶层有 `|` 的多分支正则）→ 任何文本变化都必须 full；
 *   · 命中节点被原地改写 / 被移出文档 → full（旧 Range 会指到错的字）；
 *   · 变化文本**所在格子的整段文本**含前缀 → full（跨文本节点、值慢慢填的场景，
 *     只测"变化的那一段"会漏 —— `_e2e/probe-relevance.js` ⑧ 实测过）；
 *   · 命中的表格/假表格里只有抓取字段变（且不含前缀）→ consume；
 *   · 与命中、抓取、图片都不相关 → skip。
 * 真浏览器侧的对应用例见 `_e2e/probe-relevance.js`（12 项）与 content.test.js 的图片/相关性组。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;

/* ---------------- 极简假 DOM（classify 只碰这几个口子） ---------------- */

function fakeText(value, parent) {
  return { nodeType: 3, nodeValue: value, parentElement: parent || null, isConnected: true };
}

function fakeEl(tag, text, cell) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'DIV').toUpperCase(),
    textContent: text == null ? '' : String(text),
    parentElement: null,
    isConnected: true,
    children: [],
    hasAttribute: () => false,
    closest(sel) {
      if (cell && /td|th/.test(sel)) return cell;
      if (/table/.test(sel)) return el._table || null;
      return null;
    },
    contains(n) { return n === el || (el._desc || []).indexOf(n) >= 0; },
    querySelector() { return null; }
  };
  return el;
}

/* 注意：`MutationRecord.type` 的真实取值是 **`'attributes'`（复数）** ——
 * 用 `'attribute'` 会让判据永不匹配（真机上踩过），这里统一用真值，防回归。 */
const ATTR = 'attributes';

function rec(type, target, extra) {
  return Object.assign({ type, target, addedNodes: [], removedNodes: [], attributeName: null }, extra || {});
}

/** 用假的 rules / registry 跑一次判据（不改动真实内核状态，跑完还原） */
function withStubs(rules, hits, fn) {
  const { KH } = require('../bootstrap');
  const dRules = Object.getOwnPropertyDescriptor(KH, 'rules');
  const dReg = Object.getOwnPropertyDescriptor(KH, 'registry');
  Object.defineProperty(KH, 'rules', { value: rules, configurable: true });
  Object.defineProperty(KH, 'registry', { value: { all: () => hits, size: hits.length }, configurable: true });
  try { return fn(KH); } finally {
    if (dRules) Object.defineProperty(KH, 'rules', dRules);
    if (dReg) Object.defineProperty(KH, 'registry', dReg);
  }
}

const rulePlain = (src, flags) => ({ pattern: new RegExp(src, flags || 'g'), labelPattern: null, flags: {}, meta: {} });
const ruleCombo = (core, label) => ({ pattern: new RegExp(core, 'g'), labelPattern: new RegExp(label, 'g'), flags: {}, meta: {} });

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const R = KH.Relevance;

  suite('relevance · 变更相关性预筛（K54）');

  await test('★ 字面前缀：含前缀 → 可能命中；不含 → 不可能命中（大小写按各规则 flag）', () => {
    const rules = [rulePlain('华为')];
    truthy(R.textMayMatch('这是一家华为公司', rules), '文本含前缀应判"可能命中"');
    truthy(!R.textMayMatch('这是一家别的公司', rules), '文本不含前缀应判"不可能命中"');
    const ci = [{ pattern: /HUAWEI/i, labelPattern: null, flags: {}, meta: {} }];
    truthy(R.textMayMatch('huawei tech', ci), '忽略大小写的规则要按小写比对');
    truthy(!R.textMayMatch('other', ci), '不含前缀');
  });

  await test('★ 拿不到字面前缀的规则一律"无法预筛"（罕见字 / 顶层多分支正则）', () => {
    truthy(!R.unfilterable(rulePlain('华为')), '普通字面词可预筛');
    truthy(R.unfilterable(rulePlain('安.*车主|好.*车主')), '顶层有 | 的正则 literalOf 返回空串 → 无法预筛');
    truthy(R.unfilterable({ pattern: null, labelPattern: null, flags: {}, meta: {} }), '罕见字（无模式、靠逐字判定）→ 无法预筛');
    truthy(R.textMayMatch('随便什么字', [{ pattern: /a|b/g, labelPattern: null, flags: {}, meta: {} }]),
      '无法预筛的规则，任何文本都要判"可能命中"');
  });

  await test('★ 命中节点被原地改写 → full（旧 Range 会指到新文本的同一段）', () => {
    const cell = fakeEl('TD', '审核不通过');
    const hitNode = fakeText('审核不通过', cell);
    /* 对照：同样的 characterData，但打在**非命中**节点上、且新文本与所在容器都不含前缀 → 什么都不用做。
     * （注意：若这个节点在"含关键词的格子"里，判据会保守地按格子上下文判 full —— 那是刻意的） */
    const other = fakeEl('DIV', '其它说明');
    const p = fakeText('其它说明', other);
    const rules = [rulePlain('审核不通过')];
    const v = withStubs(rules, [{ textNode: hitNode, meta: {} }], () => R.classify([rec('characterData', hitNode)], {}));
    eq(v, 'full', '命中节点的文本被改 → 必须完整重建');
    /* 对照：同样的 characterData，但打在**非命中**节点上、且新文本不含前缀 → 什么都不用做 */
    eq(withStubs(rules, [{ textNode: hitNode, meta: {} }], () => R.classify([rec('characterData', p)], {})), 'skip',
      '非命中节点的文本变化、又不含前缀 → 什么都不用做');
  });

  await test('★ 命中节点被移出文档 → full（Range 已失效）', () => {
    const hitNode = fakeText('华为', null);
    hitNode.isConnected = false;
    const v = withStubs([rulePlain('华为')], [{ textNode: hitNode, meta: {} }], () => R.classify([rec('childList', fakeEl('DIV'), { addedNodes: [fakeText('x')] })], {}));
    eq(v, 'full', '命中节点不再连着文档 → 必须重建');
  });

  await test('★ 值慢慢填 / 词被拆开：只看"变化的那段文本"会漏，要用所在格子的整段文本兜住', () => {
    const cell = fakeEl('TD', '华为');
    /* 变化的是 `<span>为</span>`（自己只含"为"，不含前缀"华为"），父级/格子文本才是完整的 */
    const span = fakeEl('SPAN', '为', cell);
    const rules = [rulePlain('华为')];
    const v = withStubs(rules, [], () => R.classify([rec('childList', cell, { addedNodes: [span] })], {}));
    eq(v, 'full', '格子整段文本含前缀 → 必须重建（否则拆开的词永远不会被高亮）');
  });

  await test('★ 命中所在表格里、不含前缀的字段变化 → consume（仅消费），而不是 full / skip', () => {
    const table = fakeEl('TABLE', '供应商 华为 备注 初值');
    const cell = fakeEl('TD', '华为', null);
    cell._table = table;
    const hitNode = fakeText('华为', cell);
    const fieldCell = fakeEl('TD', '改过的值', null);
    fieldCell._table = table;
    const fieldText = fakeText('改过的值', fieldCell);
    table._desc = [cell, fieldCell];                 // 假 DOM：让"表 contains 格子"成立
    const hits = [{ textNode: hitNode, meta: { important: true, fetchLabels: '备注' } }];
    const v = withStubs([rulePlain('华为'), ruleCombo('华为', '供应商')], hits,
      () => R.classify([rec('characterData', fieldText)], {}));
    eq(v, 'consume', '命中没变、只有抓取字段变 → 只重跑 Consume');
  });

  await test('★ 与命中、抓取都不相关的变动 → skip（这是省资源的全部意义）', () => {
    const table = fakeEl('TABLE', '供应商 华为 备注 初值');
    const cell = fakeEl('TD', '华为', null);
    cell._table = table;
    const hitNode = fakeText('华为', cell);
    const noise = fakeEl('P', '今日天气晴朗');
    const hits = [{ textNode: hitNode, meta: { important: true, fetchLabels: '备注' } }];
    const v = withStubs([rulePlain('华为'), ruleCombo('华为', '供应商')], hits,
      () => R.classify([rec('childList', fakeEl('BODY'), { addedNodes: [noise] })], {}));
    eq(v, 'skip', '不含前缀、也不在任何命中表格里 → 不重建');
  });

  await test('★ 新进来的图 + 开了图片识别的组合词 → full（要重新采集）', () => {
    const img = fakeEl('IMG', '');
    const rule = ruleCombo('华为', '供应商');
    rule.meta = { imgOcr: true };
    const v = withStubs([rule], [], () => R.classify([rec('childList', fakeEl('DIV'), { addedNodes: [img] })], {}));
    eq(v, 'full', '新图进来必须重新采集（图片识别）');
  });

  await test('★ 隐藏容器被显出来（class/style/hidden 变化）→ 必须重建（否则露出来的词永远不亮）', () => {
    const box = fakeEl('DIV', '供应商 华为');
    box.checkVisibility = () => true;                       // 现在可见了
    const rules = [rulePlain('华为')];
    const rec1 = rec(ATTR, box, { attributeName: 'class' });
    eq(withStubs(rules, [], () => R.classify([rec1], {})), 'full',
      '显出来的子树里含关键词前缀 → 必须重建');
    /* 对照：显出来的子树里没有任何关键词前缀 → 不用动 */
    const box2 = fakeEl('DIV', '与关键词无关的一段说明');
    box2.checkVisibility = () => true;
    eq(withStubs(rules, [], () => R.classify([rec(ATTR, box2, { attributeName: 'style' })], {})), 'skip',
      '显出来但与关键词无关 → 什么都不做');
  });

  await test('★ 命中所在的块被隐藏 → 必须重建（扫描按可见性剪枝，命中要跟着消失）', () => {
    const box = fakeEl('DIV', '华为');
    box.checkVisibility = () => false;                      // 现在不可见
    const hitNode = fakeText('华为', box);
    box._desc = [hitNode];
    eq(withStubs([rulePlain('华为')], [{ textNode: hitNode, meta: {} }],
      () => R.classify([rec(ATTR, box, { attributeName: 'hidden' })], {})), 'full',
      '命中被藏起来 → 需要重建把命中收掉');
  });

  await test('★ 换图：有图片识别 → full（要重采）；没有 → consume（抓取/面板里的图要刷新）', () => {
    const img = fakeEl('IMG', '');
    const withOcr = ruleCombo('华为', '供应商');
    withOcr.meta = { imgOcr: true };
    eq(withStubs([withOcr], [], () => R.classify([rec(ATTR, img, { attributeName: 'src' })], {})), 'full',
      '开着图片识别时换图 → 重新采集');
    const cell = fakeEl('TD', '华为', null);
    const table = fakeEl('TABLE', '供应商 华为 备注 初值');
    cell._table = table; table._desc = [cell];
    const hitNode = fakeText('华为', cell);
    eq(withStubs([rulePlain('华为')], [{ textNode: hitNode, meta: { important: true, fetchLabels: '备注' } }],
      () => R.classify([rec(ATTR, img, { attributeName: 'src' })], {})), 'consume',
      '没开图片识别时换图 → 只刷面板');
  });

  await test('★ 与命中无关的属性变化（不在白名单里的属性）不该被当成相关', () => {
    const box = fakeEl('DIV', '供应商 华为');
    box.checkVisibility = () => true;
    /* 观察器只投 class/style/hidden/src/srcset；即便递进来别的属性，judge 也按"显隐"档处理，
     * 这里用"子树里没有前缀"的节点代表"改了个无关属性" → skip */
    const noise = fakeEl('DIV', '今日天气晴朗');
    noise.checkVisibility = () => true;
    eq(withStubs([rulePlain('华为')], [], () => R.classify([rec(ATTR, noise, { attributeName: 'class' })], {})), 'skip',
      '无关属性变化 → 不重建');
  });
  /* K58：把这个取舍做成**可切换**的 —— 用户遇到"页面明明变了却不亮"时，
   * 切到保守档 → 现象消失 ⇒ 问题在预筛；现象仍在 ⇒ 问题在别处（这一步能把范围砍一半）。 */
  await test('★ 保守档（changeHandling=always）：无关变动也必须整页重建，且不走"仅消费"', () => {
    const noise = fakeEl('DIV', '今日天气晴朗');
    noise.checkVisibility = () => true;
    const noiseRec = rec('childList', noise, { addedNodes: [fakeText('x')] });
    eq(withStubs([rulePlain('华为')], [], () => R.classify([noiseRec], { changeHandling: 'smart' })), 'skip',
      '智能档：无关变动不重建（省资源的全部意义）');
    eq(withStubs([rulePlain('华为')], [], () => R.classify([noiseRec], { changeHandling: 'always' })), 'full',
      '保守档：同一批无关变动也必须整页重建');
    /* "仅消费"也属于增量通道 —— 保守档下必须让路，只做整页 */
    const imgEl = fakeEl('IMG', '');
    const cell = fakeEl('TD', '华为', null);
    const table = fakeEl('TABLE', '供应商 华为 备注 初值');
    cell._table = table; table._desc = [cell];
    const hitNode = fakeText('华为', cell);
    const hits = [{ textNode: hitNode, meta: { important: true, fetchLabels: '备注' } }];
    const attrRec = rec(ATTR, imgEl, { attributeName: 'src' });
    eq(withStubs([rulePlain('华为')], hits, () => R.classify([attrRec], {})), 'consume',
      '智能档：换图（没开图片识别）只刷面板');
    eq(withStubs([rulePlain('华为')], hits, () => R.classify([attrRec], { changeHandling: 'always' })), 'full',
      '保守档：换图也整页重建（不做增量）');
  });

  await test('★ 变更处理方式：非法值回退智能档（坏值不许让两头都失效）', () => {
    const C = KH.Config;
    const norm = (v) => C.normalize(v).config.changeHandling;   // normalize 返回 { config, changed }
    eq(norm({ changeHandling: 'always' }), 'always', '合法值必须原样保留');
    eq(norm({ changeHandling: 'smart' }), 'smart');
    eq(norm({ changeHandling: '乱写的值' }), 'smart', '非法值回退默认（智能）');
    eq(norm({}), 'smart', '缺省即智能');
  });

  await test('★ 判据出错时保守回退 full（绝不因为"省资源"而漏命中）', () => {
    /* 把 rules 换成会抛异常的怪对象：literalOf 拿不到 → unfilterable 判 true 也行，
     * 这里更直接：让 registry.all 抛错，看 classify 是否回退 full。 */
    const { KH: K2 } = require('../bootstrap');
    const dReg = Object.getOwnPropertyDescriptor(K2, 'registry');
    Object.defineProperty(K2, 'registry', { value: { all() { throw new Error('boom'); } }, configurable: true });
    let v;
    try { v = K2.Relevance.classify([rec('childList', fakeEl('DIV'), { addedNodes: [fakeText('x')] })], {}); }
    finally { if (dReg) Object.defineProperty(K2, 'registry', dReg); }
    eq(v, 'full', '判据异常 → 回退整页重建');
  });
};
