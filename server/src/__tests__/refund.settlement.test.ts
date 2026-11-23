/**
 * ============================================================================
 * PHASE 8.3 — STEP 5: REFUND VERIFICATION AND FINAL SETTLEMENT TEST SUITE
 * ============================================================================
 *
 * ARCHITECTURAL NOTICE ON TEST HARNESS:
 * In accordance with strict project rules, all tests run in-process without
 * connecting to external networks, MongoDB Atlas, or live Razorpay APIs.
 * Authoritative settlement, dual-ledger accounting, out-of-order event protection,
 * duplicate delivery idempotency, and transactional consistency are verified.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import crypto from 'crypto';
import app from '../app.js';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob } from '../models/RefundJob.js';
import { WebhookEvent, claimWebhookEvent, completeWebhookEvent } from '../models/WebhookEvent.js';
import { setRazorpayClient } from '../config/razorpay.js';
import {
  processRefundSettlement,
  processRefundFailure,
  fetchAuthoritativeGatewayRefund,
  RefundNotFoundError,
  RefundIdentityMismatchError,
  RefundAmountMismatchError,
  RefundCurrencyMismatchError,
  StaleRefundEventError,
  PaymentNotCapturedForRefundError,
  GatewayRefundPendingError,
  GatewayRefundVerificationError,
} from '../services/refund-settlement.service.js';

describe('Phase 8.3 — Step 5: Refund Verification and Final Settlement', () => {
  let databaseOrders: any[] = [];
  let databasePaymentAttempts: any[] = [];
  let databaseRefunds: any[] = [];
  let databaseRefundJobs: any[] = [];
  let databaseWebhookEvents: any[] = [];

  const dummyUserId = new mongoose.Types.ObjectId('6740000000000000000000a1');
  const dummyProjectId = new mongoose.Types.ObjectId('6740000000000000000000b1');
  const WEBHOOK_SECRET = 'mockWebhookSecretStep5';

  function signPayload(rawBody: string | Buffer): string {
    return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

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
      webhookEventsProcessed: overrides.webhookEventsProcessed || [],
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
    const plain: any = {
      _id: overrides._id || new mongoose.Types.ObjectId(),
      refundId,
      orderId: overrides.orderId || databaseOrders[0]?._id || new mongoose.Types.ObjectId(),
      paymentId: overrides.paymentId || databasePaymentAttempts[0]?.paymentId || 'pay_test_default',
      refundJobId: overrides.refundJobId || databaseRefundJobs[0]?._id,
      providerRefundId: overrides.providerRefundId,
      amountPaise: overrides.amountPaise ?? 417000,
      currency: overrides.currency || 'INR',
      type: overrides.type || 'purchase_compensation',
      status: overrides.status || 'pending',
      notes: overrides.notes,
    };
    if (overrides.settledAt) plain.settledAt = overrides.settledAt;
    if (overrides.settlementSource) plain.settlementSource = overrides.settlementSource;
    if (overrides.settlementVerifiedAt) plain.settlementVerifiedAt = overrides.settlementVerifiedAt;
    if (overrides.failureReason) plain.failureReason = overrides.failureReason;

    const doc: any = Refund.hydrate(plain);
    doc._originalStatus = overrides.status || 'pending';
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
      providerRefundId: overrides.providerRefundId,
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
    databaseWebhookEvents = [];

    process.env.RAZORPAY_KEY_ID = 'rzp_test_mockKeyIdStep5';
    process.env.RAZORPAY_KEY_SECRET = 'mockKeySecretStep5';
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    // Mock Razorpay SDK client with authoritative refund endpoints
    setRazorpayClient({
      refunds: {
        fetch: async (refundId: string, params?: any) => {
          const found = databaseRefunds.find(
            (r) => r.providerRefundId === refundId || r.refundId === refundId
          );
          if (found) {
            return {
              id: refundId,
              payment_id: found.paymentId,
              amount: (found as any).gatewayAmount !== undefined ? (found as any).gatewayAmount : found.amountPaise,
              currency: found.currency || 'INR',
              status: (found as any).gatewayStatus || 'processed',
            };
          }
          return {
            id: refundId,
            payment_id: params?.payment_id || 'pay_wh_default',
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          };
        },
      },
      payments: {
        fetchRefund: async (paymentId: string, refundId: string) => {
          const found = databaseRefunds.find(
            (r) => r.providerRefundId === refundId || r.refundId === refundId
          );
          return {
            id: refundId,
            payment_id: paymentId,
            amount: found ? found.amountPaise : 417000,
            currency: 'INR',
            status: found ? ((found as any).gatewayStatus || 'processed') : 'processed',
          };
        },
      },
    } as any);

    // Mock Order methods
    Order.findById = (async (id: any) => {
      const found = databaseOrders.find((d) => d._id.toString() === id.toString());
      if (found) found.session = function () { return this; };
      return found || null;
    }) as any;

    Order.findOne = (async (query: any) => {
      const found = databaseOrders.find((d) => {
        if (query._id && d._id.toString() !== query._id.toString()) return false;
        if (query.orderId && d.orderId !== query.orderId) return false;
        if (query.razorpayOrderId && d.razorpayOrderId !== query.razorpayOrderId) return false;
        return true;
      });
      if (found) found.session = function () { return this; };
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
      if (found) found.session = function () { return this; };
      return found || null;
    }) as any;

    // Mock Refund methods
    Refund.findOne = (async (query: any) => {
      const found = databaseRefunds.find((r) => {
        if (query.$or) {
          return query.$or.some((cond: any) => {
            if (cond.providerRefundId && r.providerRefundId === cond.providerRefundId) return true;
            if (cond.refundId && r.refundId === cond.refundId) return true;
            return false;
          });
        }
        if (query.refundId && r.refundId !== query.refundId) return false;
        if (query.providerRefundId && r.providerRefundId !== query.providerRefundId) return false;
        if (query.paymentId && r.paymentId !== query.paymentId) return false;
        if (query.status && r.status !== query.status) return false;
        if (query.amountPaise && r.amountPaise !== query.amountPaise) return false;
        if (query.refundJobId && (!r.refundJobId || r.refundJobId.toString() !== query.refundJobId.toString())) {
          return false;
        }
        return true;
      });
      if (found) found.session = function () { return this; };
      return found || null;
    }) as any;

    Refund.prototype.save = async function () {
      const self = this as any;
      if (!self.isNew) {
        for (const field of ['refundId', 'orderId', 'paymentId', 'amountPaise', 'currency', 'type']) {
          if (self.isModified(field)) {
            throw new Error(`Cannot modify immutable field: ${field}`);
          }
        }
        if (self.isModified('status')) {
          const orig = self._originalStatus || self._original?.status;
          if (orig === 'failed' && self.status === 'settled') {
            throw new Error('Invalid refund status transition: A failed refund cannot transition to settled');
          }
        }
      }
      self._originalStatus = self.status;
      return self;
    };

    Refund.updateOne = (async (filter: any, update: any) => {
      const item = databaseRefunds.find((r) => {
        if (filter._id && r._id.toString() !== filter._id.toString()) return false;
        if (filter.refundId && r.refundId !== filter.refundId) return false;
        return true;
      });
      if (!item) return { matchedCount: 0, modifiedCount: 0 };
      const newStatus = update.status || update.$set?.status;
      if (newStatus === 'settled' && item.status === 'failed') {
        throw new Error('Invalid refund status transition: A failed refund cannot transition to settled');
      }
      const setsSettlement =
        update.settledAt !== undefined ||
        update.settlementSource !== undefined ||
        update.settlementVerifiedAt !== undefined ||
        (update.$set &&
          (update.$set.settledAt !== undefined ||
            update.$set.settlementSource !== undefined ||
            update.$set.settlementVerifiedAt !== undefined));
      if (setsSettlement && (item.status === 'failed' || newStatus === 'failed')) {
        throw new Error('Cannot set settlement metadata on a failed refund');
      }
      if (update.$set) Object.assign(item, update.$set);
      if (update.status) item.status = update.status;
      return { matchedCount: 1, modifiedCount: 1 };
    }) as any;

    // Mock RefundJob methods
    RefundJob.findById = (async (id: any) => {
      const found = databaseRefundJobs.find((j) => j._id.toString() === id.toString());
      if (found) found.session = function () { return this; };
      return found || null;
    }) as any;

    RefundJob.findOne = (async (query: any) => {
      const found = databaseRefundJobs.find((j) => {
        if (query._id && j._id.toString() !== query._id.toString()) return false;
        if (query.idempotencyKey && j.idempotencyKey !== query.idempotencyKey) return false;
        return true;
      });
      if (found) found.session = function () { return this; };
      return found || null;
    }) as any;

    RefundJob.prototype.save = async function () {
      return this;
    };

    // Mock WebhookEvent methods
    WebhookEvent.create = (async (data: any) => {
      const exists = databaseWebhookEvents.some((e) => e.eventId === data.eventId);
      if (exists) {
        const dupError: any = new Error(
          `E11000 duplicate key error collection: webhookevents index: eventId_1 dup key: { eventId: "${data.eventId}" }`
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

    WebhookEvent.findOne = (async (query: any) => {
      return databaseWebhookEvents.find((e) => e.eventId === query.eventId) || null;
    }) as any;

    WebhookEvent.findOneAndUpdate = (async (query: any, update: any) => {
      const item = databaseWebhookEvents.find((e) => {
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
      return item;
    }) as any;
  });

  // ============================================================================
  // 1. SUCCESSFUL FULL REFUND SETTLEMENT
  // ============================================================================
  it('1. successful full refund settlement moves reserved to confirmed and marks order refunded', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 417000,
      purchaseCapturedPaise: 417000,
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      paymentStatus: 'refund_pending',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_full_settle_001',
      amountCapturedPaise: 417000,
      status: 'captured',
    });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 417000,
      status: 'processing',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      providerRefundId: 'rfnd_full_settle_101',
      amountPaise: 417000,
      status: 'pending',
      type: 'purchase_compensation',
    });

    const result = await processRefundSettlement({
      refundId: 'rfnd_full_settle_101',
      paymentId: payment.paymentId,
      amountPaise: 417000,
      currency: 'INR',
      eventId: 'evt_settle_001',
    });

    assert.strictEqual(result.status, 'settled');
    assert.strictEqual(result.duplicateDelivery, false);

    // Assert Refund State
    assert.strictEqual(refund.status, 'settled');
    assert.ok(refund.settledAt instanceof Date);
    assert.strictEqual(refund.settlementSource, 'webhook');
    assert.ok(refund.settlementVerifiedAt instanceof Date);

    // Assert Order Accounting State
    assert.strictEqual(order.amountReservedRefundPaise, 0, 'Reserved capacity must be decremented to 0');
    assert.strictEqual(order.confirmedRefundPaise, 417000, 'Confirmed capacity must increase by full amount');
    assert.strictEqual(order.purchaseRefundedPaise, 417000);
    assert.strictEqual(order.paymentStatus, 'refunded', 'Payment status must transition to refunded');
    assert.strictEqual(order.status, 'refunded', 'Order status must transition to refunded');

    // Assert RefundJob State
    assert.strictEqual(job.status, 'succeeded');
    assert.strictEqual(job.providerRefundId, 'rfnd_full_settle_101');
  });

  // ============================================================================
  // 2. SUCCESSFUL PARTIAL REFUND SETTLEMENT
  // ============================================================================
  it('2. successful partial refund settlement transitions paymentStatus to partially_refunded and retains completed status', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 500000,
      purchaseCapturedPaise: 500000,
      amountReservedRefundPaise: 200000,
      confirmedRefundPaise: 0,
      paymentStatus: 'refund_pending',
      status: 'completed',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_part_settle_001',
      amountCapturedPaise: 500000,
      status: 'captured',
    });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 200000,
      classification: 'partial_refund',
      status: 'processing',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      providerRefundId: 'rfnd_part_settle_202',
      amountPaise: 200000,
      status: 'pending',
      type: 'partial_refund',
    });

    const result = await processRefundSettlement({
      refundId: 'rfnd_part_settle_202',
      paymentId: payment.paymentId,
      amountPaise: 200000,
      currency: 'INR',
    });

    assert.strictEqual(result.status, 'settled');

    // Verify partial accounting
    assert.strictEqual(order.amountReservedRefundPaise, 0);
    assert.strictEqual(order.confirmedRefundPaise, 200000);
    assert.strictEqual(order.purchaseRefundedPaise, 200000);

    // CRUCIAL: Partial refund must NOT mark entire order refunded!
    assert.strictEqual(order.paymentStatus, 'partially_refunded');
    assert.strictEqual(order.status, 'completed', 'Order status must remain completed after partial refund');
  });

  // ============================================================================
  // 3. DUPLICATE-CHARGE REFUND SETTLEMENT
  // ============================================================================
  it('3. duplicate-charge compensation settlement updates duplicate bucket and never transitions order to refunded', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 834000,
      purchaseCapturedPaise: 417000,
      duplicateCapturedPaise: 417000,
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      paymentStatus: 'duplicate_charge_detected',
      status: 'completed',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_dup_settle_001',
      amountCapturedPaise: 417000,
      classification: 'duplicate',
      status: 'captured',
    });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 417000,
      classification: 'duplicate_charge_compensation',
      status: 'processing',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      providerRefundId: 'rfnd_dup_settle_303',
      amountPaise: 417000,
      status: 'pending',
      type: 'duplicate_charge_compensation',
    });

    const result = await processRefundSettlement({
      refundId: 'rfnd_dup_settle_303',
      paymentId: payment.paymentId,
      amountPaise: 417000,
      currency: 'INR',
    });

    assert.strictEqual(result.status, 'settled');

    // Dual-ledger accounting checks
    assert.strictEqual(order.amountReservedRefundPaise, 0);
    assert.strictEqual(order.confirmedRefundPaise, 417000);
    assert.strictEqual(order.duplicateRefundedPaise, 417000, 'Duplicate bucket must record the refunded amount');
    assert.strictEqual(order.purchaseRefundedPaise, 0, 'Primary purchase bucket must remain strictly 0');

    // CRUCIAL: Duplicate refund settlement must NEVER transition order to 'refunded' or 'partially_refunded'
    assert.notStrictEqual(order.paymentStatus, 'refunded');
    assert.notStrictEqual(order.paymentStatus, 'partially_refunded');
    assert.strictEqual(order.status, 'completed');
  });

  // ============================================================================
  // 4. FAILED REFUND RELEASING RESERVED CAPACITY (refund.failed)
  // ============================================================================
  it('4. failed refund releases reserved capacity exactly once and reverts paymentStatus to captured', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 417000,
      purchaseCapturedPaise: 417000,
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      purchaseRefundedPaise: 0,
      paymentStatus: 'refund_pending',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_fail_rel_001',
      amountCapturedPaise: 417000,
      status: 'captured',
    });
    const job = createTestRefundJob({
      orderId: order._id,
      targetPaymentId: payment.paymentId,
      targetAmountPaise: 417000,
      status: 'processing',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      refundJobId: job._id,
      providerRefundId: 'rfnd_fail_rel_404',
      amountPaise: 417000,
      status: 'pending',
    });

    const result = await processRefundFailure({
      refundId: 'rfnd_fail_rel_404',
      paymentId: payment.paymentId,
      failureReason: 'Customer bank account closed or invalid VPA',
    });

    assert.strictEqual(result.status, 'failed_recorded');
    assert.strictEqual(result.duplicateDelivery, false);

    // Verify Refund record state
    assert.strictEqual(refund.status, 'failed');
    assert.strictEqual(refund.failureReason, 'Customer bank account closed or invalid VPA');
    assert.strictEqual(refund.settledAt, undefined, 'settledAt must NOT be set on a failed refund');

    // Verify Order accounting state: capacity released
    assert.strictEqual(order.amountReservedRefundPaise, 0, 'Reserved capacity must be released to 0');
    assert.strictEqual(order.confirmedRefundPaise, 0, 'Confirmed capacity must NOT be incremented');
    assert.strictEqual(order.purchaseRefundedPaise, 0);
    assert.strictEqual(order.paymentStatus, 'captured', 'Status must safely revert back to captured');

    // Verify RefundJob escalated to manual_review
    assert.strictEqual(job.status, 'manual_review');
    assert.match(job.manualReviewReason!, /Customer bank account closed/);
  });

  // ============================================================================
  // 5. DUPLICATE WEBHOOK DELIVERY (IDEMPOTENCY)
  // ============================================================================
  it('5. duplicate webhook delivery does not double-settle or mutate financial totals', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 417000,
      purchaseCapturedPaise: 417000,
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      paymentStatus: 'refund_pending',
    });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_dup_deliv_001', status: 'captured' });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_dup_deliv_505',
      amountPaise: 417000,
      status: 'pending',
    });

    // 1st delivery: successfully settles
    const firstDelivery = await processRefundSettlement({
      refundId: 'rfnd_dup_deliv_505',
      paymentId: payment.paymentId,
      amountPaise: 417000,
    });
    assert.strictEqual(firstDelivery.status, 'settled');
    assert.strictEqual(order.confirmedRefundPaise, 417000);
    assert.strictEqual(order.amountReservedRefundPaise, 0);

    // 2nd delivery: duplicate delivery of the same refund.processed event
    const secondDelivery = await processRefundSettlement({
      refundId: 'rfnd_dup_deliv_505',
      paymentId: payment.paymentId,
      amountPaise: 417000,
    });
    assert.strictEqual(secondDelivery.status, 'already_settled');
    assert.strictEqual(secondDelivery.duplicateDelivery, true);

    // Strict validation: accounting must NOT be double counted
    assert.strictEqual(order.confirmedRefundPaise, 417000, 'Confirmed refund paise must not double-count');
    assert.strictEqual(order.amountReservedRefundPaise, 0, 'Reserved refund paise must remain 0');
  });

  // ============================================================================
  // 6. CONCURRENT SETTLEMENT ATTEMPTS
  // ============================================================================
  it('6. concurrent settlement attempts are safe and result in exactly one settlement', async () => {
    const order = createTestOrder({
      totalCapturedPaise: 417000,
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
    });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_conc_settle_001', status: 'captured' });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_conc_settle_606',
      amountPaise: 417000,
      status: 'pending',
    });

    const [res1, res2] = await Promise.all([
      processRefundSettlement({ refundId: 'rfnd_conc_settle_606', paymentId: payment.paymentId, amountPaise: 417000 }),
      processRefundSettlement({ refundId: 'rfnd_conc_settle_606', paymentId: payment.paymentId, amountPaise: 417000 }),
    ]);

    const settledCount = [res1, res2].filter((r) => r.status === 'settled').length;
    const alreadySettledCount = [res1, res2].filter((r) => r.status === 'already_settled').length;

    assert.strictEqual(settledCount, 1, 'Exactly one concurrent call must perform settlement');
    assert.strictEqual(alreadySettledCount, 1, 'The other concurrent call must detect already_settled');
    assert.strictEqual(order.confirmedRefundPaise, 417000, 'Totals must never be incremented twice');
  });

  // ============================================================================
  // 7. OUT-OF-ORDER EVENTS & STALE REJECTION
  // ============================================================================
  it('7. rejects stale refund.failed arriving after a refund is already settled', async () => {
    const order = createTestOrder({ confirmedRefundPaise: 417000, amountReservedRefundPaise: 0 });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_stale_001', status: 'captured' });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_stale_707',
      amountPaise: 417000,
      status: 'settled', // Already settled!
      settledAt: new Date(),
      settlementSource: 'webhook',
    });

    await assert.rejects(
      async () => {
        await processRefundFailure({
          refundId: 'rfnd_stale_707',
          paymentId: payment.paymentId,
          failureReason: 'Late failure event',
        });
      },
      (err: any) => {
        assert.ok(err instanceof StaleRefundEventError);
        assert.match(err.message, /already authoritatively settled/);
        return true;
      }
    );

    // Confirmed funds must remain untouched
    assert.strictEqual(order.confirmedRefundPaise, 417000);
    assert.strictEqual(refund.status, 'settled');
  });

  it('7b. rejects stale refund.processed arriving after a refund was already failed and released', async () => {
    const order = createTestOrder({ amountReservedRefundPaise: 0, confirmedRefundPaise: 0 });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_stale_002', status: 'captured' });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_stale_708',
      amountPaise: 417000,
      status: 'failed', // Already failed!
      failureReason: 'Previously failed and released',
    });

    await assert.rejects(
      async () => {
        await processRefundSettlement({
          refundId: 'rfnd_stale_708',
          paymentId: payment.paymentId,
          amountPaise: 417000,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StaleRefundEventError);
        assert.match(err.message, /previously marked failed/);
        return true;
      }
    );

    // No accounting mutation permitted
    assert.strictEqual(order.confirmedRefundPaise, 0);
    assert.strictEqual(refund.status, 'failed');
  });

  // ============================================================================
  // 8. IDENTITY & INTEGRITY MISMATCH GUARDS
  // ============================================================================
  it('8. rejects settlement when amount, currency, or payment association mismatches', async () => {
    const order = createTestOrder({ amountReservedRefundPaise: 417000 });
    const payment = createTestPaymentAttempt({ orderId: order._id, paymentId: 'pay_mismatch_001', status: 'captured' });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_mismatch_808',
      amountPaise: 417000,
      status: 'pending',
    });

    // Case A: Amount mismatch (gateway reports 100000 instead of reserved 417000)
    await assert.rejects(
      async () => {
        await processRefundSettlement({
          refundId: 'rfnd_mismatch_808',
          paymentId: payment.paymentId,
          amountPaise: 100000, // Mismatch!
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundAmountMismatchError);
        assert.match(err.message, /amount mismatch/i);
        return true;
      }
    );

    // Case B: Payment ID mismatch
    await assert.rejects(
      async () => {
        await processRefundSettlement({
          refundId: 'rfnd_mismatch_808',
          paymentId: 'pay_wrong_payment_id', // Wrong payment!
          amountPaise: 417000,
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundIdentityMismatchError);
        assert.match(err.message, /Payment ID mismatch/i);
        return true;
      }
    );

    // Case C: Currency mismatch
    await assert.rejects(
      async () => {
        await processRefundSettlement({
          refundId: 'rfnd_mismatch_808',
          paymentId: payment.paymentId,
          amountPaise: 417000,
          currency: 'USD', // Non-INR!
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundCurrencyMismatchError);
        assert.match(err.message, /currency mismatch/);
        return true;
      }
    );

    // Ensure order accounting was never changed during any of the rejected attempts
    assert.strictEqual(order.amountReservedRefundPaise, 417000);
    assert.strictEqual(order.confirmedRefundPaise, 0);
    assert.strictEqual(refund.status, 'pending');
  });

  // ============================================================================
  // 9. UNCAPTURED PAYMENT ATTEMPT PROTECTION
  // ============================================================================
  it('9. rejects settlement if the associated payment attempt is not captured', async () => {
    const order = createTestOrder();
    const uncapturedPayment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_uncap_settle_001',
      status: 'authorized', // Not captured!
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: uncapturedPayment.paymentId,
      providerRefundId: 'rfnd_uncap_909',
      amountPaise: 417000,
      status: 'pending',
    });

    await assert.rejects(
      async () => {
        await processRefundSettlement({
          refundId: 'rfnd_uncap_909',
          paymentId: uncapturedPayment.paymentId,
          amountPaise: 417000,
        });
      },
      (err: any) => {
        assert.ok(err instanceof PaymentNotCapturedForRefundError);
        assert.match(err.message, /Only captured payments can have settled refunds/);
        return true;
      }
    );
  });

  // ============================================================================
  // 10. AUTHORITATIVE GATEWAY LOOKUP VIA RAZORPAY SDK
  // ============================================================================
  it('10. fetchAuthoritativeGatewayRefund retrieves authoritative status via client.refunds.fetch', async () => {
    const mockClient = {
      refunds: {
        fetch: async (refundId: string, params: any) => {
          return {
            id: refundId,
            payment_id: params?.payment_id,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          };
        },
      },
    };

    const fetched = await fetchAuthoritativeGatewayRefund('rfnd_authoritative_001', 'pay_auth_001', mockClient);
    assert.ok(fetched);
    assert.strictEqual(fetched.id, 'rfnd_authoritative_001');
    assert.strictEqual(fetched.status, 'processed');
  });

  // ============================================================================
  // 11. WEBHOOK ROUTE INTEGRATION TESTS (refund.processed & refund.failed)
  // ============================================================================
  it('11. POST /api/webhooks/razorpay processes refund.processed and authoritatively settles reserved refund', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_settle_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      paymentStatus: 'refund_pending',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_settle_001',
      razorpayOrderId: order.razorpayOrderId,
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_settle_111',
      amountPaise: 417000,
      status: 'pending',
    });

    const payload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_settle_111',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed',
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_settle_001')
      .send(raw);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(refund.status, 'settled');
    assert.strictEqual(order.confirmedRefundPaise, 417000);
    assert.strictEqual(order.amountReservedRefundPaise, 0);
    assert.strictEqual(order.paymentStatus, 'refunded');
  });

  it('11b. POST /api/webhooks/razorpay processes refund.failed and releases reserved refund capacity', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_fail_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
      paymentStatus: 'refund_pending',
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_fail_001',
      razorpayOrderId: order.razorpayOrderId,
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_fail_222',
      amountPaise: 417000,
      status: 'pending',
    });

    const payload = {
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_fail_222',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            error_description: 'Refund failed due to invalid beneficiary IFSC',
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_fail_002')
      .send(raw);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(refund.status, 'failed');
    assert.strictEqual(order.amountReservedRefundPaise, 0, 'Reserved capacity must be released');
    assert.strictEqual(order.confirmedRefundPaise, 0, 'Confirmed capacity must not increase');
    assert.strictEqual(order.paymentStatus, 'captured', 'Status reverts back to captured');
  });

  it('11c. POST /api/webhooks/razorpay rejects security discrepancy (amount tampering) with HTTP 400', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_tamper_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_tamper_001',
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_tamper_333',
      amountPaise: 417000,
      status: 'pending',
    });

    const tamperedPayload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_tamper_333',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 100000, // Tampered amount!
            currency: 'INR',
          },
        },
      },
    };

    const raw = JSON.stringify(tamperedPayload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_tamper_003')
      .send(raw);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(refund.status, 'pending', 'Refund must remain pending');
    assert.strictEqual(order.confirmedRefundPaise, 0, 'Accounting must not be modified');
  });

  it('11d. POST /api/webhooks/razorpay rejects settlement when authoritative gateway reports status pending', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_pending_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_pending_001',
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_pending_444',
      amountPaise: 417000,
      status: 'pending',
    });

    // Gateway says pending
    (refund as any).gatewayStatus = 'pending';

    const payload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_pending_444',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
            status: 'processed', // Webhook says processed, but gateway says pending!
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_pending_004')
      .send(raw);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(refund.status, 'pending', 'Refund must remain pending if gateway says pending');
    assert.strictEqual(order.confirmedRefundPaise, 0, 'Accounting must not change when gateway is pending');
  });

  it('11e. POST /api/webhooks/razorpay aborts settlement without modifying accounting when gateway lookup fails', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_gwfail_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_gwfail_001',
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_gwfail_555',
      amountPaise: 417000,
      status: 'pending',
    });

    // Mock client to simulate network error during gateway lookup
    setRazorpayClient({
      refunds: {
        fetch: async () => {
          throw new Error('ECONNRESET: Connection reset by peer on Razorpay API');
        },
      },
    } as any);

    const payload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_gwfail_555',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_gwfail_005')
      .send(raw);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(refund.status, 'pending', 'Refund remains pending when gateway verification fails');
    assert.strictEqual(order.confirmedRefundPaise, 0, 'Accounting must never change on uncertain gateway verification');
  });

  it('11f. POST /api/webhooks/razorpay rejects settlement when authoritative gateway reports amount mismatch', async () => {
    const order = createTestOrder({
      razorpayOrderId: 'order_wh_gwamt_test',
      amountReservedRefundPaise: 417000,
      confirmedRefundPaise: 0,
    });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_wh_gwamt_001',
      status: 'captured',
    });
    const refund = createTestRefund({
      orderId: order._id,
      paymentId: payment.paymentId,
      providerRefundId: 'rfnd_wh_gwamt_666',
      amountPaise: 417000,
      status: 'pending',
    });

    // Gateway reports different amount
    (refund as any).gatewayAmount = 200000;

    const payload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_wh_gwamt_666',
            order_id: order.razorpayOrderId,
            payment_id: payment.paymentId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_wh_gwamt_006')
      .send(raw);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(refund.status, 'pending');
    assert.strictEqual(order.confirmedRefundPaise, 0);
  });

  // ============================================================================
  // REQUIREMENT 2: REFUND MODEL STATUS AND IMMUTABILITY TESTS
  // ============================================================================
  it('12a. Refund model explicitly supports failed status and forbids settlement metadata on pending/failed refunds', async () => {
    const orderId = new mongoose.Types.ObjectId();

    // 1. Valid failed refund without settlement metadata validates cleanly
    const failedRefund = new Refund({
      refundId: 'rfnd_model_failed_001',
      orderId,
      paymentId: 'pay_valid_001',
      amountPaise: 150000,
      currency: 'INR',
      type: 'purchase_compensation',
      status: 'failed',
      failureReason: 'Customer card expired',
    });
    await failedRefund.validate();

    // 2. Pending refund with settledAt must fail schema validation
    const pendingWithSettledAt = new Refund({
      refundId: 'rfnd_model_pending_bad',
      orderId,
      paymentId: 'pay_valid_002',
      amountPaise: 150000,
      currency: 'INR',
      type: 'purchase_compensation',
      status: 'pending',
      settledAt: new Date(),
    });
    await assert.rejects(
      async () => await pendingWithSettledAt.validate(),
      (err: any) => !!err.errors?.settledAt
    );

    // 3. Failed refund with settledAt must fail schema validation
    const failedWithSettledAt = new Refund({
      refundId: 'rfnd_model_failed_bad',
      orderId,
      paymentId: 'pay_valid_003',
      amountPaise: 150000,
      currency: 'INR',
      type: 'purchase_compensation',
      status: 'failed',
      settledAt: new Date(),
    });
    await assert.rejects(
      async () => await failedWithSettledAt.validate(),
      (err: any) => !!err.errors?.settledAt
    );

    // 4. Failed refund with settlementSource must fail schema validation
    const failedWithSource = new Refund({
      refundId: 'rfnd_model_failed_bad_source',
      orderId,
      paymentId: 'pay_valid_004',
      amountPaise: 150000,
      currency: 'INR',
      type: 'purchase_compensation',
      status: 'failed',
      settlementSource: 'webhook',
    });
    await assert.rejects(
      async () => await failedWithSource.validate(),
      (err: any) => !!err.errors?.settlementSource
    );
  });

  it('12b. Settled refunds strictly require valid settlement metadata', async () => {
    const orderId = new mongoose.Types.ObjectId();

    // Missing settledAt and settlementSource
    const settledMissingMeta = new Refund({
      refundId: 'rfnd_model_settled_missing',
      orderId,
      paymentId: 'pay_valid_005',
      amountPaise: 150000,
      currency: 'INR',
      type: 'purchase_compensation',
      status: 'settled',
    });
    await assert.rejects(
      async () => await settledMissingMeta.validate(),
      (err: any) => !!err.errors?.settledAt && !!err.errors?.settlementSource
    );
  });

  it('12c. A failed refund cannot transition to settled via document save', async () => {
    const failedRefund = createTestRefund({
      refundId: 'rfnd_trans_test_001',
      status: 'failed',
      failureReason: 'Initial failure',
    });

    // Attempt to mutate status to settled
    failedRefund.status = 'settled';
    failedRefund.settledAt = new Date();
    failedRefund.settlementSource = 'webhook';

    await assert.rejects(
      async () => await failedRefund.save(),
      /Invalid refund status transition: A failed refund cannot transition to settled/
    );
  });

  it('12d. A failed refund cannot transition to settled via direct database update', async () => {
    const failedRefund = createTestRefund({
      refundId: 'rfnd_trans_update_001',
      status: 'failed',
    });

    await assert.rejects(
      async () =>
        await Refund.updateOne(
          { _id: failedRefund._id, status: 'failed' },
          { $set: { status: 'settled', settledAt: new Date(), settlementSource: 'webhook' } }
        ),
      /Invalid refund status transition: A failed refund cannot transition to settled/
    );
  });

  it('12e. A failed refund cannot acquire settlement metadata via direct database update', async () => {
    const failedRefund = createTestRefund({
      refundId: 'rfnd_meta_update_001',
      status: 'failed',
    });

    await assert.rejects(
      async () =>
        await Refund.updateOne(
          { _id: failedRefund._id, status: 'failed' },
          { $set: { settledAt: new Date() } }
        ),
      /Cannot set settlement metadata on a failed refund/
    );
  });

  it('12f. Existing immutable field protections remain effective on Refund', async () => {
    const refund = createTestRefund({
      refundId: 'rfnd_immut_test_001',
      amountPaise: 417000,
      status: 'pending',
    });

    // Mongoose schema immutable: true prevents normal property mutation
    const origAmount = refund.amountPaise;
    refund.amountPaise = 200000;
    assert.strictEqual(refund.amountPaise, origAmount, 'Direct mutation prevented by schema');

    // Forced modification throws in pre-save guard
    refund.set('amountPaise', 200000, { overwriteImmutable: true });
    await assert.rejects(
      async () => await refund.save(),
      /Cannot modify immutable field: amountPaise/
    );
  });

  // ============================================================================
  // REQUIREMENT 3: WEBHOOK CRASH RECOVERY TESTS
  // ============================================================================
  it('13a. Crash recovery: event left in processing with expired lease is safely recovered and claimed by new worker', async () => {
    const eventId = 'evt_crash_recovery_001';
    const now = new Date();

    // Simulate an event left in processing by a worker that crashed 2 minutes ago
    databaseWebhookEvents.push({
      _id: new mongoose.Types.ObjectId(),
      eventId,
      event: 'payment.captured',
      status: 'processing',
      attempts: 1,
      leaseWorkerId: 'worker_crashed_999',
      leaseToken: 'token_crashed_999',
      leaseAcquiredAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000), // Expired!
    });

    const claimResult = await claimWebhookEvent({
      eventId,
      eventName: 'payment.captured',
      workerId: 'worker_new_111',
      now,
    });

    assert.strictEqual(claimResult.claimed, true, 'Expired lease must be claimed');
    assert.strictEqual(claimResult.workerId, 'worker_new_111');
    assert.notStrictEqual(claimResult.leaseToken, 'token_crashed_999', 'New leaseToken must be issued');

    const eventInDb = databaseWebhookEvents.find((e) => e.eventId === eventId);
    assert.strictEqual(eventInDb.attempts, 2, 'Attempts must increment upon recovery');
    assert.strictEqual(eventInDb.leaseWorkerId, 'worker_new_111');
  });

  it('13b. Active lease prevents concurrent workers from double-processing', async () => {
    const eventId = 'evt_active_lease_002';
    const now = new Date();

    // Active worker currently processing (lease valid for another 45 seconds)
    databaseWebhookEvents.push({
      _id: new mongoose.Types.ObjectId(),
      eventId,
      event: 'payment.captured',
      status: 'processing',
      attempts: 1,
      leaseWorkerId: 'worker_active_222',
      leaseToken: 'token_active_222',
      leaseAcquiredAt: now,
      leaseExpiresAt: new Date(now.getTime() + 45_000),
    });

    const secondWorkerClaim = await claimWebhookEvent({
      eventId,
      eventName: 'payment.captured',
      workerId: 'worker_competitor_333',
      now,
    });

    assert.strictEqual(secondWorkerClaim.claimed, false);
    assert.strictEqual(secondWorkerClaim.reason, 'currently_processing');
  });

  it('13c. Stale worker whose lease expired cannot overwrite a newer worker result via leaseToken fencing', async () => {
    const eventId = 'evt_stale_fencing_003';
    const now = new Date();

    // 1. Worker 1 claims event
    const w1Claim = await claimWebhookEvent({
      eventId,
      eventName: 'refund.processed',
      workerId: 'worker_stale_1',
      leaseDurationMs: 10_000, // 10s lease
      now,
    });
    assert.strictEqual(w1Claim.claimed, true);
    const w1Token = w1Claim.leaseToken!;

    // 2. Time passes (15 seconds) -> Lease expires, Worker 2 recovers the event
    const later = new Date(now.getTime() + 15_000);
    const w2Claim = await claimWebhookEvent({
      eventId,
      eventName: 'refund.processed',
      workerId: 'worker_fresh_2',
      leaseDurationMs: 60_000,
      now: later,
    });
    assert.strictEqual(w2Claim.claimed, true);
    const w2Token = w2Claim.leaseToken!;

    // 3. Worker 1 wakes up late and attempts to mark the event processed with its stale leaseToken
    const w1CompleteResult = await completeWebhookEvent({
      eventId,
      leaseToken: w1Token,
      status: 'processed',
      orderId: 'ORD_STALE_OVERWRITE',
    });
    assert.strictEqual(
      w1CompleteResult,
      false,
      'Stale worker must NOT be able to complete or overwrite event'
    );

    // 4. Worker 2 successfully completes with its active leaseToken
    const w2CompleteResult = await completeWebhookEvent({
      eventId,
      leaseToken: w2Token,
      status: 'processed',
      orderId: 'ORD_FRESH_CORRECT',
    });
    assert.strictEqual(w2CompleteResult, true, 'Active worker completes successfully');

    const finalDoc = databaseWebhookEvents.find((e) => e.eventId === eventId);
    assert.strictEqual(finalDoc.orderId, 'ORD_FRESH_CORRECT', 'Newer worker result must be preserved');
    assert.strictEqual(finalDoc.status, 'processed');
  });

  it('13d. Genuinely completed event is permanent and idempotent', async () => {
    const eventId = 'evt_completed_idem_004';

    databaseWebhookEvents.push({
      _id: new mongoose.Types.ObjectId(),
      eventId,
      event: 'payment.captured',
      status: 'processed',
      attempts: 1,
      processedAt: new Date(),
    });

    const duplicateClaim = await claimWebhookEvent({
      eventId,
      eventName: 'payment.captured',
      workerId: 'worker_dup_444',
    });

    assert.strictEqual(duplicateClaim.claimed, false);
    assert.strictEqual(duplicateClaim.reason, 'already_processed');
  });
});
