/* risa-app.js — the Risa page driver: FloveApp sections, playlists,
   reactions, author page, tabs and page-level UI. Loaded after risa.js and
   the shared flove libs. Extracted from index.html. */
/* ============================================================
   risa-fork · risa/index con las etiquetas flotantes y la playlist
   (y los hilos) abstraídas en central/shared/code. RISAS DE LA
   GENTE y RISAS DEL MUNDO llaman al MISMO código (FloveApp.section),
   solo cambia el contenido: su tags-space, su reproductor, su
   media-toggle (audio/vídeo) y su filtro/título.
   ============================================================ */
(function () {
  'use strict';
  var F = window.floveFeed;
  var S = window.floveSound;

  /* ── botón de sonido abstraído (junto al theme switcher) ── */
  if (S) S.initSoundBtn(document.getElementById('sound-btn'), { preview: 'ui:confirm' });

  /* ── RISAS DEL MUNDO · playlist curada (scrapped de Wikimedia Commons,
     tal cual en liberada v1): audios/vídeos reales, NO clips del bot.
     La sección usa esta fuente propia vía sc.clips. ── */
  var CW = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
  var CP = 'https://commons.wikimedia.org/wiki/File:';
  var WORLD_CATS = [
    ['w', 'Risa contagiosa', [
      ['Risa de multitud', '72842_lonemonk_approx-800-laugh-1.wav', 'lonemonk · CC BY 3.0'],
      ['Solo risas', '72843_lonemonk_approx-800-laughter-only-1.wav', 'lonemonk · CC BY 3.0'],
      ['Risas y aplausos', '72844_lonemonk_approx-800-laughter-and-clapter-1.wav', 'lonemonk · CC BY 3.0'],
      ['Grupo pequeño', 'Small_group_laughter.ogg', 'CC BY 3.0'],
      ['Gente riendo', 'Menschen-Lachen.ogg', 'CC BY-SA 4.0']
    ]],
    ['c', 'Carcajada suelta', [
      ['Carcajada', 'Laugh.wav', 'CC BY-SA 4.0'],
      ['Carcajadón', 'Laughter.ogg', 'Dominio público'],
      ['Risa corta', 'En-us-laugh.ogg', 'Dominio público'],
      ['Risotada (EE. UU.)', 'En-us-guffaw.ogg', 'CC BY-SA 3.0'],
      ['Risotada (Australia)', 'En-au-guffaw.ogg', 'CC BY-SA 4.0']
    ]],
    ['p', 'Pícara y malvada', [
      ['Risa malvada', 'Evil_laugh_2.oga', 'CC BY-SA 3.0'],
      ['Risa malvada (CC0)', 'Evil_laugh.ogg', 'CC0'],
      ['Carcajada diabólica', 'Evil_laughter.ogg', 'Dominio público'],
      ['Risa de loco', 'Insane_laughter_man_reverb.ogg', 'CC BY 3.0'],
      ['Risa de bestia', 'Beast_laughter.ogg', 'Dominio público']
    ]],
    ['r', 'Risita nerviosa', [
      ['Risa «lol»', 'Man_saying_lol.oga', 'CC BY-SA 4.0'],
      ['Risita (giggle juice)', 'En-au-giggle_juice.ogg', 'CC BY-SA 4.0'],
      ['Risita (giggle berries)', 'En-au-giggle_berries.ogg', 'CC BY-SA 4.0'],
      ['Risa disimulada', 'En-us-laughter.ogg', 'CC BY-SA 3.0'],
      ['Risita entre dientes', 'Laughter-Ochi.oga', 'CC BY-SA 4.0'],
      ['Risa contenida (cackle)', 'En-au-cackle-bladder.ogg', 'CC BY-SA 4.0']
    ]],
    ['m', 'Risas del mundo', [
      ['Risa (Alemania)', 'Menschen-Lachen.ogg', 'CC BY-SA 4.0'],
      ['Rire (París, Francia)', 'Fr-Rire-fr-Paris.ogg', 'CC BY-SA 2.0 fr'],
      ['Rire (Quebec)', 'Qc-rire.ogg', 'CC BY-SA 3.0'],
      ['Risa de bebé (Francia, 9 meses)', 'Rire_de_b%C3%A9b%C3%A9_de_9_mois.ogg', 'CC BY-SA 4.0'],
      ['Risa de bebé', 'Baby_Laugh.ogg', 'CC BY 3.0']
    ]]
  ];
  var WORLD_CLIPS = [];
  WORLD_CATS.forEach(function (cat) {
    cat[2].forEach(function (tr, i) {
      WORLD_CLIPS.push({
        id: 'w' + cat[0] + '_' + i,
        t: tr[0],
        src: CW + tr[1],
        by: tr[2],
        orig: CP + tr[1],
        tags: cat[1]
      });
    });
  });

  function currentSelf() {
    try {
      var s = JSON.parse(localStorage.getItem('flove:self') || 'null');
      if (s && s.id) return s;
    } catch (e) {}
    return null;
  }
  /* ── GENTE + MUNDO: dos secciones, el mismo driver ── */
  var app = window.FloveApp.init({
    app: 'Risa liberada',
    feedUrl: window.Risa.RISA_URL,
    clipsOf: window.Risa.clipsOf,
    favKey: 'risa-liberada-favs',
    botUrl: window.Risa.TELEGRAM_BOT,
    reservedSections: ['espiritualidad', 'cultura', 'ciencia']
      .concat((function () { var h = (location.hash || '').slice(1); return h && h.charAt(0) === '/' ? [h] : []; })()),
    self: currentSelf(),
    onReply: function (t) { openReplyModal(t); },
    onRemix: function (t) { startEncima(t); },
    onFeed: function () { if (/^#\/u\//.test(location.hash || '')) renderAuthor(); },
    onReaction: function (t, emoji) {
      var id = t && t.clip && t.clip.id;
      try {
        fetch((window.Risa && window.Risa.API_URL || 'https://api.liberada.net/api') + '/reactions', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: 'risa', item_id: id, reaction: emoji })
        }).catch(function () {});
      } catch (_) {}
      var pop = document.createElement('div');
      pop.className = 'quick-toast';
      pop.textContent = emoji + ' · ¡gracias!';
      pop.setAttribute('role', 'status');
      document.body.appendChild(pop);
      setTimeout(function () { pop.remove(); }, 1200);
    },
    sections: [
      {
        tagSpaceId: 'tag-space',
        playerRootId: 'gente-player',
        playBtn: '#gente-play', prevBtn: '#gente-prev', nextBtn: '#gente-next',
        mediaAudio: '#mt-audio', mediaVideo: '#mt-video',
        pageSize: 10, alwaysRepo: true,
        titleEs: 'Risas de la gente 😹', titleEn: 'People\u2019s laughs 😹',
        shareText: 'Escucha esta risa 😂', shareTitle: 'Risa liberada'
      },
      {
        /* Cultura ya no lleva nube de etiquetas: el id no existe en el DOM,
           así que FloveApp deja tags = null (y no toca la nube de la gente). */
        tagSpaceId: 'world-tag-space',
        playerRootId: 'world-player',
        playBtn: '#world-play', prevBtn: '#world-prev', nextBtn: '#world-next',
        mediaHost: document.getElementById('world-media-toggle'),
        clips: WORLD_CLIPS,
        repo: 'https://commons.wikimedia.org/wiki/Category:Laughter',
        pageSize: 5,
        titleEs: 'Risas del mundo 😹', titleEn: 'World laughs 😹'
      }
    ],
    nav: {
      home: { name: 'Risa', url: '#top', mark: '😹' },
      apps: { name: 'apps', url: 'https://flove.org/apps' },
      categories: [
        { name: 'lib', icon: '🌱', apps: [
          { name: 'Risa', url: '#top', mark: '😹' },
          { name: 'Ama', url: 'https://ama.liberada.net', mark: '💗' },
          { name: 'Liberada', url: 'https://liberada.net', mark: '🌱' }
        ]},
        { name: 'flove', icon: '🧩', apps: [
          { name: 'flove.org', url: 'https://flove.org', mark: '🌱' },
          { name: 'Apps', url: 'https://flove.org/apps', mark: '🧩' }
        ]}
      ]
    }
  });

  /* ── PESTAÑAS DEL MUNDO (interior · cultura · ciencia) ── */
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-bar .tab-btn'));
  function showTab(name) {
    tabBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === name)); });
    Array.prototype.slice.call(document.querySelectorAll('.tab-panel')).forEach(function (p) { p.hidden = p.id !== name; });
  }
