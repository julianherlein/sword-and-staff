import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl, findCloudflared } from '../share-lib.mjs';

test('extracts the quick-tunnel URL from cloudflared log output', () => {
  const log = `2026-09-24T23:50:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-24T23:50:03Z INF +--------------------------------------------------------------------------------------------+
2026-09-24T23:50:03Z INF |  https://brave-lion-tiger-sample.trycloudflare.com                                         |
2026-09-24T23:50:03Z INF +--------------------------------------------------------------------------------------------+`;
  assert.equal(extractTunnelUrl(log), 'https://brave-lion-tiger-sample.trycloudflare.com');
});

test('ignores the api hostname and partial output', () => {
  assert.equal(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(extractTunnelUrl('failed to request https://api.trycloudflare.com/tunnel'), null);
  assert.equal(extractTunnelUrl(''), null);
});

test('finds cloudflared: env override, PATH, then install folders', () => {
  const has = (set) => (p) => set.has(p);
  assert.equal(findCloudflared({ env: { CLOUDFLARED: 'D:\\cf.exe' }, platform: 'win32', exists: has(new Set(['D:\\cf.exe'])) }), 'D:\\cf.exe');
  assert.equal(
    findCloudflared({ env: { Path: 'C:\\a;C:\\tools' }, platform: 'win32', exists: has(new Set(['C:\\tools\\cloudflared.exe'])) }),
    'C:\\tools\\cloudflared.exe',
  );
  const msi = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  assert.equal(findCloudflared({ env: { Path: 'C:\\a' }, platform: 'win32', exists: has(new Set([msi])) }), msi);
  assert.equal(findCloudflared({ env: { PATH: '/usr/bin' }, platform: 'linux', exists: has(new Set(['/usr/bin/cloudflared'])) }), '/usr/bin/cloudflared');
  assert.equal(findCloudflared({ env: {}, platform: 'linux', exists: () => false }), null);
});
