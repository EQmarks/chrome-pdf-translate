import { translate, DEFAULT_SETTINGS, isPdfUrl, ENGINES, LANGS } from './lib/engines.js';

const MENU_SELECT = 'xk-translate-selection';
const MENU_CLIP = 'xk-translate-clipboard';
const MENU_READER_PAGE = 'xk-reader-page';
const MENU_READER_LINK = 'xk-reader-link';
const CURRENT_KEY = 'xk-current';
const HISTORY_KEY = 'xk-history';
const HISTORY_MAX = 30;

let lastClipText = '';

function getSettings() {
  return chrome.storage.sync.get(null).then(function (s) {
    return Object.assign({}, DEFAULT_SETTINGS, s || {});
  });
}

function normalise(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

async function initMenus() {
  try { await chrome.contextMenus.removeAll(); } catch (e) {}
  chrome.contextMenus.create({
    id: MENU_SELECT,
    title: '翻译选中文字「%s」',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: MENU_CLIP,
    title: '翻译剪贴板里的文字',
    contexts: ['page', 'link', 'image', 'editable']
  });
  chrome.contextMenus.create({
    id: MENU_READER_PAGE,
    title: '用「框选译」阅读器打开（框选即译）',
    contexts: ['page'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf']
  });
  chrome.contextMenus.create({
    id: MENU_READER_LINK,
    title: '用「框选译」阅读器打开这个 PDF',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf']
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  initMenus();
  syncWatcher();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(function () {
  initMenus();
  syncWatcher();
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync') return;
  if (changes.watchClipboard || changes.watchAllTabs) syncWatcher();
});

function activeTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
    return tabs && tabs[0] ? tabs[0] : null;
  });
}

async function pushCurrent(text, result, tab) {
  var payload = {
    text: text,
    result: result,
    url: tab && tab.url ? tab.url : '',
    ts: Date.now()
  };
  try { await chrome.storage.session.set({ [CURRENT_KEY]: payload }); } catch (e) {}
  try {
    var hist = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
    hist.unshift(payload);
    if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
    await chrome.storage.local.set({ [HISTORY_KEY]: hist });
  } catch (e) {}
  try {
    await chrome.action.setBadgeText({ text: '译' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    await chrome.action.setTitle({ title: '框选译 · 新译文已就绪，点开查看' });
  } catch (e) {}
}

async function translateAndPush(text, tab) {
  var s = await getSettings();
  var result = await translate({ text: text, engine: s.engine, target: s.target });
  await pushCurrent(text, result, tab);
  return result;
}

async function showCardInTab(tab, text, frameId) {
  var opts = frameId != null && frameId >= 0 ? { frameId: frameId } : {};
  try {
    var res = await chrome.tabs.sendMessage(tab.id, { type: 'xk-show-card', text: text }, opts);
    if (res && res.ok) return true;
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({
      target: frameId != null && frameId >= 0 ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id },
      files: ['content/content.js']
    });
    var res2 = await chrome.tabs.sendMessage(tab.id, { type: 'xk-show-card', text: text }, opts);
    return !!(res2 && res2.ok);
  } catch (e) {
    return false;
  }
}

async function openPanel(windowId) {
  try {
    if (windowId != null) await chrome.sidePanel.open({ windowId: windowId });
    else {
      var tab = await activeTab();
      if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function deliver(text, tab, frameId) {
  text = normalise(text);
  if (!text) return;
  var s = await getSettings();
  var pdf = isPdfUrl(tab && tab.url);
  if (!pdf) {
    var ok = await showCardInTab(tab, text, frameId);
    if (ok) return;
  } else {
    await openPanel(tab.windowId);
  }
  await translateAndPush(text, tab);
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_SELECT) {
    var sel = normalise(info.selectionText || '');
    if (sel) {
      deliver(sel, tab, info.frameId);
    } else {
      readClipboard().then(function (clip) {
        if (clip) deliver(clip, tab, info.frameId);
        else notifyBadge('没读到文字');
      });
    }
    return;
  }
  if (info.menuItemId === MENU_READER_PAGE || info.menuItemId === MENU_READER_LINK) {
    var target = info.linkUrl || (tab && tab.url) || '';
    if (!target) return;
    chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?file=' + encodeURIComponent(target)) });
    return;
  }
  if (info.menuItemId === MENU_CLIP) {
    readClipboard().then(function (clip) {
      if (clip) deliver(clip, tab, info.frameId);
      else notifyBadge('剪贴板是空的');
    });
    return;
  }
});

function notifyBadge(text) {
  chrome.action.setBadgeText({ text: '?' });
  chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  chrome.action.setTitle({ title: '框选译 · ' + text });
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try { if (await chrome.offscreen.hasDocument()) return true; } catch (e) {}
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: '在 PDF 阅读时监听复制动作，自动翻译选中的文字'
    });
  } catch (e) {}
  return true;
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage(msg).catch(function () { return null; });
}

async function readClipboard() {
  await ensureOffscreen();
  try {
    var r = await sendToOffscreen({ type: 'xk-clipboard-read' });
    return normalise((r && r.text) || '');
  } catch (e) {
    return '';
  }
}

async function syncWatcher() {
  var s = await getSettings();
  if (!s.watchClipboard) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
    return;
  }
  await ensureOffscreen();
  var tab = await activeTab();
  sendToOffscreen({
    type: 'xk-watch-config',
    all: !!s.watchAllTabs,
    activeIsPdf: isPdfUrl(tab && tab.url)
  });
}

