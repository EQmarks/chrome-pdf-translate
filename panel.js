import { DEFAULT_SETTINGS, ENGINES, LANGS, langById, engineLabel } from './lib/engines.js';

const CURRENT = 'xk-current';
const HISTORY = 'xk-history';
const $ = function (id) { return document.getElementById(id); };
let settings = Object.assign({}, DEFAULT_SETTINGS);
let current = null;

init();

async function init() {
  const stored = await chrome.storage.sync.get(null);
  settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
  buildSelects();
  bindUI();
  const ses = await chrome.storage.session.get(CURRENT);
  current = ses[CURRENT] || null;
  renderCurrent(current);
  const local = await chrome.storage.local.get(HISTORY);
  renderHistory(local[HISTORY] || []);
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'session' && changes[CURRENT]) {
      current = changes[CURRENT].newValue || null;
      renderCurrent(current);
    }
    if (area === 'local' && changes[HISTORY]) {
      renderHistory(changes[HISTORY].newValue || []);
    }
    if (area === 'sync') {
      Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
      syncControls();
    }
  });
  try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
}

function buildSelects() {
  const eng = $('engine');
  ENGINES.forEach(function (e) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    eng.appendChild(o);
  });
  const tgt = $('target');
  LANGS.forEach(function (l) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.label;
    tgt.appendChild(o);
  });
  syncControls();
}

function syncControls() {
  $('engine').value = settings.engine;
  $('target').value = settings.target;
  $('watch').checked = !!settings.watchClipboard;
  const e = ENGINES.find(function (x) { return x.id === settings.engine; });
  $('engine-note').textContent = e ? e.note : '';
}

function bindUI() {
  $('engine').addEventListener('change', function () {
    chrome.storage.sync.set({ engine: $('engine').value });
  });
  $('target').addEventListener('change', function () {
    chrome.storage.sync.set({ target: $('target').value });
  });
  $('watch').addEventListener('change', function () {
    chrome.storage.sync.set({ watchClipboard: $('watch').checked });
  });
  $('opts').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('clear').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.storage.local.set({ [HISTORY]: [] });
    chrome.storage.session.remove(CURRENT);
  });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function copyText(text, btn) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(function () {
    btn.textContent = '已复制';
    setTimeout(function () { btn.textContent = '复制'; }, 1200);
  }, function () {
    btn.textContent = '复制失败';
    setTimeout(function () { btn.textContent = '复制'; }, 1200);
  });
}

function renderCurrent(cur) {
  const box = $('current');
  box.textContent = '';
  if (!cur) {
    box.className = 'card empty';
    box.textContent = '还没有译文。在 PDF 里选中文字按 Ctrl+C，或右键「翻译选中文字」。';
    return;
  }
  box.className = 'card';
  const res = cur.result || {};
  const meta = el('div', 'meta');
  const from = res.from ? res.from.toUpperCase() : '原文';
  meta.appendChild(el('span', 'pill', from + ' → ' + (res.toName || langById(settings.target).label)));
  if (res.engineLabel) meta.appendChild(el('span', 'pill', res.engineLabel));
  const t = new Date(cur.ts || Date.now());
  meta.appendChild(el('span', null, t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
  box.appendChild(meta);

  if (res.ok) {
    box.appendChild(el('div', 'out', res.text || ''));
    if (cur.text && cur.text !== res.text) box.appendChild(el('div', 'src', cur.text));
  } else {
    box.appendChild(el('div', 'out err', res.error || '翻译失败'));
    if (cur.text) box.appendChild(el('div', 'src', cur.text));
  }

  const acts = el('div', 'acts');
  const cp = el('button', 'act', '复制译文');
  cp.addEventListener('click', function () { copyText(res.text || '', cp); });
  acts.appendChild(cp);
  const sp = el('button', 'act', '朗读');
  sp.addEventListener('click', function () {
    if (!res.text || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(res.text);
    const to = res.to || settings.target;
    u.lang = to.indexOf('zh') === 0 ? 'zh-CN' : to === 'en' ? 'en-US' : to === 'ja' ? 'ja-JP' : 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
  acts.appendChild(sp);
  const rt = el('button', 'act', '换个引擎');
  rt.addEventListener('click', function () { retranslate(cur.text); });
  acts.appendChild(rt);
  box.appendChild(acts);
}

async function retranslate(text) {
  if (!text) return;
  const order = ['bing', 'mymemory', 'google'];
  const curEngine = (current && current.result && current.result.engine) || settings.engine;
  const idx = order.indexOf(curEngine);
  const next = order[(idx + 1) % order.length];
  const res = await chrome.runtime.sendMessage({ type: 'xk-translate', text: text, engine: next, target: settings.target });
  const payload = { text: text, result: res, url: '', ts: Date.now() };
  await chrome.storage.session.set({ [CURRENT]: payload });
  const hist = (await chrome.storage.local.get(HISTORY))[HISTORY] || [];
  hist.unshift(payload);
  await chrome.storage.local.set({ [HISTORY]: hist.slice(0, 30) });
}

function renderHistory(list) {
  const ul = $('history');
  ul.textContent = '';
  if (!list.length) {
    const li = el('li');
    li.appendChild(el('div', 'h-src', '暂无记录'));
    ul.appendChild(li);
    return;
  }
  list.forEach(function (item) {
    const li = el('li');
    const res = item.result || {};
    li.appendChild(el('div', 'h-out', res.ok ? res.text : res.error || '失败'));
    li.appendChild(el('div', 'h-src', item.text || ''));
    li.addEventListener('click', function () {
      if (res.ok) navigator.clipboard.writeText(res.text || '');
      chrome.storage.session.set({ [CURRENT]: item });
    });
    ul.appendChild(li);
  });
}
