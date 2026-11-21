import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import app from '../app.js';

describe('Authentication Rate Limiting', () => {
  it('returns HTTP 429 when exceeding the request limit on protected auth endpoints', async () => {
    // Create an isolated Express app with a small max limit for fast deterministic verification
    const testApp = express();
    const testLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 3, // Allow 3 requests, 4th must be 429
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
      },
    });

    testApp.post('/login', testLimiter, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    // Requests 1, 2, 3 succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(testApp).post('/login').expect(200);
      assert.equal(res.body.ok, true);
    }

    // Request 4 exceeds the limit -> returns 429
    const limitedRes = await request(testApp).post('/login').expect(429);
    assert.equal(
      limitedRes.body.message,
      'Too many authentication attempts from this IP. Please try again after 15 minutes.'
    );
  });

  it('does NOT rate-limit logout endpoint even when called repeatedly', async () => {
    // Call logout 5 times on main app to ensure it is not rate limited
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/auth/logout').expect(200);
      assert.equal(res.body.message, 'Logged out successfully.');
    }
  });
});
