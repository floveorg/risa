import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdates, decisionOf, hashId, identityOf, risaEntry, MAX_VIDEO_BYTES, clipsOf,
         encChatId, decChatId,
         latestClips, clipsOfAuthor, clipsToday, clipsSince,
         randomClip, tagTrend, authorStats, searchClips, inlineResult,
         claimTokenOf, claimHashOf } from '../logic.mjs';

const CTX = { modGroupId: -1001234 };

test('hashId is one-way, stable, and salted', () => {
  const a = hashId(12345, 'secret');
  const b = hashId(12345, 'secret');
  assert.equal(a, b);
  assert.equal(a.length, 64);                       // sha256 hex
  assert.notEqual(a, hashId(12346, 'secret'));      // differs per id
  assert.notEqual(a, hashId(12345, 'other-secret'));// differs per salt
  assert.notEqual(a, String(12345));                // never the raw id
});

test('identityOf: ①+② obfuscates the id (idHash only)', () => {
  const got = identityOf({ tg: true, name: true, anon: false }, 777, 's');
  assert.deepEqual(Object.keys(got), ['idHash']);
  assert.equal(got.idHash, hashId(777, 's'));
});

test('identityOf: solo ① keeps the id direct', () => {
  const got = identityOf({ tg: true, name: false, anon: false }, 777, 's');
  assert.deepEqual(got, { idDirect: '777' });
});

test('encChatId/decChatId round-trip hides the id in the repo', () => {
  const enc = encChatId(123456789, 'secret');
  assert.notEqual(enc, '123456789');              // nunca en claro
  assert.equal(decChatId(enc, 'secret'), '123456789');  // reversible con el secret
  assert.notEqual(decChatId(enc, 'other'), '123456789');// sin el secret, ilegible
  assert.equal(decChatId(encChatId(777, 's'), 's'), '777');
});

test('clipsOf extracts array or {schema,clips} (bot feed contract)', () => {
  assert.deepEqual(clipsOf([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(clipsOf({ schema: 'risa-feed/1', clips: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(clipsOf({ schema: 'risa-feed/1' }), []);
  assert.deepEqual(clipsOf(null), []);
});

test('identityOf: ③ anónimo and ② name-only store nothing', () => {
  assert.deepEqual(identityOf({ tg: false, name: false, anon: true }, 777, 's'), {});
  assert.deepEqual(identityOf({ tg: false, name: true, anon: false }, 777, 's'), {});
  assert.deepEqual(identityOf({}, 777, 's'), {});
});

test('decisionOf maps approval/rejection words', () => {
  assert.equal(decisionOf('ok'), 'approve');
  assert.equal(decisionOf('SÍ'), 'approve');
  assert.equal(decisionOf('publicar'), 'approve');
  assert.equal(decisionOf('✅'), 'approve');
  assert.equal(decisionOf('no'), 'reject');
  assert.equal(decisionOf('borrar'), 'reject');
  assert.equal(decisionOf('🗑'), 'reject');
  assert.equal(decisionOf('qué risa'), null);
  assert.equal(decisionOf(''), null);
});

test('a private voice message becomes a draft action', () => {
  const updates = [{
    update_id: 10,
    message: { message_id: 5, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'AAA', duration: 3 } }
  }];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 11);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    kind: 'draft', id: 'q_10', chatId: 777, fileId: 'AAA', fromChatId: 777, fromMsgId: 5,
    name: 'Marta', username: '', title: ''
  });
});

test('a forward from the channel becomes a forward-channel action', () => {
  const updates = [{
    update_id: 11,
    message: { message_id: 7, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      forward_from_chat: { id: -100999, type: 'channel' },
      forward_from_message_id: 42 }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    kind: 'forward-channel', chatId: 777, channelMsgId: 42, channelId: -100999
  });
});

test('forward + reply voice-note in the SAME batch threads the reply (pendingParent)', () => {
  const risas = [{ id: 'clipA', name: 'Padre', channelMsgId: 42 }];
  const awaitingDraftParent = {};
  const ctx = { ...CTX, risas, awaitingDraftParent };
  const updates = [
    { update_id: 20, message: { message_id: 8, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      forward_from_chat: { id: -100999, type: 'channel' }, forward_from_message_id: 42 } },
    { update_id: 21, message: { message_id: 9, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'REPLY', duration: 5 } } },
    { update_id: 22, message: { message_id: 10, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'SOLO', duration: 4 } } }
  ];
  const { actions } = parseUpdates(updates, ctx);
  assert.equal(actions[0].kind, 'forward-channel');
  // the reply voice-note attaches to the forwarded clip…
  assert.equal(actions[1].kind, 'draft');
  assert.equal(actions[1].fileId, 'REPLY');
  assert.equal(actions[1].parent, 'clipA');
  // …and the following plain voice-note is NOT silently overwritten: it is
  // refused so the threaded draft survives (one draft per user).
  assert.equal(actions[2].kind, 'draft-overlap');
  assert.equal(actions[2].chatId, 777);
});

