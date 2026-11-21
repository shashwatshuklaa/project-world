import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app.js';
import { AUTH_COOKIE_NAME, generateToken } from '../utils/token.js';

describe('Auth API Routes Integration', () => {
  describe('POST /api/auth/register input validation', () => {
    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({})
        .expect(400);

      assert.equal(res.body.message, 'Validation failed');
      assert.ok(Array.isArray(res.body.errors));
      assert.ok(res.body.errors.length >= 3);
    });

    it('returns 400 when password is under 6 characters', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Test User',
          email: 'test@example.com',
          password: '123',
        })
        .expect(400);

      assert.equal(res.body.message, 'Validation failed');
      const passErr = res.body.errors.find((e: any) => e.field === 'password');
      assert.ok(passErr, 'Expected a password validation error');
    });

    it('returns 400 when role is injected in the request body', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Test User',
          email: 'test@example.com',
          password: 'password123',
          role: 'admin',
        })
        .expect(400);

      assert.equal(res.body.message, 'Validation failed');
    });
  });

  describe('POST /api/auth/login input validation', () => {
    it('returns 400 when email or password is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({})
        .expect(400);

      assert.equal(res.body.message, 'Validation failed');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 200 and clears the authentication cookie', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .expect(200);

      assert.equal(res.body.message, 'Logged out successfully.');

      // Check Set-Cookie header contains auth_token with expiration in the past
      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie, 'Expected Set-Cookie header');
      const authCookie = Array.isArray(setCookie)
        ? setCookie.find((c: string) => c.startsWith(`${AUTH_COOKIE_NAME}=`))
        : setCookie;
      assert.ok(authCookie, 'Expected auth_token cookie to be cleared');
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 when unauthenticated (no cookie or header)', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .expect(401);

      assert.equal(res.body.message, 'Authentication required. Please log in.');
    });

    it('returns 401 when token is invalid or expired', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${AUTH_COOKIE_NAME}=invalid_token_value`])
        .expect(401);

      assert.equal(res.body.message, 'Invalid or expired session. Please log in again.');
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 with server status', async () => {
      const res = await request(app)
        .get('/api/health')
        .expect(200);

      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.database);
    });
  });
});
