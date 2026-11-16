/* ============================================================
   flove-bottom-nav.js · the central bottom navigation menu
   (flove.css §5 bottom-nav), two levels: Category → App.
   Renders into a #bottom-nav container. Exposes window.FloveNav.
   ============================================================ */
(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  /* bottom(cfg)
     cfg: {
       home:   { name, url, mark }        — logo/home button
       apps:   { name, url }              — "all apps" button
       active: {name} (optional)
       categories: [ { name, icon, apps: [ {name, url, mark} ] } ]
     } */
  function bottom(cfg) {
    var mount = document.getElementById('bottom-nav');
    if (!mount || !cfg) return null;
    mount.classList.add('has-nav');
    var state = { open: null };

    function catBtn(cat) {
      var on = state.open === cat.name;
      return '<button type="button" class="nav-btn' + (on ? ' on' : '') + '" data-nav="cat" data-name="' + esc(cat.name) + '" aria-expanded="' + on + '">' +
        '<div class="nav-icon">' + (cat.icon || '') + '</div>' +
        '<span class="nav-label">' + esc(cat.name) + '</span></button>';
    }

    function renderBar() {
      var html =
        (cfg.home
          ? '<a class="nav-btn" href="' + esc(cfg.home.url) + '" title="' + esc(cfg.home.name) + '">' +
            '<div class="nav-icon">' + (cfg.home.mark || '') + '</div><span class="nav-label">' + esc(cfg.home.name) + '</span></a>'
          : '') +
        (cfg.categories || []).map(catBtn).join('') +
        (cfg.apps
          ? '<a class="nav-btn" href="' + esc(cfg.apps.url) + '" title="' + esc(cfg.apps.name) + '">' +
            '<div class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>' +
            '<span class="nav-label">' + esc(cfg.apps.name) + '</span></a>'
          : '');
      mount.innerHTML = '<nav class="bottom-nav" aria-label="Navegación principal">' + html + '</nav>' +
        '<div class="bottom-nav-level2" id="bottomNavLevel2" hidden></div>';
    }

    function renderLevel2(cat) {
      var box = document.getElementById('bottomNavLevel2');
      if (!box) return;
      if (!cat) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="bn2-title">' + esc(cat.name) + '</div>' +
        (cat.apps || []).map(function (a) {
          return '<a class="bn2-app" href="' + esc(a.url) + '"><span class="bn2-mark">' + (a.mark || '') + '</span><span>' + esc(a.name) + '</span></a>';
        }).join('');
    }

    renderBar();
    mount.querySelectorAll('[data-nav="cat"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.dataset.name;
        var cat = (cfg.categories || []).find(function (c) { return c.name === name; });
        state.open = state.open === name ? null : name;
        mount.querySelectorAll('[data-nav="cat"]').forEach(function (x) { x.classList.toggle('on', x === b && state.open); x.setAttribute('aria-expanded', String(x === b && !!state.open)); });
        renderLevel2(state.open ? cat : null);
      });
    });
    document.addEventListener('click', function (e) {
      if (!mount.contains(e.target)) { state.open = null; renderLevel2(null); mount.querySelectorAll('[data-nav="cat"]').forEach(function (x) { x.classList.remove('on'); x.setAttribute('aria-expanded', 'false'); }); }
    });

    return {
      open: function (name) {
        var b = Array.prototype.find.call(mount.querySelectorAll('[data-nav="cat"]'), function (x) { return x.dataset.name === name; });
        if (b) b.click();
      },
      close: function () { state.open = null; renderLevel2(null); }
    };
  }

  global.FloveNav = { bottom: bottom };
})(typeof window !== 'undefined' ? window : globalThis);
