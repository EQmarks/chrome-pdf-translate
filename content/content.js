(function () {
  'use strict';
  if (window.__xkSelectTranslateLoaded) return;
  window.__xkSelectTranslateLoaded = true;

  var HOST_ID = 'xk-select-translate-host';
  var DEFAULTS = {
    enabled: true,
    webEnabled: true,
    mode: 'auto',
    engine: 'bing',
    target: 'zh-Hans',
    minLength: 2,
    maxLength: 3000,
    theme: 'dark',
    fontSize: 'normal'
  };
  var settings = Object.assign({}, DEFAULTS);
  var host = null;
  var shadow = null;
  var card = null;
  var lastKey = '';
  var dragState = null;
  var hideTimer = null;
  var pinned = false;      // 固定模式：卡片停在原地，不跟随选区
  var pinnedPos = null;    // 固定时的坐标
  var holdPos = false;     // 取消固定后：保持当前位置，直到下一次新的框选
  var curPos = null;       // 卡片当前实际坐标（卡片会重建，必须单独记）
  var pageZoom = 1;        // 当前标签页的 Chrome 页面缩放
  var lastAnchor = null;   // 最近一次译文的锚点，缩放变化后用来重新定位
  // 内置 PDF 阅读器页面：<html data-xk-reader="1">
  var IS_READER = document.documentElement.hasAttribute('data-xk-reader');

  var CSS = [
    ':host{all:initial}',
    '.xk-card{--xk-fs:15px;--xk-fs-src:12px;position:absolute;box-sizing:border-box;max-width:420px;min-width:260px;max-height:60vh;overflow:hidden;display:flex;flex-direction:column;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08);font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;pointer-events:auto;opacity:0;transition:opacity .12s ease}',
    '.xk-card.xk-in{opacity:1}',
    '.xk-dark{background:#1e2430;color:#e8edf5;border:1px solid #333d4f}',
    '.xk-light{background:#ffffff;color:#1a2230;border:1px solid #dfe4ec}',
    '.xk-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;user-select:none;border-bottom:1px solid rgba(128,145,170,.22);flex:0 0 auto}',
    '.xk-lang{font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.xk-badge{font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(37,99,235,.18);color:#7aa2f7;white-space:nowrap}',
    '.xk-x{margin-left:auto;background:none;border:0;color:inherit;opacity:.55;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}',
    '.xk-x:hover{opacity:1}',
    '.xk-pin{margin-left:auto;background:rgba(128,145,170,.12);border:1px solid rgba(128,145,170,.3);color:inherit;font-size:11px;line-height:1.6;padding:1px 7px;border-radius:6px;cursor:pointer;white-space:nowrap}',
    '.xk-pin.xk-on{background:rgba(37,99,235,.35);border-color:#5b8ef7;color:#dce8ff}',
    '.xk-body{padding:10px 12px 6px;overflow:auto;flex:1 1 auto}',
    '.xk-card[data-size="small"]{--xk-fs:13px;--xk-fs-src:11px}',
    '.xk-card[data-size="large"]{--xk-fs:18px;--xk-fs-src:13px}',
    '.xk-card[data-size="xlarge"]{--xk-fs:21px;--xk-fs-src:14px}',
    '.xk-tr{font-size:var(--xk-fs);line-height:1.6;word-break:break-word;white-space:pre-wrap}',
    '.xk-src{margin-top:8px;font-size:var(--xk-fs-src);opacity:.62;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;border-left:2px solid rgba(128,145,170,.3);padding-left:8px}',
    '.xk-foot{display:flex;gap:6px;padding:6px 10px 9px;flex:0 0 auto}',
    '.xk-btn{border:1px solid rgba(128,145,170,.3);background:rgba(128,145,170,.12);color:inherit;font-size:12px;padding:3px 9px;border-radius:7px;cursor:pointer}',
    '.xk-btn:hover{background:rgba(128,145,170,.24)}',
    '.xk-err{color:#f08a8a;font-size:13px}',
    '.xk-tip{font-size:12px;opacity:.6;margin-top:6px}',
    '.xk-dots{display:inline-block;width:14px;text-align:left}',
    '.xk-dots:after{content:"...";animation:xkdot 1.1s steps(4,end) infinite}',
    '@keyframes xkdot{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}'
  ].join('\n');

  function applySettings(s) {
    if (!s) return;
    Object.keys(DEFAULTS).forEach(function (k) {
      if (s[k] !== undefined) settings[k] = s[k];
    });
  }

  try {
    chrome.storage.sync.get(null, function (s) {
      applySettings(s);
      if (!settings.enabled) closeCard();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      var s = {};
      Object.keys(changes).forEach(function (k) { s[k] = changes[k].newValue; });
      applySettings(s);
      if (!settings.enabled) closeCard();
      if (changes.theme && card) card.className = 'xk-card xk-' + (settings.theme === 'light' ? 'light' : 'dark');
      if (changes.fontSize && card) {
        card.setAttribute('data-size', settings.fontSize || 'normal');
        position(lastAnchor, false);
      }
    });
  } catch (e) {}

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function normalise(text) {
    if (!text) return '';
    return String(text).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;');
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    var parent = document.documentElement || document.body;
    if (parent) parent.appendChild(host);
  }

  function makeEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function baseCard() {
    ensureHost();
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = makeEl('div', 'xk-card xk-' + (settings.theme === 'light' ? 'light' : 'dark'));
    card.setAttribute('data-size', settings.fontSize || 'normal');
    if (pinned && pinnedPos) {
      card.style.left = pinnedPos.left + 'px';
      card.style.top = pinnedPos.top + 'px';
    }
    shadow.appendChild(card);
    applyCardZoom();
    return card;
  }

  // 拖动/固定时的位置约束：不要求整张卡都在屏内，只要左边留 80px、
  // 标题栏留 40px 能抓回来就行（原来必须整张卡完整可见，拖起来像被吸住）
  function clampPos(left, top, w, h, vw, vh) {
    var keepX = Math.min(80, w);
    var keepY = Math.min(40, h);
    var l = Math.min(Math.max(-(w - keepX), left), vw - keepX);
    var t = Math.min(Math.max(0, top), vh - keepY);
    return { left: l, top: t };
  }

  function setPos(left, top) {
    curPos = { left: Math.round(left), top: Math.round(top) };
    if (card) {
      card.style.left = curPos.left + 'px';
      card.style.top = curPos.top + 'px';
    }
  }

  function applyCardZoom() {
    if (!card) return;
    var z = pageZoom || 1;
    if (Math.abs(z - 1) < 0.001) {
      card.style.transform = '';
      card.style.transformOrigin = '';
    } else {
      card.style.transformOrigin = '0 0';
      card.style.transform = 'scale(' + (1 / z) + ')';
    }
  }

  function position(rect, asNew) {
    if (!card) return;
    if (rect) lastAnchor = rect;
    var margin = 10;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var z = pageZoom || 1;
    // 卡片按 1/缩放 反向缩放到 transform，视觉尺寸恒定；宽度按 CSS 视口换算
    var maxW = Math.min(420, Math.max(240, vw * z - margin * 2 * z));
    card.style.width = Math.round(maxW) + 'px';
    var box = card.getBoundingClientRect();
    var w = box.width || maxW;
    var h = box.height || 120;
    if (pinned && pinnedPos) {
      // 固定模式：只保证不跑出屏幕，不跟随选区
      // 固定就固定：只把左边拉回屏内、保证标题栏可见，不因内容变高而上下跳
      var fixed = clampPos(pinnedPos.left, pinnedPos.top, w, h, vw, vh);
      pinnedPos = { left: Math.round(fixed.left), top: Math.round(fixed.top) };
      card.style.left = pinnedPos.left + 'px';
      card.style.top = pinnedPos.top + 'px';
      if (asNew) requestAnimationFrame(function () { if (card) card.classList.add('xk-in'); });
      return;
    }
    if (!pinned && holdPos) {
      var cur = card.getBoundingClientRect();
      if (cur.width) {
        var keep = clampPos(cur.left, cur.top, w, h, vw, vh);
        card.style.left = Math.round(keep.left) + 'px';
        card.style.top = Math.round(keep.top) + 'px';
        if (asNew) requestAnimationFrame(function () { if (card) card.classList.add('xk-in'); });
        return;
      }
    }
    var anchor = rect || lastAnchor || { left: margin, top: 70, bottom: 70 };
    var left = Math.round(anchor.left);
    // 默认放选区上方：下方会挡住刚读到的下文
    var above = Math.round(anchor.top - h - 8);
    var top = above >= margin ? above : Math.round(anchor.bottom + 8);
    if (left < margin) left = margin;
    if (left + w > vw - margin) left = Math.max(margin, vw - w - margin);
    if (top + h > vh - margin) top = Math.max(margin, vh - h - margin);
    if (top < margin) top = margin;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    if (asNew) {
      requestAnimationFrame(function () {
        if (card) card.classList.add('xk-in');
      });
    }
  }

  function addHead(langText, badgeText) {
    var head = makeEl('div', 'xk-head');
    head.appendChild(makeEl('span', 'xk-lang', langText));
    if (badgeText) head.appendChild(makeEl('span', 'xk-badge', badgeText));
    var pin = makeEl('button', 'xk-pin', pinned ? '已固定' : '固定');
    pin.title = pinned ? '取消固定（恢复跟随选区）' : '固定在此处：新译文原地刷新，不跟随选区';
    if (pinned) pin.classList.add('xk-on');
    pin.addEventListener('click', function (e) {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned) {
        holdPos = false;
        var r = card.getBoundingClientRect();
        pinnedPos = { left: Math.round(r.left), top: Math.round(r.top) };
        pin.textContent = '已固定';
        pin.classList.add('xk-on');
      } else {
        // 取消固定只改「以后跟不跟随」，当前位置不动（原来会跳回选区）
        pinnedPos = null;
        holdPos = true;
        pin.textContent = '固定';
        pin.classList.remove('xk-on');
        pin.title = '固定在此处：新译文原地刷新，不跟随选区';
      }
    });
    head.appendChild(pin);

    var x = makeEl('button', 'xk-x', '×');
    x.title = '关闭（Esc）';
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCard();
    });
    head.appendChild(x);
    card.appendChild(head);
    head.addEventListener('mousedown', startDrag);
    return head;
  }

  function addFoot(original, result) {
    var foot = makeEl('div', 'xk-foot');
    var copy = makeEl('button', 'xk-btn', '复制');
    copy.addEventListener('click', function () {
      var value = result && result.text ? result.text : '';
      if (!value) return;
      try {
        navigator.clipboard.writeText(value).then(function () { copy.textContent = '已复制'; }, function () { copy.textContent = '复制失败'; });
      } catch (e) { copy.textContent = '复制失败'; }
      setTimeout(function () { copy.textContent = '复制'; }, 1200);
    });
    foot.appendChild(copy);

    var speak = makeEl('button', 'xk-btn', '朗读');
    speak.addEventListener('click', function () {
      if (!result || !result.text || !window.speechSynthesis) return;
      var u = new SpeechSynthesisUtterance(result.text);
      var to = result.to || '';
      u.lang = to.indexOf('zh') === 0 ? 'zh-CN' : to === 'en' ? 'en-US' : to === 'ja' ? 'ja-JP' : 'en-US';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
    foot.appendChild(speak);

    var retry = makeEl('button', 'xk-btn', '换个引擎');
    retry.addEventListener('click', function () {
      var order = ['bing', 'mymemory', 'google'];
      var cur = result && result.engine ? result.engine : settings.engine;
      var idx = order.indexOf(cur);
      var next = order[(idx + 1) % order.length];
      requestTranslate(original, getCardRect(), { engine: next });
    });
    foot.appendChild(retry);

    var sizeBtn = makeEl('button', 'xk-btn', '字号');
    sizeBtn.title = '译文/原文字号：标准 → 大 → 特大 → 小';
    sizeBtn.addEventListener('click', function () {
      var order = ['normal', 'large', 'xlarge', 'small'];
      var cur = settings.fontSize || 'normal';
      var next = order[(order.indexOf(cur) + 1) % order.length];
      settings.fontSize = next;
      try { chrome.storage.sync.set({ fontSize: next }); } catch (e) {}
      if (card) {
        card.setAttribute('data-size', next);
        position(lastAnchor, false);
      }
      sizeBtn.textContent = next === 'normal' ? '字号' : next === 'large' ? '字号+' : next === 'xlarge' ? '字号++' : '字号-';
    });
    foot.appendChild(sizeBtn);

    card.appendChild(foot);
  }

  function getCardRect() {
    if (!card) return null;
    var r = card.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.top };
  }

  function startDrag(e) {
    if (e.button !== 0) return;
    if (e.target && e.target.tagName === 'BUTTON') return;
    var r = card.getBoundingClientRect();
    dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    e.preventDefault();
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', endDrag, true);
  }

  function onDragMove(e) {
    if (!dragState || !card) return;
    if (!dragState.moved && Math.abs(e.clientX - dragState.sx) + Math.abs(e.clientY - dragState.sy) > 3) dragState.moved = true;
    if (!dragState.moved) return;
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var pos = clampPos(e.clientX - dragState.dx, e.clientY - dragState.dy, w, h, vw, vh);
    var left = Math.round(pos.left);
    var top = Math.round(pos.top);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    pinnedPos = { left: left, top: top };
  }

  function endDrag() {
    var moved = dragState && dragState.moved;
    dragState = null;
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', endDrag, true);
    if (moved && card && !pinned) {
      // 手动拖过 = 我要它在这儿：自动进入固定状态，按钮同步显示「已固定」
      pinned = true;
      var box = card.getBoundingClientRect();
      pinnedPos = { left: Math.round(box.left), top: Math.round(box.top) };
      var pinBtn = card.querySelector('.xk-pin');
      if (pinBtn) {
        pinBtn.textContent = '已固定';
        pinBtn.classList.add('xk-on');
        pinBtn.title = '取消固定（恢复跟随选区）';
      }
    }
  }

  function renderLoading(original, rect, opts) {
    baseCard();
    addHead('翻译中', opts && opts.engine ? '换引擎' : '');
    var body = makeEl('div', 'xk-body');
    var tr = makeEl('div', 'xk-tr');
    tr.appendChild(makeEl('span', 'xk-dots', ''));
    body.appendChild(tr);
    card.appendChild(body);
    position(rect, true);
    return card;
  }

  function renderResult(original, result, rect) {
    baseCard();
    var fromLabel = result.from ? result.from.toUpperCase() : '原文';
    var head = addHead(fromLabel + ' → ' + (result.toName || result.to), result.fallback ? result.engineLabel + '（已切换）' : result.engineLabel);
    var body = makeEl('div', 'xk-body');
    body.appendChild(makeEl('div', 'xk-tr', result.text));
    if (original && original !== result.text) {
      var src = makeEl('div', 'xk-src', original);
      body.appendChild(src);
    }
    card.appendChild(body);
    addFoot(original, result);
    position(rect, true);
  }

  function renderError(message, original, rect) {
    baseCard();
    addHead('翻译失败', '');
    var body = makeEl('div', 'xk-body');
    body.appendChild(makeEl('div', 'xk-err', message || '未知错误'));
    body.appendChild(makeEl('div', 'xk-tip', '可点「换个引擎」重试；或在设置里换引擎 / 检查网络。'));
    card.appendChild(body);
    var foot = makeEl('div', 'xk-foot');
    var retry = makeEl('button', 'xk-btn', '重试');
    retry.addEventListener('click', function () {
      closeCard();
      requestTranslate(original, rect);
    });
    foot.appendChild(retry);
    var open = makeEl('button', 'xk-btn', '设置');
    open.addEventListener('click', function () {
      try { chrome.runtime.sendMessage({ type: 'xk-open-options' }); } catch (e) {}
    });
    foot.appendChild(open);
    card.appendChild(foot);
    position(rect, true);
  }

  function requestTranslate(text, rect, opts) {
    opts = opts || {};
    holdPos = false;   // 新的一次框选：恢复「跟随选区」
    var engine = opts.engine;
    renderLoading(text, rect, opts);
    var payload = { type: 'xk-translate', text: text, target: settings.target };
    if (engine) payload.engine = engine;
    try {
      chrome.runtime.sendMessage(payload, function (res) {
        if (chrome.runtime.lastError) {
          renderError('扩展正在更新，刷新本页再试', text, rect);
          return;
        }
        if (!res) {
          renderError('没有拿到响应，刷新本页再试', text, rect);
          return;
        }
        if (!res.ok) {
          renderError(res.error || '翻译失败', text, rect);
          return;
        }
        renderResult(text, res, rect);
      });
    } catch (e) {
      renderError('扩展已更新，刷新本页再试', text, rect);
    }
  }

  function closeCard() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  function selectionRect(sel) {
    try {
      if (!sel || !sel.rangeCount) return null;
      var range = sel.getRangeAt(0);
      var r = range.getBoundingClientRect();
      if ((!r || (!r.width && !r.height))) {
        var rects = range.getClientRects();
        if (rects && rects.length) r = rects[rects.length - 1];
      }
      if (!r) return null;
      return { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
    } catch (e) {
      return null;
    }
  }

  function inCardPath(e) {
    if (!card) return false;
    if (!e.composedPath) return false;
    var path = e.composedPath();
    for (var i = 0; i < path.length; i++) {
      if (path[i] === host) return true;
    }
    return false;
  }

  function handleSelection(x, y, force) {
    var sel = window.getSelection();
    var text = sel ? normalise(sel.toString()) : '';
    if (!text) return;
    if (text.length < Math.max(1, settings.minLength || 1)) return;
    if (/^[\s\W]+$/.test(text)) return;
    var key = text.length + '|' + text.slice(0, 160);
    if (key === lastKey && card && card.style.display !== 'none' && card.parentNode) return;
    lastKey = key;
    var rect = selectionRect(sel);
    if (!rect) rect = { left: x, top: y, bottom: y, right: x, width: 0, height: 0 };
    if (text.length > (settings.maxLength || 3000)) text = text.slice(0, settings.maxLength || 3000);
    requestTranslate(text, rect, force ? { engine: force } : null);
  }

  document.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    if (!settings.enabled || settings.mode === 'off') return;
    // 网页开关关闭时，普通网页不自动翻译；阅读器始终可用
    if (!IS_READER && settings.webEnabled === false) return;
    if (inCardPath(e)) return;
    if (isEditable(e.target)) return;
    var needCtrl = settings.mode === 'ctrl';
    if (needCtrl && !(e.ctrlKey || e.altKey)) return;
    var x = e.clientX;
    var y = e.clientY;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { handleSelection(x, y, null); }, 320);
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (card && !inCardPath(e)) {
      // 用户开始新的选择，旧卡片先留着，避免闪烁
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && card) closeCard();
  }, true);

  window.addEventListener('blur', function () {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  });

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'xk-show-card') {
        var text = normalise(msg.text || '');
        if (!text) { sendResponse({ ok: false }); return true; }
        var sel = window.getSelection();
        var rect = selectionRect(sel) || { left: 60, top: 60, bottom: 60 };
        requestTranslate(text, rect);
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === 'xk-page-zoom') {
        pageZoom = msg.zoom || 1;
        if (card) {
          applyCardZoom();
          // 缩放后选区坐标全变了，优先按当前选区重新取锚点
          var liveSel = window.getSelection();
          var liveRect = liveSel && liveSel.toString().trim() ? selectionRect(liveSel) : null;
          if (liveRect) lastAnchor = liveRect;
          position(lastAnchor, false);
        }
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === 'xk-ping') {
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (e) {}

  chrome.storage.sync.get(null, function (s) { applySettings(s); });

  // 页面缩放：卡片按 1/缩放 反向补偿，字号不随缩放变化
  try {
    chrome.runtime.sendMessage({ type: 'xk-get-zoom' }, function (r) {
      if (chrome.runtime.lastError) return;
      if (r && r.zoom) {
        pageZoom = r.zoom;
        if (card) {
          applyCardZoom();
          position(lastAnchor, false);
        }
      }
    });
  } catch (e) {}
})();
