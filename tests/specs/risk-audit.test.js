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
    eq(got.dev, '北京甲科技有限公司', '开发者/主体也要读出来：判定正版与冒充就靠它');

    const empty = H.el('div', {}, []);
    empty.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">主标题</td><td></td></tr>' +
      '</tbody></table>';
    const none = R.readCard(empty.querySelectorAll('table')[0]);
    eq(none.title, '', '空值不当作标题');
    falsy(none.found, '没有标题也没有图标 = 没找到');
  });

  await test('★ 2.0.18 副标题也纳入判定：名称按主标题-副标题拼，副标题里的词一样会命中（m27217）', () => {
    const d = H.el('div', {}, []);
    d.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">主标题</td><td>记账助手</td></tr>' +
      '<tr><td class="kh-table-label">副标题</td><td>微信版</td></tr>' +
      '</tbody></table>';
    const got = R.readCard(d.querySelectorAll('table')[0]);
    eq(got.subtitle, '微信版', '副标题要读出来');
    eq(got.name, '记账助手-微信版', '名称 = 主标题-副标题');
    /* 副标题里带品牌，没开发者 ⇒ 待核；开发者是官方主体 ⇒ 清零。 */
    eq(R.auditCard(d.querySelectorAll('table')[0]).level, 1);
    eq(R.screen('记账助手-微信版', {}, '深圳市腾讯计算机系统有限公司').level, 0);
    /* 只有副标题没有主标题时不算找到：判定以主标题为准。 */
    const d2 = H.el('div', {}, []);
    d2.innerHTML = '<table class="kh-table-fetch"><tbody>' +
      '<tr><td class="kh-table-label">副标题</td><td>微信版</td></tr>' +
      '</tbody></table>';
    falsy(R.readCard(d2.querySelectorAll('table')[0]).found, '没有主标题不给结论');
  });

  await test('★ 2.0.18 自定义词可带备注：命中时备注跟着出来，备注长度有上限（m27217）', () => {
    const cfg = { riskLexicon: { custom: [{ w: '秒下款', cat: 'loan', note: '客户反馈的这类话术' }], disabled: [], remoteUrl: '' } };
    const r = R.screen('秒下款钱包', cfg);
    eq(r.level, 2, '自定义词照样判高风险');
    const hit = r.hits.filter((h) => h.kind === 'sensitive')[0];
    eq(hit.note, '客户反馈的这类话术', '备注要跟着命中带出来');
    const lex = R.lexicon(cfg);
    eq(lex.notes[R.normalizeName('秒下款')], '客户反馈的这类话术', '备注按归一后的词存');
  });

  await test('★ 2.0.18 接线契约：副标题别名、备注输入、深查提示词带上名称与色情相似（m27217）', () => {
    const src = read('src/features/compare/sources.js');
    truthy(src.indexOf("subtitle: ['副标题'") >= 0, '抓取字段要认副标题');
    const html = read('options/options.html');
    truthy(html.indexOf('id="risk-lex-note"') >= 0, '设置页要能填备注');
    const opt = read('options/options.js');
    truthy(opt.indexOf("'data-note'") >= 0, '备注按词回到 custom 里存');
    const ai = read('background/ai.js');
    truthy(ai.indexOf('色情软件') >= 0, '提示词要点明图标是否与色情软件相似');
    truthy(ai.indexOf('主标题-副标题') >= 0, '提示词用拼好的名称');
    const cfg = read('src/core/config.js');
    truthy(cfg.indexOf('RISK_NOTE_MAX') >= 0, '备注长度要有上限');
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

  await test('★ 接线契约：模块进 manifest、卡片出体检条、深查自动排队且回填', () => {
    const mf = read('manifest.json');
    truthy(mf.indexOf('"src/features/risk-audit.js"') >= 0, '新增模块必须进 manifest（单测也按它加载）');
    truthy(mf.indexOf('src/features/risk-audit.js') < mf.indexOf('src/features/important-note.js'), '要先于面板加载');

    const panel = read('src/features/important-note.js');
    truthy(panel.indexOf('decorateRisk(el, item)') >= 0, '卡片要能出体检条');
    truthy(panel.indexOf("'data-kh-verdicts-sig'") >= 0, '同一张卡重复渲染不能重画');
    truthy(panel.indexOf('.khin-verdicts') >= 0, '体检条要按一类一格渲染');
    truthy(panel.indexOf('.khin-ai-line') >= 0, '深查结论要固定占一行');
    truthy(panel.indexOf('this.riskEnqueue(key, cardName, res.icon, res.dev)') >= 0, '深查不用点，进卡即排队（开发者一起带上）');
    truthy(panel.indexOf('res.name || res.title') >= 0, '名称按主标题-副标题拼起来用');
    truthy(panel.indexOf('khRiskAuditV1') >= 0, '结论要落本地缓存，重开面板能回填');
    truthy(panel.indexOf('MSG.RISK_SCAN') >= 0, '深查走一次性消息，不复用对话端口');

    const ai = read('background/ai.js');
    truthy(ai.indexOf('AI.riskCheck = async function') >= 0);
    truthy(ai.indexOf("credentials: 'include'") >= 0, '图标在后台按站点身份取');
    truthy(ai.indexOf('webSearch: true') >= 0, '深查要联网');
    truthy(ai.indexOf('files: files') >= 0, '有图标才带图');
    truthy(ai.indexOf('parseRisk') >= 0, '只认结构化结论，解析不出来宁可报未查明');

    const sw = read('background/service-worker.js');
    truthy(sw.indexOf('[MSG.RISK_SCAN]') >= 0);
    truthy(sw.indexOf('self.KhAi.riskCheck') >= 0);
  });

  await test('★ 2.0.17.6 开发者/主体参与判定：正版不再被判蹭品牌，同名但不是官方主体算冒充（m26871）', () => {
    /* ① 主体名自带品牌：支付宝（中国）网络技术有限公司做「支付宝」= 官方。 */
    const a1 = R.screen('支付宝', {}, '支付宝（中国）网络技术有限公司');
    eq(a1.level, 0);
    eq(a1.official, '支付宝');
    truthy(a1.hits.some((h) => h.official && h.tag === '官方'), '要说清是按官方处理的');

    /* ② 主体名不带品牌，靠官方主体关键词表：腾讯做「微信」。 */
    eq(R.screen('微信', {}, '深圳市腾讯计算机系统有限公司').level, 0);
    /* ③ 名称含品牌 + 官方主体 = 正版（微信输入法）。 */
    eq(R.screen('微信输入法', {}, '深圳市腾讯计算机系统有限公司').level, 0);
    /* ④ 同名但开发者不是官方主体 = 冒充（2），不再只是「待核」。 */
    const a4 = R.screen('微信', {}, '张三工作室');
    eq(a4.level, 2);
    truthy(a4.hits.some((h) => h.tag === '冒充'), '同名 + 非官方开发者要标成冒充');
    /* ⑤ 没有开发者字段时维持旧口径：同名 2、含品牌 1。 */
    eq(R.screen('微信', {}).level, 2);
    eq(R.screen('微信分身版', {}).level, 1);
    /* ⑥ 开发者与品牌无关时，不能因为主体名里恰好有别的字就放行。 */
    eq(R.screen('微信分身版', {}, '记账小本工作室').level, 1);
    /* ⑦ 敏感词优先：官方主体也洗不掉赌博词。 */
    eq(R.screen('微信赌博', {}, '深圳市腾讯计算机系统有限公司').level, 2);
    /* ⑧ 开发者进缓存键：同名不同开发者不能共用旧结论。 */
    truthy(R.cacheKey('微信', '', '腾讯') !== R.cacheKey('微信', '', '张三工作室'), '换了开发者要换缓存键');
    eq(R.cacheKey('微信', '', ''), R.cacheKey('微 信·', '', ''), '没有开发者时键仍按名称归一');

    const panel = read('src/features/important-note.js');
    truthy(panel.indexOf('RA.cacheKey(cardName, res.icon, res.dev)') >= 0, '面板的缓存键要带开发者，且用主标题-副标题拼的名称');
    truthy(panel.indexOf("dev: job.dev || ''") >= 0, '深查请求要把开发者一起发给后台');
    truthy(panel.indexOf('V.riskOfficial') >= 0, '官方主体要在卡里说明，不只是静默放行');
    const ai = read('background/ai.js');
    truthy(ai.indexOf("'开发者/主体：' + dev") >= 0, '提示词要带开发者，否则模型仍会按名字判蹭牌');
    const sw = read('background/service-worker.js');
    truthy(sw.indexOf("dev: (msg && msg.dev) || ''") >= 0, '后台入口要透传开发者');
  });

  await test('★ 缓存键与状态换算：名称归一 + 图标指纹，过期一律当未查明', () => {
    eq(R.cacheKey('微信', ''), R.cacheKey('微 信·', ''), '名称先归一');
    eq(R.cacheKey('', 'data:image/png;base64,AA'), '', '没有名称就没有键（裸图标判不出蹭谁）');
    truthy(R.cacheKey('记账本', 'data:image/png;base64,AA') !== R.cacheKey('记账本', 'data:image/png;base64,BB'),
      '图标变了要换键，否则回填别人的结论');
    eq(R.iconKey('https://cdn.test/a.png?v=1'), R.iconKey('https://cdn.test/a.png?v=2'), '同一张图不同查询串算同一张');
    truthy(R.iconKey('https://a.test/x.png') !== R.iconKey('https://b.test/x.png'), '不同站点不算同一张');

    const now = R.aiState({ at: Date.now(), verdict: 'risky', iconRisk: 'similar' });
    eq(now.title, 'bad');
    eq(now.icon, 'warn');
    falsy(now.stale);
    const old = R.aiState({ at: Date.now() - R.AI_TTL - 1000, verdict: 'safe', iconRisk: 'none' });
    eq(old.title, 'unknown', '过期不许当成「通过」');
    eq(old.icon, 'unknown');
    truthy(old.stale);
    eq(R.aiState(null).title, 'unknown', '没查过 = 未查明');
  });

  await test('★ 2.0.17.5 自定义词生效、逐词停用生效，配置归一不漏（m26374）', () => {
    const norm = KH.Config.normalizeRiskLexicon;
    truthy(typeof norm === 'function', 'Config 要导出词库归一（设置页与判定侧共用一份）');
    eq(R.screen('微信分身版', {}).level, 1, '基线：名称含品牌 = 待核');

    const cfg = { riskLexicon: norm({ custom: [{ w: '极速下款', cat: 'loan' }], disabled: ['微信'] }) };
    eq(R.screen('微信分身版', cfg).level, 0, '停用品牌后不再判它');
    const hit = R.screen('极速下款宝', cfg);
    eq(hit.level, 2, '自定义敏感词 = 高风险');
    truthy(hit.hits.some((h) => h.tag === '违规贷款' && h.word === '极速下款'), '命中要落到对应类别');

    const cur = { riskLexicon: norm({ custom: [{ w: '记账本', cat: 'brand' }] }) };
    eq(R.screen('记账本', cur).level, 2, '自定义品牌也能判同名');

    const dup = norm({ custom: [{ w: ' a ', cat: 'nope' }, { w: 'a', cat: 'fund' }], disabled: [' X ', 'x'] });
    eq(dup.custom.length, 1, '同词只留一条');
    eq(dup.custom[0].cat, 'other', '非法类别回 other');
    eq(dup.disabled.length, 1, '停用清单也要按归一去重');
    eq(norm({ remoteUrl: 'ftp://x' }).remoteUrl, '', '订阅地址只认 http(s)（D 档口子）');
    eq(norm({ remoteUrl: 'https://x.test/l.json' }).remoteUrl, 'https://x.test/l.json');
  });

  await test('★ 2.0.17.5 设置页有词库入口与深查开关，深查模型固定', () => {
    const html = read('options/options.html');
    ['pf-riskAuto', 'risk-lex-list', 'risk-lex-word', 'risk-lex-cat', 'btn-risk-lex-add', 'btn-risk-lex-import', 'btn-risk-lex-export', 'risk-lex-remote']
      .forEach((id) => truthy(html.indexOf('id="' + id + '"') >= 0, '设置页缺 #' + id));
    const js = read('options/options.js');
    truthy(js.indexOf('renderRiskLexicon()') >= 0, '词表要能回显');
    truthy(js.indexOf('KH.Config.normalizeRiskLexicon') >= 0, '保存前走同一份归一');
    truthy(js.indexOf("riskLexSave({ disabled: off })") >= 0, '取消勾选 = 停用该词');
    truthy(js.indexOf("saveNested({ importantNote: { riskAuto: ra.checked === true } })") >= 0, '深查开关写 importantNote.riskAuto');

    const ai = read('background/ai.js');
    truthy(ai.indexOf("const RISK_MODEL = 'deepseek::deepseek-v4.1-flash-1017';") >= 0, '深查模型固定为 deepseek v4.1 flash 1017');
    truthy(ai.indexOf('self.KhTaiji.chat({ model: RISK_MODEL') >= 0, '深查请求要带上这个模型');
  });
};
