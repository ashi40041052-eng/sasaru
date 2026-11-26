'use strict';
// ササル — 刺さったスクショを縦スワイプで見返す PWA。データは端末の IndexedDB だけに保存する。

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const feed = $('#feed');

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sasaru', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('meta', { keyPath: 'id' });
      d.createObjectStore('images');
      d.createObjectStore('thumbs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function tx(stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, rej);
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error || new Error('tx abort'));
  });
}
const getBlob = (store, id) => tx([store], 'readonly', t => reqP(t.objectStore(store).get(id)));
const saveMeta = m => tx(['meta'], 'readwrite', t => { t.objectStore('meta').put(m); });
const saveMetas = ms => tx(['meta'], 'readwrite', t => { const s = t.objectStore('meta'); ms.forEach(m => s.put(m)); });
function deleteItems(ids) {
  return tx(['meta', 'images', 'thumbs'], 'readwrite', t => {
    for (const id of ids) ['meta', 'images', 'thumbs'].forEach(s => t.objectStore(s).delete(id));
  });
}

// ---------- state ----------
let metas = [];                 // 全アイテムのメタ情報
let byId = new Map();
let order = [];                 // いま表示中の並び(id の配列)
let cur = 0;
const S = Object.assign({ filter: 'all', sort: 'shuffle', autoSec: 0, installClosed: false },
  JSON.parse(localStorage.getItem('sasaru.state') || '{}'));
S.autoSec = 0;
const saveState = () => localStorage.setItem('sasaru.state', JSON.stringify(S));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function allTags() {
  const c = new Map();
  metas.forEach(m => m.tags.forEach(t => c.set(t, (c.get(t) || 0) + 1)));
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}
function filterLabel(f = S.filter) {
  if (f === 'all') return 'すべて';
  if (f === 'fav') return '♥ 刺さる';
  if (f === 'untagged') return 'タグなし';
  if (f === 'memo') return 'メモあり';
  return '#' + f.slice(4);
}
function matches(m, f = S.filter) {
  if (f === 'all') return true;
  if (f === 'fav') return m.fav;
  if (f === 'untagged') return !m.tags.length;
  if (f === 'memo') return !!m.memo;
  return m.tags.includes(f.slice(4));
}

// 見た回数が少ない物ほど前に来やすいシャッフル。同じ順番ばかりにならない。
function computeOrder() {
  let list = metas.filter(m => matches(m));
  if (S.sort === 'new') list.sort((a, b) => b.added - a.added);
  else if (S.sort === 'old') list.sort((a, b) => a.added - b.added);
  else {
    const now = Date.now();
    list = list.map(m => {
      const recent = m.lastSeen && now - m.lastSeen < 6 * 3600e3 ? 2 : 0;
      return [Math.random() * (1 + m.views * 0.5 + recent) / (m.fav ? 1.4 : 1), m];
    }).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  }
  return list.map(m => m.id);
}

// ---------- feed ----------
const urls = new Map(); // id -> objectURL(近くのスライドだけ持つ)
let loadedSet = new Set();
const KEEP = 2, DROP = 5;

function rebuild(keepId) {
  order = computeOrder();
  unloadAll(); loadedSet.clear();
  feed.innerHTML = order.map((id, i) => `<div class="slide" data-i="${i}"></div>`).join('');
  let idx = keepId ? order.indexOf(keepId) : 0;
  if (idx < 0) idx = 0;
  cur = idx;
  feed.scrollTop = idx * feed.clientHeight;
  document.body.classList.toggle('isEmpty', metas.length === 0);
  $('#empty').hidden = metas.length !== 0;
  $('#filterLabel').textContent = filterLabel();
  $('#count').textContent = order.length;
  $('#sortBtn').textContent = { shuffle: '🔀', new: '🆕', old: '🕰' }[S.sort];
  refreshAround();
  updateUI();
  if (metas.length && !order.length) toast('この絞り込みには1枚もありません');
}

