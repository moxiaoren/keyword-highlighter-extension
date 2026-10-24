/* ============================ 软著一致性核对（用户 m00001 需求②）============================
 *
 * 用户原话要点：
 *   「我配置开发者、备案主体公司两个抓取字段；软著图片里的著作权人必须与开发者一致，
 *    不一致就需要授权书（图里会出现授权人/被授权人），且 授权人==著作权人、被授权人==开发者 也算通过。
 *    要求插件一次性比对这个，通过的话给开发者所在的单元格加绿底。」
 *   并补了一句：「还有其他的比对需求」——所以**比对对象、标签名、关键词全部走配置**
 *   （见 `Config.defaults.softCheck`），这一层只管"按配置算"，不写死任何行业字段名。
 *
 * 判定设计（宁可漏判，绝不假绿）：
 *   · `norm` 只做四件事：全角折半角、去所有空白、大小写折叠、去首尾标点；
 *   · `sameOrg` 只认**两种**相等：完全一致，或去掉尾部「股份有限公司/有限责任公司/有限公司/公司/集团」
 *     后完全一致。「XX有限公司」与「XX」判等是**有意的**（图里常省后缀）；
 *     不做编辑距离、不做包含匹配、不做拼音——差一个字就是两家公司，假绿比漏判更贵。
 *
 * 模块边界：本文件**不碰 chrome API**（纯函数 + 可传入的 DOM 元素），
 * 单测可以直接喂字符串 / 喂一张 `KH.Fetch` 出来的表元素。
 * 展示（涂色 + 小徽标）见 `decorateTable`；面板侧的绑定在 `important-note.js` 的 `panel.applySoftCheck`。
 * ========================================================================================= */
