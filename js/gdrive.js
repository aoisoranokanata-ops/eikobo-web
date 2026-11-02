/* ------------------------------------------------------------
   Google Drive（紙工房 Web の js/gdrive.js と同じ作り）
   - 作品のバックアップ（.ekp ＋素材＋ LUT の .zip = 「Windows 版へ・バックアップ」と同じ形）・戻す、
     ドライブの .ekp / .zip を作品として読み込む、動画・音声・画像を素材として読み込む・見つからない素材を名前で結ぶ、
     書き出した動画・.zip をドライブに保存。
   - ライブラリは使わず、OAuth 2.0（トークンだけの流れ）＋ Drive REST v3 を fetch / XHR で直接呼ぶ。
     クライアント ID は利用者が Google Cloud で作って貼る（紙工房 Web と同じ ID を使える。リダイレクト URI を足すだけ）。
   - サインイン: Safari のタブでは小窓、ホーム画面アプリ・小窓が開けない時はページごと Google へ移り oauth.html で戻る。
     トークンは localStorage `eikobo-web:gdrive-token`（1 時間）。ページごと移った時は起動時の resume() がやりかけの事を続ける
     （送りかけのファイルは OPFS の eikobo-web/export/gd-pending に置いておく）。
   - 動画は大きいので: 受け取りはメモリに溜めずに OPFS（eikobo-web/export/gd-…）へ流し、使い終わったら消す。
     送るのは再開できる形のアップロードを 32MB ずつ（通信が切れたら受け取り済みの所を聞いて続きから）。
   - 権限: drive.file（映工房が作ったファイルの読み書き）＋ drive.readonly（ドライブの動画・作品を読む）。
   - 保存先はマイドライブの「映工房 Web」フォルダ（無ければ作る）。
   ------------------------------------------------------------ */
