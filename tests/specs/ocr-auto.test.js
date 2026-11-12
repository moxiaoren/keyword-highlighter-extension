/* tests/specs/ocr-auto.test.js — 证书 / 授权书自动抽取进表（2026-11-12 用户需求）
 * ----------------------------------------------------------------------------
 * 用户原话：「现在进表依靠著作权人、登记号、授权方、授权人之类的 OCR 命中结果，
 * 没有命中就不会进表。有没有办法实现针对性优化，自动识别对应内容，然后进表展示。」
 *
 * 本 spec 守的是**判据边界**，不是某一张证书的 OCR 逐字结果：
 *   · 认得出文档类型才抽（字段名 → 标题），普通截图一行都不许出；
 *   · 证书只出 著作权人 + 登记号；授权书只出 授权方/被授权方/应用名称/包名/授权期限；
 *   · `被授权方` 不能被 `授权方` 抢走；`登记号` 优先于 `证书号`；
 *   · 值的形状不对宁可少一行（包名不带点、登记号不是编号）。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const fs = require('fs');
const path = require('path');
const { suite, test, eq, truthy } = H;

const CERT = [
  '中华人民共和国国家版权局',
  '计算机软件著作权登记证书',
  '证书号：软著登字第1234567号',
  '软件名称：智慧门店管理系统 V2.0',
  '著作权人：北京知行灵动科技有限公司',
  '登记号：2019SR0456789'
].join('\n');

const AUTH = [
  '计算机软件著作权登记证书授权书',
  '授权方（甲方）：北京知行灵动科技有限公司',
  '被授权方（乙方）：上海云启信息技术有限公司',
  '应用名称：云启助手',
  '包名：com.yunqi.helper',
  '授权期限：2024年1月1日至2026年12月31日'
].join('\n');

const map = (rows) => {
  const o = {};
  for (const r of rows) o[r.label] = r.value;
  return o;
};

module.exports = async function run() {
  const KH = H.loadKernel();
  const A = KH.OcrAuto;

  suite('2.0.10.1 · 证书/授权书自动抽取');

  await test('★ 登记证书：自动出 著作权人 + 登记号（登记号优先于证书号）', () => {
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书', src: 'a.png', text: CERT });
    eq(rows.map((r) => r.label).join(','), '著作权人,登记号');
    const m = map(rows);
    eq(m['著作权人'], '北京知行灵动科技有限公司');
    eq(m['登记号'], '2019SR0456789', '同一张证书上「证书号」在前，但用户点名的是登记号');
    eq(rows[0].doc, 'cert');
  });

  await test('★ 授权书：自动出五个字段，顺序与用户点名一致', () => {
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', src: 'b.png', text: AUTH });
    eq(rows.map((r) => r.label).join(','), '授权方,被授权方,应用名称,包名,授权期限');
    const m = map(rows);
    eq(m['授权方'], '北京知行灵动科技有限公司');
    eq(m['被授权方'], '上海云启信息技术有限公司');
    eq(m['应用名称'], '云启助手');
    eq(m['包名'], 'com.yunqi.helper');
    eq(m['授权期限'], '2024年1月1日至2026年12月31日');
    eq(rows[0].doc, 'auth');
  });

  await test('★ 「被授权方」不会被「授权方」的标签抢走', () => {
    const text = ['APP电子版权证书授权书', '被授权方：上海云启信息技术有限公司', '包名：com.yunqi.helper'].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: 'APP电子版权证书授权书', src: 'c.png', text }));
    truthy(!m['授权方'], '没有「授权方」这一行时不许把「被授权方」的值顶上来');
    eq(m['被授权方'], '上海云启信息技术有限公司');
  });

  await test('★ 认不出文档类型 ⇒ 一行都不出（不许在普通截图里瞎猜）', () => {
    const text = ['营业执照', '统一社会信用代码：91110108MA01ABC123', '法定代表人：张三'].join('\n');
    eq(A.rowsFor({ state: 'done', label: '营业执照', src: 'd.png', text }).length, 0);
    eq(A.docOf({ label: '营业执照', text }), '');
  });

  await test('★ 标签独占一行、值在下一行也能取到', () => {
    const text = ['计算机软件著作权登记证书', '著作权人', '北京知行灵动科技有限公司', '登记号', '2019SR0456789'].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: '登记证书', src: 'e.png', text }));
    eq(m['著作权人'], '北京知行灵动科技有限公司');
    eq(m['登记号'], '2019SR0456789');
  });

  await test('★ 字段名没有信号时，用 OCR 顶部标题认文档类型', () => {
    const text = ['APP电子版权证书', '著作权人：北京知行灵动科技有限公司', '登记号：2020SR0123456'].join('\n');
    eq(A.docOf({ label: '', text }), 'cert');
    const m = map(A.rowsFor({ state: 'done', label: '', src: 'f.png', text }));
    eq(m['著作权人'], '北京知行灵动科技有限公司');
    eq(m['登记号'], '2020SR0123456');
  });

  await test('★ 包名形状不对 ⇒ 只少这一行，别的行照出', () => {
    const text = ['计算机软件著作权登记证书授权书', '被授权方：上海云启信息技术有限公司', '包名：com yunqi helper'].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: '授权书', src: 'g.png', text }));
    eq(m['被授权方'], '上海云启信息技术有限公司');
    truthy(!m['包名'], '不带点的不是包名');
  });

  await test('★ 登记号/授权期限有形状兜底（标签被 OCR 认坏时仍能捞回）', () => {
    const regText = ['计算机软件著作权登记证书', '著作权人：北京知行灵动科技有限公司', '编号 2019SR0456789'].join('\n');
    eq(map(A.rowsFor({ state: 'done', label: '登记证书', src: 'h.png', text: regText }))['登记号'], '2019SR0456789');
    const termText = ['计算机软件著作权登记证书授权书', '授权有效期从 2024-01-01 至 2026-12-31'].join('\n');
    eq(map(A.rowsFor({ state: 'done', label: '授权书', src: 'i.png', text: termText }))['授权期限'], '2024-01-01 至 2026-12-31');
  });

  await test('★ 条目没跑完 / 没文本 ⇒ 不抽', () => {
    eq(A.rowsFor({ state: 'pending', label: '登记证书', text: CERT }).length, 0);
    eq(A.rowsFor({ state: 'done', label: '登记证书', text: '' }).length, 0);
    eq(A.rowsFor(null).length, 0);
  });

  await test('★ 集成契约：进表路径真的接了自动行，且脚本在 manifest 里', () => {
    const root = path.join(__dirname, '..', '..');
    const note = fs.readFileSync(path.join(root, 'src/features/important-note.js'), 'utf8');
    truthy(note.indexOf('KH.OcrAuto') >= 0, 'ocrExtraRows 要读 KH.OcrAuto');
    truthy(note.indexOf('autoApi.rowsFor(it)') >= 0, '逐条目抽行');
    truthy(note.indexOf("pushRow(ar.label, ar.value, ar.src, 'auto')") >= 0, '自动行要带 kind:auto');
    truthy(note.indexOf('if (!words.length && !autoOn) return [];') >= 0, '词表为空时不能提前返回');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const js = (manifest.content_scripts[0] || {}).js || [];
    const iAuto = js.indexOf('src/features/ocr-auto.js');
    truthy(iAuto >= 0, 'manifest 要加载 ocr-auto.js');
    truthy(iAuto < js.indexOf('src/features/important-note.js'), '必须在 important-note 之前加载');
  });
};
