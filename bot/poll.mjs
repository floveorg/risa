// bot/poll.mjs — thin orchestrator: config → state → loop → handleAction
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseUpdates, risaEntry, prependClip, identityOf, hashId, MAX_FILE_BYTES, clipsOf,
  latestClips, clipsOfAuthor, clipsToday, clipsSince, randomClip,
  tagTrend, authorStats, searchClips, inlineResult,
  hasAncestor, clipByChannelMsg, encChatId, decChatId, claimTokenOf, claimHashOf
} from './logic.mjs';
import { pageUrlOf } from './pages.mjs';
import { Telegram } from './telegram.mjs';
import { uploadAudio, uploadMedia } from './r2.mjs';
import { buildFeeds } from '../build-rss.mjs';
import { publishClip, persistFeed, commitState } from './publish.mjs';
import { loadState, saveState, pollLoop, writeJSON } from './ingest.mjs';
import {
  WELCOME_TEXT, TGPUB_TEXT, TGPUB_KEYS, ENTRAR_TEXT, ENTRAR_KEYS,
  MEJORAR_TEXT, SUBOFFER_TEXT, SUBOFFER_KEYS, SUBEDIT_TEXT, SUBEDIT_KEYS,
  BUTTONS, EDIT_PROMPT_KEYS, EDIT_KEYS, ACCEPT_KEYS, CANCEL_KEYS,
  ALIAS_KEYS, OPTIONS, draftText, tagsText, tagsKeys,
  OVERLAP_TEXT, OVERLAP_KEYS, RESUME_KEYS,
  displayName, identityLabel, tagsHash, addTags, selOf, DEFAULT_SEL,
  clipLine, detailLines, proposalLines, modCaption, parseEditDetails,
  subdomainUrl, subdomainBase, candidateUsernameOf, claimUsername,
  renameUsername, subOf, publishedConfirmation
} from './drafts.mjs';

// Salt for the obfuscated Telegram-id hash.
const TG_ID_SECRET = process.env.TG_ID_SECRET || 'risa-dev-secret';
const CLAIM_SECRET = process.env.CLAIM_SECRET || TG_ID_SECRET;

const ROOT = new URL('..', import.meta.url).pathname;
const p = (rel) => ROOT + rel;

const readJSON = async (rel, fallback) => {
  try { return JSON.parse(await readFile(p(rel), 'utf8')); } catch { return fallback; }
};

// Answering the callback is cosmetic — never let it block the real work.
const bestEffort = (promise) => promise.catch((err) => console.error('non-fatal:', err.message));

// ── Presencia del bot ────────────────────────────────────────────────────────
async function setupBotPresence(tg, cfg) {
  const web = String(cfg.webUrl || 'https://risa.liberada.net').replace(/\/+$/, '');
  const miniapp = web + '/#/entrar';
  await bestEffort(tg.setMyDescription(
    'Risa liberada · Comparte tu risa con todos aquí 💛\n\n' +
    'Graba una risa (máx. 1 min) y, tras moderación, la publicamos en ' +
    (cfg.channel || '@risaliberada') + ' y en la web.\n' +
    '🌐 Tu perfil (miniapp): ' + miniapp
  ));
  await bestEffort(tg.setMyShortDescription('Comparte tu risa con todos aquí 💛 ' + miniapp));
  await bestEffort(tg.setMyCommands([
    { command: 'entrar', description: 'Entrar a tu perfil (miniapp)' },
    { command: 'mejorar', description: 'Novedades de risa' },
    { command: 'usuario', description: 'Tu subdominio .liberada.net' },
    { command: 'name', description: 'Tu nombre público' },
    { command: 'pub', description: 'Mostrar tu @ en la web' },
    { command: 'me', description: 'Tu página de autor' },
    { command: 'perfil', description: 'Tus opciones de perfil' },
    { command: 'notify', description: 'Avisos de respuestas: /notify on|off' },
    { command: 'latest', description: 'Últimas risas' },
    { command: 'random', description: 'Una risa al azar' },
    { command: 'trending', description: 'Etiquetas con más risas' }
  ]));
  if (cfg.channel) {
    await bestEffort(tg.setChatDescription(cfg.channel,
      'Risa liberada · Comparte tu risa con todos aquí 💛\n🌐 Miniapp: ' + miniapp));
  }
  if (cfg.modGroupId) {
    await bestEffort(tg.setChatDescription(String(cfg.modGroupId),
      'Risas nuevas en moderación · 💛 ' + miniapp));
  }
}

