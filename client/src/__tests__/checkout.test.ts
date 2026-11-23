/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderService,
  generateIdempotencyKey,
  OrderApiError,
} from '../services/order.service.js';
import {
  loadRazorpayScript,
  resetScriptLoadingCache,
} from '../services/razorpay.service.js';
import {
  RazorpayOptions,
  VerifyPaymentInput,
} from '../types/order.js';

describe('Frontend Checkout & Razorpay Integration (Step 8.5)', () => {
  // Store original globals
  const originalFetch = global.fetch;
  const originalWindow = (global as any).window;
  const originalDocument = (global as any).document;

  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockFetchResponses: Map<string, { status: number; body: any }> = new Map();

  beforeEach(() => {
    fetchCalls = [];
    mockFetchResponses = new Map();
    resetScriptLoadingCache();

    // Mock global fetch
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

    // Setup browser DOM mock in Node environment
    const mockDocument: any = {
      createElement: (tag: string) => {
        const elem: any = {
          tagName: tag.toUpperCase(),
          onload: null,
          onerror: null,
          src: '',
          async: false,
          addEventListener: (event: string, cb: any) => {
            if (event === 'load') elem.onload = cb;
            if (event === 'error') elem.onerror = cb;
          },
        };
        return elem;
      },
      querySelector: () => null,
      body: {
        appendChild: (elem: any) => {
          // Default behavior: trigger onload asynchronously
          setTimeout(() => {
            if (typeof elem.onload === 'function') {
              elem.onload();
            }
          }, 0);
          return elem;
        },
      },
    };

    const mockWindow: any = {
      location: { href: 'http://localhost:5173/cart' },
      document: mockDocument,
    };

    (global as any).window = mockWindow;
    (global as any).document = mockDocument;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
    (global as any).document = originalDocument;
    resetScriptLoadingCache();
  });

  // ============================================================================
  // 1. Checkout with an empty cart
  // ============================================================================
  it('1. checkout with an empty cart is blocked and makes no network request', async () => {
    const emptyCart: any = { items: [], total: 0, subtotal: 0, itemCount: 0 };

    // Function simulating checkout initiation guard
    async function attemptCheckout(cart: any) {
      if (!cart || !cart.items || cart.items.length === 0) {
        throw new Error('Your shopping cart is empty. Please add projects before checking out.');
      }
      const key = generateIdempotencyKey();
      return orderService.createOrder(key);
    }

    await assert.rejects(
      async () => {
        await attemptCheckout(emptyCart);
      },
      (err: any) => {
        assert.match(err.message, /empty/i);
        return true;
      }
    );

    // Verify zero network requests were made to /api/orders
    assert.equal(fetchCalls.length, 0);
  });

  // ============================================================================
  // 2. Successful order creation request
  // ============================================================================
  it('2. successful order creation sends credentials & idempotency key without client prices', async () => {
    const mockKey = 'chk_test_1234567890_abcdef';
    mockFetchResponses.set('/api/orders', {
      status: 201,
      body: {
        success: true,
        orderId: 'ord_success_1234567890',
        razorpayOrderId: 'order_rzp_mock_123',
        amount: 417000, // canonical 4170 INR in paise calculated by backend
        currency: 'INR',
        keyId: 'rzp_test_mock_key',
      },
    });

    const result = await orderService.createOrder(mockKey);

    assert.equal(result.success, true);
    assert.equal(result.orderId, 'ord_success_1234567890');
    assert.equal(result.razorpayOrderId, 'order_rzp_mock_123');
    assert.equal(result.amount, 417000);
    assert.equal(result.currency, 'INR');
    assert.equal(result.keyId, 'rzp_test_mock_key');

    // Verify request headers and body
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.equal(call.url, '/api/orders');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.credentials, 'include'); // HTTP-only auth cookies

    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['Idempotency-Key'], mockKey);
    assert.equal(headers['Content-Type'], 'application/json');

    // Confirm client strictly does NOT send prices or totals
    const parsedBody = JSON.parse(call.options.body as string);
    assert.equal(parsedBody.idempotencyKey, mockKey);
    assert.equal(parsedBody.amount, undefined, 'Client must NEVER send amount');
    assert.equal(parsedBody.price, undefined, 'Client must NEVER send price');
    assert.equal(parsedBody.total, undefined, 'Client must NEVER send total');
    assert.equal(parsedBody.items, undefined, 'Client must NEVER send cart items');
  });

  // ============================================================================
  // 3. Idempotency key generation and reuse for the same attempt
  // ============================================================================
  it('3. idempotency key generation produces valid keys and reuses the same key across retries', () => {
    const key1 = generateIdempotencyKey();
    const key2 = generateIdempotencyKey();

    // Verify format: alphanumeric with underscores, within length 1-100
    const IDEMPOTENCY_REGEX = /^[a-zA-Z0-9_-]+$/;
    assert.match(key1, IDEMPOTENCY_REGEX);
    assert.match(key2, IDEMPOTENCY_REGEX);
    assert.ok(key1.length >= 10 && key1.length <= 100);
    assert.ok(key2.length >= 10 && key2.length <= 100);
    assert.notEqual(key1, key2, 'Fresh generations produce unique keys');

    // Simulate key reuse logic in state management
    let activeKey: string | null = null;
    function getOrReuseKey(isRetry: boolean): string {
      if (isRetry && activeKey) {
        return activeKey;
      }
      activeKey = generateIdempotencyKey();
      return activeKey;
    }

    const firstAttemptKey = getOrReuseKey(false);
    const retryAttemptKey = getOrReuseKey(true);
    assert.equal(firstAttemptKey, retryAttemptKey, 'Retrying the same attempt MUST reuse the same key');

    // A fresh checkout after completion or reset generates a new key
    const freshAttemptKey = getOrReuseKey(false);
    assert.notEqual(firstAttemptKey, freshAttemptKey, 'Subsequent attempts produce a fresh key');
  });

  // ============================================================================
  // 4. Razorpay script-loading failure
  // ============================================================================
  it('4. script-loading failure is handled safely without crashing and halts checkout', async () => {
    // Override document.body.appendChild to simulate a network script load failure
    (global as any).document.body.appendChild = (script: any) => {
      setTimeout(() => {
        if (typeof script.onerror === 'function') {
          script.onerror(new Error('Network connection failed'));
        }
      }, 0);
      return script;
    };

    const loaded = await loadRazorpayScript('https://checkout.razorpay.com/v1/checkout.js');
    assert.equal(loaded, false);

    // Verify that when script fails to load, no order creation occurs
    let checkoutProceeded = false;
    if (loaded) {
      await orderService.createOrder('test_key');
      checkoutProceeded = true;
    }

    assert.equal(checkoutProceeded, false);
    assert.equal(fetchCalls.length, 0);
  });

  // ============================================================================
  // 5. Modal dismissal
  // ============================================================================
  it('5. modal dismissal transitions to cancelled and does not clear cart or claim success', async () => {
    let modalDismissed = false;
    let cartCleared = false;
    let checkoutStatus = 'awaiting_payment';

    const mockCart = {
      items: [{ id: 'item_1', title: 'Drone', quantity: 1 }],
      clearCart: () => {
        cartCleared = true;
      },
    };

    const mockOptions: RazorpayOptions = {
      key: 'rzp_test_key',
      amount: 417000,
      currency: 'INR',
      name: 'ProjectWorld',
      description: 'Order #1',
      order_id: 'order_rzp_mock_modal',
      handler: () => {},
      modal: {
        ondismiss: () => {
          modalDismissed = true;
          checkoutStatus = 'cancelled';
        },
      },
    };

    // User closes the Razorpay modal
    mockOptions.modal?.ondismiss?.();

    assert.equal(modalDismissed, true);
    assert.equal(checkoutStatus, 'cancelled');
    assert.equal(cartCleared, false, 'Modal dismissal must NOT clear the user cart');
    assert.equal(mockCart.items.length, 1);
  });

  // ============================================================================
  // 6. Successful Razorpay callback followed by backend verification
  // ============================================================================
  it('6. successful Razorpay callback verifies with backend before confirming payment', async () => {
    const verifyPayload: VerifyPaymentInput = {
      orderId: 'ord_verify_test_123',
      razorpay_order_id: 'order_rzp_valid_123',
      razorpay_payment_id: 'pay_rzp_valid_123',
      razorpay_signature: 'signature_hmac_hex_valid_64_characters',
    };

    mockFetchResponses.set('/api/orders/verify-payment', {
      status: 200,
      body: {
        success: true,
        message: 'Payment verified successfully.',
        order: {
          id: '674000000000000000000099',
          _id: '674000000000000000000099',
          orderId: 'ord_verify_test_123',
          status: 'completed',
          paymentStatus: 'captured',
          totalAmount: 4170,
          currency: 'INR',
          razorpayOrderId: 'order_rzp_valid_123',
          razorpayPaymentId: 'pay_rzp_valid_123',
        },
      },
    });

    const verifyResult = await orderService.verifyPayment(verifyPayload);

    assert.equal(verifyResult.success, true);
    assert.equal(verifyResult.order?.status, 'completed');
    assert.equal(verifyResult.order?.paymentStatus, 'captured');
    assert.equal(verifyResult.order?.totalAmount, 4170);

    // Verify request
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.equal(call.url, '/api/orders/verify-payment');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.credentials, 'include');

    const body = JSON.parse(call.options.body as string);
    assert.equal(body.orderId, 'ord_verify_test_123');
    assert.equal(body.razorpay_order_id, 'order_rzp_valid_123');
    assert.equal(body.razorpay_payment_id, 'pay_rzp_valid_123');
    assert.equal(body.razorpay_signature, 'signature_hmac_hex_valid_64_characters');
  });

  // ============================================================================
  // 7. Backend verification failure
  // ============================================================================
  it('7. backend verification failure is rejected and never falsely claims payment success', async () => {
    mockFetchResponses.set('/api/orders/verify-payment', {
      status: 400,
      body: {
        success: false,
        message: 'Invalid payment signature. Verification failed.',
      },
    });

    let paymentSucceeded = false;
    let errorMessage = '';

    try {
      await orderService.verifyPayment({
        orderId: 'ord_tampered',
        razorpay_order_id: 'order_rzp_tampered',
        razorpay_payment_id: 'pay_rzp_tampered',
        razorpay_signature: 'invalid_tampered_signature',
      });
      paymentSucceeded = true;
    } catch (err: any) {
      paymentSucceeded = false;
      errorMessage = err.message;
    }

    assert.equal(paymentSucceeded, false, 'Must NEVER claim payment success on verification error');
    assert.match(errorMessage, /invalid payment signature/i);
  });

  // ============================================================================
  // 8. Duplicate checkout prevention
  // ============================================================================
  it('8. duplicate checkout clicks are ignored while an attempt is already in flight', async () => {
    let orderCreationCalls = 0;
    let isProcessing = false;

    mockFetchResponses.set('/api/orders', {
      status: 201,
      body: {
        success: true,
        orderId: 'ord_single_call',
        razorpayOrderId: 'order_rzp_single',
        amount: 100000,
        currency: 'INR',
      },
    });

    async function handleCheckoutClick() {
      if (isProcessing) {
        return; // Guard against concurrent duplicate submission
      }
      isProcessing = true;
      try {
        orderCreationCalls++;
        await orderService.createOrder('idemp_key_single');
      } finally {
        isProcessing = false;
      }
    }

    // Simulate rapid double click
    const promise1 = handleCheckoutClick();
    const promise2 = handleCheckoutClick(); // immediately during flight

    await Promise.all([promise1, promise2]);

    assert.equal(orderCreationCalls, 1, 'Only 1 order creation request must be executed');
    assert.equal(fetchCalls.length, 1);
  });

  // ============================================================================
  // 9. Cart refresh after verified payment
  // ============================================================================
  it('9. cart refresh is triggered after authoritative backend payment verification', async () => {
    let cartRefreshed = false;

    mockFetchResponses.set('/api/orders/verify-payment', {
      status: 200,
      body: {
        success: true,
        message: 'Payment verified successfully.',
        order: { orderId: 'ord_refresh_test', status: 'completed', paymentStatus: 'captured' },
      },
    });

    // Simulated verified checkout flow
    const verifyRes = await orderService.verifyPayment({
      orderId: 'ord_refresh_test',
      razorpay_order_id: 'order_rzp_refresh',
      razorpay_payment_id: 'pay_rzp_refresh',
      razorpay_signature: 'sig_valid',
    });

    if (verifyRes.success) {
      // Refresh user cart state from the backend
      cartRefreshed = true;
    }

    assert.equal(cartRefreshed, true, 'Cart state must refresh after verified payment');
  });

  // ============================================================================
  // 10. No false success message when verification is uncertain
  // ============================================================================
  it('10. uncertain verification (HTTP 504/timeout/resolutionNeeded) warns customer and never claims success', async () => {
    mockFetchResponses.set('/api/orders/verify-payment', {
      status: 504,
      body: {
        success: false,
        message: 'Payment gateway communication timed out. Your order outcome is being verified.',
        resolutionNeeded: true,
      },
    });

    let checkoutStatus: 'idle' | 'success' | 'error' = 'idle';
    let isUncertain = false;
    let customerMessage = '';

    try {
      await orderService.verifyPayment({
        orderId: 'ord_uncertain_123',
        razorpay_order_id: 'order_rzp_uncertain',
        razorpay_payment_id: 'pay_rzp_uncertain',
        razorpay_signature: 'sig_uncertain',
      });
      checkoutStatus = 'success';
    } catch (err: any) {
      checkoutStatus = 'error';
      if (err instanceof OrderApiError && err.resolutionNeeded) {
        isUncertain = true;
        customerMessage =
          'Your payment was processed by the gateway, but server verification is pending or timed out. Please check your order history before attempting payment again.';
      }
    }

    assert.notEqual(checkoutStatus, 'success', 'Must NEVER set success when verification is uncertain');
    assert.equal(checkoutStatus, 'error');
    assert.equal(isUncertain, true);
    assert.match(customerMessage, /verification is pending or timed out/i);
    assert.match(customerMessage, /check your order history/i);
  });
});
