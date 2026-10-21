/* ============================================================================
 * offscreen/pdf-text.js · PDF 文本抽取（纯函数：不碰 DOM、不碰 chrome*、不联网）
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件：
 *   网页里的 PDF 是 <embed>/<iframe> 里的插件画布，content script 只能拿到那个
 *   <embed> 标签，DOM 里一个字都没有 —— "这份 PDF 里有没有关键词"没法用
 *   textContent 判。仓库是零构建零依赖，引不进 pdf.js（几 MB + 构建链），
 *   所以这里自己把字节解开，只做"抽文本"这一件事：不排版、不渲染、不解密。
 *
 * 刻意不做的（都为省体积；哪天要了再补，别指望现在有）：
 *   · 只解 FlateDecode；LZW / DCT / JPX 一律跳过并记 warning
 *   · 只认 ToUnicode；没有它的字体按 latin1 降级（中文必乱码，但不崩）
 *   · 不处理加密 PDF（/Encrypt 只报 warning 后按明文硬解）
 *   · 版式信息全丢，坐标只用来判"这一行结束没有"
 * ========================================================================= */
(function () {
  'use strict';

  const ROOT = (typeof globalThis !== 'undefined') ? globalThis : self;
  const NS = ROOT.KHPdfText = (ROOT.KHPdfText || {});

  /* ---------------------------------------------------------------- 字节层 */

  /** PDF 的空白符（规范 7.2.2：0 9 10 12 13 32）。 */
  const WS = new Uint8Array(256);
  [0, 9, 10, 12, 13, 32].forEach(function (c) { WS[c] = 1; });
  function isWs(c) { return c < 256 && WS[c] === 1; }

  /* 整个文件读成 latin1 字符串：一个字符 == 一个字节，**字符串下标就是字节偏移**。
   * 后面所有字典解析都在这个串上做；流内容一律按偏移从原始 Uint8Array 切，
   * 绝不把 latin1 串再转回字节（那样中文 CMap 就毁了）。分块拼是因为
   * String.fromCharCode.apply 的参数个数有上限（长 PDF 会直接 RangeError）。 */
  function bytesToLatin1(u8) {
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return out;
  }

  /** 十六进制串 → latin1 串（保留字节值，长度减半）。 */
  function hexToLatin1(hex) {
    let s = '';
    for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return s;
  }

  /* ---------------------------------------------------------------- 值解析 */
  /* 轻量递归下降：只认 PDF 里真会出现的那几种值形态。每个值都是 {t, v}：
   * dict / arr / name / num / ref / s(字符串) / bool / null / kw(裸关键字)。
   * 不追求完整语法 —— 遇到坏字节就抛，调用方吞掉并记 warning。 */

  function skipWs(s, i) {
    const n = s.length;
    for (;;) {
      if (i >= n) return i;
      const c = s.charCodeAt(i);
      if (isWs(c)) { i++; continue; }
      if (c === 37) {                                  /* % 注释到行尾 */
        while (i < n) { const d = s.charCodeAt(i); if (d === 10 || d === 13) break; i++; }
        continue;
      }
      return i;
    }
  }

  function isDelim(c) {
    return c === 47 || c === 40 || c === 41 || c === 60 || c === 62 ||
      c === 91 || c === 93 || c === 123 || c === 125 || c === 37;
  }

  function readName(s, i) {
    let out = '';
    i++;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (isWs(c) || isDelim(c)) break;
      if (c === 35 && i + 2 < s.length) {              /* #XX 名字转义 */
        const hex = s.substr(i + 1, 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3; continue; }
      }
      out += s.charAt(i);
      i++;
    }
    return { v: out, i: i };
  }

  /** `\n \r \t \b \f` 这一族：名字符 → 转义后的字符。 */
  const ESC = { 110: '\n', 114: '\r', 116: '\t', 98: '\b', 102: '\f' };

  /** `( ... )` 字面串：支持 \( \) \\ 转义族、\(\) 嵌套、\ddd 八进制、续行。 */
  function readLiteral(s, i) {
    let out = '';
    let depth = 0;
    i++;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 92) {
        const d = s.charCodeAt(i + 1);
        if (ESC[d] !== undefined) { out += ESC[d]; i += 2; continue; }
        if (d === 40 || d === 41 || d === 92) { out += String.fromCharCode(d); i += 2; continue; }
        if (d === 10) { i += 2; continue; }            /* 续行：反斜杠+LF 一起吞 */
        if (d === 13) { i += (s.charCodeAt(i + 2) === 10 ? 3 : 2); continue; }
        if (d >= 48 && d <= 55) {
          let oct = '';
          let k = i + 1;
          while (k < s.length && oct.length < 3 && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 55) { oct += s.charAt(k); k++; }
          out += String.fromCharCode(parseInt(oct, 8) & 255);
          i = k;
          continue;
        }
        i++;                                            /* 未知转义：丢反斜杠留字符 */
        continue;
      }
      if (c === 40) { depth++; out += '('; i++; continue; }
      if (c === 41) {
        if (depth === 0) { i++; break; }
        depth--;
        out += ')';
        i++;
        continue;
      }
      out += s.charAt(i);
      i++;
    }
    return { v: out, i: i };
  }

  function readHexStr(s, i) {
    let hex = '';
    i++;
    while (i < s.length) {
      const ch = s.charAt(i);
      if (ch === '>') { i++; break; }
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      i++;
    }
    if (hex.length % 2) hex += '0';                     /* 规范：奇数位右补 0 */
    return { v: hexToLatin1(hex), i: i };
  }

  /* `12 0 R` 的尾随检测：必须**粘在当前位置**匹配（sticky）。
   * 用 g 会往后搜到文件末尾，把下一个对象里的 `/Root 1 0 R` 当成自己的孩子 —
   * 实机症状就是 `/Length 42` 被解析成"引用后面某个对象的 0 R"，流从此找不到。 */
  const REF_TAIL = /\s+([0-9]+)\s+R(?![A-Za-z0-9])/y;

  function parseValue(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) throw new Error('unexpected eof');
    const c = s.charCodeAt(i);
    if (c === 60) {
      if (s.charCodeAt(i + 1) === 60) return parseDict(s, i);
      const r = readHexStr(s, i);
      return { v: { t: 's', v: r.v }, i: r.i };
    }
    if (c === 40) { const r = readLiteral(s, i); return { v: { t: 's', v: r.v }, i: r.i }; }
    if (c === 91) return parseArray(s, i);
    if (c === 47) { const r = readName(s, i); return { v: { t: 'name', v: r.v }, i: r.i }; }
    if (c === 93 || c === 62) throw new Error('unexpected closer');

    const start = i;
    while (i < s.length) {
      const d = s.charCodeAt(i);
      if (isWs(d) || isDelim(d)) break;
      i++;
    }
    const word = s.slice(start, i);
    if (!word) throw new Error('empty token');

    if (/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/.test(word)) {
      const num = parseFloat(word);
      REF_TAIL.lastIndex = i;
      const r = REF_TAIL.exec(s);
      if (r) return { v: { t: 'ref', num: num, gen: parseInt(r[1], 10) }, i: i + r[0].length };
      return { v: { t: 'num', v: num }, i: i };
    }
    if (word === 'true') return { v: { t: 'bool', v: true }, i: i };
    if (word === 'false') return { v: { t: 'bool', v: false }, i: i };
    if (word === 'null') return { v: { t: 'null' }, i: i };
    return { v: { t: 'kw', v: word }, i: i };
  }

  function parseDict(s, i) {
    const out = Object.create(null);
    i += 2;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s.charCodeAt(i) === 62 && s.charCodeAt(i + 1) === 62) { i += 2; break; }
      if (s.charCodeAt(i) !== 47) {                     /* 坏字典：跳一个值保命，别原地打转 */
        const bad = parseValue(s, i);
        i = bad.i;
        continue;
      }
      const k = readName(s, i);
      const v = parseValue(s, k.i);
      out[k.v] = v.v;
      i = v.i;
    }
    return { v: { t: 'dict', v: out }, i: i };
  }

  function parseArray(s, i) {
    const arr = [];
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s.charCodeAt(i) === 93) { i++; break; }
      const r = parseValue(s, i);
      arr.push(r.v);
      i = r.i;
    }
    return { v: { t: 'arr', v: arr }, i: i };
  }

  function dv(val, key) { return (val && val.t === 'dict') ? val.v[key] : undefined; }
  function isName(val, want) { return !!val && val.t === 'name' && val.v === want; }
  function numOf(val) { return (val && val.t === 'num') ? val.v : undefined; }

  /** 追一次引用链（防环：最多 16 跳）。 */
  function deref(objs, val) {
    let guard = 0;
    while (val && val.t === 'ref' && guard++ < 16) {
      const o = objs.get(val.num);
      val = o ? o.val : null;
    }
    return val || null;
  }

  /* ---------------------------------------------------------------- 解压 */

  async function inflateBytes(bytes) {
    const tryFmt = async function (fmt) {
      const ds = new DecompressionStream(fmt);
      const piped = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(piped).arrayBuffer();
      return new Uint8Array(buf);
    };
    try { return await tryFmt('deflate'); } catch (e) { /* 落到裸 deflate */ }
    /* 有些生成器把裸 deflate 当成 FlateDecode 写（少了 zlib 头）：规范说该是可选的，
     * 实机遇过不少，所以无条件再试一次 deflate-raw —— 不写自己的 inflate。 */
    return await tryFmt('deflate-raw');
  }

  /* ---------------------------------------------------------------- 对象扫描 */

  /* 找所有 `N G obj`，逐个解析它的值；遇到 stream 就**按 /Length 跳到 endstream**，
   * 把正则的下次搜索位置推过去 —— 否则压缩流里的随机字节会被当成 `5 0 obj`，
   * 整份文档的对象表就乱了。 */
  function scanObjects(src) {
    const objs = new Map();
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const num = parseInt(m[1], 10);
      let val, i;
      try { const r = parseValue(src, m.index + m[0].length); val = r.v; i = r.i; } catch (e) { continue; }
      let stream = null;
      let tight = false;
      const j = skipWs(src, i);
      if (src.substr(j, 6) === 'stream') {
        let k = j + 6;
        if (src.charCodeAt(k) === 13) k++;
        if (src.charCodeAt(k) === 10) k++;
        const start = k;
        const declared = numOf(dv(val, 'Length'));
        let len = -1;
        if (typeof declared === 'number' && declared >= 0 && start + declared <= src.length &&
            src.substr(skipWs(src, start + declared), 9) === 'endstream') len = declared;
        if (len < 0) {                                  /* /Length 是间接引用或写错：退回找关键字 */
          const e = src.indexOf('endstream', start);
          len = e < 0 ? Math.max(0, src.length - start) : Math.max(0, e - start);
          /* 只去掉**一个**换行序列。以前这里是 while 循环，会把数据末尾恰好是 0x0A
           * 的那个字节也当分隔符删掉 —— w3c 的 dummy.pdf 就是这样：129 字节少 1 字节，
           * zlib 报 "unexpected end of file"，整页一个字都抽不出来。 */
          if (len > 0) {
            const last = src.charCodeAt(start + len - 1);
            if (last === 10) { len--; if (len > 0 && src.charCodeAt(start + len - 1) === 13) len--; }
            else if (last === 13) len--;
          }
        } else {
          tight = true;
        }
        stream = { start: start, len: len };
        re.lastIndex = Math.max(re.lastIndex, start + len);
      }
      objs.set(num, { num: num, val: val, stream: stream, tight: tight });
    }

    /* 第二遍：/Length 写成 `3 0 R` 时，扫到这条流的那一刻还解析不出那个对象
     * （它通常就排在流后面），只能先按 endstream 关键字兜底估长度。现在对象表齐了，
     * 用**声明的精确长度**覆盖 —— 这是唯一可靠的长度来源，兜底估计会错几个字节。 */
    for (const entry of objs.values()) {
      if (!entry.stream || entry.tight) continue;
      const declared = numOf(deref(objs, dv(entry.val, 'Length')));
      if (typeof declared !== 'number' || declared < 0) continue;
      const start = entry.stream.start;
      if (start + declared > src.length) continue;
      const after = skipWs(src, start + declared);
      if (src.substr(after, 9) !== 'endstream') continue;   /* 声明值与实际对不上就别信它 */
      entry.stream.len = declared;
    }
    return objs;
  }

  /* 对象流（/Type /ObjStm）：把一批小对象压进一条流里。里面的对象**不能有流**，
   * 只可能是字典/数组 —— 字体字典最常见的藏身处。只在"没有同号间接对象"时登记，
   * 免得覆盖真正在文件里独立存在的那个（规范也要求间接对象优先）。 */
  async function expandObjectStreams(u8, objs, warn) {
    const added = [];
    for (const entry of Array.from(objs.values())) {
      if (!entry.stream) continue;
      const val = deref(objs, entry.val);
      if (!isName(dv(val, 'Type'), 'ObjStm')) continue;
      let data;
      try { data = await decodeStream(u8, objs, entry, warn); } catch (e) { data = null; }
      if (!data) continue;
      const text = bytesToLatin1(data);
      const n = numOf(dv(val, 'N'));
      const first = numOf(dv(val, 'First'));
      if (typeof n !== 'number' || typeof first !== 'number' || n <= 0 || first < 0) continue;
      const header = text.slice(0, first);
      const pairs = [];
      const hr = /(\d+)\s+(\d+)/g;
      let hm;
      while ((hm = hr.exec(header)) !== null && pairs.length < n) {
        pairs.push({ num: parseInt(hm[1], 10), off: parseInt(hm[2], 10) });
      }
      for (let q = 0; q < pairs.length; q++) {
        try {
          if (!objs.has(pairs[q].num)) added.push([pairs[q].num, { num: pairs[q].num, val: parseValue(text, first + pairs[q].off).v, stream: null }]);
        } catch (e) { /* 单个对象坏了不影响别的 */ }
      }
    }
    for (const kv of added) objs.set(kv[0], kv[1]);
    return added.length;
  }

  /* ---------------------------------------------------------------- 流解码 */

  function filterList(objs, val) {
    const f = dv(val, 'Filter');
    if (!f) return [];
    if (f.t === 'name') return [f.v];
    const arr = deref(objs, f);
    return (arr && arr.t === 'arr') ? arr.v.filter(function (x) { return x.t === 'name'; }).map(function (x) { return x.v; }) : [];
  }

  async function decodeStream(u8, objs, entry, warn) {
    const bytes = u8.subarray(entry.stream.start, entry.stream.start + entry.stream.len);
    let data = bytes;
    for (const f of filterList(objs, entry.val)) {
      if (f === 'FlateDecode' || f === 'Fl') {
        try { data = await inflateBytes(data); }
        catch (e) {
          warn('有一段流解压失败（FlateDecode），该处内容可能缺失');
          return null;
        }
      } else {
        warn('遇到不支持的流过滤器 /' + f + '，已跳过该流');
        return null;
      }
    }
    return data;
  }

  /* ---------------------------------------------------------------- ToUnicode CMap */

  function padHex(code, byteLen) {
    let h = code.toString(16).toUpperCase();
    const want = byteLen * 2;
    while (h.length < want) h = '0' + h;
    return h.length > want ? h.slice(h.length - want) : h;
  }

  /** hex 串 → JS 串（大端 UTF-16BE，每 4 位一个码元；末段 2 位按单字节补）。 */
  function hexToText(hex) {
    let s = '';
    for (let i = 0; i < hex.length; i += 4) {
      let part = hex.slice(i, i + 4);
      if (part.length === 2) part = '00' + part;
      s += String.fromCharCode(parseInt(part, 16));
    }
    return s;
  }

  function parseCMap(text) {
    const map = new Map();
    let codeLen = 0;
    const note = function (hex) {
      const n = Math.ceil(hex.length / 2);
      if (n > codeLen) codeLen = n;
    };

    const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
    let m;
    while ((m = csRe.exec(text)) !== null) {
      const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      let p;
      while ((p = pr.exec(m[1])) !== null) note(p[1]);
    }

    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = bfcharRe.exec(text)) !== null) {
      const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
      let p;
      while ((p = pr.exec(m[1])) !== null) { note(p[1]); map.set(p[1].toUpperCase(), hexToText(p[2])); }
    }

    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrangeRe.exec(text)) !== null) {
      const pr = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
      let p;
      while ((p = pr.exec(m[1])) !== null) {
        const srcHex = p[1];
        const srcLen = Math.ceil(srcHex.length / 2);
        note(srcHex);
        const lo = parseInt(srcHex, 16);
        const hi = parseInt(p[2], 16);
        if (!(hi >= lo)) continue;
        if (p[3] != null) {
          /* 单个 dst：规范是"dst 作为大端整数逐个 +1"，不是只加最后一个字节 ——
           * <4E2D> 之后要是 <4EFF> 再 +1 必须进到 4F00，只加低字节就会错。 */
          const dstHex = p[3].toUpperCase();
          const width = dstHex.length;
          const base = BigInt('0x' + (dstHex || '0'));
          for (let c = lo; c <= hi; c++) {
            let h = (base + BigInt(c - lo)).toString(16).toUpperCase();
            if (h.length > width) h = h.slice(h.length - width);
            while (h.length < width) h = '0' + h;
            map.set(padHex(c, srcLen), hexToText(h));
          }
        } else {
          const items = p[4].match(/<[0-9a-fA-F]*>/g) || [];
          for (let k = 0; k < items.length; k++) {
            map.set(padHex(lo + k, srcLen), hexToText(items[k].slice(1, -1)));
          }
        }
      }
    }

    if (!codeLen) codeLen = 2;                          /* 只有 bfchar 没 codespace：Identity-H 最常见 */
    if (codeLen > 3) codeLen = 3;
    return { map: map, codeLen: codeLen };
  }

  /* ---------------------------------------------------------------- 内容流 tokenizer */

  /* 不建词法表，直接出 token：{t:'op'|'num'|'s'|'name'|'arr'}。
   * 数组就地展开成 {t:'arr'}，这样 TJ 的遍历不用额外状态机。 */
  function tokenize(s, i0, inArray) {
    const out = [];
    let i = i0 | 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (isWs(c)) { i++; continue; }
      if (c === 37) {
        while (i < s.length) { const d = s.charCodeAt(i); if (d === 10 || d === 13) break; i++; }
        continue;
      }
      if (c === 40) { const r = readLiteral(s, i); out.push({ t: 's', v: r.v }); i = r.i; continue; }
      if (c === 60 && s.charCodeAt(i + 1) === 60) { i += 2; continue; }   /* << 内联字典：内容流里用不到，略过 */
      if (c === 60) { const r = readHexStr(s, i); out.push({ t: 's', v: r.v }); i = r.i; continue; }
      if (c === 62) { i += (s.charCodeAt(i + 1) === 62 ? 2 : 1); continue; }
      if (c === 91) { const r = tokenize(s, i + 1, true); out.push({ t: 'arr', v: r.v }); i = r.i; continue; }
      if (c === 93) { if (inArray) return { v: out, i: i + 1 }; i++; continue; }
      if (c === 123 || c === 125) { i++; continue; }
      if (c === 47) { const r = readName(s, i); out.push({ t: 'name', v: r.v }); i = r.i; continue; }

      const st = i;
      while (i < s.length) {
        const d = s.charCodeAt(i);
        if (isWs(d) || isDelim(d)) break;
        i++;
      }
      if (i === st) { i++; continue; }                /* 兜底：认不出就吞一个字节，绝不原地打转 */
      const w = s.slice(st, i);
      if (/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/.test(w)) out.push({ t: 'num', v: parseFloat(w) });
      else out.push({ t: 'op', v: w });
    }
    return { v: out, i: i };
  }

  /* ---------------------------------------------------------------- 一页的文本 */

  /**
   * 跑一页的内容流。
   * 换行判据（都写在这，别猜）：
   *   · T* / ' / " 是语义上的"下一行"，无条件换行
   *   · Td / TD / Tm 里 y 变化 ≥ 2pt 算换行（2pt 是经验阈值：下标/上标一般 < 2pt，
   *     而最小行距不会比字号小到哪去）；y 不变表示同一行的横向续接
   *   · y 不变的续接**不补空格**：真实字宽未知，按坐标补空格会造出原文没有的词边界，
   *     宁可两段贴在一起（关键词匹配时也不会因此误命中 —— 贴一起只会漏，不会多做）
   *   · TJ 数组里 ≤ -100 的数字是"词间距"（千分之一字号），补一个空格；
   *     ≥ 100 是收紧字距，忽略（补空格反而是错的）
   */
  function pageLines(text, decoders, stats) {
    const lines = [];
    const toks = tokenize(text, 0, false).v;
    let line = '';
    let curY = 0;
    let font = null;
    const stack = [];

    const flush = function () {
      const t = line.replace(/[\s\u0000]+$/, '').replace(/^[\s\u0000]+/, '');
      line = '';
      if (t) lines.push(t);
    };
    const space = function () {
      if (line && !/\s$/.test(line)) line += ' ';
    };
    const emit = function (tokens) {
      for (const tk of tokens) {
        if (tk.t === 's') {
          const dec = font ? decoders.get(font) : null;
          line += decodeString(tk.v, dec, stats);
        }
      }
    };

    for (const tk of toks) {
      if (tk.t !== 'op') { stack.push(tk); continue; }
      const op = tk.v;
      switch (op) {
        case 'BT': curY = 0; break;
        case 'Tf':
          for (const x of stack) if (x.t === 'name') { font = x.v; break; }
          break;
        case 'Tj': emit([stack[stack.length - 1]]); break;
        case "'": flush(); emit([stack[stack.length - 1]]); break;
        case '"': flush(); emit([stack[stack.length - 1]]); break;
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (arr && arr.t === 'arr') {
            for (const el of arr.v) {
              if (el.t === 's') emit([el]);
              else if (el.t === 'num' && el.v <= -100) space();
            }
          }
          break;
        }
        case 'T*': flush(); break;
        case 'Td':
        case 'TD': {
          const ty = (stack.length >= 2 && stack[1].t === 'num') ? stack[1].v : 0;
          curY += ty;
          if (Math.abs(ty) >= 2) flush();
          break;
        }
        case 'Tm': {
          const f = (stack.length >= 6 && stack[5].t === 'num') ? stack[5].v : curY;
          if (Math.abs(f - curY) >= 2) flush();
          curY = f;
          break;
        }
        default: break;
      }
      stack.length = 0;
    }
    flush();                                            /* 页尾自动收行 */
    return lines;
  }

  /** 一个字符串 token → 文本。有 ToUnicode 就走映射，没有就 latin1 硬降级。 */
  function decodeString(raw, dec, stats) {
    if (!dec || !dec.map.size) {
      /* 降级：字节值当 latin1 直接吐出去。ASCII 原样可读，中文必是乱码 ——
       * 但"乱码"至少还能做 ASCII 关键词匹配，比整页丢掉强。 */
      for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) >= 128) stats.mojibake++;
      return raw;
    }
    let out = '';
    const n = dec.codeLen;
    for (let i = 0; i + n <= raw.length; i += n) {
      let key = '';
      for (let k = 0; k < n; k++) key += ('0' + raw.charCodeAt(i + k).toString(16)).slice(-2);
      const hit = dec.map.get(key.toUpperCase());
      if (hit !== undefined) out += hit;
      else stats.unmapped++;
    }
    return out;
  }

  /* ---------------------------------------------------------------- 字体与页面 */

  /** 取一个字体对象的解码表：/ToUnicode → CMap 流 → 解压 → 解析。 */
  async function decoderOf(u8, objs, fontVal, warn, cmapWarned) {
    const tu = dv(fontVal, 'ToUnicode');
    if (!tu) return null;
    const entry = (tu.t === 'ref') ? objs.get(tu.num) : null;
    if (!entry) {
      warn('字体声明了 /ToUnicode 但指向的对象不存在，该字体按降级处理');
      return null;
    }
    if (!entry.stream) {
      warn('字体的 /ToUnicode 不是流对象，已按降级处理');
      return null;
    }
    let data;
    try { data = await decodeStream(u8, objs, entry, warn); } catch (e) { data = null; }
    if (!data) return null;
    const cm = parseCMap(bytesToLatin1(data));
    if (!cm.map.size) {
      const key = 'empty-cmap';
      if (!cmapWarned[key]) { cmapWarned[key] = 1; warn('有 ToUnicode CMap 解析不出任何映射，该字体按降级处理'); }
      return null;
    }
    return cm;
  }

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {Promise<{lines:string[], text:string, pages:number, fonts:number,
   *                    mapped:number, warnings:string[]}>}
   * **永不抛**：任何失败都只进 warnings，最坏返回空结果。
   */
  async function extractText(input) {
    const res = { lines: [], text: '', pages: 0, fonts: 0, mapped: 0, warnings: [] };
    const warn = function (msg) { if (res.warnings.indexOf(msg) < 0) res.warnings.push(msg); };

    try {
      let u8;
      if (input instanceof Uint8Array) u8 = input;
      else if (input instanceof ArrayBuffer) u8 = new Uint8Array(input);
      else if (input && input.buffer instanceof ArrayBuffer) u8 = new Uint8Array(input.buffer, input.byteOffset | 0, input.byteLength | 0);
      else { warn('输入既不是 ArrayBuffer 也不是 Uint8Array，未解析'); return res; }
      if (!u8.length) { warn('PDF 字节为空'); return res; }

      const src = bytesToLatin1(u8);
      if (src.slice(0, 1024).indexOf('%PDF') < 0) {
        warn('不是 PDF（文件头没有 %PDF），未解析');
        return res;
      }
      if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(src)) {
        warn('PDF 带 /Encrypt（已加密），文本抽取结果不可信');
      }

      const objs = scanObjects(src);
      const objstm = await expandObjectStreams(u8, objs, warn);
      if (objstm) warn('有 ' + objstm + ' 个对象藏在对象流（ObjStm）里，已展开');

      /* 页面按对象在文件里出现的顺序排（Map 保序；绝大多数 PDF 就是这么写的） */
      const pageEntries = [];
      for (const o of objs.values()) {
        if (o.stream) continue;
        const t = dv(o.val, 'Type');
        if (isName(t, 'Page')) pageEntries.push(o);
      }
      res.pages = pageEntries.length;
      if (!pageEntries.length) warn('没找到任何 /Type /Page 页面对象');

      const cmapWarned = Object.create(null);
      const fontSeen = new Set();
      const decoderCache = new Map();
      /* 降级计数（跨页累加，最后汇总成一条 warning） */
      const stats = { unmapped: 0, mojibake: 0 };

      for (const page of pageEntries) {
        const resources = deref(objs, dv(page.val, 'Resources'));
        const fontDict = deref(objs, dv(resources, 'Font'));
        const decoders = new Map();

        if (fontDict && fontDict.t === 'dict') {
          for (const fname of Object.keys(fontDict.v)) {
            const fref = fontDict.v[fname];
            const fval = deref(objs, fref);
            if (!fval || fval.t !== 'dict') continue;
            const fkey = (fref && fref.t === 'ref') ? fref.num : null;
            let cm = (fkey != null) ? decoderCache.get(fkey) : undefined;
            if (cm === undefined) {
              try { cm = await decoderOf(u8, objs, fval, warn, cmapWarned); }
              catch (e) { cm = null; }
              if (fkey != null) decoderCache.set(fkey, cm);
            }
            if (fkey == null || !fontSeen.has(fkey)) {
              res.fonts++;
              if (cm && cm.map.size) res.mapped++;
              if (fkey != null) fontSeen.add(fkey);
            }
            if (cm && cm.map.size) decoders.set(fname, cm);
          }
        } else {
          warn('有页面没有 /Resources /Font，该页文字只能按降级处理');
        }

        /* /Contents 可能是单个引用，也可能是引用数组 */
        const refs = [];
        const collect = function (v) {
          if (!v) return;
          if (v.t === 'ref') refs.push(v);
          else if (v.t === 'arr') v.v.forEach(collect);
        };
        collect(dv(page.val, 'Contents'));
        let text = '';
        for (const r of refs) {
          const entry = objs.get(r.num);
          if (!entry || !entry.stream) continue;
          let data;
          try { data = await decodeStream(u8, objs, entry, warn); } catch (e) { data = null; }
          if (data) text += bytesToLatin1(data) + '\n';
        }
        const pageOut = text ? pageLines(text, decoders, stats) : [];
        for (const l of pageOut) res.lines.push(l);
      }

      /* 码点级降级按全书汇总成一条（按页发会刷屏：一份 300 页的 PDF 会变成 300 条同义警告） */
      if (stats.unmapped) warn('有 ' + stats.unmapped + ' 个字符码在 ToUnicode 里查不到映射，已丢弃');
      if (stats.mojibake) warn('有 ' + stats.mojibake + ' 个非 ASCII 字节没有对应的 ToUnicode 映射，已按 latin1 降级');

      const noMap = res.fonts - res.mapped;
      if (noMap > 0) {
        warn('有 ' + noMap + ' 个字体没有 ToUnicode 映射，非 ASCII 字符可能丢失（已按 latin1 降级）');
      }
      res.text = res.lines.join('\n');
      return res;
    } catch (e) {
      /* 兜底：走到这都算解析失败，保留已经抽到的东西，只补一条说明 */
      warn('PDF 解析中断：' + (e && e.message ? e.message : String(e)));
      res.text = res.lines.join('\n');
      return res;
    }
  }

  NS.extractText = extractText;
})();
