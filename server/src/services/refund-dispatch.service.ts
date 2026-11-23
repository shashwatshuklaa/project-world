import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import {
  RefundJob,
  IRefundJob,
  RefundJobStatus,
  IRefundJobError,
} from '../models/RefundJob.js';
import { getRazorpayClient } from '../config/razorpay.js';

// ============================================================================
// CUSTOM ERROR CLASSES FOR REFUND DISPATCH & LEASING
// ============================================================================

export class RefundJobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundJobNotFoundError';
  }
}

export class RefundJobNotClaimedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundJobNotClaimedError';
  }
}

export class StaleWorkerLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWorkerLeaseError';
  }
}

export class InvalidJobStateForDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobStateForDispatchError';
  }
}

export class PermanentGatewayError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PermanentGatewayError';
    this.statusCode = statusCode;
  }
}

export class UncertainGatewayError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'UncertainGatewayError';
    this.statusCode = statusCode;
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ClaimRefundJobParams {
  workerId: string;
  jobId?: string;
  leaseDurationMs?: number; // Defaults to 60,000ms (1 minute)
  now?: Date;
}

export interface DispatchRefundJobParams {
  jobId: string;
  workerId: string;
  leaseToken: string;
  razorpayClient?: any; // Optional dependency injection for testing
  now?: Date;
}

export interface DispatchRefundResult {
  status: RefundJobStatus;
  providerRefundId?: string;
  refundJob: IRefundJob;
  refund?: IRefund;
  error?: string;
  isRetryable?: boolean;
}

export interface RecoverExpiredLeasesOptions {
  now?: Date;
  batchSize?: number;
}

export interface RecoverExpiredLeasesResult {
  recoveredPendingCount: number;
  recoveredUncertainCount: number;
  recoveredJobs: IRefundJob[];
}

export interface GatewayErrorClassification {
  isUncertain: boolean;
  isRetryable: boolean;
  isRateLimited: boolean;
  isConflict: boolean;
  isPermanent: boolean;
  message: string;
  statusCode?: number;
}

// ============================================================================
// REQUEST-SCOPED CONTEXT & INTERCEPTOR MANAGEMENT
// ============================================================================

export interface RefundDispatchContext {
  providerIdempotencyKey: string;
  jobId: string;
}

/**
 * Node.js AsyncLocalStorage store providing request-scoped context across async call stacks.
 * Guarantees that concurrent refund dispatches sharing the same Razorpay client instance
 * always resolve their own respective provider idempotency key without race conditions.
 */
export const refundDispatchStorage = new AsyncLocalStorage<RefundDispatchContext>();

export function getActiveRefundDispatchContext(): RefundDispatchContext | undefined {
  return refundDispatchStorage.getStore();
}

const initializedClients = new WeakSet<object>();

/**
 * Ensures a single, permanent request interceptor is attached to the Razorpay SDK's Axios instance.
 * Unlike ephemeral per-request interceptors that overlap and overwrite each other under concurrent
 * dispatches, this interceptor dynamically reads the request-scoped providerIdempotencyKey from
 * Node.js AsyncLocalStorage. This guarantees 100% request-isolated idempotency keys without race conditions.
 */
