import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import { Order } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { Project } from '../models/Project.js';
import { setRazorpayClient } from '../config/razorpay.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';
import {
  classifyRazorpayError,
  isDuplicateReceiptError,
  isValidReconciliationMatch,
  generateOrderIdentifiers,
} from '../controllers/order.controller.js';

// Authenticated test user identities (24-character hex strings)
const user1 = { id: '6740000000000000000000a1', email: 'user1@example.com', role: 'user' as const };
const user2 = { id: '6740000000000000000000a2', email: 'user2@example.com', role: 'user' as const };
const tokenUser1 = generateToken(user1);
const tokenUser2 = generateToken(user2);

// Mock catalog project data
const mockDroneProject = {
  _id: new mongoose.Types.ObjectId('674000000000000000000001'),
  slug: 'eng-Drone-001',
  title: 'Racing Drone Construction Kit',
  category: 'Engineering',
  subcategory: 'Drone',
  price: 4170,
  image: '/projects/drone1.png',
  difficulty: 'Intermediate',
  isActive: true,
};

const mockRcProject = {
  _id: new mongoose.Types.ObjectId('674000000000000000000002'),
  slug: 'eng-rc-001',
  title: 'Off-Road RC Crawler',
  category: 'Engineering',
  subcategory: 'RC Devices',
  price: 3500,
  image: '/projects/rc1.png',
  difficulty: 'Beginner',
  isActive: true,
};

// Store original method references for post-test restoration
const originalOrderFindOne = Order.findOne;
const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
const originalOrderFindByIdAndUpdate = Order.findByIdAndUpdate;
const originalOrderDeleteOne = Order.deleteOne;
const originalOrderSave = Order.prototype.save;
const originalCartFindOne = Cart.findOne;
const originalProjectFind = Project.find;

