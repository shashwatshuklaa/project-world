import { Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE_NAME, verifyToken } from '../utils/token.js';
import { User, UserRole } from '../models/User.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Authentication middleware: verifies JWT from HTTP-only cookie
 * (with fallback to Bearer token header) and attaches user identity to req.user.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // 1. Extract token from HTTP-only cookie first
    let token = req.cookies?.[AUTH_COOKIE_NAME];

    // Fallback: Check Authorization header
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ message: 'Authentication required. Please log in.' });
      return;
    }

    // 2. Verify signature and expiration
    const payload = verifyToken(token);

    // 3. Attach authenticated identity to request
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
    };

    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired session. Please log in again.' });
  }
}

/**
 * Authorization middleware: restricts route access to verified admin users.
 * Verifies role against the live database record, never trusting client input.
 */
export async function adminOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user || !req.user.id) {
    res.status(401).json({ message: 'Authentication required. Please log in.' });
    return;
  }

  try {
    // Verify role directly in the database
    const user = await User.findById(req.user.id).select('role');

    if (!user) {
      res.status(401).json({ message: 'User account not found.' });
      return;
    }

    if (user.role !== 'admin') {
      res.status(403).json({ message: 'Forbidden: Admin access required.' });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      message: 'Failed to verify user permissions.',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
