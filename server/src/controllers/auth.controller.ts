import { Request, Response } from 'express';
import { User } from '../models/User.js';
import {
  AUTH_COOKIE_NAME,
  generateToken,
  getAuthCookieOptions,
  getClearCookieOptions,
} from '../utils/token.js';

/**
 * Register a new user account.
 * Assigns default role 'user' strictly on the server.
 */
export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, password } = req.body;

    // 1. Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({ message: 'An account with this email address already exists.' });
      return;
    }

    // 2. Create new user with strictly enforced 'user' role
    const user = new User({
      name,
      email,
      role: 'user', // Enforce 'user' role on server
    });

    // 3. Hash password using bcrypt
    user.setPassword(password);
    await user.save();

    // 4. Issue JWT and set HTTP-only cookie
    const token = generateToken({
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    });

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.status(201).json({
      message: 'User registered successfully.',
      user: user.toSafeObject(),
    });
  } catch (error) {
    console.error('[Auth Controller] Error during registration:', error);
    res.status(500).json({
      message: 'Registration failed due to a server error.',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Log in an existing user with email and password.
 * Sets an HTTP-only JWT cookie upon success.
 * Transparently migrates legacy PBKDF2 passwords to bcrypt upon successful verification.
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    // 1. Find user including password fields
    const user = await User.findOne({ email }).select('+hashedPassword +salt');
    if (!user) {
      res.status(401).json({ message: 'Invalid email or password.' });
      return;
    }

    // 2. Verify password securely
    const isValid = user.validatePassword(password);
    if (!isValid) {
      res.status(401).json({ message: 'Invalid email or password.' });
      return;
    }

    // 3. Automatic password migration:
    // If the account was hashed with legacy PBKDF2, upgrade to bcrypt and clear salt
    const isBcrypt =
      user.hashedPassword.startsWith('$2a$') || user.hashedPassword.startsWith('$2b$');
    if (!isBcrypt && user.salt) {
      user.setPassword(password);
      await user.save();
    }

    // 4. Issue JWT and set HTTP-only cookie
    const token = generateToken({
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    });

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.status(200).json({
      message: 'Login successful.',
      user: user.toSafeObject(),
    });
  } catch (error) {
    console.error('[Auth Controller] Error during login:', error);
    res.status(500).json({
      message: 'Login failed due to a server error.',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Log out the current user by clearing the HTTP-only auth cookie.
 */
export async function logout(_req: Request, res: Response): Promise<void> {
  res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());
  res.status(200).json({ message: 'Logged out successfully.' });
}

/**
 * Retrieve the current authenticated user's profile.
 */
export async function getCurrentUser(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({ message: 'Authentication required. Please log in.' });
      return;
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(401).json({ message: 'User account not found.' });
      return;
    }

    res.status(200).json({
      user: user.toSafeObject(),
    });
  } catch (error) {
    console.error('[Auth Controller] Error fetching current user:', error);
    res.status(500).json({
      message: 'Failed to retrieve user profile.',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
