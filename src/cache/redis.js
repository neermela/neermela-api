// Redis (spec §24): OTP challenge state, sessions, rate limiting, presence, idempotency.
import Redis from 'ioredis';
import { config } from '../config/index.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (e) => console.error('[redis]', e.message));

// Fixed-window rate limiter. Returns { allowed, remaining, resetIn }.
export async function rateLimit(key, limit, windowSec) {
  const k = `rl:${key}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSec);
  const ttl = await redis.ttl(k);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetIn: ttl };
}
