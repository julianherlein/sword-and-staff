import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lobbyFor, REGIONS } from '../src/lobby.js';

test('no region: the original object, placed near the first player', () => {
  assert.deepEqual(lobbyFor({}), { name: 'lobby', options: undefined });
  assert.deepEqual(lobbyFor({ LOBBY_REGION: '' }), { name: 'lobby', options: undefined });
});

test('a region names a separate object and passes it as the location hint', () => {
  // Objects never move after creation, so a region change must reach a new object, not the old one.
  assert.deepEqual(lobbyFor({ LOBBY_REGION: 'sam' }), { name: 'lobby-sam', options: { locationHint: 'sam' } });
  const names = new Set(REGIONS.map((r) => lobbyFor({ LOBBY_REGION: r }).name));
  assert.equal(names.size, REGIONS.length);
  assert.ok(!names.has('lobby'));
});

test('a typo fails loudly instead of silently hosting somewhere random', () => {
  assert.throws(() => lobbyFor({ LOBBY_REGION: 'south-america' }), /LOBBY_REGION must be one of/);
});
