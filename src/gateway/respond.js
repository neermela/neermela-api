// Standardized envelopes (spec §58, §59). Every response carries a request_id.

export function ok(res, data = {}, meta = null) {
  const body = { success: true, data, request_id: res.locals.requestId };
  if (meta) body.pagination = meta;
  return res.json(body);
}

export function created(res, data = {}) {
  return res.status(201).json({ success: true, data, request_id: res.locals.requestId });
}

// Typed API error. Throw these from anywhere; the error handler formats them.
export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  validation: (msg = 'Invalid request.', details) => new ApiError(400, 'VALIDATION_ERROR', msg, details),
  unauthorized: (msg = 'Authentication required.') => new ApiError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'You do not have access to this resource.') => new ApiError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Not found.') => new ApiError(404, 'NOT_FOUND', msg),
  conflict: (code, msg) => new ApiError(409, code, msg),
  rateLimited: (msg = 'Too many requests. Slow down.') => new ApiError(429, 'RATE_LIMITED', msg),
  otpExpired: () => new ApiError(400, 'OTP_EXPIRED', 'Verification code has expired.'),
  otpInvalid: () => new ApiError(400, 'OTP_INVALID', 'The code you entered is incorrect.'),
  otpLocked: () => new ApiError(429, 'OTP_LOCKED', 'Too many attempts. Try again later.'),
  internal: (msg = 'Something went wrong on our side.') => new ApiError(500, 'INTERNAL_ERROR', msg),
};