test('a webm sent as document (audio mime) becomes a draft', () => {
  const updates = [{
    update_id: 25,
    message: { message_id: 11, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      document: { file_id: 'WEBM', mime_type: 'audio/webm', file_size: 512 * 1024, file_name: 'remix.blas.webm' } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].fileId, 'WEBM');
  assert.equal(actions[0].video, undefined);
});

test('a video document is drafted with the video mark', () => {
  const updates = [{
    update_id: 26,
    message: { message_id: 12, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      document: { file_id: 'MP4', mime_type: 'video/mp4', file_size: 4 * 1024 * 1024, file_name: 'remix.mp4' } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].video, true);
});

test('a non-media document is ignored', () => {
  const updates = [{
    update_id: 27,
    message: { message_id: 13, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      document: { file_id: 'PDF', mime_type: 'application/pdf', file_name: 'doc.pdf' } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 0);
});

test('/start remix_<clipId> becomes a remix-start action', () => {
  const updates = [{
    update_id: 28,
    message: { message_id: 14, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: '/start remix_q_823020302' }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { kind: 'remix-start', chatId: 777, clipId: 'q_823020302' });
});

test('a pendingParent holder (no media yet) is NOT an open draft — the reply webm still threads', () => {
  // forward/remix-start only writes pendingParent on drafts[key]; the clip that
  // arrives next must not be refused as "overlap".
  const drafts = { '777': { pendingParent: { id: 'q_1', remix: true } } };
  const ctx = { ...CTX, drafts, awaitingDraftParent: {} };
  const updates = [{
    update_id: 42, message: { message_id: 17, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      document: { file_id: 'WEBM', mime_type: 'audio/webm', file_name: 'remix.webm' } }
  }];
  const { actions } = parseUpdates(updates, ctx);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].fileId, 'WEBM');
});

test('remix deep-link + webm in the SAME batch threads it with the remix mark', () => {
  const ctx = { ...CTX, risas: [{ id: 'q_1', t: 'Padre' }], awaitingDraftParent: {} };
  const updates = [
    { update_id: 40, message: { message_id: 15, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: '/start remix_q_1' } },
    { update_id: 41, message: { message_id: 16, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' },
      document: { file_id: 'WEBM', mime_type: 'audio/webm', file_name: 'remix.webm' } } }
  ];
  const { actions } = parseUpdates(updates, ctx);
  assert.equal(actions[0].kind, 'remix-start');
  assert.equal(actions[1].kind, 'draft');
  assert.equal(actions[1].parent, 'q_1');
  assert.equal(actions[1].remix, true);
});

test('a media while an unsent draft is pending is refused (no silent loss)', () => {
  const drafts = { '777': { id: 'q_5', chatId: 777, fileId: 'FIRST', draftMsgId: 9, awaitingTitle: false, awaitingTags: false } };
  const ctx = { ...CTX, drafts };
  const updates = [
    { update_id: 30, message: { message_id: 12, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'EXTRA', duration: 5 } } }
  ];
  const { actions } = parseUpdates(updates, ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'draft-overlap');
});

test('an audio message with a caption carries the caption as title', () => {
  const updates = [{
    update_id: 12,
    message: { message_id: 6, chat: { id: 888, type: 'private' },
      from: { first_name: 'Yusuf' }, audio: { file_id: 'BBB' }, caption: 'de vientre' }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].title, 'de vientre');
  assert.equal(actions[0].id, 'q_12');
  assert.equal(actions[0].fileId, 'BBB');
});

test('oversized or overlong media is rejected instead of drafted', () => {
  const updates = [
    { update_id: 60, message: { message_id: 1, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'BIG', file_size: 11 * 1024 * 1024, duration: 3 } } },
    { update_id: 61, message: { message_id: 2, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, voice: { file_id: 'LONG', file_size: 1024, duration: 61 } } },
    { update_id: 62, message: { message_id: 3, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, audio: { file_id: 'OK', file_size: 10 * 1024 * 1024, duration: 20 } } },
  ];
  const { actions } = parseUpdates(updates, CTX);
  assert.deepEqual(actions[0], { kind: 'draft-invalid', chatId: 777, reason: 'size' });
  assert.deepEqual(actions[1], { kind: 'draft-invalid', chatId: 777, reason: 'duration' });
  assert.equal(actions[2].kind, 'draft');
});

test('limits can be overridden per deployer via ctx.limits', () => {
  const mk = (duration) => [{ update_id: 70, message: { message_id: 1, chat: { id: 777, type: 'private' },
    from: { first_name: 'Marta' }, voice: { file_id: 'V', duration } } }];
  const { actions: strict } = parseUpdates(mk(61), { modGroupId: -1001234, limits: { maxDurationS: 120 } });
  assert.equal(strict[0].kind, 'draft');
  const { actions: lenient } = parseUpdates(mk(61), { modGroupId: -1001234, limits: { maxDurationS: 30 } });
  assert.deepEqual(lenient[0], { kind: 'draft-invalid', chatId: 777, reason: 'duration' });
});

test('a video message becomes a draft action with the video mark', () => {
  const updates = [{
    update_id: 71,
    message: { message_id: 7, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, video: { file_id: 'VID', duration: 45, file_size: 5 * 1024 * 1024 } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].fileId, 'VID');
  assert.equal(actions[0].video, true);
});

test('a vídeo over 10 MB is drafted (it will be compressed on publish), over 20 MB rejected', () => {
  const mk = (bytes) => [{ update_id: 72, message: { message_id: 8, chat: { id: 777, type: 'private' },
    from: { first_name: 'Marta' }, video: { file_id: 'V' + bytes, duration: 40, file_size: bytes } } }];
  const { actions: big } = parseUpdates(mk(15 * 1024 * 1024), CTX);
  assert.equal(big[0].kind, 'draft');
  assert.equal(big[0].video, true);
  const { actions: huge } = parseUpdates(mk(MAX_VIDEO_BYTES + 1), CTX);
  assert.deepEqual(huge[0], { kind: 'draft-invalid', chatId: 777, reason: 'size' });
});

test('a video_note (circular video) becomes a video draft too', () => {
  const updates = [{ update_id: 140, message: { message_id: 9, chat: { id: 777, type: 'private' },
    from: { first_name: 'Marta' }, video_note: { file_id: 'VN', duration: 8, file_size: 512 * 1024 } } }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'draft');
  assert.equal(actions[0].video, true);
  assert.equal(actions[0].fileId, 'VN');
});

test('risaEntry carries the video mark for the web filter', () => {
  const plain = risaEntry({ id: 'b_1', name: 'A', src: 'https://x/a.mp3', when: '2026-01-01' });
  assert.equal(plain.video, undefined);
  const clip = risaEntry({ id: 'b_2', name: 'A', src: 'https://x/a.mp4', when: '2026-01-01', video: true });
  assert.equal(clip.video, true);
  assert.equal(clip.src.endsWith('.mp4'), true);
});

test('the telegram username rides into the draft action', () => {
  const updates = [{
    update_id: 12,
    message: { message_id: 6, chat: { id: 888, type: 'private' },
      from: { first_name: 'Yusuf', username: 'yusuf_r' }, voice: { file_id: 'BBB' } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.equal(actions[0].username, 'yusuf_r');
});

test('draft callbacks from a private chat are parsed', () => {
  const updates = [
    { update_id: 13, callback_query: { id: 'cb3', data: 'draft:title',
      message: { message_id: 20, chat: { id: 777, type: 'private' } }, from: { id: 777 } } },
    { update_id: 14, callback_query: { id: 'cb4', data: 'draft:id:anon',
      message: { message_id: 21, chat: { id: 777, type: 'private' } }, from: { id: 777 } } },
    { update_id: 15, callback_query: { id: 'cb5', data: 'draft:send',
      message: { message_id: 22, chat: { id: 777, type: 'private' } }, from: { id: 777 } } },
  ];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 16);
  assert.deepEqual(actions[0], { kind: 'draft-title', chatId: 777, callbackId: 'cb3', draftMsgId: 20 });
  assert.deepEqual(actions[1], { kind: 'draft-id', chatId: 777, callbackId: 'cb4', draftMsgId: 21, mode: 'anon' });
  assert.deepEqual(actions[2], { kind: 'draft-send', chatId: 777, callbackId: 'cb5', draftMsgId: 22 });
});

test('tags and identity callbacks parse into their actions', () => {
  const mk = (cb, mid) => ({ update_id: mid, callback_query: { id: 'cb' + mid, data: cb,
    message: { message_id: 100 + mid, chat: { id: 777, type: 'private' } }, from: { id: 777 } } });
  const { actions } = parseUpdates([
    mk('draft:tags', 1),
    mk('draft:tags-done', 2),
    mk('draft:id:tg', 3),
    mk('draft:id:name', 4),
    mk('draft:id:anon', 5)
  ], CTX);
  assert.deepEqual(actions[0], { kind: 'draft-tags', chatId: 777, callbackId: 'cb1', draftMsgId: 101 });
  assert.deepEqual(actions[1], { kind: 'draft-tags-done', chatId: 777, callbackId: 'cb2', draftMsgId: 102 });
  assert.deepEqual(actions[2], { kind: 'draft-id', chatId: 777, callbackId: 'cb3', draftMsgId: 103, mode: 'tg' });
  assert.deepEqual(actions[3], { kind: 'draft-id', chatId: 777, callbackId: 'cb4', draftMsgId: 104, mode: 'name' });
  assert.deepEqual(actions[4], { kind: 'draft-id', chatId: 777, callbackId: 'cb5', draftMsgId: 105, mode: 'anon' });
});

test('alias callbacks parse (draft:aliases, draft:alias:<name>, draft:alias-new)', () => {
  const mk = (cb, mid) => ({ update_id: mid, callback_query: { id: 'cb' + mid, data: cb,
    message: { message_id: 200 + mid, chat: { id: 777, type: 'private' } }, from: { id: 777 } } });
  const { actions } = parseUpdates([
    mk('draft:aliases', 1),
    mk('draft:alias:Marc', 2),
    mk('draft:alias-new', 3)
  ], CTX);
  assert.deepEqual(actions[0], { kind: 'draft-aliases', chatId: 777, callbackId: 'cb1', draftMsgId: 201 });
  assert.deepEqual(actions[1], { kind: 'draft-alias', chatId: 777, callbackId: 'cb2', draftMsgId: 202, mode: 'Marc' });
  assert.deepEqual(actions[2], { kind: 'draft-alias-new', chatId: 777, callbackId: 'cb3', draftMsgId: 203 });
});

test('a private text while awaiting a new alias becomes draft-alias-new-text', () => {
  const ctx = { modGroupId: -1001234, awaitingAlias: { '777': true } };
  const updates = [{ update_id: 145, message: { message_id: 4, chat: { id: 777, type: 'private' },
    text: 'Risalog' } }];
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'draft-alias-new-text', chatId: 777, text: 'Risalog' });
});

test('unknown draft callbacks are ignored', () => {
  const updates = [{
    update_id: 6,
    callback_query: { id: 'cbx', data: 'draft:nope',
      message: { message_id: 1, chat: { id: 777, type: 'private' } }, from: { id: 777 } }
  }];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 0);
  assert.equal(offset, 7);
});

test('draft callbacks from another user or the mod group are ignored', () => {
  const updates = [
    { update_id: 16, callback_query: { id: 'cb6', data: 'draft:send',
      message: { message_id: 23, chat: { id: 777, type: 'private' } }, from: { id: 999 } } },
    { update_id: 17, callback_query: { id: 'cb7', data: 'draft:send',
      message: { message_id: 24, chat: { id: -1001234 } } } },
  ];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 0);
  assert.equal(offset, 18);
});

