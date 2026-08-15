// Health API (spec §57).
import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { redis } from '../../cache/redis.js';

const r = Router();
r.get('/health', (req, res) => res.json({ status: 'healthy', version: '1.0.0' }));
r.get('/version', (req, res) => res.json({ version: '1.0.0', api: 'v1' }));
r.get('/ready', async (req, res) => {
  const checks = { db: 'down', redis: 'down' };
  try { await pool.query('SELECT 1'); checks.db = 'up'; } catch {}
  try { await redis.ping(); checks.redis = 'up'; } catch {}
  const ready = Object.values(checks).every((v) => v === 'up');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
});
export default r;
