/* tests/specs/compare-center.test.js — 【T5】校验中心：三处配置的只读汇总
 * ----------------------------------------------------------------------------
 * 用户 m09277 起做 T5（专家报告 pm.md「校验中心」）：一屏列出「图怎么取 / 谁和谁比 /
 * 放行哪些平台」，并标出当前是默认值还是改过。
 * 本文件只测纯函数 KH.Compare.Center.summary(cfg)，不碰设置页 DOM。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const Center = KH.Compare.Center;
  const cfgOf = (over) => Object.assign({}, over || {});

  suite('校验中心 · T5（图怎么取 / 谁和谁比 / 放行哪些平台）');

  await test('默认配置：三项都在，且都标「默认」', () => {
    const items = Center.summary(cfgOf());
    eq(items.length, 3);
    eq(items.map((x) => x.key).join(','), 'ocr,pairs,allow');
    eq(items[0].tag, '默认');
    eq(items[1].tag, '默认');
    eq(items[2].tag, '默认');
    truthy(items[2].text.indexOf('vivo') >= 0 && items[2].text.indexOf('维沃') >= 0, items[2].text);
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

  await test('谁和谁比：配了额外的对 ⇒ 原样列出，并说明优先于内置兜底', () => {
    const items = Center.summary(cfgOf({ imgCompare: { on: true, rows: [{ left: '著作权人', right: '授权公司' }] } }));
    eq(items[1].text, '著作权人 ↔ 授权公司');
    eq(items[1].tag, '已改');
    truthy(items[1].hint.indexOf('优先') >= 0, items[1].hint);
  });

  await test('谁和谁比：总开关关掉 ⇒ 明说一律不判', () => {
    const items = Center.summary(cfgOf({ imgCompare: { on: false, rows: [] } }));
    truthy(items[1].text.indexOf('已关闭') >= 0, items[1].text);
    eq(items[1].tag, '已改');
  });

  await test('★ 放行哪些平台：改过名单 ⇒ 标已改，并回显默认名单做对照', () => {
    const items = Center.summary(cfgOf({ noteCheck: { promiseOk: ['某平台'] } }));
    eq(items[2].text, '某平台');
    eq(items[2].tag, '已改');
    truthy(items[2].hint.indexOf('默认：vivo、维沃、天宸') >= 0, items[2].hint);
  });

  await test('图怎么取：改了引擎/上限也算「已改」', () => {
    const items = Center.summary(cfgOf({ imgOcr: { engine: 'tesseract', defaultMax: 6, crossOriginSites: { 'a.com': true } } }));
    truthy(items[0].text.indexOf('只用兼容引擎') >= 0, items[0].text);
    truthy(items[0].text.indexOf('6 张') >= 0, items[0].text);
    truthy(items[0].text.indexOf('跨域放行 1 个站点') >= 0, items[0].text);
    eq(items[0].tag, '已改');
  });
};
