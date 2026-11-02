/* ------------------------------------------------------------
   テロップ（映像トラックの文字クリップ）と字幕（字幕トラック）を画面に置く。exe の render.py と同じ置き方。

   - 大きさは 1080p 基準: 出力の倍率 × 作品の高さ / 1080 × クリップの拡大（拡大は絵を引き伸ばさず、その大きさで描き直す）。
   - テロップの基準の位置は style.anchor（左上〜右下・中央）と margin_x / margin_y、そこから pos_x / pos_y だけずらす。
   - モーションは単位（全体・1 行・1 文字）ごとに「登場 → 強調 → 退場」の変形を重ね、層ごとに全部の単位を描く
     （1 文字ずつの時、隣の文字の縁が塗りに被らないように）。
   ------------------------------------------------------------ */
const TelopDraw = (() => {
  function textStyle(c) {
    const st = { ...Telop.defaultTextStyle(), ...(c.style || {}) };
    if (c.motion && Motion.finestUnit(c.motion) !== 'whole' && !st.text_align) st.text_align = 'center';
    return st;
  }

  /** テロップの中心（出力の座標）。w・h は絵の大きさ、kOut = 出力の画素 / 作品の画素 */
  function textCenter(p, c, st, w, h, kOut) {
    const W = p.width * kOut, H = p.height * kOut;
    let cx = W / 2, cy = H / 2;
    const anchor = (c.style || {}).anchor;
    if (anchor && anchor !== 'center') {
      const k = p.height / 1080 * kOut;
      const pad = TextRender.richPad(TextRender.richen(st), k * Math.max(0.01, c.scale))[0];
      const mx = ((c.style || {}).margin_x ?? 80) * k;
      const my = ((c.style || {}).margin_y ?? 60) * k;
      if (anchor.endsWith('left')) cx = mx - pad + w / 2;
      else if (anchor.endsWith('right')) cx = W - mx + pad - w / 2;
      if (anchor.startsWith('top')) cy = my - pad + h / 2;
      else if (anchor.startsWith('bottom')) cy = H - my + pad - h / 2;
    }
    return [cx + c.pos_x * kOut, cy + c.pos_y * kOut];
  }

  const textScale = (p, c, kOut) => p.height / 1080 * kOut * Math.max(0.01, c.scale);

  /** テロップを描く（g の変形は何でもよい。中で出力の座標に戻す） */
  function drawText(g, p, c, fr, kOut, alpha, tr) {
    if (!c.text) return;
    if (tr) c = { ...c, ...tr };          // キーフレームを反映した位置・拡大・回転
    const st = textStyle(c);
    if (c.motion && Motion.catalog && drawMotion(g, p, c, fr, kOut, alpha, st)) return;
    const img = TextRender.render(c.text, st, textScale(p, c, kOut));
    const [cx, cy] = textCenter(p, c, st, img.width, img.height, kOut);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    if (Math.abs(c.rotation || 0) % 360 > 0.01) {
      g.translate(cx, cy);
      g.rotate(c.rotation * Math.PI / 180);
      g.drawImage(img, -img.width / 2, -img.height / 2);
    } else {
      g.drawImage(img, Math.round(cx - img.width / 2), Math.round(cy - img.height / 2));
    }
    g.restore();
  }

  function drawMotion(g, p, c, fr, kOut, alpha, st) {
    const unit = Motion.finestUnit(c.motion);
    const k = textScale(p, c, kOut);
    const fps = Proj.fps(p);
    let w, h, units, lineGeo, box, nLayers, counts;
    if (unit === 'whole') {
      const img = TextRender.render(c.text, st, k);
      w = img.width; h = img.height;
      units = [{ line: 0, char: 0, pivot: [w / 2, h / 2], rect: [0, 0, w, h], layers: [{ c: img, x0: 0, y0: 0 }] }];
      lineGeo = [[[w / 2, h / 2], [0, 0, w, h]]];
      box = null; nLayers = 1; counts = { whole: 1 };
    } else {
      const us = TextRender.unitSprites(c.text, st, k, unit);
      ({ W: w, H: h, units, lineGeo, box, nLayers, counts } = us);
    }
    const plan = Motion.makePlan(c.motion, Math.max(1, c.duration - 1) / fps, counts);
    if (!plan) return false;
    const t = (fr - c.start) / fps;
    const [cx, cy] = textCenter(p, c, st, w, h, kOut);
    const geo = { whole: [[w / 2, h / 2], [0, 0, w, h]], lines: lineGeo, sizePx: (st.size || 96) * k, W: p.width * kOut, H: p.height * kOut };
    let base = [1, 0, 0, 1, Math.round(cx - w / 2), Math.round(cy - h / 2)];
    if (Math.abs(c.rotation || 0) % 360 > 0.01) {
      const a = c.rotation * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
      base = Motion.mul([co, si, -si, co, cx - co * cx + si * cy, cy - si * cx - co * cy], base);
    }
    g.save();
    if (box) {
      const s = Motion.unitState(plan, t, geo, { box: true });
      paste(g, box, Motion.mul(base, s.M), alpha * s.opacity, s.blur * k, s.tint, s.tintColor, s.wipes);
    }
    const states = units.map((u) => Motion.unitState(plan, t, geo, { line: u.line, char: u.char, pivot: u.pivot, rect: u.rect }));
    for (let L = 0; L < nLayers; L++) {
      units.forEach((u, i) => {
        const spr = u.layers[L];
        const s = states[i];
        if (spr) paste(g, spr, Motion.mul(base, s.M), alpha * s.opacity, s.blur * k, s.tint, s.tintColor, s.wipes);
      });
    }
    g.restore();
    return true;
  }

  function scratch(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /** 1 つの絵 {c, x0, y0}（全体の絵の座標）を行列 M で重ねる。拭き取り・色寄せ・ぼかしもここで */
  function paste(g, spr, M, opacity, blur, tint, tcol, wipes) {
    if (opacity <= 0.001) return;
    let img = spr.c, x0 = spr.x0, y0 = spr.y0;
    if (wipes.length || tint > 0.001 || blur > 0.3) {
      const t = scratch(img.width, img.height);
      const tg = t.getContext('2d');
      tg.drawImage(img, 0, 0);
      for (const [[rx0, ry0, rx1, ry1], pr, d] of wipes) {
        const horiz = d === 'ltr' || d === 'rtl';
        const lo = horiz ? rx0 : ry0, hi = horiz ? rx1 : ry1;
        const ext = Math.max(1, hi - lo);
        const soft = Math.max(2, ext * 0.08);
        const off = horiz ? x0 : y0;
        // 見えている所（覆い 1）と消えている所（0）の境目を soft の幅でなめらかに
        let a, b;
        if (d === 'ltr' || d === 'ttb') { b = lo + pr * (ext + soft) - off; a = b - soft; }
        else { a = hi - pr * (ext + soft) - off; b = a + soft; }
        const lg = horiz ? tg.createLinearGradient(a, 0, b, 0) : tg.createLinearGradient(0, a, 0, b);
        const fwd = d === 'ltr' || d === 'ttb';
        lg.addColorStop(0, fwd ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0)');
        lg.addColorStop(1, fwd ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,1)');
        tg.globalCompositeOperation = 'destination-in';
        tg.fillStyle = lg;
        tg.fillRect(0, 0, t.width, t.height);
        tg.globalCompositeOperation = 'source-over';
      }
      if (tint > 0.001) {
        tg.globalCompositeOperation = 'source-atop';
        tg.globalAlpha = Math.min(1, tint);
        tg.fillStyle = tcol || '#ffffff';
        tg.fillRect(0, 0, t.width, t.height);
        tg.globalAlpha = 1;
        tg.globalCompositeOperation = 'source-over';
      }
      img = t;
      if (blur > 0.3) {
        // ぼかし（ctx.filter が使えない Safari のため、縮めて広げる近似）
        const m = Math.ceil(blur * 3) + 1;
        const f = Math.max(1, blur / 1.2);
        const small = scratch((img.width + 2 * m) / f, (img.height + 2 * m) / f);
        const sg = small.getContext('2d');
        sg.imageSmoothingQuality = 'high';
        sg.drawImage(img, m / f, m / f, img.width / f, img.height / f);
        const big = scratch(img.width + 2 * m, img.height + 2 * m);
        const bg = big.getContext('2d');
        bg.imageSmoothingQuality = 'high';
        bg.drawImage(small, 0, 0, big.width, big.height);
        img = big; x0 -= m; y0 -= m;
      }
    }
    g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    g.globalAlpha = Math.min(1, opacity);
    g.drawImage(img, x0, y0);
    g.globalAlpha = 1;
  }

  // ---- 字幕 -----------------------------------------------------------------------
  function subtitleImage(p, c, kOut) {
    const st = Telop.clipSubtitleStyle(p, c);
    const k = p.height / 1080 * kOut;
    const img = st.bubble ? TextRender.renderBubble(c.text, st, k, (c.style || {}).speaker) : TextRender.render(c.text, st, k);
    return { st, img, k };
  }

  function subtitlePos(p, c, st, img, k, kOut) {
    const W = p.width * kOut, H = p.height * kOut;
    const w = img.width, h = img.height;
    const margin = (st.margin ?? 60) * k;
    const mx = (st.margin_x ?? 80) * k;
    const halign = st.halign || 'center', align = st.align || 'bottom';
    let x = halign === 'left' ? mx : halign === 'right' ? W - mx - w : (W - w) / 2;
    let y = align === 'top' ? margin : align === 'middle' ? (H - h) / 2 : H - margin - h;
    x += c.pos_x * kOut; y += c.pos_y * kOut;
    return [Math.round(x), Math.round(y)];
  }

  function drawSubtitles(g, p, fr, kOut, fade) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const t of p.tracks) {
      if (t.kind !== 'subtitle' || t.muted) continue;
      for (const c of Object.values(p.clips)) {
        if (c.track !== t.id || !c.enabled || !c.text || !(c.start <= fr && fr < Proj.end(c))) continue;
        const { st, img, k } = subtitleImage(p, c, kOut);
        const [x, y] = subtitlePos(p, c, st, img, k, kOut);
        const a = clamp(c.opacity, 0, 1) * fade(c, Math.floor(fr));
        if (a <= 0) continue;
        g.globalAlpha = a;
        g.drawImage(img, x, y);
      }
    }
    g.restore();
  }

  /** 画面上の枠（作品の画素）: {cx, cy, w, h, rot}。プレビューで掴む・枠を描く用 */
  function bounds(p, c, tr) {
    if (tr) c = { ...c, ...tr };
    const track = Proj.track(p, c.track);
    if (track && track.kind === 'subtitle') {
      const { st, img, k } = subtitleImage(p, c, 1);
      const [x, y] = subtitlePos(p, c, st, img, k, 1);
      return { cx: x + img.width / 2, cy: y + img.height / 2, w: img.width, h: img.height, rot: 0 };
    }
    const st = textStyle(c);
    const img = TextRender.render(c.text, st, textScale(p, c, 1));
    const [cx, cy] = textCenter(p, c, st, img.width, img.height, 1);
    return { cx, cy, w: img.width, h: img.height, rot: c.rotation || 0 };
  }

  return { drawText, drawSubtitles, bounds, textStyle };
})();