export function ensureRazorpayClientInterceptor(client: any): void {
  if (!client?.api?.rq?.interceptors?.request) return;
  if (initializedClients.has(client)) return;

  client.api.rq.interceptors.request.use((config: any) => {
    const store = refundDispatchStorage.getStore();
    if (store && store.providerIdempotencyKey) {
      config.headers = config.headers || {};
      config.headers['X-Refund-Idempotency'] = store.providerIdempotencyKey;
    }
    return config;
  });

  initializedClients.add(client);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generates a stable, deterministic idempotency key for the Razorpay X-Refund-Idempotency header.
 * Razorpay requires an alphanumeric key of at most 40 characters.
 *
 * We produce a 32-character hexadecimal digest from the sha256 hash of the internal idempotency key.
 * This guarantees:
 * 1. Strict alphanumericity (characters 0-9, a-f).
 * 2. Exactly 32 characters (strictly <= 40).
 * 3. Exact determinism: the identical internal key always produces the exact same provider key across retries.
 */
export function generateProviderRefundIdempotencyKey(internalKey: string): string {
  if (!internalKey || typeof internalKey !== 'string') {
    throw new Error('Internal idempotency key is required to generate provider idempotency key.');
  }
  return crypto.createHash('sha256').update(internalKey.trim()).digest('hex').substring(0, 32);
}

/**
 * Classifies an error received from the Razorpay API or underlying network transport.
 */
export function classifyGatewayError(err: any): GatewayErrorClassification {
  const statusCode =
    err?.statusCode ||
    err?.response?.status ||
    (typeof err?.status === 'number' ? err.status : undefined);

  const rawMessage =
    err?.error?.description ||
    err?.response?.data?.error?.description ||
    err?.message ||
    String(err);

  const errorCode = err?.code || err?.error?.code || '';

  // Network timeouts, socket hangup, connection resets
  const isTimeoutOrSocketError =
    errorCode === 'ECONNABORTED' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ECONNRESET' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'EAI_AGAIN' ||
    /timeout|timed out|socket hang up|connection reset|network error/i.test(rawMessage);

  if (isTimeoutOrSocketError) {
    return {
      isUncertain: true,
      isRetryable: true,
      isRateLimited: false,
      isConflict: false,
      isPermanent: false,
      message: `Gateway network timeout or socket drop: ${rawMessage}`,
      statusCode,
    };
  }

  // 409 Conflict: Existing refund or duplicate idempotency in-flight on gateway
  if (statusCode === 409) {
    return {
      isUncertain: true,
      isRetryable: true,
      isRateLimited: false,
      isConflict: true,
      isPermanent: false,
      message: `Gateway conflict (409): ${rawMessage}`,
      statusCode: 409,
    };
  }

  // 429 Too Many Requests (Rate limit)
  if (statusCode === 429) {
    return {
      isUncertain: false,
      isRetryable: true,
      isRateLimited: true,
      isConflict: false,
      isPermanent: false,
      message: `Gateway rate limit exceeded (429): ${rawMessage}`,
      statusCode: 429,
    };
  }

  // 5xx Server Errors (500, 502, 503, 504)
  if (statusCode && statusCode >= 500 && statusCode < 600) {
    return {
      isUncertain: true,
      isRetryable: true,
      isRateLimited: false,
      isConflict: false,
      isPermanent: false,
      message: `Gateway server error (${statusCode}): ${rawMessage}`,
      statusCode,
    };
  }

  // Permanent 4xx Client Errors (400, 401, 403, 404, 422, etc.)
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return {
      isUncertain: false,
      isRetryable: false,
      isRateLimited: false,
      isConflict: false,
      isPermanent: true,
      message: `Gateway permanent error (${statusCode}): ${rawMessage}`,
      statusCode,
    };
  }

  // Default fallback for unclassified exceptions
  return {
    isUncertain: true,
    isRetryable: true,
    isRateLimited: false,
    isConflict: false,
    isPermanent: false,
    message: `Unknown gateway error: ${rawMessage}`,
    statusCode,
  };
}

// ============================================================================
// CORE SERVICE METHODS
// ============================================================================

/**
 * Claims a refund job atomically using a lease and unique ownership token.
 * Prevents two workers from independently claiming or processing the same job.
 *
 * Eligible jobs have status in ['pending', 'failed_retryable'] and either:
 * - leaseExpiresAt is null, OR
 * - leaseExpiresAt < currentTime (expired lease)
 */
export async function claimRefundJob(params: ClaimRefundJobParams): Promise<IRefundJob | null> {
  const { workerId, jobId, leaseDurationMs = 60_000 } = params;
  const now = params.now || new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const leaseToken = crypto.randomUUID();

  if (!workerId || !workerId.trim()) {
    throw new Error('Worker ID is strictly required to claim a refund job.');
  }

  const query: any = {
    status: { $in: ['pending', 'failed_retryable'] },
    $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }],
  };

  if (jobId) {
    query._id = new mongoose.Types.ObjectId(jobId);
  }

  // Atomically claim the lease
  const claimedJob = await RefundJob.findOneAndUpdate(
    query,
    {
      $set: {
        status: 'processing',
        leaseWorkerId: workerId.trim(),
        leaseToken,
        leaseAcquiredAt: now,
        leaseExpiresAt,
      },
    },
    {
      new: true,
      sort: { createdAt: 1 }, // Claim oldest job first if no specific jobId
    }
  );

  if (!claimedJob) {
    return null;
  }

  // Ensure stable providerIdempotencyKey is initialized before dispatch
  if (!claimedJob.providerIdempotencyKey) {
    const providerKey = generateProviderRefundIdempotencyKey(claimedJob.idempotencyKey);
    claimedJob.providerIdempotencyKey = providerKey;
    await RefundJob.updateOne(
      { _id: claimedJob._id, leaseToken },
      { $set: { providerIdempotencyKey: providerKey } }
    );
  }

  return claimedJob;
}