test('a text reply while awaiting a title becomes a draft-title-text action', () => {
  const updates = [{
    update_id: 18,
    message: { message_id: 9, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: 'la de la boda' }
  }];
  const ctx = { modGroupId: -1001234, awaitingTitle: { '777': true } };
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'draft-title-text', chatId: 777, title: 'la de la boda' });
});

test('plain text without awaiting input triggers the welcome message', () => {
  const updates = [{
    update_id: 19,
    message: { message_id: 10, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: 'hola' }
  }];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 20);
  assert.deepEqual(actions[0], { kind: 'welcome', chatId: 777 });
});

test('/start also triggers the welcome message', () => {
  const updates = [{
    update_id: 22,
    message: { message_id: 11, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: '/start' }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.deepEqual(actions[0], { kind: 'welcome', chatId: 777 });
});

test('a text reply while awaiting tags becomes a draft-tags-text action', () => {
  const updates = [{
    update_id: 24,
    message: { message_id: 12, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: 'loca, de grupo' }
  }];
  const ctx = { modGroupId: -1001234, awaitingTags: { '777': true } };
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'draft-tags-text', chatId: 777, tagsText: 'loca, de grupo' });
});

test('awaiting title takes precedence over awaiting tags', () => {
  const updates = [{
    update_id: 26,
    message: { message_id: 13, chat: { id: 777, type: 'private' },
      from: { first_name: 'Marta' }, text: 'el título' }
  }];
  const ctx = { modGroupId: -1001234, awaitingTitle: { '777': true }, awaitingTags: { '777': true } };
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'draft-title-text', chatId: 777, title: 'el título' });
});

