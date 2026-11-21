import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Resolve directory of this file
const currentDir = path.dirname(fileURLToPath(import.meta.url));

// server/ directory is two levels up from src/config or dist/config
const serverDir = path.resolve(currentDir, '../..');
// project root directory is one level up from server/
const rootDir = path.resolve(serverDir, '..');

export const serverEnvPath = path.resolve(serverDir, '.env');
export const rootEnvPath = path.resolve(rootDir, '.env');

let envLoaded = false;

/**
 * Standardized environment loader.
 * Ensures server/.env always takes precedence over the project root .env,
 * preserves existing OS environment variables, and works identically
 * regardless of the working directory from which node/npm was invoked.
 */
export function loadEnv(): void {
  if (envLoaded) {
    return;
  }

  // 1. Load server/.env first (takes priority)
  if (fs.existsSync(serverEnvPath)) {
    dotenv.config({ path: serverEnvPath });
  }

  // 2. Load root .env second as fallback for any keys not in server/.env
  // (dotenv will not overwrite variables already present in process.env)
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
  }

  // 3. Additional fallback based on process.cwd() if run in non-standard layout
  const cwdServerEnv = path.resolve(process.cwd(), 'server/.env');
  if (fs.existsSync(cwdServerEnv) && cwdServerEnv !== serverEnvPath) {
    dotenv.config({ path: cwdServerEnv });
  }

  const cwdEnv = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(cwdEnv) && cwdEnv !== rootEnvPath && cwdEnv !== serverEnvPath) {
    dotenv.config({ path: cwdEnv });
  }

  envLoaded = true;
}

// Auto-load on import
loadEnv();

export default loadEnv;
