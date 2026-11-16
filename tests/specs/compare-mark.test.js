/* tests/specs/compare-mark.test.js — 「比对」标记 `#比`：配置写法 + 命中即一致
 * ----------------------------------------------------------------------------
 * 【2.0.11 · 用户 m00001】比对收进「添加关键词」：
 *   · 图片命中词 / 图片动态词里，每个词后面勾「比对」⇒ 落盘成后缀 `#比`（英文 `#cmp` 等价）；
 *   · 同一张图上勾了的项都出现 ⇒ 一致；缺哪个就点名 ⇒ 不一致；没勾 ⇒ 不判、不显示；
 *   · 静态词按「词本身」判，动态字段按「它取到的值」判（任一值出现即算该项命中）。
 * 用户点名要删掉的逐字段证据行（值 · 源 · 读取：HH:MM · 法人未查到）另有用例守着。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, truthy, loadKernel } = H;

module.exports = async function run() {
  const KH = loadKernel();
  const O = KH.ImgOcr;
  truthy(O && typeof O.cmpReqs === 'function', 'KH.ImgOcr.cmpReqs 必须可用');
  truthy(O && typeof O.cmpJudge === 'function', 'KH.ImgOcr.cmpJudge 必须可用');
  truthy(typeof O.chipTags === 'function', 'KH.ImgOcr.chipTags 必须可用');

  const known = ['截图', '名称', '开发者'];
  const rule = (kw, need) => ({
    meta: { imgOcr: true, imgOcrKeyword: kw || '', imgOcrNeed: need || '', fetchLabels: '截图|名称|开发者' }
  });

  suite('2.0.11 比对标记 `#比`：写法与解析');

    await test('★ `#比` 与 `#表` 可以同时出现、顺序无关', () => {
      eq(O.chipTags('致方#表#比').body, '致方');
      eq(O.chipTags('致方#表#比').cmp, true);
      eq(O.chipTags('致方#表#比').mark, true);
      eq(O.chipTags('致方#比#表').body, '致方');
      eq(O.chipTags('致方#比#表').cmp, true);
      eq(O.chipTags('致方#比').mark, false);
    });

    await test('★ 英文写法 `#cmp` 等价；剥标记后只剩裸词', () => {
      eq(O.chipTags('承诺方#cmp').cmp, true);
      eq(O.chipTags('承诺方#cmp').body, '承诺方');
      eq(O.stripKvMarks('致方#比|承诺方#表'), '致方|承诺方');
    });

    await test('★ 批量切词：标记后面的分隔符照旧切段（不会把两张图挤进一段）', () => {
      eq(O.kvCmpWords('致方#比,承诺方#比').join('|'), '致方|承诺方');
      eq(O.kvCmpWords('致方#比|普通词').join('|'), '致方');
    });

    await test('★ `@字段名` 与 `#比` 共存：作用域照旧解析，比对标志单独带出', () => {
      const sp = O.splitScope('致方@名称#比', known);
      eq(O.chipTags(sp.text).body, '致方');
      eq(sp.cmp, true);
      eq(sp.scopes.join('|'), '名称');
    });

  suite('2.0.11 比对项 `cmpReqs`：只有勾了「比对」的项才进来');

    await test('没勾 ⇒ 空数组（不判、不显示结论）', () => {
      eq(O.cmpReqs(rule('致方|承诺方'), '截图', null).length, 0);
    });

    await test('★ 静态词：勾了几个就核对几项', () => {
      const q = O.cmpReqs(rule('甲公司#比|乙公司#比|普通词'), '截图', null);
      eq(q.map((x) => x.name).join('|'), '甲公司|乙公司');
      eq(q.every((x) => x.kind === 'word'), true);
    });

    await test('★ 动态字段：图片动态词里的 `#比` 也进 reqs（名字取裸名）', () => {
      const q = O.cmpReqs(rule('', '开发者#比'), '截图', null);
      eq(q.length, 1);
      eq(q[0].name, '开发者');
      eq(q[0].kind, 'need');
    });

    await test('★ 作用域覆盖：这张字段有专属比对词就只用它（与图片命中词同一条口径）', () => {
      eq(O.cmpReqs(rule('致方@名称#比|承诺方#比'), '名称', null).map((x) => x.name).join('|'), '致方');
      eq(O.cmpReqs(rule('致方@名称#比|承诺方#比'), '截图', null).map((x) => x.name).join('|'), '承诺方');
    });

  suite('2.0.11 判决 `cmpJudge`：命中即一致');

    const reqs = [
      { name: '甲公司', kind: 'word', word: '甲公司' },
      { name: '乙公司', kind: 'word', word: '乙公司' }
    ];

    await test('★ 两项都在 ⇒ same', () => {
      const r = O.cmpJudge(rule(''), '兹证明  致：甲公司  承诺方：乙公司', '截图', reqs);
      eq(r.state, 'same');
      eq(r.missing.length, 0);
      eq(r.items.length, 2);
    });

    await test('★ 缺一项 ⇒ diff，并点名缺的是谁', () => {
      const r = O.cmpJudge(rule(''), '致：甲公司', '截图', reqs);
      eq(r.state, 'diff');
      eq(r.missing.join('|'), '乙公司');
    });

    await test('没勾比对项 ⇒ null（不显示任何结论，也不涂色）', () => {
      eq(O.cmpJudge(rule(''), '任意文本', '截图', []), null);
      eq(O.cmpJudge(rule(''), '任意文本', '截图', null), null);
    });

    await test('★ 动态项按「取到的值」判：值出现在图上才算到齐', () => {
      const q = [{ name: '开发者', kind: 'need', values: ['南京石诚星桥科技有限公司'] }];
      eq(O.cmpJudge(rule(''), '开发者：南京石诚星桥科技有限公司', '截图', q).state, 'same');
      eq(O.cmpJudge(rule(''), '开发者：别的公司', '截图', q).state, 'diff');
    });

    await test('动态项一个字都没取到 ⇒ 不算一致（缺的就是它，不许当成「没配」）', () => {
      const q = [{ name: '开发者', kind: 'need', values: [] }];
      const r = O.cmpJudge(rule(''), '开发者：随便', '截图', q);
      eq(r.state, 'diff');
      eq(r.missing.join('|'), '开发者');
    });
};
