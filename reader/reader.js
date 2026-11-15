import * as pdfjsLib from './pdfjs/pdf.min.mjs';

const params = new URLSearchParams(location.search);
const fileParam = params.get('file') || '';
const $ = function (id) { return document.getElementById(id); };

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('reader/pdfjs/pdf.worker.min.mjs');

/*
 * 缩放模型（v1.0.4）：只有一个缩放源 —— Chrome 的页面缩放。
 *   · 工具栏显示的百分比 = Chrome 页面缩放百分比，两边永远一致（1:1）。
 *   · 工具栏 − / + 直接调用 chrome.tabs.setZoom，效果和按 Ctrl +/- 完全一样。
 *   · Ctrl +/- 或用 − / + 放大后，正文跟着放大，不会再被「自动适应宽度」拉回去。
 *   · 顶栏自身按 1/缩放 反向补偿，所以它的物理尺寸恒定，不会被放大撑高。
 *   · 「适应宽度」只调整 PDF 的渲染比例（把一页铺满当前窗口），不改浏览器缩放。
 */
// 100% 按「实际尺寸」显示：1pt = 96/72 CSS px（和 Adobe / pdf.js 的 100% 一致），
// 否则 A4/Letter 在 100% 下只有 612px 宽，看着偏小。
var BASE_SCALE = 96 / 72;

var doc = null;
var scale = BASE_SCALE;   // PDF 渲染比例（CSS 像素）
var browserZoom = 1;      // Chrome 页面缩放
var fitMode = false;      // 最近一次是否点了「适应宽度」
var tabId = null;
var views = [];
var observer = null;
var current = 1;

function updateZoomLabel() {
  $('zoomLabel').textContent = Math.round(browserZoom * 100) + '%';
}

// 顶栏恒定尺寸：按 1/页面缩放 反向 zoom，物理高度/字号/按钮大小不变
function applyBarScale() {
  var z = browserZoom || 1;
  var k = 1 / z;
  var bar = $('bar');
  var status = $('status');
  var clientW = document.documentElement.clientWidth || window.innerWidth;
  try {
    bar.style.zoom = k;
    bar.style.width = Math.ceil(clientW * z) + 'px';
    status.style.zoom = k;
    status.style.width = Math.ceil(clientW * z) + 'px';
  } catch (e) {}
  requestAnimationFrame(function () {
    var h = bar.getBoundingClientRect().height || 44;
    $('pages').style.paddingTop = Math.round(h + 16) + 'px';
    status.style.top = Math.round(h) + 'px';
  });
}

async function trackBrowserZoom() {
  try {
    var tab = await chrome.tabs.getCurrent();
    tabId = tab && tab.id != null ? tab.id : null;
    if (tabId != null) browserZoom = await chrome.tabs.getZoom(tabId);
  } catch (e) {}
  updateZoomLabel();
  applyBarScale();
  try {
    chrome.tabs.onZoomChange.addListener(function (info) {
      if (tabId == null || info.tabId !== tabId) return;
      browserZoom = info.newZoomFactor;
      applyBarScale();
      updateZoomLabel();
      fitMode = false;
      if (doc) rebuildHoldView();
    });
  } catch (e) {}
}

function stepZoom(delta) {
  if (tabId == null) return;
  var next = Math.round((browserZoom + delta) * 100) / 100;
  next = Math.max(0.25, Math.min(5, next));
  if (Math.abs(next - browserZoom) < 0.005) return;
  try {
    chrome.tabs.setZoom(tabId, next);
  } catch (e) {}
}

function init() {
  updateZoomLabel();
  bind();
  trackBrowserZoom();
  if (fileParam) {
    openUrl(fileParam);
  } else {
    $('empty').hidden = false;
  }
}

function bind() {
  $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) openFile(f);
  });
  $('zoomIn').addEventListener('click', function () { stepZoom(0.1); });
  $('zoomOut').addEventListener('click', function () { stepZoom(-0.1); });
  $('fitWidth').addEventListener('click', fitWidth);
  $('prevPage').addEventListener('click', function () { gotoPage(current - 1); });
  $('nextPage').addEventListener('click', function () { gotoPage(current + 1); });
  $('pageInput').addEventListener('change', function () { gotoPage(parseInt($('pageInput').value, 10)); });

  window.addEventListener('dragover', function (e) {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', function () { document.body.classList.remove('dragging'); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    document.body.classList.remove('dragging');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === '+' || e.key === '=') stepZoom(0.1);
    if (e.key === '-') stepZoom(-0.1);
  });
  window.addEventListener('scroll', trackPage, { passive: true });
  window.addEventListener('resize', function () { applyBarScale(); });
}

