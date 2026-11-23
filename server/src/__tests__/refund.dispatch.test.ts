/**
 * ============================================================================
 * PHASE 8.3 — STEP 4: RAZORPAY REFUND DISPATCH TEST SUITE
 * ============================================================================
 *
 * ARCHITECTURAL NOTICE ON TEST HARNESS:
 * In accordance with strict project guidelines, all tests run in-process without
 * connecting to external networks, MongoDB Atlas, or live Razorpay APIs.
 * Distributed lease claiming, fencing tokens, idempotency key persistence,
 * gateway error classification, and crash recovery are deterministically verified.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob } from '../models/RefundJob.js';
import {
  claimRefundJob,
  dispatchRefundJob,
  recoverExpiredLeases,
  generateProviderRefundIdempotencyKey,
  classifyGatewayError,
  RefundJobNotFoundError,
  StaleWorkerLeaseError,
  InvalidJobStateForDispatchError,
} from '../services/refund-dispatch.service.js';

describe('Phase 8.3 — Step 4: Razorpay Refund Dispatch', () => {
  let databaseOrders: any[] = [];
  let databasePaymentAttempts: any[] = [];
  let databaseRefunds: any[] = [];
  let databaseRefundJobs: any[] = [];

  const dummyUserId = new mongoose.Types.ObjectId('6740000000000000000000a1');
  const dummyProjectId = new mongoose.Types.ObjectId('6740000000000000000000b1');

  function createTestOrder(overrides: Partial<any> = {}): IOrder {
    const orderId = overrides.orderId || `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const rzpOrderId = overrides.razorpayOrderId || `order_rzp_${Date.now()}`;
    const totalAmount = overrides.totalAmount ?? 4170;
    const amountPaise = overrides.amountPaise ?? Math.round(totalAmount * 100);

    const doc: any = new Order({
      orderId,
      receipt: overrides.receipt || `rcpt_${orderId.substring(4)}`,
      userId: overrides.userId || dummyUserId,
      items: overrides.items || [
        {
          projectId: dummyProjectId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: totalAmount,
          quantity: 1,
        },
      ],
      totalAmount,
      amountPaise,
      currency: overrides.currency || 'INR',
      status: overrides.status || 'completed',
      paymentStatus: overrides.paymentStatus || 'refund_pending',
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: overrides.razorpayPaymentId || `pay_${orderId.substring(4)}`,
      idempotencyKey: overrides.idempotencyKey || `idem_${orderId}`,
      totalCapturedPaise: overrides.totalCapturedPaise ?? amountPaise,
      purchaseCapturedPaise: overrides.purchaseCapturedPaise ?? amountPaise,
      duplicateCapturedPaise: overrides.duplicateCapturedPaise ?? 0,
      amountReservedRefundPaise: overrides.amountReservedRefundPaise ?? amountPaise,
      confirmedRefundPaise: overrides.confirmedRefundPaise ?? 0,
      purchaseRefundedPaise: overrides.purchaseRefundedPaise ?? 0,
      duplicateRefundedPaise: overrides.duplicateRefundedPaise ?? 0,
      primaryPaymentId: overrides.primaryPaymentId || overrides.razorpayPaymentId || `pay_${orderId.substring(4)}`,
    });

    doc._id = overrides._id || new mongoose.Types.ObjectId();
    databaseOrders.push(doc);
    return doc;
  }

  function createTestPaymentAttempt(overrides: Partial<any> = {}): IPaymentAttempt {
    const paymentId = overrides.paymentId || `pay_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const doc: any = new PaymentAttempt({
      paymentId,
      orderId: overrides.orderId || databaseOrders[0]?._id || new mongoose.Types.ObjectId(),
      razorpayOrderId: overrides.razorpayOrderId || databaseOrders[0]?.razorpayOrderId || 'order_rzp_mock',
      amountCapturedPaise: overrides.amountCapturedPaise ?? 417000,
      currency: overrides.currency || 'INR',
      status: overrides.status || 'captured',
      classification: overrides.classification || 'primary',
      gatewayMethod: overrides.gatewayMethod || 'upi',
    });

    doc._id = overrides._id || new mongoose.Types.ObjectId();
    databasePaymentAttempts.push(doc);
    return doc;
  }

  function createTestRefund(overrides: Partial<any> = {}): IRefund {
    const refundId = overrides.refundId || `resv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const doc: any = new Refund({
      refundId,
      orderId: overrides.orderId || databaseOrders[0]?._id || new mongoose.Types.ObjectId(),
      paymentId: overrides.paymentId || databasePaymentAttempts[0]?.paymentId || 'pay_test_default',
      refundJobId: overrides.refundJobId || databaseRefundJobs[0]?._id,
      amountPaise: overrides.amountPaise ?? 417000,
      currency: overrides.currency || 'INR',
      type: overrides.type || 'purchase_compensation',
      status: overrides.status || 'pending',
      notes: overrides.notes,
    });

    doc._id = overrides._id || new mongoose.Types.ObjectId();
    databaseRefunds.push(doc);
    return doc;
  }

  function createTestRefundJob(overrides: Partial<any> = {}): IRefundJob {
    const idempotencyKey = overrides.idempotencyKey || `refund:job:${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const doc: any = new RefundJob({
      orderId: overrides.orderId || databaseOrders[0]?._id || new mongoose.Types.ObjectId(),
      targetPaymentId: overrides.targetPaymentId || databasePaymentAttempts[0]?.paymentId || 'pay_test_default',
      targetAmountPaise: overrides.targetAmountPaise ?? 417000,
      currency: overrides.currency || 'INR',
      reason: overrides.reason || 'customer_cancellation',
      classification: overrides.classification || 'purchase_compensation',
      idempotencyKey,
      status: overrides.status || 'pending',
      apiDispatched: overrides.apiDispatched ?? false,
      attempts: overrides.attempts ?? 0,
      maxRetries: overrides.maxRetries ?? 3,
      providerIdempotencyKey: overrides.providerIdempotencyKey,
      leaseWorkerId: overrides.leaseWorkerId ?? null,
      leaseToken: overrides.leaseToken ?? null,
      leaseAcquiredAt: overrides.leaseAcquiredAt ?? null,
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      errorHistory: overrides.errorHistory || [],
    });

    doc._id = overrides._id || new mongoose.Types.ObjectId();
    databaseRefundJobs.push(doc);
    return doc;
  }

  beforeEach(() => {
    databaseOrders = [];
    databasePaymentAttempts = [];
    databaseRefunds = [];
    databaseRefundJobs = [];

    // Mock Order methods
    Order.findById = (async (id: any) => {
      const found = databaseOrders.find((d) => d._id.toString() === id.toString());
      return found || null;
    }) as any;

    Order.findOne = (async (query: any) => {
      const found = databaseOrders.find((d) => {
        if (query._id && d._id.toString() !== query._id.toString()) return false;
        if (query.orderId && d.orderId !== query.orderId) return false;
        return true;
      });
      return found || null;
    }) as any;

    // Mock PaymentAttempt methods
    PaymentAttempt.findOne = (async (query: any) => {
      const found = databasePaymentAttempts.find((p) => {
        if (query.paymentId && p.paymentId !== query.paymentId) return false;
        return true;
      });
      return found || null;
    }) as any;

    // Mock Refund methods
    Refund.findOne = (async (query: any) => {
      const found = databaseRefunds.find((r) => {
        if (query.refundJobId && (!r.refundJobId || r.refundJobId.toString() !== query.refundJobId.toString())) {
          return false;
        }
        if (query.refundId && r.refundId !== query.refundId) return false;
        return true;
      });
      return found || null;
    }) as any;

    Refund.prototype.save = async function () {
      return this;
    };

    // Mock RefundJob methods
    RefundJob.findById = (async (id: any) => {
      const found = databaseRefundJobs.find((j) => j._id.toString() === id.toString());
      return found || null;
    }) as any;

    RefundJob.findOne = (async (query: any) => {
      const found = databaseRefundJobs.find((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.idempotencyKey && j.idempotencyKey !== query.idempotencyKey) return false;
        return true;
      });
      return found || null;
    }) as any;

    RefundJob.updateOne = (async (query: any, update: any) => {
      const found = databaseRefundJobs.find((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.leaseToken && j.leaseToken !== query.leaseToken) return false;
        return true;
      });
      if (!found) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(found, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }) as any;

    RefundJob.findOneAndUpdate = (async (query: any, update: any, options: any = {}) => {
      // Find candidate matching all query conditions
      const candidateIndex = databaseRefundJobs.findIndex((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.leaseToken && j.leaseToken !== query.leaseToken) return false;

        // Status check
        if (query.status) {
          if (query.status.$in) {
            if (!query.status.$in.includes(j.status)) return false;
          } else if (j.status !== query.status) {
            return false;
          }
        }

        // $or clause (e.g. leaseExpiresAt is null OR leaseExpiresAt < now)
        if (query.$or) {
          const satisfiesOr = query.$or.some((condition: any) => {
            if ('leaseExpiresAt' in condition) {
              if (condition.leaseExpiresAt === null) {
                return j.leaseExpiresAt === null || j.leaseExpiresAt === undefined;
              }
              if (condition.leaseExpiresAt.$lt) {
                return j.leaseExpiresAt && j.leaseExpiresAt.getTime() < condition.leaseExpiresAt.$lt.getTime();
              }
            }
            return false;
          });
          if (!satisfiesOr) return false;
        }

        return true;
      });

      if (candidateIndex === -1) {
        return null;
      }

      const found = databaseRefundJobs[candidateIndex];

      // Apply $set
      if (update.$set) {
        Object.assign(found, update.$set);
      }
      // Apply $inc
      if (update.$inc) {
        for (const [key, val] of Object.entries(update.$inc)) {
          found[key] = (found[key] || 0) + (val as number);
        }
      }
      // Apply $push
      if (update.$push) {
        for (const [key, val] of Object.entries(update.$push)) {
          if (!found[key]) found[key] = [];
          found[key].push(val);
        }
      }

      return found;
    }) as any;

    RefundJob.find = ((query: any) => {
      const matched = databaseRefundJobs.filter((j) => {
        if (query.status && j.status !== query.status) return false;
        if (query.leaseExpiresAt?.$lte) {
          if (!j.leaseExpiresAt || j.leaseExpiresAt.getTime() > query.leaseExpiresAt.$lte.getTime()) {
            return false;
          }
        }
        return true;
      });

      return {
        limit: (n: number) => ({
          exec: async () => matched.slice(0, n),
        }),
      };
    }) as any;

    RefundJob.prototype.save = async function () {
      return this;
    };
  });

  // ============================================================================
  // 1. SUCCESSFUL DISPATCH (processed)
  // ============================================================================
  it('1. successful dispatch transitions job to succeeded, persists providerRefundId, keeps Refund pending, and preserves reserved accounting', async () => {
    const order = createTestOrder({ amountReservedRefundPaise: 417000, confirmedRefundPaise: 0 });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_succ_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 417000,
      status: 'pending',
      idempotencyKey: 'refund:full:order:101',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      amountPaise: 417000,
      status: 'pending',
    });

    // Worker claims the job
    const claimed = await claimRefundJob({ workerId: 'worker_alpha', jobId: job._id.toString() });
    assert.ok(claimed, 'Worker alpha should successfully claim job');
    assert.strictEqual(claimed.status, 'processing');
    assert.ok(claimed.leaseToken, 'Should receive a unique lease token');
    assert.ok(claimed.providerIdempotencyKey, 'Should generate stable providerIdempotencyKey');

    let capturedHeaders: any = null;
    let capturedPaymentId: string | null = null;
    let capturedPayload: any = null;

    const mockRazorpay = {
      payments: {
        refund: async (paymentId: string, payload: any, options: any) => {
          capturedPaymentId = paymentId;
          capturedPayload = payload;
          capturedHeaders = options?.headers;
          return {
            id: 'rfnd_succ_123',
            entity: 'refund',
            amount: 417000,
            currency: 'INR',
            payment_id: paymentId,
            status: 'processed',
          };
        },
      },
    };

    const dispatchResult = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_alpha',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay,
    });

    assert.strictEqual(dispatchResult.status, 'succeeded');
    assert.strictEqual(dispatchResult.providerRefundId, 'rfnd_succ_123');

    // Verify RefundJob database state
    assert.strictEqual(job.status, 'succeeded');
    assert.strictEqual(job.providerRefundId, 'rfnd_succ_123');
    assert.strictEqual(job.leaseWorkerId, null, 'Lease worker should be cleared');
    assert.strictEqual(job.leaseToken, null, 'Lease token should be cleared');
    assert.strictEqual(job.apiDispatched, true, 'apiDispatched must be marked true');
    assert.strictEqual(job.attempts, 1);

    // Verify payload & idempotency header sent to Razorpay
    assert.strictEqual(capturedPaymentId, 'pay_succ_001');
    assert.strictEqual(capturedPayload.amount, 417000);
    assert.strictEqual(capturedHeaders?.['X-Refund-Idempotency'], claimed.providerIdempotencyKey);

    // CRUCIAL: Verify Refund model state remains pending and unconfirmed
    assert.strictEqual(refund.providerRefundId, 'rfnd_succ_123');
    assert.strictEqual(refund.status, 'pending', 'Refund model status must remain pending until Step 5');
    assert.strictEqual(refund.settledAt, undefined, 'settledAt must not be set prematurely');

    // CRUCIAL: Verify Order financial accounting is NOT mutated
    assert.strictEqual(order.confirmedRefundPaise, 0, 'confirmedRefundPaise must not increase prematurely');
    assert.strictEqual(order.amountReservedRefundPaise, 417000, 'amountReservedRefundPaise remains reserved');
  });

  // ============================================================================
  // 2. PENDING RAZORPAY RESPONSE
  // ============================================================================
  it('2. Razorpay pending response leaves job and refund status as pending', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_pend_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
      idempotencyKey: 'refund:full:order:102',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      status: 'pending',
    });

    const claimed = await claimRefundJob({ workerId: 'worker_beta', jobId: job._id.toString() });
    assert.ok(claimed);

    const mockRazorpay = {
      payments: {
        refund: async () => ({
          id: 'rfnd_pending_999',
          status: 'pending', // Banking partner has not confirmed yet
        }),
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_beta',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay,
    });

    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.providerRefundId, 'rfnd_pending_999');
    assert.strictEqual(job.status, 'pending');
    assert.strictEqual(job.providerRefundId, 'rfnd_pending_999');
    assert.strictEqual(job.leaseToken, null, 'Lease must be cleared even if pending');
    assert.strictEqual(refund.status, 'pending');
    assert.strictEqual(refund.providerRefundId, 'rfnd_pending_999');
  });

  // ============================================================================
  // 3. DUPLICATE DISPATCH ATTEMPTS & CONCURRENT CLAIMS
  // ============================================================================
  it('3. duplicate claim returns null and dispatch without valid lease token throws StaleWorkerLeaseError', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_dup_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    // Worker 1 claims job
    const claim1 = await claimRefundJob({ workerId: 'worker_1', jobId: job._id.toString() });
    assert.ok(claim1);
    assert.strictEqual(job.status, 'processing');

    // Worker 2 attempts to claim the same job before lease expires
    const claim2 = await claimRefundJob({ workerId: 'worker_2', jobId: job._id.toString() });
    assert.strictEqual(claim2, null, 'Second worker must be prevented from claiming an active job');

    // Worker 2 attempts to dispatch using a forged or stale lease token
    await assert.rejects(
      async () => {
        await dispatchRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_2',
          leaseToken: 'forged_or_stale_uuid',
          razorpayClient: { payments: { refund: async () => ({ id: 'rfnd_fail' }) } },
        });
      },
      (err: any) => {
        assert.ok(err instanceof StaleWorkerLeaseError);
        assert.match(err.message, /does not hold active lease/);
        return true;
      }
    );
  });

  // ============================================================================
  // 4. CONCURRENT WORKERS RACING TO CLAIM THE SAME JOB
  // ============================================================================
  it('4. concurrent worker claims grant the lease to exactly one worker', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_race_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });

    const [res1, res2] = await Promise.all([
      claimRefundJob({ workerId: 'worker_race_a', jobId: job._id.toString() }),
      claimRefundJob({ workerId: 'worker_race_b', jobId: job._id.toString() }),
    ]);

    const winnerCount = [res1, res2].filter((r) => r !== null).length;
    assert.strictEqual(winnerCount, 1, 'Exactly one worker must acquire the lease');

    const winner = res1 || res2;
    assert.strictEqual(job.leaseWorkerId, winner?.leaseWorkerId);
  });

  // ============================================================================
  // 5. WORKER CRASH & EXPIRED LEASE RECOVERY (apiDispatched: false)
  // ============================================================================
  it('5. recoverExpiredLeases resets job to pending when apiDispatched is false', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_crash_001', status: 'captured' });
    const pastDate = new Date(Date.now() - 10_000);

    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'processing',
      apiDispatched: false, // Worker died BEFORE sending network packet
      leaseWorkerId: 'crashed_worker',
      leaseToken: 'crashed_token_1',
      leaseExpiresAt: pastDate,
    });

    const recoveryResult = await recoverExpiredLeases({ now: new Date() });
    assert.strictEqual(recoveryResult.recoveredPendingCount, 1);
    assert.strictEqual(recoveryResult.recoveredUncertainCount, 0);

    assert.strictEqual(job.status, 'pending', 'Job must safely reset to pending');
    assert.strictEqual(job.leaseToken, null);
    assert.strictEqual(job.leaseWorkerId, null);
    assert.strictEqual(job.errorHistory.length, 1);
    assert.match(job.errorHistory[0].error, /Worker lease expired before API dispatch; safely reset to pending/);

    // Now a new healthy worker can claim and dispatch the job
    const newClaim = await claimRefundJob({ workerId: 'healthy_worker', jobId: job._id.toString() });
    assert.ok(newClaim);
    assert.strictEqual(job.status, 'processing');
  });

  // ============================================================================
  // 6. WORKER CRASH & EXPIRED LEASE RECOVERY (apiDispatched: true)
  // ============================================================================
  it('6. recoverExpiredLeases marks job uncertain when apiDispatched is true to prevent duplicate dispatch', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_crash_002', status: 'captured' });
    const pastDate = new Date(Date.now() - 10_000);

    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'processing',
      apiDispatched: true, // Worker recorded intent before network call, but crashed during call
      leaseWorkerId: 'crashed_worker_2',
      leaseToken: 'crashed_token_2',
      leaseExpiresAt: pastDate,
    });

    const recoveryResult = await recoverExpiredLeases({ now: new Date() });
    assert.strictEqual(recoveryResult.recoveredPendingCount, 0);
    assert.strictEqual(recoveryResult.recoveredUncertainCount, 1);

    assert.strictEqual(job.status, 'uncertain', 'Must transition to uncertain for reconciliation');
    assert.strictEqual(job.leaseToken, null);
    assert.strictEqual(job.errorHistory.length, 1);
    assert.match(job.errorHistory[0].error, /Worker lease expired after API dispatch was recorded/);

    // A normal worker attempting to claim pending jobs cannot claim uncertain jobs
    const claimAttempt = await claimRefundJob({ workerId: 'worker_3', jobId: job._id.toString() });
    assert.strictEqual(claimAttempt, null, 'Uncertain jobs cannot be claimed as normal pending jobs');
  });

  // ============================================================================
  // 7. NETWORK TIMEOUT / SOCKET DROP HANDLING
  // ============================================================================
  it('7. gateway timeout or socket drop transitions job to uncertain and retains providerIdempotencyKey', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_timeout_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_timeout', jobId: job._id.toString() });
    assert.ok(claimed);
    const persistedKey = claimed.providerIdempotencyKey;

    const mockRazorpayTimeout = {
      payments: {
        refund: async () => {
          const timeoutErr: any = new Error('Client network socket disconnected before secure TLS response');
          timeoutErr.code = 'ECONNRESET';
          throw timeoutErr;
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_timeout',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpayTimeout,
    });

    assert.strictEqual(result.status, 'uncertain');
    assert.strictEqual(job.status, 'uncertain');
    assert.strictEqual(job.leaseToken, null, 'Lease must be cleared');
    assert.strictEqual(job.providerIdempotencyKey, persistedKey, 'Must retain original provider key');
    assert.strictEqual(job.attempts, 1);
    assert.strictEqual(job.errorHistory.length, 1);
    assert.match(job.errorHistory[0].error, /Gateway network timeout or socket drop/);
  });

  // ============================================================================
  // 8. RETRY USING EXACT SAME PROVIDER IDEMPOTENCY KEY AND PAYLOAD
  // ============================================================================
  it('8. retrying a retryable refund uses the exact same providerIdempotencyKey and request payload', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_retry_001', status: 'captured' });
    const existingProviderKey = 'a1b2c3d4e5f607182930415263748596';

    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 250000,
      reason: 'partial_defective_item',
      classification: 'partial_refund',
      status: 'failed_retryable',
      attempts: 1,
      maxRetries: 3,
      providerIdempotencyKey: existingProviderKey,
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id, amountPaise: 250000 });

    // Claim the retryable job
    const claimed = await claimRefundJob({ workerId: 'retry_worker', jobId: job._id.toString() });
    assert.ok(claimed);
    assert.strictEqual(claimed.providerIdempotencyKey, existingProviderKey, 'Must retain existing key');

    let capturedHeaders: any = null;
    let capturedPayload: any = null;

    const mockRazorpaySuccess = {
      payments: {
        refund: async (_paymentId: string, payload: any, options: any) => {
          capturedPayload = payload;
          capturedHeaders = options?.headers;
          return { id: 'rfnd_retry_success', status: 'processed' };
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'retry_worker',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpaySuccess,
    });

    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(capturedHeaders?.['X-Refund-Idempotency'], existingProviderKey);
    assert.strictEqual(capturedPayload.amount, 250000);
    assert.strictEqual(capturedPayload.notes.reason, 'partial_defective_item');
    assert.strictEqual(job.attempts, 2);
  });

  // ============================================================================
  // 9. RAZORPAY 409 CONFLICT HANDLING
  // ============================================================================
  it('9. Razorpay 409 conflict retains original key and payload without creating new refund', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_conflict_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_conflict', jobId: job._id.toString() });
    assert.ok(claimed);
    const originalKey = claimed.providerIdempotencyKey;

    const mockRazorpayConflict = {
      payments: {
        refund: async () => {
          const err: any = new Error('A refund request with this idempotency key is already in progress');
          err.statusCode = 409;
          throw err;
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_conflict',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpayConflict,
    });

    assert.strictEqual(result.status, 'uncertain');
    assert.strictEqual(job.status, 'uncertain');
    assert.strictEqual(job.providerIdempotencyKey, originalKey, 'Provider key must NOT be regenerated or changed');
    assert.strictEqual(job.leaseToken, null);
    assert.match(job.lastError!, /409/);
  });

  // ============================================================================
  // 10. RAZORPAY 429 RATE LIMIT HANDLING
  // ============================================================================
  it('10. Razorpay 429 rate limit marks job failed_retryable', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_rate_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_rate', jobId: job._id.toString() });
    assert.ok(claimed);

    const mockRazorpay429 = {
      payments: {
        refund: async () => {
          const err: any = new Error('Too many requests. Please throttle your API calls.');
          err.statusCode = 429;
          throw err;
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_rate',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay429,
    });

    assert.strictEqual(result.status, 'failed_retryable');
    assert.strictEqual(result.isRetryable, true);
    assert.strictEqual(job.status, 'failed_retryable');
    assert.strictEqual(job.leaseToken, null);
  });

  // ============================================================================
  // 11. RAZORPAY 5XX SERVER ERROR HANDLING
  // ============================================================================
  it('11. Razorpay 5xx server error marks job uncertain', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_500_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_500', jobId: job._id.toString() });
    assert.ok(claimed);

    const mockRazorpay502 = {
      payments: {
        refund: async () => {
          const err: any = new Error('Bad Gateway');
          err.statusCode = 502;
          throw err;
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_500',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay502,
    });

    assert.strictEqual(result.status, 'uncertain');
    assert.strictEqual(job.status, 'uncertain');
  });

  // ============================================================================
  // 12. PERMANENT 4XX REJECTION (400 Bad Request)
  // ============================================================================
  it('12. permanent 4xx gateway error escalates job to manual_review and is not retryable', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_perm_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
      attempts: 0,
      maxRetries: 3,
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_perm', jobId: job._id.toString() });
    assert.ok(claimed);

    const mockRazorpay400 = {
      payments: {
        refund: async () => {
          const err: any = new Error('The payment has already been fully refunded on Razorpay.');
          err.statusCode = 400;
          throw err;
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_perm',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay400,
    });

    assert.strictEqual(result.status, 'manual_review');
    assert.strictEqual(result.isRetryable, false);
    assert.strictEqual(job.status, 'manual_review');
    assert.ok(job.manualReviewReason);
    assert.match(job.manualReviewReason, /Permanent gateway rejection/);
    assert.strictEqual(job.leaseToken, null);
  });

  // ============================================================================
  // 13. MAX RETRIES EXCEEDED ESCALATION
  // ============================================================================
  it('13. reaching maxRetries transitions job to manual_review without calling gateway', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_max_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'failed_retryable',
      attempts: 3,
      maxRetries: 3,
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    const claimed = await claimRefundJob({ workerId: 'worker_max', jobId: job._id.toString() });
    assert.ok(claimed);

    let gatewayCalled = false;
    const mockRazorpay = {
      payments: {
        refund: async () => {
          gatewayCalled = true;
          return { id: 'rfnd_never' };
        },
      },
    };

    const result = await dispatchRefundJob({
      jobId: job._id.toString(),
      workerId: 'worker_max',
      leaseToken: claimed.leaseToken!,
      razorpayClient: mockRazorpay,
    });

    assert.strictEqual(result.status, 'manual_review');
    assert.strictEqual(gatewayCalled, false, 'Gateway must NOT be called when maxRetries is reached');
    assert.strictEqual(job.status, 'manual_review');
    assert.match(job.manualReviewReason!, /Maximum dispatch retries/);
  });

  // ============================================================================
  // 14. STALE WORKER LEASE FENCING
  // ============================================================================
  it('14. stale worker whose lease expired is prevented from overwriting newer worker state', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_fence_001', status: 'captured' });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      status: 'pending',
    });
    createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

    // Worker A claims job with 10ms lease
    const claimA = await claimRefundJob({
      workerId: 'worker_slow_a',
      jobId: job._id.toString(),
      leaseDurationMs: 10,
    });
    assert.ok(claimA);
    const tokenA = claimA.leaseToken!;

    // Time passes: lease expires and recovery resets to pending
    const futureTime = new Date(Date.now() + 100);
    const recovery = await recoverExpiredLeases({ now: futureTime });
    assert.strictEqual(recovery.recoveredPendingCount, 1);

    // Worker B claims the now-recovered job
    const claimB = await claimRefundJob({
      workerId: 'worker_fast_b',
      jobId: job._id.toString(),
      now: futureTime,
    });
    assert.ok(claimB, 'Worker B must be able to claim expired job');
    const tokenB = claimB.leaseToken!;
    assert.notStrictEqual(tokenA, tokenB);

    // Worker A finally finishes its delayed external call and tries to record success
    const mockRazorpay = {
      payments: {
        refund: async () => ({ id: 'rfnd_slow_a', status: 'processed' }),
      },
    };

    await assert.rejects(
      async () => {
        await dispatchRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_slow_a',
          leaseToken: tokenA,
          razorpayClient: mockRazorpay,
          now: futureTime,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StaleWorkerLeaseError);
        return true;
      }
    );

    // Verify Worker B's lease was not overwritten or corrupted by Worker A
    assert.strictEqual(job.leaseWorkerId, 'worker_fast_b');
    assert.strictEqual(job.leaseToken, tokenB);
    assert.strictEqual(job.status, 'processing');
  });

  // ============================================================================
  // 15. PRE-DISPATCH INTEGRITY VALIDATIONS
  // ============================================================================
  it('15. rejects dispatch if Refund record is missing or PaymentAttempt is uncaptured', async () => {
    const order = createTestOrder();
    const uncapturedPayment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_uncaptured_001',
      status: 'authorized', // Not captured!
    });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: uncapturedPayment.paymentId,
      status: 'pending',
    });

    const claimed = await claimRefundJob({ workerId: 'worker_guard', jobId: job._id.toString() });
    assert.ok(claimed);

    // Case 1: Missing Refund record
    await assert.rejects(
      async () => {
        await dispatchRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_guard',
          leaseToken: claimed.leaseToken!,
          razorpayClient: { payments: { refund: async () => ({}) } },
        });
      },
      (err: any) => {
        assert.ok(err instanceof InvalidJobStateForDispatchError);
        assert.match(err.message, /No associated Refund record found/);
        return true;
      }
    );

    // Add Refund record, but payment is still uncaptured
    createTestRefund({
      orderId: order._id,
      paymentId: uncapturedPayment.paymentId,
      refundJobId: job._id,
      status: 'pending',
    });

    // Case 2: PaymentAttempt is not captured
    await assert.rejects(
      async () => {
        await dispatchRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_guard',
          leaseToken: claimed.leaseToken!,
          razorpayClient: { payments: { refund: async () => ({}) } },
        });
      },
      (err: any) => {
        assert.ok(err instanceof InvalidJobStateForDispatchError);
        assert.match(err.message, /is not captured/);
        return true;
      }
    );
  });

  // ============================================================================
  // 16. DETERMINISTIC PROVIDER IDEMPOTENCY KEY GENERATION
  // ============================================================================
  it('16. generateProviderRefundIdempotencyKey produces deterministic, valid alphanumeric keys <= 40 chars', () => {
    const key1 = 'refund:full:order:ord_123456789:payment:pay_ABCDEFGHIJKLMN';
    const providerKey1a = generateProviderRefundIdempotencyKey(key1);
    const providerKey1b = generateProviderRefundIdempotencyKey(key1);

    // Deterministic across invocations
    assert.strictEqual(providerKey1a, providerKey1b);

    // Format check: exactly 32 lowercase hex characters (alphanumeric, <= 40 chars)
    assert.strictEqual(providerKey1a.length, 32);
    assert.match(providerKey1a, /^[0-9a-f]{32}$/);

    // Different input keys produce distinct provider keys
    const key2 = 'refund:partial:order:ord_123456789:request:req_999:item:item_001';
    const providerKey2 = generateProviderRefundIdempotencyKey(key2);
    assert.notStrictEqual(providerKey1a, providerKey2);
    assert.strictEqual(providerKey2.length, 32);
    assert.match(providerKey2, /^[0-9a-f]{32}$/);
  });

  // ============================================================================
  // 17. CONCURRENT DISPATCHES ISOLATE X-REFUND-IDEMPOTENCY ON SHARED SDK CLIENT
  // ============================================================================
  it('17. concurrent dispatches using the same Razorpay SDK client isolate outgoing X-Refund-Idempotency headers without overlap', async () => {
    const orderA = createTestOrder({ totalAmount: 1000, amountPaise: 100000 });
    const paymentA = createTestPaymentAttempt({ orderId: orderA._id, paymentId: 'pay_conc_001', status: 'captured' });
    const jobA = createTestRefundJob({
      orderId: orderA._id,
      targetPaymentId: paymentA.paymentId,
      targetAmountPaise: 100000,
      idempotencyKey: 'refund:full:order:conc_001',
    });
    createTestRefund({ orderId: orderA._id, paymentId: paymentA.paymentId, refundJobId: jobA._id, amountPaise: 100000 });

    const orderB = createTestOrder({ totalAmount: 2000, amountPaise: 200000 });
    const paymentB = createTestPaymentAttempt({ orderId: orderB._id, paymentId: 'pay_conc_002', status: 'captured' });
    const jobB = createTestRefundJob({
      orderId: orderB._id,
      targetPaymentId: paymentB.paymentId,
      targetAmountPaise: 200000,
      idempotencyKey: 'refund:full:order:conc_002',
    });
    createTestRefund({ orderId: orderB._id, paymentId: paymentB.paymentId, refundJobId: jobB._id, amountPaise: 200000 });

    // Claim both jobs with distinct workers
    const claimA = await claimRefundJob({ workerId: 'worker_conc_a', jobId: jobA._id.toString() });
    const claimB = await claimRefundJob({ workerId: 'worker_conc_b', jobId: jobB._id.toString() });
    assert.ok(claimA);
    assert.ok(claimB);
    assert.notStrictEqual(claimA.providerIdempotencyKey, claimB.providerIdempotencyKey);

    // Single shared official Razorpay client instance
    const sharedRazorpayClient = new (Razorpay as any)({
      key_id: 'rzp_test_shared_key',
      key_secret: 'rzp_test_shared_secret',
    });

    const capturedOutgoingRequests: Array<{
      url: string;
      amount: number;
      jobId: string;
      header: string;
    }> = [];

    // Intercept outgoing HTTP transport at the Axios adapter level to inspect real outgoing headers
    sharedRazorpayClient.api.rq.defaults.adapter = async (config: any) => {
      // Artificial asynchronous delay to guarantee in-flight overlap
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 25 + 10));

      const parsedData = JSON.parse(config.data);
      capturedOutgoingRequests.push({
        url: config.url,
        amount: parsedData.amount,
        jobId: parsedData.notes?.refundJobId,
        header: config.headers?.['X-Refund-Idempotency'],
      });

      return {
        data: {
          id: `rfnd_${parsedData.notes?.refundJobId}`,
          status: 'processed',
        },
        status: 200,
        headers: {},
        config,
      };
    };

    // Dispatch both refunds concurrently using the exact same client instance
    const [resA, resB] = await Promise.all([
      dispatchRefundJob({
        jobId: jobA._id.toString(),
        workerId: 'worker_conc_a',
        leaseToken: claimA.leaseToken!,
        razorpayClient: sharedRazorpayClient,
      }),
      dispatchRefundJob({
        jobId: jobB._id.toString(),
        workerId: 'worker_conc_b',
        leaseToken: claimB.leaseToken!,
        razorpayClient: sharedRazorpayClient,
      }),
    ]);

    assert.strictEqual(resA.status, 'succeeded');
    assert.strictEqual(resB.status, 'succeeded');

    assert.strictEqual(capturedOutgoingRequests.length, 2);

    const outgoingA = capturedOutgoingRequests.find((r) => r.jobId === jobA._id.toString());
    const outgoingB = capturedOutgoingRequests.find((r) => r.jobId === jobB._id.toString());

    assert.ok(outgoingA, 'Outgoing request for Job A must be recorded');
    assert.ok(outgoingB, 'Outgoing request for Job B must be recorded');

    // Strict validation: each request has its own correct key and neither overwrote the other
    assert.strictEqual(outgoingA.header, claimA.providerIdempotencyKey);
    assert.strictEqual(outgoingB.header, claimB.providerIdempotencyKey);
    assert.notStrictEqual(outgoingA.header, outgoingB.header);
  });

  // ============================================================================
  // 18. CONCURRENT DISPATCHES USING SHARED MOCK CLIENT
  // ============================================================================
  it('18. concurrent dispatches using a shared mock Razorpay client pass request-scoped headers without mutual interference', async () => {
    const orderA = createTestOrder({ totalAmount: 1500, amountPaise: 150000 });
    const paymentA = createTestPaymentAttempt({ orderId: orderA._id, paymentId: 'pay_mock_conc_001', status: 'captured' });
    const jobA = createTestRefundJob({
      orderId: orderA._id,
      targetPaymentId: paymentA.paymentId,
      targetAmountPaise: 150000,
      idempotencyKey: 'refund:full:order:mock_conc_001',
    });
    createTestRefund({ orderId: orderA._id, paymentId: paymentA.paymentId, refundJobId: jobA._id, amountPaise: 150000 });

    const orderB = createTestOrder({ totalAmount: 2500, amountPaise: 250000 });
    const paymentB = createTestPaymentAttempt({ orderId: orderB._id, paymentId: 'pay_mock_conc_002', status: 'captured' });
    const jobB = createTestRefundJob({
      orderId: orderB._id,
      targetPaymentId: paymentB.paymentId,
      targetAmountPaise: 250000,
      idempotencyKey: 'refund:full:order:mock_conc_002',
    });
    createTestRefund({ orderId: orderB._id, paymentId: paymentB.paymentId, refundJobId: jobB._id, amountPaise: 250000 });

    const claimA = await claimRefundJob({ workerId: 'worker_mock_a', jobId: jobA._id.toString() });
    const claimB = await claimRefundJob({ workerId: 'worker_mock_b', jobId: jobB._id.toString() });
    assert.ok(claimA);
    assert.ok(claimB);

    const receivedCalls: Array<{ paymentId: string; amount: number; header: string }> = [];

    const sharedMockClient = {
      payments: {
        refund: async (paymentId: string, payload: any, options: any) => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 + 5));
          receivedCalls.push({
            paymentId,
            amount: payload.amount,
            header: options?.headers?.['X-Refund-Idempotency'],
          });
          return { id: `rfnd_${paymentId}`, status: 'processed' };
        },
      },
    };

    const [resA, resB] = await Promise.all([
      dispatchRefundJob({
        jobId: jobA._id.toString(),
        workerId: 'worker_mock_a',
        leaseToken: claimA.leaseToken!,
        razorpayClient: sharedMockClient,
      }),
      dispatchRefundJob({
        jobId: jobB._id.toString(),
        workerId: 'worker_mock_b',
        leaseToken: claimB.leaseToken!,
        razorpayClient: sharedMockClient,
      }),
    ]);

    assert.strictEqual(resA.status, 'succeeded');
    assert.strictEqual(resB.status, 'succeeded');
    assert.strictEqual(receivedCalls.length, 2);

    const callA = receivedCalls.find((c) => c.paymentId === paymentA.paymentId);
    const callB = receivedCalls.find((c) => c.paymentId === paymentB.paymentId);

    assert.ok(callA);
    assert.ok(callB);
    assert.strictEqual(callA.header, claimA.providerIdempotencyKey);
    assert.strictEqual(callB.header, claimB.providerIdempotencyKey);
    assert.notStrictEqual(callA.header, callB.header);
  });

  // ============================================================================
  // 19. RETRIES PRESERVE ORIGINAL PROVIDER IDEMPOTENCY KEY AND PAYLOAD UNDER CONCURRENCY
  // ============================================================================
  it('19. concurrent retries preserve their original providerIdempotencyKey and request payload', async () => {
    const orderRetry = createTestOrder({ totalAmount: 3000, amountPaise: 300000 });
    const paymentRetry = createTestPaymentAttempt({ orderId: orderRetry._id, paymentId: 'pay_retry_p1', status: 'captured' });
    const originalProviderKey = 'deadbeef1234567890abcdef12345678';

    const jobRetry = createTestRefundJob({
      orderId: orderRetry._id,
      targetPaymentId: paymentRetry.paymentId,
      targetAmountPaise: 300000,
      reason: 'cancellation_retry',
      classification: 'purchase_compensation',
      status: 'failed_retryable',
      attempts: 1,
      maxRetries: 3,
      providerIdempotencyKey: originalProviderKey,
    });
    createTestRefund({ orderId: orderRetry._id, paymentId: paymentRetry.paymentId, refundJobId: jobRetry._id, amountPaise: 300000 });

    const orderFresh = createTestOrder({ totalAmount: 4000, amountPaise: 400000 });
    const paymentFresh = createTestPaymentAttempt({ orderId: orderFresh._id, paymentId: 'pay_fresh_p2', status: 'captured' });
    const jobFresh = createTestRefundJob({
      orderId: orderFresh._id,
      targetPaymentId: paymentFresh.paymentId,
      targetAmountPaise: 400000,
      reason: 'fresh_cancellation',
      classification: 'purchase_compensation',
      status: 'pending',
    });
    createTestRefund({ orderId: orderFresh._id, paymentId: paymentFresh.paymentId, refundJobId: jobFresh._id, amountPaise: 400000 });

    const claimRetry = await claimRefundJob({ workerId: 'worker_retry', jobId: jobRetry._id.toString() });
    const claimFresh = await claimRefundJob({ workerId: 'worker_fresh', jobId: jobFresh._id.toString() });
    assert.ok(claimRetry);
    assert.ok(claimFresh);

    assert.strictEqual(claimRetry.providerIdempotencyKey, originalProviderKey, 'Retry must preserve original provider key');
    assert.notStrictEqual(claimFresh.providerIdempotencyKey, originalProviderKey);

    const capturedCalls: Array<{ paymentId: string; amount: number; reason: string; header: string }> = [];

    const sharedRazorpayClient = new (Razorpay as any)({
      key_id: 'rzp_test_retry_key',
      key_secret: 'rzp_test_retry_secret',
    });

    sharedRazorpayClient.api.rq.defaults.adapter = async (config: any) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 + 5));
      const parsedData = JSON.parse(config.data);
      capturedCalls.push({
        paymentId: config.url.split('/')[3],
        amount: parsedData.amount,
        reason: parsedData.notes?.reason,
        header: config.headers?.['X-Refund-Idempotency'],
      });
      return {
        data: { id: `rfnd_${config.url.split('/')[3]}`, status: 'processed' },
        status: 200,
        headers: {},
        config,
      };
    };

    const [resRetry, resFresh] = await Promise.all([
      dispatchRefundJob({
        jobId: jobRetry._id.toString(),
        workerId: 'worker_retry',
        leaseToken: claimRetry.leaseToken!,
        razorpayClient: sharedRazorpayClient,
      }),
      dispatchRefundJob({
        jobId: jobFresh._id.toString(),
        workerId: 'worker_fresh',
        leaseToken: claimFresh.leaseToken!,
        razorpayClient: sharedRazorpayClient,
      }),
    ]);

    assert.strictEqual(resRetry.status, 'succeeded');
    assert.strictEqual(resFresh.status, 'succeeded');

    const retryCall = capturedCalls.find((c) => c.paymentId === paymentRetry.paymentId);
    const freshCall = capturedCalls.find((c) => c.paymentId === paymentFresh.paymentId);

    assert.ok(retryCall);
    assert.ok(freshCall);

    // Verify retry retained original key, payload amount, and reason
    assert.strictEqual(retryCall.header, originalProviderKey);
    assert.strictEqual(retryCall.amount, 300000);
    assert.strictEqual(retryCall.reason, 'cancellation_retry');

    // Verify fresh call received its own key
    assert.strictEqual(freshCall.header, claimFresh.providerIdempotencyKey);
    assert.strictEqual(freshCall.amount, 400000);
    assert.strictEqual(freshCall.reason, 'fresh_cancellation');

    assert.notStrictEqual(retryCall.header, freshCall.header);
  });
});
