/* 書き出しの中身を OPFS のファイルへ順に書く（メモリに溜めないため）。
   受け取り: {id, cmd: 'open', dir, name} / {id, cmd: 'write', data: ArrayBuffer} / {id, cmd: 'close'} / {id, cmd: 'abort'}
   返し: {id, ok: true} / {id, error} */
let handle = null;
let pos = 0;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      let d = await navigator.storage.getDirectory();
      for (const part of m.dir) d = await d.getDirectoryHandle(part, { create: true });
      const fh = await d.getFileHandle(m.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      pos = 0;
    } else if (m.cmd === 'write') {
      const u8 = new Uint8Array(m.data);
      let off = 0;
      while (off < u8.length) off += handle.write(u8.subarray(off), { at: pos + off });
      pos += u8.length;
    } else if (m.cmd === 'close' || m.cmd === 'abort') {
      if (handle) { if (m.cmd === 'close') handle.flush(); handle.close(); handle = null; }
    }
    self.postMessage({ id: m.id, ok: true, size: pos });
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err), name: err && err.name });
  }
};
