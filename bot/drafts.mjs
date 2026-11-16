// bot/drafts.mjs — draft UI helpers, keyboard builders, text generators
import { hashId, identityOf } from './logic.mjs';

// Identidad (v2): «Autor» elige un alias (draft:aliases); «Anónimo» lo anula.
export const DEFAULT_SEL = { alias: '', anon: false };
export const selOf = (d) => d.sel || { ...DEFAULT_SEL };

export function displayName(d) {
  const s = selOf(d);
  if (s.anon) return 'Anónima';
  if (s.alias) return s.alias;
  return d.name || 'Anónima';
}

export function identityLabel(d) {
  const s = selOf(d);
  if (s.anon) return '🙈 ' + displayName(d);
  return '🙂 ' + displayName(d);
}

// Etiquetas como hashtags (buscables en Telegram).
export function tagsHash(tags) {
  return (tags || []).map(t => '#' + t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join(' ');
}

// Añade palabras escritas por el usuario a d.tags.
export function addTags(d, text) {
  const out = d.tags || [];
  const seen = new Set(out.map(t => t.toLowerCase()));
  String(text || '').split(/[;,]/).forEach(chunk =>
    chunk.split(/\s+/).forEach(word => {
      const w = word.replace(/^#/, '').trim().toLowerCase();
      if (!w) return;
      if (!seen.has(w)) { seen.add(w); out.push(w); }
    }));
  d.tags = out;
}

// Detalles que un moderador propone para una risa en cola.
export function parseEditDetails(text) {
  const parts = String(text || '').split('|').map(s => s.trim());
  const out = {};
  if (parts[0]) out.title = parts[0].slice(0, 60);
  const tags = String(parts[1] || '').split(/[;,]/)
    .map(t => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
  if (tags.length) out.tags = tags;
  if (parts[2]) out.name = parts[2].slice(0, 40);
  return out;
}

// Detalles actuales (líneas legibles) para el mensaje de moderación.
export function detailLines(q) {
  const tags = q.tags && q.tags.length ? q.tags.join(', ') : '—';
  return ['✏️ ' + (q.title || '—'), '🏷️ ' + tags, '🙂 ' + (q.name || 'Anónima')];
}

// Detalles con la propuesta aplicada encima (para enseñar al autor).
export function proposalLines(q) {
  const p = q.proposed || {};
  const tags = (p.tags && p.tags.length)
    ? p.tags.join(', ')
    : ((q.tags && q.tags.length) ? q.tags.join(', ') : '—');
  return ['✏️ ' + (p.title || q.title || '—'),
          '🏷️ ' + tags,
          '🙂 ' + (p.name || q.name || 'Anónima')];
}

// Pie original del mensaje de moderación.
export function modCaption(q) {
  const tags = (q.tags && q.tags.length) ? q.tags.join(', ') : '';
  return [q.title || '', tagsHash(q.tags), q.name || 'Anónima'].filter(Boolean).join('\n');
}

// Línea legible de una risa publicada.
export function clipLine(e) {
  return '🎧 ' + (e.t || '—') + ' · 🙂 ' + (e.name || 'Anónima') + ' · 📅 ' + (e.when || '—');
}

// Texto del borrador: Título + Tags + identidad.
export function draftText(d) {
  const parentLine = d.parent ? '↳ Responde a: ' + (d.parentTitle || d.parent) : '';
  return [
    '🎵 Risa recibida 💛',
    '',
    parentLine,
    '✏️ ' + (d.title || '—'),
    '🏷️ ' + ((d.tags && d.tags.length) ? d.tags.join(', ') : '—'),
    identityLabel(d),
    '',
    'Ajusta lo que quieras y pulsa «Enviar».'
  ].filter(Boolean).join('\n');
}

// Teclado del borrador.
export function OPTIONS(d) {
  const s = selOf(d);
  return { inline_keyboard: [
    [{ text: '✏️ Título', callback_data: 'draft:title' },
     { text: '🏷️ Tags', callback_data: 'draft:tags' }],
    [{ text: (s.alias ? '✓ ' : '') + '🙂 Autor ▾', callback_data: 'draft:aliases' },
     { text: (s.anon ? '✓ ' : '') + '🙈 Anónimo', callback_data: 'draft:id:anon' }],
    [{ text: '✅ Enviar', callback_data: 'draft:send' }]
  ]};
}

// Submenú de aliases.
export const ALIAS_KEYS = (aliases) => ({
  inline_keyboard: [
    ...aliases.map((a) => [{ text: (a.private ? '🔒 ' : '') + a.alias, callback_data: 'draft:alias:' + a.alias }]),
    [{ text: '➕ Nuevo alias', callback_data: 'draft:alias-new' },
     { text: '✖️ Cancelar', callback_data: 'draft:cancel' }]
  ]
});

export const CANCEL_KEYS = () => ({ inline_keyboard: [[
  { text: '✖️ Cancelar', callback_data: 'draft:cancel' }
]] });

// Llegó una risa nueva con otra en borrador: ofrecer abrir la ficha actual
// (vuelve a mostrar el formulario aunque el mensaje anterior se haya perdido),
// usar la nueva, o cancelar el borrador.
export const OVERLAP_TEXT = 'Ya tienes una risa en borrador 💛 ¿Qué hacemos?\n\n' +
  '«Abrir mi borrador» te vuelve a mostrar la ficha con sus botones (título, ' +
  'etiquetas y ✅ Enviar). «Usar esta nueva» cambia el borrador a la risa que ' +
  'acabas de mandar.';
export const OVERLAP_KEYS = () => ({ inline_keyboard: [
  [{ text: '✏️ Abrir mi borrador', callback_data: 'draft:resume' },
   { text: '🆕 Usar esta nueva', callback_data: 'draft:replace' }],
  [{ text: '✖️ Cancelar borrador', callback_data: 'draft:cancel' }]
] });

// Hay un borrador abierto (p. ej. tras /welcome): botón para reabrir su ficha.
export const RESUME_KEYS = () => ({ inline_keyboard: [[
  { text: '✏️ Abrir mi borrador', callback_data: 'draft:resume' }
]] });

// Moderación: botones de aprobar/borrar/editar.
export const BUTTONS = (id) => ({ inline_keyboard: [[
  { text: '✅ Publicar', callback_data: 'ok:' + id },
  { text: '🗑 Borrar',   callback_data: 'no:' + id }
], [
  { text: '✏️ Editar', callback_data: 'edit:' + id }
]] });

export const EDIT_PROMPT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '✖️ Cancelar', callback_data: 'edit-cancel:' + id }
]] });

