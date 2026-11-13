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
    eq(rows.map((r) => r.label).join(','), '软著授权方,软著被授权方,应用名称,包名,授权期限');
    const m = map(rows);
    eq(m['软著授权方'], '北京知行灵动科技有限公司');
    eq(m['软著被授权方'], '上海云启信息技术有限公司');
    eq(m['应用名称'], '云启助手');
    eq(m['包名'], 'com.yunqi.helper');
    eq(m['授权期限'], '2024年1月1日至2026年12月31日');
    eq(rows[0].doc, 'auth');
    eq(rows[0].kind, 'auth-soft', '软著授权书要标明归属');
  });

  await test('★ 「被授权方」不会被「授权方」的标签抢走', () => {
    const text = ['APP电子版权证书授权书', '被授权方：上海云启信息技术有限公司', '包名：com.yunqi.helper'].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: 'APP电子版权证书授权书', src: 'c.png', text }));
    truthy(!m['APP电子版权授权方'], '没有「授权方」这一行时不许把「被授权方」的值顶上来');
    eq(m['APP电子版权被授权方'], '上海云启信息技术有限公司');
  });

  await test('★ 授权方/被授权方带文档归属：软著与 APP 电子版权不混名', () => {
    const soft = map(A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', src: 's.png', text: AUTH }));
    truthy(soft['软著授权方'] && soft['软著被授权方'], '软著授权书');
    const app = map(A.rowsFor({ state: 'done', label: 'APP电子版权证书授权书', src: 'a.png', text: AUTH }));
    truthy(app['APP电子版权授权方'] && app['APP电子版权被授权方'], 'APP 电子版权授权书');
    truthy(!app['软著授权方'], '不能沿用软著的字段名');
  });

  await test('★ 认不出文档类型 ⇒ 一行都不出（不许在普通截图里瞎猜）', () => {
    /* 2026-11-13：营业执照已升级为「认得出」的文档类型（抽企业名称），
     * 这条改用真正无信号的普通截图，守住「不许瞎猜」本意。 */
    const text = ['会议纪要', '时间：2024年1月1日', '地点：三楼会议室', '参会人：张三、李四'].join('\n');
    eq(A.rowsFor({ state: 'done', label: '会议纪要', src: 'd.png', text }).length, 0);
    eq(A.docOf({ label: '会议纪要', text }), '');
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
    eq(m['软著被授权方'], '上海云启信息技术有限公司');
    truthy(!m['包名'], '不带点的不是包名');
  });

  await test('★ 登记号/授权期限有形状兜底（标签被 OCR 认坏时仍能捞回）', () => {
    const regText = ['计算机软件著作权登记证书', '著作权人：北京知行灵动科技有限公司', '编号 2019SR0456789'].join('\n');
    eq(map(A.rowsFor({ state: 'done', label: '登记证书', src: 'h.png', text: regText }))['登记号'], '2019SR0456789');
    const termText = ['计算机软件著作权登记证书授权书', '授权有效期从 2024-01-01 至 2026-12-31'].join('\n');
    eq(map(A.rowsFor({ state: 'done', label: '授权书', src: 'i.png', text: termText }))['授权期限'], '2024-01-01 至 2026-12-31');
  });

  await test('★ 登记号必须是编号形状：2026SA0112833 出，纯数字不出', () => {
    const mk = (v) => ['计算机软件著作权登记证书', '著作权人：北京知行灵动科技有限公司', '登记号：' + v].join('\n');
    const code = (v) => (map(A.rowsFor({ state: 'done', label: '登记证书', text: mk(v) }))['登记号'] || '');
    eq(code('2026SA0112833'), '2026SA0112833', '年份 + 两位字母 + 数字');
    eq(code('2019SR0456789'), '2019SR0456789');
    eq(code('软著登字第1234567号'), '软著登字第1234567号', '中文形仍认');
    eq(code('20260112833'), '', '纯数字不是登记号（用户点名的毛病）');
    eq(code('12345'), '', '太短不算');
    eq(code('北京知行灵动科技有限公司'), '', '公司名不是登记号');
  });

  await test('★ 反向版式：名字在前、（被授权公司）在后 —— 真实版权授权书样例', () => {
    const SAMPLE = [
      '版权授权书',
      '致趣娱科技（深圳) 有限公司（被授权公司)：',
      '《包包源头》(以下简称“授权应用，软件著作权登记号：2022SR0727825)是我司自是我司白',
      '主研发或有合法分授权的移动应用产品，我司对授权应用拥有独立、完整的著作权或合法授又或合法技',
      '权，足以授权贵司运营授权应用。现我司授予贵司授权应用的运营权，贵司可自行运营授权宁运营授权',
      '应用，也可授权第三方运营授权应用。',
      '在授权期限内，贵司对授权应用享有非独家、不可转让、可分授权的、有限的权利，包括但L，包括但.',
      '不限于：',
      '授权期限：2025年9月12日至2050年12月31 日',
      '授权地域：中国大陆范围'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', src: 'b.png', text: SAMPLE });
    const m = map(rows);
    eq(m['软著被授权方'], '致趣娱科技（深圳) 有限公司', '名字写在标签左边，也要取到');
    eq(m['软著授权方'], '我司', '正文只写「我司」，至少把主体关系标出来');
    eq(m['应用名称'], '包包源头', '书名号里、后面跟「以下简称」的是应用名');
    truthy((m['授权期限'] || '').indexOf('2025年9月12日') >= 0, '期限要认出来');
    truthy(rows.every((r) => r.kind === 'auth-soft'), '正文有 2022SR ⇒ 软著，不受配置字段名影响');
  });

  await test('★ APP 备案核准：主体叫主办单位，编号是 ICP备…号-6A', () => {
    const SAMPLE = [
      'APP备案核准通知书',
      '主办单位：北京知行灵动科技有限公司',
      '备案号：京ICP备2023012345号-6A',
      '应用名称：包包源头',
      '网站域名：app.baobaoyuantou.com',
      '服务内容：移动应用'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: 'APP备案核准函', src: 'r.png', text: SAMPLE });
    const m = map(rows);
    eq(m['APP备案主办单位'], '北京知行灵动科技有限公司', '备案类不叫著作权人，叫主办单位');
    eq(m['APP备案号'], '京ICP备2023012345号-6A', '编号要带省简称与 -6A 后缀');
    eq(m['APP备案应用名称'], '包包源头');
    eq(m['APP备案域名'], 'app.baobaoyuantou.com');
    truthy(rows.every((r) => r.kind === 'record-app'), 'kind 固定 record-app');
  });

  await test('★ 资质合作协议：甲乙双方 + 应用 + 期限 + 合作内容', () => {
    const SAMPLE = [
      '软件合作推广协议',
      '甲方（授权方）：北京知行灵动科技有限公司',
      '乙方（被授权方）：致趣娱科技（深圳）有限公司',
      '合作应用名称：包包源头',
      '包名：com.baobao.yt',
      '合作期限：2025年9月12日至2026年9月11日',
      '合作内容：在指定渠道推广并运营授权应用'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: '软件合作推广协议', src: 'a.png', text: SAMPLE });
    const m = map(rows);
    eq(m['合作授权方'], '北京知行灵动科技有限公司');
    eq(m['合作被授权方'], '致趣娱科技（深圳）有限公司');
    eq(m['应用名称'], '包包源头');
    eq(m['包名'], 'com.baobao.yt');
    truthy((m['授权期限'] || '').indexOf('2025年9月12日') >= 0);
    truthy((m['合作内容'] || '').indexOf('推广') >= 0);
    truthy(rows.every((r) => r.kind === 'agreement-qual'), '没有软著/APP 证据 ⇒ 中性合作名头');
  });

  await test('★ 条目没跑完 / 没文本 ⇒ 不抽', () => {
    eq(A.rowsFor({ state: 'pending', label: '登记证书', text: CERT }).length, 0);
    eq(A.rowsFor({ state: 'done', label: '登记证书', text: '' }).length, 0);
    eq(A.rowsFor(null).length, 0);
  });

  /* ==========================================================================
   * 2026-11-13 用户口径：不靠标签也要取到值
   *   「并不是一定要出现空格和冒号才能取到值……软著、app 版权的图片里必然会有类似
   *    2026SR0635345 这种固定形状的编号，就能直接定位；公司或者人名属于著作权人
   *    （也可能出现多个，存在转移关系 a 转给 b）。」
   * ========================================================================== */
  await test('★ 真实软著①：登记号被噪声粘住、著作权人没冒号，仍然取对', () => {
    const T1 = [
      '中华人民共和国国家版权局',
      '计算机软件著作权登记证书',
      '证书号： 软著登字第17849626号',
      '软件名称：吉边购APP',
      '[简称：吉边购]',
      'V1.0',
      '著作权人吉林省边疆新电商科技有限公司',
      '权利取得方式：原始取得',
      '权利范围：全部权利',
      '登记号：2026SR0635345 6O Kcp o',
      '根据《计算机软件保护条例》和《计算机软件著作权登记办法》的',
      '规定，经中国版权保护中心审核，对以上事项予以登记。'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书', text: T1 });
    const m = map(rows);
    eq(m['著作权人'], '吉林省边疆新电商科技有限公司', '没有冒号也要取到');
    eq(m['登记号'], '2026SR0635345', '尾巴上的 OCR 噪声不影响；证书号不许顶上来');
    truthy(rows.every((r) => r.value !== '软著登字第17849626号'), '证书号不是登记号');
  });

  await test('★ 真实软著②：标签被读成「记 号」、著作权人是人名，仍然取对', () => {
    const T2 = [
      '中华人民共和国国家版权局',
      '计算机软件著作权登记证书',
      '证书号： 软著登字第17846210号',
      '软件名称：装小恢装修系统',
      '著作权人：李天',
      '记 号： 2026SR0631929 C COOR'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书', text: T2 });
    const m = map(rows);
    eq(m['著作权人'], '李天');
    eq(m['登记号'], '2026SR0631929', '「登」被 OCR 吃掉也要按形状定位');
  });

  await test('★ 完全没有标签：公司名 + 固定形状编号也能进表', () => {
    const text = [
      '计算机软件著作权登记证书',
      '北京知行灵动科技有限公司',
      '2026SR0635345'
    ].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: '', text }));
    eq(m['著作权人'], '北京知行灵动科技有限公司', '公司名本身就是著作权人');
    eq(m['登记号'], '2026SR0635345');
  });

  await test('★ 多个著作权人 / 转移关系：A 转让给 B，两个主体都保留', () => {
    const text = [
      '计算机软件著作权登记证书',
      '著作权人：北京甲科技有限公司（转让给上海乙信息技术有限公司）',
      '登记号：2026SR0635345'
    ].join('\n');
    const owners = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书', text })
      .filter((r) => r.label === '著作权人').map((r) => r.value);
    eq(owners.join('|'), '北京甲科技有限公司|上海乙信息技术有限公司');
  });

  await test('★ 授权书无线索①：甲方 / 乙方写在同一句里', () => {
    const text = [
      '授权书',
      '北京甲科技有限公司（以下简称“甲方”）同意授权上海乙信息技术有限公司（以下简称“乙方”）在指定渠道运营。'
    ].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', text }));
    eq(m['软著授权方'], '北京甲科技有限公司');
    eq(m['软著被授权方'], '上海乙信息技术有限公司', '标签取到整句时，用实体线索判角色');
  });

  await test('★ 授权书无线索②：A 授权 B —— 动词前是授权方、动词后是被授权方', () => {
    const text = [
      '授权书',
      '北京甲科技有限公司授权上海乙信息技术有限公司运营授权应用。',
      '包名：com.demo.app'
    ].join('\n');
    const rows = A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', text });
    const m = map(rows);
    eq(m['软著授权方'], '北京甲科技有限公司');
    eq(m['软著被授权方'], '上海乙信息技术有限公司');
    truthy(rows.every((r) => r.kind === 'auth-soft'), '包名里的 app 不许把文档判成 APP 版权');
  });

  await test('★ 授权书无线索③：致：收件人 + 我司（公司名）', () => {
    const text = [
      '授权书',
      '致：上海乙信息技术有限公司',
      '北京甲科技有限公司（我司）特此授予贵司运营权。'
    ].join('\n');
    const m = map(A.rowsFor({ state: 'done', label: '计算机软件著作权登记证书授权书', text }));
    eq(m['软著被授权方'], '上海乙信息技术有限公司', '致… 的收件人');
    eq(m['软著授权方'], '北京甲科技有限公司', '正文只写「我司」时，括号里的公司名优先');
  });

  /* 【2026-11-13 用户需求】营业执照 / 各类资质：抽公司进表；承诺函：判承诺对象 + 承诺方。
   * 抽取层只负责「抽得对」，绿/黄由 note-check 的 qualVerdict / promiseVerdict 决定。 */
  await test('★ 营业执照：认文档类型，按「名称」抽出企业名称', () => {
    const text = [
      '营业执照',
      '统一社会信用代码 91110108MA01ABCD2X',
      '名称 北京知行灵动科技有限公司',
      '类型 有限责任公司(自然人投资或控股)',
      '法定代表人 张三',
      '住所 北京市海淀区中关村大街1号',
      '经营范围 技术开发、技术咨询'
    ].join('\n');
    const it = { state: 'done', src: 'b.png', label: '营业执照', text };
    eq(A.docOf(it), 'license');
    eq(A.kindOf(it), 'license');
    const m = map(A.rowsFor(it));
    eq(m['企业名称'], '北京知行灵动科技有限公司');
    eq(m['法定代表人'], undefined, '资质类只出企业名称，不抽法定代表人');
  });

  await test('★ 资质证书：企业名称进表，许可证编号不许混进公司名', () => {
    const text = [
      '增值电信业务经营许可证',
      '企业名称：上海乙信息技术有限公司',
      '许可证编号：B2-20230001',
      '有效期至：2028年12月31日'
    ].join('\n');
    const it = { state: 'done', src: 'c.png', label: '增值电信业务经营许可证', text };
    eq(A.docOf(it), 'license');
    const m = map(A.rowsFor(it));
    eq(m['企业名称'], '上海乙信息技术有限公司');
  });

  await test('★ 承诺函 vivo：承诺对象取「致：」收件人，承诺方取标签值', () => {
    const text = [
      '应用上架承诺函',
      '致：维沃移动通信有限公司',
      '我司承诺遵守平台规则，所提交材料真实有效。',
      '承诺方：北京甲科技有限公司'
    ].join('\n');
    const it = { state: 'done', src: 'd.png', label: '应用上架承诺函', text };
    eq(A.docOf(it), 'promise');
    const m = map(A.rowsFor(it));
    eq(m['承诺对象'], '维沃移动通信有限公司');
    eq(m['承诺方'], '北京甲科技有限公司');
  });

  await test('★ 承诺函 华为：照常抽取两层字段，平台好坏交给判定层', () => {
    const text = [
      '应用上架承诺函',
      '承诺对象：华为技术有限公司',
      '承诺单位：北京甲科技有限公司',
      '承诺内容：所提交材料真实有效。'
    ].join('\n');
    const m = map(A.rowsFor({ state: 'done', src: 'e.png', label: '应用上架承诺函', text }));
    eq(m['承诺对象'], '华为技术有限公司');
    eq(m['承诺方'], '北京甲科技有限公司');
  });

  await test('★ 承诺函无指向：落「应用平台」泛称，承诺方回落「我司」', () => {
    const text = [
      '应用上架承诺函',
      '本公司承诺遵守各应用平台的上架规范。'
    ].join('\n');
    const m = map(A.rowsFor({ state: 'done', src: 'f.png', label: '承诺函', text }));
    eq(m['承诺对象'], '应用平台');
    eq(m['承诺方'], '我司');
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
