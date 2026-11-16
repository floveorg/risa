/* ============================================================
   flove-feed.js · shared feed/data layer — abstracted from
   risa/index (buildRisaTracks · threadOrder · tagList · esc).
   Used by any flove app with a JSON feed of clips (risa, ama…).
   Exposes window.floveFeed.
   ============================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function esTxt(es, en) {
    return '<span class="es">' + esc(es) + '</span><span class="en">' + esc(en) + '</span>';
  }

  function tagList(tags) {
    return String(tags || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }

  function isVideoSrc(src) {
    return /\.(mp4|webm|mov|m4v|ogv)$/i.test(String(src || ''));
  }

  function isVideoClip(c) {
    if (!c) return false;
    if (c.video === true || c.kind === 'video' || c.type === 'video') return true;
    return isVideoSrc(c.src);
  }

  /* Telegram id legible del clip: nick, username o nombre que empieza por @ */
  function tgOf(c) {
    if (!c) return '';
    var s = String(c.tg || c.username || c.name || '').replace(/^@/, '').trim();
    if (s) return s;
    var k = String(c.key || '').trim();
    if (k) return k;
    return '';
  }

  /* Convierte un feed de clips a tracks del reproductor (forma canónica). */
  function buildTracks(clips, opts) {
    opts = opts || {};
    if (!Array.isArray(clips)) return [];
    var base = opts.src || (function (c) { return c.src; });
    return clips
      .filter(function (c) { return c && c.src; })
      .map(function (c) {
        var by = opts.byOf ? opts.byOf(c) : (c.name || 'Anónimo');
        var orig = opts.origOf ? opts.origOf(c) : (c.orig || c.link || '');
        return {
          t: opts.titleOf ? opts.titleOf(c) : (c.t || c.title || ''),
          src: typeof base === 'function' ? base(c) : c.src,
          tags: c.tags || opts.defaultTags || '',
          by: by,
          tg: tgOf(c),
          key: c.key || '',
          orig: orig,
          origLabel: opts.origLabel || 'original',
          isVideo: isVideoClip(c),
          clip: c
        };
      });
  }

  /* Orden en profundidad (hilos/cadenas): una respuesta suena ANTES que el
     siguiente hermano. Devuelve [{clip, depth}]. */
  function threadOrder(clips) {
    var byId = new Map();
    (clips || []).forEach(function (c) { if (c && c.id) byId.set(c.id, c); });
    var children = new Map();
    (clips || []).forEach(function (c) {
      var p = c && c.parent;
      if (p && byId.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(c);
      }
    });
    var out = [];
    function walk(c, depth) {
      out.push({ clip: c, depth: depth });
      (children.get(c.id) || []).forEach(function (k) { walk(k, depth + 1); });
    }
    (clips || []).forEach(function (c) {
      if (!(c && c.parent && byId.has(c.parent))) walk(c, 0);
    });
    return out;
  }

  /* Árbol de hilos para render: byId, children, roots, countNested. */
  function buildTree(tracks) {
    var byId = new Map();
    var children = new Map();
    tracks.forEach(function (t) { if (t.clip && t.clip.id) byId.set(t.clip.id, t); });
    tracks.forEach(function (t) {
      var p = t.clip && t.clip.parent;
      if (p && byId.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(t);
      }
    });
    function countNested(kids) {
      var n = kids.length;
      kids.forEach(function (k) {
        var c = children.get(k.clip.id);
        if (c) n += countNested(c);
      });
      return n;
    }
    return {
      byId: byId,
      children: children,
      roots: tracks.filter(function (t) { return !(t.clip && t.clip.parent && byId.has(t.clip.parent)); }),
      countNested: countNested
    };
  }

  /* Carga un feed JSON con fail-silent → null. */
  function fetchFeed(url, opts) {
    opts = opts || {};
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .catch(function () {
        if (opts.onError) opts.onError();
        return null;
      });
  }

  var api = {
    esc: esc, esTxt: esTxt,
    tagList: tagList, isVideoSrc: isVideoSrc, isVideoClip: isVideoClip, tgOf: tgOf,
    buildTracks: buildTracks, threadOrder: threadOrder, buildTree: buildTree,
    fetchFeed: fetchFeed
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.floveFeed = api;
})(typeof window !== 'undefined' ? window : globalThis);
