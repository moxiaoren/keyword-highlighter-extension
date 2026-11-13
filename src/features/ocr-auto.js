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
   * —— 真机上「著 作 权 人」「登 记 号」很常见。`被授权方` 不能被 `授权方` 抢走（notAfter）。
   * 【2026-11-13】`证书号` 不再是登记号的别名：证书号是 `软著登字第…号`，与用户点名的
   * 登记号是两件事；证书类的登记号改走形状优先（`regNoValues`）。 */
  var DEFS = [
    { id: 'owner', label: '著作权人', words: ['著作权人', '著作权所有者', '版权所有人', '版权人'], line: /(著作权人|著作权所有者|版权所有人|版权人)/, ok: okName },
    { id: 'regNo', label: '登记号', words: ['登记号'], line: /(登记号|软著登字第)/, strong: /登\s*记\s*号/, ok: okCode },
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

  /* 文档类型 → 要抽的字段（顺序即进表顺序，与用户点名顺序一致） */
  var SETS = {
    cert: ['owner', 'regNo'],
    auth: ['licensor', 'licensee', 'appName', 'pkg', 'term'],
    /* APP 备案核准：主体 + 备案号 + 应用名 + 域名 */
    record: ['registrant', 'recordNo', 'appName', 'domain'],
    /* 资质 / 合作协议：谁授权给谁 + 应用 + 期限 + 合作内容 */
    agreement: ['licensor', 'licensee', 'appName', 'pkg', 'term', 'coop'],
    /* 营业执照 / 各类资质：只抽主体公司，进表后与「开发者」比对 */
    license: ['company'],
    /* 承诺函：写给哪个平台 + 谁出具的 */
    promise: ['promiseTo', 'promiser']
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
    if (/承诺函|承诺书/.test(label)) return 'promise';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(label)) return 'record';
    if (/营业执照|企业法人营业执照|许可证|资质证书|认证证书/.test(label)) return 'license';
    if (/合作协议|联运协议|推广协议|代理协议|资质|许可协议|授权协议/.test(label)) return 'agreement';
    if (/登记证书|版权证书/.test(label)) return 'cert';
    var head = headOf(it);
    if (/授权书/.test(head)) return 'auth';
    if (/承诺函|承诺书/.test(head)) return 'promise';
    if (/备案核准|备案通知|备案证明|APP\s*备案|应用备案/i.test(head)) return 'record';
    if (/营业执照|企业法人营业执照|许可证|资质证书|认证证书/.test(head)) return 'license';
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
    return out;
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
  function ownerValues(lines, full) {
    var out = [];
    function add(v) {
      var s = clean(v).replace(/^[\s:：，,、；;]+/, '').trim();
      if (!s || s.length < 2 || s.length > 40) return;
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
      addRest(rest);
    }
    /* ② 标签被 OCR 认坏 / 根本没出现时的兜底：正文里的单位名都按著作权人处理。
     *    跳过软件名称、代理机构、审核发证这些行，避免把无关主体当成权利人。 */
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
      var s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
      if (!s || !okCode(s)) return;
      if (out.indexOf(s) < 0) out.push(s);
    }
    /* ① 固定形状：年份 + 2 位字母 + 6–9 位数字。标签读成 `记 号` 也不影响。 */
    var m = /(?:19|20)\d{2}\s*[A-Za-z]{2}\s*\d{6,9}/.exec(full);
    if (m) { add(m[0]); return out; }
    /* ② 登记号标签行：标签可能被读散（`登 记 号` / `记 号`），在行内找代码。 */
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!/登\s*记\s*号/.test(line) && !/记\s*号/.test(line)) continue;
      var code = /((?:19|20)\d{2}\s*[A-Za-z]{2}\s*\d{6,9})/.exec(line) ||
                 /((?:软著登字第|第)\s*\d{4,8}\s*号)/.exec(line);
      if (code) { add(code[1]); return out; }
    }
    /* ③ 中文形兜底：`证书号 软著登字第…号` 那一行不是登记号，跳过。 */
    for (var j = 0; j < lines.length; j++) {
      if (/证书号/.test(lines[j]) && !/登记号/.test(lines[j])) continue;
      var cn = /((?:软著登字第|第)\s*\d{4,8}\s*号)/.exec(lines[j]);
      if (cn) { add(cn[1]); return out; }
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
  function authRoles(lines, full) {
    var score = {};
    var names = [];
    function see(name) {
      if (!score[name]) { score[name] = { licensor: 0, licensee: 0 }; names.push(name); }
      return score[name];
    }
    function bump(name, role, w) {
      if (!name) return;
      var s = see(name);
      s[role] += w;
    }
    function pick(role) {
      var best = '';
      var bs = 0;
      for (var i = 0; i < names.length; i++) {
        var s = score[names[i]][role];
        if (s > bs) { bs = s; best = names[i]; }
      }
      return bs >= 1.2 ? best : '';
    }
    var LIC_CUE = /(授权方|授权人|授权单位|授权公司|甲方|著作权人|版权所有人|版权所有|我司|本公司)/;
    var LEE_CUE = /(被授权方|被授权人|被授权单位|被授权公司|乙方|贵司|被许可方|被许可人)/;
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '').replace(/[ \t]+/g, '');
      if (!line) continue;
      var hits = orgHits(line);
      if (!hits.length) continue;
      var lic = LIC_CUE.test(line);
      var lee = LEE_CUE.test(line);
      var addressee = /^致\s*[：:]?\s*/.test(line) || (/[：:]$/.test(line) && i < 6 && !lic);
      for (var h = 0; h < hits.length; h++) {
        var name = hits[h].name;
        var after = line.slice(hits[h].end, hits[h].end + 16);
        if (/^[（(]?["“”‘’']?(?:以下简称)?["“”‘’']?(?:甲方|授权方|授权人|授权单位|著作权人)/.test(after)) bump(name, 'licensor', 3);
        if (/^[（(]?["“”‘’']?(?:以下简称)?["“”‘’']?(?:乙方|被授权方|被授权人|被授权单位)/.test(after)) bump(name, 'licensee', 3);
        if (/^[（(]?我司/.test(after)) bump(name, 'licensor', 3);
        var before = line.slice(Math.max(0, hits[h].index - 8), hits[h].index);
        if (/我司|本公司/.test(before)) bump(name, 'licensor', 3);
        if (addressee) bump(name, 'licensee', 2.5);
        else if (lic && !lee) bump(name, 'licensor', 1.2);
        else if (lee && !lic) bump(name, 'licensee', 1.2);
      }
      /* 「A 授权 B」句式（排除 `授权方：A` 这种标签行，避免把标签里的「授权」当动词）。 */
      if (!lic && !lee) {
        var vm = /(?:授予|授权给|授权予|许可给|许可予|授权|许可)/.exec(line);
        if (vm) {
          var left = orgHits(line.slice(0, vm.index));
          var right = orgHits(line.slice(vm.index));
          if (left.length) bump(left[left.length - 1].name, 'licensor', 2);
          if (right.length) bump(right[0].name, 'licensee', 2);
        }
      }
    }
    var licName = pick('licensor');
    var leeName = pick('licensee');
    if (licName && leeName && licName === leeName) leeName = '';
    var remaining = [];
    for (var n = 0; n < names.length; n++) {
      if (names[n] !== licName && names[n] !== leeName) remaining.push(names[n]);
    }
    /* 只判出一边、另一边只剩一个主体 ⇒ 用参考关系补齐。 */
    if (!licName && leeName && remaining.length === 1) licName = remaining[0];
    if (licName && !leeName && remaining.length === 1) leeName = remaining[0];
    if (!licName && leeName && /我司|本公司/.test(full)) licName = '我司';
    return { licensor: licName, licensee: leeName };
  }

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
  function looksLikeEntity(v) {
    if (!v) return false;
    if (v === '我司' || v === '本公司') return false;
    var flat = String(v).replace(/\s+/g, '');
    var os = orgsIn(v);
    for (var i = 0; i < os.length; i++) if (os[i].replace(/\s+/g, '') === flat) return true;
    return !!okPersonName(v);
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
    /* 授权书的角色判断需要看全文，先算一次；正常标签路径取到值时优先用标签值。 */
    var roles = (doc === 'auth' || doc === 'agreement') ? authRoles(lines, full) : null;
    for (var k = 0; k < ids.length; k++) {
      var def = BY_ID[ids[k]];
      if (!def) continue;
      var vals = [];
      if (def.id === 'owner' && doc === 'cert') {
        vals = ownerValues(lines, full);
      } else if (def.id === 'regNo' && doc === 'cert') {
        vals = regNoValues(lines, full);
      } else if (def.id === 'company' && doc === 'license') {
        vals = companyValues(lines, full);
      } else if (def.id === 'promiseTo' && doc === 'promise') {
        vals = promiseToValues(lines, full);
      } else if (def.id === 'promiser' && doc === 'promise') {
        vals = promiserValues(lines, full);
      } else {
        var normal = singleValue(def, lines, full);
        var roleVal = roles ? (roles[def.id] || '') : '';
        var one = normal;
        /* 授权方/被授权方：标签取到的若不是主体名（整句正文），而实体线索能给出主体，
         * 就用实体线索 —— 「甲方（授权方）：」这类写法真正的主体在括号前后，不在冒号后。 */
        if (roleVal && (!normal || !looksLikeEntity(normal))) one = roleVal;
        else if (!one) one = roleVal;
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
