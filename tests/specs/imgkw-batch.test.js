/* tests/specs/imgkw-batch.test.js — 图片词条的「作用域」与批量改写口径
 * ----------------------------------------------------------------------------
 * 【2.0.7.2 需求①】用户现场（round 70 第 1 条）三条，逐条钉住：
 *   ① 作用域写在词尾 `@字段名` 上，但**可以连写多个**（关键词不是只指一个字段）；
 *   ② 批量弹窗必须**认得出**已配的抓取字段（旧实现读 `input.value`，候选框常态是胶囊 ⇒ 永远空
 *      ⇒ 下拉框灰掉、`@截图` 被当普通词显示成「通用」）；
 *   ③ 不是真配过的字段名 ⇒ 整段按普通词（老配置零影响）。
 * 判定侧的唯一实现是 `KH.ImgOcr` 的 `splitScope` / `scopedRaw`；管理端那份镜像在
 * `src/ui/components/fields.js`（options 不加载 img-ocr.js），两边靠本文件对账。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy, loadKernel } = H;

module.exports = async function run() {
  const KH = loadKernel();
  const O = KH.ImgOcr;
  truthy(O && typeof O.splitScope === 'function', 'KH.ImgOcr.splitScope 必须可用');

  const known = ['截图', '名称', '开发者'];
  const rule = (kw) => ({ meta: { imgOcr: true, imgOcrKeyword: kw, fetchLabels: '截图|名称|开发者' } });

  suite('2.0.7.2 需求①：词尾 `@字段名` 可连写多个（一个词管多个字段的图）');
    await test('★ 单个 `@截图`：只在截图字段生效，其它字段只剩未限定词', () => {
      const k = O.scopeKnown(rule(''));
      eq(JSON.stringify(k), JSON.stringify(known));
      eq(O.scopedRaw('一对一@截图|通用', '截图', k), '一对一');
      eq(O.scopedRaw('一对一@截图|通用', '名称', k), '通用');
    });

    await test('★ 连写 `@截图@名称`：两个字段都算命中（任一即属于它）', () => {
      const k = O.scopeKnown(rule(''));
      eq(O.matchedInText(rule('一对一@截图@名称'), '一对一', '截图').length, 1, '截图在作用域里');
      eq(O.matchedInText(rule('一对一@截图@名称'), '一对一', '名称').length, 1, '★ 名称也在（多字段）');
      eq(O.matchedInText(rule('一对一@截图@名称'), '一对一', '开发者').length, 0, '没点名的字段不生效');
    });

    await test('★ 连写顺序保留、重复去重', () => {
      const p = O.splitScope('一对一@名称@截图@截图', known);
      eq(JSON.stringify(p.scopes), JSON.stringify(['名称', '截图']), '按书写顺序、重复只留一条');
      eq(p.text, '一对一');
    });

    await test('★ `#表` 仍必须收尾：`一对一@截图#表` 剥完只剩词 + 标记', () => {
      const p = O.splitScope('一对一@截图#表', known);
      eq(p.text, '一对一#表', '标记留在词上（`#表` 必须在最末，`@` 在它前面）');
      eq(JSON.stringify(p.scopes), JSON.stringify(['截图']));
    });

    await test('★ 不是真配过的字段名 ⇒ 整段按普通词（老配置零影响）', () => {
      eq(O.matchedInText(rule('张三@不存在'), '张三@不存在', '截图').length, 1, '整段当一个词');
      eq(O.matchedInText(rule('张三@截图'), '张三', '截图').length, 1, '真字段名才剥');
      const k = O.scopeKnown(rule(''));
      eq(JSON.stringify(O.splitScope('张三@不存在', k).scopes), JSON.stringify([]), '不算作用域');
    });

    await test('★ 只有一半是真字段：从后往前剥到第一个不认识的为止', () => {
      const p = O.splitScope('词@不存在@截图', known);
      eq(JSON.stringify(p.scopes), JSON.stringify(['截图']), '尾部真字段剥掉');
      eq(p.text, '词@不存在', '★ 剩下的 `@不存在` 留在词里（不当作用域，也不丢）');
    });
};
