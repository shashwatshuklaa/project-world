import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import { Order } from '../models/Order.js';
import { Project } from '../models/Project.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';

// Test user identities (24-character hexadecimal IDs)
const user1 = { id: '6740000000000000000000a1', email: 'user1@example.com', role: 'user' as const };
const user2 = { id: '6740000000000000000000a2', email: 'user2@example.com', role: 'user' as const };
const tokenUser1 = generateToken(user1);
const tokenUser2 = generateToken(user2);

const mockDroneId = new mongoose.Types.ObjectId('674000000000000000000001');
const mockRcId = new mongoose.Types.ObjectId('674000000000000000000002');

// Original model method references for restoration
const originalOrderFind = Order.find;
const originalOrderFindOne = Order.findOne;
const originalOrderCountDocuments = Order.countDocuments;
const originalProjectFindById = Project.findById;

describe('Order History & Order Details REST API (GET /api/orders & GET /api/orders/:id)', () => {
  let databaseOrders: any[] = [];
  let databaseProjects: any[] = [];

  function createMockOrderQuery(items: any[]) {
    let current = [...items];
    const queryObj: any = {
      sort(sortObj: any) {
        if (sortObj?.createdAt === -1) {
          current.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        } else if (sortObj?.createdAt === 1) {
          current.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        }
        return queryObj;
      },
      skip(n: number) {
        current = current.slice(n);
        return queryObj;
      },
      limit(n: number) {
        current = current.slice(0, n);
        return queryObj;
      },
      lean() {
        return queryObj;
      },
      async exec() {
        return current;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(current).then(resolve, reject);
      },
    };
    return queryObj;
  }

  function createMockFindOneQuery(item: any | null) {
    const queryObj: any = {
      lean() {
        return queryObj;
      },
      async exec() {
        return item;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(item).then(resolve, reject);
      },
    };
    return queryObj;
  }

  beforeEach(() => {
    databaseOrders = [];
    databaseProjects = [
      {
        _id: mockDroneId,
        slug: 'eng-drone-001',
        title: 'Racing Drone Construction Kit',
        price: 4170, // Historical price at purchase time
        isActive: true,
      },
      {
        _id: mockRcId,
        slug: 'eng-rc-001',
        title: 'Off-Road RC Crawler',
        price: 3500,
        isActive: true,
      },
    ];

    function matchCondition(doc: any, cond: any): boolean {
      if (cond.$and && Array.isArray(cond.$and)) {
        return cond.$and.every((c: any) => matchCondition(doc, c));
      }
      if (cond.$or && Array.isArray(cond.$or)) {
        return cond.$or.some((c: any) => matchCondition(doc, c));
      }
      if (cond.userId && doc.userId && doc.userId.toString() !== cond.userId.toString()) return false;
      if (cond._id && doc._id && doc._id.toString() !== cond._id.toString()) return false;
      if (cond.orderId && doc.orderId !== cond.orderId) return false;
      if (cond.status) {
        if (typeof cond.status === 'object' && cond.status !== null) {
          if (cond.status.$in && Array.isArray(cond.status.$in)) {
            if (!cond.status.$in.includes(doc.status)) return false;
          }
          if (cond.status.$ne !== undefined) {
            if (doc.status === cond.status.$ne) return false;
          }
        } else if (doc.status !== cond.status) {
          return false;
        }
      }
      if (cond.paymentStatus) {
        if (typeof cond.paymentStatus === 'object' && cond.paymentStatus !== null) {
          if (cond.paymentStatus.$in && Array.isArray(cond.paymentStatus.$in)) {
            if (!cond.paymentStatus.$in.includes(doc.paymentStatus)) return false;
          }
          if (cond.paymentStatus.$ne !== undefined) {
            if (doc.paymentStatus === cond.paymentStatus.$ne) return false;
          }
        } else if (doc.paymentStatus !== cond.paymentStatus) {
          return false;
        }
      }
      return true;
    }

    // Mock Order.countDocuments
    Order.countDocuments = (async (filter: any) => {
      return databaseOrders.filter((doc) => matchCondition(doc, filter)).length;
    }) as any;

    // Mock Order.find
    Order.find = ((filter: any) => {
      const matches = databaseOrders.filter((doc) => matchCondition(doc, filter));
      return createMockOrderQuery(matches);
    }) as any;

    // Mock Order.findOne
    Order.findOne = ((filter: any) => {
      const match = databaseOrders.find((doc) => matchCondition(doc, filter));
      return createMockFindOneQuery(match || null);
    }) as any;

    // Mock Project.findById
    Project.findById = (async (id: any) => {
      return databaseProjects.find((p) => p._id.toString() === id.toString()) || null;
    }) as any;
  });

  afterEach(() => {
    Order.find = originalOrderFind;
    Order.findOne = originalOrderFindOne;
    Order.countDocuments = originalOrderCountDocuments;
    Project.findById = originalProjectFindById;
  });

  // ============================================================================
  // 1. Authenticated user retrieves order history
  // ============================================================================
  it('1. authenticated user retrieves their order history sorted newest first', async () => {
    const order1 = {
      _id: new mongoose.Types.ObjectId('674000000000000000000011'),
      orderId: 'ord_history_test_1',
      receipt: 'rcpt_history_1',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone Construction Kit',
          price: 4170,
          quantity: 1,
          customization: 'Blue propellers',
          category: 'Engineering',
          subcategory: 'Drone',
          image: '/drone.png',
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      razorpayOrderId: 'order_rzp_hist_1',
      razorpayPaymentId: 'pay_rzp_hist_1',
      paidAt: new Date('2026-11-20T10:00:00Z'),
      createdAt: new Date('2026-11-20T09:55:00Z'),
      updatedAt: new Date('2026-11-20T10:00:00Z'),
    };

    const order2 = {
      _id: new mongoose.Types.ObjectId('674000000000000000000012'),
      orderId: 'ord_history_test_2',
      receipt: 'rcpt_history_2',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockRcId,
          projectSlug: 'eng-rc-001',
          title: 'Off-Road RC Crawler',
          price: 3500,
          quantity: 2,
          customization: '',
          category: 'Engineering',
          subcategory: 'RC',
          image: '/rc.png',
        },
      ],
      totalAmount: 7000,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'created',
      createdAt: new Date('2026-11-22T14:00:00Z'), // newer
      updatedAt: new Date('2026-11-22T14:00:00Z'),
    };

    databaseOrders.push(order1, order2);

    const res = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.orders.length, 2);
    // Newest first
    assert.equal(res.body.orders[0].orderId, 'ord_history_test_2');
    assert.equal(res.body.orders[1].orderId, 'ord_history_test_1');
    assert.equal(res.body.orders[0].itemCount, 2);
    assert.equal(res.body.orders[1].itemCount, 1);
    // Customer-facing status mapping: 'created' -> 'pending', 'captured' -> 'captured'
    assert.equal(res.body.orders[0].paymentStatus, 'pending');
    assert.equal(res.body.orders[1].paymentStatus, 'captured');
    assert.equal(res.body.pagination.total, 2);
    assert.equal(res.body.pagination.page, 1);
    assert.equal(res.body.pagination.limit, 10);
    assert.equal(res.body.pagination.totalPages, 1);
  });

  // ============================================================================
  // 2. Unauthenticated request is rejected
  // ============================================================================
  it('2. unauthenticated request across all order endpoints is rejected with HTTP 401', async () => {
    const resOrders = await request(app).get('/api/orders').expect(401);
    assert.match(resOrders.body.message, /authentication required/i);

    const resDetail = await request(app)
      .get('/api/orders/674000000000000000000011')
      .expect(401);
    assert.match(resDetail.body.message, /authentication required/i);
  });

  // ============================================================================
  // 3. User cannot retrieve another user's orders (ownership isolation)
  // ============================================================================
  it('3. user cannot retrieve another user orders even if injecting query parameters', async () => {
    const user1Order = {
      _id: new mongoose.Types.ObjectId('674000000000000000000011'),
      orderId: 'ord_user1_only',
      userId: new mongoose.Types.ObjectId(user1.id),
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      items: [{ title: 'Drone', price: 4170, quantity: 1 }],
      createdAt: new Date(),
    };

    const user2Order = {
      _id: new mongoose.Types.ObjectId('674000000000000000000022'),
      orderId: 'ord_user2_private',
      userId: new mongoose.Types.ObjectId(user2.id),
      totalAmount: 9000,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      items: [{ title: 'Private Drone', price: 9000, quantity: 1 }],
      createdAt: new Date(),
    };

    databaseOrders.push(user1Order, user2Order);

    // User 1 requests their own orders
    const res1 = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res1.body.orders.length, 1);
    assert.equal(res1.body.orders[0].orderId, 'ord_user1_only');
    assert.ok(!res1.body.orders.some((o: any) => o.orderId === 'ord_user2_private'));

    // Attempting query parameter injection (e.g. ?userId=user2Id) is rejected with 400
    const resInjected = await request(app)
      .get(`/api/orders?userId=${user2.id}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(400);

    assert.equal(resInjected.body.success, false);
    assert.match(resInjected.body.message, /validation failed/i);
  });

  // ============================================================================
  // 4. Pagination returns correct results and metadata
  // ============================================================================
  it('4. pagination returns correct page slices and complete metadata', async () => {
    // Populate 5 orders for user1 with distinct createdAt timestamps
    for (let i = 1; i <= 5; i++) {
      databaseOrders.push({
        _id: new mongoose.Types.ObjectId(`67400000000000000000003${i}`),
        orderId: `ord_page_item_${i}`,
        userId: new mongoose.Types.ObjectId(user1.id),
        totalAmount: 1000 * i,
        currency: 'INR',
        status: 'completed',
        paymentStatus: 'captured',
        items: [{ title: `Item ${i}`, price: 1000 * i, quantity: 1 }],
        createdAt: new Date(2026, 10, i, 12, 0, 0), // Day i
      });
    }

    // Page 2 with limit 2 -> should return 4th and 3rd newest orders (Day 3 and Day 2)
    const res = await request(app)
      .get('/api/orders?page=2&limit=2')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.orders.length, 2);
    assert.equal(res.body.orders[0].orderId, 'ord_page_item_3');
    assert.equal(res.body.orders[1].orderId, 'ord_page_item_2');

    assert.deepEqual(res.body.pagination, {
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  // ============================================================================
  // 5. Invalid page and limit values are handled safely
  // ============================================================================
  it('5. invalid page and limit values are rejected safely with HTTP 400', async () => {
    const invalidPages = ['0', '-1', '-5', 'abc', '1.5'];
    for (const p of invalidPages) {
      const res = await request(app)
        .get(`/api/orders?page=${p}`)
        .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
        .expect(400);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /validation failed/i);
    }

    const invalidLimits = ['0', '-1', 'abc', '51', '100', '9999'];
    for (const l of invalidLimits) {
      const res = await request(app)
        .get(`/api/orders?limit=${l}`)
        .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
        .expect(400);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /validation failed/i);
    }
  });

  // ============================================================================
  // 6. Status filtering works for supported statuses
  // ============================================================================
  it('6. status and paymentStatus filtering works for supported statuses and rejects invalid filters', async () => {
    databaseOrders.push(
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000041'),
        orderId: 'ord_filter_completed',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'completed',
        paymentStatus: 'captured',
        totalAmount: 1000,
        currency: 'INR',
        items: [{ title: 'Item 1', price: 1000, quantity: 1 }],
        createdAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000042'),
        orderId: 'ord_filter_pending',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'created',
        totalAmount: 2000,
        currency: 'INR',
        items: [{ title: 'Item 2', price: 2000, quantity: 1 }],
        createdAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000043'),
        orderId: 'ord_filter_refunded',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'refunded',
        paymentStatus: 'refunded',
        totalAmount: 3000,
        currency: 'INR',
        items: [{ title: 'Item 3', price: 3000, quantity: 1 }],
        createdAt: new Date(),
      }
    );

    // Filter by status=completed
    const resCompleted = await request(app)
      .get('/api/orders?status=completed')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resCompleted.body.orders.length, 1);
    assert.equal(resCompleted.body.orders[0].orderId, 'ord_filter_completed');
    assert.equal(resCompleted.body.pagination.total, 1);

    // Filter by customer-facing paymentStatus=pending (which matches underlying paymentStatus: 'created')
    const resPending = await request(app)
      .get('/api/orders?paymentStatus=pending')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resPending.body.orders.length, 1);
    assert.equal(resPending.body.orders[0].orderId, 'ord_filter_pending');
    assert.equal(resPending.body.orders[0].paymentStatus, 'pending');

    // Filter by customer-facing paymentStatus=captured
    const resCaptured = await request(app)
      .get('/api/orders?paymentStatus=captured')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resCaptured.body.orders.length, 1);
    assert.equal(resCaptured.body.orders[0].orderId, 'ord_filter_completed');
    assert.equal(resCaptured.body.orders[0].paymentStatus, 'captured');

    // Querying with an internal-only state (e.g. 'created', 'security_discrepancy') is rejected with 400
    const resInternalCreated = await request(app)
      .get('/api/orders?paymentStatus=created')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(400);

    assert.equal(resInternalCreated.body.success, false);
    assert.match(resInternalCreated.body.message, /validation failed/i);

    // Invalid status filter rejected with 400
    const resInvalid = await request(app)
      .get('/api/orders?status=bogus_status')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(400);

    assert.equal(resInvalid.body.success, false);
    assert.match(resInvalid.body.message, /validation failed/i);
  });

  // ============================================================================
  // 7. Empty order history returns valid empty response
  // ============================================================================
  it('7. empty order history returns a valid 200 response with empty array and pagination', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.orders, []);
    assert.deepEqual(res.body.pagination, {
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
    });
  });

  // ============================================================================
  // 8. User can retrieve their own order details
  // ============================================================================
  it('8. user can retrieve their own order details by MongoDB ObjectId', async () => {
    const orderId = new mongoose.Types.ObjectId('674000000000000000000051');
    databaseOrders.push({
      _id: orderId,
      orderId: 'ord_detail_success_1',
      receipt: 'rcpt_detail_1',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone Construction Kit',
          price: 4170,
          quantity: 1,
          customization: 'High-torque motors',
          category: 'Engineering',
          subcategory: 'Drone',
          image: '/drone.png',
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      razorpayOrderId: 'order_rzp_detail_1',
      razorpayPaymentId: 'pay_rzp_detail_1',
      paidAt: new Date('2026-11-20T10:00:00Z'),
      createdAt: new Date('2026-11-20T09:55:00Z'),
      updatedAt: new Date('2026-11-20T10:00:00Z'),
      // Internal fields
      webhookEventsProcessed: ['evt_111'],
      idempotencyKey: 'idemp-secret-key-1',
      receiptKey: 'secret_receipt',
      confirmedRefundPaise: 0,
    });

    const res = await request(app)
      .get(`/api/orders/${orderId.toString()}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.order._id, orderId.toString());
    assert.equal(res.body.order.orderId, 'ord_detail_success_1');
    assert.equal(res.body.order.totalAmount, 4170);
    assert.equal(res.body.order.currency, 'INR');
    assert.equal(res.body.order.items.length, 1);
    assert.equal(res.body.order.items[0].title, 'Racing Drone Construction Kit');
    assert.equal(res.body.order.items[0].price, 4170);
    assert.equal(res.body.order.items[0].customization, 'High-torque motors');
    assert.equal(res.body.order.razorpayOrderId, 'order_rzp_detail_1');
    assert.equal(res.body.order.razorpayPaymentId, 'pay_rzp_detail_1');
  });

  // ============================================================================
  // 9. Invalid ObjectId returns an appropriate error
  // ============================================================================
  it('9. invalid ObjectId format returns HTTP 400 error', async () => {
    const invalidIds = ['invalid-id', '12345', '6740000000000000000000aZ', '6740000000000000000000a123'];
    for (const id of invalidIds) {
      const res = await request(app)
        .get(`/api/orders/${id}`)
        .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
        .expect(400);

      assert.equal(res.body.success, false);
      assert.match(res.body.message, /invalid order id format/i);
    }
  });

  // ============================================================================
  // 10. Nonexistent order returns 404
  // ============================================================================
  it('10. nonexistent order returns HTTP 404', async () => {
    const nonexistentId = '674000000000000000000999';
    const res = await request(app)
      .get(`/api/orders/${nonexistentId}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(404);

    assert.equal(res.body.success, false);
    assert.match(res.body.message, /order not found/i);
  });

  // ============================================================================
  // 11. Another user's order returns 404 without existence leakage
  // ============================================================================
  it('11. another user order returns HTTP 404 without revealing whether the order exists', async () => {
    const user2OrderId = new mongoose.Types.ObjectId('674000000000000000000062');
    databaseOrders.push({
      _id: user2OrderId,
      orderId: 'ord_user2_private_secret',
      userId: new mongoose.Types.ObjectId(user2.id),
      totalAmount: 5000,
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      items: [{ title: 'Secret Project', price: 5000, quantity: 1 }],
      createdAt: new Date(),
    });

    // User 1 attempts to access User 2's order
    const res = await request(app)
      .get(`/api/orders/${user2OrderId.toString()}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(404);

    assert.equal(res.body.success, false);
    // Returns exact same 404 message as nonexistent order
    assert.match(res.body.message, /order not found/i);
  });

  // ============================================================================
  // 12. Sensitive internal fields are not exposed
  // ============================================================================
  it('12. sensitive internal gateway, dual-ledger, and worker fields are strictly omitted from responses', async () => {
    const orderId = new mongoose.Types.ObjectId('674000000000000000000071');
    databaseOrders.push({
      _id: orderId,
      orderId: 'ord_sanitize_test',
      receipt: 'rcpt_internal_private_secret',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Drone',
          price: 4170,
          quantity: 1,
        },
      ],
      totalAmount: 4170,
      currency: 'INR',
      status: 'refunded',
      paymentStatus: 'refunded',
      razorpayOrderId: 'order_rzp_public',
      razorpayPaymentId: 'pay_rzp_public',
      razorpaySignature: 'sig_secret_hmac_hex_should_not_leak',
      idempotencyKey: 'idemp-secret-user-key',
      webhookEventsProcessed: ['evt_private_1', 'evt_private_2'],
      cartReconciled: true,
      totalCapturedPaise: 417000,
      purchaseCapturedPaise: 417000,
      duplicateCapturedPaise: 0,
      amountReservedRefundPaise: 0,
      confirmedRefundPaise: 417000, // 4170 INR
      purchaseRefundedPaise: 417000,
      duplicateRefundedPaise: 0,
      primaryPaymentId: 'pay_rzp_public',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Check GET /api/orders/:id
    const resDetail = await request(app)
      .get(`/api/orders/${orderId.toString()}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    const doc = resDetail.body.order;

    // Verify sensitive fields are strictly undefined
    assert.equal(doc.receipt, undefined, 'receipt must not be exposed');
    assert.equal(doc.razorpaySignature, undefined, 'razorpaySignature must not be exposed');
    assert.equal(doc.idempotencyKey, undefined, 'idempotencyKey must not be exposed');
    assert.equal(doc.webhookEventsProcessed, undefined, 'webhookEventsProcessed must not be exposed');
    assert.equal(doc.cartReconciled, undefined, 'cartReconciled must not be exposed');
    assert.equal(doc.totalCapturedPaise, undefined, 'totalCapturedPaise must not be exposed');
    assert.equal(doc.purchaseCapturedPaise, undefined, 'purchaseCapturedPaise must not be exposed');
    assert.equal(doc.duplicateCapturedPaise, undefined, 'duplicateCapturedPaise must not be exposed');
    assert.equal(doc.amountReservedRefundPaise, undefined, 'amountReservedRefundPaise must not be exposed');
    assert.equal(doc.confirmedRefundPaise, undefined, 'confirmedRefundPaise must not be exposed');
    assert.equal(doc.purchaseRefundedPaise, undefined, 'purchaseRefundedPaise must not be exposed');
    assert.equal(doc.duplicateRefundedPaise, undefined, 'duplicateRefundedPaise must not be exposed');
    assert.equal(doc.primaryPaymentId, undefined, 'primaryPaymentId must not be exposed');
    assert.equal(doc.userId, undefined, 'userId must not be exposed');
    assert.equal(doc.__v, undefined, '__v must not be exposed');

    // Verify customer-facing refund summary is properly calculated in INR
    assert.equal(doc.refundSummary.isRefunded, true);
    assert.equal(doc.refundSummary.refundedAmount, 4170);

    // Check GET /api/orders
    const resList = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    const listDoc = resList.body.orders[0];
    assert.equal(listDoc.receipt, undefined);
    assert.equal(listDoc.razorpaySignature, undefined);
    assert.equal(listDoc.confirmedRefundPaise, undefined);
    assert.equal(listDoc.refundSummary.refundedAmount, 4170);
  });

  // ============================================================================
  // 13. Historical order prices remain unchanged even if current project prices change
  // ============================================================================
  it('13. historical order prices remain unchanged even if current project prices change in the catalog', async () => {
    const historicalPrice = 4170;
    const orderId = new mongoose.Types.ObjectId('674000000000000000000081');
    databaseOrders.push({
      _id: orderId,
      orderId: 'ord_historical_price_test',
      userId: new mongoose.Types.ObjectId(user1.id),
      items: [
        {
          projectId: mockDroneId,
          projectSlug: 'eng-drone-001',
          title: 'Racing Drone Construction Kit',
          price: historicalPrice,
          quantity: 2,
        },
      ],
      totalAmount: 8340, // 4170 * 2
      currency: 'INR',
      status: 'completed',
      paymentStatus: 'captured',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    // The project's price later increases drastically in the catalog
    const catalogProject = databaseProjects.find((p) => p._id.toString() === mockDroneId.toString());
    catalogProject.price = 99999;

    // Check single order details
    const resDetail = await request(app)
      .get(`/api/orders/${orderId.toString()}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resDetail.body.order.items[0].price, historicalPrice);
    assert.equal(resDetail.body.order.totalAmount, 8340);
    assert.notEqual(resDetail.body.order.items[0].price, catalogProject.price);

    // Check order list
    const resList = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resList.body.orders[0].items[0].price, historicalPrice);
    assert.equal(resList.body.orders[0].totalAmount, 8340);
  });

  // ============================================================================
  // 14. Internal payment and security states are never exposed to customers
  // ============================================================================
  it('14. internal payment-processing and security states are never exposed to customers and map cleanly', async () => {
    const internalOrders = [
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000091'),
        orderId: 'ord_internal_test_1',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'security_discrepancy', // internal security state
        totalAmount: 1000,
        currency: 'INR',
        items: [{ title: 'Item 1', price: 1000, quantity: 1 }],
        createdAt: new Date('2026-11-20T10:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000092'),
        orderId: 'ord_internal_test_2',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'held_for_review', // internal review state
        totalAmount: 2000,
        currency: 'INR',
        items: [{ title: 'Item 2', price: 2000, quantity: 1 }],
        createdAt: new Date('2026-11-20T11:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000093'),
        orderId: 'ord_internal_test_3',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'creating', // internal reservation state
        totalAmount: 3000,
        currency: 'INR',
        items: [{ title: 'Item 3', price: 3000, quantity: 1 }],
        createdAt: new Date('2026-11-20T12:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000094'),
        orderId: 'ord_internal_test_4',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'unknown', // internal uncertain recovery state
        totalAmount: 4000,
        currency: 'INR',
        items: [{ title: 'Item 4', price: 4000, quantity: 1 }],
        createdAt: new Date('2026-11-20T13:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000095'),
        orderId: 'ord_internal_test_5',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'completed',
        paymentStatus: 'duplicate_charge_detected', // internal ledger state
        totalAmount: 5000,
        currency: 'INR',
        items: [{ title: 'Item 5', price: 5000, quantity: 1 }],
        createdAt: new Date('2026-11-20T14:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId('674000000000000000000096'),
        orderId: 'ord_internal_test_6',
        userId: new mongoose.Types.ObjectId(user1.id),
        status: 'pending',
        paymentStatus: 'retryable_failure', // internal retry state
        totalAmount: 6000,
        currency: 'INR',
        items: [{ title: 'Item 6', price: 6000, quantity: 1 }],
        createdAt: new Date('2026-11-20T15:00:00Z'),
      },
    ];

    databaseOrders.push(...internalOrders);

    // 1. Check list endpoint: GET /api/orders
    const resList = await request(app)
      .get('/api/orders')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    const forbiddenStrings = [
      'security_discrepancy',
      'held_for_review',
      'creating',
      'unknown',
      'duplicate_charge_detected',
      'retryable_failure',
    ];

    const rawResponseText = JSON.stringify(resList.body);
    for (const forbidden of forbiddenStrings) {
      assert.equal(
        rawResponseText.includes(forbidden),
        false,
        `Response must not expose internal state: ${forbidden}`
      );
    }

    // Check individual mapped statuses
    const findInList = (orderId: string) => resList.body.orders.find((o: any) => o.orderId === orderId);

    // security_discrepancy -> customer sees failed
    const secDoc = findInList('ord_internal_test_1');
    assert.equal(secDoc.paymentStatus, 'failed');
    assert.equal(secDoc.status, 'failed');

    // held_for_review -> customer sees pending
    const heldDoc = findInList('ord_internal_test_2');
    assert.equal(heldDoc.paymentStatus, 'pending');
    assert.equal(heldDoc.status, 'pending');

    // creating -> customer sees pending
    const creatingDoc = findInList('ord_internal_test_3');
    assert.equal(creatingDoc.paymentStatus, 'pending');

    // unknown -> customer sees pending
    const unknownDoc = findInList('ord_internal_test_4');
    assert.equal(unknownDoc.paymentStatus, 'pending');

    // duplicate_charge_detected -> customer sees captured
    const dupDoc = findInList('ord_internal_test_5');
    assert.equal(dupDoc.paymentStatus, 'captured');
    assert.equal(dupDoc.status, 'completed');

    // retryable_failure -> customer sees failed
    const retryDoc = findInList('ord_internal_test_6');
    assert.equal(retryDoc.paymentStatus, 'failed');
    assert.equal(retryDoc.status, 'failed');

    // 2. Check detail endpoint: GET /api/orders/:id for security_discrepancy
    const resDetailSec = await request(app)
      .get(`/api/orders/${internalOrders[0]._id.toString()}`)
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(resDetailSec.body.order.paymentStatus, 'failed');
    assert.equal(resDetailSec.body.order.status, 'failed');
    assert.equal(JSON.stringify(resDetailSec.body).includes('security_discrepancy'), false);
  });

  // ============================================================================
  // 15. Customers cannot discover or filter by internal-only states
  // ============================================================================
  it('15. customers cannot discover or filter by internal-only states via query parameters', async () => {
    const internalStatesToProbe = [
      'security_discrepancy',
      'held_for_review',
      'creating',
      'unknown',
      'duplicate_charge_detected',
      'retryable_failure',
      'created',
      'authorized',
    ];

    for (const internalState of internalStatesToProbe) {
      const res = await request(app)
        .get(`/api/orders?paymentStatus=${internalState}`)
        .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
        .expect(400);

      assert.equal(res.body.success, false);
      assert.match(res.body.message, /validation failed/i);
    }
  });

  // ============================================================================
  // 16. Regression: paymentStatus=captured filter includes held_for_review orders with status completed
  // ============================================================================
  it('16. paymentStatus=captured filter includes held_for_review orders where status is completed, and response maps to captured', async () => {
    const orderHeldCompleted = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000b1'),
      orderId: 'ord_regress_held_completed',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'completed',
      paymentStatus: 'held_for_review',
      totalAmount: 1500,
      currency: 'INR',
      items: [{ title: 'Item Held Completed', price: 1500, quantity: 1 }],
      createdAt: new Date('2026-11-20T10:00:00Z'),
    };

    const orderHeldPending = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000b2'),
      orderId: 'ord_regress_held_pending',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'pending',
      paymentStatus: 'held_for_review',
      totalAmount: 2500,
      currency: 'INR',
      items: [{ title: 'Item Held Pending', price: 2500, quantity: 1 }],
      createdAt: new Date('2026-11-20T11:00:00Z'),
    };

    const orderRegularCaptured = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000b3'),
      orderId: 'ord_regress_regular_captured',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'completed',
      paymentStatus: 'captured',
      totalAmount: 3500,
      currency: 'INR',
      items: [{ title: 'Item Regular Captured', price: 3500, quantity: 1 }],
      createdAt: new Date('2026-11-20T12:00:00Z'),
    };

    const orderDupCaptured = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000b4'),
      orderId: 'ord_regress_dup_captured',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'completed',
      paymentStatus: 'duplicate_charge_detected',
      totalAmount: 4500,
      currency: 'INR',
      items: [{ title: 'Item Dup Captured', price: 4500, quantity: 1 }],
      createdAt: new Date('2026-11-20T13:00:00Z'),
    };

    databaseOrders.push(orderHeldCompleted, orderHeldPending, orderRegularCaptured, orderDupCaptured);

    const res = await request(app)
      .get('/api/orders?paymentStatus=captured')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.orders.length, 3);
    assert.equal(res.body.pagination.total, 3);

    // Confirms held_for_review + completed is included
    const foundHeldCompleted = res.body.orders.find((o: any) => o.orderId === 'ord_regress_held_completed');
    assert.ok(foundHeldCompleted, 'held_for_review with status=completed must be returned by paymentStatus=captured');
    assert.equal(foundHeldCompleted.paymentStatus, 'captured', 'returned customer paymentStatus must be captured');
    assert.equal(foundHeldCompleted.status, 'completed');

    // Confirms regular captured and duplicate_charge_detected are included
    assert.ok(res.body.orders.some((o: any) => o.orderId === 'ord_regress_regular_captured'));
    assert.ok(res.body.orders.some((o: any) => o.orderId === 'ord_regress_dup_captured'));

    // Confirms held_for_review + pending is NOT included
    assert.ok(!res.body.orders.some((o: any) => o.orderId === 'ord_regress_held_pending'));

    // Every item in the captured filter response must have paymentStatus === 'captured'
    for (const order of res.body.orders) {
      assert.equal(order.paymentStatus, 'captured');
    }
  });

  // ============================================================================
  // 17. Regression: paymentStatus=pending filter excludes held_for_review orders with status completed
  // ============================================================================
  it('17. paymentStatus=pending filter excludes held_for_review orders where status is completed, and includes held_for_review orders where status is not completed', async () => {
    const orderHeldCompleted = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
      orderId: 'ord_regress_pending_held_completed',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'completed',
      paymentStatus: 'held_for_review',
      totalAmount: 1500,
      currency: 'INR',
      items: [{ title: 'Item Held Completed', price: 1500, quantity: 1 }],
      createdAt: new Date('2026-11-20T10:00:00Z'),
    };

    const orderHeldPending = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000c2'),
      orderId: 'ord_regress_pending_held_pending',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'pending',
      paymentStatus: 'held_for_review',
      totalAmount: 2500,
      currency: 'INR',
      items: [{ title: 'Item Held Pending', price: 2500, quantity: 1 }],
      createdAt: new Date('2026-11-20T11:00:00Z'),
    };

    const orderNormalPending = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000c3'),
      orderId: 'ord_regress_normal_pending',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'pending',
      paymentStatus: 'created',
      totalAmount: 3500,
      currency: 'INR',
      items: [{ title: 'Item Normal Pending', price: 3500, quantity: 1 }],
      createdAt: new Date('2026-11-20T12:00:00Z'),
    };

    const orderCaptured = {
      _id: new mongoose.Types.ObjectId('6740000000000000000000c4'),
      orderId: 'ord_regress_pending_captured',
      userId: new mongoose.Types.ObjectId(user1.id),
      status: 'completed',
      paymentStatus: 'captured',
      totalAmount: 4500,
      currency: 'INR',
      items: [{ title: 'Item Captured', price: 4500, quantity: 1 }],
      createdAt: new Date('2026-11-20T13:00:00Z'),
    };

    databaseOrders.push(orderHeldCompleted, orderHeldPending, orderNormalPending, orderCaptured);

    const res = await request(app)
      .get('/api/orders?paymentStatus=pending')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${tokenUser1}`])
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.orders.length, 2);
    assert.equal(res.body.pagination.total, 2);

    // Confirms held_for_review with status=pending IS included
    const foundHeldPending = res.body.orders.find((o: any) => o.orderId === 'ord_regress_pending_held_pending');
    assert.ok(foundHeldPending, 'held_for_review with status!=completed must be returned by paymentStatus=pending');
    assert.equal(foundHeldPending.paymentStatus, 'pending');

    // Confirms normal pending is included
    assert.ok(res.body.orders.some((o: any) => o.orderId === 'ord_regress_normal_pending'));

    // Confirms held_for_review + completed is strictly EXCLUDED
    assert.ok(
      !res.body.orders.some((o: any) => o.orderId === 'ord_regress_pending_held_completed'),
      'held_for_review with status=completed must NOT be returned by paymentStatus=pending'
    );

    // Confirms captured is strictly EXCLUDED
    assert.ok(!res.body.orders.some((o: any) => o.orderId === 'ord_regress_pending_captured'));

    // Every item in the pending filter response must have paymentStatus === 'pending'
    for (const order of res.body.orders) {
      assert.equal(order.paymentStatus, 'pending');
    }
  });
});