export const EDIT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '📨 Proponer al autor', callback_data: 'edit-send:' + id },
  { text: '✖️ Cancelar', callback_data: 'edit-cancel:' + id }
]] });

export const ACCEPT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '✅ Aceptar', callback_data: 'accept:' + id },
  { text: '❌ Rechazar', callback_data: 'reject-edit:' + id }
]] });

// Editor de etiquetas.
export function tagsText(d) {
  return '🏷️ Etiqueta tu risa — escribe las etiquetas separadas por coma.\n\n' +
    'Actuales: ' + ((d.tags && d.tags.length) ? d.tags.join(', ') : '—');
}
export function tagsKeys() {
  return { inline_keyboard: [[
    { text: '✅ Listo', callback_data: 'draft:tags-done' },
    { text: '✖️ Cancelar', callback_data: 'draft:cancel' }
  ]] };
}

// Textos de constantes del bot.
export const WELCOME_TEXT = 'Comparte tu risa con todos aquí.\n\n' +
  'Audios o vídeos de máx. 1 min, 10 MB, 5 al día. Graba y envía el tuyo: elige visibilidad, descríbelo y pulsa Enviar. Un moderador lo revisa y, si entra, lo publicamos en @risaliberada y en risa.liberada.net 💛';

export const TGPUB_TEXT = '📣 ¿Mostrar tu @ en la web?\n\n' +
  'Risa nunca enlaza tu Telegram automáticamente: solo si tú lo pides, junto a ' +
  'tu nombre público aparecerá un enlace a t.me. Puedes cambiarlo luego con /pub.';
export const TGPUB_KEYS = () => ({ inline_keyboard: [[
  { text: '✅ Sí, mostrar mi @', callback_data: 'tgpub:yes' },
  { text: '✖️ No', callback_data: 'tgpub:no' }
]] });

