/* tests/specs/compare-core.test.js — 【R1】比对子系统核心：判等唯一实现
 * ----------------------------------------------------------------------------
 * 用户 2026-11-15 拍板：直接重写比对子系统（新目录，不留旧路径）。
 * 本文件只测纯函数：不建 DOM、不读配置存储，锁的是「结论」与「理由标签」。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const C = KH.Compare;

  suite('比对核心 · 判等（R1）');
    test('keyOf：去括号补充 + 全半角/空白折叠', () => {
      eq(C.keyOf('某某（松江）科技有限公司'), C.keyOf('某某科技有限公司'));
      eq(C.keyOf('ＡＢＣ 公司'), C.keyOf('abc公司'));
      eq(C.keyOf('  甲  乙 '), C.keyOf('甲乙'));
    });

    test('pairState：原样一致 / 只差空白 / 一侧空 / 弱值 / 真不同', () => {
      eq(C.pairState('甲乙科技', '甲乙科技').state, 'same');
      eq(C.pairState('甲乙 科技', '甲乙科技').state, 'same');
      eq(C.pairState('甲乙科技', '甲乙科技').how, 'same');
      eq(C.pairState('甲乙科技', '').state, 'unknown');
      eq(C.pairState('甲乙科技', '').missing, 'b');
      eq(C.pairState('', '甲乙科技').missing, 'a');
      eq(C.pairState('', '').state, 'none');
      eq(C.pairState('12', '2024-12-31').state, 'weak');
      eq(C.pairState('甲公司', '乙公司').state, 'diff');
    });

    test('pairState：core 开关只放宽括号补充，默认不放宽', () => {
      eq(C.pairState('某某（松江）公司', '某某公司').state, 'diff');
      eq(C.pairState('某某（松江）公司', '某某公司', { core: true }).state, 'same');
      eq(C.pairState('某某（松江）公司', '某某公司', { core: true }).how, 'fold-core');
    });

    test('pairState：org 开关放行全称/简称，但短词不误绿', () => {
      eq(C.pairState('上海甲甲信息技术有限公司', '甲甲信息技术有限公司', { org: true }).state, 'same');
      eq(C.pairState('上海甲甲信息技术有限公司', '甲甲信息技术有限公司', { org: true }).how, 'contain');
      eq(C.pairState('甲乙', '甲乙丙丁', { org: true }).state, 'diff');
    });

    test('pairState：near 只对长词差一字放宽', () => {
      eq(C.pairState('飞翔的红蜻蜓科技', '飞翔的红蜻挺科技', { near: true }).state, 'same');
      eq(C.pairState('飞翔的红蜻蜓科技', '飞翔的红蜻挺科技', { near: true }).how, 'near');
      /* 单字值先被判成弱值：短值不参与近似比对，比「差一字」更该保护。 */
      eq(C.pairState('甲', '乙', { near: true }).state, 'weak');
    });

  suite('比对核心 · 同一法人（R1）');
    test('名字全等 ⇒ same，不用法人', () => {
      const r = C.legalRep({ name: '甲公司' }, { name: '甲公司' });
      eq(r.state, 'same');
      eq(r.by, 'name');
    });

    test('名字不同但法人同名 ⇒ same / 法人不同 ⇒ diff', () => {
      eq(C.legalRep({ name: '甲公司', rep: '张三' }, { name: '乙公司', rep: '张三' }).state, 'same');
      eq(C.legalRep({ name: '甲公司', rep: '张三' }, { name: '乙公司', rep: '李四' }).state, 'diff');
    });

    test('个人当主体 ⇒ 本人即法人；缺法人 ⇒ unknown', () => {
      eq(C.isPersonName('张三'), true);
      eq(C.isPersonName('买买提·艾力'), true);
      eq(C.isPersonName('甲甲科技有限公司'), false);
      eq(C.legalRep({ name: '张三' }, { name: '乙公司', rep: '张三' }).state, 'same');
      eq(C.legalRep({ name: '甲公司' }, { name: '乙公司' }).state, 'unknown');
    });

  suite('比对核心 · 隐私政策正文（R1）');
    test('原文 / 括号补充 / 行政区划 / 差一字 四级命中', () => {
      const body = '本政策由上海松江融媒体中心制定，适用于某某清理大师。';
      eq(C.policyMatch(body, '上海松江融媒体中心').mode, 1);
      eq(C.policyMatch(body, '上海松江融媒体中心（松江报社）').mode, 2);
      eq(C.policyMatch('本政策由上海市松江区融媒体中心制定', '上海松江融媒体中心').mode, 3);
      eq(C.policyMatch('本政策由某某清理大师提供', '某某清理大师APP', 'title').mode, 2);
      eq(C.policyMatch('本政策由飞翔的红蜻蜓科技提供', '飞翔的红蜻挺科技').mode, 4);
    });

    test('linkHit：整串没有就只看域名；null = 没这个字段', () => {
      eq(C.linkHit('详见 https://www.example.com/privacy 页面', 'https://example.com/privacy'), true);
      eq(C.linkHit('详见 example.com 页面', 'https://www.example.com/privacy'), true);
      eq(C.linkHit('没有任何链接', ''), null);
      eq(C.linkHit('没有任何链接', 'https://example.com'), false);
    });

    test('policyVerdict：全中 ok；缺一项 false 且 missing 说清', () => {
      const ok = C.policyVerdict({ title: '某某清理大师', dev: '甲甲公司', policy: '本政策适用于某某清理大师，由甲甲公司提供。' });
      eq(ok.ok, true);
      eq(ok.missing.length, 0);
      const bad = C.policyVerdict({ title: '某某清理大师', dev: '乙乙公司', policy: '本政策适用于某某清理大师，由甲甲公司提供。' });
      eq(bad.ok, false);
      eq(C.policyVerdict({ policy: '太短' }), null);
      /* 没有标题/开发者/链接 ⇒ 一个可比的项都没有，返回 null（与旧 note-check 口径一致）。 */
      eq(C.policyVerdict({ policy: '本政策适用于某某清理大师，由甲甲公司提供。' }), null);
    });

    test('★ 通用模板页：正文没写主体名、链接参数里有 ⇒ 算命中（mode 5），并标出来源', () => {
      /* 真实案例：agreement-*.cos 的 ysxy.html 正文 7845 字里一个主体名都没有，
       * App 名与公司在 ?appName= / ?appTheme= 里；以前会误判「不一致」。 */
      const url = 'https://x.test/util/ysxy.html?appName=' + encodeURIComponent('企业信息信用查询帮')
        + '&appTheme=' + encodeURIComponent('上海昂思通科技有限责任公司杭州第五分公司');
      const v = C.policyVerdict({
        title: '企业信息信用查询帮',
        dev: '上海昂思通科技有限责任公司杭州第五分公司',
        url: url,
        policy: '本政策适用于（以下简称“我们”）在中国大陆提供的APP及相关产品和服务。联系方式为 users_feedback@126.com。'
      });
      truthy(v && v.ok, '正文是通用模板、参数里有 ⇒ 一致');
      eq(v.paramUsed, 2, '两项都来自链接参数');
      eq(v.items.map((it) => it.mode).join(','), '5,5');
    });

    test('★ 正文里写了别家名字 ⇒ 仍然判不一致（参数命中不许掩盖真差异）', () => {
      const v = C.policyVerdict({
        title: '甲应用',
        dev: '乙乙科技有限公司',
        url: 'https://x.test/p?appName=' + encodeURIComponent('甲应用'),
        policy: '甲应用的隐私政策由丙丙科技有限公司提供。'
      });
      eq(v.ok, false, '正文里是丙丙公司，开发者是乙乙公司 ⇒ 不一致');
      eq(v.items.filter((it) => !it.hit).map((it) => it.key).join(','), 'dev');
    });

    test('★ 链接没有查询参数 ⇒ 不做参数兜底（还是按正文判断）', () => {
      const v = C.policyVerdict({ title: '甲应用', dev: '乙乙科技有限公司', url: 'https://x.test/p',
        policy: '甲应用的隐私政策正文。' });
      eq(v.ok, false);
      eq(C.paramHit('https://x.test/p', '甲应用'), false);
      eq(C.paramHit('https://x.test/p?a=' + encodeURIComponent('甲应用'), '甲应用'), true);
      eq(C.paramHit('https://x.test/p?a=%E7%94%B2', '甲'), false, '单字太短不参与');
    });

  suite('比对核心 · 标记与底色（R1）');
    test('七态文案唯一真源；未知态返回 null', () => {
      eq(C.markOf('same').label, '✔ 一致');
      eq(C.markOf('ok').label, '✔ 一致');
      eq(C.markOf('diff').label, '⚠ 待确认');
      eq(C.markOf('unknown').label, '？ 未查明');
      eq(C.markOf('timeout').label, '⏱ 超时');
      eq(C.markOf('unset').label, '⚙ 待配置');
      eq(C.markOf('weak'), null);
      eq(C.markOf(''), null);
    });

    test('只有一致/不一致涂色，其余不涂', () => {
      eq(C.colorOf('same'), C.COLOR_OK);
      eq(C.colorOf('ok'), C.COLOR_OK);
      eq(C.colorOf('diff'), C.COLOR_BAD);
      eq(C.colorOf('warn'), C.COLOR_BAD);
      eq(C.colorOf('unknown'), '');
      eq(C.colorOf('unset'), '');
      eq(C.colorOf('timeout'), '');
    });
};
