/* ------------------------------------------------------------
   テロップのスタイル・カタログの画面（100 種の見本から選ぶ）
   見本は小さく描いた本物（TextRender）。少しずつ描いて画面を固まらせない。
   ------------------------------------------------------------ */
const StylePicker = (() => {
  const TILE_W = 196, TILE_H = 92;

  /** 選ぶ。返り値はカタログのスタイル（やめたら null） */
  async function pick(sample, currentId) {
    await Telop.load();
    const text = (String(sample || '').split('\n')[0] || 'テロップ').slice(0, 8) || 'テロップ';
    const favs = Telop.favorites();
    const cat = h('select', null, h('option', { value: '' }, 'すべての種類'), ...Telop.categories().map((c) => h('option', { value: c }, c)));
    const col = h('select', null, h('option', { value: '' }, 'すべての色'), ...Telop.colorTags().map((c) => h('option', { value: c }, c)));
    const q = h('input', { type: 'search', placeholder: '探す（例: 縁取り・帯・ネオン）' });
    const favOnly = h('label', { class: 'pick-fav' }, h('input', { type: 'checkbox' }), '★だけ');
    const grid = h('div', { class: 'style-grid' });
    const count = h('span', { class: 'hint' });
    let chosen = null;
    let closeFn = null;
    let job = 0;

    function draw(tile, st) {
      const cv = tile.querySelector('canvas');
      const g = cv.getContext('2d');
      const style = Telop.toClipStyle(st);
      delete style.anchor;
      const img = TextRender.render(text, style, 0.42);
      const k = Math.min(1, (cv.width - 8) / img.width, (cv.height - 8) / img.height);
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(img, (cv.width - img.width * k) / 2, (cv.height - img.height * k) / 2, img.width * k, img.height * k);
    }

    function list() {
      grid.textContent = '';
      const items = Telop.filter({ category: cat.value || null, color: col.value || null, query: q.value, ids: favOnly.firstChild.checked ? favs : null });
      count.textContent = `${items.length} 種`;
      const my = ++job;
      const tiles = items.map((st) => {
        const star = h('button', { class: 'star' + (favs.has(st.id) ? ' on' : ''), 'aria-label': 'お気に入り', onclick: (e) => {
          e.stopPropagation();
          if (favs.has(st.id)) favs.delete(st.id); else favs.add(st.id);
          Telop.setFavorites(favs);
          star.classList.toggle('on', favs.has(st.id));
        } }, '★');
        const tile = h('div', { class: 'style-tile' + (st.id === currentId ? ' current' : ''), title: st.name, onclick: () => { chosen = st; if (closeFn) closeFn('picked'); } },
          h('canvas', { width: TILE_W * 2, height: TILE_H * 2 }), h('div', { class: 'style-name' }, st.name), star);
        grid.append(tile);
        return [tile, st];
      });
      // 少しずつ描く
      let i = 0;
      const step = () => {
        if (my !== job) return;
        const t0 = performance.now();
        while (i < tiles.length && performance.now() - t0 < 24) { draw(...tiles[i]); i++; }
        if (i < tiles.length) setTimeout(step, 0);
      };
      step();
    }
    [cat, col, favOnly.firstChild].forEach((e) => e.addEventListener('change', list));
    q.addEventListener('input', list);
    const body = h('div', { class: 'picker' }, h('div', { class: 'picker-filters' }, cat, col, q, favOnly, count), grid);
    await showDialog({ title: 'テロップのスタイル', body, wide: true, buttons: [{ label: 'やめる', value: null }], onOpen: (box, close) => { closeFn = close; list(); } });
    job++;
    return chosen;
  }

  return { pick };
})();
