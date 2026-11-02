/* ------------------------------------------------------------
   テロップ・字幕の文字を描く（exe の subrender.TextRenderer を canvas に移したもの）

   重ねる順: 帯 → 影 → 光彩 → 縁（外側から）→ 塗り。余白（影・光彩・縁の分）と帯の内側の余白は exe と同じ計算。
   - 縁: strokeText（太さ = 縁の 2 倍、角は丸）＋ fillText で「文字＋縁」の形。
   - 影・光彩のぼかし: iPad の Safari は ctx.filter が使えないので、canvas の影（shadowBlur）で作る。
     形を画面の外に描いて、影だけを shadowOffset で戻す（shadowBlur = σ の 2 倍）。
   - 古い書き方の style（outline / outline_color / shadow: true）は、同じ見た目の「凝った」形に直して描く。
   すべての大きさは px（1080p 基準の値 × scale）。結果はキャッシュする。
   ------------------------------------------------------------ */
const TextRender = (() => {
  const cache = new Map();
  const LIMIT = 80;
  const OFF = 20000;                   // 影の技のために形を描く画面の外の位置
  const meas = document.createElement('canvas').getContext('2d');

  function remember(key, val) {
    cache.set(key, val);
    while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    return val;
  }
  function recall(key) {
    const v = cache.get(key);
    if (v !== undefined) { cache.delete(key); cache.set(key, v); }
    return v;
  }

  const RICH_KEYS = ['strokes', 'gradient', 'glow', 'spacing', 'hollow', 'box_bar', 'text_align', 'weight', 'line_spacing', 'box_radius', 'box_pad_x', 'box_pad_y'];
  const isRich = (st) => RICH_KEYS.some((k) => st[k] !== undefined && st[k] !== null && st[k] !== false) || (st.shadow && typeof st.shadow === 'object');

  /** 古い書き方 → 凝った書き方（exe の render_text と同じ見た目になるよう） */
  function richen(st) {
    if (isRich(st)) return st;
    const out = { ...st };
    const w = Number(st.outline || 0);
    out.strokes = w > 0 ? [{ width: w, color: st.outline_color || '#000000' }] : [];
    if (st.shadow) { const d = (st.size || 54) * 0.06; out.shadow = { color: '#000000a0', dx: d, dy: d, blur: 0 }; }
    else out.shadow = false;
    out.line_spacing = 0.25;
    if (st.box) { out.box_pad_x = 0.35; out.box_pad_y = 0.35; out.box_radius = 0.2; }
    // exe の古い描き方（render_text）: 行の高さに縁の 2 倍を足し、文字は行の上端から（縦に真ん中へ寄せない）
    out._legacy = w;
    return out;
  }

  function strokesOf(st) {
    return (Array.isArray(st.strokes) ? st.strokes : []).map((s) => [Number(s.width) || 0, s.color || '#000000']).filter(([w]) => w > 0);
  }
  function shadowOf(st) {
    const sh = st.shadow;
    if (sh && typeof sh === 'object') return sh;
    if (sh) { const d = (st.size || 54) * 0.06; return { color: '#000000a0', dx: d, dy: d, blur: 0 }; }
    return null;
  }

  /** [外側の余白, 帯の左右の余白, 上下の余白]（exe の rich_pad） */
  function richPad(st, scale) {
    const size = Math.max(6, Math.round((st.size || 54) * scale));
    const sw = Math.max(0, ...strokesOf(st).map(([w]) => w)) * scale;
    let pad = sw;
    const glow = st.glow;
    if (glow && glow.radius) pad = Math.max(pad, sw + 3 * glow.radius * scale);
    const sh = shadowOf(st);
    if (sh) pad = Math.max(pad, sw + Math.max(Math.abs(sh.dx || 0), Math.abs(sh.dy || 0)) * scale + 3 * (sh.blur || 0) * scale);
    let bx = 0, by = 0;
    if (st.box) { bx = Math.floor(size * (st.box_pad_x ?? 0.45)); by = Math.floor(size * (st.box_pad_y ?? 0.2)); }
    return [Math.ceil(pad) + 2, bx, by];
  }

  function fontOf(st, size) {
    const weight = st.weight || (st.bold === false ? 400 : 700);
    return `${weight} ${size}px ${Telop.cssFamily(st.font || 'BIZ UDGothic')}`;
  }

  // ---- 配置 ---------------------------------------------------------------------
  function layout(text, st, scale) {
    const key = 'L|' + text + '|' + JSON.stringify(st) + '|' + scale.toFixed(4);
    const hit = recall(key);
    if (hit) return hit;
    const size = Math.max(6, Math.round((st.size || 54) * scale));
    const font = fontOf(st, size);
    meas.font = font;
    const spacing = (Number(st.spacing) || 0) * scale;
    const lines = String(text).split('\n');
    const [pad, bx, by] = richPad(st, scale);
    const m = meas.measureText('あ');
    const asc = Math.round(m.fontBoundingBoxAscent || size * 0.88);
    const desc = Math.round(m.fontBoundingBoxDescent || size * 0.12);
    const legacy = st._legacy !== undefined;
    const lineH = Math.round(size * 1.25) + (legacy ? 2 * Math.max(0, Math.round(st._legacy * scale)) : 0);
    const gap = Math.round(size * (st.line_spacing ?? 0.2));
    const chars = [], advs = [], widths = [], glyphs = [];
    for (const ln of lines) {
      const arr = Array.from(ln);
      const xs = [], ad = [];
      let acc = 0;
      for (let j = 0; j < arr.length; j++) {
        const w = meas.measureText(arr[j]).width;
        xs.push(spacing ? acc + spacing * j : meas.measureText(arr.slice(0, j).join('')).width);
        ad.push(w);
        acc += w;
      }
      chars.push(xs); advs.push(ad); glyphs.push(arr);
      widths.push(spacing ? acc + spacing * Math.max(0, arr.length - 1) : meas.measureText(ln).width);
    }
    const tw = Math.ceil(widths.length ? Math.max(...widths) : 0);
    const th = lineH * lines.length + gap * (lines.length - 1);
    const W = tw + 2 * (pad + bx), H = th + 2 * (pad + by);
    const ox = pad + bx, oy = pad + by;
    const talign = st.text_align || 'center';
    const yTop = legacy ? oy : oy + Math.floor((lineH - (asc + desc)) / 2);
    const starts = [], tops = [], base = [], grad = [];
    widths.forEach((w, i) => {
      const x = ox + (talign === 'left' ? 0 : talign === 'right' ? tw - w : (tw - w) / 2);
      const y = yTop + i * (lineH + gap);
      starts.push([x, y]);
      tops.push(oy + i * (lineH + gap));
      base.push(y + asc);
      // グラデーションの範囲 = 行の文字の上端〜下端
      const mm = meas.measureText(lines[i] || 'あ');
      const a = mm.actualBoundingBoxAscent || asc * 0.9, d = mm.actualBoundingBoxDescent || desc;
      grad.push([y + asc - a, y + asc + d]);
    });
    const lay = { W, H, pad, bx, by, size, lineH, gap, asc, desc, spacing, font, lines, glyphs, starts, tops, widths, base, grad,
      chars: chars.map((xs, i) => xs.map((x) => starts[i][0] + x)), advs };
    return remember(key, lay);
  }

  // ---- 形 -------------------------------------------------------------------------
  /** 文字の形を描く。sel: null = 全部 / ['line', i] / ['char', i, j]。stroke = 縁の太さ（0 で塗りだけ） */
  function shape(g, lay, sel, stroke, color, dx = 0, dy = 0) {
    g.font = lay.font;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = color;
    g.strokeStyle = color;
    g.lineJoin = 'round';
    g.lineWidth = stroke * 2;
    const put = (s, x, y) => {
      if (stroke > 0) g.strokeText(s, x + dx, y + dy);
      g.fillText(s, x + dx, y + dy);
    };
    lay.lines.forEach((ln, i) => {
      if (sel && sel[1] !== i) return;
      const y = lay.base[i];
      if (sel && sel[0] === 'char') { put(lay.glyphs[i][sel[2]], lay.chars[i][sel[2]], y); return; }
      if (!lay.spacing) { put(ln, lay.starts[i][0], y); return; }
      lay.glyphs[i].forEach((ch, j) => put(ch, lay.chars[i][j], y));
    });
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /** 「外側の形」（いちばん太い縁、無ければ文字）。中抜きは中の文字を抜く */
  function outerShape(lay, st, scale, sel, w, h, wx0) {
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const strokes = strokesOf(st).sort((a, b) => b[0] - a[0]);
    shape(g, lay, sel, strokes.length ? Math.max(1, Math.round(strokes[0][0] * scale)) : 0, '#000', -wx0, 0);
    if (st.hollow) { g.globalCompositeOperation = 'destination-out'; shape(g, lay, sel, 0, '#000', -wx0, 0); }
    return c;
  }

  /** 形 src の影（色 color・ずれ dx dy・ぼかし σ）を g に描く */
  function shadowFrom(g, src, color, dx, dy, sigma, times = 1) {
    g.save();
    g.shadowColor = color;
    g.shadowBlur = Math.max(0, sigma * 2);
    g.shadowOffsetX = OFF + dx;
    g.shadowOffsetY = dy;
    const whole = Math.floor(times), frac = times - whole;
    for (let i = 0; i < whole; i++) g.drawImage(src, -OFF, 0);
    if (frac > 0.05) { g.globalAlpha = frac; g.drawImage(src, -OFF, 0); }
    g.restore();
  }

  /**
   * 層の名前の並び（単位ごとの絵でも同じ並びにする）
   */
  function layerNames(st) {
    const out = [];
    if (shadowOf(st)) out.push('shadow');
    if (st.glow && st.glow.radius) out.push('glow');
    strokesOf(st).forEach((_, i) => out.push('stroke' + i));
    if (!st.hollow) out.push('fill');
    return out;
  }

  /** 1 つの層を g に描く（g の大きさは w×h、横は wx0 からの窓） */
  function paintLayer(g, name, lay, st, scale, sel, wx0) {
    const w = g.canvas.width, h = g.canvas.height;
    if (name === 'shadow') {
      const sh = shadowOf(st);
      const src = outerShape(lay, st, scale, sel, w, h, wx0);
      shadowFrom(g, src, sh.color || '#000000a0', Math.round((sh.dx || 0) * scale), Math.round((sh.dy || 0) * scale), (sh.blur || 0) * scale);
      return;
    }
    if (name === 'glow') {
      const src = outerShape(lay, st, scale, sel, w, h, wx0);
      shadowFrom(g, src, st.glow.color || '#ffffff', 0, 0, Math.max(0.5, st.glow.radius * scale), st.glow.strength ?? 1.6);
      return;
    }
    if (name.startsWith('stroke')) {
      const strokes = strokesOf(st).sort((a, b) => b[0] - a[0]);
      const [sw, col] = strokes[Number(name.slice(6))];
      const wpx = Math.max(1, Math.round(sw * scale));
      if (!st.hollow) { shape(g, lay, sel, wpx, col, -wx0, 0); return; }
      const c = canvas(w, h);
      const cg = c.getContext('2d');
      shape(cg, lay, sel, wpx, col, -wx0, 0);
      cg.globalCompositeOperation = 'destination-out';
      shape(cg, lay, sel, 0, '#000', -wx0, 0);
      g.drawImage(c, 0, 0);
      return;
    }
    if (name === 'fill') {
      const grad = Array.isArray(st.gradient) && st.gradient.length >= 2 ? st.gradient : null;
      if (!grad) { shape(g, lay, sel, 0, st.color || '#ffffff', -wx0, 0); return; }
      lay.lines.forEach((_, i) => {
        if (sel && sel[1] !== i) return;
        const [y0, y1] = lay.grad[i];
        const lg = g.createLinearGradient(0, y0, 0, Math.max(y0 + 1, y1));
        grad.forEach((c, k) => lg.addColorStop(k / (grad.length - 1), c));
        shape(g, lay, sel ? sel : ['line', i], 0, lg, -wx0, 0);
      });
    }
  }

  function paintBox(g, lay, st, scale, wx0 = 0) {
    const pad = lay.pad;
    const x0 = pad - wx0, y0 = pad, x1 = lay.W - pad - wx0, y1 = lay.H - pad;
    const r = Math.min(lay.size * (st.box_radius ?? 0.2), (x1 - x0) / 2, (y1 - y0) / 2);
    g.save();
    g.beginPath();
    roundRect(g, x0, y0, x1 - x0, y1 - y0, r);
    g.fillStyle = st.box_color || '#000000a0';
    g.fill();
    const bar = st.box_bar;
    if (bar && bar.width) {
      g.clip();
      g.fillStyle = bar.color || '#3a7bd5';
      g.fillRect(x0, y0, Math.max(1, Math.round(bar.width * scale)), y1 - y0);
    }
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /** 文字の絵（帯も含めた 1 枚）。返り値は canvas（大きさは layout の W×H） */
  function render(text, style, scale) {
    const st = richen(style);
    const key = 'R|' + text + '|' + JSON.stringify(st) + '|' + scale.toFixed(4);
    const hit = recall(key);
    if (hit) return hit;
    const lay = layout(text, st, scale);
    const c = canvas(lay.W, lay.H);
    const g = c.getContext('2d');
    if (st.box) paintBox(g, lay, st, scale);
    for (const name of layerNames(st)) paintLayer(g, name, lay, st, scale, null, 0);
    return remember(key, c);
  }

  /**
   * 1 行ずつ（unit='line'）・1 文字ずつ（'char'）に分けた絵。層ごと・単位ごとの canvas と、全体の絵の中の位置。
   * 返り値 { W, H, units: [{line, char, pivot, rect, layers: [{c, x0, y0} | null]}], lineGeo: [[pivot, rect]], box, nLayers }
   */
  function unitSprites(text, style, scale, unit) {
    const st = richen(style);
    const key = 'U|' + unit + '|' + text + '|' + JSON.stringify(st) + '|' + scale.toFixed(4);
    const hit = recall(key);
    if (hit) return hit;
    const lay = layout(text, st, scale);
    const names = layerNames(st);
    const units = [];
    const lineGeo = [];
    const margin = lay.pad + Math.floor(lay.size * 0.3) + 2;
    const sprite = (sel, wx0, wx1) => names.map((name) => {
      const c = canvas(wx1 - wx0, lay.H);
      paintLayer(c.getContext('2d'), name, lay, st, scale, sel, wx0);
      return { c, x0: wx0, y0: 0 };
    });
    let nChar = 0;
    lay.lines.forEach((ln, i) => {
      const top = lay.tops[i];
      const x0 = lay.starts[i][0];
      const geo = [[x0 + lay.widths[i] / 2, top + lay.lineH / 2], [x0 - lay.pad, top - lay.pad, x0 + lay.widths[i] + lay.pad, top + lay.lineH + lay.pad]];
      lineGeo.push(geo);
      if (unit === 'line') {
        if (ln.trim()) units.push({ line: i, char: null, pivot: geo[0], rect: geo[1], layers: sprite(['line', i], 0, lay.W) });
        return;
      }
      lay.glyphs[i].forEach((ch, j) => {
        if (!ch.trim()) return;
        const cx = lay.chars[i][j], adv = lay.advs[i][j];
        const wx0 = Math.max(0, Math.floor(cx - margin)), wx1 = Math.min(lay.W, Math.ceil(cx + adv + margin));
        units.push({ line: i, char: nChar++, pivot: [cx + adv / 2, top + lay.lineH / 2], rect: [cx - lay.pad, top - lay.pad, cx + adv + lay.pad, top + lay.lineH + lay.pad], layers: sprite(['char', i, j], wx0, wx1) });
      });
    });
    let box = null;
    if (st.box) {
      const c = canvas(lay.W, lay.H);
      paintBox(c.getContext('2d'), lay, st, scale);
      box = { c, x0: 0, y0: 0 };
    }
    const out = { W: lay.W, H: lay.H, unit, units, lineGeo, box, nLayers: names.length, counts: { whole: 1, line: lay.lines.length, char: nChar } };
    return remember(key, out);
  }

  /** 吹き出し（角の丸い枠＋しっぽ＋名前札）。exe の render_bubble と同じ寸法 */
  function renderBubble(text, style, scale, name) {
    const key = 'B|' + text + '|' + name + '|' + JSON.stringify(style) + '|' + scale.toFixed(4);
    const hit = recall(key);
    if (hit) return hit;
    const size = Math.max(6, Math.round((style.size || 50) * scale));
    const font = fontOf({ ...style, weight: style.bold === false ? 400 : 700 }, size);
    meas.font = font;
    const lines = String(text).split('\n');
    const spacing = Math.floor(size * 0.2);
    const widths = lines.map((ln) => meas.measureText(ln || ' ').width);
    const lineH = Math.floor(size * 1.25);
    const bw = Math.max(2, Math.floor(size * 0.07));
    const padX = Math.floor(size * 0.6), padY = Math.floor(size * 0.32);
    const bodyW = Math.max(...widths) + padX * 2 + bw * 2;
    const bodyH = lineH * lines.length + spacing * (lines.length - 1) + padY * 2 + bw * 2;
    const tail = style.tail || 'none';
    const th = tail === 'up' || tail === 'down' ? Math.floor(size * 0.8) : 0;
    const tw = Math.floor(size * 0.85);
    const showName = !!style.show_name && !!name;
    const ntagH = showName ? Math.floor(size * 0.5 * 1.5) : 0;
    const sh = style.shadow ? Math.floor(size * 0.08) : 0;
    const topExtra = (tail === 'up' ? th : 0) + (showName ? Math.floor(ntagH / 2) : 0);
    const W = bodyW + sh + 2, H = topExtra + bodyH + (tail === 'down' ? th : 0) + sh + 2;
    const c = canvas(W, H);
    const g = c.getContext('2d');
    const fill = style.box_color || '#ffffff', border = style.border_color || '#3a7bd5';
    const r = Math.floor(size * 0.45);
    const x0 = 0, y0 = topExtra, x1 = bodyW, y1 = topExtra + bodyH;
    const side = style.tail_side || 'left';
    const cx = side === 'left' ? x0 + bodyW * 0.22 : side === 'right' ? x0 + bodyW * 0.78 : x0 + bodyW / 2;
    let tri = null;
    if (tail === 'up') tri = [[cx - tw / 2, y0 + bw * 2], [cx + tw / 2, y0 + bw * 2], [cx - tw * 0.15, y0 - th]];
    else if (tail === 'down') tri = [[cx - tw / 2, y1 - bw * 2], [cx + tw / 2, y1 - bw * 2], [cx + tw * 0.15, y1 + th]];
    const poly = (pts, color, ox = 0, oy = 0) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy))); g.closePath(); g.fillStyle = color; g.fill(); };
    const rrect = (a, b, w, hh, rr, color) => { g.beginPath(); roundRect(g, a, b, w, hh, rr); g.fillStyle = color; g.fill(); };
    if (sh) {
      rrect(x0 + sh, y0 + sh, bodyW, bodyH, r, 'rgba(0,0,0,0.31)');
      if (tri) poly(tri, 'rgba(0,0,0,0.31)', sh, sh);
    }
    rrect(x0, y0, bodyW, bodyH, r, border);
    if (tri) poly(tri, border);
    rrect(x0 + bw, y0 + bw, bodyW - 2 * bw, bodyH - 2 * bw, Math.max(1, r - bw), fill);
    if (tri) poly([[tri[0][0] + bw, tri[0][1]], [tri[1][0] - bw, tri[1][1]], [tri[2][0], tri[2][1] + (tail === 'up' ? bw * 1.6 : -bw * 1.6)]], fill);
    g.font = font;
    g.textBaseline = 'top';
    g.fillStyle = style.color || '#1d1d1f';
    let ty = y0 + bw + padY + Math.floor(size * 0.08);
    lines.forEach((ln, i) => { g.fillText(ln, (bodyW - widths[i]) / 2, ty); ty += lineH + spacing; });
    if (showName) {
      const nfont = fontOf({ ...style, weight: 700 }, Math.max(6, Math.floor(size * 0.5)));
      g.font = nfont;
      const nwText = g.measureText(name).width;
      const nw = nwText + Math.floor(size * 0.5);
      const nx = side === 'left' ? x1 - Math.floor(size * 0.4) - nw : x0 + Math.floor(size * 0.4);
      const ny = y0 - Math.floor(ntagH / 2);
      rrect(nx, ny, nw, ntagH, ntagH / 2, border);
      g.fillStyle = '#ffffff';
      g.textBaseline = 'middle';
      g.fillText(name, nx + (nw - nwText) / 2, ny + ntagH / 2);
    }
    return remember(key, c);
  }

  return { richen, isRich, richPad, layout, render, unitSprites, renderBubble, layerNames, roundRect };
})();
