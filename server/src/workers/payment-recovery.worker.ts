import { fileURLToPath } from 'url';
import { WorkerConfig, getWorkerConfig } from '../config/worker.config.js';
import { runRecoverySweep, RecoverySweepSummary } from '../services/recovery.service.js';
import { loadEnv } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';

export interface PaymentRecoveryWorkerOptions {
  config?: Partial<WorkerConfig>;
  workerId?: string;
  razorpayClient?: any;
}

export interface SweepOverlapSkipped {
  skippedDueToOverlap: true;
  workerId: string;
  timestamp: Date;
}

/**
 * Background Payment and Refund Recovery Worker.
 *
 * Provides a resilient background loop to:
 * 1. Sweep expired WebhookEvent leases and reset or fail them.
 * 2. Sweep expired RefundJob leases and reset un-dispatched jobs to 'pending' or dispatched jobs to 'uncertain'.
 * 3. Authoritatively reconcile 'uncertain' refund outcomes with Razorpay via SDK queries.
 * 4. Settle pending refunds whose webhooks were dropped or delayed.
 * 5. Dispatch retryable refund jobs honoring exponential backoff cooldowns.
 *
 * Guarantees:
 * - Single-process non-overlapping sweeps (isSweeping guard).
 * - Multi-process safety via atomic MongoDB leases (findOneAndUpdate + leaseTokens).
 * - Stale worker fencing tokens.
 * - Clean startup and graceful shutdown awaiting in-flight sweeps.
 */
export class PaymentRecoveryWorker {
  private config: WorkerConfig;
  private workerId: string;
  private isRunning: boolean = false;
  private isSweeping: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private currentSweepPromise: Promise<RecoverySweepSummary | SweepOverlapSkipped> | null = null;
  private razorpayClient?: any;

  constructor(options?: PaymentRecoveryWorkerOptions) {
    this.config = getWorkerConfig(options?.config);
    this.workerId = options?.workerId || this.config.workerId;
    this.razorpayClient = options?.razorpayClient;
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getIsSweeping(): boolean {
    return this.isSweeping;
  }

  public getConfig(): WorkerConfig {
    return this.config;
  }

  /**
   * Starts the worker background loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    // Trigger initial sweep immediately upon startup
    this.triggerSweepSafe();

    // Schedule recurring sweeps
    this.timer = setInterval(() => {
      this.triggerSweepSafe();
    }, this.config.sweepIntervalMs);

    // Unref timer so that background timer does not hold open Node.js test runners
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Safe sweep trigger that guards against overlapping invocations.
   */
  private triggerSweepSafe(): void {
    if (!this.isRunning || this.isSweeping) {
      return;
    }

    this.currentSweepPromise = this.runSweep()
      .catch((err) => {
        console.error(`[RecoveryWorker:${this.workerId}] Unhandled sweep error:`, err);
        return {
          skippedDueToOverlap: true,
          workerId: this.workerId,
          timestamp: new Date(),
        } as SweepOverlapSkipped;
      })
      .finally(() => {
        this.currentSweepPromise = null;
      });
  }

  /**
   * Runs a single non-overlapping recovery sweep pass.
   */
  public async runSweep(now?: Date): Promise<RecoverySweepSummary | SweepOverlapSkipped> {
    if (this.isSweeping) {
      return {
        skippedDueToOverlap: true,
        workerId: this.workerId,
        timestamp: now || new Date(),
      };
    }

    this.isSweeping = true;
    try {
      return await runRecoverySweep({
        workerId: this.workerId,
        config: this.config,
        now: now || new Date(),
        razorpayClient: this.razorpayClient,
      });
    } finally {
      this.isSweeping = false;
    }
  }

  /**
   * Stops the worker gracefully, waiting for in-flight sweeps to complete.
   */
  public async stop(timeoutMs: number = 10_000): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for in-flight sweep to finish cleanly within timeoutMs
    if (this.currentSweepPromise) {
      const timeoutPromise = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      });

      await Promise.race([this.currentSweepPromise, timeoutPromise]);
      this.currentSweepPromise = null;
    }
  }
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  return process.argv[1] === scriptPath || process.argv[1].endsWith('payment-recovery.worker.ts') || process.argv[1].endsWith('payment-recovery.worker.js');
}

if (isExecutedDirectly()) {
  loadEnv();

  connectDB()
    .then(async () => {
      console.log('[RecoveryWorker] Database connected. Starting payment recovery worker...');
      const worker = new PaymentRecoveryWorker();
      await worker.start();
      console.log(
        `[RecoveryWorker] Worker ${worker.getWorkerId()} started (interval: ${worker.getConfig().sweepIntervalMs}ms, lease: ${worker.getConfig().leaseDurationMs}ms)`
      );

      const gracefulShutdown = async (signal: string) => {
        console.log(`[RecoveryWorker] Received ${signal}. Shutting down worker gracefully...`);
        await worker.stop();
        await disconnectDB();
        console.log('[RecoveryWorker] Shutdown complete.');
        process.exit(0);
      };

      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    })
    .catch((err) => {
      console.error('[RecoveryWorker] Fatal startup error:', err);
      process.exit(1);
    });
}

export default PaymentRecoveryWorker;
