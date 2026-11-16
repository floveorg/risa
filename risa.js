/* Risa liberada — helpers puros (compartidos por la página y los tests).
   Se carga como <script src="risa.js"> (expone window.Risa) y como módulo Node. */
(function (global) {
  'use strict';

  var LICENSE = 'CC BY-SA 4.0';
  var LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/deed.es';

  // ¿El clip es un vídeo? (el feed puede agregar risas de otros bots con vídeo).
  function isVideoClip(c) {
    if (!c) return false;
    if (c.video === true || c.kind === 'video' || c.type === 'video') return true;
    return /\.(mp4|webm|mov|m4v|ogv)$/i.test(String(c.src || ''));
  }

  // Clip publicado {id,t?,name,tags?,src,when?} -> pista del reproductor.
  function buildRisaTracks(risas) {
    if (!Array.isArray(risas)) return [];
    return risas
      .filter(function (c) { return c && c.src; })
      .map(function (c) {
        return {
          t: c.t || ('Risa de ' + (c.name || 'alguien')),
          src: c.src,
          tags: c.tags || 'risa libre',
          by: (c.name || 'Anónima') + ' · ' + LICENSE,
          tg: c.tg || '',                  // enlace t.me solo si el autor hizo opt-in (C19)
          key: c.key || '',                // página de autor: clave estable (tag-url automática), nunca en claro
          orig: LICENSE_URL,
          origLabel: 'licencia',
          isVideo: isVideoClip(c),
          clip: c
        };
      });
  }

  // Clips publicados -> ítems del feed "Últimas risas".
  function latestFeed(risas, n) {
    if (!Array.isArray(risas)) return [];
    return risas.slice(0, n || 6).map(function (c) {
      return {
        name: (c && c.name) || 'Anónima',
        tags: (c && c.tags) || 'risa libre',
        when: (c && c.when) || 'ahora'
      };
    });
  }

  // Thread tree: reorder clips so replies appear directly below their parent
  // in depth-first order. Each track gains a `depth` property for indentation.
  function threadOrder(clips) {
    if (!Array.isArray(clips) || !clips.length) return [];
    var byId = new Map();
    clips.forEach(function (c) { if (c && c.id) byId.set(c.id, c); });
    var byParent = new Map();
    var roots = [];
    clips.forEach(function (c) {
      if (!c) return;
      var p = c.parent;
      if (p && byId.has(p)) {
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(c);
      } else {
        roots.push(c);
      }
    });
    var out = [];
    function walk(clip, depth) {
      out.push({ clip: clip, depth: depth });
      var children = byParent.get(clip.id) || [];
      children.forEach(function (child) { walk(child, depth + 1); });
    }
    roots.forEach(function (r) { walk(r, 0); });
    // Append any clips whose parent wasn't found (broken refs) at the end
    var seen = new Set(out.map(function (o) { return o.clip.id; }));
    clips.forEach(function (c) {
      if (c && !seen.has(c.id)) out.push({ clip: c, depth: 0 });
    });
    return out;
  }

  // El feed puede ser un array de clips (v1, retrocompatible) o un objeto con
  // cabecera `{ flag:{...}, clips:[...] }`. Los addons se activan sin romper lo
  // ya publicado: el flag hace de toggle y de fallback desde la interfaz.
  function clipsOf(risa) {
    if (Array.isArray(risa)) return risa;
    return (risa && Array.isArray(risa.clips)) ? risa.clips : [];
  }
  function flagsOf(risa) {
    return (risa && !Array.isArray(risa) && risa.flag && typeof risa.flag === 'object')
      ? risa.flag : {};
  }

  var api = {
    buildRisaTracks: buildRisaTracks,
    latestFeed: latestFeed,
    clipsOf: clipsOf,
    flagsOf: flagsOf,
    threadOrder: threadOrder,
    // Configurable URLs — update these for v2 or new apps
    RISA_URL:  'https://risa.liberada.net/risa.json',
    API_URL:   'https://api.liberada.net/api',   // comunidad D1 (fail-silent si no está)
    TELEGRAM_BOT: 'https://t.me/RisaLiberadaBot',
    LICENSE: LICENSE,
    LICENSE_URL: LICENSE_URL
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Risa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
