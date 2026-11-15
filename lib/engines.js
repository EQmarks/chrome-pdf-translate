export const DEFAULT_SETTINGS = {
  enabled: true,
  webEnabled: true,   // 普通网页上是否自动划词翻译；关掉后只有 PDF 阅读器会翻
  mode: 'auto',
  engine: 'bing',
  target: 'zh-Hans',
  minLength: 2,
  maxLength: 3000,
  theme: 'dark',
  watchClipboard: true,
  watchAllTabs: false
};

export const ENGINES = [
  { id: 'bing', label: 'Bing（推荐）', note: '网页版免费接口，国内直连可用，质量好' },
  { id: 'mymemory', label: 'MyMemory', note: '免费备用引擎，无需密钥，短句够用' },
  { id: 'google', label: 'Google', note: '需要能访问 googleapis.com 的网络' }
];

export const LANGS = [
  { id: 'zh-Hans', label: '中文（简体）', bing: 'zh-Hans', google: 'zh-CN', mymemory: 'zh-CN' },
  { id: 'zh-Hant', label: '中文（繁體）', bing: 'zh-Hant', google: 'zh-TW', mymemory: 'zh-TW' },
  { id: 'en', label: 'English', bing: 'en', google: 'en', mymemory: 'en' },
  { id: 'ja', label: '日本語', bing: 'ja', google: 'ja', mymemory: 'ja' },
  { id: 'ko', label: '한국어', bing: 'ko', google: 'ko', mymemory: 'ko' },
  { id: 'de', label: 'Deutsch', bing: 'de', google: 'de', mymemory: 'de' },
  { id: 'fr', label: 'Français', bing: 'fr', google: 'fr', mymemory: 'fr' },
  { id: 'ru', label: 'Русский', bing: 'ru', google: 'ru', mymemory: 'ru' }
];

export function langById(id) {
  for (var i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i];
  return LANGS[0];
}
export function engineLabel(id) {
  for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i].label;
  return id;
}
export function isPdfUrl(url) {
  if (!url) return false;
  if (url.indexOf('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai') === 0) return true;
  var path = url.split('#')[0].split('?')[0];
  return /\.pdf$/i.test(path);
}

function withTimeout(url, opts, ms) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, ms || 12000);
  var o = Object.assign({ cache: 'no-store', credentials: 'omit' }, opts || {});
  o.signal = controller.signal;
  return fetch(url, o).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
}

const CACHE = new Map();
const CACHE_MAX = 200;

function cacheGet(key) { return CACHE.get(key); }
function cacheSet(key, val) {
  if (CACHE.size >= CACHE_MAX) { var first = CACHE.keys().next(); if (!first.done) CACHE.delete(first.value); }
  CACHE.set(key, val);
}

function guessSource(text, target) {
  var cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  var latin = (text.match(/[A-Za-z]/g) || []).length;
  if (target.indexOf('zh') === 0) return cjk > latin ? 'zh-CN' : 'en';
  if (cjk > latin) return 'zh-CN';
  return 'en';
}

var bingCtx = null;

async function getBingCtx(force) {
  if (!force && bingCtx && Date.now() - bingCtx.ts < 20 * 60 * 1000) return bingCtx;
  var page = await withTimeout('https://cn.bing.com/translator', {}, 15000);
  if (!page.ok) throw new Error('Bing 页面 HTTP ' + page.status);
  var html = await page.text();
  var ig = /IG:"([^"]+)"/.exec(html);
  var iid = /data-iid="([^"]+)"/.exec(html) || /IID:"([^"]+)"/.exec(html);
  var ab = /params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/.exec(html);
  if (!ig || !iid || !ab) throw new Error('Bing 页面结构变化，未能取到 token');
  var parts = ab[1].split(',');
  bingCtx = {
    ig: ig[1],
    iid: iid[1],
    key: parts[0].replace(/^\s+|\s+$/g, ''),
    token: parts[1].replace(/^\s+|\s+$/g, '').replace(/^"|"$/g, ''),
    ts: Date.now()
  };
  return bingCtx;
}

async function bingPost(ctx, text, to) {
  var body = new URLSearchParams({ fromLang: 'auto-detect', text: text, to: to, token: ctx.token, key: ctx.key });
  var url = 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + ctx.ig + '&IID=' + ctx.iid + '.' + Date.now();
  var res = await withTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 12000);
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Bing 翻译 HTTP ' + res.status);
  var raw = await res.text();
  var data;
  try { data = JSON.parse(raw); } catch (e) { return null; }
  if (!data || !data.length) return null;
  var out = '';
  var from = '';
  for (var i = 0; i < data.length; i++) {
    var item = data[i];
    if (item && item.translations && item.translations.length) out += item.translations[0].text;
    if (item && item.detectedLanguage && item.detectedLanguage.language && !from) from = item.detectedLanguage.language;
  }
  if (!out) return null;
  return { text: out, from: from, to: to };
}

async function bingTranslate(text, target) {
  var to = langById(target).bing;
  var first = await bingPost(await getBingCtx(false), text, to);
  if (first) return first;
  var second = await bingPost(await getBingCtx(true), text, to);
  if (second) return second;
  throw new Error('Bing 拒绝了这次请求（token 失效/触发风控）');
}

async function mymemoryTranslate(text, target) {
  var to = langById(target).mymemory;
  var from = guessSource(text, target);
  var q = text.slice(0, 480);
  var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + encodeURIComponent(from + '|' + to);
  var res = await withTimeout(url, {}, 15000);
  if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
  var data = await res.json();
  var out = data && data.responseData ? data.responseData.translatedText : '';
  if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(out)) throw new Error('MyMemory 限额或用不了');
  return { text: out, from: from, to: to };
}

async function googleTranslate(text, target) {
  var to = langById(target).google;
  var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
  var res = await withTimeout(url, {}, 12000);
  if (!res.ok) throw new Error('Google HTTP ' + res.status);
  var data = await res.json();
  var segs = (data && data[0]) || [];
  var out = '';
  for (var i = 0; i < segs.length; i++) if (segs[i] && segs[i][0]) out += segs[i][0];
  if (!out) throw new Error('Google 未返回译文');
  return { text: out, from: (data && data[2]) || '', to: to };
}

const RUNNERS = { bing: bingTranslate, mymemory: mymemoryTranslate, google: googleTranslate };

export async function translate(opts) {
  var text = String(opts.text || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  var target = opts.target || 'zh-Hans';
  var engine = opts.engine || 'bing';
  if (!text) return { ok: false, error: '没有可翻译的文字' };
  var ck = engine + '|' + target + '|' + text;
  var hit = cacheGet(ck);
  if (hit) return hit;
  if (!RUNNERS[engine]) engine = 'bing';
  var order = [engine];
  var all = ['bing', 'mymemory', 'google'];
  for (var i = 0; i < all.length; i++) if (all[i] !== engine) order.push(all[i]);
  var errors = [];
  for (var j = 0; j < order.length; j++) {
    var id = order[j];
    try {
      var r = await RUNNERS[id](text, target);
      var result = {
        ok: true,
        text: r.text,
        from: r.from || '',
        to: target,
        toName: langById(target).label,
        engine: id,
        engineLabel: engineLabel(id),
        fallback: id !== engine,
        original: text
      };
      cacheSet(ck, result);
      return result;
    } catch (err) {
      errors.push(engineLabel(id) + '：' + ((err && err.message) || err));
    }
  }
  return { ok: false, error: '翻译失败（' + errors.join('；') + '）', original: text };
}