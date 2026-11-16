// bot/ingest.mjs — Telegram polling loop, state load/save, offset management
import { readFile, writeFile } from 'node:fs/promises';
import { parseUpdates, clipsOf, decChatId } from './logic.mjs';
import { Telegram } from './telegram.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const p = (rel) => ROOT + rel;

const readJSON = async (rel, fallback) => {
  try { return JSON.parse(await readFile(p(rel), 'utf8')); } catch { return fallback; }
};
export const writeJSON = (rel, v) => writeFile(p(rel), JSON.stringify(v, null, 2) + '\n');

const LOOP_MAX_MS = 8 * 60 * 1000;
const POLL_TIMEOUT = 25;

// Persistencia de borradores/uploaders con ids de chat ofuscados (encChatId),
// para que el cron los conserve entre corridas sin exponer ids en claro.
import { encChatId } from './logic.mjs';

const TG_ID_SECRET = process.env.TG_ID_SECRET || 'risa-dev-secret';

const encDrafts = (d) => Object.fromEntries(Object.entries(d || {}).map(([k, v]) =>
  [encChatId(k, TG_ID_SECRET), { ...v, fromChatId: encChatId(v.fromChatId, TG_ID_SECRET) }]));
const encUploaders = (u) => Object.fromEntries(Object.entries(u || {}).map(([id, c]) =>
  [id, encChatId(c, TG_ID_SECRET)]));

// Load all state files from disk, decoding obfuscated chat IDs.
export async function loadState() {
  let drafts = await readJSON('state/drafts.json', {});
  let uploaders = await readJSON('state/.uploaders.json', {});
  drafts = Object.fromEntries(Object.entries(drafts).map(([k, d]) =>
    [decChatId(k, TG_ID_SECRET), { ...d, fromChatId: decChatId(d.fromChatId, TG_ID_SECRET) }]));
  uploaders = Object.fromEntries(Object.entries(uploaders).map(([id, c]) => [id, decChatId(c, TG_ID_SECRET)]));
  let clipOwners = await readJSON('state/clipowners.json', {});
  clipOwners = Object.fromEntries(Object.entries(clipOwners).map(([id, c]) => [id, decChatId(c, TG_ID_SECRET)]));

  return {
    offset: parseInt(await readFile(p('state/offset.txt'), 'utf8'), 10) || 0,
    queue: await readJSON('state/queue.json', {}),
    drafts,
    uploaders,
    uploads: await readJSON('state/uploads.json', {}),
    tgpub: await readJSON('state/tgpub.json', {}),
    names: await readJSON('state/names.json', {}),
    suboffer: await readJSON('state/suboffer.json', {}),
    clipOwners,
    notifyprefs: await readJSON('state/notifyprefs.json', {}),
    usernames: await readJSON('usernames.json', {}),
    risas: clipsOf(await readJSON('risa.json', [])),
  };
}

// Persist all state files to disk, encoding obfuscated chat IDs.
export async function saveState(state) {
  const { queue, drafts, uploaders, uploads, tgpub, names, suboffer,
          clipOwners, notifyprefs, usernames, risas, offset } = state;
  await writeJSON('state/queue.json', queue);
  await writeJSON('state/drafts.json', encDrafts(drafts));
  await writeJSON('state/.uploaders.json', encUploaders(uploaders));
  await writeJSON('state/uploads.json', uploads);
  await writeJSON('state/tgpub.json', tgpub);
  await writeJSON('state/names.json', names);
  await writeJSON('state/suboffer.json', suboffer);
  await writeJSON('state/clipowners.json', encUploaders(clipOwners));
  await writeJSON('state/notifyprefs.json', notifyprefs);
  await writeJSON('usernames.json', usernames);
  await writeFile(p('state/offset.txt'), String(offset) + '\n');
}

// Run the polling loop: poll Telegram → parse updates → call handler → persist.
// `handleBatch` is called with (actions, state) and must return { state, dirty }.
export async function pollLoop(tg, cfg, state, handleBatch) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOOP_MAX_MS) {
    const { queue, drafts, uploaders, offset } = state;
    const modMsgToId = Object.fromEntries(
      Object.entries(queue).map(([id, e]) => [e.modMsgId, id]));
    const awaitingTitle = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingTitle));
    const awaitingTags = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingTags));
    const awaitingDraftParent = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.pendingParent).map(([k, d]) => [k, d.pendingParent]));
    const awaitingModEdit = Object.fromEntries(
      Object.entries(queue).filter(([, e]) => e.editing));
    const awaitingSubedit = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingSubedit));
    const awaitingAlias = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingAlias));

    const updates = await tg.getUpdates(offset, POLL_TIMEOUT);
    const { actions, offset: nextOffset } = parseUpdates(
      updates, { modGroupId: cfg.modGroupId, modMsgToId, awaitingTitle, awaitingTags,
                 awaitingDraftParent, awaitingModEdit, awaitingSubedit, awaitingAlias,
                 uploaderOf: uploaders, drafts, risas: state.risas, limits: cfg.limits }, offset);

    if (actions.length) {
      const result = await handleBatch(actions, state);
      Object.assign(state, result.state);
      if (result.dirty) await saveState(state);
    }

    if (nextOffset !== offset) {
      state.offset = nextOffset;
      await writeFile(p('state/offset.txt'), String(nextOffset) + '\n');
    }
    if (actions.length) {
      console.log(`processed ${actions.length} action(s); offset ${state.offset}; risas ${state.risas.length}`);
    }
  }
  await saveState(state);
}
