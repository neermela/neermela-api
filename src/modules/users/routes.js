// User API (spec §11).
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ok, Errors } from '../../gateway/respond.js';
import { requireAuth } from '../../gateway/middleware.js';
import { publicUser } from '../auth/service.js';
import * as kyc from './kyc.js';

const r = Router();

// KYC — submit identity, check status (spec §11, §67)
r.post('/kyc', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({
      doc_type: z.enum(['nid', 'passport', 'driving', 'birth']),
      doc_number: z.string().min(5),
      full_name: z.string().max(120).optional(),
      date_of_birth: z.string().optional(),
      gender: z.enum(['male', 'female', 'other']).optional(),
      country: z.string().max(40).optional(),
      email: z.string().email().optional(),
      address: z.string().max(200).optional(),
      is_expat: z.boolean().optional(),
      residence_country: z.string().max(40).optional(),
      doc_front_media: z.string().optional(), doc_back_media: z.string().optional(), selfie_media: z.string().optional(),
    }).parse(req.body);
    ok(res, await kyc.submitKyc(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Check your KYC details.', e.issues) : e); }
});
r.get('/kyc', requireAuth, async (req, res, next) => {
  try { ok(res, await kyc.getKyc(req.auth.userId)); } catch (e) { next(e); }
});

// Lightweight user lookup so clients can start a chat (§11/§44-lite).
// GET /v1/users?q=<username|phone fragment>
r.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 2) return ok(res, { users: [] });
    const { rows } = await query(
      `SELECT * FROM users.users
       WHERE (username ILIKE $1 OR phone ILIKE $1 OR display_name ILIKE $1)
         AND user_id <> $2 AND account_status='active'
       ORDER BY updated_at DESC LIMIT 20`,
      [`%${q}%`, req.auth.userId]
    );
    ok(res, { users: rows.map(publicUser) });
  } catch (e) { next(e); }
});

r.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM users.users WHERE user_id=$1', [req.auth.userId]);
    if (!rows[0]) throw Errors.notFound('User not found.');
    ok(res, { user: publicUser(rows[0]) });
  } catch (e) { next(e); }
});

const patchSchema = z.object({
  display_name: z.string().min(1).max(80).optional(),
  username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/).optional(),
  bio: z.string().max(200).optional(),
  country: z.string().max(2).optional(),
  profile_photo: z.string().url().optional(),
  language: z.enum(['bn', 'en', 'ar']).optional(),
}).strict();

r.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const p = patchSchema.parse(req.body);
    const keys = Object.keys(p);
    if (!keys.length) return ok(res, {});
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    const values = keys.map((k) => p[k]);
    const { rows } = await query(
      `UPDATE users.users SET ${sets}, updated_at=now() WHERE user_id=$1 RETURNING *`,
      [req.auth.userId, ...values]
    );
    ok(res, { user: publicUser(rows[0]) });
  } catch (e) { next(e?.issues ? Errors.validation('Invalid profile fields.', e.issues) : e); }
});

r.get('/:userId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM users.users WHERE user_id=$1 OR username=$2', [req.params.userId, req.params.userId.replace(/^@/, '')]);
    if (!rows[0]) throw Errors.notFound('User not found.');
    ok(res, { user: publicUser(rows[0]) });
  } catch (e) { next(e); }
});

r.delete('/me', requireAuth, async (req, res, next) => {
  try {
    // Soft-delete + schedule purge per retention policy (spec §67).
    await query(`UPDATE users.users SET account_status='deletion_scheduled', updated_at=now() WHERE user_id=$1`, [req.auth.userId]);
    await query(`UPDATE auth.sessions SET status='revoked' WHERE user_id=$1`, [req.auth.userId]);
    ok(res, { scheduled: true });
  } catch (e) { next(e); }
});

export default r;
