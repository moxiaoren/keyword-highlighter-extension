/* tests/specs/risk-audit.test.js — 主标题 / 图标的本地风险初筛（2.0.18 · 用户 m24795）
 * ----------------------------------------------------------------------------
 * 用户口径：「默认从重要笔记里面获取主标题和图标字段抓取到的内容，搜索是否涉及蹭词、
 * 资金盘、色情低俗、诈骗等风险内容。」这一段是零联网的本地词库初筛：
 *   · screen() 只认两件事——品牌（同名=2、名称含品牌=1）与六类敏感词（=2）；
 *   · readCard() 从渲染好的抓取表里取主标题与图标，不重新解析页面；
 *   · 深查（联网）不在这里，归后台 AI.riskCheck，这里只锁它的契约。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const R = KH.RiskAudit;

  suite('风险初筛 · 本地词库（2.0.18 · m24795）');

  await test('★ normalizeName：空格/标点/大小写归一到同一套比较上', () => {
    truthy(R, '必须导出 KH.RiskAudit');
    eq(R.normalizeName('微 信·'), '微信');
    eq(R.normalizeName('  DeepSeek！ '), 'deepseek');
    eq(R.normalizeName('（测试）'), '测试');
    eq(R.normalizeName(null), '');
  });

  await test('★ screen：与品牌同名=高风险（2），名称里含品牌=待核（1）', () => {
    const same = R.screen('微信');
    eq(same.level, 2);
    eq(same.verdict, 'risky');
    truthy(same.hits.some((h) => h.kind === 'brand' && h.tag === '同名' && h.word === '微信'), '要说出与谁同名');

    const rub = R.screen('微信分身版');
    eq(rub.level, 1);
    eq(rub.verdict, 'suspect');
    truthy(rub.hits.some((h) => h.tag === '蹭品牌'), '要说出蹭了哪个品牌');

    eq(R.screen('某某记账本').level, 0, '普通名称不该报');
    eq(R.screen('').level, 0, '空名不判');
  });

  await test('★ screen：六类敏感词都算高风险，并说出类别与命中的词', () => {
    const cases = [
      ['天天赌博神器', '赌博'],
      ['同城约炮', '色情低俗'],
      ['静态收益躺赚', '资金盘'],
      ['冒充客服退款', '诈骗'],
      ['秒批无抵押贷款', '违规贷款'],
      ['usdt 代币发行', '其它']
    ];
    for (const [name, tag] of cases) {
      const r = R.screen(name);
      eq(r.level, 2, name + ' 应判高风险');
      truthy(r.hits.some((h) => h.kind === 'sensitive' && h.tag === tag), name + ' 应归到「' + tag + '」');
    }
  });

  await test('★ readCard：从抓取表里取主标题与图标，空值不算', () => {
    const d = H.el('div', {}, []);
    d.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">主标题</td><td>微信</td></tr>' +
      '<tr><td class="kh-table-label">图标</td><td><img src="data:image/png;base64,AA"></td></tr>' +
      '<tr><td class="kh-table-label">开发者</td><td>北京甲科技有限公司</td></tr>' +
      '</tbody></table>';
    const got = R.readCard(d.querySelectorAll('table')[0]);
    truthy(got.found, '有主标题就算找到了');
    eq(got.title, '微信');
    eq(got.icon, 'data:image/png;base64,AA');

    const empty = H.el('div', {}, []);
    empty.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">主标题</td><td></td></tr>' +
      '</tbody></table>';
    const none = R.readCard(empty.querySelectorAll('table')[0]);
    eq(none.title, '', '空值不当作标题');
    falsy(none.found, '没有标题也没有图标 = 没找到');
  });

  await test('★ auditCard：名称有风险时带出等级与命中；没标题不判', () => {
    const d = H.el('div', {}, []);
    d.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">主标题</td><td>微信</td></tr>' +
      '</tbody></table>';
    const res = R.auditCard(d.querySelectorAll('table')[0]);
    truthy(res.ok);
    eq(res.level, 2);
    truthy(res.hits.length > 0);

    const d2 = H.el('div', {}, []);
    d2.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">开发者</td><td>北京甲科技有限公司</td></tr>' +
      '</tbody></table>';
    const res2 = R.auditCard(d2.querySelectorAll('table')[0]);
    falsy(res2.ok, '没有主标题就无从判断');
    eq(res2.level, 0);
  });

  await test('★ 接线契约：模块进 manifest、卡片出徽标、深查走 AI 端口', () => {
    const mf = read('manifest.json');
    truthy(mf.indexOf('"src/features/risk-audit.js"') >= 0, '新增模块必须进 manifest（单测也按它加载）');
    truthy(mf.indexOf('src/features/risk-audit.js') < mf.indexOf('src/features/important-note.js'), '要先于面板加载');

    const panel = read('src/features/important-note.js');
    truthy(panel.indexOf('decorateRisk(el)') >= 0, '卡片要能出风险徽标');
    truthy(panel.indexOf("'data-kh-risk-sig'") >= 0, '同一张卡重复渲染不能叠徽标');
    truthy(panel.indexOf('.khin-risk-flag') >= 0);
    truthy(panel.indexOf('this.riskAi(res.title, res.icon)') >= 0, '深查要带上图标');
    truthy(panel.indexOf("action: 'risk', title: String(title || ''), icon: String(icon || '')") >= 0, '深查走 AI 端口');
    truthy(panel.indexOf('khin-chat-bar') >= 0, '模型下拉要单独一行（名字长不挤 head）');

    const ai = read('background/ai.js');
    truthy(ai.indexOf('AI.riskCheck = async function') >= 0);
    truthy(ai.indexOf("credentials: 'include'") >= 0, '图标在后台按站点身份取');
    truthy(ai.indexOf('webSearch: true') >= 0, '深查要联网');
    truthy(ai.indexOf('files: files') >= 0, '有图标才带图');

    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("m.action === 'risk'") >= 0);
    truthy(sw.indexOf('self.KhAi.riskCheck({ title: m.title, icon: m.icon })') >= 0);
    truthy(sw.indexOf('riskBusy') >= 0, '深查要防并发');
  });
};
