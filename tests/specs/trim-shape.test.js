/* tests/specs/trim-shape.test.js — 【2.0.11 · T1/T2】贴图即出候选行 / 值裁剪形状优先
 * ----------------------------------------------------------------------------
 * 用户 2026-11-15 拍板（m08922 原话「1A 2A 3A」）：
 *   · 1A：候选行「固定为字段」在右键路径上没有规则可写 ⇒ 只把字段串复制给用户；
 *   · 2A：ghost 候选行只放右键识别卡，不动抓取字段的开关与编辑器联动；
 *   · 3A：裁剪只认强形状（软著登记号 / ICP 备案号），不收「第 N 号」与 6 位以上纯数字。
 * 这里锁的是**真渲染 + 真认类**：候选行走 KH.OcrAuto.rowsFor，裁剪走 KH.ImportantNote._trimValue。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

module.exports = async function run() {
  const { KH } = require('../bootstrap');
  const N = KH.ImportantNote;
  const VIEW = KH.OcrCopy.VIEW;
  const shadowPanel = () => Object.create(N.panel);

  const ctxItem = (over) => Object.assign({
    key: 'ctxmenu|a', src: 'https://ex.com/a.png', state: 'done', via: 'contextMenu'
  }, over || {});

  const certText = '软件著作权登记证书\n著作权人：北京知行灵动科技有限公司\n登记号：2026SR0635345';
  const recordText = 'APP备案核准\n主办单位：某某网络科技有限公司\n备案号：京ICP备2023012345号-6A';

  /* ==========================================================================
   * T2 · 值裁剪：强形状优先（自定义字段名也能裁）
   * ========================================================================== */
  suite('值裁剪 · 批 T2（强形状优先；既有五类裁剪不回归）');

  await test('自定义字段名 + 软著登记号 ⇒ 只留编号串', () => {
    eq(N._trimValue('证照号码', '2026SR0635345（以下简称甲方）'), '2026SR0635345');
    eq(N._trimValue('资质编号', '证书号 2026SR0635345 有效期三年'), '2026SR0635345');
  });

  await test('自定义字段名 + 软著登字第 N 号 / ICP 备案号 ⇒ 只留编号串', () => {
    eq(N._trimValue('证照', '软著登字第 1234567 号 2024年'), '软著登字第1234567号');
    eq(N._trimValue('证照', '京ICP备2023012345号-6A'), '京ICP备2023012345号-6A');
    eq(N._trimValue('证照', '京 ICP 备 2023012345 号 - 6A'), '京ICP备2023012345号-6A', '空白压掉、行政区划与连字符保留');
  });

  await test('弱形状不越界裁（用户 3A：第 N 号 / 长数字不认）', () => {
    eq(N._trimValue('证照号码', '第3号仓库'), '第3号仓库');
    eq(N._trimValue('证照号码', '订单20240101'), '订单20240101');
  });

  await test('自定义字段名 + 单位名带噪音尾巴 ⇒ 收到单位后缀为止', () => {
    eq(N._trimValue('证照主体', '北京甲乙科技有限公司（以下简称"甲方"）'), '北京甲乙科技有限公司');
    eq(N._trimValue('证照主体', '上海某某有限公司 授权人 合肥分公司'), '上海某某有限公司');
  });

  await test('正文整句不裁、干净单位名不动（裁错比不裁更伤人）', () => {
    eq(N._trimValue('证照主体', '本协议由北京甲乙科技有限公司与乙方签订'), '本协议由北京甲乙科技有限公司与乙方签订');
    eq(N._trimValue('证照主体', '甲方：北京甲乙科技有限公司'), '甲方：北京甲乙科技有限公司');
    eq(N._trimValue('证照主体', '北京甲乙科技有限公司'), '北京甲乙科技有限公司');
  });

  await test('★ 2.0.16.4 括号别称是同一家单位，不许被单位后缀切掉（用户 m19162）', () => {
    /* 用户现场：APP 电子版权认证证书「著作权人：精河县融媒体中心（精河县广播电视台）」
     * 进表只剩「精河县融媒体中心」—— KV_ORG_TAIL_G 只在「中心」收口，「电视台」不在表里。 */
    eq(N._trimValue('著作权人', '精河县融媒体中心（精河县广播电视台）'), '精河县融媒体中心（精河县广播电视台）');
    eq(N._trimValue('著作权人', '精河县融媒体中心(精河县广播电视台)'), '精河县融媒体中心(精河县广播电视台)', '半角括号同样要留住');
    eq(N._trimValue('著作权人', '精河县融媒体中心（精河县广播电视台'), '精河县融媒体中心', '右括号没读出来就退回后缀收口，不切半截');
    eq(N._trimValue('著作权人', '北京某某科技（集团）有限公司'), '北京某某科技（集团）有限公司', '后缀在括号里也不许从括号处切断');
    eq(N._trimValue('著作权人', '精河县融媒体中心'), '精河县融媒体中心');
  });

  await test('既有五类编号裁剪逐条不回归（明确语义的字段）', () => {
    eq(N._trimValue('登记号', '证书号：2026SR0635345 2026年'), '2026SR0635345');
    eq(N._trimValue('登记号', '第 12345 号'), '第12345号');
    eq(N._trimValue('登记号', '软著登字第 998877 号'), '软著登字第998877号');
    eq(N._trimValue('证书号', 'ABC-123456 附页'), 'ABC-123456');
    eq(N._trimValue('编号', '20240101'), '20240101');
  });

  await test('普通字段：没有强形状就原样返回；有强形状则形状优先于字段名', () => {
    eq(N._trimValue('版本号', 'v2.0.10.13 这一串只是普通版本号'), 'v2.0.10.13 这一串只是普通版本号');
    eq(N._trimValue('版本号', '2026SR0635345 这一串只是恰好长得像编号'), '2026SR0635345', '强形状优先于字段名');
  });

  /* ==========================================================================
   * T1 · 右键卡：贴图即出候选行
   * ========================================================================== */
  suite('右键卡 · 批 T1（贴图即出候选行 / 零候选说清支持哪些证）');

  await test('★ 识别完成 ⇒ 卡里多出 ghost 候选行（不必先配抓取字段）', () => {
    const p = shadowPanel();
    p.imgItems = [ctxItem({ text: certText, label: '软件著作权登记证书' })];
    const card = p.ctxCard(document);
    const trs = card.querySelectorAll('tr');
    eq(trs.length, 3, '截图行 + 两条候选');
    eq(card.querySelectorAll('.khin-ghost-row').length, 2, '候选行有 ghost 标记');
    eq(card.querySelectorAll('.khin-ghost-row')[0].getAttribute('data-kh-ghost'), '1', '行上还要带属性钩子（避免被当成抓取字段）');
    const labels = [];
    for (const tr of card.querySelectorAll('.khin-ghost-row')) {
      labels.push(tr.querySelectorAll('td')[0].textContent.trim());
    }
    eq(labels.join(','), '著作权人,登记号', '候选行名取自动认类');
    truthy(card.textContent.indexOf(VIEW.ghostTag) >= 0, '每行都标「来自这张图 · 待确认」');
    falsy(card.querySelector('.khin-ghost-none'), '有候选就不说"没认出来"');
  });

  await test('★ 候选行不参与字段解析（不会被当成抓取到的 entity）', () => {
    const p = shadowPanel();
    /* 2026-11-17：备案核准模板已退场，候选行改用证书（著作权人 / 登记号）来造。 */
    p.imgItems = [ctxItem({ text: certText, label: '软件著作权登记证书' })];
    const card = p.ctxCard(document);
    const table = card.querySelector('table');
    truthy(card.querySelectorAll('.khin-ghost-row').length >= 1, '先确认真有候选行');
    eq(KH.Compare.Sources.readFields(table).entity, '', 'readFields 必须跳过 ghost 行');
    eq(KH.Compare.Sources.field(table, '著作权人').found, false, '按名取字段也要跳过');
  });

  await test('★ 「固定为字段」只复制字段串，并当场把结果说出来', async () => {
    const p = shadowPanel();
    p.imgItems = [ctxItem({ text: certText, label: '软件著作权登记证书' })];
    const card = p.ctxCard(document);
    const btn = card.querySelector('.khin-ghost-fix');
    truthy(btn, '认得出证书就该给按钮');
    eq(btn.textContent, KH.OcrCopy.render(VIEW.ghostFix, { name: '证书' }), '按钮文案取面板真源');
    btn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 10));
    /* 单测环境没有剪贴板（navigator.clipboard / execCommand 都不可用）⇒ 必须走失败文案，
     * 且文案里要带完整字段串，用户能照着手抄。 */
    eq(btn.textContent, KH.OcrCopy.render(VIEW.ghostCopyFail, { spec: '证书#图' }));
    eq(btn.disabled, true, '点过就禁用，避免重复点');
  });

  await test('★ 有识别完的图、但一条候选都没有 ⇒ 说清支持哪几种证', () => {
    const p = shadowPanel();
    p.imgItems = [ctxItem({ text: '这是一段普通说明文字，什么证都不是。' })];
    const card = p.ctxCard(document);
    eq(card.querySelectorAll('.khin-ghost-row').length, 0, '没有候选行');
    const none = card.querySelector('.khin-ghost-none');
    truthy(none, '要给零候选提示');
    eq(none.textContent, VIEW.ghostNone);
  });

  await test('还在识别（pending）⇒ 不催、也不说"没认出来"', () => {
    const p = shadowPanel();
    p.imgItems = [ctxItem({ state: 'pending', text: '' })];
    const card = p.ctxCard(document);
    eq(card.querySelectorAll('.khin-ghost-row').length, 0);
    falsy(card.querySelector('.khin-ghost-none'), '没识别完就不该下"认不出"的结论');
    truthy(card.textContent.indexOf(VIEW.ctxBusy) >= 0, '只说识别中');
  });
};
