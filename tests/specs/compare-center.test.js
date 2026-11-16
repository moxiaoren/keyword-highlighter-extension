/* tests/specs/compare-center.test.js — 【T5】校验中心：两处配置的只读汇总
 * ----------------------------------------------------------------------------
 * 一屏列出「图怎么取 / 谁和谁比」，并标出当前是默认值还是改过。
 * 2026-11-16 用户拍板：承诺对象放行名单整项退场，第三行（放行哪些平台）已删。
 * 本文件只测纯函数 KH.Compare.Center.summary(cfg)，不碰设置页 DOM。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const Center = KH.Compare.Center;
  const cfgOf = (over) => Object.assign({}, over || {});

  suite('校验中心 · T5（图怎么取 / 谁和谁比）');

  await test('默认配置：两项都在，且都标「默认」', () => {
    const items = Center.summary(cfgOf());
    eq(items.length, 2);
    eq(items.map((x) => x.key).join(','), 'ocr,pairs');
    eq(items[0].tag, '默认');
    eq(items[1].tag, '默认');
  });

  await test('★ 图怎么取：抓取字段带 #图 ⇒ 说清「只要图片」的几个', () => {
    const items = Center.summary(cfgOf({ keywords: [{ fetchLabels: '开发者#图|著作权人' }] }));
    truthy(items[0].text.indexOf('抓取字段 2 个') >= 0, items[0].text);
    truthy(items[0].text.indexOf('1 个「只要图片」') >= 0, items[0].text);
    eq(items[0].tag, '已改');
  });

  await test('图怎么取：抓取字段没勾「只要图片」⇒ 明说图里的值不会进表', () => {
    const items = Center.summary(cfgOf({ keywords: [{ fetchLabels: '开发者|著作权人' }] }));
    truthy(items[0].text.indexOf('没勾「只要图片」') >= 0, items[0].text);
    truthy(items[0].text.indexOf('不会进表') >= 0, items[0].text);
  });

  /* 【2026-11-16】谁和谁比现在只汇总各关键词里标的「比对」（`#比=对象`）；设置页那张全局表已退场。 */
  await test('谁和谁比：汇总关键词里标的对 ⇒ 列出，并指到关键词编辑弹窗', () => {
    const items = Center.summary(cfgOf({ keywords: [{ fetchLabels: '著作权人#比=授权公司' }] }));
    eq(items[1].text, '已标：著作权人 ↔ 授权公司');
    eq(items[1].tag, '已改');
    truthy(items[1].hint.indexOf('关键词') >= 0, items[1].hint);
  });

  await test('谁和谁比：两条关键词标了同一对 ⇒ 只列一次', () => {
    const items = Center.summary(cfgOf({ keywords: [
      { fetchLabels: '著作权人#比=授权公司' },
      { fetchLabels: '授权公司#比=著作权人' }
    ] }));
    eq(items[1].text, '已标：著作权人 ↔ 授权公司', '方向相反也算同一对');
  });

  await test('谁和谁比：没标 ⇒ 明说抓取字段之间不判等', () => {
    const items = Center.summary(cfgOf({}));
    truthy(items[1].text.indexOf('没标') >= 0, items[1].text);
    eq(items[1].tag, '默认');
  });

  await test('图怎么取：改了引擎/上限也算「已改」', () => {
    const items = Center.summary(cfgOf({ imgOcr: { engine: 'tesseract', defaultMax: 6, crossOriginSites: { 'a.com': true } } }));
    truthy(items[0].text.indexOf('只用兼容引擎') >= 0, items[0].text);
    truthy(items[0].text.indexOf('6 张') >= 0, items[0].text);
    truthy(items[0].text.indexOf('跨域放行 1 个站点') >= 0, items[0].text);
    eq(items[0].tag, '已改');
  });
};
