// shadcn 翻译器 - 系统弹窗
const STORAGE_KEY = 'shadcn_translator_config';
const SUPPORTED_LANGUAGES = { 'zh-CN': '简体中文' };

// DOM 引用
const langTrigger = document.getElementById('langTrigger');
const langValue = document.getElementById('langValue');
const langMenu = document.getElementById('langMenu');
const translateBtn = document.getElementById('translateBtn');
const autoBtn = document.getElementById('autoBtn');
const stopBtn = document.getElementById('stopBtn');
const resetInline = document.getElementById('resetInline');
const statusBar = document.getElementById('statusBar');

// ─── 配置 ───

async function loadConfig() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { enabled: false, targetLang: '' };
}
async function saveConfig(config) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: config });
}

// ─── 与内容脚本通信 ───

async function sendToContent(action, data = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action, ...data });
    return res;
  } catch { return null; }
}

// ─── 下拉框 ───

const langOptions = Object.entries(SUPPORTED_LANGUAGES).map(([v, l]) => ({ value: v, label: l }));

langOptions.forEach(opt => {
  const el = document.createElement('div');
  el.className = 'select-option';
  el.dataset.value = opt.value;
  el.textContent = opt.label;
  el.role = 'option';
  langMenu.appendChild(el);
});

let currentLang = '';

function updateLangDisplay(value) {
  const opt = langOptions.find(o => o.value === value);
  langValue.textContent = opt ? opt.label : '选择语言...';
  langValue.classList.toggle('placeholder', !value);
  langMenu.querySelectorAll('.select-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === value);
  });
}

function getSelectedLang() {
  const sel = langMenu.querySelector('.select-option.selected');
  return sel ? sel.dataset.value : '';
}

function closeMenu() {
  langMenu.classList.remove('open');
  langTrigger.classList.remove('open');
  langTrigger.setAttribute('aria-expanded', 'false');
}

langTrigger.addEventListener('click', () => {
  const isOpen = langMenu.classList.contains('open');
  if (isOpen) closeMenu();
  else {
    langMenu.classList.add('open');
    langTrigger.classList.add('open');
    langTrigger.setAttribute('aria-expanded', 'true');
  }
});

langMenu.querySelectorAll('.select-option').forEach(el => {
  el.addEventListener('click', () => {
    const value = el.dataset.value;
    updateLangDisplay(value);
    closeMenu();
    saveConfig({ targetLang: value });
  });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.select-container')) closeMenu();
});

// ─── 恢复翻译状态 ───

function resetUIState() {
  autoBtn.classList.remove('active');
  autoBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
    自动`;
}

// ─── 翻译 ───

translateBtn.addEventListener('click', async () => {
  const lang = getSelectedLang();
  if (!lang) { showStatus('请先选择语言', 'error'); return; }
  showStatus('正在翻译...', 'loading');
  const res = await sendToContent('translatePage', { targetLang: lang });
  if (res?.success) {
    showStatus('翻译完成', 'success');
    saveConfig({ enabled: true, targetLang: lang });
  } else {
    showStatus('翻译失败', 'error');
  }
});

// ─── 自动 ───

autoBtn.addEventListener('click', async () => {
  const lang = getSelectedLang();
  if (!lang) { showStatus('请先选择语言', 'error'); return; }

  const isActive = autoBtn.classList.contains('active');
  if (isActive) {
    await saveConfig({ enabled: false, targetLang: lang });
    resetUIState();
    showStatus('自动翻译已关闭', '');
    await sendToContent('resetTranslation');
  } else {
    await saveConfig({ enabled: true, targetLang: lang });
    autoBtn.classList.add('active');
    autoBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      ✓ 自动`;
    showStatus('自动翻译已开启', 'success');
    await sendToContent('translatePage', { targetLang: lang });
  }
});

// ─── 关闭翻译 ───

stopBtn.addEventListener('click', async () => {
  const res = await sendToContent('resetTranslation');
  if (res?.success) {
    resetUIState();
    showStatus('翻译已关闭', '');
    await saveConfig({ enabled: false, targetLang: getSelectedLang() });
  }
});

// ─── 恢复原文 ───

resetInline.addEventListener('click', async () => {
  showStatus('正在恢复...', 'loading');
  const res = await sendToContent('resetTranslation');
  if (res?.success) {
    resetUIState();
    showStatus('已恢复原文', '');
    await saveConfig({ enabled: false, targetLang: getSelectedLang() });
  }
});

// ─── 状态提示 ───

function showStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
  if (type === 'success') setTimeout(() => { statusBar.textContent = ''; statusBar.className = 'status-bar'; }, 3000);
  if (type === 'error') setTimeout(() => { if (statusBar.textContent === msg) { statusBar.textContent = ''; statusBar.className = 'status-bar'; } }, 4000);
  if (type === 'loading') setTimeout(() => { if (statusBar.textContent === msg) { statusBar.textContent = ''; statusBar.className = 'status-bar'; } }, 10000);
}

// ─── 初始化 ───

async function init() {
  const config = await loadConfig();
  updateLangDisplay(config.targetLang || '');
  if (config.enabled && config.targetLang) {
    autoBtn.classList.add('active');
    autoBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      ✓ 自动`;
  }
}

init();