async function loadSlide(i) {
  const el = feed.children[i];
  if (!el || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const id = order[i];
  let u = urls.get(id);
  if (!u) {
    const b = await getBlob('images', id);
    if (!b || el.dataset.loaded !== '1' || order[i] !== id) return;
    u = URL.createObjectURL(b);
    urls.set(id, u);
  }
  el.innerHTML = `<img class="bg" src="${u}" alt=""><img class="main" src="${u}" alt="" decoding="async">`;
}
function unloadSlide(i) {
  const el = feed.children[i];
  if (!el || !el.dataset.loaded) return;
  delete el.dataset.loaded;
  el.innerHTML = '';
  const id = order[i];
  const u = urls.get(id);
  if (u) { URL.revokeObjectURL(u); urls.delete(id); }
}
function unloadAll() {
  urls.forEach(u => URL.revokeObjectURL(u));
  urls.clear();
}
function refreshAround() {
  const want = new Set();
  for (let i = cur - KEEP; i <= cur + KEEP; i++) if (i >= 0 && i < order.length) want.add(i);
  // 今の1枚を先に読む
  loadSlide(cur);
  want.forEach(i => loadSlide(i));
  loadedSet.forEach(i => { if (Math.abs(i - cur) > DROP) { unloadSlide(i); loadedSet.delete(i); } });
  want.forEach(i => loadedSet.add(i));
}

let scrollRaf = 0;
feed.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const h = feed.clientHeight || 1;
    const i = Math.min(order.length - 1, Math.max(0, Math.round(feed.scrollTop / h)));
    if (i !== cur) { cur = i; refreshAround(); updateUI(); }
  });
}, { passive: true });

// 1.2秒以上表示したら「見た」に数える
let viewTimer = 0;
function updateUI() {
  const m = byId.get(order[cur]);
  clearTimeout(viewTimer);
  if (!m) { $('#caption').innerHTML = ''; return; }
  const fb = $('#favBtn');
  fb.classList.toggle('on', m.fav);
  fb.querySelector('.ic').textContent = m.fav ? '♥' : '♡';
  const tags = m.tags.map(t => '#' + esc(t)).join(' ');
  $('#caption').innerHTML = (tags ? `<div class="tags">${tags}</div>` : '') + (m.memo ? `<div class="memo">${esc(m.memo)}</div>` : '');
  const id = m.id;
  viewTimer = setTimeout(() => {
    const mm = byId.get(id);
    if (!mm || order[cur] !== id) return;
    mm.views++; mm.lastSeen = Date.now();
    saveMeta(mm);
  }, 1200);
}
function curMeta() { return byId.get(order[cur]); }
function goTo(i, smooth = true) {
  if (!order.length) return;
  i = (i + order.length) % order.length;
  feed.scrollTo({ top: i * feed.clientHeight, behavior: smooth ? 'smooth' : 'auto' });
}

// タップ = 表示を消す/出す、ダブルタップ = 刺さる(♥)
let lastTap = 0, tapTimer = 0;
feed.addEventListener('click', e => {
  if (!order.length) return;
  const now = Date.now();
  if (now - lastTap < 300) {
    clearTimeout(tapTimer); lastTap = 0;
    const m = curMeta();
    if (m && !m.fav) { m.fav = true; saveMeta(m); updateUI(); }
    const h = $('#heart'); h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop');
    return;
  }
  lastTap = now;
  tapTimer = setTimeout(() => document.body.classList.toggle('clean'), 300);
});

// 自動めくり
let autoTimer = 0;
function setAuto(sec) {
  S.autoSec = sec;
  clearInterval(autoTimer);
  const b = $('#autoBtn');
  b.classList.toggle('on', !!sec);
  b.textContent = sec ? `${sec}秒` : '▶︎';
  if (sec) autoTimer = setInterval(() => goTo(cur + 1), sec * 1000);
}

