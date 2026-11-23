import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import app from '../app.js';
import { Order } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { PaymentAttempt } from '../models/PaymentAttempt.js';
import { setRazorpayClient } from '../config/razorpay.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';

// Authenticated test user identities
const user1 = { id: '6740000000000000000000a1', email: 'user1@example.com', role: 'user' as const };
const user2 = { id: '6740000000000000000000a2', email: 'user2@example.com', role: 'user' as const };
const tokenUser1 = generateToken(user1);
const tokenUser2 = generateToken(user2);

const mockDroneId = new mongoose.Types.ObjectId('674000000000000000000001');
const mockRcId = new mongoose.Types.ObjectId('674000000000000000000002');

describe('Payment Verification Integration (POST /api/orders/verify-payment)', () => {
  let databaseOrders: any[] = [];
  let databaseCarts: any[] = [];

  const KEY_SECRET = 'mockKeySecret67890';
  const KEY_ID = 'rzp_test_mockKeyId12345';

  function generateValidSignature(rzpOrderId: string, paymentId: string): string {
    return crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');
  }

  let databasePaymentAttempts: any[] = [];

  beforeEach(() => {
    databaseOrders = [];
    databaseCarts = [];
    databasePaymentAttempts = [];

    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'mockWebhookSecret99999';

    // Mock Razorpay client payments.fetch
    setRazorpayClient({
      payments: {
        fetch: async (paymentId: string) => {
          const matchingOrder = databaseOrders.find(
            (o) => o.razorpayPaymentId === paymentId || o.razorpayOrderId
          );
          return {
            id: paymentId,
            entity: 'payment',
            amount: matchingOrder ? Math.round(matchingOrder.totalAmount * 100) : 417000,
            currency: 'INR',
            status: 'captured',
            order_id: matchingOrder ? matchingOrder.razorpayOrderId : 'order_rzp_mock_123',
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

    // Mock Cart methods
    Cart.findOne = (async (query: any) => {
      const found = databaseCarts.find(
        (c) => c.user && query.user && c.user.toString() === query.user.toString()
      );
      return found || null;
    }) as any;

    // Mock PaymentAttempt methods
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
  });

  it('1. verifies payment with valid HMAC SHA-256 signature and transitions order to completed', async () => {
    const orderId = 'ord_test_valid_sig_123';
    const razorpayOrderId = 'order_rzp_mock_123';
    const razorpayPaymentId = 'pay_rzp_mock_123';
    const validSignature = generateValidSignature(razorpayOrderId, razorpayPaymentId);

    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_test_valid_sig_123',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId,
      idempotencyKey: 'idemp-valid-sig-key',
    });
    databaseOrders.push(testOrder);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: validSignature,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order.status, 'completed');
    assert.equal(res.body.order.paymentStatus, 'captured');
    assert.equal(res.body.order.razorpayPaymentId, razorpayPaymentId);

    const updated = databaseOrders[0];
    assert.equal(updated.paymentStatus, 'captured');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.razorpayPaymentId, razorpayPaymentId);
    assert.ok(updated.paidAt instanceof Date);
  });

  it('2. rejects invalid or tampered signature and leaves order unpaid', async () => {
    const orderId = 'ord_test_invalid_sig_123';
    const razorpayOrderId = 'order_rzp_mock_inv';
    const razorpayPaymentId = 'pay_rzp_mock_inv';
    const tamperedSignature = 'a'.repeat(64); // Invalid signature

    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_test_invalid_sig',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId,
      idempotencyKey: 'idemp-invalid-sig-key',
    });
    databaseOrders.push(testOrder);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: tamperedSignature,
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /invalid payment signature/i);

    // Database state remains unchanged
    const doc = databaseOrders[0];
    assert.equal(doc.paymentStatus, 'created');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.razorpayPaymentId, undefined);
  });

  it('3. rejects mismatched Razorpay order ID with 400', async () => {
    const orderId = 'ord_test_mismatched_rzp_id';
    const storedRzpOrderId = 'order_rzp_stored_111';
    const wrongRzpOrderId = 'order_rzp_wrong_222';
    const paymentId = 'pay_rzp_test_123';
    const signature = generateValidSignature(wrongRzpOrderId, paymentId);

    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_mismatched_rzp_id',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: storedRzpOrderId,
      idempotencyKey: 'idemp-mismatch-key',
    });
    databaseOrders.push(testOrder);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: wrongRzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /identifier mismatch/i);
    assert.equal(databaseOrders[0].paymentStatus, 'created');
  });

  it('4. returns 404 for unknown internal order ID', async () => {
    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId: 'ord_completely_unknown',
        razorpay_order_id: 'order_some_rzp_id',
        razorpay_payment_id: 'pay_some_payment_id',
        razorpay_signature: generateValidSignature('order_some_rzp_id', 'pay_some_payment_id'),
      });

    assert.equal(res.status, 404);
    assert.match(res.body.message, /order not found/i);
  });

  it('5. prevents a user from verifying another user’s order (ownership isolation)', async () => {
    const orderId = 'ord_user1_private_order';
    const rzpOrderId = 'order_rzp_user1';
    const paymentId = 'pay_rzp_user1';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    // Order belongs strictly to user1
    const orderUser1 = new Order({
      orderId,
      receipt: 'rcpt_user1_private',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-user1-key',
    });
    databaseOrders.push(orderUser1);

    // User 2 attempts to verify user 1's order
    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser2}`) // user2 token
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 404); // Order not found for user 2
    assert.equal(databaseOrders[0].paymentStatus, 'created'); // Unchanged
  });

  it('6. repeated verification is idempotent and does not corrupt an already-paid order', async () => {
    const orderId = 'ord_idempotent_verify';
    const rzpOrderId = 'order_rzp_idem';
    const paymentId = 'pay_rzp_idem';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_idempotent_verify',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-idem-key',
    });
    databaseOrders.push(testOrder);

    // First verification call
    const res1 = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });
    assert.equal(res1.status, 200);

    const firstPaidAt = databaseOrders[0].paidAt;

    // Second verification call (duplicate callback)
    const res2 = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res2.status, 200);
    assert.equal(databaseOrders[0].paymentStatus, 'captured');
    assert.equal(databaseOrders[0].status, 'completed');
    assert.equal(databaseOrders[0].paidAt.getTime(), firstPaidAt.getTime());
  });

  it('7. verification succeeds when webhook already marked order as captured without re-running cart cleanup', async () => {
    const orderId = 'ord_webhook_first';
    const rzpOrderId = 'order_rzp_wh_first';
    const paymentId = 'pay_rzp_wh_first';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    // Simulate that webhook arrived first and captured the order
    const orderCapturedByWebhook = new Order({
      orderId,
      receipt: 'rcpt_webhook_first',
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
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      cartReconciled: true,
      paidAt: new Date(Date.now() - 5000),
      idempotencyKey: 'idemp-wh-first',
    });
    databaseOrders.push(orderCapturedByWebhook);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'completed');
    assert.equal(res.body.order.paymentStatus, 'captured');
  });

  // ==========================================
  // Cart Reconciliation Focused Tests
  // ==========================================
  it('8. cart reconciliation: removes only purchased quantity and preserves newly added items', async () => {
    const orderId = 'ord_cart_recon_1';
    const rzpOrderId = 'order_rzp_cr_1';
    const paymentId = 'pay_rzp_cr_1';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    // Order was created for Drone (qty 2)
    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_cart_recon_1',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-recon-1',
    });
    databaseOrders.push(testOrder);

    // In the meantime, user added RC Car (qty 1) to cart
    const userCart = new Cart({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockDroneId,
          quantity: 2,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockRcId, // Newly added item
          quantity: 1,
        },
      ],
    });
    userCart.save = async function () {
      return this;
    };
    databaseCarts.push(userCart);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 200);
    // Drone (qty 2) removed; RC Car (qty 1) preserved!
    assert.equal(userCart.items.length, 1);
    assert.equal(userCart.items[0].project.toString(), mockRcId.toString());
    assert.equal(userCart.items[0].quantity, 1);
  });

  it('9. cart reconciliation: preserves additional quantity increased after checkout initiated', async () => {
    const orderId = 'ord_cart_recon_2';
    const rzpOrderId = 'order_rzp_cr_2';
    const paymentId = 'pay_rzp_cr_2';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    // Order was created for Drone (qty 2)
    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_cart_recon_2',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-recon-2',
    });
    databaseOrders.push(testOrder);

    // While checkout was pending, user increased Drone quantity in cart from 2 to 3
    const userCart = new Cart({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockDroneId,
          quantity: 3, // Increased to 3
        },
      ],
    });
    userCart.save = async function () {
      return this;
    };
    databaseCarts.push(userCart);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 200);
    // Exactly 2 units deducted; 1 remaining unit preserved in cart!
    assert.equal(userCart.items.length, 1);
    assert.equal(userCart.items[0].quantity, 1);
  });

  it('10. cart reconciliation: does not remove items if customization notes were modified', async () => {
    const orderId = 'ord_cart_recon_3';
    const rzpOrderId = 'order_rzp_cr_3';
    const paymentId = 'pay_rzp_cr_3';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    // Order was created for Drone with customization "Engrave John"
    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_cart_recon_3',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 1,
          customization: 'Engrave John',
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-recon-3',
    });
    databaseOrders.push(testOrder);

    // In cart, user changed customization to "Engrave Mary"
    const userCart = new Cart({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockDroneId,
          quantity: 1,
          customization: 'Engrave Mary',
        },
      ],
    });
    userCart.save = async function () {
      return this;
    };
    databaseCarts.push(userCart);

    const res = await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(res.status, 200);
    // Customization did not match; "Engrave Mary" is NOT accidentally deleted
    assert.equal(userCart.items.length, 1);
    assert.equal(userCart.items[0].customization, 'Engrave Mary');
  });

  it('11. repeated success calls never deduct cart quantities twice', async () => {
    const orderId = 'ord_cart_recon_4';
    const rzpOrderId = 'order_rzp_cr_4';
    const paymentId = 'pay_rzp_cr_4';
    const signature = generateValidSignature(rzpOrderId, paymentId);

    const testOrder = new Order({
      orderId,
      receipt: 'rcpt_cart_recon_4',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone',
          price: 4170,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      razorpayOrderId: rzpOrderId,
      idempotencyKey: 'idemp-recon-4',
    });
    databaseOrders.push(testOrder);

    const userCart = new Cart({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockDroneId,
          quantity: 4, // 4 items in cart
        },
      ],
    });
    userCart.save = async function () {
      return this;
    };
    databaseCarts.push(userCart);

    // 1st verify
    await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    assert.equal(userCart.items[0].quantity, 2); // 4 - 2 = 2

    // 2nd verify
    await request(app)
      .post('/api/orders/verify-payment')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({
        orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    // Quantity MUST REMAIN 2, NOT 0!
    assert.equal(userCart.items[0].quantity, 2);
  });
});
