/* tests/specs/renderer-row-tint.test.js — 上下格组合词命中 ⇒ 整行底色（2.0.16.3）
 * ----------------------------------------------------------------------------
 * 用户口径（2026-11-23）：「上下格组合关键词命中时，把命中单元格所在行的单元格底色都改成高亮」。
 * 只认 combo-tb：普通词、左右格（combo-lr）、罕见字都不整行着色——否则一页全是黄条，等于没标。
 *
 * 这里不拉浏览器（CI 也要能跑），验的是两件最容易被改坏的事：
 *   1) 判据与配色的纯函数（kind / 颜色解析 / 透明度）；
 *   2) 上色与撤色的记账（render 不再先清后建，旧行必须被显式撤掉，否则删词后底色永远留着）。
 * 真浏览器的视觉结果在 e2e/content.test.js 的模板组里另有用例。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** 在垫片 DOM 里加载真渲染器：不支持 CSS.highlights（传 undefined）也能上整行底色 */
function loadRenderer() {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'core', 'renderer.js'), 'utf8');
  const doc = { head: { appendChild(el) { el.parentNode = doc.head; } }, documentElement: {} };
  doc.createElement = function (tag) {
    return {
      tagName: String(tag).toUpperCase(), textContent: '', children: [], attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(el) { this.children.push(el); el.parentNode = this; }
    };
  };
  const win = { KH: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'globalThis', 'CSS', 'Highlight', code)(win, doc, win, undefined, undefined);
  return win.KH.Renderer;
}

/** 假表格行：只带 _paintRows/_untintRow 真正会碰的三个口子 */
function fakeRow() {
  const classes = new Set();
  const vars = {};
  return {
    isConnected: true,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); }
    },
    style: {
      setProperty(k, v) { vars[k] = v; },
      removeProperty(k) { delete vars[k]; }
    },
    _classes: classes,
    _vars: vars
  };
}

module.exports = async function run() {
  /* 注意：harness 的 suite(name) 只切标题、不收回调 —— 写成 suite(name, fn) 会只打印标题、一条用例都不跑。 */
  suite('2.0.16.3 · 上下格命中整行底色（渲染器纯函数与记账）');
  const R = loadRenderer();
  const row = R && R._row;

  test('渲染器暴露整行底色的纯函数（单测不依赖真浏览器）', () => {
      truthy(row, 'Renderer._row 必须存在');
      eq(typeof row.isTbCombo, 'function', 'isTbCombo 应是函数');
      eq(typeof row.rowTintOf, 'function', 'rowTintOf 应是函数');
      eq(row.ROW_CLASS, 'kh-row-hit', '整行类名固定为 kh-row-hit');
      eq(row.ROW_TINT_ALPHA, 0.18, '底纹透明度固定 0.18（再深就盖住表格原有底色）');
  });

  test('只认上下格：普通词 / 左右格 / 罕见字都不整行着色', () => {
      eq(row.isTbCombo({ kind: 'combo-tb' }), true, 'combo-tb 应整行着色');
      eq(row.isTbCombo({ kind: 'combo-lr' }), false, '左右格不整行着色');
      eq(row.isTbCombo({ kind: 'normal' }), false, '普通词不整行着色');
      eq(row.isTbCombo({ kind: 'rare' }), false, '罕见字不整行着色');
      eq(row.isTbCombo({}), false, '没有 kind 的老命中不整行着色');
      eq(row.isTbCombo(null), false, '空命中不炸');
      eq(row.isTbCombo({ meta: { combo: 'tb' } }), true, 'meta.combo=tb 的老数据也认');
      eq(row.isTbCombo({ meta: { combo: 'lr' } }), false, 'meta.combo=lr 不认');
  });

  test('底纹颜色 = 高亮色同名 rgba(0.18)：十六进制、rgb() 都能解析，认不出的不硬上色', () => {
      eq(row.rowTintOf('#ff9500'), 'rgba(255,149,0,0.18)', '#ff9500 应转成 0.18 透明底');
      eq(row.rowTintOf('rgb(255, 0, 0)'), 'rgba(255,0,0,0.18)', 'rgb() 写法同样要转');
      eq(row.rowTintOf('rgba(0,128,255,0.6)'), 'rgba(0,128,255,0.18)', '本身带透明度也压到 0.18');
      eq(row.rowTintOf(''), '', '空色值不上色');
      eq(row.rowTintOf('bogus'), '', '认不出的色值不上色（宁可不着色也不要瞎涂）');
  });

  test('上色后能撤干净：类名与 --kh-row-tint 变量一起移除，set 里也不留死引用', () => {
      const tr = fakeRow();
      R._paintRows(new Map([[tr, 'rgba(255,149,0,0.18)']]));
      eq(tr._classes.has('kh-row-hit'), true, '命中的行要带上整行类名');
      eq(tr._vars['--kh-row-tint'], 'rgba(255,149,0,0.18)', '行上要写底纹变量');
      eq(R._rows.has(tr), true, '行要记进账本');

      R._paintRows(new Map());
      eq(tr._classes.has('kh-row-hit'), false, '这一轮没命中就必须撤掉类名');
      eq(Object.prototype.hasOwnProperty.call(tr._vars, '--kh-row-tint'), false, '变量也要撤掉，否则下次上色前会闪旧色');
      eq(R._rows.has(tr), false, '账本里不许留死引用');
  });

  test('行卸载（isConnected=false）时也会被清账，不留内存与样式残留', () => {
      const tr = fakeRow();
      R._paintRows(new Map([[tr, 'rgba(255,149,0,0.18)']]));
      tr.isConnected = false;
      R._paintRows(new Map());
      eq(R._rows.has(tr), false, '已卸载的行要从账本里清掉');
  });

  test('源码级：tbRows 只在 combo-tb 分支写入，prune 之后才上色，clear 里要逐行撤', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'renderer.js'), 'utf8');
      truthy(src.indexOf('if (isTbCombo(h))') >= 0, 'render 里必须只对 tb 命中收集行');
      truthy(src.indexOf('this._paintRows(tbRows)') >= 0, 'render 必须把收集到的行交给 _paintRows');
      const iPrune = src.indexOf('this.prune(keep)');
      const iPaint = src.indexOf('this._paintRows(tbRows)');
      truthy(iPrune >= 0 && iPaint > iPrune, '上色要在 prune 之后（否则会被这轮的清理顺手抹掉）');
      truthy(src.indexOf('background-color:var(--kh-row-tint) !important') >= 0,
        '整行底纹样式要带 !important，否则被页面 td 的底色压掉');
  });
};