// Subdominio de autor.
export function subdomainBase(cfg) {
  const host = String(cfg.webUrl || 'https://risa.liberada.net')
    .replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const parts = host.split('.');
  return 'https://' + parts.slice(-2).join('.');
}
export function subdomainUrl(cfg, sub) {
  const base = subdomainBase(cfg).replace(/^https?:\/\//, '');
  return 'https://' + String(sub).toLowerCase() + '.' + base;
}
export function candidateUsernameOf(q, usernames) {
  const raw = (q.username || q.name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  let base = raw || 'user';
  if (base.length < 3) base = base + '_risa';
  const myKey = q.uploader;
  const mine = Object.entries(usernames || {}).find(([, v]) => v.key === myKey);
  if (mine) return mine[0];
  let candidate = base.slice(0, 20);
  let n = 1;
  while (usernames[candidate] && usernames[candidate].key !== myKey) {
    n++;
    candidate = (base.slice(0, 16) + '_' + n).slice(0, 20);
  }
  return candidate;
}
export function claimUsername(q, usernames) {
  const myKey = q.uploader;
  const mine = Object.entries(usernames || {}).find(([, v]) => v.key === myKey);
  if (mine) return mine[0];
  const sub = candidateUsernameOf(q, usernames);
  const isoToday = () => new Date().toISOString().slice(0, 10);
  usernames[sub] = { key: myKey, name: q.name || 'Anónima', claimedAt: isoToday() };
  return sub;
}
export function renameUsername(usernames, who, newName, displayName) {
  const clean = String(newName || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (clean.length < 3 || clean.length > 20) return { error: 'Entre 3 y 20 letras, números o guiones bajos.' };
  if (/^[0-9_]+$/.test(clean)) return { error: 'El nombre necesita al menos una letra.' };
  const mine = Object.entries(usernames || {}).find(([, v]) => v.key === who);
  if (usernames[clean] && usernames[clean].key !== who) return { error: 'Ese nombre ya está tomado.' };
  if (mine && mine[0] !== clean) delete usernames[mine[0]];
  const isoToday = () => new Date().toISOString().slice(0, 10);
  usernames[clean] = { key: who, name: displayName || 'Anónima', claimedAt: isoToday() };
  return { sub: clean };
}
export function subOf(usernames, who) {
  const mine = Object.entries(usernames || {}).find(([, v]) => v.key === who);
  return mine ? mine[0] : null;
}

export const SUBOFFER_TEXT = (cfg, sub) => '🌐 ¿Quieres ' + sub + '.liberada.net también?\n\n' +
  'Un enlace corto de autor para compartir todas tus risas juntas. Tu perfil ' +
  'redirigirá a tus risas allí. Puedes cambiar el nombre cuando quieras.';
export const SUBOFFER_KEYS = () => ({ inline_keyboard: [[
  { text: '✅ Sí, quiero', callback_data: 'suboffer:yes' },
  { text: '🤔 No sé', callback_data: 'suboffer:maybe' },
  { text: '🚫 No, seguro', callback_data: 'suboffer:never' }
]] });

export function publishedConfirmation(q, cfg, usernames, suboffer) {
  const lines = ['✅ ¡Tu risa ya está publicada!'];
  if (q.title) lines.push('✏️ ' + q.title);
  if (q.tags && q.tags.length) lines.push('🏷️ ' + q.tags.join(', '));
  lines.push('🙂 ' + (q.name || 'Anónima'));
  const who = q.uploader;
  const so = suboffer[who];
  const showEdit = !(so && so.status === 'never');
  const mine = subOf(usernames, who);
  if (so && so.status === 'yes' && mine) {
    lines.push('🌐 Subdominio activado: ' + mine + '.liberada.net');
  } else if (showEdit) {
    lines.push('🌐 Tu subdominio <nombre>.liberada.net · Editar');
  }
  if (q.claimToken) {
    const web = String(cfg.webUrl || 'https://risa.liberada.net').replace(/\/+$/, '');
    lines.push('🔑 Reclama tu perfil: ' + web + '/#/claim/' + encodeURIComponent(q.claimToken));
  }
  lines.push('📣 Grupo Risa liberada: ' + cfg.groupUrl);
  lines.push('📌 Envía /perfil para ver más opciones');
  const keys = showEdit
    ? { inline_keyboard: [[{ text: '✏️ Editar subdominio', callback_data: 'subedit' }]] } : undefined;
  const wantsOffer = !so || so.status === 'maybe';
  return { text: lines.join('\n'), keys, wantsOffer };
}

export const SUBEDIT_TEXT = '✏️ Escribe el nombre de tu subdominio:\n\n' +
  'Entre 3 y 20 letras, números o guiones bajos (sin acentos). Te quedará así:\n' +
  '<nombre>.liberada.net';
export const SUBEDIT_KEYS = () => ({ inline_keyboard: [[
  { text: '✖️ Cancelar', callback_data: 'subedit:cancel' }
]] });

export const ENTRAR_TEXT = '🔑 Reclama tu perfil\n\n' +
  'El bot te da un enlace de reclamo personal. Ábrelo una vez: la web verifica ' +
  'el token contra el clip publicado y te lleva a tu página de autor.\n\n' +
  'También puedes pegar el token en la miniapp.';
export const ENTRAR_KEYS = (cfg) => ({ inline_keyboard: [[
  { text: '📱 Abrir miniapp', url: String(cfg.webUrl || 'https://risa.liberada.net').replace(/\/+$/, '') + '/#/entrar' }
], [
  { text: '🔑 Mi enlace de reclamo', callback_data: 'entrar:claim' }
]] });

export const MEJORAR_TEXT = '✨ Mejorar tu risa — novedades\n\n' +
  '🌐 <b>Subdominio de autor</b> — tu perfil en <tu-nombre>.liberada.net para ' +
  'compartir todas tus risas con un enlace corto.\n' +
  '✏️ <b>Editar perfil</b> — cambia tu nombre público y tu subdominio desde la ' +
  'web o aquí mismo.\n' +
  '🚀 <b>Más funciones y apps</b> — seguimos sumando apps liberada y perfiles ' +
  'cada vez más tuyos.\n\n' +
  '➡️ Tu perfil redirigirá a tus risas allí.';
