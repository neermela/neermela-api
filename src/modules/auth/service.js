// Auth domain service (spec §4–§10). OTP challenge lifecycle + session issuance.
import argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { redis } from '../../cache/redis.js';
import { config } from '../../config/index.js';
import { userId as newUserId, sessionId as newSessionId, challengeId as newChallengeId } from '../../lib/ids.js';
import { issueAccessToken, newRefreshToken, hashRefresh } from '../../lib/tokens.js';
import { Errors } from '../../gateway/respond.js';
import { sms } from '../../adapters/sms/index.js';
import { email } from '../../adapters/email/index.js';
import { audit } from '../../lib/audit.js';

function genCode() {
  // 6-digit, cryptographically random. Never logged in prod, never stored in plaintext (spec §7).
  return String(randomInt(0, 1_000_000)).padStart(config.otp.length, '0');
}

// Send an OTP over sms|email. Old challenges for the same destination are invalidated (spec §7).
export async function sendOtp({ channel, phone, email: emailAddr, purpose = 'login', ip, deviceId }) {
  const destination = channel === 'email' ? emailAddr : phone;
  if (!destination) throw Errors.validation(`A ${channel === 'email' ? 'email' : 'phone'} is required.`);

  // Resend cooldown (spec §7 anti-abuse).
  const cdKey = `otp:cd:${destination}`;
  if (await redis.get(cdKey)) throw Errors.rateLimited('Please wait before requesting another code.');

  const code = genCode();
  const otpHash = await argon2.hash(code);
  const chId = newChallengeId();
  const expiresAt = new Date(Date.now() + config.otp.ttlSeconds * 1000);

  await withTransaction(async (c) => {
    // Invalidate any pending challenges to this destination.
    await c.query(
      `UPDATE nm_auth.otp_challenges SET status='superseded'
       WHERE destination=$1 AND status='pending'`,
      [destination]
    );
    await c.query(
      `INSERT INTO nm_auth.otp_challenges
         (challenge_id, destination, channel, purpose, otp_hash, expires_at, max_attempts, ip_address, device_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [chId, destination, channel, purpose, otpHash, expiresAt, config.otp.maxAttempts, ip, deviceId]
    );
  });

  const text = `Your NeerMela verification code is ${code}. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes.`;
  if (channel === 'email') await email.send({ to: destination, subject: 'NeerMela verification code', text });
  else await sms.send({ to: destination, text });

  await redis.set(cdKey, '1', 'EX', config.otp.resendCooldown);

  return { challenge_id: chId, channel, destination_masked: mask(destination), expires_in: config.otp.ttlSeconds };
}

// Verify a code. On success, upsert the user and issue a session (spec §5).
export async function verifyOtp({ challengeId, code, ip, deviceId, userAgent }) {
  const { rows } = await query(
    `SELECT * FROM nm_auth.otp_challenges WHERE challenge_id=$1`,
    [challengeId]
  );
  const ch = rows[0];
  if (!ch) throw Errors.otpInvalid();
  if (ch.status !== 'pending') throw Errors.otpInvalid();
  if (new Date(ch.expires_at) < new Date()) {
    await query(`UPDATE nm_auth.otp_challenges SET status='expired' WHERE challenge_id=$1`, [challengeId]);
    throw Errors.otpExpired();
  }
  if (ch.attempt_count >= ch.max_attempts) {
    await query(`UPDATE nm_auth.otp_challenges SET status='locked' WHERE challenge_id=$1`, [challengeId]);
    throw Errors.otpLocked();
  }

  const okCode = await argon2.verify(ch.otp_hash, code).catch(() => false);
  if (!okCode) {
    await query(`UPDATE nm_auth.otp_challenges SET attempt_count=attempt_count+1 WHERE challenge_id=$1`, [challengeId]);
    throw Errors.otpInvalid();
  }

  await query(`UPDATE nm_auth.otp_challenges SET status='used' WHERE challenge_id=$1`, [challengeId]);

  // Find or create the user by destination (spec §8: internal immutable id).
  const isEmail = ch.channel === 'email';
  const lookupCol = isEmail ? 'email' : 'phone';
  let { rows: urows } = await query(`SELECT * FROM users.users WHERE ${lookupCol}=$1`, [ch.destination]);
  let user = urows[0];
  let isNew = false;
  if (!user) {
    isNew = true;
    const uid = newUserId();
    const username = uid.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
    ({ rows: urows } = await query(
      `INSERT INTO users.users (user_id, username, display_name, ${lookupCol}, ${lookupCol}_verified, account_status)
       VALUES ($1,$2,$3,$4,true,'active') RETURNING *`,
      [uid, username, 'New user', ch.destination]
    ));
    user = urows[0];
  } else {
    await query(`UPDATE users.users SET ${lookupCol}_verified=true, updated_at=now() WHERE user_id=$1`, [user.user_id]);
  }

  const session = await createSession({ userId: user.user_id, ip, deviceId, userAgent });
  await audit({ actorUserId: user.user_id, action: isNew ? 'user.registered' : 'user.login', resource: user.user_id, ip, device: deviceId });

  return { user: publicUser(user), ...session, is_new: isNew };
}

// Create a session with rotating refresh token (spec §9).
export async function createSession({ userId, ip, deviceId, userAgent, scopes = defaultScopes() }) {
  const sid = newSessionId();
  const { plaintext, hash } = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtl * 1000);
  await query(
    `INSERT INTO nm_auth.sessions (session_id, user_id, refresh_hash, device_id, user_agent, ip_address, scopes, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
    [sid, userId, hash, deviceId, userAgent, ip, scopes, expiresAt]
  );
  const accessToken = issueAccessToken({ userId, sessionId: sid, scopes });
  return { session_id: sid, access_token: accessToken, refresh_token: plaintext, expires_in: config.jwt.accessTtl, scopes };
}

// Rotate refresh token; detect reuse of a revoked token (spec §9).
export async function refresh({ refreshToken, ip, deviceId }) {
  const hash = hashRefresh(refreshToken);
  const { rows } = await query(`SELECT * FROM nm_auth.sessions WHERE refresh_hash=$1`, [hash]);
  const sess = rows[0];
  if (!sess) throw Errors.unauthorized('Invalid refresh token.');
  if (sess.status !== 'active') {
    // Reuse of a rotated/revoked token → revoke the whole session family (spec §9).
    await query(`UPDATE nm_auth.sessions SET status='revoked' WHERE user_id=$1`, [sess.user_id]);
    await audit({ actorUserId: sess.user_id, action: 'auth.refresh_reuse_detected', result: 'blocked', ip, device: deviceId });
    throw Errors.unauthorized('Refresh token reuse detected. All sessions revoked.');
  }
  if (new Date(sess.expires_at) < new Date()) throw Errors.unauthorized('Session expired.');

  const { plaintext, hash: newHash } = newRefreshToken();
  await query(
    `UPDATE nm_auth.sessions SET refresh_hash=$1, status='active', last_used_at=now() WHERE session_id=$2`,
    [newHash, sess.session_id]
  );
  const accessToken = issueAccessToken({ userId: sess.user_id, sessionId: sess.session_id, scopes: sess.scopes });
  return { access_token: accessToken, refresh_token: plaintext, expires_in: config.jwt.accessTtl };
}

export async function logout({ sessionId }) {
  await query(`UPDATE nm_auth.sessions SET status='revoked' WHERE session_id=$1`, [sessionId]);
}

export async function listSessions({ userId }) {
  const { rows } = await query(
    `SELECT session_id, device_id, user_agent, ip_address, created_at, last_used_at, status
     FROM nm_auth.sessions WHERE user_id=$1 ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    [userId]
  );
  return rows;
}

export async function revokeSession({ userId, sessionId }) {
  await query(`UPDATE nm_auth.sessions SET status='revoked' WHERE session_id=$1 AND user_id=$2`, [sessionId, userId]);
}

function defaultScopes() {
  return ['users:read', 'users:write', 'messages:read', 'messages:write', 'media:upload'];
}
function mask(dest) {
  if (dest.includes('@')) { const [a, b] = dest.split('@'); return a.slice(0, 2) + '***@' + b; }
  return dest.slice(0, 4) + '***' + dest.slice(-2);
}
export function publicUser(u) {
  return {
    user_id: u.user_id, username: u.username, display_name: u.display_name,
    phone: u.phone || null, email: u.email || null, country: u.country || null,
    profile_photo: u.profile_photo || null, bio: u.bio || null,
    full_name: u.full_name || null, date_of_birth: u.date_of_birth || null, gender: u.gender || null,
    is_expat: u.is_expat || false, residence_country: u.residence_country || null,
    account_status: u.account_status, verification_status: u.verification_status || 'none',
    kyc_status: u.kyc_status || 'none', kyc_tier: u.kyc_tier || 0,
    created_at: u.created_at,
  };
}
