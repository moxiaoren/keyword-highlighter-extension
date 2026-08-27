/**
 * 本地存储管理模块
 * 所有数据仅保存在 chrome.storage.local
 */
const Storage = {
  // 默认配置
  defaults: {
    globalEnabled: true,
    keywords: [],
    groups: [],
    siteRules: [],       // { type: 'blacklist'|'whitelist', pattern: '', matchType: 'exact'|'subdomain'|'prefix'|'regex' }
    siteDisabledMap: {},  // { 'example.com': true }
    highlightStyle: {
      defaultBgColor: '#ffff00',
      defaultTextColor: '#000000',
      defaultBorderColor: '#e6c300',
      defaultBorderWidth: '1px',
      defaultBorderRadius: 'iat::3px',
    },
    noteCardStyle: {
      bgColor: '#ffffff',
      textColor: '#333333',
      borderColor: '#cccccc',
      borderWidth: '1px',
      borderRadius: '8px',
      shadow: '0 4px 12px rgba(0,0,0,0.15)',
      maxWidth: '320px',
      opacity: '0.96',
      fontSize: '14px'
    },
    matchSettings: {
      defaultCaseSensitive: false,
      defaultWholeWord: false,
      defaultUseRegex: false
    },
    noteFormat: '备注：{content}',
    shadowDOMEnabled: true,
    adjacentCellNote: true,  // 重要笔记是否识别相邻单元格并特别标注
    stats: {
      keywordHits: {},    // { keywordId: count }
      siteHits: {}       // { domain: count }
    },
    version: '1.6.33'
  },

  async getAll() {
    const result = await chrome.storage.local.get(null);
    return this._mergeDefaults(result);
  },

  async get(keys) {
    const result = await chrome.storage.local.get(keys);
    return this._mergeDefaults(result);
  },

  async set(items) {
    return chrome.storage.local.set(items);
  },

  async remove(keys) {
    return chrome.storage.local.remove(keys);
  },

  async clear() {
    return chrome.storage.local.clear();
  },

  // 关键词 CRUD
  async getKeywords() {
    const data = await this.get(['keywords']);
    return data.keywords || [];
  },

  async addKeyword(keyword) {
    const keywords = await this.getKeywords();
    // 检测重复：前格(text) + 后格(cellVerify) 都相同才算重复，支持前格相同后格不同的多条词并存
    const dup = keywords.find(k => this._sameKeyword(k, keyword) && k.id !== keyword.id);
    if (dup) {
      const tag = keyword.cellVerify ? `(${keyword.text} | ${keyword.cellVerify})` : `"${keyword.text}"`;
      throw new Error(`关键词 ${tag} 已存在`);
    }
    keyword.id = keyword.id || this._generateId();
    keyword.createdAt = keyword.createdAt || Date.now();
    keyword.updatedAt = Date.now();
    keyword.enabled = keyword.enabled !== false;
    keyword.important = keyword.important === true;
    keyword.importantNote = keyword.importantNote || '';
    keywords.push(keyword);
    await this.set({ keywords });
    return keyword;
  },

  async updateKeyword(id, updates) {
    const keywords = await this.getKeywords();
    const idx = keywords.findIndex(k => k.id === id);
    if (idx === -1) throw new Error('关键词不存在');
    // 检测重复：前格(text) + 后格(cellVerify) 组合去重
    if (updates.text) {
      const tCv = updates.cellVerify !== undefined ? updates.cellVerify : (keywords[idx].cellVerify || '');
      const dup = keywords.find(k => k.id !== id && this._sameKeyword(k, { text: updates.text, cellVerify: tCv }));
      if (dup) {
        const tag = tCv ? `(${updates.text} | ${tCv})` : `"${updates.text}"`;
        throw new Error(`关键词 ${tag} 已存在`);
      }
    }
    keywords[idx] = { ...keywords[idx], ...updates, updatedAt: Date.now() };
    await this.set({ keywords });
    return keywords[idx];
  },

  async deleteKeyword(id) {
    let keywords = await this.getKeywords();
    keywords = keywords.filter(k => k.id !== id);
    await this.set({ keywords });
  },

  async toggleKeyword(id) {
    const keywords = await this.getKeywords();
    const kw = keywords.find(k => k.id === id);
    if (kw) {
      kw.enabled = !kw.enabled;
      kw.updatedAt = Date.now();
      await this.set({ keywords });
    }
    return kw;
  },

  // 分组 CRUD
  async getGroups() {
    const data = await this.get(['groups']);
    return data.groups || [];
  },

  async addGroup(group) {
    const groups = await this.getGroups();
    if (groups.find(g => g.name === group.name)) {
      throw new Error(`分组 "${group.name}" 已存在`);
    }
    group.id = group.id || this._generateId();
    group.important = group.important === true;
    group.importantNote = group.importantNote || '';
    groups.push(group);
    await this.set({ groups });
    return group;
  },

  async updateGroup(id, updates) {
    const groups = await this.getGroups();
    const idx = groups.findIndex(g => g.id === id);
    if (idx === -1) throw new Error('分组不存在');
    const newGroup = { ...groups[idx], ...updates };
    groups[idx] = newGroup;
    await this.set({ groups });

    // 若更新了分组颜色，同步组内关键词的颜色数据，保证同组颜色统一
    if (updates.bgColor !== undefined) {
      const keywords = await this.getKeywords();
      let changed = false;
      keywords.forEach(k => {
        if (k.groupId === id) {
          k.bgColor = newGroup.bgColor || '';
          k.textColor = newGroup.textColor || '';
          changed = true;
        }
      });
      if (changed) await this.set({ keywords });
    }
    return newGroup;
  },

  async deleteGroup(id) {
    let groups = await this.getGroups();
    groups = groups.filter(g => g.id !== id);
    await this.set({ groups });
    // 清除关联关键词的分组引用
    const keywords = await this.getKeywords();
    let changed = false;
    keywords.forEach(k => {
      if (k.groupId === id) {
        k.groupId = '';
        changed = true;
      }
    });
    if (changed) await this.set({ keywords });
  },

  // 站点规则
  async getSiteRules() {
    const data = await this.get(['siteRules']);
    return data.siteRules || [];
  },

  async getSiteDisabledMap() {
    const data = await this.get(['siteDisabledMap']);
    return data.siteDisabledMap || {};
  },

  async setSiteDisabled(hostname, disabled) {
    const map = await this.getSiteDisabledMap();
    if (disabled) {
      map[hostname] = true;
    } else {
      delete map[hostname];
    }
    await this.set({ siteDisabledMap: map });
  },

  // 统计
  async incrementHit(keywordId, domain) {
    const data = await this.get(['stats']);
    const stats = data.stats || this.defaults.stats;
    stats.keywordHits[keywordId] = (stats.keywordHits[keywordId] || 0) + 1;
    stats.siteHits[domain] = (stats.siteHits[domain] || 0) + 1;
    await this.set({ stats });
  },

  async getTodayHits() {
    // 简单实现：返回总命中数（可按需扩展为每天）
    const data = await this.get(['stats']);
    const stats = data.stats || this.defaults.stats;
    return Object.values(stats.keywordHits).reduce((a, b) => a + b, 0);
  },

  async clearStats() {
    await this.set({ stats: this.defaults.stats });
  },

  // 导入导出
  async exportData() {
    const data = await this.getAll();
    delete data.stats; // 不导出统计
    return JSON.stringify(data, null, 2);
  },

  async importData(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      // 验证基本结构
      if (!data.keywords || !Array.isArray(data.keywords)) {
        throw new Error('无效的数据格式：缺少 keywords 字段');
      }
      // 规整分组：补全颜色等字段（旧备份或缺字段时保持结构完整，避免分组颜色/属性丢失）
      const groups = (data.groups || []).map(g => (g ? {
        id: g.id || this._generateId(),
        name: g.name || '',
        bgColor: g.bgColor || '',
        textColor: g.textColor || '',
        important: g.important === true,
        importantNote: g.importantNote || ''
      } : null)).filter(Boolean);
      await this.set({
        globalEnabled: data.globalEnabled !== false,      // 补齐：导出含此字段，导入需恢复，避免开关状态丢失
        keywords: data.keywords || [],
        groups,
        siteRules: data.siteRules || [],
        siteDisabledMap: data.siteDisabledMap || {},       // 补齐：导出含此字段，导入需恢复，避免站点禁用状态丢失
        highlightStyle: data.highlightStyle || this.defaults.highlightStyle,
        noteCardStyle: data.noteCardStyle || this.defaults.noteCardStyle,
        matchSettings: data.matchSettings || this.defaults.matchSettings,
        noteFormat: data.noteFormat || this.defaults.noteFormat,
        shadowDOMEnabled: data.shadowDOMEnabled !== false
      });
      return true;
    } catch (e) {
      throw new Error('导入失败：' + e.message);
    }
  },

  async exportCSV() {
    const keywords = await this.getKeywords();
    const groups = await this.getGroups();
    const groupMap = {};
    groups.forEach(g => { groupMap[g.id] = g.name; });

    const headers = ['关键词', '备注', '分组', '启用', '区分大小写', '全词匹配', '正则表达式', '背景色', '文字颜色', '重要', '重要笔记', '单元格标注', '单元格标注值', '单元格标注匹配方式'];
    const rows = keywords.map(k => [
      this._csvEscape(k.text),
      this._csvEscape(k.note || ''),
      this._csvEscape(groupMap[k.groupId] || ''),
      k.enabled ? '是' : '否',
      k.caseSensitive ? '是' : '否',
      k.wholeWord ? '是' : '否',
      k.useRegex ? '是' : '否',
      k.bgColor || '',
      k.textColor || '',
      k.important ? '是' : '否',
      this._csvEscape(k.importantNote || ''),
      k.cellVerifyEnabled ? '是' : '否',
      this._csvEscape(k.cellVerify || ''),
      k.cellVerifyMatchMode || 'include'
    ].join(','));
    return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  },

  async importCSV(csvStr) {
    const lines = csvStr.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV 格式无效');
    // 跳过 BOM
    let headerLine = lines[0].replace(/^\uFEFF/, '');
    const headers = headerLine.split(',').map(h => h.trim());
    const keywords = await this.getKeywords();
    const groups = await this.getGroups();
    const groupByName = new Map();
    groups.forEach(g => { if (g && g.name) groupByName.set(g.name, g); });

    let groupsChanged = false;
    for (let i = 1; i < lines.length; i++) {
      const values = this._parseCSVLine(lines[i]);
      if (values.length < 1) continue;
      // 恢复分组关联：CSV「分组」列(第3列)映射回 groupId，避免导入后关键词脱离原分组、分组高亮色丢失；
      // 若目标当前无该分组，则自动创建同名分组（颜色由关键词继承或后续设置）。
      const groupName = (values[2] || '').trim();
      let groupId = '';
      if (groupName) {
        let g = groupByName.get(groupName);
        if (!g) {
          g = { id: this._generateId(), name: groupName, bgColor: '', textColor: '', important: false, importantNote: '' };
          groups.push(g);
          groupByName.set(groupName, g);
          groupsChanged = true;
        }
        groupId = g.id;
      }
      const kw = {
        id: this._generateId(),
        text: values[0] || '',
        note: values[1] || '',
        groupId,
        enabled: values[3] !== '否',
        caseSensitive: values[4] === '是',
        wholeWord: values[5] === '是',
        useRegex: values[6] === '是',
        bgColor: values[7] || '',
        textColor: values[8] || '',
        important: values[9] === '是',
        importantNote: values[10] || '',
        cellVerifyEnabled: values[11] === '是',
        cellVerify: values[12] || '',
        cellVerifyMatchMode: (values[13] === 'exact') ? 'exact' : 'include',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      // 检测重复：前格 + 后格组合去重
      if (!keywords.find(k => this._sameKeyword(k, kw))) {
        keywords.push(kw);
      }
    }
    if (groupsChanged) await this.set({ groups });
    await this.set({ keywords });
    return keywords.length;
  },

  // 内部辅助：判断两条关键词是否相同（前格 text + 后格 cellVerify 组合去重）
  _sameKeyword(a, b) {
    if (!a || !b) return false;
    if (a.text !== b.text) return false;
    return (a.cellVerify || '') === (b.cellVerify || '');
  },

  _mergeDefaults(data) {
    const result = { ...this.defaults };
    for (const key of Object.keys(data)) {
      if (data[key] !== undefined) {
        if (typeof result[key] === 'object' && !Array.isArray(result[key]) && result[key] !== null) {
          result[key] = { ...result[key], ...data[key] };
        } else {
          result[key] = data[key];
        }
      }
    }
    return result;
  },

  _generateId() {
    return 'kw_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  },

  _csvEscape(str) {
    if (!str) return '';
    str = String(str);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  },

  _parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          result.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    result.push(current);
    return result;
  }
};

// 导出到全局作用域（content script / popup / options / service worker 共享）
if (typeof window !== 'undefined') {
  window.Storage = Storage;
}
// Service Worker 环境没有 window，挂到 globalThis
if (typeof globalThis !== 'undefined' && typeof Storage === 'undefined') {
  globalThis.Storage = Storage;
}
