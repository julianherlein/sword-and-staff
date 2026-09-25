// Stage the static files Cloudflare serves into services/edge/dist/.
// The set is exactly what the Node server serves: same roots (PUBLIC), same filter (resolvePublic),
// so test folders, server source, .env and .git can never be uploaded. `/` serves the client page.
// Wrangler runs this before `wrangler dev` and `wrangler deploy` (see [build] in wrangler.toml).
import { readdirSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC, resolvePublic } from '../server/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// Every file under the public roots that the Node server would answer, as [urlPath, absPath].
export function publicFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}${ent.name}`;
      if (ent.isDirectory()) walk(`${child}/`);
      else if (resolvePublic(`/${child}`)) out.push([`/${child}`, path.join(root, child)]);
    }
  };
  for (const dir of PUBLIC) walk(dir);
  return out;
}

// Every file under dir, relative, with forward slashes.
function listTree(dir, rel = '') {
  if (!existsSync(path.join(dir, rel))) return [];
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((ent) => {
    const child = rel ? `${rel}/${ent.name}` : ent.name;
    return ent.isDirectory() ? listTree(dir, child) : [child];
  });
}

// Syncs in place rather than wiping outDir: a running `wrangler dev` watches it, and on Windows a
// watched directory cannot be removed (EBUSY). Changed files are copied, stale ones deleted.
export function build(outDir = path.join(HERE, 'dist')) {
  const files = publicFiles();
  files.push(['/index.html', resolvePublic('/')]); // `/` -> the client page, as on the Node server
  const wanted = new Set(files.map(([url]) => url.slice(1)));
  for (const rel of listTree(outDir)) if (!wanted.has(rel)) rmSync(path.join(outDir, rel));
  for (const [url, abs] of files) {
    const dest = path.join(outDir, url);
    if (existsSync(dest) && readFileSync(dest).equals(readFileSync(abs))) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  }
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`edge build: ${build()} files -> services/edge/dist/`);
}
