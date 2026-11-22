/* tests/specs/audit-template.test.js — 审核后台模板页（2.0.15.2）
 * ----------------------------------------------------------------------------
 * 用户给的「审核后台」快照页，现在同时是**人工验收页**和**真机 e2e 的装置**：
 *   · 图标（64×64）—— 极小图，OCR 的「不瞎转」就靠它当现场；
 *   · 应用截图（3 张 1280×360）—— 截图 OCR 的正例（1/2 含公司名）与负例（3 号不含）；
 *   · 左右格组合词 —— 核心词被 <span> 拆成两段，跨节点命中必须能整词命中；
 *   · 上下格组合词 —— 嵌表里 th 是标题格、td 是数据格；
 *   · PDF 控件 —— 三份资质 PDF（attachment.pdf / ?v=2 / ?v=3），其中 ?v=3 在「两标题一格」那行。
 * 这张 spec 只锁**结构**（不拉浏览器，CI 也能跑）：尺寸、前缀、行列关系一旦被改坏，
 * e2e 会以一种很难懂的方式红（比如 OCR 无正例可命中），所以先在这里钉住。
 * 改模板请改 `_tools/build-audit-page.js`（真源是 fixture 这份），不要手改 HTML。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'audit-detail.html'), 'utf8');

/** PNG 的 IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后：宽高各 4 字节大端 */
function pngSize(rel) {
  const b = fs.readFileSync(path.join(ROOT, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

module.exports = async function run() {
suite('2.0.15.2 审核后台模板页：结构（图标 / 截图 / 左右格 / 上下格 / 三份 PDF）');

test('★ 应用截图是 3 张真实 1280×360 图，不是占位 gif', () => {
  const n = (HTML.match(/audit-assets\/shot-\d\.png/g) || []).length;
  eq(n, 3, '应用截图行应有 3 张真图，实际 ' + n);
  for (const i of [1, 2, 3]) {
    const s = pngSize('e2e/fixtures/audit-assets/shot-' + i + '.png');
    eq(s.w, 1280, 'shot-' + i + ' 宽应为 1280');
    eq(s.h, 360, 'shot-' + i + ' 高应为 360');
  }
  /* 占位 gif 是旧页面留下的空壳：留一张都会让「截图 OCR」看起来有装置、实际无字 */
  truthy(HTML.indexOf('audit-assets/placeholder') < 0, '不许残留占位图');
});

test('★ 应用图标是 64×64 —— 极小图档的现场（OCR 分级就靠它验）', () => {
  truthy(HTML.indexOf('id="audit-icon"') >= 0, '图标 img 必须有 id 供 e2e 定位');
  const s = pngSize('e2e/fixtures/audit-assets/icon-64.png');
  eq(s.w, 64, '图标宽应为 64');
  eq(s.h, 64, '图标高应为 64');
  truthy(Math.max(s.w, s.h) <= 160, '必须落在 TINY_EDGE=160 的极小图档里');
});

test('★ 左右格：标题格「软件介绍」的左格 + 值格里核心词被 <span> 拆成两段', () => {
  const m = HTML.match(/<tr[^>]*><td[^>]*>软件介绍<\/td><td[^>]*id="audit-lr-core">([\s\S]*?)<\/td><\/tr>/);
  truthy(m, '「软件介绍」这一行必须存在，且值格 id=audit-lr-core');
  truthy(m[1].indexOf('<span style="color:#e53935">来遇</span>见你') >= 0, '核心词必须被 span 拆开（跨节点命中的唯一验法）');
  /* 拆开之后，任何「取单个文本节点」的实现都只会拿到「来遇」——这就是断言要抓的回归 */
  truthy(m[1].indexOf('来遇见你') < 0, '核心词不许是单个文本节点（否则跨节点路径测不到）');
});

test('★ 上下格：嵌表里 th「是否重点关注」在上、td「是的哦」在下', () => {
  const m = HTML.match(/<td[^>]*>上下格装置<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/);
  truthy(m, '「上下格装置」这一行必须存在');
  const inner = m[1] || '';
  truthy(inner.indexOf('<th') >= 0 && inner.indexOf('<td id="audit-tb-core"') >= 0, '嵌表必须有 th 与 id=audit-tb-core 的 td');
  truthy(inner.indexOf('是否重点关注') < inner.indexOf('是的哦'), '标题格要在数据格上面（上→下）');
});

test('★ 三份资质 PDF：都在 audit-assets/ 下，且 ?v=3 那份落在「两标题一格」的行里', () => {
  const urls = (HTML.match(/data-pdf="([^"]+)"/g) || []).map((s) => s.slice(10, -1));
  truthy(urls.length >= 3, 'PDF 控件至少 3 个，实际 ' + urls.length);
  /* 页面里还有几行别的资质也挂了 PDF（同一份 attachment.pdf，用 query 区分）：
   * 这份断言只要求「每个控件都指得到真实文件」，外加模板新增的那三个地址必须在。 */
  for (const u of urls) {
    const rel = 'e2e/fixtures/' + u.split('?')[0];
    truthy(fs.existsSync(path.join(ROOT, rel)), 'PDF 控件指向的文件必须存在，缺 ' + rel);
  }
  for (const want of ['audit-assets/attachment.pdf', 'audit-assets/attachment.pdf?v=2', 'audit-assets/attachment.pdf?v=3']) {
    truthy(urls.indexOf(want) >= 0, '模板页缺这份 PDF 控件：' + want);
  }
  const two = HTML.match(/class="pdf-two-title"[\s\S]{0,400}?data-pdf="audit-assets\/attachment\.pdf\?v=3"/);
  truthy(two, '?v=3 必须留在两标题一格的那行（PDF 归属要按紧邻标题判）');
});
};
