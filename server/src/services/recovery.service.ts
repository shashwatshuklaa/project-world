import crypto from 'crypto';
import mongoose from 'mongoose';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob, RefundJobStatus } from '../models/RefundJob.js';
import { WebhookEvent, IWebhookEvent, completeWebhookEvent } from '../models/WebhookEvent.js';
import { getRazorpayClient } from '../config/razorpay.js';
import {
  claimRefundJob,
  dispatchRefundJob,
  recoverExpiredLeases,
  RecoverExpiredLeasesResult,
} from './refund-dispatch.service.js';
import {
  fetchAuthoritativeGatewayRefund,
  processRefundSettlement,
  processRefundFailure,
} from './refund-settlement.service.js';
import { verifyWebhookSignature } from './payment.service.js';
import { processVerifiedWebhookEvent } from './webhook-processor.service.js';
import { WorkerConfig, getWorkerConfig } from '../config/worker.config.js';

// ============================================================================
// TYPES & INTERFACES FOR RECOVERY SERVICE
// ============================================================================

export interface SweepWebhooksParams {
  now?: Date;
  batchSize?: number;
  maxRetries?: number;
  workerId?: string;
  leaseDurationMs?: number;
  razorpayClient?: any;
}

export interface SweepWebhooksResult {
  recoveredResetCount: number;
  recoveredFailedCount: number;
  reprocessedSuccessCount: number;
  processedEventIds: string[];
}

export interface ReconcileUncertainJobParams {
  jobId: string;
  workerId: string;
  leaseDurationMs?: number;
  maxRetries?: number;
  now?: Date;
  razorpayClient?: any;
}

export interface ReconcileUncertainJobResult {
  jobId: string;
  outcome:
    | 'settled'
    | 'failed'
    | 'pending_gateway'
    | 'retrying_dispatch'
    | 'escalated_manual_review'
    | 'skipped_claimed'
    | 'error';
  error?: string;
  job?: IRefundJob | null;
}

export interface SweepUncertainParams {
  workerId: string;
  batchSize?: number;
  leaseDurationMs?: number;
  maxRetries?: number;
  now?: Date;
  razorpayClient?: any;
}

export interface SweepUncertainResult {
  totalScanned: number;
  settledCount: number;
  failedCount: number;
  pendingGatewayCount: number;
  retryingDispatchCount: number;
  escalatedCount: number;
  results: ReconcileUncertainJobResult[];
}

export interface SweepDispatchParams {
  workerId: string;
  batchSize?: number;
  leaseDurationMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  now?: Date;
  razorpayClient?: any;
}

export interface SweepDispatchResult {
  totalScanned: number;
  dispatchedCount: number;
  succeededCount: number;
  failedRetryableCount: number;
  escalatedCount: number;
  skippedCooldownCount: number;
  results: Array<{ jobId: string; status: RefundJobStatus; error?: string }>;
}

export interface ReconcilePendingSettlementsParams {
  workerId: string;
  batchSize?: number;
  settlementThresholdMs?: number;
  now?: Date;
  razorpayClient?: any;
}

export interface ReconcilePendingSettlementsResult {
  totalScanned: number;
  settledCount: number;
  failedCount: number;
  pendingGatewayCount: number;
  results: Array<{ refundId: string; outcome: string }>;
}

export interface RunRecoverySweepOptions {
  workerId?: string;
  config?: Partial<WorkerConfig>;
  now?: Date;
  razorpayClient?: any;
}

export interface RecoverySweepSummary {
  workerId: string;
  timestamp: Date;
  durationMs: number;
  webhooks: SweepWebhooksResult;
  jobLeases: RecoverExpiredLeasesResult;
  uncertainJobs: SweepUncertainResult;
  pendingSettlements: ReconcilePendingSettlementsResult;
  dispatches: SweepDispatchResult;
}

// ============================================================================
// BACKOFF & RETRY ELIGIBILITY HELPERS
// ============================================================================

