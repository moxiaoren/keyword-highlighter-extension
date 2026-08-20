/**
 * Welcome 页面脚本
 */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnStart').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById('btnAddFirst').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    // 延迟触发添加关键词
    setTimeout(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        // 选项页已打开，用户可以手动点击添加
      });
    }, 500);
    window.close();
  });
});