function setStatus(text) {
  var el = $('status');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
}

async function openUrl(url) {
  setStatus('正在加载 PDF…');
  $('empty').hidden = true;
  try {
    var res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var buf = await res.arrayBuffer();
    // 用 %PDF 魔数判断：网页/登录页/下载页都不是 PDF
    var head = new Uint8Array(buf.slice(0, 5));
    var isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    if (!isPdf) {
      var ctype = (res.headers.get('content-type') || '').split(';')[0];
      setStatus('这个链接不是 PDF 文件' + (ctype ? '（服务器返回 ' + ctype + '）' : '') + '。可以点右上角「打开文件」选本地 PDF，或把 PDF 直接拖进本页面。');
      $('empty').hidden = false;
      return;
    }
    var name = decodeURIComponent((url.split('#')[0].split('?')[0].split('/').pop() || 'document.pdf'));
    await openBytes(buf, name);
  } catch (err) {
    var msg = '加载失败：' + ((err && err.message) || err);
    if (url.indexOf('file:') === 0) {
      msg += '。本地文件请在扩展详情里打开「允许访问文件网址」，或直接把 PDF 拖进本页面。';
    }
    setStatus(msg);
    $('empty').hidden = false;
  }
}

async function openFile(file) {
  if (!file) return;
  setStatus('正在加载 ' + file.name + '…');
  $('empty').hidden = true;
  try {
    var buf = await file.arrayBuffer();
    await openBytes(buf, file.name);
  } catch (err) {
    setStatus('读取失败：' + ((err && err.message) || err));
  }
}

function availWidth() {
  return Math.max(200, (document.documentElement.clientWidth || window.innerWidth) - 48);
}

async function openBytes(buf, name) {
  setStatus('解析中…');
  $('title').textContent = name || 'PDF';
  document.title = (name || 'PDF') + ' · 框选译';
  try {
    var task = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: chrome.runtime.getURL('reader/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('reader/pdfjs/standard_fonts/'),
      // 标准 14 字体改用 pdf.js 自带的等宽度字体：系统字体（serif/arial）与 PDF
      // 字宽不一致，会让文本层被 scaleX 压扁，框选位置随机偏一个字符
      useSystemFonts: false,
      isEvalSupported: false
    });
    doc = await task.promise;
  } catch (err) {
    setStatus('解析失败：' + ((err && err.message) || err));
    return;
  }
  scale = BASE_SCALE;   // 默认 100%（实际尺寸），和工具栏的 100% 对得上
  fitMode = false;
  updateZoomLabel();
  await buildPages();
  setStatus('');
}

async function buildPages() {
  await buildPagesRaw();
  if (fitMode) await refineFit(2);
}

// 建完页按实际宽度纠偏：滚动条出现的那一帧 clientWidth 可能还没更新
async function refineFit(passes) {
  for (var i = 0; i < passes; i++) {
    if (!views.length) return;
    var shown = views[0].div.getBoundingClientRect().width;
    var avail = availWidth();
    if (!shown || Math.abs(shown - avail) < 1) return;
    scale = scale * (avail / shown);
    await buildPagesRaw();
  }
}

async function buildPagesRaw() {
  var container = $('pages');
  container.textContent = '';
  views = [];
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(onIntersect, { rootMargin: '900px 0px' });
  for (var n = 1; n <= doc.numPages; n++) {
    var page = await doc.getPage(n);
    var vp = page.getViewport({ scale: scale });
    var div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = String(n);
    div.style.width = Math.floor(vp.width) + 'px';
    div.style.height = Math.floor(vp.height) + 'px';
    var canvas = document.createElement('canvas');
    var textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    div.appendChild(canvas);
    div.appendChild(textDiv);
    container.appendChild(div);
    var v = { num: n, page: page, div: div, canvas: canvas, textDiv: textDiv, rendered: false, rendering: false };
    views.push(v);
    observer.observe(div);
  }
  $('pageCount').textContent = String(doc.numPages);
  $('pageInput').max = String(doc.numPages);
  current = 1;
  $('pageInput').value = '1';
  window.scrollTo(0, 0);
}

