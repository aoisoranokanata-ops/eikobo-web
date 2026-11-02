/* ------------------------------------------------------------
   ナレーション録音: マイク（getUserMedia）→ MediaRecorder（iPad は audio/mp4）。
   録音中はタイムラインを再生する（映像を見ながら話せる。スピーカーの音が入らないようイヤホン推奨）。
   止めたら素材として読み込み、録音を始めた位置の空いている音声トラックに置く。
   再生の始まりは録音の始まりより少し遅れるので、その差だけ録音の頭を削って位置を合わせる。
   ------------------------------------------------------------ */
const Recorder = (() => {
  let rec = null, stream = null, chunks = [], startFrame = 0, recStart = 0, playStart = 0, timer = 0, onState = null;

  const active = () => !!rec;

  function pickType() {
    for (const t of ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  async function start(frame, state) {
    if (rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('このブラウザでは録音できません');
    onState = state;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const type = pickType();
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    startFrame = frame;
    const cx = Media.audioContext();
    if (cx.state !== 'running') cx.resume();
    rec.start(1000);
    recStart = cx.currentTime;
    Engine.seek(frame);
    Engine.play();
    playStart = cx.currentTime + 0.08 + (cx.outputLatency || 0);
    const t0 = performance.now();
    timer = setInterval(() => { if (onState) onState(true, (performance.now() - t0) / 1000); }, 250);
    if (onState) onState(true, 0);
  }

  /** 止める。返り値 {file, frame, trim（頭を削る秒）} */
  function stop() {
    return new Promise((resolve) => {
      if (!rec) { resolve(null); return; }
      const r = rec;
      clearInterval(timer);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = r.mimeType || 'audio/mp4';
        const ext = /webm/.test(type) ? 'webm' : 'm4a';
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const file = new File(chunks, `ナレーション ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.${ext}`, { type: type.split(';')[0] });
        rec = null; stream = null; chunks = [];
        if (onState) onState(false, 0);
        resolve({ file, frame: startFrame, trim: Math.max(0, playStart - recStart) });
      };
      Engine.pause();
      r.stop();
    });
  }

  return { start, stop, active };
})();
