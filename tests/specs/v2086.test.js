/* tests/specs/v2086.test.js — 2.0.8.6 的三条需求 + 用户当天追加的两条
 * ----------------------------------------------------------------------------
 * ① 去掉「软著一致性核对」，换成「图文合并」：抓取字段的图片 + 它的 OCR 动态词命中
 *    ⇒ 卡片里多一行「自定义标题 ｜ 该字段抓到的值」，并且能配「默认不展示」。
 * ② 贴边模式默认钉住「置顶排序第一个词」那条并展开；没有置顶词就还是全部收起。
 * ③ 卡顿/内存/速度（本版只做能实测的那部分，见 CHANGELOG 的措辞）。
 * 追加：贴边条可以上下拖（默认仍居中）；AI 页签在贴边态更宽一档、不再挤。
 *
 * 断言对齐"用户能看见的行为"，不锁实现内部命名；纯文本判据一律用 indexOf，
 * 免得正则转义把断言本身变成第二个 bug。
 * ========================================================================= */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Config;

  /* ==================== ① 软著核对 → 图文合并 ==================== */
  suite('v2.0.8.6 · ① 软著一致性核对整块移除，换成图文合并');


  await test('★ 归一：去空 / 同名字段去重 / 标题截断 / hidden 只认 true', () => {
    const n = C.normalizeImgMerge;
    const a = n({ rows: [{ field: ' 登记号 ', title: '  软件登记号  ', hidden: 1 }, { field: '登记号' }, { field: '' }] });
    eq(a.rows.length, 1, '同名字段必须去重、空字段必须丢掉');
    eq(a.rows[0].field, '登记号', '字段名要 trim');
    eq(a.rows[0].title, '软件登记号', '标题要 trim');
    eq(a.rows[0].hidden, false, 'hidden 只认 true（脏值 1 不算开）');
    eq(n({ rows: [{ field: 'A', title: '字'.repeat(80) }] }).rows[0].title.length, C.MERGE_TITLE_MAX, '标题截到上限');
    eq(n({ on: false }).on, false, 'on:false 必须保住');
    eq(C.defaults.imgMerge.rows.length, 0, '默认表必须是空的（空表 ⇒ 与旧版逐字节一致）');
  });



  /* ==================== ② 默认钉住置顶词 ==================== */
  suite('v2.0.8.6 · ② 贴边模式默认钉住置顶第一个词并展开');


  /* ==================== 追加：贴边可拖 + AI 更宽 ==================== */
  suite('v2.0.8.6 · 追加：贴边条上下拖 / AI 页签更宽');


};