test('approve/reject callbacks from the mod group are parsed', () => {
  const updates = [
    { update_id: 20, callback_query: { id: 'cb1', data: 'ok:q_10',
      message: { message_id: 99, chat: { id: -1001234 } } } },
    { update_id: 21, callback_query: { id: 'cb2', data: 'no:q_12',
      message: { message_id: 98, chat: { id: -1001234 } } } },
  ];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 22);
  assert.deepEqual(actions[0], { kind:'approve', id:'q_10', callbackId:'cb1', modMsgId:99 });
  assert.deepEqual(actions[1], { kind:'reject',  id:'q_12', callbackId:'cb2', modMsgId:98 });
});

test('callbacks from other chats are ignored; private text becomes a welcome', () => {
  const updates = [
    { update_id: 30, callback_query: { id:'x', data:'ok:q_1', message:{ message_id:1, chat:{ id: 999 } } } },
    { update_id: 31, message: { message_id: 7, chat:{ id: 5, type:'private' }, from:{ first_name:'A' }, text: 'hola' } },
  ];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 32);
  assert.deepEqual(actions, [{ kind: 'welcome', chatId: 5 }]);
});

test('a reply to a mod message approves/rejects via text', () => {
  const ctx = { modGroupId: -1001234, modMsgToId: { 42: 'q_10', 43: 'q_12' } };
  const updates = [
    { update_id: 40, message: { message_id: 1, chat: { id: -1001234 },
      from: { first_name: 'Mod' }, text: 'ok',
      reply_to_message: { message_id: 42 } } },
    { update_id: 41, message: { message_id: 2, chat: { id: -1001234 },
      from: { first_name: 'Mod' }, text: 'borrar',
      reply_to_message: { message_id: 43 } } },
  ];
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'approve', id: 'q_10', modMsgId: 42, via: 'reply' });
  assert.deepEqual(actions[1], { kind: 'reject', id: 'q_12', modMsgId: 43, via: 'reply' });
});

