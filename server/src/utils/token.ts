import jwt from 'jsonwebtoken';
import { CookieOptions } from 'express';
import { UserRole } from '../models/User.js';

export const AUTH_COOKIE_NAME = 'auth_token';

// JWT Expiration: 7 days
export const TOKEN_EXPIRY = '7d';
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

export interface TokenPayload {
  id: string;
  email: string;
  role: UserRole;
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable is required in production.');
    }
    // Safe development fallback
    return 'dev_insecure_jwt_secret_key_for_local_testing_only_32_chars';
  }
  return secret;
}

export function generateToken(payload: TokenPayload): string {
  const secret = getJwtSecret();
  return jwt.sign(payload, secret, {
    expiresIn: TOKEN_EXPIRY,
  });
}

export function verifyToken(token: string): TokenPayload {
  const secret = getJwtSecret();
  const decoded = jwt.verify(token, secret) as TokenPayload;
  return decoded;
}

export function getAuthCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

export function getClearCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}