/**
 * Dispatches a previously reserved refund job to Razorpay.
 *
 * Rules:
 * 1. Only dispatch refunds with a valid pending reservation and matching RefundJob.
 * 2. Uses captured Razorpay payment ID, reserved integer paise, and INR.
 * 3. Uses Razorpay's documented X-Refund-Idempotency header.
 * 4. Reuses exactly the same stable provider idempotency key and request payload for every retry.
 * 5. External Razorpay API request is executed OUTSIDE MongoDB transactions.
 * 6. Verifies lease ownership (leaseToken) before updating database records after API call.
 * 7. Never marks Refund as settled or increases confirmed refund accounting (that is Step 5).
 */
export async function dispatchRefundJob(
  params: DispatchRefundJobParams
): Promise<DispatchRefundResult> {
  const { jobId, workerId, leaseToken } = params;
  const now = params.now || new Date();

  if (!jobId) throw new RefundJobNotFoundError('jobId is required.');
  if (!workerId) throw new Error('workerId is required.');
  if (!leaseToken) throw new StaleWorkerLeaseError('leaseToken is required.');

  // 1. Fetch current job state
  const job = await RefundJob.findById(jobId);
  if (!job) {
    throw new RefundJobNotFoundError(`Refund job ${jobId} was not found.`);
  }

  // 2. Verify lease ownership and active validity
  if (job.leaseToken !== leaseToken || job.leaseWorkerId !== workerId) {
    throw new StaleWorkerLeaseError(
      `Worker ${workerId} with token ${leaseToken} does not hold active lease for job ${jobId} ` +
        `(current worker: ${job.leaseWorkerId}, current token: ${job.leaseToken}).`
    );
  }

  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new StaleWorkerLeaseError(
      `Worker ${workerId} lease for job ${jobId} expired at ${job.leaseExpiresAt.toISOString()} (current time: ${now.toISOString()}).`
    );
  }

  if (job.status !== 'processing') {
    throw new InvalidJobStateForDispatchError(
      `Refund job ${jobId} has status "${job.status}", expected "processing".`
    );
  }

  // 3. Check retry limit
  if (job.attempts >= job.maxRetries) {
    const updated = await RefundJob.findOneAndUpdate(
      { _id: job._id, leaseToken },
      {
        $set: {
          status: 'manual_review',
          manualReviewReason: `Maximum dispatch retries (${job.maxRetries}) exceeded before dispatch.`,
          leaseWorkerId: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
        },
        $push: {
          errorHistory: {
            error: `Maximum dispatch retries (${job.maxRetries}) exceeded. Transitioned to manual_review.`,
            timestamp: now,
          },
        },
      },
      { new: true }
    );
    if (!updated) {
      throw new StaleWorkerLeaseError(`Lease lost while escalating job ${jobId} to manual_review.`);
    }
    return {
      status: 'manual_review',
      refundJob: updated,
      error: `Maximum dispatch retries (${job.maxRetries}) exceeded.`,
      isRetryable: false,
    };
  }

  // 4. Pre-dispatch validations: Associated Refund, PaymentAttempt, and Order
  const refund = await Refund.findOne({ refundJobId: job._id });
  if (!refund) {
    throw new InvalidJobStateForDispatchError(
      `No associated Refund record found for RefundJob ${jobId}.`
    );
  }
  if (refund.status !== 'pending') {
    throw new InvalidJobStateForDispatchError(
      `Associated Refund ${refund.refundId} has status "${refund.status}". Only pending reservations can be dispatched.`
    );
  }

  const paymentAttempt = await PaymentAttempt.findOne({ paymentId: job.targetPaymentId });
  if (!paymentAttempt) {
    throw new InvalidJobStateForDispatchError(
      `Associated PaymentAttempt "${job.targetPaymentId}" was not found.`
    );
  }
  if (paymentAttempt.status !== 'captured') {
    throw new InvalidJobStateForDispatchError(
      `PaymentAttempt "${job.targetPaymentId}" is not captured (current status: "${paymentAttempt.status}"). Only captured payments can be refunded.`
    );
  }

  const order = await Order.findById(job.orderId);
  if (!order) {
    throw new InvalidJobStateForDispatchError(
      `Associated Order ${job.orderId} was not found.`
    );
  }

  // 5. Ensure stable provider idempotency key is set
  const providerIdempotencyKey =
    job.providerIdempotencyKey || generateProviderRefundIdempotencyKey(job.idempotencyKey);

  // 6. Atomically record dispatch intent BEFORE making the external HTTP call
  const intentUpdatedJob = await RefundJob.findOneAndUpdate(
    { _id: job._id, leaseToken },
    {
      $set: {
        apiDispatched: true,
        dispatchRecordedAt: now,
        providerIdempotencyKey,
      },
      $inc: {
        attempts: 1,
      },
    },
    { new: true }
  );

  if (!intentUpdatedJob) {
    throw new StaleWorkerLeaseError(
      `Lease lost for job ${jobId} while recording dispatch intent.`
    );
  }

  // 7. Execute external Razorpay API call OUTSIDE MongoDB transactions
  const client = params.razorpayClient || getRazorpayClient();
  if (!client || !client.payments || typeof client.payments.refund !== 'function') {
    throw new Error('Razorpay client is not configured for refund dispatch.');
  }

  const payload = {
    amount: job.targetAmountPaise,
    notes: {
      orderId: job.orderId.toString(),
      refundJobId: job._id.toString(),
      reason: job.reason,
      classification: job.classification,
    },
  };

  let gatewayResponse: any;
  let gatewayError: any;

  try {
    ensureRazorpayClientInterceptor(client);

    const isNativeSdk =
      Boolean(client?.api?.rq) &&
      typeof client.payments.refund === 'function' &&
      client.payments.refund.toString().includes('api.post');

    gatewayResponse = await refundDispatchStorage.run(
      { providerIdempotencyKey, jobId: job._id.toString() },
      async () => {
        if (isNativeSdk) {
          // Native SDK method delegates to api.post which uses Axios under the hood.
          // The persistent interceptor injects X-Refund-Idempotency isolated via refundDispatchStorage.
          // Passing a 3rd non-function arg to the official SDK causes nodeify callback TypeError.
          return await client.payments.refund(job.targetPaymentId, payload);
        } else {
          // Mock or custom client: pass request-scoped headers directly as 3rd arg options
          return await client.payments.refund(job.targetPaymentId, payload, {
            headers: { 'X-Refund-Idempotency': providerIdempotencyKey },
          });
        }
      }
    );
  } catch (err: any) {
    gatewayError = err;
  }

  // 8. Process Gateway Response or Error with Fencing Verification
  if (!gatewayError && gatewayResponse) {
    const providerRefundId = gatewayResponse.id;
    const returnedStatus = gatewayResponse.status; // 'processed' | 'pending' | 'failed'

    if (returnedStatus === 'processed') {
      // Razorpay processed the refund immediately
      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: job._id, leaseToken },
        {
          $set: {
            status: 'succeeded',
            providerRefundId,
            lastError: null,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
        },
        { new: true }
      );

      if (!postUpdate) {
        throw new StaleWorkerLeaseError(
          `Lease expired or claimed by another worker after successful dispatch of job ${jobId}. Stale update rejected.`
        );
      }

      // Persist providerRefundId on the Refund model.
      // CRUCIAL: Do NOT mark Refund as settled, and do NOT alter Order confirmed refund accounting!
      // Status strictly remains 'pending' until authoritative settlement (Step 5).
      refund.providerRefundId = providerRefundId;
      await refund.save();

      return {
        status: 'succeeded',
        providerRefundId,
        refundJob: postUpdate,
        refund,
      };
    } else if (returnedStatus === 'pending') {
      // Razorpay accepted the refund request but settlement remains pending with the banking network
      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: job._id, leaseToken },
        {
          $set: {
            status: 'pending',
            providerRefundId,
            lastError: null,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
        },
        { new: true }
      );

      if (!postUpdate) {
        throw new StaleWorkerLeaseError(
          `Lease expired or claimed by another worker after pending dispatch of job ${jobId}. Stale update rejected.`
        );
      }

      refund.providerRefundId = providerRefundId;
      await refund.save();

      return {
        status: 'pending',
        providerRefundId,
        refundJob: postUpdate,
        refund,
      };
    } else {
      // Explicit 'failed' status returned by gateway
      const classification = classifyGatewayError({
        statusCode: 400,
        message: `Gateway returned status "${returnedStatus}" for refund ${providerRefundId}`,
      });
      return await handleDispatchFailure(
        job,
        leaseToken,
        classification,
        now,
        intentUpdatedJob.attempts
      );
    }
  }

  // 9. Handle Dispatch Exception / Network Failure
  const classification = classifyGatewayError(gatewayError);
  return await handleDispatchFailure(
    job,
    leaseToken,
    classification,
    now,
    intentUpdatedJob.attempts
  );
}

