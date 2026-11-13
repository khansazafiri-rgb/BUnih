import { db } from './index.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const applied = migrate(db());
if (applied.length) console.log(`Migrasi diterapkan: ${applied.join(', ')}`);
else console.log('Tidak ada migrasi baru.');

const result = seed(db());
console.log(`Seed: ${JSON.stringify(result)}`);
