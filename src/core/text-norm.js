/* ============================================================================
 * src/core/text-norm.js · 文本比较口径（**全工程唯一实现**）
 * ----------------------------------------------------------------------------
 * 为什么要有这个模块（2.0.8.18 需求①）：
 *   「图片命中词 / 图片动态词」这条线上，同一个问题在四个地方各判了一次，四处口径互不相同：
 *     · `ImgOcr.judgeInfo()`      原文剔空白 + 小写后 `indexOf`（子串存在性，无边界）
 *     · `ImportantNote` 的 `ocrFieldHit()`   动态值**全齐**才算命中（AND）
 *     · `ImportantNote` 的 `ocrExtraRows()`  有**任一**命中就进表（OR）
 *     · `ImportantNote` 的 `decorateMerge()` 按字段名 `textContent` **精确**回表取第二个值
 *   于是同一个「图上到底有没有这个值」的判定，在面板、进表、合并三处给出三种答案
 *   （最典型：OCR 把 `abc1234` 读成 `ａｂｃ１２３４` ⇒ 面板说不命中，进表却出了一行）。
 *
 * 本模块只做一件事：把「怎么算同一个值」写成纯函数，谁要判等谁调这里，不许再各写一份。
 * 三条纪律（改这里之前先读）：
 *   ① **归一化只用于比较，不覆盖展示原值**。RFC 8264 §12 明说文本变换"rarely reversible"，
 *      大小写折叠会丢信息（`StPeter` → `stpeter`）。所以本模块的返回值只进判据，不许回写配置/笔记。
 *   ② **只做"格式差异"**：空白、全半角、零宽字符、大小写，以及**中英文标点的 1:1 折叠**
 *      （2026-11-12 需求③：`a，b` 与 `a,b` 要算同一个词）。标点折叠只做**单字符→单字符**
 *      的查表（`，`→`,`、`「`→`"`），绝不合并/删除字符，所以区间映射照旧精确。
 *      **不做**去标点、不做 NFKC（NFKC 会改长度：`①`→`1`、`ﬁ`→`fi`，长度一变就无法把命中
 *      区间映射回原文，面板的词块与"复制整句"会整片错位；UAX #15 自己也警告 KC/KD
 *      "must not be blindly applied"）。
 *   ③ **逐级归并**：`verdict()` 必须说清是"第几级折出来的相等"（fold-ws / fold-width / …），
 *      面板才能把「因为全半角才凑上」如实告诉用户，而不是笼统地说"一致"。
 * ========================================================================= */
