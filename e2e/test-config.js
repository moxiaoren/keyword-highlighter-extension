'use strict';
/* 测试用配置（走 storage 注入，避免手工点 UI） */

/** 测试注入必须带 silent/gap = 0，否则默认 1s 静默 + 2s 节流会读到旧状态 */
const PERF = {
  pageRebuildOnChange: true,
  pageRebuildSilentMs: 0,
  pageRebuildGapMs: 0,
  pageFingerprintIntervalMs: 0
};

const CONFIG = Object.assign({
  globalEnabled: true,
  shadowDOMEnabled: true,
  suspendInactiveTab: false,
  pageResidualClean: true,
  pageCleanClick: false,

  highlightStyle: { defaultBgColor: '#ff9500', defaultTextColor: '#000000' },
  noteCardStyle: {
    bgColor: '#ffffff', textColor: '#333333', borderColor: '#cccccc', borderWidth: '1px',
    borderRadius: '8px', shadow: '0 4px 12px rgba(0,0,0,0.15)', maxWidth: '320px',
    opacity: '0.96', fontSize: '14px'
  },
  importantNote: { imgSize: 70 },
  matchSettings: { defaultCaseSensitive: false, defaultWholeWord: false, defaultUseRegex: false },

  siteRules: [],
  siteDisabledMap: {},

  groups: [
    { id: 'gA', name: '分组甲', bgColor: '#3388ff', textColor: '#ffffff', important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '' }
  ],

  keywords: [
    /* 1. 普通词 + 备注（点卡片用） + 抓取（驳回原因多行） —— 抓取必须配重要标记才进面板 */
    { id: 'k1', text: '审核不通过', note: '这是**备注**：状态词的解释。',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: true, importantNote: '状态说明笔记', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '驳回原因|运营备注' },

    /* 2. 分组色（验证 分组色 > 词色 > 默认色）：命中装置里的「运营备注」 */
    { id: 'k2', text: '运营备注', note: '分组甲的词',
      groupId: 'gA', enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '#ff0000', textColor: '',   // 自身红色，但分组色应压过它
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 3. 左右格组合词：标题「资质类型」→ 核心「资质A1」（核心在跨节点里，检验整格匹配） */
    { id: 'k3', text: '资质A1', note: '组合词备注',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: true, importantNote: '组合词笔记', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '资质类型', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 4. 上下格组合词：表头「是否刚需」× 数据行「否」 */
    { id: 'k4', text: '否', note: '',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '是否刚需', comboAxis: 'tb',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 5. 仅抓取：核心留空 + 标题「应用名称」+ 抓包名。
          第一行右格是「-」→ 不显示；第二行右格有内容 → 显示 com.foo.real */
    { id: 'k5', text: '', note: '',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: true, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '应用名称', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false,
      fetchLabels: '包名' },

    /* 6. 全词 + 正则含 | （策划案 §7.1 坑 1：中间分支必须也有边界） */
    { id: 'k6', text: 'BUG|FEATURE', note: '',
      groupId: null, enabled: true, caseSensitive: true, wholeWord: true, useRegex: true,
      bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: false, cellVerify: '', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 7. el-table 分表：表头「审核状态」× 数据行「审核不通过」*/
    { id: 'k7', text: '审核不通过', note: '',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '审核状态', comboAxis: 'tb',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 8. 组合词（左右格）核心词被拆成多个文本节点：
          v1.99.99.8 用户实测缺陷 —— 普通词能命中、组合词漏。装置见 fixtures/combo-xnode.html */
    { id: 'k8', text: '来遇见你', note: '跨节点组合词备注',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: true, importantNote: '跨节点组合词笔记', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '软件介绍', comboAxis: 'lr',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' },

    /* 9. 组合词（上下格）核心词被拆成多个文本节点（同一条口径，两个轴都要覆盖） */
    { id: 'k9', text: '是的哦', note: '',
      groupId: null, enabled: true, caseSensitive: false, wholeWord: false, useRegex: false,
      bgColor: '', textColor: '',
      important: false, importantNote: '', impNoteUseHlColor: false, imgSize: '',
      cellVerifyEnabled: true, cellVerify: '是否重点关注', comboAxis: 'tb',
      cellVerifyMatchMode: 'include', cellVerifyCaseSensitive: false, cellVerifyUseRegex: false, fetchLabels: '' }
  ]
}, PERF);

module.exports = { CONFIG, PERF };
