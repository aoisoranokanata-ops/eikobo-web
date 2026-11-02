/* ------------------------------------------------------------
   映工房 Web — 画面のつなぎ（作品一覧・編集画面・素材・保存・キーボード）
   ------------------------------------------------------------ */
const App = (() => {
  let P = null;                   // 開いている作品
  const hist = new Proj.History();
  let saveTimer = 0;
  let dirty = false;
  let liveBefore = null;
  let mediaMissing = new Set();
  let relinkId = null;
  let seekRefresh = 0;
  const STD_FPS = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]];

  // ---- 保存 -------------------------------------------------------------------
  function badge(state) {
    const b = $('#saveBadge');
    if (!b) return;
    b.className = 'badge ' + state;
    b.textContent = { saved: '保存済み', saving: '保存中…', unsaved: '● 未保存', error: '● 保存できません' }[state] || '';
  }

  function markDirty() {
    if (!P) return;
    dirty = true;
    P.modified = Date.now();
    badge('unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 800);
  }

  function cover() {
    const vids = Object.values(P.clips).filter((c) => c.media && P.media[c.media] && Proj.track(P, c.track).kind === 'video').sort((a, b) => a.start - b.start);
    for (const c of vids) {
      const r = Media.rec(c.media);
      if (r && r.thumbs && r.thumbs.length) return r.thumbs[0];
    }
    return null;
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!P || !dirty) return;
    dirty = false;
    badge('saving');
    try {
      P.playhead = Math.round(Engine.position());
      P.cover = cover();
      P.total = Proj.duration(P) / Proj.fps(P);
      await Store.put('projects', JSON.parse(JSON.stringify(P)));
      badge(dirty ? 'unsaved' : 'saved');
    } catch (err) {
      console.error(err);
      dirty = true;
      badge('error');
      saveTimer = setTimeout(save, 4000);   // 自動でもう一度
    }
  }

  // ---- 編集と履歴 ---------------------------------------------------------------
  function edit(label, fn) {
    if (!P) return false;
    const before = Proj.snapshot(P);
    try { fn(); } catch (err) {
      Proj.restore(P, before);
      toast(err.message || String(err));
      afterChange();
      return false;
    }
    const after = Proj.snapshot(P);
    if (after !== before) {
      hist.push(label, before, after);
      afterChange();
    }
    return true;
  }

  function begin() { if (!liveBefore) liveBefore = Proj.snapshot(P); }
  function live(fn) { fn(); Engine.refresh(); Timeline.draw(); }
  function end(label) {
    if (!liveBefore) return;
    const after = Proj.snapshot(P);
    if (after !== liveBefore) hist.push(label, liveBefore, after);
    liveBefore = null;
    afterChange();
  }

  function afterChange() {
    Timeline.prune();
    Timeline.draw();
    Engine.refresh();
    Inspector.show(Timeline.primaryClip() ? Timeline.primaryClip().id : null);
    Mixer.refresh();
    updateUi();
    markDirty();
  }

  function undo() {
    const e = hist.undo.pop();
    if (!e) return;
    Proj.restore(P, e.before);
    hist.redo.push(e);
    afterChange();
    renderBin();
    toast('取り消し: ' + e.label, 1400);
  }

  function redo() {
    const e = hist.redo.pop();
    if (!e) return;
    Proj.restore(P, e.after);
    hist.undo.push(e);
    afterChange();
    renderBin();
    toast('やり直し: ' + e.label, 1400);
  }

  function updateUi() {
    if (!P) return;
    $('#btnUndo').disabled = !hist.undo.length;
    $('#btnRedo').disabled = !hist.redo.length;
    const has = Timeline.selected().length > 0;
    $('#btnDelete').disabled = !has;
    $('#btnRipple').disabled = !has;
    const c = Timeline.primaryClip();
    $('#btnUnlink').disabled = !(c && c.link);
    $('#durTc').textContent = ' / ' + fmtTC(Proj.duration(P), Proj.fps(P));
    $('#btnName').textContent = P.name;
  }

  function updateTc(fr) {
    $('#tc').textContent = fmtTC(fr, Proj.fps(P));
  }

  // ---- 作品一覧 -------------------------------------------------------------------
  async function showHome() {
    await closeProject();
    $('#editor').hidden = true;
    $('#home').hidden = false;
    document.title = '映工房 Web';
    await gcMedia();
    renderHome();
  }

  async function renderHome() {
    const grid = $('#projectGrid');
    grid.textContent = '';
    const list = (await Store.all('projects')).sort((a, b) => b.modified - a.modified);
    if (!list.length) {
      grid.append(h('div', { class: 'empty-home' },
        h('p', null, 'まだ作品がありません。'),
        h('p', null, '「＋ 新しい作品」から始めて、写真アプリやファイルから動画・音声・画像を読み込みます。')));
    }
    for (const pr of list) {
      const more = h('button', { class: 'card-more', 'aria-label': 'その他', onclick: (e) => { e.stopPropagation(); projectMenu(pr); } }, '⋯');
      grid.append(h('div', { class: 'card', onclick: () => openProject(pr.id) },
        h('div', { class: 'card-cover' }, pr.cover ? h('img', { src: pr.cover, alt: '' }) : h('span', null, '映'), h('span', { class: 'card-dur' }, fmtDur(pr.total || 0))),
        h('div', { class: 'card-body' }, h('div', { class: 'card-name' }, pr.name), h('div', { class: 'card-meta' }, `${pr.width}×${pr.height}・${fmtDate(pr.modified)}`), more)));
    }
    const est = await Store.estimate();
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const info = $('#storageInfo');
    info.textContent = '';
    if (est) info.append(`使っている容量 ${fmtBytes(est.usage || 0)}（この端末で使える目安 ${fmtBytes(est.quota || 0)}）　`);
    info.append(persisted ? '保存領域は固定済み' : h('button', { class: 'small', onclick: async () => { const ok = await Store.persist(); toast(ok ? '保存領域を固定しました（端末が勝手に消さなくなります）' : '固定できませんでした（ホーム画面に追加すると固定されやすくなります）'); renderHome(); } }, '保存領域を固定する'));
    if (!Store.hasOpfs) info.append(h('div', { class: 'warn' }, 'このブラウザは素材の保存に対応していません。再読み込みすると素材が消えます。'));
    $('#homeVer').textContent = 'v' + APP_VERSION;
  }

  async function projectMenu(pr) {
    const v = await showDialog({
      title: pr.name,
      buttons: [{ label: '名前を変える', value: 'rename' }, { label: '複製', value: 'dup' }, { label: 'Windows 版へ・バックアップ（.zip）', value: 'zip' }, { label: '☁️ Google Drive にバックアップ', value: 'drive' }, { label: '削除', value: 'del', danger: true }, { label: '閉じる', value: null }],
    });
    if (v === 'zip') { await exportBundle(pr); return; }
    if (v === 'drive') { await GDrive.backupDialog([pr.id], `「${pr.name}」`); return; }
    if (v === 'rename') {
      const name = await askText('作品の名前', pr.name);
      if (name) { pr.name = name; await Store.put('projects', pr); renderHome(); }
    } else if (v === 'dup') {
      const copy = JSON.parse(JSON.stringify(pr));
      copy.id = uid('p');
      copy.name = pr.name + ' のコピー';
      copy.created = copy.modified = Date.now();
      await Store.put('projects', copy);
      renderHome();
    } else if (v === 'del') {
      if (await confirmDlg(`「${pr.name}」を削除します。元に戻せません。`, '削除する', true)) {
        await Store.del('projects', pr.id);
        await gcMedia();
        renderHome();
      }
    }
  }

  /** どの作品からも使われていない素材を消す（作品一覧に戻った時だけ。編集中は取り消しで戻る可能性がある） */
  async function gcMedia() {
    try {
      const projects = await Store.all('projects');
      const used = new Set();
      for (const pr of projects) for (const id of Object.keys(pr.media || {})) used.add(id);
      for (const r of await Store.all('media')) if (!used.has(r.id)) await Media.remove(r.id);
    } catch (err) { console.warn('素材の片付けに失敗', err); }
  }

  /** 作品を ZIP（.ekp ＋ 素材）にして渡す */
  async function exportBundle(pr) {
    const withMedia = h('input', { type: 'checkbox', checked: true });
    const size = Object.keys(pr.media || {}).length;
    const ok = await showDialog({
      title: 'Windows 版へ・バックアップ',
      body: h('div', { class: 'form' },
        h('p', { class: 'modal-text' }, `「${pr.name}」を .zip にします。Windows で展開して、中の .ekp を映工房（Windows 版）で開いてください。この Web 版の「読み込む」でも戻せます。`),
        h('label', { class: 'inline' }, withMedia, `素材のファイルも入れる（${size} 個。大きくなります）`),
        h('p', { class: 'hint' }, '外すと作品のデータ（.ekp）だけになります。素材がもう Windows にある時に。')),
      buttons: [{ label: 'やめる', value: false }, { label: '書き出す', value: true, primary: true }],
    });
    if (!ok) return;
    const p = Proj.normalize(JSON.parse(JSON.stringify(pr)));
    const pb = progressBox('まとめています');
    let res;
    try { res = await Ekp.exportZip(p, withMedia.checked, (tx, r) => pb.set(tx, r)); } catch (err) { pb.close(); showDialog({ title: '書き出せませんでした', body: String(err.message || err) }); return; }
    pb.close();
    const { file, missing } = res;
    const url = URL.createObjectURL(file);
    const buttons = [];
    if (navigator.canShare && navigator.canShare({ files: [file] })) buttons.push({ label: '共有・保存', primary: true, value: () => { navigator.share({ files: [file] }).catch(() => {}); return 'keep'; } });
    buttons.push({ label: 'ダウンロード', value: () => { const a = h('a', { href: url, download: file.name }); document.body.append(a); a.click(); a.remove(); return 'keep'; } });
    let drive = null;
    if (GDrive.configured()) buttons.push({ label: '☁️ Google Drive に保存', value: () => { drive = GDrive.go({ kind: 'upload', blob: file, name: file.name }); return 'keep'; } });
    buttons.push({ label: '閉じる', value: null });
    const body = h('p', { class: 'modal-text' }, `${file.name}（${fmtBytes(file.size)}）` + (missing.length ? `
この端末に無い素材は入れられませんでした: ${missing.join('、')}` : ''));
    for (;;) {
      const v = await showDialog({ title: '書き出しました', body, buttons });
      if (drive) { await drive; drive = null; }         // 送り終わってから出し直す
      if (v !== 'keep') break;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** .ekp・.zip を読み込んで新しい作品に */
  async function importProject(file) {
    Store.persist();
    const pb = progressBox('作品を読み込んでいます');
    let r;
    try {
      await Telop.load();
      r = await Ekp.importFile(file, (tx, x) => pb.set(tx, x));
    } catch (err) { pb.close(); showDialog({ title: '読み込めませんでした', body: String(err.message || err) }); return; }
    pb.close();
    await Store.put('projects', JSON.parse(JSON.stringify(r.project)));
    await openProject(r.project.id);
    if (r.missing.length) toast(`素材 ${r.found.length} 個を読み込みました。見つからない素材 ${r.missing.length} 個は「素材」から選べます`, 6000);
    else toast(`作品と素材 ${r.found.length} 個を読み込みました`);
  }

  async function newProject() {
    const name = await askText('新しい作品の名前', '無題の作品', '作る');
    if (!name) return;
    const pr = Proj.create(name);
    await Store.put('projects', pr);
    await openProject(pr.id);
  }

  // ---- 編集画面 -------------------------------------------------------------------
  async function openProject(id) {
    const pr = await Store.get('projects', id);
    if (!pr) { toast('作品が見つかりません'); return; }
    P = Proj.normalize(pr);
    hist.clear();
    dirty = false;
    await Media.load(Object.keys(P.media));
    mediaMissing = new Set();
    for (const mid of Object.keys(P.media)) if (!(await Store.readFile(mid))) mediaMissing.add(mid);
    $('#home').hidden = true;
    $('#editor').hidden = false;
    document.title = P.name + ' — 映工房 Web';
    Engine.setProject(P);
    Timeline.setProject(P);
    Inspector.setProject(P);
    Mixer.setProject(P);
    renderBin();
    badge('saved');
    requestAnimationFrame(() => { Engine.resize(); Timeline.resize(); Timeline.fitAll(); });
    updateUi();
    updateTc(Engine.position());
    Engine.preloadAudio();
    if (mediaMissing.size) toast(`見つからない素材が ${mediaMissing.size} 個あります（素材の一覧で差し替えられます）`, 5000);
  }

  async function closeProject() {
    if (!P) return;
    if (Recorder.active()) await Recorder.stop();
    Engine.stop();
    Mixer.toggle(false);
    await save();
    Engine.setProject(null);
    Media.release();
    P = null;
  }

  // ---- 素材 ----------------------------------------------------------------------
  function renderBin() {
    const list = $('#binList');
    list.textContent = '';
    $('#btnDriveMedia').hidden = !GDrive.configured();
    if (!P) return;
    const items = Object.values(P.media);
    if (mediaMissing.size) {
      list.append(h('div', { class: 'bin-missing' },
        h('span', null, `見つからない素材が ${mediaMissing.size} 個あります。`),
        h('button', { class: 'small primary', onclick: () => { relinkId = '*'; $('#fileInput').click(); } }, 'まとめて選ぶ（名前で結びます）'),
        GDrive.configured() ? h('button', { class: 'small', onclick: () => GDrive.go({ kind: 'relink' }) }, '☁️ Google Drive から選ぶ（名前で結びます）') : null));
    }
    if (!items.length) {
      list.append(h('div', { class: 'bin-empty' }, '「＋ 読み込む」から動画・音声・画像を追加します。', h('br'), '写真アプリ・ファイル・iCloud Drive から選べます。'));
      return;
    }
    for (const m of items) {
      const r = Media.rec(m.id);
      const used = Object.values(P.clips).some((c) => c.media === m.id);
      const missing = mediaMissing.has(m.id);
      const thumb = r && r.thumbs && r.thumbs[0] ? h('img', { src: r.thumbs[0], alt: '' }) : h('span', { class: 'bin-icon' }, m.kind === 'audio' ? '♪' : '?');
      const meta = m.kind === 'image' ? `画像 ${m.width}×${m.height}` : m.kind === 'audio' ? `音声 ${fmtDur(m.duration)}` : `動画 ${fmtDur(m.duration)}・${m.width}×${m.height}${m.has_audio ? '' : '・音なし'}`;
      list.append(h('div', { class: 'bin-item' + (missing ? ' missing' : '') },
        h('div', { class: 'bin-thumb' }, thumb),
        h('div', { class: 'bin-info' }, h('div', { class: 'bin-name' }, m.name), h('div', { class: 'bin-meta' }, missing ? 'ファイルが見つかりません' : meta + (used ? '' : '・未使用'))),
        missing
          ? h('button', { class: 'small', onclick: () => relink(m.id) }, '差し替え')
          : h('button', { class: 'small primary', title: '再生位置に置く', onclick: () => place(m.id) }, '＋'),
        h('button', { class: 'small', 'aria-label': 'その他', onclick: () => mediaMenu(m) }, '⋯')));
    }
  }

  function place(mid, frame) {
    const m = P.media[mid];
    if (!m) return;
    let placed = [];
    const at = frame !== undefined ? frame : Math.round(Engine.position());
    if (edit('素材を置く', () => { placed = Proj.insertMedia(P, m, at); })) {
      Timeline.select(placed.map((c) => c.id), placed[0] && placed[0].id);
      Engine.preloadAudio();
      renderBin();
      closeDrawers();
    }
  }

  async function mediaMenu(m) {
    const used = Object.values(P.clips).filter((c) => c.media === m.id);
    const v = await showDialog({
      title: m.name,
      body: used.length ? `タイムラインで ${used.length} か所使っています。` : 'タイムラインでは使っていません。',
      buttons: [
        { label: '末尾に置く', value: 'end' },
        { label: '作品から外す', value: 'remove', danger: true },
        { label: '閉じる', value: null },
      ],
    });
    if (v === 'end') place(m.id, Proj.duration(P));
    else if (v === 'remove') {
      if (used.length && !(await confirmDlg(`使っている ${used.length} 個のクリップも消えます。`, '外す', true))) return;
      edit('素材を外す', () => {
        for (const c of used) delete P.clips[c.id];
        delete P.media[m.id];
      });
      renderBin();
    }
  }

  function relink(mid) {
    relinkId = mid;
    $('#fileInput').click();
  }

  /** 素材を差し替える [[素材 ID, File]]。同じ ID のまま取り込み直す（縮小画像・波形も作り直す） */
  async function relinkFiles(pairs) {
    const pb = progressBox('素材を差し替えています');
    let ok = 0;
    const errors = [];
    for (let i = 0; i < pairs.length; i++) {
      const [mid, f] = pairs[i];
      try {
        const rec = await Media.importFile(f, (tx, r) => pb.set(`${i + 1} / ${pairs.length}　${f.name}${tx ? '：' + tx : ''}`, r !== null && r !== undefined ? (i + r) / pairs.length : null), { id: mid });
        P.media[mid] = { ...P.media[mid], ...Media.projectInfo(rec), name: P.media[mid].name || rec.name };
        mediaMissing.delete(mid);
        ok++;
      } catch (err) { errors.push(`${f.name}: ${err.message}`); }
    }
    pb.close();
    markDirty();
    Engine.setProject(P);
    Engine.preloadAudio();
    Timeline.draw();
    renderBin();
    toast(`${ok} 個を差し替えました` + (mediaMissing.size ? `（まだ見つからない素材 ${mediaMissing.size} 個）` : ''), 4000);
    if (errors.length) showDialog({ title: '差し替えられなかったファイル', body: h('ul', { class: 'err-list' }, ...errors.map((e) => h('li', null, e))) });
  }

  async function onFiles(files) {
    if (!files.length || !P) return;
    if (relinkId) {
      const mid = relinkId;
      relinkId = null;
      if (mid === '*') await linkFiles(files);
      else await relinkFiles([[mid, files[0]]]);
      return;
    }
    await importFiles(Array.from(files));
  }

  /** 見つからない素材を、名前の合うファイルで差し替える（「まとめて選ぶ」・Google Drive から） */
  async function linkFiles(files) {
    if (!P) return;
    const pairs = [...mediaMissing].map((id) => [id, files.find((f) => f.name.toLowerCase() === (P.media[id].name || '').toLowerCase() || f.name.toLowerCase() === Ekp.baseName(P.media[id].path).toLowerCase())]).filter(([, f]) => f);
    if (!pairs.length) { toast('名前の合うファイルがありませんでした'); return; }
    await relinkFiles(pairs);
  }

  async function importFiles(files) {
    Store.persist();
    const pb = progressBox('素材を読み込んでいます');
    const added = [];
    const errors = [];
    const n = files.length;
    for (let i = 0; i < n; i++) {
      const f = files[i];
      const head = n > 1 ? `${i + 1} / ${n}　` : '';
      pb.set(head + f.name, i / n);
      try {
        const rec = await Media.importFile(f, (text, r) => pb.set(text ? `${head}${f.name}：${text}` : null, r !== null && r !== undefined ? (i + r) / n : null));
        added.push(rec);
      } catch (err) {
        console.error(err);
        errors.push(`${f.name}：${err && err.name === 'QuotaExceededError' ? '端末の空き容量が足りません' : (err.message || err)}`);
      }
    }
    pb.close();
    if (added.length) {
      const wasEmpty = Object.keys(P.clips).length === 0;
      let placed = [];
      edit('素材の読み込み', () => {
        for (const r of added) P.media[r.id] = Media.projectInfo(r);
        if (!P.configured && wasEmpty) {
          const v = added.find((r) => r.kind === 'video');
          if (v) configureFrom(v);
        }
        // タイムラインが空なら、読み込んだ順に並べる
        if (wasEmpty) {
          let at = 0;
          for (const r of added) {
            const cs = Proj.insertMedia(P, P.media[r.id], at, { vtrack: r.kind === 'audio' ? undefined : 'v1', atrack: 'a1' });
            placed = placed.concat(cs);
            at = Math.max(...cs.map(Proj.end));
          }
        }
      });
      renderBin();
      Engine.preloadAudio();
      if (placed.length) { Timeline.fitAll(); toast(`${added.length} 個を読み込んで、タイムラインに並べました`); } else toast(`${added.length} 個を読み込みました（＋ で再生位置に置けます）`);
    }
    if (errors.length) {
      showDialog({ title: '読み込めなかったファイル', body: h('ul', { class: 'err-list' }, ...errors.map((e) => h('li', null, e))) });
    }
  }

  function nearestFps(fps) {
    let best = null;
    for (const [n, d] of STD_FPS) {
      const diff = Math.abs(n / d - fps) / fps;
      if (diff < 0.006 && (!best || diff < best.diff)) best = { n, d, diff };
    }
    return best ? [best.n, best.d] : [Math.max(1, Math.round(fps)), 1];
  }

  function configureFrom(rec) {
    const even = (x) => Math.max(2, Math.round(x / 2) * 2);
    P.width = even(rec.width);
    P.height = even(rec.height);
    const [n, d] = nearestFps(rec.fps || 30);
    Proj.setFps(P, n, d);
    P.configured = true;
    requestAnimationFrame(() => Engine.resize());
    setTimeout(() => toast(`作品を ${P.width}×${P.height}・${Math.round(n / d * 1000) / 1000}fps にしました（作品の設定で変えられます）`, 4000), 2700);
  }

  // ---- 作品の設定 ----------------------------------------------------------------
  async function settingsDialog() {
    const sizes = [['1920x1080', '1920 × 1080（横・フル HD）'], ['1080x1920', '1080 × 1920（縦・ショート）'], ['1080x1080', '1080 × 1080（正方形）'], ['1080x1350', '1080 × 1350（縦 4:5）'], ['3840x2160', '3840 × 2160（4K）'], ['2160x3840', '2160 × 3840（縦 4K）'], ['1280x720', '1280 × 720（HD）']];
    const cur = `${P.width}x${P.height}`;
    if (!sizes.some((s) => s[0] === cur)) sizes.unshift([cur, `${P.width} × ${P.height}（今の大きさ）`]);
    const name = h('input', { type: 'text', value: P.name, class: 'wide-input' });
    const size = h('select', null, ...sizes.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
    const fpsNow = `${P.fps_num}/${P.fps_den}`;
    const fpsList = STD_FPS.map(([n, d]) => [`${n}/${d}`, `${Math.round(n / d * 1000) / 1000} fps`]);
    if (!fpsList.some((x) => x[0] === fpsNow)) fpsList.unshift([fpsNow, `${Math.round(Proj.fps(P) * 1000) / 1000} fps`]);
    const fps = h('select', null, ...fpsList.map(([v, t]) => h('option', { value: v, selected: v === fpsNow }, t)));
    const body = h('div', { class: 'form' },
      h('label', null, '名前', name),
      h('label', null, '大きさ', size),
      h('label', null, 'フレームレート', fps),
      h('p', { class: 'hint' }, 'フレームレートを変えても、クリップの位置と長さは秒で同じに保ちます。'));
    const ok = await showDialog({ title: '作品の設定', body, buttons: [{ label: 'やめる', value: false }, { label: '決める', value: true, primary: true }] });
    if (!ok) return;
    const [w, hh] = size.value.split('x').map(Number);
    const [n, d] = fps.value.split('/').map(Number);
    edit('作品の設定', () => {
      P.name = name.value.trim() || P.name;
      P.width = w; P.height = hh;
      Proj.setFps(P, n, d);
      P.configured = true;
    });
    document.title = P.name + ' — 映工房 Web';
    Engine.resize();
    Timeline.fitAll();
  }

  async function trackMenu(t) {
    const empty = !Object.values(P.clips).some((c) => c.track === t.id);
    const canDel = empty && Proj.tracksOf(P, t.kind).length > 1;
    const vol = h('input', { type: 'range', min: -40, max: 12, step: 0.5, value: t.volume_db || 0 });
    const volLabel = h('span', null, (t.volume_db || 0) + ' dB');
    vol.addEventListener('input', () => { volLabel.textContent = vol.value + ' dB'; });
    const body = t.kind === 'audio' ? h('div', { class: 'form' }, h('label', null, 'トラックの音量 ', volLabel, vol)) : null;
    const v = await showDialog({
      title: 'トラック ' + t.name, body,
      buttons: [{ label: '名前を変える', value: 'rename' }, canDel ? { label: 'トラックを削除', value: 'del', danger: true } : null, { label: '閉じる', value: 'close', primary: true }].filter(Boolean),
    });
    if (t.kind === 'audio' && Number(vol.value) !== (t.volume_db || 0)) edit('トラックの音量', () => { Proj.track(P, t.id).volume_db = Number(vol.value); });
    if (v === 'rename') {
      const name = await askText('トラックの名前', t.name);
      if (name) edit('トラックの名前', () => { Proj.track(P, t.id).name = name; });
    } else if (v === 'del') {
      edit('トラックを削除', () => { P.tracks = P.tracks.filter((x) => x.id !== t.id); });
    }
  }

  async function addTrackDialog() {
    const v = await showDialog({ title: 'トラックを足す', buttons: [{ label: '映像トラック', value: 'video' }, { label: '音声トラック', value: 'audio' }, { label: 'やめる', value: null }] });
    if (v) edit('トラックを足す', () => Proj.addTrack(P, v));
  }

  // ---- テロップ・字幕 --------------------------------------------------------------
  function addText() {
    let c = null;
    if (edit('テキストを置く', () => { c = Proj.insertText(P, Engine.position(), 'テロップ', Telop.defaultTextStyle()); })) {
      Timeline.select([c.id], c.id);
      $('#inspector').classList.add('open');
      setTimeout(() => { const ta = $('#inspector .insp-textarea'); if (ta) { ta.focus(); ta.select(); } }, 50);
    }
  }

  async function subtitleMenu() {
    const n = Proj.subtitleClips(P).length;
    const v = await showDialog({
      title: '字幕',
      body: n ? `字幕が ${n} 個あります。` : 'まだ字幕がありません。',
      buttons: [
        { label: '再生位置に字幕を足す', value: 'add', primary: true },
        { label: 'SRT を読み込む', value: 'import' },
        { label: 'SRT を書き出す', value: 'export' },
        { label: '字幕全体の見た目', value: 'style' },
        { label: '閉じる', value: null },
      ],
    });
    if (v === 'add') {
      let c = null;
      if (edit('字幕を足す', () => { c = Proj.insertSubtitle(P, Engine.position(), '字幕'); })) {
        Timeline.select([c.id], c.id);
        $('#inspector').classList.add('open');
        setTimeout(() => { const ta = $('#inspector .insp-textarea'); if (ta) { ta.focus(); ta.select(); } }, 50);
      }
    } else if (v === 'import') $('#srtInput').click();
    else if (v === 'export') exportSrt();
    else if (v === 'style') subtitleStyleDialog();
  }

  async function importSrt(file) {
    let text;
    try {
      const buf = await file.arrayBuffer();
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      try { text = new TextDecoder('shift_jis').decode(await file.arrayBuffer()); } catch { text = ''; }
    }
    const cues = Srt.parse(text);
    if (!cues.length) { toast('字幕が見つかりませんでした（SRT の形か確かめてください）'); return; }
    let r = null;
    edit('SRT の読み込み', () => { r = Proj.addCues(P, cues); });
    if (r) toast(`${r.count} 個の字幕を ${r.track.name} に並べました`);
  }

  function exportSrt() {
    const text = Srt.fromProject(P);
    if (!text) { toast('字幕がありません'); return; }
    const file = new File(['﻿' + text], (P.name || '字幕').replace(/[\\/:*?"<>|]/g, '_') + '.srt', { type: 'application/x-subrip' });
    const url = URL.createObjectURL(file);
    const buttons = [];
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      buttons.push({ label: '共有・保存', primary: true, value: () => { navigator.share({ files: [file] }).catch(() => {}); return null; } });
    }
    buttons.push({ label: 'ダウンロード', value: () => { const a = h('a', { href: url, download: file.name }); document.body.append(a); a.click(); a.remove(); return null; } });
    buttons.push({ label: '閉じる', value: null });
    showDialog({ title: 'SRT を書き出す', body: `${file.name}（字幕 ${Proj.subtitleClips(P).length} 個）`, buttons }).then(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
  }

  async function subtitleStyleDialog() {
    const s = { ...Telop.defaultSubtitleStyle(), ...(P.subtitle_style || {}) };
    const fonts = Telop.FONT_CHOICES.slice();
    if (!fonts.some(([f]) => f === s.font)) fonts.unshift([s.font, s.font]);
    const font = h('select', null, ...fonts.map(([v, t]) => h('option', { value: v, selected: v === s.font }, t)));
    const size = h('input', { type: 'number', min: 16, max: 200, value: s.size });
    const color = h('input', { type: 'color', value: (s.color || '#ffffff').slice(0, 7) });
    const outline = h('input', { type: 'number', min: 0, max: 30, value: s.outline || 0 });
    const ocolor = h('input', { type: 'color', value: (s.outline_color || '#000000').slice(0, 7) });
    const box = h('input', { type: 'checkbox', checked: !!s.box });
    const bcolor = h('input', { type: 'color', value: (s.box_color || '#000000a0').slice(0, 7) });
    const align = h('select', null, ...[['bottom', '下'], ['top', '上'], ['middle', '中央']].map(([v, t]) => h('option', { value: v, selected: v === s.align }, t)));
    const margin = h('input', { type: 'number', min: 0, max: 500, value: s.margin ?? 60 });
    const body = h('div', { class: 'form two' },
      h('label', null, '書体', font), h('label', null, '大きさ（1080p で px）', size),
      h('label', null, '文字の色', color), h('label', null, '縁の太さ', outline), h('label', null, '縁の色', ocolor),
      h('label', { class: 'inline' }, box, '帯を付ける'), h('label', null, '帯の色', bcolor),
      h('label', null, '位置', align), h('label', null, '端からの距離（px）', margin),
      h('p', { class: 'hint wide' }, '話者ごとの吹き出しは、字幕クリップの「話者」に名前を入れると付きます。'));
    const ok = await showDialog({ title: '字幕全体の見た目', body, buttons: [{ label: 'やめる', value: false }, { label: '決める', value: true, primary: true }] });
    if (!ok) return;
    const keepA = (old, v) => v + ((old || '').length === 9 ? old.slice(7) : '');
    edit('字幕の見た目', () => {
      P.subtitle_style = {
        ...s, font: font.value, size: clamp(Number(size.value) || 54, 16, 200), color: color.value, outline: clamp(Number(outline.value) || 0, 0, 30),
        outline_color: ocolor.value, box: box.checked, box_color: keepA(s.box_color, bcolor.value), align: align.value, margin: clamp(Number(margin.value) || 0, 0, 500),
      };
    });
  }

  function addFill() {
    let c = null;
    if (edit('カラーを置く', () => { c = Proj.insertFill(P, Engine.position(), '#1e3a5f'); })) {
      Timeline.select([c.id], c.id);
      $('#inspector').classList.add('open');
    }
  }

  /** .cube を選んで読み込む。返り値は LUT の参照（やめたら null） */
  function importLut() {
    return new Promise((resolve) => {
      const inp = $('#lutInput');
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) { resolve(null); return; }
        try {
          const r = await Grade.importCube(f);
          toast(`LUT「${r.name}」を読み込みました`);
          resolve(r.ref);
        } catch (err) { toast('LUT を読めませんでした: ' + err.message, 4000); resolve(null); }
      };
      inp.click();
    });
  }

  // ---- 音声 --------------------------------------------------------------------
  /** 選んだ音声クリップを目標のラウドネスへ（exe の normalize_loudness。同じ素材はまとめて測る） */
  async function normalizeSelected(target) {
    const clips = Timeline.selected().map((id) => P.clips[id]).filter((c) => c && c.media && Proj.track(P, c.track).kind === 'audio');
    if (!clips.length) { toast('音声トラックのクリップを選んでください'); return; }
    const pb = progressBox('ラウドネスを測っています');
    let res;
    try { res = await AudioFx.measureClips(P, clips, true); } finally { pb.close(); }
    const plan = res.filter((r) => r.lufs !== null);
    if (!plan.length) { toast('音が小さすぎて測れませんでした'); return; }
    edit(`ラウドネスを ${target} LUFS に`, () => {
      for (const r of plan) {
        const gain = target - r.lufs;
        for (const c0 of r.clips) {
          const c = P.clips[c0.id];
          if (!c) continue;
          const old = c.volume_db;
          c.volume_db = clamp(gain, -96, 24);
          // 音量のキーがあれば形を保って全体をずらす
          if (c.keys && c.keys.volume_db) c.keys = { ...c.keys, volume_db: c.keys.volume_db.map((k) => [k[0], k[1] + c.volume_db - old, k[2]]) };
        }
      }
    });
    toast(plan.map((r) => `${r.lufs.toFixed(1)} LUFS → ${target}（${(target - r.lufs > 0 ? '+' : '') + (target - r.lufs).toFixed(1)} dB）`).join('　'), 5000);
  }

  /** ノイズ除去など重い処理を、選んだ時点で進み具合を出しながら済ませておく */
  async function prepareFx(c0) {
    const c = P.clips[c0.id];
    if (!c || !AudioFx.hasFx(c.afx)) return;
    const pb = progressBox('音を処理しています');
    try { await AudioFx.processed(c.media, c.afx, (r) => pb.set('ノイズを取っています', r)); toast('処理しました'); } catch (err) { toast('処理できませんでした: ' + err.message); } finally { pb.close(); }
    Engine.refresh();
  }

  async function duckDialog() {
    const auds = P.tracks.filter((t) => t.kind === 'audio');
    if (auds.length < 2) { toast('声と音楽の 2 つの音声トラックが要ります（BGM を A2 などに置いてください）'); return; }
    const d = { ...AudioFx.DUCK_DEFAULT, ...(P.ducking || {}) };
    const tsel = (cur, def) => h('select', null, ...auds.map((t) => h('option', { value: t.id, selected: (cur && cur.length ? cur[0] : def) === t.id }, t.name)));
    const on = h('input', { type: 'checkbox', checked: !!d.on });
    const voice = tsel(d.voice, auds[0].id), music = tsel(d.music, auds[auds.length - 1].id);
    const num = (v, min, max, step) => h('input', { type: 'number', min, max, step, value: v, inputmode: 'decimal' });
    const amount = num(d.amount, 0.5, 60, 0.5), threshold = num(d.threshold, -80, -5, 1), release = num(d.release, 0.05, 5, 0.05);
    const body = h('div', { class: 'form two' },
      h('label', { class: 'inline wide' }, on, '声が入っている間、音楽を自動で下げる'),
      h('label', null, '声のトラック', voice), h('label', null, '音楽のトラック', music),
      h('label', null, '下げる量（dB）', amount), h('label', null, '声と見なす大きさ（dBFS）', threshold),
      h('label', null, '戻る速さ（秒）', release),
      h('p', { class: 'hint wide' }, '声の大きさで決まった計算をするので、どこから再生しても書き出しても同じ音になります。'));
    const ok = await showDialog({ title: 'BGM の自動ダッキング', body, buttons: [{ label: 'やめる', value: false }, { label: '決める', value: true, primary: true }] });
    if (!ok) return;
    if (voice.value === music.value && on.checked) { toast('声と音楽に同じトラックは選べません'); return; }
    edit('BGM の自動ダッキング', () => {
      P.ducking = {
        ...d, on: on.checked, voice: [voice.value], music: [music.value],
        amount: clamp(Number(amount.value) || 12, 0.5, 60), threshold: clamp(Number(threshold.value) || -40, -80, -5), release: clamp(Number(release.value) || 0.4, 0.05, 5),
      };
    });
    Engine.preloadAudio();
    Mixer.refresh();
  }

  async function toggleRecord() {
    const btn = $('#btnRec');
    if (!Recorder.active()) {
      try {
        await Recorder.start(Math.round(Engine.position()), (on, sec) => {
          btn.classList.toggle('on', on);
          btn.textContent = on ? `■ 停止 ${fmtDur(sec)}` : '● 録音';
        });
        toast('録音しています（イヤホンを使うとスピーカーの音が入りません）', 3000);
      } catch (err) {
        toast('録音を始められませんでした: ' + (err.message || err), 4000);
      }
      return;
    }
    const r = await Recorder.stop();
    if (!r || !r.file.size) { toast('録音できませんでした'); return; }
    const pb = progressBox('録音を読み込んでいます');
    let rec;
    try { rec = await Media.importFile(r.file, (t, x) => pb.set(t, x)); } catch (err) { pb.close(); toast('録音を読み込めませんでした: ' + err.message, 4000); return; } finally { pb.close(); }
    let placed = [];
    edit('ナレーションを置く', () => {
      P.media[rec.id] = Media.projectInfo(rec);
      const m = P.media[rec.id];
      const trimF = Math.round(r.trim * Proj.fps(P));
      const dur = Math.max(1, Proj.mediaFrames(P, m) - trimF);
      const tid = Proj.freeTrack(P, 'audio', r.frame, r.frame + dur);
      placed = [Proj.addClip(P, { id: uid('c'), track: tid, start: r.frame, duration: dur, media: m.id, src_in: r.trim, name: m.name }, false)];
    });
    renderBin();
    Timeline.select(placed.map((c) => c.id), placed[0] && placed[0].id);
    toast('ナレーションを置きました');
  }

  function previewClip(c) {
    Engine.pause();
    seek(c.start);
    Engine.play();
  }

  // ---- タイムラインの操作 --------------------------------------------------------
  function split() {
    const fr = Math.round(Engine.position());
    const ids = Timeline.selected();
    let rights = [];
    edit('分割', () => { rights = Proj.splitAt(P, fr, ids.length ? ids : null); });
    if (!rights.length) toast(ids.length ? '選んだクリップが再生位置にありません' : '再生位置にクリップがありません');
  }

  function remove(ripple) {
    const ids = Timeline.selected();
    if (!ids.length) return;
    edit(ripple ? '詰めて削除' : '削除', () => Proj.deleteClips(P, ids, ripple));
    Timeline.clearSelection();
    renderBin();
  }

  function toggleMarker() {
    const fr = Math.round(Engine.position());
    edit('マーカー', () => {
      const i = P.markers.findIndex((m) => m.frame === fr);
      if (i >= 0) P.markers.splice(i, 1);
      else P.markers.push({ frame: fr, name: '', color: '#e0b030', end: null, kind: '' });
      P.markers.sort((a, b) => a.frame - b.frame);
    });
  }

  function jumpMarker(dir) {
    const fr = Math.round(Engine.position());
    const pts = [0, Proj.duration(P)].concat(P.markers.map((m) => m.frame), Object.values(P.clips).flatMap((c) => [c.start, Proj.end(c)]));
    const cand = [...new Set(pts)].sort((a, b) => a - b);
    const t = dir > 0 ? cand.find((x) => x > fr) : cand.reverse().find((x) => x < fr);
    if (t !== undefined) seek(t);
  }

  function seek(fr) {
    Engine.seek(fr);
    Timeline.follow(Engine.position());     // 再生位置が見えていなければ見える所まで送る
  }

  function step(n) {
    Engine.pause();
    seek(Math.round(Engine.position()) + n);
  }

  // ---- プレビューの直接操作 -------------------------------------------------------
  /** 再生位置での値（キーフレームを反映） */
  const kv = (c, prop) => Keys.valueAt(c, prop, Math.floor(Engine.position()));
  /** 値を変える。キーのある属性は再生位置のキーを作る・直す */
  function setKv(c, prop, v) {
    if (Keys.has(c, prop)) Keys.setKey(c, prop, clamp(Math.round(Engine.position() - c.start), 0, c.duration), v);
    else c[prop] = v;
  }

  function initPreview() {
    const cv = $('#preview');
    const pts = new Map();
    let drag = null;
    const toProj = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * P.width, y: (e.clientY - r.top) / r.height * P.height };
    };
    const visual = (c) => {
      if (!c) return false;
      const t = Proj.track(P, c.track);
      const fr = Math.floor(Engine.position());
      if (t.kind === 'subtitle') return !t.muted && c.enabled && c.text && c.start <= fr && fr < Proj.end(c);
      return t.kind === 'video' && Engine.visibleClips(fr).some((x) => x.id === c.id);
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!P) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても続ける */ }
      const pt = toProj(e);
      pts.set(e.pointerId, pt);
      let c = Timeline.primaryClip();
      if (pts.size === 1) {
        // 選んでいるクリップの角 = 拡大、中 = 移動。他の所なら、そこにあるクリップを選ぶ
        const box = visual(c) ? Engine.clipBox(c) : null;
        const corner = box && cornerHit(box, pt, e.pointerType === 'touch' ? 40 : 22);
        if (!corner && !(box && inBox(box, pt))) {
          const hit = Engine.clipAtPoint(pt.x, pt.y);
          if (hit) { Timeline.select([hit.id], hit.id); c = hit; } else { drag = null; return; }
        }
        if (c && Proj.track(P, c.track).locked) { drag = null; return; }
        drag = { id: c.id, mode: corner ? 'scale' : 'move', x0: pt.x, y0: pt.y, px: kv(c, 'pos_x'), py: kv(c, 'pos_y'), s0: kv(c, 'scale'), r0: kv(c, 'rotation'), began: false };
        if (corner) { const b = Engine.clipBox(c); drag.d0 = Math.hypot(pt.x - b.cx, pt.y - b.cy); }
      } else if (pts.size === 2 && c && visual(c)) {
        const [a, b] = [...pts.values()];
        drag = { id: c.id, mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), a0: Math.atan2(b.y - a.y, b.x - a.x), s0: kv(c, 'scale'), r0: kv(c, 'rotation'), px: kv(c, 'pos_x'), py: kv(c, 'pos_y'), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, began: drag ? drag.began : false };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !drag || !P) return;
      pts.set(e.pointerId, toProj(e));
      const c = P.clips[drag.id];
      if (!c) return;
      const pt = pts.get(e.pointerId);
      if (!drag.began) {
        if (drag.mode !== 'pinch' && Math.hypot(pt.x - drag.x0, pt.y - drag.y0) < P.width * 0.004) return;
        drag.began = true;
        begin();
      }
      live(() => {
        if (drag.mode === 'move') {
          let x = Math.round(drag.px + pt.x - drag.x0), y = Math.round(drag.py + pt.y - drag.y0);
          // 中央に吸い付く
          if (Math.abs(x) < P.width * 0.01) x = 0;
          if (Math.abs(y) < P.height * 0.01) y = 0;
          setKv(c, 'pos_x', x);
          setKv(c, 'pos_y', y);
        } else if (drag.mode === 'scale') {
          const b = Engine.clipBox(c);
          const d = Math.hypot(pt.x - b.cx, pt.y - b.cy);
          setKv(c, 'scale', clamp(drag.s0 * d / Math.max(1, drag.d0), 0.05, 8));
        } else if (drag.mode === 'pinch' && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          setKv(c, 'scale', clamp(drag.s0 * d / Math.max(1, drag.d0), 0.05, 8));
          let rot = drag.r0 + (ang - drag.a0) * 180 / Math.PI;
          if (Math.abs(rot - Math.round(rot / 90) * 90) < 3) rot = Math.round(rot / 90) * 90;   // 90 度ごとに吸い付く
          setKv(c, 'rotation', Math.round(rot * 10) / 10);
          setKv(c, 'pos_x', Math.round(drag.px + m.x - drag.m0.x));
          setKv(c, 'pos_y', Math.round(drag.py + m.y - drag.m0.y));
        }
      });
      Inspector.refresh();
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size === 0 && drag) {
        if (drag.began) end(drag.mode === 'move' ? '位置' : drag.mode === 'scale' ? '拡大' : '拡大・回転');
        drag = null;
      } else if (pts.size === 1 && drag && drag.mode === 'pinch') {
        // 1 本だけ残ったら移動に戻る
        const [rest] = [...pts.values()];
        const c = P.clips[drag.id];
        if (c) drag = { id: c.id, mode: 'move', x0: rest.x, y0: rest.y, px: kv(c, 'pos_x'), py: kv(c, 'pos_y'), began: drag.began };
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);

    // 選んだクリップの枠
    Engine.setOverlay((g, k) => {
      const c = Timeline.primaryClip();
      if (!c || !visual(c)) return;
      const b = Engine.clipBox(c);
      if (!b) return;
      g.setTransform(k, 0, 0, k, 0, 0);
      g.translate(b.cx, b.cy);
      g.rotate((b.rot || 0) * Math.PI / 180);
      g.lineWidth = 2 / k;
      g.strokeStyle = '#ffd23f';
      g.setLineDash([8 / k, 5 / k]);
      g.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      g.setLineDash([]);
      g.fillStyle = '#ffd23f';
      const s = 10 / k;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.fillRect(x * b.w / 2 - s / 2, y * b.h / 2 - s / 2, s, s);
    });
  }

  function local(box, pt) {
    const a = -(box.rot || 0) * Math.PI / 180;
    const dx = pt.x - box.cx, dy = pt.y - box.cy;
    return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  }
  function inBox(box, pt) { const l = local(box, pt); return Math.abs(l.x) <= box.w / 2 && Math.abs(l.y) <= box.h / 2; }
  function cornerHit(box, pt, cssRadius) {
    const cv = $('#preview');
    const r = cssRadius * P.width / cv.getBoundingClientRect().width;
    const l = local(box, pt);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].some(([sx, sy]) => Math.hypot(l.x - sx * box.w / 2, l.y - sy * box.h / 2) <= r);
  }

  // ---- 画面の部品 ---------------------------------------------------------------
  function closeDrawers() { $('#bin').classList.remove('open'); $('#inspector').classList.remove('open'); }

  function initDivider() {
    const ed = $('#editor');
    const KEY = 'eikobo-web:timeline-h';
    let saved = 0;
    try { saved = Number(localStorage.getItem(KEY)) || 0; } catch { /* 無くてよい */ }
    if (saved) ed.style.setProperty('--tl-h', saved + 'px');
    const div = $('#divider');
    let y0 = 0, h0 = 0;
    div.addEventListener('pointerdown', (e) => {
      try { div.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても続ける */ }
      y0 = e.clientY;
      h0 = $('#timelineBox').getBoundingClientRect().height;
    });
    div.addEventListener('pointermove', (e) => {
      if (!div.hasPointerCapture(e.pointerId)) return;
      const hh = clamp(h0 - (e.clientY - y0), 120, window.innerHeight - 260);
      ed.style.setProperty('--tl-h', hh + 'px');
    });
    div.addEventListener('pointerup', () => {
      const hh = Math.round($('#timelineBox').getBoundingClientRect().height);
      try { localStorage.setItem(KEY, String(hh)); } catch { /* 無くてよい */ }
    });
  }

  function setPlayIcon(on) {
    $('#btnPlay').innerHTML = on
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  }

  function onKey(e) {
    if (!P || $('#editor').hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-back')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); split(); return; }
    if (mod && (k === 's' || k === 'S')) { e.preventDefault(); save(); return; }
    if (mod) return;
    if (k === ' ') { e.preventDefault(); Engine.toggle(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -Math.round(Proj.fps(P)) : -1); }
    else if (k === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? Math.round(Proj.fps(P)) : 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); jumpMarker(-1); }
    else if (k === 'ArrowDown') { e.preventDefault(); jumpMarker(1); }
    else if (k === 'Home') { e.preventDefault(); seek(0); }
    else if (k === 'End') { e.preventDefault(); seek(Proj.duration(P)); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); remove(e.shiftKey); }
    else if (k === 's' || k === 'S') split();
    else if (k === 'm' || k === 'M') toggleMarker();
    else if (k === 't' || k === 'T') addText();
    else if (k === '+' || k === '=') Timeline.zoom(1.5);
    else if (k === '-') Timeline.zoom(1 / 1.5);
    else if (k === '\\') Timeline.fitAll();
    else if (k === 'Escape') Timeline.clearSelection();
  }

  // ---- 起動 ---------------------------------------------------------------------
  function init() {
    Engine.attach($('#preview'));
    Timeline.init($('#timeline'), {
      select: (id) => { Inspector.show(id); Engine.requestDraw(); updateUi(); },
      edit,
      seek: (f) => { Engine.pause(); seek(f); },
      trackMenu,
    });
    Inspector.init($('#inspector'), {
      begin, live, end, edit, settings: settingsDialog, preview: previewClip, subtitleStyle: subtitleStyleDialog,
      playhead: () => Engine.position(), seek: (f) => { Engine.pause(); seek(f); }, importLut, normalize: normalizeSelected, prepareFx,
    });
    Grade.onLoaded = () => { Engine.refresh(); Inspector.refresh(); };
    // カタログは先に読んでおく（テロップの描き方・モーションに要る）
    Promise.all([Telop.load(), Motion.load()]).then(() => { if (P) { Engine.refresh(); Inspector.refresh(); } }).catch((e) => console.warn('カタログを読めません', e));
    Engine.on('tick', (fr) => {
      updateTc(fr);
      if (Engine.isPlaying()) Timeline.follow(fr);
      else {
        Timeline.draw();
        // キーフレームのある値は再生位置で変わるので出し直す（動かしている間はまとめて 1 回）
        if (!seekRefresh) seekRefresh = requestAnimationFrame(() => { seekRefresh = 0; Inspector.onSeek(); });
      }
    });
    Engine.on('state', (on) => setPlayIcon(on));
    setPlayIcon(false);
    initPreview();
    initDivider();
    new ResizeObserver(() => Engine.resize()).observe($('#previewBox'));

    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('#btnNew', newProject);
    on('#btnOpenFile', () => $('#projectInput').click());
    on('#btnDrive', () => GDrive.homeMenu());
    on('#btnDriveMedia', () => GDrive.go({ kind: 'media' }));
    $('#projectInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importProject(f); });
    on('#btnHome', showHome);
    on('#btnName', settingsDialog);
    on('#btnSettings', settingsDialog);
    on('#btnUndo', undo);
    on('#btnRedo', redo);
    on('#btnImport', () => { relinkId = null; $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', (e) => { const f = Array.from(e.target.files || []); e.target.value = ''; onFiles(f); });
    on('#btnPlay', () => Engine.toggle());
    on('#btnStart', () => { Engine.pause(); seek(0); });
    on('#btnEnd', () => { Engine.pause(); seek(Proj.duration(P)); });
    on('#btnPrevF', () => step(-1));
    on('#btnNextF', () => step(1));
    on('#btnText', addText);
    on('#btnSubs', subtitleMenu);
    on('#btnFill', addFill);
    on('#btnMixer', () => Mixer.toggle());
    on('#btnRec', toggleRecord);
    Mixer.init($('#mixer'), { begin, end, edit, duck: duckDialog });
    $('#srtInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f && P) importSrt(f); });
    on('#btnSplit', split);
    on('#btnDelete', () => remove(false));
    on('#btnRipple', () => remove(true));
    on('#btnUnlink', () => { const c = Timeline.primaryClip(); if (c) edit('リンク解除', () => Proj.unlink(P, [c.id])); });
    on('#btnMarker', toggleMarker);
    on('#btnMulti', (e) => { const v = !Timeline.multi; Timeline.setMulti(v); e.currentTarget.classList.toggle('on', v); toast(v ? '複数選択: 触れたクリップを足したり外したりします' : '複数選択を終わりました', 1600); });
    on('#btnSnap', (e) => { const v = !Timeline.snap; Timeline.setSnap(v); e.currentTarget.classList.toggle('on', v); });
    on('#btnAddTrack', addTrackDialog);
    on('#btnZoomIn', () => Timeline.zoom(1.5));
    on('#btnZoomOut', () => Timeline.zoom(1 / 1.5));
    on('#btnZoomFit', () => Timeline.fitAll());
    on('#btnExport', () => { if (P) Exporter.open(P, Timeline.selected()); });
    on('#btnBin', () => { $('#inspector').classList.remove('open'); $('#bin').classList.toggle('open'); });
    on('#btnInspector', () => { $('#bin').classList.remove('open'); $('#inspector').classList.toggle('open'); });
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { Engine.pause(); save(); } });
    window.addEventListener('pagehide', () => { save(); });

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // Google にサインインしに行って戻ってきた時は、やりかけの事を続ける
    showHome().then(() => GDrive.resume());
  }

  return { init, edit, importFiles, importProject, linkFiles, get project() { return P; }, save, undo, redo, split, place, seek, openProject, showHome };
})();

document.addEventListener('DOMContentLoaded', App.init);
