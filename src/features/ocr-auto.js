/* src/features/ocr-auto.js — 证书 / 授权书自动抽取，直接进表（2026-11-12 用户需求）
 * ---------------------------------------------------------------------------
 * 用户原话：「现在进表依靠著作权人、登记号、授权方、授权人之类的 OCR 命中结果，
 * 没有命中就不会进表。有没有办法实现针对性优化，自动识别对应内容，然后进表展示。」
 * 点名两类文档：
 *   · 计算机软件著作权登记证书 / APP 电子版权证书 → 著作权人、登记号
 *   · 上述两种证书的授权书 → 授权方、被授权方、应用名称、包名、授权期限
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
  var CODE_RE = /^(?:19|20)\d{2}[A-Z]{2}\d{6,9}$/;
  var CN_CODE_RE = /^(?:软著登字第|第)\d{4,8}号$/;
  function okCode(v) {
    var s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
    if (!s || s.length > 40) return false;
    return CODE_RE.test(s) || CN_CODE_RE.test(s);
  }

  /* 包名：至少两段、带点（`com.example.app`）。上架后的包名不会只有一段。 */
  function okPkg(v) {
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(v);
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
   * —— 真机上「著 作 权 人」「登 记 号」很常见。`被授权方` 不能被 `授权方` 抢走（notAfter）。 */
  var DEFS = [
    { id: 'owner', label: '著作权人', words: ['著作权人', '著作权所有者', '版权所有人', '版权人'], line: /(著作权人|著作权所有者|版权所有人|版权人)/, ok: okName },
    { id: 'regNo', label: '登记号', words: ['登记号', '证书号'], line: /(登记号|证书号|软著登字第)/, strong: /登\s*记\s*号/, ok: okCode },
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
    { id: 'coop', label: '合作内容', words: ['合作内容', '合作范围', '合作方式', '授权内容', '授权范围'], line: /(合作内容|合作范围|合作方式|授权内容|授权范围)/, ok: okCoop }
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

  /* 文档类型 → 要抽的字段（顺序即进表顺序，与用户点名顺序一致） */
  var SETS = {
    cert: ['owner', 'regNo'],
    auth: ['licensor', 'licensee', 'appName', 'pkg', 'term'],
    /* APP 备案核准：主体 + 备案号 + 应用名 + 域名 */
    record: ['registrant', 'recordNo', 'appName', 'domain'],
    /* 资质 / 合作协议：谁授权给谁 + 应用 + 期限 + 合作内容 */
    agreement: ['licensor', 'licensee', 'appName', 'pkg', 'term', 'coop']
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

  /* 标题只在前 4 个非空行里找：证书/授权书的标题永远在顶上，正文里的「授权」二字不算信号。 */
  function headOf(it) {
    var lines = textOf(it).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length && out.length < 4; i++) {
      var t = lines[i].trim();
      if (t) out.push(t);
    }
    return out.join(' ');
  }

  function docOf(it) {
    var label = String((it && it.label) || '');
    if (/授权书/.test(label)) return 'auth';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(label)) return 'record';
    if (/合作协议|联运协议|推广协议|代理协议|资质|许可协议|授权协议/.test(label)) return 'agreement';
    if (/登记证书|版权证书/.test(label)) return 'cert';
    var head = headOf(it);
    if (/授权书/.test(head)) return 'auth';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(head)) return 'record';
    if (/合作协议|联运协议|推广协议|代理协议|许可协议|授权协议/.test(head)) return 'agreement';
    if (/著作权登记证书|电子版权证书|软件著作权登记证书|版权认证证书/.test(head)) return 'cert';
    return '';
  }

  /** 文档细类：`cert-soft` / `cert-app` / `auth-soft` / `auth-app` /
   *  `record-app` / `agreement-soft|app|qual`。只影响进表名字，不影响抽哪些字段。 */
  function kindOf(it) {
    var doc = docOf(it);
    if (!doc) return '';
    if (doc === 'record') return 'record-app';
    var label = String((it && it.label) || '');
    var head = headOf(it);
    var full = textOf(it);
    /* 正文证据优先：授权书正文里的登记号是 `2022SR…`（软著），或者明写「电子版权 / APP 版权」。
     * 只看字段名会把「APP 电子版权授权书」这种配置套到软著文件上，进表名头就错了。 */
    var soft = /(?:19|20)\d{2}\s*SR\s*\d{5,}/i.test(full) || /软著登字/.test(full);
    var app = /电子版权|APP\s*版权|App\s*版权/i.test(full) || /APP|App|app|电子版权/.test(label + ' ' + head);
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

  /** 一行里按「精确 → 宽松」找字段标签；命中就把 match 带回来（取值要按真正命中的那段切）。 */
  function firstHit(line, def) {
    var tries = [];
    if (def.strong) tries.push(def.strong);
    tries.push(def.line);
    if (def.loose) tries.push(def.loose);
    for (var i = 0; i < tries.length; i++) {
      var m = tries[i].exec(line);
      if (m) return { m: m };
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
      var m = /(?:19|20)\d{2}\s*[A-Za-z]{2}\s*\d{6,9}/.exec(full);
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
  /**
   * 从一条 OCR 条目里抽出可以进表的行。
   * @param {object} it `KH.ImgOcr.items()` 里的条目（`state/text/label/src`）
   * @returns {{label:string,value:string,doc:string,src:string}[]}
   */
  function rowsFor(it) {
    if (!it || it.state !== 'done' || !it.text) return [];
    var doc = docOf(it);
    if (!doc) return [];
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
      if (!v || !def.ok(v)) continue;
      /* 授权方/被授权方按文档细类改名：软著与 APP 电子版权不能混成同一个字段名。 */
      var label = overrides[def.id] || def.label;
      var TN = KH.TextNorm;
      var sig = TN ? (TN.keyOf(label) + '|' + TN.keyOf(v)) : (label + '|' + v);
      if (seen[sig]) continue;
      seen[sig] = 1;
      out.push({ label: label, value: v, doc: doc, kind: kind, src: String(it.src || '') });
    }
    return out;
  }

  KH.OcrAuto = {
    rowsFor: rowsFor,
    docOf: docOf,
    kindOf: kindOf,
    fieldsOf: function (doc) { return (SETS[doc] || []).slice(); },
    DEFS: DEFS,
    LABELS: LABELS
  };
})();