/**
 * Handles dispatch failure states with strict lease ownership validation.
 */
async function handleDispatchFailure(
  job: IRefundJob,
  leaseToken: string,
  classification: GatewayErrorClassification,
  now: Date,
  currentAttempts: number
): Promise<DispatchRefundResult> {
  let targetStatus: RefundJobStatus;
  let manualReviewReason: string | undefined;

  const errorEntry: IRefundJobError = {
    error: classification.message,
    timestamp: now,
  };

  if (currentAttempts >= job.maxRetries) {
    // Retry threshold exceeded
    targetStatus = 'manual_review';
    manualReviewReason = `Maximum retries (${job.maxRetries}) exceeded. Last error: ${classification.message}`;
  } else if (classification.isPermanent) {
    // Permanent 4xx client or configuration error
    targetStatus = 'manual_review';
    manualReviewReason = `Permanent gateway rejection: ${classification.message}`;
  } else if (classification.isConflict) {
    // 409 Conflict: retains original key and payload without creating new refund
    // Transition to uncertain for reconciliation without re-dispatching blindly
    targetStatus = 'uncertain';
  } else if (classification.isRateLimited) {
    // 429 Rate limited: retryable after backoff
    targetStatus = 'failed_retryable';
  } else if (classification.isUncertain) {
    // Timeout, 5xx, socket drop
    targetStatus = 'uncertain';
  } else {
    targetStatus = 'failed_retryable';
  }

  const updateFields: any = {
    status: targetStatus,
    lastError: classification.message,
    leaseWorkerId: null,
    leaseToken: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
  };

  if (manualReviewReason) {
    updateFields.manualReviewReason = manualReviewReason;
  }

  const postUpdate = await RefundJob.findOneAndUpdate(
    { _id: job._id, leaseToken },
    {
      $set: updateFields,
      $push: { errorHistory: errorEntry },
    },
    { new: true }
  );

  if (!postUpdate) {
    throw new StaleWorkerLeaseError(
      `Lease lost for job ${job._id} while recording dispatch failure. Stale worker update rejected.`
    );
  }

  return {
    status: targetStatus,
    refundJob: postUpdate,
    error: classification.message,
    isRetryable: classification.isRetryable && targetStatus !== 'manual_review',
  };
}

