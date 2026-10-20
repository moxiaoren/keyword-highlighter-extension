/* ============================================================================
 * tests/specs/ocr-layout.test.js · 【2.0.2.19 需求②③⑤】OCR 全文的列带排版与动态命中
 * ----------------------------------------------------------------------------
 * 三条用户口径（本轮交办）：
 *   ② 图里是表格 ⇒ 展示 OCR 全文时也排成表格；图里表格「姓名|张三」命中后，抓取字段表下方
 *      补一行 姓名|张三；**同值就合并**成「姓名/员工名字|张三」。
 *   ③ 「图片命中关键词」之外的动态判据：抓取字段 姓名 抓到 张三、图里也有 张三 才算命中。
 *   ⑤ 两张软著横排 ⇒ OCR 全文做成左右两个单元格。
 *
 * 这里钉的是**纯函数**（不碰 DOM、不碰消息层）：
 *   · `KH.ImgOcr.layout(lineList)` → 列带模型（`cols` < 2 必须退回纯文本，零回归）
 *   · `KH.ImgOcr.layoutHtml(模型)` → 表格 HTML（逐格转义）
 *   · `KH.ImgOcr.judge/needOf`   → 动态命中的唯一判决点
 *   · `KH.ImportantNote.ocrExtraRows` → 无冒号的表格行也要能并进抓取字段表
 * 真机证据（2.0.2.18 实测的软著证书图）见 _memory/STATUS.md 的 2.0.2.19 段。
 * ========================================================================= */
'use strict';

const H = require('../harness');
const { suite, test, eq, deepEq, truthy, falsy, loadKernel } = H;

/** 造一行的单元格：`mk(50, 100, '姓名')` = x 从 50 起、右边界 100 */
const cell = (x, x2, t) => ({ t: t, x: x, x2: x2 });
const line = (...cells) => ({ t: cells.map(c => c.t).join(' '), cells: cells });