test('a reply to an unknown mod message or with unrelated text is ignored', () => {
  const ctx = { modGroupId: -1001234, modMsgToId: { 42: 'q_10' } };
  const updates = [
    { update_id: 50, message: { message_id: 1, chat: { id: -1001234 }, text: 'ok',
      reply_to_message: { message_id: 999 } } },
    { update_id: 51, message: { message_id: 2, chat: { id: -1001234 }, text: 'qué bien',
      reply_to_message: { message_id: 42 } } },
  ];
  const { actions, offset } = parseUpdates(updates, ctx);
  assert.equal(actions.length, 0);
  assert.equal(offset, 52);
});

test('empty batch keeps the current offset', () => {
  assert.deepEqual(parseUpdates([], CTX, 500), { actions: [], offset: 500 });
});

test('/name and /pub in a private chat become rename/tgpub-ask commands', () => {
  const updates = [
    { update_id: 60, message: { message_id: 1, chat: { id: 777, type: 'private' }, text: '/name Marta 2' } },
    { update_id: 61, message: { message_id: 2, chat: { id: 777, type: 'private' }, text: '/pub' } },
  ];
  const { actions } = parseUpdates(updates, CTX);
  assert.deepEqual(actions[0], { kind: 'rename', chatId: 777, name: 'Marta 2' });
  assert.deepEqual(actions[1], { kind: 'tgpub-ask', chatId: 777 });
});

test('/name without a value falls back to welcome-free ignore: handled as empty rename', () => {
  const { actions } = parseUpdates([
    { update_id: 62, message: { message_id: 3, chat: { id: 777, type: 'private' }, text: '/name' } },
  ], CTX);
  assert.deepEqual(actions[0], { kind: 'rename', chatId: 777, name: '' });
});

test('tgpub callbacks parse with the username', () => {
  const mk = (data, id) => ({ update_id: id, callback_query: { id: 'c' + id, data,
    message: { message_id: 40 + id, chat: { id: 777, type: 'private' } },
    from: { id: 777, username: 'mar' } } });
  const { actions } = parseUpdates([mk('tgpub:yes', 1), mk('tgpub:no', 2)], CTX);
  assert.deepEqual(actions[0], { kind: 'tgpub-yes', chatId: 777, callbackId: 'c1', username: 'mar' });
  assert.deepEqual(actions[1], { kind: 'tgpub-no', chatId: 777, callbackId: 'c2', username: 'mar' });
});