(function () {
  'use strict';
  const KH = window.KH = window.KH || {};

  /* ---------------- 归一与判等（纯函数） ---------------- */

  /** 首尾标点（中英文都算）。OCR 的「著作权人：XX有限公司。」末尾那个句号不该参与比较。 */
  const EDGE_PUNCT = /^[\s"'“”‘’`《》〈〉「」『』【】\[\](){},，。、；;：:!！?？·…—–\-_/\\|+=*&#%$@~^]+|[\s"'“”‘’`《》〈〉「」『』【】\[\](){},，。、；;：:!！?？·…—–\-_/\\|+=*&#%$@~^]+$/g;

  /**
   * 公司名/字段值 → 比较用的规范形。
   * 只做四件事：全角 ASCII 折半角（含 `（）`→`()`）、去所有空白（含全角空格与换行）、
   * 大小写折叠、去首尾标点。**不做**同音字归并、不做标点内嵌删除——那是模糊匹配的入口。
   */
  function norm(s) {
    let t = String(s == null ? '' : s);
    t = t.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    t = t.replace(/\s+/g, '');
    t = t.toLowerCase();
    return t.replace(EDGE_PUNCT, '');
  }

  /** 公司名常见后缀：只在**尾部整体**命中时才剥（顺序从长到短，保证「股份有限公司」先于「公司」）。 */
  const ORG_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '公司', '集团'];

  function stripOrgSuffix(t) {
    for (let i = 0; i < ORG_SUFFIXES.length; i++) {
      const suf = ORG_SUFFIXES[i];
      if (t.length > suf.length && t.slice(-suf.length) === suf) return t.slice(0, -suf.length);
    }
    return t;
  }

  /**
   * 两个公司名/字段值是否指同一家。
   * 规则只有两条：规范形相等；或剥掉尾部公司后缀后相等。任一为空一律**不相等**
   * （空值必须走 skip 分支告诉用户缺什么，绝不能被当成"一致"涂绿）。
   */
  function sameOrg(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const sx = stripOrgSuffix(x);
    const sy = stripOrgSuffix(y);
    return !!sx && !!sy && sx === sy;
  }

  /* ---------------- OCR 文本里取「标签：值」 ---------------- */

  /** 标签与值之间的分隔符：`：` `:` `｜` `|` `＝` `=` `、` 与空白（OCR 把两者读散很常见）。 */
  const KV_SEP = /^[\s:：、｜|=＝]+/;
  /** 值末尾的句读去掉（OCR 会把下一句的标点带进来）。 */
  const TAIL_PUNCT = /[\s;；,，.。]+$/;

  /** 拿到配置（接受整份 config 或单独的 softCheck 对象；脏值仍走唯一归一函数） */
  function cfgOf(cfg) {
    const C = KH.Config;
    const raw = (cfg && cfg.softCheck) ? cfg.softCheck : cfg;
    if (C && typeof C.normalizeSoftCheck === 'function') return C.normalizeSoftCheck(raw);
    return raw || {};
  }

  /** 配置里的名字列表 → 数组（唯一实现是 `Config.softList`，这里只做兜底） */
  function splitList(value) {
    const C = KH.Config;
    if (C && typeof C.softList === 'function') return C.softList(value);
    return String(value == null ? '' : value).split(/[,，、;；\r\n]+/).map((s) => s.trim()).filter(Boolean);
  }

  function cleanValue(v) {
    return String(v == null ? '' : v).replace(TAIL_PUNCT, '').trim();
  }

  /**
   * 从一段 OCR 文本里取「标签 → 值」。四种写法都认：
   *   `著作权人：XX` / `著作权人: XX` / `著作权人 XX` / `著作权人` 换行 `XX`
   * 取值的两条边界（OCR 归行常把两条字段并进一行，越界取值是本功能最贵的错误）：
   *   ① 同一行里再出现**任何已知标签**（`stopLabels`）⇒ 在那里切断；
   *   ② 换行写法只吃**紧接着的那一条**非空行，且那行本身长得像另一个字段 ⇒ 不吃（本字段空着）。
   * @param {string} text OCR 全文
   * @param {string|string[]} labels 本字段的标签候选（数组或逗号串）
   * @param {string|string[]} [stopLabels] 遇到就停的全部标签（缺省 = labels 自己）
   * @returns {string} 取到的值（原样，未归一）；取不到返回空串
   */
  function kvFromText(text, labels, stopLabels) {
    const raw = String(text == null ? '' : text);
    const labs = splitList(labels);
    if (!labs.length || !raw) return '';
    const stops = splitList(stopLabels);
    const stop = stops.length ? stops : labs;
    const lines = raw.split(/\r?\n/);
    const cutAtLabel = (s) => {
      let end = s.length;
      for (let i = 0; i < stop.length; i++) {
        const at = s.indexOf(stop[i]);
        if (at > 0 && at < end) end = at;
      }
      return s.slice(0, end);
    };
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] == null ? '' : lines[i]);
      for (let li = 0; li < labs.length; li++) {
        const at = line.indexOf(labs[li]);
        if (at < 0) continue;
        let rest = line.slice(at + labs[li].length);
        rest = rest.replace(KV_SEP, '');
        if (rest.trim()) return cleanValue(cutAtLabel(rest));
        /* 换行写法：标签独占一行，值在下面。只吃一条非空行，且不吃"像另一个字段"的行。 */
        for (let j = i + 1; j < lines.length; j++) {
          const next = String(lines[j] == null ? '' : lines[j]).trim();
          if (!next) continue;
          let other = false;
          for (let k = 0; k < stop.length; k++) {
            if (next.indexOf(stop[k]) >= 0) { other = true; break; }
          }
          if (other) break;
          return cleanValue(cutAtLabel(next));
        }
      }
    }
    return '';
  }

  /* ---------------- 从 OCR 条目里取两个事实 ---------------- */

  /** 只认识别完成的条目（`state === 'done'`；其余状态的 `text` 是空串或半截） */
  function doneTexts(items) {
    const out = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      if (!it || it.state !== 'done') continue;
      const t = String(it.text == null ? '' : it.text);
      if (t) out.push(t);
    }
    return out;
  }

  /** 全部已知标签（取值时当边界用；顺序无关） */
  function allLabels(c) {
    return splitList(c.ownerLabels).concat(splitList(c.devFields), splitList(c.subjectFields),
      splitList(c.grantorLabels), splitList(c.granteeLabels));
  }

  /** 多张图里取「著作权人」：第一个非空值（软著证书通常只有一张，但用户可能截了好几张） */
  function ownerFromItems(items, c) {
    const sc = c || cfgOf();
    const stops = allLabels(sc);
    const texts = doneTexts(items);
    for (let i = 0; i < texts.length; i++) {
      const v = kvFromText(texts[i], sc.ownerLabels, stops);
      if (v) return v;
    }
    return '';
  }

  /**
   * 找「授权书」：文本里命中任一 `authKeywords` 的图即授权书（取第一张命中的）。
   * @returns {{isAuth:boolean, grantor:string, grantee:string, keyword:string}}
   */
  function authFromItems(items, c) {
    const sc = c || cfgOf();
    const out = { isAuth: false, grantor: '', grantee: '', keyword: '' };
    const kws = splitList(sc.authKeywords);
    const stops = allLabels(sc);
    const texts = doneTexts(items);
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      let hit = '';
      for (let k = 0; k < kws.length; k++) {
        if (kws[k] && t.indexOf(kws[k]) >= 0) { hit = kws[k]; break; }
      }
      if (!hit) continue;
      out.isAuth = true;
      out.keyword = hit;
      out.grantor = kvFromText(t, sc.grantorLabels, stops.concat(splitList(sc.granteeLabels)));
      out.grantee = kvFromText(t, sc.granteeLabels, stops.concat(splitList(sc.grantorLabels)));
      return out;
    }
    return out;
  }

  /* ---------------- 判定 ---------------- */

  const LABEL_DEV = '开发者';
  const LABEL_SUBJECT = '备案主体';

  /**
   * 一次性比对，出结论。
   * @param {{dev?:string, subject?:string, owner?:string, auth?:object}} input
   * @param {object} cfg 整份配置或 `softCheck` 对象
   * @returns {{state:'pass'|'fail'|'skip', reason:string, target:'dev'|'subject',
   *            owner:string, dev:string, subject:string, auth:object}}
   *   `state`：pass=涂绿 / fail=涂琥珀 / skip=不涂（缺输入，不冤枉用户）
   *   `target`：结论落在哪一行的值格上（`dev` 或 `subject`）
   *   `reason`：给用户看的中文句子，**不含内部术语**（可直接进 `title`）
   */
  function judge(input, cfg) {
    const c = cfgOf(cfg);
    const inp = input || {};
    const dev = String(inp.dev == null ? '' : inp.dev).trim();
    const subject = String(inp.subject == null ? '' : inp.subject).trim();
    const owner = String(inp.owner == null ? '' : inp.owner).trim();
    const ra = inp.auth || {};
    const auth = {
      isAuth: ra.isAuth === true,
      grantor: String(ra.grantor == null ? '' : ra.grantor).trim(),
      grantee: String(ra.grantee == null ? '' : ra.grantee).trim(),
      keyword: String(ra.keyword == null ? '' : ra.keyword)
    };
    const out = { state: 'skip', reason: '', target: 'dev', owner: owner, dev: dev, subject: subject, auth: auth };

    /* 比对基准：按 `compareTo` 收，顺序固定「开发者 → 备案主体」（授权书那条也拿它当"被授权方应该是谁"） */
    const basis = [];
    if (c.compareTo !== 'subject' && dev) basis.push({ key: 'dev', label: LABEL_DEV, value: dev });
    if (c.compareTo !== 'dev' && subject) basis.push({ key: 'subject', label: LABEL_SUBJECT, value: subject });
    out.target = basis.length ? basis[0].key : (c.compareTo === 'subject' ? 'subject' : 'dev');

    // ① 没有比对基准：skip，并说清缺哪个字段（不判 fail、不涂色）
    if (!basis.length) {
      if (c.compareTo === 'dev') out.reason = '没抓到「' + LABEL_DEV + '」的值，无法核对';
      else if (c.compareTo === 'subject') out.reason = '没抓到「' + LABEL_SUBJECT + '」的值，无法核对';
      else out.reason = '没抓到「' + LABEL_DEV + '」或「' + LABEL_SUBJECT + '」的值，无法核对';
      return out;
    }
    // ② 图里没读到著作权人：skip（多半是图没识别完/图里没有这四个字）
    if (!owner) {
      out.reason = '图片里没读到「著作权人」，无法核对';
      return out;
    }

    // ③ 直接一致 —— 三种通过方式之一
    for (let i = 0; i < basis.length; i++) {
      if (!sameOrg(owner, basis[i].value)) continue;
      out.state = 'pass';
      out.target = basis[i].key;
      out.reason = '著作权人「' + owner + '」与' + basis[i].label + '「' + basis[i].value + '」一致';
      return out;
    }

    // ④ 不一致但授权书对得上：授权人 = 著作权人，被授权人 = 开发者（比对基准的第一个）
    const g = basis[0];
    if (auth.isAuth && auth.grantor && auth.grantee
      && sameOrg(auth.grantor, owner) && sameOrg(auth.grantee, g.value)) {
      out.state = 'pass';
      out.target = g.key;
      out.reason = '授权书匹配：授权人「' + auth.grantor + '」= 著作权人，被授权人「'
        + auth.grantee + '」= ' + g.label + '「' + g.value + '」';
      return out;
    }

    // ⑤ 不一致且授权书也不匹配：fail，reason 必须带具体值（用户要能一眼看出是哪两家公司）
    out.state = 'fail';
    const pairs = basis.map((b) => b.label + '「' + b.value + '」').join(' / ');
    let why = '，也没有找到匹配的授权书';
    if (auth.isAuth) {
      if (!auth.grantor || !auth.grantee) why = '，授权书里没读全授权人/被授权人';
      else why = '，授权书里的授权人「' + auth.grantor + '」/被授权人「' + auth.grantee + '」也对不上';
    }
    out.reason = '著作权人「' + owner + '」≠ ' + pairs + why;
    return out;
  }

  /* ---------------- 展示：把结论落到表的单元格上 ---------------- */

  const LABEL_CELL = 'td.kh-table-label';
  const CLS_OK = 'khin-soft-ok';
  const CLS_WARN = 'khin-soft-warn';
  const CLS_BADGE = 'khin-soft-badge';

  /** 这一格文本是不是某个已知字段名（`开发者` / `开发者：` 都算；多两个字的后缀也认） */
  function isLabelText(text, tokens) {
    const t = norm(text);
    if (!t) return false;
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      if (!w) continue;
      if (t === w) return true;
      if (t.indexOf(w) === 0 && t.length <= w.length + 2) return true;
    }
    return false;
  }

  /**
   * 在抓取表里找到「某个字段」的**值格**（标签格 `td.kh-table-label` 的紧邻下一个 `td`）。
   * 表格由 `KH.Fetch.rowsToTableHtml` 生成：左列是字段名、右列是它的内容 ⇒ 邻格就是值。
   * ponytail: 只认**第一个**命中的标签行（同一张表里出现两个「开发者」时按第一个判、也只涂第一个）；
   *   实际表格里同名字段很少见，等真遇到再改成"全部行一起涂"。
   * @returns {Element|null}
   */
  function findRowCell(tableEl, labels) {
    if (!tableEl || typeof tableEl.querySelectorAll !== 'function') return null;
    const tokens = splitList(labels).map(norm).filter(Boolean);
    if (!tokens.length) return null;
    let cells;
    try { cells = tableEl.querySelectorAll(LABEL_CELL); } catch (e) { return null; }
    for (let i = 0; i < (cells || []).length; i++) {
      const cell = cells[i];
      if (!isLabelText(cell.textContent, tokens)) continue;
      const val = cell.nextElementSibling;
      if (!val || String(val.className || '').indexOf('kh-table-label') >= 0) continue;
      return val;
    }
    return null;
  }

  /** 从抓取表里读某字段的值文本（读不到返回空串；面板侧也可自己从 `KH.Fetch` 更早的 rows 给进来） */
  function readRowValue(tableEl, labels) {
    const cell = findRowCell(tableEl, labels);
    return cell ? String(cell.textContent == null ? '' : cell.textContent).trim() : '';
  }

  /** 每张表一个徽标元素（WeakMap：卡片复用时不重复插、表没了自然回收） */
  const badges = new WeakMap();

  function clearMarks(tableEl) {
    let marks;
    try { marks = tableEl.querySelectorAll('.' + CLS_OK + ', .' + CLS_WARN); } catch (e) { marks = []; }
    for (let i = 0; i < (marks || []).length; i++) {
      marks[i].classList.remove(CLS_OK);
      marks[i].classList.remove(CLS_WARN);
      /* `title` 是本函数新加的（老表格的 label 格 title 挂在 `.kh-lbt` 上，不受影响） */
      marks[i].title = '';
    }
    const b = badges.get(tableEl);
    if (b) {
      b.className = CLS_BADGE;
      b.textContent = '';
      b.title = '';
    }
  }

  function badgeFor(tableEl) {
    let b = badges.get(tableEl);
    if (b) return b;
    const parent = tableEl.parentNode;
    if (!parent) return null;
    const doc = tableEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return null;
    b = doc.createElement('div');
    b.className = CLS_BADGE;
    badges.set(tableEl, b);
    parent.insertBefore(b, tableEl.nextSibling || null);
    return b;
  }

  /**
   * 把核对结论落到一张抓取表上（**唯一**的涂色实现，单测直接喂表元素）。
   *   pass → 目标值格绿底 + 徽标「✅ …」；fail → 琥珀底 + 徽标「⚠️ …」；skip → 不涂不插徽标。
   * 目标行由 `judge` 的 `target` 决定（`compareTo=subject` 时落到备案主体那行）。
   * 幂等：先清上一轮的涂色/徽标再画；`softCheck.on === false` 时**只清不画**（零额外计算）。
   * @param {Element} tableEl `table.kh-table-fetch`
   * @param {{cfg?:object, items?:Array, dev?:string, subject?:string, owner?:string}} ctx
   *        `dev`/`subject`/`owner` 是调用方已算好的值（给了就不再从表/OCR 条目里取）
   * @returns {object|null} `judge` 的结论；未开启核对时返回 null
   */
  function decorateTable(tableEl, ctx) {
    if (!tableEl || typeof tableEl.querySelectorAll !== 'function') return null;
    clearMarks(tableEl);
    const c = cfgOf(ctx && ctx.cfg);
    if (c.on !== true) return null;
    const items = (ctx && ctx.items) || [];
    const dev = (ctx && ctx.dev != null) ? String(ctx.dev)
      : readRowValue(tableEl, c.devFields);
    const subject = (ctx && ctx.subject != null) ? String(ctx.subject)
      : readRowValue(tableEl, c.subjectFields);
    const owner = (ctx && ctx.owner != null) ? String(ctx.owner)
      : ownerFromItems(items, c);
    const verdict = judge({ dev: dev, subject: subject, owner: owner, auth: authFromItems(items, c) }, { softCheck: c });
    if (verdict.state !== 'pass' && verdict.state !== 'fail') return verdict;
    const cell = findRowCell(tableEl, verdict.target === 'subject' ? c.subjectFields : c.devFields);
    const cls = verdict.state === 'pass' ? CLS_OK : CLS_WARN;
    if (cell) {
      cell.classList.add(cls);
      cell.title = verdict.reason;
    }
    const badge = badgeFor(tableEl);
    if (badge) {
      badge.className = CLS_BADGE + ' ' + cls;
      badge.textContent = (verdict.state === 'pass' ? '✅ ' : '⚠️ ') + verdict.reason;
      badge.title = verdict.reason;
    }
    return verdict;
  }

  KH.SoftCheck = {
    norm,
    sameOrg,
    stripOrgSuffix,
    kvFromText,
    ownerFromItems,
    authFromItems,
    judge,
    findRowCell,
    readRowValue,
    decorateTable
  };
})();