/**
 * Sweeps and recovers jobs whose worker leases have expired.
 *
 * Rules:
 * - If apiDispatched === false: The worker crashed before any network request left the host.
 *   Safely reset status to 'pending' to allow immediate re-claiming.
 * - If apiDispatched === true: The worker recorded dispatch intent before crashing/timing out.
 *   Transition status to 'uncertain' to mandate reconciliation. Never create a second refund.
 */
export async function recoverExpiredLeases(
  options?: RecoverExpiredLeasesOptions
): Promise<RecoverExpiredLeasesResult> {
  const now = options?.now || new Date();
  const batchSize = options?.batchSize || 100;

  // Find processing jobs whose lease expired
  const expiredJobs = await RefundJob.find({
    status: 'processing',
    leaseExpiresAt: { $lte: now },
  })
    .limit(batchSize)
    .exec();

  let recoveredPendingCount = 0;
  let recoveredUncertainCount = 0;
  const recoveredJobs: IRefundJob[] = [];

  for (const job of expiredJobs) {
    if (!job.apiDispatched) {
      // Safe recovery: no external packet was ever dispatched
      const updated = await RefundJob.findOneAndUpdate(
        { _id: job._id, leaseToken: job.leaseToken, status: 'processing' },
        {
          $set: {
            status: 'pending',
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error: 'Worker lease expired before API dispatch; safely reset to pending',
              timestamp: now,
            },
          },
        },
        { new: true }
      );

      if (updated) {
        recoveredPendingCount++;
        recoveredJobs.push(updated);
      }
    } else {
      // Uncertain recovery: external call was sent or in-flight; mandate reconciliation
      const updated = await RefundJob.findOneAndUpdate(
        { _id: job._id, leaseToken: job.leaseToken, status: 'processing' },
        {
          $set: {
            status: 'uncertain',
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error:
                'Worker lease expired after API dispatch was recorded; transitioned to uncertain state for reconciliation',
              timestamp: now,
            },
          },
        },
        { new: true }
      );

      if (updated) {
        recoveredUncertainCount++;
        recoveredJobs.push(updated);
      }
    }
  }

  return {
    recoveredPendingCount,
    recoveredUncertainCount,
    recoveredJobs,
  };
}
