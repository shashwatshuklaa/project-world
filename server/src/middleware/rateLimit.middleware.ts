import rateLimit from 'express-rate-limit';

/**
 * Authentication rate limiter:
 * Restricts sensitive auth endpoints (login and register) to 10 requests per IP per 15 minutes.
 * Mitigates brute-force credential stuffing and mass registration attacks.
 * Returns HTTP 429 Too Many Requests when the threshold is exceeded.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP
  standardHeaders: true, // Draft-6/Draft-7 RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  statusCode: 429,
  message: {
    message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
  },
});

export default authRateLimiter;
