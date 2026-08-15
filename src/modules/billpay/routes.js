// Bill pay (v1.7). Closed-loop: debits the user's wallet to the platform
// biller-settlement account, records the payment. Real biller rails plug in later.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ok, created, Errors } from '../../gateway/respond.js';
import { requireAuth, idempotency } from '../../gateway/middleware.js';
import { billId } from '../../lib/ids.js';
import { transfer, getPlatformWallet, toMinor } from '../wallet/service.js';

const r = Router();

// List available billers
r.get('/billers', requireAuth, async (req, res, next) => {
  try {
    const cat = req.query.category || null;
    const { rows } = await query(
      `SELECT biller_id, name, category, min_amount FROM wallet.billers
       WHERE active=true AND ($1::text IS NULL OR category=$1) ORDER BY category, name`, [cat]);
    ok(res, { billers: rows });
  } catch (e) { next(e); }
});

// Pay a bill (wallet -> platform biller settlement)
const payBill = z.object({
  biller_id: z.string(),
  account_ref: z.string().min(1).max(60),  // meter / phone / customer id
  amount: z.number().positive(),
  pin: z.string().optional(),
});
r.post('/pay', requireAuth, idempotency, async (req, res, next) => {
  try {
    const p = payBill.parse(req.body);
    const { rows:[biller] } = await query('SELECT * FROM wallet.billers WHERE biller_id=$1 AND active=true', [p.biller_id]);
    if (!biller) throw Errors.notFound('Biller not found.');
    if (p.amount < Number(biller.min_amount)) throw Errors.validation(`Minimum for ${biller.name} is ${biller.min_amount}.`);

    // Move funds to the platform settlement wallet (closed-loop, ledger-consistent).
    const platform = await getPlatformWallet();
    const t = await transfer(req.auth.userId, {
      to: platform.user_id, amount: p.amount, pin: p.pin,
      note: `Bill: ${biller.name} (${p.account_ref})`,
    });

    const pid = billId();
    await query(
      `INSERT INTO wallet.bill_payments (payment_id,user_id,biller_id,account_ref,amount_minor,txn_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,'success')`,
      [pid, req.auth.userId, p.biller_id, p.account_ref, toMinor(p.amount), t.txn_id || null]);

    created(res, { payment_id: pid, biller: biller.name, account_ref: p.account_ref, amount: p.amount, status: 'success' });
  } catch (e) { next(e?.issues ? Errors.validation('Invalid bill payment.', e.issues) : e); }
});

// Bill payment history
r.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.payment_id, b.account_ref, b.amount_minor, b.status, b.created_at,
              bl.name AS biller, bl.category
       FROM wallet.bill_payments b JOIN wallet.billers bl ON bl.biller_id=b.biller_id
       WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [req.auth.userId]);
    ok(res, { payments: rows });
  } catch (e) { next(e); }
});

export default r;