// ---------- toast / sheet ----------
let toastT = 0;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
let sheetClose = null;
function openSheet(html, onClose) {
  const s = $('#sheet'); s.innerHTML = html; s.hidden = false; $('#sheetBack').hidden = false;
  sheetClose = onClose || null;
  return s;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheetBack').hidden = true;
  const f = sheetClose; sheetClose = null; if (f) f();
}
$('#sheetBack').addEventListener('click', () => { if (!importing) closeSheet(); });

// ---------- 画像の取り込み ----------
const MAXW = 1290, MAXPX = 16e6, THUMBW = 240;
async function decode(file) {
  if (window.createImageBitmap) {
    try { const b = await createImageBitmap(file); return { src: b, w: b.width, h: b.height, close: () => b.close && b.close() }; } catch (e) {}
  }
  const u = URL.createObjectURL(file);
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('画像を読めません')); im.src = u; });
  return { src: im, w: im.naturalWidth, h: im.naturalHeight, close: () => URL.revokeObjectURL(u) };
}
function draw(d, w, h, q) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(d.src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => { c.width = c.height = 0; b ? res(b) : rej(new Error('変換に失敗')); }, 'image/jpeg', q));
}
async function processImage(file) {
  const d = await decode(file);
  try {
    const s = Math.min(1, MAXW / d.w, Math.sqrt(MAXPX / (d.w * d.h)));
    let blob;
    if (s === 1 && file.type === 'image/jpeg' && file.size < 1.5e6) blob = file;
    else blob = await draw(d, d.w * s, d.h * s, 0.88);
    const ts = Math.min(1, THUMBW / d.w);
    const thumb = await draw(d, d.w * ts, Math.min(d.h * ts, THUMBW * 3), 0.72);
    return { blob, thumb, w: Math.round(d.w * s), h: Math.round(d.h * s) };
  } finally { d.close(); }
}
async function hashOf(file) {
  try {
    if (crypto.subtle) {
      const buf = await file.arrayBuffer();
      const h = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}
  return `${file.size}-${file.lastModified}-${file.name}`;
}

let importing = false;
function askImport(files) {
  files = [...files].filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|heic|heif|webp|gif)$/i.test(f.name));
  if (!files.length) return;
  const tags = allTags().slice(0, 30);
  const s = openSheet(`
    <h2>${files.length}枚を追加</h2>
    <p>まとめてタグを付けられます(あとで変えられます)。</p>
    <input type="text" id="impTag" placeholder="例: 名言 / 漫画 / 仕事" enterkeyhint="done">
    <div class="chips">${tags.map(([t]) => `<button class="chip" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
    <div class="row"><button class="btn" data-x="cancel">やめる</button><button class="btn primary" data-x="go">追加する</button></div>`);
  s.querySelectorAll('.chip').forEach(c => c.onclick = () => { s.querySelector('#impTag').value = c.dataset.t; });
  s.querySelector('[data-x=cancel]').onclick = closeSheet;
  s.querySelector('[data-x=go]').onclick = () => runImport(files, s.querySelector('#impTag').value.trim().replace(/^#/, ''));
}

async function runImport(files, tag) {
  importing = true;
  setAuto(0);
  const s = openSheet(`<h2>追加しています…</h2>
    <div class="bar"><i id="impBar"></i></div>
    <p id="impTxt">0 / ${files.length}</p>
    <p class="small">画面を閉じずにお待ちください。終わるまで1枚0.2秒ほどです。</p>`);
  const known = new Set(metas.map(m => m.hash));
  let added = 0, dup = 0, fail = 0;
  const base = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const hash = await hashOf(f);
      if (known.has(hash)) { dup++; }
      else {
        const p = await processImage(f);
        const m = { id: uid(), hash, w: p.w, h: p.h, tags: tag ? [tag] : [], fav: false, memo: '',
          added: base + i, views: 0, lastSeen: 0 };
        await tx(['meta', 'images', 'thumbs'], 'readwrite', t => {
          t.objectStore('meta').put(m); t.objectStore('images').put(p.blob, m.id); t.objectStore('thumbs').put(p.thumb, m.id);
        });
        metas.push(m); byId.set(m.id, m); known.add(hash); added++;
      }
    } catch (e) { console.error(e); fail++; }
    s.querySelector('#impBar').style.width = ((i + 1) / files.length * 100) + '%';
    s.querySelector('#impTxt').textContent = `${i + 1} / ${files.length}` + (dup ? `(重複 ${dup})` : '');
  }
  importing = false;
  closeSheet();
  if (added && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  toast(`${added}枚 追加` + (dup ? ` / 重複 ${dup}枚は飛ばしました` : '') + (fail ? ` / 失敗 ${fail}枚` : ''), 3500);
  if (added) { if (S.filter !== 'all' && !(tag && S.filter === 'tag:' + tag)) S.filter = 'all'; S.sort = S.sort === 'shuffle' ? 'shuffle' : S.sort; saveState(); }
  // 追加した物を先頭に出す
  const newest = metas.filter(m => m.added >= base).map(m => m.id);
  rebuild();
  if (newest.length && S.sort === 'shuffle') {
    const rest = order.filter(id => !newest.includes(id));
    order = [...newest, ...rest];
    rebuildWithOrder(order);
  }
  maybeInstallHint();
}
function rebuildWithOrder(o) {
  unloadAll(); loadedSet.clear();
  order = o;
  feed.innerHTML = order.map((id, i) => `<div class="slide" data-i="${i}"></div>`).join('');
  cur = 0; feed.scrollTop = 0; refreshAround(); updateUI();
  $('#count').textContent = order.length;
}

$('#fileIn').addEventListener('change', e => { const f = e.target.files; askImport(f); e.target.value = ''; });
document.addEventListener('paste', e => {
  const fs = [...(e.clipboardData?.files || [])];
  if (fs.length) askImport(fs);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); askImport(e.dataTransfer.files); });

// ---------- 各操作 ----------
function openFilter() {
  const tags = allTags();
  const cnt = f => metas.filter(m => matches(m, f)).length;
  const opts = [['all', 'すべて'], ['fav', '♥ 刺さる'], ['memo', '✎ メモあり'], ['untagged', 'タグなし'], ...tags.map(([t]) => ['tag:' + t, '#' + t])];
  const sorts = [['shuffle', '🔀 シャッフル(見てない物を優先)'], ['new', '🆕 新しい順'], ['old', '🕰 古い順']];
  const s = openSheet(`<h2>見るもの</h2><div class="list">${opts.map(([f, l]) =>
    `<button data-f="${esc(f)}" class="${S.filter === f ? 'on' : ''}"><span>${esc(l)}</span><span class="n">${cnt(f)}</span></button>`).join('')}</div>
    <h2 style="margin-top:20px">並び順</h2><div class="list">${sorts.map(([k, l]) =>
    `<button data-s="${k}" class="${S.sort === k ? 'on' : ''}"><span>${l}</span></button>`).join('')}</div>`);
  s.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filter = b.dataset.f; saveState(); closeSheet(); rebuild(); });
  s.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { S.sort = b.dataset.s; saveState(); closeSheet(); rebuild(); });
}

function openMemo() {
  const m = curMeta(); if (!m) return;
  const s = openSheet(`<h2>メモ</h2><p>どこが刺さった?いつ見返したい?</p>
    <textarea id="memoTx" placeholder="例: 落ち込んだ時に読む">${esc(m.memo)}</textarea>
    <div class="row"><button class="btn" data-x="c">やめる</button><button class="btn primary" data-x="ok">保存</button></div>`);
  const ta = s.querySelector('#memoTx'); setTimeout(() => ta.focus(), 50);
  s.querySelector('[data-x=c]').onclick = closeSheet;
  s.querySelector('[data-x=ok]').onclick = () => { m.memo = ta.value.trim(); saveMeta(m); closeSheet(); updateUI(); };
}

function openTagEditor(targets, done) {
  const sel = new Set(targets.length === 1 ? targets[0].tags : []);
  const render = () => allTags().map(([t, n]) => t).concat([...sel].filter(t => !allTags().some(([x]) => x === t)));
  const s = openSheet(`<h2>タグ${targets.length > 1 ? `(${targets.length}枚に付ける)` : ''}</h2>
    <div class="chips" id="tagChips"></div>
    <div class="row" style="margin-top:4px"><input type="text" id="newTag" placeholder="新しいタグ" enterkeyhint="done"><button class="btn" data-x="addt" style="flex:0 0 auto;padding:0 18px">追加</button></div>
    <div class="row"><button class="btn" data-x="c">やめる</button><button class="btn primary" data-x="ok">決定</button></div>`);
  const chipsEl = s.querySelector('#tagChips');
  const paint = () => {
    chipsEl.innerHTML = render().map(t => `<button class="chip ${sel.has(t) ? 'on' : ''}" data-t="${esc(t)}">#${esc(t)}</button>`).join('') || '<p>まだタグがありません</p>';
    chipsEl.querySelectorAll('.chip').forEach(c => c.onclick = () => { const t = c.dataset.t; sel.has(t) ? sel.delete(t) : sel.add(t); paint(); });
  };
  paint();
  const inp = s.querySelector('#newTag');
  const addNew = () => { const v = inp.value.trim().replace(/^#/, ''); if (v) { sel.add(v); inp.value = ''; paint(); } };
  s.querySelector('[data-x=addt]').onclick = addNew;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } });
  s.querySelector('[data-x=c]').onclick = closeSheet;
  s.querySelector('[data-x=ok]').onclick = async () => {
    addNew();
    if (targets.length === 1) targets[0].tags = [...sel];
    else targets.forEach(m => { m.tags = [...new Set([...m.tags, ...sel])]; });
    await saveMetas(targets);
    closeSheet(); done && done();
  };
}

