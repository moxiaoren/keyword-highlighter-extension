/* tests/specs/ocr-options.test.js — 设置页与面板的"引擎可感知面"（S2-c）
 * ----------------------------------------------------------------------------
 * S2 把「识别档位」换成了「识别引擎」，于是有三类**用户看不见但会骗人**的失配必须被钉住：
 *
 *   ① **档位必须彻底消失**（判据 ④）：`#ocr-quality` 这个死控件、`ocrQuality()` 这个恒返回 'fast'
 *      的函数、以及各处 `quality:` 传参，只要留一个，用户看到的设置就与实际行为不一致。
 *      唯一的例外是 `src/core/config.js` —— 那里是**迁移代码**（`DEPRECATED_KEYS` + 存量回落），
 *      判据本来就允许它留档。
 *   ② **只读「高级信息」不许变成谎话**（票 #17 D-17.7）：它展示的 15 个引擎参数值全部来自
 *      `offscreen/ocr.js` / `src/features/img-ocr.js` 的常量。这张表是**手写**的，
 *      所以这里逐条回源码对账 —— 改了常量不改设置页，立刻红。
 *   ③ **迁移提示必须关得掉**（D-17.4）：置 `migrated.ocrEngine=false` 时**必须同时写回 imgOcr** ，
 *      否则存储里那个废弃键还在，下一次读又把它置真 —— 用户点了「知道了」，下次打开又弹。
 *
 * 面板那一侧（读 `it.engineReason` 并把"已从 PP-OCR 回落到兼容引擎"写进展开说明）在这里也一并测：
 * 它是**唯一**让用户知道自己被降级了的地方（折叠标签故意不动）。
 */
