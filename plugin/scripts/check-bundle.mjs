// Static release check, not a replacement for Even Hub's runtime permission check.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(process.argv[2] ?? join(root, 'dist'));
const manifest = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
const origins = manifest.permissions
  .filter((permission) => permission.name === 'network')
  .flatMap((permission) => permission.whitelist);

// A scheme prefix alone is not a destination. Include template substitutions so the
// v0.3.1 rejection (http://${t}) fails locally even though it is not a real origin.
const urls = /https?:\/\/[^\s"'`<>\\]+/g;
let checked = 0;
const failures = [];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (['.js', '.css', '.html'].includes(extname(entry.name))) {
      checked++;
      for (const [url] of readFileSync(path, 'utf8').matchAll(urls)) {
        if (!origins.some((origin) => url === origin || url.startsWith(origin + '/') ||
          url.startsWith(origin + '?') || url.startsWith(origin + '#'))) {
          failures.push(`${path}: ${url}`);
        }
      }
    }
  }
}

// Fail on a missing entrypoint or missing build output, too.
readFileSync(join(dist, manifest.entrypoint));
scan(dist);
if (failures.length) throw new Error(`Bundle URLs outside network.whitelist:\n${failures.join('\n')}`);
console.log(`Bundle URL check passed (${checked} files; static literals only).`);