/**
 * Calculates exponential backoff duration in milliseconds based on attempt count.
 * Formula: min(baseBackoffMs * 2^(attempts - 1), maxBackoffMs)
 */
export function calculateBackoffMs(
  attempts: number,
  baseBackoffMs: number = 5_000,
  maxBackoffMs: number = 300_000
): number {
  if (attempts <= 0) return 0;
  const backoff = baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(backoff, maxBackoffMs);
}

/**
 * Checks whether a refund job in 'failed_retryable' status has satisfied its exponential backoff period.
 */
export function isJobEligibleForRetry(
  job: IRefundJob,
  now: Date,
  baseBackoffMs: number = 5_000,
  maxBackoffMs: number = 300_000
): boolean {
  if (job.status === 'pending') {
    return true;
  }

  if (job.status !== 'failed_retryable') {
    return false;
  }

  if (job.attempts >= (job.maxRetries || 3)) {
    return false;
  }

  const backoffMs = calculateBackoffMs(job.attempts, baseBackoffMs, maxBackoffMs);

  let lastAttemptTime = job.updatedAt ? new Date(job.updatedAt).getTime() : 0;
  if (job.errorHistory && job.errorHistory.length > 0) {
    const lastError = job.errorHistory[job.errorHistory.length - 1];
    if (lastError?.timestamp) {
      lastAttemptTime = new Date(lastError.timestamp).getTime();
    }
  }

  return now.getTime() - lastAttemptTime >= backoffMs;
}

// ============================================================================
// PHASE A: SWEEP EXPIRED WEBHOOK EVENTS
// ============================================================================

/**
 * Finds webhook events left in 'processing' with expired worker leases.
 * - If attempts >= maxRetries: transitions to 'failed' to prevent infinite lease churn.
 * - Claims an exclusive lease token atomically using findOneAndUpdate to prevent race conditions.
 * - If verified payload/rawBody is durably stored:
 *   Re-verifies cryptographic signature (HMAC SHA-256) and safely reprocesses the event through
 *   all existing safeguards (processVerifiedWebhookEvent) without requiring Razorpay redelivery!
 * - If payload is unavailable or cryptographic verification fails:
 *   Does NOT modify financial records, and marks the event 'failed' with descriptive reason.
 * - Preserves event ID idempotency, atomic lease claiming, and lease-token fencing.
 */
