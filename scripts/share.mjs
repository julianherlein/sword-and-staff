// npm run share: start the game server and a Cloudflare quick tunnel, print the public link.
// Anyone on the internet can open the link and play online with you. No account, no router setup.
// Usage: npm run share [-- --port 8080]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from '../services/server/index.js';
import { extractTunnelUrl, findCloudflared, INSTALL_HINT } from './share-lib.mjs';

const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT) || 8080;

const bin = findCloudflared({ exists: existsSync });
if (!bin) {
  console.error(`cloudflared is not installed. Install it with:\n  ${INSTALL_HINT[process.platform] || INSTALL_HINT.linux}`);
  process.exit(1);
}

const { server } = createServer();
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is busy. Stop the other server or use: npm run share -- --port 8081` : err.message);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Game server on http://localhost:${port}. Opening tunnel...`);
  const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let announced = false;
  let log = '';
  const onData = (chunk) => {
    log = (log + chunk.toString()).slice(-4000);
    const url = !announced && extractTunnelUrl(log);
    if (url) {
      announced = true;
      console.log(`Tunnel created: ${url}\nWaiting for it to go live (usually 10-40s)...`);
      waitUntilLive(url);
    }
  };
  // A fresh quick-tunnel hostname takes a few seconds to exist in DNS. Asking too early makes the
  // local resolver cache "not found", so give it a head start, then poll until the game answers.
  async function waitUntilLive(url) {
    await new Promise((r) => setTimeout(r, 8000));
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          console.log('\n  READY. Share this link with your opponent:\n');
          console.log(`    ${url}\n`);
          console.log('  Both of you open it, pick Online, one hosts and the other joins with the room code.');
          console.log('  The link works until you stop this command (Ctrl+C). It changes every run.\n');
          return;
        }
      } catch { /* not in DNS yet */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`\n  The link did not answer from this machine within 90s. It may still work for others:\n    ${url}\n`);
  }
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  const timer = setTimeout(() => {
    if (!announced) console.error(`No tunnel link after 30s. cloudflared said:\n${log}`);
  }, 30000);
  tunnel.on('exit', (code) => {
    clearTimeout(timer);
    console.error(`cloudflared exited (code ${code}).${announced ? '' : `\n${log}`}`);
    server.close();
    process.exit(code || 1);
  });
  const stop = () => { tunnel.kill(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
