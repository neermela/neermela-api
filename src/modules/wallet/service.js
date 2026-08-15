// Wallet domain service — closed-loop P2P payments (WeChat Pay / BOTIM style).
// Money is handled in integer MINOR UNITS. Transfers are atomic double-entry
// with row locking, balance checks, PIN, idempotency, and daily limits.
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { id } from '../../lib/ids.js';
import { Errors, ApiError } from '../../gateway/respond.js';
import { audit } from '../../lib/audit.js';
import { publishUser } from '../messaging/ws.js';
import { config } from '../../config/index.js';

const PAY_SECRET = process.env.PAYCODE_SECRET || config.jwt.devSecret;

const walletId = () => id('NM_wal');
const txnId = () => id('NM_txn');
const reqId = () => id('NM_req');

export function toMinor(v) { return Math.round(Number(v) * 100); }
export function toMajor(minor) { return (Number(minor) / 100); }

// Every user has exactly one wallet; create on first touch.
export async function getOrCreateWallet(userId) {
  const { rows } = await query('SELECT * FROM wallet.accounts WHERE user_id=$1', [userId]);
  if (rows[0]) return rows[0];
  const wid = walletId();
  const ins = await query(
    `INSERT INTO wallet.accounts (wallet_id, user_id) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET updated_at=now() RETURNING *`,
    [wid, userId]
  );
  return ins.rows[0];
}

export async function walletView(userId) {
  const w = await getOrCreateWallet(userId);
  return {
    wallet_id: w.wallet_id, currency: w.currency,
    balance: toMajor(w.balance), balance_minor: Number(w.balance),
    has_pin: !!w.pin_hash, status: w.status, daily_limit: toMajor(w.daily_limit),
  };
}

export async function setPin(userId, { old_pin, new_pin }) {
  if (!/^\d{4,6}$/.test(new_pin || '')) throw Errors.validation('PIN must be 4–6 digits.');
  const w = await getOrCreateWallet(userId);
  if (w.pin_hash) {
    const ok = await argon2.verify(w.pin_hash, old_pin || '').catch(() => false);
    if (!ok) throw new ApiError(403, 'PIN_INVALID', 'Current PIN is incorrect.');
  }
  const hash = await argon2.hash(new_pin);
  await query('UPDATE wallet.accounts SET pin_hash=$1, updated_at=now() WHERE user_id=$2', [hash, userId]);
  await audit({ actorUserId: userId, action: 'wallet.pin_set' });
  return { has_pin: true };
}

async function verifyPin(walletRow, pin) {
  if (!walletRow.pin_hash) throw new ApiError(403, 'PIN_NOT_SET', 'Set a wallet PIN first.');
  const ok = await argon2.verify(walletRow.pin_hash, pin || '').catch(() => false);
  if (!ok) throw new ApiError(403, 'PIN_INVALID', 'Incorrect PIN.');
}

// Resolve a recipient (user_id | @username | phone) to their user row.
async function resolveUser(to) {
  const q = String(to || '').replace(/^@/, '');
  const { rows } = await query(
    `SELECT * FROM users.users WHERE user_id=$1 OR username=$2 OR phone=$3 LIMIT 1`,
    [to, q, to]
  );
  if (!rows[0]) throw Errors.notFound('Recipient not found on NeerMela.');
  return rows[0];
}

