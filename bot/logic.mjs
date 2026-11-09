// Pure logic: Telegram getUpdates -> ordered actions + new offset. No I/O.

import { createHash } from 'node:crypto';

const APPROVE_WORDS = new Set(['ok', 'si', 'sí', 'yes', 'publicar', 'publish', 'dale', 'adelante', 'aprobado', 'subir', 'listo']);
const REJECT_WORDS = new Set(['no', 'borrar', 'delete', 'rechazar', 'quitar', 'fuera', 'cancelar', 'anular']);

const MAX_FILE_BYTES = 10 * 1024 * 1024;  // 10 MB — audios de 1 min jamás lo alcanzan
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20 MB — los vídeos se comprimen al publicar (MP4), tope de descarga de la Bot API
const MAX_DURATION_S = 60;                // 1 min — risas cortas (estándar §6)
export { MAX_FILE_BYTES, MAX_VIDEO_BYTES, MAX_DURATION_S };

// Obfuscated store of the uploader's Telegram id. One-way, salted: the hash is
// stable per bot install (TG_ID_SECRET) but never reversible, so the id never
// travels in claro beyond DM autor / grupo privado / cabecera del bot.
export function hashId(chatId, secret = '') {
  return createHash('sha256').update(String(secret) + ':' + String(chatId)).digest('hex');
}

// Which identity fields land in queue.json (committed to the public repo):
//   ①+②  -> { idHash }    (Nombre público oscurece el ID — hash 🔒)
//   solo ① -> { idDirect } (ID directo)
//   ③ / ② / nada -> {}     (sin identidad Telegram en el repo)
export function identityOf(sel, chatId, secret = '') {
  const s = sel || {};
  if (s.anon) return {};
  if (s.tg && s.name) return { idHash: hashId(chatId, secret) };
  if (s.tg) return { idDirect: String(chatId) };
  return {};
}

// Map the text a moderator types (as a reply to a mod message) to a decision.
export function decisionOf(raw) {
  const text = (raw || '').trim();
  if (/^(✅|👍|✔️|sí|si|ok|yes)$/i.test(text)) return 'approve';
  if (/^(🗑|❌|🚫|no)$/i.test(text)) return 'reject';
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').trim();
  if (!t) return null;
  if (APPROVE_WORDS.has(t)) return 'approve';
  if (REJECT_WORDS.has(t)) return 'reject';
  return null;
}

