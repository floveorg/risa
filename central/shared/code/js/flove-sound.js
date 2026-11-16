/* ============================================================
   flove-sound.js · shared sound engine for flove pages
   ============================================================
   Derived from blogy/flove.js sound engine.
   Usage:  <script src="shared/js/flove-sound.js"></script>
           (load after flove-settings.js if present)

   Sounds are triggered by:
     1. data-sound="key" attribute on clicked element (or ancestor)
     2. class→key map (CLASS_MAP) for declarative wiring

   Integration with flove-settings.js:
     - Reads floveSettings.get('sound') to gate playback
     - Listens to 'flove:setting' event for 'sound' key changes
     - Respects 'soundLevel' setting: mini|basic|normal|advanced|super

   Public API: window.floveSound
     .play(key, force)         play a sound by key
     .set(key, src)            register a sound (string URL or {freq,dur,type,gain})
     .get(key)                 read registered sound
     .preview(key)             play once ignoring toggle (force=true)
     .applyPack(map)           bulk register from object
     .applyPackToArea(area, id) apply preset to all keys with prefix
     .getLevel() / setLevel(l) sound depth level
     .speak(text)              speech synthesis (normal+ levels)
   ============================================================ */
(function () {
  'use strict';

  /* ── CLASS_MAP: CSS selector → stable sound key ── */
  var CLASS_MAP = {
    '.nav-btn':                  'ui:nav',
    '.btn':                      'ui:click',
    '.btn.signal':               'ui:confirm',
    '.btn.danger':               'ui:danger',
    '.toggle-track':             'ui:toggle',
    '.card':                     'ui:card',
    '.tab-dot, .feed-tab':       'ui:tab',
    '.mgmt-btn':                 'ui:action',
    '.authy-item':               'ui:expand',
    '.profile-edit-btn':         'ui:edit',
    '.see-more-btn':             'ui:expand',
    '.score-sug':                'ui:suggest',
    '.rcircle-increase-btn':     'ui:increase',
    '.action-btn.invite':        'ui:invite',
    '.action-btn.request':       'ui:request',
    '.promoted-chip':            'ui:app',
    '.export-btn':               'ui:export',
    '.copy-key-btn':             'ui:copy',
    '.heritage-chip':            'ui:heritage',
    '.create-circle-head':       'ui:create',
    '.follow-expand-btn':        'ui:expand',
    '.id5-bar':                  'ui:scale',
    '.id-action':                'ui:action',
    '.cat-item, .cat-pick-item': 'ui:category',
    '#pubBtn':                   'ui:publish',
    '.wizy-btn':                 'ui:wizy',
  };

  /* ── PACK_SOFT: gentle sine tones for central ── */
  var PACK_SOFT = {
    'ui:nav':       { freq: 587,  dur: 50,  type: 'sine',     gain: 0.04 },
    'ui:click':     { freq: 880,  dur: 50,  type: 'sine',     gain: 0.04 },
    'ui:confirm':   { freq: 698,  dur: 160, type: 'triangle', gain: 0.06 },
    'ui:danger':    { freq: 330,  dur: 120, type: 'sine',     gain: 0.05 },
    'ui:toggle':    { freq: 740,  dur: 40,  type: 'sine',     gain: 0.03 },
    'ui:card':      { freq: 660,  dur: 40,  type: 'sine',     gain: 0.02 },
    'ui:tab':       { freq: 988,  dur: 60,  type: 'triangle', gain: 0.04 },
    'ui:action':    { freq: 830,  dur: 80,  type: 'sine',     gain: 0.05 },
    'ui:expand':    { freq: 1319, dur: 80,  type: 'sine',     gain: 0.04 },
    'ui:edit':      { freq: 554,  dur: 60,  type: 'sine',     gain: 0.04 },
    'ui:suggest':   { freq: 1108, dur: 100, type: 'triangle', gain: 0.05 },
    'ui:increase':  { freq: 1245, dur: 90,  type: 'sine',     gain: 0.05 },
    'ui:invite':    { freq: 932,  dur: 140, type: 'triangle', gain: 0.06 },
    'ui:request':   { freq: 784,  dur: 120, type: 'triangle', gain: 0.05 },
    'ui:app':       { freq: 1175, dur: 80,  type: 'triangle', gain: 0.05 },
    'ui:export':    { freq: 523,  dur: 200, type: 'triangle', gain: 0.06 },
    'ui:copy':      { freq: 1047, dur: 60,  type: 'sine',     gain: 0.04 },
    'ui:heritage':  { freq: 880,  dur: 120, type: 'triangle', gain: 0.05 },
    'ui:create':    { freq: 698,  dur: 90,  type: 'sine',     gain: 0.05 },
    'ui:scale':     { freq: 1109, dur: 70,  type: 'sine',     gain: 0.04 },
    'ui:category':  { freq: 740,  dur: 60,  type: 'sine',     gain: 0.04 },
    'ui:publish':   { freq: 698,  dur: 240, type: 'triangle', gain: 0.07 },
    'ui:wizy':      { freq: 1397, dur: 140, type: 'triangle', gain: 0.06 },
    'ui:export':    { freq: 587,  dur: 200, type: 'triangle', gain: 0.06 },
    /* demo de la nube de tags + playlist: chips, títulos y el botón + */
    'ui:tag':       { freq: 740,  dur: 50,  type: 'sine',     gain: 0.035 },
    'ui:title':     { freq: 880,  dur: 60,  type: 'triangle', gain: 0.04 },
    'ui:reply':     { freq: 1175, dur: 70,  type: 'sine',     gain: 0.04 },
  };

  /* ── Sound registry ── */
  var sounds = {};
  Object.assign(sounds, PACK_SOFT);

  /* ── Audio context (lazy) ── */
  var ctx = null;
  var audioCache = {};

  function getCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) { /* not supported */ }
    }
    return ctx;
  }

  /* ── Sound depth levels ── */
  var LEVELS = ['off', 'mini', 'basic', 'normal', 'advanced', 'super'];
  var soundLevel = 'basic';

  /* ── Core play ── */
  function play(key, force) {
    if (!force) {
      var fs = window.floveSettings;
      if (fs && !fs.get('sound')) return;
      if (!fs) { try { if (localStorage.getItem('flove:sound') === 'false') return; } catch (_) {} }
      if (soundLevel === 'off') return;
    }
    var s = sounds[key];
    if (!s) return;

    if (typeof s === 'string') {
      var a = audioCache[key];
      if (!a || a._src !== s) {
        a = new Audio(s);
        a._src = s;
        audioCache[key] = a;
      }
      try { a.currentTime = 0; a.play().catch(function(){}); } catch (_) {}
    }
    else if (typeof s === 'object' && (s.freq || s.f)) {
      var c = getCtx();
      if (!c) return;
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = s.type || 'sine';
      o.frequency.value = s.freq || s.f;
      g.gain.value = s.gain != null ? s.gain : 0.06;
      o.connect(g); g.connect(c.destination);
      var dur = (s.dur || 120) / 1000;
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.stop(c.currentTime + dur);
    }
  }

  /* ── Lookup: data-sound attr → class map ── */
  function lookupKey(target) {
    var explicit = target.closest('[data-sound]');
    if (explicit) return explicit.getAttribute('data-sound');
    for (var sel in CLASS_MAP) {
      if (target.closest(sel)) return CLASS_MAP[sel];
    }
    return null;
  }

  /* ── Delegated click listener (capture phase) ── */
  document.addEventListener('click', function (ev) {
    var key = lookupKey(ev.target);
    if (!key) return;
    var force = !!ev.target.closest('[data-sound-force]');
    play(key, force);
  }, true);

  /* ── Speech synthesis (normal+ levels) ── */
  function speak(text) {
    if (soundLevel === 'off' || soundLevel === 'mini' || soundLevel === 'basic') return;
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 1.0;
    u.volume = 0.7;
    window.speechSynthesis.speak(u);
  }

  /* ── synthForArea: deterministic tone for unknown keys ── */
  function synthForArea(prefix, packId, key) {
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000;
    var base = 440 + h * 1.3;
    var presets = {
      soft:   { type: 'sine',     gain: 0.05 },
      chimes: { type: 'triangle', gain: 0.05 },
      retro:  { type: 'square',   gain: 0.04 },
      synth:  { type: 'sawtooth', gain: 0.04 },
      mystic: { type: 'sine',     gain: 0.06 },
    };
    var p = presets[packId] || presets.soft;
    return { freq: Math.round(base), dur: 80 + (h % 200), type: p.type, gain: p.gain };
  }

  /* ── Apply pack to area ── */
  function applyPackToArea(area, packId) {
    var packs = api.packs || {};
    var pack = packs[packId] || {};
    for (var key in sounds) {
      var prefix = key.split(':')[0];
      if (prefix !== area) continue;
      if (packId === 'off' || packId === '') {
        delete sounds[key];
        audioCache[key] = null;
        continue;
      }
      sounds[key] = pack[key] || synthForArea(prefix, packId, key);
      audioCache[key] = null;
    }
  }

  /* ── Integration with flove-settings.js ── */
  if (window.floveSettings) {
    var saved = window.floveSettings.get('sound');
    var savedLevel = window.floveSettings.get('soundLevel');
    if (saved === false) soundLevel = 'off';
    else if (savedLevel && LEVELS.indexOf(savedLevel) !== -1) soundLevel = savedLevel;
    window.floveSettings.on('sound', function (e) {
      if (!e.value) soundLevel = 'off';
      else if (soundLevel === 'off') soundLevel = 'basic';
    });
  }

  /* ── Botón de sonido abstraído (junto al theme switcher) ──
     initSoundBtn(btn, opts): toggle 🔊/🔇 · estado en flove-settings
     (si está) o localStorage 'flove:sound' · preview al pulsar. */
  function isSoundOn() {
    if (window.floveSettings) return !!window.floveSettings.get('sound');
    try { return localStorage.getItem('flove:sound') !== 'false'; } catch (_) { return true; }
  }
  function setSoundOn(v) {
    if (window.floveSettings) window.floveSettings.set('sound', v);
    else { try { localStorage.setItem('flove:sound', v ? 'true' : 'false'); } catch (_) {} }
  }
  function initSoundBtn(btn, opts) {
    if (!btn) return null;
    opts = opts || {};
    function paint() {
      var on = isSoundOn();
      btn.textContent = on ? '🔊' : '🔇';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Silenciar sonido' : 'Activar sonido');
      btn.title = on ? 'Silenciar sonido' : 'Activar sonido';
    }
    btn.addEventListener('click', function () {
      setSoundOn(!isSoundOn());
      paint();
      play(opts.preview || 'ui:click', true);   // preview siempre, para oír el estado
    });
    paint();
    return { isOn: isSoundOn, set: setSoundOn };
  }

  /* ── Public API ── */
  var api = {
    play: play,
    set: function (key, src) { sounds[key] = src; audioCache[key] = null; },
    get: function (key) { return sounds[key]; },
    preview: function (key) { play(key, true); },
    isSoundOn: isSoundOn,
    setSoundOn: setSoundOn,
    initSoundBtn: initSoundBtn,
    applyPack: function (pack) { for (var k in pack) api.set(k, pack[k]); },
    applyPackToArea: applyPackToArea,
    setArea: function (area, src) {
      for (var key in sounds) {
        if (key.split(':')[0] !== area) continue;
        sounds[key] = src;
        audioCache[key] = null;
      }
    },
    getLevel: function () { return soundLevel; },
    setLevel: function (l) {
      if (LEVELS.indexOf(l) !== -1) {
        soundLevel = l;
        if (window.floveSettings) window.floveSettings.set('soundLevel', l);
      }
    },
    speak: speak,
    keys: function () { var k = []; for (var key in sounds) k.push(key); return k; },
    classMap: CLASS_MAP,
    packs: {
      off: {},
      soft: PACK_SOFT,
    },
    LEVELS: LEVELS,
  };

  window.floveSound = api;
})();
