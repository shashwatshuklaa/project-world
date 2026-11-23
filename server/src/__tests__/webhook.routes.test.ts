import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import app from '../app.js';
import { Order } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { WebhookEvent } from '../models/WebhookEvent.js';
import { PaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund } from '../models/Refund.js';
import { RefundJob } from '../models/RefundJob.js';
import { setRazorpayClient } from '../config/razorpay.js';

const user1Id = '6740000000000000000000a1';
const mockDroneId = new mongoose.Types.ObjectId('674000000000000000000001');

describe('Razorpay Webhook Integration (POST /api/webhooks/razorpay)', () => {
  let databaseOrders: any[] = [];
  let databaseCarts: any[] = [];
  let databaseWebhookEvents: any[] = [];

  const WEBHOOK_SECRET = 'mockWebhookSecret99999';

  function signPayload(rawBody: string | Buffer): string {
    return crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
  }

  let databasePaymentAttempts: any[] = [];
  let databaseRefunds: any[] = [];
  let databaseRefundJobs: any[] = [];

  beforeEach(() => {
    databaseOrders = [];
    databaseCarts = [];
    databaseWebhookEvents = [];
    databasePaymentAttempts = [];
    databaseRefunds = [];
    databaseRefundJobs = [];

    process.env.RAZORPAY_KEY_ID = 'rzp_test_mockKeyId12345';
    process.env.RAZORPAY_KEY_SECRET = 'mockKeySecret67890';
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    // Mock Razorpay SDK payments.fetch and refunds.fetch
    setRazorpayClient({
      payments: {
        fetch: async (paymentId: string) => {
          if (paymentId === 'pay_tampered_123') {
            return {
              id: 'pay_tampered_123',
              amount: 100000,
              currency: 'INR',
              status: 'captured',
              order_id: 'order_wh_tampered_amount',
              method: 'upi',
              captured: true,
            };
          }
          const matchingOrder = databaseOrders.find(
            (o) => o.razorpayPaymentId === paymentId || o.razorpayOrderId
          );
          return {
            id: paymentId,
            entity: 'payment',
            amount: matchingOrder
              ? matchingOrder.amountPaise || Math.round(matchingOrder.totalAmount * 100)
              : 417000,
            currency: 'INR',
            status: 'captured',
            order_id: matchingOrder ? matchingOrder.razorpayOrderId : 'order_wh_default_123',
            method: 'upi',
            captured: true,
          };
        },
      },
      refunds: {
        fetch: async (refundId: string, params?: any) => {
          const matchingRefund = databaseRefunds.find(
            (r) => r.providerRefundId === refundId || r.refundId === refundId
          );
          return {
            id: refundId,
            payment_id: matchingRefund ? matchingRefund.paymentId : params?.payment_id || 'pay_wh_default',
            amount: matchingRefund ? matchingRefund.amountPaise : 417000,
            currency: 'INR',
            status: 'processed',
          };
        },
      },
    } as any);

    // Mock Order
    Order.findOne = (async (query: any) => {
      return (
        databaseOrders.find((doc) => {
          let matches = true;
          if (query._id && doc._id.toString() !== query._id.toString()) matches = false;
          if (query.orderId && doc.orderId !== query.orderId) matches = false;
          if (query.razorpayOrderId && doc.razorpayOrderId !== query.razorpayOrderId) matches = false;
          return matches;
        }) || null
      );
    }) as any;

    Order.findById = (async (id: any) => {
      return databaseOrders.find((doc) => doc._id?.toString() === id.toString()) || null;
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

    // Mock PaymentAttempt
    PaymentAttempt.findOne = (async (query: any) => {
      return (
        databasePaymentAttempts.find((doc) => {
          let matches = true;
          if (query.paymentId && doc.paymentId !== query.paymentId) matches = false;
          return matches;
        }) || null
      );
    }) as any;

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

    // Mock Cart
    Cart.findOne = (async (query: any) => {
      return (
        databaseCarts.find(
          (c) => c.user && query.user && c.user.toString() === query.user.toString()
        ) || null
      );
    }) as any;

    // Mock WebhookEvent
    WebhookEvent.create = (async (data: any) => {
      // Simulate MongoDB unique index on eventId
      const exists = databaseWebhookEvents.some((e) => e.eventId === data.eventId);
      if (exists) {
        const dupError: any = new Error(
          `E11000 duplicate key error collection: webhookevents index: eventId_1 dup key: { eventId: "${data.eventId}" }`
        );
        dupError.code = 11000;
        throw dupError;
      }

      const doc: any = {
        _id: new mongoose.Types.ObjectId(),
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        save: async function () {
          const idx = databaseWebhookEvents.findIndex(
            (e) => e._id.toString() === this._id.toString()
          );
          if (idx >= 0) databaseWebhookEvents[idx] = this;
          return this;
        },
      };
      databaseWebhookEvents.push(doc);
      return doc;
    }) as any;

    WebhookEvent.findOne = (async (query: any) => {
      return (
        databaseWebhookEvents.find((e) => {
          if (query.eventId && e.eventId === query.eventId) return true;
          return false;
        }) || null
      );
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

    // Mock Refund
    Refund.findOne = (async (query: any) => {
      return (
        databaseRefunds.find((r) => {
          if (query.$or) {
            return query.$or.some((cond: any) => {
              if (cond.providerRefundId && r.providerRefundId === cond.providerRefundId) return true;
              if (cond.refundId && r.refundId === cond.refundId) return true;
              return false;
            });
          }
          if (query.refundId && r.refundId !== query.refundId) return false;
          if (query.providerRefundId && r.providerRefundId !== query.providerRefundId) return false;
          return true;
        }) || null
      );
    }) as any;

    Refund.prototype.save = async function () {
      return this;
    };

    // Mock RefundJob
    RefundJob.findById = (async (id: any) => {
      return databaseRefundJobs.find((j) => j._id?.toString() === id.toString()) || null;
    }) as any;

    RefundJob.findOne = (async (query: any) => {
      return (
        databaseRefundJobs.find((j) => {
          if (query._id && j._id?.toString() !== query._id?.toString()) return false;
          return true;
        }) || null
      );
    }) as any;

    RefundJob.prototype.save = async function () {
      return this;
    };
  });

  it('1. verifies valid HMAC SHA-256 signature on payment.captured and marks order completed', async () => {
    const rzpOrderId = 'order_wh_captured_123';
    const paymentId = 'pay_wh_captured_123';
    const eventId = 'evt_captured_001';

    const testOrder = new Order({
      orderId: 'ord_wh_cap_1',
      receipt: 'rcpt_wh_cap_1',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170, // 417000 paise
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-cap-1',
    });
    databaseOrders.push(testOrder);

    const payload = {
      entity: 'event',
      account_id: 'acc_test_123',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const rawBody = JSON.stringify(payload);
    const signature = signPayload(rawBody);

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(rawBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = databaseOrders[0];
    assert.equal(updated.paymentStatus, 'captured');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.razorpayPaymentId, paymentId);
    assert.equal(updated.paymentMethod, 'upi');
    assert.ok(updated.webhookEventsProcessed.includes(eventId));

    // Webhook event was persisted as processed
    assert.equal(databaseWebhookEvents.length, 1);
    assert.equal(databaseWebhookEvents[0].status, 'processed');
    assert.equal(databaseWebhookEvents[0].eventId, eventId);
  });

  it('2. rejects invalid webhook signature with HTTP 400', async () => {
    const rawBody = JSON.stringify({ event: 'payment.captured' });
    const tamperedSignature = 'f'.repeat(64);

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', tamperedSignature)
      .set('X-Razorpay-Event-Id', 'evt_bad_sig')
      .send(rawBody);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /invalid webhook signature/i);
    assert.equal(databaseWebhookEvents.length, 0); // No event recorded
  });

  it('3. rejects missing X-Razorpay-Signature header with HTTP 400', async () => {
    const rawBody = JSON.stringify({ event: 'payment.captured' });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', 'evt_no_sig')
      .send(rawBody);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /missing razorpay webhook signature/i);
  });

  it('4. rejects missing event ID with HTTP 400', async () => {
    const rawBody = JSON.stringify({ event: 'payment.captured' });
    const signature = signPayload(rawBody);

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .send(rawBody);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /missing razorpay event identifier/i);
  });

  it('5. duplicate event ID delivery returns idempotent HTTP 200 without duplicate processing', async () => {
    const eventId = 'evt_dup_test_123';
    const rzpOrderId = 'order_wh_dup_123';

    const testOrder = new Order({
      orderId: 'ord_wh_dup_1',
      receipt: 'rcpt_wh_dup_1',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-dup-1',
    });
    databaseOrders.push(testOrder);

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_wh_dup_123',
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(rawBody);

    // 1st delivery
    const res1 = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(rawBody);

    assert.equal(res1.status, 200);

    // 2nd delivery (Razorpay webhook retry)
    const res2 = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(rawBody);

    assert.equal(res2.status, 200);
    assert.match(res2.body.message, /already processed/i);
    // Database contains only ONE webhook event record
    assert.equal(databaseWebhookEvents.length, 1);
  });

  it('6. concurrent duplicate deliveries are safely handled via database uniqueness', async () => {
    const eventId = 'evt_concurrent_test_123';
    const rzpOrderId = 'order_wh_concurrent_123';

    const testOrder = new Order({
      orderId: 'ord_wh_conc_1',
      receipt: 'rcpt_wh_conc_1',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-conc-1',
    });
    databaseOrders.push(testOrder);

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_wh_conc_123',
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(rawBody);

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature)
        .set('X-Razorpay-Event-Id', eventId)
        .send(rawBody),
      request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature)
        .set('X-Razorpay-Event-Id', eventId)
        .send(rawBody),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(databaseWebhookEvents.length, 1);
  });

  it('7. verifies signature against exact raw request body including custom whitespace', async () => {
    const rawBodyWithSpaces = '  {\n  "event":  "payment.authorized" \n}  ';
    const signature = signPayload(rawBodyWithSpaces);

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', 'evt_raw_body_spacing')
      .send(rawBodyWithSpaces);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it('8. payment.failed followed by successful payment allows recovery and completion', async () => {
    const rzpOrderId = 'order_wh_retry_scenario';

    const testOrder = new Order({
      orderId: 'ord_wh_retry',
      receipt: 'rcpt_wh_retry',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-retry',
    });
    databaseOrders.push(testOrder);

    // 1st event: payment.failed (e.g. wrong OTP entered by user)
    const failPayload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_failed_attempt_1',
            order_id: rzpOrderId,
            error_description: 'User entered wrong bank OTP',
          },
        },
      },
    };
    const failRaw = JSON.stringify(failPayload);
    const failRes = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(failRaw))
      .set('X-Razorpay-Event-Id', 'evt_payment_failed_1')
      .send(failRaw);

    assert.equal(failRes.status, 200);
    // Crucial: paymentStatus is retryable_failure, status remains pending!
    assert.equal(databaseOrders[0].paymentStatus, 'retryable_failure');
    assert.equal(databaseOrders[0].status, 'pending');
    assert.equal(databaseOrders[0].failureReason, 'User entered wrong bank OTP');

    // 2nd event: User retried with correct OTP and payment succeeded
    const successPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_success_attempt_2',
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };
    const succRaw = JSON.stringify(successPayload);
    const succRes = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(succRaw))
      .set('X-Razorpay-Event-Id', 'evt_payment_success_2')
      .send(succRaw);

    assert.equal(succRes.status, 200);
    assert.equal(databaseOrders[0].paymentStatus, 'captured');
    assert.equal(databaseOrders[0].status, 'completed');
    assert.equal(databaseOrders[0].razorpayPaymentId, 'pay_success_attempt_2');
  });

  it('9. captured payment is NEVER downgraded by a later delayed failure event', async () => {
    const rzpOrderId = 'order_wh_downgrade_defense';

    // Order was already captured
    const testOrder = new Order({
      orderId: 'ord_wh_dg',
      receipt: 'rcpt_wh_dg',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: 'pay_captured_winner',
      idempotencyKey: 'idemp-wh-dg',
    });
    databaseOrders.push(testOrder);

    // Delayed failure event from an earlier failed attempt arrives late
    const lateFailPayload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_delayed_failure',
            order_id: rzpOrderId,
            error_description: 'Delayed gateway timeout notification',
          },
        },
      },
    };
    const lateFailRaw = JSON.stringify(lateFailPayload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(lateFailRaw))
      .set('X-Razorpay-Event-Id', 'evt_late_fail_123')
      .send(lateFailRaw);

    assert.equal(res.status, 200);
    // Protected against downgrade: remains captured & completed!
    assert.equal(databaseOrders[0].paymentStatus, 'captured');
    assert.equal(databaseOrders[0].status, 'completed');
    assert.equal(databaseOrders[0].razorpayPaymentId, 'pay_captured_winner');
  });

  it('10. amount/currency mismatch is rejected with HTTP 400 and does NOT mark order paid', async () => {
    const rzpOrderId = 'order_wh_tampered_amount';

    const testOrder = new Order({
      orderId: 'ord_wh_tamp',
      receipt: 'rcpt_wh_tamp',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170, // 417000 paise
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-tamp',
    });
    databaseOrders.push(testOrder);

    // Attacker or bug sends amount = 100000 (1000 INR instead of 4170)
    const tamperedPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_tampered_123',
            order_id: rzpOrderId,
            amount: 100000, // Underpaid
            currency: 'INR',
          },
        },
      },
    };
    const tamperedRaw = JSON.stringify(tamperedPayload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(tamperedRaw))
      .set('X-Razorpay-Event-Id', 'evt_tampered_amount')
      .send(tamperedRaw);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /amount or currency mismatch/i);
    // Order is held for resolution ('unknown'), NOT marked captured or completed!
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
    assert.notEqual(databaseOrders[0].status, 'completed');
  });

  it('11. unknown Razorpay order returns 200 without throwing unhandled exception', async () => {
    const unknownPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_orphan_123',
            order_id: 'order_completely_unknown',
            amount: 50000,
            currency: 'INR',
          },
        },
      },
    };
    const raw = JSON.stringify(unknownPayload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_orphan_payment')
      .send(raw);

    assert.equal(res.status, 200);
    assert.match(res.body.message, /order not found/i);
  });

  it('12. processes refund event and transitions order to refunded', async () => {
    const rzpOrderId = 'order_wh_refund_test';

    const testOrder = new Order({
      orderId: 'ord_wh_refund',
      receipt: 'rcpt_wh_refund',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-refund',
    });
    databaseOrders.push(testOrder);

    const refundPayload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_mock_12345',
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
          },
        },
      },
    };
    const raw = JSON.stringify(refundPayload);
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(raw))
      .set('X-Razorpay-Event-Id', 'evt_refund_processed_1')
      .send(raw);

    assert.equal(res.status, 200);
    assert.equal(databaseOrders[0].status, 'refunded');
    assert.equal(databaseOrders[0].paymentStatus, 'refunded');
    assert.match(databaseOrders[0].failureReason, /rfnd_mock_12345/);
  });

  it('13. rejects webhook when optional body event ID mismatches header event ID with HTTP 400', async () => {
    const rawBody = JSON.stringify({
      event: 'payment.captured',
      event_id: 'evt_body_mismatch_999',
      payload: {
        payment: {
          entity: {
            id: 'pay_mismatch_header',
            amount: 417000,
          },
        },
      },
    });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(rawBody))
      .set('X-Razorpay-Event-Id', 'evt_header_canonical_111')
      .send(rawBody);

    assert.equal(res.status, 400);
    assert.match(res.body.message, /event id mismatch/i);
  });

  it('14. accepts header-based event ID when JSON body has no event ID and stores canonical event ID', async () => {
    const rzpOrderId = 'order_wh_header_no_body_id';
    const testOrder = new Order({
      orderId: 'ord_wh_header_no_body_id',
      receipt: 'rcpt_wh_header_1',
      userId: new mongoose.Types.ObjectId(user1Id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-wh-header-only',
    });
    databaseOrders.push(testOrder);

    // Payload has entity, event, payload, but NO event_id or id at root!
    const rawBody = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test_123',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_wh_header_only_123',
            order_id: rzpOrderId,
            amount: 417000,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    });

    const canonicalHeaderId = 'evt_canonical_header_only_456';
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signPayload(rawBody))
      .set('X-Razorpay-Event-Id', canonicalHeaderId)
      .send(rawBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const savedEvent = databaseWebhookEvents.find((e) => e.eventId === canonicalHeaderId);
    assert.ok(savedEvent, 'Webhook event must be persisted using the canonical header event ID');
    assert.equal(savedEvent.eventId, canonicalHeaderId);
    assert.equal(savedEvent.status, 'processed');
  });
});
