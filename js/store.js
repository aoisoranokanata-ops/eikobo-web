/* ------------------------------------------------------------
   保存
   - IndexedDB "eikobo-web": projects（作品の JSON）・media（素材の情報・縮小画像・波形）
   - OPFS の eikobo-web/media/<素材 ID>: 素材のファイルそのもの
     （github.io の他のアプリとオリジンを共有するので、必ず eikobo-web の下に置く）
   ------------------------------------------------------------ */
const Store = (() => {
  const DB_NAME = 'eikobo-web';
  const DB_VER = 1;
  const DIR = ['eikobo-web', 'media'];
  let dbp = null;
  const memFiles = new Map();          // OPFS が使えない時だけ（再読み込みで消える）

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { dbp = null; };            // iPad で接続が切られたら次は開き直す
        db.onversionchange = () => { db.close(); dbp = null; };
        resolve(db);
      };
      req.onerror = () => { dbp = null; reject(req.error); };
    });
    return dbp;
  }

  async function run(store, mode, fn, retry = true) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        const r = fn(os);
        if (r) r.onsuccess = () => { result = r.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('abort'));
      });
    } catch (err) {
      if (retry && err && (err.name === 'InvalidStateError' || err.name === 'UnknownError')) {
        dbp = null;
        return run(store, mode, fn, false);
      }
      throw err;
    }
  }

  const get = (store, id) => run(store, 'readonly', (os) => os.get(id));
  const all = (store) => run(store, 'readonly', (os) => os.getAll());
  const put = (store, obj) => run(store, 'readwrite', (os) => os.put(obj));
  const del = (store, id) => run(store, 'readwrite', (os) => os.delete(id));

  // ---- OPFS --------------------------------------------------------------
  const hasOpfs = !!(navigator.storage && navigator.storage.getDirectory);

  async function mediaDir() {
    let d = await navigator.storage.getDirectory();
    for (const part of DIR) d = await d.getDirectoryHandle(part, { create: true });
    return d;
  }

  function writeWithWorker(name, file, onProgress) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker('js/opfs-worker.js'); } catch (err) { reject(err); return; }
      w.onmessage = (e) => {
        const m = e.data;
        if (m.progress !== undefined) { if (onProgress) onProgress(m.progress); return; }
        w.terminate();
        if (m.done) resolve();
        else reject(Object.assign(new Error(m.error), { name: m.name || 'Error' }));
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker')); };
      w.postMessage({ dir: DIR, name, file });
    });
  }

  async function writeWithStream(name, file, onProgress) {
    const d = await mediaDir();
    const fh = await d.getFileHandle(name, { create: true });
    const ws = await fh.createWritable();
    const CHUNK = 8 * 1024 * 1024;
    for (let pos = 0; pos < file.size; pos += CHUNK) {
      await ws.write(await file.slice(pos, pos + CHUNK).arrayBuffer());
      if (onProgress) onProgress(Math.min(1, (pos + CHUNK) / file.size));
    }
    await ws.close();
  }

  /** 素材のファイルを取っておく */
  async function writeFile(id, file, onProgress) {
    if (!hasOpfs) { memFiles.set(id, file); return 'memory'; }
    try {
      await writeWithWorker(id, file, onProgress);
    } catch (err) {
      if (err && err.name === 'QuotaExceededError') throw err;
      const d = await mediaDir();
      const fh = await d.getFileHandle(id, { create: true });
      if (fh.createWritable) await writeWithStream(id, file, onProgress);
      else throw err;
    }
    return 'opfs';
  }

  /** 取っておいたファイル（File）。無ければ null */
  async function readFile(id) {
    if (memFiles.has(id)) return memFiles.get(id);
    if (!hasOpfs) return null;
    try {
      const d = await mediaDir();
      const fh = await d.getFileHandle(id);
      return await fh.getFile();
    } catch { return null; }
  }

  async function removeFile(id) {
    memFiles.delete(id);
    if (!hasOpfs) return;
    try { await (await mediaDir()).removeEntry(id); } catch { /* 無ければよい */ }
  }

  async function estimate() {
    try { return await navigator.storage.estimate(); } catch { return null; }
  }

  async function persist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch { /* 無視 */ }
    return false;
  }

  /**
   * 書き出し用: OPFS の eikobo-web/export/<name> へ順に書く。{write(u8), close() → File, abort()}
   * OPFS が使えない時はメモリに溜める（長い動画では iPad のメモリが足りなくなるかもしれない）。
   */
  async function openStream(name) {
    const dir = ['eikobo-web', 'export'];
    if (hasOpfs) {
      try {
        const w = new Worker('js/stream-worker.js');
        let seq = 0;
        const waiting = new Map();
        w.onmessage = (e) => {
          const r = waiting.get(e.data.id);
          if (!r) return;
          waiting.delete(e.data.id);
          if (e.data.error) r.reject(Object.assign(new Error(e.data.error), { name: e.data.name || 'Error' }));
          else r.resolve(e.data);
        };
        const call = (msg, transfer) => new Promise((resolve, reject) => {
          const id = ++seq;
          waiting.set(id, { resolve, reject });
          w.postMessage({ ...msg, id }, transfer || []);
        });
        await call({ cmd: 'open', dir, name });
        return {
          write: (u8) => {
            const copy = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
            return call({ cmd: 'write', data: copy }, [copy]);
          },
          async close() {
            await call({ cmd: 'close' });
            w.terminate();
            let d = await navigator.storage.getDirectory();
            for (const part of dir) d = await d.getDirectoryHandle(part);
            return (await d.getFileHandle(name)).getFile();
          },
          async abort() { try { await call({ cmd: 'abort' }); } catch { /* 済み */ } w.terminate(); await removeExport(name); },
        };
      } catch (err) { console.warn('OPFS に書けないのでメモリに溜めます', err); }
    }
    const parts = [];
    return {
      write: async (u8) => { parts.push(u8.slice()); },
      close: async () => new Blob(parts),
      abort: async () => { parts.length = 0; },
    };
  }

  async function removeExport(name) {
    if (!hasOpfs) return;
    try {
      let d = await navigator.storage.getDirectory();
      d = await (await d.getDirectoryHandle('eikobo-web')).getDirectoryHandle('export');
      if (name) await d.removeEntry(name);
      else for await (const k of d.keys()) await d.removeEntry(k);
    } catch { /* 無ければよい */ }
  }

  return { get, all, put, del, writeFile, readFile, removeFile, estimate, persist, hasOpfs, openStream, removeExport };
})();
