/**
 * 快速添加关键词 - 独立弹窗脚本
 * 在独立小窗口中运行，空间宽裕，避免 popup 内挤压换行。
 */
document.addEventListener('DOMContentLoaded', () => {
  const text = document.getElementById('qwText');
  const note = document.getElementById('qwNote');
  const important = document.getElementById('qwImportant');
  const importantNoteField = document.getElementById('importantNoteField');
  const importantNote = document.getElementById('qwImportantNote');
  const cancel = document.getElementById('qwCancel');
  const save = document.getElementById('qwSave');

  // 备注格式说明小标
  document.getElementById('qwNoteHint')?.addEventListener('click', () => {
    const p = document.getElementById('qwNoteHintPanel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('qwImportantNoteHint')?.addEventListener('click', () => {
    const p = document.getElementById('qwImportantNoteHintPanel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });

  // 勾选「重要」才展开重要笔记输入框（避免表单被拉长）
  const toggleImportantNote = () => {
    importantNoteField.classList.toggle('show', important.checked);
    if (important.checked) {
      importantNote.focus();
    }
  };
  important.addEventListener('change', toggleImportantNote);

  // Enter 保存 / Shift+Enter 在文本框内换行
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save.click();
    }
  });

  cancel.addEventListener('click', () => window.close());

  save.addEventListener('click', async () => {
    const kw = text.value.trim();
    if (!kw) {
      text.focus();
      text.style.borderColor = '#e53935';
      setTimeout(() => { text.style.borderColor = ''; }, 1200);
      return;
    }

    try {
      await Storage.addKeyword({
        text: kw,
        note: note.value.trim(),
        importantNote: importantNote.value.trim(),
        important: important.checked,
        groupId: '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        enabled: true
      });

      // 通知当前活动标签页刷新高亮
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].id) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, { action: 'refresh' });
        } catch (e) { /* 页面无法收到也没关系 */ }
      }

      window.close();
    } catch (err) {
      alert('添加失败：' + (err && err.message || err));
    }
  });

  text.focus();
});