async function shareCur() {
  const m = curMeta(); if (!m) return;
  const b = await getBlob('images', m.id);
  const file = new File([b], `sasaru-${m.id}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: m.memo || undefined }); } catch (e) {}
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}

async function delCur() {
  const m = curMeta(); if (!m) return;
  if (!confirm('この1枚を削除しますか?')) return;
  await removeIds([m.id]);
  const next = order[cur + 1] || order[cur - 1];
  rebuildKeepingOrder(next);
  toast('削除しました');
}
async function removeIds(ids) {
  await deleteItems(ids);
  const set = new Set(ids);
  metas = metas.filter(m => !set.has(m.id));
  ids.forEach(id => byId.delete(id));
}
// シャッフルの並びを崩さずに、消した物だけ抜く
function rebuildKeepingOrder(keepId) {
  const o = order.filter(id => byId.has(id) && matches(byId.get(id)));
  unloadAll(); loadedSet.clear();
  order = o;
  feed.innerHTML = order.map((id, i) => `<div class="slide" data-i="${i}"></div>`).join('');
  cur = Math.max(0, order.indexOf(keepId));
  feed.scrollTop = cur * feed.clientHeight;
  document.body.classList.toggle('isEmpty', metas.length === 0);
  $('#empty').hidden = metas.length !== 0;
  $('#count').textContent = order.length;
  refreshAround(); updateUI();
}

async function openZoom() {
  const m = curMeta(); if (!m) return;
  const u = urls.get(m.id) || URL.createObjectURL(await getBlob('images', m.id));
  $('#zoomImg').src = u; $('#zoom').hidden = false; $('#zoom').classList.remove('x2');
  $('#zoomScroll').scrollTop = 0;
  document.querySelector('[data-act=zoomScale]').textContent = '2倍';
  setAuto(0);
}

// ---------- 一覧 ----------
let selecting = false; const selected = new Set();
let gridObs;
function openGrid() {
  setAuto(0);
  $('#grid').hidden = false;
  renderGrid();
}
function renderGrid() {
  const g = $('#gridBody');
  $('#gridTitle').textContent = `${filterLabel()}(${order.length})`;
  g.innerHTML = order.map((id, i) => {
    const m = byId.get(id);
    return `<div class="cell ${selected.has(id) ? 'sel' : ''}" data-id="${esc(id)}" data-i="${i}"><img alt="">${m.fav ? '<span class="f">♥</span>' : ''}${m.views ? `<span class="v">👁${+m.views}</span>` : ''}</div>`;
  }).join('') || '<p style="grid-column:1/-1;text-align:center;opacity:.6;padding:40px">まだありません</p>';
  if (gridObs) gridObs.disconnect();
  gridObs = new IntersectionObserver(async ents => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      gridObs.unobserve(e.target);
      const b = await getBlob('thumbs', e.target.dataset.id);
      if (b) { const img = e.target.querySelector('img'); img.onload = () => URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(b); }
    }
  }, { root: g, rootMargin: '600px' });
  g.querySelectorAll('.cell').forEach(c => gridObs.observe(c));
  updateSel();
}
$('#gridBody').addEventListener('click', e => {
  const c = e.target.closest('.cell'); if (!c) return;
  if (selecting) {
    const id = c.dataset.id; selected.has(id) ? selected.delete(id) : selected.add(id);
    c.classList.toggle('sel'); updateSel(); return;
  }
  closeGrid();
  goTo(+c.dataset.i, false);
});
function updateSel() {
  $('#grid').classList.toggle('selecting', selecting);
  $('#gridBar').hidden = !selecting;
  $('#gridSelectBtn').textContent = selecting ? '完了' : '選択';
  $('#selCount').textContent = `${selected.size}枚`;
}
function closeGrid() { $('#grid').hidden = true; selecting = false; selected.clear(); updateSel(); }

// ---------- 設定・バックアップ ----------
async function openSettings() {
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `使っている容量: 約${(e.usage / 1e6).toFixed(0)}MB`; } catch (e) {}
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (e) {}
  const favs = metas.filter(m => m.fav).length;
  const s = openSheet(`<h2>設定・バックアップ</h2>
    <p>${metas.length}枚(♥ ${favs}枚)<br>${est}<br>${persisted ? '✅ 端末に消えにくい形で保存中' : '⚠️ 長く開かないと消える可能性があります。ホーム画面に追加して使い、ときどきバックアップしてください。'}</p>
    <p class="small">データはこの iPhone の中だけにあります。機種変更や削除に備えて、バックアップ(zip)を「ファイル」や iCloud Drive に保存できます。</p>
    <div class="row"><button class="btn primary" data-x="exp">バックアップを作る</button></div>
    <div class="row"><button class="btn" data-x="imp">バックアップから戻す</button></div>
    <div class="row"><button class="btn" data-x="close">閉じる</button></div>`);
  s.querySelector('[data-x=exp]').onclick = exportZip;
  s.querySelector('[data-x=imp]').onclick = () => $('#zipIn').click();
  s.querySelector('[data-x=close]').onclick = closeSheet;
}

// 圧縮なし zip(画像はもう圧縮済みなので十分)
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(entries, onProgress) { // entries: [{name, blob}]
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  const d = new Date(); const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    const nm = enc.encode(name); const data = new Uint8Array(await blob.arrayBuffer()); const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, tm, true); h.setUint16(12, dt, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, nm, blob);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, off, true);
    central.push(c.buffer, nm);
    off += 30 + nm.length + data.length;
    onProgress && onProgress(i + 1, entries.length);
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
async function readZip(blob) {
  const dv = async (o, n) => new DataView(await blob.slice(o, o + n).arrayBuffer());
  const tail = Math.min(blob.size, 22 + 65535);
  const t = await dv(blob.size - tail, tail);
  let p = -1; for (let i = tail - 22; i >= 0; i--) if (t.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('zip ではありません');
  const count = t.getUint16(p + 10, true), cdSize = t.getUint32(p + 12, true), cdOff = t.getUint32(p + 16, true);
  const cd = await dv(cdOff, cdSize); const dec = new TextDecoder(); const out = {};
  let q = 0;
  for (let i = 0; i < count; i++) {
    const method = cd.getUint16(q + 10, true), size = cd.getUint32(q + 20, true), nl = cd.getUint16(q + 28, true),
      el = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true), lo = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nl));
    q += 46 + nl + el + cl;
    if (method !== 0) continue;
    const lh = await dv(lo, 30);
    const start = lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out[name] = blob.slice(start, start + size);
  }
  return out;
}
async function exportZip() {
  if (!metas.length) return toast('まだ1枚もありません');
  importing = true;
  const s = openSheet(`<h2>バックアップを作っています…</h2><div class="bar"><i id="bk"></i></div><p id="bkT"></p>`);
  try {
    const entries = [{ name: 'meta.json', blob: new Blob([JSON.stringify({ app: 'sasaru', v: 1, items: metas })], { type: 'application/json' }) }];
    for (const m of metas) {
      const b = await getBlob('images', m.id); if (b) entries.push({ name: `images/${m.id}.jpg`, blob: b });
      const th = await getBlob('thumbs', m.id); if (th) entries.push({ name: `thumbs/${m.id}.jpg`, blob: th });
    }
    const zip = await makeZip(entries, (i, n) => { s.querySelector('#bk').style.width = (i / n * 100) + '%'; s.querySelector('#bkT').textContent = `${i} / ${n}`; });
    const d = new Date(); const name = `sasaru-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.zip`;
    const file = new File([zip], name, { type: 'application/zip' });
    importing = false; closeSheet();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) {}
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    toast('「ファイルに保存」で iCloud Drive などに置いてください', 3500);
  } catch (e) { importing = false; closeSheet(); toast('バックアップに失敗: ' + e.message, 4000); }
}
$('#zipIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  importing = true;
  const s = openSheet(`<h2>戻しています…</h2><div class="bar"><i id="rs"></i></div><p id="rsT"></p>`);
  try {
    const files = await readZip(f);
    if (!files['meta.json']) throw new Error('ササルのバックアップではありません');
    const data = JSON.parse(await files['meta.json'].text());
    const known = new Set(metas.map(m => m.hash)); let added = 0, n = 0;
    for (const m of data.items) {
      n++;
      s.querySelector('#rs').style.width = (n / data.items.length * 100) + '%'; s.querySelector('#rsT').textContent = `${n} / ${data.items.length}`;
      // 外から来た zip なので、形が正しい物だけ受け入れる
      if (!m || typeof m.id !== 'string' || !/^[a-z0-9]{4,40}$/.test(m.id)) continue;
      const img = files[`images/${m.id}.jpg`]; if (!img || known.has(m.hash) || byId.has(m.id)) continue;
      const blob = new Blob([await img.arrayBuffer()], { type: 'image/jpeg' });
      let thumb = files[`thumbs/${m.id}.jpg`];
      thumb = thumb ? new Blob([await thumb.arrayBuffer()], { type: 'image/jpeg' }) : (await processImage(blob)).thumb;
      const num = v => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);
      const mm = { id: m.id, hash: String(m.hash || m.id).slice(0, 200), w: num(m.w), h: num(m.h),
        tags: Array.isArray(m.tags) ? m.tags.filter(t => typeof t === 'string').map(t => t.slice(0, 50)).slice(0, 50) : [],
        fav: m.fav === true, memo: typeof m.memo === 'string' ? m.memo.slice(0, 5000) : '',
        added: num(m.added) || Date.now(), views: num(m.views), lastSeen: num(m.lastSeen) };
      await tx(['meta', 'images', 'thumbs'], 'readwrite', t => { t.objectStore('meta').put(mm); t.objectStore('images').put(blob, mm.id); t.objectStore('thumbs').put(thumb, mm.id); });
      metas.push(mm); byId.set(mm.id, mm); known.add(mm.hash); added++;
    }
    importing = false; closeSheet(); rebuild();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    toast(`${added}枚を戻しました`, 3000);
  } catch (err) { importing = false; closeSheet(); toast('戻せませんでした: ' + err.message, 4000); }
});

// ---------- ボタンの振り分け ----------
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  e.stopPropagation();
  const act = b.dataset.act;
  const m = curMeta();
  switch (act) {
    case 'add': $('#fileIn').click(); break;
    case 'restore': $('#zipIn').click(); break;
    case 'filter': openFilter(); break;
    case 'sort': S.sort = { shuffle: 'new', new: 'old', old: 'shuffle' }[S.sort]; saveState(); rebuild(); toast({ shuffle: 'シャッフル(見てない物を優先)', new: '新しい順', old: '古い順' }[S.sort]); break;
    case 'auto': { const seq = [0, 5, 10, 20]; const nx = seq[(seq.indexOf(S.autoSec) + 1) % seq.length]; setAuto(nx); toast(nx ? `${nx}秒ごとに自動でめくります` : '自動めくりを止めました'); break; }
    case 'grid': openGrid(); break;
    case 'fav': if (m) { m.fav = !m.fav; saveMeta(m); updateUI(); if (m.fav) { const h = $('#heart'); h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop'); } } break;
    case 'memo': openMemo(); break;
    case 'tag': if (m) openTagEditor([m], () => { updateUI(); if (!matches(m)) toast('いまの絞り込みから外れました'); }); break;
    case 'zoom': openZoom(); break;
    case 'share': shareCur(); break;
    case 'del': delCur(); break;
    case 'gridClose': closeGrid(); break;
    case 'gridSelect': selecting = !selecting; if (!selecting) selected.clear(); renderGrid(); break;
    case 'selAll': if (selected.size === order.length) selected.clear(); else order.forEach(id => selected.add(id)); renderGrid(); break;
    case 'selFav': { const ts = [...selected].map(id => byId.get(id)); const on = !ts.every(x => x.fav); ts.forEach(x => x.fav = on); await saveMetas(ts); renderGrid(); toast(on ? `${ts.length}枚に♥` : '♥を外しました'); break; }
    case 'selTag': { const ts = [...selected].map(id => byId.get(id)); if (!ts.length) return toast('先に選んでください'); openTagEditor(ts, () => { renderGrid(); toast(`${ts.length}枚にタグを付けました`); }); break; }
    case 'selDel': {
      const ids = [...selected]; if (!ids.length) return toast('先に選んでください');
      if (!confirm(`${ids.length}枚を削除しますか?`)) return;
      await removeIds(ids); selected.clear(); rebuildKeepingOrder(order[cur]); renderGrid(); toast(`${ids.length}枚 削除しました`); break;
    }
    case 'settings': openSettings(); break;
    case 'zoomScale': { const z = $('#zoom'); z.classList.toggle('x2'); b.textContent = z.classList.contains('x2') ? '1倍' : '2倍'; break; }
    case 'zoomClose': { $('#zoom').hidden = true; const im = $('#zoomImg'); if (![...urls.values()].includes(im.src)) URL.revokeObjectURL(im.src); im.removeAttribute('src'); break; }
    case 'installClose': $('#install').hidden = true; S.installClosed = true; saveState(); break;
  }
});

document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); goTo(cur + 1); }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); goTo(cur - 1); }
  if (e.key === 'Escape') { if (!$('#sheet').hidden && !importing) closeSheet(); else if (!$('#zoom').hidden) $('[data-act=zoomClose]').click(); else if (!$('#grid').hidden) closeGrid(); }
});

let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { feed.scrollTop = cur * feed.clientHeight; }, 100); });

function maybeInstallHint() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !standalone && !S.installClosed && metas.length) $('#install').hidden = false;
}

// ---------- 起動 ----------
(async () => {
  try {
    db = await openDB();
    metas = await tx(['meta'], 'readonly', t => reqP(t.objectStore('meta').getAll()));
    metas.forEach(m => byId.set(m.id, m));
  } catch (e) {
    toast('保存場所を開けませんでした。プライベートブラウズでは使えません。', 6000);
  }
  if (S.filter !== 'all' && !metas.some(m => matches(m))) S.filter = 'all';
  rebuild();
  maybeInstallHint();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