async function onClipboardChanged(text) {
  var s = await getSettings();
  if (!s.watchClipboard) return;
  var t = normalise(text);
  if (!t || t.length < Math.max(2, s.minLength || 2)) return;
  if (t === lastClipText) return;
  lastClipText = t;
  var tab = await activeTab();
  if (!s.watchAllTabs && !isPdfUrl(tab && tab.url)) return;
  await translateAndPush(t, tab);
}

chrome.tabs.onZoomChange.addListener(function (info) {
  if (info.tabId == null || info.tabId < 0) return;
  chrome.tabs.sendMessage(info.tabId, { type: 'xk-page-zoom', zoom: info.newZoomFactor }).catch(function () {});
});

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId).then(function (tab) {
    sendToOffscreen({ type: 'xk-tab-state', activeIsPdf: isPdfUrl(tab && tab.url) });
  }).catch(function () {});
});

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (!tab || !tab.active) return;
  if (info.url || info.status === 'complete' || info.status === 'loading') {
    sendToOffscreen({ type: 'xk-tab-state', activeIsPdf: isPdfUrl(tab.url) });
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === 'xk-translate') {
    getSettings().then(function (s) {
      return translate({ text: msg.text, engine: msg.engine || s.engine, target: msg.target || s.target });
    }).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'xk-clipboard-changed') {
    onClipboardChanged(msg.text).catch(function () {});
    return;
  }
  if (msg.type === 'xk-get-settings') {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === 'xk-open-panel') {
    openPanel(msg.windowId).then(function (ok) {
      sendResponse({ ok: ok });
    });
    return true;
  }
  if (msg.type === 'xk-get-zoom') {
    var tab = sender && sender.tab;
    if (!tab || tab.id == null) { sendResponse({ zoom: 1 }); return true; }
    chrome.tabs.getZoom(tab.id).then(function (z) { sendResponse({ zoom: z }); }, function () { sendResponse({ zoom: 1 }); });
    return true;
  }
  if (msg.type === 'xk-open-reader') {
    var targetUrl = msg.url || '';
    var page = targetUrl ? 'reader.html?file=' + encodeURIComponent(targetUrl) : 'reader.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(page) });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'xk-open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'xk-clear-badge') {
    try {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: '框选译' });
    } catch (e) {}
    return;
  }
  if (msg.type === 'xk-translate-clipboard') {
    readClipboard().then(function (clip) {
      if (!clip) { notifyBadge('剪贴板是空的'); sendResponse({ ok: false, error: '剪贴板是空的' }); return; }
      deliver(clip, sender && sender.tab).then(function () { sendResponse({ ok: true }); }, function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    });
    return true;
  }
  if (msg.type === 'xk-read-clipboard') {
    readClipboard().then(function (text) { sendResponse({ text: text }); });
    return true;
  }
  if (msg.type === 'xk-retry') {
    translateAndPush(msg.text, sender && sender.tab).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }
});

// 首次安装/更新后清理旧菜单残留
setTimeout(function () { syncWatcher(); }, 2000);
