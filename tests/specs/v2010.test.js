/* tests/specs/v2010.test.js — 2.0.10 四件事的不变式
 * ============================================================================
 * 用户 2026-11-12 的原话（`_stage/REQUESTS.md` 同日四条）：
 *   ③「符号在命中里面区分中英文么，我希望改成不区分中英文（包括图片命中词和动态词）
 *      忽略空格和因为 ocr 导致的换行，从而命中（原本就是另起一段的不需要忽略）」
 *   ②「添加关键词里面的编辑列表弹窗要支持拖动排序，修改展示顺序」
 *   ④「隐私链接还是试图展开，导致重要笔记悬窗和贴边模式闪烁（会不会是名和开的小标导致的）」
 *
 * 这一份只钉**口径**，不重复既有 spec：
 *   · 标点/空白折叠与段落边界 → `TextNorm` 本身（`text-norm.test.js` 管分级与区间映射）；
 *   · 图片命中词的宽松兜底 → `ImgOcr.matchedInText`（`img-ocr.test.js` 管既有空白用例）；
 *   · 拖拽排序源码契约 → 单测沙箱没有真实布局，按本仓惯例用源码不变式守住；
 *   · 裁剪宽度与政策小标 → `v20813.test.js` 管离屏量高，这里只加「宽度只增不减」与「小标不参与排版」。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { suite, test, eq, truthy, falsy, loadKernel } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = async function run() {
  const KH = loadKernel();
  const TN = KH.TextNorm;
  const O = KH.ImgOcr;

  /* ------------------------------------------------------------ ③ 文本口径 */
  suite('2.0.10 ③ · 中英文标点不再区分（1:1 折叠，区间仍可回原文）');

  await test('★ 中文标点 vs 英文标点 ⇒ fold-punct（不是 conflict）', () => {
    truthy(TN, 'KH.TextNorm 必须可用');
    eq(TN.verdict('养生、保健', '养生,保健'), 'fold-punct', '、 与 , 算同一个分隔符');
    eq(TN.verdict('养生。保健', '养生.保健'), 'fold-punct', '。 与 . 算同一个句号');
    eq(TN.verdict('“服务”', '"服务"'), 'fold-punct', '弯引号与直引号算同一个');
    eq(TN.verdict('A—B', 'A-B'), 'fold-punct', '破折号与连字符算同一个');
  });

  await test('★ 折叠是单字符→单字符：长度不变，区间能映射回原文', () => {
    const src = '养生、保健服务：非医疗';
    const hit = TN.findInText(src, '养生,保健服务:非医疗');
    truthy(hit, '标点差异不该让命中失败');
    eq(hit.start, 0, '起点在原文上');
    eq(hit.end, src.length, '终点覆盖到原文最后一个字');
    eq(hit.text, src, '回给调用方的是原文片段（不是折叠后的串）');
    eq(TN.keyOf(src).length, TN.keyOf('养生,保健服务:非医疗').length, '1:1 折叠不许改长度');
  });

  await test('★ 空格与 OCR 单换行照旧忽略；空行（另起一段）是硬边界', () => {
    truthy(TN.findInText('养生\n保健', '养生保健'), '单换行 = OCR 检测框切行，要容忍');
    truthy(TN.findInText('养生 保健', '养生保健'), '空格要容忍');
    falsy(TN.findInText('养生\n\n保健', '养生保健'), '空行 = 真正另起一段，不许跨过去命中');
    truthy(TN.keyOf('养生\n\n保健') !== TN.keyOf('养生保健'), '空行两侧不能算同一个值');
    eq(TN.keyOf('\n\n养生保健\n\n'), TN.keyOf('养生保健'), '首尾空行不算语义（否则每段都会判不等）');
  });

  /* ------------------------------------------------- ③ 图片命中词的宽松兜底 */
  suite('2.0.10 ③ · 图片命中词 / 动态词共用同一份折叠口径');

  await test('★ 图片命中词跨中文标点仍命中，且命中块落在原文', () => {
    const rule = { meta: { imgOcrKeyword: '养生,保健服务' } };
    const src = '经营范围：养生、保健\n服务（非医疗）';
    const hits = O.matchedInText(rule, src);
    eq(hits.length, 1, '标点 + 单换行都该被折叠掉');
    eq(src.slice(hits[0].start, hits[0].end), hits[0].text, 'start/end 必须能切回原文');
  });

  await test('★ 关键词里带中文标点、图里是英文标点，也命中', () => {
    const rule = { meta: { imgOcrKeyword: 'A，B' } };
    truthy(O.matchedInText(rule, 'A,B').length, '， 与 , 要算同一个');
  });

  await test('★ 空行是硬边界：图片命中词不许跨段拼出来', () => {
    const rule = { meta: { imgOcrKeyword: '养生保健' } };
    eq(O.matchedInText(rule, '养生\n\n保健').length, 0, '两段各半句不算命中');
    eq(O.matchedInText(rule, '养生\n保健').length, 1, '单换行仍算命中');
  });

  await test('★ 带正则元字符的词不在宽松兜底里重试（不制造用户没预期的命中）', () => {
    const src = read('src/features/img-ocr.js');
    truthy(/LITERAL_OK/.test(src), '宽松兜底必须先过字面量白名单');
    truthy(/TN\.findInText\(raw, piece, \{ boundary: false \}\)/.test(src),
      '兜底只能调内核唯一比较入口，不许自己再写一份折叠');
    falsy(/unshrinkRange/.test(src), '旧的"剔空白 + 收缩区间"实现必须已删除（第二份口径）');
  });

  /* ------------------------------------------------------------ ② 拖动排序 */
  suite('2.0.10 ② · 列表弹窗拖动排序');

  await test('★ 每行有拖拽把手，且只有把手 draggable（输入框仍可正常选字）', () => {
    const src = read('src/ui/components/fields.js');
    truthy(/kh-lrow-grip/.test(src), '要有可见把手');
    truthy(/grip\.setAttribute\('draggable', 'true'\)/.test(src), '把手自己 draggable');
    truthy(/dragstart/.test(src) && /dragover/.test(src) && /drop/.test(src) && /dragend/.test(src),
      '四个事件都要挂（缺 dragend 会留下半透明残影）');
    truthy(/function moveRow\(/.test(src), '排序必须是"移动一行"，不是交换');
  });

  await test('★ 拖完必须让保存走「整串重排」分支（否则 kvApply 按原下标 patch 会把顺序改回去）', () => {
    const src = read('src/ui/components/fields.js');
    truthy(/let orderDirty = false/.test(src), '要单独记"顺序被改过"');
    truthy(/if \(hasNew \|\| orderDirty\)/.test(src), '顺序变化与新增行共用整串重排');
    truthy(/const rawOut = /.test(src), '未改动的行要取原文片段（不能重新序列化，避免动到用户写法）');
  });

  await test('★ 拖拽视觉反馈只加描边，不改行高（改行高会让落点自己跳）', () => {
    const css = read('src/ui/components/components.css');
    truthy(/\.kh-lrow-grip/.test(css) && /cursor: grab/.test(css), '把手是 grab 光标');
    truthy(/\.kh-lrow\.drop-before/.test(css) && /\.kh-lrow\.drop-after/.test(css),
      '落点要有 before/after 两种提示');
    truthy(/\.kh-lrow\.is-dragging/.test(css), '被拖的行要有可辨识状态');
  });

  /* -------------------------------------------------- ④ 隐私链接不再「试图展开」 */
  suite('2.0.10 ④ · 裁剪宽度只增不减 + 政策小标不参与排版');

  await test('★ 同一段文字的裁剪基准宽度只增不减（断掉"变窄→判得下→摘 clamp→变宽"的回环）', () => {
    const src = read('src/features/important-note.js');
    const i = src.indexOf('function clipValueBoxes');
    truthy(i >= 0, '裁剪入口还在');
    const seg = src.slice(i, i + 2200);
    truthy(/el\.__khClipBase === 'number'/.test(seg), '要记住历史最大宽度');
    truthy(/Math\.max\(measured, el\.__khClipBase\)/.test(seg), '取 max：宽度不许回缩');
    truthy(/el\.__khClipTxt === txt/.test(seg), '换了文字才重新取基准');
  });

  await test('★ 「名」「开」小标横排、浮在标题文字上面', () => {
    const src = read('src/features/important-note.js');
    const i = src.indexOf('.kh-table .kh-policy-flags {');
    truthy(i >= 0, '小标要有一个绝对定位的容器');
    const seg = src.slice(i, i + 320);
    truthy(/position:\s*absolute/.test(seg), '容器绝对定位：不参与排版、不撑宽标题格');
    truthy(/right:\s*3px/.test(seg) && /top:\s*50%/.test(seg) && /translateY\(-50%\)/.test(seg),
      '贴在标题格右侧、垂直居中（压在文字上面）');
    truthy(/display:\s*inline-flex/.test(seg), '两个小标横排');
    const fi = src.indexOf('.kh-policy-flag {');
    truthy(fi >= 0, '小标样式还在');
    const fseg = src.slice(fi, fi + 220);
    truthy(/position:\s*static/.test(fseg), '小标回到普通流，由容器负责排开');
    truthy(!/margin-left/.test(fseg), '不许留 margin（会被推出容器）');
    truthy(/\.kh-table \.kh-table-label \{ position: relative; \}/.test(src),
      '标题格要成为定位上下文，否则小标会跑到整张卡外面');
    truthy(!/flagIdx \* 16/.test(src), '竖排的旧写法要删掉');
  });

  await test('★ 抓取字段可以点名第几张图（控件与写回）', () => {
    const src = read('src/ui/components/fields.js');
    truthy(/指定第几张图（#图1,3）/.test(src), '「取什么内容」要有这一档');
    truthy(/const imgPickInp = h\('input'/.test(src), '需要输入序号的控件');
    truthy(/imgPickInp\.hidden = m !== '#PICK'/.test(src), '只有选中这一档时才露出输入框');
    truthy(/sp\.imgPick = \(m === '#PICK'\)/.test(src), '改档位要写回 sp.imgPick');
    truthy(/\.sort\(\(a, b\) => a - b\)/.test(src), '序号要排好再存，`3,1` 与 `1,3` 等价');
    truthy(/it\.imgPick && it\.imgPick\.length/.test(src), '展示串要先看序号');
    truthy(/'#' \+ \(it\.imgOnly \? '图' : ''\) \+ it\.imgPick\.join\(','\)/.test(src),
      '写回 `#图1,3`（只留图）或 `#1,3`（文字照留）');
  });
};