(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  /** 空白：`\s` 之外还要认全角空格 `\u3000`（中文排版里最常见的那一个） */
  const WHITE = /[\s\u3000]/;
  const WHITE_ALL = /[\s\u3000]+/g;
  /** 零宽字符：OCR 引擎/复制粘贴会在词中间塞这些，肉眼不可见却让 `indexOf` 失败 */
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;
  /** 纯 ASCII 字母数字：只有这类值需要"边界"约束（中文没有词边界可言） */
  const ASCII_WORD = /^[a-z0-9]+$/;
  const WORD_CHAR = /[a-z0-9]/;

  /** 小于这个长度的纯 ASCII 值不参与**相等判定**（`12`、`abc` 当判据只会制造假冲突） */
  const MIN_ASCII_LEN = 4;
  /** 小于这个长度的值连"存在性"都不判（图上"1"/"是"到处都是） */
  const MIN_ANY_LEN = 2;

  /** 单个字符的全角→半角（1:1，长度不变，所以区间映射不会错位） */
  function foldWidthChar(c) {
    const code = c.charCodeAt(0);
    if (code === 0x3000) return ' ';
    if (code >= 0xFF01 && code <= 0xFF5E) return String.fromCharCode(code - 0xFEE0);
    return c;
  }

  /**
   * 中英文标点 1:1 折叠表（全角 ASCII 标点已经被 `foldWidthChar` 折过了，这里只补 CJK 专有标点）。
   * 纪律：**一个字符换一个字符**，不合并（`……` 不能换成 `...`）、不删除 —— 否则
   * `foldTo().spans` 就映射不回原文，命中块会画到别的字上。
   */
  const PUNCT_MAP = {
    '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!',
    '「': '"', '」': '"', '『': '"', '』': '"', '“': '"', '”': '"', '‘': "'", '’': "'",
    '【': '[', '】': ']', '《': '<', '》': '>', '〈': '<', '〉': '>', '〔': '[', '〕': ']',
    '—': '-', '–': '-', '·': '.'
  };

  function foldPunctChar(c) { return PUNCT_MAP[c] || c; }

  /** 逐字符的最终折叠（全半角 → 中英标点），返回单个字符 */
  function foldChar(c) { return foldPunctChar(foldWidthChar(c)); }

  /**
   * 段落边界哨兵：**空行**（两个换行之间没有别的非空白字符）是真正的另起一段，
   * 比对时不许跨过去（2026-11-12 需求③：「原本就是另起一段的不需要忽略」）。
   * 单个换行只是 OCR 检测框切行留下的版面痕迹，照旧丢掉。
   * 用 `\u0001` 而不是 `\n`：它不会被 `WHITE` 吃掉，也不会和用户文本里的任何字符撞车。
   */
  const PARA_BREAK = '\u0001';

  function isNl(c) { return c === '\n' || c === '\r'; }

  function stripWs(s) { return String(s == null ? '' : s).replace(WHITE_ALL, ''); }

  function foldWidth(s) {
    const src = String(s == null ? '' : s);
    let out = '';
    for (let i = 0; i < src.length; i += 1) out += foldWidthChar(src.charAt(i));
    return out;
  }

  function foldPunct(s) {
    const src = String(s == null ? '' : s);
    let out = '';
    for (let i = 0; i < src.length; i += 1) out += foldPunctChar(src.charAt(i));
    return out;
  }

  function stripZero(s) { return String(s == null ? '' : s).replace(ZERO_WIDTH, ''); }

  /**
   * 全量折叠 + **区间映射**：`foldTo(text).spans[i]` = 输出第 i 个字符来自原文的 `[start, end)`。
   *
   * 为什么不直接 `String.replace()`：命中块要画在**原文**里（`OcrCopy.sentenceOf` 在原文上
   * `indexOf`），而折叠会删字符（空白/零宽）甚至加字符（`İ`.toLowerCase() 是两码）。
   * 逐字符记账是唯一不会错位的做法；这也正是本模块**不许**引入 NFKC 的原因（NFKC 的映射表
   * 不是逐字符可记账的）。
   */
  function foldTo(text) {
    const src = String(text == null ? '' : text);
    let out = '';
    const spans = [];
    for (let i = 0; i < src.length; i += 1) {
      const c = src.charAt(i);
      /* 换行：单个换行 = 版面折行（丢掉）；空行 = 真段落边界（插哨兵，不许跨段命中） */
      if (isNl(c)) {
        let j = i + 1;
        if (c === '\r' && src.charAt(j) === '\n') j += 1;
        let k = j;
        while (k < src.length) {
          const d = src.charAt(k);
          if (isNl(d)) break;
          if (!WHITE.test(d) && !ZERO_WIDTH.test(d)) break;
          k += 1;
        }
        if (k < src.length && isNl(src.charAt(k))) {
          let end = k + 1;
          if (src.charAt(k) === '\r' && src.charAt(end) === '\n') end += 1;
          out += PARA_BREAK;
          spans.push([i, end]);
          i = end - 1;
        }
        continue;
      }
      if (WHITE.test(c)) continue;
      if (ZERO_WIDTH.test(c)) continue;
      const low = foldChar(c).toLowerCase();
      for (let k = 0; k < low.length; k += 1) {
        out += low.charAt(k);
        spans.push([i, i + 1]);
      }
    }
    return { text: out, spans: spans };
  }

  /** 全量规范形（L1 去空白 + L2 全半角 + L3 中英标点 + L4 去零宽 + L5 小写）—— 只用于判等/去重 */
  function keyOf(s) {
    /* 首尾的空行不改变"这是同一个值"，只有夹在两个值中间的段边界才有语义 */
    return foldTo(s).text.replace(/^\u0001+|\u0001+$/g, '');
  }

  /**
   * 「这个值太短，不足以当判据」。
   * 判据只区分两类：非 ASCII（中文/混排，2 个字就有意义）与纯 ASCII 字母数字（4 位起步）。
   * 用户现场 S3：抓取值 `12` 命中图上 `2024-12-31` —— 只有长度下限能挡住它，
   * 边界约束挡不住（`-12-` 两侧都不是字母数字，照样算"完整词"）。
   */
  function isWeak(s) {
    const k = keyOf(s);
    if (k.length < MIN_ANY_LEN) return true;
    if (ASCII_WORD.test(k) && k.length < MIN_ASCII_LEN) return true;
    return false;
  }

  /** 全半角/大小写等都不改语义的字符集里，前后必须是"非字母数字"才算一个完整词 */
  function hasBoundary(hay, at, len) {
    const before = at > 0 ? hay.charAt(at - 1) : '';
    const after = at + len < hay.length ? hay.charAt(at + len) : '';
    if (before && WORD_CHAR.test(before)) return false;
    if (after && WORD_CHAR.test(after)) return false;
    return true;
  }

  /**
   * 在 `text` 里找 `needle`（唯一查找实现）。
   *
   * @param {string} text 识别文本/抓取值
   * @param {string} needle 要找的值
   * @param {{boundary?:boolean, minLen?:number, allowWeak?:boolean}} [opts]
   *   `boundary` 默认 **true**：纯 ASCII 判据必须左右是词边界（`abc1234` 不许命中 `abc12345`）；
   *   `allowWeak` 默认 false：太短的值直接返回 null（调用方据此记为"判据不可用"，不是"没命中"）。
   * @returns {{start:number, end:number, text:string, key:string}|null} 区间是**原文**下标
   */
  function findInText(text, needle, opts) {
    const o = opts || {};
    const raw = String(text == null ? '' : text);
    const key = keyOf(needle);
    if (!key) return null;
    if (!o.allowWeak && isWeak(key)) return null;
    const minLen = (o.minLen == null) ? 0 : o.minLen;
    if (minLen && key.length < minLen) return null;
    const folded = foldTo(raw);
    const wantBoundary = o.boundary !== false && ASCII_WORD.test(key);
    let from = 0;
    for (;;) {
      const at = folded.text.indexOf(key, from);
      if (at < 0) return null;
      if (!wantBoundary || hasBoundary(folded.text, at, key.length)) {
        const s = folded.spans[at];
        const e = folded.spans[at + key.length - 1];
        /* 映射不到（理论上不会）就如实返回 null：宁可少画一个词块，也不许猜一个区间 */
        if (!s || !e) return null;
        return { start: s[0], end: e[1], text: raw.slice(s[0], e[1]), key: key };
      }
      from = at + 1;
    }
  }

  function contains(text, needle, opts) { return !!findInText(text, needle, opts); }

  /**
   * 两个值"像不像同一个东西"，并说清是**哪一级**折出来的相等。
   *
   * 返回（顺序 = 从强到弱，面板文案按这个顺序解释）：
   *   `same`       原样（去首尾空白）就一样
   *   `fold-ws`    只差空白（OCR 字距/换行造成的）
   *   `fold-width` 只差全半角（`ａｂｃ` vs `abc`）
   *   `fold-punct` 只差中英文标点（`a，b` vs `a,b`）
   *   `fold-zero`  只差零宽字符
   *   `fold-case`  只差大小写
   *   `weak`       有一侧太短，**不该**参与相等判定（不是"不一致"，别报冲突）
   *   `only-a` / `only-b`  有一侧是空的
   *   `conflict`   以上都不成立 = 真的不一样
   */
  function verdict(a, b) {
    const A = String(a == null ? '' : a);
    const B = String(b == null ? '' : b);
    const ka = keyOf(A);
    const kb = keyOf(B);
    if (!ka && !kb) return 'none';
    if (!ka) return 'only-b';
    if (!kb) return 'only-a';
    if (A.trim() === B.trim()) return 'same';
    if (isWeak(ka) || isWeak(kb)) return 'weak';
    const steps = [
      ['fold-ws', (s) => stripWs(s)],
      ['fold-width', (s) => foldWidth(stripWs(s))],
      ['fold-punct', (s) => foldPunct(stripWs(s))],
      ['fold-zero', (s) => stripZero(foldWidth(stripWs(s)))],
      ['fold-case', (s) => stripZero(foldWidth(stripWs(s))).toLowerCase()]
    ];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i][1](A) === steps[i][1](B)) return steps[i][0];
    }
    return 'conflict';
  }

  /** 是不是"可以认为相等"（含折叠出来的相等；`weak` 不算 —— 判不了就不下结论） */
  function equal(a, b) {
    const v = verdict(a, b);
    return v === 'same' || v === 'fold-ws' || v === 'fold-width' || v === 'fold-punct'
      || v === 'fold-zero' || v === 'fold-case';
  }

  KH.TextNorm = {
    /** 常量（诊断/单测读，不要在别处再造一份） */
    MIN_ASCII_LEN: MIN_ASCII_LEN,
    MIN_ANY_LEN: MIN_ANY_LEN,
    PARA_BREAK: PARA_BREAK,
    keyOf: keyOf,
    foldTo: foldTo,
    foldWidth: foldWidth,
    foldWidthChar: foldWidthChar,
    foldPunct: foldPunct,
    foldPunctChar: foldPunctChar,
    stripWs: stripWs,
    stripZero: stripZero,
    isWeak: isWeak,
    hasBoundary: hasBoundary,
    findInText: findInText,
    contains: contains,
    verdict: verdict,
    equal: equal
  };
})();
