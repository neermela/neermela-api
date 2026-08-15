// Owner/admin dashboard API (spec §47, §48). Protected by a master admin key for now
// (full role-based admin — Super/Finance/Support — is on the roadmap).
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { ok, ApiError } from '../../gateway/respond.js';
import { getPlatformWallet, toMajor, revenueSummary } from '../wallet/service.js';

const r = Router();

// Simple master-key guard. Set ADMIN_KEY in the environment.
function requireAdmin(req, res, next) {
  const key = req.header('X-Admin-Key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return next(new ApiError(401, 'ADMIN_UNAUTHORIZED', 'Admin key required.'));
  }
  next();
}
r.use(requireAdmin);

const PLATFORM = 'NM_usr_PLATFORM';

// Headline numbers for the dashboard.
r.get('/overview', async (req, res, next) => {
  try {
    const users = await query(`SELECT COUNT(*)::int n FROM users.users WHERE user_id<>$1`, [PLATFORM]);
    const agents = await query(`SELECT COUNT(*)::int n FROM users.users WHERE is_agent=true`);
    const verified = await query(`SELECT COUNT(*)::int n FROM users.users WHERE kyc_status='verified'`);
    const float = await query(`SELECT COALESCE(SUM(balance),0) s FROM wallet.accounts WHERE user_id<>$1`, [PLATFORM]);
    const txToday = await query(`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0) v FROM wallet.ledger WHERE direction='debit' AND type IN ('transfer','merchant','cashout') AND created_at::date=now()::date`);
    const rev = await revenueSummary();
    ok(res, {
      users: users.rows[0].n, agents: agents.rows[0].n, verified: verified.rows[0].n,
      customer_float: toMajor(float.rows[0].s),
      tx_today: txToday.rows[0].n, volume_today: toMajor(txToday.rows[0].v),
      revenue_total: rev.total, revenue_by_type: rev.by_type,
    });
  } catch (e) { next(e); }
});

// Recent transactions across the whole platform (join names).
r.get('/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await query(
      `SELECT l.txn_id, l.direction, l.amount, l.type, l.note, l.created_at,
              u.display_name AS owner_name, u.username AS owner_username, l.counterparty_name
       FROM wallet.ledger l
       JOIN wallet.accounts a ON a.wallet_id=l.wallet_id
       JOIN users.users u ON u.user_id=a.user_id
       WHERE u.user_id<>$1
       ORDER BY l.created_at DESC LIMIT $2`, [PLATFORM, limit]);
    ok(res, { transactions: rows.map((t) => ({ ...t, amount: toMajor(t.amount) })) });
  } catch (e) { next(e); }
});

// Customers / users with balances + KYC + agent flag.
r.get('/users', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').replace(/^@/, '');
    const filter = req.query.filter; // agents | verified | all
    const { rows } = await query(
      `SELECT u.user_id, u.username, u.display_name, u.phone, u.email, u.kyc_status, u.kyc_tier,
              u.is_expat, u.is_agent, u.residence_country, COALESCE(w.balance,0) AS balance, u.created_at
       FROM users.users u LEFT JOIN wallet.accounts w ON w.user_id=u.user_id
       WHERE u.user_id<>$1
         AND ($2='' OR u.username ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%' OR u.phone ILIKE '%'||$2||'%')
         AND ($3='agents' AND u.is_agent OR $3='verified' AND u.kyc_status='verified' OR $3 IS NULL OR $3='all')
       ORDER BY u.created_at DESC LIMIT 200`,
      [PLATFORM, q, filter || null]);
    ok(res, { users: rows.map((u) => ({ ...u, balance: toMajor(u.balance) })) });
  } catch (e) { next(e); }
});

// Make/remove an agent.
r.post('/users/:id/agent', async (req, res, next) => {
  try {
    const on = req.body?.is_agent !== false;
    await query(`UPDATE users.users SET is_agent=$2, updated_at=now() WHERE user_id=$1`, [req.params.id, on]);
    ok(res, { user_id: req.params.id, is_agent: on });
  } catch (e) { next(e); }
});

// Freeze / unfreeze a wallet.
r.post('/users/:id/wallet', async (req, res, next) => {
  try {
    const status = req.body?.status === 'frozen' ? 'frozen' : 'active';
    await query(`UPDATE wallet.accounts SET status=$2, updated_at=now() WHERE user_id=$1`, [req.params.id, status]);
    ok(res, { user_id: req.params.id, wallet_status: status });
  } catch (e) { next(e); }
});

// Settlement: your withdrawable revenue (platform wallet) + how to move it to bank.
r.get('/settlement', async (req, res, next) => {
  try {
    const p = await getPlatformWallet();
    const rev = await revenueSummary();
    ok(res, {
      withdrawable_revenue: toMajor(p.balance),
      by_type: rev.by_type,
      note: 'This is NeerMela\'s fee income. In production it settles from the pooled trust account to your company bank account via your PSP/settlement bank.',
    });
  } catch (e) { next(e); }
});

// Adjust a fee rate live (owner control).
r.post('/fees', async (req, res, next) => {
  try {
    const { key, bps } = req.body || {};
    if (!key || typeof bps !== 'number') throw new ApiError(400, 'BAD_INPUT', 'key and bps required.');
    await query(`INSERT INTO wallet.fee_config (key,bps) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET bps=$2, updated_at=now()`, [key, Math.round(bps)]);
    const { rows } = await query(`SELECT key, bps FROM wallet.fee_config ORDER BY key`);
    ok(res, { fees: rows });
  } catch (e) { next(e); }
});
r.get('/fees', async (req, res, next) => {
  try { const { rows } = await query(`SELECT key, bps, flat, min_fee FROM wallet.fee_config ORDER BY key`); ok(res, { fees: rows }); } catch (e) { next(e); }
});

export default r;
