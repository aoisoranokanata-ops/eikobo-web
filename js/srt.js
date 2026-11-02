/* SRT の読み書き（exe の ai/subtitles.py の parse_srt / to_srt と同じ形） */
const Srt = (() => {
  const TS = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;

  function frac(s) { return Number(s) / (s.length === 3 ? 1000 : 10 ** s.length); }

  /** 文字 → [{start, end, text}]（秒） */
  function parse(text) {
    const cues = [];
    const blocks = String(text).replace(/﻿/g, '').trim().split(/\r?\n\s*\r?\n/);
    for (const b of blocks) {
      const lines = b.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = TS.exec(lines[i]);
        if (!m) continue;
        const g = m.slice(1);
        const s = +g[0] * 3600 + +g[1] * 60 + +g[2] + frac(g[3]);
        const e = +g[4] * 3600 + +g[5] * 60 + +g[6] + frac(g[7]);
        const body = lines.slice(i + 1).join('\n').trim().replace(/<\/?[a-zA-Z][^>]*>/g, '');
        if (body) cues.push({ start: s, end: e, text: body });
        break;
      }
    }
    return cues;
  }

  function time(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  }

  /** 作品の字幕 → SRT の文字（非表示のトラックも入れる。exe と同じ） */
  function fromProject(p) {
    const f = Proj.fps(p);
    return Proj.subtitleClips(p).map((c, i) => `${i + 1}\n${time(c.start / f)} --> ${time(Proj.end(c) / f)}\n${c.text}\n`).join('\n');
  }

  return { parse, time, fromProject };
})();

if (typeof module !== 'undefined') module.exports = Srt;
