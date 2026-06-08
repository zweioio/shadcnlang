// shadcn 翻译器 - 后台服务
// 弹窗 -> 内容脚本的消息中转

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === 'translatePage' || request.action === 'resetTranslation') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) chrome.tabs.sendMessage(tab.id, request);
    });
  }
});
