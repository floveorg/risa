/* ============================================================
   flove-i18n.js · shared language toggle for flove apps
   ============================================================
   Usage:
     1. Add radio buttons: <input type="radio" name="lang" id="lang-en" checked>
                           <input type="radio" name="lang" id="lang-es">
     2. Include this script: <script src="libs/flove-i18n.js"></script>
     3. Mark translatable elements:
        - <span class="en">Hello</span><span class="es">Hola</span>
        - <option data-en="Name" data-es="Nombre">
        - <input data-ph-en="Search" data-ph-es="Buscar">
        - <span data-aria-en="Close" data-aria-es="Cerrar">
        - <span data-tip-en="Help" data-tip-es="Ayuda">
        - <span data-title-en="Info" data-title-es="Info">

   Public API:
     window.flove.i18n.apply()     — apply current language
     window.flove.i18n.current()   — get current language code
     window.flove.i18n.set(lang)   — programmatic language pick
   ============================================================ */
(() => {
  'use strict';

  const LS_KEY = 'flove:lang';
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function radios() {
    return Array.from(document.querySelectorAll('input[name="lang"]'));
  }

  function currentLang() {
    const r = radios().find(x => x.checked);
    return r ? r.id.replace('lang-', '') : 'en';
  }

  function apply() {
    const lang = currentLang();
    document.documentElement.lang = lang;

    // Swap text content via class .en / .es / .<lang>
    document.querySelectorAll('.en, .es, .fr, .de, .pt').forEach(el => {
      const show = el.classList.contains(lang);
      el.style.display = show ? '' : 'none';
    });

    // Swap option text
    document.querySelectorAll('option[data-en]').forEach(o => {
      if (o.dataset[lang] != null) o.textContent = o.dataset[lang];
    });

    // Swap placeholders
    document.querySelectorAll('[data-ph-en]').forEach(el => {
      const v = el.dataset['ph' + cap(lang)];
      if (v != null) el.placeholder = v;
    });

    // Swap aria-labels
    document.querySelectorAll('[data-aria-en]').forEach(el => {
      const v = el.dataset['aria' + cap(lang)];
      if (v != null) el.setAttribute('aria-label', v);
    });

    // Swap tooltips
    document.querySelectorAll('[data-tip-en]').forEach(el => {
      const v = el.dataset['tip' + cap(lang)];
      if (v != null) el.setAttribute('data-tip', v);
    });

    // Swap titles
    document.querySelectorAll('[data-title-en]').forEach(el => {
      const v = el.dataset['title' + cap(lang)];
      if (v != null) el.setAttribute('title', v);
    });

    // Swap image alt text
    document.querySelectorAll('[data-alt-en]').forEach(el => {
      const v = el.dataset['alt' + cap(lang)];
      if (v != null) el.setAttribute('alt', v);
    });

    try {
      localStorage.setItem(LS_KEY, lang);
      localStorage.setItem('translaty-lang', lang); // legacy key, keep older pages in sync
    } catch (_) {}
  }

  function set(lang) {
    const r = document.getElementById('lang-' + lang);
    if (r) { r.checked = true; apply(); }
  }

  function init() {
    // Restore saved language
    let saved = null;
    try { saved = localStorage.getItem(LS_KEY) || localStorage.getItem('translaty-lang') || localStorage.getItem('translate2-lang'); } catch (_) {}
    if (saved) {
      const r = document.getElementById('lang-' + saved);
      if (r) r.checked = true;
    }

    // Wire radio change listeners
    radios().forEach(r => {
      r.addEventListener('change', () => {
        apply();
        // Close worldball if open
        const d = document.querySelector('details.lang');
        if (d) d.open = false;
      });
    });

    apply();
  }

  // Expose API
  window.flove = window.flove || {};
  window.flove.i18n = { apply, current: currentLang, set };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