// Send money, atomically. amount is in MAJOR units (e.g. 500.00 BDT).
// feeBearer 'sender' = payer pays amount+fee (e.g. cash-out). 'recipient' = merchant MDR:
// customer pays exactly the amount, the merchant receives amount − fee (like bKash/Nagad QR).
export async function transfer(userId, { to, amount, pin, note, feeMinor = 0, feeType = 'fee', feeBearer = 'sender' }) {
  const amt = toMinor(amount);
  if (!amt || amt <= 0) throw Errors.validation('Amount must be greater than 0.');
  const recipient = await resolveUser(to);
  if (recipient.user_id === userId) throw Errors.validation('You cannot send money to yourself.');

  const sender = await getOrCreateWallet(userId);
  await verifyPin(sender, pin);
  const recWallet = await getOrCreateWallet(recipient.user_id);
  const platform = feeMinor > 0 ? await getPlatformWallet() : null;
  const senderFee = feeBearer === 'sender' ? feeMinor : 0;      // added on top of amount
  const recipientFee = feeBearer === 'recipient' ? feeMinor : 0; // deducted from what merchant receives

  const result = await withTransaction(async (c) => {
    const ids = [sender.wallet_id, recWallet.wallet_id]; if (platform) ids.push(platform.wallet_id);
    const locked = await c.query('SELECT * FROM wallet.accounts WHERE wallet_id = ANY($1) FOR UPDATE', [ids.sort()]);
    const S = locked.rows.find((r) => r.wallet_id === sender.wallet_id);
    const R = locked.rows.find((r) => r.wallet_id === recWallet.wallet_id);
    if (S.status !== 'active') throw new ApiError(403, 'WALLET_FROZEN', 'Your wallet is frozen.');
    const senderTotal = amt + senderFee;
    if (Number(S.balance) < senderTotal) throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Not enough balance.');

    const spentToday = await c.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM wallet.ledger
       WHERE wallet_id=$1 AND direction='debit' AND type IN ('transfer','request_pay','merchant','cashout') AND created_at::date = now()::date`,
      [S.wallet_id]);
    if (Number(spentToday.rows[0].s) + amt > Number(S.daily_limit)) throw new ApiError(403, 'LIMIT_EXCEEDED', 'This exceeds your daily limit. Verify your identity (KYC) to raise it.');

    const senderName = (await c.query('SELECT display_name FROM users.users WHERE user_id=$1', [userId])).rows[0].display_name;
    const recipientGets = amt - recipientFee;
    const afterAmt = Number(S.balance) - amt;
    const newR = Number(R.balance) + recipientGets;
    await c.query('UPDATE wallet.accounts SET balance=$1, updated_at=now() WHERE wallet_id=$2', [newR, R.wallet_id]);
    const tx = txnId();
    await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_wallet,counterparty_name,note) VALUES ($1,$2,'debit',$3,$4,'transfer',$5,$6,$7)`,
      [S.wallet_id, tx, amt, afterAmt, R.wallet_id, recipient.display_name, note || null]);
    await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_wallet,counterparty_name,note) VALUES ($1,$2,'credit',$3,$4,'transfer',$5,$6,$7)`,
      [R.wallet_id, tx, recipientGets, newR, S.wallet_id, senderName, recipientFee ? `MDR ${toMajor(recipientFee)}` : (note || null)]);

    let finalS = afterAmt;
    if (feeMinor > 0 && platform) {
      const P = locked.rows.find((r) => r.wallet_id === platform.wallet_id);
      const newP = Number(P.balance) + feeMinor;
      await c.query('UPDATE wallet.accounts SET balance=$1, updated_at=now() WHERE wallet_id=$2', [newP, P.wallet_id]);
      if (senderFee > 0) {   // payer-paid fee (cash-out style): extra debit on the sender
        finalS = afterAmt - senderFee;
        await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'debit',$3,$4,$5,'NeerMela fee','Service charge')`,
          [S.wallet_id, tx, senderFee, finalS, feeType]);
      } else {               // merchant MDR: fee taken from the recipient's proceeds
        await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'debit',$3,$4,$5,'NeerMela MDR','Merchant fee')`,
          [R.wallet_id, tx, recipientFee, newR, feeType]);
      }
      await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'credit',$3,$4,'revenue',$5,'Fee income')`,
        [platform.wallet_id, tx, feeMinor, newP, senderName]);
    }
    await c.query('UPDATE wallet.accounts SET balance=$1, updated_at=now() WHERE wallet_id=$2', [finalS, S.wallet_id]);
    return { txn_id: tx, new_balance: finalS, recipient, recipientGets };
  });

  await audit({ actorUserId: userId, action: 'wallet.transfer', resource: result.txn_id, metadata: { to: recipient.user_id, amount: amt, fee: feeMinor, feeBearer } });
  publishUser(recipient.user_id, { event: 'wallet.credit', amount: toMajor(result.recipientGets), currency: sender.currency, from: { user_id: userId, name: (await query('SELECT display_name FROM users.users WHERE user_id=$1', [userId])).rows[0].display_name }, note: note || null, txn_id: result.txn_id });

  return { txn_id: result.txn_id, amount: toMajor(amt), fee: toMajor(feeMinor), fee_bearer: feeBearer, recipient_gets: toMajor(result.recipientGets), currency: sender.currency, new_balance: toMajor(result.new_balance), to: { user_id: recipient.user_id, name: recipient.display_name, username: recipient.username } };
}