// 保持阅读位置重建（浏览器缩放变化后重新按新分辨率渲染，画面不糊）
async function rebuildHoldView() {
  var el = document.documentElement;
  var ratio = window.scrollY / Math.max(1, el.scrollHeight - window.innerHeight);
  await buildPages();
  requestAnimationFrame(function () {
    var maxY = Math.max(0, el.scrollHeight - window.innerHeight);
    var maxX = Math.max(0, el.scrollWidth - window.innerWidth);
    window.scrollTo(maxX / 2, ratio * maxY);
  });
}

function onIntersect(entries) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isIntersecting) continue;
    var v = views[parseInt(e.target.dataset.page, 10) - 1];
    if (v) renderPage(v);
  }
}

// pdf.js 建文本层时可能改用通用字体（serif），而画布画的是 PDF 内嵌字体。
// 两者字宽差 10% 左右，被 scaleX 压扁后，框选位置就会随机偏一个字符。
// 做法：文本层渲染完后，把每个 span 换成内嵌字体，并按目标宽度重算 scaleX。
function alignTextLayer(page, tc, container) {
  try {
    var spans = container.querySelectorAll('span');
    var items = [];
    var all = (tc && tc.items) || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] && typeof all[i].str === 'string' && all[i].str.length) items.push(all[i]);
    }
    if (!spans.length || spans.length !== items.length) return;
    for (var k = 0; k < spans.length; k++) {
      var span = spans[k];
      var item = items[k];
      if (!item || !item.fontName) continue;
      var fam = null;
      try {
        var fo = page.commonObjs.get(item.fontName);
        if (fo && fo.loadedName) fam = '"' + fo.loadedName + '", ' + (fo.fallbackName || 'serif');
      } catch (e) {}
      if (!fam) continue;
      var target = span.getBoundingClientRect().width;
      if (!target) continue;
      span.style.fontFamily = fam;
      span.style.transform = 'none';
      var measured = span.getBoundingClientRect().width;
      if (measured > 0) span.style.transform = 'scaleX(' + (target / measured).toFixed(6) + ')';
    }
  } catch (e) {}
}

async function renderPage(v) {
  if (v.rendered || v.rendering) return;
  v.rendering = true;
  try {
    var vp = v.page.getViewport({ scale: scale });
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var canvas = v.canvas;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';
    var ctx = canvas.getContext('2d');
    await v.page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    }).promise;
    // 等内嵌字体真正加载完再建文本层：否则文本层会退回系统 serif，
    // 字宽和画布上的字形不一致，框选会随机偏一个字符
    try { await document.fonts.ready; } catch (e) {}
    var tc = await v.page.getTextContent();

    v.textDiv.style.width = Math.floor(vp.width) + 'px';
    v.textDiv.style.height = Math.floor(vp.height) + 'px';
    v.textDiv.style.setProperty('--scale-factor', String(vp.scale));
    var layer = new pdfjsLib.TextLayer({ textContentSource: tc, container: v.textDiv, viewport: vp });
    await layer.render();
    alignTextLayer(v.page, tc, v.textDiv);
    v.rendered = true;
  } catch (err) {
    console.warn('page render failed', v.num, err);
  }
  v.rendering = false;
}

function fitWidth() {
  if (!doc || !views.length) return;
  var vp = views[0].page.getViewport({ scale: 1 });
  scale = availWidth() / vp.width;
  fitMode = true;
  updateZoomLabel();
  rebuildHoldView();
}

function gotoPage(n) {
  if (!doc) return;
  n = Math.max(1, Math.min(doc.numPages, n || 1));
  var v = views[n - 1];
  if (v) v.div.scrollIntoView({ block: 'start', behavior: 'smooth' });
  current = n;
  $('pageInput').value = String(n);
}

function trackPage() {
  var mid = window.scrollY + window.innerHeight / 2;
  var best = 1;
  for (var i = 0; i < views.length; i++) {
    if (views[i].div.offsetTop <= mid) best = views[i].num;
  }
  if (best !== current) {
    current = best;
    $('pageInput').value = String(best);
  }
}

init();
