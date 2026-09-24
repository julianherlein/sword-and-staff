// Pure helpers for scripts/share.mjs, kept separate so they are unit-testable.
import path from 'node:path';

// The API host shows up in error messages ("failed to request tunnel from api.trycloudflare.com").
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

// cloudflared prints the quick-tunnel address somewhere in its log output.
export function extractTunnelUrl(text) {
  const m = TUNNEL_URL.exec(text);
  return m ? m[0] : null;
}

// Find the cloudflared binary: explicit env var, then PATH, then the usual install folders
// (winget/MSI installs are not on PATH until a new terminal is opened).
export function findCloudflared({ env = process.env, platform = process.platform, exists }) {
  if (env.CLOUDFLARED && exists(env.CLOUDFLARED)) return env.CLOUDFLARED;
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of (env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    const p = join(dir, exe);
    if (exists(p)) return p;
  }
  const known = platform === 'win32'
    ? ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']
    : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];
  return known.find((p) => exists(p)) || null;
}

export const INSTALL_HINT = {
  win32: 'winget install --id Cloudflare.cloudflared',
  darwin: 'brew install cloudflared',
  linux: 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
};
