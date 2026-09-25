import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicFiles, build } from '../build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('uploads exactly what the Node server serves: client, sim, ai, contracts, three.js', () => {
  const urls = publicFiles().map(([u]) => u);
  for (const must of ['/services/client/index.html', '/services/client/js/main.js', '/services/sim/index.js', '/services/sim/predict.js',
    '/services/ai/bot.js', '/contracts/protocol.js', '/node_modules/three/build/three.module.js']) {
    assert.ok(urls.includes(must), `${must} is served`);
  }
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
});

test('never uploads tests, server source, secrets or git', () => {
  const urls = publicFiles().map(([u]) => u);
  assert.ok(existsSync(path.join(ROOT, 'services/sim/test')), 'the sim has tests on disk to leave out');
  assert.equal(urls.filter((u) => u.split('/').includes('test')).length, 0);
  for (const bad of ['/services/server/', '/services/edge/', '/evals/', '/scripts/', '/.env', '/.git/', '/package.json']) {
    assert.equal(urls.filter((u) => u.startsWith(bad)).length, 0, `${bad} stays private`);
  }
});

test('build writes the tree and serves the client page at /', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'edge-build-'));
  try {
    const n = build(out);
    assert.equal(n, publicFiles().length + 1);
    assert.deepEqual(readFileSync(path.join(out, 'index.html')), readFileSync(path.join(ROOT, 'services/client/index.html')));
    assert.ok(existsSync(path.join(out, 'services/sim/index.js')));
    assert.ok(!existsSync(path.join(out, 'services/sim/test')));
    assert.deepEqual(readdirSync(out).sort(), ['contracts', 'index.html', 'node_modules', 'services']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('rebuild syncs in place: stale files go, changed files are refreshed, the folder itself stays', () => {
  // The folder is never removed because a running `wrangler dev` watches it (EBUSY on Windows).
  const out = mkdtempSync(path.join(tmpdir(), 'edge-build-'));
  try {
    build(out);
    writeFileSync(path.join(out, 'services/sim/old-module.js'), 'stale');
    writeFileSync(path.join(out, 'contracts/protocol.js'), 'edited since last build');
    build(out);
    assert.ok(!existsSync(path.join(out, 'services/sim/old-module.js')), 'a file removed from the source is removed from the upload');
    assert.deepEqual(readFileSync(path.join(out, 'contracts/protocol.js')), readFileSync(path.join(ROOT, 'contracts/protocol.js')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
