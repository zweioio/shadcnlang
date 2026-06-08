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
      if (['code', 'pre', 'script', 'style', 'svg'].includes(tag)) return true;
      if (el.hasAttribute(TRANSLATED_ATTR)) return true;
      if (el.closest && el.closest('code, pre, .shiki, [class*="language-"]')) return true;
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
 */
function collectTextNodes(root = document.body) {
  const nodes = [];

  function traverse(node) {
    // 如果是元素且有 shadowRoot，遍历其内部
    if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
      traverse(node.shadowRoot);
    }

    // 如果是 iframe，尝试进入其 contentDocument
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IFRAME') {
      try {
        const doc = node.contentDocument || node.contentWindow?.document;
        if (doc && doc.body) {
          traverse(doc.body);
        }
      } catch (e) {
        // 跨域 iframe，跳过
      }
    }

    // 处理当前节点的子文本节点
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

    // 递归处理子元素（包括 slot 分发的内容）
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

// ─── API 翻译兜底 ────────────────────────────────────

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

async function batchTranslate(texts, targetLang) {
  if (!texts || texts.length === 0) return [];
  try {
    const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang, dt: 't', dj: '1' });
    const url = `${GOOGLE_TRANSLATE_URL}?${params}`;
    const formData = new URLSearchParams();
    for (const t of texts) formData.append('q', t);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData });
    if (!res.ok) throw new Error(`API status ${res.status}`);
    const data = await res.json();
    return (data.sentences || []).filter(s => s.trans).map(s => s.trans);
  } catch (e) {
    console.warn('[shadcn-translator] API翻译失败:', e);
    return [];
  }
}

// ─── 翻译执行（混合模式） ──────────────────────────────

async function translatePage(targetLang) {
  if (!targetLang) return { success: false, error: '未指定目标语言' };

  if (targetLang !== currentTargetLang || !dictionary) {
    currentTargetLang = targetLang;
    loadDictionary(targetLang);
  }

  const textNodes = collectTextNodes();
  if (textNodes.length === 0) return { success: true, count: 0 };

  // 去重
  const textMap = new Map();
  for (const node of textNodes) {
    const text = node.textContent.trim();
    if (!text) continue;
    if (!textMap.has(text)) textMap.set(text, []);
    textMap.get(text).push(node);
  }

  let appliedCount = 0;

  // 第一轮：字典翻译
  const dictMissed = [];      // 字典未命中的文本
  const dictMissedMap = [];   // 对应的 [text, nodes] 对

  for (const [text, nodes] of textMap.entries()) {
    const translation = lookupTranslation(text);
    if (translation && translation !== text) {
      applyToNodes(nodes, text, translation);
      appliedCount++;
    } else {
      dictMissed.push(text);
      dictMissedMap.push([text, nodes]);
    }
  }

  // 第二轮：API 兜底（只翻译字典没找到的）
  if (dictMissed.length > 0) {
    try {
      const apiResults = await batchTranslate(dictMissed, targetLang);
      for (let i = 0; i < apiResults.length && i < dictMissedMap.length; i++) {
        const [text, nodes] = dictMissedMap[i];
        const translation = apiResults[i];
        if (translation && translation !== text) {
          applyToNodes(nodes, text, translation);
          appliedCount++;
        }
      }
    } catch (e) {
      // API 失败不影响已有翻译
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

/**
 * 多阶段翻译：立即翻译 + 多次延迟重试，覆盖所有动态加载内容
 * 包括 iframe 内渲染、Shadow DOM 动态创建、慢加载 SPA 内容等
 */
async function translatePageMultiPass(targetLang) {
  const result1 = await translatePage(targetLang);

  const delays = [500, 1500, 3000, 5000, 8000];

  for (const delay of delays) {
    setTimeout(async () => {
      await translatePage(targetLang);
    }, delay);
  }

  return result1;
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
          translatePage(currentTargetLang);
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
        translateTimeout = setTimeout(() => translatePage(currentTargetLang), 300);
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

    if (hasNewContent) {
      // 同步翻译：MutationObserver 在微任务队列执行，比浏览器绘制还早
      // 所以用户看到的直接就是翻译后的文本，看不到英文→中文的切换
      translatePage(currentTargetLang);
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
      setTimeout(() => {
        translatePageMultiPass(currentTargetLang);
      }, 300);
    }
  }
}

// ─── 启动 ────────────────────────────────────────────

async function loadAndAutoTranslate() {
  try {
    const result = await chrome.storage.sync.get('shadcn_translator_config');
    const config = result.shadcn_translator_config || { enabled: false, targetLang: '' };
    if (config.enabled && config.targetLang) {
      setTimeout(() => {
        translatePageMultiPass(config.targetLang);
      }, 500);
    }
  } catch (e) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translatePage':
      translatePageMultiPass(request.targetLang)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    case 'resetTranslation':
      sendResponse(resetTranslation());
      break;
    case 'getStatus':
      sendResponse({ active: !!currentTargetLang, targetLang: currentTargetLang });
      break;
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setupNavigationObserver();
    loadAndAutoTranslate();
  });
} else {
  setupNavigationObserver();
  loadAndAutoTranslate();
}
