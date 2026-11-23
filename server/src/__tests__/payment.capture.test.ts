import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import app from '../app.js';
import { Order } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { PaymentAttempt } from '../models/PaymentAttempt.js';
import { WebhookEvent } from '../models/WebhookEvent.js';
import { setRazorpayClient } from '../config/razorpay.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';
import {
  processPaymentCapture,
  fetchAndVerifyGatewayPayment,
  withPaymentTransaction,
  isTransactionUnsupportedError,
  isTransientTransactionError,
  TransactionSupportError,
  SecurityDiscrepancyError,
  GatewayOrderMismatchError,
  GatewayAmountMismatchError,
  GatewayCurrencyMismatchError,
  PaymentNotCapturedError,
  MissingCanonicalAmountError,
} from '../services/capture.service.js';

// Authenticated test user
const user1 = { id: '6740000000000000000000c1', email: 'user-cap@example.com', role: 'user' as const };
const user2 = { id: '6740000000000000000000c2', email: 'other-cap@example.com', role: 'user' as const };
const tokenUser1 = generateToken(user1);
const tokenUser2 = generateToken(user2);

const mockDroneId = new mongoose.Types.ObjectId('674000000000000000000001');

describe('Payment Capture Processing Comprehensive Test Suite (23 Scenarios)', () => {
  let databaseOrders: any[] = [];
  let databasePaymentAttempts: any[] = [];
  let databaseCarts: any[] = [];
  let databaseWebhookEvents: any[] = [];

  const KEY_SECRET = 'mockCaptureSecret12345';
  const KEY_ID = 'rzp_test_mockCapture12345';
  const WEBHOOK_SECRET = 'mockWebhookCaptureSecret999';

  function generateValidCallbackSignature(rzpOrderId: string, paymentId: string): string {
    return crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');
  }

  function generateValidWebhookSignature(rawBody: string): string {
    return crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
  }

  beforeEach(() => {
    databaseOrders = [];
    databasePaymentAttempts = [];
    databaseCarts = [];
    databaseWebhookEvents = [];

    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    // Default mock Razorpay client
    setRazorpayClient({
      payments: {
        fetch: async (paymentId: string) => {
          const matchingOrder = databaseOrders.find(
            (o) => o.razorpayPaymentId === paymentId || o.razorpayOrderId
          );
          return {
            id: paymentId,
            entity: 'payment',
            amount: matchingOrder ? (matchingOrder.amountPaise || Math.round(matchingOrder.totalAmount * 100)) : 417000,
            currency: 'INR',
            status: 'captured',
            order_id: matchingOrder ? matchingOrder.razorpayOrderId : 'order_rzp_default_123',
            method: 'upi',
            captured: true,
          };
        },
      },
    } as any);

    // Mock Order methods
    Order.findOne = (async (query: any) => {
      return (
        databaseOrders.find((doc) => {
          let matches = true;
          if (query._id && doc._id.toString() !== query._id.toString()) matches = false;
          if (query.orderId && doc.orderId !== query.orderId) matches = false;
          if (query.userId && doc.userId.toString() !== query.userId.toString()) matches = false;
          if (query.razorpayOrderId && doc.razorpayOrderId !== query.razorpayOrderId) matches = false;
          return matches;
        }) || null
      );
    }) as any;

    Order.findById = (async (id: any) => {
      const targetId = id?.toString?.() || id;
      const found = databaseOrders.find((doc) => doc._id?.toString() === targetId);
      if (!found) return null;
      // Return a working copy so aborts before save() don't corrupt database state
      const copy = new Order(found.toObject ? found.toObject() : JSON.parse(JSON.stringify(found)));
      copy._id = found._id;
      copy.session = function () { return this; };
      return copy;
    }) as any;

    Order.prototype.save = async function () {
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

    PaymentAttempt.create = (async (docs: any, options?: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        const existing = databasePaymentAttempts.find((p) => p.paymentId === d.paymentId);
        if (existing) {
          const err: any = new Error(
            `E11000 duplicate key error collection: project_world.paymentattempts index: paymentId_1 dup key: { paymentId: "${d.paymentId}" }`
          );
          err.code = 11000;
          throw err;
        }
      }
      const created = arr.map((d: any) => {
        const item = {
          ...d,
          _id: d._id || new mongoose.Types.ObjectId(),
          save: async function () {
            const idx = databasePaymentAttempts.findIndex((p) => p.paymentId === this.paymentId);
            if (idx >= 0) databasePaymentAttempts[idx] = this;
            else databasePaymentAttempts.push(this);
            return this;
          },
        };
        return item;
      });
      databasePaymentAttempts.push(...created);
      return Array.isArray(docs) ? created : created[0];
    }) as any;

    // Mock WebhookEvent methods
    WebhookEvent.findOne = (async (query: any) => {
      return databaseWebhookEvents.find((doc) => doc.eventId === query.eventId) || null;
    }) as any;

    WebhookEvent.create = (async (docs: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        if (databaseWebhookEvents.some((w) => w.eventId === d.eventId)) {
          const dupError: any = new Error(
            `E11000 duplicate key error collection: webhookevents index: eventId_1 dup key: { eventId: "${d.eventId}" }`
          );
          dupError.code = 11000;
          throw dupError;
        }
      }

      const created = arr.map((d: any) => ({
        ...d,
        _id: d._id || new mongoose.Types.ObjectId(),
        save: async function () {
          const idx = databaseWebhookEvents.findIndex((w) => w.eventId === this.eventId);
          if (idx >= 0) databaseWebhookEvents[idx] = this;
          else databaseWebhookEvents.push(this);
          return this;
        },
      }));
      databaseWebhookEvents.push(...created);
      return Array.isArray(docs) ? created : created[0];
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

    // Mock Cart methods
    Cart.findOne = (async (query: any) => {
      const found = databaseCarts.find(
        (c) => c.user && query.user && c.user.toString() === query.user.toString()
      );
      return found || null;
    }) as any;
  });

  function createTestOrder(overrides: Partial<any> = {}) {
    const totalAmount = overrides.totalAmount !== undefined ? overrides.totalAmount : 4170;
    const amountPaise = overrides.amountPaise !== undefined ? overrides.amountPaise : 417000;

    const order = new Order({
      orderId: overrides.orderId || 'ord_capture_test_1',
      receipt: overrides.receipt || 'rcpt_capture_test_1',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount,
      amountPaise,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: overrides.razorpayOrderId || 'order_rzp_capture_1',
      idempotencyKey: overrides.idempotencyKey || 'idemp_cap_1',
      purchaseCapturedPaise: 0,
      duplicateCapturedPaise: 0,
      totalCapturedPaise: 0,
      refundedAmountPaise: 0,
      cartReconciled: false,
      webhookEventsProcessed: [],
      ...overrides,
    });
    // Ensure amountPaise override is respected even if undefined was explicitly passed
    if ('amountPaise' in overrides) {
      order.amountPaise = overrides.amountPaise;
    }
    databaseOrders.push(order);
    return order;
  }

  // ============================================================================
  // SCENARIO 1: Valid captured payment via callback marks order completed,
  // records primary PaymentAttempt, and populates order accounting.
  // ============================================================================
  it('1. valid captured payment via callback marks order completed, records primary PaymentAttempt, and populates order accounting', async () => {
    const rzpOrderId = 'order_rzp_s1';
    const paymentId = 'pay_rzp_s1';
    const testOrder = createTestOrder({ orderId: 'ord_s1', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          method: 'upi',
          captured: true,
        }),
      },
    } as any);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order.status, 'completed');
    assert.equal(res.body.order.paymentStatus, 'captured');

    // Verify order document accounting
    const updatedOrder = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(updatedOrder.status, 'completed');
    assert.equal(updatedOrder.paymentStatus, 'captured');
    assert.equal(updatedOrder.primaryPaymentId, paymentId);
    assert.equal(updatedOrder.purchaseCapturedPaise, 417000);
    assert.equal(updatedOrder.duplicateCapturedPaise, 0);
    assert.equal(updatedOrder.totalCapturedPaise, 417000);
    assert.ok(updatedOrder.paidAt);

    // Verify PaymentAttempt
    assert.equal(databasePaymentAttempts.length, 1);
    const attempt = databasePaymentAttempts[0];
    assert.equal(attempt.paymentId, paymentId);
    assert.equal(attempt.orderId.toString(), updatedOrder._id.toString());
    assert.equal(attempt.classification, 'primary');
    assert.equal(attempt.status, 'captured');
    assert.equal(attempt.amountCapturedPaise, 417000);
    assert.equal(attempt.currency, 'INR');
  });

  // ============================================================================
  // SCENARIO 2: Callback with invalid signature is rejected and does not mutate order state
  // ============================================================================
  it('2. callback with invalid signature is rejected and does not mutate order state', async () => {
    const rzpOrderId = 'order_rzp_s2';
    const paymentId = 'pay_rzp_s2';
    const testOrder = createTestOrder({ orderId: 'ord_s2', razorpayOrderId: rzpOrderId });

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: 'invalid_tampered_signature_hex',
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /invalid payment signature/i);

    // Verify order was not modified
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(orderDoc.status, 'pending');
    assert.equal(orderDoc.paymentStatus, 'created');
    assert.equal(orderDoc.totalCapturedPaise, 0);
    assert.equal(orderDoc.primaryPaymentId, undefined);
    assert.equal(databasePaymentAttempts.length, 0);
  });

  // ============================================================================
  // SCENARIO 3: Callback or webhook with payment not actually captured is rejected
  // ============================================================================
  it('3. callback or webhook with payment not actually captured (authorized or failed) is rejected and does not mark order completed', async () => {
    const rzpOrderId = 'order_rzp_s3';
    const paymentId = 'pay_rzp_s3';
    const testOrder = createTestOrder({ orderId: 'ord_s3', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    // Gateway reports status is 'authorized', NOT 'captured'
    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'authorized', // Not captured!
          order_id: rzpOrderId,
          captured: false,
        }),
      },
    } as any);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /not "captured"/i);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
    assert.equal(orderDoc.totalCapturedPaise, 0);
  });

  // ============================================================================
  // SCENARIO 4: Callback or webhook where gateway payment belongs to a different
  // Razorpay order ID is rejected
  // ============================================================================
  it('4. callback or webhook where gateway payment belongs to a different Razorpay order ID is rejected', async () => {
    const rzpOrderId = 'order_rzp_s4_expected';
    const paymentId = 'pay_rzp_s4';
    const testOrder = createTestOrder({ orderId: 'ord_s4', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    // Gateway reports payment belongs to a different order
    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: 'order_rzp_s4_DIFFERENT', // Mismatch!
          captured: true,
        }),
      },
    } as any);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /gateway order id mismatch/i);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
    assert.equal(orderDoc.totalCapturedPaise, 0);
  });

  // ============================================================================
  // SCENARIO 5: Callback or webhook where gateway payment amount does not match
  // expected integer paise is rejected
  // ============================================================================
  it('5. callback or webhook where gateway payment amount does not match expected integer paise is rejected', async () => {
    const rzpOrderId = 'order_rzp_s5';
    const paymentId = 'pay_rzp_s5';
    const testOrder = createTestOrder({ orderId: 'ord_s5', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    // Gateway reports underpaid amount (100000 paise instead of 417000)
    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 100000, // Underpayment!
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          captured: true,
        }),
      },
    } as any);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /amount or currency mismatch/i);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
    assert.equal(orderDoc.totalCapturedPaise, 0);
  });

  // ============================================================================
  // SCENARIO 6: Callback or webhook where gateway currency is not INR is rejected
  // ============================================================================
  it('6. callback or webhook where gateway currency is not INR is rejected', async () => {
    const rzpOrderId = 'order_rzp_s6';
    const paymentId = 'pay_rzp_s6';
    const testOrder = createTestOrder({ orderId: 'ord_s6', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    // Gateway reports USD currency instead of INR
    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'USD', // Non-INR!
          status: 'captured',
          order_id: rzpOrderId,
          captured: true,
        }),
      },
    } as any);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /amount or currency mismatch/i);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
  });

  // ============================================================================
  // SCENARIO 7: Callback or webhook attempting to associate a payment ID already
  // linked to a different internal order is rejected with security discrepancy
  // ============================================================================
  it('7. callback or webhook attempting to associate a payment ID already linked to a different internal order is rejected with security discrepancy', async () => {
    const orderA = createTestOrder({ orderId: 'ord_s7_A', razorpayOrderId: 'order_rzp_s7_A' });
    const orderB = createTestOrder({ orderId: 'ord_s7_B', razorpayOrderId: 'order_rzp_s7_B' });
    const stolenPaymentId = 'pay_shared_across_orders';

    // Existing PaymentAttempt is already linked to orderA
    databasePaymentAttempts.push({
      _id: new mongoose.Types.ObjectId(),
      paymentId: stolenPaymentId,
      orderId: orderA._id,
      razorpayOrderId: 'order_rzp_s7_A',
      amountCapturedPaise: 417000,
      currency: 'INR',
      status: 'captured',
      classification: 'primary',
      save: async function () { return this; },
    });

    // Callback arrives claiming this same paymentId belongs to orderB
    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: orderB.razorpayOrderId,
          captured: true,
        }),
      },
    } as any);

    await assert.rejects(
      async () => {
        await processPaymentCapture({
          paymentId: stolenPaymentId,
          orderId: orderB.orderId,
          razorpayOrderId: orderB.razorpayOrderId,
          amountPaise: 417000,
          currency: 'INR',
          source: 'callback',
        });
      },
      (err: any) => {
        assert.ok(err instanceof SecurityDiscrepancyError);
        assert.match(err.message, /already associated with internal order/i);
        return true;
      }
    );

    // Ensure Order B was NOT marked captured or completed
    assert.equal(orderB.status, 'pending');
    assert.equal(orderB.totalCapturedPaise, 0);
  });

  // ============================================================================
  // SCENARIO 8: Repeated callback for the same payment is idempotent and does not
  // increment financial counters twice
  // ============================================================================
  it('8. repeated callback for the same payment is idempotent and does not increment financial counters twice', async () => {
    const rzpOrderId = 'order_rzp_s8';
    const paymentId = 'pay_rzp_s8';
    const testOrder = createTestOrder({ orderId: 'ord_s8', razorpayOrderId: rzpOrderId });
    const signature = generateValidCallbackSignature(rzpOrderId, paymentId);

    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          captured: true,
        }),
      },
    } as any);

    // Delivery 1
    const res1 = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });
    assert.equal(res1.status, 200);

    // Delivery 2 (user double clicks or network retry)
    const res2 = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .send({
        orderId: testOrder.orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });
    assert.equal(res2.status, 200);

    // Financial counters must NOT be doubled
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(orderDoc.purchaseCapturedPaise, 417000);
    assert.equal(orderDoc.duplicateCapturedPaise, 0);
    assert.equal(orderDoc.totalCapturedPaise, 417000); // NOT 834000!
    assert.equal(databasePaymentAttempts.length, 1);
  });

  // ============================================================================
  // SCENARIO 9: Repeated webhook for the same payment is idempotent and does not
  // increment financial counters twice
  // ============================================================================
  it('9. repeated webhook for the same payment is idempotent and does not increment financial counters twice', async () => {
    const rzpOrderId = 'order_rzp_s9';
    const paymentId = 'pay_rzp_s9';
    const testOrder = createTestOrder({ orderId: 'ord_s9', razorpayOrderId: rzpOrderId });

    setRazorpayClient({
      payments: {
        fetch: async (id: string) => ({
          id,
          entity: 'payment',
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          captured: true,
        }),
      },
    } as any);

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateValidWebhookSignature(rawBody);

    // 1st Webhook delivery
    const res1 = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', 'evt_s9_1')
      .send(rawBody);
    assert.equal(res1.status, 200);

    // 2nd Webhook delivery (Razorpay retry)
    const res2 = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', 'evt_s9_2') // different event id, same payment
      .send(rawBody);
    assert.equal(res2.status, 200);
    assert.match(res2.body.message, /already processed/i);

    // Verify financial counters are clean
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(orderDoc.purchaseCapturedPaise, 417000);
    assert.equal(orderDoc.duplicateCapturedPaise, 0);
    assert.equal(orderDoc.totalCapturedPaise, 417000);
    assert.equal(databasePaymentAttempts.length, 1);
  });

  // ============================================================================
  // SCENARIO 10: Callback and webhook processing the same payment concurrently
  // both succeed safely with exactly one primary PaymentAttempt and consistent final order state
  // ============================================================================
  it('10. callback and webhook processing the same payment concurrently both succeed safely with exactly one primary PaymentAttempt', async () => {
    const rzpOrderId = 'order_rzp_s10';
    const paymentId = 'pay_rzp_s10';
    const testOrder = createTestOrder({ orderId: 'ord_s10', razorpayOrderId: rzpOrderId });

    const gatewayPayment = {
      id: paymentId,
      entity: 'payment',
      amount: 417000,
      currency: 'INR',
      status: 'captured',
      order_id: rzpOrderId,
      captured: true,
    };

    // Concurrently trigger capture via callback and webhook
    const [result1, result2] = await Promise.all([
      processPaymentCapture({
        paymentId,
        orderId: testOrder.orderId,
        razorpayOrderId: rzpOrderId,
        amountPaise: 417000,
        currency: 'INR',
        source: 'callback',
        verifiedGatewayPayment: gatewayPayment,
      }),
      processPaymentCapture({
        paymentId,
        orderId: testOrder.orderId,
        razorpayOrderId: rzpOrderId,
        amountPaise: 417000,
        currency: 'INR',
        eventId: 'evt_concurrent_s10',
        source: 'webhook',
        verifiedGatewayPayment: gatewayPayment,
      }),
    ]);

    // Exactly one was the primary capture, and the other was an idempotent duplicate
    const duplicateDeliveryCount = [result1.duplicateDelivery, result2.duplicateDelivery].filter(Boolean).length;
    assert.equal(duplicateDeliveryCount, 1);

    // Final order state is strictly consistent
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(orderDoc.status, 'completed');
    assert.equal(orderDoc.paymentStatus, 'captured');
    assert.equal(orderDoc.purchaseCapturedPaise, 417000);
    assert.equal(orderDoc.duplicateCapturedPaise, 0);
    assert.equal(orderDoc.totalCapturedPaise, 417000);
    assert.equal(orderDoc.totalCapturedPaise, orderDoc.purchaseCapturedPaise + orderDoc.duplicateCapturedPaise);

    // Exactly one PaymentAttempt exists
    assert.equal(databasePaymentAttempts.length, 1);
    assert.equal(databasePaymentAttempts[0].classification, 'primary');
  });

  // ============================================================================
  // SCENARIO 11: Two distinct payment IDs captured for the same order concurrently:
  // one becomes primary, the second is safely classified as duplicate, and financial counters match
  // ============================================================================
  it('11. two distinct payment IDs captured for the same order concurrently: one primary, one duplicate charge, invariant holds', async () => {
    const rzpOrderId = 'order_rzp_s11';
    const pay1 = 'pay_distinct_alpha_1';
    const pay2 = 'pay_distinct_beta_2';
    const testOrder = createTestOrder({ orderId: 'ord_s11', razorpayOrderId: rzpOrderId });

    // Mock PaymentAttempt.create to simulate the unique index on { orderId: 1, classification: 'primary' }
    const originalCreate = PaymentAttempt.create;
    PaymentAttempt.create = (async (docs: any, options?: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        if (d.classification === 'primary') {
          const hasPrimary = databasePaymentAttempts.some(
            (p) => p.orderId.toString() === d.orderId.toString() && p.classification === 'primary'
          );
          if (hasPrimary) {
            const err: any = new Error(
              'E11000 duplicate key error collection: project_world.paymentattempts index: orderId_1_classification_1 dup key'
            );
            err.code = 11000;
            throw err;
          }
        }
      }
      return originalCreate(docs, options);
    }) as any;

    try {
      const [res1, res2] = await Promise.all([
        processPaymentCapture({
          paymentId: pay1,
          orderId: testOrder.orderId,
          razorpayOrderId: rzpOrderId,
          amountPaise: 417000,
          currency: 'INR',
          source: 'callback',
          verifiedGatewayPayment: {
            id: pay1,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
          },
        }),
        processPaymentCapture({
          paymentId: pay2,
          orderId: testOrder.orderId,
          razorpayOrderId: rzpOrderId,
          amountPaise: 417000,
          currency: 'INR',
          source: 'webhook',
          verifiedGatewayPayment: {
            id: pay2,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
          },
        }),
      ]);

      const classifications = [res1.classification, res2.classification].sort();
      assert.deepEqual(classifications, ['duplicate_charge', 'primary']);

      const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
      assert.equal(orderDoc.status, 'completed');
      assert.equal(orderDoc.paymentStatus, 'duplicate_charge_detected');
      assert.equal(orderDoc.purchaseCapturedPaise, 417000);
      assert.equal(orderDoc.duplicateCapturedPaise, 417000);
      assert.equal(orderDoc.totalCapturedPaise, 834000);
      // Invariant check
      assert.equal(orderDoc.totalCapturedPaise, orderDoc.purchaseCapturedPaise + orderDoc.duplicateCapturedPaise);

      // Verify attempts
      assert.equal(databasePaymentAttempts.length, 2);
      const primaryAttempt = databasePaymentAttempts.find((p) => p.classification === 'primary');
      const dupAttempt = databasePaymentAttempts.find((p) => p.classification === 'duplicate_charge');
      assert.ok(primaryAttempt);
      assert.ok(dupAttempt);
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 12: Duplicate capture correctly sets duplicate_charge_detected and
  // increments duplicateCapturedPaise without overwriting primaryPaymentId or purchaseCapturedPaise
  // ============================================================================
  it('12. duplicate capture correctly sets duplicate_charge_detected and increments duplicateCapturedPaise without overwriting primaryPaymentId', async () => {
    const rzpOrderId = 'order_rzp_s12';
    const primaryPayId = 'pay_primary_orig_12';
    const duplicatePayId = 'pay_duplicate_second_12';

    // Order was already completed with primaryPayId
    const testOrder = createTestOrder({
      orderId: 'ord_s12',
      razorpayOrderId: rzpOrderId,
      status: 'completed',
      paymentStatus: 'captured',
      primaryPaymentId: primaryPayId,
      razorpayPaymentId: primaryPayId,
      purchaseCapturedPaise: 417000,
      totalCapturedPaise: 417000,
      duplicateCapturedPaise: 0,
      paidAt: new Date(Date.now() - 60000),
    });

    databasePaymentAttempts.push({
      _id: new mongoose.Types.ObjectId(),
      paymentId: primaryPayId,
      orderId: testOrder._id,
      razorpayOrderId: rzpOrderId,
      amountCapturedPaise: 417000,
      currency: 'INR',
      status: 'captured',
      classification: 'primary',
      save: async function () { return this; },
    });

    // Duplicate capture arrives
    const res = await processPaymentCapture({
      paymentId: duplicatePayId,
      orderId: testOrder.orderId,
      razorpayOrderId: rzpOrderId,
      amountPaise: 417000,
      currency: 'INR',
      source: 'webhook',
      verifiedGatewayPayment: {
        id: duplicatePayId,
        amount: 417000,
        currency: 'INR',
        status: 'captured',
        order_id: rzpOrderId,
      },
    });

    assert.equal(res.classification, 'duplicate_charge');
    assert.equal(res.wasLateCapture, false);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    // primaryPaymentId and purchaseCapturedPaise are completely preserved
    assert.equal(orderDoc.primaryPaymentId, primaryPayId);
    assert.equal(orderDoc.purchaseCapturedPaise, 417000);
    // duplicate tracking is correctly updated
    assert.equal(orderDoc.duplicateCapturedPaise, 417000);
    assert.equal(orderDoc.totalCapturedPaise, 834000);
    assert.equal(orderDoc.paymentStatus, 'duplicate_charge_detected');
    assert.equal(orderDoc.status, 'completed'); // not downgraded or mutated
    assert.equal(orderDoc.totalCapturedPaise, orderDoc.purchaseCapturedPaise + orderDoc.duplicateCapturedPaise);
  });

  // ============================================================================
  // SCENARIO 13: Late capture arriving for an already cancelled or refunded order is
  // recorded as compensation, increments duplicateCapturedPaise, does not resurrect order
  // ============================================================================
  it('13a. late capture on cancelled order is recorded as compensation and does not resurrect order to completed', async () => {
    const rzpOrderId = 'order_rzp_s13_cancelled';
    const latePayId = 'pay_late_for_cancelled';

    // Order was cancelled
    const testOrder = createTestOrder({
      orderId: 'ord_s13_can',
      razorpayOrderId: rzpOrderId,
      status: 'cancelled',
      paymentStatus: 'failed',
      purchaseCapturedPaise: 0,
      duplicateCapturedPaise: 0,
      totalCapturedPaise: 0,
    });

    const res = await processPaymentCapture({
      paymentId: latePayId,
      orderId: testOrder.orderId,
      razorpayOrderId: rzpOrderId,
      amountPaise: 417000,
      currency: 'INR',
      source: 'webhook',
      verifiedGatewayPayment: {
        id: latePayId,
        amount: 417000,
        currency: 'INR',
        status: 'captured',
        order_id: rzpOrderId,
      },
    });

    assert.equal(res.classification, 'compensation');
    assert.equal(res.wasLateCapture, true);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    // CRITICAL: Order MUST remain cancelled! NEVER resurrected to completed!
    assert.equal(orderDoc.status, 'cancelled');
    assert.equal(orderDoc.paymentStatus, 'duplicate_charge_detected');
    assert.equal(orderDoc.duplicateCapturedPaise, 417000);
    assert.equal(orderDoc.purchaseCapturedPaise, 0);
    assert.equal(orderDoc.totalCapturedPaise, 417000);
    assert.equal(orderDoc.totalCapturedPaise, orderDoc.purchaseCapturedPaise + orderDoc.duplicateCapturedPaise);
  });

  it('13b. late capture on refunded order is recorded as compensation and does not alter primaryPaymentId or resurrect order', async () => {
    const rzpOrderId = 'order_rzp_s13_refunded';
    const origPayId = 'pay_orig_refunded_13';
    const latePayId = 'pay_late_for_refunded_13';

    // Order was refunded
    const testOrder = createTestOrder({
      orderId: 'ord_s13_ref',
      razorpayOrderId: rzpOrderId,
      status: 'refunded',
      paymentStatus: 'refunded',
      primaryPaymentId: origPayId,
      razorpayPaymentId: origPayId,
      purchaseCapturedPaise: 417000,
      totalCapturedPaise: 417000,
      duplicateCapturedPaise: 0,
      refundedAmountPaise: 417000,
    });

    const res = await processPaymentCapture({
      paymentId: latePayId,
      orderId: testOrder.orderId,
      razorpayOrderId: rzpOrderId,
      amountPaise: 417000,
      currency: 'INR',
      source: 'webhook',
      verifiedGatewayPayment: {
        id: latePayId,
        amount: 417000,
        currency: 'INR',
        status: 'captured',
        order_id: rzpOrderId,
      },
    });

    assert.equal(res.classification, 'compensation');
    assert.equal(res.wasLateCapture, true);

    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.equal(orderDoc.status, 'refunded'); // Not completed!
    assert.equal(orderDoc.primaryPaymentId, origPayId); // preserved!
    assert.equal(orderDoc.duplicateCapturedPaise, 417000);
    assert.equal(orderDoc.totalCapturedPaise, 834000);
    assert.equal(orderDoc.totalCapturedPaise, orderDoc.purchaseCapturedPaise + orderDoc.duplicateCapturedPaise);
  });

  // ============================================================================
  // SCENARIO 14: Capture transaction fails safely when transactions are not supported
  // or when an invariant is violated, rolling back or aborting cleanly
  // ============================================================================
  it('14a. isTransactionUnsupportedError correctly detects standalone replica set failure', () => {
    assert.equal(
      isTransactionUnsupportedError(new Error('Transaction numbers are only allowed on a replica set member or mongos')),
      true
    );
    assert.equal(
      isTransactionUnsupportedError({ code: 20, message: 'IllegalOperation' }),
      true
    );
    assert.equal(
      isTransactionUnsupportedError(new Error('Generic network timeout')),
      false
    );
  });

  it('14b. withPaymentTransaction throws TransactionSupportError when replica set is unavailable', async () => {
    // Mock mongoose.connection to simulate live connection without replica set
    const originalReadyState = mongoose.connection.readyState;
    const originalStartSession = mongoose.startSession;

    try {
      (mongoose.connection as any).readyState = 1;
      mongoose.startSession = async () => {
        throw new Error('Transaction numbers are only allowed on a replica set member or mongos');
      };

      await assert.rejects(
        async () => {
          await withPaymentTransaction(async () => {
            return 'should_not_run';
          });
        },
        (err: any) => {
          assert.ok(err instanceof TransactionSupportError);
          assert.match(err.message, /does not support replica set transactions/i);
          return true;
        }
      );
    } finally {
      (mongoose.connection as any).readyState = originalReadyState;
      mongoose.startSession = originalStartSession;
    }
  });

  it('14c. invariant violation inside capture transaction cleanly aborts without committing partial state', async () => {
    const rzpOrderId = 'order_rzp_s14c';
    const payId = 'pay_rzp_s14c';
    const testOrder = createTestOrder({ orderId: 'ord_s14c', razorpayOrderId: rzpOrderId });

    // Intentionally corrupt initial order counters to violate financial invariant
    testOrder.totalCapturedPaise = 999999; // Corrupted, not 0!

    await assert.rejects(
      async () => {
        await processPaymentCapture({
          paymentId: payId,
          orderId: testOrder.orderId,
          razorpayOrderId: rzpOrderId,
          amountPaise: 417000,
          currency: 'INR',
          source: 'callback',
          verifiedGatewayPayment: {
            id: payId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
          },
        });
      },
      (err: any) => {
        assert.match(err.message, /Financial invariant failure/i);
        return true;
      }
    );

    // Order must NOT have been saved as completed
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
  });

  // ============================================================================
  // SCENARIO 15: PaymentAttempt duplicate-key error (E11000) during concurrent insert
  // is handled gracefully by re-querying existing attempt and returning idempotent success
  // ============================================================================
  it('15. PaymentAttempt duplicate-key error (E11000) during concurrent insert returns idempotent success', async () => {
    const rzpOrderId = 'order_rzp_s15';
    const paymentId = 'pay_rzp_s15';
    const testOrder = createTestOrder({ orderId: 'ord_s15', razorpayOrderId: rzpOrderId });

    let createCalls = 0;
    const originalCreate = PaymentAttempt.create;

    // Simulate concurrent worker having inserted the PaymentAttempt right before our insert
    PaymentAttempt.create = (async (docs: any, options?: any) => {
      createCalls++;
      // Pre-insert the record into DB as if another concurrent thread just finished it
      databasePaymentAttempts.push({
        _id: new mongoose.Types.ObjectId(),
        paymentId,
        orderId: testOrder._id,
        razorpayOrderId: rzpOrderId,
        amountCapturedPaise: 417000,
        currency: 'INR',
        status: 'captured',
        classification: 'primary',
        save: async function () { return this; },
      });
      // Throw E11000 Duplicate Key Error on paymentId unique index
      const err: any = new Error(
        `E11000 duplicate key error collection: project_world.paymentattempts index: paymentId_1 dup key: { paymentId: "${paymentId}" }`
      );
      err.code = 11000;
      throw err;
    }) as any;

    try {
      const res = await processPaymentCapture({
        paymentId,
        orderId: testOrder.orderId,
        razorpayOrderId: rzpOrderId,
        amountPaise: 417000,
        currency: 'INR',
        source: 'webhook',
        verifiedGatewayPayment: {
          id: paymentId,
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
        },
      });

      assert.equal(createCalls, 1);
      assert.equal(res.duplicateDelivery, true);
      assert.equal(res.classification, 'primary');
      assert.equal(res.attempt.paymentId, paymentId);
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 16: E11000 recovery on paymentId verifies all identity fields
  // and rejects tampered recovery data with SecurityDiscrepancyError
  // ============================================================================
  it('16. E11000 recovery verifies all identity fields and rejects tampered recovery data with SecurityDiscrepancyError', async () => {
    const rzpOrderId = 'order_rzp_s16';
    const paymentId = 'pay_rzp_s16';
    const testOrder = createTestOrder({ orderId: 'ord_s16', razorpayOrderId: rzpOrderId });

    const originalCreate = PaymentAttempt.create;

    // Simulate an attempt in the DB with tampered amount (e.g. 50000 instead of 417000)
    PaymentAttempt.create = (async () => {
      databasePaymentAttempts.push({
        _id: new mongoose.Types.ObjectId(),
        paymentId,
        orderId: testOrder._id,
        razorpayOrderId: rzpOrderId,
        amountCapturedPaise: 50000, // Tampered amount!
        currency: 'INR',
        status: 'captured',
        classification: 'primary',
        save: async function () { return this; },
      });
      const err: any = new Error(
        `E11000 duplicate key error collection: project_world.paymentattempts index: paymentId_1 dup key: { paymentId: "${paymentId}" }`
      );
      err.code = 11000;
      throw err;
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await processPaymentCapture({
            paymentId,
            orderId: testOrder.orderId,
            razorpayOrderId: rzpOrderId,
            amountPaise: 417000,
            currency: 'INR',
            source: 'webhook',
            verifiedGatewayPayment: {
              id: paymentId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              order_id: rzpOrderId,
            },
          });
        },
        (err: any) => {
          assert.ok(err instanceof SecurityDiscrepancyError);
          assert.match(err.message, /Amount mismatch on recovery/i);
          return true;
        }
      );
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 17: Unrelated duplicate key error is re-thrown and not swallowed
  // ============================================================================
  it('17. unrelated duplicate key error is re-thrown and not swallowed as duplicate delivery', async () => {
    const rzpOrderId = 'order_rzp_s17';
    const paymentId = 'pay_rzp_s17';
    const testOrder = createTestOrder({ orderId: 'ord_s17', razorpayOrderId: rzpOrderId });

    const originalCreate = PaymentAttempt.create;

    // Simulate E11000 on an unexpected/unrelated index where no matching paymentId exists
    PaymentAttempt.create = (async () => {
      const err: any = new Error(
        'E11000 duplicate key error collection: project_world.paymentattempts index: custom_unrelated_index_1 dup key'
      );
      err.code = 11000;
      throw err;
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await processPaymentCapture({
            paymentId,
            orderId: testOrder.orderId,
            razorpayOrderId: rzpOrderId,
            amountPaise: 417000,
            currency: 'INR',
            source: 'webhook',
            verifiedGatewayPayment: {
              id: paymentId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              order_id: rzpOrderId,
            },
          });
        },
        (err: any) => {
          assert.equal(err.code, 11000);
          assert.match(err.message, /custom_unrelated_index_1/i);
          return true;
        }
      );
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 18: Primary unique index collision safely re-reads the committed order
  // and reclassifies as duplicate charge
  // ============================================================================
  it('18. primary unique index collision safely re-reads the committed order and reclassifies as duplicate charge', async () => {
    const rzpOrderId = 'order_rzp_s18';
    const primaryPayId = 'pay_winner_18';
    const loserPayId = 'pay_loser_18';
    const testOrder = createTestOrder({ orderId: 'ord_s18', razorpayOrderId: rzpOrderId });

    const originalCreate = PaymentAttempt.create;

    // Simulate concurrent worker having won the primary slot right before loser creates attempt
    PaymentAttempt.create = (async (docs: any, options?: any) => {
      const doc = Array.isArray(docs) ? docs[0] : docs;
      if (doc.classification === 'primary') {
        // Winning worker commits primary payment on order and inserts attempt
        testOrder.primaryPaymentId = primaryPayId;
        testOrder.purchaseCapturedPaise = 417000;
        testOrder.totalCapturedPaise = 417000;
        testOrder.status = 'completed';
        testOrder.paymentStatus = 'captured';

        databasePaymentAttempts.push({
          _id: new mongoose.Types.ObjectId(),
          paymentId: primaryPayId,
          orderId: testOrder._id,
          razorpayOrderId: rzpOrderId,
          amountCapturedPaise: 417000,
          currency: 'INR',
          status: 'captured',
          classification: 'primary',
          save: async function () { return this; },
        });

        const err: any = new Error(
          'E11000 duplicate key error collection: project_world.paymentattempts index: orderId_1_classification_1 dup key'
        );
        err.code = 11000;
        throw err;
      }
      return originalCreate(docs, options);
    }) as any;

    try {
      const res = await processPaymentCapture({
        paymentId: loserPayId,
        orderId: testOrder.orderId,
        razorpayOrderId: rzpOrderId,
        amountPaise: 417000,
        currency: 'INR',
        source: 'callback',
        verifiedGatewayPayment: {
          id: loserPayId,
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
        },
      });

      assert.equal(res.classification, 'duplicate_charge');
      assert.equal(res.duplicateDelivery, false);

      const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
      assert.equal(orderDoc.primaryPaymentId, primaryPayId); // Preserved from winner!
      assert.equal(orderDoc.purchaseCapturedPaise, 417000);
      assert.equal(orderDoc.duplicateCapturedPaise, 417000);
      assert.equal(orderDoc.totalCapturedPaise, 834000);
      assert.equal(orderDoc.paymentStatus, 'duplicate_charge_detected');
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 19: Transient transaction write conflict triggers bounded retries
  // in withPaymentTransaction and succeeds on retry
  // ============================================================================
  it('19. transient transaction write conflict triggers bounded retries and succeeds', async () => {
    let callCount = 0;
    const writeConflictErr: any = new Error('WriteConflict: operation was aborted due to concurrent transaction conflict');
    writeConflictErr.code = 112;

    const result = await withPaymentTransaction(async () => {
      callCount++;
      if (callCount < 3) {
        throw writeConflictErr; // Fail on attempts 1 and 2
      }
      return 'success_after_retry';
    });

    assert.equal(result, 'success_after_retry');
    assert.equal(callCount, 3);
  });

  // ============================================================================
  // SCENARIO 20: Canonical persisted integer-paise amount is verified strictly
  // ============================================================================
  it('20. canonical persisted amountPaise from Order is verified strictly without floating point drift', async () => {
    const rzpOrderId = 'order_rzp_s20';
    const payId = 'pay_rzp_s20';
    const testOrder = createTestOrder({
      orderId: 'ord_s20',
      razorpayOrderId: rzpOrderId,
      totalAmount: 4170.0,
      amountPaise: 417000, // Explicitly persisted integer paise
    });

    // Valid integer match
    const validRes = await processPaymentCapture({
      paymentId: payId,
      orderId: testOrder.orderId,
      razorpayOrderId: rzpOrderId,
      amountPaise: 417000,
      currency: 'INR',
      source: 'callback',
      verifiedGatewayPayment: {
        id: payId,
        amount: 417000,
        currency: 'INR',
        status: 'captured',
        order_id: rzpOrderId,
      },
    });
    assert.equal(validRes.classification, 'primary');
    assert.equal(validRes.order.totalCapturedPaise, 417000);

    // Mismatched paise by just 1 paisa (417001)
    const payMismatch = 'pay_rzp_s20_mismatch';
    await assert.rejects(
      async () => {
        await processPaymentCapture({
          paymentId: payMismatch,
          orderId: testOrder.orderId,
          razorpayOrderId: rzpOrderId,
          amountPaise: 417001,
          currency: 'INR',
          source: 'callback',
          verifiedGatewayPayment: {
            id: payMismatch,
            amount: 417001, // 1 paisa drift!
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
          },
        });
      },
      (err: any) => {
        assert.ok(err instanceof GatewayAmountMismatchError);
        assert.match(err.message, /Payment amount or currency mismatch/i);
        return true;
      }
    );
  });

  // ============================================================================
  // SCENARIO 21: Capture fails safely if an existing order lacks amountPaise;
  // does NOT silently fall back to totalAmount
  // ============================================================================
  it('21. capture fails safely with MissingCanonicalAmountError if order lacks amountPaise without falling back to totalAmount', async () => {
    const rzpOrderId = 'order_rzp_s21_no_amount_paise';
    const payId = 'pay_rzp_s21';
    const testOrder = createTestOrder({
      orderId: 'ord_s21_legacy',
      razorpayOrderId: rzpOrderId,
      totalAmount: 4170.0,
    });
    // Deliberately strip amountPaise to simulate a legacy/corrupted document
    (testOrder as any).amountPaise = undefined;

    await assert.rejects(
      async () => {
        await processPaymentCapture({
          paymentId: payId,
          orderId: testOrder.orderId,
          razorpayOrderId: rzpOrderId,
          amountPaise: 417000,
          currency: 'INR',
          source: 'callback',
          verifiedGatewayPayment: {
            id: payId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
          },
        });
      },
      (err: any) => {
        assert.ok(err instanceof MissingCanonicalAmountError);
        assert.match(err.message, /missing canonical integer amountPaise/i);
        return true;
      }
    );

    // Verify order was not completed
    const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
    assert.notEqual(orderDoc.status, 'completed');
    assert.equal(orderDoc.totalCapturedPaise, 0);
  });

  // ============================================================================
  // SCENARIO 22: Primary-payment race collision re-reads committed winning attempt
  // and order outside the failed transaction and retries in a fresh transaction
  // ============================================================================
  it('22. primary race E11000 aborts transaction, re-reads winning attempt outside transaction, and retries in fresh transaction', async () => {
    const rzpOrderId = 'order_rzp_s22';
    const primaryPayId = 'pay_winner_s22';
    const loserPayId = 'pay_loser_s22';
    const testOrder = createTestOrder({ orderId: 'ord_s22', razorpayOrderId: rzpOrderId });

    let createInvocation = 0;
    const originalCreate = PaymentAttempt.create;

    // Simulate primary unique index collision on first attempt (orderId_1_classification_1)
    PaymentAttempt.create = (async (docs: any, options?: any) => {
      createInvocation++;
      const doc = Array.isArray(docs) ? docs[0] : docs;

      if (doc.classification === 'primary') {
        // Winning transaction committed before our write
        testOrder.primaryPaymentId = primaryPayId;
        testOrder.purchaseCapturedPaise = 417000;
        testOrder.totalCapturedPaise = 417000;
        testOrder.status = 'completed';
        testOrder.paymentStatus = 'captured';

        databasePaymentAttempts.push({
          _id: new mongoose.Types.ObjectId(),
          paymentId: primaryPayId,
          orderId: testOrder._id,
          razorpayOrderId: rzpOrderId,
          amountCapturedPaise: 417000,
          currency: 'INR',
          status: 'captured',
          classification: 'primary',
          save: async function () { return this; },
        });

        const err: any = new Error(
          'E11000 duplicate key error collection: project_world.paymentattempts index: orderId_1_classification_1 dup key'
        );
        err.code = 11000;
        throw err;
      }

      // Retry in fresh transaction with classification === 'duplicate_charge' succeeds
      return originalCreate(docs, options);
    }) as any;

    try {
      const res = await processPaymentCapture({
        paymentId: loserPayId,
        orderId: testOrder.orderId,
        razorpayOrderId: rzpOrderId,
        amountPaise: 417000,
        currency: 'INR',
        source: 'webhook',
        verifiedGatewayPayment: {
          id: loserPayId,
          amount: 417000,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
        },
      });

      assert.equal(res.classification, 'duplicate_charge');
      assert.equal(res.duplicateDelivery, false);
      assert.equal(createInvocation, 2); // Attempt 1 threw E11000 and aborted; Attempt 2 in fresh transaction succeeded

      const orderDoc = databaseOrders.find((o) => o.orderId === testOrder.orderId);
      assert.equal(orderDoc.primaryPaymentId, primaryPayId);
      assert.equal(orderDoc.purchaseCapturedPaise, 417000);
      assert.equal(orderDoc.duplicateCapturedPaise, 417000);
      assert.equal(orderDoc.totalCapturedPaise, 834000);
      assert.equal(orderDoc.paymentStatus, 'duplicate_charge_detected');
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });

  // ============================================================================
  // SCENARIO 23: Primary race collision with cross-order payment ID throws SecurityDiscrepancyError
  // ============================================================================
  it('23. primary race recovery detects cross-order payment ID and throws SecurityDiscrepancyError', async () => {
    const orderA = createTestOrder({ orderId: 'ord_s23_A', razorpayOrderId: 'order_rzp_s23_A' });
    const orderB = createTestOrder({ orderId: 'ord_s23_B', razorpayOrderId: 'order_rzp_s23_B' });
    const primaryPayA = 'pay_winner_s23_A';
    const stolenPayId = 'pay_cross_order_stolen_s23';

    // Existing attempt for stolenPayId belongs to Order B!
    databasePaymentAttempts.push({
      _id: new mongoose.Types.ObjectId(),
      paymentId: stolenPayId,
      orderId: orderB._id, // BELONGS TO ORDER B!
      razorpayOrderId: orderB.razorpayOrderId,
      amountCapturedPaise: 417000,
      currency: 'INR',
      status: 'captured',
      classification: 'primary',
      save: async function () { return this; },
    });

    const originalCreate = PaymentAttempt.create;

    // Simulate primary collision on Order A
    PaymentAttempt.create = (async (docs: any, options?: any) => {
      const doc = Array.isArray(docs) ? docs[0] : docs;
      if (doc.classification === 'primary') {
        orderA.primaryPaymentId = primaryPayA;
        orderA.status = 'completed';
        orderA.paymentStatus = 'captured';

        databasePaymentAttempts.push({
          _id: new mongoose.Types.ObjectId(),
          paymentId: primaryPayA,
          orderId: orderA._id,
          razorpayOrderId: orderA.razorpayOrderId,
          amountCapturedPaise: 417000,
          currency: 'INR',
          status: 'captured',
          classification: 'primary',
          save: async function () { return this; },
        });

        const err: any = new Error(
          'E11000 duplicate key error collection: project_world.paymentattempts index: orderId_1_classification_1 dup key'
        );
        err.code = 11000;
        throw err;
      }
      return originalCreate(docs, options);
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await processPaymentCapture({
            paymentId: stolenPayId,
            orderId: orderA.orderId,
            razorpayOrderId: orderA.razorpayOrderId,
            amountPaise: 417000,
            currency: 'INR',
            source: 'callback',
            verifiedGatewayPayment: {
              id: stolenPayId,
              amount: 417000,
              currency: 'INR',
              status: 'captured',
              order_id: orderA.razorpayOrderId,
            },
          });
        },
        (err: any) => {
          assert.ok(err instanceof SecurityDiscrepancyError);
          assert.match(err.message, /already associated with internal order/i);
          return true;
        }
      );
    } finally {
      PaymentAttempt.create = originalCreate;
    }
  });
});
