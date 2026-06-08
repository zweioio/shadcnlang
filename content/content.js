/**
 * shadcn/ui 字典翻译内容脚本
 *
 * 完全基于本地翻译字典进行文本替换，不依赖任何外部 API。
 * 支持 Shadow DOM 内部翻译（适用于 Web Components 渲染的内容）。
 *
 * 工作流程：
 * 1. 加载对应语言的翻译字典
 * 2. 遍历 DOM 树 + 所有 Shadow Root，查找可翻译文本节点
 * 3. 在字典中匹配并替换
 * 4. 多阶段翻译（立即 + 延迟）以覆盖动态渲染内容
 * 5. 通过 MutationObserver + ShadowRoot 监听处理动态内容
 */

const TRANSLATED_ATTR = 'data-shadcn-translated';
const ORIGINAL_TEXT_ATTR = 'data-shadcn-original';
const MIN_TEXT_LENGTH = 2;

let currentTargetLang = '';
let dictionary = null;
let observer = null;
let shadowObservers = [];
let translateTimeout = null;
let lastUrl = location.href;

// 检测是否在 iframe 中运行
const isInIframe = window !== window.top;

// ─── 节点过滤 ────────────────────────────────────────

function shouldSkipNode(node) {
  let el = node.parentElement || node;
  while (el) {
    if (el.nodeType === Node.ELEMENT_NODE) {
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'svg'].includes(tag)) return true;
      if (el.hasAttribute(TRANSLATED_ATTR)) return true;
    }
    el = el.parentElement || el.parentNode;
  }
  return false;
}

function isMeaningfulText(node) {
  const text = node.textContent.trim();
  if (!text || text.length < MIN_TEXT_LENGTH) return false;
  if (/^[\d\s.,!?;:()\[\]{}\-–—'"«»“”‘’\/\\%$€£¥+xX*~|]+$/.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^[.\-#@]/.test(text)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return false;
  return true;
}

// ─── 字典加载 ────────────────────────────────────────

function flattenDict(dictData) {
  const map = new Map();
  function walk(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'meta') continue;
      if (typeof value === 'object' && value !== null) {
        walk(value);
      } else if (typeof value === 'string') {
        map.set(key, value);
      }
    }
  }
  walk(dictData);
  return map;
}

function loadDictionary(lang) {
  try {
    if (typeof SHADCN_DICT_ZH_CN !== 'undefined' && lang === 'zh-CN') {
      dictionary = flattenDict(SHADCN_DICT_ZH_CN);
      return true;
    }
    console.error('[shadcn-translator] 字典未找到:', lang);
    dictionary = null;
    return false;
  } catch (error) {
    console.error('[shadcn-translator] 字典加载失败:', error);
    dictionary = null;
    return false;
  }
}

function lookupTranslation(text) {
  if (!dictionary || !text) return null;
  const trimmed = text.trim();
  if (dictionary.has(trimmed)) return dictionary.get(trimmed);
  const cleanText = trimmed.replace(/[#.:!?]+$/, '').trim();
  if (cleanText !== trimmed && dictionary.has(cleanText)) return dictionary.get(cleanText);
  return null;
}

// ─── DOM 遍历（支持 Shadow DOM） ──────────────────────

/**
 * 递归收集所有可翻译文本节点，穿透 Shadow DOM + iframe
 * @param {Node} root - 根节点
 * @param {string} [mode='basic'] - 'basic'（跳过代码块）或 'full'（翻译所有文本）
 */
function collectTextNodes(root = document.body) {
  const nodes = [];

  function traverse(node) {
    if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
      traverse(node.shadowRoot);
    }

    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IFRAME') {
      try {
        const doc = node.contentDocument || node.contentWindow?.document;
        if (doc && doc.body) {
          traverse(doc.body);
        }
      } catch (e) { /* 跨域 iframe */ }
    }

    const walker = document.createTreeWalker(
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node : node,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => {
          if (shouldSkipNode(n)) return NodeFilter.FILTER_REJECT;
          if (!isMeaningfulText(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      nodes.push(textNode);
    }

    const children = node.nodeType === Node.ELEMENT_NODE
      ? node.children
      : node.childNodes;

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        traverse(child);
      }
    }
  }

  traverse(root);
  return nodes;
}

async function translatePageSingle(targetLang) {
  if (!targetLang) return { success: false, error: '未指定目标语言' };

  if (targetLang !== currentTargetLang || !dictionary) {
    currentTargetLang = targetLang;
    loadDictionary(targetLang);
  }

  const textNodes = collectTextNodes(document.body);
  if (textNodes.length === 0) return { success: true, count: 0 };

  const textMap = new Map();
  for (const node of textNodes) {
    const text = node.textContent.trim();
    if (!text) continue;
    if (!textMap.has(text)) textMap.set(text, []);
    textMap.get(text).push(node);
  }

  let appliedCount = 0;
  for (const [text, nodes] of textMap.entries()) {
    const translation = lookupTranslation(text);
    if (translation && translation !== text) {
      applyToNodes(nodes, text, translation);
      appliedCount++;
    }
  }

  return { success: true, count: appliedCount };
}

function applyToNodes(nodes, originalText, translation) {
  for (const node of nodes) {
    const parent = node.parentElement || node.parentNode;
    if (parent) {
      parent.setAttribute(ORIGINAL_TEXT_ATTR, originalText);
      parent.setAttribute(TRANSLATED_ATTR, currentTargetLang);
    }
    node.textContent = translation;
  }
}

// ─── 恢复原文 ────────────────────────────────────────

function resetTranslation() {
  const elements = document.querySelectorAll(`[${ORIGINAL_TEXT_ATTR}]`);
  for (const el of elements) {
    const originalText = el.getAttribute(ORIGINAL_TEXT_ATTR);
    if (originalText) {
      const textNodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        textNodes.push(node);
      }
      if (textNodes.length > 0) {
        textNodes[0].textContent = originalText;
      }
    }
    el.removeAttribute(ORIGINAL_TEXT_ATTR);
    el.removeAttribute(TRANSLATED_ATTR);
  }
  currentTargetLang = '';
  dictionary = null;
  return { success: true };
}

