import { DEFAULT_SETTINGS, ENGINES, LANGS, isPdfUrl } from './lib/engines.js';

const CURRENT = 'xk-current';
const $ = function (id) { return document.getElementById(id); };
let tab = null;
let settings = Object.assign({}, DEFAULT_SETTINGS);
let isPdf = false;

init();

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs && tabs[0] ? tabs[0] : null;
  isPdf = isPdfUrl(tab && tab.url);
  const s = await chrome.storage.sync.get(null);
  settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
  buildSelects();
  syncControls();
  renderKind();
  renderLast();
  $('enabled').addEventListener('change', function () { chrome.storage.sync.set({ enabled: $('enabled').checked }); });
  $('webEnabled').addEventListener('change', function () {
    chrome.storage.sync.set({ webEnabled: $('webEnabled').checked });
    if (!isPdf) renderKind();
  });
  $('mode').addEventListener('change', function () { chrome.storage.sync.set({ mode: $('mode').value }); });
  $('engine').addEventListener('change', function () { chrome.storage.sync.set({ engine: $('engine').value }); });
  $('target').addEventListener('change', function () { chrome.storage.sync.set({ target: $('target').value }); });
  $('watch').addEventListener('change', function () { chrome.storage.sync.set({ watchClipboard: $('watch').checked }); });
  $('opts').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('reader').addEventListener('click', function () {
    var url = tab && tab.url ? tab.url : '';
    var openable = /^https?:/i.test(url);
    chrome.runtime.sendMessage({ type: 'xk-open-reader', url: openable ? url : '' }).then(function () { window.close(); });
  });
  $('panel').addEventListener('click', async function () {
    const res = await chrome.runtime.sendMessage({ type: 'xk-open-panel', windowId: tab ? tab.windowId : undefined });
    if (res && res.ok) window.close();
    else $('tip').textContent = '侧栏打开失败，请在页面上点扩展图标后重试。';
  });
  try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
}

function buildSelects() {
  ENGINES.forEach(function (e) {
    const o = document.createElement('option'); o.value = e.id; o.textContent = e.label;
    $('engine').appendChild(o);
  });
  LANGS.forEach(function (l) {
    const o = document.createElement('option'); o.value = l.id; o.textContent = l.label;
    $('target').appendChild(o);
  });
}

function syncControls() {
  $('enabled').checked = !!settings.enabled;
  $('webEnabled').checked = settings.webEnabled !== false;
  $('mode').value = settings.mode;
  $('engine').value = settings.engine;
  $('target').value = settings.target;
  $('watch').checked = !!settings.watchClipboard;
}

function renderKind() {
  if (!tab) { $('pageKind').textContent = '未知页面'; return; }
  if (isPdf) {
    $('pageKind').textContent = 'PDF（Chrome 阅读器）';
    $('tip').textContent = '想要真正的「框选即译」：点「打开 PDF 阅读器」用它重新打开本页；不想切换阅读器就选中后 Ctrl+C 或右键翻译。';
    $('panel').textContent = '打开侧栏';
    $('reader').textContent = '用阅读器打开此 PDF';
  } else if ((tab.url || '').indexOf('chrome://') === 0 || (tab.url || '').indexOf('chrome-extension://') === 0) {
    $('pageKind').textContent = '系统页面';
    $('tip').textContent = '浏览器的内部页面不允许插件运行，换普通网页或 PDF 试试。';
  } else {
    $('pageKind').textContent = '网页';
    if (settings.webEnabled === false) {
      $('tip').textContent = '网页自动翻译已关闭：现在只有内置 PDF 阅读器会框选翻译。';
    } else {
      $('tip').textContent = '框选文字即可翻译；按住 Ctrl 选择适合只想选中不翻译的时候。';
    }
    $('reader').textContent = '打开 PDF 阅读器';
  }
}

async function renderLast() {
  const ses = await chrome.storage.session.get(CURRENT);
  const cur = ses[CURRENT];
  const box = $('last');
  box.textContent = '';
  if (!cur) {
    box.innerHTML = '<div class="q">最近一次翻译</div><div class="a">还没有译文</div>';
    return;
  }
  const q = document.createElement('div'); q.className = 'q'; q.textContent = '最近一次翻译';
  const a = document.createElement('div'); a.className = 'a';
  const res = cur.result || {};
  a.textContent = res.ok ? res.text : (res.error || '失败');
  a.addEventListener('click', function () { chrome.runtime.sendMessage({ type: 'xk-open-panel', windowId: tab ? tab.windowId : undefined }); });
  box.appendChild(q); box.appendChild(a);
}
