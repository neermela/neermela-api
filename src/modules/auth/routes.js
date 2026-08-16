// Auth routes (spec §10). Sensitive endpoints get stricter rate limits.
import { Router } from 'express';
import { z } from 'zod';
import * as auth from './service.js';
import { ok, created, Errors } from '../../gateway/respond.js';
import { rateLimit, requireAuth, idempotency } from '../../gateway/middleware.js';

const r = Router();
const meta = (req) => ({ ip: req.ip, deviceId: req.header('X-Device-Id') || null, userAgent: req.header('User-Agent') || null });

const sendSchema = z.object({
  channel: z.enum(['sms', 'email']),
  phone: z.string().min(6).optional(),
  email: z.string().email().optional(),
  purpose: z.enum(['login', 'verify', 'reset']).default('login'),
});
r.post('/otp/send', rateLimit('otp'), async (req, res, next) => {
  try {
    const p = sendSchema.parse(req.body);
    const out = await auth.sendOtp({ ...p, ...meta(req) });
    // TEST MODE: when OTP_DEBUG_RETURN=true, include the code so login works
    // without a live SMS gateway. Remove this env var once real SMS is wired.
    if (process.env.OTP_DEBUG_RETURN === 'true' && out && out.debug_code) {
      out.dev_code = out.debug_code;
    }
    if (out) delete out.debug_code;
    ok(res, out);
  } catch (e) { next(zodOr(e)); }
});

const verifySchema = z.object({ challenge_id: z.string(), code: z.string().length(6) });
r.post('/otp/verify', rateLimit('login'), idempotency, async (req, res, next) => {
  try {
    const p = verifySchema.parse(req.body);
    const out = await auth.verifyOtp({ challengeId: p.challenge_id, code: p.code, ...meta(req) });
    created(res, out);
  } catch (e) { next(zodOr(e)); }
});

r.post('/refresh', rateLimit('login'), async (req, res, next) => {
  try {
    const rt = z.object({ refresh_token: z.string() }).parse(req.body);
    const out = await auth.refresh({ refreshToken: rt.refresh_token, ...meta(req) });
    ok(res, out);
  } catch (e) { next(zodOr(e)); }
});

r.post('/logout', requireAuth, async (req, res, next) => {
  try { await auth.logout({ sessionId: req.auth.sessionId }); ok(res, { logged_out: true }); }
  catch (e) { next(e); }
});

r.get('/sessions', requireAuth, async (req, res, next) => {
  try { ok(res, { sessions: await auth.listSessions({ userId: req.auth.userId }) }); }
  catch (e) { next(e); }
});

r.delete('/sessions/:sessionId', requireAuth, async (req, res, next) => {
  try { await auth.revokeSession({ userId: req.auth.userId, sessionId: req.params.sessionId }); ok(res, { revoked: true }); }
  catch (e) { next(e); }
});

function zodOr(e) {
  if (e?.issues) return Errors.validation('Invalid request.', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return e;
}

export default r;
