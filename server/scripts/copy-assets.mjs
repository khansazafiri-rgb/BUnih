import fs from 'node:fs';
import path from 'node:path';

const src = path.join('src', 'db', 'migrations');
const dest = path.join('dist', 'db', 'migrations');
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  n += 1;
}
console.log(`[build] ${n} file migrasi dikopi ke dist.`);