test('suboffer callbacks (Sí quiero / No sé / No, seguro) parse', () => {
  const mk = (data, id) => ({ update_id: id, callback_query: { id: 'c' + id, data,
    message: { message_id: 40 + id, chat: { id: 777, type: 'private' } },
    from: { id: 777, username: 'mar' } } });
  const { actions } = parseUpdates([
    mk('suboffer:yes', 1), mk('suboffer:maybe', 2), mk('suboffer:never', 3)
  ], CTX);
  assert.deepEqual(actions[0], { kind: 'suboffer-yes', chatId: 777, callbackId: 'c1', msgId: 41, username: 'mar' });
  assert.deepEqual(actions[1], { kind: 'suboffer-maybe', chatId: 777, callbackId: 'c2', msgId: 42, username: 'mar' });
  assert.deepEqual(actions[2], { kind: 'suboffer-never', chatId: 777, callbackId: 'c3', msgId: 43, username: 'mar' });
});

test('subedit (and its cancel) parse from a private chat', () => {
  const mk = (data, id) => ({ update_id: id, callback_query: { id: 'c' + id, data,
    message: { message_id: 40 + id, chat: { id: 777, type: 'private' } }, from: { id: 777 } } });
  const { actions } = parseUpdates([mk('subedit', 1), mk('subedit:cancel', 2)], CTX);
  assert.deepEqual(actions[0], { kind: 'subedit', chatId: 777, callbackId: 'c1' });
  assert.deepEqual(actions[1], { kind: 'subedit-cancel', chatId: 777, callbackId: 'c2' });
});

test('a private text while awaiting a subdomain rename becomes subedit-text', () => {
  const ctx = { modGroupId: -1001234, awaitingSubedit: { '777': true } };
  const updates = [{ update_id: 95, message: { message_id: 3, chat: { id: 777, type: 'private' },
    text: 'mar_risa' } }];
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'subedit-text', chatId: 777, text: 'mar_risa' });
});

test('entrar callbacks parse from a private chat', () => {
  const mk = (data, id) => ({ update_id: id, callback_query: { id: 'c' + id, data,
    message: { message_id: 40 + id, chat: { id: 777, type: 'private' } }, from: { id: 777 } } });
  const { actions } = parseUpdates([mk('entrar:claim', 1), mk('entrar:miniapp', 2)], CTX);
  assert.deepEqual(actions.map((a) => a.kind), ['entrar-claim', 'entrar-miniapp']);
  assert.deepEqual(actions[0], { kind: 'entrar-claim', chatId: 777, callbackId: 'c1' });
});

test('moderator edit callbacks in the mod group are parsed', () => {
  const updates = [
    { update_id: 80, callback_query: { id: 'cb1', data: 'edit:q_10',
      message: { message_id: 50, chat: { id: -1001234 } } } },
    { update_id: 81, callback_query: { id: 'cb2', data: 'edit-send:q_10',
      message: { message_id: 50, chat: { id: -1001234 } } } },
    { update_id: 82, callback_query: { id: 'cb3', data: 'edit-cancel:q_10',
      message: { message_id: 50, chat: { id: -1001234 } } } },
  ];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 83);
  assert.deepEqual(actions[0], { kind: 'mod-edit', id: 'q_10', callbackId: 'cb1', modMsgId: 50 });
  assert.deepEqual(actions[1], { kind: 'mod-edit-send', id: 'q_10', callbackId: 'cb2', modMsgId: 50 });
  assert.deepEqual(actions[2], { kind: 'mod-edit-cancel', id: 'q_10', callbackId: 'cb3', modMsgId: 50 });
});

test('a mod group text becomes edit details while an entry is being edited', () => {
  const ctx = { modGroupId: -1001234, awaitingModEdit: { q_10: true } };
  const updates = [{
    update_id: 90,
    message: { message_id: 3, chat: { id: -1001234 }, from: { first_name: 'Mod' },
      text: 'de la boda | loca, café | Marta' }
  }];
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0],
    { kind: 'mod-edit-text', id: 'q_10', chatId: -1001234, text: 'de la boda | loca, café | Marta' });
});

test('a decision reply still wins over awaiting edit text', () => {
  const ctx = { modGroupId: -1001234, modMsgToId: { 42: 'q_10' }, awaitingModEdit: { q_10: true } };
  const updates = [{ update_id: 91, message: { message_id: 3, chat: { id: -1001234 },
    text: 'ok', reply_to_message: { message_id: 42 } } }];
  const { actions } = parseUpdates(updates, ctx);
  assert.deepEqual(actions[0], { kind: 'approve', id: 'q_10', modMsgId: 42, via: 'reply' });
});

test('plain mod group text without edit context is ignored', () => {
  const updates = [{ update_id: 92, message: { message_id: 3, chat: { id: -1001234 },
    text: 'de la boda' } }];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(actions.length, 0);
  assert.equal(offset, 93);
});

