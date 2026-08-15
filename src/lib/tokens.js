// Access/refresh tokens (spec §9). Access = short-lived JWT. Refresh = opaque, rotating,
// stored hashed server-side with reuse detection.
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

function signingKey() {
  return config.jwt.privateKey || config.jwt.devSecret;
}
function verifyKey() {
  return config.jwt.publicKey || config.jwt.devSecret;
}
function alg() {
  return config.jwt.privateKey ? 'RS256' : 'HS256';
}

export function issueAccessToken({ userId, sessionId, scopes = [] }) {
  return jwt.sign(
    { sub: userId, sid: sessionId, scope: scopes.join(' ') },
    signingKey(),
    { algorithm: alg(), expiresIn: config.jwt.accessTtl, issuer: config.jwt.issuer, audience: config.jwt.audience }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, verifyKey(), { algorithms: [alg()], issuer: config.jwt.issuer, audience: config.jwt.audience });
}

// Opaque refresh token: return the plaintext (given to client once) + hash (stored).
export function newRefreshToken() {
  const plaintext = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}
export function hashRefresh(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}
