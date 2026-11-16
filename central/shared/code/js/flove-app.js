/* ============================================================
   flove-app.js · central app driver (risa/ama/maria indexes).
   Cada playlist (risas de la gente · risas del mundo · amores) llama
   al MISMO código — FloveApp.section() — solo cambia el contenido:
   tags-space, reproductor, media-toggle y filtro propios por sección.
   Powered by central/shared/code (flove-feed · flove-tags ·
   flove-player · flove-bottom-nav). Exposes window.FloveApp and
   keeps window.RisaApp as a backward-compatible alias.
   ============================================================ */
(function (global) {
  'use strict';
  var F = global.floveFeed;
  var T = global.FloveTags;
  var P = global.FlovePlayer;
  var N = global.FloveNav;

  /* ── UNA playlist: llama a las libs (FloveTags + FlovePlayer) una vez ──
   risa la llama 2× (gente + mundo), ama 1× (amores). Solo cambia el contenido. */
  function playlist(sc, shared) {
    var selected = new Set();
    var favFilter = false;
    var feedError = false;
    var space = document.getElementById(sc.tagSpaceId || 'tag-space');
    var player = P.create(document.getElementById(sc.playerRootId || 'player-root'), {
      pageSize: sc.pageSize || shared.pageSize || 10,
      repo: sc.repo || shared.feedUrl,
      alwaysRepo: sc.alwaysRepo,
      playBtn: document.querySelector(sc.playBtn || '[data-play]'),
      prevBtn: document.querySelector(sc.prevBtn || '[data-prev]'),
      nextBtn: document.querySelector(sc.nextBtn || '[data-next]'),
      mediaAudio: sc.mediaAudio || '[data-media="audio"]',
      mediaVideo: sc.mediaVideo || '[data-media="video"]',
      mediaHost: sc.mediaHost || null,
      favs: shared.favs,
      self: shared.self,   // sesión (Telegram): sin ella no se renderizan reacciones
      shareText: sc.shareText || shared.shareText || 'Escucha esto 😄',
      shareTitle: sc.shareTitle || shared.shareTitle || shared.app,
      onFavToggle: function (src, btn, on) { btn.classList.toggle('on', on); btn.textContent = on ? '★' : '☆'; shared.saveFavs(); },
      onReply: function (t, btn) { if (shared.onReply) shared.onReply(t, btn); },
      onRemix: function (t, btn) { if (shared.onRemix) shared.onRemix(t, btn); },
      onReaction: function (t, emoji) { if (shared.onReaction) shared.onReaction(t, emoji); }
    });

    function clips() {
      /* sc.clips = fuente PROPIA de la sección (playlist curada/estática):
         no usa el feed compartido del bot. sc.filter aún se aplica encima. */
      var list = sc.clips ? sc.clips.slice() : shared.risas.slice();
      if (sc.filter) list = list.filter(sc.filter);
      return list;
    }
    function tagStats() {
      var m = new Map();
      clips().forEach(function (c) {
        Array.from(new Set(F.tagList(c.tags).concat(F.tgOf(c) ? [F.tgOf(c)] : []))).forEach(function (tag) {
          if (tag) m.set(tag, (m.get(tag) || 0) + 1);
        });
      });
      return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; });
    }
    function trackKeys(t) {
      var keys = F.tagList(t.tags);
      if (t.tg) keys.push(t.tg);
      var title = String(t.t || '').trim().toLowerCase();
      if (title) keys.push(title);
      return keys;
    }
    function currentTracks() {
      var list = F.buildTracks(clips());
      if (selected.size) list = list.filter(function (t) { return trackKeys(t).some(function (k) { return selected.has(k); }); });
      if (favFilter) list = list.filter(function (t) { return shared.favs.has(t.src); });
      var byId = new Map();
      list.forEach(function (t) { if (t.clip && t.clip.id) byId.set(t.clip.id, t); });
      var out = [];
      F.threadOrder(list.map(function (t) { return t.clip || {}; })).forEach(function (o) {
        var tr = o.clip && byId.get(o.clip.id);
        if (tr) out.push(Object.assign({}, tr, { depth: o.depth }));
      });
      return out;
    }
    function applyFilters() {
      var empty = favFilter
        ? F.esTxt('Aún no has marcado ninguna con la estrella ⭐', 'You haven\'t starred any yet ⭐')
        : selected.size ? F.esTxt('Ninguna lleva esas etiquetas 😅', 'No piece has those tags 😅')
          : sc.emptyMsg || F.esTxt('Aún no hay piezas en el feed · sé la primera 💛', 'No pieces in the feed yet · be the first 💛');
      player.select(currentTracks(),
        favFilter ? F.esTxt('Mis favoritas ⭐', 'My favourites ⭐') : (sc.titleEs && F.esTxt(sc.titleEs, sc.titleEn || sc.titleEs)),
        null, empty);
    }
    var tags = null;
    if (space) {
      tags = T.init(space, {
        selected: selected,
        getStats: tagStats,
        speed: sc.speed,
        emptyHint: feedError ? 'No se pudieron cargar las risas. Revisa tu conexión (o sírvelo con un servidor local).' : 'Aún no hay risas — la primera que grabes aparecerá aquí.',
        reservedSections: shared.reservedSections || [],
        onSelect: applyFilters
      });
    }

    return {
      player: player, tags: tags, selected: selected,
      onClips: function () { if (tags) tags.refresh(); applyFilters(); },
      applyFilters: applyFilters,
      openClip: function (id) {
        if (!id) return;
        player.expandAll();
        var el = document.querySelector('.trackitem[data-id="' + F.esc(id) + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
  }

  /* ── app: carga el feed una vez y lo reparte a todas las secciones ── */
  function init(cfg) {
    var favs = new Set();
    try { JSON.parse(localStorage.getItem(cfg.favKey || 'flove-app-favs') || '[]').forEach(function (s) { favs.add(s); }); } catch (e) {}
    function saveFavs() { try { localStorage.setItem(cfg.favKey || 'flove-app-favs', JSON.stringify([...favs])); } catch (e) {} }

    var risas = [];
    var shared = {
      app: cfg.app, favs: favs, saveFavs: saveFavs, risas: risas,
      feedUrl: cfg.feedUrl, pageSize: cfg.pageSize,
      shareText: cfg.shareText, shareTitle: cfg.shareTitle,
      reservedSections: cfg.reservedSections,
      onReply: cfg.onReply, onRemix: cfg.onRemix, onReaction: cfg.onReaction,
      self: cfg.self
    };
    var sections = [];
    function add(sc) { var s = playlist(sc, shared); sections.push(s); return s; }

    if (cfg.sections && cfg.sections.length) {
      cfg.sections.forEach(add);
    } else {
      // retrocompat: una sola sección con los campos legacy
      add({
        tagSpaceId: cfg.tagSpaceId, playerRootId: cfg.playerRootId,
        playBtn: cfg.playBtn, prevBtn: cfg.prevBtn, nextBtn: cfg.nextBtn,
        mediaAudio: cfg.mediaAudio, mediaVideo: cfg.mediaVideo,
        pageSize: cfg.pageSize, alwaysRepo: cfg.alwaysRepo,
        titleEs: cfg.playlistEs, titleEn: cfg.playlistEn, emptyMsg: cfg.emptyMsg
      });
    }

    if (cfg.onFeed) shared.onFeed = cfg.onFeed;

    F.fetchFeed(cfg.feedUrl, { onError: function () { /* feedError */ } }).then(function (data) {
      var incoming = cfg.clipsOf ? cfg.clipsOf(data) : (Array.isArray(data) ? data : (data && Array.isArray(data.clips) ? data.clips : []));
      risas.length = 0;                                   // muta en sitio: las secciones ven el feed
      Array.prototype.push.apply(risas, incoming);
      sections.forEach(function (s) { s.onClips(); });
      if (cfg.onFeed) cfg.onFeed(risas);
    });

    if (N) N.bottom(cfg.nav);
    return { sections: sections, favs: favs, risas: risas, section: add };
  }

  global.FloveApp = { init: init, playlist: playlist, player: P, tags: T };
  global.RisaApp = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
