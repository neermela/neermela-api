// Applies db/schema.sql. Run: npm run migrate
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '../../db/schema.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('✓ Schema applied.');
  process.exit(0);
} catch (e) {
  console.error('✗ Migration failed:', e.message);
  process.exit(1);
}
