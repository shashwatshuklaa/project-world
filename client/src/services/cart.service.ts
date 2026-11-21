import {
  CartApiResponse,
  AddCartItemInput,
  UpdateCartItemInput,
} from '../types/cart';

export class CartApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'CartApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Reusable fetch wrapper for Shopping Cart API requests.
 * Uses Vite's /api proxy to communicate with the Express backend.
 * Enforces credentials: 'include' so HTTP-only auth cookies are sent.
 */
async function cartFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include', // Guarantees HTTP-only session cookies are transmitted
  };

  let response: Response;
  try {
    response = await fetch(endpoint, config);
  } catch {
    throw new CartApiError(
      'Network error. Please check your internet connection or backend server status.',
      0
    );
  }

  // Parse JSON response safely
  let data: unknown = null;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorData = data as { message?: string } | null;
    const errorMessage =
      errorData?.message || `Request failed with status ${response.status}`;
    throw new CartApiError(errorMessage, response.status);
  }

  return data as T;
}

/**
 * Centralized Shopping Cart API Service.
 */
export const cartService = {
  /**
   * Fetch current authenticated user's cart with server-calculated totals.
   */
  async getCart(): Promise<CartApiResponse> {
    return cartFetch<CartApiResponse>('/api/cart');
  },

  /**
   * Add a project to the cart (or increment quantity if already present).
   */
  async addToCart(input: AddCartItemInput): Promise<CartApiResponse> {
    return cartFetch<CartApiResponse>('/api/cart/items', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /**
   * Update a cart item's quantity or customization notes.
   */
  async updateCartItem(itemId: string, input: UpdateCartItemInput): Promise<CartApiResponse> {
    return cartFetch<CartApiResponse>(`/api/cart/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  /**
   * Remove an item from the cart.
   */
  async removeCartItem(itemId: string): Promise<CartApiResponse> {
    return cartFetch<CartApiResponse>(`/api/cart/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    });
  },

  /**
   * Clear all items from the user's cart.
   */
  async clearCart(): Promise<CartApiResponse> {
    return cartFetch<CartApiResponse>('/api/cart', {
      method: 'DELETE',
    });
  },
};

export default cartService;
