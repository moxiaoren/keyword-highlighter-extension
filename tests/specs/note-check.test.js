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
};
