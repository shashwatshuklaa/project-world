import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema, loginSchema } from '../validators/auth.validator.js';

describe('Auth Validation Schemas', () => {
  describe('registerSchema', () => {
    it('accepts valid registration input', async () => {
      const valid = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'securePassword123',
      };
      const result = await registerSchema.parseAsync(valid);
      assert.equal(result.name, 'Jane Doe');
      assert.equal(result.email, 'jane@example.com');
      assert.equal(result.password, 'securePassword123');
    });

    it('rejects short password (< 6 characters)', async () => {
      const invalid = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: '123',
      };
      await assert.rejects(async () => {
        await registerSchema.parseAsync(invalid);
      });
    });

    it('rejects invalid email address', async () => {
      const invalid = {
        name: 'Jane Doe',
        email: 'not-an-email',
        password: 'securePassword123',
      };
      await assert.rejects(async () => {
        await registerSchema.parseAsync(invalid);
      });
    });

    it('rejects registration payload with client-injected role', async () => {
      const injectionAttempt = {
        name: 'Attacker',
        email: 'attacker@example.com',
        password: 'securePassword123',
        role: 'admin',
      };
      await assert.rejects(async () => {
        await registerSchema.parseAsync(injectionAttempt);
      });
    });

    it('normalizes email to lowercase and trims whitespace', async () => {
      const input = {
        name: '  John Smith  ',
        email: '  JOHN.SMITH@EXAMPLE.COM  ',
        password: 'password123',
      };
      const result = await registerSchema.parseAsync(input);
      assert.equal(result.name, 'John Smith');
      assert.equal(result.email, 'john.smith@example.com');
    });
  });

  describe('loginSchema', () => {
    it('accepts valid login input', async () => {
      const valid = {
        email: 'user@example.com',
        password: 'myPassword123',
      };
      const result = await loginSchema.parseAsync(valid);
      assert.equal(result.email, 'user@example.com');
      assert.equal(result.password, 'myPassword123');
    });

    it('rejects login with empty password', async () => {
      const invalid = {
        email: 'user@example.com',
        password: '',
      };
      await assert.rejects(async () => {
        await loginSchema.parseAsync(invalid);
      });
    });

    it('rejects login with invalid email', async () => {
      const invalid = {
        email: 'invalid-email',
        password: 'password123',
      };
      await assert.rejects(async () => {
        await loginSchema.parseAsync(invalid);
      });
    });
  });
});
