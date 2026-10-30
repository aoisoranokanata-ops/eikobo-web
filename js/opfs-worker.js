/* 素材のファイルを OPFS に書く（Safari は同期アクセスハンドルを Worker の中でしか使えない）。
   受け取り: {dir: ['eikobo-web', 'media'], name, file}  返し: {progress} … {done} / {error} */
self.onmessage = async (e) => {
  const { dir, name, file } = e.data;
  let handle = null;
  try {
    let d = await navigator.storage.getDirectory();
    for (const part of dir) d = await d.getDirectoryHandle(part, { create: true });
    const fh = await d.getFileHandle(name, { create: true });
    handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    const CHUNK = 8 * 1024 * 1024;
    let pos = 0;
    while (pos < file.size) {
      const buf = new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer());
      let off = 0;
      while (off < buf.length) off += handle.write(buf.subarray(off), { at: pos + off });
      pos += buf.length;
      self.postMessage({ progress: pos / file.size });
    }
    handle.flush();
    handle.close();
    handle = null;
    self.postMessage({ done: true });
  } catch (err) {
    try { if (handle) handle.close(); } catch { /* 閉じられなくても続ける */ }
    self.postMessage({ error: String((err && err.message) || err), name: err && err.name });
  }
};
