import { DEFAULT_SETTINGS, ENGINES, LANGS, engineLabel } from './lib/engines.js';

const $ = function (id) { return document.getElementById(id); };
let settings = Object.assign({}, DEFAULT_SETTINGS);

init();

async function init() {
  const s = await chrome.storage.sync.get(null);
  settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
  ENGINES.forEach(function (e) {
    const o = document.createElement('option'); o.value = e.id; o.textContent = e.label;
    $('engine').appendChild(o);
  });
  LANGS.forEach(function (l) {
    const o = document.createElement('option'); o.value = l.id; o.textContent = l.label;
    $('target').appendChild(o);
  });
  sync();
  bind();
  if (location.search.indexOf('welcome=1') !== -1) {
    $('testout').hidden = false;
    $('testout').textContent = '装好了 👍 先点「翻译一句试试」确认网络能通，然后去开 PDF 读一读。';
  }
}

function sync() {
  $('enabled').checked = !!settings.enabled;
  $('webEnabled').checked = settings.webEnabled !== false;
  $('mode').value = settings.mode;
  $('target').value = settings.target;
  $('engine').value = settings.engine;
  $('watch').checked = !!settings.watchClipboard;
  $('watchAll').checked = !!settings.watchAllTabs;
  const e = ENGINES.find(function (x) { return x.id === settings.engine; });
  $('engineNote').textContent = e ? e.note : '';
}

function bind() {
  $('enabled').addEventListener('change', function () { save({ enabled: $('enabled').checked }); });
  $('webEnabled').addEventListener('change', function () { save({ webEnabled: $('webEnabled').checked }); });
  $('mode').addEventListener('change', function () { save({ mode: $('mode').value }); });
  $('target').addEventListener('change', function () { save({ target: $('target').value }); });
  $('engine').addEventListener('change', function () { save({ engine: $('engine').value }); sync(); });
  $('watch').addEventListener('change', function () { save({ watchClipboard: $('watch').checked }); });
  $('watchAll').addEventListener('change', function () { save({ watchAllTabs: $('watchAll').checked }); });
  $('testBtn').addEventListener('click', test);
  $('openPanelBtn').addEventListener('click', async function () {
    const res = await chrome.runtime.sendMessage({ type: 'xk-open-panel' });
    $('testout').hidden = false;
    $('testout').textContent = res && res.ok ? '侧栏已打开，去 PDF 里试试。' : '侧栏打开失败：需要先切到某个网页/PDF 标签，再点这个按钮。';
  });
  $('resetBtn').addEventListener('click', function () {
    chrome.storage.sync.set(DEFAULT_SETTINGS);
    settings = Object.assign({}, DEFAULT_SETTINGS);
    sync();
  });
}

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
}

async function test() {
  const out = $('testout');
  out.hidden = false;
  out.textContent = '测试中…';
  const t0 = performance.now();
  const res = await chrome.runtime.sendMessage({
    type: 'xk-translate',
    text: 'The finite element method is widely used in structural analysis.',
    engine: settings.engine,
    target: settings.target
  });
  const ms = Math.round(performance.now() - t0);
  if (!res || !res.ok) {
    out.textContent = '失败：' + ((res && res.error) || '无响应') + '\n可以换一个引擎再试（Bing / MyMemory / Google）。';
    return;
  }
  out.textContent = '引擎：' + engineLabel(res.engine) + '（' + ms + ' ms）' + (res.fallback ? ' · 已自动切换' : '') + '\n译文：' + res.text;
}
