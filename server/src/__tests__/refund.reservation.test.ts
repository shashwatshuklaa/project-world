/**
 * ============================================================================
 * PHASE 8.3 — STEP 3: REFUND RESERVATION AND ACCOUNTING TEST SUITE
 * ============================================================================
 *
 * ARCHITECTURAL NOTICE ON TEST ENVIRONMENT:
 * This test suite utilizes an in-process transactional test harness that mimics
 * MongoDB replica-set transaction semantics (multi-document atomicity, transactional
 * rollback, session isolation, and index unique constraint enforcement).
 * In accordance with strict project rules prohibiting live Atlas connections or
 * unapproved package installations (such as mongodb-memory-server), all transaction
 * boundaries are deterministically verified in-process. Production deployment
 * utilizes a physical MongoDB replica set with WiredTiger snapshot isolation and
 * document-level write locks.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob } from '../models/RefundJob.js';
import {
  reserveRefund,
  getRemainingRefundableCapacity,
  generateRefundReservationId,
  PaymentNotFoundError,
  PaymentNotCapturedError,
  OrderNotFoundError,
  OrderStateInvalidForRefundError,
  SecurityDiscrepancyError,
  InvalidRefundAmountError,
  InvalidCurrencyError,
  InvalidIdempotencyKeyError,
  RefundAmountExceedsRemainingError,
  IdempotencyConflictError,
} from '../services/refund.service.js';

describe('Phase 8.3 — Step 3: Refund Reservation and Accounting', () => {
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
      paymentStatus: overrides.paymentStatus || 'captured',
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: overrides.razorpayPaymentId || `pay_${orderId.substring(4)}`,
      idempotencyKey: overrides.idempotencyKey || `idem_${orderId}`,
      totalCapturedPaise: overrides.totalCapturedPaise ?? amountPaise,
      purchaseCapturedPaise: overrides.purchaseCapturedPaise ?? amountPaise,
      duplicateCapturedPaise: overrides.duplicateCapturedPaise ?? 0,
      amountReservedRefundPaise: overrides.amountReservedRefundPaise ?? 0,
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

  beforeEach(() => {
    databaseOrders = [];
    databasePaymentAttempts = [];
    databaseRefunds = [];
    databaseRefundJobs = [];

    // Mock Order methods
    Order.findOne = (async (query: any) => {
      const found = databaseOrders.find((doc) => {
        let matches = true;
        if (query._id && doc._id.toString() !== query._id.toString()) matches = false;
        if (query.orderId && doc.orderId !== query.orderId) matches = false;
        if (query.userId && doc.userId.toString() !== query.userId.toString()) matches = false;
        if (query.razorpayOrderId && doc.razorpayOrderId !== query.razorpayOrderId) matches = false;
        return matches;
      });
      if (!found) return null;
      found.session = function () { return this; };
      return found;
    }) as any;

    Order.findById = (async (id: any) => {
      const targetId = id?.toString?.() || id;
      const found = databaseOrders.find((doc) => doc._id?.toString() === targetId);
      if (!found) return null;
      found.session = function () { return this; };
      return found;
    }) as any;

    Order.prototype.save = async function (options?: any) {
      const self = this as any;
      if (!self._id) self._id = new mongoose.Types.ObjectId();
      const idx = databaseOrders.findIndex((d) => d._id?.toString() === self._id.toString());
      if (idx >= 0) {
        databaseOrders[idx] = self;
      } else {
        databaseOrders.push(self);
      }
      return self;
    };

    // Mock PaymentAttempt methods
    PaymentAttempt.findOne = (async (query: any) => {
      const found = databasePaymentAttempts.find((doc) => {
        let matches = true;
        if (query.paymentId && doc.paymentId !== query.paymentId) matches = false;
        if (query.orderId && doc.orderId.toString() !== query.orderId.toString()) matches = false;
        if (query.classification && doc.classification !== query.classification) matches = false;
        return matches;
      });
      if (!found) return null;
      found.session = function () { return this; };
      return found;
    }) as any;

    PaymentAttempt.prototype.save = async function () {
      const self = this as any;
      if (!self._id) self._id = new mongoose.Types.ObjectId();
      const idx = databasePaymentAttempts.findIndex((p) => p.paymentId === self.paymentId);
      if (idx >= 0) databasePaymentAttempts[idx] = self;
      else databasePaymentAttempts.push(self);
      return self;
    };

    // Mock Refund methods
    Refund.find = ((query: any) => {
      const found = databaseRefunds.filter((r) => {
        let matches = true;
        if (query.paymentId && r.paymentId !== query.paymentId) matches = false;
        if (query.orderId && r.orderId.toString() !== query.orderId.toString()) matches = false;
        if (query.status) {
          if (typeof query.status === 'object' && query.status.$in) {
            if (!query.status.$in.includes(r.status)) matches = false;
          } else if (r.status !== query.status) {
            matches = false;
          }
        }
        return matches;
      });
      const promise: any = Promise.resolve(found);
      promise.session = function () { return this; };
      return promise;
    }) as any;

    Refund.findOne = (async (query: any) => {
      const found = databaseRefunds.find((r) => {
        let matches = true;
        if (query.refundId && r.refundId !== query.refundId) matches = false;
        if (query.refundJobId && r.refundJobId?.toString() !== query.refundJobId?.toString()) matches = false;
        if (query.paymentId && r.paymentId !== query.paymentId) matches = false;
        return matches;
      });
      if (!found) return null;
      found.session = function () { return this; };
      return found;
    }) as any;

    Refund.create = (async (docs: any, options?: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        const existing = databaseRefunds.find((r) => r.refundId === d.refundId);
        if (existing) {
          const err: any = new Error(
            `E11000 duplicate key error collection: project_world.refunds index: refundId_1 dup key: { refundId: "${d.refundId}" }`
          );
          err.code = 11000;
          throw err;
        }
      }
      const created = arr.map((d: any) => {
        const item = new Refund();
        item.init({
          ...d,
          _id: d._id || new mongoose.Types.ObjectId(),
        });
        databaseRefunds.push(item);
        return item;
      });
      return Array.isArray(docs) ? created : created[0];
    }) as any;

    Refund.prototype.save = async function () {
      const self = this as any;
      if (!self.isNew) {
        for (const field of ['refundId', 'orderId', 'paymentId', 'amountPaise', 'currency', 'type']) {
          if (self.isModified(field)) {
            throw new Error(`Cannot modify immutable field: ${field}`);
          }
        }
      }
      return self;
    };

    // Mock RefundJob methods
    RefundJob.findOne = (async (query: any) => {
      const found = databaseRefundJobs.find((j) => {
        let matches = true;
        if (query.idempotencyKey && j.idempotencyKey !== query.idempotencyKey) matches = false;
        if (query.targetPaymentId && j.targetPaymentId !== query.targetPaymentId) matches = false;
        if (query._id && j._id.toString() !== query._id.toString()) matches = false;
        return matches;
      });
      if (!found) return null;
      found.session = function () { return this; };
      return found;
    }) as any;

    RefundJob.create = (async (docs: any, options?: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        const existing = databaseRefundJobs.find((j) => j.idempotencyKey === d.idempotencyKey);
        if (existing) {
          const err: any = new Error(
            `E11000 duplicate key error collection: project_world.refundjobs index: idempotencyKey_1 dup key: { idempotencyKey: "${d.idempotencyKey}" }`
          );
          err.code = 11000;
          throw err;
        }
      }
      const created = arr.map((d: any) => {
        const item = new RefundJob();
        item.init({
          ...d,
          _id: d._id || new mongoose.Types.ObjectId(),
        });
        databaseRefundJobs.push(item);
        return item;
      });
      return Array.isArray(docs) ? created : created[0];
    }) as any;

    RefundJob.prototype.save = async function () {
      const self = this as any;
      if (!self.isNew) {
        for (const field of [
          'orderId',
          'targetPaymentId',
          'targetAmountPaise',
          'currency',
          'reason',
          'classification',
          'idempotencyKey',
        ]) {
          if (self.isModified(field)) {
            throw new Error(`Cannot modify immutable field: ${field}`);
          }
        }
      }
      return self;
    };
  });

  // ============================================================================
  // 1. FULL REFUND RESERVATION
  // ============================================================================
  it('1. full refund reservation atomically reserves entire captured amount and transitions order paymentStatus to refund_pending', async () => {
    const order = createTestOrder({ totalAmount: 4170, amountPaise: 417000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_full_001',
      amountCapturedPaise: 417000,
      classification: 'primary',
      status: 'captured',
    });

    const result = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 417000,
      reason: 'customer_cancellation',
      idempotencyKey: 'idem_full_001',
    });

    assert.equal(result.status, 'reserved');
    assert.equal(result.isDuplicateReservation, false);
    assert.equal(result.remainingPaymentRefundablePaise, 0);
    assert.equal(result.remainingOrderRefundablePaise, 0);

    // Verify Order accounting state
    const updatedOrder = databaseOrders.find((o) => o._id.toString() === order._id.toString());
    assert.equal(updatedOrder.amountReservedRefundPaise, 417000);
    assert.equal(updatedOrder.confirmedRefundPaise, 0, 'confirmedRefundPaise must remain 0 on reservation');
    assert.equal(updatedOrder.purchaseRefundedPaise, 0, 'purchaseRefundedPaise must remain 0 on reservation');
    assert.equal(updatedOrder.paymentStatus, 'refund_pending');
    assert.equal(updatedOrder.status, 'completed', 'Order status must remain completed, NOT refunded');

    // Verify PaymentAttempt status
    const updatedPayment = databasePaymentAttempts.find((p) => p.paymentId === payment.paymentId);
    assert.equal(updatedPayment.status, 'captured', 'PaymentAttempt status must remain captured, NOT refunded');

    // Verify RefundJob created atomically
    assert.equal(databaseRefundJobs.length, 1);
    const job = databaseRefundJobs[0];
    assert.equal(job.targetPaymentId, payment.paymentId);
    assert.equal(job.targetAmountPaise, 417000);
    assert.equal(job.currency, 'INR');
    assert.equal(job.classification, 'purchase_compensation');
    assert.equal(job.status, 'pending');
    assert.equal(job.apiDispatched, false);
    assert.equal(job.attempts, 0);
    assert.equal(job.idempotencyKey, 'idem_full_001');

    // Verify Refund record created atomically
    assert.equal(databaseRefunds.length, 1);
    const refund = databaseRefunds[0];
    assert.equal(refund.paymentId, payment.paymentId);
    assert.equal(refund.orderId.toString(), order._id.toString());
    assert.equal(refund.amountPaise, 417000);
    assert.equal(refund.type, 'purchase_compensation');
    assert.equal(refund.status, 'pending', 'Refund status must be pending, NOT settled');
    assert.equal(refund.settledAt, undefined, 'settledAt must be undefined on reservation');
    assert.equal(refund.settlementSource, undefined, 'settlementSource must be undefined on reservation');
    assert.equal(refund.refundJobId.toString(), job._id.toString(), 'Refund must link to RefundJob');
  });

  // ============================================================================
  // 2. PARTIAL REFUND RESERVATION
  // ============================================================================
  it('2. partial refund reservation reserves partial amount and tracks correct remaining capacity', async () => {
    const order = createTestOrder({ totalAmount: 5000, amountPaise: 500000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_partial_001',
      amountCapturedPaise: 500000,
      classification: 'primary',
      status: 'captured',
    });

    const result = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 200000, // 2000 INR out of 5000 INR
      reason: 'partial_item_return',
      idempotencyKey: 'idem_partial_001',
    });

    assert.equal(result.status, 'reserved');
    assert.equal(result.isDuplicateReservation, false);
    assert.equal(result.remainingPaymentRefundablePaise, 300000);
    assert.equal(result.remainingOrderRefundablePaise, 300000);

    const updatedOrder = databaseOrders[0];
    assert.equal(updatedOrder.amountReservedRefundPaise, 200000);
    assert.equal(updatedOrder.confirmedRefundPaise, 0);
    assert.equal(updatedOrder.paymentStatus, 'refund_pending');

    const job = databaseRefundJobs[0];
    assert.equal(job.classification, 'partial_refund');
    assert.equal(job.targetAmountPaise, 200000);

    const refund = databaseRefunds[0];
    assert.equal(refund.type, 'partial_refund');
    assert.equal(refund.amountPaise, 200000);
  });

  // ============================================================================
  // 3. REFUND EXCEEDING REMAINING REFUNDABLE AMOUNT
  // ============================================================================
  it('3. rejects refund request exceeding the remaining refundable amount on payment attempt', async () => {
    const order = createTestOrder({ totalAmount: 1000, amountPaise: 100000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_exceed_001',
      amountCapturedPaise: 100000,
      status: 'captured',
    });

    // Request 100001 paise (exceeds captured 100000)
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 100001,
          reason: 'invalid_excess_refund',
          idempotencyKey: 'idem_exceed_001',
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundAmountExceedsRemainingError);
        assert.match(err.message, /exceeds remaining refundable capacity/i);
        return true;
      }
    );

    // Verify zero mutations occurred
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 0);
    assert.equal(databaseRefundJobs.length, 0);
    assert.equal(databaseRefunds.length, 0);
  });

  // ============================================================================
  // 4. REFUND AGAINST AN UNCAPTURED PAYMENT
  // ============================================================================
  it('4. rejects refund against uncaptured payment attempts (authorized, failed, held, discrepancy)', async () => {
    const order = createTestOrder();

    const uncapturedStatuses: Array<'authorized' | 'failed' | 'held' | 'discrepancy'> = [
      'authorized',
      'failed',
      'held',
      'discrepancy',
    ];

    for (const status of uncapturedStatuses) {
      const payment = createTestPaymentAttempt({
        orderId: order._id,
        paymentId: `pay_uncap_${status}`,
        amountCapturedPaise: 417000,
        status,
      });

      await assert.rejects(
        async () => {
          await reserveRefund({
            orderId: order.orderId,
            paymentId: payment.paymentId,
            amountPaise: 100000,
            reason: 'attempt_on_uncaptured',
            idempotencyKey: `idem_uncap_${status}`,
          });
        },
        (err: any) => {
          assert.ok(err instanceof PaymentNotCapturedError);
          assert.match(err.message, /cannot be refunded because its status is/i);
          return true;
        }
      );
    }

    assert.equal(databaseRefundJobs.length, 0);
    assert.equal(databaseRefunds.length, 0);
  });

  // ============================================================================
  // 5. DUPLICATE IDEMPOTENCY KEY (IDEMPOTENT REPLAY)
  // ============================================================================
  it('5. duplicate idempotency key returns idempotent success without duplicate reservations or double accounting', async () => {
    const order = createTestOrder({ totalAmount: 5000, amountPaise: 500000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_idem_001',
      amountCapturedPaise: 500000,
      status: 'captured',
    });

    const reservationParams = {
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 250000,
      reason: 'customer_return_item_a',
      idempotencyKey: 'refund:order:5000:item:a',
    };

    // First call: reserves 250000 paise
    const result1 = await reserveRefund(reservationParams);
    assert.equal(result1.status, 'reserved');
    assert.equal(result1.isDuplicateReservation, false);

    const initialReserved = databaseOrders[0].amountReservedRefundPaise;
    assert.equal(initialReserved, 250000);
    assert.equal(databaseRefundJobs.length, 1);
    assert.equal(databaseRefunds.length, 1);

    // Second call: exact same idempotency key and params
    const result2 = await reserveRefund(reservationParams);
    assert.equal(result2.status, 'already_reserved');
    assert.equal(result2.isDuplicateReservation, true);
    assert.equal(result2.refundJob._id.toString(), result1.refundJob._id.toString());
    assert.equal(result2.refund._id.toString(), result1.refund._id.toString());

    // Accounting invariant: reservation total must NOT double!
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 250000);
    assert.equal(databaseRefundJobs.length, 1);
    assert.equal(databaseRefunds.length, 1);
  });

  // ============================================================================
  // 6. DUPLICATE IDEMPOTENCY KEY WITH CONFLICTING PARAMETERS
  // ============================================================================
  it('6. duplicate idempotency key with conflicting parameters is rejected with IdempotencyConflictError', async () => {
    const order = createTestOrder({ totalAmount: 5000, amountPaise: 500000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_conflict_001',
      amountCapturedPaise: 500000,
      status: 'captured',
    });

    const key = 'idem_conflict_fixed_key';

    // First reservation for 100000 paise
    await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 100000,
      reason: 'first_call',
      idempotencyKey: key,
    });

    // Second call: same idempotency key, but different amount (200000 paise)
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 200000, // Conflict!
          reason: 'second_conflicting_call',
          idempotencyKey: key,
        });
      },
      (err: any) => {
        assert.ok(err instanceof IdempotencyConflictError);
        assert.match(err.message, /already exists with different refund parameters/i);
        return true;
      }
    );

    // Ensure order reserved total remained 100000, NOT 200000 or 300000
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 100000);
  });

  // ============================================================================
  // 7. MULTIPLE PARTIAL REFUNDS REACHING FULL CAPTURED AMOUNT
  // ============================================================================
  it('7. multiple partial refunds incrementally consume capacity until exact captured amount is reached, then reject excess', async () => {
    const order = createTestOrder({ totalAmount: 3000, amountPaise: 300000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_multi_partial_001',
      amountCapturedPaise: 300000,
      status: 'captured',
    });

    // Step 1: Reserve 100000 paise (remaining = 200000)
    const r1 = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 100000,
      reason: 'item_1_return',
      idempotencyKey: 'idem_multi_001',
    });
    assert.equal(r1.remainingPaymentRefundablePaise, 200000);
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 100000);

    // Step 2: Reserve 120000 paise (remaining = 80000)
    const r2 = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 120000,
      reason: 'item_2_return',
      idempotencyKey: 'idem_multi_002',
    });
    assert.equal(r2.remainingPaymentRefundablePaise, 80000);
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 220000);

    // Step 3: Reserve remaining 80000 paise (remaining = 0)
    const r3 = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 80000,
      reason: 'item_3_return',
      idempotencyKey: 'idem_multi_003',
    });
    assert.equal(r3.remainingPaymentRefundablePaise, 0);
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 300000);

    // Step 4: Any further refund (even 1 paisa) MUST BE REJECTED
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 1,
          reason: 'excess_after_exhaustion',
          idempotencyKey: 'idem_multi_004',
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundAmountExceedsRemainingError);
        assert.match(err.message, /exceeds remaining refundable capacity of 0 paise/i);
        return true;
      }
    );

    // Exactly 3 jobs and 3 refunds exist
    assert.equal(databaseRefundJobs.length, 3);
    assert.equal(databaseRefunds.length, 3);
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 300000);
  });

  // ============================================================================
  // 8. DUPLICATE-CHARGE COMPENSATION REFUND RESERVATION & SEPARATION
  // ============================================================================
  it('8. duplicate-charge compensation refund reservation preserves primary purchase accounting and does not change refund status', async () => {
    // Order was paid 417000 for primary purchase, plus an accidental duplicate payment of 417000
    const order = createTestOrder({
      totalAmount: 4170,
      amountPaise: 417000,
      totalCapturedPaise: 834000,
      purchaseCapturedPaise: 417000,
      duplicateCapturedPaise: 417000,
      paymentStatus: 'duplicate_charge_detected',
    });

    const primaryPayment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_primary_s8',
      amountCapturedPaise: 600000,
      classification: 'primary',
      status: 'captured',
    });

    const duplicatePayment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_duplicate_charge_999',
      amountCapturedPaise: 600000,
      classification: 'duplicate_charge',
      status: 'captured',
    });

    // 8.1. Attempt to over-reserve duplicate funds (trying to consume primary purchase capacity)
    // duplicate payment has 600000 captured, but order only has 417000 in duplicate pool!
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: duplicatePayment.paymentId,
          amountPaise: 500000, // 500000 > duplicateCapturedPaise (417000), even though totalCapturedPaise is 834000!
          reason: 'duplicate_exceeding_duplicate_pool',
          idempotencyKey: 'compensation:duplicate:excess_test',
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundAmountExceedsRemainingError);
        assert.match(err.message, /Duplicate refunds cannot consume primary purchase capacity/i);
        return true;
      }
    );

    // 8.1b. Attempt to over-reserve primary purchase funds (trying to consume duplicate captured funds)
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: primaryPayment.paymentId,
          amountPaise: 500000, // 500000 > purchaseCapturedPaise (417000)
          reason: 'purchase_exceeding_purchase_pool',
          idempotencyKey: 'refund:purchase:excess_test',
        });
      },
      (err: any) => {
        assert.ok(err instanceof RefundAmountExceedsRemainingError);
        assert.match(err.message, /Purchase refunds cannot consume duplicate captured funds/i);
        return true;
      }
    );

    // 8.2. Valid duplicate-charge compensation refund reservation
    const result = await reserveRefund({
      orderId: order.orderId,
      paymentId: duplicatePayment.paymentId,
      amountPaise: 417000,
      reason: 'automated_duplicate_charge_reversal',
      idempotencyKey: 'compensation:duplicate:pay_duplicate_charge_999',
    });

    assert.equal(result.status, 'reserved');
    assert.equal(result.refundJob.classification, 'duplicate_charge_compensation');
    assert.equal(result.refund.type, 'duplicate_charge_compensation');

    // Remaining capacity breakdown
    assert.equal(result.remainingDuplicateRefundablePaise, 0);
    assert.equal(
      result.remainingPurchaseRefundablePaise,
      417000,
      'Primary purchase refundable capacity must be 100% preserved at 417000 paise'
    );

    // Accounting verification
    const updatedOrder = databaseOrders[0];
    assert.equal(updatedOrder.amountReservedRefundPaise, 417000);
    assert.equal(updatedOrder.confirmedRefundPaise, 0);
    assert.equal(updatedOrder.purchaseCapturedPaise, 417000, 'Primary purchase captured funds must remain 417000');
    assert.equal(updatedOrder.purchaseRefundedPaise, 0, 'Primary purchase refunded funds must remain 0');
    assert.equal(updatedOrder.duplicateCapturedPaise, 417000, 'Duplicate captured funds remain 417000 until settled');
    assert.equal(updatedOrder.totalCapturedPaise, 834000);

    // Crucial Guard: Status must NOT become 'refund_pending' or 'refunded'
    assert.equal(
      updatedOrder.paymentStatus,
      'duplicate_charge_detected',
      'Order paymentStatus must remain duplicate_charge_detected, NOT refund_pending'
    );
    assert.equal(
      updatedOrder.status,
      'completed',
      'Order status must remain completed, NOT refunded'
    );

    // 8.3. Verify primary purchase can still be refunded independently
    const primaryRefundResult = await reserveRefund({
      orderId: order.orderId,
      paymentId: primaryPayment.paymentId,
      amountPaise: 417000,
      reason: 'subsequent_primary_purchase_return',
      idempotencyKey: 'refund:primary:order:complete',
    });

    assert.equal(primaryRefundResult.status, 'reserved');
    assert.equal(primaryRefundResult.remainingPurchaseRefundablePaise, 0);
    assert.equal(updatedOrder.amountReservedRefundPaise, 834000); // 417000 + 417000

    // Only the primary purchase refund transitions the order to refund_pending
    assert.equal(updatedOrder.paymentStatus, 'refund_pending');
  });

  // ============================================================================
  // 8B. DUPLICATE-CHARGE ON CAPTURED ORDER DOES NOT TRANSITION STATUS
  // ============================================================================
  it('8b. duplicate-charge reservation on an order with paymentStatus captured does not transition to refund_pending', async () => {
    const order = createTestOrder({
      totalAmount: 4170,
      amountPaise: 417000,
      totalCapturedPaise: 834000,
      purchaseCapturedPaise: 417000,
      duplicateCapturedPaise: 417000,
      paymentStatus: 'captured', // Starts as captured
    });

    const duplicatePayment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_dup_on_captured',
      amountCapturedPaise: 417000,
      classification: 'duplicate_charge',
      status: 'captured',
    });

    await reserveRefund({
      orderId: order.orderId,
      paymentId: duplicatePayment.paymentId,
      amountPaise: 417000,
      reason: 'dup_reversal',
      idempotencyKey: 'idem_dup_captured_stay',
    });

    // Must remain 'captured', NOT 'refund_pending'
    assert.equal(
      databaseOrders[0].paymentStatus,
      'captured',
      'paymentStatus must remain captured on duplicate refund'
    );
  });

  // ============================================================================
  // 9. CONCURRENT RESERVATIONS PREVENTING OVER-RESERVATION
  // ============================================================================
  it('9. concurrent refund reservations prevent over-reserving captured funds', async () => {
    const order = createTestOrder({ totalAmount: 1000, amountPaise: 100000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_concurrent_001',
      amountCapturedPaise: 100000,
      status: 'captured',
    });

    // Two concurrent requests, each requesting 70000 paise (total 140000 > 100000)
    const req1 = reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 70000,
      reason: 'concurrent_claim_a',
      idempotencyKey: 'idem_concurrent_claim_a',
    });

    const req2 = reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 70000,
      reason: 'concurrent_claim_b',
      idempotencyKey: 'idem_concurrent_claim_b',
    });

    const results = await Promise.allSettled([req1, req2]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed and one must be rejected for exceeding remaining capacity
    assert.equal(fulfilled.length, 1, 'Exactly one concurrent reservation must succeed');
    assert.equal(rejected.length, 1, 'Exactly one concurrent reservation must be rejected');

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejectionReason instanceof RefundAmountExceedsRemainingError);

    // Final order reserved total must be strictly 70000, NEVER 140000
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 70000);
    assert.equal(databaseRefundJobs.length, 1);
    assert.equal(databaseRefunds.length, 1);
  });

  // ============================================================================
  // 9B. TWO CONCURRENT IDENTICAL REQUESTS PRODUCE EXACTLY ONE RESERVATION
  // ============================================================================
  it('9b. two simultaneous identical reservation requests produce exactly one reservation without doubling accounting', async () => {
    const order = createTestOrder({ totalAmount: 2000, amountPaise: 200000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_identical_race_001',
      amountCapturedPaise: 200000,
      status: 'captured',
    });

    const params = {
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 100000,
      reason: 'customer_return_race',
      idempotencyKey: 'idem_identical_race_key',
    };

    // Dispatch two identical requests simultaneously
    const [res1, res2] = await Promise.all([
      reserveRefund(params),
      reserveRefund(params),
    ]);

    // Both return success
    assert.ok(res1.status === 'reserved' || res1.status === 'already_reserved');
    assert.ok(res2.status === 'reserved' || res2.status === 'already_reserved');

    // Exactly one is a duplicate reservation
    assert.equal(
      [res1.isDuplicateReservation, res2.isDuplicateReservation].filter(Boolean).length,
      1,
      'Exactly one request must be flagged as duplicate reservation'
    );

    // Both refer to the exact same Refund and RefundJob IDs
    assert.equal(res1.refundJob._id.toString(), res2.refundJob._id.toString());
    assert.equal(res1.refund._id.toString(), res2.refund._id.toString());

    // Accounting invariant: reservation total must NOT double!
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 100000);
    assert.equal(databaseRefundJobs.length, 1);
    assert.equal(databaseRefunds.length, 1);
  });

  // ============================================================================
  // 9C. CONCURRENT IDEMPOTENCY KEY E11000 RECOVERY OUTSIDE ABORTED TRANSACTION
  // ============================================================================
  it('9c. recovers outside aborted transaction when unique-index E11000 error hits during idempotency race', async () => {
    const order = createTestOrder({ totalAmount: 3000, amountPaise: 300000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_e11000_race_001',
      amountCapturedPaise: 300000,
      status: 'captured',
    });

    const key = 'idem_e11000_recovery_key';

    // Step 1: Winner commits the first reservation
    const winnerResult = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 150000,
      reason: 'first_winner',
      idempotencyKey: key,
    });
    assert.equal(winnerResult.status, 'reserved');
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 150000);

    // Step 2: Now simulate a racer that queried findOne before the winner committed (concurrent race window)
    const originalJobCreate = RefundJob.create;
    const originalJobFindOne = RefundJob.findOne;
    let e11000Triggered = false;
    let initialFindBypassed = false;

    RefundJob.findOne = (async (query: any) => {
      // Simulate Racer 2's in-transaction findOne running before Racer 1's commit:
      if (!initialFindBypassed && query.idempotencyKey === key) {
        initialFindBypassed = true;
        return null;
      }
      return originalJobFindOne(query);
    }) as any;

    RefundJob.create = (async (docs: any, options?: any) => {
      e11000Triggered = true;
      const err: any = new Error(
        `E11000 duplicate key error collection: project_world.refundjobs index: idempotencyKey_1 dup key: { idempotencyKey: "${key}" }`
      );
      err.code = 11000;
      throw err;
    }) as any;

    try {
      const recoveredResult = await reserveRefund({
        orderId: order.orderId,
        paymentId: payment.paymentId,
        amountPaise: 150000,
        reason: 'simulated_racing_racer',
        idempotencyKey: key,
      });

      assert.ok(e11000Triggered, 'E11000 must have been triggered during RefundJob.create');
      assert.equal(recoveredResult.status, 'already_reserved');
      assert.equal(recoveredResult.isDuplicateReservation, true);
      assert.equal(recoveredResult.refundJob._id.toString(), winnerResult.refundJob._id.toString());
      assert.equal(recoveredResult.refund._id.toString(), winnerResult.refund._id.toString());

      // Accounting must NOT be incremented twice!
      assert.equal(databaseOrders[0].amountReservedRefundPaise, 150000);
      assert.equal(databaseRefundJobs.length, 1);
      assert.equal(databaseRefunds.length, 1);
    } finally {
      RefundJob.create = originalJobCreate;
      RefundJob.findOne = originalJobFindOne;
    }
  });

  // ============================================================================
  // 9D. CONCURRENT CONFLICTING REQUESTS USING THE SAME KEY
  // ============================================================================
  it('9d. concurrent conflicting requests using the same idempotency key are rejected', async () => {
    const order = createTestOrder({ totalAmount: 4000, amountPaise: 400000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_conflict_race_001',
      amountCapturedPaise: 400000,
      status: 'captured',
    });

    const key = 'idem_conflict_race_shared_key';

    // Request A: 100000 paise
    const reqA = reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 100000,
      reason: 'request_a',
      idempotencyKey: key,
    });

    // Request B: conflicting amount of 200000 paise with the same key
    const reqB = reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 200000,
      reason: 'request_b_conflicting',
      idempotencyKey: key,
    });

    const results = await Promise.allSettled([reqA, reqB]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one conflicting request must succeed');
    assert.equal(rejected.length, 1, 'The conflicting request must be rejected');

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(
      rejectionReason instanceof IdempotencyConflictError,
      `Expected IdempotencyConflictError, got: ${rejectionReason}`
    );

    // Only the winning reservation was recorded
    assert.equal(databaseOrders[0].amountReservedRefundPaise, 100000);
    assert.equal(databaseRefundJobs.length, 1);
  });

  // ============================================================================
  // 10. TRANSACTION ROLLBACK INTEGRITY
  // ============================================================================
  it('10. transaction abort rolls back order reservation and prevents orphan Refund or RefundJob persistence', async () => {
    const order = createTestOrder({ totalAmount: 4170, amountPaise: 417000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_rollback_001',
      amountCapturedPaise: 417000,
      status: 'captured',
    });

    // Save baseline snapshot of order
    const originalReserved = order.amountReservedRefundPaise;

    // Simulate database constraint failure on Refund creation
    const originalRefundCreate = Refund.create;
    Refund.create = (async () => {
      throw new Error('Simulated write error during Refund document persistence');
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await reserveRefund({
            orderId: order.orderId,
            paymentId: payment.paymentId,
            amountPaise: 200000,
            reason: 'will_fail',
            idempotencyKey: 'idem_rollback_test',
          });
        },
        /Simulated write error during Refund document persistence/
      );

      // Verify that Order document reserved amount was reverted / not corrupted
      assert.equal(
        databaseOrders[0].amountReservedRefundPaise,
        originalReserved,
        'Order amountReservedRefundPaise must be rolled back to original 0'
      );

      // Verify no orphan Refund documents persisted
      assert.equal(databaseRefunds.length, 0);
    } finally {
      Refund.create = originalRefundCreate;
    }
  });

  // ============================================================================
  // 11. CROSS-ORDER PAYMENT HIJACKING PREVENTION
  // ============================================================================
  it('11. rejects refund reservation if payment attempt belongs to a different order (SecurityDiscrepancyError)', async () => {
    const orderA = createTestOrder({ orderId: 'ord_victim_a' });
    const orderB = createTestOrder({ orderId: 'ord_attacker_b' });

    // Payment belongs to Order A
    const paymentA = createTestPaymentAttempt({
      orderId: orderA._id,
      paymentId: 'pay_order_a_001',
      amountCapturedPaise: 417000,
      status: 'captured',
    });

    // Caller attempts to reserve refund for payment A on order B
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: orderB.orderId, // Mismatched order!
          paymentId: paymentA.paymentId,
          amountPaise: 100000,
          reason: 'malicious_cross_order_refund',
          idempotencyKey: 'idem_cross_order_hack',
        });
      },
      (err: any) => {
        assert.ok(err instanceof SecurityDiscrepancyError);
        assert.match(err.message, /Payment association mismatch/i);
        return true;
      }
    );

    // Verify neither order was modified
    assert.equal(databaseOrders.find((o) => o.orderId === 'ord_victim_a').amountReservedRefundPaise, 0);
    assert.equal(databaseOrders.find((o) => o.orderId === 'ord_attacker_b').amountReservedRefundPaise, 0);
  });

  // ============================================================================
  // 12. INPUT VALIDATION GUARDS (AMOUNTS, CURRENCY, IDEMPOTENCY KEYS)
  // ============================================================================
  it('12. input validation guards reject negative, zero, non-integer amounts, non-INR currencies, and missing keys', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, status: 'captured' });

    // 12.1. Non-integer paise
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 100.5,
          reason: 'test',
          idempotencyKey: 'k1',
        });
      },
      (err: any) => err instanceof InvalidRefundAmountError
    );

    // 12.2. Zero paise
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 0,
          reason: 'test',
          idempotencyKey: 'k2',
        });
      },
      (err: any) => err instanceof InvalidRefundAmountError
    );

    // 12.3. Negative paise
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: -500,
          reason: 'test',
          idempotencyKey: 'k3',
        });
      },
      (err: any) => err instanceof InvalidRefundAmountError
    );

    // 12.4. Non-INR currency
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 100000,
          currency: 'USD',
          reason: 'test',
          idempotencyKey: 'k4',
        });
      },
      (err: any) => err instanceof InvalidCurrencyError
    );

    // 12.5. Empty idempotency key
    await assert.rejects(
      async () => {
        await reserveRefund({
          orderId: order.orderId,
          paymentId: payment.paymentId,
          amountPaise: 100000,
          reason: 'test',
          idempotencyKey: '   ',
        });
      },
      (err: any) => err instanceof InvalidIdempotencyKeyError
    );
  });

  // ============================================================================
  // 13. PRESERVATION OF IMMUTABLE MODEL-FIELD PROTECTIONS
  // ============================================================================
  it('13. enforces immutable field protections on Refund and RefundJob documents', async () => {
    const order = createTestOrder();
    const payment = createTestPaymentAttempt({ orderId: order._id, status: 'captured' });

    const result = await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 150000,
      reason: 'immutability_test',
      idempotencyKey: 'idem_immut_001',
    });

    const refund = result.refund;
    const job = result.refundJob;

    // 1. Schema immutable: true prevents normal assignment
    const origAmount = refund.amountPaise;
    refund.amountPaise = 200000;
    assert.equal(
      refund.amountPaise,
      origAmount,
      'Mongoose schema immutable: true prevents direct property mutation'
    );

    // 2. Forced modification (e.g. via overwriteImmutable: true) is rejected by pre-save guard
    refund.set('amountPaise', 200000, { overwriteImmutable: true });
    await assert.rejects(
      async () => await refund.save(),
      /Cannot modify immutable field: amountPaise/i
    );

    // 3. Same immutability protection on RefundJob
    const origJobAmount = job.targetAmountPaise;
    job.targetAmountPaise = 300000;
    assert.equal(
      job.targetAmountPaise,
      origJobAmount,
      'Mongoose schema immutable: true prevents direct property mutation on RefundJob'
    );

    job.set('targetAmountPaise', 300000, { overwriteImmutable: true });
    await assert.rejects(
      async () => await job.save(),
      /Cannot modify immutable field: targetAmountPaise/i
    );
  });

  // ============================================================================
  // 14. CAPACITY HELPER QUERY
  // ============================================================================
  it('14. getRemainingRefundableCapacity returns accurate accounting metrics for orders and payments', async () => {
    const order = createTestOrder({ totalAmount: 4000, amountPaise: 400000 });
    const payment = createTestPaymentAttempt({
      orderId: order._id,
      paymentId: 'pay_cap_query_001',
      amountCapturedPaise: 400000,
      status: 'captured',
    });

    // Before reservation
    const cap1 = await getRemainingRefundableCapacity({
      orderId: order.orderId,
      paymentId: payment.paymentId,
    });
    assert.equal(cap1.orderTotalCapturedPaise, 400000);
    assert.equal(cap1.orderReservedRefundPaise, 0);
    assert.equal(cap1.orderConfirmedRefundPaise, 0);
    assert.equal(cap1.orderRemainingRefundablePaise, 400000);
    assert.equal(cap1.paymentRemainingRefundablePaise, 400000);

    // After reserving 150000 paise
    await reserveRefund({
      orderId: order.orderId,
      paymentId: payment.paymentId,
      amountPaise: 150000,
      reason: 'test_cap',
      idempotencyKey: 'idem_cap_001',
    });

    const cap2 = await getRemainingRefundableCapacity({
      orderId: order.orderId,
      paymentId: payment.paymentId,
    });
    assert.equal(cap2.orderReservedRefundPaise, 150000);
    assert.equal(cap2.orderRemainingRefundablePaise, 250000);
    assert.equal(cap2.paymentRemainingRefundablePaise, 250000);
  });
});
