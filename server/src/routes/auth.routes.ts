import { Router } from 'express';
import {
  register,
  login,
  logout,
  getCurrentUser,
} from '../controllers/auth.controller.js';
import { validateBody, registerSchema, loginSchema } from '../validators/auth.validator.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authRateLimiter } from '../middleware/rateLimit.middleware.js';

const router = Router();

// Public auth endpoints protected with rate limiting (10 requests per 15 minutes per IP)
router.post('/register', authRateLimiter, validateBody(registerSchema), register);
router.post('/login', authRateLimiter, validateBody(loginSchema), login);

// Non-rate-limited auth endpoints
router.post('/logout', logout);
router.get('/me', requireAuth, getCurrentUser);

export default router;
