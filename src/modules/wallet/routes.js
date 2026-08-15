// Wallet API — closed-loop P2P payments (spec §38 internal wallet layer).
import { Router } from 'express';
import { z } from 'zod';
import * as w from './service.js';
import { ok, created, Errors } from '../../gateway/respond.js';
import { requireAuth, requireScope, idempotency, rateLimit } from '../../gateway/middleware.js';

const r = Router();

r.get('/', requireAuth, async (req, res, next) => {
  try { ok(res, await w.walletView(req.auth.userId)); } catch (e) { next(e); }
});

r.post('/pin', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ old_pin: z.string().optional(), new_pin: z.string() }).parse(req.body);
    ok(res, await w.setPin(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid PIN request.', e.issues) : e); }
});

const transferSchema = z.object({
  to: z.string(),                       // user_id | @username | phone
  amount: z.number().positive(),
  pin: z.string(),
  note: z.string().max(120).optional(),
});
r.post('/transfer', requireAuth, requireScope('messages:write'), rateLimit('payment'), idempotency, async (req, res, next) => {
  try {
    const p = transferSchema.parse(req.body);
    created(res, await w.transfer(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid transfer.', e.issues) : e); }
});

r.get('/transactions', requireAuth, async (req, res, next) => {
  try { ok(res, { transactions: await w.transactions(req.auth.userId, { limit: parseInt(req.query.limit || '30', 10) }) }); }
  catch (e) { next(e); }
});

r.post('/topup', requireAuth, rateLimit('payment'), idempotency, async (req, res, next) => {
  try {
    const p = z.object({ amount: z.number().positive() }).parse(req.body);
    created(res, await w.topupSandbox(req.auth.userId, p.amount));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid amount.', e.issues) : e); }
});

r.post('/request', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ from: z.string(), amount: z.number().positive(), note: z.string().max(120).optional() }).parse(req.body);
    created(res, await w.createRequest(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid request.', e.issues) : e); }
});

r.get('/requests', requireAuth, async (req, res, next) => {
  try { ok(res, { requests: await w.listRequests(req.auth.userId) }); } catch (e) { next(e); }
});

r.post('/requests/:id/pay', requireAuth, rateLimit('payment'), idempotency, async (req, res, next) => {
  try {
    const p = z.object({ pin: z.string() }).parse(req.body);
    created(res, await w.payRequest(req.auth.userId, { request_id: req.params.id, pin: p.pin }));
  } catch (e) { next(e?.issues ? Errors.validation('PIN required.', e.issues) : e); }
});

// QR scan-to-pay
r.get('/paycode', requireAuth, async (req, res, next) => {
  try {
    const amount = req.query.amount ? Number(req.query.amount) : undefined;
    ok(res, await w.createPaycode(req.auth.userId, { amount }));
  } catch (e) { next(e); }
});

r.post('/pay/resolve', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ code: z.string() }).parse(req.body);
    ok(res, await w.resolvePaycode(p.code));
  } catch (e) { next(e?.issues ? Errors.validation('Code required.', e.issues) : e); }
});

r.post('/pay', requireAuth, requireScope('messages:write'), rateLimit('payment'), idempotency, async (req, res, next) => {
  try {
    const p = z.object({ code: z.string(), amount: z.number().positive().optional(), pin: z.string(), note: z.string().max(120).optional() }).parse(req.body);
    created(res, await w.payViaCode(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid payment.', e.issues) : e); }
});

r.post('/cashout', requireAuth, rateLimit('payment'), idempotency, async (req, res, next) => {
  try {
    const p = z.object({ amount: z.number().positive(), pin: z.string(), method: z.string().optional() }).parse(req.body);
    created(res, await w.cashout(req.auth.userId, p));
  } catch (e) { next(e?.issues ? Errors.validation('Invalid cash-out.', e.issues) : e); }
});

r.get('/fee', requireAuth, async (req, res, next) => {
  try { ok(res, await w.quoteFee(req.query.key || 'p2p', Number(req.query.amount || 0), req.auth.userId)); } catch (e) { next(e); }
});

// Owner/admin: your revenue so far.
r.get('/revenue', requireAuth, async (req, res, next) => {
  try { ok(res, await w.revenueSummary()); } catch (e) { next(e); }
});

// Virtual cards
r.get('/cards', requireAuth, async (req, res, next) => {
  try { ok(res, { cards: await w.listCards(req.auth.userId) }); } catch (e) { next(e); }
});
r.post('/cards', requireAuth, async (req, res, next) => {
  try { created(res, { card: await w.issueCard(req.auth.userId, { currency: (req.body && req.body.currency) || 'USD' }) }); } catch (e) { next(e); }
});
r.post('/cards/:id/status', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ status: z.enum(['active', 'frozen', 'cancelled']) }).parse(req.body);
    ok(res, { card: await w.setCardStatus(req.auth.userId, req.params.id, p.status) });
  } catch (e) { next(e?.issues ? Errors.validation('status required.', e.issues) : e); }
});

export default r;
