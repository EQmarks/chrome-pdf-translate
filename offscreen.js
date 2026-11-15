(function () {
  'use strict';
  var pad = document.getElementById('pad');
  var last = '';
  var allowAll = false;
  var activeIsPdf = true;
  var started = false;
  var busy = false;

  function readClipboard() {
    try {
      pad.value = '';
      pad.focus();
      pad.select();
      var ok = document.execCommand('paste');
      var text = pad.value || '';
      pad.value = '';
      if (ok) return Promise.resolve(text);
    } catch (e) {}
    try {
      return navigator.clipboard.readText().catch(function () { return ''; });
    } catch (e) {
      return Promise.resolve('');
    }
  }

  function tick() {
    if (!started || busy) return;
    busy = true;
    Promise.resolve(readClipboard()).then(function (text) {
      busy = false;
      if (!text || text === last) return;
      last = text;
      if (!allowAll && !activeIsPdf) return;
      try {
        chrome.runtime.sendMessage({ type: 'xk-clipboard-changed', text: text });
      } catch (e) {}
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'xk-watch-config') {
      allowAll = !!msg.all;
      if (typeof msg.activeIsPdf === 'boolean') activeIsPdf = msg.activeIsPdf;
      if (!started) {
        started = true;
        last = readClipboard();
        setInterval(tick, 900);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'xk-tab-state') {
      if (typeof msg.activeIsPdf === 'boolean') activeIsPdf = msg.activeIsPdf;
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'xk-clipboard-read') {
      sendResponse({ text: readClipboard() });
      return true;
    }
  });
})();