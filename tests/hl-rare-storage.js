/*
 * 罕见字 storage 层单测（v1.12.0）：hjz# → kind:'rare' 识别与唯一性
 * 运行：node tests/hl-rare-storage.js
 */
const mem = {};
global.window = global;
global.chrome = { storage: { local: {
  async get(keys) {
    if (keys === null) return Object.assign({}, mem);
    if (Array.isArray(keys)) { const o = {}; keys.forEach(k => { if (k in mem) o[k] = mem[k]; }); return o; }
    return { [keys]: mem[keys] };
  },
  async set(items) { Object.assign(mem, items); },
  async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete mem[k]); },
  async clear() { for (const k in mem) delete mem[k]; }
} } };

require('../lib/storage.js');
const Storage = globalThis.Storage;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  → ' + JSON.stringify(detail) : ''));
}

(async () => {
  // 1. 添加 hjz# → kind='rare'
  let kw = await Storage.addKeyword({ text: 'hjz#', enabled: true });
  check('addKeyword(hjz#) → kind=rare', kw.kind === 'rare', kw.kind);
  // 2. 普通词 → 无 kind
  let kw2 = await Storage.addKeyword({ text: '普通词', enabled: true });
  check('addKeyword(普通词) → 无 kind', !('kind' in kw2), kw2.kind);
  // 3. 读取持久化后的 kind
  const all = await Storage.getKeywords();
  const rare = all.find(k => k.text === 'hjz#');
  check('持久化后 hjz# 仍 kind=rare', !!(rare && rare.kind === 'rare'), rare && rare.kind);
  // 4. 唯一性：再次添加 hjz# → 抛「已存在」
  let dupErr = null;
  try { await Storage.addKeyword({ text: 'hjz#', enabled: true }); } catch (e) { dupErr = e.message; }
  check('重复添加 hjz# → 抛已存在', !!dupErr && /已存在/.test(dupErr), dupErr);
  // 5. 编辑：把普通词改成 hjz# → kind=rare
  await Storage.updateKeyword(kw2.id, { text: 'hjz#' });
  const upd = (await Storage.getKeywords()).find(k => k.id === kw2.id);
  check('编辑改为 hjz# → kind=rare', upd && upd.kind === 'rare', upd && upd.kind);
  // 6. 编辑：把 hjz# 改回普通 → kind 清除
  await Storage.updateKeyword(kw.id, { text: '改名啦' });
  const back = (await Storage.getKeywords()).find(k => k.id === kw.id);
  check('编辑改回普通词 → kind 清除', back && !('kind' in back), back && back.kind);
  // 7. 罕见字组合：hjz# + 标题词 → kind=rare 且可并存（不同 cellVerify）
  await Storage.addKeyword({ text: 'hjz#', cellVerifyEnabled: true, cellVerify: '组合标题', enabled: true });
  const comboKws = (await Storage.getKeywords()).filter(k => k.text === 'hjz#');
  check('罕见字组合(hjz#+标题) 可并存且 kind=rare',
    comboKws.length >= 2 && comboKws.every(k => k.kind === 'rare'),
    comboKws.map(k => ({ cv: k.cellVerify, kind: k.kind })));

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(failed.length === 0 ? '✅ 全部 ' + results.length + ' 项通过' : '❌ ' + failed.length + '/' + results.length + ' 项失败');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
