/* ------------------------------------------------------------
   テロップのスタイル（カタログ）と字幕の既定（exe の core/telop.py・subrender.py と同じ決まり）

   - assets/telop_styles/bases.json × palettes.json を展開して 100 種。"$名前" は配色の値に置き換える。
   - クリップの style には exe と同じ項目名で写す（.ekp で行き来できるように）。フォント名も exe の名前のまま持ち、
     描く時だけ iPad にある書体（ヒラギノなど）に置き換える。
   ------------------------------------------------------------ */
const Telop = (() => {
  const RENDER_KEYS = ['size', 'weight', 'bold', 'color', 'gradient', 'strokes', 'shadow', 'glow', 'spacing', 'line_spacing',
    'hollow', 'text_align', 'box', 'box_color', 'box_radius', 'box_pad_x', 'box_pad_y', 'box_bar', 'anchor', 'margin_x', 'margin_y'];
  const CLEAR_KEYS = RENDER_KEYS.concat(['outline', 'outline_color', 'font', 'telop_style']);
  const ANCHORS = ['top_left', 'top_center', 'top_right', 'middle_left', 'center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'];
  const ANCHOR_NAMES = { top_left: '左上', top_center: '上', top_right: '右上', middle_left: '左', center: '中央', middle_right: '右', bottom_left: '左下', bottom_center: '下', bottom_right: '右下' };
  const FAV_KEY = 'eikobo-web:telop-favorites';

  // exe のフォント名 → 描く時の書体の並び（iPad にはヒラギノ、Windows の Chrome には元の書体がある）
  const GOTHIC = ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'YuGothic', 'Meiryo', 'Noto Sans JP', 'sans-serif'];
  const MINCHO = ['Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho', 'BIZ UDMincho', 'Noto Serif JP', 'serif'];
  const ROUND = ['Hiragino Maru Gothic ProN', 'Klee', 'UD Digi Kyokasho N-R', 'Hiragino Sans', 'sans-serif'];
  const FONT_STACKS = {
    'BIZ UDGothic': ['BIZ UDGothic', 'BIZ UDPGothic'].concat(GOTHIC),
    'Noto Sans JP': ['Noto Sans JP'].concat(GOTHIC),
    'Yu Gothic': ['Yu Gothic', 'YuGothic'].concat(GOTHIC),
    'Meiryo': ['Meiryo'].concat(GOTHIC),
    'Yu Mincho': ['Yu Mincho', 'YuMincho'].concat(MINCHO),
    'BIZ UDMincho': ['BIZ UDMincho'].concat(MINCHO),
    'MS Mincho': ['MS Mincho'].concat(MINCHO),
    'IPAmjMincho': ['IPAmjMincho'].concat(MINCHO),
    'Noto Serif JP': ['Noto Serif JP'].concat(MINCHO),
    'UD Digi Kyokasho N': ['UD Digi Kyokasho N-R', 'UD Digi Kyokasho N'].concat(ROUND),
  };
  // 選べる書体（調整パネル用。exe の名前）
  const FONT_CHOICES = [['BIZ UDGothic', 'ゴシック'], ['Yu Mincho', '明朝'], ['UD Digi Kyokasho N', '丸ゴシック・教科書体'], ['Noto Sans JP', 'ゴシック（Noto）'], ['Noto Serif JP', '明朝（Noto）']];

  function cssFamily(name) {
    const list = FONT_STACKS[name] || [name].concat(GOTHIC);
    return list.map((f) => (/^(sans-serif|serif)$/.test(f) ? f : `"${f}"`)).join(', ');
  }

  // ---- 既定 ---------------------------------------------------------------------
  function defaultTextStyle() {
    return { font: 'BIZ UDGothic', size: 96, color: '#ffffff', bold: true, outline: 8, outline_color: '#000000', box: false, box_color: '#000000a0', shadow: true };
  }
  function defaultSubtitleStyle() {
    return { font: 'BIZ UDGothic', size: 54, color: '#ffffff', bold: true, outline: 5, outline_color: '#000000', box: false, box_color: '#000000a0', align: 'bottom', margin: 60, max_chars: 18 };
  }

  // 話者ごとの吹き出しの既定（1 人目は上・2 人目は下）
  const SPEAKER_PRESETS = [
    { align: 'top', halign: 'left', border_color: '#3a7bd5', tail: 'up', tail_side: 'left' },
    { align: 'bottom', halign: 'right', border_color: '#e0457b', tail: 'down', tail_side: 'right' },
    { align: 'top', halign: 'right', border_color: '#2fa86b', tail: 'up', tail_side: 'right' },
    { align: 'bottom', halign: 'left', border_color: '#e08a2e', tail: 'down', tail_side: 'left' },
  ];
  const BUBBLE_BASE = { bubble: true, box_color: '#ffffff', color: '#1d1d1f', outline: 0, size: 50, show_name: true, shadow: true, margin: 50, margin_x: 80 };
  const speakerPreset = (i) => ({ ...BUBBLE_BASE, ...SPEAKER_PRESETS[i % SPEAKER_PRESETS.length] });

  /** 字幕クリップの見た目: 全体の字幕スタイル ← 話者 ← クリップ個別 */
  function clipSubtitleStyle(p, c) {
    const all = p.subtitle_style || defaultSubtitleStyle();
    const base = {};
    for (const [k, v] of Object.entries(all)) if (k !== 'speakers') base[k] = v;
    const sp = c.style && c.style.speaker;
    if (sp) Object.assign(base, (all.speakers || {})[sp] || {});
    if (c.style) for (const [k, v] of Object.entries(c.style)) if (k !== 'speaker') base[k] = v;
    return base;
  }

  // ---- カタログ -------------------------------------------------------------------
  let catalog = null;          // {styles, warnings}

  function subst(v, pal, pid) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const key = v.slice(1);
      if (!(key in pal)) throw new Error(`配色 ${pid} に ${key} がありません`);
      return JSON.parse(JSON.stringify(pal[key]));
    }
    if (Array.isArray(v)) return v.map((x) => subst(x, pal, pid));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = subst(x, pal, pid); return o; }
    return v;
  }

  async function load() {
    if (catalog) return catalog;
    const warnings = [];
    const [bases, pals] = await Promise.all([
      fetch('assets/telop_styles/bases.json').then((r) => r.json()),
      fetch('assets/telop_styles/palettes.json').then((r) => r.json()),
    ]);
    const palettes = pals.palettes || {};
    const styles = [];
    for (const b of bases.bases || []) {
      for (const pid of b.palettes || []) {
        const pal = palettes[pid];
        if (!pal) { warnings.push(`${b.id}: 配色 ${pid} がありません`); continue; }
        try {
          const body = subst(b.style, pal, pid);
          styles.push({
            id: `${b.id}.${pid}`, name: `${b.name || b.id}・${pal.name || pid}`, category: b.category || 'その他',
            tags: (b.tags || []).slice(), color_tags: (pal.color_tags || []).slice(), fonts: (b.fonts || []).slice(),
            base: b.id, palette: pid, size: 96, ...body,
          });
        } catch (err) { warnings.push(`${b.id}: ${err.message}`); }
      }
    }
    catalog = { styles, warnings };
    return catalog;
  }

  const get = (id) => (catalog ? catalog.styles.find((s) => s.id === id) || null : null);
  const categories = () => [...new Set((catalog ? catalog.styles : []).map((s) => s.category))];
  const colorTags = () => [...new Set((catalog ? catalog.styles : []).flatMap((s) => s.color_tags))];

  function filter({ category, color, query, ids } = {}) {
    const q = (query || '').trim().toLowerCase();
    return (catalog ? catalog.styles : []).filter((s) => {
      if (category && s.category !== category) return false;
      if (color && !s.color_tags.includes(color)) return false;
      if (ids && !ids.has(s.id)) return false;
      if (q && ![s.id, s.name, s.category, ...s.tags].some((v) => String(v).toLowerCase().includes(q))) return false;
      return true;
    });
  }

  /** カタログのスタイル → クリップの style に写す辞書 */
  function toClipStyle(st) {
    const out = {};
    for (const k of RENDER_KEYS) if (k in st) out[k] = JSON.parse(JSON.stringify(st[k]));
    out.font = st.fonts[0] || 'BIZ UDGothic';
    if (!('bold' in out)) out.bold = (st.weight || 700) >= 600;
    if (!('shadow' in out)) out.shadow = false;
    if (!('strokes' in out)) out.strokes = [];
    out.telop_style = st.id;
    return out;
  }

  /** 今の style にカタログのスタイルを当てる（スタイルの項目は入れ替え、それ以外は残す） */
  function applyToStyle(old, st) {
    const base = {};
    for (const [k, v] of Object.entries(old || {})) if (!CLEAR_KEYS.includes(k)) base[k] = v;
    return { ...base, ...toClipStyle(st) };
  }

  function favorites() {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
  }
  function setFavorites(set) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch { /* 保存できなくても使える */ }
  }

  return {
    RENDER_KEYS, ANCHORS, ANCHOR_NAMES, FONT_CHOICES, cssFamily, defaultTextStyle, defaultSubtitleStyle, speakerPreset, clipSubtitleStyle,
    load, get, categories, colorTags, filter, toClipStyle, applyToStyle, favorites, setFavorites,
    get catalog() { return catalog; },
  };
})();
