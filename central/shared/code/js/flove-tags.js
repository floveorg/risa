/* ============================================================
   flove-tags.js · the native tags floating space — abstracted
   from risa/index (.tag-space.flowing: chips drift, size by
   count, +/− expands the cloud, hash deep-link selects tags).
   Exposes window.FloveTags.
   ============================================================ */
(function (global) {
  'use strict';

  var DEFAULT_OPTS = { start: 5, batch: 5, plusClicks: 5, speed: 0.1 };

  function floatChips(container, chips, rafRef, speed) {
    if (rafRef.id) cancelAnimationFrame(rafRef.id);
    var sp = speed || DEFAULT_OPTS.speed;      // 0.1 = 10× más lento que risa/index
    var W = function () { return container.clientWidth || 1; };
    var H = function () { return container.clientHeight || 1; };
    var state = chips.map(function (c) {
      var r = (c.getBoundingClientRect && c.getBoundingClientRect()) || { width: 90, height: 34 };
      return {
        x: 0.06 + Math.random() * 0.7, y: 0.06 + Math.random() * 0.7,
        vx: (Math.random() - 0.5) * 0.03 * sp, vy: (Math.random() - 0.5) * 0.03 * sp,
        w: r.width || 90, h: r.height || 34
      };
    });
    chips.forEach(function (c, i) {
      c.style.position = 'absolute'; c.style.left = '0'; c.style.top = '0';
      c.style.transform = 'translate(' + (state[i].x * W()) + 'px,' + (state[i].y * H()) + 'px)';
      c.style.zIndex = '1';
    });
    var last = performance.now();
    function clamp(s) {
      var mw = (s.w / W()) || 0.05, mh = (s.h / H()) || 0.05;
      if (s.x < 0.03) s.x = 0.03;
      if (s.y < 0.03) s.y = 0.03;
      if (s.x > 1 - mw) s.x = 1 - mw;
      if (s.y > 1 - mh) s.y = 1 - mh;
    }
    function tick(now) {
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      chips.forEach(function (c, i) {
        var s = state[i];
        s.x += s.vx * dt * 60; s.y += s.vy * dt * 60;
        if (s.x < 0.03 || s.x > 1 - (s.w / W())) s.vx *= -1;
        if (s.y < 0.03 || s.y > 1 - (s.h / H())) s.vy *= -1;
      });
      // colisión: las chips se empujan un poco al tocarse (no se solapan)
      for (var i = 0; i < chips.length; i++) {
        for (var j = i + 1; j < chips.length; j++) {
          var a = state[i], b = state[j];
          var ax = a.x * W(), ay = a.y * H(), bx = b.x * W(), by = b.y * H();
          var dx = (bx + b.w / 2) - (ax + a.w / 2), dy = (by + b.h / 2) - (ay + a.h / 2);
          var dist = Math.hypot(dx, dy) || 1;
          var min = (a.w + b.w) / 2 * 0.72;
          if (dist < min) {
            var push = (min - dist) / 2, ux = dx / dist, uy = dy / dist;
            a.x -= (ux * push) / W(); a.y -= (uy * push) / H();
            b.x += (ux * push) / W(); b.y += (uy * push) / H();
          }
        }
      }
      chips.forEach(function (c, i) {
        clamp(state[i]);
        c.style.transform = 'translate(' + (state[i].x * W()) + 'px,' + (state[i].y * H()) + 'px)';
      });
      rafRef.id = requestAnimationFrame(tick);
    }
    rafRef.id = requestAnimationFrame(tick);
  }

  function stop(rafRef) { if (rafRef.id) cancelAnimationFrame(rafRef.id); rafRef.id = null; }

  function chipSize(count, max) { return (0.43 + 0.27 * (count / max)).toFixed(2); }

  /* init(spaceEl, opts)
     opts: {
       getStats(): [[tag,count],…]   — ordered desc by count
       onSelect(selectedSet): void    — called when the tag selection changes
       selected: Set (optional, external)
       pinned: [{el, before}]? not needed — app appends pinned chips itself
       reservedSections: Set          — hash values NOT treated as tags
       start/batch/plusClicks
       emptyHint: {text, feedError}
     }
     Returns: { selected, setTag(tag,on), clear(), getPinned() } */
  function init(spaceEl, opts) {
    if (!spaceEl) return null;
    opts = Object.assign({}, DEFAULT_OPTS, opts);
    opts.reservedSections = new Set(opts.reservedSections || []);
    var selected = opts.selected || new Set();
    var rafRef = { id: null };
    var chipStart = 0, chipCount = opts.start, plusClicks = 0;

    var recienteBtn = document.createElement('button');
    recienteBtn.className = 'chip reciente'; recienteBtn.type = 'button';
    recienteBtn.textContent = 'Recientes';
    recienteBtn.title = 'Ver lo más reciente: deselecciona todas las etiquetas';
    recienteBtn.setAttribute('aria-pressed', 'true');
    recienteBtn.addEventListener('click', function () {
      selected.clear(); recienteBtn.setAttribute('aria-pressed', selected.size ? 'false' : 'true');
      opts.onSelect(selected);
    });

    var plusChip = document.createElement('button');
    plusChip.className = 'chip plus-chip'; plusChip.type = 'button'; plusChip.textContent = '+';
    plusChip.title = 'Más etiquetas: añade más en cada toque';
    plusChip.addEventListener('click', function () { advanceFlow(); });

    var minusChip = document.createElement('button');
    minusChip.className = 'chip minus-chip'; minusChip.type = 'button'; minusChip.textContent = '−';
    minusChip.title = 'Plegar la nube a las etiquetas iniciales';
    minusChip.addEventListener('click', function () {
      chipStart = 0; chipCount = opts.start; plusClicks = 0;
      plusChip.classList.remove('done');
      minusChip.hidden = true;
      setHeight(0);                       // encoge el espacio de vuelta al estado inicial
      build();
    });

    // El «+» multiclick: hasta 5 toques, cada uno añade un lote de etiquetas y
    // estira el espacio flotante un 10% más hacia abajo. El «−» lo encoge.
    var baseH = spaceEl.clientHeight || 460;
    function setHeight(k) { spaceEl.style.height = Math.round(baseH * (1 + 0.10 * k)) + 'px'; }

    // deep-link: #tag1+tag2 selecciona al cargar (secciones reservadas no cuentan)
    var hash = (global.location && global.location.hash || '').slice(1);
    if (!(opts.reservedSections || new Set()).has(hash)) {
      hash.split('+').forEach(function (raw) {
        var t = raw; try { t = decodeURIComponent(raw); } catch (e) {}
        if (t) selected.add(t);
      });
    }

    function build() {
      var stats = opts.getStats() || [];
      if (!stats.length) {
        stop(rafRef);
        spaceEl.querySelectorAll('.chips-hint').forEach(function (el) { el.remove(); });
        var hint = document.createElement('p');
        hint.className = 'chips-hint'; hint.setAttribute('role', 'status');
        hint.textContent = opts.emptyHint || 'Aún no hay etiquetas.';
        spaceEl.appendChild(hint);
        floatChips(spaceEl, [recienteBtn], rafRef, opts.speed);
        return;
      }
      var slice = stats.slice(chipStart, chipStart + chipCount);
      if (!slice.length) { chipStart = 0; return build(); }
      Array.prototype.slice.call(spaceEl.children).forEach(function (c) {
        if (c !== recienteBtn && c !== plusChip && c !== minusChip && !c.classList.contains('pinned-chip')) c.remove();
      });
      slice.forEach(function (pair) {
        var tag = pair[0], cnt = pair[1];
        var b = document.createElement('button');
        b.className = 'chip'; b.type = 'button'; b.dataset.tag = tag;
        b.setAttribute('aria-pressed', selected.has(tag) ? 'true' : 'false');
        b.setAttribute('data-sound', 'ui:tag');   // demo de sonido: clic en un chip de la nube
        b.style.fontSize = chipSize(cnt, stats[0][1]) + 'rem';
        b.textContent = tag;
        b.addEventListener('click', function () { setTag(tag, !selected.has(tag)); });
        spaceEl.appendChild(b);
      });
      spaceEl.appendChild(plusChip);
      if (chipCount > opts.start) { spaceEl.appendChild(minusChip); minusChip.hidden = false; }
      // todo flota: tags + recientes + «+» (y «−» solo cuando está desplegado); los pinned quedan fijos
      var floatables = Array.prototype.slice.call(spaceEl.children).filter(function (c) {
        return !c.hidden && !c.classList.contains('pinned-chip');
      });
      floatChips(spaceEl, floatables, rafRef, opts.speed);
    }

    function advanceFlow() {
      var stats = opts.getStats() || [];
      if (plusClicks >= opts.plusClicks || chipCount >= stats.length) return;   // máx. 5 toques / todas visibles
      plusClicks++; chipCount += opts.batch;
      setHeight(plusClicks);                          // el espacio crece un 10% más abajo por cada toque
      if (plusClicks >= opts.plusClicks || chipCount >= stats.length) plusChip.classList.add('done');
      minusChip.hidden = false;                       // aparece el − flotante para volver al estado inicial
      build();
    }

    function setTag(tag, on) {
      if (on) selected.add(tag); else selected.delete(tag);
      spaceEl.querySelectorAll('.chip[data-tag]').forEach(function (c) {
        c.setAttribute('aria-pressed', selected.has(c.dataset.tag) ? 'true' : 'false');
      });
      recienteBtn.setAttribute('aria-pressed', selected.size ? 'false' : 'true');
      opts.onSelect(selected);
    }

    function clear() { selected.clear(); build(); opts.onSelect(selected); }

    // refresh: reconstruye la nube con las stats actuales SIN tocar la selección
    function refresh() { build(); }

    spaceEl.classList.add('flowing');
    spaceEl.appendChild(recienteBtn);
    build();
    return { selected: selected, setTag: setTag, clear: clear, refresh: refresh, stop: function () { stop(rafRef); } };
  }

  global.FloveTags = { init: init, floatChips: floatChips };
})(typeof window !== 'undefined' ? window : globalThis);
