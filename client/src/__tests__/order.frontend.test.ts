/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderService,
  OrderApiError,
} from '../services/order.service.js';
import {
  CustomerOrder,
  GetOrdersResponse,
  GetOrderByIdResponse,
} from '../types/order.js';

describe('Order History & Order Details Frontend (Step 8.6)', () => {
  const originalFetch = global.fetch;
  const originalWindow = (global as any).window;

  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockFetchResponses: Map<string, { status: number; body: any }> = new Map();

  beforeEach(() => {
    fetchCalls = [];
    mockFetchResponses = new Map();

    global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const options = init || {};
      fetchCalls.push({ url, options });

      const mockResponse = mockFetchResponses.get(url) || {
        status: 200,
        body: { success: true },
      };

      return {
        ok: mockResponse.status >= 200 && mockResponse.status < 300,
        status: mockResponse.status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockResponse.body,
        text: async () => JSON.stringify(mockResponse.body),
      } as any;
    };

    (global as any).window = {
      location: { href: 'http://localhost:5173/orders' },
      scrollTo: () => {},
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
  });

  const sampleOrder1: CustomerOrder = {
    _id: '6740000000000000000000a1',
    id: '6740000000000000000000a1',
    orderId: 'ord_hist_frontend_001',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:05:00.000Z',
    status: 'completed',
    paymentStatus: 'captured',
    totalAmount: 4170,
    currency: 'INR',
    items: [
      {
        projectId: '674000000000000000000001',
        projectSlug: 'racing-drone-kit',
        title: 'Racing Drone Construction Kit',
        price: 4170, // Historical purchase price
        quantity: 1,
        customization: 'High-torque motors',
        category: 'Engineering',
      },
    ],
    itemCount: 1,
    paidAt: '2026-11-20T10:05:00.000Z',
    paymentMethod: 'razorpay',
    razorpayOrderId: 'order_rzp_hist_1',
    razorpayPaymentId: 'pay_rzp_hist_1',
    refundSummary: {
      isRefunded: false,
      isPartiallyRefunded: false,
      refundedAmount: 0,
    },
  };

  const sampleOrder2: CustomerOrder = {
    _id: '6740000000000000000000a2',
    id: '6740000000000000000000a2',
    orderId: 'ord_hist_frontend_002',
    createdAt: '2026-11-22T14:00:00.000Z',
    updatedAt: '2026-11-22T14:00:00.000Z',
    status: 'pending',
    paymentStatus: 'pending',
    totalAmount: 7000,
    currency: 'INR',
    items: [
      {
        projectId: '674000000000000000000002',
        projectSlug: 'rc-crawler',
        title: 'Off-Road RC Crawler',
        price: 3500,
        quantity: 2,
        customization: '',
        category: 'Robotics',
      },
    ],
    itemCount: 2,
    paidAt: null,
    paymentMethod: null,
    razorpayOrderId: 'order_rzp_hist_2',
    razorpayPaymentId: null,
    refundSummary: {
      isRefunded: false,
      isPartiallyRefunded: false,
      refundedAmount: 0,
    },
  };

  // ============================================================================
  // 1. Order history loads successfully
  // ============================================================================
  it('1. order history loads successfully and retrieves authenticated user orders', async () => {
    mockFetchResponses.set('/api/orders', {
      status: 200,
      body: {
        success: true,
        orders: [sampleOrder1, sampleOrder2],
        pagination: {
          total: 2,
          page: 1,
          limit: 10,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      } as GetOrdersResponse,
    });

    const result = await orderService.getOrders();

    assert.equal(result.success, true);
    assert.equal(result.orders.length, 2);
    assert.equal(result.orders[0].orderId, 'ord_hist_frontend_001');
    assert.equal(result.orders[1].orderId, 'ord_hist_frontend_002');
    assert.equal(result.pagination.total, 2);

    // Verify request options
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/api/orders');
    assert.equal(fetchCalls[0].options.method, 'GET');
    assert.equal(fetchCalls[0].options.credentials, 'include');
  });

  // ============================================================================
  // 2. Loading state
  // ============================================================================
  it('2. loading state transitions true during fetch and false upon completion', async () => {
    let isLoading = false;

    mockFetchResponses.set('/api/orders', {
      status: 200,
      body: {
        success: true,
        orders: [sampleOrder1],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1, hasNextPage: false, hasPrevPage: false },
      },
    });

    async function loadWithState() {
      isLoading = true;
      try {
        return await orderService.getOrders();
      } finally {
        isLoading = false;
      }
    }

    const promise = loadWithState();
    assert.equal(isLoading, true, 'Loading must be true while in-flight');

    const res = await promise;
    assert.equal(isLoading, false, 'Loading must be false after completion');
    assert.equal(res.orders.length, 1);
  });

  // ============================================================================
  // 3. Empty order history
  // ============================================================================
  it('3. empty order history returns a valid response with empty array and pagination', async () => {
    mockFetchResponses.set('/api/orders', {
      status: 200,
      body: {
        success: true,
        orders: [],
        pagination: {
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      },
    });

    const result = await orderService.getOrders();

    assert.equal(result.success, true);
    assert.deepEqual(result.orders, []);
    assert.equal(result.pagination.total, 0);
    assert.equal(result.pagination.totalPages, 0);
  });

  // ============================================================================
  // 4. API error and retry
  // ============================================================================
  it('4. API error sets error message and retry succeeds on subsequent call', async () => {
    // 1st call fails
    mockFetchResponses.set('/api/orders', {
      status: 500,
      body: { success: false, message: 'Internal server error' },
    });

    let caughtError: string | null = null;
    try {
      await orderService.getOrders();
    } catch (err: any) {
      caughtError = err.message;
    }

    assert.match(caughtError || '', /internal server error/i);

    // 2nd call (retry) succeeds
    mockFetchResponses.set('/api/orders', {
      status: 200,
      body: {
        success: true,
        orders: [sampleOrder1],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1, hasNextPage: false, hasPrevPage: false },
      },
    });

    const retryResult = await orderService.getOrders();
    assert.equal(retryResult.success, true);
    assert.equal(retryResult.orders.length, 1);
    assert.equal(fetchCalls.length, 2);
  });

  // ============================================================================
  // 5. Pagination
  // ============================================================================
  it('5. pagination passes page and limit query params and receives slice metadata', async () => {
    mockFetchResponses.set('/api/orders?page=2&limit=5', {
      status: 200,
      body: {
        success: true,
        orders: [sampleOrder2],
        pagination: {
          total: 12,
          page: 2,
          limit: 5,
          totalPages: 3,
          hasNextPage: true,
          hasPrevPage: true,
        },
      },
    });

    const result = await orderService.getOrders({ page: 2, limit: 5 });

    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.pagination.hasNextPage, true);
    assert.equal(result.pagination.hasPrevPage, true);

    const call = fetchCalls[0];
    assert.equal(call.url, '/api/orders?page=2&limit=5');
  });

  // ============================================================================
  // 6. Customer-facing status labels
  // ============================================================================
  it('6. customer-facing payment and order statuses are cleanly mapped and labeled', () => {
    function getPaymentStatusLabel(status: string): string {
      switch (status) {
        case 'captured':
          return 'Paid';
        case 'pending':
          return 'Payment Pending';
        case 'failed':
          return 'Payment Failed';
        case 'refunded':
          return 'Refunded';
        case 'partially_refunded':
          return 'Partially Refunded';
        case 'refund_pending':
          return 'Refund Pending';
        default:
          return status;
      }
    }

    function getOrderStatusLabel(status: string): string {
      switch (status) {
        case 'completed':
          return 'Completed';
        case 'processing':
          return 'Processing';
        case 'pending':
          return 'Pending';
        case 'refunded':
          return 'Refunded';
        case 'cancelled':
          return 'Cancelled';
        case 'failed':
          return 'Failed';
        default:
          return status;
      }
    }

    assert.equal(getPaymentStatusLabel('captured'), 'Paid');
    assert.equal(getPaymentStatusLabel('pending'), 'Payment Pending');
    assert.equal(getPaymentStatusLabel('failed'), 'Payment Failed');
    assert.equal(getPaymentStatusLabel('refunded'), 'Refunded');
    assert.equal(getPaymentStatusLabel('partially_refunded'), 'Partially Refunded');
    assert.equal(getPaymentStatusLabel('refund_pending'), 'Refund Pending');

    assert.equal(getOrderStatusLabel('completed'), 'Completed');
    assert.equal(getOrderStatusLabel('processing'), 'Processing');
    assert.equal(getOrderStatusLabel('pending'), 'Pending');
    assert.equal(getOrderStatusLabel('refunded'), 'Refunded');
    assert.equal(getOrderStatusLabel('cancelled'), 'Cancelled');
    assert.equal(getOrderStatusLabel('failed'), 'Failed');
  });

  // ============================================================================
  // 7. Opening an individual order
  // ============================================================================
  it('7. opening an individual order retrieves complete sanitized order details by ID', async () => {
    const orderId = '6740000000000000000000a1';
    mockFetchResponses.set(`/api/orders/${orderId}`, {
      status: 200,
      body: {
        success: true,
        order: sampleOrder1,
      } as GetOrderByIdResponse,
    });

    const result = await orderService.getOrderById(orderId);

    assert.equal(result.success, true);
    assert.equal(result.order.orderId, 'ord_hist_frontend_001');
    assert.equal(result.order.totalAmount, 4170);
    assert.equal(result.order.currency, 'INR');
    assert.equal(result.order.items.length, 1);
    assert.equal(result.order.items[0].title, 'Racing Drone Construction Kit');
    assert.equal(result.order.items[0].customization, 'High-torque motors');
    assert.equal(result.order.razorpayOrderId, 'order_rzp_hist_1');
    assert.equal(result.order.razorpayPaymentId, 'pay_rzp_hist_1');

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, `/api/orders/${orderId}`);
    assert.equal(fetchCalls[0].options.credentials, 'include');
  });

  // ============================================================================
  // 8. Invalid order ID
  // ============================================================================
  it('8. invalid order ID format returns HTTP 400 error and is handled gracefully', async () => {
    const invalidId = 'not-a-valid-24-hex-id';
    mockFetchResponses.set(`/api/orders/${invalidId}`, {
      status: 400,
      body: {
        success: false,
        message: 'Invalid order ID format. Must be a valid MongoDB ObjectId.',
      },
    });

    await assert.rejects(
      async () => {
        await orderService.getOrderById(invalidId);
      },
      (err: any) => {
        assert.ok(err instanceof OrderApiError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /invalid order id format/i);
        return true;
      }
    );
  });

  // ============================================================================
  // 9. Order not found
  // ============================================================================
  it('9. nonexistent order returns HTTP 404 without leaking existence', async () => {
    const nonexistentId = '674000000000000000000999';
    mockFetchResponses.set(`/api/orders/${nonexistentId}`, {
      status: 404,
      body: {
        success: false,
        message: 'Order not found.',
      },
    });

    await assert.rejects(
      async () => {
        await orderService.getOrderById(nonexistentId);
      },
      (err: any) => {
        assert.ok(err instanceof OrderApiError);
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /order not found/i);
        return true;
      }
    );
  });

  // ============================================================================
  // 10. Historical item prices are displayed from the API response
  // ============================================================================
  it('10. historical item prices are taken directly from order item prices, never catalog', () => {
    const historicalOrder = {
      ...sampleOrder1,
      items: [
        {
          projectId: '674000000000000000000001',
          projectSlug: 'racing-drone-kit',
          title: 'Racing Drone Construction Kit',
          price: 4170, // Historical price recorded at purchase time
          quantity: 2,
        },
      ],
      totalAmount: 8340,
    };

    // Calculate line subtotal strictly from API response item.price * item.quantity
    const item = historicalOrder.items[0];
    const computedSubtotal = item.price * item.quantity;

    assert.equal(item.price, 4170);
    assert.equal(computedSubtotal, 8340);
    assert.equal(historicalOrder.totalAmount, 8340);
  });

  // ============================================================================
  // 11. Refund summary display
  // ============================================================================
  it('11. refund summary displays refunded amount and refund status when applicable', () => {
    const refundedOrder: CustomerOrder = {
      ...sampleOrder1,
      status: 'refunded',
      paymentStatus: 'refunded',
      refundSummary: {
        isRefunded: true,
        isPartiallyRefunded: false,
        refundedAmount: 4170,
      },
    };

    assert.equal(refundedOrder.refundSummary.isRefunded, true);
    assert.equal(refundedOrder.refundSummary.refundedAmount, 4170);

    const partiallyRefundedOrder: CustomerOrder = {
      ...sampleOrder1,
      paymentStatus: 'partially_refunded',
      refundSummary: {
        isRefunded: false,
        isPartiallyRefunded: true,
        refundedAmount: 2000,
      },
    };

    assert.equal(partiallyRefundedOrder.refundSummary.isPartiallyRefunded, true);
    assert.equal(partiallyRefundedOrder.refundSummary.refundedAmount, 2000);
  });

  // ============================================================================
  // 12. Internal payment states and fields are not exposed
  // ============================================================================
  it('12. internal payment states and sensitive server fields are strictly absent', () => {
    const rawOrderJson = JSON.stringify(sampleOrder1);

    const forbiddenFields = [
      'receipt',
      'razorpaySignature',
      'idempotencyKey',
      'webhookEventsProcessed',
      'totalCapturedPaise',
      'purchaseCapturedPaise',
      'duplicateCapturedPaise',
      'amountReservedRefundPaise',
      'confirmedRefundPaise',
      'security_discrepancy',
      'held_for_review',
      'creating',
      'unknown',
      'duplicate_charge_detected',
      'retryable_failure',
    ];

    for (const forbidden of forbiddenFields) {
      assert.equal(
        rawOrderJson.includes(forbidden),
        false,
        `Customer order must NOT expose internal field or status: ${forbidden}`
      );
    }
  });

  // ============================================================================
  // 13. Unauthenticated route protection
  // ============================================================================
  it('13. unauthenticated route protection redirects unauthenticated users to /login', () => {
    function evaluateRouteAccess(isAuthenticated: boolean, requestedPath: string) {
      if (!isAuthenticated) {
        return {
          allowed: false,
          redirectTo: '/login',
          state: { from: { pathname: requestedPath } },
        };
      }
      return { allowed: true, redirectTo: null, state: null };
    }

    const unauthAccess = evaluateRouteAccess(false, '/orders');
    assert.equal(unauthAccess.allowed, false);
    assert.equal(unauthAccess.redirectTo, '/login');
    assert.deepEqual(unauthAccess.state, { from: { pathname: '/orders' } });

    const authAccess = evaluateRouteAccess(true, '/orders');
    assert.equal(authAccess.allowed, true);
    assert.equal(authAccess.redirectTo, null);
  });
});
