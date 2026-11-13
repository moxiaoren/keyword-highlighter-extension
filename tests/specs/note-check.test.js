/* tests/specs/note-check.test.js — 【2.0.8.8 需求②③】隐私政策校验 / 同法人校验
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-05 原话）：
 *   · 「把隐私政策那一行底色修改，如果都有就浅绿色，存在没有的就浅黄色
 *      （然后在标题单元格插入“名”，“开”的小图标）」
 *   · 「我说的隐私政策和隐私政策链接都是卡片里抓取字段，也就是表格标题。
 *      抓取到的内容就是隐私政策链接」
 *   · 「免费免登陆渠道搜索这两个公司是否同法人（开发者或者核准主体名称是个人时，
 *      如果这个个人就是法人也算同法人）」；查不到 = 未查明，不改底色。
 * 这里锁的是**纯判定**（取字段 / 子串口径 / 人名判定 / 法人比较 / 法人名解析），
 * 面板上的底色与徽标由真浏览器 e2e 覆盖。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 后台模块不是 content_scripts，单测里用独立沙盒加载（不污染内核的 window.KH）。 */
function loadEntity() {
  const mem = {};
  const chrome = {
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : Object.assign({}, mem)),
        set: async (o) => { Object.assign(mem, o); }
      }
    }
  };
  const sandbox = {
    console: console,
    chrome: chrome,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    fetch: async () => { throw new Error('单测不联网'); }
  };
  sandbox.self = sandbox;
  sandbox.KH = {};
  vm.createContext(sandbox);
  vm.runInContext(read('background/entity.js'), sandbox, { filename: 'background/entity.js' });
  return sandbox.KH.Entity;
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const NC = KH.NoteCheck;
  const Entity = loadEntity();

  const table = (rows) => H.el('table', { class: 'kh-table kh-table-fetch' }, rows);
  const row = (label, value, cls) => H.el('tr', { class: cls || '' }, [
    H.el('td', { class: 'kh-table-label' }, [label]),
    H.el('td', {}, [value == null ? '' : value])
  ]);

  suite('note-check · 取字段（表格标题就是字段名）');

  await test('字段别名：隐私政策 / 隐私权政策 → policy，开发者 / 开发商 → dev，核准主体 → entity', () => {
    eq(NC.fieldKey('隐私政策'), 'policy');
    eq(NC.fieldKey('隐私权政策'), 'policy');
    eq(NC.fieldKey('开发者'), 'dev');
    eq(NC.fieldKey('开发商'), 'dev');
    eq(NC.fieldKey('核准主体名称'), 'entity');
    eq(NC.fieldKey('隐私政策链接'), 'link');
    eq(NC.fieldKey('主标题'), 'title');
    eq(NC.fieldKey('包名'), '', '没登记过的字段名不认');
  });

  await test('readFields：一行一个字段，合并行（kh-merge-row）不许当字段', () => {
    const t = table([
      row('主标题', '某某清理大师'),
      row('开发者', '北京某某科技有限公司'),
      row('隐私政策', '本隐私政策说明……'),
      row('开发者', '这不是真字段', 'kh-merge-row')
    ]);
    const f = NC.readFields(t);
    eq(f.title, '某某清理大师');
    eq(f.dev, '北京某某科技有限公司');
    eq(f.policy, '本隐私政策说明……');
    eq(f.entity, '', '没这一行就是空串');
  });

  /* 【2.0.8.9 需求③】用户报的「隐私政策里明明有，小标却说没有；底色变绿了还说没有」。
   * 根因：paintPolicy 把「名」「开」两枚徽标 append 进左列（字段名单元格），下一轮读
   * `td.textContent` 就变成「隐私政策名开」⇒ fieldKey 全等失配 ⇒ 该行从 fields 里消失。
   * 这条锁住：左列带徽标时字段名照样认得出来、判定结论不翻转。 */
  await test('readFields：左列带「名」「开」徽标时仍认得出字段（否则绿底也会被判成没有）', () => {
    const flag = (t, hit) => H.el('span', { class: 'kh-policy-flag ' + (hit ? 'is-hit' : 'is-miss'), title: t }, [t]);
    const t = table([
      row('主标题', '某某清理大师'),
      row('开发者', '北京某某科技有限公司'),
      H.el('tr', {}, [
        H.el('td', { class: 'kh-table-label' }, ['隐私政策', flag('名', true), flag('开', false)]),
        H.el('td', {}, ['本隐私政策由某某清理大师提供。'])
      ])
    ]);
    const f = NC.readFields(t);
    eq(f.policy, '本隐私政策由某某清理大师提供。', '徽标不得污染字段名');
    const v = NC.policyVerdict(f);
    truthy(v, '有正文就该给判定，不能因为徽标而变 null');
    eq(v.items.map((i) => i.key).join(','), 'title,dev', '主标题 / 开发者都要参与判定');
    truthy(v.items[0].hit, '主标题在正文里 ⇒ 命中');
    falsy(v.items[1].hit, '这家公司不在正文里 ⇒ 没命中（该黄就黄，不能假绿）');
  });

  /* 【2.0.8.14】用户报的「校验应用名称和开发者是否一致似乎还是有问题」。
   * 根因：抓取表会把**值完全相同**的字段合并成一行（fetch.js rowsToTableHtml），标签格变成
   *   `<span class="kh-lbt">开发者</span><details>2 … 开发者 / 核准主体名称</details>`
   * 旧 labelText 读 textContent 得到「开发者2开发者核准主体名称」⇒ fieldKey 失配 ⇒ 「开发者」
   * 被静默吞掉，只剩主标题参与判定 ⇒ 主标题在正文里就涂绿（假绿），同法人校验也整条跳过。
   * 这两条用**真的渲染函数**造表，锁住「合并行里的每个字段都要读出来」。 */
  const mergedTable = () => {
    const html = KH.Fetch.rowsToTableHtml([
      { label: '主标题', rows: [[{ t: '某某清理大师' }]], opt: null },
      { label: '开发者', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      { label: '核准主体名称', rows: [[{ t: '北京某某科技有限公司' }]], opt: null },
      { label: '隐私政策', rows: [[{ t: '某某清理大师由北京某某科技有限公司运营。' }]], opt: null }
    ]);
    const div = H.el('div', {}, []);
    div.innerHTML = html;
    return div.querySelector('table');
  };

  await test('labelsOf / fieldKeysOf：合并标签要把全部字段名拆出来，labelText 只给最短那个', () => {
    const tds = mergedTable().querySelectorAll('tr')[1].querySelectorAll('td');
    eq(NC.labelText(tds[0]), '开发者', '合并行取 .kh-lbt 的短名，不再带着「2 + 全部字段名」');
    eq(NC.labelsOf(tds[0]).join('/'), '开发者/核准主体名称');
    eq(NC.fieldKeysOf(tds[0]).join(','), 'dev,entity', '两个字段都要认出来');
  });

  await test('readFields：开发者与核准主体同值合并 ⇒ 两个字段都读到，判定里不许只剩主标题（假绿回归）', () => {
    const t = mergedTable();
    const f = NC.readFields(t);
    eq(f.dev, '北京某某科技有限公司', '合并行里的「开发者」不许被吞');
    eq(f.entity, '北京某某科技有限公司');
    const v = NC.policyVerdict(f);
    eq(v.items.map((i) => i.key).join(','), 'title,dev', '开发者必须参与判定');
    truthy(v.ok);
    /* 反例：正文只有主标题没有公司名 ⇒ 必须变黄（旧代码这里会绿） */
    const v2 = NC.policyVerdict({ title: '某某清理大师', dev: '北京某某科技有限公司', policy: '某某清理大师隐私政策正文，我们重视您的隐私。' });
    falsy(v2.ok, '开发者不在正文里就不能涂绿');
    eq(v2.items.filter((i) => !i.hit).map((i) => i.key).join(','), 'dev');
  });

  await test('labelText：只剥徽标文本，字段名本身一个字不动', () => {
    const td = H.el('td', {}, ['隐私政策', H.el('span', { class: 'kh-policy-flag' }, ['名'])]);
    eq(NC.labelText(td), '隐私政策');
    eq(NC.labelText(null), '');
  });

  /* 同一个坑的第二个入口：徽标文字「名」本身也是字段名的一部分。
   * 「应用名称」+「名」+「开」⇒ 只能从末尾剥两个后缀，全局删会把字段名改成「应用称」，
   * 等于把「字段丢了所以报没有」换个入口复发。 */
  await test('labelText：字段名含「名」时不被徽标吃掉（应用名称 / 软件名称）', () => {
    const flags = () => [H.el('span', { class: 'kh-policy-flag' }, ['名']), H.el('span', { class: 'kh-policy-flag' }, ['开'])];
    const td = H.el('td', {}, ['应用名称'].concat(flags()));
    eq(td.textContent, '应用名称名开', '前提：徽标是 append 到末尾的');
    eq(NC.labelText(td), '应用名称', '只剥后缀');
    eq(NC.fieldKey(NC.labelText(td)), 'title', '剥完仍是 title 字段');
    /* 连读两轮也不许越读越少（paintPolicy 每轮都会重贴徽标） */
    eq(NC.labelText(td), '应用名称');
    const td2 = H.el('td', {}, ['软件名称', H.el('span', { class: 'kh-policy-flag' }, ['名'])]);
    eq(NC.labelText(td2), '软件名称');
    /* 结构被动过（徽标不在末尾）时宁可不动，也不乱删 */
    const odd = H.el('td', {}, [H.el('span', { class: 'kh-policy-flag' }, ['名']), '隐私政策']);
    eq(NC.labelText(odd), '名隐私政策', '不是后缀就不剥（宁可这条认不出，也不能改字）');
  });

  suite('note-check · 子串口径');

  await test('contains：忽略空白与换行（政策正文常把公司名断行）', () => {
    truthy(NC.contains('北京某某\n科技有限 公司', '北京某某科技有限公司'));
    truthy(NC.contains('开发者：北京某某科技有限公司', '北京某某科技有限公司'));
  });

  await test('contains：目标不足 2 字不判（单字人名会全员命中，宁可标没查到）', () => {
    falsy(NC.contains('王小明', '王'));
  });

  await test('contains：截断值只比省略号之前那段', () => {
    truthy(NC.contains('某某清理大师专业版', '某某清理大师…'));
  });

  suite('note-check · 需求② 隐私政策校验');

  await test('三项都在 ⇒ ok=true，并给出 名 / 开 / 链接 三项明细', () => {
    const v = NC.policyVerdict({
      title: '某某清理大师',
      dev: '北京某某科技有限公司',
      link: 'https://www.example.com/privacy',
      policy: '某某清理大师由北京某某科技有限公司运营，详见 https://www.example.com/privacy'
    });
    truthy(v && v.ok);
    eq(v.items.length, 3);
    eq(v.items.map((i) => i.key).join(','), 'title,dev,content');
  });

  await test('开发者不在正文里 ⇒ ok=false（这一行要变浅黄）', () => {
    const v = NC.policyVerdict({
      title: '某某清理大师',
      dev: '北京某某科技有限公司',
      policy: '某某清理大师隐私政策：我们重视您的隐私。'
    });
    falsy(v.ok);
    eq(v.items.filter((i) => !i.hit).map((i) => i.key).join(','), 'dev');
  });

  await test('链接整串没有时退一步只看域名', () => {
    const v = NC.policyVerdict({
      title: '甲应用',
      link: 'https://privacy.example.com/policy?id=1',
      policy: '甲应用的隐私政策见 privacy.example.com'
    });
    truthy(v.items.filter((i) => i.key === 'content')[0].hit);
  });

  await test('没有隐私政策正文 / 正文太短（抓的是按钮文字）⇒ 不判、不涂色', () => {
    eq(NC.policyVerdict({ title: '甲', policy: '' }), null);
    eq(NC.policyVerdict({ title: '甲', policy: '查看隐私政策' }), null);
  });

  suite('note-check · 需求③ 同法人校验');

  await test('人名判定：个人名是自然人，带公司/工作室等字样的是单位', () => {
    truthy(NC.isPersonName('张伟'));
    truthy(NC.isPersonName('买买提·艾力'));
    falsy(NC.isPersonName('北京某某科技有限公司'));
    falsy(NC.isPersonName('某某网络工作室'));
    falsy(NC.isPersonName('')); 
  });

  await test('两边查到同一法人 ⇒ same；不同 ⇒ diff', () => {
    eq(NC.sameLegalRep({ name: '北京甲科技有限公司', rep: '张伟' },
      { name: '上海乙信息有限公司', rep: '张伟' }), 'same');
    eq(NC.sameLegalRep({ name: '北京甲科技有限公司', rep: '张伟' },
      { name: '上海乙信息有限公司', rep: '李娜' }), 'diff');
  });

  await test('任一侧是个人：本人就是法人（个人 vs 公司法人同名也算 same）', () => {
    eq(NC.sameLegalRep({ name: '张伟' }, { name: '上海乙信息有限公司', rep: '张伟' }), 'same');
    eq(NC.sameLegalRep({ name: '张伟' }, { name: '上海乙信息有限公司', rep: '李娜' }), 'diff');
  });

  await test('同一主体名不用查也是 same；查不到法人 ⇒ unknown（不改底色）', () => {
    eq(NC.sameLegalRep({ name: '北京甲科技有限公司' }, { name: '北京甲科技有限公司' }), 'same');
    eq(NC.sameLegalRep({ name: '北京甲科技有限公司', rep: '' },
      { name: '上海乙信息有限公司', rep: '张伟' }), 'unknown');
    eq(NC.sameLegalRep({ name: '', rep: '张伟' }, { name: '上海乙信息有限公司', rep: '张伟' }), 'unknown');
  });

  await test('归属括号不参与比较（「北京甲科技有限公司（分公司）」）', () => {
    eq(NC.sameLegalRep({ name: '北京甲科技有限公司（朝阳分公司）' },
      { name: '北京甲科技有限公司' }), 'same');
  });

  suite('entity · 法定代表人解析（免费免登陆通道的解析口径）');

  await test('parseRep：结构化 JSON（爱企查 legalPerson）优先', () => {
    eq(Entity.parseRep('<script>window.pageData={"result":{"legalPerson":"雷军"}}</script>'), '雷军');
  });

  await test('parseRep：正文「法定代表人：雷军」', () => {
    eq(Entity.parseRep('<div>法定代表人：雷军</div>'), '雷军');
  });

  await test('parseRep：表格拍平后没有冒号也能认（法定代表人 雷军）', () => {
    eq(Entity.parseRep('<table><tr><td>法定代表人</td><td>雷军</td></tr></table>'), '雷军');
  });

  await test('parseRep：「法定代表人信息」这类不是人名，不许当成一个人', () => {
    eq(Entity.parseRep('<div>法定代表人信息</div>'), '');
  });

  await test('parseRep：页面上根本没有 ⇒ 空串（面板据此保持原底色）', () => {
    eq(Entity.parseRep('<div>公司简介</div>'), '');
  });

  /* ---- 2026-11-05 收紧：先锁定查询名，再在它附近取法人 ---- */

  await test('parseRep 收紧：同页有多家公司 ⇒ 只认查询名附近那一家', () => {
    const pad = '填'.repeat(600);
    const html = '<script>{"entName":"甲公司","legalPerson":"张三"}</script>' + pad +
      '<script>{"entName":"乙公司","legalPerson":"李四"}</script>';
    eq(Entity.parseRep(html, '甲公司'), '张三');
  });

  await test('parseRep 收紧：页面只有别家公司的法人 ⇒ 空串，绝不按一个错的法人去涂色', () => {
    const pad = '填'.repeat(900);
    const html = pad + '<script>{"legalPerson":"王五"}</script>';
    eq(Entity.parseRep(html, '甲公司'), '');
  });

  await test('parseRep 收紧：机构词尾巴、单字都不算人名', () => {
    eq(Entity.parseRep('<div>法定代表人：张三工作室</div>'), '');
    eq(Entity.parseRep('<div>法定代表人：李</div>'), '');
  });

  /* ---- 2026-11-11 同法人链路：360 企业卡（唯一稳定通道） ---- */

  await test('parseRep：360 企业卡「法定代表人 李广朝他投资的」要在「他」处截断', () => {
    const html = '<div>企业名称 北京知行灵动科技有限公司 统一社会信用代码 91110108575197959C '
      + '法定代表人 李广朝他投资的 1 家公司 经营状态 开业</div>';
    eq(Entity.parseRep(html, '北京知行灵动科技有限公司'), '李广朝', '粘连的卡片标签不许进人名');
  });

  await test('parseRep：两字人名后面紧跟「他投资的」也要完整取到', () => {
    eq(Entity.parseRep('<div>企业名称 小米科技有限责任公司 法定代表人 雷军他投资的 81 家公司</div>',
      '小米科技有限责任公司'), '雷军');
  });

  await test('parseRep：搜索结果页标题里的「法定代表人_360搜索」不许当人名', () => {
    eq(Entity.parseRep('<div>法定代表人_360搜索</div>'), '');
    eq(Entity.parseRep('<div>法定代表人 搜索 企业信息</div>'), '');
  });

  await test('parseRep 收紧：拍平正文也要求查询名在附近', () => {
    const pad = '填'.repeat(900);
    eq(Entity.parseRep('<div>' + pad + '法定代表人：李四</div>', '甲公司'), '');
    eq(Entity.parseRep('<div>甲公司 基本信息 法定代表人：李四</div>', '甲公司'), '李四');
  });

  await test('查询不联网时如实返回 ok:false（未查明，不编造法人）', async () => {
    const r = await Entity.lookup({ name: '北京某某科技有限公司' });
    falsy(r.ok);
    truthy(r.error);
  });

  /* ------------------------------------------------------------------
   * 【2.0.8.22】用户 2026-11-11 报的 5 个「正文里明明有，插件说没有」。
   * 这里锁的是「写法差异可以放宽、是不是同一家不许放宽」：
   *   · 括号补充说明省略；
   *   · 单位名行政区划写法不同（上海市松江区 ↔ 上海松江）；
   *   · 主标题带 APP / 客户端后缀；
   *   · 反面：换了字/换了公司的，必须仍然判「没有」。
   * ------------------------------------------------------------------ */
  suite('note-check · 2.0.8.22 写法差异容错（不许放宽成假绿）');

  await test('单位名行政区划写法不同也算命中：卡片「上海市松江区融媒体中心」，正文「上海松江融媒体中心」', () => {
    const policy = '本政策由上海松江融媒体中心（或简称“我们”）制定，说明个人信息的收集与使用规则。';
    truthy(NC.contains(policy, '上海市松江区融媒体中心（松江报社、上海市松江区广播电视台）'),
      '省/市/区写法差异不能把同一家单位判成没有');
    const v = NC.policyVerdict({
      title: '上海松江',
      dev: '上海市松江区融媒体中心（松江报社、上海市松江区广播电视台）',
      policy: policy
    });
    truthy(v && v.ok, '主标题与开发者都应命中 ⇒ 绿');
  });

  await test('括号补充说明省略也算命中：卡片「银飞数智（广东）科技有限公司」，正文「银飞数智科技有限公司」', () => {
    truthy(NC.contains('本政策由银飞数智科技有限公司提供。', '银飞数智（广东）科技有限公司'));
    truthy(NC.contains('本政策由银飞数智科技有限公司提供。', '银飞数智(广东)科技有限公司'), '半角括号同样处理');
  });

  await test('主标题带 APP / 客户端后缀：正文只写名字也算命中（仅 title 这一项放宽）', () => {
    truthy(NC.contains('本政策适用于某某清理大师。', '某某清理大师APP', 'title'));
    truthy(NC.contains('本政策适用于某某清理大师。', '某某清理大师客户端', 'title'));
    falsy(NC.contains('本政策适用于某某清理大师。', '某某清理大师APP'), '不带 kind 时不放宽，避免普通词被截短');
  });

  await test('反面：换了字/换了公司必须仍然判「没有」', () => {
    falsy(NC.contains('本政策由北京某某信息技术有限公司运营。', '北京某某科技有限公司'),
      '科技 ≠ 信息技术：近似不能宽到把两家公司判成一家');
    falsy(NC.contains('本政策适用于有鑫花。', '有盘花'), 'OCR 认错字就是认错字，不许猜');
    falsy(NC.contains('本政策由王小明提供。', '王'), '单字仍不判');
    falsy(NC.contains('本政策由上海某某贸易有限公司提供。', '上海市松江区融媒体中心'),
      '同城不同公司不能靠行政区划近似命中');
  });

  await test('matchMode 说清命中程度：原文 1 / 括号省略 2 / 行政区划 3 / 没中 0', () => {
    eq(NC.matchMode('本政策由北京某某科技有限公司提供。', '北京某某科技有限公司'), 1);
    eq(NC.matchMode('本政策由银飞数智科技有限公司提供。', '银飞数智（广东）科技有限公司'), 2);
    eq(NC.matchMode('本政策由上海松江融媒体中心制定。', '上海市松江区融媒体中心（松江报社、上海市松江区广播电视台）'), 3);
    eq(NC.matchMode('本政策由有鑫花提供。', '有盘花'), 0);
    const v = NC.policyVerdict({ title: '上海松江', dev: '上海市松江区融媒体中心', policy: '本政策由上海松江融媒体中心制定，详细说明了个人信息处理规则。' });
    truthy(v && v.ok);
    eq(v.items.filter((x) => x.key === 'dev')[0].mode, 3, '界面靠 mode 补「写法略有差异」');
  });

  await test('★ 需求①：卡片值被 OCR/录入认错 1 个字，长词按近似命中（sknow「红蜻挺」/「红蜻蜓」）', () => {
    eq(NC.matchMode('飞翔的红蜻蜓是一款休闲游戏。', '飞翔的红蜻挺'), 4);
    const v = NC.policyVerdict({
      title: '飞翔的红蜻挺',
      dev: '北京知行灵动科技有限公司',
      policy: '本政策由北京知行灵动科技有限公司提供。飞翔的红蜻蜓是一款休闲游戏。'
    });
    truthy(v && v.ok, '错 1 个字也应按近似命中 ⇒ 整行绿');
    eq(v.items.filter((x) => x.key === 'title')[0].mode, 4, '界面据此说明「差 1 个字」');
  });

  await test('反面：近似只放长词、只放 1 个字、不放纯数字/编号', () => {
    eq(NC.matchMode('本政策由有鑫花提供。', '有盘花'), 0, '3 字短词差一个字就是另一个词，不许近似');
    eq(NC.matchMode('登记号 2018SR458983 已登记。', '2018SR458984'), 0, '编号差一位就是另一个号');
    eq(NC.matchMode('本政策由北京某某信息技术有限公司提供。', '北京某某科技有限公司'), 0, '两家不同公司不许近似');
  });

  /* 【2026-11-13 用户需求】营业执照/资质抽出的「企业名称」要跟开发者比对；承诺函判承诺对象。
   * 抽取层（ocr-auto）只负责抽得对，绿/黄口径全部收在这里，面板只照着画。 */
  suite('note-check · 2.0.10.1 资质企业名比对 / 承诺对象判定');

  await test('企业名称与开发者一致 ⇒ 绿；不一致 ⇒ 黄；缺开发者 ⇒ 不涂色', () => {
    const same = NC.qualVerdict('北京知行灵动科技有限公司', '北京知行灵动科技有限公司');
    eq(same.state, 'same');
    eq(same.color, NC.COLOR_OK);
    const diff = NC.qualVerdict('北京知行灵动科技有限公司', '上海乙信息技术有限公司');
    eq(diff.state, 'diff');
    eq(diff.color, NC.COLOR_BAD);
    const none = NC.qualVerdict('北京知行灵动科技有限公司', '');
    eq(none.state, 'unknown');
    eq(none.color, '', '没有开发者就不许凭猜涂色');
  });

  await test('企业名称允许括号补充说明/空白差异，但不许把短名当同一家', () => {
    const v = NC.qualVerdict('北京知行灵动科技有限公司（甲方）', '北京知行灵动科技有限公司');
    eq(v.state, 'same', '括号补充说明不进比对口径');
    eq(NC.qualVerdict('北京知行灵动科技有限公司', '知行灵动').state, 'diff',
      '只写 4 个字属于写法不明，不能当同一家放绿');
  });

  await test('承诺对象：vivo / 维沃 / 广东天宸 与无指向泛称 ⇒ 绿', () => {
    for (const t of ['维沃移动通信有限公司', 'vivo', '广东天宸网络科技有限公司', '各应用平台', '应用商店', '未指定具体平台']) {
      const v = NC.promiseVerdict(t);
      eq(v.state, 'ok', t + ' 应放行（绿）');
      eq(v.color, NC.COLOR_OK);
    }
  });

  await test('承诺对象：白名单外的平台一律黄，认不出也黄', () => {
    for (const t of ['华为技术有限公司', '小米科技有限责任公司', 'OPPO广东移动通信有限公司',
      '广东欢太科技有限公司', '应用宝', '荣耀终端有限公司', '某某不知名公司']) {
      const v = NC.promiseVerdict(t);
      eq(v.state, 'warn', t + ' 应提示人工确认（黄）');
      eq(v.color, NC.COLOR_BAD);
    }
    eq(NC.promiseVerdict('').state, 'unknown', '空值不涂色');
  });
};