describe('Order Creation & Razorpay Checkout Integration (POST /api/orders)', () => {
  let createdRazorpayOrders: any[] = [];
  let razorpayOrdersStore: any[] = [];
  let databaseOrders: any[] = [];
  let reconcileReceiptQueries: string[] = [];

  const mockRazorpayClient = {
    orders: {
      create: async (params: any) => {
        createdRazorpayOrders.push(params);

        // Simulate Razorpay's unique receipt validation
        if (params.receipt && razorpayOrdersStore.some((o) => o.receipt === params.receipt)) {
          const dupErr: any = new Error('BAD_REQUEST_ERROR: Order with this receipt already exists');
          dupErr.statusCode = 400;
          dupErr.error = { code: 'BAD_REQUEST_ERROR', description: 'Order with this receipt already exists' };
          throw dupErr;
        }

        const order = {
          id: `rzp_order_${params.receipt}`,
          currency: params.currency,
          amount: params.amount,
          receipt: params.receipt,
          status: 'created',
        };
        razorpayOrdersStore.push(order);
        return order;
      },
      all: async (query?: any) => {
        if (query?.receipt) {
          reconcileReceiptQueries.push(query.receipt);
          const matched = razorpayOrdersStore.filter((o) => o.receipt === query.receipt);
          return {
            entity: 'collection',
            count: matched.length,
            items: matched,
          };
        }
        return {
          entity: 'collection',
          count: razorpayOrdersStore.length,
          items: razorpayOrdersStore,
        };
      },
    },
  };

  beforeEach(() => {
    createdRazorpayOrders = [];
    razorpayOrdersStore = [];
    databaseOrders = [];
    reconcileReceiptQueries = [];

    // Ensure mock credentials exist for test runs
    process.env.RAZORPAY_KEY_ID = 'rzp_test_mockKeyId12345';
    process.env.RAZORPAY_KEY_SECRET = 'mockKeySecret67890';

    setRazorpayClient(mockRazorpayClient as any);

    // Realistic mock for Order.prototype.save supporting atomic reservation & unique index collision
    Order.prototype.save = async function () {
      const self = this as any;
      if (!self._id) {
        self._id = new mongoose.Types.ObjectId();
      }
      if (!self.createdAt) {
        self.createdAt = new Date();
      }
      self.updatedAt = new Date();

      const existingIndex = databaseOrders.findIndex(
        (doc) => doc._id && doc._id.toString() === self._id.toString()
      );

      if (existingIndex >= 0) {
        databaseOrders[existingIndex] = self;
        return self;
      }

      // Check unique constraint on { userId, idempotencyKey }
      const isDuplicate = databaseOrders.some(
        (doc) =>
          doc.userId &&
          self.userId &&
          doc.userId.toString() === self.userId.toString() &&
          doc.idempotencyKey === self.idempotencyKey
      );

      if (isDuplicate) {
        const dupError = new Error(
          `E11000 duplicate key error collection: test.orders index: userId_1_idempotencyKey_1 dup key: { userId: "${self.userId}", idempotencyKey: "${self.idempotencyKey}" }`
        );
        (dupError as any).code = 11000;
        throw dupError;
      }

      databaseOrders.push(self);
      return self;
    };

    // Realistic mock for Order.findOne
    Order.findOne = (async (query: any) => {
      const match = databaseOrders.find((doc) => {
        if (query.userId && doc.userId.toString() !== query.userId.toString()) return false;
        if (query.idempotencyKey && doc.idempotencyKey !== query.idempotencyKey) return false;
        if (query.orderId && doc.orderId !== query.orderId) return false;
        if (query.receipt && doc.receipt !== query.receipt) return false;
        return true;
      });
      return match || null;
    }) as any;

    // Realistic mock for Order.findOneAndUpdate supporting multi-process atomic lease claiming
    Order.findOneAndUpdate = (async (query: any, update: any) => {
      const doc = databaseOrders.find((d) => {
        if (query._id && d._id && d._id.toString() !== query._id.toString()) return false;
        if (query.paymentStatus?.$in && !query.paymentStatus.$in.includes(d.paymentStatus)) return false;
        return true;
      });
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        return doc;
      }
      return null;
    }) as any;

    // Realistic mock for Order.findByIdAndUpdate
    Order.findByIdAndUpdate = (async (id: any, update: any) => {
      const doc = databaseOrders.find((d) => d._id && d._id.toString() === id.toString());
      if (doc) {
        Object.assign(doc, update);
        return doc;
      }
      return null;
    }) as any;

    // Realistic mock for Order.deleteOne
    Order.deleteOne = (async (query: any) => {
      databaseOrders = databaseOrders.filter((doc) => {
        if (query._id && doc._id && doc._id.toString() === query._id.toString()) return false;
        if (query.idempotencyKey && doc.idempotencyKey === query.idempotencyKey) return false;
        return true;
      });
      return { acknowledged: true, deletedCount: 1 };
    }) as any;

    // Default mock for Cart.findOne with active cart items
    (Cart as any).findOne = async () => ({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId('674000000000000000000011'),
          project: mockDroneProject._id,
          quantity: 2,
          customization: 'Carbon fiber propellers',
        },
      ],
    });

    // Default mock for Project.find returning both active test projects
    Project.find = (async () => [mockDroneProject, mockRcProject]) as any;
  });

  afterEach(() => {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
    Order.findByIdAndUpdate = originalOrderFindByIdAndUpdate;
    Order.deleteOne = originalOrderDeleteOne;
    Order.prototype.save = originalOrderSave;
    Cart.findOne = originalCartFindOne;
    Project.find = originalProjectFind;
    setRazorpayClient(null);
  });

  // ==========================================
  // 1. Mandatory Idempotency Key Tests
  // ==========================================
  it('1. rejects order creation when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .send({});

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /idempotency key is required/i);
    assert.equal(createdRazorpayOrders.length, 0);
  });

  it('2. rejects empty or whitespace-only idempotency key', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', '   ')
      .send({});

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /idempotency key/i);
    assert.equal(createdRazorpayOrders.length, 0);
  });

  it('3. rejects idempotency keys with invalid characters or exceeding 100 chars', async () => {
    const resSpecialChars = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'key_with_special!@#$%^&*()')
      .send({});

    assert.equal(resSpecialChars.status, 400);
    assert.equal(resSpecialChars.body.success, false);
    assert.match(resSpecialChars.body.message, /invalid idempotency key format/i);

    const resTooLong = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'a'.repeat(101))
      .send({});

    assert.equal(resTooLong.status, 400);
    assert.equal(resTooLong.body.success, false);
  });

  it('4. rejects ambiguous requests when header and body supply conflicting keys', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'header-key-111')
      .send({ idempotencyKey: 'body-key-222' });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /conflicting idempotency keys/i);
    assert.equal(createdRazorpayOrders.length, 0);
  });

  // ==========================================
  // 2. Authentication & Authorization Tests
  // ==========================================
  it('5. rejects unauthenticated order creation requests with 401', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Idempotency-Key', 'unauth-test-key')
      .send({});
    assert.equal(res.status, 401);
  });

  it('6. returns 400 when an authenticated user attempts checkout with an empty cart', async () => {
    (Cart as any).findOne = async () => ({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [],
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'empty-cart-key')
      .send({});

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /empty/i);
    assert.equal(createdRazorpayOrders.length, 0);
  });

  // ==========================================
  // 3. Price Calculation & Paise Conversion
  // ==========================================
  it('7. uses canonical database project prices to calculate total amount in integer paise', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'valid-calc-key-001')
      .send({});

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    // 4170 * 2 = 8340 INR -> 834000 paise
    assert.equal(res.body.amount, 834000);
    assert.equal(res.body.currency, 'INR');
    assert.equal(res.body.keyId, 'rzp_test_mockKeyId12345');
    assert.ok(res.body.orderId.startsWith('ord_'));
    assert.ok(res.body.razorpayOrderId.startsWith('rzp_order_'));
  });

  it('8. rejects client-supplied amount, price, or user ID in request body with 400', async () => {
    const resAmount = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'tamper-key-1')
      .send({ amount: 100 });

    assert.equal(resAmount.status, 400);
    assert.equal(resAmount.body.success, false);

    const resUser = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'tamper-key-2')
      .send({ userId: user2.id });

    assert.equal(resUser.status, 400);
    assert.equal(resUser.body.success, false);
  });

  it('9. handles inactive or deleted projects safely with 400', async () => {
    (Project as any).find = async () => [];

    const resDeleted = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'deleted-proj-key')
      .send({});

    assert.equal(resDeleted.status, 400);
    assert.match(resDeleted.body.message, /no longer available/i);
  });

  // ==========================================
  // 4. Deterministic Receipt & Persistence Match Tests
  // ==========================================
  it('10. the receipt persisted in MongoDB is exactly the receipt sent to Razorpay and <= 40 chars', async () => {
    const key = 'receipt-match-test-key';

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', key)
      .send({});

    assert.equal(res.status, 201);
    assert.equal(databaseOrders.length, 1);
    const persisted = databaseOrders[0];

    // Receipt must be <= 40 characters per Razorpay documentation
    assert.ok(persisted.receipt.length <= 40, `Receipt length ${persisted.receipt.length} exceeds 40 chars`);
    assert.ok(persisted.orderId.length <= 40, `OrderId length ${persisted.orderId.length} exceeds 40 chars`);

    // Verify exact match between persisted receipt and Razorpay create receipt
    assert.equal(createdRazorpayOrders.length, 1);
    const rzpCall = createdRazorpayOrders[0];
    assert.equal(persisted.receipt, rzpCall.receipt);
  });

  it('11. recovery queries Razorpay using that exact same stored receipt', async () => {
    const key = 'recovery-exact-receipt-key';
    const { orderId, receipt } = generateOrderIdentifiers();

    // Seed an order reservation with a persistent receipt
    const existing = new Order({
      orderId,
      receipt,
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneProject._id,
          projectSlug: mockDroneProject.slug,
          title: mockDroneProject.title,
          price: mockDroneProject.price,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'creating',
      idempotencyKey: key,
    });
    existing.createdAt = new Date(Date.now() - 30_000); // Stale (30s ago)
    databaseOrders.push(existing);

    // Seed matching order on Razorpay
    razorpayOrdersStore.push({
      id: 'rzp_order_exact_match_123',
      receipt,
      amount: 834000,
      currency: 'INR',
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', key)
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.razorpayOrderId, 'rzp_order_exact_match_123');
    // Verify query receipt was exactly the stored receipt
    assert.ok(reconcileReceiptQueries.includes(receipt));
    assert.equal(createdRazorpayOrders.length, 0); // No recreate call
  });

  // ==========================================
  // 5. Stale Reservation & Visibility Tests
  // ==========================================
  it('12. a stale reservation with no immediately visible Razorpay result is NOT deleted', async () => {
    const key = 'stale-invisible-result-key';
    const { orderId, receipt } = generateOrderIdentifiers();

    const staleDoc = new Order({
      orderId,
      receipt,
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneProject._id,
          projectSlug: mockDroneProject.slug,
          title: mockDroneProject.title,
          price: mockDroneProject.price,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'creating',
      idempotencyKey: key,
    });
    staleDoc.createdAt = new Date(Date.now() - 30_000);
    databaseOrders.push(staleDoc);

    // Razorpay orders.all returns 0 items (order not visible yet in list)
    // When retry calls orders.create with the persistent receipt, it succeeds
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', key)
      .send({});

    assert.equal(res.status, 200);
    // Crucial: The reservation was NOT deleted
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].receipt, receipt);
    // The create call used the exact same persistent receipt
    assert.equal(createdRazorpayOrders[0].receipt, receipt);
  });

  it('13. a duplicate-receipt rejection triggers reconciliation rather than generating a new receipt', async () => {
    const key = 'dup-receipt-trigger-recon-key';
    const { orderId, receipt } = generateOrderIdentifiers();

    const staleDoc = new Order({
      orderId,
      receipt,
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneProject._id,
          projectSlug: mockDroneProject.slug,
          title: mockDroneProject.title,
          price: mockDroneProject.price,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'creating',
      idempotencyKey: key,
    });
    staleDoc.createdAt = new Date(Date.now() - 30_000);
    databaseOrders.push(staleDoc);

    // Pre-populate Razorpay with this order so orders.create will hit duplicate receipt error
    razorpayOrdersStore.push({
      id: 'rzp_order_existing_dup_receipt',
      receipt,
      amount: 834000,
      currency: 'INR',
    });

    // Make orders.all return empty first time to force create attempt
    let allCallCount = 0;
    const realAll = mockRazorpayClient.orders.all;
    mockRazorpayClient.orders.all = async (query?: any) => {
      allCallCount++;
      if (allCallCount === 1) {
        return { entity: 'collection', count: 0, items: [] };
      }
      return realAll(query);
    };

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', key)
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.razorpayOrderId, 'rzp_order_existing_dup_receipt');
    assert.equal(databaseOrders[0].receipt, receipt);
    // Restored mock
    mockRazorpayClient.orders.all = realAll;
  });

  it('14. a mismatched receipt, amount, or currency is NEVER attached to the internal order', async () => {
    const key = 'mismatched-recon-key';
    const { orderId, receipt } = generateOrderIdentifiers();

    const staleDoc = new Order({
      orderId,
      receipt,
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneProject._id,
          projectSlug: mockDroneProject.slug,
          title: mockDroneProject.title,
          price: mockDroneProject.price,
          quantity: 2,
        },
      ],
      totalAmount: 8340, // 834000 paise
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'creating',
      idempotencyKey: key,
    });
    staleDoc.createdAt = new Date(Date.now() - 30_000);
    databaseOrders.push(staleDoc);

    // Razorpay returns order with WRONG AMOUNT (e.g. 500000 instead of 834000)
    razorpayOrdersStore.push({
      id: 'rzp_order_mismatched_amount',
      receipt,
      amount: 500000, // Tampered/mismatched amount
      currency: 'INR',
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', key)
      .send({});

    assert.equal(res.status, 500);
    assert.equal(res.body.resolutionNeeded, true);
    // Crucial: The mismatched razorpayOrderId is NOT attached!
    assert.equal(databaseOrders[0].razorpayOrderId, undefined);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
  });

  it('15. an unresolved result keeps the idempotency key reserved and does not free it', async () => {
    const unresolvedKey = 'unresolved-reserved-key';
    const { orderId, receipt } = generateOrderIdentifiers();

    const unknownDoc = new Order({
      orderId,
      receipt,
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneProject._id,
          projectSlug: mockDroneProject.slug,
          title: mockDroneProject.title,
          price: mockDroneProject.price,
          quantity: 2,
        },
      ],
      totalAmount: 8340,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'unknown',
      idempotencyKey: unresolvedKey,
    });
    databaseOrders.push(unknownDoc);

    // Make Razorpay orders.all throw connection error
    setRazorpayClient({
      orders: {
        create: async () => {
          throw new Error('Should not be called');
        },
        all: async () => {
          throw new Error('ECONNRESET');
        },
      },
    } as any);

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', unresolvedKey)
      .send({});

    assert.equal(res.status, 503);
    assert.equal(res.body.resolutionNeeded, true);
    // Key remains reserved in MongoDB
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].idempotencyKey, unresolvedKey);
  });

  // ==========================================
  // 6. Concurrency & Isolation Tests
  // ==========================================
  it('16. concurrent requests with the same key cause only one Razorpay orders.create call', async () => {
    const concurrentKey = 'concurrent-race-test-key';

    setRazorpayClient({
      orders: {
        create: async (params: any) => {
          await new Promise((r) => setTimeout(r, 60));
          createdRazorpayOrders.push(params);
          const order = {
            id: `rzp_order_${params.receipt}`,
            currency: params.currency,
            amount: params.amount,
            receipt: params.receipt,
          };
          razorpayOrdersStore.push(order);
          return order;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/orders')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .set('Idempotency-Key', concurrentKey)
        .send({}),
      request(app)
        .post('/api/orders')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .set('Idempotency-Key', concurrentKey)
        .send({}),
    ]);

    const statuses = [resA.status, resB.status];
    assert.ok(statuses.includes(201));
    assert.ok(statuses.includes(200) || statuses.includes(409));
    assert.equal(createdRazorpayOrders.length, 1);
  });

  it('17. same user + different idempotency keys can create separate legitimate orders', async () => {
    const res1 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'order-key-alpha')
      .send({});

    assert.equal(res1.status, 201);

    const res2 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'order-key-beta')
      .send({});

    assert.equal(res2.status, 201);
    assert.notEqual(res1.body.orderId, res2.body.orderId);
    assert.notEqual(res1.body.razorpayOrderId, res2.body.razorpayOrderId);
    assert.equal(createdRazorpayOrders.length, 2);
    assert.equal(databaseOrders.length, 2);
  });

  it('18. different users can use the same idempotency key without colliding or sharing orders', async () => {
    const sharedKey = 'client-generated-uuid-12345';

    const resUser1 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', sharedKey)
      .send({});

    assert.equal(resUser1.status, 201);

    (Cart as any).findOne = async (query: any) => {
      if (query.user.toString() === user2.id) {
        return {
          user: new mongoose.Types.ObjectId(user2.id),
          items: [
            {
              _id: new mongoose.Types.ObjectId(),
              project: mockRcProject._id,
              quantity: 1,
            },
          ],
        };
      }
      return null;
    };

    const resUser2 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser2}`)
      .set('Idempotency-Key', sharedKey)
      .send({});

    assert.equal(resUser2.status, 201);
    assert.notEqual(resUser1.body.orderId, resUser2.body.orderId);
    assert.notEqual(resUser1.body.razorpayOrderId, resUser2.body.razorpayOrderId);
    assert.equal(createdRazorpayOrders.length, 2);
    assert.equal(databaseOrders.length, 2);
  });

  // ==========================================
  // 7. Definite Rejections & Timeout Uncertainty Tests
  // ==========================================
  it('19. a definite Razorpay rejection releases reservation and permits a safe retry', async () => {
    const rejectKey = 'razorpay-definite-reject-key';

    // 1st attempt: Razorpay rejects with HTTP 400 Bad Request
    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('BAD_REQUEST_ERROR: Invalid currency');
          err.statusCode = 400;
          err.error = { code: 'BAD_REQUEST_ERROR' };
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const resFail = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', rejectKey)
      .send({});

    assert.equal(resFail.status, 400);
    assert.equal(resFail.body.success, false);
    // Reservation is removed so the key is released for retry
    assert.equal(databaseOrders.length, 0);

    // 2nd attempt: Healthy gateway now permits retry
    setRazorpayClient(mockRazorpayClient as any);

    const resRetry = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', rejectKey)
      .send({});

    assert.equal(resRetry.status, 201);
    assert.equal(resRetry.body.success, true);
    assert.equal(databaseOrders.length, 1);
  });

  it('20. a timeout/connection reset marks attempt as unknown and does NOT permit blind recreate call', async () => {
    const timeoutKey = 'razorpay-timeout-key';

    // 1st attempt: Gateway connection times out
    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('ESOCKETTIMEDOUT: Socket hang up during response');
          err.code = 'ESOCKETTIMEDOUT';
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const resTimeout = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', timeoutKey)
      .send({});

    assert.equal(resTimeout.status, 504);
    assert.equal(resTimeout.body.resolutionNeeded, true);

    // The reservation document is preserved with paymentStatus 'unknown'
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
  });

  // ==========================================
  // 8. Error Classification & Cart Preservation
  // ==========================================
  it('21. helper functions correctly validate reconciliation matches and duplicate receipts', () => {
    // Exact match
    assert.equal(
      isValidReconciliationMatch(
        { receipt: 'rcpt_123', amount: 834000, currency: 'INR' },
        { receipt: 'rcpt_123', amountInPaise: 834000, currency: 'INR' }
      ),
      true
    );

    // Mismatched amount
    assert.equal(
      isValidReconciliationMatch(
        { receipt: 'rcpt_123', amount: 500000, currency: 'INR' },
        { receipt: 'rcpt_123', amountInPaise: 834000, currency: 'INR' }
      ),
      false
    );

    // Mismatched receipt
    assert.equal(
      isValidReconciliationMatch(
        { receipt: 'rcpt_other', amount: 834000, currency: 'INR' },
        { receipt: 'rcpt_123', amountInPaise: 834000, currency: 'INR' }
      ),
      false
    );

    // Duplicate receipt detection
    assert.equal(
      isDuplicateReceiptError({ message: 'BAD_REQUEST_ERROR: Order with this receipt already exists' }),
      true
    );
    assert.equal(isDuplicateReceiptError({ message: 'Invalid currency code' }), false);
  });

  it('22. verifies user shopping cart is preserved and NOT cleared during order creation', async () => {
    let cartModified = false;
    (Cart as any).findOne = async () => ({
      user: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          _id: new mongoose.Types.ObjectId(),
          project: mockDroneProject._id,
          quantity: 1,
        },
      ],
      save: async () => {
        cartModified = true;
      },
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', 'cart-preserve-key')
      .send({});

    assert.equal(res.status, 201);
    assert.equal(cartModified, false);
  });

  // ==========================================
  // 9. Error Classification Focused Integration Tests
  // ==========================================
  it('23. HTTP 401/403 gateway auth error is classified as definite rejection and releases reservation', async () => {
    const authFailKey = 'razorpay-auth-fail-key';

    // 1st attempt: Gateway rejects with 401 Unauthorized
    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('The id provided does not exist');
          err.statusCode = 401;
          err.error = { code: 'GATEWAY_ERROR', description: 'The id provided does not exist' };
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const resFail = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', authFailKey)
      .send({});

    assert.equal(resFail.status, 502);
    assert.equal(resFail.body.success, false);
    // Reservation is removed so the key is released for subsequent attempts
    assert.equal(databaseOrders.length, 0);

    // 2nd attempt: Subsequent request with valid gateway credentials succeeds
    setRazorpayClient(mockRazorpayClient as any);

    const resRetry = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', authFailKey)
      .send({});

    assert.equal(resRetry.status, 201);
    assert.equal(databaseOrders.length, 1);
  });

  it('24. HTTP 408 request timeout is treated as uncertain: reservation is retained and retry attempts reconciliation', async () => {
    const timeoutKey = 'razorpay-408-timeout-key';

    // 1st attempt: Gateway returns HTTP 408 Request Timeout
    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('Request Timeout');
          err.statusCode = 408;
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const resTimeout = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', timeoutKey)
      .send({});

    assert.equal(resTimeout.status, 504);
    assert.equal(resTimeout.body.resolutionNeeded, true);

    // The reservation document is preserved with paymentStatus 'unknown'
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
    const persistentReceipt = databaseOrders[0].receipt;

    // Simulate that Razorpay DID create the order during that 408 timeout
    razorpayOrdersStore.push({
      id: 'rzp_order_from_408_success',
      receipt: persistentReceipt,
      amount: 834000,
      currency: 'INR',
    });

    let recreateCalled = false;
    setRazorpayClient({
      orders: {
        create: async () => {
          recreateCalled = true;
          throw new Error('Should not be called if reconciliation succeeds');
        },
        all: mockRazorpayClient.orders.all,
      },
    } as any);

    // 2nd attempt with same idempotency key
    const resRetry = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', timeoutKey)
      .send({});

    assert.equal(resRetry.status, 200);
    assert.equal(resRetry.body.razorpayOrderId, 'rzp_order_from_408_success');
    assert.equal(recreateCalled, false); // Reconciled without recreating
    assert.equal(databaseOrders[0].paymentStatus, 'created');
  });

  it('25. HTTP 429 rate limiting is treated as uncertain: reservation is retained as unknown', async () => {
    const rateLimitKey = 'razorpay-429-ratelimit-key';

    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('Too Many Requests');
          err.statusCode = 429;
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const res429 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', rateLimitKey)
      .send({});

    assert.equal(res429.status, 429);
    assert.equal(res429.body.resolutionNeeded, true);

    // Reservation is NOT deleted; retained in MongoDB as unknown
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
  });

  it('26. HTTP 500/502/503 server errors are treated as uncertain: reservation is preserved as unknown', async () => {
    const serverErrKey = 'razorpay-500-server-err-key';

    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('Internal Server Error');
          err.statusCode = 500;
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }),
      },
    } as any);

    const res500 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', serverErrKey)
      .send({});

    assert.equal(res500.status, 504);
    assert.equal(res500.body.resolutionNeeded, true);

    // Reservation is NOT deleted
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
  });

  it('27. HTTP 409 duplicate receipt with delayed reconciliation retains reservation as unknown', async () => {
    const dupReceiptKey = 'razorpay-dup-receipt-delayed-key';

    setRazorpayClient({
      orders: {
        create: async () => {
          const err: any = new Error('Conflict');
          err.statusCode = 409;
          throw err;
        },
        all: async () => ({ entity: 'collection', count: 0, items: [] }), // Delayed visibility
      },
    } as any);

    const res409 = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', dupReceiptKey)
      .send({});

    assert.equal(res409.status, 504);
    assert.equal(res409.body.resolutionNeeded, true);

    // Crucial: The reservation is NOT deleted; marked unknown for safe recovery
    assert.equal(databaseOrders.length, 1);
    assert.equal(databaseOrders[0].paymentStatus, 'unknown');
  });

  it('28. HTTP 409 duplicate receipt with successful reconciliation attaches existing order and returns 200', async () => {
    const dupReceiptKey = 'razorpay-dup-receipt-match-key';

    let interceptedReceipt: string = '';
    setRazorpayClient({
      orders: {
        create: async (params: any) => {
          interceptedReceipt = params.receipt;
          // Prepopulate order in store as if it was created previously
          razorpayOrdersStore.push({
            id: 'rzp_order_reconciled_409',
            receipt: interceptedReceipt,
            amount: 834000,
            currency: 'INR',
          });

          const err: any = new Error('Conflict');
          err.statusCode = 409;
          throw err;
        },
        all: mockRazorpayClient.orders.all,
      },
    } as any);

    const resRecon = await request(app)
      .post('/api/orders')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
      .set('Idempotency-Key', dupReceiptKey)
      .send({});

    assert.equal(resRecon.status, 200);
    assert.equal(resRecon.body.razorpayOrderId, 'rzp_order_reconciled_409');
    assert.equal(databaseOrders[0].paymentStatus, 'created');
  });

  it('29. classifyRazorpayError exhaustively and correctly categorizes all error conditions', () => {
    // Definite rejections (only when evidence proves NO order was created)
    assert.equal(classifyRazorpayError({ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } }), 'definite_rejection');
    assert.equal(classifyRazorpayError({ statusCode: 401 }), 'definite_rejection');
    assert.equal(classifyRazorpayError({ statusCode: 403 }), 'definite_rejection');
    assert.equal(classifyRazorpayError({ statusCode: 404 }), 'definite_rejection');
    assert.equal(classifyRazorpayError({ statusCode: 422 }), 'definite_rejection');
    assert.equal(classifyRazorpayError({ error: { code: 'GATEWAY_AUTHENTICATION_ERROR' } }), 'definite_rejection');

    // Uncertain outcomes (MUST preserve reservation, order might exist)
    assert.equal(classifyRazorpayError({ statusCode: 408 }), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 409 }), 'uncertain'); // Duplicate receipt is uncertain!
    assert.equal(
      classifyRazorpayError({ statusCode: 400, error: { description: 'receipt already exists' } }),
      'uncertain'
    );
    assert.equal(classifyRazorpayError({ statusCode: 429 }), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 500 }), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 502 }), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 503 }), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 504 }), 'uncertain');

    // Network and socket errors
    assert.equal(classifyRazorpayError({ code: 'ETIMEDOUT' }), 'uncertain');
    assert.equal(classifyRazorpayError({ code: 'ECONNRESET' }), 'uncertain');
    assert.equal(classifyRazorpayError({ code: 'ESOCKETTIMEDOUT' }), 'uncertain');
    assert.equal(classifyRazorpayError({ code: 'ECONNREFUSED' }), 'uncertain');
    assert.equal(classifyRazorpayError({ code: 'EPIPE' }), 'uncertain');
    assert.equal(classifyRazorpayError({ message: 'socket hang up' }), 'uncertain');
    assert.equal(classifyRazorpayError({ message: 'connection reset by peer' }), 'uncertain');
    assert.equal(classifyRazorpayError({ message: 'network error timeout' }), 'uncertain');

    // Conservative default for unknown/unhandled
    assert.equal(classifyRazorpayError(null), 'uncertain');
    assert.equal(classifyRazorpayError(undefined), 'uncertain');
    assert.equal(classifyRazorpayError({ statusCode: 418 }), 'uncertain');
    assert.equal(classifyRazorpayError(new Error('Unknown generic exception')), 'uncertain');
  });

  it('30. isDuplicateReceiptError correctly identifies duplicate receipt indicators across formats', () => {
    // Explicit HTTP 409
    assert.equal(isDuplicateReceiptError({ statusCode: 409 }), true);
    assert.equal(isDuplicateReceiptError({ status: 409 }), true);

    // HTTP 400 with duplicate receipt messages/descriptions
    assert.equal(
      isDuplicateReceiptError({
        statusCode: 400,
        error: { code: 'BAD_REQUEST_ERROR', description: 'Order with this receipt already exists' },
      }),
      true
    );
    assert.equal(
      isDuplicateReceiptError({
        statusCode: 400,
        message: 'Order already exists with receipt rcpt_12345',
      }),
      true
    );
    assert.equal(
      isDuplicateReceiptError({
        statusCode: 400,
        error: { field: 'receipt', description: 'receipt must be unique' },
      }),
      true
    );

    // Non-duplicate errors
    assert.equal(isDuplicateReceiptError({ statusCode: 400, error: { description: 'amount must be integer' } }), false);
    assert.equal(isDuplicateReceiptError({ statusCode: 401 }), false);
    assert.equal(isDuplicateReceiptError({ statusCode: 408 }), false);
    assert.equal(isDuplicateReceiptError({ statusCode: 429 }), false);
    assert.equal(isDuplicateReceiptError({ statusCode: 500 }), false);
    assert.equal(isDuplicateReceiptError(null), false);
    assert.equal(isDuplicateReceiptError(undefined), false);
  });
});
