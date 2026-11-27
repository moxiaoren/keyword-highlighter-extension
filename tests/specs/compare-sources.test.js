/* tests/specs/compare-sources.test.js — 【R2】比对子系统 · 来源层
 * ----------------------------------------------------------------------------
 * 锁「这张卡里有什么」：字段别名、从单元格认出字段名、取字段值。
 * 重点回归两条历史病：
 *   ① 面板 append 的判定标记 / 政策徽标不能让字段名认不出来（只能从右端逆序剥）；
 *   ② 值格里的证据行不能被当成字段值（同一张卡二次渲染会判错）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const S = KH.Compare.Sources;
  const card = (html) => { const d = H.el('div', {}, []); d.innerHTML = html; return d; };
  const tableOf = (d) => d.querySelectorAll('table')[0];

  suite('比对来源 · 字段识别与取值（R2）');
    test('fieldKey：五个基础字段 + APP备案主办单位别名', () => {
      eq(S.fieldKey('主标题'), 'title');
      eq(S.fieldKey('应用名称'), 'title');
      eq(S.fieldKey('开发者'), 'dev');
      eq(S.fieldKey('核准主体名称'), 'entity');
      eq(S.fieldKey('APP备案主办单位'), 'entity');
      eq(S.fieldKey('隐私政策链接'), 'link');
      eq(S.fieldKey('无关字段'), '');
    });

    test('labelText：判定标记 / 政策徽标 / 展开区都从右端剥掉', () => {
      const d = card('<table class="kh-table-fetch"><tbody><tr>' +
        '<td class="kh-table-label">隐私政策<span class="kh-policy-flag">名</span><span class="kh-verdict">✔ 一致</span></td>' +
        '<td>x</td></tr></tbody></table>');
      const td = tableOf(d).querySelectorAll('tr')[0].querySelectorAll('td')[0];
      eq(S.labelText(td), '隐私政策');
      eq(S.fieldKeysOf(td)[0], 'policy');
    });

    test('★ 2.0.19.8 值格被「只显示一行」裁过：取值必须回到 data-khfull 的全文', () => {
      /* 用户 m05608：卡片值限了字数后，隐私政策比对拿 textContent 当正文，只剩 11 字。 */
      const d = card('<table class="kh-table-fetch"><tbody>' +
        '<tr><td class="kh-table-label">隐私政策</td><td class="kh-val-clip">' +
        '<div class="kh-val-box" data-khfull="https://oanew.xdtzjt.cn:3102/public/privacy-policy" ' +
        'title="https://oanew.xdtzjt.cn:3102/public/privacy-policy">https://oa…</div></td></tr>' +
        '</tbody></table>');
      const t = tableOf(d);
      const td = t.querySelectorAll('tr')[0].querySelectorAll('td')[1];
      eq(S.cellValue(td), 'https://oanew.xdtzjt.cn:3102/public/privacy-policy');
      eq(S.readFields(t).policy, 'https://oanew.xdtzjt.cn:3102/public/privacy-policy');
    });

    test('合并行：一个值被多个字段名共用，任一侧都能取到', () => {
      const d = H.el('div', {}, []);
      d.innerHTML = KH.Fetch.rowsToTableHtml([
        { label: '开发者', rows: [[{ t: '北京甲科技有限公司' }]], opt: null },
        { label: '核准主体名称', rows: [[{ t: '北京甲科技有限公司' }]], opt: null }
      ]);
      const t = tableOf(d);
      const trs = t.querySelectorAll('tr');
      eq(trs.length, 1, '同值字段合并成一行');
      const labels = S.labelsOf(trs[0].querySelectorAll('td')[0]);
      truthy(labels.indexOf('开发者') >= 0 && labels.indexOf('核准主体名称') >= 0, labels.join('/'));
      eq(S.readFields(t).dev, '北京甲科技有限公司');
      eq(S.readFields(t).entity, '北京甲科技有限公司');
      eq(S.field(t, '开发者').value, '北京甲科技有限公司');
    });

    test('★ 2.0.19.8 集成：真按 ~N 渲染过的政策格，readFields 仍拿到完整 URL', () => {
      const d = H.el('div', {}, []);
      d.innerHTML = KH.Fetch.rowsToTableHtml([
        { label: '隐私政策', rows: [[{ t: 'https://oanew.xdtzjt.cn:3102/public/privacy-policy' }]],
          opt: { clip: true, clipChars: 8 } }
      ]);
      const f = S.readFields(tableOf(d));
      eq(f.policy, 'https://oanew.xdtzjt.cn:3102/public/privacy-policy', '裁切只裁显示，取值必须是全文');
    });

    test('field：行在值空也算 found（区分「没这一行」与「这一行是空的」）', () => {
      const d = card('<table class="kh-table-fetch"><tbody>' +
        '<tr><td class="kh-table-label">开发者</td><td></td></tr>' +
        '</tbody></table>');
      const got = S.field(tableOf(d), '开发者');
      truthy(got.found, '行在');
      eq(got.value, '');
      eq(S.field(tableOf(d), '著作权人').found, false);
    });

    test('field：值格里的证据行不算字段值', () => {
      const d = card('<table class="kh-table-fetch"><tbody><tr>' +
        '<td class="kh-table-label">著作权人</td>' +
        '<td>北京甲科技有限公司<span class="kh-evidence">值：北京甲科技有限公司 源：本页抓取 原页 ↗</span></td>' +
        '</tr></tbody></table>');
      eq(S.field(tableOf(d), '著作权人').value, '北京甲科技有限公司');
    });

    test('policySource：抓取值本身是 URL，或另有链接字段', () => {
      eq(S.policySource({ policy: 'https://a.example/p' }).from, 'policy');
      eq(S.policySource({ policy: '正文内容', link: 'https://a.example/p' }).from, 'link');
      eq(S.policySource({ policy: '正文内容' }), null);
    });
};