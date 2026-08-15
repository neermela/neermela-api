// Central configuration. Everything comes from environment variables (spec §50, §90).
// Nothing sensitive is ever hardcoded here.
import 'dotenv/config';

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    // Fail fast in production; allow dev defaults elsewhere.
    if (process.env.NODE_ENV === 'production') throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '8080', 10),
  apiVersion: 'v1',
  baseUrl: process.env.API_BASE_URL || 'http://localhost:8080',

  // Data layer
  databaseUrl: req('DATABASE_URL', 'postgres://neermela:neermela@localhost:5432/neermela'),
  redisUrl: req('REDIS_URL', 'redis://localhost:6379'),

  // JWT (RS256 in prod; symmetric fallback for local dev only)
  jwt: {
    accessTtl: parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10),          // 15 min
    refreshTtl: parseInt(process.env.REFRESH_TOKEN_TTL || '2592000', 10),    // 30 days
    privateKey: process.env.JWT_PRIVATE_KEY,                                 // PEM (RS256)
    publicKey: process.env.JWT_PUBLIC_KEY,                                   // PEM (RS256)
    devSecret: process.env.JWT_DEV_SECRET || 'dev-only-insecure-secret-change-me',
    issuer: 'https://api.neermela.com',
    audience: 'neermela',
  },

  // OTP rules (spec §7)
  otp: {
    length: 6,
    ttlSeconds: parseInt(process.env.OTP_TTL || '300', 10),   // 5 min
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
    resendCooldown: parseInt(process.env.OTP_RESEND_COOLDOWN || '60', 10),
  },

  // Rate limits (spec §36). requests per window(seconds).
  rateLimits: {
    default: { limit: 120, window: 60 },
    otp: { limit: 5, window: 60 },       // stricter for sensitive endpoints
    login: { limit: 10, window: 60 },
    payment: { limit: 20, window: 60 },
  },

  // Provider selection — swap providers without touching the public API contract (spec §99)
  providers: {
    sms: process.env.SMS_PROVIDER || 'mock',        // mock | twilio | ...
    email: process.env.EMAIL_PROVIDER || 'mock',    // mock | ses | ...
    storage: process.env.STORAGE_PROVIDER || 'mock',// mock | gcs | s3
    ai: process.env.AI_PROVIDER || 'mock',          // mock | gemini
    payment: process.env.PAYMENT_PROVIDER || 'mock',// mock | bkash | nagad
    card: process.env.CARD_PROVIDER || 'sandbox',    // sandbox | stripe | marqeta | rapyd
  },

  storage: {
    gcsBucketPublic: process.env.GCS_BUCKET_PUBLIC || 'neermela-media',
    gcsBucketPrivate: process.env.GCS_BUCKET_PRIVATE || 'neermela-private',
    signedUrlTtl: parseInt(process.env.SIGNED_URL_TTL || '900', 10),
  },
};