export function parseUpdates(updates, ctx, currentOffset = 0) {
  const lim = ctx.limits || {};
  const maxBytes = lim.maxFileBytes || MAX_FILE_BYTES;
  const maxVideoBytes = lim.maxVideoBytes || MAX_VIDEO_BYTES;
  const maxDur = lim.maxDurationS || MAX_DURATION_S;
  const actions = [];
  const draftChats = new Set();
  let maxId = -1;
  for (const u of updates) {
    if (typeof u.update_id === 'number') maxId = Math.max(maxId, u.update_id);

    const cb = u.callback_query;
    if (cb && cb.message && cb.message.chat) {
      const chatId = cb.message.chat.id;
      if (chatId === ctx.modGroupId) {
        const m = /^(ok|no):(.+)$/.exec(cb.data || '');
        if (m) {
          actions.push({
            kind: m[1] === 'ok' ? 'approve' : 'reject',
            id: m[2], callbackId: cb.id, modMsgId: cb.message.message_id
          });
          continue;
        }
        const ed = /^edit(-(send|cancel))?:(.+)$/.exec(cb.data || '');
        if (ed) {
          const kind = ed[2] === 'send' ? 'mod-edit-send'
            : ed[2] === 'cancel' ? 'mod-edit-cancel'
            : 'mod-edit';
          actions.push({ kind, id: ed[3], callbackId: cb.id, modMsgId: cb.message.message_id });
        }
        continue;
      }
      if (cb.message.chat.type === 'private' && cb.from && cb.from.id === chatId) {
        const m = /^draft:([a-z-]+)(?::([^:]*))?$/.exec(cb.data || '');
        if (m) {
          const act = m[1];
          if (act === 'id' && m[2]) {
            actions.push({ kind: 'draft-id', chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id, mode: m[2] });
          } else if (act === 'aliases') {
            actions.push({ kind: 'draft-aliases', chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id });
          } else if (act === 'alias' && m[2]) {
            actions.push({ kind: 'draft-alias', chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id, mode: m[2] });
          } else if (['title', 'tags', 'tags-done', 'send', 'cancel', 'alias-new', 'resume', 'replace'].includes(act)) {
            actions.push({ kind: 'draft-' + act, chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id });
          }
          continue;
        }
        const tp = /^tgpub:(yes|no)$/.exec(cb.data || '');
        if (tp) {
          actions.push({ kind: 'tgpub-' + tp[1], chatId, callbackId: cb.id,
            username: (cb.from && cb.from.username) || '' });
          continue;
        }
        // Subdominio de autor, opt-in: Sí quiero / No sé / No, seguro.
        const so = /^suboffer:(yes|maybe|never)$/.exec(cb.data || '');
        if (so) {
          actions.push({ kind: 'suboffer-' + so[1], chatId, callbackId: cb.id,
            msgId: cb.message.message_id,
            username: (cb.from && cb.from.username) || '' });
          continue;
        }
        // «Editar» el nombre del subdominio (username.liberada.net) o cancelar.
        const se = /^subedit(:cancel)?$/.exec(cb.data || '');
        if (se) {
          actions.push({ kind: se[1] ? 'subedit-cancel' : 'subedit', chatId, callbackId: cb.id });
          continue;
        }
        // /entrar: opciones de acceso a la miniapp de perfil.
        const en = /^entrar:(code|miniapp|email)$/.exec(cb.data || '');
        if (en) {
          actions.push({ kind: 'entrar-' + en[1], chatId, callbackId: cb.id });
          continue;
        }
        // Visto bueno del autor sobre los cambios propuestos por el moderador.
        // Solo cuenta si el callback llega del chat que subió la risa.
        const ok = /^accept:(.+)$/.exec(cb.data || '');
        if (ok && ctx.uploaderOf && ctx.uploaderOf[ok[1]] === chatId) {
          actions.push({ kind: 'edit-accept', id: ok[1], chatId, callbackId: cb.id,
            msgId: cb.message.message_id });
          continue;
        }
        const rj = /^reject-edit:(.+)$/.exec(cb.data || '');
        if (rj && ctx.uploaderOf && ctx.uploaderOf[rj[1]] === chatId) {
          actions.push({ kind: 'edit-reject', id: rj[1], chatId, callbackId: cb.id,
            msgId: cb.message.message_id });
        }
      }
      continue;
    }

    const iq = u.inline_query;
    if (iq && iq.id && iq.query !== undefined) {
      actions.push({ kind: 'inline-search', queryId: iq.id, query: iq.query.trim(),
        userId: iq.from && iq.from.id });
    }

    const msg = u.message;
    if (msg && msg.chat && msg.chat.id === ctx.modGroupId) {
      const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
      let decided = false;
      if (replyId) {
        const id = ctx.modMsgToId && ctx.modMsgToId[replyId];
        const kind = decisionOf(msg.text);
        if (id && kind) {
          actions.push({ kind, id, modMsgId: replyId, via: 'reply' });
          decided = true;
        }
      }
      // Un texto libre mientras una risa está en edición son sus nuevos detalles.
      if (!decided && msg.text && ctx.awaitingModEdit) {
        const editId = Object.keys(ctx.awaitingModEdit)[0];
        if (editId) {
          actions.push({ kind: 'mod-edit-text', id: editId, chatId: msg.chat.id, text: msg.text.trim() });
        }
      }
      continue;
    }
    if (msg && msg.chat && msg.chat.type === 'private') {
      const key = String(msg.chat.id);
      // Forward from channel: user forwards a published clip to the bot (reply-to-clip flow)
      const fwd = msg.forward_from_chat;
      if (fwd && msg.forward_from_message_id) {
        actions.push({
          kind: 'forward-channel', chatId: msg.chat.id,
          channelMsgId: msg.forward_from_message_id,
          channelId: fwd.id
        });
        // Threading in the same batch: the forward and the reply voice-note
        // usually arrive together (e.g. after the bot was offline). Register
        // the pending parent NOW so the media parsed right after this forward
        // attaches to the clip instead of waiting for the next poll tick.
        const parent = clipByChannelMsg(ctx.risas, msg.forward_from_message_id);
        if (parent && ctx.awaitingDraftParent) {
          ctx.awaitingDraftParent[key] = { id: parent.id, remix: false, title: parent.t || parent.name || '' };
        }
        continue;
      }
      // El remix «Grabar encima» se descarga en la web como .webm y se envía al
      // bot como archivo (document) — un audio/vídeo en documento también entra.
      const docMedia = msg.document && /^(audio|video)\//i.test(msg.document.mime_type || '') ? msg.document : null;
      const media = msg.voice || msg.audio || msg.video || msg.video_note || docMedia;
      if (media && media.file_id) {
        // Un vídeo no se rechaza por los 10 MB: entra hasta el tope de descarga
        // (20 MB) y se comprime a MP4 al publicar para que quepa (marca `video`).
        // `video_note` (vídeo circular «mantener pulsado») se trata como vídeo.
        const video = !!(msg.video || msg.video_note || (docMedia && /^video\//i.test(docMedia.mime_type || '')));
        const sizeCap = video ? maxVideoBytes : maxBytes;
        if (media.file_size && media.file_size > sizeCap) {
          actions.push({ kind: 'draft-invalid', chatId: msg.chat.id, reason: 'size' });
        } else if (media.duration && media.duration > maxDur) {
          actions.push({ kind: 'draft-invalid', chatId: msg.chat.id, reason: 'duration' });
        } else {
          // One draft per user: never silently overwrite an unfinished one.
          // `draftChats` catches another media that already became this user's
          // draft earlier in the SAME batch (drafts only mutate in handleAction,
          // after parseUpdates). A pure pendingParent holder (forward/remix
          // without media yet) is NOT an open draft.
          const pd = ctx.drafts && ctx.drafts[key];
          const hasOpenDraft = draftChats.has(key) || !!(pd && (pd.fileId ||
            pd.awaitingTitle || pd.awaitingTags || pd.awaitingAlias || pd.awaitingSubedit));
          // Check for pending forward/reply (threading) — { id, remix }
          const pp = ctx.awaitingDraftParent && ctx.awaitingDraftParent[key];
          if (hasOpenDraft) {
            // La risa nueva NO se pierde: viaja en la acción para que el bot
            // ofrezca abrir el borrador actual o usar esta en su lugar.
            actions.push({
              kind: 'draft-overlap', id: 'q_' + u.update_id, chatId: msg.chat.id,
              fileId: media.file_id, ...(video ? { video: true } : {}),
              fromChatId: msg.chat.id, fromMsgId: msg.message_id,
              name: (msg.from && msg.from.first_name) || 'Anónima',
              username: (msg.from && msg.from.username) || '',
              title: (msg.caption || '').trim(),
              ...(pp && pp.id ? { parent: pp.id } : {}),
              ...(pp && pp.title ? { parentTitle: pp.title } : {}),
              ...(pp && pp.remix ? { remix: true } : {})
            });
            if (pp && ctx.awaitingDraftParent) delete ctx.awaitingDraftParent[key];
          } else {
            const draftAction = {
              kind: 'draft', id: 'q_' + u.update_id, chatId: msg.chat.id,
              fileId: media.file_id, ...(video ? { video: true } : {}),
              fromChatId: msg.chat.id, fromMsgId: msg.message_id,
              name: (msg.from && msg.from.first_name) || 'Anónima',
              username: (msg.from && msg.from.username) || '',
              title: (msg.caption || '').trim()
            };
            if (pp && pp.id) draftAction.parent = pp.id;
            if (pp && pp.title) draftAction.parentTitle = pp.title;
            if (pp && pp.remix) draftAction.remix = true;
            actions.push(draftAction);
            draftChats.add(key);
            // Clear pending forward after use
            if (pp && ctx.awaitingDraftParent) {
              delete ctx.awaitingDraftParent[key];
            }
          }
        }
      } else if (msg.text) {
        // Deep link desde la web «Grabar encima» → /start remix_<clipId>
        const rm = /^\/start\s+remix_([^\s]+)/i.exec(msg.text.trim()) || /^remix_([^\s]+)/i.exec(msg.text.trim());
        if (rm) {
          const clipId = decodeURIComponent(rm[1]);
          actions.push({ kind: 'remix-start', chatId: msg.chat.id, clipId });
          // Same-batch threading: el .webm llega justo detrás del deep link en
          // el MISMO lote (getUpdates acumulado) — registra el padre ya.
          const clip = (Array.isArray(ctx.risas) ? ctx.risas : []).find((c) => c.id === clipId);
          if (clip && ctx.awaitingDraftParent) {
            ctx.awaitingDraftParent[key] = { id: clip.id, remix: true, title: clip.t || clip.name || '' };
          }
          continue;
        }
        // /name y /pub mutan tu identidad; el resto son consultas de solo lectura
        // (cmd-*: el bot responde, no cambia estado).
        const cmd = /^\/(name|pub|entrar|mejorar|usuario|me|stats|profile|perfil|notify|status|queue|latest|random|now|since|today|trending|play)\b(?:\s+(.+))?$/i.exec(msg.text.trim());
        if (cmd) {
          const c = cmd[1].toLowerCase();
          if (c === 'name') {
            actions.push({ kind: 'rename', chatId: msg.chat.id, name: (cmd[2] || '').trim().slice(0, 40) });
          } else if (c === 'pub') {
            actions.push({ kind: 'tgpub-ask', chatId: msg.chat.id });
          } else {
            actions.push({ kind: 'cmd-' + c, chatId: msg.chat.id, arg: (cmd[2] || '').trim() });
          }
        } else if (ctx.awaitingTitle && ctx.awaitingTitle[key]) {
          actions.push({ kind: 'draft-title-text', chatId: msg.chat.id, title: (msg.text || '').trim() });
        } else if (ctx.awaitingTags && ctx.awaitingTags[key]) {
          actions.push({ kind: 'draft-tags-text', chatId: msg.chat.id, tagsText: (msg.text || '').trim() });
        } else if (ctx.awaitingAlias && ctx.awaitingAlias[key]) {
          actions.push({ kind: 'draft-alias-new-text', chatId: msg.chat.id, text: (msg.text || '').trim() });
        } else if (ctx.awaitingSubedit && ctx.awaitingSubedit[key]) {
          actions.push({ kind: 'subedit-text', chatId: msg.chat.id, text: (msg.text || '').trim() });
        } else {
          actions.push({ kind: 'welcome', chatId: msg.chat.id });
        }
      }
    }
  }
  const offset = maxId >= 0 ? maxId + 1 : currentOffset;
  return { actions, offset };
}

export function risaEntry({ id, name, tags, when, src, t, tg, key, video, parent, channelMsgId, remix }) {
  // `src` is the absolute media URL (R2/public). The website composes
  // the license (`by`, `orig`) from `name`; the bot never writes those (see spec §4).
  const e = {
    id,
    name: name || 'Anónima',
    src,
    when
  };
  if (t) e.t = t;
  if (tags) e.tags = tags;
  if (tg) e.tg = tg;    // enlace t.me solo si el autor hizo opt-in (C19), nunca automático
  if (key) e.key = key; // página de autor: hash salado del id (tag-url automática), estable e inédito en claro
  if (video) e.video = true; // marca de vídeo: la web lo filtra/reproduce como vídeo (mp4)
  if (parent) e.parent = parent; // hilo: id del clip al que responde (thread reply)
  if (remix) e.remix = true; // remix «Grabar encima»: la web lo resalta como tal
  if (channelMsgId) e.channelMsgId = channelMsgId; // mapeo canal→clip para forwards
  return e;
}

// Find a clip by its channel message id (for forward-reply detection).
export function clipByChannelMsg(clips, channelMsgId) {
  if (!channelMsgId) return null;
  return (Array.isArray(clips) ? clips : []).find(c => c.channelMsgId === channelMsgId) || null;
}

// Cycle detection: returns true if linking childId as a child of proposedParent
// would create a cycle (A→B→…→A). Safe for any depth.
export function hasAncestor(clips, childId, proposedParent) {
  let current = proposedParent;
  while (current) {
    if (current === childId) return true;
    const parent = (Array.isArray(clips) ? clips : []).find(c => c.id === current);
    current = parent && parent.parent;
  }
  return false;
}

export function prependClip(risas, entry) {
  return [entry, ...(Array.isArray(risas) ? risas : [])];
}

// Extracción del feed: risa.json puede ser array (v1) u objeto {schema,clips}.
// Mismo contrato que `clipsOf` de risa.js, aquí puro para el bot.
export function clipsOf(risa) {
  if (Array.isArray(risa)) return risa;
  return (risa && Array.isArray(risa.clips)) ? risa.clips : [];
}

// Ofuscación reversible de ids de chat para persistirlos en el repo sin
// exponerlos en claro (drafts.json, .uploaders.json). Reversible solo con
// TG_ID_SECRET; sin el secret el hex es ininteligible (nunca el id directo).
function chatKey(secret) {
  return createHash('sha256').update(String(secret) + ':chat-id').digest();
}
export function encChatId(id, secret = '') {
  const key = chatKey(secret);
  const s = String(id);
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key[i % key.length]);
  return Buffer.from(out, 'binary').toString('hex');
}
export function decChatId(hex, secret = '') {
  if (!hex) return hex;
  const key = chatKey(secret);
  const s = Buffer.from(String(hex), 'hex').toString('binary');
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key[i % key.length]);
  return out;
}

