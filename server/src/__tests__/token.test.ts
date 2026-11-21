import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateToken,
  verifyToken,
  getAuthCookieOptions,
  getClearCookieOptions,
  AUTH_COOKIE_NAME,
  COOKIE_MAX_AGE_MS,
} from '../utils/token.js';

describe('JWT & Cookie Token Utilities', () => {
  const mockPayload = {
    id: '674000000000000000000001',
    email: 'token.user@example.com',
    role: 'user' as const,
  };

  it('generates a valid signed JWT', () => {
    const token = generateToken(mockPayload);
    assert.ok(token);
    assert.equal(typeof token, 'string');
    assert.equal(token.split('.').length, 3, 'JWT must contain three parts');
  });

  it('verifies a valid token and extracts payload', () => {
    const token = generateToken(mockPayload);
    const decoded = verifyToken(token);
    assert.equal(decoded.id, mockPayload.id);
    assert.equal(decoded.email, mockPayload.email);
    assert.equal(decoded.role, mockPayload.role);
  });

  it('rejects tampered tokens', () => {
    const token = generateToken(mockPayload);
    const tampered = token.slice(0, -5) + 'abcde';
    assert.throws(() => {
      verifyToken(tampered);
    });
  });

  it('rejects malformed tokens', () => {
    assert.throws(() => {
      verifyToken('not.a.valid.jwt');
    });
  });

  it('configures HTTP-only cookie options securely', () => {
    const options = getAuthCookieOptions();
    assert.equal(options.httpOnly, true, 'Cookie must be httpOnly');
    assert.equal(options.path, '/');
    assert.equal(options.maxAge, COOKIE_MAX_AGE_MS);
    assert.equal(AUTH_COOKIE_NAME, 'auth_token');
  });

  it('provides matching clear cookie options', () => {
    const clearOptions = getClearCookieOptions();
    assert.equal(clearOptions.httpOnly, true);
    assert.equal(clearOptions.path, '/');
  });
});
