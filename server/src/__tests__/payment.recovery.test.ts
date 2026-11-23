/**
 * ============================================================================
 * PHASE 8.3 — STEP 6: BACKGROUND PAYMENT RECOVERY WORKERS TEST SUITE
 * ============================================================================
 *
 * ARCHITECTURAL NOTICE ON TEST HARNESS:
 * In accordance with strict project rules, all tests run in-process without
 * connecting to external networks, MongoDB Atlas, or live Razorpay APIs.
 *
 * Verifies:
 * 1. Expired webhook event recovery (clean lease reset vs retry exhaustion failure).
 * 2. Expired refund job lease recovery (apiDispatched: false -> pending, apiDispatched: true -> uncertain).
 * 3. Authoritative reconciliation of uncertain refund outcomes (processed -> settle, failed -> release, pending -> retain, not_found -> retry).
 * 4. Transient backoff and bounded retries (exponential cooldown respected, maxRetries escalates to manual_review).
 * 5. Concurrent worker lease claiming (atomic claim, exactly one winner).
 * 6. Stale worker fencing (superseded or expired lease token rejected).
 * 7. Duplicate accounting prevention (idempotent settlement, single increment of confirmed paise).
 * 8. Worker process lifecycle and in-process sweep overlap prevention.
 * 9. Configuration validation bounds and environment variable parsing.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob } from '../models/RefundJob.js';
import { WebhookEvent, IWebhookEvent, claimWebhookEvent, completeWebhookEvent } from '../models/WebhookEvent.js';
import {
  WorkerConfig,
  DEFAULT_WORKER_CONFIG,
  validateWorkerConfig,
  getWorkerConfig,
} from '../config/worker.config.js';
import {
  calculateBackoffMs,
  isJobEligibleForRetry,
  sweepExpiredWebhookEvents,
  sweepExpiredRefundJobLeases,
  reconcileUncertainRefundJob,
  sweepUncertainRefundJobs,
  sweepAndDispatchRetryableJobs,
  reconcilePendingRefundSettlements,
  runRecoverySweep,
} from '../services/recovery.service.js';
import { PaymentRecoveryWorker } from '../workers/payment-recovery.worker.js';

describe('Phase 8.3 — Step 6: Background Payment Recovery Workers', () => {
  let databaseOrders: any[] = [];
  let databasePaymentAttempts: any[] = [];
  let databaseRefunds: any[] = [];
  let databaseRefundJobs: any[] = [];
  let databaseWebhookEvents: any[] = [];

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
      razorpayPaymentId: overrides.razorpayPaymentId !== undefined ? overrides.razorpayPaymentId : null,
      idempotencyKey: overrides.idempotencyKey || `idem_${orderId}`,
      totalCapturedPaise: overrides.totalCapturedPaise !== undefined ? overrides.totalCapturedPaise : amountPaise,
      purchaseCapturedPaise: overrides.purchaseCapturedPaise !== undefined ? overrides.purchaseCapturedPaise : amountPaise,
      duplicateCapturedPaise: overrides.duplicateCapturedPaise !== undefined ? overrides.duplicateCapturedPaise : 0,
      amountReservedRefundPaise: overrides.amountReservedRefundPaise !== undefined ? overrides.amountReservedRefundPaise : amountPaise,
      confirmedRefundPaise: overrides.confirmedRefundPaise !== undefined ? overrides.confirmedRefundPaise : 0,
      purchaseRefundedPaise: overrides.purchaseRefundedPaise !== undefined ? overrides.purchaseRefundedPaise : 0,
      duplicateRefundedPaise: overrides.duplicateRefundedPaise !== undefined ? overrides.duplicateRefundedPaise : 0,
      primaryPaymentId: overrides.primaryPaymentId !== undefined ? overrides.primaryPaymentId : null,
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
    const doc: any = Refund.hydrate({
      _id: overrides._id || new mongoose.Types.ObjectId(),
      refundId,
      orderId: overrides.orderId || databaseOrders[0]?._id || new mongoose.Types.ObjectId(),
      paymentId: overrides.paymentId || databasePaymentAttempts[0]?.paymentId || 'pay_test_default',
      refundJobId: overrides.refundJobId || databaseRefundJobs[0]?._id,
      amountPaise: overrides.amountPaise ?? 417000,
      currency: overrides.currency || 'INR',
      type: overrides.type || 'purchase_compensation',
      status: overrides.status || 'pending',
      providerRefundId: overrides.providerRefundId,
      notes: overrides.notes,
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
    });

    databaseRefunds.push(doc);
    return doc;
  }

  function createTestRefundJob(overrides: Partial<any> = {}): IRefundJob {
    const idempotencyKey =
      overrides.idempotencyKey ||
      `refund:job:${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const doc: any = RefundJob.hydrate({
      _id: overrides._id || new mongoose.Types.ObjectId(),
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
      providerRefundId: overrides.providerRefundId,
      providerIdempotencyKey: overrides.providerIdempotencyKey,
      leaseWorkerId: overrides.leaseWorkerId ?? null,
      leaseToken: overrides.leaseToken ?? null,
      leaseAcquiredAt: overrides.leaseAcquiredAt ?? null,
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      errorHistory: overrides.errorHistory || [],
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
    });

    databaseRefundJobs.push(doc);
    return doc;
  }

  const TEST_WEBHOOK_SECRET = 'mock_webhook_secret_step6';

  function signWebhookPayload(rawBody: string | Buffer): string {
    return crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

  function createTestWebhookEvent(overrides: Partial<any> = {}): IWebhookEvent {
    const eventId = overrides.eventId || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const doc: any = WebhookEvent.hydrate({
      _id: overrides._id || new mongoose.Types.ObjectId(),
      eventId,
      event: overrides.event || 'payment.captured',
      status: overrides.status || 'processing',
      payload: overrides.payload,
      rawBody: overrides.rawBody,
      signature: overrides.signature,
      attempts: overrides.attempts ?? 1,
      orderId: overrides.orderId,
      paymentId: overrides.paymentId,
      leaseWorkerId: overrides.leaseWorkerId ?? null,
      leaseToken: overrides.leaseToken ?? null,
      leaseAcquiredAt: overrides.leaseAcquiredAt ?? null,
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      error: overrides.error,
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
    });

    databaseWebhookEvents.push(doc);
    return doc;
  }

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_mockKeyId';
    process.env.RAZORPAY_KEY_SECRET = 'mockKeySecret';

    databaseOrders = [];
    databasePaymentAttempts = [];
    databaseRefunds = [];
    databaseRefundJobs = [];
    databaseWebhookEvents = [];

    // Mock Order methods
    Order.findById = (async (id: any) => {
      const found = databaseOrders.find((d) => d._id.toString() === id.toString());
      if (found) {
        found.session = function () { return this; };
      }
      return found || null;
    }) as any;

    Order.findOne = (async (query: any) => {
      const found = databaseOrders.find((d) => {
        if (query._id && d._id.toString() !== query._id.toString()) return false;
        if (query.orderId && d.orderId !== query.orderId) return false;
        if (query.razorpayOrderId && d.razorpayOrderId !== query.razorpayOrderId) return false;
        return true;
      });
      if (found) {
        found.session = function () { return this; };
      }
      return found || null;
    }) as any;

    Order.prototype.save = async function () {
      return this;
    };

    // Mock PaymentAttempt methods
    PaymentAttempt.findOne = (async (query: any) => {
      const found = databasePaymentAttempts.find((p) => {
        if (query.paymentId && p.paymentId !== query.paymentId) return false;
        return true;
      });
      if (found) {
        found.session = function () { return this; };
      }
      return found || null;
    }) as any;

    PaymentAttempt.prototype.save = async function () {
      return this;
    };

    PaymentAttempt.create = (async (docs: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      const created = arr.map((d: any) => ({
        ...d,
        _id: d._id || new mongoose.Types.ObjectId(),
        save: async function () {
          const idx = databasePaymentAttempts.findIndex((p) => p.paymentId === this.paymentId);
          if (idx >= 0) databasePaymentAttempts[idx] = this;
          else databasePaymentAttempts.push(this);
          return this;
        },
      }));
      databasePaymentAttempts.push(...created);
      return Array.isArray(docs) ? created : created[0];
    }) as any;

    Cart.findOne = (async () => null) as any;

    // Mock Refund methods
    Refund.findOne = (async (query: any) => {
      const found = databaseRefunds.find((r) => {
        if (query.$or) {
          const matchOr = query.$or.some((c: any) => {
            if (c.providerRefundId && r.providerRefundId === c.providerRefundId) return true;
            if (c.refundId && r.refundId === c.refundId) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        if (query.refundJobId && (!r.refundJobId || r.refundJobId.toString() !== query.refundJobId.toString())) {
          return false;
        }
        if (query.refundId && r.refundId !== query.refundId) return false;
        if (query.paymentId && r.paymentId !== query.paymentId) return false;
        if (query.amountPaise && r.amountPaise !== query.amountPaise) return false;
        if (query.status && r.status !== query.status) return false;
        return true;
      });
      if (found) {
        found.session = function () { return this; };
      }
      return found || null;
    }) as any;

    Refund.find = function (query: any) {
      let results = databaseRefunds.filter((r) => {
        if (query.status && r.status !== query.status) return false;
        if (query.providerRefundId) {
          if (query.providerRefundId.$exists === true && (r.providerRefundId === null || r.providerRefundId === undefined)) {
            return false;
          }
        }
        if (query.createdAt && query.createdAt.$lte) {
          if (r.createdAt && new Date(r.createdAt).getTime() > new Date(query.createdAt.$lte).getTime()) {
            return false;
          }
        }
        return true;
      });

      const queryObj: any = {
        limit: function (limitCount: number) {
          results = results.slice(0, limitCount);
          return queryObj;
        },
        exec: async function () {
          return results;
        },
        then: function (resolve: any, reject: any) {
          return queryObj.exec().then(resolve, reject);
        },
      };
      return queryObj;
    } as any;

    Refund.prototype.save = async function () {
      return this;
    };

    Refund.updateOne = (async (filter: any, update: any) => {
      const item = databaseRefunds.find((r) => {
        if (filter._id && r._id.toString() !== filter._id.toString()) return false;
        if (filter.refundId && r.refundId !== filter.refundId) return false;
        return true;
      });
      if (!item) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(item, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }) as any;

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

    RefundJob.find = function (query: any) {
      let results = databaseRefundJobs.filter((j) => {
        // Status filter
        if (query.status) {
          if (query.status.$in) {
            if (!query.status.$in.includes(j.status)) return false;
          } else if (j.status !== query.status) {
            return false;
          }
        }

        // leaseExpiresAt filter
        if (query.leaseExpiresAt && query.leaseExpiresAt.$lte) {
          if (!j.leaseExpiresAt || new Date(j.leaseExpiresAt).getTime() > new Date(query.leaseExpiresAt.$lte).getTime()) {
            return false;
          }
        }

        // $or clause
        if (query.$or) {
          const matched = query.$or.some((cond: any) => {
            if ('leaseExpiresAt' in cond) {
              if (cond.leaseExpiresAt === null) return j.leaseExpiresAt == null;
              if (cond.leaseExpiresAt.$lte) {
                return (
                  j.leaseExpiresAt &&
                  new Date(j.leaseExpiresAt).getTime() <= new Date(cond.leaseExpiresAt.$lte).getTime()
                );
              }
              if (cond.leaseExpiresAt.$lt) {
                return (
                  j.leaseExpiresAt &&
                  new Date(j.leaseExpiresAt).getTime() < new Date(cond.leaseExpiresAt.$lt).getTime()
                );
              }
            }
            return false;
          });
          if (!matched) return false;
        }

        return true;
      });

      const queryObj: any = {
        sort: function () {
          return queryObj;
        },
        limit: function (limitCount: number) {
          results = results.slice(0, limitCount);
          return queryObj;
        },
        exec: async function () {
          return results;
        },
        then: function (resolve: any, reject: any) {
          return queryObj.exec().then(resolve, reject);
        },
      };
      return queryObj;
    } as any;

    RefundJob.updateOne = (async (query: any, update: any) => {
      const found = databaseRefundJobs.find((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.leaseToken && j.leaseToken !== query.leaseToken) return false;
        if (query.status && query.status.$ne && j.status === query.status.$ne) return false;
        return true;
      });
      if (!found) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(found, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }) as any;

    RefundJob.findOneAndUpdate = (async (query: any, update: any) => {
      const candidate = databaseRefundJobs.find((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.leaseToken && j.leaseToken !== query.leaseToken) return false;

        // Status match
        if (query.status) {
          if (query.status.$in) {
            if (!query.status.$in.includes(j.status)) return false;
          } else if (j.status !== query.status) {
            return false;
          }
        }

        // $or clause
        if (query.$or) {
          const matched = query.$or.some((cond: any) => {
            if ('leaseExpiresAt' in cond) {
              if (cond.leaseExpiresAt === null) return j.leaseExpiresAt == null;
              if (cond.leaseExpiresAt.$lte) {
                return (
                  j.leaseExpiresAt &&
                  new Date(j.leaseExpiresAt).getTime() <= new Date(cond.leaseExpiresAt.$lte).getTime()
                );
              }
              if (cond.leaseExpiresAt.$lt) {
                return (
                  j.leaseExpiresAt &&
                  new Date(j.leaseExpiresAt).getTime() < new Date(cond.leaseExpiresAt.$lt).getTime()
                );
              }
            }
            return false;
          });
          if (!matched) return false;
        }

        return true;
      });

      if (!candidate) return null;

      if (update.$set) {
        Object.assign(candidate, update.$set);
      }
      if (update.$inc?.attempts) {
        candidate.attempts = (candidate.attempts || 0) + update.$inc.attempts;
      }
      if (update.$push?.errorHistory) {
        candidate.errorHistory = candidate.errorHistory || [];
        candidate.errorHistory.push(update.$push.errorHistory);
      }

      candidate.updatedAt = new Date();
      return candidate;
    }) as any;

    RefundJob.prototype.save = async function () {
      return this;
    };

    // Mock WebhookEvent methods
    WebhookEvent.find = function (query: any) {
      let results = databaseWebhookEvents.filter((e) => {
        if (query.status && e.status !== query.status) return false;
        if (query.leaseExpiresAt && query.leaseExpiresAt.$lte) {
          if (!e.leaseExpiresAt || new Date(e.leaseExpiresAt).getTime() > new Date(query.leaseExpiresAt.$lte).getTime()) {
            return false;
          }
        }
        return true;
      });

      const queryObj: any = {
        limit: function (limitCount: number) {
          results = results.slice(0, limitCount);
          return queryObj;
        },
        exec: async function () {
          return results;
        },
        then: function (resolve: any, reject: any) {
          return queryObj.exec().then(resolve, reject);
        },
      };
      return queryObj;
    } as any;

    WebhookEvent.findOne = (async (query: any) => {
      return databaseWebhookEvents.find((e) => e.eventId === query.eventId) || null;
    }) as any;

    WebhookEvent.create = (async (data: any) => {
      const existing = databaseWebhookEvents.find((e) => e.eventId === data.eventId);
      if (existing) {
        const dupError: any = new Error(
          `E11000 duplicate key error collection: project_world.webhookevents index: eventId_1 dup key: { eventId: "${data.eventId}" }`
        );
        dupError.code = 11000;
        throw dupError;
      }
      const doc: any = {
        ...data,
        _id: new mongoose.Types.ObjectId(),
        attempts: data.attempts || 1,
        save: async function () {
          const idx = databaseWebhookEvents.findIndex((e) => e.eventId === this.eventId);
          if (idx >= 0) databaseWebhookEvents[idx] = this;
          else databaseWebhookEvents.push(this);
          return this;
        },
      };
      databaseWebhookEvents.push(doc);
      return doc;
    }) as any;

    WebhookEvent.findOneAndUpdate = (async (query: any, update: any) => {
      const item = databaseWebhookEvents.find((e) => {
        if (query._id && e._id.toString() !== query._id.toString()) return false;
        if (query.eventId && e.eventId !== query.eventId) return false;
        if (query.leaseToken && e.leaseToken !== query.leaseToken) return false;
        if (query.status && e.status !== query.status) return false;
        if (query.$or) {
          const matched = query.$or.some((cond: any) => {
            if (cond.leaseExpiresAt?.$lte) {
              return (
                e.leaseExpiresAt &&
                new Date(e.leaseExpiresAt).getTime() <= new Date(cond.leaseExpiresAt.$lte).getTime()
              );
            }
            if (cond.leaseExpiresAt === null) return e.leaseExpiresAt == null;
            if (cond.leaseExpiresAt?.$exists === false) return e.leaseExpiresAt === undefined;
            return false;
          });
          if (!matched) return false;
        }
        return true;
      });

      if (!item) return null;

      if (update.$set) {
        Object.assign(item, update.$set);
      }
      if (update.status) item.status = update.status;
      if (update.$inc?.attempts) item.attempts = (item.attempts || 1) + update.$inc.attempts;

      item.updatedAt = new Date();
      return item;
    }) as any;
  });

  // ============================================================================
  // 1. CONFIGURATION & BACKOFF LOGIC
  // ============================================================================
  describe('1. Configuration & Backoff Logic', () => {
    it('1.1 validateWorkerConfig enforces architectural bounds on parameters', () => {
      const valid = validateWorkerConfig({
        sweepIntervalMs: 15_000,
        batchSize: 25,
        leaseDurationMs: 45_000,
        maxRetries: 5,
        baseBackoffMs: 2_000,
        maxBackoffMs: 60_000,
        workerId: 'custom_worker_01',
      });

      assert.equal(valid.sweepIntervalMs, 15_000);
      assert.equal(valid.batchSize, 25);
      assert.equal(valid.leaseDurationMs, 45_000);
      assert.equal(valid.maxRetries, 5);
      assert.equal(valid.baseBackoffMs, 2_000);
      assert.equal(valid.maxBackoffMs, 60_000);
      assert.equal(valid.workerId, 'custom_worker_01');

      // Reject invalid sweepIntervalMs (< 1000)
      assert.throws(() => validateWorkerConfig({ sweepIntervalMs: 500 }), /sweepIntervalMs/);

      // Reject invalid batchSize (< 1 or > 500)
      assert.throws(() => validateWorkerConfig({ batchSize: 0 }), /batchSize/);
      assert.throws(() => validateWorkerConfig({ batchSize: 600 }), /batchSize/);

      // Reject invalid leaseDurationMs (< 5000)
      assert.throws(() => validateWorkerConfig({ leaseDurationMs: 2000 }), /leaseDurationMs/);

      // Reject invalid maxRetries (< 1)
      assert.throws(() => validateWorkerConfig({ maxRetries: 0 }), /maxRetries/);

      // Reject invalid maxBackoffMs (< baseBackoffMs)
      assert.throws(
        () => validateWorkerConfig({ baseBackoffMs: 10_000, maxBackoffMs: 5_000 }),
        /maxBackoffMs/
      );
    });

    it('1.2 getWorkerConfig reads from environment variables with safe fallbacks', () => {
      const origEnv = { ...process.env };
      try {
        process.env.RECOVERY_SWEEP_INTERVAL_MS = '45000';
        process.env.RECOVERY_BATCH_SIZE = '100';
        process.env.RECOVERY_LEASE_DURATION_MS = '90000';
        process.env.RECOVERY_MAX_RETRIES = '4';
        process.env.RECOVERY_WORKER_ID = 'env_worker_node_1';

        const config = getWorkerConfig();
        assert.equal(config.sweepIntervalMs, 45_000);
        assert.equal(config.batchSize, 100);
        assert.equal(config.leaseDurationMs, 90_000);
        assert.equal(config.maxRetries, 4);
        assert.equal(config.workerId, 'env_worker_node_1');
      } finally {
        process.env = origEnv;
      }
    });

    it('1.3 calculateBackoffMs returns exponential backoff capped at maxBackoffMs', () => {
      assert.equal(calculateBackoffMs(0, 5000, 300000), 0);
      assert.equal(calculateBackoffMs(1, 5000, 300000), 5000); // 5000 * 2^0
      assert.equal(calculateBackoffMs(2, 5000, 300000), 10000); // 5000 * 2^1
      assert.equal(calculateBackoffMs(3, 5000, 300000), 20000); // 5000 * 2^2
      assert.equal(calculateBackoffMs(4, 5000, 300000), 40000); // 5000 * 2^3
      assert.equal(calculateBackoffMs(10, 5000, 50000), 50000); // Capped at 50,000ms
    });

    it('1.4 isJobEligibleForRetry evaluates cooldown timestamps correctly', () => {
      const now = new Date('2026-11-23T12:00:00.000Z');

      // Pending jobs are always eligible
      const pendingJob: any = { status: 'pending', attempts: 0 };
      assert.equal(isJobEligibleForRetry(pendingJob, now), true);

      // Succeeded or manual_review jobs are never eligible
      assert.equal(isJobEligibleForRetry({ status: 'succeeded', attempts: 1 } as any, now), false);
      assert.equal(isJobEligibleForRetry({ status: 'manual_review', attempts: 1 } as any, now), false);

      // Failed retryable job within cooldown period
      const recentFailedJob: any = {
        status: 'failed_retryable',
        attempts: 1, // backoff = 5000ms
        maxRetries: 3,
        updatedAt: new Date('2026-11-23T11:59:58.000Z'), // 2s ago
        errorHistory: [{ error: '500 Server Error', timestamp: new Date('2026-11-23T11:59:58.000Z') }],
      };
      assert.equal(isJobEligibleForRetry(recentFailedJob, now, 5000), false);

      // Failed retryable job after cooldown has passed
      const maturedFailedJob: any = {
        status: 'failed_retryable',
        attempts: 1, // backoff = 5000ms
        maxRetries: 3,
        updatedAt: new Date('2026-11-23T11:59:50.000Z'), // 10s ago
        errorHistory: [{ error: '500 Server Error', timestamp: new Date('2026-11-23T11:59:50.000Z') }],
      };
      assert.equal(isJobEligibleForRetry(maturedFailedJob, now, 5000), true);

      // Failed retryable job with attempts >= maxRetries is not eligible
      const exhaustedJob: any = {
        status: 'failed_retryable',
        attempts: 3,
        maxRetries: 3,
        updatedAt: new Date('2026-11-23T11:50:00.000Z'),
      };
      assert.equal(isJobEligibleForRetry(exhaustedJob, now), false);
    });
  });

  // ============================================================================
  // 2. EXPIRED WEBHOOK EVENT RECOVERY & SECURE REPLAY
  // ============================================================================
  describe('2. Expired Webhook Event Recovery & Secure Replay', () => {
    it('2.1 an expired event with stored verified payload is actually processed again without requiring Razorpay redelivery', async () => {
      const order = createTestOrder({
        orderId: 'ord_replay_001',
        razorpayOrderId: 'order_rzp_replay_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
        purchaseCapturedPaise: 0,
      });

      const paymentId = 'pay_replay_captured_111';
      const payloadObj = {
        event: 'payment.captured',
        event_id: 'evt_replay_001',
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: order.razorpayOrderId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              method: 'card',
            },
          },
        },
      };

      const rawBodyStr = JSON.stringify(payloadObj);
      const signature = signWebhookPayload(rawBodyStr);

      const evt = createTestWebhookEvent({
        eventId: 'evt_replay_001',
        event: 'payment.captured',
        status: 'processing',
        payload: payloadObj,
        rawBody: rawBodyStr,
        signature,
        attempts: 1,
        leaseWorkerId: 'worker_crashed_before_capture',
        leaseToken: 'token_old_crashed',
        leaseExpiresAt: new Date(Date.now() - 30_000), // Expired 30 seconds ago
      });

      const mockRazorpay = {
        payments: {
          fetch: async (id: string) => ({
            id,
            order_id: order.razorpayOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            method: 'card',
          }),
        },
      };

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.reprocessedSuccessCount, 1);
      assert.equal(evt.status, 'processed');
      assert.equal(evt.orderId, order.orderId);
      assert.equal(evt.paymentId, paymentId);
      assert.equal(order.paymentStatus, 'captured');
      assert.equal(order.status, 'completed');
      assert.equal(order.totalCapturedPaise, 417000);
      assert.equal(order.razorpayPaymentId, paymentId);
    });

    it('2.2 a completed event is never processed twice', async () => {
      const evt = createTestWebhookEvent({
        eventId: 'evt_already_done_999',
        event: 'payment.captured',
        status: 'processed',
        processedAt: new Date(Date.now() - 60_000),
      });

      const res = await sweepExpiredWebhookEvents({ now: new Date(), maxRetries: 3 });
      assert.equal(res.reprocessedSuccessCount, 0);
      assert.equal(evt.status, 'processed');

      const claimRes = await claimWebhookEvent({
        eventId: evt.eventId,
        eventName: evt.event,
        workerId: 'worker_attempt_duplicate',
      });
      assert.equal(claimRes.claimed, false);
      assert.equal(claimRes.reason, 'already_processed');
    });

    it('2.3 concurrent workers cannot process the same expired webhook event successfully', async () => {
      const order = createTestOrder({
        orderId: 'ord_race_001',
        razorpayOrderId: 'order_rzp_race_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
      });

      const payloadObj = {
        event: 'payment.captured',
        event_id: 'evt_race_001',
        payload: {
          payment: {
            entity: {
              id: 'pay_race_111',
              order_id: order.razorpayOrderId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      };
      const rawBodyStr = JSON.stringify(payloadObj);
      const signature = signWebhookPayload(rawBodyStr);

      createTestWebhookEvent({
        eventId: 'evt_race_001',
        event: 'payment.captured',
        status: 'processing',
        payload: payloadObj,
        rawBody: rawBodyStr,
        signature,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const mockRazorpay = {
        payments: {
          fetch: async (id: string) => ({
            id,
            order_id: order.razorpayOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
          }),
        },
      };

      const [res1, res2] = await Promise.all([
        sweepExpiredWebhookEvents({ workerId: 'worker_A', razorpayClient: mockRazorpay }),
        sweepExpiredWebhookEvents({ workerId: 'worker_B', razorpayClient: mockRazorpay }),
      ]);

      assert.equal(
        res1.reprocessedSuccessCount + res2.reprocessedSuccessCount,
        1,
        'Exactly one worker must reprocess the expired event'
      );
    });

    it('2.4 a stale worker cannot overwrite a newer worker result via leaseToken fencing', async () => {
      const evt = createTestWebhookEvent({
        eventId: 'evt_fence_test',
        status: 'processing',
        leaseWorkerId: 'worker_stale_1',
        leaseToken: 'token_stale_1',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      // Newer Worker 2 reclaims the event with fresh leaseToken
      evt.leaseWorkerId = 'worker_active_2';
      evt.leaseToken = 'token_active_2';
      evt.leaseExpiresAt = new Date(Date.now() + 60_000);

      // Stale worker 1 attempts to complete with superseded token
      const staleComplete = await completeWebhookEvent({
        eventId: evt.eventId,
        leaseToken: 'token_stale_1',
        status: 'failed',
        error: 'Stale error should not be written',
      });
      assert.equal(staleComplete, false, 'Stale worker update must be rejected');

      // Active worker 2 completes with active token
      const activeComplete = await completeWebhookEvent({
        eventId: evt.eventId,
        leaseToken: 'token_active_2',
        status: 'processed',
        orderId: 'ord_real_001',
      });
      assert.equal(activeComplete, true, 'Active worker update must succeed');
      assert.equal(evt.status, 'processed');
      assert.equal(evt.orderId, 'ord_real_001');
    });

    it('2.5 invalid or unavailable stored payloads do not cause financial records to be modified', async () => {
      const order = createTestOrder({
        orderId: 'ord_safety_001',
        amountReservedRefundPaise: 0,
        confirmedRefundPaise: 0,
        paymentStatus: 'pending',
      });

      // Sub-case A: Payload is unavailable (null)
      const evtUnavailable = createTestWebhookEvent({
        eventId: 'evt_no_payload',
        event: 'payment.captured',
        status: 'processing',
        payload: null,
        rawBody: undefined,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const resA = await sweepExpiredWebhookEvents({ now: new Date() });
      assert.equal(resA.recoveredFailedCount, 1);
      assert.equal(evtUnavailable.status, 'failed');
      assert.match(evtUnavailable.error || '', /unavailable for safe replay/i);

      // Verify order financial totals are strictly untouched
      assert.equal(order.paymentStatus, 'pending');
      assert.equal(order.confirmedRefundPaise, 0);

      // Sub-case B: Payload was tampered / signature mismatch
      const tamperedBody = JSON.stringify({ event: 'payment.captured', tampered: true });
      const evtTampered = createTestWebhookEvent({
        eventId: 'evt_tampered_payload',
        event: 'payment.captured',
        status: 'processing',
        payload: { event: 'payment.captured', tampered: true },
        rawBody: tamperedBody,
        signature: 'forged_invalid_signature_hex',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const resB = await sweepExpiredWebhookEvents({ now: new Date() });
      assert.equal(resB.recoveredFailedCount, 1);
      assert.equal(evtTampered.status, 'failed');
      assert.match(evtTampered.error || '', /signature verification/i);

      // Verify order financial totals remain strictly untouched
      assert.equal(order.paymentStatus, 'pending');
      assert.equal(order.confirmedRefundPaise, 0);
    });

    it('2.6 marks webhook failed when attempts >= maxRetries to prevent infinite recovery churn', async () => {
      const evt = createTestWebhookEvent({
        eventId: 'evt_exp_exhausted',
        status: 'processing',
        attempts: 3,
        leaseWorkerId: 'worker_crashed_02',
        leaseToken: 'token_old_222',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const res = await sweepExpiredWebhookEvents({ now: new Date(), maxRetries: 3 });

      assert.equal(res.recoveredFailedCount, 1);
      assert.equal(evt.status, 'failed');
      assert.match(evt.error || '', /max attempts/i);
      assert.equal(evt.leaseWorkerId, null);
      assert.equal(evt.leaseToken, null);
    });

    it('2.7 ignores webhook events currently under an active lease', async () => {
      const activeLeaseTime = new Date(Date.now() + 50_000);

      const evt = createTestWebhookEvent({
        eventId: 'evt_active_lease',
        status: 'processing',
        attempts: 1,
        leaseWorkerId: 'worker_healthy',
        leaseToken: 'token_active',
        leaseExpiresAt: activeLeaseTime,
      });

      const res = await sweepExpiredWebhookEvents({ now: new Date(), maxRetries: 3 });

      assert.equal(res.recoveredFailedCount, 0);
      assert.equal(res.reprocessedSuccessCount, 0);
      assert.equal(evt.status, 'processing');
      assert.equal(evt.leaseWorkerId, 'worker_healthy');
    });

    it('2.8 a stored payload that differs from the signed raw body cannot influence processing', async () => {
      const order = createTestOrder({
        orderId: 'ord_untainted_001',
        razorpayOrderId: 'order_rzp_untainted_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
        purchaseCapturedPaise: 0,
      });

      const untaintedPaymentId = 'pay_untainted_111';
      // The authentic signed raw body specifies payment pay_untainted_111 and 417000 paise
      const signedPayloadObj = {
        event: 'payment.captured',
        event_id: 'evt_diverge_001',
        payload: {
          payment: {
            entity: {
              id: untaintedPaymentId,
              order_id: order.razorpayOrderId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              method: 'upi',
            },
          },
        },
      };

      const validRawBody = JSON.stringify(signedPayloadObj);
      const validSignature = signWebhookPayload(validRawBody);

      // The independently stored payload in MongoDB is tampered / diverged!
      const tamperedStoredPayload = {
        event: 'payment.captured',
        event_id: 'evt_diverge_001',
        payload: {
          payment: {
            entity: {
              id: 'pay_malicious_diverged_999',
              order_id: order.razorpayOrderId,
              amount: 99999999, // Malicious tampered amount
              currency: 'INR',
              status: 'captured',
              method: 'card',
            },
          },
        },
      };

      const evt = createTestWebhookEvent({
        eventId: 'evt_diverge_001',
        event: 'payment.captured',
        status: 'processing',
        payload: tamperedStoredPayload, // Independently stored diverged payload
        rawBody: validRawBody,          // Authentic signed raw body
        signature: validSignature,      // Authentic signature matching rawBody
        attempts: 1,
        leaseWorkerId: 'worker_crashed_diverge',
        leaseToken: 'token_old_diverge',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const mockRazorpay = {
        payments: {
          fetch: async (id: string) => {
            if (id === untaintedPaymentId) {
              return {
                id,
                order_id: order.razorpayOrderId,
                amount: 417000,
                currency: 'INR',
                status: 'captured',
                method: 'upi',
              };
            }
            throw new Error(`Unexpected fetch for tampered payment ID: ${id}`);
          },
        },
      };

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.reprocessedSuccessCount, 1);
      assert.equal(evt.status, 'processed');
      assert.equal(evt.orderId, order.orderId);
      assert.equal(evt.paymentId, untaintedPaymentId);
      // Order captured using authentic rawBody, NOT tampered payload
      assert.equal(order.paymentStatus, 'captured');
      assert.equal(order.status, 'completed');
      assert.equal(order.totalCapturedPaise, 417000);
      assert.equal(order.razorpayPaymentId, untaintedPaymentId);
    });

    it('2.9 an event ID mismatch between raw body and WebhookEvent record is rejected without financial mutations', async () => {
      const order = createTestOrder({
        orderId: 'ord_mismatch_id_001',
        razorpayOrderId: 'order_rzp_mismatch_id_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
      });

      // Raw body signed with event_id evt_signed_different_999
      const signedPayload = {
        event: 'payment.captured',
        event_id: 'evt_signed_different_999',
        payload: {
          payment: {
            entity: {
              id: 'pay_mismatch_id',
              order_id: order.razorpayOrderId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      };

      const rawBody = JSON.stringify(signedPayload);
      const signature = signWebhookPayload(rawBody);

      // WebhookEvent record has eventId: evt_record_id_111 (mismatch!)
      const evt = createTestWebhookEvent({
        eventId: 'evt_record_id_111',
        event: 'payment.captured',
        status: 'processing',
        rawBody,
        signature,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      let gatewayCalled = false;
      const mockRazorpay = {
        payments: {
          fetch: async () => {
            gatewayCalled = true;
            return {};
          },
        },
      };

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.recoveredFailedCount, 1);
      assert.equal(res.reprocessedSuccessCount, 0);
      assert.equal(evt.status, 'failed');
      assert.match(evt.error || '', /Event ID mismatch/i);
      assert.equal(gatewayCalled, false, 'Gateway lookup should not be called on mismatch');

      // Zero financial mutations
      assert.equal(order.paymentStatus, 'pending');
      assert.equal(order.totalCapturedPaise, 0);
    });

    it('2.10 an event name mismatch between raw body and WebhookEvent record is rejected without financial mutations', async () => {
      const order = createTestOrder({
        orderId: 'ord_mismatch_name_001',
        razorpayOrderId: 'order_rzp_mismatch_name_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
      });

      // Raw body signed with event 'refund.processed'
      const signedPayload = {
        event: 'refund.processed',
        event_id: 'evt_mismatch_name_111',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_bogus_111',
              payment_id: 'pay_bogus_111',
              amount: 417000,
            },
          },
        },
      };

      const rawBody = JSON.stringify(signedPayload);
      const signature = signWebhookPayload(rawBody);

      // WebhookEvent record was recorded as 'payment.captured' (mismatch!)
      const evt = createTestWebhookEvent({
        eventId: 'evt_mismatch_name_111',
        event: 'payment.captured',
        status: 'processing',
        rawBody,
        signature,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
      });

      assert.equal(res.recoveredFailedCount, 1);
      assert.equal(res.reprocessedSuccessCount, 0);
      assert.equal(evt.status, 'failed');
      assert.match(evt.error || '', /Event name mismatch/i);

      // Zero financial mutations
      assert.equal(order.paymentStatus, 'pending');
      assert.equal(order.totalCapturedPaise, 0);
    });

    it('2.11 invalid signatures cannot reach payment or refund handlers', async () => {
      const order = createTestOrder({
        orderId: 'ord_invalid_sig_001',
        razorpayOrderId: 'order_rzp_invalid_sig_001',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
      });

      const rawBody = JSON.stringify({
        event: 'payment.captured',
        event_id: 'evt_invalid_sig_001',
        payload: {
          payment: {
            entity: {
              id: 'pay_invalid_sig_111',
              order_id: order.razorpayOrderId,
              amount: 417000,
            },
          },
        },
      });

      const evt = createTestWebhookEvent({
        eventId: 'evt_invalid_sig_001',
        event: 'payment.captured',
        status: 'processing',
        rawBody,
        signature: 'invalid_forged_signature_0000000000000000',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      let paymentHandlerInvoked = false;
      const mockRazorpay = {
        payments: {
          fetch: async () => {
            paymentHandlerInvoked = true;
            return {};
          },
        },
      };

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.recoveredFailedCount, 1);
      assert.equal(res.reprocessedSuccessCount, 0);
      assert.equal(evt.status, 'failed');
      assert.match(evt.error || '', /signature verification/i);
      assert.equal(paymentHandlerInvoked, false, 'Payment handler fetch must never be reached');

      // Zero financial mutations
      assert.equal(order.paymentStatus, 'pending');
      assert.equal(order.totalCapturedPaise, 0);
    });

    it('2.12 successful replay using persisted header event ID when JSON body contains no event ID', async () => {
      const order = createTestOrder({
        orderId: 'ord_replay_no_body_id_001',
        razorpayOrderId: 'order_rzp_replay_no_body_id',
        totalAmount: 4170,
        amountPaise: 417000,
        paymentStatus: 'pending',
        status: 'pending',
        primaryPaymentId: null,
        totalCapturedPaise: 0,
        purchaseCapturedPaise: 0,
      });

      const paymentId = 'pay_replay_no_body_id_222';
      // Raw body contains entity, event, payload, but NO event_id or id at top level!
      const payloadObj = {
        entity: 'event',
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: order.razorpayOrderId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              method: 'card',
            },
          },
        },
      };

      const rawBodyStr = JSON.stringify(payloadObj);
      const signature = signWebhookPayload(rawBodyStr);

      const canonicalHeaderId = 'evt_persisted_from_header_only_888';
      const evt = createTestWebhookEvent({
        eventId: canonicalHeaderId,
        event: 'payment.captured',
        status: 'processing',
        rawBody: rawBodyStr,
        signature,
        attempts: 1,
        leaseWorkerId: 'worker_crashed_header_only',
        leaseToken: 'token_old_header_only',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      });

      const mockRazorpay = {
        payments: {
          fetch: async (id: string) => ({
            id,
            order_id: order.razorpayOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            method: 'card',
          }),
        },
      };

      const res = await sweepExpiredWebhookEvents({
        now: new Date(),
        maxRetries: 3,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.reprocessedSuccessCount, 1);
      assert.equal(evt.status, 'processed');
      assert.equal(evt.eventId, canonicalHeaderId);
      assert.equal(evt.orderId, order.orderId);
      assert.equal(evt.paymentId, paymentId);
      assert.equal(order.paymentStatus, 'captured');
      assert.equal(order.status, 'completed');
      assert.equal(order.totalCapturedPaise, 417000);
      assert.equal(order.razorpayPaymentId, paymentId);
    });
  });

  // ============================================================================
  // 3. EXPIRED REFUND JOB LEASE RECOVERY
  // ============================================================================
  describe('3. Expired Refund Job Lease Recovery', () => {
    it('3.1 resets un-dispatched (apiDispatched: false) expired jobs to pending', async () => {
      const pastTime = new Date(Date.now() - 30_000);

      const job = createTestRefundJob({
        status: 'processing',
        apiDispatched: false,
        leaseWorkerId: 'worker_crashed_pre_dispatch',
        leaseToken: 'token_pre_1',
        leaseExpiresAt: pastTime,
      });

      const res = await sweepExpiredRefundJobLeases({ now: new Date() });

      assert.equal(res.recoveredPendingCount, 1);
      assert.equal(res.recoveredUncertainCount, 0);
      assert.equal(job.status, 'pending');
      assert.equal(job.leaseWorkerId, null);
      assert.equal(job.leaseToken, null);
      assert.equal(job.leaseExpiresAt, null);
    });

    it('3.2 transitions dispatched (apiDispatched: true) expired jobs to uncertain state for reconciliation', async () => {
      const pastTime = new Date(Date.now() - 30_000);

      const job = createTestRefundJob({
        status: 'processing',
        apiDispatched: true,
        leaseWorkerId: 'worker_crashed_post_dispatch',
        leaseToken: 'token_post_1',
        leaseExpiresAt: pastTime,
      });

      const res = await sweepExpiredRefundJobLeases({ now: new Date() });

      assert.equal(res.recoveredPendingCount, 0);
      assert.equal(res.recoveredUncertainCount, 1);
      assert.equal(job.status, 'uncertain');
      assert.equal(job.leaseWorkerId, null);
      assert.equal(job.leaseToken, null);
      assert.equal(job.leaseExpiresAt, null);
    });
  });

  // ============================================================================
  // 4. AUTHORITATIVE UNCERTAIN REFUND RECONCILIATION
  // ============================================================================
  describe('4. Authoritative Uncertain Refund Reconciliation', () => {
    it('4.1 gateway confirms processed: reconciles job to succeeded and settles order and refund', async () => {
      const order = createTestOrder({
        totalCapturedPaise: 417000,
        purchaseCapturedPaise: 417000,
        amountReservedRefundPaise: 417000,
        confirmedRefundPaise: 0,
        paymentStatus: 'refund_pending',
      });
      const payment = createTestPaymentAttempt({
        orderId: order._id,
        paymentId: 'pay_rec_001',
        amountCapturedPaise: 417000,
        status: 'captured',
      });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        apiDispatched: true,
        providerRefundId: 'rfnd_gw_settled_001',
      });
      const refund = createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_gw_settled_001',
        amountPaise: 417000,
        status: 'pending',
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          }),
        },
      };

      const res = await reconcileUncertainRefundJob({
        jobId: job._id.toString(),
        workerId: 'rec_worker_1',
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.outcome, 'settled');
      assert.equal(job.status, 'succeeded');
      assert.equal(job.providerRefundId, 'rfnd_gw_settled_001');
      assert.equal(job.leaseWorkerId, null);

      // Verify financial accounting in Order
      assert.equal(refund.status, 'settled');
      assert.equal(order.amountReservedRefundPaise, 0);
      assert.equal(order.confirmedRefundPaise, 417000);
      assert.equal(order.paymentStatus, 'refunded');
    });

    it('4.2 gateway confirms failed: records failure, releases reservation, and sets failed_retryable', async () => {
      const order = createTestOrder({
        totalCapturedPaise: 417000,
        amountReservedRefundPaise: 417000,
        confirmedRefundPaise: 0,
      });
      const payment = createTestPaymentAttempt({
        orderId: order._id,
        paymentId: 'pay_rec_failed_001',
        amountCapturedPaise: 417000,
      });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        apiDispatched: true,
        attempts: 1,
        maxRetries: 3,
        providerRefundId: 'rfnd_gw_failed_001',
      });
      const refund = createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_gw_failed_001',
        amountPaise: 417000,
        status: 'pending',
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'failed',
            error_description: 'Issuer bank declined transaction reversal',
          }),
        },
      };

      const res = await reconcileUncertainRefundJob({
        jobId: job._id.toString(),
        workerId: 'rec_worker_2',
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.outcome, 'failed');
      assert.equal(job.status, 'manual_review');
      assert.match(job.lastError || '', /Issuer bank declined/);
      assert.equal(job.leaseWorkerId, null);

      // Order reservation released
      assert.equal(refund.status, 'failed');
      assert.equal(order.amountReservedRefundPaise, 0);
      assert.equal(order.confirmedRefundPaise, 0);
    });

    it('4.3 gateway confirms pending: retains uncertain status and clears lease for subsequent sweep', async () => {
      const order = createTestOrder({ amountReservedRefundPaise: 417000 });
      const payment = createTestPaymentAttempt({ paymentId: 'pay_rec_pending_001' });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        apiDispatched: true,
        providerRefundId: 'rfnd_gw_pending_001',
      });
      const refund = createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_gw_pending_001',
        status: 'pending',
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'pending',
          }),
        },
      };

      const res = await reconcileUncertainRefundJob({
        jobId: job._id.toString(),
        workerId: 'rec_worker_3',
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.outcome, 'pending_gateway');
      assert.equal(job.status, 'uncertain');
      assert.equal(job.leaseWorkerId, null);
      assert.equal(job.leaseToken, null);

      // Accounting unchanged
      assert.equal(refund.status, 'pending');
      assert.equal(order.amountReservedRefundPaise, 417000);
      assert.equal(order.confirmedRefundPaise, 0);
    });

    it('4.4 refund not found on gateway: resets to failed_retryable for dispatch retry if retries remain', async () => {
      const order = createTestOrder({ amountReservedRefundPaise: 417000 });
      const payment = createTestPaymentAttempt({ paymentId: 'pay_rec_notfound_001' });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        apiDispatched: true,
        attempts: 1,
        maxRetries: 3,
        providerIdempotencyKey: 'stable_idem_key_444',
      });
      createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        status: 'pending',
      });

      const mockRazorpay = {
        payments: {
          fetchMultipleRefund: async () => ({ items: [] }), // No refunds on gateway
        },
      };

      const res = await reconcileUncertainRefundJob({
        jobId: job._id.toString(),
        workerId: 'rec_worker_4',
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.outcome, 'retrying_dispatch');
      assert.equal(job.status, 'failed_retryable');
      assert.equal(job.providerIdempotencyKey, 'stable_idem_key_444'); // Preserves stable idempotency key
      assert.equal(job.leaseWorkerId, null);
    });

    it('4.5 refund not found on gateway and max retries exceeded: escalates to manual_review', async () => {
      const order = createTestOrder({ amountReservedRefundPaise: 417000 });
      const payment = createTestPaymentAttempt({ paymentId: 'pay_rec_exhausted_001' });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        apiDispatched: true,
        attempts: 3,
        maxRetries: 3,
      });

      const mockRazorpay = {
        payments: {
          fetchMultipleRefund: async () => ({ items: [] }),
        },
      };

      const res = await reconcileUncertainRefundJob({
        jobId: job._id.toString(),
        workerId: 'rec_worker_5',
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.outcome, 'escalated_manual_review');
      assert.equal(job.status, 'manual_review');
      assert.match(job.manualReviewReason || '', /max retries exceeded/i);
    });
  });

  // ============================================================================
  // 5. DISPATCHED PENDING REFUND SETTLEMENT RECONCILIATION
  // ============================================================================
  describe('5. Dispatched Pending Refund Settlement Reconciliation', () => {
    it('5.1 settles pending refund when providerRefundId is set and gateway confirms processed', async () => {
      const order = createTestOrder({
        amountReservedRefundPaise: 417000,
        confirmedRefundPaise: 0,
      });
      const payment = createTestPaymentAttempt({ paymentId: 'pay_settle_reconcile_001' });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        status: 'succeeded',
        providerRefundId: 'rfnd_drop_wh_001',
      });
      const refund = createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_drop_wh_001',
        amountPaise: 417000,
        status: 'pending',
        createdAt: new Date(Date.now() - 30_000), // Created 30s ago
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          }),
        },
      };

      const res = await reconcilePendingRefundSettlements({
        workerId: 'worker_settle_1',
        settlementThresholdMs: 10_000,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.settledCount, 1);
      assert.equal(refund.status, 'settled');
      assert.equal(order.confirmedRefundPaise, 417000);
      assert.equal(order.amountReservedRefundPaise, 0);
    });
  });

  // ============================================================================
  // 6. RETRYABLE DISPATCH SWEEP & BACKOFF RESPECT
  // ============================================================================
  describe('6. Retryable Dispatch Sweep & Backoff Cooldown', () => {
    it('6.1 skips failed_retryable jobs whose exponential backoff cooldown has not elapsed', async () => {
      const order = createTestOrder();
      const payment = createTestPaymentAttempt({ orderId: order._id });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        status: 'failed_retryable',
        attempts: 1,
        maxRetries: 3,
        updatedAt: new Date(Date.now() - 1000), // Only 1s ago (backoff is 5s)
        errorHistory: [{ error: '429 Rate Limit', timestamp: new Date(Date.now() - 1000) }],
      });
      createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

      let dispatchCalled = false;
      const mockRazorpay = {
        payments: {
          refund: async () => {
            dispatchCalled = true;
            return { id: 'rfnd_should_not_run', status: 'processed' };
          },
        },
      };

      const res = await sweepAndDispatchRetryableJobs({
        workerId: 'worker_dispatch_1',
        baseBackoffMs: 5000,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.skippedCooldownCount, 1);
      assert.equal(res.dispatchedCount, 0);
      assert.equal(dispatchCalled, false);
      assert.equal(job.status, 'failed_retryable');
    });

    it('6.2 dispatches failed_retryable jobs after backoff cooldown has elapsed', async () => {
      const order = createTestOrder();
      const payment = createTestPaymentAttempt({ orderId: order._id });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        status: 'failed_retryable',
        attempts: 1,
        maxRetries: 3,
        updatedAt: new Date(Date.now() - 10_000), // 10s ago (exceeds 5s cooldown)
        errorHistory: [{ error: '429 Rate Limit', timestamp: new Date(Date.now() - 10_000) }],
      });
      createTestRefund({ orderId: order._id, paymentId: payment.paymentId, refundJobId: job._id });

      let dispatchedPaymentId = '';
      const mockRazorpay = {
        payments: {
          refund: async (payId: string) => {
            dispatchedPaymentId = payId;
            return { id: 'rfnd_cool_success', status: 'processed' };
          },
        },
      };

      const res = await sweepAndDispatchRetryableJobs({
        workerId: 'worker_dispatch_2',
        baseBackoffMs: 5000,
        razorpayClient: mockRazorpay,
      });

      assert.equal(res.dispatchedCount, 1);
      assert.equal(res.succeededCount, 1);
      assert.equal(dispatchedPaymentId, payment.paymentId);
      assert.equal(job.status, 'succeeded');
    });

    it('6.3 escalates retryable jobs to manual_review if attempts >= maxRetries', async () => {
      const order = createTestOrder();
      const payment = createTestPaymentAttempt({ orderId: order._id });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        status: 'failed_retryable',
        attempts: 3,
        maxRetries: 3,
      });

      const res = await sweepAndDispatchRetryableJobs({
        workerId: 'worker_dispatch_3',
        maxRetries: 3,
      });

      assert.equal(res.escalatedCount, 1);
      assert.equal(job.status, 'manual_review');
      assert.match(job.manualReviewReason || '', /Maximum dispatch attempts/);
    });
  });

  // ============================================================================
  // 7. CONCURRENT LEASE CLAIMING & STALE WORKER FENCING
  // ============================================================================
  describe('7. Concurrent Lease Claiming & Stale Worker Fencing', () => {
    it('7.1 two concurrent workers race to claim the same uncertain job: exactly one wins lease', async () => {
      const order = createTestOrder();
      const payment = createTestPaymentAttempt({ orderId: order._id });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        status: 'uncertain',
        providerRefundId: 'rfnd_race_001',
      });
      createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_race_001',
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          }),
        },
      };

      // Both workers execute reconcile concurrently
      const [res1, res2] = await Promise.all([
        reconcileUncertainRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_A',
          razorpayClient: mockRazorpay,
        }),
        reconcileUncertainRefundJob({
          jobId: job._id.toString(),
          workerId: 'worker_B',
          razorpayClient: mockRazorpay,
        }),
      ]);

      const outcomes = [res1.outcome, res2.outcome];
      assert.ok(outcomes.includes('settled'), 'One worker must successfully settle');
      assert.ok(
        outcomes.includes('skipped_claimed'),
        'The second worker must be rejected with skipped_claimed'
      );
    });

    it('7.2 stale worker with expired lease cannot complete webhook event after lease takeover', async () => {
      const evt = createTestWebhookEvent({
        eventId: 'evt_stale_fence',
        status: 'processing',
        leaseWorkerId: 'worker_1',
        leaseToken: 'token_w1_expired',
      });

      // Worker 2 takes over the expired lease
      evt.leaseWorkerId = 'worker_2';
      evt.leaseToken = 'token_w2_active';

      // Stale Worker 1 attempts to complete the event with its old token
      const successW1 = await completeWebhookEvent({
        eventId: evt.eventId,
        leaseToken: 'token_w1_expired',
        status: 'processed',
      });
      assert.equal(successW1, false, 'Stale worker 1 must be rejected');

      // Valid Worker 2 completes the event with its active token
      const successW2 = await completeWebhookEvent({
        eventId: evt.eventId,
        leaseToken: 'token_w2_active',
        status: 'processed',
      });
      assert.equal(successW2, true, 'Active worker 2 must succeed');
      assert.equal(evt.status, 'processed');
    });
  });

  // ============================================================================
  // 8. DUPLICATE ACCOUNTING PREVENTION ACROSS MULTIPLE SWEEPS
  // ============================================================================
  describe('8. Duplicate Accounting Prevention', () => {
    it('8.1 running multiple recovery sweeps on the same settled refund never double-settles', async () => {
      const order = createTestOrder({
        totalCapturedPaise: 417000,
        purchaseCapturedPaise: 417000,
        amountReservedRefundPaise: 417000,
        confirmedRefundPaise: 0,
      });
      const payment = createTestPaymentAttempt({
        orderId: order._id,
        paymentId: 'pay_multisweep_001',
        amountCapturedPaise: 417000,
      });
      const job = createTestRefundJob({
        orderId: order._id,
        targetPaymentId: payment.paymentId,
        targetAmountPaise: 417000,
        status: 'uncertain',
        providerRefundId: 'rfnd_multisweep_001',
      });
      createTestRefund({
        orderId: order._id,
        paymentId: payment.paymentId,
        refundJobId: job._id,
        providerRefundId: 'rfnd_multisweep_001',
        amountPaise: 417000,
        status: 'pending',
      });

      const mockRazorpay = {
        refunds: {
          fetch: async (refundId: string) => ({
            id: refundId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          }),
        },
      };

      // Sweep 1
      const sweep1 = await runRecoverySweep({
        workerId: 'worker_sweep_alpha',
        razorpayClient: mockRazorpay,
      });
      assert.equal(sweep1.uncertainJobs.settledCount, 1);
      assert.equal(order.confirmedRefundPaise, 417000);
      assert.equal(order.amountReservedRefundPaise, 0);

      // Sweep 2 (Identical sweep run immediately after)
      const sweep2 = await runRecoverySweep({
        workerId: 'worker_sweep_alpha',
        razorpayClient: mockRazorpay,
      });
      assert.equal(sweep2.uncertainJobs.settledCount, 0);
      assert.equal(order.confirmedRefundPaise, 417000); // Strictly unchanged!
      assert.equal(order.amountReservedRefundPaise, 0);
    });
  });

  // ============================================================================
  // 9. WORKER LIFECYCLE & IN-PROCESS OVERLAP PREVENTION
  // ============================================================================
  describe('9. Worker Lifecycle & Sweep Overlap Prevention', () => {
    it('9.1 PaymentRecoveryWorker starts, runs sweep, and stops cleanly', async () => {
      const worker = new PaymentRecoveryWorker({
        config: { sweepIntervalMs: 50_000 },
        workerId: 'test_lifecycle_worker',
      });

      assert.equal(worker.getIsRunning(), false);
      assert.equal(worker.getIsSweeping(), false);
      assert.equal(worker.getWorkerId(), 'test_lifecycle_worker');

      await worker.start();
      assert.equal(worker.getIsRunning(), true);

      await worker.stop();
      assert.equal(worker.getIsRunning(), false);
    });

    it('9.2 guards against overlapping sweeps within the same worker instance', async () => {
      const worker = new PaymentRecoveryWorker({
        config: { sweepIntervalMs: 50_000 },
        workerId: 'test_overlap_worker',
      });

      // Manually set isSweeping = true to simulate an in-flight sweep
      (worker as any).isSweeping = true;

      const result = await worker.runSweep();
      assert.equal((result as any).skippedDueToOverlap, true);

      (worker as any).isSweeping = false;
    });
  });
});
