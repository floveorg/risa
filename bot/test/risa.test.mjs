import { test } from 'node:test';
import assert from 'node:assert/strict';
import { risaEntry, prependClip } from '../logic.mjs';

const SRC = 'https://pub-e3cbc6c5f1c945358670af27745479f1.r2.dev/risa/q_10.mp3';

test('risaEntry keeps name + given src (no by field)', () => {
  const e = risaEntry({ id: 'q_10', name: 'Marta', tags: 'de grupo', when: '2026-07-19', src: SRC });
  assert.deepEqual(e, {
    id: 'q_10', name: 'Marta',
    src: SRC,
    tags: 'de grupo', when: '2026-07-19'
  });
  assert.equal('by' in e, false);
});

test('risaEntry omits tags when empty', () => {
  const e = risaEntry({ id: 'q_11', name: 'Yusuf', tags: '', when: '2026-07-19', src: SRC });
  assert.equal('tags' in e, false);
});

test('risaEntry keeps the title t when given', () => {
  const e = risaEntry({ id: 'q_12', name: 'Yusuf', t: 'de vientre', when: '2026-07-19', src: SRC });
  assert.equal(e.t, 'de vientre');
});

test('risaEntry keeps title t AND tags together', () => {
  const e = risaEntry({ id: 'q_13', name: 'Marta', t: 'la de la boda', tags: 'loca, grupo',
    when: '2026-07-19', src: SRC });
  assert.equal(e.t, 'la de la boda');
  assert.equal(e.tags, 'loca, grupo');
});

test('risaEntry keeps the tg link only when opted in', () => {
  const e = risaEntry({ id: 'q_14', name: 'Marta', when: '2026-08-13', src: SRC, tg: '@mar' });
  assert.equal(e.tg, '@mar');
  const e2 = risaEntry({ id: 'q_15', name: 'Marta', when: '2026-08-13', src: SRC });
  assert.equal(e2.tg, undefined);
});

test('prependClip puts the new risa first and does not mutate input', () => {
  const risas = [{ id: 'old' }];
  const out = prependClip(risas, { id: 'new' });
  assert.deepEqual(out.map(x => x.id), ['new', 'old']);
  assert.deepEqual(risas.map(x => x.id), ['old']); // unchanged
});