test('accept/reject-edit callbacks parse only from the original uploader', () => {
  const mk = (data, id) => ({ update_id: id, callback_query: { id: 'c' + id, data,
    message: { message_id: 60 + id, chat: { id: 777, type: 'private' } }, from: { id: 777 } } });
  const ctx = { modGroupId: -1001234, uploaderOf: { q_10: 777, q_11: 555 } };
  const { actions } = parseUpdates([
    mk('accept:q_10', 1),
    mk('reject-edit:q_10', 2),
    mk('accept:q_11', 3),
    mk('reject-edit:q_999', 4)
  ], ctx);
  assert.deepEqual(actions[0], { kind: 'edit-accept', id: 'q_10', chatId: 777, callbackId: 'c1', msgId: 61 });
  assert.deepEqual(actions[1], { kind: 'edit-reject', id: 'q_10', chatId: 777, callbackId: 'c2', msgId: 62 });
  assert.equal(actions.length, 2);
});

test('read-only commands in a private chat become cmd-* actions', () => {
  const mk = (text, id) => ({ update_id: id,
    message: { message_id: id, chat: { id: 777, type: 'private' }, text } });
  const { actions, offset } = parseUpdates([
    mk('/me', 100), mk('/stats', 101), mk('/profile', 102), mk('/status', 103),
    mk('/queue', 104), mk('/latest', 105), mk('/random', 106), mk('/now', 107),
    mk('/since 3', 108), mk('/today', 109), mk('/trending', 110), mk('/play', 111),
    mk('/entrar', 112), mk('/mejorar', 113),
  ], CTX);
  assert.equal(offset, 114);
  assert.deepEqual(actions.map((a) => a.kind), [
    'cmd-me', 'cmd-stats', 'cmd-profile', 'cmd-status', 'cmd-queue',
    'cmd-latest', 'cmd-random', 'cmd-now', 'cmd-since', 'cmd-today',
    'cmd-trending', 'cmd-play', 'cmd-entrar', 'cmd-mejorar'
  ]);
  assert.equal(actions[8].arg, '3');
  assert.deepEqual(actions[2], { kind: 'cmd-profile', chatId: 777, arg: '' });
});

test('/profile with a name passes it as arg; unknown commands stay welcome', () => {
  const mk = (text, id) => ({ update_id: id,
    message: { message_id: id, chat: { id: 777, type: 'private' }, text } });
  const { actions } = parseUpdates([
    mk('/profile Marta', 120), mk('/since', 121), mk('/mute', 122)
  ], CTX);
  assert.deepEqual(actions[0], { kind: 'cmd-profile', chatId: 777, arg: 'Marta' });
  assert.deepEqual(actions[1], { kind: 'cmd-since', chatId: 777, arg: '' });
  assert.deepEqual(actions[2], { kind: 'welcome', chatId: 777 });
});

const BANCO = [
  { id: 'a', name: 'Marta', key: 'K1', t: 'De la boda', tags: 'loca, café', when: '2026-08-16', src: 'https://x/a.mp3' },
  { id: 'b', name: 'Marta', key: 'K1', t: 'El lunes', tags: 'loca', when: '2026-08-15', src: 'https://x/b.mp3' },
  { id: 'c', name: 'Luis', key: 'K2', t: 'Risa rota', tags: 'café', when: '2026-08-10', src: 'https://x/c.mp3' },
  { id: 'd', name: 'Ana', key: 'K3', t: 'En el parque', tags: 'libre', when: '2026-07-01', src: 'https://x/d.mp3' },
];