function goTab(name) {
    showTab(name);
    var panel = document.getElementById(name);
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  tabBtns.forEach(function (b) { b.addEventListener('click', function () { goTab(b.dataset.tab); }); });
  Array.prototype.slice.call(document.querySelectorAll('[data-tab-link]')).forEach(function (b) { b.addEventListener('click', function () { goTab(b.dataset.tabLink); }); });
  showTab('cultura');

  /* ── QUIERO (servicios): despliega el contacto debajo del botón ── */
  var servQuiero = document.getElementById('serv-quiero'), servMail = document.getElementById('serv-mail');
  if (servQuiero && servMail) {
    servQuiero.setAttribute('aria-expanded', 'false');
    servQuiero.addEventListener('click', function () {
      var open = servMail.hidden;
      if (open && !servMail.innerHTML) {
        servMail.innerHTML = '<span class="es" lang="es">Cuéntanos tu idea ↗ </span>' +
          '<span class="en" lang="en">Tell us your idea ↗ </span>' +
          '<a href="mailto:risa@liberada.net">risa@liberada.net</a>';
      }
      servMail.hidden = !open;
      servQuiero.setAttribute('aria-expanded', String(open));
    });
  }

  /* ── DROPDOWN TOPBAR (logo) ── */
  var ddBtn = document.getElementById('brand-logo'), dd = document.getElementById('brand-dd');
  if (ddBtn && dd) {
    function setDD(open) {
      dd.classList.toggle('open', open);
      dd.hidden = !open;
      ddBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    ddBtn.addEventListener('click', function (e) { e.preventDefault(); setDD(!dd.classList.contains('open')); });
    document.addEventListener('click', function (e) { if (!dd.contains(e.target) && !ddBtn.contains(e.target)) setDD(false); });
    function ddAct(id, fn) { var b = document.getElementById(id); if (b) b.addEventListener('click', function () { setDD(false); fn(); }); }
    ddAct('dd-entrar', function () { var p = document.getElementById('entrar-page'); if (p) p.hidden = !p.hidden; });
    ddAct('dd-sobre-liberada', function () { window.open('https://liberada.net', '_blank', 'noopener'); });
    ddAct('dd-contactar', function () { window.open('https://t.me/RisaLiberadaBot', '_blank', 'noopener'); });
    ddAct('dd-sobre', function () { showTab('cultura'); var p = document.getElementById('promotores'); if (p) p.scrollIntoView({ behavior: 'smooth' }); });
    ddAct('dd-add-laugh', function () { openModal(document.getElementById('upload-modal')); });
  }

  /* ── MODALES · subir risa + responder en cadena ── */
  var uploadModal = document.getElementById('upload-modal'), umClose = document.getElementById('um-close');
  function openModal(m) { if (m) m.hidden = false; }
  function closeModal(m) { if (m) m.hidden = true; }
  if (umClose) umClose.addEventListener('click', function () { closeModal(uploadModal); });
  if (uploadModal) uploadModal.addEventListener('click', function (e) { if (e.target === uploadModal) closeModal(uploadModal); });

  /* ── FOOTER · créditos y licencias desplegables ── */
  var creditsToggle = document.querySelector('.credits-toggle'), creditsBody = document.getElementById('credits-body');
  if (creditsToggle && creditsBody) {
    creditsToggle.addEventListener('click', function () {
      var open = creditsBody.hidden;
      creditsBody.hidden = !open;
      creditsToggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* ── LIGHTBOX · clic en una foto → vista ampliada ── */
  var lightbox = document.getElementById('photo-lightbox'), lbImg = document.getElementById('lightbox-img'),
      lbCap = document.getElementById('lightbox-cap'), lbClose = document.getElementById('lightbox-close');
  function openLightbox(img) {
    if (!lightbox || !img) return;
    lbImg.src = img.currentSrc || img.src;
    lbImg.alt = img.alt || '';
    var fig = img.closest('figure');
    var figcap = fig && fig.querySelector('figcaption');
    lbCap.textContent = figcap ? figcap.textContent : '';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    lbImg.src = '';
    document.body.style.overflow = '';
  }
  Array.prototype.slice.call(document.querySelectorAll('figure img')).forEach(function (img) {
    img.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img);
    });
  });
  if (lbClose) lbClose.addEventListener('click', closeLightbox);
  if (lightbox) lightbox.addEventListener('click', function (e) { if (e.target === lightbox || e.target === lightbox.querySelector('figure')) closeLightbox(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLightbox(); });

  /* ── BUSCADOR · la lupa abre/cierra el panel de etiquetas ── */
  var searchToggle = document.getElementById('toggle-search');
  var tagPanel = document.getElementById('tag-panel');
  var genteGrid = document.getElementById('gente-grid');
  var ddSearchInput = document.getElementById('dd-search-input');
  var ddSearchBtn = document.getElementById('dd-search-btn');

  function refreshTagCloud() {
    if (typeof app !== 'undefined' && app.sections && app.sections[0] && app.sections[0].tags && app.sections[0].tags.refresh) {
      app.sections[0].tags.refresh();
    }
  }
  function setTagPanel(open) {
    if (!tagPanel || !searchToggle) return;
    tagPanel.hidden = !open;
    if (genteGrid) genteGrid.classList.toggle('tags-hidden', !open);
    searchToggle.classList.toggle('open', open);
    searchToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.dispatchEvent(new CustomEvent('tagpanelchange', { detail: { open: open } }));
    if (open) {
      refreshTagCloud();
      if (ddSearchInput) ddSearchInput.focus();
    }
  }
  if (searchToggle && tagPanel) {
    searchToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setTagPanel(tagPanel.hidden);
    });
  }
  if (ddSearchBtn) {
    ddSearchBtn.addEventListener('click', function () {
      var q = ddSearchInput ? ddSearchInput.value.trim() : '';
      if (q && typeof app !== 'undefined' && app.sections && app.sections[0] && app.sections[0].player && app.sections[0].player.search) {
        app.sections[0].player.search(q);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
  /* Sync dropdown audio/video toggles with the main ones */
  var ddMtAudio = document.getElementById('dd-mt-audio');
  var ddMtVideo = document.getElementById('dd-mt-video');
  var mainMtAudio = document.getElementById('mt-audio');
  var mainMtVideo = document.getElementById('mt-video');
  function syncDropdownToMain() {
    if (ddMtAudio && mainMtAudio) ddMtAudio.setAttribute('aria-pressed', mainMtAudio.getAttribute('aria-pressed'));
    if (ddMtVideo && mainMtVideo) ddMtVideo.setAttribute('aria-pressed', mainMtVideo.getAttribute('aria-pressed'));
  }
  if (ddMtAudio && mainMtAudio) {
    ddMtAudio.addEventListener('click', function () { mainMtAudio.click(); syncDropdownToMain(); });
  }
  if (ddMtVideo && mainMtVideo) {
    ddMtVideo.addEventListener('click', function () { mainMtVideo.click(); syncDropdownToMain(); });
  }
  if (typeof app !== 'undefined') {
    var origOnFeed = app.onFeed;
    app.onFeed = function () { if (origOnFeed) origOnFeed(); syncDropdownToMain(); };
  }
  /* ── Sugerencias de búsqueda: carrusel de 5, cada 10 s ──
     Un texto corto («por qué buscar») se teclea en la línea. Solo se sugieren
     etiquetas que EXISTEN en el feed (buscar una que no está no daría nada).
     Se pausa en cuanto la persona teclea algo. */
  (function () {
    var dd = document.getElementById('tag-panel');
    var input = document.getElementById('dd-search-input');
    var whyEl = document.getElementById('search-suggest-why');
    if (!dd || !input || !whyEl) return;
    var SUG = [
      { why: 'Yoga + risa = mejor día', tag: 'yoga' },
      { why: 'Un giro malvado para tu playlist', tag: 'maldad' },
      { why: 'Relájate con clase', tag: 'clase' },
      { why: 'Risas del campo', tag: 'rural' },
      { why: 'Una alegría contagiosa', tag: 'alegría' }
    ];
    var idx = 0, timer = null, seq = 0;
    function show() {
      var s = SUG[idx % SUG.length];
      var my = ++seq;                           // cancela tecleos anteriores
      var i = 0;
      (function typeWhy() {
        if (my !== seq) return;                 // una sugerencia nueva lo cancela
        whyEl.textContent = s.why.slice(0, i);
        i++;
        if (i <= s.why.length) setTimeout(typeWhy, 135);
      })();
      var j = 0;
      (function typeTag() {
        if (my !== seq) return;
        input.value = s.tag.slice(0, j);
        j++;
        if (j <= s.tag.length) setTimeout(typeTag, 180);
      })();
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() {
      stop();
      show();
      timer = setInterval(function () { idx++; show(); }, 10000);
    }
    document.addEventListener('tagpanelchange', function (e) {
      if (e.detail && e.detail.open) start(); else stop();
    });
    input.addEventListener('input', stop);      // la persona teclea → se calla
  })();

  var replyModal = document.getElementById('reply-modal'), rmClose = document.getElementById('rm-close');
  function openReplyModal(t) {
    var title = document.getElementById('rm-clip-title'), titleEn = document.getElementById('rm-clip-title-en');
    if (title) title.textContent = (t && t.t) || 'esta risa';
    if (titleEn) titleEn.textContent = (t && t.t) || 'this laugh';
    openModal(replyModal);
  }
  if (rmClose) rmClose.addEventListener('click', function () { closeModal(replyModal); });
  if (replyModal) replyModal.addEventListener('click', function (e) { if (e.target === replyModal) closeModal(replyModal); });

  /* ── ENCIMA · sin modal: un clic arranca el clip EN BUCLE y abre el bot.
     La barra acoplada manda: sobrevive al salto al bot y a recargar la página
     (vuelve pausada, lista para reanudar). El bot enlaza la nota de voz al
     clip vía deep link remix_<id> y la publica como remix. */
   var rxGuide = document.getElementById('rx-guide');
   /* El guía suena al 60% y el bot mezcla el padre al 60%: en Encima la voz
      queda por encima y el original de fondo sin saturar. Un solo ajuste: lo
      que oyes es lo que se publica. */
   if (rxGuide) rxGuide.volume = 0.60;
   var rxDock = document.getElementById('rx-dock'), rxDockTitle = document.getElementById('rx-dock-title');
  var rxDockToggle = document.getElementById('rx-dock-toggle'), rxDockStop = document.getElementById('rx-dock-stop');
  var rxDockBot = document.getElementById('rx-dock-bot');
  var RX_STORE = 'risa-encima';
  var rxClipId = '', rxClipSrc = '', rxClipTitle = '';
  function rxHref() { return 'https://t.me/RisaLiberadaBot?start=remix_' + encodeURIComponent(rxClipId); }
  function openBot() {
    if (!rxClipId) return;
    var desktop = false;
    try { desktop = matchMedia('(pointer: fine)').matches && matchMedia('(min-width: 900px)').matches; } catch (_) {}
    if (desktop) {
      // ventana con nombre «risa-bot»: si sigue abierta se REUTILIZA y trae al frente
      var w = window.open(rxHref(), 'risa-bot', 'width=420,height=700');
      try { if (w) w.focus(); } catch (_) {}
      if (!w) window.open(rxHref(), '_blank', 'noopener');   // bloqueador de pop-ups → pestaña
    } else {
      window.open(rxHref(), '_blank', 'noopener');
    }
  }
  /* Botón de la barra: ⏸ mientras suena (un clic pausa), ▶️ en pausa. */
  function rxIcon(playing) {
    if (!rxDockToggle) return;
    rxDockToggle.textContent = playing ? '⏸' : '▶️';
    rxDockToggle.setAttribute('aria-pressed', String(!playing));
    rxDockToggle.title = playing ? 'Pausar' : 'Reanudar';
  }
  function rxShow(title) {
    if (rxDockTitle) rxDockTitle.textContent = '«' + title + '»';
    if (rxDock) rxDock.hidden = false;
  }
  /* Un clic en «Encima»: suena el clip (en bucle) y el bot se abre a la vez. */
  function startEncima(t) {
    rxClipId = (t && t.clip && t.clip.id) || '';
    rxClipSrc = (t && t.src) || '';
    rxClipTitle = (t && t.t) || 'esta risa';
    if (!rxClipId || !rxClipSrc) return;
    try { localStorage.setItem(RX_STORE, JSON.stringify({ id: rxClipId, src: rxClipSrc, t: rxClipTitle })); } catch (_) {}
    if (rxGuide) {
      rxGuide.pause();
      rxGuide.loop = true;
      rxGuide.muted = false;
      rxGuide.volume = 0.60;
      rxGuide.src = rxClipSrc;
      rxGuide.load();
      var playing = rxGuide.play();
      if (playing && playing.catch) playing.catch(function () {});
    }
    rxShow(rxClipTitle);
    openBot();
  }
  if (rxGuide) {
    rxGuide.addEventListener('play', function () { rxIcon(true); });
    rxGuide.addEventListener('pause', function () { if (rxDock && !rxDock.hidden) rxIcon(false); });
  }
  if (rxDockToggle) rxDockToggle.addEventListener('click', function () {
    if (!rxGuide) return;
    if (rxGuide.paused) rxGuide.play().catch(function () {}); else rxGuide.pause();
  });
  if (rxDockBot) rxDockBot.addEventListener('click', function () { openBot(); });
  if (rxDockStop) rxDockStop.addEventListener('click', function () {
    if (rxGuide) { rxGuide.pause(); rxGuide.currentTime = 0; }   // para y rebobina
    if (rxDock) rxDock.hidden = true;
    try { localStorage.removeItem(RX_STORE); } catch (_) {}
  });
  /* Tras recargar, la barra vuelve PAUSADA con el último clip de Encima:
     reanuda con ▶️ o reabre el bot con 🤖. */
  (function () {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(RX_STORE) || 'null'); } catch (_) {}
    if (s && s.id && s.src && rxGuide) {
      rxClipId = s.id; rxClipSrc = s.src; rxClipTitle = s.t || 'esta risa';
      rxGuide.src = rxClipSrc;
      rxShow(rxClipTitle);
      rxIcon(false);
    }
  })();

  /* ── PÁGINA DE AUTOR · #/u/<key> (usa la sección gente) ── */
  function renderAuthor() {
    var m = /^#\/u\/(.+)$/.exec(location.hash || '');
    var key = m ? decodeURIComponent(m[1]) : '';
    var sec = document.getElementById('userpage');
    if (!sec) return;
    sec.hidden = !key;
    if (!key) {
      if (app && app.sections && app.sections[0]) app.sections[0].applyFilters();  // restaura la lista principal
      return;
    }
    var mine = ((app && app.risas) || []).filter(function (c) { return c && c.key === key; });
    var name = mine.length ? mine[0].name : key;
    var av = document.getElementById('up-avatar'), nm = document.getElementById('up-name');
    if (av) av.textContent = String(name).charAt(0).toUpperCase();
    if (nm) nm.textContent = name;
    var list = F.buildTracks(mine);
    var byId = new Map();
    list.forEach(function (t) { if (t.clip && t.clip.id) byId.set(t.clip.id, t); });
    var out = [];
    F.threadOrder(mine).forEach(function (o) {
      var tr = o.clip && byId.get(o.clip.id);
      if (tr) out.push(Object.assign({}, tr, { depth: o.depth }));
    });
    if (app && app.sections && app.sections[0]) app.sections[0].player.select(out, name + ' · todas sus risas', null);
    if (sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', renderAuthor);
  renderAuthor();

  /* ── CLAIM · #/claim/<token> + the #/entrar form ──
     The bot sends a token privately; the feed carries only sha256(token).
     Hashing it here and matching a clip resolves the author key without a
     server or a public codes file. */
  function sha256Hex(text) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('crypto unavailable'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }
  function claimToken(token) {
    var clean = String(token || '').trim();
    if (!clean) return Promise.resolve(false);
    return fetch(window.Risa.RISA_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var clips = window.Risa.clipsOf(data);
        return sha256Hex(clean).then(function (hash) {
          var clip = clips.find(function (c) { return c && c.claim === hash; });
          if (!clip || !clip.key) return false;
          try {
            localStorage.setItem('flove:self', JSON.stringify({
              id: clip.key, name: clip.name || 'Anónima'
            }));
          } catch (_) {}
          location.hash = '#/u/' + encodeURIComponent(clip.key);
          return true;
        });
      })
      .catch(function () { return false; });
  }
  function claimFromHash() {
    var m = /^#\/claim\/(.+)$/.exec(location.hash || '');
    if (!m) return;
    var result = document.getElementById('en-result');
    if (result) result.textContent = 'Comprobando…';
    claimToken(decodeURIComponent(m[1])).then(function (ok) {
      if (!ok) {
        var page = document.getElementById('entrar-page');
        if (page) page.hidden = false;
        if (result) result.textContent = 'Ese enlace no es válido o ya no está en el feed.';
      }
    });
  }
  var enGo = document.getElementById('en-go'), enCode = document.getElementById('en-code'), enResult = document.getElementById('en-result');
  if (enGo && enCode) {
    enGo.addEventListener('click', function () {
      if (enResult) enResult.textContent = 'Comprobando…';
      claimToken(enCode.value).then(function (ok) {
        if (!ok && enResult) enResult.textContent = 'Token no válido. Pide uno nuevo al bot.';
      });
    });
  }
  window.addEventListener('hashchange', claimFromHash);
  claimFromHash();

  /* ── BENEFICIOS · «Porque»: burbujas de beneficios. El del menú las
     lanza hacia la derecha (data-bubbles=right); Ciencia hacia abajo. ── */
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var benefitPool = [
    'Libera <b>endorfinas</b> y baja el estrés al instante.',
    'Relaja los músculos hasta <b>45 minutos</b> después.',
    'Da un empujón a tu <b>sistema inmunitario</b>.',
    'Mejora la <b>oxigenación</b> de la sangre.',
    'Ayuda a <b>bajar la tensión</b> arterial.',
    'Es un <b>ejercicio abdominal</b> suave y gratis.',
    'Sube tu <b>tolerancia al dolor</b>.',
    'Refuerza los <b>vínculos</b> con quien te rodea.',
    'Espanta la <b>ansiedad</b> y mejora el humor.',
    'Te ancla en el <b>aquí y ahora</b>.',
    'Quema unas <b>10 calorías</b> por minuto de carcajada.',
    'Entrena el <b>diafragma</b> y mejora la respiración.',
    'Favorece un <b>sueño profundo</b> al final del día.',
    'Estimula la <b>circulación</b> como un mini cardio.',
    'La alegría se asocia a <b>vivir más</b> años.',
    'Llena el cerebro de <b>dopamina</b>, la molécula del placer.',
    'Contagia: es la emoción <b>más viral</b> que existe.',
    'Mejora la <b>memoria y la concentración</b> justo después.',
    'Cuida el corazón: la carcajada <b>ensancha las arterias</b>.',
    'Te recuerda que <b>jugar</b> también es cosa de mayores.'
  ];
  var pool = benefitPool.slice();
  var benefitsBtns = Array.prototype.slice.call(document.querySelectorAll('.benefits-btn'));
  var beneAudio = new Audio();
  var beneIdx = -1;
  var bubbles = new Set();
  function stopBene() { try { beneAudio.pause(); beneAudio.currentTime = 0; } catch (_) {} }
  function nextGenteClip() {
    var list = (app.risas || []).filter(function (c) { return c && c.src; });
    if (!list.length) return;
    beneIdx = (beneIdx < 0) ? 0 : (beneIdx + 1) % list.length;
    beneAudio.src = list[beneIdx].src;
    beneAudio.play().catch(function () {});
  }
  function spawnBubble(text, k, anchor) {
    var bub = document.createElement('div');
    bub.className = 'bubble';
    bub.innerHTML = text;
    bub.setAttribute('role', 'status');
    var r = anchor.getBoundingClientRect();
    // fluyen hacia abajo, centradas horizontalmente, con espaciados distintos cada una
    var x = Math.max(14, Math.round((window.innerWidth - 230) / 2));
    var gaps = [0, 84, 176, 250];
    var g = gaps[k] != null ? gaps[k] : k * 90;
    var y = r.bottom + 12 + g;
    if (y > window.innerHeight - 140) y = window.innerHeight - 140 - g;
    bub.style.left = x + 'px'; bub.style.top = y + 'px';
    document.body.appendChild(bub);
    bubbles.add(bub);
    function dismiss() {
      if (!bub.isConnected) return;
      bub.remove();
      bubbles.delete(bub);
      if (!bubbles.size) stopBene();
    }
    bub.addEventListener('click', dismiss);
    setTimeout(dismiss, 5200);
  }
  function popBenefit(k, anchor) {
    if (!pool.length) return;
    var idx = Math.floor(Math.random() * pool.length);
    var text = pool.splice(idx, 1)[0];
    spawnBubble('<b>Reír</b> ' + text.charAt(0).toLowerCase() + text.slice(1), k, anchor);
  }
  benefitsBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      nextGenteClip();
      popBenefit(0, btn);
      if (!reduce) setTimeout(function () { popBenefit(1, btn); }, 5000);
      else popBenefit(1, btn);
    });
  });

  /* ── copy-prompt ── */
  var copy = document.getElementById('copy-prompt');
  if (copy) copy.addEventListener('click', function () {
    var t = document.querySelector('#prompt-source textarea, #prompt-source pre, textarea');
    var text = t ? t.value || t.textContent : '';
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
  });
})();