const GDrive = (() => {
  const LS = 'eikobo-web:';
  const CLIENT_ID = '';                      // ここに書けば全端末で使える
  const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
  const FOLDER = '映工房 Web';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const PENDING = 'gd-pending';
  const CHUNK = 32 * 1024 * 1024;            // 256KiB の倍数（Drive の決まり）
  const ICON = { folder: '📁', video: '🎬', audio: '🎵', image: '🖼', project: '🗂' };
  const NAMES = { video: '動画', audio: '音声', image: '画像', project: '作品（.ekp / .zip）' };
  const temps = new Set();                   // 受け取ったファイルの置き場（OPFS の export/ の名前）

  const loadLs = (k, def) => { try { const v = localStorage.getItem(LS + k); return v ? { ...def, ...JSON.parse(v) } : { ...def }; } catch { return { ...def }; } };
  const saveLs = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* 私的ブラウズなど */ } };
  const dropLs = (k) => { try { localStorage.removeItem(LS + k); } catch { /* */ } };
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const msg = (e) => (e && e.message) || String(e);
  const fail = (e) => { if (e && e.message !== 'cancel') toast(msg(e), 6000); };
  const cancelErr = () => new Error('cancel');
  const stamp = (ms) => fmtDate(ms).replace(/[/:]/g, '').replace(' ', '_');
  const safe = (s) => (String(s || '映工房').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '映工房');

  function kindOf(f) {
    const m = f.mimeType || '', n = f.name || '';
    if (m === FOLDER_MIME) return 'folder';
    if (/\.(ekp|zip)$/i.test(n) || m === 'application/zip' || m === 'application/x-zip-compressed') return 'project';
    if (m.startsWith('application/vnd.google-apps.')) return '';
    return Media.kindOf({ type: m, name: n }) || '';
  }

  // ---- 設定・トークン ------------------------------------------------------------
  const conf = () => loadLs('gdrive', { clientId: '', email: '', folderId: '', lastBackup: 0, backups: {} });
  const setConf = (patch) => saveLs('gdrive', { ...conf(), ...patch });
  const clientId = () => (conf().clientId || CLIENT_ID || '').trim();
  const configured = () => !!clientId();
  const redirectUri = () => new URL('oauth.html', location.href).href;
  function token() { const t = loadLs('gdrive-token', {}); return t.token && t.exp > Date.now() + 60000 ? t.token : null; }
  const dropToken = () => dropLs('gdrive-token');
  const standalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const authError = (code) => (code === 'access_denied' ? 'Google Drive へのアクセスが許可されませんでした' : `Google にサインインできませんでした（${code || '不明'}）`);
  /** 紙工房 Web（同じオリジン）で設定したクライアント ID。読むだけ */
  function kamikoboId() {
    try { return String((JSON.parse(localStorage.getItem('kamikobo-web.gdrive') || '{}') || {}).clientId || '').trim(); } catch { return ''; }
  }

  /**
   * クリックの中で呼ぶ（小窓はクリックの中でしか開けないので、await より前に signIn まで進む）。
   * サインインが要れば済ませてから r の事をする。r.kind: open / restore / backup / media / relink / upload
   */
  async function go(r) {
    if (!configured()) { await setupDialog(); return; }
    try {
      if (!token()) await signIn(r);
      await act(r);
    } catch (e) { fail(e); } finally { await cleanTemp(); }
  }

  async function act(r) {
    switch (r.kind) {
      case 'open': {
        const f = await pick({ kinds: ['project'], multiple: false, title: 'Google Drive から作品を読み込む' });
        if (f.length) await App.importProject(f[0]);
        return;
      }
      case 'restore': return restoreDialog();
      case 'backup': return backup(r.ids || null, r.media !== false);
      case 'media': {
        if (!App.project) return;
        const f = await pick({ kinds: ['video', 'audio', 'image'], title: 'Google Drive から素材を読み込む' });
        if (f.length) await App.importFiles(f);
        return;
      }
      case 'relink': {
        if (!App.project) return;
        const f = await pick({ kinds: ['video', 'audio', 'image'], title: '見つからない素材を Google Drive から選ぶ（名前で結びます）' });
        if (f.length) await App.linkFiles(f);
        return;
      }
      case 'upload': return r.blob ? saveFile(r.blob, r.name) : undefined;
      default: return undefined;
    }
  }

  async function signIn(r = null) {
    const state = uid('s');
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token', scope: SCOPES, include_granted_scopes: 'true', state });
    const email = conf().email;
    if (email) q.set('login_hint', email);
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
    if (!standalone()) {
      saveLs('gdrive-auth', { state, at: Date.now(), mode: 'popup' });
      const w = window.open(url, 'eikobo-gauth', 'width=520,height=700');
      if (w) { await waitToken(state); await afterSignIn(); return; }
    }
    // ページごと Google へ（ホーム画面アプリ・小窓が開けない時）。戻ったら resume() が続きをする
    let keep = r ? { ...r, blob: undefined } : null;
    if (keep && App.project) keep.projectId = App.project.id;
    if (r && r.blob) {
      if (Store.hasOpfs) { await stash(r.blob); keep.stashed = true; keep.type = r.blob.type; } else keep = null;   // 取っておけない時はサインインだけ
    }
    await App.save();
    saveLs('gdrive-auth', { state, at: Date.now(), mode: 'redirect', resume: keep });
    location.href = url;
    await new Promise(() => {});              // ページを離れるのでここで止まる
  }

  /** 送りかけのファイルを OPFS に取っておく（ページごとサインインしに行く間） */
  async function stash(blob) {
    const pb = progressBox('サインインの前にファイルを取っておいています');
    const sink = await Store.openStream(PENDING);
    try {
      const STEP = 8 * 1024 * 1024;
      for (let p = 0; p < blob.size; p += STEP) {
        await sink.write(new Uint8Array(await blob.slice(p, p + STEP).arrayBuffer()));
        pb.set(`${fmtBytes(Math.min(blob.size, p + STEP))} / ${fmtBytes(blob.size)}`, Math.min(1, (p + STEP) / blob.size));
      }
      await sink.close();
    } catch (e) { await sink.abort(); throw e; } finally { pb.close(); }
  }

  /** 小窓の oauth.html が localStorage に置くトークンを待つ（Google の画面を通ると opener が切れることがあるので postMessage には頼らない） */
  function waitToken(state) {
    return new Promise((res, rej) => {
      let closeDlg = null, finished = false;
      const finish = (fn, v) => {
        if (finished) return;
        finished = true;
        clearInterval(iv);
        removeEventListener('message', onMsg);
        removeEventListener('storage', check);
        if (closeDlg) closeDlg('done');
        fn(v);
      };
      const check = () => {
        const t = loadLs('gdrive-token', {});
        if (t.state !== state) return;
        if (t.token) finish(res, t.token); else finish(rej, new Error(authError(t.error)));
      };
      const onMsg = (e) => { if (e.origin === location.origin && e.data && e.data.eikoboGauth) check(); };
      showDialog({
        title: 'Google にサインイン', body: '開いた画面で Google アカウントを選び、Google Drive へのアクセスを許可してください。',
        buttons: [{ label: 'やめる', value: 'cancel' }], onOpen: (box, close) => { closeDlg = close; },
      }).then((v) => { if (v !== 'done') finish(rej, cancelErr()); });
      const iv = setInterval(check, 500);
      addEventListener('message', onMsg);
      addEventListener('storage', check);
    });
  }

  async function afterSignIn() {
    const t = loadLs('gdrive-token', {});
    if (t.scope && !t.scope.includes('drive.file') && !/auth\/drive(\s|$)/.test(t.scope)) {
      dropToken();
      throw new Error('Google Drive へのアクセスが許可されていません。サインインの画面で Google Drive のチェックを入れてください');
    }
    try {
      const a = await json('/about?fields=user(emailAddress)');
      const mail = a.user && a.user.emailAddress;
      if (mail && mail !== conf().email) setConf({ email: mail, folderId: '' });
    } catch { /* メールが分からなくても使える */ }
  }

  /** 起動時: ページごとサインインして戻ってきたら、やりかけの事を続ける */
  async function resume() {
    const a = loadLs('gdrive-auth', {});
    if (a.mode !== 'redirect' || !a.state) return;
    dropLs('gdrive-auth');
    const t = loadLs('gdrive-token', {});
    const r = a.resume || {};
    try {
      if (t.state !== a.state || Date.now() - a.at > 30 * 60000) return;
      if (!t.token) { toast(authError(t.error), 6000); return; }
      await afterSignIn();
      if (!r.kind) { toast('Google にサインインしました'); return; }
      let blob = null;
      if (r.stashed) {
        const f = await Store.readExport(PENDING);
        if (!f) throw new Error('送りかけのファイルが見つかりませんでした。もう一度押してください');
        blob = new File([f], r.name || 'file', { type: r.type || '' });
      }
      if (r.projectId) await App.openProject(r.projectId);         // 編集画面から行った時は、その作品に戻る
      await act({ ...r, blob });
    } catch (e) { fail(e); } finally {
      await cleanTemp();
      if (r.stashed) await Store.removeExport(PENDING);
    }
  }

  async function signOut() {
    const t = token();
    dropToken();
    setConf({ email: '', folderId: '' });
    if (t) {
      try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch { /* */ }
    }
  }

  // ---- Drive API ------------------------------------------------------------------
  async function api(url, opt = {}) {
    const tk = token();
    if (!tk) throw new Error('Google のサインインが切れました。もう一度押してください');
    const res = await fetch(url.startsWith('http') ? url : API + url, { ...opt, headers: { Authorization: 'Bearer ' + tk, ...(opt.headers || {}) } });
    if (res.status === 401) { dropToken(); throw new Error('Google のサインインが切れました。もう一度押してください'); }
    if (!res.ok) {
      let m = '';
      try { const j = await res.json(); m = j.error && j.error.message; } catch { /* */ }
      throw new Error(`Google Drive: ${m || res.status}`);
    }
    return res;
  }
  async function json(url, opt) { return (await api(url, opt)).json(); }
  function list(q, opt = {}) {
    const p = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', pageSize: '200',
      orderBy: opt.orderBy || 'folder,name_natural', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (opt.pageToken) p.set('pageToken', opt.pageToken);
    return json('/files?' + p);
  }

  /** 保存先「映工房 Web」フォルダ（id は覚えておく。消されていたら探す・作る） */
  async function folder() {
    const c = conf();
    if (c.folderId) {
      try { const f = await json(`/files/${encodeURIComponent(c.folderId)}?fields=id,trashed`); if (!f.trashed) return f.id; } catch (e) { if (!token()) throw e; }
    }
    const q = `name='${esc(FOLDER)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
    const r = await json('/files?' + new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' }));
    let id = r.files[0] && r.files[0].id;
    if (!id) {
      id = (await json('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME, parents: ['root'] }) })).id;
    }
    setConf({ folderId: id });
    return id;
  }

  /** やめられる仕事（送る・受け取る）。cancel() で今の通信も切る */
  function newJob() {
    const job = { cancelled: false, xhr: null, abort: null };
    job.cancel = () => { job.cancelled = true; if (job.xhr) job.xhr.abort(); if (job.abort) job.abort(); };
    return job;
  }
  const sleep = (ms, job) => new Promise((ok, ng) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (job && job.cancelled) { clearInterval(iv); ng(cancelErr()); } else if (Date.now() - t0 >= ms) { clearInterval(iv); ok(); }
    }, 100);
  });

  /** XHR（fetch では送る進み具合が分からないので）。HTTP の状態は返すだけ、通信の失敗は retry 付きの例外 */
  function xhr(method, url, body, headers, onProgress, job) {
    return new Promise((ok, ng) => {
      if (job && job.cancelled) { ng(cancelErr()); return; }
      const x = new XMLHttpRequest();
      x.open(method, url);
      for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      const done = () => { if (job && job.xhr === x) job.xhr = null; };
      x.onload = () => { done(); ok({ status: x.status, text: x.responseText, range: x.getResponseHeader('Range') }); };
      x.onerror = () => { done(); ng(Object.assign(new Error('Google Drive: 通信できませんでした'), { retry: true })); };
      x.ontimeout = x.onerror;
      x.onabort = () => { done(); ng(cancelErr()); };
      if (job) job.xhr = x;
      x.send(body);
    });
  }
  /** 308 の Range（bytes=0-12345）→ 次に送る位置 */
  function rangeNext(range, fallback) {
    const m = /bytes=\d+-(\d+)/.exec(range || '');
    return m ? Number(m[1]) + 1 : fallback;
  }

  /**
   * 「映工房 Web」フォルダへ送る。再開できる形のアップロードを CHUNK ずつ。
   * 通信が切れたら少し待って、受け取り済みの所を聞いてから続ける（6 回まで）。
   */
  async function upload(blob, name, onProgress, job) {
    const parent = await folder();
    const type = blob.type || 'application/octet-stream';
    const meta = JSON.stringify({ name, parents: [parent], mimeType: type });
    const res = await api(UPLOAD + '/files?uploadType=resumable&fields=id,name', {
      method: 'POST', body: meta,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
    });
    const loc = res.headers.get('Location');
    if (!loc) {
      // 送り先が分からない時は 1 回でまとめて送る
      const b = 'eikobo' + Math.random().toString(36).slice(2);
      const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
      const r = await xhr('POST', UPLOAD + '/files?uploadType=multipart&fields=id,name', body,
        { 'Content-Type': 'multipart/related; boundary=' + b, Authorization: 'Bearer ' + token() }, onProgress, job);
      if (r.status < 200 || r.status >= 300) throw new Error(`Google Drive: 送れませんでした（${r.status}）`);
      try { return JSON.parse(r.text); } catch { return {}; }
    }
    const total = blob.size;
    let pos = 0, fails = 0;
    for (;;) {
      if (job && job.cancelled) throw cancelErr();
      const end = Math.min(total, pos + CHUNK);
      let r;
      try {
        r = await xhr('PUT', loc, blob.slice(pos, end), { 'Content-Range': total ? `bytes ${pos}-${end - 1}/${total}` : 'bytes */0' },
          onProgress ? (l) => onProgress(Math.min(total, pos + l), total) : null, job);
      } catch (e) { if (!e.retry) throw e; r = { status: 0 }; }
      if (r.status === 200 || r.status === 201) { try { return JSON.parse(r.text); } catch { return {}; } }
      if (r.status === 308) { pos = rangeNext(r.range, end); fails = 0; continue; }
      if (r.status === 404 || r.status === 410) throw new Error('Google Drive: 送る途中で受け付けが切れました。もう一度送ってください');
      if (r.status && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`Google Drive: 送れませんでした（${r.status}）`);
      if (++fails > 6) throw new Error('Google Drive: 通信できませんでした（何度か送り直しました）');
      await sleep(Math.min(30000, 1000 * 2 ** fails), job);
      // 受け取り済みの所を聞く
      try {
        const s = await xhr('PUT', loc, null, { 'Content-Range': `bytes */${total}` }, null, job);
        if (s.status === 200 || s.status === 201) { try { return JSON.parse(s.text); } catch { return {}; } }
        if (s.status === 308) pos = rangeNext(s.range, s.range === null ? pos : 0);
        else if (s.status === 404 || s.status === 410) throw new Error('Google Drive: 送る途中で受け付けが切れました。もう一度送ってください');
      } catch (e) { if (!e.retry) throw e; }
    }
  }

  /** ファイルを受け取って File に。中身はメモリに溜めずに OPFS（export/gd-…）へ流す。使い終わったら cleanTemp() */
  async function download(f, onProgress, job) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (job && ctl) job.abort = () => ctl.abort();
    let res;
    try {
      res = await api(`/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`, ctl ? { signal: ctl.signal } : {});
    } catch (e) { if (job && job.cancelled) throw cancelErr(); throw e; }
    const type = f.mimeType || res.headers.get('Content-Type') || '';
    const total = +f.size || +res.headers.get('Content-Length') || 0;
    const tmp = uid('gd-');
    temps.add(tmp);
    const sink = await Store.openStream(tmp);
    try {
      let got = 0;
      if (!res.body || !res.body.getReader) {
        const u8 = new Uint8Array(await res.arrayBuffer());
        got = u8.length;
        await sink.write(u8);
      } else {
        const rd = res.body.getReader();
        const BUF = 4 * 1024 * 1024;
        let parts = [], size = 0;
        const flush = async () => {
          if (!size) return;
          const u8 = parts.length === 1 ? parts[0] : new Uint8Array(size);
          if (parts.length > 1) { let o = 0; for (const p of parts) { u8.set(p, o); o += p.length; } }
          parts = []; size = 0;
          await sink.write(u8);
        };
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          parts.push(value); size += value.length; got += value.length;
          if (size >= BUF) await flush();
          if (onProgress) onProgress(got, total);
        }
        await flush();
      }
      const raw = await sink.close();
      return new File([raw], f.name, { type });
    } catch (e) {
      await sink.abort();
      temps.delete(tmp);
      if (job && job.cancelled) throw cancelErr();
      throw e;
    } finally { if (job) job.abort = null; }
  }

  async function cleanTemp() {
    for (const n of temps) await Store.removeExport(n);
    temps.clear();
  }

  /** ドライブのファイルを受け取る（やめられる）。受け取れなかった物はトーストで知らせて飛ばす */
  async function fetchFiles(files) {
    const out = [];
    const job = newJob();
    const pb = progressBox('Google Drive から受け取っています', () => job.cancel());
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const head = files.length > 1 ? `${i + 1} / ${files.length}　` : '';
        pb.set(head + f.name, i / files.length);
        try {
          out.push(await download(f, (g, t) => pb.set(`${head}${f.name}　${fmtBytes(g)}${t ? ' / ' + fmtBytes(t) : ''}`, (i + (t ? g / t : 0)) / files.length), job));
        } catch (e) {
          if (job.cancelled || !token()) throw e;
          toast(`${f.name}: ${msg(e)}`, 6000);
        }
      }
    } finally { pb.close(); }
    return out;
  }

  // ---- 送る ---------------------------------------------------------------------
  async function saveFile(blob, name) {
    const job = newJob();
    const pb = progressBox('Google Drive に保存しています', () => job.cancel(), '画面を開いたままにしてください。');
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* 無くてもよい */ }
    try {
      pb.set(name, 0);
      await upload(blob, name, (i, n) => pb.set(`${name}　${fmtBytes(i)} / ${fmtBytes(n)}`, n ? i / n : 1), job);
      toast(`Google Drive の「${FOLDER}」に保存しました（${fmtBytes(blob.size)}）`, 4000);
    } catch (e) {
      if (e && e.message === 'cancel') toast('Google Drive への保存をやめました');
      else throw e;
    } finally {
      pb.close();
      if (wake) { try { await wake.release(); } catch { /* 済み */ } }
    }
  }

  /** 作品を .zip（Windows 版へ・バックアップと同じ形）にして送る。ids が null なら全部の作品 */
  async function backup(ids, withMedia) {
    await App.save();
    let list = ids ? await Promise.all(ids.map((id) => Store.get('projects', id))) : await Store.all('projects');
    list = list.filter(Boolean).sort((a, b) => b.modified - a.modified);
    if (!list.length) { toast('作品がありません'); return; }
    const job = newJob();
    const pb = progressBox('Google Drive にバックアップしています', () => job.cancel(), '画面を開いたままにしてください。');
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* 無くてもよい */ }
    const missing = [];
    let sent = 0, bytes = 0;
    try {
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const pr = list[i];
        const head = n > 1 ? `${i + 1} / ${n}　${pr.name}` : pr.name;
        const p = Proj.normalize(JSON.parse(JSON.stringify(pr)));
        const { file, missing: miss } = await Ekp.exportZip(p, withMedia, (tx, r) => {
          if (job.cancelled) throw cancelErr();
          pb.set(`${head}：${tx}`, (i + 0.4 * (r || 0)) / n);
        });
        for (const m of miss) missing.push(`${pr.name}: ${m}`);
        const name = `${safe(pr.name)}_${stamp(Date.now())}.zip`;
        await upload(file, name, (s, t) => pb.set(`${head}：送っています ${fmtBytes(s)} / ${fmtBytes(t)}`, (i + 0.4 + 0.6 * (t ? s / t : 1)) / n), job);
        sent++;
        bytes += file.size;
        const c = conf();
        setConf({ lastBackup: Date.now(), backups: { ...(c.backups || {}), [pr.id]: Date.now() } });
      }
    } catch (e) {
      if (!(e && e.message === 'cancel')) throw e;
      toast(sent ? `${sent} 個の作品を送ったところでやめました` : 'バックアップをやめました');
      return;
    } finally {
      pb.close();
      await Store.removeExport('bundle.zip');
      if (wake) { try { await wake.release(); } catch { /* 済み */ } }
    }
    toast(`${sent === 1 ? `「${list[0].name}」` : `${sent} 個の作品`}を Google Drive の「${FOLDER}」に保存しました（${fmtBytes(bytes)}）`, 5000);
    if (missing.length) {
      showDialog({ title: '入れられなかった素材', body: h('div', null,
        h('p', { class: 'modal-text' }, 'この端末に無い素材は .zip に入れられませんでした（作品のデータには残っています）。'),
        h('ul', { class: 'err-list' }, ...missing.map((m) => h('li', null, m)))) });
    }
  }

  // ---- 画面 ---------------------------------------------------------------------
  /** 「映工房 Web」フォルダのバックアップ（.zip / .ekp）の一覧: 戻す・削除 */
  async function restoreDialog() {
    const box = h('div', { class: 'gd-backups' }, h('p', { class: 'hint' }, '読み込み中…'));
    let closeDlg = null;
    const dlg = showDialog({ title: 'Google Drive のバックアップ', body: box, buttons: [{ label: '閉じる', value: null }], wide: true, onOpen: (b, c) => { closeDlg = c; } });
    (async () => {
      try {
        const id = await folder();
        const r = await list(`'${esc(id)}' in parents and trashed=false`, { orderBy: 'modifiedTime desc' });
        const files = r.files.filter((f) => kindOf(f) === 'project');
        box.textContent = '';
        if (!files.length) box.append(h('p', { class: 'hint' }, `マイドライブの「${FOLDER}」フォルダにバックアップがありません。`));
        for (const f of files) {
          const row = h('div', { class: 'gd-backup' },
            h('span', { class: 'gd-ic' }, ICON.project),
            h('span', { class: 'gd-name' }, f.name, h('br'), h('span', { class: 'gd-meta' }, `${fmtDate(Date.parse(f.modifiedTime))}　${fmtBytes(+f.size || 0)}`)),
            h('button', { class: 'small primary', onclick: () => closeDlg && closeDlg({ file: f }) }, '戻す'),
            h('button', { class: 'small danger', onclick: async () => {
              if (!(await confirmDlg(`「${f.name}」を Google Drive のゴミ箱へ移します。`, '削除', true))) return;
              try {
                await api(`/files/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
                row.remove();
              } catch (e) { fail(e); }
            } }, '削除'));
          box.append(row);
        }
        box.append(h('p', { class: 'hint gd-note' }, '戻すと新しい作品として加わります（今の作品は消えません）。'
          + 'ほかの場所の .ekp / .zip は「☁️ Google Drive」→「作品を読み込む」で選べます。'));
      } catch (e) { box.textContent = ''; box.append(h('p', { class: 'hint' }, msg(e))); }
    })();
    const v = await dlg;
    if (!v || !v.file) return;
    const got = await fetchFiles([v.file]);
    if (got.length) await App.importProject(got[0]);
  }

  /** ドライブのファイルを選んでもらい、受け取った File の配列を返す。kinds: video audio image project */
  async function pick(opt = {}) {
    const kinds = opt.kinds || ['video', 'audio', 'image'];
    const multiple = opt.multiple !== false;
    const scope = loadLs('gdrive-token', {}).scope || '';
    const sel = new Map();
    const TABS = [['my', 'マイドライブ'], ['shared', '共有アイテム'], ['recent', '最近'], ['app', FOLDER]];
    let tab = 'my', stack = [{ id: 'root', name: 'マイドライブ' }], query = '', next = null, seq = 0, searchTimer = 0;
    let closeDlg = null;
    const tabRow = h('div', { class: 'gd-tabs' });
    const search = h('input', { type: 'search', placeholder: '名前で検索', autocomplete: 'off' });
    const crumbs = h('div', { class: 'gd-crumbs' });
    const box = h('div', { class: 'gd-list' });
    const foot = h('div', { class: 'hint gd-foot' });
    const drawFoot = () => { foot.textContent = sel.size ? `${sel.size} 個を選んでいます` : 'ファイルをタップして選びます' + (multiple ? '（いくつでも）' : ''); };
    const drawTabs = () => {
      tabRow.textContent = '';
      for (const [k, label] of TABS) tabRow.append(h('button', { class: 'small' + (k === tab && !query ? ' on' : ''), onclick: () => openTab(k) }, label));
    };
    const drawCrumbs = () => {
      crumbs.textContent = '';
      if (query) { crumbs.append(h('span', null, `「${query}」の検索結果`)); return; }
      stack.forEach((f, i) => {
        if (i) crumbs.append(h('span', { class: 'gd-sep' }, '›'));
        crumbs.append(h('button', { class: 'small gd-crumb' + (i === stack.length - 1 ? ' cur' : ''), onclick: () => { stack = stack.slice(0, i + 1); load(); } }, f.name));
      });
    };
    const openTab = async (k) => {
      tab = k; query = ''; search.value = '';
      if (k === 'my') stack = [{ id: 'root', name: 'マイドライブ' }];
      else if (k === 'shared') stack = [{ id: ':shared', name: '共有アイテム' }];
      else if (k === 'recent') stack = [{ id: ':recent', name: '最近' }];
      else {
        try { stack = [{ id: await folder(), name: FOLDER }]; } catch (e) { fail(e); return; }
      }
      load();
    };
    const row = (f) => {
      const k = kindOf(f);
      const meta = k === 'folder' ? '' : [f.modifiedTime ? fmtDate(Date.parse(f.modifiedTime)).slice(0, 10) : '', f.size ? fmtBytes(+f.size) : ''].filter(Boolean).join('　');
      const b = h('button', { class: 'gd-row' + (sel.has(f.id) ? ' on' : '') },
        h('span', { class: 'gd-ic' }, ICON[k]), h('span', { class: 'gd-name' }, f.name), h('span', { class: 'gd-meta' }, meta));
      b.addEventListener('click', () => {
        if (k === 'folder') { stack.push({ id: f.id, name: f.name }); query = ''; search.value = ''; load(); return; }
        if (sel.has(f.id)) sel.delete(f.id);
        else {
          if (!multiple) { sel.clear(); for (const x of $$('.gd-row.on', box)) x.classList.remove('on'); }
          sel.set(f.id, f);
        }
        b.classList.toggle('on', sel.has(f.id));
        drawFoot();
      });
      return b;
    };
    const load = async (more = false) => {
      const my = ++seq;
      drawTabs(); drawCrumbs();
      if (!more) { box.textContent = ''; box.scrollTop = 0; }
      const wait = h('div', { class: 'hint gd-wait' }, '読み込み中…');
      box.append(wait);
      const top = stack[stack.length - 1];
      let q, orderBy;
      if (query) { q = `name contains '${esc(query)}' and trashed=false`; orderBy = 'modifiedTime desc'; }
      else if (top.id === ':shared') { q = 'sharedWithMe=true and trashed=false'; orderBy = 'sharedWithMeTime desc'; }
      else if (top.id === ':recent') { q = `mimeType!='${FOLDER_MIME}' and trashed=false`; orderBy = 'recency desc'; }
      else { q = `'${esc(top.id)}' in parents and trashed=false`; orderBy = 'folder,name_natural'; }
      try {
        const r = await list(q, { orderBy, pageToken: more ? next : null });
        if (my !== seq) return;
        wait.remove();
        for (const f of r.files) { const k = kindOf(f); if (k === 'folder' || kinds.includes(k)) box.append(row(f)); }
        next = r.nextPageToken || null;
        if (next) box.append(h('button', { class: 'small gd-more', onclick: (e) => { e.currentTarget.remove(); load(true); } }, 'もっと見る'));
        else if (!box.querySelector('.gd-row')) box.append(h('div', { class: 'hint gd-wait' }, 'ここには読み込めるファイルがありません'));
      } catch (e) { if (my === seq) wait.textContent = msg(e); }
    };
    const runSearch = () => { clearTimeout(searchTimer); query = search.value.trim(); load(); };
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 450); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runSearch(); } });
    const body = h('div', { class: 'gd-pick' },
      h('div', { class: 'gd-top' }, tabRow, search), crumbs, box, foot,
      h('p', { class: 'hint' }, '表示するのはフォルダと ' + kinds.map((k) => NAMES[k]).join('・') + ' だけです。'),
      scope && !scope.includes('drive.readonly') && !/auth\/drive(\s|$)/.test(scope)
        ? h('p', { class: 'hint' }, 'ドライブ全体を読む許可が無いため、映工房が作ったファイルだけが見えます（「☁️ Google Drive」でサインアウトし、もう一度サインインして許可のチェックを入れてください）。') : null,
      h('div', { class: 'modal-buttons' },
        h('button', { onclick: () => closeDlg && closeDlg(null) }, 'キャンセル'),
        h('button', { class: 'primary', onclick: () => { if (!sel.size) { toast('ファイルを選んでください'); return; } if (closeDlg) closeDlg('ok'); } }, '読み込む')));
    drawFoot();
    const dlg = showDialog({ title: opt.title || 'Google Drive から読み込む', body, buttons: [], wide: true, onOpen: (b, c) => { closeDlg = c; } });
    load();
    const v = await dlg;
    seq++;
    clearTimeout(searchTimer);
    if (v !== 'ok' || !sel.size) return [];
    return fetchFiles([...sel.values()]);
  }

  /** クライアント ID の設定（作り方つき）。保存したら true */
  async function setupDialog() {
    const kami = kamikoboId();
    const cur = conf().clientId || CLIENT_ID;
    const inp = h('input', { type: 'text', class: 'wide-input', value: cur || kami, placeholder: '123456789-xxxx.apps.googleusercontent.com',
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const ro = (v) => h('input', { type: 'text', class: 'wide-input', readonly: true, value: v, onfocus: (e) => e.target.select() });
    const body = h('div', { class: 'gd-setup' },
      h('p', { class: 'modal-text' }, 'Google Drive を使うには、Google Cloud で「OAuth クライアント ID」を 1 つ作って下に貼ります（無料・最初の 1 回だけ）。'),
      kami && !cur ? h('p', { class: 'modal-text gd-kami' }, '紙工房 Web で設定したクライアント ID を入れておきました。Google Cloud の「認証情報」でその ID を開き、「承認済みのリダイレクト URI」に下の URI を足して保存すれば、そのまま使えます（JavaScript 生成元は同じです）。') : null,
      h('ol', null,
        h('li', null, 'console.cloud.google.com を開いて、プロジェクトを作る（紙工房 Web と同じプロジェクトでよい）'),
        h('li', null, '「API とサービス」→「ライブラリ」で「Google Drive API」を有効にする'),
        h('li', null, '「OAuth 同意画面」で「外部」を選び、アプリ名（例: 映工房 Web）を入れ、「テストユーザー」に自分の Gmail を追加する'),
        h('li', null, '「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」で、次の 2 つを登録する',
          h('div', { class: 'hint' }, '承認済みの JavaScript 生成元'), ro(location.origin),
          h('div', { class: 'hint' }, '承認済みのリダイレクト URI'), ro(redirectUri())),
        h('li', null, 'できた「クライアント ID」を下に貼る')),
      h('label', { class: 'gd-field' }, 'クライアント ID', inp),
      h('p', { class: 'hint' }, 'サインインで「このアプリは Google で確認されていません」と出たら「続行」を押します（自分で作ったアプリのため）。'
        + '許可の画面では Google Drive の項目にチェックを入れてください。'));
    const v = await showDialog({ title: 'Google Drive の設定', body, wide: true,
      buttons: [{ label: 'やめる', value: null }, { label: '保存', primary: true, value: () => inp.value.trim() }] });
    if (v === null || v === undefined) return false;
    if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { toast('「….apps.googleusercontent.com」の形の ID を貼ってください', 5000); return false; }
    if (v !== conf().clientId) { dropToken(); setConf({ clientId: v, folderId: '' }); }
    toast(configured() ? 'Google Drive を使えるようにしました' : 'Google Drive の設定を消しました');
    return true;
  }

  /** 作品（ids、null なら全部）をバックアップする前の確かめ。ボタンの中で go を呼ぶ（小窓を開くため） */
  async function backupDialog(ids, label) {
    if (!configured()) { if (!(await setupDialog())) return; }
    const withMedia = h('input', { type: 'checkbox', checked: true });
    let started = null;
    await showDialog({
      title: 'Google Drive にバックアップ',
      body: h('div', { class: 'form' },
        h('p', { class: 'modal-text' }, `${label}を .zip（「Windows 版へ・バックアップ」と同じ形）にして、マイドライブの「${FOLDER}」フォルダに保存します。`),
        h('label', { class: 'inline' }, withMedia, '素材のファイルも入れる（大きくなります）'),
        h('p', { class: 'hint' }, '戻す時は作品一覧の「☁️ Google Drive」→「バックアップから戻す」。Windows 版でも展開して .ekp を開けます。')),
      buttons: [{ label: 'やめる', value: null }, { label: '保存する', primary: true, value: () => { started = go({ kind: 'backup', ids, media: withMedia.checked }); return 'go'; } }],
    });
    if (started) await started;
  }

  /** 作品一覧の「☁️ Google Drive」 */
  async function homeMenu() {
    if (!configured()) { if (await setupDialog()) homeMenu(); return; }
    const c = conf();
    const who = token() ? `サインイン中${c.email ? '（' + c.email + '）' : ''}` : c.email ? `${c.email}（使う時にサインインします）` : 'まだサインインしていません（使う時にサインインします）';
    let closeDlg = null, next = null;
    const btn = (label, fn, cls) => h('button', { class: 'block' + (cls ? ' ' + cls : ''), onclick: () => { next = fn(); if (closeDlg) closeDlg('x'); } }, label);
    const body = h('div', { class: 'gd-menu' },
      h('p', { class: 'hint' }, `${who}`, h('br'), `保存先: マイドライブの「${FOLDER}」　最後のバックアップ: ${c.lastBackup ? fmtDate(c.lastBackup) : 'まだ'}`),
      btn('作品を読み込む（.ekp / .zip）…', () => go({ kind: 'open' }), 'primary'),
      btn('バックアップから戻す…', () => go({ kind: 'restore' })),
      btn('すべての作品をバックアップ…', () => backupDialog(null, 'すべての作品')),
      h('div', { class: 'gd-row-buttons' },
        h('button', { class: 'small', onclick: () => { next = setupDialog().then((ok) => { if (ok) homeMenu(); }); if (closeDlg) closeDlg('x'); } }, 'クライアント ID…'),
        c.email || token() ? h('button', { class: 'small', onclick: () => { next = signOut().then(() => toast('サインアウトしました')); if (closeDlg) closeDlg('x'); } }, 'サインアウト') : null),
      h('p', { class: 'hint' }, '作品ごとのバックアップは作品の「⋯」から。素材は編集画面の「素材」の ☁️ から、書き出した動画は書き出しの後の「☁️ Google Drive に保存」で。'));
    await showDialog({ title: '☁️ Google Drive', body, buttons: [{ label: '閉じる', value: null }], onOpen: (b, cl) => { closeDlg = cl; } });
    if (next) await next;
  }

  return { configured, go, resume, homeMenu, backupDialog, setupDialog, signOut, upload, kindOf, FOLDER };
})();
