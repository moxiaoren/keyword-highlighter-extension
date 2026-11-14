/* tests/specs/welcome-steps.test.js — 三步上手必须真的能点（台账 2026-11-14 第 11 条）
 * ----------------------------------------------------------------------------
 * 判据不是「页面上有三张卡」，而是「每张卡点下去能落到设置页的哪一节」：
 *   ① 三张卡都是链接（<a class="kh-step" href>），不是死文案；
 *   ② 每条 href 的 #sec-xxx 必须是 options.js 里真实存在的分区 —— 写错一个字母，
 *      点下去只会停在默认分区，页面本身不会报错；
 *   ③ options.js 启动时必须读 location.hash（否则链接只能改地址栏，切不过去）；
 *   ④ 卡里还要有一句「去「xxx」›」的落点说明（纯图标卡片用户不知道会跳哪）。
 * ------------------------------------------------------------------------- */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* 从 welcome.html 里抠出「三步卡」：class 含 kh-step 且带 href 的 <a> */
function steps() {
  const html = read('welcome/welcome.html');
  const out = [];
  const re = /<a\b[^>]*class="[^"]*\bkh-step\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const href = (tag.match(/href="([^"]+)"/) || [])[1] || '';
    /* 卡片的正文：从开始标签到下一个 </a> */
    const rest = html.slice(m.index + tag.length);
    const body = rest.slice(0, rest.indexOf('</a>') >= 0 ? rest.indexOf('</a>') : 0);
    out.push({ href: href, body: body });
  }
  return out;
}

function sections() {
  const src = read('options/options.js');
  const m = src.match(/const SECTIONS = \[([^\]]*)\]/);
  truthy(m, 'options.js 里应能读到 SECTIONS 数组');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

module.exports = async function run() {
  suite('三步上手可点直达（welcome.html 深链）');

  await test('三张卡都是链接，且每条 #sec-xxx 都是真实分区', () => {
    const list = steps();
    eq(list.length, 3, '三步上手应有 3 张可点卡片，实际 ' + list.length);
    const secs = sections();
    truthy(secs.length >= 7, 'SECTIONS 至少 7 项，实际 ' + secs.length);
    list.forEach((s, i) => {
      truthy(/^(\.\.\/)?options\/options\.html#sec-[a-z]+$/.test(s.href),
        '第 ' + (i + 1) + ' 张卡的 href 必须是 options/options.html#sec-xxx，实际 ' + JSON.stringify(s.href));
      const id = s.href.split('#sec-')[1];
      truthy(secs.indexOf(id) >= 0, '第 ' + (i + 1) + ' 张卡指向的分区 #sec-' + id + ' 在 SECTIONS 里不存在：' + secs.join(','));
    });
  });

  await test('三个目标各不相同：关键词 / 样式 / 导入导出', () => {
    const ids = steps().map((s) => s.href.split('#sec-')[1]);
    eq(ids.join(','), 'keywords,style,data', '三张卡应分别落到 关键词管理 / 样式 / 导入导出，实际 ' + ids.join(','));
    eq(new Set(ids).size, 3, '三张卡不许指向同一节（否则后两步等于装饰）');
  });

  await test('每张卡都有一句落点说明（去「xxx」›），不是纯图标', () => {
    steps().forEach((s, i) => {
      truthy(/class="kh-step-go"[^>]*>[^<]*去/.test(s.body),
        '第 ' + (i + 1) + ' 张卡缺少「去「…」›」落点说明');
      truthy(/class="kh-step-t"/.test(s.body), '第 ' + (i + 1) + ' 张卡缺少标题');
      truthy(/class="kh-step-d"/.test(s.body), '第 ' + (i + 1) + ' 张卡缺少说明文字');
    });
  });

  await test('options.js 启动时真的读 location.hash（否则深链只改地址栏）', () => {
    const src = read('options/options.js');
    truthy(/location\.hash/.test(src), 'options.js 必须读 location.hash');
    truthy(/#sec-/.test(src), 'options.js 必须处理 #sec- 前缀');
    truthy(/'#' \+ sec\.id|'#'\+sec\.id/.test(src), '切分区时要把 #sec-xxx 写回地址栏（history.replaceState）');
  });

  await test('页面上不再有旧的不可点卡片（div.kh-step 死文案）', () => {
    const html = read('welcome/welcome.html');
    falsy(/<div\b[^>]*class="kh-step"/.test(html),
      'welcome.html 里不应再有 <div class="kh-step">，那会变成点不动的死卡');
  });
};
