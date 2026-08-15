// Media API (spec §21). Direct-to-storage upload via signed URL. Big files never touch this server.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ok, created, Errors } from '../../gateway/respond.js';
import { requireAuth, requireScope } from '../../gateway/middleware.js';
import { storage } from '../../adapters/storage/index.js';

const r = Router();

const initSchema = z.object({ content_type: z.string(), size: z.number().int().positive().optional(), folder: z.string().default('uploads') });
r.post('/upload/init', requireAuth, requireScope('media:upload'), async (req, res, next) => {
  try {
    const p = initSchema.parse(req.body);
    const out = await storage.createUploadUrl({ contentType: p.content_type, folder: p.folder });
    await query(
      `INSERT INTO media.media (media_id, owner_user_id, storage_key, content_type, status) VALUES ($1,$2,$3,$4,'pending')`,
      [out.mediaId, req.auth.userId, out.key, p.content_type]
    );
    created(res, { media_id: out.mediaId, upload_url: out.uploadUrl, expires_in: out.expiresIn });
  } catch (e) { next(e?.issues ? Errors.validation('Invalid media request.', e.issues) : e); }
});

r.post('/upload/complete', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ media_id: z.string() }).parse(req.body);
    const { rows } = await query(
      `UPDATE media.media SET status='ready', updated_at=now() WHERE media_id=$1 AND owner_user_id=$2 RETURNING *`,
      [p.media_id, req.auth.userId]
    );
    if (!rows[0]) throw Errors.notFound('Media not found.');
    // In production a queue worker (spec §46) transcodes video + generates thumbnails here.
    ok(res, { media_id: rows[0].media_id, url: storage.publicUrl(rows[0].storage_key), status: rows[0].status });
  } catch (e) { next(e); }
});

r.get('/:mediaId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM media.media WHERE media_id=$1', [req.params.mediaId]);
    if (!rows[0]) throw Errors.notFound('Media not found.');
    ok(res, { media_id: rows[0].media_id, url: storage.publicUrl(rows[0].storage_key), content_type: rows[0].content_type, status: rows[0].status });
  } catch (e) { next(e); }
});

export default r;
