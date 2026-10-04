/* scripts/check-changelog-quotes.js — changelog 文案行的半角引号自检
 * ----------------------------------------------------------------------------
 * 为什么需要它：changelog 里每条说明都是**双引号字符串**，正文里只要出现一个半角 `"`
 * 就会把字符串提前截断 → 整个文件语法错误（出包闸门会红，但那时已经晚了）。
 * 这条踩过 5 次（1.99.99.7 两次、1.99.99.11/12/13 各一次），所以做成一个 20 行的自检：
 *   · 文案行（以 `"` 开头的行）必须**恰好 2 个**半角双引号；
 *   · 正文里要用引号请用「」。
 * 用法：node scripts/check-changelog-quotes.js   （退出码非 0 = 有问题）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'ui', 'changelog.js');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let bad = 0;
lines.forEach((line, i) => {
  const t = line.trim();
  if (!t.startsWith('"')) return;                 // 只看文案行
  /* 只数**未转义**的半角双引号：`\"` 是合法写法（历史文案里有），不算问题 */
  const n = (line.match(/(^|[^\\])"/g) || []).length;
  if (n !== 2) {
    bad++;
    console.log('  ✗ changelog.js:' + (i + 1) + ' 半角双引号 ' + n + ' 个（应为 2）—— 正文请改用「」');
  }
});
if (bad) {
  console.log('✗ changelog 文案自检失败：' + bad + ' 行');
  process.exit(1);
}
console.log('✓ changelog 文案自检通过（所有文案行恰好 2 个半角双引号）');