/** 造一个真表格（与 fetch.test.js 同一份垫片）：needs 里的取值要走真 DOM 才验得动 */
function table(rows) {
  const t = H.el('table');
  const tbody = H.el('tbody');
  t.appendChild(tbody);
  for (const cells of rows) {
    const tr = H.el('tr');
    for (const c of cells) {
      const td = H.el('td');
      td.appendChild(H.txt(typeof c === 'string' ? c : String(c && c.text != null ? c.text : '')));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.rows = tbody.children.map((tr, ri) => {
    tr.rowIndex = ri;
    tr.cells = tr.children;
    tr.cells.forEach((td, i) => { td.cellIndex = i; });
    return tr;
  });
  return t;
}

module.exports = async function run() {
  const KH = loadKernel();
  const IO = KH.ImgOcr;
  truthy(IO && typeof IO.layout === 'function', 'KH.ImgOcr.layout 必须可用（面板靠它排 OCR 全文）');

  suite('2.0.2.19 需求②⑤：OCR 行 → 列带模型');
    await test('★ 键值表格（两列）⇒ cols=2，每行两格按列对齐', () => {
      const lines = [
        line(cell(40, 120, '姓名'), cell(300, 360, '张三')),
        line(cell(40, 120, '工号'), cell(300, 380, 'A-1024')),
        line(cell(40, 120, '部门'), cell(300, 400, '技术部'))
      ];
      const lay = IO.layout(lines);
      eq(lay.cols, 2, '两个 x 区间 ⇒ 两列');
      eq(lay.rows.length, 3, '三行原样保留');
      eq(lay.rows[0].cols[0], '姓名');
      eq(lay.rows[0].cols[1], '张三');
      eq(lay.rows[2].cols[1], '技术部');
    });

    await test('★ 需求⑤：两张证书横排 ⇒ 左右两个单元格（同 y 的左右行不串列）', () => {
      const lines = [
        line(cell(30, 330, '计算机软件著作权登记证书'), cell(380, 660, '软件著作权认证证书')),
        line(cell(30, 120, '软件名称'), cell(150, 330, '51买房软件 V1.0'), cell(380, 500, '登记号'), cell(520, 660, '软件登字第123号'))
      ];
      const lay = IO.layout(lines);
      /* 四条带各自成列（< COL_MAX=4），两张证书的"软件名称/登记号"顺序各占两列 —— 关键是：
       * **都在同一行里**，没有把右边的字挪到左边那格的下一行。 */
      truthy(lay.cols >= 2, '横排两栏必须至少分成 2 列，实际 ' + lay.cols);
      const html = IO.layoutHtml(lay);
      truthy(/<table class="kh-ocr-table">/.test(html), '必须产出表格');
      const tds = (html.match(/<td[ >]/g) || []).length;
      eq(tds, lay.cols * lay.rows.length, '每行必须恰好 ' + lay.cols + ' 个 td（空槽也输出，靠它保持列对齐）');
    });

    await test('★ 通栏行（标题/条文）不参与分列，也不把两栏桥接成一栏', () => {
      const lines = [
        line(cell(40, 480, '中华人民共和国国家版权局计算机软件著作权登记证书')),
        line(cell(40, 120, '软件名称'), cell(200, 420, '众创指购AI智能解梦分析系统')),
        line(cell(40, 520, '根据《计算机软件保护条例》和《计算机软件著作权登记办法》的规定，经中国版权保护中心审核'))
      ];
      const lay = IO.layout(lines);
      eq(lay.cols, 2, '通栏行被宽格闸门排除后，剩下两列');
      eq(lay.rows[0].wide, '中华人民共和国国家版权局计算机软件著作权登记证书', '通栏行进 wide');
      eq(lay.rows[2].wide.indexOf('根据《计算机软件保护条例》'), 0, '整段条文也算通栏');
    });

    await test('★ 2.0.6 需求③：同一格里两段文字挨得极近 ⇒ 直接贴，不许凭空多空格', () => {
      /* 检测框把「供应商：」和「华为」切成两段（间隙 2px）⇒ 现在是「供应商：华为」，
       * 旧实现一律 join(' ') ⇒「供应商： 华为」，抄进笔记就是脏数据。 */
      const lines = [
        line(cell(10, 60, '姓名'), cell(400, 460, '张三')),
        line(cell(10, 60, '供应商：'), cell(62, 140, '华为')),
        line(cell(10, 60, '姓名'), cell(110, 170, '张三'))
      ];
      const lay = IO.layout(lines);
      eq(lay.cols, 2, '两列结构不变');
      eq(lay.rows[1].cols[0], '供应商：华为', '★ 间隙 2px ⇒ 贴成「供应商：华为」');
      eq(lay.rows[2].cols[0], '姓名 张三', '真有列间距（50px）仍要留空格');
      eq(lay.rows[0].cols[1], '张三', '跨列不受影响');
    });

    await test('★ 普通一段文字（专栏 < 2 / 列太多）⇒ 必须退回纯文本（layoutHtml 返回空串）', () => {
      const one = IO.layout([line(cell(20, 400, '这是一张没有表格的截图，只有一整段文字，右边界也只到 400'))]);
      eq(one.cols, 1, '单列就是单列');
      eq(IO.layoutHtml(one), '', 'cols<2 必须返回空串，调用方走 paintHits 的老路');
      const many = IO.layout([cell(0, 30, 'a'), cell(40, 70, 'b'), cell(80, 110, 'c'), cell(120, 150, 'd'), cell(160, 190, 'e')]
        .map((c) => line(c)));
      eq(many.cols, 1, '5 条细列 = 被切碎的文字，不许排成 5 列表格');
    });

    await test('★ 表格 HTML 逐格转义（OCR 原文不许当代码拼进 DOM）', () => {
      const lay = IO.layout([line(cell(40, 120, '姓名'), cell(300, 460, '<img src=x onerror=alert(1)>'))]);
      const html = IO.layoutHtml(lay);
      falsy(html.indexOf('<img') >= 0, '尖括号必须被转义');
      truthy(html.indexOf('&lt;img') >= 0, '转义形态要在');
    });

    await test('★ 空行 / 无坐标 / 脏数据不许抛（面板异步回来时喂什么都不能炸）', () => {
      eq(IO.layout(null).cols, 1);
      eq(IO.layout([]).cols, 1);
      const junk = IO.layout([{ cells: [{ t: '姓名', x: NaN, x2: 10 }, { t: '', x: 1, x2: 9 }] }]);
      eq(junk.cols, 1, '坐标不合法 ⇒ 当没有列结构');
      eq(IO.layoutHtml(null), '');
      eq(IO.layoutHtml({ cols: 3 }), '');
    });

  suite('2.0.2.19 需求③：「图片动态关键词」点名抓取字段 ⇒ 值也要出现在图上');
    /* 两条判据：静态词 `imgOcrKeyword`（可选）+ 点名的抓取字段值 `imgOcrNeed`（可选）。
     * 为什么不是"所有抓取字段都当判据"（我最初的理解）：那会静默 break 存量配置 ——
     * 用户配 `fetchLabels` 只是为了"从哪些格子里取图"，不是为了让值当判据。 */
    const rule = { meta: { imgOcr: true, imgOcrKeyword: '姓名', imgOcrNeed: '姓名' } };
    const dynOnly = { meta: { imgOcr: true, imgOcrKeyword: '', imgOcrNeed: '姓名' } };

    await test('★ 点名了但值不在图上 ⇒ 不命中（用户原例的否定侧）', () => {
      eq(IO.judge(rule, '姓名\n岗位\n财务', ['张三']).length, 0, '图里只有「姓名」没有「张三」');
      eq(IO.judge(dynOnly, '姓名\n岗位\n财务', ['张三']).length, 0, '只配动态判据时同理');
    });

    await test('★ 值也在图里 ⇒ 命中（用户原例的肯定侧）', () => {
      const hit = IO.judge(rule, '姓名：张 三\n部门：财务', ['张三']);
      truthy(hit.length, 'OCR 把「张 三」读散也必须算命中（值与关键词同口径剔空白）');
      eq(hit[0].text, '姓名', '静态词命中块仍然返回，面板上画的是它');
      const only = IO.judge(dynOnly, '员工名字：张 三', ['张三']);
      truthy(only.length, '不填静态词、只点名抓取字段也是合法配置');
      eq(only[0].text, '张 三', '动态判据返回的是**图上那段原文**（词块要能画出来）');
    });

    await test('★ 没点名（need 为空）⇒ 与旧版逐字一致，不因升级少命中', () => {
      eq(IO.judge(rule, '姓名\n岗位\n财务', []).length, 1);
      eq(IO.judge({ meta: { imgOcr: true, imgOcrKeyword: '姓名' } }, '员工名字：张三', []).length, 0,
        '没有动态要求时唯一口径还是静态词：静态词没命中就是不命中');
    });

    await test('★ 两条都配 ⇒ 且（静态词没命中，值在也不命中）', () => {
      eq(IO.judge(rule, '员工名字：张三', ['张三']).length, 0);
    });

    await test('★ 不看大小写（OCR 出的英文大小写不可控）', () => {
      const r = { meta: { imgOcr: true, imgOcrKeyword: 'ID', imgOcrNeed: '编号' } };
      truthy(IO.judge(r, 'ID: ab-1024', ['ab-1024']).length, '抓到的值小写、图里小写 ⇒ 命中');
      truthy(IO.judge(r, 'id   AB-1024', ['Ab-1024']).length, '双方大小写不同也必须命中');
    });

    await test('★ needOf：字段名按抓取字段的语法解析（后缀写不写都认）', () => {
      eq(JSON.stringify(IO.needNames('')), '[]');
      eq(JSON.stringify(IO.needNames('开发者^高价')), '["开发者"]',
        '★ 用户原例：把「图片动态关键词」照抄成抓取字段的写法 ⇒ 旧实现比的是带后缀原文、判据被静默丢掉');
      eq(JSON.stringify(IO.needNames('开发者|金额%4, 姓名')), '["开发者","金额","姓名"]');
      eq(JSON.stringify(IO.needNames('开发者|开发者')), '["开发者"]', '同一个字段写两遍只算一次');
    });

    await test('★ needOf：值为空 / 没锚点 ⇒ 安全返回空（不许抛、不许当"命中全部"）', () => {
      eq(IO.needOf(null, { meta: { imgOcrNeed: '姓名' } }).length, 0, '没有锚点格');
      eq(IO.needOf(null, { meta: {} }).length, 0, '没点名任何字段（旧行为：没有动态判据）');
      eq(IO.needOf(null, null).length, 0, '连规则都没有');
    });

    await test('★ needOf：值走 Fetch.extractFor —— 与重要笔记表格同一份取值（含 ! ^ % @ 修饰）', () => {
      const t = table([
        ['开发者', '北京星河科技（高价版）'],
        ['金额', '12 元'],
        ['备注', '-']
      ]);
      const meta = {
        imgOcr: true, imgOcrKeyword: '开发者', imgOcrNeed: '开发者^高价|金额|备注',
        fetchLabels: '开发者^高价|金额|备注'
      };
      /* 锚点 = 命中所在格（生产里传的就是 `anchor.cell`）；这里命中在「开发者」这一格 */
      const got = IO.needOf(t.rows[0].children[0], { meta: meta });
      deepEq(got, ['北京星河科技（', '12元'],
        '★ 判据必须等于**笔记表里显示的值**：`^高价` 已生效、占位符 `-` 不参与、空白同口径剔除');
      falsy(got.indexOf('北京星河科技（高价版）') >= 0,
        '★ 原始格全文不再进判据（旧实现在这里多带「高价版」尾巴，图上永远对不上 ⇒ 图片 OCR 看着"不生效"）');
    });

  suite('2.0.4 需求①：键值行进表必须「按词配后缀标记」（收严，防误展示）');
    const { ocrExtraRows } = KH.ImportantNote;
    truthy(typeof ocrExtraRows === 'function', 'KH.ImportantNote.ocrExtraRows 必须导出');

    const withItems = (items, fn) => {
      const orig = KH.ImgOcr.items;
      KH.ImgOcr.items = () => items;
      try { return fn(); } finally { KH.ImgOcr.items = orig; }
    };

    /* 用户报的误展示现场：图上只有「一对一时间选择范围11:30.」这一行，旧版会把它拆成
     * 键=「一对一时间选择范围」值=「11:30.」塞进卡片。这两条就是收严的全部意义。 */
    const noisy = {
      ruleId: 'r1', state: 'done',
      text: '一对一时间选择范围11:30.',
      lineList: [{ t: '一对一时间选择范围11:30.', cells: [cell(10, 320, '一对一时间选择范围11:30.')] }]
    };

    await test('★ 没配标记 ⇒ 一行都不进表（旧版「所有词都生效」必须消失）', () => {
      const rows = withItems([noisy], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一' }));
      eq(rows.length, 0, '时间 11:30 不许被当值：' + JSON.stringify(rows));
    });

    await test('★ 配了标记、但这个词后面直接跟着文字 ⇒ 仍然不进表', () => {
      const rows = withItems([noisy], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一#表' }));
      eq(rows.length, 0, '「一对一」紧跟的是「时间…」不是分隔符 ⇒ 不许拆');
    });

    await test('★ 命中词 + 冒号 ⇒ 标题格=命中词，值只取冒号之后', () => {
      const it = { ruleId: 'r1', state: 'done', text: '一对一：北京某某有限公司 132 号', lineList: [] };
      const rows = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一#表|供应商' }));
      eq(rows.length, 1, JSON.stringify(rows));
      eq(rows[0].label, '一对一', '★ 标题格必须是配置的命中词本身');
      eq(rows[0].value, '北京某某有限公司 132 号', '★ 值只能是冒号之后的内容');
    });

    await test('★ 标记逐词生效：#kv 与 #表 等价，没标记的词哪怕也命中也不进表', () => {
      const it = { ruleId: 'r1', state: 'done',
        text: '一对一：北京某某\n供应商：上海某公司', lineList: [] };
      const only = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一#kv|供应商' }));
      eq(JSON.stringify(only), JSON.stringify([{ label: '一对一', value: '北京某某' }]),
        '★ 没打标记的「供应商」不许进表（哪怕它的键值行就在图上）');
      const both = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一#表|供应商#kv' }));
      eq(both.length, 2, '两个词各配一个标记 ⇒ 两行都进（逐词控制）');
    });

    await test('★ 分隔符适度放宽：空白 / ｜ / | / ＝ / = 都算（用户口径）', () => {
      const mk = (line) => ({ ruleId: 'r1', state: 'done', text: line, lineList: [] });
      const one = (line) => withItems([mk(line)], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '一对一#表' }));
      eq(one('一对一 北京某某')[0].value, '北京某某', '空白分隔');
      eq(one('一对一｜北京某某')[0].value, '北京某某', '全角竖线');
      eq(one('一对一|北京某某')[0].value, '北京某某', '半角竖线');
      eq(one('一对一＝北京某某')[0].value, '北京某某', '全角等号');
      eq(one('一对一 = 北京某某')[0].value, '北京某某', '等号两侧带空格');
      eq(one('一对一： 北京某某')[0].value, '北京某某', '冒号两侧带空格');
    });

    await test('★ 表格形式（图里就是两格）：首格必须等于命中词，值取它后面的格', () => {
      const it = {
        ruleId: 'r1', state: 'done', text: '姓名 张三',
        lineList: [{ t: '姓名 张三', cells: [cell(10, 60, '姓名'), cell(120, 190, '张三')] }]
      };
      const rows = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '姓名#表' }));
      eq(JSON.stringify(rows), JSON.stringify([{ label: '姓名', value: '张三' }]));
      const none = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '部门#表' }));
      eq(none.length, 0, '★ 首格不是这个命中词 ⇒ 不许把别的格当键（旧版是"左格当键"）');
    });

    await test('★ 标题格只认命中词：OCR 行里词前有别的字，标题仍是那个词', () => {
      const it = { ruleId: 'r1', state: 'done', text: '员工姓名：张三', lineList: [] };
      const rows = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '姓名#表' }));
      eq(rows[0].label, '姓名', '★ 标题格 = 配置的词，不是 OCR 认出来的整行前缀');
      eq(rows[0].value, '张三');
    });

    await test('★ 同一「词+值」多张图认出也只留一条 / 规则对不上不给', () => {
      const it = { ruleId: 'r1', state: 'done', text: '姓名：张三', lineList: [] };
      eq(withItems([it, it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '姓名#表' })).length, 1);
      eq(withItems([it], () => ocrExtraRows({ pinId: 'r2', imgOcr: true, imgOcrKeyword: '姓名#表' })).length, 0);
      eq(withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: false, imgOcrKeyword: '姓名#表' })).length, 0);
      eq(ocrExtraRows(null).length, 0);
    });

    /* 用户 m00893 追问：图里是 `词：值`，OCR 常认成 `词：` / `值` 两行 ⇒ 值必须能接上，
     * 但绝不许为了接上就把下面的无关正文拉进卡片。 */
    const multi = (lines, cellsOf) => ({
      ruleId: 'r1', state: 'done',
      text: lines.join('\n'),
      lineList: lines.map((t, i) => ({
        t: t,
        cells: cellsOf ? cellsOf(lines, i) : [cell(10, 10 + t.length * 8, t)]
      }))
    });
    const kvOf = (lines, csv) => withItems([multi(lines)], () =>
      ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: csv }));

    await test('★ 值被换行拆到下一行（词： / 值）：必须接上，且标题格仍是命中词', () => {
      const rows = kvOf(['供应商：', '华为技术有限公司'], '供应商#表');
      eq(JSON.stringify(rows), JSON.stringify([{ label: '供应商', value: '华为技术有限公司' }]),
        '★ 图里是「供应商：华为技术有限公司」而 OCR 折成两行 ⇒ 仍要进表');
    });

    await test('★ 值折成两行 ⇒ 合并成一条（最多两行，再多就当正文不收）', () => {
      const rows = kvOf(['地址：', '广东省深圳市', '南山区科技园'], '地址#表');
      eq(rows.length, 1, JSON.stringify(rows));
      eq(rows[0].value, '广东省深圳市 南山区科技园');
      const long = kvOf(['地址：', '广东省深圳市', '南山区科技园', '北区'], '地址#表');
      eq(long.length, 1, '★ 只吃两行：第三行不再并入（宁缺毋滥）');
      eq(long[0].value, '广东省深圳市 南山区科技园');
    });

    await test('★ 换行后的那一行若是「另一字段：值」⇒ 不偷，两条各自成行', () => {
      const rows = kvOf(['一对一：', '供应商：上海某公司'], '一对一#表|供应商#表');
      eq(JSON.stringify(rows), JSON.stringify([{ label: '供应商', value: '上海某公司' }]),
        '★ 「供应商：上海某公司」属于供应商那条，不许变成「一对一」的值');
    });

    await test('★ 换行后的那一行过长（>40 字）⇒ 判为正文，不进表', () => {
      const body = '本次招标要求投标人具备独立法人资格并近三年无重大违法记录且'.repeat(2);
      eq(kvOf(['供应商：', body], '供应商#表').length, 0,
        '★ 分隔符后面空了不代表下一段正文就是它的值（旧误展示就是这么来的）');
    });

    await test('★ 没有分隔符的独立词行绝不往下偷（词 / 值 形态不支持）', () => {
      const it = multi(['供应商', '华为技术有限公司'], () => []);
      const rows = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '供应商#表' }));
      eq(rows.length, 0, '★ 「词」单独一行、下面才是值 ⇒ 不收（否则任何标记词都能偷下一行）');
    });

    await test('★ 表格形式：词格是行末格、值在下一行 ⇒ 也能接上', () => {
      const it = multi(['供应商', '华为技术有限公司'], (lines, i) => (
        i === 0 ? [cell(10, 60, '姓名'), cell(120, 190, '供应商')] : [cell(120, 320, '华为技术有限公司')]
      ));
      const rows = withItems([it], () => ocrExtraRows({ pinId: 'r1', imgOcr: true, imgOcrKeyword: '供应商#表' }));
      eq(JSON.stringify(rows), JSON.stringify([{ label: '供应商', value: '华为技术有限公司' }]));
    });
};