// ─── SPA 导航与 Shadow DOM 监听 ─────────────────────

/**
 * 对元素及其 shadowRoot 设置 MutationObserver
 */
function observeElementAndShadow(el) {
  if (observer) {
    observer.observe(el, { childList: true, subtree: true });
  }
  // 监听 shadow root 变化
  if (el.shadowRoot) {
    const shadowObs = new MutationObserver(() => {
      if (currentTargetLang && dictionary) {
        clearTimeout(translateTimeout);
          translateTimeout = setTimeout(() => {
          translatePageSingle(currentTargetLang);
        }, 300);
      }
    });
    shadowObs.observe(el.shadowRoot, { childList: true, subtree: true, characterData: true });
    shadowObservers.push(shadowObs);

    // 递归监听子元素的 shadowRoot
    for (const child of el.shadowRoot.querySelectorAll('*')) {
      if (child.shadowRoot) {
        observeElementAndShadow(child);
      }
    }
  }
  // 递归监听所有子元素的 shadowRoot
  for (const child of el.querySelectorAll('*')) {
    if (child.shadowRoot) {
      observeElementAndShadow(child);
    }
  }
}

function setupNavigationObserver() {
  if (isInIframe) {
    // iframe 内只监听 DOM 变化，不拦截导航
    observer = new MutationObserver(() => {
      if (currentTargetLang && dictionary) {
        clearTimeout(translateTimeout);
        translateTimeout = setTimeout(() => translatePageSingle(currentTargetLang), 300);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return;
  }

  // 拦截 pushState / replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onUrlMaybeChanged();
  };
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onUrlMaybeChanged();
  };
  window.addEventListener('popstate', onUrlMaybeChanged);

  // 主 MutationObserver
  observer = new MutationObserver((mutations) => {
    onUrlMaybeChanged();
    if (!currentTargetLang || !dictionary) return;

    let hasNewContent = false;
    // 检查是否有新元素（包括带 shadow root 的）
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName?.toLowerCase();
            if (tag && !['script', 'style', 'link'].includes(tag)) {
              hasNewContent = true;
              // 如果新节点有 shadow root，监听它
              if (node.shadowRoot) {
                observeElementAndShadow(node);
              }
              // 也检查新节点内部的 shadow roots
              for (const child of node.querySelectorAll('*')) {
                if (child.shadowRoot) {
                  observeElementAndShadow(child);
                }
              }
              break;
            }
          }
        }
      }
    }

    if (hasNewContent && currentTargetLang && dictionary) {
      translatePageSingle(currentTargetLang);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 扫描页面上已有的 shadow roots
  setTimeout(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) {
        observeElementAndShadow(el);
      }
    }
  }, 100);
}

function onUrlMaybeChanged() {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    if (currentTargetLang && dictionary) {
      setTimeout(() => { translatePageSingle(currentTargetLang); updateToggleButton(true); }, 300);
    }
  }
}

