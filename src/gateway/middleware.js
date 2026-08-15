// API Gateway middleware (spec §3): request id, logging, auth, rate limit,
// idempotency, and the unified error handler.
import { requestId as newRequestId } from '../lib/ids.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { rateLimit as rl } from '../cache/redis.js';
import { ApiError } from './respond.js';
import { config } from '../config/index.js';
import { redis } from '../cache/redis.js';

// Attach a request id to every request (spec §58).
export function requestId(req, res, next) {
  const rid = req.header('X-Request-Id') || newRequestId();
  res.locals.requestId = rid;
  res.setHeader('X-Request-Id', rid);
  next();
}

// Structured request log (spec §56 observability).
export function accessLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const line = {
      t: new Date().toISOString(),
      rid: res.locals.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
    };
    console.log(JSON.stringify(line));
  });
  next();
}

// Rate limiting factory (spec §36). bucket picks the policy.
export function rateLimit(bucket = 'default') {
  const policy = config.rateLimits[bucket] || config.rateLimits.default;
  return async (req, res, next) => {
    try {
      const key = `${bucket}:${req.ip}`;
      const { allowed, remaining, resetIn } = await rl(key, policy.limit, policy.window);
      res.setHeader('X-RateLimit-Limit', policy.limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetIn);
      if (!allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Slow down.');
      next();
    } catch (e) { next(e); }
  };
}

// Bearer-token auth (spec §9). Sets req.auth = { userId, sessionId, scopes }.
export function requireAuth(req, res, next) {
  const h = req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new ApiError(401, 'UNAUTHORIZED', 'Authentication required.'));
  try {
    const p = verifyAccessToken(token);
    req.auth = { userId: p.sub, sessionId: p.sid, scopes: (p.scope || '').split(' ').filter(Boolean) };
    next();
  } catch (e) {
    next(new ApiError(401, 'TOKEN_INVALID', 'Session expired. Please sign in again.'));
  }
}

// Scope check for granular API permissions (spec §32).
export function requireScope(scope) {
  return (req, res, next) => {
    if (!req.auth?.scopes?.includes(scope)) return next(new ApiError(403, 'FORBIDDEN', `Missing scope: ${scope}`));
    next();
  };
}

// Idempotency for critical POSTs (spec §60). Replays return the stored response.
export function idempotency(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key) return next();
  const cacheKey = `idem:${req.method}:${req.path}:${key}`;
  redis.get(cacheKey).then((cached) => {
    if (cached) {
      const { status, body } = JSON.parse(cached);
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(status).json(body);
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      redis.set(cacheKey, JSON.stringify({ status: res.statusCode, body }), 'EX', 86400).catch(() => {});
      return origJson(body);
    };
    next();
  }).catch(() => next());
}

// Unified error handler (spec §58). Always the last middleware.
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', res.locals.requestId, err);
  res.status(status).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 ? 'Something went wrong on our side.' : err.message,
      ...(err.details ? { details: err.details } : {}),
      request_id: res.locals.requestId,
    },
  });
}

export function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.', request_id: res.locals.requestId },
  });
}