export async function sweepExpiredWebhookEvents(
  params?: SweepWebhooksParams
): Promise<SweepWebhooksResult> {
  const now = params?.now || new Date();
  const batchSize = params?.batchSize || 50;
  const maxRetries = params?.maxRetries || 3;
  const workerId = params?.workerId || `recovery_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
  const leaseDurationMs = params?.leaseDurationMs || 60_000;
  const razorpayClient = params?.razorpayClient;

  const expiredEvents = await WebhookEvent.find({
    status: 'processing',
    leaseExpiresAt: { $lte: now },
  })
    .limit(batchSize)
    .exec();

  let recoveredResetCount = 0;
  let recoveredFailedCount = 0;
  let reprocessedSuccessCount = 0;
  const processedEventIds: string[] = [];

  for (const event of expiredEvents) {
    // 1. Retry exhaustion check: prevent infinite recovery churn
    if (event.attempts >= maxRetries) {
      const updated = await WebhookEvent.findOneAndUpdate(
        {
          _id: event._id,
          leaseToken: event.leaseToken,
          status: 'processing',
        },
        {
          $set: {
            status: 'failed',
            error: `Lease expired and max attempts (${event.attempts}/${maxRetries}) exceeded`,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
        },
        { new: true }
      );

      if (updated) {
        recoveredFailedCount++;
        processedEventIds.push(event.eventId);
      }
      continue;
    }

    // 2. Atomically claim lease for this recovery worker
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const claimed = await WebhookEvent.findOneAndUpdate(
      {
        _id: event._id,
        status: 'processing',
        $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: null }],
      },
      {
        $set: {
          leaseWorkerId: workerId,
          leaseToken,
          leaseAcquiredAt: now,
          leaseExpiresAt,
        },
        $inc: { attempts: 1 },
      },
      { new: true }
    );

    if (!claimed) {
      // Race: claimed by another worker concurrently
      continue;
    }

    // 3. Cryptographic Replay Requirement:
    // Stored parsed payload (claimed.payload) is strictly untrusted / diagnostic only.
    // Safe automated replay REQUIRES the original cryptographically signed raw request body and signature.
    if (!claimed.rawBody || !claimed.signature) {
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: 'Original signed rawBody or signature unavailable for safe replay',
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
      continue;
    }

    // 4. Cryptographic signature check: verify signature against exact stored raw request body
    const isSignatureValid = verifyWebhookSignature({
      rawBody: claimed.rawBody,
      signature: claimed.signature,
    });

    if (!isSignatureValid) {
      // Cryptographic check failed: Stored rawBody was altered or corrupted.
      // Do not modify financial records!
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: 'Stored webhook payload failed cryptographic signature verification',
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
      continue;
    }

    // 5. Parse the event payload freshly from that verified raw body
    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(claimed.rawBody);
    } catch {
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: 'Stored webhook rawBody could not be parsed as JSON',
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
      continue;
    }

    // 6. Validate that parsed event name and event ID match the WebhookEvent record being replayed
    const parsedEventName = parsedPayload?.event;
    if (!parsedEventName || parsedEventName !== claimed.event) {
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: `Event name mismatch: parsed rawBody reports "${parsedEventName}", but WebhookEvent record is "${claimed.event}"`,
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
      continue;
    }

    const parsedEventId =
      parsedPayload?.event_id ||
      (parsedPayload?.entity === 'event' ? parsedPayload?.id : undefined) ||
      (typeof parsedPayload?.id === 'string' && parsedPayload.id.startsWith('evt_')
        ? parsedPayload.id
        : undefined);

    if (parsedEventId && parsedEventId !== claimed.eventId) {
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: `Event ID mismatch: parsed rawBody reports "${parsedEventId}", but WebhookEvent record is "${claimed.eventId}"`,
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
      continue;
    }

    // 7. Safely process the newly parsed payload through all existing domain safeguards
    try {
      const processResult = await processVerifiedWebhookEvent({
        eventId: claimed.eventId,
        eventName: claimed.event,
        payload: parsedPayload,
        rawBody: claimed.rawBody,
        signature: claimed.signature,
        leaseToken,
        razorpayClient,
      });

      if (processResult.success || processResult.status === 'processed') {
        reprocessedSuccessCount++;
      } else {
        recoveredFailedCount++;
      }
      processedEventIds.push(claimed.eventId);
    } catch (err: any) {
      await completeWebhookEvent({
        eventId: claimed.eventId,
        leaseToken,
        status: 'failed',
        error: `Error replaying webhook event: ${err?.message || err}`,
      });
      recoveredFailedCount++;
      processedEventIds.push(claimed.eventId);
    }
  }

  return {
    recoveredResetCount,
    recoveredFailedCount,
    reprocessedSuccessCount,
    processedEventIds,
  };
}

// ============================================================================
// PHASE B: SWEEP EXPIRED REFUND JOB LEASES
// ============================================================================

/**
 * Sweeps refund jobs left in 'processing' whose worker leases have expired.
 * Un-dispatched jobs (apiDispatched = false) safely reset to 'pending'.
 * Dispatched jobs (apiDispatched = true) transition to 'uncertain' for authoritative reconciliation.
 */
export async function sweepExpiredRefundJobLeases(params?: {
  now?: Date;
  batchSize?: number;
}): Promise<RecoverExpiredLeasesResult> {
  return await recoverExpiredLeases(params);
}

// ============================================================================
// PHASE C: RECONCILE UNCERTAIN REFUND JOBS
// ============================================================================

/**
 * Authoritatively reconciles a single uncertain refund job against the Razorpay gateway.
 *
 * Rules:
 * 1. Atomically claims an exclusive lease token on the uncertain job.
 * 2. Fetches authoritative gateway refund details via Razorpay SDK.
 * 3. If gateway confirms 'processed': invokes processRefundSettlement and marks job 'succeeded'.
 * 4. If gateway confirms 'failed': invokes processRefundFailure and marks job 'failed_retryable' or 'manual_review'.
 * 5. If gateway indicates 'pending': retains 'uncertain' status and clears lease for subsequent sweep.
 * 6. If gateway has no record (e.g. 404 or empty list) and retries remain: resets to 'failed_retryable' for dispatch retry.
 * 7. If retries exceeded or gateway error permanent: escalates to 'manual_review'.
 * 8. Fencing tokens prevent stale worker overwrites.
 */
export async function reconcileUncertainRefundJob(
  params: ReconcileUncertainJobParams
): Promise<ReconcileUncertainJobResult> {
  const {
    jobId,
    workerId,
    leaseDurationMs = 60_000,
    maxRetries = 3,
    now = new Date(),
    razorpayClient,
  } = params;

  if (!jobId || !mongoose.Types.ObjectId.isValid(jobId)) {
    return { jobId, outcome: 'error', error: 'Invalid jobId provided for reconciliation.' };
  }

  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  // 1. Atomically claim lease on this uncertain job
  const claimedJob = await RefundJob.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(jobId),
      status: 'uncertain',
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        leaseWorkerId: workerId,
        leaseToken,
        leaseAcquiredAt: now,
        leaseExpiresAt,
      },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!claimedJob) {
    return { jobId, outcome: 'skipped_claimed' };
  }

  // 2. Perform authoritative gateway inquiry
  let gatewayRefund: any = null;
  let notFoundOnGateway = false;

  try {
    const client = razorpayClient || getRazorpayClient();

    if (claimedJob.providerRefundId) {
      // Direct lookup by known provider refund ID
      gatewayRefund = await fetchAuthoritativeGatewayRefund(
        claimedJob.providerRefundId,
        claimedJob.targetPaymentId,
        client
      );
    } else {
      // Lookup by querying payment refunds on gateway
      if (client?.payments && typeof client.payments.fetchMultipleRefund === 'function') {
        const resp = await client.payments.fetchMultipleRefund(claimedJob.targetPaymentId);
        const refundsList: any[] = Array.isArray(resp) ? resp : resp?.items || [];

        // Match by refundJobId in notes or exact amount
        const match = refundsList.find(
          (r: any) =>
            (r?.notes && r.notes.refundJobId === claimedJob._id.toString()) ||
            (r?.amount === claimedJob.targetAmountPaise && (r?.currency || 'INR') === 'INR')
        );

        if (match) {
          gatewayRefund = match;
        } else {
          notFoundOnGateway = true;
        }
      } else if (client?.refunds && typeof client.refunds.all === 'function') {
        const resp = await client.refunds.all({ payment_id: claimedJob.targetPaymentId });
        const refundsList: any[] = Array.isArray(resp) ? resp : resp?.items || [];
        const match = refundsList.find(
          (r: any) =>
            (r?.notes && r.notes.refundJobId === claimedJob._id.toString()) ||
            (r?.amount === claimedJob.targetAmountPaise && (r?.currency || 'INR') === 'INR')
        );
        if (match) {
          gatewayRefund = match;
        } else {
          notFoundOnGateway = true;
        }
      } else {
        notFoundOnGateway = true;
      }
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (/not found|404/i.test(errorMsg)) {
      notFoundOnGateway = true;
    } else {
      // Gateway connection dropped, 5xx, or network timeout during inquiry
      if (claimedJob.attempts >= (claimedJob.maxRetries || maxRetries)) {
        const postUpdate = await RefundJob.findOneAndUpdate(
          { _id: claimedJob._id, leaseToken },
          {
            $set: {
              status: 'manual_review',
              manualReviewReason: `Authoritative gateway lookup failed and retries exhausted (${claimedJob.attempts}/${claimedJob.maxRetries}): ${errorMsg}`,
              leaseWorkerId: null,
              leaseToken: null,
              leaseAcquiredAt: null,
              leaseExpiresAt: null,
            },
            $push: {
              errorHistory: {
                error: `Gateway reconciliation error: ${errorMsg}. Escalated to manual_review.`,
                timestamp: now,
              },
            },
          },
          { new: true }
        );
        return {
          jobId,
          outcome: 'escalated_manual_review',
          error: errorMsg,
          job: postUpdate,
        };
      } else {
        const postUpdate = await RefundJob.findOneAndUpdate(
          { _id: claimedJob._id, leaseToken },
          {
            $set: {
              lastError: `Reconciliation inquiry error: ${errorMsg}`,
              leaseWorkerId: null,
              leaseToken: null,
              leaseAcquiredAt: null,
              leaseExpiresAt: null,
            },
            $push: {
              errorHistory: {
                error: `Reconciliation inquiry error: ${errorMsg}`,
                timestamp: now,
              },
            },
          },
          { new: true }
        );
        return {
          jobId,
          outcome: 'error',
          error: errorMsg,
          job: postUpdate,
        };
      }
    }
  }

  // 3. Process Authoritative Gateway Result

  // Case A: Gateway confirms refund is 'processed'
  if (gatewayRefund && gatewayRefund.status === 'processed') {
    try {
      await processRefundSettlement({
        refundId: gatewayRefund.id,
        paymentId: claimedJob.targetPaymentId,
        amountPaise: gatewayRefund.amount,
        currency: gatewayRefund.currency || 'INR',
        source: 'reconciliation_worker',
        gatewayRefund,
        razorpayClient,
      });

      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: claimedJob._id, leaseToken },
        {
          $set: {
            status: 'succeeded',
            providerRefundId: gatewayRefund.id,
            lastError: null,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
        },
        { new: true }
      );

      return {
        jobId,
        outcome: 'settled',
        job: postUpdate,
      };
    } catch (settleErr: any) {
      // Settlement exception (e.g. transaction failure)
      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: claimedJob._id, leaseToken },
        {
          $set: {
            lastError: `Settlement execution error: ${settleErr?.message || settleErr}`,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error: `Settlement execution error: ${settleErr?.message || settleErr}`,
              timestamp: now,
            },
          },
        },
        { new: true }
      );
      return {
        jobId,
        outcome: 'error',
        error: settleErr?.message,
        job: postUpdate,
      };
    }
  }

  // Case B: Gateway confirms refund 'failed'
  if (gatewayRefund && gatewayRefund.status === 'failed') {
    const failureReason = gatewayRefund.error_description || 'Gateway reported refund status failed';
    try {
      await processRefundFailure({
        refundId: gatewayRefund.id,
        paymentId: claimedJob.targetPaymentId,
        failureReason,
        gatewayRefund,
        razorpayClient,
      });
    } catch {
      // Ignored if already recorded
    }

    const postUpdate = await RefundJob.findById(claimedJob._id);

    return {
      jobId,
      outcome: 'failed',
      job: postUpdate,
    };
  }

  // Case C: Gateway reports refund is still 'pending' with banking network
  if (gatewayRefund && gatewayRefund.status === 'pending') {
    const postUpdate = await RefundJob.findOneAndUpdate(
      { _id: claimedJob._id, leaseToken },
      {
        $set: {
          providerRefundId: gatewayRefund.id,
          lastError: 'Gateway refund is still pending with banking network',
          leaseWorkerId: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
        },
      },
      { new: true }
    );

    return {
      jobId,
      outcome: 'pending_gateway',
      job: postUpdate,
    };
  }

  // Case D: Refund was NOT found on gateway (dispatch packet never reached Razorpay)
  if (notFoundOnGateway || !gatewayRefund) {
    if (claimedJob.attempts >= (claimedJob.maxRetries || maxRetries)) {
      // Retries exhausted
      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: claimedJob._id, leaseToken },
        {
          $set: {
            status: 'manual_review',
            manualReviewReason: `Refund not found on gateway and max retries exceeded (${claimedJob.attempts}/${claimedJob.maxRetries}).`,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error: 'Refund not found on gateway; max retries exceeded. Escalated to manual_review.',
              timestamp: now,
            },
          },
        },
        { new: true }
      );

      return {
        jobId,
        outcome: 'escalated_manual_review',
        job: postUpdate,
      };
    } else {
      // Eligible to retry dispatch using the exact same providerIdempotencyKey
      const postUpdate = await RefundJob.findOneAndUpdate(
        { _id: claimedJob._id, leaseToken },
        {
          $set: {
            status: 'failed_retryable',
            lastError: 'Refund not found on gateway during reconciliation; reset for dispatch retry',
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error: 'Refund not found on gateway during reconciliation; reset to failed_retryable for retry',
              timestamp: now,
            },
          },
        },
        { new: true }
      );

      return {
        jobId,
        outcome: 'retrying_dispatch',
        job: postUpdate,
      };
    }
  }

  return { jobId, outcome: 'error', error: 'Unexpected reconciliation state reached' };
}

/**
 * Sweeps and authoritatively reconciles all eligible 'uncertain' refund jobs.
 */
export async function sweepUncertainRefundJobs(
  params: SweepUncertainParams
): Promise<SweepUncertainResult> {
  const {
    workerId,
    batchSize = 50,
    leaseDurationMs = 60_000,
    maxRetries = 3,
    now = new Date(),
    razorpayClient,
  } = params;

  const uncertainJobs = await RefundJob.find({
    status: 'uncertain',
    $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
  })
    .limit(batchSize)
    .exec();

  const results: ReconcileUncertainJobResult[] = [];
  let settledCount = 0;
  let failedCount = 0;
  let pendingGatewayCount = 0;
  let retryingDispatchCount = 0;
  let escalatedCount = 0;

  for (const job of uncertainJobs) {
    const res = await reconcileUncertainRefundJob({
      jobId: job._id.toString(),
      workerId,
      leaseDurationMs,
      maxRetries,
      now,
      razorpayClient,
    });
    results.push(res);

    if (res.outcome === 'settled') settledCount++;
    else if (res.outcome === 'failed') failedCount++;
    else if (res.outcome === 'pending_gateway') pendingGatewayCount++;
    else if (res.outcome === 'retrying_dispatch') retryingDispatchCount++;
    else if (res.outcome === 'escalated_manual_review') escalatedCount++;
  }

  return {
    totalScanned: uncertainJobs.length,
    settledCount,
    failedCount,
    pendingGatewayCount,
    retryingDispatchCount,
    escalatedCount,
    results,
  };
}

// ============================================================================
// PHASE D: RECONCILE DISPATCHED PENDING SETTLEMENTS
// ============================================================================

/**
 * Reconciles refunds where status is 'pending' and providerRefundId is present,
 * authoritatively completing settlement if webhook delivery was lost.
 */
export async function reconcilePendingRefundSettlements(
  params: ReconcilePendingSettlementsParams
): Promise<ReconcilePendingSettlementsResult> {
  const {
    batchSize = 50,
    settlementThresholdMs = 15_000, // Wait at least 15s after creation to allow normal webhook
    now = new Date(),
    razorpayClient,
  } = params;

  const thresholdDate = new Date(now.getTime() - settlementThresholdMs);

  const pendingRefunds = await Refund.find({
    status: 'pending',
    providerRefundId: { $exists: true, $ne: null },
    createdAt: { $lte: thresholdDate },
  })
    .limit(batchSize)
    .exec();

  let settledCount = 0;
  let failedCount = 0;
  let pendingGatewayCount = 0;
  const results: Array<{ refundId: string; outcome: string }> = [];

  for (const refund of pendingRefunds) {
    try {
      const gatewayRefund = await fetchAuthoritativeGatewayRefund(
        refund.providerRefundId!,
        refund.paymentId,
        razorpayClient
      );

      if (gatewayRefund && gatewayRefund.status === 'processed') {
        await processRefundSettlement({
          refundId: refund.providerRefundId!,
          paymentId: refund.paymentId,
          amountPaise: refund.amountPaise,
          currency: refund.currency,
          source: 'reconciliation_worker',
          gatewayRefund,
          razorpayClient,
        });

        // Also update any matching RefundJob
        if (refund.refundJobId) {
          await RefundJob.updateOne(
            { _id: refund.refundJobId, status: { $ne: 'succeeded' } },
            {
              $set: {
                status: 'succeeded',
                providerRefundId: gatewayRefund.id,
                lastError: null,
                leaseWorkerId: null,
                leaseToken: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
              },
            }
          );
        }

        settledCount++;
        results.push({ refundId: refund.refundId, outcome: 'settled' });
      } else if (gatewayRefund && gatewayRefund.status === 'failed') {
        await processRefundFailure({
          refundId: refund.providerRefundId!,
          paymentId: refund.paymentId,
          failureReason: gatewayRefund.error_description || 'Gateway refund marked failed',
          gatewayRefund,
          razorpayClient,
        });
        failedCount++;
        results.push({ refundId: refund.refundId, outcome: 'failed' });
      } else {
        pendingGatewayCount++;
        results.push({ refundId: refund.refundId, outcome: 'pending_gateway' });
      }
    } catch (err: any) {
      results.push({ refundId: refund.refundId, outcome: `error: ${err?.message || err}` });
    }
  }

  return {
    totalScanned: pendingRefunds.length,
    settledCount,
    failedCount,
    pendingGatewayCount,
    results,
  };
}

// ============================================================================
// PHASE E: SWEEP AND DISPATCH RETRYABLE / PENDING REFUND JOBS
// ============================================================================

/**
 * Sweeps pending and retryable refund jobs, verifies backoff cooldown, claims leases,
 * and executes dispatch with stable provider idempotency keys.
 */
export async function sweepAndDispatchRetryableJobs(
  params: SweepDispatchParams
): Promise<SweepDispatchResult> {
  const {
    workerId,
    batchSize = 50,
    leaseDurationMs = 60_000,
    baseBackoffMs = 5_000,
    maxBackoffMs = 300_000,
    maxRetries = 3,
    now = new Date(),
    razorpayClient,
  } = params;

  const candidates = await RefundJob.find({
    status: { $in: ['pending', 'failed_retryable'] },
    $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
  })
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .exec();

  const results: Array<{ jobId: string; status: RefundJobStatus; error?: string }> = [];
  let dispatchedCount = 0;
  let succeededCount = 0;
  let failedRetryableCount = 0;
  let escalatedCount = 0;
  let skippedCooldownCount = 0;

  for (const job of candidates) {
    const jobMaxRetries = job.maxRetries || maxRetries;

    // Retry limit check
    if (job.attempts >= jobMaxRetries) {
      const updated = await RefundJob.findOneAndUpdate(
        { _id: job._id, status: { $in: ['pending', 'failed_retryable'] } },
        {
          $set: {
            status: 'manual_review',
            manualReviewReason: `Maximum dispatch attempts (${job.attempts}/${jobMaxRetries}) exceeded.`,
            leaseWorkerId: null,
            leaseToken: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
          },
          $push: {
            errorHistory: {
              error: `Maximum retry attempts exceeded (${job.attempts}/${jobMaxRetries}). Escalated to manual_review.`,
              timestamp: now,
            },
          },
        },
        { new: true }
      );

      if (updated) {
        escalatedCount++;
        results.push({
          jobId: job._id.toString(),
          status: 'manual_review',
          error: `Max retries (${jobMaxRetries}) exceeded`,
        });
      }
      continue;
    }

    // Exponential backoff check for failed_retryable jobs
    if (job.status === 'failed_retryable') {
      const isEligible = isJobEligibleForRetry(job, now, baseBackoffMs, maxBackoffMs);
      if (!isEligible) {
        skippedCooldownCount++;
        results.push({
          jobId: job._id.toString(),
          status: job.status,
          error: 'Skipped: exponential backoff cooldown in effect',
        });
        continue;
      }
    }

    // Atomically claim the lease
    const claimed = await claimRefundJob({
      workerId,
      jobId: job._id.toString(),
      leaseDurationMs,
      now,
    });

    if (!claimed) {
      continue;
    }

    dispatchedCount++;

    try {
      const dispatchResult = await dispatchRefundJob({
        jobId: claimed._id.toString(),
        workerId,
        leaseToken: claimed.leaseToken!,
        razorpayClient,
        now,
      });

      results.push({
        jobId: claimed._id.toString(),
        status: dispatchResult.status,
        error: dispatchResult.error,
      });

      if (dispatchResult.status === 'succeeded') succeededCount++;
      else if (dispatchResult.status === 'failed_retryable') failedRetryableCount++;
      else if (dispatchResult.status === 'manual_review') escalatedCount++;
    } catch (dispatchErr: any) {
      results.push({
        jobId: claimed._id.toString(),
        status: 'uncertain',
        error: dispatchErr?.message || String(dispatchErr),
      });
    }
  }

  return {
    totalScanned: candidates.length,
    dispatchedCount,
    succeededCount,
    failedRetryableCount,
    escalatedCount,
    skippedCooldownCount,
    results,
  };
}

// ============================================================================
// COMPLETE RECOVERY SWEEP ORCHESTRATION
// ============================================================================

/**
 * Runs one complete multi-phase recovery sweep:
 * Phase A: Expired Webhook Recovery (sweepExpiredWebhookEvents)
 * Phase B: Expired Refund Job Lease Recovery (sweepExpiredRefundJobLeases)
 * Phase C: Uncertain Refund Job Reconciliation (sweepUncertainRefundJobs)
 * Phase D: Dispatched Refund Settlement Reconciliation (reconcilePendingRefundSettlements)
 * Phase E: Retryable Refund Job Dispatch (sweepAndDispatchRetryableJobs)
 */
export async function runRecoverySweep(
  options?: RunRecoverySweepOptions
): Promise<RecoverySweepSummary> {
  const startTime = Date.now();
  const config = getWorkerConfig(options?.config);
  const workerId = options?.workerId || config.workerId;
  const now = options?.now || new Date();
  const razorpayClient = options?.razorpayClient;

  // Phase A: Expired Webhooks
  const webhooks = await sweepExpiredWebhookEvents({
    now,
    batchSize: config.batchSize,
    maxRetries: config.maxRetries,
    workerId,
    leaseDurationMs: config.leaseDurationMs,
    razorpayClient,
  });

  // Phase B: Expired Refund Job Leases
  const jobLeases = await sweepExpiredRefundJobLeases({
    now,
    batchSize: config.batchSize,
  });

  // Phase C: Uncertain Refund Jobs Authoritative Reconciliation
  const uncertainJobs = await sweepUncertainRefundJobs({
    workerId,
    batchSize: config.batchSize,
    leaseDurationMs: config.leaseDurationMs,
    maxRetries: config.maxRetries,
    now,
    razorpayClient,
  });

  // Phase D: Dispatched Refund Settlements
  const pendingSettlements = await reconcilePendingRefundSettlements({
    workerId,
    batchSize: config.batchSize,
    now,
    razorpayClient,
  });

  // Phase E: Retryable / Pending Refund Jobs Dispatch
  const dispatches = await sweepAndDispatchRetryableJobs({
    workerId,
    batchSize: config.batchSize,
    leaseDurationMs: config.leaseDurationMs,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    maxRetries: config.maxRetries,
    now,
    razorpayClient,
  });

  const durationMs = Date.now() - startTime;

  return {
    workerId,
    timestamp: now,
    durationMs,
    webhooks,
    jobLeases,
    uncertainJobs,
    pendingSettlements,
    dispatches,
  };
}
