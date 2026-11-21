import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { serverEnvPath, rootEnvPath, loadEnv } from '../config/env.js';

describe('Standardized Environment Configuration Loader', () => {
  it('resolves valid paths for server/.env and root .env', () => {
    assert.ok(serverEnvPath.endsWith('server/.env'), 'serverEnvPath must point to server/.env');
    assert.ok(rootEnvPath.endsWith('project_world/.env'), 'rootEnvPath must point to project_world/.env');
  });

  it('preserves existing operating system environment variables', () => {
    process.env.TEST_PRESERVED_OS_VAR = 'os_original_value';

    loadEnv();

    assert.equal(
      process.env.TEST_PRESERVED_OS_VAR,
      'os_original_value',
      'OS-level environment variables must never be overridden by dotenv'
    );

    delete process.env.TEST_PRESERVED_OS_VAR;
  });

  it('loads server/.env without throwing', () => {
    assert.doesNotThrow(() => {
      loadEnv();
    });
  });
});