'use strict';
const H = require('../harness');
const { suite, test, eq, truthy, falsy } = H;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 去掉注释后的源码（按行保留换行与列位，行号不漂）—— 静态守卫不该打自己的解释性注释 */
function codeOf(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

module.exports = async function run() {
  const { KH } = require('../bootstrap');

  suite('设置页与面板的引擎可感知面（S2-c · 判据 ④）');

  /* ==================================================================
   * ① 档位彻底消失 + 引擎选择器就位
   * ================================================================== */

  await test('★ 「识别档位」控件已被「识别引擎」取代（三项取值恰为 auto/ppocr/tesseract）', () => {
    const html = read('options/options.html');
    falsy(/id="ocr-quality"/.test(html), '设置页还留着 #ocr-quality（档位已取消，它会变成一个死控件）');
    truthy(/id="ocr-engine"/.test(html), '设置页缺 #ocr-engine（用户就无从选引擎）');
    const block = /<select[^>]*id="ocr-engine"[\s\S]*?<\/select>/.exec(html);
    truthy(block, '找不到 #ocr-engine 的 select 块');
    const values = Array.from(block[0].matchAll(/<option value="([^"]+)"/g)).map((m) => m[1]);
    eq(values.join(','), 'auto,ppocr,tesseract', '#ocr-engine 的选项必须是这三项（顺序也照契约）');
  });

  await test('★ 判据 ④：`imgOcr.quality` / `ocrQuality()` / `quality:` 在业务代码里零命中（迁移代码除外）', () => {
    const dirs = ['options', 'offscreen', 'background', 'popup', 'content'];
    const files = ['src/features/img-ocr.js', 'src/ui/ocr-copy.js', 'src/platform/storage.js'];
    for (const d of dirs) {
      const abs = path.join(ROOT, d);
      for (const name of fs.readdirSync(abs)) {
        const rel = d + '/' + name;
        if (!/\.(js|html)$/.test(name)) continue;
        files.push(rel);
      }
    }
    const hits = [];
    for (const rel of files) {
      const code = codeOf(rel);
      code.split(/\r?\n/).forEach((line, i) => {
        if (/imgOcr\.quality|\bocrQuality\b|\bquality\s*[:,)]/.test(line)) {
          hits.push(rel + ':' + (i + 1) + '  ' + read(rel).split(/\r?\n/)[i].trim().slice(0, 100));
        }
      });
    }
    eq(hits.length, 0, '档位相关写法必须清干净（除 src/core/config.js 的迁移代码外）：\n      ' + hits.join('\n      '));
    /* 反过来：迁移代码必须**还在** —— 删了它，存量用户的 'best' 就没人接，会落成非法值 */
    const cfg = read('src/core/config.js');
    truthy(/'imgOcr\.quality'/.test(cfg), "config.js 的 DEPRECATED_KEYS 必须留着 'imgOcr.quality'（写回时物理删掉它）");
    truthy(/'quality' in raw\.imgOcr/.test(cfg), 'config.js 的迁移判据（存量 quality 在 ⇒ 置 migrated.ocrEngine）丢了');
  });

  /* ==================================================================
   * ② 只读「高级信息」与源码常量对账
   * ================================================================== */

  await test('★ 只读「高级信息」的每一行都必须在源码里找得到同名的常量与同一个值', () => {
    const js = read('options/options.js');
    const rows = Array.from(js.matchAll(/^\s*\['([A-Z][A-Z0-9_]*)',\s*'[^']*',\s*'([^']*)'\]/gm))
      .map((m) => ({ name: m[1], value: m[2] }));
    truthy(rows.length >= 10, '只读「高级信息」的参数表太小了（至少覆盖契约里那 10 个）：' + rows.length);
    const src = read('offscreen/ocr.js') + '\n' + read('src/features/img-ocr.js');
    const bad = [];
    for (const r of rows) {
      /* 常量声明形如 `const NAME = 1600;` —— 字符串值（PSM）两边都去引号再比 */
      const m = new RegExp('const ' + r.name + '\\s*=\\s*([^;]+);').exec(src);
      if (!m) { bad.push(r.name + ' 在源码里没有同名常量（改名了？那设置页这张表就是谎话）'); continue; }
      const got = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (got !== r.value) bad.push(r.name + ' 的值与源码不一致：设置页写 ' + r.value + '，源码是 ' + got);
    }
    eq(bad.length, 0, bad.join('\n      '));
    /* 参数表**只许读**：不许出现输入控件（一旦可改，用户就能把识别调坏且无从排查） */
    const block = /const OCR_ENGINE_PARAMS = \[[\s\S]*?\];/.exec(js);
    truthy(block, '找不到 OCR_ENGINE_PARAMS 表');
    falsy(/input|select/i.test(block[0]), '参数表里不该有可编辑控件（票 #17 D-17.7：一律不给可配）');
  });

  /* ==================================================================
   * ③ 迁移提示与自检
   * ================================================================== */

  await test('★ 迁移提示：存在、可关，且写回时**一起写 imgOcr**（否则提示关不掉）', () => {
    const html = read('options/options.html');
    truthy(/id="ocr-migrate-note"/.test(html), '设置页缺一次性迁移提示块 #ocr-migrate-note');
    truthy(/id="btn-ocr-migrate-ok"/.test(html), '缺「知道了」按钮（提示必须能关掉）');
    const js = codeOf('options/options.js');
    truthy(/cfg\.migrated\s*&&\s*cfg\.migrated\.ocrEngine\s*===\s*true/.test(js), '提示的显示条件必须读 migrated.ocrEngine');
    /* 正面钉住那一行：两个键必须**同时**写。只写 migrated ⇒ 存储里 imgOcr.quality 还在 ⇒ 下次读又置真 */
    truthy(/imgOcr:\s*Object\.assign\(\{\},\s*cfg\.imgOcr\)[\s\S]{0,80}migrated:\s*\{\s*ocrEngine:\s*false\s*\}/.test(js),
      '点「知道了」时必须同时写回 imgOcr 与 migrated.ocrEngine=false（只写后者的话提示永远关不掉）');
  });

  await test('★ 自检三件事：requestId 比对 / 30s 超时 / 回显**实际**引擎', () => {
    const js = codeOf('options/options.js');
    truthy(/selftestId\s*&&\s*m\.requestId\s*!==\s*selftestId/.test(js),
      '自检必须比对 requestId，否则页面里别的识别的结果会把自检"点亮"');
    truthy(/setTimeout\(\(\)\s*=>\s*\{\s*done\(\{\s*timeout:\s*true\s*\}\);\s*\},\s*30000\)/.test(js),
      '自检必须有 30s 超时（引擎卡死时不能永远停在「识别中…」）');
    truthy(/msg\.engine/.test(js), '自检结果必须回显**实际**用的引擎（否则用户以为在测主引擎）');
  });

  /* ==================================================================
   * ④ 面板：降级告知（唯一让用户知道"被降级了"的地方）
   * ================================================================== */

  await test('★ 面板展开说明：engineReason 非空 ⇒ 明说"已从 PP-OCR 回落到兼容引擎"；空 ⇒ 不加废话', () => {
    const C = KH.OcrCopy;
    const base = { state: 'done', text: '供应商甲', keyword: '一对一' };
    const miss = Object.assign({}, base, { engineReason: 'asset-missing' });
    const w = C.why(miss);
    truthy(w.indexOf('回落') >= 0, '降级了必须在展开说明里写出来：' + w);
    truthy(w.indexOf('模型文件没准备好') >= 0, '原因要翻成人话（`asset-missing` 这种机器码印给用户等于没说）：' + w);
    /* 折叠标签**故意不动**：标签是"发生了什么"，引擎是"怎么发生的"，塞进去只会让标签变长 */
    eq(C.tag(miss), C.tag(base), '折叠标签不该因为引擎回落而改变');
    /* 没回落 ⇒ 一个字的废话都不加 */
    eq(C.why(base).indexOf('回落'), -1, '没回落就不许提引擎');
    /* 每个原因码都要有"人话"，且不许留未替换的占位符 */
    const reasons = C.dump().engineReason || {};
    const codes = Object.keys(reasons);
    truthy(codes.length >= 5, '引擎回落原因的"人话"表太小：' + codes.join('、'));
    for (const code of ['asset-missing', 'init-failed', 'module-load-failed', 'engine-unavailable', 'missing-engine']) {
      truthy(codes.indexOf(code) >= 0, '缺少原因码 ' + code + ' 的"人话"（它真会出现在回执里）');
    }
    for (const code of codes) {
      const t = C.why(Object.assign({}, base, { engineReason: code }));
      truthy(t.indexOf('回落') >= 0 && t.indexOf('{') < 0, code + ' 的人话渲染不对：' + t);
    }
  });
};
