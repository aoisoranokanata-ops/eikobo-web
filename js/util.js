/* ------------------------------------------------------------
   映工房 Web — 共通の小物
   ファイルを直したら、APP_VERSION と sw.js の VERSION を必ず両方上げること。
   ------------------------------------------------------------ */
const APP_VERSION = '0.1.0';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 要素を作る。h('button', {class: 'x', onclick: f}, '文字', 子要素…) */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

/** フレーム → 00:00:05:12 */
function fmtTC(frame, fps) {
  const f = Math.max(0, Math.round(frame));
  const r = Math.round(fps) || 30;
  const s = Math.floor(f / fps);
  const ff = Math.floor(f - s * fps + 1e-6);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${String(Math.min(ff, r - 1)).padStart(2, '0')}`;
}

/** 秒 → 1:05 / 1:02:03 */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  const p2 = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * 小さな画面（モーダル）。buttons: [{label, value, primary, danger}]。押されたボタンの value を返す（閉じたら null）。
 * body は文字か要素。onOpen(root) で入力欄に焦点を当てるなど。
 */
function showDialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], onOpen, wide }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') });
    if (title) box.append(h('h3', null, title));
    if (body) box.append(typeof body === 'string' ? h('p', { class: 'modal-text' }, body) : body);
    const row = h('div', { class: 'modal-buttons' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    for (const b of buttons) {
      row.append(h('button', { class: (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), onclick: () => close(typeof b.value === 'function' ? b.value(box) : b.value) }, b.label));
    }
    box.append(row);
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); close(typeof p.value === 'function' ? p.value(box) : p.value); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    if (onOpen) onOpen(box);
  });
}

function confirmDlg(message, okLabel = 'OK', danger = false) {
  return showDialog({ body: message, buttons: [{ label: 'やめる', value: false }, { label: okLabel, value: true, primary: !danger, danger }] }).then((v) => !!v);
}

function askText(title, value = '', okLabel = 'OK') {
  const input = h('input', { type: 'text', value, class: 'wide-input' });
  return showDialog({
    title, body: input,
    buttons: [{ label: 'やめる', value: null }, { label: okLabel, primary: true, value: () => input.value.trim() }],
    onOpen: () => { input.focus(); input.select(); },
  });
}

/** 時間のかかる処理の表示。返り値の set(文字, 割合 0〜1) と close() */
function progressBox(title) {
  const bar = h('div', { class: 'progress-bar' }, h('div'));
  const label = h('div', { class: 'progress-label' }, '');
  const back = h('div', { class: 'modal-back busy' }, h('div', { class: 'modal' }, h('h3', null, title), label, bar));
  document.body.append(back);
  return {
    set(text, ratio) {
      if (text !== undefined && text !== null) label.textContent = text;
      if (ratio !== undefined && ratio !== null) bar.firstChild.style.width = (clamp(ratio, 0, 1) * 100).toFixed(1) + '%';
    },
    close() { back.remove(); },
  };
}

const isApple = /Mac|iPhone|iPad/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
