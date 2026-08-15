// KYC / identity verification (spec §11, §67). NID / passport (probashi) / email.
// Verifying raises the user's wallet daily limit (tiered like real MFS apps).
import { query } from '../../db/pool.js';
import { id } from '../../lib/ids.js';
import { Errors, ApiError } from '../../gateway/respond.js';
import { audit } from '../../lib/audit.js';

const TIER_LIMIT = { 0: 2500000, 1: 20000000, 2: 100000000 }; // minor units/day: 25k, 200k, 1,000k

export async function submitKyc(userId, body) {
  const { doc_type, doc_number, full_name, date_of_birth, country, email,
          is_expat, residence_country, address, gender,
          doc_front_media, doc_back_media, selfie_media } = body;
  if (!['nid', 'passport', 'driving', 'birth'].includes(doc_type)) throw Errors.validation('doc_type must be nid | passport | driving | birth.');
  if (!doc_number || doc_number.length < 5) throw Errors.validation('A valid document number is required.');
  // Basic format hints (not authoritative — a real integration checks against the issuing authority).
  if (doc_type === 'nid' && !/^\d{10,17}$/.test(doc_number)) throw Errors.validation('Bangladeshi NID should be 10–17 digits.');

  const kid = id('NM_kyc');
  try {
    await query(
      `INSERT INTO users.kyc (kyc_id,user_id,doc_type,doc_number,full_name,date_of_birth,country,email,doc_front_media,doc_back_media,selfie_media,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       ON CONFLICT (user_id) DO UPDATE SET doc_type=$3,doc_number=$4,full_name=$5,date_of_birth=$6,country=$7,email=$8,doc_front_media=$9,doc_back_media=$10,selfie_media=$11,status='pending',updated_at=now()`,
      [kid, userId, doc_type, doc_number, full_name || null, date_of_birth || null, country || null, email || null, doc_front_media || null, doc_back_media || null, selfie_media || null]
    );
    await query(
      `UPDATE users.users SET full_name=COALESCE($2,full_name), date_of_birth=COALESCE($3,date_of_birth), gender=COALESCE($4,gender),
         address=COALESCE($5,address), is_expat=COALESCE($6,is_expat), residence_country=COALESCE($7,residence_country),
         email=COALESCE($8,email), kyc_status='pending', updated_at=now() WHERE user_id=$1`,
      [userId, full_name || null, date_of_birth || null, gender || null, address || null,
       typeof is_expat === 'boolean' ? is_expat : null, residence_country || null, email || null]
    );
  } catch (e) {
    if (e.code === '23505') {
      if (String(e.constraint || '').includes('email')) throw new ApiError(409, 'EMAIL_TAKEN', 'That email is already linked to another account.');
      throw new ApiError(409, 'DUPLICATE', 'Some of these details are already registered.');
    }
    throw e;
  }
  await audit({ actorUserId: userId, action: 'kyc.submitted', metadata: { doc_type } });

  // Sandbox auto-review so wallet limits work while testing. Turn OFF in production.
  if (process.env.AUTO_KYC === 'true') return verifyKyc(userId, { tier: 1, reviewerId: 'auto' });
  return getKyc(userId);
}

export async function getKyc(userId) {
  const u = (await query('SELECT kyc_status, kyc_tier, is_expat, residence_country, email FROM users.users WHERE user_id=$1', [userId])).rows[0];
  const k = (await query('SELECT doc_type, doc_number, status, reject_reason, created_at FROM users.kyc WHERE user_id=$1', [userId])).rows[0];
  return {
    status: u?.kyc_status || 'none', tier: u?.kyc_tier || 0,
    is_expat: u?.is_expat || false, residence_country: u?.residence_country || null, email: u?.email || null,
    document: k ? { doc_type: k.doc_type, doc_number_masked: mask(k.doc_number), status: k.status, reject_reason: k.reject_reason } : null,
    daily_limit: (TIER_LIMIT[u?.kyc_tier || 0]) / 100,
  };
}

// Admin action (wire to admin panel). Raises the wallet daily limit on approval.
export async function verifyKyc(userId, { tier = 1, reviewerId }) {
  await query(`UPDATE users.kyc SET status='verified', reviewer_id=$2, updated_at=now() WHERE user_id=$1`, [userId, reviewerId || null]);
  await query(`UPDATE users.users SET kyc_status='verified', kyc_tier=$2, verification_status='verified', updated_at=now() WHERE user_id=$1`, [userId, tier]);
  await query(`UPDATE wallet.accounts SET daily_limit=$2, updated_at=now() WHERE user_id=$1`, [userId, TIER_LIMIT[tier] || TIER_LIMIT[1]]);
  await audit({ actorUserId: userId, action: 'kyc.verified', metadata: { tier } });
  return getKyc(userId);
}
export async function rejectKyc(userId, reason) {
  await query(`UPDATE users.kyc SET status='rejected', reject_reason=$2, updated_at=now() WHERE user_id=$1`, [userId, reason || null]);
  await query(`UPDATE users.users SET kyc_status='rejected', updated_at=now() WHERE user_id=$1`, [userId]);
  return getKyc(userId);
}
function mask(s) { return s.length <= 4 ? '****' : s.slice(0, 2) + '****' + s.slice(-2); }
