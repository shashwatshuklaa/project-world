import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth, adminOnly } from '../middleware/auth.middleware.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';
import { User } from '../models/User.js';

describe('Auth & Authorization Middleware', () => {
  describe('requireAuth', () => {
    it('returns 401 when neither cookie nor Authorization header is present', async () => {
      let statusCode = 0;
      let jsonPayload: any = null;
      let nextCalled = false;

      const req: any = { cookies: {}, headers: {} };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (payload: any) => {
              jsonPayload = payload;
            },
          };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      await requireAuth(req, res, next);
      assert.equal(statusCode, 401);
      assert.equal(nextCalled, false);
      assert.equal(jsonPayload.message, 'Authentication required. Please log in.');
    });

    it('returns 401 when token is invalid or corrupted', async () => {
      let statusCode = 0;
      let nextCalled = false;

      const req: any = {
        cookies: { [AUTH_COOKIE_NAME]: 'invalid-token' },
        headers: {},
      };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return { json: () => {} };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      await requireAuth(req, res, next);
      assert.equal(statusCode, 401);
      assert.equal(nextCalled, false);
    });

    it('attaches req.user and calls next() when valid token is in HTTP-only cookie', async () => {
      const token = generateToken({
        id: '674000000000000000000002',
        email: 'authenticated@example.com',
        role: 'user',
      });

      let nextCalled = false;
      const req: any = {
        cookies: { [AUTH_COOKIE_NAME]: token },
        headers: {},
      };
      const res: any = {};
      const next = () => {
        nextCalled = true;
      };

      await requireAuth(req, res, next);
      assert.equal(nextCalled, true);
      assert.equal(req.user.id, '674000000000000000000002');
      assert.equal(req.user.email, 'authenticated@example.com');
      assert.equal(req.user.role, 'user');
    });

    it('attaches req.user when valid token is in Bearer authorization header', async () => {
      const token = generateToken({
        id: '674000000000000000000003',
        email: 'bearer@example.com',
        role: 'admin',
      });

      let nextCalled = false;
      const req: any = {
        cookies: {},
        headers: { authorization: `Bearer ${token}` },
      };
      const res: any = {};
      const next = () => {
        nextCalled = true;
      };

      await requireAuth(req, res, next);
      assert.equal(nextCalled, true);
      assert.equal(req.user.id, '674000000000000000000003');
      assert.equal(req.user.role, 'admin');
    });
  });

  describe('adminOnly', () => {
    it('returns 401 if req.user is missing', async () => {
      let statusCode = 0;
      let nextCalled = false;
      const req: any = {};
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return { json: () => {} };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      await adminOnly(req, res, next);
      assert.equal(statusCode, 401);
      assert.equal(nextCalled, false);
    });

    it('rejects ordinary user with 403 Forbidden using database role verification', async () => {
      // Mock User.findById to return a user with role 'user'
      const originalFindById = User.findById;
      (User as any).findById = () => ({
        select: async () => ({
          _id: '674000000000000000000004',
          role: 'user',
        }),
      });

      let statusCode = 0;
      let jsonPayload: any = null;
      let nextCalled = false;

      const req: any = {
        user: { id: '674000000000000000000004', role: 'user', email: 'user@example.com' },
      };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (payload: any) => {
              jsonPayload = payload;
            },
          };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      try {
        await adminOnly(req, res, next);
        assert.equal(statusCode, 403);
        assert.equal(nextCalled, false);
        assert.equal(jsonPayload.message, 'Forbidden: Admin access required.');
      } finally {
        (User as any).findById = originalFindById;
      }
    });

    it('permits admin user and calls next() after verifying role in database', async () => {
      // Mock User.findById to return a verified admin
      const originalFindById = User.findById;
      (User as any).findById = () => ({
        select: async () => ({
          _id: '674000000000000000000005',
          role: 'admin',
        }),
      });

      let nextCalled = false;
      const req: any = {
        user: { id: '674000000000000000000005', role: 'admin', email: 'admin@example.com' },
      };
      const res: any = {};
      const next = () => {
        nextCalled = true;
      };

      try {
        await adminOnly(req, res, next);
        assert.equal(nextCalled, true);
      } finally {
        (User as any).findById = originalFindById;
      }
    });
  });
});
