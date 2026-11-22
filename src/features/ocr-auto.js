/* src/features/ocr-auto.js — 证书 / 授权书自动抽取，直接进表（2026-11-12 用户需求）
 * ---------------------------------------------------------------------------
 * 用户原话：「现在进表依靠著作权人、登记号、授权方、授权人之类的 OCR 命中结果，
 * 没有命中就不会进表。有没有办法实现针对性优化，自动识别对应内容，然后进表展示。」
 * 点名两类文档：
 *   · 计算机软件著作权登记证书 / APP 电子版权证书 → 著作权人、登记号
 *   · 上述两种证书的授权书 → 授权方、被授权方、应用名称、包名、授权期限
 *
 * 【2026-11-13 用户补充口径】不再要求「标签 + 空格 + 冒号」：
 *   · 软著 / APP 版权图里 `2026SR0635345` 是固定形状 ⇒ 直接按形状定位登记号，
 *     标签被 OCR 认坏（`记 号`）也照样能取；`证书号 软著登字第…号` 不是登记号；
 *   · 公司名 / 人名就是著作权人（可能多个、可能带「A 转让给 B」的转移关系）⇒
 *     标签值取不到时，按「单位后缀 / 人名」扫正文，再剔掉版权局、版权保护中心等发证机关；
 *   · 授权书同样先认公司 / 人名，再用「致…」「甲方 / 乙方」「谁授权给谁」「我司 / 本公司」
 *     这些参考线索判授权方与被授权方 —— 判不出来时宁可少一行，不判反。
 *
 * 口径（只做「先认得出是什么文档」之后的结构化抽取，不做无边界的猜）：
 *   1. 文档类型先看抓取字段名，再看 OCR 前几行的标题；两处都没有信号就不抽 ——
 *      绝不把一张普通截图里随便一行当成「著作权人」。
 *   2. 每类文档只抽点名的字段，顺序固定（进表行的顺序跟着配置走）。
 *   3. 取值只认两种版式：「标签 + 分隔符 + 值」和「标签独占一行、值在下一行」。
 *      同一行里有多个标签时，值只取到下一个标签之前。
 *   4. 值还要过字段自己的形状校验：包名必须带点、登记号必须是编号形状、
 *      授权期限必须是一段时间 —— 宁可少一行，不可错一行。
 *   5. 不缓存、不落盘：每次都由 `ocrExtraRows` 拿当前条目重算，OCR 文本变了行就跟着变。
 * ========================================================================= */
