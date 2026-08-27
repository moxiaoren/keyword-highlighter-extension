/**
 * 快速添加关键词 - 独立弹窗脚本
 * 在独立小窗口中运行，空间宽裕，避免 popup 内挤压换行。
 * 说明文字采用「ⓘ + 悬浮气泡」展示，不占版面。
 */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('qaForm');
  const text = document.getElementById('qwText');
  const note = document.getElementById('qwNote');
  const important = document.getElementById('qwImportant');
  const importantNoteField = document.getElementById('importantNoteField');
  const importantNote = document.getElementById('qwImportantNote');
  const cell = document.getElementById('qwCell');
  const cellField = document.getElementById('cellField');
  const cellValue = document.getElementById('qwCellValue');
  const cellExact = document.getElementById('qwCellExact');
  const cellCase = document.getElementById('qwCellCase');
  const cellRegex = document.getElementById('qwCellRegex');
  const cancel = document.getElementById('qwCancel');

  // 勾选「重要」才展开重要笔记输入框（避免表单被拉长）
  important.addEventListener('change', () => {
    importantNoteField.classList.toggle('show', important.checked);
    if (important.checked) importantNote.focus();
  });

  // 勾选「单元格特别标注」才展开后格配置
  cell.addEventListener('change', () => {
    cellField.classList.toggle('show', cell.checked);
    if (cell.checked) cellValue.focus();
  });

  // 关键词框：Enter 保存（Shift+Enter 无意义，单行输入框）
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  cancel.addEventListener('click', () => window.close());

  // 保存
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

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
        enabled: true,
        cellVerifyEnabled: cell.checked,
        cellVerify: cell.checked ? cellValue.value.trim() : '',
        cellVerifyMatchMode: cellExact.checked ? 'exact' : 'include',
        cellVerifyCaseSensitive: cellCase.checked,
        cellVerifyUseRegex: cellRegex.checked
      });

      // 通知当前活动标签页刷新高亮
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].id) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, { action: 'refresh' });
        } catch (err) { /* 页面无法收到也没关系 */ }
      }

      window.close();
    } catch (err) {
      alert('添加失败：' + (err && err.message || err));
    }
  });

  text.focus();
});