// ─── 消息监听 ────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translatePage':
      translatePageSingle(request.targetLang)
        .then((result) => { sendResponse(result); if (result?.success) updateToggleButton(true); })
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    case 'resetTranslation':
      sendResponse(resetTranslation());
      updateToggleButton(false);
      break;
    case 'getStatus':
      sendResponse({ active: !!currentTargetLang, targetLang: currentTargetLang });
      break;
  }
});

// ─── 导航栏语言切换按钮 ──────────────────────────────

const TOGGLE_BTN_ID = 'shadcn-lang-toggle';

let toggleBtn = null;
let toggleInitialized = false;

function injectToggleCSS() {
  if (document.getElementById('shadcn-toggle-style')) return;
  const style = document.createElement('style');
  style.id = 'shadcn-toggle-style';
  style.textContent = `
    #shadcn-lang-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 6px;
      border: none; background: transparent;
      cursor: pointer; transition: all 0.15s; flex-shrink: 0;
      color: var(--foreground, #18181b); opacity: 1;
    }
    #shadcn-lang-toggle svg { width: 16px; height: 16px; }
    #shadcn-lang-toggle:hover { background: var(--accent, #f4f4f5); }
  `;
  document.head.appendChild(style);
}

function findThemeToggle() {
  const allSpans = document.querySelectorAll('span.sr-only');
  for (const span of allSpans) {
    if (span.textContent === 'Toggle theme') {
      return span.closest('button');
    }
  }
  return null;
}

function ensureToggleInNav() {
  if (!toggleBtn) return;
  const themeBtn = findThemeToggle();
  if (!themeBtn || !themeBtn.parentElement) return;
  // 如果已经是 themeBtn 的前一个兄弟 → 无需操作
  if (themeBtn.previousElementSibling === toggleBtn) return;
  // 否则插入到 themeBtn 前面
  themeBtn.parentElement.insertBefore(toggleBtn, themeBtn);
}

function initToggleButton() {
  if (toggleInitialized) return;
  toggleInitialized = true;
  injectToggleCSS();

  // 创建按钮（仅一次）
  toggleBtn = document.createElement('button');
  toggleBtn.id = TOGGLE_BTN_ID;
  toggleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>
  </svg>`;
  toggleBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (currentTargetLang === 'zh-CN') {
      resetTranslation();
      updateToggleButton(false);
      await chrome.storage.sync.set({ shadcn_translator_config: { enabled: false, targetLang: 'zh-CN' } });
    } else {
      await translatePageSingle('zh-CN');
      updateToggleButton(true);
      await chrome.storage.sync.set({ shadcn_translator_config: { enabled: true, targetLang: 'zh-CN' } });
    }
  });

  // 恢复上次的翻译状态
  chrome.storage.sync.get('shadcn_translator_config').then(result => {
    const config = result.shadcn_translator_config || {};
    if (config.enabled && config.targetLang === 'zh-CN') updateToggleButton(true);
  }).catch(() => {});

  // 立即尝试插入
  ensureToggleInNav();

  // 持久 DOM 监听：导航栏重渲染时自动恢复
  const navObserver = new MutationObserver(ensureToggleInNav);
  navObserver.observe(document.body, { childList: true, subtree: true });

  // 兜底：头 30 秒每 500ms 检查一次（应对极慢渲染或 MutationObserver 漏触发）
  let fallback = 0;
  const fallbackTimer = setInterval(() => {
    if (++fallback > 60) { clearInterval(fallbackTimer); return; }
    ensureToggleInNav();
  }, 500);
}

function updateToggleButton(isActive) {
  if (!toggleBtn) return;
  toggleBtn.classList.toggle('active', isActive);
  toggleBtn.title = isActive ? '切换为英文' : '切换为中文';
}

// ─── 自动翻译（安装后自动执行） ──────────────────────

async function autoTranslateOnLoad() {
  // 等待页面稳定后自动翻译
  await new Promise(r => setTimeout(r, 100));
  await translatePageSingle('zh-CN');
  updateToggleButton(true);
  try {
    await chrome.storage.sync.set({ shadcn_translator_config: { enabled: true, targetLang: 'zh-CN' } });
  } catch (e) { /* ignore */ }
}

// ─── 启动 ────────────────────────────────────────────

try {
  const boot = () => { setupNavigationObserver(); initToggleButton(); autoTranslateOnLoad(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
} catch (e) {
  console.error('[shadcn-translator] 启动失败:', e);
}