// Platform (NeerMela) revenue wallet — collects all fees. This IS your profit account.
export async function getPlatformWallet() {
  await query(`INSERT INTO users.users (user_id, username, display_name, account_status) VALUES ('NM_usr_PLATFORM','neermela','NeerMela','active') ON CONFLICT (user_id) DO NOTHING`);
  return getOrCreateWallet('NM_usr_PLATFORM');
}
export async function getFeeMinor(key, amountMinor) {
  const { rows } = await query('SELECT * FROM wallet.fee_config WHERE key=$1', [key]);
  const f = rows[0]; if (!f) return 0;
  let fee = Math.round(amountMinor * f.bps / 10000) + Number(f.flat);
  if (fee < Number(f.min_fee)) fee = Number(f.min_fee);
  return fee;
}

export async function transactions(userId, { limit = 30 } = {}) {
  const w = await getOrCreateWallet(userId);
  const { rows } = await query(
    `SELECT txn_id, direction, amount, balance_after, type, counterparty_name, note, created_at
     FROM wallet.ledger WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [w.wallet_id, Math.min(limit, 100)]
  );
  return rows.map((r) => ({
    txn_id: r.txn_id, direction: r.direction, type: r.type,
    amount: toMajor(r.amount), balance_after: toMajor(r.balance_after),
    counterparty: r.counterparty_name, note: r.note, created_at: r.created_at,
  }));
}

// Sandbox cash-in. Real cash-in must come through a licensed PSP/bank or agent (see notes).
export async function topupSandbox(userId, amount) {
  if (process.env.ALLOW_SANDBOX_TOPUP === 'false') throw Errors.forbidden('Sandbox top-up disabled.');
  const amt = toMinor(amount);
  if (!amt || amt <= 0) throw Errors.validation('Amount must be greater than 0.');
  const w = await getOrCreateWallet(userId);
  const out = await withTransaction(async (c) => {
    const locked = await c.query('SELECT * FROM wallet.accounts WHERE wallet_id=$1 FOR UPDATE', [w.wallet_id]);
    const bal = Number(locked.rows[0].balance) + amt;
    await c.query('UPDATE wallet.accounts SET balance=$1, updated_at=now() WHERE wallet_id=$2', [bal, w.wallet_id]);
    const tx = txnId();
    await c.query(
      `INSERT INTO wallet.ledger (wallet_id, txn_id, direction, amount, balance_after, type, counterparty_name, note)
       VALUES ($1,$2,'credit',$3,$4,'topup','Sandbox top-up','Test credit')`,
      [w.wallet_id, tx, amt, bal]
    );
    return { tx, bal };
  });
  return { txn_id: out.tx, new_balance: toMajor(out.bal) };
}

// Request money from someone.
export async function createRequest(userId, { from, amount, note }) {
  const amt = toMinor(amount);
  if (!amt || amt <= 0) throw Errors.validation('Amount must be greater than 0.');
  const payer = await resolveUser(from);
  const rid = reqId();
  await query(
    `INSERT INTO wallet.requests (request_id, from_user_id, to_user_id, amount, note)
     VALUES ($1,$2,$3,$4,$5)`,
    [rid, userId, payer.user_id, amt, note || null]
  );
  publishUser(payer.user_id, { event: 'wallet.request', request_id: rid, amount: toMajor(amt), from: { user_id: userId }, note: note || null });
  return { request_id: rid, amount: toMajor(amt), to: { user_id: payer.user_id, name: payer.display_name } };
}

export async function listRequests(userId) {
  const { rows } = await query(
    `SELECT r.*, u.display_name AS from_name FROM wallet.requests r
     JOIN users.users u ON u.user_id=r.from_user_id
     WHERE r.to_user_id=$1 AND r.status='pending' ORDER BY r.created_at DESC LIMIT 30`,
    [userId]
  );
  return rows.map((r) => ({ request_id: r.request_id, from: r.from_name, from_user_id: r.from_user_id, amount: toMajor(r.amount), note: r.note, created_at: r.created_at }));
}

export async function payRequest(userId, { request_id, pin }) {
  const { rows } = await query('SELECT * FROM wallet.requests WHERE request_id=$1', [request_id]);
  const rq = rows[0];
  if (!rq) throw Errors.notFound('Request not found.');
  if (rq.to_user_id !== userId) throw Errors.forbidden('This request is not for you.');
  if (rq.status !== 'pending') throw Errors.conflict('REQUEST_CLOSED', 'This request is no longer pending.');
  const res = await transfer(userId, { to: rq.from_user_id, amount: toMajor(rq.amount), pin, note: rq.note || 'Payment' });
  await query('UPDATE wallet.requests SET status=$1, txn_id=$2, updated_at=now() WHERE request_id=$3', ['paid', res.txn_id, request_id]);
  return res;
}

/* ---------- QR pay-code (scan-to-pay, WeChat/BOTIM style) ---------- */
// A pay-code is a compact HMAC-signed token: "NMPAY1:<payloadB64>.<sig>".
// It carries the payee's user_id, an optional locked amount, and an expiry.
function signPay(b64) { return crypto.createHmac('sha256', PAY_SECRET).update(b64).digest('base64url').slice(0, 22); }

export async function createPaycode(userId, { amount, ttl = 600 } = {}) {
  await getOrCreateWallet(userId);
  const payload = { u: userId, a: amount ? toMinor(amount) : null, e: Math.floor(Date.now() / 1000) + ttl };
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const code = 'NMPAY1:' + b + '.' + signPay(b);
  const me = (await query('SELECT username, display_name FROM users.users WHERE user_id=$1', [userId])).rows[0];
  return { code, expires_in: ttl, amount: amount ? Number(amount) : null, username: me.username, name: me.display_name };
}

export function parsePaycode(code) {
  if (!code || !code.startsWith('NMPAY1:')) throw Errors.validation('Not a NeerMela pay code.');
  const [b, sig] = code.slice(7).split('.');
  if (!b || !sig || signPay(b) !== sig) throw new ApiError(400, 'PAYCODE_INVALID', 'This QR / code is invalid.');
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  if ((p.e || 0) * 1000 < Date.now()) throw new ApiError(400, 'PAYCODE_EXPIRED', 'This QR has expired. Ask for a new one.');
  return p;
}

// Show who you'd pay (no money moves) — for the confirm screen.
export async function resolvePaycode(code) {
  const p = parsePaycode(code);
  const u = (await query('SELECT user_id, display_name, username, profile_photo FROM users.users WHERE user_id=$1', [p.u])).rows[0];
  if (!u) throw Errors.notFound('Payee not found.');
  return { to: { user_id: u.user_id, name: u.display_name, username: u.username, photo: u.profile_photo }, amount: p.a ? toMajor(p.a) : null, fixed: !!p.a };
}

// Scan → pay. Uses the locked amount if the code has one, else the entered amount.
// Merchant/QR payments carry a fee that becomes NeerMela revenue.
export async function payViaCode(userId, { code, amount, pin, note }) {
  const p = parsePaycode(code);
  if (p.u === userId) throw Errors.validation('This is your own pay code.');
  const amt = p.a ? toMajor(p.a) : Number(amount);
  if (!amt || amt <= 0) throw Errors.validation('Amount is required for this code.');
  const feeMinor = await getFeeMinor('merchant', toMinor(amt));
  return transfer(userId, { to: p.u, amount: amt, pin, note: note || 'QR payment', feeMinor, feeType: 'merchant', feeBearer: 'recipient' });
}

// Cash-out (agent/bank withdrawal). Fee is NeerMela revenue. Verified/expat users get the cheapest rate.
export async function cashout(userId, { amount, pin, method = 'agent' }) {
  const amt = toMinor(amount);
  if (!amt || amt <= 0) throw Errors.validation('Amount must be greater than 0.');
  const feeMinor = await getFeeMinor(await cashoutKeyFor(userId), amt);
  const w = await getOrCreateWallet(userId);
  await verifyPin(w, pin);
  const platform = await getPlatformWallet();
  const out = await withTransaction(async (c) => {
    const ids = [w.wallet_id, platform.wallet_id].sort();
    const locked = await c.query('SELECT * FROM wallet.accounts WHERE wallet_id = ANY($1) FOR UPDATE', [ids]);
    const S = locked.rows.find((r) => r.wallet_id === w.wallet_id);
    const P = locked.rows.find((r) => r.wallet_id === platform.wallet_id);
    const total = amt + feeMinor;
    if (Number(S.balance) < total) throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Not enough balance for amount + fee.');
    const afterAmt = Number(S.balance) - amt;
    const finalS = afterAmt - feeMinor;
    const newP = Number(P.balance) + feeMinor;
    const tx = txnId();
    await c.query('UPDATE wallet.accounts SET balance=$1 WHERE wallet_id=$2', [finalS, w.wallet_id]);
    await c.query('UPDATE wallet.accounts SET balance=$1 WHERE wallet_id=$2', [newP, platform.wallet_id]);
    await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'debit',$3,$4,'cashout',$5,$6)`,
      [w.wallet_id, tx, amt, afterAmt, method, 'Cash out']);
    await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'debit',$3,$4,'cashout','NeerMela fee','Cash-out charge')`,
      [w.wallet_id, tx, feeMinor, finalS]);
    await c.query(`INSERT INTO wallet.ledger (wallet_id,txn_id,direction,amount,balance_after,type,counterparty_name,note) VALUES ($1,$2,'credit',$3,$4,'revenue','Cash-out fee','Fee income')`,
      [platform.wallet_id, tx, feeMinor, newP]);
    return { tx, finalS };
  });
  return { txn_id: out.tx, amount: toMajor(amt), fee: toMajor(feeMinor), new_balance: toMajor(out.finalS) };
}

// Platform revenue summary (admin/owner) — your profit so far.
export async function revenueSummary() {
  const p = await getPlatformWallet();
  const { rows } = await query(`SELECT type, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM wallet.ledger WHERE wallet_id=$1 AND direction='credit' GROUP BY type`, [p.wallet_id]);
  return { total: toMajor(p.balance), by_type: rows.map((r) => ({ type: r.type, total: toMajor(r.total), count: Number(r.n) })) };
}

// Verified (KYC tier ≥1) and expat/probashi users get the cheapest cash-out rate.
export async function cashoutKeyFor(userId) {
  const u = (await query('SELECT kyc_tier, is_expat FROM users.users WHERE user_id=$1', [userId])).rows[0];
  return (u && (Number(u.kyc_tier) >= 1 || u.is_expat)) ? 'cashout_verified' : 'cashout';
}

// Estimate the fee for a UI preview (no money moves). For cash-out, resolves the user's tier.
export async function quoteFee(key, amount, userId) {
  let k = key;
  if (key === 'cashout' && userId) k = await cashoutKeyFor(userId);
  return { fee: toMajor(await getFeeMinor(k, toMinor(amount))), rate_key: k };
}

/* ---------- Virtual cards (issued via a licensed issuer / BaaS partner) ---------- */
import { cards as cardIssuer } from '../../adapters/cards/index.js';

const cardId = () => id('NM_card');

// Auto-issue one virtual card per user (a "default" card). Real issuance requires KYC + an issuer.
export async function issueCard(userId, { currency = 'USD' } = {}) {
  const existing = await query('SELECT * FROM wallet.cards WHERE user_id=$1 AND status<>$2 ORDER BY created_at DESC', [userId, 'cancelled']);
  if (existing.rows[0]) return cardView(existing.rows[0]);
  await getOrCreateWallet(userId);
  const c = await cardIssuer.issue({ userId, currency });
  const cid = cardId();
  const ins = await query(
    `INSERT INTO wallet.cards (card_id,user_id,provider,provider_ref,brand,last4,exp_month,exp_year,currency,type,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'virtual','active') RETURNING *`,
    [cid, userId, process.env.CARD_PROVIDER || 'sandbox', c.provider_ref, c.brand, c.last4, c.exp_month, c.exp_year, currency]
  );
  await audit({ actorUserId: userId, action: 'card.issued', resource: cid });
  return cardView(ins.rows[0]);
}

export async function listCards(userId) {
  const { rows } = await query('SELECT * FROM wallet.cards WHERE user_id=$1 AND status<>$2 ORDER BY created_at DESC', [userId, 'cancelled']);
  return rows.map(cardView);
}

export async function setCardStatus(userId, cardIdArg, status) {
  if (!['active', 'frozen', 'cancelled'].includes(status)) throw Errors.validation('status must be active | frozen | cancelled.');
  const { rows } = await query('SELECT * FROM wallet.cards WHERE card_id=$1 AND user_id=$2', [cardIdArg, userId]);
  if (!rows[0]) throw Errors.notFound('Card not found.');
  await cardIssuer.setStatus({ provider_ref: rows[0].provider_ref, status });
  const upd = await query('UPDATE wallet.cards SET status=$1, updated_at=now() WHERE card_id=$2 RETURNING *', [status, cardIdArg]);
  return cardView(upd.rows[0]);
}

function cardView(c) {
  return {
    card_id: c.card_id, brand: c.brand, last4: c.last4,
    exp: String(c.exp_month).padStart(2, '0') + '/' + String(c.exp_year).slice(-2),
    currency: c.currency, type: c.type, status: c.status, provider: c.provider,
    number_masked: '•••• •••• •••• ' + c.last4,
  };
}
