'use strict';
/* 2.0.8.13 需求①②③④：抓取字段取值人话摘要、CSV 导入预览+撤销、首屏密度、深色主题。
 * 只锁「契约」不锁像素：这里断言的是"谁是一处真源""失败时不能谎报""深色只靠属性"。
 * 用户原话（m02493）：「一起做了。然后发版」。 */
const fs = require('fs');
const path = require('path');
const { test, truthy, eq } = require('../harness');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------------------------------------------------------- ① 取值摘要 */
module.exports = function run() {
test('describeSuffix：把后缀翻译成人话（而不是让用户背 @ ~ * #）', () => {
  const src = read('src/features/fetch.js');
  const i = src.indexOf('function describeSuffix');
  truthy(i >= 0, '要有 describeSuffix');
  const seg = src.slice(i, i + 2200);
  truthy(/值格/.test(seg), '取值格要说"值格：右数第 N 格"这类人话');
  truthy(/只显示一行/.test(seg), 'clip 要说"只显示一行"');
  truthy(/做成链接/.test(seg), 'link 要说"做成链接"');
  truthy(/suffixTextOf, describeSuffix,/.test(src), '要挂在 KH.Fetch 上导出（与 suffixTextOf 同一行）');
});

test('字段面板用摘要当按钮文案，原始写法退到 title（两处：样式区 + 行内）', () => {
  const src = read('src/ui/components/fields.js');
  const hits = (src.match(/describeSuffix\(/g) || []).length;
  truthy(hits >= 2, '取值按钮文案要用 describeSuffix（样式区 + 行内两处）');
  truthy(/取值：/.test(src), '按钮前缀统一成"取值："');
  truthy(/suffixTextOf\(/.test(src), '原始后缀写法要留在 title 里，方便排障');
});

/* ------------------------------------------------------------ ② CSV 预览撤销 */
test('importCSV 拆成 plan/preview/import：预览不许写盘', () => {
  const src = read('src/platform/storage.js');
  truthy(/planCSV\(text, config\)\s*\{/.test(src), '要有纯计算的 planCSV');
  truthy(/previewCSV\(text, config\)\s*\{/.test(src), '要有 previewCSV');
  const pv = src.slice(src.indexOf('function previewCSV'), src.indexOf('function previewCSV') + 600);
  truthy(!/patch\(/.test(pv), 'previewCSV 里不许调 patch（预览写盘＝用户还没确认就改了数据）');
  truthy(/action:\s*'bad'/.test(src) || /'bad'/.test(src), '行分类要含 bad');
  truthy(/关键词为空/.test(src), '空关键词要给可读原因，不是静默跳过');
});

test('导入走预览弹窗 + 可撤销快照（10 分钟内）', () => {
  const src = read('options/options.js');
  truthy(/previewCSV\(/.test(src), '导入前要先 previewCSV');
  truthy(/导入 CSV 预览/.test(src), '要有预览弹窗标题');
  truthy(/kh\.importUndo/.test(src), '撤销快照走 storage.session 的 kh.importUndo');
  truthy(/10\s*\*\s*60\s*\*\s*1000/.test(src), '撤销窗口＝10 分钟');
  truthy(/btn-undo-import/.test(src), '要有撤销按钮绑定');
  const html = read('options/options.html');
  truthy(/id="undo-row"/.test(html) && /id="btn-undo-import"/.test(html), '撤销行要落在 DOM 里');
});

/* -------------------------------------------------------------- ③ 首屏密度 */
test('首屏密度只收垂直留白，水平 10 与 -62px 派生宽度是契约', () => {
  const src = read('src/features/important-note.js');
  truthy(/margin:\s*0 6px 5px;\s*padding:\s*5px 10px;/.test(src), '卡片 margin 6→5、padding 垂直 7→5，水平仍 10');
  truthy(/margin-bottom:\s*2px;/.test(src), '卡头下边距 3→2');
  truthy(/line-height:\s*1\.45;/.test(src), '正文行高 1.55→1.45');
});

/* -------------------------------------------------------------- ④ 深色主题 */
test('深色只靠属性：theme.js 写 data-kh-theme，light 时摘掉属性', () => {
  const src = read('src/ui/theme.js');
  truthy(/const ATTR = 'data-kh-theme'/.test(src), '属性名单一真源');
  truthy(/el\.removeAttribute\(ATTR\)/.test(src), 'light 要摘掉属性（浅色令牌＝默认值，不写第二份）');
  truthy(/prefers-color-scheme: dark/.test(src), 'auto 要跟系统');
  truthy(/uiTheme/.test(src), '真值来自 config.uiTheme');
});

test('深色令牌齐全且只写一份（两份就会漂移）', () => {
  const css = read('src/ui/tokens.css');
  const blocks = (css.match(/:root\[data-kh-theme="dark"\]/g) || []).length;
  eq(blocks, 1, '深色令牌块只许一份');
  const i = css.indexOf(':root[data-kh-theme="dark"]');
  const seg = css.slice(i, i + 1600);
  ['--bg', '--card', '--border', '--text', '--text-3', '--brand', '--brand-on-soft'].forEach((k) => {
    truthy(seg.indexOf(k + ':') >= 0, '缺令牌 ' + k);
  });
  const start = css.indexOf('/* @inject:tokens:start */');
  const end = css.indexOf('/* @inject:tokens:end */');
  truthy(start >= 0 && end > start && i > start && i < end, '深色块必须在注入标记之内，否则构建期会被裁掉');
});

test('uiTheme 进配置：默认 auto，坏值回 auto 并记账', () => {
  const src = read('src/core/config.js');
  truthy(/'uiTheme': \['auto', 'light', 'dark'\]/.test(src), 'ENUMS 要有三档');
  truthy(/uiTheme:\s*'auto'/.test(src), '默认 auto（跟随系统）');
  truthy(/ENUMS\['uiTheme'\]\.includes/.test(src), 'normalize 要校验');
  truthy(/changed\.invalid\.push\('uiTheme'\)/.test(src), '坏值要记进 invalid，不能静默');
});

test('面板深色落在 shadow host 上，绝不改宿主文档；设置页有下拉', () => {
  const panel = read('src/features/important-note.js');
  truthy(/this\.host\.setAttribute\('data-kh-theme', 'dark'\)/.test(panel), '面板把主题写在自己的 host 上');
  truthy(/:host\(\[data-kh-theme="dark"\]\) \.khin-panel/.test(panel), '面板深色样式走 :host 属性选择器');
  truthy(!/document\.documentElement\.setAttribute\(['"]data-kh-theme/.test(panel), '绝不许改宿主文档属性');
  const html = read('options/options.html');
  truthy(/id="ui-theme"/.test(html), '设置页要有外观下拉');
  truthy(/跟随系统/.test(html), '要有"跟随系统"这一档');
});
};