// ---- Consultas de solo lectura (comandos cmd-* del bot; sin I/O) ----

// Últimos n publicados (nuevos primero).
export function latestClips(risas, n = 5) {
  return (Array.isArray(risas) ? risas : []).slice(0, Math.max(0, n));
}

// Todos los clips de un autor, por su key/handle (nuevos primero).
export function clipsOfAuthor(risas, key) {
  return (Array.isArray(risas) ? risas : []).filter((e) => e.key === key);
}

// Publicados hoy (when === fecha ISO yyyy-mm-dd).
export function clipsToday(risas, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  return (Array.isArray(risas) ? risas : []).filter((e) => e.when === t);
}

// Publicados en los últimos N días (incluye hoy). N >= 1, por defecto 1.
export function clipsSince(risas, days = 1, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const from = new Date(t + 'T00:00:00Z');
  from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1));
  const fromIso = from.toISOString().slice(0, 10);
  return (Array.isArray(risas) ? risas : []).filter((e) => e.when >= fromIso);
}

// Una risa al azar, o undefined si no hay risas.
export function randomClip(risas) {
  const b = Array.isArray(risas) ? risas : [];
  return b.length ? b[Math.floor(Math.random() * b.length)] : undefined;
}

// Tags más usados en los últimos n clips: [{ tag, count }], de más a menos.
export function tagTrend(risas, n = 50) {
  const counts = new Map();
  latestClips(risas, n).forEach((e) =>
    String(e.tags || '').split(/[;,]/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean)
      .forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// Resumen de un autor: publicados y en cola de moderación.
export function authorStats(risas, queue, key) {
  return { key, published: clipsOfAuthor(risas, key).length,
           pending: Object.values(queue || {}).filter((e) => e.uploader === key).length };
}

// ---- Inline mode: search clips for sharing in any chat ----

// Search risa.json by query (matches title, tags, name).
export function searchClips(risas, query, limit = 10) {
  if (!query) {
    // No query: return latest clips
    return latestClips(risas, limit);
  }
  const q = query.toLowerCase();
  return (Array.isArray(risas) ? risas : [])
    .filter((e) => {
      const title = (e.t || '').toLowerCase();
      const tags = String(e.tags || '').toLowerCase();
      const name = (e.name || '').toLowerCase();
      return title.includes(q) || tags.includes(q) || name.includes(q);
    })
    .slice(0, limit);
}

// Format a clip as a Telegram InlineQueryResultAudio.
export function inlineResult(e) {
  return {
    type: 'audio',
    id: e.id,
    audio_url: e.src,
    title: e.t || 'Risa liberada',
    performer: e.name || 'Anónima',
    caption: [(e.t || ''), (e.tags || ''), (e.name || 'Anónima')].filter(Boolean).join(' · '),
    description: e.tags || undefined
  };
}