// ── Handle one action (the core switch) ──────────────────────────────────────
export async function handleAction(a, tg, cfg, state) {
  const { queue, drafts, risas, uploaders, uploads, tgpub, names,
          suboffer, usernames, clipOwners, notifyprefs } = state;
  const limits = cfg.limits || {};

  // Parent intent (remix deep link / forward) → open draft or pending holder.
  // With an OPEN draft the promise applies to THAT draft — the web dock and the
  // bot text both say «esta risa», so silently keeping the old parent would lie.
  // Returns true when an open draft was reparented (message re-rendered).
  async function attachParent(chatId, parent, remix) {
    const key = String(chatId);
    const prev = drafts[key] || {};
    const title = parent.t || parent.name || 'esta risa';
    if (prev.fileId) {
      prev.parent = parent.id;
      prev.parentTitle = title;
      prev.remix = !!remix;
      delete prev.pendingParent;
      if (prev.draftMsgId) await renderDraftCard(chatId, prev);
      return true;
    }
    drafts[key] = { ...prev, pendingParent: { id: parent.id, remix: !!remix, title } };
    return false;
  }

  // Pinta la ficha del borrador (texto + botones título/tags/enviar). Si el
  // mensaje anterior ya no existe («message not found», chat limpiado…), el
  // edit falla y se reenvía la ficha COMO MENSAJE NUEVO — el formulario nunca
  // se pierde; el id del mensaje se actualiza para los siguientes edits.
  async function renderDraftCard(chatId, d) {
    const text = draftText(d);
    if (d.draftMsgId) {
      try {
        await tg.editMessageText(chatId, d.draftMsgId, text, OPTIONS(d));
        return;
      } catch (err) {
        console.error('draft card edit failed → resending fresh:', err.message);
      }
    }
    const sent = await tg.sendMessage(chatId, text, OPTIONS(d));
    d.draftMsgId = sent.message_id;
  }

  // Borrador nuevo a partir de una acción con medio (draft / draft-replace).
  function newDraftFrom(a) {
    return {
      id: a.id, fileId: a.fileId, name: a.name, username: a.username, video: !!a.video,
      title: a.title || '', tags: [], sel: { ...DEFAULT_SEL },
      fromChatId: a.fromChatId, fromMsgId: a.fromMsgId,
      awaitingTitle: false, awaitingTags: false,
      parent: a.parent || null, parentTitle: a.parentTitle || null, remix: !!a.remix
    };
  }

  if (a.kind === 'draft') {
    const key = String(a.chatId);
    const prev = drafts[key] || {};
    const base = newDraftFrom(a);
    // Red de seguridad: un pendingParent de un lote anterior que parseUpdates
    // no haya podido fusionar se honra aquí.
    const pp = prev.pendingParent;
    if (!base.parent && pp && pp.id) {
      base.parent = pp.id;
      base.parentTitle = pp.title || null;
      if (pp.remix) base.remix = true;
    }
    drafts[key] = { ...base, draftMsgId: prev.draftMsgId };
    await renderDraftCard(a.chatId, drafts[key]);
    return { dirty: true };
  }
  if (a.kind === 'draft-title') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    d.awaitingTitle = true; d.awaitingTags = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Escribe el título'));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId,
      '✏️ Escribe el título de tu risa (una palabra o frase corta):', CANCEL_KEYS()));
    return { dirty: true };
  }
  if (a.kind === 'draft-title-text') {
    const d = drafts[String(a.chatId)];
    if (!d || !d.awaitingTitle) return {};
    d.title = (a.title || '').slice(0, 60); d.awaitingTitle = false;
    await renderDraftCard(a.chatId, d);
    return { dirty: true };
  }
  if (a.kind === 'draft-tags') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    d.awaitingTitle = false; d.awaitingTags = true;
    await bestEffort(tg.answerCallback(a.callbackId, 'Etiqueta tu risa'));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, tagsText(d), tagsKeys()));
    return { dirty: true };
  }
  if (a.kind === 'draft-tags-text') {
    const d = drafts[String(a.chatId)];
    if (!d || !d.awaitingTags) return {};
    addTags(d, a.tagsText);
    await bestEffort(tg.editMessageText(a.chatId, d.draftMsgId, tagsText(d), tagsKeys()));
    return { dirty: true };
  }
  if (a.kind === 'draft-tags-done') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    d.awaitingTags = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Etiquetas guardadas'));
    await renderDraftCard(a.chatId, d);
    return { dirty: true };
  }
  if (a.kind === 'draft-id') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    const s = selOf(d);
    if (a.mode === 'anon') { s.anon = !s.anon; if (s.anon) s.alias = ''; }
    await bestEffort(tg.answerCallback(a.callbackId, 'Autor: ' + displayName(d)));
    await renderDraftCard(a.chatId, d);
    return { dirty: true };
  }
  if (a.kind === 'draft-aliases') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    await bestEffort(tg.answerCallback(a.callbackId, 'Elige tu alias'));
    const who = hashId(a.chatId, TG_ID_SECRET);
    let aliases = [];
    try {
      const res = await fetch('https://risa.liberada.net/api/aliases/' + encodeURIComponent(who),
        { signal: AbortSignal.timeout(2500) });
      const data = res.ok ? await res.json() : null;
      if (data && data.ok) aliases = data.aliases || [];
    } catch (_) {}
    if (!aliases.length) {
      const label = d.name || 'Anónima';
      aliases = [{ alias: label, private: false }];
    }
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId,
      '🙂 Elige tu alias:\n\n' + aliases.map((x) => (x.private ? '🔒 ' : '') + x.alias).join('\n'), ALIAS_KEYS(aliases)));
    return { dirty: true };
  }
  if (a.kind === 'draft-alias') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    const s = selOf(d);
    s.alias = a.mode; s.anon = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Autor: ' + a.mode));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, draftText(d), OPTIONS(d)));
    return { dirty: true };
  }
  if (a.kind === 'draft-alias-new') {
    const d = drafts[String(a.chatId)];
    if (!d) return {};
    d.awaitingAlias = true;
    await bestEffort(tg.answerCallback(a.callbackId, 'Escribe el nuevo alias'));
    await bestEffort(tg.sendMessage(a.chatId, '✏️ Escribe tu nuevo alias (público):', CANCEL_KEYS()));
    return { dirty: true };
  }
  if (a.kind === 'draft-alias-new-text') {
    const key = String(a.chatId);
    const d = drafts[key];
    if (!d || !d.awaitingAlias) return {};
    d.awaitingAlias = false;
    const alias = String(a.text || '').trim().slice(0, 40);
    if (!alias) {
      await bestEffort(tg.editMessageText(a.chatId, d.draftMsgId, draftText(d), OPTIONS(d)));
      return { dirty: true };
    }
    const s = selOf(d);
    s.alias = alias; s.anon = false;
    const who = hashId(a.chatId, TG_ID_SECRET);
    try {
      await fetch('https://risa.liberada.net/api/aliases', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer devris' },
        body: JSON.stringify({ key: who, alias, private: false }),
        signal: AbortSignal.timeout(2500) });
    } catch (_) {}
    await bestEffort(tg.answerCallback(a.callbackId, 'Alias guardado'));
    await bestEffort(tg.editMessageText(a.chatId, d.draftMsgId, draftText(d), OPTIONS(d)));
    return { dirty: true };
  }
  if (a.kind === 'draft-cancel') {
    const key = String(a.chatId);
    if (!drafts[key]) return {};
    delete drafts[key];
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId,
      '❌ Risa cancelada — mándame otra cuando quieras 💛'));
    return { dirty: true };
  }
  if (a.kind === 'draft-send') {
    const d = drafts[String(a.chatId)];
    if (!d) { await bestEffort(tg.answerCallback(a.callbackId, 'Nada que enviar')); return {}; }
    // Heal drafts stuck with a parent intent that arrived after the media:
    // honour it now so «Enviar» publishes what the bot promised.
    if (d.pendingParent && d.pendingParent.id) {
      d.parent = d.pendingParent.id;
      d.parentTitle = d.pendingParent.title || null;
      d.remix = !!d.pendingParent.remix;
      delete d.pendingParent;
    }
    if (queue[d.id] || risas.some((e) => e.id === d.id)) { delete drafts[String(a.chatId)]; return { dirty: true }; }
    const who = hashId(a.chatId, TG_ID_SECRET);
    const today = new Date().toISOString().slice(0, 10);
    const day = uploads[today] || (uploads[today] = {});
    if ((day[who] || 0) >= limits.maxPerDay) {
      await bestEffort(tg.answerCallback(a.callbackId, 'Límite diario alcanzado'));
      await bestEffort(tg.sendMessage(a.chatId,
        'Ya has enviado ' + limits.maxPerDay + ' risas hoy. Vuelve mañana 💛'));
      return {};
    }
    const pending = Object.values(queue).filter((e) => e.uploader === who).length;
    if (pending >= limits.maxPending) {
      await bestEffort(tg.answerCallback(a.callbackId, 'Cola llena'));
      await bestEffort(tg.sendMessage(a.chatId,
        'Ya tienes ' + limits.maxPending + ' risas en moderación. Espera a que se publiquen o borren antes de enviar más 💛'));
      return {};
    }
    const name = displayName(d);
    const caption = [d.title || '', tagsHash(d.tags), name].filter(Boolean).join('\n');
    const copied = await tg.copyMessage(cfg.modGroupId, d.fromChatId, d.fromMsgId, BUTTONS(d.id), caption);
    queue[d.id] = { fileId: d.fileId, name, username: d.username, title: d.title, video: !!d.video,
                    tags: d.tags || [], sel: d.sel || { ...DEFAULT_SEL },
                    uploader: who,
                    ...identityOf(d.sel, a.chatId, TG_ID_SECRET), modMsgId: copied.message_id,
                    parent: d.parent || null, remix: !!d.remix };
    day[who] = (day[who] || 0) + 1;
    uploaders[d.id] = a.chatId;
    delete drafts[String(a.chatId)];
    await bestEffort(tg.answerCallback(a.callbackId, 'Enviada a moderación'));
    await bestEffort(tg.sendMessage(a.chatId,
      'Gracias, lo revisamos en breve y te avisamos cuando se publique.'));
    const entry = queue[d.id];
    if (entry.idHash && !tgpub[who]) {
      await bestEffort(tg.sendMessage(a.chatId, TGPUB_TEXT, TGPUB_KEYS()));
    }
    return { dirty: true };
  }
  if (a.kind === 'draft-overlap') {
    const key = String(a.chatId);
    const d = drafts[key];
    if (d && d.fileId) {
      // La risa nueva se guarda como reemplazo pendiente; el usuario elige.
      d.pendingMedia = {
        id: a.id, fileId: a.fileId, video: !!a.video, name: a.name, username: a.username,
        fromChatId: a.fromChatId, fromMsgId: a.fromMsgId, title: a.title || '',
        parent: a.parent || null, parentTitle: a.parentTitle || null, remix: !!a.remix
      };
      await bestEffort(tg.sendMessage(a.chatId, OVERLAP_TEXT, OVERLAP_KEYS()));
      return { dirty: true };
    }
    // Carrera: el borrador ya no está abierto → trátala como risa nueva.
    const prev = drafts[key] || {};
    const base = newDraftFrom(a);
    const pp = prev.pendingParent;
    if (!base.parent && pp && pp.id) {
      base.parent = pp.id;
      base.parentTitle = pp.title || null;
      if (pp.remix) base.remix = true;
    }
    drafts[key] = { ...base, draftMsgId: prev.draftMsgId };
    await renderDraftCard(a.chatId, drafts[key]);
    return { dirty: true };
  }
  if (a.kind === 'draft-resume') {
    const d = drafts[String(a.chatId)];
    await bestEffort(tg.answerCallback(a.callbackId, d && d.fileId ? 'Aquí está tu borrador' : 'No hay ningún borrador'));
    if (!d || !d.fileId) return {};
    delete d.pendingMedia;
    await renderDraftCard(a.chatId, d);       // reabre/refresca el formulario
    return { dirty: true };
  }
  if (a.kind === 'draft-replace') {
    const key = String(a.chatId);
    const d = drafts[key];
    const pm = d && d.pendingMedia;
    await bestEffort(tg.answerCallback(a.callbackId, pm ? 'Borrador cambiado a la nueva' : 'No hay risa nueva guardada'));
    if (!d || !pm) return {};
    const oldMsgId = d.draftMsgId;
    drafts[key] = { ...newDraftFrom(pm), draftMsgId: oldMsgId };
    delete d.pendingMedia;
    await renderDraftCard(a.chatId, drafts[key]);
    // El botón «Enviar» de la ficha vieja apuntaría al borrador nuevo: sin botones.
    if (oldMsgId && oldMsgId !== drafts[key].draftMsgId) {
      await bestEffort(tg.editReplyMarkupClear(a.chatId, oldMsgId));
    }
    return { dirty: true };
  }
  if (a.kind === 'draft-invalid') {
    const msg = a.reason === 'size'
      ? 'Ups… tu archivo supera el límite de 10 MB. Mándalo en un formato más ligero 💛'
      : 'Ups… tu risa supera el minuto. Mándala más cortita 💛';
    await bestEffort(tg.sendMessage(a.chatId, msg));
    return {};
  }
  if (a.kind === 'welcome') {
    const d = drafts[String(a.chatId)];
    await bestEffort(tg.sendMessage(a.chatId, WELCOME_TEXT, (d && d.fileId) ? RESUME_KEYS() : undefined));
    return {};
  }
  if (a.kind === 'forward-channel') {
    const parent = clipByChannelMsg(risas, a.channelMsgId);
    if (!parent) {
      await bestEffort(tg.sendMessage(a.chatId,
        'No encontré esa risa en el feed. Prueba a reenviarla más tarde.'));
      return {};
    }
    const open = await attachParent(a.chatId, parent, false);
    await bestEffort(tg.sendMessage(a.chatId,
      '↳ Respondiendo a «' + (parent.t || parent.name || 'esta risa') + '»\n\n' +
      (open
        ? 'Tu borrador ahora responde a esa risa.'
        : 'Ahora envía tu risa (nota de voz o vídeo).')));
    return { dirty: true };
  }
  if (a.kind === 'remix-start') {
    const clip = (Array.isArray(risas) ? risas : []).find((c) => c.id === a.clipId);
    if (!clip) {
      await bestEffort(tg.sendMessage(a.chatId,
        'No encontré ese clip. Abre el bot desde la risa que quieres remezclar 💛'));
      return {};
    }
    const open = await attachParent(a.chatId, clip, true);
    await bestEffort(tg.sendMessage(a.chatId,
      '🔀 Encima de «' + (clip.t || clip.name || 'esta risa') + '»\n\n' +
      (open
        ? 'Tu borrador se publicará como remix de esa risa. El original se mezclará de fondo al publicar.'
        : 'Envía tu grabación (el .webm que descargaste o una nota de voz) y la ' +
          'publicaremos como remix de esa risa. El original se mezclará de fondo al publicar; ' +
          'para oírlo mientras grabas, usa auriculares.') + ' 💛'));
    return { dirty: true };
  }
  if (a.kind === 'rename') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const n = (a.name || '').trim();
    if (!n) {
      await bestEffort(tg.sendMessage(a.chatId, 'Uso: /name <tu nombre público>'));
      return {};
    }
    names[who] = n;
    await bestEffort(tg.sendMessage(a.chatId,
      'Nombre público guardado: ' + n + ' — se aplica a tus próximas risas publicadas.'));
    return { dirty: true };
  }
  if (a.kind === 'tgpub-ask') {
    await bestEffort(tg.sendMessage(a.chatId, TGPUB_TEXT, TGPUB_KEYS()));
    return {};
  }
  if (a.kind === 'cmd-usuario') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const r = renameUsername(usernames, who, a.arg, names[who]);
    if (r.error) {
      await bestEffort(tg.sendMessage(a.chatId,
        '⚠️ ' + r.error + '\n\nUso: /usuario <nuevo_nombre> para tu subdominio'));
      return {};
    }
    suboffer[who] = { status: 'yes', sub: r.sub };
    await bestEffort(tg.sendMessage(a.chatId, '🌐 Nombre guardado: ' + subdomainUrl(cfg, r.sub)));
    return { dirty: true };
  }
  if (a.kind === 'tgpub-yes' || a.kind === 'tgpub-no') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const yes = a.kind === 'tgpub-yes';
    tgpub[who] = { ok: yes, username: a.username ? '@' + a.username : '' };
    await bestEffort(tg.answerCallback(a.callbackId,
      yes ? 'Tu @ se mostrará junto a tu nombre' : 'Perfecto, tu @ quedará oculto'));
    return { dirty: true };
  }
  if (a.kind === 'suboffer-yes') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const sub = claimUsername({ uploader: who, username: a.username, name: names[who] }, usernames);
    suboffer[who] = { status: 'yes', sub };
    await bestEffort(tg.answerCallback(a.callbackId, '¡Creado!'));
    await bestEffort(tg.sendMessage(a.chatId,
      '🌐 ¡Listo! Tu enlace de autor:\n\n' + subdomainUrl(cfg, sub) + '\n\n' +
      'Lo verás en tus próximas publicaciones. Puedes cambiarlo con Editar o con /entrar.'));
    return { dirty: true };
  }
  if (a.kind === 'suboffer-maybe') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    suboffer[who] = { status: 'maybe' };
    await bestEffort(tg.answerCallback(a.callbackId, 'Te lo preguntamos en tu próxima publicación'));
    return { dirty: true };
  }
  if (a.kind === 'suboffer-never') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    suboffer[who] = { status: 'never' };
    await bestEffort(tg.answerCallback(a.callbackId, 'Entendido, no volveremos a preguntar'));
    return { dirty: true };
  }
  if (a.kind === 'subedit') {
    const key = String(a.chatId);
    const d = drafts[key] || (drafts[key] = {});
    d.awaitingSubedit = true;
    await bestEffort(tg.answerCallback(a.callbackId, 'Escribe el nuevo nombre'));
    await bestEffort(tg.sendMessage(a.chatId, SUBEDIT_TEXT, SUBEDIT_KEYS()));
    return { dirty: true };
  }
  if (a.kind === 'subedit-cancel') {
    const d = drafts[String(a.chatId)];
    if (d) d.awaitingSubedit = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Cancelado'));
    return { dirty: true };
  }
  if (a.kind === 'subedit-text') {
    const key = String(a.chatId);
    const d = drafts[key];
    if (!d || !d.awaitingSubedit) return {};
    d.awaitingSubedit = false;
    const who = hashId(a.chatId, TG_ID_SECRET);
    const r = renameUsername(usernames, who, a.text, names[who]);
    if (r.error) {
      await bestEffort(tg.sendMessage(a.chatId, '⚠️ ' + r.error + '\n\n' + SUBEDIT_TEXT, SUBEDIT_KEYS()));
      d.awaitingSubedit = true;
      return { dirty: true };
    }
    suboffer[who] = { status: 'yes', sub: r.sub };
    await bestEffort(tg.sendMessage(a.chatId, '🌐 Nombre guardado: ' + subdomainUrl(cfg, r.sub)));
    return { dirty: true };
  }
  if (a.kind === 'cmd-entrar') {
    await bestEffort(tg.sendMessage(a.chatId, ENTRAR_TEXT, ENTRAR_KEYS(cfg)));
    return {};
  }
  if (a.kind === 'entrar-miniapp') {
    await bestEffort(tg.answerCallback(a.callbackId, 'Abriendo la miniapp…'));
    const web = String(cfg.webUrl || 'https://risa.liberada.net').replace(/\/+$/, '');
    await bestEffort(tg.sendMessage(a.chatId,
      'Pega tu token de reclamo aquí:\n\n' + web + '/#/entrar\n\n' + ENTRAR_TEXT, ENTRAR_KEYS(cfg)));
    return {};
  }
  if (a.kind === 'entrar-claim') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const mine = clipsOfAuthor(risas, who);
    if (!mine.length) {
      await bestEffort(tg.sendMessage(a.chatId,
        'Aún no tienes risas publicadas. Publica una y te daré su enlace de reclamo.'));
      return {};
    }
    const clip = mine[0];
    let dirty = false;
    if (!clip.claim) {
      clip.claim = claimHashOf(claimTokenOf(who, clip.id, CLAIM_SECRET));
      dirty = true;
    }
    const token = claimTokenOf(who, clip.id, CLAIM_SECRET);
    const web = String(cfg.webUrl || 'https://risa.liberada.net').replace(/\/+$/, '');
    await bestEffort(tg.answerCallback(a.callbackId, 'Enlace generado'));
    await bestEffort(tg.sendMessage(a.chatId,
      '🔑 Tu enlace de reclamo:\n\n' + web + '/#/claim/' + encodeURIComponent(token) +
      '\n\nÁbrelo una vez. La web comprueba el token contra tu risa publicada y te lleva a tu página de autor.'));
    return { dirty };
  }
  if (a.kind === 'cmd-mejorar') {
    await bestEffort(tg.sendMessage(a.chatId, MEJORAR_TEXT));
    return {};
  }
  if (a.kind === 'approve') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Publicando…' : 'Ya resuelta'));
    if (!q) return {};
    if (q.pendingAccept) {
      await bestEffort(tg.answerCallback(a.callbackId,
        'La risa está esperando el visto bueno del autor — resuélvelo antes'));
      return {};
    }
    if (risas.some((e) => e.id === a.id)) { delete queue[a.id]; return { dirty: true }; }
    if (!q.fileId) throw new Error('queue entry missing fileId for ' + a.id);
    state.risas = await publishClip(tg, cfg, q, a.id, risas, names, tgpub);
    delete queue[a.id];
    await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '✅ Publicado'));
    const upChatId = uploaders[a.id];
    if (upChatId) {
      clipOwners[q.id] = upChatId;
      const conf = publishedConfirmation(q, cfg, usernames, suboffer);
      if (conf.wantsOffer) {
        conf.keys = conf.keys
          ? { inline_keyboard: conf.keys.inline_keyboard.concat(SUBOFFER_KEYS().inline_keyboard) }
          : SUBOFFER_KEYS();
      }
      await bestEffort(tg.sendMessage(upChatId, conf.text, conf.keys));
      delete uploaders[a.id];
      if (q.parent) {
        const parentClip = state.risas.find(e => e.id === q.parent);
        const parentChatId = clipOwners[q.parent];
        if (parentClip && parentChatId && parentChatId !== upChatId &&
            notifyprefs[parentClip.key] !== false) {
          const reactName = (q.name || 'Alguien');
          const reactUrl = pageUrlOf(q.uploader, cfg.webUrl);
          await bestEffort(tg.sendMessage(parentChatId,
            reactName + ' ha comentado a tu risa\n\n' +
            'Míralo aquí: ' + reactUrl + '\n' +
            '🚫 Para apagar estos avisos: /notify off'));
        }
      }
    }
    return { dirty: true };
  }
  if (a.kind === 'reject') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Borrada'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '🗑 Borrada'));
      delete queue[a.id]; delete uploaders[a.id];
    }
    return { dirty: !!q };
  }
  if (a.kind === 'mod-edit') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Editando…' : 'Ya resuelta'));
    if (!q) return {};
    q.editing = true; q.proposed = undefined;
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Editando — manda los detalles en una línea:\nTítulo | Tags | Nombre\n\nActuales:\n' +
      detailLines(q).join('\n')));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_PROMPT_KEYS(a.id)));
    return { dirty: true };
  }
  if (a.kind === 'mod-edit-text') {
    const q = queue[a.id];
    if (!q) return {};
    const prop = parseEditDetails(a.text);
    if (!Object.keys(prop).length) {
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
        'Nada que proponer — usa el formato: Título | Tags | Nombre'));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_PROMPT_KEYS(a.id)));
      return { dirty: true };
    }
    q.proposed = prop; q.editing = false;
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Propuesta:\n\n' + proposalLines(q).join('\n') +
      '\n\n¿La enviamos al autor para su visto bueno?'));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_KEYS(a.id)));
    return { dirty: true };
  }
  if (a.kind === 'mod-edit-send') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Enviando propuesta…' : 'Ya resuelta'));
    if (!q) return {};
    const upChatId = uploaders[a.id];
    if (!upChatId) {
      q.editing = false; q.proposed = undefined;
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
        'No encuentro al autor para el visto bueno — propuesta cancelada.'));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
      return { dirty: true };
    }
    q.editing = false; q.pendingAccept = true;
    await bestEffort(tg.sendMessage(upChatId,
      'Un moderador quiere ajustar tu risa antes de publicarla 💛\n\n' +
      proposalLines(q).join('\n') + '\n\n¿Te vale así?', ACCEPT_KEYS(a.id)));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Propuesta enviada al autor — esperando su visto bueno.'));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, { inline_keyboard: [] }));
    return { dirty: true };
  }
  if (a.kind === 'mod-edit-cancel') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Edición cancelada'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, modCaption(q)));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
    }
    return { dirty: !!q };
  }
  if (a.kind === 'edit-accept') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Publicando…' : 'Ya resuelta'));
    if (!q) return {};
    if (risas.some((e) => e.id === a.id)) { delete queue[a.id]; return { dirty: true }; }
    q.editing = false; q.pendingAccept = false;
    if (q.proposed) {
      if (q.proposed.title) q.title = q.proposed.title;
      if (q.proposed.tags) q.tags = q.proposed.tags;
      if (q.proposed.name) q.name = q.proposed.name;
      q.proposed = undefined;
    }
    if (!q.fileId) throw new Error('queue entry missing fileId for ' + a.id);
    state.risas = await publishClip(tg, cfg, q, a.id, risas, names, tgpub);
    delete queue[a.id];
    await bestEffort(tg.editReplyMarkupClear(a.chatId, a.msgId));
    await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '✅ Publicado'));
    const upChatId = uploaders[a.id];
    if (upChatId) {
      clipOwners[q.id] = upChatId;
      const conf = publishedConfirmation(q, cfg, usernames, suboffer);
      if (conf.wantsOffer) {
        conf.keys = conf.keys
          ? { inline_keyboard: conf.keys.inline_keyboard.concat(SUBOFFER_KEYS().inline_keyboard) }
          : SUBOFFER_KEYS();
      }
      await bestEffort(tg.sendMessage(upChatId, conf.text, conf.keys));
      delete uploaders[a.id];
    }
    return { dirty: true };
  }
  if (a.kind === 'edit-reject') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Dejamos tu risa como estaba'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editReplyMarkupClear(a.chatId, a.msgId));
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, modCaption(q)));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
      await bestEffort(tg.sendMessage(cfg.modGroupId,
        'El autor no aceptó la propuesta para ' + a.id + ' — se conserva lo original.'));
    }
    return { dirty: !!q };
  }
  // ---- Read-only commands ----
  if (a.kind === 'cmd-me') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const st = authorStats(risas, queue, key);
    await bestEffort(tg.sendMessage(a.chatId,
      '👤 Tu página de autor: ' + pageUrlOf(key, cfg.webUrl) + '\n' +
      '🙂 ' + (names[key] || 'Anónima') + '\n' +
      '📀 Publicadas: ' + st.published + '\n' +
      '⏳ En moderación: ' + st.pending));
    return {};
  }
  if (a.kind === 'cmd-profile') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    if (a.arg) {
      const match = (Array.isArray(risas) ? risas : [])
        .filter((e) => String(e.name || '').toLowerCase() === a.arg.toLowerCase());
      if (!match.length) {
        await bestEffort(tg.sendMessage(a.chatId,
          'No encontré ningún autor con ese nombre. Prueba /profile sin palabra para ver tu página.'));
        return {};
      }
      const keys = [...new Set(match.map((e) => e.key).filter(Boolean))];
      await bestEffort(tg.sendMessage(a.chatId,
        '👥 Autor «' + a.arg + '» — páginas:\n' +
        keys.map((k) => '• ' + pageUrlOf(k, cfg.webUrl)).join('\n')));
    } else {
      await bestEffort(tg.sendMessage(a.chatId,
        '👤 Tu página de autor: ' + pageUrlOf(key, cfg.webUrl) + '\n' +
        '🙂 ' + (names[key] || 'Anónima') + '\n' +
        '📀 Publicadas: ' + authorStats(risas, queue, key).published));
    }
    return {};
  }
  if (a.kind === 'cmd-perfil') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const st = authorStats(risas, queue, key);
    const sub = subOf(usernames, key);
    const notifyOn = notifyprefs[key] !== false;
    await bestEffort(tg.sendMessage(a.chatId,
      '👤 Tu perfil en risa liberada\n\n' +
      '🙂 Nombre: ' + (names[key] || 'Anónima') + ' — cámbialo con /name\n' +
      '🌐 Subdominio: ' + (sub ? subdomainUrl(cfg, sub) : 'sin activar — /mejorar o /usuario') + '\n' +
      '💬 Avisos de respuestas: ' + (notifyOn ? 'ON' : 'OFF') + ' — /notify on|off\n' +
      '📀 Publicadas: ' + st.published + ' · ⏳ En moderación: ' + st.pending + '\n' +
      '🔗 Tu página: ' + pageUrlOf(key, cfg.webUrl)));
    return {};
  }
  if (a.kind === 'cmd-notify') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const arg = String(a.arg || '').toLowerCase();
    if (arg === 'on' || arg === 'off') {
      notifyprefs[key] = arg === 'on';
      await bestEffort(tg.sendMessage(a.chatId,
        arg === 'on' ? '🔔 Avisos de respuestas activados.' : '🔕 Avisos de respuestas desactivados.'));
      return { dirty: true };
    }
    const on = notifyprefs[key] !== false;
    await bestEffort(tg.sendMessage(a.chatId,
      '💬 Avisos de respuestas: ' + (on ? 'ON' : 'OFF') + '\nUso: /notify on  ·  /notify off'));
    return {};
  }
  if (a.kind === 'cmd-stats') {
    const today = clipsToday(risas);
    const authors = new Set((Array.isArray(risas) ? risas : []).map((e) => e.key).filter(Boolean)).size;
    await bestEffort(tg.sendMessage(a.chatId,
      '📊 Risa liberada — stats\n\n' +
      '📀 ' + (Array.isArray(risas) ? risas.length : 0) + ' risas publicadas\n' +
      '📅 ' + today.length + ' hoy\n' +
      '⏳ ' + Object.keys(queue).length + ' en moderación\n' +
      '👥 ' + authors + ' autores'));
    return {};
  }
  if (a.kind === 'cmd-status') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const draft = drafts[String(a.chatId)];
    await bestEffort(tg.sendMessage(a.chatId,
      '🟢 Estado del circuito\n\n' +
      '⏳ ' + Object.keys(queue).length + ' risas en moderación\n' +
      '📅 ' + clipsToday(risas).length + ' publicadas hoy\n' +
      '📀 ' + (Array.isArray(risas) ? risas.length : 0) + ' risas publicadas\n' +
      '✏️ Tu borrador: ' + (draft ? 'en curso (termina en el mensaje anterior)' : '—') + '\n' +
      '👤 Página: ' + pageUrlOf(key, cfg.webUrl)));
    return {};
  }
  if (a.kind === 'cmd-queue') {
    const entries = Object.values(queue).slice(0, 10);
    if (!entries.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'No hay risas en moderación ahora mismo 💛'));
      return {};
    }
    const lines = ['⏳ En moderación (' + entries.length + '):'];
    entries.forEach((e) => lines.push('• ' + (e.title || '—') + ' · 🙂 ' + (e.name || 'Anónima')));
    await bestEffort(tg.sendMessage(a.chatId, lines.join('\n')));
    return {};
  }
  if (a.kind === 'cmd-latest') {
    const clips = latestClips(risas, 5);
    if (!clips.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay risas publicadas — sé la primera 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId, '🆕 Últimas risas:\n\n' + clips.map(clipLine).join('\n')));
    return {};
  }
  if (a.kind === 'cmd-now') {
    const e = (Array.isArray(risas) ? risas : [])[0];
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay risas publicadas 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId, '▶️ Ahora mismo suena:\n\n' + clipLine(e) + '\n' + e.src));
    return {};
  }
  if (a.kind === 'cmd-today') {
    const clips = clipsToday(risas);
    if (!clips.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Hoy aún no se ha publicado nada 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '📅 Hoy (' + clips.length + '):\n\n' + clips.slice(0, 10).map(clipLine).join('\n')));
    return {};
  }
  if (a.kind === 'cmd-since') {
    const days = Math.min(90, Math.max(1, parseInt(a.arg, 10) || 1));
    const clips = clipsSince(risas, days);
    if (!clips.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'No hay risas de los últimos ' + days + ' día(s) 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '🗓️ Últimos ' + days + ' día(s) (' + clips.length + '):\n\n' +
      clips.slice(0, 10).map(clipLine).join('\n')));
    return {};
  }
  if (a.kind === 'cmd-random') {
    const e = randomClip(risas);
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay risas publicadas 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId, '🎲 Del saco:\n\n' + clipLine(e) + '\n' + e.src));
    return {};
  }
  if (a.kind === 'cmd-trending') {
    const top = tagTrend(risas, 50).slice(0, 5);
    if (!top.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay etiquetas que mostrar 💛'));
      return {};
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '🔥 Etiquetas con más risas:\n\n' +
      top.map((t, i) => (i + 1) + '. #' + t.tag + ' ×' + t.count).join('\n')));
    return {};
  }
  if (a.kind === 'cmd-play') {
    const e = (Array.isArray(risas) ? risas : [])[0];
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay risas publicadas — sé la primera 💛'));
      return {};
    }
    await bestEffort(tg.sendAudioByUrl(a.chatId, e.src, clipLine(e),
      { title: e.t, performer: e.name }));
    return {};
  }
  if (a.kind === 'inline-search') {
    const clips = searchClips(risas, a.query, 10);
    const results = clips.map(inlineResult);
    await bestEffort(tg.answerInlineQuery(a.queryId, results, {
      cache_time: 300, is_personal: false,
      switch_pm_text: results.length ? '' : '💬 Sube tu risa',
      switch_pm_parameter: 'inline_empty'
    }));
    return {};
  }
  return {};
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const cfg = await readJSON('config.json', {});
  if (!cfg.modGroupId) throw new Error('config.json modGroupId not set (run Task 6)');
  cfg.limits = { ...{ maxFileBytes: 10 * 1024 * 1024, maxDurationS: 60, maxPending: 5, maxPerDay: 5 }, ...(cfg.limits || {}) };
  const tg = Telegram(token);

  await bestEffort(setupBotPresence(tg, cfg));

  const state = await loadState();

  await pollLoop(tg, cfg, state, async (actions, st) => {
    let dirty = false;
    for (const a of actions) {
      try {
        const r = await handleAction(a, tg, cfg, st);
        if (r.dirty) dirty = true;
      } catch (err) {
        console.error('action failed', a.id, a.kind, err.message);
      }
    }
    return { state: st, dirty };
  });

  await persistFeed(state.risas, cfg);
  await commitState();
}

// Run the loop only when executed directly (tests import handleAction).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