test('latestClips keeps newest-first and respects the limit', () => {
  assert.deepEqual(latestClips(BANCO, 2).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(latestClips(BANCO).map((e) => e.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(latestClips(undefined, 3), []);
});

test('clipsOfAuthor filters by author key, newest-first', () => {
  assert.deepEqual(clipsOfAuthor(BANCO, 'K1').map((e) => e.id), ['a', 'b']);
  assert.deepEqual(clipsOfAuthor(BANCO, 'nobody'), []);
});

test('clipsToday matches the ISO date exactly', () => {
  assert.deepEqual(clipsToday(BANCO, '2026-08-16').map((e) => e.id), ['a']);
  assert.deepEqual(clipsToday(BANCO, '2020-01-01'), []);
});

test('clipsSince includes today and counts back N days', () => {
  assert.deepEqual(clipsSince(BANCO, 1, '2026-08-16').map((e) => e.id), ['a']);
  assert.deepEqual(clipsSince(BANCO, 2, '2026-08-16').map((e) => e.id), ['a', 'b']);
  assert.deepEqual(clipsSince(BANCO, 7, '2026-08-16').map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(clipsSince(BANCO, 90, '2026-08-16').length, BANCO.length);
});

test('randomClip returns a member of the risas or undefined when empty', () => {
  const got = randomClip(BANCO);
  assert.ok(BANCO.includes(got));
  assert.equal(randomClip([]), undefined);
  assert.equal(randomClip(undefined), undefined);
});

test('tagTrend counts and sorts tags by frequency over recent clips', () => {
  assert.deepEqual(tagTrend(BANCO, 2), [
    { tag: 'loca', count: 2 }, { tag: 'café', count: 1 }
  ]);
  assert.deepEqual(tagTrend(BANCO, 50), [
    { tag: 'loca', count: 2 }, { tag: 'café', count: 2 },
    { tag: 'libre', count: 1 }
  ]);
  assert.deepEqual(tagTrend([], 10), []);
});

test('authorStats counts published and pending per key', () => {
  const queue = { q1: { uploader: 'K1', title: 'Nueva' }, q2: { uploader: 'K2', title: 'Otra' } };
  assert.deepEqual(authorStats(BANCO, queue, 'K1'), { key: 'K1', published: 2, pending: 1 });
  assert.deepEqual(authorStats(BANCO, queue, 'nobody'), { key: 'nobody', published: 0, pending: 0 });
  assert.deepEqual(authorStats(BANCO, undefined, 'K1').published, 2);
});

// ---- Inline mode tests ----

test('inline_query update becomes an inline-search action', () => {
  const updates = [{
    update_id: 200,
    inline_query: { id: 'iq1', query: 'café', from: { id: 777 } }
  }];
  const { actions, offset } = parseUpdates(updates, CTX);
  assert.equal(offset, 201);
  assert.deepEqual(actions[0], { kind: 'inline-search', queryId: 'iq1', query: 'café', userId: 777 });
});

test('empty inline query parses correctly', () => {
  const updates = [{
    update_id: 201,
    inline_query: { id: 'iq2', query: '', from: { id: 888 } }
  }];
  const { actions } = parseUpdates(updates, CTX);
  assert.deepEqual(actions[0], { kind: 'inline-search', queryId: 'iq2', query: '', userId: 888 });
});

test('searchClips returns latest when query is empty', () => {
  const results = searchClips(BANCO, '', 3);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((e) => e.id), ['a', 'b', 'c']);
});

test('searchClips filters by title', () => {
  const results = searchClips(BANCO, 'boda');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

test('searchClips filters by tags (case-insensitive)', () => {
  const results = searchClips(BANCO, 'café');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((e) => e.id), ['a', 'c']);
});

test('searchClips filters by author name', () => {
  const results = searchClips(BANCO, 'luis');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'c');
});

test('searchClips respects the limit', () => {
  const results = searchClips(BANCO, '', 2);
  assert.equal(results.length, 2);
});

test('searchClips returns empty array when nothing matches', () => {
  const results = searchClips(BANCO, 'xyz');
  assert.equal(results.length, 0);
});

test('searchClips handles undefined/empty banco', () => {
  assert.deepEqual(searchClips(undefined, 'test'), []);
  assert.deepEqual(searchClips([], 'test'), []);
});

test('inlineResult formats a clip as InlineQueryResultAudio', () => {
  const clip = BANCO[0];
  const result = inlineResult(clip);
  assert.equal(result.type, 'audio');
  assert.equal(result.id, 'a');
  assert.equal(result.audio_url, 'https://x/a.mp3');
  assert.equal(result.title, 'De la boda');
  assert.equal(result.performer, 'Marta');
  assert.ok(result.caption.includes('loca'));
  assert.equal(result.description, 'loca, café');
});


test('claim token is stable per key+clip, salted, and hashes to the feed claim', () => {
  const token = claimTokenOf('key-a', 'q_1', 'secret');
  assert.equal(token, claimTokenOf('key-a', 'q_1', 'secret'));
  assert.notEqual(token, claimTokenOf('key-b', 'q_1', 'secret'));
  assert.notEqual(token, claimTokenOf('key-a', 'q_2', 'secret'));
  assert.notEqual(token, claimTokenOf('key-a', 'q_1', 'other'));
  const hash = claimHashOf(token);
  assert.equal(hash.length, 64);
  assert.equal(hash, claimHashOf(token));
  const entry = risaEntry({ id: 'q_1', name: 'A', src: 'x', when: 'now', key: 'key-a', claim: hash });
  assert.equal(entry.claim, hash);
  assert.equal(entry.key, 'key-a');
  assert.ok(!JSON.stringify(entry).includes(token));
});
