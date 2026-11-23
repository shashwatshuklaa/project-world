import {
  CreateOrderResponse,
  VerifyPaymentInput,
  VerifyPaymentResponse,
  GetOrdersParams,
  GetOrdersResponse,
  GetOrderByIdResponse,
} from '../types/order';

export class OrderApiError extends Error {
  statusCode: number;
  resolutionNeeded?: boolean;
  inProgress?: boolean;

  constructor(
    message: string,
    statusCode: number,
    options?: { resolutionNeeded?: boolean; inProgress?: boolean }
  ) {
    super(message);
    this.name = 'OrderApiError';
    this.statusCode = statusCode;
    this.resolutionNeeded = options?.resolutionNeeded;
    this.inProgress = options?.inProgress;
  }
}

/**
 * Generates a cryptographically strong, URL-safe idempotency key.
 * Format: `chk_<timestamp>_<randomHex>` (alphanumeric with underscores, <= 50 chars).
 * Strictly conforms to backend validator's IDEMPOTENCY_KEY_REGEX (/^[a-zA-Z0-9_\-]+$/).
 */
export function generateIdempotencyKey(): string {
  const timestamp = Date.now().toString(36);
  let randomPart = '';

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    randomPart = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } else {
    randomPart = Math.random().toString(36).substring(2, 14);
  }

  return `chk_${timestamp}_${randomPart}`;
}

/**
 * Reusable fetch wrapper for Order and Payment API requests.
 * Uses Vite's /api proxy to reach the Express backend.
 * Guarantees credentials: 'include' so HTTP-only auth cookies are sent.
 */
async function orderFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include', // Guarantees HTTP-only auth cookies are sent
  };

  let response: Response;
  try {
    response = await fetch(endpoint, config);
  } catch {
    throw new OrderApiError(
      'Network error. Please check your internet connection or backend server status.',
      0,
      { resolutionNeeded: true }
    );
  }

  // Parse JSON response safely
  let data: Record<string, unknown> | null = null;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorMessage =
      (typeof data?.message === 'string' ? data.message : null) ||
      `Order request failed with status ${response.status}`;
    const resolutionNeeded = Boolean(
      data?.resolutionNeeded ||
        response.status === 504 ||
        response.status === 503 ||
        response.status === 429
    );
    const inProgress = Boolean(data?.inProgress);

    throw new OrderApiError(errorMessage, response.status, {
      resolutionNeeded,
      inProgress,
    });
  }

  return data as unknown as T;
}

/**
 * Centralized Order & Payment API Service.
 */
export const orderService = {
  /**
   * Retrieves paginated order history for the authenticated customer.
   * Supports page, limit, status, and paymentStatus query filters.
   */
  async getOrders(params: GetOrdersParams = {}): Promise<GetOrdersResponse> {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set('page', String(params.page));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.paymentStatus) query.set('paymentStatus', params.paymentStatus);

    const queryString = query.toString();
    const endpoint = queryString ? `/api/orders?${queryString}` : '/api/orders';
    return orderFetch<GetOrdersResponse>(endpoint, { method: 'GET' });
  },

  /**
   * Retrieves complete order details for a specific order owned by the customer.
   * Requires a 24-character hexadecimal MongoDB ObjectId.
   */
  async getOrderById(id: string): Promise<GetOrderByIdResponse> {
    return orderFetch<GetOrderByIdResponse>(`/api/orders/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  },

  /**
   * Initiates order creation on the backend using the authenticated user's persistent cart.
   * - Enforces user-scoped idempotency key (header + body).
   * - Never sends prices, amounts, or items; backend computes canonical totals.
   */
  async createOrder(idempotencyKey: string): Promise<CreateOrderResponse> {
    return orderFetch<CreateOrderResponse>('/api/orders', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        idempotencyKey,
      }),
    });
  },

  /**
   * Verifies Razorpay payment signature and authoritative capture on the backend.
   * - Strictly sends only { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature }.
   * - Never sends client prices or items.
   * - Reconciles purchased cart items without wiping new additions.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResponse> {
    return orderFetch<VerifyPaymentResponse>('/api/orders/verify-payment', {
      method: 'POST',
      body: JSON.stringify({
        orderId: input.orderId,
        razorpay_order_id: input.razorpay_order_id,
        razorpay_payment_id: input.razorpay_payment_id,
        razorpay_signature: input.razorpay_signature,
      }),
    });
  },
};

export default orderService;