(function () {
  'use strict';

  var KH = window.KH = window.KH || {};
  if (KH.OcrAuto) return;

  /* ---------------- 值的形状校验 ---------------- */

  function okName(v) {
    return v.length >= 2 && v.length <= 40;
  }

  /* 登记号必须是**编号形状**，不是随便一串数字（2026-11-12 用户点名）：
   *   · 主流形：4 位年份 + 2 位字母 + 6–9 位数字，如 `2026SA0112833`、`2019SR0456789`；
   *   · 中文形：`软著登字第1234567号`、`第1234567号`。
   * 纯数字、纯字母、把公司名/电话带进来的一律不算。 */
  var CODE_RE = /^(?:19|20)\d{2}[A-Z]{1,3}\d{5,10}$/;
  var CN_CODE_RE = /^(?:软著登字第|第)\d{4,8}号$/;
  /* OCR 常把数字认成字母（0↔O、1↔I/l、5↔S、8↔B、2↔Z…）。证书图上「2026SR08464O4」只因
   * 一个 O 就整条丢掉，卡片上就没有登记号（2026-11-18 用户样图）。
   * 这里只把**数字位**上的易混字符改回来，字母段（SR / SA）原样保留 ——
   * 否则「2026SR」这类字母段会被吃成数字，纯数字串也会误判成编号。 */
  var CONFUSE = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8' };
  function fixDigits(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      o += (CONFUSE[c] || c);
    }
    return o;
  }
  /* 从 s[i] 起读一个「年份 + 字母段 + 流水号」：读不出返回 ''。
   * 用逐位扫描而不是整串正则，因为 OCR 对登记号的破坏不止「数字读成字母」：
   *   ① 年份读重：`202424SR0242674`（把年份尾巴又读了一遍）；
   *   ② 流水号开头的 0 读成字母：`2024SRO242674`（字母段末尾那个 O 其实属于流水号）；
   *   ③ 数字位读成字母：`2O26SR1OO1O64`。
   * 规则：年份 4 位（允许易混字符，修好后必须是 19xx/20xx）；年份之后、字母段之前多出来的数字
   * 一律丢弃（流水号不可能在字母段前面）；字母段最多 3 位；流水号只认数字与易混字符，读到别的
   * 字符就停；不足 7 位时把字母段末尾的易混字母（O→0 之类）挪进流水号；超过 7 位裁到 7 位。 */
  function codeAt(s, i) {
    var year = fixDigits(String(s).slice(i, i + 4));
    if (!/^(?:19|20)\d{2}$/.test(year)) return '';
    var j = i + 4;
    /* 只丢纯数字：S/A/B/G/T/Z/I/L 这些既是易混数字也是合法字母段（SR/SA），不能当多余字符丢掉。 */
    while (j < s.length && /[0-9]/.test(s.charAt(j))) j++;
    var letters = '';
    while (j < s.length && letters.length < 3 && /[A-Za-z]/.test(s.charAt(j))) {
      letters += s.charAt(j).toUpperCase();
      j++;
    }
    if (!letters) return '';
    var num = '';
    while (j < s.length && num.length < 12) {
      var ch = s.charAt(j).toUpperCase();
      if (/[0-9]/.test(ch)) { num += ch; j++; continue; }
      if (CONFUSE[ch]) { num += CONFUSE[ch]; j++; continue; }
      break;
    }
    while (num.length < 7 && letters.length > 1) {
      var last = letters.charAt(letters.length - 1);
      if (!CONFUSE[last]) break;
      letters = letters.slice(0, -1);
      num = CONFUSE[last] + num;
    }
    if (!/^\d{5,10}$/.test(num)) return '';
    if (num.length > 7) num = num.slice(0, 7);
    return year + letters + num;
  }

  /* 一段文字里所有能读成登记号的位置（同一编号只留一次）。空格先去掉：竖排/被拆开的号码常带空格。 */
  function codesIn(text) {
    var out = [];
    var s = String(text == null ? '' : text).replace(/\s+/g, '');
    for (var i = 0; i < s.length; i++) {
      if (!/[0-9OQDILSZAGTB]/.test(s.charAt(i))) continue;
      var c = codeAt(s, i);
      if (!c || out.indexOf(c) >= 0) continue;
      out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  }

  /* 归一后的编号（判形状与展示都用它，卡片上显示的是修好的号码）。 */
  function normalizeCode(v) {
    var raw = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
    if (!raw) return '';
    /* 中文形（软著登字第…号）原样保留：它不走「年 + 字母 + 流水号」这条路。 */
    if (CN_CODE_RE.test(raw)) return raw;
    var s = raw.replace(/[^0-9A-Z]/g, '');
    for (var i = 0; i < s.length; i++) {
      if (!/[0-9OQDILSZAGTB]/.test(s.charAt(i))) continue;
      var c = codeAt(s, i);
      if (c) return c;
    }
    return raw;
  }
  function okCode(v) {
    var s = normalizeCode(v);
    if (!s || s.length > 40) return false;
    return CODE_RE.test(s) || CN_CODE_RE.test(s);
  }

  /* 包名：至少两段、带点（`com.example.app`）。上架后的包名不会只有一段。 */
  function okPkg(v) {
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(v);
  }

  /* ---------------- 有效期推算（2.0.14 需求三） ----------------
   * 「有效期为 N 年，自双方均盖章之日起生效」⇒ 盖章日起算，到期日 = 周年日；
   * 「若到期双方无异议，自动续约 N 年」⇒ 按次数叠加，没写次数按 1 次，写「次数不限」⇒ 长期；
   * 日期读不到时不猜，输出「待补：盖章日期（有效期N年）」。
   * 到期日口径（用户 2026-11-19 例子）：盖章 2026-01-01 + 3 年 ⇒ 2029-01-01。 */
  var CN_DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  var CN_FIN = { '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9, '拾': 10 };
  var NUM_CH = '0-9〇零一二两三四五六七八九十壹贰叁肆伍陆柒捌玖拾';

  function numOf(raw) {
    var t = String(raw == null ? '' : raw).replace(/\s+/g, '');
    if (!t) return 0;
    if (/^[0-9]+$/.test(t)) return parseInt(t, 10) || 0;
    var at = t.indexOf('十');
    if (at >= 0) {
      var hi = at === 0 ? 1 : (CN_DIGIT[t.charAt(at - 1)] || CN_FIN[t.charAt(at - 1)] || 0);
      var lo = at === t.length - 1 ? 0 : (CN_DIGIT[t.charAt(at + 1)] || CN_FIN[t.charAt(at + 1)] || 0);
      return hi * 10 + lo;
    }
    var n = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      var d = CN_DIGIT[c];
      if (d == null) d = CN_FIN[c];
      if (d == null) return 0;
      n = n * 10 + d;
    }
    return n;
  }

  var DATE_CN = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?/;
  var DATE_NUM = /((?:19|20)\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/;
  function dateOf(s) {
    var t = String(s == null ? '' : s);
    var m = DATE_NUM.exec(t);
    var y = 0, mo = 0, d = 0, hasDay = false;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; hasDay = true; }
    else {
      m = DATE_CN.exec(t);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = m[3] ? +m[3] : 1; hasDay = !!m[3];
    }
    if (!(y >= 1990 && y <= 2100) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (d > new Date(y, mo, 0).getDate()) return null;
    return { y: y, m: mo, d: d, hasDay: hasDay };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(t) { return t.y + '-' + pad2(t.m) + '-' + pad2(t.d); }

  function addMonths(t, n) {
    var m0 = (t.m - 1) + n;
    var y = t.y + Math.floor(m0 / 12);
    var mo = (m0 % 12 + 12) % 12 + 1;
    var last = new Date(y, mo, 0).getDate();
    return { y: y, m: mo, d: Math.min(t.d, last) };
  }
  function addYears(t, n) { return addMonths(t, n * 12); }
  function addDays(t, n) {
    var dt = new Date(t.y, t.m - 1, t.d + n);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  function addDur(t, dur) {
    if (!dur || !dur.n) return t;
    if (dur.unit === 'y') return addYears(t, dur.n);
    if (dur.unit === 'm') return addMonths(t, dur.n);
    return addDays(t, dur.n);
  }
  function durText(dur) {
    if (!dur || !dur.n) return '';
    return dur.n + (dur.unit === 'y' ? '年' : (dur.unit === 'm' ? '个月' : '天'));
  }

  /* 期间：只认「有效期/期限」附近紧邻的数字 + 单位，避免把正文里「三年内不得…」当期间。 */
  function durationOf(full) {
    var t = String(full == null ? '' : full);
    var re = new RegExp('(?:有效期|授权期限|合作期限|合同期限|协议期限|期限)\\s*(?:为|是|限|共)?\\s*([' + NUM_CH + ']{1,4})\\s*(年|个月|月|天|日)');
    var m = re.exec(t);
    if (!m) return null;
    var n = numOf(m[1]);
    if (!n || n > 120) return null;
    var u = m[2];
    return { unit: (u === '年') ? 'y' : ((u === '天' || u === '日') ? 'd' : 'm'), n: n };
  }

  /* 自动续约条款：是否自动、每次多久、最多几次、是否不限次数。 */
  function renewalOf(full) {
    var t = String(full == null ? '' : full);
    var auto = /自动续约|自动续期|自动续展|自动延期/.test(t)
      || /(?:无异议|未提出异议|没有异议)[^。；\n]{0,20}(?:自动)?(?:续约|续期|续展|延长)/.test(t);
    if (!auto) return null;
    var once = { unit: 'y', n: 1 };
    var dm = new RegExp('(?:续约|续期|续展|延长)\\s*(?:期限|期)?\\s*(?:为|是)?\\s*([' + NUM_CH + ']{1,4})\\s*(年|个月|月|天|日)').exec(t);
    if (dm) {
      var n = numOf(dm[1]);
      if (n && n <= 120) {
        var u = dm[2];
        once = { unit: (u === '年') ? 'y' : ((u === '天' || u === '日') ? 'd' : 'm'), n: n };
      }
    }
    var unlimited = /次数不限|不限次数|无限次|可无限(?:次)?续|直至一方|直到一方|随时(?:书面)?(?:通知)?(?:终止|解除)/.test(t);
    var max = null;
    var mm = new RegExp('(?:最多|至多|不超过|上限为?|限)\\s*(?:续约|续期|续签)?\\s*([' + NUM_CH + ']{1,3})\\s*次').exec(t)
      || new RegExp('([' + NUM_CH + ']{1,3})\\s*次为限').exec(t);
    if (mm) {
      var k = numOf(mm[1]);
      if (k > 0 && k <= 90) max = k;
    }
    return { auto: true, once: once, unlimited: unlimited, max: max };
  }

  /* 起算日：第一优先是「自 YYYY 年 M 月 D 日起生效」这类显式写法；
   * 其次是盖章/签章行上的日期；再次是签署/签订日期行。
   * 多个候选取最晚那个（「双方均盖章之日」= 两方都完成的那天）。 */
  function startDateOf(lines, full) {
    var explicit = /自\s*((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)\s*(?:起|开始)/.exec(full)
      || /((?:19|20)\d{2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2})\s*(?:起|开始)/.exec(full);
    if (explicit) {
      var d0 = dateOf(explicit[1]);
      if (d0) return d0;
    }
    var pool = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = String(lines[i] || '');
      if (!ln) continue;
      /* 有效期区间行（两个日期 + 至/到）不是盖章日。 */
      if (/(?:至|到|—|－|~|～)\s*(?:19|20)\d{2}/.test(ln)) continue;
      if (!/盖章|签章|签署|签订|签约|签发|出具|日期/.test(ln)) continue;
      var d = dateOf(ln);
      if (d && d.hasDay) pool.push(d);
    }
    if (!pool.length) return null;
    pool.sort(function (a, b) { return (a.y * 10000 + a.m * 100 + a.d) - (b.y * 10000 + b.m * 100 + b.d); });
    return pool[pool.length - 1];
  }

  /* 显式起止（两个日期 + 至/到）仍走原 singleValue 口径，本函数不重复处理。 */
  function hasExplicitRange(full) {
    var t = String(full == null ? '' : full);
    return /(?:19|20)\d{2}[^。；\n]{0,14}(?:至|到|—|－|~|～)[^。；\n]{0,14}(?:19|20)\d{2}/.test(t);
  }

  /* 有效期进表文案。没有可算的期间/续约条款、或已被显式区间覆盖时返回空串。 */
  function termCalc(full) {
    var t = String(full == null ? '' : full);
    if (!t || hasExplicitRange(t)) return '';
    var dur = durationOf(t);
    var ren = renewalOf(t);
    if (!dur && !ren) return '';
    if (!dur && ren) {
      /* 「有效期至 2025 年 12 月 1 日，到期自动续约一年」：终期已写明，直接在终期上叠加续约。 */
      var exp = /有效期\s*(?:至|到)\s*((?:19|20)\d{2}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2}\s*[日号]?)/.exec(t);
      var endAt = exp ? dateOf(exp[1]) : null;
      if (!endAt) return '';
      if (ren.unlimited) return '长期（有效期至 ' + fmtDate(endAt) + '，到期无异议自动续约' + durText(ren.once) + '，次数不限）';
      var expTimes = (ren.max == null) ? 1 : ren.max;
      var endExp = { y: endAt.y, m: endAt.m, d: endAt.d };
      for (var q = 0; q < expTimes; q++) endExp = addDur(endExp, ren.once);
      return fmtDate(endAt) + ' 至 ' + fmtDate(endExp) + '（到期无异议自动续约' + durText(ren.once) + '×' + expTimes + '次）';
    }
    var start = startDateOf(t.split(/\r?\n/), t);
    if (!start) return '待补：盖章日期（有效期' + (dur ? durText(dur) : '续约') + '）';
    var end = dur ? addDur({ y: start.y, m: start.m, d: start.d }, dur) : null;
    if (ren) {
      if (!dur) return '';
      if (ren.unlimited) {
        return '长期（自 ' + fmtDate(start) + ' 起，有效期' + durText(dur) + '，到期无异议自动续约）';
      }
      var times = (ren.max == null) ? 1 : ren.max;
      for (var k = 0; k < times; k++) end = addDur(end, ren.once);
      return fmtDate(start) + ' 至 ' + fmtDate(end) + '（有效期' + durText(dur) + (start.hasDay ? '' : '，按月初估算')
        + '，到期无异议自动续约' + durText(ren.once) + '×' + times + '次）';
    }
    return fmtDate(start) + ' 至 ' + fmtDate(end) + '（有效期' + durText(dur) + (start.hasDay ? '' : '，按月初估算') + '）';
  }

  /* 授权期限：必须有年份 + 起止关系（`2024年1月1日至2026年12月31日`、`2024-01-01 - 2026-12-31`）。 */
  function okTerm(v) {
    return v.length <= 60 && /(19|20)\d{2}/.test(v) && /(至|到|—|－|-|~|～|起)/.test(v);
  }

  /* APP 备案号：`京ICP备2023012345号-6A`（省简称 + ICP备 + 数字 + 序号 + 应用标识）。
   * 也有只写 `ICP备2023012345号` 的；纯数字、把「备案」二字当值的一律不算。 */
  function okRecordNo(v) {
    var s = String(v == null ? '' : v).replace(/\s+/g, '');
    return s.length >= 8 && s.length <= 40 && /(?:ICP|icp)备\d{4,10}号(?:-\d+[A-Za-z]?)?/.test(s);
  }

  /* 域名：至少两段带点（`example.com`、`app.example.com.cn`），允许被 OCR 断在端口前。 */
  function okDomain(v) {
    return /^[A-Za-z0-9][A-Za-z0-9\-.]*\.[A-Za-z]{2,}(?::\d+)?$/.test(v);
  }

  /* 合作内容/授权范围是整句说明，不校验形状，只挡空值和超长（防止把整段正文塞进一格）。 */
  function okCoop(v) {
    return v.length >= 2 && v.length <= 120;
  }

  /* ---------------- 字段定义 ----------------
   * `line` 是紧凑写法（最常用）；`words` 用来生成「字与字之间允许被 OCR 拆开」的宽松写法
   * —— 真机上「著 作 权 人」「登 记 号」很常见。`被授权方` 不能被 `授权方` 抢走（notAfter）。
   * 【2026-11-13】`证书号` 不再是登记号的别名：证书号是 `软著登字第…号`，与用户点名的
   * 登记号是两件事；证书类的登记号改走形状优先（`regNoValues`）。 */
  var DEFS = [
    { id: 'owner', label: '著作权人', words: ['著作权人', '著作权所有者', '版权所有人', '版权人'], line: /(著作权人|著作权所有者|版权所有人|版权人)/, ok: okName },
    /* 【2026-11-16】APP 电子版权证书上的编号常叫「认证号」（也写「认证编号」），
     * 与软著的「登记号」是同一种东西：都必须是「年号 + 字母 + 数字」形状，不进这形状的一律不收。 */
    { id: 'regNo', label: '登记号', words: ['登记号', '认证号', '认证编号'], line: /(登记号|认证号|认证编号|软著登字第)/, strong: /登\s*记\s*号|认\s*证\s*号|认\s*证\s*编\s*号/, ok: okCode },
    { id: 'licensor', label: '授权方', words: ['授权方', '授权人', '授权单位', '授权公司', '甲方'], notAfter: '被', line: /(?<!被)(授权方|授权人|授权单位|授权公司|甲方)/, rev: /^(.{2,40}?)\s*[（(]\s*(?:授权公司|授权方|授权单位|甲方)\s*[）)]/, ok: okName },
    { id: 'licensee', label: '被授权方', words: ['被授权方', '被授权人', '被授权单位', '被授权公司', '乙方'], line: /(被授权方|被授权人|被授权单位|被授权公司|乙方)/, rev: /^(.{2,40}?)\s*[（(]\s*(?:被授权公司|被授权方|被授权单位|乙方)\s*[）)]/, ok: okName },
    { id: 'appName', label: '应用名称', words: ['应用名称', '软件名称', '应用名', '软件名'], line: /(应用名称|软件名称|APP\s*名称|应用名|软件名)/i, ok: okName },
    { id: 'pkg', label: '包名', words: ['包名', '包名称'], line: /(包名|包名称|Bundle\s*ID|applicationId|Application\s*ID)/i, ok: okPkg },
    { id: 'term', label: '授权期限', words: ['授权期限', '授权有效期', '授权期间', '有效期', '期限'], line: /(授权期限|授权有效期|授权期间|有效期|期限)/, ok: okTerm },

    /* —— APP 备案核准（2026-11-12 用户点名）——
     * 备案类文件的「主体」不叫著作权人，叫主办单位；编号是 `京ICP备…号-6A`。 */
    { id: 'registrant', label: '主办单位', words: ['主办单位', '主办单位名称', '主办者', '备案主体', '备案单位'], line: /(主办单位名称|主办单位|主办者|备案主体|备案单位)/, ok: okName },
    { id: 'recordNo', label: '备案号', words: ['备案号', '备案编号', 'ICP备案号', '网站备案号', 'APP备案号'], line: /((?:ICP|icp)?\s*备案(?:号|编号))/i, ok: okRecordNo },
    { id: 'domain', label: '域名', words: ['网站域名', '服务域名', '访问域名', '域名'], line: /(?:网站|服务|访问)?域名/, ok: okDomain },

    /* —— 资质 / 合作协议 ——
     * 协议里常写「合作内容」「授权范围」，是整句，不当成名字校验。 */
    { id: 'coop', label: '合作内容', words: ['合作内容', '合作范围', '合作方式', '授权内容', '授权范围'], line: /(合作内容|合作范围|合作方式|授权内容|授权范围)/, ok: okCoop },

    /* —— 营业执照 / 各类资质（2026-11-13 用户点名）——
     * 这类文件的主体不叫著作权人，也不叫主办单位，就是「企业名称」；
     * 进表后要和抓取到的「开发者」比对，一致标绿、不一致标黄。 */
    { id: 'company', label: '企业名称', words: ['企业名称', '公司名称', '单位名称', '企业全称'], line: /(企业名称|公司名称|单位名称|企业全称)/, ok: okName },

    /* —— 承诺函（2026-11-13 用户点名）——
     * 承诺对象 = 写给哪个应用平台（vivo/维沃/广东天宸 等，或「各应用平台」这种泛称）；
     * 承诺方   = 出具承诺函的主体（公司名，正文只写「我司」时就是「我司」）。 */
    { id: 'promiseTo', label: '承诺对象', words: ['承诺对象', '收件单位', '报送单位'], line: /(承诺对象|收件单位|报送单位)/, ok: okName },
    { id: 'promiser', label: '承诺方', words: ['承诺方', '承诺单位', '承诺主体', '承诺人', '出具单位'], line: /(承诺方|承诺单位|承诺主体|承诺人|出具单位)/, ok: okName }
  ];

  function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function looseSource(words) {
    var parts = [];
    for (var i = 0; i < words.length; i++) {
      parts.push(words[i].split('').map(escRe).join('\\s*'));
    }
    return parts.join('|');
  }

  var BY_ID = {};
  for (var di = 0; di < DEFS.length; di++) {
    var def0 = DEFS[di];
    if (def0.words && def0.words.length) {
      def0.loose = new RegExp((def0.notAfter ? '(?<!' + def0.notAfter + ')' : '') + '(?:' + looseSource(def0.words) + ')');
    }
    BY_ID[def0.id] = def0;
  }

  /* 文档类型 → 要抽的字段（顺序即进表顺序，与用户点名顺序一致）。
   * 【2026-11-17 用户第 3 条】只保留「计算机软件著作权登记证书」（含 APP 电子版权证书）与
   * 软著「登记事项变更或补充证明」两套模板；授权书 / 备案核准 / 合作协议 / 营业执照 / 承诺函
   * 的自动进表全部退场（这些内容改由关键词配置表达）。
   * 唯一例外是「授权期限」：见 rowsFor 末尾 —— 它对任何非证书文档仍单独抽一次。 */
  var SETS = {
    cert: ['owner', 'regNo'],
    /* 软著「登记事项变更或补充证明」：同一份文件给出变更后的主体名与原本的登记号 */
    amend: ['owner', 'regNo']
  };

  /* 授权方/被授权方进表时必须写明是**哪一种**授权（2026-11-12 用户点名）：
   * 软著的授权书与 APP 电子版权的授权书是两份不同的文件，进表不能都写成「授权方」。 */
  var LABELS = {
    'auth-soft': { licensor: '软著授权方', licensee: '软著被授权方' },
    'auth-app': { licensor: 'APP电子版权授权方', licensee: 'APP电子版权被授权方' },
    'record-app': { registrant: 'APP备案主办单位', recordNo: 'APP备案号', appName: 'APP备案应用名称', domain: 'APP备案域名' },
    'agreement-soft': { licensor: '软著合作授权方', licensee: '软著合作被授权方' },
    'agreement-app': { licensor: 'APP电子版权合作授权方', licensee: 'APP电子版权合作被授权方' },
    'agreement-qual': { licensor: '合作授权方', licensee: '合作被授权方' }
  };

  /* ---------------- 文档类型 ---------------- */

  function textOf(it) {
    return String((it && it.text) || '');
  }

  /* 标题只在前 6 个非空行里找：证书/授权书的标题永远在顶上，正文里的「授权」二字不算信号。
   * 【2026-11-17】原来是 4 行 —— 真机上证书截图前面常多出「中华人民共和国国家版权局」
   * 以及扫描件水印/编号等噪声行，标题被挤出窗口后 `docOf` 认不出证书，自动抽取整条不跑。 */
  function headOf(it) {
    var lines = textOf(it).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length && out.length < 6; i++) {
      var t = lines[i].trim();
      if (t) out.push(t);
    }
    return out.join(' ');
  }

  /* 证书标题兜底：前 12 行里只要有一行本身就是证书标题就认（允许前面压着更多噪声行）。 */
  var CERT_TITLE = /著作权登记证书|电子版权证书|软件著作权登记证书|版权认证证书/;
  function certTitle(it) {
    var lines = textOf(it).split(/\r?\n/);
    for (var i = 0; i < lines.length && i < 12; i++) {
      if (CERT_TITLE.test(String(lines[i] || '').trim())) return true;
    }
    return false;
  }

  /* 【2026-11-18 用户问题五】抓取字段名常常是「计算机软件著作权登记证书授权书」这种
   * 复合叫法 —— 图片本身是证书，只因为名字里带「授权书」就被判成授权书，登记号/著作权人
   * 整条不抽。判据：正文前 12 行有证书标题、且有登记号/认证号 ⇒ 按证书抽。 */
  function isCertBody(it) {
    return certTitle(it) && /登\s*记\s*号|认\s*证\s*号/.test(textOf(it));
  }
  /* 【2026-11-18 用户口径】著作权人 / 登记号只允许从**真正的证书**里自动进表：
   * 授权书即使挂在「计算机软件著作权登记证书」字段下，正文是授权书就不抽这两个字段
   * （授权书里的「授权方」不是著作权人，抽进去会把比对引到错的值上）。
   * 比对另走图片动态词 `#比`，值仍取这张图的 OCR 文本，不受这里影响。 */
  function headIsAuth(it) {
    return /授权书/.test(headOf(it));
  }
  function docOf(it) {
    var label = String((it && it.label) || '');
    if (/变更或补充证明|变更证明|变补字/.test(label)) return 'amend';
    if (headIsAuth(it)) return 'auth';
    if (/授权书/.test(label)) return isCertBody(it) ? 'cert' : 'auth';
    if (/承诺函|承诺书/.test(label)) return 'promise';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(label)) return 'record';
    /* 【2026-11-17 用户报障】「电子版权认证证书」里也含「认证证书」，原来先判 license 就把它
     * 当成营业执照类文档，只抽企业名称、不抽著作权人与认证号。证书标题必须先判。 */
    if (CERT_TITLE.test(label) || /登记证书|版权证书/.test(label)) return 'cert';
    if (/营业执照|企业法人营业执照|许可证|资质证书|认证证书/.test(label)) return 'license';
    if (/合作协议|联运协议|推广协议|代理协议|资质|许可协议|授权协议/.test(label)) return 'agreement';
    var head = headOf(it);
    if (/变更或补充证明|变更证明|变补字/.test(head)) return 'amend';
    if (/授权书/.test(head)) return isCertBody(it) ? 'cert' : 'auth';
    if (/承诺函|承诺书/.test(head)) return 'promise';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(head)) return 'record';
    /* 证书判定必须在 license 之前：见上面 label 分支的同一条说明。 */
    if (CERT_TITLE.test(head) || certTitle(it)) return 'cert';
    if (/营业执照|企业法人营业执照|许可证|资质证书|认证证书/.test(head)) return 'license';
    if (/合作协议|联运协议|推广协议|代理协议|许可协议|授权协议/.test(head)) return 'agreement';
    return '';
  }

  /** 文档细类：`cert-soft` / `cert-app` / `auth-soft` / `auth-app` /
   *  `record-app` / `agreement-soft|app|qual`。只影响进表名字，不影响抽哪些字段。 */
  function kindOf(it) {
    var doc = docOf(it);
    if (!doc) return '';
    if (doc === 'record') return 'record-app';
    /* 资质与承诺函不细分成 soft/app：它们的字段名就是「企业名称 / 承诺对象」，没有归属歧义。 */
    if (doc === 'license' || doc === 'promise') return doc;
    var label = String((it && it.label) || '');
    var head = headOf(it);
    var full = textOf(it);
    /* 正文证据优先：授权书正文里的登记号是 `2022SR…`（软著），或者明写「电子版权 / APP 版权」。
     * 只看字段名会把「APP 电子版权授权书」这种配置套到软著文件上，进表名头就错了。 */
    var soft = /(?:19|20)\d{2}\s*SR\s*\d{5,}/i.test(full) || /软著登字/.test(full);
    /* 包名 `com.demo.app` 里的小写 app 不是文档证据：APP 只认大写写法。 */
    var app = /电子版权|APP\s*版权|App\s*版权|APP/.test(full) || /APP|App|电子版权/.test(label + ' ' + head);
    /* 合作协议：看不出是软著还是 APP 版权时，名字回到中性的「合作授权方 / 合作被授权方」。 */
    if (doc === 'agreement') return 'agreement-' + (app && !soft ? 'app' : (soft ? 'soft' : 'qual'));
    return doc + '-' + (app && !soft ? 'app' : 'soft');
  }

  /* ---------------- 取值 ---------------- */

  /* 去掉标签后面的「：为是」之类的连接字，以及值尾巴上的标点。 */
  function clean(s) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s:：是为有从自（(【\[、，,;；]+/, '');
    s = s.replace(/[\s:：，,、;；。.]+$/, '');
    return s;
  }

  /* 【2026-11-16 用户样图】软著证书的版式把四字标签**逐字拉开**（`著 作 权 人：`、
   * `登 记 号：`）。原来的标签正则只认连写，这类证书只能靠正文兜底捞公司名 ——
   * 页面上还有代理机构、发证机关时就会抓错人。这里给每个字段词补一条「字间可插空格」的写法，
   * 命中位置仍按原行切，取值逻辑一点没变（匹配到的就是带空格那段，切完照样干净）。 */
  var SPACED_CACHE = {};
  function spacedOf(word) {
    var w = String(word == null ? '' : word);
    if (w.length < 3) return null;
    if (SPACED_CACHE[w]) return SPACED_CACHE[w];
    var parts = [];
    for (var i = 0; i < w.length; i++) {
      parts.push(w.charAt(i).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    SPACED_CACHE[w] = new RegExp(parts.join('\\s*'));
    return SPACED_CACHE[w];
  }

  /** 一行里按「精确 → 宽松 → 字间空格」找字段标签；命中就把 match 带回来（取值要按真正命中的那段切）。 */
  function firstHit(line, def) {
    var tries = [];
    if (def.strong) tries.push(def.strong);
    tries.push(def.line);
    if (def.loose) tries.push(def.loose);
    for (var i = 0; i < tries.length; i++) {
      var m = tries[i].exec(line);
      if (m) return { m: m };
    }
    var words = def.words || [];
    for (var k = 0; k < words.length; k++) {
      var r = spacedOf(words[k]);
      if (!r) continue;
      var sm = r.exec(line);
      /* 只认**真的带空格**的命中：`授\s*权\s*方` 也能零宽匹配「被授权方」，
       * 那就把「被授权方」的标签判成「授权方」了（本 spec 有专门一条守这个）。 */
      if (sm && /\s/.test(sm[0])) return { m: sm };
    }
    return null;
  }

  function isLabelLine(line) {
    for (var i = 0; i < DEFS.length; i++) {
      if (firstHit(line, DEFS[i])) return true;
    }
    return false;
  }

  /** 一行里出现多个字段时（证书常把「登记号 / 软件名称 / 著作权人」排在同一行），
   *  值只取到下一个字段标签之前。 */
  function cutAtNextLabel(rest, self) {
    var cut = rest.length;
    for (var i = 0; i < DEFS.length; i++) {
      if (DEFS[i] === self) continue;
      var h = firstHit(rest, DEFS[i]);
      if (h && h.m.index < cut) cut = h.m.index;
    }
    return rest.slice(0, cut);
  }

  function valueOfHit(line, def, m) {
    var rest = line.slice(m.index + m[0].length);
    /* 标签后面常跟一个括注（`授权方（甲方）：`）—— 它不是值的一部分。 */
    rest = rest.replace(/^\s*[（(][^）)]{0,8}[）)]/, '');
    return clean(cutAtNextLabel(rest, def));
  }

  /* 标签独占一行、值被 OCR 排到下一行（最多看两行，遇到另一个标签就停）。 */
  function valueNextLine(lines, at, def) {
    for (var j = at + 1; j < lines.length && j <= at + 2; j++) {
      var t = lines[j].trim();
      if (!t) continue;
      if (isLabelLine(t)) return '';
      var v = clean(t);
      return def.ok(v) ? v : '';
    }
    return '';
  }

  /* 反向版式：`公司名（被授权公司）：` —— 名字写在标签前面，授权书里很常见。 */
  function valueBeforeLabel(line, def) {
    if (!def.rev) return '';
    var m = def.rev.exec(String(line || '').trim());
    if (!m) return '';
    var v = clean(m[1]);
    /* `授权方（甲方）：公司名` 这种写法里，括号前的「授权方」只是标签本身，
     * 不能当成值；真正的值在冒号后面，交给常规路径。 */
    if (/^(?:甲方|乙方|被?授权(?:方|人|单位|公司))$/.test(v)) return '';
    return def.ok(v) ? v : '';
  }

  /* 应用名兜底：授权书常写 `《包包源头》(以下简称"授权应用")`，没有「应用名称」这个标签。 */
  function appNameFromTitle(full) {
    var re = /《([^》]{2,40})》/g;
    var m;
    var first = '';
    while ((m = re.exec(full))) {
      var v = clean(m[1]);
      if (!okName(v)) continue;
      if (/授权|协议|合同|证书|申请|说明|承诺/.test(v)) continue;
      var after = full.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (/以下简称|下称/.test(after)) return v;
      if (!first) first = v;
    }
    return first;
  }

  /* 版式兜底：登记号/授权期限有很稳的形状，标签被 OCR 认坏时还能捞回来。 */
  function fallbackText(full, id) {
    if (id === 'regNo') {
      var m = /(?:19|20)\d{2}\s*[A-Za-z]{1,3}\s*\d{5,10}/.exec(full);
      if (m) return m[0].replace(/\s+/g, '').toUpperCase();
      var cn = /((?:软著登字第|第)\s*\d{4,8}\s*号)/.exec(full);
      if (cn) return cn[1].replace(/\s+/g, '');
    }
    if (id === 'term') {
      var t = /((?:19|20)\d{2}\s*[年./\-]\s*\d{1,2}\s*[月./\-]\s*\d{1,2}\s*日?)\s*(?:至|到|—|－|-|~|～)\s*((?:19|20)\d{2}\s*[年./\-]\s*\d{1,2}\s*[月./\-]\s*\d{1,2}\s*日?)/.exec(full);
      if (t) return clean(t[1] + '至' + t[2]);
    }
    if (id === 'recordNo') {
      var r = /((?:[\u4e00-\u9fa5]{1,3})?\s*ICP\s*备\s*\d{4,10}\s*号(?:-\d+[A-Za-z]?)?)/i.exec(full);
      if (r) return r[1].replace(/\s+/g, '');
    }
    if (id === 'domain') {
      var d = /(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}/.exec(full);
      if (d && okDomain(d[0])) return d[0];
    }
    return '';
  }

  /* =========================================================================
   * 实体识别（2026-11-13 用户补充口径）
   * 「并不是一定要出现空格和冒号才能取到值……公司或者人名，属于著作权人
   *  （也可能出现多个，存在转移关系著作权人 a 转给 b）」。
   * 所以证书的著作权人不再只认标签：先认标签值，再用「单位后缀 / 人名」扫正文，
   * 最后剔掉发证机关。扫描前把行内空白压掉（`著 作 权 人`、`厦门房 在线科技` 都能拼回来）。
   * ========================================================================= */

  /* 发证机关 / 审核机关：它们也带「中心」「局」字样，但绝不是著作权人。 */
  var ISSUER_RE = /(版权局|版权保护中心|知识产权局|市场监督管理局|登记机关|版权中心)/;

  /* 单位后缀：按长度从长到短排，`有限公司` 不会被 `公司` 截短。 */
  var ORG_SUFFIX_SRC = '股份有限公司|有限责任公司|集团有限公司|有限公司|分公司|公司|研究院|研究所|事务所|工作室|合作社|基金会|协会|学校|大学|学院|医院|银行|支行|集团|中心|厂|商行|经营部|服务部|出版社|报社|电视台';
  var ORG_RE = new RegExp('([\\u4e00-\\u9fa5A-Za-z0-9（）()·&\\-]{2,40}?(?:' + ORG_SUFFIX_SRC + '))', 'g');

  /* 值前面粘着的标签词：扫到的候选可能是「著作权人吉林省…」，把标签切掉。 */
  var ORG_LABEL_WORDS = [
    '被授权公司', '被授权单位', '被授权方', '被授权人',
    '授权公司', '授权单位', '授权方', '授权人',
    '著作权人', '著作权所有者', '版权所有人', '版权人',
    '申请人名称', '申请人', '主办单位名称', '主办单位', '备案单位',
    '公司名称', '单位名称', '软件名称', '应用名称', '甲方', '乙方',
    '开发者', '开发人', '运营者', '运营单位'
  ];
  /* 候选前面常粘着的引导词（「本证书由…」「经…」「根据…」「授权上海乙…」）。
   * 只剥开头，避免误伤名字中间的字（「北京授权科技有限公司」不受影响）。 */
  var ORG_LEAD_RE = /^(?:本证书由|本软件由|兹由|兹有|现由|特此由|由|经|根据|依照|按照|同意授权|同意|授权给|授权予|授权|授予|许可给|许可予|许可|转让给|转移给|变更给|转给|受让给)\s*/;

  function orgTrim(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '');
    s = s.replace(/^[：:，,。；;、（）()《》【】"'“”‘’·\-]+/, '');
    var cut = 0;
    for (var i = 0; i < ORG_LABEL_WORDS.length; i++) {
      var idx = s.lastIndexOf(ORG_LABEL_WORDS[i]);
      if (idx >= 0) {
        var end = idx + ORG_LABEL_WORDS[i].length;
        if (end > cut) cut = end;
      }
    }
    if (cut) s = s.slice(cut);
    s = s.replace(/^[：:，,。；;、（）()《》【】"'“”‘’·\-]+/, '');
    s = s.replace(ORG_LEAD_RE, '');
    return s;
  }

  /** 抽出一段文本里的全部单位名（含位置，授权书判角色要用）。 */
  function orgHits(text) {
    var out = [];
    var flat = String(text == null ? '' : text).replace(/\s+/g, '');
    var m;
    ORG_RE.lastIndex = 0;
    while ((m = ORG_RE.exec(flat))) {
      var name = orgTrim(m[1]);
      if (!name || name.length > 40) continue;
      if (ISSUER_RE.test(name)) continue;
      var dup = false;
      for (var i = 0; i < out.length; i++) {
        if (out[i].name === name) { dup = true; break; }
      }
      if (!dup) out.push({ name: name, index: m.index, end: m.index + m[0].length });
    }
    /* 【2026-11-19 用户报障】惰性后缀把一家公司切成两个主体：
     * `南京楷灿科技有限公司杭州分公司` 先匹配到「…有限公司」，再从「杭州分公司」起匹配出「杭州分公司」；
     * `鼎信数智技术集团股份有限公司` 同理被切成「…集团」+「股份有限公司」。
     * 相邻命中（中间只隔零个或一个括号/点/空白）合并成同一个名字；跨「、」「；」不合并。 */
    var merged = [];
    /* 同一行判定：flat 里的换行还在，跨行的两个片段不算一家公司。 */
    function lineAt(at) { return flat.lastIndexOf('\n', Math.max(0, at - 1)); }
    for (var k = 0; k < out.length; k++) {
      var cur = out[k];
      var prev = merged[merged.length - 1];
      if (prev && cur.index >= prev.end && cur.index <= prev.end + 2 &&
          lineAt(cur.index) === lineAt(prev.end)) {
        var gap = flat.slice(prev.end, cur.index);
        if (!gap || /^[（()）·\-]+$/.test(gap)) {
          var nameEnd = cur.end;
          /* 命中停在「（杭州分公司」这种半截括号上：按已并入的左括号把同一行的右括号补齐，
           * 否则 okOwnerName 的括号配对校验会把整个名字丢掉。 */
          var seg = flat.slice(prev.index, nameEnd);
          var opens = (seg.match(/[（(]/g) || []).length;
          var closes = (seg.match(/[）)]/g) || []).length;
          while (opens > closes && nameEnd < flat.length && /[）)]/.test(flat.charAt(nameEnd))) {
            nameEnd += 1;
            closes += 1;
          }
          prev.name = orgTrim(flat.slice(prev.index, nameEnd));
          prev.end = nameEnd;
          continue;
        }
      }
      merged.push({ name: cur.name, index: cur.index, end: cur.end });
    }
    return merged;
  }
  function orgsIn(text) {
    var hits = orgHits(text);
    var out = [];
    for (var i = 0; i < hits.length; i++) out.push(hits[i].name);
    return out;
  }

  /* 人名只在「著作权人」上下文里认：2–4 个汉字，排除常见字段词。 */
  var PERSON_STOP = /^(?:中华人民共和国|国家版权局|中国版权|版权保护|计算机软件|软件著作权|登记证书|版权证书|原始取得|全部权利|权利范围|权利取得|版本号|登记号|证书号|软件名称|应用名称|著作权人|版权所有人|有限公司|有限责任公司|股份有限公司)$/;
  function okPersonName(v) {
    var s = String(v == null ? '' : v).replace(/[（(][^）)]*[）)]/g, '').trim();
    if (!/^[\u4e00-\u9fa5·]{2,4}$/.test(s)) return '';
    if (PERSON_STOP.test(s)) return '';
    return s;
  }

  /* 下一行取值（不做形状校验，留给调用方按实体再判）。 */
  function valueNextLineRaw(lines, at) {
    for (var j = at + 1; j < lines.length && j <= at + 2; j++) {
      var t = lines[j].trim();
      if (!t) continue;
      if (isLabelLine(t)) return '';
      return clean(t);
    }
    return '';
  }

  /* 著作权人可能是多个主体，也可能是「A 转让给 B」；这里一次收全。 */
  /* 主体名形状：真公司名括号必须成对，且不许是别的公司名的碎片。
   * 【2026-11-17 用户报障】APP 电子版权证书那张图的 OCR 把同一行读了两遍、拼在一起
   * （`芯聆启悦（南玲启悦（南京）网络科技有限公司`：两个左括号一个右括号），
   * 再叠上「全文兜底」把每行的公司片段都收进来，进表就多出「限责任公司」「cn）核验中心」这种行。 */
  function okOwnerName(s) {
    if (!s || s.length < 2 || s.length > 40) return false;
    /* 片段：从「限责任公司 / 责任公司 / 有限公司」这类中段起头 ⇒ 是别人名字的尾巴 */
    if (/^(?:限责任|责任公司|限公司|公司|责任有限)/.test(s)) return false;
    /* 噪音：核验/官网/服务号这类页面尾巴 */
    if (/扫码|核验|官网|服务号|www\.|\.com/i.test(s)) return false;
    /* 括号必须成对：成对才说明这一整串是同一个名字，不是两遍 OCR 拼起来的 */
    var op = (s.match(/[（(]/g) || []).length;
    var cl = (s.match(/[）)]/g) || []).length;
    if (op !== cl) return false;
    return true;
  }
  /* 变更或补充证明：主体名不在「著作权人：X」里，而在
   *   `著作权人姓名或名称` 下面那条 `变更后内容：X` 里（上面还有一条软件名称的「变更后内容」，
   *   所以必须跟着标签行定位，不能全文扫）。登记号仍是「登记号：2022SR1484008」，走 regNoValues。 */
  function amendOwnerValues(lines) {
    var out = [];
    function addRest(rest) {
      var s = clean(rest).replace(/[（(]?\[?简称[^\]}]*\]?[)）]?/g, '').replace(/\s*[Vv]\d+(\.\d+)*\s*$/, '').trim();
      if (!s) return;
      var os = orgsIn(s);
      if (os.length) { for (var i = 0; i < os.length; i++) add(os[i]); return; }
      var pn = okPersonName(s);
      if (pn) add(pn);
    }
    function add(v) {
      var s = clean(v);
      if (!okOwnerName(s)) return;
      if (out.indexOf(s) >= 0) return;
      out.push(s);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '');
      if (!/著作权人/.test(line)) continue;
      var same = /变更后内容\s*[：:]\s*(.+)$/.exec(line);
      if (same) { addRest(same[1]); continue; }
      for (var j = i + 1; j < lines.length && j <= i + 4; j++) {
        var m = /变更后内容\s*[：:]\s*(.+)$/.exec(String(lines[j] || ''));
        if (m) { addRest(m[1]); break; }
      }
    }
    /* 兜底：整份文件只有一条「变更后内容」，且正文里没出现「著作权人」标签。 */
    if (!out.length) {
      var only = [];
      for (var k = 0; k < lines.length; k++) {
        var mm = /变更后内容\s*[：:]\s*(.+)$/.exec(String(lines[k] || ''));
        if (mm) only.push(mm[1]);
      }
      if (only.length === 1) addRest(only[0]);
    }
    return out.slice(0, 8);
  }

  function ownerValues(lines, full) {
    var out = [];
    var fromLabel = 0;
    function add(v) {
      var s = clean(v).replace(/^[\s:：，,、；;]+/, '').trim();
      if (!okOwnerName(s)) return;
      if (ISSUER_RE.test(s)) return;
      for (var i = 0; i < out.length; i++) if (out[i] === s) return;
      out.push(s);
    }
    function addRest(rest) {
      var s = clean(rest);
      if (!s) return;
      /* 转移关系：A 转让给 B —— 两个主体都算权利人（用户点名的场景）。
       * 允许 OCR 把关系写在括号里：`A（转让给 B）`。 */
      var tm = /^(.{2,30}?)[（(]?(?:转让给|转移给|变更给|转给|受让给)(.{2,30})[）)]?$/.exec(s);
      if (tm) {
        var a = orgsIn(tm[1]);
        var b = orgsIn(tm[2]);
        var pa = okPersonName(tm[1]);
        var pb = okPersonName(tm[2]);
        if (a.length) { for (var ai = 0; ai < a.length; ai++) add(a[ai]); } else if (pa) add(pa);
        if (b.length) { for (var bi = 0; bi < b.length; bi++) add(b[bi]); } else if (pb) add(pb);
        if (a.length || b.length || pa || pb) return;
      }
      var orgs = orgsIn(s);
      if (orgs.length) {
        for (var oi = 0; oi < orgs.length; oi++) add(orgs[oi]);
        return;
      }
      /* 人名：`著作权人：张三、李四` 或 `著作权人：李天`。 */
      var parts = s.split(/[、,，;；和及与]/);
      var any = false;
      for (var i = 0; i < parts.length; i++) {
        var p = okPersonName(parts[i]);
        if (p) { add(p); any = true; }
      }
      /* 不像句式、也不含数字/字段词的短名字（如没有单位后缀的「华为」）原样收下。 */
      if (!any && s.length <= 20 && !/\d/.test(s) && !/[：:，,。；;]/.test(s) &&
          !/转让|转移|变更|受让|权利|取得|方式|范围|日期|版本|登记|证书|软件|应用/.test(s)) {
        add(s);
      }
    }
    /* ① 标签值（`著作权人：X` / `著作权人X` / 标签一行、值在下一行）。 */
    for (var i = 0; i < lines.length; i++) {
      var hit = firstHit(lines[i], BY_ID.owner);
      if (!hit) continue;
      var rest = valueOfHit(lines[i], BY_ID.owner, hit.m);
      if (!rest) rest = valueNextLineRaw(lines, i);
      var before = out.length;
      addRest(rest);
      if (out.length > before) fromLabel = 1;
    }
    /* ② 只在「① 一个都没取到」时才兜底：标签已经给出权利人时，正文里每行都再扫一遍
     *    只会把重复拼接的残片、页面尾巴也收进来（2026-11-17 用户报障的多余行）。
     *    标签被 OCR 认坏 / 根本没出现时的兜底：正文里的单位名都按著作权人处理。
     *    跳过软件名称、代理机构、审核发证这些行，避免把无关主体当成权利人。 */
    if (fromLabel) return out.slice(0, 8);
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (/软件名称|应用名称|APP\s*名称|简称|版本|代理|经办|受理|发证|登记机关|审核|地址|电话|邮编|邮箱|日期/i.test(ln)) continue;
      var os = orgsIn(ln);
      for (var k = 0; k < os.length; k++) add(os[k]);
    }
    return out.slice(0, 8);
  }

  /* 登记号：形状优先（2026-11-13 用户口径）。
   *   `证书号：软著登字第17849626号` 在第 3 行，`2026SR0635345` 在第 7 行 —— 前者不许抢后者。 */
  function regNoValues(lines, full) {
    var out = [];
    function add(v) {
      /* 归一里已经把「年份读重 / 流水号 0 读成字母 / 末尾多读一位」修好了（见 codeAt）。 */
      var s = normalizeCode(v);
      if (!s || !okCode(s)) return false;
      if (out.indexOf(s) < 0) out.push(s);
      return true;
    }
    /* ① 逐位扫描优先：被 OCR 破坏的编号（`202424SR…` / `2024SRO…`）不符合任何整串形状，
     *    只能按「年份 + 字母段 + 流水号」逐位还原。 */
    var found = codesIn(full);
    if (found.length && add(found[0])) return out;
    /* ①·b 整串形状兜底：年份 + 1–3 位字母 + 5–10 位数字（`2026SR0635345` / `2023SR1234567`）。
     *     标签读成 `记 号` / `认 证 号` 也不影响。 */
    var SHAPE = /([0-9OQDILSZAGTB]{4}\s*[A-Za-z]{1,3}\s*[0-9OQDILSZAGTB]{5,10})/;
    var m = SHAPE.exec(full);
    if (m && add(m[1])) return out;
    /* ② 登记号标签行：标签可能被读散（`登 记 号` / `记 号`），在行内找代码；
     *    号码被挤到**下一行**时（竖排证书常见）再看一眼下一行。 */
    var LABEL = /登\s*记\s*号|认\s*证\s*号|认\s*证\s*编\s*号|记\s*号/;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!LABEL.test(line)) continue;
      var cand = '';
      var inLine = codesIn(line);
      if (inLine.length) cand = inLine[0];
      else {
        var mm = SHAPE.exec(line) || /((?:软著登字第|第)\s*\d{4,8}\s*号)/.exec(line);
        cand = mm ? mm[1] : '';
      }
      if (!cand && lines[i + 1]) {
        var nx = codesIn(lines[i + 1]);
        if (nx.length) cand = nx[0];
        else {
          var mm2 = SHAPE.exec(lines[i + 1]);
          cand = mm2 ? mm2[1] : '';
        }
      }
      if (cand && add(cand)) return out;
    }
    /* ③ 中文形兜底：`证书号 软著登字第…号` 那一行不是登记号，跳过。 */
    for (var j = 0; j < lines.length; j++) {
      if (/证书号/.test(lines[j]) && !/登记号|认证号/.test(lines[j])) continue;
      var cn = /((?:软著登字第|第)\s*\d{4,8}\s*号)/.exec(lines[j]);
      if (cn && add(cn[1])) return out;
    }
    return out;
  }

  /* 营业执照 / 资质里的主体公司（2026-11-13 用户点名）。
   * 营业执照常用「名称」而不是「企业名称」，所以这里额外认行首的「名称」；
   * 都取不到时扫正文第一个单位名（跳过统一社会信用代码、地址、法人这些字段行）。 */
  function companyValues(lines, full) {
    var out = [];
    function add(name) {
      var s = clean(name);
      if (!s || s.length < 2 || s.length > 40) return;
      if (ISSUER_RE.test(s)) return;
      if (out.indexOf(s) >= 0) return;
      out.push(s);
    }
    function addText(t) {
      var os = orgsIn(t);
      for (var i = 0; i < os.length; i++) add(os[i]);
    }
    /* ① 标签值：企业名称 / 公司名称 / 单位名称 / 名称（行首）。 */
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var hit = firstHit(line, BY_ID.company);
      if (hit) {
        addText(valueOfHit(line, BY_ID.company, hit.m));
        continue;
      }
      var nm = /^(?:企业)?名称\s*[：:为]?\s*(.+)$/.exec(line.trim());
      if (nm && nm[1]) addText(nm[1]);
    }
    if (out.length) return out.slice(0, 2);
    /* ② 标签被认坏：正文里第一个单位名。证照编号、地址、法人、经营范围都不算。 */
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (/营业执照|许可证|资质证书|认证证书|统一社会信用代码|注册号|证书编号|住所|地址|经营场所|法定代表人|负责人|成立日期|营业期限|经营范围|注册资本|许可内容|发证机关|登记机关|有效期/i.test(ln)) continue;
      addText(ln);
      if (out.length) break;
    }
    return out.slice(0, 2);
  }

  /* 承诺对象：写给哪个应用平台。标签 → 「致：」收件人 → 正文平台名 → 泛称兜底。 */
  var PLATFORM_RE = /(vivo|维沃|广东天宸|天宸|华为|HUAWEI|小米|XIAOMI|OPPO|广东欢太|欢太|应用宝|腾讯|荣耀|HONOR|三星|SAMSUNG|魅族|MEIZU|中兴|努比亚|一加|realme|抖音|快手|百度|阿里|UC|应用平台|应用市场|应用商店)/i;
  function promiseToValues(lines, full) {
    var out = [];
    function add(v) {
      var s = clean(v);
      if (!s || s.length < 2 || s.length > 40) return;
      if (out.indexOf(s) >= 0) return;
      out.push(s);
    }
    /* ① 「承诺对象：vivo」这类标签。 */
    for (var i = 0; i < lines.length; i++) {
      var hit = firstHit(lines[i], BY_ID.promiseTo);
      if (!hit) continue;
      var v = valueOfHit(lines[i], BY_ID.promiseTo, hit.m);
      if (!v) v = valueNextLineRaw(lines, i);
      add(v);
      if (out.length) return out;
    }
    /* ② 书信体：`致：维沃移动通信有限公司` / `收件人：…`。 */
    for (var j = 0; j < lines.length; j++) {
      var m = /^(?:致|收件人|报送单位|尊敬的)\s*[：:]?\s*(.+)$/.exec(lines[j].trim());
      if (!m || !m[1]) continue;
      var os = orgsIn(m[1]);
      if (os.length) add(os[0]);
      else add(PLATFORM_RE.exec(m[1]) ? PLATFORM_RE.exec(m[1])[0] : m[1]);
      if (out.length) return out;
    }
    /* ③ 正文里出现平台名（`本函提交至广东天宸网络科技有限公司`）。 */
    var osAll = orgsIn(full);
    for (var k = 0; k < osAll.length; k++) {
      if (PLATFORM_RE.test(osAll[k])) { add(osAll[k]); return out; }
    }
    var pm = PLATFORM_RE.exec(full);
    if (pm) { add(pm[0]); return out; }
    /* ④ 没有指向任何具体平台：明确写成泛称，绝不能默认成绿。 */
    var gen = /(?:各|所有|全部)?(?:应用平台|应用市场|应用商店|渠道)/.exec(full);
    add(gen ? gen[0] : '未指定具体平台');
    return out;
  }

  /* 承诺方：出具承诺函的主体。标签 → 正文单位名（跳过收件人 / 平台行）→ 我司。 */
  function promiserValues(lines, full) {
    var out = [];
    function add(v) {
      var s = clean(v);
      if (!s || s.length < 2 || s.length > 40) return;
      if (ISSUER_RE.test(s)) return;
      if (out.indexOf(s) >= 0) return;
      out.push(s);
    }
    for (var i = 0; i < lines.length; i++) {
      var hit = firstHit(lines[i], BY_ID.promiser);
      if (!hit) continue;
      var v = valueOfHit(lines[i], BY_ID.promiser, hit.m);
      if (!v) v = valueNextLineRaw(lines, i);
      var os = orgsIn(v);
      if (os.length) { add(os[0]); return out; }
      if (okPersonName(v)) { add(okPersonName(v)); return out; }
    }
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (/^致\s*[：:]|承诺对象|收件人|报送单位|应用平台|应用市场|应用商店|日期|地址|电话|邮箱/.test(ln)) continue;
      var os2 = orgsIn(ln);
      if (os2.length) { add(os2[0]); return out; }
    }
    if (/我司|本公司/.test(full)) add('我司');
    return out;
  }

  /* 授权书角色参考判断（2026-11-13 用户口径）：
   * 先认公司/人名，再看线索 —— `致…`（收件人=被授权）、`（以下简称甲方/乙方）`、
   * `A 授权 B`（动词前=授权方、动词后=被授权方）、`我司 / 本公司`（发文方=授权方）。
   * 两个主体都找不到线索时不硬判，宁可不进表。 */

  /* 单值字段的取值路径（反向版式 → 精确词 → 通用标签 → 形状兜底 → 文档级兜底）。 */
  function singleValue(def, lines, full) {
    var v = '';
    /* 反向版式先试：`致趣娱科技（深圳) 有限公司（被授权公司)：` 里名字在标签左边，
     * 按「标签后取值」永远取到冒号后面那句话，被授权方就丢了。 */
    if (def.rev) {
      for (var ri = 0; ri < lines.length && !v; ri++) v = valueBeforeLabel(lines[ri], def);
    }
    /* 有 `strong`（更精确的标题词）就先按它找一遍：证书上同时印着「证书号」和「登记号」时，
     * 用户点名的「登记号」优先，不能被前一行那个别名抢走。 */
    if (def.strong) {
      for (var si = 0; si < lines.length && !v; si++) {
        var sm = def.strong.exec(lines[si]);
        if (!sm) continue;
        var strong = valueOfHit(lines[si], def, sm);
        if (strong && def.ok(strong)) v = strong;
        else if (!strong) v = valueNextLine(lines, si, def);
      }
    }
    for (var i = 0; i < lines.length && !v; i++) {
      var hit = firstHit(lines[i], def);
      if (!hit) continue;
      var same = valueOfHit(lines[i], def, hit.m);
      if (same && def.ok(same)) v = same;
      else if (!same) v = valueNextLine(lines, i, def);
    }
    if (!v || !def.ok(v)) v = fallbackText(full, def.id);
    if (!v || !def.ok(v)) {
      if (def.id === 'appName') v = appNameFromTitle(full);
      /* 授权书写「我司授予贵司…」时，授权方就是发文方本身；至少把主体关系标出来，
       * 不能让这一行整个消失。 */
      else if (def.id === 'licensor' && /我司|本公司/.test(full)) v = '我司';
    }
    return def.ok(v) ? v : '';
  }

  /* 这个值本身是不是一个「主体名」：授权书里标签取到的常常是一整句（`”）同意授权…`），
   * 这种值不能压过实体参考判断。 */

  /**
   * 从一条 OCR 条目里抽出可以进表的行。
   * @param {object} it `KH.ImgOcr.items()` 里的条目（`state/text/label/src`）
   * @returns {{label:string,value:string,doc:string,src:string}[]}
   */
  function rowsFor(it, opts) {
    if (!it || it.state !== 'done' || !it.text) return [];
    var doc = docOf(it);
    if (!doc) {
      /* 认不出文档类型时只留一条活口：授权期限（授权书版式千变万化，标题常常认不出来）。 */
      var lines0 = textOf(it).split(/\r?\n/);
      var tv0 = singleValue(BY_ID.term, lines0, lines0.join('\n'));
      return (tv0 && BY_ID.term.ok(tv0))
        ? [{ label: BY_ID.term.label, value: tv0, doc: '', kind: '', src: String(it.src || '') }]
        : [];
    }
    var kind = kindOf(it);
    var overrides = LABELS[kind] || {};
    var ids = SETS[doc] || [];
    var lines = textOf(it).split(/\r?\n/);
    var full = lines.join('\n');
    var out = [];
    var seen = {};
    for (var k = 0; k < ids.length; k++) {
      var def = BY_ID[ids[k]];
      if (!def) continue;
      var vals = [];
      if (def.id === 'owner' && doc === 'cert') {
        vals = ownerValues(lines, full);
      } else if (def.id === 'owner' && doc === 'amend') {
        vals = amendOwnerValues(lines, full);
      } else if (def.id === 'regNo' && doc === 'cert') {
        vals = regNoValues(lines, full);
      } else if (def.id === 'company' && doc === 'license') {
        vals = companyValues(lines, full);
      } else if (def.id === 'promiseTo' && doc === 'promise') {
        vals = promiseToValues(lines, full);
      } else if (def.id === 'promiser' && doc === 'promise') {
        vals = promiserValues(lines, full);
      } else {
        var one = singleValue(def, lines, full);
        if (one && def.ok(one)) vals = [one];
      }
      for (var vi = 0; vi < vals.length; vi++) {
        var v = vals[vi];
        if (!v || !def.ok(v)) continue;
        /* 授权方/被授权方按文档细类改名：软著与 APP 电子版权不能混成同一个字段名。 */
        var label = overrides[def.id] || def.label;
        var TN = KH.TextNorm;
        var sig = TN ? (TN.keyOf(label) + '|' + TN.keyOf(v)) : (label + '|' + v);
        if (seen[sig]) continue;
        seen[sig] = 1;
        out.push({ label: label, value: v, doc: doc, kind: kind, src: String(it.src || '') });
      }
    }
    /* 授权期限：授权书等模板已退场，但这一行仍要自动进表（用户 2026-11-17 点名保留）。 */
    if (doc === 'auth' || doc === 'agreement') {
      var termDef = BY_ID.term;
      var tv = termDef ? singleValue(termDef, lines, full) : '';
      /* 相对期间（有效期 N 年 + 盖章日起算 / 自动续约）要自己算：这一行文字里没有现成的起止日期。 */
      var tc = '';
      if (!tv || !termDef || !termDef.ok(tv)) {
        tc = termCalc(full);
        if (tc) tv = tc;
      }
      if (tv && (tc || termDef.ok(tv))) {
        var TN2 = KH.TextNorm;
        var tsig = TN2 ? (TN2.keyOf(termDef.label) + '|' + TN2.keyOf(tv)) : (termDef.label + '|' + tv);
        if (!seen[tsig]) {
          seen[tsig] = 1;
          out.push({ label: termDef.label, value: tv, doc: doc, kind: kind, src: String(it.src || '') });
        }
      }
    }
    return out;
  }

  KH.OcrAuto = {
    rowsFor: rowsFor,
    docOf: docOf,
    kindOf: kindOf,
    fieldsOf: function (doc) { return (SETS[doc] || []).slice(); },
    termCalc: termCalc,
    DEFS: DEFS,
    LABELS: LABELS
  };
})();