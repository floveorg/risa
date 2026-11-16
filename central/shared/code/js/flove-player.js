/* ============================================================
   flove-player.js · players, playlists and threads — abstracted
   from risa/index (createPlayer: transport, tracklist, pagination,
   reply threads, video boxes, quick-menu, favorites/share).
   Exposes window.FlovePlayer.create(root, opts).
   ============================================================ */
(function (global) {
  'use strict';

  var F = global.floveFeed;

  /* create(root, opts)
     root: player container with <audio>, .tracklist, optional .paginator,
           .plname, .track; transport buttons via opts or .play-btn/.prev/.next.
     opts: {
       playBtn, prevBtn, nextBtn, nowPl, nowTrack, pageSize, alwaysPage, alwaysRepo,
       repo, mediaAudio, mediaVideo, mediaHost, metaHTML(t), shareText, shareTitle, clipUrl(t),
       favs (Set) + onFavToggle(src, btn), onReply(t, btn), onRemix(t, btn), onReaction(t, emoji),
       self (sesión Telegram), reactions (siembra), onFeed
     } */
  function create(root, opts) {
    if (!root) return null;
    opts = opts || {};
    var audio = root.querySelector('audio');
    var nowPl = opts.nowPl || root.querySelector('.plname');
    var nowTrack = opts.nowTrack || root.querySelector('.track');
    var trackList = root.querySelector('.tracklist');
    var playBtn = opts.playBtn || root.querySelector('.play-btn');
    var prevBtn = opts.prevBtn || null;
    var nextBtn = opts.nextBtn || null;
    var favs = opts.favs || new Set();

    var tracks = [], emptyMsg = 'Aún no hay pistas todavía 💛';
    var allTracks = [];
    var query = '';                 // búsqueda activa (título · autor · etiquetas)
    var ti = 0, playing = false;
    var page = 0, size = opts.pageSize || 0;
    var bulk = false;
    var alwaysPage = !!opts.alwaysPage;
    var alwaysRepo = !!opts.alwaysRepo;   // muestra el enlace «Ver todas» aunque no haya paginado
    /* media toggle abstraído: filtro audio/vídeo propio del reproductor */
    var media = { audio: true, video: false };
    var mediaHost = opts.mediaHost || null;                       // donde RENDERIZAR los botones
    var pagRoot = root.querySelector('.paginator') || null;
    var pgPrev = pagRoot ? pagRoot.querySelector('.pg-prev') : null;
    var pgChip10 = pagRoot ? pagRoot.querySelector('.pg-10') : null;
    var pgChip100 = pagRoot ? pagRoot.querySelector('.pg-100') : null;
    var pgLabel = pagRoot ? pagRoot.querySelector('.pg-label') : null;
    var pgRepo = pagRoot ? pagRoot.querySelector('.pg-repo') : null;
    var repoURL = opts.repo || '';

    var tree = null;               // buildTree result for the current tracks
    var expanded = new Set();      // ids de clips con sus respuestas desplegadas
    var tagsOpenSet = new Set();   // ids de clips con sus etiquetas abiertas
    var videosOpen = new Set();    // ids de clips con su vídeo ABIERTO (colapsados por defecto)
    var videoState = new Map();    // cid → {time, playing}

    /* byline con el usuario enlazado a su perfil: #/u/<key> si hay key
       (página de autor), o a t.me si el autor hizo opt-in (c.tg). */
    function bylineOf(t) {
      if (opts.metaHTML) return opts.metaHTML(t);
      var c = t.clip || {};
      var name = F.esc(t.by || c.name || 'Anónimo');
      var key = String(t.key || c.key || '').trim();
      var tg = String(c.tg || '').replace(/^@/, '').trim();
      var html = name;
      if (key) html = '<a class="clip-author clip-flove" href="#/u/' + encodeURIComponent(key) + '" data-sound="ui:click">' + name + '</a>';
      else if (tg) html = '<a class="clip-tg-link" href="https://t.me/' + F.esc(tg) + '" target="_blank" rel="noopener" data-sound="ui:click">@' + F.esc(tg) + ' ↗</a>';
      return '<span class="by">' + html + '</span>';
    }

    /* ── Reacciones por clip (estilo Facebook): cid → emoji → {userIds}.
       Se siembran desde opts.reactions / player.react() y crecen con el usuario
       autenticado (opts.self vía Telegram). SOLO se renderizan contadores y
       perfiles cuando hay sesión (self). Cada fila muestra el primer emoji como
       agregador + contador; al pulsar se expande el desglose (emoji · cantidad ·
       perfiles clicables) con los emojis restantes debajo para seleccionar. ── */
    var self = opts.self || null;   // null = sin sesión Telegram → sin contadores ni enlaces
    var reactions = new Map();      // cid -> Map(emoji -> Set(userId))
    var userNames = new Map();      // userId -> nombre visible
    function addReaction(cid, emoji, uid, name) {
      if (!cid || !emoji || !uid) return;
      if (!reactions.has(cid)) reactions.set(cid, new Map());
      var byEmoji = reactions.get(cid);
      if (!byEmoji.has(emoji)) byEmoji.set(emoji, new Set());
      byEmoji.get(emoji).add(uid);
      if (name) userNames.set(uid, name);
    }
    function removeReaction(cid, emoji, uid) {
      var byEmoji = reactions.get(cid);
      if (!byEmoji) return;
      var set = byEmoji.get(emoji);
      if (set) { set.delete(uid); if (!set.size) byEmoji.delete(emoji); }
    }
    function reactionsOf(cid) {
      var byEmoji = reactions.get(cid);
      if (!byEmoji) return [];
      return Array.from(byEmoji.entries()).map(function (entry) {
        return {
          emoji: entry[0],
          users: Array.from(entry[1]).map(function (uid) { return { id: uid, name: userNames.get(uid) || uid }; })
        };
      });
    }
    if (opts.reactions) {
      Object.keys(opts.reactions).forEach(function (cid) {
        Object.keys(opts.reactions[cid] || {}).forEach(function (emoji) {
          (opts.reactions[cid][emoji] || []).forEach(function (u) {
            if (typeof u === 'string') addReaction(cid, emoji, u, u);
            else addReaction(cid, emoji, u.id, u.name || u.id);
          });
        });
      });
    }

    function playable() { return tracks.filter(function (t) { return t.src; }); }

    function mediaFilter(list) {
      return list.filter(function (t) {
        if (media.audio === media.video) return true;          // ambos o ninguno → todo
        return media.audio ? !t.isVideo : !!t.isVideo;         // check acumulativo
      });
    }

    /* Filtro de búsqueda: título · autor · etiquetas (subcadena, sin acentos
       se busca tal cual; vacío = sin filtro). */
    function norm(s) { return String(s || '').toLowerCase(); }
    function queryFilter(list) {
      var q = norm(query).trim();
      if (!q) return list;
      return list.filter(function (t) {
        return norm(t.t).indexOf(q) >= 0 ||
               norm(t.name).indexOf(q) >= 0 ||
               norm(t.tags).indexOf(q) >= 0;
      });
    }

    var MEDIA_ICONS = {
      audio: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
      video: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="m15 10 7-4v12l-7-4"/></svg>'
    };

    /* Renderiza el toggle audio/vídeo en mediaHost (o vincula botones existentes
       vía opts.mediaAudio / opts.mediaVideo — selectores). Abstraído: cada
       reproductor tiene su propio filtro audio/vídeo. */
    function mediaBtn(kind) {
      var btn = null;
      if (opts.mediaAudio && kind === 'audio') btn = document.querySelector(opts.mediaAudio);
      else if (opts.mediaVideo && kind === 'video') btn = document.querySelector(opts.mediaVideo);
      var host = mediaHost || root;
      if (!btn) btn = host.querySelector('[data-media="' + kind + '"]');
      return btn;
    }
    function wireMedia(kind) {
      var btn = mediaBtn(kind);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (kind === 'audio') media.audio = !media.audio;      // checks acumulativos
        else media.video = !media.video;
        applyMedia();
      });
    }
    function applyMedia() {
      var a = mediaBtn('audio'), v = mediaBtn('video');
      if (a) a.setAttribute('aria-pressed', media.audio ? 'true' : 'false');
      if (v) v.setAttribute('aria-pressed', media.video ? 'true' : 'false');
      tracks = queryFilter(mediaFilter(allTracks));
      ti = 0; page = 0;
      render();
    }
    function initMedia() {
      if (mediaHost) {
        mediaHost.innerHTML = '<div class="media-toggle" role="group" aria-label="Tipo de piezas: audio o vídeo">' +
          '<button type="button" class="mt-btn mt-audio" data-media="audio" aria-pressed="true" aria-label="Filtrar audios" title="Filtrar audios">' + MEDIA_ICONS.audio + '</button>' +
          '<button type="button" class="mt-btn mt-video" data-media="video" aria-pressed="false" aria-label="Filtrar vídeos" title="Filtrar vídeos">' + MEDIA_ICONS.video + '</button></div>';
      }
      wireMedia('audio');
      wireMedia('video');
      applyMedia();
    }

    function pageCount() { return !size ? 1 : Math.max(1, Math.ceil(tree.roots.length / size)); }

    function buildLi(t) {
      var li = document.createElement('li');
      var isDL = !!t.src;
      li.dataset.src = t.src || '';
      li.dataset.id = (t.clip && t.clip.id) || '';
      var byline = bylineOf(t);
      var src = t.src || '';
      var cid = t.clip && t.clip.id;
      var depth = t.depth || 0;
      var tagArr = F.tagList(t.tags);
      var tagsOpen = !!cid && tagsOpenSet.has(cid);
      var titleHtml = '<button type="button" class="clip-title" data-title="' + F.esc(cid || '') + '" data-sound="ui:title" aria-expanded="' + (tagsOpen ? 'true' : 'false') + '" aria-label="' + (tagsOpen ? 'Ocultar etiquetas' : 'Mostrar etiquetas') + '">' + F.esc(t.t) + '</button>';
      var chips = tagsOpen ? tagArr.map(function (tag) { return '<span class="clip-tag">' + F.esc(tag) + '</span>'; }).join('') : '';
      var clipUrl = opts.clipUrl ? opts.clipUrl(t) : '#/c/' + encodeURIComponent(cid || '');
      var replyBtn = cid ? '<button type="button" class="reply-btn" data-id="' + F.esc(cid) + '" data-sound="ui:reply" data-title="' + F.esc(t.t || '') + '" data-src="' + F.esc(src) + '" data-clip="' + F.esc(clipUrl) + '" title="Responder" aria-label="Responder a este clip">+</button>' : '';
      var reacts = self ? reactionsOf(cid) : [];   // sin sesión → sin contadores
      var reactChip = '';
      if (self) {
        var totalReact = reacts.reduce(function (n, r) { return n + r.users.length; }, 0);
        var chipEmoji = reacts.length ? reacts[0].emoji : (self.defaultEmoji || '🤣');
        var chipCount = totalReact ? '<span class="react-count">' + totalReact + '</span>' : '';
        reactChip = '<button type="button" class="react-chip" data-react="' + F.esc(cid || '') + '" aria-expanded="false" aria-label="Reacciones" title="Reaccionar" data-sound="ui:reaction">' +
          '<span class="react-emoji">' + F.esc(chipEmoji) + '</span>' + chipCount + '</button>';
      }
      var isVideoClip = !!(t.isVideo && src);
      var videoOpen = isVideoClip && cid && videosOpen.has(cid);   // colapsado por defecto
      var videoBtn = isVideoClip ? '<button type="button" class="clip-video-btn' + (videoOpen ? ' on' : '') + '" data-clipvideo="' + F.esc(cid || '') + '" title="Ver vídeo" aria-label="Ver vídeo">' + (videoOpen ? 'Cerrar' : 'Video') + '</button>' : '';
      var videoBox = isVideoClip
        ? '<div class="clip-video-box" data-videobox="' + F.esc(cid || '') + '"' + (videoOpen ? '' : ' hidden') + '>' +
          '<video src="' + F.esc(src) + '" controls playsinline webkit-playsinline' + (videoOpen ? ' preload="metadata"' : ' preload="none"') + ' data-cid="' + F.esc(cid || '') + '" data-open="' + (videoOpen ? '1' : '0') + '"></video></div>'
        : '';
      var kids = cid ? (tree.children.get(cid) || []) : [];
      var toggleLine = '';
      if (kids.length) {
        var cnt = tree.countNested(kids);
        toggleLine = '<div class="thread-toggle-line' + (depth > 0 ? ' sub-arrow' : '') + '" style="padding-left:' + (12 + depth * 20) + 'px">' +
          '<button type="button" class="thread-arrow-btn" data-toggle="' + F.esc(cid) + '" aria-expanded="' + (expanded.has(cid) ? 'true' : 'false') + '" aria-label="' + (expanded.has(cid) ? 'Colapsar respuestas' : 'Mostrar ' + cnt + ' respuestas') + '">' +
          '<span class="thread-arrow">↳</span>' +
          (expanded.has(cid) ? '' : '<span class="thread-count">' + cnt + '</span>') +
          '</button></div>';
      }
      var clipMeta =
        '<span class="tag ' + (isDL ? 'dl' : 'link') + '"' + (isDL ? ' title="Dale al Play" aria-label="Dale al Play"' : '') + '>' + (isDL ? '▶' : 'enlace') + '</span>' +
        '<span class="ti">' + titleHtml + chips + byline + '</span>' + videoBtn + reactChip + replyBtn;
      var isRemix = !!(t.clip && t.clip.remix);
      var row = '<div class="thread-item' + (isRemix ? ' clip-remix' : '') + '" style="padding-left:' + (depth * 20) + 'px">' + clipMeta + '</div>';
      if (toggleLine) {
        li.className = 'tgl' + (depth > 0 ? ' clip-reply-row' : '');
        li.style.flexDirection = 'column';
        li.innerHTML = '<div class="clip-card">' + row + '</div>' + videoBox + toggleLine;
      } else {
        if (depth > 0) li.className = 'clip-reply-row';
        if (videoBox) { li.style.flexDirection = 'column'; li.innerHTML = row + videoBox; }
        else li.innerHTML = row;
      }
      if (cid && tagArr.length) {
        li.querySelector('.clip-title').addEventListener('click', function (e) {
          e.stopPropagation();
          if (tagsOpenSet.has(cid)) tagsOpenSet.delete(cid); else tagsOpenSet.add(cid);
          render();
        });
      }
      if (toggleLine) {
        li.querySelector('[data-toggle]').addEventListener('click', function (e) {
          e.stopPropagation();
          if (expanded.has(cid)) expanded.delete(cid); else expanded.add(cid);
          render();
        });
      }
      var vbtn = li.querySelector('[data-clipvideo]');
      if (vbtn) {
        vbtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var box = li.querySelector('[data-videobox]');
          if (!box) return;
          var vid = box.querySelector('video');
          if (vid && !vid.dataset.wired) {
            vid.dataset.wired = '1';
            vid.addEventListener('play', function () {
              if (audio) audio.pause();
              var idx = playable().findIndex(function (tr) { return tr.clip && tr.clip.id === cid; });
              if (idx >= 0) { ti = idx; setPlaying(true); highlight(); }
            });
            vid.addEventListener('ended', function () {
              var list = playable();
              if (ti < list.length - 1) { ti++; startTrack(); }
              else { ti = 0; setPlaying(false); }
            });
          }
          if (box.hidden) {
            if (cid) videosOpen.add(cid);
            box.hidden = false;
            if (vid) vid.preload = 'metadata';   // se muestra colapsado: NUNCA autoplay al expandir
            vbtn.classList.add('on'); vbtn.textContent = 'Cerrar';
            setTimeout(function () { li.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60);
          } else {
            if (cid) videosOpen.delete(cid);
            box.hidden = true;
            if (vid) vid.pause();
            vbtn.classList.remove('on'); vbtn.textContent = 'Video';
          }
        });
      }
      if (videoOpen && cid) {
        var vidR = li.querySelector('video');
        if (vidR) {
          var st = videoState.get(cid);
          if (st && st.time > 0) vidR.currentTime = st.time;
          if (st && st.playing) vidR.play().catch(function () {});
        }
      }
      if (isDL) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', function (e) {
          if (e.target.closest('a') || e.target.closest('button')) return;
          if (playing && t.src === audio.src) { audio.pause(); setPlaying(false); return; }
          var list = playable(); ti = list.indexOf(t); startTrack();
        });
      }
      return li;
    }

    function renderNode(t, depth, first) {
      var li = buildLi(t);
      if (first && depth > 0) li.classList.add('reply-first');
      trackList.appendChild(li);
      var id = t.clip && t.clip.id;
      if (id && expanded.has(id)) {
        (tree.children.get(id) || []).forEach(function (k, idx) { renderNode(k, depth + 1, idx === 0); });
      }
    }

    function render() {
      trackList.querySelectorAll('video[data-open="1"]').forEach(function (v) {
        var cid = v.dataset.cid;
        if (cid) videoState.set(cid, { time: v.currentTime || 0, playing: !v.paused });
      });
      trackList.innerHTML = '';
      tree = F.buildTree(tracks);
      if (page > pageCount() - 1) page = pageCount() - 1;
      var pageRoots = size ? tree.roots.slice(page * size, (page + 1) * size) : tree.roots;
      pageRoots.forEach(function (r) { renderNode(r, 0); });
      highlight();
      renderPaginator();
    }

    function renderPaginator() {
      if (!pagRoot) return;
      pagRoot.hidden = !(size > 0 && tracks.length > 0);
      if (pagRoot.hidden) return;
      var pages = pageCount();
      var showNav = pages > 1;
      var atStart = page === 0, atEnd = page >= pages - 1;
      if (pgChip100) pgChip100.setAttribute('aria-pressed', bulk ? 'true' : 'false');
      if (pgPrev) pgPrev.hidden = !(showNav && !atStart);
      if (pgLabel) { pgLabel.hidden = !showNav; if (showNav) pgLabel.textContent = (page + 1) + ' / ' + pages; }
      if (pgChip10) pgChip10.hidden = !(alwaysPage || (showNav && !atEnd));
      if (pgChip100) pgChip100.hidden = !(alwaysPage || (showNav && (atStart || atEnd)));
      if (pgRepo) {
        pgRepo.hidden = !(repoURL && (alwaysRepo || (showNav && atEnd)));
        if (!pgRepo.hidden) pgRepo.href = repoURL;
      }
    }

    function highlight() {
      var active = playable()[ti];
      Array.prototype.slice.call(trackList.children).forEach(function (li) {
        li.classList.toggle('active', playing && active && li.dataset.src === active.src);
      });
    }

    function setPlaying(v) {
      playing = v;
      root.classList.toggle('playing', v);
      if (playBtn) {
        playBtn.textContent = v ? '⏸' : '▶';   // sin el texto «Todas»
        playBtn.classList.toggle('playing', v);
        if (playBtn.parentNode) playBtn.parentNode.classList.toggle('playing', v);   // el transport muestra ‹ › al reproducir
        playBtn.setAttribute('aria-label', v ? 'Pausar' : 'Reproducir');
      }
      if (!v) highlight();
    }

    /* Página (de raíces) donde vive una pista: subir por la cadena de padres
       hasta su raíz y paginar sobre tree.roots. Antes se paginaba con el
       índice PLANO del hilo — clicar una respuesta anidada saltaba de página
       y la lista cambiaba bajo el dedo. */
    function pageOf(t) {
      if (!size || !tree) return page;
      var byId = tree.byId;
      var walk = (t.clip && t.clip.id) ? byId.get(t.clip.id) : null;
      while (walk && walk.clip && walk.clip.parent && byId.has(walk.clip.parent)) {
        walk = byId.get(walk.clip.parent);
      }
      var idx = tree.roots.indexOf(walk);
      return idx >= 0 ? Math.floor(idx / size) : page;
    }

    function startTrack() {
      var list = playable();
      if (!list.length) { if (nowTrack) nowTrack.innerHTML = F.esTxt('Esta playlist solo tiene enlaces ↗', 'This playlist only has links ↗'); return; }
      if (ti >= list.length) ti = 0;
      var np = pageOf(list[ti]);
      if (np !== page) { page = np; render(); }
      var t = list[ti];
      audio.src = t.src;
      audio.play().then(function () {
        errSkips = 0;
        setPlaying(true);
        if (nowTrack) nowTrack.innerHTML = '▶ ' + F.esc(t.t);
        highlight();
      }).catch(function () {
        if (audio.error) return;   // fallo real de medio: el listener «error» ya salta a la siguiente
        if (nowTrack) nowTrack.innerHTML = F.esTxt('No se pudo reproducir ', 'Could not play ') + F.esc(t.t);
      });
    }

    function select(newTracks, newName, tags, empty) {
      tracks = newTracks;
      allTracks = newTracks;                       // el toggle media filtra SIEMPRE sobre lo seleccionado
      emptyMsg = empty || F.esTxt('Aún no hay pistas todavía 💛', 'No tracks yet 💛');
      ti = 0; page = 0; bulk = false; size = opts.pageSize || 0;
      if (playing) { audio.pause(); setPlaying(false); }
      if (nowPl) nowPl.innerHTML = newName;
      render();
      var n = playable().length;
      if (nowTrack) nowTrack.innerHTML = n
        ? n + (n === 1 ? F.esTxt(' pista lista · pulsa play', ' track ready · press play') : F.esTxt(' pistas listas · pulsa play', ' tracks ready · press play'))
        : emptyMsg;
    }

    if (playBtn) playBtn.addEventListener('click', function () {
      if (playing) { audio.pause(); setPlaying(false); }
      else { if (audio.src) { audio.play().then(function () { setPlaying(true); }); } else startTrack(); }
    });
    if (prevBtn) prevBtn.addEventListener('click', function () {
      var list = playable(); if (!list.length) return;
      ti = (ti - 1 + list.length) % list.length; startTrack();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      var list = playable(); if (!list.length) return;
      ti = (ti + 1) % list.length; startTrack();
    });

    /* Al terminar una pista suena la siguiente; al llegar al final de la
       lista se para. El vídeo ya lo hacía (listener «ended» de su caja) —
       el audio principal no, y la cadena se cortaba en cada clip. */
    var errSkips = 0;   // acota el salto: si NINGUNA pista es jugable, no buclea
    if (audio) audio.addEventListener('ended', function () {
      var list = playable();
      if (ti < list.length - 1) { ti++; startTrack(); }
      else { ti = 0; setPlaying(false); }
    });
    /* Fichero muerto (borrado del banco, 404…): salta a la siguiente jugable
       en vez de quedarse muda con «No se pudo reproducir». */
    if (audio) audio.addEventListener('error', function () {
      if (!audio.currentSrc && !audio.src) return;
      var list = playable();
      if (!list.length || ++errSkips > list.length) { errSkips = 0; setPlaying(false); return; }
      ti = (ti + 1) % list.length; startTrack();
    });
    if (pgPrev) pgPrev.addEventListener('click', function () { if (page > 0) { page--; render(); } });
    if (pgChip10) pgChip10.addEventListener('click', function () { if (page < pageCount() - 1) { page++; render(); } });
    if (pgChip100) pgChip100.addEventListener('click', function () {
      if (!bulk) { bulk = true; size = 100; page = 0; }
      else if (page < pageCount() - 1) { page++; }
      render();
    });

    trackList.addEventListener('click', function (e) {
      var star = e.target.closest('.fav-star');
      if (star) {
        e.stopPropagation();
        var src = star.dataset.src;
        var on = !favs.has(src);
        if (on) favs.add(src); else favs.delete(src);
        if (opts.onFavToggle) opts.onFavToggle(src, star, on);
        return;
      }
      var s = e.target.closest('.share-btn');
      if (s) { e.stopPropagation(); shareClip(s.dataset.clip); return; }
      var r = e.target.closest('.reply-btn');
      if (r) {
        e.stopPropagation();
        if (r.classList.contains('on')) closeQuick();   // ya estaba marcado: pulsar de nuevo colapsa el menú
        else showQuickMenu(r);
        return;
      }
      var rc = e.target.closest('.react-chip');
      if (rc) { e.stopPropagation(); toggleReactions(rc); return; }
    });

    function trackOf(id) {
      return tracks.find(function (t) { return t.clip && t.clip.id === id; }) || null;
    }

    function shareClip(url) {
      if (!url) return;
      var text = opts.shareText || 'Escucha esto 😄';
      if (navigator.share) navigator.share({ title: opts.shareTitle || '', text: text, url: url }).catch(function () {});
      else window.open('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text), '_blank', 'noopener');
    }

    /* ── Menú rápido del botón «+» de cada clip: Responder · reacciones ·
       favorita · descargar · compartir. Abstraído (flove-player.js). ── */
    var QUICK_REACTIONS = ['🤣', '😂', '😄', '❤️', '👏', '😹'];
    var quickMenu = null;
    var quickBtn = null;
    function closeQuick() {
      if (quickMenu) { quickMenu.remove(); quickMenu = null; }
      if (quickBtn) { quickBtn.classList.remove('on'); quickBtn = null; }   // el «+» vuelve a fondo en blanco
      document.removeEventListener('click', closeQuick);
    }
    function showQuickMenu(btn) {
      closeQuick();
      quickBtn = btn;
      if (btn) btn.classList.add('on');   // el «+» se marca en amarillo mientras su menú está abierto
      var t = trackOf(btn.dataset.id);
      var menu = document.createElement('div');
      menu.className = 'quick-menu';
      menu.setAttribute('role', 'menu');

      var replyRow = document.createElement('div');
      replyRow.className = 'quick-reply-row';
      var reply = document.createElement('button');
      reply.type = 'button'; reply.className = 'quick-opt'; reply.setAttribute('role', 'menuitem');
      reply.innerHTML = '🎙️ ' + F.esTxt('Responder', 'Reply');
      reply.addEventListener('click', function (e) {
        e.stopPropagation(); closeQuick();
        if (opts.onReply) opts.onReply(t || trackOf(btn.dataset.id), btn);
      });
      replyRow.appendChild(reply);
      var remix = document.createElement('button');
      remix.type = 'button'; remix.className = 'quick-opt remix'; remix.setAttribute('role', 'menuitem');
      remix.innerHTML = '🔀 ' + F.esTxt('Encima', 'Over');
      remix.addEventListener('click', function (e) {
        e.stopPropagation(); closeQuick();
        if (opts.onRemix) opts.onRemix(t || trackOf(btn.dataset.id), btn);
      });
      replyRow.appendChild(remix);
      menu.appendChild(replyRow);

      /* (sin fila de emojis aquí: las reacciones se eligen en el chip del clip,
         con la sesión Telegram; el menú «+» solo lleva Responder y acciones) */

      var row = document.createElement('div'); row.className = 'quick-actions';
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Acciones');
      var src = btn.dataset.src || '';
      var favOn = !!src && favs.has(src);
      var star = document.createElement('button'); star.type = 'button';
      star.className = 'quick-act' + (favOn ? ' on' : '');
      star.title = 'Favorita'; star.setAttribute('aria-label', 'Marcar como favorita'); star.textContent = favOn ? '★' : '☆';
      star.addEventListener('click', function (e) {
        e.stopPropagation(); closeQuick();
        var on = !favs.has(src);
        if (on) favs.add(src); else favs.delete(src);
        if (opts.onFavToggle) opts.onFavToggle(src, star, on);
      });
      row.appendChild(star);
      if (src) {
        var dl = document.createElement('a'); dl.className = 'quick-act'; dl.href = src;
        dl.download = src.split('/').pop(); dl.title = 'Descargar'; dl.setAttribute('aria-label', 'Descargar'); dl.textContent = '↓';
        dl.addEventListener('click', function (e) { e.stopPropagation(); });
        row.appendChild(dl);
      }
      var share = document.createElement('button'); share.type = 'button'; share.className = 'quick-act';
      share.title = 'Compartir'; share.setAttribute('aria-label', 'Compartir'); share.textContent = '↗';
      share.addEventListener('click', function (e) { e.stopPropagation(); closeQuick(); shareClip(btn.dataset.clip); });
      row.appendChild(share);
      menu.appendChild(row);

      var r = btn.getBoundingClientRect();
      menu.style.left = Math.min(r.right - 40, Math.max(8, (window.innerWidth || 900) - 220)) + 'px';
      menu.style.top = (r.bottom + 6) + 'px';
      document.body.appendChild(menu);
      quickMenu = menu;
      // El cierre se añade en el siguiente tick para no cerrar con el mismo clic que abrió.
      setTimeout(function () { document.addEventListener('click', closeQuick); }, 0);
    }

    /* ── Desglose de reacciones (estilo Facebook): al pulsar el chip del clip
       muestra cada emoji con su cantidad y los perfiles que reaccionaron; pulsar
       una fila conmuta la reacción del usuario actual (multi-selección). ── */
    var reactPop = null;
    function closeReactPop() {
      if (reactPop) { reactPop.remove(); reactPop = null; }
      document.removeEventListener('click', closeReactPop);
    }
    /* popover de reacciones: por emoji se muestran solo las 3 últimas personas
       (primeras 5 letras, como enlaces a su perfil, separadas por «…»); si hay
       más de 3, un «+N» expande la lista completa de quien reaccionó a ese
       emoji y empuja los demás emojis hacia abajo. */
    var reactPopCid = null, reactPopExpanded = null, reactPopRect = null;
    function name5(n) {
      n = String(n || '');
      return n.length > 5 ? n.slice(0, 5) + '…' : n;
    }
    function profileHref(u) { return '#/u/' + encodeURIComponent(u.id); }
    function renderReactPop() {
      closeReactPop();
      if (!self) return;
      var cid = reactPopCid;
      var reacts = reactionsOf(cid);          // puede estar vacío: se muestran los emojis para elegir
      var t = trackOf(cid);
      var menu = document.createElement('div');
      menu.className = 'react-pop';
      menu.setAttribute('role', 'group');
      menu.setAttribute('aria-label', 'Reacciones');
      function addRow(r, hasSelf, expanded) {
        var row = document.createElement('div');
        row.className = 'react-pop-row'; row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.setAttribute('aria-pressed', hasSelf ? 'true' : 'false');
        var usersHtml = '';
        if (r.users) {
          var shown = expanded ? r.users : r.users.slice(-3);
          usersHtml = '<span class="react-pop-users">' + shown.map(function (u) {
            return '<a class="react-user" href="' + profileHref(u) + '" data-sound="ui:click">' + F.esc(expanded ? u.name : name5(u.name)) + '</a>';
          }).join(expanded ? ', ' : '…') + '</span>';
          if (!expanded && r.users.length > 3) {
            usersHtml += '<button type="button" class="react-more" title="Ver todas las reacciones">+' + r.users.length + '</button>';
          }
        }
        row.innerHTML = '<span class="react-pop-emoji">' + F.esc(r.emoji) + '</span>' +
          (r.users ? '<span class="react-pop-count">' + r.users.length + '</span>' : '') +
          usersHtml;
        row.addEventListener('click', function (e) {
          e.stopPropagation();
          if (e.target.closest && e.target.closest('.react-more')) {
            reactPopExpanded = r.emoji;      // expande la lista completa de este emoji (los demás bajan)
            renderReactPop();
            return;
          }
          if (e.target.closest && e.target.closest('.react-user')) { closeReactPop(); return; }   // navega al perfil
          if (r.users) {
            if (hasSelf) removeReaction(cid, r.emoji, self.id);
            else { addReaction(cid, r.emoji, self.id, self.name); if (opts.onReaction) opts.onReaction(t, r.emoji); }
          } else {
            addReaction(cid, r.emoji, self.id, self.name);
            if (opts.onReaction) opts.onReaction(t, r.emoji);
          }
          renderReactPop();
          render();
        });
        menu.appendChild(row);
      }
      var selected = new Set();
      reacts.forEach(function (r) {
        selected.add(r.emoji);
        addRow(r, r.users.some(function (u) { return u.id === self.id; }), reactPopExpanded === r.emoji);
      });
      var remaining = QUICK_REACTIONS.filter(function (e) { return !selected.has(e); });
      if (remaining.length) {
        var sep = document.createElement('div');
        sep.className = 'react-pop-sep';
        sep.textContent = '—';
        menu.appendChild(sep);
        remaining.forEach(function (e) { addRow({ emoji: e, users: null }, false, false); });
      }
      var cr = reactPopRect || { right: 120, bottom: 220 };
      menu.style.left = Math.min(cr.right - 70, Math.max(8, (window.innerWidth || 900) - 270)) + 'px';
      menu.style.top = (cr.bottom + 6) + 'px';
      document.body.appendChild(menu);
      reactPop = menu;
      setTimeout(function () { document.addEventListener('click', closeReactPop); }, 0);
    }
    function toggleReactions(chip) {
      if (!self) return;                      // sin sesión Telegram no se renderizan reacciones
      reactPopCid = chip.dataset.react;
      reactPopExpanded = null;
      reactPopRect = chip.getBoundingClientRect();
      renderReactPop();
    }

    initMedia();

    return {
      select: select, render: render,
      playable: playable,
      search: function (q) { query = String(q || ''); applyMedia(); },  // '' limpia el filtro
      getMedia: function () { return { audio: media.audio, video: media.video }; },
      current: function () { return playable()[ti] || null; },
      react: addReaction,   // la app siembra reacciones externas (API/feed): player.react(cid, emoji, userId, name)
      getReactions: function () { return reactions; },   // pestaña «Reacciones» de la app
      expandAll: function () {
        var ids = [];
        (tree ? tree.byId : new Map()).forEach(function (v, id) { ids.push(id); });
        ids.forEach(function (id) { expanded.add(id); });
        render();
      }
    };
  }

  global.FlovePlayer = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
