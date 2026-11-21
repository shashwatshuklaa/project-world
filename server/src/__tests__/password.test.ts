import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { User } from '../models/User.js';

describe('Password Hashing & User Model Security', () => {
  it('hashes new passwords with bcrypt (starts with $2a$ or $2b$)', () => {
    const user = new User({
      name: 'Alice',
      email: 'alice@example.com',
      role: 'user',
    });

    user.setPassword('SuperSecret123!');
    assert.ok(user.hashedPassword);
    assert.ok(
      user.hashedPassword.startsWith('$2a$') || user.hashedPassword.startsWith('$2b$'),
      'Password hash must follow standard bcrypt format'
    );
  });

  it('validates correct password successfully', () => {
    const user = new User({
      name: 'Bob',
      email: 'bob@example.com',
      role: 'user',
    });

    user.setPassword('CorrectHorseBatteryStaple');
    assert.equal(user.validatePassword('CorrectHorseBatteryStaple'), true);
    assert.equal(user.validatePassword('WrongPassword'), false);
    assert.equal(user.validatePassword(''), false);
  });

  it('supports backward compatibility with legacy PBKDF2 password hashes', () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const legacyPassword = 'legacyPassword456';
    const legacyHash = crypto
      .pbkdf2Sync(legacyPassword, salt, 1000, 64, 'sha512')
      .toString('hex');

    const legacyUser = new User({
      name: 'Legacy User',
      email: 'legacy@example.com',
      hashedPassword: legacyHash,
      salt: salt,
      role: 'user',
    });

    assert.equal(legacyUser.validatePassword('legacyPassword456'), true);
    assert.equal(legacyUser.validatePassword('wrongPassword'), false);
  });

  it('toSafeObject returns only safe profile attributes without credentials', () => {
    const user = new User({
      name: 'Safe User',
      email: 'safe@example.com',
      role: 'user',
    });
    user.setPassword('mySecretPassword');

    const safe = user.toSafeObject();
    assert.equal(safe.name, 'Safe User');
    assert.equal(safe.email, 'safe@example.com');
    assert.equal(safe.role, 'user');
    assert.equal((safe as any).hashedPassword, undefined);
    assert.equal((safe as any).salt, undefined);
  });

  it('toJSON transform removes sensitive properties during serialization', () => {
    const user = new User({
      name: 'JSON User',
      email: 'json@example.com',
      role: 'user',
    });
    user.setPassword('mySecretPassword');

    const json = JSON.parse(JSON.stringify(user));
    assert.equal(json.name, 'JSON User');
    assert.equal(json.email, 'json@example.com');
    assert.equal(json.hashedPassword, undefined);
    assert.equal(json.salt, undefined);
    assert.equal(json.__v, undefined);
  });
});
