import crypto from 'crypto';

export interface WorkerConfig {
  sweepIntervalMs: number;
  batchSize: number;
  leaseDurationMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  workerId: string;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  sweepIntervalMs: 30_000, // 30 seconds between recurring sweeps
  batchSize: 50, // Max records fetched per phase per sweep pass
  leaseDurationMs: 60_000, // 60 seconds lease duration for worker fencing
  maxRetries: 3, // Max automated attempts before escalating to manual_review
  baseBackoffMs: 5_000, // 5 seconds initial backoff
  maxBackoffMs: 300_000, // 5 minutes max backoff ceiling
  workerId: `worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
};

/**
 * Validates worker configuration parameters against safe architectural bounds.
 */
export function validateWorkerConfig(config: Partial<WorkerConfig>): WorkerConfig {
  const merged: WorkerConfig = {
    sweepIntervalMs: config.sweepIntervalMs ?? DEFAULT_WORKER_CONFIG.sweepIntervalMs,
    batchSize: config.batchSize ?? DEFAULT_WORKER_CONFIG.batchSize,
    leaseDurationMs: config.leaseDurationMs ?? DEFAULT_WORKER_CONFIG.leaseDurationMs,
    maxRetries: config.maxRetries ?? DEFAULT_WORKER_CONFIG.maxRetries,
    baseBackoffMs: config.baseBackoffMs ?? DEFAULT_WORKER_CONFIG.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs ?? DEFAULT_WORKER_CONFIG.maxBackoffMs,
    workerId: config.workerId || `worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
  };

  if (!Number.isInteger(merged.sweepIntervalMs) || merged.sweepIntervalMs < 1_000) {
    throw new Error(
      `Invalid sweepIntervalMs: ${merged.sweepIntervalMs}. Must be an integer >= 1000ms.`
    );
  }

  if (!Number.isInteger(merged.batchSize) || merged.batchSize < 1 || merged.batchSize > 500) {
    throw new Error(
      `Invalid batchSize: ${merged.batchSize}. Must be an integer between 1 and 500.`
    );
  }

  if (!Number.isInteger(merged.leaseDurationMs) || merged.leaseDurationMs < 5_000) {
    throw new Error(
      `Invalid leaseDurationMs: ${merged.leaseDurationMs}. Must be an integer >= 5000ms.`
    );
  }

  if (!Number.isInteger(merged.maxRetries) || merged.maxRetries < 1 || merged.maxRetries > 50) {
    throw new Error(
      `Invalid maxRetries: ${merged.maxRetries}. Must be an integer between 1 and 50.`
    );
  }

  if (!Number.isInteger(merged.baseBackoffMs) || merged.baseBackoffMs < 500) {
    throw new Error(
      `Invalid baseBackoffMs: ${merged.baseBackoffMs}. Must be an integer >= 500ms.`
    );
  }

  if (!Number.isInteger(merged.maxBackoffMs) || merged.maxBackoffMs < merged.baseBackoffMs) {
    throw new Error(
      `Invalid maxBackoffMs: ${merged.maxBackoffMs}. Must be an integer >= baseBackoffMs (${merged.baseBackoffMs}ms).`
    );
  }

  if (typeof merged.workerId !== 'string' || !merged.workerId.trim()) {
    throw new Error('Worker ID must be a non-empty string.');
  }

  return Object.freeze(merged);
}

/**
 * Loads worker configuration from environment variables with safe defaults and overrides.
 */
export function getWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const envConfig: Partial<WorkerConfig> = {};

  if (process.env.RECOVERY_SWEEP_INTERVAL_MS) {
    const val = parseInt(process.env.RECOVERY_SWEEP_INTERVAL_MS, 10);
    if (!isNaN(val)) envConfig.sweepIntervalMs = val;
  }

  if (process.env.RECOVERY_BATCH_SIZE) {
    const val = parseInt(process.env.RECOVERY_BATCH_SIZE, 10);
    if (!isNaN(val)) envConfig.batchSize = val;
  }

  if (process.env.RECOVERY_LEASE_DURATION_MS) {
    const val = parseInt(process.env.RECOVERY_LEASE_DURATION_MS, 10);
    if (!isNaN(val)) envConfig.leaseDurationMs = val;
  }

  if (process.env.RECOVERY_MAX_RETRIES) {
    const val = parseInt(process.env.RECOVERY_MAX_RETRIES, 10);
    if (!isNaN(val)) envConfig.maxRetries = val;
  }

  if (process.env.RECOVERY_BASE_BACKOFF_MS) {
    const val = parseInt(process.env.RECOVERY_BASE_BACKOFF_MS, 10);
    if (!isNaN(val)) envConfig.baseBackoffMs = val;
  }

  if (process.env.RECOVERY_MAX_BACKOFF_MS) {
    const val = parseInt(process.env.RECOVERY_MAX_BACKOFF_MS, 10);
    if (!isNaN(val)) envConfig.maxBackoffMs = val;
  }

  if (process.env.RECOVERY_WORKER_ID) {
    envConfig.workerId = process.env.RECOVERY_WORKER_ID.trim();
  }

  return validateWorkerConfig({
    ...envConfig,
    ...overrides,
  });
}
