import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { login } from '../controllers/auth.controller.js';
import { User } from '../models/User.js';

describe('Automatic PBKDF2 to Bcrypt Password Migration', () => {
  it('transparently upgrades legacy PBKDF2 passwords to bcrypt upon successful login', async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const rawPassword = 'legacyPassword123';
    const legacyHash = crypto
      .pbkdf2Sync(rawPassword, salt, 1000, 64, 'sha512')
      .toString('hex');

    let saveCalled = false;
    let savedHash = '';
    let savedSalt = 'not-cleared';

    // Create a mock user instance behaving like a Mongoose document
    const mockUser: any = new User({
      name: 'Legacy User',
      email: 'legacy@example.com',
      hashedPassword: legacyHash,
      salt: salt,
      role: 'user',
    });

    // Intercept save to track migration
    mockUser.save = async () => {
      saveCalled = true;
      savedHash = mockUser.hashedPassword;
      savedSalt = mockUser.salt;
      return mockUser;
    };

    const originalFindOne = User.findOne;
    (User as any).findOne = () => ({
      select: async () => mockUser,
    });

    let statusCode = 0;
    let jsonResponse: any = null;
    let cookieSet = false;

    const req: any = {
      body: {
        email: 'legacy@example.com',
        password: rawPassword,
      },
    };

    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (data: any) => {
            jsonResponse = data;
          },
        };
      },
      cookie: () => {
        cookieSet = true;
      },
    };

    try {
      await login(req, res);

      // Assert login succeeded
      assert.equal(statusCode, 200);
      assert.equal(cookieSet, true);
      assert.equal(jsonResponse.message, 'Login successful.');

      // Assert password was migrated
      assert.equal(saveCalled, true, 'User document must be saved with upgraded password');
      assert.ok(
        savedHash.startsWith('$2a$') || savedHash.startsWith('$2b$'),
        'Migrated hash must use bcrypt format'
      );
      assert.equal(savedSalt, '', 'Salt must be cleared for bcrypt accounts');
    } finally {
      (User as any).findOne = originalFindOne;
    }
  });

  it('does NOT upgrade or save password when submitted password is incorrect', async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const rawPassword = 'correctPassword';
    const legacyHash = crypto
      .pbkdf2Sync(rawPassword, salt, 1000, 64, 'sha512')
      .toString('hex');

    let saveCalled = false;
    const mockUser: any = new User({
      name: 'Legacy User',
      email: 'legacy@example.com',
      hashedPassword: legacyHash,
      salt: salt,
      role: 'user',
    });
    mockUser.save = async () => {
      saveCalled = true;
    };

    const originalFindOne = User.findOne;
    (User as any).findOne = () => ({
      select: async () => mockUser,
    });

    let statusCode = 0;
    const req: any = {
      body: {
        email: 'legacy@example.com',
        password: 'incorrectPassword',
      },
    };
    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
      cookie: () => {},
    };

    try {
      await login(req, res);
      assert.equal(statusCode, 401);
      assert.equal(saveCalled, false, 'Must never save or upgrade password on failed verification');
    } finally {
      (User as any).findOne = originalFindOne;
    }
  });

  it('does NOT redundantly re-hash or save already-migrated bcrypt accounts', async () => {
    const rawPassword = 'bcryptPassword123';
    let saveCalled = false;

    const mockUser: any = new User({
      name: 'Bcrypt User',
      email: 'bcrypt@example.com',
      role: 'user',
    });
    mockUser.setPassword(rawPassword);
    const initialBcryptHash = mockUser.hashedPassword;

    mockUser.save = async () => {
      saveCalled = true;
    };

    const originalFindOne = User.findOne;
    (User as any).findOne = () => ({
      select: async () => mockUser,
    });

    let statusCode = 0;
    const req: any = {
      body: {
        email: 'bcrypt@example.com',
        password: rawPassword,
      },
    };
    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
      cookie: () => {},
    };

    try {
      await login(req, res);
      assert.equal(statusCode, 200);
      assert.equal(saveCalled, false, 'Bcrypt accounts should not be saved redundantly on login');
      assert.equal(mockUser.hashedPassword, initialBcryptHash);
    } finally {
      (User as any).findOne = originalFindOne;
    }
  });
});
